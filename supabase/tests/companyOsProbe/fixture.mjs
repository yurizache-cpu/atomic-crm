// The committed fixture of the Company OS Data API probe
// (supabase/tests/companyOsApiExposure.mjs, FIXTURE). PostgREST sees only
// committed rows, so each piece here commits, in ONE owner transaction each:
// a failure leaves nothing of that piece behind.

import { randomUUID } from "node:crypto";
import {
  ACTOR,
  CONTENT,
  DISPLAY_PREFIX,
  PRICE,
  PROBE_SLUGS,
  SENTINELS,
  SLUG_A,
  SLUG_B,
  SOURCE,
  TENANT_A_NAME,
  TENANT_B_NAME,
  UUID,
  digits,
  hex,
  idsOf,
  psql,
} from "./common.mjs";

/**
 * The durable record of a flag the probe borrowed: while tenant A holds the
 * local-CRM flag another tenant held, tenant B's name ends with this and that
 * tenant's id. Tenant B is never readable by any caller (its only member is
 * refused at resolver step 6), and the record commits with the takeover and is
 * removed with the give-back, so an interrupted run's takeover is undone by
 * the next run's leftover sweep (cleanup.mjs).
 */
export const LENT_BY = " | local CRM flag lent by ";

/** The two persistent probe tenants, created on first use, found by slug. */
export function ensureProbeTenants() {
  const ids = idsOf(
    psql(
      `insert into ops.tenants (slug, name, owns_local_crm) values
         ('${SLUG_A}', '${TENANT_A_NAME}', false),
         ('${SLUG_B}', '${TENANT_B_NAME}', false)
       on conflict (slug) do nothing;
       select 'tenant_a=' || id from ops.tenants where slug = '${SLUG_A}';
       select 'tenant_b=' || id from ops.tenants where slug = '${SLUG_B}';`,
    ),
    ["tenant_a", "tenant_b"],
  );
  return { tenantA: ids.tenant_a, tenantB: ids.tenant_b };
}

/**
 * Makes tenant A the one tenant that owns the local CRM (the Phase 2C
 * eligibility policy), recording the tenant that held the flag, if any, in the
 * same transaction. Resolves to that tenant's id, or undefined.
 */
export function lendLocalCrmFlag() {
  const lines = psql(
    `begin;
     select coalesce((select id::text from ops.tenants
                       where owns_local_crm and slug not in ${PROBE_SLUGS}), 'none') as lender \\gset
     update ops.tenants
        set name = '${TENANT_B_NAME}'
                   || case when :'lender' = 'none' then '' else '${LENT_BY}' || :'lender' end
      where slug = '${SLUG_B}';
     update ops.tenants set owns_local_crm = false where owns_local_crm;
     update ops.tenants set owns_local_crm = true where slug = '${SLUG_A}';
     commit;
     select 'lender=' || :'lender';`,
  );
  const lender = lines
    .find((line) => line.startsWith("lender="))
    ?.slice("lender=".length);
  if (lender === "none") return undefined;
  if (!UUID.test(lender ?? "")) {
    throw new Error("the local-CRM flag takeover did not report its lender");
  }
  return lender;
}

/** The per-run values the fixture plants: random, so each run's are its own. */
export function runValues() {
  return {
    providerTarget: digits(15),
    contactRef: digits(15),
    runKeyA: `cos-probe-run-key-${hex(16)}`,
    runKeyB: `cos-probe-run-key-${hex(16)}`,
    runFingerprintA: hex(64),
    runFingerprintB: hex(64),
    inputFingerprintA: hex(64),
    correlationA: randomUUID(),
    correlationB: randomUUID(),
    providerRequestA: `cos-probe-provider-request-${hex(16)}`,
    providerResponseA: `cos-probe-provider-response-${hex(16)}`,
    jobKeyA: `cos-probe-job-key-${hex(16)}`,
    // Legacy fixture A: the admitted lead and the run whose review is decided.
    admissionMessage: `cos-probe-message-${hex(16)}`,
    admissionContact: `synthetic:cos-probe-contact-${hex(16)}`,
    runKeyDecided: `cos-probe-run-key-${hex(16)}`,
    runFingerprintDecided: hex(64),
    inputFingerprintDecided: hex(64),
    correlationDecided: randomUUID(),
    providerRequestDecided: `cos-probe-provider-request-${hex(16)}`,
    providerResponseDecided: `cos-probe-provider-response-${hex(16)}`,
    jobKeyDecided: `cos-probe-job-key-${hex(16)}`,
  };
}

