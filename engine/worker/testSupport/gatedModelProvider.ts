// A model provider whose calls wait at a gate the test opens, for the runtime
// governance suites: "a call is in flight" becomes a state the test holds for as
// long as it needs, and releases on an event it observed, never after a guessed
// delay.
//
// It counts calls when they START (before the gate), how many are in flight at
// once and the most that ever were. Behind the gate it delegates to the scripted
// fake provider, so every answer, usage figure and failure is the fake's. It
// honours the provider contract: a call waiting at the gate rejects promptly,
// as cancelled, when its signal aborts.

import { ModelError } from "../../models/errors.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
} from "../../models/fakeModelProvider.ts";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../../models/types.ts";

export interface GatedModelProvider extends ModelProvider {
  /** Every request received, in the order the calls started. */
  readonly requests: readonly ModelRequest[];
  /** Calls started so far, gated or not. */
  readonly started: number;
  /** Calls started and not yet settled. */
  readonly inFlight: number;
  /** The most calls that were ever in flight at once. */
  readonly maxInFlight: number;
  /** Resolves once `n` calls (1-based) have started. */
  callStarted(n: number): Promise<void>;
  /** Lets every waiting call, and every later one, through. */
  open(): void;
}

export function createGatedModelProvider(
  script:
    | FakeBehavior
    | ((request: ModelRequest, index: number) => FakeBehavior),
): GatedModelProvider {
  const fake = createFakeModelProvider(script);
  const received: ModelRequest[] = [];
  let started = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let opened = false;
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  let waiters: readonly { readonly n: number; readonly resolve: () => void }[] =
    [];

  const passGate = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const cancelled = () =>
        reject(new ModelError("cancelled", { code: "aborted" }));
      if (signal.aborted) {
        cancelled();
        return;
      }
      signal.addEventListener("abort", cancelled, { once: true });
      void gate.then(() => {
        signal.removeEventListener("abort", cancelled);
        resolve();
      });
    });

  return {
    name: fake.name,
    get requests(): readonly ModelRequest[] {
      return Object.freeze([...received]);
    },
    get started() {
      return started;
    },
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    callStarted(n: number): Promise<void> {
      if (started >= n) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters = [...waiters, { n, resolve }];
      });
    },
    open(): void {
      opened = true;
      openGate();
    },
    async execute(
      request: ModelRequest,
      signal: AbortSignal,
    ): Promise<ModelResponse> {
      received.push(request);
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const ready = waiters.filter((waiter) => waiter.n <= started);
      waiters = waiters.filter((waiter) => waiter.n > started);
      for (const waiter of ready) waiter.resolve();
      try {
        if (!opened) await passGate(signal);
        return await fake.execute(request, signal);
      } finally {
        inFlight -= 1;
      }
    },
  };
}
