// Vocabulary parity (docs/PHASE_2C_BRIEF.md §9, §11, §7.3; stream S4): every
// closed vocabulary of contracts/company-os-api against the live database,
// through the real `pg` driver.
//
// companyOsContracts.test.ts proves the lists the engine already pins equal
// their engine copies. This file proves each list equals what SQL actually
// bounds or emits: the check constraint of the column it names, the lead_triage
// output contract (ops.agent_run_result_valid) for the advice vocabularies and
// bounds, the decision service for the review decisions, the literals of the
// projection helper that produces it, the facts ops.cos_event_facts lets out
// for each known event type, and the codes and fixed texts each identity gate
// raises. TENANT_STOP_SCOPES alone is derived, in the unit test. The response
// shapes themselves are companyOsContracts.dbtest.ts's subject. Read-only: it
// writes nothing.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import * as contracts from "../../contracts/company-os-api/index.ts";
import {
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";
import { ACTOR, BODY, PHONE } from "./testSupport/companyOsContractFixture.ts";

const { COMPANY_OS_OPERATION_NAMES, EVENT_FACTS, KNOWN_EVENT_TYPES } =
  contracts;

let admin: Pool;

const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** The quoted literals of a SQL text fragment. */
const literals = (text: string): string[] =>
  [...text.matchAll(/'([a-z][a-z0-9_.:-]*)'/g)].map((m) => m[1]);

async function constraintDefinition(
  table: string,
  name: string,
): Promise<string> {
  const { rows } = await admin.query<{ definition: string }>(
    `select pg_get_constraintdef(k.oid) as definition
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ops' and c.relname = $1 and k.conname = $2`,
    [table, name],
  );
  if (rows.length !== 1) throw new Error(`no constraint ops.${table}.${name}`);
  return rows[0].definition;
}

async function functionSource(name: string): Promise<string> {
  const { rows } = await admin.query<{ source: string }>(
    `select p.prosrc as source from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ops' and p.proname = $1`,
    [name],
  );
  if (rows.length !== 1) throw new Error(`no single function ops.${name}`);
  return rows[0].source;
}

/** The text of the first match of `pattern` in `source`, or a failed case. */
function section(source: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(source);
  if (!match) throw new Error(`${what} not found`);
  return match[1];
}

beforeAll(async () => {
  admin = adminPool();
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await admin?.end();
});

/** Each closed vocabulary and the check constraint (table.name) that bounds it. */
const CHECKED: Readonly<Record<string, readonly [readonly string[], string]>> =
  {
    TASK_STATUSES: [contracts.TASK_STATUSES, "tasks.tasks_status_check"],
    AGENT_RUN_STATUSES: [
      contracts.AGENT_RUN_STATUSES,
      "agent_runs.agent_runs_status_check",
    ],
    REVIEW_STATUSES: [
      contracts.REVIEW_STATUSES,
      "review_items.review_items_status_check",
    ],
    OUTBOUND_STATUSES: [
      contracts.OUTBOUND_STATUSES,
      "outbound_messages.outbound_messages_status_check",
    ],
    EXECUTION_STOP_SCOPES: [
      contracts.EXECUTION_STOP_SCOPES,
      "execution_stops.execution_stops_scope_check",
    ],
    JOB_STATUSES: [contracts.JOB_STATUSES, "jobs.jobs_status_check"],
    JOB_FAILURE_CLASSES: [
      contracts.JOB_FAILURE_CLASSES,
      "jobs.jobs_last_error_class_check",
    ],
    INBOUND_SOURCE_KINDS: [
      contracts.INBOUND_SOURCE_KINDS,
      "inbound_messages.inbound_messages_source_kind_check",
    ],
    CHANNEL_MODES: [
      contracts.CHANNEL_MODES,
      "communication_channels.communication_channels_mode_check",
    ],
    EVENT_SUBJECT_TYPES: [
      contracts.EVENT_SUBJECT_TYPES,
      "events.events_subject_type_check",
    ],
  };

describe("the contract vocabularies equal the database's", () => {
  it.each(Object.entries(CHECKED))("%s", async (_name, [vocabulary, where]) => {
    const [table, constraint] = where.split(".");
    const definition = await constraintDefinition(table, constraint);
    expect(sorted(new Set(literals(definition)))).toEqual(sorted(vocabulary));
  });

  it("the error categories are exactly those the status-pair constraint admits", async () => {
    const definition = await constraintDefinition(
      "agent_runs",
      "agent_runs_category_status_pair",
    );
    const categories = [
      ...[
        ...definition.matchAll(/error_category = ANY \(ARRAY\[([^\]]*)\]\)/g),
      ].flatMap((m) => literals(m[1])),
      ...[...definition.matchAll(/error_category = '([a-z_]+)'/g)].map(
        (m) => m[1],
      ),
    ];
    expect(sorted(new Set(categories))).toEqual(
      sorted(contracts.AGENT_RUN_ERROR_CATEGORIES),
    );
  });

  it("the contact resolutions, the tenant's limit scopes and the stop origins", async () => {
    const transport = await constraintDefinition(
      "inbound_messages",
      "inbound_messages_transport_shape",
    );
    expect(
      sorted(
        literals(
          section(
            transport,
            /contact_resolution = ANY \(ARRAY\[([^\]]*)\]\)/,
            "the contact resolutions",
          ),
        ),
      ),
    ).toEqual(sorted(contracts.CONTACT_RESOLUTIONS));

    const limits = await constraintDefinition(
      "spend_limits",
      "spend_limits_scope_check",
    );
    expect(sorted(literals(limits).filter((s) => s !== "global"))).toEqual(
      sorted(contracts.TENANT_LIMIT_SCOPES),
    );

    const { rows } = await admin.query<{ expression: string }>(
      `select pg_get_expr(d.adbin, d.adrelid) as expression
         from pg_attrdef d
         join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        where d.adrelid = 'ops.execution_stops'::regclass and a.attname = 'origin'`,
    );
    const origins = [
      ...rows[0].expression.matchAll(/(?:THEN|ELSE) '([a-z]+)'/g),
    ].map((m) => m[1]);
    expect(sorted(origins)).toEqual(sorted(contracts.STOP_ORIGINS));
  });

  it("the advice vocabularies and bounds are the lead_triage output contract's", async () => {
    // Only the lead_triage branch: task_assessment has an outcome list too.
    const branch = section(
      await functionSource("agent_run_result_valid"),
      /if p_capability = 'lead_triage' then(.*?)return true;/s,
      "the lead_triage branch",
    );
    const listed = (field: RegExp, what: string): string[] =>
      sorted(literals(section(branch, field, what)));
    expect(
      listed(/\(p_result ->> 'outcome'\) not in \(([^)]*)\)/, "outcomes"),
    ).toEqual(sorted(contracts.LEAD_TRIAGE_OUTCOMES));
    expect(
      listed(/\(p_result ->> 'intent'\) not in \(([^)]*)\)/, "intents"),
    ).toEqual(sorted(contracts.LEAD_TRIAGE_INTENTS));
    expect(
      listed(/\(p_result ->> 'priority'\) not in \(([^)]*)\)/, "priorities"),
    ).toEqual(sorted(contracts.LEAD_TRIAGE_PRIORITIES));
    expect(listed(/\(v_flag #>> '\{\}'\) not in \(([^)]*)\)/, "flags")).toEqual(
      sorted(contracts.LEAD_TRIAGE_FLAGS),
    );
    const bound = (pattern: RegExp, what: string): number =>
      Number(section(branch, pattern, what));
    expect(
      bound(
        /char_length\(p_result ->> 'summary'\) not between 1 and (\d+)/,
        "the summary bound",
      ),
    ).toBe(contracts.TRIAGE_SUMMARY_MAX_LENGTH);
    expect(
      bound(
        /char_length\(p_result ->> 'recommended_next_action'\) not between 1 and (\d+)/,
        "the next action bound",
      ),
    ).toBe(contracts.NEXT_ACTION_MAX_LENGTH);
    expect(
      bound(
        /jsonb_array_length\(p_result -> 'flags'\) > (\d+)/,
        "the flag bound",
      ),
    ).toBe(contracts.MAX_TRIAGE_FLAGS);
  });

  it("the review decisions are exactly those the decision service takes", async () => {
    const service = await functionSource("record_review_decision");
    expect(
      sorted(
        literals(
          section(service, /p_decision not in \(([^)]*)\)/, "the decisions"),
        ),
      ),
    ).toEqual(sorted(contracts.REVIEW_DECISIONS));
  });

  it("the projection helpers emit exactly the contract's vocabularies", async () => {
    const eventSource = await functionSource("cos_event_source");
    expect(
      sorted(literals(section(eventSource, /in \(([^)]*)\)/, "the sources"))),
    ).toEqual(sorted(contracts.EVENT_SOURCES));
    expect(
      literals(section(eventSource, /else ('[a-z]+')/, "the fallback")),
    ).toEqual([contracts.OTHER_EVENT_SOURCE]);

    const eventKnown = await functionSource("cos_event_known");
    expect(sorted(literals(eventKnown))).toEqual(sorted(KNOWN_EVENT_TYPES));

    const advice = await functionSource("read_review_advice");
    expect(
      sorted([...advice.matchAll(/'withheld', '([a-z_]+)'/g)].map((m) => m[1])),
    ).toEqual(sorted(contracts.ADVICE_WITHHELD_REASONS));

    const runSummary = await functionSource("cos_run_summary");
    const attention = section(
      runSummary,
      /'attention', case(.*?)end,/s,
      "the attention reasons",
    );
    expect(
      sorted([...attention.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1])),
    ).toEqual(sorted(contracts.RUN_ATTENTION_REASONS));

    const runDetail = await functionSource("read_agent_run_detail");
    const steps = literals(
      section(runDetail, /je\.event in \(([^)]*)\)/, "the job steps"),
    );
    expect(sorted(steps.map((step) => `job_${step}`))).toEqual(
      sorted(contracts.JOB_STEPS),
    );
    const jobEvents = literals(
      await constraintDefinition("job_events", "job_events_event_check"),
    );
    for (const step of steps) expect(jobEvents).toContain(step);

    const state = await functionSource("agent_operational_state");
    const outcomes = (label: string, end: string): string[] =>
      [
        ...section(
          state,
          new RegExp(`'${label}', case(.*?)${end}`, "s"),
          label,
        ).matchAll(/(?:then|else) '([a-z_]+)'/g),
      ].map((m) => m[1]);
    expect(sorted(new Set(outcomes("availability", "end,")))).toEqual(
      sorted(contracts.AGENT_AVAILABILITIES),
    );
    expect(sorted(new Set(outcomes("activity", "end,")))).toEqual(
      sorted(contracts.AGENT_ACTIVITIES),
    );
    expect(sorted(new Set(outcomes("inactiveUnit", "end\\)")))).toEqual(
      sorted(contracts.ORG_UNITS),
    );

    const spendStatus = await functionSource("spend_status");
    expect(
      sorted(
        [...spendStatus.matchAll(/(?:then|else) '([a-z_]+)'/g)].map(
          (m) => m[1],
        ),
      ),
    ).toEqual(sorted(contracts.SPEND_ADMISSIONS));
    // The overview reports the tenant row's admission, or its own fallback.
    const fallback = section(
      await functionSource("read_overview"),
      /'tenantAdmission', coalesce\(.*?\), '([a-z_]+)'\)/s,
      "the admission fallback",
    );
    expect(sorted([...contracts.SPEND_ADMISSIONS, fallback])).toEqual(
      sorted(contracts.TENANT_ADMISSIONS),
    );
  });

  it("maps a pinned source to itself and anything else to other, and knows exactly the known types", async () => {
    const { rows } = await admin.query<{
      given: string;
      shown: string;
      known: boolean;
    }>(
      `select x as given, ops.cos_event_source(x) as shown, ops.cos_event_known(x) as known
         from unnest($1::text[]) as x`,
      [
        [
          ...contracts.EVENT_SOURCES,
          "legacy-import",
          ...KNOWN_EVENT_TYPES,
          "dbtest.unknown_kind",
        ],
      ],
    );
    const shown = new Map(rows.map((row) => [row.given, row.shown]));
    for (const source of contracts.EVENT_SOURCES) {
      expect(shown.get(source)).toBe(source);
    }
    expect(shown.get("legacy-import")).toBe(contracts.OTHER_EVENT_SOURCE);
    expect(
      sorted(rows.filter((row) => row.known).map((row) => row.given)),
    ).toEqual(sorted(KNOWN_EVENT_TYPES));
  });

  it("lets out, for each known event type, exactly the facts its contract names, and nothing for another", async () => {
    // Every key any type allows, plus keys none may carry. The ids name no row,
    // so they come back classified as null.
    const payload = {
      decision: "accepted",
      from_status: "queued",
      to_status: "assigned",
      channel_id: randomUUID(),
      reason: "contact_not_found",
      mode: "test",
      active: true,
      outbound_message_id: randomUUID(),
      review_item_id: randomUUID(),
      status: "delivered",
      previous: "sent",
      step: 2,
      operation: "update",
      error_code: "provider_timeout",
      marked_by: ACTOR,
      body: BODY,
      contact_ref: PHONE,
    };
    const types = [...KNOWN_EVENT_TYPES, "dbtest.unknown_kind"];
    const { rows } = await admin.query<{ type: string; facts: unknown }>(
      `select x as type, ops.cos_event_facts($1, x, $2::jsonb) as facts
         from unnest($3::text[]) as x`,
      [randomUUID(), JSON.stringify(payload), types],
    );
    expect(rows).toHaveLength(types.length);
    for (const { type, facts } of rows) {
      const schema = contracts.isKnownEventType(type)
        ? EVENT_FACTS[type]
        : contracts.NoFactsSchema;
      const parsed = schema.safeParse(facts);
      expect(parsed.error?.issues ?? [], type).toEqual([]);
      expect(JSON.stringify(facts), type).not.toMatch(
        /COS-SENTINEL|example\.test|5511900000771/,
      );
    }
  });

  it("each gate raises only the contract's codes, with the contract's fixed text", async () => {
    const { rows } = await admin.query<{ name: string; source: string }>(
      `select p.proname as name, p.prosrc as source
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ops' and p.proname like 'gate\\_%'
        order by p.proname`,
    );
    expect(sorted(rows.map((row) => row.name.slice("gate_".length)))).toEqual(
      sorted([
        ...COMPANY_OS_OPERATION_NAMES,
        ...contracts.COMPANY_OS_ACT_NAMES,
      ]),
    );
    for (const { name, source } of rows) {
      const operation = name.slice(
        "gate_".length,
      ) as contracts.CompanyOsFunction;
      const raised = [
        ...source.matchAll(
          /errcode = '([A-Z0-9]{5})', message = 'company_os_api\.([a-z_]+): ([^']+)'/g,
        ),
      ];
      // One fixed, data-free message per code (brief §7.3). Only the trip
      // answers lock contention, with the one retryable code (owner S0-B).
      expect(
        raised.map((m) => m[1]),
        name,
      ).toEqual(
        operation === "trip_stop"
          ? ["OS400", "OS401", "OS403", "OS404", "OS409", "OS429", "OS500"]
          : ["OS400", "OS401", "OS403", "OS404", "OS409", "OS500"],
      );
      for (const [, code, op, text] of raised) {
        expect(contracts.isOsErrorCode(code), `${name} ${code}`).toBe(true);
        expect(op, name).toBe(operation);
        expect(`company_os_api.${op}: ${text}`, `${name} ${code}`).toBe(
          new contracts.CompanyOsApiError(
            operation,
            code as contracts.OsErrorCode,
          ).message,
        );
      }
    }
  });
});
