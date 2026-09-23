// The refusal vocabulary of the operator API (docs/PHASE_2C_BRIEF.md §7.3).
//
// Every identity gate raises one fixed, data-free message per SQLSTATE, and
// PostgREST delivers each of them as HTTP 400 (S0 measurement): a client
// switches on the code, never on the HTTP status and never on the text. So the
// typed error keeps the code and the operation, and its message is this
// contract's own, never the server's.

export const OS_ERROR_CODES = [
  "OS400",
  "OS401",
  "OS403",
  "OS404",
  "OS409",
  "OS429",
  "OS500",
] as const;

export type OsErrorCode = (typeof OS_ERROR_CODES)[number];

export const isOsErrorCode = (value: unknown): value is OsErrorCode =>
  typeof value === "string" &&
  (OS_ERROR_CODES as readonly string[]).includes(value);

/** What each code means to a client. OS429 is the one retryable refusal. */
export const OS_ERROR_MEANINGS: Readonly<Record<OsErrorCode, string>> =
  Object.freeze({
    OS400: "bad request",
    OS401: "not signed in",
    OS403: "no access",
    OS404: "not found",
    OS409: "conflict",
    OS429: "could not be completed yet; retry",
    OS500: "internal error",
  });

/** A refusal from a company_os_api function, by code. */
export class CompanyOsApiError extends Error {
  readonly operation: string;
  readonly code: OsErrorCode;

  constructor(operation: string, code: OsErrorCode) {
    super(`company_os_api.${operation}: ${OS_ERROR_MEANINGS[code]}`);
    this.name = "CompanyOsApiError";
    this.operation = operation;
    this.code = code;
  }
}

/**
 * The refusals PostgREST answers itself, before any gate runs, that a screen
 * must still render as a refusal (brief §6.2, §16, §18), each measured on the
 * local stack (2026-09-23) unless noted:
 *
 * - 42501: a caller outside `authenticated`, which is what a signed-out browser
 *   is (anon, 401), and the same code a wrapper holding no privilege fails
 *   with: no access;
 * - PGRST106: `company_os_api` no longer exposed, the instant rollback (406):
 *   no access;
 * - PGRST301: a token PostgREST cannot decode or verify (401); PGRST302 and
 *   PGRST303, not measured, are PostgREST's documented codes for no token where
 *   one is required and for claims it refuses, an expired session's included:
 *   not signed in.
 */
const POSTGREST_REFUSALS: ReadonlyMap<string, OsErrorCode> = new Map([
  ["42501", "OS403"],
  ["PGRST106", "OS403"],
  ["PGRST301", "OS401"],
  ["PGRST302", "OS401"],
  ["PGRST303", "OS401"],
]);

/**
 * The typed error for whatever a call failed with: a gate's own code, or one of
 * PostgREST's refusals above by the code it maps to. Any other code (a
 * malformed uuid's 22P02, an unknown signature's PGRST202, a statement cancel,
 * a lost connection) is OS500 to a client. Nothing of the original is kept.
 */
export const toCompanyOsApiError = (
  operation: string,
  failure: unknown,
): CompanyOsApiError => {
  const code =
    typeof failure === "object" && failure !== null && "code" in failure
      ? (failure as { code: unknown }).code
      : undefined;
  if (isOsErrorCode(code)) return new CompanyOsApiError(operation, code);
  const refusal =
    typeof code === "string" ? POSTGREST_REFUSALS.get(code) : undefined;
  return new CompanyOsApiError(operation, refusal ?? "OS500");
};

/**
 * Where a response broke its contract: a path and a zod issue code, never a
 * value. A path holds only array positions and the keys the contract declares;
 * a record's key is data, so it reads as UNDECLARED_KEY_SEGMENT (operations.ts).
 */
export interface ContractIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
}

/**
 * A response that does not match its contract. It renders as an error instead
 * of the value (brief §6.2): a tripwire, not a boundary. It keeps where the
 * response broke and never what it held.
 */
export class CompanyOsContractError extends Error {
  readonly operation: string;
  readonly issues: readonly ContractIssue[];

  constructor(operation: string, issues: readonly ContractIssue[]) {
    super(`company_os_api.${operation}: the response broke its contract`);
    this.name = "CompanyOsContractError";
    this.operation = operation;
    this.issues = issues;
  }
}

/**
 * Arguments the client refused to send: a key the function does not take, or
 * a value outside its argument's contract (a malformed id, an unknown status).
 * No request left, so nothing about the server is known. A separate class from
 * CompanyOsContractError, never a subclass: a screen must not read a request
 * the browser refused as a server answer that broke its contract. Like that
 * error, it keeps where the input broke and never what it held.
 */
export class CompanyOsInputError extends Error {
  readonly operation: string;
  readonly issues: readonly ContractIssue[];

  constructor(operation: string, issues: readonly ContractIssue[]) {
    super(`company_os_api.${operation}: the request broke its input contract`);
    this.name = "CompanyOsInputError";
    this.operation = operation;
    this.issues = issues;
  }
}
