-- Phase 2D.1: the decision engine foundation, in SHADOW mode only.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_2D1_REPORT.md; the Phase 2C brief §22
-- and decision P record the direction):
--
--   1. ops.decision_evaluations: one durable, immutable record per evaluated
--      subject and policy version. The one subject is a lead triage human
--      review. It stores references (tenant, company, review, the run's unit),
--      a fingerprint of the allowlisted input and never the input itself, the
--      provider's DecisionVector, and the deterministic policy outcome.
--   2. ops.decision_input_for_review: the ALLOWLISTED decision input. Structured
--      enums and booleans only: no message body, reply draft, summary, free-text
--      next action, phone number, email, name, auth identity or CRM note.
--   3. ops.decision_vector_valid and ops.decision_shadow_policy: the strict
--      schema check and the deterministic Company Engine policy. The policy only
--      CLASSIFIES a vector; every outcome keeps human review required, which the
--      table enforces as a constant.
--   4. ops.request_shadow_decision: records the request once per review and
--      policy version and enqueues ONE `decision.shadow_evaluate` job on the
--      existing queue. It refuses nothing silently: a review outside the
--      synthetic and test scope is not evaluated at all (BASELINE Q8, the same
--      ops.cos_review_decidable the browser decision uses); a request under an
--      active execution stop is recorded refused, with no job (owner decision E).
--   5. The worker's three functions, each narrow:
--        * ops.request_shadow_decision_for_settled_job(worker, job): a runtime
--          step after an agent run's settlement, like
--          ops.open_review_for_settled_job;
--        * ops.start_shadow_decision and ops.settle_shadow_decision:
--          lease-bound capabilities of the new external job kind. The start
--          re-checks the scope and the stops, records `running` BEFORE the
--          provider is called, and settles an earlier attempt's `running` row
--          as indeterminate instead of calling again (at most once).
--   6. `decision.shadow_evaluate` is an EXTERNAL job kind: the one kill switch
--      holds it at the lease and again before the call, and a job_kind stop can
--      name it. ops.job_covering_stop resolves its unit from the evaluation.
--   7. get_review's projection gains `shadowDecision`, read only.
--
-- WHAT IT DELIBERATELY DOES NOT DO. Nothing here decides a review, calls
-- ops.record_review_decision, writes an outbound row, sends, touches the CRM,
-- trips or clears a stop, changes a budget, price, channel or membership,
-- widens the Q8 scope, or adds a company_os_api function: the browser still
-- has exactly its two acts. No network provider exists: the only providers are
-- the worker's deterministic fake and a Jev boundary that has no approved API
-- contract and calls nothing (engine/decision/).

-- ---------------------------------------------------------------------------
-- 1. The decision vector and the deterministic policy.
-- ---------------------------------------------------------------------------

-- The strict schema of a DecisionVector (engine/decision/decisionVector.ts
-- mirrors it). Exactly these keys, each of its pinned type and range; anything
-- else is not a vector.
create function ops.decision_vector_valid(p_vector pg_catalog.jsonb)
returns pg_catalog.bool
language plpgsql immutable security invoker set search_path = '' as $$
declare
  c_keys     constant pg_catalog.text[] := array['caution', 'confidence', 'evaluatedAt', 'inputFingerprint',
                                                 'mode', 'provider', 'reasonCodes', 'recommendation', 'version'];
  c_provider constant pg_catalog.text[] := array['id', 'kind', 'version'];
  c_name     constant pg_catalog.text := '^[a-z0-9][a-z0-9._-]{0,63}$';
  v_codes    pg_catalog.jsonb;
begin
  if p_vector is null or pg_catalog.jsonb_typeof(p_vector) <> 'object' then
    return false;
  end if;
  if (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_vector) k) is distinct from c_keys then
    return false;
  end if;
  if p_vector ->> 'version' is distinct from 'decision_vector.v1'
     or p_vector ->> 'mode' is distinct from 'shadow'
     or pg_catalog.jsonb_typeof(p_vector -> 'recommendation') is distinct from 'string'
     or p_vector ->> 'recommendation' not in ('accept', 'needs_edit', 'reject', 'abstain')
     or pg_catalog.jsonb_typeof(p_vector -> 'caution') is distinct from 'string'
     or p_vector ->> 'caution' not in ('low', 'medium', 'high')
     or pg_catalog.jsonb_typeof(p_vector -> 'confidence') is distinct from 'number'
     or (p_vector ->> 'confidence')::pg_catalog.numeric < 0
     or (p_vector ->> 'confidence')::pg_catalog.numeric > 1
     or pg_catalog.jsonb_typeof(p_vector -> 'inputFingerprint') is distinct from 'string'
     or p_vector ->> 'inputFingerprint' !~ '^sha256:[0-9a-f]{64}$'
     or pg_catalog.jsonb_typeof(p_vector -> 'evaluatedAt') is distinct from 'string'
     or p_vector ->> 'evaluatedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' then
    return false;
  end if;
  if pg_catalog.jsonb_typeof(p_vector -> 'provider') is distinct from 'object'
     or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_vector -> 'provider') k)
        is distinct from c_provider
     or p_vector #>> '{provider,kind}' not in ('fake', 'jev')
     or pg_catalog.jsonb_typeof(p_vector #> '{provider,id}') is distinct from 'string'
     or p_vector #>> '{provider,id}' !~ c_name
     or pg_catalog.jsonb_typeof(p_vector #> '{provider,version}') is distinct from 'string'
     or p_vector #>> '{provider,version}' !~ c_name then
    return false;
  end if;
  v_codes := p_vector -> 'reasonCodes';
  if pg_catalog.jsonb_typeof(v_codes) is distinct from 'array'
     or pg_catalog.jsonb_array_length(v_codes) not between 1 and 8
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_codes) c
                 where pg_catalog.jsonb_typeof(c) <> 'string' or c #>> '{}' !~ '^[a-z][a-z0-9_]{0,63}$')
     or (select count(distinct c) from pg_catalog.jsonb_array_elements_text(v_codes) c)
        <> pg_catalog.jsonb_array_length(v_codes) then
    return false;
  end if;
  return true;
exception
  -- A number too large for numeric, or any other malformed value, is not a vector.
  when others then
    return false;
end
$$;

-- The deterministic Company Engine policy of 2D.1. It CLASSIFIES a valid vector
-- and nothing else: every outcome still requires the human review, and no
-- confidence, however high, decides anything.
create function ops.decision_shadow_policy(p_vector pg_catalog.jsonb)
returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case
    when not ops.decision_vector_valid(p_vector) then null
    when p_vector ->> 'recommendation' = 'abstain' then 'abstained'
    when p_vector ->> 'caution' = 'high' then 'high_caution'
    when (p_vector ->> 'confidence')::pg_catalog.numeric < 0.6 then 'low_confidence'
    else 'recommendation_available'
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The durable record.
-- ---------------------------------------------------------------------------

create table ops.decision_evaluations (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references ops.tenants (id) on delete restrict,
  company_id        uuid not null,
  department_id     uuid not null,
  agent_id          uuid not null,
  review_item_id    uuid not null,
  subject           text not null check (subject = 'lead_triage.review'),
  trigger_source    text not null check (trigger_source in ('review.opened', 'owner.request')),
  policy_version    text not null check (policy_version = 'decision_shadow.v1'),
  idempotency_key   text not null check (char_length(idempotency_key) <= 200),
  status            text not null check (status in ('pending', 'running', 'completed', 'indeterminate',
                                                    'invalid', 'failed', 'refused')),
  refusal_code      text check (refusal_code in ('stopped', 'not_eligible')),
  job_id            uuid unique,
  provider_kind     text check (provider_kind in ('fake', 'jev', 'none')),
  provider_id       text check (provider_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  provider_version  text check (provider_version ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  input_fingerprint text check (input_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  vector            jsonb,
  policy_outcome    text check (policy_outcome in ('recommendation_available', 'low_confidence', 'high_caution',
                                                   'abstained', 'provider_indeterminate', 'provider_invalid',
                                                   'provider_failed')),
  -- The policy of 2D.1 in one column: whatever the vector says, a person decides.
  human_review_required boolean not null default true check (human_review_required),
  error_code        text check (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  settled_at        timestamptz,
  constraint decision_evaluations_key unique (tenant_id, idempotency_key),
  constraint decision_evaluations_review_key unique (tenant_id, review_item_id, policy_version),
  constraint decision_evaluations_company_fkey foreign key (tenant_id, company_id)
    references ops.companies (tenant_id, id) on delete restrict,
  constraint decision_evaluations_review_fkey foreign key (tenant_id, company_id, review_item_id)
    references ops.review_items (tenant_id, company_id, id) on delete restrict,
  constraint decision_evaluations_refused_iff_code check ((status = 'refused') = (refusal_code is not null)),
  constraint decision_evaluations_vector_iff_completed check ((status = 'completed') = (vector is not null)),
  constraint decision_evaluations_vector_valid check (vector is null or ops.decision_vector_valid(vector)),
  constraint decision_evaluations_policy_iff_settled check (
    (status in ('completed', 'indeterminate', 'invalid', 'failed')) = (policy_outcome is not null)),
  constraint decision_evaluations_policy_matches check (
    status <> 'completed' or policy_outcome = ops.decision_shadow_policy(vector)),
  constraint decision_evaluations_started check (
    (status in ('running', 'completed', 'indeterminate', 'invalid', 'failed'))
      = (started_at is not null and provider_kind is not null and input_fingerprint is not null)),
  constraint decision_evaluations_settled check (
    (status in ('completed', 'indeterminate', 'invalid', 'failed', 'refused')) = (settled_at is not null))
);

create index decision_evaluations_tenant_requested on ops.decision_evaluations (tenant_id, requested_at desc, id desc);

comment on table ops.decision_evaluations is
  'Phase 2D.1 shadow decisions: advisory only. One row per subject and policy version; references and an input fingerprint, never the input; the DecisionVector and the deterministic policy outcome. Nothing reads it to act.';

-- Identity is fixed; the lifecycle only moves forward, once:
--   pending -> running | refused (out of scope at the start); running -> completed | indeterminate | invalid | failed.
create function ops.guard_decision_evaluation_update()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id or new.department_id is distinct from old.department_id
     or new.agent_id is distinct from old.agent_id or new.review_item_id is distinct from old.review_item_id
     or new.subject is distinct from old.subject or new.trigger_source is distinct from old.trigger_source
     or new.policy_version is distinct from old.policy_version or new.idempotency_key is distinct from old.idempotency_key
     or new.requested_at is distinct from old.requested_at then
    raise exception using errcode = 'OS409',
      message = 'ops.decision_evaluations: an evaluation''s identity is never rewritten';
  end if;
  -- The job is attached once, to a pending request.
  if new.job_id is distinct from old.job_id
     and not (old.job_id is null and old.status = 'pending' and new.status = 'pending') then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: the job is attached once';
  end if;
  if old.status in ('completed', 'indeterminate', 'invalid', 'failed', 'refused') then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: a settled evaluation is history';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('running', 'refused'))
    or (old.status = 'running' and new.status in ('completed', 'indeterminate', 'invalid', 'failed'))) then
    raise exception using errcode = 'OS409',
      message = pg_catalog.format('ops.decision_evaluations: %s -> %s is not a transition', old.status, new.status);
  end if;
  -- A refusal is recorded once, by the transition that refuses.
  if new.refusal_code is distinct from old.refusal_code and not (old.status = 'pending' and new.status = 'refused') then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: a refusal is recorded once';
  end if;
  -- What was started is what is settled: the provider and the input are fixed at the start.
  if old.status = 'running' and (new.provider_kind is distinct from old.provider_kind
       or new.provider_id is distinct from old.provider_id or new.provider_version is distinct from old.provider_version
       or new.input_fingerprint is distinct from old.input_fingerprint or new.started_at is distinct from old.started_at) then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: a started evaluation keeps its provider and input';
  end if;
  return new;
end
$$;

create trigger decision_evaluations_guard_update
  before update on ops.decision_evaluations
  for each row execute function ops.guard_decision_evaluation_update();
alter table ops.decision_evaluations enable always trigger decision_evaluations_guard_update;

-- A row is born pending or refused, with nothing started or settled.
create function ops.guard_decision_evaluation_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.status not in ('pending', 'refused') or new.job_id is not null or new.started_at is not null
     or new.provider_kind is not null or new.vector is not null then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: an evaluation is born pending or refused';
  end if;
  return new;
end
$$;

create trigger decision_evaluations_guard_insert
  before insert on ops.decision_evaluations
  for each row execute function ops.guard_decision_evaluation_insert();
alter table ops.decision_evaluations enable always trigger decision_evaluations_guard_insert;

alter table ops.decision_evaluations enable row level security;
alter table ops.decision_evaluations force  row level security;

-- ---------------------------------------------------------------------------
-- 3. The allowlisted input. Structured values only, each checked against its
--    vocabulary; anything outside it is dropped, never passed on.
-- ---------------------------------------------------------------------------

create function ops.decision_input_for_review(p_tenant_id pg_catalog.uuid, p_review_item_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item   ops.review_items;
  v_result pg_catalog.jsonb;
  v_source pg_catalog.text;
begin
  select * into v_item from ops.review_items r where r.tenant_id = p_tenant_id and r.id = p_review_item_id;
  if not found or v_item.capability <> 'lead_triage' then
    return null;
  end if;
  select r.result into v_result from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.id = v_item.agent_run_id and r.status = 'succeeded';
  if v_result is null or pg_catalog.jsonb_typeof(v_result) <> 'object' then
    return null;
  end if;
  select case when i.source_kind = 'synthetic' then 'synthetic'
              when i.source_kind = 'whatsapp' and ch.mode = 'test' then 'whatsapp_test' end
    into v_source
    from ops.inbound_messages i
    left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
   where i.tenant_id = p_tenant_id and i.task_id = v_item.task_id
   limit 1;
  if v_source is null then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'version', 'decision_input.v1',
    'subject', 'lead_triage.review',
    'sourceClass', v_source,
    'contactPolicy', case when v_item.do_not_contact then 'do_not_contact' else 'contactable' end,
    'triage', pg_catalog.jsonb_build_object(
      'outcome', case when v_result ->> 'outcome' in ('triaged', 'needs_input', 'out_of_scope')
                      then v_result ->> 'outcome' end,
      'intent', case when v_result ->> 'intent' in ('book_appointment', 'pricing', 'information', 'support', 'other')
                     then v_result ->> 'intent' end,
      'priority', case when v_result ->> 'priority' in ('low', 'normal', 'high') then v_result ->> 'priority' end,
      'flags', coalesce((select pg_catalog.jsonb_agg(distinct f order by f)
                           from pg_catalog.jsonb_array_elements_text(
                                  case when pg_catalog.jsonb_typeof(v_result -> 'flags') = 'array'
                                       then v_result -> 'flags' else '[]'::pg_catalog.jsonb end) f
                          where f in ('possible_crisis', 'minor', 'out_of_scope', 'already_a_patient', 'spam', 'unclear')),
                        '[]'::pg_catalog.jsonb),
      'needsHumanReview', case when pg_catalog.jsonb_typeof(v_result -> 'needs_human_review') = 'boolean'
                               then (v_result ->> 'needs_human_review')::pg_catalog.bool end));
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The request: once per review and policy version, on the existing queue.
-- ---------------------------------------------------------------------------

create function ops.request_shadow_decision(p_tenant_id pg_catalog.uuid, p_review_item_id pg_catalog.uuid,
                                            p_trigger_source pg_catalog.text)
returns pg_catalog.uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  c_policy constant pg_catalog.text := 'decision_shadow.v1';
  v_item   ops.review_items;
  v_run    ops.agent_runs;
  v_key    pg_catalog.text;
  v_id     pg_catalog.uuid;
  v_stop   pg_catalog.uuid;
  v_job    pg_catalog.uuid;
begin
  if p_tenant_id is null or p_review_item_id is null or p_trigger_source not in ('review.opened', 'owner.request') then
    raise exception using errcode = 'OS400', message = 'ops.request_shadow_decision: bad request';
  end if;
  select * into v_item from ops.review_items r where r.tenant_id = p_tenant_id and r.id = p_review_item_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.request_shadow_decision: not found';
  end if;
  -- BASELINE Q8: only a lead triage review of a synthetic admission or a
  -- WhatsApp TEST channel is ever evaluated. Anything else is not requested at
  -- all: no row, no job, no DecisionPort.
  if v_item.capability <> 'lead_triage' or not ops.cos_review_decidable(p_tenant_id, v_item)
     or ops.decision_input_for_review(p_tenant_id, v_item.id) is null then
    return null;
  end if;

  v_key := 'review:' || v_item.id::pg_catalog.text || ':' || c_policy;
  select e.id into v_id from ops.decision_evaluations e where e.tenant_id = p_tenant_id and e.idempotency_key = v_key;
  if found then
    return v_id;
  end if;

  select * into v_run from ops.agent_runs r where r.tenant_id = p_tenant_id and r.id = v_item.agent_run_id;
  if not found then
    return null;
  end if;

  -- A request under an active stop is refused and recorded, with no job
  -- (owner decision E), serialised with tripping like every admission.
  perform pg_catalog.pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.covering_execution_stop(p_tenant_id, 'decision.shadow_evaluate',
                                        v_run.company_id, v_run.department_id, v_run.agent_id);

  insert into ops.decision_evaluations (tenant_id, company_id, department_id, agent_id, review_item_id, subject,
                                        trigger_source, policy_version, idempotency_key, status, refusal_code,
                                        settled_at)
  values (p_tenant_id, v_item.company_id, v_run.department_id, v_run.agent_id, v_item.id, 'lead_triage.review',
          p_trigger_source, c_policy, v_key,
          case when v_stop is null then 'pending' else 'refused' end,
          case when v_stop is null then null else 'stopped' end,
          case when v_stop is null then null else now() end)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    -- A concurrent request recorded it first: that one is the evaluation.
    select e.id into v_id from ops.decision_evaluations e where e.tenant_id = p_tenant_id and e.idempotency_key = v_key;
    return v_id;
  end if;
  if v_stop is not null then
    return v_id;
  end if;

  v_job := ops.enqueue_job(p_tenant_id, 'decision.shadow_evaluate',
                           pg_catalog.jsonb_build_object('decision_evaluation_id', v_id),
                           100, now(), 3, 'decision:' || v_id::pg_catalog.text);
  update ops.decision_evaluations set job_id = v_job where id = v_id;
  return v_id;
end
$$;

-- The runtime step: after an agent run's settlement commits, in a transaction
-- of its own, for the worker that completed the job (the trust model of
-- ops.open_review_for_settled_job). It names a job and a worker, nothing else.
create function ops.request_shadow_decision_for_settled_job(p_worker_id pg_catalog.text, p_job_id pg_catalog.uuid)
returns pg_catalog.uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job    ops.jobs;
  v_review pg_catalog.uuid;
begin
  if p_worker_id is null or pg_catalog.btrim(p_worker_id) = '' or p_job_id is null then
    raise exception using errcode = 'OS400',
      message = 'ops.request_shadow_decision_for_settled_job requires a worker id and a job id';
  end if;
  select j.* into v_job from ops.jobs j
   where j.id = p_job_id and j.kind = 'agent_run.execute' and j.status = 'succeeded';
  if not found then
    return null;
  end if;
  if not exists (select 1 from ops.job_events e
                  where e.job_id = v_job.id and e.tenant_id = v_job.tenant_id
                    and e.event = 'succeeded' and e.worker_id = p_worker_id) then
    raise exception using errcode = 'OS403',
      message = 'ops.request_shadow_decision_for_settled_job: that job was not completed by this worker';
  end if;
  select ri.id into v_review
    from ops.agent_runs r join ops.review_items ri on ri.tenant_id = r.tenant_id and ri.agent_run_id = r.id
   where r.tenant_id = v_job.tenant_id and r.job_id = v_job.id;
  if v_review is null then
    return null;
  end if;
  return ops.request_shadow_decision(v_job.tenant_id, v_review, 'review.opened');
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The job kind's two capabilities. Lease-bound: they take no tenant and
--    reach only the evaluation of the leased job.
-- ---------------------------------------------------------------------------

create function ops.start_shadow_decision(p_provider_kind pg_catalog.text, p_provider_id pg_catalog.text,
                                          p_provider_version pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job   ops.jobs := ops.leased_job();
  v_eval  ops.decision_evaluations;
  v_item  ops.review_items;
  v_input pg_catalog.jsonb;
  v_print pg_catalog.text;
begin
  if p_provider_kind is null or p_provider_kind not in ('fake', 'jev', 'none')
     or p_provider_id is null or p_provider_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or p_provider_version is null or p_provider_version !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception using errcode = 'OS400', message = 'ops.start_shadow_decision: bad provider identity';
  end if;
  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = v_job.tenant_id and e.job_id = v_job.id
     for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  -- An earlier attempt recorded the start and never settled: the provider may
  -- have answered. It is not called again.
  if v_eval.status = 'running' then
    update ops.decision_evaluations
       set status = 'indeterminate', policy_outcome = 'provider_indeterminate',
           error_code = 'attempt_interrupted', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'indeterminate', 'evaluationId', v_eval.id);
  end if;
  if v_eval.status <> 'pending' then
    return pg_catalog.jsonb_build_object('status', v_eval.status, 'evaluationId', v_eval.id);
  end if;

  -- The scope again, at the moment of acting (BASELINE Q8).
  select * into v_item from ops.review_items r where r.tenant_id = v_eval.tenant_id and r.id = v_eval.review_item_id;
  v_input := ops.decision_input_for_review(v_eval.tenant_id, v_eval.review_item_id);
  if not ops.cos_review_decidable(v_eval.tenant_id, v_item) or v_input is null then
    update ops.decision_evaluations
       set status = 'refused', refusal_code = 'not_eligible', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'refused', 'evaluationId', v_eval.id);
  end if;

  -- A stop tripped since the lease holds the job: nothing is recorded, and the
  -- runtime defers it with its attempt given back (owner decision B).
  perform pg_catalog.pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.covering_execution_stop(v_eval.tenant_id, v_job.kind, v_eval.company_id, v_eval.department_id,
                                 v_eval.agent_id) is not null then
    return pg_catalog.jsonb_build_object('status', 'stopped', 'evaluationId', v_eval.id);
  end if;

  v_print := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_input::pg_catalog.text, 'UTF8')), 'hex');
  update ops.decision_evaluations
     set status = 'running', started_at = now(), provider_kind = p_provider_kind,
         provider_id = p_provider_id, provider_version = p_provider_version, input_fingerprint = v_print
   where id = v_eval.id;
  return pg_catalog.jsonb_build_object('status', 'running', 'evaluationId', v_eval.id,
                                       'inputFingerprint', v_print, 'input', v_input);
