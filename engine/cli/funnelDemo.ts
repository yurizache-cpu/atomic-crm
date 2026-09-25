// The Phase 3B.1 demonstration: a fictional clinic's commercial funnel for the
// owner's Funil comercial screen, on a local database.
//
//   npm run funnel:demo
//
// with ADMIN_DATABASE_URL naming a database on this machine. LOCAL AND MANUAL
// ONLY; no CI job runs it. It refuses a CRM that already holds any deal, and a
// local CRM that another tenant owns.
//
// WHAT IT DOES, all synthetic (engine/cli/funnelDemoData.ts; no real name,
// phone, email or message):
//   1. gives the local CRM to the development seed's tenant (owns_local_crm)
//      and, when the tenant has none, the scheduling zone America/Sao_Paulo;
//   2. saves the clinic's stage configuration in the CRM, as its Settings
//      would, keeping every other configuration key;
//   3. creates fictional contacts with their recorded acquisition sources,
//      and seventeen opportunities through ordinary CRM writes, with their
//      stages, ages, next actions, amounts and outcomes;
//   4. moves three opportunities to their current stage now, so the ledger
//      observes real stage changes after it exists. Those three enter their
//      stage today.
//
// The ledger records every insert and move as it happens: nothing is
// backfilled and nothing is planted. Company OS only reads. Nothing is sent,
// and no model or external service is called.

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
import {
  FUNNEL_DEMO_CONVERTED,
  FUNNEL_DEMO_DEALS,
  FUNNEL_DEMO_STAGES,
  daysBefore,
  nextActionAt,
  type FunnelDemoDeal,
  type FunnelDemoOrigin,
} from "./funnelDemoData.ts";
import { readPlacement } from "./leadTriageDemo.ts";

const ZONE = "America/Sao_Paulo";
const ACTOR = "funnel-demo";

/** Opportunities inserted one stage back, then moved now: [label, stage before]. */
const MOVED_NOW: readonly (readonly [string, string])[] = [
  ["r03", "new_lead"],
  ["r07", "conversation_active"],
  ["r09", "initial_session_scheduled"],
];

export interface FunnelDemoDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

const refuse = (code: string, message: string): never => {
  throw new CompanyOsError("refused", `${code}: ${message}`);
};

async function claimLocalCrm(tx: TxClient, tenantId: string): Promise<void> {
  const { rows: deals } = await tx.query<{ n: string }>(
    "select count(*) as n from public.deals",
  );
  if (Number(deals[0].n) > 0) {
    refuse(
      "crm_not_empty",
      "this CRM already holds deals; the demonstration runs only on an empty local CRM",
    );
  }
  const { rows: owners } = await tx.query<{ id: string }>(
    "select id from ops.tenants where owns_local_crm",
  );
  if (owners.some((o) => o.id !== tenantId)) {
    refuse("crm_owned", "another tenant owns the local CRM");
  }
  await tx.query("update ops.tenants set owns_local_crm = true where id = $1", [
    tenantId,
  ]);
  const { rows: zone } = await tx.query<{ n: string }>(
    "select count(*) as n from ops.scheduling_settings where tenant_id = $1",
    [tenantId],
  );
  if (Number(zone[0].n) === 0) {
    await tx.query("select ops.set_scheduling_timezone($1, $2, $3)", [
      tenantId,
      ZONE,
      ACTOR,
    ]);
  }
}

async function saveStages(tx: TxClient): Promise<void> {
  const { rows } = await tx.query<{ config: Record<string, unknown> }>(
    "select config from public.configuration where id = 1",
  );
  const config = rows[0]?.config ?? {};
  const stored = config.dealStages;
  if (
    stored !== undefined &&
    JSON.stringify(stored) !== JSON.stringify(FUNNEL_DEMO_STAGES)
  ) {
    refuse(
      "stages_differ",
      "the CRM already stores other stages; the demonstration does not replace a tenant's configuration",
    );
  }
  await tx.query("update public.configuration set config = $1 where id = 1", [
    {
      ...config,
      currency: config.currency ?? "BRL",
      dealStages: FUNNEL_DEMO_STAGES,
      dealPipelineStatuses: FUNNEL_DEMO_CONVERTED,
    },
  ]);
}

