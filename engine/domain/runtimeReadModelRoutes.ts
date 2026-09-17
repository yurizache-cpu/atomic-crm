// The owner's read of the model routes the most recently seen workers published,
// stopped ones included (ADR 0017 §9).
// Part of runtimeReadModel.ts, which re-exports it.
//
// The operator never reads routing or provider variables from its own
// environment. It reads what each worker wrote into its heartbeat detail
// (engine/models/routeSummary.ts), and asks the database, per published route:
// whether a current price exists for its provider and model, the database's own
// output ceiling for the route and whether the worker agrees with it, and the
// smallest and largest reservation a run on that route can make under that price,
// with its text within the CHECK bounds (WORST_CASE_CONTEXT). The largest is the
// figure the global ceiling should be sized against: it should comfortably exceed
// (worker processes + 1) times it (ADR 0017 §5).
//
// A detail is shown only through parseWorkerDetail, which refuses any shape but
// its own, and a route whose model id looks like a provider key withholds the
// whole detail: a key pasted into the wrong variable is never printed.

import type { TxClient } from "../db/types.ts";
import {
  parseWorkerDetail,
  type RouteSummaryEntry,
} from "../models/routeSummary.ts";
import { formatMicrosAsUsd } from "./money.ts";
import { readRows } from "./runtimeReadModelRuns.ts";

export const MAX_LISTED_WORKERS = 50;

export interface PublishedRouteView extends RouteSummaryEntry {
  /** The version ops.current_model_price chooses now, or null: runs on it are refused. */
  readonly priceId: string | null;
  readonly priced: boolean;
  /** ops.agent_run_route_policies(); null for a route the database does not know. */
  readonly databaseMaxOutputTokens: number | null;
  /** False: every start on this route is refused as route_policy_mismatch. */
  readonly matchesDatabase: boolean;
  /** micro-USD under the current price, as exact text; null when unpriced. */
  readonly smallestReservationMicros: string | null;
  readonly largestReservationMicros: string | null;
  readonly smallestReservationUsd: string | null;
  readonly largestReservationUsd: string | null;
}

/**
 * published: the routes below. absent: the worker wrote no detail. unreadable: a
 * detail that is not this version's shape. withheld: a detail naming something
 * that looks like a provider key.
 */
export type WorkerDetailState =
  | "published"
  | "absent"
  | "unreadable"
  | "withheld";

export interface WorkerRoutesRow {
  readonly workerId: string;
  readonly lastSeenAt: string;
  readonly stoppedAt: string | null;
  readonly detail: WorkerDetailState;
  readonly state: string | null;
  readonly routes: readonly PublishedRouteView[] | null;
}

const UTC = (column: string): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// A provider key starts with `sk-` (OpenAI's shape, and others'). No model id or
// worker id does; one that seems to is withheld rather than printed.
const KEY_LIKE = /(?:^|[^A-Za-z0-9])sk-/i;
const WITHHELD_WORKER_ID = "[withheld]";

const WORKERS_SQL = `select w.worker_id,
       ${UTC("w.last_seen_at")} as last_seen_at,
       ${UTC("w.stopped_at")} as stopped_at,
       w.detail
  from ops.worker_instances w
 order by w.last_seen_at desc, w.worker_id
 limit $1`;

// The worst-case context a run can hand a model: every text field at its
// character bound, made of a character JSON escapes to six bytes. It is the
// largest reservation only for text within those bounds: the name, role and
// title CHECKs measure btrim(), which trims spaces, so a value padded with edge
// spaces is longer, and a run carrying one reserves more (its own start computes
// the reservation from its real rows, so the budget still holds).
const WORST_CASE_CONTEXT = `jsonb_build_object(
         'agent', jsonb_build_object('name', repeat(chr(1), 200), 'role', repeat(chr(1), 200),
                                     'description', repeat(chr(1), 2000)),
         'task', jsonb_build_object('type', repeat('a', 100), 'title', repeat(chr(1), 300),
                                    'description', repeat(chr(1), 10000),
                                    'priority', 1000, 'due_at', now()))`;

export const ROUTE_PRICING_SQL = `select p.ord::int as ord,
       price.id as price_id,
       pol.max_output_tokens,
       ops.agent_run_reservation_micros(price.id, ops.agent_run_input_token_ceiling('{}'::jsonb),
                                        pol.max_output_tokens)::text as smallest_reservation_micros,
       ops.agent_run_reservation_micros(price.id, ops.agent_run_input_token_ceiling(${WORST_CASE_CONTEXT}),
                                        pol.max_output_tokens)::text as largest_reservation_micros
  from unnest($1::text[], $2::text[], $3::text[]) with ordinality as p(route, provider, model, ord)
  left join lateral (select ops.current_model_price(p.provider, p.model, now()) as id) price on true
  left join ops.agent_run_route_policies() pol on pol.model_route = p.route
 order by p.ord`;

