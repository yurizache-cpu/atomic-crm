// Shared fixtures and probes for the agent runtime suites
// (agentRunRuntime.dbtest.ts, agentRunInterruptions.dbtest.ts,
// agentRunContracts.dbtest.ts): the real worker runtime and the real agent run
// handler, with a scripted model provider standing in for the vendor.
//
// Each suite owns its connections and its lifecycle; `agentRuntimeProbes` takes
// an accessor rather than the connections because a suite opens them in
// `beforeAll`, after its probes are built. It lives in engine/domain because
// only there may code import the domain services, the worker runtime and the
// database fixture together (eslint.config.js). All data is synthetic
// office-operations text.

import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../../db/types.ts";
import { createWorkerDatabase } from "../../db/workerDatabase.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../../handlers/agentRunExecute.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
  type FakeModelProvider,
} from "../../models/fakeModelProvider.ts";
import { createModelRouter } from "../../models/router.ts";
import type { TaskAssessment } from "../../models/taskAssessment.ts";
import type { ModelProvider } from "../../models/types.ts";
import {
  createRegistry,
  isExternalCallHandler,
  resolveHandler,
  type ExternalCallHandlerDefinition,
  type HandlerRegistry,
  type PrepareBudget,
} from "../../worker/handlerRegistry.ts";
import type { LeasedJob } from "../../worker/job.ts";
import { createHandlerRegistry } from "../../worker/registry.ts";
import {
  runOneJob,
  type RunOneJobOptions,
  type RunOneJobResult,
} from "../../worker/runOneJob.ts";
import {
  ADMIN_URL,
  adminPool,
  cleanupFixtures,
  provisionWorkerRole,
  TENANT_A,
  workerDatabase,
} from "../../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "../agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "../companyOs.ts";

export const SOURCE = "dbtest-agent-runtime";
export const WORKER = "dbtest-agent-runtime";
export const MODEL = "fake-model-1";

// Sentinels inside the tenant text a run reads. They must reach the model, and
// nothing the database keeps about the run may contain them.
export const TASK_SENTINEL = "dbtest-sentinel-task-4f1c";
export const AGENT_SENTINEL = "dbtest-sentinel-agent-9b2e";

export const VALID: TaskAssessment = Object.freeze({
  outcome: "completed",
  summary: "Order paper, toner and coffee before Friday.",
  proposed_next_steps: Object.freeze([
    "Check the stock list.",
    "Place the order with the usual supplier.",
  ]),
});

/** What a live 30 s lease leaves a prepare: above the handler's minimum. */
export const SHARED_LEASE_BUDGET: PrepareBudget = Object.freeze({
  callBudgetMs: 20_000,
  remainingMs: () => 20_000,
});

export interface AgentRuntimeDatabases {
  readonly admin: Pool;
  /** Owner transactions: the worker's adapter pointed at the admin connection. */
  readonly owner: WorkerDatabase;
  /** The worker's database, over the real adapter. */
  readonly db: WorkerDatabase;
}

/** Provisions the worker role and opens a suite's connections. */
export function openAgentRuntimeDatabases(): AgentRuntimeDatabases {
  provisionWorkerRole();
  return {
    admin: adminPool(),
    owner: createWorkerDatabase({ connectionString: ADMIN_URL, max: 2 }),
    db: workerDatabase(2),
  };
}

/** Closes what openAgentRuntimeDatabases opened and removes the suite's rows. */
export async function closeAgentRuntimeDatabases(
  databases: Partial<AgentRuntimeDatabases>,
): Promise<void> {
  await databases.db?.close();
  await databases.owner?.close();
  await cleanupFixtures(databases.admin);
  await databases.admin?.end();
}

export interface OfficeTask {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
  readonly taskId: string;
}

