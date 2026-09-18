// The Phase 2A transport: synthetic messages, and only when a person turned it
// on for this process.
//
// WHAT MAKES IT SAFE, in the order that matters:
//
//   1. It has NO NETWORK SURFACE. There is no edge function, no HTTP route and
//      no webhook that reaches it. The only caller is a local CLI run by
//      someone who already holds the database credential. A transport that
//      cannot be reached from the internet cannot be reached from the internet
//      by accident either — this is the property, and the flag below is the
//      belt to its braces.
//   2. It is OFF unless COMPANY_OS_SYNTHETIC_INGRESS is exactly "enabled".
//      Not "true", not "1", not "yes": a value that merely looks truthy is
//      refused, because those are the values that end up in a deployment
//      environment by accident.
//   3. Everything it admits is marked `synthetic` all the way into the
//      database, where ops.inbound_messages.source_kind admits nothing else.
//
// Q8 (BASELINE): this is why Phase 2A is synthetic-only in a way that can be
// checked rather than promised. A real message has no path through this file.

import { z } from "zod";
import {
  CommunicationError,
  type CommunicationPort,
  type InboundMessage,
} from "./types.ts";

export const SYNTHETIC_SOURCE_KIND = "synthetic" as const;

/** The one variable that turns the synthetic transport on. */
export const SYNTHETIC_INGRESS_FLAG = "COMPANY_OS_SYNTHETIC_INGRESS";

/** The one value that turns it on. Any other value, and it stays off. */
export const SYNTHETIC_INGRESS_ENABLED_VALUE = "enabled";

/**
 * Well under ops.tasks.description's 10000 and equal to the prompt builder's
 * own ceiling, so a message that is admitted is a message the model sees whole.
 */
export const MAX_SYNTHETIC_BODY_LENGTH = 4000;
export const MAX_EXTERNAL_MESSAGE_ID_LENGTH = 200;
export const MAX_CONTACT_REF_LENGTH = 200;

/** Printable ASCII, the shape ops.admit_inbound_message enforces. */
const PRINTABLE = /^[\x21-\x7e]+$/;

const deliverySchema = z.strictObject({
  external_message_id: z
    .string()
    .min(1)
    .max(MAX_EXTERNAL_MESSAGE_ID_LENGTH)
    .regex(PRINTABLE),
  contact_ref: z.string().min(1).max(MAX_CONTACT_REF_LENGTH).regex(PRINTABLE),
  body: z.string().min(1),
  received_at: z.iso.datetime({ offset: true }).optional(),
  // No consent field. strictObject refuses one as an unknown key: a delivery
  // cannot declare its own sender contactable (ContactPolicy in types.ts).
});

export interface SyntheticIngressEnv {
  readonly [name: string]: string | undefined;
}

/** Whether this process may admit synthetic messages at all. */
export const isSyntheticIngressEnabled = (env: SyntheticIngressEnv): boolean =>
  env[SYNTHETIC_INGRESS_FLAG] === SYNTHETIC_INGRESS_ENABLED_VALUE;

/**
 * The synthetic transport, or a refusal. Reads exactly one variable, and never
 * reports its value.
 *
 * Throws `CommunicationError("ingress_disabled")` when the flag is absent or is
 * anything other than the exact enabling value.
 */
export function createSyntheticCommunicationPort(
  env: SyntheticIngressEnv,
): CommunicationPort {
  if (!isSyntheticIngressEnabled(env)) {
    throw new CommunicationError(
      "ingress_disabled",
      `the synthetic ingress is off: set ${SYNTHETIC_INGRESS_FLAG}=${SYNTHETIC_INGRESS_ENABLED_VALUE} to admit test messages`,
    );
  }

  return Object.freeze({
    sourceKind: SYNTHETIC_SOURCE_KIND,

    receive(delivery: unknown): InboundMessage {
      const parsed = deliverySchema.safeParse(delivery);
      if (!parsed.success) {
        // The issues quote the delivery, which is the untrusted part; the
        // refusal names the shape instead.
        throw new CommunicationError(
          "malformed_delivery",
          "a synthetic delivery is {external_message_id, contact_ref, body, received_at?}",
        );
      }
      // Length is checked after the shape so the message says which rule the
      // delivery broke, and it is checked here rather than in the schema so a
      // long body is not reported as a malformed envelope.
      if (parsed.data.body.length > MAX_SYNTHETIC_BODY_LENGTH) {
        throw new CommunicationError(
          "body_too_long",
          `a synthetic message body is at most ${MAX_SYNTHETIC_BODY_LENGTH} characters`,
        );
      }
      if (parsed.data.body.trim() === "") {
        throw new CommunicationError(
          "malformed_delivery",
          "a synthetic message body cannot be blank",
        );
      }

      return Object.freeze({
        sourceKind: SYNTHETIC_SOURCE_KIND,
        externalMessageId: parsed.data.external_message_id,
        contactRef: parsed.data.contact_ref,
        body: parsed.data.body,
        receivedAt:
          parsed.data.received_at === undefined
            ? new Date()
            : new Date(parsed.data.received_at),
      });
    },
  });
}
