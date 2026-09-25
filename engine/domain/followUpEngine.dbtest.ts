// Phase 3A.1: the follow-up engine against a real Postgres, through the real
// `pg` driver and the real worker runtime (supabase/migrations/
// 20260928120000_follow_up_engine.sql, engine/handlers/followUpDue.ts).
//
// What it proves, each against the database rather than a mock:
//
//   * a cadence is versioned and immutable, and a plan keeps its version;
//   * a due time is the anchor plus a FIXED offset, identical under any
//     session time zone and across a daylight-saving change;
//   * scheduling is idempotent per key, including two owners racing one key,
//     and a new plan for a subject supersedes the active one;
//   * a future follow-up becomes runnable through the existing queue's
//     availability, and the worker marks it due once and contacts nobody;
//   * a replayed due job and two racing workers change it exactly once;
//   * a covering stop holds the due job at the lease and, when it arrives
//     after the lease, defers it in its transaction with the attempt given
//     back; clearing the stop lets it become due;
//   * completion and cancellation are idempotent, a closed follow-up never
//     changes, and one tenant reaches nothing of another's.
//
// All data is synthetic: opaque references, no names, numbers or messages.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { followUpDue, FOLLOW_UP_DUE_KIND } from "../handlers/followUpDue.ts";
import { createRegistry } from "../worker/handlerRegistry.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import {
  jobEvents,
  makeJobDue,
  readJobLease,
} from "../worker/testSupport/jobLedger.ts";
import { createAgent, createCompany, createDepartment } from "./companyOs.ts";
import { CompanyOsError } from "./errors.ts";
import {
  clearExecutionStop,
  tripExecutionStop,
  type ExecutionStopTarget,
} from "./executionStops.ts";
import {
  cancelFollowUp,
  cancelFollowUpPlan,
  completeFollowUp,
  defineFollowUpPolicyVersion,
  FOLLOW_UP_STATUS_TRANSITIONS,
  scheduleFollowUpPlan,
  type SchedulePlanInput,
} from "./followUps.ts";
import {
  closeAgentRunDatabases,
  openAgentRunDatabases,
} from "./testSupport/agentRunSessions.ts";

const SOURCE = "dbtest-follow-ups";
const WORKER = "dbtest-follow-ups";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The synthetic demo's cadence: 3, 7 and 10 days, as minutes. Data, not an engine constant. */
const CADENCE = [72 * 60, 168 * 60, 240 * 60];
const POLICY = "lead-cadence";
const TRIP = { reason: "dbtest follow-up drill", actor: "dbtest" };
const CLEAR = { reason: "dbtest follow-up drill over", actor: "dbtest" };

let admin: Pool;
let owner: WorkerDatabase;
let worker: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, worker } = openAgentRunDatabases());
}, 60_000);

afterAll(() => closeAgentRunDatabases({ admin, owner, worker }));

interface Office {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly otherDepartmentId: string;
  readonly agentId: string;
}

let office: Office;
let officeB: Office;

const context = (tenantId: string) => ({
  tenantId,
  source: SOURCE,
  actor: "dbtest",
});

async function createOffice(tenantId: string): Promise<Office> {
  return owner.withTransaction(async (tx) => {
    const ctx = { tenantId, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "clinica",
      name: "Clínica sintética",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "atendimento",
      name: "Atendimento",
    });
    const otherDepartmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "financeiro",
      name: "Financeiro",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "recepcao",
      name: "Recepção",
      role: "Atendimento inicial",
    });
    await defineFollowUpPolicyVersion(tx, context(tenantId), {
      policyKey: POLICY,
      label: "Cadência de leads",
      stepOffsetsMinutes: CADENCE,
    });
    return { tenantId, companyId, departmentId, otherDepartmentId, agentId };
  });
}

beforeEach(async () => {
  await resetFixtures(admin);
  office = await createOffice(TENANT_A);
  officeB = await createOffice(TENANT_B);
});

const registry = createRegistry([followUpDue]);
const run = (overrides: Partial<Parameters<typeof runOneJob>[1]> = {}) =>
  runOneJob(worker, { workerId: WORKER, registry, ...overrides });