export interface RunRow {
  id: string;
  status: string;
  job_id: string | null;
  correlation_id: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  input_fingerprint: string | null;
  job_attempt: number | null;
  response_model: string | null;
  finish_reason: string | null;
  provider_request_id: string | null;
  provider_response_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cached_input_tokens: number | null;
  reasoning_tokens: number | null;
  latency_ms: number | null;
  result: unknown;
  error_category: string | null;
  error_code: string | null;
  stop_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface RunEvent {
  id: string;
  type: string;
  correlation_id: string | null;
  causation_id: string | null;
  payload: Record<string, unknown>;
}

/** The production registry, its `standard` route served by `provider`. */
export function registryServing(provider: ModelProvider): HandlerRegistry {
  const modelRouter = createModelRouter({
    routes: new Map([["standard", { provider: provider.name, model: MODEL }]]),
    providers: new Map([[provider.name, provider]]),
  });
  return createHandlerRegistry({ modelRouter });
}

/** The production registry, its `standard` route served by a counting fake provider. */
export function fakeRuntime(script: FakeBehavior): {
  provider: FakeModelProvider;
  registry: HandlerRegistry;
} {
  const provider = createFakeModelProvider(script);
  return { provider, registry: registryServing(provider) };
}

/** The production agent run handler, exactly as the registry holds it. */
export function agentRunHandler(
  registry: HandlerRegistry,
): ExternalCallHandlerDefinition {
  const handler = resolveHandler(registry, AGENT_RUN_EXECUTE_KIND);
  if (!handler || !isExternalCallHandler(handler)) {
    throw new Error(
      "the agent run handler is not registered as an external call handler",
    );
  }
  return handler;
}

/**
 * The production agent run handler, except that it asks the database for a
 * claim ONCE and hands that first claim to every later attempt. The claim is the
 * handler's to ask for, and nothing in the runtime makes it fresh.
 */
export function reusingFirstClaim(registry: HandlerRegistry): HandlerRegistry {
  const handler = agentRunHandler(registry);
  let firstClaim: Promise<unknown> | undefined;
  const stale: ExternalCallHandlerDefinition = {
    ...handler,
    prepare(job, capabilities, budget) {
      firstClaim ??= capabilities.claimAgentRun();
      const claim = firstClaim;
      return handler.prepare(
        job,
        { ...capabilities, claimAgentRun: () => claim },
        budget,
      );
    },
  };
  return createRegistry([stale]);
}

/**
 * Resolves or rejects as `promise` does, or rejects with `message` once `ms`
 * pass first. It bounds a wait on an event; it never stands in for one.
 */
export async function withinMs<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves to what the promise rejected with; fails the test if it resolved. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection, but the call succeeded");
}

export interface AgentRuntimeProbes {
  /** One company, department and agent, and a task assigned to that agent. */
  buildOfficeTask(tenantId?: string): Promise<OfficeTask>;
  /** One run requested by the owner, committed. */
  requestRun(office: OfficeTask, idempotencyKey: string): Promise<string>;
  /**
   * Runs `step` in a worker transaction on a lease THIS process did not take,
   * resumed by worker id and job id, as a second process configured with the
   * same worker id could (finding AR-03). Throws when the lease is not live, so
   * a case cannot pass on a refusal that has nothing to do with the run.
   */
  onSharedLease<T>(
    workerId: string,
    jobId: string,
    step: (tx: TxClient, job: LeasedJob) => Promise<T>,
  ): Promise<T>;
  /** One pass of the real runtime as WORKER, with `registry`. */
  runAgentJob(
    registry: HandlerRegistry,
    options?: Omit<Partial<RunOneJobOptions>, "registry">,
  ): Promise<RunOneJobResult>;
  readRun(runId: string): Promise<RunRow>;
  runEvents(runId: string): Promise<RunEvent[]>;
  readTaskRow(taskId: string): Promise<unknown>;
  /** Moves the job's lease into the past on the database clock. */
  expireLease(jobId: string): Promise<void>;
  /** ops.settle_stale_agent_runs(), as the worker's reaper tick calls it. */
  sweepStaleRuns(): Promise<number>;
  countJobs(tenantId: string): Promise<number>;
}

