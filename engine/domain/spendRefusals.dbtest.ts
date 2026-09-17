// Governance refusals through the real worker runtime (ADR 0017 §1 and §3),
// against a real Postgres through the real `pg` driver and the real agent run
// handler, with a scripted model provider that counts every call.
//
// supabase/tests/runtime_governance.sql proves each refusal on leases it takes
// by hand, inside one rolled-back transaction. What it cannot show is the
// runtime's side: that the real handler, on a real committed lease, records the
// refusal the database decided, completes the job, and never reaches the
// provider. Every case here counts provider calls, and every refusal leaves the
// run with no price, no reservation and no charge:
//
//   * a start that settled spend alone cannot absorb is recorded
//     budget_exhausted, naming the limit version that refused it;
//   * a request made once settled spend has reached a budget is refused before
//     any job exists;
//   * a missing global ceiling or tenant budget refuses at request, and at start
//     when it was retired between the two;
//   * a model with no current price (never priced, or its price expired) is
//     refused at start;
//   * one tenant's exhausted budget refuses only that tenant;
//   * exhaustion wins over contention: a start its tenant budget cannot absorb
//     is recorded budget_exhausted even while another tenant's call in flight
//     contends the global ceiling, instead of being retried.
//
// Concurrency at a limit is in spendAdmission.dbtest.ts. It lives in
// engine/domain because only there may a test import the domain services, the
// worker runtime and the database fixture together (eslint.config.js). All data
// is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  readJob,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import {
  createGatedModelProvider,
  type GatedModelProvider,
} from "../worker/testSupport/gatedModelProvider.ts";
import {
  activeLimitId,
  quietSpend,
  readRunCost,
  recordPrice,
  reservationFor,
  retireDailyLimit,
  setDailyLimit,
  todaySpend,
  UNSTARTED_COST,
  type LimitScope,
} from "../worker/testSupport/spendProbes.ts";
import { VALID, withinMs } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  PRICED_MODEL,
  requestRuns,
  type GovernedOffice,
} from "./testSupport/governanceRuntime.ts";

const WORKER = "dbtest-spend-refusals";

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

const answering = (): GatedModelProvider => {
  const provider = createGatedModelProvider({
    type: "respond",
    content: VALID,
  });
  provider.open();
  return provider;
};

/** One pass of the real runtime with the production registry, its route naming `model`. */
const runOnce = (provider: GatedModelProvider, model = PRICED_MODEL) =>
  runOneJob(db, {
    workerId: WORKER,
    registry: governedRuntime(provider, model).registry,
  });

/** One run requested and answered, so the tenant's day has settled spend. */
async function settleOneRun(
  office: GovernedOffice,
  key: string,
): Promise<bigint> {
  const [runId] = await requestRuns(owner, office, [key]);
  expect((await runOnce(answering())).outcome).toBe("succeeded");
  const cost = await readRunCost(admin, runId);
  expect(cost.status).toBe("succeeded");
  expect(cost.charged).toBeGreaterThan(0n);
  return cost.charged as bigint;
}

async function jobCount(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from ops.jobs where tenant_id = $1",
    [tenantId],
  );
  return rows[0].n;
}

/** The run was refused by governance and carries nothing of a start. */
async function expectRefused(
  runId: string,
  errorCode: string,
  spendLimitId: string | null,
): Promise<void> {
  expect(await readRunCost(admin, runId)).toMatchObject({
    ...UNSTARTED_COST,
    status: "cancelled",
    errorCategory: "refused",
    errorCode,
    stopId: null,
    spendLimitId,
  });
  const { rows } = await admin.query<{ provider: string | null }>(
    "select provider from ops.agent_runs where id = $1",
    [runId],
  );
  expect(rows[0].provider).toBeNull();
}

// ---------------------------------------------------------------------------
// Settled spend exhausts a budget
// ---------------------------------------------------------------------------

