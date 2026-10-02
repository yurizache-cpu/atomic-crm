// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BUSINESS_INTENTS,
  buildBusinessRoutingRequest,
  parseBusinessDecision,
} from "./businessRouting.ts";
import {
  buildLeadIntelligenceRequest,
  LEAD_SIGNAL_FIELDS,
  parseLeadIntelligence,
  type LeadSignals,
} from "./leadIntelligence.ts";
import {
  buildModelRouteRequest,
  inputSizeBucket,
  parseModelRouteAdvice,
  type RouteCandidate,
} from "./modelRouteAdvice.ts";
import { DecisionAnswerError, parseDecisionAnswers } from "./types.ts";

const JEV = "typesafe/jev-1.13";

const businessInput = {
  sourceClass: "synthetic" as const,
  message:
    "Oi, vi seu site e queria saber como funcionam os atendimentos e valores. Meu email e ana@example.com e meu telefone +55 27 99999-1234.",
  departments: ["reception", "marketing", "operations"],
  capabilities: ["lead_triage", "task_assessment"],
};

const businessAnswers = {
  intent: {
    type: "choice",
    choice: "new_lead",
    confidence: 0.8,
    probabilities: { new_lead: 0.85, pricing_question: 0.15 },
  },
  department: {
    type: "choice",
    choice: "reception",
    confidence: 0.9,
    probabilities: { reception: 0.95, human_review: 0.05 },
  },
  capability: { type: "choice", choice: "lead_triage", confidence: 0.9 },
  complexity: {
    type: "score",
    score: 0.2,
    confidence: 0.9,
    probabilities: { "0": 0.8, "1": 0.2, "2": 0 },
  },
  human_review: { type: "noul", noul: 0.1 },
};

describe("business_routing.v1", () => {
  it("offers only the tenant's departments plus human_review and no_action, and removes structured identifiers from the state", () => {
    const request = buildBusinessRoutingRequest(JEV, businessInput);
    expect(request.model).toBe(JEV);
    const department = request.questions.department;
    expect(department.type).toBe("choice");
    expect(Object.keys((department as { criteria: object }).criteria)).toEqual([
      "reception",
      "marketing",
      "operations",
      "human_review",
      "no_action",
    ]);
    expect(
      Object.keys((request.questions.intent as { criteria: object }).criteria),
    ).toEqual(Object.keys(BUSINESS_INTENTS));
    const message = String(request.state.message);
    expect(message).not.toContain("ana@example.com");
    expect(message).not.toContain("99999-1234");
    expect(request.state).toEqual({ source: "synthetic", message });
  });

  it("refuses data that is neither synthetic nor test, before any call", () => {
    expect(() =>
      buildBusinessRoutingRequest(JEV, {
        ...businessInput,
        sourceClass: "health" as never,
      }),
    ).toThrow(/synthetic or test data only/);
  });

  it("parses a complete answer into the typed decision", () => {
    const request = buildBusinessRoutingRequest(JEV, businessInput);
    expect(
      parseBusinessDecision(request.questions, businessAnswers),
    ).toMatchObject({
      version: "business_routing.v1",
      intent: "new_lead",
      department: "reception",
      capability: "lead_triage",
      complexity: "low",
      humanReviewProbability: 0.1,
    });
  });

  it.each([
    [
      "a missing answer",
      { ...businessAnswers, complexity: undefined },
      "missing_answer:complexity",
    ],
    [
      "a department never offered",
      { ...businessAnswers, department: { type: "choice", choice: "finance" } },
      "unknown_option:department",
    ],
    [
      "a wrong answer type",
      { ...businessAnswers, human_review: { type: "choice", choice: "yes" } },
      "unexpected_type:human_review",
    ],
    [
      "a probability out of range",
      { ...businessAnswers, human_review: { type: "noul", noul: 1.2 } },
      "bad_probability:human_review",
    ],
    [
      "a probability for an option never offered",
      {
        ...businessAnswers,
        intent: {
          type: "choice",
          choice: "new_lead",
          probabilities: { diagnosis: 1 },
        },
      },
      "bad_probability:intent",
    ],
    [
      "a score beyond the scale",
      { ...businessAnswers, complexity: { type: "score", score: 3 } },
      "bad_score:complexity",
    ],
  ])("refuses %s rather than defaulting", (_label, answers, code) => {
    const request = buildBusinessRoutingRequest(JEV, businessInput);
    const attempt = () => parseBusinessDecision(request.questions, answers);
    expect(attempt).toThrow(DecisionAnswerError);
    try {
      attempt();
    } catch (error) {
      expect((error as DecisionAnswerError).code).toBe(code);
    }
  });
});

