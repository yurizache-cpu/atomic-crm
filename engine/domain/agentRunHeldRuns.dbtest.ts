// Agent run rows another transaction holds, against a real Postgres through
// the real `pg` driver — with TWO sessions at once.
//
// supabase/tests/agent_runtime.sql runs on ONE connection, so nothing it runs
// is ever held by anyone else. This file proves what only a second session
// holding a run, or its job, can show:
//
//   * the stale-run sweep passes over a run, or a job, that another
//     transaction holds (SKIP LOCKED), and settles it once released;
//   * a request naming a run a worker holds refuses on plain reads of that run,
//     never waiting on its lock, and the worker's settlement still commits;
//   * in the prepare window, where the claim share-locks the task (ADR 0017
//     §2), the same requests wait on the worker alone, the worker's start still
//     proceeds, and both requests refuse on what it committed.
//
// Every wait is read from pg_stat_activity while the waiting call is still
// unsettled; a call that must not wait runs under a lock timeout. It lives in
// engine/domain because only there may a test import the domain services, the
// worker capabilities and the database fixture together (eslint.config.js).
// All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import { resetFixtures } from "../worker/testSupport/dbFixture.ts";
import {
  isRowLocked,
  openSession,
  waitUntilBlocked,
  whileRowLocked,
} from "../worker/testSupport/transactionSession.ts";
import { requestAgentRun } from "./agentRuns.ts";
import { requestTaskExecution } from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import {
  agentRunProbes,
  capabilities,
  closeAgentRunDatabases,
  COMPLETION,
  HOLDER,
  LOCK_TIMEOUT,
  openAgentRunDatabases,
  ownerContext,
  rejectionOf,
  resume,
  runInput,
  START,
  type Office,
} from "./testSupport/agentRunSessions.ts";

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, worker } = openAgentRunDatabases());
}, 60_000);

afterAll(() => closeAgentRunDatabases({ admin, owner, worker }));

beforeEach(async () => {
  await resetFixtures(admin);
});

const {
  blockingPids,
  buildOffice,
  jobsIn,
  leaseHead,
  prepare,
  readRun,
  requestRun,
  runsIn,
  sweep,
} = agentRunProbes(() => ({ admin, owner, worker }));

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
// AR-07: refusals about a held run never wait on the run
// ---------------------------------------------------------------------------

/** A retry of `runId`, as a request its owner may make. */
const retryOf = (tx: TxClient, office: Office, runId: string) =>
  requestAgentRun(
    tx,
    ownerContext(office.tenantId),
    runInput(office, `retry-of-${runId}`, { retryOfRunId: runId }),
  );

/** A second agent_run.execute job for `runId`, as a request its owner may make. */
const secondJobFor = (tx: TxClient, office: Office, runId: string) =>
  requestTaskExecution(tx, ownerContext(office.tenantId), {
    taskId: office.taskId,
    kind: AGENT_RUN_EXECUTE_KIND,
    payload: { agent_run_id: runId },
    idempotencyKey: `second-job-for-${runId}`,
  });

/** `request` in its own owner transaction, bounded so that waiting is an error. */
function withoutWaiting<T>(request: (tx: TxClient) => Promise<T>): Promise<T> {
  return owner.withTransaction(async (tx) => {
    await tx.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    return request(tx);
  });
}

function expectRetryAndSecondJobRefused(
  retry: unknown,
  secondJob: unknown,
): void {
  expect(retry).toBeInstanceOf(CompanyOsError);
  expect(retry).toMatchObject({ code: "invalid_state" });
  expect((retry as Error).message).toMatch(/only a finished run/);
  expect(secondJob).toBeInstanceOf(CompanyOsError);
  expect(secondJob).toMatchObject({ code: "invalid_state" });
  expect((secondJob as Error).message).toMatch(/already has its job/);
}

describe("a request that names a run a worker holds", () => {
  // What the SQL suite cannot prove: that these refusals are decided on plain
  // reads of the run. Only a second session holding the run shows that neither
  // request waits on it (a wait here fails as 55P03 under the lock timeout),
  // and that the worker then carries on. The settle transaction holds the run
  // and the job, and nothing of the task, so the requests meet only the run.
  it("refuses a retry of it and a second job for it while its settlement is open, without waiting on the worker's run lock, and the settlement still commits", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "held-by-worker");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(jobId);
    expect(await prepare(HOLDER, jobId)).toBe("running");
    const settle = openSession(worker);
    try {
      await settle.run((tx) => resume(tx, HOLDER, jobId));
      expect(
        await settle.run((tx) => capabilities(tx).completeAgentRun(COMPLETION)),
      ).toBe("succeeded");
      expect(await isRowLocked(admin, "ops.agent_runs", runId)).toBe(true);
      expect(await isRowLocked(admin, "ops.tasks", office.taskId)).toBe(false);

      expectRetryAndSecondJobRefused(
        await rejectionOf(withoutWaiting((tx) => retryOf(tx, office, runId))),
        await rejectionOf(
          withoutWaiting((tx) => secondJobFor(tx, office, runId)),
        ),
      );
      await settle.end("commit");
    } finally {
      await settle.end("rollback");
    }

    expect(await readRun(runId)).toMatchObject({
      status: "succeeded",
      job_id: jobId,
    });
    expect(await runsIn([office.tenantId])).toBe(1);
    expect(await jobsIn([office.tenantId])).toBe(1);
  }, 30_000);

  // What the SQL suite cannot prove: the prepare window. A claim share-locks
  // the run's task for the rest of its transaction (ADR 0017 §2), and both
  // requests lock that task first, so there they WAIT, on the worker alone,
  // holding nothing the worker needs: the worker's start still proceeds while
  // they wait, and once it commits both refuse on what it committed.
  it("makes a retry of it and a second job for it wait on the task lock its claim holds, lets the worker's start proceed, and refuses both once the start commits", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "claimed-by-worker");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(jobId);
    const step = openSession(worker);
    const retrySession = openSession(owner);
    const jobSession = openSession(owner);
    try {
      await step.run((tx) => resume(tx, HOLDER, jobId));
      await step.run((tx) => capabilities(tx).claimAgentRun());
      expect(await isRowLocked(admin, "ops.agent_runs", runId)).toBe(true);
      expect(await isRowLocked(admin, "ops.tasks", office.taskId)).toBe(true);
      const stepPid = await step.pid;

      const retry = rejectionOf(
        retrySession.run((tx) => retryOf(tx, office, runId)),
      );
      const retryPid = await retrySession.pid;
      await waitUntilBlocked(admin, retryPid, retry);
      expect(await blockingPids(retryPid)).toEqual([stepPid]);

      const secondJob = rejectionOf(
        jobSession.run((tx) => secondJobFor(tx, office, runId)),
      );
      await waitUntilBlocked(admin, await jobSession.pid, secondJob);

      expect(
        await step.run((tx) => capabilities(tx).startAgentRun(START)),
      ).toBe("running");
      await step.end("commit");

      // A refused request keeps its task lock until its transaction ends, and
      // the second request queued behind it.
      const retried = await retry;
      await retrySession.end("rollback");
      const secondRefused = await secondJob;
      await jobSession.end("rollback");
      expectRetryAndSecondJobRefused(retried, secondRefused);
    } finally {
      await step.end("rollback");
      await retrySession.end("rollback");
      await jobSession.end("rollback");
    }

    expect(await readRun(runId)).toMatchObject({
      status: "running",
      job_id: jobId,
    });
    expect(await runsIn([office.tenantId])).toBe(1);
    expect(await jobsIn([office.tenantId])).toBe(1);
  }, 30_000);
});
