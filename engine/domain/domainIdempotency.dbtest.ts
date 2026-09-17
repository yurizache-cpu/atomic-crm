// Idempotent Phase 1C creates (ADR 0017 §7), against a real Postgres through the
// real `pg` driver and the typed domain services, with two owner sessions.
//
// supabase/tests/runtime_governance.sql replays a key inside one transaction,
// where the second call always sees the first. What only two sessions show:
//
//   * a create that meets an UNCOMMITTED create with the same key waits on it
//     (the unique index), then answers from what the first committed: the same
//     id for the same request, invalid_state for a different one, and a fresh
//     row when the first rolled back;
//   * that neither path records a second task, a second task.created fact or a
//     second business event;
//   * a replay after commit, in a session with another time zone, resolving to
//     the same row (the fingerprint holds the due date as epoch seconds);
//   * a key that is the tenant's own: another tenant's same key is another row.
//
// It lives in engine/domain because only there may a test import the domain
// services and the database fixture together (eslint.config.js). All data is
// synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  ADMIN_URL,
  adminPool,
  cleanupFixtures,
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  openSession,
  waitUntilBlocked,
  type TransactionSession,
} from "../worker/testSupport/transactionSession.ts";
import {
  createCompany,
  createDepartment,
  createTask,
  recordEvent,
  type CreateTaskInput,
  type DomainContext,
  type RecordEventInput,
} from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import { rejectionOf } from "./testSupport/agentRunSessions.ts";

let admin: Pool;
let owner: WorkerDatabase;

beforeAll(() => {
  admin = adminPool();
  owner = createWorkerDatabase({ connectionString: ADMIN_URL, max: 4 });
}, 60_000);

afterAll(async () => {
  await owner?.close();
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

const ctx = (tenantId: string): DomainContext => ({
  tenantId,
  source: "dbtest-idempotency",
});

interface Office {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
}

const buildOffice = (tenantId: string): Promise<Office> =>
  owner.withTransaction(async (tx) => {
    const companyId = await createCompany(tx, ctx(tenantId), {
      slug: "dbtest-idempotent-office",
      name: "Office",
    });
    const departmentId = await createDepartment(tx, ctx(tenantId), {
      companyId,
      slug: "operations",
      name: "Operations",
    });
    return { tenantId, companyId, departmentId };
  });

const taskInput = (
  office: Office,
  idempotencyKey: string,
  overrides: Partial<CreateTaskInput> = {},
): CreateTaskInput => ({
  companyId: office.companyId,
  departmentId: office.departmentId,
  type: "operations.supply_order",
  title: "Prepare next week's office supply order",
  description: "Paper, toner and coffee are running low.",
  priority: 40,
  dueAt: new Date("2026-09-21T12:00:00Z"),
  idempotencyKey,
  ...overrides,
});

const eventInput = (
  office: Office,
  idempotencyKey: string,
  payload: Record<string, unknown> = { boxes: 3 },
): RecordEventInput => ({
  companyId: office.companyId,
  type: "operations.supplies_delivered",
  payload,
  idempotencyKey,
});

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly request_fingerprint: string;
}

async function tasksWithKey(tenantId: string, key: string): Promise<TaskRow[]> {
  const { rows } = await admin.query<TaskRow>(
    `select id, title, request_fingerprint from ops.tasks
      where tenant_id = $1 and idempotency_key = $2 order by created_at, id`,
    [tenantId, key],
  );
  return rows;
}

/** Every task.created fact in the tenant, by the task it names. */
async function taskCreatedFacts(tenantId: string): Promise<string[]> {
  const { rows } = await admin.query<{ subject_id: string }>(
    `select subject_id from ops.events
      where tenant_id = $1 and type = 'task.created' order by seq`,
    [tenantId],
  );
  return rows.map((row) => row.subject_id);
}

async function eventsWithKey(
  tenantId: string,
  key: string,
): Promise<{ id: string; payload: unknown }[]> {
  const { rows } = await admin.query<{ id: string; payload: unknown }>(
    `select id, payload from ops.events
      where tenant_id = $1 and idempotency_key = $2 order by seq`,
    [tenantId, key],
  );
  return rows;
}

async function businessEvents(tenantId: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `select count(*)::int as n from ops.events
      where tenant_id = $1 and type = 'operations.supplies_delivered'`,
    [tenantId],
  );
  return rows[0].n;
}

/**
 * Runs `first` in session one and leaves it uncommitted, then `second` in
 * session two, and proves session two is waiting on session one before
 * session one ends with `firstOutcome`. Resolves to what each call answered.
 */
