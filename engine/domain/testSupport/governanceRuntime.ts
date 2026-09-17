// Shared fixtures for the runtime governance driver suites (ADR 0017): offices
// whose agent and task text a case chooses, several runs on one task, the real
// production registry behind a model router the case can also read, worker
// loops started and stopped together, and a sampler that watches a tenant's
// spend while they run.
//
// It lives in engine/domain because only there may code import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). Everything else a governance case needs from the database
// is SQL on the admin pool (engine/worker/testSupport/spendProbes.ts). All data
// is synthetic office-operations text.

import type { Pool } from "pg";
import type { WorkerDatabase } from "../../db/types.ts";
import { createWorkerDatabase } from "../../db/workerDatabase.ts";
import {
  createModelRouter,
  type ModelRouter,
  type ResolvedModelRoute,
} from "../../models/router.ts";
import type { ModelProvider } from "../../models/types.ts";
import {
  createRegistry,
  type HandlerRegistry,
} from "../../worker/handlerRegistry.ts";
import type { WorkerLogEvent, WorkerLogFields } from "../../worker/log.ts";
import { createHandlerRegistry } from "../../worker/registry.ts";
import {
  runWorker,
  type RunWorkerOptions,
  type WorkerStats,
} from "../../worker/runWorker.ts";
import {
  ADMIN_URL,
  adminPool,
  cleanupFixtures,
  provisionWorkerRole,
  workerDatabase,
} from "../../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "../agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "../companyOs.ts";
import { agentRunHandler } from "./agentRuntimeProbes.ts";

export const GOVERNANCE_SOURCE = "dbtest-governance";
export const PRICED_MODEL = "fake-model-1";

export interface GovernanceDatabases {
  readonly admin: Pool;
  /** Owner transactions: the worker's adapter pointed at the admin connection. */
  readonly owner: WorkerDatabase;
  /** The worker's database, with room for several loops at once. */
  readonly db: WorkerDatabase;
}

export function openGovernanceDatabases(): GovernanceDatabases {
  provisionWorkerRole();
  return {
    admin: adminPool(),
    owner: createWorkerDatabase({ connectionString: ADMIN_URL, max: 4 }),
    db: workerDatabase(8),
  };
}

export async function closeGovernanceDatabases(
  databases: Partial<GovernanceDatabases>,
): Promise<void> {
  await databases.db?.close();
  await databases.owner?.close();
  await cleanupFixtures(databases.admin);
  await databases.admin?.end();
}

/** The text an office's agent and task carry. */
export interface OfficeText {
  readonly agentName: string;
  readonly agentRole: string;
  readonly agentDescription: string | null;
  readonly taskTitle: string;
  readonly taskDescription: string | null;
}

export const PLAIN_OFFICE: OfficeText = Object.freeze({
  agentName: "Office assistant",
  agentRole: "Operations assistant",
  agentDescription: "Keeps the office stocked and orders supplies.",
  taskTitle: "Prepare next week's office supply order",
  taskDescription: "Paper, toner and coffee are running low.",
});

export interface GovernedOffice {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
  readonly taskId: string;
}

/** One company, department and agent, and one task assigned to that agent. */
export function buildGovernedOffice(
  owner: WorkerDatabase,
  tenantId: string,
  slug: string,
  text: OfficeText = PLAIN_OFFICE,
): Promise<GovernedOffice> {
  return owner.withTransaction(async (tx) => {
    const ctx = { tenantId, source: GOVERNANCE_SOURCE };
    const companyId = await createCompany(tx, ctx, { slug, name: "Office" });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "operations",
      name: "Operations",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "office-assistant",
      name: text.agentName,
      role: text.agentRole,
      description: text.agentDescription ?? undefined,
    });
    const taskId = await createTask(tx, ctx, {
      companyId,
      departmentId,
      type: "operations.supply_order",
      title: text.taskTitle,
      description: text.taskDescription ?? undefined,
      dueAt: new Date("2026-09-21T12:00:00Z"),
    });
    await assignTask(tx, ctx, taskId, agentId);
    return { tenantId, companyId, departmentId, agentId, taskId };
  });
}

