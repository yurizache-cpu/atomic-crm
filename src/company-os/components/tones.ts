// Which badge variant a state value gets. Presentation only: the value itself
// is always printed, so nothing depends on a colour.

export type BadgeTone = "default" | "secondary" | "destructive" | "outline";

const ATTENTION = new Set([
  "failed",
  "indeterminate",
  "blocked",
  "stopped",
  "stale",
  "held",
  "inactive",
  "indeterminate_not_retried",
  "running_without_live_lease",
  "unknown",
]);

const ACTIVE = new Set([
  "working",
  "running",
  "leased",
  "pending",
  "queued",
  "sending",
]);

export const toneOf = (value: string): BadgeTone => {
  if (value === "unknown") return "outline";
  if (ATTENTION.has(value)) return "destructive";
  if (ACTIVE.has(value)) return "default";
  return "secondary";
};
