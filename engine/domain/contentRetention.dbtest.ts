// BASELINE Q8, owner decisions D6 and D7, through the REAL worker loop against
// a real Postgres.
//
// supabase/tests/content_retention.sql attacks the database inside one
// rolled-back transaction. What only this file proves is that a deployed
// worker, with nothing but its registry, redacts a protected flow when its
// clock ends: the one internal job the decision queued is leased and run by
// the production handler; before the deadline the queue offers nothing; the
// owner's sweep and erasure reach the same result; and two concurrent sweeps
// never process a flow twice.
//
// The flows run on the in-process provider (the fake, named `fake`), pinned,
// with NO authorization: D6 then applies its own 30 days. ALL DATA HERE IS
// SYNTHETIC; the "health" class labels invented text to exercise the lifecycle.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import {
  LEAD_TRIAGE_CAPABILITY,
  type LeadTriage,
} from "../models/leadTriage.ts";
import {
  resetFixtures,
  TENANT_A,
  TENANT_B,
} from "../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "./agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "./companyOs.ts";
import {
  eraseTaskContent,
  listContentRetention,
  sweepContentRetention,
} from "./contentRetention.ts";
import type { CompanyOsError } from "./errors.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
  registryServing,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-retention";
const SENTINEL = "SENTINEL-RETENTION";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: `${SENTINEL} summary of an invented enquiry.`,
  intent: "information",
  priority: "normal",
  recommended_next_action: `${SENTINEL} next action.`,
  response_draft: `${SENTINEL} draft reply.`,
  needs_human_review: true,
  flags: Object.freeze([]),
}) as LeadTriage;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

const fakeProvider = () => {
  const provider = createFakeModelProvider({
    type: "respond",
    content: ADVICE,
  });
  return { provider, registry: registryServing(provider) };
};

interface Flow {
  readonly tenantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly reviewId: string;
}

let sequence = 0;

/** A health lead, pinned to the in-process provider, run by the real worker and reviewed. */
async function decidedFlow(
  registry: ReturnType<typeof fakeProvider>["registry"],
  tenantId: string = TENANT_A,
): Promise<Flow> {
  sequence += 1;
  const key = `dbtest-retention-${sequence}`;
  const { taskId, runId } = await owner.withTransaction(async (tx) => {
    const ctx = { tenantId, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: `dbtest-retention-${sequence}`,
      name: "Clinic",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "intake",
      name: "Intake",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "lead-triage",
      name: "Lead Triage",
      role: "Intake assistant",
    });
    const task = await createTask(tx, ctx, {
      companyId,
      type: LEAD_TRIAGE_CAPABILITY,
      title: "Lead triage",
      description: `${SENTINEL} invented enquiry ${sequence}`,
      dataClass: "health",
    });
    await assignTask(tx, ctx, task, agentId);
    const run = await requestAgentRun(tx, ctx, {
      taskId: task,
      agentId,
      capability: LEAD_TRIAGE_CAPABILITY,
      idempotencyKey: key,
      pinnedProvider: "fake",
    });
    return { taskId: task, runId: run };
  });
  await runAgentJob(registry);
  const { rows } = await admin.query<{ id: string }>(
    "select id from ops.review_items where agent_run_id = $1",
    [runId],
  );
  const reviewId = rows[0]?.id;
  expect(reviewId).toBeDefined();
  await admin.query(
    `select ops.record_review_decision($1, $2, 'rejected', 'dbtest-reviewer', 'dbtest', $3)`,
    [tenantId, reviewId, `${SENTINEL} reviewer note`],
  );
  return { tenantId, taskId, runId, reviewId };
}

