// The synthetic tenant of the contract parity suite
// (engine/domain/companyOsContracts.dbtest.ts): rows that reach every branch
// the company_os_api projections have, built through the domain services, the
// worker's own lease-bound steps and, where no service can produce a state
// without a provider or a CRM contact, owner rows shaped as those services
// write them. Everything runs on the caller's owner transaction, which the
// suite always rolls back.
//
// Stops are planted as rows, never through ops.trip_execution_stop, so this
// takes the kill-switch lock only shared (the worker steps), never exclusively.
// All data is synthetic office-operations text; the sentinels below must never
// reach a response.

import { randomBytes, randomUUID } from "node:crypto";
import type { TxClient } from "../../db/types.ts";

const SOURCE = "dbtest-cos-contracts";
const PROVIDER = "fake";
const MODEL = "dbtest-cos-contract-model";
const PROMPT_VERSION = "lead_triage.v1";

// Values that must never reach a response. None is placed in free text that a
// projection returns as content (a note, a reason, a label).
export const BODY = "COS-SENTINEL-BODY synthetic question about opening hours";
const DRAFT = "COS-SENTINEL-DRAFT synthetic reply";
export const PHONE = "5511900000771";
// Every label a person or a service writes, each distinct so a leak names its
// column: stops, reviews, channels, sends and marks; price and limit rows;
// the membership grant; the worker's lease.
export const ACTOR = "cos.sentinel.actor@example.test";
export const PRICE_RECORDER = "cos.sentinel.price-recorder@example.test";
export const LIMIT_SETTER = "cos.sentinel.limit-setter@example.test";
export const GRANTOR = "cos.sentinel.grantor@example.test";
export const WORKER = "dbtest-cos-contracts-worker";
// The member's principal and grant (ops.principals.display_name may hold no '@').
export const DISPLAY_NAME = "COS-SENTINEL-DISPLAY-NAME Synthetic Member";
export const GRANT_REASON =
  "COS-SENTINEL-GRANT-REASON synthetic parity session";
// A synthetic auth user's name; its email is mixed case, so the email, its
// lower-cased form and that form's hash are three different values.
export const AUTH_GIVEN_NAME = "CosSentinelGiven";
export const AUTH_FAMILY_NAME = "CosSentinelFamily";
// Message, contact and call identity, and the fixture's own task text.
export const SYNTHETIC_MESSAGE_ID_PREFIX = "dbtest-cos-msg-";
export const SYNTHETIC_CONTACT_PREFIX = "synthetic:dbtest-lead-";
export const WHATSAPP_MESSAGE_ID_PREFIX = "wamid.DBTEST";
export const PROVIDER_REQUEST_ID = "dbtest-req-1";
export const PROVIDER_RESPONSE_ID = "dbtest-resp-1";
export const RETRY_IDEMPOTENCY_KEY = "dbtest-cos-retry-9";
export const TASK_TITLE = "Synthetic follow-up call";
export const AGENT_ROLE = "Intake assistant";

/** A lead_triage result that passes its output contract. */
const VALID_ADVICE = Object.freeze({
  outcome: "triaged",
  summary: "A synthetic person asks about a first appointment.",
  intent: "book_appointment",
  priority: "normal",
  recommended_next_action: "Offer two synthetic slots.",
  response_draft: DRAFT,
  needs_human_review: false,
  flags: ["unclear"],
});

async function one<T>(
  tx: TxClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const { rows } = await tx.query<{ v: T }>(sql, params);
  if (rows.length !== 1) throw new Error(`expected one row from: ${sql}`);
  return rows[0].v;
}

export function must(condition: boolean, what: string): void {
  if (!condition) throw new Error(`fixture: ${what}`);
}

interface Unit {
  readonly id: string;
  readonly companyId: string;
}

interface Admitted {
  readonly taskId: string;
  readonly runId: string;
}

