import { addNoteToContact } from "./addNoteToContact.ts";
import type { Attachment } from "./extractAndUploadAttachments.ts";
import {
  classifyFailureStatus,
  decideReplay,
  escalateUnrecordedFailure,
  ledgerStatusForOutcome,
  type RecipientResult,
} from "./ingestionOutcome.ts";
import {
  bumpAttempts,
  claimDelivery,
  readDelivery,
  recordMessageFailure,
  settleDelivery,
  type LedgerRow,
} from "./inboundEmailLedger.ts";

/** One entry of `extractMailContactData`'s output. */
export interface MailContact {
  firstName: string;
  lastName: string;
  email: string;
  domain: string;
  companyName: string;
  website: string;
}

export interface IngestRecipientParams {
  messageId: string;
  payload: Record<string, unknown>;
  salesEmail: string;
  noteContent: string;
  attachments: Attachment[];
  contact: MailContact;
}

/**
 * Either the ledger row this delivery owns and may work on, or the finished
 * result of a delivery that must not do the work.
 *
 * Expressed as a discriminated union rather than an early `return` out of the
 * caller, because an early return inside the recipients loop is the exact bug
 * that got the previous implementation rejected.
 */
type ClaimStep =
  | { proceed: true; row: LedgerRow }
  | { proceed: false; result: RecipientResult };

const claimOrResolve = async ({
  messageId,
  email,
  payload,
}: {
  messageId: string;
  email: string;
  payload: Record<string, unknown>;
}): Promise<ClaimStep> => {
  const claim = await claimDelivery({
    messageId,
    recipientEmail: email,
    payload,
  });

  if (claim.kind === "claimed") {
    return { proceed: true, row: claim.row };
  }

  if (claim.kind === "unavailable") {
    // No claim means no idempotency guarantee. Working anyway could duplicate
    // a note on the next delivery, and answering 200 would lose the message.
    return {
      proceed: false,
      result: {
        email,
        outcome: "transient",
        detail: `could not claim delivery: ${claim.detail}`,
      },
    };
  }

  // The unique index rejected the claim: some earlier delivery owns this
  // (message_id, recipient). What happens next depends on how that one ended.
  const existing = await readDelivery(messageId, email);
  if (!existing.row) {
    return {
      proceed: false,
      result: {
        email,
        outcome: "transient",
        detail: existing.detail ?? "claim conflicted but no row was readable",
      },
    };
  }

  const attempts = await bumpAttempts(existing.row);
  const decision = decideReplay({
    status: existing.row.status,
    attempts,
    received_at: existing.row.received_at,
  });

  switch (decision) {
    case "skip-ingested":
      return {
        proceed: false,
        result: { email, outcome: "duplicate", detail: "already ingested" },
      };
    case "skip-failed-permanent":
      return {
        proceed: false,
        result: {
          email,
          outcome: "permanent",
          detail: "already recorded as permanently failed",
        },
      };
    case "wait-for-in-flight":
      return {
        proceed: false,
        result: {
          email,
          outcome: "transient",
          detail: "an earlier delivery of this message is still pending",
        },
      };
    case "give-up": {
      const detail = `gave up after ${attempts} attempts`;
      const recorded = await settleDelivery(
        existing.row.id,
        "failed_permanent",
        detail,
      );
      return {
        proceed: false,
        result: {
          email,
          outcome: escalateUnrecordedFailure("permanent", recorded),
          detail,
        },
      };
    }
    case "retry-work":
      // Postmark's redelivery is the only retry mechanism there is, so this is
      // where a transient failure is actually replayed.
      return { proceed: true, row: existing.row };
  }
};

/**
 * Ingests one recipient of one delivery: claim, work, settle.
 *
 * Always returns a result — it never returns on behalf of the delivery, and
 * never reports success for work that did not happen.
 */
export const ingestRecipient = async ({
  messageId,
  payload,
  salesEmail,
  noteContent,
  attachments,
  contact,
}: IngestRecipientParams): Promise<RecipientResult> => {
  const email = (contact.email || "").toLowerCase();

  if (!email) {
    const detail = "a ToFull entry carries no email address";
    const recorded = await recordMessageFailure({
      messageId,
      payload,
      status: "failed_permanent",
      detail,
    });
    return {
      email: "",
      outcome: escalateUnrecordedFailure("permanent", recorded),
      detail,
    };
  }

  const step = await claimOrResolve({ messageId, email, payload });
  if (!step.proceed) return step.result;

  // The claim is already written, so an escaping throw would leave the row at
  // `pending` forever: `decideReplay` refuses to re-run work for a pending row,
  // so every redelivery would be turned away until the attempt cap gave up on a
  // message that was never ingested. Settling here is what keeps the row
  // replayable. The outer `collectRecipientResults` net stays as the guard for
  // anything this block does not cover.
  let failure: Response | undefined;
  try {
    failure = await addNoteToContact({
      salesEmail,
      email,
      domain: contact.domain,
      firstName: contact.firstName,
      lastName: contact.lastName,
      noteContent,
      attachments,
      companyName: contact.companyName,
      website: contact.website,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await settleDelivery(step.row.id, "failed_transient", detail);
    return { email, outcome: "transient", detail };
  }

  if (!failure) {
    // A failed settle here leaves the row `pending` with the note already
    // created. That is the designed triage signal ("pending older than N
    // minutes"), and nothing is lost, so the outcome stays `ingested`.
    await settleDelivery(step.row.id, "ingested");
    return { email, outcome: "ingested" };
  }

  // `addNoteToContact` signals failure by RETURNING a Response. Before this
  // change the caller discarded it and answered 200 regardless.
  const outcome = classifyFailureStatus(failure.status);
  const detail = `${failure.status}: ${await failure.text()}`;
  const recorded = await settleDelivery(
    step.row.id,
    ledgerStatusForOutcome(outcome),
    detail,
  );

  return {
    email,
    outcome: escalateUnrecordedFailure(outcome, recorded),
    detail,
  };
};