const planInput = (
  key: string,
  anchorAt: Date,
  overrides: Partial<SchedulePlanInput> = {},
): SchedulePlanInput => ({
  companyId: office.companyId,
  departmentId: office.departmentId,
  policyKey: POLICY,
  anchorAt,
  subject: { subjectRef: "lead:SYN-0001" },
  idempotencyKey: key,
  ...overrides,
});

const schedule = (input: SchedulePlanInput, tenantId = TENANT_A) =>
  owner.withTransaction((tx) =>
    scheduleFollowUpPlan(tx, context(tenantId), input),
  );

const asOwner = <T>(work: (tx: TxClient) => Promise<T>) =>
  owner.withTransaction(work);

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
};

interface OccurrenceRow {
  id: string;
  step_number: number;
  status: string;
  due_at: Date;
  job_id: string;
}

async function occurrences(planId: string): Promise<OccurrenceRow[]> {
  const { rows } = await admin.query<OccurrenceRow>(
    `select id, step_number, status, due_at, job_id
       from ops.follow_ups where plan_id = $1 order by step_number`,
    [planId],
  );
  return rows;
}

async function eventCount(tenantId: string, type: string): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    "select count(*)::int as n from ops.events where tenant_id = $1 and type = $2",
    [tenantId, type],
  );
  return rows[0].n;
}

/** An anchor that makes step 1 due one minute ago and steps 2 and 3 due later. */
const anchorWithFirstStepDue = () =>
  new Date(Date.now() - CADENCE[0] * MINUTE - MINUTE);

const trip = (target: ExecutionStopTarget) =>
  asOwner((tx) => tripExecutionStop(tx, target, TRIP));
const clear = (stopId: string) =>
  asOwner((tx) => clearExecutionStop(tx, stopId, CLEAR));

describe("follow-up policies are versioned tenant configuration", () => {
  it("keeps the same cadence as the same version, makes a new cadence the next version, and never rewrites one", async () => {
    // Arrange / Act
    const again = await asOwner((tx) =>
      defineFollowUpPolicyVersion(tx, context(TENANT_A), {
        policyKey: POLICY,
        label: "ignored: the label is fixed at first definition",
        stepOffsetsMinutes: CADENCE,
      }),
    );
    const next = await asOwner((tx) =>
      defineFollowUpPolicyVersion(tx, context(TENANT_A), {
        policyKey: POLICY,
        label: "Cadência de leads",
        stepOffsetsMinutes: [24 * 60, 48 * 60],
      }),
    );

    // Assert
    expect(again).toMatchObject({ version: 1, created: false });
    expect(next).toMatchObject({ version: 2, created: true });
    expect(
      await rejection(
        admin.query(
          "update ops.follow_up_policy_versions set step_offsets_minutes = '{60}' where id = $1",
          [again.versionId],
        ),
      ),
    ).toMatchObject({ code: "OS409" });
  });

  it("refuses a cadence that is not strictly increasing positive minutes", async () => {
    for (const offsets of [[], [60, 60], [120, 60], [0], [60, 600_000]]) {
      const error = await rejection(
        asOwner((tx) =>
          defineFollowUpPolicyVersion(tx, context(TENANT_A), {
            policyKey: "bad-cadence",
            label: "Bad",
            stepOffsetsMinutes: offsets,
          }),
        ),
      );
      expect(error).toBeInstanceOf(Error);
    }
  });

  it("binds a plan to the version current when it was scheduled, so a later cadence changes only later plans", async () => {
    // Arrange
    const first = await schedule(planInput("plan-v1", new Date()));
    await asOwner((tx) =>
      defineFollowUpPolicyVersion(tx, context(TENANT_A), {
        policyKey: POLICY,
        label: "Cadência de leads",
        stepOffsetsMinutes: [24 * 60],
      }),
    );

    // Act
    const second = await schedule(
      planInput("plan-v2", new Date(), {
        subject: { subjectRef: "lead:SYN-0002" },
      }),
    );

    // Assert
    expect(await occurrences(first.planId)).toHaveLength(3);
    expect(await occurrences(second.planId)).toHaveLength(1);
  });

  it("mirrors the database's occurrence state machine exactly", async () => {
    const { rows } = await admin.query<{
      from_status: string;
      to_status: string;
    }>("select from_status, to_status from ops.follow_up_status_transitions()");
    const database = rows.map((r) => `${r.from_status}>${r.to_status}`).sort();
    const engine = FOLLOW_UP_STATUS_TRANSITIONS.map(
      ([a, b]) => `${a}>${b}`,
    ).sort();
    expect(database).toEqual(engine);
  });
});

