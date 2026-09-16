// The agent runtime against a real Postgres: the real `pg` driver, the real
// constrained worker role, the real worker runtime and the real agent run
// handler, with a scripted model provider standing in for the vendor.
//
// supabase/tests/agent_runtime.sql attacks the database with psql, inside ONE
// rolled-back transaction, on leases it takes by hand. It cannot see what this
// file proves:
//
//   * that runOneJob's separately COMMITTED transactions around the model call
//     leave the database in the states the SQL cases assume, in that order;
//   * what a model call leaves behind when a REAL worker process is killed while
//     the call is in flight;
//   * that the handler's TypeScript refusals, the lease-derived deadline and the
//     shutdown signal are recorded the way the database decides;
//   * what a pooled connection carries after an agent run;
//   * that the TypeScript mirrors of the database (the run state machine, the
//     category -> status mapping) are the same relations.
//
// Every case counts provider calls. "A run is started once" is proven only by a
// count that stays at one across a crash, a retry and a recovery.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import {
  agentRunStatusForCategory,
  MODEL_ERROR_CATEGORIES,
} from "../models/errors.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
  type FakeModelProvider,
} from "../models/fakeModelProvider.ts";
import { fingerprintModelRequest } from "../models/fingerprint.ts";
import { createModelRouter } from "../models/router.ts";
import {
  TASK_ASSESSMENT_PROMPT_VERSION,
  type TaskAssessment,
} from "../models/taskAssessment.ts";
import type { ModelProvider, ModelRequest } from "../models/types.ts";
import { grantCapabilities } from "../worker/capabilities.ts";
import {
  createRegistry,
  isExternalCallHandler,
  resolveHandler,
  type ExternalCallHandlerDefinition,
  type HandlerRegistry,
  type PrepareBudget,
} from "../worker/handlerRegistry.ts";
import type { LeasedJob } from "../worker/job.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import { runOneJob, type RunOneJobOptions } from "../worker/runOneJob.ts";
import { runWorker } from "../worker/runWorker.ts";
import {
  ADMIN_URL,
  adminPool,
  cleanupFixtures,
  provisionWorkerRole,
  readJob,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  WORKER_URL,
  workerDatabase,
} from "../worker/testSupport/dbFixture.ts";
import { testChildEnvironment } from "../worker/testSupport/childEnvironment.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";
import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TRANSITIONS,
  canTransitionAgentRun,
  type AgentRunStatus,
} from "./agentRunStateMachine.ts";
import { requestAgentRun } from "./agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "./companyOs.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";

const SOURCE = "dbtest-agent-runtime";
const WORKER = "dbtest-agent-runtime";
const MODEL = "fake-model-1";
const AGENT_WORKER_SCRIPT = "engine/worker/testSupport/agentRunWorker.ts";

// Sentinels inside the tenant text a run reads. They must reach the model, and
// nothing the database keeps about the run may contain them.
const TASK_SENTINEL = "dbtest-sentinel-task-4f1c";
const AGENT_SENTINEL = "dbtest-sentinel-agent-9b2e";

const VALID: TaskAssessment = Object.freeze({
  outcome: "completed",
  summary: "Order paper, toner and coffee before Friday.",
  proposed_next_steps: Object.freeze([
    "Check the stock list.",
    "Place the order with the usual supplier.",
  ]),
});

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(async () => {
  provisionWorkerRole();
  admin = adminPool();
  // Owner transactions use the same adapter as the worker, pointed at the
  // admin connection, exactly as companyOs.dbtest.ts does.
  owner = createWorkerDatabase({ connectionString: ADMIN_URL, max: 2 });
  db = workerDatabase(2);
}, 60_000);

