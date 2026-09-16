// A real worker PROCESS whose model call can be caught in flight, for the agent
// run crash proofs in engine/domain/agentRunRuntime.dbtest.ts.
//
// It builds the same adapter, asserts the same identity, and runs the same loop
// and the same handler registry as `engine/worker/main.ts`. Two things differ,
// both on purpose:
//
//   * the `standard` route is served by the scripted fake provider. No provider
//     key exists in this process, none is read, and nothing leaves the machine;
//   * the provider writes ONE line to stdout the moment a call STARTS, so the
//     parent kills this process while the call is in flight by waiting for that
//     line — never by guessing with a timer. By then the prepare transaction has
//     committed the run as `running`, which is exactly the state under test.
//
// Because it answers whatever run heads the queue with a canned assessment, it
// refuses a database that is not on this machine (localDatabase.ts) before it
// opens a connection, registers a listener or starts a timer.
//
//   node engine/worker/testSupport/agentRunWorker.ts
//
// Environment: OPS_WORKER_DATABASE_URL, OPS_WORKER_ID, FAKE_MODEL_BEHAVIOR
// (hang | respond | respond_after_ms:<n>), WORKER_LEASE_SECONDS (default 30),
// and WORKER_RUN_MS (default 60000), a backstop so an orphaned process ends.
// Exit 2 on a refused configuration.

import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../../db/workerDatabase.ts";
import {
  createFakeModelProvider,
  type FakeBehavior,
} from "../../models/fakeModelProvider.ts";
import { createModelRouter } from "../../models/router.ts";
import type { ModelProvider, ModelRequest } from "../../models/types.ts";
import { silentLogger } from "../log.ts";
import { createHandlerRegistry } from "../registry.ts";
import { runWorker } from "../runWorker.ts";
import { loopbackDatabaseTarget } from "./localDatabase.ts";

type Env = Readonly<Record<string, string | undefined>>;

const readInt = (env: Env, name: string, fallback: number) => {
  const raw = env[name];
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Synthetic, and valid against the task_assessment contract. */
const VALID_ASSESSMENT = Object.freeze({
  outcome: "completed",
  summary: "Order paper, toner and coffee before Friday.",
  proposed_next_steps: Object.freeze([
    "Check the stock list.",
    "Place the order with the usual supplier.",
  ]),
});

function behaviorFrom(raw: string | undefined): FakeBehavior | undefined {
  if (raw === "hang") return { type: "hang" };
  const respond: FakeBehavior = { type: "respond", content: VALID_ASSESSMENT };
  if (raw === "respond") return respond;
  const delayed = /^respond_after_ms:(\d{1,7})$/.exec(raw ?? "");
  return delayed
    ? { type: "delay", ms: Number(delayed[1]), then: respond }
    : undefined;
}

interface WorkerConfig {
  readonly workerId: string;
  readonly behavior: FakeBehavior;
  readonly connectionString: string;
  readonly leaseSeconds: number;
  readonly runMs: number;
}

/** The configuration, or the refusal to print. A refusal names variables, never their values. */
function readConfig(env: Env): WorkerConfig | string {
  const behavior = behaviorFrom(env.FAKE_MODEL_BEHAVIOR);
  const connectionString = env.OPS_WORKER_DATABASE_URL;
  if (!behavior || !connectionString) {
    return "OPS_WORKER_DATABASE_URL and FAKE_MODEL_BEHAVIOR (hang | respond | respond_after_ms:<n>) are required";
  }
  if (!loopbackDatabaseTarget(connectionString)) {
    return "OPS_WORKER_DATABASE_URL must name a database on this machine (127.0.0.1, localhost or [::1]): this test worker answers queued agent runs with canned model output";
  }
  return {
    workerId: env.OPS_WORKER_ID ?? "dbtest-agent-run-worker",
    behavior,
    connectionString,
    leaseSeconds: readInt(env, "WORKER_LEASE_SECONDS", 30),
    runMs: readInt(env, "WORKER_RUN_MS", 60_000),
  };
}

async function run(config: WorkerConfig): Promise<void> {
  const { workerId } = config;
  const fake = createFakeModelProvider(config.behavior);
  let calls = 0;
  const provider: ModelProvider = Object.freeze({
    name: fake.name,
    execute(request: ModelRequest, signal: AbortSignal) {
      calls += 1;
      process.stdout.write(
        `${JSON.stringify({ event: "model_call_started" })}\n`,
      );
      return fake.execute(request, signal);
    },
  });
  const modelRouter = createModelRouter({
    routes: new Map([
      ["standard", { provider: provider.name, model: "fake-model-1" }],
    ]),
    providers: new Map([[provider.name, provider]]),
  });

  const db = createWorkerDatabase({
    connectionString: config.connectionString,
    max: 2,
  });
  const controller = new AbortController();

  // The same two stop channels as concurrencyWorker.ts, for the same reason: on
  // win32 `child.kill("SIGTERM")` is TerminateProcess and no handler runs.
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  process.stdin.on("data", () => controller.abort());

  const timer = setTimeout(() => controller.abort(), config.runMs);

  try {
    assertWorkerIdentity(await db.identity());
    const stats = await runWorker({
      workerId,
      db,
      registry: createHandlerRegistry({ modelRouter }),
      signal: controller.signal,
      pollIntervalMs: 25,
      heartbeatIntervalMs: 1_000,
      reapIntervalMs: 1_000,
      leaseSeconds: config.leaseSeconds,
      log: silentLogger,
    });
    process.stdout.write(`${JSON.stringify({ workerId, stats, calls })}\n`);
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
    process.stdin.destroy();
  }
}

const config = readConfig(process.env);
if (typeof config === "string") {
  // exitCode, not exit(): a pipe write on win32 is asynchronous, and nothing
  // else keeps this process alive.
  process.stderr.write(`${config}\n`);
  process.exitCode = 2;
} else {
  await run(config);
}
