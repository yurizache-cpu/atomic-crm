// The failure taxonomy. Deterministic, typed, and small.
//
// The rule this module exists to enforce: NOT every exception is a retry. A
// worker that retries everything turns a permanently invalid payload into an
// infinite loop, and turns a security refusal into a repeated attack.
//
// Nothing here uses a model to classify an error. Classification is a lookup
// over error types and Postgres SQLSTATE codes, so the same failure always
// lands in the same class.

/** Matches ops.jobs.last_error_class. The database enforces the same four. */
export type FailureClass = "transient" | "permanent" | "security" | "unknown";

export const FAILURE_CLASSES: readonly FailureClass[] = Object.freeze([
  "transient",
  "permanent",
  "security",
  "unknown",
]);

abstract class ClassifiedError extends Error {
  abstract readonly failureClass: FailureClass;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Infrastructure that may work later. Earns a bounded retry. */
export class TransientError extends ClassifiedError {
  readonly failureClass = "transient" as const;
}

/** Invalid input or an unrunnable job. Retrying cannot help. */
export class PermanentError extends ClassifiedError {
  readonly failureClass = "permanent" as const;
}

/**
 * A trust-boundary violation: a payload reaching for another tenant, a lease
 * that is not ours, a capability that was refused. Terminal by design — a
 * security refusal that retries is an attack running on a schedule.
 */
export class SecurityError extends ClassifiedError {
  readonly failureClass = "security" as const;
}

/** SQLSTATEs that mean "the trust boundary said no". */
const SECURITY_SQLSTATES = new Set([
  "42501", // insufficient_privilege — a grant or an RLS policy refused
  "28000", // invalid_authorization_specification
  "28P01", // invalid_password
]);

/** SQLSTATEs that mean "this input will never be valid". */
const PERMANENT_SQLSTATES = new Set([
  "22P02", // invalid_text_representation
  "22023", // invalid_parameter_value
  "23502", // not_null_violation
  "23503", // foreign_key_violation
  "23514", // check_violation
  "42883", // undefined_function
  "42P01", // undefined_table
  "42703", // undefined_column
]);

/** SQLSTATEs and socket errors that mean "try again later". */
const TRANSIENT_SQLSTATES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "53300", // too_many_connections
  "57014", // query_canceled — statement_timeout fired
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const TRANSIENT_SYSCALL_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
]);

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Classifies any thrown value.
 *
 * The default is `unknown`, never `transient`. That distinction is the whole
 * point: `unknown` still retries (an unanalysed failure is not a proven-hopeless
 * one, the same reasoning `classifyFailureStatus` applies to the Postmark
 * webhook), but it is RECORDED as unanalysed, so a class of failure nobody has
 * looked at is visible in the ledger instead of being filed as understood.
 */
export function classifyError(error: unknown): FailureClass {
  if (error instanceof TransientError) return "transient";
  if (error instanceof PermanentError) return "permanent";
  if (error instanceof SecurityError) return "security";

  const code = codeOf(error);
  if (code) {
    if (SECURITY_SQLSTATES.has(code)) return "security";
    if (PERMANENT_SQLSTATES.has(code)) return "permanent";
    if (TRANSIENT_SQLSTATES.has(code)) return "transient";
    if (TRANSIENT_SYSCALL_CODES.has(code)) return "transient";
  }

  return "unknown";
}

/** A short, loggable reason. Never the payload, never a stack. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = codeOf(error);
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
