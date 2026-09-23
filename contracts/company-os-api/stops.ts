// Execution stops as the browser sees them (docs/PHASE_2C_BRIEF.md §9): only
// stops NAMING the caller's tenant, never a platform stop, and never who
// tripped or cleared one (the raw actor labels are free-form and may hold an
// email). The origin is enough.

import { z } from "zod";
import {
  CURSOR_KINDS,
  DottedNameSchema,
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

export type TenantStopRef = z.infer<typeof TenantStopRefSchema>;
export type ExecutionStopSummary = z.infer<typeof ExecutionStopSummarySchema>;
export type ExecutionStopList = z.infer<typeof ExecutionStopListSchema>;
