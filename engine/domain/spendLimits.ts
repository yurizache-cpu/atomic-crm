// Spend limits — versioned owner data (ADR 0017 §3) — as a narrow, typed owner
// boundary over ops.spend_limits and ops.spend_status().
//
// WHAT A LIMIT IS. A daily ceiling in micro-USD, counted from local midnight in
// its own IANA time zone, at one of three scopes: `global` (ADR 0010's daily spend
// ceiling), `tenant` (a tenant's daily budget) or `company` (optional, and
// organisation only, never isolation). An agent run starts only when a global
// ceiling AND its tenant's budget exist and every applicable limit absorbs its
// worst-case reservation. Absence refuses; it never means "unlimited".
//
// SETTING a limit supersedes the active version; the same value again changes
// nothing. A new version keeps the time zone: changing the zone is a deliberate
// retire, then set. RETIRING is a recorded act, and a retired global ceiling or
// tenant budget refuses every run it governed until a limit is set again. The
// amount is exact decimal USD text, converted by money.ts; nothing rounds.
//
// Each act validates before the database and calls exactly one function. The
// database decides the rest, including whether a time zone exists.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { formatMicrosAsUsd, parseUsdAmountToMicros } from "./money.ts";

export type SpendLimitScope = "global" | "tenant" | "company";

export const SPEND_LIMIT_SCOPES: readonly SpendLimitScope[] = Object.freeze([
  "global",
  "tenant",
  "company",
]);

export interface SpendLimitTarget {
  readonly scope: SpendLimitScope;
  readonly tenantId?: string;
  readonly companyId?: string;
}

export interface SpendLimitValue {
  /** Exact decimal USD per day, e.g. "25" or "0.50". */
  readonly dailyUsd: string;
  /** An IANA time zone name, e.g. America/Sao_Paulo; the database checks it exists. */
  readonly timezone: string;
}

export interface SpendLimitAct {
  /** Why: 1 to 500 characters, not blank. No personal data. */
  readonly reason: string;
  readonly actor: string;
}

export interface SpendLimitRow {
  readonly id: string;
  readonly scope: SpendLimitScope;
  readonly tenantId: string | null;
  readonly companyId: string | null;
  readonly dailyLimitMicros: string;
  readonly dailyLimitUsd: string;
  readonly timezone: string;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
  readonly endedAt: string | null;
  readonly endedBy: string | null;
  readonly endReason: string | null;
}

/**
 * What one limit does to the next agent run start (ADR 0017 §3), never a promise:
 * - `blocked`: charged spend has reached the limit, so no run with a reservation
 *   above zero is admitted. A run whose reservation settled spend cannot absorb
 *   (settled + reservation > limit) is refused as `budget_exhausted`, even when
 *   `settledExhausted` is false, and on the global ceiling that refusal trips the
 *   ceiling stop. Any other run is contended: its start raises OS429 and its job
 *   retries on its backoff, which may end in admission, in exhaustion, or in job
 *   failure after the last attempt.
 * - `conditional`: a run is admitted by this limit only if its reservation fits
 *   `remainingMicros`. The price, every other applicable limit and the execution
 *   stops still decide whether it starts. It says nothing about a limit that does
 *   not exist: with no global ceiling or tenant budget every run is refused.
 */
export type NewRunAdmission = "blocked" | "conditional";

export const NEW_RUN_ADMISSIONS: readonly NewRunAdmission[] = Object.freeze([
  "blocked",
  "conditional",
]);

export interface SpendStatusRow {
  readonly limitId: string;
  readonly scope: SpendLimitScope;
  readonly tenantId: string | null;
  readonly companyId: string | null;
  readonly timezone: string;
  /** Local midnight of the limit's current day, as a UTC instant. */
  readonly windowStart: string;
  readonly dailyLimitMicros: string;
  /** Everything admission counts, calls in flight at their reservation. */
  readonly chargedMicros: string;
  /** The part of the charge that is no longer running. */
  readonly settledMicros: string;
  readonly estimatedMicros: string;
  /**
   * The largest reservation this limit alone admits now (limit − charged). May be
   * negative: a charge can exceed a limit after admission.
   */
  readonly remainingMicros: string;
  readonly dailyLimitUsd: string;
  readonly chargedUsd: string;
  readonly settledUsd: string;
  readonly estimatedUsd: string;
  readonly remainingUsd: string;
  readonly runningRuns: number;
  /** Settled runs charged without a complete usage estimate. */
  readonly unknownCostRuns: number;
  /** Runs this limit version refused as budget_exhausted today. */
  readonly refusedRuns: number;
  /**
   * Settled spend has reached the limit (settled >= limit). On the global ceiling
   * it is one of the two conditions the ceiling sweep trips on; the other is
   * `refusedRuns` > 0, a budget_exhausted refusal by this version today (ADR 0017
   * §5). False never means a run can start, nor that the sweep will not trip:
   * read `newRunAdmission` and the active stops.
   */
  readonly settledExhausted: boolean;
  readonly newRunAdmission: NewRunAdmission;
}

export interface TenantWithoutBudget {
  readonly tenantId: string;
  readonly slug: string;
}

