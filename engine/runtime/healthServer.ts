// A process health endpoint for a deployed worker (Production Hosting, SI-77).
//
//   GET /healthz  ->  200 "ok" while healthy, 503 "unavailable" otherwise
//
// It answers a status and nothing else: no version, no count, no identifier,
// no content. Any other path is 404 and any other method 405. It is off unless
// a port is configured, and it binds where it is told: a container binds all of
// its own interfaces so the platform's health check can reach it, and exposes
// no public service for it (fly.toml gives the worker none).

import { createServer, type Server } from "node:http";

export const HEALTH_PATH = "/healthz";

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  readonly isHealthy: () => boolean;
}

const HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

/** The server, unstarted: exported for the tests. */
export function createHealthServer(isHealthy: () => boolean): Server {
  return createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (path !== HEALTH_PATH) {
      response.writeHead(404, HEADERS).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, HEADERS).end();
      return;
    }
    let healthy = false;
    try {
      healthy = isHealthy();
    } catch {
      healthy = false;
    }
    response
      .writeHead(healthy ? 200 : 503, HEADERS)
      .end(
        request.method === "HEAD" ? undefined : healthy ? "ok" : "unavailable",
      );
  });
}

export async function startHealthServer(
  options: HealthServerOptions,
): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const server = createHealthServer(options.isHealthy);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  return {
    port:
      typeof address === "object" && address !== null
        ? address.port
        : options.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Health from the worker loop: healthy once a poll has reached the database and
 * while the last one that did is recent. A poll can be busy for a whole lease
 * (a model call), so the window is generous; a database that stays unreachable
 * makes the worker unhealthy, and the platform restarts it.
 */
export function createPollHealth(
  staleAfterMs: number,
  now: () => number = Date.now,
): {
  readonly onPoll: (outcome: "ok" | "failed") => void;
  readonly isHealthy: () => boolean;
} {
  let lastOk: number | null = null;
  return {
    onPoll: (outcome) => {
      if (outcome === "ok") lastOk = now();
    },
    isHealthy: () => lastOk !== null && now() - lastOk <= staleAfterMs,
  };
}