// Tenant A's organisation: a company, a department, an agent and its task.
const OFFICE_A = `
  select ops.create_company(:'tenant_a', 'probe-office', 'Probe office', '${SOURCE}') as company_a \\gset
  select ops.create_department(:'tenant_a', :'company_a', 'front-desk', 'Front desk', '${SOURCE}') as department_a \\gset
  select ops.create_agent(:'tenant_a', :'company_a', :'department_a', 'probe-assistant', 'Probe assistant',
                          '${SENTINELS.agentRole}', '${SOURCE}', '${SENTINELS.agentDescription}') as agent_a \\gset
  select ops.create_task(:'tenant_a', :'company_a', 'office_follow_up', '${SENTINELS.taskTitle}', '${SOURCE}',
                         '${SENTINELS.taskBody}', :'department_a') as task_a \\gset
  select ops.assign_task(:'tenant_a', :'task_a', :'agent_a', '${SOURCE}');`;

// The probe's own platform price row, which only its runs reference.
const PRICE_A = `
  select ops.record_model_price('${PRICE.provider}', '${PRICE.model}', 1.5, 6, false,
                                now() - interval '1 day', now() + interval '300 days',
                                '${SENTINELS.priceSource}', '${SENTINELS.priceRecorder}') as price_a \\gset`;

/**
 * One succeeded lead_triage run of agent_a on the task in psql variable
 * `task`, and the review opened from its stored result into `review`. The run
 * guard admits a run only as pending, so it is born through an owner insert
 * and then moved through the states a worker moves it through, each change
 * checked by that guard. Every execution fact is a sentinel: the stored
 * result (reply draft, summary, next action), the keys, fingerprints,
 * correlation and provider ids (the psql variables suffixed `_${v}`), and its
 * job's lease owner, raw error and step detail. The job is born succeeded, so
 * no worker on this stack can ever lease it. The run is priced by PRICE_A.
 * The review is opened from the stored result exactly as the runtime opens it
 * (ops.open_review_for_run, which the post-settlement step and `triage
 * recover` both call). Sets `run_${v}` and `job_${v}`.
 */
const succeededRun = (v, task, review) => `
  select ops.push_event_context('${SOURCE}', :'correlation_${v}', null);
  insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                              idempotency_key, request_fingerprint, correlation_id, requested_by)
  values (:'tenant_a', :'company_a', :'department_a', :'${task}', :'agent_a', 'lead_triage', 'standard',
          :'run_key_${v}', :'run_fingerprint_${v}', :'correlation_${v}', '${SENTINELS.runRequester}')
  returning id as run_${v} \\gset
  insert into ops.jobs (tenant_id, kind, payload, status, attempts, max_attempts, idempotency_key,
                        leased_at, lease_expires_at, lease_owner, last_error, last_error_class, completed_at)
  values (:'tenant_a', 'agent_run.execute', jsonb_build_object('agent_run_id', :'run_${v}'), 'succeeded', 1, 5,
          :'job_key_${v}', now(), now() + interval '5 minutes', '${SENTINELS.leaseOwner}',
          '${SENTINELS.jobError}', 'transient', now())
  returning id as job_${v} \\gset
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (:'job_${v}', :'tenant_a', 'leased', '${SENTINELS.leaseOwner}', 1, '${SENTINELS.jobEventDetail}');
  update ops.agent_runs set job_id = :'job_${v}' where id = :'run_${v}';
  update ops.agent_runs
     set status = 'running', job_attempt = 1, prompt_version = 'lead_triage.v1',
         input_fingerprint = :'input_fingerprint_${v}', provider = '${PRICE.provider}', model = '${PRICE.model}',
         price_id = :'price_a', reserved_cost_micros = 50000
   where id = :'run_${v}';
  update ops.agent_runs
     set status = 'succeeded',
         result = jsonb_build_object(
           'outcome', 'triaged', 'intent', 'book_appointment', 'priority', 'normal',
           'summary', '${SENTINELS.runSummary}', 'recommended_next_action', '${SENTINELS.runNextAction}',
           'response_draft', '${SENTINELS.draft}', 'needs_human_review', false,
           'flags', jsonb_build_array('unclear')),
         response_model = '${PRICE.model}', provider_request_id = :'provider_request_${v}',
         provider_response_id = :'provider_response_${v}', finish_reason = 'completed',
         input_tokens = 1200, output_tokens = 300, total_tokens = 1500, cached_input_tokens = 0,
         reasoning_tokens = 0, latency_ms = 842
   where id = :'run_${v}';
  select ops.open_review_for_run(:'tenant_a', :'run_${v}') as ${review} \\gset`;

