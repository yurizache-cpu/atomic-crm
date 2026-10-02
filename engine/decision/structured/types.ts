// The provider-neutral structured-decision boundary (ADR 0022 §E).
//
// A structured decision model reads STATE and answers TYPED QUESTIONS with a
// probability distribution, never with text. Three primitives cover every use
// here: `choice` (one of a closed set of options), `noul` (the probability that
// a condition holds) and `score` (a level on an ordered scale). Jev, served by
// OpenRouter's Decisions API, is the provider today; nothing outside the
// adapter (engine/models/openRouterDecisions.ts) knows its wire format.
//
// Answers are UNTRUSTED. `parseDecisionAnswers` holds every answer to the exact
// question that was asked: a missing key, an unexpected type, an option that
// was never offered or a probability outside [0, 1] is a refusal, never a
// default. The database validates the stored answers again.

export type DecisionQuestion =
  | {
      readonly type: "choice";
      readonly instructions: string;
      /** Option key -> what it means. The model answers with one key. */
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: "score";
      readonly instructions: string;
      /** Ordered levels, lowest first. */
      readonly criteria: readonly string[];
    };

export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export interface StructuredDecisionRequest {
  /** The exact, versioned decision model id (never an alias). */
  readonly model: string;
  /** Allowlisted, already-minimised state. Data, never instructions. */
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: DecisionQuestions;
}

export type DecisionAnswer =
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number | null;
      readonly probabilities: Readonly<Record<string, number>> | null;
    }
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "score";
      /** The probability-weighted level, 0 .. levels-1. Not a calibrated magnitude. */
      readonly score: number;
      /** The most probable level, 0-based. */
      readonly level: number;
      readonly confidence: number | null;
      readonly probabilities: Readonly<Record<string, number>> | null;
    };

export type DecisionAnswers = Readonly<Record<string, DecisionAnswer>>;

export interface StructuredDecisionResponse {
  readonly gateway: string;
  /** The exact build that answered, e.g. `typesafe/jev-1.13-20260917`. */
  readonly model: string;
  /** Upstream provider name, audit only. */
  readonly providerRoute: string | null;
  readonly responseId: string | null;
  /** Raw, still unvalidated: pass through parseDecisionAnswers. */
  readonly answers: unknown;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reportedCostMicros: number | null;
  readonly latencyMs: number;
}

export interface StructuredDecisionGateway {
  readonly name: string;
  /** Rejects with ModelError only (engine/models/errors.ts), like a ModelProvider. */
  decide(
    request: StructuredDecisionRequest,
    signal: AbortSignal,
  ): Promise<StructuredDecisionResponse>;
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/** A probability map whose keys are exactly a subset of `allowed`; null when absent. */
const probabilityMap = (
  raw: unknown,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, number>> | null | "invalid" => {
  if (raw === undefined || raw === null) return null;
  const map = asRecord(raw);
  if (!map) return "invalid";
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(map)) {
    if (!allowed.has(key) || !isProbability(value)) return "invalid";
    out[key] = value;
  }
  return Object.freeze(out);
};

const optionalProbability = (raw: unknown): number | null | "invalid" =>
  raw === undefined || raw === null
    ? null
    : isProbability(raw)
      ? raw
      : "invalid";

export class DecisionAnswerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`structured decision answer refused: ${code}`);
    this.name = "DecisionAnswerError";
    this.code = code;
  }
}

/** Every asked question answered, exactly as asked; throws DecisionAnswerError otherwise. */
export function parseDecisionAnswers(
  questions: DecisionQuestions,
  raw: unknown,
): DecisionAnswers {
  const answers = asRecord(raw);
  if (!answers) throw new DecisionAnswerError("answers_not_object");
  const out: Record<string, DecisionAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = asRecord(answers[key]);
    if (!answer) throw new DecisionAnswerError(`missing_answer:${key}`);
    if (answer.type !== question.type) {
      throw new DecisionAnswerError(`unexpected_type:${key}`);
    }
    switch (question.type) {
      case "choice": {
        const options = new Set(Object.keys(question.criteria));
        if (typeof answer.choice !== "string" || !options.has(answer.choice)) {
          throw new DecisionAnswerError(`unknown_option:${key}`);
        }
        const probabilities = probabilityMap(answer.probabilities, options);
        const confidence = optionalProbability(answer.confidence);
        if (probabilities === "invalid" || confidence === "invalid") {
          throw new DecisionAnswerError(`bad_probability:${key}`);
        }
        out[key] = Object.freeze({
          type: "choice",
          choice: answer.choice,
          confidence,
          probabilities,
        });
        break;
      }
      case "noul": {
        if (!isProbability(answer.noul)) {
          throw new DecisionAnswerError(`bad_probability:${key}`);
        }
        out[key] = Object.freeze({ type: "noul", noul: answer.noul });
        break;
      }
      case "score": {
        const levels = question.criteria.length;
        const score = answer.score;
        if (
          typeof score !== "number" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > levels - 1
        ) {
          throw new DecisionAnswerError(`bad_score:${key}`);
        }
        const allowed = new Set(
          question.criteria.map((_, index) => String(index)),
        );
        const probabilities = probabilityMap(answer.probabilities, allowed);
        const confidence = optionalProbability(answer.confidence);
        if (probabilities === "invalid" || confidence === "invalid") {
          throw new DecisionAnswerError(`bad_probability:${key}`);
        }
        // The level is the most probable one when the distribution is given,
        // else the nearest level to the expectation. Never a magnitude.
        const level =
          probabilities && Object.keys(probabilities).length > 0
            ? Number(
                Object.entries(probabilities).reduce((best, entry) =>
                  entry[1] > best[1] ? entry : best,
                )[0],
              )
            : Math.round(score);
        out[key] = Object.freeze({
          type: "score",
          score,
          level,
          confidence,
          probabilities,
        });
        break;
      }
    }
  }
  return Object.freeze(out);
}