/** What the suite needs to call every function and check what came back. */
export interface Fixture {
  readonly tenantId: string;
  readonly slug: string;
  readonly providerTarget: string;
  readonly agents: readonly string[];
  readonly tasks: readonly string[];
  readonly runs: readonly string[];
  readonly reviews: readonly string[];
  readonly tripped: Readonly<Record<string, string>>;
  readonly subjects: readonly (readonly [string, string])[];
  readonly eventCount: number;
  /**
   * Every task, run, review, outbound record and stop the fixture creates, by
   * a stable `<kind>:<name>` label, in creation order: the recorder
   * (companyOsRecordedResponses.dbtest.ts) maps each random id to a
   * deterministic one through it.
   */
  readonly named: Readonly<Record<string, string>>;
}

async function admitSynthetic(
  tx: TxClient,
  tenantId: string,
  agent: Unit,
  n: number,
): Promise<Admitted> {
  const admitted = await one<{ task_id: string; agent_run_id: string }>(
    tx,
    `select ops.admit_inbound_message($1, $2, $3, 'synthetic', $4, $5, $6, $7) as v`,
    [
      tenantId,
      agent.companyId,
      agent.id,
      `${SYNTHETIC_MESSAGE_ID_PREFIX}${n}`,
      `${SYNTHETIC_CONTACT_PREFIX}${n}`,
      BODY,
      SOURCE,
    ],
  );
  return { taskId: admitted.task_id, runId: admitted.agent_run_id };
}

/** Leases the run's job to WORKER, as ops.lease_job would, and binds the lease. */
async function lease(tx: TxClient, runId: string): Promise<string> {
  const jobId = await one<string>(
    tx,
    `update ops.jobs j
        set status = 'leased', lease_owner = $2, leased_at = now(),
            lease_expires_at = now() + interval '5 minutes',
            attempts = attempts + 1, updated_at = now()
       from ops.agent_runs r
      where r.id = $1 and j.id = r.job_id and j.status = 'queued'
      returning j.id as v`,
    [runId, WORKER],
  );
  await tx.query(
    `insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
     select j.id, j.tenant_id, 'leased', $2, j.attempts, j.kind from ops.jobs j where j.id = $1`,
    [jobId, WORKER],
  );
  await tx.query(
    "select set_config('app.worker_id', $1, true), set_config('app.job_id', $2, true)",
    [WORKER, jobId],
  );
  return jobId;
}

/** Runs one worker step as ops_worker, on the lease `lease` bound. */
async function asWorker<T>(tx: TxClient, step: () => Promise<T>): Promise<T> {
  await tx.query("set local role ops_worker");
  const result = await step();
  await tx.query("reset role");
  return result;
}

/** Leases, claims and starts a run: it is then running on a live lease. */
async function start(tx: TxClient, runId: string): Promise<string> {
  const maxOutput = await one<number>(
    tx,
    `select p.max_output_tokens as v from ops.agent_run_route_policies() p
      where p.model_route = (select r.model_route from ops.agent_runs r where r.id = $1)`,
    [runId],
  );
  const jobId = await lease(tx, runId);
  await asWorker(tx, async () => {
    const claim = await one<{ action: string }>(
      tx,
      "select ops.claim_agent_run() as v",
    );
    must(claim.action === "start", `run ${runId} is claimable`);
    const started = await one<string>(
      tx,
      "select ops.start_agent_run($1, $2, $3, $4, $5) as v",
      [
        PROVIDER,
        MODEL,
        PROMPT_VERSION,
        randomBytes(32).toString("hex"),
        maxOutput,
      ],
    );
    must(started === "running", `run ${runId} starts (got ${started})`);
  });
  return jobId;
}

