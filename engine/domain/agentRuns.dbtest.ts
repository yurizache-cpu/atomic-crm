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
//   * a start whose lease ran out while it waited on a lock (the task's, or a
//     spend lock after its claim) refuses before it writes anything, even when
//     every gate still admits the run;
//   * a trip and a start (or a request, or a clear) are serialised: each waits
//     for the other, and decides on what the other committed; a job not yet
//     leased when a trip commits stays queued.
//
// The sweep beside held rows and requests about a held run are in
// agentRunHeldRuns.dbtest.ts; the owner's stop CLI is in
// executionStopCli.dbtest.ts. Every wait is read from pg_stat_activity while the
// waiting call is still unsettled; a call that never waited fails its case. It
// lives in engine/domain because only there may a test import the domain
// services, the worker capabilities and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  enqueue,
  readJob,
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  isRowLocked,
  openSession,
  waitUntilBlocked,
  type TransactionSession,
} from "../worker/testSupport/transactionSession.ts";
import { requestAgentRun, type RequestAgentRunInput } from "./agentRuns.ts";
import { CompanyOsError } from "./errors.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import { formatMicrosAsUsd } from "./money.ts";
import { setSpendLimit } from "./spendLimits.ts";
import {
  agentRunProbes,
  agentTarget,
  capabilities,
  CLEAR,
  closeAgentRunDatabases,
  COMPLETION,
  createAssignedTask,
  HOLDER,
  openAgentRunDatabases,
  opsRowsWritten,
  OTHER,
  ownerContext,
  rejectionOf,
  resume,
  runInput,
  SHORT_LEASE_SECONDS,
  START,
  TRIP,
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
  countRows,
  jobsIn,
  leaseAsOther,
  leaseHead,
  prepare,
  readRun,
  reap,
  requestRun,
  runsIn,
  sweep,
  waitUntilLeaseEnded,
} = agentRunProbes(() => ({ admin, owner, worker }));

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
  //
  // The start's transaction holds no claim here. A claim share-locks the task
  // for the rest of its transaction (ADR 0017 §2), so after one no owner can
  // take that row; but the capability does not require a claim first, and the
  // start's own task lock is what this case makes it wait on. The wait that the
  // runtime's claim-then-start order still meets is the next case.
  it("refuses a start whose lease ran out while it waited on the task lock, and leaves the run pending", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "start-behind-task-lock");
    const jobId = (await readRun(runId)).job_id as string;
    expect(await leaseHead(HOLDER, SHORT_LEASE_SECONDS)).toBe(jobId);
    const start = openSession(worker);
    const taskLock = openSession(owner);
    try {
      await start.run((tx) => resume(tx, HOLDER, jobId));
      const locked = await taskLock.run((tx) =>
        tx.query("select 1 from ops.tasks where id = $1 for update", [
          office.taskId,
        ]),
      );
      expect(locked.rows).toHaveLength(1);
      await expectStartRefusedAfterWait(start, jobId, {
        holderPid: await taskLock.pid,
        release: () => taskLock.end("commit"),
      });
    } finally {
      await taskLock.end("rollback");
      await start.end("rollback");
    }

    await expectRunUntouched(runId);
  }, 30_000);

  // What the SQL suite cannot prove: the same second look at the clock in the
  // runtime's own order. After its claim the start cannot meet the task lock,
  // but it still waits on the spend locks, the last locks it takes (ADR 0017
  // §4). Here an owner's limit act holds the global one: setting the value
  // already in force records nothing, and still holds the lock until it commits.
  it("refuses a start whose lease ran out while it waited on a spend lock after its claim, and leaves the run pending", async () => {
    const office = await buildOffice();
    const runId = await requestRun(office, "start-behind-spend-lock");
    const jobId = (await readRun(runId)).job_id as string;
    const ceiling = await activeGlobalLimit();
    expect(await leaseHead(HOLDER, SHORT_LEASE_SECONDS)).toBe(jobId);
    const start = openSession(worker);
    const limitAct = openSession(owner);
    try {
      await start.run((tx) => resume(tx, HOLDER, jobId));
      expect(
        await start.run((tx) => capabilities(tx).claimAgentRun()),
      ).toMatchObject({ action: "start", agent_run_id: runId });
      const inForce = await limitAct.run((tx) =>
        setSpendLimit(
          tx,
          { scope: "global" },
          { dailyUsd: ceiling.dailyUsd, timezone: "UTC" },
          { reason: "dbtest ceiling unchanged", actor: "dbtest" },
        ),
      );
      expect(inForce).toBe(ceiling.id);
      await expectStartRefusedAfterWait(start, jobId, {
        holderPid: await limitAct.pid,
        release: () => limitAct.end("commit"),
        waitEvent: "advisory",
      });
    } finally {
      await limitAct.end("rollback");
      await start.end("rollback");
    }

    await expectRunUntouched(runId);
    expect(await activeGlobalLimit()).toEqual(ceiling);
  }, 30_000);
});

interface HeldLock {
  /** The backend that holds the lock the start must wait on. */
  readonly holderPid: number;
  /** Ends the holder's transaction. */
  readonly release: () => Promise<void>;
  /** The wait event the start must be seen on, when it matters. */
  readonly waitEvent?: string;
}