describe("due times are fixed durations from an instant", () => {
  it("derives each due time as the anchor plus its offset, identical under any session time zone and across a daylight-saving change", async () => {
    // Arrange: 2026-11-01 ends daylight saving in New York; the anchor is two
    // days before, so every step crosses it.
    const anchor = new Date("2026-10-30T15:00:00.000Z");
    const inZone = (zone: string, key: string, ref: string) =>
      asOwner(async (tx) => {
        await tx.query(`set local time zone '${zone}'`);
        return scheduleFollowUpPlan(tx, context(TENANT_A), {
          ...planInput(key, anchor),
          subject: { subjectRef: ref },
        });
      });

    // Act
    const auckland = await inZone("Pacific/Auckland", "tz-1", "lead:SYN-0101");
    const newYork = await inZone("America/New_York", "tz-2", "lead:SYN-0102");
    const saoPaulo = await inZone("America/Sao_Paulo", "tz-3", "lead:SYN-0103");

    // Assert
    const expected = CADENCE.map((m) => anchor.getTime() + m * MINUTE);
    for (const plan of [auckland, newYork, saoPaulo]) {
      const rows = await occurrences(plan.planId);
      expect(rows.map((r) => new Date(r.due_at).getTime())).toEqual(expected);
    }
    expect(expected[0] - anchor.getTime()).toBe(72 * HOUR);
  });

  it("refuses an occurrence whose due time was not derived from its plan", async () => {
    const plan = await schedule(planInput("derived", new Date()));
    const error = await rejection(
      admin.query(
        `insert into ops.follow_ups (tenant_id, company_id, plan_id, step_number, step_count, due_at)
         values ($1, $2, $3, 1, 3, now())`,
        [TENANT_A, office.companyId, plan.planId],
      ),
    );
    expect(error).toMatchObject({ code: "OS400" });
  });
});

