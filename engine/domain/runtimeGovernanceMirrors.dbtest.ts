// The runtime governance contracts the engine and the database share (ADR 0017),
// against a real Postgres through the real `pg` driver, the real worker runtime
// and the real agent run handler, with a scripted model provider.
//
// supabase/tests/runtime_governance.sql proves the database side of each
// contract on its own. What it cannot see is the other side:
//
//   * that ops.agent_run_route_policies() and the job kind classification are
//     the same values the worker's code holds (MODEL_ROUTE_POLICIES,
//     EXTERNAL_JOB_KINDS, INTERNAL_JOB_KINDS);
//   * that the request the handler REALLY sends, for agent and task text at
//     every column limit and full of characters that JSON escaping grows, is
//     never larger in UTF-8 bytes than the input ceiling the database computed
//     from the context its claim returned (a byte-level tokenizer never emits
//     more tokens than bytes, so this is the bound the reservation rests on);
//   * that a real start records exactly the reservation
//     ops.agent_run_reservation_for derives, and charges it while the call is
//     in flight.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  AGENT_RUN_CAPABILITIES,
  SUPPORTED_CAPABILITIES,
} from "../models/capabilityContracts.ts";
import { modelRequestByteSize } from "../models/requestSize.ts";
import { buildModelRequest, MODEL_ROUTE_POLICIES } from "../models/router.ts";
import {
  buildTaskAssessmentPrompt,
  taskAssessmentContract,
  TRUNCATION_MARKER,
} from "../models/taskAssessment.ts";
import { MODEL_ROUTE_NAMES, type ModelRequest } from "../models/types.ts";
import { EXTERNAL_JOB_KINDS, INTERNAL_JOB_KINDS } from "../worker/jobKinds.ts";
import { REGISTERED_HANDLER_KINDS } from "../worker/registry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import { createGatedModelProvider } from "../worker/testSupport/gatedModelProvider.ts";
import {
  inputTokenCeiling,
  readRunCost,
  reservationFor,
  reservationMicros,
} from "../worker/testSupport/spendProbes.ts";
import { VALID, withinMs } from "./testSupport/agentRuntimeProbes.ts";
import {
  buildGovernedOffice,
  capturingClaims,
  closeGovernanceDatabases,
  governedRuntime,
  openGovernanceDatabases,
  PRICED_MODEL,
  requestRuns,
  type OfficeText,
} from "./testSupport/governanceRuntime.ts";

const WORKER = "dbtest-governance-mirrors";
const STANDARD_OUTPUT_CEILING = MODEL_ROUTE_POLICIES.standard.maxOutputTokens;
/** The fixed allowance ops.agent_run_input_token_ceiling adds for framing. */
const FRAMING_ALLOWANCE = 8192;

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

// ---------------------------------------------------------------------------
// Engine vocabulary the database mirrors
// ---------------------------------------------------------------------------

describe("the vocabulary the worker and the database share", () => {
  it("has the database's route output ceilings equal to MODEL_ROUTE_POLICIES, route for route", async () => {
    const { rows } = await admin.query<{
      model_route: string;
      max_output_tokens: number;
    }>(
      "select model_route, max_output_tokens from ops.agent_run_route_policies() order by model_route",
    );

    const database = Object.fromEntries(
      rows.map((row) => [row.model_route, row.max_output_tokens]),
    );
    const engine = Object.fromEntries(
      MODEL_ROUTE_NAMES.map((route) => [
        route,
        MODEL_ROUTE_POLICIES[route].maxOutputTokens,
      ]),
    );
    expect(rows).toHaveLength(MODEL_ROUTE_NAMES.length);
    expect(database).toEqual(engine);
  });

  it("has the database's external and internal job kinds equal to EXTERNAL_JOB_KINDS and INTERNAL_JOB_KINDS, together exactly the registered kinds", async () => {
    const { rows } = await admin.query<{
      external: string[];
      internal: string[];
    }>(
      "select ops.external_job_kinds() as external, ops.internal_job_kinds() as internal",
    );

    const sorted = (kinds: readonly string[]) => [...kinds].sort();
    expect(sorted(rows[0].external)).toEqual(sorted(EXTERNAL_JOB_KINDS));
    expect(sorted(rows[0].internal)).toEqual(sorted(INTERNAL_JOB_KINDS));
    expect(sorted([...rows[0].external, ...rows[0].internal])).toEqual(
      sorted(REGISTERED_HANDLER_KINDS),
    );
  });

  // The database decides which capabilities may be requested; this worker
  // decides which it can execute. A capability the database offers and the
  // worker lacks is refused as `capability_unsupported` — recorded, and
  // nothing called — so the two must be added in the same change.
  it("has a prompt and a contract for every capability the database offers", async () => {
    const { rows } = await admin.query<{
      capability: string;
      model_route: string;
    }>("select capability, model_route from ops.agent_run_capabilities()");

    expect([...rows].map((row) => row.capability).sort()).toEqual(
      [...SUPPORTED_CAPABILITIES].sort(),
    );
    for (const row of rows) {
      const binding = AGENT_RUN_CAPABILITIES.get(row.capability);
      expect(binding?.contract.name).toBe(row.capability);
      expect(MODEL_ROUTE_NAMES).toContain(row.model_route);
    }
  });
});

