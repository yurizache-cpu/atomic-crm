// The commercial funnel (Phase 3B.1): the overview's read-only view of the
// local CRM's opportunities, built by ops.cos_commercial_funnel through the
// one CRM adapter, ops.crm_commercial_funnel (supabase/migrations/
// 20260929130000_commercial_funnel_read_model.sql).
//
// AUTHORITY. The CRM (today the Atomic CRM's public.deals) is the one
// commercial source of truth. This is a projection of it that the browser can
// read and never act on, and nothing here names the Atomic CRM: another CRM
// replaces the adapter, not this contract.
//
// DEFINITIONS, decided by the server and only formatted by the screen:
//   - open: not archived, not lost and not converted;
//   - converted and lost: the CRM's own dated facts. A deal with both is
//     "conflicting" and counts as neither;
//   - closing rate over the window = converted / (converted + lost), both
//     counted over outcomes dated in the same window. There is no rate
//     without that denominator, and never a stage-to-stage ratio of current
//     counts;
//   - stage age: whole days, in the tenant's zone, since the CURRENT stage was
//     entered. Past stage durations were never recorded;
//   - movement: observed from coverageStart on. Nothing earlier is known.
//
// MINIMISED. An opportunity is its CRM reference, stage code, instants,
// states, informed amount and origin. No title, name, contact, contact id,
// email, phone, note, UTM value, campaign, keyword or click id has a key, and
// every object is strict.

import { z } from "zod";
import {
  CountSchema,
  TimestampSchema,
  boundedTextSchema,
} from "./primitives.ts";
import { TimeZoneSchema } from "./agenda.ts";

export const FUNNEL_STATUSES = [
  "available",
  "stages_not_configured",
  "not_configured",
  // The CRM could not be read right now; the rest of the overview stands.
  "unavailable",
] as const;
export const FUNNEL_CONFIGURATION_PROBLEMS = ["missing", "invalid"] as const;
export const NEXT_ACTION_STATES = [
  "none",
  "overdue",
  "today",
  "future",
] as const;
export const OPPORTUNITY_OUTCOMES = ["open", "converted"] as const;
/** How a deal's origin is known: never an invented category. */
export const ORIGIN_KINDS = [
  "recorded",
  "unknown",
  "multiple",
  "withheld",
] as const;
/** The breakdown adds "other": the recorded labels beyond the top ones. */
export const ORIGIN_BREAKDOWN_KINDS = [...ORIGIN_KINDS, "other"] as const;

export const NextActionStateSchema = z.enum(NEXT_ACTION_STATES);
export const OpportunityOutcomeSchema = z.enum(OPPORTUNITY_OUTCOMES);

/** A configured stage code: the CRM's machine identity for a stage. */
export const StageCodeSchema = boundedTextSchema(64);
/** A configured stage or loss-reason label, as the owner typed it. */
export const CrmLabelSchema = boundedTextSchema(80);
/** The CRM's own deal id: shown as "Oportunidade #id", nothing more. */
export const DealRefSchema = z.int().positive();
/** An informed amount, exact as a JSON number, or null. */
export const AmountSchema = z.number().int().nullable();
const ALL_DAYS = z.int().positive();

export const OriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("recorded"),
    // The recorded acquisition source, trimmed; identifier-shaped values
    // arrive as "withheld" instead.
    label: boundedTextSchema(40),
  }),
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("multiple") }),
  z.strictObject({ kind: z.literal("withheld") }),
]);

export const OpportunityCardSchema = z
  .strictObject({
    dealRef: DealRefSchema,
    // null: the deal's stage is not a configured one.
    stage: StageCodeSchema.nullable(),
    stageEnteredAt: TimestampSchema,
    stageAgeDays: CountSchema,
    nextActionAt: TimestampSchema.nullable(),
    nextAction: NextActionStateSchema,
    amount: AmountSchema,
    origin: OriginSchema,
    outcome: OpportunityOutcomeSchema,
  })
  .refine((c) => (c.nextActionAt === null) === (c.nextAction === "none"), {
    message: "a next action is none exactly when it has no instant",
  });

export const FunnelStageSchema = z
  .strictObject({
    code: StageCodeSchema,
    label: CrmLabelSchema,
    position: z.int().positive(),
    converted: z.boolean(),
    total: CountSchema,
    amountTotal: AmountSchema,
    amountCount: CountSchema,
    cards: z.array(OpportunityCardSchema),
  })
  .refine((s) => s.cards.length <= s.total, {
    message: "a stage shows no more cards than its total",
  })
  .refine((s) => s.cards.every((c) => c.stage === s.code), {
    message: "a stage's cards are that stage's deals",
  });

const listOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ total: CountSchema, items: z.array(item) });

export const FunnelMovementSchema = z
  .strictObject({
    dealRef: DealRefSchema,
    entered: z.boolean(),
    // null when the deal entered the funnel, or the stage is not configured.
    fromStage: StageCodeSchema.nullable(),
    toStage: StageCodeSchema.nullable(),
    at: TimestampSchema,
  })
  .refine((m) => !m.entered || m.fromStage === null, {
    message: "an entry has no previous stage",
  });

export const ConvertedOutcomeSchema = z.strictObject({
  dealRef: DealRefSchema,
  at: TimestampSchema,
  amount: AmountSchema,
  origin: OriginSchema,
});

export const LostOutcomeSchema = z.strictObject({
  dealRef: DealRefSchema,
  at: TimestampSchema,
  stage: StageCodeSchema.nullable(),
  reason: CrmLabelSchema.nullable(),
  origin: OriginSchema,
});

export const OriginCountSchema = z
  .strictObject({
    kind: z.enum(ORIGIN_BREAKDOWN_KINDS),
    label: boundedTextSchema(40).nullable(),
    count: z.int().positive(),
  })
  .refine((o) => (o.kind === "recorded") === (o.label !== null), {
    message: "only a recorded origin has a label",
  });

export const AvailableFunnelSchema = z
  .strictObject({
    status: z.literal("available"),
    timezone: TimeZoneSchema,
    timezoneConfigured: z.boolean(),
    today: z.iso.date(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    perStageCap: z.int().positive(),
    stages: z.array(FunnelStageSchema).min(1),
    unconfigured: z.strictObject({
      total: CountSchema,
      cards: z.array(OpportunityCardSchema),
    }),
    summary: z.strictObject({
      active: CountSchema,
      overdue: CountSchema,
      dueToday: CountSchema,
      noNextAction: CountSchema,
      convertedUndated: CountSchema,
      windowDays: ALL_DAYS,
      newDeals: CountSchema,
      converted: CountSchema,
      lost: CountSchema,
      conflicting: CountSchema,
    }),
    attention: z.strictObject({
      cap: z.int().positive(),
      overdue: listOf(OpportunityCardSchema),
      noNextAction: listOf(OpportunityCardSchema),
    }),
    movements: z.strictObject({
      coverageStart: TimestampSchema.nullable(),
      windowDays: ALL_DAYS,
      totalInWindow: CountSchema,
      items: z.array(FunnelMovementSchema),
    }),
    origins: z.strictObject({
      windowDays: ALL_DAYS,
      total: CountSchema,
      items: z.array(OriginCountSchema),
    }),
    outcomes: z.strictObject({
      windowDays: ALL_DAYS,
      cap: z.int().positive(),
      converted: z.strictObject({ items: z.array(ConvertedOutcomeSchema) }),
      lost: z.strictObject({ items: z.array(LostOutcomeSchema) }),
    }),
  })
  .refine((f) => f.stages.every((s, i) => s.position === i + 1), {
    message: "stages arrive in their configured order",
  })
  .refine((f) => f.stages.every((s) => s.cards.length <= f.perStageCap), {
    message: "no stage shows more than the per-stage cap",
  })
  .refine(
    (f) =>
      f.attention.overdue.total === f.summary.overdue &&
      f.attention.noNextAction.total === f.summary.noNextAction,
    { message: "the attention totals are the summary's counts" },
  )
  .refine(
    (f) =>
      f.origins.items.reduce((sum, o) => sum + o.count, 0) === f.origins.total,
    { message: "the origin breakdown adds up to its total" },
  );

export const CommercialFunnelSchema = z.union([
  AvailableFunnelSchema,
  z.strictObject({
    status: z.literal("stages_not_configured"),
    reason: z.enum(FUNNEL_CONFIGURATION_PROBLEMS),
  }),
  z.strictObject({ status: z.literal("not_configured") }),
  z.strictObject({ status: z.literal("unavailable") }),
]);

export type CommercialFunnel = z.infer<typeof CommercialFunnelSchema>;
export type AvailableFunnel = z.infer<typeof AvailableFunnelSchema>;
export type FunnelStage = z.infer<typeof FunnelStageSchema>;
export type OpportunityCard = z.infer<typeof OpportunityCardSchema>;
export type FunnelMovement = z.infer<typeof FunnelMovementSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type OriginCount = z.infer<typeof OriginCountSchema>;
export type ConvertedOutcome = z.infer<typeof ConvertedOutcomeSchema>;
export type LostOutcome = z.infer<typeof LostOutcomeSchema>;
