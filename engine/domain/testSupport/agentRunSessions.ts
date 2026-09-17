// Shared fixtures and probes for the two-session agent run suites
// (agentRuns.dbtest.ts, agentRunHeldRuns.dbtest.ts, executionStopCli.dbtest.ts).
//
// Each suite owns its connections and its lifecycle; this module only knows how
// to use them. `agentRunProbes` takes an accessor rather than the connections
// themselves because a suite opens them in `beforeAll`, after this module's
// probes are built. It lives in engine/domain because only there may code
// import the domain services, the worker capabilities and the database fixture
// together (eslint.config.js). All data is synthetic office-operations text.

import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../../db/types.ts";
import { createWorkerDatabase } from "../../db/workerDatabase.ts";
import { MODEL_ROUTE_POLICIES } from "../../models/router.ts";
import {
  grantCapabilities,
  type AgentRunCompletion,
} from "../../worker/capabilities.ts";
import {
  ADMIN_URL,
  adminPool,
  cleanupFixtures,
  provisionWorkerRole,
  TENANT_A,
  workerDatabase,
} from "../../worker/testSupport/dbFixture.ts";
import { requestAgentRun, type RequestAgentRunInput } from "../agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "../companyOs.ts";
import type { ExecutionStopTarget } from "../executionStops.ts";

export const SOURCE = "dbtest-agent-runs";
export const HOLDER = "dbtest-agent-runs-holder";
export const OTHER = "dbtest-agent-runs-other";

/** Long enough to take a step inside the lease; short enough to run out while the step is held. */
export const SHORT_LEASE_SECONDS = 3;
/** Bounds every call that must NOT wait: a wait becomes 55P03 instead of a hang. */
export const LOCK_TIMEOUT = "2s";

export const TRIP = { reason: "dbtest kill switch drill", actor: "dbtest" };
export const CLEAR = { reason: "dbtest drill over", actor: "dbtest" };
export const START = Object.freeze({
  provider: "fake",
  model: "fake-model-1",
  promptVersion: "task_assessment.v1",
  inputFingerprint: "f".repeat(64),
  maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
});
export const COMPLETION: AgentRunCompletion = Object.freeze({
  result: {
    outcome: "completed",
    summary: "Order paper, toner and coffee before Friday.",
    proposed_next_steps: ["Check the stock list."],
  },
  responseModel: "fake-model-1",
  finishReason: "completed",
  providerRequestId: "fake-req-1",
  providerResponseId: "fake-resp-1",
  usage: null,
  latencyMs: 5,
});

export interface AgentRunDatabases {
  readonly admin: Pool;
  /** Owner transactions: the worker's adapter pointed at the admin connection. */
  readonly owner: WorkerDatabase;
  readonly worker: WorkerDatabase;
}

/**
 * Provisions the worker role and opens a suite's connections. Several owner and
 * worker transactions at once: two sessions and a one-shot transaction can be
 * open together.
 */
export function openAgentRunDatabases(): AgentRunDatabases {
  provisionWorkerRole();
  return {
    admin: adminPool(),
    owner: createWorkerDatabase({ connectionString: ADMIN_URL, max: 4 }),
    worker: workerDatabase(4),
  };
}

/** Closes what openAgentRunDatabases opened and removes the suite's rows. */
export async function closeAgentRunDatabases(
  databases: Partial<AgentRunDatabases>,
): Promise<void> {
  await databases.worker?.close();
  await databases.owner?.close();
  await cleanupFixtures(databases.admin);
  await databases.admin?.end();
}

export interface Office {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
  readonly otherAgentId: string;
  readonly taskId: string;
}

export interface RunRow {
  status: string;
  job_id: string | null;
  stop_id: string | null;
  error_category: string | null;
  error_code: string | null;
  job_attempt: number | null;
  provider: string | null;
}

export const ownerContext = (tenantId: string) => ({
  tenantId,
  source: SOURCE,
});

