-- ADR 0022: the model registry, pools, agent profiles, the candidate and agent
-- budget gates in ops.start_agent_run, the Q8 refusal of OpenRouter for
-- protected data, and the structured decision ledger.
--
--   A  nothing but the owner reaches the new tables; the worker executes
--      exactly its five new capabilities;
--   B  the registry: identity and classes fixed, only the switch changes, never
--      deleted, no alias, no in-process gateway;
--   C  pools: definitions fixed; members owner data, removed once;
--   D  the candidates: enabled, priced, structured, authorized, in rank order;
--   E  the start: a provider that leaves the process runs only as one of the
--      run's authorized candidates (model_not_authorized, model_route_unavailable),
--      the route is recorded, the fake is unaffected, the agent ceiling holds;
--   F  Q8: OpenRouter cannot be authorized for person_text or health;
--   G  the structured decision ledger: born pending, answers held to the spec,
--      start refuses protected data and missing models, the cost counts in the
--      daily window, a settled decision is history.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

create temporary table mg_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into mg_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from mg_ids where name = p_name;
  if v is null then raise exception 'setup: no id named %', p_name; end if;
  return v;
end
$$;

create function pg_temp.attempt(p_sql text) returns text
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return sqlstate;
  end;
  return null;
end
$$;

create function pg_temp.expect(p_label text, p_state text, p_sql text) returns void
language plpgsql as $$
declare v text := pg_temp.attempt(p_sql);
begin
  if v is distinct from p_state then
    raise exception '%: expected SQLSTATE %, got %', p_label, coalesce(p_state, 'success'), coalesce(v, 'success');
  end if;
end
$$;

create function pg_temp.task(p_key text, p_class text) returns uuid
language plpgsql as $f$
declare v uuid;
begin
  v := ops.create_task(pg_temp.id('tenant'), pg_temp.id('company'), 'lead_triage', 'Lead triage', 'mg-suite',
                       'Synthetic enquiry ' || p_key, p_data_class => p_class);
  perform ops.assign_task(pg_temp.id('tenant'), v, pg_temp.id('agent'), 'mg-suite');
  return pg_temp.remember('task.' || p_key, v);
end
$f$;

create function pg_temp.request(p_key text) returns uuid
language sql as $$
  select pg_temp.remember('run.' || p_key,
    ops.request_agent_run(pg_temp.id('tenant'), pg_temp.id('task.' || p_key), pg_temp.id('agent'),
                          'lead_triage', 'mg-' || p_key, 'mg-suite'));
$$;

-- Lease a job as the worker and set the lease context.
create function pg_temp.lease(p_job uuid) returns void
language plpgsql as $f$
begin
  update ops.jobs
     set status = 'leased', lease_owner = 'mg-worker', leased_at = now(),
         lease_expires_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
   where id = p_job and status = 'queued';
  if not found then
    raise exception 'setup: job % is not queued', p_job;
  end if;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  select j.id, j.tenant_id, 'leased', 'mg-worker', j.attempts, j.kind from ops.jobs j where j.id = p_job;
  perform set_config('app.worker_id', 'mg-worker', true);
  perform set_config('app.job_id', p_job::text, true);
end
$f$;

create function pg_temp.start(p_key text, p_provider text, p_model text) returns text
language plpgsql as $f$
declare
  v_job uuid;
  v     text;
begin
  select r.job_id into v_job from ops.agent_runs r where r.id = pg_temp.id('run.' || p_key);
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  v := ops.start_agent_run(p_provider, p_model, 'lead_triage.v2',
                           encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), 8000);
  execute 'reset role';
  return v;
end
$f$;

create function pg_temp.run(p_key text) returns ops.agent_runs
language sql as $$ select r.* from ops.agent_runs r where r.id = pg_temp.id('run.' || p_key); $$;

