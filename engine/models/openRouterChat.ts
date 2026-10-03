// The OpenRouter chat-completions adapter (ADR 0022 §B): the primary model
// gateway. The only file that knows OpenRouter's chat wire format, and, with
// the Jev Decisions client, the only code that holds the OpenRouter key.
//
// ONE EXACT MODEL, NO FALLBACK. The request names exactly the model the
// database authorized for this run and forbids every way OpenRouter could serve
// something else: `provider.allow_fallbacks: false`, no `models` list, no
// `route`, no plugins (so no hosted router), no tools. `require_parameters`
// keeps the strict JSON schema from being silently dropped by an endpoint that
// does not support it, and `data_collection: "deny"` keeps prompts away from
// endpoints that log or train on them. A unit test pins the exact key set.
//
// A SUBSTITUTED MODEL IS NEVER A RESULT. The served model must be the requested
// id or one of the dated builds the registry accepts for it; anything else is
// recorded `invalid_response / model_substituted` with its usage, because the
// call was made and billed.
//
// THE KEY lives in this closure and one request header, never in an error or a
// stored string (a provider string that echoes it is dropped). Error MESSAGES
// are never read. The response is untrusted network content read under a byte
// cap. Redirects are refused.

import {
  ModelError,
  MODEL_ERROR_CODE_PATTERN,
  type ModelErrorCategory,
  type ModelErrorDetails,
} from "./errors.ts";
import {
  asObject,
  assertApiKeyShape,
  assertMaxResponseBytes,
  cancelled,
  DEFAULT_MAX_RESPONSE_BYTES,
  parseJson,
  readCappedBody,
  untilAborted,
  type BodyRead,
} from "./httpTransport.ts";
import {
  isModelId,
  isProviderIdentifier,
  isTokenCount,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
} from "./types.ts";

export const OPENROUTER_CHAT_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_PROVIDER_NAME = "openrouter";

/**
 * The routing constraints sent with every request. Frozen: a caller cannot
 * widen them, and a test pins them.
 */
export const OPENROUTER_PROVIDER_CONSTRAINTS = Object.freeze({
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny",
});

/**
 * HTTP status -> category, read with ADR 0016 §2's question: does the answer
 * PROVE the model never ran? OpenRouter documents 402 as missing credits, 403 as
 * flagged by moderation before routing, and 404 as no endpoint satisfying the
 * request's constraints: all refusals before execution, recorded `failed`. Every
 * other non-2xx status leaves open whether the model ran.
 */
const STATUS_CATEGORIES: ReadonlyMap<
  number,
  { readonly category: ModelErrorCategory; readonly code?: string }
> = new Map([
  [400, { category: "invalid_request" }],
  [401, { category: "authentication" }],
  [402, { category: "configuration", code: "insufficient_credits" }],
  [403, { category: "invalid_request", code: "moderation_flagged" }],
  [404, { category: "configuration", code: "model_route_unavailable" }],
  [408, { category: "timeout" }],
  [409, { category: "unknown" }],
  [413, { category: "invalid_request" }],
  [422, { category: "invalid_request" }],
  [429, { category: "rate_limit" }],
  [502, { category: "transport" }],
  [504, { category: "timeout" }],
]);

export function openRouterStatus(status: number): {
  readonly category: ModelErrorCategory;
  readonly code: string;
} {
  const listed = STATUS_CATEGORIES.get(status);
  if (listed)
    return { category: listed.category, code: listed.code ?? `http_${status}` };
  if (status >= 500)
    return { category: "provider_5xx", code: `http_${status}` };
  return { category: "unknown", code: `http_${status}` };
}

/** An upstream provider name as OpenRouter reports it ("OpenAI", "Google AI Studio"). */
export const PROVIDER_ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;

/**
 * OpenRouter's documented opt-in for routing metadata on a chat completion:
 * the response then carries `openrouter_metadata.endpoints.available[]`, and
 * the endpoint marked `selected` is the one that served the call. Audit only:
 * it changes no routing, and the request still names one exact model with
 * fallbacks off.
 */
export const OPENROUTER_METADATA_HEADER = "x-openrouter-metadata";

