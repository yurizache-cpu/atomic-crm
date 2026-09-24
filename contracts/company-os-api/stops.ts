// Execution stops as the browser sees them (docs/PHASE_2C_BRIEF.md §9): only
// stops NAMING the caller's tenant, never a platform stop, and never who
// tripped or cleared one (the raw actor labels are free-form and may hold an
// email). The origin is enough.

import { z } from "zod";
import {
  CURSOR_KINDS,
  DottedNameSchema,
  ENVELOPE_SHAPE,
  NameSchema,
  TimestampSchema,
  UuidSchema,
  cursorSchema,
  envelopedPageSchema,
} from "./primitives.ts";
import { StopOriginSchema, TenantStopScopeSchema } from "./vocabulary.ts";

/**
 * ops.cos_stop: a stop naming the tenant, as `{ id, scope, origin }`. A
 * reference to a platform stop is null wherever it would appear.
 */
export const TenantStopRefSchema = z.strictObject({
  id: UuidSchema,
  scope: TenantStopScopeSchema,
  origin: StopOriginSchema,
});

const ORG_SCOPES: readonly string[] = ["company", "department", "agent"];

export const ExecutionStopSummarySchema = z
  .strictObject({
    id: UuidSchema,
    scope: TenantStopScopeSchema,
    jobKind: DottedNameSchema.nullable(),
    origin: StopOriginSchema,
    target: z
      .strictObject({
        companyId: UuidSchema,
        departmentId: UuidSchema.nullable(),
        agentId: UuidSchema.nullable(),
        name: NameSchema,
      })
      .nullable(),
    trippedAt: TimestampSchema,
    reason: z.string().min(1),
    clearedAt: TimestampSchema.nullable(),
    clearedReason: z.string().min(1).nullable(),
  })
  .superRefine((stop, ctx) => {
    if (ORG_SCOPES.includes(stop.scope) !== (stop.target !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "only a company, department or agent stop names a target",
      });
    }
    if ((stop.scope === "job_kind") !== (stop.jobKind !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["jobKind"],
        message: "only a job_kind stop names a job kind",
      });
    }
    if ((stop.clearedAt === null) !== (stop.clearedReason === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["clearedReason"],
        message: "a stop is cleared with a reason, or not at all",
      });
    }
  });

/** list_stops. */
export const ExecutionStopListSchema = envelopedPageSchema(
  CURSOR_KINDS.stops,
  ExecutionStopSummarySchema,
);

export const StopCursorSchema = cursorSchema(CURSOR_KINDS.stops);

/**
 * The scopes a member may trip (S7.2): never global, never job_kind. The gate
 * refuses both with OS403 whatever the browser sends.
 */
export const TRIP_STOP_SCOPES = [
  "tenant",
  "company",
  "department",
  "agent",
] as const;
export const TripStopScopeSchema = z.enum(TRIP_STOP_SCOPES);

/**
 * The reason every browser trip records: fixed by the server, never sent by
 * the browser, so a stop's free-form reason never comes from a page.
 */
export const MEMBER_TRIP_REASON =
  "owner requested execution stop via Company OS";

/**
 * trip_stop's input: a scope and, except for the tenant, the target it names.
 * The tenant, the actor and the reason are the gate's, never the browser's.
 */
export const TripStopInputSchema = z
  .strictObject({
    p_scope: TripStopScopeSchema,
    p_target_id: UuidSchema.nullable().optional(),
  })
  .refine(
    (input) => (input.p_scope === "tenant") === (input.p_target_id == null),
    {
      path: ["p_target_id"],
      message: "only a tenant stop names no target",
    },
  );

/**
 * trip_stop: the stop that now holds the target. `stopped` when this call
 * recorded it; `already_stopped` when an active stop at the same coordinates
 * already did, whoever tripped it. Nothing is ever cleared.
 */
export const StopTripResultSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  stopId: UuidSchema,
  outcome: z.enum(["stopped", "already_stopped"]),
});

export type TenantStopRef = z.infer<typeof TenantStopRefSchema>;
export type ExecutionStopSummary = z.infer<typeof ExecutionStopSummarySchema>;
export type ExecutionStopList = z.infer<typeof ExecutionStopListSchema>;
export type TripStopScope = z.infer<typeof TripStopScopeSchema>;
export type StopTripResult = z.infer<typeof StopTripResultSchema>;
