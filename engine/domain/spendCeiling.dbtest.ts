// The global spend ceiling trips the one kill switch (ADR 0017 §5), through the
// real worker loop's reaper tick, against a real Postgres through the real `pg`
// driver and the real agent run handler, with a scripted model provider.
//
// supabase/tests/runtime_governance.sql (section E) calls
// ops.enforce_spend_ceiling() by hand on one connection. What it cannot show is
// the sweep as the running system meets it: runWorker's tick calling it on its
// own clock, and the stop it trips holding real queued work at the real lease.
// This file proves:
//
//   * a start refused as budget_exhausted by the ceiling version in force makes
//     the next tick trip a global stop as system:spend_ceiling, and that stop
//     holds the next queued agent run at the lease;
//   * an owner's global stop is a separate row: clearing the system stop leaves
//     the owner's stop holding work, and the tick trips a new system stop while
//     the version is still exhausted;
//   * once a new ceiling version is in force and the system stop is cleared,
//     the tick does not trip again and the held run starts.
//
// The tick beside calls in flight is in spendCeilingInFlight.dbtest.ts. It
// lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { runWorker } from "../worker/runWorker.ts";
import {
  FIXTURE_GLOBAL_LIMIT_MICROS,
  readJob,
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import {
  createGatedModelProvider,
  type GatedModelProvider,
} from "../worker/testSupport/gatedModelProvider.ts";
import {
  activeSystemStops,
  globalStops,
  quietSpend,
  readRunCost,
  reservationFor,
  setDailyLimit,
} from "../worker/testSupport/spendProbes.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import { VALID } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  PRICED_MODEL,
  requestRuns,
  type LoggedEvent,
} from "./testSupport/governanceRuntime.ts";

const TICKING_WORKER = "dbtest-ceiling-ticker";
const OWNER_ACT = { reason: "dbtest owner incident", actor: "dbtest-owner" };
const CLEAR = { reason: "dbtest cleared", actor: "dbtest-owner" };

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

const answering = (): GatedModelProvider => {
  const provider = createGatedModelProvider({
    type: "respond",
    content: VALID,
  });
  provider.open();
  return provider;
};

/** A real worker loop that runs its reaper tick on every iteration, for a bounded number of them. */
async function tickAndPoll(provider: GatedModelProvider, iterations: number) {
  const events: LoggedEvent[] = [];
  const stats = await runWorker({
    workerId: TICKING_WORKER,
    db,
    registry: governedRuntime(provider).registry,
    maxIterations: iterations,
    reapIntervalMs: 0,
    pollIntervalMs: 10,
    heartbeatIntervalMs: 60_000,
    log: (event, fields = {}) => {
      events.push({ event, fields });
    },
  });
  const tripped = events
    .filter(({ event }) => event === "spend_ceiling.tripped")
    .map(({ fields }) => fields.detail);
  const failures = events.filter(({ event }) => event === "worker.poll_failed");
  expect(failures).toEqual([]);
  return { stats, tripped };
}

/**
 * The ceiling version in force refuses one start as budget_exhausted; a second
 * run is then requested (the request checks one micro-USD, which still fits) and
 * waits queued. Then one worker loop ticks and polls.
 */
async function exhaustCeilingByRefusal() {
  const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-ceiling");
  const [refused] = await requestRuns(owner, office, ["ceiling-refused"]);
  const settled = await quietSpend(admin, "global");
  const reservation = await reservationFor(admin, refused, priceId());
  const ceilingId = await setDailyLimit(
    admin,
    "global",
    settled + reservation - 1n,
  );
  const provider = answering();
  expect(
    (
      await runOneJob(db, {
        workerId: "dbtest-ceiling-refused",
        registry: governedRuntime(provider).registry,
      })
    ).outcome,
  ).toBe("succeeded");
  expect(await readRunCost(admin, refused)).toMatchObject({
    status: "cancelled",
    errorCode: "budget_exhausted",
    spendLimitId: ceilingId,
    charged: null,
  });
  expect(await activeSystemStops(admin)).toEqual([]);

  const [held] = await requestRuns(owner, office, ["ceiling-held"]);
  const heldJob = (await readRunCost(admin, held)).jobId as string;
  expect(heldJob).not.toBeNull();

  const first = await tickAndPoll(provider, 2);
  const stops = await activeSystemStops(admin);
  expect(stops).toHaveLength(1);
  const [systemStop] = stops;
  expect(first.tripped).toEqual([systemStop.id]);
  expect(systemStop).toMatchObject({
    scope: "global",
    origin: "system",
    trippedBy: "system:spend_ceiling",
  });
  expect(systemStop.reason).toContain(ceilingId);
  expect(first.stats).toMatchObject({ leased: 0, idlePolls: 2 });
  expect(provider.started).toBe(0);
  return { provider, held, heldJob, systemStop, ceilingId };
}

