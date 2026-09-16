// The Company OS domain services against a real Postgres, through the real `pg`
// driver.
//
// supabase/tests/company_domain_core.sql attacks the database with psql. This
// file proves what psql cannot: that the TYPED boundary reaches the right
// functions with the right arguments, maps their refusals, keeps a native
// privilege failure distinguishable from a domain refusal, and that the
// TypeScript state machine and the database's are the same relation. It also
// runs the one race the functions must survive: a reassignment that arrives
// while the task is being completed.
//
// Owner transactions use the same adapter as the worker, pointed at the admin
// connection — no second module imports `pg`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { REGISTERED_HANDLER_KINDS } from "../worker/registry.ts";
import {
  ADMIN_URL,
  adminPool,
  assertTargetDatabase,
  deleteCompanyOsRows,
  provisionWorkerRole,
  workerDatabase,
} from "../worker/testSupport/dbFixture.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
  requestTaskExecution,
  setAgentStatus,
  transitionTask,
  type DomainContext,
} from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import { TASK_STATUSES, TASK_TRANSITIONS } from "./taskStateMachine.ts";

// Distinct from the worker suites' fixture tenants, so the two can never
// delete each other's rows.
const TENANT_A = "e0000000-0000-4000-8000-0000000000ea";
const TENANT_B = "e0000000-0000-4000-8000-0000000000eb";
const TENANTS = [TENANT_A, TENANT_B];

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

const context = (tenantId: string): DomainContext => ({
  tenantId,
  source: "dbtest-domain",
});

async function clean(): Promise<void> {
  await deleteCompanyOsRows(admin, TENANTS);
  await admin.query(
    "delete from ops.job_events where tenant_id = any($1::uuid[])",
    [TENANTS],
  );
  await admin.query("delete from ops.jobs where tenant_id = any($1::uuid[])", [
    TENANTS,
  ]);
  await admin.query("delete from ops.tenants where id = any($1::uuid[])", [
    TENANTS,
  ]);
}

