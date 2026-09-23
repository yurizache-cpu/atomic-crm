// The kill-switch lock under the Phase 2C trip bound (owner decision S0-B,
// brief §7.3 "Bounded trip", §14 item 9, §16 "Stops"), against a real Postgres
// through the real `pg` driver, with a second session holding the lock.
//
// The browser trip (company_os_api.trip_stop, its gate and
// ops.trip_stop_in_tenant) does not exist before S7 and S8, and nothing here
// creates it. What the gate will do is fixed: set `lock_timeout = '2s'` and
// call the AUTHORITATIVE ops.trip_execution_stop, with no lock-free pre-check,
// the outcome read exactly as the CLI reads it (tripExecutionStopWithOutcome).
// So this file drives that path now, bound by a transaction-local lock_timeout
// of the pinned value, and proves:
//
//   * with the lock held exclusively (an open trip, in this tenant or another)
//     or shared (as a lease or start holds it), the trip fails with 55P03 after
//     about two seconds, with the same code, message, detail, hint and context
//     whatever holds the lock, and creates nothing;
//   * once the holder ends, the same trip records exactly one stop;
//   * while a trip waits behind a shared holder, another tenant's lease queues
//     behind it for at most about the bound, then leases (head of line);
//   * deny wins: a trip racing a CLI clear of the same target waits for it
//     although the stop is still visibly active, then reports `stopped` with a
//     new stop when the clear commits and the existing stop as
//     `already_stopped` when it rolls back.
//
// Timings are bounded, never exact: a slower machine adds latency, never
// removes the wait. It lives in engine/domain because only there may a test
// import the domain services and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.
//
// A SHARED STACK. Other suites run on the same database, and two of the locks
// this file measures are theirs too:
//
//   * The member's trip targets tenant B, which the fixture never makes the
//     owner of the local CRM. trip_execution_stop first takes FOR SHARE on
//     its tenant's row, and every suite that moves owns_local_crm
//     (company_os_api.sql, whatsapp_transport.sql, the Data API probe) holds
//     FOR NO KEY UPDATE on the row of the tenant that owned the flag for the
//     rest of its transaction: after resetFixtures that is tenant A. A trip
//     of tenant A then timed out on that row lock instead of the kill-switch
//     lock, with another context, and the refusals were not identical (the
//     measured cause of this file's intermittent failure on a shared stack).
//   * Every agent-run request holds the kill-switch lock shared until its
//     transaction ends, and the SQL suites request runs inside transactions
//     of several seconds. The trip that must succeed once this file's holder
//     is gone is therefore retried while such a session holds the lock: each
//     attempt keeps the 2 s bound and must be refused with 55P03 having
//     recorded nothing, and exactly one stop is recorded in the end.
//   * The job queue is shared as well (jobLeasingConcurrency.mjs leases any
//     queued job), so the head-of-line case measures the lease's wait until
//     the database grants it the kill-switch lock, not whether a job was
//     still queued for it to take.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import {
  clearExecutionStop,
  tripExecutionStop,
  tripExecutionStopWithOutcome,
  type ExecutionStopAct,
  type ExecutionStopTarget,
  type ExecutionStopTripOutcome,
} from "./executionStops.ts";
import {
  agentRunProbes,
  CLEAR,
  closeAgentRunDatabases,
  openAgentRunDatabases,
  OTHER,
  rejectionOf,
  TRIP,
} from "./testSupport/agentRunSessions.ts";

/** The browser trip gate's pinned lock_timeout (S0-B). */
const STOP_LOCK_TIMEOUT = "2s";
const BOUND_MS = 2_000;
/** What a slow machine may add around the bound; it never shortens the wait. */
const SLACK_MS = 3_000;
/** How long another suite may keep the kill-switch lock before a retried trip gives up. */
const OTHER_SUITES_MS = 60_000;

