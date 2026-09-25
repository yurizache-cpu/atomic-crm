-- Phase 1D.1 — runtime governance, attacked against the real database.
--
-- Run with `npm run test:db` (scripts/run-db-tests.mjs). What it proves, against the
-- functions and guards 20260917120000_runtime_governance.sql ships (ADR 0017):
--
--   R  The READ COMMITTED premise: the lease, the request, the start and spend
--      admission refuse to run under any other isolation level.
--   W  Lock witnesses: the lease, the pre-call check and the deferral take the
--      kill-switch lock shared; admission takes the three spend locks exclusively;
--      a settlement that raises a charge takes them, and one that lowers it does not.
--   P  Prices: versioned, immutable, exact, expiring, and chosen with no fallback.
--   C  Cost: the estimate and reservation arithmetic, and the charge the update guard
--      derives on every write path, including a raw owner UPDATE.
--   L  Limits: versioned, superseded, retired, never rewritten, and reported.
--   A  Admission: absence refuses; exhaustion is recorded and names its limit;
--      contention records nothing; the window is the limit's own day.
--   K  The kill switch: the job_kind scope, the stop origin, the lease-time hold for
--      every non-internal kind, unknown coordinates failing closed, and the
--      pre-call check and deferral capabilities.
--   E  The ceiling sweep: trips on settled spend only, never clears.
--   I  Idempotent domain creates: ops.create_task and ops.record_event.
--   G  Grants and surface: no application role reaches prices, limits or the new
--      owner services; the three new worker capabilities are narrow.
--
-- ONE TRANSACTION, ROLLED BACK, as in agent_runtime.sql, after two short premise
-- transactions that are rolled back too. A lease taken here expires at now() + 60 s,
-- and the run capabilities judge it on the wall clock, so the whole suite must finish
-- well inside 60 s. Every price here is synthetic and every limit is set inside the
-- rolled-back transaction: no price or limit ever survives this file.

\set ON_ERROR_STOP on

-- ===========================================================================
-- R. THE READ COMMITTED PREMISE. Admission and the kill switch read what a lock
--    serialised, which only a fresh statement snapshot sees. Under REPEATABLE READ
--    every entry point that relies on that refuses before it writes anything.
-- ===========================================================================
begin isolation level repeatable read;

do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

do $$
declare
  v_tenant     uuid;
  v_company    uuid;
  v_department uuid;
  v_agent      uuid;
  v_task       uuid;
  v_run        uuid;
  v_job        uuid;
  v_call       record;
  v_state      text;
  v_message    text;
  v_tried      integer := 0;
begin
  if current_setting('transaction_isolation') <> 'repeatable read' then
    raise exception 'R1: the premise block is not running under REPEATABLE READ; it would prove nothing';
  end if;

  insert into ops.tenants (slug, name) values ('rg1d-test-isolation', 'RG1D Isolation') returning id into v_tenant;
  v_company := ops.create_company(v_tenant, 'iso-one', 'Iso One', 'rg1d-test');
  v_department := ops.create_department(v_tenant, v_company, 'operations', 'Operations', 'rg1d-test');
  v_agent := ops.create_agent(v_tenant, v_company, v_department, 'analyst', 'Analyst', 'Work reviewer', 'rg1d-test');
  v_task := ops.create_task(v_tenant, v_company, 'work.review', 'Review under repeatable read', 'rg1d-test');
  perform ops.assign_task(v_tenant, v_task, v_agent, 'rg1d-test');

  -- A pending run and its job, built without ops.request_agent_run, which is itself
  -- refused here; and a lease installed by hand, because ops.lease_job is too.
  perform set_config('app.event_source', 'rg1d-raw', true);
  insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                              idempotency_key, request_fingerprint, correlation_id, requested_by)
  values (v_tenant, v_company, v_department, v_task, v_agent, 'task_assessment', 'standard',
          'rg1d-iso-run', repeat('a', 64), gen_random_uuid(), 'rg1d-raw')
  returning id into v_run;
  perform set_config('app.event_source', '', true);
  v_job := ops.request_task_execution(v_tenant, v_task, 'agent_run.execute', 'rg1d-test',
                                      jsonb_build_object('agent_run_id', v_run));
  update ops.jobs
     set status = 'leased', lease_owner = 'rg1d-worker-iso', leased_at = now(),
         lease_expires_at = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now()
   where id = v_job;
  perform set_config('app.worker_id', 'rg1d-worker-iso', true);
  perform set_config('app.job_id', v_job::text, true);

  for v_call in
    select * from (values
      ('ops.spend_admission', 'postgres',
       format('select ops.spend_admission(%L, %L, 0, false)', v_tenant, v_company)),
      ('ops.spend_admission taking its locks', 'postgres',
       format('select ops.spend_admission(%L, %L, 0, true)', v_tenant, v_company)),
      ('ops.request_agent_run', 'postgres',
       format($q$select ops.request_agent_run(%L, %L, %L, 'task_assessment', 'rg1d-iso-request', 'rg1d-test')$q$,
              v_tenant, v_task, v_agent)),
      ('ops.start_agent_run', 'ops_worker',
       $q$select ops.start_agent_run('fake', 'rg1d-model', 'task_assessment.v1', repeat('f', 64), 8000)$q$),
      -- Last: the lease clears the lease context, which the start above needs.
      ('ops.lease_job', 'ops_worker', $q$select ops.lease_job('rg1d-worker-iso-two', 60)$q$)
    ) as c (label, role_name, statement)
  loop
    v_tried := v_tried + 1;
    v_state := null;
    begin
      if v_call.role_name = 'ops_worker' then
        execute 'set local role ops_worker';
      end if;
      execute v_call.statement;
      raise exception using errcode = 'C1CAC', message = 'accepted';
    exception when others then
      v_state := sqlstate;
      v_message := sqlerrm;
    end;
    if v_state is distinct from 'OS400' or strpos(v_message, 'READ COMMITTED') = 0 then
      raise exception 'R1: % ran under REPEATABLE READ instead of refusing (% %)', v_call.label, v_state, v_message;
    end if;
  end loop;
  if v_tried <> 5 then
    raise exception 'R1: % premise attempts ran, expected 5; a case was lost', v_tried;
  end if;

  if (select r.status from ops.agent_runs r where r.id = v_run) <> 'pending'
     or exists (select 1 from ops.agent_runs r where r.tenant_id = v_tenant and r.id <> v_run) then
    raise exception 'R1: a call refused under REPEATABLE READ still wrote a run';
  end if;
end
$$;

rollback;

begin isolation level serializable;
do $$
declare
  v_state text;
  v_message text;
begin
  begin
    perform ops.lease_job('rg1d-worker-serializable', 60);
    raise exception using errcode = 'C1CAC', message = 'accepted';
  exception when others then
    v_state := sqlstate;
    v_message := sqlerrm;
  end;
  if v_state is distinct from 'OS400' or strpos(v_message, 'READ COMMITTED') = 0 then
    raise exception 'R2: ops.lease_job ran under SERIALIZABLE instead of refusing (% %)', v_state, v_message;
  end if;
end
$$;
rollback;

-- ===========================================================================
-- The main transaction.
-- ===========================================================================
begin;

-- Membership is needed to `set role ops_worker`; interpolate (see ops_execution_core.sql).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Helpers. Temporary, so they vanish with the transaction.
-- ---------------------------------------------------------------------------

-- Runs one statement and requires it to fail with exactly this SQLSTATE.
create function pg_temp.expect_refused(p_label text, p_sqlstate text, p_sql text)
returns void
language plpgsql
as $f$
declare
  v_state text;
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
  if v_state <> p_sqlstate then
    raise exception '%: expected SQLSTATE %, got % (%)', p_label, p_sqlstate, v_state, v_message;
  end if;
end
$f$;

-- The same, and the message must carry a fragment.
create function pg_temp.expect_refused_with(p_label text, p_sqlstate text, p_fragment text, p_sql text)
returns void
language plpgsql
as $f$
declare
  v_state text;
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
  if v_state <> p_sqlstate or strpos(v_message, p_fragment) = 0 then
    raise exception '%: expected SQLSTATE % with "%", got % (%)', p_label, p_sqlstate, p_fragment, v_state, v_message;
  end if;
end
$f$;

-- The same, with one guard trigger switched off for the attempt, to prove the
-- structural backstop behind it. The DISABLE is rolled back with the attempt.
create function pg_temp.expect_refused_without_trigger(
  p_label text, p_sqlstate text, p_table text, p_trigger text, p_sql text)
returns void
language plpgsql
as $f$
declare
  v_state text;
  v_message text;
begin
  begin
    execute format('alter table ops.%I disable trigger %I', p_table, p_trigger);
    execute p_sql;
    raise exception using errcode = 'C1CAC', message = 'accepted';
  exception when others then
    v_state := sqlstate;
    v_message := sqlerrm;
  end;
  if v_state = 'C1CAC' then
    raise exception '%: ACCEPTED with trigger % off, expected SQLSTATE %', p_label, p_trigger, p_sqlstate;
  end if;
  if v_state <> p_sqlstate then
    raise exception '%: expected SQLSTATE % with trigger % off, got % (%)', p_label, p_sqlstate, p_trigger, v_state, v_message;
  end if;
end
$f$;

-- NULL when the statement is accepted (its effects kept), else its SQLSTATE and message.
create function pg_temp.attempt(p_sql text)
returns text
language plpgsql
as $f$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

-- NULL when a role is refused a statement at the privilege layer; otherwise what
-- happened instead. The role switch lives in the rolled-back subtransaction.
create function pg_temp.privilege_leak(p_role text, p_sql text)
returns text
language plpgsql
as $f$
begin
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    raise exception using errcode = 'C1CAC', message = 'accepted';
  exception
    when insufficient_privilege then return null;
    when sqlstate 'C1CAC' then return 'accepted';
    when others then return sqlstate || ' ' || sqlerrm;
  end;
end
$f$;

-- Ids and numbers travel in transaction-local settings, which every role can read.
create function pg_temp.id(p_key text)
returns uuid
language sql
as $f$ select current_setting('rg1d.' || p_key)::uuid $f$;

create function pg_temp.remember(p_key text, p_id uuid)
returns uuid
language sql
as $f$ select set_config('rg1d.' || p_key, p_id::text, true)::uuid $f$;

create function pg_temp.number(p_key text)
returns bigint
language sql
as $f$ select current_setting('rg1d.' || p_key)::bigint $f$;

create function pg_temp.remember_number(p_key text, p_value bigint)
returns bigint
language sql
as $f$ select set_config('rg1d.' || p_key, p_value::text, true)::bigint $f$;

create function pg_temp.huge()
returns bigint
language sql
as $f$ select 1000000000000::bigint $f$;

create function pg_temp.as_worker()
returns void
language plpgsql
as $f$ begin execute 'set local role ops_worker'; end $f$;

create function pg_temp.as_owner()
returns void
language plpgsql
as $f$ begin execute 'reset role'; end $f$;

create function pg_temp.tenants()
returns uuid[]
language sql
as $f$ select array[pg_temp.id('tenant_a'), pg_temp.id('tenant_b'), pg_temp.id('tenant_c')] $f$;

create function pg_temp.valid_result()
returns jsonb
language sql
as $f$
  select '{"outcome": "needs_input", "summary": "Two items have no owner.", "proposed_next_steps": ["Name an owner"]}'::jsonb
$f$;

-- Offers ONE job to ops.lease_job: every other queued fixture job is parked far in
-- the future for the call, and this one is put first. Returns what ops.lease_job
-- leased, or NULL. Called and returns as the owner, with the lease's context
-- installed when one was taken.
create function pg_temp.offer(p_worker text, p_job uuid)
returns uuid
language plpgsql
as $f$
declare
  v_job ops.jobs;
begin
  update ops.jobs set available_at = available_at + interval '876000 hours'
   where status = 'queued' and id <> p_job and tenant_id = any (pg_temp.tenants());
  update ops.jobs set priority = -2147483648 where id = p_job;
  perform pg_temp.as_worker();
  v_job := ops.lease_job(p_worker, 60);
  perform pg_temp.as_owner();
  update ops.jobs set available_at = available_at - interval '876000 hours'
   where status = 'queued' and available_at > now() + interval '438000 hours'
     and tenant_id = any (pg_temp.tenants());
  return v_job.id;
end
$f$;

-- A REAL lease of exactly this job, or the case fails.
create function pg_temp.lease(p_label text, p_job uuid)
returns void
language plpgsql
as $f$
declare
  v_leased uuid;
begin
  v_leased := pg_temp.offer('rg1d-worker', p_job);
  if v_leased is distinct from p_job then
    raise exception '%: the lease went to %, not the fixture job %; this case would prove nothing', p_label, v_leased, p_job;
  end if;
end
$f$;

-- The lease on this job's context again, as the worker would resume it.
create function pg_temp.resume(p_label text, p_job uuid)
returns void
language plpgsql
as $f$
declare
  v_job ops.jobs;
begin
  perform pg_temp.as_worker();
  v_job := ops.resume_lease('rg1d-worker', p_job);
  perform pg_temp.as_owner();
  if v_job.id is distinct from p_job then
    raise exception '%: the lease on job % could not be resumed; this case would prove nothing', p_label, p_job;
  end if;
end
$f$;

-- A job a stop covers is passed over: still queued, no attempt spent, no lease event.
create function pg_temp.expect_held(p_label text, p_job uuid)
returns void
language plpgsql
as $f$
declare
  v_before ops.jobs;
  v_after  ops.jobs;
  v_events bigint;
  v_leased uuid;
begin
  select * into v_before from ops.jobs j where j.id = p_job;
  select count(*) into v_events from ops.job_events e where e.job_id = p_job;
  if v_before.status is distinct from 'queued' or v_before.available_at > now() then
    raise exception '%: job % is not queued and available (%); this case would prove nothing', p_label, p_job, v_before.status;
  end if;
  v_leased := pg_temp.offer('rg1d-worker-held', p_job);
  select * into v_after from ops.jobs j where j.id = p_job;
  if v_leased is not distinct from p_job or v_after.status <> 'queued' or v_after.attempts <> v_before.attempts
     or v_after.lease_owner is not null
     or (select count(*) from ops.job_events e where e.job_id = p_job) <> v_events then
    raise exception '%: a queued job an active stop covers was leased or spent an attempt (leased %, status %, attempts % -> %)',
      p_label, v_leased, v_after.status, v_before.attempts, v_after.attempts;
  end if;
end
$f$;

-- A job no stop covers is leased, spending exactly one attempt.
create function pg_temp.expect_leased(p_label text, p_job uuid)
returns void
language plpgsql
as $f$
declare
  v_before integer;
  v_leased uuid;
begin
  select j.attempts into v_before from ops.jobs j where j.id = p_job and j.status = 'queued';
  if v_before is null then
    raise exception '%: job % is not queued; this case would prove nothing', p_label, p_job;
  end if;
  v_leased := pg_temp.offer('rg1d-worker', p_job);
  if v_leased is distinct from p_job
     or (select j.attempts from ops.jobs j where j.id = p_job) <> v_before + 1 then
    raise exception '%: a queued job no active stop covers was not leased (leased %)', p_label, v_leased;
  end if;
end
$f$;

create function pg_temp.request(p_key text, p_tenant text, p_task text, p_agent text)
returns uuid
language sql
as $f$
  select ops.request_agent_run(pg_temp.id(p_tenant), pg_temp.id(p_task), pg_temp.id(p_agent),
                               'task_assessment', p_key, 'rg1d-test')
$f$;

create function pg_temp.job_of(p_run uuid)
returns uuid
language sql
as $f$ select r.job_id from ops.agent_runs r where r.id = p_run $f$;

create function pg_temp.run(p_run uuid)
returns ops.agent_runs
language sql
as $f$ select r from ops.agent_runs r where r.id = p_run $f$;

create function pg_temp.run_status(p_run uuid)
returns text
language sql
as $f$ select r.status from ops.agent_runs r where r.id = p_run $f$;

create function pg_temp.run_event_types(p_run uuid)
returns text[]
language sql
as $f$
  select coalesce(array_agg(e.type order by e.seq), '{}'::text[])
    from ops.events e
   where e.subject_type = 'agent_run' and e.subject_id = p_run
$f$;

create function pg_temp.run_state(p_run uuid)
returns jsonb
language sql
as $f$
  select to_jsonb(r) || jsonb_build_object('_facts',
           (select count(*) from ops.events e where e.subject_type = 'agent_run' and e.subject_id = r.id))
    from ops.agent_runs r
   where r.id = p_run
$f$;

-- A run requested and its job really leased, ready for the worker's sequence.
create function pg_temp.leased_run(p_key text, p_tenant text, p_task text, p_agent text)
returns uuid
language plpgsql
as $f$
declare
  v_run uuid;
  v_job uuid;
begin
  v_run := pg_temp.request(p_key, p_tenant, p_task, p_agent);
  v_job := pg_temp.job_of(v_run);
  if v_job is null then
    raise exception '%: the fixture run was given no job (%); this case would prove nothing',
      p_key, (select r.error_code from ops.agent_runs r where r.id = v_run);
  end if;
  perform pg_temp.lease(p_key, v_job);
  return v_run;
end
$f$;

create function pg_temp.adm_run(p_key text)
returns uuid
language sql
as $f$ select pg_temp.leased_run(p_key, 'tenant_a', 'task_adm', 'agent_a1') $f$;

-- The claim and start a healthy worker performs on the live lease. Returns the
-- start's answer, as the owner.
create function pg_temp.start(p_model text default 'rg1d-model', p_max_output integer default 8000)
returns text
language plpgsql
as $f$
declare
  v_state text;
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', p_model, 'task_assessment.v1', repeat('f', 64), p_max_output);
  perform pg_temp.as_owner();
  return v_state;
end
$f$;

-- One statement as the leased worker; returns its single text answer, as the owner.
create function pg_temp.worker(p_sql text)
returns text
language plpgsql
as $f$
declare
  v_out text;
begin
  perform pg_temp.as_worker();
  execute p_sql into v_out;
  perform pg_temp.as_owner();
  return v_out;
end
$f$;

-- Raw DML as the owner, with provenance declared, so only the guards decide.
create function pg_temp.raw(p_sql text)
returns void
language plpgsql
as $f$
declare
  v_previous constant text := current_setting('app.event_source', true);
begin
  perform set_config('app.event_source', 'rg1d-raw', true);
  execute p_sql;
  perform set_config('app.event_source', coalesce(v_previous, ''), true);
end
$f$;

create function pg_temp.raw_pending_run(p_tenant text, p_company text, p_department text, p_task text, p_agent text)
returns uuid
language plpgsql
as $f$
declare
  v_previous constant text := current_setting('app.event_source', true);
  v_id uuid;
begin
  perform set_config('app.event_source', 'rg1d-raw', true);
  insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                              idempotency_key, request_fingerprint, correlation_id, requested_by)
  values (pg_temp.id(p_tenant), pg_temp.id(p_company), pg_temp.id(p_department), pg_temp.id(p_task),
          pg_temp.id(p_agent), 'task_assessment', 'standard', 'rg1d-raw-' || gen_random_uuid(),
          repeat('a', 64), gen_random_uuid(), 'rg1d-raw')
  returning id into v_id;
  perform set_config('app.event_source', coalesce(v_previous, ''), true);
  return v_id;
end
$f$;

create function pg_temp.raw_update(p_run uuid, p_set text)
returns void
language plpgsql
as $f$
begin
  perform pg_temp.raw(format('update ops.agent_runs set %s where id = %L', p_set, p_run));
end
$f$;

-- What a raw owner start writes: the facts of a start, a price version and a reservation.
create function pg_temp.start_facts(p_model text, p_price uuid, p_reserved bigint, p_provider text default 'fake')
returns text
language sql
as $f$
  select format('status = ''running'', provider = %L, model = %L, prompt_version = ''task_assessment.v1'', '
                || 'input_fingerprint = repeat(''c'', 64), job_attempt = 1, price_id = %L, reserved_cost_micros = %s',
                p_provider, p_model, p_price, p_reserved)
$f$;

-- A tenant-A run started by a raw owner UPDATE.
create function pg_temp.raw_started(p_model text, p_price_key text, p_reserved bigint)
returns uuid
language plpgsql
as $f$
declare
  v_run uuid;
begin
  v_run := pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_cost', 'agent_a1');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts(p_model, pg_temp.id(p_price_key), p_reserved));
  return v_run;
end
$f$;

-- The reservation ops.start_agent_run makes for a run: its input ceiling over the
-- context the claim hands out, and its route's output ceiling.
create function pg_temp.expected_reservation(p_run uuid, p_price uuid)
returns bigint
language sql
as $f$
  select ops.agent_run_reservation_micros(p_price,
           ops.agent_run_input_token_ceiling(jsonb_build_object(
             'agent', jsonb_build_object('name', a.name, 'role', a.role, 'description', a.description),
             'task', jsonb_build_object('type', t.type, 'title', t.title, 'description', t.description,
                                        'priority', t.priority, 'due_at', t.due_at))),
           p.max_output_tokens)
    from ops.agent_runs r
    join ops.tasks t on t.id = r.task_id
    join ops.agents a on a.id = r.agent_id
    join ops.agent_run_route_policies() p on p.model_route = r.model_route
   where r.id = p_run
$f$;

-- Today's totals in UTC, the zone of every limit this suite sets unless it says otherwise.
create function pg_temp.settled(p_scope text, p_tenant uuid default null, p_company uuid default null)
returns bigint
language sql
as $f$
  select t.p_settled
    from ops.spend_window_total(p_scope, p_tenant, p_company, ops.spend_window_start('UTC', now())) t
$f$;

create function pg_temp.charged(p_scope text, p_tenant uuid default null, p_company uuid default null)
returns bigint
language sql
as $f$
  select t.p_charged
    from ops.spend_window_total(p_scope, p_tenant, p_company, ops.spend_window_start('UTC', now())) t
$f$;

-- 'code:limit' of an unlocked admission; 'admitted:-' when every limit absorbs it.
create function pg_temp.admission(p_tenant uuid, p_company uuid, p_reservation bigint)
returns text
language sql
as $f$
  select coalesce(a.p_code, 'admitted') || ':' || coalesce(a.p_limit_id::text, '-')
    from ops.spend_admission(p_tenant, p_company, p_reservation, false) a
$f$;

create function pg_temp.set_limit(p_scope text, p_micros bigint, p_tenant uuid default null,
                                  p_company uuid default null, p_timezone text default 'UTC')
returns uuid
language sql
as $f$
  select ops.set_spend_limit(p_scope, p_micros, p_timezone, 'rg1d-test: ' || p_scope || ' limit', 'rg1d-owner',
                             p_tenant, p_company)
$f$;

create function pg_temp.active_limit(p_scope text, p_tenant uuid default null, p_company uuid default null)
returns uuid
language sql
as $f$
  select l.id from ops.spend_limits l
   where l.scope = p_scope and l.tenant_id is not distinct from p_tenant
     and l.company_id is not distinct from p_company and l.ended_at is null
$f$;

create function pg_temp.retire_limit(p_scope text, p_tenant uuid default null, p_company uuid default null)
returns void
language plpgsql
as $f$
declare
  v_id uuid := pg_temp.active_limit(p_scope, p_tenant, p_company);
begin
  if v_id is not null then
    perform ops.retire_spend_limit(v_id, 'rg1d-test: retired', 'rg1d-owner');
  end if;
end
$f$;

-- The modes in which THIS backend holds the kill-switch lock (the one-key form).
create function pg_temp.stop_lock_modes()
returns text[]
language sql
as $f$
  select coalesce(array_agg(l.mode::text order by l.mode::text), '{}'::text[])
    from pg_locks l
   where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
     and l.classid = ((ops.execution_stop_lock_key() >> 32) & 4294967295)::oid
     and l.objid = (ops.execution_stop_lock_key() & 4294967295)::oid
$f$;

-- The modes in which THIS backend holds one spend lock (the two-key form).
create function pg_temp.spend_lock_modes(p_scope text, p_tenant uuid, p_company uuid)
returns text
language sql
as $f$
  select coalesce(array_agg(l.mode::text order by l.mode::text), '{}'::text[])::text
    from pg_locks l
   where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 2
     and l.classid = (ops.spend_lock_namespace()::bigint & 4294967295)::oid
     and l.objid = (ops.spend_lock_key(p_scope, p_tenant, p_company)::bigint & 4294967295)::oid
$f$;

create function pg_temp.spend_locks(p_tenant uuid, p_company uuid)
returns text
language sql
as $f$
  select format('global=%s tenant=%s company=%s',
                pg_temp.spend_lock_modes('global', null, null),
                pg_temp.spend_lock_modes('tenant', p_tenant, null),
                pg_temp.spend_lock_modes('company', p_tenant, p_company))
$f$;

-- Ends a lease DURING this transaction, on the wall clock only. Owner only.
create function pg_temp.expire_on_clock(p_job uuid)
returns void
language plpgsql
as $f$
declare
  v_expires timestamptz;
begin
  update ops.jobs set lease_expires_at = clock_timestamp() + interval '20 milliseconds'
   where id = p_job and status = 'leased'
  returning lease_expires_at into v_expires;
  perform pg_sleep(0.1);
  if v_expires is null or not (v_expires > now()) or not (v_expires < clock_timestamp()) then
    raise exception 'fixture: job % is not a lease live by now() that ended on the wall clock', p_job;
  end if;
end
$f$;

-- ---------------------------------------------------------------------------
-- Fixtures, built through the domain functions so their events are real.
-- Tenant A holds two companies, company A1 two departments; tenant C belongs to
-- section L. No spend limit exists yet: section W needs the spend locks free.
-- ---------------------------------------------------------------------------
create function pg_temp.assigned_task(p_key text, p_tenant text, p_company text, p_agent text,
                                      p_title text default null, p_description text default null)
returns uuid
language plpgsql
as $f$
declare
  v_task uuid;
