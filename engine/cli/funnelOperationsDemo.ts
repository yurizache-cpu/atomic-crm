// The Phase 3B.2 demonstration: the operational commercial funnel, on a local
// database, through the real commercial acts.
//
//   npm run funnel:operations-demo
//
// with ADMIN_DATABASE_URL naming a database on this machine. LOCAL AND MANUAL
// ONLY; no CI job runs it. It first builds the Phase 3B.1 fictional funnel
// (engine/cli/funnelDemo.ts, which refuses a CRM that already holds any deal
// or contact), then:
//
//   1. as the owner, configures the commercial follow-up bridge EXPLICITLY:
//      a Company OS company and department of its own, and one follow-up
//      cadence (demo data: 1 hour, 2 days and 5 days after the anchor, so the
//      first occurrence falls on the next action itself and the others 2 and
//      5 days minus an hour later);
//   2. makes the four acts as the gates make them, each in its own
//      transaction, with a synthetic principal: a move, a next action set,
//      changed and cleared, a conversion and a loss, each with a follow-up
//      plan the bridge created first, and one act refused as stale;
//   3. prints the funnel's counts before and after, the ledger's observation
//      of the move, and each deal's follow-up plans.
//
// Everything is synthetic (no real name, phone, email or message). Nothing is
// sent, no model or external service is called, and a due follow-up is only
// operator work. Open opportunities are left for the owner to act on in the
// Funil comercial.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { CompanyOsError } from "../domain/errors.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  isEntryPoint,
  jsonLine,
} from "./cliOutput.ts";
import { runFunnelDemo, type FunnelDemoDependencies } from "./funnelDemo.ts";

const OWNER = "funnel-operations-demo";
/** A synthetic Company OS principal: the demo's acts are made in its name. */
const PRINCIPAL = "principal:00000000-0000-4000-8000-0000000de302";
const POLICY = "commercial-follow-up-demo";
/** Demo data only: the bridge plans whatever cadence the owner pins. */
const OFFSETS_MINUTES = [60, 2 * 1440, 5 * 1440];
const DAY_MS = 86_400_000;

/** The acts, as their gates call them once the member is resolved. */
const ACT_SQL = {
  move: "select ops.move_opportunity_as_member($1, $2, $3, $4, $5) as r",
  next: "select ops.set_opportunity_next_action_as_member($1, $2, $3, $4, $5) as r",
  convert: "select ops.convert_opportunity_as_member($1, $2, $3, $4, $5) as r",
  lose: "select ops.lose_opportunity_as_member($1, $2, $3, $4, $5) as r",
} as const;

type Act = keyof typeof ACT_SQL;

interface Placement {
  readonly tenantId: string;
}

async function tenantOwningCrm(tx: TxClient): Promise<Placement> {
  const { rows } = await tx.query<{ id: string }>(
    "select id from ops.tenants where owns_local_crm",
  );
  if (rows[0] === undefined) {
    throw new CompanyOsError("not_found", "no tenant owns the local CRM");
  }
  return { tenantId: rows[0].id };
}

/** The owner's explicit bridge: its own unit and cadence, then enabled. */
async function configureBridge(tx: TxClient, tenantId: string) {
  const unit = async (sql: string, params: unknown[]) =>
    (await tx.query<{ id: string }>(sql, params)).rows[0]?.id;
  const company =
    (await unit(
      "select id from ops.companies where tenant_id = $1 and slug = 'commercial-demo'",
      [tenantId],
    )) ??
    (await unit(
      "select ops.create_company($1, 'commercial-demo', 'Comercial (demonstração)', $2) as id",
      [tenantId, OWNER],
    ));
  const department =
    (await unit(
      "select id from ops.departments where tenant_id = $1 and company_id = $2 and slug = 'commercial-follow-up'",
      [tenantId, company],
    )) ??
    (await unit(
      "select ops.create_department($1, $2, 'commercial-follow-up', 'Acompanhamento comercial', $3) as id",
      [tenantId, company, OWNER],
    ));
  const { rows } = await tx.query<{ v: { version_id: string } }>(
    "select ops.define_follow_up_policy_version($1, $2, 'Acompanhamento comercial (demonstração)', $3, $4) as v",
    [tenantId, POLICY, OFFSETS_MINUTES, OWNER],
  );
  const bridge = await tx.query<{ b: Record<string, unknown> }>(
    "select ops.configure_commercial_follow_up_bridge($1, true, $2, $3, null, $4, $5) as b",
    [tenantId, company, department, rows[0].v.version_id, OWNER],
  );
  return { company, department, bridge: bridge.rows[0].b };
}

