// The DecisionPort (Phase 2D.1): the provider-neutral boundary between the
// Company Engine and a decision provider.
//
// It EVALUATES a bounded, allowlisted input and answers with an advisory
// DecisionVector. It knows nothing of the browser, sessions, reviews, sends,
// the CRM, stops, budgets or channels, and it is handed nothing it could act
// through: the worker calls it with data only, outside any transaction, and the
// database stores what it answered after validating it again. Whatever it
// answers, the deterministic policy keeps the human review required.
//
// Providers: the deterministic fake (fakeDecisionProvider.ts) and the Jev
// boundary (jevDecisionProvider.ts), which has no approved API contract and
// never calls anything.

import type {
  DecisionInput,
  DecisionProviderIdentity,
} from "./decisionVector.ts";

export interface DecisionRequest {
  readonly input: DecisionInput;
  /** The database's fingerprint of `input`; the vector must echo it. */
  readonly inputFingerprint: string;
}

export interface DecisionPort {
  /** Recorded on the evaluation before the provider is called. */
  readonly identity: DecisionProviderIdentity | UnconfiguredIdentity;
  /**
   * The provider's raw answer, deliberately `unknown`: the caller validates it
   * against the strict vector schema, and the database validates it again.
   * Rejects with DecisionProviderUnavailableError when the provider was never
   * reached; any other rejection is an ambiguous outcome.
   */
  evaluate(
    request: DecisionRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

/** The identity of "no provider configured". */
export interface UnconfiguredIdentity {
  readonly kind: "none";
  readonly id: string;
  readonly version: string;
}

/**
 * The provider was NOT reached: nothing was asked, so the outcome is a clean
 * failure (never indeterminate). `code` is a stable reason code.
 */
export class DecisionProviderUnavailableError extends Error {
  // A declared field, not a parameter property: the worker runs under Node's
  // type stripping, which refuses parameter properties.
  readonly code: string;

  constructor(code: string) {
    super(`decision provider unavailable: ${code}`);
    this.name = "DecisionProviderUnavailableError";
    this.code = code;
  }
}

/** The port a worker has when no decision provider is configured. */
export const UNCONFIGURED_DECISION_PORT: DecisionPort = Object.freeze({
  identity: Object.freeze({
    kind: "none",
    id: "unconfigured",
    version: "0",
  }) as UnconfiguredIdentity,
  async evaluate(): Promise<unknown> {
    throw new DecisionProviderUnavailableError("provider_not_configured");
  },
});
