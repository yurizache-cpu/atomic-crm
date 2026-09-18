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
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import {
  LEAD_TRIAGE_CAPABILITY,
  LEAD_TRIAGE_PROMPT_VERSION,
  type LeadTriage,
} from "../models/leadTriage.ts";
import { resetFixtures, TENANT_A } from "../worker/testSupport/dbFixture.ts";
import { createAgent, createCompany, createDepartment } from "./companyOs.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import { admitInboundMessage } from "./leadIntake.ts";
import {
  listReviewItems,
  readReviewItem,
  recordReviewDecision,
} from "./reviewQueue.ts";
import { setSpendLimit } from "./spendLimits.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
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

const { readRun, runAgentJob, countJobs } = agentRuntimeProbes(() => ({
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

const message = (overrides: Record<string, unknown> = {}): InboundMessage =>
  port.receive({
    external_message_id: "dbtest-msg-0001",
    contact_ref: "synthetic:lead-alpha",
    body: SYNTHETIC_BODY,
    received_at: "2026-09-17T12:00:00Z",
    do_not_contact: false,
    ...overrides,
  });

const admit = (clinic: Clinic, inbound: InboundMessage = message()) =>
  owner.withTransaction((tx) =>
    admitInboundMessage(
      tx,
      {
        tenantId: clinic.tenantId,
        companyId: clinic.companyId,
        agentId: clinic.agentId,
      },
      inbound,
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
  it("is triaged, but the draft can never be accepted", async () => {
    const clinic = await buildClinic();
    await admit(clinic, message({ do_not_contact: true }));
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
