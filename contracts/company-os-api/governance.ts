// Spend and communication status (docs/PHASE_2C_BRIEF.md §9): the tenant's own
// rows and counts, all arithmetic done in SQL.
//
// SpendSummary never carries the global ceiling, global spend, another
// tenant's limit or a price row; the global row feeds only
// `platform.globalAdmissionBlocked`. CommunicationStatusSummary is labels and
// counts: no provider target, contact, conversation id, body, draft or
// individual send.

import { z } from "zod";
import {
  ChannelLabelSchema,
  CountSchema,
  ENVELOPE_SHAPE,
  MoneySchema,
  NamedRefSchema,
  ReasonCodeSchema,
  TimestampSchema,
  UuidSchema,
} from "./primitives.ts";
import { PlatformStateSchema } from "./context.ts";
import {
  ChannelModeSchema,
  OutboundStatusSchema,
  SpendAdmissionSchema,
  TenantLimitScopeSchema,
} from "./vocabulary.ts";

export const TenantSpendRowSchema = z
  .strictObject({
    scope: TenantLimitScopeSchema,
    companyId: UuidSchema.nullable(),
    timezone: z.string().regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/),
    dailyLimit: MoneySchema,
    charged: MoneySchema,
    settled: MoneySchema,
    estimated: MoneySchema,
    // A limit minus what it has charged: negative once in-flight reservations overrun it.
    remaining: MoneySchema,
    runningRuns: CountSchema,
    unknownCostRuns: CountSchema,
    refusedRuns: CountSchema,
    settledExhausted: z.boolean(),
    newRunAdmission: SpendAdmissionSchema,
  })
  .refine((row) => (row.scope === "tenant") === (row.companyId === null), {
    message: "only a company budget names a company",
    path: ["companyId"],
  });

/** spend_summary. */
export const SpendSummarySchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  windowStart: TimestampSchema,
  tenantRows: z.array(TenantSpendRowSchema),
  today: z.strictObject({
    byAgent: z.array(
      z.strictObject({
        agent: NamedRefSchema,
        runs: CountSchema,
        charged: MoneySchema,
      }),
    ),
    byModel: z.array(
      z.strictObject({
        provider: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
        model: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
          .nullable(),
        runs: CountSchema,
        charged: MoneySchema,
      }),
    ),
  }),
  platform: PlatformStateSchema,
});

/** The fixed note of the optional Communications view (SI-53). */
export const UNROUTED_DELIVERIES_NOTE = "Unrouted deliveries are never stored.";

/** communication_status (optional, OD-9). */
export const CommunicationStatusSummarySchema = z.strictObject({
  ...ENVELOPE_SHAPE,
  channels: z.array(
    z.strictObject({
      id: UuidSchema,
      label: ChannelLabelSchema,
      mode: ChannelModeSchema,
      active: z.boolean(),
      agent: NamedRefSchema,
      updatedAt: TimestampSchema,
    }),
  ),
  inbound: z.strictObject({
    admittedToday: CountSchema,
    refusedTodayByReason: z.record(ReasonCodeSchema, CountSchema),
  }),
  conversationsActive24h: CountSchema,
  outbound: z.strictObject({
    byStatus: z.partialRecord(OutboundStatusSchema, CountSchema),
    blockedByReason: z.record(ReasonCodeSchema, CountSchema),
    indeterminateOpen: CountSchema,
    acceptedWithoutSend: CountSchema,
  }),
  note: z.literal(UNROUTED_DELIVERIES_NOTE),
});

export type TenantSpendRow = z.infer<typeof TenantSpendRowSchema>;
export type SpendSummary = z.infer<typeof SpendSummarySchema>;
export type CommunicationStatusSummary = z.infer<
  typeof CommunicationStatusSummarySchema
>;