// ---------------------------------------------------------------------------
// The input ceiling bounds the request the handler really sends
// ---------------------------------------------------------------------------

/** U+0001 to U+001F: each is escaped to six bytes by JSON and by jsonb. */
const CONTROL = Array.from({ length: 31 }, (_, i) =>
  String.fromCharCode(i + 1),
).join("");
const QUOTES_AND_BACKSLASHES = `"\\'"\\\\`;
/** Characters outside the BMP: four UTF-8 bytes, two UTF-16 code units each. */
const FOUR_BYTE = [0x1f600, 0x1f4e6, 0x10348, 0x1f9fe]
  .map((codePoint) => String.fromCodePoint(codePoint))
  .join("");

const ALPHABETS: Readonly<Record<string, string>> = Object.freeze({
  control: CONTROL,
  quotes: QUOTES_AND_BACKSLASHES,
  fourByte: FOUR_BYTE,
  mixed: `${CONTROL}${QUOTES_AND_BACKSLASHES}${FOUR_BYTE}`,
});

/** Exactly `length` code points (what the database's char_length counts), cycling `alphabet`. */
function fill(alphabet: string, length: number): string {
  const points = Array.from(alphabet);
  return Array.from({ length }, (_, i) => points[i % points.length]).join("");
}

/** Every text column at its limit: name and role 200, agent description 2000, title 300. */
const officeText = (
  alphabet: string,
  descriptionLength: number,
): OfficeText => ({
  agentName: fill(alphabet, 200),
  agentRole: fill(alphabet, 200),
  agentDescription: fill(alphabet, 2000),
  taskTitle: fill(alphabet, 300),
  taskDescription: fill(alphabet, descriptionLength),
});

interface ClaimedContext {
  readonly agent_run_id: string;
  readonly agent: { name: string; role: string; description: string | null };
  readonly task: {
    type: string;
    title: string;
    description: string | null;
    priority: number;
    due_at: string | null;
  };
}

