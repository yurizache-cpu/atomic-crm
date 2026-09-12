/**
 * Retry semantics for the Postmark inbound webhook, as pure functions.
 *
 * This module imports NOTHING, deliberately. The rules below decide whether an
 * inbound email is ingested, retried, duplicated or lost, and they have to be
 * provable without a database — the previous attempt at this change tangled
 * the same logic into the request handler, shipped with zero tests, and
 * reintroduced a fail-open inside the recipients loop
 * (docs/PHASE_0_5_REPORT.md §2.4).
 *
 * The rule a naive "return non-2xx on failure" fix gets backwards
 * (docs/design/postmark-ingestion.md §2):
 *
 *   ingested / duplicate  -> 200  success; a redelivery of a done message is
 *                                 also a success
 *   permanently invalid   -> 200  PLUS a durable failure record. Retrying
 *                                 cannot help, and a non-2xx here is a retry
 *                                 storm for a message that will never succeed
 *   transient             -> 500  the one case Postmark should retry
 */

/** Result of attempting one recipient of one delivery. */
export type RecipientOutcome =
  | "ingested"
  | "duplicate"
  | "permanent"
  | "transient";

/** Persisted state of a ledger row (`public.inbound_emails.status`). */
export type LedgerStatus =
  | "pending"
  | "ingested"
  | "failed_permanent"
  | "failed_transient";

export interface RecipientResult {
  /** Recipient address the outcome belongs to; "" when none could be read. */
  email: string;
  outcome: RecipientOutcome;
  /** Short reason, for the structured delivery log. */
  detail?: string;
}

/**
 * Deliveries counted before a repeatedly-failing message is reclassified as
 * permanent. Infinite retry is a decision, not a default
 * (docs/design/postmark-ingestion.md §5).
 */
export const MAX_DELIVERY_ATTEMPTS = 10;

/**
 * Maps the HTTP status `addNoteToContact` signals a failure with onto a retry
 * class. Its four known failures are the whole table:
 *
 *   sales lookup failed            500 -> transient
 *   sender has no active sales row 403 -> permanent
 *   contact/company creation faile 500 -> transient
 *   note insert failed             500 -> transient
 */
export const classifyFailureStatus = (
  status: number,
): "permanent" | "transient" => {
  // No amount of retrying turns an unknown sender into a known one.
  if (status === 403) return "permanent";
  // Every other known failure is a database failure, which is recoverable.
  // Anything unrecognised lands here on purpose: an unanalysed failure is not
  // a proven-hopeless one. A durable record is written either way, so assuming
  // "retryable" costs a bounded number of extra deliveries, while assuming
  // "hopeless" costs the email.
  return "transient";
};

/**
 * Folds every recipient's outcome into the delivery's outcome.
 *
 * This is the function the rejected implementation did not have. It returned
 * from inside the recipients loop, so one recipient's `transient` was
 * discarded the moment another recipient produced anything else.
 */
export const foldOutcomes = (
  outcomes: readonly RecipientOutcome[],
): RecipientOutcome => {
  // A delivery that produced no recipient outcomes ingested nothing. Calling
  // that a success is the fail-open this module exists to prevent.
  if (outcomes.length === 0) return "permanent";
  // Transient wins over everything, at any position. One recipient that could
  // still succeed is enough to require redelivery; the recipients that already
  // succeeded are protected from duplication by the ledger's unique index, not
  // by the HTTP status.
  if (outcomes.some((outcome) => outcome === "transient")) return "transient";
  if (outcomes.every((outcome) => outcome === "permanent")) return "permanent";
  // Nothing left to recover by retrying, and at least one recipient landed.
  return outcomes.some((outcome) => outcome === "ingested")
    ? "ingested"
    : "duplicate";
};

/** Transient is the only outcome Postmark should retry. */
export const httpStatusForOutcome = (outcome: RecipientOutcome): number =>
  outcome === "transient" ? 500 : 200;

export const ledgerStatusForOutcome = (
  outcome: "ingested" | "permanent" | "transient",
): LedgerStatus => {
  if (outcome === "ingested") return "ingested";
  return outcome === "permanent" ? "failed_permanent" : "failed_transient";
};

/**
 * A permanent failure that could not be written down is not permanent — it is
 * a silent drop, which is the exact behaviour this change removes. Escalating
 * it to transient makes Postmark deliver again, giving the ledger another
 * chance to record it.
 */
export const escalateUnrecordedFailure = (
  outcome: RecipientOutcome,
  recorded: boolean,
): RecipientOutcome =>
  outcome === "permanent" && !recorded ? "transient" : outcome;

