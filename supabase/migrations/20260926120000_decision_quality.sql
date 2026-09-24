-- Phase 2D.2 + 2D.3: decision quality, recovery and calibration (shadow mode).
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_2D23_REPORT.md):
--
--   1. ops.decision_policies: an immutable, versioned registry of shadow
--      decision policies. `decision_shadow.v1` (Phase 2D.1) is recorded and
--      RETIRED; `decision_shadow.v2` is current. A policy's meaning never
--      changes: a new meaning is a new version (a new row, and a new branch in
--      ops.decision_policy_outcome, never an edit of an old one).
--   2. A closed reason-code vocabulary, `lead_triage_reasons.v1`, and
--      `decision_vector.v2`, whose reason codes must come from it. v1 vectors
--      stay valid as history (the pattern check they were stored under), and
--      only a policy whose vector version is v2 accepts new ones.
--   3. Every evaluation keeps its exact policy version (now a foreign key to
--      the registry), its outcome is checked against THAT version's policy, and
--      a vector's version must match its policy's. Idempotency stays per
--      (review, policy version): a new version is a new evaluation, and a
--      completed one is never rewritten.
--   4. ops.recover_shadow_decision: the owner's narrow repair. It creates a
--      missing request, or attaches a job to a request that has none (or whose
--      job ended without starting it). It never touches an evaluation that was
--      started: one under a live lease is in progress, any other running or
--      indeterminate one is reported for a person, never re-asked; a settled
--      one is reported complete. It honours the scope (BASELINE Q8) and the
--      stops: a new request under a stop is recorded refused (owner decision
--      E), and a pending one is left untouched until the stop is cleared.
--   5. ops.cos_decision_intelligence: neutral, aggregate calibration counts per
--      policy and provider version (agreement, never "accuracy"), returned in
--      the overview projection. Counts only: no id, name, text or input.
--   6. get_review's shadowDecision gains its policy version.
--
-- WHAT IT DELIBERATELY DOES NOT DO: decide a review, send, write the CRM, trip
-- or clear a stop, change money, channels or memberships, widen the Q8 scope,
-- rewrite a stored evaluation, or add a company_os_api function (the browser
-- still has exactly its two acts). No provider is connected: Jev stays an
-- unconnected boundary.

-- ---------------------------------------------------------------------------
-- 1. The closed reason-code vocabulary and the vector check.
-- ---------------------------------------------------------------------------

-- lead_triage_reasons.v1: the only codes a decision_vector.v2 may carry.
create function ops.lead_triage_reason_codes_v1()
returns pg_catalog.text[]
language sql immutable security invoker set search_path = '' as $$
  select array['triage_complete', 'intent_book_appointment', 'intent_pricing', 'intent_information',
               'flag_possible_crisis', 'flag_minor', 'flag_spam', 'contact_do_not_contact',
               'outcome_out_of_scope', 'outcome_needs_input', 'insufficient_signal']::pg_catalog.text[];
$$;

-- v1 (history, the pattern it was stored under) and v2 (the closed vocabulary).
-- Everything else about the two versions is the same strict shape.
create or replace function ops.decision_vector_valid(p_vector pg_catalog.jsonb)
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
  if p_vector ->> 'version' not in ('decision_vector.v1', 'decision_vector.v2')
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
  -- v2: every code from the closed vocabulary.
  if p_vector ->> 'version' = 'decision_vector.v2'
     and exists (select 1 from pg_catalog.jsonb_array_elements_text(v_codes) c
                  where c <> all (ops.lead_triage_reason_codes_v1())) then
    return false;
  end if;
  return true;
exception
  when others then
    return false;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. The policy registry, and each version's fixed meaning.
-- ---------------------------------------------------------------------------

-- The vector version a policy version accepts. Fixed per version.
create function ops.decision_policy_vector_version(p_policy_version pg_catalog.text)
returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case p_policy_version
    when 'decision_shadow.v1' then 'decision_vector.v1'
    when 'decision_shadow.v2' then 'decision_vector.v2'
  end;
$$;

