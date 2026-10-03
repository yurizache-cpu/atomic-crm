// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { agentRunStatusForCategory, ModelError } from "./errors.ts";
import {
  createOpenRouterChatProvider,
  OPENROUTER_CHAT_URL,
  OPENROUTER_METADATA_HEADER,
  OPENROUTER_PROVIDER_CONSTRAINTS,
  openRouterStatus,
  reportedCostMicros,
} from "./openRouterChat.ts";
import {
  hangUntilAborted,
  jsonResponse,
  recordingFetch,
  TEST_API_KEY,
  type RecordedRequest,
} from "./testSupport/openAiFakeFetch.ts";
import type { ModelRequest } from "./types.ts";

// Every response is a fake. These tests pin what ADR 0022 §B promises about
// the primary gateway: one exact model, no fallback of any kind, a substituted
// model never accepted as a result, and neither the key nor the prompt in an
// error.

const PROMPT_SENTINEL = "prompt-sentinel-77c0";
const MODEL = "vendor/model-small";

const REQUEST: ModelRequest = Object.freeze({
  model: MODEL,
  acceptedResponseModels: Object.freeze(["vendor/model-small-20260922"]),
  instructions: `Triage carefully. ${PROMPT_SENTINEL}`,
  input: `Inbound message ${PROMPT_SENTINEL}`,
  output: Object.freeze({
    name: "lead_triage",
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    }),
  }),
  maxOutputTokens: 2000,
});

const completion = (
  overrides: Readonly<Record<string, unknown>> = {},
  choice: Readonly<Record<string, unknown>> = {},
) => ({
  id: "gen-1790000000-abc",
  model: MODEL,
  openrouter_metadata: {
    endpoints: {
      available: [
        { model: MODEL, provider: "Together", selected: false },
        { model: MODEL, provider: "DeepInfra", selected: true },
      ],
      total: 2,
    },
  },
  object: "chat.completion",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({ summary: "New enquiry." }),
        refusal: null,
      },
      ...choice,
    },
  ],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 30,
    total_tokens: 150,
    cost: 0.0000271,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 4 },
  },
  ...overrides,
});

const adapter = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
) => {
  const recorder = recordingFetch(respond);
  let clock = 1000;
  const provider = createOpenRouterChatProvider({
    apiKey: TEST_API_KEY,
    fetch: recorder.fetch,
    now: () => (clock += 25),
  });
  return { provider, requests: recorder.requests };
};

const run = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
  request: ModelRequest = REQUEST,
) => adapter(respond).provider.execute(request, new AbortController().signal);

const failureOf = async (promise: Promise<unknown>): Promise<ModelError> => {
  const outcome = await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ModelError);
  for (const printed of [
    String((outcome as Error).stack),
    JSON.stringify(outcome) ?? "",
    inspect(outcome, { depth: 10, showHidden: true }),
  ]) {
    expect(printed).not.toContain(TEST_API_KEY);
    expect(printed).not.toContain(PROMPT_SENTINEL);
  }
  return outcome as ModelError;
};

describe("the request names one exact model and forbids every fallback", () => {
  it("posts the closed key set to the fixed URL with the key only in the header", async () => {
    const { provider, requests } = adapter(() =>
      jsonResponse(200, completion()),
    );
    await provider.execute(REQUEST, new AbortController().signal);

    expect(requests).toHaveLength(1);
    const [{ url, init, body }] = requests;
    expect(url).toBe(OPENROUTER_CHAT_URL);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TEST_API_KEY}`,
    );
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${TEST_API_KEY}`,
      [OPENROUTER_METADATA_HEADER]: "enabled",
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        "max_tokens",
        "messages",
        "model",
        "provider",
        "response_format",
        "stream",
        "usage",
      ].sort(),
    );
    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(false);
    expect(body.provider).toEqual({
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
    });
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    // No other route to a different model: no fallback list, router, plugin or tool.
    for (const absent of [
      "models",
      "route",
      "plugins",
      "tools",
      "tool_choice",
      "user",
    ]) {
      expect(body).not.toHaveProperty(absent);
    }
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "lead_triage",
        strict: true,
        schema: REQUEST.output.schema,
      },
    });
  });

  it("keeps the routing constraints frozen so no caller can widen them", () => {
    expect(Object.isFrozen(OPENROUTER_PROVIDER_CONSTRAINTS)).toBe(true);
    expect(OPENROUTER_PROVIDER_CONSTRAINTS.allow_fallbacks).toBe(false);
  });
});

