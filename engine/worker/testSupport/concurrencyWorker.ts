// A real worker PROCESS, for the concurrency suite.
//
// It is not a mock and not a harness: it builds the same adapter, asserts the
// same identity and runs the same loop as `engine/worker/main.ts`. The only
// difference is its registry, which holds a deliberately slow handler so that
// two processes genuinely overlap, and the fact that it prints its stats and
// the jobs it ran so the parent can assert on them.
//
// Because it leases the head of whatever queue it is pointed at and settles
// those jobs with its own test handlers, it refuses a database that is not on
// this machine (localDatabase.ts) before it opens a connection, registers a
// listener or starts a timer, as agentRunWorker.ts does.
//
//   node engine/worker/testSupport/concurrencyWorker.ts
//
// Environment: OPS_WORKER_DATABASE_URL, OPS_WORKER_ID, WORKER_RUN_MS,
// WORKER_HANDLER_DELAY_MS. Exit 2 on a refused configuration.

import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../../db/workerDatabase.ts";
import { createRegistry } from "../handlerRegistry.ts";
import { silentLogger } from "../log.ts";
import { runWorker } from "../runWorker.ts";
import { loopbackDatabaseTarget } from "./localDatabase.ts";

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

/** The refusal to print, or undefined for a usable connection string. Names the variable, never its value. */
function refusalFor(connectionString: string | undefined): string | undefined {
  if (!connectionString) return "OPS_WORKER_DATABASE_URL is required";
  if (!loopbackDatabaseTarget(connectionString)) {
    return "OPS_WORKER_DATABASE_URL must name a database on this machine (127.0.0.1, localhost or [::1]): this test worker leases the head of its queue and settles those jobs with test handlers";
  }
  return undefined;
}

async function run(connectionString: string): Promise<void> {
  const db = createWorkerDatabase({ connectionString, max: 2 });
  const controller = new AbortController();

  // SIGTERM is how the parent asks for a graceful stop, exactly as an operator or
  // an orchestrator would — and it is what `main.ts` wires in production.
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());

  // A second, equivalent stop channel, because signals are not portable.
  // MEASURED on win32: `child.kill("SIGTERM")` is TerminateProcess, so the
  // handler above NEVER RUNS and the child dies with exit code null. That is a
  // property of the platform's process model, not of the worker — so the test
  // drives this channel on Windows and the real signal on POSIX. Both reach the
  // same `controller.abort()`, so the behaviour under test is identical; only the
  // signal *wiring* is proven on POSIX alone (i.e. in CI).
  // Attaching a "data" listener is enough to put stdin into flowing mode.
  // `resume()` would ALSO hold the event loop open forever, so the process
  // would never exit after the loop ended and the parent would wait on `close`
  // until it timed out -- measured, and it turned 3 passing tests into 5
  // timeouts. `unref()` is not available for every stdin kind either, so the
  // handle is released explicitly in the `finally` below instead.
  process.stdin.on("data", () => controller.abort());

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
    // Release stdin, or its open handle keeps this process alive after the
    // loop has finished and the parent never sees `close`.
    process.stdin.destroy();
  }
}

const connectionString = process.env.OPS_WORKER_DATABASE_URL;
const refusal = refusalFor(connectionString);
if (refusal !== undefined || connectionString === undefined) {
  // exitCode, not exit(): a pipe write on win32 is asynchronous, and nothing
  // else keeps this process alive.
  process.stderr.write(`${refusal ?? "OPS_WORKER_DATABASE_URL is required"}\n`);
  process.exitCode = 2;
} else {
  await run(connectionString);
}
