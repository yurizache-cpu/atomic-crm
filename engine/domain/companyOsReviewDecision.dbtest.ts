// The browser review decision under concurrency (S7.1; docs/PHASE_2C_BRIEF.md
// §9 row 16), over the real `pg` driver on two connections.
//
// company_os_api.decide_review reaches ops.decide_review_as_member through its
// identity gate, and the callee records the decision through
// ops.record_review_decision, which locks the review row (FOR UPDATE) and
// keeps a decision final. These cases call the callee directly, as the gate
// does once the member is resolved (the identity cases are
// supabase/tests/company_os_api.sql, section I and V, and the live probe),
// so two committed transactions can race on one committed review:
//
//   - two different decisions: exactly one is recorded, the other waits on the
//     row lock and is then refused with OS409;
//   - the same principal repeating the same decision: recorded once, the
//     second answered as already recorded;
//   - either way, one lead_triage.reviewed event, and nothing sent: no
//     outbound row and no job.
//
// All data is synthetic.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import {
  ADMIN_URL,
  TENANT_A,
  adminPool,
  assertTargetDatabase,
  cleanupFixtures,
  resetFixtures,
} from "../worker/testSupport/dbFixture.ts";

const SOURCE = "dbtest-review-decision";
const PRINCIPAL_A = "principal:00000000-0000-4000-8000-0000000000a1";
const PRINCIPAL_B = "principal:00000000-0000-4000-8000-0000000000b2";

let admin: Pool;
/** The two racing connections: apart from admin, which watches and reads. */
let racers: Pool;

beforeAll(async () => {
  admin = adminPool();
  racers = new Pool({
    connectionString: ADMIN_URL,
    max: 2,
    statement_timeout: 15_000,
  });
  await assertTargetDatabase(admin);
});

afterAll(async () => {
  await racers?.end();
  await cleanupFixtures(admin);
  await admin?.end();
});

beforeEach(async () => {
  await resetFixtures(admin);
});

/** One pending lead_triage review on a synthetic admission, committed. */
async function openReview(): Promise<string> {
  const one = async (sql: string, params: unknown[]) =>
    (await admin.query<{ v: string }>(sql, params)).rows[0].v;
  const company = await one(
    "select ops.create_company($1, 'dbtest-decision-clinic', 'Clinic', $2) as v",
    [TENANT_A, SOURCE],
  );
  const department = await one(
    "select ops.create_department($1, $2, 'intake', 'Intake', $3) as v",
    [TENANT_A, company, SOURCE],
  );
  const agent = await one(
    `select ops.create_agent($1, $2, $3, 'lead-triage', 'Lead Triage',
                             'Intake assistant', $4, 'Triages new enquiries.') as v`,
    [TENANT_A, company, department, SOURCE],
  );
  const task = await one(
    `select (ops.admit_inbound_message($1, $2, $3, 'synthetic', 'dbtest-decision-0001',
                                      'synthetic:dbtest-decision-lead', 'Synthetic question',
                                      $4, false, now()) ->> 'task_id') as v`,
    [TENANT_A, company, agent, SOURCE],
  );
  return one(
    `insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
     values ($1, $2, $3, gen_random_uuid(), 'lead_triage', '{}'::jsonb, false)
     returning id::text as v`,
    [TENANT_A, company, task],
  );
}

const DECIDE =
  "select ops.decide_review_as_member($1, $2, $3, $4)::text as body";

/** The backend process of `client`, to watch it in pg_stat_activity. */
async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
    .rows[0].pid;
}

/** Resolves once backend `pid` is waiting on a lock. */
async function untilBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await admin.query<{ waiting: boolean }>(
      "select coalesce(wait_event_type = 'Lock', false) as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second decision never waited on the review's row lock");
}