describe("scheduling is idempotent and one subject has one active plan", () => {
  it("returns the same plan for the same request under one key and creates nothing twice", async () => {
    // Act
    const input = planInput("same-key", new Date());
    const first = await schedule(input);
    const again = await schedule(input);

    // Assert
    expect(again).toEqual({
      planId: first.planId,
      created: false,
      supersededPlanId: null,
    });
    expect(await occurrences(first.planId)).toHaveLength(3);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.jobs where tenant_id = $1 and kind = $2",
      [TENANT_A, FOLLOW_UP_DUE_KIND],
    );
    expect(rows[0].n).toBe(3);
    expect(await eventCount(TENANT_A, "follow_up.scheduled")).toBe(3);
  });

  it("refuses a different request under a key that already names a plan", async () => {
    await schedule(planInput("taken", new Date()));
    const error = await rejection(
      schedule(planInput("taken", new Date(Date.now() + HOUR))),
    );
    expect(error).toBeInstanceOf(CompanyOsError);
    expect((error as CompanyOsError).code).toBe("invalid_state");
  });

  it("creates one plan when two owners race the same key", async () => {
    // Arrange
    const input = planInput("raced-key", new Date("2026-10-01T12:00:00Z"));

    // Act
    const [a, b] = await Promise.all([schedule(input), schedule(input)]);

    // Assert
    expect(a.planId).toBe(b.planId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await occurrences(a.planId)).toHaveLength(3);
  });

  it("supersedes the subject's active plan with a new one, leaving exactly one active", async () => {
    // Arrange
    const first = await schedule(planInput("subject-1", new Date()));

    // Act
    const second = await schedule(
      planInput("subject-2", new Date(Date.now() + HOUR)),
    );

    // Assert
    expect(second.supersededPlanId).toBe(first.planId);
    expect((await occurrences(first.planId)).map((r) => r.status)).toEqual([
      "superseded",
      "superseded",
      "superseded",
    ]);
    const { rows } = await admin.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from ops.follow_up_plans
        where tenant_id = $1 group by status order by status`,
      [TENANT_A],
    );
    expect(rows).toEqual([
      { status: "active", n: 1 },
      { status: "superseded", n: 1 },
    ]);
  });

  it("keeps one active plan when two different keys race for one subject", async () => {
    const [a, b] = await Promise.all([
      schedule(planInput("race-a", new Date())),
      schedule(planInput("race-b", new Date())),
    ]);
    const superseded = [a.supersededPlanId, b.supersededPlanId].filter(
      (id) => id !== null,
    );
    expect(superseded).toHaveLength(1);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.follow_up_plans where tenant_id = $1 and status = 'active'",
      [TENANT_A],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("a due follow-up is operator work on the existing queue", () => {
  it("leaves a future follow-up unrunnable, marks it due at its time, once, and contacts nobody", async () => {
    // Arrange
    const plan = await schedule(planInput("due-now", anchorWithFirstStepDue()));

    // Act
    const first = await run();
    const second = await run();

    // Assert
    expect(first).toMatchObject({
      outcome: "succeeded",
      kind: FOLLOW_UP_DUE_KIND,
      detail: "follow_up=due",
    });
    expect(second.outcome).toBe("idle");
    const rows = await occurrences(plan.planId);
    expect(rows.map((r) => r.status)).toEqual([
      "due",
      "scheduled",
      "scheduled",
    ]);
    for (const row of rows.slice(1)) {
      const lease = await readJobLease(admin, row.job_id);
      expect(lease.status).toBe("queued");
      expect(new Date(lease.availableAt).getTime()).toBe(
        new Date(row.due_at).getTime(),
      );
    }
    expect(await eventCount(TENANT_A, "follow_up.due")).toBe(1);
    const { rows: effects } = await admin.query<{ n: number }>(
      `select (select count(*) from ops.outbound_messages where tenant_id = $1)
            + (select count(*) from ops.agent_runs where tenant_id = $1)
            + (select count(*) from ops.decision_evaluations where tenant_id = $1)
            + (select count(*) from ops.review_items where tenant_id = $1)
            + (select count(*) from ops.jobs where tenant_id = $1 and kind <> $2) as n`,
      [TENANT_A, FOLLOW_UP_DUE_KIND],
    );
    expect(Number(effects[0].n)).toBe(0);
  });

  it("changes nothing when a due job is replayed", async () => {
    // Arrange: the job ran; the owner puts it back on the queue.
    const plan = await schedule(planInput("replay", anchorWithFirstStepDue()));
    expect((await run()).detail).toBe("follow_up=due");
    const [step1] = await occurrences(plan.planId);
    await admin.query(
      `update ops.jobs set status = 'queued', available_at = now(), completed_at = null
        where id = $1`,
      [step1.job_id],
    );

    // Act
    const replay = await run();

    // Assert
    expect(replay).toMatchObject({
      outcome: "succeeded",
      detail: "follow_up=already_due",
    });
    expect(await occurrences(plan.planId)).toHaveLength(3);
    expect(await eventCount(TENANT_A, "follow_up.due")).toBe(1);
  });

  it("marks each follow-up due exactly once when several workers race the queue", async () => {
    // Arrange: three subjects, each with its first step due now.
    const plans = await Promise.all(
      ["SYN-0201", "SYN-0202", "SYN-0203"].map((ref, i) =>
        schedule(
          planInput(`race-${i}`, anchorWithFirstStepDue(), {
            subject: { subjectRef: `lead:${ref}` },
          }),
        ),
      ),
    );

    // Act
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        runOneJob(worker, { workerId: `${WORKER}-${i}`, registry }),
      ),
    );

    // Assert
    expect(outcomes.filter((o) => o.outcome === "succeeded")).toHaveLength(3);
    expect(outcomes.filter((o) => o.outcome === "idle")).toHaveLength(2);
    for (const plan of plans) {
      expect((await occurrences(plan.planId))[0].status).toBe("due");
    }
    expect(await eventCount(TENANT_A, "follow_up.due")).toBe(3);
  });
});

describe("the one kill switch holds follow-up work, and a stop is never destructive", () => {
  const departmentStop = (): ExecutionStopTarget => ({
    scope: "department",
    tenantId: TENANT_A,
    companyId: office.companyId,
    departmentId: office.departmentId,
  });

  it("holds the due job at the lease under a covering stop, consuming no attempt, and lets it become due once cleared", async () => {
    // Arrange
    const plan = await schedule(planInput("held", anchorWithFirstStepDue()));
    const stop = await trip(departmentStop());

    // Act
    const whileStopped = await run();

    // Assert
    expect(whileStopped.outcome).toBe("idle");
    const [step1] = await occurrences(plan.planId);
    expect(step1.status).toBe("scheduled");
    expect(await readJobLease(admin, step1.job_id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });

    // Act: the stop is cleared by a person.
    await clear(stop);
    const afterClear = await run();

    // Assert
    expect(afterClear.detail).toBe("follow_up=due");
    expect((await occurrences(plan.planId))[0].status).toBe("due");
  });

  it("is not held by a stop on another department of the same company", async () => {
    await schedule(planInput("other-unit", anchorWithFirstStepDue()));
    await trip({
      scope: "department",
      tenantId: TENANT_A,
      companyId: office.companyId,
      departmentId: office.otherDepartmentId,
    });
    expect((await run()).detail).toBe("follow_up=due");
  });

  it("is held by a stop on the agent a plan names, and not by one on another tenant", async () => {
    await schedule(
      planInput("agent-unit", anchorWithFirstStepDue(), {
        agentId: office.agentId,
      }),
    );
    await trip({ scope: "tenant", tenantId: TENANT_B });
    const stop = await trip({
      scope: "agent",
      tenantId: TENANT_A,
      companyId: office.companyId,
      agentId: office.agentId,
    });
    expect((await run()).outcome).toBe("idle");
    await clear(stop);
    expect((await run()).detail).toBe("follow_up=due");
  });

  it("defers a job a stop covered after its lease committed, with the attempt given back and nothing run", async () => {
    // Arrange
    const plan = await schedule(
      planInput("late-stop", anchorWithFirstStepDue()),
    );
    let stopId = "";

    // Act: the stop is tripped in the window between the lease and TX2.
    const outcome = await run({
      onLeased: async () => {
        stopId = await trip(departmentStop());
      },
    });

    // Assert
    expect(outcome.outcome).toBe("deferred");
    const [step1] = await occurrences(plan.planId);
    expect(step1.status).toBe("scheduled");
    const lease = await readJobLease(admin, step1.job_id);
    expect(lease).toMatchObject({ status: "queued", attempts: 0 });
    expect(lease.dueInSeconds).toBeGreaterThan(20);
    expect((await jobEvents(admin, step1.job_id)).map((e) => e.event)).toEqual([
      "enqueued",
      "leased",
      "deferred",
    ]);
    expect(await eventCount(TENANT_A, "follow_up.due")).toBe(0);

    // Act: cleared, and its delay passed.
    await clear(stopId);
    await makeJobDue(admin, step1.job_id);
    const resumed = await run();

    // Assert
    expect(resumed.detail).toBe("follow_up=due");
    expect(resumed.attempt).toBe(1);
  });
});

describe("a person completes or cancels a follow-up; a closed one never changes", () => {
  it("completes only a due follow-up, and a repeat is harmless", async () => {
    const plan = await schedule(
      planInput("complete", anchorWithFirstStepDue()),
    );
    const [step1, step2] = await occurrences(plan.planId);
    const ctx = context(TENANT_A);

    expect(
      await rejection(asOwner((tx) => completeFollowUp(tx, ctx, step1.id))),
    ).toMatchObject({ code: "invalid_state" });
    await run();
    expect(await asOwner((tx) => completeFollowUp(tx, ctx, step1.id))).toBe(
      "completed",
    );
    expect(await asOwner((tx) => completeFollowUp(tx, ctx, step1.id))).toBe(
      "already_completed",
    );
    expect(
      await rejection(
        asOwner((tx) => cancelFollowUp(tx, ctx, step1.id, "lead_replied")),
      ),
    ).toMatchObject({ code: "invalid_state" });
    expect(
      await asOwner((tx) => cancelFollowUp(tx, ctx, step2.id, "lead_replied")),
    ).toBe("cancelled");
    expect(
      await asOwner((tx) => cancelFollowUp(tx, ctx, step2.id, "lead_replied")),
    ).toBe("already_cancelled");
    expect(await eventCount(TENANT_A, "follow_up.completed")).toBe(1);
    expect(await eventCount(TENANT_A, "follow_up.cancelled")).toBe(1);
  });

  it("cancels a plan's open follow-ups, and their jobs later change nothing", async () => {
    // Arrange
    const plan = await schedule(
      planInput("cancel-plan", anchorWithFirstStepDue()),
    );
    await run();

    // Act
    const ctx = context(TENANT_A);
    expect(
      await asOwner((tx) =>
        cancelFollowUpPlan(tx, ctx, plan.planId, "lead_converted"),
      ),
    ).toBe("cancelled");
    expect(
      await asOwner((tx) =>
        cancelFollowUpPlan(tx, ctx, plan.planId, "lead_converted"),
      ),
    ).toBe("already_cancelled");
    const rows = await occurrences(plan.planId);
    await makeJobDue(admin, rows[1].job_id);
    const late = await run();

    // Assert
    expect(rows.map((r) => r.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(late.detail).toBe("follow_up=cancelled");
    expect((await occurrences(plan.planId))[1].status).toBe("cancelled");
  });

  it("refuses to delete open work, and keeps a closed follow-up unchanged", async () => {
    const plan = await schedule(planInput("history", new Date()));
    const [step1] = await occurrences(plan.planId);
    expect(
      await rejection(
        admin.query("delete from ops.follow_ups where id = $1", [step1.id]),
      ),
    ).toMatchObject({ code: "OS409" });
    expect(
      await rejection(
        admin.query("delete from ops.follow_up_plans where id = $1", [
          plan.planId,
        ]),
      ),
    ).toMatchObject({ code: "OS409" });
    await asOwner((tx) =>
      cancelFollowUp(tx, context(TENANT_A), step1.id, "operator_cancelled"),
    );
    expect(
      await rejection(
        admin.query(
          "update ops.follow_ups set status = 'scheduled', closed_by = null, close_reason = null, cancelled_at = null where id = $1",
          [step1.id],
        ),
      ),
    ).toMatchObject({ code: "OS409" });
  });
});

describe("one tenant reaches nothing of another's follow-ups", () => {
  it("answers not found for another tenant's follow-up and plan, and refuses its units and policy", async () => {
    // Arrange
    const plan = await schedule(planInput("tenant-a", new Date()));
    const [step1] = await occurrences(plan.planId);
    const ctxB = context(TENANT_B);

    // Act / Assert
    for (const attempt of [
      asOwner((tx) => completeFollowUp(tx, ctxB, step1.id)),
      asOwner((tx) => cancelFollowUp(tx, ctxB, step1.id, "lead_replied")),
      asOwner((tx) =>
        cancelFollowUpPlan(tx, ctxB, plan.planId, "lead_replied"),
      ),
    ]) {
      expect(await rejection(attempt)).toMatchObject({ code: "not_found" });
    }
    // Tenant B naming tenant A's company and department: the composite keys
    // make the row unstorable.
    expect(
      await rejection(
        schedule(planInput("cross-tenant", new Date()), TENANT_B),
      ),
    ).toBeInstanceOf(Error);
    // Tenant A cannot use tenant B's policy, even by its key: each tenant has its own.
    await asOwner((tx) =>
      defineFollowUpPolicyVersion(tx, context(TENANT_B), {
        policyKey: "b-only",
        label: "B only",
        stepOffsetsMinutes: [60],
      }),
    );
    expect(
      await rejection(
        schedule(planInput("b-policy", new Date(), { policyKey: "b-only" })),
      ),
    ).toMatchObject({ code: "not_found" });
    expect((await occurrences(plan.planId))[0].status).toBe("scheduled");
    expect(officeB.companyId).not.toBe(office.companyId);
  });
});
