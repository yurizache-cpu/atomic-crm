-- Phase 2C (S2) — attacks on the Company OS operator read surface.
--
-- The question: can a browser request through company_os_api reach anything
-- but its own tenant's pinned, minimised projections, choose a tenant, a
-- principal or an operation, identify itself any other way than through a
-- verified session of an auth user holding exactly one eligible membership,
-- or reach anything in ops the capability graph does not pin?
--
-- WHAT THIS SUITE PROVES (docs/PHASE_2C_BRIEF.md §7, §9-§11, §13, §15, §16 "O"),
-- in the order the sections run:
--   * T: tenant isolation. Tenant A's outputs do not change when tenant B is
--     busy, and a platform stop or the global ceiling changes them only at the
--     pinned platform-derived paths; every id and cursor parameter, fed another
--     tenant's ids of every kind, own ids of the wrong kind, platform ids,
--     malformed and erased values, answers exactly like a fresh random uuid;
--     and the reads write no row (this transaction's own write counters).
--   * E: the cursor-paged reads use their indexes (brief §11): EXPLAIN of
--     each projection's own page statement, and the scan counts of the reads
--     as they run.
--   * N: minimisation. Sentinels planted in every excluded column and payload
--     key never leave; key sets are pinned; cursors; the event allowlists; the
--     advice branches; the legacy actor labels (brief §16 fixtures A to D); no
--     global sequence value; a stored reference to a platform row leaves as
--     null, and one to another tenant's row as the fixed OS500; every list in
--     its pinned order, proven on rows with distinct times, under any plan.
--   * L: the agent list cap; get_agent answers an agent past it; the
--     overview counts every agent, past the cap included.
--   * I: the identity matrix. Every function refuses every non-member shape
--     with its one fixed OS401, OS403 or OS409, byte-identical across shapes,
--     before any argument can produce OS400 or OS404.
--   * M: the principal is the auth user id; the membership model is
--     tenant-generic and the Phase 2C eligibility policy one predicate; the
--     binding is immutable.
--   * P: the capability graph, pinned from the live catalogue: the exposed
--     catalogue with full signatures, the gates, the internal functions; every
--     owner, ACL, security mode, search path and volatility; each exposed body
--     one call to its own gate; each gate the resolver, one pinned callee and
--     no-store; a catalogue-driven callee denylist; ops_operator_api's
--     attributes, members, memberships and privileges; K4 and K5; the default
--     privileges reaching ops or company_os_api; the platform role closure
--     (owner decision S0-G), pinned as observed, not approved.
--   * X: deliberate mutations make the pins fail by name, the role's own
--     42501 backstop is exercised, and list_events' subject check is shown to
--     fail closed for a subject type it does not name.
--   Left to the driver-backed suites (engine/domain/*.dbtest.ts) and the live
--   probe (companyOsApiExposure.mjs): real leases and workers, contention,
--   PostgREST itself and real GoTrue sessions.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only. The auth users, sessions,
-- principals and memberships below exist only inside it. Every refusal is
-- compared as (SQLSTATE, message, detail, hint).

\set ON_ERROR_STOP on

begin;

-- A lock this suite waits on (another session's open transaction on a shared
-- stack) fails it instead of hanging it.
set local lock_timeout = '20s';

-- Membership is needed to `set role ops_worker` for the worker capabilities
-- that build the fixtures. `grant <role> to current_user` crashes this server
-- build (owner decision S0-F): interpolate, and only inside this transaction.
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Helpers. Temporary, so they vanish with the transaction.
-- ---------------------------------------------------------------------------

create temporary table cos_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into cos_ids (name, id) values (p_name, p_id) returning id;
$$;

-- Volatile on purpose: the planner may evaluate a STABLE call with constant
-- arguments while estimating, under a snapshot that misses the ids a block
-- has just remembered.
create function pg_temp.id(p_name text) returns uuid
language plpgsql volatile as $$
declare v uuid;
begin
  select id into v from cos_ids where name = p_name;
  if v is null then
    raise exception 'setup: no fixture named %', p_name;
  end if;
  return v;
end
$$;

-- Runs one statement and requires it to fail with this SQLSTATE and a message
-- matching this pattern (a refusal for the wrong reason proves nothing).
create function pg_temp.expect_refused(p_label text, p_sqlstate text, p_message text, p_sql text)
returns void
language plpgsql as $f$
declare
  v_state   text;
  v_message text;
begin
  begin
    execute p_sql;
    raise exception using errcode = 'C1CAC', message = 'accepted';
  exception when others then
    v_state := sqlstate;
    v_message := sqlerrm;
  end;
  if v_state = 'C1CAC' then
    raise exception '%: ACCEPTED, expected a refusal with SQLSTATE %', p_label, p_sqlstate;
  end if;
  if v_state <> p_sqlstate or v_message !~ p_message then
    raise exception '%: expected SQLSTATE % matching "%", got % (%)', p_label, p_sqlstate, p_message, v_state, v_message;
  end if;
end
$f$;

-- The claims PostgREST sets after verifying a JWT, for a named fixture user.
create function pg_temp.claims(p_who text, p_patch jsonb default '{}', p_remove text[] default '{}')
returns text
language plpgsql volatile as $f$
declare
  v jsonb;
begin
  v := jsonb_build_object(
    'sub', pg_temp.id('user.' || p_who), 'role', 'authenticated', 'aud', 'authenticated',
    'session_id', pg_temp.id('session.' || p_who), 'is_anonymous', false,
    'iss', 'http://127.0.0.1:54341/auth/v1', 'exp', extract(epoch from now() + interval '1 hour')::bigint)
    || p_patch;
  return (v - p_remove)::text;
end
$f$;

-- One simulated PostgREST request: the verified claims, then the call as the
-- request's role. Returns the body, or the refusal as (SQLSTATE, message,
-- detail, hint). An error rolls the subtransaction back, role included.
create function pg_temp.api(p_claims text, p_call text, p_role text default 'authenticated',
                            p_legacy_sub text default null)
returns jsonb
language plpgsql as $f$
declare
  v_body   jsonb;
  v_state  text;
  v_msg    text;
  v_detail text;
  v_hint   text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(p_legacy_sub, ''), true);
  perform set_config('request.jwt.claim.role', case when p_legacy_sub is null then '' else 'authenticated' end, true);
  begin
    execute format('set local role %I', p_role);
    execute 'select ' || p_call into v_body;
    execute 'reset role';
    return jsonb_build_object('ok', true, 'body', v_body);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('ok', false, 'code', v_state, 'message', v_msg,
                              'detail', v_detail, 'hint', v_hint);
  end;
end
$f$;

-- The same call as the member of tenant A; its body, or the named failure.
create function pg_temp.member_body(p_label text, p_call text, p_who text default 'm_a')
returns jsonb
language plpgsql as $f$
declare
  v jsonb := pg_temp.api(pg_temp.claims(p_who), p_call);
begin
  if not (v ->> 'ok')::boolean then
    raise exception '%: % was refused: %', p_label, p_call, v;
  end if;
  return v -> 'body';
end
$f$;

-- asOf and serverTime are the only values a repeated read may change.
create function pg_temp.untimed(p jsonb) returns jsonb
language plpgsql immutable as $f$
begin
  return case jsonb_typeof(p)
    when 'object' then (select coalesce(jsonb_object_agg(k, pg_temp.untimed(v)), '{}'::jsonb)
                          from jsonb_each(p) as e (k, v) where k not in ('asOf', 'serverTime'))
    when 'array' then (select coalesce(jsonb_agg(pg_temp.untimed(v) order by i), '[]'::jsonb)
                         from jsonb_array_elements(p) with ordinality as e (v, i))
    else p end;
end
$f$;

-- Every leaf path at which two outputs differ, arrays indexed.
create function pg_temp.json_diff(a jsonb, b jsonb, p text default '') returns setof text
language plpgsql immutable as $f$
declare
  k text;
  i int;
begin
  if a is not distinct from b then
    return;
  end if;
  if jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
    for k in select x from jsonb_object_keys(a) x union select x from jsonb_object_keys(b) x loop
      return query select * from pg_temp.json_diff(a -> k, b -> k, p || '.' || k);
    end loop;
  elsif jsonb_typeof(a) = 'array' and jsonb_typeof(b) = 'array'
        and jsonb_array_length(a) = jsonb_array_length(b) then
    for i in 0 .. jsonb_array_length(a) - 1 loop
      return query select * from pg_temp.json_diff(a -> i, b -> i, p || '[' || i || ']');
    end loop;
  else
    return next p;
  end if;
end
$f$;

-- Every object key path of an output, array positions folded to [].
create function pg_temp.key_paths(p jsonb, p_path text default '') returns setof text
language plpgsql immutable as $f$
declare
  k text;
  v jsonb;
begin
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      return next p_path || '.' || k;
      return query select * from pg_temp.key_paths(v, p_path || '.' || k);
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select * from jsonb_array_elements(p) loop
      return query select * from pg_temp.key_paths(v, p_path || '[]');
    end loop;
  end if;
end
$f$;

-- A lease on one run's job, taken the way ops.lease_job takes it but only on
-- that job, so a job some other suite left queued is never leased here.
create function pg_temp.lease(p_run uuid, p_worker text) returns uuid
language plpgsql as $f$
declare
  v_job uuid;
begin
  select job_id into v_job from ops.agent_runs where id = p_run;
  update ops.jobs
     set status = 'leased', lease_owner = p_worker, leased_at = now(),
         lease_expires_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
   where id = v_job and status = 'queued';
  if not found then
    raise exception 'setup: the job of run % is not queued', p_run;
  end if;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  select j.id, j.tenant_id, 'leased', p_worker, j.attempts, j.kind from ops.jobs j where j.id = v_job;
  perform set_config('app.worker_id', p_worker, true);
  perform set_config('app.job_id', v_job::text, true);
  return v_job;
end
$f$;

-- Claim and start a run through the worker's own capabilities.
create function pg_temp.start_run(p_run uuid, p_worker text) returns void
language plpgsql as $f$
declare
  v_state text;
begin
  perform pg_temp.lease(p_run, p_worker);
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'cos-api-model-7', 'lead_triage.v1',
                                 encode(sha256(convert_to(p_run::text, 'UTF8')), 'hex'), 8000);
  execute 'reset role';
  if v_state is distinct from 'running' then
    raise exception 'setup: run % did not start (%)', p_run, v_state;
  end if;
end
$f$;

-- Settle a started run: succeeded (and its review opened after the
-- settlement, as the worker does), or failed or indeterminate by category.
create function pg_temp.settle_run(p_run uuid, p_worker text, p_key text, p_category text, p_result jsonb)
returns void
language plpgsql as $f$
declare
  v_job uuid;
begin
  select job_id into v_job from ops.agent_runs where id = p_run;
  perform set_config('app.worker_id', p_worker, true);
  perform set_config('app.job_id', v_job::text, true);
  execute 'set local role ops_worker';
  if p_category is null then
    perform ops.complete_agent_run(p_result, 'cos-api-model-7', 'completed',
      'sentinel-' || p_key || '-provider-req', 'sentinel-' || p_key || '-provider-resp', 120, 60, 180, 0, 0, 42);
  else
    perform ops.fail_agent_run(p_category, 'cos_api_' || p_category, 'cos-api-model-7',
      'sentinel-' || p_key || '-provider-req-' || p_category, null, 120, 0, 120, 0, 0, 42);
  end if;
  perform ops.complete_job(v_job);
  if p_category is null then
    perform ops.open_review_for_settled_job(p_worker, v_job);
  end if;
  execute 'reset role';
end
$f$;

-- A valid lead_triage result. Its summary and next action are the only
-- content the advice may return; its reply draft never leaves.
create function pg_temp.triage_result(p_key text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'outcome', 'triaged', 'intent', 'book_appointment', 'priority', 'normal',
    'summary', 'SENTINEL-' || upper(p_key) || '-SUMMARY a synthetic person asks about a first appointment.',
    'recommended_next_action', 'SENTINEL-' || upper(p_key) || '-NEXT offer two synthetic slots.',
    'response_draft', 'SENTINEL-' || upper(p_key) || '-DRAFT', 'needs_human_review', false,
    'flags', jsonb_build_array('unclear'));
$$;

-- p_source is the admission's source, which the run stores as requested_by.
create function pg_temp.admit(p_key text, p_n int, p_tenant uuid, p_company uuid, p_agent uuid,
                              p_source text default 'cos-api-suite') returns jsonb
language sql as $$
  select ops.admit_inbound_message(
    p_tenant, p_company, p_agent, 'synthetic', 'sentinel-' || p_key || '-ext-' || p_n,
    'synthetic:sentinel-' || p_key || '-contact-' || p_n,
    'SENTINEL-' || upper(p_key) || '-BODY-' || p_n || ' synthetic hello', p_source, false, now());
$$;

-- One tenant's office, in every state the projections distinguish, built
-- through the domain services, the admission paths and the worker's own
-- capabilities so every event is real. p_key names its fixtures (a., b.) and
-- its sentinels (SENTINEL-A-..., SENTINEL-B-...); p_legacy is the free-form
-- actor label the owner CLI could have stored (brief §16, fixtures A to C).
create function pg_temp.build_office(
  p_key text, p_tenant uuid, p_company_name text, p_agent_name text, p_channel_label text,
  p_legacy text, p_target text, p_phone text, p_limit bigint, p_note text, p_stop_reason text,
  p_cleared_reason text)
returns void
language plpgsql as $f$
declare
  c_src    constant text := 'cos-api-suite';
  c_worker constant text := 'sentinel-' || p_key || '-lease-owner';
  k        text := p_key;
  t        uuid := p_tenant;
  co uuid; co2 uuid; d uuid; d2 uuid;
  ag_triage uuid; ag_follow uuid; ag_annex uuid; ag_archive uuid; ag_holder uuid;
  ch_test uuid; ch_test2 uuid;
  v jsonb; v_run uuid; v_job uuid; v_review uuid; v_out uuid; v_stop uuid; v_limit uuid; v_task uuid;
begin
  co  := pg_temp.remember(k || '.company', ops.create_company(t, k || '-clinic', p_company_name, c_src));
  co2 := pg_temp.remember(k || '.company_annex', ops.create_company(t, k || '-annex', 'Annex ' || upper(k), c_src));
  d   := pg_temp.remember(k || '.department', ops.create_department(t, co, 'intake', 'Intake ' || upper(k), c_src));
  d2  := pg_temp.remember(k || '.department_annex', ops.create_department(t, co2, 'annex-intake', 'Annex Intake ' || upper(k), c_src));
  -- agents.role and agents.description are configuration free text no read
  -- returns (brief §8 row 3).
  ag_triage := pg_temp.remember(k || '.agent_triage', ops.create_agent(
    t, co, d, 'triage', p_agent_name, 'SENTINEL-' || upper(k) || '-AGENT-ROLE', c_src,
    'SENTINEL-' || upper(k) || '-AGENT-DESCRIPTION'));
  ag_follow := pg_temp.remember(k || '.agent_follow', ops.create_agent(
    t, co, d, 'follow-up', 'Follow Up ' || upper(k), 'Intake assistant', c_src));
  ag_annex := pg_temp.remember(k || '.agent_annex', ops.create_agent(
    t, co2, d2, 'annex', 'Annex Triage ' || upper(k), 'Intake assistant', c_src));
  ag_archive := pg_temp.remember(k || '.agent_archive', ops.create_agent(
    t, co, d, 'archive', 'Archive ' || upper(k), 'Intake assistant', c_src));
  perform ops.set_agent_status(t, ag_archive, 'inactive', c_src);
  ag_holder := pg_temp.remember(k || '.agent_holder', ops.create_agent(
    t, co, d, 'holder', 'Queue Holder ' || upper(k), 'Intake assistant', c_src));

  -- Money: the tenant budget (a distinctive amount), a zero annex budget that
  -- refuses, and a retired company budget whose set_by and ended_by never leave.
  perform ops.set_spend_limit('tenant', p_limit, 'UTC', 'SENTINEL-' || upper(k) || '-LIMIT-REASON',
                              'sentinel-' || k || '-set-by', t);
  perform ops.set_spend_limit('company', 0, 'UTC', 'annex budget', 'sentinel-' || k || '-set-by', t, co2);
  perform ops.set_spend_limit('company', 500000000000, 'UTC', 'retired budget', 'sentinel-' || k || '-set-by', t, co);
  select l.id into v_limit from ops.spend_limits l
   where l.scope = 'company' and l.tenant_id = t and l.company_id = co and l.ended_at is null;
  perform ops.retire_spend_limit(v_limit, 'retired for the suite', 'sentinel-' || k || '-ended-by');

  -- Channels: two test lines and an inactive production line (the Q8 gate).
  ch_test := pg_temp.remember(k || '.channel_test', ops.configure_whatsapp_channel(
    t, co, ag_triage, p_target || '1', 'test', p_channel_label, 'sentinel-' || k || '-configured-by'));
  perform pg_temp.remember(k || '.channel_prod', ops.configure_whatsapp_channel(
    t, co, ag_triage, p_target || '2', 'production', 'Production ' || upper(k), 'sentinel-' || k || '-configured-by', false));
  ch_test2 := pg_temp.remember(k || '.channel_test2', ops.configure_whatsapp_channel(
    t, co, ag_triage, p_target || '3', 'test', 'Second test ' || upper(k), 'sentinel-' || k || '-configured-by'));

  -- Runs, one per state.
  -- succeeded, with its review opened after the settlement (pending)
  v := pg_temp.admit(k, 1, t, co, ag_triage);
  v_run := pg_temp.remember(k || '.run_ok', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_ok', (v ->> 'task_id')::uuid);
  perform pg_temp.start_run(v_run, c_worker);
  perform pg_temp.settle_run(v_run, c_worker, k, null, pg_temp.triage_result(k));
  perform pg_temp.remember(k || '.review_ok', (select r.id from ops.review_items r where r.agent_run_id = v_run));
  -- running on a live lease (working), admitted through the WhatsApp test line
  v := ops.receive_whatsapp_message(p_target || '1', 'wamid.SENTINEL-' || upper(k) || '-EXT-LIVE', p_phone || '1',
                                    'SENTINEL-' || upper(k) || '-BODY-LIVE synthetic hello', now());
  if v ->> 'state' <> 'admitted' then
    raise exception 'setup: the % test line did not admit: %', k, v;
  end if;
  v_run := pg_temp.remember(k || '.run_live', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_live', (v ->> 'task_id')::uuid);
  perform pg_temp.remember(k || '.conversation', (v ->> 'conversation_id')::uuid);
  perform pg_temp.start_run(v_run, c_worker);
  -- running without a live lease (stale), its job carrying a raw error
  v := pg_temp.admit(k, 2, t, co, ag_triage);
  v_run := pg_temp.remember(k || '.run_stale', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_stale', (v ->> 'task_id')::uuid);
  perform pg_temp.start_run(v_run, c_worker);
  select job_id into v_job from ops.agent_runs where id = v_run;
  update ops.jobs set lease_expires_at = now() - interval '1 minute',
                      last_error = 'SENTINEL-' || upper(k) || '-LAST-ERROR', last_error_class = 'transient'
   where id = v_job;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job, t, 'retry', 'sentinel-' || k || '-job-event-worker', 1, 'SENTINEL-' || upper(k) || '-JOB-EVENT-DETAIL');
  -- indeterminate, not retried (attention)
  v := pg_temp.admit(k, 3, t, co, ag_triage);
  v_run := pg_temp.remember(k || '.run_indeterminate', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_indeterminate', (v ->> 'task_id')::uuid);
  perform pg_temp.start_run(v_run, c_worker);
  perform pg_temp.settle_run(v_run, c_worker, k, 'timeout', null);
  -- failed
  v := pg_temp.admit(k, 4, t, co, ag_triage);
  v_run := pg_temp.remember(k || '.run_failed', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_failed', (v ->> 'task_id')::uuid);
  perform pg_temp.start_run(v_run, c_worker);
  perform pg_temp.settle_run(v_run, c_worker, k, 'invalid_response', null);
  -- queued, then held by an agent stop the owner CLI tripped (legacy label)
  v := pg_temp.admit(k, 5, t, co, ag_follow);
  perform pg_temp.remember(k || '.run_held', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_held', (v ->> 'task_id')::uuid);
  insert into ops.execution_stops (scope, tenant_id, company_id, agent_id, reason, tripped_by)
  values ('agent', t, co, ag_follow, p_stop_reason, p_legacy)
  returning id into v_stop;
  perform pg_temp.remember(k || '.stop_agent', v_stop);
  -- refused at the request by that stop (stopRef)
  v := pg_temp.admit(k, 6, t, co, ag_follow);
  perform pg_temp.remember(k || '.run_stopped', (v ->> 'agent_run_id')::uuid);
  -- refused by the zero annex budget (spendLimitRef)
  v := pg_temp.admit(k, 7, t, co2, ag_annex);
  perform pg_temp.remember(k || '.run_budget', (v ->> 'agent_run_id')::uuid);
  -- queued and covered by no stop, requested under a sentinel label: a run's
  -- requested_by is a stored actor label no read returns (brief §9, §13)
  v := pg_temp.admit(k, 8, t, co, ag_holder, 'sentinel-' || k || '-run-requested-by');
  perform pg_temp.remember(k || '.run_queued', (v ->> 'agent_run_id')::uuid);
  -- two more WhatsApp admissions: one for an accepted, sent review; one on the
  -- second test line, which later leaves test mode
  v := ops.receive_whatsapp_message(p_target || '1', 'wamid.SENTINEL-' || upper(k) || '-EXT-SENT', p_phone || '2',
                                    'SENTINEL-' || upper(k) || '-BODY-SENT synthetic hello', now());
  perform pg_temp.remember(k || '.run_sent', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_sent', (v ->> 'task_id')::uuid);
  v := ops.receive_whatsapp_message(p_target || '3', 'wamid.SENTINEL-' || upper(k) || '-EXT-PROD', p_phone || '3',
                                    'SENTINEL-' || upper(k) || '-BODY-PROD synthetic hello', now());
  perform pg_temp.remember(k || '.run_prod', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember(k || '.task_prod', (v ->> 'task_id')::uuid);
  -- a company stop on the annex, after its refusal
  insert into ops.execution_stops (scope, tenant_id, company_id, reason, tripped_by)
  values ('company', t, co2, 'Synthetic annex pause', 'sentinel-' || k || '-tripped-by')
  returning id into v_stop;
  perform pg_temp.remember(k || '.stop_company', v_stop);
  -- a cleared tenant stop, both labels legacy
  insert into ops.execution_stops (scope, tenant_id, reason, tripped_by)
  values ('tenant', t, 'Synthetic tenant drill', p_legacy) returning id into v_stop;
  update ops.execution_stops set cleared_by = p_legacy, cleared_reason = p_cleared_reason, cleared_at = now()
   where id = v_stop;
  perform pg_temp.remember(k || '.stop_tenant_cleared', v_stop);
  -- a tenant job_kind stop, tripped and cleared (read-only in the browser)
  insert into ops.execution_stops (scope, tenant_id, job_kind, reason, tripped_by)
  values ('job_kind', t, 'agent_run.execute', 'Synthetic kind drill', 'sentinel-' || k || '-tripped-by')
  returning id into v_stop;
  update ops.execution_stops set cleared_by = 'sentinel-' || k || '-cleared-by', cleared_reason = 'Kind drill over',
                                 cleared_at = now()
   where id = v_stop;
  perform pg_temp.remember(k || '.stop_kind_cleared', v_stop);

  -- Tasks no admission created: one carrying every task sentinel.
  v_task := pg_temp.remember(k || '.task_sentinel', ops.create_task(
    t, co, 'crm.follow_up', 'SENTINEL-' || upper(k) || '-TITLE', c_src, 'SENTINEL-' || upper(k) || '-DESCRIPTION',
    d, null, 100, now() + interval '1 day', null, null, 'sentinel-' || k || '-task-idempotency'));
  perform pg_temp.remember(k || '.task_plain', ops.create_task(t, co, 'crm.follow_up', 'Plain follow-up', c_src));
  -- An admission row carrying a resolved CRM contact, on the sentinel task.
  insert into ops.inbound_messages (tenant_id, company_id, source_kind, external_message_id, contact_ref,
                                    do_not_contact, body_fingerprint, received_at, task_id, channel_id,
                                    conversation_id, contact_resolution, crm_contact_ref)
  values (t, co, 'whatsapp', 'wamid.SENTINEL-' || upper(k) || '-EXT-RAW', p_phone || '9', false,
          encode(sha256(convert_to('SENTINEL-' || upper(k) || '-FINGERPRINT', 'UTF8')), 'hex'), now(),
          v_task, ch_test, pg_temp.id(k || '.conversation'), 'found',
          'crm:contact:98765432' || case k when 'a' then '101' else '202' end);

  -- Reviews, one per state and per advice branch.
  -- accepted through the owner service with the legacy reviewer label, then
  -- a send requested under that label and marked indeterminate under it
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_live'), pg_temp.id(k || '.run_live'), 'lead_triage',
          pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_accepted', v_review);
  perform ops.record_review_decision(t, v_review, 'accepted', p_legacy, 'operator-cli', p_note);
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (t, co, ch_test, pg_temp.id(k || '.conversation'), v_review, pg_temp.id(k || '.task_live'),
          'authorized', p_legacy, jsonb_build_object('sentinel', 'SENTINEL-' || upper(k) || '-AUTH-CHECK'))
  returning id into v_out;
  perform pg_temp.remember(k || '.outbound_indeterminate', v_out);
  perform ops.record_event(t, co, 'communication.outbound_authorized', 'operator-cli', 'task', pg_temp.id(k || '.task_live'),
                           jsonb_build_object('outbound_message_id', v_out, 'review_item_id', v_review));
  update ops.outbound_messages set status = 'sending', sending_at = now() - interval '10 minutes' where id = v_out;
  perform ops.record_event(t, co, 'communication.outbound_attempted', 'operator-cli', 'task', pg_temp.id(k || '.task_live'),
                           jsonb_build_object('outbound_message_id', v_out));
  perform ops.mark_outbound_indeterminate(t, v_out, p_legacy);
  -- accepted, sent and delivered
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_sent'), pg_temp.id(k || '.run_sent'), 'lead_triage', pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_sent', v_review);
  perform ops.record_review_decision(t, v_review, 'accepted', 'sentinel-' || k || '-reviewer', 'operator-cli');
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (t, co, ch_test, (select i.conversation_id from ops.inbound_messages i where i.task_id = pg_temp.id(k || '.task_sent')),
          v_review, pg_temp.id(k || '.task_sent'), 'authorized', 'sentinel-' || k || '-requested-by', '{}'::jsonb)
  returning id into v_out;
  perform pg_temp.remember(k || '.outbound_sent', v_out);
  update ops.outbound_messages
     set status = 'sending', sending_at = now(),
         send_check = jsonb_build_object('sentinel', 'SENTINEL-' || upper(k) || '-SEND-CHECK')
   where id = v_out;
  perform ops.settle_outbound_send(t, v_out, 'sent', 'wamid.SENTINEL-' || upper(k) || '-PROVIDER-MESSAGE', null, null);
  v := ops.receive_whatsapp_status(p_target || '1', 'wamid.SENTINEL-' || upper(k) || '-PROVIDER-MESSAGE', 'delivered',
                                   now(), p_phone || '2', null, null);
  -- accepted, and its send blocked by the eligibility re-check
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_ok'), gen_random_uuid(), 'lead_triage', pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_blocked', v_review);
  perform ops.record_review_decision(t, v_review, 'accepted', 'sentinel-' || k || '-reviewer', 'operator-cli');
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (t, co, ch_test, pg_temp.id(k || '.conversation'), v_review, pg_temp.id(k || '.task_ok'),
          'authorized', 'sentinel-' || k || '-requested-by', '{}'::jsonb)
  returning id into v_out;
  perform pg_temp.remember(k || '.outbound_blocked', v_out);
  update ops.outbound_messages set status = 'blocked', blocked_reason = 'contact_not_found' where id = v_out;
  perform ops.record_event(t, co, 'communication.outbound_blocked', 'operator-cli', 'task', pg_temp.id(k || '.task_ok'),
                           jsonb_build_object('outbound_message_id', v_out, 'reason', 'contact_not_found'));
  -- rejected
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_indeterminate'), pg_temp.id(k || '.run_indeterminate'), 'lead_triage',
          pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_rejected', v_review);
  perform ops.record_review_decision(t, v_review, 'rejected', 'sentinel-' || k || '-reviewer', 'operator-cli');
  -- pending and do-not-contact
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_stale'), pg_temp.id(k || '.run_stale'), 'lead_triage', pg_temp.triage_result(k), true)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_dnc', v_review);
  -- needs_edit
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_failed'), gen_random_uuid(), 'lead_triage', pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_needs_edit', v_review);
  perform ops.record_review_decision(t, v_review, 'needs_edit', 'sentinel-' || k || '-reviewer', 'operator-cli');
  -- the advice branches: an invalid proposal, another capability, a task no
  -- admission created, and a WhatsApp line that later leaves test mode
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_failed'), gen_random_uuid(), 'lead_triage',
          jsonb_build_object('outcome', 'bogus', 'response_draft', 'SENTINEL-' || upper(k) || '-DRAFT-INVALID'), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_invalid', v_review);
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_sentinel'), gen_random_uuid(), 'crm.follow_up', pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_capability', v_review);
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_plain'), gen_random_uuid(), 'lead_triage', pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_no_admission', v_review);
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (t, co, pg_temp.id(k || '.task_prod'), pg_temp.id(k || '.run_prod'), 'lead_triage', pg_temp.triage_result(k), false)
  returning id into v_review;
  perform pg_temp.remember(k || '.review_prod', v_review);

  -- An inbound message refused on the record, and an event of an unknown
  -- type from a source outside the provenance allowlist.
  v := ops.receive_whatsapp_message(p_target || '1', 'wamid.SENTINEL-' || upper(k) || '-EXT-EMPTY', p_phone || '4', '   ', now());
  if v ->> 'state' <> 'refused' then
    raise exception 'setup: an empty % message was not refused: %', k, v;
  end if;
  perform ops.record_event(t, co, 'custom.thing_happened', 'legacy-import', 'task', pg_temp.id(k || '.task_ok'),
                           jsonb_build_object('secret', 'SENTINEL-' || upper(k) || '-PAYLOAD',
                                              'marked_by', p_legacy));

  -- The remaining job sentinel: a payload key no read returns.
  update ops.jobs set payload = payload || jsonb_build_object('sentinel', 'SENTINEL-' || upper(k) || '-JOB-PAYLOAD')
   where id = (select r.job_id from ops.agent_runs r where r.id = pg_temp.id(k || '.run_ok'));
end
$f$;

-- ---------------------------------------------------------------------------
-- Setup. Tenant A owns the local CRM for the length of this transaction (the
-- Phase 2C eligibility policy); tenants B and C do not.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid; tb uuid; tc uuid;
  v_stop uuid;
begin
  -- Rows other sessions may hold come first: the owner of the local CRM and
  -- the platform governance. The global sequences restart after them.
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('cos-api-test-alpha', 'COS API Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('cos-api-test-beta', 'COS API Beta Zeta-B77') returning id into tb;
  insert into ops.tenants (slug, name) values ('cos-api-test-gamma', 'COS API Gamma') returning id into tc;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  perform pg_temp.remember('tenant_c', tc);

  perform pg_temp.remember('platform.price', ops.record_model_price(
    'fake', 'cos-api-model-7', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'SENTINEL-PLATFORM-PRICE-SOURCE', 'sentinel-platform-recorded-by', 0.125));
  -- A distinctive global ceiling amount: it must appear in no tenant output.
  perform ops.set_spend_limit('global', 876543219876, 'UTC', 'SENTINEL-PLATFORM-CEILING-REASON',
                              'sentinel-platform-set-by');
  perform pg_temp.remember('platform.limit',
    (select l.id from ops.spend_limits l where l.scope = 'global' and l.ended_at is null));
  -- Platform stops, cleared: identifiers a tenant must never be able to name.
  insert into ops.execution_stops (scope, reason, tripped_by)
  values ('global', 'SENTINEL-PLATFORM-STOP-REASON', 'sentinel-platform-tripped-by') returning id into v_stop;
  update ops.execution_stops set cleared_by = 'sentinel-platform-cleared-by',
                                 cleared_reason = 'SENTINEL-PLATFORM-CLEAR-REASON', cleared_at = now()
   where id = v_stop;
  perform pg_temp.remember('platform.stop_global', v_stop);
  insert into ops.execution_stops (scope, job_kind, reason, tripped_by)
  values ('job_kind', 'agent_run.execute', 'SENTINEL-PLATFORM-KIND-REASON', 'sentinel-platform-tripped-by')
  returning id into v_stop;
  update ops.execution_stops set cleared_by = 'sentinel-platform-cleared-by',
                                 cleared_reason = 'SENTINEL-PLATFORM-CLEAR-REASON', cleared_at = now()
   where id = v_stop;
  perform pg_temp.remember('platform.stop_kind', v_stop);
end
$$;

-- Global monotonic identifiers restart at distinctive values, so a value that
-- leaked into any output would be found (SI-26). ALTER SEQUENCE is
-- transactional; the rollback restores both (checked after it).
alter sequence ops.events_seq_seq restart with 9876543210000;
alter sequence ops.job_events_id_seq restart with 8765432100000;

-- Auth users, sessions, principals and memberships: synthetic, and only in
-- this transaction. Inserting an auth user fires handle_new_user, which gives
-- it a CRM sales row, as a real signup does.
do $$
declare
  v_user uuid;
  v_who  text;
  v_n    int := 0;
begin
  foreach v_who in array array['m_a', 'm_b', 'nonmember', 'disabled', 'revoked', 'unbanned', 'banned',
                               'banned_past', 'deleted', 'anonymous', 'two', 'renamed', 'reused'] loop
    v_n := v_n + 1;
    v_user := pg_temp.remember('user.' || v_who, gen_random_uuid());
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            format('Sentinel.Cos.%s.Q7@Example.Test', replace(v_who, '_', '-')), 'x', now(), now(), now(), '{}',
            jsonb_build_object('first_name', 'Synthetic', 'last_name', 'Member ' || v_n));
    insert into auth.sessions (id, user_id, created_at, updated_at)
    values (pg_temp.remember('session.' || v_who, gen_random_uuid()), v_user, now(), now());
  end loop;
  -- A second, expired session of the member of tenant A.
  insert into auth.sessions (id, user_id, created_at, updated_at, not_after)
  values (pg_temp.remember('session.expired', gen_random_uuid()), pg_temp.id('user.m_a'),
          now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 minute');

  -- Members of tenant A, through the owner service the CLI uses.
  foreach v_who in array array['m_a', 'disabled', 'revoked', 'unbanned', 'banned', 'banned_past', 'deleted',
                               'anonymous', 'two', 'renamed'] loop
    perform pg_temp.remember('membership.' || v_who, (ops.grant_membership(
      pg_temp.id('tenant_a'), pg_temp.id('user.' || v_who), 'Sentinel Display ' || v_who || ' Q7',
      'sentinel-owner-cli', 'synthetic suite member') ->> 'membershipId')::uuid);
    perform pg_temp.remember('principal.' || v_who,
      (select p.id from ops.principals p where p.subject = pg_temp.id('user.' || v_who)));
  end loop;

  -- A member of tenant B: the tables accept any tenant (the model is
  -- tenant-generic); only the eligibility policy refuses it, at grant and at
  -- resolve (section M). An owner fixture, since the CLI's grant refuses it.
  insert into ops.principals (kind, issuer, subject, display_name, created_by)
  values ('human', 'supabase_auth', pg_temp.id('user.m_b'), 'Sentinel Display m_b Q7', 'sentinel-owner-cli')
  returning id into v_user;
  perform pg_temp.remember('principal.m_b', v_user);
  insert into ops.tenant_memberships (principal_id, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
  values (v_user, pg_temp.id('tenant_b'), repeat('b', 64), 'sentinel-owner-cli', 'owner fixture');

  -- The states the resolver must refuse, each after a valid grant.
  update ops.principals set disabled_at = now(), disabled_by = 'sentinel-owner-cli'
   where id = pg_temp.id('principal.disabled');
  perform ops.revoke_membership(pg_temp.id('membership.revoked'), 'sentinel-owner-cli', 'synthetic revoke');
  perform ops.revoke_membership(pg_temp.id('membership.unbanned'), 'sentinel-owner-cli', 'synthetic revoke');
  -- A CRM administrator's disable bans the auth user; an unban after the owner
  -- revoked the membership restores nothing.
  update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.id('user.unbanned');
  update auth.users set banned_until = null where id = pg_temp.id('user.unbanned');
  update auth.users set banned_until = now() + interval '1 day' where id = pg_temp.id('user.banned');
  update auth.users set banned_until = now() - interval '1 day' where id = pg_temp.id('user.banned_past');
  update auth.users set deleted_at = now() where id = pg_temp.id('user.deleted');
  update auth.users set is_anonymous = true where id = pg_temp.id('user.anonymous');
end
$$;

-- Tenant A's office, with the legacy fixtures of brief §16: the email-like
-- legacy actor label (A to C), and free text carrying email-like substrings
-- that is content and is returned as such (D).
do $$
begin
  perform pg_temp.build_office(
    'a', pg_temp.id('tenant_a'), 'Clinic A (desk@example.test)', 'Lead Triage (triage@example.test)',
    'Synthetic test line ops-line@example.test', 'person@example.test', '300987650000', '55119876500',
    1000000000000, 'Call back; cc someone@example.test', 'Synthetic pause; ask ops@example.test',
    'Drill over; mail drill@example.test');
end
$$;

-- Tenant A work whose stored references name platform rows (brief §7.4, §9):
-- a run refused by a platform stop (stop_id) and one refused by the global
-- ceiling (spend_limit_id). The stop is cleared and the ceiling restored at
-- once, so every read below sees the platform as the setup left it; N3 and N9
-- require both references to leave as null.
do $$
declare
  ta     uuid := pg_temp.id('tenant_a');
  v_stop uuid;
  v_zero uuid;
  v_run  uuid;
begin
  insert into ops.execution_stops (scope, reason, tripped_by)
  values ('global', 'SENTINEL-PLATFORM-STOP-REFUSING', 'sentinel-platform-tripped-by') returning id into v_stop;
  perform pg_temp.remember('platform.stop_global_refusing', v_stop);
  v_run := pg_temp.remember('a.run_platform_stopped',
    (pg_temp.admit('a', 10, ta, pg_temp.id('a.company'), pg_temp.id('a.agent_triage')) ->> 'agent_run_id')::uuid);
  update ops.execution_stops set cleared_by = 'sentinel-platform-cleared-by',
                                 cleared_reason = 'SENTINEL-PLATFORM-CLEAR-REASON', cleared_at = now()
   where id = v_stop;
  if not exists (select 1 from ops.agent_runs r
                  where r.id = v_run and r.status = 'cancelled' and r.stop_id = v_stop) then
    raise exception 'setup: the platform stop did not refuse tenant A''s run on the record';
  end if;
  -- A zero ceiling is exhausted by any request, whatever the settled spend.
  v_zero := pg_temp.remember('platform.limit_zero', ops.set_spend_limit(
    'global', 0, 'UTC', 'SENTINEL-PLATFORM-CEILING-ZERO', 'sentinel-platform-set-by'));
  v_run := pg_temp.remember('a.run_platform_limit',
    (pg_temp.admit('a', 11, ta, pg_temp.id('a.company'), pg_temp.id('a.agent_triage')) ->> 'agent_run_id')::uuid);
  perform ops.set_spend_limit('global', 876543219876, 'UTC', 'SENTINEL-PLATFORM-CEILING-REASON',
                              'sentinel-platform-set-by');
  if not exists (select 1 from ops.agent_runs r
                  where r.id = v_run and r.status = 'cancelled' and r.error_code = 'budget_exhausted'
                    and r.spend_limit_id = v_zero)
     or (select l.daily_limit_micros from ops.spend_limits l where l.scope = 'global' and l.ended_at is null)
        is distinct from 876543219876 then
    raise exception 'setup: the global ceiling did not refuse tenant A''s run on the record, or was not restored';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tenant A's member reads everything, twice: with tenant B idle (it has no
-- office yet), then with B busy in every state. Every function, with every
-- argument its fixtures give it, following every nextCursor to the end.
-- ---------------------------------------------------------------------------

create temporary table cos_out (
  n        serial primary key,
  snapshot text not null,
  fn       text not null,
  call     text not null,
  result   jsonb not null
) on commit drop;

create function pg_temp.collect(p_snapshot text) returns void
language plpgsql as $f$
declare
  ta      uuid := pg_temp.id('tenant_a');
  v_calls text[] := array[
    'company_os_api.operator_context()', 'company_os_api.overview()', 'company_os_api.list_agents()',
    'company_os_api.spend_summary()', 'company_os_api.communication_status()',
    'company_os_api.list_tasks()', 'company_os_api.list_runs()', 'company_os_api.list_runs(p_attention_only => true)',
    'company_os_api.list_events()', 'company_os_api.list_reviews()',
    'company_os_api.list_stops()', 'company_os_api.list_stops(p_include_cleared => true)'];
  v_call  text;
  v_s     text;
  v_id    uuid;
  v_type  text;
  v_page  text;
  v_i     int;
  v_res   jsonb;
begin
  foreach v_s in array array['pending', 'accepted', 'rejected', 'needs_edit'] loop
    v_calls := v_calls || format('company_os_api.list_reviews(p_status => %L)', v_s);
  end loop;
  foreach v_s in array array['queued', 'assigned', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled'] loop
    v_calls := v_calls || format('company_os_api.list_tasks(p_status => %L)', v_s);
  end loop;
  foreach v_s in array array['pending', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled'] loop
    v_calls := v_calls || format('company_os_api.list_runs(p_status => %L)', v_s);
  end loop;
  for v_id in select a.id from ops.agents a where a.tenant_id = ta order by a.id loop
    v_calls := v_calls || format('company_os_api.get_agent(%L)', v_id)
                       || format('company_os_api.list_tasks(p_agent_id => %L)', v_id)
                       || format('company_os_api.list_runs(p_agent_id => %L)', v_id);
  end loop;
  for v_id in select x.id from ops.tasks x where x.tenant_id = ta order by x.id loop
    v_calls := v_calls || format('company_os_api.get_task(%L)', v_id);
  end loop;
  for v_id in select x.id from ops.agent_runs x where x.tenant_id = ta order by x.id loop
    v_calls := v_calls || format('company_os_api.get_run(%L)', v_id);
  end loop;
  for v_id in select x.id from ops.review_items x where x.tenant_id = ta order by x.id loop
    v_calls := v_calls || format('company_os_api.get_review(%L)', v_id)
                       || format('company_os_api.get_review_advice(%L)', v_id);
  end loop;
  for v_type, v_id in
    select 'task', x.id from ops.tasks x where x.tenant_id = ta
    union all select 'agent_run', x.id from ops.agent_runs x where x.tenant_id = ta
    union all select 'company', x.id from ops.companies x where x.tenant_id = ta
    union all select 'department', x.id from ops.departments x where x.tenant_id = ta
    union all select 'agent', x.id from ops.agents x where x.tenant_id = ta
    order by 1, 2 loop
    v_calls := v_calls || format('company_os_api.list_events(p_subject_type => %L, p_subject_id => %L)', v_type, v_id);
  end loop;
  foreach v_call in array v_calls loop
    insert into cos_out (snapshot, fn, call, result)
    values (p_snapshot, substring(v_call from '^company_os_api\.([a-z_]+)\('), v_call,
            pg_temp.api(pg_temp.claims('m_a'), v_call));
  end loop;
  -- Every page, through the cursor each page hands out.
  foreach v_s in array array[
      'company_os_api.list_tasks(p_limit => 2%s)',
      'company_os_api.list_runs(p_limit => 2%s)',
      'company_os_api.list_reviews(p_limit => 1%s)',
      'company_os_api.list_reviews(p_status => ''accepted'', p_limit => 1%s)',
      'company_os_api.list_events(p_limit => 7%s)',
      'company_os_api.list_stops(p_include_cleared => true, p_limit => 1%s)'] loop
    v_page := null;
    v_i := 0;
    loop
      v_call := format(v_s, case when v_page is null then '' else format(', p_cursor => %L', v_page) end);
      v_res := pg_temp.api(pg_temp.claims('m_a'), v_call);
      insert into cos_out (snapshot, fn, call, result)
      values (p_snapshot, substring(v_call from '^company_os_api\.([a-z_]+)\('), v_call, v_res);
      v_page := v_res -> 'body' ->> 'nextCursor';
      exit when v_page is null;
      v_i := v_i + 1;
      if v_i > 200 then
        raise exception 'setup: % never reached its last page', v_s;
      end if;
    end loop;
  end loop;
end
$f$;

do $$ begin perform pg_temp.collect('idle'); end $$;

-- Tenant B, busy in every state: its own sentinels, its own legacy label, a
-- distinctive budget amount, and an active tenant job_kind stop holding its
-- queued work. None of it may reach tenant A.
do $$
begin
  perform pg_temp.build_office(
    'b', pg_temp.id('tenant_b'), 'Beta Clinic Zeta-B77', 'Beta Agent Zeta-B77', 'Beta line Zeta-B77',
    'person-b@example.test', '300987651000', '55119876510', 987654321987, 'Beta note Zeta-B77',
    'Beta pause Zeta-B77', 'Beta drill Zeta-B77');
end
$$;
insert into ops.execution_stops (scope, tenant_id, job_kind, reason, tripped_by)
values ('job_kind', pg_temp.id('tenant_b'), 'agent_run.execute', 'Beta kind stop Zeta-B77', 'sentinel-b-tripped-by');

do $$ begin perform pg_temp.collect('busy'); end $$;

-- ===========================================================================
-- T. TENANT ISOLATION.
-- ===========================================================================

-- T1. Tenant A's outputs are byte-identical, asOf and serverTime aside,
--     whether tenant B is idle or busy in every state (brief §14 item 1).
do $$
declare
  v_bad text;
begin
  if not exists (select 1 from ops.agent_runs r join ops.jobs j on j.id = r.job_id
                  where r.tenant_id = pg_temp.id('tenant_b') and r.status = 'running'
                    and j.status = 'leased' and j.lease_expires_at > now())
     or (select count(distinct r.status) from ops.agent_runs r where r.tenant_id = pg_temp.id('tenant_b')) < 6 then
    raise exception 'T1: tenant B is not busy in every run state, so the differential proves nothing';
  end if;
  if (select count(*) from cos_out where snapshot = 'idle') <> (select count(*) from cos_out where snapshot = 'busy') then
    raise exception 'T1: tenant A''s reads differ in number while tenant B is busy';
  end if;
  with i as (select call, row_number() over (partition by call order by n) as k, result from cos_out where snapshot = 'idle'),
       b as (select call, row_number() over (partition by call order by n) as k, result from cos_out where snapshot = 'busy')
  select string_agg(format('%s at %s', i.call, d), '; ') into v_bad
    from i join b using (call, k), pg_temp.json_diff(pg_temp.untimed(i.result), pg_temp.untimed(b.result)) d;
  if v_bad is not null then
    raise exception 'T1: tenant A''s outputs changed while tenant B was busy: %', v_bad;
  end if;
end
$$;

-- T1b. Phase 2E.2: the overview's operationalHealth is EXACT. Tenant B, busy
--      in every state, reads the counts its own rows give, recomputed here
--      from the tables; it carries no identifier; and a latency percentile
--      appears only from its minimum sample size.
do $$
declare
  tb      uuid := pg_temp.id('tenant_b');
  v_h     jsonb;
  v_since timestamptz;
  v_bad   text;
begin
  v_h := ops.read_overview(tb) -> 'operationalHealth';
  v_since := clock_timestamp() - interval '24 hours';
  if (v_h -> 'queue' ->> 'ready')::int8 is distinct from
       (select count(*) from ops.jobs where tenant_id = tb and status = 'queued' and available_at <= now())
     or (v_h -> 'queue' ->> 'scheduled')::int8 is distinct from
       (select count(*) from ops.jobs where tenant_id = tb and status = 'queued' and available_at > now())
     or (v_h -> 'queue' ->> 'running')::int8 is distinct from
       (select count(*) from ops.jobs where tenant_id = tb and status = 'leased' and lease_expires_at > now())
     or (v_h -> 'queue' ->> 'expiredLeases')::int8 is distinct from
       (select count(*) from ops.jobs where tenant_id = tb and status = 'leased' and lease_expires_at <= now()) then
    raise exception 'T1b: the queue counts are not tenant B''s own: %', v_h -> 'queue';
  end if;
  if (select count(*) from ops.jobs where tenant_id = tb and status in ('queued', 'leased')) = 0 then
    raise exception 'T1b: tenant B has no live job, so the queue check proves nothing';
  end if;
  if v_h -> 'agentRuns' -> 'inWindowByStatus' is distinct from
       (select coalesce(jsonb_object_agg(x.status, x.n), '{}') from
          (select status, count(*) as n from ops.agent_runs where tenant_id = tb and created_at >= v_since group by status) x) then
    raise exception 'T1b: the run counts are not tenant B''s own: %', v_h -> 'agentRuns';
  end if;
  if (v_h -> 'decisions' ->> 'pendingNow')::int8 is distinct from
       (select count(*) from ops.decision_evaluations where tenant_id = tb and status in ('pending', 'running'))
     or (v_h -> 'spend' -> 'chargedToday' ->> 'micros')::int8 is distinct from
       (select coalesce(sum(charged_cost_micros), 0) from ops.agent_runs
         where tenant_id = tb and started_at >= ops.cos_today_start(tb))
     or (v_h -> 'spend' -> 'chargedToday' ->> 'micros')::int8 is distinct from
       (select coalesce(sum(x.charged_micros), 0) from ops.spend_status() x
         where x.scope = 'tenant' and x.tenant_id = tb)
     or (v_h -> 'spend' -> 'reservedInFlight' ->> 'micros')::int8 is distinct from
       (select coalesce(sum(charged_cost_micros), 0) from ops.agent_runs
         where tenant_id = tb and status = 'running') then
    raise exception 'T1b: the decision or spend facts are not tenant B''s own: % %', v_h -> 'decisions', v_h -> 'spend';
  end if;
  -- Percentiles only from their minimum samples, never from one or two.
  if ((v_h -> 'agentRuns' -> 'latency' ->> 'sampleSize')::int < 5) <> (v_h -> 'agentRuns' -> 'latency' -> 'p50Ms' = 'null')
     or ((v_h -> 'agentRuns' -> 'latency' ->> 'sampleSize')::int < 20) <> (v_h -> 'agentRuns' -> 'latency' -> 'p95Ms' = 'null') then
    raise exception 'T1b: a latency percentile disagrees with its sample size: %', v_h -> 'agentRuns' -> 'latency';
  end if;
  -- No identifier of any kind: every row id is a uuid, and none is here.
  select string_agg(m[1], ', ') into v_bad
    from regexp_matches(v_h::text, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', 'g') m;
  if v_bad is not null then
    raise exception 'T1b: operationalHealth carries an identifier: %', v_bad;
  end if;
end
$$;

-- T2. The platform differential: a platform stop, and the global ceiling
--     exhausted by tenant B's spend (tripping system:spend_ceiling), change
--     tenant A's outputs only at the pinned platform-derived paths (brief §9).
--     Each case runs in a subtransaction that is rolled back, lock included.
create function pg_temp.platform_changes() returns table (fn text, path text)
language sql as $$
  with b as (select call, row_number() over (partition by call order by n) as k, fn, result from cos_out where snapshot = 'busy'),
       p as (select call, row_number() over (partition by call order by n) as k, result from cos_out where snapshot = 'platform')
  select distinct b.fn, regexp_replace(d, '\[[0-9]+\]', '[]', 'g')
    from b join p using (call, k), pg_temp.json_diff(pg_temp.untimed(b.result -> 'body'), pg_temp.untimed(p.result -> 'body')) d;
$$;

do $$
declare
  -- The pinned platform-derived set (brief §9 item 1 and 2), as paths.
  c_allowed constant text[] := array[
    'overview .platform.globalAdmissionBlocked', 'spend_summary .platform.globalAdmissionBlocked',
    'overview .agents.held', 'overview .agents.queued',
    'overview .runs.todayByStatus', 'overview .outbound.todayByStatus',
    'list_agents .items[].activity', 'list_agents .items[].evidence.heldRunIds', 'list_agents .items[].evidence.queuedRunIds',
    'get_agent .agent.activity', 'get_agent .agent.evidence.heldRunIds', 'get_agent .agent.evidence.queuedRunIds',
    'list_runs .items[].status', 'list_runs .items[].errorCategory', 'list_runs .items[].errorCode',
    'get_agent .recentRuns[].status', 'get_agent .recentRuns[].errorCategory', 'get_agent .recentRuns[].errorCode',
    'get_task .runs[].status', 'get_task .runs[].errorCategory', 'get_task .runs[].errorCode',
    'get_run .status', 'get_run .errorCategory', 'get_run .errorCode',
    'get_run .job.status', 'get_run .job.availableAt', 'get_run .jobSteps',
    'get_task .outbound.status', 'get_task .outbound.blockedReason', 'get_task .pipeline.outbound.status',
    'list_tasks .items[].pipeline.outbound.status', 'get_task .review.outboundStatus',
    'list_reviews .items[].outboundStatus', 'get_review .outboundStatus',
    'communication_status .outbound.byStatus', 'communication_status .outbound.blockedByReason'];
  -- What each case must change, measured: the derived boolean, and the queued
  -- run no tenant stop covers becoming held.
  c_expected constant text[] := array[
    'get_agent .agent.activity', 'get_agent .agent.evidence.heldRunIds', 'get_agent .agent.evidence.queuedRunIds',
    'list_agents .items[].activity', 'list_agents .items[].evidence.heldRunIds', 'list_agents .items[].evidence.queuedRunIds',
    'overview .agents.held', 'overview .agents.queued', 'overview .platform.globalAdmissionBlocked',
    'spend_summary .platform.globalAdmissionBlocked'];
  v_case    text;
  v_changed text[];
  v_bad     text;
  v_stop    uuid;
  v_settled bigint;
begin
  foreach v_case in array array['platform job_kind stop', 'global ceiling exhausted by tenant B'] loop
    v_changed := null;
    begin
      if v_case = 'platform job_kind stop' then
        insert into ops.execution_stops (scope, job_kind, reason, tripped_by)
        values ('job_kind', 'agent_run.execute', 'SENTINEL-PLATFORM-KIND-ACTIVE', 'sentinel-platform-tripped-by');
      else
        -- A ceiling tenant A's own settled spend stays under: only tenant B's
        -- spend exhausts it, and the sweep trips the system stop.
        select t.p_settled into v_settled
          from ops.spend_window_total('tenant', pg_temp.id('tenant_a'), null, ops.spend_window_start('UTC', now())) t;
        perform ops.set_spend_limit('global', v_settled + 1, 'UTC', 'SENTINEL-PLATFORM-CEILING-LOWERED',
                                    'sentinel-platform-set-by');
        v_stop := ops.enforce_spend_ceiling();
        if v_stop is null or (select s.tripped_by from ops.execution_stops s where s.id = v_stop) <> 'system:spend_ceiling' then
          raise exception 'T2: tenant B''s spend did not trip the system spend-ceiling stop';
        end if;
      end if;
      perform pg_temp.collect('platform');
      select array_agg(c.fn || ' ' || c.path order by c.fn || ' ' || c.path) into v_changed from pg_temp.platform_changes() c;
      select string_agg(x, ', ') into v_bad from unnest(v_changed) x where x <> all (c_allowed);
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    exception when sqlstate 'C1CAC' then null;
    end;
    if v_bad is not null then
      raise exception 'T2: % changed tenant A''s outputs outside the pinned platform-derived set: %', v_case, v_bad;
    end if;
    if v_changed is distinct from (select array_agg(x order by x) from unnest(c_expected) x) then
      raise exception 'T2: % changed % instead of exactly %', v_case, v_changed, c_expected;
    end if;
  end loop;
end
$$;

-- T3. Every id and cursor parameter, fed tenant B's ids of every kind, the
--     caller's own ids of the wrong kind, platform ids, erased ids and
--     malformed cursors, answers exactly like a fresh random uuid: SQLSTATE,
--     message, detail and hint (brief §11, §16). Catalogue-driven: every table
--     of ops with a uuid id and a tenant, both tenants, up to eight rows each.
create temporary table cos_feed (owner text not null, kind text not null, id uuid not null) on commit drop;

do $$
declare
  v_table text;
  v_task  uuid;
  v_event uuid;
  v_rev   uuid;
  v_stop  uuid;
  v_run   uuid;
begin
  for v_table in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'ops' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
       and exists (select 1 from information_schema.columns i where i.table_schema = 'ops' and i.table_name = c.table_name
                      and i.column_name = 'id' and i.data_type = 'uuid')
     order by 1 loop
    execute format('insert into cos_feed select %L, %L, x.id from (select id from ops.%I where tenant_id = $1 order by id limit 8) x',
                   'a', v_table, v_table) using pg_temp.id('tenant_a');
    execute format('insert into cos_feed select %L, %L, x.id from (select id from ops.%I where tenant_id = $1 order by id limit 8) x',
                   'b', v_table, v_table) using pg_temp.id('tenant_b');
    execute format('insert into cos_feed select %L, %L, x.id from (select id from ops.%I where tenant_id is null order by id limit 8) x',
                   'platform', v_table, v_table);
  end loop;
  insert into cos_feed values ('platform', 'model_prices', pg_temp.id('platform.price'));
  insert into cos_feed select 'platform', 'principals', p.id from ops.principals p where p.id <> pg_temp.id('principal.m_a');
  -- Erased rows: created, then rolled back with their subtransaction.
  begin
    v_task := ops.create_task(pg_temp.id('tenant_a'), pg_temp.id('a.company'), 'crm.follow_up', 'erased', 'cos-api-suite');
    v_event := ops.record_event(pg_temp.id('tenant_a'), pg_temp.id('a.company'), 'custom.erased', 'cos-api-suite');
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed)
    values (pg_temp.id('tenant_a'), pg_temp.id('a.company'), v_task, gen_random_uuid(), 'lead_triage', '{}')
    returning id into v_rev;
    insert into ops.execution_stops (scope, tenant_id, reason, tripped_by)
    values ('tenant', pg_temp.id('tenant_a'), 'erased', 'cos-api-suite') returning id into v_stop;
    v_run := (pg_temp.admit('a', 99, pg_temp.id('tenant_a'), pg_temp.id('a.company'), pg_temp.id('a.agent_holder')) ->> 'agent_run_id')::uuid;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if exists (select 1 from ops.tasks where id = v_task) or exists (select 1 from ops.agent_runs where id = v_run) then
    raise exception 'T3: an erased fixture survived its subtransaction';
  end if;
  insert into cos_feed values ('erased', 'tasks', v_task), ('erased', 'events', v_event),
                              ('erased', 'review_items', v_rev), ('erased', 'execution_stops', v_stop),
                              ('erased', 'agent_runs', v_run);
  if (select count(distinct kind) from cos_feed where owner = 'b') < 14
     or not exists (select 1 from cos_feed where owner = 'platform' and kind = 'execution_stops')
     or not exists (select 1 from cos_feed where owner = 'platform' and kind = 'spend_limits')
     or not exists (select 1 from cos_feed where kind = 'jobs') then
    raise exception 'T3: the feed does not hold every kind of id, so the matrix proves less than it claims';
  end if;
end
$$;

-- What this transaction itself has written so far: per table outside the
-- temporary and TOAST schemas, the rows it inserted, updated and deleted,
-- counted as attempted (a write undone with its subtransaction still counts),
-- and the value of the two global sequences it restarted. Only this backend
-- moves these counters, and no other session can advance a sequence this
-- transaction restarted until it ends, so what another session writes at the
-- same time never shows here (under READ COMMITTED a row count would).
create function pg_temp.own_writes() returns jsonb
language sql volatile as $$
  select jsonb_build_object(
    'tables', (select coalesce(jsonb_object_agg(c.oid::regclass::text, w.n), '{}')
                 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace,
                      lateral (select pg_stat_get_xact_tuples_inserted(c.oid) + pg_stat_get_xact_tuples_updated(c.oid)
                                        + pg_stat_get_xact_tuples_deleted(c.oid) as n) w
                where c.relkind in ('r', 'p', 'm') and ns.nspname !~ '^pg_(temp|toast)' and w.n > 0),
    'events_seq', pg_sequence_last_value('ops.events_seq_seq'),
    'job_events_seq', pg_sequence_last_value('ops.job_events_id_seq'));
$$;

-- One entry per exposed READ: its id and cursor parameters, each with the
-- kind of row it names. A read without an entry fails T3. The one act,
-- decide_review (VOLATILE), writes on success, so its isolation is proven in
-- section V instead: a foreign or erased review answers like a random uuid.
create temporary table cos_matrix (fn text not null, kind text not null, template text not null,
                                   right_kind text, prefix text) on commit drop;
insert into cos_matrix values
  ('operator_context', 'none', 'company_os_api.operator_context()', null, null),
  ('overview', 'none', 'company_os_api.overview()', null, null),
  ('list_agents', 'none', 'company_os_api.list_agents()', null, null),
  ('spend_summary', 'none', 'company_os_api.spend_summary()', null, null),
  ('communication_status', 'none', 'company_os_api.communication_status()', null, null),
  ('get_agent', 'id', 'company_os_api.get_agent(p_agent_id => %L)', 'agents', null),
  ('list_tasks', 'id', 'company_os_api.list_tasks(p_agent_id => %L)', 'agents', null),
  ('list_tasks', 'cursor', 'company_os_api.list_tasks(p_cursor => %L)', 'tasks', 'tk'),
  ('get_task', 'id', 'company_os_api.get_task(p_task_id => %L)', 'tasks', null),
  ('list_runs', 'id', 'company_os_api.list_runs(p_agent_id => %L)', 'agents', null),
  ('list_runs', 'cursor', 'company_os_api.list_runs(p_cursor => %L)', 'agent_runs', 'rn'),
  ('get_run', 'id', 'company_os_api.get_run(p_run_id => %L)', 'agent_runs', null),
  ('list_reviews', 'cursor', 'company_os_api.list_reviews(p_cursor => %L)', 'review_items', 'rv'),
  ('list_reviews', 'cursor', 'company_os_api.list_reviews(p_status => ''accepted'', p_cursor => %L)', 'review_items', 'rv'),
  ('get_review', 'id', 'company_os_api.get_review(p_review_id => %L)', 'review_items', null),
  ('get_review_advice', 'id', 'company_os_api.get_review_advice(p_review_id => %L)', 'review_items', null),
  ('list_events', 'id', 'company_os_api.list_events(p_subject_type => ''task'', p_subject_id => %L)', 'tasks', null),
  ('list_events', 'id', 'company_os_api.list_events(p_subject_type => ''agent_run'', p_subject_id => %L)', 'agent_runs', null),
  ('list_events', 'id', 'company_os_api.list_events(p_subject_type => ''company'', p_subject_id => %L)', 'companies', null),
  ('list_events', 'id', 'company_os_api.list_events(p_subject_type => ''department'', p_subject_id => %L)', 'departments', null),
  ('list_events', 'id', 'company_os_api.list_events(p_subject_type => ''agent'', p_subject_id => %L)', 'agents', null),
  ('list_events', 'cursor', 'company_os_api.list_events(p_cursor => %L)', 'events', 'ev'),
  ('list_stops', 'cursor', 'company_os_api.list_stops(p_include_cleared => true, p_cursor => %L)', 'execution_stops', 'st'),
  ('list_stops', 'cursor', 'company_os_api.list_stops(p_cursor => %L)', 'execution_stops', 'st');

do $$
declare
  c_prefixes constant text[] := array['tk', 'rn', 'rv', 'ev', 'st'];
  v_claims  text := pg_temp.claims('m_a');
  m         record;
  v_ref     jsonb;
  v_got     jsonb;
  v_value   text;
  v_values  text[];
  v_random  text;
  v_own     uuid;
  v_bad     text[] := array[]::text[];
  v_calls   int := 0;
  v_before  jsonb;
begin
  -- Every function has an entry, and every uuid or cursor parameter a template.
  select string_agg(p.proname, ', ') into v_value
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api' and p.provolatile = 's'
     and (not exists (select 1 from cos_matrix cm where cm.fn = p.proname)
          or ('uuid'::regtype = any (p.proargtypes::oid[]::regtype[])
              and not exists (select 1 from cos_matrix cm where cm.fn = p.proname and cm.kind = 'id'))
          or ('p_cursor' = any (p.proargnames)
              and not exists (select 1 from cos_matrix cm where cm.fn = p.proname and cm.kind = 'cursor')));
  if v_value is not null then
    raise exception 'T3: exposed function(s) without a complete isolation matrix entry: %', v_value;
  end if;

  -- The reads write nothing: this transaction's own writes to every table,
  -- ops and auth and the rest, and the global sequences, are the same after
  -- the whole matrix (pg_temp.own_writes). The counters are live: the setup
  -- above wrote events.
  v_before := pg_temp.own_writes();
  if coalesce((v_before -> 'tables' ->> 'ops.events')::bigint, 0) = 0 then
    raise exception 'T3: the transaction''s write counters show none of the setup''s events, so they would prove nothing';
  end if;

  for m in select * from cos_matrix where kind <> 'none' order by fn, template loop
    -- The caller's own row of the right kind is answered (the positive control).
    select f.id into v_own from cos_feed f where f.owner = 'a' and f.kind = m.right_kind
       and (m.template not like '%list_stops(p_cursor%'
            or exists (select 1 from ops.execution_stops s where s.id = f.id and s.cleared_at is null))
     order by f.id limit 1;
    v_got := pg_temp.api(v_claims, format(m.template, case when m.kind = 'cursor' then m.prefix || '1:' || v_own else v_own::text end));
    if not (v_got ->> 'ok')::boolean then
      raise exception 'T3: % refused the caller''s own % (%)', m.template, m.right_kind, v_got;
    end if;

    v_random := gen_random_uuid()::text;
    if m.kind = 'id' then
      v_ref := pg_temp.api(v_claims, format(m.template, v_random));
      if v_ref ->> 'code' is distinct from 'OS404' then
        raise exception 'T3: % answered a fresh random uuid with %, not OS404', m.template, v_ref;
      end if;
      select array_agg(f.id::text) into v_values from cos_feed f where not (f.owner = 'a' and f.kind = m.right_kind);
    else
      v_ref := pg_temp.api(v_claims, format(m.template, m.prefix || '1:' || v_random));
      if v_ref ->> 'code' is distinct from 'OS400' then
        raise exception 'T3: % answered a well-formed cursor naming no row with %, not OS400', m.template, v_ref;
      end if;
      select array_agg(m.prefix || '1:' || f.id) into v_values from cos_feed f where not (f.owner = 'a' and f.kind = m.right_kind);
      -- The caller's own row of the right kind, under every other kind's prefix.
      v_values := v_values || array(
        select p || '1:' || f.id from cos_feed f, unnest(c_prefixes) p
         where f.owner = 'a' and f.kind = m.right_kind and p <> m.prefix);
      -- A cleared stop is not on the active page: its cursor restarts too.
      if m.template like '%list_stops(p_cursor%' then
        v_values := v_values || array(
          select m.prefix || '1:' || s.id from ops.execution_stops s
           where s.tenant_id = pg_temp.id('tenant_a') and s.cleared_at is not null);
      end if;
      -- Malformed cursors.
      v_values := v_values || array[
        '', m.prefix || '1:', m.prefix || '1:not-a-uuid', m.prefix || '2:' || v_random, upper(m.prefix) || '1:' || v_random,
        m.prefix || '1:' || upper(v_random), ' ' || m.prefix || '1:' || v_random, m.prefix || '1:' || v_random || ' ',
        m.prefix || '1:{' || v_random || '}', m.prefix || '1:' || replace(v_random, '-', ''),
        m.prefix || '1:' || v_random || ''';select 1', m.prefix || '1:' || v_random || E'\n', m.prefix || ':' || v_random,
        m.prefix || '01:' || v_random, 'xx1:' || v_random];
    end if;
    foreach v_value in array v_values loop
      v_got := pg_temp.api(v_claims, format(m.template, v_value));
      v_calls := v_calls + 1;
      if v_got is distinct from v_ref then
        v_bad := v_bad || format('%s fed %s: %s', m.template, v_value, v_got);
      end if;
    end loop;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'T3: a foreign, platform, wrong-kind, erased or malformed value answered unlike a random uuid: %',
      array_to_string(v_bad[1:10], ' | ');
  end if;
  if v_calls < 2000 then
    raise exception 'T3: only % isolation calls ran', v_calls;
  end if;
  if v_before is distinct from pg_temp.own_writes() then
    raise exception 'T3: a read wrote a row: before %, after %', v_before, pg_temp.own_writes();
  end if;
end
$$;

-- ===========================================================================
-- E. THE PAGED READS USE THEIR INDEXES (brief §11: "EXPLAIN checks confirm
--    each is used"). Tenant A gets 3000 rows of each paged kind (tasks, runs,
--    reviews half pending and half accepted, events), written in replica mode
--    as N10 writes its rows, and ANALYZE then gives the planner their real
--    shape, all inside a subtransaction that is rolled back: the rows, the
--    statistics and ANALYZE's lock go with it. (ANALYZE also rewrites the
--    page and row estimates in pg_class in place, outside any transaction;
--    they stay until the next autovacuum or ANALYZE of those tables
--    recomputes them. On a shared stack that shifts other sessions' plan
--    estimates, never a result.) The statement EXPLAINed is each
--    projection's own page statement, cut from its body (pg_proc.prosrc),
--    every PL/pgSQL variable in it made a parameter, and planned the way the
--    projection runs it: a custom plan, the call's values folded in, for the
--    first page and for a cursor page. Each must read the pinned index, in
--    either direction, and hold no Sort: a page is the index read up to its
--    limit, never a sort of the tenant's whole list. The four paged reads
--    never run a generic plan (plan_cache_mode = force_custom_plan, pinned by
--    P4). Measured in this suite's own session before that setting existed:
--    PL/pgSQL's plan cache had settled list_tasks on its generic plan, a
--    sequential scan and a sort, because a cached statement switches to its
--    generic plan whenever that costs less than the session's average custom
--    plan over every filter and page read so far. Then the reads run as the
--    member, through their gates, and each page must really scan its index.
-- ===========================================================================

-- The p_nth page statement ("with page as (...)") of a projection, exactly
-- as its body has it, each variable in p_vars replaced by its $n.
create function pg_temp.page_statement(p_fn regprocedure, p_nth int, p_vars text[]) returns text
language plpgsql as $f$
declare
  c_open  constant text := 'with page as (';
  c_close constant text := 'limit v_limit)';
  v_src   text := (select prosrc from pg_proc where oid = p_fn);
  v_at    int := 0;
  v_step  int;
  v_len   int;
  v_sql   text;
  i       int;
begin
  for i in 1 .. p_nth loop
    v_step := strpos(substr(v_src, v_at + 1), c_open);
    if v_step = 0 then
      raise exception 'E: % has no page statement number %', p_fn, p_nth;
    end if;
    v_at := v_at + v_step + length(c_open) - 1;
  end loop;
  v_len := strpos(substr(v_src, v_at + 1), c_close);
  if v_len = 0 then
    raise exception 'E: page statement number % of % does not end at its limit', p_nth, p_fn;
  end if;
  v_sql := substr(v_src, v_at + 1, v_len + length(c_close) - 2);
  for i in 1 .. cardinality(p_vars) loop
    v_sql := regexp_replace(v_sql, '\m' || replace(p_vars[i], '.', '\.') || '\M', '$' || i, 'g');
  end loop;
  -- Every variable is bound: a name left over would plan as a column or fail.
  if v_sql ~ '\m[pv]_[a-z]' then
    raise exception 'E: page statement number % of % keeps an unbound variable: %', p_nth, p_fn, v_sql;
  end if;
  return v_sql;
end
$f$;

-- Every node of an EXPLAIN (FORMAT JSON) plan.
create function pg_temp.plan_nodes(p_plan jsonb) returns setof jsonb
language sql immutable as $$
  select n from jsonb_path_query(p_plan, 'strict $.**') n where jsonb_typeof(n) = 'object' and n ? 'Node Type';
$$;

-- A plan that reads p_index (in either direction) and sorts nothing.
create function pg_temp.plan_reads_index(p_plan jsonb, p_index text) returns boolean
language sql immutable as $$
  select exists (select 1 from pg_temp.plan_nodes(p_plan) n
                  where n ->> 'Node Type' in ('Index Scan', 'Index Only Scan') and n ->> 'Index Name' = p_index)
     and not exists (select 1 from pg_temp.plan_nodes(p_plan) n where n ->> 'Node Type' ~ 'Sort');
$$;

-- A plan's shape, for a failure message.
create function pg_temp.plan_shape(p_plan jsonb) returns text
language sql immutable as $$
  select string_agg(n ->> 'Node Type' || coalesce(' ' || (n ->> 'Scan Direction'), '')
                      || coalesce(' using ' || (n ->> 'Index Name'), '') || coalesce(' on ' || (n ->> 'Relation Name'), ''),
                    ' > ')
    from pg_temp.plan_nodes(p_plan) n;
$$;

-- The page statement, prepared, and planned the way its projection runs it:
-- a custom plan for each argument list, never a generic one (the four paged
-- reads carry plan_cache_mode = force_custom_plan, which P4 pins). Each plan
-- must read p_index and sort nothing.
create function pg_temp.page_plan_faults(p_label text, p_statement text, p_types text, p_index text, p_args text[])
returns text[]
language plpgsql as $f$
declare
  v_args   text;
  v_plan   jsonb;
  v_faults text[] := array[]::text[];
begin
  execute format('prepare cos_page(%s) as %s', p_types, p_statement);
  set local plan_cache_mode = force_custom_plan;
  foreach v_args in array p_args loop
    execute format('explain (format json, costs off) execute cos_page(%s)', v_args) into v_plan;
    if not pg_temp.plan_reads_index(v_plan, p_index) then
      v_faults := v_faults || format('%s (%s): %s', p_label, v_args, pg_temp.plan_shape(v_plan));
    end if;
  end loop;
  deallocate cos_page;
  return v_faults;
end
$f$;

do $$
declare
  ta      uuid := pg_temp.id('tenant_a');
  co      uuid := pg_temp.id('a.company');
  t_plain uuid := pg_temp.id('a.task_plain');
  v_at    timestamptz := now() - interval '1 day';
  c_rows  constant int := 3000;
  v_task  ops.tasks;
  v_run   ops.agent_runs;
  v_rev   ops.review_items;
  v_done  ops.review_items;
  v_event ops.events;
  v_call  text;
  v_index text;
  v_scans bigint;
  v_faults text[] := array[]::text[];
  v_checked int := 0;
begin
  begin
    set local session_replication_role = replica;
    insert into ops.tasks (tenant_id, company_id, type, title, created_at, updated_at)
    select ta, co, 'crm.follow_up', 'Index probe', v_at - make_interval(secs => g), v_at - make_interval(secs => g)
      from generate_series(1, c_rows) g;
    insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                                idempotency_key, request_fingerprint, correlation_id, requested_by, created_at, updated_at)
    select r.tenant_id, r.company_id, r.department_id, r.task_id, r.agent_id, r.capability, r.model_route,
           'index-probe-' || g, r.request_fingerprint, gen_random_uuid(), 'cos-api-suite',
           v_at - make_interval(secs => g), v_at - make_interval(secs => g)
      from ops.agent_runs r, generate_series(1, c_rows) g
     where r.id = pg_temp.id('a.run_queued');
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, status, reviewer,
                                  reviewed_at, created_at, updated_at)
    select ta, co, t_plain, gen_random_uuid(), 'lead_triage', '{}'::jsonb,
           case when g % 2 = 0 then 'pending' else 'accepted' end,
           case when g % 2 = 1 then 'cos-api-suite' end, case when g % 2 = 1 then v_at end,
           v_at - make_interval(secs => g), v_at - make_interval(secs => g)
      from generate_series(1, c_rows) g;
    insert into ops.events (tenant_id, company_id, type, source, subject_type, subject_id, created_at)
    select ta, co, 'custom.index_probe', 'cos-api-suite', 'task', t_plain, v_at - make_interval(secs => g)
      from generate_series(1, c_rows) g;
    set local session_replication_role = origin;
    analyze ops.tasks;
    analyze ops.agent_runs;
    analyze ops.review_items;
    analyze ops.events;

    -- A cursor row in the middle of each list.
    select * into v_task from ops.tasks where tenant_id = ta order by created_at desc, id desc offset c_rows / 2 limit 1;
    select * into v_run from ops.agent_runs where tenant_id = ta order by created_at desc, id desc offset c_rows / 2 limit 1;
    select * into v_rev from ops.review_items where tenant_id = ta and status = 'pending'
     order by created_at, id offset c_rows / 4 limit 1;
    select * into v_done from ops.review_items where tenant_id = ta and status = 'accepted'
     order by created_at desc, id desc offset c_rows / 4 limit 1;
    select * into v_event from ops.events where tenant_id = ta order by created_at desc, seq desc offset c_rows / 2 limit 1;

    v_faults := v_faults || pg_temp.page_plan_faults('list_tasks',
      pg_temp.page_statement('ops.read_tasks(uuid, text, text, uuid, integer)', 1,
        array['p_tenant_id', 'p_status', 'p_agent_id', 'v_cursor', 'v_after.created_at', 'v_after.id', 'v_limit']),
      'uuid, text, uuid, uuid, timestamptz, uuid, integer', 'tasks_tenant_created_id',
      array[format('%L, null, null, null, null, null, 50', ta),
            format('%L, null, null, %L, %L, %L, 50', ta, v_task.id, v_task.created_at, v_task.id)]);
    v_faults := v_faults || pg_temp.page_plan_faults('list_runs',
      pg_temp.page_statement('ops.read_agent_runs(uuid, text, text, uuid, boolean, integer)', 1,
        array['p_tenant_id', 'p_status', 'p_agent_id', 'p_attention_only', 'v_as_of', 'v_cursor', 'v_after.created_at',
              'v_after.id', 'v_limit']),
      'uuid, text, uuid, boolean, timestamptz, uuid, timestamptz, uuid, integer', 'agent_runs_tenant_created_id',
      array[format('%L, null, null, false, now(), null, null, null, 50', ta),
            format('%L, null, null, false, now(), %L, %L, %L, 50', ta, v_run.id, v_run.created_at, v_run.id)]);
    v_faults := v_faults || pg_temp.page_plan_faults('list_reviews, the pending tab',
      pg_temp.page_statement('ops.read_reviews(uuid, text, text, integer)', 1,
        array['p_tenant_id', 'v_status', 'v_cursor', 'v_after.created_at', 'v_after.id', 'v_limit']),
      'uuid, text, uuid, timestamptz, uuid, integer', 'review_items_tenant_created_id',
      array[format('%L, ''pending'', null, null, null, 50', ta),
            format('%L, ''pending'', %L, %L, %L, 50', ta, v_rev.id, v_rev.created_at, v_rev.id)]);
    v_faults := v_faults || pg_temp.page_plan_faults('list_reviews, a decided tab',
      pg_temp.page_statement('ops.read_reviews(uuid, text, text, integer)', 2,
        array['p_tenant_id', 'v_status', 'v_cursor', 'v_after.created_at', 'v_after.id', 'v_limit']),
      'uuid, text, uuid, timestamptz, uuid, integer', 'review_items_tenant_created_id',
      array[format('%L, ''accepted'', null, null, null, 50', ta),
            format('%L, ''accepted'', %L, %L, %L, 50', ta, v_done.id, v_done.created_at, v_done.id)]);
    v_faults := v_faults || pg_temp.page_plan_faults('list_events',
      pg_temp.page_statement('ops.read_events(uuid, text, text, uuid, integer)', 1,
        array['p_tenant_id', 'p_subject_type', 'p_subject_id', 'v_cursor', 'v_after.created_at', 'v_after.seq', 'v_limit']),
      'uuid, text, uuid, uuid, timestamptz, bigint, integer', 'events_tenant_created_seq',
      array[format('%L, null, null, null, null, null, 50', ta),
            format('%L, null, null, %L, %L, %s, 50', ta, v_event.id, v_event.created_at, v_event.seq)]);
    -- And as they run: through the gate, PL/pgSQL and its plan cache, each
    -- page scans its index (this transaction's own scan count of the index,
    -- which nothing else these three reads run scans; list_runs is left to
    -- the EXPLAIN above, since its run summaries may scan its index too).
    for v_call, v_index in select * from (values
        ('company_os_api.list_tasks()', 'ops.tasks_tenant_created_id'),
        (format('company_os_api.list_tasks(p_cursor => %L)', 'tk1:' || v_task.id), 'ops.tasks_tenant_created_id'),
        ('company_os_api.list_reviews()', 'ops.review_items_tenant_created_id'),
        (format('company_os_api.list_reviews(p_cursor => %L)', 'rv1:' || v_rev.id), 'ops.review_items_tenant_created_id'),
        ('company_os_api.list_reviews(p_status => ''accepted'')', 'ops.review_items_tenant_created_id'),
        (format('company_os_api.list_reviews(p_status => ''accepted'', p_cursor => %L)', 'rv1:' || v_done.id),
         'ops.review_items_tenant_created_id'),
        ('company_os_api.list_events()', 'ops.events_tenant_created_seq'),
        (format('company_os_api.list_events(p_cursor => %L)', 'ev1:' || v_event.id), 'ops.events_tenant_created_seq')
      ) as c (call, idx) loop
      v_scans := pg_stat_get_xact_numscans(v_index::regclass);
      perform pg_temp.member_body('E', v_call);
      if pg_stat_get_xact_numscans(v_index::regclass) <= v_scans then
        v_faults := v_faults || format('%s ran without scanning %s', v_call, v_index);
      end if;
    end loop;
    v_checked := 5;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_checked <> 5 or cardinality(v_faults) > 0 then
    raise exception 'E: a paged read does not use its index, or sorts: %',
      coalesce(array_to_string(v_faults, ' | '), 'a check did not run');
  end if;
  if exists (select 1 from ops.tasks where tenant_id = ta and title = 'Index probe')
     or exists (select 1 from pg_prepared_statements where name = 'cos_page')
     or current_setting('plan_cache_mode') <> 'auto' then
    raise exception 'E: a probe row, the prepared statement or the plan mode outlived its subtransaction';
  end if;
end
$$;

-- ===========================================================================
-- N. MINIMISATION (brief §9, §11, §13).
-- ===========================================================================

-- N1. Every read the member made succeeded, and every output has exactly its
--     pinned key set (dynamic maps and event facts folded; N5 pins the facts).
create function pg_temp.norm_path(p text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(p, '\.(todayByStatus|byStatus|inWindowByStatus|blockedByReason|refusedTodayByReason)\.[^.\[]+',
                                       '.\1.*', 'g'),
                        '\.facts\.[^.\[]+', '.facts.*', 'g');
$$;

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s: %s', call, result), '; ') into v_bad
    from cos_out where snapshot = 'busy' and not (result ->> 'ok')::boolean;
  if v_bad is not null then
    raise exception 'N1: a member''s read of its own tenant was refused: %', v_bad;
  end if;

  with pinned (fn, paths) as (values
    ('communication_status', array[
      '.asOf', '.channels', '.channels[].active', '.channels[].agent', '.channels[].agent.id',
      '.channels[].agent.name', '.channels[].id', '.channels[].label', '.channels[].mode',
      '.channels[].updatedAt', '.conversationsActive24h', '.inbound', '.inbound.admittedToday',
      '.inbound.refusedTodayByReason', '.inbound.refusedTodayByReason.*', '.note', '.outbound',
      '.outbound.acceptedWithoutSend', '.outbound.blockedByReason', '.outbound.blockedByReason.*',
      '.outbound.byStatus', '.outbound.byStatus.*', '.outbound.indeterminateOpen', '.v']),
    ('get_agent', array[
      '.agent', '.agent.activity', '.agent.attentionCount', '.agent.availability', '.agent.company',
      '.agent.company.id', '.agent.company.name', '.agent.department', '.agent.department.id',
      '.agent.department.name', '.agent.evidence', '.agent.evidence.attentionRunIds',
      '.agent.evidence.heldRunIds', '.agent.evidence.inactiveUnit', '.agent.evidence.queuedRunIds',
      '.agent.evidence.staleRunIds', '.agent.evidence.stop', '.agent.evidence.stop.id',
      '.agent.evidence.stop.origin', '.agent.evidence.stop.scope', '.agent.evidence.workingRunIds', '.agent.id',
      '.agent.lastRunAt', '.agent.name', '.agent.slug', '.asOf', '.recentRuns', '.recentRuns[].agentId',
      '.recentRuns[].attention', '.recentRuns[].cachedInputTokens', '.recentRuns[].capability',
      '.recentRuns[].chargedCost', '.recentRuns[].chargedCost.micros', '.recentRuns[].chargedCost.usd',
      '.recentRuns[].companyId', '.recentRuns[].completedAt', '.recentRuns[].createdAt',
      '.recentRuns[].errorCategory', '.recentRuns[].errorCode', '.recentRuns[].estimatedCost',
      '.recentRuns[].estimatedCost.micros', '.recentRuns[].estimatedCost.usd', '.recentRuns[].id',
      '.recentRuns[].inputTokens', '.recentRuns[].jobAttempt', '.recentRuns[].latencyMs', '.recentRuns[].model',
      '.recentRuns[].modelRoute', '.recentRuns[].outputTokens', '.recentRuns[].provider',
      '.recentRuns[].reasoningTokens', '.recentRuns[].reservedCost', '.recentRuns[].reservedCost.micros',
      '.recentRuns[].reservedCost.usd', '.recentRuns[].responseModel', '.recentRuns[].retryOfRunId',
      '.recentRuns[].spendLimitRef', '.recentRuns[].spendLimitRef.id', '.recentRuns[].spendLimitRef.scope',
      '.recentRuns[].startedAt', '.recentRuns[].status', '.recentRuns[].stopRef', '.recentRuns[].stopRef.id',
      '.recentRuns[].taskId', '.recentRuns[].totalTokens', '.v']),
    ('get_review', array[
      '.agentRunId', '.allowedDecisions', '.asOf', '.capability', '.createdAt', '.decisionNote',
      '.doNotContact', '.hasNote', '.id', '.outboundStatus', '.reviewedAt', '.shadowDecision',
      '.shadowDecision.status', '.status', '.taskId', '.v']),
    ('get_review_advice', array[
      '.asOf', '.capability', '.flags', '.intent', '.needsHumanReview', '.outcome', '.priority',
      '.recommendedNextAction', '.reviewId', '.summary', '.v', '.withheld']),
    ('get_run', array[
      '.agentId', '.asOf', '.attention', '.cachedInputTokens', '.capability', '.chargedCost',
      '.chargedCost.micros', '.chargedCost.usd', '.companyId', '.completedAt', '.coveringStop',
      '.coveringStop.id', '.coveringStop.origin', '.coveringStop.scope', '.createdAt', '.errorCategory',
      '.errorCode', '.estimatedCost', '.estimatedCost.micros', '.estimatedCost.usd', '.id', '.inputTokens',
      '.job', '.jobAttempt', '.job.attempts', '.job.availableAt', '.job.lastErrorClass', '.job.leaseLive',
      '.job.status', '.jobSteps', '.jobSteps[].at', '.jobSteps[].attempt', '.jobSteps[].step', '.latencyMs',
      '.model', '.modelRoute', '.outputTokens', '.provider', '.reasoningTokens', '.reservedCost',
      '.reservedCost.micros', '.reservedCost.usd', '.responseModel', '.retriedByRunIds', '.retryOfRunId',
      '.spendLimitRef', '.spendLimitRef.id', '.spendLimitRef.scope', '.startedAt', '.status', '.stopRef',
      '.stopRef.id', '.taskId', '.totalTokens', '.v']),
    ('get_task', array[
      '.asOf', '.assignedAgent', '.assignedAgent.id', '.assignedAgent.name', '.company', '.company.id',
      '.company.name', '.createdAt', '.department', '.department.id', '.department.name', '.dueAt', '.events',
      '.events.items', '.events.items[].causationId', '.events.items[].createdAt', '.events.items[].facts',
      '.events.items[].facts.*', '.events.items[].factsWithheld', '.events.items[].id',
      '.events.items[].source', '.events.items[].subjectId', '.events.items[].subjectType',
      '.events.items[].type', '.events.nextCursor', '.id', '.inbound', '.inbound.channelLabel',
      '.inbound.contactResolution', '.inbound.doNotContact', '.inbound.receivedAt', '.inbound.sourceKind',
      '.lifecycleStatus', '.outbound', '.outbound.authorizedAt', '.outbound.blockedReason',
      '.outbound.channelId', '.outbound.deliveredAt', '.outbound.errorClass', '.outbound.errorCode',
      '.outbound.id', '.outbound.readAt', '.outbound.reviewItemId', '.outbound.sendingAt',
      '.outbound.settledAt', '.outbound.status', '.outbound.taskId', '.pipeline', '.pipeline.latestRun',
      '.pipeline.latestRun.id', '.pipeline.latestRun.status', '.pipeline.outbound', '.pipeline.outbound.id',
      '.pipeline.outbound.status', '.pipeline.review', '.pipeline.review.id', '.pipeline.review.status',
      '.priority', '.review', '.review.agentRunId', '.review.capability', '.review.createdAt',
      '.review.doNotContact', '.review.hasNote', '.review.id', '.review.outboundStatus', '.review.reviewedAt',
      '.review.status', '.review.taskId', '.runs', '.runs[].agentId', '.runs[].attention',
      '.runs[].cachedInputTokens', '.runs[].capability', '.runs[].chargedCost', '.runs[].chargedCost.micros',
      '.runs[].chargedCost.usd', '.runs[].companyId', '.runs[].completedAt', '.runs[].createdAt',
      '.runs[].errorCategory', '.runs[].errorCode', '.runs[].estimatedCost', '.runs[].estimatedCost.micros',
      '.runs[].estimatedCost.usd', '.runs[].id', '.runs[].inputTokens', '.runs[].jobAttempt',
      '.runs[].latencyMs', '.runs[].model', '.runs[].modelRoute', '.runs[].outputTokens', '.runs[].provider',
      '.runs[].reasoningTokens', '.runs[].reservedCost', '.runs[].reservedCost.micros',
      '.runs[].reservedCost.usd', '.runs[].responseModel', '.runs[].retryOfRunId', '.runs[].spendLimitRef',
      '.runs[].spendLimitRef.id', '.runs[].spendLimitRef.scope', '.runs[].startedAt', '.runs[].status',
      '.runs[].stopRef', '.runs[].stopRef.id', '.runs[].taskId', '.runs[].totalTokens', '.type', '.v']),
    ('list_agents', array[
      '.asOf', '.items', '.items[].activity', '.items[].attentionCount', '.items[].availability',
      '.items[].company', '.items[].company.id', '.items[].company.name', '.items[].department',
      '.items[].department.id', '.items[].department.name', '.items[].evidence',
      '.items[].evidence.attentionRunIds', '.items[].evidence.heldRunIds', '.items[].evidence.inactiveUnit',
      '.items[].evidence.queuedRunIds', '.items[].evidence.staleRunIds', '.items[].evidence.stop',
      '.items[].evidence.stop.id', '.items[].evidence.stop.origin', '.items[].evidence.stop.scope',
      '.items[].evidence.workingRunIds', '.items[].id', '.items[].lastRunAt', '.items[].name', '.items[].slug',
      '.v']),
    ('list_events', array[
      '.asOf', '.items', '.items[].causationId', '.items[].createdAt', '.items[].facts', '.items[].facts.*',
      '.items[].factsWithheld', '.items[].id', '.items[].source', '.items[].subjectId', '.items[].subjectType',
      '.items[].type', '.nextCursor', '.v']),
    ('list_reviews', array[
      '.asOf', '.items', '.items[].agentRunId', '.items[].capability', '.items[].createdAt',
      '.items[].doNotContact', '.items[].hasNote', '.items[].id', '.items[].outboundStatus',
      '.items[].reviewedAt', '.items[].status', '.items[].taskId', '.nextCursor', '.v']),
    ('list_runs', array[
      '.asOf', '.items', '.items[].agentId', '.items[].attention', '.items[].cachedInputTokens',
      '.items[].capability', '.items[].chargedCost', '.items[].chargedCost.micros', '.items[].chargedCost.usd',
      '.items[].companyId', '.items[].completedAt', '.items[].createdAt', '.items[].errorCategory',
      '.items[].errorCode', '.items[].estimatedCost', '.items[].estimatedCost.micros',
      '.items[].estimatedCost.usd', '.items[].id', '.items[].inputTokens', '.items[].jobAttempt',
      '.items[].latencyMs', '.items[].model', '.items[].modelRoute', '.items[].outputTokens',
      '.items[].provider', '.items[].reasoningTokens', '.items[].reservedCost', '.items[].reservedCost.micros',
      '.items[].reservedCost.usd', '.items[].responseModel', '.items[].retryOfRunId', '.items[].spendLimitRef',
      '.items[].spendLimitRef.id', '.items[].spendLimitRef.scope', '.items[].startedAt', '.items[].status',
      '.items[].stopRef', '.items[].stopRef.id', '.items[].taskId', '.items[].totalTokens', '.nextCursor', '.v']),
    ('list_stops', array[
      '.asOf', '.items', '.items[].clearedAt', '.items[].clearedReason', '.items[].id', '.items[].jobKind',
      '.items[].origin', '.items[].reason', '.items[].scope', '.items[].target', '.items[].target.agentId',
      '.items[].target.companyId', '.items[].target.departmentId', '.items[].target.name', '.items[].trippedAt',
      '.nextCursor', '.v']),
    ('list_tasks', array[
      '.asOf', '.items', '.items[].assignedAgent', '.items[].assignedAgent.id', '.items[].assignedAgent.name',
      '.items[].company', '.items[].company.id', '.items[].company.name', '.items[].createdAt',
      '.items[].department', '.items[].department.id', '.items[].department.name', '.items[].dueAt',
      '.items[].id', '.items[].lifecycleStatus', '.items[].pipeline', '.items[].pipeline.latestRun',
      '.items[].pipeline.latestRun.id', '.items[].pipeline.latestRun.status', '.items[].pipeline.outbound',
      '.items[].pipeline.outbound.id', '.items[].pipeline.outbound.status', '.items[].pipeline.review',
      '.items[].pipeline.review.id', '.items[].pipeline.review.status', '.items[].priority', '.items[].type',
      '.nextCursor', '.v']),
    ('operator_context', array[
      '.allowedActions', '.allowedActions.decideReview', '.allowedActions.tripStop',
      '.allowedActions.viewAdvice', '.asOf', '.dataPolicy', '.principal', '.principal.id', '.role',
      '.serverTime', '.tenant', '.tenant.id', '.tenant.name', '.v']),
    ('overview', array[
      '.admission', '.admission.tenantAdmission',
      -- Phase 3A: the agenda, read only. The fixture tenant has no scheduling
      -- rows, so its lists are empty here; engine/domain/
      -- companyOsAgendaRecording.dbtest.ts parses a populated one with its
      -- strict contract (no subject, actor, key or provider id).
      '.agenda', '.agenda.availability', '.agenda.bookings', '.agenda.bookings.cancelledInWindow',
      '.agenda.bookings.changes', '.agenda.bookings.conflicts', '.agenda.bookings.next7DaysBooked',
      '.agenda.bookings.rescheduledInWindow', '.agenda.bookings.today', '.agenda.bookings.todayBooked',
      '.agenda.bookings.upcoming', '.agenda.calendar', '.agenda.calendar.state', '.agenda.calendar.upcomingSyncs',
      '.agenda.calendar.upcomingSyncs.failed', '.agenda.calendar.upcomingSyncs.indeterminate',
      '.agenda.calendar.upcomingSyncs.pending', '.agenda.calendar.upcomingSyncs.running',
      '.agenda.calendar.upcomingSyncs.skipped', '.agenda.calendar.upcomingSyncs.synced', '.agenda.followUps',
      '.agenda.followUps.awaitingProcessing', '.agenda.followUps.closedRecently', '.agenda.followUps.due',
      '.agenda.followUps.dueToday', '.agenda.followUps.needingAction', '.agenda.followUps.overdue',
      '.agenda.followUps.recentlyClosed', '.agenda.followUps.scheduled', '.agenda.followUps.scheduledNext7Days',
      '.agenda.timezone', '.agenda.timezoneConfigured', '.agenda.today',
      '.agents', '.agents.held', '.agents.inactive',
      '.agents.queued', '.agents.stale', '.agents.stopped', '.agents.total', '.agents.working', '.asOf',
      -- Phase 3B.1: the commercial funnel. The fixture tenant owns the local
      -- CRM, whose configuration stores no stages here, so it reads
      -- stages_not_configured; commercial_funnel.sql and engine/domain/
      -- companyOsFunnelRecording.dbtest.ts read a populated one.
      '.funnel', '.funnel.reason', '.funnel.status',
      -- Phase 2D.3: the group key paths are pinned exactly by decision_shadow.sql D15.
      '.decisionIntelligence', '.decisionIntelligence.currentPolicyVersion', '.decisionIntelligence.groups',
      '.decisionIntelligence.mode',
      -- Phase 2E.2: exact operational health, counts, times and micros only.
      '.operationalHealth', '.operationalHealth.agentRuns', '.operationalHealth.agentRuns.inWindowByStatus',
      '.operationalHealth.agentRuns.inWindowByStatus.*', '.operationalHealth.agentRuns.latency',
      '.operationalHealth.agentRuns.latency.minSamplesP50', '.operationalHealth.agentRuns.latency.minSamplesP95',
      '.operationalHealth.agentRuns.latency.p50Ms', '.operationalHealth.agentRuns.latency.p95Ms',
      '.operationalHealth.agentRuns.latency.sampleSize', '.operationalHealth.decisions',
      '.operationalHealth.decisions.inWindow', '.operationalHealth.decisions.inWindow.abstained',
      '.operationalHealth.decisions.inWindow.completed', '.operationalHealth.decisions.inWindow.failed',
      '.operationalHealth.decisions.inWindow.indeterminate', '.operationalHealth.decisions.inWindow.invalid',
      '.operationalHealth.decisions.inWindow.refused', '.operationalHealth.decisions.pendingNow',
      '.operationalHealth.outbound', '.operationalHealth.outbound.inWindowByStatus',
      '.operationalHealth.outbound.inWindowByStatus.*', '.operationalHealth.queue',
      '.operationalHealth.queue.expiredLeases', '.operationalHealth.queue.failedInWindow',
      '.operationalHealth.queue.oldestReadyAt', '.operationalHealth.queue.ready', '.operationalHealth.queue.running',
      '.operationalHealth.queue.scheduled', '.operationalHealth.queue.succeededInWindow',
      '.operationalHealth.queueByKind', '.operationalHealth.queueByKind[].expiredLeases',
      '.operationalHealth.queueByKind[].failedInWindow', '.operationalHealth.queueByKind[].kind',
      '.operationalHealth.queueByKind[].ready', '.operationalHealth.queueByKind[].running',
      '.operationalHealth.queueByKind[].scheduled', '.operationalHealth.queueByKind[].succeededInWindow',
      '.operationalHealth.spend', '.operationalHealth.spend.chargedInWindow',
      '.operationalHealth.spend.chargedInWindow.micros', '.operationalHealth.spend.chargedInWindow.usd',
      '.operationalHealth.spend.chargedLast7Days', '.operationalHealth.spend.chargedLast7Days.micros',
      '.operationalHealth.spend.chargedLast7Days.usd', '.operationalHealth.spend.chargedToday',
      '.operationalHealth.spend.chargedToday.micros', '.operationalHealth.spend.chargedToday.usd',
      '.operationalHealth.spend.reservedInFlight', '.operationalHealth.spend.reservedInFlight.micros',
      '.operationalHealth.spend.reservedInFlight.usd', '.operationalHealth.windowHours',
      '.outbound', '.outbound.acceptedWithoutSend', '.outbound.indeterminateOpen', '.outbound.todayByStatus',
      '.outbound.todayByStatus.*', '.platform', '.platform.globalAdmissionBlocked', '.reviews',
      '.reviews.oldestPendingAt', '.reviews.pending', '.runs', '.runs.needingAttention', '.runs.todayByStatus',
      '.runs.todayByStatus.*', '.runs.workingNow', '.stops', '.stops.tenantScopedActive', '.v']),
    ('spend_summary', array[
      '.asOf', '.platform', '.platform.globalAdmissionBlocked', '.tenantRows', '.tenantRows[].charged',
      '.tenantRows[].charged.micros', '.tenantRows[].charged.usd', '.tenantRows[].companyId',
      '.tenantRows[].dailyLimit', '.tenantRows[].dailyLimit.micros', '.tenantRows[].dailyLimit.usd',
      '.tenantRows[].estimated', '.tenantRows[].estimated.micros', '.tenantRows[].estimated.usd',
      '.tenantRows[].newRunAdmission', '.tenantRows[].refusedRuns', '.tenantRows[].remaining',
      '.tenantRows[].remaining.micros', '.tenantRows[].remaining.usd', '.tenantRows[].runningRuns',
      '.tenantRows[].scope', '.tenantRows[].settled', '.tenantRows[].settledExhausted',
      '.tenantRows[].settled.micros', '.tenantRows[].settled.usd', '.tenantRows[].timezone',
      '.tenantRows[].unknownCostRuns', '.today', '.today.byAgent', '.today.byAgent[].agent',
      '.today.byAgent[].agent.id', '.today.byAgent[].agent.name', '.today.byAgent[].charged',
      '.today.byAgent[].charged.micros', '.today.byAgent[].charged.usd', '.today.byAgent[].runs',
      '.today.byModel', '.today.byModel[].charged', '.today.byModel[].charged.micros',
      '.today.byModel[].charged.usd', '.today.byModel[].model', '.today.byModel[].provider',
      '.today.byModel[].runs', '.v', '.windowStart'])
  ),
  actual as (
    select fn, array_agg(distinct pg_temp.norm_path(k) order by pg_temp.norm_path(k)) as paths
      from cos_out, pg_temp.key_paths(result -> 'body') k
     where snapshot = 'busy'
     group by fn)
  select string_agg(format('%s: added %s, missing %s', coalesce(a.fn, p.fn),
                           (select array_agg(x) from unnest(a.paths) x where x <> all (coalesce(p.paths, '{}'))),
                           (select array_agg(x) from unnest(p.paths) x where x <> all (coalesce(a.paths, '{}')))), '; ')
    into v_bad
    from actual a full join pinned p on p.fn = a.fn
   where a.paths is distinct from (select array_agg(x order by x) from unnest(p.paths) x);
  if v_bad is not null then
    raise exception 'N1: an output''s key set drifted from the pinned projection: %', v_bad;
  end if;

  -- The folded maps hold only their own vocabularies.
  select string_agg(format('%s %s', o.fn, e.k), ', ') into v_bad
    from cos_out o,
         lateral (select k, 'run' as voc from jsonb_object_keys(o.result -> 'body' -> 'runs' -> 'todayByStatus') k
                  union all select k, 'outbound' from jsonb_object_keys(o.result -> 'body' -> 'outbound' -> 'todayByStatus') k
                  union all select k, 'outbound' from jsonb_object_keys(o.result -> 'body' -> 'outbound' -> 'byStatus') k
                  union all select k, 'run' from jsonb_object_keys(o.result -> 'body' -> 'operationalHealth' -> 'agentRuns' -> 'inWindowByStatus') k
                  union all select k, 'outbound' from jsonb_object_keys(o.result -> 'body' -> 'operationalHealth' -> 'outbound' -> 'inWindowByStatus') k
                  union all select k, 'reason' from jsonb_object_keys(o.result -> 'body' -> 'outbound' -> 'blockedByReason') k
                  union all select k, 'reason' from jsonb_object_keys(o.result -> 'body' -> 'inbound' -> 'refusedTodayByReason') k) e
   where o.snapshot = 'busy' and o.fn in ('overview', 'communication_status')
     and not ((e.voc = 'run' and e.k in ('pending', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled'))
              or (e.voc = 'outbound' and e.k in ('authorized', 'blocked', 'sending', 'sent', 'delivered', 'read', 'failed', 'indeterminate'))
              or (e.voc = 'reason' and e.k ~ '^[a-z][a-z0-9_]{0,63}$'));
  if v_bad is not null then
    raise exception 'N1: a count map carries a key outside its vocabulary: %', v_bad;
  end if;
end
$$;

-- N2. Every excluded column and payload key of brief §13 item 2 carries a
--     planted sentinel (SENTINEL-..., sentinel-..., Sentinel...) in both
--     tenants, and no output carries one: the only allowed content is the
--     advice's summary and next action, in get_review_advice alone.
do $$
declare
  v_check record;
  v_key   text;
  v_bad   text;
  v_found boolean;
begin
  for v_check in select * from (values
      ('tasks.title', 'select 1 from ops.tasks where tenant_id = $1 and title like ''SENTINEL-%'''),
      ('tasks.description', 'select 1 from ops.tasks where tenant_id = $1 and description like ''SENTINEL-%'''),
      ('tasks.idempotency_key', 'select 1 from ops.tasks where tenant_id = $1 and idempotency_key like ''sentinel-%'''),
      ('agents.role', 'select 1 from ops.agents where tenant_id = $1 and role like ''SENTINEL-%'''),
      ('agents.description', 'select 1 from ops.agents where tenant_id = $1 and description like ''SENTINEL-%'''),
      ('inbound_messages.contact_ref', 'select 1 from ops.inbound_messages where tenant_id = $1 and contact_ref like ''synthetic:sentinel-%'''),
      ('inbound_messages.external_message_id', 'select 1 from ops.inbound_messages where tenant_id = $1 and external_message_id like ''wamid.SENTINEL-%'''),
      ('agent_runs.result response_draft', 'select 1 from ops.agent_runs where tenant_id = $1 and result ->> ''response_draft'' like ''SENTINEL-%'''),
      ('agent_runs.provider_request_id', 'select 1 from ops.agent_runs where tenant_id = $1 and provider_request_id like ''sentinel-%'''),
      ('agent_runs.provider_response_id', 'select 1 from ops.agent_runs where tenant_id = $1 and provider_response_id like ''sentinel-%'''),
      ('agent_runs.requested_by', 'select 1 from ops.agent_runs where tenant_id = $1 and requested_by like ''sentinel-%'''),
      ('jobs.last_error', 'select 1 from ops.jobs where tenant_id = $1 and last_error like ''SENTINEL-%'''),
      ('jobs.lease_owner', 'select 1 from ops.jobs where tenant_id = $1 and lease_owner like ''sentinel-%'''),
      ('jobs.payload', 'select 1 from ops.jobs where tenant_id = $1 and payload ->> ''sentinel'' like ''SENTINEL-%'''),
      ('job_events.detail', 'select 1 from ops.job_events where tenant_id = $1 and detail like ''SENTINEL-%'''),
      ('job_events.worker_id', 'select 1 from ops.job_events where tenant_id = $1 and worker_id like ''sentinel-%'''),
      ('events.payload', 'select 1 from ops.events where tenant_id = $1 and payload ->> ''secret'' like ''SENTINEL-%'''),
      ('review_items.proposed response_draft', 'select 1 from ops.review_items where tenant_id = $1 and proposed ->> ''response_draft'' like ''SENTINEL-%'''),
      ('review_items.reviewer', 'select 1 from ops.review_items where tenant_id = $1 and reviewer like ''sentinel-%'''),
      ('outbound_messages.requested_by', 'select 1 from ops.outbound_messages where tenant_id = $1 and requested_by like ''sentinel-%'''),
      ('outbound_messages.provider_message_id', 'select 1 from ops.outbound_messages where tenant_id = $1 and provider_message_id like ''wamid.SENTINEL-%'''),
      ('outbound_messages.authorized_check', 'select 1 from ops.outbound_messages where tenant_id = $1 and authorized_check ->> ''sentinel'' like ''SENTINEL-%'''),
      ('outbound_messages.send_check', 'select 1 from ops.outbound_messages where tenant_id = $1 and send_check ->> ''sentinel'' like ''SENTINEL-%'''),
      ('communication_channels.configured_by', 'select 1 from ops.communication_channels where tenant_id = $1 and configured_by like ''sentinel-%'''),
      ('execution_stops.tripped_by', 'select 1 from ops.execution_stops where tenant_id = $1 and tripped_by like ''sentinel-%'''),
      ('execution_stops.cleared_by', 'select 1 from ops.execution_stops where tenant_id = $1 and cleared_by like ''sentinel-%'''),
      ('spend_limits.set_by', 'select 1 from ops.spend_limits where tenant_id = $1 and set_by like ''sentinel-%'''),
      ('spend_limits.ended_by', 'select 1 from ops.spend_limits where tenant_id = $1 and ended_by like ''sentinel-%'''),
      ('spend_limits.reason', 'select 1 from ops.spend_limits where tenant_id = $1 and reason like ''SENTINEL-%'''),
      ('principals.display_name', 'select 1 from ops.principals p join ops.tenant_memberships m on m.principal_id = p.id where m.tenant_id = $1 and p.display_name like ''Sentinel %'''),
      ('auth.users.email', 'select 1 from auth.users u join ops.principals p on p.subject = u.id join ops.tenant_memberships m on m.principal_id = p.id where m.tenant_id = $1 and u.email like ''Sentinel.%''')
    ) as c (label, probe) loop
    foreach v_key in array array['tenant_a', 'tenant_b'] loop
      execute format('select exists (%s)', v_check.probe) into v_found using pg_temp.id(v_key);
      if not v_found then
        raise exception 'N2: no sentinel planted in % for %, so the sweep proves nothing there', v_check.label, v_key;
      end if;
    end loop;
  end loop;
  if not exists (select 1 from ops.model_prices where recorded_by like 'sentinel-%' and source like 'SENTINEL-%') then
    raise exception 'N2: no sentinel planted in the platform price';
  end if;

  select string_agg(distinct format('%s: %s', o.call, m[1]), '; ') into v_bad
    from cos_out o,
         regexp_matches(case when o.fn = 'get_review_advice'
                             then replace(replace(o.result::text, 'SENTINEL-A-SUMMARY', ''), 'SENTINEL-A-NEXT', '')
                             else o.result::text end,
                        '(sentinel[^",]{0,40})', 'gi') m
   where o.snapshot = 'busy';
  if v_bad is not null then
    raise exception 'N2: an excluded value reached an output: %', v_bad;
  end if;
  -- The advice content does leave, and only on explicit open.
  if not exists (select 1 from cos_out where snapshot = 'busy' and fn = 'get_review_advice'
                    and result::text like '%SENTINEL-A-SUMMARY%' and result::text like '%SENTINEL-A-NEXT%') then
    raise exception 'N2: the advice summary and next action never left, so the exception is untested';
  end if;
end
$$;

-- N3. Identifiers and amounts that must never leave: every row id of tenant B
--     and of the platform, B's names and distinctive budget, the global ceiling,
--     other principals and memberships, the excluded identifiers of tenant A
--     (correlation ids, idempotency keys, fingerprints, contact refs, external
--     and provider ids, conversations, inbound rows, jobs, provider targets,
--     email hashes, auth emails), the legacy labels, and every global sequence
--     value (events.seq and job_events.id restarted at distinctive values).
create temporary table cos_forbidden (value text not null, what text not null) on commit drop;

do $$
declare
  ta      uuid := pg_temp.id('tenant_a');
  tb      uuid := pg_temp.id('tenant_b');
  v_table text;
  v_bad   text;
begin
  -- Every row of tenant B, catalogue-driven.
  for v_table in
    select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'ops' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
       and exists (select 1 from information_schema.columns i where i.table_schema = 'ops' and i.table_name = c.table_name
                      and i.column_name = 'id' and i.data_type = 'uuid') loop
    execute format('insert into cos_forbidden select id::text, %L from ops.%I where tenant_id = $1', 'tenant B ' || v_table, v_table)
      using tb;
    execute format('insert into cos_forbidden select id::text, %L from ops.%I where tenant_id is null', 'platform ' || v_table, v_table);
  end loop;
  insert into cos_forbidden values (tb::text, 'tenant B'), (pg_temp.id('tenant_c')::text, 'tenant C'),
    ('Zeta-B77', 'tenant B names'), ('987654321987', 'tenant B budget micros'), ('987654.321987', 'tenant B budget USD'),
    ('876543219876', 'global ceiling micros'), ('876543.219876', 'global ceiling USD'),
    ('person@example.test', 'legacy actor label (A)'), ('person-b@example.test', 'legacy actor label (B)');
  insert into cos_forbidden select id::text, 'price' from ops.model_prices;
  insert into cos_forbidden select id::text, 'principal' from ops.principals where id <> pg_temp.id('principal.m_a');
  insert into cos_forbidden select id::text, 'membership' from ops.tenant_memberships;
  insert into cos_forbidden select email_at_grant_sha256, 'email hash' from ops.tenant_memberships;
  insert into cos_forbidden select u.email, 'auth email' from auth.users u where u.email like 'Sentinel.Cos.%';
  insert into cos_forbidden select lower(u.email), 'auth email, lower-cased' from auth.users u where u.email like 'Sentinel.Cos.%';
  -- Tenant A's excluded identifiers.
  insert into cos_forbidden
    select x.v, x.w from (
      select correlation_id::text v, 'run correlation id' w from ops.agent_runs where tenant_id = ta
      union all select idempotency_key, 'run idempotency key' from ops.agent_runs where tenant_id = ta
      union all select request_fingerprint, 'run request fingerprint' from ops.agent_runs where tenant_id = ta
      union all select input_fingerprint, 'run input fingerprint' from ops.agent_runs where tenant_id = ta
      union all select job_id::text, 'run job id' from ops.agent_runs where tenant_id = ta
      union all select correlation_id::text, 'event correlation id' from ops.events where tenant_id = ta
      union all select idempotency_key, 'event idempotency key' from ops.events where tenant_id = ta
      union all select request_fingerprint, 'event request fingerprint' from ops.events where tenant_id = ta
      union all select idempotency_key, 'task idempotency key' from ops.tasks where tenant_id = ta
      union all select request_fingerprint, 'task request fingerprint' from ops.tasks where tenant_id = ta
      union all select id::text, 'inbound message id' from ops.inbound_messages where tenant_id = ta
      union all select contact_ref, 'inbound contact ref' from ops.inbound_messages where tenant_id = ta
      union all select external_message_id, 'external message id' from ops.inbound_messages where tenant_id = ta
      union all select body_fingerprint, 'body fingerprint' from ops.inbound_messages where tenant_id = ta
      union all select crm_contact_ref, 'CRM contact ref' from ops.inbound_messages where tenant_id = ta
      union all select id::text, 'conversation id' from ops.conversations where tenant_id = ta
      union all select contact_ref, 'conversation contact ref' from ops.conversations where tenant_id = ta
      union all select id::text, 'job id' from ops.jobs where tenant_id = ta
      union all select idempotency_key, 'job idempotency key' from ops.jobs where tenant_id = ta
      union all select provider_target, 'provider target' from ops.communication_channels where tenant_id = ta
      union all select provider_message_id, 'provider message id' from ops.outbound_messages where tenant_id = ta
      union all select seq::text, 'events.seq' from ops.events where tenant_id in (ta, tb)
      union all select id::text, 'job_events.id' from ops.job_events where tenant_id in (ta, tb)) x
     where x.v is not null;
  -- The fixtures really carry what the sweep looks for.
  if (select min(seq) from ops.events where tenant_id in (ta, tb)) < 9876543210000
     or (select min(id) from ops.job_events where tenant_id in (ta, tb)) < 8765432100000
     or not exists (select 1 from cos_forbidden where what = 'CRM contact ref')
     or not exists (select 1 from cos_forbidden where what = 'run correlation id')
     or (select count(*) from cos_forbidden where what like 'tenant B %') < 100 then
    raise exception 'N3: the forbidden set is not what the fixtures promise';
  end if;

  select string_agg(distinct format('%s (%s) in %s', f.value, f.what, o.call), '; ') into v_bad
    from cos_forbidden f join cos_out o on o.snapshot = 'busy' and strpos(o.result::text, f.value) > 0;
  if v_bad is not null then
    raise exception 'N3: a foreign, platform, excluded or global-sequence value reached tenant A''s outputs: %', v_bad;
  end if;
end
$$;

-- N4. Cursors: nextCursor is exactly '<kind>1:<id of the last item>', only on
--     a full page; the pages chain without a gap or a repeat, into exactly
--     the list the unpaged read returns.
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s -> %s', call, result -> 'body' ->> 'nextCursor'), '; ') into v_bad
    from cos_out
   where snapshot = 'busy' and result -> 'body' ? 'nextCursor'
     and (result -> 'body' -> 'nextCursor') <> 'null'::jsonb
     and ((result -> 'body' ->> 'nextCursor') is distinct from
            (case fn when 'list_tasks' then 'tk' when 'list_runs' then 'rn' when 'list_reviews' then 'rv'
                     when 'list_events' then 'ev' when 'list_stops' then 'st' end)
            || '1:' || (result -> 'body' -> 'items' -> -1 ->> 'id')
          or jsonb_array_length(result -> 'body' -> 'items')
             <> coalesce(substring(call from 'p_limit => ([0-9]+)')::int, 50));
  if v_bad is not null then
    raise exception 'N4: a nextCursor is not exactly the kind and the last item id of a full page: %', v_bad;
  end if;
  select string_agg(call, '; ') into v_bad
    from cos_out
   where snapshot = 'busy' and result -> 'body' ? 'nextCursor' and (result -> 'body' -> 'nextCursor') = 'null'::jsonb
     and jsonb_array_length(result -> 'body' -> 'items') >= coalesce(substring(call from 'p_limit => ([0-9]+)')::int, 50)
     and call like '%p_limit%';
  if v_bad is not null then
    raise exception 'N4: a full page gave no cursor: %', v_bad;
  end if;

  with series (prefix, full_call) as (values
         ('company_os_api.list_tasks(p_limit => 2', 'company_os_api.list_tasks()'),
         ('company_os_api.list_runs(p_limit => 2', 'company_os_api.list_runs()'),
         ('company_os_api.list_reviews(p_limit => 1', 'company_os_api.list_reviews()'),
         ('company_os_api.list_reviews(p_status => ''accepted'', p_limit => 1',
          'company_os_api.list_reviews(p_status => ''accepted'')'),
         ('company_os_api.list_events(p_limit => 7', 'company_os_api.list_events()'),
         ('company_os_api.list_stops(p_include_cleared => true, p_limit => 1',
          'company_os_api.list_stops(p_include_cleared => true)')),
       chained as (
         select s.prefix, array_agg(e.value ->> 'id' order by o.n, e.ordinality) as ids
           from series s
           join cos_out o on o.snapshot = 'busy' and starts_with(o.call, s.prefix)
          cross join jsonb_array_elements(o.result -> 'body' -> 'items') with ordinality as e
          group by s.prefix),
       unpaged as (
         select s.prefix, (select array_agg(e.value ->> 'id' order by e.ordinality)
                             from jsonb_array_elements(o.result -> 'body' -> 'items') with ordinality as e) as ids
           from series s
           join cos_out o on o.snapshot = 'busy' and o.call = s.full_call
          where o.n = (select min(x.n) from cos_out x where x.snapshot = 'busy' and x.call = s.full_call))
  select string_agg(s.prefix, '; ') into v_bad
    from series s left join chained c using (prefix) left join unpaged u using (prefix)
   where c.ids is null or u.ids is null or cardinality(c.ids) < 2
      or c.ids[1:cardinality(u.ids)] is distinct from u.ids
      or cardinality(c.ids) <> (select count(distinct x) from unnest(c.ids) x);
  if v_bad is not null then
    raise exception 'N4: paging does not chain into the unpaged list: %', v_bad;
  end if;
end
$$;

-- N5. Events: the source is a pinned provenance label or 'other'; the facts
--     are exactly the keys allowlisted for the type (deny by default; no
--     marked_by, ever); an unknown type has {} and factsWithheld.
do $$
declare
  v_bad text;
begin
  with items as (
         select e from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
          where o.snapshot = 'busy' and o.fn = 'list_events'
         union all
         select e from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'events' -> 'items') e
          where o.snapshot = 'busy' and o.fn = 'get_task'),
       expected (type, facts) as (values
         ('lead_triage.reviewed', '{decision}'::text[]),
         ('communication.inbound_refused', '{channel_id,reason}'), ('communication.inbound_held', '{channel_id,reason}'),
         ('communication.channel_configured', '{active,channel_id,mode}'),
         ('communication.outbound_authorized', '{outbound_message_id,review_item_id}'),
         ('communication.outbound_blocked', '{outbound_message_id,reason}'),
         ('communication.outbound_attempted', '{outbound_message_id}'), ('communication.outbound_sent', '{outbound_message_id}'),
         ('communication.outbound_failed', '{outbound_message_id}'), ('communication.outbound_indeterminate', '{outbound_message_id}'),
         ('communication.delivery_updated', '{outbound_message_id,previous,status}'),
         ('company.status_changed', '{from_status,to_status}'), ('department.status_changed', '{from_status,to_status}'),
         ('agent.status_changed', '{from_status,to_status}'), ('task.status_changed', '{from_status,to_status}'),
         ('task.completed', '{from_status,to_status}'), ('task.failed', '{from_status,to_status}'),
         ('task.cancelled', '{from_status,to_status}'), ('task.assigned', '{from_status,to_status}'),
         ('agent_run.started', '{from_status,to_status}'), ('agent_run.succeeded', '{from_status,to_status}'),
         ('agent_run.failed', '{from_status,to_status}'), ('agent_run.indeterminate', '{from_status,to_status}'),
         ('agent_run.cancelled', '{from_status,to_status}'))
  select string_agg(distinct format('%s %s: facts %s, withheld %s, source %s (stored %s)', i.e ->> 'type', i.e ->> 'id',
                                    i.e -> 'facts', i.e -> 'factsWithheld', i.e ->> 'source', ev.source), '; ')
    into v_bad
    from items i
    join ops.events ev on ev.id = (i.e ->> 'id')::uuid
    left join expected x on x.type = i.e ->> 'type'
   where (select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(i.e -> 'facts') k)
           is distinct from coalesce(x.facts, '{}')
      or (i.e -> 'factsWithheld') is distinct from to_jsonb(not ops.cos_event_known(ev.type))
      or (i.e ->> 'source') is distinct from
           (case when ev.source in ('agent-runtime', 'agent-runtime-smoke', 'company-os-ui', 'lead-triage-demo',
                                    'operator-cli', 'seed', 'whatsapp-gateway')
                 then ev.source else 'other' end);
  if v_bad is not null then
    raise exception 'N5: an event left with more than its allowlisted facts, or an unlisted source: %', v_bad;
  end if;
  -- The fixtures reach the interesting branches.
  if not exists (select 1 from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
                  where o.snapshot = 'busy' and o.fn = 'list_events' and e ->> 'type' = 'custom.thing_happened'
                    and e ->> 'source' = 'other' and e -> 'facts' = '{}'::jsonb and (e ->> 'factsWithheld')::boolean)
     or not exists (select 1 from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
                     where o.snapshot = 'busy' and o.fn = 'list_events'
                       and e ->> 'type' = 'communication.outbound_indeterminate')
     or not exists (select 1 from ops.events where tenant_id = pg_temp.id('tenant_a')
                       and type = 'communication.outbound_indeterminate' and payload ->> 'marked_by' = 'person@example.test') then
    raise exception 'N5: the unknown-type, unlisted-source or marked_by fixtures did not reach the feed';
  end if;
  if exists (select 1 from cos_out o, pg_temp.key_paths(o.result -> 'body') k
              where o.snapshot = 'busy' and k ~ '\.(marked_by|markedBy)$') then
    raise exception 'N5: a marked_by key left the database';
  end if;
end
$$;

-- N6. The advice (brief §13 item 3): the structured fields of lead_triage on
--     explicit open, never the draft; withheld for another capability, a task
--     no admission created, an origin no longer in test mode, and an invalid
--     proposal; a foreign review is OS404 before any of those; no advice field
--     in list_reviews or get_review.
do $$
declare
  c_full constant text[] := array['asOf', 'capability', 'flags', 'intent', 'needsHumanReview', 'outcome', 'priority',
                                  'recommendedNextAction', 'reviewId', 'summary', 'v'];
  c_held constant text[] := array['asOf', 'reviewId', 'v', 'withheld'];
  v      jsonb;
  v_ref  jsonb;
  v_rev  uuid;
  v_bad  text;
begin
  v := pg_temp.member_body('N6', format('company_os_api.get_review_advice(%L)', pg_temp.id('a.review_ok')));
  if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from c_full
     or v ->> 'summary' not like 'SENTINEL-A-SUMMARY%' or v ->> 'recommendedNextAction' not like 'SENTINEL-A-NEXT%'
     or v::text like '%DRAFT%' or v ->> 'capability' <> 'lead_triage' then
    raise exception 'N6: the lead_triage advice is not exactly its pinned structured fields: %', v;
  end if;
  foreach v_bad in array array['review_invalid:contract_invalid', 'review_capability:capability_not_pinned',
                               'review_no_admission:origin_not_synthetic_or_test'] loop
    v := pg_temp.member_body('N6', format('company_os_api.get_review_advice(%L)', pg_temp.id('a.' || split_part(v_bad, ':', 1))));
    if v ->> 'withheld' is distinct from split_part(v_bad, ':', 2)
       or (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from c_held then
      raise exception 'N6: % was not withheld as %: %', split_part(v_bad, ':', 1), split_part(v_bad, ':', 2), v;
    end if;
  end loop;

  -- A WhatsApp task admitted on a test line gives advice until that line
  -- leaves test mode; read at call time, it is then withheld.
  v := pg_temp.member_body('N6', format('company_os_api.get_review_advice(%L)', pg_temp.id('a.review_prod')));
  if v ? 'withheld' then
    raise exception 'N6: advice on a test line was withheld before the line left test mode: %', v;
  end if;
  perform ops.configure_whatsapp_channel(pg_temp.id('tenant_a'), pg_temp.id('a.company'), pg_temp.id('a.agent_triage'),
                                         '3009876500003', 'production', 'Second test A', 'sentinel-a-configured-by', false);
  v := pg_temp.member_body('N6', format('company_os_api.get_review_advice(%L)', pg_temp.id('a.review_prod')));
  if v ->> 'withheld' is distinct from 'origin_not_synthetic_or_test'
     or (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from c_held then
    raise exception 'N6: advice for a line now in production was not withheld: %', v;
  end if;

  -- Tenant B's reviews, in every branch, answer exactly like a random uuid.
  v_ref := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.get_review_advice(%L)', gen_random_uuid()));
  for v_rev in select r.id from ops.review_items r where r.tenant_id = pg_temp.id('tenant_b') loop
    v := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.get_review_advice(%L)', v_rev));
    if v is distinct from v_ref or v_ref ->> 'code' <> 'OS404' then
      raise exception 'N6: tenant B''s review % answered % instead of %', v_rev, v, v_ref;
    end if;
  end loop;

  if exists (select 1 from cos_out o, pg_temp.key_paths(o.result -> 'body') k
              where o.snapshot = 'busy' and o.fn in ('list_reviews', 'get_review', 'get_task')
                and k ~ '\.(outcome|intent|flags|summary|recommendedNextAction|needsHumanReview|proposed|responseDraft|response_draft)$') then
    raise exception 'N6: an advice field left through a list or a review detail';
  end if;
end
$$;

-- N7. The legacy actor labels (brief §16, PR #6 review). A: a review decided
--     by the owner service under 'person@example.test'; B: an active and a
--     cleared tenant stop under it; C: a send requested under it; the mark
--     under it; none of which leaves (N3 sweeps the value). D: free text and
--     configuration labels carrying email-like substrings ARE returned, as
--     content, and only where the projection returns that field.
do $$
declare
  v    jsonb;
  v_ok boolean;
begin
  -- A.
  v := pg_temp.member_body('N7', format('company_os_api.get_review(%L)', pg_temp.id('a.review_accepted')));
  if v ? 'reviewer' or v ->> 'status' <> 'accepted' then
    raise exception 'N7 (A): the decided review carries a reviewer, or is not decided: %', v;
  end if;
  if exists (select 1 from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
              where o.snapshot = 'busy' and o.fn = 'list_reviews' and e ? 'reviewer') then
    raise exception 'N7 (A): a review list item carries a reviewer';
  end if;
  -- B: the active stop reaches the agent's evidence, the refused run's stopRef
  -- and the held run's covering stop as {id, scope, origin} or {id} only.
  v := pg_temp.member_body('N7', format('company_os_api.get_agent(%L)', pg_temp.id('a.agent_follow')));
  if v -> 'agent' -> 'evidence' -> 'stop' is distinct from
       jsonb_build_object('id', pg_temp.id('a.stop_agent'), 'scope', 'agent', 'origin', 'owner')
     or v -> 'agent' ->> 'availability' <> 'stopped' then
    raise exception 'N7 (B): the agent''s stop evidence is not exactly {id, scope, origin}: %', v -> 'agent';
  end if;
  v := pg_temp.member_body('N7', format('company_os_api.get_run(%L)', pg_temp.id('a.run_stopped')));
  if v -> 'stopRef' is distinct from jsonb_build_object('id', pg_temp.id('a.stop_agent')) then
    raise exception 'N7 (B): the refused run''s stopRef is not exactly {id}: %', v -> 'stopRef';
  end if;
  v := pg_temp.member_body('N7', format('company_os_api.get_run(%L)', pg_temp.id('a.run_held')));
  if v -> 'coveringStop' is distinct from
       jsonb_build_object('id', pg_temp.id('a.stop_agent'), 'scope', 'agent', 'origin', 'owner') then
    raise exception 'N7 (B): the held run''s covering stop is not exactly {id, scope, origin}: %', v -> 'coveringStop';
  end if;
  v := pg_temp.member_body('N7', 'company_os_api.list_stops(p_include_cleared => true)');
  if not exists (select 1 from jsonb_array_elements(v -> 'items') e where (e ->> 'id')::uuid = pg_temp.id('a.stop_tenant_cleared')
                    and e ->> 'clearedReason' = 'Drill over; mail drill@example.test')
     or not exists (select 1 from jsonb_array_elements(v -> 'items') e where (e ->> 'id')::uuid = pg_temp.id('a.stop_agent'))
     or exists (select 1 from jsonb_array_elements(v -> 'items') e where e ? 'trippedBy' or e ? 'clearedBy'
                   or e ? 'tripped_by' or e ? 'cleared_by') then
    raise exception 'N7 (B): the stops list misses a tenant stop or carries an actor label: %', v;
  end if;
  -- C.
  v := pg_temp.member_body('N7', format('company_os_api.get_task(%L)', pg_temp.id('a.task_live')));
  if v -> 'outbound' ? 'requestedBy' or v -> 'outbound' ? 'requested_by'
     or (v -> 'outbound' ->> 'id')::uuid is distinct from pg_temp.id('a.outbound_indeterminate') then
    raise exception 'N7 (C): the task''s send carries a requester label, or is missing: %', v -> 'outbound';
  end if;
  -- The operator context names no display name.
  v := pg_temp.member_body('N7', 'company_os_api.operator_context()');
  if v::text ~* 'display|Sentinel Display' or v -> 'principal' is distinct from jsonb_build_object('id', pg_temp.id('principal.m_a')) then
    raise exception 'N7: the operator context carries a display name or more than the principal id: %', v;
  end if;
  -- D: content with email-like substrings is returned, in its own field only.
  select bool_and(x) into v_ok from (values
    (exists (select 1 from cos_out where snapshot = 'busy' and fn = 'get_review'
                and result -> 'body' ->> 'decisionNote' = 'Call back; cc someone@example.test')),
    (not exists (select 1 from cos_out where snapshot = 'busy' and fn <> 'get_review'
                    and result::text like '%someone@example.test%')),
    (exists (select 1 from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
              where o.snapshot = 'busy' and o.fn = 'list_stops' and e ->> 'reason' = 'Synthetic pause; ask ops@example.test')),
    (exists (select 1 from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
              where o.snapshot = 'busy' and o.fn = 'list_agents' and e -> 'company' ->> 'name' = 'Clinic A (desk@example.test)'
                and e ->> 'name' = 'Lead Triage (triage@example.test)')),
    (exists (select 1 from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'channels') e
              where o.snapshot = 'busy' and o.fn = 'communication_status'
                and e ->> 'label' = 'Synthetic test line ops-line@example.test')),
    (exists (select 1 from cos_out where snapshot = 'busy' and fn = 'get_task'
                and result -> 'body' -> 'inbound' ->> 'channelLabel' = 'Synthetic test line ops-line@example.test'))) as t (x);
  if not v_ok then
    raise exception 'N7 (D): free text or a configuration label with an email-like substring was not returned as content, or leaked elsewhere';
  end if;
end
$$;

-- N8. The Phase 2B real-data gate is unchanged, every production line stays
--     inactive, and no graph body can write a channel (P6 pins the bodies).
do $$
begin
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'ops.communication_channels'::regclass and c.conname = 'communication_channels_q8_real_data_gate')
     is distinct from 'CHECK (((mode = ''test''::text) OR (NOT active)))' then
    raise exception 'N8: the Q8 real-data gate constraint changed or is gone';
  end if;
  if exists (select 1 from ops.communication_channels where mode = 'production' and active) then
    raise exception 'N8: a production channel is active';
  end if;
end
$$;

-- N9. Reference classification (brief §7.4, §9; §16 "every reference to a
--     platform-scoped row is null"). A stored reference to a platform row
--     leaves as null in every projection that carries it; one to the caller's
--     own row leaves as its id; one to another tenant's row is the
--     operation's fixed internal error (OS500), never data.
do $$
declare
  ta       uuid := pg_temp.id('tenant_a');
  c_refused constant uuid[] := array[pg_temp.id('a.run_platform_stopped'), pg_temp.id('a.run_platform_limit')];
  v_bad    text;
  v_task   uuid;
  v_rev    uuid;
  v_b_run  uuid := pg_temp.id('b.run_failed');
  v_fn     text;
  v_call   text;
  v_got    jsonb;
  v_calls  jsonb := '[]';
begin
  -- The fixtures store what this section classifies.
  if not exists (select 1 from ops.agent_runs r join ops.execution_stops s on s.id = r.stop_id
                  where r.tenant_id = ta and s.tenant_id is null)
     or not exists (select 1 from ops.agent_runs r join ops.spend_limits l on l.id = r.spend_limit_id
                     where r.tenant_id = ta and l.tenant_id is null) then
    raise exception 'N9: no tenant A run stores a platform stop or limit, so the platform branch is untested';
  end if;

  -- Every run summary of the two refused runs, wherever a read carries one.
  with occ (fn, run) as (
         select o.fn, o.result -> 'body' from cos_out o where o.snapshot = 'busy' and o.fn = 'get_run'
         union all
         select o.fn, e from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'items') e
          where o.snapshot = 'busy' and o.fn = 'list_runs'
         union all
         select o.fn, e from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'runs') e
          where o.snapshot = 'busy' and o.fn = 'get_task'
         union all
         select o.fn, e from cos_out o, jsonb_array_elements(o.result -> 'body' -> 'recentRuns') e
          where o.snapshot = 'busy' and o.fn = 'get_agent'),
       mine as (select fn, run from occ where (run ->> 'id')::uuid = any (c_refused)),
       expected (fn, id) as (select f, r from unnest(array['get_run', 'list_runs', 'get_task', 'get_agent']) f,
                                              unnest(c_refused) r)
  select string_agg(x, '; ') into v_bad from (
    select format('%s carries no summary of run %s', e.fn, e.id) x
      from expected e
     where not exists (select 1 from mine m where m.fn = e.fn and (m.run ->> 'id')::uuid = e.id)
    union all
    select format('%s: run %s has stopRef %s and spendLimitRef %s', m.fn, m.run ->> 'id',
                  m.run -> 'stopRef', m.run -> 'spendLimitRef')
      from mine m
     where m.run -> 'stopRef' is distinct from 'null'::jsonb
        or m.run -> 'spendLimitRef' is distinct from 'null'::jsonb) z;
  if v_bad is not null then
    raise exception 'N9: a reference to a platform row did not leave as null: %', v_bad;
  end if;

  -- The positive control: a reference to the caller's own limit leaves.
  v_got := pg_temp.member_body('N9', format('company_os_api.get_run(%L)', pg_temp.id('a.run_budget')));
  if v_got -> 'spendLimitRef' is distinct from
       (select jsonb_build_object('id', r.spend_limit_id, 'scope', 'company') from ops.agent_runs r
         where r.id = pg_temp.id('a.run_budget')) then
    raise exception 'N9: the run refused by its own company budget does not name that limit: %', v_got -> 'spendLimitRef';
  end if;

  -- A reference to tenant B's run, stored on a tenant A review of a task of
  -- its own; every read reaching it answers the fixed OS500, rolled back
  -- with its subtransaction.
  begin
    v_task := ops.create_task(ta, pg_temp.id('a.company'), 'crm.follow_up', 'Foreign reference probe', 'cos-api-suite');
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
    values (ta, pg_temp.id('a.company'), v_task, v_b_run, 'lead_triage', pg_temp.triage_result('a'), false)
    returning id into v_rev;
    for v_fn, v_call in values
        ('list_reviews', 'company_os_api.list_reviews()'),
        ('list_reviews', 'company_os_api.list_reviews(p_status => ''pending'')'),
        ('get_review', format('company_os_api.get_review(%L)', v_rev)),
        ('get_task', format('company_os_api.get_task(%L)', v_task)) loop
      v_calls := v_calls || jsonb_build_array(jsonb_build_object(
        'fn', v_fn, 'call', v_call, 'got', pg_temp.api(pg_temp.claims('m_a'), v_call)));
    end loop;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if exists (select 1 from ops.review_items where agent_run_id = v_b_run and tenant_id = ta) then
    raise exception 'N9: the foreign-reference probe outlived its subtransaction';
  end if;
  select string_agg(format('%s: %s', c ->> 'call', c -> 'got'), '; ') into v_bad
    from jsonb_array_elements(v_calls) c
   where c -> 'got' is distinct from jsonb_build_object(
           'ok', false, 'code', 'OS500', 'message', format('company_os_api.%s: internal error', c ->> 'fn'),
           'detail', '', 'hint', '')
      or exists (select 1 from cos_forbidden f
                  where f.what like 'tenant B %' and strpos((c -> 'got')::text, f.value) > 0);
  if v_bad is not null or jsonb_array_length(v_calls) <> 4 then
    raise exception 'N9: a stored reference to tenant B''s run was not the fixed internal error: %', v_bad;
  end if;
end
$$;

-- N10. Ordering (brief §11): the lists newest first by (created_at desc,
--      id desc), stops by (tripped_at desc, id desc); the pending review tab
--      oldest first by (created_at asc, id asc); events by (created_at desc,
--      seq desc), seq the tie-break that keeps insertion order inside one
--      transaction. Every fixture above shares the transaction's one now(),
--      so only rows with distinct, explicit times prove an order. The insert
--      guards stamp now() themselves, so these inserts run in replica mode,
--      where those ENABLE ORIGIN guards do not fire (an owner act; no DDL, so
--      no table lock on a shared stack), inside a subtransaction that is
--      rolled back, setting and rows included. The ids disagree with the time
--      order; each tie disagrees with the reverse tie-break, and is inserted
--      in an order that disagrees with its own tie-break too. The first page
--      and a walk through the cursors, one row per page, must both give the
--      order, under the default plans AND with index scans disabled.
--      PLAN-INDEPENDENT. A list's index (brief §11) returns tied rows already
--      in its tie-break order, so under an index plan a projection that had
--      dropped its tie-break would still pass. With index, index-only and
--      bitmap scans off, and custom plans forced (so no plan PL/pgSQL cached
--      earlier carries an index scan across), the only plan left is a
--      sequential scan and a sort, and a sort without the tie-break leaves
--      tied rows in the order the scan read them. The three tied events get
--      explicit seq values (OVERRIDING SYSTEM VALUE), so that neither their
--      physical order (checked by ctid; the insert is retried in the rare case
--      a page boundary reorders it), nor its reverse, nor their id order in
--      either direction is their seq order. A mutant of read_events that
--      orders by created_at alone must then fail the walk (a one-row page
--      keeps the first tied row the scan reads, never the highest seq).
create function pg_temp.head_ids(p_call text, p_n int) returns uuid[]
language plpgsql as $f$
begin
  return array(select (e.v ->> 'id')::uuid
                 from jsonb_array_elements(pg_temp.member_body('N10', p_call) -> 'items') with ordinality as e (v, i)
                order by e.i limit p_n);
end
$f$;

-- p_call carries p_limit => 1 and a %s where the cursor argument goes.
create function pg_temp.walk_ids(p_call text, p_n int) returns uuid[]
language plpgsql as $f$
declare
  v_ids  uuid[] := '{}';
  v_page text;
  v_res  jsonb;
begin
  loop
    v_res := pg_temp.member_body('N10', format(p_call, case when v_page is null then '' else format(', p_cursor => %L', v_page) end));
    v_ids := v_ids || array(select (e ->> 'id')::uuid from jsonb_array_elements(v_res -> 'items') e);
    v_page := v_res ->> 'nextCursor';
    exit when v_page is null or cardinality(v_ids) >= p_n;
  end loop;
  return v_ids[1:p_n];
end
$f$;

do $$
declare
  ta     uuid := pg_temp.id('tenant_a');
  co     uuid := pg_temp.id('a.company');
  t_plain uuid := pg_temp.id('a.task_plain');
  v_at   timestamptz := now();
  -- Per kind: newest (lowest id), then a tie on the next time (highest id
  -- first when descending); pending reviews: oldest (highest id), then a tie
  -- (lowest id first). Each tie is inserted against its own tie-break.
  c_task constant uuid[] := array['10000000-0000-4000-8000-000000000000', '1f000000-0000-4000-8000-000000000000',
                                  '18000000-0000-4000-8000-000000000000']::uuid[];
  c_run constant uuid[] := array['20000000-0000-4000-8000-000000000000', '2f000000-0000-4000-8000-000000000000',
                                 '28000000-0000-4000-8000-000000000000']::uuid[];
  c_pending constant uuid[] := array['3f000000-0000-4000-8000-000000000000', '30000000-0000-4000-8000-000000000000',
                                     '38000000-0000-4000-8000-000000000000']::uuid[];
  c_accepted constant uuid[] := array['40000000-0000-4000-8000-000000000000', '4f000000-0000-4000-8000-000000000000',
                                      '48000000-0000-4000-8000-000000000000']::uuid[];
  -- Events, in the order they must be listed: the newest, then a three-way
  -- tie by seq, highest first (5800, 5000, 5f00). Ids: descending 5f, 58, 50
  -- and ascending 50, 58, 5f, neither the seq order.
  c_event constant uuid[] := array['5c000000-0000-4000-8000-000000000000', '58000000-0000-4000-8000-000000000000',
                                   '50000000-0000-4000-8000-000000000000', '5f000000-0000-4000-8000-000000000000']::uuid[];
  -- The order they are written in, so read in: the tie as mid, low, high seq.
  -- Its reverse is high, low, mid: neither is the seq order either.
  c_event_written constant uuid[] := array['5c000000-0000-4000-8000-000000000000', '50000000-0000-4000-8000-000000000000',
                                           '5f000000-0000-4000-8000-000000000000', '58000000-0000-4000-8000-000000000000']::uuid[];
  c_stop constant uuid[] := array['60000000-0000-4000-8000-000000000000', '6f000000-0000-4000-8000-000000000000',
                                  '68000000-0000-4000-8000-000000000000']::uuid[];
  v_seq    bigint;
  v_placed boolean := false;
  v_try    int;
  v_plans  text;
  v_checks jsonb := '[]';
  v_mutant jsonb := '[]';
  v_check  record;
  v_bad    text;
  v_rev    uuid;
  v_def    text := pg_get_functiondef('ops.read_events(uuid, text, text, uuid, integer)'::regprocedure);
  v_mut    text;
begin
  -- The mutant: read_events ordered by created_at alone, everywhere it orders.
  v_mut := replace(replace(replace(v_def,
             'order by e.created_at desc, e.seq desc', 'order by e.created_at desc'),
             'order by (page.e).created_at desc, (page.e).seq desc', 'order by (page.e).created_at desc'),
             'order by (page.e).created_at asc, (page.e).seq asc', 'order by (page.e).created_at asc');
  if v_def !~ 'seq desc' or v_mut ~ 'seq (asc|desc)' then
    raise exception 'N10: the seq tie-break was not found where read_events orders, so the mutant would prove nothing';
  end if;
  begin
    -- A SET statement, not set_config(): the platform allows this setting to
    -- the migration identity only through SET.
    set local session_replication_role = replica;
    insert into ops.tasks (id, tenant_id, company_id, type, title, created_at, updated_at)
    select x.id, ta, co, 'crm.follow_up', 'Order probe', x.at, x.at
      from unnest(array[c_task[1], c_task[3], c_task[2]],
                  array[v_at + interval '3 hours', v_at + interval '2 hours', v_at + interval '2 hours']) as x (id, at);
    insert into ops.agent_runs (id, tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                                idempotency_key, request_fingerprint, correlation_id, requested_by, created_at, updated_at)
    select x.id, r.tenant_id, r.company_id, r.department_id, r.task_id, r.agent_id, r.capability, r.model_route,
           'order-probe-' || x.id, r.request_fingerprint, gen_random_uuid(), 'cos-api-suite', x.at, x.at
      from ops.agent_runs r,
           unnest(array[c_run[1], c_run[3], c_run[2]],
                  array[v_at + interval '3 hours', v_at + interval '2 hours', v_at + interval '2 hours']) as x (id, at)
     where r.id = pg_temp.id('a.run_queued');
    insert into ops.review_items (id, tenant_id, company_id, task_id, agent_run_id, capability, proposed, created_at, updated_at)
    select x.id, ta, co, t_plain, gen_random_uuid(), 'lead_triage', '{}'::jsonb, x.at, x.at
      from unnest(array[c_pending[1], c_pending[3], c_pending[2], c_accepted[1], c_accepted[3], c_accepted[2]],
                  array[v_at - interval '3 hours', v_at - interval '2 hours', v_at - interval '2 hours',
                        v_at + interval '3 hours', v_at + interval '2 hours', v_at + interval '2 hours']) as x (id, at);
    -- Explicit seq values past every seq this transaction holds, written in
    -- c_event_written order in one statement; retried when the heap placed
    -- them otherwise (a page boundary between two rows).
    v_seq := (select max(e.seq) from ops.events e) + 1000;
    for v_try in 1 .. 5 loop
      begin
        insert into ops.events (id, seq, tenant_id, company_id, type, source, subject_type, subject_id, created_at)
        overriding system value
        values (c_event[1], v_seq + 1, ta, co, 'custom.order_probe', 'cos-api-suite', 'task', t_plain, v_at + interval '3 hours'),
               (c_event[3], v_seq + 3, ta, co, 'custom.order_probe', 'cos-api-suite', 'task', t_plain, v_at + interval '2 hours'),
               (c_event[4], v_seq + 2, ta, co, 'custom.order_probe', 'cos-api-suite', 'task', t_plain, v_at + interval '2 hours'),
               (c_event[2], v_seq + 4, ta, co, 'custom.order_probe', 'cos-api-suite', 'task', t_plain, v_at + interval '2 hours');
        if (select array_agg(e.id order by e.ctid) from ops.events e where e.id = any (c_event)) is distinct from c_event_written then
          raise exception using errcode = 'C1CAC', message = 'placed out of order';
        end if;
        v_placed := true;
      exception when sqlstate 'C1CAC' then null;
      end;
      exit when v_placed;
    end loop;
    insert into ops.execution_stops (id, scope, tenant_id, company_id, agent_id, reason, tripped_by, tripped_at)
    values (c_stop[1], 'agent', ta, co, pg_temp.id('a.agent_triage'), 'Order probe', 'cos-api-suite', v_at + interval '3 hours'),
           (c_stop[3], 'agent', ta, pg_temp.id('a.company_annex'), pg_temp.id('a.agent_annex'), 'Order probe', 'cos-api-suite',
            v_at + interval '2 hours'),
           (c_stop[2], 'agent', ta, co, pg_temp.id('a.agent_holder'), 'Order probe', 'cos-api-suite', v_at + interval '2 hours');
    -- Back to the ordinary mode: the decisions go through the owner service,
    -- guards on, and leave created_at as inserted.
    set local session_replication_role = origin;
    foreach v_rev in array c_accepted loop
      perform ops.record_review_decision(ta, v_rev, 'accepted', 'sentinel-a-reviewer', 'operator-cli');
    end loop;
    if not v_placed
       or (select array_agg(e.id order by e.seq desc) from ops.events e where e.id = any (c_event[2:4])) is distinct from c_event[2:4]
       or (select count(distinct created_at) from ops.tasks where id = any (c_task)) <> 2
       or (select count(*) from ops.review_items where id = any (c_accepted) and status = 'accepted') <> 3 then
      raise exception 'N10: the probe rows did not keep their explicit times, seq order, written order or decisions';
    end if;

    foreach v_plans in array array['default plans', 'no index scans'] loop
      if v_plans = 'no index scans' then
        set local enable_indexscan = off;
        set local enable_indexonlyscan = off;
        set local enable_bitmapscan = off;
        set local plan_cache_mode = force_custom_plan;
      end if;
      for v_check in select * from (values
          ('tasks', 'company_os_api.list_tasks()', 'company_os_api.list_tasks(p_limit => 1%s)', c_task),
          ('runs', 'company_os_api.list_runs()', 'company_os_api.list_runs(p_limit => 1%s)', c_run),
          ('pending reviews', 'company_os_api.list_reviews()', 'company_os_api.list_reviews(p_limit => 1%s)', c_pending),
          ('accepted reviews', 'company_os_api.list_reviews(p_status => ''accepted'')',
           'company_os_api.list_reviews(p_status => ''accepted'', p_limit => 1%s)', c_accepted),
          ('events', 'company_os_api.list_events()', 'company_os_api.list_events(p_limit => 1%s)', c_event),
          ('the task''s events',
           format('company_os_api.list_events(p_subject_type => ''task'', p_subject_id => %L)', t_plain),
           format('company_os_api.list_events(p_subject_type => ''task'', p_subject_id => %L, p_limit => 1%%s)', t_plain),
           c_event),
          ('stops', 'company_os_api.list_stops()', 'company_os_api.list_stops(p_limit => 1%s)', c_stop)
        ) as c (label, first_page, paged, expected) loop
        v_checks := v_checks || jsonb_build_array(jsonb_build_object(
          'label', v_check.label || ', ' || v_plans, 'expected', to_jsonb(v_check.expected),
          'first_page', to_jsonb(pg_temp.head_ids(v_check.first_page, cardinality(v_check.expected))),
          'walked', to_jsonb(pg_temp.walk_ids(v_check.paged, cardinality(v_check.expected)))));
      end loop;
    end loop;

    -- The mutant, under the plans left above (no index scans).
    begin
      execute v_mut;
      for v_check in select * from (values
          ('events', 'company_os_api.list_events()', 'company_os_api.list_events(p_limit => 1%s)', c_event),
          ('the task''s events',
           format('company_os_api.list_events(p_subject_type => ''task'', p_subject_id => %L)', t_plain),
           format('company_os_api.list_events(p_subject_type => ''task'', p_subject_id => %L, p_limit => 1%%s)', t_plain),
           c_event)
        ) as c (label, first_page, paged, expected) loop
        v_mutant := v_mutant || jsonb_build_array(jsonb_build_object(
          'label', v_check.label, 'expected', to_jsonb(v_check.expected),
          'first_page', to_jsonb(pg_temp.head_ids(v_check.first_page, cardinality(v_check.expected))),
          'walked', to_jsonb(pg_temp.walk_ids(v_check.paged, cardinality(v_check.expected)))));
      end loop;
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    exception when sqlstate 'C1CAC' then null;
    end;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;

  select string_agg(format('%s: expected %s, first page %s, walked %s', c ->> 'label', c -> 'expected',
                           c -> 'first_page', c -> 'walked'), '; ') into v_bad
    from jsonb_array_elements(v_checks) c
   where c -> 'first_page' is distinct from c -> 'expected' or c -> 'walked' is distinct from c -> 'expected';
  if v_bad is not null or jsonb_array_length(v_checks) <> 14 then
    raise exception 'N10: a list is not in its pinned order: %', coalesce(v_bad, 'a check did not run');
  end if;
  -- The check is plan-independent: without its seq tie-break, read_events
  -- walks the tie in the order the scan read it, on both event lists.
  select string_agg(format('%s walked %s', c ->> 'label', c -> 'walked'), '; ') into v_bad
    from jsonb_array_elements(v_mutant) c
   where c -> 'walked' = c -> 'expected';
  if v_bad is not null or jsonb_array_length(v_mutant) <> 2 then
    raise exception 'N10: read_events ordered by created_at alone still gave the seq order: %',
      coalesce(v_bad, 'the mutant did not run');
  end if;
  if exists (select 1 from ops.tasks where id = any (c_task))
     or exists (select 1 from ops.events where id = any (c_event))
     or current_setting('session_replication_role') <> 'origin'
     or current_setting('enable_indexscan') <> 'on' or current_setting('plan_cache_mode') <> 'auto'
     or pg_get_functiondef('ops.read_events(uuid, text, text, uuid, integer)'::regprocedure) <> v_def then
    raise exception 'N10: a probe row, a planner setting, replica mode or the mutant outlived its subtransaction';
  end if;
end
$$;

-- ===========================================================================
-- L. THE LIST CAP (brief §8 row 3). list_agents answers the first 500 agents
--    by (name, id); get_agent computes one agent's state wherever that agent
--    sorts. With tenant A at 501 agents (in a subtransaction that is rolled
--    back), the 501st by name is missing from list_agents and answered in
--    full by get_agent, and an agent inside the cap reads the same in both.
--    The overview is not capped: with the 501st agent then given a queued
--    run and an agent stop (held and stopped), its agents.total is 501 and
--    every per-state count equals the count over list_agents' 500 plus
--    get_agent's 501st, so the agent past the cap is counted too.
-- ===========================================================================
do $$
declare
  ta        uuid := pg_temp.id('tenant_a');
  v_list    jsonb;
  v_last    jsonb;
  v_inside  jsonb;
  v_last_id uuid;
  v_name    text;
  v_bad     text;
  v_over    jsonb;
  v_expect  jsonb;
begin
  begin
    perform ops.create_agent(ta, pg_temp.id('a.company'), pg_temp.id('a.department'), 'scale-' || n,
                             'Zz Scale ' || lpad(n::text, 4, '0'), 'Intake assistant', 'cos-api-suite')
       from generate_series(1, 501 - (select count(*)::int from ops.agents where tenant_id = ta)) n;
    select a.id, a.name into v_last_id, v_name from ops.agents a where a.tenant_id = ta order by a.name desc, a.id desc limit 1;
    v_list := pg_temp.member_body('L', 'company_os_api.list_agents()');
    v_last := pg_temp.member_body('L', format('company_os_api.get_agent(%L)', v_last_id));
    v_inside := pg_temp.member_body('L', format('company_os_api.get_agent(%L)', pg_temp.id('a.agent_follow')));
    select string_agg(x, '; ') into v_bad from (
      select format('tenant A holds %s agents, not 501', count(*)) x from ops.agents where tenant_id = ta having count(*) <> 501
      union all
      select format('list_agents answered %s agents, not the first 500 by name', jsonb_array_length(v_list -> 'items'))
       where (select array_agg((e.v ->> 'id')::uuid order by e.i)
                from jsonb_array_elements(v_list -> 'items') with ordinality as e (v, i))
             is distinct from (select array_agg(y.id order by y.name, y.id)
                                 from (select a.id, a.name from ops.agents a where a.tenant_id = ta
                                        order by a.name, a.id limit 500) y)
      union all
      select 'list_agents carries the 501st agent'
       where exists (select 1 from jsonb_array_elements(v_list -> 'items') e where (e ->> 'id')::uuid = v_last_id)
      union all
      select format('get_agent answered the 501st agent (%s) as %s', v_name, v_last -> 'agent')
       where (v_last -> 'agent' ->> 'id')::uuid is distinct from v_last_id
          or v_last -> 'agent' ->> 'name' is distinct from v_name
          or v_last -> 'agent' ->> 'availability' is distinct from 'available'
          or v_last -> 'agent' ->> 'activity' is distinct from 'idle'
          or v_last -> 'recentRuns' is distinct from '[]'::jsonb
      union all
      select format('an agent inside the cap reads %s in get_agent and %s in list_agents', v_inside -> 'agent', f.e)
        from (select (select e from jsonb_array_elements(v_list -> 'items') e
                       where (e ->> 'id')::uuid = pg_temp.id('a.agent_follow')) as e) f
       where f.e is null or f.e is distinct from v_inside -> 'agent') z;

    -- The overview counts every agent: the 501st, past the cap, is made held
    -- (a queued run under an agent stop) and stopped, then counted.
    perform pg_temp.admit('a', 501, ta, pg_temp.id('a.company'), v_last_id);
    insert into ops.execution_stops (scope, tenant_id, company_id, agent_id, reason, tripped_by)
    values ('agent', ta, pg_temp.id('a.company'), v_last_id, 'Synthetic scale pause', 'cos-api-suite');
    v_list := pg_temp.member_body('L', 'company_os_api.list_agents()');
    v_last := pg_temp.member_body('L', format('company_os_api.get_agent(%L)', v_last_id));
    v_over := pg_temp.member_body('L', 'company_os_api.overview()');
    with items as (
      select e from jsonb_array_elements(v_list -> 'items') e
      union all select v_last -> 'agent')
    select jsonb_build_object(
             'total', count(*),
             'working', count(*) filter (where e ->> 'activity' = 'working'),
             'held', count(*) filter (where e ->> 'activity' = 'held'),
             'queued', count(*) filter (where e ->> 'activity' = 'queued'),
             'stale', count(*) filter (where e ->> 'activity' = 'stale'),
             'stopped', count(*) filter (where e ->> 'availability' = 'stopped'),
             'inactive', count(*) filter (where e ->> 'availability' = 'inactive'))
      into v_expect from items;
    select string_agg(x, '; ') into v_bad from (
      select v_bad x where v_bad is not null
      union all
      select format('the 501st agent was not made held and stopped past the cap: %s', v_last -> 'agent')
       where v_last -> 'agent' ->> 'activity' is distinct from 'held'
          or v_last -> 'agent' ->> 'availability' is distinct from 'stopped'
          or exists (select 1 from jsonb_array_elements(v_list -> 'items') e where (e ->> 'id')::uuid = v_last_id)
      union all
      select format('the overview counts %s, not every agent: %s', v_over -> 'agents', v_expect)
       where (v_over -> 'agents') is distinct from v_expect or (v_expect ->> 'total')::int <> 501) z;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_bad is not null then
    raise exception 'L: %', v_bad;
  end if;
  if v_last_id is null or v_name not like 'Zz Scale %'
     or exists (select 1 from ops.agents where tenant_id = ta and name like 'Zz Scale %') then
    raise exception 'L: the 501st agent was not a scale fixture, or a scale fixture outlived its subtransaction';
  end if;
end
$$;

-- ===========================================================================
-- I. IDENTITY. The resolver refuses first, for every function and every
--    well-typed argument, with one fixed message per SQLSTATE.
-- ===========================================================================

-- Per function: a valid call, and calls that would be OS400 or OS404 for a
-- member (a foreign id, a bad cursor, limit, status or subject).
create temporary table cos_variants (fn text not null, call text not null, member_code text not null) on commit drop;

do $$
declare
  v_random text := gen_random_uuid()::text;
  v_bad    text;
begin
  insert into cos_variants values
    ('operator_context', 'company_os_api.operator_context()', 'ok'),
    ('overview', 'company_os_api.overview()', 'ok'),
    ('list_agents', 'company_os_api.list_agents()', 'ok'),
    ('spend_summary', 'company_os_api.spend_summary()', 'ok'),
    ('communication_status', 'company_os_api.communication_status()', 'ok'),
    ('get_agent', format('company_os_api.get_agent(%L)', pg_temp.id('a.agent_triage')), 'ok'),
    ('get_agent', format('company_os_api.get_agent(%L)', pg_temp.id('b.agent_triage')), 'OS404'),
    ('get_agent', format('company_os_api.get_agent(%L)', v_random), 'OS404'),
    ('list_tasks', 'company_os_api.list_tasks()', 'ok'),
    ('list_tasks', 'company_os_api.list_tasks(p_cursor => ''bogus'')', 'OS400'),
    ('list_tasks', 'company_os_api.list_tasks(p_limit => 0)', 'OS400'),
    ('list_tasks', 'company_os_api.list_tasks(p_status => ''bogus'')', 'OS400'),
    ('list_tasks', format('company_os_api.list_tasks(p_agent_id => %L)', pg_temp.id('b.agent_triage')), 'OS404'),
    ('get_task', format('company_os_api.get_task(%L)', pg_temp.id('a.task_ok')), 'ok'),
    ('get_task', format('company_os_api.get_task(%L)', pg_temp.id('b.task_ok')), 'OS404'),
    ('list_runs', 'company_os_api.list_runs(p_attention_only => true)', 'ok'),
    ('list_runs', format('company_os_api.list_runs(p_cursor => %L)', 'rn1:' || pg_temp.id('b.run_ok')), 'OS400'),
    ('list_runs', 'company_os_api.list_runs(p_limit => 101)', 'OS400'),
    ('list_runs', 'company_os_api.list_runs(p_status => ''bogus'')', 'OS400'),
    ('list_runs', format('company_os_api.list_runs(p_agent_id => %L)', pg_temp.id('b.agent_triage')), 'OS404'),
    ('get_run', format('company_os_api.get_run(%L)', pg_temp.id('a.run_live')), 'ok'),
    ('get_run', format('company_os_api.get_run(%L)', pg_temp.id('b.run_live')), 'OS404'),
    ('list_reviews', 'company_os_api.list_reviews()', 'ok'),
    ('list_reviews', 'company_os_api.list_reviews(p_status => ''bogus'')', 'OS400'),
    ('list_reviews', format('company_os_api.list_reviews(p_cursor => %L)', 'rv1:' || pg_temp.id('b.review_ok')), 'OS400'),
    ('list_reviews', 'company_os_api.list_reviews(p_limit => 0)', 'OS400'),
    ('get_review', format('company_os_api.get_review(%L)', pg_temp.id('a.review_accepted')), 'ok'),
    ('get_review', format('company_os_api.get_review(%L)', pg_temp.id('b.review_accepted')), 'OS404'),
    ('get_review_advice', format('company_os_api.get_review_advice(%L)', pg_temp.id('a.review_ok')), 'ok'),
    ('get_review_advice', format('company_os_api.get_review_advice(%L)', pg_temp.id('b.review_ok')), 'OS404'),
    ('list_events', 'company_os_api.list_events()', 'ok'),
    ('list_events', format('company_os_api.list_events(p_subject_type => ''bogus'', p_subject_id => %L)', v_random), 'OS400'),
    ('list_events', format('company_os_api.list_events(p_subject_id => %L)', pg_temp.id('a.task_ok')), 'OS400'),
    ('list_events', format('company_os_api.list_events(p_cursor => %L)', 'ev1:' || v_random), 'OS400'),
    ('list_events', format('company_os_api.list_events(p_subject_type => ''task'', p_subject_id => %L)', pg_temp.id('b.task_ok')), 'OS404'),
    ('list_stops', 'company_os_api.list_stops()', 'ok'),
    ('list_stops', format('company_os_api.list_stops(p_include_cleared => true, p_cursor => %L)', 'st1:' || pg_temp.id('b.stop_agent')), 'OS400'),
    ('list_stops', 'company_os_api.list_stops(p_limit => 0)', 'OS400'),
    ('decide_review', format('company_os_api.decide_review(%L, %L)', pg_temp.id('b.review_ok'), 'rejected'), 'OS404'),
    ('decide_review', format('company_os_api.decide_review(%L, %L)', v_random, 'rejected'), 'OS404'),
    ('decide_review', format('company_os_api.decide_review(%L, %L)', pg_temp.id('a.review_ok'), 'bogus'), 'OS400'),
    ('trip_stop', format('company_os_api.trip_stop(%L, %L)', 'company', pg_temp.id('b.company')), 'OS404'),
    ('trip_stop', format('company_os_api.trip_stop(%L)', 'global'), 'OS403'),
    ('trip_stop', format('company_os_api.trip_stop(%L)', 'bogus'), 'OS400');

  -- Every exposed function has variants, and for the member each variant
  -- answers as intended: the bad ones are really bad.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api' and not exists (select 1 from cos_variants v where v.fn = p.proname);
  if v_bad is not null then
    raise exception 'I1: exposed function(s) with no identity variant: %', v_bad;
  end if;
  select string_agg(format('%s gave %s', v.call, r), '; ') into v_bad
    from cos_variants v, pg_temp.api(pg_temp.claims('m_a'), v.call) r
   where case when v.member_code = 'ok' then not (r ->> 'ok')::boolean
              else r ->> 'code' is distinct from v.member_code end;
  if v_bad is not null then
    raise exception 'I1: a variant did not answer the member as intended: %', v_bad;
  end if;
end
$$;

-- The one fixed refusal of an operation for a SQLSTATE: no detail, no hint.
create function pg_temp.refusal(p_fn text, p_code text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message',
           format('company_os_api.%s: %s', p_fn,
                  case p_code when 'OS401' then 'not signed in' when 'OS403' then 'no access' when 'OS409' then 'conflict' end),
           'detail', '', 'hint', '');
$$;

-- I1. The identity matrix (brief §16): each shape refused with its code, the
--     same bytes whatever the shape and whatever the arguments.
do $$
declare
  v_case  record;
  v_bad   text[] := array[]::text[];
  v_count int := 0;
  v       jsonb;
  vv      record;
begin
  for v_case in select * from (values
      ('no claims', '', null::uuid, 'OS401'),
      ('claims that are not JSON', 'not json', null, 'OS401'),
      ('claims that are a JSON array', '["authenticated"]', null, 'OS401'),
      ('claims that are JSON null', 'null', null, 'OS401'),
      ('role anon in the claims', pg_temp.claims('m_a', '{"role": "anon"}'), null, 'OS401'),
      ('role service_role in the claims', pg_temp.claims('m_a', '{"role": "service_role"}'), null, 'OS401'),
      ('no role claim', pg_temp.claims('m_a', '{}', '{role}'), null, 'OS401'),
      ('aud anon', pg_temp.claims('m_a', '{"aud": "anon"}'), null, 'OS401'),
      ('aud an array', pg_temp.claims('m_a', '{"aud": ["authenticated"]}'), null, 'OS401'),
      ('no aud claim', pg_temp.claims('m_a', '{}', '{aud}'), null, 'OS401'),
      ('is_anonymous true', pg_temp.claims('m_a', '{"is_anonymous": true}'), null, 'OS401'),
      ('is_anonymous "true"', pg_temp.claims('m_a', '{"is_anonymous": "true"}'), null, 'OS401'),
      ('sub not a uuid', pg_temp.claims('m_a', '{"sub": "not-a-uuid"}'), null, 'OS401'),
      ('no sub claim', pg_temp.claims('m_a', '{}', '{sub}'), null, 'OS401'),
      ('no session_id claim', pg_temp.claims('m_a', '{}', '{session_id}'), null, 'OS401'),
      ('an unknown session', pg_temp.claims('m_a', jsonb_build_object('session_id', gen_random_uuid())), null, 'OS401'),
      ('another user''s session', pg_temp.claims('m_a', jsonb_build_object('session_id', pg_temp.id('session.nonmember'))),
       null, 'OS401'),
      ('an expired session', pg_temp.claims('m_a', jsonb_build_object('session_id', pg_temp.id('session.expired'))), null, 'OS401'),
      ('a sub with no auth user', pg_temp.claims('m_a', jsonb_build_object('sub', gen_random_uuid(),
                                                                          'session_id', gen_random_uuid())), null, 'OS401'),
      ('a banned auth user', pg_temp.claims('banned'), null, 'OS401'),
      ('a deleted auth user', pg_temp.claims('deleted'), null, 'OS401'),
      ('an anonymous auth user', pg_temp.claims('anonymous'), null, 'OS401'),
      ('the legacy per-claim sub only (the sealed owner-session pool)', '', pg_temp.id('user.m_a'), 'OS401'),
      ('no principal', pg_temp.claims('nonmember'), null, 'OS403'),
      ('a disabled principal', pg_temp.claims('disabled'), null, 'OS403'),
      ('a revoked membership', pg_temp.claims('revoked'), null, 'OS403'),
      ('unbanned by a CRM administrator after an owner revoke', pg_temp.claims('unbanned'), null, 'OS403'),
      ('a member of a tenant the eligibility policy refuses', pg_temp.claims('m_b'), null, 'OS403')
    ) as c (label, claims, legacy_sub, code) loop
    for vv in select * from cos_variants loop
      v := pg_temp.api(v_case.claims, vv.call, 'authenticated', v_case.legacy_sub::text);
      v_count := v_count + 1;
      if v is distinct from pg_temp.refusal(vv.fn, v_case.code) then
        v_bad := v_bad || format('%s, %s: %s', v_case.label, vv.call, v);
      end if;
    end loop;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'I1: an identity shape was not refused by the resolver, first, with its fixed refusal: %',
      array_to_string(v_bad[1:10], ' | ');
  end if;
  -- The positive controls: the member, and a user whose ban has expired.
  for vv in select * from cos_variants where member_code = 'ok' loop
    if not (pg_temp.api(pg_temp.claims('banned_past'), vv.call) ->> 'ok')::boolean then
      raise exception 'I1: a user whose ban has expired was refused %', vv.call;
    end if;
  end loop;
  if v_count <> 28 * (select count(*) from cos_variants) then
    raise exception 'I1: % identity calls ran, not one per shape and variant', v_count;
  end if;
end
$$;

-- I2. Two active memberships are a conflict (OS409), before any argument.
--     The one-active index is dropped inside a subtransaction, so the second
--     membership can exist at all; both are rolled back with it.
do $$
declare
  v_bad text[] := array[]::text[];
  vv    record;
  v     jsonb;
begin
  begin
    drop index ops.tenant_memberships_one_active;
    insert into ops.tenant_memberships (principal_id, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
    values (pg_temp.id('principal.two'), pg_temp.id('tenant_c'), repeat('c', 64), 'sentinel-owner-cli', 'second membership');
    for vv in select * from cos_variants loop
      v := pg_temp.api(pg_temp.claims('two'), vv.call);
      if v is distinct from pg_temp.refusal(vv.fn, 'OS409') then
        v_bad := v_bad || format('%s: %s', vv.call, v);
      end if;
    end loop;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if cardinality(v_bad) > 0 then
    raise exception 'I2: two active memberships were not refused as a conflict first: %', array_to_string(v_bad[1:10], ' | ');
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'ops' and indexname = 'tenant_memberships_one_active') then
    raise exception 'I2: the one-active-membership index did not come back';
  end if;
end
$$;

-- I3. The eligibility policy is read at every call: with the local CRM moved
--     to tenant B, tenant A's member is refused like a non-member, and B's
--     member (an owner fixture) is let in to its own tenant only.
do $$
declare
  v_bad text[] := array[]::text[];
  vv    record;
  v     jsonb;
begin
  begin
    update ops.tenants set owns_local_crm = false where id = pg_temp.id('tenant_a');
    update ops.tenants set owns_local_crm = true where id = pg_temp.id('tenant_b');
    for vv in select * from cos_variants loop
      v := pg_temp.api(pg_temp.claims('m_a'), vv.call);
      if v is distinct from pg_temp.refusal(vv.fn, 'OS403') then
        v_bad := v_bad || format('%s: %s', vv.call, v);
      end if;
    end loop;
    v := pg_temp.member_body('I3', 'company_os_api.operator_context()', 'm_b');
    if (v -> 'tenant' ->> 'id')::uuid is distinct from pg_temp.id('tenant_b') then
      v_bad := v_bad || format('tenant B''s member resolved to %s', v -> 'tenant');
    end if;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if cardinality(v_bad) > 0 then
    raise exception 'I3: the eligibility policy was not applied at resolve time: %', array_to_string(v_bad[1:10], ' | ');
  end if;
end
$$;

-- I4. Only authenticated reaches the exposed schema: every other application
--     role is refused at the door, whatever the claims.
do $$ begin execute format('grant ops_gateway to %I', current_user); end $$;

do $$
declare
  v_role text;
  vv     record;
  v      jsonb;
  v_bad  text[] := array[]::text[];
begin
  foreach v_role in array array['anon', 'service_role', 'ops_worker', 'ops_gateway'] loop
    for vv in select * from cos_variants where member_code = 'ok' loop
      v := pg_temp.api(pg_temp.claims('m_a'), vv.call, v_role);
      if v ->> 'code' is distinct from '42501' or v ->> 'message' <> 'permission denied for schema company_os_api' then
        v_bad := v_bad || format('%s, %s: %s', v_role, vv.call, v);
      end if;
    end loop;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'I4: a role other than authenticated reached company_os_api: %', array_to_string(v_bad[1:10], ' | ');
  end if;
end
$$;

-- I5. A malformed uuid is refused before any body runs, with a data-free
--     22P02 that echoes only the caller's own input, whoever calls.
do $$
declare
  v_who text;
  v     jsonb;
begin
  foreach v_who in array array['m_a', 'nonmember'] loop
    v := pg_temp.api(pg_temp.claims(v_who), 'company_os_api.get_task(''not-a-uuid'')');
    if v ->> 'code' is distinct from '22P02' or v ->> 'message' <> 'invalid input syntax for type uuid: "not-a-uuid"' then
      raise exception 'I5: a malformed uuid answered %', v;
    end if;
  end loop;
  v := pg_temp.api('', 'company_os_api.get_task(''not-a-uuid'')');
  if v ->> 'code' is distinct from '22P02' then
    raise exception 'I5: a malformed uuid without claims answered %', v;
  end if;
end
$$;

-- ===========================================================================
-- M. THE PRINCIPAL AND THE MEMBERSHIP MODEL (brief §7.4).
-- ===========================================================================

-- M1. The principal is the auth user id: an email changed after the grant
--     keeps the same principal and tenant; a new auth user carrying the
--     former email holds nothing (same email is not the same principal).
do $$
declare
  v     jsonb;
  v_old text;
begin
  select email into v_old from auth.users where id = pg_temp.id('user.renamed');
  update auth.users set email = 'Sentinel.Cos.renamed-changed.Q7@Example.Test' where id = pg_temp.id('user.renamed');
  v := pg_temp.member_body('M1', 'company_os_api.operator_context()', 'renamed');
  if (v -> 'principal' ->> 'id')::uuid is distinct from pg_temp.id('principal.renamed')
     or (v -> 'tenant' ->> 'id')::uuid is distinct from pg_temp.id('tenant_a') then
    raise exception 'M1: an email change moved the principal or the tenant: %', v;
  end if;
  update auth.users set email = v_old where id = pg_temp.id('user.reused');
  if pg_temp.api(pg_temp.claims('reused'), 'company_os_api.operator_context()')
     is distinct from pg_temp.api(pg_temp.claims('nonmember'), 'company_os_api.operator_context()')
     or pg_temp.api(pg_temp.claims('reused'), 'company_os_api.operator_context()')
        is distinct from pg_temp.refusal('operator_context', 'OS403') then
    raise exception 'M1: a new auth user holding a former member''s email was let in, or refused unlike a non-member';
  end if;
  if exists (select 1 from ops.principals where subject = pg_temp.id('user.reused')) then
    raise exception 'M1: an email created a principal';
  end if;
end
$$;

-- M2. Tenant-generic model, temporary policy: the tables accept a membership
--     for a tenant that does not own the CRM (tenant B's, an owner fixture),
--     and nothing in them refers to CRM ownership; the eligibility predicate
--     refuses that tenant at grant (and at resolve, I1 and I3); the one
--     predicate is the only Phase 2C reader of owns_local_crm; no identity
--     path reads schema public.
do $$
declare
  v_bad text;
begin
  if not exists (select 1 from ops.tenant_memberships m join ops.tenants t on t.id = m.tenant_id
                  where not t.owns_local_crm and m.revoked_at is null) then
    raise exception 'M2: no membership of a non-CRM tenant exists, so the tenant-generic model is untested';
  end if;
  if exists (select 1 from pg_constraint c where c.conrelid in ('ops.tenant_memberships'::regclass, 'ops.principals'::regclass)
              and pg_get_constraintdef(c.oid) ~* 'owns_local_crm')
     or exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                 where t.tgrelid in ('ops.tenant_memberships'::regclass, 'ops.principals'::regclass)
                   and p.prosrc ~* 'owns_local_crm') then
    raise exception 'M2: the membership tables tie a membership to CRM ownership';
  end if;
  perform pg_temp.expect_refused('M2 a grant for tenant B', 'OS403', 'only the tenant that owns the local CRM is eligible',
    format('select ops.grant_membership(%L, %L, ''Synthetic'', ''sentinel-owner-cli'', ''probe'')',
           pg_temp.id('tenant_b'), pg_temp.id('user.nonmember')));
  perform pg_temp.expect_refused('M2 a grant for tenant C', 'OS403', 'only the tenant that owns the local CRM is eligible',
    format('select ops.grant_membership(%L, %L, ''Synthetic'', ''sentinel-owner-cli'', ''probe'')',
           pg_temp.id('tenant_c'), pg_temp.id('user.nonmember')));
  -- The predicate is called by exactly the grant and the resolver.
  select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('ops', 'company_os_api') and p.prosrc ~ 'ops\.membership_tenant_eligible\(';
  if v_bad is distinct from 'ops.grant_membership(uuid,uuid,text,text,text), ops.operator_scope()' then
    raise exception 'M2: ops.membership_tenant_eligible is called by % instead of exactly the grant and the resolver', v_bad;
  end if;
  -- owns_local_crm: the predicate, the two readers that predate Phase 2C, and
  -- Phase 3B.1's commercial funnel CRM adapter, which serves only the tenant
  -- that owns the local CRM (as crm_contact_by_phone does).
  select string_agg(p.proname, ', ' order by p.proname) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('ops', 'company_os_api') and p.prosrc ~ 'owns_local_crm';
  if v_bad is distinct from 'crm_commercial_funnel, crm_contact_by_phone, membership_tenant_eligible, purge_inbound_email_ledger' then
    raise exception 'M2: owns_local_crm is read by % (expected the predicate, the two pre-Phase-2C readers and the funnel''s CRM adapter)', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'company_os_api')
          or (n.nspname = 'ops' and (p.proname ~ '^(gate_|read_|cos_)'
              or p.proname in ('operator_scope', 'agent_operational_state', 'membership_tenant_eligible',
                               'grant_membership', 'revoke_membership'))))
     and p.prosrc ~* '\mpublic\.';
  if v_bad is not null then
    raise exception 'M2: an identity, eligibility or graph body reads schema public: %', v_bad;
  end if;
end
$$;

-- M3. The resolver never reads an email, and neither does any other graph
--     body (brief §7.4: an email never selects, identifies or authorises).
do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where ((n.nspname = 'company_os_api')
          or (n.nspname = 'ops' and (p.proname ~ '^(gate_|read_|cos_)'
              or p.proname in ('operator_scope', 'agent_operational_state', 'membership_tenant_eligible'))))
     and p.prosrc ~* 'email';
  if v_bad is not null then
    raise exception 'M3: a graph body reads an email: %', v_bad;
  end if;
end
$$;

-- M4. A membership is for a human principal only, by the table itself.
do $$
declare
  v_agent uuid;
begin
  insert into ops.principals (kind, issuer, subject, display_name, created_by)
  values ('agent', 'supabase_auth', gen_random_uuid(), 'Synthetic agent principal', 'sentinel-owner-cli')
  returning id into v_agent;
  perform pg_temp.expect_refused('M4 a membership whose principal kind is agent', '23514', 'tenant_memberships_human_only',
    format($q$insert into ops.tenant_memberships (principal_id, principal_kind, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
              values (%L, 'agent', %L, repeat('d', 64), 'sentinel-owner-cli', 'probe')$q$, v_agent, pg_temp.id('tenant_a')));
  perform pg_temp.expect_refused('M4 a human membership pointing at an agent principal', '23503', 'tenant_memberships_principal_fkey',
    format($q$insert into ops.tenant_memberships (principal_id, principal_kind, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
              values (%L, 'human', %L, repeat('d', 64), 'sentinel-owner-cli', 'probe')$q$, v_agent, pg_temp.id('tenant_a')));
end
$$;

-- M5. The binding is immutable, the owner credential included: each change
--     is refused by name (brief §7.4, §16).
do $$
declare
  v_col   text;
  v_value text;
  p_m_a   uuid := pg_temp.id('principal.m_a');
  m_m_a   uuid := pg_temp.id('membership.m_a');
begin
  foreach v_col in array array['id', 'kind', 'issuer', 'subject', 'created_by', 'created_at'] loop
    v_value := case v_col when 'id' then 'gen_random_uuid()' when 'kind' then '''agent'''
                          when 'issuer' then '''other_issuer''' when 'subject' then 'gen_random_uuid()'
                          when 'created_by' then '''someone-else''' else 'created_at - interval ''1 day''' end;
    perform pg_temp.expect_refused('M5 an update of principals.' || v_col, 'OS403', 'a principal''s identity is immutable',
      format('update ops.principals set %I = %s where id = %L', v_col, v_value, p_m_a));
  end loop;
  perform pg_temp.expect_refused('M5 a second disable', 'OS409', 'a disable is recorded once',
    format('update ops.principals set disabled_at = now() + interval ''1 second'', disabled_by = ''someone-else'' where id = %L',
           pg_temp.id('principal.disabled')));
  perform pg_temp.expect_refused('M5 an undone disable', 'OS409', 'a disable is recorded once',
    format('update ops.principals set disabled_at = null, disabled_by = null where id = %L', pg_temp.id('principal.disabled')));
  foreach v_col in array array['id', 'principal_id', 'principal_kind', 'tenant_id', 'role', 'email_at_grant_sha256',
                               'granted_by', 'grant_reason', 'granted_at'] loop
    v_value := case v_col when 'id' then 'gen_random_uuid()' when 'principal_id' then format('%L', pg_temp.id('principal.revoked'))
                          when 'principal_kind' then '''agent''' when 'tenant_id' then format('%L', pg_temp.id('tenant_b'))
                          when 'role' then '''operator''' when 'email_at_grant_sha256' then 'repeat(''e'', 64)'
                          when 'granted_by' then '''someone-else''' when 'grant_reason' then '''another reason'''
                          else 'granted_at - interval ''1 day''' end;
    perform pg_temp.expect_refused('M5 an update of tenant_memberships.' || v_col, 'OS403', 'a grant is immutable',
      format('update ops.tenant_memberships set %I = %s where id = %L', v_col, v_value, m_m_a));
  end loop;
  perform pg_temp.expect_refused('M5 a second revoke', 'OS409', 'a revocation is recorded once',
    format('update ops.tenant_memberships set revoked_at = now() + interval ''1 second'', revoked_by = ''someone-else'', revoke_reason = ''again'' where id = %L',
           pg_temp.id('membership.revoked')));
  perform pg_temp.expect_refused('M5 a changed revoke reason', 'OS409', 'a revocation is recorded once',
    format('update ops.tenant_memberships set revoke_reason = ''rewritten'' where id = %L', pg_temp.id('membership.revoked')));
  perform pg_temp.expect_refused('M5 an undone revoke', 'OS409', 'a revocation is recorded once',
    format('update ops.tenant_memberships set revoked_at = null, revoked_by = null, revoke_reason = null where id = %L',
           pg_temp.id('membership.revoked')));
  perform pg_temp.expect_refused('M5 a deleted principal', 'OS403', 'a principal is never deleted',
    format('delete from ops.principals where id = %L', pg_temp.id('principal.revoked')));
  perform pg_temp.expect_refused('M5 a deleted membership', 'OS403', 'a membership is never deleted',
    format('delete from ops.tenant_memberships where id = %L', m_m_a));
  -- Each by its own table's guard: the principals table cannot be truncated
  -- alone (the membership foreign key refuses it first), so its guard is
  -- proven by the table-qualified message of the pair.
  perform pg_temp.expect_refused('M5 a truncated membership table', 'OS403', '^ops\.tenant_memberships: rows are never removed$',
    'truncate ops.tenant_memberships');
  perform pg_temp.expect_refused('M5 a truncated principal table', 'OS403', '^ops\.principals: rows are never removed$',
    'truncate ops.principals, ops.tenant_memberships');
  -- The guards are ENABLE ALWAYS: replica mode does not silence them.
  if (select count(*) from pg_trigger t
       where t.tgrelid in ('ops.principals'::regclass, 'ops.tenant_memberships'::regclass) and t.tgenabled = 'A'
         and t.tgname in ('principals_guard_change', 'principals_refuse_truncate',
                          'tenant_memberships_guard_change', 'tenant_memberships_refuse_truncate')) <> 4 then
    raise exception 'M5: a principal or membership guard trigger is missing or not ENABLE ALWAYS';
  end if;
  -- Behind the grant guard, the table still keeps a membership human.
  perform pg_temp.expect_refused('M5 a membership made non-human with its guard off', '23514', 'tenant_memberships_human_only',
    format('alter table ops.tenant_memberships disable trigger tenant_memberships_guard_change; update ops.tenant_memberships set principal_kind = ''agent'' where id = %L',
           m_m_a));
end
$$;

-- ===========================================================================
-- P. THE CAPABILITY GRAPH, PINNED (brief §7.3, §7.6 E, §15 "SQL pins";
--    owner decisions S0-E, S0-F, S0-G). Each pin is a function, so section X
--    can break the graph and watch the pin fail by name.
-- ===========================================================================

-- The exposed catalogue: each operation, its full argument list as the
-- catalogue prints it, and the one callee its gate may reach, with the
-- arguments the gate passes.
create temporary table cos_catalogue (op text primary key, args text not null, callee text not null, callee_args text not null,
                                       act boolean not null default false,
                                       gate_config text[] not null default '{"search_path=\"\""}',
                                       extra_handler text not null default '')
  on commit drop;
insert into cos_catalogue values
  ('operator_context', '', 'read_operator_context', 'v.tenant_id, v.principal_id, v.role'),
  ('overview', '', 'read_overview', 'v.tenant_id'),
  ('list_agents', '', 'agent_operational_state', 'v.tenant_id'),
  ('get_agent', 'p_agent_id uuid', 'read_agent_detail', 'v.tenant_id, p_agent_id'),
  ('list_tasks', 'p_cursor text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_agent_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50',
   'read_tasks', 'v.tenant_id, p_cursor, p_status, p_agent_id, p_limit'),
  ('get_task', 'p_task_id uuid', 'read_task_detail', 'v.tenant_id, p_task_id'),
  ('list_runs', 'p_cursor text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_agent_id uuid DEFAULT NULL::uuid, p_attention_only boolean DEFAULT false, p_limit integer DEFAULT 50',
   'read_agent_runs', 'v.tenant_id, p_cursor, p_status, p_agent_id, p_attention_only, p_limit'),
  ('get_run', 'p_run_id uuid', 'read_agent_run_detail', 'v.tenant_id, p_run_id'),
  ('list_reviews', 'p_cursor text DEFAULT NULL::text, p_status text DEFAULT ''pending''::text, p_limit integer DEFAULT 50',
   'read_reviews', 'v.tenant_id, p_cursor, p_status, p_limit'),
  ('get_review', 'p_review_id uuid', 'read_review_detail', 'v.tenant_id, p_review_id'),
  ('get_review_advice', 'p_review_id uuid', 'read_review_advice', 'v.tenant_id, p_review_id'),
  ('list_events', 'p_cursor text DEFAULT NULL::text, p_subject_type text DEFAULT NULL::text, p_subject_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50',
   'read_events', 'v.tenant_id, p_cursor, p_subject_type, p_subject_id, p_limit'),
  ('list_stops', 'p_include_cleared boolean DEFAULT false, p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 50',
   'read_stops_in_tenant', 'v.tenant_id, p_include_cleared, p_cursor, p_limit'),
  ('spend_summary', '', 'read_spend_summary', 'v.tenant_id'),
  ('communication_status', '', 'read_communication_status', 'v.tenant_id');
insert into cos_catalogue (op, args, callee, callee_args, act) values
  ('decide_review', 'p_review_id uuid, p_decision text', 'decide_review_as_member',
   'v.tenant_id, v.actor, p_review_id, p_decision', true);
-- The trip (S7.2): its gate carries owner decision S0-B's 2 s lock_timeout and
-- answers a lock wait past it with the one generic, retryable refusal.
insert into cos_catalogue (op, args, callee, callee_args, act, gate_config, extra_handler) values
  ('trip_stop', 'p_scope text, p_target_id uuid DEFAULT NULL::uuid', 'trip_stop_in_tenant',
   'v.tenant_id, v.actor, p_scope, p_target_id', true, '{"search_path=\"\"",lock_timeout=2s}',
   'when sqlstate ''55P03'' then raise exception using errcode = ''OS429'', message = ''company_os_api.trip_stop: could not be completed yet; retry''; ');

-- The internal catalogue the read-surface migration adds to ops besides the
-- gates, with each function's volatility and configuration: search_path = ''
-- for all, and custom plans only for the four cursor-paged reads (section E).
create temporary table cos_internal (signature text primary key, volatility "char" not null,
                                     config text[] not null default '{"search_path=\"\""}') on commit drop;
insert into cos_internal values
  ('ops.guard_principal_change()', 'v'), ('ops.guard_membership_change()', 'v'), ('ops.refuse_identity_truncate()', 'v'),
  ('ops.membership_tenant_eligible(uuid)', 's'), ('ops.grant_membership(uuid, uuid, text, text, text)', 'v'),
  ('ops.revoke_membership(uuid, text, text)', 'v'), ('ops.operator_scope()', 's'),
  ('ops.cos_ts(timestamp with time zone)', 'i'), ('ops.cos_money(bigint)', 'i'), ('ops.cos_cursor(text, text)', 'i'),
  ('ops.cos_limit(integer)', 'i'), ('ops.cos_ref_id(uuid, text, uuid)', 's'), ('ops.cos_ref(uuid, text, uuid)', 's'),
  ('ops.cos_stop(uuid, uuid)', 's'), ('ops.cos_tenant_covering_stop(uuid, text, uuid, uuid, uuid)', 's'),
  ('ops.cos_global_admission_blocked()', 's'), ('ops.cos_today_start(uuid)', 's'), ('ops.cos_event_source(text)', 'i'),
  ('ops.cos_event_known(text)', 'i'), ('ops.cos_event_facts(uuid, text, jsonb)', 's'),
  ('ops.cos_run_summary(uuid, ops.agent_runs, timestamp with time zone)', 's'),
  ('ops.cos_review_summary(uuid, ops.review_items)', 's'), ('ops.cos_outbound_summary(uuid, ops.outbound_messages)', 's'),
  ('ops.cos_task_summary(uuid, ops.tasks)', 's'), ('ops.cos_event_summary(uuid, ops.events)', 's'),
  ('ops.read_operator_context(uuid, uuid, text)', 's'), ('ops.agent_operational_state(uuid, uuid, boolean)', 's'),
  ('ops.read_agent_detail(uuid, uuid)', 's'), ('ops.read_overview(uuid)', 's'),
  ('ops.read_tasks(uuid, text, text, uuid, integer)', 's'), ('ops.read_events(uuid, text, text, uuid, integer)', 's'),
  ('ops.read_task_detail(uuid, uuid)', 's'), ('ops.read_agent_runs(uuid, text, text, uuid, boolean, integer)', 's'),
  ('ops.read_agent_run_detail(uuid, uuid)', 's'), ('ops.read_reviews(uuid, text, text, integer)', 's'),
  ('ops.read_review_detail(uuid, uuid)', 's'), ('ops.read_review_advice(uuid, uuid)', 's'),
  ('ops.read_stops_in_tenant(uuid, boolean, text, integer)', 's'), ('ops.read_spend_summary(uuid)', 's'),
  ('ops.read_communication_status(uuid)', 's'),
  ('ops.decide_review_as_member(uuid, text, uuid, text)', 'v'),
  ('ops.cos_review_decidable(uuid, ops.review_items)', 's'),
  ('ops.trip_stop_in_tenant(uuid, text, text, uuid)', 'v'),
  -- Phase 2D.1: get_review's shadow decision, read only.
  ('ops.cos_review_shadow_decision(uuid, ops.review_items)', 's'),
  -- Phase 2D.3: the overview's shadow calibration counts, read only.
  ('ops.cos_decision_intelligence(uuid)', 's'),
  -- Phase 2E.2: the overview's operational health, read only.
  ('ops.cos_operational_health(uuid, timestamp with time zone, timestamp with time zone)', 's'),
  -- Phase 3A: the overview's agenda and its two row summaries, read only.
  ('ops.cos_agenda(uuid, timestamp with time zone)', 's'),
  ('ops.cos_booking_summary(uuid, ops.bookings)', 's'),
  ('ops.cos_follow_up_summary(uuid, ops.follow_ups, timestamp with time zone)', 's'),
  -- Phase 3B.1: the overview's commercial funnel, the provider-neutral entry.
  -- Its one CRM adapter (ops.crm_commercial_funnel and helpers) is not a
  -- Company OS body; commercial_funnel.sql pins it.
  ('ops.cos_commercial_funnel(uuid, timestamp with time zone)', 's');
update cos_internal set config = '{"search_path=\"\"",plan_cache_mode=force_custom_plan}'
 where signature in ('ops.read_tasks(uuid, text, text, uuid, integer)', 'ops.read_events(uuid, text, text, uuid, integer)',
                     'ops.read_agent_runs(uuid, text, text, uuid, boolean, integer)', 'ops.read_reviews(uuid, text, text, integer)');

-- A function's signature, independent of the search path.
create function pg_temp.sig(p oid) returns text
language sql stable as $$
  select n.nspname || '.' || f.proname || '(' || pg_catalog.oidvectortypes(f.proargtypes) || ')'
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace where f.oid = p;
$$;

-- P1. The catalogue: exactly the 17 exposed functions (15 reads and the two
--     acts, decide_review and trip_stop) with their full signatures, one gate
--     each with the same arguments, the internal set, no overload, no
--     relation or type in the exposed schema, and no clear.
create function pg_temp.pin_catalogue() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(coalesce(p.proname, c.op), ', ') into v_bad
    from (select f.proname, pg_get_function_arguments(f.oid) as args, f.prokind, f.proretset, f.prorettype, l.lanname
            from pg_proc f join pg_namespace n on n.oid = f.pronamespace join pg_language l on l.oid = f.prolang
           where n.nspname = 'company_os_api') p
    full join cos_catalogue c on c.op = p.proname
   where p.proname is null or c.op is null or p.args <> c.args or p.prokind <> 'f' or p.proretset
      or p.prorettype <> 'jsonb'::regtype or p.lanname <> 'sql';
  if v_bad is not null then
    raise exception 'P1: the company_os_api catalogue drifted from the pinned signatures: %', v_bad;
  end if;
  if (select count(*) from pg_proc f join pg_namespace n on n.oid = f.pronamespace where n.nspname = 'company_os_api')
     <> (select count(*) from cos_catalogue) then
    raise exception 'P1: company_os_api holds an overload';
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'company_os_api')
     or exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'company_os_api') then
    raise exception 'P1: company_os_api holds a relation, sequence, type or domain';
  end if;
  select string_agg(coalesce(g.proname, 'gate_' || c.op), ', ') into v_bad
    from (select f.proname, pg_get_function_identity_arguments(f.oid) as args
            from pg_proc f join pg_namespace n on n.oid = f.pronamespace
           where n.nspname = 'ops' and f.proname like 'gate\_%') g
    full join (select c.op, pg_get_function_identity_arguments(f.oid) as args
                 from cos_catalogue c
                 join pg_proc f on f.proname = c.op
                 join pg_namespace n on n.oid = f.pronamespace and n.nspname = 'company_os_api') c
      on g.proname = 'gate_' || c.op
   where g.proname is null or c.op is null or g.args is distinct from c.args;
  if v_bad is not null then
    raise exception 'P1: the gates are not exactly one per exposed function with its arguments: %', v_bad;
  end if;
  select string_agg(coalesce(pg_temp.sig(f.oid), i.signature), ', ') into v_bad
    from (select f.oid from pg_proc f join pg_namespace n on n.oid = f.pronamespace
           where n.nspname = 'ops' and (f.proname ~ '^(cos_|read_)'
              or f.proname in ('guard_principal_change', 'guard_membership_change', 'refuse_identity_truncate',
                               'membership_tenant_eligible', 'grant_membership', 'revoke_membership',
                               'operator_scope', 'agent_operational_state', 'decide_review_as_member',
                               'trip_stop_in_tenant'))) f
    full join cos_internal i on i.signature = pg_temp.sig(f.oid)
   where f.oid is null or i.signature is null;
  if v_bad is not null then
    raise exception 'P1: the internal catalogue drifted: %', v_bad;
  end if;
  -- The two acts are the review decision (S7.1) and the trip (S7.2); nothing
  -- the browser reaches clears, resumes or untrips a stop, anywhere.
  select string_agg(pg_temp.sig(f.oid), ', ') into v_bad from pg_proc f
   where (f.pronamespace = 'company_os_api'::regnamespace and f.proname ~ '(clear|resume|untrip)')
      or (f.pronamespace = 'ops'::regnamespace and f.proname ~ '^gate_.*(clear|resume|untrip)');
  if v_bad is not null then
    raise exception 'P1: a clear function is exposed to the browser: %', v_bad;
  end if;
end
$f$;

-- An exposed function's pinned volatility: VOLATILE for the one act, STABLE
-- for every read.
create function pg_temp.volatility_of(p_op text) returns "char"
language sql stable as $$
  select case when exists (select 1 from cos_catalogue c where c.op = p_op and c.act) then 'v' else 's' end::"char";
$$;

-- P2. Each exposed function: SECURITY DEFINER, search_path = '', STABLE (the
--     one act VOLATILE),
--     owned by ops_operator_api, executable by authenticated (and implicitly
--     its owner) only, its body exactly one call to its own gate.
create function pg_temp.pin_exposed() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(format('%s (%s)', f.proname, concat_ws(' ',
           case when not f.prosecdef then 'not DEFINER' end,
           case when f.proconfig is distinct from '{"search_path=\"\""}'::text[] then 'config ' || f.proconfig::text end,
           case when f.provolatile <> pg_temp.volatility_of(f.proname) then 'volatility ' || f.provolatile::text end,
           case when f.proowner <> 'ops_operator_api'::regrole then 'owner ' || f.proowner::regrole::text end,
           case when f.proacl is distinct from '{ops_operator_api=X/ops_operator_api,authenticated=X/ops_operator_api}'::aclitem[]
                then 'acl ' || coalesce(f.proacl::text, 'default (PUBLIC)') end,
           case when btrim(regexp_replace(f.prosrc, '\s+', ' ', 'g'))
                     <> format('select ops.gate_%s(%s)', f.proname, coalesce(array_to_string(f.proargnames, ', '), ''))
                then 'body ' || btrim(f.prosrc) end)), '; ') into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname = 'company_os_api'
     and (not f.prosecdef or f.proconfig is distinct from '{"search_path=\"\""}'::text[]
          or f.provolatile <> pg_temp.volatility_of(f.proname)
          or f.proowner <> 'ops_operator_api'::regrole
          or f.proacl is distinct from '{ops_operator_api=X/ops_operator_api,authenticated=X/ops_operator_api}'::aclitem[]
          or btrim(regexp_replace(f.prosrc, '\s+', ' ', 'g'))
             <> format('select ops.gate_%s(%s)', f.proname, coalesce(array_to_string(f.proargnames, ', '), '')));
  if v_bad is not null then
    raise exception 'P2: an exposed function is not a DEFINER one-call wrapper owned by ops_operator_api with its pinned ACL: %', v_bad;
  end if;
  -- The schema: owned by the migration identity; USAGE for authenticated
  -- only; CREATE for nobody else; no PUBLIC EXECUTE there or in ops (A3).
  if (select nspowner::regrole::text from pg_namespace where nspname = 'company_os_api') <> 'postgres'
     or not has_schema_privilege('authenticated', 'company_os_api', 'USAGE')
     or has_schema_privilege('anon', 'company_os_api', 'USAGE') or has_schema_privilege('service_role', 'company_os_api', 'USAGE')
     or has_schema_privilege('public', 'company_os_api', 'USAGE')
     or has_schema_privilege('ops_worker', 'company_os_api', 'USAGE') or has_schema_privilege('ops_gateway', 'company_os_api', 'USAGE')
     or has_schema_privilege('ops_operator_api', 'company_os_api', 'USAGE')
     or exists (select 1 from pg_roles r where r.rolname <> 'postgres' and not r.rolsuper
                   and has_schema_privilege(r.oid, 'company_os_api', 'CREATE'))
     or has_schema_privilege('authenticated', 'ops', 'USAGE') or has_schema_privilege('anon', 'ops', 'USAGE') then
    raise exception 'P2: a schema privilege on company_os_api or ops is wider than the graph';
  end if;
  select string_agg(pg_temp.sig(f.oid), ', ') into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname in ('ops', 'company_os_api')
     and (f.proacl is null or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'P2: function(s) executable by PUBLIC: %', v_bad;
  end if;
end
$f$;

-- P3. Each gate: SECURITY DEFINER, owned by the owner of the ops tables,
--     executable by ops_operator_api (and its owner) only, search_path = '',
--     STABLE, and its body exactly the pinned shape: the resolver first, its
--     one callee with the resolved tenant and the caller's selectors,
--     no-store, and one fixed data-free message per SQLSTATE.
create function pg_temp.pin_gates() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(format('%s (%s)', f.proname, concat_ws(' ',
           case when not f.prosecdef then 'not DEFINER' end,
           case when f.proowner <> 'postgres'::regrole then 'owner ' || f.proowner::regrole::text end,
           case when f.proacl is distinct from '{postgres=X/postgres,ops_operator_api=X/postgres}'::aclitem[]
                then 'acl ' || coalesce(f.proacl::text, 'default (PUBLIC)') end,
           case when f.proconfig is distinct from c.gate_config then 'config ' || coalesce(f.proconfig::text, 'none') end,
           case when f.provolatile <> pg_temp.volatility_of(c.op) then 'volatility ' || f.provolatile::text end,
           case when b.actual <> b.expected then 'body ' || b.actual end,
           case when b.callees is distinct from b.pinned then 'callees ' || b.callees::text end)), '; ') into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace and n.nspname = 'ops'
    join cos_catalogue c on 'gate_' || c.op = f.proname
    cross join lateral (
      select btrim(regexp_replace(f.prosrc, '\s+', ' ', 'g')) as actual,
             format('declare v record; r pg_catalog.jsonb; begin select * into v from ops.operator_scope(); '
                    'r := ops.%s(%s); '
                    'perform pg_catalog.set_config(''response.headers'', ''[{"Cache-Control": "no-store"}]'', true); '
                    'return r; exception '
                    'when sqlstate ''OS400'' then raise exception using errcode = ''OS400'', message = ''company_os_api.%s: bad request''; '
                    'when sqlstate ''OS401'' then raise exception using errcode = ''OS401'', message = ''company_os_api.%s: not signed in''; '
                    'when sqlstate ''OS403'' then raise exception using errcode = ''OS403'', message = ''company_os_api.%s: no access''; '
                    'when sqlstate ''OS404'' then raise exception using errcode = ''OS404'', message = ''company_os_api.%s: not found''; '
                    'when sqlstate ''OS409'' then raise exception using errcode = ''OS409'', message = ''company_os_api.%s: conflict''; '
                    '%s'
                    'when others then raise exception using errcode = ''OS500'', message = ''company_os_api.%s: internal error''; end',
                    c.callee, c.callee_args, c.op, c.op, c.op, c.op, c.op, c.extra_handler, c.op) as expected,
             (select array_agg(distinct m[1] order by m[1])
                from regexp_matches(f.prosrc, '([a-z_]+\."?[a-z_0-9]+"?)\s*\(', 'g') m) as callees,
             (select array_agg(x order by x) from unnest(array['ops.operator_scope', 'ops.' || c.callee, 'pg_catalog.set_config']) x)
               as pinned) b
   where not f.prosecdef or f.proowner <> 'postgres'::regrole
      or f.proacl is distinct from '{postgres=X/postgres,ops_operator_api=X/postgres}'::aclitem[]
      or f.proconfig is distinct from c.gate_config or f.provolatile <> pg_temp.volatility_of(c.op)
      or b.actual <> b.expected or b.callees is distinct from b.pinned;
  if v_bad is not null then
    raise exception 'P3: a gate is not exactly the resolver, its one pinned callee and no-store, with its pinned owner and ACL: %', v_bad;
  end if;
end
$f$;

-- P4. The resolver, the eligibility predicate, the projections and their
--     helpers are SECURITY INVOKER, owner-only, search_path = '' (and, for
--     the four paged reads, custom plans only), with their pinned
--     volatility: the resolver and every read STABLE, never IMMUTABLE.
create function pg_temp.pin_internal() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(format('%s (%s)', i.signature, concat_ws(' ',
           case when f.prosecdef then 'DEFINER' end,
           case when f.proowner <> 'postgres'::regrole then 'owner ' || f.proowner::regrole::text end,
           case when f.proacl is distinct from '{postgres=X/postgres}'::aclitem[] then 'acl ' || coalesce(f.proacl::text, 'default (PUBLIC)') end,
           case when f.proconfig is distinct from i.config then 'config ' || coalesce(f.proconfig::text, 'none') end,
           case when f.provolatile <> i.volatility then 'volatility ' || f.provolatile::text end)), '; ') into v_bad
    from cos_internal i join pg_proc f on pg_temp.sig(f.oid) = i.signature
   where f.prosecdef or f.proowner <> 'postgres'::regrole
      or f.proacl is distinct from '{postgres=X/postgres}'::aclitem[]
      or f.proconfig is distinct from i.config or f.provolatile <> i.volatility;
  if v_bad is not null then
    raise exception 'P4: an internal function is DEFINER, reachable, unpinned or of the wrong volatility: %', v_bad;
  end if;
  if exists (select 1 from cos_internal i where i.volatility = 'i'
              and i.signature ~ '^ops\.(operator_scope|membership_tenant_eligible|read_|agent_operational_state)') then
    raise exception 'P4: the pinned volatility itself lets the resolver or a read be IMMUTABLE';
  end if;
end
$f$;

-- P5. The graph bodies (the exposed functions, the gates, the resolver, the
--     predicate, the projections and their helpers) call only a pinned set of
--     ops functions, none VOLATILE; never the CRM adapter, send eligibility,
--     a send, mark, clear, request or start; no schema public, no email, no
--     write and no dynamic SQL; no schema but ops and pg_catalog (and, in the
--     resolver only, auth.sessions and auth.users). Each named service a
--     browser must never reach is VOLATILE, so the volatility rule alone would
--     catch it.
-- The READ graph: the acts' paths (decide_review, trip_stop and their gates)
-- write by design and are pinned on their own by P5b.
create function pg_temp.graph_bodies() returns table (fid oid)
language sql stable as $$
  select f.oid from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where f.proname not in ('decide_review', 'gate_decide_review', 'trip_stop', 'gate_trip_stop')
     and (n.nspname = 'company_os_api'
          or (n.nspname = 'ops' and (f.proname ~ '^(gate_|read_|cos_)'
              or f.proname in ('operator_scope', 'membership_tenant_eligible', 'agent_operational_state'))));
$$;

-- A body as code only, lower-cased: every comment removed and every string
-- literal emptied (''), each found by scanning, so an apostrophe inside a
-- comment cannot pair with a quote in the code and hide a call.
create function pg_temp.code_only(p text) returns text
language plpgsql immutable as $f$
declare
  v_rest text := lower(p);
  v_out  text := '';
  v_q    int;
  v_line int;
  v_blk  int;
  v_at   int;
  v_end  int;
begin
  loop
    v_q := nullif(strpos(v_rest, ''''), 0);
    v_line := nullif(strpos(v_rest, '--'), 0);
    v_blk := nullif(strpos(v_rest, '/*'), 0);
    v_at := least(v_q, v_line, v_blk);
    if v_at is null then
      return v_out || v_rest;
    end if;
    v_out := v_out || substr(v_rest, 1, v_at - 1);
    v_rest := substr(v_rest, v_at);
    if v_at = v_q then
      -- A string: to its closing quote, a doubled quote being part of it.
      v_end := 2;
      loop
        v_at := strpos(substr(v_rest, v_end), '''');
        if v_at = 0 then
          return v_out || '''''';
        end if;
        v_end := v_end + v_at - 1;
        exit when substr(v_rest, v_end + 1, 1) <> '''';
        v_end := v_end + 2;
      end loop;
      v_out := v_out || '''''';
      v_rest := substr(v_rest, v_end + 1);
    elsif v_at = v_line then
      v_at := strpos(v_rest, E'\n');
      if v_at = 0 then
        return v_out;
      end if;
      v_rest := substr(v_rest, v_at);
    else
      v_at := strpos(substr(v_rest, 3), '*/');
      if v_at = 0 then
        return v_out;
      end if;
      v_out := v_out || ' ';
      v_rest := substr(v_rest, v_at + 4);
    end if;
  end loop;
end
$f$;

-- Every name a body's code calls, schema-qualified or not, quoted or not.
create function pg_temp.called_names(p text) returns setof text
language sql immutable as $$
  select distinct m[1]
    from regexp_matches(pg_temp.code_only(p), '(?:^|[^a-z0-9_$"])"?([a-z_][a-z0-9_$]*)"?(?=\s*\()', 'g') m;
$$;

create function pg_temp.pin_graph() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(format('%s calls ops.%s', pg_temp.sig(g.fid), m.callee), '; ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid,
         lateral (select distinct x[1] as callee from regexp_matches(f.prosrc, 'ops\."?([a-z_0-9]+)"?\s*\(', 'g') x) m
   where not (m.callee ~ '^(gate_|read_|cos_)'
              or m.callee in ('operator_scope', 'membership_tenant_eligible', 'agent_operational_state',
                              'execution_stop_covers', 'job_covering_stop', 'spend_status', 'spend_window_start',
                              'agent_run_result_valid',
                              -- Phase 2D.2: reads the policy registry's one current version.
                              'current_shadow_policy_version',
                              -- Phase 3A: the agenda's next free slots, a STABLE,
                              -- bounded and deterministic read.
                              'available_slots',
                              -- Phase 3B.1 (owner brief, 2026-09-25): the
                              -- commercial funnel's ONE read-only CRM adapter.
                              -- It serves only the tenant that owns the local
                              -- CRM, reads only the five CRM tables the funnel
                              -- needs and writes nothing (commercial_funnel.sql
                              -- F1 pins it). No other CRM service is callable.
                              'crm_commercial_funnel'))
      or m.callee in ('crm_contact_by_phone', 'whatsapp_send_eligibility')
      or (m.callee !~ '^(gate_|read_|cos_)' and m.callee <> 'spend_window_start'
          and m.callee ~ '(^|_)(send|mark|clear|request|start|trip|grant|revoke|admit|receive|configure|record|enforce|settle|lease|claim|defer|reap|assign|transition)(_|$)')
      or exists (select 1 from pg_proc c where c.pronamespace = 'ops'::regnamespace and c.proname = m.callee and c.provolatile = 'v')
      or not exists (select 1 from pg_proc c where c.pronamespace = 'ops'::regnamespace and c.proname = m.callee);
  if v_bad is not null then
    raise exception 'P5: a graph body reaches beyond the pinned read callees: %', v_bad;
  end if;
  select string_agg(pg_temp.sig(g.fid), ', ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid
   where f.prosrc ~* '\mpublic\.' or f.prosrc ~* 'email'
      -- A write verb in the CODE. String literals are data (Phase 3A's
      -- calendar operation 'update' is one); a literal can only become SQL
      -- through EXECUTE, which the next rule refuses on the raw source.
      or regexp_replace(f.prosrc, '''([^'']|'''')*''', '''''', 'g') ~* '\m(insert|update|delete|truncate|merge|copy)\M'
      -- A PL/pgSQL EXECUTE statement (the job kind 'agent_run.execute' is data).
      or f.prosrc ~* '(^|[\s;])execute\s'
      or f.prosrc ~* 'crm_contact_by_phone|whatsapp_send_eligibility|clear_execution_stop';
  if v_bad is not null then
    raise exception 'P5: a graph body reads public or an email, writes, runs dynamic SQL or names a forbidden service: %', v_bad;
  end if;
  -- Every schema-qualified name a graph body uses names ops or pg_catalog; the
  -- resolver alone may also read auth.sessions and auth.users (brief §7.4).
  -- Any other schema fails, pg_temp included, so no body reads or calls past
  -- the pinned surface through a name the callee rule above does not parse. A
  -- qualifier counts as a schema when a namespace carries its name (aliases
  -- and row variables do not); string literals are data and are skipped (the
  -- EXECUTE rule above keeps them from becoming SQL).
  select string_agg(distinct format('%s names %s.%s', pg_temp.sig(g.fid), m[1], m[2]), '; ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid,
         regexp_matches(regexp_replace(lower(f.prosrc), '''([^'']|'''')*''', '''''', 'g'),
                        '(?:^|[^a-z0-9_$".])"?([a-z_][a-z0-9_$]*)"?\s*\.\s*"?([a-z_][a-z0-9_$]*)', 'g') m
   where (m[1] ~ '^pg_' or exists (select 1 from pg_namespace n where n.nspname = m[1]))
     and m[1] not in ('ops', 'pg_catalog')
     and not (f.oid = 'ops.operator_scope()'::regprocedure and m[1] = 'auth' and m[2] in ('sessions', 'users'));
  if v_bad is not null then
    raise exception 'P5: a graph body names a schema outside its pinned set: %', v_bad;
  end if;
  -- pg_catalog is allowed, and it holds built-ins that would carry a body
  -- past everything above. Denied by name, plain, qualified or quoted: those
  -- that run SQL text (query_to_xml*, cursor_to_xml*, ts_stat, ts_rewrite)
  -- or read a relation, a sequence, a file or a large object by name
  -- (table_to_xml*, schema_to_xml*, database_to_xml*, nextval, currval,
  -- setval, lastval, pg_sequence_last_value, pg_read_file,
  -- pg_read_binary_file, pg_ls_*, pg_stat_file, lo_*, loread, lowrite,
  -- pg_logical_*, pg_export_*, pg_import_*, dblink*).
  -- The scan reads plain strings and comments only: an escape string or a
  -- dollar-quoted one in a graph body fails closed instead of being misread.
  select string_agg(pg_temp.sig(g.fid), ', ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid
   where f.prosrc ~* '(^|[^a-z0-9_''])e''' or f.prosrc ~ '\$[a-z_0-9]*\$';
  if v_bad is not null then
    raise exception 'P5: a graph body holds an escape or dollar-quoted string, which the code scan cannot read: %', v_bad;
  end if;
  select string_agg(distinct format('%s calls %s', pg_temp.sig(g.fid), c), '; ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid, pg_temp.called_names(f.prosrc) c
   where c ~ '^((query|table|cursor|schema|database)_to_xml|ts_(stat|rewrite)$|(nextval|currval|setval|lastval|pg_sequence_last_value)$|pg_read_(binary_)?file$|pg_ls_|pg_stat_file$|lo_|lo(read|write)$|pg_logical_|pg_(export|import)_|dblink)';
  if v_bad is not null then
    raise exception 'P5: a graph body runs SQL text or reads a relation, a sequence, a file or a large object by name: %', v_bad;
  end if;
  -- Every other VOLATILE built-in is denied too (a read changes nothing), but
  -- clock_timestamp, and set_config in a gate (its no-store header; P3 pins
  -- each gate's body).
  select string_agg(distinct format('%s calls %s', pg_temp.sig(g.fid), c), '; ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid, pg_temp.called_names(f.prosrc) c
   where exists (select 1 from pg_proc b where b.pronamespace = 'pg_catalog'::regnamespace and b.proname = c and b.provolatile = 'v')
     and c <> 'clock_timestamp'
     and not (c = 'set_config' and f.pronamespace = 'ops'::regnamespace and f.proname ~ '^gate_');
  if v_bad is not null then
    raise exception 'P5: a graph body calls a volatile built-in other than clock_timestamp, or set_config outside a gate: %', v_bad;
  end if;
  -- No system catalog either, named plain, qualified or quoted (with no
  -- search path, pg_catalog is still searched): pg_statistic alone holds
  -- sample values of every tenant's columns, and pg_stat_activity other
  -- sessions' statements.
  select string_agg(distinct format('%s names %s', pg_temp.sig(g.fid), m[1]), '; ') into v_bad
    from pg_temp.graph_bodies() g join pg_proc f on f.oid = g.fid,
         regexp_matches(pg_temp.code_only(f.prosrc), '(?:^|[^a-z0-9_$"])"?(pg_[a-z0-9_]+)"?(?![a-z0-9_$])', 'g') m
   where exists (select 1 from pg_class r where r.relnamespace = 'pg_catalog'::regnamespace and r.relname = m[1]
                    and r.relkind in ('r', 'v', 'm', 'p', 'f'));
  if v_bad is not null then
    raise exception 'P5: a graph body reads a system catalog: %', v_bad;
  end if;
  select string_agg(x, ', ') into v_bad
    from unnest(array['request_agent_run', 'start_agent_run', 'assign_task', 'record_event', 'open_review_for_settled_job',
                      'enforce_spend_ceiling', 'spend_admission', 'set_agent_status', 'clear_execution_stop',
                      'trip_execution_stop', 'configure_whatsapp_channel', 'request_outbound_send', 'begin_outbound_send',
                      'settle_outbound_send', 'mark_outbound_indeterminate', 'whatsapp_send_eligibility',
                      'admit_inbound_message', 'admit_inbound_core', 'receive_whatsapp_message', 'receive_whatsapp_status',
                      'lease_job', 'complete_job', 'fail_job', 'claim_agent_run', 'refuse_agent_run', 'complete_agent_run',
                      'fail_agent_run', 'settle_stale_agent_runs', 'job_execution_stop', 'defer_job', 'reap_expired_leases',
                      'grant_membership', 'revoke_membership', 'record_review_decision', 'open_missing_reviews',
                      'record_model_price', 'set_spend_limit', 'retire_spend_limit']) x
   where not exists (select 1 from pg_proc c where c.pronamespace = 'ops'::regnamespace and c.proname = x)
      or exists (select 1 from pg_proc c where c.pronamespace = 'ops'::regnamespace and c.proname = x and c.provolatile <> 'v');
  if v_bad is not null then
    raise exception 'P5: a service a browser must never reach is missing or not VOLATILE, so the denylist would miss it: %', v_bad;
  end if;
end
$f$;

-- P6. ops_operator_api: NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
--     NOBYPASSRLS NOINHERIT; no member and no membership at rest; in no login
--     role's recursive membership closure; USAGE on ops; CREATE nowhere;
--     EXECUTE in ops exactly the gates; no relation, column or sequence
--     privilege where it holds USAGE (the K2 shape); owning exactly the
--     exposed catalogue.
create function pg_temp.pin_role() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  if not exists (select 1 from pg_roles r where r.rolname = 'ops_operator_api'
                  and not r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
                  and not r.rolbypassrls and not r.rolinherit and not r.rolreplication
                  and r.rolvaliduntil is null and r.rolconfig is null) then
    raise exception 'P6: ops_operator_api is missing, can log in, or carries a blanket attribute';
  end if;
  select string_agg(format('%s in %s', m.member::regrole, m.roleid::regrole), ', ') into v_bad
    from pg_auth_members m
   where m.roleid = 'ops_operator_api'::regrole or m.member = 'ops_operator_api'::regrole;
  if v_bad is not null then
    raise exception 'P6: ops_operator_api has a member or a membership at rest: %', v_bad;
  end if;
  with recursive closure (login, role) as (
    select r.oid, r.oid from pg_roles r where r.rolcanlogin
    union
    select c.login, m.roleid from closure c join pg_auth_members m on m.member = c.role)
  select string_agg(distinct c.login::regrole::text, ', ') into v_bad
    from closure c where c.role = 'ops_operator_api'::regrole;
  if v_bad is not null then
    raise exception 'P6: ops_operator_api is in the membership closure of login role(s): %', v_bad;
  end if;
  -- This session's own temporary schema is exempt, by oid and nothing else:
  -- PostgreSQL lets every role holding TEMPORARY on the database use the
  -- temporary schema of the session it runs in, and nobody can open a session
  -- as ops_operator_api. P6b pins the exemption to exactly that schema.
  select string_agg(n.nspname, ', ') into v_bad from pg_namespace n
   where has_schema_privilege('ops_operator_api', n.oid, 'CREATE') and n.oid <> pg_my_temp_schema();
  if v_bad is not null or has_database_privilege('ops_operator_api', current_database(), 'CREATE') then
    raise exception 'P6: ops_operator_api can create objects: %', coalesce(v_bad, 'the database');
  end if;
  select string_agg(n.nspname, ', ' order by n.nspname) into v_bad from pg_namespace n
   where has_schema_privilege('ops_operator_api', n.oid, 'USAGE') and n.oid <> pg_my_temp_schema();
  if v_bad is distinct from 'information_schema, ops, pg_catalog, public' then
    raise exception 'P6: ops_operator_api holds USAGE on % instead of exactly ops (and what PUBLIC gives)', v_bad;
  end if;
  -- P6b, the CI case (run 35901717419): a session that has a temporary
  -- schema, as this one does (cos_ids lives in it), sees CREATE for
  -- ops_operator_api there through TEMPORARY on the database. The exemption
  -- must remove exactly that schema: no persistent one, and not the session's
  -- toast-temporary schema, which is scanned like any other.
  if pg_my_temp_schema() = 0 then
    raise exception 'P6b: this session has no temporary schema, so the CI case is not reproduced';
  end if;
  select string_agg(n.nspname, ', ') into v_bad from pg_namespace n
   where has_schema_privilege('ops_operator_api', n.oid, 'CREATE');
  if v_bad is distinct from (select n.nspname::text from pg_namespace n where n.oid = pg_my_temp_schema()) then
    raise exception 'P6b: without the exemption, ops_operator_api can create in % instead of only this session''s temporary schema',
      coalesce(v_bad, 'nothing');
  end if;
  if has_schema_privilege('ops_operator_api', 'company_os_api', 'CREATE')
     or has_schema_privilege('ops_operator_api', 'ops', 'CREATE')
     or has_schema_privilege('ops_operator_api', 'public', 'CREATE') then
    raise exception 'P6b: ops_operator_api can create objects in company_os_api, ops or public';
  end if;
  select string_agg(pg_temp.sig(f.oid), ', ') into v_bad
    from pg_proc f join pg_namespace n on n.oid = f.pronamespace
   where n.nspname = 'ops' and has_function_privilege('ops_operator_api', f.oid, 'EXECUTE')
     and not exists (select 1 from cos_catalogue c where 'gate_' || c.op = f.proname);
  if v_bad is not null
     or (select count(*) from pg_proc f join pg_namespace n on n.oid = f.pronamespace
          where n.nspname = 'ops' and f.proname like 'gate\_%'
            and has_function_privilege('ops_operator_api', f.oid, 'EXECUTE')) <> (select count(*) from cos_catalogue) then
    raise exception 'P6: ops_operator_api''s EXECUTE surface in ops is not exactly the gates: %', coalesce(v_bad, 'a gate is missing');
  end if;
  select string_agg(c.oid::regclass::text, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast_)?temp_'
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and has_schema_privilege('ops_operator_api', n.oid, 'USAGE')
     and (case when c.relkind = 'S' then has_sequence_privilege('ops_operator_api', c.oid, 'USAGE,SELECT,UPDATE')
               else has_table_privilege('ops_operator_api', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or has_any_column_privilege('ops_operator_api', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') end);
  if v_bad is not null then
    raise exception 'P6: ops_operator_api holds a relation, column or sequence privilege: %', v_bad;
  end if;
  select string_agg(x, ', ') into v_bad from (
    select pg_temp.sig(f.oid) x from pg_proc f
     where f.proowner = 'ops_operator_api'::regrole
       and not (f.pronamespace = 'company_os_api'::regnamespace and exists (select 1 from cos_catalogue c where c.op = f.proname))
    union all select c.oid::regclass::text from pg_class c where c.relowner = 'ops_operator_api'::regrole
    union all select n.nspname from pg_namespace n where n.nspowner = 'ops_operator_api'::regrole
    union all select t.oid::regtype::text from pg_type t where t.typowner = 'ops_operator_api'::regrole) o;
  if v_bad is not null
     or (select count(*) from pg_proc f where f.proowner = 'ops_operator_api'::regrole) <> (select count(*) from cos_catalogue) then
    raise exception 'P6: ops_operator_api owns something other than exactly the exposed catalogue: %', coalesce(v_bad, 'a count mismatch');
  end if;
end
$f$;

-- P7 (K4). Every SECURITY DEFINER function authenticated can execute outside
--     pg_catalog, information_schema and ops, by signature, trigger functions
--     exempt and nothing by pattern: the exposed catalogue, and the platform
--     and CRM entries measured on this stack (S0.4), pinned as observed, not
--     approved: the six PUBLIC CRM helpers are existing debt.
create function pg_temp.pin_k4() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(coalesce(a.s, e.s), ', ') into v_bad
    from (select pg_temp.sig(f.oid) s from pg_proc f join pg_namespace n on n.oid = f.pronamespace
           where n.nspname not in ('pg_catalog', 'information_schema', 'ops') and n.nspname !~ '^pg_(toast_)?temp_'
             and f.prosecdef and f.prorettype <> 'trigger'::regtype
             and has_function_privilege('authenticated', f.oid, 'EXECUTE')) a
    full join (select 'company_os_api.' || c.op || '(' ||
                      (select oidvectortypes(f.proargtypes) from pg_proc f
                        where f.pronamespace = 'company_os_api'::regnamespace and f.proname = c.op) || ')' s
                 from cos_catalogue c
               union all
               select unnest(array['public.is_admin()', 'public.can_access_contact(bigint)', 'public.can_access_deal(bigint)',
                                   'public.can_manage_sales_id(bigint)', 'public.current_sales_id()',
                                   'public.is_active_sales_user()', 'graphql.get_schema_version()',
                                   'graphql.increment_schema_version()'])) e using (s)
   where a.s is null or e.s is null;
  if v_bad is not null then
    raise exception 'P7 (K4): the SECURITY DEFINER functions authenticated can execute drifted: %', v_bad;
  end if;
end
$f$;

-- P8 (K5). Every function outside pg_catalog, information_schema and ops that
--     ops_operator_api owns anywhere, or can execute (PUBLIC included) in a
--     schema where it holds USAGE, by signature, trigger functions exempt: its
--     own exposed catalogue, and what PUBLIC already executes in public
--     (measured in S0.4; existing debt, pinned as observed, not approved).
create function pg_temp.pin_k5() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(coalesce(a.s, e.s), ', ') into v_bad
    from (select pg_temp.sig(f.oid) s from pg_proc f join pg_namespace n on n.oid = f.pronamespace
           where n.nspname not in ('pg_catalog', 'information_schema', 'ops') and n.nspname !~ '^pg_(toast_)?temp_'
             and f.prorettype <> 'trigger'::regtype
             and (f.proowner = 'ops_operator_api'::regrole
                  or (has_schema_privilege('ops_operator_api', n.oid, 'USAGE')
                      and has_function_privilege('ops_operator_api', f.oid, 'EXECUTE')))) a
    full join (select 'company_os_api.' || c.op || '(' ||
                      (select oidvectortypes(f.proargtypes) from pg_proc f
                        where f.pronamespace = 'company_os_api'::regnamespace and f.proname = c.op) || ')' s
                 from cos_catalogue c
               union all
               select unnest(array['public.is_admin()', 'public.can_access_contact(bigint)', 'public.can_access_deal(bigint)',
                                   'public.can_manage_sales_id(bigint)', 'public.current_sales_id()',
                                   'public.is_active_sales_user()', 'public.get_note_attachments_function_url()',
                                   'public.get_avatar_for_email(text)', 'public.get_domain_favicon(text)',
                                   'public.merge_contacts(bigint, bigint)'])) e using (s)
   where a.s is null or e.s is null;
  if v_bad is not null then
    raise exception 'P8 (K5): the functions ops_operator_api owns or can execute outside ops drifted: %', v_bad;
  end if;
end
$f$;

-- P9. No default privilege reaches ops or company_os_api: none scoped to
--     either schema and none global (defaclnamespace 0, which reaches every
--     schema), measured in S0.4 as the empty set; so no role gains any
--     future authority there.
create function pg_temp.pin_default_acl() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(format('%s %s %s %s', d.defaclrole::regrole, coalesce(n.nspname, '(global)'), d.defaclobjtype, d.defaclacl), '; ')
    into v_bad
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
   where d.defaclnamespace = 0 or n.nspname in ('ops', 'company_os_api');
  if v_bad is not null then
    raise exception 'P9: a default privilege reaches ops or company_os_api: %', v_bad;
  end if;
end
$f$;

-- P10. The platform role graph around the capability role (owner decision
--      S0-G), measured on this stack and pinned as observed, not approved:
--      the roles that are superusers or CREATEROLE (able to grant any
--      non-superuser role, ops_operator_api included), the login roles whose
--      recursive closure reaches one (so able to become or grant
--      ops_operator_api), the recursive members of authenticated, and the
--      roles able to become ops_operator_api today (none).
create function pg_temp.pin_role_closure() returns void
language plpgsql as $f$
declare
  v_got text;
begin
  select string_agg(r.rolname, ',' order by r.rolname) into v_got from pg_roles r where r.rolsuper or r.rolcreaterole;
  if v_got is distinct from 'dashboard_user,postgres,supabase_admin,supabase_auth_admin,supabase_functions_admin,supabase_storage_admin' then
    raise exception 'P10: the superuser and CREATEROLE roles drifted: %', v_got;
  end if;
  with recursive closure (login, role) as (
    select r.oid, r.oid from pg_roles r where r.rolcanlogin
    union
    select c.login, m.roleid from closure c join pg_auth_members m on m.member = c.role)
  select string_agg(distinct l.rolname, ',' order by l.rolname) into v_got
    from closure c join pg_roles l on l.oid = c.login join pg_roles t on t.oid = c.role
   where t.rolsuper or t.rolcreaterole;
  if v_got is distinct from 'postgres,supabase_admin,supabase_auth_admin,supabase_functions_admin,supabase_storage_admin' then
    raise exception 'P10: the login roles able to reach a superuser or CREATEROLE role drifted: %', v_got;
  end if;
  with recursive members (role) as (
    select m.member from pg_auth_members m where m.roleid = 'authenticated'::regrole
    union
    select m.member from members x join pg_auth_members m on m.roleid = x.role)
  select string_agg(r.rolname || case when r.rolcanlogin then '(login)' else '' end, ',' order by r.rolname) into v_got
    from members x join pg_roles r on r.oid = x.role;
  if v_got is distinct from 'authenticator(login),postgres(login),supabase_realtime_admin,supabase_storage_admin(login)' then
    raise exception 'P10: the recursive members of authenticated drifted: %', v_got;
  end if;
  with recursive members (role) as (
    select m.member from pg_auth_members m where m.roleid = 'ops_operator_api'::regrole
    union
    select m.member from members x join pg_auth_members m on m.roleid = x.role)
  select string_agg(x.role::regrole::text, ',') into v_got from members x;
  if v_got is not null
     or exists (select 1 from pg_auth_members m where m.roleid = 'ops_operator_api'::regrole and m.admin_option) then
    raise exception 'P10: a role can become or administer ops_operator_api: %', v_got;
  end if;
end
$f$;

-- P5b. The act's path (S7.1). Its gate reaches the resolver and its one callee
--      (P3). The callee calls only the authoritative ops.record_review_decision,
--      ops.cos_ts and the decidable rule ops.cos_review_decidable (a STABLE
--      read helper, pinned with the reads) and writes nothing itself; the exposed act, its gate, its
--      callee and the authoritative operation name no send, no outbound row,
--      no job, no run, no WhatsApp or CRM service, no schema public, no email
--      and no dynamic SQL: accepting a review is not sending (SI-45).
create function pg_temp.pin_act_graph() returns void
language plpgsql as $f$
declare
  c_path constant regprocedure[] := array[
    'company_os_api.decide_review(uuid, text)'::regprocedure, 'ops.gate_decide_review(uuid, text)'::regprocedure,
    'ops.decide_review_as_member(uuid, text, uuid, text)'::regprocedure,
    'ops.record_review_decision(uuid, uuid, text, text, text, text)'::regprocedure,
    'company_os_api.trip_stop(text, uuid)'::regprocedure, 'ops.gate_trip_stop(text, uuid)'::regprocedure,
    'ops.trip_stop_in_tenant(uuid, text, text, uuid)'::regprocedure,
    'ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid, text)'::regprocedure];
  -- The authoritative operations write; the acts' own layers never do.
  c_writers constant regprocedure[] := array[
    'ops.record_review_decision(uuid, uuid, text, text, text, text)'::regprocedure,
    'ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid, text)'::regprocedure];
  v_bad text;
begin
  select string_agg(distinct m[1], ', ') into v_bad
    from pg_proc f, regexp_matches(pg_temp.code_only(f.prosrc), 'ops\."?([a-z_0-9]+)"?\s*\(', 'g') m
   where f.oid = 'ops.decide_review_as_member(uuid, text, uuid, text)'::regprocedure
     and m[1] not in ('record_review_decision', 'cos_ts', 'cos_review_decidable');
  if v_bad is not null then
    raise exception 'P5b: the act''s callee reaches beyond record_review_decision, cos_ts and cos_review_decidable: %', v_bad;
  end if;
  select string_agg(distinct m[1], ', ') into v_bad
    from pg_proc f, regexp_matches(pg_temp.code_only(f.prosrc), 'ops\."?([a-z_0-9]+)"?\s*\(', 'g') m
   where f.oid = 'ops.trip_stop_in_tenant(uuid, text, text, uuid)'::regprocedure
     and m[1] not in ('trip_execution_stop', 'cos_ts');
  if v_bad is not null then
    raise exception 'P5b: the trip''s callee reaches beyond trip_execution_stop and cos_ts: %', v_bad;
  end if;
  -- Nothing on the browser's side of the trip names a clear.
  select string_agg(pg_temp.sig(f.oid), ', ') into v_bad
    from pg_proc f
   where f.oid in ('company_os_api.trip_stop(text, uuid)'::regprocedure, 'ops.gate_trip_stop(text, uuid)'::regprocedure,
                   'ops.trip_stop_in_tenant(uuid, text, text, uuid)'::regprocedure)
     and pg_temp.code_only(f.prosrc) ~ '(clear|resume|untrip)';
  if v_bad is not null then
    raise exception 'P5b: the trip''s path names a clear: %', v_bad;
  end if;
  select string_agg(pg_temp.sig(f.oid), ', ') into v_bad
    from pg_proc f, lateral (select regexp_replace(pg_temp.code_only(f.prosrc), 'for\s+update', ' ', 'g') as code) b
   where f.oid = any (c_path)
     and (b.code ~ '(outbound|send|enqueue|_jobs?\M|\mjobs?\M|agent_runs?\M|whatsapp|crm_|public\.|email)'
          or b.code ~ '(^|[\s;])execute\s'
          or (f.oid <> all (c_writers) and b.code ~ '\m(insert|update|delete|truncate|merge|copy)\M'));
  if v_bad is not null then
    raise exception 'P5b: the act''s path names a send, an outbound row, a job, a run, a WhatsApp or CRM service, public, an email or dynamic SQL, or writes outside the authoritative operation: %', v_bad;
  end if;
end
$f$;

do $$
begin
  perform pg_temp.pin_catalogue();
  perform pg_temp.pin_exposed();
  perform pg_temp.pin_gates();
  perform pg_temp.pin_internal();
  perform pg_temp.pin_graph();
  perform pg_temp.pin_act_graph();
  perform pg_temp.pin_role();
  perform pg_temp.pin_k4();
  perform pg_temp.pin_k5();
  perform pg_temp.pin_default_acl();
  perform pg_temp.pin_role_closure();
end
$$;

-- ===========================================================================
-- X. DELIBERATE BREAKS. Each mutation, inside a subtransaction that is rolled
--    back, makes its pin fail by name.
-- ===========================================================================

create function pg_temp.expect_pin_failure(p_label text, p_mutation text, p_pin text, p_marker text)
returns void
language plpgsql as $f$
declare
  v_message text;
begin
  begin
    execute p_mutation;
    begin
      execute format('select %s()', p_pin);
      v_message := null;
    exception when others then
      v_message := sqlerrm;
    end;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_message is null then
    raise exception '%: % still passed after the mutation', p_label, p_pin;
  end if;
  if position(p_marker in v_message) <> 1 then
    raise exception '%: % failed for another reason: %', p_label, p_pin, v_message;
  end if;
end
$f$;

do $x$
begin
  perform pg_temp.expect_pin_failure('X1 authenticated made a member of ops_operator_api',
    'grant ops_operator_api to authenticated', 'pg_temp.pin_role', 'P6: ops_operator_api has a member');
  perform pg_temp.expect_pin_failure('X2 the migration identity left a member of ops_operator_api',
    'grant ops_operator_api to postgres', 'pg_temp.pin_role', 'P6: ops_operator_api has a member');
  perform pg_temp.expect_pin_failure('X3 EXECUTE on a projection granted to ops_operator_api',
    'grant execute on function ops.read_tasks(uuid, text, text, uuid, integer) to ops_operator_api',
    'pg_temp.pin_role', 'P6: ops_operator_api''s EXECUTE surface in ops is not exactly the gates');
  perform pg_temp.expect_pin_failure('X4 a gate calling a second callee',
    $m$create or replace function ops.gate_overview() returns pg_catalog.jsonb
       language plpgsql stable security definer set search_path = '' as $b$
       declare v record; r pg_catalog.jsonb;
       begin
         select * into v from ops.operator_scope();
         r := ops.read_overview(v.tenant_id) || ops.read_spend_summary(v.tenant_id);
         perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
         return r;
       end $b$$m$,
    'pg_temp.pin_gates', 'P3: a gate is not exactly');
  perform pg_temp.expect_pin_failure('X5 an exposed function recreated by the schema owner',
    $m$drop function company_os_api.overview();
       create function company_os_api.overview() returns pg_catalog.jsonb
       language sql stable security definer set search_path = '' as $b$ select ops.gate_overview() $b$$m$,
    'pg_temp.pin_exposed', 'P2: an exposed function is not');
  perform pg_temp.expect_pin_failure('X6 the resolver marked IMMUTABLE',
    'alter function ops.operator_scope() immutable', 'pg_temp.pin_internal', 'P4: an internal function');
  perform pg_temp.expect_pin_failure('X7 a gate''s search_path dropped',
    'alter function ops.gate_overview() reset search_path', 'pg_temp.pin_gates', 'P3: a gate is not exactly');
  perform pg_temp.expect_pin_failure('X8 a projection calling clear_execution_stop',
    $m$create or replace function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
       language plpgsql stable security invoker set search_path = '' as $b$
       begin
         perform ops.clear_execution_stop(pg_catalog.gen_random_uuid(), 'x', 'x');
         return pg_catalog.now();
       end $b$$m$,
    'pg_temp.pin_graph', 'P5: a graph body reaches beyond');
  perform pg_temp.expect_pin_failure('X9 an uncatalogued function in the exposed schema',
    $m$create function company_os_api.clear_probe() returns pg_catalog.jsonb
       language sql stable security definer set search_path = '' as $b$ select '{}'::pg_catalog.jsonb $b$$m$,
    'pg_temp.pin_catalogue', 'P1: ');
  perform pg_temp.expect_pin_failure('X10 a default privilege on ops',
    'alter default privileges in schema ops grant execute on functions to ops_operator_api',
    'pg_temp.pin_default_acl', 'P9: a default privilege reaches');
  perform pg_temp.expect_pin_failure('X11 a PUBLIC EXECUTE on a gate',
    'grant execute on function ops.gate_overview() to public', 'pg_temp.pin_gates', 'P3: a gate is not exactly');
  perform pg_temp.expect_pin_failure('X12 a new DEFINER function authenticated can execute',
    $m$create function public.cos_api_probe() returns int language sql security definer set search_path = '' as $b$ select 1 $b$;
       grant execute on function public.cos_api_probe() to authenticated$m$,
    'pg_temp.pin_k4', 'P7 (K4)');
  perform pg_temp.expect_pin_failure('X14 a projection reading auth.users, which only the resolver may',
    $m$create or replace function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
       language plpgsql stable security invoker set search_path = '' as $b$
       begin
         perform 1 from "auth" . "users" limit 1;
         return pg_catalog.now();
       end $b$$m$,
    'pg_temp.pin_graph', 'P5: a graph body names a schema outside its pinned set');
  perform pg_temp.expect_pin_failure('X15 a projection calling into pg_temp',
    $m$create or replace function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
       language plpgsql stable security invoker set search_path = '' as $b$
       begin
         perform pg_temp.id('tenant_a');
         return pg_catalog.now();
       end $b$$m$,
    'pg_temp.pin_graph', 'P5: a graph body names a schema outside its pinned set');
  -- The resolver's own allowance is exactly auth.sessions and auth.users. (A
  -- mutation whose anchor is missing changes nothing, so the pin would still
  -- pass and this check would fail, never pass vacuously.)
  perform pg_temp.expect_pin_failure('X16 the resolver reading an auth table besides sessions and users',
    regexp_replace(pg_get_functiondef('ops.operator_scope()'::regprocedure), 'perform 1 from auth\.sessions s',
                   'perform 1 from auth.identities i limit 1; perform 1 from auth.sessions s'),
    'pg_temp.pin_graph', 'P5: a graph body names a schema outside its pinned set');
  -- The pg_catalog way past the schema allowlist: a built-in that runs SQL
  -- text or reads a relation, a sequence, a file or a large object by name,
  -- written plain, schema-qualified, quoted, nested in another call, or after
  -- a comment whose apostrophe a naive string stripper would pair up.
  perform pg_temp.expect_pin_failure(format('X18 a projection calling %s', m.call),
    format($m$create or replace function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
       language plpgsql stable security invoker set search_path = '' as $b$
       begin
         -- the tenant's day
         perform %s;
         return pg_catalog.now(); -- it's the day's start
       end $b$$m$, m.call),
    'pg_temp.pin_graph', 'P5: a graph body runs SQL text or reads a relation, a sequence, a file or a large object by name')
    from (values ('query_to_xml(''select 1'', true, false, '''')'),
                 ('pg_catalog.coalesce_probe(pg_catalog.query_to_xmlschema(''select 1'', true, false, ''''))'),
                 ('pg_catalog.length("pg_catalog"."table_to_xml"(''ops.tasks''::pg_catalog.regclass, true, false, '''')::pg_catalog.text)'),
                 ('schema_to_xml(''ops'', true, false, '''')'),
                 ('database_to_xml(true, false, '''')'),
                 ('cursor_to_xml(null::pg_catalog.refcursor, 1, true, false, '''')'),
                 ('pg_read_file(''postmaster.opts'')'),
                 ('pg_catalog.pg_read_binary_file(''postmaster.opts'')'),
                 ('pg_ls_dir(''.'')'),
                 ('lo_get(1)'),
                 ('lo_export(1, ''/tmp/x'')'),
                 ('ts_stat(''select 1'')'),
                 ('currval(''ops.events_seq_seq'')'),
                 ('pg_catalog.pg_sequence_last_value(''ops.events_seq_seq'')')) as m (call);
  perform pg_temp.expect_pin_failure(format('X19 a projection reading %s', m.rel),
    format($m$create or replace function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
       language plpgsql stable security invoker set search_path = '' as $b$
       begin
         perform 1 from %s limit 1;
         return pg_catalog.now();
       end $b$$m$, m.rel),
    'pg_temp.pin_graph', 'P5: a graph body reads a system catalog')
    from (values ('pg_statistic'), ('pg_catalog.pg_stat_activity'), ('"pg_catalog"."pg_locks"')) as m (rel);
  perform pg_temp.expect_pin_failure('X20 a projection calling set_config',
    $m$create or replace function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
       language plpgsql stable security invoker set search_path = '' as $b$
       begin
         perform pg_catalog.set_config('role', 'ops_worker', true);
         return pg_catalog.now();
       end $b$$m$,
    'pg_temp.pin_graph', 'P5: a graph body calls a volatile built-in');
  perform pg_temp.expect_pin_failure('X21 a paged read left to the plan cache''s generic plan (section E)',
    'alter function ops.read_tasks(uuid, text, text, uuid, integer) reset plan_cache_mode',
    'pg_temp.pin_internal', 'P4: an internal function');
  perform pg_temp.expect_pin_failure('X22 the act''s callee inserting an outbound row',
    $m$create or replace function ops.decide_review_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                        p_review_id pg_catalog.uuid, p_decision pg_catalog.text)
       returns pg_catalog.jsonb language plpgsql volatile security invoker set search_path = '' as $b$
       begin
         insert into ops.outbound_messages default values;
         return ops.record_review_decision(p_tenant_id, p_review_id, p_decision, p_actor, 'company-os-ui', null);
       end $b$$m$,
    'pg_temp.pin_act_graph', 'P5b: the act''s path names');
  perform pg_temp.expect_pin_failure('X23 the act''s callee asking for send eligibility',
    $m$create or replace function ops.decide_review_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                        p_review_id pg_catalog.uuid, p_decision pg_catalog.text)
       returns pg_catalog.jsonb language plpgsql volatile security invoker set search_path = '' as $b$
       begin
         perform ops.whatsapp_send_eligibility(p_tenant_id, p_review_id);
         return ops.record_review_decision(p_tenant_id, p_review_id, p_decision, p_actor, 'company-os-ui', null);
       end $b$$m$,
    'pg_temp.pin_act_graph', 'P5b: the act''s callee reaches beyond');
  perform pg_temp.expect_pin_failure('X24 the trip''s callee clearing a stop',
    $m$create or replace function ops.trip_stop_in_tenant(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                    p_scope pg_catalog.text, p_target_id pg_catalog.uuid)
       returns pg_catalog.jsonb language plpgsql volatile security invoker set search_path = '' as $b$
       begin
         perform ops.clear_execution_stop(p_target_id, 'x', p_actor);
         return pg_catalog.jsonb_build_object('v', 1);
       end $b$$m$,
    'pg_temp.pin_act_graph', 'P5b: the trip''s callee reaches beyond');
  perform pg_temp.expect_pin_failure('X25 the trip gate''s S0-B lock_timeout dropped',
    'alter function ops.gate_trip_stop(text, uuid) reset lock_timeout', 'pg_temp.pin_gates', 'P3: a gate is not exactly');
end
$x$;

-- X13. The 42501 backstop, exercised as the role itself: the suite makes
--      itself a member inside a rolled-back subtransaction (a literal grantee,
--      never current_user: owner decision S0-F), creates an exposed function
--      whose body reads a table, and a member calling it is refused by the
--      database, not by a test; the role reads no table and runs no
--      projection directly either.
do $$
declare
  v_via_api jsonb;
  v_tenant  uuid;
  v_table   text;
  v_fn      text;
begin
  begin
    v_tenant := pg_temp.id('tenant_a');
    grant ops_operator_api to postgres;
    grant create on schema company_os_api to ops_operator_api;
    set local role ops_operator_api;
    create function company_os_api.probe_tasks() returns bigint
    language sql stable security definer set search_path = '' as $b$ select count(*) from ops.tasks $b$;
    begin
      perform count(*) from ops.tasks;
      v_table := 'read';
    exception when insufficient_privilege then
      v_table := sqlerrm;
    end;
    begin
      perform ops.read_tasks(v_tenant, null, null, null, 1);
      v_fn := 'ran';
    exception when insufficient_privilege then
      v_fn := sqlerrm;
    end;
    reset role;
    -- As a member of the owner, as the migration's own grants are made.
    grant execute on function company_os_api.probe_tasks() to authenticated;
    v_via_api := pg_temp.api(pg_temp.claims('m_a'), 'company_os_api.probe_tasks()');
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_table is distinct from 'permission denied for table tasks'
     or v_fn is distinct from 'permission denied for function read_tasks'
     or v_via_api ->> 'code' is distinct from '42501' or v_via_api ->> 'message' <> 'permission denied for table tasks' then
    raise exception 'X13: ops_operator_api reached ops data outside its gates (table: %, projection: %, exposed body: %)',
      v_table, v_fn, v_via_api;
  end if;
  if exists (select 1 from pg_auth_members where roleid = 'ops_operator_api'::regrole)
     or exists (select 1 from pg_proc where proname = 'probe_tasks') then
    raise exception 'X13: the probe''s membership or function outlived its subtransaction';
  end if;
end
$$;

-- X17. list_events' subject check fails closed: a subject type that the type
--      check admits but the existence check does not name answers the gate's
--      fixed not found, never a page (the CASE's else false). The type check
--      is widened by one type inside a subtransaction that is rolled back.
do $$
declare
  v_def  text := pg_get_functiondef('ops.read_events(uuid, text, text, uuid, integer)'::regprocedure);
  v_wide text;
  v      jsonb;
begin
  v_wide := replace(v_def, '''department'', ''agent'') then', '''department'', ''agent'', ''job'') then');
  if v_wide = v_def then
    raise exception 'X17: the subject type check was not found, so the probe would prove nothing';
  end if;
  begin
    execute v_wide;
    v := pg_temp.api(pg_temp.claims('m_a'),
      format('company_os_api.list_events(p_subject_type => ''job'', p_subject_id => %L)', pg_temp.id('a.task_plain')));
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v ->> 'code' is distinct from 'OS404' or v ->> 'message' is distinct from 'company_os_api.list_events: not found' then
    raise exception 'X17: a subject type the existence check does not name answered %', v;
  end if;
  if pg_get_functiondef('ops.read_events(uuid, text, text, uuid, integer)'::regprocedure) <> v_def then
    raise exception 'X17: the widened subject check outlived its subtransaction';
  end if;
end
$$;

-- ===========================================================================
-- V. THE ONE ACT: decide_review (S7.1; brief §9 row 16, §7.5; SI-45).
--    A member decides an open review of their own tenant, once. The decision
--    goes through ops.record_review_decision, with the principal as the
--    reviewer and company-os-ui as the source, and NOTHING IS SENT: no
--    outbound row, no job, no run, no communication event. A foreign or
--    missing review answers alike and writes nothing; a review outside the
--    synthetic and test scope (BASELINE Q8), of another capability, or of a
--    do-not-contact lead when accepting, is refused and unchanged; a decided
--    review is final. The identity shapes are refused first (section I).
-- ===========================================================================

-- Fresh pending reviews on the synthetic task a.task_ok, so no other section's
-- fixture changes state.
create temporary table cos_act (name text primary key, id uuid not null) on commit drop;

do $$
declare
  t  uuid := pg_temp.id('tenant_a');
  co uuid := (select r.company_id from ops.review_items r where r.id = pg_temp.id('a.review_ok'));
  n  text;
begin
  foreach n in array array['accept', 'reject', 'needs_edit', 'repeat', 'other_reviewer', 'dnc'] loop
    with created as (
      insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
      values (t, co, pg_temp.id('a.task_ok'), gen_random_uuid(), 'lead_triage', pg_temp.triage_result('a'), n = 'dnc')
      returning id)
    insert into cos_act select n, created.id from created;
  end loop;
end
$$;

-- The state of everything a decision must not touch, and its change since.
create function pg_temp.act_untouched() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'outbound', (select count(*) from ops.outbound_messages),
    'jobs', (select count(*) from ops.jobs),
    'runs', (select count(*) from ops.agent_runs),
    'tasks', (select count(*) from ops.tasks),
    'communication', (select count(*) from ops.events e where e.type like 'communication.%'));
$$;

-- V1. accepted, rejected and needs_edit, each once, as the principal, with
--     one event from company-os-ui; the response is exactly the pinned shape.
do $$
declare
  v_before   jsonb := pg_temp.act_untouched();
  v_reviewer text := 'principal:' || pg_temp.id('principal.m_a');
  c          record;
  v          jsonb;
  v_id       uuid;
  v_item     ops.review_items;
begin
  for c in select * from (values ('accept', 'accepted'), ('reject', 'rejected'), ('needs_edit', 'needs_edit'))
             as x (name, decision) loop
    v_id := (select a.id from cos_act a where a.name = c.name);
    v := pg_temp.member_body('V1', format('company_os_api.decide_review(%L, %L)', v_id, c.decision));
    if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
         array['asOf', 'recorded', 'reviewItemId', 'status', 'v']
       or v ->> 'status' <> c.decision or (v ->> 'recorded')::boolean is not true
       or (v ->> 'reviewItemId')::uuid <> v_id or (v ->> 'v')::int <> 1 then
      raise exception 'V1: % answered %', c.name, v;
    end if;
    select * into v_item from ops.review_items r where r.id = v_id;
    if v_item.status <> c.decision or v_item.reviewer <> v_reviewer or v_item.decision_note is not null
       or v_item.reviewed_at is null then
      raise exception 'V1: % recorded status %, reviewer %, note %', c.name, v_item.status, v_item.reviewer,
        v_item.decision_note;
    end if;
    if (select count(*) from ops.events e
         where e.type = 'lead_triage.reviewed' and e.source = 'company-os-ui'
           and e.payload ->> 'review_item_id' = v_id::text and e.payload ->> 'decision' = c.decision) <> 1 then
      raise exception 'V1: % did not write exactly one lead_triage.reviewed event from company-os-ui', c.name;
    end if;
  end loop;
  -- Accepting is not sending (SI-45): no outbound row, job, run, task or
  -- communication event came from any of the three decisions.
  if pg_temp.act_untouched() is distinct from v_before then
    raise exception 'V1: a decision touched the send path or the runtime: before %, after %',
      v_before, pg_temp.act_untouched();
  end if;
end
$$;

-- V2. Final once: the same principal repeating the same decision is answered
--     as already recorded, with no second event; any other decision, and the
--     same decision by another principal, is OS409, and nothing changes.
do $$
declare
  v_id     uuid := (select a.id from cos_act a where a.name = 'repeat');
  v_other  uuid := (select a.id from cos_act a where a.name = 'other_reviewer');
  v        jsonb;
  v_events bigint;
begin
  perform pg_temp.member_body('V2', format('company_os_api.decide_review(%L, %L)', v_id, 'rejected'));
  v_events := (select count(*) from ops.events e where e.payload ->> 'review_item_id' = v_id::text);
  v := pg_temp.member_body('V2', format('company_os_api.decide_review(%L, %L)', v_id, 'rejected'));
  if v ->> 'status' <> 'rejected' or (v ->> 'recorded')::boolean is not false
     or (select count(*) from ops.events e where e.payload ->> 'review_item_id' = v_id::text) <> v_events then
    raise exception 'V2: repeating the same decision was not answered as already recorded: %', v;
  end if;
  v := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.decide_review(%L, %L)', v_id, 'accepted'));
  if v is distinct from pg_temp.refusal('decide_review', 'OS409') then
    raise exception 'V2: changing a decided review answered %', v;
  end if;
  perform pg_temp.member_body('V2', format('company_os_api.decide_review(%L, %L)', v_other, 'needs_edit'));
  v := pg_temp.api(pg_temp.claims('banned_past'), format('company_os_api.decide_review(%L, %L)', v_other, 'needs_edit'));
  if v is distinct from pg_temp.refusal('decide_review', 'OS409') then
    raise exception 'V2: the same decision by another principal answered %', v;
  end if;
  if (select r.status || '/' || r.reviewer from ops.review_items r where r.id = v_other)
     <> 'needs_edit/principal:' || pg_temp.id('principal.m_a') then
    raise exception 'V2: another principal''s refused decision changed the review';
  end if;
end
$$;

-- The act's fixed refusal for a SQLSTATE: one data-free message, as every gate.
create function pg_temp.act_refusal(p_code text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message',
           'company_os_api.decide_review: ' || case p_code when 'OS400' then 'bad request' when 'OS401' then 'not signed in'
             when 'OS403' then 'no access' when 'OS404' then 'not found' when 'OS409' then 'conflict' end,
           'detail', '', 'hint', '');
$$;

-- V3. Refusals that write nothing: a do-not-contact lead cannot be accepted
--     (OS403; it can still be rejected); a review of another capability, of a
--     task no admission created, or of a WhatsApp line no longer in test mode
--     (BASELINE Q8) is OS403; a foreign review answers exactly like a random
--     uuid (OS404); a decision outside the vocabulary is OS400.
do $$
declare
  v_before jsonb := pg_temp.act_untouched();
  v_dnc    uuid := (select a.id from cos_act a where a.name = 'dnc');
  c        record;
  v        jsonb;
  v_rows   jsonb;
begin
  v_rows := (select jsonb_agg(to_jsonb(r) order by r.id) from ops.review_items r);
  for c in select * from (values
      ('a do-not-contact lead, accepted', v_dnc, 'accepted', 'OS403'),
      ('another capability', pg_temp.id('a.review_capability'), 'rejected', 'OS403'),
      ('a task no admission created', pg_temp.id('a.review_no_admission'), 'rejected', 'OS403'),
      ('a WhatsApp line no longer in test mode', pg_temp.id('a.review_prod'), 'rejected', 'OS403'),
      ('a review of tenant B', pg_temp.id('b.review_ok'), 'rejected', 'OS404'),
      ('a decided review of tenant B', pg_temp.id('b.review_accepted'), 'accepted', 'OS404'),
      ('a random uuid', gen_random_uuid(), 'rejected', 'OS404'),
      ('a decision outside the vocabulary', pg_temp.id('a.review_ok'), 'approved', 'OS400'),
      ('no decision', pg_temp.id('a.review_ok'), null, 'OS400')
    ) as x (label, review_id, decision, code) loop
    v := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.decide_review(%L, %L)', c.review_id, c.decision));
    if v is distinct from pg_temp.act_refusal(c.code) then
      raise exception 'V3: % answered %, not %', c.label, v, pg_temp.act_refusal(c.code);
    end if;
  end loop;
  if (select jsonb_agg(to_jsonb(r) order by r.id) from ops.review_items r) is distinct from v_rows
     or pg_temp.act_untouched() is distinct from v_before then
    raise exception 'V3: a refused decision changed a review or the send path';
  end if;
  -- The do-not-contact lead can still be rejected.
  perform pg_temp.member_body('V3', format('company_os_api.decide_review(%L, %L)', v_dnc, 'rejected'));
end
$$;

-- V5. What the screen offers is what the act accepts: get_review lists no
--     decision for a review outside the synthetic and test scope or of another
--     capability, no acceptance for a do-not-contact lead, and all three for
--     an open synthetic review (ops.cos_review_decidable, shared by both).
do $$
declare
  c record;
  v jsonb;
begin
  with created as (
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
    select r.tenant_id, r.company_id, r.task_id, gen_random_uuid(), 'lead_triage', pg_temp.triage_result('a'), dnc
      from ops.review_items r, (values (false), (true)) as x (dnc)
     where r.id = pg_temp.id('a.review_ok')
    returning id, do_not_contact)
  insert into cos_act
  select case when created.do_not_contact then 'open_dnc' else 'open' end, created.id from created;
  for c in select * from (values
      ('another capability', pg_temp.id('a.review_capability'), '[]'),
      ('a task no admission created', pg_temp.id('a.review_no_admission'), '[]'),
      ('a WhatsApp line no longer in test mode', pg_temp.id('a.review_prod'), '[]'),
      ('an open do-not-contact synthetic review', (select a.id from cos_act a where a.name = 'open_dnc'),
       '["rejected", "needs_edit"]'),
      ('an open synthetic review', (select a.id from cos_act a where a.name = 'open'),
       '["accepted", "rejected", "needs_edit"]')
    ) as x (label, review_id, expected) loop
    v := pg_temp.member_body('V5', format('company_os_api.get_review(%L)', c.review_id));
    if v -> 'allowedDecisions' is distinct from c.expected::jsonb then
      raise exception 'V5: % lists %, not %', c.label, v -> 'allowedDecisions', c.expected;
    end if;
  end loop;
end
$$;

-- V4. No other role reaches the act's path: anon and service_role cannot call
--     it, and no application role executes the callee, the gate or the
--     authoritative operation directly.
do $$
declare
  v    jsonb;
  r    text;
  f    text;
begin
  foreach r in array array['anon', 'service_role'] loop
    v := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.decide_review(%L, %L)', gen_random_uuid(), 'rejected'), r);
    if (v ->> 'ok')::boolean or v ->> 'code' <> '42501' then
      raise exception 'V4: % reached decide_review: %', r, v;
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway'] loop
    foreach f in array array['ops.decide_review_as_member(uuid, text, uuid, text)', 'ops.gate_decide_review(uuid, text)',
                             'ops.record_review_decision(uuid, uuid, text, text, text, text)'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'V4: % can execute %', r, f;
      end if;
    end loop;
  end loop;
end
$$;

-- ===========================================================================
-- W. THE SECOND ACT: trip_stop (S7.2; brief §9 row 17 and the trip
--    coordinates table; owner decision S0-B; SI-58).
--    A member trips an execution stop at tenant, company, department or agent
--    scope of their own tenant: always through the authoritative
--    ops.trip_execution_stop, with the principal as the actor, a fixed server
--    reason and origin owner, and the coordinates the brief fixes. A repeat is
--    already_stopped with the same stop and nothing new; a global or job_kind
--    stop is OS403; a foreign or missing target answers like a random uuid;
--    nothing is cleared, no event is written, and nothing else moves. The
--    identity shapes are refused first (section I).
-- ===========================================================================

-- Fresh targets in tenant A, so no fixture's own stop answers for them.
create temporary table cos_trip (name text primary key, id uuid) on commit drop;

do $$
declare
  t  uuid := pg_temp.id('tenant_a');
  co uuid;
  d  uuid;
begin
  co := ops.create_company(t, 'trip-clinic', 'Trip Clinic', 'cos-api-suite');
  d := ops.create_department(t, co, 'trip-desk', 'Trip Desk', 'cos-api-suite');
  insert into cos_trip values
    ('company', co),
    ('department', d),
    ('agent', ops.create_agent(t, co, d, 'trip-agent', 'Trip Agent', 'Synthetic role', 'cos-api-suite',
                               'Synthetic agent a member stops'));
  -- Tenant A's own tenant stop was cleared by its fixture: none is active.
  if exists (select 1 from ops.execution_stops s
              where s.tenant_id = t and s.scope = 'tenant' and s.cleared_at is null) then
    raise exception 'W: tenant A already holds an active tenant stop, so W1 would prove less than it claims';
  end if;
end
$$;

-- What a trip must not touch, beyond ops.execution_stops.
create function pg_temp.trip_untouched() returns jsonb
language sql stable as $$
  select pg_temp.act_untouched() || jsonb_build_object(
    'events', (select count(*) from ops.events),
    'cleared', (select count(*) from ops.execution_stops s where s.cleared_at is not null),
    'reviews', (select jsonb_agg(to_jsonb(r) order by r.id) from ops.review_items r));
$$;

-- W1. Each scope, once, as the principal: the authoritative row with the
--     brief's coordinates, the fixed reason, origin owner; the pinned response
--     shape; and nothing else moves (no event, no clear, no job, run, task,
--     outbound row or review change).
do $$
declare
  t         uuid := pg_temp.id('tenant_a');
  v_before  jsonb := pg_temp.trip_untouched();
  v_actor   text := 'principal:' || pg_temp.id('principal.m_a');
  c         record;
  v         jsonb;
  v_stop    ops.execution_stops;
begin
  for c in select * from (values
      ('tenant', null::uuid, null::uuid, null::uuid, null::uuid),
      ('company', (select id from cos_trip where name = 'company'),
       (select id from cos_trip where name = 'company'), null, null),
      ('department', (select id from cos_trip where name = 'department'),
       (select id from cos_trip where name = 'company'), (select id from cos_trip where name = 'department'), null),
      ('agent', (select id from cos_trip where name = 'agent'),
       (select id from cos_trip where name = 'company'), null, (select id from cos_trip where name = 'agent'))
    ) as x (scope, target, company, department, agent) loop
    v := pg_temp.member_body('W1', format('company_os_api.trip_stop(%L, %L)', c.scope, c.target));
    if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
         array['asOf', 'outcome', 'stopId', 'v']
       or v ->> 'outcome' <> 'stopped' or (v ->> 'v')::int <> 1 then
      raise exception 'W1: % answered %', c.scope, v;
    end if;
    select * into v_stop from ops.execution_stops s where s.id = (v ->> 'stopId')::uuid;
    if v_stop.scope <> c.scope or v_stop.tenant_id <> t
       or v_stop.company_id is distinct from c.company or v_stop.department_id is distinct from c.department
       or v_stop.agent_id is distinct from c.agent or v_stop.job_kind is not null
       or v_stop.tripped_by <> v_actor or v_stop.origin <> 'owner'
       or v_stop.reason <> 'owner requested execution stop via Company OS' or v_stop.cleared_at is not null then
      raise exception 'W1: % recorded %', c.scope, to_jsonb(v_stop);
    end if;
    insert into cos_trip values ('stop:' || c.scope, v_stop.id);
  end loop;
  if pg_temp.trip_untouched() is distinct from v_before then
    raise exception 'W1: a trip touched something beyond its stop: before %, after %', v_before, pg_temp.trip_untouched();
  end if;
end
$$;

-- W2. A repeat by another member is already_stopped: the same stop, no new
--     row, nothing cleared. (This file is ONE transaction, so the same
--     principal repeating here would share now() and read as recorded; that
--     case, across real transactions, is engine/domain/
--     companyOsExecutionStop.dbtest.ts.) The member's own read of the stops
--     shows each trip and never an actor label.
do $$
declare
  v_rows bigint := (select count(*) from ops.execution_stops);
  c      record;
  v      jsonb;
begin
  for c in select * from (values ('banned_past', 'agent'), ('banned_past', 'tenant')) as x (who, scope) loop
    v := pg_temp.api(pg_temp.claims(c.who),
           format('company_os_api.trip_stop(%L, %L)', c.scope, (select id from cos_trip where name = c.scope)));
    if not (v ->> 'ok')::boolean or v -> 'body' ->> 'outcome' <> 'already_stopped'
       or (v -> 'body' ->> 'stopId')::uuid <> (select id from cos_trip where name = 'stop:' || c.scope) then
      raise exception 'W2: % repeating the % trip answered %', c.who, c.scope, v;
    end if;
  end loop;
  if (select count(*) from ops.execution_stops) <> v_rows then
    raise exception 'W2: a repeated trip wrote a new stop';
  end if;
  v := pg_temp.member_body('W2', 'company_os_api.list_stops()');
  if not (v -> 'items' @> jsonb_build_array(jsonb_build_object('id', (select id from cos_trip where name = 'stop:agent'))))
     or v::text ~ 'principal:' then
    raise exception 'W2: the member''s stops do not show the trip, or show an actor label';
  end if;
end
$$;

-- W3. Refusals that write nothing: a global or job_kind stop (OS403); any
--     other scope, a tenant stop with a target, an organisational stop without
--     one (OS400); another tenant's company, department or agent, and a random
--     uuid, all the same OS404.
do $$
declare
  v_before jsonb := pg_temp.trip_untouched();
  v_rows   bigint := (select count(*) from ops.execution_stops);
  c        record;
  v        jsonb;
begin
  for c in select * from (values
      ('a global stop', 'global', null::uuid, 'OS403'),
      ('a job_kind stop', 'job_kind', null, 'OS403'),
      ('a scope outside the vocabulary', 'bogus', null, 'OS400'),
      ('no scope', null, null, 'OS400'),
      ('a tenant stop naming a target', 'tenant', pg_temp.id('b.company'), 'OS400'),
      ('a company stop without a target', 'company', null, 'OS400'),
      ('tenant B''s company', 'company', pg_temp.id('b.company'), 'OS404'),
      ('tenant B''s department', 'department', pg_temp.id('b.department'), 'OS404'),
      ('tenant B''s agent', 'agent', pg_temp.id('b.agent_triage'), 'OS404'),
      ('a department id named as a company', 'company', pg_temp.id('a.department'), 'OS404'),
      ('a random uuid', 'agent', gen_random_uuid(), 'OS404')
    ) as x (label, scope, target, code) loop
    v := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.trip_stop(%L, %L)', c.scope, c.target));
    if v is distinct from jsonb_build_object('ok', false, 'code', c.code, 'message',
         'company_os_api.trip_stop: ' || case c.code when 'OS400' then 'bad request' when 'OS403' then 'no access'
                                                     when 'OS404' then 'not found' end,
         'detail', '', 'hint', '') then
      raise exception 'W3: % answered %', c.label, v;
    end if;
  end loop;
  if (select count(*) from ops.execution_stops) <> v_rows or pg_temp.trip_untouched() is distinct from v_before then
    raise exception 'W3: a refused trip changed a stop or anything else';
  end if;
end
$$;

-- W4. No other role reaches the trip's path, and nothing any browser-facing
--     role can run clears a stop.
do $$
declare
  v jsonb;
  r text;
  f text;
begin
  foreach r in array array['anon', 'service_role'] loop
    v := pg_temp.api(pg_temp.claims('m_a'), 'company_os_api.trip_stop(''tenant'')', r);
    if (v ->> 'ok')::boolean or v ->> 'code' <> '42501' then
      raise exception 'W4: % reached trip_stop: %', r, v;
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    foreach f in array array['ops.trip_stop_in_tenant(uuid, text, text, uuid)',
                             'ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid, text)',
                             'ops.clear_execution_stop(uuid, text, text)'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'W4: % can execute %', r, f;
      end if;
    end loop;
    if r <> 'ops_operator_api' and has_function_privilege(r, 'ops.gate_trip_stop(text, uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'W4: % can execute the trip gate', r;
    end if;
    if has_table_privilege(r, 'ops.execution_stops', 'INSERT,UPDATE,DELETE,TRUNCATE') then
      raise exception 'W4: % can write ops.execution_stops directly', r;
    end if;
  end loop;
  v := pg_temp.member_body('W4', 'company_os_api.operator_context()');
  if v -> 'allowedActions' is distinct from '{"decideReview": true, "tripStop": true, "viewAdvice": true}'::jsonb then
    raise exception 'W4: operator_context reports %', v -> 'allowedActions';
  end if;
end
$$;


rollback;

-- ---------------------------------------------------------------------------
-- After the rollback: nothing survived, and the global sequences, the
-- one-active-membership index and the capability role are as they were.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'cos-api-test-%')
     or exists (select 1 from ops.principals where display_name like 'Sentinel Display %')
     or exists (select 1 from auth.users where email like 'Sentinel.Cos.%')
     or exists (select 1 from ops.model_prices where model = 'cos-api-model-7') then
    raise exception 'company_os_api.sql left fixtures behind';
  end if;
  if (select last_value from ops.events_seq_seq) >= 9876543210000
     or (select last_value from ops.job_events_id_seq) >= 8765432100000 then
    raise exception 'company_os_api.sql left a global sequence restarted';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'ops' and indexname = 'tenant_memberships_one_active')
     or exists (select 1 from pg_auth_members where roleid = 'ops_operator_api'::regrole or member = 'ops_operator_api'::regrole) then
    raise exception 'company_os_api.sql left the membership index dropped or ops_operator_api with a member';
  end if;
end
$$;
