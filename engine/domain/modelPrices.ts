// Model prices — versioned owner data (ADR 0017 §1) — as a narrow, typed owner
// boundary over ops.model_prices.
//
// WHAT A PRICE IS. One immutable version of what one provider charges for one
// model, from a moment on, as an owner read it from a source. The database picks
// the version a run is priced by, at its start: the latest effective one, and
// none at all if that one has expired. Nothing falls back to an older version, so
// a price must be re-confirmed, as a new version, at least yearly. No migration
// ships a price.
//
// RECORDING is an owner act (`npm run ops -- price record`). Replaying the same
// version resolves to it; a different version at the same (provider, model,
// effective_from) is refused (invalid_state), so a correction is a new version
// with a later effective_from. A rate is exact text, parsed by money.ts: more than
// six decimals is refused rather than rounded.
//
// Each act validates before the database and calls exactly one function; the
// database still decides everything, including the bounds checked here.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";
import { parseUsdRate, parseUsdRateMillionths } from "./money.ts";

export interface ModelPriceInput {
  readonly provider: string;
  /** The configured model id, ideally a pinned snapshot. */
  readonly model: string;
  /** USD per one million tokens, as exact decimal text, e.g. "2.50". */
  readonly inputUsdPerMtok: string;
  /** Absent: cached input is billed at the input rate. At most the input rate. */
  readonly cachedInputUsdPerMtok?: string;
  readonly outputUsdPerMtok: string;
  /** Whether reported reasoning tokens are already inside output tokens. */
  readonly reasoningInOutput: boolean;
  /** ISO 8601 with seconds and an explicit offset, e.g. 2026-09-17T00:00:00Z. */
  readonly effectiveFrom: string;
  /** After effectiveFrom, and at most 366 days after it. */
  readonly expiresAt: string;
}

export interface ModelPriceAct {
  /** Where the price was read: 1 to 500 characters, not blank. */
  readonly source: string;
  /** Who recorded it. */
  readonly actor: string;
}

export type ModelPriceStatus = "current" | "expired" | "superseded" | "future";

export interface ModelPriceRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  /** Decimal text as the database stores it, six decimals. */
  readonly inputUsdPerMtok: string;
  readonly cachedInputUsdPerMtok: string | null;
  readonly outputUsdPerMtok: string;
  readonly reasoningInOutput: boolean;
  /** ISO 8601 in UTC, from the database. */
  readonly effectiveFrom: string;
  readonly expiresAt: string;
  readonly source: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /**
   * current: the version a run starting now is priced by. expired: the latest
   * effective version of its model, past expires_at, so that model has no price.
   * future: not yet effective. superseded: an older version.
   */
  readonly status: ModelPriceStatus;
}

/** A list is bounded. */
export const MAX_LISTED_MODEL_PRICES = 500;

const PROVIDER = /^[a-z][a-z0-9_]{0,31}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const MAX_SOURCE_LENGTH = 500;
const EDGE_SPACES = /^ +| +$/g;
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const MAX_VALIDITY_MICROS = 366n * 86_400n * 1_000_000n;
const STATUSES: readonly ModelPriceStatus[] = Object.freeze([
  "current",
  "expired",
  "superseded",
  "future",
]);

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Status is computed by the database at its own now(), with the database's own
// choice of the current version, so the list can never disagree with a start.
const LIST_SQL = `select * from (
  select p.id, p.provider, p.model,
         p.input_usd_per_mtok::text as input_usd_per_mtok,
         p.cached_input_usd_per_mtok::text as cached_input_usd_per_mtok,
         p.output_usd_per_mtok::text as output_usd_per_mtok,
         p.reasoning_in_output,
         ${UTC("p.effective_from")} as effective_from,
         ${UTC("p.expires_at")} as expires_at,
         p.source, p.recorded_by,
         ${UTC("p.recorded_at")} as recorded_at,
         case
           when p.effective_from > now() then 'future'
           when p.id = ops.current_model_price(p.provider, p.model, now()) then 'current'
           when p.expires_at <= now()
                and p.effective_from = (select max(q.effective_from)
                                          from ops.model_prices q
                                         where q.provider = p.provider and q.model = p.model
                                           and q.effective_from <= now()) then 'expired'
           else 'superseded'
         end as status,
         p.effective_from as sort_from
    from ops.model_prices p
) v
 where $1::boolean or v.status <> 'superseded'
 order by v.provider, v.model, v.sort_from desc, v.id
 limit $2`;

interface ModelPriceRecord {
  id: string;
  provider: string;
  model: string;
  input_usd_per_mtok: string;
  cached_input_usd_per_mtok: string | null;
  output_usd_per_mtok: string;
  reasoning_in_output: boolean;
  effective_from: string;
  expires_at: string;
  source: string;
  recorded_by: string;
  recorded_at: string;
  status: string;
}

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * An instant as microseconds since the epoch, or null when the text is not an
 * ISO 8601 instant with seconds and an explicit offset. The offset is required so
 * that no session time zone decides what the owner meant.
 */
