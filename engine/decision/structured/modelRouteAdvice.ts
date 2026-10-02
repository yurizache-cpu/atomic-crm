// Question set `model_route.v1` (ADR 0022 §E.2): which of a run's AUTHORIZED
// candidates Jev would have chosen. Shadow: the deterministic policy executed;
// this records the advice beside it so routing can be measured before it is
// trusted.
//
// The options are exactly the candidates the database authorized for that run
// (ops.agent_run_model_candidates). Nothing here can name a model the database
// did not already allow: an answer outside the options is refused by
// parseDecisionAnswers, and the advice is never executed in this milestone.

import type { Complexity } from "./businessRouting.ts";
import {
  parseDecisionAnswers,
  type DecisionQuestions,
  type StructuredDecisionRequest,
} from "./types.ts";

export const MODEL_ROUTE_VERSION = "model_route.v1";

export interface RouteCandidate {
  readonly model: string;
  readonly family: string;
  readonly costClass: "low" | "medium" | "high";
  readonly latencyClass: "fast" | "medium" | "slow";
  readonly reasoning: boolean;
  readonly contextClass: "short" | "long";
}

export interface ModelRouteInput {
  readonly capability: string;
  readonly complexity: Complexity | "unknown";
  /** A bucket of the run's input tokens, never the input. */
  readonly inputSize: "small" | "medium" | "large";
  readonly candidates: readonly RouteCandidate[];
}

export const MAX_ROUTE_CANDIDATES = 12;

const describe = (candidate: RouteCandidate): string =>
  [
    `${candidate.family} family`,
    `${candidate.costClass} cost`,
    `${candidate.latencyClass} latency`,
    candidate.reasoning
      ? "supports extended reasoning"
      : "no extended reasoning",
    `${candidate.contextClass} context`,
  ].join(", ");

export function buildModelRouteRequest(
  model: string,
  input: ModelRouteInput,
): StructuredDecisionRequest {
  if (
    input.candidates.length < 2 ||
    input.candidates.length > MAX_ROUTE_CANDIDATES
  ) {
    throw new Error("model route advice needs 2 to 12 authorized candidates");
  }
  const criteria: Record<string, string> = {};
  for (const candidate of input.candidates) {
    if (criteria[candidate.model])
      throw new Error("a candidate is listed twice");
    criteria[candidate.model] = describe(candidate);
  }
  const questions: DecisionQuestions = Object.freeze({
    model: {
      type: "choice",
      instructions:
        "Which model is the cheapest one that will still handle this task well? Prefer lower cost unless the task's complexity or size needs a stronger model.",
      criteria: Object.freeze(criteria),
    },
  });
  return Object.freeze({
    model,
    state: Object.freeze({
      capability: input.capability,
      complexity: input.complexity,
      input_size: input.inputSize,
      structured_output: "required",
    }),
    questions,
  });
}

export interface ModelRouteAdvice {
  readonly version: typeof MODEL_ROUTE_VERSION;
  readonly model: string;
  readonly confidence: number | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
}

export function parseModelRouteAdvice(
  questions: DecisionQuestions,
  raw: unknown,
): ModelRouteAdvice {
  const answer = parseDecisionAnswers(questions, raw).model;
  if (answer?.type !== "choice") throw new Error("unexpected model answer");
  return Object.freeze({
    version: MODEL_ROUTE_VERSION,
    model: answer.choice,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  });
}

/** The input-size bucket from a token estimate. */
export function inputSizeBucket(
  estimatedInputTokens: number,
): ModelRouteInput["inputSize"] {
  if (estimatedInputTokens <= 2000) return "small";
  if (estimatedInputTokens <= 16000) return "medium";
  return "large";
}