afterAll(async () => {
  await db?.close();
  await owner?.close();
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

// ---------------------------------------------------------------------------
// Fixtures and probes
// ---------------------------------------------------------------------------

interface OfficeTask {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
  readonly taskId: string;
}

/** One company, department and agent, and a task assigned to that agent. */
function buildOfficeTask(tenantId: string = TENANT_A): Promise<OfficeTask> {
  return owner.withTransaction(async (tx) => {
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
}

function requestRun(office: OfficeTask, idempotencyKey: string) {
  return owner.withTransaction((tx) =>
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
}

/** The production registry, its `standard` route served by `provider`. */
function registryServing(provider: ModelProvider): HandlerRegistry {
  const modelRouter = createModelRouter({
    routes: new Map([["standard", { provider: provider.name, model: MODEL }]]),
    providers: new Map([[provider.name, provider]]),
  });
  return createHandlerRegistry({ modelRouter });
}

/** The production registry, its `standard` route served by a counting fake provider. */
function fakeRuntime(script: FakeBehavior): {
  provider: FakeModelProvider;
  registry: HandlerRegistry;
} {
  const provider = createFakeModelProvider(script);
  return { provider, registry: registryServing(provider) };
}

/** The production agent run handler, exactly as the registry holds it. */
function agentRunHandler(
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
function reusingFirstClaim(registry: HandlerRegistry): HandlerRegistry {
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

/** What a live 30 s lease leaves a prepare: above the handler's minimum. */
const SHARED_LEASE_BUDGET: PrepareBudget = Object.freeze({
  callBudgetMs: 20_000,
  remainingMs: () => 20_000,
});

/**
 * Runs `step` in a worker transaction on a lease THIS process did not take,
 * resumed by worker id and job id, as a second process configured with the
 * same worker id could (finding AR-03). Throws when the lease is not live, so a
 * case cannot pass on a refusal that has nothing to do with the run.
 */
function onSharedLease<T>(
  workerId: string,
  jobId: string,
  step: (tx: TxClient, job: LeasedJob) => Promise<T>,
): Promise<T> {
  return db.withTransaction(async (tx) => {
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
}

/**
 * Resolves or rejects as `promise` does, or rejects with `message` once `ms`
 * pass first. It bounds a wait on an event; it never stands in for one.
 */
async function withinMs<T>(
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

function runAgentJob(
  registry: HandlerRegistry,
  options: Omit<Partial<RunOneJobOptions>, "registry"> = {},
) {
  return runOneJob(db, { workerId: WORKER, registry, ...options });
}

interface RunRow {
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

async function readRun(runId: string): Promise<RunRow> {
  const { rows } = await admin.query<RunRow>(
    "select * from ops.agent_runs where id = $1",
    [runId],
  );
  if (!rows[0]) throw new Error("the agent run under test does not exist");
  return rows[0];
}

interface RunEvent {
  id: string;
  type: string;
  correlation_id: string | null;
  causation_id: string | null;
  payload: Record<string, unknown>;
}

async function runEvents(runId: string): Promise<RunEvent[]> {
  const { rows } = await admin.query<RunEvent>(
    `select id, type, correlation_id, causation_id, payload
       from ops.events
      where subject_type = 'agent_run' and subject_id = $1
      order by seq`,
    [runId],
  );
  return rows;
}

async function readTaskRow(taskId: string): Promise<unknown> {
  const { rows } = await admin.query<{ row: unknown }>(
    "select row_to_json(t)::jsonb as row from ops.tasks t where t.id = $1",
    [taskId],
  );
  return rows[0]?.row;
}

async function expireLease(jobId: string): Promise<void> {
  await admin.query(
    "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
    [jobId],
  );
}

/** ops.settle_stale_agent_runs(), as the worker's reaper tick calls it. */
function sweepStaleRuns(): Promise<number> {
  return db.withTransaction(async (tx) => {
    await tx.query("set local role ops_worker");
    const { rows } = await tx.query<{ settled: number }>(
      "select ops.settle_stale_agent_runs() as settled",
    );
    return Number(rows[0]?.settled);
  });
}

async function countJobs(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from ops.jobs where tenant_id = $1",
    [tenantId],
  );
  return rows[0].n;
}

/** Resolves to what the promise rejected with; fails the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection, but the call succeeded");
}

// ---------------------------------------------------------------------------
// 1. The first demonstration flow
// ---------------------------------------------------------------------------

describe("an agent run through the real worker runtime", () => {
  // What the SQL suite cannot prove: that the handler, the router and three
  // committed runtime transactions together store exactly the facts of the
  // call the PROVIDER received (the stored fingerprint is recomputed from the
  // request the fake actually got), that tenant text reaches the model and
  // nowhere else the database keeps, that the job ledger's detail is metadata
  // only, and that the whole flow leaves the task row byte-identical.
  it("assesses an assigned task with one provider call, stores the facts of that call, and never touches the task", async () => {
    const office = await buildOfficeTask();
    const taskBefore = await readTaskRow(office.taskId);
    const runId = await requestRun(office, "supply-order-1");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      provider: "fake",
      model: MODEL,
      response_model: MODEL,
      prompt_version: TASK_ASSESSMENT_PROMPT_VERSION,
      job_attempt: 1,
      finish_reason: "completed",
      provider_request_id: "fake-req-1",
      provider_response_id: "fake-resp-1",
      input_tokens: 120,
      output_tokens: 60,
      total_tokens: 180,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      error_category: null,
      error_code: null,
      stop_id: null,
    });
    expect(run.latency_ms).toBeGreaterThanOrEqual(0);
    expect(run.result).toEqual(VALID);
    expect(Object.keys(run.result as object).sort()).toEqual([
      "outcome",
      "proposed_next_steps",
      "summary",
    ]);

    // The fingerprint names the request the provider actually received.
    const sent = provider.calls[0];
    expect(run.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(run.input_fingerprint).toBe(
      fingerprintModelRequest(sent, "fake", TASK_ASSESSMENT_PROMPT_VERSION),
    );

    // Tenant text reached the model; no identifier did.
    const sentText = JSON.stringify(sent);
    expect(sentText).toContain(TASK_SENTINEL);
    expect(sentText).toContain(AGENT_SENTINEL);
    const jobId = run.job_id as string;
    for (const id of [
      office.tenantId,
      office.companyId,
      office.departmentId,
      office.agentId,
      office.taskId,
      runId,
      jobId,
    ]) {
      expect(sentText).not.toContain(id);
    }

    // Nothing the database keeps about the run holds the tenant text, and the
    // job ledger holds no model answer either.
    const { rows: runText } = await admin.query<{ text: string }>(
      "select row_to_json(r)::text as text from ops.agent_runs r where r.id = $1",
      [runId],
    );
    const { rows: ledgerText } = await admin.query<{ text: string }>(
      `select e.payload::text as text from ops.events e
        where e.subject_type = 'agent_run' and e.subject_id = $1
       union all
       select row_to_json(j)::text from ops.jobs j where j.id = $2
       union all
       select coalesce(je.detail, '') from ops.job_events je where je.job_id = $2`,
      [runId, jobId],
    );
    expect(runText).toHaveLength(1);
    expect(ledgerText.length).toBeGreaterThanOrEqual(6);
    for (const { text } of [...runText, ...ledgerText]) {
      expect(text).not.toContain(TASK_SENTINEL);
      expect(text).not.toContain(AGENT_SENTINEL);
    }
    for (const { text } of ledgerText) {
      expect(text).not.toContain(VALID.summary);
    }
    const { rows: succeeded } = await admin.query<{ detail: string }>(
      "select detail from ops.job_events where job_id = $1 and event = 'succeeded'",
      [jobId],
    );
    expect(succeeded).toEqual([
      {
        detail: `agent_run=${runId} status=succeeded route=standard provider=fake model=${MODEL} input_tokens=120 output_tokens=60 category=-`,
      },
    ]);

    // Exactly three facts, one correlation, each caused by the one before.
    const events = await runEvents(runId);
    expect(events.map((e) => e.type)).toEqual([
      "agent_run.requested",
      "agent_run.started",
      "agent_run.succeeded",
    ]);
    expect(new Set(events.map((e) => e.correlation_id))).toEqual(
      new Set([run.correlation_id]),
    );
    expect(events.map((e) => e.causation_id)).toEqual([
      null,
      events[0].id,
      events[1].id,
    ]);

    expect(await readTaskRow(office.taskId)).toEqual(taskBefore);
    expect((await readJob(admin, jobId)).status).toBe("succeeded");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2 and 3. Crashes around the call
// ---------------------------------------------------------------------------

interface WorkerExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface SpawnedAgentWorker {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves on the worker's `model_call_started` line; rejects if it exits first. */
  readonly modelCallStarted: Promise<void>;
  /** Resolves once the process has exited and its output streams have closed. */
  readonly closed: Promise<WorkerExit>;
}

const isModelCallStartedLine = (line: string): boolean => {
  try {
    return JSON.parse(line).event === "model_call_started";
  } catch {
    return false;
  }
};

const modelCallsStarted = (stdout: string): number =>
  stdout.split("\n").filter(isModelCallStartedLine).length;

function spawnAgentRunWorker(
  workerId: string,
  behavior: string,
  env: Readonly<Record<string, string>> = {},
): SpawnedAgentWorker {
  const child = spawn(process.execPath, [AGENT_WORKER_SCRIPT], {
    env: testChildEnvironment(process.env, {
      OPS_WORKER_DATABASE_URL: WORKER_URL,
      OPS_WORKER_ID: workerId,
      FAKE_MODEL_BEHAVIOR: behavior,
      ...env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const closed = new Promise<WorkerExit>((resolve) =>
    child.once("close", (code) => resolve({ code, stdout, stderr })),
  );
  const modelCallStarted = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.split("\n").some(isModelCallStartedLine)) resolve();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      reject(
        new Error(
          `${workerId} exited ${code} before its model call started: ${stderr || stdout}`,
        ),
      ),
    );
  });
  // A case that never waits for a call (a process that refuses to start) must
  // not leave this rejection unhandled; awaiting it still rejects.
  modelCallStarted.catch(() => undefined);
  return { child, modelCallStarted, closed };
}

/**
 * Asks a spawned worker to stop the way an operator would: SIGTERM on POSIX, as
 * main.ts wires it; the stdin channel on win32, where child.kill("SIGTERM") is
 * TerminateProcess and no handler runs (measured in concurrency.dbtest.ts).
 */
function requestStop(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32") {
    child.stdin.write("stop\n");
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * Requests a run, lets a spawned worker process start its model call, and
 * SIGKILLs the process while the call is in flight. Then expires the lease, so
 * recovery is driven by the database's clock rather than by waiting it out.
 */
async function killWorkerDuringCall(workerId: string) {
  const office = await buildOfficeTask();
  const runId = await requestRun(office, `crash-${workerId}`);
  const worker = spawnAgentRunWorker(workerId, "hang");
  try {
    await worker.modelCallStarted;
  } finally {
    worker.child.kill("SIGKILL");
    await worker.closed;
  }

  // The start was committed BEFORE the call left the process.
  const run = await readRun(runId);
  expect(run).toMatchObject({ status: "running", job_attempt: 1 });
  expect(run.started_at).not.toBeNull();
  const jobId = run.job_id as string;
  expect(await readJob(admin, jobId)).toMatchObject({
    status: "leased",
    attempts: 1,
    lease_owner: workerId,
  });

  await expireLease(jobId);
  return { runId, jobId };
}

describe("a worker process killed while its model call is in flight", () => {
  // What the SQL suite cannot prove: that a real process, killed with no
  // shutdown hook while the provider call is on the wire, has already
  // committed `running` (the prepare transaction is durable before the call),
  // and that the stale-run sweep followed by a real worker loop settles the
  // run without issuing the call again.
  it("is recovered by the stale-run sweep as indeterminate, and the next worker never calls the provider", async () => {
    const { runId, jobId } = await killWorkerDuringCall(
      "dbtest-agent-crash-sweep",
    );

    expect(await sweepStaleRuns()).toBe(1);
    const swept = await readRun(runId);
    expect(swept).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      result: null,
    });

    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const stats = await runWorker({
      workerId: "dbtest-agent-recoverer",
      db,
      registry,
      maxIterations: 2,
      pollIntervalMs: 10,
      reapIntervalMs: 0,
      heartbeatIntervalMs: 60_000,
    });

    expect(provider.calls).toHaveLength(0);
    expect(stats).toMatchObject({ leased: 1, succeeded: 1 });
    expect(await readRun(runId)).toEqual(swept);
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
  }, 60_000);

  // What the SQL suite cannot prove: the same crash with NO sweep in between,
  // so what stands between a job retry and a second paid call is the next
  // attempt's own claim and start on a real re-lease (lease_job reaps the
  // expired lease and hands the job straight back as attempt 2).
  it("is settled indeterminate by the job's next attempt when no sweep ran, and the provider is never called", async () => {
    const { runId, jobId } = await killWorkerDuringCall(
      "dbtest-agent-crash-claim",
    );
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 2,
      detail: `agent_run=${runId} status=indeterminate`,
    });
    expect(provider.calls).toHaveLength(0);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      job_attempt: 1,
      result: null,
    });
    expect((await readJob(admin, jobId)).status).toBe("succeeded");
  }, 60_000);
});

describe("a second process that shares the worker id of a call in flight", () => {
  // What the SQL suite cannot prove (L4 claims twice on ONE connection, with no
  // call anywhere): a REAL process has committed `running` and its call is on
  // the wire under a live lease, and a second process configured with the same
  // worker id resumes that lease (AR-03). The real handler's claim must refuse
  // rather than settle the run from under the call; a start made without a claim
  // must answer `already_running`, never `running`; and the crash that follows
  // is still recovered without a second call.
  it("refuses to claim or restart a run whose own attempt's call is still in flight, and the crash that follows is recovered without a second call", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "shared-worker-id");
    const jobId = (await readRun(runId)).job_id as string;
    const workerId = "dbtest-agent-shared-id";
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const handler = agentRunHandler(registry);
    const first = spawnAgentRunWorker(workerId, "hang");
    try {
      await first.modelCallStarted;
      const inFlight = await readRun(runId);
      expect(inFlight).toMatchObject({ status: "running", job_attempt: 1 });

      const claim = await rejectionOf(
        onSharedLease(workerId, jobId, (tx, job) =>
          handler.prepare(
            job,
            grantCapabilities(tx, handler.prepareCapabilities),
            SHARED_LEASE_BUDGET,
          ),
        ),
      );
      expect(claim).toMatchObject({ code: "42501" });
      expect((claim as Error).message).toMatch(/never claimed twice/);

      const start = await onSharedLease(workerId, jobId, (tx) =>
        grantCapabilities(tx, ["startAgentRun"]).startAgentRun({
          provider: "fake",
          model: MODEL,
          promptVersion: TASK_ASSESSMENT_PROMPT_VERSION,
          inputFingerprint: inFlight.input_fingerprint as string,
        }),
      );
      expect(start).toBe("already_running");

      expect(await readRun(runId)).toEqual(inFlight);
      expect(provider.calls).toHaveLength(0);
    } finally {
      first.child.kill("SIGKILL");
    }
    expect(modelCallsStarted((await first.closed).stdout)).toBe(1);

    await expireLease(jobId);
    const recovered = await runAgentJob(registry);

    expect(provider.calls).toHaveLength(0);
    expect(recovered).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 2,
      detail: `agent_run=${runId} status=indeterminate`,
    });
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      job_attempt: 1,
      result: null,
    });
  }, 60_000);
});

