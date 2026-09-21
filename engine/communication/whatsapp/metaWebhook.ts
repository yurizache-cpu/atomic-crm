// The Meta webhook boundary: verify, then parse. Nothing here touches a
// database, decides a tenant or decides consent.
//
// TWO DISTINCT CHECKS (Meta, "Create a webhook endpoint"):
//
//   * SUBSCRIPTION (GET): Meta sends hub.mode=subscribe, hub.verify_token and
//     hub.challenge; the endpoint answers 200 with the challenge only when the
//     token is the one this deployment configured.
//   * AUTHENTICITY (POST): every event carries X-Hub-Signature-256:
//     sha256=<hex>, the HMAC-SHA256 of the payload keyed with the app secret.
//     It is computed here over the RAW request bytes, before any JSON parsing,
//     and compared in constant time. An unauthentic body is never parsed.
//
// PARSING is tolerant of what Meta adds and strict about what this adapter
// reads. EVERY message Meta names with an id is handed to the database, which
// decides what it becomes (Phase 2B pre-push review): a `text` message carries
// its body; any other type (media, a voice note, a reaction...) carries none;
// a sender known only by username (a business-scoped user id with no `from`)
// carries no sender number. The database admits what it can and records a
// content-free refusal for the rest, so nothing is acknowledged in silence.
// Nothing here bounds a body's length: that is the database's decision, in
// characters. Only an element with no usable message id, which could never be
// keyed once, is COUNTED as ignored.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BIZ_OPAQUE_CALLBACK_DATA_MAX_LENGTH } from "./metaApi.ts";

export interface SubscriptionQuery {
  readonly mode: string | null;
  readonly verifyToken: string | null;
  readonly challenge: string | null;
}

export type SubscriptionAnswer =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false };

const CHALLENGE = /^[\x21-\x7e]{1,256}$/;

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // timingSafeEqual needs equal lengths. Comparing the input with itself
    // keeps the work independent of where a wrong token differs.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
};

/** The GET handshake. Never reveals which part was wrong. */
export function answerSubscription(
  query: SubscriptionQuery,
  verifyToken: string,
): SubscriptionAnswer {
  if (
    verifyToken === "" ||
    query.mode !== "subscribe" ||
    query.verifyToken === null ||
    query.challenge === null ||
    !CHALLENGE.test(query.challenge) ||
    !safeEqual(query.verifyToken, verifyToken)
  ) {
    return { ok: false };
  }
  return { ok: true, challenge: query.challenge };
}

const SIGNATURE = /^sha256=([0-9a-fA-F]{64})$/;

/**
 * Whether `rawBody` was signed with `appSecret`. Constant-time over the digest;
 * false for a missing, malformed or wrong header and for an empty secret.
 */
export function isAuthenticWebhook(
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (appSecret === "" || typeof signatureHeader !== "string") return false;
  const match = SIGNATURE.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const provided = Buffer.from(match[1], "hex");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

/** One inbound message, as the gateway hands it to the database. */
export interface WhatsAppInboundMessage {
  /** The receiving phone number id: selects a channel, never a tenant directly. */
  readonly providerTarget: string;
  readonly externalMessageId: string;
  /**
   * The sender's WhatsApp id (digits, with the country code), or null when
   * the sender is known only by username.
   */
  readonly from: string | null;
  /**
   * The text of a `text` message; null for any other type, and for text the
   * database cannot hold (a NUL character).
   */
  readonly body: string | null;
  readonly receivedAt: Date;
}

/** One delivery status for a message this system may have sent. */
export interface WhatsAppStatusUpdate {
  readonly providerTarget: string;
  readonly providerMessageId: string;
  readonly status: string;
  readonly statusAt: Date | null;
  readonly recipient: string | null;
  /** biz_opaque_callback_data, when the send carried it. */
  readonly correlation: string | null;
  /** The first error's numeric code, as text, when the status is failed. */
  readonly errorCode: string | null;
}

export interface ParsedWebhook {
  readonly messages: readonly WhatsAppInboundMessage[];
  readonly statuses: readonly WhatsAppStatusUpdate[];
  /** Elements present but not readable as either. Counted, never guessed at. */
  readonly ignored: number;
}

export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

const DIGITS = /^[0-9]{1,32}$/;
const WA_ID = /^[0-9]{6,20}$/;
const PROVIDER_ID = /^[\x21-\x7e]{1,200}$/;
const UNIX_SECONDS = /^[0-9]{1,12}$/;

const envelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.unknown()).max(1000),
});
const entrySchema = z.object({ changes: z.array(z.unknown()).max(1000) });
const changeSchema = z.object({
  field: z.string(),
  value: z.object({
    messaging_product: z.literal("whatsapp"),
    metadata: z.object({ phone_number_id: z.string().regex(DIGITS) }),
    messages: z.array(z.unknown()).max(1000).optional(),
    statuses: z.array(z.unknown()).max(1000).optional(),
  }),
});
const inboundMessageSchema = z.object({
  id: z.string().regex(PROVIDER_ID),
  from: z.unknown().optional(),
  timestamp: z.unknown().optional(),
  type: z.unknown().optional(),
  text: z.unknown().optional(),
});
const textBodySchema = z.object({ body: z.string() });
const statusSchema = z.object({
  id: z.string().regex(PROVIDER_ID),
  status: z.string().regex(/^[a-z_]{1,32}$/),
  timestamp: z.string().regex(UNIX_SECONDS).optional(),
  recipient_id: z.string().max(64).optional(),
  biz_opaque_callback_data: z
    .string()
    .max(BIZ_OPAQUE_CALLBACK_DATA_MAX_LENGTH)
    .optional(),
  errors: z
    .array(z.object({ code: z.number().int().nonnegative().optional() }))
    .optional(),
});