create table ops.decision_policies (
  version           text primary key check (version ~ '^decision_shadow\.v[0-9]+$'),
  vector_version    text not null check (vector_version in ('decision_vector.v1', 'decision_vector.v2')),
  reason_vocabulary text check (reason_vocabulary in ('lead_triage_reasons.v1')),
  description       text not null check (char_length(description) between 1 and 500),
  created_at        timestamptz not null default now(),
  retired_at        timestamptz,
  -- The registry and the executable meaning agree, row by row.
  constraint decision_policies_vector_version_fixed
    check (vector_version is not distinct from ops.decision_policy_vector_version(version))
);

-- Exactly one current policy.
create unique index decision_policies_one_current on ops.decision_policies ((true)) where retired_at is null;

comment on table ops.decision_policies is
  'Phase 2D.2: the versioned shadow decision policies. Immutable: a version never changes meaning; retiring one is recorded once. Its executable meaning is ops.decision_policy_outcome.';

create function ops.guard_decision_policy_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS409', message = 'ops.decision_policies: a policy version is never deleted';
  end if;
  if new.version is distinct from old.version or new.vector_version is distinct from old.vector_version
     or new.reason_vocabulary is distinct from old.reason_vocabulary or new.description is distinct from old.description
     or new.created_at is distinct from old.created_at
     or (old.retired_at is not null and new.retired_at is distinct from old.retired_at) then
    raise exception using errcode = 'OS409',
      message = 'ops.decision_policies: a policy version is immutable; it is only retired, once';
  end if;
  return new;
end
$$;

create trigger decision_policies_guard_change
  before update or delete on ops.decision_policies
  for each row execute function ops.guard_decision_policy_change();
alter table ops.decision_policies enable always trigger decision_policies_guard_change;

create function ops.refuse_decision_policy_truncate()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'OS409', message = 'ops.decision_policies: the policy registry is never truncated';
end
$$;

create trigger decision_policies_refuse_truncate
  before truncate on ops.decision_policies
  for each statement execute function ops.refuse_decision_policy_truncate();
alter table ops.decision_policies enable always trigger decision_policies_refuse_truncate;

alter table ops.decision_policies enable row level security;
alter table ops.decision_policies force  row level security;

insert into ops.decision_policies (version, vector_version, reason_vocabulary, description, retired_at) values
  ('decision_shadow.v1', 'decision_vector.v1', null,
   'Phase 2D.1: advisory only; classifies a vector as abstained, high_caution, low_confidence (below 0.6) or recommendation_available; human review always required. Reason codes by pattern only.',
   now()),
  ('decision_shadow.v2', 'decision_vector.v2', 'lead_triage_reasons.v1',
   'Phase 2D.2: the v1 classification unchanged, over vectors whose reason codes come from the closed vocabulary lead_triage_reasons.v1; human review always required.',
   null);

-- Each version's executable meaning. A new version adds a branch; an existing
-- branch is never edited, so a stored outcome keeps its meaning.
create function ops.decision_policy_outcome(p_policy_version pg_catalog.text, p_vector pg_catalog.jsonb)
returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case
    when p_policy_version not in ('decision_shadow.v1', 'decision_shadow.v2') then null
    when not ops.decision_vector_valid(p_vector) then null
    when p_vector ->> 'version' is distinct from ops.decision_policy_vector_version(p_policy_version) then null
    -- v1 and v2 classify identically; v2 only narrows what a vector may say.
    when p_vector ->> 'recommendation' = 'abstain' then 'abstained'
    when p_vector ->> 'caution' = 'high' then 'high_caution'
    when (p_vector ->> 'confidence')::pg_catalog.numeric < 0.6 then 'low_confidence'
    else 'recommendation_available'
  end;
$$;

-- The Phase 2D.1 policy function keeps its v1 meaning exactly: now that the
-- vector check also accepts v2, it delegates to the v1 branch, so a v2 vector
-- is not a v1 classification.
create or replace function ops.decision_shadow_policy(p_vector pg_catalog.jsonb)
returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select ops.decision_policy_outcome('decision_shadow.v1', p_vector);
$$;

-- The current version: the one registry row not retired.
create function ops.current_shadow_policy_version()
returns pg_catalog.text
language sql stable security invoker set search_path = '' as $$
  select p.version from ops.decision_policies p where p.retired_at is null;
$$;

-- ---------------------------------------------------------------------------
-- 3. Evaluations keep their exact version, checked against it.
-- ---------------------------------------------------------------------------

