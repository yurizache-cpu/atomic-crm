// ADR 0026 §C: a contact's opt-out reaches the CRM.
//
// Every screening that detects an opt-out queues ONE `crm.opt_out_record` job,
// due at the end of the conversation's 24-hour window and moved to now when
// the opt-out's acknowledgement settles. When the queue leases it, this
// handler asks the database to record that opt-out, and that is all: the
// exact contact's lead_profiles.do_not_contact becomes true (recorded in the
// CRM's consent ledger as the system's, naming the message), the act is
// recorded and the opt_out exception reconciled.
//
// INTERNAL, not governed (jobKinds.ts): an opt-out is protective, so the kill
// switch never holds it. It calls nothing outside the database.
//
// IDEMPOTENT. The capability resolves its request from the leased job, never
// from the payload; a replay answers already_settled, or superseded when the
// job is no longer the bound one. An opt-out not yet due, or whose
// acknowledgement is still on its way, is moved to a new job and answers
// deferred, so this job succeeds and no attempt is spent waiting. An opt-out
// a person dismissed answers dismissed and records nothing.

import { PermanentError } from "../worker/failures.ts";
import type { HandlerDefinition } from "../worker/handlerRegistry.ts";

export const CRM_OPT_OUT_RECORD_KIND = "crm.opt_out_record";

/** The answers ops.record_due_opt_out() gives. Anything else is a contract break. */
export const CRM_OPT_OUT_RECORD_ANSWERS: readonly string[] = Object.freeze([
  "recorded",
  "already_recorded",
  "unresolved",
  "dismissed",
  "erased",
  "deferred",
  "superseded",
  "already_settled",
]);

export const crmOptOutRecordDue: HandlerDefinition<"recordDueOptOut"> = {
  kind: CRM_OPT_OUT_RECORD_KIND,
  capabilities: ["recordDueOptOut"],
  async run(_job, capabilities) {
    const answer = await capabilities.recordDueOptOut();
    if (!CRM_OPT_OUT_RECORD_ANSWERS.includes(answer)) {
      // Retrying the same code returns the same answer.
      throw new PermanentError(
        "ops.record_due_opt_out answered outside its contract",
      );
    }
    // A status token only: the job detail is metadata, never a number.
    return `crm_opt_out_record=${answer}`;
  },
};
