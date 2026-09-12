// A real worker PROCESS, for the concurrency suite.
//
// It is not a mock and not a harness: it builds the same adapter, asserts the
// same identity and runs the same loop as `engine/worker/main.ts`. The only
// difference is its registry, which holds a deliberately slow handler so that
// two processes genuinely overlap, and the fact that it prints its stats and
// the jobs it ran so the parent can assert on them.
//
//   node engine/worker/testSupport/concurrencyWorker.ts
//
// Environment: OPS_WORKER_DATABASE_URL, OPS_WORKER_ID, WORKER_RUN_MS,
// WORKER_HANDLER_DELAY_MS.

import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../../db/workerDatabase.ts";
import { createRegistry } from "../handlerRegistry.ts";
import { silentLogger } from "../log.ts";
import { runWorker } from "../runWorker.ts";

const readInt = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const workerId = process.env.OPS_WORKER_ID ?? "concurrency-worker";
const runMs = readInt("WORKER_RUN_MS", 4_000);
const delayMs = readInt("WORKER_HANDLER_DELAY_MS", 150);

/** Every job this process actually executed, with the tenant it ran under. */
const executed: { jobId: string; tenantId: string }[] = [];

const registry = createRegistry([
  {
    kind: "dbtest.slow",
    capabilities: [],
    run: async (job) => {
      executed.push({ jobId: job.id, tenantId: job.tenant_id });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return `ran by ${workerId}`;
    },
  },
  {
    kind: "dbtest.quick",
    capabilities: [],
    run: async (job) => {
      executed.push({ jobId: job.id, tenantId: job.tenant_id });
      return `ran by ${workerId}`;
    },
  },
]);

const connectionString = process.env.OPS_WORKER_DATABASE_URL;
if (!connectionString) {
  process.stderr.write("OPS_WORKER_DATABASE_URL is required\n");
  process.exit(2);
}

const db = createWorkerDatabase({ connectionString, max: 2 });
const controller = new AbortController();

// SIGTERM is how the parent asks for a graceful stop, exactly as an operator or
// an orchestrator would.
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
const timer = setTimeout(() => controller.abort(), runMs);

try {
  assertWorkerIdentity(await db.identity());
  const stats = await runWorker({
    workerId,
    db,
    registry,
    signal: controller.signal,
    pollIntervalMs: 25,
    heartbeatIntervalMs: 1_000,
    reapIntervalMs: 1_000,
    leaseSeconds: 30,
    log: silentLogger,
  });
  process.stdout.write(`${JSON.stringify({ workerId, stats, executed })}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      workerId,
      fatal: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await db.close();
}