describe("a retried attempt that reaches start with a stale claim", () => {
  // What the SQL suite cannot prove (N3 calls a later attempt's start by hand):
  // that the database's START, on its own, keeps a second paid call from leaving
  // the real runtime. This handler reuses its first claim, so the job's next
  // attempt reaches ops.start_agent_run still believing the run is pending. The
  // start must settle the crashed attempt's run; a start that answered `running`
  // for a run already running would send the call again.
  it("settles a crashed attempt's run at the next attempt's start even when that attempt reuses a stale claim, and never calls the provider again", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "stale-claim");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const stale = reusingFirstClaim(registry);

    await expect(
      runAgentJob(stale, {
        onCallFinished: async () => {
          throw new Error("process died after the answer arrived");
        },
      }),
    ).rejects.toThrow(/process died/);
    const started = await readRun(runId);
    expect(started).toMatchObject({ status: "running", job_attempt: 1 });
    expect(provider.calls).toHaveLength(1);
    const jobId = started.job_id as string;
    await expireLease(jobId);

    const retry = await runAgentJob(stale);

    expect(provider.calls).toHaveLength(1);
    expect(retry).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 2,
      detail: `agent_run=${runId} status=indeterminate`,
    });
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      error_code: "execution_interrupted",
      job_attempt: 1,
      input_fingerprint: started.input_fingerprint,
      result: null,
    });
    expect((await runEvents(runId)).map((e) => e.type)).toEqual([
      "agent_run.requested",
      "agent_run.started",
      "agent_run.indeterminate",
    ]);
  }, 30_000);
});

