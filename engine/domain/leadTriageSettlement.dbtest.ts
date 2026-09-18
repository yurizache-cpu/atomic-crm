// Phase 2A final review: a paid answer is durable whatever happens to its review.
//
// The provider's answer is settled (the run `succeeded`, its result stored, its
// job completed) in one transaction. Opening the human review of that answer is
// a SEPARATE transaction that runs only after the settlement committed, so no
// failure of it can reach the settlement: not an error, not a lock wait, not a
// statement timeout, not a cancellation.
//
// The last three are why this file exists. PL/pgSQL's `when others` does not
// catch QUERY_CANCELED (SQLSTATE 57014), which is what a statement timeout and
// pg_cancel_backend both raise, so a review opened INSIDE the settlement
// statement, even behind its own exception block, could still abort it: the run
// stayed `running`, its next lease settled it `indeterminate`, and the valid,
// already-paid answer was lost. Each case below was red on that design.
//
// Every case counts provider calls, because "the answer is kept" must never be
// bought with a second call.
//
// ALL DATA HERE IS SYNTHETIC (BASELINE Q8). The fictitious lead below is
// invented for this test; no real message, patient or clinical text is used.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import type { WorkerDatabase } from "../db/types.ts";
import { createSyntheticContactPolicy } from "../communication/syntheticContactPolicy.ts";
import { createSyntheticCommunicationPort } from "../communication/syntheticIngress.ts";
import type { LeadTriage } from "../models/leadTriage.ts";
import type { WorkerLogEvent, WorkerLogFields } from "../worker/log.ts";
import type { HandlerRegistry } from "../worker/handlerRegistry.ts";
import {
  resetFixtures,
  TENANT_A,
  WORKER_URL,
} from "../worker/testSupport/dbFixture.ts";
import { createAgent, createCompany, createDepartment } from "./companyOs.ts";
import { admitInboundMessage } from "./leadIntake.ts";
import { listReviewItems, openMissingReviews } from "./reviewQueue.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  fakeRuntime,
  openAgentRuntimeDatabases,
  WORKER,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-lead-triage-settlement";

/**
 * The worker's statement timeout in the lock-wait case: long enough for every
 * ordinary worker statement, short enough that a wait on the review queue's
 * lock ends in a timeout within the test.
 */
const SHORT_STATEMENT_TIMEOUT_MS = 2_000;

/** A fictitious enquiry. Invented for this test; not from any real person. */
const SYNTHETIC_BODY =
  "Oi, queria saber como funciona a primeira consulta e quais horarios voces tem.";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: "New enquiry asking how a first session works and when it can be.",
  intent: "book_appointment",
  priority: "normal",
  recommended_next_action:
    "Reply with how a first session works and two times.",
  response_draft:
    "Oi! A primeira consulta dura 50 minutos. Posso te oferecer dois horarios.",
  needs_human_review: true,
  flags: Object.freeze([]),
}) as LeadTriage;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
/** The worker's database with a short statement timeout, for the lock-wait case. */
let impatientDb: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
  impatientDb = createWorkerDatabase({
    connectionString: WORKER_URL,
    max: 2,
    statementTimeoutMs: SHORT_STATEMENT_TIMEOUT_MS,
  });
}, 60_000);

afterAll(async () => {
  await impatientDb.close();
  await closeAgentRuntimeDatabases({ admin, owner, db });
});

beforeEach(async () => {
  await resetFixtures(admin);
});

const probes = agentRuntimeProbes(() => ({ admin, owner, db }));
const impatient = agentRuntimeProbes(() => ({ admin, owner, db: impatientDb }));

const port = createSyntheticCommunicationPort({
  COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
});
const LEAD = "synthetic:lead-settlement";
const LEAD_ELIGIBLE = createSyntheticContactPolicy({ eligible: [LEAD] });

interface Admitted {
  readonly tenantId: string;
  readonly agentRunId: string;
}