end
$$;

-- The settlement. A `completed` vector is validated here again, against the
-- schema and against what was started (the provider and the input's
-- fingerprint); one that fails is stored as `invalid`, never coerced.
create function ops.settle_shadow_decision(p_outcome pg_catalog.text, p_vector pg_catalog.jsonb,
                                           p_error_code pg_catalog.text)
returns pg_catalog.text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job  ops.jobs := ops.leased_job();
  v_eval ops.decision_evaluations;
begin
  if p_outcome is null or p_outcome not in ('completed', 'indeterminate', 'invalid', 'failed')
     or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
     or (p_outcome = 'completed') <> (p_vector is not null) then
    raise exception using errcode = 'OS400', message = 'ops.settle_shadow_decision: bad settlement';
  end if;
  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = v_job.tenant_id and e.job_id = v_job.id
     for update;
  if not found or v_eval.status <> 'running' then
    return 'not_running';
  end if;

  if p_outcome = 'completed' then
    if not ops.decision_vector_valid(p_vector)
       or p_vector #>> '{provider,kind}' is distinct from v_eval.provider_kind
       or p_vector #>> '{provider,id}' is distinct from v_eval.provider_id
       or p_vector #>> '{provider,version}' is distinct from v_eval.provider_version
       or p_vector ->> 'inputFingerprint' is distinct from v_eval.input_fingerprint then
      update ops.decision_evaluations
         set status = 'invalid', policy_outcome = 'provider_invalid', error_code = 'vector_rejected', settled_at = now()
       where id = v_eval.id;
      return 'invalid';
    end if;
    update ops.decision_evaluations
       set status = 'completed', vector = p_vector, policy_outcome = ops.decision_shadow_policy(p_vector),
           settled_at = now()
     where id = v_eval.id;
    return 'completed';
  end if;

  update ops.decision_evaluations
     set status = p_outcome,
         policy_outcome = case p_outcome when 'indeterminate' then 'provider_indeterminate'
                                         when 'invalid' then 'provider_invalid'
                                         else 'provider_failed' end,
         error_code = p_error_code, settled_at = now()
   where id = v_eval.id;
  return p_outcome;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. The kind, and the stop that covers one of its jobs.
