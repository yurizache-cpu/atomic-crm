// Question set `business_routing.v1` (ADR 0022 §E.1): what a demand is, which
// department and capability should handle it, how complex it is, and whether a
// person should look first. SHADOW ONLY in this milestone: it is recorded beside
// the route the deterministic path actually took, and changes nothing.
//
// The options are versioned. A department option exists only for a department
// the tenant actually has, plus `human_review` and `no_action`; nothing here
// invents a department the company does not run. The state carries the
// message with structured identifiers removed (ADR 0020 D8 minimisation), and
// is reached only for synthetic or test data: the Q8 gate refuses the rest
// before any call.

import { redactStructuredIdentifiers } from "../../models/identifierRedaction.ts";
import {
  parseDecisionAnswers,
  type DecisionAnswers,
  type DecisionQuestions,
  type StructuredDecisionRequest,
} from "./types.ts";

export const BUSINESS_ROUTING_VERSION = "business_routing.v1";

/** `business_intents.v1`. Closed; a new intent is a new version. */
export const BUSINESS_INTENTS = Object.freeze({
  new_lead:
    "Someone not yet a client asks about the service for the first time.",
  pricing_question:
    "A question about prices, packages, fees or what is covered.",
  scheduling:
    "Someone wants to book a first appointment or find an available time.",
  rescheduling: "Someone wants to move an appointment that already exists.",
  cancellation: "Someone wants to cancel an appointment or stop the service.",
  existing_client_admin:
    "An existing client's administrative request (documents, receipts, data).",
  payment_question:
    "A question or problem about a payment already made or due.",
  follow_up: "A reply that continues an earlier conversation or follow-up.",
  unknown: "None of the above, or impossible to tell from the message.",
});
export type BusinessIntent = keyof typeof BUSINESS_INTENTS;

/** Descriptions of department slugs the decision may name; unknown slugs get a generic one. */
const DEPARTMENT_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze(
  {
    reception:
      "First contact: new leads, general questions, prices and how sessions work.",
    scheduling: "Booking, moving or cancelling appointments.",
    commercial: "Proposals, packages, negotiation and closing.",
    finance: "Payments, receipts, invoices and refunds.",
    operations: "Internal operations, documents and administrative processes.",
    marketing: "Campaigns, content and acquisition channels.",
    support: "Problems using the service or its tools.",
  },
);
const CAPABILITY_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze(
  {
    lead_triage:
      "Classify an inbound enquiry and prepare an advisory triage for a person to review.",
    task_assessment:
      "Assess an internal task and propose next steps for a person.",
  },
);

const ALWAYS_DEPARTMENTS = Object.freeze({
  human_review: "A person must read this before anyone acts.",
  no_action: "Nothing should be done (spam, a closed conversation, a mistake).",
});

const COMPLEXITY_LEVELS = Object.freeze([
  "Low: a routine question a short, standard answer handles.",
  "Medium: needs some judgement or several pieces of information.",
  "High: ambiguous, sensitive or long; needs careful reasoning or a person.",
]);
export const COMPLEXITY = Object.freeze(["low", "medium", "high"] as const);
export type Complexity = (typeof COMPLEXITY)[number];

/** The longest message the state carries; the decision model reads at most 32k tokens. */
export const MAX_STATE_MESSAGE_CHARS = 4000;

export interface BusinessRoutingInput {
  readonly sourceClass: "synthetic" | "test";
  readonly message: string;
  /** The tenant's active department slugs. */
  readonly departments: readonly string[];
  /** Capabilities this tenant's agents can perform. */
  readonly capabilities: readonly string[];
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function businessRoutingQuestions(
  input: Pick<BusinessRoutingInput, "departments" | "capabilities">,
): DecisionQuestions {
  const departments: Record<string, string> = {};
  for (const slug of input.departments) {
    if (!SLUG.test(slug)) throw new Error("a department slug is malformed");
    departments[slug] =
      DEPARTMENT_DESCRIPTIONS[slug] ?? `The ${slug} department.`;
  }
  Object.assign(departments, ALWAYS_DEPARTMENTS);
  const capabilities: Record<string, string> = {};
  for (const name of input.capabilities) {
    if (!SLUG.test(name)) throw new Error("a capability name is malformed");
    capabilities[name] =
      CAPABILITY_DESCRIPTIONS[name] ?? `The ${name} capability.`;
  }
  capabilities.none = "No automated capability fits; a person handles it.";
  return Object.freeze({
    intent: {
      type: "choice",
      instructions: "What is the person who wrote `message` asking for?",
      criteria: BUSINESS_INTENTS,
    },
    department: {
      type: "choice",
      instructions: "Which department of the clinic should handle `message`?",
      criteria: Object.freeze(departments),
    },
    capability: {
      type: "choice",
      instructions:
        "Which automated capability should process `message` first?",
      criteria: Object.freeze(capabilities),
    },
    complexity: {
      type: "score",
      instructions: "How complex is it to handle `message` well?",
      criteria: COMPLEXITY_LEVELS,
    },
    human_review: {
      type: "noul",
      instructions:
        "Should a person read `message` before any automated reply is prepared?",
      criteria: {
        true: "It is ambiguous, sensitive, urgent, a complaint, or outside what the clinic handles.",
        false: "It is a routine administrative or commercial request.",
      },
    },
  } satisfies DecisionQuestions);
}

export function buildBusinessRoutingRequest(
  model: string,
  input: BusinessRoutingInput,
): StructuredDecisionRequest {
  if (input.sourceClass !== "synthetic" && input.sourceClass !== "test") {
    // Defence in depth: the Q8 gate already refused anything else.
    throw new Error(
      "business routing reaches the decision model for synthetic or test data only",
    );
  }
  const message = redactStructuredIdentifiers(input.message).slice(
    0,
    MAX_STATE_MESSAGE_CHARS,
  );
  return Object.freeze({
    model,
    state: Object.freeze({ source: input.sourceClass, message }),
    questions: businessRoutingQuestions(input),
  });
}

export interface BusinessDecision {
  readonly version: typeof BUSINESS_ROUTING_VERSION;
  readonly intent: BusinessIntent;
  readonly department: string;
  readonly capability: string;
  readonly complexity: Complexity;
  readonly humanReviewProbability: number;
  readonly answers: DecisionAnswers;
}

export function parseBusinessDecision(
  questions: DecisionQuestions,
  raw: unknown,
): BusinessDecision {
  const answers = parseDecisionAnswers(questions, raw);
  const pick = (key: string) => {
    const answer = answers[key];
    if (answer?.type !== "choice")
      throw new Error(`unexpected answer for ${key}`);
    return answer.choice;
  };
  const complexity = answers.complexity;
  const humanReview = answers.human_review;
  if (complexity?.type !== "score" || humanReview?.type !== "noul") {
    throw new Error("unexpected complexity or human review answer");
  }
  return Object.freeze({
    version: BUSINESS_ROUTING_VERSION,
    intent: pick("intent") as BusinessIntent,
    department: pick("department"),
    capability: pick("capability"),
    complexity: COMPLEXITY[complexity.level] ?? "high",
    humanReviewProbability: humanReview.noul,
    answers,
  });
}
