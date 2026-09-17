// The owner's read of agent runs (ADR 0017 §9): ids, statuses, categories,
// codes, token counts and costs. Part of runtimeReadModel.ts, which re-exports it.
//
// NEVER READ HERE: a run's result, its prompt, task or agent text, its
// idempotency key, its correlation id, or its provider request and response ids.
// The column list below is the whole of what leaves the database, and a test pins
// that none of those columns is in it.

import type { TxClient } from "../db/types.ts";
import {
  isAgentRunStatus,
  type AgentRunStatus,
} from "./agentRunStateMachine.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export const MAX_LISTED_RUNS = 200;
export const DEFAULT_LISTED_RUNS = 50;

export interface RuntimeRunRow {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly retryOfRunId: string | null;
  readonly capability: string;
  readonly modelRoute: string;
  readonly status: AgentRunStatus;
  readonly errorCategory: string | null;
  readonly errorCode: string | null;
  /** The provider and model the run was started with. */
  readonly provider: string | null;
  readonly model: string | null;
  /** The model the provider reported; differs from `model` when an alias moved. */
  readonly responseModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly latencyMs: number | null;
  readonly jobAttempt: number | null;
  readonly priceId: string | null;
  /** micro-USD, as exact decimal text. */
  readonly reservedCostMicros: string | null;
  readonly estimatedCostMicros: string | null;
  readonly chargedCostMicros: string | null;
  readonly stopId: string | null;
  readonly spendLimitId: string | null;
  /** ISO 8601 in UTC, from the database. */
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/**
 * indeterminate_not_retried: a call may have happened and nobody has decided
 * whether to retry it. running_without_live_lease: its attempt holds no live
 * lease any more, so the sweep will settle it as indeterminate.
 */
export type RunAttention =
  | "indeterminate_not_retried"
  | "running_without_live_lease";

export interface AttentionRunRow extends RuntimeRunRow {
  readonly attention: RunAttention;
}

export interface RecentRunsOptions {
  readonly tenantId?: string;
  readonly status?: AgentRunStatus;
  /** 1 to MAX_LISTED_RUNS; DEFAULT_LISTED_RUNS when absent. */
  readonly limit?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Every column a run read returns. Nothing else of a run leaves the database. */
export const RUN_COLUMNS = `r.id, r.tenant_id, r.company_id, r.task_id, r.agent_id, r.retry_of_run_id,
       r.capability, r.model_route, r.status, r.error_category, r.error_code,
       r.provider, r.model, r.response_model,
       r.input_tokens, r.output_tokens, r.total_tokens, r.cached_input_tokens, r.reasoning_tokens,
       r.latency_ms, r.job_attempt, r.price_id,
       r.reserved_cost_micros::text as reserved_cost_micros,
       r.estimated_cost_micros::text as estimated_cost_micros,
       r.charged_cost_micros::text as charged_cost_micros,
       r.stop_id, r.spend_limit_id,
       ${UTC("r.created_at")} as created_at,
       ${UTC("r.started_at")} as started_at,
       ${UTC("r.completed_at")} as completed_at`;

// The sweep's own test for a dead attempt (ops.settle_stale_agent_runs), on the
// current clock.
const INDETERMINATE_NOT_RETRIED = `(r.status = 'indeterminate'
       and not exists (select 1 from ops.agent_runs x
                        where x.tenant_id = r.tenant_id and x.retry_of_run_id = r.id))`;
const RUNNING_WITHOUT_LIVE_LEASE = `(r.status = 'running'
       and not exists (select 1 from ops.jobs j
                        where j.tenant_id = r.tenant_id and j.id = r.job_id
                          and j.status = 'leased' and j.lease_expires_at > clock_timestamp()
                          and j.attempts = r.job_attempt))`;

/** Every run an operator should look at, optionally within one tenant ($1). */
export const ATTENTION_WHERE = `($1::uuid is null or r.tenant_id = $1::uuid)
   and (${INDETERMINATE_NOT_RETRIED} or ${RUNNING_WITHOUT_LIVE_LEASE})`;

const RECENT_SQL = `select ${RUN_COLUMNS}
  from ops.agent_runs r
 where ($1::uuid is null or r.tenant_id = $1::uuid)
   and ($2::text is null or r.status = $2::text)
 order by r.created_at desc, r.id
 limit $3`;

const ATTENTION_SQL = `select ${RUN_COLUMNS},
       case when r.status = 'indeterminate' then 'indeterminate_not_retried'
            else 'running_without_live_lease' end as attention
  from ops.agent_runs r
 where ${ATTENTION_WHERE}
 order by r.created_at desc, r.id
 limit $2`;

type Nullable<T> = T | null;

interface RunRecord {
  id: string;
  tenant_id: string;
  company_id: string;
  task_id: string;
  agent_id: string;
  retry_of_run_id: Nullable<string>;
  capability: string;
  model_route: string;
  status: string;
  error_category: Nullable<string>;
  error_code: Nullable<string>;
  provider: Nullable<string>;
  model: Nullable<string>;
  response_model: Nullable<string>;
  input_tokens: Nullable<number>;
  output_tokens: Nullable<number>;
  total_tokens: Nullable<number>;
  cached_input_tokens: Nullable<number>;
  reasoning_tokens: Nullable<number>;
  latency_ms: Nullable<number>;
  job_attempt: Nullable<number>;
  price_id: Nullable<string>;
  reserved_cost_micros: Nullable<string>;
  estimated_cost_micros: Nullable<string>;
  charged_cost_micros: Nullable<string>;
  stop_id: Nullable<string>;
  spend_limit_id: Nullable<string>;
  created_at: string;
  started_at: Nullable<string>;
  completed_at: Nullable<string>;
  attention?: string;
}

export function optionalTenant(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", "tenantId is not a uuid");
  }
  return value;
}

export async function readRows<TRow>(
  tx: TxClient,
  sql: string,
  params: readonly unknown[],
): Promise<TRow[]> {
  try {
    return (await tx.query<TRow>(sql, params)).rows;
  } catch (error) {
    throw toDomainError(error);
  }
}

function toRunRow(record: RunRecord): RuntimeRunRow {
  if (!isAgentRunStatus(record.status)) {
    throw new Error("ops.agent_runs returned a run with an unknown status");
  }
  return {
    id: record.id,
    tenantId: record.tenant_id,
    companyId: record.company_id,
    taskId: record.task_id,
    agentId: record.agent_id,
    retryOfRunId: record.retry_of_run_id,
    capability: record.capability,
    modelRoute: record.model_route,
    status: record.status,
    errorCategory: record.error_category,
    errorCode: record.error_code,
    provider: record.provider,
    model: record.model,
    responseModel: record.response_model,
    inputTokens: record.input_tokens,
    outputTokens: record.output_tokens,
    totalTokens: record.total_tokens,
    cachedInputTokens: record.cached_input_tokens,
    reasoningTokens: record.reasoning_tokens,
    latencyMs: record.latency_ms,
    jobAttempt: record.job_attempt,
    priceId: record.price_id,
    reservedCostMicros: record.reserved_cost_micros,
    estimatedCostMicros: record.estimated_cost_micros,
    chargedCostMicros: record.charged_cost_micros,
    stopId: record.stop_id,
    spendLimitId: record.spend_limit_id,
    createdAt: record.created_at,
    startedAt: record.started_at,
    completedAt: record.completed_at,
  };
}

function requireLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LISTED_RUNS;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LISTED_RUNS
  ) {
    throw new CompanyOsError(
      "invalid_argument",
      `limit must be a whole number from 1 to ${MAX_LISTED_RUNS}`,
    );
  }
  return value;
}