do $$
declare
  ta uuid; co uuid; d uuid;
  m text;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('mg-test', 'MG Test', true) returning id into ta;
  perform pg_temp.remember('tenant', ta);
  co := pg_temp.remember('company', ops.create_company(ta, 'mg-clinic', 'MG Clinic', 'mg-suite'));
  d := ops.create_department(ta, co, 'reception', 'Reception', 'mg-suite');
  perform pg_temp.remember('department', d);
  perform pg_temp.remember('agent', ops.create_agent(ta, co, d, 'reception-agent', 'MG Reception',
                                                     'Synthetic receptionist', 'mg-suite'));
  perform ops.set_spend_limit('global', 900000000000, 'UTC', 'mg ceiling', 'mg-suite');
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'mg budget', 'mg-suite', ta);

  -- Four priced models, a fifth unpriced; four in the reception pool.
  foreach m in array array['mg/cheap', 'mg/strong', 'mg/outsider', 'mg/disabled'] loop
    perform ops.record_model_price('openrouter', m, 0.10, 0.50, true, now() - interval '1 minute',
                                   now() + interval '1 day', 'mg price source', 'mg-suite');
  end loop;
  perform ops.record_model('openrouter', 'mg/cheap', 'mgfam', array['mg/cheap-20260101'], true, false, false,
                           'long', 'fast', 'low', 'mg registry', 'mg-suite');
  perform ops.record_model('openrouter', 'mg/strong', 'mgfam', null, true, true, false, 'long', 'slow', 'high',
                           'mg registry', 'mg-suite');
  perform ops.record_model('openrouter', 'mg/outsider', 'mgfam', null, true, false, false, 'long', 'fast', 'low',
                           'mg registry', 'mg-suite');
  perform ops.record_model('openrouter', 'mg/disabled', 'mgfam', null, true, false, false, 'long', 'fast', 'low',
                           'mg registry', 'mg-suite');
  perform ops.record_model('openrouter', 'mg/unpriced', 'mgfam', null, true, false, false, 'long', 'fast', 'low',
                           'mg registry', 'mg-suite');
  perform ops.record_model('openrouter', 'mg/unstructured', 'mgfam', null, false, false, false, 'long', 'fast', 'low',
                           'mg registry', 'mg-suite');
  perform ops.record_model_price('openrouter', 'mg/unstructured', 0.10, 0.50, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'mg price source', 'mg-suite');
  perform ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/cheap', 1, 'mg-suite');
  perform ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/strong', 2, 'mg-suite');
  perform ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/disabled', 3, 'mg-suite');
  perform ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/unpriced', 4, 'mg-suite');
  perform ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/unstructured', 5, 'mg-suite');
  perform ops.set_model_enabled('openrouter', 'mg/disabled', false, 'mg test: disabled', 'mg-suite');
  perform ops.record_model_price('fake', 'mg-fake', 0.10, 0.50, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'mg price source', 'mg-suite');
end
$$;

-- ===========================================================================
-- A. Access.
-- ===========================================================================

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['model_registry', 'model_pools', 'model_pool_members', 'agent_profiles', 'agent_run_routes',
                           'structured_decisions', 'decision_outcomes'] loop
    foreach r in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
      if has_table_privilege(r, 'ops.' || t, 'SELECT,INSERT,UPDATE,DELETE') then
        raise exception 'A1: % holds a privilege on ops.%', r, t;
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_function_privilege(r, 'ops.record_model(text, text, text, text[], boolean, boolean, boolean, text, text, text, text, text)', 'EXECUTE')
       or has_function_privilege(r, 'ops.add_model_pool_member(text, text, text, integer, text)', 'EXECUTE')
       or has_function_privilege(r, 'ops.record_agent_profile(uuid, uuid, text, text[], text[], bigint, text, jsonb, text)', 'EXECUTE')
       or has_function_privilege(r, 'ops.record_decision_outcome(uuid, uuid, text, bigint, timestamptz, text)', 'EXECUTE')
       or has_function_privilege(r, 'ops.model_economics(uuid, timestamptz)', 'EXECUTE') then
      raise exception 'A2: % can execute an owner act or read of ADR 0022', r;
    end if;
  end loop;
  if not (has_function_privilege('ops_worker', 'ops.agent_run_model_candidates()', 'EXECUTE')
          and has_function_privilege('ops_worker', 'ops.record_agent_run_gateway_report(text, bigint)', 'EXECUTE')
          and has_function_privilege('ops_worker', 'ops.start_structured_decision(text)', 'EXECUTE')) then
    raise exception 'A3: the worker lost a capability ADR 0022 gives it';
  end if;
end
$$;

-- ===========================================================================
-- B. The registry.
-- ===========================================================================

