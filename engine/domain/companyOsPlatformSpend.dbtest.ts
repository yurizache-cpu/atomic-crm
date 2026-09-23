// The platform-derived differential (brief §9 item 2, §14 item 1, §16
// "Identity and tenancy"; OD-7), against a real Postgres through the real `pg`
// driver, the real worker runtime and the real spend ceiling sweep.
//
// A tenant member sees tenant-scoped data only. Platform state reaches them as
// ONE derived boolean, `platform.globalAdmissionBlocked`, and as the effects a
// platform stop or the global ceiling has on the tenant's own rows (a queued
// run held, the counts that follow), never as a platform id, amount, reason,
// actor or time. supabase/tests/company_os_api.sql can plant a platform stop;
// what it cannot do is what this file does: settle real charged spend in
// tenant B, put a global ceiling below the day's settled spend, and let the
// real ops.enforce_spend_ceiling (as the worker's tick calls it) trip
// system:spend_ceiling. Then tenant A's member reads every catalogued function
// before and after, and the file proves:
//
//   * A's outputs change only at the pinned platform-derived paths, and do
//     change there (the boolean, the queued run now held, the two counts);
//   * no id, amount or reason of B, of the ceiling or of the stop appears: B
//     gets its own budget and its own charge, distinct from A's, so that B's
//     spend row would read as B's, and A's spend summary carries exactly one
//     tenant row, A's;
//   * a second platform stop (an all-tenant job_kind stop) changes nothing A
//     can see.
//
// The ceiling and the stops are global while the case runs, so the case puts
// the fixture's governance back and removes its stops before it ends. It lives
// in engine/domain because only there may a test import the domain services,
// the worker runtime and the database fixture together (eslint.config.js). All
// data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../handlers/agentRunExecute.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import type { ModelUsage } from "../models/types.ts";
import {
  configureGovernance,
  deleteFixtureStops,
  FIXTURE_TENANT_LIMIT_MICROS,
  resetFixtures,
  TENANT_A,
  TENANT_B,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import {
  activeSystemStops,
  quietSpend,
  readRunCost,
  setDailyLimit,
} from "../worker/testSupport/spendProbes.ts";
import { tripExecutionStop } from "./executionStops.ts";
import { VALID } from "./testSupport/agentRuntimeProbes.ts";
import {
  readAsMember,
  type CompanyOsRead,
} from "./testSupport/companyOsMember.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  requestRuns,
  type GovernedOffice,
} from "./testSupport/governanceRuntime.ts";

const WORKER = "dbtest-cos-platform";
const PLATFORM_STOP = Object.freeze({
  reason: "dbtest cos platform stop",
  actor: "dbtest",
});

/**
 * Tenant B's own budget and its call's usage, both unlike A's: were B's spend
 * row or B's charge to reach A, it would read as B's, not as a copy of A's.
 */
const B_BUDGET_MICROS = 123_456_789_012n;
const B_USAGE: ModelUsage = Object.freeze({
  inputTokens: 1_357,
  outputTokens: 246,
  totalTokens: 1_603,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});

/**
 * The pinned platform-derived set (brief §9 item 2), as paths of the flattened
 * outputs below. Anything else that changes is a platform leak.
 */
const PLATFORM_DERIVED: readonly RegExp[] = Object.freeze([
  /^(overview|spend_summary)\.platform\.globalAdmissionBlocked$/,
  /^overview\.agents\.(held|queued)$/,
  /^overview\.(runs|outbound)\.todayByStatus\./,
  /^(list_agents\.items\[\d+\]|get_agent\.agent)\.activity$/,
  /^(list_agents\.items\[\d+\]|get_agent\.agent)\.evidence\.(heldRunIds|queuedRunIds)(\.length|\[\d+\])$/,
  // The tenant's own runs' outcome, where a worker settles one under a stop.
  /^(list_runs\.items\[\d+\]|get_run [a-z]+|get_agent\.recentRuns\[\d+\]|get_task\.runs\[\d+\])\.(status|errorCategory|errorCode)$/,
  /^(list_tasks\.items\[\d+\]|get_task)\.pipeline\.latestRun\.status$/,
  /^get_run [a-z]+\.job\.(status|availableAt)$/,
  /^get_run [a-z]+\.jobSteps(\.length|\[\d+\]\.)/,
]);

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

type Reads = ReadonlyArray<
  readonly [string, CompanyOsRead, Readonly<Record<string, unknown>>]
>;

