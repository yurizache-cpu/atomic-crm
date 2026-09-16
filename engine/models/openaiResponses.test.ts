// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  agentRunStatusForCategory,
  ModelError,
  type ModelErrorCategory,
} from "./errors.ts";
import {
  categoryForHttpStatus,
  createOpenAiResponsesProvider,
  OPENAI_RESPONSES_URL,
} from "./openaiResponses.ts";
import {
  completedBody,
  errorBodyEchoing,
  hangUntilAborted,
  jsonResponse,
  messageOutput,
  recordingFetch,
  TEST_API_KEY,
  VALID_ASSESSMENT,
  type RecordedRequest,
} from "./testSupport/openAiFakeFetch.ts";
import type { ModelRequest } from "./types.ts";

// Every response below is a fake. What these tests pin is how the adapter
// treats an ANSWER it cannot trust: which fields survive, which category a
// failure lands in (that decides failed versus indeterminate in the database),
// and that neither the key nor the prompt ever travels back out in an error.

const PROMPT_SENTINEL = "prompt-sentinel-e41b";

const REQUEST: ModelRequest = Object.freeze({
  model: "gpt-test-2026",
  instructions: `Assess carefully. ${PROMPT_SENTINEL}`,
  input: `Task input ${PROMPT_SENTINEL}`,
  output: Object.freeze({
    name: "task_assessment",
    schema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: { summary: { type: "string" } },
    }),
  }),
  maxOutputTokens: 2000,
});

const adapter = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
  options: { readonly maxResponseBytes?: number } = {},
) => {
  const recorder = recordingFetch(respond);
  let clock = 1000;
  const provider = createOpenAiResponsesProvider({
    apiKey: TEST_API_KEY,
    fetch: recorder.fetch,
    now: () => (clock += 25),
    ...options,
  });
  return { provider, requests: recorder.requests };
};

const run = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
  options?: { readonly maxResponseBytes?: number },
) =>
  adapter(respond, options).provider.execute(
    REQUEST,
    new AbortController().signal,
  );

const expectNothingLeaked = (error: unknown) => {
  for (const printed of [
    error instanceof Error ? error.message : "",
    error instanceof Error ? String(error.stack) : "",
    JSON.stringify(error) ?? "",
    inspect(error, { depth: 10, showHidden: true }),
  ]) {
    expect(printed).not.toContain(TEST_API_KEY);
    expect(printed).not.toContain(PROMPT_SENTINEL);
  }
};

const failureOf = async (promise: Promise<unknown>): Promise<ModelError> => {
  const outcome = await promise.then(
    () => "resolved",
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ModelError);
  expectNothingLeaked(outcome);
  return outcome as ModelError;
};

const streamOf = (chunks: readonly string[], onCancel?: () => void) => {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length)
        controller.enqueue(encoder.encode(chunks[index++]));
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
};

