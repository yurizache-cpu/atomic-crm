// The agent run state machine, as data the TypeScript side can type against.
//
// THIS AUTHORISES NOTHING. The only enforcement point is the BEFORE UPDATE
// trigger on ops.agent_runs (ENABLE ALWAYS, so replica mode does not silence
// it), which checks every status change against
// ops.agent_run_status_transitions(). This module exists so callers can type a
// run status and reason about it without a round trip, and a driver-backed test
// asserts its edge set equals the database's, so the two cannot drift.
//
// The machine is small on purpose. A run is STARTED ONCE: nothing returns to
// `pending`, nothing returns to `running`, and nothing leaves a finished status.
// A retry is a new run that names the one it repeats, never a transition.
//
// String-literal unions and `as const`, never an enum: the engine runs under
// Node's type stripping, which cannot erase an enum.

export const AGENT_RUN_STATUSES = Object.freeze([
  "pending",
  "running",
  "succeeded",
  "failed",
  "indeterminate",
  "cancelled",
] as const);

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Terminal: a run in one of these is finished, and a finished run is immutable. */
export const FINISHED_AGENT_RUN_STATUSES: readonly AgentRunStatus[] =
  Object.freeze(["succeeded", "failed", "indeterminate", "cancelled"]);

/**
 * Every legal status change. Engine vocabulary — the same for every tenant —
 * which is why it is fixed here and in the schema rather than configured.
 *
 *   pending -> running        started, committed BEFORE the provider call
 *   pending -> cancelled      a deterministic gate or an execution stop refused
 *                             it; no call happened
 *   pending -> failed         it could not be attempted (no configured route) or
 *                             its job ended first; no call happened
 *   running -> succeeded      a result the database itself validated
 *   running -> failed         the outcome is known and unusable
 *   running -> indeterminate  a call may have happened and nobody can tell, so
 *                             it is never issued again
 *
 * There is no `running -> cancelled`: once the start is committed, a call may
 * already be on the wire, and calling that "cancelled" would claim a certainty
 * nobody has.
 */
export const AGENT_RUN_TRANSITIONS: ReadonlyArray<
  readonly [from: AgentRunStatus, to: AgentRunStatus]
> = Object.freeze([
  Object.freeze(["pending", "running"] as const),
  Object.freeze(["pending", "cancelled"] as const),
  Object.freeze(["pending", "failed"] as const),
  Object.freeze(["running", "succeeded"] as const),
  Object.freeze(["running", "failed"] as const),
  Object.freeze(["running", "indeterminate"] as const),
]);

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return (
    typeof value === "string" &&
    (AGENT_RUN_STATUSES as readonly string[]).includes(value)
  );
}

export function isFinishedAgentRunStatus(status: AgentRunStatus): boolean {
  return FINISHED_AGENT_RUN_STATUSES.includes(status);
}

export function canTransitionAgentRun(
  from: AgentRunStatus,
  to: AgentRunStatus,
): boolean {
  return AGENT_RUN_TRANSITIONS.some(([f, t]) => f === from && t === to);
}
