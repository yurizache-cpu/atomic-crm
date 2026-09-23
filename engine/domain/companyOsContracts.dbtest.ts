// Contract parity (docs/PHASE_2C_BRIEF.md §9, §16; stream S4): the operator
// API contracts in contracts/company-os-api against the live database, through
// the real `pg` driver.
//
// companyOsContracts.test.ts proves the contracts' vocabularies equal the
// engine's, companyOsContractMinimisation.test.ts proves what the schemas
// refuse, and companyOsContractVocabulary.dbtest.ts proves every vocabulary
// but the derived TENANT_STOP_SCOPES equals what SQL bounds or emits. This
// file:
//
//   * compares the operation catalogue with pg_proc: the 15 functions of
//     company_os_api, their argument names, types and DEFAULTs, and no act;
//   * builds a synthetic tenant whose rows reach every branch the projections
//     have (testSupport/companyOsContractFixture.ts: each agent availability
//     and activity, each run status and attention reason, each review status
//     and withheld reason, each tenant stop scope, outbound rows, spend rows,
//     refused inbound messages, events of every kind the fixture can produce,
//     an unknown one included), then calls all 15 functions as a signed-in
//     member exactly as PostgREST would (`set local role authenticated`, the
//     verified claims, a live auth session and a membership granted through
//     the owner service), pages through every list, parses every response
//     with its contract, and maps the gates' refusals to the typed error. Any
//     mismatch fails.
//
// Everything is built and read inside ONE owner transaction that is always
// rolled back, in a tenant of its own: nothing it writes outlives the case
// (principals and memberships are immutable and never deleted), and the
// worker suites' fixture tenants are never touched except for the one
// owns_local_crm flag, which the rollback restores. It lives in engine/domain
// because only there may a test import the domain services and the database
// fixture together (eslint.config.js). All data is synthetic.

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import * as contracts from "../../contracts/company-os-api/index.ts";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  ADMIN_URL,
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";
import {
  ACTOR,
  AGENT_ROLE,
  AUTH_FAMILY_NAME,
  AUTH_GIVEN_NAME,
  DISPLAY_NAME,
  GRANTOR,
  GRANT_REASON,
  LIMIT_SETTER,
  PHONE,
  PRICE_RECORDER,
  PROVIDER_REQUEST_ID,
  PROVIDER_RESPONSE_ID,
  RETRY_IDEMPOTENCY_KEY,
  SYNTHETIC_CONTACT_PREFIX,
  SYNTHETIC_MESSAGE_ID_PREFIX,
  TASK_TITLE,
  WHATSAPP_MESSAGE_ID_PREFIX,
  WORKER,
  actAs,
  buildFixture,
  createAuthUser,
  must,
  type AuthUser,
  type Fixture,
} from "./testSupport/companyOsContractFixture.ts";

const {
  COMPANY_OS_API_SCHEMA,
  COMPANY_OS_OPERATIONS,
  COMPANY_OS_OPERATION_NAMES,
  parseOperationInput,
} = contracts;
type CompanyOsOperation = contracts.CompanyOsOperation;
type OperationArgument = contracts.OperationArgument;

let admin: Pool;
let owner: WorkerDatabase;

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

class RolledBack<T> {
  constructor(readonly value: T) {}
}

