// Agent run requests, the execution stop switch and the run capabilities'
// locks, against a real Postgres through the real `pg` driver — with TWO
// sessions at once.
//
// supabase/tests/agent_runtime.sql attacks each function on ONE connection,
// inside one rolled-back transaction. It can check which lock a function takes
// (section N7), but never what that lock BUYS, because nothing else is running.
// This file proves what only a second session can show:
//
//   * a duplicate request arriving while the first is uncommitted WAITS, then
//     resolves to the first run (or is refused) instead of creating a second;
//   * a lease-bound capability's share lock keeps the reaper, a re-lease and the
//     stale-run sweep off a job whose lease ran out while the step held it;
//   * a start whose lease ran out while it waited on a lock refuses before it
//     writes anything, even when every gate still admits the run;
//   * the sweep passes over a run, or a job, that another transaction holds;
//   * a trip and a start (or a request, or a clear) are serialised: each waits
//     for the other, and decides on what the other committed;
//   * a request naming a run a worker holds refuses without waiting on it;
//   * the owner's stop CLI, as a real process, trips, lists and clears.
//
// Every wait is read from pg_stat_activity while the waiting call is still
// unsettled; a call that never waited fails its case. It lives in engine/domain
// because only there may a test import the domain services, the worker
// capabilities and the database fixture together (eslint.config.js). All data
// is synthetic office-operations text.

import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import {
  grantCapabilities,
  type AgentRunCompletion,
} from "../worker/capabilities.ts";
import {
  ADMIN_URL,
  adminPool,
  cleanupFixtures,
  enqueue,
  provisionWorkerRole,
  readJob,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  workerDatabase,
} from "../worker/testSupport/dbFixture.ts";
import {
  isRowLocked,
  openSession,
  waitUntilBlocked,
  whileRowLocked,
} from "../worker/testSupport/transactionSession.ts";
import { requestAgentRun, type RequestAgentRunInput } from "./agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
  requestTaskExecution,
} from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import {
  clearExecutionStop,
  listExecutionStops,
  tripExecutionStop,
  type ExecutionStopTarget,
} from "./executionStops.ts";

const SOURCE = "dbtest-agent-runs";
const HOLDER = "dbtest-agent-runs-holder";
const OTHER = "dbtest-agent-runs-other";
const STOP_CLI = "engine/cli/executionStop.ts";