const FINISH_REASON_FAILURES: ReadonlyMap<string, string> = new Map([
  ["length", "incomplete_max_output_tokens"],
  ["content_filter", "content_filter"],
  ["tool_calls", "unexpected_tool_call"],
  ["function_call", "unexpected_tool_call"],
  ["error", "provider_error"],
]);

const normalizeUsage = (raw: unknown): ModelUsage | null => {
  const usage = asObject(raw);
  if (!usage) return null;
  const count = (value: unknown) => (isTokenCount(value) ? value : null);
  return Object.freeze({
    inputTokens: count(usage.prompt_tokens),
    outputTokens: count(usage.completion_tokens),
    totalTokens: count(usage.total_tokens),
    cachedInputTokens: count(
      asObject(usage.prompt_tokens_details)?.cached_tokens,
    ),
    reasoningTokens: count(
      asObject(usage.completion_tokens_details)?.reasoning_tokens,
    ),
  });
};

/** OpenRouter's reported USD cost, as whole micro-dollars rounded up; null when absent or not a sane number. */
export function reportedCostMicros(raw: unknown): number | null {
  const cost = asObject(raw)?.cost;
  if (
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost > 1000
  ) {
    return null;
  }
  return Math.ceil(cost * 1_000_000 - 1e-9);
}

