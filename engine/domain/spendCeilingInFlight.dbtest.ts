// The global spend ceiling's sweep beside calls in flight (ADR 0017 §5),
// through real worker loops whose reaper tick runs on every iteration, against a
// real Postgres through the real `pg` driver and the real agent run handler,
// with a scripted model provider whose call a case holds in flight.
//
// The sweep trips on SETTLED spend only, so one burst of concurrent calls
// cannot halt the fleet. supabase/tests/runtime_governance.sql (section E)
// shows that on rows it arranges by hand; this file shows it on the running
// system, counting the ticks that ran while each state held:
//
//   * starts refused only by contention never trip it, and neither does a
//     reservation in flight;
//   * the same amount, once the call that reserved it settled indeterminate at
//     that reservation, trips it on the next tick.
//
// The sweep after a refusal is in spendCeiling.dbtest.ts. It lives in
// engine/domain because only there may a test import the domain services, the
// worker runtime and the database fixture together (eslint.config.js). All data
// is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { FAKE_DEFAULT_USAGE } from "../models/fakeModelProvider.ts";
import {
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import { createGatedModelProvider } from "../worker/testSupport/gatedModelProvider.ts";
import {
  activeSystemStops,
  estimateFor,
  globalStops,
  quietSpend,
  readRunCost,
  reservationFor,
  setDailyLimit,
  todaySpend,
  waitUntil,
} from "../worker/testSupport/spendProbes.ts";
import { VALID, withinMs } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  PRICED_MODEL,
  requestRuns,
  startWorkers,
} from "./testSupport/governanceRuntime.ts";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let governance: FixtureGovernance;

beforeAll(() => {
  ({ admin, owner, db } = openGovernanceDatabases());
}, 60_000);

afterAll(() => closeGovernanceDatabases({ admin, owner, db }));

beforeEach(async () => {
  governance = await resetFixtures(admin);
});

const priceId = () => governance.priceIds[PRICED_MODEL];

/** The worker's database, counting every reaper tick's ceiling sweep once it has answered. */
function countingSweeps(inner: WorkerDatabase): {
  readonly db: WorkerDatabase;
  readonly sweeps: () => number;
} {
  let sweeps = 0;
  const counting = (tx: TxClient): TxClient => ({
    async query(sql, params) {
      const result = await tx.query(sql, params);
      if (sql.includes("ops.enforce_spend_ceiling()")) sweeps += 1;
      return result as never;
    },
  });
  return {
    sweeps: () => sweeps,
    db: {
      withTransaction: (fn) => inner.withTransaction((tx) => fn(counting(tx))),
      identity: () => inner.identity(),
      close: () => Promise.resolve(),
    },
  };
}