describe("the request is a closed shape", () => {
  it("posts to the fixed URL with the key only in the authorization header, refusing redirects", async () => {
    const controller = new AbortController();
    const { provider, requests } = adapter(() =>
      jsonResponse(200, completedBody()),
    );
    await provider.execute(REQUEST, controller.signal);

    expect(requests).toHaveLength(1);
    const [{ url, init }] = requests;
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${TEST_API_KEY}`,
    });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBe(controller.signal);
    expect(String(init.body)).not.toContain(TEST_API_KEY);
  });

  it("sends exactly the documented body keys, and none that grant a capability or retain state", async () => {
    const { provider, requests } = adapter(() =>
      jsonResponse(200, completedBody()),
    );
    await provider.execute(REQUEST, new AbortController().signal);
    const { body } = requests[0];

    expect(Object.keys(body).sort()).toEqual(
      [
        "input",
        "instructions",
        "max_output_tokens",
        "model",
        "store",
        "text",
      ].sort(),
    );
    for (const forbidden of [
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "include",
      "temperature",
      "metadata",
      "user",
      "background",
      "stream",
      "previous_response_id",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(body).toEqual({
      model: "gpt-test-2026",
      instructions: REQUEST.instructions,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: REQUEST.input }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "task_assessment",
          schema: REQUEST.output.schema,
          strict: true,
        },
      },
      max_output_tokens: 2000,
      store: false,
    });
  });
});

describe("the key never sits where it can be read back", () => {
  it("is not a property of the provider object", () => {
    const { provider } = adapter(() => jsonResponse(200, completedBody()));
    expect(Object.keys(provider).sort()).toEqual(["execute", "name"]);
    expect(provider.name).toBe("openai");
    expect(JSON.stringify(provider)).not.toContain(TEST_API_KEY);
    expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(
      TEST_API_KEY,
    );
  });

  it("refuses an empty or whitespace-bearing key without echoing it", () => {
    for (const apiKey of [
      "",
      "sk-with space-inside",
      "sk-trailing-newline\n",
    ]) {
      let message = "";
      try {
        createOpenAiResponsesProvider({ apiKey });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        "the OpenAI API key must be a non-empty string without whitespace",
      );
    }
  });

  it("refuses a byte cap that is not a positive integer", () => {
    for (const maxResponseBytes of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createOpenAiResponsesProvider({
          apiKey: TEST_API_KEY,
          maxResponseBytes,
        }),
      ).toThrow("maxResponseBytes must be a positive integer");
    }
  });
});

describe("a successful response is reduced to shape-checked fields", () => {
  it("returns the parsed output with normalized usage, ids, model and latency", async () => {
    const response = await run(() => jsonResponse(200, completedBody()));
    expect(response).toEqual({
      provider: "openai",
      model: "gpt-test-2026-01-01",
      content: VALID_ASSESSMENT,
      finishReason: "completed",
      usage: {
        inputTokens: 321,
        outputTokens: 45,
        totalTokens: 366,
        cachedInputTokens: 100,
        reasoningTokens: 12,
      },
      providerRequestId: "req_123",
      providerResponseId: "resp_0123abc",
      latencyMs: 25,
    });
  });

  it("drops token counts that are not non-negative integers, and absent usage entirely", async () => {
    const odd = await run(() =>
      jsonResponse(
        200,
        completedBody({
          usage: {
            input_tokens: -1,
            output_tokens: 2.5,
            total_tokens: "9",
            input_tokens_details: null,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        }),
      ),
    );
    expect(odd.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cachedInputTokens: null,
      reasoningTokens: 3,
    });
    expect(
      (await run(() => jsonResponse(200, completedBody({ usage: undefined }))))
        .usage,
    ).toBeNull();
  });

  it("drops malformed ids and falls back to the requested model", async () => {
    const response = await run(() =>
      jsonResponse(
        200,
        completedBody({ id: "resp with space", model: "not a model id!" }),
        { "x-request-id": "x".repeat(201) },
      ),
    );
    expect(response.providerRequestId).toBeNull();
    expect(response.providerResponseId).toBeNull();
    expect(response.model).toBe("gpt-test-2026");
  });

  it("drops an id or model that echoes the key, even when it is well formed", async () => {
    const response = await run(() =>
      jsonResponse(
        200,
        completedBody({ id: TEST_API_KEY, model: TEST_API_KEY }),
        {
          "x-request-id": `req-${TEST_API_KEY}`,
        },
      ),
    );
    expect(response.providerRequestId).toBeNull();
    expect(response.providerResponseId).toBeNull();
    expect(response.model).toBe("gpt-test-2026");
    expect(JSON.stringify(response)).not.toContain(TEST_API_KEY);
  });

  it("concatenates output text across parts and messages, in order", async () => {
    const response = await run(() =>
      jsonResponse(
        200,
        completedBody({
          output: [
            ...messageOutput(
              '{"outcome":"needs_input",',
              '"summary":"Missing the owner.",',
            ),
            ...messageOutput('"proposed_next_steps":[]}'),
          ],
        }),
      ),
    );
    expect(response.content).toEqual({
      outcome: "needs_input",
      summary: "Missing the owner.",
      proposed_next_steps: [],
    });
  });

  it("ignores reasoning items entirely, wherever they appear", async () => {
    // If any field of a reasoning item were read, the "{" fragments would break
    // the concatenated JSON and the call would fail.
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "{" }],
      content: [{ type: "output_text", text: "{" }],
      encrypted_content: "{",
    };
    const response = await run(() =>
      jsonResponse(
        200,
        completedBody({
          output: [
            reasoning,
            ...messageOutput(JSON.stringify(VALID_ASSESSMENT)),
            reasoning,
          ],
        }),
      ),
    );
    expect(response.content).toEqual(VALID_ASSESSMENT);
  });
});

describe("a 200 the adapter cannot use is reported with what the call cost", () => {
  const cases: readonly (readonly [string, Record<string, unknown>, string])[] =
    [
      [
        "a refusal",
        {
          output: [
            {
              type: "message",
              content: [
                {
                  type: "refusal",
                  refusal: `I will not repeat ${TEST_API_KEY} ${PROMPT_SENTINEL}`,
                },
              ],
            },
          ],
        },
        "refusal",
      ],
      ["empty text", { output: messageOutput("") }, "empty_output"],
      ["no output items", { output: [] }, "empty_output"],
      [
        "only reasoning",
        { output: [{ type: "reasoning", summary: [] }] },
        "empty_output",
      ],
      [
        "prose instead of JSON",
        { output: messageOutput("Sure! Here it is.") },
        "output_not_json",
      ],
      ["a JSON array", { output: messageOutput("[1,2]") }, "output_not_object"],
      ["JSON null", { output: messageOutput("null") }, "output_not_object"],
      [
        "a JSON string",
        { output: messageOutput('"text"') },
        "output_not_object",
      ],
      [
        "a tool call the request never offered",
        {
          output: [
            { type: "function_call", name: "delete_records", arguments: "{}" },
            ...messageOutput(JSON.stringify(VALID_ASSESSMENT)),
          ],
        },
        "unexpected_output_item",
      ],
      [
        "a text part that is not a string",
        {
          output: [
            { type: "message", content: [{ type: "output_text", text: 42 }] },
          ],
        },
        "malformed_output",
      ],
      [
        "an incomplete response",
        {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
        "incomplete_max_output_tokens",
      ],
      [
        "an incomplete response with a malformed reason",
        { status: "incomplete", incomplete_details: { reason: "Bad Reason!" } },
        "incomplete",
      ],
      [
        "an incomplete response with no details",
        { status: "incomplete" },
        "incomplete",
      ],
      [
        "an unrecognised failure",
        {
          status: "failed",
          error: { code: "something_else", message: TEST_API_KEY },
        },
        "response_failed",
      ],
    ];

  for (const [label, overrides, code] of cases) {
    it(`reports ${label} as ${code}`, async () => {
      const error = await failureOf(
        run(() => jsonResponse(200, completedBody(overrides))),
      );
      expect(error).toMatchObject({
        category: "invalid_response",
        code,
        providerRequestId: "req_123",
        providerResponseId: "resp_0123abc",
        model: "gpt-test-2026-01-01",
        latencyMs: 25,
      });
      expect(error.usage).toMatchObject({ inputTokens: 321, outputTokens: 45 });
    });
  }

  it("drops an incomplete reason that carries the key", async () => {
    // Only a key of lowercase letters, digits and underscores fits the reason
    // pattern. The check must not rest on real keys happening to contain a dash.
    const apiKey = "sk_underscore_sentinel_key";
    const provider = createOpenAiResponsesProvider({
      apiKey,
      fetch: recordingFetch(() =>
        jsonResponse(
          200,
          completedBody({
            status: "incomplete",
            incomplete_details: { reason: apiKey },
          }),
        ),
      ).fetch,
    });
    const error = await provider
      .execute(REQUEST, new AbortController().signal)
      .then(
        () => "resolved",
        (rejection: unknown) => rejection,
      );
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "invalid_response",
      code: "incomplete",
    });
    expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
      apiKey,
    );
  });

  it("maps a complete, terminal failed response to a known failure: a server error as invalid_response, a rate limit as rate_limit", async () => {
    const server = await failureOf(
      run(() =>
        jsonResponse(
          200,
          completedBody({ status: "failed", error: { code: "server_error" } }),
        ),
      ),
    );
    expect(server).toMatchObject({
      category: "invalid_response",
      code: "server_error",
    });
    expect(agentRunStatusForCategory(server.category)).toBe("failed");
    expect(server.usage).not.toBeNull();

    const limited = await failureOf(
      run(() =>
        jsonResponse(
          200,
          completedBody({
            status: "failed",
            error: { code: "rate_limit_exceeded" },
          }),
        ),
      ),
    );
    expect(limited).toMatchObject({
      category: "rate_limit",
      code: "rate_limit_exceeded",
    });
  });

  it("reports a body that is not JSON as json_parse", async () => {
    const error = await failureOf(
      run(
        () =>
          new Response(`<html>${TEST_API_KEY}</html>`, {
            status: 200,
            headers: { "x-request-id": "req_html" },
          }),
      ),
    );
    expect(error).toMatchObject({
      category: "unknown",
      code: "json_parse",
      providerRequestId: "req_html",
      usage: null,
    });
  });

  it("reports a JSON body that is not an object as unexpected_status", async () => {
    const error = await failureOf(
      run(() => jsonResponse(200, [completedBody()])),
    );
    expect(error).toMatchObject({
      category: "unknown",
      code: "unexpected_status",
    });
  });
});

describe("a 200 that names no terminal status is unknown and carries what the call cost", () => {
  // The provider has not said the model's run ended, so nobody can say how it
  // ended: the run is indeterminate (ADR 0016, owner review 2026-09-16).
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["a status still in progress", { status: "in_progress" }],
    ["a queued status", { status: "queued" }],
    ["no status", { status: undefined }],
    ["a status nobody defined", { status: "paused" }],
  ];

  for (const [label, overrides] of cases) {
    it(`reports ${label} as unexpected_status, recorded indeterminate`, async () => {
      const error = await failureOf(
        run(() => jsonResponse(200, completedBody(overrides))),
      );
      expect(error).toMatchObject({
        category: "unknown",
        code: "unexpected_status",
        providerRequestId: "req_123",
        providerResponseId: "resp_0123abc",
        model: "gpt-test-2026-01-01",
        latencyMs: 25,
      });
      expect(error.usage).toMatchObject({ inputTokens: 321, outputTokens: 45 });
      expect(agentRunStatusForCategory(error.category)).toBe("indeterminate");
    });
  }
});

describe("HTTP failures are classified by status, never by message", () => {
  const statuses: readonly (readonly [number, ModelErrorCategory])[] = [
    [400, "invalid_request"],
    [401, "authentication"],
    [403, "authentication"],
    [404, "configuration"],
    [408, "timeout"],
    [409, "unknown"],
    [405, "unknown"],
    [410, "unknown"],
    [413, "invalid_request"],
    [418, "unknown"],
    [422, "invalid_request"],
    [429, "rate_limit"],
    [499, "unknown"],
    [500, "provider_5xx"],
    [501, "provider_5xx"],
    [502, "transport"],
    [503, "provider_5xx"],
    [504, "timeout"],
    [599, "provider_5xx"],
    [302, "unknown"],
  ];

  for (const [status, category] of statuses) {
    it(`maps ${status} to ${category}`, async () => {
      const error = await failureOf(
        run((request) =>
          jsonResponse(status, errorBodyEchoing(request), {
            "x-request-id": "req_err",
          }),
        ),
      );
      expect(error).toMatchObject({
        category,
        code: `http_${status}`,
        providerRequestId: "req_err",
        latencyMs: 25,
        usage: null,
      });
    });
  }

  it("uses the provider's error code when it is a short identifier", async () => {
    const error = await failureOf(
      run((request) =>
        jsonResponse(
          429,
          errorBodyEchoing(request, { code: "insufficient_quota" }),
        ),
      ),
    );
    expect(error).toMatchObject({
      category: "rate_limit",
      code: "insufficient_quota",
    });
  });

  it("falls back to http_<status> when the reported code is malformed, echoes the key, or is unreadable", async () => {
    const bodies: readonly ((request: RecordedRequest) => Response)[] = [
      (request) =>
        jsonResponse(
          401,
          errorBodyEchoing(request, { code: "Invalid API Key" }),
        ),
      (request) =>
        jsonResponse(401, errorBodyEchoing(request, { code: TEST_API_KEY })),
      () => new Response(`upstream said ${TEST_API_KEY}`, { status: 401 }),
      () => new Response(null, { status: 401 }),
      () => jsonResponse(401, { error: "just a string" }),
    ];
    for (const body of bodies) {
      const error = await failureOf(run(body));
      expect(error).toMatchObject({
        category: "authentication",
        code: "http_401",
      });
    }
  });

  it("keeps the status classification when the error body is over the byte cap", async () => {
    const error = await failureOf(
      run(
        (request) =>
          jsonResponse(
            503,
            errorBodyEchoing(request, { code: "server_is_overloaded" }),
          ),
        { maxResponseBytes: 16 },
      ),
    );
    expect(error).toMatchObject({ category: "provider_5xx", code: "http_503" });
  });
});

describe("an oversized body is refused", () => {
  it("refuses a declared Content-Length over the cap", async () => {
    let cancelled = false;
    const error = await failureOf(
      run(
        () =>
          new Response(
            streamOf(["{}"], () => (cancelled = true)),
            {
              status: 200,
              headers: { "content-length": "5000", "x-request-id": "req_big" },
            },
          ),
        { maxResponseBytes: 1000 },
      ),
    );
    expect(error).toMatchObject({
      category: "unknown",
      code: "response_too_large",
      providerRequestId: "req_big",
    });
    expect(cancelled).toBe(true);
  });

  it("refuses an undeclared body the moment it crosses the cap, and releases the stream", async () => {
    let cancelled = false;
    const error = await failureOf(
      run(
        () =>
          new Response(
            streamOf(
              ["a".repeat(600), "b".repeat(600), "c".repeat(600)],
              () => (cancelled = true),
            ),
            {
              status: 200,
            },
          ),
        { maxResponseBytes: 1000 },
      ),
    );
    expect(error).toMatchObject({
      category: "unknown",
      code: "response_too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("accepts a body of exactly the cap, counted in bytes", async () => {
    const text = JSON.stringify(
      completedBody({
        output: messageOutput(
          JSON.stringify({
            ...VALID_ASSESSMENT,
            summary: "Ação é necessária.",
          }),
        ),
      }),
    );
    const bytes = new TextEncoder().encode(text).byteLength;
    expect(bytes).toBeGreaterThan(text.length);
    const response = await run(() => new Response(text, { status: 200 }), {
      maxResponseBytes: bytes,
    });
    expect((response.content as { summary: string }).summary).toBe(
      "Ação é necessária.",
    );
    await expect(
      run(() => new Response(text, { status: 200 }), {
        maxResponseBytes: bytes - 1,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
});

describe("cancellation and network failures", () => {
  it("issues no request when the signal is already aborted", async () => {
    const { provider, requests } = adapter(() =>
      jsonResponse(200, completedBody()),
    );
    const error = await failureOf(
      provider.execute(REQUEST, AbortSignal.abort()),
    );
    expect(error).toMatchObject({ category: "cancelled", code: "aborted" });
    expect(requests).toHaveLength(0);
  });

  it("reports an abort during the fetch as cancelled", async () => {
    const { provider } = adapter(hangUntilAborted);
    const controller = new AbortController();
    const pending = provider.execute(REQUEST, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect(await failureOf(pending)).toMatchObject({
      category: "cancelled",
      code: "aborted",
    });
  });

  it("rejects promptly even when the fetch ignores the abort", async () => {
    const { provider } = adapter(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = provider.execute(REQUEST, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const abortedAt = performance.now();
    controller.abort();
    const error = await failureOf(pending);
    expect(performance.now() - abortedAt).toBeLessThan(250);
    expect(error.category).toBe("cancelled");
  });

  it("rejects promptly when the body stalls and the abort arrives mid-read", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
    });
    const { provider } = adapter(() => new Response(stalled, { status: 200 }));
    const controller = new AbortController();
    const pending = provider.execute(REQUEST, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const abortedAt = performance.now();
    controller.abort();
    const error = await failureOf(pending);
    expect(performance.now() - abortedAt).toBeLessThan(250);
    expect(error.category).toBe("cancelled");
  });

  it("reports a fetch rejection without an abort as transport, discarding its text", async () => {
    const error = await failureOf(
      run((request) => {
        throw new TypeError(
          `fetch failed: Bearer ${TEST_API_KEY} ${request.body.instructions}`,
        );
      }),
    );
    expect(error).toMatchObject({
      category: "transport",
      code: "network",
      latencyMs: 25,
    });
  });

  it("reports a synchronously throwing fetch as transport", async () => {
    const provider = createOpenAiResponsesProvider({
      apiKey: TEST_API_KEY,
      fetch: (() => {
        throw new TypeError(`invalid header ${TEST_API_KEY}`);
      }) as typeof fetch,
    });
    const error = await failureOf(
      provider.execute(REQUEST, new AbortController().signal),
    );
    expect(error.category).toBe("transport");
  });

  it("reports a body that fails mid-read as transport", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(
          new Error(`connection reset while sending ${TEST_API_KEY}`),
        );
      },
    });
    const error = await failureOf(
      run(
        () =>
          new Response(broken, {
            status: 200,
            headers: { "x-request-id": "req_reset" },
          }),
      ),
    );
    expect(error).toMatchObject({
      category: "transport",
      code: "network",
      providerRequestId: "req_reset",
    });
  });
});

describe("an ambiguous provider outcome is never recorded as a known failure", () => {
  // ADR 0016, owner review 2026-09-16. A run may be recorded failed only when the
  // provider was never called or its answer settles the outcome: a refusal that
  // proves the model never ran, or a complete response we read. Anything that
  // leaves open whether the model ran is indeterminate, so nobody retries a paid
  // call believing it never happened.
  const DEFINITIVE_REFUSALS: ReadonlyMap<number, ModelErrorCategory> = new Map([
    [400, "invalid_request"],
    [401, "authentication"],
    [403, "authentication"],
    [404, "configuration"],
    [413, "invalid_request"],
    [422, "invalid_request"],
    [429, "rate_limit"],
  ]);

  it("classifies every HTTP status outside the definitive refusals as indeterminate", () => {
    const knownFailures: number[] = [];
    for (let status = 100; status <= 599; status += 1) {
      if (status >= 200 && status <= 299) continue;
      const category = categoryForHttpStatus(status);
      if (agentRunStatusForCategory(category) !== "indeterminate") {
        knownFailures.push(status);
      }
    }
    expect(knownFailures).toEqual([...DEFINITIVE_REFUSALS.keys()]);
  });

  it("records a complete, terminal answer it cannot use as a known failure", async () => {
    for (const overrides of [
      { output: messageOutput("not json at all") },
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      { status: "failed", error: { code: "server_error" } },
      { status: "failed", error: { code: "rate_limit_exceeded" } },
    ]) {
      const error = await failureOf(
        run(() => jsonResponse(200, completedBody(overrides))),
      );
      expect(agentRunStatusForCategory(error.category)).toBe("failed");
    }
  });

  it("classifies each definitive refusal as its own known failure", () => {
    for (const [status, category] of DEFINITIVE_REFUSALS) {
      expect(categoryForHttpStatus(status)).toBe(category);
      expect(agentRunStatusForCategory(category)).toBe("failed");
    }
  });

  it("records a server or gateway error, a lost connection, a broken body, an abort in flight and an unreadable or unfinished answer as indeterminate", async () => {
    const outcomes: ModelError[] = [];
    for (const status of [500, 502, 503, 504]) {
      outcomes.push(
        await failureOf(
          run((request) => jsonResponse(status, errorBodyEchoing(request))),
        ),
      );
    }
    outcomes.push(
      await failureOf(
        run(() => {
          throw new TypeError("socket closed after the request was written");
        }),
      ),
    );
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset mid-body"));
      },
    });
    outcomes.push(
      await failureOf(run(() => new Response(broken, { status: 200 }))),
    );
    const { provider } = adapter(hangUntilAborted);
    const controller = new AbortController();
    const pending = provider.execute(REQUEST, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    outcomes.push(await failureOf(pending));
    outcomes.push(
      await failureOf(
        run(() => jsonResponse(200, completedBody({ status: "in_progress" }))),
      ),
    );
    outcomes.push(
      await failureOf(
        run(() => new Response("<html>gateway</html>", { status: 200 })),
      ),
    );
    outcomes.push(
      await failureOf(
        run(() => jsonResponse(200, completedBody()), { maxResponseBytes: 16 }),
      ),
    );

    expect(outcomes.map((error) => error.category)).toEqual([
      "provider_5xx",
      "transport",
      "provider_5xx",
      "timeout",
      "transport",
      "transport",
      "cancelled",
      "unknown",
      "unknown",
      "unknown",
    ]);
    for (const error of outcomes) {
      expect(agentRunStatusForCategory(error.category)).toBe("indeterminate");
    }
  });

  it("records a failure nobody classified, after the request left, as unknown and indeterminate", async () => {
    // The fetch resolves, so the request was sent, but with something that is
    // not a Response. What breaks next escapes every mapping above and reaches
    // the adapter's last-resort catch, which must never name a known failure.
    const { provider, requests } = adapter(
      () => ({ ok: true, status: 200 }) as unknown as Response,
    );
    const error = await failureOf(
      provider.execute(REQUEST, new AbortController().signal),
    );
    expect(requests).toHaveLength(1);
    expect(error).toMatchObject({ category: "unknown", code: null });
    expect(agentRunStatusForCategory(error.category)).toBe("indeterminate");
  });
});
