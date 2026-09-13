// The task state machine, as data the TypeScript side can type against.
//
// THIS AUTHORISES NOTHING. The only enforcement point is the BEFORE UPDATE
// trigger on ops.tasks, which checks every status change against
// ops.task_status_transitions() for every role but the owner. This module
// exists so callers can type a status and know the next legal ones without a
// round trip — and a driver-backed test asserts its edge set equals the
// database's, so the two cannot drift.
//
// String-literal unions and `as const`, never an enum: the engine runs under
// Node's type stripping, which cannot erase an enum.

export const TASK_STATUSES = [
  "queued",
  "assigned",
  "in_progress",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Terminal: a task in one of these is closed, and a closed task is immutable. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = Object.freeze([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * Every legal status change. Engine vocabulary — the same for every tenant,
 * which is why it is fixed here and in the schema rather than configured.
 *
 * `queued -> assigned` happens only through an assignment. There is no edge
 * back to `queued` (reassign instead), and none out of a closed status: a
 * retried piece of work is a new task.
 */
export const TASK_TRANSITIONS: ReadonlyArray<
  readonly [from: TaskStatus, to: TaskStatus]
> = Object.freeze([
  ["queued", "assigned"],
  ["queued", "cancelled"],
  ["assigned", "in_progress"],
  ["assigned", "cancelled"],
  ["in_progress", "waiting"],
  ["in_progress", "completed"],
  ["in_progress", "failed"],
  ["in_progress", "cancelled"],
  ["waiting", "in_progress"],
  ["waiting", "failed"],
  ["waiting", "cancelled"],
] as const);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

export function isClosed(status: TaskStatus): boolean {
  return CLOSED_TASK_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

/** The statuses reachable in one step, in declaration order. */
export function nextStatuses(from: TaskStatus): TaskStatus[] {
  return TASK_TRANSITIONS.filter(([f]) => f === from).map(([, to]) => to);
}
