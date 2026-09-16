// @vitest-environment node
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRunStatusForCategory, ModelError } from "./errors.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
} from "./fakeModelProvider.ts";
import {
  buildModelRequest,
  createModelRouter,
  MODEL_ROUTE_POLICIES,
  type ModelRouter,
  type ResolvedModelRoute,
} from "./router.ts";
import { taskAssessmentContract } from "./taskAssessment.ts";
import type { ModelProvider, ModelRouteName } from "./types.ts";

// The router is tested through the fake provider. What these tests pin is
// what the router REFUSES to do on a provider's behalf: default, fall back,
// retry, wait for a provider that ignores cancellation, or accept output the
// contract rejects.

const VALID = {
  outcome: "completed",
  summary: "The task is clear.",
  proposed_next_steps: ["Do the first thing."],
};
const PROMPT = { instructions: "Assess the task.", input: "The task." };

const routerFor = (
  routes: readonly (readonly [ModelRouteName, ModelProvider, string])[],
): ModelRouter =>
  createModelRouter({
    routes: new Map(
      routes.map(([route, provider, model]) => [
        route,
        { provider: provider.name, model },
      ]),
    ),
    providers: new Map(routes.map(([, provider]) => [provider.name, provider])),
  });

const single = (behavior: FakeBehavior, route: ModelRouteName = "standard") => {
  const provider = createFakeModelProvider(behavior);
  const router = routerFor([[route, provider, `model-${route}-1`]]);
  return { provider, router, route: resolved(router, route) };
};

const resolved = (router: ModelRouter, name: string): ResolvedModelRoute => {
  const route = router.resolve(name);
  if (!route) throw new Error(`route ${name} did not resolve`);
  return route;
};

const failureOf = async (promise: Promise<unknown>): Promise<ModelError> => {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ModelError);
  return outcome as ModelError;
};

