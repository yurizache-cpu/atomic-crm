// What a run is charged when it settles (ADR 0017 §2), through real runs:
// the real `pg` driver, the real worker runtime and the real agent run handler,
// with a scripted model provider, and a real worker process killed mid-call.
//
// supabase/tests/runtime_governance.sql proves the charge rules on rows it
// settles by hand (C5, C6). What it cannot show is that the facts the RUNTIME
// records, from what a provider really answered or failed with, land on the
// rule the ADR names:
//
//   * a succeeded run with complete, consistent usage records its price
//     version and an estimate, and is charged the estimate;
//   * usage that is missing or contradictory leaves the estimate empty and
//     charges the reservation;
//   * a refusal proven to have no response body (a refusal category, no
//     response id, no response model, no usage) is charged nothing, and the
//     same refusal carrying any of those, or a failure of any other category
//     carrying none of them, is charged its reservation;
//   * a run that ends indeterminate (a call hung past its deadline, a server
//     error with usage, a worker killed mid-call and swept later) is never
//     charged below its reservation.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { ModelError, type ModelErrorDetails } from "../models/errors.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
} from "../models/fakeModelProvider.ts";
import type { ModelProvider, ModelUsage } from "../models/types.ts";
import { runOneJob, type RunOneJobOptions } from "../worker/runOneJob.ts";
import {
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import {
  estimateFor,
  readRunCost,
  recordPrice,
  reservationFor,
} from "../worker/testSupport/spendProbes.ts";
import { spawnAgentRunWorker } from "./testSupport/agentRunProcesses.ts";
import { agentRuntimeProbes, VALID } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  PRICED_MODEL,
  requestRuns,
} from "./testSupport/governanceRuntime.ts";

const WORKER = "dbtest-spend-settlement";
/** A model priced by this suite with rates that make the arithmetic legible. */
const RATED_MODEL = "fake-model-rated";

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

const { expireLease, sweepStaleRuns } = agentRuntimeProbes(() => ({
  admin,
  owner,
  db,
}));

/**
 * Requests one run and settles it through one pass of the real runtime, its
 * route naming `model` and served by `provider`. Resolves to the run's cost.
 */
async function settleRun(
  provider: ModelProvider,
  options: { model?: string } & Partial<RunOneJobOptions> = {},
) {
  const { model = PRICED_MODEL, ...runOptions } = options;
  const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-settle");
  const [runId] = await requestRuns(owner, office, ["settle-1"]);
  const result = await runOneJob(db, {
    workerId: WORKER,
    registry: governedRuntime(provider, model).registry,
    ...runOptions,
  });
  expect(result.outcome).toBe("succeeded");
  return { runId, cost: await readRunCost(admin, runId) };
}

const scripted = (behavior: FakeBehavior) => createFakeModelProvider(behavior);

/** A provider that refuses every call with this error, as an adapter would. */
const refusing = (
  category: ModelError["category"],
  details: ModelErrorDetails,
): ModelProvider =>
  Object.freeze({
    name: "fake",
    execute: () => Promise.reject(new ModelError(category, details)),
  });

const usage = (overrides: Partial<ModelUsage>): ModelUsage => ({
  inputTokens: 1000,
  cachedInputTokens: 200,
  outputTokens: 300,
  reasoningTokens: 100,
  totalTokens: 1300,
  ...overrides,
});

// ---------------------------------------------------------------------------
// A known answer
// ---------------------------------------------------------------------------

