import type { AgentRunStatus } from "../../../../contracts/company-os-api/index.ts";

// Which run statuses may still change, for the "unknown" rule of
// docs/PHASE_2C_BRIEF.md §10: a state read more than two polling intervals ago
// is not shown as current. A run that is pending or running, or that needs
// attention (an indeterminate run no retry has answered yet, a running one
// without a live lease), can change under a stale answer: its status reads
// "unknown" once the answer is too old, and a screen showing one re-reads it
// every polling interval while visible. A run that settled (succeeded, failed,
// cancelled, or indeterminate and retried) has reached its final state: it is
// neither re-read nor aged.

const LIVE_STATUSES: readonly AgentRunStatus[] = ["pending", "running"];

export interface RunState {
  readonly status: AgentRunStatus;
  /**
   * A summary's attention; absent where the projection carries only the
   * status (a task's pipeline), and then an indeterminate run counts as
   * live, since whether a retry answered it is not known there.
   */
  readonly attention?: string | null;
}

/** Whether a run's status, or its attention, can still change. */
export const isLiveRun = (run: RunState): boolean =>
  LIVE_STATUSES.includes(run.status) ||
  (run.attention === undefined
    ? run.status === "indeterminate"
    : run.attention !== null);

/** What to print for a run's status: "unknown" when the answer is stale and the run live. */
export const shownRunStatus = (run: RunState, fresh: boolean): string =>
  fresh || !isLiveRun(run) ? run.status : "unknown";