/** Long enough to take a step inside the lease; short enough to run out while the step is held. */
const SHORT_LEASE_SECONDS = 3;
/** Bounds every call that must NOT wait: a wait becomes 55P03 instead of a hang. */
const LOCK_TIMEOUT = "2s";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const TRIP = { reason: "dbtest kill switch drill", actor: "dbtest" };
const CLEAR = { reason: "dbtest drill over", actor: "dbtest" };
const START = Object.freeze({
  provider: "fake",
  model: "fake-model-1",
  promptVersion: "task_assessment.v1",
  inputFingerprint: "f".repeat(64),
});
const COMPLETION: AgentRunCompletion = Object.freeze({
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

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

beforeAll(async () => {
  provisionWorkerRole();
  admin = adminPool();
  // Owner transactions use the worker's adapter pointed at the admin
  // connection, as companyOs.dbtest.ts does. Several at once: two sessions and
  // a one-shot transaction can be open together.
  owner = createWorkerDatabase({ connectionString: ADMIN_URL, max: 4 });
  worker = workerDatabase(4);
}, 60_000);

afterAll(async () => {
  await worker?.close();
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

interface Office {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
  readonly otherAgentId: string;
  readonly taskId: string;
}

const ownerContext = (tenantId: string) => ({ tenantId, source: SOURCE });

async function createAssignedTask(
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

/** A company, a department, two agents, and a task assigned to the first. */
function buildOffice(
  tenantId: string = TENANT_A,
  slug = "dbtest-office",
): Promise<Office> {
  return owner.withTransaction(async (tx) => {
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
    return { tenantId, companyId, departmentId, agentId, otherAgentId, taskId };
  });
}

const runInput = (
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

function requestRun(office: Office, idempotencyKey: string): Promise<string> {
  return owner.withTransaction((tx) =>
    requestAgentRun(
      tx,
      ownerContext(office.tenantId),
      runInput(office, idempotencyKey),
    ),
  );
}

const agentTarget = (office: Office): ExecutionStopTarget => ({
  scope: "agent",
  tenantId: office.tenantId,
  companyId: office.companyId,
  agentId: office.agentId,
});

interface RunRow {
  status: string;
  job_id: string | null;
  stop_id: string | null;
  error_category: string | null;
  error_code: string | null;
  job_attempt: number | null;
  provider: string | null;
}

async function readRun(runId: string): Promise<RunRow> {
  const { rows } = await admin.query<RunRow>(
    `select status, job_id, stop_id, error_category, error_code, job_attempt, provider
       from ops.agent_runs where id = $1`,
    [runId],
  );
  if (!rows[0]) throw new Error("the agent run under test does not exist");
  return rows[0];
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(sql, params);
  return Number(rows[0].n);
}

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

/** Resolves to what the promise rejected with; fails the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection, but the call succeeded");
}

// The worker's side, step by step, in the order runOneJob takes it.

/** TX1: lease the queue head and commit. */
function leaseHead(
  workerId: string,
  leaseSeconds = 60,
): Promise<string | null> {
  return worker.withTransaction(async (tx) => {
    await tx.query("set local role ops_worker");
    const { rows } = await tx.query<{ id: string | null }>(
      "select id from ops.lease_job($1, $2)",
      [workerId, leaseSeconds],
    );
    return rows[0]?.id ?? null;
  });
}

/** How every later runtime transaction begins. */
async function resume(
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
const capabilities = (tx: TxClient) =>
  grantCapabilities(tx, ["claimAgentRun", "startAgentRun", "completeAgentRun"]);

/** A whole prepare transaction, committed: claim, then start. Resolves to the start's token. */
function prepare(workerId: string, jobId: string): Promise<string> {
  return worker.withTransaction(async (tx) => {
    await resume(tx, workerId, jobId);
    await capabilities(tx).claimAgentRun();
    return capabilities(tx).startAgentRun(START);
  });
}

/** A worker-role statement in its own transaction, bounded so that waiting is an error. */
function asWorker<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return worker.withTransaction(async (tx) => {
    await tx.query("set local role ops_worker");
    await tx.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    const { rows } = await tx.query<T>(sql, params);
    return rows;
  });
}

const reap = async () =>
  Number(
    (await asWorker<{ n: number }>("select ops.reap_expired_leases() as n"))[0]
      .n,
  );
const sweep = async () =>
  Number(
    (
      await asWorker<{ n: number }>("select ops.settle_stale_agent_runs() as n")
    )[0].n,
  );
const leaseAsOther = async () =>
  (
    await asWorker<{ id: string | null }>(
      "select id from ops.lease_job($1, 60)",
      [OTHER],
    )
  )[0]?.id ?? null;

/**
 * Rows this transaction has inserted, updated or deleted in ops, counting those a
 * rolled-back savepoint undid. A refusal that raised after a write leaves no row
 * behind to read; it leaves this count.
 */
async function opsRowsWritten(tx: TxClient): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as n from pg_stat_xact_user_tables where schemaname = 'ops'",
  );
  return Number(rows[0]?.n ?? 0);
}

async function waitUntilLeaseEnded(jobId: string): Promise<void> {
  const deadline = Date.now() + (SHORT_LEASE_SECONDS + 10) * 1000;
  for (;;) {
    const { rows } = await admin.query<{ ended: boolean }>(
      "select lease_expires_at <= clock_timestamp() as ended from ops.jobs where id = $1",
      [jobId],
    );
    if (rows[0]?.ended) return;
    if (Date.now() > deadline) throw new Error("the short lease never ended");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------
// Requesting an agent run
// ---------------------------------------------------------------------------

describe("requesting an agent run", () => {
  // What the SQL suite cannot prove: a duplicate that arrives while the first
  // request is UNCOMMITTED. Its idempotency lookup finds nothing, so only the
  // database's lock waits and its conflict path stand between it and a second
  // run and a second job.
  it("resolves two concurrent requests with one key to one run and one job, the second waiting for the first to commit", async () => {
    const office = await buildOffice();
    const ctx = ownerContext(office.tenantId);
    const first = openSession(owner);
    const second = openSession(owner);
    try {
      const firstId = await first.run((tx) =>
        requestAgentRun(tx, ctx, runInput(office, "same-key")),
      );
      const secondPid = await second.pid;
      const secondId = second.run((tx) =>
        requestAgentRun(tx, ctx, runInput(office, "same-key")),
      );
      await waitUntilBlocked(admin, secondPid, secondId);
      await first.end("commit");
      expect(await secondId).toBe(firstId);
      await second.end("commit");

      expect(await runsIn([office.tenantId])).toBe(1);
      expect(await jobsIn([office.tenantId])).toBe(1);
      expect((await readRun(firstId)).job_id).not.toBeNull();
      expect(
        await countRows(
          "select count(*)::int as n from ops.events where subject_type = 'agent_run' and subject_id = $1",
          [firstId],
        ),
      ).toBe(1);
    } finally {
      await first.end("rollback");
      await second.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: the conflict path that only a race
  // reaches. The second request's lookup ran before the first committed, so it
  // meets the key at the insert, and must compare the requests there rather
  // than adopt the first run as its own.
  it("refuses a concurrent request that reuses a key for a different task once the first commits, and creates nothing", async () => {
    const office = await buildOffice();
    const ctx = ownerContext(office.tenantId);
    const otherTaskId = await owner.withTransaction((tx) =>
      createAssignedTask(tx, office, "Book the meeting room for the review"),
    );
    const reuse = runInput(office, "shared-key", { taskId: otherTaskId });
    const first = openSession(owner);
    const second = openSession(owner);
    try {
      const firstId = await first.run((tx) =>
        requestAgentRun(tx, ctx, runInput(office, "shared-key")),
      );
      const secondPid = await second.pid;
      const refused = rejectionOf(
        second.run((tx) => requestAgentRun(tx, ctx, reuse)),
      );
      await waitUntilBlocked(admin, secondPid, refused);
      await first.end("commit");
      const error = await refused;
      await second.end("rollback");

      expect(error).toBeInstanceOf(CompanyOsError);
      expect(error).toMatchObject({ code: "invalid_state" });
      expect((error as Error).message).toMatch(/names a different agent run/);
      // The same reuse after the commit is refused by the lookup itself.
      const again = await rejectionOf(
        owner.withTransaction((tx) => requestAgentRun(tx, ctx, reuse)),
      );
      expect(again).toMatchObject({ code: "invalid_state" });
      expect(await runsIn([office.tenantId])).toBe(1);
      expect(await jobsIn([office.tenantId])).toBe(1);
      expect((await readRun(firstId)).status).toBe("pending");
    } finally {
      await first.end("rollback");
      await second.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: that the typed service, through the real
  // driver, surfaces each id from outside the task's tenant or company as
  // not_found — never a native error that would say where the id lives — and
  // writes nothing in either tenant.
  it("treats another tenant's task or agent, and another company's agent, as not found, and records nothing", async () => {
    const office = await buildOffice(TENANT_A, "dbtest-office-a");
    const branch = await buildOffice(TENANT_A, "dbtest-office-a-branch");
    const elsewhere = await buildOffice(TENANT_B, "dbtest-office-b");
    const attempts: readonly [string, RequestAgentRunInput][] = [
      ["another tenant's task", runInput(elsewhere, "cross-tenant-task")],
      [
        "another tenant's agent",
        runInput(office, "cross-tenant-agent", {
          agentId: elsewhere.agentId,
        }),
      ],
      [
        "another company's agent",
        runInput(office, "cross-company-agent", { agentId: branch.agentId }),
      ],
    ];

    for (const [label, input] of attempts) {
      const error = await rejectionOf(
        owner.withTransaction((tx) =>
          requestAgentRun(tx, ownerContext(TENANT_A), input),
        ),
      );
      expect(error, label).toBeInstanceOf(CompanyOsError);
      expect((error as CompanyOsError).code, label).toBe("not_found");
    }
    expect(await runsIn([TENANT_A, TENANT_B])).toBe(0);
    expect(await jobsIn([TENANT_A, TENANT_B])).toBe(0);
  }, 30_000);

  // What the SQL suite cannot prove: the same refusal through the typed
  // boundary, as the conflict code a caller branches on, with nothing written.
  it("refuses a request for an agent the task is not assigned to, and records nothing", async () => {
    const office = await buildOffice();

    const error = await rejectionOf(
      owner.withTransaction((tx) =>
        requestAgentRun(
          tx,
          ownerContext(office.tenantId),
          runInput(office, "not-the-assignee", {
            agentId: office.otherAgentId,
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(CompanyOsError);
    expect(error).toMatchObject({ code: "invalid_state" });
    expect((error as Error).message).toMatch(/not assigned to this agent/);
    expect(await runsIn([office.tenantId])).toBe(0);
  });

  // What the SQL suite cannot prove: a leased worker, on the real constrained
  // login, reaching the owner service through the typed boundary. The refusal
  // must stay the native 42501 a misconfiguration raises, never a domain code.
  it("refuses a leased worker at the privilege layer, and the typed boundary does not disguise it as a domain refusal", async () => {
    const office = await buildOffice();
    const probe = await enqueue(admin, office.tenantId, "dbtest.agent_runs");
    expect(await leaseHead(HOLDER)).toBe(probe);

    const error = await rejectionOf(
      worker.withTransaction(async (tx) => {
        await resume(tx, HOLDER, probe);
        return requestAgentRun(
          tx,
          ownerContext(office.tenantId),
          runInput(office, "from-a-worker"),
        );
      }),
    );

    expect(error).not.toBeInstanceOf(CompanyOsError);
    expect((error as { code?: string }).code).toBe("42501");
    expect(await runsIn([office.tenantId])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A capability's job lock outlives the lease it was taken under
// ---------------------------------------------------------------------------

describe("a run capability holding its leased job past the lease's expiry", () => {
  // What the SQL suite cannot prove: the share lock a capability takes on its
  // job is worth something only if a SECOND session — the reaper, a re-lease —
  // arriving after the lease ran out passes the job over, rather than taking it
  // from under a prepare step that is still deciding whether to call. Each call
  // is bounded by a lock timeout, so a wait fails the case instead of hiding it.
  it("keeps the reaper and a re-lease off a job whose claim is still open, and lets them act once it ends", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "held-claim");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER, SHORT_LEASE_SECONDS)).toBe(jobId);
    const step = openSession(worker);
    try {
      await step.run((tx) => resume(tx, HOLDER, jobId));
      expect(
        await step.run((tx) => capabilities(tx).claimAgentRun()),
      ).toMatchObject({ action: "start", agent_run_id: runId });
      await waitUntilLeaseEnded(jobId);

      expect(await reap()).toBe(0);
      expect(await leaseAsOther()).toBeNull();
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "leased",
        lease_owner: HOLDER,
        attempts: 1,
      });
      // Eligible on the clock; only the step's lock kept it.
      expect(await isRowLocked(admin, "ops.jobs", jobId)).toBe(true);
    } finally {
      await step.end("rollback");
    }

    expect(await reap()).toBe(1);
    expect(await readJob(admin, jobId)).toMatchObject({
      status: "queued",
      attempts: 1,
    });
    expect(await leaseAsOther()).toBe(jobId);
  }, 30_000);

  // What the SQL suite cannot prove: the settle window. The run is committed
  // `running` and its lease has run out, so every recovery path would claim
  // it — yet a settle transaction still holds it, and recording its result is
  // this attempt's to finish or roll back, not the sweep's to overwrite.
  it("keeps the reaper, a re-lease and the stale-run sweep off a running run whose settlement is still open, and lets them act once it ends", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "held-settle");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER, SHORT_LEASE_SECONDS)).toBe(jobId);
    expect(await prepare(HOLDER, jobId)).toBe("running");
    const settle = openSession(worker);
    try {
      await settle.run((tx) => resume(tx, HOLDER, jobId));
      expect(
        await settle.run((tx) => capabilities(tx).completeAgentRun(COMPLETION)),
      ).toBe("succeeded");
      await waitUntilLeaseEnded(jobId);

      expect(await reap()).toBe(0);
      expect(await leaseAsOther()).toBeNull();
      expect(await sweep()).toBe(0);
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "leased",
        lease_owner: HOLDER,
      });
      expect((await readRun(runId)).status).toBe("running");
      expect(await isRowLocked(admin, "ops.jobs", jobId)).toBe(true);
    } finally {
      await settle.end("rollback");
    }

    expect(await reap()).toBe(1);
    expect(await sweep()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
    });
  }, 30_000);

  // What the SQL suite cannot prove: the lease looked at again AFTER the start's
  // lock waits. The start proves its lease live when it begins, then waits on a
  // task row an owner holds; the lease runs out on the database clock meanwhile;
  // the owner commits without changing the task, so every gate the start reads
  // afterwards still admits the run. Only that second look at the clock keeps
  // the start from answering `running` — the one token that means "call" — on a
  // lease that is no longer live, and it looks before the start writes anything.
  it("refuses a start whose lease ran out while it waited on the task lock, and leaves the run pending", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "start-behind-task-lock");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER, SHORT_LEASE_SECONDS)).toBe(jobId);
    const start = openSession(worker);
    const taskLock = openSession(owner);
    try {
      await start.run((tx) => resume(tx, HOLDER, jobId));
      expect(
        await start.run((tx) => capabilities(tx).claimAgentRun()),
      ).toMatchObject({ action: "start", agent_run_id: runId });
      const locked = await taskLock.run((tx) =>
        tx.query("select 1 from ops.tasks where id = $1 for update", [
          office.taskId,
        ]),
      );
      expect(locked.rows).toHaveLength(1);
      const startPid = await start.pid;
      const lockPid = await taskLock.pid;
      // The savepoint keeps the session readable once the start has failed.
      const writtenBefore = await start.run(opsRowsWritten);
      await start.run((tx) => tx.query("savepoint start_attempt"));

      const status = start.run((tx) => capabilities(tx).startAgentRun(START));
      await waitUntilBlocked(admin, startPid, status);
      const { rows: blockers } = await admin.query<{ pids: number[] }>(
        "select pg_blocking_pids($1) as pids",
        [startPid],
      );
      expect(blockers[0].pids).toEqual([lockPid]);
      await waitUntilLeaseEnded(jobId);
      await taskLock.end("commit");

      const refused = await rejectionOf(status);
      expect(refused).toMatchObject({ code: "42501" });
      expect((refused as Error).message).toMatch(
        /the lease on this job ran out while the start waited; nothing was started/,
      );
      await start.run((tx) => tx.query("rollback to savepoint start_attempt"));
      expect(
        await start.run(opsRowsWritten),
        "ops rows the start wrote before it refused",
      ).toBe(writtenBefore);
      await start.end("rollback");
    } finally {
      await taskLock.end("rollback");
      await start.end("rollback");
    }

    expect(await readRun(runId)).toMatchObject({
      status: "pending",
      job_attempt: null,
      provider: null,
      error_code: null,
    });
    const { rows: facts } = await admin.query<{ type: string }>(
      "select type from ops.events where subject_type = 'agent_run' and subject_id = $1 order by seq",
      [runId],
    );
    expect(facts.map((fact) => fact.type)).toEqual(["agent_run.requested"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The stale-run sweep skips what another transaction holds
// ---------------------------------------------------------------------------

/**
 * The sweep, run while the run row and then the job row is held by another
 * transaction, in the modes a capability holds them. It must settle neither.
 */
async function expectSweepSkipsWhileHeld(
  runId: string,
  jobId: string,
  status: string,
): Promise<void> {
  await whileRowLocked(
    admin,
    "select 1 from ops.agent_runs where id = $1 for update",
    [runId],
    async () => {
      expect(await sweep(), "while the run row is held").toBe(0);
    },
  );
  await whileRowLocked(
    admin,
    "select 1 from ops.jobs where id = $1 for share",
    [jobId],
    async () => {
      expect(await sweep(), "while the job row is held").toBe(0);
    },
  );
  expect((await readRun(runId)).status).toBe(status);
}

describe("the stale-run sweep beside a transaction holding a run or its job", () => {
  // What the SQL suite cannot prove: SKIP LOCKED needs a lock someone else
  // holds. A stale running run is passed over, not waited on and not settled,
  // while either its run or its job is held, and is settled once released.
  it("skips a running run with an ended lease while its run or its job is held, and settles it once released", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "stale-running");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(jobId);
    expect(await prepare(HOLDER, jobId)).toBe("running");
    await admin.query(
      "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = $1",
      [jobId],
    );

    await expectSweepSkipsWhileHeld(runId, jobId, "running");

    expect(await sweep()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "indeterminate",
      error_category: "interrupted",
    });
  }, 30_000);

  // What the SQL suite cannot prove: the sweep's second pass, for a pending
  // run whose job ended before anything started, skips held rows the same way.
  it("skips a pending run whose job already failed while its run or its job is held, and settles it once released", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "orphaned-pending");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(jobId);
    // The attempt ends before any start, as a handler's permanent error does.
    await worker.withTransaction(async (tx) => {
      await resume(tx, HOLDER, jobId);
      const { rows } = await tx.query<{ result: string }>(
        "select ops.settle_job_failure($1, 'permanent', 'dbtest: ended before start') as result",
        [jobId],
      );
      expect(rows[0].result).toBe("failed");
    });

    await expectSweepSkipsWhileHeld(runId, jobId, "pending");

    expect(await sweep()).toBe(1);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      error_category: "job_failed",
      error_code: "job_failed",
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The kill switch between concurrent transactions
// ---------------------------------------------------------------------------

describe("the kill switch between concurrent transactions", () => {
  // What the SQL suite cannot prove (N7 checks only the lock MODES): a trip
  // WAITING for a start that has already read the switch, and the next start
  // deciding on what that trip committed.
  it("makes a trip wait for a start in flight, and a start that begins after the trip refuses its run", async () => {
    const office = await buildOffice();
    const inFlight = await requestRun(office, "start-in-flight");
    const later = await requestRun(office, "start-after-trip");
    const inFlightJob = (await readRun(inFlight)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(inFlightJob);
    const start = openSession(worker);
    const trip = openSession(owner);
    try {
      await start.run((tx) => resume(tx, HOLDER, inFlightJob));
      await start.run((tx) => capabilities(tx).claimAgentRun());
      expect(
        await start.run((tx) => capabilities(tx).startAgentRun(START)),
      ).toBe("running");
      const tripPid = await trip.pid;
      const stopId = trip.run((tx) =>
        tripExecutionStop(tx, agentTarget(office), TRIP),
      );
      await waitUntilBlocked(admin, tripPid, stopId, "advisory");
      await start.end("commit");
      const tripped = await stopId;
      await trip.end("commit");

      // The start the trip waited for had passed the switch; a trip never recalls it.
      expect(await readRun(inFlight)).toMatchObject({
        status: "running",
        stop_id: null,
      });
      const laterJob = (await readRun(later)).job_id as string;
      expect(await leaseHead(OTHER)).toBe(laterJob);
      expect(await prepare(OTHER, laterJob)).toBe("cancelled");
      expect(await readRun(later)).toMatchObject({
        status: "cancelled",
        error_code: "execution_stopped",
        stop_id: tripped,
        provider: null,
      });
    } finally {
      await start.end("rollback");
      await trip.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: that the start reads the stops only AFTER
  // it holds the lock. A start that read first would wait just the same, and
  // then act on the switch as it was before the trip committed.
  it("makes a start wait for a trip in flight, and the start refuses its run once the trip commits", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "trip-in-flight");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(jobId);
    const trip = openSession(owner);
    const start = openSession(worker);
    try {
      const stopId = await trip.run((tx) =>
        tripExecutionStop(tx, agentTarget(office), TRIP),
      );
      await start.run((tx) => resume(tx, HOLDER, jobId));
      await start.run((tx) => capabilities(tx).claimAgentRun());
      const startPid = await start.pid;
      const status = start.run((tx) => capabilities(tx).startAgentRun(START));
      await waitUntilBlocked(admin, startPid, status, "advisory");
      await trip.end("commit");
      expect(await status).toBe("cancelled");
      await start.end("commit");

      expect(await readRun(runId)).toMatchObject({
        status: "cancelled",
        error_code: "execution_stopped",
        stop_id: stopId,
        provider: null,
        job_attempt: null,
      });
    } finally {
      await trip.end("rollback");
      await start.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: the request side of the same serialisation
  // — a trip waits for a request that has read the switch, and every request
  // after the trip is recorded as refused by it.
  it("makes a trip wait for a request in flight, and a request made after the trip is recorded as refused", async () => {
    const office = await buildOffice();
    const ctx = ownerContext(office.tenantId);
    const request = openSession(owner);
    const trip = openSession(owner);
    try {
      const inFlight = await request.run((tx) =>
        requestAgentRun(tx, ctx, runInput(office, "request-in-flight")),
      );
      const tripPid = await trip.pid;
      const stopId = trip.run((tx) =>
        tripExecutionStop(tx, agentTarget(office), TRIP),
      );
      await waitUntilBlocked(admin, tripPid, stopId, "advisory");
      await request.end("commit");
      const tripped = await stopId;
      await trip.end("commit");

      const admitted = await readRun(inFlight);
      expect(admitted).toMatchObject({ status: "pending", stop_id: null });
      expect(admitted.job_id).not.toBeNull();
      const later = await requestRun(office, "request-after-trip");
      expect(await readRun(later)).toMatchObject({
        status: "cancelled",
        error_code: "execution_stopped",
        stop_id: tripped,
        job_id: null,
      });
    } finally {
      await request.end("rollback");
      await trip.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: a request that waited for a trip reads
  // the switch after the trip committed, records the refusal naming that stop,
  // and creates no job.
  it("makes a request wait for a trip in flight, and records the request as refused by that stop once the trip commits", async () => {
    const office = await buildOffice();
    const trip = openSession(owner);
    const request = openSession(owner);
    try {
      const stopId = await trip.run((tx) =>
        tripExecutionStop(tx, agentTarget(office), TRIP),
      );
      const requestPid = await request.pid;
      const runId = request.run((tx) =>
        requestAgentRun(
          tx,
          ownerContext(office.tenantId),
          runInput(office, "request-behind-trip"),
        ),
      );
      await waitUntilBlocked(admin, requestPid, runId, "advisory");
      await trip.end("commit");
      const refused = await runId;
      await request.end("commit");

      expect(await readRun(refused)).toMatchObject({
        status: "cancelled",
        error_code: "execution_stopped",
        stop_id: stopId,
        job_id: null,
      });
      expect(await jobsIn([office.tenantId])).toBe(0);
    } finally {
      await trip.end("rollback");
      await request.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: that a trip takes the switch's lock BEFORE
  // it looks for an active stop on its target. A trip that looked first would
  // find the stop a concurrent clearing is about to clear, wait, then find no
  // active stop and refuse — the owner's trip lost to the clear.
  it("makes a trip wait for a clearing of the same target, and records a new active stop once the clearing commits", async () => {
    const office = await buildOffice();
    const target = agentTarget(office);
    const clearedStop = await owner.withTransaction((tx) =>
      tripExecutionStop(tx, target, TRIP),
    );
    const clearing = openSession(owner);
    const trip = openSession(owner);
    try {
      // A clearing between its lock and its update: the order
      // ops.clear_execution_stop takes them in, held open.
      await clearing.run((tx) =>
        tx.query("select pg_advisory_xact_lock(ops.execution_stop_lock_key())"),
      );
      const tripPid = await trip.pid;
      const stopId = trip.run((tx) => tripExecutionStop(tx, target, TRIP));
      await waitUntilBlocked(admin, tripPid, stopId, "advisory");
      expect(
        await clearing.run((tx) => clearExecutionStop(tx, clearedStop, CLEAR)),
      ).toBe(true);
      await clearing.end("commit");
      const tripped = await stopId;
      await trip.end("commit");

      expect(tripped).not.toBe(clearedStop);
      const { rows } = await admin.query<{ id: string }>(
        "select id from ops.execution_stops where tenant_id = $1 and cleared_at is null",
        [office.tenantId],
      );
      expect(rows).toEqual([{ id: tripped }]);
    } finally {
      await clearing.end("rollback");
      await trip.end("rollback");
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// AR-07: refusals about a held run never wait on it
// ---------------------------------------------------------------------------

describe("a request that names a run a worker holds", () => {
  // What the SQL suite cannot prove: that these refusals are decided on plain
  // reads. Only a second session holding the run shows that neither request
  // waits on it (a wait here fails as 55P03 under the lock timeout, and with
  // the request holding the task it would deadlock with the worker's start),
  // and that the worker then carries on.
  it("refuses a retry of it and a second job for it without waiting on the worker's lock, and the worker's start still proceeds", async () => {
    const office = await buildOffice();
    const ctx = ownerContext(office.tenantId);
    const runId = await requestRun(office, "held-by-worker");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(jobId);
    const step = openSession(worker);
    try {
      await step.run((tx) => resume(tx, HOLDER, jobId));
      await step.run((tx) => capabilities(tx).claimAgentRun());
      expect(await isRowLocked(admin, "ops.agent_runs", runId)).toBe(true);

      const retry = await rejectionOf(
        owner.withTransaction(async (tx) => {
          await tx.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
          return requestAgentRun(
            tx,
            ctx,
            runInput(office, "retry-of-held", { retryOfRunId: runId }),
          );
        }),
      );
      expect(retry).toBeInstanceOf(CompanyOsError);
      expect(retry).toMatchObject({ code: "invalid_state" });
      expect((retry as Error).message).toMatch(/only a finished run/);

      const secondJob = await rejectionOf(
        owner.withTransaction(async (tx) => {
          await tx.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
          return requestTaskExecution(tx, ctx, {
            taskId: office.taskId,
            kind: AGENT_RUN_EXECUTE_KIND,
            payload: { agent_run_id: runId },
            idempotencyKey: "second-job-for-held",
          });
        }),
      );
      expect(secondJob).toBeInstanceOf(CompanyOsError);
      expect(secondJob).toMatchObject({ code: "invalid_state" });
      expect((secondJob as Error).message).toMatch(/already has its job/);

      expect(
        await step.run((tx) => capabilities(tx).startAgentRun(START)),
      ).toBe("running");
      await step.end("commit");
    } finally {
      await step.end("rollback");
    }

    expect(await readRun(runId)).toMatchObject({
      status: "running",
      job_id: jobId,
    });
    expect(await runsIn([office.tenantId])).toBe(1);
    expect(await jobsIn([office.tenantId])).toBe(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The owner's stop CLI and the stop list
// ---------------------------------------------------------------------------

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runStopCli(
  args: readonly string[],
  connectionString: string = ADMIN_URL,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STOP_CLI, ...args], {
      env: { ...process.env, ADMIN_DATABASE_URL: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The tool's JSON lines; anything else on the stream (a Node warning) is ignored. */
const jsonLines = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The parts of a connection string that must never appear in the tool's output. */
function connectionPieces(connectionString: string): string[] {
  const url = new URL(connectionString);
  return [
    connectionString,
    "postgresql://",
    url.password,
    `${url.hostname}:${url.port}`,
  ].filter(Boolean);
}

describe("the owner's execution stop CLI, as a real process", () => {
  // What neither the SQL suite nor the CLI's unit tests can prove: the owner
  // tool as a separate PROCESS on its own connection against the real
  // functions, with a run requested through the domain between its commands,
  // and none of its output carrying the connection string it was given.
  it("trips a scoped stop, lists it, refuses a covered run, clears it, lists it as history, and never prints the connection string", async () => {
    const office = await buildOffice();
    const outputs: CliResult[] = [];
    const cli = async (args: readonly string[]) => {
      const result = await runStopCli(args);
      outputs.push(result);
      expect(result.code, `${args[0]}: ${result.stderr}`).toBe(0);
      return jsonLines(result.stdout);
    };

    const [tripped] = await cli([
      "trip",
      "--scope",
      "tenant",
      "--tenant",
      office.tenantId,
      "--reason",
      "dbtest cli drill",
      "--actor",
      "dbtest",
    ]);
    expect(tripped).toMatchObject({ result: "stopped" });
    const stopId = String(tripped.stopId);

    expect((await cli(["list"])).find((s) => s.id === stopId)).toMatchObject({
      scope: "tenant",
      tenantId: office.tenantId,
      reason: "dbtest cli drill",
      trippedBy: "dbtest",
      trippedAt: expect.stringMatching(ISO_UTC),
      clearedAt: null,
    });

    const refused = await requestRun(office, "cli-refused");
    expect(await readRun(refused)).toMatchObject({
      status: "cancelled",
      error_code: "execution_stopped",
      stop_id: stopId,
      job_id: null,
    });

    expect(
      await cli([
        "clear",
        "--id",
        stopId,
        "--reason",
        "dbtest cli drill over",
        "--actor",
        "dbtest",
      ]),
    ).toEqual([{ result: "cleared", stopId }]);

    expect((await cli(["list"])).map((s) => s.id)).not.toContain(stopId);
    expect(
      (await cli(["list", "--all"])).find((s) => s.id === stopId),
    ).toMatchObject({
      clearedBy: "dbtest",
      clearedReason: "dbtest cli drill over",
      clearedAt: expect.stringMatching(ISO_UTC),
    });

    const allowed = await readRun(await requestRun(office, "cli-allowed"));
    expect(allowed).toMatchObject({ status: "pending", stop_id: null });
    expect(allowed.job_id).not.toBeNull();

    expect(outputs).toHaveLength(5);
    for (const { stdout, stderr } of outputs) {
      for (const piece of connectionPieces(ADMIN_URL)) {
        expect(stdout).not.toContain(piece);
        expect(stderr).not.toContain(piece);
      }
    }
  }, 60_000);

  // What the CLI's unit tests cannot prove: the REAL server's refusal of a
  // connection, whose message names the user, reported by its SQLSTATE alone.
  it("reports a connection the database refuses by its SQLSTATE alone, naming no part of the connection string", async () => {
    const url = new URL(ADMIN_URL);
    url.password = "dbtest-not-the-password";

    const result = await runStopCli(["list"], url.toString());

    expect(result.code).toBe(1);
    expect(jsonLines(result.stdout)).toEqual([]);
    expect(jsonLines(result.stderr)).toEqual([
      { error: "28P01", message: expect.any(String) },
    ]);
    for (const piece of [...connectionPieces(url.toString()), url.username]) {
      expect(result.stderr).not.toContain(piece);
    }
  }, 30_000);
});

describe("listing execution stops", () => {
  // What the domain's unit tests cannot prove: the list's filter against real
  // rows. They see only the parameters it sends, not which rows those select.
  it("lists only active stops by default, and every stop newest first with includeCleared", async () => {
    const office = await buildOffice();
    const tenantStop = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: office.tenantId },
        TRIP,
      ),
    );
    const companyStop = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        {
          scope: "company",
          tenantId: office.tenantId,
          companyId: office.companyId,
        },
        TRIP,
      ),
    );
    expect(
      await owner.withTransaction((tx) =>
        clearExecutionStop(tx, tenantStop, CLEAR),
      ),
    ).toBe(true);

    const active = await owner.withTransaction((tx) => listExecutionStops(tx));
    const all = await owner.withTransaction((tx) =>
      listExecutionStops(tx, { includeCleared: true }),
    );

    const ours = (rows: readonly { id: string }[]) =>
      rows
        .map((row) => row.id)
        .filter((id) => id === tenantStop || id === companyStop);
    expect(ours(active)).toEqual([companyStop]);
    expect(active.every((row) => row.clearedAt === null)).toBe(true);
    expect(ours(all)).toEqual([companyStop, tenantStop]);
    expect(all.find((row) => row.id === tenantStop)).toMatchObject({
      clearedBy: "dbtest",
      clearedReason: CLEAR.reason,
      clearedAt: expect.stringMatching(ISO_UTC),
    });
  });
});