async function expectHeld(held: string, heldJob: string): Promise<void> {
  expect(await readJob(admin, heldJob)).toMatchObject({
    status: "queued",
    attempts: 0,
    lease_owner: null,
  });
  expect((await readRunCost(admin, held)).status).toBe("pending");
}

describe("the reaper tick after the ceiling refused a start", () => {
  // What the SQL suite cannot prove: the refusal the real handler recorded is
  // what the loop's own tick trips on, and the stop it trips holds a queued
  // run at the real lease without consuming an attempt.
  it("trips a global stop as system:spend_ceiling naming the ceiling version, and that stop holds the next queued agent run at the lease", async () => {
    const { held, heldJob } = await exhaustCeilingByRefusal();

    await expectHeld(held, heldJob);
  }, 30_000);

  // What the SQL suite cannot prove: the two stops side by side on the real
  // queue. The owner's stop is not absorbed by the system one, is not cleared
  // with it, and holds work on its own.
  it("keeps an owner's global stop as a separate row that still holds work when the system stop is cleared, and trips a new system stop while the version is still exhausted", async () => {
    const { provider, held, heldJob, systemStop } =
      await exhaustCeilingByRefusal();
    const ownerStop = await owner.withTransaction((tx) =>
      tripExecutionStop(tx, { scope: "global" }, OWNER_ACT),
    );
    expect(ownerStop).not.toBe(systemStop.id);
    expect(
      (await globalStops(admin))
        .filter((stop) => stop.active)
        .map((stop) => [stop.id, stop.origin]),
    ).toEqual([
      [systemStop.id, "system"],
      [ownerStop, "owner"],
    ]);

    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, systemStop.id, CLEAR),
    );
    const withoutTick = await runOneJob(db, {
      workerId: "dbtest-ceiling-owner-held",
      registry: governedRuntime(provider).registry,
    });
    expect(withoutTick.outcome).toBe("idle");
    await expectHeld(held, heldJob);

    const again = await tickAndPoll(provider, 1);
    const stops = (await globalStops(admin)).filter((stop) => stop.active);
    expect(stops.map((stop) => stop.origin).sort()).toEqual([
      "owner",
      "system",
    ]);
    const retripped = stops.find((stop) => stop.origin === "system");
    expect(retripped?.id).not.toBe(systemStop.id);
    expect(again.tripped).toEqual([retripped?.id]);
    expect(stops.find((stop) => stop.origin === "owner")?.id).toBe(ownerStop);
    expect(again.stats.leased).toBe(0);
    await expectHeld(held, heldJob);
    expect(provider.started).toBe(0);
  }, 30_000);

  // What the SQL suite cannot prove: resuming as an operator would, with the
  // real loop ticking throughout. The old version's refusal stays on record and
  // no longer trips anything.
  it("does not trip again once a new ceiling version is in force and the system stop is cleared, and the held run then starts", async () => {
    const { provider, held, systemStop, ceilingId } =
      await exhaustCeilingByRefusal();
    const newVersion = await setDailyLimit(
      admin,
      "global",
      BigInt(FIXTURE_GLOBAL_LIMIT_MICROS),
    );
    expect(newVersion).not.toBe(ceilingId);
    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, systemStop.id, CLEAR),
    );

    const resumed = await tickAndPoll(provider, 3);

    expect(resumed.tripped).toEqual([]);
    expect(await activeSystemStops(admin)).toEqual([]);
    expect(resumed.stats).toMatchObject({ leased: 1, succeeded: 1 });
    expect(provider.started).toBe(1);
    expect(await readRunCost(admin, held)).toMatchObject({
      status: "succeeded",
      spendLimitId: null,
    });
    expect((await readRunCost(admin, held)).charged).toBeGreaterThan(0n);
  }, 30_000);
});
