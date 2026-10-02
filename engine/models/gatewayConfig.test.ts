// @vitest-environment node
import { describe, expect, it } from "vitest";
import { structuredDecisionsFromEnv } from "../decision/structured/gatewayFromEnv.ts";
import { createModelRouterFromEnv } from "./routingConfig.ts";
import { TEST_API_KEY } from "./testSupport/openAiFakeFetch.ts";

// ADR 0022: the gateway path from environment. No model id is configured
// anywhere: the routes are the database's authorized candidates, and the
// decision model is the database's structured_decision pool.

describe("AGENT_MODEL_GATEWAY", () => {
  it("builds a gateway router on the listed tiers, with no static route", () => {
    const router = createModelRouterFromEnv({
      AGENT_MODEL_GATEWAY: "openrouter",
      OPENROUTER_API_KEY: TEST_API_KEY,
      AGENT_MODEL_GATEWAY_ROUTES: "economy,standard",
    });
    expect(router.gatewayName).toBe("openrouter");
    expect(router.resolve("standard")).toBeUndefined();
    expect(router.maxConfiguredTimeoutMs).toBe(45_000);
    expect(
      router.resolveCandidate("standard", {
        gateway: "openrouter",
        model: "vendor/cheap",
        acceptedBuilds: [],
      }),
    ).toMatchObject({
      provider: "openrouter",
      model: "vendor/cheap",
      route: "standard",
    });
    // A tier it was not given, or another gateway's candidate, resolves to nothing.
    expect(
      router.resolveCandidate("reasoning", {
        gateway: "openrouter",
        model: "vendor/cheap",
        acceptedBuilds: [],
      }),
    ).toBeUndefined();
    expect(
      router.resolveCandidate("standard", {
        gateway: "openai",
        model: "vendor/cheap",
        acceptedBuilds: [],
      }),
    ).toBeUndefined();
  });

  it("defaults to the standard tier only", () => {
    const router = createModelRouterFromEnv({
      AGENT_MODEL_GATEWAY: "openrouter",
      OPENROUTER_API_KEY: TEST_API_KEY,
    });
    expect(router.maxConfiguredTimeoutMs).toBe(45_000);
    expect(
      router.resolveCandidate("economy", {
        gateway: "openrouter",
        model: "a/b",
        acceptedBuilds: [],
      }),
    ).toBeUndefined();
  });

  it.each([
    [{ AGENT_MODEL_GATEWAY: "openrouter" }, /OPENROUTER_API_KEY is required/],
    [
      { AGENT_MODEL_GATEWAY: "anthropic", OPENROUTER_API_KEY: TEST_API_KEY },
      /must be unset, empty or "openrouter"/,
    ],
    [
      {
        AGENT_MODEL_GATEWAY: "openrouter",
        OPENROUTER_API_KEY: TEST_API_KEY,
        AGENT_MODEL_PROVIDER: "openai",
      },
      /exclusive/,
    ],
    [
      {
        AGENT_MODEL_GATEWAY: "openrouter",
        OPENROUTER_API_KEY: TEST_API_KEY,
        AGENT_MODEL_GATEWAY_ROUTES: "turbo",
      },
      /AGENT_MODEL_GATEWAY_ROUTES/,
    ],
  ])(
    "refuses a misconfiguration at boot, naming the variable and never the key",
    (env, message) => {
      let thrown: unknown;
      try {
        createModelRouterFromEnv(env);
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).toMatch(message);
      expect(String(thrown)).not.toContain(TEST_API_KEY);
    },
  );
});

describe("STRUCTURED_DECISIONS_GATEWAY", () => {
  it("is off when unset: no request, and a gateway that asks nobody", async () => {
    const config = structuredDecisionsFromEnv({});
    expect(config.requestsStructuredDecisions).toBe(false);
    await expect(
      config.gateway.decide(
        { model: "a/b", state: {}, questions: {} },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      category: "configuration",
      code: "decision_gateway_not_configured",
    });
  });

  it("selects OpenRouter's Decisions API with its key", () => {
    const config = structuredDecisionsFromEnv({
      STRUCTURED_DECISIONS_GATEWAY: "openrouter",
      OPENROUTER_API_KEY: TEST_API_KEY,
    });
    expect(config.requestsStructuredDecisions).toBe(true);
    expect(config.gateway.name).toBe("openrouter");
  });

  it("refuses the scripted gateway from environment, and a missing key", () => {
    expect(() =>
      structuredDecisionsFromEnv({ STRUCTURED_DECISIONS_GATEWAY: "fake" }),
    ).toThrow(/test-only/);
    expect(() =>
      structuredDecisionsFromEnv({
        STRUCTURED_DECISIONS_GATEWAY: "openrouter",
      }),
    ).toThrow(/OPENROUTER_API_KEY is required/);
  });
});
