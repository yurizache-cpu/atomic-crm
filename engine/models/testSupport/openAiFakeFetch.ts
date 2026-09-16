// A recording stand-in for `fetch`, speaking the OpenAI Responses API's shapes.
//
// Used by the adapter's own tests, the routing configuration tests and the
// provider contract harness. It never touches the network.
//
// The key is assembled from parts so no committed file contains a literal that
// looks like a real credential to push protection or to the build scan. It is
// deliberately LOWERCASE with dashes: that is the shape that passes the
// error-code, provider-identifier and model-id patterns, so a provider echoing
// it into any of those fields is only stopped by the adapter's explicit check,
// which is what the tests need to exercise.

export const TEST_API_KEY = ["sk", "test", "sentinel0key0for0model0tests"].join(
  "-",
);

export interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Readonly<Record<string, unknown>>;
}

export const recordingFetch = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const request: RecordedRequest = {
      url: String(input),
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch: fetchImpl, requests };
};

/** The user input text the adapter sent, so a fake error body can echo it. */
export const inputTextOf = (request: RecordedRequest): string => {
  const input = request.body.input as readonly {
    readonly content: readonly { readonly text: string }[];
  }[];
  return input[0].content[0].text;
};

export const VALID_ASSESSMENT = Object.freeze({
  outcome: "completed",
  summary: "The task is clear enough to act on.",
  proposed_next_steps: Object.freeze([
    "Confirm the owner.",
    "Schedule the work.",
  ]),
});

export const jsonResponse = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = { "x-request-id": "req_123" },
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export const messageOutput = (...texts: readonly string[]) => [
  {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: texts.map((text) => ({
      type: "output_text",
      text,
      annotations: [],
    })),
  },
];

export const completedBody = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: "resp_0123abc",
  object: "response",
  status: "completed",
  model: "gpt-test-2026-01-01",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    ...messageOutput(JSON.stringify(VALID_ASSESSMENT)),
  ],
  usage: {
    input_tokens: 321,
    input_tokens_details: { cached_tokens: 100 },
    output_tokens: 45,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 366,
  },
  ...overrides,
});

/** An error body that echoes the key and the prompt into every field a careless adapter might copy. */
export const errorBodyEchoing = (
  request: RecordedRequest,
  error: Readonly<Record<string, unknown>> = {},
) => ({
  error: {
    message: `Incorrect API key provided: ${TEST_API_KEY}. The request said: ${inputTextOf(request)}`,
    type: `invalid_request_error ${TEST_API_KEY}`,
    param: inputTextOf(request),
    code: null,
    ...error,
  },
});

/** Behaves like a real fetch that never gets an answer: settles only on abort. */
export const hangUntilAborted = (request: RecordedRequest): Promise<Response> =>
  new Promise((_resolve, reject) => {
    request.init.signal?.addEventListener(
      "abort",
      () =>
        reject(new DOMException("This operation was aborted", "AbortError")),
      { once: true },
    );
  });