begin
  v_task := pg_temp.remember(p_key, ops.create_task(
    pg_temp.id(p_tenant), pg_temp.id(p_company), 'work.review',
    coalesce(p_title, format('Review the open items (%s)', p_key)), 'rg1d-test',
    coalesce(p_description, 'Look at the open items and propose what to do next.'), null, null, 200,
    '2026-10-01T12:00:00Z'));
  if p_agent is not null then
    perform ops.assign_task(pg_temp.id(p_tenant), v_task, pg_temp.id(p_agent), 'rg1d-test');
  end if;
  return v_task;
end
$f$;

do $$
declare
  ta uuid;
  tb uuid;
  tc uuid;
  c_source constant text := 'rg1d-test';
begin
  insert into ops.tenants (slug, name) values ('rg1d-test-alpha', 'RG1D Alpha') returning id into ta;
  insert into ops.tenants (slug, name) values ('rg1d-test-beta', 'RG1D Beta') returning id into tb;
  insert into ops.tenants (slug, name) values ('rg1d-test-gamma', 'RG1D Gamma') returning id into tc;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  perform pg_temp.remember('tenant_c', tc);

  perform pg_temp.remember('company_a1', ops.create_company(ta, 'alpha-one', 'Alpha One', c_source));
  perform pg_temp.remember('company_a2', ops.create_company(ta, 'alpha-two', 'Alpha Two', c_source));
  perform pg_temp.remember('company_b', ops.create_company(tb, 'beta-one', 'Beta One', c_source));
  perform pg_temp.remember('company_c1', ops.create_company(tc, 'gamma-one', 'Gamma One', c_source));
  perform pg_temp.remember('company_c2', ops.create_company(tc, 'gamma-two', 'Gamma Two', c_source));

  perform pg_temp.remember('dept_a1', ops.create_department(ta, pg_temp.id('company_a1'), 'operations', 'Operations', c_source));
  perform pg_temp.remember('dept_a1_support', ops.create_department(ta, pg_temp.id('company_a1'), 'support', 'Support', c_source));
  perform pg_temp.remember('dept_a2', ops.create_department(ta, pg_temp.id('company_a2'), 'operations', 'Operations', c_source));
  perform pg_temp.remember('dept_b', ops.create_department(tb, pg_temp.id('company_b'), 'operations', 'Operations', c_source));
  perform pg_temp.remember('dept_c1', ops.create_department(tc, pg_temp.id('company_c1'), 'operations', 'Operations', c_source));
  perform pg_temp.remember('dept_c2', ops.create_department(tc, pg_temp.id('company_c2'), 'operations', 'Operations', c_source));

  perform pg_temp.remember('agent_a1', ops.create_agent(ta, pg_temp.id('company_a1'), pg_temp.id('dept_a1'),
    'analyst', 'Analyst', 'Work reviewer', c_source, 'Reviews assigned work and proposes next steps.'));
  perform pg_temp.remember('agent_a1_two', ops.create_agent(ta, pg_temp.id('company_a1'), pg_temp.id('dept_a1'),
    'analyst-two', 'Analyst Two', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_a1_support', ops.create_agent(ta, pg_temp.id('company_a1'), pg_temp.id('dept_a1_support'),
    'support-analyst', 'Support Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_a2', ops.create_agent(ta, pg_temp.id('company_a2'), pg_temp.id('dept_a2'),
    'analyst', 'Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_b', ops.create_agent(tb, pg_temp.id('company_b'), pg_temp.id('dept_b'),
    'analyst', 'Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_c1', ops.create_agent(tc, pg_temp.id('company_c1'), pg_temp.id('dept_c1'),
    'analyst', 'Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_c2', ops.create_agent(tc, pg_temp.id('company_c2'), pg_temp.id('dept_c2'),
    'analyst', 'Analyst', 'Work reviewer', c_source));

  perform pg_temp.assigned_task('task_adm', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_k', 'tenant_a', 'company_a1', 'agent_a1');
  -- Adversarial text: quotes, backslashes, control characters and 4-byte characters,
  -- at the longest description a task may hold. JSON escaping makes it far longer.
  perform pg_temp.assigned_task('task_cost', 'tenant_a', 'company_a1', 'agent_a1',
    'Assess "quoted" ' || chr(92) || ' path' || chr(9) || chr(128512),
    repeat('"' || chr(92) || chr(1) || chr(128512), 2500));
  perform pg_temp.assigned_task('task_b', 'tenant_b', 'company_b', 'agent_b');
  perform pg_temp.assigned_task('task_c1', 'tenant_c', 'company_c1', 'agent_c1');
  perform pg_temp.assigned_task('task_c2', 'tenant_c', 'company_c2', 'agent_c2');
  perform pg_temp.assigned_task('task_i_parent', 'tenant_a', 'company_a1', null);

  -- The price every admission run starts with. Synthetic, and rolled back.
  perform pg_temp.remember('price_base', ops.record_model_price(
    'fake', 'rg1d-model', 1, 1, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'rg1d-owner', 0.5));
end
$$;

-- ===========================================================================
-- W. LOCK WITNESSES. A transaction-level advisory lock is held until the
--    transaction ends, so these run before anything else takes the kill-switch or
--    a spend lock, each in a subtransaction that is rolled back and releases what it
--    took. What one connection cannot prove is what the locks BUY; the
--    driver-backed suite races real connections.
-- ===========================================================================

-- W1. ops.lease_job holds the kill-switch lock SHARED once it has read the stops. One
--     session proves that it is held; that it is taken BEFORE the read (so an
--     uncommitted trip is waited for) is proven with two sessions in
--     engine/domain/killSwitchLease.dbtest.ts.
do $$
declare
  v_before text[];
  v_after  text[];
begin
  v_before := pg_temp.stop_lock_modes();
  begin
    perform pg_temp.as_worker();
    perform ops.lease_job('rg1d-worker-witness', 60);
    perform pg_temp.as_owner();
    v_after := pg_temp.stop_lock_modes();
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_before <> '{}'::text[] then
    raise exception 'W1: the kill-switch lock was held before the lease (%); this case would prove nothing', v_before;
  end if;
  if v_after is distinct from array['ShareLock'] then
    raise exception 'W1: ops.lease_job does not hold the kill-switch lock shared once it has read the stops (held: %)', v_after;
  end if;
end
$$;

-- W2. Admission takes the global, tenant and company spend locks exclusively when
--     asked to, and none when it only reads.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_unlocked text;
  v_locked   text;
begin
  begin
    perform ops.spend_admission(ta, ca1, 0, false);
    v_unlocked := pg_temp.spend_locks(ta, ca1);
    perform ops.spend_admission(ta, ca1, 0, true);
    v_locked := pg_temp.spend_locks(ta, ca1);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_unlocked is distinct from 'global={} tenant={} company={}' then
    raise exception 'W2: an unlocked spend admission took a spend lock (%)', v_unlocked;
  end if;
  if v_locked is distinct from 'global={ExclusiveLock} tenant={ExclusiveLock} company={ExclusiveLock}' then
    raise exception 'W2: a locking spend admission did not take the global, tenant and company spend locks exclusively (%)', v_locked;
  end if;
end
$$;

-- W3. A start takes the company spend lock even when no company limit exists: the
--     limits set here take only their own scopes' locks.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_before text;
  v_after  text;
  v_state  text;
begin
  begin
    perform pg_temp.set_limit('global', pg_temp.huge());
    perform pg_temp.set_limit('tenant', pg_temp.huge(), ta);
    perform pg_temp.adm_run('rg1d-w3');
    v_before := pg_temp.spend_locks(ta, ca1);
    v_state := pg_temp.start();
    v_after := pg_temp.spend_locks(ta, ca1);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_before is distinct from 'global={ExclusiveLock} tenant={ExclusiveLock} company={}' then
    raise exception 'W3: the locks before the start were % ; this case would prove nothing', v_before;
  end if;
  if v_state is distinct from 'running'
     or v_after is distinct from 'global={ExclusiveLock} tenant={ExclusiveLock} company={ExclusiveLock}' then
    raise exception 'W3: a start did not take every spend lock before admitting the run (start %, locks %)', v_state, v_after;
  end if;
end
$$;

-- W4, W5. A settlement that raises a charge above its reservation takes the spend
--     locks first; one that lowers it takes none.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_run    uuid;
  v_start  text;
  v_raised text;
  v_lowered text;
  v_raise_charge bigint;
  v_lower_charge bigint;
begin
  begin
    v_run := pg_temp.raw_started('rg1d-model', 'price_base', 1);
    v_start := pg_temp.spend_locks(ta, ca1);
    perform pg_temp.raw_update(v_run, format(
      'status = ''succeeded'', result = %L, input_tokens = 100, output_tokens = 100', pg_temp.valid_result()));
    v_raised := pg_temp.spend_locks(ta, ca1);
    v_raise_charge := (pg_temp.run(v_run)).charged_cost_micros;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  begin
    v_run := pg_temp.raw_started('rg1d-model', 'price_base', 1000000);
    perform pg_temp.raw_update(v_run, format(
      'status = ''succeeded'', result = %L, input_tokens = 100, output_tokens = 100', pg_temp.valid_result()));
    v_lowered := pg_temp.spend_locks(ta, ca1);
    v_lower_charge := (pg_temp.run(v_run)).charged_cost_micros;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_start is distinct from 'global={} tenant={} company={}' then
    raise exception 'W4: a raw start already held a spend lock (%); this case would prove nothing', v_start;
  end if;
  if v_raise_charge is distinct from 200
     or v_raised is distinct from 'global={ExclusiveLock} tenant={ExclusiveLock} company={ExclusiveLock}' then
    raise exception 'W4: a settlement that raised a charge above its reservation did not take the spend locks first (charge %, locks %)',
      v_raise_charge, v_raised;
  end if;
  if v_lower_charge is distinct from 200 or v_lowered is distinct from 'global={} tenant={} company={}' then
    raise exception 'W5: a settlement that lowered a charge took a spend lock (charge %, locks %)', v_lower_charge, v_lowered;
  end if;
end
$$;

-- W6, W7. The pre-call check and the deferral each hold the kill-switch lock SHARED
--     once they have read the stops. The order (the pre-call check waits for a trip
--     still in flight, then reads the stops) is proven with two sessions in
--     engine/domain/preCallStopCheck.dbtest.ts. The lease is built by hand, because
--     ops.lease_job takes the same lock and would hide whether a later call takes it.
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_case   record;
  v_job    uuid;
  v_tenant uuid;
  v_before text[];
  v_after  text[];
begin
  for v_case in
    select * from (values
      ('W6', 'select ops.job_execution_stop()',
       'W6: ops.job_execution_stop does not hold the kill-switch lock shared once it has read the stops'),
      ('W7', 'select ops.defer_job()',
       'W7: ops.defer_job does not hold the kill-switch lock shared once it has read the stops')
    ) as c (label, statement, failure)
  loop
    v_tenant := null;
    v_before := null;
    v_after := null;
    begin
      v_job := ops.enqueue_job(ta, 'rg1d.lock_probe', '{}'::jsonb, 100, now(), 5, null);
      update ops.jobs
         set status = 'leased', lease_owner = 'rg1d-worker-lock', leased_at = now(),
             lease_expires_at = now() + interval '60 seconds', attempts = attempts + 1, updated_at = now()
       where id = v_job and status = 'queued';
      perform set_config('app.worker_id', 'rg1d-worker-lock', true);
      perform set_config('app.job_id', v_job::text, true);
      v_before := pg_temp.stop_lock_modes();
      perform pg_temp.as_worker();
      v_tenant := ops.current_tenant_id();
      execute v_case.statement;
      perform pg_temp.as_owner();
      v_after := pg_temp.stop_lock_modes();
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    exception when sqlstate 'C1CAC' then null;
    end;
    if v_tenant is distinct from ta or v_before is distinct from '{}'::text[] then
      raise exception '%: the hand-built lease did not install tenant A, or the kill-switch lock was already held (%); this case would prove nothing',
        v_case.label, v_before;
    end if;
    if v_after is distinct from array['ShareLock'] then
      raise exception '% (held: %)', v_case.failure, v_after;
    end if;
  end loop;
end
$$;

-- The configuration every later section starts from: a global ceiling and a budget
-- for tenants A and B that nothing here can exhaust.
do $$
begin
  perform pg_temp.set_limit('global', pg_temp.huge());
  perform pg_temp.set_limit('tenant', pg_temp.huge(), pg_temp.id('tenant_a'));
  perform pg_temp.set_limit('tenant', pg_temp.huge(), pg_temp.id('tenant_b'));
end
$$;

-- ===========================================================================
-- P. PRICES.
-- ===========================================================================

-- P1-P5. Recording a version: replay, conflict, precision, bounds and shape.
do $$
declare
  c_from constant timestamptz := now() - interval '1 hour';
  c_to   constant timestamptz := now() + interval '30 days';
  v_id    uuid;
  v_again uuid;
  r       ops.model_prices;
  v_case  record;
  v_n     integer := 0;
begin
  v_id := pg_temp.remember('price_p', ops.record_model_price(
    'fake', 'rg1d-p-model', 1.5, 3, true, c_from, c_to, 'rg1d synthetic price v1', 'rg1d-owner', 0.15));
  v_again := ops.record_model_price('fake', 'rg1d-p-model', 1.500000, 3.000, true, c_from, c_to,
                                    'rg1d synthetic price v1', 'rg1d-owner', 0.150);
  if v_again is distinct from v_id then
    raise exception 'P1: replaying the same price version recorded another version (% then %)', v_id, v_again;
  end if;
  v_again := ops.record_model_price('fake', 'rg1d-p-model', 1.5, 3, true, c_from, c_to,
                                    'rg1d another reading of the same price', 'rg1d-other-owner', 0.15);
  select * into r from ops.model_prices p where p.id = v_id;
  if v_again is distinct from v_id or r.source <> 'rg1d synthetic price v1' or r.recorded_by <> 'rg1d-owner' then
    raise exception 'P1: a replay from another source did not return the recorded version unchanged (returned %, source %, by %)',
      v_again, r.source, r.recorded_by;
  end if;
  if (select count(*) from ops.model_prices p where p.provider = 'fake' and p.model = 'rg1d-p-model') <> 1 then
    raise exception 'P1: replaying a price version stored another row';
  end if;
  if r.input_usd_per_mtok <> 1.5 or r.output_usd_per_mtok <> 3 or r.cached_input_usd_per_mtok <> 0.15
     or not r.reasoning_in_output or r.effective_from <> c_from or r.expires_at <> c_to then
    raise exception 'P1: the recorded version does not hold what it was given: %', to_jsonb(r);
  end if;

  -- P2. A different version under the same (provider, model, effective_from).
  for v_case in
    select * from (values
      ('P2 another input rate at a recorded moment',
       $q$select ops.record_model_price('fake', 'rg1d-p-model', 1.6, 3, true, %L, %L, 'rg1d conflict', 'rg1d-owner', 0.15)$q$),
      ('P2 another output rate at a recorded moment',
       $q$select ops.record_model_price('fake', 'rg1d-p-model', 1.5, 3.1, true, %L, %L, 'rg1d conflict', 'rg1d-owner', 0.15)$q$),
      ('P2 another cached rate at a recorded moment',
       $q$select ops.record_model_price('fake', 'rg1d-p-model', 1.5, 3, true, %L, %L, 'rg1d conflict', 'rg1d-owner', 0.16)$q$),
      ('P2 no cached rate at a moment recorded with one',
       $q$select ops.record_model_price('fake', 'rg1d-p-model', 1.5, 3, true, %L, %L, 'rg1d conflict', 'rg1d-owner')$q$),
      ('P2 another reasoning rule at a recorded moment',
       $q$select ops.record_model_price('fake', 'rg1d-p-model', 1.5, 3, false, %L, %L, 'rg1d conflict', 'rg1d-owner', 0.15)$q$),
      ('P2 another expiry at a recorded moment',
       $q$select ops.record_model_price('fake', 'rg1d-p-model', 1.5, 3, true, %L, %L::timestamptz + interval '1 day', 'rg1d conflict', 'rg1d-owner', 0.15)$q$)
    ) as c (label, statement)
  loop
    perform pg_temp.expect_refused(v_case.label, 'OS409', format(v_case.statement, c_from, c_to));
    v_n := v_n + 1;
  end loop;
  if (select count(*) from ops.model_prices p where p.provider = 'fake' and p.model = 'rg1d-p-model') <> 1 then
    raise exception 'P2: a conflicting price version was stored';
  end if;

  -- P3-P5. Refused rather than rounded, bounded, and well formed.
  for v_case in
    select * from (values
      ('P3 an input rate with seven decimals',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1.0000001, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P3 an output rate with seven decimals',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 0.0000001, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P3 a cached rate with seven decimals',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner', 0.1234567)$q$),
      ('P3 a negative input rate',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', -1, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P3 a negative output rate',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, -1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P3 a negative cached rate',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner', -0.5)$q$),
      ('P3 an input rate beyond the column',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 100000000, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P3 no input rate',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', null, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P4 a cached rate above the input rate',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner', 1.000001)$q$),
      ('P5 a version valid for more than 366 days',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %1$L::timestamptz + interval '366 days 1 second', 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a version that expires when it takes effect',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %1$L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a version that expires before it takes effect',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %2$L, %1$L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a version with no start',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, null, %2$L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a version with no expiry',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, null, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a malformed provider',
       $q$select ops.record_model_price('Fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a malformed model',
       $q$select ops.record_model_price('fake', 'rg1d p bounds', 1, 1, true, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 an unstated reasoning rule',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, null, %L, %L, 'rg1d bounds', 'rg1d-owner')$q$),
      ('P5 a blank source',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, '   ', 'rg1d-owner')$q$),
      ('P5 an over-long source',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, repeat('s', 501), 'rg1d-owner')$q$),
      ('P5 a malformed actor',
       $q$select ops.record_model_price('fake', 'rg1d-p-bounds', 1, 1, true, %L, %L, 'rg1d bounds', 'The Owner')$q$)
    ) as c (label, statement)
  loop
    perform pg_temp.expect_refused(v_case.label, 'OS400', format(v_case.statement, c_from, c_to, c_from, c_from));
    v_n := v_n + 1;
  end loop;
  if exists (select 1 from ops.model_prices p where p.model = 'rg1d-p-bounds') then
    raise exception 'P3: a refused price version was stored';
  end if;

  -- Controls: six decimals, a cached rate equal to the input rate, and exactly 366 days are accepted.
  v_id := ops.record_model_price('fake', 'rg1d-p-bounds', 1.123456, 0.000001, true, c_from,
                                 c_from + interval '366 days', 'rg1d bounds', 'rg1d-owner', 1.123456);
  select * into r from ops.model_prices p where p.id = v_id;
  if r.input_usd_per_mtok <> 1.123456 or r.output_usd_per_mtok <> 0.000001 or r.cached_input_usd_per_mtok <> 1.123456 then
    raise exception 'P3: an exact six-decimal price was not stored exactly: %', to_jsonb(r);
  end if;
  if v_n <> 26 then
    raise exception 'P2-P5: % refusals ran, expected 26; a case was lost', v_n;
  end if;
end
$$;

-- P3-P5 structural backstop: a raw owner insert meets the table's own constraints.
select pg_temp.expect_refused('P4 a raw version whose cached rate is above its input rate', '23514', $q$
  insert into ops.model_prices (provider, model, input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok,
                                reasoning_in_output, effective_from, expires_at, source, recorded_by)
  values ('fake', 'rg1d-p-raw', 1, 2, 1, true, now(), now() + interval '1 day', 'rg1d raw', 'rg1d-owner')
$q$);
select pg_temp.expect_refused('P5 a raw version valid for more than 366 days', '23514', $q$
  insert into ops.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok,
                                reasoning_in_output, effective_from, expires_at, source, recorded_by)
  values ('fake', 'rg1d-p-raw', 1, 1, true, now(), now() + interval '367 days', 'rg1d raw', 'rg1d-owner')
$q$);
select pg_temp.expect_refused('P5 a raw version with a negative rate', '23514', $q$
  insert into ops.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok,
                                reasoning_in_output, effective_from, expires_at, source, recorded_by)
  values ('fake', 'rg1d-p-raw', 1, -1, true, now(), now() + interval '1 day', 'rg1d raw', 'rg1d-owner')
$q$);
select pg_temp.expect_refused('P2 a raw second version at a recorded moment', '23505', format($q$
  insert into ops.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok,
                                reasoning_in_output, effective_from, expires_at, source, recorded_by)
  select provider, model, 9, 9, true, effective_from, expires_at, 'rg1d raw', 'rg1d-owner'
    from ops.model_prices where id = %L
$q$, pg_temp.id('price_p')));

-- P6, P7. The price at a moment is the latest version effective at or before it; a
--     future version is not used yet; an expired latest version means no price, with
--     no fallback to an older one.
do $$
declare
  v1 uuid;
  v2 uuid;
  v3 uuid;
  s1 uuid;
  s2 uuid;
begin
  v1 := ops.record_model_price('fake', 'rg1d-p-lookup', 1, 1, true, now() - interval '10 days',
                               now() + interval '300 days', 'rg1d lookup v1', 'rg1d-owner');
  v2 := ops.record_model_price('fake', 'rg1d-p-lookup', 2, 2, true, now() - interval '1 day',
                               now() + interval '300 days', 'rg1d lookup v2', 'rg1d-owner');
  v3 := ops.record_model_price('fake', 'rg1d-p-lookup', 3, 3, true, now() + interval '1 day',
                               now() + interval '300 days', 'rg1d lookup v3', 'rg1d-owner');
  if ops.current_model_price('fake', 'rg1d-p-lookup', now()) is distinct from v2 then
    raise exception 'P6: the price now is not the latest version already in effect (got %, expected %, future %)',
      ops.current_model_price('fake', 'rg1d-p-lookup', now()), v2, v3;
  end if;
  if ops.current_model_price('fake', 'rg1d-p-lookup', now() - interval '1 day') is distinct from v2 then
    raise exception 'P6: a version is not in effect from the very moment it takes effect';
  end if;
  if ops.current_model_price('fake', 'rg1d-p-lookup', now() - interval '5 days') is distinct from v1 then
    raise exception 'P6: the price at an earlier moment is not the version in effect then';
  end if;
  if ops.current_model_price('fake', 'rg1d-p-lookup', now() - interval '11 days') is not null then
    raise exception 'P6: a moment before any version took effect has a price';
  end if;
  if ops.current_model_price('fake', 'rg1d-p-lookup', now() + interval '2 days') is distinct from v3 then
    raise exception 'P6: a future version is not used once it takes effect';
  end if;
  if ops.current_model_price('other', 'rg1d-p-lookup', now()) is not null
     or ops.current_model_price('fake', 'rg1d-p-lookup-unknown', now()) is not null then
    raise exception 'P6: another provider''s or another model''s run found a price';
  end if;

  s1 := ops.record_model_price('fake', 'rg1d-p-stale', 1, 1, true, now() - interval '10 days',
                               now() + interval '300 days', 'rg1d stale v1', 'rg1d-owner');
  s2 := ops.record_model_price('fake', 'rg1d-p-stale', 2, 2, true, now() - interval '2 days',
                               now() - interval '1 day', 'rg1d stale v2', 'rg1d-owner');
  if ops.current_model_price('fake', 'rg1d-p-stale', now()) is not null then
    raise exception 'P7: an expired latest price version fell back to an older unexpired one (got %)',
      ops.current_model_price('fake', 'rg1d-p-stale', now());
  end if;
  if ops.current_model_price('fake', 'rg1d-p-stale', now() - interval '1 day') is not null then
    raise exception 'P7: a price version is still used at the moment it expires';
  end if;
  if ops.current_model_price('fake', 'rg1d-p-stale', now() - interval '1 day 1 second') is distinct from s2
     or ops.current_model_price('fake', 'rg1d-p-stale', now() - interval '3 days') is distinct from s1 then
    raise exception 'P7: the versions in effect before the expiry are not the ones recorded';
  end if;
end
$$;

-- P8. A version is immutable, and the table is never truncated, replica mode included.
select pg_temp.expect_refused('P8 rewriting a price version''s input rate', 'OS409',
  format('update ops.model_prices set input_usd_per_mtok = 0 where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 rewriting a price version''s cached rate', 'OS409',
  format('update ops.model_prices set cached_input_usd_per_mtok = 0 where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 rewriting a price version''s output rate', 'OS409',
  format('update ops.model_prices set output_usd_per_mtok = 0 where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 rewriting a price version''s reasoning rule', 'OS409',
  format('update ops.model_prices set reasoning_in_output = false where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 moving a price version''s start', 'OS409',
  format('update ops.model_prices set effective_from = effective_from - interval ''1 day'' where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 extending a price version''s expiry', 'OS409',
  format('update ops.model_prices set expires_at = expires_at + interval ''1 day'' where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 rewriting a price version''s source', 'OS409',
  format('update ops.model_prices set source = ''rg1d rewritten'' where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 re-attributing a price version', 'OS409',
  format('update ops.model_prices set recorded_by = ''someone-else'' where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 a no-op update of a price version', 'OS409',
  format('update ops.model_prices set source = source where id = %L', pg_temp.id('price_p')));
select pg_temp.expect_refused('P8 truncating the price versions', 'OS409', 'truncate ops.model_prices cascade');
set local session_replication_role = replica;
do $$
begin
  begin
    update ops.model_prices set expires_at = expires_at + interval '1 day' where id = pg_temp.id('price_p');
    raise exception 'P8: replica mode silenced model_prices_refuse_update; the guard must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    truncate ops.model_prices cascade;
    raise exception 'P8: replica mode silenced model_prices_refuse_truncate; the guard must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
end
$$;
set local session_replication_role = origin;

-- P10. A recording cannot be backdated.
do $$
declare
  v_at timestamptz;
begin
  insert into ops.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok, reasoning_in_output,
                                effective_from, expires_at, source, recorded_by, recorded_at)
  values ('fake', 'rg1d-p-backdated', 1, 1, true, now() - interval '1 day', now() + interval '1 day',
          'rg1d raw price', 'rg1d-owner', now() - interval '1 year')
  returning recorded_at into v_at;
  if v_at is distinct from now() then
    raise exception 'P10: a price version was recorded at %, not by the database clock', v_at;
  end if;
end
$$;

-- P11. No application role can read or write the prices, or record one.
do $$
declare
  v_role    text;
  v_case    record;
  v_leak    text;
  v_reached text[] := '{}';
  v_tried   integer := 0;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker'] loop
    for v_case in
      select * from (values
        ('select', 'select count(*) from ops.model_prices'),
        ('insert', $q$insert into ops.model_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok,
                     reasoning_in_output, effective_from, expires_at, source, recorded_by)
                     values ('fake', 'rg1d-p-role', 0, 0, true, now(), now() + interval '1 day', 'rg1d attack', 'rg1d-attacker')$q$),
        ('update', 'update ops.model_prices set input_usd_per_mtok = 0'),
        ('delete', 'delete from ops.model_prices'),
        ('truncate', 'truncate ops.model_prices'),
        ('record_model_price', $q$select ops.record_model_price('fake', 'rg1d-p-role', 0, 0, true, now(),
                                  now() + interval '1 day', 'rg1d attack', 'rg1d-attacker')$q$)
      ) as c (label, statement)
    loop
      v_tried := v_tried + 1;
      v_leak := pg_temp.privilege_leak(v_role, v_case.statement);
      if v_leak is not null then
        v_reached := v_reached || format('%s %s (%s)', v_role, v_case.label, v_leak);
      end if;
    end loop;
  end loop;
  if cardinality(v_reached) > 0 then
    raise exception 'P11: an application role reached the model prices: %', array_to_string(v_reached, '; ');
  end if;
  if v_tried <> 24 then
    raise exception 'P11: % attempts ran, expected 24; a case was lost', v_tried;
  end if;
end
$$;

-- ===========================================================================
-- C. COST. Synthetic versions whose arithmetic is easy to check by hand.
--    inside: input 2, cached 0.5, output 8, reasoning inside output.
--    ontop:  input 2, no cached rate, output 8, reasoning billed on top.
--    round:  0.4 everywhere, so rounding shows.
--    other:  the inside rates under another provider.
-- ===========================================================================
do $$
begin
  perform pg_temp.remember('price_c_inside', ops.record_model_price('fake', 'rg1d-c-inside', 2, 8, true,
    now() - interval '1 minute', now() + interval '1 day', 'sql suite synthetic price', 'rg1d-owner', 0.5));
  perform pg_temp.remember('price_c_ontop', ops.record_model_price('fake', 'rg1d-c-ontop', 2, 8, false,
    now() - interval '1 minute', now() + interval '1 day', 'sql suite synthetic price', 'rg1d-owner'));
  perform pg_temp.remember('price_c_round', ops.record_model_price('fake', 'rg1d-c-round', 0.4, 0.4, true,
    now() - interval '1 minute', now() + interval '1 day', 'sql suite synthetic price', 'rg1d-owner', 0.4));
  perform pg_temp.remember('price_c_other', ops.record_model_price('other', 'rg1d-c-inside', 2, 8, true,
    now() - interval '1 minute', now() + interval '1 day', 'sql suite synthetic price', 'rg1d-owner', 0.5));
end
$$;

-- C1. The estimate: uncached input at the input rate, cached input at the cached
--     rate (the input rate when none was recorded), output at the output rate, and
--     reasoning on top only when the version says so; rounded up once. Incomplete or
--     inconsistent usage is no estimate.
do $$
declare
  v_case record;
  v_got  bigint;
  v_n    integer := 0;
begin
  for v_case in
    select * from (values
      ('uncached and cached input, reasoning inside output', 'price_c_inside', 1000, 200, 500, 100, 1500, 5700::bigint),
      ('no cached count is no cached input', 'price_c_inside', 1000, null, 500, 100, 1500, 6000),
      ('unreported reasoning is allowed when it is inside output', 'price_c_inside', 1000, 200, 500, null, null, 5700),
      ('reasoning equal to output is consistent', 'price_c_inside', 1000, 0, 500, 500, 1500, 6000),
      ('no cached rate bills cached input in full, and reasoning is billed on top', 'price_c_ontop', 1000, 200, 500, 100, 1600, 6800),
      ('0.8 micro-USD over three terms is rounded up once, to 1', 'price_c_round', 1, 1, 1, 0, 2, 1),
      ('1.2 micro-USD is rounded up to 2', 'price_c_round', 2, 0, 1, 0, 3, 2),
      ('zero usage costs nothing', 'price_c_inside', 0, 0, 0, 0, 0, 0),
      ('the largest token counts do not overflow', 'price_c_inside', 2147483647, 0, 2147483647, 0, null, 21474836470),
      ('unknown input', 'price_c_inside', null, 0, 500, 0, null, null),
      ('unknown output', 'price_c_inside', 1000, 0, null, 0, null, null),
      ('cached input above input', 'price_c_inside', 100, 101, 500, 0, null, null),
      ('a total below input plus output', 'price_c_inside', 1000, 0, 500, 0, 1499, null),
      ('reasoning above output when it is inside output', 'price_c_inside', 1000, 0, 500, 501, 1500, null),
      ('unknown reasoning when it is billed on top', 'price_c_ontop', 1000, 0, 500, null, 1500, null),
      ('a price version that does not exist', null, 1000, 0, 500, 0, 1500, null)
    ) as c (label, price_key, input_tokens, cached_tokens, output_tokens, reasoning_tokens, total_tokens, expected)
  loop
    v_got := ops.agent_run_estimated_cost_micros(
      case when v_case.price_key is null then gen_random_uuid() else pg_temp.id(v_case.price_key) end,
      v_case.input_tokens, v_case.cached_tokens, v_case.output_tokens, v_case.reasoning_tokens, v_case.total_tokens);
    if v_got is distinct from v_case.expected then
      raise exception 'C1: the estimated cost for "%" is %, expected %', v_case.label, v_got, v_case.expected;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> 16 then
    raise exception 'C1: % estimates were checked, expected 16; a case was lost', v_n;
  end if;
end
$$;

-- C2. The reservation: the input ceiling at the input rate (cached input is never
--     assumed), plus the output ceiling at the output rate, counted twice when
--     reasoning is billed on top; rounded up once. The input ceiling is the context's
--     jsonb text, plus the name and role again, plus 8192 tokens.
do $$
declare
  v_context jsonb := jsonb_build_object('agent', jsonb_build_object(
    'name', 'A' || chr(241) || chr(128512), 'role', 'C"d' || chr(92) || 'e' || chr(1)));
begin
  if ops.agent_run_reservation_micros(pg_temp.id('price_c_inside'), 1000, 8000) <> 66000 then
    raise exception 'C2: the reservation with reasoning inside output is %, expected 66000 (1000 x 2 + 8000 x 8)',
      ops.agent_run_reservation_micros(pg_temp.id('price_c_inside'), 1000, 8000);
  end if;
  if ops.agent_run_reservation_micros(pg_temp.id('price_c_ontop'), 1000, 8000) <> 130000 then
    raise exception 'C2: the reservation with reasoning billed on top is %, expected 130000 (1000 x 2 + 2 x 8000 x 8)',
      ops.agent_run_reservation_micros(pg_temp.id('price_c_ontop'), 1000, 8000);
  end if;
  if ops.agent_run_reservation_micros(pg_temp.id('price_c_round'), 1, 1) <> 1
     or ops.agent_run_reservation_micros(pg_temp.id('price_c_round'), 3, 0) <> 2 then
    raise exception 'C2: the reservation is not rounded up once (% and %)',
      ops.agent_run_reservation_micros(pg_temp.id('price_c_round'), 1, 1),
      ops.agent_run_reservation_micros(pg_temp.id('price_c_round'), 3, 0);
  end if;
  -- {"agent": {"name": "An<emoji>", "role": "C\"d\\e<U+0001>"}} is 55 bytes as jsonb
  -- text; the name is quoted again (9 bytes) and the role (15 bytes).
  if ops.agent_run_input_token_ceiling(v_context) <> 55 + 9 + 15 + 8192 then
    raise exception 'C2: the input ceiling of an escaped, multi-byte context is %, expected 8271',
      ops.agent_run_input_token_ceiling(v_context);
  end if;
  if ops.agent_run_input_token_ceiling(null) <> 2 + 8192 then
    raise exception 'C2: the input ceiling of no context is %, expected 8194', ops.agent_run_input_token_ceiling(null);
  end if;
  if (select array_agg(p.model_route || '=' || p.max_output_tokens order by p.model_route)
        from ops.agent_run_route_policies() p)
     is distinct from array['economy=2000', 'reasoning=25000', 'standard=8000'] then
    raise exception 'C2: the route output ceilings drifted from the reviewed ones';
  end if;
end
$$;

-- C3. A real start records the price version of its own model and reserves the
--     worst case of the very context its claim handed out, adversarial text included;
--     the worker's usage report then settles the charge at the estimate.
do $$
declare
  v_run      uuid;
  v_claim    jsonb;
  v_context  jsonb;
  v_state    text;
  v_expected bigint;
  r          ops.agent_runs;
begin
  v_run := pg_temp.leased_run('rg1d-c-start', 'tenant_a', 'task_cost', 'agent_a1');
  perform pg_temp.as_worker();
  v_claim := ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'rg1d-c-inside', 'task_assessment.v1', repeat('f', 64), 8000);
  perform pg_temp.as_owner();
  v_context := v_claim - 'action' - 'agent_run_id' - 'capability' - 'model_route';
  v_expected := ops.agent_run_reservation_micros(pg_temp.id('price_c_inside'),
                                                 ops.agent_run_input_token_ceiling(v_context), 8000);
  r := pg_temp.run(v_run);
  if v_state is distinct from 'running' or r.price_id is distinct from pg_temp.id('price_c_inside')
     or r.reserved_cost_micros is distinct from v_expected or r.charged_cost_micros is distinct from v_expected
     or r.estimated_cost_micros is not null then
    raise exception 'C3: a start did not record its own model''s price and the reservation of the context it handed out (start %, price %, reserved % expected %, charged %, estimated %)',
      v_state, r.price_id, r.reserved_cost_micros, v_expected, r.charged_cost_micros, r.estimated_cost_micros;
  end if;
  if v_expected is distinct from pg_temp.expected_reservation(v_run, pg_temp.id('price_c_inside')) then
    raise exception 'C3: this suite''s reservation mirror disagrees with the start; every admission case below would be miscalibrated';
  end if;
  if ops.agent_run_input_token_ceiling(v_context) < octet_length(v_claim::text)
     or octet_length(v_claim ->> 'task') < 30000 then
    raise exception 'C3: the input ceiling (%) does not bound the adversarial context the worker was handed (% bytes)',
      ops.agent_run_input_token_ceiling(v_context), octet_length(v_claim::text);
  end if;
  perform pg_temp.remember_number('reservation_cost', v_expected);

  v_state := pg_temp.worker(format(
    'select ops.complete_agent_run(%L::jsonb, ''rg1d-c-inside'', ''completed'', ''req-c3'', ''resp-c3'', 1000, 500, 1500, 200, 100, 40)',
    pg_temp.valid_result()));
  r := pg_temp.run(v_run);
  if v_state is distinct from 'succeeded' or r.estimated_cost_micros is distinct from 5700
     or r.charged_cost_micros is distinct from 5700 or r.reserved_cost_micros is distinct from v_expected then
    raise exception 'C3: the worker''s usage report did not settle the charge at the estimate (%, estimated %, charged %)',
      v_state, r.estimated_cost_micros, r.charged_cost_micros;
  end if;
  perform pg_temp.remember('run_c_start', v_run);
end
$$;

-- C4. The guard derives the charge and the estimate on a raw owner UPDATE too: a
--     caller's own figures are overwritten, and a charge above its reservation is
--     recorded as it is.
do $$
declare
  v_run uuid;
  r     ops.agent_runs;
begin
  v_run := pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_cost', 'agent_a1');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_inside'), 1000)
                                    || ', charged_cost_micros = 5, estimated_cost_micros = 7');
  r := pg_temp.run(v_run);
  if r.charged_cost_micros is distinct from 1000 or r.estimated_cost_micros is not null or r.started_at is distinct from now() then
    raise exception 'C4: a raw start kept a caller''s charge or estimate (charged %, estimated %)',
      r.charged_cost_micros, r.estimated_cost_micros;
  end if;
  perform pg_temp.raw_update(v_run, format(
    'status = ''succeeded'', result = %L, input_tokens = 1000, cached_input_tokens = 200, output_tokens = 500, '
    || 'reasoning_tokens = 100, total_tokens = 1500, estimated_cost_micros = 1, charged_cost_micros = 2',
    pg_temp.valid_result()));
  r := pg_temp.run(v_run);
  if r.estimated_cost_micros is distinct from 5700 or r.charged_cost_micros is distinct from 5700
     or r.reserved_cost_micros is distinct from 1000 then
    raise exception 'C4: a raw settlement kept a caller''s figures instead of deriving them (estimated %, charged %, reserved %)',
      r.estimated_cost_micros, r.charged_cost_micros, r.reserved_cost_micros;
  end if;
end
$$;

-- C5. The charge, decided status first, for every rule, on runs that reserved 1000.
do $$
declare
  v_case record;
  v_run  uuid;
  r      ops.agent_runs;
  v_n    integer := 0;
begin
  for v_case in
    select * from (values
      ('an indeterminate run with no usage is charged its reservation',
       $s$status = 'indeterminate', error_category = 'timeout'$s$, null::bigint, 1000::bigint),
      ('an indeterminate run below its reservation is still charged the reservation',
       $s$status = 'indeterminate', error_category = 'transport', input_tokens = 10, output_tokens = 10$s$, 100, 1000),
      ('an indeterminate run above its reservation is charged its estimate',
       $s$status = 'indeterminate', error_category = 'provider_5xx', input_tokens = 1000, cached_input_tokens = 200,
          output_tokens = 500, reasoning_tokens = 100, total_tokens = 1500$s$, 5700, 5700),
      ('a success below its reservation is charged its estimate',
       $s$status = 'succeeded', result = @result, input_tokens = 10, output_tokens = 10$s$, 100, 100),
      ('a success with incomplete usage is charged its reservation',
       $s$status = 'succeeded', result = @result, input_tokens = 10$s$, null, 1000),
      ('a failure with complete usage is charged its estimate',
       $s$status = 'failed', error_category = 'schema_validation', input_tokens = 10, output_tokens = 10$s$, 100, 100),
      ('an authentication refusal with no body is charged nothing',
       $s$status = 'failed', error_category = 'authentication'$s$, null, 0),
      ('an invalid request refusal with no body is charged nothing',
       $s$status = 'failed', error_category = 'invalid_request'$s$, null, 0),
      ('a configuration refusal with no body is charged nothing',
       $s$status = 'failed', error_category = 'configuration'$s$, null, 0),
      ('a rate limit refusal with no body is charged nothing',
       $s$status = 'failed', error_category = 'rate_limit'$s$, null, 0),
      ('a refusal that only carries a request id is charged nothing',
       $s$status = 'failed', error_category = 'rate_limit', provider_request_id = 'req-1'$s$, null, 0),
      ('a refusal that carries a provider response id is charged its reservation',
       $s$status = 'failed', error_category = 'authentication', provider_response_id = 'resp-1'$s$, null, 1000),
      ('a refusal that carries a response model is charged its reservation',
       $s$status = 'failed', error_category = 'invalid_request', response_model = 'rg1d-c-inside'$s$, null, 1000),
      ('a refusal with partial usage is charged its reservation',
       $s$status = 'failed', error_category = 'rate_limit', input_tokens = 10$s$, null, 1000),
      ('a refusal reporting only cached tokens is charged its reservation',
       $s$status = 'failed', error_category = 'configuration', cached_input_tokens = 0$s$, null, 1000),
      ('a refusal reporting only reasoning tokens is charged its reservation',
       $s$status = 'failed', error_category = 'configuration', reasoning_tokens = 0$s$, null, 1000),
      ('a refusal reporting only a total is charged its reservation',
       $s$status = 'failed', error_category = 'configuration', total_tokens = 0$s$, null, 1000),
      ('a refusal with complete usage is charged its estimate',
       $s$status = 'failed', error_category = 'rate_limit', input_tokens = 10, output_tokens = 10$s$, 100, 100),
      ('an invalid response with no usage is charged its reservation',
       $s$status = 'failed', error_category = 'invalid_response'$s$, null, 1000),
      ('a contract failure with no usage is charged its reservation',
       $s$status = 'failed', error_category = 'schema_validation'$s$, null, 1000)
    ) as c (label, settle, estimated, charged)
  loop
    v_run := pg_temp.raw_started('rg1d-c-inside', 'price_c_inside', 1000);
    if (pg_temp.run(v_run)).charged_cost_micros is distinct from 1000 then
      raise exception 'C5: a running run is not charged its reservation';
    end if;
    perform pg_temp.raw_update(v_run, replace(v_case.settle, '@result', quote_literal(pg_temp.valid_result()::text)));
    r := pg_temp.run(v_run);
    if r.estimated_cost_micros is distinct from v_case.estimated or r.charged_cost_micros is distinct from v_case.charged then
      raise exception 'C5: % — estimated %, charged % (expected %, %)',
        v_case.label, r.estimated_cost_micros, r.charged_cost_micros, v_case.estimated, v_case.charged;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> 20 then
    raise exception 'C5: % charge rules were checked, expected 20; a case was lost', v_n;
  end if;
end
$$;

-- C6. Through the worker: an HTTP refusal is charged nothing; a 200 that reported a
--     failure (it carries a response id) and an ambiguous server error are charged
--     their reservation.
do $$
declare
  v_case  record;
  v_run   uuid;
  v_state text;
  r       ops.agent_runs;
  c_reserved constant bigint := pg_temp.number('reservation_cost');
begin
  for v_case in
    select * from (values
      ('c6-401', $q$select ops.fail_agent_run('authentication', 'http_401', null, 'req-401', null, null, null, null, null, null, 12)$q$,
       'failed', 0::bigint),
      ('c6-429', $q$select ops.fail_agent_run('rate_limit', 'http_429', null, 'req-429', null, null, null, null, null, null, 12)$q$,
       'failed', 0),
      ('c6-200-rate-limit', $q$select ops.fail_agent_run('rate_limit', 'terminal_rate_limit', 'rg1d-c-inside', 'req-200', 'resp-200', null, null, null, null, null, 12)$q$,
       'failed', c_reserved),
      ('c6-200-failed', $q$select ops.fail_agent_run('invalid_response', 'status_failed', 'rg1d-c-inside', 'req-200', 'resp-200', null, null, null, null, null, 12)$q$,
       'failed', c_reserved),
      ('c6-503', $q$select ops.fail_agent_run('provider_5xx', 'http_503', null, 'req-503', null, null, null, null, null, null, 12)$q$,
       'indeterminate', c_reserved)
    ) as c (key, statement, status, charged)
  loop
    v_run := pg_temp.leased_run('rg1d-' || v_case.key, 'tenant_a', 'task_cost', 'agent_a1');
    v_state := pg_temp.start('rg1d-c-inside');
    if v_state is distinct from 'running' then
      raise exception 'C6: % did not start (%); this case would prove nothing', v_case.key, v_state;
    end if;
    v_state := pg_temp.worker(v_case.statement);
    r := pg_temp.run(v_run);
    if v_state is distinct from v_case.status or r.charged_cost_micros is distinct from v_case.charged
       or r.estimated_cost_micros is not null then
      raise exception 'C6: the worker''s % settled as % charged %, expected % charged %',
        v_case.key, v_state, r.charged_cost_micros, v_case.status, v_case.charged;
    end if;
  end loop;
end
$$;

-- C7. The update guard: a start names the price version of its own provider and model
--     and a reservation, both then fixed; a finished run's cost is immutable; a run
--     that never started carries no cost.
do $$
declare
  v_pending  uuid := pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_cost', 'agent_a1');
  v_running  uuid := pg_temp.raw_started('rg1d-c-inside', 'price_c_inside', 1000);
  v_finished uuid := pg_temp.id('run_c_start');
  v_case     record;
  v_n        integer := 0;
begin
  for v_case in
    select * from (values
      ('C7 a start priced by another model''s version', v_pending,
       pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_ontop'), 1000)),
      ('C7 a start priced by another provider''s version', v_pending,
       pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_other'), 1000)),
      ('C7 a start with no price version', v_pending,
       replace(pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_inside'), 1000),
               format('price_id = %L', pg_temp.id('price_c_inside')), 'price_id = null')),
      ('C7 a start priced by an unknown version', v_pending,
       pg_temp.start_facts('rg1d-c-inside', gen_random_uuid(), 1000)),
      ('C7 a start with no reservation', v_pending,
       replace(pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_inside'), 1000),
               'reserved_cost_micros = 1000', 'reserved_cost_micros = null')),
      ('C7 a start with a negative reservation', v_pending,
       pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_inside'), -1)),
      ('C7 changing a running run''s charge', v_running, 'charged_cost_micros = 0'),
      ('C7 changing a running run''s estimate', v_running, 'estimated_cost_micros = 0'),
      ('C7 changing a running run''s reservation', v_running, 'reserved_cost_micros = 1'),
      ('C7 changing a running run''s price version', v_running, format('price_id = %L', pg_temp.id('price_base'))),
      ('C7 changing the reservation while settling', v_running,
       $s$status = 'failed', error_category = 'rate_limit', reserved_cost_micros = 0$s$),
      ('C7 changing the price version while settling', v_running,
       format($s$status = 'indeterminate', error_category = 'timeout', price_id = %L$s$, pg_temp.id('price_c_ontop'))),
      ('C7 changing a finished run''s charge', v_finished, 'charged_cost_micros = 0'),
      ('C7 a run cancelled before its start carrying a price', v_pending,
       format($s$status = 'cancelled', error_category = 'refused', error_code = 'rg1d_refused', price_id = %L$s$,
              pg_temp.id('price_c_inside'))),
      ('C7 a run cancelled before its start carrying a reservation', v_pending,
       $s$status = 'cancelled', error_category = 'refused', error_code = 'rg1d_refused', reserved_cost_micros = 1$s$),
      ('C7 a run failed before its start carrying a charge', v_pending,
       $s$status = 'failed', error_category = 'configuration', charged_cost_micros = 0$s$),
      ('C7 a run failed before its start carrying an estimate', v_pending,
       $s$status = 'failed', error_category = 'configuration', estimated_cost_micros = 0$s$)
    ) as c (label, run_id, settle)
  loop
    perform pg_temp.expect_refused(v_case.label, 'OS409',
      format('select pg_temp.raw_update(%L, %L)', v_case.run_id, v_case.settle));
    v_n := v_n + 1;
  end loop;
  if v_n <> 17 then
    raise exception 'C7: % guard refusals ran, expected 17; a case was lost', v_n;
  end if;

  -- Controls: the same pending run starts with its own model's version, and the
  -- running one settles, once the forbidden change is left out.
  perform pg_temp.raw_update(v_pending, pg_temp.start_facts('rg1d-c-inside', pg_temp.id('price_c_inside'), 1000));
  perform pg_temp.raw_update(v_running, $s$status = 'failed', error_category = 'rate_limit'$s$);
  if pg_temp.run_status(v_pending) <> 'running' or pg_temp.run_status(v_running) <> 'failed' then
    raise exception 'C7: the control writes were refused, so the refusals above prove nothing';
  end if;
  -- No call stays in flight for tenant A: section A's arithmetic counts on it.
  perform pg_temp.raw_update(v_pending, $s$status = 'failed', error_category = 'rate_limit'$s$);
end
$$;

-- C7 structural backstop, with the update guard off.
select set_config('app.event_source', 'rg1d-raw', true);
select pg_temp.remember('run_c_backstop', pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_cost', 'agent_a1'));
select pg_temp.expect_refused_without_trigger('C7 a started run with no price version', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs
     set status = 'running', started_at = now(), provider = 'fake', model = 'rg1d-c-inside',
         prompt_version = 'task_assessment.v1', input_fingerprint = repeat('c', 64), job_attempt = 1,
         reserved_cost_micros = 1, charged_cost_micros = 1
   where id = %L
$q$, pg_temp.id('run_c_backstop')));
select pg_temp.expect_refused_without_trigger('C7 a running run with an estimate', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs
     set status = 'running', started_at = now(), provider = 'fake', model = 'rg1d-c-inside',
         prompt_version = 'task_assessment.v1', input_fingerprint = repeat('c', 64), job_attempt = 1,
         price_id = %L, reserved_cost_micros = 1, charged_cost_micros = 1, estimated_cost_micros = 1
   where id = %L
$q$, pg_temp.id('price_c_inside'), pg_temp.id('run_c_backstop')));
select pg_temp.expect_refused_without_trigger('C7 a negative charge', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs
     set status = 'running', started_at = now(), provider = 'fake', model = 'rg1d-c-inside',
         prompt_version = 'task_assessment.v1', input_fingerprint = repeat('c', 64), job_attempt = 1,
         price_id = %L, reserved_cost_micros = 1, charged_cost_micros = -1
   where id = %L
$q$, pg_temp.id('price_c_inside'), pg_temp.id('run_c_backstop')));
select set_config('app.event_source', '', true);

-- C8 (P9). A price version a run references cannot be deleted; an unreferenced one
--     can, so the refusal is the reference and not the table.
select pg_temp.expect_refused('C8 deleting a price version a run references', '23503',
  format('delete from ops.model_prices where id = %L', pg_temp.id('price_c_inside')));
do $$
begin
  begin
    delete from ops.model_prices where id = pg_temp.id('price_p');
    if found then
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    end if;
    raise exception 'C8: the unreferenced control version was not deleted, so the refusal above proves nothing';
  exception when sqlstate 'C1CAC' then null;
  end;
end
$$;

-- ===========================================================================
-- L. LIMITS. Tenant C has no limit until this section sets one.
-- ===========================================================================

-- L1-L5. Set, replay, supersede, a fixed zone, and retirement.
do $$
declare
  tc  constant uuid := pg_temp.id('tenant_c');
  cc1 constant uuid := pg_temp.id('company_c1');
  v1 uuid;
  v2 uuid;
  v3 uuid;
  v_again uuid;
  r ops.spend_limits;
begin
  v1 := ops.set_spend_limit('tenant', 5000, 'UTC', 'rg1d-test: first budget', 'rg1d-owner', tc);
  v_again := ops.set_spend_limit('tenant', 5000, 'UTC', 'rg1d-test: the same budget again', 'rg1d-other-owner', tc);
  select * into r from ops.spend_limits l where l.id = v1;
  if v_again is distinct from v1 or r.reason <> 'rg1d-test: first budget' or r.set_by <> 'rg1d-owner'
     or r.ended_at is not null or r.set_at <> now() or r.timezone <> 'UTC' or r.daily_limit_micros <> 5000
     or (select count(*) from ops.spend_limits l where l.tenant_id = tc) <> 1 then
    raise exception 'L1: setting the same limit again did not return the version in force unchanged (%, %)', v_again, to_jsonb(r);
  end if;

  v2 := ops.set_spend_limit('tenant', 6000, 'UTC', 'rg1d-test: a larger budget', 'rg1d-owner', tc);
  select * into r from ops.spend_limits l where l.id = v1;
  if v2 is not distinct from v1 or r.ended_at is distinct from now() or r.ended_by <> 'rg1d-owner'
     or r.end_reason <> 'superseded' or r.reason <> 'rg1d-test: first budget' or r.daily_limit_micros <> 5000 then
    raise exception 'L2: a new value did not supersede the version in force, recorded on it (%)', to_jsonb(r);
  end if;
  if pg_temp.active_limit('tenant', tc) is distinct from v2
     or (select count(*) from ops.spend_limits l where l.tenant_id = tc and l.ended_at is null) <> 1 then
    raise exception 'L2: a target does not have exactly one version in force after a change';
  end if;

  perform pg_temp.expect_refused('L3 a new version in another time zone', 'OS409', format($q$
    select ops.set_spend_limit('tenant', 7000, 'America/Sao_Paulo', 'rg1d-test: moved', 'rg1d-owner', %L)
  $q$, tc));
  perform pg_temp.expect_refused('L3 the same value in another time zone', 'OS409', format($q$
    select ops.set_spend_limit('tenant', 6000, 'America/Sao_Paulo', 'rg1d-test: moved', 'rg1d-owner', %L)
  $q$, tc));
  perform pg_temp.expect_refused('L4 an unknown time zone', 'OS400', format($q$
    select ops.set_spend_limit('tenant', 7000, 'Mars/Olympus_Mons', 'rg1d-test: unknown zone', 'rg1d-owner', %L)
  $q$, tc));
  perform pg_temp.expect_refused('L4 no time zone', 'OS400', format($q$
    select ops.set_spend_limit('tenant', 7000, null, 'rg1d-test: no zone', 'rg1d-owner', %L)
  $q$, tc));
  perform pg_temp.expect_refused('L4 a raw limit in an unknown time zone', 'OS400', $q$
    insert into ops.spend_limits (scope, daily_limit_micros, timezone, reason, set_by)
    values ('global', 1, 'Mars/Olympus_Mons', 'rg1d-test: unknown zone', 'rg1d-owner')
  $q$);
  perform pg_temp.expect_refused('L4 a raw limit whose time zone is not a name', 'OS400', $q$
    insert into ops.spend_limits (scope, daily_limit_micros, timezone, reason, set_by)
    values ('global', 1, 'UTC; select 1', 'rg1d-test: injected zone', 'rg1d-owner')
  $q$);
  if pg_temp.active_limit('tenant', tc) is distinct from v2
     or (select l.daily_limit_micros from ops.spend_limits l where l.id = v2) <> 6000 then
    raise exception 'L3: a refused change altered the version in force';
  end if;

  if ops.retire_spend_limit(v2, 'rg1d-test: budget withdrawn', 'rg1d-owner') is not true then
    raise exception 'L5: retiring the version in force was not reported';
  end if;
  if ops.retire_spend_limit(v2, 'rg1d-test: withdrawn again', 'rg1d-owner') is not false then
    raise exception 'L5: retiring an ended version was reported as a retirement';
  end if;
  select * into r from ops.spend_limits l where l.id = v2;
  if r.ended_at is distinct from now() or r.ended_by <> 'rg1d-owner' or r.end_reason <> 'rg1d-test: budget withdrawn'
     or r.reason <> 'rg1d-test: a larger budget' then
    raise exception 'L5: a retirement was not recorded whole, once (%)', to_jsonb(r);
  end if;
  if pg_temp.admission(tc, cc1, 1) <> 'budget_unconfigured:-' then
    raise exception 'L5: a tenant whose budget was retired is not refused as unconfigured (%)', pg_temp.admission(tc, cc1, 1);
  end if;

  -- After a retirement, a new zone is a deliberate new start.
  v3 := ops.set_spend_limit('tenant', 8000, 'America/Sao_Paulo', 'rg1d-test: a new zone', 'rg1d-owner', tc);
  if (select l.timezone from ops.spend_limits l where l.id = v3) <> 'America/Sao_Paulo' then
    raise exception 'L5: a limit set after a retirement did not take its new time zone';
  end if;
  perform ops.retire_spend_limit(v3, 'rg1d-test: back to UTC', 'rg1d-owner');
  perform pg_temp.remember('limit_c_first', v1);
  perform pg_temp.remember('limit_c_tenant', ops.set_spend_limit('tenant', 1000000000, 'UTC', 'rg1d-test: tenant C budget', 'rg1d-owner', tc));
end
$$;

-- L6. A retirement is an owner act with who and why.
select pg_temp.expect_refused('L6 retiring without a reason', 'OS400',
  format($q$select ops.retire_spend_limit(%L, null, 'rg1d-owner')$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L6 retiring with a blank reason', 'OS400',
  format($q$select ops.retire_spend_limit(%L, '   ', 'rg1d-owner')$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L6 retiring with an over-long reason', 'OS400',
  format($q$select ops.retire_spend_limit(%L, repeat('r', 501), 'rg1d-owner')$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L6 retiring without an actor', 'OS400',
  format($q$select ops.retire_spend_limit(%L, 'rg1d-test: why', null)$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L6 retiring as a malformed actor', 'OS400',
  format($q$select ops.retire_spend_limit(%L, 'rg1d-test: why', 'The Owner')$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L6 retiring an unknown limit', 'OS404',
  $q$select ops.retire_spend_limit('00000000-0000-4000-8000-000000000000', 'rg1d-test: why', 'rg1d-owner')$q$);

-- L7, L8. An active version is never deleted; the table is never truncated.
select pg_temp.expect_refused('L7 deleting the limit in force', 'OS409',
  format('delete from ops.spend_limits where id = %L', pg_temp.id('limit_c_tenant')));
do $$
begin
  begin
    delete from ops.spend_limits where id = pg_temp.id('limit_c_first');
    if found then
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    end if;
    raise exception 'L7: the ended, unreferenced control version was not deleted, so the refusal above proves nothing';
  exception when sqlstate 'C1CAC' then null;
  end;
end
$$;
select pg_temp.expect_refused('L8 truncating the spend limits', 'OS409', 'truncate ops.spend_limits cascade');

-- L9. A version changes only by its one ending and by redacting its free text.
select pg_temp.expect_refused('L9 rewriting a limit''s amount', 'OS409',
  format('update ops.spend_limits set daily_limit_micros = 1 where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 rewriting a limit''s time zone', 'OS409',
  format('update ops.spend_limits set timezone = ''America/Sao_Paulo'' where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 re-scoping a limit', 'OS409',
  format('update ops.spend_limits set scope = ''global'', tenant_id = null where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 moving a limit to another tenant', 'OS409',
  format('update ops.spend_limits set tenant_id = %L where id = %L', pg_temp.id('tenant_a'), pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 re-attributing a limit', 'OS409',
  format('update ops.spend_limits set set_by = ''someone-else'' where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 backdating a limit', 'OS409',
  format('update ops.spend_limits set set_at = set_at - interval ''1 day'' where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 rewriting why a limit was set', 'OS409',
  format('update ops.spend_limits set reason = ''rg1d-test: rewritten'' where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 an ending that rewrites why the limit was set', 'OS409',
  format($q$update ops.spend_limits set ended_by = 'rg1d-owner', end_reason = 'rg1d-test: ended', reason = 'rg1d-test: other'
            where id = %L$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 an ending with no reason', '23514',
  format($q$update ops.spend_limits set ended_by = 'rg1d-owner' where id = %L$q$, pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 an ending by timestamp alone', 'OS409',
  format('update ops.spend_limits set ended_at = now() where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 a no-op update of a limit', 'OS409',
  format('update ops.spend_limits set reason = reason where id = %L', pg_temp.id('limit_c_tenant')));
select pg_temp.expect_refused('L9 re-attributing an ended limit''s ending', 'OS409',
  format($q$update ops.spend_limits set ended_by = 'someone-else' where id = %L$q$, pg_temp.id('limit_c_first')));
select pg_temp.expect_refused('L9 rewriting why a limit ended', 'OS409',
  format($q$update ops.spend_limits set end_reason = 'rg1d-test: changed my mind' where id = %L$q$, pg_temp.id('limit_c_first')));
select pg_temp.expect_refused('L9 re-arming an ended limit', 'OS409',
  format('update ops.spend_limits set ended_by = null, end_reason = null, ended_at = null where id = %L', pg_temp.id('limit_c_first')));
select pg_temp.expect_refused('L9 a raw limit born ended', 'OS409', $q$
  insert into ops.spend_limits (scope, daily_limit_micros, timezone, reason, set_by, ended_at, ended_by, end_reason)
  values ('global', 1, 'UTC', 'rg1d-test: born ended', 'rg1d-owner', now(), 'rg1d-owner', 'rg1d-test: ended')
$q$);
do $$
declare
  v_ended  timestamptz;
  v_set    timestamptz;
  v_reason text;
  v_end_reason text;
begin
  -- An ending is stamped by the database clock.
  begin
    update ops.spend_limits
       set ended_by = 'rg1d-owner', end_reason = 'rg1d-test: backdated ending', ended_at = now() - interval '1 year'
     where id = pg_temp.id('limit_c_tenant')
     returning ended_at into v_ended;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_ended is distinct from now() then
    raise exception 'L9: a limit''s ending was recorded at %, not by the database clock', v_ended;
  end if;
  -- So is a raw setting.
  begin
    insert into ops.spend_limits (scope, tenant_id, daily_limit_micros, timezone, reason, set_by, set_at)
    values ('tenant', pg_temp.id('tenant_a'), 1, 'UTC', 'rg1d-test: backdated', 'rg1d-owner', now() - interval '1 year')
    returning set_at into v_set;
    raise exception 'L9: a second limit in force for tenant A was stored';
  exception when unique_violation then null;
  end;
  begin
    insert into ops.spend_limits (scope, company_id, tenant_id, daily_limit_micros, timezone, reason, set_by, set_at)
    values ('company', pg_temp.id('company_c2'), pg_temp.id('tenant_c'), 1, 'UTC', 'rg1d-test: backdated', 'rg1d-owner',
            now() - interval '1 year')
    returning set_at into v_set;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_set is distinct from now() then
    raise exception 'L9: a limit was set at %, not by the database clock', v_set;
  end if;
  -- Redaction: the free text of a limit in force and of an ended one.
  begin
    update ops.spend_limits set reason = '[redacted]' where id = pg_temp.id('limit_c_tenant') returning reason into v_reason;
    update ops.spend_limits set end_reason = '[redacted]' where id = pg_temp.id('limit_c_first') returning end_reason into v_end_reason;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_reason is distinct from '[redacted]' or v_end_reason is distinct from '[redacted]' then
    raise exception 'L9: a limit''s free text could not be redacted (% / %)', v_reason, v_end_reason;
  end if;
end
$$;
set local session_replication_role = replica;
do $$
begin
  begin
    update ops.spend_limits set daily_limit_micros = 1 where id = pg_temp.id('limit_c_tenant');
    raise exception 'L9: replica mode silenced spend_limits_guard_update; the guard must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    delete from ops.spend_limits where id = pg_temp.id('limit_c_tenant');
    raise exception 'L9: replica mode silenced spend_limits_guard_delete; the guard must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    truncate ops.spend_limits cascade;
    raise exception 'L9: replica mode silenced spend_limits_refuse_truncate; the guard must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
end
$$;
set local session_replication_role = origin;

-- L10. A limit's target matches its scope, and a company limit names its own
--      tenant's company.
select pg_temp.expect_refused('L10 an unknown scope', 'OS400',
  $q$select ops.set_spend_limit('planet', 1, 'UTC', 'rg1d-test: shape', 'rg1d-owner')$q$);
select pg_temp.expect_refused('L10 a global limit naming a tenant', 'OS400',
  format($q$select ops.set_spend_limit('global', 1, 'UTC', 'rg1d-test: shape', 'rg1d-owner', %L)$q$, pg_temp.id('tenant_c')));
select pg_temp.expect_refused('L10 a tenant limit naming a company', 'OS400',
  format($q$select ops.set_spend_limit('tenant', 1, 'UTC', 'rg1d-test: shape', 'rg1d-owner', %L, %L)$q$,
         pg_temp.id('tenant_c'), pg_temp.id('company_c1')));
select pg_temp.expect_refused('L10 a company limit without its company', 'OS400',
  format($q$select ops.set_spend_limit('company', 1, 'UTC', 'rg1d-test: shape', 'rg1d-owner', %L)$q$, pg_temp.id('tenant_c')));
select pg_temp.expect_refused('L10 a company limit without its tenant', 'OS401',
  format($q$select ops.set_spend_limit('company', 1, 'UTC', 'rg1d-test: shape', 'rg1d-owner', null, %L)$q$,
         pg_temp.id('company_c1')));
select pg_temp.expect_refused('L10 a company limit for another tenant''s company', 'OS404',
  format($q$select ops.set_spend_limit('company', 1, 'UTC', 'rg1d-test: cross', 'rg1d-owner', %L, %L)$q$,
         pg_temp.id('tenant_c'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('L10 a tenant limit for an unknown tenant', 'OS404',
  $q$select ops.set_spend_limit('tenant', 1, 'UTC', 'rg1d-test: cross', 'rg1d-owner', '00000000-0000-4000-8000-000000000000')$q$);
select pg_temp.expect_refused('L10 a negative limit', 'OS400',
  format($q$select ops.set_spend_limit('tenant', -1, 'UTC', 'rg1d-test: shape', 'rg1d-owner', %L)$q$, pg_temp.id('tenant_c')));
select pg_temp.expect_refused('L10 a limit beyond the range', 'OS400',
  format($q$select ops.set_spend_limit('tenant', 1000000000000001, 'UTC', 'rg1d-test: shape', 'rg1d-owner', %L)$q$,
         pg_temp.id('tenant_c')));
select pg_temp.expect_refused('L10 a limit with no reason', 'OS400',
  format($q$select ops.set_spend_limit('tenant', 1, 'UTC', '  ', 'rg1d-owner', %L)$q$, pg_temp.id('tenant_c')));
select pg_temp.expect_refused('L10 a limit set by a malformed actor', 'OS400',
  format($q$select ops.set_spend_limit('tenant', 1, 'UTC', 'rg1d-test: shape', 'The Owner', %L)$q$, pg_temp.id('tenant_c')));
select pg_temp.expect_refused('L10 a raw company limit for another tenant''s company', '23503', format($q$
  insert into ops.spend_limits (scope, tenant_id, company_id, daily_limit_micros, timezone, reason, set_by)
  values ('company', %L, %L, 1, 'UTC', 'rg1d-test: cross', 'rg1d-owner')
$q$, pg_temp.id('tenant_c'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('L10 a raw global limit naming a tenant', '23514', format($q$
  insert into ops.spend_limits (scope, tenant_id, daily_limit_micros, timezone, reason, set_by)
  values ('global', %L, 1, 'UTC', 'rg1d-test: shape', 'rg1d-owner')
$q$, pg_temp.id('tenant_c')));

-- L11. The day's spend against every limit in force.
do $$
declare
  tc  constant uuid := pg_temp.id('tenant_c');
  cc1 constant uuid := pg_temp.id('company_c1');
  v_company_limit uuid;
  v_tenant_limit  uuid := pg_temp.id('limit_c_tenant');
  v_exhausted     uuid;
  v_run uuid;
  s     record;
begin
  v_company_limit := ops.set_spend_limit('company', 1000000000, 'UTC', 'rg1d-test: company C1', 'rg1d-owner', tc, cc1);

  -- In company C1: one running (3000), one known (150), one unknown (2000), one
  -- refusal charged nothing, and one run the tenant budget refused.
  v_run := pg_temp.raw_pending_run('tenant_c', 'company_c1', 'dept_c1', 'task_c1', 'agent_c1');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts('rg1d-model', pg_temp.id('price_base'), 3000));
  v_run := pg_temp.raw_pending_run('tenant_c', 'company_c1', 'dept_c1', 'task_c1', 'agent_c1');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts('rg1d-model', pg_temp.id('price_base'), 1000));
  perform pg_temp.raw_update(v_run, format(
    'status = ''succeeded'', result = %L, input_tokens = 100, output_tokens = 50, total_tokens = 150', pg_temp.valid_result()));
  v_run := pg_temp.raw_pending_run('tenant_c', 'company_c1', 'dept_c1', 'task_c1', 'agent_c1');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts('rg1d-model', pg_temp.id('price_base'), 2000));
  perform pg_temp.raw_update(v_run, $s$status = 'indeterminate', error_category = 'timeout'$s$);
  v_run := pg_temp.raw_pending_run('tenant_c', 'company_c1', 'dept_c1', 'task_c1', 'agent_c1');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts('rg1d-model', pg_temp.id('price_base'), 4000));
  perform pg_temp.raw_update(v_run, $s$status = 'failed', error_category = 'authentication'$s$);
  v_run := pg_temp.raw_pending_run('tenant_c', 'company_c1', 'dept_c1', 'task_c1', 'agent_c1');
  perform pg_temp.raw_update(v_run, format(
    $s$status = 'cancelled', error_category = 'refused', error_code = 'budget_exhausted', spend_limit_id = %L$s$,
    v_tenant_limit));
  perform pg_temp.remember('run_c_refused', v_run);
  -- In company C2: one known (20).
  v_run := pg_temp.raw_pending_run('tenant_c', 'company_c2', 'dept_c2', 'task_c2', 'agent_c2');
  perform pg_temp.raw_update(v_run, pg_temp.start_facts('rg1d-model', pg_temp.id('price_base'), 500));
  perform pg_temp.raw_update(v_run, format(
    'status = ''succeeded'', result = %L, input_tokens = 10, output_tokens = 10', pg_temp.valid_result()));

  select * into s from ops.spend_status() x where x.limit_id = v_tenant_limit;
  if s is null or s.scope <> 'tenant' or s.tenant_id <> tc or s.company_id is not null
     or s.window_start <> ops.spend_window_start('UTC', now())
     or s.charged_micros <> 5170 or s.settled_micros <> 2170 or s.estimated_micros <> 170
     or s.running_runs <> 1 or s.unknown_cost_runs <> 1
     or s.refused_runs <> 1 or s.remaining_micros <> 1000000000 - 5170 or s.settled_exhausted
     or s.new_run_admission <> 'conditional' then
    raise exception 'L11: the tenant budget''s status is wrong: %', to_jsonb(s);
  end if;
  select * into s from ops.spend_status() x where x.limit_id = v_company_limit;
  if s is null or s.scope <> 'company' or s.company_id <> cc1
     or s.charged_micros <> 5150 or s.settled_micros <> 2150 or s.estimated_micros <> 150
     or s.running_runs <> 1 or s.unknown_cost_runs <> 1
     or s.refused_runs <> 0 or s.remaining_micros <> 1000000000 - 5150 or s.settled_exhausted
     or s.new_run_admission <> 'conditional' then
    raise exception 'L11: the company limit''s status is wrong, or counts another company''s runs: %', to_jsonb(s);
  end if;
  select * into s from ops.spend_status() x where x.scope = 'global';
  if s is null or s.charged_micros <> pg_temp.charged('global') or s.charged_micros < 5170 then
    raise exception 'L11: the global ceiling''s status does not count every tenant: %', to_jsonb(s);
  end if;
  if exists (select 1 from ops.spend_status() x where x.limit_id = pg_temp.id('limit_c_first')) then
    raise exception 'L11: the spend status reports a limit that is no longer in force';
  end if;
  select * into s from ops.spend_status(now() + interval '1 day') x where x.limit_id = v_tenant_limit;
  if s.charged_micros <> 0 or s.refused_runs <> 0 or s.remaining_micros <> 1000000000 then
    raise exception 'L11: tomorrow''s status counts today''s spend: %', to_jsonb(s);
  end if;

  -- A version that today's charges reach only with the call in flight has nothing
  -- left to admit for a positive reservation, but is not exhausted: exhaustion is
  -- settled spend, which on the global ceiling is one of the two conditions the
  -- ceiling sweep trips on (E3 covers the other, a refusal). It still blocks the
  -- next start, so a false settled_exhausted never reads as room to start. Today's
  -- refusal by the version before it is not its own.
  v_exhausted := ops.set_spend_limit('tenant', 5170, 'UTC', 'rg1d-test: reached', 'rg1d-owner', tc);
  select * into s from ops.spend_status() x where x.limit_id = v_exhausted;
  if s is null or s.remaining_micros <> 0 or s.settled_exhausted or s.refused_runs <> 0
     or s.new_run_admission is distinct from 'blocked' then
    raise exception 'L11: a budget reached only with a call in flight is reported exhausted, has room left, or does not block the next start: %', to_jsonb(s);
  end if;
  -- Blocked is the admission's own rule for this limit: a reservation settled spend
  -- cannot absorb is exhausted even though settled_exhausted is false, a smaller one
  -- is contended, and only a zero reservation (a zero-priced model) is admitted.
  if pg_temp.admission(tc, cc1, 3001) <> 'budget_exhausted:' || v_exhausted
     or pg_temp.admission(tc, cc1, 3000) <> 'budget_contended:' || v_exhausted
     or pg_temp.admission(tc, cc1, 0) <> 'admitted:-' then
    raise exception 'L11: a blocked budget does not match what admission does (3001 %, 3000 %, 0 %)',
      pg_temp.admission(tc, cc1, 3001), pg_temp.admission(tc, cc1, 3000), pg_temp.admission(tc, cc1, 0);
  end if;
  -- A version that today's SETTLED spend reaches is exhausted, and blocks.
  v_exhausted := ops.set_spend_limit('tenant', 2170, 'UTC', 'rg1d-test: settled reached', 'rg1d-owner', tc);
  select * into s from ops.spend_status() x where x.limit_id = v_exhausted;
  if s is null or s.remaining_micros <> 2170 - 5170 or not s.settled_exhausted or s.refused_runs <> 0
     or s.new_run_admission is distinct from 'blocked' then
    raise exception 'L11: a budget that today''s settled spend reaches is not reported exhausted and blocked: %', to_jsonb(s);
  end if;

  -- One micro-USD above today's charges leaves room for a reservation of one, no more:
  -- conditional, never blocked, and never a promise that a real run fits.
  v_exhausted := ops.set_spend_limit('tenant', 5171, 'UTC', 'rg1d-test: one left', 'rg1d-owner', tc);
  select * into s from ops.spend_status() x where x.limit_id = v_exhausted;
  if s is null or s.remaining_micros <> 1 or s.settled_exhausted
     or s.new_run_admission is distinct from 'conditional' then
    raise exception 'L11: a budget with one micro-USD left is not reported conditional: %', to_jsonb(s);
  end if;

  -- The superseded version is referenced by the run it refused.
  perform pg_temp.expect_refused('L7 deleting an ended limit a run names', '23503',
    format('delete from ops.spend_limits where id = %L', v_tenant_limit));
end
$$;

-- ===========================================================================
-- A. ADMISSION, through ops.spend_admission and through the real request and start
--    on real leases. Every admission run is on task_adm with the base price, so all
--    of them reserve the same amount.
-- ===========================================================================

-- A1. No global ceiling: the start refuses, and so does a request, before any job.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_run   uuid;
  v_r     bigint;
  v_state text;
  r       ops.agent_runs;
begin
  v_run := pg_temp.adm_run('rg1d-a1-start');
  v_r := pg_temp.remember_number('reservation_adm', pg_temp.expected_reservation(v_run, pg_temp.id('price_base')));
  if v_r < 2 then
    raise exception 'A1: the admission reservation is %; the boundary cases below need at least 2', v_r;
  end if;
  perform pg_temp.retire_limit('global');
  if pg_temp.admission(ta, ca1, v_r) <> 'spend_ceiling_unconfigured:-' then
    raise exception 'A1: a run with no global ceiling configured was not refused as unconfigured (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.status <> 'cancelled' or r.error_category <> 'refused'
     or r.error_code <> 'spend_ceiling_unconfigured' or r.spend_limit_id is not null or r.started_at is not null
     or r.price_id is not null or r.charged_cost_micros is not null then
    raise exception 'A1: a run started with no global ceiling configured (start %, run % / %)', v_state, r.status, r.error_code;
  end if;
  if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.cancelled'] then
    raise exception 'A1: a run refused at start recorded %', pg_temp.run_event_types(v_run);
  end if;

  v_run := pg_temp.request('rg1d-a1-request', 'tenant_a', 'task_adm', 'agent_a1');
  r := pg_temp.run(v_run);
  if r.status <> 'cancelled' or r.error_code <> 'spend_ceiling_unconfigured' or r.job_id is not null
     or r.spend_limit_id is not null then
    raise exception 'A1: a request with no global ceiling configured was not refused before any job (% / % / job %)',
      r.status, r.error_code, r.job_id;
  end if;

  perform pg_temp.set_limit('global', pg_temp.huge());
  if pg_temp.admission(ta, ca1, v_r) <> 'admitted:-' then
    raise exception 'A1: the configured control was not admitted (%), so the refusals above prove nothing', pg_temp.admission(ta, ca1, v_r);
  end if;
end
$$;

-- A2. No tenant budget: that tenant is refused, and only that tenant.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_run   uuid;
  v_state text;
  r       ops.agent_runs;
begin
  v_run := pg_temp.adm_run('rg1d-a2-start');
  perform pg_temp.retire_limit('tenant', ta);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_unconfigured:-' then
    raise exception 'A2: a tenant with no budget configured was not refused as unconfigured (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  if pg_temp.admission(pg_temp.id('tenant_b'), pg_temp.id('company_b'), v_r) <> 'admitted:-' then
    raise exception 'A2: retiring tenant A''s budget changed tenant B''s admission';
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.error_code <> 'budget_unconfigured' or r.spend_limit_id is not null
     or r.started_at is not null then
    raise exception 'A2: a run started with no tenant budget configured (start %, code %)', v_state, r.error_code;
  end if;
  v_run := pg_temp.request('rg1d-a2-request', 'tenant_a', 'task_adm', 'agent_a1');
  r := pg_temp.run(v_run);
  if r.status <> 'cancelled' or r.error_code <> 'budget_unconfigured' or r.job_id is not null then
    raise exception 'A2: a request with no tenant budget configured was not refused before any job (% / %)', r.status, r.error_code;
  end if;
  perform pg_temp.set_limit('tenant', pg_temp.huge(), ta);
end
$$;

-- A3. A company limit is optional, and enforced when it exists, for its company only.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  ca2 constant uuid := pg_temp.id('company_a2');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_zero  uuid;
  v_run   uuid;
  v_state text;
  r       ops.agent_runs;
begin
  if pg_temp.admission(ta, ca1, v_r) <> 'admitted:-' then
    raise exception 'A3: a run with no company limit was not admitted (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  v_run := pg_temp.adm_run('rg1d-a3-start');
  v_zero := pg_temp.set_limit('company', 0, ta, ca1);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_exhausted:' || v_zero then
    raise exception 'A3: a company limit in force was not enforced (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  if pg_temp.admission(ta, ca2, v_r) <> 'admitted:-' then
    raise exception 'A3: company A1''s limit refused a run of company A2 (%)', pg_temp.admission(ta, ca2, v_r);
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.error_code <> 'budget_exhausted' or r.spend_limit_id is distinct from v_zero then
    raise exception 'A3: a start the company limit cannot absorb was not refused naming it (start %, code %, limit %)',
      v_state, r.error_code, r.spend_limit_id;
  end if;
  v_run := pg_temp.request('rg1d-a3-request', 'tenant_a', 'task_adm', 'agent_a1');
  r := pg_temp.run(v_run);
  if r.status <> 'cancelled' or r.error_code <> 'budget_exhausted' or r.spend_limit_id is distinct from v_zero
     or r.job_id is not null then
    raise exception 'A3: a request the company limit already refuses was not refused before any job, naming it';
  end if;

  perform pg_temp.set_limit('company', pg_temp.huge(), ta, ca1);
  if pg_temp.admission(ta, ca1, v_r) <> 'admitted:-' then
    raise exception 'A3: a larger company limit did not admit the run (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  perform pg_temp.expect_refused('A3 deleting a superseded limit version that refused runs', '23503',
    format('delete from ops.spend_limits where id = %L', v_zero));
  perform pg_temp.retire_limit('company', ta, ca1);
  perform pg_temp.remember('limit_a1_ended', v_zero);
end
$$;

-- A4. Settled spend plus the reservation above a limit is exhaustion: recorded on the
--     run, naming the limit version, at start and at request.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_limit   uuid;
  v_run     uuid;
  v_request uuid;
  v_state   text;
  r         ops.agent_runs;
begin
  if pg_temp.charged('tenant', ta) <> pg_temp.settled('tenant', ta) then
    raise exception 'A4: tenant A has a call in flight (% charged, % settled); this case would prove nothing',
      pg_temp.charged('tenant', ta), pg_temp.settled('tenant', ta);
  end if;
  v_run := pg_temp.adm_run('rg1d-a4-start');
  v_limit := pg_temp.set_limit('tenant', pg_temp.settled('tenant', ta) + v_r - 1, ta);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_exhausted:' || v_limit then
    raise exception 'A4: a reservation settled spend cannot absorb was not refused as exhausted (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  if pg_temp.admission(ta, ca1, v_r - 1) <> 'admitted:-' then
    raise exception 'A4: a reservation that exactly fills the budget was refused (%)', pg_temp.admission(ta, ca1, v_r - 1);
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.status <> 'cancelled' or r.error_category <> 'refused'
     or r.error_code <> 'budget_exhausted' or r.spend_limit_id is distinct from v_limit or r.stop_id is not null
     or r.started_at is not null or r.price_id is not null or r.reserved_cost_micros is not null
     or r.charged_cost_micros is not null then
    raise exception 'A4: a start settled spend cannot absorb was not recorded cancelled by that limit version (start %, % / % / limit %)',
      v_state, r.status, r.error_code, r.spend_limit_id;
  end if;
  if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.cancelled'] then
    raise exception 'A4: a run refused by its budget recorded %', pg_temp.run_event_types(v_run);
  end if;

  -- A request checks one micro-USD: room is room.
  v_request := pg_temp.request('rg1d-a4-request-room', 'tenant_a', 'task_adm', 'agent_a1');
  if pg_temp.run_status(v_request) <> 'pending' or pg_temp.job_of(v_request) is null then
    raise exception 'A4: a request was refused although settled spend leaves room (%)', (pg_temp.run(v_request)).error_code;
  end if;
  v_limit := pg_temp.set_limit('tenant', pg_temp.settled('tenant', ta), ta);
  v_request := pg_temp.request('rg1d-a4-request-spent', 'tenant_a', 'task_adm', 'agent_a1');
  r := pg_temp.run(v_request);
  if r.status <> 'cancelled' or r.error_code <> 'budget_exhausted' or r.spend_limit_id is distinct from v_limit
     or r.job_id is not null or r.started_at is not null then
    raise exception 'A4: a request settled spend already exhausts was not refused before any job, naming its limit (% / % / %)',
      r.status, r.error_code, r.spend_limit_id;
  end if;
  perform pg_temp.set_limit('tenant', pg_temp.huge(), ta);
end
$$;

-- A5. It fits settled spend but not beside a call in flight: the start raises OS429
--     and records nothing; a request is never refused for that; once the call
--     settles, the same start is admitted.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_flight     uuid;
  v_contended  uuid;
  v_request    uuid;
  v_limit      uuid;
  v_state      text;
  v_err        text;
  v_run_before jsonb;
  v_job_before jsonb;
begin
  v_flight := pg_temp.adm_run('rg1d-a5-in-flight');
  if pg_temp.start() is distinct from 'running' or (pg_temp.run(v_flight)).reserved_cost_micros is distinct from v_r then
    raise exception 'A5: the call in flight did not start with the expected reservation; this case would prove nothing';
  end if;
  v_contended := pg_temp.adm_run('rg1d-a5-contended');
  v_limit := pg_temp.set_limit('tenant', pg_temp.settled('tenant', ta) + v_r, ta);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_contended:' || v_limit then
    raise exception 'A5: a reservation that fits settled spend but not the calls in flight is not contended (%)',
      pg_temp.admission(ta, ca1, v_r);
  end if;

  v_run_before := pg_temp.run_state(v_contended);
  select to_jsonb(j) into v_job_before from ops.jobs j where j.id = pg_temp.job_of(v_contended);
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_err := pg_temp.attempt($q$select ops.start_agent_run('fake', 'rg1d-model', 'task_assessment.v1', repeat('f', 64), 8000)$q$);
  perform pg_temp.as_owner();
  if v_err is null or v_err not like 'OS429 %' then
    raise exception 'A5: a start that fits settled spend but not the calls in flight was not refused with OS429 (%)', v_err;
  end if;
  if pg_temp.run_state(v_contended) is distinct from v_run_before then
    raise exception 'A5: a start refused by contention recorded something on its run';
  end if;
  if (select to_jsonb(j) from ops.jobs j where j.id = pg_temp.job_of(v_contended)) is distinct from v_job_before then
    raise exception 'A5: a start refused by contention changed its job, which must stay leased to retry';
  end if;

  v_request := pg_temp.request('rg1d-a5-request', 'tenant_a', 'task_adm', 'agent_a1');
  if pg_temp.run_status(v_request) <> 'pending' or pg_temp.job_of(v_request) is null then
    raise exception 'A5: a request was refused because calls were in flight (%)', (pg_temp.run(v_request)).error_code;
  end if;

  -- The call in flight settles as a refusal charged nothing; the retried start fits.
  perform pg_temp.resume('A5', pg_temp.job_of(v_flight));
  v_state := pg_temp.worker($q$select ops.fail_agent_run('rate_limit', 'http_429', null, 'req-a5', null, null, null, null, null, null, 9)$q$);
  if v_state is distinct from 'failed' or (pg_temp.run(v_flight)).charged_cost_micros is distinct from 0 then
    raise exception 'A5: the call in flight did not settle charged nothing (%); this case would prove nothing', v_state;
  end if;
  perform pg_temp.resume('A5', pg_temp.job_of(v_contended));
  v_state := pg_temp.start();
  if v_state is distinct from 'running' then
    raise exception 'A5: the start refused by contention was not admitted once the call in flight settled (%, %)',
      v_state, (pg_temp.run(v_contended)).error_code;
  end if;
  perform pg_temp.remember('run_a_in_flight', v_contended);
  perform pg_temp.set_limit('tenant', pg_temp.huge(), ta);
end
$$;

-- A6. Exhaustion on a later limit wins over contention on an earlier one.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_global uuid;
  v_tenant uuid;
  v_run    uuid;
  v_state  text;
  r        ops.agent_runs;
begin
  if pg_temp.run_status(pg_temp.id('run_a_in_flight')) is distinct from 'running' then
    raise exception 'A6: no call is in flight; this case would prove nothing';
  end if;
  v_run := pg_temp.adm_run('rg1d-a6');
  v_global := pg_temp.set_limit('global', pg_temp.settled('global') + v_r);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_contended:' || v_global then
    raise exception 'A6: the global ceiling is not contended (%); this case would prove nothing', pg_temp.admission(ta, ca1, v_r);
  end if;
  v_tenant := pg_temp.set_limit('tenant', pg_temp.settled('tenant', ta) + v_r - 1, ta);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_exhausted:' || v_tenant then
    raise exception 'A6: exhaustion of a later limit did not win over contention on an earlier one (%)', pg_temp.admission(ta, ca1, v_r);
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.error_code <> 'budget_exhausted' or r.spend_limit_id is distinct from v_tenant then
    raise exception 'A6: a start exhausted by its tenant budget and contended at the ceiling was not recorded as exhausted (start %, %, %)',
      v_state, r.error_code, r.spend_limit_id;
  end if;
  perform pg_temp.set_limit('global', pg_temp.huge());
  perform pg_temp.set_limit('tenant', pg_temp.huge(), ta);
end
$$;

-- A12. A missing tenant budget is recorded as unconfigured, naming no limit, even
--      while the global ceiling is contended by a call in flight. (Found by the stream
--      review: the contended ceiling's id used to survive into the refusal, and the
--      refusal then failed on agent_runs_limit_iff_budget_refusal instead of being
--      recorded.)
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_run     uuid;
  v_request uuid;
  v_state   text;
  r         ops.agent_runs;
begin
  if pg_temp.run_status(pg_temp.id('run_a_in_flight')) is distinct from 'running' then
    raise exception 'A12: no call is in flight; this case would prove nothing';
  end if;
  v_run := pg_temp.adm_run('rg1d-a12');
  perform pg_temp.set_limit('global', pg_temp.settled('global') + v_r);
  if pg_temp.admission(ta, ca1, v_r) not like 'budget_contended:%' then
    raise exception 'A12: the global ceiling is not contended (%); this case would prove nothing', pg_temp.admission(ta, ca1, v_r);
  end if;
  perform pg_temp.retire_limit('tenant', ta);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_unconfigured:-' then
    raise exception 'A12: a missing tenant budget beside a contended ceiling was not refused as unconfigured with no limit (%)',
      pg_temp.admission(ta, ca1, v_r);
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.error_code <> 'budget_unconfigured' or r.spend_limit_id is not null then
    raise exception 'A12: a start with no tenant budget beside a contended ceiling was not recorded unconfigured (start %, %, %)',
      v_state, r.error_code, r.spend_limit_id;
  end if;
  v_request := pg_temp.request('rg1d-a12-request', 'tenant_a', 'task_adm', 'agent_a1');
  r := pg_temp.run(v_request);
  if r.status <> 'cancelled' or r.error_code <> 'budget_unconfigured' or r.spend_limit_id is not null or r.job_id is not null then
    raise exception 'A12: a request with no tenant budget beside a contended ceiling was not refused before any job (% / %)',
      r.status, r.error_code;
  end if;
  perform pg_temp.set_limit('tenant', pg_temp.huge(), ta);
  perform pg_temp.set_limit('global', pg_temp.huge());
end
$$;

-- A7. "Today" is the limit's own day. A run is backdated, with the update guard off,
--     to just before local midnight in one zone and after it in another; the same
--     tenant-B budget counts it only in the zone where it started today. Rolled back.
do $$
declare
  tb constant uuid := pg_temp.id('tenant_b');
  cb constant uuid := pg_temp.id('company_b');
  c_charge constant bigint := 5000000;
  -- Local midnight, computed here rather than by the helper under test.
  v_east timestamptz := date_trunc('day', now() at time zone 'Pacific/Kiritimati') at time zone 'Pacific/Kiritimati';
  v_west timestamptz := date_trunc('day', now() at time zone 'Etc/GMT+12') at time zone 'Etc/GMT+12';
  v_zone_out  text;
  v_zone_in   text;
  v_since_out timestamptz;
  v_since_in  timestamptz;
  v_moment    timestamptz;
  v_run       uuid;
  v_out       bigint;
  v_in        bigint;
  v_limit_in  uuid;
  v_outcome_out text;
  v_outcome_in  text;
begin
  -- The two zones are 26 hours apart, so their local midnights never coincide.
  if v_east > v_west then
    v_zone_out := 'Pacific/Kiritimati'; v_since_out := v_east; v_zone_in := 'Etc/GMT+12'; v_since_in := v_west;
  else
    v_zone_out := 'Etc/GMT+12'; v_since_out := v_west; v_zone_in := 'Pacific/Kiritimati'; v_since_in := v_east;
  end if;
  v_moment := v_since_out - interval '1 minute';
  if not (v_moment >= v_since_in and v_moment < now()) then
    raise exception 'A7: the backdated moment % is not inside one window only (% / %); this case would prove nothing',
      v_moment, v_since_in, v_since_out;
  end if;

  begin
    v_run := pg_temp.request('rg1d-a7-yesterday', 'tenant_b', 'task_b', 'agent_b');
    execute 'alter table ops.agent_runs disable trigger agent_runs_guard_update';
    perform pg_temp.raw_update(v_run, format(
      $s$status = 'succeeded', started_at = %L, completed_at = %L, provider = 'fake', model = 'rg1d-model',
         prompt_version = 'task_assessment.v1', input_fingerprint = repeat('c', 64), job_attempt = 1,
         price_id = %L, reserved_cost_micros = %s, estimated_cost_micros = %s, charged_cost_micros = %s, result = %L$s$,
      v_moment, v_moment + interval '1 second', pg_temp.id('price_base'), c_charge, c_charge, c_charge,
      pg_temp.valid_result()));
    execute 'alter table ops.agent_runs enable always trigger agent_runs_guard_update';
    select t.p_settled into v_out from ops.spend_window_total('tenant', tb, null, v_since_out) t;
    select t.p_settled into v_in from ops.spend_window_total('tenant', tb, null, v_since_in) t;

    perform pg_temp.retire_limit('tenant', tb);
    perform pg_temp.set_limit('tenant', v_out + 1000, tb, null, v_zone_out);
    v_outcome_out := pg_temp.admission(tb, cb, 1000);
    perform pg_temp.retire_limit('tenant', tb);
    v_limit_in := pg_temp.set_limit('tenant', v_out + 1000, tb, null, v_zone_in);
    v_outcome_in := pg_temp.admission(tb, cb, 1000);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;

  if v_in - v_out < c_charge then
    raise exception 'A7: the backdated run is not in one window only (% vs %); this case would prove nothing', v_in, v_out;
  end if;
  if v_outcome_out is distinct from 'admitted:-' then
    raise exception 'A7: a run started before the limit''s own local midnight counted against today (%)', v_outcome_out;
  end if;
  if v_outcome_in is distinct from 'budget_exhausted:' || v_limit_in then
    raise exception 'A7: a run started after the limit''s own local midnight did not count against today (%)', v_outcome_in;
  end if;
end
$$;

-- A8. A run names only a limit in force that applies to it, and only when that limit
--     refused it.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  ca2 constant uuid := pg_temp.id('company_a2');
  v_run       uuid := pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_adm', 'agent_a1');
  v_tenant    uuid := pg_temp.active_limit('tenant', ta);
  v_a2_limit  uuid;
  v_a1_limit  uuid;
  v_limit     uuid;
  v_case      record;
  v_n         integer := 0;
  c_refusal   constant text := $s$status = 'cancelled', error_category = 'refused', error_code = 'budget_exhausted', spend_limit_id = %L$s$;
begin
  v_a2_limit := pg_temp.set_limit('company', pg_temp.huge(), ta, ca2);
  for v_case in
    select * from (values
      ('A8 a run naming an ended limit', 'OS409', format(c_refusal, pg_temp.id('limit_a1_ended'))),
      ('A8 a tenant-A run naming tenant B''s budget', 'OS409',
       format(c_refusal, pg_temp.active_limit('tenant', pg_temp.id('tenant_b')))),
      ('A8 a company-A1 run naming company A2''s limit', 'OS409', format(c_refusal, v_a2_limit)),
      ('A8 a run naming a limit that does not exist', 'OS409', format(c_refusal, gen_random_uuid())),
      ('A8 a failed run naming a limit', 'OS409',
       format($s$status = 'failed', error_category = 'configuration', error_code = 'budget_exhausted', spend_limit_id = %L$s$, v_tenant)),
      ('A8 budget_exhausted naming no limit', '23514',
       $s$status = 'cancelled', error_category = 'refused', error_code = 'budget_exhausted'$s$),
      ('A8 a limit on a refusal for another reason', '23514',
       format($s$status = 'cancelled', error_category = 'refused', error_code = 'task_closed', spend_limit_id = %L$s$, v_tenant))
    ) as c (label, sqlstate_expected, settle)
  loop
    perform pg_temp.expect_refused(v_case.label, v_case.sqlstate_expected,
      format('select pg_temp.raw_update(%L, %L)', v_run, v_case.settle));
    v_n := v_n + 1;
  end loop;
  if v_n <> 7 then
    raise exception 'A8: % refusals ran, expected 7; a case was lost', v_n;
  end if;

  -- Controls: the global ceiling, the run's tenant budget and its own company limit.
  v_a1_limit := pg_temp.set_limit('company', pg_temp.huge(), ta, ca1);
  foreach v_limit in array array[pg_temp.active_limit('global'), v_tenant, v_a1_limit] loop
    begin
      perform pg_temp.raw_update(v_run, format(c_refusal, v_limit));
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    exception
      when sqlstate 'C1CAC' then null;
      when others then
        raise exception 'A8: the owner could not record limit % that applies to the run (% %), so the refusals above prove nothing',
          v_limit, sqlstate, sqlerrm;
    end;
  end loop;
  perform pg_temp.retire_limit('company', ta, ca1);
  perform pg_temp.retire_limit('company', ta, ca2);
end
$$;

-- A9. A worker cannot record a governance refusal as its own.
do $$
declare
  v_code  text;
  v_run   uuid;
  v_state text;
  v_n     integer := 0;
  r       ops.agent_runs;
begin
  foreach v_code in array array['price_unavailable', 'route_policy_mismatch', 'spend_ceiling_unconfigured',
                                'budget_unconfigured', 'budget_exhausted'] loop
    v_run := pg_temp.adm_run('rg1d-a9-refuse-' || v_code);
    v_state := pg_temp.worker(format('select ops.refuse_agent_run(%L)', v_code));
    r := pg_temp.run(v_run);
    if v_state is distinct from 'failed' or r.error_category <> 'configuration' or r.error_code <> 'configuration'
       or r.spend_limit_id is not null then
      raise exception 'A9: a worker recorded the governance code % through refuse_agent_run (%, %)', v_code, v_state, r.error_code;
    end if;
    v_n := v_n + 1;
  end loop;

  v_run := pg_temp.adm_run('rg1d-a9-fail');
  if pg_temp.start() is distinct from 'running' then
    raise exception 'A9: the run did not start; this case would prove nothing';
  end if;
  v_state := pg_temp.worker($q$select ops.fail_agent_run('rate_limit', 'budget_exhausted', null, 'req-a9', null, null, null, null, null, null, 3)$q$);
  r := pg_temp.run(v_run);
  if v_state is distinct from 'failed' or r.error_code is not null or r.spend_limit_id is not null then
    raise exception 'A9: a worker recorded budget_exhausted through fail_agent_run (%, %)', v_state, r.error_code;
  end if;
  if v_n <> 5 then
    raise exception 'A9: % codes were attacked, expected 5', v_n;
  end if;
end
$$;

-- A10. No current price, no call: an unpriced model, an expired price, an expired
--      latest version with an older one still valid, and a price not yet in effect.
do $$
declare
  v_case  record;
  v_run   uuid;
  v_state text;
  v_n     integer := 0;
  r       ops.agent_runs;
begin
  perform ops.record_model_price('fake', 'rg1d-a-expired', 1, 1, true, now() - interval '2 days',
                                 now() - interval '1 day', 'rg1d expired', 'rg1d-owner');
  perform ops.record_model_price('fake', 'rg1d-a-stale', 1, 1, true, now() - interval '10 days',
                                 now() + interval '300 days', 'rg1d stale v1', 'rg1d-owner');
  perform ops.record_model_price('fake', 'rg1d-a-stale', 1, 1, true, now() - interval '2 days',
                                 now() - interval '1 day', 'rg1d stale v2', 'rg1d-owner');
  perform ops.record_model_price('fake', 'rg1d-a-future', 1, 1, true, now() + interval '1 hour',
                                 now() + interval '1 day', 'rg1d future', 'rg1d-owner');
  for v_case in
    select * from (values ('unpriced', 'rg1d-a-unpriced'), ('expired', 'rg1d-a-expired'),
                          ('stale', 'rg1d-a-stale'), ('future', 'rg1d-a-future')) as c (key, model)
  loop
    v_run := pg_temp.adm_run('rg1d-a10-' || v_case.key);
    v_state := pg_temp.start(v_case.model);
    r := pg_temp.run(v_run);
    if v_state is distinct from 'cancelled' or r.error_category <> 'refused' or r.error_code <> 'price_unavailable'
       or r.started_at is not null or r.price_id is not null or r.provider is not null or r.model is not null
       or r.charged_cost_micros is not null or r.spend_limit_id is not null then
      raise exception 'A10: a run whose model has no current price (%) was not refused before any call (start %, code %)',
        v_case.key, v_state, r.error_code;
    end if;
    v_n := v_n + 1;
  end loop;
  if v_n <> 4 then
    raise exception 'A10: % price cases ran, expected 4', v_n;
  end if;
end
$$;

-- A11. The worker reports the output ceiling it will send; anything but the route's
--      own is refused before any call, and a missing one is malformed.
do $$
declare
  v_case  record;
  v_run   uuid;
  v_state text;
  r       ops.agent_runs;
begin
  for v_case in select * from (values ('low', 7999), ('high', 25000)) as c (key, ceiling) loop
    v_run := pg_temp.adm_run('rg1d-a11-' || v_case.key);
    v_state := pg_temp.start('rg1d-model', v_case.ceiling);
    r := pg_temp.run(v_run);
    if v_state is distinct from 'cancelled' or r.error_code <> 'route_policy_mismatch' or r.started_at is not null
       or r.price_id is not null then
      raise exception 'A11: a start reporting output ceiling % for the standard route was not refused (start %, code %)',
        v_case.ceiling, v_state, r.error_code;
    end if;
  end loop;

  v_run := pg_temp.adm_run('rg1d-a11-missing');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  perform pg_temp.expect_refused('A11 a start reporting an output ceiling of zero', 'OS400',
    $q$select ops.start_agent_run('fake', 'rg1d-model', 'task_assessment.v1', repeat('f', 64), 0)$q$);
  perform pg_temp.expect_refused('A11 a start reporting no output ceiling', 'OS400',
    $q$select ops.start_agent_run('fake', 'rg1d-model', 'task_assessment.v1', repeat('f', 64), null)$q$);
  perform pg_temp.as_owner();
  if pg_temp.run_status(v_run) <> 'pending' then
    raise exception 'A11: a malformed start changed its run';
  end if;
end
$$;

-- A13. A missing tenant budget beside a global ceiling that settled spend already
--      reaches: the scopes are walked global first, so the refusal is budget_exhausted
--      naming the ceiling version, not budget_unconfigured. Either way it is a
--      refusal, recorded at start and before any job at request (owner decision A).
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_tenant  bigint;
  v_global  uuid;
  v_run     uuid;
  v_request uuid;
  v_state   text;
  r         ops.agent_runs;
begin
  select l.daily_limit_micros into v_tenant
    from ops.spend_limits l where l.id = pg_temp.active_limit('tenant', ta);
  if v_tenant is null then
    raise exception 'A13: tenant A has no budget to retire; this case would prove nothing';
  end if;
  v_run := pg_temp.adm_run('rg1d-a13');
  v_global := pg_temp.set_limit('global', pg_temp.settled('global'));
  perform pg_temp.retire_limit('tenant', ta);
  if pg_temp.admission(ta, ca1, v_r) <> 'budget_exhausted:' || v_global
     or pg_temp.admission(ta, ca1, 1) <> 'budget_exhausted:' || v_global then
    raise exception 'A13: a missing tenant budget beside an exhausted ceiling was not refused as exhausted by the ceiling (%, %)',
      pg_temp.admission(ta, ca1, v_r), pg_temp.admission(ta, ca1, 1);
  end if;
  v_state := pg_temp.start();
  r := pg_temp.run(v_run);
  if v_state is distinct from 'cancelled' or r.error_code <> 'budget_exhausted'
     or r.spend_limit_id is distinct from v_global or r.started_at is not null then
    raise exception 'A13: a start with no tenant budget beside an exhausted ceiling was not recorded exhausted by the ceiling (start %, %, %)',
      v_state, r.error_code, r.spend_limit_id;
  end if;
  v_request := pg_temp.request('rg1d-a13-request', 'tenant_a', 'task_adm', 'agent_a1');
  r := pg_temp.run(v_request);
  if r.status <> 'cancelled' or r.error_code <> 'budget_exhausted'
     or r.spend_limit_id is distinct from v_global or r.job_id is not null then
    raise exception 'A13: a request with no tenant budget beside an exhausted ceiling was not refused by the ceiling before any job (% / % / %)',
      r.status, r.error_code, r.spend_limit_id;
  end if;
  perform pg_temp.set_limit('tenant', v_tenant, ta);
  perform pg_temp.set_limit('global', pg_temp.huge());
end
$$;

-- ===========================================================================
-- K. THE KILL SWITCH, EXTENDED.
-- ===========================================================================

-- K1. A stop can name one external kind, for one tenant or for all.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_all   uuid;
  v_one   uuid;
  v_again uuid;
  s       ops.execution_stops;
begin
  v_all := ops.trip_execution_stop('job_kind', 'rg1d-test: every agent run', 'rg1d-owner',
                                   null, null, null, null, 'agent_run.execute');
  v_again := ops.trip_execution_stop('job_kind', 'rg1d-test: again', 'rg1d-owner',
                                     null, null, null, null, 'agent_run.execute');
  if v_again is distinct from v_all then
    raise exception 'K1: tripping the same all-tenant kind stop twice returned a second stop';
  end if;
  v_one := ops.trip_execution_stop('job_kind', 'rg1d-test: tenant A agent runs', 'rg1d-owner',
                                   ta, null, null, null, 'agent_run.execute');
  v_again := ops.trip_execution_stop('job_kind', 'rg1d-test: again', 'rg1d-owner',
                                     ta, null, null, null, 'agent_run.execute');
  if v_again is distinct from v_one or v_one = v_all then
    raise exception 'K1: a one-tenant kind stop was not its own stop, or tripping it twice returned another';
  end if;
  select * into s from ops.execution_stops x where x.id = v_all;
  if s.scope <> 'job_kind' or s.tenant_id is not null or s.job_kind <> 'agent_run.execute' or s.origin <> 'owner'
     or s.reason <> 'rg1d-test: every agent run' or s.company_id is not null then
    raise exception 'K1: the all-tenant kind stop was not recorded as tripped: %', to_jsonb(s);
  end if;
  if (select count(*) from ops.execution_stops x where x.cleared_at is null and x.scope = 'job_kind') <> 2 then
    raise exception 'K1: tripping two kind stops twice each left other than two active stops';
  end if;
  if ops.active_execution_stop(ta, ca1, da1, ga1) is distinct from v_all then
    raise exception 'K1: the switch read for an agent run does not report the all-tenant kind stop first';
  end if;
  perform ops.clear_execution_stop(v_all, 'rg1d-test: cleared', 'rg1d-owner');
  if ops.active_execution_stop(ta, ca1, da1, ga1) is distinct from v_one then
    raise exception 'K1: the switch read for an agent run does not report the tenant''s kind stop';
  end if;
  perform ops.clear_execution_stop(v_one, 'rg1d-test: cleared', 'rg1d-owner');
  if ops.active_execution_stop(ta, ca1, da1, ga1) is not null then
    raise exception 'K1: a cleared kind stop still covers agent runs';
  end if;
end
$$;

do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_case record;
  v_n    integer := 0;
begin
  for v_case in
    select * from (values
      ('K1 a kind stop naming no kind', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner')$q$),
      ('K1 a kind stop naming a company', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', %1$L, %2$L, null, null, 'agent_run.execute')$q$),
      ('K1 a kind stop naming a department', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', %1$L, %2$L, %3$L, null, 'agent_run.execute')$q$),
      ('K1 a kind stop naming an agent', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', %1$L, null, null, %4$L, 'agent_run.execute')$q$),
      ('K1 a global stop naming a kind', 'OS400',
       $q$select ops.trip_execution_stop('global', 'rg1d-test: shape', 'rg1d-owner', null, null, null, null, 'agent_run.execute')$q$),
      ('K1 a tenant stop naming a kind', 'OS400',
       $q$select ops.trip_execution_stop('tenant', 'rg1d-test: shape', 'rg1d-owner', %1$L, null, null, null, 'agent_run.execute')$q$),
      ('K1 a company stop naming a kind', 'OS400',
       $q$select ops.trip_execution_stop('company', 'rg1d-test: shape', 'rg1d-owner', %1$L, %2$L, null, null, 'agent_run.execute')$q$),
      ('K1 a department stop naming a kind', 'OS400',
       $q$select ops.trip_execution_stop('department', 'rg1d-test: shape', 'rg1d-owner', %1$L, %2$L, %3$L, null, 'agent_run.execute')$q$),
      ('K1 an agent stop naming a kind', 'OS400',
       $q$select ops.trip_execution_stop('agent', 'rg1d-test: shape', 'rg1d-owner', %1$L, %2$L, null, %4$L, 'agent_run.execute')$q$),
      ('K1 a kind stop on an internal kind, which would hold nothing', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', null, null, null, null, 'postmark.ledger_retention')$q$),
      ('K1 a kind stop on a kind nobody classified', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', null, null, null, null, 'rg1d.unclassified')$q$),
      ('K1 a kind stop on a malformed kind', 'OS400',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', null, null, null, null, 'Agent Run')$q$),
      ('K1 a kind stop for an unknown tenant', 'OS404',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: shape', 'rg1d-owner', '00000000-0000-4000-8000-000000000000', null, null, null, 'agent_run.execute')$q$),
      ('K1 a raw kind stop naming a company', '23514',
       $q$insert into ops.execution_stops (scope, tenant_id, company_id, job_kind, reason, tripped_by)
          values ('job_kind', %1$L, %2$L, 'agent_run.execute', 'rg1d-test: shape', 'rg1d-owner')$q$),
      ('K1 a raw kind stop naming no kind', '23514',
       $q$insert into ops.execution_stops (scope, tenant_id, reason, tripped_by)
          values ('job_kind', %1$L, 'rg1d-test: shape', 'rg1d-owner')$q$),
      -- The insert guard refuses any kind that is not external before the format
      -- constraint is reached, so a malformed kind is refused the same way.
      ('K1 a raw stop on a malformed kind', 'OS400',
       $q$insert into ops.execution_stops (scope, job_kind, reason, tripped_by)
          values ('job_kind', 'Agent Run', 'rg1d-test: shape', 'rg1d-owner')$q$),
      ('K1 a raw kind stop on an internal kind', 'OS400',
       $q$insert into ops.execution_stops (scope, job_kind, reason, tripped_by)
          values ('job_kind', 'postmark.ledger_retention', 'rg1d-test: shape', 'rg1d-owner')$q$),
      ('K1 a raw kind stop on a kind nobody classified', 'OS400',
       $q$insert into ops.execution_stops (scope, tenant_id, job_kind, reason, tripped_by)
          values ('job_kind', %1$L, 'rg1d.unclassified', 'rg1d-test: shape', 'rg1d-owner')$q$),
      ('K1 a raw global stop naming a kind', '23514',
       $q$insert into ops.execution_stops (scope, job_kind, reason, tripped_by)
          values ('global', 'agent_run.execute', 'rg1d-test: shape', 'rg1d-owner')$q$)
    ) as c (label, sqlstate_expected, statement)
  loop
    perform pg_temp.expect_refused(v_case.label, v_case.sqlstate_expected, format(v_case.statement, ta, ca1, da1, ga1));
    v_n := v_n + 1;
  end loop;
  if v_n <> 19 then
    raise exception 'K1: % shape refusals ran, expected 19; a case was lost', v_n;
  end if;
  if exists (select 1 from ops.execution_stops x where x.reason = 'rg1d-test: shape') then
    raise exception 'K1: a refused stop was stored';
  end if;
end
$$;

-- K2. Who tripped a stop is part of its target: a system stop and an owner's stop
--     coexist, and clearing one leaves the other covering.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_system uuid;
  v_owner  uuid;
  v_owner2 uuid;
  v_again  uuid;
begin
  v_system := ops.trip_execution_stop('global', 'rg1d-test: system global', 'system:spend_ceiling');
  v_owner := ops.trip_execution_stop('global', 'rg1d-test: owner global', 'rg1d-owner');
  if v_owner is not distinct from v_system then
    raise exception 'K2: an owner''s global trip was absorbed by the system stop on the same target';
  end if;
  if (select x.origin from ops.execution_stops x where x.id = v_system) <> 'system'
     or (select x.origin from ops.execution_stops x where x.id = v_owner) <> 'owner' then
    raise exception 'K2: a stop''s origin was not derived from who tripped it';
  end if;
  v_again := ops.trip_execution_stop('global', 'rg1d-test: another system actor', 'system:other_sweep');
  if v_again is distinct from v_system then
    raise exception 'K2: a second system actor''s trip was not answered with the active system stop';
  end if;
  v_again := ops.trip_execution_stop('global', 'rg1d-test: owner again', 'rg1d-owner');
  if v_again is distinct from v_owner then
    raise exception 'K2: an owner''s second trip was not answered with the owner''s active stop';
  end if;
  v_again := ops.trip_execution_stop('global', 'rg1d-test: not a system actor', 'systemic-owner');
  if v_again is distinct from v_owner then
    raise exception 'K2: an actor that only begins like system was not treated as an owner';
  end if;

  perform ops.clear_execution_stop(v_owner, 'rg1d-test: owner cleared', 'rg1d-owner');
  if ops.active_execution_stop(ta, ca1, da1, ga1) is distinct from v_system then
    raise exception 'K2: clearing the owner''s global stop cleared or uncovered the system one';
  end if;
  v_owner2 := ops.trip_execution_stop('global', 'rg1d-test: owner again', 'rg1d-owner');
  if v_owner2 is not distinct from v_owner or v_owner2 is not distinct from v_system then
    raise exception 'K2: an owner''s trip after its clearing was not a new stop';
  end if;
  perform pg_temp.expect_refused('K2 a second active owner stop on one target', '23505', $q$
    insert into ops.execution_stops (scope, reason, tripped_by) values ('global', 'rg1d-test: duplicate', 'rg1d-owner')
  $q$);
  perform ops.clear_execution_stop(v_system, 'rg1d-test: system cleared', 'rg1d-owner');
  if ops.active_execution_stop(ta, ca1, da1, ga1) is distinct from v_owner2 then
    raise exception 'K2: clearing the system global stop cleared or uncovered the owner''s';
  end if;
  perform pg_temp.expect_refused('K2 writing a stop''s origin', '428C9',
    format($q$update ops.execution_stops set origin = 'system' where id = %L$q$, v_owner2));
  perform pg_temp.expect_refused('K2 inserting a stop with its origin', '428C9', $q$
    insert into ops.execution_stops (scope, reason, tripped_by, origin)
    values ('global', 'rg1d-test: forged origin', 'rg1d-owner', 'system')
  $q$);
  perform ops.clear_execution_stop(v_owner2, 'rg1d-test: owner cleared', 'rg1d-owner');
  if ops.active_execution_stop(ta, ca1, da1, ga1) is not null then
    raise exception 'K2: a stop is still active after both were cleared';
  end if;
end
$$;

-- K3. At the lease, a queued agent run job that an active stop covers is passed
--     over for every scope, stays queued, spends no attempt, and is leased once the
--     stop is cleared. Stops that cover other work do not hold it.
do $$
declare
  ta   constant uuid := pg_temp.id('tenant_a');
  tb   constant uuid := pg_temp.id('tenant_b');
  ca1  constant uuid := pg_temp.id('company_a1');
  ca2  constant uuid := pg_temp.id('company_a2');
  da1  constant uuid := pg_temp.id('dept_a1');
  da1s constant uuid := pg_temp.id('dept_a1_support');
  ga1  constant uuid := pg_temp.id('agent_a1');
  ga1b constant uuid := pg_temp.id('agent_a1_two');
  v_held     uuid;
  v_held_job uuid;
  v_case     record;
  v_stop     uuid;
  v_others   uuid[];
  v_run      uuid;
  v_job      uuid;
  v_state    text;
  v_n        integer := 0;
  c_complete constant text := format(
    'select ops.complete_agent_run(%L::jsonb, ''rg1d-model'', ''completed'', ''req-k3'', ''resp-k3'', 10, 10, 20, 0, 0, 5)',
    pg_temp.valid_result());
begin
  v_held := pg_temp.request('rg1d-k3-held', 'tenant_a', 'task_k', 'agent_a1');
  v_held_job := pg_temp.job_of(v_held);
  if v_held_job is null then
    raise exception 'K3: the fixture run was given no job; this case would prove nothing';
  end if;

  for v_case in
    select * from (values
      ('global',     null::uuid, null::uuid, null::uuid, null::uuid, null::text),
      ('tenant',     ta,         null,       null,       null,       null),
      ('job_kind',   null,       null,       null,       null,       'agent_run.execute'),
      ('job_kind',   ta,         null,       null,       null,       'agent_run.execute'),
      ('company',    ta,         ca1,        null,       null,       null),
      ('department', ta,         ca1,        da1,        null,       null),
      ('agent',      ta,         ca1,        null,       ga1,        null)
    ) as c (scope, tenant_id, company_id, department_id, agent_id, job_kind)
  loop
    v_stop := ops.trip_execution_stop(v_case.scope, 'rg1d-test: hold ' || v_case.scope, 'rg1d-owner',
                                      v_case.tenant_id, v_case.company_id, v_case.department_id,
                                      v_case.agent_id, v_case.job_kind);
    perform pg_temp.expect_held(format('K3 a %s stop%s', v_case.scope,
                                       case when v_case.tenant_id is null then ' for every tenant' else ' for tenant A' end),
                                v_held_job);
    if pg_temp.run_status(v_held) <> 'pending' then
      raise exception 'K3: a run whose job is held left pending (%)', pg_temp.run_status(v_held);
    end if;
    perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
    v_n := v_n + 1;
  end loop;
  if v_n <> 7 then
    raise exception 'K3: % stop scopes held the job, expected 7; a case was lost', v_n;
  end if;

  -- Stops on another tenant, another tenant's kind, another company, another
  -- department and another agent, all at once: the job is leased and its run starts.
  v_others := array[
    ops.trip_execution_stop('tenant', 'rg1d-test: other work', 'rg1d-owner', tb),
    ops.trip_execution_stop('job_kind', 'rg1d-test: other work', 'rg1d-owner', tb, null, null, null, 'agent_run.execute'),
    ops.trip_execution_stop('company', 'rg1d-test: other work', 'rg1d-owner', ta, ca2),
    ops.trip_execution_stop('department', 'rg1d-test: other work', 'rg1d-owner', ta, ca1, da1s),
    ops.trip_execution_stop('agent', 'rg1d-test: other work', 'rg1d-owner', ta, ca1, null, ga1b)];
  perform pg_temp.expect_leased('K3 stops that cover only other work', v_held_job);
  v_state := pg_temp.start();
  if v_state is distinct from 'running' then
    raise exception 'K3: a run no stop covers was refused at start under stops on other work (%, %)',
      v_state, (pg_temp.run(v_held)).error_code;
  end if;
  if pg_temp.worker(c_complete) is distinct from 'succeeded' then
    raise exception 'K3: the run leased under stops on other work did not complete';
  end if;
  foreach v_stop in array v_others loop
    perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  end loop;

  -- A held job waits, however often it is offered, and is leased once the stop is
  -- cleared, with no attempt spent while it waited; its start re-checks every gate.
  v_run := pg_temp.request('rg1d-k3-cleared', 'tenant_a', 'task_k', 'agent_a1');
  v_job := pg_temp.job_of(v_run);
  v_stop := ops.trip_execution_stop('department', 'rg1d-test: hold until cleared', 'rg1d-owner', ta, ca1, da1);
  perform pg_temp.expect_held('K3 a department stop, first offer', v_job);
  perform pg_temp.expect_held('K3 a department stop, second offer', v_job);
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  perform pg_temp.lease('K3 after the clearing', v_job);
  if (select j.attempts from ops.jobs j where j.id = v_job) <> 1 then
    raise exception 'K3: a job held by a stop spent an attempt while it waited (% attempts)',
      (select j.attempts from ops.jobs j where j.id = v_job);
  end if;
  v_state := pg_temp.start();
  if v_state is distinct from 'running' or pg_temp.worker(c_complete) is distinct from 'succeeded' then
    raise exception 'K3: a run held until its stop was cleared did not then run (%)', v_state;
  end if;
end
$$;

-- K3 (maintenance). Internal kinds are never held; a kind nobody classified always is.
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_internal     uuid;
  v_unclassified uuid;
  v_stop         uuid;
  v_answer       text;
begin
  v_internal := ops.enqueue_job(ta, 'postmark.ledger_retention', '{}'::jsonb, 100, now(), 5, null);
  v_unclassified := ops.enqueue_job(ta, 'rg1d.unclassified', '{}'::jsonb, 100, now(), 5, null);
  v_stop := ops.trip_execution_stop('global', 'rg1d-test: administration stays up', 'rg1d-owner');
  perform pg_temp.expect_held('K3 a global stop and a kind nobody classified', v_unclassified);
  perform pg_temp.expect_leased('K3 a global stop and an internal kind', v_internal);
  v_answer := pg_temp.worker(
    $q$select coalesce(ops.job_execution_stop()::text, 'none') || ':' || coalesce(ops.defer_job()::text, 'none')$q$);
  if v_answer is distinct from 'none:none'
     or (select j.status from ops.jobs j where j.id = v_internal) <> 'leased' then
    raise exception 'K3: an internal job was reported held or was deferred under a global stop (%)', v_answer;
  end if;
  if pg_temp.worker(format('select ops.complete_job(%L)::text', v_internal)) is distinct from 'true' then
    raise exception 'K3: the internal job leased under a global stop could not be completed';
  end if;
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');

  v_stop := ops.trip_execution_stop('tenant', 'rg1d-test: unclassified', 'rg1d-owner', ta);
  perform pg_temp.expect_held('K3 a tenant stop and a kind nobody classified', v_unclassified);
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  perform pg_temp.expect_leased('K3 a kind nobody classified, with no stop', v_unclassified);
end
$$;

-- K4. A second external kind, inside this rolled-back transaction only, so a kind
--     stop can name it and a job of it can be requested for a task without being an
--     agent run. The final block proves the classification is back to exactly
--     {agent_run.execute, decision.shadow_evaluate, calendar.create,
--     calendar.update, calendar.cancel} (the second since Phase 2D.1, the
--     calendar kinds since Phase 3A.2).
create or replace function ops.external_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update',
               'calendar.cancel', 'rg1d.probe_external']::text[];
$function$;

do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  tb  constant uuid := pg_temp.id('tenant_b');
  ca1 constant uuid := pg_temp.id('company_a1');
  ca2 constant uuid := pg_temp.id('company_a2');
  cb  constant uuid := pg_temp.id('company_b');
  da1 constant uuid := pg_temp.id('dept_a1');
  da2 constant uuid := pg_temp.id('dept_a2');
  db  constant uuid := pg_temp.id('dept_b');
  ga1 constant uuid := pg_temp.id('agent_a1');
  gb  constant uuid := pg_temp.id('agent_b');
  s1 uuid;
  s2 uuid;
  v_linked      uuid;
  v_linked_ok   uuid;
  v_unlinked    uuid;
  v_unlinked_ok uuid;
  v_task_dept   uuid;
  v_linked_dept uuid;
  v_case   record;
  v_stop   uuid;
  v_stops  uuid[];
  v_run    uuid;
begin
  -- K1, with two external kinds: each kind has its own stop.
  s1 := ops.trip_execution_stop('job_kind', 'rg1d-test: kind one', 'rg1d-owner', null, null, null, null, 'agent_run.execute');
  s2 := ops.trip_execution_stop('job_kind', 'rg1d-test: kind two', 'rg1d-owner', null, null, null, null, 'rg1d.probe_external');
  if s1 is not distinct from s2
     or (select count(*) from ops.execution_stops x where x.cleared_at is null and x.scope = 'job_kind') <> 2 then
    raise exception 'K1: stops on two external kinds are not two stops';
  end if;
  if ops.trip_execution_stop('job_kind', 'rg1d-test: again', 'rg1d-owner', null, null, null, null, 'agent_run.execute') is distinct from s1
     or ops.trip_execution_stop('job_kind', 'rg1d-test: again', 'rg1d-owner', null, null, null, null, 'rg1d.probe_external') is distinct from s2 then
    raise exception 'K1: tripping a kind stop again did not return that kind''s own stop';
  end if;
  perform ops.clear_execution_stop(s1, 'rg1d-test: cleared', 'rg1d-owner');
  perform ops.clear_execution_stop(s2, 'rg1d-test: cleared', 'rg1d-owner');

  -- Jobs of the test kind: two requested for a task of company A1, two with no task.
  v_linked := pg_temp.remember('job_k_linked', ops.enqueue_job(ta, 'rg1d.probe_external', '{}'::jsonb, 100, now(), 5, null));
  v_linked_ok := ops.enqueue_job(ta, 'rg1d.probe_external', '{}'::jsonb, 100, now(), 5, null);
  v_unlinked := pg_temp.remember('job_k_unlinked', ops.enqueue_job(ta, 'rg1d.probe_external', '{}'::jsonb, 100, now(), 5, null));
  v_unlinked_ok := ops.enqueue_job(ta, 'rg1d.probe_external', '{}'::jsonb, 100, now(), 5, null);
  perform pg_temp.raw(format(
    'insert into ops.task_jobs (tenant_id, job_id, company_id, task_id) values (%L, %L, %L, %L), (%L, %L, %L, %L)',
    ta, v_linked, ca1, pg_temp.id('task_k'), ta, v_linked_ok, ca1, pg_temp.id('task_k')));

  -- A department or agent the job does not know fails closed, in its tenant and company.
  for v_case in
    select * from (values ('department', da1, null::uuid), ('agent', null, ga1)) as c (scope, department_id, agent_id)
  loop
    v_stop := ops.trip_execution_stop(v_case.scope, 'rg1d-test: unknown coordinate', 'rg1d-owner',
                                      ta, ca1, v_case.department_id, v_case.agent_id);
    perform pg_temp.expect_held(format('K4 a %s stop and a company-A1 job whose %s is unknown', v_case.scope, v_case.scope),
                                v_linked);
    perform pg_temp.expect_held(format('K4 a %s stop and a job whose company is unknown too', v_case.scope), v_unlinked);
    perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  end loop;

  -- Nor are they read from the requesting task's current department or assignee,
  -- which change: a task of department A1 assigned to agent A1 requests a job, and a
  -- stop on ANOTHER department or agent of company A1 still holds it.
  v_task_dept := ops.create_task(ta, ca1, 'work.review', 'Probe from a department', 'rg1d-test', null, da1);
  perform ops.assign_task(ta, v_task_dept, ga1, 'rg1d-test');
  v_linked_dept := ops.enqueue_job(ta, 'rg1d.probe_external', '{}'::jsonb, 100, now(), 5, null);
  perform pg_temp.raw(format(
    'insert into ops.task_jobs (tenant_id, job_id, company_id, task_id) values (%L, %L, %L, %L)',
    ta, v_linked_dept, ca1, v_task_dept));
  if (select t.department_id from ops.tasks t where t.id = v_task_dept) is distinct from da1
     or (select t.assigned_agent_id from ops.tasks t where t.id = v_task_dept) is distinct from ga1 then
    raise exception 'K4: the requesting task has no department or assignee; this case would prove nothing';
  end if;
  for v_case in
    select * from (values ('department', pg_temp.id('dept_a1_support'), null::uuid),
                          ('agent', null, pg_temp.id('agent_a1_two'))) as c (scope, department_id, agent_id)
  loop
    v_stop := ops.trip_execution_stop(v_case.scope, 'rg1d-test: another ' || v_case.scope, 'rg1d-owner',
                                      ta, ca1, v_case.department_id, v_case.agent_id);
    perform pg_temp.expect_held(
      format('K4 a stop on another %s of its company and a job whose task has a department and an assignee', v_case.scope),
      v_linked_dept);
    perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  end loop;

  -- A known coordinate must match: a department stop in company A2 holds the job
  -- whose company is unknown, and leases the one known to be company A1's.
  v_stop := ops.trip_execution_stop('department', 'rg1d-test: another company', 'rg1d-owner', ta, ca2, da2);
  perform pg_temp.expect_held('K4 a department stop in company A2 and a job with no company', v_unlinked);
  perform pg_temp.expect_leased('K4 a department stop in company A2 and a job of company A1', v_linked_ok);
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');

  -- An unknown coordinate never crosses tenants.
  v_stops := array[
    ops.trip_execution_stop('company', 'rg1d-test: another tenant', 'rg1d-owner', tb, cb),
    ops.trip_execution_stop('department', 'rg1d-test: another tenant', 'rg1d-owner', tb, cb, db),
    ops.trip_execution_stop('agent', 'rg1d-test: another tenant', 'rg1d-owner', tb, cb, null, gb),
    ops.trip_execution_stop('job_kind', 'rg1d-test: another tenant', 'rg1d-owner', tb, null, null, null, 'rg1d.probe_external')];
  perform pg_temp.expect_leased('K4 stops in another tenant and a job with no company', v_unlinked_ok);
  foreach v_stop in array v_stops loop
    perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  end loop;

  -- A kind stop holds its own kind only.
  v_stop := ops.trip_execution_stop('job_kind', 'rg1d-test: probe kind', 'rg1d-owner', ta, null, null, null, 'rg1d.probe_external');
  perform pg_temp.expect_held('K4 a kind stop and a job of that kind', v_linked);
  v_run := pg_temp.request('rg1d-k4-other-kind', 'tenant_a', 'task_k', 'agent_a1');
  perform pg_temp.expect_leased('K4 a kind stop and a job of another kind', pg_temp.job_of(v_run));
  if pg_temp.start() is distinct from 'running' then
    raise exception 'K4: an agent run was refused at start by a stop on another kind (%)', (pg_temp.run(v_run)).error_code;
  end if;
  perform pg_temp.worker($q$select ops.fail_agent_run('rate_limit', 'http_429', null, null, null, null, null, null, null, null, 1)$q$);
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
end
$$;

-- K5. The pre-call check and the deferral: lease-bound, argument-free, and a
--     deferral only when a stop covers the job, returning it to the queue without
--     spending an attempt.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  v_job      constant uuid := pg_temp.id('job_k_linked');
  v_before   ops.jobs;
  v_after    ops.jobs;
  v_event    ops.job_events;
  v_answer   text;
  v_dept     uuid;
  v_tenant   uuid;
  v_deferred uuid;
begin
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  perform pg_temp.as_worker();
  perform pg_temp.expect_refused_with('K5 asking for the covering stop without a lease', '42501', 'no live lease',
    'select ops.job_execution_stop()');
  perform pg_temp.expect_refused_with('K5 deferring a job without a lease', '42501', 'no live lease',
    'select ops.defer_job()');
  perform pg_temp.as_owner();

  perform pg_temp.lease('K5', v_job);
  select * into v_before from ops.jobs j where j.id = v_job;
  v_answer := pg_temp.worker(
    $q$select coalesce(ops.job_execution_stop()::text, 'none') || ':' || coalesce(ops.defer_job()::text, 'none')$q$);
  if v_answer is distinct from 'none:none'
     or (select to_jsonb(j) from ops.jobs j where j.id = v_job) is distinct from to_jsonb(v_before) then
    raise exception 'K5: with no stop, the pre-call check reported one or a deferral changed the job (%)', v_answer;
  end if;
  if pg_temp.worker('select ops.current_tenant_id()::text') is distinct from ta::text then
    raise exception 'K5: a deferral no stop allowed dropped the lease';
  end if;

  -- Stops tripped after the lease: the check reports the broadest covering stop, and
  -- the deferral releases the job.
  v_dept := ops.trip_execution_stop('department', 'rg1d-test: pre-call', 'rg1d-owner', ta, ca1, da1);
  if pg_temp.worker('select ops.job_execution_stop()::text') is distinct from v_dept::text then
    raise exception 'K5: the pre-call check did not report the stop covering a job whose department is unknown';
  end if;
  v_tenant := ops.trip_execution_stop('tenant', 'rg1d-test: pre-call', 'rg1d-owner', ta);
  if pg_temp.worker('select ops.job_execution_stop()::text') is distinct from v_tenant::text then
    raise exception 'K5: the pre-call check did not report the broadest covering stop';
  end if;
  v_deferred := pg_temp.worker('select ops.defer_job()::text')::uuid;
  select * into v_after from ops.jobs j where j.id = v_job;
  if v_deferred is distinct from v_tenant or v_after.status <> 'queued' or v_after.attempts <> v_before.attempts - 1
     or v_after.lease_owner is not null or v_after.leased_at is not null or v_after.lease_expires_at is not null
     or v_after.available_at <> now() + interval '30 seconds' or v_after.completed_at is not null then
    raise exception 'K5: a deferral did not return the job to the queue 30 seconds later with its attempt restored (%, %)',
      v_deferred, to_jsonb(v_after);
  end if;
  select * into v_event from ops.job_events e where e.job_id = v_job order by e.id desc limit 1;
  if v_event.event <> 'deferred' or v_event.attempt <> v_before.attempts or v_event.worker_id <> 'rg1d-worker'
     or v_event.tenant_id <> ta or v_event.detail <> format('held by execution stop %s', v_tenant) then
    raise exception 'K5: a deferral was not recorded as deferred, naming its stop: %', to_jsonb(v_event);
  end if;

  -- The deferral ended the lease in this transaction.
  perform pg_temp.as_worker();
  perform pg_temp.expect_refused_with('K5 asking for the covering stop after a deferral', '42501', 'no live lease',
    'select ops.job_execution_stop()');
  perform pg_temp.expect_refused_with('K5 deferring twice', '42501', 'no live lease', 'select ops.defer_job()');
  perform pg_temp.as_owner();

  perform ops.clear_execution_stop(v_dept, 'rg1d-test: cleared', 'rg1d-owner');
  perform ops.clear_execution_stop(v_tenant, 'rg1d-test: cleared', 'rg1d-owner');
  if pg_temp.offer('rg1d-worker', v_job) is not distinct from v_job then
    raise exception 'K5: a deferred job was leased again before its delay';
  end if;
end
$$;

-- K5 (a lease that ran out). Neither capability answers on it.
do $$
declare
  v_job constant uuid := pg_temp.id('job_k_unlinked');
begin
  perform pg_temp.lease('K5 expired', v_job);
  perform pg_temp.expire_on_clock(v_job);
  perform pg_temp.as_worker();
  perform pg_temp.expect_refused_with('K5 asking for the covering stop on a lease that ran out', '42501', 'no longer live',
    'select ops.job_execution_stop()');
  perform pg_temp.expect_refused_with('K5 deferring on a lease that ran out', '42501', 'no longer live',
    'select ops.defer_job()');
  perform pg_temp.as_owner();
end
$$;

create or replace function ops.external_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update', 'calendar.cancel']::text[];
$function$;

-- ===========================================================================
-- E. THE CEILING SWEEP. ops.enforce_spend_ceiling() trips a global system stop only
--    when the global version in force is exhausted by settled spend, and never
--    clears one. The call in flight from section A stays in flight throughout.
-- ===========================================================================
do $$
declare
  v_r constant bigint := pg_temp.number('reservation_adm');
  v_limit   uuid;
  v_z       uuid;
  v_w       uuid;
  v_stop    uuid;
  v_owner   uuid;
  v_again   uuid;
  v_err     text;
  v_state   text;
  s         ops.execution_stops;
begin
  if exists (select 1 from ops.execution_stops x where x.cleared_at is null) then
    raise exception 'E: an execution stop is already active; this section would prove nothing';
  end if;
  if pg_temp.run_status(pg_temp.id('run_a_in_flight')) is distinct from 'running' then
    raise exception 'E: no call is in flight; this section would prove nothing';
  end if;
  -- Leased before any stop can hold them.
  v_z := pg_temp.adm_run('rg1d-e-contended');
  v_w := pg_temp.adm_run('rg1d-e-exhausted');

  -- E0. A fresh version with room: nothing to trip.
  perform pg_temp.set_limit('global', pg_temp.huge() - 1);
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E0: the ceiling sweep tripped a stop with the ceiling far from reached';
  end if;

  -- E1. No ceiling: nothing to reach, and every start refuses anyway.
  perform pg_temp.retire_limit('global');
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E1: the ceiling sweep tripped a stop with no ceiling configured';
  end if;

  -- E2. Contention and reservations in flight never trip it.
  perform pg_temp.set_limit('global', pg_temp.settled('global') + v_r);
  perform pg_temp.resume('E2', pg_temp.job_of(v_z));
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_err := pg_temp.attempt($q$select ops.start_agent_run('fake', 'rg1d-model', 'task_assessment.v1', repeat('f', 64), 8000)$q$);
  perform pg_temp.as_owner();
  if v_err is null or v_err not like 'OS429 %' then
    raise exception 'E2: the start at the ceiling was not contended (%); this case would prove nothing', v_err;
  end if;
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E2: the ceiling sweep tripped a stop because a start was contended';
  end if;
  perform pg_temp.set_limit('global', pg_temp.settled('global') + 1);
  if pg_temp.charged('global') < pg_temp.settled('global') + 1 then
    raise exception 'E2: the charges in flight do not reach the ceiling; this case would prove nothing';
  end if;
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E2: the ceiling sweep tripped on reservations still in flight';
  end if;

  -- E3. A refusal by the version in force trips a global system stop, once.
  v_limit := pg_temp.set_limit('global', pg_temp.settled('global') + v_r - 1);
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E3: the ceiling sweep tripped before settled spend or a refusal exhausted the ceiling';
  end if;
  perform pg_temp.resume('E3', pg_temp.job_of(v_w));
  v_state := pg_temp.start();
  if v_state is distinct from 'cancelled' or (pg_temp.run(v_w)).spend_limit_id is distinct from v_limit then
    raise exception 'E3: the start was not refused by the ceiling (%); this case would prove nothing', v_state;
  end if;
  v_stop := ops.enforce_spend_ceiling();
  select * into s from ops.execution_stops x where x.id = v_stop;
  if v_stop is null or s.scope <> 'global' or s.tripped_by <> 'system:spend_ceiling' or s.origin <> 'system'
     or s.cleared_at is not null or strpos(s.reason, v_limit::text) = 0 then
    raise exception 'E3: a ceiling version that refused a run today did not trip a global system stop naming it (%)', to_jsonb(s);
  end if;
  if ops.enforce_spend_ceiling() is not null
     or (select count(*) from ops.execution_stops x where x.cleared_at is null) <> 1 then
    raise exception 'E3: the ceiling sweep tripped a second stop while its own was active';
  end if;

  -- E4. An owner's global stop is not the sweep's, and the sweep never clears one.
  v_owner := ops.trip_execution_stop('global', 'rg1d-test: owner incident', 'rg1d-owner');
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared by the owner', 'rg1d-owner');
  v_again := ops.enforce_spend_ceiling();
  if v_again is null or v_again = v_owner or v_again = v_stop
     or (select x.origin from ops.execution_stops x where x.id = v_again) <> 'system' then
    raise exception 'E4: an owner''s global stop was taken for the ceiling''s own, or the sweep did not re-trip (%)', v_again;
  end if;
  if ops.enforce_spend_ceiling() is not null
     or exists (select 1 from ops.execution_stops x where x.id in (v_owner, v_again) and x.cleared_at is not null) then
    raise exception 'E4: the ceiling sweep cleared a stop, or tripped twice';
  end if;
  perform ops.clear_execution_stop(v_again, 'rg1d-test: cleared by the owner', 'rg1d-owner');
  v_again := ops.enforce_spend_ceiling();
  if v_again is null then
    raise exception 'E4: clearing the ceiling''s stop while its version is still exhausted did not re-trip it';
  end if;
  perform ops.clear_execution_stop(v_again, 'rg1d-test: cleared by the owner', 'rg1d-owner');
  perform ops.clear_execution_stop(v_owner, 'rg1d-test: cleared', 'rg1d-owner');

  -- E5. A new version's day does not start clean: only the old version's refusal
  --     stops counting, so it no longer trips; today's settled spend still counts
  --     against the new version (E6).
  perform pg_temp.set_limit('global', pg_temp.huge());
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E5: a refusal by a superseded ceiling version still tripped the sweep';
  end if;

  -- E6. Settled spend that reaches the version in force trips it, from a worker with
  --     no lease.
  perform pg_temp.set_limit('global', pg_temp.settled('global'));
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  v_stop := pg_temp.worker('select ops.enforce_spend_ceiling()::text')::uuid;
  if v_stop is null or (select x.tripped_by from ops.execution_stops x where x.id = v_stop) <> 'system:spend_ceiling' then
    raise exception 'E6: settled spend that reached the ceiling did not trip a system stop from the worker''s sweep';
  end if;
  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared', 'rg1d-owner');
  perform pg_temp.set_limit('global', pg_temp.huge());
  if exists (select 1 from ops.execution_stops x where x.cleared_at is null) then
    raise exception 'E: a stop is still active at the end of the section';
  end if;
end
$$;

-- E7. Only a refusal recorded TODAY trips the sweep: a budget_exhausted refusal by
--     the very version in force that completed before its day began does not. The
--     old refusal is backdated with the update guard off, and a refusal recorded
--     now is the control. Both are rolled back.
do $$
declare
  v_limit constant uuid := pg_temp.active_limit('global');
  v_since constant timestamptz := ops.spend_window_start('UTC', now());
  c_refusal constant text :=
    $s$status = 'cancelled', error_category = 'refused', error_code = 'budget_exhausted', spend_limit_id = %L$s$;
  v_run       uuid;
  v_yesterday uuid;
  v_today     uuid;
  v_completed timestamptz;
begin
  if v_limit is null or (select l.timezone from ops.spend_limits l where l.id = v_limit) <> 'UTC'
     or ops.enforce_spend_ceiling() is not null then
    raise exception 'E7: the global ceiling in force is missing, not in UTC, or already exhausted; this case would prove nothing';
  end if;
  begin
    v_run := pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_adm', 'agent_a1');
    execute 'alter table ops.agent_runs disable trigger agent_runs_guard_update';
    perform pg_temp.raw_update(v_run, format(c_refusal || ', completed_at = %L', v_limit, v_since - interval '1 minute'));
    execute 'alter table ops.agent_runs enable always trigger agent_runs_guard_update';
    v_completed := (pg_temp.run(v_run)).completed_at;
    v_yesterday := ops.enforce_spend_ceiling();

    v_run := pg_temp.raw_pending_run('tenant_a', 'company_a1', 'dept_a1', 'task_adm', 'agent_a1');
    perform pg_temp.raw_update(v_run, format(c_refusal, v_limit));
    v_today := ops.enforce_spend_ceiling();
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_completed is distinct from v_since - interval '1 minute' then
    raise exception 'E7: the old refusal was not backdated before the window (%); this case would prove nothing', v_completed;
  end if;
  if v_yesterday is not null then
    raise exception 'E7: the ceiling sweep tripped on a refusal recorded before the day of the ceiling began';
  end if;
  if v_today is null then
    raise exception 'E7: the control refusal recorded today did not trip the sweep, so the case above proves nothing';
  end if;
end
$$;

-- E8. Owner decision D: only a person clears the ceiling's stop. While it is active, a
--     new ceiling version with room and a new price version change nothing: the sweep
--     answers NULL, the stop stays uncleared, and a queued agent run is still held at
--     the lease. A tenant or company budget exhausted by settled spend never trips a
--     stop, and the sweep's body has no statement that could clear or rewrite one.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_tenant  bigint;
  v_company bigint;
  v_run     uuid;
  v_job     uuid;
  v_stop    uuid;
  v_price   uuid;
  v_def     text;
  s         ops.execution_stops;
begin
  if exists (select 1 from ops.execution_stops x where x.cleared_at is null) then
    raise exception 'E8: an execution stop is already active; this case would prove nothing';
  end if;
  select l.daily_limit_micros into v_tenant
    from ops.spend_limits l where l.id = pg_temp.active_limit('tenant', ta);
  select l.daily_limit_micros into v_company
    from ops.spend_limits l where l.id = pg_temp.active_limit('company', ta, ca1);

  -- A budget below the ceiling, reached by settled spend: refused runs, never a stop.
  perform pg_temp.set_limit('tenant', pg_temp.settled('tenant', ta), ta);
  perform pg_temp.set_limit('company', pg_temp.settled('company', ta, ca1), ta, ca1);
  if ops.enforce_spend_ceiling() is not null
     or exists (select 1 from ops.execution_stops x where x.cleared_at is null) then
    raise exception 'E8: a tenant or company budget exhausted by settled spend tripped a stop';
  end if;
  perform pg_temp.set_limit('tenant', coalesce(v_tenant, pg_temp.huge()), ta);
  if v_company is null then
    perform pg_temp.retire_limit('company', ta, ca1);
  else
    perform pg_temp.set_limit('company', v_company, ta, ca1);
  end if;

  -- Queued before the stop, so only the lease can hold it.
  v_run := pg_temp.request('rg1d-e8-held', 'tenant_a', 'task_adm', 'agent_a1');
  v_job := pg_temp.job_of(v_run);
  perform pg_temp.set_limit('global', pg_temp.settled('global'));
  v_stop := ops.enforce_spend_ceiling();
  if v_stop is null then
    raise exception 'E8: settled spend at the ceiling did not trip the stop; this case would prove nothing';
  end if;

  perform pg_temp.set_limit('global', pg_temp.huge());
  v_price := ops.record_model_price('fake', 'rg1d-model', 2, 2, true, now() - interval '23 seconds',
                                    now() + interval '1 day', 'rg1d-test: E8 new price', 'rg1d-owner');
  if ops.current_model_price('fake', 'rg1d-model', now()) is distinct from v_price then
    raise exception 'E8: the new price version is not the current one; this case would prove nothing';
  end if;
  if ops.enforce_spend_ceiling() is not null then
    raise exception 'E8: the sweep tripped again while its own stop was active';
  end if;
  select * into s from ops.execution_stops x where x.id = v_stop;
  if s.cleared_at is not null or s.cleared_by is not null or s.cleared_reason is not null then
    raise exception 'E8: a new ceiling version or a new price cleared the ceiling''s stop (%)', to_jsonb(s);
  end if;
  perform pg_temp.expect_held('E8 a queued run under the ceiling''s stop', v_job);
  if pg_temp.run_status(v_run) <> 'pending' then
    raise exception 'E8: a run held by the ceiling''s stop changed state';
  end if;

  v_def := pg_get_functiondef('ops.enforce_spend_ceiling()'::regprocedure);
  if v_def ~* 'update\s+ops\.execution_stops' or v_def ~* 'delete\s+from\s+ops\.execution_stops'
     or v_def ~* 'clear_execution_stop' then
    raise exception 'E8: the ceiling sweep has a statement that could clear or rewrite a stop';
  end if;

  perform ops.clear_execution_stop(v_stop, 'rg1d-test: cleared by a person', 'rg1d-owner');
  delete from ops.model_prices where id = v_price;
end
$$;

-- ===========================================================================
-- I. IDEMPOTENT DOMAIN CREATES.
-- ===========================================================================

-- I1-I4. ops.create_task with a key.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  tb  constant uuid := pg_temp.id('tenant_b');
  ca1 constant uuid := pg_temp.id('company_a1');
  cb  constant uuid := pg_temp.id('company_b');
  da1 constant uuid := pg_temp.id('dept_a1');
  c_call constant text := $q$select ops.create_task(
      p_tenant_id => %L, p_company_id => %L, p_type => %L, p_title => %L, p_source => 'rg1d-test',
      p_description => %L, p_department_id => %L, p_parent_task_id => %L, p_priority => %s,
      p_due_at => %L, p_idempotency_key => 'rg1d-i-task')$q$;
  v_task    uuid;
  v_again   uuid;
  v_other   uuid;
  v_tasks   bigint;
  v_created bigint;
  v_case    record;
  v_n       integer := 0;
  v_first   uuid;
  v_second  uuid;
begin
  v_task := ops.create_task(ta, ca1, 'work.review', 'Idempotent review', 'rg1d-test', 'Review once.', da1,
                            pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z', null, null, 'rg1d-i-task');
  perform pg_temp.remember('task_i', v_task);
  select count(*) into v_tasks from ops.tasks t where t.tenant_id = ta;
  select count(*) into v_created from ops.events e where e.tenant_id = ta and e.type = 'task.created';

  -- I1. The same request under the same key, from another source and lineage, is a replay.
  begin
    v_again := ops.create_task(ta, ca1, 'work.review', 'Idempotent review', 'rg1d-retry', 'Review once.', da1,
                               pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z', gen_random_uuid(), null, 'rg1d-i-task');
  exception when others then
    raise exception 'I1: replaying the same task create was refused (% %)', sqlstate, sqlerrm;
  end;
  if v_again is distinct from v_task then
    raise exception 'I1: replaying a task create returned another task (% then %)', v_task, v_again;
  end if;
  if (select count(*) from ops.tasks t where t.tenant_id = ta) <> v_tasks
     or (select count(*) from ops.events e where e.tenant_id = ta and e.type = 'task.created') <> v_created
     or (select count(*) from ops.events e where e.subject_id = v_task and e.type = 'task.created') <> 1 then
    raise exception 'I1: replaying a task create stored a second task or a second task.created fact';
  end if;

  -- I2. The same key for a different request.
  for v_case in
    select * from (values
      ('I2 the same task key with another title',
       format(c_call, ta, ca1, 'work.review', 'Another title', 'Review once.', da1, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key in another company',
       format(c_call, ta, pg_temp.id('company_a2'), 'work.review', 'Idempotent review', 'Review once.', da1, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key in another department',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review once.', pg_temp.id('dept_a1_support'), pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key with no department',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review once.', null, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key under another parent',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review once.', da1, pg_temp.id('task_k'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key with another type',
       format(c_call, ta, ca1, 'work.triage', 'Idempotent review', 'Review once.', da1, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key with another description',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review twice.', da1, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key with no description',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', null, da1, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:00Z')),
      ('I2 the same task key with another priority',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review once.', da1, pg_temp.id('task_i_parent'), 301, '2026-10-01T12:00:00Z')),
      ('I2 the same task key with another due date',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review once.', da1, pg_temp.id('task_i_parent'), 300, '2026-10-01T12:00:01Z')),
      ('I2 the same task key with no due date',
       format(c_call, ta, ca1, 'work.review', 'Idempotent review', 'Review once.', da1, pg_temp.id('task_i_parent'), 300, null))
    ) as c (label, statement)
  loop
    perform pg_temp.expect_refused(v_case.label, 'OS409', v_case.statement);
    v_n := v_n + 1;
  end loop;
  if v_n <> 11 or (select count(*) from ops.tasks t where t.tenant_id = ta) <> v_tasks then
    raise exception 'I2: % conflicting creates ran (expected 11), or one stored a task', v_n;
  end if;

  -- I3. Keys are tenant-scoped: the same key in tenant B is its own request.
  v_other := ops.create_task(tb, cb, 'work.review', 'Idempotent review', 'rg1d-test', 'Review once.', null, null,
                             300, '2026-10-01T12:00:00Z', null, null, 'rg1d-i-task');
  if v_other is not distinct from v_task
     or (select t.tenant_id from ops.tasks t where t.id = v_other) is distinct from tb
     or ops.create_task(tb, cb, 'work.review', 'Idempotent review', 'rg1d-test', 'Review once.', null, null,
                        300, '2026-10-01T12:00:00Z', null, null, 'rg1d-i-task') is distinct from v_other then
    raise exception 'I3: the same key in another tenant did not name that tenant''s own task';
  end if;

  -- The default priority is the priority the fingerprint records.
  v_first := ops.create_task(ta, ca1, 'work.review', 'Default priority', 'rg1d-test', p_idempotency_key => 'rg1d-i-default');
  if ops.create_task(ta, ca1, 'work.review', 'Default priority', 'rg1d-test', p_priority => 100,
                     p_idempotency_key => 'rg1d-i-default') is distinct from v_first
     or ops.create_task(ta, ca1, 'work.review', 'Default priority', 'rg1d-test', p_priority => null,
                        p_idempotency_key => 'rg1d-i-default') is distinct from v_first then
    raise exception 'I1: a replay spelling the default priority differently was not the same request';
  end if;

  -- I4. Without a key, nothing changes: two calls, two tasks, no key or fingerprint.
  v_first := ops.create_task(ta, ca1, 'work.review', 'Keyless review', 'rg1d-test');
  v_second := ops.create_task(ta, ca1, 'work.review', 'Keyless review', 'rg1d-test');
  if v_first = v_second
     or exists (select 1 from ops.tasks t where t.id in (v_first, v_second)
                   and (t.idempotency_key is not null or t.request_fingerprint is not null)) then
    raise exception 'I4: a create without a key was deduplicated or stored a key';
  end if;
  perform pg_temp.remember('task_i_keyless', v_first);
end
$$;

-- I5. The fingerprint is derived from the stored row, never taken from the caller,
--     and it is the one the service computes.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_id uuid;
  v_fp text;
begin
  perform set_config('app.event_source', 'rg1d-raw', true);
  insert into ops.tasks (tenant_id, company_id, type, title, idempotency_key, request_fingerprint)
  values (ta, ca1, 'work.review', 'Raw with a key', 'rg1d-i-raw', repeat('0', 64))
  returning id, request_fingerprint into v_id, v_fp;
  if v_fp is distinct from ops.task_request_fingerprint(ca1, null, null, 'work.review', 'Raw with a key', null, 100, null) then
    raise exception 'I5: a raw insert kept a caller''s request fingerprint (%)', v_fp;
  end if;
  if ops.create_task(ta, ca1, 'work.review', 'Raw with a key', 'rg1d-test', p_idempotency_key => 'rg1d-i-raw') is distinct from v_id then
    raise exception 'I5: the service''s fingerprint differs from the one the database derived';
  end if;
  insert into ops.tasks (tenant_id, company_id, type, title, idempotency_key)
  values (ta, ca1, 'work.review', 'Raw with a key only', 'rg1d-i-raw-two')
  returning request_fingerprint into v_fp;
  if v_fp is null then
    raise exception 'I5: a raw insert with a key and no fingerprint was not given one';
  end if;
  insert into ops.tasks (tenant_id, company_id, type, title, request_fingerprint)
  values (ta, ca1, 'work.review', 'Raw with a fingerprint only', repeat('0', 64))
  returning request_fingerprint into v_fp;
  if v_fp is not null then
    raise exception 'I5: a raw insert with no key kept a fingerprint';
  end if;
  perform set_config('app.event_source', '', true);
end
$$;

-- I6. The key and fingerprint are fixed once stored, replica mode included.
select pg_temp.expect_refused('I6 changing a task''s idempotency key', 'OS409',
  format('update ops.tasks set idempotency_key = ''rg1d-i-other'' where id = %L', pg_temp.id('task_i')));
select pg_temp.expect_refused('I6 removing a task''s idempotency key', 'OS409',
  format('update ops.tasks set idempotency_key = null, request_fingerprint = null where id = %L', pg_temp.id('task_i')));
select pg_temp.expect_refused('I6 changing a task''s request fingerprint', 'OS409',
  format('update ops.tasks set request_fingerprint = repeat(''1'', 64) where id = %L', pg_temp.id('task_i')));
select pg_temp.expect_refused('I6 giving a keyless task a key', 'OS409',
  format($q$update ops.tasks set idempotency_key = 'rg1d-i-late', request_fingerprint = repeat('1', 64) where id = %L$q$,
         pg_temp.id('task_i_keyless')));
set local session_replication_role = replica;
do $$
begin
  begin
    update ops.tasks set idempotency_key = 'rg1d-i-replica' where id = pg_temp.id('task_i');
    raise exception 'I6: replica mode silenced tasks_request_identity_update; the guard must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    update ops.events set request_fingerprint = repeat('1', 64)
     where id = (select e.id from ops.events e where e.subject_id = pg_temp.id('task_i') limit 1);
    raise exception 'I6: replica mode let an event be updated';
  exception when sqlstate 'OS409' then null;
  end;
end
$$;
set local session_replication_role = origin;

-- I7. The fingerprint does not depend on the session time zone.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_zone constant text := current_setting('timezone');
  v_first  uuid;
  v_second uuid;
  v_fp_one text;
  v_fp_two text;
  v_err    text;
begin
  perform set_config('timezone', 'Pacific/Kiritimati', true);
  v_first := ops.create_task(ta, ca1, 'work.review', 'Due in two zones', 'rg1d-test',
                             p_due_at => '2026-10-01T12:00:00Z', p_idempotency_key => 'rg1d-i-zone');
  v_fp_one := ops.task_request_fingerprint(ca1, null, null, 'work.review', 'Due in two zones', null, 100, '2026-10-01T12:00:00Z');
  perform set_config('timezone', 'America/Sao_Paulo', true);
  begin
    v_second := ops.create_task(ta, ca1, 'work.review', 'Due in two zones', 'rg1d-test',
                                p_due_at => '2026-10-01 09:00:00-03', p_idempotency_key => 'rg1d-i-zone');
  exception when others then
    raise exception 'I7: the request fingerprint changed with the session time zone: the same instant was refused (% %)',
      sqlstate, sqlerrm;
  end;
  v_fp_two := ops.task_request_fingerprint(ca1, null, null, 'work.review', 'Due in two zones', null, 100, '2026-10-01T12:00:00Z');
  -- The same wall-clock time in this zone is another instant, so another request.
  v_err := pg_temp.attempt($q$select ops.create_task(
    (select current_setting('rg1d.tenant_a')::uuid), (select current_setting('rg1d.company_a1')::uuid),
    'work.review', 'Due in two zones', 'rg1d-test', p_due_at => '2026-10-01 12:00:00',
    p_idempotency_key => 'rg1d-i-zone')$q$);
  perform set_config('timezone', v_zone, true);
  if v_second is distinct from v_first or v_fp_one is distinct from v_fp_two
     or v_fp_one is distinct from (select t.request_fingerprint from ops.tasks t where t.id = v_first) then
    raise exception 'I7: the request fingerprint changed with the session time zone (% / %)', v_fp_one, v_fp_two;
  end if;
  if v_err is null or v_err not like 'OS409 %' then
    raise exception 'I7: another instant with the same wall-clock time was taken for the same request (%)', v_err;
  end if;
end
$$;

-- I8. A malformed key is refused.
select pg_temp.expect_refused('I8 a task key with a space', 'OS400', format($q$
  select ops.create_task(%L, %L, 'work.review', 'Bad key', 'rg1d-test', p_idempotency_key => 'bad key')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('I8 an empty task key', 'OS400', format($q$
  select ops.create_task(%L, %L, 'work.review', 'Bad key', 'rg1d-test', p_idempotency_key => '')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('I8 an over-long task key', 'OS400', format($q$
  select ops.create_task(%L, %L, 'work.review', 'Bad key', 'rg1d-test', p_idempotency_key => repeat('k', 201))
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('I8 a task key outside printable ASCII', 'OS400', format($q$
  select ops.create_task(%L, %L, 'work.review', 'Bad key', 'rg1d-test', p_idempotency_key => 'cl' || chr(233))
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('I8 an event key with a space', 'OS400', format($q$
  select ops.record_event(%L, %L, 'rg1d.fact_recorded', 'rg1d-test', p_idempotency_key => 'bad key')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('I8 an over-long event key', 'OS400', format($q$
  select ops.record_event(%L, %L, 'rg1d.fact_recorded', 'rg1d-test', p_idempotency_key => repeat('k', 201))
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));

-- I9. ops.record_event with a key.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  tb  constant uuid := pg_temp.id('tenant_b');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_task constant uuid := pg_temp.id('task_i');
  c_call constant text := $q$select ops.record_event(
      p_tenant_id => %L, p_company_id => %L, p_type => %L, p_source => %L, p_subject_type => %L,
      p_subject_id => %L, p_payload => %L, p_causation_id => %L, p_idempotency_key => 'rg1d-e-fact')$q$;
  c_payload constant jsonb := '{"a": 1, "b": {"c": 2, "d": 3}}';
  v_event  uuid;
  v_cause  uuid;
  v_first  uuid;
  v_second uuid;
  v_events bigint;
  v_case   record;
  v_n      integer := 0;
begin
  v_cause := (select e.id from ops.events e where e.subject_id = v_task and e.type = 'task.created');
  v_event := ops.record_event(ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', 'task', v_task, c_payload, null, null, 'rg1d-e-fact');
  select count(*) into v_events from ops.events e where e.tenant_id = ta;

  if ops.record_event(ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', 'task', v_task,
                      '{"b": {"d": 3, "c": 2}, "a": 1}', gen_random_uuid(), null, 'rg1d-e-fact') is distinct from v_event then
    raise exception 'I9: replaying an event with its payload keys in another order was not the same request';
  end if;
  if (select count(*) from ops.events e where e.tenant_id = ta) <> v_events
     or (select count(*) from ops.events e where e.idempotency_key = 'rg1d-e-fact' and e.tenant_id = ta) <> 1 then
    raise exception 'I9: replaying an event recorded a second fact';
  end if;

  for v_case in
    select * from (values
      ('I9 the same event key with another type',
       format(c_call, ta, ca1, 'rg1d.other_fact', 'rg1d-test', 'task', v_task, c_payload, null)),
      ('I9 the same event key from another source',
       format(c_call, ta, ca1, 'rg1d.fact_recorded', 'rg1d-other', 'task', v_task, c_payload, null)),
      ('I9 the same event key about another subject',
       format(c_call, ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', 'task', pg_temp.id('task_k'), c_payload, null)),
      ('I9 the same event key about no subject',
       format(c_call, ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', null, null, c_payload, null)),
      ('I9 the same event key with another payload',
       format(c_call, ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', 'task', v_task, '{"a": 2, "b": {"c": 2, "d": 3}}', null)),
      ('I9 the same event key with an empty payload',
       format(c_call, ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', 'task', v_task, '{}', null)),
      ('I9 the same event key with another cause',
       format(c_call, ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', 'task', v_task, c_payload, v_cause)),
      ('I9 the same event key in another company',
       format(c_call, ta, pg_temp.id('company_a2'), 'rg1d.fact_recorded', 'rg1d-test', 'task', v_task, c_payload, null))
    ) as c (label, statement)
  loop
    perform pg_temp.expect_refused(v_case.label, 'OS409', v_case.statement);
    v_n := v_n + 1;
  end loop;
  if v_n <> 8 or (select count(*) from ops.events e where e.tenant_id = ta) <> v_events then
    raise exception 'I9: % conflicting events ran (expected 8), or one was recorded', v_n;
  end if;

  -- No payload and an empty payload are the same request.
  v_first := ops.record_event(ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', p_payload => null, p_idempotency_key => 'rg1d-e-empty');
  if ops.record_event(ta, ca1, 'rg1d.fact_recorded', 'rg1d-test', p_payload => '{}', p_idempotency_key => 'rg1d-e-empty')
     is distinct from v_first then
    raise exception 'I9: an event replayed with an empty payload instead of none was not the same request';
  end if;

  -- Keys are tenant-scoped.
  v_second := ops.record_event(tb, pg_temp.id('company_b'), 'rg1d.fact_recorded', 'rg1d-test', p_idempotency_key => 'rg1d-e-fact');
  if v_second is not distinct from v_event or (select e.tenant_id from ops.events e where e.id = v_second) is distinct from tb then
    raise exception 'I9: the same event key in another tenant did not record that tenant''s own fact';
  end if;

  -- Without a key: two calls, two facts.
  v_first := ops.record_event(ta, ca1, 'rg1d.keyless_fact', 'rg1d-test');
  v_second := ops.record_event(ta, ca1, 'rg1d.keyless_fact', 'rg1d-test');
  if v_first = v_second
     or exists (select 1 from ops.events e where e.id in (v_first, v_second)
                   and (e.idempotency_key is not null or e.request_fingerprint is not null)) then
    raise exception 'I9: an event without a key was deduplicated or stored a key';
  end if;

  -- A lifecycle namespace is still refused, key or not, and records nothing.
  perform pg_temp.expect_refused('I9 recording a lifecycle fact under a key', 'OS403', format($q$
    select ops.record_event(%L, %L, 'task.created', 'rg1d-attack', 'task', %L, p_idempotency_key => 'rg1d-e-forged')
  $q$, ta, ca1, v_task));
  if exists (select 1 from ops.events e where e.idempotency_key = 'rg1d-e-forged') then
    raise exception 'I9: a refused lifecycle fact was stored';
  end if;

  -- Events are still never updated, their key included.
  perform pg_temp.expect_refused('I9 updating an event''s payload', 'OS409',
    format($q$update ops.events set payload = '{}' where id = %L$q$, v_event));
  perform pg_temp.expect_refused('I9 updating an event''s idempotency key', 'OS409',
    format('update ops.events set idempotency_key = null, request_fingerprint = null where id = %L', v_event));

  -- A raw insert's fingerprint is derived, and it is the one the service computes.
  perform set_config('app.event_source', 'rg1d-raw', true);
  insert into ops.events (tenant_id, company_id, type, source, payload, idempotency_key, request_fingerprint)
  values (ta, ca1, 'rg1d.raw_fact', 'rg1d-raw', '{"x": 1}', 'rg1d-e-raw', repeat('0', 64))
  returning id into v_first;
  perform set_config('app.event_source', '', true);
  if (select e.request_fingerprint from ops.events e where e.id = v_first) = repeat('0', 64)
     or ops.record_event(ta, ca1, 'rg1d.raw_fact', 'rg1d-raw', p_payload => '{"x": 1}', p_idempotency_key => 'rg1d-e-raw')
        is distinct from v_first then
    raise exception 'I9: a raw event kept a caller''s fingerprint, or the service computes another one';
  end if;
end
$$;

-- ===========================================================================
-- G. GRANTS AND SURFACE.
-- ===========================================================================
do $$
declare
  c_roles constant text[] := array['anon', 'authenticated', 'service_role', 'ops_worker'];
  c_worker_capabilities constant regprocedure[] := array[
    'ops.job_execution_stop()', 'ops.defer_job()', 'ops.enforce_spend_ceiling()']::regprocedure[];
  -- Every function the runtime governance migration defines or replaces that is not
  -- a worker capability.
  c_owner_only constant regprocedure[] := array[
    'ops.external_job_kinds()', 'ops.internal_job_kinds()', 'ops.require_read_committed(text)',
    'ops.agent_run_route_policies()', 'ops.agent_run_input_token_ceiling(jsonb)',
    'ops.agent_run_reserved_error_codes()', 'ops.spend_lock_namespace()', 'ops.spend_lock_key(text, uuid, uuid)',
    'ops.execution_stop_covers(text, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, uuid)',
    'ops.guard_model_price_insert()', 'ops.refuse_model_price_change()', 'ops.guard_spend_limit_insert()',
    'ops.guard_spend_limit_update()', 'ops.guard_spend_limit_delete()', 'ops.refuse_spend_limit_truncate()',
    'ops.guard_execution_stop_update()',
    'ops.task_request_fingerprint(uuid, uuid, uuid, text, text, text, integer, timestamptz)',
    'ops.event_request_fingerprint(uuid, text, text, text, uuid, jsonb, uuid)',
    'ops.derive_task_request_identity()', 'ops.derive_event_request_identity()', 'ops.guard_task_request_identity()',
    'ops.covering_execution_stop(uuid, text, uuid, uuid, uuid)', 'ops.active_execution_stop(uuid, uuid, uuid, uuid)',
    'ops.job_covering_stop(uuid, uuid, text)', 'ops.current_model_price(text, text, timestamptz)',
    'ops.agent_run_reservation_micros(uuid, integer, integer)',
    'ops.agent_run_estimated_cost_micros(uuid, integer, integer, integer, integer, integer)',
    'ops.spend_window_start(text, timestamptz)', 'ops.spend_window_total(text, uuid, uuid, timestamptz)',
    'ops.spend_admission(uuid, uuid, bigint, boolean)', 'ops.guard_agent_run_insert()', 'ops.guard_agent_run_update()',
    'ops.record_model_price(text, text, numeric, numeric, boolean, timestamptz, timestamptz, text, text, numeric)',
    'ops.set_spend_limit(text, bigint, text, text, text, uuid, uuid)', 'ops.retire_spend_limit(uuid, text, text)',
    'ops.spend_status(timestamptz)', 'ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid, text)',
    'ops.request_agent_run(uuid, uuid, uuid, text, text, text, uuid)',
    'ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid, text)',
    'ops.record_event(uuid, uuid, text, text, text, uuid, jsonb, uuid, uuid, text)',
    'ops.leased_job()']::regprocedure[];
  v_bad text;
begin
  -- G1. No application role holds any privilege on the price or limit tables.
  select string_agg(format('%s:%s:%s', r.rolname, t.relname, p.priv), ', ') into v_bad
    from unnest(array['model_prices', 'spend_limits']) as t (relname)
   cross join unnest(c_roles) as r (rolname)
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where has_table_privilege(r.rolname, format('ops.%I', t.relname), p.priv)
      or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          and has_any_column_privilege(r.rolname, format('ops.%I', t.relname), p.priv));
  if v_bad is not null then
    raise exception 'G1: a price or limit table is reachable by an application role: %', v_bad;
  end if;

  -- G2. None of the owner services or helpers is executable by an application role.
  select string_agg(format('%s:%s', r.rolname, f), ', ') into v_bad
    from unnest(c_owner_only) as f
   cross join unnest(c_roles) as r (rolname)
   where has_function_privilege(r.rolname, f, 'EXECUTE');
  if v_bad is not null then
    raise exception 'G2: a runtime governance owner service or helper is executable by an application role: %', v_bad;
  end if;
  if cardinality(c_owner_only) <> 41 then
    raise exception 'G2: the owner-only list has % entries, expected 41; a function was dropped from the attack', cardinality(c_owner_only);
  end if;

  -- G3. The three worker capabilities: the worker's alone, argument-free, DEFINER,
  --     with an empty search path. So is the start's new signature.
  select string_agg(format('%s:%s', r.rolname, f), ', ') into v_bad
    from unnest(c_worker_capabilities || 'ops.start_agent_run(text, text, text, text, integer)'::regprocedure) as f
   cross join unnest(array['anon', 'authenticated', 'service_role', 'public']) as r (rolname)
   where case when r.rolname = 'public'
              then exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                            where p.oid = f and a.grantee = 0 and a.privilege_type = 'EXECUTE')
              else has_function_privilege(r.rolname, f, 'EXECUTE') end;
  if v_bad is not null then
    raise exception 'G3: a worker capability is executable by a role other than ops_worker: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where p.oid = any (c_worker_capabilities)
     and (not has_function_privilege('ops_worker', p.oid, 'EXECUTE') or p.pronargs <> 0 or not p.prosecdef
          or not coalesce(p.proconfig @> array['search_path=""'], false) or p.prorettype <> 'uuid'::regtype);
  if v_bad is not null then
    raise exception 'G3: a runtime governance worker capability is not an argument-free DEFINER function of the worker with an empty search path: %', v_bad;
  end if;
  if not has_function_privilege('ops_worker', 'ops.start_agent_run(text, text, text, text, integer)', 'EXECUTE')
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'ops' and p.proname in ('start_agent_run', 'trip_execution_stop', 'create_task', 'record_event')) <> 4 then
    raise exception 'G3: the changed signatures are not the only overloads, or the worker lost its start';
  end if;

  -- G4. The worker holds no write verb anywhere in ops.
  select string_agg(format('%s:%s', c.relname, p.priv), ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where n.nspname = 'ops' and c.relkind in ('r', 'p', 'v', 'm')
     and has_table_privilege('ops_worker', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'G4: ops_worker holds a write privilege in ops: %', v_bad;
  end if;

  -- G5. Row security is enabled and forced, with no policy, on both new tables.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
   where c.oid in ('ops.model_prices'::regclass, 'ops.spend_limits'::regclass)
     and (not c.relrowsecurity or not c.relforcerowsecurity
          or exists (select 1 from pg_policy p where p.polrelid = c.oid));
  if v_bad is not null then
    raise exception 'G5: % lacks ENABLE + FORCE row level security, or carries a policy', v_bad;
  end if;
end
$$;

-- G6. A worker holding a real lease reaches neither the prices, nor the limits, nor
--     the services that set them.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_job     uuid;
  v_case    record;
  v_leak    text;
  v_reached text[] := '{}';
  v_tried   integer := 0;
begin
  v_job := ops.enqueue_job(ta, 'rg1d.lease_probe', '{}'::jsonb, 100, now(), 5, null);
  perform pg_temp.lease('G6', v_job);
  if pg_temp.worker('select ops.current_tenant_id()::text') is distinct from ta::text then
    raise exception 'G6: the lease did not install tenant A; this case would prove nothing';
  end if;

  for v_case in
    select * from (values
      ('select ops.model_prices', 'select count(*) from ops.model_prices'),
      ('update ops.model_prices', 'update ops.model_prices set source = source'),
      ('select ops.spend_limits', 'select count(*) from ops.spend_limits'),
      ('insert ops.spend_limits', $q$insert into ops.spend_limits (scope, daily_limit_micros, timezone, reason, set_by)
                                    values ('global', 1, 'UTC', 'rg1d-test: worker', 'rg1d-worker')$q$),
      ('update ops.spend_limits', 'update ops.spend_limits set daily_limit_micros = daily_limit_micros'),
      ('delete ops.spend_limits', 'delete from ops.spend_limits'),
      ('truncate ops.spend_limits', 'truncate ops.spend_limits'),
      ('ops.record_model_price', $q$select ops.record_model_price('fake', 'rg1d-model', 0, 0, true, now() - interval '1 second',
                                   now() + interval '1 day', 'rg1d worker price', 'rg1d-worker')$q$),
      ('ops.set_spend_limit', $q$select ops.set_spend_limit('global', 1000000000000000, 'UTC', 'rg1d-test: worker', 'rg1d-worker')$q$),
      ('ops.retire_spend_limit', $q$select ops.retire_spend_limit('00000000-0000-4000-8000-000000000000', 'rg1d-test: worker', 'rg1d-worker')$q$),
      ('ops.spend_status', 'select * from ops.spend_status()'),
      ('ops.spend_admission', format('select ops.spend_admission(%L, %L, 0, false)', ta, ca1)),
      ('ops.spend_window_total', 'select ops.spend_window_total(''global'', null, null, now())'),
      ('ops.current_model_price', $q$select ops.current_model_price('fake', 'rg1d-model', now())$q$),
      ('ops.agent_run_estimated_cost_micros',
       $q$select ops.agent_run_estimated_cost_micros('00000000-0000-4000-8000-000000000000', 1, 0, 1, 0, 2)$q$),
      ('ops.trip_execution_stop',
       $q$select ops.trip_execution_stop('job_kind', 'rg1d-test: worker', 'rg1d-worker', null, null, null, null, 'agent_run.execute')$q$),
      ('ops.job_covering_stop', format('select ops.job_covering_stop(%L, %L, ''agent_run.execute'')', ta, v_job)),
      ('ops.leased_job', 'select ops.leased_job()'),
      ('ops.create_task', format($q$select ops.create_task(%L, %L, 'work.review', 'Worker task', 'rg1d-worker',
                                   p_idempotency_key => 'rg1d-worker-key')$q$, ta, ca1)),
      ('ops.record_event', format($q$select ops.record_event(%L, %L, 'rg1d.worker_fact', 'rg1d-worker',
                                    p_idempotency_key => 'rg1d-worker-key')$q$, ta, ca1))
    ) as c (label, statement)
  loop
    v_tried := v_tried + 1;
    v_leak := pg_temp.privilege_leak('ops_worker', v_case.statement);
    if v_leak is not null then
      v_reached := v_reached || format('%s (%s)', v_case.label, v_leak);
    end if;
  end loop;
  if cardinality(v_reached) > 0 then
    raise exception 'G6: a leased worker reached runtime governance data or services: %', array_to_string(v_reached, '; ');
  end if;
  if v_tried <> 20 then
    raise exception 'G6: % attempts ran, expected 20; a case was lost', v_tried;
  end if;
  if pg_temp.worker(format('select ops.complete_job(%L)::text', v_job)) is distinct from 'true' then
    raise exception 'G6: the lease was not live after the attempts, so the refusals above may prove nothing';
  end if;
end
$$;

-- G7. Every reader of the switch refuses when row security would hide the stops, the
--     lease included, so an unreadable switch leases nothing (ADR 0010: fail closed).
--     The function owner bypasses row security, so the refusal is pinned in the body.
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'ops.lease_job(text,integer)',
    'ops.covering_execution_stop(uuid,text,uuid,uuid,uuid)',
    'ops.active_execution_stop(uuid,uuid,uuid,uuid)',
    'ops.enforce_spend_ceiling()'] loop
    if pg_get_functiondef(v_fn::regprocedure) !~ 'row_security_active\(''ops\.execution_stops''\)' then
      raise exception 'G7: % reads the stops without refusing when row security would hide them', v_fn;
    end if;
  end loop;
end
$$;

-- ===========================================================================
-- Z. What every section left, checked once more before the rollback.
-- ===========================================================================
do $$
declare
  v_bad text;
  v_unstarted bigint;
begin
  -- A run that never started carries no cost, however it ended.
  select count(*) into v_unstarted
    from ops.agent_runs r where r.tenant_id = any (pg_temp.tenants()) and r.started_at is null;
  select string_agg(r.id::text, ', ') into v_bad
    from ops.agent_runs r
   where r.tenant_id = any (pg_temp.tenants()) and r.started_at is null
     and (r.price_id is not null or r.reserved_cost_micros is not null
          or r.estimated_cost_micros is not null or r.charged_cost_micros is not null);
  if v_bad is not null then
    raise exception 'Z1: run(s) that never started carry a cost: %', v_bad;
  end if;
  if v_unstarted < 20 then
    raise exception 'Z1: only % runs never started; the check above proves little', v_unstarted;
  end if;

  -- Every started run is priced by its own provider's and model's version.
  select string_agg(r.id::text, ', ') into v_bad
    from ops.agent_runs r
    left join ops.model_prices p on p.id = r.price_id
   where r.tenant_id = any (pg_temp.tenants()) and r.started_at is not null
     and (p.id is null or p.provider <> r.provider or p.model <> r.model
          or r.reserved_cost_micros is null or r.charged_cost_micros is null);
  if v_bad is not null then
    raise exception 'Z2: started run(s) not priced by their own model''s version: %', v_bad;
  end if;

  -- Every budget refusal names a limit that applies to its run.
  select string_agg(r.id::text, ', ') into v_bad
    from ops.agent_runs r
    join ops.spend_limits l on l.id = r.spend_limit_id
   where r.tenant_id = any (pg_temp.tenants())
     and not (l.scope = 'global'
              or (l.scope = 'tenant' and l.tenant_id = r.tenant_id)
              or (l.scope = 'company' and l.tenant_id = r.tenant_id and l.company_id = r.company_id));
  if v_bad is not null then
    raise exception 'Z3: budget refusal(s) name a limit that does not apply to them: %', v_bad;
  end if;

  if exists (select 1 from ops.execution_stops x where x.cleared_at is null) then
    raise exception 'Z4: a section left an execution stop active';
  end if;
  if ops.external_job_kinds() is distinct from array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update', 'calendar.cancel']::text[] then
    raise exception 'Z4: the external job kinds were not restored inside the transaction';
  end if;
end
$$;

rollback;

-- Nothing above committed.
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'rg1d-test-%') then
    raise exception 'runtime_governance.sql left fixtures behind';
  end if;
  if exists (select 1 from ops.model_prices where recorded_by in ('rg1d-owner', 'rg1d-other-owner', 'rg1d-attacker', 'rg1d-worker')) then
    raise exception 'runtime_governance.sql left a synthetic price behind';
  end if;
  if exists (select 1 from ops.spend_limits where set_by in ('rg1d-owner', 'rg1d-other-owner', 'rg1d-worker')) then
    raise exception 'runtime_governance.sql left a spend limit behind';
  end if;
  if exists (select 1 from ops.execution_stops
              where reason like 'rg1d-test%' or tripped_by in ('rg1d-owner', 'systemic-owner', 'system:other_sweep')
                 or reason like 'the global daily spend ceiling%') then
    raise exception 'runtime_governance.sql left an execution stop behind';
  end if;
  if exists (select 1 from ops.jobs where kind in ('rg1d.probe_external', 'rg1d.unclassified', 'rg1d.lease_probe', 'rg1d.lock_probe')) then
    raise exception 'runtime_governance.sql left a job behind';
  end if;
  if ops.external_job_kinds() is distinct from array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update', 'calendar.cancel']::text[] then
    raise exception 'runtime_governance.sql left the external job kinds widened';
  end if;
end
$$;
