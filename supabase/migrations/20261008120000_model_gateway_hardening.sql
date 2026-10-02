-- ADR 0022 hardening: the pre-review corrections to the model gateway and the
-- structured decision ledger. Forward only; 20261006120000 and 20261007120000
-- are applied and unchanged.
--
-- WHAT CHANGES
--   1. ops.structured_decision_answers_valid: NULL-safe. A missing choice,
--      score or noul is refused, and so is a key that was not asked. The
--      database, not only the worker, holds answers to the recorded spec.
--   2. ops.structured_decision_input: lead intelligence says `unknown` for
--      has_open_opportunity instead of a `false` nothing established (the
--      inbound message is not linked to a deal today).
--   3. ops.settle_structured_decision: a decision the model answered (a served
--      model on record) is never charged zero; without usage it keeps its
--      reservation. Only a call with no response is charged nothing.
--   4. ops.guard_agent_profile_change: a capability's pool must be on that
--      capability's own route tier, so a profile can no longer silently refuse
--      every run of its agent.
--   5. ops.start_agent_run: an agent with a current profile runs only its own
--      capabilities on its own data classes (agent_not_permitted), and its
--      daily ceiling splits settled spend (refusal: agent_budget_exhausted)
--      from calls still in flight (contention: OS429, retried), as
--      ops.spend_admission does for the global and tenant limits.
--   6. ops.settle_stale_agent_runs: also settles a structured decision whose
--      attempt died as indeterminate, charged at its reservation.
--   7. The end state asserts that OpenRouter holds no current authorization for
--      person_text or health content.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. Nothing here authorizes data.

-- ---------------------------------------------------------------------------
-- 1. Answers: exactly the questions asked, each answered as asked.
-- ---------------------------------------------------------------------------

create or replace function ops.structured_decision_answers_valid(p_spec jsonb, p_answers jsonb)
returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare
  v_key     text;
  v_q       jsonb;
  v_a       jsonb;
  v_allowed text[];