async function dealIds(tx: TxClient): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ label: string; id: string }>(
    `select substring(name from 'r[0-9]{2}$') as label, id from public.deals
      where name like 'Oportunidade sintética r%'`,
  );
  return new Map(rows.map((r) => [r.label, Number(r.id)]));
}

async function counts(tx: TxClient, tenantId: string) {
  const { rows } = await tx.query<{
    f: { status: string; summary?: Record<string, number> };
  }>("select ops.cos_commercial_funnel($1, clock_timestamp()) as f", [
    tenantId,
  ]);
  const s = rows[0].f.summary ?? {};
  return {
    active: s.active,
    overdue: s.overdue,
    dueToday: s.dueToday,
    noNextAction: s.noNextAction,
    converted: s.converted,
    lost: s.lost,
  };
}

/** A deal's follow-up plans, oldest first: status and anchor only. */
async function plansOf(tx: TxClient, tenantId: string, dealRef: number) {
  const { rows } = await tx.query<{ status: string; bridge: boolean }>(
    `select p.status, exists (select 1 from ops.commercial_follow_up_plans c where c.plan_id = p.id) as bridge
       from ops.follow_up_plans p
      where p.tenant_id = $1 and p.subject_ref = 'deal:' || $2::text
      order by p.created_at, p.id`,
    [tenantId, dealRef],
  );
  return rows.map((r) => `${r.status}${r.bridge ? "" : " (not the bridge's)"}`);
}

/** Tomorrow-or-later at a whole minute, `days` from now. */
const at = (days: number, hour: number): Date => {
  const d = new Date(Date.now() + days * DAY_MS);
  d.setUTCHours(hour + 3, 0, 0, 0); // hour on São Paulo's wall clock (UTC-3)
  return d;
};