describe("a worker that dies after the provider answered", () => {
  // What the SQL suite cannot prove: the window between a PAID answer and the
  // settle transaction, on the real runtime. The answer is lost rather than
  // bought twice: the run stays running, the sweep settles it indeterminate,
  // and the job's next attempt does not call again.
  it("never calls again for a run whose answer arrived but was never settled", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "answered-then-died");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    await expect(
      runAgentJob(registry, {
        onCallFinished: async () => {
          throw new Error("process died after the answer arrived");
        },
      }),
    ).rejects.toThrow(/process died/);

    expect(provider.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run).toMatchObject({ status: "running", result: null });
    const jobId = run.job_id as string;
    expect((await readJob(admin, jobId)).status).toBe("leased");

    await expireLease(jobId);
    expect(await sweepStaleRuns()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      result: null,
    });

    const again = await runAgentJob(registry);
    expect(again).toMatchObject({ outcome: "succeeded", attempt: 2 });
    expect(provider.calls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("indeterminate");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The lease runs out during the call
// ---------------------------------------------------------------------------

describe("a lease that runs out while the model call is in flight", () => {
  // What the SQL suite cannot prove: that the deadline runOneJob derives from
  // the DATABASE's view of the lease actually aborts a slow provider, and that
  // the handler records that abort as a timeout rather than a cancellation or,
  // worse, waits for the answer and records success.
  it("records the run as indeterminate timeout at the lease-derived deadline, with one provider call", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "slow-provider");
    const { provider, registry } = fakeRuntime({
      type: "delay",
      ms: 60_000,
      then: { type: "respond", content: VALID },
    });

    // 8 s lease - 2 s margin: the call gets about 6 s, above the 5 s minimum.
    const result = await runAgentJob(registry, {
      leaseSeconds: 8,
      leaseSafetyMarginMs: 2_000,
    });

    expect(result.outcome).toBe("succeeded");
    expect(result.detail).toMatch(/status=indeterminate .*category=timeout$/);
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "timeout",
      error_code: "deadline",
      result: null,
    });
  }, 60_000);

  // What the SQL suite cannot prove: with no margin, the deadline IS the lease
  // expiry, so the settle transaction finds the lease gone. The runtime must
  // then record nothing about the run (it is not this attempt's any more), and
  // the sweep, not a retry, settles it.
  it("leaves the run to the sweep when the lease is already gone at settlement, and it never reads succeeded", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "slow-provider-no-margin");
    const { provider, registry } = fakeRuntime({
      type: "delay",
      ms: 60_000,
      then: { type: "respond", content: VALID },
    });

    let leaseGoneAtSettlement: boolean | undefined;
    const result = await runAgentJob(registry, {
      leaseSeconds: 7,
      leaseSafetyMarginMs: 0,
      onCallFinished: async (job) => {
        const { rows } = await admin.query<{ gone: boolean }>(
          "select lease_expires_at <= clock_timestamp() as gone from ops.jobs where id = $1",
          [job.id],
        );
        leaseGoneAtSettlement = rows[0]?.gone;
      },
    });

    expect(leaseGoneAtSettlement).toBe(true);
    expect(result).toMatchObject({
      outcome: "failed",
      failureClass: "security",
    });
    expect(provider.calls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("running");

    expect(await sweepStaleRuns()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      result: null,
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5 and 6. Failure categories and malformed output
// ---------------------------------------------------------------------------

async function databaseStatusByCategory(): Promise<Map<string, string | null>> {
  const { rows } = await admin.query<{
    category: string;
    status: string | null;
  }>(
    "select c as category, ops.agent_run_error_status(c) as status from unnest($1::text[]) as c",
    [[...MODEL_ERROR_CATEGORIES]],
  );
  return new Map(rows.map((row) => [row.category, row.status]));
}

describe("model failures", () => {
  // What the SQL suite cannot prove: that engine/models/errors.ts, which the
  // worker reasons with, is the same mapping the database applies, for every
  // category the worker can report.
  it("agree with the database on the run status of every MODEL_ERROR_CATEGORIES entry", async () => {
    const database = await databaseStatusByCategory();
    expect(database.size).toBe(MODEL_ERROR_CATEGORIES.length);
    for (const category of MODEL_ERROR_CATEGORIES) {
      expect(database.get(category), category).not.toBeNull();
      expect(agentRunStatusForCategory(category), category).toBe(
        database.get(category),
      );
    }
  });

  // What the SQL suite cannot prove: that each category a provider failure
  // can carry survives the router, the handler and ops.fail_agent_run as
  // itself (never coerced to `unknown`), in the status the DATABASE derives,
  // with exactly one call per run.
  it("land every MODEL_ERROR_CATEGORIES entry in the status the database decides, through a real run", async () => {
    const office = await buildOfficeTask();
    const database = await databaseStatusByCategory();

    for (const category of MODEL_ERROR_CATEGORIES) {
      const runId = await requestRun(office, `category-${category}`);
      const { provider, registry } = fakeRuntime({
        type: "fail",
        category,
        code: "dbtest_failure",
      });

      const result = await runAgentJob(registry);

      expect(result.outcome, category).toBe("succeeded");
      expect(provider.calls, category).toHaveLength(1);
      expect(await readRun(runId), category).toMatchObject({
        status: database.get(category),
        error_category: category,
        error_code: "dbtest_failure",
        result: null,
      });
    }
  }, 60_000);

  // What the SQL suite cannot prove: that an answer the output contract
  // refuses is recorded as the paid call it was — usage and provider ids kept,
  // no result stored — rather than dropped or retried.
  it("record malformed model output as failed schema_validation, keeping its usage and storing no result", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "malformed-output");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: { ...VALID, proposed_next_steps: "not a list" },
    });

    const result = await runAgentJob(registry);

    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      error_category: "schema_validation",
      error_code: "contract_mismatch",
      result: null,
      response_model: MODEL,
      provider_response_id: "fake-resp-1",
      input_tokens: 120,
      output_tokens: 60,
      total_tokens: 180,
    });
    const events = await runEvents(runId);
    expect(events.map((e) => e.type)).toEqual([
      "agent_run.requested",
      "agent_run.started",
      "agent_run.failed",
    ]);
    expect(events[2].payload).toEqual({
      from_status: "running",
      to_status: "failed",
      error_category: "schema_validation",
      error_code: "contract_mismatch",
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 7. No blind retry
// ---------------------------------------------------------------------------

describe("a job retried after its settlement failed", () => {
  // What the SQL suite cannot prove: the runtime's own failure path after a
  // PAID call. The settle transaction is refused (the lease ran out between the
  // answer and the settlement), the failure path cannot record it either, and
  // the job comes back as a second attempt that must not buy the answer again.
  it("does not call the provider again when settlement was refused because the lease ran out", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "settle-refused");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const first = await runAgentJob(registry, {
      onCallFinished: async (job) => {
        await expireLease(job.id);
      },
    });

    expect(first).toMatchObject({
      outcome: "failed",
      failureClass: "security",
    });
    expect(first.detail).toMatch(/lease could not be resumed/);
    expect((await readRun(runId)).status).toBe("running");

    const retry = await runAgentJob(registry);

    expect(retry).toMatchObject({ outcome: "succeeded", attempt: 2 });
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
      result: null,
    });
  }, 30_000);

  // What the SQL suite cannot prove: a TRANSIENT settle failure while the lease
  // is still live, which the runtime records as a scheduled retry of the job
  // (settle_job_failure -> 'retry'). That retry is exactly where a naive worker
  // would issue the call again.
  it("does not call the provider again when settlement failed transiently and the runtime scheduled the job's retry", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "settle-transient");
    const jobId = (await readRun(runId)).job_id as string;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    // A short statement timeout, so a settle blocked on the run's row lock
    // fails as 57014 (transient) in seconds.
    const shortStatements = createWorkerDatabase({
      connectionString: WORKER_URL,
      max: 2,
      statementTimeoutMs: 2_000,
    });
    const locker = await admin.connect();
    try {
      const first = await runOneJob(shortStatements, {
        workerId: WORKER,
        registry,
        onCallFinished: async () => {
          await locker.query("begin");
          await locker.query(
            "select 1 from ops.agent_runs where id = $1 for update",
            [runId],
          );
        },
      });
      await locker.query("rollback");

      expect(first).toMatchObject({
        outcome: "retry",
        failureClass: "transient",
      });
      expect(first.detail).toMatch(/^57014/);
      expect((await readRun(runId)).status).toBe("running");
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "queued",
        attempts: 1,
        last_error_class: "transient",
      });

      await admin.query(
        "update ops.jobs set available_at = now() where id = $1",
        [jobId],
      );
      const retry = await runOneJob(shortStatements, {
        workerId: WORKER,
        registry,
      });

      expect(retry).toMatchObject({ outcome: "succeeded", attempt: 2 });
      expect(provider.calls).toHaveLength(1);
      expect(await readRun(runId)).toMatchObject({
        status: "indeterminate",
        error_category: "interrupted",
        result: null,
      });
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
      await shortStatements.close();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 8. The kill switch