export const runInput = (
  office: Office,
  idempotencyKey: string,
  overrides: Partial<RequestAgentRunInput> = {},
): RequestAgentRunInput => ({
  taskId: office.taskId,
  agentId: office.agentId,
  capability: "task_assessment",
  idempotencyKey,
  ...overrides,
});

export const agentTarget = (office: Office): ExecutionStopTarget => ({
  scope: "agent",
  tenantId: office.tenantId,
  companyId: office.companyId,
  agentId: office.agentId,
});

export async function createAssignedTask(
  tx: TxClient,
  office: Pick<Office, "tenantId" | "companyId" | "departmentId" | "agentId">,
  title: string,
): Promise<string> {
  const ctx = ownerContext(office.tenantId);
  const taskId = await createTask(tx, ctx, {
    companyId: office.companyId,
    departmentId: office.departmentId,
    type: "operations.supply_order",
    title,
  });
  await assignTask(tx, ctx, taskId, office.agentId);
  return taskId;
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

/** How every runtime transaction after the lease begins. */
export async function resume(
  tx: TxClient,
  workerId: string,
  jobId: string,
): Promise<void> {
  await tx.query("set local role ops_worker");
  const { rows } = await tx.query<{ id: string | null }>(
    "select id from ops.resume_lease($1, $2)",
    [workerId, jobId],
  );
  if (rows[0]?.id !== jobId) {
    throw new Error(
      "the lease could not be resumed; the case would prove nothing",
    );
  }
}

/** The capabilities exactly as the handler receives them. */
export const capabilities = (tx: TxClient) =>
  grantCapabilities(tx, ["claimAgentRun", "startAgentRun", "completeAgentRun"]);

/**
 * Rows this transaction has inserted, updated or deleted in ops, counting those a
 * rolled-back savepoint undid. A refusal that raised after a write leaves no row
 * behind to read; it leaves this count.
 */
export async function opsRowsWritten(tx: TxClient): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as n from pg_stat_xact_user_tables where schemaname = 'ops'",
  );
  return Number(rows[0]?.n ?? 0);
}

export interface AgentRunProbes {
  /** A company, a department, two agents, and a task assigned to the first. */
  buildOffice(tenantId?: string, slug?: string): Promise<Office>;
  /** One run requested by the owner, committed. */
  requestRun(office: Office, idempotencyKey: string): Promise<string>;
  readRun(runId: string): Promise<RunRow>;
  countRows(sql: string, params: unknown[]): Promise<number>;
  runsIn(tenantIds: string[]): Promise<number>;
  jobsIn(tenantIds: string[]): Promise<number>;
  /** TX1: lease the queue head as `workerId` and commit. */
  leaseHead(workerId: string, leaseSeconds?: number): Promise<string | null>;
  /** A whole prepare transaction, committed: claim, then start. Resolves to the start's token. */
  prepare(workerId: string, jobId: string): Promise<string>;
  /** ops.reap_expired_leases(), refusing to wait on a lock. */
  reap(): Promise<number>;
  /** ops.settle_stale_agent_runs(), refusing to wait on a lock. */
  sweep(): Promise<number>;
  /** A lease as OTHER, refusing to wait on a lock. */
  leaseAsOther(): Promise<string | null>;
  /** The backends `pid` is waiting on, as the lock manager sees them now. */
  blockingPids(pid: number): Promise<number[]>;
  /** Polls the database clock, bounded, until the job's lease has ended. */
  waitUntilLeaseEnded(jobId: string): Promise<void>;
}