export async function runFunnelOperationsDemo(
  dependencies: FunnelDemoDependencies,
): Promise<number> {
  const { env, stdout, stderr, openDatabase } = dependencies;
  const adminUrl = env[ADMIN_DATABASE_URL];
  if (!adminUrl || !loopbackDatabaseTarget(adminUrl)) {
    stderr(
      jsonLine({
        error: "configuration",
        message: `${ADMIN_DATABASE_URL} must name a database on this machine`,
      }),
    );
    return EXIT_USAGE;
  }
  const built = await runFunnelDemo(dependencies);
  if (built !== EXIT_OK) return built;

  const owner: WorkerDatabase = openDatabase(adminUrl);
  try {
    const { tenantId } = await owner.withTransaction(tenantOwningCrm);
    const ids = await owner.withTransaction(dealIds);
    const id = (label: string): number => {
      const value = ids.get(label);
      if (value === undefined) throw new Error(`no synthetic deal ${label}`);
      return value;
    };
    const revision = async (dealRef: number): Promise<string> =>
      owner.withTransaction(async (tx) => {
        const { rows } = await tx.query<{ r: string }>(
          "select ops.crm_deal_revision(d) as r from public.deals d where d.id = $1",
          [dealRef],
        );
        return rows[0].r;
      });
    const act = async (
      kind: Act,
      label: string,
      input: unknown,
      expected?: string,
    ): Promise<Record<string, unknown>> => {
      const dealRef = id(label);
      const rev = expected ?? (await revision(dealRef));
      try {
        return await owner.withTransaction(async (tx) => {
          const { rows } = await tx.query<{ r: Record<string, unknown> }>(
            ACT_SQL[kind],
            [tenantId, PRINCIPAL, dealRef, input, rev],
          );
          return rows[0].r;
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? "unexpected";
        return { refused: code };
      }
    };
    const report = (
      step: string,
      label: string,
      answer: Record<string, unknown>,
    ) =>
      stdout(
        jsonLine({
          step,
          opportunity: `Oportunidade #${id(label)}`,
          outcome: answer.outcome ?? answer.refused,
          followUp: answer.followUp ?? null,
        }),
      );

    const bridge = await owner.withTransaction((tx) =>
      configureBridge(tx, tenantId),
    );
    stdout(
      jsonLine({
        step: "bridge_configured",
        cadenceMinutes: OFFSETS_MINUTES,
        version: bridge.bridge.version,
      }),
    );
    const before = await owner.withTransaction((tx) => counts(tx, tenantId));
    stdout(jsonLine({ step: "funnel_before", ...before }));

    // 1. A move, and the same move again from the view before it: stale.
    const beforeMove = await revision(id("r01"));
    report("moved", "r01", await act("move", "r01", "contact_started"));
    report(
      "stale_refused",
      "r01",
      await act("move", "r01", "conversation_active", beforeMove),
    );

    // 2. A next action set, changed and, on another deal, set then cleared.
    report("next_action_set", "r06", await act("next", "r06", at(1, 10)));
    report("next_action_changed", "r06", await act("next", "r06", at(2, 15)));
    report("next_action_set", "r04", await act("next", "r04", at(1, 9)));
    report("next_action_cleared", "r04", await act("next", "r04", null));

    // 3. A conversion and a loss, each cancelling the plan the bridge made.
    report("next_action_set", "r12", await act("next", "r12", at(1, 11)));
    report(
      "converted",
      "r12",
      await act("convert", "r12", "continuity_converted"),
    );
    report("next_action_set", "r05", await act("next", "r05", at(1, 14)));
    report("lost", "r05", await act("lose", "r05", "no_response"));

    const after = await owner.withTransaction((tx) => counts(tx, tenantId));
    stdout(jsonLine({ step: "funnel_after", ...after }));
    const observed = await owner.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ from: string | null; to: string }>(
        `select from_stage as "from", to_stage as "to" from public.deal_stage_transitions
          where deal_id = $1 order by changed_at, id`,
        [id("r01")],
      );
      return rows.map((r) => `${r.from ?? "entry"} -> ${r.to}`);
    });
    stdout(
      jsonLine({
        step: "ledger",
        opportunity: `Oportunidade #${id("r01")}`,
        observed,
      }),
    );
    for (const label of ["r06", "r04", "r12", "r05"]) {
      const plans = await owner.withTransaction((tx) =>
        plansOf(tx, tenantId, id(label)),
      );
      stdout(
        jsonLine({
          step: "follow_up_plans",
          opportunity: `Oportunidade #${id(label)}`,
          plans,
        }),
      );
    }
    stdout(
      jsonLine({
        step: "try_it",
        open: ["r02", "r03", "r08", "r10", "r11"].map(
          (l) => `Oportunidade #${id(l)}`,
        ),
        note: "synthetic opportunities left open for the owner in the Funil comercial; nothing was sent",
      }),
    );
    return EXIT_OK;
  } catch (error) {
    stderr(
      jsonLine({
        error: error instanceof CompanyOsError ? error.code : "unexpected",
        message:
          error instanceof Error ? error.message : "the demonstration failed",
      }),
    );
    return EXIT_REFUSED;
  } finally {
    await owner.close();
  }
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runFunnelOperationsDemo({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 2 }),
  });
}
