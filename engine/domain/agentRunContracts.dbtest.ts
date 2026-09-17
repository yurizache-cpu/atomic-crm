// What the agent runtime shares with the database, against a real Postgres
// through the real `pg` driver and the real worker runtime:
//
//   * engine/models/errors.ts maps every failure category to the run status
//     the database decides, and malformed output is recorded as the database
//     says;
//   * a pooled connection carries nothing of an agent run into the next
//     transaction;
//   * the driver-backed test workers and fixture refuse any database that is
//     not on this machine;
//   * the TypeScript agent run state machine is the database's relation.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import {
  agentRunStatusForCategory,
  MODEL_ERROR_CATEGORIES,
} from "../models/errors.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { testChildEnvironment } from "../worker/testSupport/childEnvironment.ts";
import {
  ADMIN_URL,
  resetFixtures,
  workerDatabase,
} from "../worker/testSupport/dbFixture.ts";
import { loopbackDatabaseTarget } from "../worker/testSupport/localDatabase.ts";
import {
  AGENT_RUN_STATUSES,
  AGENT_RUN_TRANSITIONS,
  canTransitionAgentRun,
  type AgentRunStatus,
} from "./agentRunStateMachine.ts";
import { spawnAgentRunWorker } from "./testSupport/agentRunProcesses.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  MODEL,
  openAgentRuntimeDatabases,
  rejectionOf,
  VALID,
  withinMs,
  WORKER,
} from "./testSupport/agentRuntimeProbes.ts";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

beforeEach(async () => {
  await resetFixtures(admin);
});

const {
  buildOfficeTask,
  countJobs,
  readRun,
  requestRun,
  runAgentJob,
  runEvents,
} = agentRuntimeProbes(() => ({ admin, owner, db }));

// ---------------------------------------------------------------------------
// 5 and 6. Failure categories and malformed output
// ---------------------------------------------------------------------------

async function databaseStatusByCategory(): Promise<Map<string, string | null>> {
  const { rows } = await admin.query<{
    category: string;
    status: string | null;
  }>(
    "select c as category, ops.agent_run_error_status(c) as status from unnest($1::text[]) as c",
    [[...MODEL_ERROR_CATEGORIES]],
  );
  return new Map(rows.map((row) => [row.category, row.status]));
}