/** Moves a flow's clock and its job into the past: the owner's DISABLE TRIGGER. */
async function passDeadline(flow: Flow): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query(
      "alter table ops.content_retention disable trigger content_retention_guard_update",
    );
    await client.query(
      `update ops.content_retention
          set anchored_at = anchored_at - interval '31 days', due_at = due_at - interval '31 days'
        where task_id = $1`,
      [flow.taskId],
    );
    await client.query(
      "alter table ops.content_retention enable always trigger content_retention_guard_update",
    );
    await client.query(
      `update ops.jobs set available_at = now() - interval '1 second'
        where id = (select job_id from ops.content_retention where task_id = $1)`,
      [flow.taskId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

interface FlowState {
  readonly description: string | null;
  readonly taskRedacted: boolean;
  readonly dataClass: string;
  readonly result: unknown;
  readonly inputFingerprint: string | null;
  readonly runStatus: string;
  readonly provider: string | null;
  readonly completedAt: string | null;
  readonly proposed: unknown;
  readonly note: string | null;
  readonly decision: string;
  readonly reviewer: string | null;
  readonly contentLeft: boolean;
}

async function readFlow(flow: Flow): Promise<FlowState> {
  const { rows } = await admin.query<FlowState>(
    `select t.description, t.content_redacted_at is not null as "taskRedacted", t.data_class as "dataClass",
            r.result, r.input_fingerprint as "inputFingerprint", r.status as "runStatus", r.provider,
            r.completed_at::text as "completedAt",
            v.proposed, v.decision_note as note, v.status as decision, v.reviewer,
            (t::text || r::text || v::text) like '%' || $4 || '%' as "contentLeft"
       from ops.tasks t, ops.agent_runs r, ops.review_items v
      where t.id = $1 and r.id = $2 and v.id = $3`,
    [flow.taskId, flow.runId, flow.reviewId, SENTINEL],
  );
  return rows[0];
}

beforeEach(async () => {
  // The fixture governance records the in-process provider's price for MODEL.
  await resetFixtures(admin);
});

describe("AI working-content retention (D6)", () => {
  it("the worker redacts a decided health flow when its 30 days end, and nothing before", async () => {
    const { provider, registry } = fakeProvider();
    const flow = await decidedFlow(registry);
    const before = await readFlow(flow);
    expect(before.contentLeft).toBe(true);
    expect(before.inputFingerprint).not.toBeNull();

    // Scheduled 30 days on, with no authorization: the in-process path.
    const [row] = await owner.withTransaction((tx) =>
      listContentRetention(tx, { tenantId: TENANT_A }),
    );
    expect(row).toMatchObject({
      taskId: flow.taskId,
      dataClass: "health",
      reviewItemId: flow.reviewId,
      retentionDays: 30,
      dataAuthorizationId: null,
      state: "scheduled",
    });
    expect(
      Date.parse(row.dueAt as string) - Date.parse(row.anchoredAt as string),
    ).toBe(30 * 24 * 3_600_000);

    // Before its deadline the queue offers the worker nothing to do.
    expect((await runAgentJob(registry)).outcome).toBe("idle");
    expect((await readFlow(flow)).contentLeft).toBe(true);

    await passDeadline(flow);
    const pass = await runAgentJob(registry);
    expect(pass).toMatchObject({
      outcome: "succeeded",
      kind: "content.retention_due",
      detail: "content_retention=redacted",
    });

    const after = await readFlow(flow);
    expect(after).toMatchObject({
      description: null,
      taskRedacted: true,
      dataClass: "health",
      result: null,
      inputFingerprint: null,
      runStatus: "succeeded",
      provider: "fake",
      completedAt: before.completedAt,
      proposed: null,
      note: null,
      decision: "rejected",
      reviewer: "dbtest-reviewer",
      contentLeft: false,
    });
    // The model was asked once, for the triage; the redaction called nothing.
    expect(provider.calls).toHaveLength(1);

    // A repeat changes nothing: the owner's sweep finds nothing due.
    await expect(
      owner.withTransaction((tx) =>
        sweepContentRetention(tx, { actor: "dbtest-owner" }),
      ),
    ).resolves.toEqual({ redacted: 0, inProgress: 0 });
    const [redacted] = await owner.withTransaction((tx) =>
      listContentRetention(tx, { tenantId: TENANT_A }),
    );
    expect(redacted).toMatchObject({
      state: "redacted",
      redactionReason: "retention_expired",
      redactedBy: "system:content-retention",
    });
  });

  it("two concurrent sweeps redact each due flow exactly once", async () => {
    const { registry } = fakeProvider();
    const flows = [];
    for (let i = 0; i < 3; i += 1) flows.push(await decidedFlow(registry));
    for (const flow of flows) await passDeadline(flow);

    const results = await Promise.all(
      ["dbtest-sweep-a", "dbtest-sweep-b"].map((actor) =>
        admin.query<{ result: { redacted: number } }>(
          "select ops.sweep_content_retention(10, $1) as result",
          [actor],
        ),
      ),
    );
    const total = results.reduce(
      (sum, { rows }) => sum + rows[0].result.redacted,
      0,
    );
    expect(total).toBe(3);
    for (const flow of flows) {
      expect((await readFlow(flow)).contentLeft).toBe(false);
    }
    // Their queued jobs then find each flow already redacted.
    for (let i = 0; i < 3; i += 1) {
      expect((await runAgentJob(registry)).detail).toBe(
        "content_retention=already_redacted",
      );
    }
  });
});

describe("the owner's erasure (D7)", () => {
  it("redacts one flow at once, in its own tenant only", async () => {
    const { registry } = fakeProvider();
    const flow = await decidedFlow(registry);

    await expect(
      owner.withTransaction((tx) =>
        eraseTaskContent(tx, {
          tenantId: TENANT_B,
          taskId: flow.taskId,
          actor: "dbtest-owner",
        }),
      ),
    ).rejects.toMatchObject({
      code: "not_found",
    } satisfies Partial<CompanyOsError>);
    expect((await readFlow(flow)).contentLeft).toBe(true);

    await expect(
      owner.withTransaction((tx) =>
        eraseTaskContent(tx, {
          tenantId: TENANT_A,
          taskId: flow.taskId,
          actor: "dbtest-owner",
        }),
      ),
    ).resolves.toEqual({ taskId: flow.taskId, status: "redacted" });
    const after = await readFlow(flow);
    expect(after).toMatchObject({
      contentLeft: false,
      decision: "rejected",
      runStatus: "succeeded",
      dataClass: "health",
    });
    const [row] = await owner.withTransaction((tx) =>
      listContentRetention(tx, { tenantId: TENANT_A }),
    );
    expect(row).toMatchObject({
      state: "redacted",
      redactionReason: "erasure",
      redactedBy: "dbtest-owner",
    });
  });
});
