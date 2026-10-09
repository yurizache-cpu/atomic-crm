// The transport a worker carries policy sends with (ADR 0026 §B). Built once at
// start from the process environment (whatsapp/replyTransportFromEnv.ts) and
// handed to the reply-send handler; a handler never reads the environment or a
// token (SI-33).
//
//   none  no transport: the handler gives every reply job back to the queue
//         until its text is out of date, then the database blocks it
//         (transport_not_configured) and lists it for a person.
//   meta  the official Meta Cloud API, with the worker's WhatsApp token.
//   fake  a transport that calls nobody, for local development only.

import type {
  OutboundOutcome,
  OutboundRequest,
  OutboundTransport,
} from "./types.ts";

export type ReplyTransportKind = "none" | "meta" | "fake";

export interface ReplyTransport {
  readonly kind: ReplyTransportKind;
  /** null exactly when `kind` is none. */
  readonly transport: OutboundTransport | null;
  /** The transport's own bound on one call, in milliseconds; 0 for none. */
  readonly timeoutMs: number;
}

export const UNCONFIGURED_REPLY_TRANSPORT: ReplyTransport = Object.freeze({
  kind: "none",
  transport: null,
  timeoutMs: 0,
});

/**
 * A transport that calls nobody and accepts every well-formed request, naming
 * it after the send it carries. Local development and tests only: the start
 * gate refuses it anywhere else (engine/runtime/deploymentEnvironment.ts).
 */
export function createFakeOutboundTransport(): OutboundTransport & {
  readonly calls: readonly OutboundRequest[];
} {
  const calls: OutboundRequest[] = [];
  return {
    provider: "meta_whatsapp",
    calls,
    async send(request: OutboundRequest): Promise<OutboundOutcome> {
      calls.push(request);
      if (request.body.trim() === "") {
        return {
          kind: "rejected",
          errorCode: null,
          errorClass: "invalid_request",
        };
      }
      return {
        kind: "accepted",
        providerMessageId: `fake.${request.correlation}`,
      };
    },
  };
}