/** Wraps a provider so a test can see the signal the router handed it. */
const observed = (inner: ModelProvider) => {
  const signals: AbortSignal[] = [];
  const provider: ModelProvider = {
    name: inner.name,
    execute: (request, signal) => {
      signals.push(signal);
      return inner.execute(request, signal);
    },
  };
  return { provider, signals };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("route policies are fixed per tier", () => {
  it("pins the token ceiling and timeout of each tier", () => {
    expect(MODEL_ROUTE_POLICIES).toEqual({
      economy: { maxOutputTokens: 2000, timeoutMs: 20_000 },
      standard: { maxOutputTokens: 8000, timeoutMs: 45_000 },
      reasoning: { maxOutputTokens: 25_000, timeoutMs: 90_000 },
    });
    expect(Object.isFrozen(MODEL_ROUTE_POLICIES)).toBe(true);
    expect(Object.isFrozen(MODEL_ROUTE_POLICIES.standard)).toBe(true);
  });
});

describe("a route resolves to its configuration or to nothing", () => {
  it("resolves a configured tier to its provider, model and the tier's policy", () => {
    const { router } = single({ type: "respond", content: VALID });
    expect(router.resolve("standard")).toEqual({
      route: "standard",
      provider: "fake",
      model: "model-standard-1",
      policy: { maxOutputTokens: 8000, timeoutMs: 45_000 },
    });
  });

  it("returns undefined for an unconfigured tier, an unknown name or a prototype key", () => {
    const { router } = single({ type: "respond", content: VALID });
    for (const name of [
      "economy",
      "reasoning",
      "premium",
      "",
      "STANDARD",
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(router.resolve(name)).toBeUndefined();
    }
  });

  it("has no default: a router with no routes resolves nothing and budgets no time", () => {
    const router = createModelRouter({
      routes: new Map(),
      providers: new Map(),
    });
    for (const name of ["economy", "standard", "reasoning"]) {
      expect(router.resolve(name)).toBeUndefined();
    }
    expect(router.maxConfiguredTimeoutMs).toBe(0);
  });

  it("reports the largest timeout among configured tiers only", () => {
    const provider = createFakeModelProvider({ type: "hang" });
    expect(routerFor([["economy", provider, "m"]]).maxConfiguredTimeoutMs).toBe(
      20_000,
    );
    expect(
      routerFor([
        ["economy", provider, "m"],
        ["standard", provider, "m"],
      ]).maxConfiguredTimeoutMs,
    ).toBe(45_000);
    expect(
      routerFor([["reasoning", provider, "m"]]).maxConfiguredTimeoutMs,
    ).toBe(90_000);
  });
});

describe("construction refuses a route it could not honour", () => {
  const provider = createFakeModelProvider({ type: "hang" });

  it("refuses a route naming an unregistered provider, without echoing the name", () => {
    const build = () =>
      createModelRouter({
        routes: new Map([
          ["standard", { provider: "ghostprovider", model: "m" }],
        ]),
        providers: new Map([[provider.name, provider]]),
      });
    expect(build).toThrow(
      'model route "standard" names a provider that is not registered',
    );
    expect(build).not.toThrow("ghostprovider");
  });

  it("refuses a malformed model id, without echoing it", () => {
    const build = () =>
      createModelRouter({
        routes: new Map([
          ["economy", { provider: "fake", model: "bad model id" }],
        ]),
        providers: new Map([[provider.name, provider]]),
      });
    expect(build).toThrow(
      'the model id for model route "economy" is malformed',
    );
    expect(build).not.toThrow("bad model id");
  });

  it("refuses a route name outside the three tiers", () => {
    expect(() =>
      createModelRouter({
        routes: new Map([
          ["premium" as ModelRouteName, { provider: "fake", model: "m" }],
        ]),
        providers: new Map([[provider.name, provider]]),
      }),
    ).toThrow("model route must be one of economy, standard, reasoning");
  });

  it("refuses a provider registered under a name other than its own", () => {
    expect(() =>
      createModelRouter({
        routes: new Map([["standard", { provider: "openai", model: "m" }]]),
        providers: new Map([["openai", provider]]),
      }),
    ).toThrow("does not carry its registered name");
  });
});

describe("a structured call is one invocation of the configured provider", () => {
  it("sends the route's model and ceiling with the contract's schema, and returns the parsed value", async () => {
    const { provider, router, route } = single({
      type: "respond",
      content: VALID,
    });
    const result = await router.executeStructured(
      route,
      PROMPT,
      taskAssessmentContract,
      new AbortController().signal,
    );

    expect(result.value).toEqual(VALID);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result).toMatchObject({
      provider: "fake",
      model: "model-standard-1",
      finishReason: "completed",
      providerRequestId: "fake-req-1",
      providerResponseId: "fake-resp-1",
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toEqual({
      model: "model-standard-1",
      instructions: PROMPT.instructions,
      input: PROMPT.input,
      output: {
        name: taskAssessmentContract.name,
        schema: taskAssessmentContract.jsonSchema,
      },
      maxOutputTokens: 8000,
    });
  });

  it("sends exactly the request the exported builder produces, so a fingerprint of that request is a fingerprint of the call", async () => {
    // A caller fingerprints buildModelRequest's output before the call. If the
    // router assembled its own copy, the two could drift apart unseen.
    const { provider, router, route } = single({
      type: "respond",
      content: VALID,
    });
    await router.executeStructured(
      route,
      PROMPT,
      taskAssessmentContract,
      new AbortController().signal,
    );
    expect(provider.calls[0]).toEqual(
      buildModelRequest(route, PROMPT, taskAssessmentContract),
    );
  });

  it("builds the request from picked fields, so a wider prompt object does not widen it", () => {
    const { router } = single({ type: "respond", content: VALID });
    const wider = {
      ...PROMPT,
      promptVersion: "task_assessment.v1",
      tenant: "t-1",
    };
    const request = buildModelRequest(
      resolved(router, "standard"),
      wider,
      taskAssessmentContract,
    );
    expect(Object.keys(request).sort()).toEqual([
      "input",
      "instructions",
      "maxOutputTokens",
      "model",
      "output",
    ]);
    expect(Object.keys(request.output).sort()).toEqual(["name", "schema"]);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.output)).toBe(true);
  });

  it("applies the configured policy even when handed a copy with a larger budget", async () => {
    const { provider, router, route } = single({
      type: "delay",
      ms: 30,
      then: { type: "respond", content: VALID },
    });
    const widened: ResolvedModelRoute = {
      ...route,
      policy: { maxOutputTokens: 1_000_000, timeoutMs: 1 },
    };
    await router.executeStructured(
      widened,
      PROMPT,
      taskAssessmentContract,
      new AbortController().signal,
    );
    // Neither the ceiling nor the 1 ms timeout from the caller's copy applied.
    expect(provider.calls[0].maxOutputTokens).toBe(8000);
  });

  it("refuses a route this router did not configure, without calling any provider", async () => {
    const { provider, router, route } = single({
      type: "respond",
      content: VALID,
    });
    for (const forged of [
      { ...route, model: "some-other-model" },
      { ...route, provider: "openai" },
      { ...route, route: "economy" as const },
    ]) {
      const error = await failureOf(
        router.executeStructured(
          forged,
          PROMPT,
          taskAssessmentContract,
          new AbortController().signal,
        ),
      );
      expect(error.category).toBe("configuration");
      expect(error.code).toBe("route_not_configured");
    }
    expect(provider.calls).toHaveLength(0);
  });
});

describe("there is no retry and no fallback", () => {
  it("invokes a failing provider once, passes its category through, and never tries another route", async () => {
    const failing = createFakeModelProvider(
      { type: "fail", category: "rate_limit", code: "rate_limit_exceeded" },
      { name: "primary" },
    );
    const other = createFakeModelProvider(
      { type: "respond", content: VALID },
      { name: "secondary" },
    );
    const router = routerFor([
      ["standard", failing, "model-a"],
      ["economy", other, "model-b"],
    ]);
    const error = await failureOf(
      router.executeStructured(
        resolved(router, "standard"),
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      ),
    );
    expect(error.category).toBe("rate_limit");
    expect(error.code).toBe("rate_limit_exceeded");
    expect(failing.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(0);
  });

  it("does not retry a transport failure either", async () => {
    const { provider, router, route } = single({
      type: "fail",
      category: "transport",
    });
    const error = await failureOf(
      router.executeStructured(
        route,
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      ),
    );
    expect(error.category).toBe("transport");
    expect(provider.calls).toHaveLength(1);
  });

  it("rejects malformed output as schema_validation, carrying what the call cost", async () => {
    for (const content of [
      "not an object",
      null,
      [],
      { ...VALID, outcome: "done" },
      { ...VALID, extra: true },
      { ...VALID, summary: " " },
    ]) {
      const usage = {
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 33,
        cachedInputTokens: 0,
        reasoningTokens: 4,
      };
      const { provider, router, route } = single({
        type: "respond",
        content,
        usage,
        model: "reported-model",
      });
      const error = await failureOf(
        router.executeStructured(
          route,
          PROMPT,
          taskAssessmentContract,
          new AbortController().signal,
        ),
      );
      expect(error).toMatchObject({
        category: "schema_validation",
        code: "contract_mismatch",
        usage,
        providerRequestId: "fake-req-1",
        providerResponseId: "fake-resp-1",
        model: "reported-model",
      });
      expect(error.latencyMs).toBeGreaterThanOrEqual(0);
      expect(provider.calls).toHaveLength(1);
    }
  });

  it("never quotes rejected output in the error", async () => {
    const { router, route } = single({
      type: "respond",
      content: {
        outcome: "leaked-output-sentinel-44",
        summary: "x",
        proposed_next_steps: [],
      },
    });
    const error = await failureOf(
      router.executeStructured(
        route,
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      ),
    );
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
      "leaked-output-sentinel-44",
    );
  });

  it("turns a provider's foreign error, thrown or rejected, into unknown without its text", async () => {
    const secret = "foreign-error-sentinel-81";
    for (const provider of [
      { name: "fake", execute: () => Promise.reject(new Error(secret)) },
      {
        name: "fake",
        execute: () => {
          throw new Error(secret);
        },
      },
    ] satisfies ModelProvider[]) {
      const router = routerFor([["standard", provider, "m"]]);
      const pending = router.executeStructured(
        resolved(router, "standard"),
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      );
      const error = await failureOf(pending);
      expect(error.category).toBe("unknown");
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
        secret,
      );
    }
  });

  it("re-shapes a provider's response instead of trusting its fields", async () => {
    const provider: ModelProvider = {
      name: "fake",
      execute: async () => ({
        provider: "someone_else",
        model: "not a model id",
        content: VALID,
        finishReason: "Completed!",
        usage: {
          inputTokens: -5,
          outputTokens: 1,
          totalTokens: 1,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
        providerRequestId: "has space",
        providerResponseId: "resp_ok",
        latencyMs: Number.NaN,
      }),
    };
    const router = routerFor([["standard", provider, "configured-model"]]);
    const result = await router.executeStructured(
      resolved(router, "standard"),
      PROMPT,
      taskAssessmentContract,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      provider: "fake",
      model: "configured-model",
      finishReason: "unknown",
      usage: { inputTokens: null, outputTokens: 1 },
      providerRequestId: null,
      providerResponseId: "resp_ok",
      latencyMs: 0,
    });
  });
});

