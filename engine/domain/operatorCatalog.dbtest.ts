// The operator's price and limit catalogue (ADR 0017 §1, §3, §9) against a real
// Postgres: what `npm run ops -- prices` and `limits` print, what the database
// computes, and what a real start in another transaction then uses.
//
// engine/cli/operator.test.ts and engine/domain/modelPrices.test.ts see only
// the SQL the tool sends. The status of a price version (current, expired,
// future, superseded) is computed by the database at its own now(), with its own
// choice of the current version. What only the real database shows:
//
//   * one version of each status, built through the tool, listed as the
//     database computes it, the superseded ones only with --all;
//   * an older, unexpired version under an expired latest one is superseded,
//     not current, and a real run on that model is refused as
//     price_unavailable with no provider call: nothing falls back;
//   * the version a listing calls current is the one the next real start, in
//     another transaction, records, before and after a newer one takes effect;
//   * `limits` lists what is in force, and `limits --all` every version, ended
//     ones after active ones, with who ended each and why.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime, the CLIs and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import { readRunCost, recordPrice } from "../worker/testSupport/spendProbes.ts";
import { listModelPrices, type ModelPriceRow } from "./modelPrices.ts";
import { VALID } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  requestRuns,
} from "./testSupport/governanceRuntime.ts";
import { runOps } from "./testSupport/ownerCli.ts";

const WORKER = "dbtest-operator-catalog";
const ACTOR = "dbtest-operator";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

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

const isoFromNow = (ms: number): string =>
  new Date(Date.now() + ms).toISOString();

/** Records one version of `model` through the tool and resolves to its id. */
async function recordThroughTool(
  model: string,
  fromMs: number,
  untilMs: number,
): Promise<string> {
  const result = await runOps([
    ...["price", "record", "--provider", "fake", "--model", model],
    ...["--input-usd-per-mtok", "1", "--output-usd-per-mtok", "3"],
    ...["--reasoning-in-output", "yes"],
    ...["--effective-from", isoFromNow(fromMs)],
    ...["--expires-at", isoFromNow(untilMs)],
    ...["--source", "dbtest catalog price sheet", "--actor", ACTOR],
  ]);
  expect(result, result.stderr.join("\n")).toMatchObject({ code: 0 });
  return String(result.lines[0].priceId);
}

async function currentPrice(model: string): Promise<string | null> {
  const { rows } = await admin.query<{ id: string | null }>(
    "select ops.current_model_price('fake', $1, now()) as id",
    [model],
  );
  return rows[0].id;
}

const statusesOf = (
  lines: readonly Record<string, unknown>[],
  models: readonly string[],
) =>
  lines
    .filter((line) => models.includes(String(line.model)))
    .map((line) => [line.id, line.model, line.status]);

describe("the price versions the operator lists", () => {
  // What the unit tests cannot prove: the statuses the DATABASE computes, for
  // one version of each, and a real start agreeing with them.
  it("are current, future, expired and superseded as the database computes them, hide the superseded ones without --all, and never fall back to an older version of an expired model", async () => {
    const [live, lapsed] = ["dbtest-catalog-live", "dbtest-catalog-lapsed"];
    const superseded = await recordThroughTool(live, -3 * DAY, 300 * DAY);
    const current = await recordThroughTool(live, -DAY, 300 * DAY);
    const future = await recordThroughTool(live, 2 * DAY, 100 * DAY);
    const olderUnexpired = await recordThroughTool(
      lapsed,
      -20 * DAY,
      300 * DAY,
    );
    const expired = await recordThroughTool(lapsed, -10 * DAY, -DAY);

    const listed = await runOps(["prices"]);
    const all = await runOps(["prices", "--all"]);

    expect(statusesOf(listed.lines, [live, lapsed])).toEqual([
      [expired, lapsed, "expired"],
      [future, live, "future"],
      [current, live, "current"],
    ]);
    expect(statusesOf(all.lines, [live, lapsed])).toEqual([
      [expired, lapsed, "expired"],
      [olderUnexpired, lapsed, "superseded"],
      [future, live, "future"],
      [current, live, "current"],
      [superseded, live, "superseded"],
    ]);
    expect(all.lines.find((line) => line.id === current)).toMatchObject({
      provider: "fake",
      inputUsdPerMtok: "1.000000",
      cachedInputUsdPerMtok: null,
      outputUsdPerMtok: "3.000000",
      reasoningInOutput: true,
      effectiveFrom: expect.stringMatching(ISO_UTC),
      source: "dbtest catalog price sheet",
      recordedBy: ACTOR,
    });
    expect(await currentPrice(live)).toBe(current);
    expect(await currentPrice(lapsed)).toBeNull();

    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-lapsed");
    const [runId] = await requestRuns(owner, office, ["catalog-lapsed"]);
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const result = await runOneJob(db, {
      workerId: WORKER,
      registry: governedRuntime(provider, lapsed).registry,
    });

    expect(result).toMatchObject({
      outcome: "succeeded",
      detail: `agent_run=${runId} status=cancelled`,
    });
    expect(await readRunCost(admin, runId)).toMatchObject({
      status: "cancelled",
      errorCategory: "refused",
      errorCode: "price_unavailable",
      priceId: null,
      charged: null,
    });
    expect(provider.calls).toHaveLength(0);
  }, 30_000);

  // What the unit tests cannot prove: that the listing and a start made in a
  // separate, later transaction agree on the version, across a new version
  // taking effect in between.
  it("name as current exactly the version the next real start records, before and after a newer version takes effect", async () => {
    const model = "fake-model-1";
    const first = governance.priceIds[model];
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-prices");
    const [before, after] = await requestRuns(owner, office, [
      "catalog-before",
      "catalog-after",
    ]);
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const { registry } = governedRuntime(provider, model);
    const currentOf = (rows: readonly ModelPriceRow[]) =>
      rows
        .filter((row) => row.model === model && row.status === "current")
        .map((row) => row.id);

    const listedFirst = await owner.withTransaction((tx) =>
      listModelPrices(tx),
    );
    await runOneJob(db, { workerId: WORKER, registry });
    const newer = await recordPrice(admin, model, {
      effectiveFrom: "-1 minute",
      expiresAt: "1 day",
      inputUsdPerMtok: "1",
      outputUsdPerMtok: "3",
    });
    const listedNext = await owner.withTransaction((tx) => listModelPrices(tx));
    const history = await owner.withTransaction((tx) =>
      listModelPrices(tx, { includeHistory: true }),
    );
    await runOneJob(db, { workerId: WORKER, registry });

    expect(currentOf(listedFirst)).toEqual([first]);
    expect(await readRunCost(admin, before)).toMatchObject({
      status: "succeeded",
      priceId: first,
      charged: 90n,
    });
    expect(currentOf(listedNext)).toEqual([newer]);
    expect(listedNext.map((row) => row.id)).not.toContain(first);
    expect(history.find((row) => row.id === first)?.status).toBe("superseded");
    // 120 input tokens at 1 USD and 60 output tokens at 3 USD per million.
    expect(await readRunCost(admin, after)).toMatchObject({
      status: "succeeded",
      priceId: newer,
      estimated: 300n,
      charged: 300n,
    });
    expect(provider.calls).toHaveLength(2);
  }, 30_000);
});

