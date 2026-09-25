import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  METRICS,
  OTHER,
  SPAN_ATTRIBUTE_RULES,
  SPAN_NAMES,
  sanitizeMetricLabels,
  sanitizeSpanAttributes,
  type MetricName,
} from "./catalog.ts";
import { TELEMETRY_SENTINELS } from "./testSupport/recordingTelemetry.ts";

// The telemetry allowlist (Phase 2E.1) is the privacy boundary: what it does
// not declare cannot be exported, and what it declares accepts only closed
// sets or fixed shapes. These tests pin both halves, so widening either one is
// a deliberate, reviewed change to this file.

const SENTINELS = Object.values(TELEMETRY_SENTINELS);
const TENANT = "0b8f3a3e-5c1a-4d2e-9f6b-2a7c1d9e4f10";

describe("the span attribute allowlist", () => {
  it("is exactly the reviewed set of keys", () => {
    expect(Object.keys(SPAN_ATTRIBUTE_RULES).sort()).toEqual([
      "company_os.agent_run.outcome",
      "company_os.call.outcome",
      "company_os.decision.outcome",
      "company_os.failure.class",
      "company_os.job.attempt",
      "company_os.job.id",
      "company_os.job.kind",
      "company_os.job.outcome",
      "company_os.operation",
      "company_os.policy.version",
      "company_os.provider.kind",
      "company_os.run.id",
      "company_os.tenant.id",
    ]);
    expect([...SPAN_NAMES].sort()).toEqual([
      "company_os.governance.check",
      "company_os.job.execute",
      "company_os.provider.call",
      "company_os.settlement",
      "company_os.whatsapp.send",
    ]);
  });

  it("accepts no content under ANY allowed key: every sentinel is dropped", () => {
    // The mutant this guards against: a key whose rule is later widened to
    // free text (a pattern like /.+/). Every sentinel would then survive here.
    for (const key of Object.keys(SPAN_ATTRIBUTE_RULES)) {
      for (const sentinel of SENTINELS) {
        expect(sanitizeSpanAttributes({ [key]: sentinel })).toEqual({});
      }
    }
  });

  it("drops a key it does not declare, whatever the value", () => {
    const kept = sanitizeSpanAttributes({
      "company_os.job.kind": "agent_run.execute",
      "company_os.message.body": TELEMETRY_SENTINELS.messageBody,
      "contact.phone": TELEMETRY_SENTINELS.phone,
      "enduser.id": TELEMETRY_SENTINELS.email,
      "db.statement": TELEMETRY_SENTINELS.rawSql,
      "gen_ai.prompt": TELEMETRY_SENTINELS.prompt,
      "exception.message": TELEMETRY_SENTINELS.providerOutput,
      authorization: TELEMETRY_SENTINELS.token,
    });
    expect(kept).toEqual({ "company_os.job.kind": "agent_run.execute" });
  });

  it("keeps an internal id only as a lowercase uuid, and never a uuid under another key", () => {
    expect(
      sanitizeSpanAttributes({
        "company_os.tenant.id": TENANT,
        "company_os.job.id": TENANT.toUpperCase(),
        "company_os.run.id": `${TENANT} `,
        "company_os.job.kind": TENANT,
      }),
    ).toEqual({ "company_os.tenant.id": TENANT });
  });

  it("drops a value of the wrong type, an unsafe count and a prototype key", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"company_os.job.kind": "agent_run.execute"}, "company_os.job.attempt": 1.5, "company_os.job.outcome": ["succeeded"]}',
    );
    expect(sanitizeSpanAttributes(hostile)).toEqual({});
    expect(sanitizeSpanAttributes(undefined)).toEqual({});
  });
});

describe("the metric catalogue", () => {
  it("is exactly the reviewed metrics, with exactly the reviewed labels", () => {
    const shape = Object.fromEntries(
      Object.entries(METRICS).map(([name, definition]) => [
        name,
        [definition.type, ...Object.keys(definition.labels).sort()],
      ]),
    );
    expect(shape).toEqual({
      company_os_agent_run_duration_seconds: ["histogram"],
      company_os_agent_runs_total: ["counter", "outcome"],
      company_os_decision_evaluations_total: [
        "counter",
        "outcome",
        "policy_version",
      ],
      company_os_external_calls_total: ["counter", "operation", "outcome"],
      company_os_job_duration_seconds: ["histogram", "job_kind"],
      company_os_jobs_total: ["counter", "job_kind", "outcome"],
      company_os_provider_duration_seconds: [
        "histogram",
        "operation",
        "provider_kind",
      ],
      company_os_worker_active_jobs: ["gauge"],
      company_os_worker_queue_depth: ["gauge"],
    });
  });

  it("has no identifier label: no tenant, job, run, review, contact or message", () => {
    for (const definition of Object.values(METRICS)) {
      for (const label of Object.keys(definition.labels)) {
        expect(label).not.toMatch(
          /tenant|job_id|run_id|review|contact|message|phone|email|user|id$/,
        );
      }
    }
  });

  it("folds every sentinel, uuid and unknown value into 'other', and adds no undeclared label", () => {
    for (const metric of Object.keys(METRICS) as MetricName[]) {
      const declared = Object.keys(METRICS[metric].labels).sort();
      for (const sentinel of [...SENTINELS, TENANT]) {
        const raw = Object.fromEntries(
          declared.map((label) => [label, sentinel]),
        );
        const labels = sanitizeMetricLabels(metric, {
          ...raw,
          tenant_id: TENANT,
          detail: sentinel,
        });
        expect(Object.keys(labels)).toEqual(declared);
        expect(Object.values(labels).every((value) => value === OTHER)).toBe(
          true,
        );
      }
    }
  });

  it("keeps a value its label's closed set allows", () => {
    expect(
      sanitizeMetricLabels("company_os_jobs_total", {
        job_kind: "decision.shadow_evaluate",
        outcome: "deferred",
      }),
    ).toEqual({ job_kind: "decision.shadow_evaluate", outcome: "deferred" });
    expect(
      sanitizeMetricLabels("company_os_decision_evaluations_total", {
        outcome: "completed",
        policy_version: "decision_shadow.v2",
      }),
    ).toEqual({ outcome: "completed", policy_version: "decision_shadow.v2" });
  });
});

// Every telemetry key the engine writes must be one the catalogue declares:
// an undeclared key would be dropped silently, so this makes the addition a
// visible catalogue change instead of a no-op someone thinks is exported.
describe("telemetry call sites in the engine", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.ts$/.test(entry) && !/\.(test|dbtest)\.ts$/.test(entry)
        ? [path]
        : [];
    });

  it("name only declared span attributes", () => {
    const used = new Set<string>();
    for (const file of sources("engine")) {
      for (const match of readFileSync(file, "utf8").matchAll(
        /"(company_os\.[a-z_.]+)":/g,
      )) {
        used.add(match[1]);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    for (const key of used) {
      expect(Object.keys(SPAN_ATTRIBUTE_RULES)).toContain(key);
    }
  });

  it("import OpenTelemetry in exactly one adapter file, and no vendor SDK anywhere", () => {
    const importers: string[] = [];
    for (const file of sources("engine")) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /from "(prom-client|dd-trace|@sentry\/|newrelic|@datadog\/)/,
      );
      if (/from "@opentelemetry\//.test(text)) {
        importers.push(file.replace(/\\/g, "/"));
      }
    }
    expect(importers).toEqual(["engine/telemetry/openTelemetry.ts"]);
  });
});
