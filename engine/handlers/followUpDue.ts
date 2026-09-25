// Phase 3A.1: a follow-up becomes due.
//
// Every follow-up occurrence has ONE `follow_up.due` job on the existing queue,
// available at its due time (ops.schedule_follow_up_plan). When the queue
// leases it, this handler asks the database to move that occurrence from
// scheduled to due, and that is all: a due follow-up is a piece of operator
// work the owner sees in the Company OS, never a permission to contact anyone.
// Nothing here sends a message, calls a model or a provider, or writes the CRM.
//
// GOVERNED, not internal (jobKinds.ts): the kill switch holds the job at the
// lease, and the runtime asks it again at the start of this transaction,
// before `run`. Under a covering stop the job is deferred with its attempt
// given back and the occurrence stays scheduled, recorded and untouched,
// until the stop is cleared.
//
// IDEMPOTENT. The capability resolves the occurrence from the leased job, never
// from the payload, and changes nothing on a replay: the database answers
// already_due, completed, cancelled or superseded. The change and the job's
// completion share one transaction, so a crash between them discards both.

import { PermanentError } from "../worker/failures.ts";
import type { HandlerDefinition } from "../worker/handlerRegistry.ts";

export const FOLLOW_UP_DUE_KIND = "follow_up.due";

/** The answers ops.mark_follow_up_due() gives. Anything else is a contract break. */
export const FOLLOW_UP_DUE_ANSWERS: readonly string[] = Object.freeze([
  "due",
  "already_due",
  "completed",
  "cancelled",
  "superseded",
]);

export const followUpDue: HandlerDefinition<"markFollowUpDue"> = {
  kind: FOLLOW_UP_DUE_KIND,
  capabilities: ["markFollowUpDue"],
  async run(_job, capabilities) {
    const answer = await capabilities.markFollowUpDue();
    if (!FOLLOW_UP_DUE_ANSWERS.includes(answer)) {
      // Retrying the same code returns the same answer.
      throw new PermanentError(
        "ops.mark_follow_up_due answered outside its contract",
      );
    }
    // A status token only: the job detail is metadata, never content.
    return `follow_up=${answer}`;
  },
};
