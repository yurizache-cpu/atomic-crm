// The Phase 2A demonstration: ONE synthetic lead, end to end, on a local
// database.
//
//   COMPANY_OS_SYNTHETIC_INGRESS=enabled npm run lead-triage:demo
//
// LOCAL AND MANUAL ONLY, like agent-runtime:smoke. No CI job runs it: it writes
// to the database it is pointed at, and CI relies on the driver-backed proof in
// engine/domain/leadTriagePilot.dbtest.ts, which asserts every property this
// command merely shows.
//
// WHAT IT SHOWS, one JSON line per step: a synthetic message is admitted once,
// becomes one lead_triage task and one requested agent run, the REAL worker
// runtime executes that run under the kill switch, the price and the spend
// limits, the structured advice opens a human review item, a person decides, and
// the facts of all of it are on the record. Then it states the two boundaries
// this phase exists to hold: nothing was sent, and nothing in the CRM changed.
//
// THE PROVIDER IS THE FAKE ONE. There is no --live: Q8 is open, so this command
// never calls a real provider, not even with synthetic text. A real-provider
// probe is a separate, deliberate act with its own owner decision.
//
// THE MESSAGE IS FICTITIOUS. It is written for this demonstration. No real
// enquiry, patient or clinical text is used, and the transport that carries it
// admits nothing else (ops.inbound_messages.source_kind).
//
// ENVIRONMENT. COMPANY_OS_SYNTHETIC_INGRESS=enabled, ADMIN_DATABASE_URL (the
// owner connection) and OPS_WORKER_DATABASE_URL (the constrained worker login).
// Both must name the same database on this machine.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import { CompanyOsError } from "../domain/errors.ts";
import { admitInboundMessage } from "../domain/leadIntake.ts";
import { recordModelPrice } from "../domain/modelPrices.ts";
import { setSpendLimit } from "../domain/spendLimits.ts";
import {
  listReviewItems,
  readReviewItem,
  recordReviewDecision,
} from "../domain/reviewQueue.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import {
  LEAD_TRIAGE_CAPABILITY,
  type LeadTriage,
} from "../models/leadTriage.ts";
import { createModelRouter } from "../models/router.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  isEntryPoint,
  jsonLine,
} from "./cliOutput.ts";

const WORKER_DATABASE_URL = "OPS_WORKER_DATABASE_URL";
const SOURCE = "lead-triage-demo";
export const MODEL = "fake-model-1";
const MAX_STEPS = 5;

/** The fictitious sender, and the trusted consent source that knows it. */
export const DEMO_CONTACT = "synthetic:lead-demo";
export const DEMO_CONTACT_POLICY = createSyntheticContactPolicy({
  eligible: [DEMO_CONTACT],
});

/** A fictitious enquiry, written for this demonstration. */
export const SYNTHETIC_BODY =
  "Oi, vi o site. Tenho tido muita ansiedade e pensamentos demais e queria entender como funciona a primeira consulta.";

/** What the fake provider answers. A real model would write its own. */
export const CANNED_ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary:
    "New enquiry asking how a first session works, mentioning ongoing anxiety. No clinical judgement is made here.",
  intent: "information",
  priority: "normal",
  recommended_next_action:
    "Reply explaining how a first session works and offer two times this week.",
  response_draft:
    "Oi! Obrigado por escrever. A primeira consulta dura cerca de 50 minutos e serve para entender o que voce procura e responder suas duvidas. Posso te oferecer dois horarios esta semana.",
  needs_human_review: true,
  flags: Object.freeze([]),
}) as LeadTriage;

export interface LeadTriageDemoDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

export interface Placement {
  readonly tenantId: string;
  readonly companyId: string;
  readonly agentId: string;
}

/** The first active agent of the local development tenant. */
const PLACEMENT_SQL = `select a.tenant_id, a.company_id, a.id as agent_id
    from ops.agents a
    join ops.companies c on c.id = a.company_id and c.tenant_id = a.tenant_id
    join ops.departments d on d.id = a.department_id and d.tenant_id = a.tenant_id
   where a.status = 'active' and c.status = 'active' and d.status = 'active'
   order by a.created_at
   limit 1`;

