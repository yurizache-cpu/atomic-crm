-- ADR 0022 §E, §F, §H: the structured decision ledger (Jev, shadow first).
--
-- ONE LEDGER, THREE KINDS, each its own auditable row:
--   business_route     business_routing.v1: intent, department, capability,
--                      complexity, human escalation. Recorded beside the route
--                      the deterministic path actually took.
--   lead_intelligence  lead_intelligence.v1: readiness, follow-up priority,
--                      objection, next best action, from OPERATIONAL signals only.
--   model_route        model_route.v1: which of the run's AUTHORIZED candidates
--                      Jev would have chosen, beside the model that executed.
--
-- All three are requested after an agent run's settlement commits, run on the
-- existing queue as ONE external kind (decision.structured_evaluate: the kill
-- switch covers it, the call is at most once), change nothing that executes,
-- and reach a decision model ONLY for synthetic or test data: any other class is
-- refused on the record (data_not_authorized), with no job and no call.
--
-- The decision model is not named in code: it is the rank-1 enabled, priced
-- member of the `structured_decision` pool for the worker's gateway. Its cost is
-- reserved and charged under the same daily limits as agent runs.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

insert into ops.model_pools (name, purpose, model_route) values
  ('structured_decision', 'Structured decision models (typed choices with probabilities), for shadow business decisions, lead intelligence and model-routing advice.', 'economy');

-- ---------------------------------------------------------------------------
-- 1. The ledger.
-- ---------------------------------------------------------------------------

