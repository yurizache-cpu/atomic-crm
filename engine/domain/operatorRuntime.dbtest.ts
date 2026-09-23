// The owner's operator CLI (ADR 0017 §9) against a real Postgres: its price and
// spend-limit acts and its reads after real runs. The rest of SI-39's act
// allowlist is proven elsewhere: the services behind triage accept, reject,
// needs-edit and recover in leadTriagePilot.dbtest.ts and
// leadTriageSettlement.dbtest.ts, and membership grant and revoke, through this
// CLI, in memberships.dbtest.ts. Its print rule has one exception,
// `triage show`, which prints the stored proposal, reply draft included, of the
// one review item it names; the membership commands never print an email, an
// email hash, an auth token or privileged connection information.
//
// engine/cli/operator.test.ts sees only the SQL the tool sends to a fake
// database, and supabase/tests/runtime_governance.sql never runs the tool. What
// only the real database shows:
//
//   * that each act's printed id is the row the database then holds, with the
//     exact amount, zone and actor, and that a replay or a refusal prints what
//     the database decided;
//   * that `status`, `spend`, `runs` and `indeterminate` report real runs (one
//     succeeded, one indeterminate, one with its call in flight) as the database
//     accounts them, with `settledExhausted` on settled spend only (ADR 0017 §5)
//     and `newRunAdmission` blocked whenever charged spend has reached a limit, so
//     a budget that is not settled-exhausted never reads as room to start;
//   * that nothing printed carries task or agent text, a result, an idempotency
//     key or a piece of the connection string.
//
// The read-only transaction is proven in operatorReadOnly.dbtest.ts; prices,
// limit history and routes in operatorCatalog.dbtest.ts. It lives
// in engine/domain because only there may a test import the domain services,
// the worker runtime, the CLIs and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import { createGatedModelProvider } from "../worker/testSupport/gatedModelProvider.ts";
import { readRunCost } from "../worker/testSupport/spendProbes.ts";
import { tripExecutionStop } from "./executionStops.ts";
import { formatMicrosAsUsd } from "./money.ts";
import {
  AGENT_SENTINEL,
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  registryServing,
  TASK_SENTINEL,
  VALID,
  withinMs,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  connectionPieces,
  leaks,
  newTranscript,
  runOps,
} from "./testSupport/ownerCli.ts";

const WORKER = "dbtest-operator-runtime";
const ACTOR = "dbtest-operator";
/** Keys distinctive enough that finding one in output cannot be a coincidence. */
const RUN_KEYS = Object.freeze({
  succeeded: "dbtest-opkey-succeeded-5b7e",
  indeterminate: "dbtest-opkey-indeterminate-c02d",
  inFlight: "dbtest-opkey-inflight-91fa",
  held: "dbtest-opkey-held-4d18",
});
/** 120 input and 60 output tokens at the fixture's 0.5 USD per million each. */
const FAKE_USAGE_COST_MICROS = 90n;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let governance: FixtureGovernance;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

beforeEach(async () => {
  governance = await resetFixtures(admin);
});

const probes = agentRuntimeProbes(() => ({ admin, owner, db }));

const isoFromNow = (ms: number): string =>
  new Date(Date.now() + ms).toISOString();

const limitSet = (flags: readonly string[], reason = "dbtest operator limit") =>
  runOps(["limit", "set", ...flags, "--reason", reason, "--actor", ACTOR]);

async function activeLimit(scope: string, tenantId: string | null) {
  const { rows } = await admin.query<{
    id: string;
    daily_limit_micros: string;
    timezone: string;
    set_by: string;
  }>(
    `select id, daily_limit_micros::text, timezone, set_by from ops.spend_limits
      where scope = $1 and tenant_id is not distinct from $2::uuid and ended_at is null`,
    [scope, tenantId],
  );
  return rows;
}

async function limitEnding(limitId: string) {
  const { rows } = await admin.query<{
    ended_by: string | null;
    end_reason: string | null;
    ended: boolean;
  }>(
    "select ended_by, end_reason, ended_at is not null as ended from ops.spend_limits where id = $1",
    [limitId],
  );
  return rows[0];
}

