// A local, manual smoke test of the agent runtime: ONE synthetic agent run,
// requested through the domain services and executed by the real worker
// runtime and the real agent run handler.
//
//   npm run agent-runtime:smoke            # the scripted fake provider (default)
//   npm run agent-runtime:smoke -- --live  # the provider configured in the environment
//
// LOCAL AND MANUAL ONLY. No CI job runs it, and none may: it writes to the
// database it is pointed at, --live spends money on a provider, and a CI runner
// must never need a provider key. It exists as a package.json script and nothing
// else calls it; CI relies on the driver-backed proofs in engine/domain/*.dbtest.ts.
//
// WHAT IT DOES. In the seeded `dev` tenant (the local development seed only), it
// takes the first active department that has an active agent, creates a
// synthetic office-operations task there, assigns it to that agent, requests one
// task_assessment run under the key `smoke:<ISO timestamp>`, and runs the worker
// one job at a time until that run is finished or ten steps have passed. What it
// creates stays: the run, its job and its events are the record of what
// happened, and the domain's history is append-only.
//
// It refuses to start while any job is queued or leased. A worker leases the
// head of the WHOLE queue, whoever it belongs to, and the fake provider would
// answer another run with canned text recorded as that run's result.
//
// That check narrows the window; it does not close it. A job enqueued after the
// check commits and before the worker leases heads the queue whenever it sorts
// first (a lower priority value, or an earlier available_at), and the worker
// runs it. So the default mode also refuses, before it connects, unless
// ADMIN_DATABASE_URL and OPS_WORKER_DATABASE_URL both name the same database on
// this machine (engine/worker/testSupport/localDatabase.ts, the rule the
// driver-backed suites apply). Whatever can race the smoke is then a process on
// the developer's own machine, and a canned result can land only in local
// development data, never in a deployment's queue. --live keeps no such rule:
// its provider is real, so a job it picks up by that race gets the real call any
// worker would give it, on the database its operator chose.
//
// ENVIRONMENT. ADMIN_DATABASE_URL, the owner connection that creates the task and
// requests the run; OPS_WORKER_DATABASE_URL, the constrained worker login, which
// must pass the worker's own identity gate. Without --live both must name the
// same database on this machine (above). With --live the router is built by
// createModelRouterFromEnv exactly as the worker builds it, and when it has no
// `standard` route the command prints {"skipped": …} and exits 0 before it reads
// either connection string. The fake provider cannot be selected from the
// environment (routingConfig.ts); only this command's default uses it.
//
// OUTPUT. Identifiers, statuses, a step count and event types — never an
// environment value, the prompt, the result, or anything a provider sent. One
// JSON line on stdout once the run was driven; one JSON line on stderr on a
// failure, naming a code and the stage it failed in. A database error is
// reported by its SQLSTATE alone, because its message can name the user,
// database or host of a connection string. Exit 0 when the run succeeded or
// --live skipped, 1 when the run did not succeed or something failed, 2 on a
// usage error.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import {
  assertWorkerIdentity,
  createWorkerDatabase,
  WorkerIdentityError,
} from "../db/workerDatabase.ts";
import { requestAgentRun } from "../domain/agentRuns.ts";
import {
  isAgentRunStatus,
  isFinishedAgentRunStatus,
} from "../domain/agentRunStateMachine.ts";
import { assignTask, createTask } from "../domain/companyOs.ts";
import { CompanyOsError } from "../domain/errors.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { createModelRouter, type ModelRouter } from "../models/router.ts";
import { createModelRouterFromEnv } from "../models/routingConfig.ts";
import {
  TASK_ASSESSMENT_CAPABILITY,
  type TaskAssessment,
} from "../models/taskAssessment.ts";
import {
  assertLeaseFitsModelRoutes,
  LEASE_PREPARE_ALLOWANCE_MS,
  resolveWorkerId,
} from "../worker/main.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import {
  DEFAULT_LEASE_SAFETY_MARGIN_MS,
  runOneJob,
} from "../worker/runOneJob.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** The two variables this command reads besides the model routing ones. Named in errors; their values never are. */
export const ADMIN_DATABASE_URL = "ADMIN_DATABASE_URL";
export const OPS_WORKER_DATABASE_URL = "OPS_WORKER_DATABASE_URL";

