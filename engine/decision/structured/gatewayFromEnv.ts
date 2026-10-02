// The structured decision gateway from environment (ADR 0022 §E). Pure: reads
// only the `env` it is handed.
//
//   STRUCTURED_DECISIONS_GATEWAY unset or empty -> no gateway: settled runs
//     request no structured decisions, and a decision job another worker queued
//     is refused by the database (no decision model on gateway "none").
//   "openrouter" -> OpenRouter's Decisions API; OPENROUTER_API_KEY required.
//   Anything else, "fake" included, throws at boot: the scripted gateway is
//   test-only.
//
// The decision MODEL is never configured here: the database names it (the
// rank-1 member of the structured_decision pool), so no model id lives in code
// or environment. Errors name the variable, never its value.

import { ModelError } from "../../models/errors.ts";
import { createOpenRouterDecisionsGateway } from "../../models/openRouterDecisions.ts";
import type { StructuredDecisionGateway } from "./types.ts";

export interface StructuredDecisionsConfig {
  readonly gateway: StructuredDecisionGateway;
  readonly requestsStructuredDecisions: boolean;
}

/** The gateway a worker has when none is configured: it asks nobody. */
export const UNCONFIGURED_DECISION_GATEWAY: StructuredDecisionGateway =
  Object.freeze({
    name: "none",
    decide: async () => {
      throw new ModelError("configuration", {
        code: "decision_gateway_not_configured",
      });
    },
  });

export function structuredDecisionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  dependencies: { readonly fetch?: typeof fetch } = {},
): StructuredDecisionsConfig {
  const selected = env.STRUCTURED_DECISIONS_GATEWAY;
  if (selected === undefined || selected === "") {
    return Object.freeze({
      gateway: UNCONFIGURED_DECISION_GATEWAY,
      requestsStructuredDecisions: false,
    });
  }
  if (selected !== "openrouter") {
    throw new Error(
      'STRUCTURED_DECISIONS_GATEWAY must be unset, empty or "openrouter". A scripted gateway is test-only.',
    );
  }
  const apiKey = env.OPENROUTER_API_KEY;
  if (typeof apiKey !== "string" || apiKey === "" || /\s/.test(apiKey)) {
    throw new Error(
      "OPENROUTER_API_KEY is required when STRUCTURED_DECISIONS_GATEWAY is openrouter, and must not contain whitespace.",
    );
  }
  return Object.freeze({
    gateway: createOpenRouterDecisionsGateway({
      apiKey,
      fetch: dependencies.fetch,
    }),
    requestsStructuredDecisions: true,
  });
}
