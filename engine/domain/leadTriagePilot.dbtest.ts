// Phase 2A end to end against a real Postgres: a synthetic message becomes one
// unit of work, the REAL runtime executes it under every Phase 1D/1D.1 gate,
// and a person decides what happens — which in this phase is nothing but the
// decision being recorded.
//
// supabase/tests/lead_triage_pilot.sql attacks the database with psql inside one
// rolled-back transaction. It cannot see what this file proves:
//
//   * that the ingress reaches a provider ONLY through the runtime, and how
//     many times it is called;
//   * that the review item is DERIVED from a run that succeeded, in the same
//     statement that settled it, and never exists for one that failed;
//   * that the kill switch and the spend limits refuse the pilot exactly as
//     they refuse any other run, before any call;
//   * that a redelivery of the same message calls nothing a second time.
//
// Every case counts provider calls: "one message, at most one model call" is
// proven only by a count.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js).
//
// ALL DATA HERE IS SYNTHETIC (BASELINE Q8). The fictitious lead below is
// invented for this test; no real message, patient or clinical text is used.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import type { InboundMessage } from "../communication/types.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import type { ContactPolicy } from "../communication/types.ts";
import {
  LEAD_TRIAGE_CAPABILITY,
  LEAD_TRIAGE_PROMPT_VERSION,
  type LeadTriage,
} from "../models/leadTriage.ts";
import { resetFixtures, TENANT_A } from "../worker/testSupport/dbFixture.ts";
import { createAgent, createCompany, createDepartment } from "./companyOs.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import { requestAgentRun } from "./agentRuns.ts";
import { admitInboundMessage } from "./leadIntake.ts";
import {
  listReviewItems,
  openMissingReviews,
  readReviewItem,
  recordReviewDecision,
} from "./reviewQueue.ts";
import { setSpendLimit } from "./spendLimits.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  VALID,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-lead-triage";

/** A fictitious enquiry. Invented for this test; not from any real person. */
const SYNTHETIC_BODY =
  "Oi, vi o site. Tenho tido muita ansiedade e pensamentos demais e queria entender como funciona a primeira consulta.";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary:
    "New enquiry asking how a first session works, mentioning ongoing anxiety.",
  intent: "information",
  priority: "normal",
  recommended_next_action:
    "Reply explaining how a first session works and offer two times.",
  response_draft:
    "Oi! Obrigado por escrever. A primeira consulta dura 50 minutos e serve para entender o que voce procura.",
  needs_human_review: true,
  flags: Object.freeze(["unclear"]),
}) as LeadTriage;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

const { buildOfficeTask, countJobs, readRun, requestRun, runAgentJob } =
  agentRuntimeProbes(() => ({
    admin,
    owner,
    db,
  }));

interface Clinic {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
}

/** One clinic with one triage agent. No task: the ingress creates that. */
const buildClinic = (tenantId = TENANT_A): Promise<Clinic> =>
  owner.withTransaction(async (tx) => {
    const ctx = { tenantId, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-clinic",
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
      description: "Triages new enquiries for a person to review.",
    });
    return { tenantId, companyId, departmentId, agentId };
  });

/** The transport, on: the ingress refuses to exist otherwise. */
const port = createSyntheticCommunicationPort({
  COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
});

const LEAD = "synthetic:lead-alpha";

/** The trusted consent source: this fictitious lead may be contacted. */
const LEAD_ELIGIBLE = createSyntheticContactPolicy({ eligible: [LEAD] });
/** The trusted consent source: this fictitious lead must not be contacted. */
const LEAD_BLOCKED = createSyntheticContactPolicy({ blocked: [LEAD] });

const message = (overrides: Record<string, unknown> = {}): InboundMessage =>
  port.receive({
    external_message_id: "dbtest-msg-0001",
    contact_ref: LEAD,
    body: SYNTHETIC_BODY,
    received_at: "2026-09-17T12:00:00Z",
    ...overrides,
  });