export const SMOKE_SKIPPED =
  "no live provider configured (AGENT_MODEL_PROVIDER / OPENAI_API_KEY / AGENT_MODEL_STANDARD)";
export const SMOKE_SYNOPSIS = "npm run agent-runtime:smoke [-- --live]";

/** The route task_assessment runs on (ops.agent_run_capabilities()). */
const SMOKE_ROUTE = "standard";
const MAX_STEPS = 10;
const IDLE_WAIT_MS = 500;
const SOURCE = "agent-runtime-smoke";
const MIN_LEASE_SECONDS = 60;
const SQLSTATE = /^[0-9A-Z]{5}$/;

const FAKE_ASSESSMENT: TaskAssessment = Object.freeze({
  outcome: "completed",
  summary: "Order paper, toner and coffee before Friday.",
  proposed_next_steps: Object.freeze([
    "Check the stock list.",
    "Place the order with the usual supplier.",
  ]),
});

// The first active department, in a stable order, that has an active agent, in
// an active company of the `dev` tenant.
const DEV_AGENT_SQL = `select d.tenant_id, d.company_id, d.id as department_id, a.id as agent_id
  from ops.tenants t
  join ops.companies c on c.tenant_id = t.id and c.status = 'active'
  join ops.departments d on d.tenant_id = c.tenant_id and d.company_id = c.id and d.status = 'active'
  join ops.agents a on a.tenant_id = d.tenant_id and a.company_id = d.company_id
                   and a.department_id = d.id and a.status = 'active'
 where t.slug = 'dev'
 order by d.created_at, d.slug, a.created_at, a.slug
 limit 1`;

const REPORT_SQL = `select r.status, r.error_category, r.job_id,
       (select array_agg(e.type order by e.seq)
          from ops.events e
         where e.tenant_id = r.tenant_id and e.subject_type = 'agent_run' and e.subject_id = r.id) as event_types
  from ops.agent_runs r
 where r.id = $1`;

type Stage = "connect" | "identity" | "request" | "run" | "report";

export interface AgentRunSmokeDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Opens a pool. Production passes createWorkerDatabase. */
  readonly openDatabase: (
    connectionString: string,
    max: number,
  ) => WorkerDatabase;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

interface SmokeRun {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
}

type SmokeRequest =
  | { readonly kind: "requested"; readonly run: SmokeRun }
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly message: string;
    };

function fakeModelRouter(): ModelRouter {
  const provider = createFakeModelProvider({
    type: "respond",
    content: FAKE_ASSESSMENT,
  });
  return createModelRouter({
    routes: new Map([
      [SMOKE_ROUTE, { provider: provider.name, model: "fake-model-1" }],
    ]),
    providers: new Map([[provider.name, provider]]),
  });
}

/**
 * The error line. Only codes, and messages written in this file or the routing
 * config's variable-naming ones: a database's own message is never repeated.
 */
function failureLine(stage: Stage, error: unknown): string {
  if (error instanceof CompanyOsError) {
    return JSON.stringify({ error: error.code, stage });
  }
  if (error instanceof WorkerIdentityError) {
    return JSON.stringify({
      error: "worker_identity",
      stage,
      message: `${OPS_WORKER_DATABASE_URL} must name the constrained worker login (scripts/provision-worker-role.mjs), never the owner`,
    });
  }
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return JSON.stringify({
    error: typeof code === "string" && SQLSTATE.test(code) ? code : "failed",
    stage,
  });
}

/**
 * Why the default, fake-provider mode refuses these connection strings, or
 * undefined when both name the same database on this machine. Names the
 * variables, never their values.
 */
function localDatabaseRefusal(
  adminUrl: string,
  workerUrl: string,
): { readonly error: string; readonly message: string } | undefined {
  const admin = loopbackDatabaseTarget(adminUrl);
  const worker = loopbackDatabaseTarget(workerUrl);
  const notLocal = !admin
    ? ADMIN_DATABASE_URL
    : !worker
      ? OPS_WORKER_DATABASE_URL
      : undefined;
  if (notLocal) {
    return {
      error: "database_not_local",
      message: `${notLocal} must name a database on this machine (127.0.0.1, localhost or [::1]) unless --live is given: the fake provider records canned output as a run's result`,
    };
  }
  if (admin !== worker) {
    return {
      error: "databases_differ",
      message: `${ADMIN_DATABASE_URL} and ${OPS_WORKER_DATABASE_URL} must name the same host, port and database unless --live is given: the worker would lease another database's queue`,
    };
  }
  return undefined;
}

