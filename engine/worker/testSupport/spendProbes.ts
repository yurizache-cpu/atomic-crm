// Spend and cost probes for the runtime governance driver suites (ADR 0017):
// what the database says a run reserved, was estimated and was charged, what a
// day's spend is, and the owner acts that tighten or retire a limit.
//
// Everything here runs on the fixture's admin pool, which dbFixture.ts refuses
// to open on any database that is not on this machine. Every act is recorded as
// a `dbtest` actor, so deleteFixtureGovernance and deleteCompanyOsRows remove
// it. Limits are always set in UTC, the zone the fixture's limits use: a new
// version keeps its target's zone.
//
// Money is micro-USD in a Postgres bigint. The driver returns a bigint as text,
// and every value is read back as a JavaScript bigint, so no amount is rounded.

import type { Pool } from "pg";

/** The actor of every limit act these suites record; cleanup keys on `dbtest`. */
export const GOVERNANCE_ACTOR = "dbtest-governance";

export type LimitScope = "global" | "tenant";

const toBigInt = (value: unknown): bigint | null =>
  value === null || value === undefined ? null : BigInt(String(value));

export interface RunCost {
  readonly status: string;
  readonly errorCategory: string | null;
  readonly errorCode: string | null;
  readonly jobId: string | null;
  readonly jobAttempt: number | null;
  readonly stopId: string | null;
  readonly startedAt: Date | null;
  readonly priceId: string | null;
  readonly reserved: bigint | null;
  readonly estimated: bigint | null;
  readonly charged: bigint | null;
  readonly spendLimitId: string | null;
}

