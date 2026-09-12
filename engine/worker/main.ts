// The worker process entry point.
//
//   node --experimental-strip-types engine/worker/main.ts
//   npm run worker
//
// Configuration is environment only. Nothing here reads a file, and the
// connection string is never logged — not even redacted, because a redaction
// bug is how connection strings reach logs.
//
// It refuses to start unless the database identity is the constrained one. A
// worker pointed at `postgres` or `service_role` would run every job correctly
// and leak every tenant, so this is a boot gate rather than a warning.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../db/workerDatabase.ts";
import { createLogger } from "./log.ts";
import { handlerRegistry } from "./registry.ts";
import { runWorker } from "./runWorker.ts";

const readInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${raw}`);
  }
  return value;
};

export async function main(): Promise<void> {
  const connectionString = process.env.OPS_WORKER_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "OPS_WORKER_DATABASE_URL is required. It must point at a dedicated LOGIN role that is a member of ops_worker — never the postgres or service_role connection string. See scripts/provision-worker-role.mjs.",
    );
  }

  // Stable for the process, unique across processes: the lease binds to it, and
  // two workers sharing an id could settle each other's jobs.
  const workerId =
    process.env.OPS_WORKER_ID ??
    `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

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
      registry: handlerRegistry,
      signal: controller.signal,
      pollIntervalMs: readInt("OPS_WORKER_POLL_INTERVAL_MS", 1_000),
      heartbeatIntervalMs: readInt("OPS_WORKER_HEARTBEAT_INTERVAL_MS", 15_000),
      reapIntervalMs: readInt("OPS_WORKER_REAP_INTERVAL_MS", 30_000),
      leaseSeconds: readInt("OPS_WORKER_LEASE_SECONDS", 60),
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
