-- Phase 1D — attacks on the agent runtime.
--
-- The question: can an agent run be requested, claimed, started, settled or
-- recorded by anyone, for any task, in any state, other than along the one path
-- 20260914120000_agent_runtime.sql declares? Can a payload choose the run a lease
-- reaches, a reused key answer a different request, a caller choose a run's
-- lineage, a model's answer skip its contract, a stop be bypassed, or a run be
-- started twice?
--
-- WHAT ACTUALLY HOLDS IN PHASE 1D, stated so no case below is read as more:
--   * No application role holds any privilege on ops.agent_runs or
--     ops.execution_stops, and the owner services are executable by none of them
--     (section A, and section B on a real lease).
--   * The worker reaches runs only through six SECURITY DEFINER capabilities that
--     take no id. Five resolve their one run from the live lease's job and never
--     read a payload (sections C and L). The sixth, the stale-run sweep, takes no
--     lease by design, exactly like ops.reap_expired_leases, and can only settle
--     work that is already dead (section M).
--   * Composite keys and guard triggers make a cross-scope run or stop unstorable,
--     and the run state machine unbypassable, for every role but the owner
--     (sections D and H). The owner is outside that boundary by design; those
--     sections characterise how far it reaches.
--   * Idempotency, lineage, events and the kill switch are decided in the database
--     from the run's own facts, never from a caller's setting (sections E to K).
--
--   * Section N pins, case by case, every change the adversarial review (v2) made.
--
-- ONE TRANSACTION, ROLLED BACK, as in company_domain_core.sql. A lease taken here
-- expires at now() + 60 s, and now() is this transaction's start. ops.current_tenant_id()
-- judges that against now(), but the run capabilities and the sweep judge it on the
-- WALL clock, so the whole suite must finish well inside 60 s. It takes about a second;
-- a slow run fails loudly with "no longer live", never silently. No lease expires
-- unless a case expires it on purpose.

\set ON_ERROR_STOP on

begin;

-- Membership is needed to `set role ops_worker`. `grant <role> to current_user`
-- SEGFAULTS this server build; interpolate (see ops_execution_core.sql).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Helpers. Temporary, so they vanish with the transaction.
-- ---------------------------------------------------------------------------

-- Runs one statement and requires it to fail with exactly this SQLSTATE. A
-- refusal for the WRONG reason is a failure too.
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

-- The same, with one guard trigger switched off for the attempt, to prove the
-- STRUCTURAL backstop independently of the trigger in front of it. The DISABLE
-- lives in the rolled-back subtransaction either way.
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

-- The same, and the message must carry a fragment. Every capability refusal is
-- 42501, and "no live lease" and "no agent run is bound" are different properties:
-- a case that expected one and got the other has proven nothing about its own.
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
  if v_state <> p_sqlstate then
    raise exception '%: expected SQLSTATE %, got % (%)', p_label, p_sqlstate, v_state, v_message;
  end if;
  if strpos(v_message, p_fragment) = 0 then
    raise exception '%: refused with SQLSTATE % for another reason (%), expected "%"', p_label, p_sqlstate, v_message, p_fragment;
  end if;
end
$f$;

-- The five lease-bound capabilities, each called the way a worker would. The
-- sweep is deliberately absent: it takes no lease (section M).
create function pg_temp.capability_calls()
returns table (capability text, statement text)
language sql
as $f$
  select * from (values
    ('claim_agent_run', 'select ops.claim_agent_run()'),
    ('refuse_agent_run', 'select ops.refuse_agent_run(''no_route'')'),
    ('start_agent_run', 'select ops.start_agent_run(''fake'', ''fake-model-1'', ''task_assessment.v1'', repeat(''f'', 64))'),
    ('complete_agent_run', 'select ops.complete_agent_run(''{"outcome": "completed", "summary": "ok", "proposed_next_steps": []}''::jsonb, ''fake-model-1'', ''completed'', null, null, 1, 1, 2, 0, 0, 5)'),
    ('fail_agent_run', 'select ops.fail_agent_run(''timeout'', ''deadline'', null, null, null, null, null, null, null, null, 5)')
  ) as c (capability, statement)
$f$;

create function pg_temp.expect_capabilities_refused(p_label text, p_fragment text)
returns void
language plpgsql
as $f$
declare
  v_call record;
begin
  for v_call in select * from pg_temp.capability_calls() loop
    perform pg_temp.expect_refused_with(format('%s: %s', p_label, v_call.capability), '42501', p_fragment, v_call.statement);
  end loop;
end
$f$;

-- Ids travel in transaction-local settings, which every role can read.
create function pg_temp.id(p_key text)
returns uuid
language sql
as $f$ select current_setting('ar1d.' || p_key)::uuid $f$;

create function pg_temp.remember(p_key text, p_id uuid)
returns uuid
language sql
as $f$ select set_config('ar1d.' || p_key, p_id::text, true)::uuid $f$;

-- Role switches inside a block. SET LOCAL lasts until the transaction ends, and
-- RESET returns to the session's own role.
create function pg_temp.as_worker()
returns void
language plpgsql
as $f$ begin execute 'set local role ops_worker'; end $f$;

create function pg_temp.as_owner()
returns void
language plpgsql
as $f$ begin execute 'reset role'; end $f$;

-- ops.lease_job takes the queued job with the lowest priority, so a case that must
-- lease ONE job puts it first and every other fixture job behind it. Owner only.
create function pg_temp.queue_first(p_job uuid)
returns void
language plpgsql
as $f$
begin
  update ops.jobs set priority = 100
   where tenant_id in (pg_temp.id('tenant_a'), pg_temp.id('tenant_b')) and priority < 0 and id <> p_job;
  update ops.jobs set priority = -2147483648 where id = p_job;
end
$f$;

-- A REAL lease: ops_worker calls ops.lease_job, and the case fails if it was not
-- given exactly this job. Called as the owner; returns as the owner, with the
-- lease's context installed.
create function pg_temp.lease(p_label text, p_worker text, p_job uuid)
returns void
language plpgsql
as $f$
declare
  v_job ops.jobs;
begin
  perform pg_temp.queue_first(p_job);
  perform pg_temp.as_worker();
  v_job := ops.lease_job(p_worker, 60);
  perform pg_temp.as_owner();
  if v_job.id is distinct from p_job then
    raise exception '%: the lease went to %, not the fixture job %; this case would prove nothing', p_label, v_job.id, p_job;
  end if;
end
$f$;

create function pg_temp.probe_job(p_key text, p_tenant text)
returns uuid
language sql
as $f$
  select pg_temp.remember(p_key,
    ops.enqueue_job(pg_temp.id(p_tenant), 'ar1d.lease_probe', '{}'::jsonb, 100, now(), 5, null))
$f$;

create function pg_temp.open_task(p_key text, p_tenant text, p_company text)
returns uuid
language sql
as $f$
  select pg_temp.remember(p_key,
    ops.create_task(pg_temp.id(p_tenant), pg_temp.id(p_company), 'work.review',
                    format('Review the open items (%s)', p_key), 'ar1d-test',
                    'Look at the open items and propose what to do next.', null, null, 200,
                    '2026-10-01T12:00:00Z'))
$f$;

create function pg_temp.assigned_task(p_key text, p_tenant text, p_company text, p_agent text)
returns uuid
language plpgsql
as $f$
declare
  v_task uuid;
begin
  v_task := pg_temp.open_task(p_key, p_tenant, p_company);
  perform ops.assign_task(pg_temp.id(p_tenant), v_task, pg_temp.id(p_agent), 'ar1d-test');
  return v_task;
end
$f$;

-- The one legitimate request path.
create function pg_temp.request(p_key text, p_tenant text, p_task text, p_agent text, p_retry_of uuid default null)
returns uuid
language sql
as $f$
  select ops.request_agent_run(pg_temp.id(p_tenant), pg_temp.id(p_task), pg_temp.id(p_agent),
                               'task_assessment', p_key, 'ar1d-test', p_retry_of)
$f$;

create function pg_temp.request_sql(p_tenant uuid, p_task uuid, p_agent uuid, p_key text,
                                    p_capability text default 'task_assessment',
                                    p_source text default 'ar1d-attack',
                                    p_retry_of uuid default null)
returns text
language sql
as $f$
  select format('select ops.request_agent_run(%L::uuid, %L::uuid, %L::uuid, %L, %L, %L, %L::uuid)',
                p_tenant, p_task, p_agent, p_capability, p_key, p_source, p_retry_of)
$f$;

create function pg_temp.job_of(p_run uuid)
returns uuid
language sql
as $f$ select r.job_id from ops.agent_runs r where r.id = p_run $f$;

-- A tenant-A run requested and its job leased, ready for the worker's sequence.
create function pg_temp.leased_run(p_key text, p_task text, p_agent text, p_worker text default 'ar1d-worker')
returns uuid
language plpgsql
as $f$
declare
  v_run uuid;
  v_job uuid;
begin
  v_run := pg_temp.request(p_key, 'tenant_a', p_task, p_agent);
  v_job := pg_temp.job_of(v_run);
  if v_job is null then
    raise exception '%: the fixture run was given no job; this case would prove nothing', p_key;
  end if;
  perform pg_temp.lease(p_key, p_worker, v_job);
  return v_run;
end
$f$;

create function pg_temp.valid_result()
returns jsonb
language sql
as $f$
  select '{"outcome": "needs_input", "summary": "Three open items have no owner.", "proposed_next_steps": ["Name an owner for each item", "Set a due date"]}'::jsonb
$f$;

-- The claim, start and complete a healthy worker performs. Returns as the owner.
-- Completes a run this attempt already started. A second claim would be refused:
-- a run is never claimed twice by the attempt that started it.
create function pg_temp.worker_completes()
returns text
language plpgsql
as $f$
declare
  v_state text;
begin
  perform pg_temp.as_worker();
  v_state := ops.complete_agent_run(pg_temp.valid_result(), 'fake-model-1', 'completed',
                                    'fake-req-1', 'fake-resp-1', 120, 60, 180, 0, 0, 42);
  perform pg_temp.as_owner();
  return v_state;
end
$f$;

create function pg_temp.worker_succeeds()
returns text
language plpgsql
as $f$
declare
  v_state text;
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  if v_state = 'running' then
    v_state := ops.complete_agent_run(pg_temp.valid_result(), 'fake-model-1', 'completed',
                                      'fake-req-1', 'fake-resp-1', 120, 60, 180, 0, 0, 42);
  end if;
  perform pg_temp.as_owner();
  return v_state;
end
$f$;

-- Raw DML as the owner, with provenance declared, so that only the structure or
-- the guard decides. The previous provenance is restored, so a section that set
-- its own keeps it.
create function pg_temp.raw(p_sql text)
returns void
language plpgsql
as $f$
declare
  v_previous constant text := current_setting('app.event_source', true);
begin
  perform set_config('app.event_source', 'ar1d-raw', true);
  execute p_sql;
  perform set_config('app.event_source', coalesce(v_previous, ''), true);
end
$f$;

create function pg_temp.raw_run_sql(p_tenant text, p_company text, p_department text, p_task text, p_agent text,
                                    p_columns text default '', p_values text default '')
returns text
language sql
as $f$
  select format(
    'insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route, '
    || 'idempotency_key, request_fingerprint, correlation_id, requested_by%s) '
    || 'values (%L, %L, %L, %L, %L, ''task_assessment'', ''standard'', %L, repeat(''a'', 64), gen_random_uuid(), ''ar1d-raw''%s)',
    p_columns, pg_temp.id(p_tenant), pg_temp.id(p_company), pg_temp.id(p_department), pg_temp.id(p_task),
    pg_temp.id(p_agent), 'ar1d-raw-' || gen_random_uuid(), p_values)
$f$;

create function pg_temp.raw_pending_run(p_task text)
returns uuid
language plpgsql
as $f$
declare
  v_previous constant text := current_setting('app.event_source', true);
  v_id uuid;
begin
  perform set_config('app.event_source', 'ar1d-raw', true);
  execute pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', p_task, 'agent_a1') || ' returning id' into v_id;
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

create function pg_temp.running_facts()
returns text
language sql
as $f$
  select 'status = ''running'', provider = ''fake'', model = ''fake-model-1'', '
      || 'prompt_version = ''task_assessment.v1'', input_fingerprint = repeat(''c'', 64), job_attempt = 1'
$f$;

create function pg_temp.run_status(p_run uuid)
returns text
language sql
as $f$ select r.status from ops.agent_runs r where r.id = p_run $f$;

-- A raw tenant-A run in a given status, reached only through legal transitions.
create function pg_temp.raw_run_in(p_status text, p_task text default 'task_h')
returns uuid
language plpgsql
as $f$
declare
  v_run uuid;
begin
  v_run := pg_temp.raw_pending_run(p_task);
  case p_status
    when 'pending' then null;
    when 'running' then
      perform pg_temp.raw_update(v_run, pg_temp.running_facts());
    when 'succeeded' then
      perform pg_temp.raw_update(v_run, pg_temp.running_facts());
      perform pg_temp.raw_update(v_run, format('status = ''succeeded'', result = %L', pg_temp.valid_result()));
    when 'failed' then
      perform pg_temp.raw_update(v_run, $s$status = 'failed', error_category = 'configuration', error_code = 'ar1d_fixture'$s$);
    when 'indeterminate' then
      perform pg_temp.raw_update(v_run, pg_temp.running_facts());
      perform pg_temp.raw_update(v_run, $s$status = 'indeterminate', error_category = 'timeout', error_code = 'ar1d_fixture'$s$);
    when 'cancelled' then
      perform pg_temp.raw_update(v_run, $s$status = 'cancelled', error_category = 'refused', error_code = 'ar1d_fixture'$s$);
  end case;
  if pg_temp.run_status(v_run) is distinct from p_status then
    raise exception 'fixture: could not build a % run through legal transitions', p_status;
  end if;
  return v_run;
end
$f$;

create function pg_temp.run_event_types(p_run uuid)
returns text[]
language sql
as $f$
  select coalesce(array_agg(e.type order by e.seq), '{}'::text[])
    from ops.events e
   where e.subject_type = 'agent_run' and e.subject_id = p_run and e.type like 'agent\_run.%'
$f$;

-- A run's row plus how many facts it has, for "nothing changed" assertions.
create function pg_temp.run_state(p_run uuid)
returns jsonb
language sql
as $f$
  select to_jsonb(r) || jsonb_build_object('_facts',
           (select count(*) from ops.events e where e.subject_type = 'agent_run' and e.subject_id = r.id))
    from ops.agent_runs r
   where r.id = p_run
$f$;

create function pg_temp.snapshot(p_key text, p_runs uuid[])
returns void
language plpgsql
as $f$
begin
  perform set_config('ar1d.snapshot_' || p_key,
    (select jsonb_object_agg(r, pg_temp.run_state(r)) from unnest(p_runs) as r)::text, true);
end
$f$;

create function pg_temp.changed_since(p_key text)
returns text
language sql
as $f$
  select string_agg(s.key, ', ')
    from jsonb_each(current_setting('ar1d.snapshot_' || p_key)::jsonb) as s
   where pg_temp.run_state(s.key::uuid) is distinct from s.value
$f$;

-- What an agent run request can write: runs, their facts, jobs and job links.
create function pg_temp.runtime_footprint()
returns text
language sql
as $f$
  select format('runs %s, run and execution request facts %s, jobs %s, task links %s, job events %s, stops %s',
    (select count(*) from ops.agent_runs),
    (select count(*) from ops.events e where e.type like 'agent\_run.%' or e.type = 'task.execution_requested'),
    (select count(*) from ops.jobs),
    (select count(*) from ops.task_jobs),
    (select count(*) from ops.job_events),
    (select count(*) from ops.execution_stops))
$f$;

-- Runs one statement: NULL when it is accepted (its effects kept), or its SQLSTATE and
-- message when it is refused (its effects rolled back with its subtransaction).
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

-- The modes in which THIS backend holds the kill-switch advisory lock. A
-- transaction-level advisory lock is held until the transaction, or the
-- subtransaction that took it, ends. Owner only: it reads the key function.
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

-- Ends a lease DURING this transaction, on the wall clock only: it stays live by
-- now(), the transaction's start, which is all ops.current_tenant_id() reads. Owner only.
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
    raise exception 'fixture: job % is not a lease live by now() that ended on the wall clock; the case would prove nothing', p_job;
  end if;
end
$f$;

-- ---------------------------------------------------------------------------
-- Fixtures, built through the domain functions so their events are real.
-- Two tenants; tenant A holds two companies and company A1 two departments, so
-- cross-company and cross-department cases are real rows.
-- ---------------------------------------------------------------------------
do $$
declare
  ta  uuid;
  tb  uuid;
  ca1 uuid;
  ca2 uuid;
  cb  uuid;
  da1 uuid;
  da1s uuid;
  da2 uuid;
  db  uuid;
  c_source constant text := 'ar1d-test';