describe("a tenant budget exhausted by settled spend", () => {
  // What the SQL suite cannot prove: the refusal the real handler meets at
  // start. The run was requested while the budget still had room (a request
  // checks one micro-USD), and only the start's full reservation exhausts it.
  it("records a start that settled spend cannot absorb as cancelled, refused, budget_exhausted naming the budget version, with no provider call", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-spent");
    await settleOneRun(office, "spent-settled");
    const [runId] = await requestRuns(owner, office, ["spent-next"]);
    const settled = await quietSpend(admin, "tenant", TENANT_A);
    const reservation = await reservationFor(
      admin,
      runId,
      governance.priceIds[PRICED_MODEL],
    );
    const budget = await setDailyLimit(
      admin,
      "tenant",
      settled + reservation - 1n,
      TENANT_A,
    );
    const provider = answering();

    const result = await runOnce(provider);

    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: `agent_run=${runId} status=cancelled`,
    });
    expect(provider.started).toBe(0);
    await expectRefused(runId, "budget_exhausted", budget);
    expect((await readJob(admin, result.jobId as string)).status).toBe(
      "succeeded",
    );
    expect(await todaySpend(admin, "tenant", TENANT_A)).toEqual({
      charged: settled,
      settled,
    });
  }, 30_000);

  // What the SQL suite cannot prove: the early refusal the owner's request path
  // meets, with nothing queued for any worker to lease afterwards.
  it("refuses a request made once settled spend has reached the budget, naming the budget version, before any job exists", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-reached");
    const settled = await settleOneRun(office, "reached-settled");
    expect(await quietSpend(admin, "tenant", TENANT_A)).toBe(settled);
    const budget = await setDailyLimit(admin, "tenant", settled, TENANT_A);
    const jobsBefore = await jobCount(TENANT_A);
    const provider = answering();

    const [runId] = await requestRuns(owner, office, ["reached-next"]);

    await expectRefused(runId, "budget_exhausted", budget);
    expect((await readRunCost(admin, runId)).jobId).toBeNull();
    expect(await jobCount(TENANT_A)).toBe(jobsBefore);
    expect((await runOnce(provider)).outcome).toBe("idle");
    expect(provider.started).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// A missing limit refuses
// ---------------------------------------------------------------------------

const UNCONFIGURED: Readonly<Record<LimitScope, string>> = Object.freeze({
  global: "spend_ceiling_unconfigured",
  tenant: "budget_unconfigured",
});

const limitTenant = (scope: LimitScope) =>
  scope === "global" ? null : TENANT_A;

describe("a missing global ceiling or tenant budget", () => {
  // What the SQL suite cannot prove: that absence refuses on the real request
  // path too, so no worker ever sees a job for the run.
  it.each<LimitScope>(["global", "tenant"])(
    "refuses a request with no %s limit in force, naming no limit, before any job exists",
    async (scope) => {
      const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-bare");
      await retireDailyLimit(admin, scope, limitTenant(scope));
      const provider = answering();

      const [runId] = await requestRuns(owner, office, [`bare-${scope}`]);

      await expectRefused(runId, UNCONFIGURED[scope], null);
      expect((await readRunCost(admin, runId)).jobId).toBeNull();
      expect(await jobCount(TENANT_A)).toBe(0);
      expect((await runOnce(provider)).outcome).toBe("idle");
      expect(provider.started).toBe(0);
    },
    30_000,
  );

  // What the SQL suite cannot prove: the start the real handler makes for a
  // job queued while the limit existed. The request admitted it; the start is
  // authoritative and refuses it.
  it.each<LimitScope>(["global", "tenant"])(
    "refuses at start, with no provider call, a run whose %s limit was retired between its request and its start",
    async (scope) => {
      const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-gone");
      const [runId] = await requestRuns(owner, office, [`gone-${scope}`]);
      const jobId = (await readRunCost(admin, runId)).jobId;
      expect(jobId).not.toBeNull();
      await retireDailyLimit(admin, scope, limitTenant(scope));
      expect(await activeLimitId(admin, scope, limitTenant(scope))).toBeNull();
      const provider = answering();

      const result = await runOnce(provider);

      expect(result).toMatchObject({
        outcome: "succeeded",
        jobId,
        detail: `agent_run=${runId} status=cancelled`,
      });
      expect(provider.started).toBe(0);
      await expectRefused(runId, UNCONFIGURED[scope], null);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// No current price
// ---------------------------------------------------------------------------

describe("a route whose model has no current price", () => {
  // What the SQL suite cannot prove: that the model a deployment's ROUTER names
  // is the one priced, through the real handler's start. The fixture prices
  // only its own model; these routes name another.
  it.each([
    ["that was never priced", "fake-model-unpriced", null],
    [
      "whose only price has expired",
      "fake-model-expired",
      { effectiveFrom: "-2 days", expiresAt: "-1 day" },
    ],
  ] as const)(
    "refuses at start, with no provider call, a run whose route names a model %s",
    async (_label, model, window) => {
      if (window) await recordPrice(admin, model, { ...window });
      const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-price");
      const [runId] = await requestRuns(owner, office, [`price-${model}`]);
      const provider = answering();

      const result = await runOnce(provider, model);

      expect(result).toMatchObject({
        outcome: "succeeded",
        detail: `agent_run=${runId} status=cancelled`,
      });
      expect(provider.started).toBe(0);
      await expectRefused(runId, "price_unavailable", null);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Budgets are per tenant
// ---------------------------------------------------------------------------

describe("tenant budgets", () => {
  // What the SQL suite cannot prove: two tenants' runs on one real queue, one
  // worker, one provider. Tenant B's spent budget refuses B's run at start and
  // B's next request, and nothing about A.
  it("refuses tenant B's runs on B's exhausted budget and still runs tenant A's, with a provider call for A only", async () => {
    const officeA = await buildGovernedOffice(owner, TENANT_A, "dbtest-share");
    const officeB = await buildGovernedOffice(owner, TENANT_B, "dbtest-share");
    const settledB = await settleOneRun(officeB, "b-settled");
    const [queuedB] = await requestRuns(owner, officeB, ["b-queued"]);
    const budgetB = await setDailyLimit(admin, "tenant", settledB, TENANT_B);
    const budgetA = governance.tenantLimitIds[TENANT_A];
    const [refusedB] = await requestRuns(owner, officeB, ["b-refused"]);
    const [runA] = await requestRuns(owner, officeA, ["a-runs"]);
    const provider = answering();

    const first = await runOnce(provider);
    const second = await runOnce(provider);
    const third = await runOnce(provider);

    expect([first.outcome, second.outcome, third.outcome]).toEqual([
      "succeeded",
      "succeeded",
      "idle",
    ]);
    expect(provider.started).toBe(1);
    await expectRefused(queuedB, "budget_exhausted", budgetB);
    await expectRefused(refusedB, "budget_exhausted", budgetB);
    const costA = await readRunCost(admin, runA);
    expect(costA.status).toBe("succeeded");
    expect(costA.charged).toBeGreaterThan(0n);
    expect(await activeLimitId(admin, "tenant", TENANT_A)).toBe(budgetA);
    expect((await todaySpend(admin, "tenant", TENANT_B)).charged).toBe(
      settledB,
    );
  }, 30_000);

  // What the SQL suite cannot prove (A6 checks the admission answer on rows it
  // arranges): the runtime's outcome when the two refusals meet. The global
  // ceiling fits settled spend plus one reservation, and tenant B's call holds
  // that room in flight; tenant A's budget cannot absorb A's run even from its
  // settled spend. A contended answer would retry A's job; exhaustion ends it.
  it("records a start its tenant budget cannot absorb as budget_exhausted, not as a contended retry, while another tenant's call in flight contends the global ceiling", async () => {
    const officeA = await buildGovernedOffice(owner, TENANT_A, "dbtest-both");
    const officeB = await buildGovernedOffice(owner, TENANT_B, "dbtest-both");
    const settledA = await settleOneRun(officeA, "both-a-settled");
    const [inFlightB] = await requestRuns(owner, officeB, ["both-b-flight"]);
    const [refusedA] = await requestRuns(owner, officeA, ["both-a-refused"]);
    const priceId = governance.priceIds[PRICED_MODEL];
    const reservation = await reservationFor(admin, refusedA, priceId);
    expect(await reservationFor(admin, inFlightB, priceId)).toBe(reservation);
    const settled = await quietSpend(admin, "global");
    await setDailyLimit(admin, "global", settled + reservation);
    const budgetA = await setDailyLimit(
      admin,
      "tenant",
      settledA + reservation - 1n,
      TENANT_A,
    );
    const gated = createGatedModelProvider({ type: "respond", content: VALID });
    const flightB = runOneJob(db, {
      workerId: "dbtest-spend-refusals-flight",
      registry: governedRuntime(gated).registry,
    });
    try {
      await withinMs(
        gated.callStarted(1),
        15_000,
        "tenant B's call never started",
      );
      expect(await todaySpend(admin, "global")).toEqual({
        charged: settled + reservation,
        settled,
      });
      const provider = answering();

      const result = await runOnce(provider);

      expect(result).toMatchObject({
        outcome: "succeeded",
        detail: `agent_run=${refusedA} status=cancelled`,
      });
      expect(provider.started).toBe(0);
      await expectRefused(refusedA, "budget_exhausted", budgetA);
      expect((await readJob(admin, result.jobId as string)).status).toBe(
        "succeeded",
      );
    } finally {
      gated.open();
      await flightB;
    }
    expect((await flightB).outcome).toBe("succeeded");
    expect(gated.started).toBe(1);
    expect((await readRunCost(admin, inFlightB)).status).toBe("succeeded");
  }, 30_000);
});
