// Phase 2D.2: the owner's narrow repair of a shadow decision request that never
// ran (`npm run ops -- decision recover`).
//
// ops.recover_shadow_decision does the work, in the owner's transaction:
//
//   created    no evaluation existed under the current policy: requested now,
//              exactly as the post-settlement step would have;
//   stopped    an active stop covers it: nothing is created, enqueued or
//              recorded; run it again once a person has cleared the stop;
//   repaired   a pending evaluation had no job, or its job ended without ever
//              starting it: one new job is attached;
//   in_progress                        its job is still queued or leased, or it
//                                      was started under a live lease;
//   already_complete                   it settled (completed, invalid, failed
//                                      or refused): never rewritten;
//   indeterminate_requires_human_operator  it was started (running or
//                                      indeterminate): the provider may have
//                                      been asked, so it is NEVER asked again;
//   not_eligible                       outside the synthetic and test scope
//                                      (BASELINE Q8), or not a lead triage
//                                      review with a stored result.
//
// It decides no review, sends nothing, writes no CRM row and trips or clears no
// stop. Running it again is harmless: every outcome is idempotent.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export const RECOVERY_OUTCOMES = [
  "created",
  "stopped",
  "repaired",
  "in_progress",
  "already_complete",
  "indeterminate_requires_human_operator",
  "not_eligible",
] as const;

export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export interface RecoveredShadowDecision {
  readonly outcome: RecoveryOutcome;
  readonly evaluationId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("invalid_argument", `${field} must be a uuid`);
  }
  return value;
}

export async function recoverShadowDecision(
  tx: TxClient,
  input: { readonly tenantId: string; readonly reviewId: string },
): Promise<RecoveredShadowDecision> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const reviewId = requireUuid(input.reviewId, "reviewId");
  let answer: unknown;
  try {
    const { rows } = await tx.query<{ result: unknown }>(
      "select ops.recover_shadow_decision($1, $2) as result",
      [tenantId, reviewId],
    );
    answer = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  const outcome = (answer as { outcome?: unknown } | null)?.outcome;
  const evaluationId = (answer as { evaluationId?: unknown } | null)
    ?.evaluationId;
  if (
    typeof outcome !== "string" ||
    !(RECOVERY_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    throw new Error("ops.recover_shadow_decision returned no known outcome");
  }
  return {
    outcome: outcome as RecoveryOutcome,
    evaluationId:
      typeof evaluationId === "string" && UUID.test(evaluationId)
        ? evaluationId
        : null,
  };
}
