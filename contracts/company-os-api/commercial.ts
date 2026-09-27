// The four commercial acts (Phase 3B.2, owner decision R): the browser's only
// way to change the CRM, each its own company_os_api function with fixed
// arguments (supabase/migrations/20260930130000_company_os_commercial_acts.sql;
// the acts themselves, 20260930120000_commercial_opportunity_acts.sql).
//
// The browser names a deal by the reference the funnel showed it, the revision
// it saw, and the act's own input; never a tenant, company, actor,
// salesperson, table, column or operation. Each act locks the deal and refuses
// a stale revision (OS409), so an act never overwrites a newer change; a
// repeat whose result already holds answers "unchanged". None sends a
// message, and none creates, deletes or reopens anything.

import { z } from "zod";
import {
  DealRefSchema,
  LossReasonSchema,
  RevisionSchema,
  StageCodeSchema,
} from "./funnel.ts";
import { ENVELOPE_SHAPE, TimestampSchema } from "./primitives.ts";

/** An absolute instant the browser sends: UTC, with its Z. */
export const AbsoluteInstantSchema = z.iso.datetime();

export const MoveOpportunityInputSchema = z.strictObject({
  p_deal_ref: DealRefSchema,
  p_target_stage: StageCodeSchema,
  p_expected_revision: RevisionSchema,
});

export const SetOpportunityNextActionInputSchema = z.strictObject({
  p_deal_ref: DealRefSchema,
  // null clears the next action.
  p_next_action_at: AbsoluteInstantSchema.nullable(),
  p_expected_revision: RevisionSchema,
});

export const ConvertOpportunityInputSchema = z.strictObject({
  p_deal_ref: DealRefSchema,
  // One of the configured converted stages, always chosen explicitly.
  p_target_stage: StageCodeSchema,
  p_expected_revision: RevisionSchema,
});

export const LoseOpportunityInputSchema = z.strictObject({
  p_deal_ref: DealRefSchema,
  // An active configured loss reason, by its stable code; never free text.
  p_loss_reason: LossReasonSchema.shape.code,
  p_expected_revision: RevisionSchema,
});

/** What the follow-up bridge did, or why it planned nothing. */
export const FOLLOW_UP_OUTCOMES = [
  "unchanged",
  "not_configured",
  "scheduled",
  "not_scheduled",
  "cancelled",
  "none",
] as const;
export const FOLLOW_UP_NOT_SCHEDULED_REASONS = [
  "configuration_invalid",
  "outside_window",
  "existing_plan",
] as const;

export const FollowUpOutcomeSchema = z
  .strictObject({
    status: z.enum(FOLLOW_UP_OUTCOMES),
    reason: z.enum(FOLLOW_UP_NOT_SCHEDULED_REASONS).nullable(),
  })
  .refine((f) => (f.status === "not_scheduled") === (f.reason !== null), {
    message: "a reason is given exactly when nothing could be scheduled",
  });

const ACT_SHAPE = {
  ...ENVELOPE_SHAPE,
  dealRef: DealRefSchema,
  revision: RevisionSchema,
} as const;

export const MoveOpportunityResultSchema = z.strictObject({
  ...ACT_SHAPE,
  outcome: z.enum(["moved", "unchanged"]),
  stage: StageCodeSchema,
});

export const SetOpportunityNextActionResultSchema = z
  .strictObject({
    ...ACT_SHAPE,
    outcome: z.enum(["set", "cleared", "unchanged"]),
    nextActionAt: TimestampSchema.nullable(),
    followUp: FollowUpOutcomeSchema,
  })
  .refine(
    (r) =>
      (r.outcome === "set" && r.nextActionAt !== null) ||
      (r.outcome === "cleared" && r.nextActionAt === null) ||
      r.outcome === "unchanged",
    { message: "a set next action has an instant and a cleared one none" },
  );

export const ConvertOpportunityResultSchema = z.strictObject({
  ...ACT_SHAPE,
  outcome: z.enum(["converted", "unchanged"]),
  stage: StageCodeSchema,
  followUp: FollowUpOutcomeSchema,
});

export const LoseOpportunityResultSchema = z.strictObject({
  ...ACT_SHAPE,
  outcome: z.enum(["lost", "unchanged"]),
  followUp: FollowUpOutcomeSchema,
});

export type FollowUpOutcome = z.infer<typeof FollowUpOutcomeSchema>;
export type MoveOpportunityResult = z.infer<typeof MoveOpportunityResultSchema>;
export type SetOpportunityNextActionResult = z.infer<
  typeof SetOpportunityNextActionResultSchema
>;
export type ConvertOpportunityResult = z.infer<
  typeof ConvertOpportunityResultSchema
>;
export type LoseOpportunityResult = z.infer<typeof LoseOpportunityResultSchema>;
