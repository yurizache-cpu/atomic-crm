// The recorded responses of the Company OS browser tests
// (docs/PHASE_2C_BRIEF.md §16 "Browser": "browser tests fed with responses
// recorded from the driver suite and validated by the contracts, never
// hand-invented activity").
//
// One rolled-back owner transaction builds the synthetic tenant of the
// contract parity suite (testSupport/companyOsContractFixture.ts), grants a
// synthetic auth user a membership through the owner service, and then reads
// the REAL company_os_api functions as that member, exactly as PostgREST
// would, with the arguments the screens send. Three scenarios:
//
//   tenant            every screen's states: agents working (with the run that
//                     proves it), stale, held, queued, idle, inactive and
//                     stopped; runs succeeded, failed, indeterminate, running,
//                     pending, cancelled, with attention and a retry; reviews
//                     pending, accepted, rejected, needs_edit and
//                     do-not-contact; advice shown and each withheld reason;
//                     active and cleared stops (a cleared tenant job_kind stop
//                     among them); spend rows; communication counts; a feed of
//                     more than one page; every task and run chain;
//   tenant-kind-stop  the same tenant with an ACTIVE tenant job_kind stop, its
//                     only active stop (the others cleared);
//   task-many-runs    one task with exactly the 20 runs get_task carries at
//                     most (its refused run and 19 refused retries: the
//                     annex's zero budget cancels each at request time), with
//                     its chain;
//   platform-stop     the same tenant under a platform stop: the one
//                     platform-derived boolean set, and nothing else of it.
//
// The answers are normalised (testSupport/companyOsContractRecording.ts: ids
// mapped through the fixture's labels, times ranked, the server's id
// tie-break replayed on the mapped ids), parsed with their contracts, swept
// for every identity value the fixture planted, and compared with the
// recordings committed under src/company-os/testing/recorded/. A projection
// change therefore fails here until it is re-recorded:
//
//   COMPANY_OS_RECORD=1 SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//     SUPABASE_DB_PORT=54342 npx vitest run --config vitest.db.config.ts \
//     engine/domain/companyOsRecordedResponses.dbtest.ts
//
// Without COMPANY_OS_RECORD=1 nothing is written. All data is synthetic, and
// nothing outlives the transaction.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
} from "./testSupport/companyOsContractFixture.ts";
import {
  buildIdMap,
  firstDifference,
  normalise,
  type IdMap,
  type RecordedCall,
} from "./testSupport/companyOsContractRecording.ts";

const {
  COMPANY_OS_API_SCHEMA,
  COMPANY_OS_OPERATIONS,
  COMPANY_OS_OPERATION_NAMES,
  parseOperationInput,
  withoutDefaultArguments,
} = contracts;
type CompanyOsOperation = contracts.CompanyOsOperation;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RECORDED_DIR = join(ROOT, "src", "company-os", "testing", "recorded");
const RECORD = process.env.COMPANY_OS_RECORD === "1";
const GENERATED_BY =
  "engine/domain/companyOsRecordedResponses.dbtest.ts; re-record with COMPANY_OS_RECORD=1, never edit by hand";

/** The scenario files, each a list of recorded reads. */
type Scenario =
  | "tenant"
  | "tenant-kind-stop"
  | "platform-stop"
  | "task-many-runs";

/** The filters the screen tests select, each recorded as the screen sends it. */
const TASK_FILTERS = (agent: string) => [
  { p_status: "assigned" },
  { p_status: "assigned", p_agent_id: agent },
  { p_agent_id: agent },
];
const RUN_FILTERS = (agent: string) => [
  { p_attention_only: true },
  ...contracts.AGENT_RUN_STATUSES.map((status) => ({ p_status: status })),
  { p_status: "indeterminate", p_agent_id: agent },
  { p_status: "indeterminate", p_agent_id: agent, p_attention_only: true },
  { p_agent_id: agent },
];
/** A chain reads one subject's events 100 at a time (src/company-os). */
const CHAIN_EVENTS_PAGE = 100;

/**
 * get_task carries a task's 20 most recent runs. Exactly 20, not more: every
 * run of the recording shares one created_at, so with a 21st the server's id
 * tie-break would decide which one is left out.
 */
const TASK_RUNS_CAP = 20;

/** A transaction end in the first minutes after UTC midnight moves "today". */
const MIDNIGHT_MARGIN_MINUTES = 20;