alter table ops.decision_evaluations drop constraint decision_evaluations_policy_version_check;
alter table ops.decision_evaluations
  add constraint decision_evaluations_policy_fkey foreign key (policy_version)
    references ops.decision_policies (version) on delete restrict;
alter table ops.decision_evaluations drop constraint decision_evaluations_policy_matches;
alter table ops.decision_evaluations
  add constraint decision_evaluations_policy_matches check (
    status <> 'completed' or policy_outcome is not distinct from ops.decision_policy_outcome(policy_version, vector));
alter table ops.decision_evaluations
  add constraint decision_evaluations_vector_matches_policy check (
    vector is null or vector ->> 'version' = ops.decision_policy_vector_version(policy_version));
alter table ops.decision_evaluations drop constraint decision_evaluations_trigger_source_check;
alter table ops.decision_evaluations
  add constraint decision_evaluations_trigger_source_check
    check (trigger_source in ('review.opened', 'owner.request', 'operator.recover'));
alter table ops.decision_evaluations drop constraint decision_evaluations_refusal_code_check;
alter table ops.decision_evaluations
  add constraint decision_evaluations_refusal_code_check
    check (refusal_code in ('stopped', 'not_eligible', 'policy_retired'));

create index decision_evaluations_tenant_policy on ops.decision_evaluations (tenant_id, policy_version);

-- The job of a request that was never started may be replaced (recovery, which
-- does so only once that job has ended). Nothing else about the guard changes.
create or replace function ops.guard_decision_evaluation_update()
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
  -- A job is attached to, or replaced on, a request that was never started.
  if new.job_id is distinct from old.job_id
     and not (old.status = 'pending' and new.status = 'pending' and new.job_id is not null) then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: only a request that was never started takes a job';
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
  if new.refusal_code is distinct from old.refusal_code and not (old.status = 'pending' and new.status = 'refused') then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: a refusal is recorded once';
  end if;
  if old.status = 'running' and (new.provider_kind is distinct from old.provider_kind
       or new.provider_id is distinct from old.provider_id or new.provider_version is distinct from old.provider_version
       or new.input_fingerprint is distinct from old.input_fingerprint or new.started_at is distinct from old.started_at) then
    raise exception using errcode = 'OS409', message = 'ops.decision_evaluations: a started evaluation keeps its provider and input';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The request, the start and the settlement follow the current version.
-- ---------------------------------------------------------------------------

create or replace function ops.request_shadow_decision(p_tenant_id pg_catalog.uuid, p_review_item_id pg_catalog.uuid,
                                                       p_trigger_source pg_catalog.text)
returns pg_catalog.uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_policy pg_catalog.text := ops.current_shadow_policy_version();
  v_item   ops.review_items;
  v_run    ops.agent_runs;
  v_key    pg_catalog.text;
  v_id     pg_catalog.uuid;
  v_stop   pg_catalog.uuid;
  v_job    pg_catalog.uuid;
begin
  if p_tenant_id is null or p_review_item_id is null
     or p_trigger_source not in ('review.opened', 'owner.request', 'operator.recover') then
    raise exception using errcode = 'OS400', message = 'ops.request_shadow_decision: bad request';
  end if;
  if v_policy is null then
    raise exception using errcode = 'OS500', message = 'ops.request_shadow_decision: no current policy';
  end if;
  select * into v_item from ops.review_items r where r.tenant_id = p_tenant_id and r.id = p_review_item_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.request_shadow_decision: not found';
  end if;
  -- BASELINE Q8: only a lead triage review of a synthetic admission or a
  -- WhatsApp TEST channel is ever evaluated. Anything else is not requested.
  if v_item.capability <> 'lead_triage' or not ops.cos_review_decidable(p_tenant_id, v_item)
     or ops.decision_input_for_review(p_tenant_id, v_item.id) is null then
    return null;
  end if;

  v_key := 'review:' || v_item.id::pg_catalog.text || ':' || v_policy;
  select e.id into v_id from ops.decision_evaluations e where e.tenant_id = p_tenant_id and e.idempotency_key = v_key;
  if found then
    return v_id;
  end if;

  select * into v_run from ops.agent_runs r where r.tenant_id = p_tenant_id and r.id = v_item.agent_run_id;
  if not found then
    return null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.covering_execution_stop(p_tenant_id, 'decision.shadow_evaluate',
                                        v_run.company_id, v_run.department_id, v_run.agent_id);

  insert into ops.decision_evaluations (tenant_id, company_id, department_id, agent_id, review_item_id, subject,
                                        trigger_source, policy_version, idempotency_key, status, refusal_code,
                                        settled_at)
  values (p_tenant_id, v_item.company_id, v_run.department_id, v_run.agent_id, v_item.id, 'lead_triage.review',
          p_trigger_source, v_policy, v_key,
          case when v_stop is null then 'pending' else 'refused' end,
          case when v_stop is null then null else 'stopped' end,
          case when v_stop is null then null else now() end)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
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