/** Every catalogued read, with every selector of tenant A's office. */
const readsOf = (
  office: GovernedOffice,
  settled: string,
  queued: string,
): Reads => [
  ["operator_context", "operator_context", {}],
  ["overview", "overview", {}],
  ["list_agents", "list_agents", {}],
  ["get_agent", "get_agent", { p_agent_id: office.agentId }],
  ["list_tasks", "list_tasks", {}],
  ["get_task", "get_task", { p_task_id: office.taskId }],
  ["list_runs", "list_runs", {}],
  ["get_run settled", "get_run", { p_run_id: settled }],
  ["get_run queued", "get_run", { p_run_id: queued }],
  ["list_reviews", "list_reviews", {}],
  ["list_events", "list_events", {}],
  ["list_stops", "list_stops", { p_include_cleared: true }],
  ["spend_summary", "spend_summary", {}],
  ["communication_status", "communication_status", {}],
];

/** Tenant A's outputs, keyed by read, as a member reads them now. */
const snapshot = (reads: Reads) =>
  readAsMember(owner, TENANT_A, async (member) => {
    const out: Record<string, { text: string; value: unknown }> = {};
    for (const [label, fn, args] of reads) {
      const { text, value } = await member.read(fn, args);
      out[label] = { text, value };
    }
    return out;
  });

/**
 * Leaf paths to values, without the read's own instants (`asOf`,
 * `serverTime`) and without the principal id, which is new in every
 * rolled-back read session.
 */
