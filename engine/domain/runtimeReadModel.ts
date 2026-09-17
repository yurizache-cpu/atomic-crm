// The owner's read model of the runtime (ADR 0017 §9): what `npm run ops` shows.
//
// READS ONLY. Every function here is a plain, parameterised read. The operator
// CLI runs each inside a read-only transaction, so none can change anything even
// by mistake. They print ids, statuses, categories, codes, token counts and
// costs — never a run's result, a prompt, task or agent text, an idempotency
// key, a correlation id, a connection string or a key.
//
// WHO CAN CALL THIS: a transaction running as the database owner. The tables and
// functions read here are granted to no application role, and several of the
// functions raise rather than answer when row security would hide rows from their
// caller, because a filtered read would under-report.
//
// The module is split for size: runs in runtimeReadModelRuns.ts, worker routes in
// runtimeReadModelRoutes.ts, the one-object status here. All are exported here.

import type { TxClient } from "../db/types.ts";
import {
  isAgentRunStatus,
  type AgentRunStatus,
} from "./agentRunStateMachine.ts";
import {
  EXECUTION_STOP_SCOPES,
  type ExecutionStopOrigin,
  type ExecutionStopScope,
} from "./executionStops.ts";
import { ATTENTION_WHERE, readRows } from "./runtimeReadModelRuns.ts";
import {
  listTenantsWithoutBudget,
  readSpendStatus,
  type SpendStatusRow,
  type TenantWithoutBudget,
} from "./spendLimits.ts";

export {
  DEFAULT_LISTED_RUNS,
  MAX_LISTED_RUNS,
  listRecentRuns,
  listRunsNeedingAttention,
  type AttentionRunRow,
  type RecentRunsOptions,
  type RunAttention,
  type RuntimeRunRow,
} from "./runtimeReadModelRuns.ts";
export {
  MAX_LISTED_WORKERS,
  listWorkerRoutes,
  type PublishedRouteView,
  type WorkerDetailState,
  type WorkerRoutesRow,
} from "./runtimeReadModelRoutes.ts";

/** The held-job scan reads at most this many queued jobs, head of the queue first. */
export const HELD_JOB_SCAN_LIMIT = 10_000;

export interface ActiveStopCount {
  readonly scope: ExecutionStopScope;
  readonly origin: ExecutionStopOrigin;
  readonly count: number;
}

export interface HeldJobs {
  /**
   * Queued jobs an active stop holds, among those scanned: every kind that is not
   * internal, so an external kind and a kind nobody classified alike.
   */
  readonly held: number;
  readonly scanned: number;
  readonly scanLimit: number;
  /** False when the scan reached its cap: `held` is then a lower bound. */
  readonly complete: boolean;
}

export interface RuntimeStatus {
  /** The database's now(), in UTC. */
  readonly generatedAt: string;
  readonly activeStops: readonly ActiveStopCount[];
  readonly runsStartedToday: {
    /** UTC midnight. */
    readonly since: string;
    /** Only the statuses that occur; an absent status counts zero. */
    readonly byStatus: Readonly<Partial<Record<AgentRunStatus, number>>>;
  };
  readonly heldJobs: HeldJobs;
  readonly runsNeedingAttention: number;
  readonly spend: readonly SpendStatusRow[];
  /**
   * Whether an active global daily ceiling exists. Without one every agent run
   * is refused (spend_ceiling_unconfigured), whatever the other rows say.
   */
  readonly globalCeilingConfigured: boolean;
  /**
   * Tenants with no active daily budget: every agent run they request is
   * refused (budget_unconfigured, unless the global ceiling refuses it first).
   */
  readonly tenantsWithoutBudget: readonly TenantWithoutBudget[];
}