describe("the operator's acts on the real database", () => {
  // What neither the CLI's unit tests nor the SQL suite can prove: the tool's
  // printed answer and the row the database holds are the same thing.
  it("records a price version and prints the same id for its replay, refuses a different version at that moment, and stores the exact rates it was given", async () => {
    const model = "dbtest-operator-model";
    const from = isoFromNow(-60_000);
    const until = isoFromNow(30 * 86_400_000);
    const price = (inputRate: string) =>
      runOps([
        "price",
        "record",
        "--provider",
        "fake",
        "--model",
        model,
        "--input-usd-per-mtok",
        inputRate,
        "--cached-input-usd-per-mtok",
        "0.25",
        "--output-usd-per-mtok",
        "4.5",
        "--reasoning-in-output",
        "no",
        "--effective-from",
        from,
        "--expires-at",
        until,
        "--source",
        "dbtest operator price sheet",
        "--actor",
        ACTOR,
      ]);

    const recorded = await price("1.25");
    const replayed = await price("1.250000");
    const conflicting = await price("1.5");

    expect(recorded).toMatchObject({ code: 0, stderr: [] });
    expect(recorded.lines).toEqual([
      { result: "recorded", priceId: expect.any(String) },
    ]);
    expect(replayed.lines).toEqual(recorded.lines);
    expect(conflicting).toMatchObject({ code: 1, stdout: [] });
    expect(JSON.parse(conflicting.stderr[0])).toMatchObject({
      error: "invalid_state",
    });
    const { rows } = await admin.query(
      `select id, input_usd_per_mtok::text as input, cached_input_usd_per_mtok::text as cached,
              output_usd_per_mtok::text as output, reasoning_in_output,
              effective_from = $2::timestamptz as from_matches,
              expires_at = $3::timestamptz as until_matches, source, recorded_by
         from ops.model_prices where provider = 'fake' and model = $1`,
      [model, from, until],
    );
    expect(rows).toEqual([
      {
        id: recorded.lines[0].priceId,
        input: "1.250000",
        cached: "0.250000",
        output: "4.500000",
        reasoning_in_output: false,
        from_matches: true,
        until_matches: true,
        source: "dbtest operator price sheet",
        recorded_by: ACTOR,
      },
    ]);
  }, 30_000);

  it("sets global, tenant and company limits that supersede the ones in force, keeps a company's zone until its limit is retired, and retires it once", async () => {
    const office = await probes.buildOfficeTask(TENANT_A);
    const company = ["--tenant", TENANT_A, "--company", office.companyId];

    const global = await limitSet([
      ...["--scope", "global", "--daily-usd", "2500000", "--timezone", "UTC"],
    ]);
    const globalAgain = await limitSet([
      ...["--scope", "global", "--daily-usd", "2500000.000000"],
      ...["--timezone", "UTC"],
    ]);
    const tenant = await limitSet([
      ...["--scope", "tenant", "--tenant", TENANT_A],
      ...["--daily-usd", "50000.5", "--timezone", "UTC"],
    ]);
    const companyFirst = await limitSet([
      ...["--scope", "company", ...company],
      ...["--daily-usd", "12.345678", "--timezone", "America/Sao_Paulo"],
    ]);
    const zoneChange = await limitSet([
      ...["--scope", "company", ...company],
      ...["--daily-usd", "7.5", "--timezone", "UTC"],
    ]);

    expect(global.lines).toEqual([
      { result: "set", limitId: expect.any(String), scope: "global" },
    ]);
    expect(globalAgain.lines).toEqual(global.lines);
    expect(tenant.lines).toEqual([
      { result: "set", limitId: expect.any(String), scope: "tenant" },
    ]);
    expect(companyFirst.lines).toEqual([
      { result: "set", limitId: expect.any(String), scope: "company" },
    ]);
    expect(zoneChange).toMatchObject({ code: 1, stdout: [] });
    expect(JSON.parse(zoneChange.stderr[0])).toMatchObject({
      error: "invalid_state",
    });
    expect(await activeLimit("global", null)).toEqual([
      {
        id: global.lines[0].limitId,
        daily_limit_micros: "2500000000000",
        timezone: "UTC",
        set_by: ACTOR,
      },
    ]);
    expect(await activeLimit("tenant", TENANT_A)).toEqual([
      {
        id: tenant.lines[0].limitId,
        daily_limit_micros: "50000500000",
        timezone: "UTC",
        set_by: ACTOR,
      },
    ]);
    expect(await limitEnding(governance.globalLimitId)).toEqual({
      ended_by: ACTOR,
      end_reason: "superseded",
      ended: true,
    });

    const companyLimit = String(companyFirst.lines[0].limitId);
    const retire = () =>
      runOps([
        ...["limit", "retire", "--id", companyLimit],
        ...["--reason", "dbtest operator retire", "--actor", ACTOR],
      ]);
    const retired = await retire();
    const retiredAgain = await retire();
    const companySecond = await limitSet([
      ...["--scope", "company", ...company],
      ...["--daily-usd", "7.5", "--timezone", "UTC"],
    ]);

    expect(retired.lines).toEqual([
      { result: "retired", limitId: companyLimit },
    ]);
    expect(retiredAgain.lines).toEqual([
      { result: "already_retired", limitId: companyLimit },
    ]);
    expect(await limitEnding(companyLimit)).toEqual({
      ended_by: ACTOR,
      end_reason: "dbtest operator retire",
      ended: true,
    });
    expect(companySecond.lines[0].limitId).not.toBe(companyLimit);
    const { rows } = await admin.query(
      `select id, daily_limit_micros::text as micros, timezone from ops.spend_limits
        where scope = 'company' and company_id = $1 and ended_at is null`,
      [office.companyId],
    );
    expect(rows).toEqual([
      {
        id: companySecond.lines[0].limitId,
        micros: "7500000",
        timezone: "UTC",
      },
    ]);
  }, 30_000);
});