function flatten(value: unknown, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    out.set(`${path}.length`, String(value.length));
    value.forEach((item, i) => flatten(item, `${path}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "asOf" || key === "serverTime") continue;
      if (path === "operator_context.principal" && key === "id") continue;
      flatten(inner, `${path}.${key}`, out);
    }
  } else {
    out.set(path, JSON.stringify(value));
  }
}

function changedPaths(
  before: Record<string, { value: unknown }>,
  after: Record<string, { value: unknown }>,
): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  for (const [label, { value }] of Object.entries(before))
    flatten(value, label, a);
  for (const [label, { value }] of Object.entries(after))
    flatten(value, label, b);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((path) => a.get(path) !== b.get(path))
    .sort();
}

/** Micros as the projections render USD (ops.cos_money): six decimals. */
const usd = (micros: bigint): string =>
  `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;

const valueAt = (
  outputs: Record<string, { value: unknown }>,
  label: string,
  path: readonly string[],
): unknown =>
  path.reduce<unknown>(
    (node, key) => (node as Record<string, unknown> | null)?.[key],
    outputs[label]?.value,
  );

/** The tenant-scope rows of a spend_summary answer. */
const tenantScopeRows = (
  outputs: Record<string, { value: unknown }>,
): unknown[] =>
  (
    valueAt(outputs, "spend_summary", ["tenantRows"]) as { scope: string }[]
  ).filter((row) => row.scope === "tenant");

describe("tenant A's reads while tenant B's settled spend exhausts the global ceiling", () => {
  // What the SQL suite cannot prove: real charged spend, settled by the real
  // runtime, a ceiling version below it, and the real sweep tripping the
  // system stop that then holds A's own queued work.
  it("change only at the pinned platform-derived paths, carry nothing of B, the ceiling or the stop, and do not change again for a second platform stop", async () => {
    const officeA = await buildGovernedOffice(
      owner,
      TENANT_A,
      "dbtest-cos-spend-a",
    );
    const officeB = await buildGovernedOffice(
      owner,
      TENANT_B,
      "dbtest-cos-spend-b",
    );
    const bBudgetId = await setDailyLimit(
      admin,
      "tenant",
      B_BUDGET_MICROS,
      TENANT_B,
    );
    // Call 0 is A's settled run, call 1 is B's: each is requested and settled
    // before the next is requested.
    const provider = createFakeModelProvider((_request, index) => ({
      type: "respond",
      content: VALID,
      ...(index === 1 ? { usage: B_USAGE } : {}),
    }));
    const { registry } = governedRuntime(provider);
    const settleHead = async () =>
      expect(
        (await runOneJob(db, { workerId: WORKER, registry })).outcome,
      ).toBe("succeeded");

    const [aSettled] = await requestRuns(owner, officeA, [
      "dbtest-cos-a-settled",
    ]);
    await settleHead();
    const [bSettled] = await requestRuns(owner, officeB, [
      "dbtest-cos-b-settled",
    ]);
    await settleHead();
    const [aQueued] = await requestRuns(owner, officeA, [
      "dbtest-cos-a-queued",
    ]);
    const bCost = await readRunCost(admin, bSettled);
    expect(bCost.status).toBe("succeeded");
    const bCharged = bCost.charged ?? 0n;
    expect(bCharged).toBeGreaterThan(1n);
    const aCost = await readRunCost(admin, aSettled);
    expect(aCost.status).toBe("succeeded");
    const aCharged = aCost.charged ?? 0n;
    expect(aCharged).toBeGreaterThan(0n);
    expect(bCharged).not.toBe(aCharged);
    expect((await readRunCost(admin, aQueued)).status).toBe("pending");

    const reads = readsOf(officeA, aSettled, aQueued);
    const before = await snapshot(reads);
    expect(
      valueAt(before, "overview", ["platform", "globalAdmissionBlocked"]),
    ).toBe(false);
    expect(valueAt(before, "get_agent", ["agent", "activity"])).toBe("queued");
    // A's own tenant row, and no other tenant's: B's would carry B's budget.
    const aTenantRow = expect.objectContaining({
      dailyLimit: {
        micros: FIXTURE_TENANT_LIMIT_MICROS,
        usd: usd(BigInt(FIXTURE_TENANT_LIMIT_MICROS)),
      },
      charged: { micros: String(aCharged), usd: usd(aCharged) },
    });
    expect(tenantScopeRows(before)).toEqual([aTenantRow]);

    try {
      // A ceiling version below the day's settled spend, which B's charge
      // pushes past it: without B, A's spend alone would fit.
      const settled = await quietSpend(admin, "global");
      const ceiling = settled - 1n;
      expect(settled - bCharged).toBeLessThan(ceiling);
      const ceilingId = await setDailyLimit(admin, "global", ceiling);
      const stopId = await db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ stop_id: string | null }>(
          "select ops.enforce_spend_ceiling() as stop_id",
        );
        return rows[0]?.stop_id ?? null;
      });
      expect(stopId).toEqual(expect.any(String));
      expect(await activeSystemStops(admin)).toEqual([
        expect.objectContaining({
          id: stopId,
          trippedBy: "system:spend_ceiling",
        }),
      ]);

      const after = await snapshot(reads);
      const changed = changedPaths(before, after);

      expect(
        changed.filter((path) => !PLATFORM_DERIVED.some((re) => re.test(path))),
      ).toEqual([]);
      for (const label of ["overview", "spend_summary"]) {
        expect(
          valueAt(after, label, ["platform", "globalAdmissionBlocked"]),
        ).toBe(true);
      }
      expect(valueAt(after, "get_agent", ["agent", "activity"])).toBe("held");
      expect(valueAt(after, "get_agent", ["agent", "evidence"])).toMatchObject({
        heldRunIds: [aQueued],
        queuedRunIds: [],
        stop: null,
      });
      expect(valueAt(after, "overview", ["agents"])).toMatchObject({
        held: 1,
        queued: 0,
        stopped: 0,
      });
      expect(valueAt(after, "get_run queued", ["coveringStop"])).toBeNull();
      expect(tenantScopeRows(after)).toEqual([aTenantRow]);
      expect(changed).toEqual(
        expect.arrayContaining([
          "overview.platform.globalAdmissionBlocked",
          "spend_summary.platform.globalAdmissionBlocked",
          "overview.agents.held",
          "overview.agents.queued",
          "get_agent.agent.activity",
        ]),
      );

      // Nothing of B, of the ceiling or of the stop, by id or by amount.
      const text = Object.values(after)
        .map((output) => output.text)
        .join("\n");
      for (const secret of [
        TENANT_B,
        "DB test tenant B",
        officeB.companyId,
        officeB.departmentId,
        officeB.agentId,
        officeB.taskId,
        bSettled,
        governance.tenantLimitIds[TENANT_B],
        bBudgetId,
        governance.globalLimitId,
        stopId as string,
        ceilingId,
        ...[
          ceiling,
          settled,
          B_BUDGET_MICROS,
          bCharged,
          B_BUDGET_MICROS - bCharged,
        ].flatMap((micros) => [`"${micros}"`, `"${usd(micros)}"`]),
      ]) {
        expect(text).not.toContain(secret);
      }
      // Positive control: A's own charge is there, in both renderings.
      expect(text).toContain(`"${aCharged}"`);
      expect(text).toContain(`"${usd(aCharged)}"`);

      // A second platform stop covers what is already held: A sees nothing new.
      await owner.withTransaction((tx) =>
        tripExecutionStop(
          tx,
          { scope: "job_kind", jobKind: AGENT_RUN_EXECUTE_KIND },
          PLATFORM_STOP,
        ),
      );
      const again = await snapshot(reads);
      expect(changedPaths(after, again)).toEqual([]);
      expect(
        Object.values(again)
          .map((o) => o.text)
          .join("\n"),
      ).not.toContain(PLATFORM_STOP.reason);
    } finally {
      // Global state: put the fixture's ceiling back and remove both stops now,
      // not at the end of the file.
      await deleteFixtureStops(admin);
      await configureGovernance(admin);
    }
  }, 60_000);
});