begin
  if p_spec is null or p_answers is null
     or jsonb_typeof(p_spec) is distinct from 'object' or jsonb_typeof(p_answers) is distinct from 'object' then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(p_answers) k where not (p_spec ? k)) then
    return false;
  end if;
  for v_key, v_q in select * from jsonb_each(p_spec) loop
    v_a := p_answers -> v_key;
    if v_a is null or jsonb_typeof(v_a) is distinct from 'object'
       or (v_a ->> 'type') is distinct from (v_q ->> 'type') then
      return false;
    end if;
    v_allowed := null;
    if v_q ->> 'type' = 'choice' then
      select array_agg(o) into v_allowed from jsonb_array_elements_text(v_q -> 'options') o;
      if jsonb_typeof(v_a -> 'choice') is distinct from 'string'
         or not coalesce((v_a ->> 'choice') = any (v_allowed), false) then
        return false;
      end if;
    elsif v_q ->> 'type' = 'score' then
      select array_agg(g::text) into v_allowed from generate_series(0, (v_q ->> 'levels')::int - 1) g;
      if jsonb_typeof(v_a -> 'score') is distinct from 'number'
         or not coalesce((v_a ->> 'score')::numeric between 0 and (v_q ->> 'levels')::int - 1, false) then
        return false;
      end if;
    elsif v_q ->> 'type' = 'noul' then
      if jsonb_typeof(v_a -> 'noul') is distinct from 'number'
         or not coalesce((v_a ->> 'noul')::numeric between 0 and 1, false) then
        return false;
      end if;
      continue;
    else
      return false;
    end if;
    if v_a ? 'confidence' and jsonb_typeof(v_a -> 'confidence') <> 'null'
       and (jsonb_typeof(v_a -> 'confidence') <> 'number'
            or not coalesce((v_a ->> 'confidence')::numeric between 0 and 1, false)) then
      return false;
    end if;
    if v_a ? 'probabilities' and jsonb_typeof(v_a -> 'probabilities') <> 'null' then
      if jsonb_typeof(v_a -> 'probabilities') <> 'object' or exists (
           select 1 from jsonb_each(v_a -> 'probabilities') p
            where not coalesce(p.key = any (v_allowed), false) or jsonb_typeof(p.value) <> 'number'
               or not coalesce((p.value #>> '{}')::numeric between 0 and 1, false)) then
        return false;
      end if;
    end if;
  end loop;
  return true;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Lead intelligence input.
-- ---------------------------------------------------------------------------

create or replace function ops.structured_decision_input(p_decision ops.structured_decisions)
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
        'has_open_opportunity', 'unknown',
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
-- 3. Settlement.
-- ---------------------------------------------------------------------------

create or replace function ops.settle_structured_decision(
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
    when v_status = 'failed' and p_served_model is null then 0
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
-- 4. Agent profiles.
-- ---------------------------------------------------------------------------

create or replace function ops.guard_agent_profile_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_key   pg_catalog.text;
  v_value pg_catalog.jsonb;
begin
  if tg_op = 'DELETE' then
    if old.superseded_at is null then
      raise exception using errcode = 'OS409', message = 'ops.agent_profiles: the current profile is superseded before it may be deleted';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.superseded_at is not null
       or (pg_catalog.to_jsonb(new) - 'superseded_at') is distinct from (pg_catalog.to_jsonb(old) - 'superseded_at')
       or new.superseded_at is null then
      raise exception using errcode = 'OS409', message = 'ops.agent_profiles: a profile changes only by being superseded, once';
    end if;
    return new;
  end if;
  if new.superseded_at is not null then
    raise exception using errcode = 'OS409', message = 'ops.agent_profiles: a profile is born current';
  end if;
  if exists (select 1 from pg_catalog.unnest(new.capabilities) c
              where c is null or not exists (select 1 from ops.agent_run_capabilities() k where k.capability = c)) then
    raise exception using errcode = 'OS400', message = 'ops.agent_profiles: a capability is not an agent run capability';
  end if;
  if exists (select 1 from pg_catalog.unnest(new.data_classes) c
              where c is null or c not in ('synthetic', 'test', 'operational', 'identifier', 'person_text', 'health',
                                           'clinical_record', 'derived', 'unclassified')) then
    raise exception using errcode = 'OS400', message = 'ops.agent_profiles: a data class is not one of the closed set';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception using errcode = 'OS400', message = 'ops.agent_profiles: the time zone is not an IANA name';
  end if;
  for v_key, v_value in select * from pg_catalog.jsonb_each(new.capability_pools) loop
    if not (v_key = any (new.capabilities)) or pg_catalog.jsonb_typeof(v_value) <> 'string'
       or not exists (select 1 from ops.model_pools p
                        join ops.agent_run_capabilities() k on k.model_route = p.model_route
                       where p.name = v_value #>> '{}' and k.capability = v_key) then
      raise exception using errcode = 'OS400',
        message = 'ops.agent_profiles: a capability pool names a capability the agent lacks, or a pool that does not exist on that capability''s route tier';
    end if;
  end loop;
  new.recorded_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The start.
-- ---------------------------------------------------------------------------

-- The agent's charges today in its profile's time zone, split into settled
-- spend and calls still in flight (charged at their reservation).
create function ops.agent_spend_window(p_tenant_id uuid, p_agent_id uuid, p_timezone text,
                                       out p_settled bigint, out p_in_flight bigint)
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.sum(r.charged_cost_micros) filter (where r.status <> 'running'), 0)::bigint,
         coalesce(pg_catalog.sum(r.charged_cost_micros) filter (where r.status = 'running'), 0)::bigint
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.agent_id = p_agent_id
     and r.started_at >= ops.spend_window_start(p_timezone, now());
$$;

create or replace function ops.agent_run_reserved_error_codes()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['execution_stopped', 'execution_interrupted', 'database_contract',
               'job_failed', 'job_ended_before_start',
               'price_unavailable', 'route_policy_mismatch', 'spend_ceiling_unconfigured',
               'budget_unconfigured', 'budget_exhausted', 'data_not_authorized',
               'route_provider_mismatch',
               'model_route_unavailable', 'model_not_authorized', 'agent_budget_exhausted',
               'agent_not_permitted']::text[];
$function$;

create or replace function ops.start_agent_run(
  p_provider          text,
  p_model             text,
  p_prompt_version    text,
  p_input_fingerprint text,
  p_max_output_tokens integer
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt    integer := ops.agent_run_lease_attempt();
  v_tenant     uuid := ops.current_tenant_id();
  v_job        uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run        ops.agent_runs;
  v_task       ops.tasks;
  v_agent      ops.agents;
  v_company    text;
  v_department text;
  v_stop       uuid;
  v_code       text;
  v_price      uuid;
  v_max_output integer;
  v_reserved   bigint;
  v_limit      uuid;
  v_spend      record;
  v_auth       record;
  v_context    jsonb;
  v_pool       text;
  v_candidates jsonb;
  v_profile    ops.agent_profiles;
  v_has_profile boolean := false;
  v_agent_spend record;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.start_agent_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;

  if v_run.status = 'running' then
    if v_run.job_attempt is distinct from v_attempt then
      v_context := ops.push_event_context('agent-runtime', null, null);
      update ops.agent_runs
         set status = 'indeterminate', error_category = 'interrupted', error_code = 'execution_interrupted'
       where id = v_run.id;
      perform ops.pop_event_context(v_context);
      return 'indeterminate';
    end if;
    return 'already_running';
  end if;
  if v_run.status <> 'pending' then
    return v_run.status;
  end if;

  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,31}$'
     or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
     or p_prompt_version is null or p_prompt_version !~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'
     or p_input_fingerprint is null or p_input_fingerprint !~ '^[0-9a-f]{64}$'
     or p_max_output_tokens is null or p_max_output_tokens < 1 then
    raise exception using
      errcode = 'OS400',
      message = 'ops.start_agent_run: provider, model, prompt version, input fingerprint and output ceiling are required and well formed';
  end if;
  perform ops.require_read_committed('ops.start_agent_run');

  select t.* into v_task from ops.tasks t
   where t.id = v_run.task_id and t.tenant_id = v_run.tenant_id and t.company_id = v_run.company_id
     for share;
  select a.* into v_agent from ops.agents a
   where a.id = v_run.agent_id and a.tenant_id = v_run.tenant_id and a.company_id = v_run.company_id for share;
  select c.status into v_company from ops.companies c
   where c.id = v_run.company_id and c.tenant_id = v_run.tenant_id for share;
  select d.status into v_department from ops.departments d
   where d.id = v_run.department_id and d.tenant_id = v_run.tenant_id and d.company_id = v_run.company_id for share;
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.active_execution_stop(v_run.tenant_id, v_run.company_id, v_run.department_id, v_run.agent_id);
  if v_stop is not null then
    return 'stopped';
  end if;

  v_code := case
    when v_task.status in ('completed', 'failed', 'cancelled') then 'task_closed'
    when v_task.assigned_agent_id is distinct from v_run.agent_id then 'task_reassigned'
    when v_company is distinct from 'active' then 'company_inactive'
    when v_department is distinct from 'active' then 'department_inactive'
    when v_agent.status is distinct from 'active' then 'agent_inactive'
  end;

  if v_code is null and v_run.pinned_provider is not null and p_provider is distinct from v_run.pinned_provider then
    v_code := 'route_provider_mismatch';
  end if;

  -- ADR 0022 §G: an agent acts only within its definition. With a current
  -- profile, the run's capability and the task's data class must be in it.
  select ap.* into v_profile from ops.agent_profiles ap
   where ap.tenant_id = v_run.tenant_id and ap.agent_id = v_run.agent_id and ap.superseded_at is null;
  v_has_profile := found;
  if v_code is null and v_has_profile
     and not (v_run.capability = any (v_profile.capabilities) and v_task.data_class = any (v_profile.data_classes)) then
    v_code := 'agent_not_permitted';
  end if;

  if v_code is null then
    -- BASELINE Q8 (ADR 0020 §D4): the authoritative gate, unchanged.
    select a.p_authorized, a.p_authorization_id into v_auth
      from ops.model_data_authorized(v_run.tenant_id, v_task.data_class, v_run.capability, p_provider, p_model) a;
    if not coalesce(v_auth.p_authorized, false) then
      v_code := 'data_not_authorized';
    end if;
  end if;

  -- ADR 0022 §D: every provider that leaves this process must be one of the
  -- run's authorized candidates. The in-process fake is the only exception.
  if v_code is null and p_provider <> 'fake' then
    v_pool := ops.agent_run_pool(v_run.tenant_id, v_run.agent_id, v_run.capability, v_run.model_route);
    v_candidates := case when v_pool is null then '[]'::jsonb
                         else ops.model_pool_candidates(v_run.tenant_id, v_pool, v_task.data_class, v_run.capability) end;
    if jsonb_array_length(v_candidates) = 0 then
      v_code := 'model_route_unavailable';
    elsif not exists (select 1 from jsonb_array_elements(v_candidates) c
                       where c ->> 'gateway' = p_provider and c ->> 'model' = p_model) then
      v_code := 'model_not_authorized';
    end if;
  end if;

  if v_code is null then
    select p.max_output_tokens into v_max_output
      from ops.agent_run_route_policies() p
     where p.model_route = v_run.model_route;
    if v_max_output is null or v_max_output <> p_max_output_tokens then
      v_code := 'route_policy_mismatch';
    end if;
  end if;

  if v_code is null then
    v_price := ops.current_model_price(p_provider, p_model, now());
    if v_price is null then
      v_code := 'price_unavailable';
    end if;
  end if;

  if v_code is null then
    v_reserved := ops.agent_run_reservation_for(
      v_run.tenant_id, v_run.company_id, v_run.task_id, v_run.agent_id, v_run.model_route, v_price);
    if v_reserved is null then
      raise exception using
        errcode = 'OS400',
        message = 'ops.start_agent_run: the run''s reservation could not be derived';
    end if;
    select a.p_code, a.p_limit_id into v_spend
      from ops.spend_admission(v_run.tenant_id, v_run.company_id, v_reserved, true) a;
    if v_spend.p_code = 'budget_contended' then
      raise exception using
        errcode = 'OS429',
        message = 'ops.start_agent_run: the spend limits cannot absorb this run beside the calls in flight; try again after they settle';
    end if;
    v_code := v_spend.p_code;
    v_limit := v_spend.p_limit_id;
  end if;

  -- ADR 0022 §G: the agent's own daily ceiling, serialised per agent after the
  -- spend locks. Settled spend that leaves no room refuses the run; room taken
  -- only by calls still in flight is contention, retried once they settle
  -- (the split ops.spend_admission makes for the global and tenant limits).
  if v_code is null and v_has_profile then
    perform pg_advisory_xact_lock(hashtextextended('ops.agent_budget:' || v_run.agent_id::text, 0));
    select w.p_settled, w.p_in_flight into v_agent_spend
      from ops.agent_spend_window(v_run.tenant_id, v_run.agent_id, v_profile.timezone) w;
    if v_agent_spend.p_settled + v_reserved > v_profile.daily_cost_ceiling_micros then
      v_code := 'agent_budget_exhausted';
    elsif v_agent_spend.p_settled + v_agent_spend.p_in_flight + v_reserved > v_profile.daily_cost_ceiling_micros then
      raise exception using
        errcode = 'OS429',
        message = 'ops.start_agent_run: the agent''s daily ceiling cannot absorb this run beside its calls in flight; try again after they settle';
    end if;
  end if;

  if not exists (
    select 1
      from ops.jobs j
     where j.id = v_job
       and j.tenant_id = v_tenant
       and j.lease_owner = nullif(current_setting('app.worker_id', true), '')
       and j.status = 'leased'
       and j.attempts = v_attempt
       and j.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'ops.start_agent_run: the lease on this job ran out while the start waited; nothing was started'
      using errcode = '42501';
  end if;

  v_context := ops.push_event_context('agent-runtime', null, null);
  if v_code is not null then
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = v_code,
           spend_limit_id = v_limit
     where id = v_run.id;
    perform ops.pop_event_context(v_context);
    return 'cancelled';
  end if;

  update ops.agent_runs
     set status = 'running', provider = p_provider, model = p_model,
         prompt_version = p_prompt_version, input_fingerprint = p_input_fingerprint,
         job_attempt = v_attempt, price_id = v_price, reserved_cost_micros = v_reserved,
         data_authorization_id = v_auth.p_authorization_id
   where id = v_run.id;
  if v_pool is not null then
    insert into ops.agent_run_routes (agent_run_id, tenant_id, agent_id, capability, model_pool, candidates, gateway, model)
    values (v_run.id, v_run.tenant_id, v_run.agent_id, v_run.capability, v_pool, v_candidates, p_provider, p_model);
  end if;
  perform ops.pop_event_context(v_context);
  return 'running';
end
$function$;

comment on function ops.start_agent_run(text, text, text, text, integer) is
  'Re-checks every gate and the execution stops; then (ADR 0022) that a current agent profile permits the run''s capability and the task''s data class; the BASELINE Q8 data authorization; that a provider other than the in-process fake is one of the run''s authorized pool candidates; the price; the spend limits; and the agent''s daily ceiling under lock (settled spend refuses, calls in flight raise OS429). Then it records the run as running with its price version, reservation, data authorization and route. The caller commits this BEFORE calling the provider, and only the returned token running means call. A covering execution stop answers stopped and writes nothing. Codes: agent_not_permitted, data_not_authorized, model_route_unavailable (no authorized candidate), model_not_authorized (not one of them), agent_budget_exhausted. Resolves the run from the live lease; takes no id.';

-- ---------------------------------------------------------------------------
-- 6. The reaper.
-- ---------------------------------------------------------------------------

create or replace function ops.settle_stale_agent_runs()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_running integer;
  v_pending integer;
  v_decisions integer;
begin
  v_context := ops.push_event_context('agent-runtime', null, null);

  with stale as (
    select r.id
      from ops.agent_runs r
      join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
     where r.status = 'running'
       and not (j.status = 'leased' and j.lease_expires_at > clock_timestamp() and j.attempts = r.job_attempt)
     order by r.started_at
     limit 500
       for update of r, j skip locked
  )
  update ops.agent_runs r
     set status = 'indeterminate', error_category = 'interrupted', error_code = 'execution_interrupted'
    from stale s
   where r.id = s.id;
  get diagnostics v_running = row_count;

  with orphaned as (
    select r.id, j.status as job_status
      from ops.agent_runs r
      join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
     where r.status = 'pending'
       and j.status in ('failed', 'succeeded')
     order by r.created_at
     limit 500
       for update of r, j skip locked
  )
  update ops.agent_runs r
     set status = 'failed', error_category = 'job_failed',
         error_code = case when o.job_status = 'failed' then 'job_failed' else 'job_ended_before_start' end
    from orphaned o
   where r.id = o.id;
  get diagnostics v_pending = row_count;

  -- ADR 0022: a structured decision `running` whose job no longer holds a live
  -- lease -> indeterminate, charged at its reservation. The question may have
  -- been asked; it is never asked again.
  with stale_decisions as (
    select d.id
      from ops.structured_decisions d
      join ops.jobs j on j.tenant_id = d.tenant_id and j.id = d.job_id
     where d.status = 'running'
       and not (j.status = 'leased' and j.lease_expires_at > clock_timestamp())
     order by d.started_at
     limit 500
       for update of d, j skip locked
  )
  update ops.structured_decisions d
     set status = 'indeterminate', error_code = 'execution_interrupted', settled_at = now()
    from stale_decisions s
   where d.id = s.id;
  get diagnostics v_decisions = row_count;

  perform ops.pop_event_context(v_context);
  return v_running + v_pending + v_decisions;
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. Privileges: the one new function is executed by nobody directly.
-- ---------------------------------------------------------------------------

revoke all on function ops.agent_spend_window(uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 8. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
begin
  if ops.structured_decision_answers_valid('{"a":{"type":"choice","options":["x","y"]}}', '{"a":{"type":"choice"}}')
     or ops.structured_decision_answers_valid('{"s":{"type":"score","levels":3}}', '{"s":{"type":"score"}}')
     or ops.structured_decision_answers_valid('{"n":{"type":"noul"}}', '{"n":{"type":"noul"}}')
     or ops.structured_decision_answers_valid('{"a":{"type":"choice","options":["x"]}}',
                                              '{"a":{"type":"choice","choice":"x"},"b":{"type":"noul","noul":0.5}}')
     or not ops.structured_decision_answers_valid('{"a":{"type":"choice","options":["x"]},"n":{"type":"noul"}}',
                                                  '{"a":{"type":"choice","choice":"x"},"n":{"type":"noul","noul":0.4}}') then
    raise exception 'ops.structured_decision_answers_valid does not hold answers to exactly the asked questions';
  end if;

  if not ('agent_not_permitted' = any (ops.agent_run_reserved_error_codes())) then
    raise exception 'agent_not_permitted is not a code only the database decides';
  end if;

  -- ADR 0022 §D: the insert guard refuses new ones; none may predate it.
  if exists (select 1 from ops.model_data_authorizations a
              where a.provider = 'openrouter' and a.data_class in ('person_text', 'health') and a.retired_at is null) then
    raise exception 'OpenRouter holds a current authorization for protected content';
  end if;

  if exists (select 1 from ops.agent_profiles ap
              cross join lateral pg_catalog.jsonb_each_text(ap.capability_pools) cp (capability, pool)
              where ap.superseded_at is null
                and not exists (select 1 from ops.model_pools p
                                  join ops.agent_run_capabilities() k on k.model_route = p.model_route
                                 where p.name = cp.pool and k.capability = cp.capability)) then
    raise exception 'a current agent profile maps a capability to a pool on another route tier';
  end if;

  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_function_privilege(r.rolname, 'ops.agent_spend_window(uuid, uuid, text)', 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute ops.agent_spend_window: %', v_bad;
  end if;

  if not pg_catalog.has_function_privilege('ops_worker', 'ops.start_agent_run(text, text, text, text, integer)', 'EXECUTE')
     or not pg_catalog.has_function_privilege('ops_worker', 'ops.settle_stale_agent_runs()', 'EXECUTE')
     or not pg_catalog.has_function_privilege('ops_worker', 'ops.settle_structured_decision(text, jsonb, text, integer, integer, bigint, integer, text, text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'ops.start_agent_run(text, text, text, text, integer)', 'EXECUTE') then
    raise exception 'the replaced functions lost or widened their privileges';
  end if;
end
$end_state$;
