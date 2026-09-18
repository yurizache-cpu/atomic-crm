// The communication boundary: the smallest thing that can carry an inbound
// message into the Company OS, and nothing more.
//
// WHY IT IS THIS SMALL. Phase 2A has exactly one transport, and it is
// synthetic. The point of naming a port now is that Phase 2B can add the
// official WhatsApp Cloud API behind the SAME shape without touching the engine:
// a transport parses its own delivery format into `InboundMessage`, and
// everything after that — admission, idempotency, the task, the run, the review
// — is transport-agnostic and already written.
//
// WHAT IS DELIBERATELY ABSENT. No outbound `send`. Phase 2A cannot send a
// message because no code exists that could: the port has no such method, and
// adding one is a reviewed change with its own phase, its own consent gate and
// its own owner decision. No threads, no conversation, no participants, no
// attachments, no delivery receipts, no webhook framework.
//
// TENANCY. `InboundMessage` carries NO tenant, company or agent. Those come
// from `CommunicationTarget`, which the caller builds from trusted
// configuration. A payload cannot select a tenant, because there is nowhere in
// the envelope to put one.

/** The transports that may exist. Phase 2A ships one; Phase 2B adds its own. */
export type SourceKind = "synthetic";

/** One inbound message, as any transport must present it. */
export interface InboundMessage {
  readonly sourceKind: SourceKind;
  /** The transport's own identifier. The admission identity, and a grant of nothing. */
  readonly externalMessageId: string;
  /** The sender as the transport names it. Never a CRM key. */
  readonly contactRef: string;
  /** What the person wrote. Bounded by the transport's own parser. */
  readonly body: string;
  readonly receivedAt: Date;
  /**
   * The consent state resolved BEFORE admission. A transport that cannot
   * resolve it says `true`: refusing to contact someone we know nothing about
   * is the fail-closed answer, and Phase 2A sends nothing either way.
   */
  readonly doNotContact: boolean;
}

/**
 * Where admitted work belongs. Built from trusted configuration by the caller,
 * never parsed from a delivery.
 */
export interface CommunicationTarget {
  readonly tenantId: string;
  readonly companyId: string;
  /** The agent the admitted task is assigned to, and which the run is requested for. */
  readonly agentId: string;
}

/**
 * An inbound transport. It parses and refuses; it does not admit, and it holds
 * no database handle — admission is `admitInboundMessage`'s job, in one
 * transaction, after the port has produced an envelope.
 */
export interface CommunicationPort {
  readonly sourceKind: SourceKind;
  /**
   * Parses one delivery into an envelope. Throws `CommunicationError` for
   * anything it will not admit; it never returns a partial message.
   */
  receive(delivery: unknown): InboundMessage;
}

export type CommunicationErrorCode =
  | "ingress_disabled"
  | "malformed_delivery"
  | "body_too_long";

/** A refusal by a transport, before anything durable happened. */
export class CommunicationError extends Error {
  readonly code: CommunicationErrorCode;

  constructor(code: CommunicationErrorCode, message: string) {
    super(message);
    this.name = "CommunicationError";
    this.code = code;
  }
}
