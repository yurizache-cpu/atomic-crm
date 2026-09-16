// The model failure taxonomy.
//
// One typed error for every way a model call can end without a usable result,
// and a FIXED message for each. That second property is the security one: a
// provider's error text is untrusted network content. It can echo the prompt
// (which carries tenant data), echo a header, or quote a malformed key back, so
// no provider-supplied string is ever interpolated into a message, and the
// original error is never attached as `cause` — an SDK or fetch error can carry
// the request configuration, headers included.
//
// What a caller may keep is structured and shape-checked: a short code, token
// usage, provider ids, the model, the latency. Each is dropped to null when it
// does not have the expected shape, never cleaned up into something plausible.

import {
  isModelId,
  isProviderIdentifier,
  normalizeLatencyMs,
  sanitizeUsage,
  type ModelUsage,
} from "./types.ts";

export type ModelErrorCategory =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "provider_5xx"
  | "invalid_request"
  | "invalid_response"
  | "schema_validation"
  | "cancelled"
  | "unknown";

export const MODEL_ERROR_CATEGORIES: readonly ModelErrorCategory[] =
  Object.freeze([
    "configuration",
    "authentication",
    "rate_limit",
    "timeout",
    "transport",
    "provider_5xx",
    "invalid_request",
    "invalid_response",
    "schema_validation",
    "cancelled",
    "unknown",
  ]);

/**
 * What the DATABASE will record for a run that ended with this category.
 * Mirrors ops.agent_run_error_status(); a driver-backed test asserts equality.
 */
export type AgentRunFailureStatus = "failed" | "indeterminate";

/**
 * The split is "do we KNOW how the call ended?" (ADR 0016 §2, owner review
 * 2026-09-16). The evidence decides it:
 *
 * A. The provider was never called: no route, no key. `failed`.
 * B. The provider answered, and the answer settles the outcome: a refusal that
 *    proves the model never ran (our credentials, our quota, a malformed
 *    request, a missing model), or a complete response we read and could not
 *    use. `failed`: retrying the RUN is a decision someone can make with full
 *    information.
 * C. The model may have run, and nobody can say how it ended: a server or
 *    gateway error, a timeout, a lost connection or broken body, an abort in
 *    flight, an answer we could not read or that names no terminal status, or
 *    anything nobody classified. `indeterminate`: recording it as
 *    `failed` would invite a re-issue of a paid call that may already have
 *    happened. A 5xx is here, not in B: it proves nothing about whether the
 *    model ran before the failure became visible.
 *
 * `cancelled` also covers an abort before the request was sent, which is
 * provably A; it is kept on the conservative side because the runtime cannot
 * always tell the two apart.
 */
const STATUS_BY_CATEGORY: Readonly<
  Record<ModelErrorCategory, AgentRunFailureStatus>
> = Object.freeze({
  configuration: "failed",
  authentication: "failed",
  rate_limit: "failed",
  invalid_request: "failed",
  invalid_response: "failed",
  schema_validation: "failed",
  timeout: "indeterminate",
  transport: "indeterminate",
  provider_5xx: "indeterminate",
  cancelled: "indeterminate",
  unknown: "indeterminate",
});

const isCategory = (value: unknown): value is ModelErrorCategory =>
  typeof value === "string" && Object.hasOwn(STATUS_BY_CATEGORY, value);

export function agentRunStatusForCategory(
  category: ModelErrorCategory,
): AgentRunFailureStatus {
  // A category from outside the type (untyped JS, a future value) is the case
  // nobody analysed, so it gets the answer that never invites a re-issue.
  return isCategory(category) ? STATUS_BY_CATEGORY[category] : "indeterminate";
}

/** A short machine code. Lowercase, bounded, no spaces: safe to store and log. */
export const MODEL_ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,99}$/;

export interface ModelErrorDetails {
  /** Dropped to null unless it matches MODEL_ERROR_CODE_PATTERN. */
  readonly code?: string | null;
  readonly usage?: ModelUsage | null;
  readonly providerRequestId?: string | null;
  readonly providerResponseId?: string | null;
  readonly model?: string | null;
  readonly latencyMs?: number | null;
}

const FIXED_MESSAGES: Readonly<Record<ModelErrorCategory, string>> =
  Object.freeze({
    configuration: "model call is not configured",
    authentication: "model provider refused the credentials",
    rate_limit: "model provider rate limit or quota reached",
    timeout: "model call timed out",
    transport: "model provider could not be reached",
    provider_5xx: "model provider failed with a server error",
    invalid_request: "model provider rejected the request",
    invalid_response: "model provider returned an unusable response",
    schema_validation: "model output does not match the output contract",
    cancelled: "model call was cancelled",
    unknown: "model call failed for an unclassified reason",
  });

export class ModelError extends Error {
  readonly category: ModelErrorCategory;
  readonly code: string | null;
  readonly usage: ModelUsage | null;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly model: string | null;
  readonly latencyMs: number | null;

  constructor(category: ModelErrorCategory, details: ModelErrorDetails = {}) {
    const safeCategory = isCategory(category) ? category : "unknown";
    const code =
      typeof details.code === "string" &&
      MODEL_ERROR_CODE_PATTERN.test(details.code)
        ? details.code
        : null;
    // The message is the category's fixed text and nothing else. The code can be
    // one a provider reported, so it travels only as its own shape-checked field.
    super(FIXED_MESSAGES[safeCategory]);
    this.name = "ModelError";
    this.category = safeCategory;
    this.code = code;
    this.usage = sanitizeUsage(details.usage);
    this.providerRequestId = isProviderIdentifier(details.providerRequestId)
      ? details.providerRequestId
      : null;
    this.providerResponseId = isProviderIdentifier(details.providerResponseId)
      ? details.providerResponseId
      : null;
    this.model = isModelId(details.model) ? details.model : null;
    this.latencyMs = normalizeLatencyMs(details.latencyMs);
  }
}

/**
 * Any thrown value -> ModelError. A ModelError passes through as the same
 * instance; everything else is `unknown`, with no message, code or cause
 * carried across, because nothing about a foreign error's text is known to be
 * safe.
 */
export function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  return new ModelError("unknown");
}
