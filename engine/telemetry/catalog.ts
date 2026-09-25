// The telemetry allowlist (Phase 2E.1): every span, span attribute, metric and
// metric label the Company OS may emit, and the only values each may carry.
//
// TELEMETRY HAS NO AUTHORITY. Nothing the runtime decides (whether a job runs,
// a review, a stop, spend admission, a retry, a send, the CRM, Q8, a task's or
// a run's lifecycle) reads anything this module or its exporters hold. The
// authoritative state is PostgreSQL, through the Company Engine.
//
// WHAT NEVER LEAVES, because the first tenant is a psychology clinic under the
// LGPD: names, phone numbers, email addresses, message bodies, reply drafts,
// clinical or psychotherapy text, CRM notes, prompts, model or provider
// answers, decision explanations, secrets, tokens, auth metadata, raw SQL and
// arbitrary error text. None of them has a key below, and a key this module
// does not declare is dropped.
//
// AN ALLOWLIST, NOT A DENYLIST. Every key has a rule, and every rule accepts a
// closed set or a fixed shape:
//   * a span attribute whose key is not declared, or whose value fails its
//     rule, is DROPPED;
//   * a metric label whose value fails its rule becomes "other", so a metric
//     keeps counting without ever carrying the value.
// Identifiers (tenant, job, run) are span-only and must be lowercase UUIDs;
// they are never a metric label, so a Prometheus series never names a tenant.

import {
  EXTERNAL_JOB_KINDS,
  GOVERNED_JOB_KINDS,
  INTERNAL_JOB_KINDS,
} from "../worker/jobKinds.ts";

/** What a label value becomes when it fails its rule. */
export const OTHER = "other";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POLICY_VERSION = /^decision_shadow\.v[0-9]{1,4}$/;

type Rule =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "pattern"; readonly pattern: RegExp }
  | { readonly kind: "count"; readonly max: number };

const oneOf = (...values: string[]): Rule =>
  Object.freeze({ kind: "enum", values: Object.freeze(values) });

/** Every job kind the worker classifies; anything else is "other". */
const JOB_KIND = oneOf(
  ...EXTERNAL_JOB_KINDS,
  ...GOVERNED_JOB_KINDS,
  ...INTERNAL_JOB_KINDS,
);
// "interrupted": the attempt stopped without an outcome of its own (the
// process lost the job); its lease expires and the reaper recovers it.
const JOB_OUTCOME = oneOf(
  "succeeded",
  "retry",
  "failed",
  "deferred",
  "interrupted",
);
/** The operations that make an external call, by what they call. */
const OPERATION = oneOf(...EXTERNAL_JOB_KINDS, "whatsapp.send");
const CALL_OUTCOME = oneOf("ok", "error", "timeout", "cancelled");
const PROVIDER_KIND = oneOf("fake", "openai", "jev", "meta", "none");
const AGENT_RUN_OUTCOME = oneOf(
  "succeeded",
  "failed",
  "indeterminate",
  "cancelled",
);
const DECISION_OUTCOME = oneOf(
  "completed",
  "invalid",
  "failed",
  "indeterminate",
  "refused",
);
const FAILURE_CLASS = oneOf("transient", "permanent", "security", "unknown");

// ---------------------------------------------------------------------------
// Spans.
// ---------------------------------------------------------------------------

/** The operation names a span may take. Stable: a rename is a reviewed change. */
export const SPAN_NAMES = Object.freeze([
  // One leased job, from the lease to its outcome.
  "company_os.job.execute",
  // An external call's committed prepare: the stop checks and, for an agent
  // run, the spend reservation (TX2a).
  "company_os.governance.check",
  // The one provider call, outside every transaction.
  "company_os.provider.call",
  // An external call's settlement: the outcome and the spend settlement (TX2b).
  "company_os.settlement",
  // An operator's explicit WhatsApp send (npm run messaging -- send).
  "company_os.whatsapp.send",
] as const);

export type SpanName = (typeof SPAN_NAMES)[number];

export const SPAN_ATTRIBUTE_RULES: Readonly<Record<string, Rule>> =
  Object.freeze({
    "company_os.job.kind": JOB_KIND,
    "company_os.job.outcome": JOB_OUTCOME,
    "company_os.job.attempt": Object.freeze({ kind: "count", max: 1_000 }),
    "company_os.operation": OPERATION,
    "company_os.call.outcome": CALL_OUTCOME,
    "company_os.provider.kind": PROVIDER_KIND,
    "company_os.agent_run.outcome": AGENT_RUN_OUTCOME,
    "company_os.decision.outcome": DECISION_OUTCOME,
    "company_os.policy.version": Object.freeze({
      kind: "pattern",
      pattern: POLICY_VERSION,
    }),
    "company_os.failure.class": FAILURE_CLASS,
    // Span-only identifiers, already internal operational ids (ADR 0015
    // addendum; ARCHITECTURE_ACCELERATION_REVIEW §8). Never a metric label.
    "company_os.tenant.id": Object.freeze({ kind: "pattern", pattern: UUID }),
    "company_os.job.id": Object.freeze({ kind: "pattern", pattern: UUID }),
    "company_os.run.id": Object.freeze({ kind: "pattern", pattern: UUID }),
  });

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