/** The governance columns of one run, as the database holds them now. */
export async function readRunCost(
  admin: Pool,
  runId: string,
): Promise<RunCost> {
  const { rows } = await admin.query<Record<string, unknown>>(
    `select status, error_category, error_code, job_id, job_attempt, stop_id,
            started_at, price_id, spend_limit_id,
            reserved_cost_micros::text as reserved,
            estimated_cost_micros::text as estimated,
            charged_cost_micros::text as charged
       from ops.agent_runs where id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) throw new Error("the agent run under test does not exist");
  return {
    status: String(row.status),
    errorCategory: (row.error_category as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    jobId: (row.job_id as string | null) ?? null,
    jobAttempt: (row.job_attempt as number | null) ?? null,
    stopId: (row.stop_id as string | null) ?? null,
    startedAt: (row.started_at as Date | null) ?? null,
    priceId: (row.price_id as string | null) ?? null,
    reserved: toBigInt(row.reserved),
    estimated: toBigInt(row.estimated),
    charged: toBigInt(row.charged),
    spendLimitId: (row.spend_limit_id as string | null) ?? null,
  };
}

/** What a run that never started carries: no price, no reservation, no charge. */
export const UNSTARTED_COST = Object.freeze({
  startedAt: null,
  priceId: null,
  reserved: null,
  estimated: null,
  charged: null,
  jobAttempt: null,
});

/**
 * ops.agent_run_reservation_for, for the run's own tenant, company, task, agent
 * and route, under `priceId`: what a start of that run reserves right now.
 */
export async function reservationFor(
  admin: Pool,
  runId: string,
  priceId: string,
): Promise<bigint> {
  const { rows } = await admin.query<{ micros: string | null }>(
    `select ops.agent_run_reservation_for(
              r.tenant_id, r.company_id, r.task_id, r.agent_id, r.model_route, $2)::text as micros
       from ops.agent_runs r where r.id = $1`,
    [runId, priceId],
  );
  const micros = toBigInt(rows[0]?.micros);
  if (micros === null) {
    throw new Error("the database derived no reservation for the run");
  }
  return micros;
}

/** ops.agent_run_input_token_ceiling of a context, as the claim returned it. */
export async function inputTokenCeiling(
  admin: Pool,
  context: { readonly agent: unknown; readonly task: unknown },
): Promise<number> {
  const { rows } = await admin.query<{ ceiling: number }>(
    "select ops.agent_run_input_token_ceiling($1::jsonb) as ceiling",
    [JSON.stringify({ agent: context.agent, task: context.task })],
  );
  return Number(rows[0].ceiling);
}

/** ops.agent_run_reservation_micros: an input ceiling and an output ceiling under a price. */
export async function reservationMicros(
  admin: Pool,
  priceId: string,
  inputTokens: number,
  maxOutputTokens: number,
): Promise<bigint> {
  const { rows } = await admin.query<{ micros: string }>(
    "select ops.agent_run_reservation_micros($1, $2, $3)::text as micros",
    [priceId, inputTokens, maxOutputTokens],
  );
  return BigInt(rows[0].micros);
}

export interface Usage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
}

/** ops.agent_run_estimated_cost_micros: null when the usage is not a cost. */
export async function estimateFor(
  admin: Pool,
  priceId: string,
  usage: Usage,
): Promise<bigint | null> {
  const { rows } = await admin.query<{ micros: string | null }>(
    "select ops.agent_run_estimated_cost_micros($1, $2, $3, $4, $5, $6)::text as micros",
    [
      priceId,
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.reasoningTokens,
      usage.totalTokens,
    ],
  );
  return toBigInt(rows[0]?.micros);
}

export interface DaySpend {
  /** Everything admission counts: calls in flight at their reservation. */
  readonly charged: bigint;
  /** The part that is no longer running. */
  readonly settled: bigint;
}

/** Today's spend (UTC day) for everyone, or for one tenant. */
export async function todaySpend(
  admin: Pool,
  scope: LimitScope,
  tenantId: string | null = null,
): Promise<DaySpend> {
  const { rows } = await admin.query<{ charged: string; settled: string }>(
    `select t.p_charged::text as charged, t.p_settled::text as settled
       from ops.spend_window_total($1, $2::uuid, null,
                                   ops.spend_window_start('UTC', now())) t`,
    [scope, scope === "global" ? null : tenantId],
  );
  return {
    charged: BigInt(rows[0].charged),
    settled: BigInt(rows[0].settled),
  };
}

/**
 * Today's spend, refusing a day that still has calls in flight: a limit sized
 * from it would otherwise count a reservation this case knows nothing about.
 */
export async function quietSpend(
  admin: Pool,
  scope: LimitScope,
  tenantId: string | null = null,
): Promise<bigint> {
  const spend = await todaySpend(admin, scope, tenantId);
  if (spend.charged !== spend.settled) {
    throw new Error(
      `a ${scope} call is already in flight on this database; the case would prove nothing`,
    );
  }
  return spend.settled;
}

/** Sets a UTC daily limit as GOVERNANCE_ACTOR and resolves to the version in force. */
export async function setDailyLimit(
  admin: Pool,
  scope: LimitScope,
  micros: bigint,
  tenantId: string | null = null,
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `select ops.set_spend_limit($1, $2::bigint, 'UTC', 'dbtest governance limit', $3, $4::uuid) as id`,
    [scope, micros.toString(), GOVERNANCE_ACTOR, tenantId],
  );
  return rows[0].id;
}

/** The limit version in force for a target, or null. */
export async function activeLimitId(
  admin: Pool,
  scope: LimitScope,
  tenantId: string | null = null,
): Promise<string | null> {
  const { rows } = await admin.query<{ id: string }>(
    `select id from ops.spend_limits
      where scope = $1 and tenant_id is not distinct from $2::uuid
        and company_id is null and ended_at is null`,
    [scope, scope === "global" ? null : tenantId],
  );
  return rows[0]?.id ?? null;
}

/** Retires the limit in force for a target, as an owner act, and resolves to its id. */
export async function retireDailyLimit(
  admin: Pool,
  scope: LimitScope,
  tenantId: string | null = null,
): Promise<string> {
  const id = await activeLimitId(admin, scope, tenantId);
  if (id === null) {
    throw new Error(
      `no ${scope} limit is in force; the case would prove nothing`,
    );
  }
  await admin.query(
    "select ops.retire_spend_limit($1, 'dbtest limit withdrawn', $2)",
    [id, GOVERNANCE_ACTOR],
  );
  return id;
}

export interface PriceVersion {
  /** Offsets from now, as Postgres intervals, e.g. "-1 hour". */
  readonly effectiveFrom: string;
  readonly expiresAt: string;
  /** USD per million tokens, as exact decimals. 0.5 each, and no cached rate, by default. */
  readonly inputUsdPerMtok?: string;
  readonly cachedInputUsdPerMtok?: string | null;
  readonly outputUsdPerMtok?: string;
}

/** Records a price version for the fake provider as a `dbtest` actor, which cleanup removes. */
export async function recordPrice(
  admin: Pool,
  model: string,
  version: PriceVersion,
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `select ops.record_model_price('fake', $1, $2::numeric, $3::numeric, true,
              now() + $4::interval, now() + $5::interval,
              'dbtest synthetic price', $6, $7::numeric) as id`,
    [
      model,
      version.inputUsdPerMtok ?? "0.5",
      version.outputUsdPerMtok ?? "0.5",
      version.effectiveFrom,
      version.expiresAt,
      GOVERNANCE_ACTOR,
      version.cachedInputUsdPerMtok ?? null,
    ],
  );
  return rows[0].id;
}

export interface StopRow {
  readonly id: string;
  readonly scope: string;
  readonly origin: string;
  readonly trippedBy: string;
  readonly reason: string;
  readonly active: boolean;
}

/** Every global stop on this database, oldest first. */
export async function globalStops(admin: Pool): Promise<StopRow[]> {
  const { rows } = await admin.query<{
    id: string;
    scope: string;
    origin: string;
    tripped_by: string;
    reason: string;
    active: boolean;
  }>(
    `select id, scope, origin, tripped_by, reason, cleared_at is null as active
       from ops.execution_stops
      where scope = 'global'
      order by tripped_at, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    origin: row.origin,
    trippedBy: row.tripped_by,
    reason: row.reason,
    active: row.active,
  }));
}

/** The global stops the spend ceiling tripped and nobody has cleared. */
export async function activeSystemStops(admin: Pool): Promise<StopRow[]> {
  return (await globalStops(admin)).filter(
    (stop) => stop.active && stop.origin === "system",
  );
}

/** Polls `probe` until it answers true, bounded; a wait that never ends is a failed case. */
export async function waitUntil(
  probe: () => Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`${message} (not seen within ${timeoutMs} ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
