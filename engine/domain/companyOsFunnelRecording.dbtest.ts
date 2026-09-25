// The recorded commercial funnel the browser tests replay (Phase 3B.1), read
// from the REAL projection, never hand-built.
//
// The shared recordings (companyOsRecordedResponses.dbtest.ts) carry the
// overview of a tenant whose CRM stores no stage configuration, so their
// funnel is stages_not_configured. This suite records one populated funnel of
// its own, at a FIXED instant. One rolled-back transaction:
//   * empties the CRM, which cascades every older observation;
//   * gives a fresh tenant the local CRM and the clinic's stage configuration;
//   * builds the synthetic opportunities of engine/cli/funnelDemoData.ts
//     relative to AS_OF;
//   * plants the ledger's observations in 2030. The observing trigger is off
//     for the build, because it stamps the real clock and no fixed recording
//     could hold it; the ledger's own rules are proven by
//     supabase/tests/commercial_funnel.sql and commercialFunnelLedger.dbtest.ts;
//   * then reads ops.cos_commercial_funnel(tenant, AS_OF).
//
// The CRM's deal ids are mapped to deterministic references by fixture label
// (a reference the recorder cannot place fails the recording). The result is
// parsed with its contract, swept for every title, name and click id the
// fixture planted, and compared with src/company-os/testing/recorded/funnel.json:
//
//   COMPANY_OS_RECORD=1 SUPABASE_DB_CONTAINER=supabase_db_atomic-crm-e2e \
//     SUPABASE_DB_PORT=54342 npx vitest run --config vitest.db.config.ts \
//     engine/domain/companyOsFunnelRecording.dbtest.ts
//
// Without COMPANY_OS_RECORD=1 nothing is written. All data is fictional and
// nothing outlives the transaction.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { format, resolveConfig } from "prettier";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AvailableFunnelSchema } from "../../contracts/company-os-api/index.ts";
import {
  FUNNEL_DEMO_CONVERTED,
  FUNNEL_DEMO_DEALS,
  FUNNEL_DEMO_STAGES,
  daysBefore,
  nextActionAt,
  type FunnelDemoOrigin,
} from "../cli/funnelDemoData.ts";
import {
  adminPool,
  assertTargetDatabase,
} from "../worker/testSupport/dbFixture.ts";

const RECORDING = join(
  fileURLToPath(new URL("../../", import.meta.url)),
  "src/company-os/testing/recorded/funnel.json",
);

/** Monday 2030-03-04, 10:30 in São Paulo. */
const AS_OF = new Date("2030-03-04T13:30:00Z");
const ZONE = "America/Sao_Paulo";
const SENTINEL = "REC-FUNNEL-SENTINEL";

/** Observations planted in 2030: [deal label, from stage or null, to stage, hours before AS_OF]. */
const PLANTED: readonly (readonly [string, string | null, string, number])[] = [
  ["r10", "initial_session_paid", "initial_session_attended", 8 * 24],
  ["r05", "contact_started", "conversation_active", 5 * 24],
  ["r09", "initial_session_scheduled", "initial_session_paid", 4 * 24],
  ["r03", "new_lead", "contact_started", 3 * 24 + 1],
  ["r12", "continuity_offered", "continuity_accepted", 3 * 24],
  ["r07", "conversation_active", "initial_session_scheduled", 2 * 24 + 1],
  ["r13", "continuity_accepted", "continuity_converted", 2 * 24],
  ["r02", null, "new_lead", 24],
  ["r01", null, "new_lead", 2],
];

let admin: Pool;

beforeAll(async () => {
  admin = adminPool();
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await admin?.end();
});

async function one<T>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const { rows } = await client.query<{ result: T }>(sql, [...params]);
  return rows[0].result;
}

/** A contact per origin kind, returning the ids a deal links. */
async function contactsFor(
  client: PoolClient,
  origin: FunnelDemoOrigin,
  label: string,
): Promise<string[]> {
  if (origin === "none") return [];
  const contact = async (source: string) => {
    const id = await one<string>(
      client,
      "insert into public.contacts (first_name, last_name) values ($1, $2) returning id as result",
      [SENTINEL, label],
    );
    await client.query(
      `insert into public.acquisition_attributions (contact_id, source, campaign, gclid)
       values ($1, $2, $3, $4)`,
      [id, source, `${SENTINEL} campaign`, `${SENTINEL}-gclid`],
    );
    return id;
  };
  if (origin === "multiple") {
    return [await contact("Google Ads"), await contact("Orgânico")];
  }
  return [await contact(origin)];
}

