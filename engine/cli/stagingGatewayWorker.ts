// The real worker loop against the hosted SYNTHETIC staging project, on the
// real model gateway (ADR 0022), BOUNDED. Local and manual only
// (docs/COST_FIRST_STAGING.md); never CI, never production.
//
//   node scripts/with-staging.mjs --as worker --pass OPENROUTER_API_KEY -- \
//     env AGENT_MODEL_GATEWAY=openrouter STRUCTURED_DECISIONS_GATEWAY=openrouter \
//     npm run staging:gateway-worker
//
// It is the deployable worker's registry, built from the same environment
// (createModelRouterFromEnv, structuredDecisionsFromEnv), under every gate of
// runOneJob, with these differences that bound a paid test:
//   * it refuses every environment but staging, and a worker with no gateway;
//   * it works the queue until it is idle or STAGING_MAX_JOBS jobs (default 10,
//     at most 20) have run, then exits;
//   * it prints one JSON line per job: ids, kinds and outcomes, never content;
//   * the reaper tick's maintenance runs once before and once after the loop,
//     and the lease is sized to the longest configured route.
// Which model is called is the database's choice among the authorized
// candidates; the spend limits and the agent's ceiling still apply.

import { hostname } from "node:os";
import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../db/workerDatabase.ts";
import type { WorkerDatabase } from "../db/types.ts";
import { structuredDecisionsFromEnv } from "../decision/structured/gatewayFromEnv.ts";
import { createModelRouterFromEnv } from "../models/routingConfig.ts";
import { replyTransportFromEnv } from "../communication/whatsapp/replyTransportFromEnv.ts";
import { assertDeploymentEnvironment } from "../runtime/deploymentEnvironment.ts";
import {
  assertLeaseFitsModelRoutes,
  LEASE_PREPARE_ALLOWANCE_MS,
} from "../worker/main.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import {
  DEFAULT_LEASE_SAFETY_MARGIN_MS,
  runOneJob,
} from "../worker/runOneJob.ts";
import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  isEntryPoint,
  jsonLine,
} from "./cliOutput.ts";

const WORKER_DATABASE_URL = "OPS_WORKER_DATABASE_URL";
export const DEFAULT_MAX_JOBS = 10;
export const MAX_JOBS_CEILING = 20;
const MIN_LEASE_SECONDS = 60;

/**
 * The maintenance the deployable worker runs on its reaper tick, once: expired
 * leases recovered, runs and decisions a dead attempt left running settled,
 * automatic replies whose job ended without settling them closed out, the
 * spend ceiling enforced, and the owner's notifications a job left unsettled
 * closed out. Each step is its own transaction and a
 * failure is reported, never fatal, as in runWorker.
 */
async function maintain(
  db: WorkerDatabase,
  stdout: (line: string) => void,
): Promise<void> {
  for (const [step, sql] of [
    ["reap_expired_leases", "select ops.reap_expired_leases() as n"],
    ["settle_stale_agent_runs", "select ops.settle_stale_agent_runs() as n"],
    ["settle_stale_reply_sends", "select ops.settle_stale_reply_sends() as n"],
    [
      "enforce_spend_ceiling",
      "select ops.enforce_spend_ceiling() is not null as n",
    ],
    [
      "settle_stale_owner_notifications",
      "select ops.settle_stale_owner_notifications() as n",
    ],
  ] as const) {
    try {
      const value = await db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ n: unknown }>(sql);
        return rows[0]?.n ?? null;
      });
      stdout(jsonLine({ step, result: String(value) }));
    } catch {
      stdout(jsonLine({ step, result: "failed" }));
    }
  }
}

export interface StagingGatewayWorkerDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

export async function runStagingGatewayWorker({
  env,
  stdout,
  stderr,
  openDatabase,
}: StagingGatewayWorkerDependencies): Promise<number> {
  const refuse = (error: string, message: string, code = EXIT_REFUSED) => {
    stderr(jsonLine({ error, message }));
    return code;
  };
  let environment: string;
  try {
    environment = assertDeploymentEnvironment(env, "worker").environment;
  } catch (error) {
    return refuse("environment", (error as Error).message, EXIT_USAGE);
  }
  if (environment !== "staging") {
    return refuse(
      "environment",
      "DEPLOYMENT_ENVIRONMENT must be staging: this tool is the bounded synthetic staging run",
    );
  }
  if (env.AGENT_MODEL_GATEWAY !== "openrouter") {
    return refuse(
      "configuration",
      "AGENT_MODEL_GATEWAY must be openrouter for the gateway run",
      EXIT_USAGE,
    );
  }
  const limitText = env.STAGING_MAX_JOBS ?? String(DEFAULT_MAX_JOBS);
  const maxJobs = Number(limitText);
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_JOBS_CEILING) {
    return refuse(
      "configuration",
      `STAGING_MAX_JOBS is 1 to ${MAX_JOBS_CEILING}`,
      EXIT_USAGE,
    );
  }
  const url = env[WORKER_DATABASE_URL];
  if (url === undefined || url === "") {
    return refuse(
      "configuration",
      `${WORKER_DATABASE_URL} (the ops_worker_login connection) is required`,
      EXIT_USAGE,
    );
  }

  let registry;
  let leaseSeconds: number;
  try {
    const structured = structuredDecisionsFromEnv(env);
    const modelRouter = createModelRouterFromEnv(env);
    // ADR 0026 §B: REPLY_TRANSPORT=meta carries the published fixed texts the
    // policy authorized, with a token whose system user holds the test
    // WhatsApp Business Account alone; unset, they wait and are then blocked.
    const replyTransport = replyTransportFromEnv(env, "staging");
    const longestCallMs = Math.max(
      modelRouter.maxConfiguredTimeoutMs,
      replyTransport.timeoutMs,
    );
    // Sized like the smoke run's lease: the longest configured route, the
    // prepare allowance and the safety margin always fit inside it.
    leaseSeconds = Math.max(
      MIN_LEASE_SECONDS,
      Math.ceil(
        (LEASE_PREPARE_ALLOWANCE_MS +
          longestCallMs +
          DEFAULT_LEASE_SAFETY_MARGIN_MS) /
          1000,
      ),
    );
    assertLeaseFitsModelRoutes(leaseSeconds, longestCallMs);
    registry = createHandlerRegistry({
      modelRouter,
      structuredDecisionGateway: structured.gateway,
      requestsStructuredDecisions: structured.requestsStructuredDecisions,
      replyTransport,
    });
  } catch (error) {
    // Boot errors name variables, never values (routingConfig.ts).
    return refuse("configuration", (error as Error).message, EXIT_USAGE);
  }

  const db = openDatabase(url);
  try {
    assertWorkerIdentity(await db.identity());
    const workerId = `staging-gateway-${hostname()}-${process.pid}`;
    await maintain(db, stdout);
    let jobs = 0;
    for (; jobs < maxJobs; jobs += 1) {
      const result = await runOneJob(db, { workerId, registry, leaseSeconds });
      if (result.outcome === "idle") break;
      stdout(
        jsonLine({
          step: "job",
          jobId: result.jobId,
          kind: result.kind,
          outcome: result.outcome,
          attempt: result.attempt,
          failureClass: result.failureClass,
          durationMs: result.durationMs,
        }),
      );
    }
    stdout(
      jsonLine({ step: jobs < maxJobs ? "idle" : "stopped_at_limit", jobs }),
    );
    await maintain(db, stdout);
    return EXIT_OK;
  } finally {
    await db.close();
  }
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runStagingGatewayWorker({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 2 }),
  });
}
