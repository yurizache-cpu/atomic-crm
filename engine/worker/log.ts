// Structured worker logs.
//
// One JSON object per line on stdout, so an operator can grep it and a log
// shipper can parse it without a format.
//
// WHAT NEVER GOES IN A LOG LINE, and this is a rule rather than a convention
// because the first tenant is a psychology clinic under the LGPD:
//
//   * job payloads,
//   * anything read out of `public.*` — email bodies, note text, names,
//   * credentials, connection strings, tokens.
//
// Identifiers and counts only. `emit` takes a fixed set of fields rather than
// an open object so that "just log the payload while I debug this" is a change
// to this file, reviewed, rather than an inline decision in a handler.

export type WorkerLogEvent =
  | "worker.started"
  | "worker.stopping"
  | "worker.stopped"
  | "worker.heartbeat"
  | "worker.idle"
  | "worker.poll_failed"
  | "job.leased"
  | "job.handler_selected"
  | "job.attempt_started"
  | "job.attempt_completed"
  | "job.attempt_failed"
  | "job.retry_scheduled"
  | "job.terminal_failure"
  | "job.settlement_refused"
  | "lease.recovered";

export interface WorkerLogFields {
  workerId?: string;
  jobId?: string;
  tenantId?: string;
  kind?: string;
  attempt?: number;
  maxAttempts?: number;
  durationMs?: number;
  failureClass?: string;
  /** Short reason. Never a payload, never a stack, never row content. */
  detail?: string;
  count?: number;
}

export type WorkerLogger = (
  event: WorkerLogEvent,
  fields?: WorkerLogFields,
) => void;

const FIELD_ORDER: readonly (keyof WorkerLogFields)[] = [
  "workerId",
  "jobId",
  "tenantId",
  "kind",
  "attempt",
  "maxAttempts",
  "durationMs",
  "failureClass",
  "count",
  "detail",
];

/** Truncated so a driver's multi-kilobyte error cannot become the log. */
const MAX_DETAIL = 500;

export function formatLogLine(
  event: WorkerLogEvent,
  fields: WorkerLogFields = {},
  at: string,
): string {
  const line: Record<string, unknown> = { at, event };
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    line[key] = key === "detail" ? String(value).slice(0, MAX_DETAIL) : value;
  }
  return JSON.stringify(line);
}

export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => Date = () => new Date(),
): WorkerLogger {
  return (event, fields) => {
    write(formatLogLine(event, fields, now().toISOString()));
  };
}

/** For tests and for a worker asked to run silently. */
export const silentLogger: WorkerLogger = () => {};
