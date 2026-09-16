// The model provider contract, as one reusable vitest suite.
//
// Every provider adapter runs through this file (engine/models/
// providerContract.test.ts runs it against the fake provider and the OpenAI
// adapter). It pins what the rest of the engine RELIES on a provider for:
//
//   * a success is a plain JSON object, attributed to the provider's own name,
//     with usage and ids that are either null or safe to store;
//   * every failure is a ModelError, in the category the database's run status
//     is derived from — so a wrong category is a wrong `failed` versus
//     `indeterminate` record, not a cosmetic difference;
//   * malformed output is never accepted as an answer, whether the provider
//     refuses it or the output contract does;
//   * an abort is honoured within 250 ms;
//   * no rejection, anywhere it could be printed, carries the provider's secret
//     or the prompt it was sent.
//
// ADDING A PROVIDER means writing a new harness for this suite and nothing
// else. Agent runs, tasks, worker tenancy, events and idempotency are built on
// the ModelProvider interface and must not change when a vendor is added; if a
// new provider seems to need such a change, the provider is what is wrong.

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  agentRunStatusForCategory,
  ModelError,
  type ModelErrorCategory,
} from "../errors.ts";
import { createModelRouter } from "../router.ts";
import { taskAssessmentContract } from "../taskAssessment.ts";
import {
  isModelId,
  isProviderIdentifier,
  isProviderName,
  isTokenCount,
  type ModelProvider,
  type ModelRequest,
} from "../types.ts";

export interface ProviderContractHarness {
  /**
   * The secret the provider holds (an API key), or a stand-in for a provider
   * that has none. It must appear in no rejection and no response.
   */
  readonly secretSentinel: string;
  /** Answers with a JSON object as its output. */
  readonly succeeding: () => ModelProvider;
  /** Answers with output that is not JSON, or not a JSON object. */
  readonly malformedOutput: () => ModelProvider;
  readonly authenticationFailure: () => ModelProvider;
  readonly rateLimited: () => ModelProvider;
  readonly serverError: () => ModelProvider;
  /** The provider cannot be reached at all. */
  readonly transportFailure: () => ModelProvider;
  /** Never answers; settles only when the signal aborts. */
  readonly hangingUntilAbort: () => ModelProvider;
}

/** Present in the prompt of every contract request; a harness may echo it back to prove it goes nowhere. */
export const CONTRACT_PROMPT_SENTINEL = "contract-prompt-sentinel-5d7c19";
export const CONTRACT_MODEL = "contract-model-1";

const ABORT_BUDGET_MS = 250;

export const contractRequest = (): ModelRequest =>
  Object.freeze({
    model: CONTRACT_MODEL,
    instructions: `Contract instructions ${CONTRACT_PROMPT_SENTINEL}.`,
    input: `Contract input ${CONTRACT_PROMPT_SENTINEL}.`,
    output: Object.freeze({
      name: taskAssessmentContract.name,
      schema: taskAssessmentContract.jsonSchema,
    }),
    maxOutputTokens: 2000,
  });

const isPlainObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Settlement =
  | { readonly kind: "resolved"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "pending" };

const settle = (
  promise: Promise<unknown>,
  withinMs?: number,
): Promise<Settlement> => {
  const outcome = promise.then(
    (value): Settlement => ({ kind: "resolved", value }),
    (error: unknown): Settlement => ({ kind: "rejected", error }),
  );
  if (withinMs === undefined) return outcome;
  return Promise.race([
    outcome,
    new Promise<Settlement>((resolve) =>
      setTimeout(() => resolve({ kind: "pending" }), withinMs),
    ),
  ]);
};

/** Every surface a rejection could be printed from: message, stack, JSON, inspect (which includes `cause`). */
const printedForms = (error: unknown): readonly string[] => [
  error instanceof Error ? error.message : String(error),
  error instanceof Error ? String(error.stack) : "",
  JSON.stringify(error) ?? "",
  inspect(error, { depth: 10, showHidden: true }),
];

const expectModelError = (
  settlement: Settlement,
  secretSentinel: string,
): ModelError => {
  expect(settlement.kind).toBe("rejected");
  const error = settlement.kind === "rejected" ? settlement.error : undefined;
  expect(error).toBeInstanceOf(ModelError);
  for (const printed of printedForms(error)) {
    expect(printed).not.toContain(secretSentinel);
    expect(printed).not.toContain(CONTRACT_PROMPT_SENTINEL);
  }
  return error as ModelError;
};