export function parseIsoInstantMicros(text: unknown): bigint | null {
  if (typeof text !== "string") return null;
  const match = ISO_INSTANT.exec(text);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const [fraction = "", sign, offsetHours = "0", offsetMinutes = "0"] =
    match.slice(7);
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysIn(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    Number(offsetHours) > 15 ||
    Number(offsetMinutes) > 59
  ) {
    return null;
  }
  const offsetMs =
    (sign === "-" ? -1 : 1) *
    (Number(offsetHours) * 3_600_000 + Number(offsetMinutes) * 60_000);
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second);
  return BigInt(localMs - offsetMs) * 1000n + BigInt(fraction.padEnd(6, "0"));
}

function requireInstant(text: unknown, field: string): bigint {
  const micros = parseIsoInstantMicros(text);
  if (micros === null) {
    throw invalid(
      `${field} must be an ISO 8601 instant with seconds and an offset, such as 2026-09-17T00:00:00Z`,
    );
  }
  return micros;
}

/** The ten positional arguments of ops.record_model_price, validated in the order it refuses. */
function recordParams(input: ModelPriceInput, act: ModelPriceAct): unknown[] {
  if (typeof input.provider !== "string" || !PROVIDER.test(input.provider)) {
    throw invalid("provider is missing or malformed");
  }
  if (typeof input.model !== "string" || !MODEL.test(input.model)) {
    throw invalid("model is missing or malformed");
  }
  const inputRate = parseUsdRate(input.inputUsdPerMtok);
  const outputRate = parseUsdRate(input.outputUsdPerMtok);
  let cachedRate: string | null = null;
  if (
    input.cachedInputUsdPerMtok !== undefined &&
    input.cachedInputUsdPerMtok !== null
  ) {
    cachedRate = parseUsdRate(input.cachedInputUsdPerMtok);
    if (
      parseUsdRateMillionths(input.cachedInputUsdPerMtok) >
      parseUsdRateMillionths(input.inputUsdPerMtok)
    ) {
      throw invalid("the cached input rate is at most the input rate");
    }
  }
  if (typeof input.reasoningInOutput !== "boolean") {
    throw invalid(
      "whether reasoning tokens are inside output tokens must be stated",
    );
  }
  const from = requireInstant(input.effectiveFrom, "effectiveFrom");
  const until = requireInstant(input.expiresAt, "expiresAt");
  if (until <= from || until - from > MAX_VALIDITY_MICROS) {
    throw invalid(
      "a price version expires after it is effective, within 366 days",
    );
  }
  const { source, actor } = act;
  if (
    typeof source !== "string" ||
    !/\S/.test(source) ||
    [...source.replace(EDGE_SPACES, "")].length > MAX_SOURCE_LENGTH
  ) {
    throw invalid(
      `source must be 1 to ${MAX_SOURCE_LENGTH} characters and not blank`,
    );
  }
  if (typeof actor !== "string" || !ACTOR.test(actor)) {
    throw invalid("actor is missing or malformed");
  }
  return [
    input.provider,
    input.model,
    inputRate,
    outputRate,
    input.reasoningInOutput,
    input.effectiveFrom,
    input.expiresAt,
    source,
    actor,
    cachedRate,
  ];
}

/** Records one price version and resolves to its id; the same version again resolves to the same id. */
export async function recordModelPrice(
  tx: TxClient,
  input: ModelPriceInput,
  act: ModelPriceAct,
): Promise<string> {
  const params = recordParams(input, act);
  let id: unknown;
  try {
    const { rows } = await tx.query<{ result: unknown }>(
      "select ops.record_model_price($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result",
      params,
    );
    id = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof id !== "string") {
    throw new Error("the database returned no model price id");
  }
  return id;
}

function toRow(record: ModelPriceRecord): ModelPriceRow {
  if (!STATUSES.includes(record.status as ModelPriceStatus)) {
    throw new Error("ops.model_prices produced a row with an unknown status");
  }
  return {
    id: record.id,
    provider: record.provider,
    model: record.model,
    inputUsdPerMtok: record.input_usd_per_mtok,
    cachedInputUsdPerMtok: record.cached_input_usd_per_mtok,
    outputUsdPerMtok: record.output_usd_per_mtok,
    reasoningInOutput: record.reasoning_in_output,
    effectiveFrom: record.effective_from,
    expiresAt: record.expires_at,
    source: record.source,
    recordedBy: record.recorded_by,
    recordedAt: record.recorded_at,
    status: record.status as ModelPriceStatus,
  };
}

/**
 * Price versions by provider and model, newest first, at most
 * MAX_LISTED_MODEL_PRICES. Current, expired and future versions only, unless
 * `includeHistory` adds the superseded ones.
 */
export async function listModelPrices(
  tx: TxClient,
  options: { readonly includeHistory?: boolean } = {},
): Promise<readonly ModelPriceRow[]> {
  const includeHistory = options.includeHistory ?? false;
  if (typeof includeHistory !== "boolean") {
    throw invalid("includeHistory must be a boolean");
  }
  let records: ModelPriceRecord[];
  try {
    ({ rows: records } = await tx.query<ModelPriceRecord>(LIST_SQL, [
      includeHistory,
      MAX_LISTED_MODEL_PRICES,
    ]));
  } catch (error) {
    throw toDomainError(error);
  }
  return records.map(toRow);
}
