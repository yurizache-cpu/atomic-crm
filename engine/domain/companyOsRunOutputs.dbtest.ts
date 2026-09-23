// What the Company OS read gates return about work the REAL runtime did (brief
// §13 item 2 and §16 "Minimisation"; SI-56 as proposed), against a real
// Postgres through the real `pg` driver.
//
// supabase/tests/company_os_api.sql plants sentinels in hand-made rows inside
// one rolled-back transaction. What it cannot show is the same sweep over rows
// the worker itself wrote: a stored result with a reply draft, a prompt built
// from a task body, fingerprints and provider ids from a real settlement, a
// lease owner on a live lease. This file drives them through the production
// handler with a scripted provider, reads EVERY catalogued function as a
// signed-in member (testSupport/companyOsMember.ts), with every selector the
// fixture has, and proves:
//
//   * no run result, reply draft, prompt, task title or body, agent role or
//     description, input fingerprint, provider id, correlation or idempotency
//     value, lease owner, job error, stored contact or message id, reviewer
//     label or unlisted source label reaches any output, by value or by key;
//   * the advice summary and recommended next action appear through
//     get_review_advice and nowhere else, without the draft;
//   * succeeded, failed and indeterminate runs and a working run keep their
//     status, error class and attention, with truthful evidence.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker runtime and the database fixture together
// (eslint.config.js).
//
// ALL DATA HERE IS SYNTHETIC (BASELINE Q8). The fictitious lead below is
// invented for this test; no real message, patient or clinical text is used.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  EVENT_SOURCES,
  OTHER_EVENT_SOURCE,
} from "../../contracts/company-os-api/index.ts";
import type { WorkerDatabase } from "../db/types.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import type { LeadTriage } from "../models/leadTriage.ts";
import type { FakeBehavior } from "../models/fakeModelProvider.ts";
import { runOneJob } from "../worker/runOneJob.ts";
import { resetFixtures, TENANT_A } from "../worker/testSupport/dbFixture.ts";
import { createAgent, createCompany, createDepartment } from "./companyOs.ts";
import { admitInboundMessage } from "./leadIntake.ts";
import { listReviewItems, recordReviewDecision } from "./reviewQueue.ts";
import { agentRunProbes } from "./testSupport/agentRunSessions.ts";
import {
  AGENT_SENTINEL,
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  TASK_SENTINEL,
} from "./testSupport/agentRuntimeProbes.ts";
import {
  agentIn,
  evidenceFaults,
  leaks,
  readAsMember,
  type AgentList,
  type ApiOutput,
  type CompanyOsRead,
} from "./testSupport/companyOsMember.ts";

const SOURCE = "dbtest-cos-outputs";
const WORKER = "dbtest-cos-outputs-worker";
/** The worker id of the live lease: `jobs.lease_owner` must never leave. */
const LEASE_OWNER = "dbtest-cos-lease-owner-8e61";

// Sentinels, each unique, planted in what the worker and the owner write.
const BODY = "dbtest-cos-body-sentinel-3a91";
const DRAFT = "dbtest-cos-draft-sentinel-6d02";
const SUMMARY = "dbtest-cos-summary-sentinel-b7e4";
const NEXT_ACTION = "dbtest-cos-next-action-sentinel-19cf";
const DESCRIPTION = "dbtest-cos-agent-description-sentinel-5c2d";
const JOB_ERROR = "dbtest-cos-job-error-sentinel-0f4b";
/** An email-shaped legacy reviewer label (the PR #6 review, fixture A). */
const REVIEWER = "dbtest-cos-reviewer@example.test";
const NOTE = "dbtest cos decision note, returned as content";
/**
 * A source label the provenance allowlist no longer carries: only a unit-test
 * default ever wrote it (supabase/tests/companyOsEventAllowlist.test.ts), so
 * an event stored under it must leave as "other" and the label nowhere.
 */
const UNLISTED_SOURCE = "synthetic-ingress";

/** A fictitious enquiry. Invented for this test; not from any real person. */
const SYNTHETIC_BODY = `Oi, queria entender como funciona a primeira consulta. ${BODY}`;

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: `Synthetic enquiry about how a first session works. ${SUMMARY}`,
  intent: "information",
  priority: "normal",
  recommended_next_action: `Reply with how a first session works. ${NEXT_ACTION}`,
  response_draft: `Oi! A primeira consulta dura 50 minutos. ${DRAFT}`,
  needs_human_review: true,
  flags: Object.freeze([]),
}) as LeadTriage;

/**
 * Keys no projection may carry, at any depth. Not `role`: OperatorContext's
 * membership role is a contract field; an agent's configured role is swept by
 * value instead.
 */
