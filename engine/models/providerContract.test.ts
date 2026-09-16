// @vitest-environment node
import { createFakeModelProvider } from "./fakeModelProvider.ts";
import { createOpenAiResponsesProvider } from "./openaiResponses.ts";
import {
  completedBody,
  errorBodyEchoing,
  hangUntilAborted,
  inputTextOf,
  jsonResponse,
  messageOutput,
  recordingFetch,
  TEST_API_KEY,
  VALID_ASSESSMENT,
  type RecordedRequest,
} from "./testSupport/openAiFakeFetch.ts";
import { describeModelProviderContract } from "./testSupport/providerContract.ts";

// One contract, every provider. A new provider adds a harness here and nothing
// anywhere else.

describeModelProviderContract("the fake provider", () => ({
  // The fake holds no secret; the sentinel proves the assertions run, not that
  // there was anything to hide.
  secretSentinel: "fake-provider-holds-no-secret-3a9f",
  succeeding: () =>
    createFakeModelProvider({ type: "respond", content: VALID_ASSESSMENT }),
  malformedOutput: () =>
    createFakeModelProvider({
      type: "respond",
      content: "this is not an object",
    }),
  authenticationFailure: () =>
    createFakeModelProvider({
      type: "fail",
      category: "authentication",
      code: "invalid_api_key",
    }),
  rateLimited: () =>
    createFakeModelProvider({ type: "fail", category: "rate_limit" }),
  serverError: () =>
    createFakeModelProvider({ type: "fail", category: "provider_5xx" }),
  transportFailure: () =>
    createFakeModelProvider({
      type: "fail",
      category: "transport",
      code: "network",
    }),
  hangingUntilAbort: () => createFakeModelProvider({ type: "hang" }),
}));

const openAi = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
) =>
  createOpenAiResponsesProvider({
    apiKey: TEST_API_KEY,
    fetch: recordingFetch(respond).fetch,
  });

describeModelProviderContract("the OpenAI Responses adapter", () => ({
  secretSentinel: TEST_API_KEY,
  succeeding: () => openAi(() => jsonResponse(200, completedBody())),
  malformedOutput: () =>
    openAi(() =>
      jsonResponse(
        200,
        completedBody({ output: messageOutput("not json at all") }),
      ),
    ),
  // Every failure body echoes the key and the prompt, the way a careless proxy
  // or a verbose provider message would.
  authenticationFailure: () =>
    openAi((request) =>
      jsonResponse(401, errorBodyEchoing(request, { code: "invalid_api_key" })),
    ),
  rateLimited: () =>
    openAi((request) =>
      jsonResponse(
        429,
        errorBodyEchoing(request, { code: "rate_limit_exceeded" }),
      ),
    ),
  serverError: () =>
    openAi((request) =>
      jsonResponse(500, errorBodyEchoing(request, { code: "server_error" })),
    ),
  transportFailure: () =>
    openAi((request) => {
      throw new TypeError(
        `fetch failed: Bearer ${TEST_API_KEY} while sending ${inputTextOf(request)}`,
      );
    }),
  hangingUntilAbort: () => openAi(hangUntilAborted),
}));
