// BASELINE Q8, owner decisions D6 and D7: a protected flow's AI working
// content reaches the end of its retention.
//
// When a review of a health or person_text task is decided, the database
// anchors the flow's clock at that decision and queues ONE
// `content.retention_due` job, available at the due instant
// (ops.schedule_content_retention). When the queue leases it, this handler asks
// the database to redact that flow's content in place, and that is all: the
// task, run and review rows stay, with every content-free fact on them.
//
// INTERNAL, not governed (jobKinds.ts): maintenance the kill switch never
// holds, because an erasure obligation does not pause with execution. It calls
// nothing outside the database.
//
// IDEMPOTENT. The capability resolves the flow from the leased job, never from
// the payload, and a replay changes nothing: the database answers
// already_redacted, or superseded when a later decided review moved the clock
// and its own job took the binding. A flow still in progress (a run pending or
// running, a review undecided) is retried later, never redacted under it.

import { PermanentError, TransientError } from "../worker/failures.ts";
import type { HandlerDefinition } from "../worker/handlerRegistry.ts";

export const CONTENT_RETENTION_DUE_KIND = "content.retention_due";

/** The answers after which the job is done. */
export const CONTENT_RETENTION_FINAL_ANSWERS: readonly string[] = Object.freeze(
  ["redacted", "already_redacted", "superseded"],
);

/** The answers that mean "not yet": the job is tried again later. */
export const CONTENT_RETENTION_RETRY_ANSWERS: readonly string[] = Object.freeze(
  ["in_progress", "not_due"],
);

export const contentRetentionDue: HandlerDefinition<"redactDueContent"> = {
  kind: CONTENT_RETENTION_DUE_KIND,
  capabilities: ["redactDueContent"],
  async run(_job, capabilities) {
    const answer = await capabilities.redactDueContent();
    if (CONTENT_RETENTION_RETRY_ANSWERS.includes(answer)) {
      throw new TransientError(`content retention: ${answer}`);
    }
    if (!CONTENT_RETENTION_FINAL_ANSWERS.includes(answer)) {
      // Retrying the same code returns the same answer.
      throw new PermanentError(
        "ops.redact_due_content answered outside its contract",
      );
    }
    // A status token only: the job detail is metadata, never content.
    return `content_retention=${answer}`;
  },
};