/** Runs `fn` in one owner transaction that is always rolled back. */
async function rolledBack<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  try {
    await owner.withTransaction(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (outcome) {
    if (outcome instanceof RolledBack) return outcome.value as T;
    throw outcome;
  }
  throw new Error("the parity session committed; it must roll back");
}

/** An argument as pg_get_function_arguments prints it. */
const sqlArgument = (arg: OperationArgument): string => {
  if (!arg.optional) return `${arg.name} ${arg.type}`;
  const value =
    arg.defaultValue === null
      ? `NULL::${arg.type}`
      : typeof arg.defaultValue === "string"
        ? `'${arg.defaultValue}'::${arg.type}`
        : String(arg.defaultValue);
  return `${arg.name} ${arg.type} DEFAULT ${value}`;
};

const sorted = (values: Iterable<string>): string[] => [...values].sort();

beforeAll(async () => {
  admin = adminPool();
  owner = createWorkerDatabase({ connectionString: ADMIN_URL, max: 2 });
  await assertTargetDatabase(admin);
  const { rows } = await admin.query<{ present: boolean }>(
    "select to_regnamespace($1) is not null as present",
    [COMPANY_OS_API_SCHEMA],
  );
  if (!rows[0]?.present) {
    throw new Error(
      "company_os_api does not exist: apply 20260922120000_company_os_read_surface.sql to this stack first",
    );
  }
});

afterAll(async () => {
  await owner?.close();
  await admin?.end();
});

// ---------------------------------------------------------------------------
// The catalogue, against pg_proc.
// ---------------------------------------------------------------------------

describe("the operation catalogue equals pg_proc", () => {
  it("company_os_api holds exactly the 15 catalogued functions, with their argument names, types and defaults", async () => {
    const { rows } = await admin.query<{
      name: string;
      args: string;
      result: string;
      volatility: string;
      definer: boolean;
    }>(
      `select p.proname as name, pg_get_function_arguments(p.oid) as args,
              pg_get_function_result(p.oid) as result, p.provolatile as volatility,
              p.prosecdef as definer
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = $1
        order by p.proname`,
      [COMPANY_OS_API_SCHEMA],
    );
    // No overload: one row per name.
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    expect(Object.fromEntries(rows.map((row) => [row.name, row.args]))).toEqual(
      Object.fromEntries(
        COMPANY_OS_OPERATION_NAMES.map((name) => [
          name,
          COMPANY_OS_OPERATIONS[name].args.map(sqlArgument).join(", "),
        ]),
      ),
    );
    for (const row of rows) {
      expect(
        {
          result: row.result,
          volatility: row.volatility,
          definer: row.definer,
        },
        row.name,
      ).toEqual({ result: "jsonb", volatility: "s", definer: true });
    }
  });

  it("no act, act gate or trip service exists before S8", async () => {
    const { rows } = await admin.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('ops', $1)
          and p.proname in ('decide_review', 'trip_stop', 'gate_decide_review',
                            'gate_trip_stop', 'trip_stop_in_tenant')`,
      [COMPANY_OS_API_SCHEMA],
    );
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The member's session.
// ---------------------------------------------------------------------------

interface Call {
  readonly label: string;
  readonly operation: CompanyOsOperation;
  readonly value: unknown;
}

interface Session {
  readonly fixture: Fixture;
  readonly member: AuthUser;
  /** ops.tenant_memberships.email_at_grant_sha256, as the grant stored it. */
  readonly storedEmailHash: string;
  /** The grant's ops.tenant_memberships.id, which no read returns. */
  readonly membershipId: string;
  /** The ops.principals.id the grant keyed to the auth user. */
  readonly principalId: string;
  readonly calls: readonly Call[];
  readonly refusals: readonly Refusal[];
  readonly pagedEventIds: readonly string[];
  readonly pagedRunIds: readonly string[];
}

interface Refusal {
  readonly operation: CompanyOsOperation;
  /** The SQLSTATE and message the driver received. */
  readonly code: string;
  readonly message: string;
  /** What the contract's typed error made of it. */
  readonly typed: contracts.OsErrorCode;
}

async function readSession(tx: TxClient): Promise<Session> {
  const fixture = await buildFixture(tx);
  const member = await createAuthUser(tx);
  await tx.query("select ops.grant_membership($1, $2, $3, $4, $5)", [
    fixture.tenantId,
    member.userId,
    DISPLAY_NAME,
    GRANTOR,
    GRANT_REASON,
  ]);
  const { rows: grants } = await tx.query<{
    hash: string;
    membership_id: string;
    principal_id: string;
  }>(
    `select m.email_at_grant_sha256 as hash, m.id as membership_id, p.id as principal_id
       from ops.tenant_memberships m join ops.principals p on p.id = m.principal_id
      where p.issuer = 'supabase_auth' and p.subject = $1 and m.revoked_at is null`,
    [member.userId],
  );
  must(grants.length === 1, "the member holds one active membership");
  await actAs(tx, member);
  const calls: Call[] = [];
  const refusals: Refusal[] = [];

  const call = async (
    operation: CompanyOsOperation,
    args: Readonly<Record<string, unknown>> = {},
    label: string = operation,
  ): Promise<Record<string, unknown>> => {
    // The contract checks the input a client would send before it leaves.
    const input = parseOperationInput(operation, args) as Record<
      string,
      unknown
    >;
    const names = Object.keys(input);
    const catalogued = COMPANY_OS_OPERATIONS[operation].args.map((a) => a.name);
    for (const name of names)
      must(catalogued.includes(name), `${name} is catalogued`);
    const named = names.map((name, i) => `${name} => $${i + 1}`).join(", ");
    const { rows } = await tx.query<{ body: string }>(
      `select company_os_api.${operation}(${named})::text as body`,
      names.map((name) => input[name]),
    );
    const value = JSON.parse(rows[0].body) as Record<string, unknown>;
    calls.push({ label, operation, value });
    return value;
  };

  /** Every page of a list, following nextCursor to the end. */
  const pages = async (
    operation: CompanyOsOperation,
    args: Readonly<Record<string, unknown>>,
    limit: number,
  ): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: unknown = null;
    for (let page = 0; page < 100; page++) {
      const value = await call(
        operation,
        { ...args, p_cursor: cursor, p_limit: limit },
        `${operation} ${JSON.stringify(args)} page ${page}`,
      );
      ids.push(...(value.items as { id: string }[]).map((item) => item.id));
      cursor = value.nextCursor;
      if (cursor === null) return ids;
    }
    throw new Error(`${operation} did not reach its last page`);
  };

  await call("operator_context");
  await call("overview");
  await call("list_agents");
  await call("spend_summary");
  await call("communication_status");
  for (const agentId of fixture.agents) {
    await call("get_agent", { p_agent_id: agentId });
  }

  await pages("list_tasks", {}, 4);
  await pages("list_tasks", { p_status: "assigned" }, 50);
  await pages("list_tasks", { p_agent_id: fixture.agents[0] }, 50);
  for (const taskId of fixture.tasks) {
    await call("get_task", { p_task_id: taskId });
  }

  const pagedRunIds = await pages("list_runs", {}, 4);
  await pages("list_runs", { p_attention_only: true }, 50);
  await pages("list_runs", { p_status: "indeterminate" }, 50);
  for (const runId of fixture.runs) {
    await call("get_run", { p_run_id: runId });
  }

  for (const status of contracts.REVIEW_STATUSES) {
    await pages("list_reviews", { p_status: status }, 2);
  }
  await call("list_reviews", {}, "list_reviews default tab");
  for (const reviewId of fixture.reviews) {
    await call("get_review", { p_review_id: reviewId });
    await call("get_review_advice", { p_review_id: reviewId });
  }

  const pagedEventIds = await pages("list_events", {}, 7);
  for (const [subjectType, subjectId] of fixture.subjects) {
    await pages(
      "list_events",
      { p_subject_type: subjectType, p_subject_id: subjectId },
      50,
    );
  }

  await pages("list_stops", {}, 50);
  await pages("list_stops", { p_include_cleared: true }, 2);

  // Refusals, each in a savepoint so the session goes on. The SQL is sent as a
  // client that skipped the contract's input check would send it.
  const refuse = async (
    operation: CompanyOsOperation,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<void> => {
    await tx.query("savepoint cos_refusal");
    let failure: unknown = null;
    try {
      await tx.query(sql, params);
    } catch (error) {
      failure = error;
    }
    await tx.query("rollback to savepoint cos_refusal");
    const { code, message } = (failure ?? {}) as {
      code?: unknown;
      message?: unknown;
    };
    refusals.push({
      operation,
      code: String(code),
      message: String(message),
      typed: contracts.toCompanyOsApiError(operation, failure).code,
    });
  };
  await refuse("get_agent", "select company_os_api.get_agent($1)", [
    randomUUID(),
  ]);
  await refuse(
    "list_tasks",
    "select company_os_api.list_tasks(p_cursor => $1)",
    [`rn1:${fixture.runs[0]}`],
  );
  await refuse("get_agent", "select company_os_api.get_agent($1)", [
    "not-a-uuid",
  ]);
  // No verified claims (the legacy pool's empty setting): refused first.
  await tx.query("select set_config('request.jwt.claims', '', true)");
  await refuse("overview", "select company_os_api.overview()");
  // Signed in, with no membership.
  await tx.query("reset role");
  const stranger = await createAuthUser(tx);
  await actAs(tx, stranger);
  await refuse("operator_context", "select company_os_api.operator_context()");
  // Signed out: PostgREST runs a keyless or anon-key request as anon, which no
  // grant on company_os_api reaches.
  await tx.query("reset role");
  await tx.query(
    `select set_config('request.jwt.claims', '{"role":"anon"}', true)`,
  );
  await tx.query("set local role anon");
  await refuse("operator_context", "select company_os_api.operator_context()");

  await tx.query("reset role");
  return {
    fixture,
    member,
    storedEmailHash: grants[0].hash,
    membershipId: grants[0].membership_id,
    principalId: grants[0].principal_id,
    calls,
    refusals,
    pagedEventIds,
    pagedRunIds,
  };
}

// ---------------------------------------------------------------------------
// What the member received.
// ---------------------------------------------------------------------------

describe("every company_os_api response parses with its contract", () => {
  let session: Session;

  beforeAll(async () => {
    session = await rolledBack(readSession);
  });

  const valuesOf = <T>(operation: CompanyOsOperation): T[] =>
    session.calls
      .filter((c) => c.operation === operation)
      .map((c) => c.value as T);
  const itemsOf = <T>(operation: CompanyOsOperation): T[] =>
    valuesOf<{ items: T[] }>(operation).flatMap((value) => value.items);

  it("calls all 15 functions, and every response parses", () => {
    expect(sorted(new Set(session.calls.map((c) => c.operation)))).toEqual(
      sorted(COMPANY_OS_OPERATION_NAMES),
    );
    const broken = session.calls.flatMap(({ label, operation, value }) => {
      const parsed = COMPANY_OS_OPERATIONS[operation].response.safeParse(value);
      return parsed.success
        ? []
        : parsed.error.issues.map(
            (issue) =>
              `${label}: ${issue.path.join(".")} ${issue.code} ${issue.message}`,
          );
    });
    expect(broken).toEqual([]);
  });

  it("reaches every agent availability, activity and inactive unit, with a stop as evidence", () => {
    const agents = [
      ...itemsOf<contracts.AgentSummary>("list_agents"),
      ...valuesOf<contracts.AgentDetail>("get_agent").map((d) => d.agent),
    ];
    expect(sorted(new Set(agents.map((a) => a.availability)))).toEqual(
      sorted(contracts.AGENT_AVAILABILITIES),
    );
    expect(sorted(new Set(agents.map((a) => a.activity)))).toEqual(
      sorted(contracts.AGENT_ACTIVITIES),
    );
    expect(
      sorted(new Set(agents.flatMap((a) => a.evidence.inactiveUnit ?? []))),
    ).toEqual(sorted(contracts.ORG_UNITS));
    const { tripped } = session.fixture;
    const stops = new Set(agents.flatMap((a) => a.evidence.stop?.id ?? []));
    expect(sorted(stops)).toEqual(
      sorted([tripped.agentStop, tripped.companyStop, tripped.departmentStop]),
    );
    const agent = (id: string) => agents.find((a) => a.id === id);
    // Inactive wins over stopped, and the stop still shows as evidence.
    expect(agent(tripped.pausedDesk)).toMatchObject({
      availability: "inactive",
      evidence: {
        inactiveUnit: "department",
        stop: { id: tripped.departmentStop },
      },
    });
    expect(agent(tripped.closedDesk)?.evidence.inactiveUnit).toBe("company");
  });

  it("reaches every run status and attention reason, a stop, a limit and a retry", () => {
    const runs = [
      ...itemsOf<contracts.AgentRunSummary>("list_runs"),
      ...valuesOf<contracts.AgentRunDetail>("get_run"),
    ];
    expect(sorted(new Set(runs.map((r) => r.status)))).toEqual(
      sorted(contracts.AGENT_RUN_STATUSES),
    );
    expect(sorted(new Set(runs.flatMap((r) => r.attention ?? [])))).toEqual(
      sorted(contracts.RUN_ATTENTION_REASONS),
    );
    const byId = new Map(runs.map((r) => [r.id, r]));
    const { tripped } = session.fixture;
    expect(byId.get(tripped.refusedByStop)?.stopRef).toEqual({
      id: tripped.agentStop,
    });
    expect(byId.get(tripped.refusedByBudget)?.spendLimitRef).toMatchObject({
      scope: "company",
    });
    expect(byId.get(tripped.retry)?.retryOfRunId).toEqual(expect.any(String));
    const details = valuesOf<contracts.AgentRunDetail>("get_run");
    expect(details.some((d) => d.retriedByRunIds.includes(tripped.retry))).toBe(
      true,
    );
    const held = details.find((d) => d.id === tripped.held);
    expect(held?.jobSteps.map((s) => s.step)).toEqual([
      "job_leased",
      "job_deferred",
    ]);
    expect(held?.coveringStop?.id).toBe(tripped.agentStop);
  });

  it("reaches every review status, both advice branches and every withheld reason", () => {
    const reviews = [
      ...itemsOf<contracts.ReviewSummary>("list_reviews"),
      ...valuesOf<contracts.ReviewDetail>("get_review"),
    ];
    expect(sorted(new Set(reviews.map((r) => r.status)))).toEqual(
      sorted(contracts.REVIEW_STATUSES),
    );
    expect(reviews.some((r) => r.agentRunId === null)).toBe(true);
    const advice = valuesOf<contracts.ReviewAdvice>("get_review_advice");
    expect(advice.some((a) => "capability" in a)).toBe(true);
    expect(
      sorted(
        new Set(advice.flatMap((a) => ("withheld" in a ? [a.withheld] : []))),
      ),
    ).toEqual(sorted(contracts.ADVICE_WITHHELD_REASONS));
    const decisions = valuesOf<contracts.ReviewDetail>("get_review").map((r) =>
      r.allowedDecisions.join(","),
    );
    expect(sorted(new Set(decisions))).toEqual([
      "",
      "accepted,rejected,needs_edit",
      "rejected,needs_edit",
    ]);
    expect(
      valuesOf<contracts.ReviewDetail>("get_review").some(
        (r) => r.decisionNote === "" && r.hasNote,
      ),
    ).toBe(true);
  });

  it("reaches every tenant stop scope, active and cleared, and never a platform stop", () => {
    const stops = itemsOf<contracts.ExecutionStopSummary>("list_stops");
    expect(sorted(new Set(stops.map((s) => s.scope)))).toEqual(
      sorted(contracts.TENANT_STOP_SCOPES),
    );
    expect(stops.some((s) => s.clearedAt === null)).toBe(true);
    expect(stops.some((s) => s.clearedAt !== null)).toBe(true);
    // Only the fixture's own stops, whatever platform stop exists meanwhile.
    const { tripped } = session.fixture;
    expect(sorted(new Set(stops.map((s) => s.id)))).toEqual(
      sorted([
        tripped.agentStop,
        tripped.companyStop,
        tripped.departmentStop,
        tripped.tenantStop,
        tripped.kindStop,
      ]),
    );
  });

  it("reaches the task, outbound, inbound, spend and communication branches", () => {
    const tasks = valuesOf<contracts.TaskDetail>("get_task");
    expect(
      sorted(
        new Set(tasks.flatMap((t) => (t.outbound ? [t.outbound.status] : []))),
      ),
    ).toEqual(["blocked", "failed", "indeterminate"]);
    expect(
      sorted(
        new Set(
          tasks.flatMap((t) => (t.inbound ? [t.inbound.sourceKind] : [])),
        ),
      ),
    ).toEqual(sorted(contracts.INBOUND_SOURCE_KINDS));
    expect(
      tasks.some((t) => t.inbound === null && t.assignedAgent === null),
    ).toBe(true);
    const [spend] = valuesOf<contracts.SpendSummary>("spend_summary");
    expect(sorted(spend.tenantRows.map((row) => row.scope))).toEqual(
      sorted(contracts.TENANT_LIMIT_SCOPES),
    );
    expect(spend.today.byAgent.length).toBeGreaterThan(0);
    expect(spend.today.byModel.length).toBeGreaterThan(0);
    const [communication] = valuesOf<contracts.CommunicationStatusSummary>(
      "communication_status",
    );
    expect(sorted(communication.channels.map((c) => c.mode))).toEqual(
      sorted(contracts.CHANNEL_MODES),
    );
    expect(communication.inbound.refusedTodayByReason).not.toEqual({});
    expect(communication.outbound.blockedByReason).not.toEqual({});
  });

  it("returns known and unknown events, facts withheld for the unknown one", () => {
    const events = itemsOf<contracts.EventSummary>("list_events");
    const types = new Set(events.map((e) => e.type));
    for (const type of [
      "task.created",
      "task.assigned",
      "agent_run.requested",
      "agent_run.started",
      "agent_run.succeeded",
      "agent_run.failed",
      "agent_run.indeterminate",
      "agent_run.cancelled",
      "lead_triage.review_pending",
      "lead_triage.reviewed",
      "communication.received",
      "communication.inbound_refused",
      "communication.channel_configured",
      "communication.outbound_authorized",
      "communication.outbound_blocked",
      "communication.outbound_failed",
      "communication.outbound_indeterminate",
      "communication.delivery_updated",
      "agent.status_changed",
      "department.status_changed",
      "company.status_changed",
    ]) {
      expect(types, type).toContain(type);
    }
    const probe = events.find((e) => e.type === "dbtest.contract_probe");
    expect(probe).toMatchObject({
      source: contracts.OTHER_EVENT_SOURCE,
      facts: {},
      factsWithheld: true,
    });
  });

  it("pages every event and every run exactly once through the opaque cursors", () => {
    // More rows than one page holds, so each cursor was followed.
    expect(session.pagedEventIds.length).toBeGreaterThan(7);
    expect(session.pagedRunIds.length).toBeGreaterThan(4);
    expect(new Set(session.pagedEventIds).size).toBe(
      session.pagedEventIds.length,
    );
    expect(session.pagedEventIds).toHaveLength(session.fixture.eventCount);
    expect(sorted(session.pagedRunIds)).toEqual(sorted(session.fixture.runs));
  });

  it("sweeps the email hash the grant actually stored", () => {
    const lowered = session.member.email.toLowerCase();
    expect(lowered).not.toBe(session.member.email);
    expect(session.storedEmailHash).toBe(
      createHash("sha256").update(lowered, "utf8").digest("hex"),
    );
  });

  it("names the caller by the granted principal's id, never the auth user or the membership row", () => {
    const [context] = valuesOf<contracts.OperatorContext>("operator_context");
    expect(context.principal).toEqual({ id: session.principalId });
    expect(session.principalId).not.toBe(session.member.userId);
    expect(session.principalId).not.toBe(session.membershipId);
  });

  it("carries no content, message or call identity, label or person identity the brief keeps out", () => {
    const text = JSON.stringify(session.calls.map((c) => c.value));
    const { member } = session;
    const kept: [string, string][] = [
      ["the stored body", "COS-SENTINEL-BODY"],
      ["the reply draft", "COS-SENTINEL-DRAFT"],
      ["the task title", TASK_TITLE],
      ["the agent's role", AGENT_ROLE],
      ["the sender's number", PHONE],
      ["a synthetic contact ref", SYNTHETIC_CONTACT_PREFIX],
      ["a synthetic message id", SYNTHETIC_MESSAGE_ID_PREFIX],
      ["a WhatsApp message id", WHATSAPP_MESSAGE_ID_PREFIX],
      ["the provider target", session.fixture.providerTarget],
      ["the provider request id", PROVIDER_REQUEST_ID],
      ["the provider response id", PROVIDER_RESPONSE_ID],
      ["the retry's idempotency key", RETRY_IDEMPOTENCY_KEY],
      ["the worker's lease label", WORKER],
      ["a raw actor label", ACTOR],
      ["the price's recorded_by", PRICE_RECORDER],
      ["the limits' set_by", LIMIT_SETTER],
      ["the membership's granted_by", GRANTOR],
      ["the membership's grant reason", GRANT_REASON],
      ["the principal's display name", DISPLAY_NAME],
      ["the member's email hash", session.storedEmailHash],
      ["the membership row's id", session.membershipId],
      ["the member's email", member.email],
      ["the member's lower-cased email", member.email.toLowerCase()],
      ["the member's auth user id", member.userId],
      ["the member's session id", member.sessionId],
      ["the member's given name", AUTH_GIVEN_NAME],
      ["the member's family name", AUTH_FAMILY_NAME],
    ];
    // Case-insensitive, so a re-cased copy of any value counts as a leak too.
    const haystack = text.toLowerCase();
    const leaked = kept
      .filter(([, value]) => haystack.includes(value.toLowerCase()))
      .map(([label]) => label);
    expect(leaked).toEqual([]);
  });

  it("refuses exactly as the gates do, and the typed error keeps the code and the fixed text", () => {
    expect(session.refusals.map((r) => [r.operation, r.code, r.typed])).toEqual(
      [
        ["get_agent", "OS404", "OS404"],
        ["list_tasks", "OS400", "OS400"],
        // A malformed uuid never reaches the gate; to a client it is OS500.
        ["get_agent", "22P02", "OS500"],
        ["overview", "OS401", "OS401"],
        ["operator_context", "OS403", "OS403"],
        // Signed out: refused before any gate, and "no access" to a client.
        ["operator_context", "42501", "OS403"],
      ],
    );
    for (const refusal of session.refusals.filter((r) =>
      r.code.startsWith("OS"),
    )) {
      expect(refusal.message).toBe(
        new contracts.CompanyOsApiError(refusal.operation, refusal.typed)
          .message,
      );
    }
  });

  it("leaves nothing behind", async () => {
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.tenants where slug = $1",
      [session.fixture.slug],
    );
    expect(rows[0].n).toBe(0);
  });
});
