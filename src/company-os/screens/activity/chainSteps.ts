import type { EventSummary } from "../../../../contracts/company-os-api/index.ts";

// The inspectable chain of docs/PHASE_2C_BRIEF.md §11. Insertion order is not
// step order (admission writes six facts in one transaction), so a chain lays
// the facts out by STEP and shows each fact's own time. A step with no durable
// fact is shown as absent, never inferred. Task-level steps read the events
// whose subject is the task; the run-level steps read the events whose subject
// is the run, and the id-free job steps projected from the run's own job.

/** A chain reads the events of one subject 100 at a time, more on request. */
export const CHAIN_EVENTS_PAGE = 100;

export interface ChainStep {
  readonly id: string;
  readonly label: string;
  /** The event types that record this step; none for the job step. */
  readonly eventTypes: readonly string[];
}

export const TASK_STEPS_BEFORE_RUNS: readonly ChainStep[] = [
  {
    id: "received",
    label: "Event received",
    eventTypes: ["communication.received", "lead_triage.admitted"],
  },
  {
    id: "task-created",
    label: "Task created",
    eventTypes: ["task.created", "task.assigned"],
  },
  {
    // The task-side fact of a run request; the run's own fact is the run
    // block's "Run requested". Two steps, two labels.
    id: "execution-requested",
    label: "Execution requested",
    eventTypes: ["task.execution_requested"],
  },
];

/** The job step has no ops.events fact: it reads the run's job steps. */
export const JOB_STEP_ID = "job-leased";

export const RUN_STEPS: readonly ChainStep[] = [
  {
    id: "run-requested",
    label: "Run requested",
    eventTypes: ["agent_run.requested"],
  },
  { id: JOB_STEP_ID, label: "Job leased", eventTypes: [] },
  {
    id: "call-begun",
    label: "Provider call begun",
    eventTypes: ["agent_run.started"],
  },
  {
    id: "settled",
    label: "Result settled",
    eventTypes: [
      "agent_run.succeeded",
      "agent_run.failed",
      "agent_run.indeterminate",
      "agent_run.cancelled",
    ],
  },
];

export const TASK_STEPS_AFTER_RUNS: readonly ChainStep[] = [
  {
    id: "review-opened",
    label: "Review opened",
    eventTypes: ["lead_triage.review_pending"],
  },
  {
    id: "decision",
    label: "Operator decision",
    eventTypes: ["lead_triage.reviewed"],
  },
  {
    id: "send-requested",
    label: "Outbound send requested",
    eventTypes: [
      "communication.outbound_authorized",
      "communication.outbound_attempted",
      "communication.outbound_blocked",
    ],
  },
  {
    id: "provider-result",
    label: "Provider result or status",
    eventTypes: [
      "communication.outbound_sent",
      "communication.outbound_failed",
      "communication.outbound_indeterminate",
      "communication.delivery_updated",
    ],
  },
];

const byTime = (
  left: { readonly createdAt: string },
  right: { readonly createdAt: string },
): number =>
  left.createdAt === right.createdAt
    ? 0
    : left.createdAt < right.createdAt
      ? -1
      : 1;

/** A copy of `records`, oldest first (contract timestamps sort as text). */
export const oldestFirst = <T extends { readonly createdAt: string }>(
  records: readonly T[],
): T[] => [...records].sort(byTime);

/** The facts that record `step`, oldest first. */
export const eventsOfStep = (
  events: readonly EventSummary[],
  step: ChainStep,
): readonly EventSummary[] =>
  events.filter((event) => step.eventTypes.includes(event.type)).sort(byTime);

/** Facts about the subject that belong to none of `steps`: shown, not hidden. */
export const eventsOutside = (
  events: readonly EventSummary[],
  steps: readonly ChainStep[],
): readonly EventSummary[] =>
  events
    .filter(
      (event) => !steps.some((step) => step.eventTypes.includes(event.type)),
    )
    .sort(byTime);