interface WorkerRecord {
  worker_id: string;
  last_seen_at: string;
  stopped_at: string | null;
  detail: string | null;
}

interface RoutePricingRecord {
  ord: number;
  price_id: string | null;
  max_output_tokens: number | null;
  smallest_reservation_micros: string | null;
  largest_reservation_micros: string | null;
}

interface ParsedWorker {
  readonly record: WorkerRecord;
  readonly detail: WorkerDetailState;
  readonly state: string | null;
  readonly routes: readonly RouteSummaryEntry[] | null;
}

const routeKey = (entry: RouteSummaryEntry): string =>
  `${entry.route}|${entry.provider}|${entry.model}`;

function parseWorker(record: WorkerRecord): ParsedWorker {
  if (record.detail === null || record.detail === undefined) {
    return { record, detail: "absent", state: null, routes: null };
  }
  const parsed = parseWorkerDetail(record.detail);
  if (parsed === null) {
    return { record, detail: "unreadable", state: null, routes: null };
  }
  if (parsed.routes.some((entry) => KEY_LIKE.test(entry.model))) {
    return { record, detail: "withheld", state: null, routes: null };
  }
  return {
    record,
    detail: "published",
    state: parsed.state,
    routes: parsed.routes,
  };
}

const usdOrNull = (micros: string | null): string | null =>
  micros === null ? null : formatMicrosAsUsd(micros);

async function priceRoutes(
  tx: TxClient,
  entries: readonly RouteSummaryEntry[],
): Promise<ReadonlyMap<string, RoutePricingRecord>> {
  if (entries.length === 0) return new Map();
  const records = await readRows<RoutePricingRecord>(tx, ROUTE_PRICING_SQL, [
    entries.map((entry) => entry.route),
    entries.map((entry) => entry.provider),
    entries.map((entry) => entry.model),
  ]);
  const byKey = new Map<string, RoutePricingRecord>();
  for (const record of records) {
    const entry = entries[Number(record.ord) - 1];
    if (entry === undefined) {
      throw new Error(
        "the route pricing read returned a route it was not asked",
      );
    }
    byKey.set(routeKey(entry), record);
  }
  return byKey;
}

function toView(
  entry: RouteSummaryEntry,
  pricing: RoutePricingRecord | undefined,
): PublishedRouteView {
  if (pricing === undefined) {
    throw new Error("a published route came back without its pricing");
  }
  const databaseMaxOutputTokens = pricing.max_output_tokens ?? null;
  return {
    route: entry.route,
    provider: entry.provider,
    model: entry.model,
    maxOutputTokens: entry.maxOutputTokens,
    timeoutMs: entry.timeoutMs,
    priceId: pricing.price_id ?? null,
    priced: typeof pricing.price_id === "string",
    databaseMaxOutputTokens,
    matchesDatabase: databaseMaxOutputTokens === entry.maxOutputTokens,
    smallestReservationMicros: pricing.smallest_reservation_micros ?? null,
    largestReservationMicros: pricing.largest_reservation_micros ?? null,
    smallestReservationUsd: usdOrNull(
      pricing.smallest_reservation_micros ?? null,
    ),
    largestReservationUsd: usdOrNull(
      pricing.largest_reservation_micros ?? null,
    ),
  };
}

/**
 * The most recently seen workers first, at most MAX_LISTED_WORKERS, each with
 * the routes it published and what the database says about each of them.
 */
export async function listWorkerRoutes(
  tx: TxClient,
): Promise<readonly WorkerRoutesRow[]> {
  const records = await readRows<WorkerRecord>(tx, WORKERS_SQL, [
    MAX_LISTED_WORKERS,
  ]);
  const workers = records.map(parseWorker);

  const distinct = new Map<string, RouteSummaryEntry>();
  for (const worker of workers) {
    for (const entry of worker.routes ?? []) {
      distinct.set(routeKey(entry), entry);
    }
  }
  const pricing = await priceRoutes(tx, [...distinct.values()]);

  return workers.map(({ record, detail, state, routes }) => ({
    workerId: KEY_LIKE.test(record.worker_id)
      ? WITHHELD_WORKER_ID
      : record.worker_id,
    lastSeenAt: record.last_seen_at,
    stoppedAt: record.stopped_at,
    detail,
    state,
    routes:
      routes === null
        ? null
        : routes.map((entry) => toView(entry, pricing.get(routeKey(entry)))),
  }));
}
