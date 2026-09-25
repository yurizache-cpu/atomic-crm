// The recorded Agenda the browser tests replay (Phase 3A), read from the REAL
// projection, never hand-built.
//
// The shared recordings (companyOsRecordedResponses.dbtest.ts) carry the
// overview of a tenant with no scheduling rows, because an agenda depends on
// the day: every window is keyed on local dates. So this suite records one
// agenda of its own, at a FIXED instant: one rolled-back owner transaction
// builds a fictional clinic's week in 2030 (bookings in every state, follow-ups
// due, overdue, awaiting the worker, scheduled and closed, a simulated
// calendar with synced, pending and uncertain syncs), then reads
// ops.cos_agenda(tenant, AS_OF). The projection is a pure function of its rows
// and that instant, so the answer is the same on every run. Its ids are mapped
// to deterministic ones through the fixture's labels (an id the recorder
// cannot place fails the recording), it is parsed with its contract and swept
// for every subject reference and actor label the fixture planted, and it is
// compared with src/company-os/testing/recorded/agenda.json:
//
//   COMPANY_OS_RECORD=1 SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//     SUPABASE_DB_PORT=54342 npx vitest run --config vitest.db.config.ts \
//     engine/domain/companyOsAgendaRecording.dbtest.ts
//
// Without COMPANY_OS_RECORD=1 nothing is written. All data is fictional and
// nothing outlives the transaction.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgendaSchema } from "../../contracts/company-os-api/index.ts";
import {
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";

const RECORDING = join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "src/company-os/testing/recorded/agenda.json",
);

/** Monday 2030-03-04, 10:30 in São Paulo. */
const AS_OF = "2030-03-04T13:30:00Z";
const ZONE = "America/Sao_Paulo";
const ACTOR = "agenda-recorder-actor-7c1d";
const SUBJECT_PREFIX = "lead:REC-";

let admin: Pool;

beforeAll(async () => {
  admin = adminPool();
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await admin?.end();
});

/** A São Paulo wall-clock time on a 2030 date (UTC-3, no DST). */
const at = (date: string, time: string): string => `${date}T${time}:00-03:00`;
const sp = (day: number, time: string): string =>
  at(`2030-03-${String(day).padStart(2, "0")}`, time);

interface Built {
  readonly tenantId: string;
  /** label -> live id, every row the agenda may name. */
  readonly labels: ReadonlyMap<string, string>;
}

