// The OpenRouter Decisions API adapter (ADR 0022 §E): how Jev is reached. The
// only file that knows the Decisions wire format.
//
// The endpoint is an ALPHA outside /api/v1 (POST /api/alpha/decisions). The
// request is a closed shape: an exact versioned decision model, the state and
// the questions. No `provider`, `trace`, `session_id` or `user`: nothing that
// routes elsewhere or attributes a person. A unit test pins the key set.
//
// The answers come back UNVALIDATED (`answers: unknown`); the caller holds them
// to the questions it asked (parseDecisionAnswers). The served build must be
// the requested id or one of its accepted dated builds, as for chat.
//
// Errors use the model taxonomy (errors.ts): a refusal the status proves
// happened before the model ran is `failed`; anything else is `indeterminate`.

import { ModelError, type ModelErrorDetails } from "./errors.ts";
import {
  asObject,
  assertApiKeyShape,
  assertMaxResponseBytes,
  cancelled,
  parseJson,
  readCappedBody,
  untilAborted,
  type BodyRead,
} from "./httpTransport.ts";
import {
  openRouterStatus,
  PROVIDER_ROUTE_PATTERN,
  reportedCostMicros,
} from "./openRouterChat.ts";
import { isModelId, isProviderIdentifier, isTokenCount } from "./types.ts";
import type {
  StructuredDecisionGateway,
  StructuredDecisionRequest,
  StructuredDecisionResponse,
} from "../decision/structured/types.ts";

export const OPENROUTER_DECISIONS_URL =
  "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_DECISIONS_GATEWAY = "openrouter";

/** Decisions answers are small; a megabyte is generous. */
const MAX_DECISION_RESPONSE_BYTES = 1_000_000;

export function createOpenRouterDecisionsGateway(options: {
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly maxResponseBytes?: number;
  /** Served builds accepted for each requested model id. */
  readonly acceptedBuilds?: Readonly<Record<string, readonly string[]>>;
}): StructuredDecisionGateway {
  const apiKey = assertApiKeyShape(options.apiKey, "OpenRouter");
  const maxResponseBytes = assertMaxResponseBytes(
    options.maxResponseBytes ?? MAX_DECISION_RESPONSE_BYTES,
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());
  const acceptedBuilds = options.acceptedBuilds ?? {};

  const withoutKey = (value: string | null): string | null =>
    value !== null && value.includes(apiKey) ? null : value;

  const decide = async (
    request: StructuredDecisionRequest,
    signal: AbortSignal,
  ): Promise<StructuredDecisionResponse> => {
    if (signal.aborted) throw cancelled();
    if (!isModelId(request.model) || request.model.startsWith("~")) {
      // An alias moves to a new build under the thresholds tuned on the old one.
      throw new ModelError("configuration", {
        code: "decision_model_not_pinned",
      });
    }
    const startedAt = now();
    const elapsed = () => Math.max(0, Math.round(now() - startedAt));

    const body = JSON.stringify({
      model: request.model,
      state: request.state,
      questions: request.questions,
    });

    let response: Response;
    try {
      response = await untilAborted(
        fetchImpl(OPENROUTER_DECISIONS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
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

    const readBody = async (): Promise<BodyRead> => {
      try {
        return await readCappedBody(response, maxResponseBytes, signal);
      } catch {
        if (signal.aborted) throw cancelled();
        throw new ModelError("transport", {
          code: "network",
          latencyMs: elapsed(),
        });
      }
    };

    if (!response.ok) {
      const { category, code } = openRouterStatus(response.status);
      await readBody().catch((error: unknown) => {
        if (error instanceof ModelError && error.category === "cancelled")
          throw error;
        return null;
      });
      throw new ModelError(category, { code, latencyMs: elapsed() });
    }

    const read = await readBody();
    if (read.kind === "too_large") {
      throw new ModelError("unknown", {
        code: "response_too_large",
        latencyMs: elapsed(),
      });
    }
    const parsed = parseJson(read.text);
    const root = parsed.ok ? asObject(parsed.value) : null;
    if (!root) {
      throw new ModelError("unknown", {
        code: "json_parse",
        latencyMs: elapsed(),
      });
    }

    const usage = asObject(root.usage);
    const inputTokens = isTokenCount(usage?.input_tokens)
      ? usage.input_tokens
      : null;
    const outputTokens = isTokenCount(usage?.output_tokens)
      ? usage.output_tokens
      : null;
    const served =
      isModelId(root.model) && withoutKey(root.model) !== null
        ? root.model
        : null;
    const latencyMs = elapsed();
    const details = {
      code: "",
      usage: Object.freeze({
        inputTokens,
        outputTokens,
        totalTokens: null,
        cachedInputTokens: null,
        reasoningTokens: null,
      }),
      model: served ?? request.model,
      latencyMs,
    } satisfies ModelErrorDetails;

    const accepted = new Set([
      request.model,
      ...(acceptedBuilds[request.model] ?? []),
    ]);
    if (served === null || !accepted.has(served)) {
      throw new ModelError("invalid_response", {
        ...details,
        code: "model_substituted",
      });
    }
    if (asObject(root.answers) === null) {
      throw new ModelError("invalid_response", {
        ...details,
        code: "answers_missing",
      });
    }

    return Object.freeze({
      gateway: OPENROUTER_DECISIONS_GATEWAY,
      model: served,
      providerRoute:
        typeof root.provider === "string" &&
        PROVIDER_ROUTE_PATTERN.test(root.provider)
          ? withoutKey(root.provider)
          : null,
      responseId: isProviderIdentifier(root.id) ? withoutKey(root.id) : null,
      answers: root.answers,
      inputTokens,
      outputTokens,
      reportedCostMicros: reportedCostMicros(root.usage),
      latencyMs,
    });
  };

  return Object.freeze({
    name: OPENROUTER_DECISIONS_GATEWAY,
    decide: (request: StructuredDecisionRequest, signal: AbortSignal) =>
      decide(request, signal).catch((error: unknown) => {
        if (error instanceof ModelError) throw error;
        throw signal.aborted ? cancelled() : new ModelError("unknown");
      }),
  });
}
