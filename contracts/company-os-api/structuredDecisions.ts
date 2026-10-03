// ADR 0022: the structured decisions (Jev, shadow only) a review carries,
// read only (get_review's `structuredDecisions`, built by
// ops.cos_review_structured_decisions).
//
// ADVISORY. Recorded beside the route the deterministic path took, they change
// nothing about the review or the decisions a person may make. MINIMISED: the
// chosen options, their levels and confidences, the build that answered, the
// charged cost and the instants; never the question spec, the input
// fingerprint, the raw answers or a probability map. Every object is strict,
// so a projection that grew any of those fails to parse instead of reaching a
// screen.
//
// The option lists are the question sets' own (engine/decision/structured/),
// version 1; engine/domain/companyOsContracts.test.ts holds them equal, so a
// new option is a new question-set version here too.

import { z } from "zod";
import {
  DottedNameSchema,
  MoneySchema,
  NameSchema,
  ReasonCodeSchema,
  TimestampSchema,
} from "./primitives.ts";

/** business_intents.v1 (business_routing.v1's intent options). */
export const STRUCTURED_BUSINESS_INTENTS = [
  "new_lead",
  "pricing_question",
  "scheduling",
  "rescheduling",
  "cancellation",
  "existing_client_admin",
  "payment_question",
  "follow_up",
  "unknown",
] as const;

/** lead_intelligence.v1's objection options. */
export const STRUCTURED_OBJECTIONS = [
  "price",
  "schedule",
  "modality",
  "trust_or_fit",
  "none",
  "unknown",
] as const;

/** lead_intelligence.v1's next-best-action options. */
export const STRUCTURED_NEXT_ACTIONS = [
  "offer_slots",
  "share_pricing_information",
  "answer_question",
  "follow_up_later",
  "human_review",
] as const;

export const STRUCTURED_DECISION_STATUSES = [
  "pending",
  "completed",
  "indeterminate",
  "invalid",
  "failed",
  "refused",
] as const;

export const STRUCTURED_DECISION_REFUSALS = [
  "stopped",
  "not_eligible",
  "data_not_authorized",
  "model_route_unavailable",
  "spend_ceiling_unconfigured",
  "budget_unconfigured",
  "budget_exhausted",
] as const;

const LevelSchema = z.enum(["low", "medium", "high"]);
const ProbabilitySchema = z.number().finite().min(0).max(1);
const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/);

/**
 * A department the decision names: its slug, and the name its company gives
 * it (null for `human_review`, `no_action` or a slug no department carries).
 */
const DepartmentRefSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: NameSchema.nullable(),
});

const BusinessRouteAnswerSchema = z.strictObject({
  intent: z.enum(STRUCTURED_BUSINESS_INTENTS),
  intentConfidence: ProbabilitySchema.nullable(),
  department: DepartmentRefSchema,
  departmentConfidence: ProbabilitySchema.nullable(),
  capability: DottedNameSchema,
  capabilityConfidence: ProbabilitySchema.nullable(),
  complexity: LevelSchema.nullable(),
  humanReviewProbability: ProbabilitySchema,
});

const LeadIntelligenceAnswerSchema = z.strictObject({
  commercialReadiness: LevelSchema.nullable(),
  schedulingReadiness: LevelSchema.nullable(),
  followUpPriority: LevelSchema.nullable(),
  objection: z.enum(STRUCTURED_OBJECTIONS),
  nextBestAction: z.enum(STRUCTURED_NEXT_ACTIONS),
});

const ModelRouteAnswerSchema = z.strictObject({
  suggestedModel: ModelIdSchema,
  confidence: ProbabilitySchema.nullable(),
});

/** The fields every kind shares. */
const DECISION_SHAPE = {
  status: z.enum(STRUCTURED_DECISION_STATUSES),
  refusal: z.enum(STRUCTURED_DECISION_REFUSALS).nullable(),
  errorCode: ReasonCodeSchema.nullable(),
  /** The exact build that answered; null until a model answered. */
  decisionModel: ModelIdSchema.nullable(),
  chargedCost: MoneySchema.nullable(),
  requestedAt: TimestampSchema,
  settledAt: TimestampSchema.nullable(),
} as const;

/** The state rules every kind obeys. */
const checkDecisionState = (
  decision: {
    status: (typeof STRUCTURED_DECISION_STATUSES)[number];
    refusal: unknown;
    decisionModel: unknown;
    settledAt: unknown;
    answer: unknown;
  },
  ctx: z.RefinementCtx,
): void => {
  const completed = decision.status === "completed";
  const refused = decision.status === "refused";
  const settled = decision.status !== "pending";
  if (
    completed !== (decision.answer !== null) ||
    refused !== (decision.refusal !== null) ||
    settled !== (decision.settledAt !== null) ||
    (completed && decision.decisionModel === null)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message:
        "only a completed decision answers (and names its build), only a refused one has a refusal, and only a settled one has an end",
    });
  }
};

const BusinessRouteDecisionSchema = z
  .strictObject({
    ...DECISION_SHAPE,
    questionSet: z.literal("business_routing.v1"),
    routeTaken: z.strictObject({
      department: DepartmentRefSchema.nullable(),
      capability: DottedNameSchema.nullable(),
    }),
    answer: BusinessRouteAnswerSchema.nullable(),
  })
  .superRefine(checkDecisionState);

const LeadIntelligenceDecisionSchema = z
  .strictObject({
    ...DECISION_SHAPE,
    questionSet: z.literal("lead_intelligence.v1"),
    routeTaken: z.null(),
    answer: LeadIntelligenceAnswerSchema.nullable(),
  })
  .superRefine(checkDecisionState);

const ModelRouteDecisionSchema = z
  .strictObject({
    ...DECISION_SHAPE,
    questionSet: z.literal("model_route.v1"),
    routeTaken: z.strictObject({ model: ModelIdSchema.nullable() }),
    answer: ModelRouteAnswerSchema.nullable(),
  })
  .superRefine(checkDecisionState);

/**
 * `unavailable`: out of the synthetic and test scope (BASELINE Q8), as for the
 * Phase 2D shadow decision. `available`: each kind recorded, or null when none
 * was requested for this review.
 */
export const ReviewStructuredDecisionsSchema = z.union([
  z.strictObject({ status: z.literal("unavailable") }),
  z.strictObject({
    status: z.literal("available"),
    businessRoute: BusinessRouteDecisionSchema.nullable(),
    leadIntelligence: LeadIntelligenceDecisionSchema.nullable(),
    modelRoute: ModelRouteDecisionSchema.nullable(),
  }),
]);

export type ReviewStructuredDecisions = z.infer<
  typeof ReviewStructuredDecisionsSchema
>;
export type AvailableStructuredDecisions = Extract<
  ReviewStructuredDecisions,
  { status: "available" }
>;
export type BusinessRouteDecision = z.infer<typeof BusinessRouteDecisionSchema>;
export type LeadIntelligenceDecision = z.infer<
  typeof LeadIntelligenceDecisionSchema
>;
export type ModelRouteDecision = z.infer<typeof ModelRouteDecisionSchema>;
export type StructuredDecisionStatus =
  (typeof STRUCTURED_DECISION_STATUSES)[number];
export type StructuredDecisionRefusal =
  (typeof STRUCTURED_DECISION_REFUSALS)[number];