begin
  insert into ops.tenants (slug, name) values ('ar1d-test-alpha', 'AR1D Alpha') returning id into ta;
  insert into ops.tenants (slug, name) values ('ar1d-test-beta', 'AR1D Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);

  ca1 := pg_temp.remember('company_a1', ops.create_company(ta, 'alpha-one', 'Alpha One', c_source));
  ca2 := pg_temp.remember('company_a2', ops.create_company(ta, 'alpha-two', 'Alpha Two', c_source));
  cb  := pg_temp.remember('company_b', ops.create_company(tb, 'beta-one', 'Beta One', c_source));

  da1  := pg_temp.remember('dept_a1', ops.create_department(ta, ca1, 'operations', 'Operations', c_source));
  da1s := pg_temp.remember('dept_a1_support', ops.create_department(ta, ca1, 'support', 'Support', c_source));
  da2  := pg_temp.remember('dept_a2', ops.create_department(ta, ca2, 'operations', 'Operations', c_source));
  db   := pg_temp.remember('dept_b', ops.create_department(tb, cb, 'operations', 'Operations', c_source));

  perform pg_temp.remember('agent_a1', ops.create_agent(ta, ca1, da1, 'analyst', 'Analyst', 'Work reviewer', c_source,
                                                      'Reviews assigned work and proposes next steps.'));
  perform pg_temp.remember('agent_a1_two', ops.create_agent(ta, ca1, da1, 'analyst-two', 'Analyst Two', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_a1_idle', ops.create_agent(ta, ca1, da1, 'idle-analyst', 'Idle Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_a1_spare', ops.create_agent(ta, ca1, da1, 'spare-analyst', 'Spare Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_a1_support', ops.create_agent(ta, ca1, da1s, 'support-analyst', 'Support Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_a2', ops.create_agent(ta, ca2, da2, 'analyst', 'Analyst', 'Work reviewer', c_source));
  perform pg_temp.remember('agent_b', ops.create_agent(tb, cb, db, 'analyst', 'Analyst', 'Work reviewer', c_source));

  perform pg_temp.assigned_task('task_c', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_b', 'tenant_b', 'company_b', 'agent_b');
  perform pg_temp.assigned_task('task_b_closed', 'tenant_b', 'company_b', 'agent_b');
  perform ops.transition_task(tb, pg_temp.id('task_b_closed'), 'cancelled', c_source);
  perform pg_temp.open_task('task_e_unassigned', 'tenant_a', 'company_a1');
  perform pg_temp.assigned_task('task_e_closed', 'tenant_a', 'company_a1', 'agent_a1');
  perform ops.transition_task(ta, pg_temp.id('task_e_closed'), 'cancelled', c_source);
  perform pg_temp.assigned_task('task_e_idle', 'tenant_a', 'company_a1', 'agent_a1_idle');
  perform ops.set_agent_status(ta, pg_temp.id('agent_a1_idle'), 'inactive', c_source);
  perform pg_temp.assigned_task('task_e_company', 'tenant_a', 'company_a2', 'agent_a2');
  perform pg_temp.assigned_task('task_e_department', 'tenant_a', 'company_a1', 'agent_a1_support');
  perform pg_temp.assigned_task('task_f', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_f_b', 'tenant_b', 'company_b', 'agent_b');
  perform pg_temp.assigned_task('task_g', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_h', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_h_other', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_j', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_j_other', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_k_a1', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_k_a1two', 'tenant_a', 'company_a1', 'agent_a1_two');
  perform pg_temp.assigned_task('task_k_a1s', 'tenant_a', 'company_a1', 'agent_a1_support');
  perform pg_temp.assigned_task('task_k_a2', 'tenant_a', 'company_a2', 'agent_a2');
  perform pg_temp.assigned_task('task_k_b', 'tenant_b', 'company_b', 'agent_b');
  perform pg_temp.assigned_task('task_l', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_l_closed', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_l_reassigned', 'tenant_a', 'company_a1', 'agent_a1');
  perform pg_temp.assigned_task('task_l_spare', 'tenant_a', 'company_a1', 'agent_a1_spare');
  perform pg_temp.assigned_task('task_l_support', 'tenant_a', 'company_a1', 'agent_a1_support');
  perform pg_temp.assigned_task('task_l_a2', 'tenant_a', 'company_a2', 'agent_a2');
  perform pg_temp.assigned_task('task_m', 'tenant_a', 'company_a1', 'agent_a1');

  -- Jobs that carry no run.
  perform pg_temp.probe_job('job_b', 'tenant_a');
  perform pg_temp.probe_job('job_c_none', 'tenant_a');
  perform pg_temp.probe_job('job_d_a', 'tenant_a');
  perform pg_temp.probe_job('job_d_a2', 'tenant_a');
  perform pg_temp.probe_job('job_d_b', 'tenant_b');
  perform pg_temp.probe_job('job_h_link1', 'tenant_a');
  perform pg_temp.probe_job('job_h_link2', 'tenant_a');
end
$$;

-- ===========================================================================
-- A. THE SURFACE.
-- ===========================================================================
do $$
declare
  v_bad text;
  c_roles constant text[] := array['anon', 'authenticated', 'service_role', 'ops_worker'];
  c_capabilities constant regprocedure[] := array[
    'ops.claim_agent_run()',
    'ops.refuse_agent_run(text)',
    'ops.start_agent_run(text, text, text, text)',
    'ops.complete_agent_run(jsonb, text, text, text, text, integer, integer, integer, integer, integer, integer)',
    'ops.fail_agent_run(text, text, text, text, text, integer, integer, integer, integer, integer, integer)',
    'ops.settle_stale_agent_runs()']::regprocedure[];
  c_owner_services constant regprocedure[] := array[
    'ops.request_agent_run(uuid, uuid, uuid, text, text, text, uuid)',
    'ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid)',
    'ops.clear_execution_stop(uuid, text, text)',
    'ops.active_execution_stop(uuid, uuid, uuid, uuid)',
    'ops.request_task_execution(uuid, uuid, text, text, jsonb, text, uuid, uuid)']::regprocedure[];
begin
  -- A1. No application role holds any privilege on either table, table-wide or
  --     on a single column.
  select string_agg(format('%s:%s:%s', r.rolname, t.relname, p.priv), ', ') into v_bad
    from unnest(array['agent_runs', 'execution_stops']) as t (relname)
   cross join unnest(c_roles) as r (rolname)
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where has_table_privilege(r.rolname, format('ops.%I', t.relname), p.priv)
      or case when p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              then has_any_column_privilege(r.rolname, format('ops.%I', t.relname), p.priv)
              else false end;
  if v_bad is not null then
    raise exception 'A1: an agent runtime table is reachable by an application role: %', v_bad;
  end if;

  -- A2. The six capabilities are lease-bound definers: SECURITY DEFINER with an
  --     empty search_path, executable by ops_worker and no other application
  --     role, and with no argument that could name a row.
  select string_agg(format('%s %s', x.fn, x.problem), '; ') into v_bad from (
    select f::text as fn, 'is not SECURITY DEFINER' as problem
      from unnest(c_capabilities) as f join pg_proc p on p.oid = f
     where not p.prosecdef
    union all
    select f::text, 'does not pin an empty search_path'
      from unnest(c_capabilities) as f join pg_proc p on p.oid = f
     where not coalesce(p.proconfig @> array['search_path=""'], false)
    union all
    select f::text, 'is not executable by ops_worker'
      from unnest(c_capabilities) as f
     where not has_function_privilege('ops_worker', f, 'EXECUTE')
    union all
    select f::text, 'is executable by ' || r.rolname
      from unnest(c_capabilities) as f
     cross join unnest(array['anon', 'authenticated', 'service_role']) as r (rolname)
     where has_function_privilege(r.rolname, f, 'EXECUTE')
    union all
    select f::text, 'takes an argument that names a row: ' || a.name
      from unnest(c_capabilities) as f join pg_proc p on p.oid = f
     cross join unnest(coalesce(p.proargnames, '{}'::text[])) as a (name)
     where a.name in ('p_tenant_id', 'p_task_id', 'p_agent_id', 'p_run_id', 'p_job_id', 'p_company_id',
                      'p_department_id', 'p_agent_run_id', 'p_stop_id')
    union all
    select f::text, 'takes a uuid argument'
      from unnest(c_capabilities) as f join pg_proc p on p.oid = f
     where 'uuid'::regtype::oid = any (p.proargtypes::oid[])
  ) as x;
  if v_bad is not null then
    raise exception 'A2: an agent run capability is not a lease-bound definer: %', v_bad;
  end if;

  -- A3. The owner services are SECURITY INVOKER and executable by no application role.
  select string_agg(x.d, '; ') into v_bad from (
    select format('%s is executable by %s', f, r.rolname) as d
      from unnest(c_owner_services) as f cross join unnest(c_roles) as r (rolname)
     where has_function_privilege(r.rolname, f, 'EXECUTE')
    union all
    select format('%s is SECURITY DEFINER', f)
      from unnest(c_owner_services) as f join pg_proc p on p.oid = f
     where p.prosecdef
  ) as x;
  if v_bad is not null then
    raise exception 'A3: an agent runtime owner service is reachable by an application role: %', v_bad;
  end if;

  -- A4. No caller supplies lineage: no correlation or causation argument, on the
  --     one request_agent_run there is.
  select string_agg(format('%s(%s)', p.oid::regprocedure, a.name), ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join unnest(coalesce(p.proargnames, '{}'::text[])) as a (name)
   where n.nspname = 'ops' and p.proname = 'request_agent_run' and a.name ~ '(correlation|causation)';
  if v_bad is not null then
    raise exception 'A4: ops.request_agent_run takes lineage from its caller: %', v_bad;
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname = 'request_agent_run') <> 1 then
    raise exception 'A4: ops.request_agent_run has an overload this suite does not attack';
  end if;

  -- A5. Exactly one task-executable kind.
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'A5: ops.task_executable_kinds() is not exactly {agent_run.execute}';
  end if;

  -- A6. A run's facts come from its state changes only.
  if not ('agent_run' = any (ops.derived_event_namespaces())) then
    raise exception 'A6: agent_run is not a reserved lifecycle namespace, so ops.record_event could forge a run''s facts';
  end if;

  -- A7. The update and removal guards survive replica mode.
  select string_agg(g.name, ', ') into v_bad
    from unnest(array['agent_runs_guard_update', 'execution_stops_guard_update',
                      'execution_stops_guard_delete', 'execution_stops_refuse_truncate']) as g (name)
   where not exists (
     select 1 from pg_trigger tg
       join pg_class c on c.oid = tg.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ops' and tg.tgname = g.name and tg.tgenabled = 'A');
  if v_bad is not null then
    raise exception 'A7: agent runtime guard trigger(s) missing or not ENABLE ALWAYS: %', v_bad;
  end if;

  -- A8. ENABLE + FORCE row level security, and no policy on the stops: a tenant
  --     policy there could only hide the global stops that matter most.
  select string_agg(t.relname, ', ') into v_bad
    from unnest(array['agent_runs', 'execution_stops']) as t (relname)
   where not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ops' and c.relname = t.relname and c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'A8: % lack(s) ENABLE + FORCE row level security', v_bad;
  end if;
  if exists (select 1 from pg_policy p where p.polrelid = 'ops.execution_stops'::regclass) then
    raise exception 'A8: ops.execution_stops carries a row level security policy';
  end if;

  -- A9. The helpers the review added are reached only through the code that calls
  --     them, and the lease helper confers nothing: SECURITY INVOKER, it runs with the
  --     rights of the capability that calls it.
  select string_agg(format('%s:%s', r.rolname, f), ', ') into v_bad
    from unnest(array['ops.agent_run_lease_attempt()', 'ops.execution_stop_lock_key()',
                      'ops.agent_run_reserved_error_codes()', 'ops.guard_execution_stop_delete()',
                      'ops.refuse_execution_stop_truncate()']::regprocedure[]) as f
   cross join unnest(c_roles) as r (rolname)
   where has_function_privilege(r.rolname, f, 'EXECUTE');
  if v_bad is not null then
    raise exception 'A9: a Phase 1D helper is executable by an application role: %', v_bad;
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = 'ops.agent_run_lease_attempt()'::regprocedure) then
    raise exception 'A9: ops.agent_run_lease_attempt() is SECURITY DEFINER';
  end if;
end
$$;

-- ===========================================================================
-- B. A LEASED WORKER IS REFUSED AT THE PRIVILEGE LAYER.
-- ===========================================================================
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_job     ops.jobs;
  v_attempt record;
  v_reached text[] := '{}';
  v_tried   integer := 0;
begin
  perform pg_temp.queue_first(pg_temp.id('job_b'));
  perform pg_temp.as_worker();
  v_job := ops.lease_job('ar1d-worker-b', 60);
  if v_job.id is distinct from pg_temp.id('job_b') then
    raise exception 'B: the lease went to %, not the fixture job; this case would prove nothing', v_job.id;
  end if;
  if ops.current_tenant_id() is distinct from ta then
    raise exception 'B: the lease did not install tenant A';
  end if;

  for v_attempt in
    select * from (values
      ('select ops.agent_runs', 'select count(*) from ops.agent_runs'),
      ('insert ops.agent_runs', format('insert into ops.agent_runs (tenant_id) values (%L)', ta)),
      ('update ops.agent_runs', 'update ops.agent_runs set status = status'),
      ('delete ops.agent_runs', 'delete from ops.agent_runs'),
      ('truncate ops.agent_runs', 'truncate ops.agent_runs'),
      ('select ops.execution_stops', 'select count(*) from ops.execution_stops'),
      ('insert ops.execution_stops',
       $q$insert into ops.execution_stops (scope, reason, tripped_by) values ('global', 'ar1d-test: worker', 'ar1d-worker')$q$),
      ('update ops.execution_stops', $q$update ops.execution_stops set cleared_by = 'ar1d-worker'$q$),
      ('delete ops.execution_stops', 'delete from ops.execution_stops'),
      ('truncate ops.execution_stops', 'truncate ops.execution_stops'),
      ('ops.request_agent_run',
       format($q$select ops.request_agent_run(%L, %L, %L, 'task_assessment', 'ar1d-worker-key', 'ar1d-worker')$q$,
              ta, pg_temp.id('task_c'), pg_temp.id('agent_a1'))),
      ('ops.trip_execution_stop', $q$select ops.trip_execution_stop('global', 'ar1d-test: worker', 'ar1d-worker')$q$),
      ('ops.clear_execution_stop',
       $q$select ops.clear_execution_stop('00000000-0000-4000-8000-000000000000', 'ar1d-test: worker', 'ar1d-worker')$q$),
      ('ops.active_execution_stop',
       format('select ops.active_execution_stop(%L, %L, %L, %L)',
              ta, pg_temp.id('company_a1'), pg_temp.id('dept_a1'), pg_temp.id('agent_a1'))),
      ('ops.request_task_execution',
       format($q$select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-worker', jsonb_build_object('agent_run_id', gen_random_uuid()))$q$,
              ta, pg_temp.id('task_c')))
    ) as a (label, statement)
  loop
    v_tried := v_tried + 1;
    begin
      execute v_attempt.statement;
      raise exception using errcode = 'C1CAC', message = 'accepted';
    exception
      when insufficient_privilege then null;
      when sqlstate 'C1CAC' then v_reached := v_reached || (v_attempt.label || ' (accepted)');
      when others then v_reached := v_reached || format('%s (%s %s)', v_attempt.label, sqlstate, sqlerrm);
    end;
  end loop;

  if cardinality(v_reached) > 0 then
    raise exception 'B: a leased worker reached agent runtime data or services: % of % attempts were not refused with insufficient_privilege: %',
      cardinality(v_reached), v_tried, array_to_string(v_reached, '; ');
  end if;
  if v_tried <> 15 then
    raise exception 'B: % attempts ran, expected 15; a case was lost', v_tried;
  end if;

  if ops.complete_job(v_job.id) is not true then
    raise exception 'B: could not settle the fixture job';
  end if;
  perform pg_temp.as_owner();
end
$$;

-- ===========================================================================
-- N7 (first part). WHO TAKES THE KILL-SWITCH LOCK, AND IN WHICH MODE.
--    Runs here, not with the rest of section N: a transaction-level advisory lock is
--    held until the transaction ends, so once section C's first request takes it no
--    later block could see it being taken. Each case runs in a subtransaction that is
--    rolled back, which releases what that case took. What one connection cannot
--    prove is what the lock BUYS: a trip waiting for a start in flight, and a start
--    or request waiting for a trip. That belongs to the driver-backed suite.
-- ===========================================================================
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_run   uuid;
  v_job   uuid;
  v_stop  uuid;
  v_state text;
  v_modes text[];
begin
  -- N7a. Every party locks one fixed, immutable key.
  if ops.execution_stop_lock_key() is distinct from -1743835370934658107::bigint
     or ops.execution_stop_lock_key() is distinct from hashtextextended('ops.execution_stops', 0)
     or (select p.provolatile from pg_proc p where p.oid = 'ops.execution_stop_lock_key()'::regprocedure) <> 'i' then
    raise exception 'N7a: ops.execution_stop_lock_key() is not the one fixed, immutable key (%)', ops.execution_stop_lock_key();
  end if;

  if pg_temp.stop_lock_modes() <> '{}'::text[] then
    raise exception 'N7: the kill-switch lock is held before any case took it; the cases below would prove nothing';
  end if;

  -- N7b. ops.start_agent_run takes it SHARED. The run is linked by the bridge directly,
  --      so no request took the lock first.
  begin
    v_run := pg_temp.raw_pending_run('task_c');
    v_job := ops.request_task_execution(ta, pg_temp.id('task_c'), 'agent_run.execute', 'ar1d-bridge',
                                        jsonb_build_object('agent_run_id', v_run));
    perform pg_temp.lease('N7b', 'ar1d-worker-lock', v_job);
    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    perform pg_temp.as_owner();
    v_modes := pg_temp.stop_lock_modes();
    if v_modes <> '{}'::text[] then
      raise exception 'N7b: the bridge, lease or claim already took the kill-switch lock (%); this case would prove nothing', v_modes;
    end if;
    perform pg_temp.as_worker();
    v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
    perform pg_temp.as_owner();
    v_modes := pg_temp.stop_lock_modes();
    if v_state is distinct from 'running' then
      raise exception 'N7b: the fixture start returned %; this case would prove nothing', v_state;
    end if;
    if v_modes is distinct from array['ShareLock'] then
      raise exception 'N7b: ops.start_agent_run does not hold the kill-switch lock shared once it has read the stops (held: %); that it takes it BEFORE the read needs two sessions: engine/domain/agentRuns.dbtest.ts', v_modes;
    end if;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if pg_temp.stop_lock_modes() <> '{}'::text[] then
    raise exception 'N7: a rolled-back case left the kill-switch lock held; the next case would prove nothing';
  end if;

  -- N7c. ops.request_agent_run takes it SHARED.
  begin
    perform pg_temp.request('ar1d-n7-request', 'tenant_a', 'task_c', 'agent_a1');
    v_modes := pg_temp.stop_lock_modes();
    if v_modes is distinct from array['ShareLock'] then
      raise exception 'N7c: ops.request_agent_run does not hold the kill-switch lock shared once it has read the stops (held: %); that it takes it BEFORE the read needs two sessions: engine/domain/agentRuns.dbtest.ts', v_modes;
    end if;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if pg_temp.stop_lock_modes() <> '{}'::text[] then
    raise exception 'N7: a rolled-back case left the kill-switch lock held; the next case would prove nothing';
  end if;

  -- N7d. ops.trip_execution_stop takes it EXCLUSIVELY.
  begin
    perform ops.trip_execution_stop('global', 'ar1d-test: lock witness', 'ar1d-owner');
    v_modes := pg_temp.stop_lock_modes();
    if v_modes is distinct from array['ExclusiveLock'] then
      raise exception 'N7d: ops.trip_execution_stop did not take the kill-switch lock exclusively (held: %)', v_modes;
    end if;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if pg_temp.stop_lock_modes() <> '{}'::text[] then
    raise exception 'N7: a rolled-back case left the kill-switch lock held; the next case would prove nothing';
  end if;

  -- N7e. ops.clear_execution_stop takes it EXCLUSIVELY. The stop is inserted raw, so no
  --      trip took the lock first.
  begin
    insert into ops.execution_stops (scope, reason, tripped_by)
    values ('global', 'ar1d-test: lock witness', 'ar1d-owner')
    returning id into v_stop;
    v_modes := pg_temp.stop_lock_modes();
    if v_modes <> '{}'::text[] then
      raise exception 'N7e: inserting a stop took the kill-switch lock (%); this case would prove nothing', v_modes;
    end if;
    perform ops.clear_execution_stop(v_stop, 'ar1d-test: lock witness cleared', 'ar1d-owner');
    v_modes := pg_temp.stop_lock_modes();
    if v_modes is distinct from array['ExclusiveLock'] then
      raise exception 'N7e: ops.clear_execution_stop did not take the kill-switch lock exclusively (held: %)', v_modes;
    end if;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if pg_temp.stop_lock_modes() <> '{}'::text[] then
    raise exception 'N7: a rolled-back case left the kill-switch lock held after the last case';
  end if;
end
$$;

-- ===========================================================================
-- C. THE CAPABILITIES ARE LEASE-BOUND, AND A PAYLOAD IS NEVER READ.
--    ops.settle_stale_agent_runs() is not attacked here: it takes no lease by
--    design (migration section 7) and section M proves what it can touch.
-- ===========================================================================
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_runs uuid[];
begin
  perform pg_temp.remember('run_c_a', pg_temp.request('ar1d-c-a', 'tenant_a', 'task_c', 'agent_a1'));
  perform pg_temp.remember('run_c_a_other', pg_temp.request('ar1d-c-a-other', 'tenant_a', 'task_c', 'agent_a1'));
  perform pg_temp.remember('run_c_expired', pg_temp.request('ar1d-c-expired', 'tenant_a', 'task_c', 'agent_a1'));
  perform pg_temp.remember('run_c_b', pg_temp.request('ar1d-c-b', 'tenant_b', 'task_b', 'agent_b'));
  v_runs := array[pg_temp.id('run_c_a'), pg_temp.id('run_c_a_other'), pg_temp.id('run_c_expired'), pg_temp.id('run_c_b')];
  if exists (select 1 from ops.agent_runs r where r.id = any (v_runs) and (r.status <> 'pending' or r.job_id is null)) then
    raise exception 'C: a fixture run is not pending with its job; the cases below would prove nothing';
  end if;
  perform pg_temp.remember('job_c_a', pg_temp.job_of(pg_temp.id('run_c_a')));
  perform pg_temp.remember('job_c_expired', pg_temp.job_of(pg_temp.id('run_c_expired')));
  perform pg_temp.remember('job_c_b', pg_temp.job_of(pg_temp.id('run_c_b')));
  -- Jobs of the agent run kind, enqueued outside the bridge (as service_role
  -- could), whose payloads name runs: tenant B's, and another of tenant A's.
  perform pg_temp.remember('job_c_forged_b',
    ops.enqueue_job(ta, 'agent_run.execute', jsonb_build_object('agent_run_id', pg_temp.id('run_c_b')), 100, now(), 5, null));
  perform pg_temp.remember('job_c_forged_a',
    ops.enqueue_job(ta, 'agent_run.execute', jsonb_build_object('agent_run_id', pg_temp.id('run_c_a_other')), 100, now(), 5, null));
  perform pg_temp.snapshot('c', v_runs);
end
$$;

-- C1. No lease.
do $$
begin
  perform pg_temp.as_worker();
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  perform pg_temp.expect_capabilities_refused('C1 no lease', 'no live lease');
  perform pg_temp.as_owner();
end
$$;

-- C2. A live lease on a job that carries no run.
do $$
begin
  perform pg_temp.lease('C2', 'ar1d-worker-c', pg_temp.id('job_c_none'));
  perform pg_temp.as_worker();
  perform pg_temp.expect_capabilities_refused('C2 a lease on a job that carries no agent run', 'no agent run is bound');
  perform pg_temp.as_owner();
end
$$;

-- C3. A forged app.job_id naming tenant B's agent run job, under this worker's
--     own id. The job is really leased (by another worker), and this worker's own
--     lease is live, so the only thing refusing is the lease check itself.
do $$
begin
  perform pg_temp.lease('C3', 'ar1d-worker-beta', pg_temp.id('job_c_b'));
  perform pg_temp.as_worker();
  if ops.current_tenant_id() is distinct from pg_temp.id('tenant_b') then
    raise exception 'C3: tenant B''s agent run job is not live-leased; the forged case would prove nothing';
  end if;
  perform set_config('app.worker_id', 'ar1d-worker-c', true);
  perform set_config('app.job_id', pg_temp.id('job_c_none')::text, true);
  if ops.current_tenant_id() is distinct from pg_temp.id('tenant_a') then
    raise exception 'C3: this worker''s own lease is not live; the forged case would prove nothing';
  end if;
  perform set_config('app.job_id', pg_temp.id('job_c_b')::text, true);
  perform pg_temp.expect_capabilities_refused('C3 a forged app.job_id naming tenant B''s agent run job', 'no live lease');
  perform pg_temp.as_owner();
end
$$;

-- C4. Another worker's live lease on tenant A's agent run job.
do $$
begin
  perform pg_temp.lease('C4', 'ar1d-worker-a', pg_temp.id('job_c_a'));
  perform pg_temp.as_worker();
  perform set_config('app.worker_id', 'ar1d-forger', true);
  perform pg_temp.expect_capabilities_refused('C4 another worker''s lease on tenant A''s agent run job', 'no live lease');
  perform pg_temp.as_owner();
end
$$;

-- C5. An expired lease. The owner moves the expiry into the past, as
--     company_domain_core.sql C7, so even ops.current_tenant_id(), which judges expiry
--     by now(), the transaction start, finds no lease. A lease that ends on the wall
--     clock DURING the transaction, which only the capabilities' own check sees, is N1.
do $$
begin
  perform pg_temp.lease('C5', 'ar1d-worker-e', pg_temp.id('job_c_expired'));
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = pg_temp.id('job_c_expired');
  perform pg_temp.as_worker();
  perform set_config('app.worker_id', 'ar1d-worker-e', true);
  perform set_config('app.job_id', pg_temp.id('job_c_expired')::text, true);
  perform pg_temp.expect_capabilities_refused('C5 an expired lease on tenant A''s agent run job', 'no live lease');
  perform pg_temp.as_owner();
end
$$;

-- C6. A live lease on tenant A's agent run job claims exactly that run.
do $$
declare
  v_claim   jsonb;
  v_changed text;
begin
  perform pg_temp.as_worker();
  if (ops.resume_lease('ar1d-worker-a', pg_temp.id('job_c_a'))).id is null then
    raise exception 'C6: the tenant A lease could not be resumed; this case would prove nothing';
  end if;
  v_claim := ops.claim_agent_run();
  perform pg_temp.as_owner();
  if v_claim ->> 'action' is distinct from 'start'
     or v_claim ->> 'agent_run_id' is distinct from pg_temp.id('run_c_a')::text then
    raise exception 'C6: a live lease on tenant A''s agent run job did not claim exactly its own run: %', v_claim;
  end if;
  v_changed := pg_temp.changed_since('c');
  if v_changed is not null then
    raise exception 'C6: claiming one run changed runs: %', v_changed;
  end if;
end
$$;

-- C7. Payload is never read: a leased agent run job whose payload names a run
--     binds nothing, whether the named run is tenant B's or tenant A's own.
do $$
declare
  v_changed text;
begin
  perform pg_temp.lease('C7', 'ar1d-worker-p', pg_temp.id('job_c_forged_b'));
  perform pg_temp.as_worker();
  perform pg_temp.expect_capabilities_refused('C7 a leased job whose payload names tenant B''s run', 'no agent run is bound');
  perform pg_temp.as_owner();

  perform pg_temp.lease('C7', 'ar1d-worker-p', pg_temp.id('job_c_forged_a'));
  perform pg_temp.as_worker();
  perform pg_temp.expect_capabilities_refused('C7 a leased job whose payload names tenant A''s other pending run', 'no agent run is bound');
  perform pg_temp.as_owner();

  v_changed := pg_temp.changed_since('c');
  if v_changed is not null then
    raise exception 'C7: a job payload chose the agent run a lease reached: %', v_changed;
  end if;
end
$$;

-- ===========================================================================
-- D. STRUCTURE, AS THE OWNER, WITH RAW DML.
--    Provenance is declared so that only the structure refuses. Where a guard
--    stands in front of a key, the key is proven again with the guard off.
-- ===========================================================================
select set_config('app.event_source', 'ar1d-raw', true);

select pg_temp.expect_refused('D1 a tenant-A run on a tenant-B task', '23503',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_b', 'agent_a1'));
select pg_temp.expect_refused('D1 a tenant-A run in a tenant-B company', '23503',
  pg_temp.raw_run_sql('tenant_a', 'company_b', 'dept_b', 'task_b', 'agent_b'));

select pg_temp.expect_refused('D2 a run whose agent is another company''s', '23503',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a2', 'task_c', 'agent_a2'));
select pg_temp.expect_refused('D2 a run whose agent is another company''s, under this company''s department', '23503',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_c', 'agent_a2'));
select pg_temp.expect_refused('D2 a run whose agent is another tenant''s', '23503',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_b', 'task_c', 'agent_b'));

select pg_temp.expect_refused('D3 a run whose department is not the agent''s', '23503',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1_support', 'task_c', 'agent_a1'));

-- D4. The job link is a (tenant, job) key.
select pg_temp.remember('run_d_pending', pg_temp.raw_pending_run('task_h'));
select pg_temp.expect_refused('D4 linking a tenant-A run to a tenant-B job (guard on)', '23503', format($q$
  update ops.agent_runs set job_id = %L where id = %L
$q$, pg_temp.id('job_d_b'), pg_temp.id('run_d_pending')));
select pg_temp.expect_refused_without_trigger('D4 linking a tenant-A run to a tenant-B job (guard off)', '23503',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set job_id = %L where id = %L
$q$, pg_temp.id('job_d_b'), pg_temp.id('run_d_pending')));
select pg_temp.raw_update(pg_temp.id('run_d_pending'), format('job_id = %L', pg_temp.id('job_d_a')));
select pg_temp.remember('run_d_pending_two', pg_temp.raw_pending_run('task_h'));
select pg_temp.expect_refused('D4 two runs carried by one job', '23505', format($q$
  update ops.agent_runs set job_id = %L where id = %L
$q$, pg_temp.id('job_d_a'), pg_temp.id('run_d_pending_two')));

-- D5. A retry repeats a finished run of the SAME task, which must already exist.
select pg_temp.remember('run_d_other_task', pg_temp.raw_run_in('failed', 'task_h_other'));
select pg_temp.expect_refused('D5 a retry of another task''s run (guard)', 'OS404',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
                      ', retry_of_run_id', format(', %L', pg_temp.id('run_d_other_task'))));
select pg_temp.expect_refused_without_trigger('D5 a retry of another task''s run (foreign key)', '23503',
  'agent_runs', 'agent_runs_guard_insert',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
                      ', retry_of_run_id', format(', %L', pg_temp.id('run_d_other_task'))));
select pg_temp.expect_refused('D5 a retry of an unfinished run', 'OS409',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
                      ', retry_of_run_id', format(', %L', pg_temp.id('run_d_pending_two'))));
-- A foreign key is checked at the END of the statement, so without the insert
-- guard one multi-row INSERT could store a lineage whose parents never existed first.
select pg_temp.expect_refused('D5 a retry cycle in one multi-row INSERT', 'OS404', format($q$
  insert into ops.agent_runs (id, tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                              idempotency_key, request_fingerprint, correlation_id, requested_by, retry_of_run_id)
  values
    ('a1d00000-0000-4000-8000-000000000001', %1$L, %2$L, %3$L, %4$L, %5$L, 'task_assessment', 'standard',
     'ar1d-d5-one', repeat('a', 64), gen_random_uuid(), 'ar1d-raw', 'a1d00000-0000-4000-8000-000000000002'),
    ('a1d00000-0000-4000-8000-000000000002', %1$L, %2$L, %3$L, %4$L, %5$L, 'task_assessment', 'standard',
     'ar1d-d5-two', repeat('a', 64), gen_random_uuid(), 'ar1d-raw', 'a1d00000-0000-4000-8000-000000000001')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1'), pg_temp.id('task_h'), pg_temp.id('agent_a1')));

-- D6. A run is born pending, with no job and no execution fact.
select pg_temp.expect_refused('D6 a run born running', 'OS409',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
    ', status, provider, model, prompt_version, input_fingerprint, job_attempt, started_at',
    $v$, 'running', 'fake', 'fake-model-1', 'task_assessment.v1', repeat('c', 64), 1, now()$v$));
select pg_temp.expect_refused('D6 a run born with a job', 'OS409',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
    ', job_id', format(', %L', pg_temp.id('job_d_a2'))));
select pg_temp.expect_refused('D6 a run born with a result', 'OS409',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
    ', result', format(', %L', pg_temp.valid_result())));
select pg_temp.expect_refused('D6 a run born finished', 'OS409',
  pg_temp.raw_run_sql('tenant_a', 'company_a1', 'dept_a1', 'task_h', 'agent_a1',
    ', status, error_category, error_code, completed_at', $v$, 'failed', 'configuration', 'ar1d_born', now()$v$));

-- D7. Status coherence is structural: with the update guard off, the table's own
--     CHECKs refuse a run whose facts disagree with its status.
select pg_temp.remember('stop_d', ops.trip_execution_stop('tenant', 'ar1d-test: D fixture', 'ar1d-owner', pg_temp.id('tenant_a')));
select ops.clear_execution_stop(pg_temp.id('stop_d'), 'ar1d-test: D fixture cleared', 'ar1d-owner');
select pg_temp.remember('run_d_checks', pg_temp.raw_pending_run('task_h'));
select pg_temp.expect_refused_without_trigger('D7 a failed run with an indeterminate category', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'failed', error_category = 'timeout', completed_at = now() where id = %L
$q$, pg_temp.id('run_d_checks')));
select pg_temp.expect_refused_without_trigger('D7 a cancelled run with a failure category', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'cancelled', error_category = 'configuration', completed_at = now() where id = %L
$q$, pg_temp.id('run_d_checks')));
select pg_temp.expect_refused_without_trigger('D7 a result on a failed run', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'failed', error_category = 'configuration', completed_at = now(), result = %L where id = %L
$q$, pg_temp.valid_result(), pg_temp.id('run_d_checks')));
select pg_temp.expect_refused_without_trigger('D7 a stop recorded without execution_stopped', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'cancelled', error_category = 'refused', error_code = 'task_closed',
         stop_id = %L, completed_at = now() where id = %L
$q$, pg_temp.id('stop_d'), pg_temp.id('run_d_checks')));
select pg_temp.expect_refused_without_trigger('D7 execution_stopped without its stop', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped',
         completed_at = now() where id = %L
$q$, pg_temp.id('run_d_checks')));
select pg_temp.expect_refused_without_trigger('D7 a finished run with no completion time', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'failed', error_category = 'configuration' where id = %L
$q$, pg_temp.id('run_d_checks')));
select pg_temp.expect_refused_without_trigger('D7 a running run without what it started', '23514',
  'agent_runs', 'agent_runs_guard_update', format($q$
  update ops.agent_runs set status = 'running', started_at = now(), job_attempt = 1 where id = %L
$q$, pg_temp.id('run_d_checks')));