do $$
begin
  perform pg_temp.expect('B1 a class rewritten', 'OS409',
    $q$update ops.model_registry set cost_class = 'high', changed_by = 'mg-suite', change_reason = 'x' where model = 'mg/cheap'$q$);
  perform pg_temp.expect('B2 a switch with nobody named', 'OS409',
    $q$update ops.model_registry set enabled = false where model = 'mg/cheap'$q$);
  perform pg_temp.expect('B3 an enabled model deleted', 'OS409', $q$delete from ops.model_registry where model = 'mg/cheap'$q$);
  perform pg_temp.expect('B3 a disabled model still in a pool deleted', 'OS409',
    $q$delete from ops.model_registry where model = 'mg/disabled'$q$);
  perform pg_temp.expect('B4 an alias registered', '23514', $q$select ops.record_model('openrouter', '~mg/latest', 'mgfam',
    null, true, false, false, 'long', 'fast', 'low', 'x', 'mg-suite')$q$);
  perform pg_temp.expect('B5 the in-process gateway registered', '23514', $q$select ops.record_model('fake', 'mg/x', 'mgfam',
    null, true, false, false, 'long', 'fast', 'low', 'x', 'mg-suite')$q$);
  perform pg_temp.expect('B6 a model registered twice', 'OS409', $q$select ops.record_model('openrouter', 'mg/cheap', 'mgfam',
    null, true, false, false, 'long', 'fast', 'low', 'x', 'mg-suite')$q$);
end
$$;

-- ===========================================================================
-- C. Pools.
-- ===========================================================================

