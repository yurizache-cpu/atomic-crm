// Operational health (Phase 2E.2): the overview's exact, tenant-scoped
// operational facts, built by ops.cos_operational_health from authoritative
// rows (jobs, agent runs, shadow decisions, sends, spend), never from
// telemetry, so it stays correct with the observability stack offline.
//
// Counts, times and integer micros only: no id, name, body, draft, prompt,
// answer or error text, and no score, grade or percentage. What needs the
// owner's attention is decided from these concrete states by the screen.

import { z } from "zod";
import {
  CountSchema,
  DottedNameSchema,
  MoneySchema,
  TimestampSchema,
} from "./primitives.ts";
import { AgentRunStatusSchema, OutboundStatusSchema } from "./vocabulary.ts";

/** The smallest samples a median and a 95th percentile are reported from. */
export const LATENCY_MIN_SAMPLES_P50 = 5;
export const LATENCY_MIN_SAMPLES_P95 = 20;

const QUEUE_COUNTS = {
  ready: CountSchema,
  scheduled: CountSchema,
  running: CountSchema,
  // Leased past its lease: the reaper returns it to the queue on its tick.
  expiredLeases: CountSchema,
  succeededInWindow: CountSchema,
  failedInWindow: CountSchema,
};

export const OperationalQueueSchema = z.strictObject({
  ...QUEUE_COUNTS,
  oldestReadyAt: TimestampSchema.nullable(),
});

export const OperationalQueueKindSchema = z.strictObject({
  // An engine job kind (agent_run.execute, ...), or "other".
  kind: DottedNameSchema.max(64),
  ...QUEUE_COUNTS,
});

export const OperationalLatencySchema = z
  .strictObject({
    sampleSize: CountSchema,
    p50Ms: CountSchema.nullable(),
    p95Ms: CountSchema.nullable(),
    minSamplesP50: z.literal(LATENCY_MIN_SAMPLES_P50),
    minSamplesP95: z.literal(LATENCY_MIN_SAMPLES_P95),
  })
  .superRefine((latency, ctx) => {
    // A percentile exists exactly when its sample is large enough.
    if (
      (latency.p50Ms === null) !== latency.sampleSize < latency.minSamplesP50 ||
      (latency.p95Ms === null) !== latency.sampleSize < latency.minSamplesP95 ||
      (latency.p50Ms !== null &&
        latency.p95Ms !== null &&
        latency.p50Ms > latency.p95Ms)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sampleSize"],
        message: "a percentile disagrees with its sample size",
      });
    }
  });

const microsOf = (money: z.infer<typeof MoneySchema>): bigint =>
  BigInt(money.micros);

export const OperationalHealthSchema = z
  .strictObject({
    windowHours: z.literal(24),
    queue: OperationalQueueSchema,
    queueByKind: z.array(OperationalQueueKindSchema),
    agentRuns: z.strictObject({
      inWindowByStatus: z.partialRecord(AgentRunStatusSchema, CountSchema),
      latency: OperationalLatencySchema,
    }),
    decisions: z.strictObject({
      inWindow: z.strictObject({
        completed: CountSchema,
        abstained: CountSchema,
        invalid: CountSchema,
        failed: CountSchema,
        indeterminate: CountSchema,
        refused: CountSchema,
      }),
      pendingNow: CountSchema,
    }),
    outbound: z.strictObject({
      inWindowByStatus: z.partialRecord(OutboundStatusSchema, CountSchema),
    }),
    spend: z.strictObject({
      chargedToday: MoneySchema,
      chargedInWindow: MoneySchema,
      chargedLast7Days: MoneySchema,
      // What running calls hold reserved, already inside the charged amounts.
      reservedInFlight: MoneySchema,
    }),
  })
  .superRefine((health, ctx) => {
    // The per-kind rows add up to the totals, exactly.
    for (const key of Object.keys(
      QUEUE_COUNTS,
    ) as (keyof typeof QUEUE_COUNTS)[]) {
      const sum = health.queueByKind.reduce(
        (total, row) => total + row[key],
        0,
      );
      if (sum !== health.queue[key]) {
        ctx.addIssue({
          code: "custom",
          path: ["queueByKind"],
          message: `the per-kind ${key} does not add up to the total`,
        });
      }
    }
    // Every window sits inside the last 7 days.
    const week = microsOf(health.spend.chargedLast7Days);
    for (const key of [
      "chargedToday",
      "chargedInWindow",
      "reservedInFlight",
    ] as const) {
      if (microsOf(health.spend[key]) > week) {
        ctx.addIssue({
          code: "custom",
          path: ["spend", key],
          message: "a shorter window cannot hold more than the last 7 days",
        });
      }
    }
  });

export type OperationalHealth = z.infer<typeof OperationalHealthSchema>;
export type OperationalQueueKind = z.infer<typeof OperationalQueueKindSchema>;