/** The act a member's trip would record; the gate derives both in S8. */
const MEMBER_TRIP: ExecutionStopAct = Object.freeze({
  reason: "dbtest bounded trip from the operator surface",
  actor: "dbtest-cos-member",
});
/** What the second session trips while it holds the lock, then rolls back. */
const HOLD: ExecutionStopAct = Object.freeze({
  reason: "dbtest lock holder",
  actor: "dbtest-cos-holder",
});

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

const { buildOffice, requestRun } = agentRunProbes(() => ({
  admin,
  owner,
  worker,
}));

/** Tenant B: never the local-CRM owner, so no other suite holds its row. */
const TENANT_TARGET: ExecutionStopTarget = Object.freeze({
  scope: "tenant",
  tenantId: TENANT_B,
});

/** The trip the S8 gate will make: bounded, authoritative, outcome as the CLI reads it. */
async function boundedTrip(
  tx: TxClient,
  target: ExecutionStopTarget,
  act: ExecutionStopAct = MEMBER_TRIP,
): Promise<ExecutionStopTripOutcome> {
  await tx.query(`set local lock_timeout = '${STOP_LOCK_TIMEOUT}'`);
  return tripExecutionStopWithOutcome(tx, target, act);
}

interface Refusal {
  readonly code: unknown;
  readonly message: unknown;
  readonly detail: unknown;
  readonly hint: unknown;
  readonly where: unknown;
}

/** Everything of a database error a caller could compare, and nothing else. */
const refusalOf = (error: unknown): Refusal => {
  const e = error as Record<string, unknown>;
  return {
    code: e.code,
    message: e.message,
    detail: e.detail,
    hint: e.hint,
    where: e.where,
  };
};

/** Stops recorded by an act with this reason, active or not. */
async function stopsWithReason(reason: string): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    "select id from ops.execution_stops where reason = $1 order by tripped_at, id",
    [reason],
  );
  return rows.map((row) => row.id);
}

/** Active stops naming the tenant at tenant scope. */
async function activeTenantStops(tenantId: string): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    `select id from ops.execution_stops
      where scope = 'tenant' and tenant_id = $1 and cleared_at is null
      order by tripped_at, id`,
    [tenantId],
  );
  return rows.map((row) => row.id);
}

/**
 * The bounded trip once this file holds nothing: retried while another
 * suite's session still holds the kill-switch lock. Every refused attempt
 * keeps the bound, answers 55P03 and records nothing.
 */
async function boundedTripOnceFree(): Promise<ExecutionStopTripOutcome> {
  const deadline = Date.now() + OTHER_SUITES_MS;
  for (;;) {
    try {
      return await owner.withTransaction((tx) =>
        boundedTrip(tx, TENANT_TARGET),
      );
    } catch (error) {
      if (refusalOf(error).code !== "55P03" || Date.now() > deadline) {
        throw error;
      }
      expect(await stopsWithReason(MEMBER_TRIP.reason)).toEqual([]);
    }
  }
}

/**
 * Resolves once backend `pid` holds the kill-switch lock, granted. Rejects
 * when that is not seen in time.
 */