/** Seconds since the epoch, never later than now: a sender's clock is not ours. */
const fromUnixSeconds = (seconds: string, now: number): Date =>
  new Date(Math.min(Number(seconds) * 1000, now));

/**
 * Parses an AUTHENTICATED payload. Throws WebhookPayloadError only when the
 * envelope itself is not a WhatsApp Business Account notification; anything
 * unreadable inside it is counted in `ignored`.
 */
export function parseWebhook(
  payload: unknown,
  now: number = Date.now(),
): ParsedWebhook {
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new WebhookPayloadError(
      "not a whatsapp_business_account notification",
    );
  }
  const messages: WhatsAppInboundMessage[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];
  let ignored = 0;

  for (const rawEntry of envelope.data.entry) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      ignored += 1;
      continue;
    }
    for (const rawChange of entry.data.changes) {
      const change = changeSchema.safeParse(rawChange);
      if (!change.success || change.data.field !== "messages") {
        ignored += 1;
        continue;
      }
      const { value } = change.data;
      const providerTarget = value.metadata.phone_number_id;
      for (const rawMessage of value.messages ?? []) {
        const message = inboundMessageSchema.safeParse(rawMessage);
        if (!message.success) {
          ignored += 1;
          continue;
        }
        const { from, timestamp, type, text } = message.data;
        const textBody =
          type === "text" ? textBodySchema.safeParse(text) : undefined;
        messages.push(
          Object.freeze({
            providerTarget,
            externalMessageId: message.data.id,
            from: typeof from === "string" && WA_ID.test(from) ? from : null,
            body:
              textBody?.success === true &&
              !textBody.data.body.includes("\u0000")
                ? textBody.data.body
                : null,
            receivedAt:
              typeof timestamp === "string" && UNIX_SECONDS.test(timestamp)
                ? fromUnixSeconds(timestamp, now)
                : new Date(now),
          }),
        );
      }
      for (const rawStatus of value.statuses ?? []) {
        const status = statusSchema.safeParse(rawStatus);
        if (!status.success) {
          ignored += 1;
          continue;
        }
        const code = status.data.errors?.[0]?.code;
        statuses.push(
          Object.freeze({
            providerTarget,
            providerMessageId: status.data.id,
            status: status.data.status,
            statusAt:
              status.data.timestamp === undefined
                ? null
                : fromUnixSeconds(status.data.timestamp, now),
            recipient:
              status.data.recipient_id !== undefined &&
              WA_ID.test(status.data.recipient_id)
                ? status.data.recipient_id
                : null,
            correlation: status.data.biz_opaque_callback_data ?? null,
            errorCode: code === undefined ? null : String(code),
          }),
        );
      }
    }
  }
  return Object.freeze({
    messages: Object.freeze(messages),
    statuses: Object.freeze(statuses),
    ignored,
  });
}
