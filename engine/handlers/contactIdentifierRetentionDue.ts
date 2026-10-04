// ADR 0021 W5: a sender's phone number reaches the end of its retention.
//
// Every WhatsApp conversation has ONE `contact.identifier_retention_due` job,
// available 12 months after the sender's last message and moved forward while
// it is queued when they write again (ops.refresh_contact_identifier_retention).
// When the queue leases it, this handler asks the database to erase that
// conversation's number in place, and that is all: the number becomes the
// conversation's tombstone on the conversation and on every admission of it,
// and every content-free fact stays.
//
// INTERNAL, not governed (jobKinds.ts): maintenance the kill switch never
// holds, because an erasure obligation does not pause with execution. It calls
// nothing outside the database.
//
// IDEMPOTENT. The capability resolves the conversation from the leased job,
// never from the payload, and a replay changes nothing: the database answers
// already_erased, or superseded when the job is no longer the bound one. A
// conversation whose clock moved forward while this job ran is not erased:
// the database binds its next job at the new due instant and answers deferred,
// so this job succeeds and no attempt is spent waiting.

import { PermanentError } from "../worker/failures.ts";
import type { HandlerDefinition } from "../worker/handlerRegistry.ts";

export const CONTACT_IDENTIFIER_RETENTION_DUE_KIND =
  "contact.identifier_retention_due";

/** The answers ops.erase_due_contact_identifier() gives. Anything else is a contract break. */
export const CONTACT_IDENTIFIER_RETENTION_ANSWERS: readonly string[] =
  Object.freeze(["erased", "already_erased", "superseded", "deferred"]);

export const contactIdentifierRetentionDue: HandlerDefinition<"eraseDueContactIdentifier"> =
  {
    kind: CONTACT_IDENTIFIER_RETENTION_DUE_KIND,
    capabilities: ["eraseDueContactIdentifier"],
    async run(_job, capabilities) {
      const answer = await capabilities.eraseDueContactIdentifier();
      if (!CONTACT_IDENTIFIER_RETENTION_ANSWERS.includes(answer)) {
        // Retrying the same code returns the same answer.
        throw new PermanentError(
          "ops.erase_due_contact_identifier answered outside its contract",
        );
      }
      // A status token only: the job detail is metadata, never a number.
      return `contact_identifier_retention=${answer}`;
    },
  };