/** One clinic, one triage agent, and one admitted synthetic message. */
const admitOne = async (): Promise<Admitted> => {
  const ctx = { tenantId: TENANT_A, source: SOURCE };
  const placement = await owner.withTransaction(async (tx) => {
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-settlement-clinic",
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
    return { tenantId: TENANT_A, companyId, agentId };
  });
  const inbound = port.receive({
    external_message_id: "dbtest-settlement-0001",
    contact_ref: LEAD,
    body: SYNTHETIC_BODY,
    received_at: "2026-09-18T12:00:00Z",
  });
  const admitted = await owner.withTransaction((tx) =>
    admitInboundMessage(tx, placement, inbound, LEAD_ELIGIBLE, SOURCE),
  );
  return { tenantId: TENANT_A, agentRunId: admitted.agentRunId };
};

interface LogLine {
  readonly event: WorkerLogEvent;
  readonly fields: WorkerLogFields | undefined;
}

const recordingLogger = (): {
  lines: LogLine[];
  log: (event: WorkerLogEvent, fields?: WorkerLogFields) => void;
} => {
  const lines: LogLine[] = [];
  return { lines, log: (event, fields) => lines.push({ event, fields }) };
};

const reviewCount = async (tenantId: string): Promise<number> =>
  (await owner.withTransaction((tx) => listReviewItems(tx, { tenantId })))
    .length;

const pendingFacts = async (tenantId: string): Promise<number> => {
  const { rows } = await admin.query<{ count: string }>(
    `select count(*)::text as count from ops.events
      where tenant_id = $1 and type = 'lead_triage.review_pending'`,
    [tenantId],
  );
  return Number(rows[0].count);
};

const jobStatus = async (jobId: string): Promise<string> => {
  const { rows } = await admin.query<{ status: string }>(
    "select status from ops.jobs where id = $1",
    [jobId],
  );
  return rows[0].status;
};

/** `npm run ops -- triage recover`, through the service the CLI calls. */
const recoverReviews = (tenantId: string): Promise<number> =>
  owner.withTransaction((tx) => openMissingReviews(tx, { tenantId }));

/**
 * What must hold after the review could not be opened: the paid answer is
 * settled and kept, its job is finished, nothing can call again, and recovery
 * opens the one missing review exactly once.
 */
const expectPaidAnswerKeptAndRecoveredOnce = async (
  admitted: Admitted,
  provider: { readonly calls: readonly unknown[] },
  registry: HandlerRegistry,
): Promise<void> => {
  expect(provider.calls).toHaveLength(1);

  const run = await probes.readRun(admitted.agentRunId);
  expect(run.status).toBe("succeeded");
  expect(run.result).toEqual(ADVICE);
  expect(run.job_id).not.toBeNull();
  expect(await jobStatus(String(run.job_id))).toBe("succeeded");

  // The review is absent: opening it failed, and that is all that failed.
  expect(await reviewCount(admitted.tenantId)).toBe(0);

  // Nothing is left for a worker to lease, so nothing can call again.
  expect((await probes.runAgentJob(registry)).outcome).toBe("idle");
  expect(provider.calls).toHaveLength(1);

  // Recovery derives the missing review from the stored answer, once.
  expect(await recoverReviews(admitted.tenantId)).toBe(1);
  expect(await recoverReviews(admitted.tenantId)).toBe(0);
  expect(await reviewCount(admitted.tenantId)).toBe(1);
  expect(await pendingFacts(admitted.tenantId)).toBe(1);
  expect(provider.calls).toHaveLength(1);
};

/** The step that failed, as the worker reported it: its name and SQLSTATE only. */
const expectReviewStepFailure = (lines: readonly LogLine[], code: string) => {
  const failures = lines.filter(
    (line) => line.event === "job.after_settlement_failed",
  );
  expect(failures).toHaveLength(1);
  expect(failures[0].fields?.detail).toBe(`openRunReview sqlstate=${code}`);
};

// ---------------------------------------------------------------------------
// 1. Cancelled while the review is opened: deterministic
// ---------------------------------------------------------------------------

/**
 * Every insert into the review queue is CANCELLED: SQLSTATE 57014, exactly what
 * a statement timeout or pg_cancel_backend raises, and the one class of error a
 * PL/pgSQL `when others` block lets through.
 */