/** The probes that need a suite's connections, bound to them through `databases`. */
export function agentRuntimeProbes(
  databases: () => AgentRuntimeDatabases,
): AgentRuntimeProbes {
  const admin = () => databases().admin;
  const owner = () => databases().owner;
  const db = () => databases().db;

  const buildOfficeTask = (tenantId: string = TENANT_A) =>
    owner().withTransaction(async (tx) => {
      const ctx = { tenantId, source: SOURCE };
      const companyId = await createCompany(tx, ctx, {
        slug: "dbtest-office",
        name: "Office",
      });
      const departmentId = await createDepartment(tx, ctx, {
        companyId,
        slug: "operations",
        name: "Operations",
      });
      const agentId = await createAgent(tx, ctx, {
        companyId,
        departmentId,
        slug: "office-assistant",
        name: "Office assistant",
        role: "Operations assistant",
        description: `Keeps the office stocked and orders supplies. ${AGENT_SENTINEL}`,
      });
      const taskId = await createTask(tx, ctx, {
        companyId,
        departmentId,
        type: "operations.supply_order",
        title: "Prepare next week's office supply order",
        description: `Paper, toner and coffee are running low. ${TASK_SENTINEL}`,
        dueAt: new Date("2026-09-21T12:00:00Z"),
      });
      await assignTask(tx, ctx, taskId, agentId);
      return { tenantId, companyId, departmentId, agentId, taskId };
    });

  const requestRun = (office: OfficeTask, idempotencyKey: string) =>
    owner().withTransaction((tx) =>
      requestAgentRun(
        tx,
        { tenantId: office.tenantId, source: SOURCE },
        {
          taskId: office.taskId,
          agentId: office.agentId,
          capability: "task_assessment",
          idempotencyKey,
        },
      ),
    );

  const onSharedLease = <T>(
    workerId: string,
    jobId: string,
    step: (tx: TxClient, job: LeasedJob) => Promise<T>,
  ): Promise<T> =>
    db().withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<LeasedJob>(
        "select * from ops.resume_lease($1, $2)",
        [workerId, jobId],
      );
      const job = rows[0];
      if (job?.id !== jobId) {
        throw new Error(
          "the shared lease is not live; the case would prove nothing",
        );
      }
      return step(tx, job);
    });

  const runAgentJob = (
    registry: HandlerRegistry,
    options: Omit<Partial<RunOneJobOptions>, "registry"> = {},
  ) => runOneJob(db(), { workerId: WORKER, registry, ...options });

  const readRun = async (runId: string): Promise<RunRow> => {
    const { rows } = await admin().query<RunRow>(
      "select * from ops.agent_runs where id = $1",
      [runId],
    );
    if (!rows[0]) throw new Error("the agent run under test does not exist");
    return rows[0];
  };

  const runEvents = async (runId: string): Promise<RunEvent[]> => {
    const { rows } = await admin().query<RunEvent>(
      `select id, type, correlation_id, causation_id, payload
         from ops.events
        where subject_type = 'agent_run' and subject_id = $1
        order by seq`,
      [runId],
    );
    return rows;
  };

  const readTaskRow = async (taskId: string): Promise<unknown> => {
    const { rows } = await admin().query<{ row: unknown }>(
      "select row_to_json(t)::jsonb as row from ops.tasks t where t.id = $1",
      [taskId],
    );
    return rows[0]?.row;
  };

  const expireLease = async (jobId: string): Promise<void> => {
    await admin().query(
      "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [jobId],
    );
  };

  const sweepStaleRuns = () =>
    db().withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ settled: number }>(
        "select ops.settle_stale_agent_runs() as settled",
      );
      return Number(rows[0]?.settled);
    });

  const countJobs = async (tenantId: string): Promise<number> => {
    const { rows } = await admin().query<{ n: number }>(
      "select count(*)::int as n from ops.jobs where tenant_id = $1",
      [tenantId],
    );
    return rows[0].n;
  };

  return {
    buildOfficeTask,
    requestRun,
    onSharedLease,
    runAgentJob,
    readRun,
    runEvents,
    readTaskRow,
    expireLease,
    sweepStaleRuns,
    countJobs,
  };
}
