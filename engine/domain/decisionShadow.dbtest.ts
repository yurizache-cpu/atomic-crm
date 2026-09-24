// The Phase 2D.1 shadow decision, end to end through the real worker runtime,
// over the real `pg` driver.
//
//   * a synthetic lead's review, once its run settles, requests ONE shadow
//     decision; the worker's next pass asks the DecisionPort the allowlisted
//     input and stores the vector with its deterministic policy; the review,
//     its decisions, the outbound state and the CRM are untouched, and the
//     owner still decides it;
//   * a worker without a provider requests nothing;
//   * a review outside the synthetic and test scope (BASELINE Q8) is never
//     evaluated, and the provider is never asked;
//   * a stop covering the agent holds the decision job and the provider is not
//     asked until it is cleared;
//   * an ambiguous provider failure is indeterminate and never asked again; a
//     malformed answer is stored invalid;
//   * concurrent requests and a repeated step record one evaluation and one job.
//
// All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import type { InboundMessage } from "../communication/types.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import type {
  DecisionPort,
  DecisionRequest,
} from "../decision/decisionPort.ts";
import {
  FAKE_DECISION_PROVIDER,
  createFakeDecisionProvider,
} from "../decision/fakeDecisionProvider.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import type { LeadTriage } from "../models/leadTriage.ts";
import {
  ADMIN_URL,
  TENANT_A,
  resetFixtures,
} from "../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "./agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "./companyOs.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import { admitInboundMessage } from "./leadIntake.ts";
import { recordReviewDecision } from "./reviewQueue.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
  registryServing,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-decision-shadow";
const SYNTHETIC_BODY =
  "Oi, sou a Maria Silva (+55 11 99999-0000), tenho ansiedade e queria entender a primeira consulta.";
const LEAD = "synthetic:lead-decision-shadow@example.test";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: "DRAFT-SENTINEL-SUMMARY a first-session enquiry.",
  intent: "information",
  priority: "normal",
  recommended_next_action: "DRAFT-SENTINEL-NEXT offer two times.",
  response_draft:
    "DRAFT-SENTINEL-REPLY Oi! A primeira consulta dura 50 minutos.",
  needs_human_review: true,
  flags: Object.freeze([]),
}) as LeadTriage;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
/** Two racing owner connections, apart from admin. */
let racers: Pool;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
  racers = new Pool({
    connectionString: ADMIN_URL,
    max: 2,
    statement_timeout: 15_000,
  });
}, 60_000);