describe("the input ceiling the database reserves against", () => {
  // What the SQL suite cannot prove: the WORKER's side of the bound. The
  // database sizes the context as jsonb text; the handler builds its request
  // with JSON.stringify, truncates long fields with a marker, and quotes the
  // name and role again in its instructions. Only the bytes of the request the
  // provider actually received show that the ceiling holds.
  it("is never exceeded by the request the handler sends, for adversarial agent and task text at every column limit and at the handler's own truncation limits", async () => {
    const provider = createGatedModelProvider({
      type: "respond",
      content: VALID,
    });
    provider.open();
    const runtime = governedRuntime(provider);
    const { registry, claims } = capturingClaims(runtime.registry);
    const atColumnLimits = Object.entries(ALPHABETS).flatMap(
      ([alphabet, letters]) =>
        [4000, 4001, 10000].map((length) => ({
          label: `${alphabet} text, task description of ${length}`,
          slug: `dbtest-limits-${alphabet.toLowerCase()}-${length}`,
          text: officeText(letters, length),
          // One code unit per character, so the handler's truncation keeps as
          // many characters as the database counts: the bound is at its
          // tightest.
          tight:
            (alphabet === "control" || alphabet === "quotes") && length <= 4001,
          untruncated: false,
        })),
    );
    // The handler truncates in UTF-16 code units, so four-byte text at the
    // column limits is cut to half. At half those lengths nothing is cut, and
    // every byte the request carries is one the database must count.
    const untruncatedFourByte = {
      label: "four-byte text at the handler's own limits, untruncated",
      slug: "dbtest-limits-fourbyte-untruncated",
      text: {
        agentName: fill(FOUR_BYTE, 100),
        agentRole: fill(FOUR_BYTE, 100),
        agentDescription: fill(FOUR_BYTE, 1000),
        taskTitle: fill(FOUR_BYTE, 150),
        taskDescription: fill(FOUR_BYTE, 2000),
      },
      tight: true,
      untruncated: true,
    };
    const cases = [...atColumnLimits, untruncatedFourByte];

    for (const [index, testCase] of cases.entries()) {
      const office = await buildGovernedOffice(
        owner,
        TENANT_A,
        testCase.slug,
        testCase.text,
      );
      const [runId] = await requestRuns(owner, office, [`limits-${index}`]);

      const result = await runOneJob(db, { workerId: WORKER, registry });

      expect(result.outcome, testCase.label).toBe("succeeded");
      const claim = claims.at(-1) as ClaimedContext;
      expect(claim.agent_run_id, testCase.label).toBe(runId);
      // The database handed back the text it stored, untouched.
      expect(claim.agent.name, testCase.label).toBe(testCase.text.agentName);
      expect(claim.agent.description, testCase.label).toBe(
        testCase.text.agentDescription,
      );
      expect(claim.task.title, testCase.label).toBe(testCase.text.taskTitle);
      expect(claim.task.description, testCase.label).toBe(
        testCase.text.taskDescription,
      );

      // The request the provider received is the one the handler builds from
      // that claim, byte for byte.
      const recorded = provider.requests;
      const request = recorded.at(-1) as ModelRequest;
      expect(recorded, testCase.label).toHaveLength(index + 1);
      expect(request, testCase.label).toEqual(
        buildModelRequest(
          runtime.route,
          buildTaskAssessmentPrompt({
            agent: claim.agent,
            task: { ...claim.task, dueAt: claim.task.due_at },
          }),
          taskAssessmentContract,
        ),
      );

      if (testCase.untruncated) {
        expect(JSON.stringify(request), testCase.label).not.toContain(
          TRUNCATION_MARKER,
        );
      }

      const bytes = modelRequestByteSize(request);
      const ceiling = await inputTokenCeiling(admin, claim);
      expect(
        bytes,
        `${testCase.label}: request bytes vs ceiling`,
      ).toBeLessThanOrEqual(ceiling);
      if (testCase.tight) {
        // Not a vacuous bound: here the escaped text is counted almost byte for
        // byte, and only the framing allowance stands between the two.
        expect(ceiling - bytes, testCase.label).toBeLessThan(FRAMING_ALLOWANCE);
      }

      // The ceiling compared above is the one the start reserved against.
      const cost = await readRunCost(admin, runId);
      expect(cost.status, testCase.label).toBe("succeeded");
      expect(cost.priceId, testCase.label).toBe(
        governance.priceIds[PRICED_MODEL],
      );
      expect(cost.reserved, testCase.label).toBe(
        await reservationMicros(
          admin,
          cost.priceId as string,
          ceiling,
          STANDARD_OUTPUT_CEILING,
        ),
      );
    }
    expect(provider.started).toBe(cases.length);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The reservation a real start records
// ---------------------------------------------------------------------------

describe("a started agent run", () => {
  // What the SQL suite cannot prove: that the start the real handler makes,
  // with the ceiling its router reports, records the reservation the database
  // derives for that run, and charges exactly that while the call is in flight.
  it("records at start the reservation ops.agent_run_reservation_for derives for its own task, agent, route and price, and is charged it while its call is in flight", async () => {
    const office = await buildGovernedOffice(
      owner,
      TENANT_A,
      "dbtest-reserved",
    );
    const [runId] = await requestRuns(owner, office, ["reserved-1"]);
    const provider = createGatedModelProvider({
      type: "respond",
      content: VALID,
    });
    const { registry } = governedRuntime(provider);
    const priceId = governance.priceIds[PRICED_MODEL];

    const attempt = runOneJob(db, { workerId: WORKER, registry });
    try {
      await withinMs(
        provider.callStarted(1),
        15_000,
        "the admitted call never started",
      );
      const inFlight = await readRunCost(admin, runId);
      expect(inFlight).toMatchObject({
        status: "running",
        priceId,
        estimated: null,
        spendLimitId: null,
      });
      expect(inFlight.startedAt).not.toBeNull();
      expect(inFlight.reserved).toBe(
        await reservationFor(admin, runId, priceId),
      );
      expect(inFlight.charged).toBe(inFlight.reserved);
      expect(inFlight.reserved).toBeGreaterThan(0n);
    } finally {
      provider.open();
    }

    expect((await attempt).outcome).toBe("succeeded");
    const settled = await readRunCost(admin, runId);
    expect(settled.status).toBe("succeeded");
    expect(settled.reserved).toBe(await reservationFor(admin, runId, priceId));
  }, 30_000);

  // What neither side can prove alone: the reservation counts the DATABASE's
  // output ceiling for the route, and the request the provider receives must
  // carry that same ceiling. The engine's own request builder and its mirror of
  // the route policies could both drift together; the provider's copy cannot.
  it("sends the provider exactly the output ceiling the database reserved for, the one ops.agent_run_route_policies() gives its route", async () => {
    const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-ceiling");
    const [runId] = await requestRuns(owner, office, ["ceiling-sent-1"]);
    const provider = createGatedModelProvider({
      type: "respond",
      content: VALID,
    });
    provider.open();
    const { registry, claims } = capturingClaims(
      governedRuntime(provider).registry,
    );
    const priceId = governance.priceIds[PRICED_MODEL];
    const { rows } = await admin.query<{ max_output_tokens: number }>(
      `select p.max_output_tokens
         from ops.agent_runs r
         join ops.agent_run_route_policies() p on p.model_route = r.model_route
        where r.id = $1`,
      [runId],
    );
    expect(rows).toHaveLength(1);
    const databaseCeiling = rows[0].max_output_tokens;

    const result = await runOneJob(db, { workerId: WORKER, registry });

    expect(result.outcome).toBe("succeeded");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].maxOutputTokens).toBe(databaseCeiling);
    expect(claims).toHaveLength(1);
    const claim = claims[0] as ClaimedContext;
    expect(claim.agent_run_id).toBe(runId);
    const cost = await readRunCost(admin, runId);
    expect(cost).toMatchObject({ status: "succeeded", priceId });
    expect(cost.reserved).toBe(
      await reservationMicros(
        admin,
        priceId,
        await inputTokenCeiling(admin, claim),
        databaseCeiling,
      ),
    );
  }, 30_000);
});
