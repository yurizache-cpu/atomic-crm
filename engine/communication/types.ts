// The communication boundary: the smallest thing that can carry a message
// between a transport and the Company OS, and nothing more.
//
// TWO DIRECTIONS, TWO PORTS, deliberately separate:
//
//   * INBOUND (`CommunicationPort`, and the WhatsApp webhook parser): a
//     transport parses its own delivery format into an envelope. Admission,
//     idempotency, the task, the run and the review are transport-agnostic.
//   * OUTBOUND (`OutboundTransport`, Phase 2B): a transport EXECUTES one send
//     that the Company OS already authorized. It decides nothing. Whether a
//     message may be sent (a person's explicit request, an accepted review,
//     consent read fresh at that moment, BASELINE Q8) is decided in the
//     database before a transport is ever asked (ops.begin_outbound_send).
//
// WHAT IS STILL ABSENT: automatic sending of any kind, attachments, templates,
// an inbox, and any transport-side notion of tenant or consent.
//
// TENANCY. No envelope carries a tenant, company or agent. For the synthetic
// transport they come from `CommunicationTarget`, built from trusted
// configuration; for WhatsApp, from the owner-configured provider target
// (ops.communication_channels). A payload cannot select a tenant, because
// there is nowhere in an envelope to put one.

/** The transports that may exist. */
export type SourceKind = "synthetic" | "whatsapp";

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
  // NO consent field, deliberately. A message cannot vouch for its own
  // sender's consent: whether a contact may be contacted comes from a
  // ContactPolicy the caller trusts, never from the delivery.
}

/**
 * A TRUSTED answer to "may this contact be contacted?", resolved by the
 * caller and never read from a delivery.
 *
 * Phase 2A: a synthetic fixture built from trusted configuration
 * (syntheticContactPolicy.ts). Phase 2B replaces it with a read-only lookup of
 * the CRM's lead_profiles.do_not_contact, behind a port — never a foreign key
 * from the engine into public.*.
 */
export interface ContactPolicy {
  /**
   * True when the contact must not be contacted, and ALSO when that is
   * unknown: refusing to contact someone we know nothing about is the
   * fail-closed answer. Only an explicit `false` makes a contact eligible.
   */
  doNotContact(contactRef: string): boolean;
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

/**
 * What the read-only CRM adapter (ops.crm_contact_by_phone) can answer. Only
 * `found` names a contact, and even then only its opt-out flag decides
 * anything: the CRM records no affirmative consent.
 */
export type ContactResolution =
  | "found"
  | "not_found"
  | "ambiguous"
  | "unavailable";

/**
 * One send the Company OS ALREADY authorized, as a transport is asked to make
 * it. Built only by ops.begin_outbound_send, in the transaction that committed
 * the send as in flight.
 */
export interface OutboundRequest {
  /** The channel's provider target (for Meta, the sending phone number id). */
  readonly providerTarget: string;
  /** The recipient as the transport names them (for WhatsApp, a WhatsApp id). */
  readonly to: string;
  readonly body: string;
  /**
   * This system's id for the send, carried to the provider so that a status
   * callback can name the send even when the call's response was lost.
   */
  readonly correlation: string;
}

/**
 * What ONE provider call produced, as data.
 *
 *   * accepted: the provider took the message and named it.
 *   * rejected: the provider definitively refused it; nothing was sent.
 *   * ambiguous: the provider may or may not have sent it (a timeout, a lost
 *     response, a 5xx, a malformed success). Never retried by the system.
 *
 * Codes and classes only, never provider text: a provider message can echo
 * the request, and the request carries a person's words.
 */
export type OutboundOutcome =
  | { readonly kind: "accepted"; readonly providerMessageId: string }
  | {
      readonly kind: "rejected";
      readonly errorCode: string | null;
      readonly errorClass: string;
    }
  | { readonly kind: "ambiguous"; readonly errorClass: string };

/**
 * An outbound transport. It executes; it never authorizes, and it never
 * retries: `send` makes AT MOST ONE provider call and never throws.
 */
export interface OutboundTransport {
  readonly provider: "meta_whatsapp";
  send(request: OutboundRequest): Promise<OutboundOutcome>;
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