// ---------------------------------------------------------------------------

describe("the kill switch, end to end", () => {
  // What the SQL suite cannot prove: the switch through the owner services and
  // the real worker, with a provider that would answer. A global stop refuses
  // the REQUEST (a recorded, cancelled run and no job); an agent stop tripped
  // after the request refuses the START on the worker; clearing restores the
  // flow. The provider count is what shows no call slipped through.
  it("refuses a run at request under a global stop and at start under an agent stop, with no provider call, and runs once cleared", async () => {
    const office = await buildOfficeTask();
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const trip = { reason: "dbtest kill switch drill", actor: "dbtest" };
    const clear = { reason: "dbtest drill over", actor: "dbtest" };

    const globalStop = await owner.withTransaction((tx) =>
      tripExecutionStop(tx, { scope: "global" }, trip),
    );
    const refusedAtRequest = await requestRun(office, "stop-global");
    expect(await readRun(refusedAtRequest)).toMatchObject({
      status: "cancelled",
      error_category: "refused",
      error_code: "execution_stopped",
      stop_id: globalStop,
      job_id: null,
    });
    expect(await countJobs(office.tenantId)).toBe(0);
    expect((await runAgentJob(registry)).outcome).toBe("idle");
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, globalStop, clear),
    );

    const refusedAtStart = await requestRun(office, "stop-agent");
    expect((await readRun(refusedAtStart)).status).toBe("pending");
    const agentStop = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        {
          scope: "agent",
          tenantId: office.tenantId,
          companyId: office.companyId,
          agentId: office.agentId,
        },
        trip,
      ),
    );
    expect(await runAgentJob(registry)).toMatchObject({
      outcome: "succeeded",
      detail: `agent_run=${refusedAtStart} status=cancelled`,
    });
    expect(await readRun(refusedAtStart)).toMatchObject({
      status: "cancelled",
      error_category: "refused",
      error_code: "execution_stopped",
      stop_id: agentStop,
      provider: null,
      job_attempt: null,
    });
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, agentStop, clear),
    );
    expect(provider.calls).toHaveLength(0);

    const afterClear = await requestRun(office, "stop-cleared");
    expect((await runAgentJob(registry)).outcome).toBe("succeeded");
    expect((await readRun(afterClear)).status).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 9. Payload forgery