async function one<T>(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<T> {
  const { rows } = await client.query<{ result: T }>(sql, params);
  return rows[0].result;
}

async function build(client: PoolClient): Promise<Built> {
  const labels = new Map<string, string>();
  const label = (name: string, id: string) => {
    labels.set(name, id);
    return id;
  };
  const tenantId = label(
    "tenant",
    await one<string>(
      client,
      "insert into ops.tenants (slug, name) values ('agenda-recording', 'Clínica fictícia') returning id as result",
      [],
    ),
  );
  const companyId = await one<string>(
    client,
    "select ops.create_company($1, 'clinica', 'Clínica fictícia', 'seed') as result",
    [tenantId],
  );
  const departmentId = await one<string>(
    client,
    "select ops.create_department($1, $2, 'atendimento', 'Atendimento', 'seed') as result",
    [tenantId, companyId],
  );
  await client.query("select ops.set_scheduling_timezone($1, $2, $3)", [
    tenantId,
    ZONE,
    ACTOR,
  ]);
  const resource = async (key: string, name: string) =>
    label(
      `resource:${key}`,
      await one<string>(
        client,
        "select ops.define_booking_resource($1, $2, $3, $4, $5, 'professional', $6) as result",
        [tenantId, companyId, departmentId, `agenda-${key}`, name, ACTOR],
      ),
    );
  const agendaA = await resource("a", "Agenda Profissional A");
  const agendaB = await resource("b", "Agenda Profissional B");
  const initial = label(
    "type:inicial",
    await one<string>(
      client,
      "select ops.define_booking_type($1, $2, 'atendimento-inicial', 'Atendimento inicial', 50, 0, 10, 60, $3) as result",
      [tenantId, companyId, ACTOR],
    ),
  );
  for (const r of [agendaA, agendaB]) {
    for (let weekday = 1; weekday <= 5; weekday += 1) {
      for (const [from, until] of [
        ["09:00", "12:00"],
        ["14:00", "18:00"],
      ]) {
        await client.query(
          "select ops.add_availability_rule($1, $2, $3, $4::time, $5::time, $6, '2030-01-01', null, $7)",
          [tenantId, r, weekday, from, until, ZONE, ACTOR],
        );
      }
    }
  }
  // A simulated calendar: every booking below requests a sync.
  await client.query(
    "select ops.configure_calendar_connection($1, $2, 'fake', 'Atendimento', true, $3)",
    [tenantId, companyId, ACTOR],
  );

  let bookings = 0;
  const book = async (r: string, startAt: string) => {
    bookings += 1;
    const answer = await one<{ booking_id: string }>(
      client,
      "select ops.create_booking($1, $2, $3, $4, null, null, $5, $6, $7, 'seed') as result",
      [
        tenantId,
        r,
        initial,
        startAt,
        `${SUBJECT_PREFIX}${bookings}`,
        `rec-${bookings}`,
        ACTOR,
      ],
    );
    return label(`booking:${bookings}`, answer.booking_id);
  };
  // Today, Monday 2030-03-04.
  const synced = await book(agendaA, sp(4, "09:00"));
  await book(agendaA, sp(4, "11:00"));
  const uncertain = await book(agendaB, sp(4, "14:00"));
  const cancelled = await book(agendaA, sp(4, "15:00"));
  const moved = await book(agendaB, sp(4, "16:00"));
  // The rest of the week.
  await book(agendaA, sp(5, "09:00"));
  await book(agendaB, sp(7, "14:00"));
  await client.query(
    "select ops.cancel_booking($1, $2, 'patient_request', $3, 'seed')",
    [tenantId, cancelled, ACTOR],
  );
  const successor = await one<{ booking_id: string }>(
    client,
    "select ops.reschedule_booking($1, $2, $3, 'rec-move', $4, 'seed') as result",
    [tenantId, moved, sp(6, "10:00"), ACTOR],
  );
  label("booking:successor", successor.booking_id);

  // Two creates settled as a worker would: one synced, one uncertain.
  const settle = async (
    bookingId: string,
    outcome: "synced" | "indeterminate",
  ) => {
    await client.query(
      `update ops.calendar_syncs set status = 'running', job_attempt = 1, provider_kind = 'fake'
        where booking_id = $1 and operation = 'create'`,
      [bookingId],
    );
    await client.query(
      `update ops.calendar_syncs
          set status = $2,
              external_event_id = case when $2 = 'synced' then 'fake-recorded-event' end,
              error_code = case when $2 = 'indeterminate' then 'provider_timeout' end
        where booking_id = $1 and operation = 'create'`,
      [bookingId, outcome],
    );
  };
  await settle(synced, "synced");
  await settle(uncertain, "indeterminate");

  // Follow-ups on the 3/7/10-day demo cadence, anchored in 2030 (past the
  // scheduling service's one-year horizon, so written as an owner would).
  const version = await one<{ version_id: string }>(
    client,
    "select ops.define_follow_up_policy_version($1, 'lead-cadence', 'Cadência de leads', '{4320,10080,14400}', $2) as result",
    [tenantId, ACTOR],
  );
  let plans = 0;
  const plan = async (anchorAt: string) => {
    plans += 1;
    const planId = label(
      `plan:${plans}`,
      await one<string>(
        client,
        `insert into ops.follow_up_plans (tenant_id, company_id, department_id, policy_version_id, anchor_at,
                                          subject_ref, idempotency_key, request_fingerprint, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, repeat('a', 64), $8) returning id as result`,
        [
          tenantId,
          companyId,
          departmentId,
          version.version_id,
          anchorAt,
          `${SUBJECT_PREFIX}plan-${plans}`,
          `rec-plan-${plans}`,
          ACTOR,
        ],
      ),
    );
    const steps: string[] = [];
    for (const [step, minutes] of [
      [1, 4320],
      [2, 10080],
      [3, 14400],
    ] as const) {
      const id = await one<string>(
        client,
        `insert into ops.follow_ups (tenant_id, company_id, plan_id, step_number, step_count, due_at)
         values ($1, $2, $3, $4, 3, $5::timestamptz + make_interval(mins => $6)) returning id as result`,
        [tenantId, companyId, planId, step, anchorAt, minutes],
      );
      const job = await one<string>(
        client,
        "select ops.enqueue_job($1, 'follow_up.due', jsonb_build_object('follow_up_id', $2::uuid), 100, now(), 5, 'rec:' || $2) as result",
        [tenantId, id],
      );
      await client.query(
        "update ops.follow_ups set job_id = $2 where id = $1",
        [id, job],
      );
      steps.push(label(`follow_up:${plans}.${step}`, id));
    }
    return steps;
  };
  const markDue = (id: string) =>
    client.query("update ops.follow_ups set status = 'due' where id = $1", [
      id,
    ]);
  // Overdue since Thursday, and due this morning; its third step comes Thursday.
  const [overdue, dueToday] = await plan(at("2030-02-25", "10:00"));
  await markDue(overdue);
  await markDue(dueToday);
  // Done on Tuesday, dismissed on Saturday; the third step is Wednesday.
  const [done, dismissed] = await plan(at("2030-02-23", "11:00"));
  await markDue(done);
  await client.query("select ops.complete_follow_up($1, $2, $3, 'seed')", [
    tenantId,
    done,
    ACTOR,
  ]);
  await client.query(
    "select ops.cancel_follow_up($1, $2, 'lead_replied', $3, 'seed')",
    [tenantId, dismissed, ACTOR],
  );
  // Due at 07:00 today and not yet marked: the worker has not run it.
  await plan(sp(1, "07:00"));
  return { tenantId, labels };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** A deterministic id per label, in label order. */
function mapIds(value: unknown, labels: ReadonlyMap<string, string>): unknown {
  const ordered = [...labels.keys()].sort();
  const byLive = new Map<string, string>();
  ordered.forEach((name, index) =>
    byLive.set(
      labels.get(name) as string,
      `00000000-0000-4000-a000-${(index + 1).toString(16).padStart(12, "0")}`,
    ),
  );
  const text = JSON.stringify(value).replace(UUID, (live) => {
    const mapped = byLive.get(live);
    if (!mapped)
      throw new Error(
        `the agenda names an id the recorder cannot place: ${live}`,
      );
    return mapped;
  });
  return JSON.parse(text);
}

async function record(): Promise<unknown> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const built = await build(client);
    const agenda = await one<unknown>(
      client,
      "select ops.cos_agenda($1, $2) as result",
      [built.tenantId, AS_OF],
    );
    return mapIds(agenda, built.labels);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("the recorded agenda is the real projection at a fixed instant", () => {
  it("parses with its contract, leaks nothing the fixture planted, and equals the committed recording", async () => {
    // Arrange / Act
    const agenda = await record();

    // Assert: the contract, and every state the screens need.
    const parsed = AgendaSchema.parse(agenda);
    expect(parsed.timezone).toBe(ZONE);
    expect(parsed.today).toBe("2030-03-04");
    expect(parsed.bookings.today.map((b) => b.status)).toEqual([
      "booked",
      "booked",
      "booked",
      "cancelled",
      "rescheduled",
    ]);
    expect(parsed.bookings.conflicts).toBe(0);
    expect(parsed.followUps).toMatchObject({
      due: 2,
      overdue: 1,
      awaitingProcessing: 1,
      closedRecently: 2,
    });
    expect(parsed.calendar.state).toBe("simulated");
    expect(parsed.calendar.upcomingSyncs.indeterminate).toBe(1);
    expect(parsed.availability).toHaveLength(2);
    const text = JSON.stringify(parsed);
    for (const planted of [
      SUBJECT_PREFIX,
      "REC-",
      ACTOR,
      "rec-",
      "fake-recorded-event",
      "provider_timeout",
    ]) {
      expect(text).not.toContain(planted);
    }

    const formatted = await format(JSON.stringify(parsed), {
      ...(await resolveConfig(RECORDING)),
      parser: "json",
    });
    if (process.env.COMPANY_OS_RECORD === "1") {
      writeFileSync(RECORDING, formatted);
    }
    expect(JSON.parse(readFileSync(RECORDING, "utf8"))).toEqual(parsed);
  });
});