describe("a usable answer", () => {
  it("returns the parsed object, the served build, the provider route, usage and the reported cost", async () => {
    const result = await run(() =>
      jsonResponse(200, completion({ model: "vendor/model-small-20260922" })),
    );
    expect(result).toMatchObject({
      provider: "openrouter",
      model: "vendor/model-small-20260922",
      content: { summary: "New enquiry." },
      finishReason: "completed",
      providerRoute: "DeepInfra",
      providerResponseId: "gen-1790000000-abc",
      reportedCostMicros: 28,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cachedInputTokens: 0,
        reasoningTokens: 4,
      },
    });
  });

  it("takes the provider from the documented metadata's selected endpoint, over the undocumented field", async () => {
    const result = await run(() =>
      jsonResponse(200, completion({ provider: "Undocumented" })),
    );
    expect(result.providerRoute).toBe("DeepInfra");
  });

  it.each([
    ["no endpoint selected", [{ provider: "DeepInfra", selected: false }]],
    [
      "two endpoints selected",
      [
        { provider: "DeepInfra", selected: true },
        { provider: "Together", selected: true },
      ],
    ],
    ["a malformed provider name", [{ provider: "bad;name", selected: true }]],
    [
      "the key echoed as a provider",
      [{ provider: TEST_API_KEY, selected: true }],
    ],
  ])(
    "records no route for %s, never the undocumented field instead",
    async (_label, available) => {
      const result = await run(() =>
        jsonResponse(
          200,
          completion({
            provider: "Undocumented",
            openrouter_metadata: {
              endpoints: { available, total: available.length },
            },
          }),
        ),
      );
      expect(result.providerRoute).toBeNull();
    },
  );

  it("reads the observed top-level provider only when the metadata is missing altogether", async () => {
    const result = await run(() =>
      jsonResponse(
        200,
        completion({ openrouter_metadata: undefined, provider: "Observed" }),
      ),
    );
    expect(result.providerRoute).toBe("Observed");
  });

  it("rounds the reported cost up to whole micro-dollars and drops a nonsense value", () => {
    expect(reportedCostMicros({ cost: 0.000001 })).toBe(1);
    expect(reportedCostMicros({ cost: 0.0000271 })).toBe(28);
    expect(reportedCostMicros({ cost: -1 })).toBeNull();
    expect(reportedCostMicros({ cost: "0.1" })).toBeNull();
    expect(reportedCostMicros({})).toBeNull();
  });
});

