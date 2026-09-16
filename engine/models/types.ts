// The provider-neutral model boundary.
//
// Everything above this file (agent runs, tasks, the worker, events,
// idempotency) talks to a model through these types and nothing else. A
// provider adapter is the only code that knows a vendor's wire format, and the
// only code that ever holds a credential. Swapping or adding a provider must
// never touch anything that imports from here.
//
// WHAT IS DELIBERATELY ABSENT: a model id on a route. Callers ask for a TIER
// (`economy | standard | reasoning`); which model serves a tier is deployment
// configuration (routingConfig.ts). A model id in engine code is a vendor
// decision frozen into a release.
//
// The shape helpers at the bottom exist because every value in a ModelResponse
// or a ModelError came from a provider, which is to say from the network. They
// are the one place that decides what a provider-supplied identifier may look
// like before it can reach a database column or a log line.

export type ModelRouteName = "economy" | "standard" | "reasoning";

export const MODEL_ROUTE_NAMES: readonly ModelRouteName[] = Object.freeze([
  "economy",
  "standard",
  "reasoning",
]);

export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface ModelRequest {
  readonly model: string;
  /** System-level instructions. Never contains secrets. */
  readonly instructions: string;
  /** The bounded task input, as text. Data, not instructions. */
  readonly input: string;
  /** Strict JSON schema the provider must constrain output to (root object). */
  readonly output: {
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
  readonly maxOutputTokens: number;
}

export interface ModelResponse {
  /** Provider name as registered ("openai", "fake"). */
  readonly provider: string;
  /** Model the provider reports it used; falls back to the requested model when absent. */
  readonly model: string;
  /** Parsed JSON value of the final output. NOT yet validated against the contract. */
  readonly content: unknown;
  /** Normalized, e.g. "completed". */
  readonly finishReason: string;
  readonly usage: ModelUsage | null;
  /** e.g. x-request-id; matches PROVIDER_IDENTIFIER_PATTERN or is null. */
  readonly providerRequestId: string | null;
  /** e.g. resp_…; matches PROVIDER_IDENTIFIER_PATTERN or is null. */
  readonly providerResponseId: string | null;
  readonly latencyMs: number;
}

export interface ModelProvider {
  /** Matches PROVIDER_NAME_PATTERN. */
  readonly name: string;
  /** Must reject with ModelError only. Must reject promptly (<= a few ms) after `signal` aborts. */
  execute(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
}

/** A registered provider name. Lowercase so "OpenAI" and "openai" cannot be two providers. */
export const PROVIDER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * A request or response id a provider hands back. Bounded and free of spaces,
 * quotes and control characters, so it is safe to store and to log; anything
 * else is dropped to null rather than cleaned, because a cleaned id is an id
 * nobody at the provider can look up.
 */
export const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** A model id, from configuration or reported back by a provider. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export const isProviderName = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_NAME_PATTERN.test(value);

export const isProviderIdentifier = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_IDENTIFIER_PATTERN.test(value);

export const isModelId = (value: unknown): value is string =>
  typeof value === "string" && MODEL_ID_PATTERN.test(value);

/**
 * The largest value a Postgres `integer` holds. Token counts and latencies are
 * stored in integer columns through integer parameters, and a larger or
 * fractional number is not nulled there: it is refused on input, which fails
 * the whole statement carrying an otherwise usable result.
 */
export const MAX_STORED_INTEGER = 2_147_483_647;

/** A token count: a non-negative integer that fits the column it is stored in. */
export const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_STORED_INTEGER;

/** A latency in whole milliseconds, or null when it is not a storable duration. */
export function normalizeLatencyMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded <= MAX_STORED_INTEGER ? rounded : null;
}

const countOrNull = (value: unknown): number | null =>
  isTokenCount(value) ? value : null;

/**
 * A frozen copy of `usage` with every count that is not a token count dropped
 * to null. Null for anything that is not an object. A NaN or a fractional
 * "token" would otherwise reach cost accounting, where arithmetic is supposed to
 * be the deterministic part.
 */
export function sanitizeUsage(usage: unknown): ModelUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const source = usage as Partial<Record<keyof ModelUsage, unknown>>;
  return Object.freeze({
    inputTokens: countOrNull(source.inputTokens),
    outputTokens: countOrNull(source.outputTokens),
    totalTokens: countOrNull(source.totalTokens),
    cachedInputTokens: countOrNull(source.cachedInputTokens),
    reasoningTokens: countOrNull(source.reasoningTokens),
  });
}
