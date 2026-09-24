// The deterministic fake decision provider (Phase 2D.1). It is NOT Jev and not
// a model: fixed rules over the allowlisted structured input, the same answer
// for the same input every time, no network, no randomness. It exists so the
// DecisionPort, the vector, the policy, the storage and the owner's view can be
// built and tested end to end while no real provider is approved.
//
// Its identity says what it is (kind `fake`), and the owner's screen labels it
// as a simulation.

import type { DecisionPort, DecisionRequest } from "./decisionPort.ts";
import {
  DECISION_VECTOR_VERSION,
  type DecisionInput,
  type DecisionProviderIdentity,
  type DecisionVector,
} from "./decisionVector.ts";

export const FAKE_DECISION_PROVIDER: DecisionProviderIdentity = Object.freeze({
  kind: "fake",
  id: "fake-rules",
  version: "1",
});

type Verdict = Pick<
  DecisionVector,
  "recommendation" | "confidence" | "caution" | "reasonCodes"
>;

/** The rules, first match wins. Each returns stable reason codes only. */
export function fakeVerdict(input: DecisionInput): Verdict {
  const { triage } = input;
  const flags = new Set(triage.flags);
  if (flags.has("possible_crisis") || flags.has("minor")) {
    return {
      recommendation: "needs_edit",
      confidence: 0.9,
      caution: "high",
      reasonCodes: [
        flags.has("possible_crisis") ? "flag_possible_crisis" : "flag_minor",
      ],
    };
  }
  if (input.contactPolicy === "do_not_contact") {
    return {
      recommendation: "reject",
      confidence: 0.8,
      caution: "medium",
      reasonCodes: ["contact_do_not_contact"],
    };
  }
  if (flags.has("spam")) {
    return {
      recommendation: "reject",
      confidence: 0.85,
      caution: "low",
      reasonCodes: ["flag_spam"],
    };
  }
  if (triage.outcome === "out_of_scope" || flags.has("out_of_scope")) {
    return {
      recommendation: "reject",
      confidence: 0.7,
      caution: "low",
      reasonCodes: ["outcome_out_of_scope"],
    };
  }
  if (triage.outcome === "needs_input" || flags.has("unclear")) {
    return {
      recommendation: "needs_edit",
      confidence: 0.65,
      caution: "medium",
      reasonCodes: ["outcome_needs_input"],
    };
  }
  if (
    triage.outcome === "triaged" &&
    (triage.intent === "book_appointment" ||
      triage.intent === "pricing" ||
      triage.intent === "information")
  ) {
    return {
      recommendation: "accept",
      confidence: 0.82,
      caution: triage.priority === "high" ? "medium" : "low",
      reasonCodes: ["triage_complete", `intent_${triage.intent}`],
    };
  }
  return {
    recommendation: "abstain",
    confidence: 0.5,
    caution: "low",
    reasonCodes: ["insufficient_signal"],
  };
}

export function createFakeDecisionProvider(
  options: { readonly now?: () => Date } = {},
): DecisionPort {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    identity: FAKE_DECISION_PROVIDER,
    async evaluate(request: DecisionRequest): Promise<unknown> {
      const vector: DecisionVector = {
        version: DECISION_VECTOR_VERSION,
        mode: "shadow",
        ...fakeVerdict(request.input),
        provider: FAKE_DECISION_PROVIDER,
        inputFingerprint: request.inputFingerprint,
        evaluatedAt: now().toISOString(),
      };
      return vector;
    },
  });
}