describe("a billed but unusable answer keeps its gateway report", () => {
  it("carries the provider route and the reported cost on the error", async () => {
    const provider = createOpenRouterChatProvider({
      apiKey: TEST_API_KEY,
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "gen-1",
            model: "other/model",
            openrouter_metadata: {
              endpoints: {
                available: [{ provider: "DeepInfra", selected: true }],
                total: 1,
              },
            },
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
              cost: 0.000033,
            },
            choices: [{ finish_reason: "stop", message: { content: "{}" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const error = await provider
      .execute(REQUEST, new AbortController().signal)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({
      code: "model_substituted",
      providerRoute: "DeepInfra",
      reportedCostMicros: 33,
    });
  });
});

describe("a substituted model is never a result", () => {
  it.each([
    ["another model", "other/model-large"],
    ["no model at all", undefined],
  ])(
    "refuses %s as invalid_response / model_substituted, keeping the usage",
    async (_label, served) => {
      const error = await failureOf(
        run(() => jsonResponse(200, completion({ model: served }))),
      );
      expect(error.category).toBe("invalid_response");
      expect(error.code).toBe("model_substituted");
      expect(agentRunStatusForCategory(error.category)).toBe("failed");
      expect(error.usage?.inputTokens).toBe(120);
    },
  );
});

describe("failures land in the category that decides failed versus indeterminate", () => {
  it.each([
    [402, "configuration", "insufficient_credits", "failed"],
    [403, "invalid_request", "moderation_flagged", "failed"],
    [404, "configuration", "model_route_unavailable", "failed"],
    [401, "authentication", "http_401", "failed"],
    [429, "rate_limit", "http_429", "failed"],
    [408, "timeout", "http_408", "indeterminate"],
    [502, "transport", "http_502", "indeterminate"],
    [503, "provider_5xx", "http_503", "indeterminate"],
    [418, "unknown", "http_418", "indeterminate"],
  ] as const)(
    "HTTP %i is %s / %s (%s)",
    async (status, category, code, outcome) => {
      expect(openRouterStatus(status)).toEqual({ category, code });
      const error = await failureOf(
        run(() =>
          jsonResponse(status, {
            error: {
              code: status,
              message: `echo ${TEST_API_KEY} ${PROMPT_SENTINEL}`,
            },
          }),
        ),
      );
      expect(error.category).toBe(category);
      expect(error.code).toBe(code);
      expect(agentRunStatusForCategory(error.category)).toBe(outcome);
    },
  );

  it.each([
    ["length", "invalid_response", "incomplete_max_output_tokens"],
    ["content_filter", "invalid_response", "content_filter"],
    ["tool_calls", "invalid_response", "unexpected_tool_call"],
    ["error", "invalid_response", "provider_error"],
    ["something_new", "unknown", "unexpected_status"],
  ])("finish_reason %s is %s / %s", async (finish, category, code) => {
    const error = await failureOf(
      run(() => jsonResponse(200, completion({}, { finish_reason: finish }))),
    );
    expect(error.category).toBe(category);
    expect(error.code).toBe(code);
  });

  it("refuses a refusal, a tool call, empty or non-JSON content", async () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ role: "assistant", content: null, refusal: "no" }, "refusal"],
      [
        { role: "assistant", content: "{}", tool_calls: [{ id: "x" }] },
        "unexpected_tool_call",
      ],
      [{ role: "assistant", content: "" }, "empty_output"],
      [{ role: "assistant", content: "not json" }, "output_not_json"],
      [{ role: "assistant", content: "[1,2]" }, "output_not_object"],
    ];
    for (const [message, code] of cases) {
      const error = await failureOf(
        run(() => jsonResponse(200, completion({}, { message }))),
      );
      expect(error.category).toBe("invalid_response");
      expect(error.code).toBe(code);
    }
  });

  it("treats a 200 carrying an error object as a known provider error", async () => {
    const error = await failureOf(
      run(() =>
        jsonResponse(
          200,
          completion({ error: { code: 500, message: "boom" } }),
        ),
      ),
    );
    expect(error.code).toBe("provider_error");
  });

  it("treats an unreadable or choiceless 200 as indeterminate", async () => {
    const unparseable = await failureOf(
      run(() => new Response("{not json", { status: 200 })),
    );
    expect(unparseable.category).toBe("unknown");
    const noChoice = await failureOf(
      run(() => jsonResponse(200, completion({ choices: [] }))),
    );
    expect(noChoice.code).toBe("unexpected_choices");
    expect(agentRunStatusForCategory(noChoice.category)).toBe("indeterminate");
  });

  it("maps a network failure to transport and an abort to cancelled", async () => {
    const network = await failureOf(
      run(() => {
        throw new TypeError(`fetch failed ${TEST_API_KEY}`);
      }),
    );
    expect(network.category).toBe("transport");

    const controller = new AbortController();
    const { provider } = adapter(hangUntilAborted);
    const pending = provider.execute(REQUEST, controller.signal);
    controller.abort();
    expect((await failureOf(pending)).category).toBe("cancelled");
  });

  it("drops a provider string that echoes the key", async () => {
    const result = await run(() =>
      jsonResponse(200, completion({ id: TEST_API_KEY })),
    );
    expect(result.providerResponseId).toBeNull();
  });
});

describe("construction", () => {
  it("refuses an empty or whitespace key without quoting it", () => {
    for (const apiKey of ["", "has space"]) {
      expect(() => createOpenRouterChatProvider({ apiKey })).toThrow(
        /OpenRouter API key must be a non-empty string/,
      );
    }
  });
});
