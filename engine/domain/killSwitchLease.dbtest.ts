// The kill switch at the LEASE (ADR 0017 §6), against a real Postgres through
// the real `pg` driver, the real worker runtime and the real agent run handler,
// with a scripted model provider standing in for the vendor.
//
// supabase/tests/runtime_governance.sql (K3) offers one job at a time to
// ops.lease_job inside one rolled-back transaction. What it cannot see:
//
//   * that runOneJob, on a real committed queue, answers `idle` for a run whose
//     job a stop tripped AFTER the request covers, for every scope, and that the
//     job keeps its attempts and its available_at and gains no job event;
//   * that the same job, once the stop is cleared, is leased by the next pass and
//     makes exactly one provider call;
//   * that a stop on a neighbour (another tenant, company, department or agent,
//     or the kind in another tenant) holds nothing of this run's;
//   * that the internal postmark retention job is still leased and run under a
//     global stop, beside an agent run the same stop holds;
//   * deny wins: with two covering stops, clearing one still holds the job;
//   * a lease that meets a trip in flight waits for it, and then leases nothing
//     the committed stop covers.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import { POSTMARK_LEDGER_RETENTION_KIND } from "../handlers/postmarkLedgerRetention.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  clearLedger,
  countLedger,
  enqueue,
  resetFixtures,
  seedLedger,
  TENANT_A,
} from "../worker/testSupport/dbFixture.ts";
import { jobEvents, readJobLease } from "../worker/testSupport/jobLedger.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import {
  clearExecutionStop,
  tripExecutionStop,
  type ExecutionStopTarget,
} from "./executionStops.ts";
import {
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  VALID,
} from "./testSupport/agentRuntimeProbes.ts";
import { CLEAR, TRIP } from "./testSupport/agentRunSessions.ts";
import {
  buildStopOffice,
  COVERING_STOPS,
  NEIGHBOUR_STOPS,
  requestStopRun,
  type StopOffice,
} from "./testSupport/stopOffices.ts";

const WORKER = "dbtest-kill-switch-lease";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

beforeEach(async () => {
  await resetFixtures(admin);
  await clearLedger(admin);
});

const trip = (target: ExecutionStopTarget) =>
  owner.withTransaction((tx) => tripExecutionStop(tx, target, TRIP));

const clear = (stopId: string) =>
  owner.withTransaction((tx) => clearExecutionStop(tx, stopId, CLEAR));

async function readRun(runId: string) {
  const { rows } = await admin.query<{
    status: string;
    job_id: string | null;
    job_attempt: number | null;
    started_at: Date | null;
    stop_id: string | null;
  }>(
    "select status, job_id, job_attempt, started_at, stop_id from ops.agent_runs where id = $1",
    [runId],
  );
  if (!rows[0]) throw new Error("the agent run under test does not exist");
  return rows[0];
}

async function stopIsActive(stopId: string): Promise<boolean> {
  const { rows } = await admin.query<{ active: boolean }>(
    "select cleared_at is null as active from ops.execution_stops where id = $1",
    [stopId],
  );
  return rows[0]?.active === true;
}

/** A pending run on a fresh office, its job queued and never leased. */
async function queuedRun(key: string): Promise<{
  office: StopOffice;
  runId: string;
  jobId: string;
}> {
  const office = await buildStopOffice(owner, TENANT_A);
  const runId = await requestStopRun(owner, office, key);
  const run = await readRun(runId);
  expect(run).toMatchObject({ status: "pending", stop_id: null });
  const jobId = run.job_id as string;
  expect(jobId).toEqual(expect.any(String));
  return { office, runId, jobId };
}

/** Asserts the job is exactly as its request left it: queued, unleased, no attempt, one event. */
async function expectUntouched(jobId: string, availableAt: string) {
  expect(await readJobLease(admin, jobId)).toMatchObject({
    status: "queued",
    attempts: 0,
    leaseOwner: null,
    leasedAt: null,
    leaseExpiresAt: null,
    availableAt,
  });
  expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
    "enqueued",
  ]);
}