// ---------------------------------------------------------------------------

describe("a job payload that names another tenant's run", () => {
  // What the SQL suite cannot prove: that the WORKER, handed a forged job at
  // the head of the real queue, fails it as a security refusal and reaches
  // neither the named run nor the provider.
  it("fails a forged agent_run.execute job as a security refusal and leaves the other tenant's run untouched", async () => {
    const officeB = await buildOfficeTask(TENANT_B);
    const runB = await requestRun(officeB, "tenant-b-run");
    const runBBefore = await readRun(runB);
    const eventsBefore = await runEvents(runB);
    const { rows } = await admin.query<{ id: string }>(
      "select ops.enqueue_job($1, $2, $3::jsonb, -2147483648, now(), 5, null) as id",
      [
        TENANT_A,
        AGENT_RUN_EXECUTE_KIND,
        JSON.stringify({ agent_run_id: runB }),
      ],
    );
    const forged = rows[0].id;
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result).toMatchObject({
      jobId: forged,
      tenantId: TENANT_A,
      outcome: "failed",
      failureClass: "security",
    });
    expect(result.detail).toMatch(/no agent run is bound to the leased job/);
    expect(provider.calls).toHaveLength(0);
    expect(await readRun(runB)).toEqual(runBBefore);
    expect(await runEvents(runB)).toEqual(eventsBefore);
    expect(await readJob(admin, runBBefore.job_id as string)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  }, 30_000);

  // What neither the SQL suite nor the handler's unit tests can prove: the
  // handler's own payload check on a REAL claim. The job is the one bound to
  // tenant A's run, so the database hands over A's run; its payload, rewritten
  // by the owner, names tenant B's. The attempt must be refused before the run
  // is started.
  it("refuses a run's own job whose payload was rewritten to another tenant's run, before anything is started", async () => {
    const officeA = await buildOfficeTask(TENANT_A);
    const officeB = await buildOfficeTask(TENANT_B);
    const runA = await requestRun(officeA, "tenant-a-run");
    const runB = await requestRun(officeB, "tenant-b-run");
    const runBBefore = await readRun(runB);
    const jobA = (await readRun(runA)).job_id as string;
    await admin.query(
      `update ops.jobs
          set payload = jsonb_build_object('agent_run_id', $2::uuid),
              priority = -2147483648
        where id = $1`,
      [jobA, runB],
    );
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });

    const result = await runAgentJob(registry);

    expect(result).toMatchObject({
      jobId: jobA,
      tenantId: TENANT_A,
      outcome: "failed",
      failureClass: "security",
    });
    expect(result.detail).toMatch(
      /does not name the run its lease is bound to/,
    );
    expect(provider.calls).toHaveLength(0);
    expect(await readRun(runA)).toMatchObject({
      status: "pending",
      provider: null,
      job_attempt: null,
    });
    expect((await runEvents(runA)).map((e) => e.type)).toEqual([
      "agent_run.requested",
    ]);
    expect(await readRun(runB)).toEqual(runBBefore);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 10. Pooling
// ---------------------------------------------------------------------------

describe("a pooled connection after an agent run", () => {
  // What the SQL suite cannot prove: the driver's connection REUSE. With one
  // socket, the transaction after an agent run provably runs on the backend
  // the run's three transactions used, and it must carry no role, lease,
  // tenant or event provenance the capabilities installed — and a capability
  // called on it must refuse.
  it("carries no role, lease, tenant or event provenance into the next transaction, and the run capabilities refuse on it", async () => {
    const pooled = workerDatabase(1);
    try {
      const backendPid = () =>
        pooled.withTransaction(async (tx) => {
          const { rows } = await tx.query<{ pid: number }>(
            "select pg_backend_pid() as pid",
          );
          return rows[0].pid;
        });
      const pidBefore = await backendPid();
      const office = await buildOfficeTask();
      await requestRun(office, "pooled");
      const { provider, registry } = fakeRuntime({
        type: "respond",
        content: VALID,
      });

      const result = await runOneJob(pooled, { workerId: WORKER, registry });
      expect(result.outcome).toBe("succeeded");
      expect(provider.calls).toHaveLength(1);

      const after = await pooled.withTransaction(async (tx) => {
        const { rows: session } = await tx.query<Record<string, unknown>>(
          `select pg_backend_pid() as pid,
                  current_user::text as role,
                  nullif(current_setting('app.job_id', true), '') as job,
                  nullif(current_setting('app.worker_id', true), '') as worker,
                  nullif(current_setting('app.event_source', true), '') as event_source,
                  nullif(current_setting('app.event_correlation_id', true), '') as correlation,
                  nullif(current_setting('app.event_causation_id', true), '') as causation`,
        );
        await tx.query("set local role ops_worker");
        const { rows: scoped } = await tx.query<Record<string, unknown>>(
          `select ops.current_tenant_id()::text as tenant,
                  (select count(*) from ops.jobs)::int as jobs`,
        );
        return { ...session[0], ...scoped[0] };
      });
      expect(after).toEqual({
        pid: pidBefore,
        role: "ops_worker_login",
        job: null,
        worker: null,
        event_source: null,
        correlation: null,
        causation: null,
        tenant: null,
        jobs: 0,
      });
      // The table is not empty; the connection simply sees none of it.
      expect(await countJobs(office.tenantId)).toBe(1);

      const refused = await rejectionOf(
        pooled.withTransaction(async (tx) => {
          await tx.query("set local role ops_worker");
          await tx.query("select ops.claim_agent_run()");
        }),
      );
      expect(refused).toMatchObject({ code: "42501" });
      expect((refused as Error).message).toMatch(/no live lease, so no tenant/);
      expect(await backendPid()).toBe(pidBefore);
    } finally {
      await pooled.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 11. Graceful shutdown
// ---------------------------------------------------------------------------

describe("graceful shutdown during a model call", () => {
  // What the SQL suite cannot prove: that the worker loop's shutdown signal
  // reaches the provider call in flight, and that the aborted call is RECORDED
  // (indeterminate, cancelled) with its job settled before the loop stops,
  // instead of being left running for the sweep.
  //
  // The run alone cannot show the first half: the runtime abandons a call that
  // ignores its signal after a short grace and records the same outcome. So the
  // provider keeps the signal it was handed and whether its own call ended, and
  // both are asserted.
  it("aborts the in-flight call, records the run indeterminate cancelled, settles its job and stops the loop", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "shutdown");
    const fake = createFakeModelProvider({ type: "hang" });
    let providerSignal: AbortSignal | undefined;
    let providerCallEnded = false;
    const provider: ModelProvider = Object.freeze({
      name: fake.name,
      execute(request: ModelRequest, signal: AbortSignal) {
        providerSignal = signal;
        return fake.execute(request, signal).finally(() => {
          providerCallEnded = true;
        });
      },
    });
    const registry = registryServing(provider);
    const controller = new AbortController();
    const workerId = "dbtest-agent-shutdown";

    const stopped = runWorker({
      workerId,
      db,
      registry,
      signal: controller.signal,
      pollIntervalMs: 25,
      heartbeatIntervalMs: 60_000,
      reapIntervalMs: 60_000,
      leaseSeconds: 60,
    });
    await Promise.race([
      fake.callStarted(),
      stopped.then(() => {
        throw new Error("the worker stopped before its model call started");
      }),
    ]);
    controller.abort();
    const stats = await withinMs(
      stopped,
      10_000,
      "the worker loop did not stop within 10 s of shutdown",
    );

    // Shutdown reached the provider's own signal, and the call ended on it:
    // it was not abandoned by the runtime's grace timer.
    expect(providerSignal?.aborted).toBe(true);
    expect(providerCallEnded).toBe(true);
    expect(stats).toMatchObject({ leased: 1, succeeded: 1, failed: 0 });
    expect(fake.calls).toHaveLength(1);
    const run = await readRun(runId);
    expect(run).toMatchObject({
      status: "indeterminate",
      error_category: "cancelled",
      error_code: "aborted",
      result: null,
    });
    expect((await readJob(admin, run.job_id as string)).status).toBe(
      "succeeded",
    );
    const { rows } = await admin.query<{ stopped: boolean }>(
      "select stopped_at is not null as stopped from ops.worker_instances where worker_id = $1",
      [workerId],
    );
    expect(rows).toEqual([{ stopped: true }]);
  }, 30_000);

  // What the in-process case above cannot prove: a real worker PROCESS asked to
  // stop from outside while its call is on the wire (SIGTERM on POSIX, as
  // main.ts wires it; stdin on win32). The process's own stop wiring must reach
  // the call, and the run is recorded and the job settled before it exits 0, so
  // nothing is left running for the sweep.
  it("stops a real worker process mid-call when asked, recording the run indeterminate cancelled and settling its job before it exits", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "process-stop");
    const jobId = (await readRun(runId)).job_id as string;
    const workerId = "dbtest-agent-process-stop";
    const worker = spawnAgentRunWorker(workerId, "hang");

    const exit = await (async () => {
      try {
        await worker.modelCallStarted;
        requestStop(worker.child);
        return await withinMs(
          worker.closed,
          15_000,
          `${workerId} did not exit within 15 s of being asked to stop`,
        );
      } finally {
        worker.child.kill("SIGKILL");
      }
    })();

    expect(exit.code, exit.stderr).toBe(0);
    expect(modelCallsStarted(exit.stdout)).toBe(1);
    const report = JSON.parse(exit.stdout.trim().split("\n").at(-1) ?? "");
    expect(report).toMatchObject({
      workerId,
      calls: 1,
      stats: { leased: 1, succeeded: 1, retried: 0, failed: 0 },
    });
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "cancelled",
      error_code: "aborted",
      job_attempt: 1,
      result: null,
    });
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "succeeded",
      attempts: 1,
    });
    expect(await sweepStaleRuns()).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The test workers stay on this machine
// ---------------------------------------------------------------------------

describe("the database a driver-backed worker may be pointed at", () => {
  // What no other case can prove: the spawned test worker answers whatever run
  // heads the queue with a canned assessment, so pointed at a deployment (an
  // exported OPS_WORKER_DATABASE_URL is enough) it would record fake results
  // there. It must refuse before it opens a connection, naming no part of the
  // connection string.
  it("refuses a worker process pointed at a database that is not on this machine, before connecting and without printing the connection string", async () => {
    const remote =
      "postgresql://ops_worker_login:dbtest-remote-pw@192.0.2.10:5432/postgres";
    const worker = spawnAgentRunWorker("dbtest-agent-remote", "respond", {
      OPS_WORKER_DATABASE_URL: remote,
    });

    const exit = await (async () => {
      try {
        return await withinMs(
          worker.closed,
          15_000,
          "the worker did not refuse a remote database before trying to reach it",
        );
      } finally {
        worker.child.kill("SIGKILL");
      }
    })();

    expect(exit.code).toBe(2);
    expect(exit.stdout).toBe("");
    expect(exit.stderr).toMatch(
      /OPS_WORKER_DATABASE_URL must name a database on this machine/,
    );
    for (const piece of [
      "dbtest-remote-pw",
      "192.0.2.10",
      "ops_worker_login",
    ]) {
      expect(exit.stderr).not.toContain(piece);
    }
  }, 30_000);

  // What the helper's unit tests cannot prove: that the shared fixture every
  // driver-backed suite imports actually applies the check, before it
  // provisions a role or opens a pool, when the production worker's variable
  // names another database on this machine: the other working copy's stack, or
  // another database on the fixture's own server.
  //
  // Both are derived from the fixture's own database, never written as fixed
  // addresses: CI's only stack listens on 54322, the port the other working copy
  // uses here, so a fixed "other" address can be the fixture's own database.
  it("refuses to load the driver-backed fixture when OPS_WORKER_DATABASE_URL names another database", async () => {
    const fixture = new URL(
      "../worker/testSupport/dbFixture.ts",
      import.meta.url,
    ).href;
    const own = new URL(ADMIN_URL);
    const otherPort = own.port === "54322" ? "54342" : "54322";
    const others = [
      `postgresql://ops_worker_login:dbtest-other-pw@${own.hostname}:${otherPort}${own.pathname}`,
      `postgresql://ops_worker_login:dbtest-other-pw@${own.host}/dbtest_other_database`,
    ];
    for (const other of others) {
      // The premise: a database on this machine, and not the fixture's.
      expect(loopbackDatabaseTarget(other)).toBeDefined();
      expect(loopbackDatabaseTarget(other)).not.toBe(
        loopbackDatabaseTarget(ADMIN_URL),
      );

      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(fixture)});`,
        ],
        {
          env: testChildEnvironment(process.env, {
            OPS_WORKER_DATABASE_URL: other,
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const code = await withinMs(
        new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
        15_000,
        "loading the fixture did not finish",
      ).finally(() => child.kill("SIGKILL"));

      expect(code).not.toBe(0);
      expect(stderr).toMatch(
        /OPS_WORKER_DATABASE_URL and ADMIN_DATABASE_URL name different databases/,
      );
      expect(stderr).not.toContain("dbtest-other-pw");
    }
    // Two children, each bounded at 15 s by withinMs, so that message fires first.
  }, 45_000);
});

// ---------------------------------------------------------------------------
// 12. The state machines agree
// ---------------------------------------------------------------------------

describe("the TypeScript and database agent run state machines", () => {
  // What the SQL suite cannot prove: that engine/domain/agentRunStateMachine.ts,
  // which authorises nothing, still describes the machine the trigger enforces.
  // Compared both ways, as edge sets and through the decision function the
  // trigger itself calls for every ordered pair of statuses.
  it("agree on every agent run transition, in both directions", async () => {
    const { rows } = await admin.query<{
      from_status: string;
      to_status: string;
    }>("select from_status, to_status from ops.agent_run_status_transitions()");
    const database = new Set(
      rows.map((r) => `${r.from_status}->${r.to_status}`),
    );
    const typescript = new Set(
      AGENT_RUN_TRANSITIONS.map(([f, t]) => `${f}->${t}`),
    );

    expect(
      [...typescript].filter((edge) => !database.has(edge)),
      "edges only TypeScript allows",
    ).toEqual([]);
    expect(
      [...database].filter((edge) => !typescript.has(edge)),
      "edges only the database allows",
    ).toEqual([]);

    const { rows: decisions } = await admin.query<{
      from_status: AgentRunStatus;
      to_status: AgentRunStatus;
      allowed: boolean;
    }>(
      `select f as from_status, t as to_status, ops.agent_run_transition_allowed(f, t) as allowed
         from unnest($1::text[]) as f cross join unnest($1::text[]) as t`,
      [[...AGENT_RUN_STATUSES]],
    );
    expect(decisions).toHaveLength(AGENT_RUN_STATUSES.length ** 2);
    for (const { from_status, to_status, allowed } of decisions) {
      expect(
        canTransitionAgentRun(from_status, to_status),
        `${from_status}->${to_status}`,
      ).toBe(allowed);
    }
  });

  it("agree on the set of agent run statuses", async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(k.oid) as definition
         from pg_constraint k join pg_namespace n on n.oid = k.connamespace
        where n.nspname = 'ops' and k.conname = 'agent_runs_status_check'`,
    );
    const database = [...rows[0].definition.matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .sort();
    expect(database).toEqual([...AGENT_RUN_STATUSES].sort());
  });
});