afterAll(async () => {
  await racers?.end();
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

beforeEach(async () => {
  await resetFixtures(admin);
});

const { countJobs, runAgentJob } = agentRuntimeProbes(() => ({
  admin,
  owner,
  db,
}));

/** The DecisionPort, counting what it was asked. */
function counting(
  port: DecisionPort,
): DecisionPort & { calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  return {
    identity: port.identity,
    calls,
    async evaluate(request, options) {
      calls.push(request);
      return port.evaluate(request, options);
    },
  };
}

const fakeDecisions = () =>
  counting(
    createFakeDecisionProvider({
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    }),
  );

/** The production registry: the lead triage answered by a fake model, and `decisionPort`. */
const runtime = (decisionPort?: DecisionPort, requestsShadowDecisions = true) =>
  registryServing(
    createFakeModelProvider({ type: "respond", content: ADVICE }),
    {
      decisionPort,
      requestsShadowDecisions:
        decisionPort !== undefined && requestsShadowDecisions,
    },
  );

interface Clinic {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
}

const buildClinic = (): Promise<Clinic> =>
  owner.withTransaction(async (tx) => {
    const ctx = { tenantId: TENANT_A, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-shadow",
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
    return { tenantId: TENANT_A, companyId, departmentId, agentId };
  });

const inbound = (n = 1): InboundMessage =>
  createSyntheticCommunicationPort({
    COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
  }).receive({
    external_message_id: `dbtest-shadow-${n}`,
    contact_ref: LEAD,
    body: SYNTHETIC_BODY,
    received_at: "2026-09-24T12:00:00Z",
  });

/** A synthetic lead admitted and its run executed: its review is open. */
async function openReview(clinic: Clinic, decisionPort?: DecisionPort, n = 1) {
  const admitted = await owner.withTransaction((tx) =>
    admitInboundMessage(
      tx,
      {
        tenantId: clinic.tenantId,
        companyId: clinic.companyId,
        agentId: clinic.agentId,
      },
      inbound(n),
      createSyntheticContactPolicy({ eligible: [LEAD] }),
      SOURCE,
    ),
  );
  const result = await runAgentJob(runtime(decisionPort));
  expect(result.outcome).toBe("succeeded");
  const { rows } = await admin.query<{ id: string }>(
    "select id from ops.review_items where agent_run_id = $1",
    [admitted.agentRunId],
  );
  return rows[0].id;
}

interface EvaluationRow {
  id: string;
  status: string;
  job_id: string | null;
  vector: Record<string, unknown> | null;
  policy_outcome: string | null;
  human_review_required: boolean;
  error_code: string | null;
  refusal_code: string | null;
}

const evaluationsOf = async (reviewId: string): Promise<EvaluationRow[]> =>
  (
    await admin.query<EvaluationRow>(
      "select * from ops.decision_evaluations where review_item_id = $1",
      [reviewId],
    )
  ).rows;

/** The review and everything a shadow decision must never touch. */
const untouched = async (tenantId: string) =>
  (
    await admin.query<{ state: unknown }>(
      `select jsonb_build_object(
         'reviews', (select jsonb_agg(jsonb_build_array(r.id, r.status, r.reviewer) order by r.id)
                       from ops.review_items r where r.tenant_id = $1),
         'outbound', (select count(*) from ops.outbound_messages o where o.tenant_id = $1),
         'events', (select count(*) from ops.events e where e.tenant_id = $1),
         'stops', (select count(*) from ops.execution_stops s where s.tenant_id = $1),
         'contacts', (select count(*) from public.contacts)) as state`,
      [tenantId],
    )
  ).rows[0].state;

describe("the shadow decision through the worker", () => {
  it("evaluates a synthetic review once, stores the vector and its policy, and leaves the review to the person", async () => {
    const clinic = await buildClinic();
    const decisions = fakeDecisions();
    const reviewId = await openReview(clinic, decisions);

    // The settlement's step requested exactly one evaluation, with one job.
    const [requested] = await evaluationsOf(reviewId);
    expect(requested).toMatchObject({
      status: "pending",
      human_review_required: true,
    });
    expect(requested.job_id).not.toBeNull();
    expect(decisions.calls).toHaveLength(0);
    const before = await untouched(clinic.tenantId);
    const { rows: allowedBefore } = await admin.query<{ allowed: unknown }>(
      "select ops.read_review_detail($1, $2) -> 'allowedDecisions' as allowed",
      [clinic.tenantId, reviewId],
    );

    // The worker's next pass asks the provider, once.
    const pass = await runAgentJob(runtime(decisions));
    expect(pass.outcome).toBe("succeeded");
    expect(decisions.calls).toHaveLength(1);

    // It was asked the allowlisted input only.
    const asked = JSON.stringify(decisions.calls[0]);
    for (const secret of [
      "Maria",
      "Silva",
      "99999",
      "ansiedade",
      "DRAFT-SENTINEL",
      LEAD,
      reviewId,
      clinic.tenantId,
    ]) {
      expect(asked).not.toContain(secret);
    }
    expect(decisions.calls[0].input).toEqual({
      version: "decision_input.v1",
      subject: "lead_triage.review",
      sourceClass: "synthetic",
      contactPolicy: "contactable",
      triage: {
        outcome: "triaged",
        intent: "information",
        priority: "normal",
        flags: [],
        needsHumanReview: true,
      },
    });

    const [stored] = await evaluationsOf(reviewId);
    expect(stored).toMatchObject({
      status: "completed",
      policy_outcome: "recommendation_available",
      human_review_required: true,
      vector: expect.objectContaining({
        recommendation: "accept",
        confidence: 0.82,
        provider: FAKE_DECISION_PROVIDER,
      }),
    });
    expect(await untouched(clinic.tenantId)).toEqual(before);
    const { rows: allowedAfter } = await admin.query<{ allowed: unknown }>(
      "select ops.read_review_detail($1, $2) -> 'allowedDecisions' as allowed",
      [clinic.tenantId, reviewId],
    );
    expect(allowedAfter).toEqual(allowedBefore);
    expect(await runAgentJob(runtime(decisions))).toEqual({ outcome: "idle" });

    // The owner still decides, independently, and the evaluation stays as it was.
    await owner.withTransaction((tx) =>
      recordReviewDecision(
        tx,
        { tenantId: clinic.tenantId, source: SOURCE },
        { reviewId, decision: "rejected", reviewer: "dbtest-owner" },
      ),
    );
    const { rows: review } = await admin.query<{ status: string }>(
      "select status from ops.review_items where id = $1",
      [reviewId],
    );
    expect(review[0].status).toBe("rejected");
    expect((await evaluationsOf(reviewId))[0]).toEqual(stored);
  });

  it("requests nothing from a worker with no decision provider", async () => {
    const clinic = await buildClinic();
    const reviewId = await openReview(clinic, undefined);

    expect(await evaluationsOf(reviewId)).toEqual([]);
    expect(await countJobs(clinic.tenantId)).toBe(1);
  });

  it("never evaluates a review outside the synthetic and test scope, and never asks the provider", async () => {
    const clinic = await buildClinic();
    const decisions = fakeDecisions();
    // A lead triage task no synthetic or test admission created: the stand-in
    // for a real-origin review while BASELINE Q8 is open.
    await owner.withTransaction(async (tx) => {
      const ctx = { tenantId: clinic.tenantId, source: SOURCE };
      const taskId = await createTask(tx, ctx, {
        companyId: clinic.companyId,
        type: "lead_triage",
        title: "Lead triage: real origin",
        description: SYNTHETIC_BODY,
      });
      await assignTask(tx, ctx, taskId, clinic.agentId);
      await requestAgentRun(tx, ctx, {
        taskId,
        agentId: clinic.agentId,
        capability: "lead_triage",
        idempotencyKey: "dbtest-real-origin",
      });
    });
    expect((await runAgentJob(runtime(decisions))).outcome).toBe("succeeded");

    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.decision_evaluations where tenant_id = $1",
      [clinic.tenantId],
    );
    expect(rows[0].n).toBe(0);
    expect(await runAgentJob(runtime(decisions))).toEqual({ outcome: "idle" });
    expect(decisions.calls).toHaveLength(0);
  });

  it("holds the decision job under a stop covering the agent, and asks the provider only after it is cleared", async () => {
    const clinic = await buildClinic();
    const decisions = fakeDecisions();
    const reviewId = await openReview(clinic, decisions);
    const stop = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        {
          scope: "agent",
          tenantId: clinic.tenantId,
          companyId: clinic.companyId,
          agentId: clinic.agentId,
        },
        { reason: "dbtest shadow hold", actor: "dbtest-owner" },
      ),
    );

    const held = await runAgentJob(runtime(decisions));
    expect(held.outcome === "idle" || held.outcome === "deferred").toBe(true);
    expect(decisions.calls).toHaveLength(0);
    expect((await evaluationsOf(reviewId))[0].status).toBe("pending");

    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, stop, {
        reason: "dbtest shadow release",
        actor: "dbtest-owner",
      }),
    );
    await admin.query(
      "update ops.jobs set available_at = now() where tenant_id = $1",
      [clinic.tenantId],
    );
    expect((await runAgentJob(runtime(decisions))).outcome).toBe("succeeded");
    expect(decisions.calls).toHaveLength(1);
    expect((await evaluationsOf(reviewId))[0].status).toBe("completed");
  });

  it("settles an ambiguous provider failure as indeterminate and never asks again", async () => {
    const clinic = await buildClinic();
    const failing = counting({
      identity: FAKE_DECISION_PROVIDER,
      evaluate: async () => {
        throw new Error("socket hang up");
      },
    });
    const reviewId = await openReview(clinic, failing);

    expect((await runAgentJob(runtime(failing))).outcome).toBe("succeeded");
    expect(await runAgentJob(runtime(failing))).toEqual({ outcome: "idle" });

    expect(failing.calls).toHaveLength(1);
    expect((await evaluationsOf(reviewId))[0]).toMatchObject({
      status: "indeterminate",
      policy_outcome: "provider_indeterminate",
      vector: null,
      human_review_required: true,
    });
  });

  it("stores a malformed provider answer as invalid, never as a recommendation", async () => {
    const clinic = await buildClinic();
    const malformed = counting({
      identity: FAKE_DECISION_PROVIDER,
      evaluate: async (request) => ({
        ...((await createFakeDecisionProvider().evaluate(request, {
          signal: new AbortController().signal,
        })) as object),
        recommendation: "approve_and_send",
      }),
    });
    const reviewId = await openReview(clinic, malformed);

    expect((await runAgentJob(runtime(malformed))).outcome).toBe("succeeded");

    expect((await evaluationsOf(reviewId))[0]).toMatchObject({
      status: "invalid",
      policy_outcome: "provider_invalid",
      vector: null,
      error_code: "vector_rejected",
    });
  });
});