async function contactsFor(
  tx: TxClient,
  origin: FunnelDemoOrigin,
): Promise<string[]> {
  if (origin === "none") return [];
  const contact = async (source: string) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.contacts (first_name, last_name)
       values ('Contato', 'Sintético') returning id`,
    );
    await tx.query(
      "insert into public.acquisition_attributions (contact_id, source) values ($1, $2)",
      [rows[0].id, source],
    );
    return rows[0].id;
  };
  return origin === "multiple"
    ? [await contact("Google Ads"), await contact("Orgânico")]
    : [await contact(origin)];
}

async function createDeal(
  tx: TxClient,
  spec: FunnelDemoDeal,
  asOf: Date,
  stageBefore: string | undefined,
): Promise<string> {
  const contactIds = await contactsFor(tx, spec.origin);
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.deals (name, stage, pipeline_stage, contact_ids, amount,
                               created_at, stage_entered_at, next_action_at,
                               lost_at, loss_reason_id, converted_at)
     values ($1, $2, $2, $3::bigint[], $4, $5, $6, $7, $8,
             (select id from public.loss_reasons where code = $9), $10)
     returning id`,
    [
      `Oportunidade sintética ${spec.label}`,
      stageBefore ?? spec.stage,
      contactIds,
      spec.amount,
      daysBefore(asOf, spec.createdDaysAgo),
      daysBefore(asOf, spec.enteredDaysAgo),
      nextActionAt(asOf, spec.nextAction),
      spec.lost ? daysBefore(asOf, spec.lost.daysAgo) : null,
      spec.lost?.reason ?? null,
      spec.convertedDaysAgo === undefined
        ? null
        : daysBefore(asOf, spec.convertedDaysAgo),
    ],
  );
  return rows[0].id;
}

export async function runFunnelDemo(
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

  const owner = openDatabase(adminUrl);
  try {
    const placement = await owner.withTransaction(readPlacement);
    await owner.withTransaction(async (tx) => {
      await claimLocalCrm(tx, placement.tenantId);
      await saveStages(tx);
    });
    stdout(jsonLine({ step: "configured", stages: FUNNEL_DEMO_STAGES.length }));

    const asOf = new Date();
    const moved = new Map(MOVED_NOW);
    const ids = new Map<string, string>();
    await owner.withTransaction(async (tx) => {
      for (const spec of FUNNEL_DEMO_DEALS) {
        ids.set(
          spec.label,
          await createDeal(tx, spec, asOf, moved.get(spec.label)),
        );
      }
    });
    stdout(jsonLine({ step: "opportunities", created: ids.size }));

    // Real stage changes, each its own write, observed by the ledger now.
    for (const [label] of MOVED_NOW) {
      const spec = FUNNEL_DEMO_DEALS.find((d) => d.label === label);
      await owner.withTransaction((tx) =>
        tx.query("update public.deals set pipeline_stage = $2 where id = $1", [
          ids.get(label),
          spec?.stage,
        ]),
      );
    }
    stdout(jsonLine({ step: "moved", moves: MOVED_NOW.length }));

    const summary = await owner.withTransaction(async (tx) => {
      const { rows } = await tx.query<{ funnel: Record<string, unknown> }>(
        "select ops.cos_commercial_funnel($1, clock_timestamp()) as funnel",
        [placement.tenantId],
      );
      const funnel = rows[0].funnel as {
        status: string;
        summary?: Record<string, unknown>;
        movements?: { totalInWindow: number };
      };
      return {
        status: funnel.status,
        ...funnel.summary,
        movementsObserved: funnel.movements?.totalInWindow,
      };
    });
    stdout(
      jsonLine({
        step: "summary",
        ...summary,
        note: "synthetic opportunities in the local CRM; Company OS only reads them, and nothing was sent",
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
  process.exitCode = await runFunnelDemo({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 2 }),
  });
}