const UTC = (expression: string): string =>
  `to_char(${expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const STOPS_SQL = `select s.scope, s.origin, count(*)::int as count
  from ops.execution_stops s
 where s.cleared_at is null
 group by s.scope, s.origin
 order by s.scope, s.origin`;

const RUNS_TODAY_SQL = `select ${UTC("w.since")} as since, ${UTC("w.at")} as generated_at,
       r.status, count(r.id)::int as count
  from (select now() as at,
               date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as since) w
  left join ops.agent_runs r on r.started_at >= w.since
 group by w.since, w.at, r.status
 order by r.status nulls first`;

// The lease filter's own evaluator (ops.job_covering_stop), over the head of the
// queue in the lease's own order. A deferred job waits with a later available_at
// and is still queued, so it is counted. With no active stop nothing is
// evaluated, as at the lease.
const HELD_JOBS_SQL = `select count(*)::int as scanned,
       count(*) filter (
         where case when exists (select 1 from ops.execution_stops s where s.cleared_at is null)
                    then ops.job_covering_stop(q.tenant_id, q.id, q.kind) is not null
                    else false end)::int as held
  from (select j.tenant_id, j.id, j.kind
          from ops.jobs j
         where j.status = 'queued'
           and not (j.kind = any (ops.internal_job_kinds()))
         order by j.priority, j.available_at, j.created_at, j.id
         limit $1) q`;

const ATTENTION_COUNT_SQL = `select count(*)::int as count
  from ops.agent_runs r
 where ${ATTENTION_WHERE}`;

const toCount = (value: unknown): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("the runtime status read returned a count that is not one");
  }
  return count;
};

async function readActiveStops(
  tx: TxClient,
): Promise<readonly ActiveStopCount[]> {
  const rows = await readRows<{ scope: string; origin: string; count: number }>(
    tx,
    STOPS_SQL,
    [],
  );
  return rows.map((row) => {
    if (
      !(EXECUTION_STOP_SCOPES as readonly string[]).includes(row.scope) ||
      (row.origin !== "owner" && row.origin !== "system")
    ) {
      throw new Error(
        "ops.execution_stops returned an unknown scope or origin",
      );
    }
    return {
      scope: row.scope as ExecutionStopScope,
      origin: row.origin,
      count: toCount(row.count),
    };
  });
}

async function readRunsToday(tx: TxClient) {
  const rows = await readRows<{
    since: string;
    generated_at: string;
    status: string | null;
    count: number;
  }>(tx, RUNS_TODAY_SQL, []);
  const first = rows[0];
  if (first === undefined) {
    throw new Error("the runs-today read returned no window");
  }
  const byStatus: Partial<Record<AgentRunStatus, number>> = {};
  for (const row of rows) {
    if (row.status === null) continue;
    if (!isAgentRunStatus(row.status)) {
      throw new Error("ops.agent_runs returned a run with an unknown status");
    }
    byStatus[row.status] = toCount(row.count);
  }
  return {
    generatedAt: first.generated_at,
    runsStartedToday: { since: first.since, byStatus },
  };
}

async function readHeldJobs(tx: TxClient): Promise<HeldJobs> {
  const [row] = await readRows<{ scanned: number; held: number }>(
    tx,
    HELD_JOBS_SQL,
    [HELD_JOB_SCAN_LIMIT],
  );
  const scanned = toCount(row?.scanned);
  return {
    held: toCount(row?.held),
    scanned,
    scanLimit: HELD_JOB_SCAN_LIMIT,
    complete: scanned < HELD_JOB_SCAN_LIMIT,
  };
}

/** One object: what is stopped, what ran today, what is held, what needs a person, and spend. */
export async function readRuntimeStatus(tx: TxClient): Promise<RuntimeStatus> {
  // Sequential: one transaction is one connection.
  const activeStops = await readActiveStops(tx);
  const { generatedAt, runsStartedToday } = await readRunsToday(tx);
  const heldJobs = await readHeldJobs(tx);
  const [attention] = await readRows<{ count: number }>(
    tx,
    ATTENTION_COUNT_SQL,
    [null],
  );
  const spend = await readSpendStatus(tx);
  const tenantsWithoutBudget = await listTenantsWithoutBudget(tx);
  return {
    generatedAt,
    activeStops,
    runsStartedToday,
    heldJobs,
    runsNeedingAttention: toCount(attention?.count),
    spend,
    globalCeilingConfigured: spend.some((row) => row.scope === "global"),
    tenantsWithoutBudget,
  };
}
