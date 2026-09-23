import { POLL_INTERVAL_MS } from "./queryClient";

// The "unknown" rule of docs/PHASE_2C_BRIEF.md §10: state read more than two
// polling intervals ago is not shown as current. The age is measured from when
// this browser received the answer (TanStack's dataUpdatedAt), never from the
// server's asOf, so a clock difference between the two cannot hide it.

export const STATE_UNKNOWN_AFTER_MS = 2 * POLL_INTERVAL_MS;

/** How often a screen that shows live state looks at the clock again. */
export const FRESHNESS_TICK_MS = 1_000;

/** Whether an answer received at `receivedAt` may still be shown as current at `now`. */
export const isStateCurrent = (receivedAt: number, now: number): boolean =>
  receivedAt > 0 && now - receivedAt <= STATE_UNKNOWN_AFTER_MS;
