// Phase 2D.2: decision quality, over the real `pg` driver and the real worker
// runtime.
//
//   * the database and the worker agree on the closed reason vocabulary, the
//     current policy version and the vector version it accepts;
//   * the owner's recovery repairs a request whose job ended without starting
//     it, and the provider is then asked exactly once; a settled evaluation is
//     reported complete and never asked again;
//   * a started evaluation (here: indeterminate) is never re-asked;
//   * two concurrent recoveries record one evaluation and one job, and two
//     concurrent repairs attach exactly one new job;
//   * recovery decides no review, sends nothing and writes no CRM row.
//
// All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import type {
  DecisionPort,
  DecisionRequest,
} from "../decision/decisionPort.ts";
import {
  DECISION_VECTOR_VERSION,
  DecisionVectorSchema,
  LEAD_TRIAGE_REASON_CODES,
  REASON_VOCABULARY_VERSION,
} from "../decision/decisionVector.ts";
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
import { createAgent, createCompany, createDepartment } from "./companyOs.ts";
import { recoverShadowDecision } from "./decisionRecovery.ts";
import { admitInboundMessage } from "./leadIntake.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  openAgentRuntimeDatabases,
  registryServing,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-decision-quality";
const LEAD = "synthetic:lead-decision-quality@example.test";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: "A first-session enquiry.",
  intent: "information",
  priority: "normal",
  recommended_next_action: "Offer two times.",
  response_draft: "Oi! A primeira consulta dura 50 minutos.",
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

const { runAgentJob } = agentRuntimeProbes(() => ({ admin, owner, db }));

/** A DecisionPort that counts what it was asked, answering with `port`. */
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

const runtime = (decisionPort?: DecisionPort) =>
  registryServing(
    createFakeModelProvider({ type: "respond", content: ADVICE }),
    { decisionPort, requestsShadowDecisions: decisionPort !== undefined },
  );