-- ---------------------------------------------------------------------------

create or replace function ops.external_job_kinds()
returns text[]
language sql immutable set search_path = '' as $$
  select array['agent_run.execute', 'decision.shadow_evaluate']::text[];
$$;

create or replace function ops.job_covering_stop(p_tenant_id uuid, p_job_id uuid, p_job_kind text)
returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_company    uuid;
  v_department uuid;
  v_agent      uuid;
begin
  if p_job_kind = any (ops.internal_job_kinds()) then
    return null; -- administration stays up: the switch never holds maintenance
  end if;
  select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.job_id = p_job_id;
  if not found then
    -- A shadow decision is held by the stops of the unit whose run it evaluates.
    select d.company_id, d.department_id, d.agent_id into v_company, v_department, v_agent
      from ops.decision_evaluations d
     where d.tenant_id = p_tenant_id and d.job_id = p_job_id;
  end if;
  if not found then
    select l.company_id into v_company
      from ops.task_jobs l
     where l.tenant_id = p_tenant_id and l.job_id = p_job_id;
  end if;
  return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. get_review: the shadow decision, read only and minimised. `null` when the
--    review is in scope and nothing was requested; `unavailable` when it is out
--    of the synthetic and test scope. No input, fingerprint, job or error text.
-- ---------------------------------------------------------------------------

