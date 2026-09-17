// What a worker publishes about the model routes it resolved, and how an operator
// reads it back (ADR 0017 §9).
//
// The operator CLI never reads routing or provider variables from its own
// environment: the provider key and the owner connection string must never have
// to share a process. Instead a worker writes this summary into its heartbeat
// detail (ops.worker_instances.detail) when it starts, and the CLI reads it from
// the database.
//
// The summary holds only a tier, a provider name, a model id and the tier's
// policy. It never holds a key: routingConfig.ts already refuses a model id that
// contains the key or looks like one, and the parser below refuses any other
// field, so a detail someone widened is ignored rather than shown.

import { MODEL_ROUTE_POLICIES, type ModelRouter } from "./router.ts";
import {
  isModelId,
  isProviderName,
  MODEL_ROUTE_NAMES,
  type ModelRouteName,
} from "./types.ts";

export const WORKER_DETAIL_VERSION = "worker.detail.v1";

/** Heartbeat detail is free text; this summary stays far below any sane bound. */
export const WORKER_DETAIL_MAX_LENGTH = 2000;

export interface RouteSummaryEntry {
  readonly route: ModelRouteName;
  readonly provider: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface WorkerDetail {
  readonly state: string;
  readonly routes: readonly RouteSummaryEntry[];
}

const STATE_PATTERN = /^[a-z][a-z_]{0,31}$/;

/** The routes a router actually resolved, in tier order. */
export function summarizeRoutes(
  router: Pick<ModelRouter, "resolve">,
): readonly RouteSummaryEntry[] {
  const entries: RouteSummaryEntry[] = [];
  for (const name of MODEL_ROUTE_NAMES) {
    const resolved = router.resolve(name);
    if (resolved === undefined) continue;
    entries.push(
      Object.freeze({
        route: resolved.route,
        provider: resolved.provider,
        model: resolved.model,
        maxOutputTokens: resolved.policy.maxOutputTokens,
        timeoutMs: resolved.policy.timeoutMs,
      }),
    );
  }
  return Object.freeze(entries);
}

/** The heartbeat detail a worker writes when it starts. */
export function formatWorkerDetail(
  state: string,
  routes: readonly RouteSummaryEntry[],
): string {
  if (!STATE_PATTERN.test(state)) {
    throw new Error("a worker detail state is a short lowercase word");
  }
  const text = JSON.stringify({
    version: WORKER_DETAIL_VERSION,
    state,
    routes: routes.map((entry) => ({
      route: entry.route,
      provider: entry.provider,
      model: entry.model,
      maxOutputTokens: entry.maxOutputTokens,
      timeoutMs: entry.timeoutMs,
    })),
  });
  if (text.length > WORKER_DETAIL_MAX_LENGTH) {
    throw new Error("the worker detail is longer than its bound");
  }
  return text;
}

const isRouteName = (value: unknown): value is ModelRouteName =>
  typeof value === "string" &&
  (MODEL_ROUTE_NAMES as readonly string[]).includes(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const ENTRY_KEYS = [
  "maxOutputTokens",
  "model",
  "provider",
  "route",
  "timeoutMs",
] as const;

function parseEntry(value: unknown): RouteSummaryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== ENTRY_KEYS.length ||
    keys.some((key, index) => key !== ENTRY_KEYS[index])
  ) {
    return null;
  }
  const { route, provider, model, maxOutputTokens, timeoutMs } = record;
  if (
    !isRouteName(route) ||
    !isProviderName(provider) ||
    !isModelId(model) ||
    !isPositiveInteger(maxOutputTokens) ||
    !isPositiveInteger(timeoutMs)
  ) {
    return null;
  }
  return Object.freeze({ route, provider, model, maxOutputTokens, timeoutMs });
}

/**
 * A worker detail read back from the database, or null for anything that is not
 * exactly this version's shape: an older worker's plain text, a widened object,
 * or a detail too long to be one of ours. A route whose policy disagrees with this
 * build's MODEL_ROUTE_POLICIES is kept, so an operator can see the skew.
 */
export function parseWorkerDetail(detail: unknown): WorkerDetail | null {
  if (typeof detail !== "string" || detail.length > WORKER_DETAIL_MAX_LENGTH) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "routes" ||
    keys[1] !== "state" ||
    keys[2] !== "version" ||
    record.version !== WORKER_DETAIL_VERSION ||
    typeof record.state !== "string" ||
    !STATE_PATTERN.test(record.state) ||
    !Array.isArray(record.routes)
  ) {
    return null;
  }
  const routes: RouteSummaryEntry[] = [];
  for (const item of record.routes) {
    const entry = parseEntry(item);
    if (entry === null) return null;
    routes.push(entry);
  }
  return Object.freeze({ state: record.state, routes: Object.freeze(routes) });
}

/** Whether a published route's policy is the one this build would send. */
export const routePolicyMatches = (entry: RouteSummaryEntry): boolean =>
  MODEL_ROUTE_POLICIES[entry.route].maxOutputTokens === entry.maxOutputTokens &&
  MODEL_ROUTE_POLICIES[entry.route].timeoutMs === entry.timeoutMs;