async function race<T>(
  first: (tx: TxClient) => Promise<T>,
  second: (tx: TxClient) => Promise<T>,
  firstOutcome: "commit" | "rollback",
): Promise<{ firstId: T; secondResult: Promise<T>; two: TransactionSession }> {
  const one = openSession(owner);
  const two = openSession(owner);
  try {
    const firstId = await one.run(first);
    const onePid = await one.pid;
    const secondResult = two.run(second);
    secondResult.catch(() => undefined);
    await waitUntilBlocked(admin, await two.pid, secondResult, "transactionid");
    const { rows } = await admin.query<{ blockers: number[] }>(
      "select pg_blocking_pids($1) as blockers",
      [await two.pid],
    );
    expect(rows[0].blockers).toEqual([onePid]);
    await one.end(firstOutcome);
    return { firstId, secondResult, two };
  } catch (error) {
    await one.end("rollback");
    await two.end("rollback");
    throw error;
  }
}

describe("two sessions creating a task with the same idempotency key", () => {
  // What the SQL suite cannot prove: the concurrent path of ops.create_task,
  // where the second create's pre-check sees nothing and its insert meets the
  // first's uncommitted row.
  it("converge on one task and one task.created fact when the requests match, the second waiting for the first to commit", async () => {
    const office = await buildOffice(TENANT_A);
    const input = taskInput(office, "dbtest-task-key-7c1d");

    const { firstId, secondResult, two } = await race(
      (tx) => createTask(tx, ctx(TENANT_A), input),
      (tx) => createTask(tx, ctx(TENANT_A), input),
      "commit",
    );
    try {
      const secondId = await secondResult;
      await two.end("commit");

      expect(secondId).toBe(firstId);
    } finally {
      await two.end("rollback");
    }
    const tasks = await tasksWithKey(TENANT_A, input.idempotencyKey as string);
    expect(tasks.map((task) => task.id)).toEqual([firstId]);
    expect(tasks[0].request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await taskCreatedFacts(TENANT_A)).toEqual([firstId]);
  }, 30_000);

  it("refuse the second as invalid_state after the wait when its request differs, and it creates nothing", async () => {
    const office = await buildOffice(TENANT_A);
    const key = "dbtest-task-key-3e9a";
    const input = taskInput(office, key);
    const different = taskInput(office, key, {
      title: "Order new desk chairs",
    });

    const { firstId, secondResult, two } = await race(
      (tx) => createTask(tx, ctx(TENANT_A), input),
      (tx) => createTask(tx, ctx(TENANT_A), different),
      "commit",
    );
    const refusal = await rejectionOf(secondResult).finally(() =>
      two.end("rollback"),
    );

    expect(refusal).toBeInstanceOf(CompanyOsError);
    expect(refusal).toMatchObject({
      code: "invalid_state",
      sqlstate: "OS409",
    });
    expect(await tasksWithKey(TENANT_A, key)).toEqual([
      expect.objectContaining({ id: firstId, title: input.title }),
    ]);
    expect(await taskCreatedFacts(TENANT_A)).toEqual([firstId]);
  }, 30_000);

  it("let the second create the task when the first rolls back, with one task.created fact", async () => {
    const office = await buildOffice(TENANT_A);
    const input = taskInput(office, "dbtest-task-key-b41f");

    const { firstId, secondResult, two } = await race(
      (tx) => createTask(tx, ctx(TENANT_A), input),
      (tx) => createTask(tx, ctx(TENANT_A), input),
      "rollback",
    );
    let secondId: string;
    try {
      secondId = await secondResult;
      await two.end("commit");
    } finally {
      await two.end("rollback");
    }

    expect(secondId).not.toBe(firstId);
    const tasks = await tasksWithKey(TENANT_A, input.idempotencyKey as string);
    expect(tasks.map((task) => task.id)).toEqual([secondId]);
    expect(await taskCreatedFacts(TENANT_A)).toEqual([secondId]);
  }, 30_000);
});

