// The worker process entry point.
//
//   node --experimental-strip-types engine/worker/main.ts
//   npm run worker
//
// Configuration is environment only. Nothing here reads a file, and the
// connection string is never logged — not even redacted, because a redaction
// bug is how connection strings reach logs. No environment VALUE appears in any
// message this file raises: a misconfigured variable is exactly where a pasted
// secret ends up.
//
// It refuses to start unless the database identity is the constrained one. A
// worker pointed at `postgres` or `service_role` would run every job correctly
// and leak every tenant, so this is a boot gate rather than a warning.
//
// It also refuses to start with a lease too short for the model calls it is
// configured to make. A call the lease cannot bound is a call whose result this
// worker cannot record, so the operator learns it at boot rather than from runs
// that all end indeterminate.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../db/workerDatabase.ts";
import { createModelRouterFromEnv } from "../models/routingConfig.ts";
import { createLogger } from "./log.ts";
import { createHandlerRegistry } from "./registry.ts";
import { DEFAULT_LEASE_SAFETY_MARGIN_MS } from "./runOneJob.ts";
import { runWorker } from "./runWorker.ts";

/**
 * Lease time spent before a call can start: the lease commit, then the prepare
 * transaction's claim, gate and stop checks. The abandon grace and the settle
 * transaction already fit inside the safety margin, after the deadline.
 */
export const LEASE_PREPARE_ALLOWANCE_MS = 5_000;

const readInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

/**
 * Refuses a lease that cannot hold the longest configured model call.
 *
 * An external call's deadline is the lease's remaining time minus the runtime's
 * safety margin, and the settle transaction, with any abandon grace, runs inside
 * that margin. So the lease must hold what is spent before the call, the longest
 * route timeout, and the margin. A shorter lease lets the LEASE, not the route,
 * end the call. Pure, so it is tested without a process or a database.
 *
 * No configured route means no model call, so there is nothing to bound.
 */
export function assertLeaseFitsModelRoutes(
  leaseSeconds: number,
  maxConfiguredTimeoutMs: number,
): void {
  if (maxConfiguredTimeoutMs <= 0) return;
  const requiredMs =
    LEASE_PREPARE_ALLOWANCE_MS +
    maxConfiguredTimeoutMs +
    DEFAULT_LEASE_SAFETY_MARGIN_MS;
  if (leaseSeconds * 1000 < requiredMs) {
    throw new Error(
      `Refusing to start: OPS_WORKER_LEASE_SECONDS is too short for the longest configured model route timeout (${maxConfiguredTimeoutMs} ms) plus the prepare allowance (${LEASE_PREPARE_ALLOWANCE_MS} ms) and the lease safety margin (${DEFAULT_LEASE_SAFETY_MARGIN_MS} ms). Set it to at least ${Math.ceil(requiredMs / 1000)} seconds, or configure no longer route.`,
    );
  }
}

/**
 * The lease binds to the worker id, so two processes must never share one: a
 * process that resumed another's lease could settle its job, or settle its run
 * while the other's call is in flight. A configured OPS_WORKER_ID therefore
 * names the worker, and a per-process suffix keeps it unique.
 */
export function resolveWorkerId(
  configured: string | undefined,
  host: string,
  pid: number,
  uniqueSuffix: string,
): string {
  const name = configured ? configured : `${host}:${pid}`;
  return `${name}:${uniqueSuffix}`;
}

export async function main(): Promise<void> {
  const connectionString = process.env.OPS_WORKER_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "OPS_WORKER_DATABASE_URL is required. It must point at a dedicated LOGIN role that is a member of ops_worker — never the postgres or service_role connection string. See scripts/provision-worker-role.mjs.",
    );
  }

  // Stable for the process, unique across processes: the lease binds to it, and
  // two workers sharing an id could settle each other's jobs.
  const workerId = resolveWorkerId(
    process.env.OPS_WORKER_ID,
    hostname(),
    process.pid,
    randomUUID().slice(0, 8),
  );

  // Both boot gates that need no database run before the pool opens, so a
  // refused start leaves no connection behind. The router's errors name
  // variables, never their values.
  const leaseSeconds = readInt("OPS_WORKER_LEASE_SECONDS", 60);
  const modelRouter = createModelRouterFromEnv(process.env);
  assertLeaseFitsModelRoutes(leaseSeconds, modelRouter.maxConfiguredTimeoutMs);

  const log = createLogger();
  const db = createWorkerDatabase({
    connectionString,
    max: readInt("OPS_WORKER_POOL_SIZE", 4),
    statementTimeoutMs: readInt("OPS_WORKER_STATEMENT_TIMEOUT_MS", 30_000),
  });

  const controller = new AbortController();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      // A second signal means the operator is not waiting. Leases expire and
      // the reaper recovers whatever was in flight.
      process.exit(130);
    }
    stopping = true;
    log("worker.stopping", { workerId, detail: `signal ${signal}` });
    controller.abort();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  try {
    assertWorkerIdentity(await db.identity());
    await runWorker({
      workerId,
      db,
      registry: createHandlerRegistry({ modelRouter }),
      signal: controller.signal,
      pollIntervalMs: readInt("OPS_WORKER_POLL_INTERVAL_MS", 1_000),
      heartbeatIntervalMs: readInt("OPS_WORKER_HEARTBEAT_INTERVAL_MS", 15_000),
      reapIntervalMs: readInt("OPS_WORKER_REAP_INTERVAL_MS", 30_000),
      leaseSeconds,
      log,
    });
  } finally {
    await db.close();
  }
}

// `import.meta.url === \`file://${process.argv[1]}\`` is never true on Windows.
// That exact comparison silently disabled two hooks in this repository
// (CLAUDE.md, "Tests"), so this module uses pathToFileURL instead.
const isEntryPoint = async () => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await isEntryPoint()) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "worker.fatal",
        detail: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    process.exit(1);
  });
}