// One succeeded lead_triage run on task_a, a task no admission created, so
// its pending review is do-not-contact and its advice is withheld.
const RUN_A = `${PRICE_A}${succeededRun("a", "task_a", "review_pending")}`;

// The PR #6 legacy actor labels (brief §16), every one email-like:
// (A) a review opened by the runtime path for a task an admission created,
//     then decided through the owner service ops.record_review_decision,
//     exactly as the CLI records one, under an email-like reviewer. The lead
//     is admitted through ops.admit_inbound_message as the synthetic ingress
//     admits one; the run the admission requests is refused on the record at
//     the request (tenant A has no budget, so whatever the platform holds the
//     request is refused, and a refusal creates no job for any worker), so the
//     run whose advice is reviewed is a second, succeeded one on that task,
//     and its review carries the admission's consent (not do-not-contact),
//     which is what lets it be accepted;
// (B) an active agent stop and a cleared tenant stop, the label in tripped_by
//     and in cleared_by;
// (C) a send requested under the label, on the decided review, over an
//     inactive test channel: nothing routes to it and nothing leaves.
const LEGACY_A = `
  select ops.admit_inbound_message(:'tenant_a', :'company_a', :'agent_a', 'synthetic', :'admission_message',
                                   :'admission_contact', '${SENTINELS.admittedBody}', '${SOURCE}', false, now())
         as admission \\gset
  select (:'admission'::jsonb ->> 'task_id') as task_admitted \\gset
  select ('probe fixture: the admitted lead''s own run was not refused at the request, with no job ('
          || r.status || ')')::int
    from ops.agent_runs r
   where r.id = (:'admission'::jsonb ->> 'agent_run_id')::uuid
     and not (r.status = 'cancelled' and r.error_category = 'refused' and r.job_id is null);
  ${succeededRun("decided", "task_admitted", "review_decided")}
  select ('probe fixture: the decided review was not opened pending, with the admission''s consent ('
          || coalesce(v.status, 'missing') || ')')::int
    from (select 1) one
    left join ops.review_items v on v.id = :'review_decided'
   where v.id is null or v.agent_run_id <> :'run_decided' or v.status <> 'pending' or v.do_not_contact;
  select ops.record_review_decision(:'tenant_a', :'review_decided', 'accepted', '${SENTINELS.reviewer}',
                                    'operator-cli', '${CONTENT.decisionNote}');
  select ops.trip_execution_stop('agent', '${CONTENT.stopReason}', '${SENTINELS.tripper}',
                                 :'tenant_a', :'company_a', null, :'agent_a') as stop_a \\gset
  select ops.trip_execution_stop('tenant', '${CONTENT.drillReason}', '${SENTINELS.tripper}',
                                 :'tenant_a', null, null, null, null) as stop_cleared \\gset
  select ops.clear_execution_stop(:'stop_cleared', '${CONTENT.clearedReason}', '${SENTINELS.clearer}');
  insert into ops.communication_channels (tenant_id, company_id, agent_id, provider, provider_target,
                                          mode, active, label, configured_by)
  values (:'tenant_a', :'company_a', :'agent_a', 'meta_whatsapp', :'provider_target',
          'test', false, 'Probe test channel', '${SENTINELS.configurer}')
  returning id as channel_a \\gset
  insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref)
  values (:'tenant_a', :'company_a', :'channel_a', :'contact_ref')
  returning id as conversation_a \\gset
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (:'tenant_a', :'company_a', :'channel_a', :'conversation_a', :'review_decided',
          :'task_admitted', 'authorized', '${SENTINELS.requester}', '{}'::jsonb)
  returning id as outbound_a \\gset`;