describe("a queued agent run under a stop tripped after its request", () => {
  // What the SQL suite cannot prove: the real runtime's pass over a committed
  // queue, for every scope, and the same job released by the clear.
  for (const { name, key, target } of COVERING_STOPS) {
    it(`is held at the lease under a ${name} stop with no attempt spent and no job event, and runs with exactly one provider call once the stop is cleared`, async () => {
      const { office, runId, jobId } = await queuedRun(`lease-hold-${key}`);
      const { availableAt } = await readJobLease(admin, jobId);
      const { provider, registry } = fakeRuntime({
        type: "respond",
        content: VALID,
      });
      const stopId = await trip(target(office));

      const held = await runOneJob(db, { workerId: WORKER, registry });

      expect(held).toEqual({ outcome: "idle" });
      await expectUntouched(jobId, availableAt);
      expect(await readRun(runId)).toMatchObject({
        status: "pending",
        job_attempt: null,
        started_at: null,
        stop_id: null,
      });
      expect(provider.calls).toHaveLength(0);

      await clear(stopId);
      const released = await runOneJob(db, { workerId: WORKER, registry });

      expect(released).toMatchObject({
        outcome: "succeeded",
        jobId,
        kind: AGENT_RUN_EXECUTE_KIND,
        attempt: 1,
        detail: expect.stringContaining(`agent_run=${runId} status=succeeded`),
      });
      expect(provider.calls).toHaveLength(1);
      expect(await readRun(runId)).toMatchObject({
        status: "succeeded",
        job_attempt: 1,
        stop_id: null,
      });
      expect(await readJobLease(admin, jobId)).toMatchObject({
        status: "succeeded",
        attempts: 1,
      });
      expect((await jobEvents(admin, jobId)).map((e) => e.event)).toEqual([
        "enqueued",
        "leased",
        "succeeded",
      ]);
    }, 30_000);
  }

  // What the SQL suite cannot prove: that the coverage predicate the lease uses
  // on the real queue is exact for a run, which knows all its coordinates.
  for (const { name, key, target } of NEIGHBOUR_STOPS) {
    it(`is not held by a ${name}, which covers other work only, and runs with one provider call while that stop stays active`, async () => {
      const { office, runId, jobId } = await queuedRun(`lease-free-${key}`);
      const { provider, registry } = fakeRuntime({
        type: "respond",
        content: VALID,
      });
      const stopId = await trip(target(office));

      const result = await runOneJob(db, { workerId: WORKER, registry });

      expect(result).toMatchObject({
        outcome: "succeeded",
        jobId,
        attempt: 1,
      });
      expect(provider.calls).toHaveLength(1);
      expect(await readRun(runId)).toMatchObject({
        status: "succeeded",
        stop_id: null,
      });
      expect(await stopIsActive(stopId)).toBe(true);
    }, 30_000);
  }

  // What the SQL suite cannot prove: deny wins on the real queue. Two stops
  // cover the job; clearing either one alone releases nothing.
  it("stays held while any covering stop is active: clearing the tenant stop leaves the all-tenant kind stop holding it, and clearing both releases it", async () => {
    const { office, runId, jobId } = await queuedRun("lease-deny-wins");
    const { availableAt } = await readJobLease(admin, jobId);
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const tenantStop = await trip({
      scope: "tenant",
      tenantId: office.tenantId,
    });
    const kindStop = await trip({
      scope: "job_kind",
      jobKind: AGENT_RUN_EXECUTE_KIND,
    });

    await clear(tenantStop);
    const stillHeld = await runOneJob(db, { workerId: WORKER, registry });

    expect(stillHeld).toEqual({ outcome: "idle" });
    await expectUntouched(jobId, availableAt);

    await clear(kindStop);
    const released = await runOneJob(db, { workerId: WORKER, registry });

    expect(released).toMatchObject({ outcome: "succeeded", jobId });
    expect(provider.calls).toHaveLength(1);
    expect((await readRun(runId)).status).toBe("succeeded");
  }, 30_000);
});