create or replace function ops.start_shadow_decision(p_provider_kind pg_catalog.text, p_provider_id pg_catalog.text,
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

  -- A request made under a policy since retired is not evaluated under it.
  if exists (select 1 from ops.decision_policies p where p.version = v_eval.policy_version and p.retired_at is not null) then
    update ops.decision_evaluations
       set status = 'refused', refusal_code = 'policy_retired', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'refused', 'evaluationId', v_eval.id);
  end if;

  select * into v_item from ops.review_items r where r.tenant_id = v_eval.tenant_id and r.id = v_eval.review_item_id;
  v_input := ops.decision_input_for_review(v_eval.tenant_id, v_eval.review_item_id);
  if not ops.cos_review_decidable(v_eval.tenant_id, v_item) or v_input is null then
    update ops.decision_evaluations
       set status = 'refused', refusal_code = 'not_eligible', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'refused', 'evaluationId', v_eval.id);
  end if;

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
                                       'policyVersion', v_eval.policy_version,
                                       'vectorVersion', ops.decision_policy_vector_version(v_eval.policy_version),
                                       'inputFingerprint', v_print, 'input', v_input);
end
$$;

create or replace function ops.settle_shadow_decision(p_outcome pg_catalog.text, p_vector pg_catalog.jsonb,
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
    -- The evaluation's own policy decides what a valid answer is.
    if ops.decision_policy_outcome(v_eval.policy_version, p_vector) is null
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
       set status = 'completed', vector = p_vector,
           policy_outcome = ops.decision_policy_outcome(v_eval.policy_version, p_vector), settled_at = now()
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
-- 5. Recovery: the owner's narrow repair of a request that never ran.
-- ---------------------------------------------------------------------------

create function ops.recover_shadow_decision(p_tenant_id pg_catalog.uuid, p_review_item_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_policy pg_catalog.text := ops.current_shadow_policy_version();
  v_item   ops.review_items;
  v_eval   ops.decision_evaluations;
  v_job    ops.jobs;
  v_new    pg_catalog.uuid;
  v_id     pg_catalog.uuid;
  v_n      pg_catalog.int8;
begin
  if p_tenant_id is null or p_review_item_id is null then
    raise exception using errcode = 'OS400', message = 'ops.recover_shadow_decision: bad request';
  end if;
  select * into v_item from ops.review_items r where r.tenant_id = p_tenant_id and r.id = p_review_item_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.recover_shadow_decision: not found';
  end if;
  if v_item.capability <> 'lead_triage' or not ops.cos_review_decidable(p_tenant_id, v_item)
     or ops.decision_input_for_review(p_tenant_id, v_item.id) is null then
    return pg_catalog.jsonb_build_object('outcome', 'not_eligible');
  end if;

  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = p_tenant_id and e.review_item_id = v_item.id and e.policy_version = v_policy
     for update;
  if not found then
    v_id := ops.request_shadow_decision(p_tenant_id, v_item.id, 'operator.recover');
    select * into v_eval from ops.decision_evaluations e where e.id = v_id;
    return pg_catalog.jsonb_build_object(
      'outcome', case when v_eval.status = 'refused' then 'stopped' else 'created' end,
      'evaluationId', v_id);
  end if;

  if v_eval.job_id is not null then
    select * into v_job from ops.jobs j where j.tenant_id = p_tenant_id and j.id = v_eval.job_id;
  end if;

  -- Started or settled: never asked again, never rewritten. A start whose
  -- lease is still live is simply in progress; any other started one may have
  -- reached the provider, so a person looks at it.
  if v_eval.status = 'running' and v_job.status = 'leased' and v_job.lease_expires_at > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('outcome', 'in_progress', 'evaluationId', v_eval.id);
  end if;
  if v_eval.status in ('running', 'indeterminate') then
    return pg_catalog.jsonb_build_object('outcome', 'indeterminate_requires_human_operator', 'evaluationId', v_eval.id);
  end if;
  if v_eval.status <> 'pending' then
    return pg_catalog.jsonb_build_object('outcome', 'already_complete', 'evaluationId', v_eval.id);
  end if;

  -- Pending: never started, so the provider was never asked.
  if v_job.status in ('queued', 'leased') then
    return pg_catalog.jsonb_build_object('outcome', 'in_progress', 'evaluationId', v_eval.id);
  end if;
  -- Under an active stop nothing is enqueued and nothing is recorded: the
  -- request stays pending, to be repaired after a person clears the stop.
  perform pg_catalog.pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.covering_execution_stop(p_tenant_id, 'decision.shadow_evaluate', v_eval.company_id, v_eval.department_id,
                                 v_eval.agent_id) is not null then
    return pg_catalog.jsonb_build_object('outcome', 'stopped', 'evaluationId', v_eval.id);
  end if;
  select count(*) into v_n from ops.jobs j
   where j.tenant_id = p_tenant_id and j.kind = 'decision.shadow_evaluate'
     and j.payload ->> 'decision_evaluation_id' = v_eval.id::pg_catalog.text;
  v_new := ops.enqueue_job(p_tenant_id, 'decision.shadow_evaluate',
                           pg_catalog.jsonb_build_object('decision_evaluation_id', v_eval.id),
                           100, now(), 3,
                           'decision:' || v_eval.id::pg_catalog.text || case when v_n = 0 then '' else ':' || v_n::pg_catalog.text end);
  update ops.decision_evaluations set job_id = v_new where id = v_eval.id;
  return pg_catalog.jsonb_build_object('outcome', 'repaired', 'evaluationId', v_eval.id);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Calibration: neutral counts, per policy and provider version.
-- ---------------------------------------------------------------------------

-- AGREEMENT, never accuracy: a human decision is not ground truth. Counts only:
-- no id, name, text, input, reason or time.
create function ops.cos_decision_intelligence(p_tenant_id pg_catalog.uuid)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  with e as (
    select d.policy_version, d.provider_kind, d.provider_id, d.provider_version, d.status,
           d.vector ->> 'recommendation' as recommendation, r.status as human
      from ops.decision_evaluations d
      join ops.review_items r on r.tenant_id = d.tenant_id and r.id = d.review_item_id
     where d.tenant_id = p_tenant_id
  ),
  g as (
    select e.policy_version, e.provider_kind, e.provider_id, e.provider_version,
           count(*) as evaluations,
           count(*) filter (where e.status = 'completed' and e.recommendation <> 'abstain') as recommendations,
           count(*) filter (where e.status = 'completed' and e.recommendation = 'abstain') as abstained,
           count(*) filter (where e.status in ('pending', 'running')) as pending,
           count(*) filter (where e.status = 'indeterminate') as indeterminate,
           count(*) filter (where e.status = 'invalid') as invalid,
           count(*) filter (where e.status = 'failed') as failed,
           count(*) filter (where e.status = 'refused') as refused,
           count(*) filter (where e.human <> 'pending') as with_human_decision,
           count(*) filter (where e.status = 'completed' and e.recommendation <> 'abstain' and e.human <> 'pending') as comparable,
           count(*) filter (where e.status = 'completed' and e.human <> 'pending'
                              and ((e.recommendation = 'accept' and e.human = 'accepted')
                                or (e.recommendation = 'reject' and e.human = 'rejected')
                                or (e.recommendation = 'needs_edit' and e.human = 'needs_edit'))) as agreements,
           count(*) filter (where e.status = 'completed' and e.recommendation = 'accept') as rec_accept,
           count(*) filter (where e.status = 'completed' and e.recommendation = 'needs_edit') as rec_needs_edit,
           count(*) filter (where e.status = 'completed' and e.recommendation = 'reject') as rec_reject,
           count(*) filter (where e.status = 'completed' and e.recommendation = 'abstain') as rec_abstain,
           count(*) filter (where e.human = 'pending') as human_pending,
           count(*) filter (where e.human = 'accepted') as human_accepted,
           count(*) filter (where e.human = 'rejected') as human_rejected,
           count(*) filter (where e.human = 'needs_edit') as human_needs_edit
      from e
     group by e.policy_version, e.provider_kind, e.provider_id, e.provider_version
  )
  select pg_catalog.jsonb_build_object(
    'mode', 'shadow',
    'currentPolicyVersion', ops.current_shadow_policy_version(),
    'groups', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'policyVersion', g.policy_version,
      'provider', case when g.provider_kind is null then null
                       else pg_catalog.jsonb_build_object('kind', g.provider_kind, 'id', g.provider_id,
                                                          'version', g.provider_version) end,
      'evaluations', g.evaluations, 'recommendations', g.recommendations, 'abstained', g.abstained,
      'pending', g.pending, 'indeterminate', g.indeterminate, 'invalid', g.invalid, 'failed', g.failed,
      'refused', g.refused, 'withHumanDecision', g.with_human_decision, 'comparable', g.comparable,
      'agreements', g.agreements, 'disagreements', g.comparable - g.agreements,
      'byRecommendation', pg_catalog.jsonb_build_object('accept', g.rec_accept, 'needs_edit', g.rec_needs_edit,
                                                        'reject', g.rec_reject, 'abstain', g.rec_abstain),
      'byHumanOutcome', pg_catalog.jsonb_build_object('pending', g.human_pending, 'accepted', g.human_accepted,
                                                      'rejected', g.human_rejected, 'needs_edit', g.human_needs_edit))
      order by g.policy_version desc, g.provider_kind nulls last, g.provider_id, g.provider_version), '[]'::pg_catalog.jsonb))
    from g;
