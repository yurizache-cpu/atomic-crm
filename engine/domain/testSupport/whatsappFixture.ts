// Shared setup for the Phase 2B driver-backed suites: the gateway's own
// constrained login, a clinic with a WhatsApp channel, CRM contacts, signed
// Meta deliveries, a counting fake transport, and a run taken to an accepted
// review.
//
// ALL DATA IS SYNTHETIC (BASELINE Q8). Phone numbers are invented, the
// provider targets are fake, and no secret here is real.

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { Pool } from "pg";
import { createWorkerDatabase } from "../../db/workerDatabase.ts";
import type { WorkerDatabase } from "../../db/types.ts";
import type {
  OutboundOutcome,
  OutboundRequest,
  OutboundTransport,
} from "../../communication/types.ts";
import {
  handleWebhookRequest,
  type GatewayConfig,
  type GatewayResponse,
} from "../../communication/whatsapp/webhookGateway.ts";
import type { LeadTriage } from "../../models/leadTriage.ts";
import type { HandlerRegistry } from "../../worker/handlerRegistry.ts";
import { runOneJob } from "../../worker/runOneJob.ts";
import { ADMIN_URL, WORKER_URL } from "../../worker/testSupport/dbFixture.ts";
import { assertLocalTestDatabases } from "../../worker/testSupport/localDatabase.ts";
import { createAgent, createCompany, createDepartment } from "../companyOs.ts";
import {
  configureWhatsAppChannel,
  type ChannelMode,
} from "../communicationChannels.ts";
import { listReviewItems, recordReviewDecision } from "../reviewQueue.ts";
import { createGatewayStore } from "../whatsappGatewayStore.ts";

export const GATEWAY_PASSWORD =
  process.env.OPS_GATEWAY_PASSWORD ?? "dbtest-gateway-pw";

/** The gateway login on the SAME local database the worker suites use. */
export const GATEWAY_URL = (() => {
  const url = new URL(WORKER_URL);
  url.username = "ops_gateway_login";
  url.password = GATEWAY_PASSWORD;
  return url.toString();
})();

assertLocalTestDatabases(ADMIN_URL, GATEWAY_URL);

