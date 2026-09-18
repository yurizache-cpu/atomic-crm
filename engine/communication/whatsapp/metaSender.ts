// The Meta outbound transport: ONE POST to the official Cloud API, and an
// honest account of what it produced.
//
// POST https://graph.facebook.com/<version>/<phone number id>/messages
// Authorization: Bearer <access token>
// {messaging_product: "whatsapp", recipient_type: "individual", to: "+<wa id>",
//  type: "text", text: {preview_url: false, body}, biz_opaque_callback_data}
//
// AT MOST ONE CALL, NEVER A RETRY. Meta documents no idempotency key for this
// endpoint (docs/PHASE_2B_REPORT.md §3), so a second POST after an ambiguous
// first one can deliver the message twice. So:
//
//   * a 2xx with a message id: accepted, and the id is the provider's name
//     for the message (a wamid);
//   * a 4xx carrying Meta's error body: rejected. Meta refused it, and the
//     numeric code says why (a closed 24-hour window, a rate limit, a bad
//     token). Nothing was sent;
//   * everything else: AMBIGUOUS. A timeout or a network error after the
//     request may have left, a 5xx, a 408, a redirect, a malformed or oversize
//     success. Meta may have accepted the message. The system records that it
//     does not know, and a status callback carrying biz_opaque_callback_data
//     (the send's own id) can still resolve it.
//
// WHAT NEVER LEAVES THIS FILE: the access token, the recipient, the text, and
// any provider message or error text. An outcome carries a code and a class.
//
// biz_opaque_callback_data rides at the top level of the request, where the
// status webhook reference and the WhatsApp changelog place it. The v25.0
// OpenAPI spec does not declare it; if Meta ever refused it, that refusal is a
// definitive 4xx (failed), never an ambiguous send.

import type {
  OutboundOutcome,
  OutboundRequest,
  OutboundTransport,
} from "../types.ts";
import {
  BIZ_OPAQUE_CALLBACK_DATA_MAX_LENGTH,
  META_GRAPH_API_VERSION,
  META_GRAPH_ORIGIN,
  META_WHATSAPP_PROVIDER,
  WHATSAPP_TEXT_MAX_LENGTH,
} from "./metaApi.ts";

/** The call's deadline. Well under the five minutes before a stuck send may be marked. */
export const DEFAULT_SEND_TIMEOUT_MS = 15_000;
/** A send response is a few hundred bytes; anything past this is not one. */
export const MAX_SEND_RESPONSE_BYTES = 64 * 1024;

export type FetchLike = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly redirect: "error";
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

export interface MetaTransportOptions {
  /** The system user or business token. Held here; never logged, never returned. */
  readonly accessToken: string;
  readonly timeoutMs?: number;
  /** Tests inject a fake; production uses the global fetch. */
  readonly fetch?: FetchLike;
}

const DIGITS = /^[0-9]{1,32}$/;
const WA_ID = /^[0-9]{6,20}$/;
const PROVIDER_ID = /^[\x21-\x7e]{1,200}$/;

/**
 * Meta's numeric error codes, grouped by what they mean for a send
 * (Meta, "Error codes"). Anything unlisted is `provider_rejected`.
 */
const ERROR_CLASSES: ReadonlyMap<number, string> = new Map([
  [131047, "service_window_closed"],
  [131026, "undeliverable"],
  [131048, "rate_limited"],
  [131056, "rate_limited"],
  [130429, "rate_limited"],
  [80007, "rate_limited"],
  [190, "access_token_invalid"],
  [131005, "permission_denied"],
  [100, "invalid_request"],
  [131008, "invalid_request"],
  [131009, "invalid_request"],
  [368, "policy_restricted"],
  [133010, "number_not_registered"],
]);

const rejected = (
  errorCode: string | null,
  errorClass: string,
): OutboundOutcome =>
  Object.freeze({ kind: "rejected", errorCode, errorClass });
const ambiguous = (errorClass: string): OutboundOutcome =>
  Object.freeze({ kind: "ambiguous", errorClass });

/** Reads at most `limit` bytes; null when the body is larger or unreadable. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const parseJson = (text: string | null): unknown => {
  if (text === null || text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const providerMessageIdOf = (body: unknown): string | null => {
  const messages = (body as { messages?: unknown } | undefined)?.messages;
  const id = Array.isArray(messages)
    ? (messages[0] as { id?: unknown } | undefined)?.id
    : undefined;
  return typeof id === "string" && PROVIDER_ID.test(id) ? id : null;
};

const errorCodeOf = (body: unknown): number | null => {
  const code = (body as { error?: { code?: unknown } } | undefined)?.error
    ?.code;
  return typeof code === "number" && Number.isInteger(code) && code >= 0
    ? code
    : null;
};

const isTimeout = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { name?: unknown }).name === "TimeoutError" ||
    (error as { name?: unknown }).name === "AbortError");

export function createMetaWhatsAppTransport(
  options: MetaTransportOptions,
): OutboundTransport {
  if (
    typeof options.accessToken !== "string" ||
    options.accessToken.trim() === ""
  ) {
    throw new Error("the Meta transport needs an access token");
  }
  const accessToken = options.accessToken;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("the Meta transport timeout is 1 to 60000 ms");
  }
  const fetchImpl: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));

  async function send(request: OutboundRequest): Promise<OutboundOutcome> {
    // A request the provider could only refuse is refused here, uncalled.
    if (
      !DIGITS.test(request.providerTarget) ||
      !WA_ID.test(request.to) ||
      typeof request.body !== "string" ||
      request.body.trim() === "" ||
      request.body.length > WHATSAPP_TEXT_MAX_LENGTH ||
      typeof request.correlation !== "string" ||
      request.correlation.length > BIZ_OPAQUE_CALLBACK_DATA_MAX_LENGTH
    ) {
      return rejected(null, "invalid_request");
    }

    const url = `${META_GRAPH_ORIGIN}/${META_GRAPH_API_VERSION}/${request.providerTarget}/messages`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: `+${request.to}`,
          type: "text",
          text: { preview_url: false, body: request.body },
          biz_opaque_callback_data: request.correlation,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // The request may already have left: never "not sent".
      return ambiguous(isTimeout(error) ? "timeout" : "network_error");
    }

    const text = await readBounded(response, MAX_SEND_RESPONSE_BYTES);
    const body = parseJson(text);

    if (response.status >= 200 && response.status < 300) {
      const id = providerMessageIdOf(body);
      return id === null
        ? ambiguous(text === null ? "response_too_large" : "malformed_success")
        : Object.freeze({ kind: "accepted", providerMessageId: id });
    }
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    ) {
      const code = errorCodeOf(body);
      if (code === null) {
        return rejected(
          null,
          response.status === 429 ? "rate_limited" : "http_4xx",
        );
      }
      return rejected(
        String(code),
        ERROR_CLASSES.get(code) ?? "provider_rejected",
      );
    }
    return ambiguous(
      response.status >= 500 ? "provider_5xx" : "unexpected_status",
    );
  }

  return Object.freeze({ provider: META_WHATSAPP_PROVIDER, send });
}
