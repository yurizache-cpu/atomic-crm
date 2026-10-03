// Question set `lead_intelligence.v1` (ADR 0022 §F): commercial readiness,
// scheduling readiness, follow-up priority, the objection category and the next
// best administrative or commercial action. SHADOW ONLY, and never presented as
// a calibrated probability of conversion.
//
// CLINICAL CONTENT IS NOT A COMMERCIAL SIGNAL. The state is built from an
// allowlist of OPERATIONAL fields only: the triage's closed intent and priority
// enums, the funnel stage, and counts and intervals of interactions. It never
// carries the message, a summary, a diagnosis, a condition, medication, how much
// someone is suffering, or any clinical record. `buildLeadIntelligenceRequest`
// refuses an input with any other field, so a caller cannot widen it by
// accident; a test pins the exact field set.

import {
  parseDecisionAnswers,
  type DecisionAnswers,
  type DecisionQuestions,
  type StructuredDecisionRequest,
} from "./types.ts";

export const LEAD_INTELLIGENCE_VERSION = "lead_intelligence.v1";

export const LEAD_SIGNAL_FIELDS = Object.freeze([
  "intent",
  "priority",
  "funnel_stage",
  "has_open_opportunity",
  "inbound_messages",
  "days_since_first_contact",
  "hours_since_last_inbound",
] as const);

export interface LeadSignals {
  /** The triage's closed intent enum (lead_triage.v2). */
  readonly intent:
    | "book_appointment"
    | "pricing"
    | "information"
    | "support"
    | "other";
  readonly priority: "low" | "normal" | "high";
  /** A configured CRM stage code, or `none`. */
  readonly funnel_stage: string;
  /** Whether the contact has an open deal; `unknown` until the CRM link exists, never a guessed `no`. */
  readonly has_open_opportunity: "yes" | "no" | "unknown";
  readonly inbound_messages: number;
  readonly days_since_first_contact: number;
  readonly hours_since_last_inbound: number;
}

const INTENTS = new Set([
  "book_appointment",
  "pricing",
  "information",
  "support",
  "other",
]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const TRI_STATE = new Set(["yes", "no", "unknown"]);
const STAGE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const isCount = (value: unknown, max: number) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;

/** The allowlisted state; throws on any other field or an out-of-range value. */
export function leadSignalsState(
  signals: LeadSignals,
): Readonly<Record<string, unknown>> {
  const keys = Object.keys(signals).sort();
  const allowed = [...LEAD_SIGNAL_FIELDS].sort();
  if (
    keys.length !== allowed.length ||
    keys.some((key, index) => key !== allowed[index])
  ) {
    throw new Error(
      "lead intelligence state carries exactly the allowlisted operational fields",
    );
  }
  if (
    !INTENTS.has(signals.intent) ||
    !PRIORITIES.has(signals.priority) ||
    !STAGE.test(signals.funnel_stage) ||
    !TRI_STATE.has(signals.has_open_opportunity) ||
    !isCount(signals.inbound_messages, 10_000) ||
    !isCount(signals.days_since_first_contact, 36_500) ||
    !isCount(signals.hours_since_last_inbound, 876_000)
  ) {
    throw new Error("a lead intelligence signal is out of range");
  }
  return Object.freeze({ ...signals });
}

const READINESS = Object.freeze([
  "Low: no sign of moving forward yet.",
  "Medium: interested but undecided.",
  "High: ready to take the next step now.",
]);

export const OBJECTIONS = Object.freeze({
  price: "Concern about the price or how to pay.",
  schedule: "No time that fits, or availability concerns.",
  modality: "Doubts about online sessions or the format.",
  trust_or_fit: "Unsure whether the service or professional fits them.",
  none: "No objection is apparent.",
  unknown: "Impossible to tell from these signals.",
});

export const NEXT_ACTIONS = Object.freeze({
  offer_slots: "Offer available appointment times.",
  share_pricing_information: "Share prices and package information.",
  answer_question: "Answer the open question before anything else.",
  follow_up_later: "Wait and follow up later.",
  human_review: "A person should decide the next step.",
});

export const LEAD_INTELLIGENCE_QUESTIONS: DecisionQuestions = Object.freeze({
  commercial_readiness: {
    type: "score",
    instructions:
      "How ready is this lead to become a client, from these operational signals?",
    criteria: READINESS,
  },
  scheduling_readiness: {
    type: "score",
    instructions: "How ready is this lead to book an appointment now?",
    criteria: READINESS,
  },
  follow_up_priority: {
    type: "score",
    instructions: "How soon should the clinic follow up with this lead?",
    criteria: Object.freeze([
      "Low: no follow-up needed soon.",
      "Medium: follow up within a few days.",
      "High: follow up today.",
    ]),
  },
  objection: {
    type: "choice",
    instructions:
      "Which administrative or commercial objection, if any, do these signals suggest?",
    criteria: OBJECTIONS,
  },
  next_best_action: {
    type: "choice",
    instructions: "What is the best next administrative or commercial step?",
    criteria: NEXT_ACTIONS,
  },
});

export function buildLeadIntelligenceRequest(
  model: string,
  signals: LeadSignals,
): StructuredDecisionRequest {
  return Object.freeze({
    model,
    state: leadSignalsState(signals),
    questions: LEAD_INTELLIGENCE_QUESTIONS,
  });
}

export function parseLeadIntelligence(raw: unknown): DecisionAnswers {
  return parseDecisionAnswers(LEAD_INTELLIGENCE_QUESTIONS, raw);
}