do $$
begin
  perform pg_temp.expect('C1 a pool redefined', 'OS409',
    $q$update ops.model_pools set model_route = 'reasoning' where name = 'reception_low_cost'$q$);
  perform pg_temp.expect('C2 a pool deleted', 'OS409', $q$delete from ops.model_pools where name = 'general_fast'$q$);
  perform pg_temp.expect('C3 an active member deleted', 'OS409',
    $q$delete from ops.model_pool_members where pool = 'reception_low_cost'$q$);
  perform pg_temp.expect('C4 a member added twice', '23505',
    $q$select ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/cheap', 9, 'mg-suite')$q$);
  perform pg_temp.expect('C5 two members on one rank', '23505',
    $q$select ops.add_model_pool_member('reception_low_cost', 'openrouter', 'mg/outsider', 1, 'mg-suite')$q$);
end
$$;

-- ===========================================================================
-- D. The candidates.
-- ===========================================================================

do $$
declare
  v jsonb;
begin
  v := ops.model_pool_candidates(pg_temp.id('tenant'), 'reception_low_cost', 'synthetic', 'lead_triage');
  if (select jsonb_agg(c ->> 'model' order by (c ->> 'rank')::int) from jsonb_array_elements(v) c)
       is distinct from '["mg/cheap", "mg/strong"]'::jsonb then
    raise exception 'D1: the candidates are not exactly the enabled, priced, structured members in rank order: %', v;
  end if;
  if (v -> 0 -> 'acceptedBuilds') is distinct from '["mg/cheap-20260101"]'::jsonb then
    raise exception 'D2: a candidate does not carry its accepted builds';
  end if;
  -- Health data with no authorization: no candidate at all.
  if jsonb_array_length(ops.model_pool_candidates(pg_temp.id('tenant'), 'reception_low_cost', 'health', 'lead_triage')) <> 0 then
    raise exception 'D3: an unauthorized class has candidates';
  end if;
  -- The pool on another tier is no pool for a standard run.
  if ops.agent_run_pool(pg_temp.id('tenant'), pg_temp.id('agent'), 'lead_triage', 'reasoning') is not null
     or ops.agent_run_pool(pg_temp.id('tenant'), pg_temp.id('agent'), 'lead_triage', 'standard') <> 'reception_low_cost' then
    raise exception 'D4: the pool of a run does not follow the capability default and the route tier';
  end if;
end
$$;

-- ===========================================================================
-- E. The start.
-- ===========================================================================

do $$
declare
  r  ops.agent_runs;
  v  text;
  rr ops.agent_run_routes;
begin
  -- E1 a priced, registered model outside the pool is not a candidate.
  perform pg_temp.task('e-outsider', 'synthetic');
  perform pg_temp.request('e-outsider');
  v := pg_temp.start('e-outsider', 'openrouter', 'mg/outsider');
  r := pg_temp.run('e-outsider');
  if v <> 'cancelled' or r.error_code <> 'model_not_authorized' or r.provider is not null then
    raise exception 'E1: a model outside the authorized candidates started (%, %)', v, r.error_code;
  end if;

  -- E2 a disabled member is not a candidate either.
  perform pg_temp.task('e-disabled', 'synthetic');
  perform pg_temp.request('e-disabled');
  if pg_temp.start('e-disabled', 'openrouter', 'mg/disabled') <> 'cancelled'
     or (pg_temp.run('e-disabled')).error_code <> 'model_not_authorized' then
    raise exception 'E2: a disabled model started';
  end if;

  -- E3 a candidate starts, and its route is recorded.
  perform pg_temp.task('e-cheap', 'synthetic');
  perform pg_temp.request('e-cheap');
  v := pg_temp.start('e-cheap', 'openrouter', 'mg/cheap');
  r := pg_temp.run('e-cheap');
  select * into rr from ops.agent_run_routes where agent_run_id = r.id;
  if v <> 'running' or rr.model_pool <> 'reception_low_cost' or rr.model <> 'mg/cheap' or rr.gateway <> 'openrouter'
     or jsonb_array_length(rr.candidates) <> 2 or rr.reported_at is not null then
    raise exception 'E3: the candidate did not start with its route recorded (%, %)', v, rr;
  end if;

  -- E4 the gateway report is recorded once, by the worker settling the run.
  execute 'set local role ops_worker';
  if ops.record_agent_run_gateway_report('DeepInfra', 28) <> 'recorded'
     or ops.record_agent_run_gateway_report('Other', 1) <> 'no_route' then
    raise exception 'E4: the gateway report is not recorded exactly once';
  end if;
  perform pg_temp.expect('E4 a malformed report', 'OS400',
    $q$select ops.record_agent_run_gateway_report('bad;route', 1)$q$);
  execute 'reset role';
  select * into rr from ops.agent_run_routes where agent_run_id = r.id;
  if rr.provider_route <> 'DeepInfra' or rr.reported_cost_micros <> 28 then
    raise exception 'E4: the report was not kept';
  end if;
  perform pg_temp.expect('E5 a route rewritten', 'OS409',
    format($q$update ops.agent_run_routes set model = 'mg/strong' where agent_run_id = %L$q$, r.id));
  perform pg_temp.expect('E5 the route of a running run deleted', 'OS409',
    format($q$delete from ops.agent_run_routes where agent_run_id = %L$q$, r.id));

  -- E6 the in-process fake is not a gateway: unaffected, no route row.
  perform pg_temp.task('e-fake', 'synthetic');
  perform pg_temp.request('e-fake');
  if pg_temp.start('e-fake', 'fake', 'mg-fake') <> 'running'
     or exists (select 1 from ops.agent_run_routes where agent_run_id = pg_temp.id('run.e-fake')) then
    raise exception 'E6: the in-process fake was held to the gateway gate';
  end if;

  -- E7 an agent profile that sends the capability to an empty pool: no candidate.
  perform ops.record_agent_profile(pg_temp.id('tenant'), pg_temp.id('agent'), 'Triage synthetic enquiries.',
                                   array['lead_triage'], array['synthetic', 'test'], 1000000, 'America/Sao_Paulo',
                                   '{"lead_triage": "general_fast"}'::jsonb, 'mg-suite');
  perform pg_temp.task('e-empty', 'synthetic');
  perform pg_temp.request('e-empty');
  if pg_temp.start('e-empty', 'openrouter', 'mg/cheap') <> 'cancelled'
     or (pg_temp.run('e-empty')).error_code <> 'model_route_unavailable' then
    raise exception 'E7: a run started with no authorized candidate in its pool';
  end if;

  -- E8 the agent's daily ceiling: one micro-dollar is less than any reservation.
  perform ops.record_agent_profile(pg_temp.id('tenant'), pg_temp.id('agent'), 'Triage synthetic enquiries.',
                                   array['lead_triage'], array['synthetic', 'test'], 1, 'America/Sao_Paulo',
                                   '{}'::jsonb, 'mg-suite');
  if (select count(*) from ops.agent_profiles where agent_id = pg_temp.id('agent') and superseded_at is null) <> 1 then
    raise exception 'E8: a profile version did not supersede the current one';
  end if;
  perform pg_temp.task('e-budget', 'synthetic');
  perform pg_temp.request('e-budget');
  if pg_temp.start('e-budget', 'openrouter', 'mg/cheap') <> 'cancelled'
     or (pg_temp.run('e-budget')).error_code <> 'agent_budget_exhausted' then
    raise exception 'E8: the agent ceiling did not hold (%)', (pg_temp.run('e-budget')).error_code;
  end if;

  -- E9 a profile is superseded, never edited or deleted, and names no unknown pool.
  perform pg_temp.expect('E9 a profile edited', 'OS409',
    format($q$update ops.agent_profiles set objective = 'x' where agent_id = %L and superseded_at is null$q$, pg_temp.id('agent')));
  perform pg_temp.expect('E9 the current profile deleted', 'OS409',
    format($q$delete from ops.agent_profiles where agent_id = %L and superseded_at is null$q$, pg_temp.id('agent')));
  perform pg_temp.expect('E9 an unknown pool', 'OS400', format($q$select ops.record_agent_profile(%L, %L, 'x',
    array['lead_triage'], array['synthetic'], 10, 'UTC', '{"lead_triage": "no_such_pool"}'::jsonb, 'mg-suite')$q$,
    pg_temp.id('tenant'), pg_temp.id('agent')));
  perform pg_temp.expect('E9 a tool granted', '23514', format($q$insert into ops.agent_profiles (tenant_id, company_id,
    agent_id, objective, capabilities, tools, data_classes, escalation_policy, review_policy, daily_cost_ceiling_micros,
    timezone, recorded_by) values (%L, %L, %L, 'x', array['lead_triage'], array['send_message'], array['synthetic'],
    'human_review_always', 'human_review_required', 10, 'UTC', 'mg-suite')$q$,
    pg_temp.id('tenant'), pg_temp.id('company'), pg_temp.id('agent')));
end
$$;

-- ===========================================================================
-- F. Q8: OpenRouter is never authorized for protected classes here.
-- ===========================================================================

do $$
declare
  k text;
begin
  foreach k in array array['health', 'person_text'] loop
    perform pg_temp.expect('F1 OpenRouter authorized for ' || k, 'OS403', format($q$
      select ops.record_model_data_authorization(%L, %L, 'lead_triage', 'openrouter', 'mg/cheap',
        now() - interval '1 hour', now() + interval '1 day', 'fixture:e', now() - interval '2 hours', true,
        'fixture:c', 'fixture:d', 'fixture:z', 'fixture:r', 'fixture:t', 'fixture:l', 7, 'mg-suite')$q$,
      pg_temp.id('tenant'), k));
  end loop;
end
$$;

-- ===========================================================================
-- G. The structured decision ledger.
-- ===========================================================================

do $$
declare
  v_spec jsonb := '{"intent": {"type": "choice", "options": ["new_lead", "unknown"]},
                    "complexity": {"type": "score", "levels": 3},
                    "human_review": {"type": "noul"}}'::jsonb;
