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
// runOneJob, with three differences that bound a paid test:
//   * it refuses every environment but staging, and a worker with no gateway;
//   * it works the queue until it is idle or STAGING_MAX_JOBS jobs (default 10,
//     at most 20) have run, then exits;
//   * it prints one JSON line per job: ids, kinds and outcomes, never content.
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
import { assertDeploymentEnvironment } from "../runtime/deploymentEnvironment.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
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
  try {
    const structured = structuredDecisionsFromEnv(env);
    registry = createHandlerRegistry({
      modelRouter: createModelRouterFromEnv(env),
      structuredDecisionGateway: structured.gateway,
      requestsStructuredDecisions: structured.requestsStructuredDecisions,
    });
  } catch (error) {
    // Boot errors name variables, never values (routingConfig.ts).
    return refuse("configuration", (error as Error).message, EXIT_USAGE);
  }

  const db = openDatabase(url);
  try {
    assertWorkerIdentity(await db.identity());
    const workerId = `staging-gateway-${hostname()}-${process.pid}`;
    let jobs = 0;
    for (; jobs < maxJobs; jobs += 1) {
      const result = await runOneJob(db, { workerId, registry });
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