/**
 * Runs the start in `start`, proves it waits on `held`, lets the lease run out,
 * releases the holder, and proves the start then refused on the clock without
 * leaving a written row. The savepoint keeps the session readable once the
 * start has failed.
 */
async function expectStartRefusedAfterWait(
  start: TransactionSession,
  jobId: string,
  held: HeldLock,
): Promise<void> {
  const startPid = await start.pid;
  const writtenBefore = await start.run(opsRowsWritten);
  await start.run((tx) => tx.query("savepoint start_attempt"));

  const status = start.run((tx) => capabilities(tx).startAgentRun(START));
  await waitUntilBlocked(admin, startPid, status, held.waitEvent);
  expect(await blockingPids(startPid)).toEqual([held.holderPid]);
  await waitUntilLeaseEnded(jobId);
  await held.release();

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
}

/** The run is exactly as its request left it: pending, unpriced, with one fact. */
async function expectRunUntouched(runId: string): Promise<void> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `select status, job_attempt, provider, error_code, price_id,
            reserved_cost_micros, charged_cost_micros
       from ops.agent_runs where id = $1`,
    [runId],
  );
  expect(rows[0]).toEqual({
    status: "pending",
    job_attempt: null,
    provider: null,
    error_code: null,
    price_id: null,
    reserved_cost_micros: null,
    charged_cost_micros: null,
  });
  const { rows: facts } = await admin.query<{ type: string }>(
    "select type from ops.events where subject_type = 'agent_run' and subject_id = $1 order by seq",
    [runId],
  );
  expect(facts.map((fact) => fact.type)).toEqual(["agent_run.requested"]);
}

/** The global ceiling in force: its id, and its daily amount in USD. */
async function activeGlobalLimit(): Promise<{ id: string; dailyUsd: string }> {
  const { rows } = await admin.query<{ id: string; micros: string }>(
    `select id, daily_limit_micros::text as micros
       from ops.spend_limits
      where scope = 'global' and ended_at is null`,
  );
  if (rows.length !== 1) {
    throw new Error(
      "no global ceiling is in force; the case would prove nothing",
    );
  }
  return { id: rows[0].id, dailyUsd: formatMicrosAsUsd(rows[0].micros) };
}

// ---------------------------------------------------------------------------
// The kill switch between concurrent transactions
// ---------------------------------------------------------------------------

describe("the kill switch between concurrent transactions", () => {
  // What the SQL suite cannot prove (N7 checks only the lock MODES): a trip
  // WAITING for a start that has already read the switch, and the next start
  // deciding on what that trip committed. That next start's job was leased
  // before the trip, so its start holds the run and writes nothing (owner
  // decision B; the runtime would then defer the job). A job not yet leased
  // when the trip commits is never leased while the stop is active (ADR 0017
  // §6), and stays queued with its attempts untouched.
  it("makes a trip wait for a start in flight, a start that begins after the trip holds its run, and a job not yet leased stays queued", async () => {
    const office = await buildOffice();
    const inFlight = await requestRun(office, "start-in-flight");
    const later = await requestRun(office, "start-after-trip");
    const notLeased = await requestRun(office, "leased-after-trip");
    const inFlightJob = (await readRun(inFlight)).job_id as string;
    const laterJob = (await readRun(later)).job_id as string;
    const notLeasedJob = (await readRun(notLeased)).job_id as string;
    expect(await leaseHead(HOLDER)).toBe(inFlightJob);
    expect(await leaseHead(OTHER)).toBe(laterJob);
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
      expect(tripped).toMatch(/^[0-9a-f-]{36}$/);
      expect(await prepare(OTHER, laterJob)).toBe("stopped");
      expect(await readRun(later)).toMatchObject({
        status: "pending",
        error_code: null,
        stop_id: null,
        provider: null,
      });

      expect(await leaseHead(OTHER)).toBeNull();
      expect(await readJob(admin, notLeasedJob)).toMatchObject({
        status: "queued",
        attempts: 0,
        lease_owner: null,
      });
      expect(await readRun(notLeased)).toMatchObject({
        status: "pending",
        stop_id: null,
      });
    } finally {
      await start.end("rollback");
      await trip.end("rollback");
    }
  }, 30_000);

  // What the SQL suite cannot prove: that the start reads the stops only AFTER
  // it holds the lock. A start that read first would wait just the same, and
  // then act on the switch as it was before the trip committed. Once the trip
  // commits, the start holds the run (owner decision B), and the deferral in
  // the same transaction, under the lock the start still holds, finds the stop.
  it("makes a start wait for a trip in flight, and the start holds its run once the trip commits, deferring its job under that stop", async () => {
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
      expect(await status).toBe("stopped");
      const deferred = await start.run(async (tx) => {
        const { rows } = await tx.query<{ stop_id: string | null }>(
          "select ops.defer_job() as stop_id",
        );
        return rows[0]?.stop_id ?? null;
      });
      expect(deferred).toBe(stopId);
      await start.end("commit");

      expect(await readRun(runId)).toMatchObject({
        status: "pending",
        error_code: null,
        stop_id: null,
        provider: null,
        job_attempt: null,
      });
      expect(await readJob(admin, jobId)).toMatchObject({
        status: "queued",
        attempts: 0,
        lease_owner: null,
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
