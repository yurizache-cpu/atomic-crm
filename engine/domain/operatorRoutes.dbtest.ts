// `npm run ops -- routes` (ADR 0017 §5, §9) against a real Postgres: what a live
// worker published into its heartbeat, and what the database says about each
// published route.
//
// engine/domain/runtimeReadModelRoutes.test.ts parses canned rows. What only the
// real database shows:
//
//   * a detail written by the real worker loop (runWorker's startDetail, built
//     with formatWorkerDetail from a real router) read back through the real
//     heartbeat table;
//   * each route's price coverage, the database's own output ceiling, and the
//     smallest and largest reservation its current price allows, checked by
//     hand: the smallest is an empty context plus the 8192-token allowance, and
//     the largest implies an input ceiling that counts every text field at its
//     bound as JSON-escaped bytes, with the agent's name and role counted twice;
//   * real runs on that route reserving within those figures, the one with
//     every text field at its bound within a few bytes of the largest;
//   * a detail naming a key-shaped model, and a key-shaped worker id, withheld
//     from the output of the real read.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime, the CLIs and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { formatWorkerDetail, summarizeRoutes } from "../models/routeSummary.ts";
import { createModelRouter, MODEL_ROUTE_POLICIES } from "../models/router.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { runWorker } from "../worker/runWorker.ts";
import {
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import { readRunCost, recordPrice } from "../worker/testSupport/spendProbes.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "./companyOs.ts";
import { VALID } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  GOVERNANCE_SOURCE,
  governedRuntime,
  openGovernanceDatabases,
  requestRuns,
  type GovernedOffice,
} from "./testSupport/governanceRuntime.ts";
import { leaks, newTranscript, runOps } from "./testSupport/ownerCli.ts";

const PUBLISHER = "dbtest-operator-routes";
const PRICED = "dbtest-route-priced";
const UNPRICED = "dbtest-route-unpriced";
/** A provider key's shape, built so that no key-shaped literal is committed. */
const KEY_PREFIX = "s" + "k-";
const KEY_SHAPED_MODEL = `${KEY_PREFIX}dbtestnotakey0123456789abcdef`;
const KEY_SHAPED_WORKER = `dbtest-${KEY_PREFIX}dbtestworker0123`;
const MODEL_WORKER = "dbtest-operator-routes-keyed";

/** ops.agent_run_input_token_ceiling of an empty context: '{}' plus the allowance. */
const EMPTY_CONTEXT_CEILING = 2 + 8192;
/**
 * Every text field of the worst-case context at its CHECK bound, of a character
 * JSON escapes to six bytes (\u0001): title 300, task description 10000, agent
 * name 200, role 200 and description 2000. Then the name and role again, as
 * quoted JSON, a 100-byte type, a four-digit priority and the allowance. The
 * rest is keys, quotes, separators and a timestamp: under 400 bytes.
 */
const WORST_CASE_CEILING_FLOOR =
  (300 + 10_000 + 200 + 200 + 2000) * 6 + (200 * 6 + 2) * 2 + 100 + 4 + 8192;
const FRAMING_BOUND = 400;

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

/** Every text field at its CHECK bound, all of it escaped to six bytes. */
function buildWorstCaseOffice(): Promise<GovernedOffice> {
  const escaped = (length: number) => "\u0001".repeat(length);
  return owner.withTransaction(async (tx) => {
    const ctx = { tenantId: TENANT_A, source: GOVERNANCE_SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-worst-case",
      name: "Office",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "operations",
      name: "Operations",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "office-assistant",
      name: escaped(200),
      role: escaped(200),
      description: escaped(2000),
    });
    const taskId = await createTask(tx, ctx, {
      companyId,
      departmentId,
      type: "a".repeat(100),
      title: escaped(300),
      description: escaped(10_000),
      priority: 1000,
      dueAt: new Date("2026-09-21T12:00:00Z"),
    });
    await assignTask(tx, ctx, taskId, agentId);
    return { tenantId: TENANT_A, companyId, departmentId, agentId, taskId };
  });
}

async function publishKeyShapedDetails(): Promise<void> {
  const detail = formatWorkerDetail("running", [
    {
      route: "standard",
      provider: "fake",
      model: KEY_SHAPED_MODEL,
      maxOutputTokens: MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
      timeoutMs: MODEL_ROUTE_POLICIES.standard.timeoutMs,
    },
  ]);
  await db.withTransaction(async (tx) => {
    await tx.query("set local role ops_worker");
    for (const workerId of [MODEL_WORKER, KEY_SHAPED_WORKER]) {
      await tx.query("select ops.worker_heartbeat($1, $2)", [
        workerId,
        workerId === MODEL_WORKER ? detail : "started",
      ]);
    }
  });
}