/** One run per key on the office's task, each requested and committed on its own. */
export async function requestRuns(
  owner: WorkerDatabase,
  office: GovernedOffice,
  keys: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const idempotencyKey of keys) {
    ids.push(
      await owner.withTransaction((tx) =>
        requestAgentRun(
          tx,
          { tenantId: office.tenantId, source: GOVERNANCE_SOURCE },
          {
            taskId: office.taskId,
            agentId: office.agentId,
            capability: "task_assessment",
            idempotencyKey,
          },
        ),
      ),
    );
  }
  return ids;
}

export interface GovernedRuntime {
  readonly router: ModelRouter;
  /** The `standard` route every task_assessment run takes. */
  readonly route: ResolvedModelRoute;
  /** The production registry, its `standard` route served by `provider`. */
  readonly registry: HandlerRegistry;
}

/** The production registry and its router, the `standard` route naming `model`. */
export function governedRuntime(
  provider: ModelProvider,
  model: string = PRICED_MODEL,
): GovernedRuntime {
  const router = createModelRouter({
    routes: new Map([["standard", { provider: provider.name, model }]]),
    providers: new Map([[provider.name, provider]]),
  });
  const route = router.resolve("standard");
  if (!route) throw new Error("the standard route did not resolve");
  return {
    router,
    route,
    registry: createHandlerRegistry({ modelRouter: router }),
  };
}

/**
 * The production agent run handler, recording every claim the database hands
 * it before the handler reads it. Nothing about the claim is changed.
 */
export function capturingClaims(registry: HandlerRegistry): {
  readonly registry: HandlerRegistry;
  readonly claims: unknown[];
} {
  const handler = agentRunHandler(registry);
  const claims: unknown[] = [];
  const recording = {
    ...handler,
    prepare: ((job, capabilities, budget) =>
      handler.prepare(
        job,
        {
          ...capabilities,
          claimAgentRun: async () => {
            const claim = await capabilities.claimAgentRun();
            claims.push(claim);
            return claim;
          },
        },
        budget,
      )) as typeof handler.prepare,
  };
  return { registry: createRegistry([recording]), claims };
}

export interface LoggedEvent {
  readonly event: WorkerLogEvent;
  readonly fields: WorkerLogFields;
}

export interface RunningWorkers {
  /** Every log line the loops emitted, in order. */
  readonly events: readonly LoggedEvent[];
  /** Aborts every loop and resolves to their stats once each has stopped. */
  stop(): Promise<WorkerStats[]>;
}

/** Starts one real worker loop per id, sharing `db`, `registry` and a log. */
export function startWorkers(
  db: WorkerDatabase,
  registry: HandlerRegistry,
  workerIds: readonly string[],
  options: Partial<RunWorkerOptions> = {},
): RunningWorkers {
  const controller = new AbortController();
  const events: LoggedEvent[] = [];
  const loops = Promise.all(
    workerIds.map((workerId) =>
      runWorker({
        workerId,
        db,
        registry,
        signal: controller.signal,
        pollIntervalMs: 25,
        heartbeatIntervalMs: 60_000,
        reapIntervalMs: 60_000,
        leaseSeconds: 60,
        log: (event, fields = {}) => {
          events.push({ event, fields });
        },
        ...options,
      }),
    ),
  );
  loops.catch(() => undefined);
  return {
    events,
    async stop() {
      controller.abort();
      return loops;
    },
  };
}

export interface SpendSamples {
  readonly samples: number;
  readonly maxCharged: bigint;
  readonly maxRunning: number;
}

/**
 * Samples one tenant's charged spend today, and its running runs, in a single
 * statement each time, until stopped: a witness of what admission let through
 * at every moment it was looked at.
 */
export function sampleTenantSpend(
  admin: Pool,
  tenantId: string,
): { stop(): Promise<SpendSamples> } {
  let stopped = false;
  let samples = 0;
  let maxCharged = 0n;
  let maxRunning = 0;
  const loop = (async () => {
    while (!stopped) {
      const { rows } = await admin.query<{ charged: string; running: number }>(
        `select coalesce(sum(charged_cost_micros), 0)::text as charged,
                count(*) filter (where status = 'running')::int as running
           from ops.agent_runs
          where tenant_id = $1
            and started_at >= ops.spend_window_start('UTC', now())`,
        [tenantId],
      );
      samples += 1;
      const charged = BigInt(rows[0].charged);
      if (charged > maxCharged) maxCharged = charged;
      maxRunning = Math.max(maxRunning, Number(rows[0].running));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { samples, maxCharged, maxRunning };
    },
  };
}