describe("the operator's reads after real runs", () => {
  // What neither the CLI's unit tests nor the SQL suite can prove: the reads
  // over runs the real runtime produced, one of them still calling the model,
  // and a whole transcript free of what the tool must never print.
  it("reports status, spend, runs and indeterminate as the database accounts them, marks exhausted on settled spend only, reports the next start blocked whenever charged spend has reached a limit, and prints no task or agent text, result, idempotency key or connection string", async () => {
    const office = await probes.buildOfficeTask(TENANT_A);
    const officeB = await probes.buildOfficeTask(TENANT_B);
    const succeeded = await probes.requestRun(office, RUN_KEYS.succeeded);
    const indeterminate = await probes.requestRun(
      office,
      RUN_KEYS.indeterminate,
    );
    const inFlight = await probes.requestRun(office, RUN_KEYS.inFlight);
    const held = await probes.requestRun(officeB, RUN_KEYS.held);
    const priceId = governance.priceIds["fake-model-1"];

    const answered = fakeRuntime({ type: "respond", content: VALID });
    const failing = fakeRuntime({ type: "fail", category: "provider_5xx" });
    const gated = createGatedModelProvider({ type: "respond", content: VALID });
    const run = (registry: typeof answered.registry) =>
      runOneJob(db, { workerId: WORKER, registry });
    expect((await run(answered.registry)).outcome).toBe("succeeded");
    expect((await run(failing.registry)).outcome).toBe("succeeded");
    await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: TENANT_B },
        { reason: "dbtest operator drill", actor: ACTOR },
      ),
    );
    const inFlightJob = run(registryServing(gated));
    try {
      await withinMs(
        gated.callStarted(1),
        15_000,
        "the call held in flight never started",
      );
      const costs = {
        succeeded: await readRunCost(admin, succeeded),
        indeterminate: await readRunCost(admin, indeterminate),
        inFlight: await readRunCost(admin, inFlight),
      };
      expect(costs.succeeded).toMatchObject({
        status: "succeeded",
        priceId,
        estimated: FAKE_USAGE_COST_MICROS,
        charged: FAKE_USAGE_COST_MICROS,
      });
      expect(costs.indeterminate).toMatchObject({
        status: "indeterminate",
        estimated: null,
        charged: costs.indeterminate.reserved,
      });
      expect(costs.inFlight).toMatchObject({
        status: "running",
        charged: costs.inFlight.reserved,
      });
      const settled =
        (costs.succeeded.charged as bigint) +
        (costs.indeterminate.charged as bigint);
      const charged = settled + (costs.inFlight.charged as bigint);
      const transcript = newTranscript();
      const ops = (argv: readonly string[]) => runOps(argv, { transcript });

      // A tenant budget one micro-USD above settled spend, which the call in
      // flight already overdraws, and a company limit exactly at settled spend.
      await limitSet([
        ...["--scope", "tenant", "--tenant", TENANT_A],
        ...[
          "--daily-usd",
          formatMicrosAsUsd(settled + 1n),
          "--timezone",
          "UTC",
        ],
      ]);
      await limitSet([
        ...["--scope", "company", "--tenant", TENANT_A],
        ...["--company", office.companyId],
        ...["--daily-usd", formatMicrosAsUsd(settled), "--timezone", "UTC"],
      ]);

      const spend = await ops(["spend", "--tenant", TENANT_A]);
      const status = await ops(["status"]);
      const runs = await ops(["runs", "--tenant", TENANT_A]);
      const onlyIndeterminate = await ops([
        ...["runs", "--tenant", TENANT_A, "--status", "indeterminate"],
      ]);
      const newest = await ops(["runs", "--tenant", TENANT_A, "--limit", "1"]);
      const attention = await ops(["indeterminate", "--tenant", TENANT_A]);

      const byScope = new Map(spend.lines.map((row) => [row.scope, row]));
      expect(spend.lines.map((row) => row.scope)).toEqual([
        "global",
        "tenant",
        "company",
      ]);
      expect(byScope.get("tenant")).toMatchObject({
        tenantId: TENANT_A,
        dailyLimitMicros: String(settled + 1n),
        chargedMicros: String(charged),
        settledMicros: String(settled),
        estimatedMicros: String(FAKE_USAGE_COST_MICROS),
        remainingMicros: String(settled + 1n - charged),
        runningRuns: 1,
        unknownCostRuns: 1,
        refusedRuns: 0,
        settledExhausted: false,
        newRunAdmission: "blocked",
      });
      expect(byScope.get("company")).toMatchObject({
        companyId: office.companyId,
        settledMicros: String(settled),
        settledUsd: formatMicrosAsUsd(settled),
        settledExhausted: true,
        newRunAdmission: "blocked",
      });
      expect(byScope.get("global")).toMatchObject({
        settledExhausted: false,
        newRunAdmission: "conditional",
      });
      expect(
        BigInt(String(byScope.get("global")?.chargedMicros)) -
          BigInt(String(byScope.get("global")?.settledMicros)),
      ).toBeGreaterThanOrEqual(costs.inFlight.charged as bigint);

      expect(status.lines).toHaveLength(1);
      const report = status.lines[0];
      expect(report.activeStops).toEqual([
        { scope: "tenant", origin: "owner", count: 1 },
      ]);
      expect(report.heldJobs).toMatchObject({ held: 1, complete: true });
      expect(report.runsStartedToday).toMatchObject({
        byStatus: {
          succeeded: expect.any(Number),
          indeterminate: expect.any(Number),
          running: expect.any(Number),
        },
      });
      expect(report.runsNeedingAttention).toEqual(expect.any(Number));
      expect(Number(report.runsNeedingAttention)).toBeGreaterThanOrEqual(1);
      expect(report.spend).toEqual(
        expect.arrayContaining([
          ...spend.lines,
          expect.objectContaining({ scope: "tenant", tenantId: TENANT_B }),
        ]),
      );
      expect(report.globalCeilingConfigured).toBe(true);
      expect(report.tenantsWithoutBudget).not.toContainEqual(
        expect.objectContaining({ tenantId: TENANT_A }),
      );

      expect(runs.lines.map((row) => [row.id, row.status])).toEqual([
        [inFlight, "running"],
        [indeterminate, "indeterminate"],
        [succeeded, "succeeded"],
      ]);
      expect(runs.lines[2]).toMatchObject({
        provider: "fake",
        model: "fake-model-1",
        responseModel: "fake-model-1",
        inputTokens: 120,
        outputTokens: 60,
        priceId,
        estimatedCostMicros: String(FAKE_USAGE_COST_MICROS),
        chargedCostMicros: String(FAKE_USAGE_COST_MICROS),
      });
      expect(runs.lines[1]).toMatchObject({
        errorCategory: "provider_5xx",
        estimatedCostMicros: null,
        chargedCostMicros: String(costs.indeterminate.reserved),
        reservedCostMicros: String(costs.indeterminate.reserved),
      });
      for (const row of [...runs.lines, ...attention.lines]) {
        for (const key of [
          "result",
          "idempotencyKey",
          "correlationId",
          "providerRequestId",
          "providerResponseId",
        ]) {
          expect(row).not.toHaveProperty(key);
        }
      }
      expect(onlyIndeterminate.lines.map((row) => row.id)).toEqual([
        indeterminate,
      ]);
      expect(newest.lines.map((row) => row.id)).toEqual([inFlight]);
      expect(attention.lines).toEqual([
        expect.objectContaining({
          id: indeterminate,
          attention: "indeterminate_not_retried",
        }),
      ]);

      expect(
        leaks(transcript, [
          TASK_SENTINEL,
          AGENT_SENTINEL,
          VALID.summary,
          ...VALID.proposed_next_steps,
          ...Object.values(RUN_KEYS),
          ...connectionPieces(),
        ]),
      ).toEqual([]);
      // spend 3, status 1, runs 3 + 1 + 1, indeterminate 1: the check above read them all.
      expect(transcript.lines).toHaveLength(10);
      expect((await readRunCost(admin, held)).status).toBe("pending");
    } finally {
      gated.open();
      await inFlightJob;
    }
    expect((await readRunCost(admin, inFlight)).status).toBe("succeeded");
  }, 60_000);
});