describe("the routes a recently seen worker published", () => {
  // What the unit tests cannot prove: the whole path from a real router to the
  // heartbeat table to the operator's read, priced by the database.
  it("are reported with their price coverage, the database's output ceiling, and the smallest and largest reservation their current price allows, which real runs on the route stay within", async () => {
    // 2 USD per million input tokens and 8 per million output tokens.
    const priceId = await recordPrice(admin, PRICED, {
      effectiveFrom: "-1 hour",
      expiresAt: "1 day",
      inputUsdPerMtok: "2",
      outputUsdPerMtok: "8",
    });
    const provider = createFakeModelProvider({
      type: "respond",
      content: VALID,
    });
    const router = createModelRouter({
      routes: new Map([
        ["economy", { provider: "fake", model: UNPRICED }],
        ["standard", { provider: "fake", model: PRICED }],
        ["reasoning", { provider: "fake", model: "fake-model-1" }],
      ]),
      providers: new Map([["fake", provider]]),
    });
    const stats = await runWorker({
      workerId: PUBLISHER,
      db,
      registry: createHandlerRegistry({ modelRouter: router }),
      maxIterations: 0,
      startDetail: formatWorkerDetail("running", summarizeRoutes(router)),
    });
    expect(stats.leased).toBe(0);
    await publishKeyShapedDetails();
    const transcript = newTranscript();

    const result = await runOps(["routes"], { transcript });

    expect(result).toMatchObject({ code: 0, stderr: [] });
    const published = result.lines.find((row) => row.workerId === PUBLISHER);
    expect(published).toMatchObject({
      detail: "published",
      state: "running",
      stoppedAt: expect.any(String),
    });
    const routes = new Map(
      (published?.routes as Record<string, unknown>[]).map((route) => [
        route.route,
        route,
      ]),
    );
    expect([...routes.keys()]).toEqual(["economy", "standard", "reasoning"]);
    expect(routes.get("economy")).toEqual({
      route: "economy",
      provider: "fake",
      model: UNPRICED,
      maxOutputTokens: 2000,
      timeoutMs: MODEL_ROUTE_POLICIES.economy.timeoutMs,
      priceId: null,
      priced: false,
      databaseMaxOutputTokens: 2000,
      matchesDatabase: true,
      smallestReservationMicros: null,
      largestReservationMicros: null,
      smallestReservationUsd: null,
      largestReservationUsd: null,
    });
    const standard = routes.get("standard") as Record<string, unknown>;
    expect(standard).toMatchObject({
      model: PRICED,
      priceId,
      priced: true,
      databaseMaxOutputTokens: 8000,
      matchesDatabase: true,
      smallestReservationMicros: String(EMPTY_CONTEXT_CEILING * 2 + 8000 * 8),
      smallestReservationUsd: "0.080388",
    });
    const largest = Number(standard.largestReservationMicros);
    const worstCaseCeiling = (largest - 8000 * 8) / 2;
    expect(Number.isInteger(worstCaseCeiling)).toBe(true);
    expect(worstCaseCeiling).toBeGreaterThanOrEqual(WORST_CASE_CEILING_FLOOR);
    expect(worstCaseCeiling).toBeLessThan(
      WORST_CASE_CEILING_FLOOR + FRAMING_BOUND,
    );
    // The fixture's 0.5 USD per million, on the same worst-case context.
    expect(routes.get("reasoning")).toMatchObject({
      priceId: governance.priceIds["fake-model-1"],
      databaseMaxOutputTokens: 25_000,
      smallestReservationMicros: String(
        Math.ceil(EMPTY_CONTEXT_CEILING / 2) + 12_500,
      ),
      largestReservationMicros: String(
        Math.ceil(worstCaseCeiling / 2) + 12_500,
      ),
    });

    expect(
      result.lines.find((row) => row.workerId === MODEL_WORKER),
    ).toMatchObject({ detail: "withheld", routes: null, state: null });
    expect(result.lines.map((row) => row.workerId)).toContain("[withheld]");
    expect(leaks(transcript, [KEY_SHAPED_MODEL, KEY_SHAPED_WORKER])).toEqual(
      [],
    );

    const plain = await buildGovernedOffice(owner, TENANT_A, "dbtest-plain");
    const worst = await buildWorstCaseOffice();
    const [plainRun] = await requestRuns(owner, plain, ["routes-plain"]);
    const [worstRun] = await requestRuns(owner, worst, ["routes-worst"]);
    const { registry } = governedRuntime(provider, PRICED);
    for (let pass = 0; pass < 2; pass += 1) {
      await runOneJob(db, { workerId: PUBLISHER, registry });
    }
    const plainCost = await readRunCost(admin, plainRun);
    const worstCost = await readRunCost(admin, worstRun);

    expect(plainCost).toMatchObject({ status: "succeeded", priceId });
    expect(worstCost).toMatchObject({ status: "succeeded", priceId });
    const smallest = BigInt(String(standard.smallestReservationMicros));
    expect(plainCost.reserved).toBeGreaterThan(smallest);
    expect(plainCost.reserved).toBeLessThan(BigInt(largest));
    // Only the due date's text differs from the worst case: a few bytes, each
    // bounding one input token at 2 micro-USD.
    const shortfall = BigInt(largest) - (worstCost.reserved as bigint);
    expect(shortfall).toBeGreaterThanOrEqual(0n);
    expect(shortfall).toBeLessThanOrEqual(32n);
    expect(provider.calls).toHaveLength(2);
  }, 60_000);
});