const FORBIDDEN_KEYS = Object.freeze([
  "result",
  "prompt",
  "instructions",
  "promptVersion",
  "inputFingerprint",
  "providerRequestId",
  "providerResponseId",
  "correlationId",
  "idempotencyKey",
  "requestFingerprint",
  "leaseOwner",
  "lastError",
  "responseDraft",
  "response_draft",
  "proposed",
  "title",
  "description",
  "reviewer",
  "requestedBy",
  "trippedBy",
  "clearedBy",
  "contactRef",
  "externalMessageId",
  "bodyFingerprint",
  "payload",
  "detail",
  "seq",
]);

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

const probes = agentRuntimeProbes(() => ({ admin, owner, db }));
const sessions = agentRunProbes(() => ({ admin, owner, worker: db }));

/** One clinic with a triage agent whose description carries a sentinel. */
const buildClinic = () =>
  owner.withTransaction(async (tx) => {
    const ctx = { tenantId: TENANT_A, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-cos-clinic",
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
      slug: "intake-triage",
      name: "Intake triage assistant",
      role: "Intake assistant",
      description: `Triages new enquiries for a person to review. ${DESCRIPTION}`,
    });
    return { companyId, agentId };
  });

const CONTACT = "synthetic:dbtest-cos-lead-4d7a";

async function admitLead(clinic: { companyId: string; agentId: string }) {
  const port = createSyntheticCommunicationPort({
    COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
  });
  return owner.withTransaction((tx) =>
    admitInboundMessage(
      tx,
      { tenantId: TENANT_A, ...clinic },
      port.receive({
        external_message_id: "dbtest-cos-msg-2b88",
        contact_ref: CONTACT,
        body: SYNTHETIC_BODY,
        received_at: "2026-09-22T12:00:00Z",
      }),
      createSyntheticContactPolicy({ eligible: [CONTACT] }),
      SOURCE,
    ),
  );
}

/** One pass of the real runtime with a scripted provider; the run it settles. */
async function settle(behavior: FakeBehavior) {
  const runtime = fakeRuntime(behavior);
  const result = await runOneJob(db, {
    workerId: WORKER,
    registry: runtime.registry,
  });
  expect(result.outcome).toBe("succeeded");
  expect(runtime.provider.calls).toHaveLength(1);
  return runtime.provider.calls[0];
}

/** Every value the database holds for this tenant that no output may carry. */
async function forbiddenValues(): Promise<Map<string, string>> {
  const forbidden = new Map<string, string>();
  const collect = async (
    label: string,
    sql: string,
    extra: readonly unknown[] = [],
  ) => {
    const { rows } = await admin.query<{ value: string | null }>(sql, [
      TENANT_A,
      ...extra,
    ]);
    rows.forEach((row, i) => {
      if (row.value) forbidden.set(`${label} #${i + 1}`, row.value);
    });
  };
  const union = (table: string, columns: string[]) =>
    columns
      .map(
        (c) =>
          `select ${c}::text as value from ops.${table} where tenant_id = $1`,
      )
      .join(" union all ");
  await collect(
    "a run's stored value",
    union("agent_runs", [
      "input_fingerprint",
      "provider_request_id",
      "provider_response_id",
      "correlation_id",
      "idempotency_key",
      "request_fingerprint",
      "requested_by",
      "result->>'response_draft'",
    ]),
  );
  await collect(
    "a task's stored value",
    union("tasks", [
      "title",
      "description",
      "idempotency_key",
      "request_fingerprint",
    ]),
  );
  await collect(
    "an agent's role or description",
    union("agents", ["role", "description"]),
  );
  await collect(
    "a job's stored value",
    union("jobs", ["lease_owner", "last_error", "idempotency_key"]),
  );
  await collect(
    "an admission's stored value",
    union("inbound_messages", [
      "contact_ref",
      "external_message_id",
      "body_fingerprint",
    ]),
  );
  // A stored source outside the contract's provenance allowlist
  // (EVENT_SOURCES, which ops.cos_event_source equals) never leaves.
  await collect(
    "an event's stored value",
    `${union("events", ["correlation_id", "idempotency_key", "request_fingerprint"])}
     union all
     select source as value from ops.events
      where tenant_id = $1 and source <> all ($2::text[])`,
    [EVENT_SOURCES],
  );
  await collect(
    "a review's reviewer label",
    union("review_items", ["reviewer"]),
  );
  return forbidden;
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysOf(inner),
  ]);
}