create table ops.structured_decisions (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  company_id            uuid not null,
  department_id         uuid not null,
  agent_id              uuid not null,
  task_id               uuid not null,
  agent_run_id          uuid not null references ops.agent_runs (id) on delete restrict,
  decision_kind         text not null check (decision_kind in ('business_route', 'lead_intelligence', 'model_route')),
  question_set          text not null,
  idempotency_key       text not null check (char_length(idempotency_key) <= 200),
  status                text not null check (status in ('pending', 'running', 'completed', 'indeterminate',
                                                          'invalid', 'failed', 'refused')),
  refusal_code          text check (refusal_code in ('stopped', 'not_eligible', 'data_not_authorized',
                                                     'model_route_unavailable', 'spend_ceiling_unconfigured',
                                                     'budget_unconfigured', 'budget_exhausted')),
  deterministic_route   jsonb check (deterministic_route is null or jsonb_typeof(deterministic_route) = 'object'),
  job_id                uuid unique,
  gateway               text check (gateway ~ '^[a-z][a-z0-9_]{0,31}$'),
  model                 text check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  accepted_builds       text[],
  input_fingerprint     text check (input_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  question_spec         jsonb check (question_spec is null or jsonb_typeof(question_spec) = 'object'),
  answers               jsonb,
  served_model          text check (served_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  provider_route        text check (provider_route ~ '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$'),
  input_tokens          integer check (input_tokens >= 0),
  output_tokens         integer check (output_tokens >= 0),
  latency_ms            integer check (latency_ms >= 0),
  price_id              uuid references ops.model_prices (id) on delete restrict,
  reserved_cost_micros  bigint check (reserved_cost_micros >= 0),
  estimated_cost_micros bigint check (estimated_cost_micros >= 0),
  charged_cost_micros   bigint check (charged_cost_micros >= 0),
  reported_cost_micros  bigint check (reported_cost_micros between 0 and 1000000000),
  error_code            text check (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  requested_at          timestamptz not null default now(),
  started_at            timestamptz,
  settled_at            timestamptz,
  constraint structured_decisions_key unique (tenant_id, idempotency_key),
  constraint structured_decisions_question_set check (
    (decision_kind, question_set) in (('business_route', 'business_routing.v1'),
                                     ('lead_intelligence', 'lead_intelligence.v1'),
                                     ('model_route', 'model_route.v1'))),
  constraint structured_decisions_task_fkey foreign key (tenant_id, company_id, task_id)
    references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint structured_decisions_refused_iff_code check ((status = 'refused') = (refusal_code is not null)),
  constraint structured_decisions_answers_iff_completed check ((status = 'completed') = (answers is not null)),
  constraint structured_decisions_started check (
    (status in ('running', 'completed', 'indeterminate', 'invalid', 'failed'))
      = (started_at is not null and gateway is not null and model is not null and input_fingerprint is not null
         and question_spec is not null and price_id is not null and reserved_cost_micros is not null
         and charged_cost_micros is not null)),
  constraint structured_decisions_settled check (
    (status in ('completed', 'indeterminate', 'invalid', 'failed', 'refused')) = (settled_at is not null))
);

create index structured_decisions_tenant_requested on ops.structured_decisions (tenant_id, requested_at desc, id desc);
create index structured_decisions_started on ops.structured_decisions (tenant_id, started_at) include (company_id, charged_cost_micros);

comment on table ops.structured_decisions is
  'ADR 0022: structured decisions (Jev), shadow only. One row per kind and subject: a business decision and lead intelligence per task, model-routing advice per run. References, an input fingerprint, the question spec and the typed answers, never the input. Nothing reads it to act. Cost is reserved and charged under the daily limits.';

-- Identity is fixed; the lifecycle moves forward once; what was started is what
-- is settled; the charge starts at the reservation.
create function ops.guard_structured_decision_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  -- A decision pending or running is work in progress; a settled one is
  -- history the owner may delete.
  if tg_op = 'DELETE' then
    if old.status in ('pending', 'running') then
      raise exception using errcode = 'OS409', message = 'ops.structured_decisions: a decision in progress is kept';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('pending', 'refused') or new.job_id is not null or new.started_at is not null
       or new.gateway is not null or new.answers is not null or new.price_id is not null
       or new.charged_cost_micros is not null then
      raise exception using errcode = 'OS409', message = 'ops.structured_decisions: a decision is born pending or refused';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id or new.department_id is distinct from old.department_id
     or new.agent_id is distinct from old.agent_id or new.task_id is distinct from old.task_id
     or new.agent_run_id is distinct from old.agent_run_id or new.decision_kind is distinct from old.decision_kind
     or new.question_set is distinct from old.question_set or new.idempotency_key is distinct from old.idempotency_key
     or new.deterministic_route is distinct from old.deterministic_route
     or new.requested_at is distinct from old.requested_at then
    raise exception using errcode = 'OS409', message = 'ops.structured_decisions: a decision''s identity is never rewritten';
  end if;
  if new.job_id is distinct from old.job_id
     and not (old.job_id is null and old.status = 'pending' and new.status = 'pending') then
    raise exception using errcode = 'OS409', message = 'ops.structured_decisions: the job is attached once';
  end if;
  if old.status in ('completed', 'indeterminate', 'invalid', 'failed', 'refused') then
    raise exception using errcode = 'OS409', message = 'ops.structured_decisions: a settled decision is history';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('running', 'refused'))
    or (old.status = 'running' and new.status in ('completed', 'indeterminate', 'invalid', 'failed'))) then
    raise exception using errcode = 'OS409',
      message = pg_catalog.format('ops.structured_decisions: %s -> %s is not a transition', old.status, new.status);
  end if;
  if old.status = 'running' and (new.gateway is distinct from old.gateway or new.model is distinct from old.model
       or new.accepted_builds is distinct from old.accepted_builds
       or new.input_fingerprint is distinct from old.input_fingerprint
       or new.question_spec is distinct from old.question_spec or new.started_at is distinct from old.started_at
       or new.price_id is distinct from old.price_id or new.reserved_cost_micros is distinct from old.reserved_cost_micros) then
    raise exception using errcode = 'OS409', message = 'ops.structured_decisions: a started decision keeps its model, input and reservation';
  end if;
  if old.status = 'pending' and new.status = 'running' then
    if not exists (select 1 from ops.model_prices p
                    where p.id = new.price_id and p.provider = new.gateway and p.model = new.model) then
      raise exception using errcode = 'OS409', message = 'ops.structured_decisions: a decision starts with the price of its own gateway and model';
    end if;
    new.charged_cost_micros := new.reserved_cost_micros;
  end if;
  if new.status = 'completed' and not ops.structured_decision_answers_valid(new.question_spec, new.answers) then
    raise exception using errcode = 'OS400', message = 'ops.structured_decisions: completed answers must satisfy the question spec';
  end if;
  return new;
end
$$;

-- Every asked question answered, exactly as asked. The spec, recorded at the
-- start, holds each key's type and its options (choice), level count (score),
-- or nothing more (noul).
create function ops.structured_decision_answers_valid(p_spec jsonb, p_answers jsonb)
returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare
  v_key     text;
  v_q       jsonb;
  v_a       jsonb;
  v_allowed text[];
begin
  if p_spec is null or p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return false;
  end if;
  for v_key, v_q in select * from jsonb_each(p_spec) loop
    v_a := p_answers -> v_key;
    if v_a is null or jsonb_typeof(v_a) <> 'object' or v_a ->> 'type' is distinct from v_q ->> 'type' then
      return false;
    end if;
    if v_q ->> 'type' = 'choice' then
      select array_agg(o) into v_allowed from jsonb_array_elements_text(v_q -> 'options') o;
      if not (v_a ->> 'choice' = any (v_allowed)) then return false; end if;
    elsif v_q ->> 'type' = 'score' then
      select array_agg(g::text) into v_allowed from generate_series(0, (v_q ->> 'levels')::int - 1) g;
      if jsonb_typeof(v_a -> 'score') <> 'number'
         or (v_a ->> 'score')::numeric < 0 or (v_a ->> 'score')::numeric > (v_q ->> 'levels')::int - 1 then
        return false;
      end if;
    elsif v_q ->> 'type' = 'noul' then
      if jsonb_typeof(v_a -> 'noul') <> 'number'
         or (v_a ->> 'noul')::numeric not between 0 and 1 then
        return false;
      end if;
      continue;
    else
      return false;
    end if;
    if v_a ? 'confidence' and jsonb_typeof(v_a -> 'confidence') <> 'null'
       and (jsonb_typeof(v_a -> 'confidence') <> 'number'
            or (v_a ->> 'confidence')::numeric not between 0 and 1) then
      return false;
    end if;
    if v_a ? 'probabilities' and jsonb_typeof(v_a -> 'probabilities') <> 'null' then
      if jsonb_typeof(v_a -> 'probabilities') <> 'object' or exists (
           select 1 from jsonb_each(v_a -> 'probabilities') p
            where not (p.key = any (v_allowed)) or jsonb_typeof(p.value) <> 'number'
               or (p.value #>> '{}')::numeric not between 0 and 1) then
        return false;
      end if;
    end if;
  end loop;
  return true;
end
$$;

create trigger structured_decisions_guard
  before insert or update or delete on ops.structured_decisions
  for each row execute function ops.guard_structured_decision_change();
alter table ops.structured_decisions enable always trigger structured_decisions_guard;

alter table ops.structured_decisions enable row level security;
alter table ops.structured_decisions force  row level security;

-- ---------------------------------------------------------------------------
-- 2. The input each kind may send, and the spec it is held to. Allowlisted
--    values only; anything outside a vocabulary is never passed on.
-- ---------------------------------------------------------------------------

-- business_intents.v1, mirrored in engine/decision/structured/businessRouting.ts
-- (a test pins the two equal).
create function ops.business_intents_v1()
returns text[]
language sql immutable set search_path = '' as $$
  select array['new_lead', 'pricing_question', 'scheduling', 'rescheduling', 'cancellation',
               'existing_client_admin', 'payment_question', 'follow_up', 'unknown']::text[];
$$;

create function ops.structured_decision_input(p_decision ops.structured_decisions)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_task    ops.tasks;
  v_run     ops.agent_runs;
  v_route   ops.agent_run_routes;
  v_depts   text[];
  v_caps    text[];
  v_result  jsonb;
  v_first   timestamptz;
  v_last    timestamptz;
  v_count   integer;
  v_cplx    text;
begin
  select t.* into v_task from ops.tasks t where t.tenant_id = p_decision.tenant_id and t.id = p_decision.task_id;
  select r.* into v_run from ops.agent_runs r where r.tenant_id = p_decision.tenant_id and r.id = p_decision.agent_run_id;
  if v_task.id is null or v_run.id is null then
    return null;
  end if;

  if p_decision.decision_kind = 'business_route' then
    if v_task.description is null or btrim(v_task.description) = '' then
      return null;
    end if;
    select coalesce(array_agg(d.slug order by d.slug), '{}') into v_depts
      from ops.departments d
     where d.tenant_id = v_task.tenant_id and d.company_id = v_task.company_id and d.status = 'active';
    select array_agg(c.capability order by c.capability) into v_caps from ops.agent_run_capabilities() c;
    return jsonb_build_object(
      'input', jsonb_build_object('sourceClass', v_task.data_class, 'message', left(v_task.description, 4000),
                                  'departments', to_jsonb(v_depts), 'capabilities', to_jsonb(v_caps)),
      'spec', jsonb_build_object(
        'intent', jsonb_build_object('type', 'choice', 'options', to_jsonb(ops.business_intents_v1())),
        'department', jsonb_build_object('type', 'choice', 'options', to_jsonb(v_depts || array['human_review', 'no_action'])),
        'capability', jsonb_build_object('type', 'choice', 'options', to_jsonb(v_caps || array['none'])),
        'complexity', jsonb_build_object('type', 'score', 'levels', 3),
        'human_review', jsonb_build_object('type', 'noul')));
  end if;

  if p_decision.decision_kind = 'lead_intelligence' then
    v_result := v_run.result;
    if v_run.status <> 'succeeded' or v_result is null or jsonb_typeof(v_result) <> 'object' then
      return null;
    end if;
    select min(i.received_at), max(i.received_at), count(*)::int into v_first, v_last, v_count
      from ops.inbound_messages i
     where i.tenant_id = v_task.tenant_id
       and i.conversation_id is not null
       and i.conversation_id = (select i2.conversation_id from ops.inbound_messages i2
                                 where i2.tenant_id = v_task.tenant_id and i2.task_id = v_task.id limit 1);
    if v_count is null or v_count = 0 then
      select 1, now(), now() into v_count, v_first, v_last;
    end if;
    return jsonb_build_object(
      'input', jsonb_build_object(
        'intent', case when v_result ->> 'intent' in ('book_appointment', 'pricing', 'information', 'support', 'other')
                       then v_result ->> 'intent' else 'other' end,
        'priority', case when v_result ->> 'priority' in ('low', 'normal', 'high') then v_result ->> 'priority' else 'normal' end,
        'funnel_stage', 'unknown',
        'has_open_opportunity', false,
        'inbound_messages', least(v_count, 10000),
        'days_since_first_contact', least(greatest(extract(day from now() - v_first)::int, 0), 36500),
        'hours_since_last_inbound', least(greatest(floor(extract(epoch from now() - v_last) / 3600)::int, 0), 876000)),
      'spec', jsonb_build_object(
        'commercial_readiness', jsonb_build_object('type', 'score', 'levels', 3),
        'scheduling_readiness', jsonb_build_object('type', 'score', 'levels', 3),
        'follow_up_priority', jsonb_build_object('type', 'score', 'levels', 3),
        'objection', jsonb_build_object('type', 'choice', 'options',
          to_jsonb(array['price', 'schedule', 'modality', 'trust_or_fit', 'none', 'unknown'])),
        'next_best_action', jsonb_build_object('type', 'choice', 'options',
          to_jsonb(array['offer_slots', 'share_pricing_information', 'answer_question', 'follow_up_later', 'human_review']))));
  end if;

  -- model_route
  select r.* into v_route from ops.agent_run_routes r where r.agent_run_id = v_run.id and r.tenant_id = v_run.tenant_id;
  if v_route.agent_run_id is null or jsonb_array_length(v_route.candidates) < 2 then
    return null;
  end if;
  select case when (d.answers -> 'complexity' ->> 'score')::numeric < 0.5 then 'low'
              when (d.answers -> 'complexity' ->> 'score')::numeric < 1.5 then 'medium'
              else 'high' end
    into v_cplx
    from ops.structured_decisions d
   where d.tenant_id = p_decision.tenant_id and d.task_id = p_decision.task_id
     and d.decision_kind = 'business_route' and d.status = 'completed';
  return jsonb_build_object(
    'input', jsonb_build_object(
      'capability', v_run.capability,
      'complexity', coalesce(v_cplx, 'unknown'),
      'inputSize', case when coalesce(v_run.input_tokens, 0) <= 2000 then 'small'
                        when v_run.input_tokens <= 16000 then 'medium' else 'large' end,
      'candidates', (select jsonb_agg(jsonb_build_object(
                       'model', c ->> 'model', 'family', c ->> 'family', 'costClass', c ->> 'costClass',
                       'latencyClass', c ->> 'latencyClass', 'reasoning', (c ->> 'reasoning')::boolean,
                       'contextClass', c ->> 'contextClass') order by (c ->> 'rank')::int)
                       from jsonb_array_elements(v_route.candidates) c)),
    'spec', jsonb_build_object(
      'model', jsonb_build_object('type', 'choice', 'options',
        (select jsonb_agg(c ->> 'model' order by (c ->> 'rank')::int) from jsonb_array_elements(v_route.candidates) c))));
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The request: after an agent run's settlement, for the worker that
--    completed the job. Idempotent per kind and subject.
-- ---------------------------------------------------------------------------

create function ops.request_structured_decisions_for_settled_job(p_worker_id text, p_job_id uuid)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job     ops.jobs;
  v_run     ops.agent_runs;
  v_task    ops.tasks;
  v_route   ops.agent_run_routes;
  v_dept    text;
  v_kind    text;
  v_key     text;
  v_id      uuid;
  v_stop    uuid;
  v_job_id  uuid;
  v_count   integer := 0;
  v_det     jsonb;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or p_job_id is null then
    raise exception using errcode = 'OS400',
      message = 'ops.request_structured_decisions_for_settled_job requires a worker id and a job id';
  end if;
  select j.* into v_job from ops.jobs j
   where j.id = p_job_id and j.kind = 'agent_run.execute' and j.status = 'succeeded';
  if not found then
    return 0;
  end if;
  if not exists (select 1 from ops.job_events e
                  where e.job_id = v_job.id and e.tenant_id = v_job.tenant_id
                    and e.event = 'succeeded' and e.worker_id = p_worker_id) then
    raise exception using errcode = 'OS403',
      message = 'ops.request_structured_decisions_for_settled_job: that job was not completed by this worker';
  end if;
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_job.tenant_id and r.job_id = v_job.id;
  if not found then
    return 0;
  end if;
  select t.* into v_task from ops.tasks t where t.tenant_id = v_run.tenant_id and t.id = v_run.task_id;
  select d.slug into v_dept from ops.departments d where d.tenant_id = v_run.tenant_id and d.id = v_run.department_id;
  select r.* into v_route from ops.agent_run_routes r where r.agent_run_id = v_run.id and r.tenant_id = v_run.tenant_id;

  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.covering_execution_stop(v_run.tenant_id, 'decision.structured_evaluate',
                                        v_run.company_id, v_run.department_id, v_run.agent_id);

  foreach v_kind in array array['business_route', 'lead_intelligence', 'model_route'] loop
    if v_kind = 'lead_intelligence' and (v_run.capability <> 'lead_triage' or v_run.status <> 'succeeded') then
      continue;
    end if;
    if v_kind = 'model_route' and (v_route.agent_run_id is null or jsonb_array_length(v_route.candidates) < 2) then
      continue;
    end if;
    v_key := case when v_kind = 'model_route' then 'model_route:run:' || v_run.id
                  else v_kind || ':task:' || v_task.id end;
    if exists (select 1 from ops.structured_decisions d where d.tenant_id = v_run.tenant_id and d.idempotency_key = v_key) then
      continue;
    end if;
    v_det := case v_kind
      when 'business_route' then jsonb_build_object('department', v_dept, 'capability', v_run.capability,
                                                     'agentId', v_run.agent_id, 'humanReview', true)
      when 'model_route' then jsonb_build_object('executedModel', v_route.model, 'gateway', v_route.gateway,
                                                  'pool', v_route.model_pool)
      else null end;
    insert into ops.structured_decisions (tenant_id, company_id, department_id, agent_id, task_id, agent_run_id,
                                          decision_kind, question_set, idempotency_key, status, refusal_code,
                                          deterministic_route, settled_at)
    values (v_run.tenant_id, v_run.company_id, v_run.department_id, v_run.agent_id, v_task.id, v_run.id, v_kind,
            case v_kind when 'business_route' then 'business_routing.v1'
                        when 'lead_intelligence' then 'lead_intelligence.v1' else 'model_route.v1' end,
            v_key,
            case when not ops.model_data_class_exempt(v_task.data_class, 'none') or v_stop is not null
                 then 'refused' else 'pending' end,
            case when not ops.model_data_class_exempt(v_task.data_class, 'none') then 'data_not_authorized'
                 when v_stop is not null then 'stopped' end,
            v_det,
            case when not ops.model_data_class_exempt(v_task.data_class, 'none') or v_stop is not null
                 then now() end)
    on conflict do nothing
    returning id into v_id;
    if v_id is null then
      continue;
    end if;
    v_count := v_count + 1;
    if ops.model_data_class_exempt(v_task.data_class, 'none') and v_stop is null then
      v_job_id := ops.enqueue_job(v_run.tenant_id, 'decision.structured_evaluate',
                                  jsonb_build_object('structured_decision_id', v_id),
                                  case v_kind when 'business_route' then 100 when 'lead_intelligence' then 105 else 110 end,
                                  now(), 3, 'structured_decision:' || v_id::text);
      update ops.structured_decisions set job_id = v_job_id where id = v_id;
    end if;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The worker's two lease-bound capabilities.
-- ---------------------------------------------------------------------------

create function ops.start_structured_decision(p_gateway text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job      ops.jobs := ops.leased_job();
  v_dec      ops.structured_decisions;
  v_task     ops.tasks;
  v_built    jsonb;
  v_model    record;
  v_price    ops.model_prices;
  v_reserved bigint;
  v_spend    record;
  v_code     text;
  v_print    text;
begin
  if p_gateway is null or p_gateway !~ '^[a-z][a-z0-9_]{0,31}$' then
    raise exception using errcode = 'OS400', message = 'ops.start_structured_decision: bad gateway';
  end if;
  select * into v_dec from ops.structured_decisions d
   where d.tenant_id = v_job.tenant_id and d.job_id = v_job.id
     for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if v_dec.status = 'running' then
    -- An earlier attempt started and never settled: never asked again.
    update ops.structured_decisions
       set status = 'indeterminate', error_code = 'attempt_interrupted', settled_at = now(),
           charged_cost_micros = v_dec.reserved_cost_micros
     where id = v_dec.id;
    return jsonb_build_object('status', 'indeterminate', 'decisionId', v_dec.id);
  end if;
  if v_dec.status <> 'pending' then
    return jsonb_build_object('status', v_dec.status, 'decisionId', v_dec.id);
  end if;

  -- BASELINE Q8 at the moment of acting: synthetic or test data only.
  select t.* into v_task from ops.tasks t where t.tenant_id = v_dec.tenant_id and t.id = v_dec.task_id;
  if not ops.model_data_class_exempt(v_task.data_class, 'none') then
    v_code := 'data_not_authorized';
  end if;

  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.covering_execution_stop(v_dec.tenant_id, v_job.kind, v_dec.company_id, v_dec.department_id,
                                 v_dec.agent_id) is not null then
    return jsonb_build_object('status', 'stopped', 'decisionId', v_dec.id);
  end if;

  if v_code is null then
    v_built := ops.structured_decision_input(v_dec);
    if v_built is null then
      v_code := 'not_eligible';
    end if;
  end if;

  if v_code is null then
    select r.model, r.accepted_builds into v_model
      from ops.model_pool_members m
      join ops.model_registry r on r.id = m.registry_id
     where m.pool = 'structured_decision' and m.removed_at is null and r.enabled and r.gateway = p_gateway
       and ops.current_model_price(r.gateway, r.model, now()) is not null
     order by m.rank
     limit 1;
    if v_model.model is null then
      v_code := 'model_route_unavailable';
    end if;
  end if;

  if v_code is null then
    select p.* into v_price from ops.model_prices p where p.id = ops.current_model_price(p_gateway, v_model.model, now());
    -- The input ceiling (bytes plus a fixed margin for the questions) at the input
    -- rate, and 512 output tokens at the output rate. USD per million tokens times
    -- tokens is micro-dollars.
    v_reserved := ceil((octet_length(v_built::text) + 8192) * v_price.input_usd_per_mtok
                       + 512 * v_price.output_usd_per_mtok)::bigint;
    select a.p_code into v_spend from ops.spend_admission(v_dec.tenant_id, v_dec.company_id, v_reserved, true) a;
    if v_spend.p_code = 'budget_contended' then
      raise exception using errcode = 'OS429',
        message = 'ops.start_structured_decision: the spend limits cannot absorb this decision beside the calls in flight; try again after they settle';
    end if;
    v_code := v_spend.p_code;
  end if;

  if v_code is not null then
    update ops.structured_decisions
       set status = 'refused', refusal_code = v_code, settled_at = now()
     where id = v_dec.id;
    return jsonb_build_object('status', 'refused', 'decisionId', v_dec.id, 'refusalCode', v_code);
  end if;

  v_print := 'sha256:' || encode(sha256(convert_to((v_built -> 'input')::text, 'UTF8')), 'hex');
  update ops.structured_decisions
     set status = 'running', started_at = now(), gateway = p_gateway, model = v_model.model,
         accepted_builds = v_model.accepted_builds, input_fingerprint = v_print,
         question_spec = v_built -> 'spec', price_id = v_price.id, reserved_cost_micros = v_reserved
   where id = v_dec.id;
  return jsonb_build_object('status', 'running', 'decisionId', v_dec.id, 'kind', v_dec.decision_kind,
                            'questionSet', v_dec.question_set, 'model', v_model.model,
                            'acceptedBuilds', to_jsonb(v_model.accepted_builds),
                            'input', v_built -> 'input', 'spec', v_built -> 'spec');
end
$$;

create function ops.settle_structured_decision(
  p_outcome text, p_answers jsonb, p_served_model text, p_input_tokens integer, p_output_tokens integer,
  p_reported_cost_micros bigint, p_latency_ms integer, p_provider_route text, p_error_code text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job      ops.jobs := ops.leased_job();
  v_dec      ops.structured_decisions;
  v_price    ops.model_prices;
  v_estimate bigint;
  v_status   text := p_outcome;
  v_code     text := p_error_code;
  v_charged  bigint;
begin
  if p_outcome is null or p_outcome not in ('completed', 'indeterminate', 'invalid', 'failed')
     or (p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
     or (p_outcome = 'completed') <> (p_answers is not null)
     or (p_input_tokens is not null and p_input_tokens < 0) or (p_output_tokens is not null and p_output_tokens < 0)
     or (p_latency_ms is not null and p_latency_ms < 0)
     or (p_provider_route is not null and p_provider_route !~ '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$')
     or (p_served_model is not null and p_served_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$')
     or (p_reported_cost_micros is not null and (p_reported_cost_micros < 0 or p_reported_cost_micros > 1000000000)) then
    raise exception using errcode = 'OS400', message = 'ops.settle_structured_decision: bad settlement';
  end if;
  select * into v_dec from ops.structured_decisions d
   where d.tenant_id = v_job.tenant_id and d.job_id = v_job.id
     for update;
  if not found or v_dec.status <> 'running' then
    return 'not_running';
  end if;

  if v_status = 'completed' then
    if p_served_model is null
       or not (p_served_model = v_dec.model or p_served_model = any (coalesce(v_dec.accepted_builds, '{}'))) then
      v_status := 'invalid';
      v_code := 'model_substituted';
    elsif not ops.structured_decision_answers_valid(v_dec.question_spec, p_answers) then
      v_status := 'invalid';
      v_code := 'answers_rejected';
    end if;
  end if;

  select p.* into v_price from ops.model_prices p where p.id = v_dec.price_id;
  v_estimate := case when p_input_tokens is not null and p_output_tokens is not null
                     then ceil(p_input_tokens * v_price.input_usd_per_mtok + p_output_tokens * v_price.output_usd_per_mtok)::bigint end;
  v_charged := case
    when v_status = 'indeterminate' then greatest(v_dec.reserved_cost_micros, coalesce(v_estimate, 0))
    when v_estimate is not null then v_estimate
    when v_status = 'failed' then 0
    else v_dec.reserved_cost_micros
  end;
  if v_charged > v_dec.charged_cost_micros then
    perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('global', null, null));
    perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('tenant', v_dec.tenant_id, null));
    perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('company', v_dec.tenant_id, v_dec.company_id));
  end if;

  update ops.structured_decisions
     set status = v_status,
         answers = case when v_status = 'completed' then p_answers end,
         served_model = p_served_model, provider_route = p_provider_route,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens, latency_ms = p_latency_ms,
         reported_cost_micros = p_reported_cost_micros,
         estimated_cost_micros = v_estimate, charged_cost_micros = v_charged,
         error_code = case when v_status = 'completed' then null else v_code end,
         settled_at = now()
   where id = v_dec.id;
  return v_status;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The kind, the stop that covers it, and the spend that counts it.
-- ---------------------------------------------------------------------------

create or replace function ops.external_job_kinds()
returns text[]
language sql immutable set search_path = '' as $$
  select array['agent_run.execute', 'decision.shadow_evaluate',
               'calendar.create', 'calendar.update', 'calendar.cancel',
               'decision.structured_evaluate']::text[];
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
  if p_job_kind = 'follow_up.due' then
    select p.company_id, p.department_id, p.agent_id into v_company, v_department, v_agent
      from ops.follow_ups f
      join ops.follow_up_plans p on p.tenant_id = f.tenant_id and p.company_id = f.company_id and p.id = f.plan_id
     where f.tenant_id = p_tenant_id and f.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  if p_job_kind in ('calendar.create', 'calendar.update', 'calendar.cancel') then
    select s.company_id, s.department_id into v_company, v_department
      from ops.calendar_syncs s
     where s.tenant_id = p_tenant_id and s.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, null);
  end if;
  if p_job_kind = 'decision.structured_evaluate' then
    -- Held by the stops of the unit whose run it describes.
    select d.company_id, d.department_id, d.agent_id into v_company, v_department, v_agent
      from ops.structured_decisions d
     where d.tenant_id = p_tenant_id and d.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.job_id = p_job_id;
  if not found then
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

-- The 20260917120000 window total, now counting structured decisions too: a
-- decision model's cost is spend like any model's (ADR 0022 §H).
create or replace function ops.spend_window_total(
  p_scope      text,
  p_tenant_id  uuid,
  p_company_id uuid,
  p_since      timestamptz,
  out p_charged bigint,
  out p_settled bigint
)
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_charged bigint;
  v_settled bigint;
begin
  if row_security_active('ops.agent_runs') or row_security_active('ops.structured_decisions') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.spend_window_total: row security would hide runs from this caller, and a total that cannot be read refuses';
  end if;
  if not (p_scope = 'global'
          or (p_scope = 'tenant' and p_tenant_id is not null)
          or (p_scope = 'company' and p_tenant_id is not null and p_company_id is not null)) then
    raise exception using
      errcode = 'OS400',
      message = format('ops.spend_window_total: %L with these coordinates is not a spend scope', p_scope);
  end if;
  select coalesce(sum(r.charged_cost_micros), 0)::bigint,
         coalesce(sum(r.charged_cost_micros) filter (where r.status <> 'running'), 0)::bigint
    into p_charged, p_settled
    from ops.agent_runs r
   where r.started_at >= p_since
     and (p_scope = 'global' or r.tenant_id = p_tenant_id)
     and (p_scope <> 'company' or r.company_id = p_company_id);
  select coalesce(sum(d.charged_cost_micros), 0)::bigint,
         coalesce(sum(d.charged_cost_micros) filter (where d.status <> 'running'), 0)::bigint
    into v_charged, v_settled
    from ops.structured_decisions d
   where d.started_at >= p_since
     and (p_scope = 'global' or d.tenant_id = p_tenant_id)
     and (p_scope <> 'company' or d.company_id = p_company_id);
  p_charged := p_charged + v_charged;
  p_settled := p_settled + v_settled;
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. Outcomes observed later, for calibration (ADR 0022 §F).
-- ---------------------------------------------------------------------------

create table ops.decision_outcomes (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references ops.tenants (id) on delete restrict,
  structured_decision_id uuid not null references ops.structured_decisions (id) on delete restrict,
  outcome                text not null check (outcome in ('replied', 'scheduled', 'attended', 'converted', 'lost',
                                                          'no_response', 'human_override')),
  value_micros           bigint check (value_micros between 0 and 100000000000),
  observed_at            timestamptz not null,
  recorded_by            text not null check (recorded_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  recorded_at            timestamptz not null default now(),
  constraint decision_outcomes_once unique (structured_decision_id, outcome)
);

comment on table ops.decision_outcomes is
  'ADR 0022 §F: an outcome observed after a structured decision (replied, scheduled, attended, converted, lost, no response, a human override), with its value and when it happened. Append-only owner data for calibration; a score is never presented as a probability of conversion before this exists.';

create function ops.guard_decision_outcome_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception using errcode = 'OS409', message = 'ops.decision_outcomes: an observed outcome is never rewritten';
  end if;
  if not exists (select 1 from ops.structured_decisions d
                  where d.id = new.structured_decision_id and d.tenant_id = new.tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.decision_outcomes: no such decision in that tenant';
  end if;
  if new.observed_at > now() then
    raise exception using errcode = 'OS400', message = 'ops.decision_outcomes: an outcome is observed, not foreseen';
  end if;
  new.recorded_at := now();
  return new;
end
$$;

create trigger decision_outcomes_guard
  before insert or update or delete on ops.decision_outcomes
  for each row execute function ops.guard_decision_outcome_change();
alter table ops.decision_outcomes enable always trigger decision_outcomes_guard;

alter table ops.decision_outcomes enable row level security;
alter table ops.decision_outcomes force  row level security;

create function ops.record_decision_outcome(p_tenant_id uuid, p_decision_id uuid, p_outcome text,
                                            p_value_micros bigint, p_observed_at timestamptz, p_actor text)
returns uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into ops.decision_outcomes (tenant_id, structured_decision_id, outcome, value_micros, observed_at, recorded_by)
  values (p_tenant_id, p_decision_id, p_outcome, p_value_micros, coalesce(p_observed_at, now()), p_actor)
  on conflict (structured_decision_id, outcome) do nothing
  returning id into v_id;
  if v_id is null then
    select o.id into v_id from ops.decision_outcomes o
     where o.structured_decision_id = p_decision_id and o.outcome = p_outcome;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. The owner's reads: decisions against what happened, and the economics.
--    Counts and sums only, never content.
-- ---------------------------------------------------------------------------

create function ops.structured_decision_summary(p_tenant_id uuid)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with d as (
    select * from ops.structured_decisions where tenant_id = p_tenant_id
  ), business as (
    select d.*, r.status as review_status
      from d
      left join ops.review_items r on r.tenant_id = d.tenant_id and r.agent_run_id = d.agent_run_id
     where d.decision_kind = 'business_route' and d.status = 'completed'
  ), routing as (
    select d.* from d where d.decision_kind = 'model_route' and d.status = 'completed'
  )
  select jsonb_build_object(
    'byKindAndStatus', coalesce((select jsonb_object_agg(k, v) from (
        select decision_kind as k, jsonb_object_agg(status, n) as v
          from (select decision_kind, status, count(*) n from d group by 1, 2) s group by 1) t), '{}'::jsonb),
    'businessRoute', jsonb_build_object(
      'completed', (select count(*) from business),
      'departmentAgreesWithDeterministic', (select count(*) from business
                                             where answers -> 'department' ->> 'choice' = deterministic_route ->> 'department'),
      'capabilityAgreesWithDeterministic', (select count(*) from business
                                             where answers -> 'capability' ->> 'choice' = deterministic_route ->> 'capability'),
      'byIntent', coalesce((select jsonb_object_agg(i, n) from (
          select answers -> 'intent' ->> 'choice' i, count(*) n from business group by 1) s), '{}'::jsonb),
      'byComplexityLevel', coalesce((select jsonb_object_agg(c, n) from (
          select case when (answers -> 'complexity' ->> 'score')::numeric < 0.5 then 'low'
                      when (answers -> 'complexity' ->> 'score')::numeric < 1.5 then 'medium' else 'high' end c,
                 count(*) n from business group by 1) s), '{}'::jsonb),
      'humanReviewSuggested', (select count(*) from business where (answers -> 'human_review' ->> 'noul')::numeric >= 0.5),
      'humanDecisions', coalesce((select jsonb_object_agg(coalesce(review_status, 'none'), n) from (
          select review_status, count(*) n from business group by 1) s), '{}'::jsonb)),
    'modelRoute', jsonb_build_object(
      'completed', (select count(*) from routing),
      'agreesWithExecuted', (select count(*) from routing
                              where answers -> 'model' ->> 'choice' = deterministic_route ->> 'executedModel')),
    'leadIntelligence', jsonb_build_object(
      'completed', (select count(*) from d where decision_kind = 'lead_intelligence' and status = 'completed'),
      'withOutcome', (select count(distinct o.structured_decision_id) from ops.decision_outcomes o
                        join d on d.id = o.structured_decision_id where d.decision_kind = 'lead_intelligence'),
      'calibration', 'not_calibrated'),
    'decisionCostMicros', (select coalesce(sum(charged_cost_micros), 0) from d));
$$;

create function ops.model_economics(p_tenant_id uuid, p_since timestamptz)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with runs as (
    select r.*, d.slug as department, rr.model_pool, rr.provider_route, rr.reported_cost_micros, rr.candidates
      from ops.agent_runs r
      join ops.departments d on d.tenant_id = r.tenant_id and d.id = r.department_id
      left join ops.agent_run_routes rr on rr.agent_run_id = r.id
     where r.tenant_id = p_tenant_id and r.started_at >= p_since
  ), strongest as (
    -- What the most expensive authorized candidate would have cost at the same
    -- tokens: the counterfactual of "always the strongest model".
    select runs.id,
           max(ceil(coalesce(runs.input_tokens, 0) * p.input_usd_per_mtok
                    + coalesce(runs.output_tokens, 0) * p.output_usd_per_mtok)::bigint) as cost
      from runs
      cross join lateral jsonb_array_elements(coalesce(runs.candidates, '[]'::jsonb)) c
      join ops.model_prices p on p.id = ops.current_model_price(c ->> 'gateway', c ->> 'model', runs.started_at)
     group by runs.id
  )
  select jsonb_build_object(
    'since', p_since,
    'runs', (select count(*) from runs),
    'chargedMicros', (select coalesce(sum(charged_cost_micros), 0) from runs),
    'reportedMicros', (select coalesce(sum(reported_cost_micros), 0) from runs),
    'byAgent', coalesce((select jsonb_object_agg(agent_id::text, jsonb_build_object('runs', n, 'chargedMicros', c)) from (
        select agent_id, count(*) n, coalesce(sum(charged_cost_micros), 0) c from runs group by 1) s), '{}'::jsonb),
    'byDepartment', coalesce((select jsonb_object_agg(department, jsonb_build_object('runs', n, 'chargedMicros', c)) from (
        select department, count(*) n, coalesce(sum(charged_cost_micros), 0) c from runs group by 1) s), '{}'::jsonb),
    'byCapability', coalesce((select jsonb_object_agg(capability, jsonb_build_object('runs', n, 'chargedMicros', c)) from (
        select capability, count(*) n, coalesce(sum(charged_cost_micros), 0) c from runs group by 1) s), '{}'::jsonb),
    'byModel', coalesce((select jsonb_object_agg(coalesce(provider, 'none') || ':' || coalesce(model, 'none'),
                                                 jsonb_build_object('runs', n, 'chargedMicros', c, 'avgLatencyMs', l)) from (
        select provider, model, count(*) n, coalesce(sum(charged_cost_micros), 0) c, round(avg(latency_ms)) l
          from runs group by 1, 2) s), '{}'::jsonb),
    'byProviderRoute', coalesce((select jsonb_object_agg(coalesce(provider_route, 'unreported'), n) from (
        select provider_route, count(*) n from runs where model_pool is not null group by 1) s), '{}'::jsonb),
    'routingEconomics', jsonb_build_object(
      'routedRuns', (select count(*) from strongest),
      'actualMicros', (select coalesce(sum(r.charged_cost_micros), 0) from runs r join strongest s on s.id = r.id),
      'alwaysStrongestMicros', (select coalesce(sum(cost), 0) from strongest)),
    'decisions', (select jsonb_build_object('count', count(*), 'chargedMicros', coalesce(sum(charged_cost_micros), 0))
                    from ops.structured_decisions d where d.tenant_id = p_tenant_id and d.started_at >= p_since));
$$;

-- ---------------------------------------------------------------------------
-- 8. Access.
-- ---------------------------------------------------------------------------

revoke all on table ops.structured_decisions, ops.decision_outcomes
  from public, anon, authenticated, service_role, ops_worker, ops_gateway, ops_operator_api;

revoke all on function
  ops.guard_structured_decision_change(),
  ops.structured_decision_answers_valid(jsonb, jsonb),
  ops.business_intents_v1(),
  ops.structured_decision_input(ops.structured_decisions),
  ops.request_structured_decisions_for_settled_job(text, uuid),
  ops.start_structured_decision(text),
  ops.settle_structured_decision(text, jsonb, text, integer, integer, bigint, integer, text, text),
  ops.external_job_kinds(),
  ops.job_covering_stop(uuid, uuid, text),
  ops.spend_window_total(text, uuid, uuid, timestamptz),
  ops.guard_decision_outcome_change(),
  ops.record_decision_outcome(uuid, uuid, text, bigint, timestamptz, text),
  ops.structured_decision_summary(uuid),
  ops.model_economics(uuid, timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway, ops_operator_api;

grant execute on function
  ops.request_structured_decisions_for_settled_job(text, uuid),
  ops.start_structured_decision(text),
  ops.settle_structured_decision(text, jsonb, text, integer, integer, bigint, integer, text, text)
  to ops_worker;

-- ---------------------------------------------------------------------------
-- 9. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_tables constant pg_catalog.text[] := array['structured_decisions', 'decision_outcomes'];
  c_fns constant pg_catalog.text[] := array[
    'guard_structured_decision_change', 'structured_decision_answers_valid', 'business_intents_v1',
    'structured_decision_input', 'request_structured_decisions_for_settled_job', 'start_structured_decision',
    'settle_structured_decision', 'guard_decision_outcome_change', 'record_decision_outcome',
    'structured_decision_summary', 'model_economics'];
begin
  select pg_catalog.string_agg(c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'structured decision table(s) lack ENABLE + FORCE row level security: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || t.relname, ', ') into v_bad
    from pg_catalog.unnest(c_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.' || t.relname, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a structured decision table: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker' and p.proname in ('request_structured_decisions_for_settled_job',
                                                          'start_structured_decision', 'settle_structured_decision'));
  if v_bad is not null then
    raise exception 'a role can execute a structured decision function it must not: %', v_bad;
  end if;

  if not ('decision.structured_evaluate' = any (ops.external_job_kinds()))
     or ops.external_job_kinds() && ops.governed_job_kinds()
     or ops.external_job_kinds() && ops.internal_job_kinds()
     or 'decision.structured_evaluate' = any (ops.task_executable_kinds()) then
    raise exception 'decision.structured_evaluate is not exactly an external, non-task kind';
  end if;

  -- A STRUCTURED DECISION NEVER ACTS: no decision function names a send, an
  -- outbound row, a review decision, the CRM, a stop act, a budget or price
  -- write, a channel, a membership, a task or run transition, or dynamic SQL.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp|send_|public\.|trip_execution_stop|clear_execution_stop|record_model_price|set_spend_limit|communication_channels|grant_membership|revoke_membership|update\s+ops\.(tasks|agent_runs|review_items)|execute\s)';
  if v_bad is not null then
    raise exception 'a structured decision function reaches beyond recording advice: %', v_bad;
  end if;
end
$end_state$;