/** Creates the synthetic task and requests its run, unless the queue is busy or there is no agent. */
async function requestSmokeRun(tx: TxClient, now: Date): Promise<SmokeRequest> {
  const { rows: busy } = await tx.query<{ n: number }>(
    "select count(*)::int as n from ops.jobs where status in ('queued', 'leased')",
  );
  if (Number(busy[0]?.n ?? 0) > 0) {
    return {
      kind: "refused",
      error: "queue_not_empty",
      message:
        "jobs are queued or leased, and a worker leases the head of the whole queue; run the smoke on an idle queue",
    };
  }
  const { rows } = await tx.query<{
    tenant_id: string;
    company_id: string;
    department_id: string;
    agent_id: string;
  }>(DEV_AGENT_SQL);
  const found = rows[0];
  if (!found) {
    return {
      kind: "refused",
      error: "no_dev_agent",
      message:
        "the dev tenant has no active department with an active agent; the local development seed creates one",
    };
  }

  const context = { tenantId: found.tenant_id, source: SOURCE };
  const taskId = await createTask(tx, context, {
    companyId: found.company_id,
    departmentId: found.department_id,
    type: "operations.supply_order",
    title: "Prepare next week's office supply order",
    description: "Paper, toner and coffee are running low.",
  });
  await assignTask(tx, context, taskId, found.agent_id);
  const runId = await requestAgentRun(tx, context, {
    taskId,
    agentId: found.agent_id,
    capability: TASK_ASSESSMENT_CAPABILITY,
    idempotencyKey: `smoke:${now.toISOString()}`,
  });
  return {
    kind: "requested",
    run: { tenantId: found.tenant_id, taskId, runId },
  };
}

async function isRunFinished(
  owner: WorkerDatabase,
  runId: string,
): Promise<boolean> {
  const status = await owner.withTransaction(async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      "select status from ops.agent_runs where id = $1",
      [runId],
    );
    return rows[0]?.status;
  });
  return isAgentRunStatus(status) && isFinishedAgentRunStatus(status);
}

/** One job at a time, as the worker loop runs them, until the run is finished. Resolves to the step count. */
async function driveWorker(
  owner: WorkerDatabase,
  worker: WorkerDatabase,
  modelRouter: ModelRouter,
  leaseSeconds: number,
  runId: string,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  const registry = createHandlerRegistry({ modelRouter });
  const workerId = resolveWorkerId(
    SOURCE,
    hostname(),
    process.pid,
    randomUUID().slice(0, 8),
  );
  let steps = 0;
  while (steps < MAX_STEPS && !(await isRunFinished(owner, runId))) {
    steps += 1;
    const { outcome } = await runOneJob(worker, {
      workerId,
      registry,
      leaseSeconds,
    });
    if (outcome === "idle") await sleep(IDLE_WAIT_MS);
  }
  return steps;
}

async function readReport(tx: TxClient, runId: string) {
  const { rows } = await tx.query<{
    status: string;
    error_category: string | null;
    job_id: string | null;
    event_types: string[] | null;
  }>(REPORT_SQL, [runId]);
  const row = rows[0];
  if (!row) throw new Error("the smoke's agent run does not exist");
  return {
    jobId: row.job_id,
    status: row.status,
    errorCategory: row.error_category,
    eventTypes: row.event_types ?? [],
  };
}