// Tenant B: an organisation, and a task, a pending run and a pending review of
// its own, so every get_* selector can be fed a foreign id of its own kind.
const OFFICE_B = `
  select ops.create_company(:'tenant_b', 'probe-office-b', '${SENTINELS.companyB}', '${SOURCE}') as company_b \\gset
  select ops.create_department(:'tenant_b', :'company_b', 'front-desk', 'Front desk', '${SOURCE}') as department_b \\gset
  select ops.create_agent(:'tenant_b', :'company_b', :'department_b', 'probe-assistant-b', '${SENTINELS.agentB}',
                          'Assistant', '${SOURCE}') as agent_b \\gset
  select ops.create_task(:'tenant_b', :'company_b', 'office_follow_up', '${SENTINELS.taskTitleB}', '${SOURCE}',
                         '${SENTINELS.taskBodyB}', :'department_b') as task_b \\gset
  select ops.assign_task(:'tenant_b', :'task_b', :'agent_b', '${SOURCE}');
  select ops.push_event_context('${SOURCE}', :'correlation_b', null);
  insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                              idempotency_key, request_fingerprint, correlation_id, requested_by)
  values (:'tenant_b', :'company_b', :'department_b', :'task_b', :'agent_b', 'lead_triage', 'standard',
          :'run_key_b', :'run_fingerprint_b', :'correlation_b', '${SENTINELS.runRequester}')
  returning id as run_b \\gset
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed)
  values (:'tenant_b', :'company_b', :'task_b', :'run_b', 'lead_triage',
          jsonb_build_object('response_draft', '${SENTINELS.draft}'))
  returning id as review_b \\gset`;

const OFFICE_KEYS = Object.freeze([
  "company_a",
  "department_a",
  "agent_a",
  "task_a",
  "run_a",
  "job_a",
  "price_a",
  "review_pending",
  "task_admitted",
  "run_decided",
  "job_decided",
  "review_decided",
  "stop_a",
  "stop_cleared",
  "channel_a",
  "outbound_a",
  "company_b",
  "department_b",
  "agent_b",
  "task_b",
  "run_b",
  "review_b",
]);

/** Both tenants' per-run rows, in one transaction; resolves to their ids. */
export function buildOffice(t) {
  const v = t.values;
  return idsOf(
    psql(
      `begin;
       ${OFFICE_A}
       ${RUN_A}
       ${LEGACY_A}
       ${OFFICE_B}
       commit;
       ${OFFICE_KEYS.map((key) => `select '${key}=' || :'${key}';`).join("\n")}`,
      {
        tenant_a: t.tenantA,
        tenant_b: t.tenantB,
        provider_target: v.providerTarget,
        contact_ref: v.contactRef,
        run_key_a: v.runKeyA,
        run_key_b: v.runKeyB,
        run_fingerprint_a: v.runFingerprintA,
        run_fingerprint_b: v.runFingerprintB,
        input_fingerprint_a: v.inputFingerprintA,
        correlation_a: v.correlationA,
        correlation_b: v.correlationB,
        provider_request_a: v.providerRequestA,
        provider_response_a: v.providerResponseA,
        job_key_a: v.jobKeyA,
        admission_message: v.admissionMessage,
        admission_contact: v.admissionContact,
        run_key_decided: v.runKeyDecided,
        run_fingerprint_decided: v.runFingerprintDecided,
        input_fingerprint_decided: v.inputFingerprintDecided,
        correlation_decided: v.correlationDecided,
        provider_request_decided: v.providerRequestDecided,
        provider_response_decided: v.providerResponseDecided,
        job_key_decided: v.jobKeyDecided,
      },
    ),
    OFFICE_KEYS,
  );
}

/** The owner's grants: a member, a revoked member, a member of tenant B. */
export function grantMemberships(t) {
  return idsOf(
    psql(
      `begin;
       select ops.grant_membership(:'tenant_a', :'member', '${SENTINELS.display}', '${ACTOR}',
                                   'probe membership') as grant_member \\gset
       select ops.grant_membership(:'tenant_a', :'revoked', '${DISPLAY_PREFIX}revoked', '${ACTOR}',
                                   'probe membership') as grant_revoked \\gset
       select ops.revoke_membership((:'grant_revoked'::jsonb ->> 'membershipId')::uuid, '${ACTOR}', 'probe revoke');
       -- Test-only owner fixture: the owner service refuses a tenant outside
       -- the Phase 2C eligibility policy, the table does not (brief §16).
       with p as (
         insert into ops.principals (kind, issuer, subject, display_name, created_by)
         values ('human', 'supabase_auth', :'other', '${DISPLAY_PREFIX}other tenant', '${ACTOR}')
         returning id)
       insert into ops.tenant_memberships (principal_id, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
       select p.id, :'tenant_b', encode(sha256(convert_to(lower(:'other_email'), 'UTF8')), 'hex'),
              '${ACTOR}', 'probe fixture: a tenant outside the eligibility policy' from p;
       commit;
       select 'principal=' || (:'grant_member'::jsonb ->> 'principalId');`,
      {
        tenant_a: t.tenantA,
        tenant_b: t.tenantB,
        member: t.member.userId,
        revoked: t.revoked.userId,
        other: t.otherTenant.userId,
        other_email: t.otherTenant.email,
      },
    ),
    ["principal"],
  ).principal;
}
