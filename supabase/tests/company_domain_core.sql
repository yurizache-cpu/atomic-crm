-- Phase 1C — attacks on the Company OS domain core.
--
-- The question: can the organisational model — companies, departments, agents,
-- tasks, events and the task->job bridge — hold a row that crosses a tenant or a
-- company, reach a state the state machine forbids, change without its fact, or
-- be read or written by any role but the owner?
--
-- WHAT ACTUALLY HOLDS IN PHASE 1C, stated so no case below is read as more:
--   * No application role holds any privilege on these tables or functions
--     (section A, and section B on a real lease). That is the live boundary.
--   * The domain functions are SECURITY INVOKER, take an explicit authorised
--     tenant scope, and resolve every other id inside it (section E).
--   * Composite foreign keys and guard triggers make cross-scope rows and illegal
--     states unstorable for every role but the owner (sections D and F). The
--     owner is outside that boundary by design — it can disable triggers and use
--     replica mode — and section D characterises exactly how far that reaches.
--   * The lease-bound read policies are exercised through a grant that exists
--     only inside this rolled-back transaction (section C). That is POLICY-SHAPE
--     evidence for a future reader, not a live read path.
--
-- ONE TRANSACTION, ROLLED BACK. Nothing here needs a COMMIT: the property that
-- does — tenant context not surviving a COMMIT on a reused connection — belongs
-- to the lease and is proven by ops_execution_core.sql. So this file leaves the
-- database exactly as it found it and needs no cleanup.

\set ON_ERROR_STOP on

begin;

-- Membership is needed to `set role ops_worker`. `grant <role> to current_user`
-- SEGFAULTS this server build; interpolate (see ops_execution_core.sql).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Helpers. Temporary, so they vanish with the transaction.
-- ---------------------------------------------------------------------------

-- Runs one statement and requires it to fail with exactly this SQLSTATE. A
-- refusal for the WRONG reason is a failure too: a test that expected "not found"
-- and got "permission denied" has proven nothing about the property it names.
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
-- STRUCTURAL backstop (a composite foreign key) independently of the trigger in
-- front of it. The DISABLE lives in the rolled-back subtransaction either way.
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

create function pg_temp.id(p_key text)
returns uuid
language sql
as $f$ select current_setting('c1c.' || p_key)::uuid $f$;

create function pg_temp.event_count()
returns bigint
language sql
as $f$ select count(*) from ops.events $f$;

-- ---------------------------------------------------------------------------
-- Fixtures, built through the domain functions so their events are real.
-- Two tenants; tenant A holds TWO companies, so cross-company attacks inside one
-- tenant are real cases rather than hypothetical ones. Ids travel in
-- transaction-local settings, which every role can read — including ops_worker
-- in sections B and C.
-- ---------------------------------------------------------------------------
do $$
declare
  ta   uuid; tb   uuid;
  ca1  uuid; ca2  uuid; cb  uuid;
  da1r uuid; da1m uuid; da2 uuid; db uuid;
  ga1r uuid; ga1m uuid; ga2 uuid; gb uuid; ga1x uuid; gbx uuid; ga1r2 uuid;
  t    uuid;
begin
  insert into ops.tenants (slug, name) values ('c1c-test-alpha', 'C1C Alpha') returning id into ta;
  insert into ops.tenants (slug, name) values ('c1c-test-beta', 'C1C Beta') returning id into tb;

  ca1 := ops.create_company(ta, 'clinic', 'Clinic', 'c1c-test');
  ca2 := ops.create_company(ta, 'printing', 'Printing', 'c1c-test');
  -- The same slug in another tenant is legitimate: slugs are unique per tenant.
  cb  := ops.create_company(tb, 'clinic', 'Clinic', 'c1c-test');

  da1r := ops.create_department(ta, ca1, 'reception', 'Reception', 'c1c-test');
  da1m := ops.create_department(ta, ca1, 'marketing', 'Marketing', 'c1c-test');
  da2  := ops.create_department(ta, ca2, 'operations', 'Operations', 'c1c-test');
  db   := ops.create_department(tb, cb, 'reception', 'Reception', 'c1c-test');

  ga1r  := ops.create_agent(ta, ca1, da1r, 'reception-agent', 'Reception Agent', 'Receptionist', 'c1c-test');
  ga1r2 := ops.create_agent(ta, ca1, da1r, 'reception-agent-two', 'Reception Agent Two', 'Receptionist', 'c1c-test');
  ga1m  := ops.create_agent(ta, ca1, da1m, 'marketing-analyst', 'Marketing Analyst', 'Analyst', 'c1c-test');
  ga2   := ops.create_agent(ta, ca2, da2, 'operator', 'Operator', 'Operator', 'c1c-test');
  gb    := ops.create_agent(tb, cb, db, 'reception-agent', 'Reception Agent', 'Receptionist', 'c1c-test');
  ga1x  := ops.create_agent(ta, ca1, da1r, 'paused-agent', 'Paused Agent', 'Receptionist', 'c1c-test');
  perform ops.set_agent_status(ta, ga1x, 'inactive', 'c1c-test');
  gbx   := ops.create_agent(tb, cb, db, 'paused-agent', 'Paused Agent', 'Receptionist', 'c1c-test');
  perform ops.set_agent_status(tb, gbx, 'inactive', 'c1c-test');

  perform set_config('c1c.tenant_a', ta::text, true);
  perform set_config('c1c.tenant_b', tb::text, true);
  perform set_config('c1c.company_a1', ca1::text, true);
  perform set_config('c1c.company_a2', ca2::text, true);
  perform set_config('c1c.company_b', cb::text, true);
  perform set_config('c1c.dept_a1_reception', da1r::text, true);
  perform set_config('c1c.dept_a1_marketing', da1m::text, true);
  perform set_config('c1c.dept_a2', da2::text, true);
  perform set_config('c1c.dept_b', db::text, true);
  perform set_config('c1c.agent_a1_reception', ga1r::text, true);
  perform set_config('c1c.agent_a1_reception_two', ga1r2::text, true);
  perform set_config('c1c.agent_a1_marketing', ga1m::text, true);
  perform set_config('c1c.agent_a2', ga2::text, true);
  perform set_config('c1c.agent_b', gb::text, true);
  perform set_config('c1c.agent_a1_inactive', ga1x::text, true);
  perform set_config('c1c.agent_b_inactive', gbx::text, true);

  t := ops.create_task(ta, ca1, 'crm.follow_up', 'Reception follow-up', 'c1c-test', null, da1r);
  perform set_config('c1c.task_a1', t::text, true);
  t := ops.create_task(ta, ca1, 'crm.follow_up', 'Company-level follow-up', 'c1c-test');
  perform set_config('c1c.task_a1_nodept', t::text, true);
  t := ops.create_task(ta, ca2, 'print.run', 'Print run', 'c1c-test', null, da2);
  perform set_config('c1c.task_a2', t::text, true);
  t := ops.create_task(tb, cb, 'crm.follow_up', 'Beta follow-up', 'c1c-test', null, db);
  perform set_config('c1c.task_b', t::text, true);
  t := ops.create_task(tb, cb, 'crm.follow_up', 'Beta closed', 'c1c-test');
  perform ops.transition_task(tb, t, 'cancelled', 'c1c-test');
  perform set_config('c1c.task_b_closed', t::text, true);

  -- Queue-winning jobs for the lease-based sections, so a job some other suite
  -- left behind can never be the one leased.
  perform set_config('c1c.job_shipped',
    ops.enqueue_job(ta, 'c1c.lease_probe', '{}'::jsonb, -2147483648, now(), 5, null)::text, true);
  perform set_config('c1c.job_a',
    ops.enqueue_job(ta, 'c1c.lease_probe', '{}'::jsonb, -2147483647, now(), 5, null)::text, true);
  perform set_config('c1c.job_b',
    ops.enqueue_job(tb, 'c1c.lease_probe', '{}'::jsonb, -2147483646, now(), 5, null)::text, true);
end
$$;

-- ===========================================================================
-- A. THE GRANT SURFACE. No application role reaches Company OS data or services.
-- ===========================================================================
do $$
declare
  v_bad text;