describe("the reaper tick while calls are in flight", () => {
  // What the SQL suite cannot prove: a burst on the running system. One call
  // holds the only room the ceiling has; the other start is contended and
  // retried; the other loop keeps ticking the whole time.
  it("never trips the ceiling stop for a start refused only by contention, nor for the reservation in flight", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-burst");
    const [first, second] = await requestRuns(owner, office, [
      "burst-1",
      "burst-2",
    ]);
    const settled = await quietSpend(admin, "global");
    const reservation = await reservationFor(admin, first, priceId());
    const estimate = (await estimateFor(
      admin,
      priceId(),
      FAKE_DEFAULT_USAGE,
    )) as bigint;
    // One call fits in flight, two do not; the settled answer leaves room for
    // the second, so nothing here is ever exhausted.
    const ceiling = settled + reservation + estimate;
    await setDailyLimit(admin, "global", ceiling);
    const provider = createGatedModelProvider({
      type: "respond",
      content: VALID,
    });
    const counted = countingSweeps(db);
    const workers = startWorkers(
      counted.db,
      governedRuntime(provider).registry,
      ["dbtest-burst-w1", "dbtest-burst-w2"],
      { reapIntervalMs: 0 },
    );
    try {
      await withinMs(
        provider.callStarted(1),
        15_000,
        "the admitted call never started",
      );
      await waitUntil(async () => {
        const { rows } = await admin.query<{ n: number }>(
          `select count(*)::int as n from ops.job_events e
             join ops.agent_runs r on r.job_id = e.job_id
            where r.id = any($1::uuid[]) and e.event = 'retry'
              and e.detail like '[transient] OS429:%'`,
          [[first, second]],
        );
        return rows[0].n === 1;
      }, "the second start was not recorded as a contended retry");
      const afterContention = counted.sweeps();
      await waitUntil(
        async () => counted.sweeps() >= afterContention + 3,
        "the reaper tick did not run after the contention",
      );
      expect(await activeSystemStops(admin)).toEqual([]);
      const inFlight = await todaySpend(admin, "global");
      expect(inFlight).toEqual({
        charged: settled + reservation,
        settled,
      });
      expect(provider.started).toBe(1);

      provider.open();
      await waitUntil(
        async () =>
          (
            await Promise.all(
              [first, second].map((runId) => readRunCost(admin, runId)),
            )
          ).some((cost) => cost.status === "succeeded"),
        "the admitted call never settled",
      );
      const afterSettlement = counted.sweeps();
      await waitUntil(
        async () => counted.sweeps() >= afterSettlement + 3,
        "the reaper tick did not run after the settlement",
      );
      expect(await activeSystemStops(admin)).toEqual([]);
    } finally {
      provider.open();
      await workers.stop();
    }
    expect(
      workers.events.filter(({ event }) => event === "spend_ceiling.tripped"),
    ).toEqual([]);
    expect(
      workers.events.filter(({ event }) => event === "worker.poll_failed"),
    ).toEqual([]);
  }, 60_000);

  // What the SQL suite cannot prove: the same tick meeting a reservation that
  // reaches the ceiling while its call is in flight (no trip), and the same
  // amount once the call settled indeterminate at its reservation (a trip).
  it("trips the ceiling stop once settled spend reaches the ceiling, and not while the call whose reservation reaches it is still in flight", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-reach");
    const [runId] = await requestRuns(owner, office, ["reach-1"]);
    const settled = await quietSpend(admin, "global");
    const reservation = await reservationFor(admin, runId, priceId());
    const ceilingId = await setDailyLimit(
      admin,
      "global",
      settled + reservation,
    );
    const provider = createGatedModelProvider({
      type: "fail",
      category: "provider_5xx",
    });
    const counted = countingSweeps(db);
    const workers = startWorkers(
      counted.db,
      governedRuntime(provider).registry,
      ["dbtest-reach-w1", "dbtest-reach-w2"],
      { reapIntervalMs: 0 },
    );
    try {
      await withinMs(
        provider.callStarted(1),
        15_000,
        "the call whose reservation reaches the ceiling never started",
      );
      const whileInFlight = counted.sweeps();
      await waitUntil(
        async () => counted.sweeps() >= whileInFlight + 3,
        "the reaper tick did not run while the call was in flight",
      );
      expect(await todaySpend(admin, "global")).toEqual({
        charged: settled + reservation,
        settled,
      });
      expect(await activeSystemStops(admin)).toEqual([]);

      provider.open();
      await waitUntil(
        async () => (await activeSystemStops(admin)).length === 1,
        "settled spend at the ceiling did not trip the system stop",
      );
    } finally {
      provider.open();
      await workers.stop();
    }
    expect(await readRunCost(admin, runId)).toMatchObject({
      status: "indeterminate",
      errorCategory: "provider_5xx",
      charged: reservation,
    });
    expect(await todaySpend(admin, "global")).toEqual({
      charged: settled + reservation,
      settled: settled + reservation,
    });
    const [stop] = await activeSystemStops(admin);
    expect(stop.trippedBy).toBe("system:spend_ceiling");
    expect(stop.reason).toContain(ceilingId);
    // Two loops may both report the one trip; neither records a second stop.
    const reported = workers.events
      .filter(({ event }) => event === "spend_ceiling.tripped")
      .map(({ fields }) => fields.detail);
    expect(reported.length).toBeGreaterThanOrEqual(1);
    expect(new Set(reported)).toEqual(new Set([stop.id]));
    expect(
      (await globalStops(admin)).filter((row) => row.origin === "system"),
    ).toHaveLength(1);
  }, 60_000);
});
