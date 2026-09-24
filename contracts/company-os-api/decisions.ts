// Shadow decisions (Phase 2D.2 and 2D.3): the versioned policy a shadow
// evaluation was made under, and the overview's calibration counts.
//
// ADVISORY ONLY. The calibration section is counts of AGREEMENT between the
// shadow engine's recommendations and human decisions, per policy and provider
// version. A human decision is not ground truth, so nothing here is, or may be
// shown as, an accuracy, a precision or a quality score. It carries no id,
// name, text, input or time: the database builds it from counts
// (ops.cos_decision_intelligence).

import { z } from "zod";
import { CountSchema } from "./primitives.ts";

/** A shadow policy version: fixed meaning, never edited (ops.decision_policies). */
export const ShadowPolicyVersionSchema = z
  .string()
  .regex(/^decision_shadow\.v[0-9]+$/);

const SHADOW_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Who answered: recorded before the provider is asked. */
export const ShadowProviderSchema = z.strictObject({
  kind: z.enum(["fake", "jev", "none"]),
  id: z.string().regex(SHADOW_NAME),
  version: z.string().regex(SHADOW_NAME),
});

/** One policy and provider version's counts; `provider` null: not started. */
export const DecisionIntelligenceGroupSchema = z
  .strictObject({
    policyVersion: ShadowPolicyVersionSchema,
    provider: ShadowProviderSchema.nullable(),
    evaluations: CountSchema,
    recommendations: CountSchema,
    abstained: CountSchema,
    pending: CountSchema,
    indeterminate: CountSchema,
    invalid: CountSchema,
    failed: CountSchema,
    refused: CountSchema,
    withHumanDecision: CountSchema,
    comparable: CountSchema,
    agreements: CountSchema,
    disagreements: CountSchema,
    byRecommendation: z.strictObject({
      accept: CountSchema,
      needs_edit: CountSchema,
      reject: CountSchema,
      abstain: CountSchema,
    }),
    byHumanOutcome: z.strictObject({
      pending: CountSchema,
      accepted: CountSchema,
      rejected: CountSchema,
      needs_edit: CountSchema,
    }),
  })
  .superRefine((group, ctx) => {
    // Agreement is counted only where a recommendation meets a human decision.
    if (
      group.agreements + group.disagreements !== group.comparable ||
      group.comparable > group.recommendations ||
      group.comparable > group.withHumanDecision ||
      group.withHumanDecision > group.evaluations
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["comparable"],
        message:
          "agreements and disagreements are exactly the comparable evaluations",
      });
    }
  });

/** overview.decisionIntelligence: the shadow calibration counts. */
export const DecisionIntelligenceSchema = z.strictObject({
  mode: z.literal("shadow"),
  currentPolicyVersion: ShadowPolicyVersionSchema.nullable(),
  // One group per policy and provider version: small, and unbounded in SQL,
  // so no cap here could fail the whole overview.
  groups: z.array(DecisionIntelligenceGroupSchema),
});

export type DecisionIntelligence = z.infer<typeof DecisionIntelligenceSchema>;
export type DecisionIntelligenceGroup = z.infer<
  typeof DecisionIntelligenceGroupSchema
>;