const admit = (
  clinic: Clinic,
  inbound: InboundMessage = message(),
  policy: ContactPolicy = LEAD_ELIGIBLE,
) =>
  owner.withTransaction((tx) =>
    admitInboundMessage(
      tx,
      {
        tenantId: clinic.tenantId,
        companyId: clinic.companyId,
        agentId: clinic.agentId,
      },
      inbound,
      policy,
      SOURCE,
    ),
  );

const reviewsOf = (tenantId: string) =>
  owner.withTransaction((tx) => listReviewItems(tx, { tenantId }));

const countRows = async (table: string, tenantId: string): Promise<number> => {
  const { rows } = await admin.query<{ count: string }>(
    `select count(*)::text as count from ${table} where tenant_id = $1`,
    [tenantId],
  );
  return Number(rows[0].count);
};

const countContacts = async (): Promise<number> => {
  const { rows } = await admin.query<{ count: string }>(
    "select count(*)::text as count from public.contacts",
  );
  return Number(rows[0].count);
};

beforeEach(async () => {
  await resetFixtures(admin);
});

// ---------------------------------------------------------------------------
// 1. The demonstration flow
// ---------------------------------------------------------------------------

describe("one synthetic lead, end to end", () => {
  it("becomes one task, one run, one review, and one recorded decision", async () => {
    const clinic = await buildClinic();
    const contactsBefore = await countContacts();

    // 1. Ingress. It creates work and calls nothing.
    const admitted = await admit(clinic);
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });
    expect(provider.calls).toHaveLength(0);

    // 2. The task carries the message, assigned to the triage agent.
    const { rows: tasks } = await admin.query<{
      type: string;
      description: string;
      assigned_agent_id: string;
      status: string;
    }>(
      "select type, description, assigned_agent_id, status from ops.tasks where id = $1",
      [admitted.taskId],
    );
    expect(tasks[0]).toMatchObject({
      type: "lead_triage",
      description: SYNTHETIC_BODY,
      assigned_agent_id: clinic.agentId,
      status: "assigned",
    });

    // 3. The run was requested, not executed: pending, with a job waiting.
    const requested = await readRun(admitted.agentRunId);
    expect(requested).toMatchObject({
      status: "pending",
      capability: LEAD_TRIAGE_CAPABILITY,
      model_route: "standard",
    });
    expect(requested.job_id).not.toBeNull();
    expect(await countJobs(clinic.tenantId)).toBe(1);

    // 4. The runtime executes it. One pass, one provider call.
    const result = await runAgentJob(registry);
    expect(result.outcome).toBe("succeeded");
    expect(provider.calls).toHaveLength(1);

    // The prompt the provider received is the lead triage prompt, and it
    // carries the message as data.
    expect(provider.calls[0].output.name).toBe(LEAD_TRIAGE_CAPABILITY);
    expect(provider.calls[0].input).toContain(SYNTHETIC_BODY);
    expect(provider.calls[0].instructions).toContain("Never diagnose");

    const executed = await readRun(admitted.agentRunId);
    expect(executed).toMatchObject({
      status: "succeeded",
      prompt_version: LEAD_TRIAGE_PROMPT_VERSION,
      provider: "fake",
    });
    expect(executed.result).toEqual(ADVICE);

    // 5. The review item was derived from the run that succeeded.
    const pending = await reviewsOf(clinic.tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      status: "pending",
      taskId: admitted.taskId,
      agentRunId: admitted.agentRunId,
      capability: LEAD_TRIAGE_CAPABILITY,
      doNotContact: false,
      reviewer: null,
      reviewedAt: null,
    });

    const detail = await owner.withTransaction((tx) =>
      readReviewItem(tx, pending[0].id, { tenantId: clinic.tenantId }),
    );
    expect(detail?.proposed).toEqual(ADVICE);

    // 6. A person decides, and the decision is auditable.
    const decided = await owner.withTransaction((tx) =>
      recordReviewDecision(
        tx,
        { tenantId: clinic.tenantId, source: "operator-cli" },
        {
          reviewId: pending[0].id,
          decision: "accepted",
          reviewer: "owner",
          note: "good draft, will edit the second line",
        },
      ),
    );
    expect(decided).toMatchObject({ status: "accepted", recorded: true });

    const [reviewed] = await reviewsOf(clinic.tenantId);
    expect(reviewed).toMatchObject({
      status: "accepted",
      reviewer: "owner",
      decisionNote: "good draft, will edit the second line",
    });
    expect(reviewed.reviewedAt).not.toBeNull();

    // 7. Nothing else happened. No second call, no CRM write, and the four
    //    facts of the flow are on the record.
    expect(provider.calls).toHaveLength(1);
    expect(await countContacts()).toBe(contactsBefore);

    const { rows: facts } = await admin.query<{ type: string }>(
      `select type from ops.events
        where tenant_id = $1 and type like any (array['communication.%', 'lead_triage.%'])
        order by seq`,
      [clinic.tenantId],
    );
    expect(facts.map((row) => row.type)).toEqual([
      "communication.received",
      "lead_triage.admitted",
      "lead_triage.review_pending",
      "lead_triage.reviewed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency, through the whole path
// ---------------------------------------------------------------------------

describe("a message delivered more than once", () => {
  it("is admitted once and calls the provider once", async () => {
    const clinic = await buildClinic();
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });

    const first = await admit(clinic);
    const second = await admit(clinic);
    expect(second).toEqual(first);

    await runAgentJob(registry);
    // A third delivery, after the run already succeeded.
    const third = await admit(clinic);
    expect(third).toEqual(first);

    expect(provider.calls).toHaveLength(1);
    expect(await countRows("ops.inbound_messages", clinic.tenantId)).toBe(1);
    expect(await countRows("ops.tasks", clinic.tenantId)).toBe(1);
    expect(await countRows("ops.agent_runs", clinic.tenantId)).toBe(1);
    expect(await countRows("ops.review_items", clinic.tenantId)).toBe(1);
  });

  it("refuses the same identity carrying a different message", async () => {
    const clinic = await buildClinic();
    await admit(clinic);

    await expect(
      admit(clinic, message({ body: "A completely different enquiry." })),
    ).rejects.toMatchObject({ code: "invalid_state" });

    expect(await countRows("ops.tasks", clinic.tenantId)).toBe(1);
  });

  it("cannot be reviewed twice, because a finished run cannot be settled twice", async () => {
    const clinic = await buildClinic();
    const admitted = await admit(clinic);
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    await runAgentJob(registry);

    // The review is derived from a run reaching `succeeded`, so a second review
    // would need a second settlement. The run guard refuses one outright, even
    // to the owner and even when the status does not change.
    await expect(
      admin.query("update ops.agent_runs set status = status where id = $1", [
        admitted.agentRunId,
      ]),
    ).rejects.toThrow(/finished run is immutable/);

    // And if one ever did, the unique key on the run would refuse the row.
    await expect(
      admin.query(
        `insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed)
         select tenant_id, company_id, task_id, agent_run_id, capability, proposed
           from ops.review_items where agent_run_id = $1`,
        [admitted.agentRunId],
      ),
    ).rejects.toThrow(/review_items_run_key|duplicate key/);

    expect(await countRows("ops.review_items", clinic.tenantId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Governance is inherited, not re-implemented
// ---------------------------------------------------------------------------

describe("the pilot under the existing gates", () => {
  it("calls nothing and opens no review when the kill switch is on", async () => {
    const clinic = await buildClinic();
    const stopId = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: clinic.tenantId },
        { reason: "dbtest lead triage stop", actor: "dbtest" },
      ),
    );

    const admitted = await admit(clinic);
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });

    // The request recorded the refusal instead of creating a job.
    const run = await readRun(admitted.agentRunId);
    expect(run).toMatchObject({
      status: "cancelled",
      error_category: "refused",
      error_code: "execution_stopped",
    });
    expect(run.job_id).toBeNull();
    expect(await countJobs(clinic.tenantId)).toBe(0);

    const idle = await runAgentJob(registry);
    expect(idle.outcome).toBe("idle");
    expect(provider.calls).toHaveLength(0);
    expect(await reviewsOf(clinic.tenantId)).toHaveLength(0);

    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, stopId, {
        reason: "dbtest cleanup",
        actor: "dbtest",
      }),
    );
  });

  it("calls nothing when the tenant's budget cannot absorb the run", async () => {
    const clinic = await buildClinic();
    // A budget of one micro-USD: smaller than any reservation this route makes.
    await owner.withTransaction((tx) =>
      setSpendLimit(
        tx,
        { scope: "tenant", tenantId: clinic.tenantId },
        { dailyUsd: "0.000001", timezone: "UTC" },
        { reason: "dbtest lead triage budget", actor: "dbtest" },
      ),
    );

    const admitted = await admit(clinic);
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });

    await runAgentJob(registry);

    const run = await readRun(admitted.agentRunId);
    expect(run.status).toBe("cancelled");
    expect(run.error_category).toBe("refused");
    expect(provider.calls).toHaveLength(0);
    expect(await reviewsOf(clinic.tenantId)).toHaveLength(0);
  });

  it("opens no review when the model answers outside its contract", async () => {
    const clinic = await buildClinic();
    const admitted = await admit(clinic);
    // A task_assessment answer to a lead_triage run: valid JSON, wrong contract.
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: {
        outcome: "completed",
        summary: "ok",
        proposed_next_steps: [],
      },
    });

    await runAgentJob(registry);

    const run = await readRun(admitted.agentRunId);
    expect(run.status).toBe("failed");
    expect(run.result).toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect(await reviewsOf(clinic.tenantId)).toHaveLength(0);
  });

  it("opens no review when the provider fails", async () => {
    const clinic = await buildClinic();
    const admitted = await admit(clinic);
    const { registry } = fakeRuntime({
      type: "fail",
      category: "provider_5xx",
    });

    await runAgentJob(registry);

    const run = await readRun(admitted.agentRunId);
    expect(run.status).toBe("indeterminate");
    expect(await reviewsOf(clinic.tenantId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Consent, and the boundary the pilot must not cross
// ---------------------------------------------------------------------------

describe("a lead who must not be contacted", () => {
  // The trust boundary: consent comes from the policy the caller trusts, never
  // from the delivery. A delivery that claims its sender is contactable is
  // refused by the transport before anything exists...
  it("cannot be declared contactable by its own message", async () => {
    for (const claim of [
      { do_not_contact: false },
      { doNotContact: false },
      { consent: "granted" },
    ]) {
      expect(() => message(claim)).toThrow(/synthetic delivery is/);
    }
  });

  // ...and a claim smuggled past the transport onto the envelope is not read:
  // the payload says eligible, the trusted source says blocked, blocked wins.
  it("is recorded blocked when the payload says eligible and the trusted source says blocked", async () => {
    const clinic = await buildClinic();
    const claimingEligible = {
      ...message(),
      doNotContact: false,
      do_not_contact: false,
    } as unknown as InboundMessage;

    const admitted = await admit(clinic, claimingEligible, LEAD_BLOCKED);

    const { rows } = await admin.query<{ do_not_contact: boolean }>(
      "select do_not_contact from ops.inbound_messages where id = $1",
      [admitted.inboundMessageId],
    );
    expect(rows[0].do_not_contact).toBe(true);
  });

  it("is triaged, but the draft can never be accepted", async () => {
    const clinic = await buildClinic();
    await admit(clinic, message(), LEAD_BLOCKED);
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    await runAgentJob(registry);

    const [item] = await reviewsOf(clinic.tenantId);
    expect(item).toMatchObject({ status: "pending", doNotContact: true });

    await expect(
      owner.withTransaction((tx) =>
        recordReviewDecision(
          tx,
          { tenantId: clinic.tenantId, source: "operator-cli" },
          { reviewId: item.id, decision: "accepted", reviewer: "owner" },
        ),
      ),
    ).rejects.toMatchObject({ code: "refused" });

    // Rejecting is always available: refusing to answer needs no consent.
    const rejected = await owner.withTransaction((tx) =>
      recordReviewDecision(
        tx,
        { tenantId: clinic.tenantId, source: "operator-cli" },
        {
          reviewId: item.id,
          decision: "rejected",
          reviewer: "owner",
          note: "do not contact",
        },
      ),
    );
    expect(rejected.status).toBe("rejected");
  });

  it("is never decided by another tenant", async () => {
    const clinic = await buildClinic();
    await admit(clinic);
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    await runAgentJob(registry);
    const [item] = await reviewsOf(clinic.tenantId);

    await expect(
      owner.withTransaction((tx) =>
        recordReviewDecision(
          tx,
          {
            tenantId: "b0000000-0000-4000-8000-00000000000b",
            source: "operator-cli",
          },
          { reviewId: item.id, decision: "accepted", reviewer: "someone" },
        ),
      ),
    ).rejects.toMatchObject({ code: "not_found" });

    // And another tenant's listing does not see it.
    expect(
      await reviewsOf("b0000000-0000-4000-8000-00000000000b"),
    ).toHaveLength(0);
  });

  it("is decided once: the second answer is refused, the same answer is a no-op", async () => {
    const clinic = await buildClinic();
    await admit(clinic);
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    await runAgentJob(registry);
    const [item] = await reviewsOf(clinic.tenantId);

    const decide = (decision: "accepted" | "rejected", reviewer = "owner") =>
      owner.withTransaction((tx) =>
        recordReviewDecision(
          tx,
          { tenantId: clinic.tenantId, source: "operator-cli" },
          { reviewId: item.id, decision, reviewer },
        ),
      );

    expect(await decide("accepted")).toMatchObject({ recorded: true });
    expect(await decide("accepted")).toMatchObject({ recorded: false });
    await expect(decide("rejected")).rejects.toMatchObject({
      code: "invalid_state",
    });

    // One decision, one fact.
    const { rows } = await admin.query<{ count: string }>(
      `select count(*)::text as count from ops.events
        where tenant_id = $1 and type = 'lead_triage.reviewed'`,
      [clinic.tenantId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. A downstream review-queue failure never becomes a second paid call
// ---------------------------------------------------------------------------

/** Makes every insert into the review queue fail, as an outage would. */
const breakReviewQueue = async (): Promise<void> => {
  await admin.query(`create or replace function ops.dbtest_break_review_queue()
    returns trigger language plpgsql as $$
    begin raise exception 'dbtest: the review queue is down'; end $$`);
  await admin.query(`create trigger dbtest_break_review_queue
    before insert on ops.review_items
    for each row execute function ops.dbtest_break_review_queue()`);
};

const repairReviewQueue = async (): Promise<void> => {
  await admin.query(
    "drop trigger if exists dbtest_break_review_queue on ops.review_items",
  );
  await admin.query("drop function if exists ops.dbtest_break_review_queue()");
};

/**
 * The operator's recovery (`npm run ops -- triage recover`): derive every
 * review a succeeded run is missing, through the same service the CLI calls.
 */
const recoverReviews = (tenantId: string): Promise<number> =>
  owner.withTransaction((tx) => openMissingReviews(tx, { tenantId }));

describe("a review queue that fails after the provider answered", () => {
  afterAll(repairReviewQueue);

  it("keeps the paid answer, never calls again, and is recovered once", async () => {
    const clinic = await buildClinic();
    const admitted = await admit(clinic);
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });

    await breakReviewQueue();
    try {
      await runAgentJob(registry);

      // The provider answered once, and the answer is kept: the run's
      // settlement does not depend on the review queue downstream of it.
      expect(provider.calls).toHaveLength(1);
      const run = await readRun(admitted.agentRunId);
      expect(run.status).toBe("succeeded");
      expect(run.result).toEqual(ADVICE);
      expect(await reviewsOf(clinic.tenantId)).toHaveLength(0);

      // Nothing is left for a worker to retry, so nothing can call again.
      expect((await runAgentJob(registry)).outcome).toBe("idle");
      expect(provider.calls).toHaveLength(1);
    } finally {
      await repairReviewQueue();
    }

    // Recovery derives the missing review from the stored answer: once.
    expect(await recoverReviews(clinic.tenantId)).toBe(1);
    expect(await recoverReviews(clinic.tenantId)).toBe(0);

    const [item] = await reviewsOf(clinic.tenantId);
    expect(item).toMatchObject({
      status: "pending",
      agentRunId: admitted.agentRunId,
    });
    const detail = await owner.withTransaction((tx) =>
      readReviewItem(tx, item.id, { tenantId: clinic.tenantId }),
    );
    expect(detail?.proposed).toEqual(ADVICE);

    const { rows } = await admin.query<{ count: string }>(
      `select count(*)::text as count from ops.events
        where tenant_id = $1 and type = 'lead_triage.review_pending'`,
      [clinic.tenantId],
    );
    expect(Number(rows[0].count)).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Only lead triage opens a review
// ---------------------------------------------------------------------------

describe("a successful run of another capability", () => {
  it("opens no review, and recovery finds none to open", async () => {
    const office = await buildOfficeTask();
    await requestRun(office, "dbtest-task-assessment-no-review");
    const { registry } = fakeRuntime({ type: "respond", content: VALID });

    await runAgentJob(registry);

    const { rows } = await admin.query<{ status: string }>(
      "select status from ops.agent_runs where tenant_id = $1",
      [office.tenantId],
    );
    expect(rows.map((row) => row.status)).toEqual(["succeeded"]);
    expect(await countRows("ops.review_items", office.tenantId)).toBe(0);
    expect(await recoverReviews(office.tenantId)).toBe(0);
    expect(await countRows("ops.review_items", office.tenantId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Concurrency: two deliveries at once, two decisions at once
// ---------------------------------------------------------------------------

describe("concurrent attempts", () => {
  it("converge when the same message is delivered twice at once", async () => {
    const clinic = await buildClinic();
    const first = await admin.connect();
    const second = await admin.connect();
    const params = [
      clinic.tenantId,
      clinic.companyId,
      clinic.agentId,
      "synthetic",
      "dbtest-concurrent-0001",
      LEAD,
      SYNTHETIC_BODY,
      SOURCE,
      false,
      "2026-09-17T12:00:00Z",
    ];
    const ADMIT =
      "select ops.admit_inbound_message($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result";
    try {
      await first.query("begin");
      await second.query("begin");
      const a = await first.query<{ result: Record<string, string> }>(
        ADMIT,
        params,
      );
      // The second delivery blocks on the first's uncommitted ledger row...
      const pending = second.query<{ result: Record<string, string> }>(
        ADMIT,
        params,
      );
      await first.query("commit");
      // ...and, once it commits, converges on the same work.
      const b = await pending;
      await second.query("commit");

      expect(b.rows[0].result).toEqual(a.rows[0].result);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await second.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }

    expect(await countRows("ops.inbound_messages", clinic.tenantId)).toBe(1);
    expect(await countRows("ops.tasks", clinic.tenantId)).toBe(1);
    expect(await countRows("ops.agent_runs", clinic.tenantId)).toBe(1);
  });

  it("record exactly one decision when two people decide at once", async () => {
    const clinic = await buildClinic();
    await admit(clinic);
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    await runAgentJob(registry);
    const [item] = await reviewsOf(clinic.tenantId);

    const first = await admin.connect();
    const second = await admin.connect();
    const DECIDE =
      "select ops.record_review_decision($1, $2, $3, $4, $5) as result";
    let refused: unknown;
    try {
      await first.query("begin");
      await second.query("begin");
      await first.query(DECIDE, [
        clinic.tenantId,
        item.id,
        "accepted",
        "reviewer one",
        SOURCE,
      ]);
      // The second decision waits on the first's row lock...
      const pending = second
        .query(DECIDE, [
          clinic.tenantId,
          item.id,
          "rejected",
          "reviewer two",
          SOURCE,
        ])
        .catch((error: unknown) => {
          refused = error;
        });
      await first.query("commit");
      await pending;
      await second.query("rollback");
    } finally {
      await first.query("rollback").catch(() => undefined);
      first.release();
      second.release();
    }

    // ...and, once the first commits, is refused: a decision is final.
    expect((refused as { code?: string } | undefined)?.code).toBe("OS409");
    const [decided] = await reviewsOf(clinic.tenantId);
    expect(decided).toMatchObject({
      status: "accepted",
      reviewer: "reviewer one",
    });
    const { rows } = await admin.query<{ count: string }>(
      `select count(*)::text as count from ops.events
        where tenant_id = $1 and type = 'lead_triage.reviewed'`,
      [clinic.tenantId],
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. The lead's words stay where the work needs them
// ---------------------------------------------------------------------------

describe("the inbound message body", () => {
  it("appears in no fact the flow records, lifecycle facts included", async () => {
    const clinic = await buildClinic();
    await admit(clinic);
    const { registry } = fakeRuntime({ type: "respond", content: ADVICE });
    await runAgentJob(registry);
    const [item] = await reviewsOf(clinic.tenantId);
    await owner.withTransaction((tx) =>
      recordReviewDecision(
        tx,
        { tenantId: clinic.tenantId, source: "operator-cli" },
        { reviewId: item.id, decision: "accepted", reviewer: "owner" },
      ),
    );

    const { rows } = await admin.query<{ type: string; payload: string }>(
      "select type, payload::text as payload from ops.events where tenant_id = $1",
      [clinic.tenantId],
    );
    expect(rows.length).toBeGreaterThan(4);
    for (const fragment of ["ansiedade", "primeira consulta", "vi o site"]) {
      expect(rows.filter((row) => row.payload.includes(fragment))).toEqual([]);
    }
    // Nor a job's payload, which the worker reads.
    const { rows: jobs } = await admin.query<{ payload: string }>(
      "select payload::text as payload from ops.jobs where tenant_id = $1",
      [clinic.tenantId],
    );
    expect(jobs.filter((job) => job.payload.includes("ansiedade"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Consent follows the lead, not the run (pre-push review, P1)
// ---------------------------------------------------------------------------

describe("consent on a run the admission did not create", () => {
  // The recovery path for a run that ended without advice is an explicit
  // retry — a NEW run. It must inherit what was recorded for the lead: before
  // the fix it found no admission by run id and opened an acceptable review.
  it("is inherited by a retry of a blocked lead, so its draft still cannot be accepted", async () => {
    const clinic = await buildClinic();
    const admitted = await admit(clinic, message(), LEAD_BLOCKED);

    // The first run ends without advice.
    await runAgentJob(
      fakeRuntime({ type: "fail", category: "provider_5xx" }).registry,
    );
    expect((await readRun(admitted.agentRunId)).status).toBe("indeterminate");

    // An operator retries it: a new run on the same task.
    const retryId = await owner.withTransaction((tx) =>
      requestAgentRun(
        tx,
        { tenantId: clinic.tenantId, source: SOURCE },
        {
          taskId: admitted.taskId,
          agentId: clinic.agentId,
          capability: LEAD_TRIAGE_CAPABILITY,
          idempotencyKey: "dbtest-operator-retry-1",
          retryOfRunId: admitted.agentRunId,
        },
      ),
    );
    await runAgentJob(
      fakeRuntime({ type: "respond", content: ADVICE }).registry,
    );
    expect((await readRun(retryId)).status).toBe("succeeded");

    const [item] = await reviewsOf(clinic.tenantId);
    expect(item).toMatchObject({ agentRunId: retryId, doNotContact: true });
    await expect(
      owner.withTransaction((tx) =>
        recordReviewDecision(
          tx,
          { tenantId: clinic.tenantId, source: "operator-cli" },
          { reviewId: item.id, decision: "accepted", reviewer: "owner" },
        ),
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("is do-not-contact when no admission established it at all", async () => {
    // A lead_triage run requested on a task no message was admitted for.
    const office = await buildOfficeTask();
    await owner.withTransaction((tx) =>
      requestAgentRun(
        tx,
        { tenantId: office.tenantId, source: SOURCE },
        {
          taskId: office.taskId,
          agentId: office.agentId,
          capability: LEAD_TRIAGE_CAPABILITY,
          idempotencyKey: "dbtest-unadmitted-lead-triage",
        },
      ),
    );
    await runAgentJob(
      fakeRuntime({ type: "respond", content: ADVICE }).registry,
    );

    const [item] = await reviewsOf(office.tenantId);
    expect(item).toMatchObject({ doNotContact: true });
  });
});
