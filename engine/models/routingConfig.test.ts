// @vitest-environment node
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_RESPONSES_URL } from "./openaiResponses.ts";
import {
  createModelRouterFromEnv,
  type ModelRoutingEnv,
} from "./routingConfig.ts";
import { taskAssessmentContract } from "./taskAssessment.ts";
import {
  completedBody,
  jsonResponse,
  recordingFetch,
  TEST_API_KEY,
  VALID_ASSESSMENT,
} from "./testSupport/openAiFakeFetch.ts";

const OPENAI: ModelRoutingEnv = {
  AGENT_MODEL_PROVIDER: "openai",
  OPENAI_API_KEY: TEST_API_KEY,
  AGENT_MODEL_STANDARD: "gpt-test-standard",
};

const messageOf = (build: () => unknown): string => {
  try {
    build();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the environment to be refused");
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("no provider means no model access, not a guessed one", () => {
  it("builds a router with no routes when AGENT_MODEL_PROVIDER is unset or empty", () => {
    for (const env of [
      {},
      { AGENT_MODEL_PROVIDER: "" },
      { ...OPENAI, AGENT_MODEL_PROVIDER: undefined },
    ]) {
      const router = createModelRouterFromEnv(env);
      for (const route of ["economy", "standard", "reasoning"]) {
        expect(router.resolve(route)).toBeUndefined();
      }
      expect(router.maxConfiguredTimeoutMs).toBe(0);
    }
  });

  it("reads only the object it is given, never process.env", () => {
    vi.stubEnv("AGENT_MODEL_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", TEST_API_KEY);
    vi.stubEnv("AGENT_MODEL_STANDARD", "gpt-test-standard");
    expect(createModelRouterFromEnv({}).resolve("standard")).toBeUndefined();
  });
});

describe("only the OpenAI adapter can be selected from environment", () => {
  it("refuses any other provider, including the test-only fake, without echoing the value", () => {
    for (const value of [
      "fake",
      "OpenAI",
      " openai",
      "anthropic",
      TEST_API_KEY,
    ]) {
      const message = messageOf(() =>
        createModelRouterFromEnv({ ...OPENAI, AGENT_MODEL_PROVIDER: value }),
      );
      expect(message).toContain("AGENT_MODEL_PROVIDER");
      if (value !== "fake") expect(message).not.toContain(value);
    }
  });

  it("requires OPENAI_API_KEY, without whitespace, and never echoes it", () => {
    for (const key of [undefined, "", `${TEST_API_KEY} `, "sk-two words"]) {
      const message = messageOf(() =>
        createModelRouterFromEnv({ ...OPENAI, OPENAI_API_KEY: key }),
      );
      expect(message).toContain("OPENAI_API_KEY");
      expect(message).not.toContain(TEST_API_KEY);
      expect(message).not.toContain("two words");
    }
  });

  it("requires at least one tier, naming the variables", () => {
    const message = messageOf(() =>
      createModelRouterFromEnv({
        AGENT_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: TEST_API_KEY,
        AGENT_MODEL_ECONOMY: "",
      }),
    );
    expect(message).toContain("AGENT_MODEL_ECONOMY");
    expect(message).toContain("AGENT_MODEL_STANDARD");
    expect(message).toContain("AGENT_MODEL_REASONING");
  });

  it("refuses a malformed model id by naming its variable, not its value", () => {
    const message = messageOf(() =>
      createModelRouterFromEnv({
        ...OPENAI,
        AGENT_MODEL_REASONING: "gpt 5 (big)",
      }),
    );
    expect(message).toBe("AGENT_MODEL_REASONING is not a valid model id.");
  });

  it("refuses the key pasted into a tier variable, without echoing it", () => {
    for (const pasted of [
      TEST_API_KEY,
      `prefix-${TEST_API_KEY}`,
      "sk-" + "looks-like-another-key",
    ]) {
      const message = messageOf(() =>
        createModelRouterFromEnv({ ...OPENAI, AGENT_MODEL_ECONOMY: pasted }),
      );
      expect(message).toBe("AGENT_MODEL_ECONOMY is not a valid model id.");
      expect(message).not.toContain(pasted);
    }
  });
});

describe("configured tiers route to the OpenAI adapter", () => {
  it("configures exactly the tiers that name a model", () => {
    const router = createModelRouterFromEnv({
      ...OPENAI,
      AGENT_MODEL_ECONOMY: "",
    });
    expect(router.resolve("standard")).toEqual({
      route: "standard",
      provider: "openai",
      model: "gpt-test-standard",
      policy: { maxOutputTokens: 8000, timeoutMs: 45_000 },
    });
    expect(router.resolve("economy")).toBeUndefined();
    expect(router.resolve("reasoning")).toBeUndefined();
    expect(router.maxConfiguredTimeoutMs).toBe(45_000);

    const all = createModelRouterFromEnv({
      ...OPENAI,
      AGENT_MODEL_ECONOMY: "gpt-test-economy",
      AGENT_MODEL_REASONING: "gpt-test-reasoning",
    });
    expect(all.resolve("economy")?.model).toBe("gpt-test-economy");
    expect(all.resolve("reasoning")?.model).toBe("gpt-test-reasoning");
    expect(all.maxConfiguredTimeoutMs).toBe(90_000);
  });

  it("calls the fixed Responses URL through the injected fetch with the configured key and model", async () => {
    const recorder = recordingFetch(() => jsonResponse(200, completedBody()));
    const router = createModelRouterFromEnv(OPENAI, { fetch: recorder.fetch });
    const route = router.resolve("standard");
    if (!route) throw new Error("standard did not resolve");

    const result = await router.executeStructured(
      route,
      { instructions: "Assess.", input: "A task." },
      taskAssessmentContract,
      new AbortController().signal,
    );

    expect(result.value).toEqual(VALID_ASSESSMENT);
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.requests[0].url).toBe(OPENAI_RESPONSES_URL);
    expect(recorder.requests[0].body.model).toBe("gpt-test-standard");
    expect(recorder.requests[0].init.headers).toMatchObject({
      authorization: `Bearer ${TEST_API_KEY}`,
    });
  });

  it("returns a router that does not expose the key", () => {
    const router = createModelRouterFromEnv(OPENAI);
    expect(JSON.stringify(router)).not.toContain(TEST_API_KEY);
    expect(inspect(router, { depth: 10, showHidden: true })).not.toContain(
      TEST_API_KEY,
    );
  });
});