async function waitUntilGranted(pid: number, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{ granted: boolean }>(
      `select true as granted from pg_locks l
        where l.pid = $1 and l.locktype = 'advisory' and l.granted
          and l.classid = ((ops.execution_stop_lock_key() >> 32) & 4294967295)::oid
          and l.objid = (ops.execution_stop_lock_key() & 4294967295)::oid and l.objsubid = 1`,
      [pid],
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `backend ${pid} was not granted the kill-switch lock within ${timeoutMs} ms`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("a trip bounded by the operator surface's lock_timeout, on the authoritative path", () => {
  // What the SQL suite cannot prove: a second backend really holding the lock.
  // One connection never waits on itself.
  it("fails with 55P03 within about the bound, identically whatever holds the lock, creates nothing, and records exactly one stop once the lock is free", async () => {
    await buildOffice(TENANT_A, "dbtest-cos-lock-a");
    const officeB = await buildOffice(TENANT_B, "dbtest-cos-lock-b");
    const holders: ReadonlyArray<
      readonly [string, (tx: TxClient) => Promise<unknown>]
    > = [
      [
        "an open trip in the same tenant",
        (tx) =>
          tripExecutionStop(
            tx,
            {
              scope: "agent",
              tenantId: TENANT_B,
              companyId: officeB.companyId,
              agentId: officeB.otherAgentId,
            },
            HOLD,
          ),
      ],
      [
        "an open trip in another tenant",
        (tx) =>
          tripExecutionStop(tx, { scope: "tenant", tenantId: TENANT_A }, HOLD),
      ],
      [
        "a shared holder, as a lease or a start holds it",
        (tx) =>
          tx.query(
            "select pg_advisory_xact_lock_shared(ops.execution_stop_lock_key())",
          ),
      ],
    ];
    const refusals: Refusal[] = [];

    for (const [name, hold] of holders) {
      const holder = openSession(owner);
      try {
        await holder.run(hold);
        const started = Date.now();
        const error = await rejectionOf(
          owner.withTransaction((tx) => boundedTrip(tx, TENANT_TARGET)),
        );
        const elapsed = Date.now() - started;

        refusals.push(refusalOf(error));
        expect(refusalOf(error).code, name).toBe("55P03");
        expect(elapsed, name).toBeGreaterThanOrEqual(BOUND_MS - 100);
        expect(elapsed, name).toBeLessThan(BOUND_MS + SLACK_MS);
        expect(await stopsWithReason(MEMBER_TRIP.reason), name).toEqual([]);
      } finally {
        await holder.end("rollback");
      }
    }

    // One answer, whatever held the lock and whichever tenant it served: the
    // wait on the kill-switch lock, with the same context each time.
    expect(refusals).toEqual(refusals.map(() => refusals[0]));
    expect(refusals[0].where).toMatch(/execution_stop_lock_key/);
    expect(await stopsWithReason(HOLD.reason)).toEqual([]);

    const released = await boundedTripOnceFree();
    expect(released).toMatchObject({
      outcome: "stopped",
      trippedBy: MEMBER_TRIP.actor,
    });
    expect(await stopsWithReason(MEMBER_TRIP.reason)).toEqual([
      released.stopId,
    ]);
    expect(await activeTenantStops(TENANT_B)).toEqual([released.stopId]);
  }, 120_000);

  // What the SQL suite cannot prove: the lock queue across three backends. A
  // waiting exclusive request queues every later shared one behind it, so a
  // trip in tenant B that waits delays tenant A's lease, and the bound caps
  // that delay. The lease is the worker's own, as its login, rolled back.
  it("delays another tenant's lease behind a waiting trip for at most about the bound, then lets it lease", async () => {
    const officeA = await buildOffice(TENANT_A, "dbtest-cos-lock-hol-a");
    await buildOffice(TENANT_B, "dbtest-cos-lock-hol-b");
    await requestRun(officeA, "dbtest-cos-lock-hol");
    const holder = openSession(owner);
    const trip = openSession(owner);
    const lease = openSession(worker);
    try {
      await holder.run((tx) =>
        tx.query(
          "select pg_advisory_xact_lock_shared(ops.execution_stop_lock_key())",
        ),
      );
      const tripPid = await trip.pid;
      const tripped = trip.run((tx) => boundedTrip(tx, TENANT_TARGET));
      tripped.catch(() => undefined);
      await waitUntilBlocked(admin, tripPid, tripped, "advisory");

      const leasePid = await lease.pid;
      const started = Date.now();
      const leased = lease.run(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ id: string | null }>(
          "select id from ops.lease_job($1, 60)",
          [OTHER],
        );
        return rows[0]?.id ?? null;
      });
      leased.catch(() => undefined);
      // Behind the waiting trip, not beside the compatible shared holder...
      await waitUntilBlocked(admin, leasePid, leased, "advisory");
      // ...until the trip gives up at its bound and the lease is granted.
      await waitUntilGranted(leasePid);
      const waited = Date.now() - started;
      const leasedJob = await leased;

      expect(refusalOf(await rejectionOf(tripped)).code).toBe("55P03");
      expect(waited).toBeLessThan(BOUND_MS + SLACK_MS);
      // Tenant A's queued job, or whatever heads the shared queue; null only
      // when another suite's worker leased every queued job first.
      expect(leasedJob === null || typeof leasedJob === "string").toBe(true);
      expect(await stopsWithReason(MEMBER_TRIP.reason)).toEqual([]);
    } finally {
      await holder.end("rollback");
      await lease.end("rollback");
      await trip.end("rollback");
    }
  }, 60_000);
});