/** Settles a started run with a provider failure, then completes its job. */
async function fail(
  tx: TxClient,
  runId: string,
  category: string,
  expected: string,
): Promise<void> {
  const jobId = await start(tx, runId);
  await asWorker(tx, async () => {
    const status = await one<string>(
      tx,
      "select ops.fail_agent_run($1, 'dbtest_provider_error', null, null, null, 12, 0, 12, 0, 0, 900) as v",
      [category],
    );
    must(status === expected, `run ${runId} settles ${expected}`);
    await tx.query("select ops.complete_job($1)", [jobId]);
  });
}

async function plantStop(
  tx: TxClient,
  tenantId: string,
  scope: string,
  target: {
    companyId?: string;
    departmentId?: string;
    agentId?: string;
    jobKind?: string;
  },
  reason: string,
): Promise<string> {
  return one<string>(
    tx,
    `insert into ops.execution_stops
       (scope, tenant_id, company_id, department_id, agent_id, job_kind, reason, tripped_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id as v`,
    [
      scope,
      tenantId,
      target.companyId ?? null,
      target.departmentId ?? null,
      target.agentId ?? null,
      target.jobKind ?? null,
      reason,
      ACTOR,
    ],
  );
}

async function insertReview(
  tx: TxClient,
  tenantId: string,
  taskId: string,
  runId: string,
  capability: string,
  proposed: unknown,
  doNotContact: boolean,
): Promise<string> {
  return one<string>(
    tx,
    `insert into ops.review_items
       (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
     select t.tenant_id, t.company_id, t.id, $3, $4, $5::jsonb, $6
       from ops.tasks t where t.tenant_id = $1 and t.id = $2
     returning id as v`,
    [
      tenantId,
      taskId,
      runId,
      capability,
      JSON.stringify(proposed),
      doNotContact,
    ],
  );
}

/**
 * Phase 2D.1: a completed shadow decision on `reviewId`, recorded as the owner
 * through the guarded lifecycle (pending, running, completed) that the worker's
 * capabilities follow. The fake provider's answer for an information enquiry.
 */
async function recordShadowDecision(
  tx: TxClient,
  reviewId: string,
): Promise<void> {
  const id = await one<string>(
    tx,
    `insert into ops.decision_evaluations
       (tenant_id, company_id, department_id, agent_id, review_item_id, subject, trigger_source,
        policy_version, idempotency_key, status)
     select r.tenant_id, r.company_id, a.department_id, a.id, r.id, 'lead_triage.review', 'review.opened',
            'decision_shadow.v1', 'review:' || r.id || ':decision_shadow.v1', 'pending'
       from ops.review_items r
       join ops.tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
       join ops.agents a on a.tenant_id = t.tenant_id and a.id = t.assigned_agent_id
      where r.id = $1
     returning id as v`,
    [reviewId],
  );
  const fingerprint = `sha256:${"0".repeat(64)}`;
  await tx.query(
    `update ops.decision_evaluations
        set status = 'running', started_at = now(), provider_kind = 'fake', provider_id = 'fake-rules',
            provider_version = '1', input_fingerprint = $2
      where id = $1`,
    [id, fingerprint],
  );
  const vector = {
    version: "decision_vector.v1",
    mode: "shadow",
    recommendation: "accept",
    confidence: 0.82,
    caution: "low",
    reasonCodes: ["triage_complete", "intent_information"],
    provider: { kind: "fake", id: "fake-rules", version: "1" },
    inputFingerprint: fingerprint,
    evaluatedAt: "2026-09-22T11:00:00.000Z",
  };
  await tx.query(
    `update ops.decision_evaluations
        set status = 'completed', vector = $2::jsonb,
            policy_outcome = ops.decision_shadow_policy($2::jsonb), settled_at = now()
      where id = $1`,
    [id, JSON.stringify(vector)],
  );
}

/**
 * An authorized send for an accepted review of a WhatsApp task: the row and the
 * event ops.request_outbound_send writes. That service itself refuses here,
 * because send eligibility needs a CRM contact the fixture never creates.
 */
