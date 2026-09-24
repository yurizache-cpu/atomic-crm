// The Phase 2E demonstration: synthetic activity for the owner's "Saúde
// operacional" screen, run by the REAL worker loop with the worker's REAL
// metrics listener, on a local database.
//
//   COMPANY_OS_SYNTHETIC_INGRESS=enabled METRICS_ENABLED=true METRICS_PORT=9464 \
//     npm run observability:demo
//
// LOCAL AND MANUAL ONLY, like lead-triage:demo, whose governance and admission
// it reuses. No CI job runs it.
//
// WHAT IT DOES: admits SIX fictitious leads (the Phase 2A synthetic message,
// never real text), then runs runWorker, the worker loop itself, until the
// queue is empty. Five runs answer, after short delays, with the canned
// triage advice; the sixth meets a scripted provider 5xx, so its run is
// recorded "indeterminate", exactly as a real ambiguous failure is, and
// nothing retries it. Each succeeded run opens a pending review and, with the
// FAKE decision provider, one shadow evaluation. The reviews are left pending
// for the owner. Then it holds the metrics listener open (DEMO_HOLD_SECONDS,
// default 20) so Prometheus can scrape it, prints what it produced, and stops.
//
// THE PROVIDERS ARE THE FAKE ONES: no model, decision service or WhatsApp is
// called, Q8 stays open, and nothing is sent or written to the CRM.

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { createFakeDecisionProvider } from "../decision/fakeDecisionProvider.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import { CompanyOsError } from "../domain/errors.ts";
import { admitInboundMessage } from "../domain/leadIntake.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import { createModelRouter } from "../models/router.ts";
import { startWorkerObservability } from "../telemetry/fromEnv.ts";
import { createLogger, type WorkerLogger } from "../worker/log.ts";
import { createHandlerRegistry } from "../worker/registry.ts";
import { runWorker } from "../worker/runWorker.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";
import {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  isEntryPoint,
  jsonLine,
} from "./cliOutput.ts";
import {
  CANNED_ADVICE,
  configureFakeGovernance,
  DEMO_CONTACT,
  DEMO_CONTACT_POLICY,
  MODEL,
  queueIsBusy,
  readPlacement,
  SYNTHETIC_BODY,
} from "./leadTriageDemo.ts";

const WORKER_DATABASE_URL = "OPS_WORKER_DATABASE_URL";
const SOURCE = "observability-demo";
const LEADS = 6;
/** The 1-based provider call that meets a scripted 5xx. */
const AMBIGUOUS_CALL = 4;
const MAX_WAIT_MS = 60_000;

export interface ObservabilityDemoDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
  readonly log?: WorkerLogger;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const JOBS_LIVE_SQL =
  "select count(*)::int as n from ops.jobs where status in ('queued', 'leased') and available_at <= now()";

const SUMMARY_SQL = `select
    (select jsonb_object_agg(s.status, s.n) from (select status, count(*) as n from ops.agent_runs
       where tenant_id = $1 and requested_by = $2 group by status) s) as runs,
    (select count(*)::int from ops.review_items v join ops.agent_runs r on r.tenant_id = v.tenant_id and r.id = v.agent_run_id
      where v.tenant_id = $1 and r.requested_by = $2 and v.status = 'pending') as pending_reviews,
    (select jsonb_object_agg(s.status, s.n) from (select e.status, count(*) as n from ops.decision_evaluations e
       join ops.review_items v on v.tenant_id = e.tenant_id and v.id = e.review_item_id
       join ops.agent_runs r on r.tenant_id = v.tenant_id and r.id = v.agent_run_id
      where e.tenant_id = $1 and r.requested_by = $2 group by e.status) s) as decisions`;