describe("the read gates over runs the real worker produced", () => {
  it("return no result, draft, prompt, fingerprint, provider id, lease owner or job error, and the advice only through its own read", async () => {
    // A synthetic lead, triaged by the real runtime: a stored result with a
    // reply draft, a review derived from it, decided under a legacy label.
    const clinic = await buildClinic();
    const admitted = await admitLead(clinic);
    // The admission fact again, as a writer outside the allowlist would store it.
    const {
      rows: [unlisted],
    } = await admin.query<{ id: string }>(
      `select ops.record_event($1, $2, 'communication.received', $3, 'task', $4, '{}'::jsonb) as id`,
      [TENANT_A, clinic.companyId, UNLISTED_SOURCE, admitted.taskId],
    );
    const triageCall = await settle({ type: "respond", content: ADVICE });
    const [pending] = await owner.withTransaction((tx) =>
      listReviewItems(tx, { tenantId: TENANT_A }),
    );
    expect(pending).toMatchObject({
      taskId: admitted.taskId,
      status: "pending",
    });
    await owner.withTransaction((tx) =>
      recordReviewDecision(
        tx,
        { tenantId: TENANT_A, source: "operator-cli" },
        {
          reviewId: pending.id,
          decision: "accepted",
          reviewer: REVIEWER,
          note: NOTE,
        },
      ),
    );

    // An office agent with a failed, an indeterminate and a working run.
    const office = await probes.buildOfficeTask(TENANT_A);
    const failedRun = await probes.requestRun(office, "dbtest-cos-idem-failed");
    await settle({
      type: "fail",
      category: "invalid_request",
      code: "dbtest_failure",
    });
    const indeterminateRun = await probes.requestRun(
      office,
      "dbtest-cos-idem-indeterminate",
    );
    await settle({ type: "fail", category: "provider_5xx" });
    const workingRun = await probes.requestRun(
      office,
      "dbtest-cos-idem-working",
    );
    const workingJob = (await probes.readRun(workingRun)).job_id as string;
    expect(await sessions.leaseHead(LEASE_OWNER)).toBe(workingJob);
    expect(await sessions.prepare(LEASE_OWNER, workingJob)).toBe("running");
    // No agent run fails its job, so the job error is planted as the owner.
    const failedJob = (await probes.readRun(failedRun)).job_id as string;
    await admin.query("update ops.jobs set last_error = $1 where id = $2", [
      JOB_ERROR,
      failedJob,
    ]);

    // Positive controls: every sentinel is really stored where it is secret.
    const { rows: stored } = await admin.query<{
      draft: string;
      lease_owner: string;
      last_error: string;
      reviewer: string;
      body: string;
    }>(
      `select (select result->>'response_draft' from ops.agent_runs where id = $1) as draft,
              (select lease_owner from ops.jobs where id = $2) as lease_owner,
              (select last_error from ops.jobs where id = $3) as last_error,
              (select reviewer from ops.review_items where id = $4) as reviewer,
              (select description from ops.tasks where id = $5) as body`,
      [admitted.agentRunId, workingJob, failedJob, pending.id, admitted.taskId],
    );
    expect(stored[0]).toEqual({
      draft: ADVICE.response_draft,
      lease_owner: LEASE_OWNER,
      last_error: JOB_ERROR,
      reviewer: REVIEWER,
      body: SYNTHETIC_BODY,
    });
    const forbidden = await forbiddenValues();
    for (const [label, value] of [
      [
        "the triage prompt's instructions",
        triageCall.instructions.slice(0, 64),
      ],
      ["the triage prompt's input", triageCall.input],
      ["the body sentinel", BODY],
      ["the draft sentinel", DRAFT],
      ["the agent description sentinel", DESCRIPTION],
      ["the task sentinel", TASK_SENTINEL],
      ["the agent sentinel", AGENT_SENTINEL],
    ] as const) {
      forbidden.set(label, value);
    }
    expect(forbidden.size).toBeGreaterThan(20);

    const runs = [admitted.agentRunId, failedRun, indeterminateRun, workingRun];
    const outputs = await readAsMember(owner, TENANT_A, async (member) => {
      const all: ApiOutput<unknown>[] = [];
      const read = async (
        fn: CompanyOsRead,
        args?: Record<string, unknown>,
      ) => {
        const output = await member.read(fn, args);
        all.push(output);
        return output;
      };
      for (const fn of [
        "operator_context",
        "overview",
        "list_agents",
        "list_tasks",
        "list_runs",
        "list_events",
        "spend_summary",
        "communication_status",
      ] as const) {
        await read(fn);
      }
      await read("list_runs", { p_attention_only: true });
      await read("list_stops", { p_include_cleared: true });
      for (const status of ["pending", "accepted", "rejected", "needs_edit"]) {
        await read("list_reviews", { p_status: status });
      }
      await read("get_review", { p_review_id: pending.id });
      await read("get_review_advice", { p_review_id: pending.id });
      for (const agentId of [clinic.agentId, office.agentId]) {
        await read("get_agent", { p_agent_id: agentId });
        await read("list_tasks", { p_agent_id: agentId });
        await read("list_runs", { p_agent_id: agentId });
      }
      for (const taskId of [admitted.taskId, office.taskId]) {
        await read("get_task", { p_task_id: taskId });
        await read("list_events", {
          p_subject_type: "task",
          p_subject_id: taskId,
        });
      }
      for (const runId of runs) {
        await read("get_run", { p_run_id: runId });
        await read("list_events", {
          p_subject_type: "agent_run",
          p_subject_id: runId,
        });
      }
      return all;
    });
    const value = <T>(fn: CompanyOsRead, index = 0): T =>
      outputs.filter((o) => o.fn === fn)[index].value as T;

    // Nothing secret leaves, by value or by key.
    expect(leaks(outputs, forbidden)).toEqual([]);
    const keys = new Set(outputs.flatMap((o) => keysOf(o.value)));
    expect(FORBIDDEN_KEYS.filter((key) => keys.has(key))).toEqual([]);
    // The unlisted label is among what is swept for, and its event is listed
    // with the fixed provenance "other".
    expect([...forbidden.values()]).toContain(UNLISTED_SOURCE);
    const listed = outputs
      .filter((o) => o.fn === "list_events")
      .flatMap(
        (o) => (o.value as { items: { id: string; source: string }[] }).items,
      )
      .filter((event) => event.id === unlisted.id);
    expect(listed.length).toBeGreaterThan(0);
    expect(new Set(listed.map((event) => event.source))).toEqual(
      new Set([OTHER_EVENT_SOURCE]),
    );

    // The advice leaves only through its own read, without the draft, and the
    // decision note only through the review's detail.
    for (const sentinel of [SUMMARY, NEXT_ACTION]) {
      expect(
        outputs.filter((o) => o.text.includes(sentinel)).map((o) => o.fn),
      ).toEqual(["get_review_advice"]);
    }
    expect(value("get_review_advice")).toEqual({
      v: 1,
      asOf: expect.any(String),
      reviewId: pending.id,
      capability: "lead_triage",
      outcome: ADVICE.outcome,
      intent: ADVICE.intent,
      priority: ADVICE.priority,
      needsHumanReview: true,
      flags: [],
      summary: ADVICE.summary,
      recommendedNextAction: ADVICE.recommended_next_action,
    });
    expect(
      outputs.filter((o) => o.text.includes(NOTE)).map((o) => o.fn),
    ).toEqual(["get_review"]);
    expect(value("get_review")).toMatchObject({
      status: "accepted",
      hasNote: true,
      decisionNote: NOTE,
      allowedDecisions: [],
    });

    // Every run keeps what it may show: status, error class and attention.
    const run = (runId: string) =>
      outputs.find(
        (o) => o.fn === "get_run" && (o.value as { id: string }).id === runId,
      )?.value;
    expect(run(admitted.agentRunId)).toMatchObject({
      status: "succeeded",
      capability: "lead_triage",
      attention: null,
    });
    expect(run(failedRun)).toMatchObject({
      status: "failed",
      errorCategory: "invalid_request",
      errorCode: "dbtest_failure",
      attention: null,
    });
    expect(run(indeterminateRun)).toMatchObject({
      status: "indeterminate",
      errorCategory: "provider_5xx",
      attention: "indeterminate_not_retried",
    });
    expect(run(workingRun)).toMatchObject({
      status: "running",
      attention: null,
      job: { status: "leased", leaseLive: true },
    });
    for (const runId of runs) {
      const steps = (run(runId) as { jobSteps: Record<string, unknown>[] })
        .jobSteps;
      for (const step of steps) {
        expect(Object.keys(step).sort()).toEqual(["at", "attempt", "step"]);
      }
    }
    const agents = value<AgentList>("list_agents");
    expect(agentIn(agents, office.agentId)).toMatchObject({
      activity: "working",
      attentionCount: 1,
      evidence: {
        workingRunIds: [workingRun],
        attentionRunIds: [indeterminateRun],
      },
    });
    expect(agentIn(agents, clinic.agentId)).toMatchObject({ activity: "idle" });
    expect(await evidenceFaults(admin, TENANT_A, agents.items)).toEqual([]);
  }, 60_000);
});