/** Lists are bounded. */
export const MAX_LISTED_SPEND_LIMITS = 500;
export const MAX_LISTED_TENANTS_WITHOUT_BUDGET = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
// The spend_limits_timezone_format CHECK.
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/;
const MAX_REASON_LENGTH = 500;
const EDGE_SPACES = /^ +| +$/g;

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SCOPE_ORDER = `case l.scope when 'global' then 0 when 'tenant' then 1 else 2 end`;

const LIST_SQL = `select l.id, l.scope, l.tenant_id, l.company_id,
       l.daily_limit_micros::text as daily_limit_micros, l.timezone, l.reason, l.set_by,
       ${UTC("l.set_at")} as set_at,
       ${UTC("l.ended_at")} as ended_at, l.ended_by, l.end_reason
  from ops.spend_limits l
 where $1::boolean or l.ended_at is null
 order by (l.ended_at is not null), ${SCOPE_ORDER}, l.tenant_id, l.company_id, l.set_at desc, l.id
 limit $2`;

const STATUS_SQL = `select s.limit_id, s.scope, s.tenant_id, s.company_id, s.timezone,
       ${UTC("s.window_start")} as window_start,
       s.daily_limit_micros::text as daily_limit_micros,
       s.charged_micros::text as charged_micros,
       s.settled_micros::text as settled_micros,
       s.estimated_micros::text as estimated_micros,
       s.remaining_micros::text as remaining_micros,
       s.running_runs::text as running_runs,
       s.unknown_cost_runs::text as unknown_cost_runs,
       s.refused_runs::text as refused_runs,
       s.settled_exhausted, s.new_run_admission
  from ops.spend_status() s
 where $1::uuid is null or s.scope = 'global' or s.tenant_id = $1::uuid`;

const WITHOUT_BUDGET_SQL = `select t.id as tenant_id, t.slug
  from ops.tenants t
 where not exists (select 1
                     from ops.spend_limits l
                    where l.scope = 'tenant' and l.tenant_id = t.id and l.ended_at is null)
 order by t.slug, t.id
 limit $1`;

interface SpendLimitRecord {
  id: string;
  scope: string;
  tenant_id: string | null;
  company_id: string | null;
  daily_limit_micros: string;
  timezone: string;
  reason: string;
  set_by: string;
  set_at: string;
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
}

interface SpendStatusRecord {
  limit_id: string;
  scope: string;
  tenant_id: string | null;
  company_id: string | null;
  timezone: string;
  window_start: string;
  daily_limit_micros: string;
  charged_micros: string;
  settled_micros: string;
  estimated_micros: string;
  remaining_micros: string;
  running_runs: string;
  unknown_cost_runs: string;
  refused_runs: string;
  settled_exhausted: boolean;
  new_run_admission: string;
}

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

export const isSpendLimitScope = (value: unknown): value is SpendLimitScope =>
  typeof value === "string" &&
  (SPEND_LIMIT_SCOPES as readonly string[]).includes(value);

const isAbsent = (value: unknown): boolean =>
  value === undefined || value === null;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
}

const optionalUuid = (value: unknown, field: string): string | null =>
  isAbsent(value) ? null : requireUuid(value, field);

/** [scope, tenant, company], in ops.set_spend_limit's order of refusal. */
function targetParams(
  target: SpendLimitTarget,
): [SpendLimitScope, string | null, string | null] {
  const { scope } = target;
  if (!isSpendLimitScope(scope)) {
    throw invalid(`${String(scope)} is not a spend limit scope`);
  }
  if (
    scope !== "global" &&
    (isAbsent(target.tenantId) || target.tenantId === "")
  ) {
    throw new CompanyOsError(
      "missing_tenant_scope",
      "a tenant or company limit needs its tenant",
    );
  }
  if (
    (scope === "global" &&
      (!isAbsent(target.tenantId) || !isAbsent(target.companyId))) ||
    (scope === "tenant" && !isAbsent(target.companyId)) ||
    (scope === "company" && isAbsent(target.companyId))
  ) {
    throw invalid(`the target does not match scope ${scope}`);
  }
  return [
    scope,
    optionalUuid(target.tenantId, "tenantId"),
    optionalUuid(target.companyId, "companyId"),
  ];
}

function actParams(act: SpendLimitAct): [string, string] {
  const { reason, actor } = act;
  if (
    typeof reason !== "string" ||
    !/\S/.test(reason) ||
    [...reason.replace(EDGE_SPACES, "")].length > MAX_REASON_LENGTH
  ) {
    throw invalid(
      `reason must be 1 to ${MAX_REASON_LENGTH} characters and not blank`,
    );
  }
  if (typeof actor !== "string" || !ACTOR.test(actor)) {
    throw invalid("actor is missing or malformed");
  }
  return [reason, actor];
}

async function query<TRow>(
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

function requireScope(value: string): SpendLimitScope {
  if (!isSpendLimitScope(value)) {
    throw new Error("ops.spend_limits returned a row with an unknown scope");
  }
  return value;
}

const isNewRunAdmission = (value: string): value is NewRunAdmission =>
  (NEW_RUN_ADMISSIONS as readonly string[]).includes(value);

function requireAdmission(value: string): NewRunAdmission {
  if (!isNewRunAdmission(value)) {
    throw new Error("ops.spend_status returned an unknown new-run admission");
  }
  return value;
}

function toCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("ops.spend_status returned a count that is not a count");
  }
  return count;
}

