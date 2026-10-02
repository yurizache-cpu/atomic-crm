// HTTP plumbing shared by the model gateway adapters (OpenAI Responses,
// OpenRouter chat completions, the Jev Decisions API). Nothing here knows a
// vendor's wire format: it reads an untrusted response body under a byte cap,
// honours an abort signal even when the fetch implementation does not, and
// parses JSON without throwing.

import { ModelError } from "./errors.ts";

export const DEFAULT_MAX_RESPONSE_BYTES = 2_000_000;

export type JsonObject = Readonly<Record<string, unknown>>;

export const asObject = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

export const cancelled = () => new ModelError("cancelled", { code: "aborted" });

/**
 * Rejects when `signal` aborts, whether or not `promise` ever settles. A fetch
 * implementation or a body stream that ignores the signal must not hold the
 * caller; its late settlement is observed and discarded.
 */
export const untilAborted = <T>(
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

export type BodyRead =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "too_large" };

/**
 * Reads the body as UTF-8 under a byte cap. A declared Content-Length over the
 * cap is refused before reading; an undeclared or understated one is refused
 * the moment the running total crosses it. Rejects with `cancelled` on abort
 * and with the stream's own error on a read failure.
 */
export const readCappedBody = async (
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

export const parseJson = (
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

/** Shared validation of a gateway credential; the message never quotes it. */
export function assertApiKeyShape(apiKey: unknown, label: string): string {
  if (typeof apiKey !== "string" || apiKey === "" || /\s/.test(apiKey)) {
    throw new Error(
      `the ${label} API key must be a non-empty string without whitespace`,
    );
  }
  return apiKey;
}

export function assertMaxResponseBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxResponseBytes must be a positive integer");
  }
  return value;
}
