// A scripted model provider, for tests only.
//
// It is never reachable from configuration: routingConfig.ts refuses
// AGENT_MODEL_PROVIDER=fake, so a deployment cannot be pointed at canned
// answers by an environment variable.
//
// It honours the same contract as a real adapter (engine/models/
// providerContract.test.ts runs both through one suite): it rejects with
// ModelError only, and rejects promptly on abort — except under `ignore_abort`,
// which exists precisely to prove that the ROUTER does not rely on a provider
// being well behaved.
//
// It does not validate what it returns. A `respond` whose content is not a
// plain object is how malformed model output is simulated; catching that is the
// output contract's job, and a fake that caught it first would hide a router
// that does not.

import { ModelError, toModelError, type ModelErrorCategory } from "./errors.ts";
import {
  isProviderName,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
} from "./types.ts";

export type FakeBehavior =
  | {
      readonly type: "respond";
      readonly content: unknown;
      readonly usage?: ModelUsage | null;
      readonly model?: string;
    }
  | {
      readonly type: "fail";
      readonly category: ModelErrorCategory;
      readonly code?: string;
      readonly usage?: ModelUsage | null;
    }
  /** Never settles until the signal aborts -> cancelled. */
  | { readonly type: "hang" }
  /** Never settles, even on abort (to prove the router does not wait). */
  | { readonly type: "ignore_abort" }
  | {
      readonly type: "delay";
      readonly ms: number;
      readonly then: FakeBehavior;
    };

export interface FakeModelProvider extends ModelProvider {
  /** Every request received, in order. */
  readonly calls: readonly ModelRequest[];
  /** Resolves when the Nth call (1-based) has STARTED. Lets crash tests act while a call is in flight. */
  callStarted(n?: number): Promise<void>;
}

export const FAKE_DEFAULT_USAGE: ModelUsage = Object.freeze({
  inputTokens: 120,
  outputTokens: 60,
  totalTokens: 180,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});

const cancelled = () => new ModelError("cancelled", { code: "aborted" });

const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    signal.addEventListener("abort", () => reject(cancelled()), { once: true });
  });

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function createFakeModelProvider(
  script:
    | FakeBehavior
    | ((request: ModelRequest, index: number) => FakeBehavior),
  options: { readonly name?: string; readonly now?: () => number } = {},
): FakeModelProvider {
  const name = options.name ?? "fake";
  if (!isProviderName(name)) {
    throw new Error("fake model provider name is malformed");
  }
  const now = options.now ?? (() => performance.now());
  const received: ModelRequest[] = [];
  let waiters: readonly { readonly n: number; readonly resolve: () => void }[] =
    [];

  const perform = async (
    behavior: FakeBehavior,
    request: ModelRequest,
    signal: AbortSignal,
    callNumber: number,
    startedAt: number,
  ): Promise<ModelResponse> => {
    switch (behavior.type) {
      case "respond":
        if (signal.aborted) throw cancelled();
        return Object.freeze({
          provider: name,
          model: behavior.model ?? request.model,
          content: behavior.content,
          finishReason: "completed",
          usage:
            behavior.usage === undefined ? FAKE_DEFAULT_USAGE : behavior.usage,
          providerRequestId: `fake-req-${callNumber}`,
          providerResponseId: `fake-resp-${callNumber}`,
          latencyMs: Math.max(0, Math.round(now() - startedAt)),
        });
      case "fail":
        throw new ModelError(behavior.category, {
          code: behavior.code,
          usage: behavior.usage,
        });
      case "hang":
        return untilAborted(signal);
      case "ignore_abort":
        return new Promise<never>(() => {});
      case "delay":
        await sleep(behavior.ms, signal);
        return perform(behavior.then, request, signal, callNumber, startedAt);
    }
  };

  return Object.freeze({
    name,
    get calls(): readonly ModelRequest[] {
      return Object.freeze([...received]);
    },
    callStarted(n = 1): Promise<void> {
      if (received.length >= n) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters = [...waiters, { n, resolve }];
      });
    },
    execute(
      request: ModelRequest,
      signal: AbortSignal,
    ): Promise<ModelResponse> {
      received.push(request);
      const callNumber = received.length;
      const ready = waiters.filter((waiter) => waiter.n <= callNumber);
      waiters = waiters.filter((waiter) => waiter.n > callNumber);
      for (const waiter of ready) waiter.resolve();

      const startedAt = now();
      try {
        const behavior =
          typeof script === "function"
            ? script(request, callNumber - 1)
            : script;
        return perform(behavior, request, signal, callNumber, startedAt).catch(
          (error: unknown) => {
            throw toModelError(error);
          },
        );
      } catch (error) {
        return Promise.reject(toModelError(error));
      }
    },
  });
}