async function authorizeSend(
  tx: TxClient,
  tenantId: string,
  reviewId: string,
): Promise<string> {
  const outboundId = await one<string>(
    tx,
    `insert into ops.outbound_messages
       (tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
        status, requested_by, authorized_check)
     select r.tenant_id, r.company_id, i.channel_id, i.conversation_id, r.id, r.task_id,
            'authorized', $3, '{}'::jsonb
       from ops.review_items r
       join ops.inbound_messages i on i.tenant_id = r.tenant_id and i.task_id = r.task_id
      where r.tenant_id = $1 and r.id = $2
     returning id as v`,
    [tenantId, reviewId, ACTOR],
  );
  await tx.query(
    `select ops.record_event(t.tenant_id, t.company_id, 'communication.outbound_authorized',
                             'operator-cli', 'task', t.id,
                             jsonb_build_object('outbound_message_id', $2::uuid, 'review_item_id', $3::uuid))
       from ops.tasks t join ops.review_items r on r.task_id = t.id and r.tenant_id = t.tenant_id
      where t.tenant_id = $1 and r.id = $3`,
    [tenantId, outboundId, reviewId],
  );
  return outboundId;
}

export async function buildFixture(tx: TxClient): Promise<Fixture> {
  const named: Record<string, string> = {};
  const name = (label: string, id: string): string => {
    must(!(label in named), `${label} is named once`);
    named[label] = id;
    return id;
  };
  const nameAdmitted = (label: string, admitted: Admitted): Admitted => {
    name(`task:${label}`, admitted.taskId);
    name(`run:${label}`, admitted.runId);
    return admitted;
  };
  const tenantId = randomUUID();
  const slug = `dbtest-cos-contracts-${tenantId.slice(0, 8)}`;
  // A synthetic phone number id no other suite's channel can hold.
  const digits = Array.from(randomBytes(13), (b) => String(b % 10)).join("");
  const providerTarget = "39" + digits;

  // Worker steps switch to ops_worker. The development stack's SQL suites
  // leave the owner a member; grant it here otherwise, rolled back like the rest.
  await tx.query(`do $$ begin
    if not pg_has_role(current_user, 'ops_worker', 'member') then
      execute format('grant ops_worker to %I', current_user);
    end if;
  end $$`);

  // The Phase 2C eligibility policy: this tenant owns the local CRM. Two
  // statements, because the unique index allows one holder at every step.
  await tx.query(
    "update ops.tenants set owns_local_crm = false where owns_local_crm",
  );
  await tx.query(
    "insert into ops.tenants (id, slug, name, owns_local_crm) values ($1, $2, 'COS Contract Tenant', true)",
    [tenantId, slug],
  );

  const company = (s: string, name: string) =>
    one<string>(tx, "select ops.create_company($1, $2, $3, $4) as v", [
      tenantId,
      s,
      name,
      SOURCE,
    ]);
  const department = (companyId: string, s: string, name: string) =>
    one<string>(tx, "select ops.create_department($1, $2, $3, $4, $5) as v", [
      tenantId,
      companyId,
      s,
      name,
      SOURCE,
    ]);
  const agent = async (
    companyId: string,
    departmentId: string,
    s: string,
    name: string,
  ): Promise<Unit> => ({
    id: await one<string>(
      tx,
      "select ops.create_agent($1, $2, $3, $4, $5, $6, $7) as v",
      [tenantId, companyId, departmentId, s, name, AGENT_ROLE, SOURCE],
    ),
    companyId,
  });

  const clinic = await company("clinic-a", "Clinic A");
  const annex = await company("clinic-annex", "Clinic Annex");
  const closed = await company("clinic-closed", "Clinic Closed");
  const intake = await department(clinic, "intake", "Intake");
  const night = await department(clinic, "night-desk", "Night Desk");
  const paused = await department(clinic, "paused-desk", "Paused Desk");
  const annexIntake = await department(annex, "annex-intake", "Annex Intake");
  const closedIntake = await department(
    closed,
    "closed-intake",
    "Closed Intake",
  );

  const triage = await agent(clinic, intake, "lead-triage", "Lead Triage");
  const followUp = await agent(clinic, intake, "follow-up", "Follow Up");
  const annexTriage = await agent(
    annex,
    annexIntake,
    "annex-triage",
    "Annex Triage",
  );
  const archive = await agent(clinic, intake, "archive", "Archive");
  const nightDesk = await agent(
    clinic,
    night,
    "night-desk",
    "Night Desk Agent",
  );
  const queueDesk = await agent(clinic, intake, "queue-desk", "Queue Desk");
  const pausedDesk = await agent(
    clinic,
    paused,
    "paused-desk",
    "Paused Desk Agent",
  );
  const closedDesk = await agent(
    closed,
    closedIntake,
    "closed-desk",
    "Closed Desk",
  );

  await tx.query("select ops.set_agent_status($1, $2, 'inactive', $3)", [
    tenantId,
    archive.id,
    SOURCE,
  ]);
  await tx.query("select ops.set_department_status($1, $2, 'inactive', $3)", [
    tenantId,
    paused,
    SOURCE,
  ]);
  await tx.query("select ops.set_company_status($1, $2, 'inactive', $3)", [
    tenantId,
    closed,
    SOURCE,
  ]);

  // Governance: a price for this suite's own model, the tenant's budget, a
  // zero company budget, and a global ceiling only when none is active.
  await tx.query(
    `select ops.record_model_price($1, $2, 1.25, 2.5, true, now() - interval '1 minute',
                                   now() + interval '1 day', 'dbtest contract price', $3, 0.125)`,
    [PROVIDER, MODEL, PRICE_RECORDER],
  );
  await tx.query(
    `select ops.set_spend_limit('global', 1000000000000, 'UTC', 'dbtest contract ceiling', $1)
      where not exists (select 1 from ops.spend_limits where scope = 'global' and ended_at is null)`,
    [LIMIT_SETTER],
  );
  await tx.query(
    "select ops.set_spend_limit('tenant', 100000000000, 'UTC', 'dbtest contract budget', $2, $1)",
    [tenantId, LIMIT_SETTER],
  );
  await tx.query(
    "select ops.set_spend_limit('company', 0, 'UTC', 'dbtest annex budget', $3, $1, $2)",
    [tenantId, annex, LIMIT_SETTER],
  );

  // Channels: an active test line and an inactive production one.
  await tx.query(
    "select ops.configure_whatsapp_channel($1, $2, $3, $4, 'test', 'Synthetic test line', $5)",
    [tenantId, clinic, triage.id, providerTarget, ACTOR],
  );
  await tx.query(
    "select ops.configure_whatsapp_channel($1, $2, $3, $4, 'production', 'Production line', $5, false)",
    [tenantId, clinic, triage.id, "38" + digits, ACTOR],
  );

  // Runs, one per state the projections distinguish.
  const succeeded = nameAdmitted(
    "succeeded",
    await admitSynthetic(tx, tenantId, triage, 1),
  );
  const succeededJob = await start(tx, succeeded.runId);
  await asWorker(tx, async () => {
    const status = await one<string>(
      tx,
      `select ops.complete_agent_run($1::jsonb, $2, 'completed', $3,
                                     $4, 120, 60, 180, 0, 0, 42) as v`,
      [
        JSON.stringify(VALID_ADVICE),
        MODEL,
        PROVIDER_REQUEST_ID,
        PROVIDER_RESPONSE_ID,
      ],
    );
    must(status === "succeeded", "the first run succeeds");
    await tx.query("select ops.complete_job($1)", [succeededJob]);
    await tx.query("select ops.open_review_for_settled_job($1, $2)", [
      WORKER,
      succeededJob,
    ]);
  });

  const whatsapp = async (n: number, body: string) =>
    one<{ state: string; task_id?: string; agent_run_id?: string }>(
      tx,
      "select ops.receive_whatsapp_message($1, $2, $3, $4, now()) as v",
      [providerTarget, `${WHATSAPP_MESSAGE_ID_PREFIX}${n}`, PHONE, body],
    );
  const working = await whatsapp(2, BODY);
  must(working.state === "admitted", "a WhatsApp message is admitted");
  nameAdmitted("working", {
    taskId: working.task_id as string,
    runId: working.agent_run_id as string,
  });
  await start(tx, working.agent_run_id as string);

  const stale = nameAdmitted(
    "stale",
    await admitSynthetic(tx, tenantId, nightDesk, 3),
  );
  const staleJob = await start(tx, stale.runId);
  await tx.query(
    "update ops.jobs set lease_expires_at = now() - interval '1 minute' where id = $1",
    [staleJob],
  );

  const failed = nameAdmitted(
    "failed",
    await admitSynthetic(tx, tenantId, triage, 7),
  );
  await fail(tx, failed.runId, "invalid_request", "failed");
  const indeterminate = nameAdmitted(
    "indeterminate",
    await admitSynthetic(tx, tenantId, triage, 8),
  );
  await fail(tx, indeterminate.runId, "timeout", "indeterminate");
  const retried = nameAdmitted(
    "retried",
    await admitSynthetic(tx, tenantId, triage, 9),
  );
  await fail(tx, retried.runId, "transport", "indeterminate");
  const retry = await one<string>(
    tx,
    "select ops.request_agent_run($1, $2, $3, 'lead_triage', $4, $5, $6) as v",
    [
      tenantId,
      retried.taskId,
      triage.id,
      RETRY_IDEMPOTENCY_KEY,
      SOURCE,
      retried.runId,
    ],
  );
  name("run:retry", retry);
  nameAdmitted("queued", await admitSynthetic(tx, tenantId, queueDesk, 11));

  // Held: queued before its agent is stopped, then deferred at the lease.
  const held = nameAdmitted(
    "held",
    await admitSynthetic(tx, tenantId, followUp, 4),
  );
  const agentStop = await plantStop(
    tx,
    tenantId,
    "agent",
    { companyId: clinic, agentId: followUp.id },
    "Synthetic pause of the follow-up desk",
  );
  name("stop:agent", agentStop);
  await lease(tx, held.runId);
  await asWorker(tx, async () => {
    const stop = await one<string | null>(tx, "select ops.defer_job() as v");
    must(stop === agentStop, "the held job is deferred by its agent's stop");
  });
  const refusedByStop = nameAdmitted(
    "refused-by-stop",
    await admitSynthetic(tx, tenantId, followUp, 5),
  );
  const refusedByBudget = nameAdmitted(
    "refused-by-budget",
    await admitSynthetic(tx, tenantId, annexTriage, 6),
  );
  const companyStop = await plantStop(
    tx,
    tenantId,
    "company",
    { companyId: annex },
    "Synthetic annex pause",
  );
  name("stop:company", companyStop);
  const departmentStop = await plantStop(
    tx,
    tenantId,
    "department",
    { companyId: clinic, departmentId: paused },
    "Synthetic desk pause",
  );
  name("stop:department", departmentStop);

  // Reviews: one opened by the runtime; the rest as rows, one per branch.
  const opened = await one<string>(
    tx,
    "select id as v from ops.review_items where agent_run_id = $1",
    [succeeded.runId],
  );
  name("review:opened", opened);
  const accepted: string[] = [];
  const sends: string[] = [];
  // Each send ends differently below: failed, blocked, marked indeterminate.
  const sendOutcomes = ["failed", "blocked", "indeterminate"];
  for (const n of [12, 13, 14]) {
    const message = await whatsapp(n, BODY);
    must(message.state === "admitted", `WhatsApp message ${n} is admitted`);
    const label = `accepted-${n - 11}`;
    nameAdmitted(label, {
      taskId: message.task_id as string,
      runId: message.agent_run_id as string,
    });
    const reviewId = await insertReview(
      tx,
      tenantId,
      message.task_id as string,
      message.agent_run_id as string,
      "lead_triage",
      VALID_ADVICE,
      false,
    );
    await tx.query(
      "select ops.record_review_decision($1, $2, 'accepted', $3, 'operator-cli', $4)",
      [tenantId, reviewId, ACTOR, n === 12 ? "Call back tomorrow" : null],
    );
    accepted.push(name(`review:${label}`, reviewId));
    sends.push(
      name(
        `outbound:${sendOutcomes[n - 12]}`,
        await authorizeSend(tx, tenantId, reviewId),
      ),
    );
  }
  const notPinned = await insertReview(
    tx,
    tenantId,
    failed.taskId,
    randomUUID(),
    "intake_summary",
    {},
    false,
  );
  name("review:not-pinned", notPinned);
  await tx.query(
    "select ops.record_review_decision($1, $2, 'rejected', $3, 'operator-cli')",
    [tenantId, notPinned, ACTOR],
  );
  const invalid = await insertReview(
    tx,
    tenantId,
    indeterminate.taskId,
    indeterminate.runId,
    "lead_triage",
    { outcome: "triaged" },
    false,
  );
  name("review:invalid", invalid);
  await tx.query(
    "select ops.record_review_decision($1, $2, 'needs_edit', $3, 'operator-cli', '')",
    [tenantId, invalid, ACTOR],
  );
  const bareTask = await one<string>(
    tx,
    `select ops.create_task($1, $2, 'lead_triage', $6, $3, $4, $5,
                            null, 250, now() + interval '1 day') as v`,
    [tenantId, clinic, SOURCE, BODY, intake, TASK_TITLE],
  );
  name("task:bare", bareTask);
  const noOrigin = await insertReview(
    tx,
    tenantId,
    bareTask,
    randomUUID(),
    "lead_triage",
    VALID_ADVICE,
    false,
  );
  name("review:no-origin", noOrigin);
  // The review a member can decide from the browser (S7.1): pending, on a
  // synthetic admission, not do-not-contact.
  const open = await insertReview(
    tx,
    tenantId,
    refusedByBudget.taskId,
    randomUUID(),
    "lead_triage",
    VALID_ADVICE,
    false,
  );
  name("review:open", open);
  // Phase 2D.1: its shadow decision, completed, through the guarded lifecycle
  // (the worker's own path needs a real run; this review has none).
  await recordShadowDecision(tx, open);

  // Sends: failed after sending, blocked by eligibility, marked indeterminate.
  await tx.query(
    "update ops.outbound_messages set status = 'sending', sending_at = now() where id = $1",
    [sends[0]],
  );
  await tx.query(
    "select ops.settle_outbound_send($1, $2, 'failed', null, '131047', 'provider_error')",
    [tenantId, sends[0]],
  );
  const begun = await one<{ state: string }>(
    tx,
    "select ops.begin_outbound_send($1, $2) as v",
    [tenantId, sends[1]],
  );
  must(
    begun.state === "blocked",
    `a send with no CRM contact is blocked (got ${begun.state})`,
  );
  await tx.query(
    `update ops.outbound_messages set status = 'sending', sending_at = now() - interval '10 minutes'
      where id = $1`,
    [sends[2]],
  );
  await tx.query("select ops.mark_outbound_indeterminate($1, $2, $3)", [
    tenantId,
    sends[2],
    ACTOR,
  ]);
  const workingTask = working.task_id as string;
  await tx.query(
    `select ops.record_event($1, $2, 'communication.delivery_updated', 'whatsapp-gateway', 'task', $3,
                             jsonb_build_object('outbound_message_id', $4::uuid, 'status', 'failed',
                                                'previous', 'sending'))`,
    [tenantId, clinic, workingTask, sends[0]],
  );

  // A refused delivery, and an event of a kind and source no allowlist knows.
  const refused = await whatsapp(15, "   ");
  must(refused.state === "refused", "a blank message is refused on the record");
  await tx.query(
    `select ops.record_event($1, $2, 'dbtest.contract_probe', 'legacy-import', 'task', $3,
                             jsonb_build_object('body', $4::text, 'marked_by', $5::text))`,
    [tenantId, clinic, bareTask, BODY, ACTOR],
  );

  // Tenant-wide stops last, each cleared, so they held nothing above.
  const tenantStop = await plantStop(
    tx,
    tenantId,
    "tenant",
    {},
    "Synthetic tenant drill",
  );
  name("stop:tenant", tenantStop);
  const kindStop = await plantStop(
    tx,
    tenantId,
    "job_kind",
    { jobKind: "agent_run.execute" },
    "Synthetic kind drill",
  );
  name("stop:kind", kindStop);
  for (const [stopId, reason] of [
    [tenantStop, "Drill over"],
    [kindStop, "Kind drill over"],
  ]) {
    await tx.query(
      "update ops.execution_stops set cleared_by = $2, cleared_reason = $3 where id = $1",
      [stopId, ACTOR, reason],
    );
  }

  const ids = async (sql: string) =>
    (await tx.query<{ id: string }>(sql, [tenantId])).rows.map((row) => row.id);
  return {
    tenantId,
    slug,
    providerTarget,
    agents: await ids(
      "select id from ops.agents where tenant_id = $1 order by name",
    ),
    tasks: await ids(
      "select id from ops.tasks where tenant_id = $1 order by created_at, id",
    ),
    runs: await ids(
      "select id from ops.agent_runs where tenant_id = $1 order by created_at, id",
    ),
    reviews: [opened, ...accepted, notPinned, invalid, noOrigin, open],
    tripped: {
      retry,
      held: held.runId,
      refusedByStop: refusedByStop.runId,
      refusedByBudget: refusedByBudget.runId,
      agentStop,
      companyStop,
      departmentStop,
      tenantStop,
      kindStop,
      pausedDesk: pausedDesk.id,
      closedDesk: closedDesk.id,
    },
    subjects: [
      ["task", workingTask],
      ["agent_run", succeeded.runId],
      ["agent", archive.id],
      ["department", paused],
      ["company", closed],
    ],
    eventCount: await one<number>(
      tx,
      "select count(*)::int as v from ops.events where tenant_id = $1",
      [tenantId],
    ),
    named,
  };
}

// ---------------------------------------------------------------------------
// The member.
// ---------------------------------------------------------------------------

export interface AuthUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
}

/** A confirmed synthetic auth user with a live session. */
export async function createAuthUser(tx: TxClient): Promise<AuthUser> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const email = `DbTest.COS-Sentinel.Member-${userId.slice(0, 8)}@Example.Test`;
  await tx.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                             email_confirmed_at, created_at, updated_at,
                             raw_app_meta_data, raw_user_meta_data)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $2, '', now(), now(), now(), '{}',
             jsonb_build_object('first_name', $3::text, 'last_name', $4::text))`,
    [userId, email, AUTH_GIVEN_NAME, AUTH_FAMILY_NAME],
  );
  await tx.query(
    "insert into auth.sessions (id, user_id, created_at, updated_at) values ($1, $2, now(), now())",
    [sessionId, userId],
  );
  return { userId, sessionId, email };
}

/** What PostgREST does with a verified JWT, in its order. */
export async function actAs(tx: TxClient, user: AuthUser): Promise<void> {
  await tx.query("set local role authenticated");
  await tx.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({
      iss: "dbtest",
      sub: user.userId,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      session_id: user.sessionId,
      is_anonymous: false,
    }),
  ]);
}