create function ops.cos_review_shadow_decision(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_eval ops.decision_evaluations;
begin
  if p_item.capability <> 'lead_triage' or not ops.cos_review_decidable(p_tenant_id, p_item) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = p_tenant_id and e.review_item_id = p_item.id and e.policy_version = 'decision_shadow.v1';
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'status', case when v_eval.status = 'running' then 'pending' else v_eval.status end,
    'mode', 'shadow',
    'recommendation', v_eval.vector ->> 'recommendation',
    'confidence', v_eval.vector -> 'confidence',
    'caution', v_eval.vector ->> 'caution',
    'reasonCodes', coalesce(v_eval.vector -> 'reasonCodes', '[]'::pg_catalog.jsonb),
    'policy', pg_catalog.jsonb_build_object('outcome', v_eval.policy_outcome,
                                            'humanReviewRequired', v_eval.human_review_required),
    'provider', case when v_eval.provider_kind is null then null
                     else pg_catalog.jsonb_build_object('kind', v_eval.provider_kind, 'id', v_eval.provider_id,
                                                        'version', v_eval.provider_version) end,
    'refusal', v_eval.refusal_code,
    'requestedAt', ops.cos_ts(v_eval.requested_at),
    'settledAt', ops.cos_ts(v_eval.settled_at));