describe("two sessions recording an event with the same idempotency key", () => {
  // What the SQL suite cannot prove: the same concurrent path in
  // ops.record_event.
  it("converge on one event when the facts match, the second waiting for the first to commit", async () => {
    const office = await buildOffice(TENANT_A);
    const input = eventInput(office, "dbtest-event-key-51aa");

    const { firstId, secondResult, two } = await race(
      (tx) => recordEvent(tx, ctx(TENANT_A), input),
      (tx) => recordEvent(tx, ctx(TENANT_A), input),
      "commit",
    );
    let secondId: string;
    try {
      secondId = await secondResult;
      await two.end("commit");
    } finally {
      await two.end("rollback");
    }

    expect(secondId).toBe(firstId);
    expect(await eventsWithKey(TENANT_A, "dbtest-event-key-51aa")).toEqual([
      { id: firstId, payload: { boxes: 3 } },
    ]);
    expect(await businessEvents(TENANT_A)).toBe(1);
  }, 30_000);

  it("refuse the second as invalid_state after the wait when its fact differs, and it records nothing", async () => {
    const office = await buildOffice(TENANT_A);
    const key = "dbtest-event-key-0d62";

    const { firstId, secondResult, two } = await race(
      (tx) => recordEvent(tx, ctx(TENANT_A), eventInput(office, key)),
      (tx) =>
        recordEvent(tx, ctx(TENANT_A), eventInput(office, key, { boxes: 4 })),
      "commit",
    );
    const refusal = await rejectionOf(secondResult).finally(() =>
      two.end("rollback"),
    );

    expect(refusal).toMatchObject({
      code: "invalid_state",
      sqlstate: "OS409",
    });
    expect(await eventsWithKey(TENANT_A, key)).toEqual([
      { id: firstId, payload: { boxes: 3 } },
    ]);
    expect(await businessEvents(TENANT_A)).toBe(1);
  }, 30_000);
});

describe("a create replayed after it committed", () => {
  // What the SQL suite cannot prove: a replay in a later transaction of a
  // session whose time zone differs, through the typed services, which send the
  // due date as a JavaScript Date.
  it("resolves to the same task and the same event, in a session with another time zone, and records nothing new", async () => {
    const office = await buildOffice(TENANT_A);
    const task = taskInput(office, "dbtest-task-key-replay");
    const fact = eventInput(office, "dbtest-event-key-replay");
    const created = await owner.withTransaction(async (tx) => ({
      taskId: await createTask(tx, ctx(TENANT_A), task),
      eventId: await recordEvent(tx, ctx(TENANT_A), fact),
    }));

    const replayed = await owner.withTransaction(async (tx) => {
      await tx.query("set local timezone = 'America/Sao_Paulo'");
      return {
        taskId: await createTask(tx, ctx(TENANT_A), task),
        eventId: await recordEvent(tx, ctx(TENANT_A), fact),
      };
    });

    expect(replayed).toEqual(created);
    expect(await tasksWithKey(TENANT_A, "dbtest-task-key-replay")).toHaveLength(
      1,
    );
    expect(await taskCreatedFacts(TENANT_A)).toEqual([created.taskId]);
    expect(await businessEvents(TENANT_A)).toBe(1);

    const changed = await rejectionOf(
      owner.withTransaction((tx) =>
        createTask(tx, ctx(TENANT_A), {
          ...task,
          dueAt: new Date("2026-09-22T12:00:00Z"),
        }),
      ),
    );
    expect(changed).toMatchObject({ code: "invalid_state" });
    expect(await taskCreatedFacts(TENANT_A)).toEqual([created.taskId]);
  }, 30_000);
});

describe("the same idempotency key in two tenants", () => {
  // What the SQL suite cannot prove: through the typed services, that a key is
  // scoped to the tenant that used it and grants nothing across tenants.
  it("creates an independent task and event in each tenant, and a replay in each resolves to its own", async () => {
    const officeA = await buildOffice(TENANT_A);
    const officeB = await buildOffice(TENANT_B);
    const key = "dbtest-shared-key-9f00";
    const create = (office: Office) =>
      owner.withTransaction(async (tx) => ({
        taskId: await createTask(
          tx,
          ctx(office.tenantId),
          taskInput(office, key),
        ),
        eventId: await recordEvent(
          tx,
          ctx(office.tenantId),
          eventInput(office, key),
        ),
      }));

    const inA = await create(officeA);
    const inB = await create(officeB);

    expect(inB.taskId).not.toBe(inA.taskId);
    expect(inB.eventId).not.toBe(inA.eventId);
    expect(await create(officeA)).toEqual(inA);
    expect(await create(officeB)).toEqual(inB);
    expect((await tasksWithKey(TENANT_A, key)).map((task) => task.id)).toEqual([
      inA.taskId,
    ]);
    expect((await tasksWithKey(TENANT_B, key)).map((task) => task.id)).toEqual([
      inB.taskId,
    ]);
    expect(await taskCreatedFacts(TENANT_A)).toEqual([inA.taskId]);
    expect(await taskCreatedFacts(TENANT_B)).toEqual([inB.taskId]);
  }, 30_000);
});