describe("a provider that breaks its own contract is an ambiguous ending", () => {
  const callWith = (execute: ModelProvider["execute"]) => {
    const router = routerFor([
      ["standard", { name: "fake", execute }, "configured-model"],
    ]);
    return failureOf(
      router.executeStructured(
        resolved(router, "standard"),
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      ),
    );
  };

  it("records something other than a response as unknown and indeterminate", async () => {
    for (const raw of [null, undefined, "text", 42, true]) {
      const error = await callWith(
        async () =>
          raw as unknown as Awaited<ReturnType<ModelProvider["execute"]>>,
      );
      expect([error.category, error.code]).toEqual([
        "unknown",
        "provider_contract",
      ]);
      expect(agentRunStatusForCategory(error.category)).toBe("indeterminate");
    }
  });

  it("records a response with no content as unknown, with what the call cost", async () => {
    const error = await callWith(
      async () =>
        ({
          provider: "fake",
          model: "served-model",
          finishReason: "completed",
          usage: {
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
          providerRequestId: "req_1",
          providerResponseId: "resp_1",
          latencyMs: 40,
        }) as unknown as Awaited<ReturnType<ModelProvider["execute"]>>,
    );
    expect(error).toMatchObject({
      category: "unknown",
      code: "provider_contract",
      model: "served-model",
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      providerRequestId: "req_1",
      providerResponseId: "resp_1",
      latencyMs: 40,
    });
    expect(agentRunStatusForCategory(error.category)).toBe("indeterminate");
  });

  it("still records present content that fails the contract as a known failure", async () => {
    for (const content of [null, "prose", { outcome: "completed" }]) {
      const error = await callWith(async () => ({
        provider: "fake",
        model: "served-model",
        content,
        finishReason: "completed",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
        providerRequestId: null,
        providerResponseId: null,
        latencyMs: 1,
      }));
      expect(error.category).toBe("schema_validation");
      expect(agentRunStatusForCategory(error.category)).toBe("failed");
    }
  });
});

describe("numbers reach the caller only in the range their columns store", () => {
  it("rounds a fractional latency and drops a token count past the integer range", async () => {
    const provider: ModelProvider = {
      name: "fake",
      execute: async (request) => ({
        provider: "fake",
        model: request.model,
        content: VALID,
        finishReason: "completed",
        usage: {
          inputTokens: 2_147_483_648,
          outputTokens: 2_147_483_647,
          totalTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
        providerRequestId: null,
        providerResponseId: null,
        latencyMs: 12.6,
      }),
    };
    const router = routerFor([["standard", provider, "m"]]);
    const result = await router.executeStructured(
      resolved(router, "standard"),
      PROMPT,
      taskAssessmentContract,
      new AbortController().signal,
    );
    expect(result.latencyMs).toBe(13);
    expect(result.usage).toMatchObject({
      inputTokens: null,
      outputTokens: 2_147_483_647,
    });
  });
});

describe("the deadline and the caller's cancellation are distinct outcomes", () => {
  it("reports the route timeout as timeout, and tells the provider to stop", async () => {
    vi.useFakeTimers();
    const { provider, signals } = observed(
      createFakeModelProvider({ type: "hang" }),
    );
    const router = routerFor([["standard", provider, "m"]]);
    let outcome: unknown = "pending";
    void router
      .executeStructured(
        resolved(router, "standard"),
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      )
      .catch((error: unknown) => {
        outcome = error;
      });

    await vi.advanceTimersByTimeAsync(44_999);
    expect(outcome).toBe("pending");
    expect(signals[0].aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    // The provider's own "cancelled" rejection, caused by this abort, must not
    // replace the deadline: a timeout is indeterminate, and so is cancelled,
    // but only one of them says the lease-bound budget ran out.
    expect(outcome).toBeInstanceOf(ModelError);
    expect(outcome).toMatchObject({ category: "timeout", code: "deadline" });
    expect(signals[0].aborted).toBe(true);
  });

  it("uses the tier's own timeout", async () => {
    vi.useFakeTimers();
    const { router, route } = single({ type: "hang" }, "economy");
    const outcome = router
      .executeStructured(
        route,
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toMatchObject({ category: "timeout" });
  });

  it("reports the caller's abort as cancelled, not as a timeout", async () => {
    const { router, route } = single({ type: "hang" });
    const controller = new AbortController();
    const pending = router.executeStructured(
      route,
      PROMPT,
      taskAssessmentContract,
      controller.signal,
    );
    controller.abort();
    const error = await failureOf(pending);
    expect(error.category).toBe("cancelled");
    expect(error.code).toBe("aborted");
  });

  it("issues no request at all when the signal is already aborted", async () => {
    const { provider, router, route } = single({
      type: "respond",
      content: VALID,
    });
    const error = await failureOf(
      router.executeStructured(
        route,
        PROMPT,
        taskAssessmentContract,
        AbortSignal.abort(),
      ),
    );
    expect(error.category).toBe("cancelled");
    expect(provider.calls).toHaveLength(0);
  });

  it("does not wait for a provider that ignores the abort", async () => {
    const { router, route } = single({ type: "ignore_abort" });
    const controller = new AbortController();
    const pending = router.executeStructured(
      route,
      PROMPT,
      taskAssessmentContract,
      controller.signal,
    );
    const abortedAt = performance.now();
    controller.abort();
    const error = await failureOf(pending);
    expect(performance.now() - abortedAt).toBeLessThan(250);
    expect(error.category).toBe("cancelled");
  });

  it("swallows a provider's settlement that arrives after the router gave up", async () => {
    // If a late rejection escaped, vitest would fail this file on an unhandled
    // rejection; if a late resolution were used, the outcome would change.
    for (const late of [
      () => Promise.reject(new ModelError("provider_5xx")),
      () => Promise.resolve({ content: VALID }),
    ]) {
      const provider: ModelProvider = {
        name: "fake",
        execute: () =>
          new Promise((resolve, reject) => {
            setTimeout(() => {
              late().then(resolve as (value: unknown) => void, reject);
            }, 20);
          }),
      };
      const router = routerFor([["standard", provider, "m"]]);
      const controller = new AbortController();
      const pending = router.executeStructured(
        resolved(router, "standard"),
        PROMPT,
        taskAssessmentContract,
        controller.signal,
      );
      controller.abort();
      expect((await failureOf(pending)).category).toBe("cancelled");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  });

  it("leaves no timer behind once a call has settled", async () => {
    vi.useFakeTimers();
    const { router, route } = single(
      { type: "respond", content: VALID },
      "reasoning",
    );
    await router.executeStructured(
      route,
      PROMPT,
      taskAssessmentContract,
      new AbortController().signal,
    );
    // A finished call must not keep a 90 s timer holding the process open.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a finish reason is kept only in the shape the database stores", () => {
  it("keeps one of 40 characters and reports a longer one as unknown", async () => {
    const at = (finishReason: string) => {
      const provider: ModelProvider = {
        name: "fake",
        execute: async (request) => ({
          provider: "fake",
          model: request.model,
          content: VALID,
          finishReason,
          usage: null,
          providerRequestId: null,
          providerResponseId: null,
          latencyMs: 1,
        }),
      };
      const router = routerFor([["standard", provider, "m"]]);
      return router.executeStructured(
        resolved(router, "standard"),
        PROMPT,
        taskAssessmentContract,
        new AbortController().signal,
      );
    };
    const forty = `s${"t".repeat(39)}`;
    expect((await at(forty)).finishReason).toBe(forty);
    expect((await at(`${forty}u`)).finishReason).toBe("unknown");
  });
});