describe("the limits the operator lists", () => {
  // What the unit tests cannot prove: the listing's filter and order over real
  // versions, and the history of each ending as the database recorded it.
  it("list the versions in force by default, and with --all every version, ended ones after active ones, with who ended each and why", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-limits");
    const set = async (flags: readonly string[]) => {
      const result = await runOps([
        ...["limit", "set", ...flags],
        ...["--reason", "dbtest catalog limit", "--actor", ACTOR],
      ]);
      expect(result, result.stderr.join("\n")).toMatchObject({ code: 0 });
      return String(result.lines[0].limitId);
    };
    const company = ["--tenant", TENANT_A, "--company", office.companyId];
    const tenant = await set([
      ...["--scope", "tenant", "--tenant", TENANT_A],
      ...["--daily-usd", "75", "--timezone", "UTC"],
    ]);
    const retiredCompany = await set([
      ...["--scope", "company", ...company],
      ...["--daily-usd", "5", "--timezone", "America/Sao_Paulo"],
    ]);
    await runOps([
      ...["limit", "retire", "--id", retiredCompany],
      ...["--reason", "dbtest catalog retire", "--actor", ACTOR],
    ]);
    const activeCompany = await set([
      ...["--scope", "company", ...company],
      ...["--daily-usd", "5", "--timezone", "UTC"],
    ]);
    const ours = [
      governance.globalLimitId,
      governance.tenantLimitIds[TENANT_A],
      governance.tenantLimitIds[TENANT_B],
      tenant,
      retiredCompany,
      activeCompany,
    ];
    const pick = (lines: readonly Record<string, unknown>[]) =>
      lines
        .filter((line) => ours.includes(String(line.id)))
        .map((line) => line.id);

    const listed = await runOps(["limits"]);
    const all = await runOps(["limits", "--all"]);

    expect(pick(listed.lines)).toEqual([
      governance.globalLimitId,
      tenant,
      governance.tenantLimitIds[TENANT_B],
      activeCompany,
    ]);
    expect(pick(all.lines)).toEqual([
      governance.globalLimitId,
      tenant,
      governance.tenantLimitIds[TENANT_B],
      activeCompany,
      governance.tenantLimitIds[TENANT_A],
      retiredCompany,
    ]);
    const byId = new Map(all.lines.map((line) => [line.id, line]));
    expect(byId.get(tenant)).toMatchObject({
      scope: "tenant",
      tenantId: TENANT_A,
      companyId: null,
      dailyLimitMicros: "75000000",
      dailyLimitUsd: "75.000000",
      timezone: "UTC",
      reason: "dbtest catalog limit",
      setBy: ACTOR,
      setAt: expect.stringMatching(ISO_UTC),
      endedAt: null,
    });
    expect(byId.get(governance.tenantLimitIds[TENANT_A])).toMatchObject({
      endedBy: ACTOR,
      endReason: "superseded",
      endedAt: expect.stringMatching(ISO_UTC),
    });
    expect(byId.get(retiredCompany)).toMatchObject({
      scope: "company",
      companyId: office.companyId,
      timezone: "America/Sao_Paulo",
      endedBy: ACTOR,
      endReason: "dbtest catalog retire",
    });
  }, 30_000);
});