$$;

-- The overview gains the calibration section; nothing else in it changes.
create or replace function ops.read_overview(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of  pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_today  pg_catalog.timestamptz := ops.cos_today_start(p_tenant_id);
  -- Every agent, not list_agents' first 500: the counts are exact.
  v_agents pg_catalog.jsonb := ops.agent_operational_state(p_tenant_id, null, true) -> 'items';
begin
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(v_as_of),
    'agents', pg_catalog.jsonb_build_object(
      'total', pg_catalog.jsonb_array_length(v_agents),
      'working', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'working'),
      'held', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'held'),
      'queued', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'queued'),
      'stale', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'stale'),
      'stopped', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'availability' = 'stopped'),
      'inactive', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'availability' = 'inactive')),
    'runs', pg_catalog.jsonb_build_object(
      'todayByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                   from (select r.status, count(*) as n from ops.agent_runs r
                                          where r.tenant_id = p_tenant_id and r.created_at >= v_today group by r.status) s),
                                '{}'::pg_catalog.jsonb),
      'workingNow', (select count(*) from ops.agent_runs r join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
                      where r.tenant_id = p_tenant_id and r.status = 'running' and j.status = 'leased'
                        and j.lease_expires_at > v_as_of and j.attempts = r.job_attempt),
      'needingAttention', (select count(*) from ops.agent_runs r
                            where r.tenant_id = p_tenant_id
                              and ((r.status = 'indeterminate'
                                    and not exists (select 1 from ops.agent_runs x where x.tenant_id = p_tenant_id and x.retry_of_run_id = r.id))
                                   or (r.status = 'running'
                                       and not exists (select 1 from ops.jobs j where j.tenant_id = p_tenant_id and j.id = r.job_id
                                                          and j.status = 'leased' and j.lease_expires_at > v_as_of
                                                          and j.attempts = r.job_attempt))))),
    'reviews', pg_catalog.jsonb_build_object(
      'pending', (select count(*) from ops.review_items v where v.tenant_id = p_tenant_id and v.status = 'pending'),
      'oldestPendingAt', ops.cos_ts((select min(v.created_at) from ops.review_items v where v.tenant_id = p_tenant_id and v.status = 'pending'))),
    'stops', pg_catalog.jsonb_build_object(
      'tenantScopedActive', (select count(*) from ops.execution_stops s where s.tenant_id = p_tenant_id and s.cleared_at is null)),
    'admission', pg_catalog.jsonb_build_object(
      'tenantAdmission', coalesce((select x.new_run_admission from ops.spend_status() x
                                    where x.scope = 'tenant' and x.tenant_id = p_tenant_id limit 1), 'unconfigured')),
    'outbound', pg_catalog.jsonb_build_object(
      'todayByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                   from (select o.status, count(*) as n from ops.outbound_messages o
                                          where o.tenant_id = p_tenant_id and o.created_at >= v_today group by o.status) s),
                                '{}'::pg_catalog.jsonb),
      'indeterminateOpen', (select count(*) from ops.outbound_messages o where o.tenant_id = p_tenant_id and o.status = 'indeterminate'),
      'acceptedWithoutSend', (select count(*) from ops.review_items v
                               where v.tenant_id = p_tenant_id and v.status = 'accepted'
                                 and not exists (select 1 from ops.outbound_messages o
                                                  where o.tenant_id = p_tenant_id and o.review_item_id = v.id))),
    'platform', pg_catalog.jsonb_build_object('globalAdmissionBlocked', ops.cos_global_admission_blocked()),
    -- Phase 2D.3: shadow calibration, aggregate and advisory.
    'decisionIntelligence', ops.cos_decision_intelligence(p_tenant_id));
