import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import type { LedgerStatus } from "./ingestionOutcome.ts";

/**
 * Durable ingestion ledger for the Postmark inbound webhook.
 *
 * The table is created by
 * `supabase/migrations/20260912090000_inbound_email_ledger.sql` and declared in
 * `supabase/schemas/01_tables.sql`. It exists so that an inbound email either
 * lands as a note or leaves a replayable record — never neither, which is what
 * the webhook did before this change.
 */
export const INBOUND_EMAILS_TABLE = "inbound_emails";

/**
 * Recipient key for a failure that belongs to the whole delivery rather than
 * to one recipient: an unparseable body, a missing field, a failed attachment
 * upload.
 *
 * It is the empty string and not NULL on purpose. A NULL in a unique index
 * deduplicates nothing — Postgres compares NULLs as distinct — so every
 * redelivery would insert another row instead of conflicting.
 */
export const MESSAGE_LEVEL_RECIPIENT = "";

/** Postgres `unique_violation`. This is the claim losing the CAS race. */
const UNIQUE_VIOLATION = "23505";

// `received_at` is selected because `decideReplay` needs it to tell a claim
// that is still in flight from one whose request died mid-work.
const LEDGER_COLUMNS = "id, status, attempts, received_at";

export interface LedgerRow {
  id: number;
  status: LedgerStatus;
  attempts: number;
  received_at: string;
}

export type ClaimResult =
  | { kind: "claimed"; row: LedgerRow }
  | { kind: "duplicate" }
  | { kind: "unavailable"; detail: string };

const logLedgerError = (operation: string, detail: string) => {
  console.error(
    JSON.stringify({
      event: "postmark.ledger.error",
      operation,
      detail,
    }),
  );
};

/**
 * Claim-before-work: insert the row first and let the unique index decide who
 * owns this (message_id, recipient). A SELECT-then-INSERT would race under
 * concurrent delivery and produce duplicate notes.
 *
 * Only the caller that gets `claimed` may do the work.
 */
export const claimDelivery = async ({
  messageId,
  recipientEmail,
  payload,
}: {
  messageId: string;
  recipientEmail: string;
  payload: Record<string, unknown>;
}): Promise<ClaimResult> => {
  const { data, error } = await supabaseAdmin
    .from(INBOUND_EMAILS_TABLE)
    .insert({
      message_id: messageId,
      recipient_email: recipientEmail,
      status: "pending",
      attempts: 1,
      payload,
    })
    .select(LEDGER_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { kind: "duplicate" };
    logLedgerError("claim", error.message);
    return { kind: "unavailable", detail: error.message };
  }
  if (!data) {
    const detail = "claim insert returned no row";
    logLedgerError("claim", detail);
    return { kind: "unavailable", detail };
  }
  return { kind: "claimed", row: data as unknown as LedgerRow };
};

/** Reads the row a previous delivery claimed, after a claim conflict. */
export const readDelivery = async (
  messageId: string,
  recipientEmail: string,
): Promise<{ row?: LedgerRow; detail?: string }> => {
  const { data, error } = await supabaseAdmin
    .from(INBOUND_EMAILS_TABLE)
    .select(LEDGER_COLUMNS)
    .eq("message_id", messageId)
    .eq("recipient_email", recipientEmail)
    .maybeSingle();

  if (error) {
    logLedgerError("read", error.message);
    return { detail: error.message };
  }
  if (!data) {
    const detail = "claim conflicted but no row could be read";
    logLedgerError("read", detail);
    return { detail };
  }
  return { row: data as unknown as LedgerRow };
};

/**
 * Counts this delivery against a row an earlier delivery claimed, and returns
 * the attempt number to decide on.
 *
 * Read-then-write rather than `attempts = attempts + 1`: PostgREST cannot
 * express column arithmetic, and an undercount costs a later cap, never a lost
 * message — so the race is acceptable where a lost write would not be.
 */
export const bumpAttempts = async (row: LedgerRow): Promise<number> => {
  const attempts = row.attempts + 1;
  const { error } = await supabaseAdmin
    .from(INBOUND_EMAILS_TABLE)
    .update({ attempts })
    .eq("id", row.id);

  if (error) {
    logLedgerError("bump_attempts", error.message);
    return row.attempts;
  }
  return attempts;
};

/**
 * Writes the final state of a claimed row.
 *
 * Returns whether the record now exists. The caller MUST NOT report a
 * permanent failure it could not write down: that is a silent drop, which is
 * the behaviour this whole change removes. `escalateUnrecordedFailure` in
 * `ingestionOutcome.ts` is the rule that handles it.
 */
export const settleDelivery = async (
  id: number,
  status: LedgerStatus,
  detail?: string,
): Promise<boolean> => {
  const { error } = await supabaseAdmin
    .from(INBOUND_EMAILS_TABLE)
    .update({
      status,
      error: detail ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    logLedgerError("settle", error.message);
    return false;
  }
  return true;
};

/**
 * Records a failure that belongs to the delivery rather than to one recipient.
 *
 * Returns whether a durable record now exists.
 */
export const recordMessageFailure = async ({
  messageId,
  payload,
  status,
  detail,
}: {
  messageId: string;
  payload: Record<string, unknown>;
  status: LedgerStatus;
  detail: string;
}): Promise<boolean> => {
  const claim = await claimDelivery({
    messageId,
    recipientEmail: MESSAGE_LEVEL_RECIPIENT,
    payload,
  });

  if (claim.kind === "claimed") {
    return await settleDelivery(claim.row.id, status, detail);
  }
  if (claim.kind === "unavailable") {
    return false;
  }

  // An earlier delivery already recorded this message: count the redelivery
  // and refresh the reason rather than inserting a second row.
  const existing = await readDelivery(messageId, MESSAGE_LEVEL_RECIPIENT);
  if (!existing.row) return false;
  await bumpAttempts(existing.row);
  return await settleDelivery(existing.row.id, status, detail);
};