describe("model failures", () => {
  // What the SQL suite cannot prove: that engine/models/errors.ts, which the
  // worker reasons with, is the same mapping the database applies, for every
  // category the worker can report.
  it("agree with the database on the run status of every MODEL_ERROR_CATEGORIES entry", async () => {
    const database = await databaseStatusByCategory();
    expect(database.size).toBe(MODEL_ERROR_CATEGORIES.length);
    for (const category of MODEL_ERROR_CATEGORIES) {
      expect(database.get(category), category).not.toBeNull();
      expect(agentRunStatusForCategory(category), category).toBe(
        database.get(category),
      );
    }
  });

  // What the SQL suite cannot prove: that each category a provider failure
  // can carry survives the router, the handler and ops.fail_agent_run as
  // itself (never coerced to `unknown`), in the status the DATABASE derives,
  // with exactly one call per run.
  it("land every MODEL_ERROR_CATEGORIES entry in the status the database decides, through a real run", async () => {
    const office = await buildOfficeTask();
    const database = await databaseStatusByCategory();

    for (const category of MODEL_ERROR_CATEGORIES) {
      const runId = await requestRun(office, `category-${category}`);
      const { provider, registry } = fakeRuntime({
        type: "fail",
        category,
        code: "dbtest_failure",
      });

      const result = await runAgentJob(registry);

      expect(result.outcome, category).toBe("succeeded");
      expect(provider.calls, category).toHaveLength(1);
      expect(await readRun(runId), category).toMatchObject({
        status: database.get(category),
        error_category: category,
        error_code: "dbtest_failure",
        result: null,
      });
    }
  }, 60_000);

  // What the SQL suite cannot prove: that an answer the output contract
  // refuses is recorded as the paid call it was — usage and provider ids kept,
  // no result stored — rather than dropped or retried.
  it("record malformed model output as failed schema_validation, keeping its usage and storing no result", async () => {
    const office = await buildOfficeTask();
    const runId = await requestRun(office, "malformed-output");
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: { ...VALID, proposed_next_steps: "not a list" },
    });

    const result = await runAgentJob(registry);

    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);
    expect(await readRun(runId)).toMatchObject({
      status: "failed",
      error_category: "schema_validation",
      error_code: "contract_mismatch",
      result: null,
      response_model: MODEL,
      provider_response_id: "fake-resp-1",
      input_tokens: 120,
      output_tokens: 60,
      total_tokens: 180,
    });
    const events = await runEvents(runId);
    expect(events.map((e) => e.type)).toEqual([
      "agent_run.requested",
      "agent_run.started",
      "agent_run.failed",
    ]);
    expect(events[2].payload).toEqual({
      from_status: "running",
      to_status: "failed",
      error_category: "schema_validation",
      error_code: "contract_mismatch",
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 10. Pooling
// ---------------------------------------------------------------------------

describe("a pooled connection after an agent run", () => {
  // What the SQL suite cannot prove: the driver's connection REUSE. With one
  // socket, the transaction after an agent run provably runs on the backend
  // the run's three transactions used, and it must carry no role, lease,
  // tenant or event provenance the capabilities installed — and a capability
  // called on it must refuse.
  it("carries no role, lease, tenant or event provenance into the next transaction, and the run capabilities refuse on it", async () => {
    const pooled = workerDatabase(1);
    try {
      const backendPid = () =>
        pooled.withTransaction(async (tx) => {
          const { rows } = await tx.query<{ pid: number }>(
            "select pg_backend_pid() as pid",
          );
          return rows[0].pid;
        });
      const pidBefore = await backendPid();
      const office = await buildOfficeTask();
      await requestRun(office, "pooled");
      const { provider, registry } = fakeRuntime({
        type: "respond",
        content: VALID,
      });

      const result = await runOneJob(pooled, { workerId: WORKER, registry });
      expect(result.outcome).toBe("succeeded");
      expect(provider.calls).toHaveLength(1);

      const after = await pooled.withTransaction(async (tx) => {
        const { rows: session } = await tx.query<Record<string, unknown>>(
          `select pg_backend_pid() as pid,
                  current_user::text as role,
                  nullif(current_setting('app.job_id', true), '') as job,
                  nullif(current_setting('app.worker_id', true), '') as worker,
                  nullif(current_setting('app.event_source', true), '') as event_source,
                  nullif(current_setting('app.event_correlation_id', true), '') as correlation,
                  nullif(current_setting('app.event_causation_id', true), '') as causation`,
        );
        await tx.query("set local role ops_worker");
        const { rows: scoped } = await tx.query<Record<string, unknown>>(
          `select ops.current_tenant_id()::text as tenant,
                  (select count(*) from ops.jobs)::int as jobs`,
        );
        return { ...session[0], ...scoped[0] };
      });
      expect(after).toEqual({
        pid: pidBefore,
        role: "ops_worker_login",
        job: null,
        worker: null,
        event_source: null,
        correlation: null,
        causation: null,
        tenant: null,
        jobs: 0,
      });
      // The table is not empty; the connection simply sees none of it.
      expect(await countJobs(office.tenantId)).toBe(1);

      const refused = await rejectionOf(
        pooled.withTransaction(async (tx) => {
          await tx.query("set local role ops_worker");
          await tx.query("select ops.claim_agent_run()");
        }),
      );
      expect(refused).toMatchObject({ code: "42501" });
      expect((refused as Error).message).toMatch(/no live lease, so no tenant/);
      expect(await backendPid()).toBe(pidBefore);
    } finally {
      await pooled.close();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The test workers stay on this machine
// ---------------------------------------------------------------------------

describe("the database a driver-backed worker may be pointed at", () => {
  // What no other case can prove: the spawned test worker answers whatever run
  // heads the queue with a canned assessment, so pointed at a deployment (an
  // exported OPS_WORKER_DATABASE_URL is enough) it would record fake results
  // there. It must refuse before it opens a connection, naming no part of the
  // connection string.
  it("refuses a worker process pointed at a database that is not on this machine, before connecting and without printing the connection string", async () => {
    const remote =
      "postgresql://ops_worker_login:dbtest-remote-pw@192.0.2.10:5432/postgres";
    const worker = spawnAgentRunWorker("dbtest-agent-remote", "respond", {
      OPS_WORKER_DATABASE_URL: remote,
    });

    const exit = await (async () => {
      try {
        return await withinMs(
          worker.closed,
          15_000,
          "the worker did not refuse a remote database before trying to reach it",
        );
      } finally {
        worker.child.kill("SIGKILL");
      }
    })();

    expect(exit.code).toBe(2);
    expect(exit.stdout).toBe("");
    expect(exit.stderr).toMatch(
      /OPS_WORKER_DATABASE_URL must name a database on this machine/,
    );
    for (const piece of [
      "dbtest-remote-pw",
      "192.0.2.10",
      "ops_worker_login",
    ]) {
      expect(exit.stderr).not.toContain(piece);
    }
  }, 30_000);

  // What the helper's unit tests cannot prove: that the shared fixture every
  // driver-backed suite imports actually applies the check, before it
  // provisions a role or opens a pool, when the production worker's variable
  // names another database on this machine: the other working copy's stack, or
  // another database on the fixture's own server.
  //
  // Both are derived from the fixture's own database, never written as fixed
  // addresses: CI's only stack listens on 54322, the port the other working copy
  // uses here, so a fixed "other" address can be the fixture's own database.
  it("refuses to load the driver-backed fixture when OPS_WORKER_DATABASE_URL names another database", async () => {
    const fixture = new URL(
      "../worker/testSupport/dbFixture.ts",
      import.meta.url,
    ).href;
    const own = new URL(ADMIN_URL);
    const otherPort = own.port === "54322" ? "54342" : "54322";
    const others = [
      `postgresql://ops_worker_login:dbtest-other-pw@${own.hostname}:${otherPort}${own.pathname}`,
      `postgresql://ops_worker_login:dbtest-other-pw@${own.host}/dbtest_other_database`,
    ];
    for (const other of others) {
      // The premise: a database on this machine, and not the fixture's.
      expect(loopbackDatabaseTarget(other)).toBeDefined();
      expect(loopbackDatabaseTarget(other)).not.toBe(
        loopbackDatabaseTarget(ADMIN_URL),
      );

      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(fixture)});`,
        ],
        {
          env: testChildEnvironment(process.env, {
            OPS_WORKER_DATABASE_URL: other,
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const code = await withinMs(
        new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        }),
        15_000,
        "loading the fixture did not finish",
      ).finally(() => child.kill("SIGKILL"));

      expect(code).not.toBe(0);
      expect(stderr).toMatch(
        /OPS_WORKER_DATABASE_URL and ADMIN_DATABASE_URL name different databases/,
      );
      expect(stderr).not.toContain("dbtest-other-pw");
    }
    // Two children, each bounded at 15 s by withinMs, so that message fires first.
  }, 45_000);
});

// ---------------------------------------------------------------------------
// 12. The state machines agree
// ---------------------------------------------------------------------------

describe("the TypeScript and database agent run state machines", () => {
  // What the SQL suite cannot prove: that engine/domain/agentRunStateMachine.ts,
  // which authorises nothing, still describes the machine the trigger enforces.
  // Compared both ways, as edge sets and through the decision function the
  // trigger itself calls for every ordered pair of statuses.
  it("agree on every agent run transition, in both directions", async () => {
    const { rows } = await admin.query<{
      from_status: string;
      to_status: string;
    }>("select from_status, to_status from ops.agent_run_status_transitions()");
    const database = new Set(
      rows.map((r) => `${r.from_status}->${r.to_status}`),
    );
    const typescript = new Set(
      AGENT_RUN_TRANSITIONS.map(([f, t]) => `${f}->${t}`),
    );

    expect(
      [...typescript].filter((edge) => !database.has(edge)),
      "edges only TypeScript allows",
    ).toEqual([]);
    expect(
      [...database].filter((edge) => !typescript.has(edge)),
      "edges only the database allows",
    ).toEqual([]);

    const { rows: decisions } = await admin.query<{
      from_status: AgentRunStatus;
      to_status: AgentRunStatus;
      allowed: boolean;
    }>(
      `select f as from_status, t as to_status, ops.agent_run_transition_allowed(f, t) as allowed
         from unnest($1::text[]) as f cross join unnest($1::text[]) as t`,
      [[...AGENT_RUN_STATUSES]],
    );
    expect(decisions).toHaveLength(AGENT_RUN_STATUSES.length ** 2);
    for (const { from_status, to_status, allowed } of decisions) {
      expect(
        canTransitionAgentRun(from_status, to_status),
        `${from_status}->${to_status}`,
      ).toBe(allowed);
    }
  });

  it("agree on the set of agent run statuses", async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(k.oid) as definition
         from pg_constraint k join pg_namespace n on n.oid = k.connamespace
        where n.nspname = 'ops' and k.conname = 'agent_runs_status_check'`,
    );
    const database = [...rows[0].definition.matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .sort();
    expect(database).toEqual([...AGENT_RUN_STATUSES].sort());
  });
});
