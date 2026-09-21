// The WhatsApp gateway's store: the two database functions the gateway role
// may execute, and nothing else (Phase 2B).
//
// Every transaction assumes ops_gateway first. That role holds no table
// privilege anywhere and may execute exactly ops.receive_whatsapp_message and
// ops.receive_whatsapp_status, both SECURITY DEFINER, both of which resolve
// the tenant from the provider target through ops.communication_channels. The
// gateway passes what Meta signed; it never names a tenant, a company, an agent
// or a consent state.
//
// ANSWERS. ops.receive_whatsapp_message answers admitted, refused (it wrote a
// durable content-free fact) or unrouted (not acknowledged, nothing stored);
// see engine/communication/whatsapp/webhookGateway.ts for what Meta is told.
//
// FAILURE CLASSES. Only a TYPED domain refusal (OS400-OS409, raised before an
// item could be tied to a channel) is PERMANENT, because redelivering the same
// item cannot change it. Everything else, a constraint or data exception
// included, is TRANSIENT: Meta is answered 500 and delivers again, admission
// converges on what the item already became, and a failure that repeats is
// repeated in the log rather than acknowledged once and forgotten.

import type { WorkerDatabase } from "../db/types.ts";
import {
  PermanentStoreError,
  type GatewayStore,
  type MessageAnswer,
  type StatusAnswer,
} from "../communication/whatsapp/webhookGateway.ts";
import type {
  WhatsAppInboundMessage,
  WhatsAppStatusUpdate,
} from "../communication/whatsapp/metaWebhook.ts";

export const GATEWAY_ROLE = "ops_gateway";

const ASSUME_GATEWAY_ROLE = "set local role ops_gateway";

/** Typed domain refusals only. OS429, and every 22xxx / 23xxx, are transient. */
const PERMANENT = /^OS40[0-9]$/;

const sqlstateOf = (error: unknown): string | null => {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
};

const classify = (error: unknown): Error => {
  const code = sqlstateOf(error);
  if (code !== null && PERMANENT.test(code))
    return new PermanentStoreError(code);
  // Transient, or not from the database at all. The original is not
  // re-thrown: a database message can quote the row it refused.
  return new Error(`transient store failure (${code ?? "unknown"})`);
};

async function callGateway(
  db: WorkerDatabase,
  sql: string,
  params: readonly unknown[],
): Promise<Record<string, unknown>> {
  try {
    return await db.withTransaction(async (tx) => {
      await tx.query(ASSUME_GATEWAY_ROLE);
      const { rows } = await tx.query<{ result: unknown }>(sql, params);
      const result = rows[0]?.result;
      if (typeof result !== "object" || result === null) {
        throw new Error("a gateway function returned no answer");
      }
      return result as Record<string, unknown>;
    });
  } catch (error) {
    throw classify(error);
  }
}

export function createGatewayStore(db: WorkerDatabase): GatewayStore {
  return Object.freeze({
    async receiveMessage(
      message: WhatsAppInboundMessage,
    ): Promise<MessageAnswer> {
      const answer = await callGateway(
        db,
        "select ops.receive_whatsapp_message($1, $2, $3, $4, $5) as result",
        [
          message.providerTarget,
          message.externalMessageId,
          message.from,
          message.body,
          message.receivedAt,
        ],
      );
      if (answer.state === "refused") return "refused";
      if (answer.state === "unrouted") return "unrouted";
      if (answer.state === "admitted") {
        return answer.replayed === true ? "replayed" : "admitted";
      }
      throw new Error("ops.receive_whatsapp_message answered an unknown state");
    },

    async receiveStatus(status: WhatsAppStatusUpdate): Promise<StatusAnswer> {
      const answer = await callGateway(
        db,
        "select ops.receive_whatsapp_status($1, $2, $3, $4, $5, $6, $7) as result",
        [
          status.providerTarget,
          status.providerMessageId,
          status.status,
          status.statusAt,
          status.recipient,
          status.correlation,
          status.errorCode,
        ],
      );
      const state = answer.state;
      if (
        state === "updated" ||
        state === "ignored" ||
        state === "unmatched" ||
        state === "unsupported"
      ) {
        return state;
      }
      throw new Error("ops.receive_whatsapp_status answered an unknown state");
    },
  });
}