/** Runs the smoke and resolves to the process exit code. Never rejects on a database failure. */
export async function runAgentRunSmoke(
  argv: readonly string[],
  deps: AgentRunSmokeDependencies,
): Promise<number> {
  const live = argv.length === 1 && argv[0] === "--live";
  if (argv.length > 0 && !live) {
    deps.stderr(
      JSON.stringify({
        error: "usage",
        message: "the only flag is --live",
        usage: SMOKE_SYNOPSIS,
      }),
    );
    return EXIT_USAGE;
  }

  let modelRouter: ModelRouter;
  try {
    modelRouter = live ? createModelRouterFromEnv(deps.env) : fakeModelRouter();
  } catch (error) {
    // The routing config names the variable at fault, never its value. Should a
    // message ever carry a value anyway, it is not printed.
    const message = error instanceof Error ? error.message : "";
    const carriesValue = Object.values(deps.env).some(
      (value) =>
        typeof value === "string" &&
        value.length >= 8 &&
        message.includes(value),
    );
    deps.stderr(
      JSON.stringify({
        error: "configuration",
        message:
          message && !carriesValue
            ? message
            : "the model routing environment is invalid",
      }),
    );
    return EXIT_FAILED;
  }
  if (live && modelRouter.resolve(SMOKE_ROUTE) === undefined) {
    deps.stdout(JSON.stringify({ skipped: SMOKE_SKIPPED }));
    return EXIT_OK;
  }

  const adminUrl = deps.env[ADMIN_DATABASE_URL];
  const workerUrl = deps.env[OPS_WORKER_DATABASE_URL];
  if (!adminUrl || !workerUrl) {
    const name = adminUrl ? OPS_WORKER_DATABASE_URL : ADMIN_DATABASE_URL;
    deps.stderr(
      JSON.stringify({
        error: "usage",
        message: `${name} is required, and is read from the environment only`,
        usage: SMOKE_SYNOPSIS,
      }),
    );
    return EXIT_USAGE;
  }
  if (!live) {
    const refusal = localDatabaseRefusal(adminUrl, workerUrl);
    if (refusal) {
      deps.stderr(JSON.stringify({ ...refusal, usage: SMOKE_SYNOPSIS }));
      return EXIT_USAGE;
    }
  }

  // The worker's own boot gate, on a lease long enough for the route's call.
  const leaseSeconds = Math.max(
    MIN_LEASE_SECONDS,
    Math.ceil(
      (LEASE_PREPARE_ALLOWANCE_MS +
        modelRouter.maxConfiguredTimeoutMs +
        DEFAULT_LEASE_SAFETY_MARGIN_MS) /
        1000,
    ),
  );
  assertLeaseFitsModelRoutes(leaseSeconds, modelRouter.maxConfiguredTimeoutMs);

  const opened: WorkerDatabase[] = [];
  let stage: Stage = "connect";
  try {
    const owner = deps.openDatabase(adminUrl, 1);
    opened.push(owner);
    const worker = deps.openDatabase(workerUrl, 2);
    opened.push(worker);

    stage = "identity";
    assertWorkerIdentity(await worker.identity());

    stage = "request";
    const request = await owner.withTransaction((tx) =>
      requestSmokeRun(tx, deps.now()),
    );
    if (request.kind === "refused") {
      deps.stderr(
        JSON.stringify({
          error: request.error,
          stage,
          message: request.message,
        }),
      );
      return EXIT_FAILED;
    }

    stage = "run";
    const steps = await driveWorker(
      owner,
      worker,
      modelRouter,
      leaseSeconds,
      request.run.runId,
      deps.sleep,
    );

    stage = "report";
    const report = await owner.withTransaction((tx) =>
      readReport(tx, request.run.runId),
    );
    deps.stdout(
      JSON.stringify({
        mode: live ? "live" : "fake",
        tenantId: request.run.tenantId,
        taskId: request.run.taskId,
        runId: request.run.runId,
        ...report,
        steps,
      }),
    );
    return report.status === "succeeded" ? EXIT_OK : EXIT_FAILED;
  } catch (error) {
    deps.stderr(failureLine(stage, error));
    return EXIT_FAILED;
  } finally {
    for (const db of opened.reverse()) {
      try {
        await db.close();
      } catch (error) {
        deps.stderr(failureLine(stage, error));
      }
    }
  }
}

// `import.meta.url === \`file://${process.argv[1]}\`` is never true on Windows,
// so this uses pathToFileURL, as engine/worker/main.ts does.
const isEntryPoint = async (): Promise<boolean> => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await isEntryPoint()) {
  process.exitCode = await runAgentRunSmoke(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString, max) =>
      createWorkerDatabase({ connectionString, max }),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
