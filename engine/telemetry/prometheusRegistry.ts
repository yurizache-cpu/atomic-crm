// An in-memory metric registry that renders the Prometheus text exposition
// format (version 0.0.4). Phase 2E.1.
//
// Not a metrics database: it holds the current value of a handful of series
// in this process, and Prometheus scrapes and stores them. A restart starts
// every counter at zero again, which Prometheus's rate functions expect.
//
// Every metric and label comes from catalog.ts. A name the catalogue does not
// declare is ignored, and every label value is sanitised, so the number of
// series is bounded by the catalogue's closed sets: no tenant, job, run,
// review, contact or message id, and no error text, can become a series.

import {
  isMetricName,
  METRICS,
  sanitizeMetricLabels,
  type MetricDefinition,
  type MetricName,
} from "./catalog.ts";
import { NOOP_TELEMETRY, type TelemetryPort } from "./telemetryPort.ts";

export const PROMETHEUS_CONTENT_TYPE =
  "text/plain; version=0.0.4; charset=utf-8";

interface HistogramState {
  readonly bucketCounts: number[];
  sum: number;
  count: number;
}

interface Series {
  readonly labels: Readonly<Record<string, string>>;
  value: number;
  histogram?: HistogramState;
}

export interface PrometheusRegistry extends TelemetryPort {
  /** The exposition text: every declared metric, then its series. */
  render(): string;
}

const escapeLabelValue = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const formatLabels = (
  labels: Readonly<Record<string, string>>,
  extra?: readonly [string, string],
): string => {
  const pairs = Object.entries(labels).map(
    ([key, value]) => `${key}="${escapeLabelValue(value)}"`,
  );
  if (extra) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
};

const formatNumber = (value: number): string =>
  value === Number.POSITIVE_INFINITY ? "+Inf" : String(value);

export function createPrometheusRegistry(): PrometheusRegistry {
  const series = new Map<MetricName, Map<string, Series>>();

  const seriesFor = (
    metric: MetricName,
    rawLabels: Readonly<Record<string, unknown>> | undefined,
  ): Series => {
    const labels = sanitizeMetricLabels(metric, rawLabels);
    const key = JSON.stringify(labels);
    let byLabels = series.get(metric);
    if (!byLabels) {
      byLabels = new Map();
      series.set(metric, byLabels);
    }
    let entry = byLabels.get(key);
    if (!entry) {
      const definition: MetricDefinition = METRICS[metric];
      entry = {
        labels,
        value: 0,
        histogram:
          definition.type === "histogram"
            ? {
                bucketCounts: (definition.buckets ?? []).map(() => 0),
                sum: 0,
                count: 0,
              }
            : undefined,
      };
      byLabels.set(key, entry);
    }
    return entry;
  };

  const typed = (metric: unknown, type: MetricDefinition["type"]) =>
    isMetricName(metric) && METRICS[metric].type === type;

  const registry: PrometheusRegistry = {
    startSpan: NOOP_TELEMETRY.startSpan,

    count(metric, labels, by = 1) {
      // A counter only goes up, and only by a finite amount.
      if (!typed(metric, "counter")) return;
      if (!Number.isFinite(by) || by < 0) return;
      seriesFor(metric, labels).value += by;
    },

    observe(metric, value, labels) {
      if (!typed(metric, "histogram")) return;
      if (!Number.isFinite(value) || value < 0) return;
      const entry = seriesFor(metric, labels);
      const histogram = entry.histogram;
      if (!histogram) return;
      const definition: MetricDefinition = METRICS[metric];
      const buckets = definition.buckets ?? [];
      buckets.forEach((bound, index) => {
        if (value <= bound) histogram.bucketCounts[index] += 1;
      });
      histogram.sum += value;
      histogram.count += 1;
    },

    setGauge(metric, value, labels) {
      if (!typed(metric, "gauge")) return;
      if (!Number.isFinite(value)) return;
      seriesFor(metric, labels).value = value;
    },

    render() {
      const lines: string[] = [];
      for (const metric of Object.keys(METRICS).sort() as MetricName[]) {
        const definition: MetricDefinition = METRICS[metric];
        lines.push(`# HELP ${metric} ${definition.help}`);
        lines.push(`# TYPE ${metric} ${definition.type}`);
        const entries = [...(series.get(metric)?.values() ?? [])].sort((a, b) =>
          formatLabels(a.labels).localeCompare(formatLabels(b.labels)),
        );
        for (const entry of entries) {
          if (definition.type !== "histogram" || !entry.histogram) {
            lines.push(
              `${metric}${formatLabels(entry.labels)} ${formatNumber(entry.value)}`,
            );
            continue;
          }
          const buckets = definition.buckets ?? [];
          buckets.forEach((bound, index) => {
            lines.push(
              `${metric}_bucket${formatLabels(entry.labels, ["le", formatNumber(bound)])} ${entry.histogram?.bucketCounts[index] ?? 0}`,
            );
          });
          lines.push(
            `${metric}_bucket${formatLabels(entry.labels, ["le", "+Inf"])} ${entry.histogram.count}`,
          );
          lines.push(
            `${metric}_sum${formatLabels(entry.labels)} ${formatNumber(entry.histogram.sum)}`,
          );
          lines.push(
            `${metric}_count${formatLabels(entry.labels)} ${entry.histogram.count}`,
          );
        }
      }
      return `${lines.join("\n")}\n`;
    },
  };
  return Object.freeze(registry);
}