end
$$;

create or replace function ops.read_review_detail(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()))
    || ops.cos_review_summary(p_tenant_id, v_item)
    || pg_catalog.jsonb_build_object(
      'decisionNote', v_item.decision_note,
      'allowedDecisions', case when v_item.status <> 'pending' or not ops.cos_review_decidable(p_tenant_id, v_item)
                                 then '[]'::pg_catalog.jsonb
                               when v_item.do_not_contact then '["rejected", "needs_edit"]'::pg_catalog.jsonb
                               else '["accepted", "rejected", "needs_edit"]'::pg_catalog.jsonb end,
      -- Phase 2D.1: advisory only. Nothing about it changes allowedDecisions.
      'shadowDecision', ops.cos_review_shadow_decision(p_tenant_id, v_item));
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Access. Backend only; the worker reaches the table only through its
--    three functions. ops_operator_api is never named here (the static guard
--    reserves its ACL to the OD-8a files): new objects give it nothing, and the
--    end state below asserts so.
-- ---------------------------------------------------------------------------

revoke all on table ops.decision_evaluations
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.decision_vector_valid(pg_catalog.jsonb),
  ops.decision_shadow_policy(pg_catalog.jsonb),
  ops.guard_decision_evaluation_update(),
  ops.guard_decision_evaluation_insert(),
  ops.decision_input_for_review(pg_catalog.uuid, pg_catalog.uuid),
  ops.request_shadow_decision(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text),
  ops.request_shadow_decision_for_settled_job(pg_catalog.text, pg_catalog.uuid),
  ops.start_shadow_decision(pg_catalog.text, pg_catalog.text, pg_catalog.text),
  ops.settle_shadow_decision(pg_catalog.text, pg_catalog.jsonb, pg_catalog.text),
  ops.cos_review_shadow_decision(pg_catalog.uuid, ops.review_items)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