describe("a lease that meets a trip in flight", () => {
  // What the SQL suite cannot prove (W1 sees only that the lease HOLDS the
  // kill-switch lock): the ORDER. A lease that read the stops without waiting,
  // or read them in the statement that waited, would decide on the switch as it
  // was before the trip committed, and lease the job the trip covers.
  it("waits for the trip to commit, then leases nothing the stop covers, and the job keeps its attempts and gains no event", async () => {
    const { office, runId, jobId } = await queuedRun("lease-behind-trip");
    const { availableAt } = await readJobLease(admin, jobId);
    const tripping = openSession(owner);
    const leasing = openSession(db);
    let stopId: string | undefined;
    try {
      stopId = await tripping.run((tx) =>
        tripExecutionStop(
          tx,
          { scope: "tenant", tenantId: office.tenantId },
          TRIP,
        ),
      );
      const leasePid = await leasing.pid;
      const leased = leasing.run(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ id: string | null }>(
          "select id from ops.lease_job($1, 60)",
          [WORKER],
        );
        return rows[0]?.id ?? null;
      });
      await waitUntilBlocked(admin, leasePid, leased, "advisory");
      const { rows } = await admin.query<{ pids: number[] }>(
        "select pg_blocking_pids($1) as pids",
        [leasePid],
      );
      expect(rows[0].pids).toEqual([await tripping.pid]);

      await tripping.end("commit");
      expect(await leased).toBeNull();
      await leasing.end("commit");
    } finally {
      await tripping.end("rollback");
      await leasing.end("rollback");
    }
    if (stopId === undefined) throw new Error("the trip never answered");

    await expectUntouched(jobId, availableAt);
    expect(await readRun(runId)).toMatchObject({
      status: "pending",
      job_attempt: null,
      stop_id: null,
    });
    await clear(stopId);
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const released = await runOneJob(db, { workerId: WORKER, registry });
    expect(released).toMatchObject({
      outcome: "succeeded",
      jobId,
      attempt: 1,
    });
    expect(provider.calls).toHaveLength(1);
  }, 30_000);
});

describe("an internal job under a global stop", () => {
  // What the SQL suite cannot prove: administration stays up through the real
  // runtime. The same pass that holds the agent run leases the maintenance job
  // beside it and really purges the ledger.
  it("is still leased and run: the postmark ledger retention job purges under a global stop while the agent run queued beside it stays held", async () => {
    const { runId, jobId } = await queuedRun("lease-maintenance");
    const { availableAt } = await readJobLease(admin, jobId);
    await seedLedger(admin, [
      { ageDays: 200, status: "ingested", messageId: "dbtest-stop-old" },
      { ageDays: 10, status: "ingested", messageId: "dbtest-stop-new" },
    ]);
    const retentionJob = await enqueue(
      admin,
      TENANT_A,
      POSTMARK_LEDGER_RETENTION_KIND,
    );
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: VALID,
    });
    const globalStop = await trip({ scope: "global" });

    const first = await runOneJob(db, { workerId: WORKER, registry });
    const second = await runOneJob(db, { workerId: WORKER, registry });

    expect(first).toMatchObject({
      outcome: "succeeded",
      jobId: retentionJob,
      kind: POSTMARK_LEDGER_RETENTION_KIND,
      detail: expect.stringMatching(/^purged=[1-9]\d* /),
    });
    expect(second).toEqual({ outcome: "idle" });
    expect(await countLedger(admin)).toBe(1);
    await expectUntouched(jobId, availableAt);
    expect((await readRun(runId)).status).toBe("pending");
    expect(provider.calls).toHaveLength(0);

    await clear(globalStop);
    const released = await runOneJob(db, { workerId: WORKER, registry });

    expect(released).toMatchObject({ outcome: "succeeded", jobId });
    expect(provider.calls).toHaveLength(1);
  }, 30_000);
});
