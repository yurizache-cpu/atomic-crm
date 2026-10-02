// The real worker loop against the hosted SYNTHETIC staging project, with the
// scripted lead-triage provider that answers the demo's canned advice. Local
// and manual only (docs/COST_FIRST_STAGING.md); never CI, never production.
//
//   DEPLOYMENT_ENVIRONMENT=staging OPS_WORKER_DATABASE_URL=... \
//     npm run staging:fake-worker
//
// The deployable worker (engine/worker/main.ts) refuses the fake provider by
// design, so a synthetic end-to-end run on staging, before any model account is
// paid for, needs this one entry point. Everything else is the worker's own:
// the same start gate (it refuses every environment but staging), the same
// identity assertion (ops_worker_login only, never an owner URL), the same
// registry under every gate through runOneJob, and DECISION_SHADOW_PROVIDER
// and CALENDAR_PROVIDER read the same way. It works the queue until it is
// idle, at most MAX_JOBS jobs, and prints one JSON line per job and no id but
// the job's.

import { hostname } from "node:os";
import { calendarPortFromEnv } from "../calendar/providerFromEnv.ts";
import {
  assertWorkerIdentity,
  createWorkerDatabase,
} from "../db/workerDatabase.ts";
import type { WorkerDatabase } from "../db/types.ts";
import { decisionShadowFromEnv } from "../decision/providerFromEnv.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { createModelRouter } from "../models/router.ts";
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
import { CANNED_ADVICE, MODEL } from "./leadTriageDemo.ts";

const WORKER_DATABASE_URL = "OPS_WORKER_DATABASE_URL";
export const MAX_JOBS = 20;

export interface StagingFakeWorkerDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

export async function runStagingFakeWorker({
  env,
  stdout,
  stderr,
  openDatabase,
}: StagingFakeWorkerDependencies): Promise<number> {
  let environment: string;
  try {
    environment = assertDeploymentEnvironment(env, "worker").environment;
  } catch (error) {
    stderr(
      jsonLine({ error: "environment", message: (error as Error).message }),
    );
    return EXIT_USAGE;
  }
  if (environment !== "staging") {
    stderr(
      jsonLine({
        error: "environment",
        message:
          "DEPLOYMENT_ENVIRONMENT must be staging: this tool answers agent runs with canned synthetic text",
      }),
    );
    return EXIT_REFUSED;
  }
  const url = env[WORKER_DATABASE_URL];
  if (url === undefined || url === "") {
    stderr(
      jsonLine({
        error: "configuration",
        message: `${WORKER_DATABASE_URL} (the ops_worker_login connection) is required`,
      }),
    );
    return EXIT_USAGE;
  }

  const provider = createFakeModelProvider({
    type: "respond",
    content: CANNED_ADVICE,
  });
  const decisionShadow = decisionShadowFromEnv(env);
  const registry = createHandlerRegistry({
    modelRouter: createModelRouter({
      routes: new Map([
        ["standard", { provider: provider.name, model: MODEL }],
      ]),
      providers: new Map([[provider.name, provider]]),
    }),
    decisionPort: decisionShadow.port,
    requestsShadowDecisions: decisionShadow.requestsShadowDecisions,
    calendarPort: calendarPortFromEnv(env),
  });

  const db = openDatabase(url);
  try {
    assertWorkerIdentity(await db.identity());
    const workerId = `staging-fake-${hostname()}-${process.pid}`;
    let jobs = 0;
    for (; jobs < MAX_JOBS; jobs += 1) {
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
      jsonLine({
        step: jobs < MAX_JOBS ? "idle" : "stopped_at_limit",
        jobs,
        modelCalls: provider.calls.length,
      }),
    );
    return EXIT_OK;
  } finally {
    await db.close();
  }
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runStagingFakeWorker({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 2 }),
  });
}