describe("the shadow decision request under concurrency", () => {
  /** The backend process of `client`, to watch it in pg_stat_activity. */
  const backendPid = async (client: PoolClient) =>
    (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0].pid;

  const untilBlocked = async (pid: number) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await admin.query<{ waiting: boolean }>(
        "select coalesce(wait_event_type = 'Lock', false) as waiting from pg_stat_activity where pid = $1",
        [pid],
      );
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the second request never waited on the first");
  };

  it("two concurrent requests for one review record one evaluation and one job", async () => {
    const clinic = await buildClinic();
    const reviewId = await openReview(clinic, undefined);
    const request =
      "select ops.request_shadow_decision($1, $2, 'owner.request')::text as id";
    const c1 = await racers.connect();
    const c2 = await racers.connect();
    try {
      await c1.query("begin");
      const first = (
        await c1.query<{ id: string }>(request, [clinic.tenantId, reviewId])
      ).rows[0].id;
      const pid2 = await backendPid(c2);
      await c2.query("begin");
      const pending = c2.query<{ id: string }>(request, [
        clinic.tenantId,
        reviewId,
      ]);
      await untilBlocked(pid2);
      await c1.query("commit");
      const second = (await pending).rows[0].id;
      await c2.query("commit");
      expect(second).toBe(first);
    } finally {
      await c1.query("rollback").catch(() => undefined);
      await c2.query("rollback").catch(() => undefined);
      c1.release();
      c2.release();
    }

    expect(await evaluationsOf(reviewId)).toHaveLength(1);
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.jobs where tenant_id = $1 and kind = 'decision.shadow_evaluate'",
      [clinic.tenantId],
    );
    expect(rows[0].n).toBe(1);
  });

  it("a repeated post-settlement step resolves to the same evaluation", async () => {
    const clinic = await buildClinic();
    const reviewId = await openReview(clinic, fakeDecisions());
    const { rows: job } = await admin.query<{ job_id: string; worker: string }>(
      `select r.job_id, e.worker_id as worker from ops.review_items ri
         join ops.agent_runs r on r.id = ri.agent_run_id
         join ops.job_events e on e.job_id = r.job_id and e.event = 'succeeded'
        where ri.id = $1`,
      [reviewId],
    );
    const repeat = () =>
      db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        return (
          await tx.query<{ id: string }>(
            "select ops.request_shadow_decision_for_settled_job($1, $2)::text as id",
            [job[0].worker, job[0].job_id],
          )
        ).rows[0].id;
      });

    const [a, b] = [await repeat(), await repeat()];

    expect(a).toBe(b);
    expect(await evaluationsOf(reviewId)).toHaveLength(1);
  });
});
