// Reviews and the one content exception (docs/PHASE_2C_BRIEF.md §9, §13 item 3;
// the SI-52 amendment).
//
// A summary and a detail carry no field of the model's proposal and no reviewer
// label. The advice is a separate, capability-pinned projection read on
// explicit open: for lead_triage, the classification enums, the summary and the
// recommended next action. It NEVER carries the reply draft: both branches of
// ReviewAdviceSchema are strict, so a `response_draft` (or any other key) makes
// the response fail to parse instead of reaching a screen.

import { z } from "zod";
import {
  CURSOR_KINDS,
  DottedNameSchema,
  ENVELOPE_SHAPE,
  TimestampSchema,
  UuidSchema,
  boundedTextSchema,
  cursorSchema,
  envelopedPageSchema,
  textUpToSchema,
} from "./primitives.ts";
import {
  AdviceWithheldReasonSchema,
  LEAD_TRIAGE_FLAGS,
  LEAD_TRIAGE_INTENTS,
  LEAD_TRIAGE_OUTCOMES,
  LEAD_TRIAGE_PRIORITIES,
  MAX_TRIAGE_FLAGS,
  NEXT_ACTION_MAX_LENGTH,
  OutboundStatusSchema,
  ReviewDecisionSchema,
  ReviewStatusSchema,
  TRIAGE_SUMMARY_MAX_LENGTH,
} from "./vocabulary.ts";

export const REVIEW_SUMMARY_SHAPE = {
  id: UuidSchema,
  taskId: UuidSchema,
  agentRunId: UuidSchema.nullable(),
  capability: DottedNameSchema,
  status: ReviewStatusSchema,
  doNotContact: z.boolean(),
  reviewedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  hasNote: z.boolean(),
  outboundStatus: OutboundStatusSchema.nullable(),
} as const;

export const ReviewSummarySchema = z.strictObject(REVIEW_SUMMARY_SHAPE);

/** list_reviews: pending oldest first, decided newest first. */
export const ReviewListSchema = envelopedPageSchema(
  CURSOR_KINDS.reviews,
  ReviewSummarySchema,
);

/** get_review: the summary, the decision note and the server-computed decisions. */
export const ReviewDetailSchema = z
  .strictObject({
    ...ENVELOPE_SHAPE,
    ...REVIEW_SUMMARY_SHAPE,
    // Stored as the operator typed it: at most 1000 characters, possibly empty.
    decisionNote: textUpToSchema(1000).nullable(),
    allowedDecisions: z.array(ReviewDecisionSchema).max(3),
  })
  .superRefine((review, ctx) => {
    if (review.hasNote !== (review.decisionNote !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["hasNote"],
        message: "hasNote does not match the note",
      });
    }
    const decisions = review.allowedDecisions;
    if (
      new Set(decisions).size !== decisions.length ||
      (review.status !== "pending" && decisions.length > 0) ||
      (review.doNotContact && decisions.includes("accepted"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedDecisions"],
        message:
          "only a pending review has decisions, once each, and a do-not-contact review is never accepted",
      });
    }
  });

/** The lead_triage advice: the classification, the summary and the next action. */
export const LeadTriageAdviceSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  reviewId: UuidSchema,
  capability: z.literal("lead_triage"),
  outcome: z.enum(LEAD_TRIAGE_OUTCOMES),
  intent: z.enum(LEAD_TRIAGE_INTENTS),
  priority: z.enum(LEAD_TRIAGE_PRIORITIES),
  needsHumanReview: z.boolean(),
  flags: z
    .array(z.enum(LEAD_TRIAGE_FLAGS))
    .max(MAX_TRIAGE_FLAGS)
    .refine((flags) => new Set(flags).size === flags.length, {
      message: "a flag appears once",
    }),
  summary: boundedTextSchema(TRIAGE_SUMMARY_MAX_LENGTH),
  recommendedNextAction: boundedTextSchema(NEXT_ACTION_MAX_LENGTH),
});

/** No advice for this review, and why; nothing else about it. */
export const AdviceWithheldSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  reviewId: UuidSchema,
  withheld: AdviceWithheldReasonSchema,
});

/** get_review_advice: the pinned advice, or the withheld answer. */
export const ReviewAdviceSchema = z.union([
  LeadTriageAdviceSchema,
  AdviceWithheldSchema,
]);

export const ReviewCursorSchema = cursorSchema(CURSOR_KINDS.reviews);

export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;
export type ReviewList = z.infer<typeof ReviewListSchema>;
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>;
export type LeadTriageAdvice = z.infer<typeof LeadTriageAdviceSchema>;
export type AdviceWithheld = z.infer<typeof AdviceWithheldSchema>;
export type ReviewAdvice = z.infer<typeof ReviewAdviceSchema>;

/**
 * decide_review (S7.1): the review, the status it now holds, and whether THIS
 * call recorded it (false: the same principal had already recorded the same
 * decision). Strict: no reviewer, note, draft or outbound field, so a response
 * that carried one would fail to parse. Recording a decision sends nothing.
 */
export const ReviewDecisionResultSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  reviewItemId: UuidSchema,
  status: ReviewDecisionSchema,
  recorded: z.boolean(),
});

export type ReviewDecisionResult = z.infer<typeof ReviewDecisionResultSchema>;