describe("a succeeded run", () => {
  // What the SQL suite cannot prove: that the usage the router passes on from
  // a real answer is what the database prices, under the version the real
  // start chose. The version's rates are chosen so the estimate can be checked
  // by hand: 800 uncached input tokens at 2 USD, 200 cached at 0.5 USD and 300
  // output tokens (reasoning inside them) at 8 USD per million tokens.
  it("records its price version, an estimate from complete and consistent usage, and a charge equal to that estimate", async () => {
    const priceId = await recordPrice(admin, RATED_MODEL, {
      effectiveFrom: "-1 hour",
      expiresAt: "1 day",
      inputUsdPerMtok: "2",
      cachedInputUsdPerMtok: "0.5",
      outputUsdPerMtok: "8",
    });
    const reported = usage({});
    const byHand = 800n * 2n + 200n / 2n + 300n * 8n;
    expect(await estimateFor(admin, priceId, reported)).toBe(byHand);

    const { runId, cost } = await settleRun(
      scripted({ type: "respond", content: VALID, usage: reported }),
      { model: RATED_MODEL },
    );

    expect(cost).toMatchObject({
      status: "succeeded",
      priceId,
      estimated: byHand,
      charged: byHand,
      spendLimitId: null,
    });
    expect(cost.reserved).toBe(await reservationFor(admin, runId, priceId));
    expect(cost.reserved).toBeGreaterThan(byHand);
  }, 30_000);

  // What the SQL suite cannot prove: that a report the router still passes on
  // (every count is a valid token count) but which is not a cost stays
  // unpriced through the real settlement, and is charged as the worst case.
  it.each([
    [
      "reports more cached input than input",
      usage({ cachedInputTokens: 1001 }),
    ],
    ["reports a total below input plus output", usage({ totalTokens: 1299 })],
    ["reports no output tokens", usage({ outputTokens: null })],
    ["reports no usage at all", null],
  ] as const)(
    "leaves the estimate empty and charges its reservation when the provider %s",
    async (_label, reported) => {
      const { runId, cost } = await settleRun(
        scripted({ type: "respond", content: VALID, usage: reported }),
      );

      const priceId = governance.priceIds[PRICED_MODEL];
      expect(cost).toMatchObject({
        status: "succeeded",
        priceId,
        estimated: null,
      });
      expect(cost.reserved).toBe(await reservationFor(admin, runId, priceId));
      expect(cost.charged).toBe(cost.reserved);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// A refusal
// ---------------------------------------------------------------------------

describe("a run the provider refused", () => {
  // What the SQL suite cannot prove: that the fields the real handler records
  // for a failed call are exactly the ones the zero-charge rule reads, so a
  // refusal the adapter reports with nothing attached costs nothing.
  it.each([
    "authentication",
    "rate_limit",
    "invalid_request",
    "configuration",
  ] as const)(
    "is charged nothing for a refusal of category %s that carries no response id, no response model and no usage",
    async (category) => {
      const { cost } = await settleRun(scripted({ type: "fail", category }));

      expect(cost).toMatchObject({
        status: "failed",
        errorCategory: category,
        priceId: governance.priceIds[PRICED_MODEL],
        estimated: null,
        charged: 0n,
      });
      expect(cost.reserved).toBeGreaterThan(0n);
    },
    30_000,
  );

  // What the SQL suite cannot prove: that the zero charge is kept for the
  // refusal categories alone. These failures mean a body arrived and could not
  // be used; a provider that attaches no response id or model to them has still
  // billed a call, so the worst case stands.
  it.each(["invalid_response", "schema_validation"] as const)(
    "is charged its reservation for a failed run of category %s that carries no response id, no response model and no usage",
    async (category) => {
      const { runId, cost } = await settleRun(
        scripted({ type: "fail", category }),
      );

      const priceId = governance.priceIds[PRICED_MODEL];
      expect(cost).toMatchObject({
        status: "failed",
        errorCategory: category,
        priceId,
        estimated: null,
      });
      expect(cost.reserved).toBe(await reservationFor(admin, runId, priceId));
      expect(cost.charged).toBe(cost.reserved);
    },
    30_000,
  );

  // What the SQL suite cannot prove: the same rule when an adapter DID see a
  // body. Any one of the facts that a body arrived keeps the worst case.
  it.each([
    ["a provider response id", { providerResponseId: "fake-resp-refused-1" }],
    ["a response model", { model: PRICED_MODEL }],
    ["partial usage", { usage: usage({ outputTokens: null }) }],
  ] as const)(
    "is charged its reservation for an authentication refusal that carries %s",
    async (_label, details) => {
      const { runId, cost } = await settleRun(
        refusing("authentication", details),
      );

      const priceId = governance.priceIds[PRICED_MODEL];
      expect(cost).toMatchObject({
        status: "failed",
        errorCategory: "authentication",
        priceId,
        estimated: null,
      });
      expect(cost.reserved).toBe(await reservationFor(admin, runId, priceId));
      expect(cost.charged).toBe(cost.reserved);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// An unknown outcome
// ---------------------------------------------------------------------------

describe("a run that ends indeterminate", () => {
  // What the SQL suite cannot prove: the deadline the runtime derives from the
  // database's lease ending a real call, and what that outcome costs.
  it("is charged its reservation when its call hung past the lease-derived deadline", async () => {
    // 8 s lease - 2 s margin: the call gets about 6 s, above the 5 s minimum.
    const { cost } = await settleRun(scripted({ type: "hang" }), {
      leaseSeconds: 8,
      leaseSafetyMarginMs: 2_000,
    });

    expect(cost).toMatchObject({
      status: "indeterminate",
      errorCategory: "timeout",
      errorCode: "deadline",
      estimated: null,
    });
    expect(cost.reserved).toBeGreaterThan(0n);
    expect(cost.charged).toBe(cost.reserved);
  }, 60_000);

  // What the SQL suite cannot prove: an ambiguous failure that still reported
  // complete usage, through the real settlement. The usage is priced, and the
  // charge stays at the reservation above it.
  it("is charged its reservation, above the estimate its reported usage gives, for a server error that reported complete usage", async () => {
    const reported = usage({});
    const priceId = governance.priceIds[PRICED_MODEL];
    const estimate = await estimateFor(admin, priceId, reported);
    expect(estimate).not.toBeNull();

    const { cost } = await settleRun(
      scripted({ type: "fail", category: "provider_5xx", usage: reported }),
    );

    expect(cost).toMatchObject({
      status: "indeterminate",
      errorCategory: "provider_5xx",
      estimated: estimate,
    });
    expect(cost.reserved).toBeGreaterThan(estimate as bigint);
    expect(cost.charged).toBe(cost.reserved);
  }, 30_000);

  // What the SQL suite cannot prove: a real worker process killed with no
  // shutdown hook while its call is on the wire. The start it committed before
  // the call charges the reservation at once, and the sweep that settles the run
  // later keeps that charge.
  it("is charged its reservation when its worker process was killed mid-call and a later sweep settled it", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-killed");
    const [runId] = await requestRuns(owner, office, ["killed-1"]);
    const worker = spawnAgentRunWorker("dbtest-cost-killed", "hang");
    try {
      await worker.modelCallStarted;
    } finally {
      worker.child.kill("SIGKILL");
      await worker.closed;
    }
    const priceId = governance.priceIds[PRICED_MODEL];
    const reservation = await reservationFor(admin, runId, priceId);
    const inFlight = await readRunCost(admin, runId);
    expect(inFlight).toMatchObject({
      status: "running",
      priceId,
      reserved: reservation,
      charged: reservation,
    });

    await expireLease(inFlight.jobId as string);
    expect(await sweepStaleRuns()).toBe(1);

    expect(await readRunCost(admin, runId)).toMatchObject({
      status: "indeterminate",
      errorCategory: "interrupted",
      errorCode: "execution_interrupted",
      priceId,
      reserved: reservation,
      estimated: null,
      charged: reservation,
    });
  }, 60_000);
});