begin
  -- A1. Tables. Phase 1D (2026-09-14) adds agent_runs and execution_stops, which
  --     are backend-only on exactly the same terms. Phase 1D.1 (2026-09-17) adds
  --     model_prices and spend_limits: owner data no application role may touch
  --     (supabase/tests/runtime_governance.sql, section G). Phase 2B (2026-09-18)
  --     adds communication_channels, conversations and outbound_messages, and a
  --     fifth application role, ops_gateway, which holds no table at all
  --     (supabase/tests/whatsapp_transport.sql, section A). Phase 2C
  --     (2026-09-22, 20260922120000_company_os_read_surface.sql) adds principals
  --     and tenant_memberships, written only by the owner, and the capability
  --     role ops_operator_api, which executes its gates and holds no table
  --     (supabase/tests/company_os_api.sql).
  select string_agg(format('%s:%s:%s', r.rolname, t.relname, p.priv), ', ') into v_bad
    from unnest(array['companies', 'departments', 'agents', 'tasks', 'events', 'task_jobs',
                      'agent_runs', 'execution_stops', 'model_prices', 'spend_limits',
                      'communication_channels', 'conversations', 'outbound_messages',
                      'principals', 'tenant_memberships']) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                      ('ops_operator_api')) as r (rolname)
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where has_table_privilege(r.rolname, format('ops.%I', t.relname), p.priv);
  if v_bad is not null then
    raise exception 'A1: Company OS table reachable by an application role: %', v_bad;
  end if;

  -- A2. The schema.
  if has_schema_privilege('anon', 'ops', 'USAGE') or has_schema_privilege('authenticated', 'ops', 'USAGE') then
    raise exception 'A2: anon or authenticated can reach schema ops';
  end if;

  -- A3. No ops function is callable by PUBLIC — a NULL ACL means the default,
  --     and the default includes PUBLIC.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A3: ops function(s) executable by PUBLIC: %', v_bad;
  end if;

  -- A4. The complete EXECUTE surface of the application roles in ops, pinned.
  --     Phase 1C adds NOTHING to it. A new function born reachable, or a grant
  --     nobody reviewed, shows up here by name.
  --     Phase 1D (2026-09-14, 20260914120000_agent_runtime.sql) adds exactly the
  --     six agent run capabilities, to ops_worker only. Each takes no tenant, run,
  --     task or job argument and resolves its one run from the live lease; the
  --     owner services it adds (request_agent_run and the stop functions) are
  --     executable by no application role. supabase/tests/agent_runtime.sql
  --     attacks both halves.
  --     Phase 1D.1 (2026-09-17, 20260917120000_runtime_governance.sql) gives the
  --     start its output ceiling as a fifth argument and adds exactly three
  --     argument-free worker capabilities: the pre-call stop check, the deferral it
  --     permits, and the ceiling sweep. The price and limit services it adds are
  --     executable by no application role (supabase/tests/runtime_governance.sql).
  --     Phase 2A's final review (2026-09-18,
  --     20260918120000_lead_triage_review_after_settlement.sql) adds exactly one
  --     worker function: the post-settlement step that opens a lead triage
  --     review AFTER the settlement committed. It takes no tenant, run or content
  --     argument, names a job and the worker that completed it, and refuses any
  --     other worker (supabase/tests/lead_triage_pilot.sql, section I).
  --     Phase 2B (2026-09-18, 20260918150000_whatsapp_transport.sql) adds a
  --     fifth role, ops_gateway, the webhook gateway's group role, with exactly
  --     two functions: admit one Meta message and record one Meta status. The
  --     provider target alone selects the tenant; neither takes a tenant, a
  --     task or a send. The owner services Phase 2B adds (channel
  --     configuration, the explicit send and its settlement) are executable by
  --     no application role (supabase/tests/whatsapp_transport.sql, section A).
  --     Phase 2C (2026-09-22, 20260922120000_company_os_read_surface.sql) adds a
  --     capability role, ops_operator_api, with exactly one identity gate per
  --     read operation of company_os_api: each resolves the caller's tenant from
  --     the verified claims and a membership, takes no tenant, company or actor
  --     argument, and calls one pinned projection. The membership services, the
  --     resolver and the projections are executable by no application role and
  --     not by ops_operator_api (supabase/tests/company_os_api.sql).
  with expected (rolname, fn) as (values
    ('service_role', 'ops.enqueue_job(uuid, text, jsonb, integer, timestamptz, integer, text)'::regprocedure),
    ('ops_worker',   'ops.lease_job(text, integer)'::regprocedure),
    ('ops_worker',   'ops.complete_job(uuid)'::regprocedure),
    ('ops_worker',   'ops.complete_job(uuid, text)'::regprocedure),
    ('ops_worker',   'ops.fail_job(uuid, text, interval)'::regprocedure),
    ('ops_worker',   'ops.current_tenant_id()'::regprocedure),
    ('ops_worker',   'ops.worker_heartbeat(text, text)'::regprocedure),
    ('ops_worker',   'ops.worker_stopped(text)'::regprocedure),
    ('ops_worker',   'ops.settle_job_failure(uuid, text, text)'::regprocedure),
    ('ops_worker',   'ops.purge_inbound_email_ledger(integer, integer)'::regprocedure),
    ('ops_worker',   'ops.resume_lease(text, uuid)'::regprocedure),
    ('ops_worker',   'ops.reap_expired_leases()'::regprocedure),
    ('ops_worker',   'ops.claim_agent_run()'::regprocedure),
    ('ops_worker',   'ops.refuse_agent_run(text)'::regprocedure),
    ('ops_worker',   'ops.start_agent_run(text, text, text, text, integer)'::regprocedure),
    ('ops_worker',   'ops.complete_agent_run(jsonb, text, text, text, text, integer, integer, integer, integer, integer, integer)'::regprocedure),
    ('ops_worker',   'ops.fail_agent_run(text, text, text, text, text, integer, integer, integer, integer, integer, integer)'::regprocedure),
    ('ops_worker',   'ops.settle_stale_agent_runs()'::regprocedure),
    ('ops_worker',   'ops.job_execution_stop()'::regprocedure),
    ('ops_worker',   'ops.defer_job()'::regprocedure),
    ('ops_worker',   'ops.enforce_spend_ceiling()'::regprocedure),
    ('ops_worker',   'ops.open_review_for_settled_job(text, uuid)'::regprocedure),
    -- Phase 2D.1: the shadow decision's runtime step and its two lease-bound
    -- capabilities (supabase/tests/decision_shadow.sql).
    ('ops_worker',   'ops.request_shadow_decision_for_settled_job(text, uuid)'::regprocedure),
    ('ops_worker',   'ops.start_shadow_decision(text, text, text)'::regprocedure),
    ('ops_worker',   'ops.settle_shadow_decision(text, jsonb, text)'::regprocedure),
    ('ops_gateway',  'ops.receive_whatsapp_message(text, text, text, text, timestamptz)'::regprocedure),
    ('ops_gateway',  'ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)'::regprocedure),
    ('ops_operator_api', 'ops.gate_operator_context()'::regprocedure),
    ('ops_operator_api', 'ops.gate_overview()'::regprocedure),
    ('ops_operator_api', 'ops.gate_list_agents()'::regprocedure),
    ('ops_operator_api', 'ops.gate_get_agent(uuid)'::regprocedure),
    ('ops_operator_api', 'ops.gate_list_tasks(text, text, uuid, integer)'::regprocedure),
    ('ops_operator_api', 'ops.gate_get_task(uuid)'::regprocedure),
    ('ops_operator_api', 'ops.gate_list_runs(text, text, uuid, boolean, integer)'::regprocedure),
    ('ops_operator_api', 'ops.gate_get_run(uuid)'::regprocedure),
    ('ops_operator_api', 'ops.gate_list_reviews(text, text, integer)'::regprocedure),
    ('ops_operator_api', 'ops.gate_get_review(uuid)'::regprocedure),
    ('ops_operator_api', 'ops.gate_get_review_advice(uuid)'::regprocedure),
    ('ops_operator_api', 'ops.gate_list_events(text, text, uuid, integer)'::regprocedure),
    ('ops_operator_api', 'ops.gate_list_stops(boolean, text, integer)'::regprocedure),
    ('ops_operator_api', 'ops.gate_spend_summary()'::regprocedure),
    ('ops_operator_api', 'ops.gate_communication_status()'::regprocedure),
    -- S7.1: the one act (supabase/tests/company_os_api.sql, section V).
    ('ops_operator_api', 'ops.gate_decide_review(uuid, text)'::regprocedure),
    -- S7.2: the trip (supabase/tests/company_os_api.sql, section W).
    ('ops_operator_api', 'ops.gate_trip_stop(text, uuid)'::regprocedure)
  ),
  actual as (
    select r.rolname, p.oid::regprocedure as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                        ('ops_operator_api')) as r (rolname)
     where n.nspname = 'ops' and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
  ),
  drift as (
    (select 'unexpected ' || rolname || ':' || fn::text as d from actual
      except select 'unexpected ' || rolname || ':' || fn::text from expected)
    union all
    (select 'missing ' || rolname || ':' || fn::text from expected
      except select 'missing ' || rolname || ':' || fn::text from actual)
  )
  select string_agg(d, ', ') into v_bad from drift;
  if v_bad is not null then
    raise exception 'A4: the ops EXECUTE surface drifted from the pinned set: %', v_bad;
  end if;

  -- A5. The SECURITY DEFINER surface, pinned. Every Company OS *service* is
  --     INVOKER. Phase 1D (2026-09-14) adds the six agent run capabilities, which
  --     are lease-bound DEFINER exactly like the Phase 1B capability: they take no
  --     tenant and reach only the run bound to the live lease's job. Phase 1D.1
  --     (2026-09-17) adds three more on the same terms: job_execution_stop and
  --     defer_job reach only the leased job, and enforce_spend_ceiling takes no
  --     argument and can only trip a global stop. Phase 2A's final review
  --     (2026-09-18) adds open_review_for_settled_job, which runs after the
  --     lease has ended: it reaches only the run of a job the calling worker
  --     completed, and only to open that run's review from the stored result.
  --     Phase 2B (2026-09-18) adds the gateway's two: receive_whatsapp_message
  --     and receive_whatsapp_status. Each maps the provider target to its ONE
  --     configured channel and acts only inside that channel's tenant: a
  --     message is admitted (test channel) or held with no content (production
  --     channel, BASELINE Q8), and a status moves only a send of that channel.
  --     Phase 2C (2026-09-22) adds one identity gate per company_os_api read,
  --     executable only by ops_operator_api: each runs the resolver first and
  --     reaches one pinned projection inside the caller's own tenant
  --     (supabase/tests/company_os_api.sql pins the graph). Phase 2D.1 adds the
  --     shadow decision's three: a runtime step bound to a job the calling
  --     worker completed (like open_review_for_settled_job), and two capabilities
  --     bound to the live lease's job. They record advice; they decide nothing
  --     (supabase/tests/decision_shadow.sql).
  select string_agg(distinct p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.prosecdef
     and p.proname not in ('complete_job', 'current_tenant_id', 'enqueue_job', 'fail_job', 'lease_job',
                           'purge_inbound_email_ledger', 'reap_expired_leases', 'resume_lease',
                           'settle_job_failure', 'worker_heartbeat', 'worker_stopped',
                           'claim_agent_run', 'refuse_agent_run', 'start_agent_run',
                           'complete_agent_run', 'fail_agent_run', 'settle_stale_agent_runs',
                           'job_execution_stop', 'defer_job', 'enforce_spend_ceiling',
                           'open_review_for_settled_job', 'request_shadow_decision_for_settled_job',
                           'start_shadow_decision', 'settle_shadow_decision',
                           'receive_whatsapp_message', 'receive_whatsapp_status',
                           'gate_operator_context', 'gate_overview', 'gate_list_agents', 'gate_get_agent',
                           'gate_list_tasks', 'gate_get_task', 'gate_list_runs', 'gate_get_run',
                           'gate_list_reviews', 'gate_get_review', 'gate_get_review_advice',
                           'gate_list_events', 'gate_list_stops', 'gate_spend_summary',
                           'gate_communication_status', 'gate_decide_review', 'gate_trip_stop');
  if v_bad is not null then
    raise exception 'A5: unexpected SECURITY DEFINER function(s) in ops: %', v_bad;
  end if;

  -- A6. ENABLE + FORCE row level security on every ops table.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind = 'r' and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'A6: ops table(s) % lack ENABLE + FORCE row level security', v_bad;
  end if;

  -- A7. Guard triggers exist and survive replica mode. Phase 1D.1 adds the guard
  --     that fixes a task's idempotency key and request fingerprint.
  select string_agg(g.name, ', ') into v_bad
    from unnest(array['companies_guard_update', 'departments_guard_update', 'agents_guard_update',
                      'tasks_guard_update', 'events_refuse_update', 'task_jobs_refuse_update',
                      'tasks_request_identity_update']) as g (name)
   where not exists (
     select 1 from pg_trigger tg
       join pg_class c on c.oid = tg.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ops' and tg.tgname = g.name and tg.tgenabled = 'A');
  if v_bad is not null then
    raise exception 'A7: guard trigger(s) missing or not ENABLE ALWAYS: %', v_bad;
  end if;

  -- A8. No task could request execution in Phase 1C. Since Phase 1D (2026-09-14)
  --     exactly one kind is allowlisted: the job that carries an agent run, which
  --     the bridge creates only for a pending run of the same task
  --     (supabase/tests/agent_runtime.sql, section J).
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'A8: ops.task_executable_kinds() is not exactly {agent_run.execute}';
  end if;
end
$$;

-- ===========================================================================
-- B. THE SHIPPED STATE, ON A REAL LEASE.
--    A worker holding a live lease for tenant A is refused at the privilege
--    layer on every Company OS table and every Company OS function. This is the
--    boundary that actually holds in Phase 1C.
-- ===========================================================================
set local role ops_worker;
do $$
declare
  v_job     ops.jobs;
  v_table   text;
  v_n       bigint;
  v_refused integer := 0;
  v_tried   integer := 0;
  ta        constant uuid := current_setting('c1c.tenant_a')::uuid;
begin
  v_job := ops.lease_job('c1c-worker', 60);
  if v_job.id is distinct from current_setting('c1c.job_shipped')::uuid then
    raise exception 'B: the lease went to %, not the fixture job; this case would prove nothing', v_job.id;
  end if;
  if ops.current_tenant_id() is distinct from ta then
    raise exception 'B: the lease did not install tenant A';
  end if;

  foreach v_table in array array['companies', 'departments', 'agents', 'tasks', 'events', 'task_jobs',
                                 'agent_runs', 'execution_stops', 'model_prices', 'spend_limits'] loop
    v_tried := v_tried + 1;
    begin
      execute format('select count(*) from ops.%I', v_table) into v_n;
    exception when insufficient_privilege then
      v_refused := v_refused + 1;
    end;
  end loop;

  v_tried := v_tried + 1;
  begin perform ops.create_company(ta, 'worker-made', 'Worker made', 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.create_task(ta, current_setting('c1c.company_a1')::uuid, 'x.y', 'Worker task', 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.assign_task(ta, current_setting('c1c.task_a1')::uuid, current_setting('c1c.agent_a1_reception')::uuid, 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.transition_task(ta, current_setting('c1c.task_a1')::uuid, 'cancelled', 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.record_event(ta, current_setting('c1c.company_a1')::uuid, 'finance.forged', 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.request_task_execution(ta, current_setting('c1c.task_a1')::uuid, 'c1c.lease_probe', 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.request_agent_run(ta, current_setting('c1c.task_a1')::uuid, current_setting('c1c.agent_a1_reception')::uuid,
                                      'task_assessment', 'c1c-worker-key', 'c1c-worker');
  exception when insufficient_privilege then v_refused := v_refused + 1; end;
  v_tried := v_tried + 1;
  begin perform ops.push_event_context('c1c-worker', null, null);
  exception when insufficient_privilege then v_refused := v_refused + 1; end;

  if v_refused <> v_tried then
    raise exception 'B: a leased worker reached Company OS data or services: only % of % attempts were refused', v_refused, v_tried;
  end if;

  -- Retire it, so section C leases its own fixtures.
  if ops.complete_job(v_job.id) is not true then
    raise exception 'B: could not settle the fixture job';
  end if;
end
$$;
reset role;

-- ===========================================================================
-- C. POLICY SHAPE — through a grant that exists only inside this transaction.
--    Proves that the day a worker is granted a read, it is born scoped to the
--    leased tenant: missing context reads nothing, malformed context raises,
--    and a lease reads its own tenant's rows and nobody else's, from both sides.
-- ===========================================================================
grant select on ops.companies, ops.departments, ops.agents, ops.tasks, ops.events, ops.task_jobs to ops_worker;

set local role ops_worker;
do $$
declare
  v_table text;
  v_n     bigint;
  v_raised boolean;
begin
  -- C1. No lease: zero rows, not all rows.
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  foreach v_table in array array['companies', 'departments', 'agents', 'tasks', 'events', 'task_jobs'] loop
    execute format('select count(*) from ops.%I', v_table) into v_n;
    if v_n <> 0 then
      raise exception 'C1: % rows of ops.% visible with no lease; missing context must fail closed for Company OS data', v_n, v_table;
    end if;
  end loop;

  -- C2. Malformed context raises rather than degrading to anything.
  perform set_config('app.worker_id', 'c1c-attacker', true);
  perform set_config('app.job_id', 'not-a-uuid', true);
  v_raised := false;
  begin
    select count(*) into v_n from ops.companies;
  exception when invalid_text_representation then
    v_raised := true;
  end;
  if not v_raised then
    raise exception 'C2: a malformed app.job_id did not raise (% company rows)', v_n;
  end if;

  -- C3. A well-formed, unknown job id: no tenant, no rows.
  perform set_config('app.job_id', '00000000-0000-0000-0000-000000000000', true);
  select count(*) into v_n from ops.tasks;
  if v_n <> 0 then
    raise exception 'C3: an unknown job id exposed % task rows', v_n;
  end if;
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
end
$$;

do $$
declare
  v_job ops.jobs;
  v_n   bigint;
  v_own bigint;
  ta    constant uuid := current_setting('c1c.tenant_a')::uuid;
  tb    constant uuid := current_setting('c1c.tenant_b')::uuid;
begin
  -- C4. Tenant A's lease sees A's rows — positively — and none of B's.
  v_job := ops.lease_job('c1c-worker-a', 60);
  if v_job.id is distinct from current_setting('c1c.job_a')::uuid or ops.current_tenant_id() is distinct from ta then
    raise exception 'C4: expected the tenant A fixture lease, got job % / tenant %', v_job.id, ops.current_tenant_id();
  end if;
  select count(*) into v_own from ops.companies where tenant_id = ta;
  if v_own <> 2 then raise exception 'C4: tenant A sees % of its 2 companies', v_own; end if;
  select count(*) into v_own from ops.events where tenant_id = ta;
  if v_own = 0 then raise exception 'C4: tenant A sees none of its own events; the policy is simply broken'; end if;
  select (select count(*) from ops.companies where tenant_id <> ta)
       + (select count(*) from ops.departments where tenant_id <> ta)
       + (select count(*) from ops.agents where tenant_id <> ta)
       + (select count(*) from ops.tasks where tenant_id <> ta)
       + (select count(*) from ops.events where tenant_id <> ta)
       + (select count(*) from ops.task_jobs where tenant_id <> ta)
    into v_n;
  if v_n <> 0 then
    raise exception 'C4: a leased worker read another tenant''s Company OS rows (% rows)', v_n;
  end if;
  perform ops.complete_job(v_job.id);

  -- C5. The same from tenant B's side, or a policy hard-wired to A would pass.
  v_job := ops.lease_job('c1c-worker-b', 60);
  if v_job.id is distinct from current_setting('c1c.job_b')::uuid or ops.current_tenant_id() is distinct from tb then
    raise exception 'C5: expected the tenant B fixture lease, got job % / tenant %', v_job.id, ops.current_tenant_id();
  end if;
  select count(*) into v_own from ops.tasks where tenant_id = tb;
  if v_own <> 2 then raise exception 'C5: tenant B sees % of its 2 tasks', v_own; end if;
  select (select count(*) from ops.companies where tenant_id <> tb)
       + (select count(*) from ops.departments where tenant_id <> tb)
       + (select count(*) from ops.agents where tenant_id <> tb)
       + (select count(*) from ops.tasks where tenant_id <> tb)
       + (select count(*) from ops.events where tenant_id <> tb)
       + (select count(*) from ops.task_jobs where tenant_id <> tb)
    into v_n;
  if v_n <> 0 then
    raise exception 'C5: a leased worker read another tenant''s Company OS rows (% rows)', v_n;
  end if;
  perform ops.complete_job(v_job.id);
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
end
$$;
reset role;

-- C6/C7. A lease that belongs to another worker, and a lease that expired
-- before this transaction began, both read nothing. Expiry is judged against
-- now(), the transaction start: a transaction that BEGINS while its lease is live
-- keeps its context until a reaper commits a change to the job row. That is the
-- Phase 1A lease mechanism, recorded in ADR 0015, not something this file can
-- change.
do $$
begin
  perform set_config('c1c.job_c',
    ops.enqueue_job(current_setting('c1c.tenant_a')::uuid, 'c1c.lease_probe', '{}'::jsonb, -2147483645, now(), 5, null)::text, true);
end
$$;
set local role ops_worker;
do $$
declare
  v_job ops.jobs;
  v_n   bigint;
begin
  v_job := ops.lease_job('c1c-worker-c', 60);
  if v_job.id is distinct from current_setting('c1c.job_c')::uuid then
    raise exception 'C6: expected the fixture lease, got %', v_job.id;
  end if;
  -- The real job id, named under another worker's id.
  perform set_config('app.worker_id', 'c1c-forger', true);
  select (select count(*) from ops.companies) + (select count(*) from ops.departments)
       + (select count(*) from ops.agents) + (select count(*) from ops.tasks)
       + (select count(*) from ops.events) + (select count(*) from ops.task_jobs)
    into v_n;
  if v_n <> 0 then
    raise exception 'C6: a job leased by another worker exposed % Company OS rows', v_n;
  end if;
end
$$;
reset role;
update ops.jobs set lease_expires_at = now() - interval '1 second'
 where id = current_setting('c1c.job_c')::uuid;
set local role ops_worker;
do $$
declare
  v_n bigint;
begin
  perform set_config('app.worker_id', 'c1c-worker-c', true);
  perform set_config('app.job_id', current_setting('c1c.job_c'), true);
  select (select count(*) from ops.companies) + (select count(*) from ops.departments)
       + (select count(*) from ops.agents) + (select count(*) from ops.tasks)
       + (select count(*) from ops.events) + (select count(*) from ops.task_jobs)
    into v_n;
  if v_n <> 0 then
    raise exception 'C7: an expired lease exposed % Company OS rows', v_n;
  end if;
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
end
$$;
reset role;
revoke select on ops.companies, ops.departments, ops.agents, ops.tasks, ops.events, ops.task_jobs from ops_worker;

-- ===========================================================================
-- D. STRUCTURAL INTEGRITY, AS THE OWNER, WITH RAW DML.
--    Provenance is declared so that the only thing refusing each row is the
--    structure. Where a guard trigger stands in front of a foreign key, the key
--    is proven again with that trigger switched off.
-- ===========================================================================
select set_config('app.event_source', 'c1c-raw', true);

-- D1-D3 switch off the row's EMISSION trigger for the attempt. Its event would
-- carry the same bad (tenant, company) pair and be refused by the events foreign
-- key, so with emission on, a weakened departments or agents key would still
-- read as "refused" and this case would prove nothing about it.
select pg_temp.expect_refused_without_trigger('D1 a tenant-A department in a tenant-B company', '23503',
  'departments', 'departments_emit_created', format($q$
  insert into ops.departments (tenant_id, company_id, slug, name) values (%L, %L, 'cross', 'Cross')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));

select pg_temp.expect_refused_without_trigger('D2 a tenant-A agent in a tenant-B department', '23503',
  'agents', 'agents_emit_created', format($q$
  insert into ops.agents (tenant_id, company_id, department_id, slug, name, role) values (%L, %L, %L, 'cross', 'Cross', 'x')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_b')));

select pg_temp.expect_refused_without_trigger('D3 a company-A1 agent in a company-A2 department', '23503',
  'agents', 'agents_emit_created', format($q$
  insert into ops.agents (tenant_id, company_id, department_id, slug, name, role) values (%L, %L, %L, 'cross', 'Cross', 'x')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a2')));

select pg_temp.expect_refused('D4 a tenant-A task assigned a tenant-B agent (guard)', 'OS404', format($q$
  update ops.tasks set assigned_agent_id = %L, status = 'assigned' where id = %L
$q$, pg_temp.id('agent_b'), pg_temp.id('task_a1_nodept')));
select pg_temp.expect_refused_without_trigger('D4 a tenant-A task assigned a tenant-B agent (foreign key)', '23503',
  'tasks', 'tasks_guard_update', format($q$
  update ops.tasks set assigned_agent_id = %L, status = 'assigned' where id = %L
$q$, pg_temp.id('agent_b'), pg_temp.id('task_a1_nodept')));

select pg_temp.expect_refused('D5 a company-A1 task assigned a company-A2 agent (guard)', 'OS404', format($q$
  update ops.tasks set assigned_agent_id = %L, status = 'assigned' where id = %L
$q$, pg_temp.id('agent_a2'), pg_temp.id('task_a1_nodept')));
select pg_temp.expect_refused_without_trigger('D5 a company-A1 task assigned a company-A2 agent (foreign key)', '23503',
  'tasks', 'tasks_guard_update', format($q$
  update ops.tasks set assigned_agent_id = %L, status = 'assigned' where id = %L
$q$, pg_temp.id('agent_a2'), pg_temp.id('task_a1_nodept')));

-- The guard checks company, not department: this one is the four-column key alone.
select pg_temp.expect_refused('D6 a reception task assigned a marketing agent of the same company', '23503', format($q$
  update ops.tasks set assigned_agent_id = %L, status = 'assigned' where id = %L
$q$, pg_temp.id('agent_a1_marketing'), pg_temp.id('task_a1')));

select pg_temp.expect_refused('D7 a parent task in another company (guard)', 'OS404', format($q$
  insert into ops.tasks (tenant_id, company_id, type, title, parent_task_id) values (%L, %L, 'x.y', 'Child', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('task_a2')));
select pg_temp.expect_refused_without_trigger('D7 a parent task in another company (foreign key)', '23503',
  'tasks', 'tasks_guard_insert', format($q$
  insert into ops.tasks (tenant_id, company_id, type, title, parent_task_id) values (%L, %L, 'x.y', 'Child', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('task_a2')));

-- A foreign key is checked at the END of a statement, so without the insert
-- guard one multi-row INSERT stores a cycle the "parent exists first" argument
-- says is impossible.
select pg_temp.expect_refused('D8 a parent-task cycle in one multi-row INSERT', 'OS404', format($q$
  insert into ops.tasks (id, tenant_id, company_id, type, title, parent_task_id) values
    ('c1c00000-0000-4000-8000-000000000001', %L, %L, 'x.y', 'One', 'c1c00000-0000-4000-8000-000000000002'),
    ('c1c00000-0000-4000-8000-000000000002', %L, %L, 'x.y', 'Two', 'c1c00000-0000-4000-8000-000000000001')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('tenant_a'), pg_temp.id('company_a1')));

select pg_temp.expect_refused('D9 an event of tenant A about a company of tenant B', '23503', format($q$
  insert into ops.events (tenant_id, company_id, type, source) values (%L, %L, 'finance.cross', 'c1c-raw')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));

select pg_temp.expect_refused_without_trigger('D10 linking a tenant-A task to a tenant-B job', '23503',
  'task_jobs', 'task_jobs_emit_requested', format($q$
  insert into ops.task_jobs (tenant_id, job_id, company_id, task_id) values (%L, %L, %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('job_b'), pg_temp.id('company_a1'), pg_temp.id('task_a1')));
select pg_temp.expect_refused_without_trigger('D10 linking a tenant-A job to a tenant-B task', '23503',
  'task_jobs', 'task_jobs_emit_requested', format($q$
  insert into ops.task_jobs (tenant_id, job_id, company_id, task_id) values (%L, %L, %L, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('job_a'), pg_temp.id('company_b'), pg_temp.id('task_b')));

-- Re-parenting: a composite key only checks the NEW parent exists, so these are
-- the immutability guards' job.
select pg_temp.expect_refused('D11 moving a department to another tenant', 'OS409', format($q$
  update ops.departments set tenant_id = %L, company_id = %L where id = %L
$q$, pg_temp.id('tenant_b'), pg_temp.id('company_b'), pg_temp.id('dept_a1_marketing')));
select pg_temp.expect_refused('D11 moving an agent to another company', 'OS409', format($q$
  update ops.agents set company_id = %L, department_id = %L where id = %L
$q$, pg_temp.id('company_a2'), pg_temp.id('dept_a2'), pg_temp.id('agent_a1_marketing')));
select pg_temp.expect_refused('D11 moving an agent to another department', 'OS409', format($q$
  update ops.agents set department_id = %L where id = %L
$q$, pg_temp.id('dept_a1_marketing'), pg_temp.id('agent_a1_reception_two')));
select pg_temp.expect_refused('D11 moving a company to another tenant', 'OS409', format($q$
  update ops.companies set tenant_id = %L where id = %L
$q$, pg_temp.id('tenant_b'), pg_temp.id('company_a2')));
select pg_temp.expect_refused('D11 moving a task to another company', 'OS409', format($q$
  update ops.tasks set company_id = %L where id = %L
$q$, pg_temp.id('company_a2'), pg_temp.id('task_a1_nodept')));
-- (Rewriting a task_jobs link is attacked in section H, once a link exists: an
-- UPDATE that matches no row fires no trigger and would pass vacuously here.)

-- D12. The owner is outside this boundary by design — characterised, not relied
-- on. Replica mode switches off ORIGIN triggers and foreign-key checks, so the
-- guards on the UPDATE path are ENABLE ALWAYS and must still refuse.
set local session_replication_role = replica;
do $$
begin
  begin
    update ops.tasks set status = 'queued', assigned_agent_id = null where id = current_setting('c1c.task_b_closed')::uuid;
    raise exception 'D12: replica mode silenced the closed-task guard; guard triggers must be ENABLE ALWAYS';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    update ops.events set source = 'rewritten' where tenant_id = current_setting('c1c.tenant_a')::uuid;
    raise exception 'D12: an event was rewritten in replica mode';
  exception when sqlstate 'OS409' then null;
  end;
end
$$;
set local session_replication_role = origin;

select set_config('app.event_source', '', true);

-- ===========================================================================
-- E. SCOPE ATTACKS THROUGH THE DOMAIN FUNCTIONS.
--    Valid tenant-A authority does not make a company-B id trusted. Every id
--    outside the scope is "not found" — resolved in the same statement that reads
--    its state, so its state is never observable — and nothing is written.
-- ===========================================================================
select set_config('c1c.events_before_e', pg_temp.event_count()::text, true);

select pg_temp.expect_refused('E1 tenant A creates a department in company B', 'OS404', format($q$
  select ops.create_department(%L, %L, 'cross', 'Cross', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));
select pg_temp.expect_refused('E1 tenant A creates an agent in company B', 'OS404', format($q$
  select ops.create_agent(%L, %L, %L, 'cross', 'Cross', 'x', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b'), pg_temp.id('dept_b')));
select pg_temp.expect_refused('E1 tenant A creates a task in company B', 'OS404', format($q$
  select ops.create_task(%L, %L, 'x.y', 'Cross', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));
select pg_temp.expect_refused('E1 tenant A records an event about company B', 'OS404', format($q$
  select ops.record_event(%L, %L, 'finance.cross', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));
select pg_temp.expect_refused('E1 tenant A deactivates company B', 'OS404', format($q$
  select ops.set_company_status(%L, %L, 'inactive', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_b')));
select pg_temp.expect_refused('E2 tenant A assigns company B''s agent', 'OS404', format($q$
  select ops.assign_task(%L, %L, %L, 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1'), pg_temp.id('agent_b')));
select pg_temp.expect_refused('E2 tenant A transitions company B''s task', 'OS404', format($q$
  select ops.transition_task(%L, %L, 'cancelled', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_b')));
select pg_temp.expect_refused('E3 a company-A1 task assigned a company-A2 agent', 'OS404', format($q$
  select ops.assign_task(%L, %L, %L, 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1_nodept'), pg_temp.id('agent_a2')));
select pg_temp.expect_refused('E3 a company-A1 agent in a company-A2 department', 'OS404', format($q$
  select ops.create_agent(%L, %L, %L, 'cross', 'Cross', 'x', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('dept_a2')));
select pg_temp.expect_refused('E3 a company-A1 task under a company-A2 parent', 'OS404', format($q$
  select ops.create_task(%L, %L, 'x.y', 'Child', 'c1c-attack', null, null, %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('task_a2')));

-- E4. Scope is resolved BEFORE state: tenant B's inactive agent and closed task
-- must read as "not found", never as "inactive" or "closed".
select pg_temp.expect_refused('E4 tenant B''s inactive agent through tenant A', 'OS404', format($q$
  select ops.assign_task(%L, %L, %L, 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1'), pg_temp.id('agent_b_inactive')));
select pg_temp.expect_refused('E4 tenant B''s closed task through tenant A', 'OS404', format($q$
  select ops.transition_task(%L, %L, 'in_progress', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_b_closed')));
select pg_temp.expect_refused('E4 tenant B''s task with a refused kind through tenant A', 'OS404', format($q$
  select ops.request_task_execution(%L, %L, 'postmark.ledger_retention', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_b')));

-- E5. Missing tenant scope fails closed, on every service.
select pg_temp.expect_refused('E5 no tenant scope: create_company', 'OS401', $q$ select ops.create_company(null, 'x', 'X', 'c1c-attack') $q$);
select pg_temp.expect_refused('E5 no tenant scope: create_department', 'OS401', format($q$ select ops.create_department(null, %L, 'x', 'X', 'c1c-attack') $q$, pg_temp.id('company_a1')));
select pg_temp.expect_refused('E5 no tenant scope: create_agent', 'OS401', format($q$ select ops.create_agent(null, %L, %L, 'x', 'X', 'x', 'c1c-attack') $q$, pg_temp.id('company_a1'), pg_temp.id('dept_a1_reception')));
select pg_temp.expect_refused('E5 no tenant scope: create_task', 'OS401', format($q$ select ops.create_task(null, %L, 'x.y', 'X', 'c1c-attack') $q$, pg_temp.id('company_a1')));
select pg_temp.expect_refused('E5 no tenant scope: assign_task', 'OS401', format($q$ select ops.assign_task(null, %L, %L, 'c1c-attack') $q$, pg_temp.id('task_a1'), pg_temp.id('agent_a1_reception')));
select pg_temp.expect_refused('E5 no tenant scope: transition_task', 'OS401', format($q$ select ops.transition_task(null, %L, 'cancelled', 'c1c-attack') $q$, pg_temp.id('task_a1')));
select pg_temp.expect_refused('E5 no tenant scope: record_event', 'OS401', format($q$ select ops.record_event(null, %L, 'finance.x', 'c1c-attack') $q$, pg_temp.id('company_a1')));
select pg_temp.expect_refused('E5 no tenant scope: request_task_execution', 'OS401', format($q$ select ops.request_task_execution(null, %L, 'x.y', 'c1c-attack') $q$, pg_temp.id('task_a1')));
select pg_temp.expect_refused('E5 no tenant scope: set_agent_status', 'OS401', format($q$ select ops.set_agent_status(null, %L, 'inactive', 'c1c-attack') $q$, pg_temp.id('agent_a1_reception')));

-- E6. An unknown tenant finds nothing; a malformed one never reaches a body.
select pg_temp.expect_refused('E6 unknown tenant: create_company', 'OS404', $q$ select ops.create_company('00000000-0000-4000-8000-000000000000', 'x', 'X', 'c1c-attack') $q$);
select pg_temp.expect_refused('E6 unknown tenant: create_task', 'OS404', format($q$ select ops.create_task('00000000-0000-4000-8000-000000000000', %L, 'x.y', 'X', 'c1c-attack') $q$, pg_temp.id('company_a1')));
select pg_temp.expect_refused('E6 malformed tenant: create_company', '22P02', $q$ select ops.create_company('not-a-uuid', 'x', 'X', 'c1c-attack') $q$);

do $$
begin
  if pg_temp.event_count() <> current_setting('c1c.events_before_e')::bigint then
    raise exception 'E7: a refused domain call wrote % event(s)', pg_temp.event_count() - current_setting('c1c.events_before_e')::bigint;
  end if;
  if exists (select 1 from ops.tasks where id = current_setting('c1c.task_a1')::uuid and assigned_agent_id is not null) then
    raise exception 'E7: a refused assignment changed the task';
  end if;
end
$$;

-- E8. INVOKER is load-bearing: an EXECUTE grant alone confers nothing.
grant execute on function ops.create_company(uuid, text, text, text, uuid, uuid) to ops_worker;
set local role ops_worker;
do $$
begin
  begin
    perform ops.create_company(current_setting('c1c.tenant_a')::uuid, 'granted-exec', 'Granted', 'c1c-worker');
    raise exception 'E8: an EXECUTE grant alone let a worker write Company OS data';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
revoke execute on function ops.create_company(uuid, text, text, text, uuid, uuid) from ops_worker;

-- ===========================================================================
-- F. THE TASK STATE MACHINE.
-- ===========================================================================

-- F1. Every ordered pair of distinct statuses, attempted with a RAW UPDATE as
--     the owner, so the database — not a function — is what decides. The oracle
--     is the LITERAL list of the 11 declared edges below, never the database's
--     own helper: with ops.task_transition_allowed() as the oracle, a mutation
--     that made every transition legal went unnoticed for every open task, because
--     the guard and the oracle agreed (mutation M03). The database's relation and
--     helper are then checked against the same list.
do $$
declare
  c_edges    constant text[] := array[
    'queued>assigned', 'queued>cancelled', 'assigned>in_progress', 'assigned>cancelled',
    'in_progress>waiting', 'in_progress>completed', 'in_progress>failed', 'in_progress>cancelled',
    'waiting>in_progress', 'waiting>failed', 'waiting>cancelled'];
  c_statuses constant text[] := array['queued', 'assigned', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled'];
  ta   constant uuid := current_setting('c1c.tenant_a')::uuid;
  ca1  constant uuid := current_setting('c1c.company_a1')::uuid;
  da1r constant uuid := current_setting('c1c.dept_a1_reception')::uuid;
  ga1r constant uuid := current_setting('c1c.agent_a1_reception')::uuid;
  v_from     text;
  v_to       text;
  v_task     uuid;
  v_allowed  boolean;
  v_accepted boolean;
  v_state    text;
  v_edges    integer := 0;
  v_refused  integer := 0;
begin
  foreach v_from in array c_statuses loop
    foreach v_to in array c_statuses loop
      continue when v_from = v_to;

      v_task := ops.create_task(ta, ca1, 'matrix.probe', 'Matrix', 'c1c-matrix', null, da1r);
      case v_from
        when 'queued' then null;
        when 'assigned' then
          perform ops.assign_task(ta, v_task, ga1r, 'c1c-matrix');
        when 'in_progress' then
          perform ops.assign_task(ta, v_task, ga1r, 'c1c-matrix');
          perform ops.transition_task(ta, v_task, 'in_progress', 'c1c-matrix');
        when 'waiting' then
          perform ops.assign_task(ta, v_task, ga1r, 'c1c-matrix');
          perform ops.transition_task(ta, v_task, 'in_progress', 'c1c-matrix');
          perform ops.transition_task(ta, v_task, 'waiting', 'c1c-matrix');
        when 'cancelled' then
          perform ops.transition_task(ta, v_task, 'cancelled', 'c1c-matrix');
        else
          perform ops.assign_task(ta, v_task, ga1r, 'c1c-matrix');
          perform ops.transition_task(ta, v_task, 'in_progress', 'c1c-matrix');
          perform ops.transition_task(ta, v_task, v_from, 'c1c-matrix');
      end case;

      v_allowed := (v_from || '>' || v_to) = any (c_edges);
      perform set_config('app.event_source', 'c1c-matrix-raw', true);
      begin
        update ops.tasks
           set status = v_to,
               assigned_agent_id = case when v_to = 'queued' then null else coalesce(assigned_agent_id, ga1r) end
         where id = v_task;
        v_accepted := true;
      exception when others then
        v_accepted := false;
        v_state := sqlstate;
      end;
      perform set_config('app.event_source', '', true);

      if v_accepted <> v_allowed then
        raise exception 'F1: illegal task transition accepted, or a legal one refused: % -> % was %, the state machine says %',
          v_from, v_to, case when v_accepted then 'ACCEPTED' else 'refused (' || v_state || ')' end,
          case when v_allowed then 'allowed' else 'forbidden' end;
      end if;
      if not v_accepted and v_state <> 'OS409' then
        raise exception 'F1: % -> % was refused for the wrong reason (%)', v_from, v_to, v_state;
      end if;
      -- The helper the guard consults must agree with the declared edges too.
      if ops.task_transition_allowed(v_from, v_to) is distinct from v_allowed then
        raise exception 'F1: ops.task_transition_allowed(%, %) disagrees with the declared state machine', v_from, v_to;
      end if;
      if v_accepted then v_edges := v_edges + 1; else v_refused := v_refused + 1; end if;
    end loop;
  end loop;

  if v_edges <> cardinality(c_edges) or v_edges + v_refused <> 42 then
    raise exception 'F1: % edges accepted and % pairs refused; expected the % declared edges and 42 pairs in total',
      v_edges, v_refused, cardinality(c_edges);
  end if;
  if (select count(*) from ops.task_status_transitions()) <> cardinality(c_edges)
     or exists (select 1 from ops.task_status_transitions() t
                 where not ((t.from_status || '>' || t.to_status) = any (c_edges))) then
    raise exception 'F1: ops.task_status_transitions() differs from the declared edges';
  end if;
end
$$;

-- F2. A task is born queued and unassigned.
select set_config('app.event_source', 'c1c-raw', true);
select pg_temp.expect_refused('F2 a task born completed', 'OS409', format($q$
  insert into ops.tasks (tenant_id, company_id, type, title, status, completed_at) values (%L, %L, 'x.y', 'Born closed', 'completed', now())
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('F2 a task born in progress', 'OS409', format($q$
  insert into ops.tasks (tenant_id, company_id, type, title, status, assigned_agent_id) values (%L, %L, 'x.y', 'Born busy', 'in_progress', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('agent_a1_reception')));

-- F3. A closed task is immutable — every column, not only its status.
select pg_temp.expect_refused('F3 rewriting a closed task''s title', 'OS409', format($q$
  update ops.tasks set title = 'Rewritten' where id = %L
$q$, pg_temp.id('task_b_closed')));
select pg_temp.expect_refused('F3 assigning a closed task', 'OS409', format($q$
  update ops.tasks set assigned_agent_id = %L where id = %L
$q$, pg_temp.id('agent_b'), pg_temp.id('task_b_closed')));
select set_config('app.event_source', '', true);

-- F4. The function path refuses the same things, for the right reasons.
select pg_temp.expect_refused('F4 transition into assigned', 'OS409', format($q$
  select ops.transition_task(%L, %L, 'assigned', 'c1c-test')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1')));
select pg_temp.expect_refused('F4 queued -> completed', 'OS409', format($q$
  select ops.transition_task(%L, %L, 'completed', 'c1c-test')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1')));
select pg_temp.expect_refused('F4 an unknown status', 'OS409', format($q$
  select ops.transition_task(%L, %L, 'thinking', 'c1c-test')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1')));
select pg_temp.expect_refused('F4 a closed task', 'OS409', format($q$
  select ops.transition_task(%L, %L, 'in_progress', 'c1c-test')
$q$, pg_temp.id('tenant_b'), pg_temp.id('task_b_closed')));

-- F5. Deterministic assignment.
select pg_temp.expect_refused('F5 an inactive agent', 'OS409', format($q$
  select ops.assign_task(%L, %L, %L, 'c1c-test')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1'), pg_temp.id('agent_a1_inactive')));
select pg_temp.expect_refused('F5 an agent outside the task''s department', 'OS409', format($q$
  select ops.assign_task(%L, %L, %L, 'c1c-test')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1'), pg_temp.id('agent_a1_marketing')));
select pg_temp.expect_refused('F5 a closed task', 'OS409', format($q$
  select ops.assign_task(%L, %L, %L, 'c1c-test')
$q$, pg_temp.id('tenant_b'), pg_temp.id('task_b_closed'), pg_temp.id('agent_b')));
select set_config('app.event_source', 'c1c-raw', true);
select pg_temp.expect_refused('F5 a raw assignment to an inactive agent', 'OS409', format($q$
  update ops.tasks set assigned_agent_id = %L, status = 'assigned' where id = %L
$q$, pg_temp.id('agent_a1_inactive'), pg_temp.id('task_a1')));
select set_config('app.event_source', '', true);
select pg_temp.expect_refused('F5 an inactive company takes no new tasks', 'OS409', format($q$
  select ops.create_task(%L, %L, 'x.y', 'Late', 'c1c-test')
$q$, pg_temp.id('tenant_a'), (select pg_temp.id('company_a2') from (select ops.set_company_status(pg_temp.id('tenant_a'), pg_temp.id('company_a2'), 'inactive', 'c1c-test')) s)));
select ops.set_company_status(pg_temp.id('tenant_a'), pg_temp.id('company_a2'), 'active', 'c1c-test');

-- F6. completed_at is derived, never supplied.
do $$
declare
  ta   constant uuid := current_setting('c1c.tenant_a')::uuid;
  v_task uuid;
  v_completed timestamptz;
begin
  v_task := ops.create_task(ta, current_setting('c1c.company_a1')::uuid, 'x.y', 'Derived', 'c1c-test');
  perform ops.assign_task(ta, v_task, current_setting('c1c.agent_a1_reception')::uuid, 'c1c-test');
  perform set_config('app.event_source', 'c1c-raw', true);
  update ops.tasks set status = 'in_progress', completed_at = now() - interval '1 year' where id = v_task;
  perform set_config('app.event_source', '', true);
  select completed_at into v_completed from ops.tasks where id = v_task;
  if v_completed is not null then
    raise exception 'F6: a caller-supplied completed_at survived on an open task';
  end if;
  perform ops.transition_task(ta, v_task, 'failed', 'c1c-test');
  select completed_at into v_completed from ops.tasks where id = v_task;
  if v_completed is null then
    raise exception 'F6: a failed task has no completed_at';
  end if;
end
$$;

-- ===========================================================================
-- G. EVENTS.
-- ===========================================================================

-- G1. Exactly one fact per change, in order, and none for a no-op.
do $$
declare
  ta    constant uuid := current_setting('c1c.tenant_a')::uuid;
  ca1   constant uuid := current_setting('c1c.company_a1')::uuid;
  v_task  uuid;
  v_types text[];
begin
  v_task := ops.create_task(ta, ca1, 'crm.call', 'Events', 'c1c-events', null,
                            current_setting('c1c.dept_a1_reception')::uuid);
  perform ops.assign_task(ta, v_task, current_setting('c1c.agent_a1_reception')::uuid, 'c1c-events');
  perform ops.assign_task(ta, v_task, current_setting('c1c.agent_a1_reception')::uuid, 'c1c-events');      -- no-op
  perform ops.assign_task(ta, v_task, current_setting('c1c.agent_a1_reception_two')::uuid, 'c1c-events');  -- reassign
  perform ops.transition_task(ta, v_task, 'in_progress', 'c1c-events');
  perform ops.transition_task(ta, v_task, 'in_progress', 'c1c-events');                                     -- no-op
  perform set_config('app.event_source', 'c1c-events', true);
  update ops.tasks set status = status, assigned_agent_id = assigned_agent_id where id = v_task;            -- no-op
  perform set_config('app.event_source', '', true);
  perform ops.transition_task(ta, v_task, 'waiting', 'c1c-events');
  perform ops.transition_task(ta, v_task, 'in_progress', 'c1c-events');
  perform ops.transition_task(ta, v_task, 'completed', 'c1c-events');
end
$$;

do $$
declare
  v_types text[];
  v_task  uuid;
begin
  select e.subject_id into v_task
    from ops.events e
   where e.type = 'task.created' and e.source = 'c1c-events'
   order by e.seq desc limit 1;
  select array_agg(e.type order by e.seq) into v_types
    from ops.events e where e.subject_type = 'task' and e.subject_id = v_task;
  if v_types is distinct from array['task.created', 'task.assigned', 'task.assigned', 'task.status_changed',
                                    'task.status_changed', 'task.status_changed', 'task.completed'] then
    raise exception 'G1: a lifecycle operation did not emit exactly its one event, in order: %', v_types;
  end if;
  if (select e.payload ->> 'to_status' from ops.events e
       where e.subject_id = v_task and e.type = 'task.assigned' order by e.seq limit 1) <> 'assigned' then
    raise exception 'G1: queued -> assigned did not carry its status change in task.assigned';
  end if;
end
$$;

-- G2. Organisational status changes: one event each, none for a no-op.
do $$
declare
  ta  constant uuid := current_setting('c1c.tenant_a')::uuid;
  da  constant uuid := current_setting('c1c.dept_a1_marketing')::uuid;
  v_n bigint;
begin
  perform ops.set_department_status(ta, da, 'active', 'c1c-org');    -- no-op
  perform ops.set_department_status(ta, da, 'inactive', 'c1c-org');
  perform ops.set_department_status(ta, da, 'active', 'c1c-org');
  select count(*) into v_n from ops.events where subject_id = da and type = 'department.status_changed';
  if v_n <> 2 then
    raise exception 'G2: % department.status_changed events for two real changes and one no-op', v_n;
  end if;
end
$$;

-- G3. A change with no declared provenance is refused, not recorded anonymously.
select pg_temp.expect_refused('G3 a raw company insert without provenance', 'OS400', format($q$
  insert into ops.companies (tenant_id, slug, name) values (%L, 'anonymous', 'Anonymous')
$q$, pg_temp.id('tenant_a')));
select pg_temp.expect_refused('G3 a raw status change without provenance', 'OS400', format($q$
  update ops.agents set status = 'inactive' where id = %L
$q$, pg_temp.id('agent_a1_reception_two')));

-- G4. Atomicity: if the event cannot be written, neither is the change.
do $$
begin
  perform set_config('app.event_source', 'NOT A VALID SOURCE', true);
  begin
    insert into ops.companies (tenant_id, slug, name)
    values (current_setting('c1c.tenant_a')::uuid, 'orphan-change', 'Orphan');
    raise exception 'G4: a mutation committed without its event';
  exception when check_violation then null;
  end;
  perform set_config('app.event_source', '', true);
  if exists (select 1 from ops.companies where slug = 'orphan-change') then
    raise exception 'G4: a mutation survived the failure of its event';
  end if;
end
$$;

-- G5. Facts are never rewritten.
select pg_temp.expect_refused('G5 rewriting an event', 'OS409', format($q$
  update ops.events set payload = '{}'::jsonb where tenant_id = %L
$q$, pg_temp.id('tenant_a')));

-- G6. Lifecycle facts cannot be recorded, only derived — `job.` included.
select pg_temp.expect_refused('G6 record_event forging task.completed', 'OS403', format($q$
  select ops.record_event(%L, %L, 'task.completed', 'c1c-attack', 'task', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('task_a1')));
select pg_temp.expect_refused('G6 record_event forging job.succeeded', 'OS403', format($q$
  select ops.record_event(%L, %L, 'job.succeeded', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));
select pg_temp.expect_refused('G6 a raw insert forging company.status_changed', 'OS403', format($q$
  insert into ops.events (tenant_id, company_id, type, source) values (%L, %L, 'company.status_changed', 'c1c-attack')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));

-- G6b. Each layer holds on its own. Both record_event and the events_guard_insert
-- trigger refuse a lifecycle namespace with OS403, so G6 alone stayed green with
-- the function's check deleted (mutation M16): the trigger refused in its place.
-- With the trigger switched off, the function must still refuse.
select pg_temp.expect_refused_without_trigger('G6b record_event forging task.completed with the table guard off', 'OS403', 'events', 'events_guard_insert', format($q$
  select ops.record_event(%L, %L, 'task.completed', 'c1c-attack', 'task', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('task_a1')));

-- G6c. That state is not hypothetical: replica mode, the owner's restore mode,
-- silences events_guard_insert (an ORIGIN trigger), and then the function's own
-- check is the only thing between a caller and a forged lifecycle fact.
set local session_replication_role = replica;
do $$
begin
  begin
    perform ops.record_event(current_setting('c1c.tenant_a')::uuid, current_setting('c1c.company_a1')::uuid,
                             'task.completed', 'c1c-attack');
    raise exception 'G6c: record_event forged a lifecycle event in replica mode';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;
set local session_replication_role = origin;

-- G7. An event's subject and cause live in its own company.
select pg_temp.expect_refused('G7 a subject in another company', 'OS404', format($q$
  select ops.record_event(%L, %L, 'finance.payment_received', 'c1c-record', 'task', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('task_a2')));
select pg_temp.expect_refused('G7 another company as the company subject', 'OS404', format($q$
  select ops.record_event(%L, %L, 'finance.payment_received', 'c1c-record', 'company', %L)
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('company_a2')));
select pg_temp.expect_refused('G7 a cause in another company', 'OS404', format($q$
  select ops.record_event(%L, %L, 'finance.payment_received', 'c1c-record', null, null, '{}'::jsonb, null,
    (select e.id from ops.events e where e.company_id = %L limit 1))
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1'), pg_temp.id('company_a2')));
select pg_temp.expect_refused('G7 an event that is its own cause', 'OS404', format($q$
  insert into ops.events (id, tenant_id, company_id, type, source, causation_id)
  values ('c1c00000-0000-4000-8000-0000000000ee', %L, %L, 'finance.self', 'c1c-record', 'c1c00000-0000-4000-8000-0000000000ee')
$q$, pg_temp.id('tenant_a'), pg_temp.id('company_a1')));

do $$
declare
  v_cause uuid;
  v_id    uuid;
begin
  -- A legitimate fact with a legitimate cause, so G7's refusals are not a broken guard.
  select e.id into v_cause from ops.events e
   where e.company_id = current_setting('c1c.company_a1')::uuid order by e.seq limit 1;
  v_id := ops.record_event(current_setting('c1c.tenant_a')::uuid, current_setting('c1c.company_a1')::uuid,
    'finance.payment_received', 'c1c-record', 'task', current_setting('c1c.task_a1')::uuid,
    '{"amount_cents": 12000}'::jsonb, gen_random_uuid(), v_cause);
  if v_id is null then
    raise exception 'G7: a valid business fact could not be recorded';
  end if;
end
$$;

-- G8. Provenance composes and does not leak.
do $$
begin
  perform set_config('app.event_source', 'c1c-outer', true);
  perform ops.create_department(current_setting('c1c.tenant_a')::uuid, current_setting('c1c.company_a1')::uuid,
                                'finance', 'Finance', 'c1c-inner');
  if current_setting('app.event_source', true) is distinct from 'c1c-outer' then
    raise exception 'G8: a domain call clobbered its caller''s event provenance (now %)', current_setting('app.event_source', true);
  end if;
  perform set_config('app.event_source', '', true);

  perform ops.create_department(current_setting('c1c.tenant_a')::uuid, current_setting('c1c.company_a1')::uuid,
                                'legal', 'Legal', 'c1c-inner');
  begin
    insert into ops.companies (tenant_id, slug, name)
    values (current_setting('c1c.tenant_a')::uuid, 'borrowed-provenance', 'Borrowed');
    raise exception 'G8: a domain call leaked its event provenance to the raw DML after it';
  exception when sqlstate 'OS400' then null;
  end;

  if (select source from ops.events where type = 'department.created'
       and payload ->> 'slug' = 'finance' and company_id = current_setting('c1c.company_a1')::uuid) <> 'c1c-inner' then
    raise exception 'G8: the event did not record the provenance its call declared';
  end if;
end
$$;

-- G9. Payload minimisation, and no trigger emitting outside a reserved namespace.
do $$
declare
  v_bad text;
begin
  if exists (select 1 from ops.events where type = 'task.created' and (payload ? 'title' or payload ? 'description')) then
    raise exception 'G9: a task.created event carries free text a human typed';
  end if;
  select string_agg(distinct type, ', ') into v_bad
    from ops.events
   where tenant_id in (current_setting('c1c.tenant_a')::uuid, current_setting('c1c.tenant_b')::uuid)
     and source <> 'c1c-record'
     and not (split_part(type, '.', 1) = any (ops.derived_event_namespaces()));
  if v_bad is not null then
    raise exception 'G9: a trigger emitted an event outside the reserved lifecycle namespaces: %', v_bad;
  end if;
end
$$;

-- ===========================================================================
-- H. THE TASK -> JOB BRIDGE.
-- ===========================================================================

-- H1. Phase 1C ships no executable kind: even the one registered handler is refused.
select set_config('c1c.jobs_before_h', (select count(*) from ops.jobs)::text, true);
select pg_temp.expect_refused('H1 a real handler kind through an empty allowlist', 'OS403', format($q$
  select ops.request_task_execution(%L, %L, 'postmark.ledger_retention', 'c1c-bridge')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1')));
select pg_temp.expect_refused('H1 an unknown kind', 'OS403', format($q$
  select ops.request_task_execution(%L, %L, 'attacker.arbitrary_code', 'c1c-bridge')
$q$, pg_temp.id('tenant_a'), pg_temp.id('task_a1')));
do $$
begin
  if (select count(*) from ops.jobs) <> current_setting('c1c.jobs_before_h')::bigint then
    raise exception 'H1: a non-allowlisted kind was enqueued';
  end if;
end
$$;

-- H2..H6. The positive path, through an allowlist replaced INSIDE this
-- transaction, so the bridge's success path is proven without shipping a kind.
create or replace function ops.task_executable_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $f$ select array['c1c.bridge_probe']::text[] $f$;

do $$
declare
  ta    constant uuid := current_setting('c1c.tenant_a')::uuid;
  tb    constant uuid := current_setting('c1c.tenant_b')::uuid;
  v_task  uuid;
  v_other uuid;
  v_job   uuid;
  v_again uuid;
  v_n     bigint;
  v_forged uuid;
begin
  v_task := ops.create_task(ta, current_setting('c1c.company_a1')::uuid, 'crm.export', 'Bridge', 'c1c-bridge');

  -- H2. The job's tenant is the task's, whatever the payload claims.
  v_job := ops.request_task_execution(ta, v_task, 'c1c.bridge_probe', 'c1c-bridge',
                                      jsonb_build_object('tenant_id', tb, 'company_id', current_setting('c1c.company_b')), 'run-1');
  if (select tenant_id from ops.jobs where id = v_job) is distinct from ta then
    raise exception 'H2: a task job took its tenant from the payload';
  end if;
  if not exists (select 1 from ops.task_jobs where tenant_id = ta and job_id = v_job and task_id = v_task) then
    raise exception 'H2: the bridge enqueued a job without linking it to its task';
  end if;
  -- The bridge inserts its own job, so it owes the execution trail the same
  -- `enqueued` row ops.enqueue_job writes.
  if (select count(*) from ops.job_events where job_id = v_job and tenant_id = ta and event = 'enqueued') <> 1 then
    raise exception 'H2: the bridge enqueued a job with no enqueued job event';
  end if;
  select count(*) into v_n from ops.events where subject_id = v_task and type = 'task.execution_requested'
     and payload ->> 'job_id' = v_job::text;
  if v_n <> 1 then
    raise exception 'H2: % task.execution_requested events for one request', v_n;
  end if;
  if (select status from ops.tasks where id = v_task) <> 'queued' then
    raise exception 'H2: requesting execution changed the task''s business state';
  end if;
  -- A link is history: never rewritten, not even to itself.
  begin
    update ops.task_jobs set task_id = task_id where tenant_id = ta and job_id = v_job;
    raise exception 'H2: a task job link was rewritten';
  exception when sqlstate 'OS409' then null;
  end;

  -- H3. The same request again is the same job: no second link, no second fact.
  v_again := ops.request_task_execution(ta, v_task, 'c1c.bridge_probe', 'c1c-bridge', '{}'::jsonb, 'run-1');
  if v_again is distinct from v_job then
    raise exception 'H3: a repeated request produced a different job';
  end if;
  select count(*) into v_n from ops.events where subject_id = v_task and type = 'task.execution_requested';
  if v_n <> 1 then
    raise exception 'H3: a repeated request recorded a second fact';
  end if;

  -- H4. Another task using the same key gets its own job, never this one.
  v_other := ops.create_task(ta, current_setting('c1c.company_a1')::uuid, 'crm.export', 'Other', 'c1c-bridge');
  v_again := ops.request_task_execution(ta, v_other, 'c1c.bridge_probe', 'c1c-bridge', '{}'::jsonb, 'run-1');
  if v_again = v_job then
    raise exception 'H4: the bridge adopted a job its task did not request (another task''s)';
  end if;

  -- H5. A job enqueued outside the bridge under this task's own key is refused,
  --     not adopted as if the task had requested it.
  v_forged := ops.enqueue_job(ta, 'c1c.bridge_probe', '{}'::jsonb, 100, now(), 5, format('task:%s:run-2', v_task));
  begin
    perform ops.request_task_execution(ta, v_task, 'c1c.bridge_probe', 'c1c-bridge', '{}'::jsonb, 'run-2');
    raise exception 'H5: the bridge adopted a job its task did not request (enqueued outside the bridge)';
  exception when sqlstate 'OS409' then null;
  end;
  if exists (select 1 from ops.task_jobs where tenant_id = ta and job_id = v_forged) then
    raise exception 'H5: a refused request still linked the job';
  end if;

  -- H6. A closed task requests nothing.
  perform ops.transition_task(ta, v_other, 'cancelled', 'c1c-bridge');
  begin
    perform ops.request_task_execution(ta, v_other, 'c1c.bridge_probe', 'c1c-bridge');
    raise exception 'H6: a closed task requested execution';
  exception when sqlstate 'OS409' then null;
  end;

  -- H7. A payload that is not an object is refused.
  begin
    perform ops.request_task_execution(ta, v_task, 'c1c.bridge_probe', 'c1c-bridge', '[1, 2]'::jsonb);
    raise exception 'H7: a non-object payload was enqueued';
  exception when sqlstate 'OS400' then null;
  end;

  -- H8. An oversize key is a typed refusal, not a btree size error.
  begin
    perform ops.request_task_execution(ta, v_task, 'c1c.bridge_probe', 'c1c-bridge', '{}'::jsonb, repeat('k', 201));
    raise exception 'H8: an oversize idempotency key reached the queue';
  exception when sqlstate 'OS400' then null;
  end;
end
$$;

rollback;

-- Nothing above committed.
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'c1c-test-%') then
    raise exception 'company_domain_core.sql left fixtures behind';
  end if;
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'company_domain_core.sql left the test allowlist in place';
  end if;
end
$$;