let admin: Pool;
let owner: WorkerDatabase;

class RolledBack<T> {
  constructor(readonly value: T) {}
}

async function rolledBack<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  try {
    await owner.withTransaction(async (tx) => {
      throw new RolledBack(await fn(tx));
    });
  } catch (outcome) {
    if (outcome instanceof RolledBack) return outcome.value as T;
    throw outcome;
  }
  throw new Error("the recording session committed; it must roll back");
}

async function rows<T>(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  return (await tx.query<T>(sql, params)).rows;
}

// ---------------------------------------------------------------------------
// The member's reads.
// ---------------------------------------------------------------------------

interface Reader {
  /** One read, recorded under its canonical input. */
  call(
    operation: CompanyOsOperation,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /** Every page of a list, following nextCursor, each page recorded. */
  pages(
    operation: CompanyOsOperation,
    args?: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  readonly calls: RecordedCall[];
}

const createReader = (tx: TxClient): Reader => {
  const calls: RecordedCall[] = [];
  const seen = new Set<string>();
  const call: Reader["call"] = async (operation, args = {}) => {
    const input = withoutDefaultArguments(
      operation,
      parseOperationInput(operation, args) as Record<string, unknown>,
    );
    const names = Object.keys(input);
    const named = names.map((name, i) => `${name} => $${i + 1}`).join(", ");
    const [row] = await rows<{ body: string }>(
      tx,
      `select ${COMPANY_OS_API_SCHEMA}.${operation}(${named})::text as body`,
      names.map((name) => input[name]),
    );
    const response = JSON.parse(row.body) as Record<string, unknown>;
    const key = `${operation} ${JSON.stringify(input)}`;
    if (!seen.has(key)) {
      seen.add(key);
      calls.push({ operation, args: input, response });
    }
    return response;
  };
  const pages: Reader["pages"] = async (operation, args = {}) => {
    let cursor: unknown = null;
    for (let page = 0; page < 20; page += 1) {
      const response = await call(operation, { ...args, p_cursor: cursor });
      cursor = response.nextCursor;
      if (cursor === null) return;
    }
    throw new Error(`${operation} did not reach its last page`);
  };
  return { call, pages, calls };
};

const ids = async (
  tx: TxClient,
  sql: string,
  tenantId: string,
  ...more: readonly unknown[]
) =>
  (await rows<{ id: string }>(tx, sql, [tenantId, ...more])).map(
    (row) => row.id,
  );

interface Targets {
  readonly agents: readonly string[];
  readonly tasks: readonly string[];
  readonly runs: readonly string[];
  readonly reviews: readonly string[];
  readonly triage: string;
}

/** The rows the member will read, found as the owner before acting as them. */
async function targetsOf(tx: TxClient, tenantId: string): Promise<Targets> {
  const [triage] = await ids(
    tx,
    "select id from ops.agents where tenant_id = $1 and slug = 'lead-triage'",
    tenantId,
  );
  return {
    agents: await ids(
      tx,
      "select id from ops.agents where tenant_id = $1 order by slug",
      tenantId,
    ),
    tasks: await ids(
      tx,
      "select id from ops.tasks where tenant_id = $1 order by id",
      tenantId,
    ),
    runs: await ids(
      tx,
      "select id from ops.agent_runs where tenant_id = $1 order by id",
      tenantId,
    ),
    reviews: await ids(
      tx,
      "select id from ops.review_items where tenant_id = $1 order by id",
      tenantId,
    ),
    triage,
  };
}

/** Every read the screens make, with the arguments they make it with. */
async function readTenant(
  tx: TxClient,
  { agents, tasks, runs, reviews, triage }: Targets,
): Promise<Reader> {
  const reader = createReader(tx);
  await reader.call("operator_context");
  await reader.call("overview");
  await reader.call("list_agents");
  await reader.call("spend_summary");
  await reader.call("communication_status");
  for (const agent of agents)
    await reader.call("get_agent", { p_agent_id: agent });

  await reader.pages("list_tasks");
  for (const filter of TASK_FILTERS(triage))
    await reader.pages("list_tasks", filter);
  for (const task of tasks) {
    await reader.call("get_task", { p_task_id: task });
    await reader.pages("list_events", {
      p_subject_type: "task",
      p_subject_id: task,
      p_limit: CHAIN_EVENTS_PAGE,
    });
  }

  await reader.pages("list_runs");
  for (const filter of RUN_FILTERS(triage))
    await reader.pages("list_runs", filter);
  for (const run of runs) {
    await reader.call("get_run", { p_run_id: run });
    await reader.pages("list_events", {
      p_subject_type: "agent_run",
      p_subject_id: run,
      p_limit: CHAIN_EVENTS_PAGE,
    });
  }

  for (const status of contracts.REVIEW_STATUSES) {
    await reader.pages("list_reviews", { p_status: status });
  }
  for (const review of reviews) {
    await reader.call("get_review", { p_review_id: review });
    await reader.call("get_review_advice", { p_review_id: review });
  }

  await reader.pages("list_events");
  await reader.pages("list_stops");
  await reader.pages("list_stops", { p_include_cleared: true });
  return reader;
}

// ---------------------------------------------------------------------------
// The session.
// ---------------------------------------------------------------------------

interface Session {
  readonly now: string;
  readonly minutesAfterMidnight: number;
  readonly member: AuthUser;
  readonly providerTarget: string;
  readonly emailHash: string;
  readonly idMap: IdMap;
  readonly scenarios: Record<Scenario, RecordedCall[]>;
}

/** Plants a stop as the owner, reads as the member, and undoes the stop. */
async function withPlantedStop(
  tx: TxClient,
  member: AuthUser,
  plant: () => Promise<void>,
  read: () => Promise<void>,
): Promise<void> {
  await tx.query("reset role");
  await tx.query("savepoint recorded_scenario");
  await plant();
  await actAs(tx, member);
  await read();
  await tx.query("reset role");
  await tx.query("rollback to savepoint recorded_scenario");
  await actAs(tx, member);
}

async function recordSession(tx: TxClient): Promise<Session> {
  const [clock] = await rows<{ now: string; minutes: number }>(
    tx,
    `select ops.cos_ts(now()) as now,
            extract(epoch from now() - date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')::int / 60 as minutes`,
    [],
  );
  const fixture = await buildFixture(tx);
  const member = await createAuthUser(tx);
  await tx.query("select ops.grant_membership($1, $2, $3, $4, $5)", [
    fixture.tenantId,
    member.userId,
    DISPLAY_NAME,
    GRANTOR,
    GRANT_REASON,
  ]);
  const [grant] = await rows<{ principal_id: string; hash: string }>(
    tx,
    `select p.id as principal_id, m.email_at_grant_sha256 as hash
       from ops.tenant_memberships m join ops.principals p on p.id = m.principal_id
      where p.issuer = 'supabase_auth' and p.subject = $1 and m.revoked_at is null`,
    [member.userId],
  );
  must(grant !== undefined, "the member holds one active membership");

  // Every row a response can name, by a stable label, in creation order.
  const labelled = async (sql: string) =>
    (
      await rows<{ id: string; label: string }>(tx, sql, [fixture.tenantId])
    ).map(({ id, label }) => [id, label] as const);
  const pairs: (readonly [string, string])[] = [
    [fixture.tenantId, "tenant:main"],
    [grant.principal_id, "principal:member"],
    ...(await labelled(
      "select id, 'company:' || slug as label from ops.companies where tenant_id = $1 order by slug",
    )),
    ...(await labelled(
      "select id, 'department:' || slug as label from ops.departments where tenant_id = $1 order by slug",
    )),
    ...(await labelled(
      "select id, 'agent:' || slug as label from ops.agents where tenant_id = $1 order by slug",
    )),
    ...(await labelled(
      "select id, 'channel:' || mode as label from ops.communication_channels where tenant_id = $1 order by mode",
    )),
    ...(await labelled(
      `select l.id, 'limit:' || l.scope || coalesce(':' || c.slug, '') as label
         from ops.spend_limits l left join ops.companies c on c.id = l.company_id
        where l.tenant_id = $1 and l.ended_at is null order by 2`,
    )),
    ...Object.entries(fixture.named).map(([label, id]) => [id, label] as const),
  ];
  const events = await labelled(
    `select id, 'event:' || lpad((row_number() over (order by seq))::text, 3, '0') as label
       from ops.events where tenant_id = $1 order by seq`,
  );
  pairs.push(...events);
  const eventLabels = events.length;

  const targets = await targetsOf(tx, fixture.tenantId);
  await actAs(tx, member);
  const tenant = await readTenant(tx, targets);

  // An ACTIVE tenant job_kind stop, the only active stop: every agent of the
  // tenant is stopped by it. The fixture's own active stops are cleared first,
  // or an agent two stops cover would be shown the one the server's id
  // tie-break picks (every planted stop trips at the transaction's now()).
  let kindStop = "";
  const kindReader = createReader(tx);
  await withPlantedStop(
    tx,
    member,
    async () => {
      await tx.query(
        `update ops.execution_stops set cleared_by = $2, cleared_reason = 'Synthetic desk pauses over'
          where tenant_id = $1 and cleared_at is null`,
        [fixture.tenantId, ACTOR],
      );
      const [stop] = await rows<{ id: string }>(
        tx,
        `insert into ops.execution_stops (scope, tenant_id, job_kind, reason, tripped_by)
         values ('job_kind', $1, 'agent_run.execute', 'Synthetic hold of every agent run', $2)
         returning id`,
        [fixture.tenantId, ACTOR],
      );
      kindStop = stop.id;
    },
    async () => {
      await kindReader.pages("list_stops");
      await kindReader.pages("list_stops", { p_include_cleared: true });
      await kindReader.call("overview");
      await kindReader.call("list_agents");
    },
  );
  pairs.push([kindStop, "stop:kind-active"]);

  // A platform stop: the tenant sees only globalAdmissionBlocked, and its
  // queued work held.
  const platformReader = createReader(tx);
  await withPlantedStop(
    tx,
    member,
    async () => {
      await tx.query(
        `insert into ops.execution_stops (scope, reason, tripped_by)
         values ('global', 'Synthetic platform drill', 'system:dbtest-recorded-platform')`,
      );
    },
    async () => {
      await platformReader.call("overview");
      await platformReader.call("spend_summary");
      await platformReader.call("list_agents");
    },
  );
  // A task at the 20-run cap: its refused run, then retries of it that the
  // annex's zero company budget refuses (cancels) at request time.
  const manyReader = createReader(tx);
  const manyTask = fixture.named["task:refused-by-budget"];
  await tx.query("reset role");
  await tx.query("savepoint recorded_scenario");
  const [annex] = await rows<{ id: string }>(
    tx,
    "select id from ops.agents where tenant_id = $1 and slug = 'annex-triage'",
    [fixture.tenantId],
  );
  let previous = fixture.named["run:refused-by-budget"];
  for (let n = 1; n < TASK_RUNS_CAP; n += 1) {
    const [requested] = await rows<{ id: string }>(
      tx,
      "select ops.request_agent_run($1, $2, $3, 'lead_triage', $4, 'dbtest-cos-recorder', $5) as id",
      [fixture.tenantId, manyTask, annex.id, `dbtest-cos-many-${n}`, previous],
    );
    const [retry] = await rows<{ id: string; status: string }>(
      tx,
      "select id, status from ops.agent_runs where id = $1",
      [requested.id],
    );
    must(retry.status === "cancelled", `retry ${n} is refused by the budget`);
    pairs.push([retry.id, `run:many-${String(n).padStart(2, "0")}`]);
    previous = retry.id;
  }
  const [labelledEvents] = await rows<{ n: number }>(
    tx,
    "select count(*)::int as n from ops.events where tenant_id = $1",
    [fixture.tenantId],
  );
  pairs.push(
    ...(
      await rows<{ id: string; label: string }>(
        tx,
        `select id, 'event:' || lpad((row_number() over (order by seq))::text, 3, '0') as label
           from ops.events where tenant_id = $1 order by seq`,
        [fixture.tenantId],
      )
    )
      .slice(eventLabels)
      .map(({ id, label }) => [id, label] as const),
  );
  must(labelledEvents.n > eventLabels, "the retries wrote events");
  const manyRuns = await ids(
    tx,
    "select id from ops.agent_runs where tenant_id = $1 and task_id = $2 order by id",
    fixture.tenantId,
    manyTask,
  );
  must(manyRuns.length === TASK_RUNS_CAP, "the task holds exactly the cap");
  await actAs(tx, member);
  await manyReader.call("get_task", { p_task_id: manyTask });
  await manyReader.pages("list_events", {
    p_subject_type: "task",
    p_subject_id: manyTask,
    p_limit: CHAIN_EVENTS_PAGE,
  });
  for (const run of manyRuns) {
    await manyReader.call("get_run", { p_run_id: run });
    await manyReader.pages("list_events", {
      p_subject_type: "agent_run",
      p_subject_id: run,
      p_limit: CHAIN_EVENTS_PAGE,
    });
  }
  await tx.query("reset role");
  await tx.query("rollback to savepoint recorded_scenario");

  return {
    now: clock.now,
    minutesAfterMidnight: clock.minutes,
    member,
    providerTarget: fixture.providerTarget,
    emailHash: grant.hash,
    idMap: buildIdMap(pairs),
    scenarios: {
      tenant: tenant.calls,
      "tenant-kind-stop": kindReader.calls,
      "platform-stop": platformReader.calls,
      "task-many-runs": manyReader.calls,
    },
  };
}

// ---------------------------------------------------------------------------
// The files.
// ---------------------------------------------------------------------------

const fileOf = (name: string) => join(RECORDED_DIR, `${name}.json`);

const serialise = async (value: unknown, file: string): Promise<string> =>
  format(JSON.stringify(value), {
    ...(await resolveConfig(file)),
    parser: "json",
    filepath: file,
  });

const readCommitted = (name: string): unknown => {
  try {
    return JSON.parse(readFileSync(fileOf(name), "utf8"));
  } catch {
    return undefined;
  }
};

/** What each file holds: the scenarios' calls, and the label index. */
const filesOf = (
  normalised: Record<string, readonly RecordedCall[]>,
  labels: Readonly<Record<string, string>>,
): Record<string, unknown> => ({
  ids: { generatedBy: GENERATED_BY, ids: labels },
  ...Object.fromEntries(
    Object.entries(normalised).map(([name, calls]) => [
      name,
      { generatedBy: GENERATED_BY, calls },
    ]),
  ),
});

beforeAll(async () => {
  admin = adminPool();
  owner = createWorkerDatabase({ connectionString: ADMIN_URL, max: 2 });
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await owner?.close();
  await admin?.end();
});

describe("the recorded company_os_api responses of the browser tests", () => {
  let session: Session;
  let files: Record<string, unknown>;

  beforeAll(async () => {
    session = await rolledBack(recordSession);
    const normalised = normalise(session.scenarios, session.idMap, session.now);
    files = filesOf(
      normalised.scenarios as Record<string, readonly RecordedCall[]>,
      session.idMap.labels,
    );
  });

  it("records every one of the 15 reads, and every recorded answer parses with its contract", () => {
    const tenant = (files.tenant as { calls: RecordedCall[] }).calls;
    expect([...new Set(tenant.map((call) => call.operation))].sort()).toEqual(
      [...COMPANY_OS_OPERATION_NAMES].sort(),
    );
    const broken = Object.entries(files).flatMap(([name, file]) =>
      name === "ids"
        ? []
        : (file as { calls: RecordedCall[] }).calls.flatMap((call, index) => {
            const parsed = COMPANY_OS_OPERATIONS[
              call.operation
            ].response.safeParse(call.response);
            return parsed.success
              ? []
              : [
                  `${name}[${index}] ${call.operation}: ${parsed.error.message}`,
                ];
          }),
    );
    expect(broken).toEqual([]);
  });

  it("holds synthetic values only: no identity, contact, message or call value the fixture planted", () => {
    const text = JSON.stringify(files).toLowerCase();
    const raw = JSON.stringify(session.scenarios).toLowerCase();
    const planted: [string, string][] = [
      ["a raw actor label", ACTOR],
      ["the price's recorded_by", PRICE_RECORDER],
      ["the limits' set_by", LIMIT_SETTER],
      ["the membership's granted_by", GRANTOR],
      ["the membership's grant reason", GRANT_REASON],
      ["the principal's display name", DISPLAY_NAME],
      ["the member's email", session.member.email],
      ["the member's email hash", session.emailHash],
      ["the member's auth user id", session.member.userId],
      ["the member's session id", session.member.sessionId],
      ["the member's given name", AUTH_GIVEN_NAME],
      ["the member's family name", AUTH_FAMILY_NAME],
      ["the stored body or draft", "cos-sentinel"],
      ["the task title", TASK_TITLE],
      ["the agent's role", AGENT_ROLE],
      ["the sender's number", PHONE],
      ["the provider target", session.providerTarget],
      ["a synthetic contact ref", SYNTHETIC_CONTACT_PREFIX],
      ["a synthetic message id", SYNTHETIC_MESSAGE_ID_PREFIX],
      ["a WhatsApp message id", WHATSAPP_MESSAGE_ID_PREFIX],
      ["the provider request id", PROVIDER_REQUEST_ID],
      ["the provider response id", PROVIDER_RESPONSE_ID],
      ["the retry's idempotency key", RETRY_IDEMPOTENCY_KEY],
      ["the worker's lease label", WORKER],
    ];
    const leaked = planted
      .filter(
        ([, value]) =>
          text.includes(value.toLowerCase()) ||
          raw.includes(value.toLowerCase()),
      )
      .map(([label]) => label);
    expect(leaked).toEqual([]);
    // Nothing email-shaped at all, and not a single live id: every uuid in a
    // recording is one the normaliser minted.
    expect(text).not.toMatch(/@/);
    expect(
      [
        ...text.matchAll(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        ),
      ]
        .map((match) => match[0])
        .filter((id) => !id.startsWith("00000000-0000-4000-8000-")),
    ).toEqual([]);
    expect(
      createHash("sha256")
        .update(session.member.email.toLowerCase())
        .digest("hex"),
    ).toBe(session.emailHash);
  });

  it("reaches the states every screen shows", () => {
    const calls = (name: string) =>
      (files[name] as { calls: RecordedCall[] }).calls;
    const answer = (name: string, operation: string) =>
      calls(name).find((call) => call.operation === operation)
        ?.response as Record<string, unknown>;
    const agents = answer("tenant", "list_agents")
      .items as contracts.AgentSummary[];
    expect(new Set(agents.map((a) => a.activity))).toEqual(
      new Set(contracts.AGENT_ACTIVITIES),
    );
    expect(new Set(agents.map((a) => a.availability))).toEqual(
      new Set(contracts.AGENT_AVAILABILITIES),
    );
    const kindAgents = answer("tenant-kind-stop", "list_agents")
      .items as contracts.AgentSummary[];
    expect(
      kindAgents
        .filter((a) => a.evidence.inactiveUnit === null)
        .map((a) => a.availability),
    ).not.toContain("available");
    const kindStops = calls("tenant-kind-stop")
      .filter((call) => call.operation === "list_stops")
      .flatMap((call) => (call.response as contracts.ExecutionStopList).items);
    expect(
      kindStops.some(
        (stop) => stop.scope === "job_kind" && stop.clearedAt === null,
      ),
    ).toBe(true);
    expect(
      (answer("platform-stop", "overview") as contracts.OverviewSummary)
        .platform.globalAdmissionBlocked,
    ).toBe(true);
    expect(
      (answer("tenant", "overview") as contracts.OverviewSummary).platform
        .globalAdmissionBlocked,
    ).toBe(false);
    const feed = calls("tenant").filter(
      (call) =>
        call.operation === "list_events" && !("p_subject_id" in call.args),
    );
    expect(feed.length).toBeGreaterThan(1);
  });

  it("matches the recordings committed under src/company-os/testing/recorded, or writes them when COMPANY_OS_RECORD=1", async (context) => {
    if (session.minutesAfterMidnight < MIDNIGHT_MARGIN_MINUTES) {
      // The fixture reaches ten minutes back: this close after midnight UTC
      // its rows straddle two days, and the "today" counts move.
      context.skip();
    }
    if (RECORD) {
      for (const [name, value] of Object.entries(files)) {
        writeFileSync(
          fileOf(name),
          await serialise(value, fileOf(name)),
          "utf8",
        );
      }
    }
    const drifted = Object.entries(files).flatMap(([name, value]) => {
      const difference = firstDifference(readCommitted(name), value);
      return difference === null ? [] : [`${name}.json at ${difference}`];
    });
    expect(
      drifted,
      "the committed recordings no longer match what the projections return: re-record with COMPANY_OS_RECORD=1 and review the diff",
    ).toEqual([]);
  });

  it("leaves nothing behind", async () => {
    const { rows: members } = await admin.query<{ n: number }>(
      "select count(*)::int as n from auth.users where id = $1",
      [session.member.userId],
    );
    expect(members[0].n).toBe(0);
  });
});