/** The newest runs first, optionally one tenant's or one status's. */
export async function listRecentRuns(
  tx: TxClient,
  options: RecentRunsOptions = {},
): Promise<readonly RuntimeRunRow[]> {
  const tenantId = optionalTenant(options.tenantId);
  const { status } = options;
  if (status !== undefined && !isAgentRunStatus(status)) {
    throw new CompanyOsError(
      "invalid_argument",
      `${String(status)} is not an agent run status`,
    );
  }
  const limit = requireLimit(options.limit);
  const records = await readRows<RunRecord>(tx, RECENT_SQL, [
    tenantId,
    status ?? null,
    limit,
  ]);
  return records.map(toRunRow);
}

/**
 * Runs that need an operator, newest first, at most MAX_LISTED_RUNS: indeterminate
 * runs no later run retries, and running runs whose attempt lost its lease.
 */
export async function listRunsNeedingAttention(
  tx: TxClient,
  options: { readonly tenantId?: string } = {},
): Promise<readonly AttentionRunRow[]> {
  const tenantId = optionalTenant(options.tenantId);
  const records = await readRows<RunRecord>(tx, ATTENTION_SQL, [
    tenantId,
    MAX_LISTED_RUNS,
  ]);
  return records.map((record) => {
    const attention = record.attention;
    if (
      attention !== "indeterminate_not_retried" &&
      attention !== "running_without_live_lease"
    ) {
      throw new Error("a run needing attention came back with no reason");
    }
    return { ...toRunRow(record), attention };
  });
}