async function build(client: PoolClient): Promise<{
  tenantId: string;
  deals: ReadonlyMap<string, number>;
}> {
  await client.query("delete from public.deals");
  await client.query("delete from public.acquisition_attributions");
  await client.query(
    "update ops.tenants set owns_local_crm = false where owns_local_crm",
  );
  const tenantId = await one<string>(
    client,
    `insert into ops.tenants (id, slug, name, owns_local_crm)
     values (gen_random_uuid(), 'rec-funnel', 'Recorded funnel', true) returning id as result`,
  );
  await client.query("select ops.set_scheduling_timezone($1, $2, $3)", [
    tenantId,
    ZONE,
    "rec-funnel-owner",
  ]);
  await client.query(
    `update public.configuration
        set config = jsonb_build_object('currency', 'BRL', 'dealStages', $1::jsonb,
                                        'dealPipelineStatuses', $2::jsonb)
      where id = 1`,
    [JSON.stringify(FUNNEL_DEMO_STAGES), JSON.stringify(FUNNEL_DEMO_CONVERTED)],
  );
  await client.query(
    "alter table public.deals disable trigger record_deal_stage_transition_trigger",
  );

  const deals = new Map<string, number>();
  for (const spec of FUNNEL_DEMO_DEALS) {
    const contactIds = await contactsFor(client, spec.origin, spec.label);
    const lostAt = spec.lost ? daysBefore(AS_OF, spec.lost.daysAgo) : null;
    const id = await one<string>(
      client,
      `insert into public.deals (name, stage, pipeline_stage, contact_ids, amount, description,
                                 created_at, stage_entered_at, next_action_at,
                                 lost_at, loss_reason_id, converted_at)
       values ($1, $2, $2, $3::bigint[], $4, $5, $6, $7, $8, $9,
               (select id from public.loss_reasons where code = $10), $11)
       returning id as result`,
      [
        `${SENTINEL} ${spec.label}`,
        spec.stage,
        contactIds,
        spec.amount,
        `${SENTINEL} note`,
        daysBefore(AS_OF, spec.createdDaysAgo),
        daysBefore(AS_OF, spec.enteredDaysAgo),
        nextActionAt(AS_OF, spec.nextAction),
        lostAt,
        spec.lost?.reason ?? null,
        spec.convertedDaysAgo === undefined
          ? null
          : daysBefore(AS_OF, spec.convertedDaysAgo),
      ],
    );
    deals.set(spec.label, Number(id));
  }
  for (const [label, from, to, hours] of PLANTED) {
    await client.query(
      `insert into public.deal_stage_transitions (deal_id, from_stage, to_stage, changed_at)
       values ($1, $2, $3, $4)`,
      [
        deals.get(label),
        from,
        to,
        new Date(AS_OF.getTime() - hours * 3_600_000),
      ],
    );
  }
  return { tenantId, deals };
}

/** A deterministic reference per fixture label: r01 -> 101, r17 -> 117. */
function mapRefs(value: unknown, deals: ReadonlyMap<string, number>): unknown {
  const byLive = new Map<number, number>();
  for (const [label, id] of deals) {
    byLive.set(id, 100 + Number(label.slice(1)));
  }
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (key !== "dealRef") return v;
    const mapped = byLive.get(v as number);
    if (mapped === undefined)
      throw new Error(
        `the funnel names a deal the recorder cannot place: ${v}`,
      );
    return mapped;
  });
}

async function record(): Promise<unknown> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const built = await build(client);
    const funnel = await one<unknown>(
      client,
      "select ops.cos_commercial_funnel($1, $2) as result",
      [built.tenantId, AS_OF],
    );
    return mapRefs(funnel, built.deals);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("the recorded funnel is the real projection at a fixed instant", () => {
  it("parses with its contract, leaks nothing the fixture planted, and equals the committed recording", async () => {
    // Arrange / Act
    const funnel = await record();

    // Assert: the contract, and every state the screen needs.
    const parsed = AvailableFunnelSchema.parse(funnel);
    expect(parsed.timezone).toBe(ZONE);
    expect(parsed.today).toBe("2030-03-04");
    expect(parsed.stages.map((s) => [s.code, s.total])).toEqual([
      ["new_lead", 2],
      ["contact_started", 2],
      ["conversation_active", 2],
      ["initial_session_scheduled", 2],
      ["initial_session_paid", 1],
      ["initial_session_attended", 1],
      ["continuity_offered", 1],
      ["continuity_accepted", 1],
      ["continuity_converted", 2],
    ]);
    expect(parsed.summary).toEqual({
      active: 12,
      overdue: 3,
      dueToday: 2,
      noNextAction: 3,
      convertedUndated: 0,
      windowDays: 30,
      newDeals: 15,
      converted: 2,
      lost: 3,
      conflicting: 0,
    });
    expect(parsed.origins.items).toEqual([
      { kind: "recorded", label: "Google Ads", count: 7 },
      { kind: "recorded", label: "Orgânico", count: 4 },
      { kind: "recorded", label: "Indicação", count: 3 },
      { kind: "unknown", label: null, count: 2 },
      { kind: "multiple", label: null, count: 1 },
    ]);
    expect(parsed.movements.coverageStart).toBe("2030-02-24T13:30:00.000000Z");
    expect(parsed.movements.items[0]).toMatchObject({
      dealRef: 101,
      entered: true,
      toStage: "new_lead",
    });
    expect(parsed.outcomes.lost.items.map((l) => l.reason)).toEqual([
      "Sem resposta",
      "Preço",
      "Adiado",
    ]);
    const text = JSON.stringify(parsed);
    for (const planted of [SENTINEL, "gclid", "campaign", "note"]) {
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