const cancelReviewQueue = async (): Promise<void> => {
  await admin.query(`create or replace function ops.dbtest_cancel_review_queue()
    returns trigger language plpgsql as $$
    begin
      raise exception using errcode = 'query_canceled',
        message = 'dbtest: opening the review was cancelled';
    end $$`);
  await admin.query(`create trigger dbtest_cancel_review_queue
    before insert on ops.review_items
    for each row execute function ops.dbtest_cancel_review_queue()`);
};

const restoreReviewQueue = async (): Promise<void> => {
  await admin.query(
    "drop trigger if exists dbtest_cancel_review_queue on ops.review_items",
  );
  await admin.query("drop function if exists ops.dbtest_cancel_review_queue()");
};

describe("a paid answer whose review is cancelled while it opens", () => {
  afterAll(restoreReviewQueue);

  it("is kept, is never called for again, and its review is recovered once", async () => {
    const admitted = await admitOne();
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });
    const { lines, log } = recordingLogger();

    await cancelReviewQueue();
    let outcome: string;
    try {
      ({ outcome } = await probes.runAgentJob(registry, { log }));
    } finally {
      await restoreReviewQueue();
    }

    await expectPaidAnswerKeptAndRecoveredOnce(admitted, provider, registry);
    expect(outcome).toBe("succeeded");
    expectReviewStepFailure(lines, "57014");
  });
});

// ---------------------------------------------------------------------------
// 2. A real lock wait that ends in the worker's statement timeout
// ---------------------------------------------------------------------------

describe("a paid answer whose review waits on a lock until the statement times out", () => {
  it("is kept, is never called for again, and its review is recovered once", async () => {
    const admitted = await admitOne();
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });
    const { lines, log } = recordingLogger();

    // A second connection holds a lock that every insert into the review queue
    // must wait for, and holds it for longer than the worker's statement
    // timeout. Nothing else in the settlement needs it.
    const holder = await admin.connect();
    let outcome: string;
    try {
      await holder.query("begin");
      await holder.query("lock table ops.review_items in share mode");

      ({ outcome } = await impatient.runAgentJob(registry, { log }));
    } finally {
      await holder.query("rollback");
      holder.release();
    }

    await expectPaidAnswerKeptAndRecoveredOnce(admitted, provider, registry);
    expect(outcome).toBe("succeeded");
    expectReviewStepFailure(lines, "57014");
  });
});

// ---------------------------------------------------------------------------
// 3. The step is the completing worker's, and derives nothing it is handed
// ---------------------------------------------------------------------------

describe("opening the review of a settled job", () => {
  afterAll(restoreReviewQueue);

  it("is refused to any worker but the one that completed the job, and opens once", async () => {
    const admitted = await admitOne();
    const { provider, registry } = fakeRuntime({
      type: "respond",
      content: ADVICE,
    });

    await cancelReviewQueue();
    try {
      await probes.runAgentJob(registry);
    } finally {
      await restoreReviewQueue();
    }
    const { job_id: jobId } = await probes.readRun(admitted.agentRunId);
    expect(await reviewCount(admitted.tenantId)).toBe(0);

    const ask = (workerId: string, job: string) =>
      db.withTransaction(async (tx) => {
        await tx.query("set local role ops_worker");
        const { rows } = await tx.query<{ opened: string | null }>(
          "select ops.open_review_for_settled_job($1, $2) as opened",
          [workerId, job],
        );
        return rows[0]?.opened ?? null;
      });

    // Another worker is refused, and opens nothing.
    await expect(
      ask("dbtest-another-worker", String(jobId)),
    ).rejects.toMatchObject({ code: "OS403" });
    expect(await reviewCount(admitted.tenantId)).toBe(0);

    // A job that does not exist has nothing to open.
    expect(await ask(WORKER, randomUUID())).toBeNull();

    // The worker that completed the job opens its review, once.
    expect(await ask(WORKER, String(jobId))).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ask(WORKER, String(jobId))).toBeNull();
    expect(await reviewCount(admitted.tenantId)).toBe(1);
    expect(await pendingFacts(admitted.tenantId)).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});