begin
  if not ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "choice", "choice": "new_lead",
        "confidence": 0.8, "probabilities": {"new_lead": 0.9, "unknown": 0.1}},
        "complexity": {"type": "score", "score": 0.4, "probabilities": {"0": 0.7, "1": 0.3}},
        "human_review": {"type": "noul", "noul": 0.2}}'::jsonb) then
    raise exception 'G1: valid answers were refused';
  end if;
  if ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "choice", "choice": "diagnose"},
        "complexity": {"type": "score", "score": 0.4}, "human_review": {"type": "noul", "noul": 0.2}}'::jsonb)
     or ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "choice", "choice": "new_lead"},
        "complexity": {"type": "score", "score": 3}, "human_review": {"type": "noul", "noul": 0.2}}'::jsonb)
     or ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "choice", "choice": "new_lead"},
        "complexity": {"type": "score", "score": 1}}'::jsonb)
     or ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "choice", "choice": "new_lead",
        "probabilities": {"diagnosis": 1}}, "complexity": {"type": "score", "score": 1},
        "human_review": {"type": "noul", "noul": 0.2}}'::jsonb)
     or ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "noul", "noul": 0.5},
        "complexity": {"type": "score", "score": 1}, "human_review": {"type": "noul", "noul": 0.2}}'::jsonb)
     or ops.structured_decision_answers_valid(v_spec, '{"intent": {"type": "choice", "choice": "new_lead"},
        "complexity": {"type": "score", "score": 1}, "human_review": {"type": "noul", "noul": 1.5}}'::jsonb) then
    raise exception 'G2: invalid answers were accepted';
  end if;