/** The review's state, its decision events, and anything sent for it. */
async function outcome(reviewId: string) {
  const { rows } = await admin.query<{
    status: string;
    reviewer: string | null;
    events: number;
    outbound: number;
    jobs: number;
  }>(
    `select r.status, r.reviewer,
            (select count(*)::int from ops.events e
              where e.type = 'lead_triage.reviewed' and e.payload ->> 'review_item_id' = r.id::text) as events,
            (select count(*)::int from ops.outbound_messages o where o.review_item_id = r.id) as outbound,
            (select count(*)::int from ops.jobs j where j.tenant_id = r.tenant_id) as jobs
       from ops.review_items r where r.id = $1`,
    [reviewId],
  );
  return rows[0];
}

/**
 * Starts `first` and `second` on two connections: the first holds the row
 * lock uncommitted, the second is proven blocked on it, then the first
 * commits. Resolves to the second's answer or its SQLSTATE.
 */
async function race(
  reviewId: string,
  first: { actor: string; decision: string },
  second: { actor: string; decision: string },
): Promise<{ body?: Record<string, unknown>; code?: string }> {
  const c1 = await racers.connect();
  const c2 = await racers.connect();
  try {
    const jobsBefore = (await outcome(reviewId)).jobs;
    await c1.query("begin");
    const recorded = JSON.parse(
      (
        await c1.query<{ body: string }>(DECIDE, [
          TENANT_A,
          first.actor,
          reviewId,
          first.decision,
        ])
      ).rows[0].body,
    );
    expect(recorded).toMatchObject({ status: first.decision, recorded: true });

    const pid2 = await backendPid(c2);
    await c2.query("begin");
    type Answer = { body?: Record<string, unknown>; code?: string };
    const pending: Promise<Answer> = c2
      .query<{
        body: string;
      }>(DECIDE, [TENANT_A, second.actor, reviewId, second.decision])
      .then(
        (result): Answer => ({ body: JSON.parse(result.rows[0].body) }),
        (error: { code?: string }): Answer => ({ code: error.code }),
      );
    await untilBlocked(pid2);
    await c1.query("commit");
    const answer = await pending;
    await c2.query(answer.code ? "rollback" : "commit");
    expect((await outcome(reviewId)).jobs).toBe(jobsBefore);
    return answer;
  } finally {
    await c1.query("rollback").catch(() => undefined);
    await c2.query("rollback").catch(() => undefined);
    c1.release();
    c2.release();
  }
}

describe("a review decision under concurrency", () => {
  it("records exactly one of two different concurrent decisions and refuses the other with OS409", async () => {
    const reviewId = await openReview();

    const loser = await race(
      reviewId,
      { actor: PRINCIPAL_A, decision: "accepted" },
      { actor: PRINCIPAL_B, decision: "rejected" },
    );

    expect(loser).toEqual({ code: "OS409" });
    expect(await outcome(reviewId)).toMatchObject({
      status: "accepted",
      reviewer: PRINCIPAL_A,
      events: 1,
      outbound: 0,
    });
  });

  it("records the same principal's concurrent same decision once, answering the second as already recorded", async () => {
    const reviewId = await openReview();

    const second = await race(
      reviewId,
      { actor: PRINCIPAL_A, decision: "needs_edit" },
      { actor: PRINCIPAL_A, decision: "needs_edit" },
    );

    expect(second.body).toMatchObject({
      reviewItemId: reviewId,
      status: "needs_edit",
      recorded: false,
    });
    expect(await outcome(reviewId)).toMatchObject({
      status: "needs_edit",
      reviewer: PRINCIPAL_A,
      events: 1,
      outbound: 0,
    });
  });

  it("refuses the same decision by another principal once one is final", async () => {
    const reviewId = await openReview();

    const loser = await race(
      reviewId,
      { actor: PRINCIPAL_A, decision: "rejected" },
      { actor: PRINCIPAL_B, decision: "rejected" },
    );

    expect(loser).toEqual({ code: "OS409" });
    expect(await outcome(reviewId)).toMatchObject({
      status: "rejected",
      reviewer: PRINCIPAL_A,
      events: 1,
    });
  });
});
