// The webhook gateway's request handling, without a server and without a
// database: verify, parse, hand each item to the store, answer Meta.
//
// ORDER IS THE SECURITY PROPERTY:
//   1. GET  is the subscription handshake, and nothing else.
//   2. POST is authenticated over the RAW bytes (X-Hub-Signature-256) BEFORE
//      anything is parsed. An unauthentic body is never parsed, never stored.
//   3. Only then is the payload parsed, and each message or status handed to
//      the store, which is the database: it resolves the tenant from the
//      provider target an owner configured, applies the Q8 gate and admits.
//
// ANSWERS. Meta retries any answer but 200 for up to 7 days, to every app
// subscribed to the account, and may deliver duplicates, which admission and
// status handling absorb. The rule (Phase 2B pre-push review): a message is
// ACKNOWLEDGED only once it became work or a durable, content-free fact.
//   * 200 once every message was admitted, replayed or refused ON THE RECORD
//     (ops.receive_whatsapp_message wrote a communication.inbound_refused
//     fact), and every status was handled or refused;
//   * 503 when any message is UNROUTED: no active test channel for its target
//     (an unknown number, a paused channel, a production channel while the
//     BASELINE Q8 real-data gate is closed) or a paused company, department or
//     agent. Nothing about it is stored, so it is not acknowledged, and a
//     paused channel or unit recovers it when re-activated;
//   * 500 when any item hit a TRANSIENT failure; it takes precedence over 503.
//     Either way Meta delivers the batch again, and the items already handled
//     converge on what they became;
//   * 200 for a message the store refused as malformed before it could be tied
//     to any channel (an OS400 the parser never produces), because no retry
//     can change it;
//   * 401 for a missing or wrong signature, 400 for an authenticated but
//     unreadable body, 403 for a failed handshake, 404 / 405 / 413 otherwise.
//
// LOGGING. Counts and outcomes, and the provider target of an unrouted message
// (the business's own phone number id, never a sender's). Never a body, a
// sender, a token, a secret, a header or a payload.

import {
  answerSubscription,
  isAuthenticWebhook,
  parseWebhook,
  WebhookPayloadError,
  type WhatsAppInboundMessage,
  type WhatsAppStatusUpdate,
} from "./metaWebhook.ts";

/**
 * What the database answered for one inbound message: admitted (or replayed)
 * as work, refused with a durable content-free fact, or unrouted (no live test
 * channel or a paused unit: not acknowledged, nothing stored).
 */
export type MessageAnswer = "admitted" | "replayed" | "refused" | "unrouted";
/** What the database answered for one status. */
export type StatusAnswer = "updated" | "ignored" | "unmatched" | "unsupported";

/** A store refusal a retry cannot change (a typed OS400-OS409). */
export class PermanentStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`the store refused the item (${code})`);
    this.name = "PermanentStoreError";
    this.code = code;
  }
}

/** The gateway's only way into the Company OS. Implemented over the database. */
export interface GatewayStore {
  receiveMessage(message: WhatsAppInboundMessage): Promise<MessageAnswer>;
  receiveStatus(status: WhatsAppStatusUpdate): Promise<StatusAnswer>;
}

export interface GatewayConfig {
  readonly appSecret: string;
  readonly verifyToken: string;
  /** The one path the gateway serves, e.g. /webhooks/whatsapp. */
  readonly path: string;
}

export interface GatewayRequest {
  readonly method: string;
  /** Path and query, as received. */
  readonly url: string;
  readonly signature: string | undefined;
  readonly body: Uint8Array;
}

export interface GatewayResponse {
  readonly status: number;
  readonly body: string;
}

/** The counters a single request produced. Safe to log: no content at all. */
export interface GatewayOutcome {
  readonly messages: Readonly<
    Record<MessageAnswer | "invalid" | "transient", number>
  >;
  readonly statuses: Readonly<
    Record<StatusAnswer | "invalid" | "transient", number>
  >;
  readonly ignored: number;
}