grant execute on function
  ops.request_shadow_decision_for_settled_job(pg_catalog.text, pg_catalog.uuid),
  ops.start_shadow_decision(pg_catalog.text, pg_catalog.text, pg_catalog.text),
  ops.settle_shadow_decision(pg_catalog.text, pg_catalog.jsonb, pg_catalog.text)
  to ops_worker;

-- ---------------------------------------------------------------------------
-- 9. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_decision_fns constant pg_catalog.text[] := array[
    'decision_vector_valid', 'decision_shadow_policy', 'decision_input_for_review', 'request_shadow_decision',
    'request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision',
    'cos_review_shadow_decision', 'guard_decision_evaluation_update', 'guard_decision_evaluation_insert'];
begin
  if not (select c.relrowsecurity and c.relforcerowsecurity from pg_catalog.pg_class c
           where c.oid = 'ops.decision_evaluations'::pg_catalog.regclass) then
    raise exception 'ops.decision_evaluations lacks ENABLE + FORCE row level security';
  end if;
  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.decision_evaluations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on ops.decision_evaluations: %', v_bad;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
       where t.tgrelid = 'ops.decision_evaluations'::pg_catalog.regclass and not t.tgisinternal and t.tgenabled = 'A') <> 2 then
    raise exception 'ops.decision_evaluations guard triggers are not both ENABLE ALWAYS';
  end if;
  if ops.external_job_kinds() is distinct from array['agent_run.execute', 'decision.shadow_evaluate']::pg_catalog.text[]
     or 'decision.shadow_evaluate' = any (ops.task_executable_kinds()) then
    raise exception 'the shadow decision kind is not exactly an external, non-task kind';
  end if;

  -- Exactly the three worker functions; nothing else of the decision layer is
  -- executable by any application or capability role.
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_decision_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker'
              and p.proname in ('request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision'));
  if v_bad is not null then
    raise exception 'a role can execute a decision function it must not: %', v_bad;
  end if;

  -- ADVISORY ONLY: no decision function names a review decision, a send, an
  -- outbound row, the CRM, a stop act, a budget, a price, a channel or a
  -- membership, or runs dynamic SQL.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_decision_fns)
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp_send|send_|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels\s+set|grant_membership|revoke_membership|execute\s|review_items\s+set|update\s+ops\.review_items)';
  if v_bad is not null then
    raise exception 'a decision function reaches beyond advice: %', v_bad;
  end if;
end
$end_state$;
