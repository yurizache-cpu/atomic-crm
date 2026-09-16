// The OpenAI Responses API adapter. The only file that knows OpenAI's wire
// format, and the only code that ever holds the API key.
//
// THE REQUEST IS A CLOSED SHAPE. It carries a model, instructions, one user
// input and a strict JSON schema, and nothing else: no tools, no tool_choice,
// no reasoning or include options, no metadata, no user, no background, no
// stream, no previous_response_id, and `store: false`. Every one of those is
// either a capability (tools act in the world), a place tenant data could be
// retained by the provider, or a way to chain state across calls that this
// layer cannot see. A unit test pins the exact key set, so adding one is a
// reviewed change.
//
// THE KEY. It lives in this closure and in one request header. It is never a
// property of the provider object, never in an error, and never compared
// against anything but the provider-supplied strings about to be stored: a
// provider (or anything between us and it) that echoes the key into an id or a
// code gets that value dropped. Provider error MESSAGES are never read at all.
//
// THE RESPONSE IS UNTRUSTED NETWORK CONTENT. It is read under a byte cap,
// parsed leniently, and reduced to a fixed set of shape-checked fields.
// Reasoning items are skipped without reading any of their fields. Any output
// item other than a message or a reasoning item is refused: this request
// declares no tools, so a tool call in the answer means the call was not the
// one we made.
//
// Redirects are refused rather than followed. The URL is fixed; a redirect is
// not something this call should ever see, and following one would re-send the
// authorization header to wherever it points.

import {
  ModelError,
  MODEL_ERROR_CODE_PATTERN,
  type ModelErrorCategory,
  type ModelErrorDetails,
} from "./errors.ts";
import {
  isModelId,
  isProviderIdentifier,
  isTokenCount,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
} from "./types.ts";

export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
export const OPENAI_PROVIDER_NAME = "openai";
export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

type JsonObject = Readonly<Record<string, unknown>>;

const asObject = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const cancelled = () => new ModelError("cancelled", { code: "aborted" });

/**
 * HTTP status -> category. Statuses not listed fall through by class: other
 * 5xx are the provider's failure, other 4xx are a request it refused. 408 and
 * 504 are timeouts and 502 a transport failure, because in each the request may
 * have been processed without an answer reaching us. 409 is a conflict this
 * request cannot cause and nobody has analysed, so it is `unknown`.
 */
const STATUS_CATEGORIES: ReadonlyMap<number, ModelErrorCategory> = new Map([
  [401, "authentication"],
  [403, "authentication"],
  [404, "configuration"],
  [408, "timeout"],
  [409, "unknown"],
  [429, "rate_limit"],
  [502, "transport"],
  [504, "timeout"],
]);

export function categoryForHttpStatus(status: number): ModelErrorCategory {
  const listed = STATUS_CATEGORIES.get(status);
  if (listed) return listed;
  if (status >= 500) return "provider_5xx";
  if (status >= 400) return "invalid_request";
  // A non-ok status below 400 (a 3xx that reached us, say) is not an answer
  // and not a refusal; nobody can say whether the request was processed.
  return "unknown";
}

/** `incomplete_details.reason`, before it is folded into a code. */
const INCOMPLETE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Rejects when `signal` aborts, whether or not `promise` ever settles. A fetch
 * implementation or a body stream that ignores the signal must not hold the
 * caller; its late settlement is observed and discarded.
 */
const untilAborted = <T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {});
      reject(cancelled());
      return;
    }
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

type BodyRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too_large" };

/**
 * Reads the body as UTF-8 under a byte cap. A declared Content-Length over the
 * cap is refused before reading; an undeclared or understated one is refused
 * the moment the running total crosses it. Rejects with `cancelled` on abort
 * and with the stream's own error on a read failure.
 */
const readCappedBody = async (
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BodyRead> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => {});
    return { kind: "too_large" };
  }
  if (!response.body) return { kind: "text", text: "" };

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        reader.cancel().catch(() => {});
        return { kind: "too_large" };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  return { kind: "text", text: text + decoder.decode() };
};

const parseJson = (
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

const normalizeUsage = (raw: unknown): ModelUsage | null => {
  const usage = asObject(raw);
  if (!usage) return null;
  const count = (value: unknown) => (isTokenCount(value) ? value : null);
  return Object.freeze({
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    totalTokens: count(usage.total_tokens),
    cachedInputTokens: count(
      asObject(usage.input_tokens_details)?.cached_tokens,
    ),
    reasoningTokens: count(
      asObject(usage.output_tokens_details)?.reasoning_tokens,
    ),
  });
};

type OutputText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "refused"; readonly code: string };

/**
 * Concatenates every `output_text` part of every message item, in order.
 * A reasoning item is skipped by its `type` alone: its `summary`,
 * `encrypted_content` and `content` are never touched.
 */
const extractOutputText = (output: unknown): OutputText => {
  if (!Array.isArray(output)) return { kind: "text", text: "" };
  let text = "";
  for (const item of output) {
    const entry = asObject(item);
    if (entry?.type === "reasoning") continue;
    if (entry?.type !== "message") {
      return { kind: "refused", code: "unexpected_output_item" };
    }
    const parts: readonly unknown[] = Array.isArray(entry.content)
      ? entry.content
      : [];
    for (const rawPart of parts) {
      const part = asObject(rawPart);
      if (part?.type === "refusal") return { kind: "refused", code: "refusal" };
      if (part?.type !== "output_text") continue;
      if (typeof part.text !== "string") {
        return { kind: "refused", code: "malformed_output" };
      }
      text += part.text;
    }
  }
  return { kind: "text", text };
};