/** The probes that need a suite's connections, bound to them through `databases`. */
export function agentRunProbes(
  databases: () => AgentRunDatabases,
): AgentRunProbes {
  const admin = () => databases().admin;
  const owner = () => databases().owner;
  const worker = () => databases().worker;

  const buildOffice = (
    tenantId: string = TENANT_A,
    slug = "dbtest-office",
  ): Promise<Office> =>
    owner().withTransaction(async (tx) => {
      const ctx = ownerContext(tenantId);
      const companyId = await createCompany(tx, ctx, { slug, name: "Office" });
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
      });
      const otherAgentId = await createAgent(tx, ctx, {
        companyId,
        departmentId,
        slug: "front-desk",
        name: "Front desk",
        role: "Front desk assistant",
      });
      const taskId = await createAssignedTask(
        tx,
        { tenantId, companyId, departmentId, agentId },
        "Prepare next week's office supply order",
      );
      return {
        tenantId,
        companyId,
        departmentId,
        agentId,
        otherAgentId,
        taskId,
      };
    });

  const requestRun = (office: Office, idempotencyKey: string) =>
    owner().withTransaction((tx) =>
      requestAgentRun(
        tx,
        ownerContext(office.tenantId),
        runInput(office, idempotencyKey),
      ),
    );

  const readRun = async (runId: string): Promise<RunRow> => {
    const { rows } = await admin().query<RunRow>(
      `select status, job_id, stop_id, error_category, error_code, job_attempt, provider
         from ops.agent_runs where id = $1`,
      [runId],
    );
    if (!rows[0]) throw new Error("the agent run under test does not exist");
    return rows[0];
  };

  const countRows = async (sql: string, params: unknown[]) => {
    const { rows } = await admin().query<{ n: number }>(sql, params);
    return Number(rows[0].n);
  };
  const runsIn = (tenantIds: string[]) =>
    countRows(
      "select count(*)::int as n from ops.agent_runs where tenant_id = any($1::uuid[])",
      [tenantIds],
    );
  const jobsIn = (tenantIds: string[]) =>
    countRows(
      "select count(*)::int as n from ops.jobs where tenant_id = any($1::uuid[])",
      [tenantIds],
    );

  const leaseHead = (workerId: string, leaseSeconds = 60) =>
    worker().withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ id: string | null }>(
        "select id from ops.lease_job($1, $2)",
        [workerId, leaseSeconds],
      );
      return rows[0]?.id ?? null;
    });

  const prepare = (workerId: string, jobId: string) =>
    worker().withTransaction(async (tx) => {
      await resume(tx, workerId, jobId);
      await capabilities(tx).claimAgentRun();
      return capabilities(tx).startAgentRun(START);
    });

  /** A worker-role statement in its own transaction, bounded so that waiting is an error. */
  const asWorker = <T>(sql: string, params: unknown[] = []) =>
    worker().withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      await tx.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
      const { rows } = await tx.query<T>(sql, params);
      return rows;
    });

  const reap = async () =>
    Number(
      (
        await asWorker<{ n: number }>("select ops.reap_expired_leases() as n")
      )[0].n,
    );
  const sweep = async () =>
    Number(
      (
        await asWorker<{ n: number }>(
          "select ops.settle_stale_agent_runs() as n",
        )
      )[0].n,
    );
  const leaseAsOther = async () =>
    (
      await asWorker<{ id: string | null }>(
        "select id from ops.lease_job($1, 60)",
        [OTHER],
      )
    )[0]?.id ?? null;

  const blockingPids = async (pid: number): Promise<number[]> => {
    const { rows } = await admin().query<{ pids: number[] }>(
      "select pg_blocking_pids($1) as pids",
      [pid],
    );
    return rows[0].pids;
  };

  const waitUntilLeaseEnded = async (jobId: string): Promise<void> => {
    const deadline = Date.now() + (SHORT_LEASE_SECONDS + 10) * 1000;
    for (;;) {
      const { rows } = await admin().query<{ ended: boolean }>(
        "select lease_expires_at <= clock_timestamp() as ended from ops.jobs where id = $1",
        [jobId],
      );
      if (rows[0]?.ended) return;
      if (Date.now() > deadline) {
        throw new Error("the short lease never ended");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  return {
    buildOffice,
    requestRun,
    readRun,
    countRows,
    runsIn,
    jobsIn,
    leaseHead,
    prepare,
    reap,
    sweep,
    leaseAsOther,
    blockingPids,
    waitUntilLeaseEnded,
  };
}