-- D8. A stop's target lives in its tenant and company.
select pg_temp.expect_refused('D8 a stop for another tenant''s company', '23503', format($q$
  insert into ops.execution_stops (scope, tenant_id, company_id, reason, tripped_by)
  values ('company', %L, %L, 'ar1d-test: cross', 'ar1d-owner')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));
select pg_temp.expect_refused('D8 a stop for another company''s department', '23503', format($q$
  insert into ops.execution_stops (scope, tenant_id, company_id, department_id, reason, tripped_by)
  values ('department', %L, %L, %L, 'ar1d-test: cross', 'ar1d-owner')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a2')));
select pg_temp.expect_refused('D8 a stop for another company''s agent', '23503', format($q$
  insert into ops.execution_stops (scope, tenant_id, company_id, agent_id, reason, tripped_by)
  values ('agent', %L, %L, %L, 'ar1d-test: cross', 'ar1d-owner')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('agent_a2')));
select pg_temp.expect_refused('D8 a stop for an unknown tenant', '23503', $q$
  insert into ops.execution_stops (scope, tenant_id, reason, tripped_by)
  values ('tenant', '00000000-0000-4000-8000-000000000000', 'ar1d-test: cross', 'ar1d-owner')
$q$);

-- D9. Malformed stops.
select pg_temp.expect_refused('D9 a global stop naming a tenant', '23514', format($q$
  insert into ops.execution_stops (scope, tenant_id, reason, tripped_by) values ('global', %L, 'ar1d-test: shape', 'ar1d-owner')
$q$, pg_temp.id('tenant_a')));
select pg_temp.expect_refused('D9 a tenant stop without its tenant', '23514', $q$
  insert into ops.execution_stops (scope, reason, tripped_by) values ('tenant', 'ar1d-test: shape', 'ar1d-owner')
$q$);
select pg_temp.expect_refused('D9 a company stop without its company', '23514', format($q$
  insert into ops.execution_stops (scope, tenant_id, reason, tripped_by) values ('company', %L, 'ar1d-test: shape', 'ar1d-owner')
$q$, pg_temp.id('tenant_a')));
select pg_temp.expect_refused('D9 a department stop without its department', '23514', format($q$
  insert into ops.execution_stops (scope, tenant_id, company_id, reason, tripped_by) values ('department', %L, %L, 'ar1d-test: shape', 'ar1d-owner')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('D9 a department stop naming an agent', '23514', format($q$
  insert into ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id, reason, tripped_by)
  values ('department', %L, %L, %L, %L, 'ar1d-test: shape', 'ar1d-owner')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1'), pg_temp.id('agent_a1')));
select pg_temp.expect_refused('D9 an agent stop naming a department', '23514', format($q$
  insert into ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id, reason, tripped_by)
  values ('agent', %L, %L, %L, %L, 'ar1d-test: shape', 'ar1d-owner')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1'), pg_temp.id('agent_a1')));
select pg_temp.expect_refused('D9 an unknown scope', '23514', $q$
  insert into ops.execution_stops (scope, reason, tripped_by) values ('planet', 'ar1d-test: shape', 'ar1d-owner')
$q$);
select pg_temp.expect_refused('D9 a blank reason', '23514', $q$
  insert into ops.execution_stops (scope, reason, tripped_by) values ('global', '   ', 'ar1d-owner')
$q$);
select pg_temp.expect_refused('D9 a 501-character reason', '23514', $q$
  insert into ops.execution_stops (scope, reason, tripped_by) values ('global', 'ar1d-test' || repeat('r', 492), 'ar1d-owner')
$q$);
select pg_temp.expect_refused('D9 a malformed actor', '23514', $q$
  insert into ops.execution_stops (scope, reason, tripped_by) values ('global', 'ar1d-test: shape', 'The Owner')
$q$);

-- D10. A stop is born active.
select pg_temp.expect_refused('D10 a stop born cleared', 'OS409', $q$
  insert into ops.execution_stops (scope, reason, tripped_by, cleared_by, cleared_reason, cleared_at)
  values ('global', 'ar1d-test: born cleared', 'ar1d-owner', 'ar1d-owner', 'ar1d-test: already', now())
$q$);

-- D11. A stop cannot be backdated: the database's clock, not the caller's.
do $$
declare
  v_tripped timestamptz;
begin
  begin
    insert into ops.execution_stops (scope, reason, tripped_by, tripped_at)
    values ('global', 'ar1d-test: backdated', 'ar1d-owner', now() - interval '1 year')
    returning tripped_at into v_tripped;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_tripped is distinct from now() then
    raise exception 'D11: a stop was recorded as tripped at %, not by the database clock', v_tripped;
  end if;
end
$$;

select set_config('app.event_source', '', true);

-- ===========================================================================
-- E. REQUEST SCOPE AND GATES.
--    Valid tenant-A authority does not make another tenant's or company's id
--    trusted, scope is resolved before state, and a refusal writes nothing.
-- ===========================================================================
select set_config('ar1d.footprint_e', pg_temp.runtime_footprint(), true);

select pg_temp.expect_refused('E1 tenant A naming tenant B''s task', 'OS404',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_b'), pg_temp.id('agent_b'), 'ar1d-e1-task'));
select pg_temp.expect_refused('E1 tenant A naming tenant B''s agent', 'OS404',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_b'), 'ar1d-e1-agent'));
select pg_temp.expect_refused('E1 tenant A naming company A2''s agent for a company-A1 task', 'OS404',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a2'), 'ar1d-e1-company'));
select pg_temp.expect_refused('E1 an unknown task', 'OS404',
  pg_temp.request_sql(pg_temp.id('tenant_a'), '00000000-0000-4000-8000-000000000000', pg_temp.id('agent_a1'), 'ar1d-e1-unknown'));

-- E2. Scope before state: tenant B's closed task, and tenant B's task with a
--     capability that does not exist, read as "not found" through tenant A.
select pg_temp.expect_refused('E2 tenant B''s closed task through tenant A', 'OS404',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_b_closed'), pg_temp.id('agent_b'), 'ar1d-e2-closed'));
select pg_temp.expect_refused('E2 tenant B''s task with an unknown capability through tenant A', 'OS404',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_b'), pg_temp.id('agent_b'), 'ar1d-e2-capability', 'task_writing'));

-- E3. An agent runs only for its own work.
select pg_temp.expect_refused('E3 an agent the task is not assigned to', 'OS409',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1_two'), 'ar1d-e3-other'));
select pg_temp.expect_refused('E3 an unassigned task', 'OS409',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_e_unassigned'), pg_temp.id('agent_a1'), 'ar1d-e3-unassigned'));

-- E4. Closed or inactive.
select pg_temp.expect_refused('E4 a closed task', 'OS409',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_e_closed'), pg_temp.id('agent_a1'), 'ar1d-e4-closed'));
select pg_temp.expect_refused('E4 an inactive agent', 'OS409',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_e_idle'), pg_temp.id('agent_a1_idle'), 'ar1d-e4-agent'));
do $$
begin
  perform ops.set_company_status(pg_temp.id('tenant_a'), pg_temp.id('company_a2'), 'inactive', 'ar1d-test');
  perform pg_temp.expect_refused('E4 an inactive company', 'OS409',
    pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_e_company'), pg_temp.id('agent_a2'), 'ar1d-e4-company'));
  perform ops.set_company_status(pg_temp.id('tenant_a'), pg_temp.id('company_a2'), 'active', 'ar1d-test');

  perform ops.set_department_status(pg_temp.id('tenant_a'), pg_temp.id('dept_a1_support'), 'inactive', 'ar1d-test');
  perform pg_temp.expect_refused('E4 an inactive department', 'OS409',
    pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_e_department'), pg_temp.id('agent_a1_support'), 'ar1d-e4-department'));
  perform ops.set_department_status(pg_temp.id('tenant_a'), pg_temp.id('dept_a1_support'), 'active', 'ar1d-test');
end
$$;

-- E5. Only a declared capability.
select pg_temp.expect_refused('E5 an unknown capability', 'OS403',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e5-unknown', 'task_writing'));
select pg_temp.expect_refused('E5 a capability spelled differently', 'OS403',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e5-case', 'Task_Assessment'));
select pg_temp.expect_refused('E5 no capability', 'OS403',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e5-null', null));

-- E6. No tenant scope.
select pg_temp.expect_refused('E6 no tenant scope', 'OS401',
  pg_temp.request_sql(null, pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e6'));

-- E7. Malformed key and source.
select pg_temp.expect_refused('E7 no idempotency key', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), null));
select pg_temp.expect_refused('E7 an empty idempotency key', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), ''));
select pg_temp.expect_refused('E7 an idempotency key with a space', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d e7'));
select pg_temp.expect_refused('E7 a 201-character idempotency key', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), repeat('k', 201)));
select pg_temp.expect_refused('E7 a non-ASCII idempotency key', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e7-' || chr(233)));
select pg_temp.expect_refused('E7 no source', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e7-source-null', 'task_assessment', null));
select pg_temp.expect_refused('E7 a malformed source', 'OS400',
  pg_temp.request_sql(pg_temp.id('tenant_a'), pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-e7-source', 'task_assessment', 'AR1D Attack'));

-- E8. After all of that, nothing was written.
do $$
begin
  if pg_temp.runtime_footprint() is distinct from current_setting('ar1d.footprint_e') then
    raise exception 'E8: a refused agent run request wrote something: before (%), after (%)',
      current_setting('ar1d.footprint_e'), pg_temp.runtime_footprint();
  end if;
end
$$;

-- ===========================================================================
-- F. IDEMPOTENCY. A key is caller-chosen, tenant-scoped DATA naming one request.
-- ===========================================================================
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_run   uuid;
  v_again uuid;
  v_job   uuid;
  v_n     bigint;
begin
  -- F1. The same request, three times.
  v_run := pg_temp.request('ar1d-f-key', 'tenant_a', 'task_f', 'agent_a1');
  v_again := pg_temp.request('ar1d-f-key', 'tenant_a', 'task_f', 'agent_a1');
  if v_again is distinct from v_run then
    raise exception 'F1: replaying the same request returned another run (%, %)', v_run, v_again;
  end if;
  v_again := pg_temp.request('ar1d-f-key', 'tenant_a', 'task_f', 'agent_a1');
  if v_again is distinct from v_run then
    raise exception 'F1: replaying the same request returned another run (%, %)', v_run, v_again;
  end if;
  perform pg_temp.remember('run_f', v_run);

  select count(*) into v_n from ops.agent_runs r where r.tenant_id = ta and r.task_id = pg_temp.id('task_f');
  if v_n <> 1 then
    raise exception 'F1: the same request made % runs for its task, expected one', v_n;
  end if;
  select count(*) into v_n from ops.events e
   where e.subject_type = 'agent_run' and e.subject_id = v_run and e.type = 'agent_run.requested';
  if v_n <> 1 then
    raise exception 'F1: the same request recorded % agent_run.requested facts, expected one', v_n;
  end if;
  v_job := pg_temp.job_of(v_run);
  select count(*) into v_n from ops.jobs j
   where j.tenant_id = ta and j.kind = 'agent_run.execute' and j.payload ->> 'agent_run_id' = v_run::text;
  if v_n <> 1 or v_job is null then
    raise exception 'F1: the same request created % jobs (run linked to %), expected one', v_n, v_job;
  end if;
  select count(*) into v_n from ops.task_jobs l where l.tenant_id = ta and l.task_id = pg_temp.id('task_f');
  if v_n <> 1 or not exists (select 1 from ops.task_jobs l where l.tenant_id = ta and l.job_id = v_job) then
    raise exception 'F1: the same request linked % jobs to its task, expected exactly its own', v_n;
  end if;
  select count(*) into v_n from ops.events e
   where e.subject_type = 'task' and e.subject_id = pg_temp.id('task_f') and e.type = 'task.execution_requested';
  if v_n <> 1 then
    raise exception 'F1: the same request recorded % task.execution_requested facts, expected one', v_n;
  end if;

  -- F2. The same key for a different agent, after a legitimate reassignment.
  perform ops.assign_task(ta, pg_temp.id('task_f'), pg_temp.id('agent_a1_two'), 'ar1d-test');
  perform pg_temp.expect_refused('F2 the same key for a different agent', 'OS409',
    pg_temp.request_sql(ta, pg_temp.id('task_f'), pg_temp.id('agent_a1_two'), 'ar1d-f-key'));
  perform ops.assign_task(ta, pg_temp.id('task_f'), pg_temp.id('agent_a1'), 'ar1d-test');

  -- F3. The same key for another task.
  perform pg_temp.expect_refused('F3 the same key for another task', 'OS409',
    pg_temp.request_sql(ta, pg_temp.id('task_c'), pg_temp.id('agent_a1'), 'ar1d-f-key'));

  -- F4. The same key in tenant B is an independent request.
  v_again := ops.request_agent_run(pg_temp.id('tenant_b'), pg_temp.id('task_f_b'), pg_temp.id('agent_b'),
                                   'task_assessment', 'ar1d-f-key', 'ar1d-test');
  if v_again = v_run then
    raise exception 'F4: the same key in tenant B returned tenant A''s run';
  end if;
  if not exists (select 1 from ops.agent_runs r
                  where r.id = v_again and r.tenant_id = pg_temp.id('tenant_b') and r.status = 'pending'
                    and r.job_id is not null and r.job_id <> v_job
                    and r.correlation_id <> (select x.correlation_id from ops.agent_runs x where x.id = v_run)) then
    raise exception 'F4: tenant B''s request with the same key is not an independent pending run with its own job and lineage';
  end if;
end
$$;

-- F3 again, and F5, once the run has finished.
select pg_temp.raw_update(pg_temp.id('run_f'), $s$status = 'failed', error_category = 'configuration', error_code = 'ar1d_finished'$s$);
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_before text;
  v_again  uuid;
begin
  -- F3. Reusing a finished run's key for its own retry names a different request.
  perform pg_temp.expect_refused('F3 the same key for a retry of its own run', 'OS409',
    pg_temp.request_sql(ta, pg_temp.id('task_f'), pg_temp.id('agent_a1'), 'ar1d-f-key', 'task_assessment',
                        'ar1d-test', pg_temp.id('run_f')));

  -- F5. Replaying the original request returns the finished run and writes nothing.
  v_before := pg_temp.runtime_footprint();
  v_again := pg_temp.request('ar1d-f-key', 'tenant_a', 'task_f', 'agent_a1');
  if v_again is distinct from pg_temp.id('run_f') then
    raise exception 'F5: replaying a finished run''s key returned % instead of the finished run', v_again;
  end if;
  if pg_temp.runtime_footprint() is distinct from v_before then
    raise exception 'F5: replaying a finished run''s key wrote something: before (%), after (%)', v_before, pg_temp.runtime_footprint();
  end if;
  if pg_temp.run_status(v_again) <> 'failed' then
    raise exception 'F5: replaying a finished run''s key changed it to %', pg_temp.run_status(v_again);
  end if;
end
$$;

-- ===========================================================================
-- G. LINEAGE. Correlation is generated or inherited in the database; causation
--    is derived from the run's own facts; no caller setting reaches either.
-- ===========================================================================
do $$
declare
  v_state text;
begin
  perform pg_temp.remember('run_g', pg_temp.leased_run('ar1d-g-key', 'task_g', 'agent_a1'));
  v_state := pg_temp.worker_succeeds();
  if v_state is distinct from 'succeeded' then
    raise exception 'G: the lineage fixture ended %, not succeeded; the cases below would prove nothing', v_state;
  end if;
end
$$;

do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  r         ops.agent_runs;
  v_retry   ops.agent_runs;
  v_other   ops.agent_runs;
  v_requested ops.events;
  v_started   ops.events;
  v_done      ops.events;
  v_exec      ops.events;
  v_retry_requested ops.events;
  v_retry_exec      ops.events;
  v_guc_correlation uuid := gen_random_uuid();
  v_guc_cause uuid;
  v_n bigint;
begin
  select * into r from ops.agent_runs where id = pg_temp.id('run_g');

  -- G1. Every fact of the run, and the task fact its request caused, carry its correlation.
  if r.correlation_id is null then
    raise exception 'G1: an agent run has no correlation';
  end if;
  select count(*) into v_n from ops.events e
   where e.subject_type = 'agent_run' and e.subject_id = r.id and e.type like 'agent\_run.%'
     and e.correlation_id is distinct from r.correlation_id;
  if v_n > 0 then
    raise exception 'G1: % agent_run fact(s) do not carry their run''s correlation', v_n;
  end if;
  select * into v_exec from ops.events e
   where e.type = 'task.execution_requested' and e.subject_id = r.task_id and e.payload ->> 'job_id' = r.job_id::text;
  if not found or v_exec.correlation_id is distinct from r.correlation_id then
    raise exception 'G1: the run''s task.execution_requested fact does not carry its correlation';
  end if;

  select * into v_requested from ops.events e where e.subject_id = r.id and e.type = 'agent_run.requested';
  select * into v_started from ops.events e where e.subject_id = r.id and e.type = 'agent_run.started';
  select * into v_done from ops.events e where e.subject_id = r.id and e.type = 'agent_run.succeeded';

  -- G2.
  if v_exec.causation_id is distinct from v_requested.id then
    raise exception 'G2: task.execution_requested is not caused by the run''s agent_run.requested fact';
  end if;

  -- G3.
  if v_requested.causation_id is not null then
    raise exception 'G3: a first request''s agent_run.requested fact claims a cause';
  end if;
  if v_started.causation_id is distinct from v_requested.id then
    raise exception 'G3: agent_run.started is not caused by agent_run.requested';
  end if;
  if v_done.causation_id is distinct from v_started.id then
    raise exception 'G3: the terminal fact is not caused by agent_run.started';
  end if;

  -- G4. A retry inherits the correlation and is caused by the parent's last fact.
  -- The request runs in its own statement: a query that called it in its WHERE clause
  -- would scan with a snapshot taken before the run existed.
  v_retry.id := pg_temp.request('ar1d-g-retry', 'tenant_a', 'task_g', 'agent_a1', r.id);
  select * into v_retry from ops.agent_runs where id = v_retry.id;
  if v_retry.correlation_id is distinct from r.correlation_id then
    raise exception 'G4: a retry did not inherit its parent''s correlation';
  end if;
  select * into v_retry_requested from ops.events e where e.subject_id = v_retry.id and e.type = 'agent_run.requested';
  if v_retry_requested.causation_id is distinct from v_done.id then
    raise exception 'G4: a retry''s agent_run.requested fact is not caused by its parent''s last fact';
  end if;
  select * into v_retry_exec from ops.events e
   where e.type = 'task.execution_requested' and e.payload ->> 'job_id' = v_retry.job_id::text;
  if v_retry_exec.correlation_id is distinct from r.correlation_id or v_retry_exec.causation_id is distinct from v_retry_requested.id then
    raise exception 'G4: a retry''s task.execution_requested fact does not carry its lineage';
  end if;

  -- G5. A caller's transaction settings do not reach a run's lineage. The cause is
  --     a real event of this company, so a leak would be stored, not refused.
  select e.id into v_guc_cause from ops.events e where e.tenant_id = ta and e.company_id = ca1 order by e.seq limit 1;
  perform set_config('app.event_correlation_id', v_guc_correlation::text, true);
  perform set_config('app.event_causation_id', v_guc_cause::text, true);
  v_other.id := pg_temp.request('ar1d-g-settings', 'tenant_a', 'task_g', 'agent_a1');
  select * into v_other from ops.agent_runs where id = v_other.id;
  perform set_config('app.event_correlation_id', '', true);
  perform set_config('app.event_causation_id', '', true);
  if v_other.correlation_id = v_guc_correlation
     or exists (select 1 from ops.events e
                 where (e.subject_id = v_other.id or e.payload ->> 'job_id' = v_other.job_id::text)
                   and (e.correlation_id = v_guc_correlation or e.causation_id = v_guc_cause)) then
    raise exception 'G5: a caller''s transaction setting chose an agent run''s lineage';
  end if;

  -- G6. Correlations are generated per request.
  if v_other.correlation_id = r.correlation_id then
    raise exception 'G6: two independent requests share a correlation';
  end if;
end
$$;

-- ===========================================================================
-- H. THE AGENT RUN STATE MACHINE.
-- ===========================================================================

-- H1. Every ordered pair of distinct statuses, attempted with a RAW UPDATE as the
--     owner on a run in the from-state. Each attempt supplies the facts the target
--     state's CHECKs need, so the guard alone decides. The oracle is the LITERAL
--     list of the six declared edges, never the database's helper (see
--     company_domain_core.sql F1, mutation M03).
do $$
declare
  c_edges    constant text[] := array[
    'pending>running', 'pending>cancelled', 'pending>failed',
    'running>succeeded', 'running>failed', 'running>indeterminate'];
  c_statuses constant text[] := array['pending', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled'];
  v_from     text;
  v_to       text;
  v_run      uuid;
  v_facts    text;
  v_allowed  boolean;
  v_accepted boolean;
  v_state    text;
  v_message  text;
  v_edges    integer := 0;
  v_refused  integer := 0;
begin
  foreach v_from in array c_statuses loop
    foreach v_to in array c_statuses loop
      continue when v_from = v_to;
      v_run := pg_temp.raw_run_in(v_from);

      v_facts := format('status = %L', v_to)
        || case when v_to in ('running', 'succeeded') then
             ', provider = coalesce(provider, ''fake''), model = coalesce(model, ''fake-model-1''), '
             || 'prompt_version = coalesce(prompt_version, ''task_assessment.v1''), '
             || 'input_fingerprint = coalesce(input_fingerprint, repeat(''c'', 64)), job_attempt = coalesce(job_attempt, 1)'
           else '' end
        || case v_to
             when 'succeeded' then format(', result = %L, error_category = null, error_code = null', pg_temp.valid_result())
             when 'failed' then ', result = null, error_category = ''configuration'', error_code = ''ar1d_matrix'''
             when 'indeterminate' then ', result = null, error_category = ''timeout'', error_code = ''ar1d_matrix'''
             when 'cancelled' then ', result = null, error_category = ''refused'', error_code = ''ar1d_matrix'''
             else ', result = null, error_category = null, error_code = null'
           end
        || ', stop_id = null';

      v_allowed := (v_from || '>' || v_to) = any (c_edges);
      begin
        perform pg_temp.raw_update(v_run, v_facts);
        v_accepted := true;
      exception when others then
        v_accepted := false;
        v_state := sqlstate;
        v_message := sqlerrm;
      end;

      if v_accepted <> v_allowed then
        raise exception 'H1: illegal agent run transition accepted, or a legal one refused: % -> % was %, the state machine says %',
          v_from, v_to, case when v_accepted then 'ACCEPTED' else 'refused (' || v_state || ': ' || v_message || ')' end,
          case when v_allowed then 'allowed' else 'forbidden' end;
      end if;
      if not v_accepted and v_state <> 'OS409' then
        raise exception 'H1: % -> % was refused for the wrong reason (% %)', v_from, v_to, v_state, v_message;
      end if;
      if v_accepted and pg_temp.run_status(v_run) is distinct from v_to then
        raise exception 'H1: % -> % was accepted but the run is %', v_from, v_to, pg_temp.run_status(v_run);
      end if;
      if v_accepted then v_edges := v_edges + 1; else v_refused := v_refused + 1; end if;
    end loop;
  end loop;

  if v_edges <> cardinality(c_edges) or v_edges + v_refused <> 30 then
    raise exception 'H1: % edges accepted and % pairs refused; expected the % declared edges and 30 pairs in total',
      v_edges, v_refused, cardinality(c_edges);
  end if;
end
$$;

-- H2. The database's relation and helper against the same literal list.
do $$
declare
  c_edges    constant text[] := array[
    'pending>running', 'pending>cancelled', 'pending>failed',
    'running>succeeded', 'running>failed', 'running>indeterminate'];
  c_statuses constant text[] := array['pending', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled'];
  v_from text;
  v_to   text;
begin
  if (select count(*) from ops.agent_run_status_transitions()) <> cardinality(c_edges)
     or exists (select 1 from ops.agent_run_status_transitions() t
                 where not ((t.from_status || '>' || t.to_status) = any (c_edges))) then
    raise exception 'H2: ops.agent_run_status_transitions() differs from the declared edges';
  end if;
  foreach v_from in array c_statuses loop
    foreach v_to in array c_statuses loop
      if ops.agent_run_transition_allowed(v_from, v_to) is distinct from ((v_from || '>' || v_to) = any (c_edges)) then
        raise exception 'H2: ops.agent_run_transition_allowed(%, %) disagrees with the declared state machine', v_from, v_to;
      end if;
    end loop;
  end loop;
end
$$;

-- H3. A finished run refuses ANY update, including a no-op.
select set_config('app.event_source', 'ar1d-raw', true);
do $$
declare
  v_status text;
  v_run    uuid;
begin
  foreach v_status in array array['succeeded', 'failed', 'indeterminate', 'cancelled'] loop
    v_run := pg_temp.raw_run_in(v_status);
    perform pg_temp.remember('run_h_' || v_status, v_run);
    perform pg_temp.expect_refused(format('H3 changing the latency of a %s run', v_status), 'OS409',
      format('update ops.agent_runs set latency_ms = coalesce(latency_ms, 0) + 1 where id = %L', v_run));
    perform pg_temp.expect_refused(format('H3 a no-op update of a %s run', v_status), 'OS409',
      format('update ops.agent_runs set status = status where id = %L', v_run));
  end loop;
end
$$;

-- H4. The request is fixed at creation, while pending too.
do $$
declare
  v_run    uuid := pg_temp.raw_run_in('pending');
  v_change record;
begin
  for v_change in
    select * from (values
      ('id', 'id = gen_random_uuid()'),
      ('tenant_id', format('tenant_id = %L', pg_temp.id('tenant_b'))),
      ('company_id', format('company_id = %L', pg_temp.id('company_a2'))),
      ('department_id', format('department_id = %L', pg_temp.id('dept_a1_support'))),
      ('task_id', format('task_id = %L', pg_temp.id('task_h_other'))),
      ('agent_id', format('agent_id = %L', pg_temp.id('agent_a1_two'))),
      ('retry_of_run_id', format('retry_of_run_id = %L', pg_temp.id('run_h_failed'))),
      ('capability', 'capability = ''task_assessment.other'''),
      ('model_route', 'model_route = ''economy'''),
      ('idempotency_key', 'idempotency_key = ''ar1d-rewritten'''),
      ('request_fingerprint', 'request_fingerprint = repeat(''b'', 64)'),
      ('correlation_id', 'correlation_id = gen_random_uuid()'),
      ('requested_by', 'requested_by = ''ar1d-rewriter'''),
      ('created_at', 'created_at = created_at - interval ''1 day''')
    ) as c (column_name, assignment)
  loop
    perform pg_temp.expect_refused(format('H4 rewriting %s of a pending run', v_change.column_name), 'OS409',
      format('update ops.agent_runs set %s where id = %L', v_change.assignment, v_run));
  end loop;
end
$$;

-- H5. The job link changes once, while pending.
do $$
declare
  v_run uuid := pg_temp.raw_run_in('pending');
begin
  perform pg_temp.raw_update(v_run, format('job_id = %L', pg_temp.id('job_h_link1')));
  if pg_temp.job_of(v_run) is distinct from pg_temp.id('job_h_link1') then
    raise exception 'H5: a pending run could not be linked to its job; the refusals below would prove nothing';
  end if;
  perform pg_temp.expect_refused('H5 relinking a linked run to another job', 'OS409',
    format('update ops.agent_runs set job_id = %L where id = %L', pg_temp.id('job_h_link2'), v_run));
  perform pg_temp.expect_refused('H5 unlinking a run from its job', 'OS409',
    format('update ops.agent_runs set job_id = null where id = %L', v_run));
  perform pg_temp.expect_refused('H5 linking a running run to a job', 'OS409',
    format('update ops.agent_runs set job_id = %L where id = %L', pg_temp.id('job_h_link2'), pg_temp.raw_run_in('running')));
  perform pg_temp.expect_refused('H5 linking a run in the update that starts it', 'OS409',
    format('update ops.agent_runs set job_id = %L, %s where id = %L',
           pg_temp.id('job_h_link2'), pg_temp.running_facts(), pg_temp.raw_run_in('pending')));
  perform pg_temp.expect_refused('H5 linking a finished run to a job', 'OS409',
    format('update ops.agent_runs set job_id = %L where id = %L', pg_temp.id('job_h_link2'), pg_temp.raw_run_in('failed')));
end
$$;
select set_config('app.event_source', '', true);

-- H6. Replica mode, the owner's restore mode, does not silence the update guards.
set local session_replication_role = replica;
do $$
begin
  begin
    update ops.agent_runs set latency_ms = 1 where id = pg_temp.id('run_h_succeeded');
    raise exception 'H6: replica mode silenced agent_runs_guard_update; guard triggers must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    -- A fixed column, the guard's first rule: the free-text rule in replica mode is N11f.
    update ops.execution_stops set tripped_by = 'someone-else' where id = pg_temp.id('stop_d');
    raise exception 'H6: replica mode silenced execution_stops_guard_update; guard triggers must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
end
$$;
set local session_replication_role = origin;

-- ===========================================================================
-- I. EVENTS.
-- ===========================================================================

-- I1 and I2. One fact per change, in order; none for a no-op.
do $$
declare
  v_types  text[];
  v_run    uuid := pg_temp.id('run_c_a_other');
  v_before bigint;
begin
  v_types := pg_temp.run_event_types(pg_temp.id('run_g'));
  if v_types is distinct from array['agent_run.requested', 'agent_run.started', 'agent_run.succeeded'] then
    raise exception 'I1: an agent run did not emit exactly one fact per change, in order: %', v_types;
  end if;
  v_types := pg_temp.run_event_types(pg_temp.id('run_h_cancelled'));
  if v_types is distinct from array['agent_run.requested', 'agent_run.cancelled'] then
    raise exception 'I1: a run cancelled before any call did not emit exactly its two facts: %', v_types;
  end if;

  select count(*) into v_before from ops.events e where e.subject_id = v_run;
  perform pg_temp.raw_update(v_run, 'status = status');
  perform pg_temp.raw_update(v_run, 'status = status, job_id = job_id, updated_at = updated_at');
  -- Without provenance too: a no-op must not even need it.
  update ops.agent_runs set status = status where id = v_run;
  if (select count(*) from ops.events e where e.subject_id = v_run) <> v_before then
    raise exception 'I2: a no-op update of an agent run recorded % fact(s)',
      (select count(*) from ops.events e where e.subject_id = v_run) - v_before;
  end if;
end
$$;

-- I4. A run's facts cannot be recorded, only derived: through the function, with
--     the table guard off, and in replica mode, where the function's own check is
--     the only thing left.
select pg_temp.expect_refused('I4 record_event forging agent_run.succeeded', 'OS403', format($q$
  select ops.record_event(%L, %L, 'agent_run.succeeded', 'ar1d-attack', 'agent_run', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('run_c_a')));
select pg_temp.expect_refused_without_trigger('I4 record_event forging agent_run.succeeded with the table guard off', 'OS403',
  'events', 'events_guard_insert', format($q$
  select ops.record_event(%L, %L, 'agent_run.succeeded', 'ar1d-attack', 'agent_run', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('run_c_a')));
set local session_replication_role = replica;
do $$
begin
  begin
    perform ops.record_event(pg_temp.id('tenant_a'), pg_temp.id('company_a1'), 'agent_run.succeeded', 'ar1d-attack',
                             'agent_run', pg_temp.id('run_c_a'));
    raise exception 'I4: record_event forged an agent_run fact in replica mode';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;
set local session_replication_role = origin;

-- I5. Nor inserted raw.
select pg_temp.expect_refused('I5 a raw insert forging agent_run.requested', 'OS403', format($q$
  insert into ops.events (tenant_id, company_id, type, source, subject_type, subject_id)
  values (%L, %L, 'agent_run.requested', 'ar1d-attack', 'agent_run', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('run_c_a')));
select pg_temp.expect_refused('I5 a raw insert forging agent_run.cancelled with no subject', 'OS403', format($q$
  insert into ops.events (tenant_id, company_id, type, source) values (%L, %L, 'agent_run.cancelled', 'ar1d-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));

-- I6. An event's agent_run subject lives in the event's own company.
select pg_temp.expect_refused('I6 an event about another company''s run', 'OS404', format($q$
  select ops.record_event(%L, %L, 'review.noted', 'ar1d-record', 'agent_run', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a2'), pg_temp.id('run_g')));
select pg_temp.expect_refused('I6 an event about another tenant''s run', 'OS404', format($q$
  select ops.record_event(%L, %L, 'review.noted', 'ar1d-record', 'agent_run', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('run_c_b')));

-- I7. A legitimate business fact about a run in its own company, so I6 is not a broken guard.
do $$
begin
  if ops.record_event(pg_temp.id('tenant_a'), pg_temp.id('company_a1'), 'review.noted', 'ar1d-record',
                      'agent_run', pg_temp.id('run_g')) is null then
    raise exception 'I7: a valid business fact about an agent run could not be recorded';
  end if;
end
$$;

-- (I3, payload minimisation, runs last, over every agent_run fact every section produced.)

-- ===========================================================================
-- J. THE TASK -> JOB BRIDGE, FOR THE AGENT RUN KIND.
-- ===========================================================================
select pg_temp.remember('run_j_pending', pg_temp.raw_run_in('pending', 'task_j'));
select pg_temp.remember('run_j_other_task', pg_temp.raw_run_in('pending', 'task_j_other'));
select pg_temp.remember('run_j_running', pg_temp.raw_run_in('running', 'task_j'));
select pg_temp.remember('run_j_finished', pg_temp.raw_run_in('failed', 'task_j'));
select pg_temp.remember('run_j_linked', pg_temp.request('ar1d-j-linked', 'tenant_a', 'task_j', 'agent_a1'));

-- J1. The payload is exactly one uuid-shaped agent_run_id.
select pg_temp.expect_refused('J1 an agent run job with an empty payload', 'OS400', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', '{}'::jsonb)
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j')));
select pg_temp.expect_refused('J1 an agent run job with no payload', 'OS400', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', null)
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j')));
select pg_temp.expect_refused('J1 an agent run job with an extra key', 'OS400', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L, 'tenant_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_pending'), pg_temp.id('tenant_b')));
select pg_temp.expect_refused('J1 an agent run job naming a non-uuid', 'OS400', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', '{"agent_run_id": "not-a-uuid"}'::jsonb)
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j')));
select pg_temp.expect_refused('J1 an agent run job naming a number', 'OS400', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', '{"agent_run_id": 42}'::jsonb)
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j')));
select pg_temp.expect_refused('J1 an agent run job naming a uuid with trailing text', 'OS400', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L || ' or true'))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_pending')));

-- J2. The run is resolved inside the task's tenant and task.
select pg_temp.expect_refused('J2 naming tenant B''s run from a tenant-A task', 'OS404', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_c_b')));
select pg_temp.expect_refused('J2 naming a run of another task', 'OS404', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_other_task')));
select pg_temp.expect_refused('J2 tenant B''s task and run through tenant A', 'OS404', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_b'), pg_temp.id('run_c_b')));

-- J3. Only a pending run without a job.
select pg_temp.expect_refused('J3 naming a running run', 'OS409', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_running')));
select pg_temp.expect_refused('J3 naming a finished run', 'OS409', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_finished')));
select pg_temp.expect_refused('J3 naming an already linked run', 'OS409', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L), 'ar1d-j-second')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_linked')));
select pg_temp.expect_refused('J3 naming an already linked run without a key', 'OS409', format($q$
  select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L))
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j'), pg_temp.id('run_j_linked')));

do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_before text;
  v_job    uuid;
  v_run    uuid := pg_temp.id('run_j_pending');
  j        ops.jobs;
begin
  -- J3. The bridge's own replay, with the key the request used, is the same job.
  v_before := pg_temp.runtime_footprint();
  v_job := ops.request_task_execution(ta, pg_temp.id('task_j'), 'agent_run.execute', 'ar1d-test',
                                      jsonb_build_object('agent_run_id', pg_temp.id('run_j_linked')),
                                      format('agent_run:%s', pg_temp.id('run_j_linked')));
  if v_job is distinct from pg_temp.job_of(pg_temp.id('run_j_linked')) then
    raise exception 'J3: replaying the bridge request with the run''s own key returned %, not its job %',
      v_job, pg_temp.job_of(pg_temp.id('run_j_linked'));
  end if;
  if pg_temp.runtime_footprint() is distinct from v_before then
    raise exception 'J3: replaying the bridge request wrote something: before (%), after (%)', v_before, pg_temp.runtime_footprint();
  end if;

  -- J4. A direct valid call creates the job in the task's tenant and links it.
  v_job := ops.request_task_execution(ta, pg_temp.id('task_j'), 'agent_run.execute', 'ar1d-bridge',
                                      jsonb_build_object('agent_run_id', v_run), 'ar1d-direct');
  select * into j from ops.jobs where id = v_job;
  if j.tenant_id is distinct from ta or j.kind <> 'agent_run.execute'
     or j.payload is distinct from jsonb_build_object('agent_run_id', v_run) then
    raise exception 'J4: the bridge created a job outside its task''s tenant or with another payload: %', to_jsonb(j);
  end if;
  if pg_temp.job_of(v_run) is distinct from v_job then
    raise exception 'J4: the bridge created a job without linking it to its run';
  end if;
  if not exists (select 1 from ops.task_jobs l where l.tenant_id = ta and l.job_id = v_job and l.task_id = pg_temp.id('task_j')) then
    raise exception 'J4: the bridge created a job without linking it to its task';
  end if;
end
$$;

-- J5. The allowlist still refuses everything else.
select pg_temp.expect_refused('J5 a real handler kind a task may not request', 'OS403', format($q$
  select ops.request_task_execution(%L, %L, 'postmark.ledger_retention', 'ar1d-bridge')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_j')));

-- ===========================================================================
-- K. THE KILL SWITCH.
-- ===========================================================================

-- K1, K4, K5, K7. For every scope: trip (twice), a covered request is RECORDED
-- cancelled by that stop with no job, a request outside the scope proceeds,
-- clearing is reported once, and clearing restores requests.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_case  record;
  v_stop  uuid;
  v_again uuid;
  v_run   uuid;
  r       ops.agent_runs;
  v_scopes integer := 0;
begin
  for v_case in
    select * from (values
      ('global',     null::uuid, null::uuid, null::uuid, null::uuid, 'task_k_b',     'agent_b',          'tenant_b'),
      ('tenant',     ta,         null,       null,       null,       'task_k_b',     'agent_b',          'tenant_b'),
      ('company',    ta,         ca1,        null,       null,       'task_k_a2',    'agent_a2',         'tenant_a'),
      ('department', ta,         ca1,        da1,        null,       'task_k_a1s',   'agent_a1_support', 'tenant_a'),
      ('agent',      ta,         ca1,        null,       ga1,        'task_k_a1two', 'agent_a1_two',     'tenant_a')
    ) as c (scope, tenant_id, company_id, department_id, agent_id, other_task, other_agent, other_tenant)
  loop
    v_stop := ops.trip_execution_stop(v_case.scope, format('ar1d-test: %s stop', v_case.scope), 'ar1d-owner',
                                      v_case.tenant_id, v_case.company_id, v_case.department_id, v_case.agent_id);

    -- K5. Tripping the same target again is the same stop, unchanged.
    v_again := ops.trip_execution_stop(v_case.scope, 'ar1d-test: tripped again', 'ar1d-owner',
                                       v_case.tenant_id, v_case.company_id, v_case.department_id, v_case.agent_id);
    if v_again is distinct from v_stop then
      raise exception 'K5: tripping the same % target twice returned a second stop', v_case.scope;
    end if;
    if (select count(*) from ops.execution_stops s
         where s.cleared_at is null and s.scope = v_case.scope
           and s.tenant_id is not distinct from v_case.tenant_id and s.company_id is not distinct from v_case.company_id
           and s.department_id is not distinct from v_case.department_id and s.agent_id is not distinct from v_case.agent_id) <> 1
       or (select s.reason from ops.execution_stops s where s.id = v_stop) <> format('ar1d-test: %s stop', v_case.scope) then
    raise exception 'K5: tripping a % target twice left more than one active stop, or rewrote it', v_case.scope;
    end if;

    -- K1. Covered: recorded, refused, no job.
    v_run := pg_temp.request(format('ar1d-k-%s-covered', v_case.scope), 'tenant_a', 'task_k_a1', 'agent_a1');
    select * into r from ops.agent_runs where id = v_run;
    if r.status <> 'cancelled' or r.error_category <> 'refused' or r.error_code <> 'execution_stopped'
       or r.stop_id is distinct from v_stop or r.job_id is not null or r.started_at is not null or r.completed_at is null then
      raise exception 'K1: a request covered by a % stop was not recorded cancelled by that stop with no job: % / % / % / stop % / job %',
        v_case.scope, r.status, r.error_category, r.error_code, r.stop_id, r.job_id;
    end if;
    if exists (select 1 from ops.jobs j where j.tenant_id = ta and j.payload ->> 'agent_run_id' = v_run::text) then
      raise exception 'K1: a request refused by a % stop still created a job', v_case.scope;
    end if;
    if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.cancelled'] then
      raise exception 'K1: a request refused by a % stop recorded %', v_case.scope, pg_temp.run_event_types(v_run);
    end if;

    -- K1. Not covered: proceeds. A global stop covers everyone, so there it refuses too.
    v_run := pg_temp.request(format('ar1d-k-%s-uncovered', v_case.scope), v_case.other_tenant, v_case.other_task, v_case.other_agent);
    select * into r from ops.agent_runs where id = v_run;
    if v_case.scope = 'global' then
      if r.status <> 'cancelled' or r.stop_id is distinct from v_stop then
        raise exception 'K1: a global stop did not refuse another tenant''s run (%)', r.status;
      end if;
    elsif r.status <> 'pending' or r.job_id is null or r.stop_id is not null then
      raise exception 'K1: a % stop refused a run it does not cover (%, job %)', v_case.scope, r.status, r.job_id;
    end if;

    -- K7. Cleared once; a second clearing reports nothing and rewrites nothing.
    if ops.clear_execution_stop(v_stop, 'ar1d-test: cleared', 'ar1d-owner') is not true then
      raise exception 'K7: clearing an active % stop did not report it', v_case.scope;
    end if;
    if ops.clear_execution_stop(v_stop, 'ar1d-test: cleared again', 'ar1d-other') is not false then
      raise exception 'K7: clearing a % stop twice reported a second clearing', v_case.scope;
    end if;
    if not exists (select 1 from ops.execution_stops s
                    where s.id = v_stop and s.cleared_reason = 'ar1d-test: cleared' and s.cleared_by = 'ar1d-owner') then
      raise exception 'K7: clearing a % stop twice rewrote the clearing', v_case.scope;
    end if;

    -- K4. Clearing restores requests.
    v_run := pg_temp.request(format('ar1d-k-%s-after-clear', v_case.scope), 'tenant_a', 'task_k_a1', 'agent_a1');
    if pg_temp.run_status(v_run) <> 'pending' or pg_temp.job_of(v_run) is null then
      raise exception 'K4: clearing a % stop did not restore requests (%)', v_case.scope, pg_temp.run_status(v_run);
    end if;
    v_scopes := v_scopes + 1;
  end loop;

  if v_scopes <> 5 then
    raise exception 'K1: % of the 5 stop scopes were exercised', v_scopes;
  end if;
end
$$;

-- K2. Deny wins: a cleared narrower stop is not an allow, and an active tenant
--     stop refuses though nothing narrower is stopped.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_agent_stop  uuid;
  v_tenant_stop uuid;
  v_run uuid;
  r     ops.agent_runs;
begin
  v_agent_stop := ops.trip_execution_stop('agent', 'ar1d-test: narrower', 'ar1d-owner', ta, ca1, null, ga1);
  v_tenant_stop := ops.trip_execution_stop('tenant', 'ar1d-test: broader', 'ar1d-owner', ta);
  perform ops.clear_execution_stop(v_agent_stop, 'ar1d-test: narrower cleared', 'ar1d-owner');

  v_run := pg_temp.request('ar1d-k-deny-wins', 'tenant_a', 'task_k_a1', 'agent_a1');
  select * into r from ops.agent_runs where id = v_run;
  if r.status <> 'cancelled' or r.stop_id is distinct from v_tenant_stop or r.job_id is not null then
    raise exception 'K2: an active tenant stop did not refuse a run whose narrower stop was cleared (%, stop %, job %)',
      r.status, r.stop_id, r.job_id;
  end if;
  if ops.active_execution_stop(ta, ca1, pg_temp.id('dept_a1'), ga1) is distinct from v_tenant_stop then
    raise exception 'K2: the switch read for the agent is not the active tenant stop';
  end if;
  perform ops.clear_execution_stop(v_tenant_stop, 'ar1d-test: broader cleared', 'ar1d-owner');
end
$$;

-- K3. A stop tripped AFTER the request refuses at ops.start_agent_run, on a real
--     lease: recorded cancelled, never running, no fact of a call.
do $$
declare
  v_run   uuid;
  v_stop  uuid;
  v_claim jsonb;
  v_state text;
  r       ops.agent_runs;
begin
  v_run := pg_temp.leased_run('ar1d-k-late-stop', 'task_k_a1two', 'agent_a1_two');
  v_stop := ops.trip_execution_stop('agent', 'ar1d-test: tripped after the request', 'ar1d-owner',
                                    pg_temp.id('tenant_a'), pg_temp.id('company_a1'), null, pg_temp.id('agent_a1_two'));
  perform pg_temp.as_worker();
  v_claim := ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  if v_claim ->> 'action' is distinct from 'start' then
    raise exception 'K3: the claim did not offer the run for a start (%); this case would prove nothing', v_claim;
  end if;
  select * into r from ops.agent_runs where id = v_run;
  if v_state is distinct from 'cancelled' or r.status <> 'cancelled' or r.error_category <> 'refused'
     or r.error_code <> 'execution_stopped' or r.stop_id is distinct from v_stop
     or r.started_at is not null or r.provider is not null or r.job_attempt is not null then
    raise exception 'K3: a stop tripped after the request did not refuse the run at start (start returned %, run % / % / stop %)',
      v_state, r.status, r.error_code, r.stop_id;
  end if;
  if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.cancelled'] then
    raise exception 'K3: a run refused at start recorded %', pg_temp.run_event_types(v_run);
  end if;
  perform ops.clear_execution_stop(v_stop, 'ar1d-test: cleared', 'ar1d-owner');
end
$$;

-- K6. A stop is never rewritten; the only change is its clearing, with who and why.
select pg_temp.remember('stop_k6', ops.trip_execution_stop('agent', 'ar1d-test: rewrite target', 'ar1d-owner',
  pg_temp.id('tenant_a'), pg_temp.id('company_a1'), null, pg_temp.id('agent_a1_idle')));
select pg_temp.expect_refused('K6 rewriting a stop''s reason', 'OS409', format($q$
  update ops.execution_stops set reason = 'ar1d-test: rewritten' where id = %L
$q$, pg_temp.id('stop_k6')));
select pg_temp.expect_refused('K6 re-targeting a stop', 'OS409', format($q$
  update ops.execution_stops set scope = 'tenant', company_id = null, agent_id = null where id = %L
$q$, pg_temp.id('stop_k6')));
select pg_temp.expect_refused('K6 backdating a stop', 'OS409', format($q$
  update ops.execution_stops set tripped_at = tripped_at - interval '1 day' where id = %L
$q$, pg_temp.id('stop_k6')));
select pg_temp.expect_refused('K6 re-attributing a stop', 'OS409', format($q$
  update ops.execution_stops set tripped_by = 'someone-else' where id = %L
$q$, pg_temp.id('stop_k6')));
select pg_temp.expect_refused('K6 a clearing that names no one', 'OS409', format($q$
  update ops.execution_stops set cleared_reason = 'ar1d-test: anonymous' where id = %L
$q$, pg_temp.id('stop_k6')));
select pg_temp.expect_refused('K6 a clearing by timestamp alone', 'OS409', format($q$
  update ops.execution_stops set cleared_at = now() where id = %L
$q$, pg_temp.id('stop_k6')));
do $$
declare
  v_cleared timestamptz;
begin
  begin
    update ops.execution_stops
       set cleared_by = 'ar1d-owner', cleared_reason = 'ar1d-test: backdated clearing', cleared_at = now() - interval '1 year'
     where id = pg_temp.id('stop_k6')
     returning cleared_at into v_cleared;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_cleared is distinct from now() then
    raise exception 'K6: a clearing was recorded at %, not by the database clock', v_cleared;
  end if;
end
$$;
select ops.clear_execution_stop(pg_temp.id('stop_k6'), 'ar1d-test: cleared', 'ar1d-owner');
select pg_temp.expect_refused('K6 rewriting a cleared stop''s clearing', 'OS409', format($q$
  update ops.execution_stops set cleared_reason = 'ar1d-test: changed my mind' where id = %L
$q$, pg_temp.id('stop_k6')));
select pg_temp.expect_refused('K6 re-arming a cleared stop', 'OS409', format($q$
  update ops.execution_stops set cleared_by = null, cleared_reason = null, cleared_at = null where id = %L
$q$, pg_temp.id('stop_k6')));

-- K8. Clearing is an owner act recorded whole.
select pg_temp.remember('stop_k8', ops.trip_execution_stop('agent', 'ar1d-test: clearing target', 'ar1d-owner',
  pg_temp.id('tenant_a'), pg_temp.id('company_a1'), null, pg_temp.id('agent_a1_idle')));
select pg_temp.expect_refused('K8 clearing a stop without a reason', '23514', format($q$
  select ops.clear_execution_stop(%L, null, 'ar1d-owner')
$q$, pg_temp.id('stop_k8')));
select pg_temp.expect_refused('K8 clearing a stop with a blank reason', '23514', format($q$
  select ops.clear_execution_stop(%L, '   ', 'ar1d-owner')
$q$, pg_temp.id('stop_k8')));
select pg_temp.expect_refused('K8 clearing a stop as a malformed actor', '23514', format($q$
  select ops.clear_execution_stop(%L, 'ar1d-test: cleared', 'The Owner')
$q$, pg_temp.id('stop_k8')));
select pg_temp.expect_refused('K8 clearing a stop without an actor', 'OS409', format($q$
  select ops.clear_execution_stop(%L, 'ar1d-test: cleared', null)
$q$, pg_temp.id('stop_k8')));
select pg_temp.expect_refused('K8 clearing an unknown stop', 'OS404', $q$
  select ops.clear_execution_stop('00000000-0000-4000-8000-000000000000', 'ar1d-test: cleared', 'ar1d-owner')
$q$);
select ops.clear_execution_stop(pg_temp.id('stop_k8'), 'ar1d-test: cleared', 'ar1d-owner');

-- K9. A malformed scope or target shape.
select pg_temp.expect_refused('K9 an unknown scope', 'OS400', $q$
  select ops.trip_execution_stop('planet', 'ar1d-test: shape', 'ar1d-owner')
$q$);
select pg_temp.expect_refused('K9 no scope', 'OS400', $q$
  select ops.trip_execution_stop(null, 'ar1d-test: shape', 'ar1d-owner')
$q$);
select pg_temp.expect_refused('K9 a global stop naming a tenant', 'OS400', format($q$
  select ops.trip_execution_stop('global', 'ar1d-test: shape', 'ar1d-owner', %L)
$q$, pg_temp.id('tenant_a')));
select pg_temp.expect_refused('K9 a tenant stop naming a company', 'OS400', format($q$
  select ops.trip_execution_stop('tenant', 'ar1d-test: shape', 'ar1d-owner', %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('K9 a company stop without its company', 'OS400', format($q$
  select ops.trip_execution_stop('company', 'ar1d-test: shape', 'ar1d-owner', %L)
$q$, pg_temp.id('tenant_a')));
select pg_temp.expect_refused('K9 a department stop without its department', 'OS400', format($q$
  select ops.trip_execution_stop('department', 'ar1d-test: shape', 'ar1d-owner', %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('K9 an agent stop naming a department', 'OS400', format($q$
  select ops.trip_execution_stop('agent', 'ar1d-test: shape', 'ar1d-owner', %L, %L, %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1'), pg_temp.id('agent_a1')));
select pg_temp.expect_refused('K9 a scoped stop without its tenant', 'OS401', format($q$
  select ops.trip_execution_stop('company', 'ar1d-test: shape', 'ar1d-owner', null, %L)
$q$, pg_temp.id('company_a1')));
select pg_temp.expect_refused('K9 a stop without a reason', '23514', $q$
  select ops.trip_execution_stop('global', '  ', 'ar1d-owner')
$q$);
select pg_temp.expect_refused('K9 a stop by a malformed actor', '23514', $q$
  select ops.trip_execution_stop('global', 'ar1d-test: shape', 'The Owner')
$q$);

-- K10. A target outside its tenant is not found.
select pg_temp.expect_refused('K10 a company stop for another tenant''s company', 'OS404', format($q$
  select ops.trip_execution_stop('company', 'ar1d-test: scope', 'ar1d-owner', %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));
select pg_temp.expect_refused('K10 a department stop for another company''s department', 'OS404', format($q$
  select ops.trip_execution_stop('department', 'ar1d-test: scope', 'ar1d-owner', %L, %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a2')));
select pg_temp.expect_refused('K10 an agent stop for another company''s agent', 'OS404', format($q$
  select ops.trip_execution_stop('agent', 'ar1d-test: scope', 'ar1d-owner', %L, %L, null, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('agent_a2')));
select pg_temp.expect_refused('K10 an agent stop for another tenant''s agent', 'OS404', format($q$
  select ops.trip_execution_stop('agent', 'ar1d-test: scope', 'ar1d-owner', %L, %L, null, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('agent_b')));
select pg_temp.expect_refused('K10 a tenant stop for an unknown tenant', 'OS404', $q$
  select ops.trip_execution_stop('tenant', 'ar1d-test: scope', 'ar1d-owner', '00000000-0000-4000-8000-000000000000')
$q$);

-- K11. A switch that cannot be read refuses rather than reading "no stop".
select pg_temp.expect_refused('K11 reading the switch without a tenant', 'OS400', format($q$
  select ops.active_execution_stop(null, %L, %L, %L)
$q$, pg_temp.id('company_a1'), pg_temp.id('dept_a1'), pg_temp.id('agent_a1')));
select pg_temp.expect_refused('K11 reading the switch without a company', 'OS400', format($q$
  select ops.active_execution_stop(%L, null, %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('dept_a1'), pg_temp.id('agent_a1')));
select pg_temp.expect_refused('K11 reading the switch without a department', 'OS400', format($q$
  select ops.active_execution_stop(%L, %L, null, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('agent_a1')));
select pg_temp.expect_refused('K11 reading the switch without an agent', 'OS400', format($q$
  select ops.active_execution_stop(%L, %L, %L, null)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1')));

-- K12. A run records only a stop that covers its tenant, and only as cancelled.
select pg_temp.remember('stop_k12_b', ops.trip_execution_stop('tenant', 'ar1d-test: tenant B', 'ar1d-owner', pg_temp.id('tenant_b')));
select pg_temp.remember('run_k12', pg_temp.raw_run_in('pending', 'task_k_a1'));
select set_config('app.event_source', 'ar1d-raw', true);
select pg_temp.expect_refused('K12 the owner records tenant B''s stop on a tenant-A run', 'OS409', format($q$
  update ops.agent_runs set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped', stop_id = %L
   where id = %L
$q$, pg_temp.id('stop_k12_b'), pg_temp.id('run_k12')));
do $$
declare
  v_stop uuid;
begin
  begin
    v_stop := ops.trip_execution_stop('tenant', 'ar1d-test: tenant A control', 'ar1d-owner', pg_temp.id('tenant_a'));
    perform pg_temp.expect_refused('K12 a stop recorded on a failed run', 'OS409', format($q$
      update ops.agent_runs set status = 'failed', error_category = 'configuration', error_code = 'execution_stopped', stop_id = %L
       where id = %L
    $q$, v_stop, pg_temp.id('run_k12')));
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped', stop_id = v_stop
     where id = pg_temp.id('run_k12');
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception
    when sqlstate 'C1CAC' then null;
    when others then
      raise exception 'K12: the owner could not record tenant A''s own stop on a tenant-A run (% %), so the refusal above proves nothing',
        sqlstate, sqlerrm;
  end;
end
$$;
select set_config('app.event_source', '', true);
select ops.clear_execution_stop(pg_temp.id('stop_k12_b'), 'ar1d-test: cleared', 'ar1d-owner');

-- ===========================================================================
-- L. THE WORKER'S SEQUENCE ON A REAL LEASE. The database layer alone: no
--    TypeScript is involved, so every property here holds against a defective
--    worker too.
-- ===========================================================================

-- L1. claim -> start -> complete(valid).
do $$
declare
  v_task_before jsonb := (select to_jsonb(t) from ops.tasks t where t.id = pg_temp.id('task_l'));
  v_run     uuid;
  v_claim   jsonb;
  v_started ops.agent_runs;
  v_state   text;
  r         ops.agent_runs;
begin
  v_run := pg_temp.leased_run('ar1d-l-success', 'task_l', 'agent_a1');
  perform pg_temp.remember('run_l_success', v_run);
  perform pg_temp.as_worker();
  v_claim := ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  select * into v_started from ops.agent_runs where id = v_run;
  perform pg_temp.as_worker();
  v_state := v_state || '>' || ops.complete_agent_run(pg_temp.valid_result(), 'fake-model-2', 'completed',
                                                      'fake-req-1', 'fake-resp-1', 120, 60, 180, 10, 5, 42);
  perform pg_temp.as_owner();

  -- The claim is exactly the bounded prompt context, and identifies nothing but the run.
  if v_claim ->> 'action' is distinct from 'start' or v_claim ->> 'agent_run_id' is distinct from v_run::text
     or v_claim ->> 'capability' is distinct from 'task_assessment' or v_claim ->> 'model_route' is distinct from 'standard' then
    raise exception 'L1: the claim did not offer the leased run for a start: %', v_claim;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v_claim) as k)
       is distinct from array['action', 'agent', 'agent_run_id', 'capability', 'model_route', 'task']
     or (select array_agg(k order by k) from jsonb_object_keys(v_claim -> 'agent') as k)
       is distinct from array['description', 'name', 'role']
     or (select array_agg(k order by k) from jsonb_object_keys(v_claim -> 'task') as k)
       is distinct from array['description', 'due_at', 'priority', 'title', 'type'] then
    raise exception 'L1: the claim carries more or less than the bounded prompt context: %', v_claim;
  end if;
  if v_claim -> 'agent' ->> 'name' is distinct from 'Analyst'
     or v_claim -> 'task' ->> 'title' is distinct from (v_task_before ->> 'title') then
    raise exception 'L1: the claim describes another agent or task: %', v_claim;
  end if;
  if (v_claim - 'agent_run_id')::text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then
    raise exception 'L1: the claim carries an identifier beyond the run''s own: %', v_claim;
  end if;

  if v_started.status <> 'running' or v_started.started_at is null or v_started.job_attempt is distinct from 1
     or v_started.provider <> 'fake' or v_started.model <> 'fake-model-1'
     or v_started.prompt_version <> 'task_assessment.v1' or v_started.input_fingerprint <> repeat('f', 64) then
    raise exception 'L1: start did not record the run running with what it started: %', to_jsonb(v_started);
  end if;

  select * into r from ops.agent_runs where id = v_run;
  if v_state is distinct from 'running>succeeded' or r.status <> 'succeeded' or r.result is distinct from pg_temp.valid_result()
     or r.provider <> 'fake' or r.model <> 'fake-model-1' or r.response_model is distinct from 'fake-model-2'
     or r.prompt_version <> 'task_assessment.v1' or r.input_fingerprint <> repeat('f', 64) or r.job_attempt is distinct from 1
     or r.finish_reason is distinct from 'completed'
     or r.provider_request_id is distinct from 'fake-req-1' or r.provider_response_id is distinct from 'fake-resp-1'
     or (r.input_tokens, r.output_tokens, r.total_tokens, r.cached_input_tokens, r.reasoning_tokens, r.latency_ms)
          is distinct from (120, 60, 180, 10, 5, 42)
     or r.error_category is not null or r.error_code is not null or r.completed_at is null then
    raise exception 'L1: a valid completion was not stored as succeeded with its facts (returned %): %', v_state, to_jsonb(r);
  end if;
  if (select to_jsonb(t) from ops.tasks t where t.id = pg_temp.id('task_l')) is distinct from v_task_before then
    raise exception 'L1: an agent run changed its task';
  end if;
end
$$;

-- L1. An out-of-shape identifier or usage figure is dropped, and does not cost the result.
do $$
declare
  v_run   uuid := pg_temp.leased_run('ar1d-l-odd-facts', 'task_l', 'agent_a1');
  v_state text;
  r       ops.agent_runs;
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  v_state := ops.complete_agent_run(pg_temp.valid_result(), 'model id with spaces', 'Completed Loudly',
                                    'request id with spaces', repeat('x', 201), -1, -2, -3, -4, -5, -6);
  perform pg_temp.as_owner();
  select * into r from ops.agent_runs where id = v_run;
  if v_state is distinct from 'succeeded' or r.status <> 'succeeded'
     or r.response_model is not null or r.finish_reason is not null
     or r.provider_request_id is not null or r.provider_response_id is not null
     or r.input_tokens is not null or r.output_tokens is not null or r.total_tokens is not null
     or r.cached_input_tokens is not null or r.reasoning_tokens is not null or r.latency_ms is not null then
    raise exception 'L1: an out-of-shape provider fact cost the result, or was stored (returned %): %', v_state, to_jsonb(r);
  end if;
end
$$;

-- L2. The database contract refuses every invalid envelope by itself, and accepts
--     the limits exactly.
do $$
declare
  v_case  record;
  v_run   uuid;
  v_state text;
  v_n     integer := 0;
  r       ops.agent_runs;
begin
  for v_case in
    select * from (values
      ('an extra key', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": [], "confidence": 0.9}'::jsonb),
      ('a missing key', '{"outcome": "completed", "summary": "ok"}'),
      ('an unknown outcome', '{"outcome": "done", "summary": "ok", "proposed_next_steps": []}'),
      ('a non-string outcome', '{"outcome": 1, "summary": "ok", "proposed_next_steps": []}'),
      ('an empty summary', '{"outcome": "completed", "summary": "", "proposed_next_steps": []}'),
      ('a whitespace summary', '{"outcome": "completed", "summary": " \t\n ", "proposed_next_steps": []}'),
      ('a 1001-character summary', jsonb_build_object('outcome', 'completed', 'summary', repeat('s', 1001), 'proposed_next_steps', '[]'::jsonb)),
      ('a non-string summary', '{"outcome": "completed", "summary": ["ok"], "proposed_next_steps": []}'),
      ('11 steps', jsonb_build_object('outcome', 'completed', 'summary', 'ok',
                                      'proposed_next_steps', (select jsonb_agg('step ' || g) from generate_series(1, 11) as g))),
      ('a 301-character step', jsonb_build_object('outcome', 'completed', 'summary', 'ok', 'proposed_next_steps', jsonb_build_array(repeat('p', 301)))),
      ('an empty step', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": [""]}'),
      ('a whitespace step', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": ["   "]}'),
      ('a non-string step', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": [1]}'),
      ('a nested step', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": [["nested"]]}'),
      ('steps that are not an array', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": "do it"}'),
      ('an array', '[]'),
      ('a string', '"completed"'),
      ('a JSON null', 'null'),
      ('no result at all', null)
    ) as c (label, envelope)
  loop
    v_n := v_n + 1;
    v_run := pg_temp.leased_run(format('ar1d-l-invalid-%s', v_n), 'task_l', 'agent_a1');
    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
    v_state := ops.complete_agent_run(v_case.envelope, 'fake-model-1', 'completed', 'fake-req', 'fake-resp', 1, 1, 2, 0, 0, 5);
    perform pg_temp.as_owner();
    select * into r from ops.agent_runs where id = v_run;
    if v_state is distinct from 'failed' or r.status <> 'failed' or r.error_category is distinct from 'schema_validation'
       or r.error_code is distinct from 'database_contract' or r.result is not null then
      raise exception 'L2: an envelope with % was not refused by the database contract: returned %, run % / % / %, result %',
        v_case.label, v_state, r.status, r.error_category, r.error_code, r.result;
    end if;
  end loop;

  for v_case in
    select * from (values
      ('a 1000-character summary', jsonb_build_object('outcome', 'completed', 'summary', repeat('s', 1000), 'proposed_next_steps', '[]'::jsonb)),
      ('1000 two-byte characters', jsonb_build_object('outcome', 'blocked', 'summary', repeat(chr(233), 1000), 'proposed_next_steps', '[]'::jsonb)),
      ('10 steps of 300 characters', jsonb_build_object('outcome', 'needs_input', 'summary', 'ok',
                                                        'proposed_next_steps', (select jsonb_agg(repeat('p', 300)) from generate_series(1, 10)))),
      ('surrounding whitespace', '{"outcome": "completed", "summary": "  ok  ", "proposed_next_steps": [" step "]}'::jsonb)
    ) as c (label, envelope)
  loop
    v_n := v_n + 1;
    v_run := pg_temp.leased_run(format('ar1d-l-valid-%s', v_n), 'task_l', 'agent_a1');
    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
    v_state := ops.complete_agent_run(v_case.envelope, 'fake-model-1', 'completed', 'fake-req', 'fake-resp', 1, 1, 2, 0, 0, 5);
    perform pg_temp.as_owner();
    select * into r from ops.agent_runs where id = v_run;
    if v_state is distinct from 'succeeded' or r.status <> 'succeeded' or r.result is distinct from v_case.envelope then
      raise exception 'L2: a valid envelope with % was refused by the database contract (returned %, run % / %)',
        v_case.label, v_state, r.status, r.error_code;
    end if;
  end loop;
end
$$;

-- L3. The worker reports a category; the database decides what it means.
do $$
declare
  v_case  record;
  v_run   uuid;
  v_state text;
  v_n     integer := 0;
  r       ops.agent_runs;
begin
  for v_case in
    select * from (values
      ('configuration', 'failed', 'configuration'),
      ('authentication', 'failed', 'authentication'),
      ('rate_limit', 'failed', 'rate_limit'),
      ('invalid_request', 'failed', 'invalid_request'),
      ('provider_5xx', 'indeterminate', 'provider_5xx'),
      ('invalid_response', 'failed', 'invalid_response'),
      ('schema_validation', 'failed', 'schema_validation'),
      ('timeout', 'indeterminate', 'timeout'),
      ('transport', 'indeterminate', 'transport'),
      ('cancelled', 'indeterminate', 'cancelled'),
      ('unknown', 'indeterminate', 'unknown'),
      -- Not a category at all, or one only the database may assign.
      ('made_up', 'indeterminate', 'unknown'),
      ('interrupted', 'indeterminate', 'unknown'),
      ('job_failed', 'indeterminate', 'unknown'),
      ('refused', 'indeterminate', 'unknown'),
      (null, 'indeterminate', 'unknown')
    ) as c (reported, status, category)
  loop
    v_n := v_n + 1;
    v_run := pg_temp.leased_run(format('ar1d-l-fail-%s', v_n), 'task_l', 'agent_a1');
    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
    v_state := ops.fail_agent_run(v_case.reported, 'provider_code', 'fake-model-2', 'fake-req', 'fake-resp', 10, 0, 10, 0, 0, 7);
    perform pg_temp.as_owner();
    select * into r from ops.agent_runs where id = v_run;
    if v_state is distinct from v_case.status or r.status is distinct from v_case.status
       or r.error_category is distinct from v_case.category or r.error_code is distinct from 'provider_code'
       or r.result is not null or r.completed_at is null then
      raise exception 'L3: fail_agent_run(%) gave % / % (returned %), expected % / %',
        coalesce(v_case.reported, 'NULL'), r.status, r.error_category, v_state, v_case.status, v_case.category;
    end if;
  end loop;

  -- A malformed code is dropped, not stored.
  v_run := pg_temp.leased_run('ar1d-l-fail-odd-code', 'task_l', 'agent_a1');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform ops.fail_agent_run('timeout', 'Provider Said: No', null, null, null, null, null, null, null, null, null);
  perform pg_temp.as_owner();
  if (select error_code from ops.agent_runs where id = v_run) is not null then
    raise exception 'L3: a malformed error code was stored';
  end if;
end
$$;

-- L4. A run is started once: a second start by the same attempt changes nothing, even
--     with other facts, and never answers running, the one token that means "call".
do $$
declare
  v_run    uuid := pg_temp.leased_run('ar1d-l-start-twice', 'task_l', 'agent_a1');
  v_first  text;
  v_second text;
  v_state  jsonb;
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_first := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  v_state := pg_temp.run_state(v_run);
  perform pg_temp.as_worker();
  v_second := ops.start_agent_run('other', 'other-model', 'task_assessment.v9', repeat('e', 64));
  perform pg_temp.as_owner();
  if v_first is distinct from 'running' or v_second is distinct from 'already_running' or pg_temp.run_state(v_run) is distinct from v_state then
    raise exception 'L4: a second start changed a running run (returned %, then %)', v_first, v_second;
  end if;
  -- The attempt that started the run cannot claim it again: settling it there would
  -- discard a call that may still be in flight.
  perform pg_temp.as_worker();
  perform pg_temp.expect_refused_with('L4 a second claim by the attempt that started the run', '42501',
    'already started the run', $q$select ops.claim_agent_run()$q$);
  perform pg_temp.as_owner();
  if pg_temp.run_state(v_run) is distinct from v_state then
    raise exception 'L4: a refused second claim changed the running run';
  end if;
  if pg_temp.worker_completes() is distinct from 'succeeded' then
    raise exception 'L4: a run started once could not be completed';
  end if;
end
$$;

-- L5 and L6. Complete and fail need a running run; refuse fails a pending one as
--     configuration and changes nothing else.
do $$
declare
  v_run      uuid := pg_temp.leased_run('ar1d-l-pending', 'task_l', 'agent_a1');
  v_state    jsonb;
  v_complete text;
  v_fail     text;
  v_refused  text;
  v_again    text;
  r          ops.agent_runs;
begin
  v_state := pg_temp.run_state(v_run);
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_complete := ops.complete_agent_run(pg_temp.valid_result(), 'fake-model-1', 'completed', null, null, 1, 1, 2, 0, 0, 5);
  v_fail := ops.fail_agent_run('timeout', 'deadline', null, null, null, null, null, null, null, null, 5);
  perform pg_temp.as_owner();
  if v_complete is distinct from 'not_running' or v_fail is distinct from 'not_running'
     or pg_temp.run_state(v_run) is distinct from v_state then
    raise exception 'L5: complete or fail changed a pending run (returned %, %)', v_complete, v_fail;
  end if;

  perform pg_temp.as_worker();
  v_refused := ops.refuse_agent_run('no_route');
  v_again := ops.refuse_agent_run('another_code');
  perform pg_temp.as_owner();
  select * into r from ops.agent_runs where id = v_run;
  if v_refused is distinct from 'failed' or v_again is distinct from 'failed' or r.status <> 'failed'
     or r.error_category is distinct from 'configuration' or r.error_code is distinct from 'no_route'
     or r.started_at is not null or r.provider is not null or r.job_attempt is not null then
    raise exception 'L6: refuse did not fail a pending run as configuration, once (returned %, then %): %', v_refused, v_again, to_jsonb(r);
  end if;
  if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.failed'] then
    raise exception 'L6: a refused run recorded %', pg_temp.run_event_types(v_run);
  end if;

  v_run := pg_temp.leased_run('ar1d-l-refuse-odd-code', 'task_l', 'agent_a1');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  perform ops.refuse_agent_run('Not A Code');
  perform pg_temp.as_owner();
  if (select error_code from ops.agent_runs where id = v_run) is distinct from 'configuration' then
    raise exception 'L6: refuse stored a malformed code';
  end if;

  v_run := pg_temp.leased_run('ar1d-l-refuse-running', 'task_l', 'agent_a1');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  v_state := pg_temp.run_state(v_run);
  perform pg_temp.as_worker();
  v_refused := ops.refuse_agent_run('no_route');
  perform pg_temp.as_owner();
  if v_refused is distinct from 'running' or pg_temp.run_state(v_run) is distinct from v_state then
    raise exception 'L6: refuse changed a running run (returned %)', v_refused;
  end if;
  if pg_temp.worker_completes() is distinct from 'succeeded' then
    raise exception 'L6: a run refuse left alone could not be completed';
  end if;
end
$$;

-- L7. A run left running by an earlier attempt is settled indeterminate when a new
--     lease claims it, and is never running again.
do $$
declare
  v_run   uuid := pg_temp.leased_run('ar1d-l-interrupted', 'task_l', 'agent_a1', 'ar1d-worker-first');
  v_job   uuid;
  v_claim jsonb;
  v_state text;
  r       ops.agent_runs;
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  if v_state is distinct from 'running' then
    raise exception 'L7: the first attempt did not start the run (%); this case would prove nothing', v_state;
  end if;

  -- The first attempt dies: its lease expires, and a second attempt leases the job.
  v_job := pg_temp.job_of(v_run);
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;
  perform pg_temp.lease('L7', 'ar1d-worker-second', v_job);
  if (select j.attempts from ops.jobs j where j.id = v_job) is distinct from 2 then
    raise exception 'L7: the job was not re-leased as a second attempt; this case would prove nothing';
  end if;

  perform pg_temp.as_worker();
  begin
    v_claim := ops.claim_agent_run();
  exception when others then
    -- Only the attempt that started a run is refused a claim; an earlier attempt's run is settled.
    raise exception 'L7: the next attempt''s claim on a run an earlier attempt left running was refused (% %)', sqlstate, sqlerrm;
  end;
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  select * into r from ops.agent_runs where id = v_run;
  if v_claim ->> 'action' is distinct from 'settled' or v_claim ->> 'status' is distinct from 'indeterminate'
     or v_state is distinct from 'indeterminate' or r.status <> 'indeterminate'
     or r.error_category is distinct from 'interrupted' or r.error_code is distinct from 'execution_interrupted'
     or r.job_attempt is distinct from 1 then
    raise exception 'L7: a run left running by an earlier attempt was not settled indeterminate on its next claim (claim %, start %, run % / % / attempt %)',
      v_claim, v_state, r.status, r.error_category, r.job_attempt;
  end if;
  if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.started', 'agent_run.indeterminate'] then
    raise exception 'L7: an interrupted run recorded %', pg_temp.run_event_types(v_run);
  end if;
end
$$;

-- L7. A claim on a finished run reports it and changes nothing.
do $$
declare
  v_run   uuid := pg_temp.id('run_l_success');
  v_job   uuid := pg_temp.job_of(pg_temp.id('run_l_success'));
  v_state jsonb := pg_temp.run_state(pg_temp.id('run_l_success'));
  v_claim jsonb;
begin
  perform pg_temp.as_worker();
  if (ops.resume_lease('ar1d-worker', v_job)).id is null then
    raise exception 'L7: the finished run''s lease could not be resumed; this case would prove nothing';
  end if;
  v_claim := ops.claim_agent_run();
  perform pg_temp.as_owner();
  if v_claim ->> 'action' is distinct from 'settled' or v_claim ->> 'status' is distinct from 'succeeded'
     or pg_temp.run_state(v_run) is distinct from v_state then
    raise exception 'L7: a claim on a finished run did not leave it as it was (claim %)', v_claim;
  end if;
end
$$;

-- L8. A start with malformed facts is refused and leaves the run pending.
do $$
declare
  v_run uuid := pg_temp.leased_run('ar1d-l-malformed-start', 'task_l', 'agent_a1');
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  perform pg_temp.expect_refused('L8 a start naming a malformed provider', 'OS400',
    $q$select ops.start_agent_run('Fake Provider', 'fake-model-1', 'task_assessment.v1', repeat('f', 64))$q$);
  perform pg_temp.expect_refused('L8 a start naming a malformed model', 'OS400',
    $q$select ops.start_agent_run('fake', 'model with spaces', 'task_assessment.v1', repeat('f', 64))$q$);
  perform pg_temp.expect_refused('L8 a start naming a malformed prompt version', 'OS400',
    $q$select ops.start_agent_run('fake', 'fake-model-1', 'v1', repeat('f', 64))$q$);
  perform pg_temp.expect_refused('L8 a start naming a malformed input fingerprint', 'OS400',
    $q$select ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('F', 64))$q$);
  perform pg_temp.expect_refused('L8 a start naming no provider', 'OS400',
    $q$select ops.start_agent_run(null, 'fake-model-1', 'task_assessment.v1', repeat('f', 64))$q$);
  perform pg_temp.as_owner();
  if pg_temp.run_status(v_run) is distinct from 'pending'
     or (select started_at from ops.agent_runs where id = v_run) is not null then
    raise exception 'L8: a refused start left the run %', pg_temp.run_status(v_run);
  end if;
  perform pg_temp.as_worker();
  perform ops.refuse_agent_run('ar1d_cleanup');
  perform pg_temp.as_owner();
end
$$;

-- L9. Every gate is checked again at start, under lock.
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_case  record;
  v_run   uuid;
  v_state text;
  r       ops.agent_runs;
begin
  for v_case in
    select * from (values
      ('task_closed', 'task_l_closed', 'agent_a1'),
      ('task_reassigned', 'task_l_reassigned', 'agent_a1'),
      ('company_inactive', 'task_l_a2', 'agent_a2'),
      ('department_inactive', 'task_l_support', 'agent_a1_support'),
      ('agent_inactive', 'task_l_spare', 'agent_a1_spare')
    ) as c (code, task_key, agent_key)
  loop
    v_run := pg_temp.leased_run('ar1d-l-gate-' || v_case.code, v_case.task_key, v_case.agent_key);
    case v_case.code
      when 'task_closed' then
        perform ops.transition_task(ta, pg_temp.id(v_case.task_key), 'cancelled', 'ar1d-test');
      when 'task_reassigned' then
        perform ops.assign_task(ta, pg_temp.id(v_case.task_key), pg_temp.id('agent_a1_two'), 'ar1d-test');
      when 'company_inactive' then
        perform ops.set_company_status(ta, pg_temp.id('company_a2'), 'inactive', 'ar1d-test');
      when 'department_inactive' then
        perform ops.set_department_status(ta, pg_temp.id('dept_a1_support'), 'inactive', 'ar1d-test');
      when 'agent_inactive' then
        perform ops.set_agent_status(ta, pg_temp.id('agent_a1_spare'), 'inactive', 'ar1d-test');
    end case;

    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
    perform pg_temp.as_owner();

    perform ops.set_company_status(ta, pg_temp.id('company_a2'), 'active', 'ar1d-test');
    perform ops.set_department_status(ta, pg_temp.id('dept_a1_support'), 'active', 'ar1d-test');

    select * into r from ops.agent_runs where id = v_run;
    if v_state is distinct from 'cancelled' or r.status <> 'cancelled' or r.error_category is distinct from 'refused'
       or r.error_code is distinct from v_case.code or r.stop_id is not null or r.started_at is not null then
      raise exception 'L9: a run whose gate changed since the request (%) was not refused at start (returned %, run % / %)',
        v_case.code, v_state, r.status, r.error_code;
    end if;
  end loop;
end
$$;

-- ===========================================================================
-- M. THE STALE-RUN SWEEP. It takes no lease and serves every tenant, so it must
--    only ever settle work that is already dead.
-- ===========================================================================
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  tb constant uuid := pg_temp.id('tenant_b');
  v_expired    uuid;
  v_released   uuid;
  v_live       uuid;
  v_job_failed uuid;
  v_job_done   uuid;
  v_queued     uuid;
  v_job        uuid;
  v_state      text;
  v_settled    integer;
  v_again      integer;
  v_changed    text;
  v_expected   text;
  r            ops.agent_runs;
begin
  -- M2. Running, and its job was since leased again by a later attempt.
  v_released := pg_temp.leased_run('ar1d-m-released', 'task_m', 'agent_a1', 'ar1d-worker-m2');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  v_job := pg_temp.job_of(v_released);
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;
  perform pg_temp.lease('M2', 'ar1d-worker-m2-again', v_job);

  -- M3. Running under its own live lease.
  v_live := pg_temp.leased_run('ar1d-m-live', 'task_m', 'agent_a1', 'ar1d-worker-m3');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := v_state || ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();

  -- M4. Pending, and its job failed before any start.
  v_job_failed := pg_temp.leased_run('ar1d-m-job-failed', 'task_m', 'agent_a1', 'ar1d-worker-m4');
  v_job := pg_temp.job_of(v_job_failed); -- read as the owner: the worker cannot read runs
  perform pg_temp.as_worker();
  if ops.settle_job_failure(v_job, 'permanent', 'ar1d-test: handler refused') is distinct from 'failed' then
    raise exception 'M4: the fixture job could not be failed; this case would prove nothing';
  end if;
  perform pg_temp.as_owner();

  -- M4. Pending, and its job succeeded without ever starting the run.
  v_job_done := pg_temp.leased_run('ar1d-m-job-done', 'task_m', 'agent_a1', 'ar1d-worker-m5');
  v_job := pg_temp.job_of(v_job_done);
  perform pg_temp.as_worker();
  if ops.complete_job(v_job) is not true then
    raise exception 'M4: the fixture job could not be completed; this case would prove nothing';
  end if;
  perform pg_temp.as_owner();

  -- M6. Pending, with its job still queued.
  v_queued := pg_temp.request('ar1d-m-queued', 'tenant_a', 'task_m', 'agent_a1');

  -- M1. Running, and its lease expired. Last, so no later lease reaps it first.
  v_expired := pg_temp.leased_run('ar1d-m-expired', 'task_m', 'agent_a1', 'ar1d-worker-m1');
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := v_state || ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = pg_temp.job_of(v_expired);

  if v_state is distinct from 'runningrunningrunning' then
    raise exception 'M: a fixture run did not start (%); the sweep cases would prove nothing', v_state;
  end if;

  perform set_config('ar1d.m_before',
    (select jsonb_object_agg(x.id, x.status) from ops.agent_runs x where x.tenant_id in (ta, tb))::text, true);

  -- The sweep, as the worker, with no lease context at all.
  perform pg_temp.as_worker();
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  v_settled := ops.settle_stale_agent_runs();
  v_again := ops.settle_stale_agent_runs();
  perform pg_temp.as_owner();

  select * into r from ops.agent_runs where id = v_expired;
  if r.status <> 'indeterminate' or r.error_category is distinct from 'interrupted' or r.error_code is distinct from 'execution_interrupted' then
    raise exception 'M1: a running run whose lease expired was not settled indeterminate (% / %)', r.status, r.error_code;
  end if;
  select * into r from ops.agent_runs where id = v_released;
  if r.status <> 'indeterminate' or r.error_category is distinct from 'interrupted' then
    raise exception 'M2: a running run whose job was leased again by a later attempt was not settled indeterminate (%)', r.status;
  end if;
  if pg_temp.run_status(v_live) is distinct from 'running' then
    raise exception 'M3: the sweep settled a run under its own live lease (%)', pg_temp.run_status(v_live);
  end if;
  select * into r from ops.agent_runs where id = v_job_failed;
  if r.status <> 'failed' or r.error_category is distinct from 'job_failed' or r.error_code is distinct from 'job_failed' then
    raise exception 'M4: a pending run whose job failed was not settled failed (% / % / %)', r.status, r.error_category, r.error_code;
  end if;
  select * into r from ops.agent_runs where id = v_job_done;
  if r.status <> 'failed' or r.error_category is distinct from 'job_failed' or r.error_code is distinct from 'job_ended_before_start' then
    raise exception 'M4: a pending run whose job ended before its start was not settled failed (% / % / %)', r.status, r.error_category, r.error_code;
  end if;
  if pg_temp.run_status(v_queued) is distinct from 'pending' then
    raise exception 'M6: the sweep settled a pending run whose job is still queued (%)', pg_temp.run_status(v_queued);
  end if;
  if v_again <> 0 then
    raise exception 'M5: a second sweep settled % more run(s)', v_again;
  end if;
  if v_settled < 4 then
    raise exception 'M5: the first sweep reported % settlements for 4 dead runs', v_settled;
  end if;

  -- M7. Exactly the dead runs changed, among every run this suite created.
  select string_agg(s.key, ',' order by s.key) into v_changed
    from jsonb_each_text(current_setting('ar1d.m_before')::jsonb) as s
   where pg_temp.run_status(s.key::uuid) is distinct from s.value;
  select string_agg(x::text, ',' order by x::text) into v_expected
    from unnest(array[v_expired, v_released, v_job_failed, v_job_done]) as x;
  if v_changed is distinct from v_expected then
    raise exception 'M7: the sweep changed runs %, expected exactly %', v_changed, v_expected;
  end if;
  if pg_temp.run_event_types(v_expired) is distinct from array['agent_run.requested', 'agent_run.started', 'agent_run.indeterminate']
     or pg_temp.run_event_types(v_job_failed) is distinct from array['agent_run.requested', 'agent_run.failed'] then
    raise exception 'M7: a swept run did not record exactly its settlement';
  end if;
end
$$;

-- ===========================================================================
-- N. THE ADVERSARIAL-REVIEW REVISION (v2), CASE BY CASE. Each label names the
--    revision it pins, and each case goes red if that revision is reverted:
--      N1  a lease that ends on the wall clock during the transaction is not live
--      N3  start settles a run ANOTHER attempt started, and never answers running
--      N4  complete and fail belong only to the attempt that started the run
--      N5  error codes only the database records are never taken from a worker
--      N6  the sweep judges a lease on the wall clock
--      N7  the kill-switch lock (N7a-N7e run before section C, see there), and a
--          trip that recorded nothing and found nothing refuses
--      N8  the execution request is caused by the run's own request fact only
--      N9  the bridge stores the canonical payload
--      N10 a switch that row security would hide refuses instead of reading "no stop"
--      N11 a stop is only cleared, or its free text redacted to the exact marker
--      N12 an active stop is never deleted or truncated, in replica mode too
--      N13 a run succeeds only in contract, and names only an active stop covering it
--      N14 lifecycle causation ignores business facts; the outcome is copied only
--          when it is a contract value
--    Revision 2 (claim refuses the attempt that started the run, and settles only an
--    earlier attempt's run) is L4 and L7. One connection cannot prove what needs a
--    second one, which belongs to the driver-backed suite: the reaper and the sweep
--    SKIPPING a job a capability holds, a trip WAITING for a start in flight and a
--    start waiting for a trip, and the lock-free reads that keep a doomed retry or
--    bridge request from waiting on, or deadlocking with, a worker.
-- ===========================================================================
do $$
begin
  perform pg_temp.assigned_task('task_n', 'tenant_a', 'company_a1', 'agent_a1');
  if ops.active_execution_stop(pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1'),
                               pg_temp.id('agent_a1')) is not null then
    raise exception 'N: an earlier section left a stop active over the fixture agent; the cases below would prove nothing';
  end if;
end
$$;

-- N1. A lease that runs out DURING the transaction is not live. ops.current_tenant_id()
--     judges expiry by now(), the transaction's start, so it still resolves the tenant:
--     only the capabilities' own wall-clock check can refuse. Each capability is asked
--     on its own, so losing the check from any one of them goes red.
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  v_run uuid;
begin
  v_run := pg_temp.leased_run('ar1d-n1-pending', 'task_n', 'agent_a1', 'ar1d-worker-n1-pending');
  perform pg_temp.as_worker();
  if ops.claim_agent_run() ->> 'action' is distinct from 'start' then
    raise exception 'N1: the claim on the live lease did not offer the run; this case would prove nothing';
  end if;
  perform pg_temp.as_owner();
  perform pg_temp.expire_on_clock(pg_temp.job_of(v_run));
  perform pg_temp.as_worker();
  if ops.current_tenant_id() is distinct from ta then
    raise exception 'N1: the lease is not live by the transaction clock, so a refusal below would not be the wall-clock check';
  end if;
  perform pg_temp.expect_refused_with('N1a: claim on a lease that ran out during the transaction', '42501',
    'no longer live', 'select ops.claim_agent_run()');
  perform pg_temp.expect_refused_with('N1b: start on a lease that ran out during the transaction', '42501',
    'no longer live', $q$select ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64))$q$);
  perform pg_temp.expect_refused_with('N1e: refuse on a lease that ran out during the transaction', '42501',
    'no longer live', $q$select ops.refuse_agent_run('no_route')$q$);
  perform pg_temp.as_owner();

  v_run := pg_temp.leased_run('ar1d-n1-running', 'task_n', 'agent_a1', 'ar1d-worker-n1-running');
  perform pg_temp.remember('run_n1_running', v_run);
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  if ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64)) is distinct from 'running' then
    raise exception 'N1: the start on the live lease did not start the run; this case would prove nothing';
  end if;
  perform pg_temp.as_owner();
  perform pg_temp.expire_on_clock(pg_temp.job_of(v_run));
  perform pg_temp.as_worker();
  if ops.current_tenant_id() is distinct from ta then
    raise exception 'N1: the lease is not live by the transaction clock, so a refusal below would not be the wall-clock check';
  end if;
  perform pg_temp.expect_refused_with('N1c: complete on a lease that ran out during the call', '42501', 'no longer live',
    (select c.statement from pg_temp.capability_calls() c where c.capability = 'complete_agent_run'));
  perform pg_temp.expect_refused_with('N1d: fail on a lease that ran out during the call', '42501', 'no longer live',
    (select c.statement from pg_temp.capability_calls() c where c.capability = 'fail_agent_run'));
  perform pg_temp.as_owner();
end
$$;

-- N3. A later attempt's start, with no claim before it, on a run an earlier attempt
--     started: settled indeterminate, the earlier start's facts untouched, and never the
--     token running. (L7 reaches the same run through claim; L4 is the same attempt.)
do $$
declare
  v_run   uuid := pg_temp.leased_run('ar1d-n3', 'task_n', 'agent_a1', 'ar1d-worker-n3-first');
  v_job   uuid;
  v_state text;
  r       ops.agent_runs;
begin
  v_job := pg_temp.job_of(v_run);
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;
  perform pg_temp.lease('N3', 'ar1d-worker-n3-second', v_job);
  if v_state is distinct from 'running' or (select j.attempts from ops.jobs j where j.id = v_job) is distinct from 2 then
    raise exception 'N3: the first attempt did not start the run, or the job was not re-leased as a second attempt; this case would prove nothing';
  end if;

  perform pg_temp.as_worker();
  v_state := ops.start_agent_run('other', 'other-model', 'task_assessment.v9', repeat('e', 64));
  perform pg_temp.as_owner();
  select * into r from ops.agent_runs where id = v_run;
  if v_state is distinct from 'indeterminate' then
    raise exception 'N3a: a later attempt''s start on a run an earlier attempt started returned %, not indeterminate', v_state;
  end if;
  if r.status <> 'indeterminate' or r.error_category is distinct from 'interrupted'
     or r.error_code is distinct from 'execution_interrupted' then
    raise exception 'N3b: a run another attempt started was not settled indeterminate by a later start (% / % / %)',
      r.status, r.error_category, r.error_code;
  end if;
  if r.job_attempt is distinct from 1 or r.provider is distinct from 'fake' or r.model is distinct from 'fake-model-1'
     or r.prompt_version is distinct from 'task_assessment.v1' or r.input_fingerprint is distinct from repeat('f', 64) then
    raise exception 'N3c: a later attempt''s start rewrote what the first attempt started: %', to_jsonb(r);
  end if;
  if pg_temp.run_event_types(v_run) is distinct from array['agent_run.requested', 'agent_run.started', 'agent_run.indeterminate'] then
    raise exception 'N3d: a run settled by a later start recorded %', pg_temp.run_event_types(v_run);
  end if;
end
$$;

-- N4. Complete and fail by a LATER attempt, with no claim before them, on a run an
--     earlier attempt started: not_running, and nothing changes. (L5 is a pending run.)
do $$
declare
  v_run    uuid := pg_temp.leased_run('ar1d-n4', 'task_n', 'agent_a1', 'ar1d-worker-n4-first');
  v_job    uuid;
  v_state  text;
  v_before jsonb;
begin
  v_job := pg_temp.job_of(v_run);
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;
  perform pg_temp.lease('N4', 'ar1d-worker-n4-second', v_job);
  if v_state is distinct from 'running' or (select j.attempts from ops.jobs j where j.id = v_job) is distinct from 2 then
    raise exception 'N4: the first attempt did not start the run, or the job was not re-leased as a second attempt; this case would prove nothing';
  end if;
  v_before := pg_temp.run_state(v_run);

  perform pg_temp.as_worker();
  v_state := ops.complete_agent_run(pg_temp.valid_result(), 'fake-model-2', 'completed', 'fake-req-2', 'fake-resp-2',
                                    9, 9, 18, 0, 0, 9);
  perform pg_temp.as_owner();
  if v_state is distinct from 'not_running' or pg_temp.run_state(v_run) is distinct from v_before then
    raise exception 'N4a: a later attempt''s complete settled a run an earlier attempt started (returned %)', v_state;
  end if;

  perform pg_temp.as_worker();
  v_state := ops.fail_agent_run('provider_5xx', 'upstream', 'fake-model-2', null, null, 9, 0, 9, 0, 0, 9);
  perform pg_temp.as_owner();
  if v_state is distinct from 'not_running' or pg_temp.run_state(v_run) is distinct from v_before then
    raise exception 'N4b: a later attempt''s fail settled a run an earlier attempt started (returned %)', v_state;
  end if;
end
$$;

-- N5. Error codes only the database records are never taken from a worker: fail drops
--     them, refuse replaces them with configuration, and neither raises. The oracle is
--     the literal list, never the database's helper.
do $$
declare
  c_reserved constant text[] := array['execution_stopped', 'execution_interrupted', 'database_contract',
                                      'job_failed', 'job_ended_before_start'];
  -- Not reserved: it only begins like a reserved code, so it is kept.
  c_lookalike constant text := 'execution_stopped_upstream';
  v_code text;
  v_n    integer := 0;
  v_run  uuid;
  v_err  text;
  r      ops.agent_runs;
begin
  if (select array_agg(c order by c) from unnest(ops.agent_run_reserved_error_codes()) as c)
     is distinct from (select array_agg(c order by c) from unnest(c_reserved) as c) then
    raise exception 'N5a: ops.agent_run_reserved_error_codes() is not the reviewed set: %', ops.agent_run_reserved_error_codes();
  end if;

  foreach v_code in array c_reserved || c_lookalike loop
    v_n := v_n + 1;

    v_run := pg_temp.leased_run(format('ar1d-n5-fail-%s', v_n), 'task_n', 'agent_a1');
    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    perform ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
    v_err := pg_temp.attempt(format(
      'select ops.fail_agent_run(''timeout'', %L, null, null, null, null, null, null, null, null, 5)', v_code));
    perform pg_temp.as_owner();
    select * into r from ops.agent_runs where id = v_run;
    if v_code = any (c_reserved) then
      if v_err is not null or r.status is distinct from 'indeterminate' or r.error_category is distinct from 'timeout'
         or r.error_code is not null then
        raise exception 'N5b: fail_agent_run did not record the failure with the reserved code % dropped (error %, run % / % / code %)',
          v_code, coalesce(v_err, 'none'), r.status, r.error_category, r.error_code;
      end if;
    elsif v_err is not null or r.error_code is distinct from v_code then
      raise exception 'N5d: fail_agent_run did not keep %, which only begins like a reserved code (error %, code %)',
        v_code, coalesce(v_err, 'none'), r.error_code;
    end if;

    v_run := pg_temp.leased_run(format('ar1d-n5-refuse-%s', v_n), 'task_n', 'agent_a1');
    perform pg_temp.as_worker();
    perform ops.claim_agent_run();
    v_err := pg_temp.attempt(format('select ops.refuse_agent_run(%L)', v_code));
    perform pg_temp.as_owner();
    select * into r from ops.agent_runs where id = v_run;
    if v_code = any (c_reserved) then
      if v_err is not null or r.status is distinct from 'failed' or r.error_category is distinct from 'configuration'
         or r.error_code is distinct from 'configuration' then
        raise exception 'N5c: refuse_agent_run did not replace the reserved code % with configuration (error %, run % / % / code %)',
          v_code, coalesce(v_err, 'none'), r.status, r.error_category, r.error_code;
      end if;
    elsif v_err is not null or r.error_code is distinct from v_code then
      raise exception 'N5d: refuse_agent_run did not keep %, which only begins like a reserved code (error %, code %)',
        v_code, coalesce(v_err, 'none'), r.error_code;
    end if;
  end loop;
end
$$;

-- N6. The sweep judges a lease on the wall clock. The N1 run's lease is live by now(),
--     the transaction's start, and ran out on the clock, so a sweep reading now() would
--     leave it running. A run whose lease is live on the clock stays running.
do $$
declare
  v_run  uuid := pg_temp.id('run_n1_running');
  v_live uuid := pg_temp.leased_run('ar1d-n6-live', 'task_n', 'agent_a1', 'ar1d-worker-n6');
  j      ops.jobs;
  r      ops.agent_runs;
begin
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  if ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64)) is distinct from 'running' then
    raise exception 'N6: the control run did not start; this case would prove nothing';
  end if;
  perform pg_temp.as_owner();
  select * into r from ops.agent_runs where id = v_run;
  select * into j from ops.jobs where id = r.job_id;
  if r.status is distinct from 'running' or j.status is distinct from 'leased' or j.attempts is distinct from r.job_attempt
     or not (j.lease_expires_at > now()) or not (j.lease_expires_at < clock_timestamp()) then
    raise exception 'N6: the fixture run is not running under a lease live by now() that ended on the clock; this case would prove nothing';
  end if;

  perform pg_temp.as_worker();
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  perform ops.settle_stale_agent_runs();
  perform pg_temp.as_owner();

  select * into r from ops.agent_runs where id = v_run;
  if r.status is distinct from 'indeterminate' or r.error_category is distinct from 'interrupted' then
    raise exception 'N6a: the sweep left a run whose lease ran out on the wall clock % (it judged the lease by the transaction clock)', r.status;
  end if;
  if pg_temp.run_status(v_live) is distinct from 'running' then
    raise exception 'N6b: the sweep settled a run whose lease is live on the wall clock (%)', pg_temp.run_status(v_live);
  end if;
end
$$;

-- N7f. A trip that records nothing and finds nothing refuses; it never returns NULL as
--      if something were tripped. The race that reaches this (a clear committing between
--      the insert and its fallback read) needs two connections; a trigger that swallows
--      the insert reaches the same branch here.
create function pg_temp.skip_stop_insert()
returns trigger
language plpgsql
as $f$ begin return null; end $f$;

do $$
declare
  v_id  uuid;
  v_err text;
begin
  if exists (select 1 from ops.execution_stops s where s.scope = 'global' and s.cleared_at is null) then
    raise exception 'N7f: an active global stop exists, so the fallback read would find it; this case would prove nothing';
  end if;
  begin
    create trigger ar1d_skip_stop_insert before insert on ops.execution_stops
      for each row execute function pg_temp.skip_stop_insert();
    v_id := ops.trip_execution_stop('global', 'ar1d-test: recorded nowhere', 'ar1d-owner');
    raise exception using errcode = 'C1CAC', message = 'accepted';
  exception
    when sqlstate 'C1CAC' then v_err := 'accepted';
    when others then v_err := sqlstate || ' ' || sqlerrm;
  end;
  if v_err = 'accepted' then
    raise exception 'N7f: a trip that recorded nothing and found nothing returned % instead of refusing', coalesce(v_id::text, 'NULL');
  end if;
  if v_err not like 'OS409 %nothing was tripped%' then
    raise exception 'N7f: a trip that recorded nothing was refused for another reason (%)', v_err;
  end if;
end
$$;

-- N8. The bridge's task.execution_requested fact is caused by the run's own
--     agent_run.requested fact, even when a business fact about the run (allowed, I7)
--     is the latest fact about it when the bridge looks. A trigger records three right
--     after the request fact, inside the request; the last two are typed next to the
--     lifecycle namespace (a plural, and a LIKE wildcard where the underscore is), so a
--     prefix or LIKE filter is caught as well as no filter.
create function pg_temp.record_business_fact()
returns trigger
language plpgsql
as $f$
declare
  v_type text;
begin
  foreach v_type in array array['review.noted', 'agent_runs.requested', 'agentxrun.requested'] loop
    perform ops.record_event(new.tenant_id, new.company_id, v_type, 'ar1d-record', 'agent_run', new.id);
  end loop;
  return null;
end
$f$;

do $$
declare
  v_run       uuid;
  v_requested ops.events;
  v_fact      ops.events;
  v_exec      ops.events;
begin
  begin
    create trigger zz_ar1d_business_fact after insert on ops.agent_runs
      for each row execute function pg_temp.record_business_fact();
    v_run := pg_temp.request('ar1d-n8', 'tenant_a', 'task_n', 'agent_a1');
    select * into v_requested from ops.events e where e.subject_id = v_run and e.type = 'agent_run.requested';
    select * into v_fact from ops.events e where e.subject_id = v_run and e.type = 'agentxrun.requested';
    select * into v_exec from ops.events e
     where e.type = 'task.execution_requested' and e.payload ->> 'job_id' = pg_temp.job_of(v_run)::text;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_requested.id is null or v_fact.id is null or v_exec.id is null or v_fact.seq <= v_requested.seq then
    raise exception 'N8a: no business fact about the run was the latest fact before the bridge; this case would prove nothing';
  end if;
  if v_exec.causation_id is distinct from v_requested.id then
    raise exception 'N8a: task.execution_requested was caused by % (the business fact is %), not by the run''s agent_run.requested fact %',
      v_exec.causation_id, v_fact.id, v_requested.id;
  end if;
end
$$;

-- N9. The bridge stores the canonical payload, whatever case the caller wrote the id
--     in, and refuses every other spelling of it.
do $$
declare
  ta   constant uuid := pg_temp.id('tenant_a');
  v_run   uuid := pg_temp.raw_run_in('pending', 'task_n');
  v_other uuid := pg_temp.raw_run_in('pending', 'task_n');
  v_job   uuid;
  v_payload text;
  v_text  text;
begin
  if upper(v_run::text) = v_run::text then
    raise exception 'N9a: the fixture id has no letters to upper-case; this case would prove nothing';
  end if;
  v_job := ops.request_task_execution(ta, pg_temp.id('task_n'), 'agent_run.execute', 'ar1d-bridge',
                                      jsonb_build_object('agent_run_id', upper(v_run::text)));
  select j.payload::text into v_payload from ops.jobs j where j.id = v_job;
  if v_payload is distinct from format('{"agent_run_id": "%s"}', v_run) then
    raise exception 'N9a: the bridge stored % for a run named in upper case, not the canonical payload', v_payload;
  end if;
  if pg_temp.job_of(v_run) is distinct from v_job then
    raise exception 'N9a: the bridge did not link the run it was named in upper case';
  end if;

  foreach v_text in array array[' ' || v_other, v_other || ' ', '{' || v_other || '}', v_other || E'\n',
                                replace(v_other::text, '-', '')] loop
    perform pg_temp.expect_refused_with(format('N9b: an agent run job naming %L', v_text), 'OS400', 'exactly one field',
      format($q$select ops.request_task_execution(%L, %L, 'agent_run.execute', 'ar1d-bridge', jsonb_build_object('agent_run_id', %L::text))$q$,
             ta, pg_temp.id('task_n'), v_text));
  end loop;
end
$$;

-- N10. A switch that row security would hide refuses. A role without BYPASSRLS that
--      holds SELECT on the stops sees none of them (FORCE, no policy), so without the
--      check it would read an active stop as "no stop". Everything the probe needs is
--      created and granted inside a rolled-back subtransaction; no migration grants it.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_stop    uuid;
  v_read    uuid;
  v_rls     boolean;
  v_rows    bigint;
  v_reached boolean := false;
  v_err     text;
begin
  v_stop := ops.trip_execution_stop('tenant', 'ar1d-test: N10 unreadable switch', 'ar1d-owner', ta);
  if ops.active_execution_stop(ta, ca1, da1, ga1) is distinct from v_stop then
    raise exception 'N10: the owner does not read the active stop; this case would prove nothing';
  end if;
  begin
    create role ar1d_probe_rls nologin nobypassrls;
    execute format('grant ar1d_probe_rls to %I', current_user);
    grant usage on schema ops to ar1d_probe_rls;
    grant select on ops.execution_stops to ar1d_probe_rls;
    grant execute on function ops.active_execution_stop(uuid, uuid, uuid, uuid) to ar1d_probe_rls;
    execute 'set local role ar1d_probe_rls';
    v_rls := row_security_active('ops.execution_stops');
    select count(*) into v_rows from ops.execution_stops;
    begin
      v_read := ops.active_execution_stop(ta, ca1, da1, ga1);
      v_reached := true;
    exception when others then
      v_err := sqlstate || ' ' || sqlerrm;
    end;
    execute 'reset role';
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  perform ops.clear_execution_stop(v_stop, 'ar1d-test: N10 cleared', 'ar1d-owner');
  if exists (select 1 from pg_roles where rolname = 'ar1d_probe_rls') then
    raise exception 'N10: the probe role outlived its subtransaction';
  end if;
  if v_rls is not true or v_rows is distinct from 0 then
    raise exception 'N10: row security does not hide the stops from the probe role (active %, rows %); this case would prove nothing', v_rls, v_rows;
  end if;
  if v_reached then
    raise exception 'N10a: a caller for whom row security hides the stops read the switch as %, not a refusal', coalesce(v_read::text, 'no stop');
  end if;
  if v_err not like 'OS403 %' then
    raise exception 'N10a: the hidden switch was refused for another reason (%)', v_err;
  end if;
end
$$;

-- N11. A stop changes in exactly two ways: it is cleared once, or its free text is
--      replaced by the exact marker [redacted]. Everything else is refused, whether the
--      stop is active or cleared.
select pg_temp.remember('stop_n11_cleared', ops.trip_execution_stop('agent', 'ar1d-test: N11 cleared stop', 'ar1d-owner',
  pg_temp.id('tenant_a'), pg_temp.id('company_a1'), null, pg_temp.id('agent_a1_idle')));
select ops.clear_execution_stop(pg_temp.id('stop_n11_cleared'), 'ar1d-test: N11 cleared', 'ar1d-owner');
select pg_temp.remember('stop_n11_active', ops.trip_execution_stop('agent', 'ar1d-test: N11 active stop', 'ar1d-owner',
  pg_temp.id('tenant_a'), pg_temp.id('company_a1'), null, pg_temp.id('agent_a1_idle')));

do $$
declare
  s_active  constant uuid := pg_temp.id('stop_n11_active');
  s_cleared constant uuid := pg_temp.id('stop_n11_cleared');
  v_case    record;
  v_stop    record;
  v_text    text;
  v_before  jsonb;
  v_after   jsonb;
  v_err     text;
begin
  if s_active = s_cleared
     or (select s.cleared_at from ops.execution_stops s where s.id = s_active) is not null
     or (select s.cleared_at from ops.execution_stops s where s.id = s_cleared) is null then
    raise exception 'N11: the fixtures are not one active and one cleared stop; the cases below would prove nothing';
  end if;

  -- N11e. What a stop targets, and who tripped it when, is fixed.
  for v_stop in select * from (values ('active', s_active), ('cleared', s_cleared)) as s (kind, id) loop
    for v_case in
      select * from (values
        ('id', 'id = gen_random_uuid()'),
        ('scope', 'scope = ''tenant'', company_id = null, agent_id = null'),
        ('tenant_id', format('tenant_id = %L', pg_temp.id('tenant_b'))),
        ('company_id', format('company_id = %L', pg_temp.id('company_a2'))),
        ('department_id', format('department_id = %L', pg_temp.id('dept_a1'))),
        ('agent_id', format('agent_id = %L', pg_temp.id('agent_a1_two'))),
        ('tripped_by', 'tripped_by = ''someone-else'''),
        ('tripped_at', 'tripped_at = tripped_at - interval ''1 day''')
      ) as c (column_name, assignment)
    loop
      perform pg_temp.expect_refused_with(format('N11e: rewriting %s of an %s stop', v_case.column_name, v_stop.kind),
        'OS409', 'never rewritten', format('update ops.execution_stops set %s where id = %L', v_case.assignment, v_stop.id));
      -- A redaction or a clearing in the same update is not a way past the rule.
      perform pg_temp.expect_refused_with(format('N11e: rewriting %s of an %s stop while redacting its reason', v_case.column_name, v_stop.kind),
        'OS409', 'never rewritten',
        format('update ops.execution_stops set %s, reason = ''[redacted]'' where id = %L', v_case.assignment, v_stop.id));
      if v_stop.kind = 'cleared' then
        perform pg_temp.expect_refused_with(format('N11e: rewriting %s of a cleared stop while redacting its clearing reason', v_case.column_name),
          'OS409', 'never rewritten',
          format('update ops.execution_stops set %s, cleared_reason = ''[redacted]'' where id = %L', v_case.assignment, v_stop.id));
      else
        perform pg_temp.expect_refused_with(format('N11e: rewriting %s of an active stop while clearing it', v_case.column_name),
          'OS409', 'never rewritten',
          format($q$update ops.execution_stops set %s, cleared_by = 'ar1d-owner', cleared_reason = 'ar1d-test: cleared' where id = %L$q$,
                 v_case.assignment, v_stop.id));
      end if;
    end loop;
  end loop;

  -- N11f. Free text is replaced only by the exact marker, never by anything near it.
  foreach v_text in array array['[REDACTED]', '[redacted] ', ' [redacted]', 'redacted', '[redacted].', 'ar1d-test: reworded'] loop
    perform pg_temp.expect_refused_with(format('N11f: replacing an active stop''s reason with %L', v_text), 'OS409',
      'only replaced by [redacted]', format('update ops.execution_stops set reason = %L where id = %L', v_text, s_active));
    perform pg_temp.expect_refused_with(format('N11f: replacing a cleared stop''s reason with %L', v_text), 'OS409',
      'only replaced by [redacted]', format('update ops.execution_stops set reason = %L where id = %L', v_text, s_cleared));
    perform pg_temp.expect_refused_with(format('N11f: replacing a cleared stop''s clearing reason with %L', v_text), 'OS409',
      'only replaced by [redacted]', format('update ops.execution_stops set cleared_reason = %L where id = %L', v_text, s_cleared));
  end loop;

  -- N11k. A no-op is not one of the two changes either.
  perform pg_temp.expect_refused_with('N11k: a no-op update of an active stop', 'OS409', 'the only updates',
    format('update ops.execution_stops set reason = reason where id = %L', s_active));
  perform pg_temp.expect_refused_with('N11k: a no-op update of a cleared stop', 'OS409', 'the only updates',
    format('update ops.execution_stops set cleared_reason = cleared_reason where id = %L', s_cleared));

  -- N11i. Clearing does not also rewrite, or redact, why the stop was tripped.
  perform pg_temp.expect_refused_with('N11i: clearing a stop while redacting its reason', 'OS409', 'does not rewrite why',
    format($q$update ops.execution_stops set cleared_by = 'ar1d-owner', cleared_reason = 'ar1d-test: cleared', reason = '[redacted]' where id = %L$q$, s_active));

  -- N11h. The marker cannot fake half a clearing on an active stop: the guard lets a
  --       redaction through, and the table's clearing CHECK refuses it.
  perform pg_temp.expect_refused('N11h: the marker written as the clearing reason of an active stop', '23514',
    format('update ops.execution_stops set cleared_reason = ''[redacted]'' where id = %L', s_active));

  -- N11j. A cleared stop's clearing is history.
  for v_case in
    select * from (values
      ('cleared_by', 'cleared_by = ''someone-else'''),
      ('cleared_at', 'cleared_at = cleared_at - interval ''1 day'''),
      ('the whole clearing', 'cleared_by = null, cleared_reason = null, cleared_at = null')
    ) as c (column_name, assignment)
  loop
    perform pg_temp.expect_refused_with(format('N11j: rewriting %s of a cleared stop', v_case.column_name), 'OS409',
      'cleared once', format('update ops.execution_stops set %s where id = %L', v_case.assignment, s_cleared));
  end loop;
  -- The same, with a redaction in the same update: redacting is not a way past the rule.
  foreach v_text in array array[
      'cleared_by = ''someone-else'', reason = ''[redacted]''',
      'cleared_by = ''someone-else'', cleared_reason = ''[redacted]''',
      'cleared_at = cleared_at - interval ''1 day'', reason = ''[redacted]''',
      'cleared_at = cleared_at - interval ''1 day'', cleared_reason = ''[redacted]''',
      'cleared_by = null, cleared_reason = null, cleared_at = null, reason = ''[redacted]'''] loop
    perform pg_temp.expect_refused_with(format('N11j: rewriting a cleared stop''s clearing while redacting (%s)', v_text), 'OS409',
      'cleared once', format('update ops.execution_stops set %s where id = %L', v_text, s_cleared));
  end loop;

  -- N11a. Redacting an active stop's reason is accepted, changes nothing else, and the
  --       stop still refuses the runs it covers.
  v_before := (select to_jsonb(s) from ops.execution_stops s where s.id = s_active);
  v_err := pg_temp.attempt(format('update ops.execution_stops set reason = ''[redacted]'' where id = %L', s_active));
  v_after := (select to_jsonb(s) from ops.execution_stops s where s.id = s_active);
  if v_err is not null or v_after ->> 'reason' is distinct from '[redacted]' or (v_after - 'reason') is distinct from (v_before - 'reason') then
    raise exception 'N11a: redacting an active stop''s reason was refused or changed more than the reason (%)', coalesce(v_err, v_after::text);
  end if;
  if ops.active_execution_stop(pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a1'),
                               pg_temp.id('agent_a1_idle')) is distinct from s_active then
    raise exception 'N11a: a redacted stop no longer refuses the runs it covers';
  end if;

  -- N11b and N11c. Redacting a cleared stop's reason, then its clearing reason.
  v_before := (select to_jsonb(s) from ops.execution_stops s where s.id = s_cleared);
  v_err := pg_temp.attempt(format('update ops.execution_stops set reason = ''[redacted]'' where id = %L', s_cleared));
  v_after := (select to_jsonb(s) from ops.execution_stops s where s.id = s_cleared);
  if v_err is not null or v_after ->> 'reason' is distinct from '[redacted]' or (v_after - 'reason') is distinct from (v_before - 'reason') then
    raise exception 'N11b: redacting a cleared stop''s reason was refused or changed more than the reason (%)', coalesce(v_err, v_after::text);
  end if;
  v_before := v_after;
  v_err := pg_temp.attempt(format('update ops.execution_stops set cleared_reason = ''[redacted]'' where id = %L', s_cleared));
  v_after := (select to_jsonb(s) from ops.execution_stops s where s.id = s_cleared);
  if v_err is not null or v_after ->> 'cleared_reason' is distinct from '[redacted]'
     or (v_after - 'cleared_reason') is distinct from (v_before - 'cleared_reason') then
    raise exception 'N11c: redacting a cleared stop''s clearing reason was refused or changed more than it (%)', coalesce(v_err, v_after::text);
  end if;

  -- N11g. A redaction is never undone.
  perform pg_temp.expect_refused_with('N11g: restoring an active stop''s redacted reason', 'OS409', 'only replaced by [redacted]',
    format('update ops.execution_stops set reason = ''ar1d-test: restored'' where id = %L', s_active));
  perform pg_temp.expect_refused_with('N11g: restoring a cleared stop''s redacted clearing reason', 'OS409', 'only replaced by [redacted]',
    format('update ops.execution_stops set cleared_reason = ''ar1d-test: restored'' where id = %L', s_cleared));
end
$$;

-- N12. An active stop is the switch itself: never deleted, never truncated, in replica
--      mode too. A cleared stop can be erased once no run names it.
do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  s_active constant uuid := pg_temp.id('stop_n11_active');
  v_referenced uuid;
  v_free uuid;
  v_err  text;
begin
  perform pg_temp.expect_refused_with('N12a: deleting an active stop', 'OS409', 'is active',
    format('delete from ops.execution_stops where id = %L', s_active));

  select r.stop_id into v_referenced
    from ops.agent_runs r join ops.execution_stops s on s.id = r.stop_id
   where r.tenant_id = ta and s.cleared_at is not null
   limit 1;
  if v_referenced is null then
    raise exception 'N12c: no cleared stop is named by a run; this case would prove nothing';
  end if;
  perform pg_temp.expect_refused('N12c: deleting a cleared stop a run still names', '23503',
    format('delete from ops.execution_stops where id = %L', v_referenced));

  v_free := ops.trip_execution_stop('agent', 'ar1d-test: N12 erasable', 'ar1d-owner',
                                    ta, pg_temp.id('company_a1'), null, pg_temp.id('agent_a1_spare'));
  perform ops.clear_execution_stop(v_free, 'ar1d-test: N12 cleared', 'ar1d-owner');
  v_err := pg_temp.attempt(format('delete from ops.execution_stops where id = %L', v_free));
  if v_err is not null or exists (select 1 from ops.execution_stops s where s.id = v_free) then
    raise exception 'N12d: a cleared stop no run names could not be erased (%)', coalesce(v_err, 'still present');
  end if;

  -- CASCADE: without it the foreign key from ops.agent_runs refuses first (0A000),
  -- before any TRUNCATE trigger fires, and the case would prove nothing about the trigger.
  perform pg_temp.expect_refused_with('N12e: truncating the stops', 'OS409', 'never truncated',
    'truncate ops.execution_stops cascade');
end
$$;

set local session_replication_role = replica;
do $$
begin
  perform pg_temp.expect_refused_with('N12b: deleting an active stop in replica mode', 'OS409', 'is active',
    format('delete from ops.execution_stops where id = %L', pg_temp.id('stop_n11_active')));
  perform pg_temp.expect_refused_with('N12f: truncating the stops in replica mode', 'OS409', 'never truncated',
    'truncate ops.execution_stops cascade');
  -- The free-text rule holds in replica mode as well (H6 probes only a fixed column).
  perform pg_temp.expect_refused_with('N11f: rewriting a stop''s reason in replica mode', 'OS409', 'only replaced by [redacted]',
    format('update ops.execution_stops set reason = ''ar1d-test: rewritten in replica mode'' where id = %L', pg_temp.id('stop_n11_active')));
end
$$;
set local session_replication_role = origin;
select ops.clear_execution_stop(pg_temp.id('stop_n11_active'), 'ar1d-test: N11 cleared', 'ar1d-owner');

-- N13. The update guard, on a raw owner UPDATE whose transition is otherwise legal: a run
--      succeeds only with a contract-valid result, and names only an ACTIVE stop that
--      COVERS it.
select set_config('app.event_source', 'ar1d-raw', true);
do $$
declare
  v_run  uuid := pg_temp.raw_run_in('running', 'task_n');
  v_case record;
  v_err  text;
begin
  for v_case in
    select * from (values
      ('an extra key', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": [], "confidence": 1}'::jsonb),
      ('a missing key', '{"outcome": "completed", "summary": "ok"}'::jsonb),
      ('an outcome outside the contract', '{"outcome": "done", "summary": "ok", "proposed_next_steps": []}'::jsonb),
      ('an empty summary', '{"outcome": "completed", "summary": "", "proposed_next_steps": []}'::jsonb),
      ('11 steps', jsonb_build_object('outcome', 'completed', 'summary', 'ok',
                                      'proposed_next_steps', (select jsonb_agg('step ' || g) from generate_series(1, 11) as g))),
      ('a non-string step', '{"outcome": "completed", "summary": "ok", "proposed_next_steps": [1]}'::jsonb),
      ('an array', '[]'::jsonb)
    ) as c (label, envelope)
  loop
    perform pg_temp.expect_refused_with(format('N13a: a raw update to succeeded with %s', v_case.label), 'OS400', 'output contract',
      format('update ops.agent_runs set status = ''succeeded'', result = %L where id = %L', v_case.envelope, v_run));
  end loop;

  v_err := pg_temp.attempt(format('update ops.agent_runs set status = ''succeeded'', result = %L where id = %L',
                                  pg_temp.valid_result(), v_run));
  if v_err is not null or pg_temp.run_status(v_run) is distinct from 'succeeded' then
    raise exception 'N13b: the same raw update with a valid result was refused (%), so the refusals above prove nothing', coalesce(v_err, 'not succeeded');
  end if;
end
$$;

do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  da1 constant uuid := pg_temp.id('dept_a1');
  ga1 constant uuid := pg_temp.id('agent_a1');
  v_run uuid := pg_temp.raw_run_in('pending', 'task_n');
  v_other_company    uuid;
  v_other_department uuid;
  v_other_agent      uuid;
  v_cleared          uuid;
  v_case record;
  v_stop uuid;
  v_err  text;
begin
  v_other_company := ops.trip_execution_stop('company', 'ar1d-test: N13 another company', 'ar1d-owner', ta, pg_temp.id('company_a2'));
  v_other_department := ops.trip_execution_stop('department', 'ar1d-test: N13 another department', 'ar1d-owner',
                                                ta, ca1, pg_temp.id('dept_a1_support'));
  v_other_agent := ops.trip_execution_stop('agent', 'ar1d-test: N13 another agent', 'ar1d-owner', ta, ca1, null, pg_temp.id('agent_a1_two'));
  v_cleared := ops.trip_execution_stop('tenant', 'ar1d-test: N13 cleared tenant stop', 'ar1d-owner', ta);
  perform ops.clear_execution_stop(v_cleared, 'ar1d-test: N13 cleared', 'ar1d-owner');
  if ops.active_execution_stop(ta, ca1, da1, ga1) is not null then
    raise exception 'N13: an active stop covers the fixture run; this case would prove nothing';
  end if;

  for v_case in
    select * from (values
      ('N13c: recording a cleared stop that covered the run', v_cleared),
      ('N13d: recording another company''s active stop', v_other_company),
      ('N13e: recording another department''s active stop', v_other_department),
      ('N13f: recording another agent''s active stop', v_other_agent)
    ) as c (label, stop_id)
  loop
    perform pg_temp.expect_refused_with(v_case.label, 'OS409', 'active stop that covers it',
      format($q$update ops.agent_runs set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped', stop_id = %L where id = %L$q$,
             v_case.stop_id, v_run));
  end loop;

  -- N13g. Controls: an active stop that covers the run is recorded, at every scope.
  for v_case in
    select * from (values
      ('global', null::uuid, null::uuid, null::uuid, null::uuid),
      ('tenant', ta, null, null, null),
      ('company', ta, ca1, null, null),
      ('department', ta, ca1, da1, null),
      ('agent', ta, ca1, null, ga1)
    ) as c (scope, tenant_id, company_id, department_id, agent_id)
  loop
    v_err := null;
    begin
      v_stop := ops.trip_execution_stop(v_case.scope, format('ar1d-test: N13 covering %s stop', v_case.scope), 'ar1d-owner',
                                        v_case.tenant_id, v_case.company_id, v_case.department_id, v_case.agent_id);
      update ops.agent_runs
         set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped', stop_id = v_stop
       where id = v_run;
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    exception
      when sqlstate 'C1CAC' then null;
      when others then v_err := sqlstate || ' ' || sqlerrm;
    end;
    if v_err is not null then
      raise exception 'N13g: an active % stop that covers the run could not be recorded on it (%), so the refusals above prove nothing',
        v_case.scope, v_err;
    end if;
  end loop;

  perform ops.clear_execution_stop(v_other_company, 'ar1d-test: N13 cleared', 'ar1d-owner');
  perform ops.clear_execution_stop(v_other_department, 'ar1d-test: N13 cleared', 'ar1d-owner');
  perform ops.clear_execution_stop(v_other_agent, 'ar1d-test: N13 cleared', 'ar1d-owner');
end
$$;
select set_config('app.event_source', '', true);

-- N14. A run's lifecycle causation is derived from its lifecycle facts only: a business
--      fact about the run (allowed, I7) recorded just before each transition is never
--      its cause. The valid path keeps its outcome. Each time three facts are recorded,
--      the last two typed next to the lifecycle namespace (agent_runs.*, and agentxrun.*
--      where a LIKE wildcard would stand for the underscore), so a prefix or LIKE filter
--      is caught as well as no filter. The helper returns the last one.
create function pg_temp.record_near_lifecycle_facts(p_tenant uuid, p_company uuid, p_run uuid)
returns ops.events
language plpgsql
as $f$
declare
  v_type text;
  v_id   uuid;
  r      ops.events;
begin
  foreach v_type in array array['review.noted', 'agent_runs.noted', 'agentxrun.noted'] loop
    v_id := ops.record_event(p_tenant, p_company, v_type, 'ar1d-record', 'agent_run', p_run);
  end loop;
  select * into r from ops.events e where e.id = v_id;
  return r;
end
$f$;

do $$
declare
  ta  constant uuid := pg_temp.id('tenant_a');
  ca1 constant uuid := pg_temp.id('company_a1');
  v_run   uuid := pg_temp.leased_run('ar1d-n14', 'task_n', 'agent_a1', 'ar1d-worker-n14');
  v_retry uuid;
  v_state text;
  v_fact_1 ops.events;
  v_fact_2 ops.events;
  v_fact_3 ops.events;
  v_requested       ops.events;
  v_started         ops.events;
  v_done            ops.events;
  v_retry_requested ops.events;
begin
  v_fact_1 := pg_temp.record_near_lifecycle_facts(ta, ca1, v_run);
  perform pg_temp.as_worker();
  perform ops.claim_agent_run();
  v_state := ops.start_agent_run('fake', 'fake-model-1', 'task_assessment.v1', repeat('f', 64));
  perform pg_temp.as_owner();
  v_fact_2 := pg_temp.record_near_lifecycle_facts(ta, ca1, v_run);
  v_state := v_state || '>' || pg_temp.worker_completes();
  v_fact_3 := pg_temp.record_near_lifecycle_facts(ta, ca1, v_run);
  v_retry := pg_temp.request('ar1d-n14-retry', 'tenant_a', 'task_n', 'agent_a1', v_run);

  select * into v_requested from ops.events e where e.subject_id = v_run and e.type = 'agent_run.requested';
  select * into v_started from ops.events e where e.subject_id = v_run and e.type = 'agent_run.started';
  select * into v_done from ops.events e where e.subject_id = v_run and e.type = 'agent_run.succeeded';
  select * into v_retry_requested from ops.events e where e.subject_id = v_retry and e.type = 'agent_run.requested';
  if v_state is distinct from 'running>succeeded'
     or not (v_requested.seq < v_fact_1.seq and v_fact_1.seq < v_started.seq and v_started.seq < v_fact_2.seq
             and v_fact_2.seq < v_done.seq and v_done.seq < v_fact_3.seq and v_fact_3.seq < v_retry_requested.seq) then
    raise exception 'N14: the business facts were not each the latest fact before a transition (run %); this case would prove nothing', v_state;
  end if;

  if v_started.causation_id is distinct from v_requested.id then
    raise exception 'N14a: agent_run.started was caused by % (the business fact is %), not by agent_run.requested %',
      v_started.causation_id, v_fact_1.id, v_requested.id;
  end if;
  if v_done.causation_id is distinct from v_started.id then
    raise exception 'N14b: agent_run.succeeded was caused by % (the business fact is %), not by agent_run.started %',
      v_done.causation_id, v_fact_2.id, v_started.id;
  end if;
  if v_retry_requested.causation_id is distinct from v_done.id then
    raise exception 'N14c: a retry''s agent_run.requested was caused by % (the business fact is %), not by its parent''s last lifecycle fact %',
      v_retry_requested.causation_id, v_fact_3.id, v_done.id;
  end if;
  if v_done.payload ->> 'outcome' is distinct from pg_temp.valid_result() ->> 'outcome' then
    raise exception 'N14e: a valid succeeded fact did not carry its contract outcome: %', v_done.payload;
  end if;
end
$$;

-- N14d. The outcome is copied only when it is a contract value. The update guard
--       normally keeps any other result from ever succeeding (N13a), so it is switched
--       off, the owner's tripwire the review named, to prove the emitter holds alone.
--       Each case is rolled back.
select set_config('app.event_source', 'ar1d-raw', true);
do $$
declare
  v_run     uuid := pg_temp.raw_run_in('running', 'task_n');
  v_outcome jsonb;
  v_payload jsonb;
  v_err     text;
begin
  foreach v_outcome in array array['"A sentence that names a person"', '1', '" completed"', '"COMPLETED"',
                                   '"completed "', '"completed, and a sentence after it"',
                                   '{"nested": "completed"}']::jsonb[] loop
    v_payload := null;
    v_err := null;
    begin
      alter table ops.agent_runs disable trigger agent_runs_guard_update;
      update ops.agent_runs
         set status = 'succeeded', completed_at = now(),
             result = jsonb_build_object('outcome', v_outcome, 'summary', 'ok', 'proposed_next_steps', '[]'::jsonb)
       where id = v_run;
      select e.payload into v_payload from ops.events e where e.subject_id = v_run and e.type = 'agent_run.succeeded';
      raise exception using errcode = 'C1CAC', message = 'rolled back';
    exception
      when sqlstate 'C1CAC' then null;
      when others then v_err := sqlstate || ' ' || sqlerrm;
    end;
    if v_err is not null or v_payload is null then
      raise exception 'N14d: with the guard off, no succeeded fact was produced for outcome % (%); this case would prove nothing',
        v_outcome, coalesce(v_err, 'no fact');
    end if;
    if v_payload ? 'outcome' then
      raise exception 'N14d: a succeeded fact copied the out-of-contract outcome % into its payload: %', v_outcome, v_payload;
    end if;
  end loop;
  if pg_temp.run_status(v_run) is distinct from 'running'
     or exists (select 1 from ops.events e where e.subject_id = v_run and e.type = 'agent_run.succeeded')
     or not exists (select 1 from pg_trigger tg where tg.tgname = 'agent_runs_guard_update' and tg.tgenabled = 'A') then
    raise exception 'N14d: a rolled-back case left its change, its fact or its disabled guard behind';
  end if;
end
$$;
-- N15. A provider server error is an ambiguous outcome (ADR 0016, owner review
--      2026-09-16): a 5xx does not prove the model never ran. The helper records it
--      indeterminate, and not even a raw owner UPDATE can store it as a known failure
--      that a person might retry believing no call was made.
do $$
declare
  v_run uuid := pg_temp.raw_run_in('running', 'task_n');
  v_err text;
begin
  perform set_config('app.event_source', 'ar1d-raw', true);
  if ops.agent_run_error_status('provider_5xx') is distinct from 'indeterminate' then
    raise exception 'N15a: ops.agent_run_error_status(provider_5xx) is %, not indeterminate',
      coalesce(ops.agent_run_error_status('provider_5xx'), 'NULL');
  end if;

  perform pg_temp.expect_refused('N15b: a raw update recording a provider server error as a known failure', '23514',
    format($q$update ops.agent_runs set status = 'failed', error_category = 'provider_5xx', error_code = 'http_503' where id = %L$q$,
           v_run));

  v_err := pg_temp.attempt(format(
    $q$update ops.agent_runs set status = 'indeterminate', error_category = 'provider_5xx', error_code = 'http_503' where id = %L$q$,
    v_run));
  if v_err is not null or pg_temp.run_status(v_run) is distinct from 'indeterminate' then
    raise exception 'N15c: the same raw update recording the server error as indeterminate was refused (%), so the refusal above proves nothing',
      coalesce(v_err, pg_temp.run_status(v_run));
  end if;
end
$$;

select set_config('app.event_source', '', true);

-- ===========================================================================
-- I3. PAYLOAD MINIMISATION, over every agent_run fact every section produced.
-- ===========================================================================
do $$
declare
  ta constant uuid := pg_temp.id('tenant_a');
  tb constant uuid := pg_temp.id('tenant_b');
  v_bad text;
begin
  select string_agg(distinct format('%s:%s', e.type, k), ', ') into v_bad
    from ops.events e
   cross join jsonb_object_keys(e.payload) as k
   where e.tenant_id in (ta, tb) and e.type like 'agent\_run.%'
     and k not in ('task_id', 'agent_id', 'capability', 'model_route', 'retry_of_run_id',
                   'from_status', 'to_status', 'error_category', 'error_code', 'outcome');
  if v_bad is not null then
    raise exception 'I3: an agent_run fact carries a payload key outside the minimised set: %', v_bad;
  end if;

  select string_agg(distinct e.type, ', ') into v_bad
    from ops.events e
   where e.tenant_id in (ta, tb) and e.type like 'agent\_run.%'
     and (e.subject_type is distinct from 'agent_run' or e.correlation_id is null
          or e.type not in ('agent_run.requested', 'agent_run.started', 'agent_run.succeeded',
                            'agent_run.failed', 'agent_run.indeterminate', 'agent_run.cancelled'));
  if v_bad is not null then
    raise exception 'I3: agent_run fact(s) without a run subject, a correlation or a declared type: %', v_bad;
  end if;

  -- The outcome, where a fact carries one, is only ever one of the three contract values.
  select string_agg(distinct e.payload ->> 'outcome', ', ') into v_bad
    from ops.events e
   where e.tenant_id in (ta, tb) and e.type like 'agent\_run.%' and e.payload ? 'outcome'
     and (jsonb_typeof(e.payload -> 'outcome') is distinct from 'string'
          or (e.payload ->> 'outcome') not in ('completed', 'needs_input', 'blocked'));
  if v_bad is not null then
    raise exception 'I3: an agent_run fact carries an outcome outside the three-valued contract: %', v_bad;
  end if;

  -- Positive control: every kind of fact was produced and inspected.
  select string_agg(t, ', ') into v_bad
    from unnest(array['agent_run.requested', 'agent_run.started', 'agent_run.succeeded',
                      'agent_run.failed', 'agent_run.indeterminate', 'agent_run.cancelled']) as t
   where not exists (select 1 from ops.events e where e.tenant_id in (ta, tb) and e.type = t);
  if v_bad is not null then
    raise exception 'I3: no % fact was produced, so the payload check above proves nothing about it', v_bad;
  end if;
end
$$;

rollback;

-- Nothing above committed.
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'ar1d-test-%') then
    raise exception 'agent_runtime.sql left fixtures behind';
  end if;
  if exists (select 1 from ops.execution_stops where reason like 'ar1d-test%') then
    raise exception 'agent_runtime.sql left an execution stop behind';
  end if;
  if exists (select 1 from pg_roles where rolname = 'ar1d_probe_rls') then
    raise exception 'agent_runtime.sql left its row security probe role behind';
  end if;
  if exists (select 1 from pg_trigger where tgname in ('ar1d_skip_stop_insert', 'zz_ar1d_business_fact')) then
    raise exception 'agent_runtime.sql left a probe trigger behind';
  end if;
end
$$;