/** Runs the real deployment script, as provisionWorkerRole does for the worker. */
export function provisionGatewayRole(): void {
  const container = process.env.SUPABASE_DB_CONTAINER;
  execFileSync("node", ["scripts/provision-gateway-role.mjs"], {
    env: {
      ...process.env,
      ADMIN_DATABASE_URL: ADMIN_URL,
      OPS_GATEWAY_PASSWORD: GATEWAY_PASSWORD,
      ...(container ? { SUPABASE_DB_CONTAINER: container } : {}),
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

export function gatewayDatabase(): WorkerDatabase {
  return createWorkerDatabase({ connectionString: GATEWAY_URL, max: 4 });
}

export const GATEWAY_CONFIG: GatewayConfig = Object.freeze({
  appSecret: "dbtest-meta-app-secret",
  verifyToken: "dbtest-verify-token",
  path: "/webhooks/whatsapp",
});

export const SOURCE = "dbtest-whatsapp";
export const OPERATOR = "dbtest operator";

/** Synthetic advice with a draft to send. Invented; not from any real person. */
export const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: "Synthetic enquiry about how a first session works.",
  intent: "information",
  priority: "normal",
  recommended_next_action: "Reply with how a first session works.",
  response_draft: "Oi! A primeira consulta dura 50 minutos. SENTINEL-DRAFT",
  needs_human_review: true,
  flags: Object.freeze([]),
}) as LeadTriage;

export interface Clinic {
  readonly tenantId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly channelId: string;
  readonly providerTarget: string;
}

/**
 * One company, one triage agent, and one WhatsApp channel on `providerTarget`.
 * A production channel is configured inactive: the BASELINE Q8 real-data gate
 * is closed, so it can be nothing else.
 */
export async function buildClinic(
  owner: WorkerDatabase,
  tenantId: string,
  providerTarget: string,
  mode: ChannelMode = "test",
): Promise<Clinic> {
  return owner.withTransaction(async (tx) => {
    const ctx = { tenantId, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: `dbtest-wa-${providerTarget.slice(-4)}`,
      name: "Clinic",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "intake",
      name: "Intake",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "lead-triage",
      name: "Lead Triage",
      role: "Intake assistant",
      description: "Triages new enquiries for a person to review.",
    });
    const channelId = await configureWhatsAppChannel(tx, {
      tenantId,
      companyId,
      agentId,
      providerTarget,
      mode,
      label: "dbtest channel",
      actor: "dbtest",
      active: mode === "test",
    });
    return { tenantId, companyId, agentId, channelId, providerTarget };
  });
}

/** A CRM contact whose one phone number is `phone`. Its lead profile is created by trigger. */
export async function addCrmContact(
  admin: Pool,
  phone: string,
  options: { readonly doNotContact?: boolean } = {},
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into public.contacts (first_name, last_name, phone_jsonb)
     values ('dbtest-wa', 'Synthetic', $1::jsonb) returning id::text as id`,
    [
      JSON.stringify([
        { number: `+${phone.slice(0, 2)} ${phone.slice(2)}`, type: "Mobile" },
      ]),
    ],
  );
  const id = rows[0].id;
  if (options.doNotContact) await setDoNotContact(admin, id, true);
  return id;
}

export async function setDoNotContact(
  admin: Pool,
  contactId: string,
  value: boolean,
): Promise<void> {
  await admin.query(
    "update public.lead_profiles set do_not_contact = $2 where contact_id = $1::bigint",
    [contactId, value],
  );
}

export async function deleteCrmContacts(admin: Pool): Promise<void> {
  await admin.query(
    "delete from public.contacts where first_name = 'dbtest-wa'",
  );
}

export interface InboundItem {
  readonly id: string;
  readonly from: string;
  readonly body: string;
  /** Unix seconds; defaults to now. */
  readonly timestamp?: number;
}

export interface StatusItem {
  readonly id: string;
  readonly status: string;
  readonly recipient: string;
  readonly correlation?: string;
  readonly errorCode?: number;
  readonly timestamp?: number;
}

/** A Meta-shaped notification for one provider target. */
export function metaPayload(
  providerTarget: string,
  items: {
    readonly messages?: InboundItem[];
    readonly statuses?: StatusItem[];
  },
  extra: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "100000000000001",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550000000",
                phone_number_id: providerTarget,
              },
              ...extra,
              messages: (items.messages ?? []).map((m) => ({
                from: m.from,
                id: m.id,
                timestamp: String(m.timestamp ?? now),
                type: "text",
                text: { body: m.body },
              })),
              statuses: (items.statuses ?? []).map((s) => ({
                id: s.id,
                status: s.status,
                timestamp: String(s.timestamp ?? now),
                recipient_id: s.recipient,
                ...(s.correlation === undefined
                  ? {}
                  : { biz_opaque_callback_data: s.correlation }),
                ...(s.errorCode === undefined
                  ? {}
                  : { errors: [{ code: s.errorCode }] }),
              })),
            },
          },
        ],
      },
    ],
  });
}

/** Signs `body` as Meta would and hands it to the real handler and the real store. */
export async function deliver(
  gateway: WorkerDatabase,
  body: string,
  log: (line: string) => void = () => {},
): Promise<GatewayResponse> {
  const signature = `sha256=${createHmac("sha256", GATEWAY_CONFIG.appSecret).update(body).digest("hex")}`;
  return handleWebhookRequest(
    {
      method: "POST",
      url: GATEWAY_CONFIG.path,
      signature,
      body: Buffer.from(body, "utf8"),
    },
    GATEWAY_CONFIG,
    createGatewayStore(gateway),
    (event, fields) => log(JSON.stringify({ event, ...fields })),
  );
}

/** A transport that records every call and answers from a script. */
export function fakeTransport(
  answer: (
    request: OutboundRequest,
    call: number,
  ) => OutboundOutcome | Promise<OutboundOutcome>,
): OutboundTransport & { readonly calls: OutboundRequest[] } {
  const calls: OutboundRequest[] = [];
  return {
    provider: "meta_whatsapp",
    calls,
    async send(request) {
      calls.push(request);
      return answer(request, calls.length);
    },
  };
}

export const accepted = (id: string): OutboundOutcome => ({
  kind: "accepted",
  providerMessageId: id,
});

/**
 * Runs the one queued agent job with the fake model answering ADVICE, then
 * accepts the review it opened. Resolves to that review's id.
 */
export async function triageAndAccept(
  owner: WorkerDatabase,
  worker: WorkerDatabase,
  registry: HandlerRegistry,
  tenantId: string,
): Promise<string> {
  const result = await runOneJob(worker, {
    workerId: "dbtest-whatsapp",
    registry,
  });
  if (result.outcome !== "succeeded") {
    throw new Error(`the triage run did not succeed: ${result.outcome}`);
  }
  return decide(owner, tenantId, "accepted");
}

/** Records `decision` on the one pending review of the tenant. */
export async function decide(
  owner: WorkerDatabase,
  tenantId: string,
  decision: "accepted" | "rejected" | "needs_edit",
): Promise<string> {
  const pending = await owner.withTransaction((tx) =>
    listReviewItems(tx, { tenantId, status: "pending" }),
  );
  if (pending.length !== 1) {
    throw new Error(`expected one pending review, found ${pending.length}`);
  }
  await owner.withTransaction((tx) =>
    recordReviewDecision(
      tx,
      { tenantId, source: SOURCE },
      { reviewId: pending[0].id, decision, reviewer: OPERATOR },
    ),
  );
  return pending[0].id;
}

export async function countRows(
  admin: Pool,
  sql: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const { rows } = await admin.query<{ count: string }>(
    sql,
    params as unknown[],
  );
  return Number(rows[0].count);
}