/** Sets the daily limit of one target and resolves to the version now in force. */
export async function setSpendLimit(
  tx: TxClient,
  target: SpendLimitTarget,
  value: SpendLimitValue,
  act: SpendLimitAct,
): Promise<string> {
  const [scope, tenantId, companyId] = targetParams(target);
  const micros = parseUsdAmountToMicros(value.dailyUsd);
  if (typeof value.timezone !== "string" || !TIMEZONE.test(value.timezone)) {
    throw invalid("timezone is not an IANA time zone name");
  }
  const [reason, actor] = actParams(act);
  const [row] = await query<{ result: unknown }>(
    tx,
    "select ops.set_spend_limit($1, $2::bigint, $3, $4, $5, $6, $7) as result",
    [scope, micros, value.timezone, reason, actor, tenantId, companyId],
  );
  if (typeof row?.result !== "string") {
    throw new Error("the database returned no spend limit id");
  }
  return row.result;
}

/** Ends a limit. True when this act ended it; false when it had already ended. */
export async function retireSpendLimit(
  tx: TxClient,
  limitId: string,
  act: SpendLimitAct,
): Promise<boolean> {
  const id = requireUuid(limitId, "limitId");
  const [reason, actor] = actParams(act);
  const [row] = await query<{ result: unknown }>(
    tx,
    "select ops.retire_spend_limit($1, $2, $3) as result",
    [id, reason, actor],
  );
  if (typeof row?.result !== "boolean") {
    throw new Error("the database returned no retirement outcome");
  }
  return row.result;
}

/** Active limits first, then ended ones when `includeHistory`; at most MAX_LISTED_SPEND_LIMITS. */
export async function listSpendLimits(
  tx: TxClient,
  options: { readonly includeHistory?: boolean } = {},
): Promise<readonly SpendLimitRow[]> {
  const includeHistory = options.includeHistory ?? false;
  if (typeof includeHistory !== "boolean") {
    throw invalid("includeHistory must be a boolean");
  }
  const records = await query<SpendLimitRecord>(tx, LIST_SQL, [
    includeHistory,
    MAX_LISTED_SPEND_LIMITS,
  ]);
  return records.map((record) => ({
    id: record.id,
    scope: requireScope(record.scope),
    tenantId: record.tenant_id,
    companyId: record.company_id,
    dailyLimitMicros: record.daily_limit_micros,
    dailyLimitUsd: formatMicrosAsUsd(record.daily_limit_micros),
    timezone: record.timezone,
    reason: record.reason,
    setBy: record.set_by,
    setAt: record.set_at,
    endedAt: record.ended_at,
    endedBy: record.ended_by,
    endReason: record.end_reason,
  }));
}

/**
 * Today's spend against every active limit, in micro-USD and in USD. With a
 * tenant, only the global ceiling and that tenant's own limits.
 */
export async function readSpendStatus(
  tx: TxClient,
  options: { readonly tenantId?: string } = {},
): Promise<readonly SpendStatusRow[]> {
  const tenantId = optionalUuid(options.tenantId, "tenantId");
  const records = await query<SpendStatusRecord>(tx, STATUS_SQL, [tenantId]);
  return records.map((record) => ({
    limitId: record.limit_id,
    scope: requireScope(record.scope),
    tenantId: record.tenant_id,
    companyId: record.company_id,
    timezone: record.timezone,
    windowStart: record.window_start,
    dailyLimitMicros: record.daily_limit_micros,
    chargedMicros: record.charged_micros,
    settledMicros: record.settled_micros,
    estimatedMicros: record.estimated_micros,
    remainingMicros: record.remaining_micros,
    dailyLimitUsd: formatMicrosAsUsd(record.daily_limit_micros),
    chargedUsd: formatMicrosAsUsd(record.charged_micros),
    settledUsd: formatMicrosAsUsd(record.settled_micros),
    estimatedUsd: formatMicrosAsUsd(record.estimated_micros),
    remainingUsd: formatMicrosAsUsd(record.remaining_micros),
    runningRuns: toCount(record.running_runs),
    unknownCostRuns: toCount(record.unknown_cost_runs),
    refusedRuns: toCount(record.refused_runs),
    settledExhausted: record.settled_exhausted === true,
    newRunAdmission: requireAdmission(record.new_run_admission),
  }));
}

/** Tenants with no active daily budget: every agent run they request is refused. */
export async function listTenantsWithoutBudget(
  tx: TxClient,
): Promise<readonly TenantWithoutBudget[]> {
  const records = await query<{ tenant_id: string; slug: string }>(
    tx,
    WITHOUT_BUDGET_SQL,
    [MAX_LISTED_TENANTS_WITHOUT_BUDGET],
  );
  return records.map((record) => ({
    tenantId: record.tenant_id,
    slug: record.slug,
  }));
}