export async function readPlacement(tx: TxClient): Promise<Placement> {
  const { rows } = await tx.query<{
    tenant_id: string;
    company_id: string;
    agent_id: string;
  }>(PLACEMENT_SQL, []);
  const row = rows[0];
  if (row === undefined) {
    throw new CompanyOsError(
      "not_found",
      "this database has no active agent to triage with; run the development seed first",
    );
  }
  return {
    tenantId: row.tenant_id,
    companyId: row.company_id,
    agentId: row.agent_id,
  };
}

interface RunFacts {
  readonly status: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly prompt_version: string | null;
  readonly model_route: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly error_code: string | null;
  readonly result: unknown;
}

const RUN_SQL = `select status, provider, model, prompt_version, model_route,
       input_tokens, output_tokens, error_code, result
  from ops.agent_runs where id = $1`;

const readRun = async (tx: TxClient, runId: string): Promise<RunFacts> => {
  const { rows } = await tx.query<RunFacts>(RUN_SQL, [runId]);
  const row = rows[0];
  if (row === undefined) throw new Error("the agent run vanished");
  return row;
};

// Scoped to THIS demonstration's task, so a database that has run it before
// prints this run's facts rather than every run's.
const EVENTS_SQL = `select type from ops.events
   where tenant_id = $1 and subject_type = 'task' and subject_id = $2
     and type like any (array['communication.%', 'lead_triage.%'])
   order by seq`;

// Whether the owner already configured a ceiling and this tenant's budget:
// exact existence, so an active limit of any value is left as it is.
const ACTIVE_LIMITS_SQL = `select exists (select 1 from ops.spend_limits l
                where l.scope = 'global' and l.ended_at is null) as has_ceiling,
       exists (select 1 from ops.spend_limits l
                where l.scope = 'tenant' and l.tenant_id = $1 and l.ended_at is null) as has_budget`;

const DAY_MS = 86_400_000;
const DEMO_ACTOR = "lead-triage-demo";
const DEMO_DAILY_USD = "1";

/**
 * A worker leases the head of the WHOLE queue, whoever it belongs to, and this
 * command's fake provider would answer another run with canned triage text
 * recorded as that run's result. So it refuses to start while anything is
 * queued or leased, exactly as agent-runtime:smoke does.
 */
const QUEUE_BUSY_SQL =
  "select count(*)::int as n from ops.jobs where status in ('queued', 'leased')";