// ---------------------------------------------------------------------------
// Metrics. Names follow the Prometheus conventions: a counter ends in _total,
// a duration is a histogram in seconds, a gauge names what it measures.
// ---------------------------------------------------------------------------

/** Seconds. From a fast settle to a slow model call bounded by its lease. */
const DURATION_BUCKETS = Object.freeze([
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
]);

export interface MetricDefinition {
  readonly type: "counter" | "histogram" | "gauge";
  readonly help: string;
  readonly labels: Readonly<Record<string, Rule>>;
  /** Histograms only. */
  readonly buckets?: readonly number[];
}

export const METRICS = Object.freeze({
  company_os_jobs_total: {
    type: "counter",
    help: "Job attempts this worker finished, by kind and outcome.",
    labels: { job_kind: JOB_KIND, outcome: JOB_OUTCOME },
  },
  company_os_job_duration_seconds: {
    type: "histogram",
    help: "Wall time of one job attempt, from its lease to its outcome.",
    labels: { job_kind: JOB_KIND },
    buckets: DURATION_BUCKETS,
  },
  company_os_external_calls_total: {
    type: "counter",
    help: "External calls issued, by operation and how the call itself ended (not the business outcome).",
    labels: { operation: OPERATION, outcome: CALL_OUTCOME },
  },
  company_os_provider_duration_seconds: {
    type: "histogram",
    help: "Duration of one external provider call.",
    labels: { provider_kind: PROVIDER_KIND, operation: OPERATION },
    buckets: DURATION_BUCKETS,
  },
  company_os_agent_runs_total: {
    type: "counter",
    help: "Agent run settlements this worker recorded after a provider call (runs the reaper settles are counted by the database, not here).",
    labels: { outcome: AGENT_RUN_OUTCOME },
  },
  company_os_agent_run_duration_seconds: {
    type: "histogram",
    help: "Duration of an agent run's provider call.",
    labels: {},
    buckets: DURATION_BUCKETS,
  },
  company_os_decision_evaluations_total: {
    type: "counter",
    help: "Shadow decision evaluations this worker settled after a provider call, by outcome and policy version.",
    labels: {
      outcome: DECISION_OUTCOME,
      policy_version: Object.freeze({
        kind: "pattern",
        pattern: POLICY_VERSION,
      }),
    },
  },
  company_os_worker_active_jobs: {
    type: "gauge",
    help: "Jobs this worker process is executing now.",
    labels: {},
  },
  company_os_worker_queue_depth: {
    type: "gauge",
    help: "Queued jobs ready to run across the deployment, read on the reaper tick (one count, no label).",
    labels: {},
  },
} satisfies Record<string, MetricDefinition>);

export type MetricName = keyof typeof METRICS;
export type MetricLabels = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// The one sanitisation boundary.
// ---------------------------------------------------------------------------

const accepts = (rule: Rule, value: unknown): boolean => {
  switch (rule.kind) {
    case "enum":
      return typeof value === "string" && rule.values.includes(value);
    case "pattern":
      return (
        typeof value === "string" &&
        value.length <= 64 &&
        rule.pattern.test(value)
      );
    case "count":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= rule.max
      );
  }
};

/**
 * The attributes a span may carry: declared keys with values their rule
 * accepts. Everything else is dropped, silently and completely.
 */
export function sanitizeSpanAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): SpanAttributes {
  const kept: Record<string, SpanAttributeValue> = {};
  if (!attributes || typeof attributes !== "object") return kept;
  for (const key of Object.keys(attributes)) {
    if (!Object.hasOwn(SPAN_ATTRIBUTE_RULES, key)) continue;
    const value = attributes[key];
    if (accepts(SPAN_ATTRIBUTE_RULES[key], value)) {
      kept[key] = value as SpanAttributeValue;
    }
  }
  return Object.freeze(kept);
}

export const isSpanName = (name: unknown): name is SpanName =>
  typeof name === "string" && (SPAN_NAMES as readonly string[]).includes(name);

export const isMetricName = (name: unknown): name is MetricName =>
  typeof name === "string" && Object.hasOwn(METRICS, name);

/**
 * A metric's labels: exactly its declared label keys, each value accepted by
 * its rule or replaced by "other". An undeclared key is dropped, so a caller
 * cannot add a dimension, and a missing one is "other", so every series of a
 * metric has the same label set.
 */
export function sanitizeMetricLabels(
  metric: MetricName,
  labels: Readonly<Record<string, unknown>> | undefined,
): MetricLabels {
  const rules: Readonly<Record<string, Rule>> = METRICS[metric].labels;
  const kept: Record<string, string> = {};
  for (const key of Object.keys(rules).sort()) {
    const value = labels?.[key];
    kept[key] = accepts(rules[key], value) ? (value as string) : OTHER;
  }
  return Object.freeze(kept);
}