/** Resolves to what the promise rejected with; fails the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection, but the call succeeded");
}

interface Hierarchy {
  companyId: string;
  departmentId: string;
  agentId: string;
  secondAgentId: string;
}

function buildHierarchy(tenantId: string, slug: string): Promise<Hierarchy> {
  return owner.withTransaction(async (tx) => {
    const ctx = context(tenantId);
    const companyId = await createCompany(tx, ctx, { slug, name: slug });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "reception",
      name: "Reception",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "agent-one",
      name: "Agent One",
      role: "Receptionist",
    });
    const secondAgentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "agent-two",
      name: "Agent Two",
      role: "Receptionist",
    });
    return { companyId, departmentId, agentId, secondAgentId };
  });
}

beforeAll(async () => {
  provisionWorkerRole();
  admin = adminPool();
  await assertTargetDatabase(admin);
  owner = createWorkerDatabase({ connectionString: ADMIN_URL, max: 3 });
  worker = workerDatabase(1);
  await clean();
  await admin.query(
    `insert into ops.tenants (id, slug, name) values
       ($1, 'dbtest-domain-a', 'Domain test tenant A'),
       ($2, 'dbtest-domain-b', 'Domain test tenant B')`,
    TENANTS,
  );
}, 60_000);

afterAll(async () => {
  await worker?.close();
  await owner?.close();
  if (admin) await clean();
  await admin?.end();
});

describe("the Company OS domain services", () => {
  it("build a company and move a task through its lifecycle, one fact per change", async () => {
    const { companyId, departmentId, agentId } = await buildHierarchy(
      TENANT_A,
      "lifecycle",
    );
    const ctx = context(TENANT_A);

    const taskId = await owner.withTransaction((tx) =>
      createTask(tx, ctx, {
        companyId,
        departmentId,
        type: "crm.follow_up",
        title: "Call back",
      }),
    );
    await owner.withTransaction((tx) => assignTask(tx, ctx, taskId, agentId));
    await owner.withTransaction((tx) =>
      transitionTask(tx, ctx, taskId, "in_progress"),
    );
    await owner.withTransaction((tx) =>
      transitionTask(tx, ctx, taskId, "completed"),
    );

    const { rows: task } = await admin.query<{
      status: string;
      completed: boolean;
    }>(
      "select status, completed_at is not null as completed from ops.tasks where id = $1",
      [taskId],
    );
    expect(task).toEqual([{ status: "completed", completed: true }]);

    const { rows: events } = await admin.query<{
      type: string;
      source: string;
    }>(
      "select type, source from ops.events where tenant_id = $1 and subject_id = $2 order by seq",
      [TENANT_A, taskId],
    );
    expect(events.map((e) => e.type)).toEqual([
      "task.created",
      "task.assigned",
      "task.status_changed",
      "task.completed",
    ]);
    expect(new Set(events.map((e) => e.source))).toEqual(
      new Set(["dbtest-domain"]),
    );
  });

  it("treat another tenant's company as not found, and write nothing", async () => {
    const { companyId: tenantBCompany } = await buildHierarchy(
      TENANT_B,
      "other-tenant",
    );
    const before = await admin.query<{ n: string }>(
      "select count(*) as n from ops.departments where company_id = $1",
      [tenantBCompany],
    );

    const error = await rejectionOf(
      owner.withTransaction((tx) =>
        createDepartment(tx, context(TENANT_A), {
          companyId: tenantBCompany,
          slug: "cross",
          name: "Cross",
        }),
      ),
    );

    expect(error).toBeInstanceOf(CompanyOsError);
    expect((error as CompanyOsError).code).toBe("not_found");
    const after = await admin.query<{ n: string }>(
      "select count(*) as n from ops.departments where company_id = $1",
      [tenantBCompany],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("refuse to assign an inactive agent", async () => {
    const { companyId, agentId } = await buildHierarchy(TENANT_A, "inactive");
    const ctx = context(TENANT_A);
    const taskId = await owner.withTransaction(async (tx) => {
      await setAgentStatus(tx, ctx, agentId, "inactive");
      return createTask(tx, ctx, {
        companyId,
        type: "crm.follow_up",
        title: "Nobody home",
      });
    });

    const error = await rejectionOf(
      owner.withTransaction((tx) => assignTask(tx, ctx, taskId, agentId)),
    );

    expect((error as CompanyOsError).code).toBe("invalid_state");
  });

  // Phase 1D allowlists exactly agent_run.execute. A kind with a registered
  // handler that the allowlist does not name is still refused, and enqueues
  // nothing.
  it("refuse an execution request for a registered handler kind the allowlist does not name", async () => {
    const { companyId } = await buildHierarchy(TENANT_A, "no-execution");
    const ctx = context(TENANT_A);
    const taskId = await owner.withTransaction((tx) =>
      createTask(tx, ctx, { companyId, type: "ops.retention", title: "Purge" }),
    );

    const error = await rejectionOf(
      owner.withTransaction((tx) =>
        requestTaskExecution(tx, ctx, {
          taskId,
          kind: "postmark.ledger_retention",
        }),
      ),
    );

    expect((error as CompanyOsError).code).toBe("refused");
    const { rows } = await admin.query<{ n: string }>(
      "select count(*) as n from ops.jobs where tenant_id = $1",
      [TENANT_A],
    );
    expect(rows[0].n).toBe("0");
  });

  it("serialize a reassignment behind a concurrent completion, which then refuses it", async () => {
    const { companyId, departmentId, agentId, secondAgentId } =
      await buildHierarchy(TENANT_A, "race");
    const ctx = context(TENANT_A);
    const taskId = await owner.withTransaction(async (tx) => {
      const id = await createTask(tx, ctx, {
        companyId,
        departmentId,
        type: "crm.follow_up",
        title: "Race",
      });
      await assignTask(tx, ctx, id, agentId);
      await transitionTask(tx, ctx, id, "in_progress");
      return id;
    });

    // The completion takes the row lock and holds it; only then does the
    // reassignment start, so it can only ever see the committed outcome.
    let lockHeld!: () => void;
    const completionHoldsLock = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const completion = owner.withTransaction(async (tx) => {
      await transitionTask(tx, ctx, taskId, "completed");
      lockHeld();
      await tx.query("select pg_sleep(0.5)");
    });
    await completionHoldsLock;
    const reassignment = rejectionOf(
      owner.withTransaction((tx) => assignTask(tx, ctx, taskId, secondAgentId)),
    );
    await completion;
    const error = await reassignment;

    expect((error as CompanyOsError).code).toBe("invalid_state");
    const { rows } = await admin.query<{
      status: string;
      assigned_agent_id: string;
    }>("select status, assigned_agent_id from ops.tasks where id = $1", [
      taskId,
    ]);
    expect(rows).toEqual([{ status: "completed", assigned_agent_id: agentId }]);
    const { rows: late } = await admin.query<{ n: string }>(
      "select count(*) as n from ops.events where subject_id = $1 and type = 'task.assigned'",
      [taskId],
    );
    expect(late[0].n).toBe("1");
  });
});

describe("the task -> job bridge under real concurrency", () => {
  it("refuses a job another caller enqueues under the task's key while the request is in flight", async () => {
    // The race the adversarial pass found: the bridge's idempotency check runs,
    // another connection inserts a job under the task's namespaced key without
    // committing, the bridge's own insert blocks on that key, and the other
    // connection commits. The bridge must refuse — never adopt that job as a
    // request the task made.
    const { companyId } = await buildHierarchy(TENANT_A, "bridge-race");
    const ctx = context(TENANT_A);
    const kind = "dbtest.bridge_race";

    let taskId = "";
    let bridgePid = 0;
    let bridgeReady!: () => void;
    const bridgeIsReady = new Promise<void>((resolve) => {
      bridgeReady = resolve;
    });
    let squatInserted!: () => void;
    const squatIsInserted = new Promise<void>((resolve) => {
      squatInserted = resolve;
    });

    const request = rejectionOf(
      owner.withTransaction(async (tx) => {
        // An allowlist that exists only inside this transaction.
        await tx.query(
          `create or replace function ops.task_executable_kinds() returns text[]
             language sql immutable set search_path to ''
             as $f$ select array['${kind}']::text[] $f$`,
        );
        taskId = await createTask(tx, ctx, {
          companyId,
          type: "crm.export",
          title: "Race",
        });
        const { rows } = await tx.query<{ pid: number }>(
          "select pg_backend_pid() as pid",
        );
        bridgePid = rows[0].pid;
        bridgeReady();
        await squatIsInserted;
        return requestTaskExecution(tx, ctx, {
          taskId,
          kind,
          idempotencyKey: "k",
        });
      }),
    );

    await bridgeIsReady;
    const squatter = await admin.connect();
    let squatJob = "";
    try {
      await squatter.query("begin");
      const { rows } = await squatter.query<{ id: string }>(
        "select ops.enqueue_job($1, $2, '{\"forged\": true}'::jsonb, 100, now(), 5, $3) as id",
        [TENANT_A, kind, `task:${taskId}:k`],
      );
      squatJob = rows[0].id;
      squatInserted();

      // Commit only once the bridge is provably waiting on the key.
      for (let i = 0; i < 100; i += 1) {
        const { rows: waiting } = await admin.query<{ wait: string | null }>(
          "select wait_event_type as wait from pg_stat_activity where pid = $1",
          [bridgePid],
        );
        if (waiting[0]?.wait === "Lock") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await squatter.query("commit");
    } finally {
      squatter.release();
    }

    const error = await request;
    expect(error).toBeInstanceOf(CompanyOsError);
    expect((error as CompanyOsError).code).toBe("invalid_state");
    const { rows: links } = await admin.query<{ n: string }>(
      "select count(*) as n from ops.task_jobs where tenant_id = $1 and job_id = $2",
      [TENANT_A, squatJob],
    );
    expect(links[0].n).toBe("0");
  });
});

describe("the database and the TypeScript side agree", () => {
  it("on every task transition, in both directions", async () => {
    const { rows } = await admin.query<{
      from_status: string;
      to_status: string;
    }>("select from_status, to_status from ops.task_status_transitions()");

    const database = rows.map((r) => `${r.from_status}->${r.to_status}`).sort();
    const typescript = TASK_TRANSITIONS.map(([f, t]) => `${f}->${t}`).sort();
    expect(database).toEqual(typescript);
  });

  it("on the set of task statuses", async () => {
    const { rows } = await admin.query<{ definition: string }>(
      `select pg_get_constraintdef(k.oid) as definition
         from pg_constraint k join pg_namespace n on n.oid = k.connamespace
        where n.nspname = 'ops' and k.conname = 'tasks_status_check'`,
    );
    const database = [...rows[0].definition.matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .sort();
    expect(database).toEqual([...TASK_STATUSES].sort());
  });

  it("that every kind a task may request has a registered handler — and that the allowlist is exactly agent_run.execute", async () => {
    const { rows } = await admin.query<{ kind: string }>(
      "select unnest(ops.task_executable_kinds()) as kind",
    );
    const kinds = rows.map((row) => row.kind);
    for (const kind of kinds) {
      expect(REGISTERED_HANDLER_KINDS).toContain(kind);
    }
    // A literal, not the handler's constant: renaming the kind on one side
    // only must fail here.
    expect(kinds).toEqual(["agent_run.execute"]);
  });
});

describe("the shipped authority boundary, through the real driver", () => {
  it("refuses a leased worker at the privilege layer, and the typed boundary does not disguise it", async () => {
    const { companyId } = await buildHierarchy(TENANT_A, "leased");
    const { rows: queued } = await admin.query<{ id: string }>(
      "select ops.enqueue_job($1, 'dbtest.domain_probe', '{}'::jsonb, -2147483648, now(), 5, null) as id",
      [TENANT_A],
    );
    const jobId = queued[0].id;
    const workerId = "dbtest-domain-worker";

    const leased = await worker.withTransaction(async (tx) => {
      await tx.query("set local role ops_worker");
      const { rows } = await tx.query<{ id: string; tenant_id: string }>(
        "select id, tenant_id from ops.lease_job($1, 60)",
        [workerId],
      );
      return rows[0];
    });
    expect(leased).toEqual({ id: jobId, tenant_id: TENANT_A });

    const read = await rejectionOf(
      worker.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select ops.resume_lease($1, $2)", [workerId, jobId]);
        await tx.query("select count(*) from ops.companies");
      }),
    );
    expect((read as { code?: string }).code).toBe("42501");

    const write = await rejectionOf(
      worker.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        await tx.query("select ops.resume_lease($1, $2)", [workerId, jobId]);
        await createTask(tx, context(TENANT_A), {
          companyId,
          type: "crm.follow_up",
          title: "Written by a worker",
        });
      }),
    );
    expect(write).not.toBeInstanceOf(CompanyOsError);
    expect((write as { code?: string }).code).toBe("42501");

    const { rows } = await admin.query<{ n: string }>(
      "select count(*) as n from ops.tasks where company_id = $1",
      [companyId],
    );
    expect(rows[0].n).toBe("0");
  });
});