export type ReplayDecision =
  | "skip-ingested"
  | "skip-failed-permanent"
  | "retry-work"
  | "give-up"
  | "wait-for-in-flight";

/**
 * Decides what a delivery should do when its claim insert was rejected by the
 * unique index, i.e. when some earlier delivery already claimed this
 * (message_id, recipient).
 *
 * `attempts` INCLUDES the delivery being decided.
 */
export const decideReplay = (
  existing: { status: string; attempts: number; received_at?: string | null },
  maxAttempts: number = MAX_DELIVERY_ATTEMPTS,
  now: number = Date.now(),
): ReplayDecision => {
  // Terminal states are terminal regardless of the attempt count.
  if (existing.status === "ingested") return "skip-ingested";
  if (existing.status === "failed_permanent") return "skip-failed-permanent";
  // Cap before replaying, so a dependency that never recovers stops the
  // provider's retries instead of accumulating them forever.
  if (existing.attempts >= maxAttempts) return "give-up";
  // Postmark's redelivery is the only retry mechanism there is; this is where
  // a transient failure actually gets replayed.
  if (existing.status === "failed_transient") return "retry-work";
  // A claim whose request died before settling stays `pending` forever. Without
  // this branch every redelivery is turned away, the attempt cap is reached,
  // and a message that was NEVER ingested is written off as
  // `failed_permanent` — the retry mechanism this change exists to provide,
  // defeated by its own bookkeeping. Design §6 names "pending older than N
  // minutes" as the triage signal; this is what consumes it.
  if (
    existing.status === "pending" &&
    isStalePending(existing.received_at, now)
  ) {
    return "retry-work";
  }
  // Fresh "pending", and any status this build does not recognise. Never
  // treated as success: another request may be mid-work, and that is resolved
  // by delivering again rather than by claiming the message landed.
  return "wait-for-in-flight";
};

/**
 * Prefix of the key minted when the payload carries no usable `MessageID`.
 * It is unique per DELIVERY, not per message, so it deduplicates nothing.
 */
export const SYNTHETIC_KEY_PREFIX = "unkeyed:";

/**
 * Whether a key can actually carry the idempotency guarantee.
 *
 * This lives in the pure module, rather than inline in the request handler, so
 * the invariant is testable: **a synthetic key must never reach the ingest
 * path**. If one did, every Postmark redelivery would claim a fresh row and
 * create another note — the ledger's whole purpose, defeated by its key. The
 * synthetic key is for recording failures that never do work.
 */
export const isUsableIdempotencyKey = (
  messageId: unknown,
): messageId is string =>
  typeof messageId === "string" &&
  messageId.length > 0 &&
  !messageId.startsWith(SYNTHETIC_KEY_PREFIX);

/**
 * How long a `pending` claim may sit before a redelivery is allowed to redo the
 * work. Long enough that a request still running is not raced, short enough
 * that a dead one is recovered within Postmark's own retry schedule.
 */
export const STALE_PENDING_MS = 5 * 60 * 1000;

/**
 * An unreadable or absent timestamp is deliberately NOT stale. The column is
 * `not null`, so reaching that branch means a query or schema bug, and the safe
 * answer to "I cannot tell how old this claim is" is to wait rather than to
 * re-run work that may be in flight — re-running risks a duplicate note, while
 * waiting risks only reaching the attempt cap, which still leaves the raw
 * payload on the row for a manual replay.
 */
export const isStalePending = (
  receivedAt: string | null | undefined,
  now: number = Date.now(),
): boolean => {
  if (!receivedAt) return false;
  const claimedAt = Date.parse(receivedAt);
  if (Number.isNaN(claimedAt)) return false;
  return now - claimedAt >= STALE_PENDING_MS;
};

/**
 * Runs `ingest` over every recipient and keeps every result.
 *
 * The loop lives here, away from the request handler, so that the rejected
 * implementation's bug is not merely fixed but unrepresentable: a `return`
 * inside `ingest` returns from `ingest`, and a throw is caught and turned into
 * a result instead of abandoning the recipients that follow.
 */
export const collectRecipientResults = async <TItem>(
  items: readonly TItem[],
  ingest: (item: TItem) => Promise<RecipientResult>,
  onUnexpectedError: (item: TItem, error: unknown) => RecipientResult,
): Promise<RecipientResult[]> => {
  const results: RecipientResult[] = [];
  for (const item of items) {
    try {
      results.push(await ingest(item));
    } catch (error) {
      results.push(onUnexpectedError(item, error));
    }
  }
  return results;
};
