// Typed Company OS errors, mapped from the SQLSTATEs the domain functions raise.
//
// The domain uses its own SQLSTATE class (OSxxx) so that a refusal is never
// confused with a NATIVE privilege failure. That distinction is the point of
// this module: a native 42501 means the connection is the wrong role — a
// misconfiguration, possibly a new service_role path — and it is re-thrown
// untouched rather than dressed up as "not found" or "refused".

export type CompanyOsErrorCode =
  | "invalid_argument"
  | "missing_tenant_scope"
  | "refused"
  | "not_found"
  | "invalid_state"
  | "malformed_identifier"
  | "duplicate"
  | "constraint_violation";

const BY_SQLSTATE: ReadonlyMap<string, CompanyOsErrorCode> = new Map([
  ["OS400", "invalid_argument"],
  ["OS401", "missing_tenant_scope"],
  ["OS403", "refused"],
  ["OS404", "not_found"],
  ["OS409", "invalid_state"],
  ["22P02", "malformed_identifier"],
  ["23505", "duplicate"],
  ["23514", "constraint_violation"],
  // A composite foreign key refusing a row the functions should already have
  // refused. Reaching it means a check in front of it is missing.
  ["23503", "constraint_violation"],
]);

export class CompanyOsError extends Error {
  readonly code: CompanyOsErrorCode;
  readonly sqlstate: string | undefined;

  constructor(
    code: CompanyOsErrorCode,
    message: string,
    options: { sqlstate?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CompanyOsError";
    this.code = code;
    this.sqlstate = options.sqlstate;
  }
}

const sqlstateOf = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/**
 * A CompanyOsError for a domain SQLSTATE; anything else is returned unchanged.
 * Never throws, never guesses.
 */
export function toDomainError(error: unknown): unknown {
  if (error instanceof CompanyOsError) return error;
  const sqlstate = sqlstateOf(error);
  const code = sqlstate ? BY_SQLSTATE.get(sqlstate) : undefined;
  if (!code) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CompanyOsError(code, message, { sqlstate, cause: error });
}
