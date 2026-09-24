import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { metricsConfigFromEnv } from "./metricsServer.ts";

// The observability deployment stays private (Phase 2E.1), checked statically
// so a later edit that publishes a port, hands Prometheus or the Collector a
// credential, forwards telemetry somewhere, or routes /metrics through the
// browser app goes red here by name.

const DIR = "deploy/observability";
const compose = readFileSync(`${DIR}/docker-compose.yml`, "utf8");
const prometheus = readFileSync(`${DIR}/prometheus.yml`, "utf8");
const collector = readFileSync(`${DIR}/otel-collector.yaml`, "utf8");

/** Configuration lines, comments removed. */
const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""))
    .filter((line) => line.trim() !== "");

const tracked = (): string[] =>
  execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

describe("the local observability stack", () => {
  it("publishes every port on loopback only, in the one short syntax this check reads", () => {
    const config = lines(compose);
    // The list items under each `ports:` key.
    const published: string[] = [];
    config.forEach((line, index) => {
      if (!/^\s+ports:\s*$/.test(line)) return;
      for (const item of config.slice(index + 1)) {
        if (!/^\s+-/.test(item)) break;
        published.push(item);
      }
    });
    expect(published.length).toBe(2);
    for (const line of published) {
      expect(line).toMatch(/^\s+-\s+"127\.0\.0\.1:[0-9]+:[0-9]+"$/);
    }
    // No long-syntax publish, host network, or unquoted mapping around it.
    for (const line of config) {
      expect(line).not.toMatch(/published:|host_ip:|network_mode|privileged/);
      expect(line).not.toMatch(/^\s+-\s+[0-9.:]+:[0-9]+\s*$/);
    }
  });

  it("pins each official image by tag and digest", () => {
    const images = lines(compose)
      .filter((line) => /^\s+image:/.test(line))
      .map((line) => line.replace(/^\s+image:\s*/, ""));
    expect(images).toEqual([
      expect.stringMatching(
        /^otel\/opentelemetry-collector:[0-9.]+@sha256:[0-9a-f]{64}$/,
      ),
      expect.stringMatching(/^prom\/prometheus:v[0-9.]+@sha256:[0-9a-f]{64}$/),
    ]);
  });

  it("gives neither service a credential, the database network or anything to write", () => {
    const config = lines(compose).join("\n");
    expect(config).not.toMatch(/environment:|env_file:|secrets:/);
    expect(config).not.toMatch(
      /supabase|postgres|DATABASE_URL|service_role|password|token|5432|5434|5432[0-9]/i,
    );
    expect(config.match(/read_only: true/g)).toHaveLength(2);
    expect(config.match(/cap_drop: \[ALL\]/g)).toHaveLength(2);
    expect(config.match(/no-new-privileges:true/g)).toHaveLength(2);
    // Mounts: its own read-only config files and Prometheus's named volume.
    const mounts = lines(compose)
      .filter((line) => /^\s+-\s+(\.\/|[a-z-]+:\/)/.test(line))
      .map((line) => line.trim());
    expect(mounts).toEqual([
      "- ./otel-collector.yaml:/etc/otelcol/config.yaml:ro",
      "- ./prometheus.yml:/etc/prometheus/prometheus.yml:ro",
      "- prometheus-data:/prometheus",
    ]);
  });

  it("points Prometheus at the worker's /metrics only, with no credential", () => {
    const config = lines(prometheus).join("\n");
    expect(config).toContain("metrics_path: /metrics");
    expect(config).toContain('targets: ["host.docker.internal:9464"]');
    expect(config).not.toMatch(
      /basic_auth|bearer|authorization|password|credentials|remote_write/i,
    );
  });

  it("forwards traces nowhere: the Collector only prints what it received", () => {
    const config = lines(collector).join("\n");
    const exporters = config.split("exporters:")[1]?.split("service:")[0] ?? "";
    expect(exporters.trim().split("\n")[0].trim()).toBe("debug:");
    expect(config).not.toMatch(
      /otlp_http:|otlp_grpc:|endpoint: https?:\/\/|headers:|api[_-]?key/i,
    );
  });
});

describe("the worker's metrics listener", () => {
  it("is off by default and binds loopback when turned on", () => {
    expect(metricsConfigFromEnv({})).toEqual({ enabled: false });
    expect(
      metricsConfigFromEnv({ METRICS_ENABLED: "true", METRICS_PORT: "9464" }),
    ).toMatchObject({ host: "127.0.0.1" });
  });

  it("is never part of the browser application or its build configuration", () => {
    const browserInputs = tracked().filter(
      (file) =>
        /^(src|public)\//.test(file) ||
        /^(vite\.[^/]*|netlify\.toml|index\.html|\.env[^/]*)$/.test(file),
    );
    expect(browserInputs.length).toBeGreaterThan(50);
    for (const file of browserInputs) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /\/metrics\b|METRICS_(ENABLED|HOST|PORT)|OTEL_EXPORTER|engine\/telemetry/,
      );
    }
  });
});
