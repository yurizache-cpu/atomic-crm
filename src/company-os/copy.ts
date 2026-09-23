// The fixed sentences the read-only screens show (docs/PHASE_2C_BRIEF.md §7.5,
// §10, §12). One place, so a test can pin them and a review sees every change.
//
// No sentence here, and no label anywhere in the module, says or implies that
// a message, draft or reply was approved for sending: recording a review
// decision is never a send (REVIEW ACCEPTANCE ≠ SEND, SI-45, SI-58).

export const REVIEW_DECISIONS_CLI_NOTE =
  "Decisions are recorded through the operator CLI in this phase.";

export const REVIEW_NOT_A_SEND_NOTE =
  "Recording a decision never approves or sends a reply.";

export const REPLY_DRAFT_NOTE = "The reply draft is never shown here.";

export const NEEDS_EDIT_TEXT = "recorded; no follow-up path in this phase";

export const ALLOWED_DECISIONS_NOTE =
  "Shown for information only: these are the decisions the server would accept for this review.";

export const STOP_CLEAR_NOTE = "Clearing a stop is an operator CLI act.";

export const STOP_JOB_KIND_NOTE =
  "A job_kind stop naming this tenant is listed read-only.";

export const STOP_PLATFORM_NOTE =
  "Only stops naming this tenant are listed; a platform stop shows only as the platform admission state on the Overview and Costs screens.";

export const STOP_EVENTS_LABEL = "Stop trips write no event";

/**
 * The `authorized` outbound state: recorded by an operator's CLI send request,
 * never by a review decision (REVIEW ACCEPTANCE is not a send, §7.5).
 */
export const OUTBOUND_AUTHORIZED_TEXT =
  "send authorized by an operator send request";

export const ACCEPTED_WITHOUT_SEND_LABEL =
  "Accepted reviews with no send recorded";

export const OVERVIEW_PROOF_NOTE =
  "Where a list cannot yet be narrowed to exactly what a count counts, the count says so beside it: that list holds every record counted, among others.";

export const PLATFORM_ADMISSION_LABEL =
  "New agent runs blocked by the platform";

export const LIFECYCLE_STATUS_LABEL = "Lifecycle status (structural)";

export const LIFECYCLE_STATUS_NOTE =
  "The lifecycle status is structural, not progress: the pipeline shows how far the work went.";

export const STATE_UNKNOWN_NOTE =
  "State unknown: the last answer is older than two polling intervals. It is shown again once a new answer arrives.";

export const ABSENT_STEP_TEXT = "Absent: no durable fact records this step.";

export const NOT_LOADED_STEP_TEXT =
  "Not loaded yet: older facts remain unread. Load more to see whether one records this step.";

/** get_task carries a task's 20 most recent runs, never more (brief §8 row 6). */
export const TASK_RUNS_LIMIT = 20;

export const TASK_RUNS_CAPPED_NOTE = `Only this task's ${TASK_RUNS_LIMIT} most recent runs are read here; older runs of the task are on the Agent runs screen.`;

export const JOB_STEPS_NOTE =
  "Job steps come from the run's own job, not from the event feed; they carry no id.";

export const COMMUNICATIONS_SCOPE_NOTE =
  "Status counts and channel labels only: no message, contact or conversation is listed, and nothing can be changed or sent from here.";

export const MONEY_NOTE =
  "Every amount is the server's own figure; this screen does no arithmetic.";