export type GatewayLogger = (
  event:
    | "gateway.handshake"
    | "gateway.rejected"
    | "gateway.delivery"
    | "gateway.store_failure"
    | "gateway.unrouted",
  fields: Readonly<Record<string, string | number>>,
) => void;

const text = (status: number, body = ""): GatewayResponse => ({ status, body });

const failureCode = (error: unknown): string =>
  error instanceof PermanentStoreError ? error.code : "transient";

export async function handleWebhookRequest(
  request: GatewayRequest,
  config: GatewayConfig,
  store: GatewayStore,
  log: GatewayLogger,
): Promise<GatewayResponse> {
  let url: URL;
  try {
    url = new URL(request.url, "http://gateway.invalid");
  } catch {
    return text(400);
  }
  if (url.pathname !== config.path) return text(404);

  if (request.method === "GET") {
    const answer = answerSubscription(
      {
        mode: url.searchParams.get("hub.mode"),
        verifyToken: url.searchParams.get("hub.verify_token"),
        challenge: url.searchParams.get("hub.challenge"),
      },
      config.verifyToken,
    );
    log("gateway.handshake", { result: answer.ok ? "accepted" : "refused" });
    return answer.ok ? text(200, answer.challenge) : text(403);
  }
  if (request.method !== "POST") return text(405);

  // Authenticity first, over the raw bytes. Nothing below runs otherwise.
  if (!isAuthenticWebhook(request.body, request.signature, config.appSecret)) {
    log("gateway.rejected", { reason: "signature" });
    return text(401);
  }

  let parsed;
  try {
    parsed = parseWebhook(
      JSON.parse(Buffer.from(request.body).toString("utf8")) as unknown,
    );
  } catch (error) {
    log("gateway.rejected", {
      reason:
        error instanceof WebhookPayloadError ? "not_whatsapp" : "not_json",
    });
    return text(400);
  }

  const messages = {
    admitted: 0,
    replayed: 0,
    refused: 0,
    unrouted: 0,
    invalid: 0,
    transient: 0,
  };
  const statuses = {
    updated: 0,
    ignored: 0,
    unmatched: 0,
    unsupported: 0,
    invalid: 0,
    transient: 0,
  };

  // One at a time, in order: a batch from one number is one conversation's
  // history, and the store's own locks make each item converge on redelivery.
  for (const message of parsed.messages) {
    try {
      const answer = await store.receiveMessage(message);
      messages[answer] += 1;
      if (answer === "unrouted") {
        log("gateway.unrouted", { target: message.providerTarget });
      }
    } catch (error) {
      const code = failureCode(error);
      log("gateway.store_failure", { kind: "message", code });
      if (code === "transient") messages.transient += 1;
      else messages.invalid += 1;
    }
  }
  for (const status of parsed.statuses) {
    try {
      statuses[await store.receiveStatus(status)] += 1;
    } catch (error) {
      const code = failureCode(error);
      log("gateway.store_failure", { kind: "status", code });
      if (code === "transient") statuses.transient += 1;
      else statuses.invalid += 1;
    }
  }

  const outcome: GatewayOutcome = {
    messages,
    statuses,
    ignored: parsed.ignored,
  };
  log("gateway.delivery", {
    admitted: messages.admitted,
    replayed: messages.replayed,
    refusedMessages: messages.refused,
    unroutedMessages: messages.unrouted,
    invalidMessages: messages.invalid,
    transientMessages: messages.transient,
    updated: statuses.updated,
    unmatched: statuses.unmatched,
    invalidStatuses: statuses.invalid,
    transientStatuses: statuses.transient,
    ignored: outcome.ignored,
  });
  if (messages.transient + statuses.transient > 0) return text(500);
  // Not ours to acknowledge: Meta keeps it, and delivers it again.
  if (messages.unrouted > 0) return text(503, "unrouted");
  return text(200);
}