end
$$;

-- G3: a decision for a settled synthetic run, its start and settlement as the
-- worker; then the same for a health task, refused before any call.
do $$
declare
  v_run  uuid := pg_temp.id('run.e-cheap');
  v_dec  uuid;
  v_job  uuid;
  v      jsonb;
  s      text;
  d      ops.structured_decisions;
  v_before record;
  v_after  record;
begin
  -- The Jev stand-in: a priced decision model in the structured_decision pool.
  perform ops.record_model_price('openrouter', 'mg/decider-1', 0.042, 0, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'mg price source', 'mg-suite');
  perform ops.record_model('openrouter', 'mg/decider-1', 'mgdecide', array['mg/decider-1-20260917'], true, false,
                           false, 'short', 'fast', 'low', 'mg registry', 'mg-suite');
  perform ops.add_model_pool_member('structured_decision', 'openrouter', 'mg/decider-1', 1, 'mg-suite');

  perform pg_temp.expect('G3 a decision born running', 'OS409', format($q$insert into ops.structured_decisions
    (tenant_id, company_id, department_id, agent_id, task_id, agent_run_id, decision_kind, question_set,
     idempotency_key, status, started_at) values (%L, %L, %L, %L, %L, %L, 'business_route', 'business_routing.v1',
     'x', 'running', now())$q$, pg_temp.id('tenant'), pg_temp.id('company'), pg_temp.id('department'),
     pg_temp.id('agent'), pg_temp.id('task.e-cheap'), v_run));

  insert into ops.structured_decisions (tenant_id, company_id, department_id, agent_id, task_id, agent_run_id,
                                        decision_kind, question_set, idempotency_key, status, deterministic_route)
  values (pg_temp.id('tenant'), pg_temp.id('company'), pg_temp.id('department'), pg_temp.id('agent'),
          pg_temp.id('task.e-cheap'), v_run, 'business_route', 'business_routing.v1', 'mg:business', 'pending',
          '{"department": "reception", "capability": "lead_triage"}'::jsonb)
  returning id into v_dec;
  v_job := ops.enqueue_job(pg_temp.id('tenant'), 'decision.structured_evaluate',
                           jsonb_build_object('structured_decision_id', v_dec), 100, now(), 3, 'mg:business');
  update ops.structured_decisions set job_id = v_job where id = v_dec;

  select t.p_charged, t.p_settled into v_before
    from ops.spend_window_total('tenant', pg_temp.id('tenant'), null, now() - interval '1 hour') t;

  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  v := ops.start_structured_decision('openrouter');
  execute 'reset role';
  if v ->> 'status' <> 'running' or v ->> 'model' <> 'mg/decider-1' or v ->> 'kind' <> 'business_route'
     or (v -> 'spec' -> 'department' -> 'options') is distinct from '["reception", "human_review", "no_action"]'::jsonb
     or v -> 'input' ->> 'message' <> 'Synthetic enquiry e-cheap' then
    raise exception 'G3: the business decision did not start with its spec and input: %', v;
  end if;

  select t.p_charged, t.p_settled into v_after
    from ops.spend_window_total('tenant', pg_temp.id('tenant'), null, now() - interval '1 hour') t;
  select * into d from ops.structured_decisions where id = v_dec;
  if v_after.p_charged - v_before.p_charged <> d.reserved_cost_micros or d.reserved_cost_micros <= 0 then
    raise exception 'G4: the decision''s reservation is not counted in the daily window (% -> %, %)',
      v_before.p_charged, v_after.p_charged, d.reserved_cost_micros;
  end if;

  -- A substituted build is invalid, never completed.
  execute 'set local role ops_worker';
  s := ops.settle_structured_decision('completed',
         '{"intent": {"type": "choice", "choice": "new_lead"}, "department": {"type": "choice", "choice": "reception"},
           "capability": {"type": "choice", "choice": "lead_triage"}, "complexity": {"type": "score", "score": 0.2},
           "human_review": {"type": "noul", "noul": 0.1}}'::jsonb,
         'other/model', 400, 20, 17, 350, 'TypeSafe', null);
  execute 'reset role';
  select * into d from ops.structured_decisions where id = v_dec;
  if s <> 'invalid' or d.error_code <> 'model_substituted' or d.answers is not null
     or d.charged_cost_micros <> ceil(400 * 0.042)::bigint then
    raise exception 'G5: a substituted build was not settled invalid with its cost (%, %, %)', s, d.error_code, d.charged_cost_micros;
  end if;
  perform pg_temp.expect('G6 a settled decision rewritten', 'OS409',
    format($q$update ops.structured_decisions set error_code = 'x' where id = %L$q$, v_dec));
  insert into ops.structured_decisions (tenant_id, company_id, department_id, agent_id, task_id, agent_run_id,
                                        decision_kind, question_set, idempotency_key, status)
  values (pg_temp.id('tenant'), pg_temp.id('company'), pg_temp.id('department'), pg_temp.id('agent'),
          pg_temp.id('task.e-cheap'), v_run, 'lead_intelligence', 'lead_intelligence.v1', 'mg:pending', 'pending')
  returning id into v_dec;
  perform pg_temp.expect('G6 a decision in progress deleted', 'OS409',
    format($q$delete from ops.structured_decisions where id = %L$q$, v_dec));