const candidates: readonly RouteCandidate[] = [
  {
    model: "vendor/cheap",
    family: "vendor",
    costClass: "low",
    latencyClass: "fast",
    reasoning: false,
    contextClass: "long",
  },
  {
    model: "other/strong",
    family: "other",
    costClass: "high",
    latencyClass: "slow",
    reasoning: true,
    contextClass: "long",
  },
];

describe("model_route.v1", () => {
  it("offers exactly the authorized candidates and no input content", () => {
    const request = buildModelRouteRequest(JEV, {
      capability: "lead_triage",
      complexity: "low",
      inputSize: inputSizeBucket(900),
      candidates,
    });
    expect(
      Object.keys((request.questions.model as { criteria: object }).criteria),
    ).toEqual(["vendor/cheap", "other/strong"]);
    expect(request.state).toEqual({
      capability: "lead_triage",
      complexity: "low",
      input_size: "small",
      structured_output: "required",
    });
  });

  it("refuses advice naming a model outside the candidates", () => {
    const request = buildModelRouteRequest(JEV, {
      capability: "lead_triage",
      complexity: "unknown",
      inputSize: "small",
      candidates,
    });
    expect(() =>
      parseModelRouteAdvice(request.questions, {
        model: { type: "choice", choice: "evil/unauthorized" },
      }),
    ).toThrow(/unknown_option:model/);
    expect(
      parseModelRouteAdvice(request.questions, {
        model: { type: "choice", choice: "vendor/cheap", confidence: 0.7 },
      }),
    ).toMatchObject({ model: "vendor/cheap", confidence: 0.7 });
  });

  it("needs at least two candidates: one candidate is not a routing question", () => {
    expect(() =>
      buildModelRouteRequest(JEV, {
        capability: "lead_triage",
        complexity: "low",
        inputSize: "small",
        candidates: [candidates[0]],
      }),
    ).toThrow(/2 to 12/);
  });
});

const signals: LeadSignals = {
  intent: "pricing",
  priority: "normal",
  funnel_stage: "none",
  has_open_opportunity: false,
  inbound_messages: 1,
  days_since_first_contact: 0,
  hours_since_last_inbound: 0,
};

describe("lead_intelligence.v1: clinical content is never a commercial signal", () => {
  it("sends exactly the allowlisted operational fields", () => {
    const request = buildLeadIntelligenceRequest(JEV, signals);
    expect(Object.keys(request.state).sort()).toEqual(
      [...LEAD_SIGNAL_FIELDS].sort(),
    );
    expect(JSON.stringify(Object.values(request.state))).not.toMatch(
      /summary|diagnos|medic|suffer|condition/i,
    );
  });

  it.each([
    ["the message", { message: "I have been very depressed" }],
    ["a summary", { summary: "anxious patient" }],
    ["a diagnosis", { diagnosis: "F41.1" }],
  ])("refuses an input that adds %s", (_label, extra) => {
    expect(() =>
      buildLeadIntelligenceRequest(JEV, {
        ...signals,
        ...extra,
      } as unknown as LeadSignals),
    ).toThrow(/exactly the allowlisted operational fields/);
  });

  it("refuses free text smuggled into a closed field", () => {
    expect(() =>
      buildLeadIntelligenceRequest(JEV, {
        ...signals,
        funnel_stage: "patient is suicidal",
      }),
    ).toThrow(/out of range/);
    expect(() =>
      buildLeadIntelligenceRequest(JEV, {
        ...signals,
        intent: "self_harm" as never,
      }),
    ).toThrow(/out of range/);
  });

  it("parses the five answers", () => {
    const answers = parseLeadIntelligence({
      commercial_readiness: {
        type: "score",
        score: 1.2,
        probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
      },
      scheduling_readiness: { type: "score", score: 0.4 },
      follow_up_priority: { type: "score", score: 2 },
      objection: { type: "choice", choice: "price" },
      next_best_action: { type: "choice", choice: "share_pricing_information" },
    });
    expect(answers.commercial_readiness).toMatchObject({
      type: "score",
      level: 1,
    });
    expect(answers.next_best_action).toMatchObject({
      choice: "share_pricing_information",
    });
  });
});

describe("the generic answer parser", () => {
  it("refuses a non-object", () => {
    expect(() => parseDecisionAnswers({}, null)).toThrow(/answers_not_object/);
  });
});