/** A synthetic lead admitted and its run executed: its review is open. */
async function openReview(decisionPort?: DecisionPort): Promise<string> {
  const clinic = await owner.withTransaction(async (tx) => {
    const ctx = { tenantId: TENANT_A, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-quality",
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
    return { tenantId: TENANT_A, companyId, agentId };
  });
  const admitted = await owner.withTransaction((tx) =>
    admitInboundMessage(
      tx,
      clinic,
      createSyntheticCommunicationPort({
        COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
      }).receive({
        external_message_id: "dbtest-quality-1",
        contact_ref: LEAD,
        body: "A synthetic question about a first session.",
        received_at: "2026-09-24T12:00:00Z",
      }),
      createSyntheticContactPolicy({ eligible: [LEAD] }),
      SOURCE,
    ),
  );
  expect((await runAgentJob(runtime(decisionPort))).outcome).toBe("succeeded");
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
  policy_version: string;
  trigger_source: string;
}

const evaluationsOf = async (reviewId: string): Promise<EvaluationRow[]> =>
  (
    await admin.query<EvaluationRow>(
      "select id, status, job_id, policy_version, trigger_source from ops.decision_evaluations where review_item_id = $1",
      [reviewId],
    )
  ).rows;

const shadowJobs = async (): Promise<number> =>
  (
    await admin.query<{ n: number }>(
      "select count(*)::int as n from ops.jobs where tenant_id = $1 and kind = 'decision.shadow_evaluate'",
      [TENANT_A],
    )
  ).rows[0].n;

const recover = (reviewId: string) =>
  owner.withTransaction((tx) =>
    recoverShadowDecision(tx, { tenantId: TENANT_A, reviewId }),
  );

/** What recovery must never touch. */
const untouched = async () =>
  (
    await admin.query<{ state: unknown }>(
      `select jsonb_build_object(
         'reviews', (select jsonb_agg(jsonb_build_array(r.id, r.status, r.reviewer) order by r.id)
                       from ops.review_items r where r.tenant_id = $1),
         'outbound', (select count(*) from ops.outbound_messages o where o.tenant_id = $1),
         'events', (select count(*) from ops.events e where e.tenant_id = $1),
         'stops', (select count(*) from ops.execution_stops s where s.tenant_id = $1),
         'contacts', (select count(*) from public.contacts)) as state`,
      [TENANT_A],
    )
  ).rows[0].state;

/** A job that ended without ever starting its evaluation. */
const endJobUnstarted = (jobId: string) =>
  admin.query(
    "update ops.jobs set status = 'failed', last_error_class = 'permanent', updated_at = now() where id = $1",
    [jobId],
  );

describe("the decision contract, in the database and the worker", () => {
  it("agrees on the reason vocabulary, the current policy and its vector version", async () => {
    const { rows } = await admin.query<{
      codes: string[];
      vector_version: string;
      reason_vocabulary: string;
    }>(
      `select ops.lead_triage_reason_codes_v1() as codes, p.vector_version, p.reason_vocabulary
         from ops.decision_policies p where p.version = ops.current_shadow_policy_version()`,
    );

    expect(rows[0]).toEqual({
      codes: [...LEAD_TRIAGE_REASON_CODES],
      vector_version: DECISION_VECTOR_VERSION,
      reason_vocabulary: REASON_VOCABULARY_VERSION,
    });
  });

  it("accepts and refuses the same vectors on both sides", async () => {
    const vector = (reasonCodes: string[]) => ({
      version: DECISION_VECTOR_VERSION,
      mode: "shadow",
      recommendation: "accept",
      confidence: 0.82,
      caution: "low",
      reasonCodes,
      provider: FAKE_DECISION_PROVIDER,
      inputFingerprint: `sha256:${"a".repeat(64)}`,
      evaluatedAt: "2026-09-24T12:00:00.000Z",
    });
    const cases = [
      ...LEAD_TRIAGE_REASON_CODES.map((code) => vector([code])),
      vector(["maria_silva_anxiety"]),
      vector(["flag_spam", "legacy_reason"]),
      { ...vector(["triage_complete"]), version: null },
      {
        ...vector(["triage_complete"]),
        provider: { ...FAKE_DECISION_PROVIDER, kind: null },
      },
    ];

    for (const candidate of cases) {
      const { rows } = await admin.query<{ valid: boolean }>(
        "select ops.decision_vector_valid($1::jsonb) as valid",
        [JSON.stringify(candidate)],
      );
      expect(rows[0].valid).toBe(
        DecisionVectorSchema.safeParse(candidate).success,
      );
    }
  });
});

describe("the owner's recovery", () => {
  it("repairs a request whose job ended unstarted, and the provider is asked exactly once", async () => {
    const decisions = fakeDecisions();
    const reviewId = await openReview(decisions);
    const [requested] = await evaluationsOf(reviewId);
    expect(requested).toMatchObject({
      status: "pending",
      policy_version: "decision_shadow.v2",
    });
    await endJobUnstarted(requested.job_id as string);
    const before = await untouched();

    expect(await recover(reviewId)).toEqual({
      outcome: "repaired",
      evaluationId: requested.id,
    });
    expect((await recover(reviewId)).outcome).toBe("in_progress");
    expect(await shadowJobs()).toBe(2);
    expect(decisions.calls).toHaveLength(0);

    expect((await runAgentJob(runtime(decisions))).outcome).toBe("succeeded");
    expect(decisions.calls).toHaveLength(1);
    expect((await evaluationsOf(reviewId))[0].status).toBe("completed");

    // Settled: reported complete, never asked again.
    expect((await recover(reviewId)).outcome).toBe("already_complete");
    expect(await runAgentJob(runtime(decisions))).toEqual({ outcome: "idle" });
    expect(decisions.calls).toHaveLength(1);
    expect(await shadowJobs()).toBe(2);
    expect(await untouched()).toEqual(before);
  });

  it("never asks again about an evaluation that was started", async () => {
    const exploding = counting({
      identity: FAKE_DECISION_PROVIDER,
      async evaluate() {
        throw new Error("the connection dropped after the request was sent");
      },
    });
    const reviewId = await openReview(exploding);
    expect((await runAgentJob(runtime(exploding))).outcome).toBe("succeeded");
    expect((await evaluationsOf(reviewId))[0].status).toBe("indeterminate");
    const jobs = await shadowJobs();

    expect((await recover(reviewId)).outcome).toBe(
      "indeterminate_requires_human_operator",
    );
    expect(await shadowJobs()).toBe(jobs);
    expect(await runAgentJob(runtime(exploding))).toEqual({ outcome: "idle" });
    expect(exploding.calls).toHaveLength(1);
    expect((await evaluationsOf(reviewId))[0].status).toBe("indeterminate");
  });
});

describe("the owner's recovery under concurrency", () => {
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
    throw new Error("the second recovery never waited on the first");
  };

  /** Two recoveries of one review, the second started while the first is open. */
  async function race(reviewId: string): Promise<[string, string]> {
    const sql =
      "select ops.recover_shadow_decision($1, $2) ->> 'outcome' as outcome";
    const c1 = await racers.connect();
    const c2 = await racers.connect();
    try {
      await c1.query("begin");
      const first = (
        await c1.query<{ outcome: string }>(sql, [TENANT_A, reviewId])
      ).rows[0].outcome;
      const pid2 = await backendPid(c2);
      await c2.query("begin");
      const pending = c2.query<{ outcome: string }>(sql, [TENANT_A, reviewId]);
      await untilBlocked(pid2);
      await c1.query("commit");
      const second = (await pending).rows[0].outcome;
      await c2.query("commit");
      return [first, second];
    } finally {
      await c1.query("rollback").catch(() => undefined);
      await c2.query("rollback").catch(() => undefined);
      c1.release();
      c2.release();
    }
  }

  it("two concurrent recoveries of an unrequested review record one evaluation and one job", async () => {
    const reviewId = await openReview(undefined);
    expect(await evaluationsOf(reviewId)).toEqual([]);

    const outcomes = await race(reviewId);

    expect(outcomes).toEqual(["created", "created"]);
    const evaluations = await evaluationsOf(reviewId);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].trigger_source).toBe("operator.recover");
    expect(await shadowJobs()).toBe(1);
  });

  it("two concurrent repairs attach exactly one new job", async () => {
    const reviewId = await openReview(fakeDecisions());
    const [requested] = await evaluationsOf(reviewId);
    await endJobUnstarted(requested.job_id as string);

    const outcomes = await race(reviewId);

    expect(outcomes).toEqual(["repaired", "in_progress"]);
    expect(await shadowJobs()).toBe(2);
    const [repaired] = await evaluationsOf(reviewId);
    expect(repaired.status).toBe("pending");
    expect(repaired.job_id).not.toBe(requested.job_id);
  });
});
