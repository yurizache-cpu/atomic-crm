// Agent runs (docs/PHASE_2C_BRIEF.md §9): the CLI's RUN_COLUMNS without the
// tenant or the price, and never the result, the prompt, a provider id, an
// idempotency key or a correlation id. A reference to a platform stop or to the
// global limit is null.

import { z } from "zod";
import {
  CURSOR_KINDS,
  CountSchema,
  DottedNameSchema,
  ENVELOPE_SHAPE,
  IdRefSchema,
  MoneySchema,
  TimestampSchema,
  UuidSchema,
  cursorSchema,
  envelopedPageSchema,
} from "./primitives.ts";
import { TenantStopRefSchema } from "./stops.ts";
import {
  AgentRunErrorCategorySchema,
  AgentRunStatusSchema,
  JobFailureClassSchema,
  JobStatusSchema,
  JobStepSchema,
  RunAttentionSchema,
  TenantLimitScopeSchema,
} from "./vocabulary.ts";

const ProviderSchema = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const ModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/);
const TokensSchema = CountSchema.nullable();

const RUN_SUMMARY_SHAPE = {
  id: UuidSchema,
  companyId: UuidSchema,
  taskId: UuidSchema,
  agentId: UuidSchema,
  retryOfRunId: UuidSchema.nullable(),
  capability: DottedNameSchema,
  modelRoute: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  status: AgentRunStatusSchema,
  errorCategory: AgentRunErrorCategorySchema.nullable(),
  errorCode: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.:-]{0,99}$/)
    .nullable(),
  provider: ProviderSchema.nullable(),
  model: ModelSchema.nullable(),
  responseModel: ModelSchema.nullable(),
  inputTokens: TokensSchema,
  outputTokens: TokensSchema,
  totalTokens: TokensSchema,
  cachedInputTokens: TokensSchema,
  reasoningTokens: TokensSchema,
  latencyMs: z.int().min(0).max(86_400_000).nullable(),
  jobAttempt: z.int().positive().nullable(),
  reservedCost: MoneySchema.nullable(),
  estimatedCost: MoneySchema.nullable(),
  chargedCost: MoneySchema.nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  attention: RunAttentionSchema.nullable(),
  stopRef: IdRefSchema.nullable(),
  spendLimitRef: z
    .strictObject({ id: UuidSchema, scope: TenantLimitScopeSchema })
    .nullable(),
} as const;

/** An attention reason belongs to one status only (the CLI's ATTENTION_WHERE). */
const attentionMatchesStatus = (run: {
  status: string;
  attention: string | null;
}): boolean =>
  run.attention === null ||
  (run.attention === "indeterminate_not_retried"
    ? run.status === "indeterminate"
    : run.status === "running");

const ATTENTION_MESSAGE = {
  message: "attention does not match the run's status",
  path: ["attention"],
};

export const AgentRunSummarySchema = z
  .strictObject(RUN_SUMMARY_SHAPE)
  .refine(attentionMatchesStatus, ATTENTION_MESSAGE);

/** list_runs. */
export const AgentRunListSchema = envelopedPageSchema(
  CURSOR_KINDS.runs,
  AgentRunSummarySchema,
);

/** get_run: the summary, the job's liveness, id-free job steps and the covering stop. */
export const AgentRunDetailSchema = z
  .strictObject({
    ...ENVELOPE_SHAPE,
    ...RUN_SUMMARY_SHAPE,
    retriedByRunIds: z.array(UuidSchema),
    job: z
      .strictObject({
        status: JobStatusSchema,
        attempts: CountSchema,
        availableAt: TimestampSchema,
        leaseLive: z.boolean(),
        lastErrorClass: JobFailureClassSchema.nullable(),
      })
      .nullable(),
    // job_events carries a global id and free-form detail; only these leave.
    // `attempt` mirrors a nullable column.
    jobSteps: z.array(
      z.strictObject({
        step: JobStepSchema,
        attempt: z.int().positive().nullable(),
        at: TimestampSchema,
      }),
    ),
    coveringStop: TenantStopRefSchema.nullable(),
  })
  .refine(attentionMatchesStatus, ATTENTION_MESSAGE);

export const RunCursorSchema = cursorSchema(CURSOR_KINDS.runs);

export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>;
export type AgentRunList = z.infer<typeof AgentRunListSchema>;
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>;