export function createOpenRouterChatProvider(options: {
  readonly apiKey: string;
  /** Injected by tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Default 2_000_000. */
  readonly maxResponseBytes?: number;
}): ModelProvider {
  // Fixed messages: the value that failed validation is the key.
  const apiKey = assertApiKeyShape(options.apiKey, "OpenRouter");
  const maxResponseBytes = assertMaxResponseBytes(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());

  const withoutKey = (value: string | null): string | null =>
    value !== null && value.includes(apiKey) ? null : value;
  const identifier = (value: unknown): string | null =>
    isProviderIdentifier(value) ? withoutKey(value) : null;
  const providerRoute = (value: unknown): string | null =>
    typeof value === "string" && PROVIDER_ROUTE_PATTERN.test(value)
      ? withoutKey(value)
      : null;
  // The provider of the ONE endpoint the metadata marks selected; none, or
  // more than one, is no answer. Only that name is kept, never the list.
  const selectedEndpointProvider = (metadata: unknown): string | null => {
    const available = asObject(asObject(metadata)?.endpoints)?.available;
    if (!Array.isArray(available)) return null;
    const selected = available
      .map((entry) => asObject(entry))
      .filter((entry) => entry !== null && entry.selected === true);
    return selected.length === 1 ? providerRoute(selected[0]?.provider) : null;
  };

  const execute = async (
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> => {
    if (signal.aborted) throw cancelled();

    const startedAt = now();
    const elapsed = () => Math.max(0, Math.round(now() - startedAt));

    const body = JSON.stringify({
      model: request.model,
      messages: [
        { role: "system", content: request.instructions },
        { role: "user", content: request.input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: request.output.name,
          strict: true,
          schema: request.output.schema,
        },
      },
      max_tokens: request.maxOutputTokens,
      provider: OPENROUTER_PROVIDER_CONSTRAINTS,
      usage: { include: true },
      stream: false,
    });

    let response: Response;
    try {
      response = await untilAborted(
        fetchImpl(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            [OPENROUTER_METADATA_HEADER]: "enabled",
          },
          body,
          signal,
          redirect: "error",
        }),
        signal,
      );
    } catch {
      if (signal.aborted) throw cancelled();
      throw new ModelError("transport", {
        code: "network",
        latencyMs: elapsed(),
      });
    }

    const providerRequestId = identifier(response.headers.get("x-request-id"));

    const readBody = async (): Promise<BodyRead> => {
      try {
        return await readCappedBody(response, maxResponseBytes, signal);
      } catch {
        if (signal.aborted) throw cancelled();
        throw new ModelError("transport", {
          code: "network",
          providerRequestId,
          latencyMs: elapsed(),
        });
      }
    };

    if (!response.ok) {
      const { category, code } = openRouterStatus(response.status);
      // The status decides the category. The body is drained (and an abort
      // still honoured) but never refines a documented code: OpenRouter's
      // `error.code` is the HTTP status again, and `error.message` is never read.
      await readBody().catch((error: unknown) => {
        if (error instanceof ModelError && error.category === "cancelled") {
          throw error;
        }
        return null;
      });
      throw new ModelError(category, {
        code: MODEL_ERROR_CODE_PATTERN.test(code)
          ? code
          : `http_${response.status}`,
        providerRequestId,
        latencyMs: elapsed(),
      });
    }

    const read = await readBody();
    if (read.kind === "too_large") {
      throw new ModelError("unknown", {
        code: "response_too_large",
        providerRequestId,
        latencyMs: elapsed(),
      });
    }
    const parsed = parseJson(read.text);
    if (!parsed.ok) {
      throw new ModelError("unknown", {
        code: "json_parse",
        providerRequestId,
        latencyMs: elapsed(),
      });
    }

    const root = asObject(parsed.value);
    const usage = normalizeUsage(root?.usage);
    const providerResponseId = identifier(root?.id);
    const servedModel =
      isModelId(root?.model) && withoutKey(root.model) !== null
        ? root.model
        : null;
    // ADR 0022 §H: the upstream provider from the documented metadata. The
    // top-level `provider` is observed but undocumented, so it is read only
    // when the metadata is missing altogether, never over it.
    const metadata = root?.openrouter_metadata;
    const route =
      metadata !== undefined && metadata !== null
        ? selectedEndpointProvider(metadata)
        : providerRoute(root?.provider);
    const costMicros = reportedCostMicros(root?.usage);
    const latencyMs = elapsed();

    const unusable = (category: ModelErrorCategory, code: string) =>
      new ModelError(category, {
        code,
        usage,
        providerRequestId,
        providerResponseId,
        model: servedModel ?? request.model,
        latencyMs,
        // Billed even when unusable: the audit report travels with the error.
        providerRoute: route,
        reportedCostMicros: costMicros,
      } satisfies ModelErrorDetails);

    const choices = Array.isArray(root?.choices) ? root.choices : null;
    const choice =
      choices && choices.length === 1 ? asObject(choices[0]) : null;
    if (root?.error !== undefined && root?.error !== null) {
      // A 200 that reports an error: the provider answered, definitively.
      throw unusable("invalid_response", "provider_error");
    }
    if (!choice) {
      // No single terminal choice: nothing says the model's run ended.
      throw unusable("unknown", "unexpected_choices");
    }

    // The served model is checked before the content is read: a substituted
    // model's answer is never a result, whatever it says.
    const accepted = new Set([
      request.model,
      ...(request.acceptedResponseModels ?? []),
    ]);
    if (servedModel === null || !accepted.has(servedModel)) {
      throw unusable("invalid_response", "model_substituted");
    }

    const finish = choice.finish_reason;
    if (typeof finish !== "string") {
      throw unusable("unknown", "unexpected_status");
    }
    const finishFailure = FINISH_REASON_FAILURES.get(finish);
    if (finishFailure) throw unusable("invalid_response", finishFailure);
    if (finish !== "stop") throw unusable("unknown", "unexpected_status");

    const message = asObject(choice.message);
    if (!message) throw unusable("invalid_response", "malformed_output");
    if (message.refusal !== undefined && message.refusal !== null) {
      throw unusable("invalid_response", "refusal");
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      throw unusable("invalid_response", "unexpected_tool_call");
    }
    if (typeof message.content !== "string") {
      throw unusable("invalid_response", "malformed_output");
    }
    if (message.content === "")
      throw unusable("invalid_response", "empty_output");

    const content = parseJson(message.content);
    if (!content.ok) throw unusable("invalid_response", "output_not_json");
    if (asObject(content.value) === null) {
      throw unusable("invalid_response", "output_not_object");
    }

    return Object.freeze({
      provider: OPENROUTER_PROVIDER_NAME,
      model: servedModel,
      content: content.value,
      finishReason: "completed",
      usage,
      providerRequestId,
      providerResponseId,
      latencyMs,
      providerRoute: route,
      reportedCostMicros: costMicros,
    });
  };

  return Object.freeze({
    name: OPENROUTER_PROVIDER_NAME,
    execute: (request: ModelRequest, signal: AbortSignal) =>
      execute(request, signal).catch((error: unknown) => {
        if (error instanceof ModelError) throw error;
        throw signal.aborted ? cancelled() : new ModelError("unknown");
      }),
  });
}
