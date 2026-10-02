// @vitest-environment node
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { agentRunStatusForCategory, ModelError } from "./errors.ts";
import {
  createOpenRouterDecisionsGateway,
  OPENROUTER_DECISIONS_URL,
} from "./openRouterDecisions.ts";
import {
  hangUntilAborted,
  jsonResponse,
  recordingFetch,
  TEST_API_KEY,
  type RecordedRequest,
} from "./testSupport/openAiFakeFetch.ts";
import type { StructuredDecisionRequest } from "../decision/structured/types.ts";

const STATE_SENTINEL = "state-sentinel-31aa";
const REQUEST: StructuredDecisionRequest = Object.freeze({
  model: "typesafe/jev-1.13",
  state: Object.freeze({ message: `hello ${STATE_SENTINEL}` }),
  questions: Object.freeze({
    human_review: {
      type: "noul" as const,
      instructions: "Should a person read it first?",
    },
  }),
});

const answer = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: "gen-dec-1790265859-EaXKST7hul1Wcqots1ZK",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: { human_review: { type: "noul", noul: 0.12 } },
  usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
  ...overrides,
});

const gateway = (
  respond: (request: RecordedRequest) => Response | Promise<Response>,
) => {
  const recorder = recordingFetch(respond);
  let clock = 0;
  return {
    gateway: createOpenRouterDecisionsGateway({
      apiKey: TEST_API_KEY,
      fetch: recorder.fetch,
      now: () => (clock += 10),
      acceptedBuilds: { "typesafe/jev-1.13": ["typesafe/jev-1.13-20260917"] },
    }),
    requests: recorder.requests,
  };
};

const failureOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => "resolved",
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ModelError);
  const printed = inspect(error, { depth: 10, showHidden: true });
  expect(printed).not.toContain(TEST_API_KEY);
  expect(printed).not.toContain(STATE_SENTINEL);
  return error as ModelError;
};

describe("the Decisions API request", () => {
  it("posts only model, state and questions to the alpha endpoint, key in the header only", async () => {
    const { gateway: g, requests } = gateway(() => jsonResponse(200, answer()));
    const result = await g.decide(REQUEST, new AbortController().signal);
    const [{ url, init, body }] = requests;
    expect(url).toBe(OPENROUTER_DECISIONS_URL);
    expect(init.redirect).toBe("error");
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    expect(result).toMatchObject({
      gateway: "openrouter",
      model: "typesafe/jev-1.13-20260917",
      providerRoute: "TypeSafe",
      inputTokens: 476,
      outputTokens: 70,
      reportedCostMicros: 20,
      answers: { human_review: { type: "noul", noul: 0.12 } },
    });
  });

  it("refuses an alias before calling anything: thresholds belong to one build", async () => {
    const { gateway: g, requests } = gateway(() => jsonResponse(200, answer()));
    const error = await failureOf(
      g.decide(
        { ...REQUEST, model: "~typesafe/jev-latest" },
        new AbortController().signal,
      ),
    );
    expect(error.code).toBe("decision_model_not_pinned");
    expect(agentRunStatusForCategory(error.category)).toBe("failed");
    expect(requests).toHaveLength(0);
  });
});

describe("Decisions API failures", () => {
  it("refuses a substituted build and a missing answers object", async () => {
    for (const [body, code] of [
      [answer({ model: "other/decider-2" }), "model_substituted"],
      [answer({ answers: null }), "answers_missing"],
    ] as const) {
      const { gateway: g } = gateway(() => jsonResponse(200, body));
      const error = await failureOf(
        g.decide(REQUEST, new AbortController().signal),
      );
      expect(error.code).toBe(code);
      expect(error.usage?.inputTokens).toBe(476);
    }
  });

  it.each([
    [402, "failed"],
    [404, "failed"],
    [429, "failed"],
    [500, "indeterminate"],
    [502, "indeterminate"],
  ] as const)("HTTP %i is %s", async (status, outcome) => {
    const { gateway: g } = gateway(() =>
      jsonResponse(status, {
        error: { code: status, message: `${TEST_API_KEY} ${STATE_SENTINEL}` },
      }),
    );
    const error = await failureOf(
      g.decide(REQUEST, new AbortController().signal),
    );
    expect(agentRunStatusForCategory(error.category)).toBe(outcome);
  });

  it("is cancelled promptly on abort and transport on a network failure", async () => {
    const controller = new AbortController();
    const { gateway: hanging } = gateway(hangUntilAborted);
    const pending = hanging.decide(REQUEST, controller.signal);
    controller.abort();
    expect((await failureOf(pending)).category).toBe("cancelled");

    const { gateway: broken } = gateway(() => {
      throw new TypeError("fetch failed");
    });
    expect(
      (await failureOf(broken.decide(REQUEST, new AbortController().signal)))
        .category,
    ).toBe("transport");
  });
});