end
$$;

-- G7: protected data never reaches the decision model, and no decision model
-- means no call.
do $$
declare
  v_dec uuid;
  v_job uuid;
  v     jsonb;
begin
  perform pg_temp.task('g-health', 'health');
  insert into ops.structured_decisions (tenant_id, company_id, department_id, agent_id, task_id, agent_run_id,
                                        decision_kind, question_set, idempotency_key, status)
  values (pg_temp.id('tenant'), pg_temp.id('company'), pg_temp.id('department'), pg_temp.id('agent'),
          pg_temp.id('task.g-health'), pg_temp.id('run.e-cheap'), 'business_route', 'business_routing.v1',
          'mg:health', 'pending')
  returning id into v_dec;
  v_job := ops.enqueue_job(pg_temp.id('tenant'), 'decision.structured_evaluate',
                           jsonb_build_object('structured_decision_id', v_dec), 100, now(), 3, 'mg:health');
  update ops.structured_decisions set job_id = v_job where id = v_dec;
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  v := ops.start_structured_decision('openrouter');
  execute 'reset role';
  if v ->> 'status' <> 'refused' or v ->> 'refusalCode' <> 'data_not_authorized' or v ? 'input' then
    raise exception 'G7: a health task reached the decision model: %', v;
  end if;

  -- No enabled decision model on the gateway: refused, nothing called.
  perform ops.set_model_enabled('openrouter', 'mg/decider-1', false, 'mg test', 'mg-suite');
  insert into ops.structured_decisions (tenant_id, company_id, department_id, agent_id, task_id, agent_run_id,
                                        decision_kind, question_set, idempotency_key, status)
  values (pg_temp.id('tenant'), pg_temp.id('company'), pg_temp.id('department'), pg_temp.id('agent'),
          pg_temp.id('task.e-cheap'), pg_temp.id('run.e-cheap'), 'business_route', 'business_routing.v1',
          'mg:nomodel', 'pending')
  returning id into v_dec;
  v_job := ops.enqueue_job(pg_temp.id('tenant'), 'decision.structured_evaluate',
                           jsonb_build_object('structured_decision_id', v_dec), 100, now(), 3, 'mg:nomodel');
  update ops.structured_decisions set job_id = v_job where id = v_dec;
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  v := ops.start_structured_decision('openrouter');
  execute 'reset role';
  if v ->> 'refusalCode' <> 'model_route_unavailable' then
    raise exception 'G8: a decision started with no enabled decision model: %', v;
  end if;
end
$$;

rollback;
