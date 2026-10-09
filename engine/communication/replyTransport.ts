// The transport a worker carries policy sends with (ADR 0026 §B), and the
// owner's notifications (ADR 0026 §D, approved templates). Built once at start
// from the process environment (whatsapp/replyTransportFromEnv.ts) and handed
// to the reply-send and owner-notification handlers; a handler never reads the
// environment or a token (SI-33).
//
//   none  no transport: the handler gives every reply job back to the queue
//         until its text is out of date, then the database blocks it
//         (transport_not_configured) and lists it for a person; a
//         notification waits until it expires.
//   meta  the official Meta Cloud API, with the worker's WhatsApp token.
//   fake  a transport that calls nobody, for local development only.

import type {
  OutboundOutcome,
  OutboundRequest,
  OutboundTemplateRequest,
  OutboundTemplateTransport,
  OutboundTransport,
} from "./types.ts";

export type ReplyTransportKind = "none" | "meta" | "fake";

export interface ReplyTransport {
  readonly kind: ReplyTransportKind;
  /** null exactly when `kind` is none. */
  readonly transport: OutboundTransport | null;
  /** The same provider's approved templates; null exactly when `kind` is none. */
  readonly templates: OutboundTemplateTransport | null;
  /** The transport's own bound on one call, in milliseconds; 0 for none. */
  readonly timeoutMs: number;
}

export const UNCONFIGURED_REPLY_TRANSPORT: ReplyTransport = Object.freeze({
  kind: "none",
  transport: null,
  templates: null,
  timeoutMs: 0,
});

/**
 * A transport that calls nobody and accepts every well-formed request, naming
 * it after the send it carries. Local development and tests only: the start
 * gate refuses it anywhere else (engine/runtime/deploymentEnvironment.ts).
 */
export function createFakeOutboundTransport(): OutboundTransport &
  OutboundTemplateTransport & {
    readonly calls: readonly OutboundRequest[];
    readonly templateCalls: readonly OutboundTemplateRequest[];
  } {
  const calls: OutboundRequest[] = [];
  const templateCalls: OutboundTemplateRequest[] = [];
  return {
    provider: "meta_whatsapp",
    calls,
    templateCalls,
    async sendTemplate(
      request: OutboundTemplateRequest,
    ): Promise<OutboundOutcome> {
      templateCalls.push(request);
      if (
        request.bodyParameters.length === 0 ||
        request.bodyParameters.some((parameter) => parameter.trim() === "")
      ) {
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
