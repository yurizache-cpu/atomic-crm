// The caller and the overview (docs/PHASE_2C_BRIEF.md §9).
//
// OperatorContext names the principal by id only: no display name, email or
// membership row. OverviewSummary is counts only; its one platform-derived
// field is `platform.globalAdmissionBlocked` (OD-7); its shadow calibration
// section is aggregate agreement counts only (Phase 2D.3); its operational
// health section is exact, tenant-scoped counts, times and micros from
// authoritative rows, never telemetry (Phase 2E.2).

import { z } from "zod";
import { DecisionIntelligenceSchema } from "./decisions.ts";
import { OperationalHealthSchema } from "./health.ts";
import {
  CountSchema,
  ENVELOPE_SHAPE,
  IdRefSchema,
  TimestampSchema,
  UuidSchema,
} from "./primitives.ts";
import {
  AgentRunStatusSchema,
  OutboundStatusSchema,
  TenantAdmissionSchema,
} from "./vocabulary.ts";

/** operator_context: always the first call. */
export const OperatorContextSchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  principal: IdRefSchema,
  // ops.tenants.name carries no length check, unlike the organisational names.
  tenant: z.strictObject({ id: UuidSchema, name: z.string() }),
  role: z.literal("tenant_operator"),
  dataPolicy: z.literal("synthetic_or_test_only"),
  // Hints only: every refusal comes from SQL. Both browser acts exist (S7.1
  // the review decision, S7.2 the trip), so both are booleans; there is no
  // clear, and no key for one.
  allowedActions: z.strictObject({
    decideReview: z.boolean(),
    tripStop: z.boolean(),
    viewAdvice: z.boolean(),
  }),
  serverTime: TimestampSchema,
});

/** The one platform-derived field a tenant operator sees. */
export const PlatformStateSchema = z.strictObject({
  globalAdmissionBlocked: z.boolean(),
});

/** overview: counts that each link to the list that proves them. */
export const OverviewSummarySchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  agents: z.strictObject({
    total: CountSchema,
    working: CountSchema,
    held: CountSchema,
    queued: CountSchema,
    stale: CountSchema,
    stopped: CountSchema,
    inactive: CountSchema,
  }),
  runs: z.strictObject({
    todayByStatus: z.partialRecord(AgentRunStatusSchema, CountSchema),
    workingNow: CountSchema,
    needingAttention: CountSchema,
  }),
  reviews: z.strictObject({
    pending: CountSchema,
    oldestPendingAt: TimestampSchema.nullable(),
  }),
  stops: z.strictObject({ tenantScopedActive: CountSchema }),
  admission: z.strictObject({ tenantAdmission: TenantAdmissionSchema }),
  outbound: z.strictObject({
    todayByStatus: z.partialRecord(OutboundStatusSchema, CountSchema),
    indeterminateOpen: CountSchema,
    // Accepted reviews with no send recorded: never "awaiting a send" (§7.5).
    acceptedWithoutSend: CountSchema,
  }),
  platform: PlatformStateSchema,
  // Phase 2D.3: shadow calibration, agreement counts only (decisions.ts).
  decisionIntelligence: DecisionIntelligenceSchema,
  // Phase 2E.2: operational health (health.ts).
  operationalHealth: OperationalHealthSchema,
});

export type OperatorContext = z.infer<typeof OperatorContextSchema>;
export type OverviewSummary = z.infer<typeof OverviewSummarySchema>;