export async function queueIsBusy(tx: TxClient): Promise<boolean> {
  const { rows } = await tx.query<{ n: number }>(QUEUE_BUSY_SQL, []);
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * A run starts only with a current price, a global ceiling and its tenant's
 * budget (ADR 0017, owner decision A): without them the demonstration would
 * stop at `spend_ceiling_unconfigured`, which is the governance working, not a
 * flow to look at. So, exactly as the agent-runtime smoke does, this records a
 * synthetic price for the FAKE model and sets a 1 USD (UTC) ceiling and budget
 * ONLY where no active one exists. It never ends, supersedes or changes an
 * owner's limit, and the price it records is for a model no real provider
 * serves.
 */
export async function configureFakeGovernance(
  tx: TxClient,
  tenantId: string,
  now: Date,
): Promise<void> {
  const dayStart = Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  await recordModelPrice(
    tx,
    {
      provider: "fake",
      model: MODEL,
      inputUsdPerMtok: "0.000001",
      outputUsdPerMtok: "0.000001",
      reasoningInOutput: true,
      effectiveFrom: new Date(dayStart).toISOString(),
      expiresAt: new Date(dayStart + 30 * DAY_MS).toISOString(),
    },
    { actor: DEMO_ACTOR, source: "lead triage demo synthetic price" },
  );

  const { rows } = await tx.query<{
    has_ceiling: boolean;
    has_budget: boolean;
  }>(ACTIVE_LIMITS_SQL, [tenantId]);
  const active = rows[0];
  if (
    typeof active?.has_ceiling !== "boolean" ||
    typeof active.has_budget !== "boolean"
  ) {
    throw new Error("the active spend limits could not be read");
  }
  const value = { dailyUsd: DEMO_DAILY_USD, timezone: "UTC" };
  if (!active.has_ceiling) {
    await setSpendLimit(tx, { scope: "global" }, value, {
      actor: DEMO_ACTOR,
      reason: "lead triage demo: local development ceiling",
    });
  }
  if (!active.has_budget) {
    await setSpendLimit(tx, { scope: "tenant", tenantId }, value, {
      actor: DEMO_ACTOR,
      reason: "lead triage demo: local development budget",
    });
  }
}

export async function runLeadTriageDemo(
  dependencies: LeadTriageDemoDependencies,
): Promise<number> {
  const { env, stdout, stderr, openDatabase } = dependencies;

  // 1. The transport must be on. It is off by default, everywhere.
  let port;
  try {
    port = createSyntheticCommunicationPort(env);
  } catch (error) {
    stderr(
      jsonLine({
        error: "ingress_disabled",
        message: (error as Error).message,
      }),
    );
    return EXIT_USAGE;
  }

  const adminUrl = env[ADMIN_DATABASE_URL];
  const workerUrl = env[WORKER_DATABASE_URL];
  if (!adminUrl || !workerUrl) {
    stderr(
      jsonLine({
        error: "configuration",
        message: `${ADMIN_DATABASE_URL} and ${WORKER_DATABASE_URL} are both required`,
      }),
    );
    return EXIT_USAGE;
  }
  // The same local database for both, as the smoke requires: a canned answer
  // must never be able to land in a deployment's queue.
  const ownerTarget = loopbackDatabaseTarget(adminUrl);
  const workerTarget = loopbackDatabaseTarget(workerUrl);
  if (
    ownerTarget === undefined ||
    workerTarget === undefined ||
    ownerTarget !== workerTarget
  ) {
    stderr(
      jsonLine({
        error: "configuration",
        message: `${ADMIN_DATABASE_URL} and ${WORKER_DATABASE_URL} must name the same database on this machine`,
      }),
    );
    return EXIT_USAGE;
  }

  const owner = openDatabase(adminUrl);
  const db = openDatabase(workerUrl);
  const provider = createFakeModelProvider({
    type: "respond",
    content: CANNED_ADVICE,
  });
  const registry = createHandlerRegistry({
    modelRouter: createModelRouter({
      routes: new Map([
        ["standard", { provider: provider.name, model: MODEL }],
      ]),
      providers: new Map([[provider.name, provider]]),
    }),
  });

  try {
    if (await owner.withTransaction(queueIsBusy)) {
      stderr(
        jsonLine({
          error: "queue_busy",
          message:
            "a job is queued or leased on this database; the demonstration would answer it with canned triage text",
        }),
      );
      return EXIT_REFUSED;
    }

    const placement = await owner.withTransaction(readPlacement);
    // Its own transaction, committed before the run is requested: setting a
    // limit takes a spend lock, and ADR 0017 §4 orders the kill-switch lock a
    // request takes before it.
    await owner.withTransaction((tx) =>
      configureFakeGovernance(tx, placement.tenantId, new Date()),
    );

    // 2. Ingress. One message in, one unit of work out, nothing called. The
    //    delivery says nothing about consent; the trusted policy does.
    const message = port.receive({
      external_message_id: `demo-${randomUUID()}`,
      contact_ref: DEMO_CONTACT,
      body: SYNTHETIC_BODY,
      received_at: new Date().toISOString(),
    });
    const admitted = await owner.withTransaction((tx) =>
      admitInboundMessage(tx, placement, message, DEMO_CONTACT_POLICY, SOURCE),
    );
    stdout(
      jsonLine({
        step: "ingress",
        accepted: true,
        sourceKind: message.sourceKind,
        externalMessageId: message.externalMessageId,
        inboundMessageId: admitted.inboundMessageId,
        providerCalls: provider.calls.length,
      }),
    );
    stdout(
      jsonLine({
        step: "work",
        taskId: admitted.taskId,
        agentRunId: admitted.agentRunId,
        capability: LEAD_TRIAGE_CAPABILITY,
      }),
    );

    // 3. The real runtime, one job at a time, under every existing gate.
    const workerId = `demo-${hostname()}-${process.pid}`;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const outcome = await runOneJob(db, { workerId, registry });
      if (outcome.outcome === "idle") break;
    }

    const run = await owner.withTransaction((tx) =>
      readRun(tx, admitted.agentRunId),
    );
    stdout(
      jsonLine({
        step: "executed",
        status: run.status,
        modelRoute: run.model_route,
        provider: run.provider,
        model: run.model,
        promptVersion: run.prompt_version,
        inputTokens: run.input_tokens,
        outputTokens: run.output_tokens,
        errorCode: run.error_code,
        providerCalls: provider.calls.length,
      }),
    );
    if (run.status !== "succeeded") {
      stderr(
        jsonLine({
          error: "run_not_succeeded",
          message:
            "the run did not succeed, so no review item exists; `npm run ops -- status` says why",
        }),
      );
      return EXIT_REFUSED;
    }
    stdout(jsonLine({ step: "triage", advice: run.result }));

    // 4. The review a person is asked for, and the decision they record.
    const pending = await owner.withTransaction((tx) =>
      listReviewItems(tx, { tenantId: placement.tenantId, status: "pending" }),
    );
    const item = pending.find((row) => row.agentRunId === admitted.agentRunId);
    if (item === undefined) {
      stderr(
        jsonLine({
          error: "no_review",
          message: "the run opened no review item",
        }),
      );
      return EXIT_REFUSED;
    }
    stdout(
      jsonLine({
        step: "review",
        reviewItemId: item.id,
        status: item.status,
        doNotContact: item.doNotContact,
      }),
    );

    const decided = await owner.withTransaction((tx) =>
      recordReviewDecision(
        tx,
        { tenantId: placement.tenantId, source: SOURCE },
        {
          reviewId: item.id,
          decision: "accepted",
          reviewer: "demo operator",
          note: "demonstration decision",
        },
      ),
    );
    const reviewed = await owner.withTransaction((tx) =>
      readReviewItem(tx, item.id, { tenantId: placement.tenantId }),
    );
    stdout(
      jsonLine({
        step: "decision",
        reviewItemId: decided.reviewItemId,
        status: decided.status,
        recorded: decided.recorded,
        reviewer: reviewed?.reviewer,
        reviewedAt: reviewed?.reviewedAt,
      }),
    );

    // 5. The record, and the two boundaries this phase holds.
    const { rows: facts } = await owner.withTransaction((tx) =>
      tx.query<{ type: string }>(EVENTS_SQL, [
        placement.tenantId,
        admitted.taskId,
      ]),
    );
    stdout(jsonLine({ step: "audit", events: facts.map((row) => row.type) }));
    stdout(
      jsonLine({
        step: "boundary",
        outboundMessagesSent: 0,
        crmRowsWritten: 0,
        // Phase 2A introduces no outbound transport and no CRM mutation path.
        // The worker's existing capabilities touch no CRM record, though one
        // touches non-CRM public-schema infrastructure (retention of
        // public.inbound_emails). The driver-backed suite verifies that
        // public.contacts is unchanged.
        transportsAvailable: [port.sourceKind],
        note: "accepting records a structured review decision only; it approves no reply draft and sends nothing, and a send of an accepted review is a separate operator act",
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
    await db.close();
    await owner.close();
  }
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runLeadTriageDemo({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 2 }),
  });
}