describe("deny wins: a bounded trip racing a CLI clear of the same target", () => {
  /**
   * An active tenant stop, a CLI clear of it held open after its lock and its
   * update, and the bounded trip of the same target started behind it and
   * seen waiting on the lock; then the clear ends as `end` says and the trip
   * answers. Should another suite's session hold the kill-switch lock past
   * the trip's bound once the clear has ended, the trip is refused with
   * 55P03, records nothing, and the race has not been seen to its end: it is
   * run again from a stop-free tenant.
   */
  async function raceAClear(end: "commit" | "rollback") {
    const deadline = Date.now() + OTHER_SUITES_MS;
    for (;;) {
      const existing = await owner.withTransaction((tx) =>
        tripExecutionStop(tx, TENANT_TARGET, TRIP),
      );
      const clearing = openSession(owner);
      const trip = openSession(owner);
      try {
        expect(
          await clearing.run((tx) => clearExecutionStop(tx, existing, CLEAR)),
        ).toBe(true);
        const tripPid = await trip.pid;
        const outcome = trip.run((tx) => boundedTrip(tx, TENANT_TARGET));
        outcome.catch(() => undefined);
        await waitUntilBlocked(admin, tripPid, outcome, "advisory");
        // No lock-free pre-check: the stop is still active for everyone
        // else, and the trip waits anyway. A pre-check would have answered
        // already_stopped.
        expect(await activeTenantStops(TENANT_B)).toEqual([existing]);
        await clearing.end(end);
        try {
          const result = await outcome;
          await trip.end("commit");
          return { existing, result };
        } catch (error) {
          if (refusalOf(error).code !== "55P03" || Date.now() > deadline) {
            throw error;
          }
          expect(await stopsWithReason(MEMBER_TRIP.reason)).toEqual([]);
        }
      } finally {
        await clearing.end("rollback");
        await trip.end("rollback");
      }
      for (const stopId of await activeTenantStops(TENANT_B)) {
        await owner.withTransaction((tx) =>
          clearExecutionStop(tx, stopId, CLEAR),
        );
      }
    }
  }

  // What the SQL suite cannot prove: two sessions racing. An answer of
  // already_stopped here would name a stop the clear just removed, and the
  // member's stop would be lost.
  it("reports stopped with a new active stop when the clear commits", async () => {
    await buildOffice(TENANT_B, "dbtest-cos-race-commit");
    const { existing, result } = await raceAClear("commit");

    expect(result).toMatchObject({
      outcome: "stopped",
      trippedBy: MEMBER_TRIP.actor,
    });
    expect(result.stopId).not.toBe(existing);
    expect(await activeTenantStops(TENANT_B)).toEqual([result.stopId]);
  }, 90_000);

  it("returns the existing stop as already_stopped when the clear rolls back", async () => {
    await buildOffice(TENANT_B, "dbtest-cos-race-rollback");
    const { existing, result } = await raceAClear("rollback");

    expect(result).toEqual({
      stopId: existing,
      outcome: "already_stopped",
      trippedBy: TRIP.actor,
    });
    expect(await activeTenantStops(TENANT_B)).toEqual([existing]);
    expect(await stopsWithReason(MEMBER_TRIP.reason)).toEqual([]);
  }, 90_000);
});