export function createOpenAiResponsesProvider(options: {
  readonly apiKey: string;
  /** Injected by tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Default 2_000_000. */
  readonly maxResponseBytes?: number;
}): ModelProvider {
  const apiKey = options.apiKey;
  // Fixed messages: the value that failed validation is the key.
  if (typeof apiKey !== "string" || apiKey === "" || /\s/.test(apiKey)) {
    throw new Error(
      "the OpenAI API key must be a non-empty string without whitespace",
    );
  }
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive integer");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => performance.now());

  /** A provider-supplied string that is about to be stored, unless it carries the key. */
  const withoutKey = (value: string | null): string | null =>
    value !== null && value.includes(apiKey) ? null : value;
  const identifier = (value: unknown): string | null =>
    isProviderIdentifier(value) ? withoutKey(value) : null;
  const errorCode = (value: unknown): string | null =>
    typeof value === "string" && MODEL_ERROR_CODE_PATTERN.test(value)
      ? withoutKey(value)
      : null;

  const execute = async (
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResponse> => {
    if (signal.aborted) throw cancelled();

    const startedAt = now();
    const elapsed = () => Math.max(0, Math.round(now() - startedAt));

    const body = JSON.stringify({
      model: request.model,
      instructions: request.instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: request.input }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: request.output.name,
          schema: request.output.schema,
          strict: true,
        },
      },
      max_output_tokens: request.maxOutputTokens,
      store: false,
    });

    let response: Response;
    try {
      response = await untilAborted(
        fetchImpl(OPENAI_RESPONSES_URL, {
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
      // The fetch error's text is discarded unread: undici's messages can quote
      // the request, and nothing about a network failure needs more than its
      // class.
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
      const category = categoryForHttpStatus(response.status);
      let code = `http_${response.status}`;
      // The status already classifies the failure; the body can only refine the
      // code. An oversized or unparseable error body costs the refinement, not
      // the classification. `error.message` is never read.
      const read = await readBody().catch((error: unknown) => {
        if (error instanceof ModelError && error.category === "cancelled") {
          throw error;
        }
        return null;
      });
      if (read?.kind === "text") {
        const parsed = parseJson(read.text);
        const reported = parsed.ok
          ? errorCode(asObject(asObject(parsed.value)?.error)?.code)
          : null;
        if (reported !== null) code = reported;
      }
      throw new ModelError(category, {
        code,
        providerRequestId,
        latencyMs: elapsed(),
      });
    }

    const read = await readBody();
    if (read.kind === "too_large") {
      throw new ModelError("invalid_response", {
        code: "response_too_large",
        providerRequestId,
        latencyMs: elapsed(),
      });
    }
    const parsed = parseJson(read.text);
    if (!parsed.ok) {
      throw new ModelError("invalid_response", {
        code: "json_parse",
        providerRequestId,
        latencyMs: elapsed(),
      });
    }

    const root = asObject(parsed.value);
    const usage = normalizeUsage(root?.usage);
    const providerResponseId = identifier(root?.id);
    const model =
      isModelId(root?.model) && withoutKey(root.model) !== null
        ? root.model
        : request.model;
    const latencyMs = elapsed();

    // Past a 200 the call was made and, likely, billed: every error from here
    // on carries what cost accounting needs.
    const unusable = (category: ModelErrorCategory, code: string) =>
      new ModelError(category, {
        code,
        usage,
        providerRequestId,
        providerResponseId,
        model,
        latencyMs,
      } satisfies ModelErrorDetails);

    switch (root?.status) {
      case "completed":
        break;
      case "incomplete": {
        const reason = asObject(root.incomplete_details)?.reason;
        throw unusable(
          "invalid_response",
          typeof reason === "string" &&
            INCOMPLETE_REASON_PATTERN.test(reason) &&
            withoutKey(reason) !== null
            ? `incomplete_${reason}`
            : "incomplete",
        );
      }
      case "failed": {
        const failure = asObject(root.error)?.code;
        if (failure === "server_error") {
          throw unusable("provider_5xx", "server_error");
        }
        if (failure === "rate_limit_exceeded") {
          throw unusable("rate_limit", "rate_limit_exceeded");
        }
        throw unusable("invalid_response", "response_failed");
      }
      default:
        throw unusable("invalid_response", "unexpected_status");
    }

    const output = extractOutputText(root.output);
    if (output.kind === "refused") {
      throw unusable("invalid_response", output.code);
    }
    if (output.text === "") throw unusable("invalid_response", "empty_output");

    const content = parseJson(output.text);
    if (!content.ok) throw unusable("invalid_response", "output_not_json");
    if (asObject(content.value) === null) {
      throw unusable("invalid_response", "output_not_object");
    }

    return Object.freeze({
      provider: OPENAI_PROVIDER_NAME,
      model,
      content: content.value,
      finishReason: "completed",
      usage,
      providerRequestId,
      providerResponseId,
      latencyMs,
    });
  };

  return Object.freeze({
    name: OPENAI_PROVIDER_NAME,
    execute: (request: ModelRequest, signal: AbortSignal) =>
      execute(request, signal).catch((error: unknown) => {
        // The contract: ModelError only. Anything that escaped the mapping
        // above is a defect in this file, reported without its text.
        if (error instanceof ModelError) throw error;
        throw signal.aborted ? cancelled() : new ModelError("unknown");
      }),
  });
}