export function describeModelProviderContract(
  name: string,
  makeHarness: () => ProviderContractHarness,
): void {
  describe(`${name} honours the model provider contract`, () => {
    it("carries a registrable name and never exposes its secret on the provider object", () => {
      const harness = makeHarness();
      const provider = harness.succeeding();
      expect(isProviderName(provider.name)).toBe(true);
      expect(JSON.stringify(provider)).not.toContain(harness.secretSentinel);
      expect(inspect(provider, { depth: 10, showHidden: true })).not.toContain(
        harness.secretSentinel,
      );
    });

    it("returns a plain object attributed to itself, with storable usage and ids", async () => {
      const harness = makeHarness();
      const provider = harness.succeeding();
      const response = await provider.execute(
        contractRequest(),
        new AbortController().signal,
      );

      expect(isPlainObject(response.content)).toBe(true);
      expect(response.provider).toBe(provider.name);
      expect(isModelId(response.model)).toBe(true);
      expect(response.finishReason).toBe("completed");
      expect(Number.isFinite(response.latencyMs)).toBe(true);
      expect(response.latencyMs).toBeGreaterThanOrEqual(0);

      if (response.usage !== null) {
        expect(Object.keys(response.usage).sort()).toEqual([
          "cachedInputTokens",
          "inputTokens",
          "outputTokens",
          "reasoningTokens",
          "totalTokens",
        ]);
        for (const count of Object.values(response.usage)) {
          expect(count === null || isTokenCount(count)).toBe(true);
        }
      }
      for (const id of [
        response.providerRequestId,
        response.providerResponseId,
      ]) {
        expect(id === null || isProviderIdentifier(id)).toBe(true);
      }
      expect(JSON.stringify(response)).not.toContain(harness.secretSentinel);
    });

    it("never lets malformed output through as an answer", async () => {
      // A provider may refuse it itself (invalid_response) or hand it on for the
      // output contract to refuse (schema_validation). Both record the run as
      // failed; what must never happen is a resolved structured result.
      const harness = makeHarness();
      const provider = harness.malformedOutput();

      const direct = await settle(
        provider.execute(contractRequest(), new AbortController().signal),
      );
      if (direct.kind === "resolved") {
        const { content } = direct.value as { content: unknown };
        expect(isPlainObject(content)).toBe(false);
      } else {
        expect(expectModelError(direct, harness.secretSentinel).category).toBe(
          "invalid_response",
        );
      }

      const router = createModelRouter({
        routes: new Map([
          ["economy", { provider: provider.name, model: CONTRACT_MODEL }],
        ]),
        providers: new Map([[provider.name, harness.malformedOutput()]]),
      });
      const route = router.resolve("economy");
      if (!route) throw new Error("the contract route did not resolve");
      const structured = await settle(
        router.executeStructured(
          route,
          contractRequest(),
          taskAssessmentContract,
          new AbortController().signal,
        ),
      );
      const error = expectModelError(structured, harness.secretSentinel);
      expect(["invalid_response", "schema_validation"]).toContain(
        error.category,
      );
      expect(agentRunStatusForCategory(error.category)).toBe("failed");
    });

    const failures: readonly (readonly [
      string,
      (harness: ProviderContractHarness) => ModelProvider,
      ModelErrorCategory,
    ])[] = [
      [
        "an authentication failure",
        (h) => h.authenticationFailure(),
        "authentication",
      ],
      ["a rate limit", (h) => h.rateLimited(), "rate_limit"],
      ["a provider server error", (h) => h.serverError(), "provider_5xx"],
      ["a transport failure", (h) => h.transportFailure(), "transport"],
    ];

    for (const [label, make, category] of failures) {
      it(`reports ${label} as ${category}, without its secret or the prompt`, async () => {
        const harness = makeHarness();
        const settlement = await settle(
          make(harness).execute(
            contractRequest(),
            new AbortController().signal,
          ),
        );
        expect(
          expectModelError(settlement, harness.secretSentinel).category,
        ).toBe(category);
      });
    }

    it(`rejects as cancelled within ${ABORT_BUDGET_MS} ms of an abort while in flight`, async () => {
      const harness = makeHarness();
      const controller = new AbortController();
      const pending = harness
        .hangingUntilAbort()
        .execute(contractRequest(), controller.signal);

      // Genuinely in flight before the abort, not merely constructed.
      expect((await settle(pending, 20)).kind).toBe("pending");
      controller.abort();
      const settlement = await settle(pending, ABORT_BUDGET_MS);

      expect(settlement.kind).not.toBe("pending");
      expect(
        expectModelError(settlement, harness.secretSentinel).category,
      ).toBe("cancelled");
    });

    it("rejects as cancelled when the signal is already aborted", async () => {
      const harness = makeHarness();
      const settlement = await settle(
        harness
          .hangingUntilAbort()
          .execute(contractRequest(), AbortSignal.abort()),
        ABORT_BUDGET_MS,
      );
      expect(
        expectModelError(settlement, harness.secretSentinel).category,
      ).toBe("cancelled");
    });
  });
}
