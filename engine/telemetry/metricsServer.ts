// The worker's metrics listener (Phase 2E.1): GET /metrics in the SAME process,
// and nothing else. There is no other endpoint, no other method and no body a
// caller can send that changes anything.
//
// PRIVATE BY DEFAULT. It exists only when METRICS_ENABLED is exactly "true",
// and it binds 127.0.0.1 unless METRICS_HOST names another address, which a
// deployment sets only to reach a private container network. It is never part
// of the browser application, and Prometheus, which scrapes it, holds no
// database credential: this process answers from memory and reads nothing to
// answer.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { PROMETHEUS_CONTENT_TYPE } from "./prometheusRegistry.ts";

export const METRICS_PATH = "/metrics";
export const DEFAULT_METRICS_HOST = "127.0.0.1";

export interface MetricsConfig {
  readonly host: string;
  readonly port: number;
}

export type MetricsConfigResult =
  | { readonly enabled: false }
  | ({ readonly enabled: true } & MetricsConfig)
  /** Fixed text, naming variables and never their values. */
  | { readonly enabled: false; readonly error: string };

const HOST = /^[A-Za-z0-9.:-]{1,253}$/;

/**
 * METRICS_ENABLED (default off), METRICS_HOST (default 127.0.0.1) and
 * METRICS_PORT (required when enabled: no port is guessed). Anything invalid
 * turns metrics off and says which variable, never what it held.
 */
export function metricsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MetricsConfigResult {
  const enabled = env.METRICS_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") {
    return { enabled: false };
  }
  if (enabled !== "true") {
    return {
      enabled: false,
      error: 'METRICS_ENABLED must be "true" or "false"; metrics are off',
    };
  }
  const host = env.METRICS_HOST?.trim() || DEFAULT_METRICS_HOST;
  if (!HOST.test(host)) {
    return {
      enabled: false,
      error: "METRICS_HOST is not a host name or address; metrics are off",
    };
  }
  const rawPort = env.METRICS_PORT?.trim() ?? "";
  const port = /^[0-9]{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      enabled: false,
      error:
        "METRICS_PORT must be a port number from 1 to 65535 when METRICS_ENABLED is true; metrics are off",
    };
  }
  return { enabled: true, host, port };
}

export interface MetricsListener {
  /** Where it listens, as bound (the port is resolved when 0 was asked for). */
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Starts the listener. Resolves once it listens, rejects if it cannot (a port
 * in use, an address this host does not have); the caller treats a rejection
 * as "no metrics endpoint", never as a reason to stop working.
 */
export function startMetricsListener(
  config: MetricsConfig,
  render: () => string,
): Promise<MetricsListener> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== METRICS_PATH) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "content-type": "text/plain" });
      response.end("method not allowed\n");
      return;
    }
    let body: string;
    try {
      body = render();
    } catch {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("metrics unavailable\n");
      return;
    }
    response.writeHead(200, {
      "content-type": PROMETHEUS_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  });
  // A scrape is small and fast; nothing may hold the listener open.
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      // A later socket error must not crash the worker.
      server.on("error", () => {});
      const address = server.address() as AddressInfo;
      resolve(
        Object.freeze({
          host: address.address,
          port: address.port,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        }),
      );
    });
  });
}