end
$$;

-- get_review's shadow decision: the current version's evaluation, else the
-- latest; now with its policy version.
create or replace function ops.cos_review_shadow_decision(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_eval ops.decision_evaluations;
begin
  if p_item.capability <> 'lead_triage' or not ops.cos_review_decidable(p_tenant_id, p_item) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = p_tenant_id and e.review_item_id = p_item.id
   order by (e.policy_version = ops.current_shadow_policy_version()) desc, e.requested_at desc, e.id desc
   limit 1;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'status', case when v_eval.status = 'running' then 'pending' else v_eval.status end,
    'mode', 'shadow',
    'policyVersion', v_eval.policy_version,
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

-- ---------------------------------------------------------------------------
-- 7. Access.
-- ---------------------------------------------------------------------------

revoke all on table ops.decision_policies from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function
  ops.lead_triage_reason_codes_v1(),
  ops.guard_decision_policy_change(),
  ops.refuse_decision_policy_truncate(),
  ops.decision_policy_vector_version(pg_catalog.text),
  ops.decision_policy_outcome(pg_catalog.text, pg_catalog.jsonb),
  ops.current_shadow_policy_version(),
  ops.recover_shadow_decision(pg_catalog.uuid, pg_catalog.uuid),
  ops.cos_decision_intelligence(pg_catalog.uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 8. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_fns constant pg_catalog.text[] := array[
    'decision_vector_valid', 'decision_shadow_policy', 'decision_input_for_review', 'request_shadow_decision',
    'request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision',
    'cos_review_shadow_decision', 'guard_decision_evaluation_update', 'guard_decision_evaluation_insert',
    'lead_triage_reason_codes_v1', 'guard_decision_policy_change', 'refuse_decision_policy_truncate',
    'decision_policy_vector_version', 'decision_policy_outcome', 'current_shadow_policy_version',
    'recover_shadow_decision', 'cos_decision_intelligence'];
begin
  if ops.current_shadow_policy_version() is distinct from 'decision_shadow.v2' then
    raise exception 'the current shadow policy is not decision_shadow.v2';
  end if;
  -- The registry and the executable meaning agree.
  if exists (select 1 from ops.decision_policies p
              where p.vector_version is distinct from ops.decision_policy_vector_version(p.version)) then
    raise exception 'a policy''s registered vector version disagrees with its executable one';
  end if;
  if not (select c.relrowsecurity and c.relforcerowsecurity from pg_catalog.pg_class c
           where c.oid = 'ops.decision_policies'::pg_catalog.regclass) then
    raise exception 'ops.decision_policies lacks ENABLE + FORCE row level security';
  end if;
  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.decision_policies', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or pg_catalog.has_table_privilege(r.rolname, 'ops.decision_evaluations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on the decision tables: %', v_bad;
  end if;
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker'
              and p.proname in ('request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision'));
  if v_bad is not null then
    raise exception 'a role can execute a decision function it must not: %', v_bad;
  end if;
  -- ADVISORY ONLY, unchanged: no decision function reaches beyond advice.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp_send|send_|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels\s+set|grant_membership|revoke_membership|execute\s|review_items\s+set|update\s+ops\.review_items)';
  if v_bad is not null then
    raise exception 'a decision function reaches beyond advice: %', v_bad;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'company_os_api') <> 17 then
    raise exception 'the browser surface changed';
  end if;
end
$end_state$;