export async function runObservabilityDemo(
  dependencies: ObservabilityDemoDependencies,
): Promise<number> {
  const { env, stdout, stderr, openDatabase } = dependencies;
  const log = dependencies.log ?? createLogger(() => {});

  let port;
  try {
    port = createSyntheticCommunicationPort(env);
  } catch (error) {
    stderr(
      jsonLine({
        error: "ingress_disabled",
        message: (error as Error).message,
      }),
    );
    return EXIT_USAGE;
  }
  const adminUrl = env[ADMIN_DATABASE_URL];
  const workerUrl = env[WORKER_DATABASE_URL];
  const ownerTarget = adminUrl ? loopbackDatabaseTarget(adminUrl) : undefined;
  const workerTarget = workerUrl
    ? loopbackDatabaseTarget(workerUrl)
    : undefined;
  if (!ownerTarget || !workerTarget || ownerTarget !== workerTarget) {
    stderr(
      jsonLine({
        error: "configuration",
        message: `${ADMIN_DATABASE_URL} and ${WORKER_DATABASE_URL} must both name the same database on this machine`,
      }),
    );
    return EXIT_USAGE;
  }
  const holdSeconds = Number.parseInt(env.DEMO_HOLD_SECONDS ?? "20", 10);

  const owner = openDatabase(adminUrl as string);
  const db = openDatabase(workerUrl as string);
  const observability = await startWorkerObservability(env, log);
  const controller = new AbortController();
  try {
    if (await owner.withTransaction(queueIsBusy)) {
      stderr(
        jsonLine({
          error: "queue_busy",
          message:
            "a job is queued or leased on this database; the demonstration would answer it with canned text",
        }),
      );
      return EXIT_REFUSED;
    }
    const placement = await owner.withTransaction(readPlacement);
    await owner.withTransaction((tx) =>
      configureFakeGovernance(tx, placement.tenantId, new Date()),
    );

    // Short, varied delays, so the latency is a distribution and not zeros.
    const provider = createFakeModelProvider((_request, index) =>
      index + 1 === AMBIGUOUS_CALL
        ? { type: "fail", category: "provider_5xx", code: "demo_503" }
        : {
            type: "delay",
            ms: 250 + index * 130,
            then: { type: "respond", content: CANNED_ADVICE },
          },
    );
    const registry = createHandlerRegistry({
      modelRouter: createModelRouter({
        routes: new Map([
          ["standard", { provider: provider.name, model: MODEL }],
        ]),
        providers: new Map([[provider.name, provider]]),
      }),
      decisionPort: createFakeDecisionProvider(),
      requestsShadowDecisions: true,
    });

    for (let lead = 0; lead < LEADS; lead += 1) {
      const message = port.receive({
        external_message_id: `observability-demo-${randomUUID()}`,
        contact_ref: DEMO_CONTACT,
        body: SYNTHETIC_BODY,
        received_at: new Date().toISOString(),
      });
      await owner.withTransaction((tx) =>
        admitInboundMessage(
          tx,
          placement,
          message,
          DEMO_CONTACT_POLICY,
          SOURCE,
        ),
      );
    }
    stdout(jsonLine({ step: "admitted", leads: LEADS }));

    const worker = runWorker({
      workerId: `observability-demo-${hostname()}-${process.pid}`,
      db,
      registry,
      signal: controller.signal,
      pollIntervalMs: 200,
      reapIntervalMs: 2_000,
      heartbeatIntervalMs: 5_000,
      log,
      telemetry: observability.telemetry,
    });

    const startedAt = Date.now();
    for (;;) {
      await sleep(1_000);
      const { rows } = await owner.withTransaction((tx) =>
        tx.query<{ n: number }>(JOBS_LIVE_SQL, []),
      );
      if (Number(rows[0]?.n ?? 0) === 0 || Date.now() - startedAt > MAX_WAIT_MS)
        break;
    }
    stdout(jsonLine({ step: "worked", providerCalls: provider.calls.length }));

    if (Number.isFinite(holdSeconds) && holdSeconds > 0) {
      stdout(jsonLine({ step: "holding_for_scrape", seconds: holdSeconds }));
      await sleep(holdSeconds * 1_000);
    }
    controller.abort();
    await worker;

    const summary = await owner.withTransaction(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(SUMMARY_SQL, [
        placement.tenantId,
        SOURCE,
      ]);
      return rows[0];
    });
    stdout(
      jsonLine({
        step: "summary",
        ...summary,
        outboundMessagesSent: 0,
        note: "reviews stay pending for the owner; accepting one sends nothing",
      }),
    );
    return EXIT_OK;
  } catch (error) {
    stderr(
      jsonLine({
        error: error instanceof CompanyOsError ? error.code : "unexpected",
        message:
          error instanceof Error ? error.message : "the demonstration failed",
      }),
    );
    return EXIT_REFUSED;
  } finally {
    controller.abort();
    await observability.close();
    await db.close();
    await owner.close();
  }
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runObservabilityDemo({
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 4 }),
  });
}
