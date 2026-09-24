import { describe, expect, it } from "vitest";

import {
  DecisionInputSchema,
  DecisionVectorSchema,
  type DecisionVector,
} from "./decisionVector.ts";

// The strict DecisionVector and DecisionInput contracts (Phase 2D.1): a
// provider's answer is refused, never coerced, when anything about it is off.

const VECTOR: DecisionVector = {
  version: "decision_vector.v1",
  mode: "shadow",
  recommendation: "accept",
  confidence: 0.82,
  caution: "low",
  reasonCodes: ["triage_complete", "intent_information"],
  provider: { kind: "fake", id: "fake-rules", version: "1" },
  inputFingerprint: `sha256:${"a".repeat(64)}`,
  evaluatedAt: "2026-09-24T12:00:00.000Z",
};

const INPUT = {
  version: "decision_input.v1",
  subject: "lead_triage.review",
  sourceClass: "synthetic",
  contactPolicy: "contactable",
  triage: {
    outcome: "triaged",
    intent: "information",
    priority: "normal",
    flags: [],
    needsHumanReview: true,
  },
};

describe("DecisionVectorSchema", () => {
  it("accepts a complete vector, at both ends of the confidence range", () => {
    expect(DecisionVectorSchema.safeParse(VECTOR).success).toBe(true);
    for (const confidence of [0, 1]) {
      expect(
        DecisionVectorSchema.safeParse({ ...VECTOR, confidence }).success,
      ).toBe(true);
    }
  });

  it.each([
    ["an unknown recommendation", { recommendation: "approve" }],
    ["confidence below 0", { confidence: -0.01 }],
    ["confidence above 1", { confidence: 1.01 }],
    ["NaN confidence", { confidence: Number.NaN }],
    ["infinite confidence", { confidence: Number.POSITIVE_INFINITY }],
    ["confidence as text", { confidence: "0.9" }],
    ["an unknown schema version", { version: "decision_vector.v2" }],
    ["a mode other than shadow", { mode: "enforce" }],
    ["an unknown caution level", { caution: "extreme" }],
    ["a malformed reason code", { reasonCodes: ["Because I said so"] }],
    ["no reason code", { reasonCodes: [] }],
    ["a repeated reason code", { reasonCodes: ["flag_spam", "flag_spam"] }],
    [
      "nine reason codes",
      { reasonCodes: [..."abcdefghi"].map((c) => `r_${c}`) },
    ],
    ["a malformed fingerprint", { inputFingerprint: "sha256:xyz" }],
    ["a malformed timestamp", { evaluatedAt: "yesterday" }],
    [
      "an unknown provider kind",
      { provider: { ...VECTOR.provider, kind: "gpt" } },
    ],
    ["an extra provider field", { provider: { ...VECTOR.provider, url: "x" } }],
    ["prose reasoning", { reasoning: "step by step, the lead seems fine" }],
  ])("refuses %s", (_label, change) => {
    expect(
      DecisionVectorSchema.safeParse({ ...VECTOR, ...change }).success,
    ).toBe(false);
  });

  it("refuses a vector missing any required field", () => {
    for (const key of Object.keys(VECTOR)) {
      const partial: Record<string, unknown> = { ...VECTOR };
      delete partial[key];
      expect(DecisionVectorSchema.safeParse(partial).success, key).toBe(false);
    }
  });
});

describe("DecisionInputSchema", () => {
  it("accepts the allowlisted structured input, nulls included", () => {
    expect(DecisionInputSchema.safeParse(INPUT).success).toBe(true);
    expect(
      DecisionInputSchema.safeParse({
        ...INPUT,
        triage: {
          ...INPUT.triage,
          outcome: null,
          intent: null,
          needsHumanReview: null,
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    ["a message body", { body: "Oi, quero marcar" }],
    ["a phone number", { contactRef: "+5511999999999" }],
    ["an email", { email: "lead@example.test" }],
    ["a reply draft", { responseDraft: "Olá!" }],
    ["a review id", { reviewItemId: "00000000-0000-4000-8000-000000000001" }],
  ])("refuses an input carrying %s", (_label, extra) => {
    expect(DecisionInputSchema.safeParse({ ...INPUT, ...extra }).success).toBe(
      false,
    );
  });

  it("refuses free text inside the triage block and values outside the vocabulary", () => {
    for (const triage of [
      { ...INPUT.triage, summary: "New enquiry about a first session" },
      { ...INPUT.triage, intent: "therapy_for_depression" },
      { ...INPUT.triage, flags: ["self_harm"] },
    ]) {
      expect(DecisionInputSchema.safeParse({ ...INPUT, triage }).success).toBe(
        false,
      );
    }
  });
});
