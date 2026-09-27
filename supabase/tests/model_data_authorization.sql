-- BASELINE Q8 enforcement (ADR 0020 §D, §G), attacked in SQL.
--
-- The question: can data of a protected or unknown class reach a model
-- provider without an owner authorization in force for its exact binding, can
-- anything but the owner create one, and can a task's class be changed?
--
--   A  the early refusal at the request: absent, unclassified, never-authorizable,
--      another purpose and another tenant are all refused on the record, no job;
--   B  the authoritative gate at the start: the exact provider and model, or
--      cancelled data_not_authorized before any price or call; the version
--      relied on recorded on the run;
--   C  retired, expired and future authorizations do not admit;
--   D  a stop holds before the gate refuses;
--   E  synthetic, test and the in-process fake are unaffected;
--   F  nothing from the browser, the gateway, the worker or PostgREST authorizes;
--   G  the task's class is fixed at creation (SI-71), and create_task takes it
--      explicitly;
--   H  the authorization record: the closed classes, the owner decisions' bar
--      (D1, D4, D5, D6, D9), versioning, and immutability;
--   I  the run guard on every write path: no start of protected data without
--      the authorization in force; the class derived, never taken;
--   K  the decision-shadow start uses the same check, and nothing authorizes it
--      for protected data;
--   L  the admission derives the class from provenance.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data and fake evidence references only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

create temporary table q8_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into q8_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from q8_ids where name = p_name;
  if v is null then raise exception 'setup: no id named %', p_name; end if;
  return v;
end
$$;

-- The SQLSTATE a statement raised, or NULL when it succeeded (and then its
-- effects stay, inside this suite's rolled-back transaction).
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

-- An assigned task of the given class in tenant a (or b).
create function pg_temp.task(p_key text, p_class text, p_tenant text default 'a') returns uuid
language plpgsql as $f$
declare v uuid;
begin
  v := ops.create_task(pg_temp.id(p_tenant || '.tenant'), pg_temp.id(p_tenant || '.company'), 'lead_triage',
                       'Lead triage', 'q8-suite', 'SENTINEL-Q8-BODY-' || p_key || ' synthetic text',
                       p_data_class => p_class);
  perform ops.assign_task(pg_temp.id(p_tenant || '.tenant'), v, pg_temp.id(p_tenant || '.agent'), 'q8-suite');
  return pg_temp.remember('task.' || p_key, v);
end
$f$;

create function pg_temp.request(p_key text, p_tenant text default 'a', p_capability text default 'lead_triage')
returns uuid
language sql as $$
  select pg_temp.remember('run.' || p_key,
    ops.request_agent_run(pg_temp.id(p_tenant || '.tenant'), pg_temp.id('task.' || p_key),
                          pg_temp.id(p_tenant || '.agent'), p_capability, 'q8-' || p_key, 'q8-suite'));
$$;

-- Lease the run's job as the worker, claim and start it, and answer the start.
create function pg_temp.start(p_key text, p_provider text, p_model text) returns text
language plpgsql as $f$
declare
  v_job uuid;
  v     text;
begin
  select r.job_id into v_job from ops.agent_runs r where r.id = pg_temp.id('run.' || p_key);
  update ops.jobs
     set status = 'leased', lease_owner = 'q8-worker', leased_at = now(),
         lease_expires_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
   where id = v_job and status = 'queued';
  if not found then
    raise exception 'setup: job of % is not queued', p_key;
  end if;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  select j.id, j.tenant_id, 'leased', 'q8-worker', j.attempts, j.kind from ops.jobs j where j.id = v_job;
  perform set_config('app.worker_id', 'q8-worker', true);
  perform set_config('app.job_id', v_job::text, true);
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  v := ops.start_agent_run(p_provider, p_model, 'lead_triage.v2',
                           encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), 8000);
  execute 'reset role';
  return v;
end
$f$;

-- One authorization with a complete set of FAKE evidence references.
create function pg_temp.authorize(p_class text, p_capability text, p_provider text, p_model text,
                                  p_tenant text default 'a', p_valid_from timestamptz default now() - interval '1 hour',
                                  p_expires_at timestamptz default now() + interval '30 days',
                                  p_lawful_basis text default 'fixture:lawful-basis:v1',
                                  p_training_excluded boolean default true,
                                  p_retention_days integer default 30)
returns uuid
language sql as $$
  select ops.record_model_data_authorization(
    pg_temp.id(p_tenant || '.tenant'), p_class, p_capability, p_provider, p_model, p_valid_from, p_expires_at,
    'fixture:provider-evidence:v1', now() - interval '2 hours', p_training_excluded,
    case when p_class = 'operational' then null else 'fixture:contract:v1' end,
    case when p_class = 'operational' then null else 'fixture:dpa:v1' end,
    case when p_class = 'operational' then null else 'fixture:zdr:v1' end,
    case when p_class = 'operational' then null else 'fixture:retention:v1' end,
    case when p_class = 'operational' then null else 'fixture:transfer:v1' end,
    case when p_class = 'operational' then null else p_lawful_basis end,
    case when p_class = 'operational' then null else p_retention_days end,
    'q8-suite');
$$;

create function pg_temp.run(p_key text) returns ops.agent_runs
language sql as $$ select r.* from ops.agent_runs r where r.id = pg_temp.id('run.' || p_key); $$;

do $$
declare
  ta uuid; tb uuid; co uuid; d uuid; cob uuid; db uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('q8-test-alpha', 'Q8 Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('q8-test-beta', 'Q8 Beta') returning id into tb;
  perform pg_temp.remember('a.tenant', ta);
  perform pg_temp.remember('b.tenant', tb);
  perform ops.record_model_price('openai', 'q8-model-a', 1.25, 2.5, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'q8 price source', 'q8-suite');
  perform ops.record_model_price('openai', 'q8-model-b', 1.25, 2.5, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'q8 price source', 'q8-suite');
  perform ops.record_model_price('fake', 'q8-fake', 1.25, 2.5, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'q8 price source', 'q8-suite');
  perform ops.set_spend_limit('global', 900000000000, 'UTC', 'q8 ceiling', 'q8-suite');
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'q8 budget', 'q8-suite', ta);
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'q8 budget', 'q8-suite', tb);
  co := pg_temp.remember('a.company', ops.create_company(ta, 'q8-clinic', 'Q8 Clinic', 'q8-suite'));
  d := ops.create_department(ta, co, 'intake', 'Intake', 'q8-suite');
  perform pg_temp.remember('a.agent', ops.create_agent(ta, co, d, 'triage', 'Q8 Triage', 'Synthetic role', 'q8-suite'));
  cob := pg_temp.remember('b.company', ops.create_company(tb, 'q8-clinic-b', 'Q8 Clinic B', 'q8-suite'));
  db := ops.create_department(tb, cob, 'intake', 'Intake B', 'q8-suite');
  perform pg_temp.remember('b.agent', ops.create_agent(tb, cob, db, 'triage', 'Q8 Triage B', 'Synthetic role', 'q8-suite'));
end
$$;

-- ===========================================================================
-- A. The early refusal at the request.
-- ===========================================================================

do $$
declare
  r ops.agent_runs;
  k text;
begin
  foreach k in array array['health', 'unclassified', 'clinical_record', 'identifier', 'derived', 'person_text', 'operational'] loop
    perform pg_temp.task('a-' || k, case when k = 'unclassified' then null else k end);
    perform pg_temp.request('a-' || k);
    r := pg_temp.run('a-' || k);
    if r.status <> 'cancelled' or r.error_category <> 'refused' or r.error_code <> 'data_not_authorized'
       or r.job_id is not null or r.data_class is distinct from k then
      raise exception 'A1: a % run with no authorization was not refused at its request with no job (%, %, %, job %)',
        k, r.status, r.error_code, r.data_class, r.job_id;
    end if;
    if exists (select 1 from ops.jobs j where j.tenant_id = r.tenant_id and j.payload ->> 'agent_run_id' = r.id::text) then
      raise exception 'A1: a refused % request created a job', k;
    end if;
  end loop;

  -- The refusal is on the record, as a code, with no content.
  if not exists (select 1 from ops.events e
                  where e.subject_id = pg_temp.id('run.a-health') and e.type = 'agent_run.cancelled'
                    and e.payload ->> 'error_code' = 'data_not_authorized')
     or exists (select 1 from ops.events e where e.tenant_id = pg_temp.id('a.tenant')
                  and e.payload::text like '%SENTINEL-Q8-BODY%') then
    raise exception 'A2: the refusal is not a content-free fact on the record';
  end if;

  -- An authorization for another purpose does not admit this one, and one for
  -- another class does not admit health.
  perform pg_temp.authorize('operational', 'task_assessment', 'openai', 'q8-model-a');
  perform pg_temp.task('a-purpose', 'operational');
  perform pg_temp.request('a-purpose');
  if (pg_temp.run('a-purpose')).error_code is distinct from 'data_not_authorized' then
    raise exception 'A3: an authorization for another capability admitted a lead_triage run';
  end if;
  perform pg_temp.authorize('operational', 'lead_triage', 'openai', 'q8-model-a');
  perform pg_temp.task('a-class', 'health');
  perform pg_temp.request('a-class');
  if (pg_temp.run('a-class')).error_code is distinct from 'data_not_authorized' then
    raise exception 'A3: an operational authorization admitted health data';
  end if;

  -- An authorization of tenant a does not admit tenant b.
  perform pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-a');
  perform pg_temp.task('a-tenant-b', 'health', 'b');
  perform pg_temp.request('a-tenant-b', 'b');
  if (pg_temp.run('a-tenant-b')).error_code is distinct from 'data_not_authorized' then
    raise exception 'A4: tenant a''s authorization admitted tenant b''s data';
  end if;
end
$$;

-- ===========================================================================
-- B. The authoritative gate at the start.
-- ===========================================================================

do $$
declare
  r ops.agent_runs;
  v text;
  v_auth uuid := ops.model_data_authorization_in_force(pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-a');
begin
  if v_auth is null then
    raise exception 'B: setup: the lead_triage authorization is not in force';
  end if;

  -- Admitted at the request (some provider is authorized), refused at the start
  -- for another model: before the route, the price and the spend.
  perform pg_temp.task('b-model', 'health');
  perform pg_temp.request('b-model');
  if (pg_temp.run('b-model')).job_id is null then
    raise exception 'B1: setup: an authorized class was refused at the request';
  end if;
  v := pg_temp.start('b-model', 'openai', 'q8-model-b');
  r := pg_temp.run('b-model');
  if v <> 'cancelled' or r.error_code <> 'data_not_authorized' or r.provider is not null or r.price_id is not null
     or r.reserved_cost_micros is not null or r.data_authorization_id is not null or r.started_at is not null then
    raise exception 'B1: a start for a model no authorization names was not refused before any call (%, %)', v, r.error_code;
  end if;

  -- Another provider, same model: refused.
  perform pg_temp.task('b-provider', 'health');
  perform pg_temp.request('b-provider');
  v := pg_temp.start('b-provider', 'anthropic', 'q8-model-a');
  if v <> 'cancelled' or (pg_temp.run('b-provider')).error_code <> 'data_not_authorized' then
    raise exception 'B2: a start for a provider no authorization names was not refused (%)', v;
  end if;

  -- The exact binding: started, the version relied on recorded.
  perform pg_temp.task('b-exact', 'health');
  perform pg_temp.request('b-exact');
  v := pg_temp.start('b-exact', 'openai', 'q8-model-a');
  r := pg_temp.run('b-exact');
  if v <> 'running' or r.data_authorization_id is distinct from v_auth or r.data_class <> 'health' then
    raise exception 'B3: the exact binding did not start with its authorization recorded (%, %)', v, r.data_authorization_id;
  end if;
end
$$;

-- ===========================================================================
-- C. Retired, expired and future authorizations do not admit.
-- ===========================================================================

do $$
declare
  v text;
  v_auth uuid;
begin
  -- Retired between the request and the start: refused at the start.
  perform pg_temp.task('c-retired', 'health');
  perform pg_temp.request('c-retired');
  v_auth := ops.model_data_authorization_in_force(pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-a');
  if not ops.retire_model_data_authorization(v_auth, 'q8 drill', 'q8-suite') then
    raise exception 'C1: setup: the retire changed nothing';
  end if;
  v := pg_temp.start('c-retired', 'openai', 'q8-model-a');
  if v <> 'cancelled' or (pg_temp.run('c-retired')).error_code <> 'data_not_authorized' then
    raise exception 'C1: a start after its authorization was retired was not refused (%)', v;
  end if;

  -- Expired and future versions are not in force.
  perform pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-a',
                            p_valid_from => now() - interval '90 minutes', p_expires_at => now() - interval '1 minute');
  perform pg_temp.task('c-expired', 'health');
  perform pg_temp.request('c-expired');
  if (pg_temp.run('c-expired')).error_code is distinct from 'data_not_authorized' then
    raise exception 'C2: an expired authorization admitted a request';
  end if;
  perform pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-a',
                            p_valid_from => now() + interval '1 day', p_expires_at => now() + interval '2 days');
  perform pg_temp.task('c-future', 'health');
  perform pg_temp.request('c-future');
  if (pg_temp.run('c-future')).error_code is distinct from 'data_not_authorized' then
    raise exception 'C3: an authorization not yet valid admitted a request';
  end if;
end
$$;

-- ===========================================================================
-- D. A stop holds before the gate refuses.
-- ===========================================================================

do $$
declare
  v text;
  r ops.agent_runs;
  v_auth uuid;
  v_stop uuid;
begin
  v_auth := pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-a');
  perform pg_temp.task('d-held', 'health');
  perform pg_temp.request('d-held');
  perform ops.retire_model_data_authorization(v_auth, 'q8 drill', 'q8-suite');
  v_stop := ops.trip_execution_stop('tenant', 'q8 drill', 'q8-suite', pg_temp.id('a.tenant'));
  v := pg_temp.start('d-held', 'openai', 'q8-model-a');
  r := pg_temp.run('d-held');
  if v <> 'stopped' or r.status <> 'pending' or r.error_code is not null then
    raise exception 'D1: a stop did not hold the run before the data gate decided (%, %, %)', v, r.status, r.error_code;
  end if;
  perform ops.clear_execution_stop(v_stop, 'q8 drill over', 'q8-suite');
end
$$;

-- ===========================================================================
-- E. synthetic, test and the in-process fake are unaffected.
-- ===========================================================================

do $$
declare
  v text;
  r ops.agent_runs;
begin
  foreach v in array array['synthetic', 'test'] loop
    perform pg_temp.task('e-' || v, v);
    perform pg_temp.request('e-' || v);
    if pg_temp.start('e-' || v, 'openai', 'q8-model-b') <> 'running' then
      raise exception 'E1: a % run did not start with no authorization', v;
    end if;
    r := pg_temp.run('e-' || v);
    if r.data_authorization_id is not null or r.data_class <> v then
      raise exception 'E1: a % run recorded an authorization it does not rely on', v;
    end if;
  end loop;

  -- Health data admitted at the request, started on the in-process fake: nothing
  -- leaves the process, so no authorization is relied on.
  perform pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-a');
  perform pg_temp.task('e-fake', 'health');
  perform pg_temp.request('e-fake');
  if pg_temp.start('e-fake', 'fake', 'q8-fake') <> 'running' or (pg_temp.run('e-fake')).data_authorization_id is not null then
    raise exception 'E2: the in-process fake did not start without relying on an authorization';
  end if;
end
$$;

-- ===========================================================================
-- F. Nothing from the browser, the gateway, the worker or PostgREST authorizes.
-- ===========================================================================

do $$
declare
  v_role text;
  v_fn   text;
  v_bad  text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_table_privilege(v_role, 'ops.model_data_authorizations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'F1: % holds a privilege on ops.model_data_authorizations', v_role;
    end if;
    foreach v_fn in array array[
      'ops.record_model_data_authorization(uuid, text, text, text, text, timestamptz, timestamptz, text, timestamptz, boolean, text, text, text, text, text, text, integer, text)',
      'ops.retire_model_data_authorization(uuid, text, text)',
      'ops.model_data_authorized(uuid, text, text, text, text)',
      'ops.model_data_authorization_in_force(uuid, text, text, text, text)',
      'ops.model_data_class_admissible(uuid, text, text)',
      'ops.model_data_controller_tenant(uuid)',
      'ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid, text, text)'] loop
      if has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception 'F1: % can execute %', v_role, v_fn;
      end if;
    end loop;
  end loop;

  -- The worker cannot record one even inside its own lease.
  perform pg_temp.expect('F2 the worker records an authorization', '42501', $q$
    set local role ops_worker;
    select ops.record_model_data_authorization(gen_random_uuid(), 'health', 'lead_triage', 'openai', 'x',
      now(), now() + interval '1 day', 'r', now(), true, 'r', 'r', 'r', 'r', 'r', 'r', 30, 'worker')
  $q$);
  execute 'reset role';

  -- No browser-reachable function names the table or the owner services.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and p.prosrc ~ '(model_data_authorizations|record_model_data_authorization|retire_model_data_authorization|data_class)';
  if v_bad is not null then
    raise exception 'F3: a browser-reachable function reaches data authorization: %', v_bad;
  end if;
end
$$;

-- ===========================================================================
-- G. The task's class is fixed at creation (SI-71).
-- ===========================================================================

do $$
declare
  v_task uuid;
begin
  perform pg_temp.task('g-open', 'health');
  perform pg_temp.expect('G1 the owner relabels a task''s class', 'OS409',
    format($q$update ops.tasks set data_class = 'synthetic' where id = %L$q$, pg_temp.id('task.g-open')));
  perform pg_temp.expect('G1 the owner unclassifies a task', 'OS409',
    format($q$update ops.tasks set data_class = 'unclassified' where id = %L$q$, pg_temp.id('task.g-open')));
  -- A task that names no class is unclassified.
  v_task := ops.create_task(pg_temp.id('a.tenant'), pg_temp.id('a.company'), 'work.review', 'Unnamed', 'q8-suite');
  if (select t.data_class from ops.tasks t where t.id = v_task) <> 'unclassified' then
    raise exception 'G2: a task with no class is not unclassified';
  end if;
  perform pg_temp.expect('G3 a class outside the closed classification', 'OS400',
    format($q$select ops.create_task(%L, %L, 'work.review', 'Bad', 'q8-suite', p_data_class => 'public')$q$,
           pg_temp.id('a.tenant'), pg_temp.id('a.company')));
  -- The same key and request under another class is refused, never answered.
  v_task := ops.create_task(pg_temp.id('a.tenant'), pg_temp.id('a.company'), 'work.review', 'Keyed', 'q8-suite',
                            p_idempotency_key => 'q8-g-key', p_data_class => 'health');
  if ops.create_task(pg_temp.id('a.tenant'), pg_temp.id('a.company'), 'work.review', 'Keyed', 'q8-suite',
                     p_idempotency_key => 'q8-g-key', p_data_class => 'health') is distinct from v_task then
    raise exception 'G4: the same request under the same class was not answered with its task';
  end if;
  perform pg_temp.expect('G4 the same key under another class', 'OS409',
    format($q$select ops.create_task(%L, %L, 'work.review', 'Keyed', 'q8-suite',
                                     p_idempotency_key => 'q8-g-key', p_data_class => 'synthetic')$q$,
           pg_temp.id('a.tenant'), pg_temp.id('a.company')));
end
$$;

-- ===========================================================================
-- H. The authorization record.
-- ===========================================================================

do $$
declare
  k      text;
  v_a    uuid;
  v_b    uuid;
  c_call constant text := $q$select ops.record_model_data_authorization(%L, %L, %L, %L, %L,
      now() - interval '1 hour', %L::timestamptz, 'fixture:e', %L::timestamptz, %L, %L, %L, %L, %L, %L, %L, %L, 'q8-suite')$q$;
begin
  foreach k in array array['identifier', 'clinical_record', 'derived', 'unclassified', 'synthetic', 'test'] loop
    perform pg_temp.expect('H1 authorizing ' || k, 'OS403',
      format(c_call, pg_temp.id('a.tenant'), k, 'lead_triage', 'openai', 'q8-model-a', now() + interval '1 day',
             now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  end loop;
  perform pg_temp.expect('H2 authorizing the fake provider', 'OS400',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'fake', 'q8-fake', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  -- D4, D5, D9: every reference for person content, and training excluded.
  perform pg_temp.expect('H3 health with no lawful basis', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', null, 30));
  perform pg_temp.expect('H3 health with no transfer mechanism', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', null, 'l', 30));
  perform pg_temp.expect('H3 health with no zero-retention evidence', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', null, 'r', 't', 'l', 30));
  perform pg_temp.expect('H3 person_text with no DPA', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'person_text', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', null, 'z', 'r', 't', 'l', 30));
  perform pg_temp.expect('H4 health with training not excluded', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', false, 'c', 'd', 'z', 'r', 't', 'l', 30));
  -- D6: at most the owner's 30 days of AI working content.
  perform pg_temp.expect('H5 health kept 31 days', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 31));
  perform pg_temp.expect('H5 health with no retention period', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h3', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', null));
  -- D1: person content only for the tenant that owns the local CRM.
  perform pg_temp.expect('H6 health for a tenant that is not the controller', 'OS403',
    format(c_call, pg_temp.id('b.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-a', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  if pg_temp.authorize('operational', 'lead_triage', 'openai', 'q8-model-a', 'b') is null then
    raise exception 'H6: operational data could not be authorized for another tenant';
  end if;
  -- Validity: after the verified evidence, and within 366 days of it.
  perform pg_temp.expect('H7 expiry 400 days after the evidence', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h7', now() + interval '400 days',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  perform pg_temp.expect('H7 valid before the evidence was verified', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h7', now() + interval '1 day',
           now() - interval '30 minutes', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  perform pg_temp.expect('H8 evidence verified in the future', 'OS400',
    format(replace(c_call, 'now() - interval ''1 hour''', 'now() + interval ''2 hours'''),
           pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-h8', now() + interval '1 day',
           now() + interval '1 hour', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  -- Person content only for a capability whose input is minimised.
  perform pg_temp.expect('H9 health for a capability with no minimisation', 'OS403',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'task_assessment', 'openai', 'q8-model-a', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  -- The purpose must be an agent run capability.
  perform pg_temp.expect('H9 an unknown purpose', 'OS403',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'bulk_marketing', 'openai', 'q8-model-a', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  perform pg_temp.expect('H9 the shadow job kind as a purpose', 'OS403',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'decision.shadow_evaluate', 'openai', 'q8-model-a',
           now() + interval '1 day', now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'l', 30));
  -- An evidence reference is a pointer, never prose.
  perform pg_temp.expect('H9 prose as a reference', '23514',
    format(c_call, pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-a', now() + interval '1 day',
           now() - interval '2 hours', true, 'c', 'd', 'z', 'r', 't', 'the patient agreed on the phone', 30));

  -- Versions: a replay is the version in force; a change supersedes it.
  v_a := pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-v', p_valid_from => now() - interval '1 hour',
                           p_expires_at => now() + interval '10 days');
  if pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-v', p_valid_from => now() - interval '1 hour',
                       p_expires_at => now() + interval '10 days') is distinct from v_a then
    raise exception 'H10: the same version again was not answered with itself';
  end if;
  v_b := pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-v', p_valid_from => now() - interval '1 hour',
                           p_expires_at => now() + interval '20 days');
  if v_b = v_a or not exists (select 1 from ops.model_data_authorizations a
                               where a.id = v_a and a.retired_at is not null and a.retire_reason = 'superseded'
                                 and a.retired_by = 'q8-suite')
     or ops.model_data_authorization_in_force(pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai', 'q8-model-v') <> v_b then
    raise exception 'H10: a changed version did not supersede the one in force, on the record';
  end if;

  -- Immutable: only retired, once.
  perform pg_temp.expect('H11 rewriting a version', 'OS409',
    format($q$update ops.model_data_authorizations set model = 'q8-model-w' where id = %L$q$, v_b));
  perform pg_temp.expect('H11 extending a version', 'OS409',
    format($q$update ops.model_data_authorizations set expires_at = expires_at + interval '1 day' where id = %L$q$, v_b));
  perform pg_temp.expect('H11 deleting a version in force', 'OS409',
    format($q$delete from ops.model_data_authorizations where id = %L$q$, v_b));
  perform pg_temp.expect('H11 truncating the authorizations', 'OS409', 'truncate ops.model_data_authorizations cascade');
  perform pg_temp.expect('H11 born retired', 'OS409',
    format($q$insert into ops.model_data_authorizations (tenant_id, data_class, capability, provider, model, valid_from,
                expires_at, provider_evidence_ref, evidence_verified_at, training_excluded, recorded_by, retired_at,
                retired_by, retire_reason)
              values (%L, 'operational', 'lead_triage', 'openai', 'q8-model-x', now(), now() + interval '1 day', 'r',
                      now() - interval '1 minute', true, 'q8-suite', now(), 'q8-suite', 'x')$q$, pg_temp.id('a.tenant')));
  if not ops.retire_model_data_authorization(v_b, 'q8 drill', 'q8-suite')
     or ops.retire_model_data_authorization(v_b, 'q8 drill again', 'q8-suite') then
    raise exception 'H12: a retire did not happen exactly once';
  end if;
  perform pg_temp.expect('H12 rewriting a retired version', 'OS409',
    format($q$update ops.model_data_authorizations set retire_reason = 'other' where id = %L$q$, v_b));
  perform pg_temp.expect('H12 retiring an unknown version', 'OS404',
    format($q$select ops.retire_model_data_authorization(%L, 'x', 'q8-suite')$q$, gen_random_uuid()));
end
$$;

-- ===========================================================================
-- I. The run guard, on every write path.
-- ===========================================================================

do $$
declare
  v_other uuid;
  v_price uuid := ops.current_model_price('openai', 'q8-model-a', now());
  v_run   uuid;
begin
  perform pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-a');
  v_other := pg_temp.authorize('health', 'lead_triage', 'openai', 'q8-model-b');
  perform pg_temp.task('i-raw', 'health');
  perform pg_temp.request('i-raw');
  v_run := pg_temp.id('run.i-raw');
  -- The owner's raw start, with no authorization: the guard refuses it.
  perform pg_temp.expect('I1 a raw start of health data with no authorization', 'OS409',
    format($q$update ops.agent_runs set status = 'running', job_attempt = 1, prompt_version = 'lead_triage.v2',
                input_fingerprint = repeat('a', 64), provider = 'openai', model = 'q8-model-a',
                price_id = %L, reserved_cost_micros = 1 where id = %L$q$, v_price, v_run));
  -- ... or with the authorization of another model.
  perform pg_temp.expect('I1 a raw start relying on another binding''s authorization', 'OS409',
    format($q$update ops.agent_runs set status = 'running', job_attempt = 1, prompt_version = 'lead_triage.v2',
                input_fingerprint = repeat('a', 64), provider = 'openai', model = 'q8-model-a',
                price_id = %L, reserved_cost_micros = 1, data_authorization_id = %L where id = %L$q$,
           v_price, v_other, v_run));
  -- A synthetic run cannot claim an authorization it does not rely on.
  perform pg_temp.task('i-synthetic', 'synthetic');
  perform pg_temp.request('i-synthetic');
  perform pg_temp.expect('I2 a synthetic start claiming an authorization', 'OS409',
    format($q$update ops.agent_runs set status = 'running', job_attempt = 1, prompt_version = 'lead_triage.v2',
                input_fingerprint = repeat('a', 64), provider = 'openai', model = 'q8-model-b',
                price_id = %L, reserved_cost_micros = 1, data_authorization_id = %L where id = %L$q$,
           ops.current_model_price('openai', 'q8-model-b', now()), v_other, pg_temp.id('run.i-synthetic')));
  -- The positive control: the same raw start relying on the authorization in
  -- force for its binding is accepted, so the refusals above are the gate's.
  perform pg_temp.task('i-raw-ok', 'health');
  perform pg_temp.request('i-raw-ok');
  perform ops.push_event_context('q8-suite', gen_random_uuid(), null);
  perform pg_temp.expect('I1 a raw start relying on its own binding''s authorization', null,
    format($q$update ops.agent_runs set status = 'running', job_attempt = 1, prompt_version = 'lead_triage.v2',
                input_fingerprint = repeat('a', 64), provider = 'openai', model = 'q8-model-a',
                price_id = %L, reserved_cost_micros = 1, data_authorization_id = %L where id = %L$q$,
           v_price, ops.model_data_authorization_in_force(pg_temp.id('a.tenant'), 'health', 'lead_triage', 'openai',
                                                          'q8-model-a'), pg_temp.id('run.i-raw-ok')));
  -- The class is derived from the task, never taken from the caller, and fixed.
  insert into ops.agent_runs (tenant_id, company_id, department_id, task_id, agent_id, capability, model_route,
                              idempotency_key, request_fingerprint, correlation_id, requested_by, data_class)
  select r.tenant_id, r.company_id, r.department_id, r.task_id, r.agent_id, r.capability, r.model_route,
         'q8-i-raw-insert', repeat('b', 64), gen_random_uuid(), 'q8-suite', 'synthetic'
    from ops.agent_runs r where r.id = v_run
  returning id into v_run;
  if (select r.data_class from ops.agent_runs r where r.id = v_run) <> 'health' then
    raise exception 'I3: a run took its class from the caller instead of its task';
  end if;
  perform pg_temp.expect('I3 relabelling a pending run', 'OS409',
    format($q$update ops.agent_runs set data_class = 'synthetic' where id = %L$q$, v_run));
  perform pg_temp.expect('I3 a refusal claiming an authorization', 'OS409',
    format($q$update ops.agent_runs set status = 'cancelled', error_category = 'refused', error_code = 'x',
                data_authorization_id = %L where id = %L$q$, v_other, v_run));
end
$$;

-- ===========================================================================
-- K. The decision-shadow start: the same check; nothing authorizes it.
-- ===========================================================================

do $$
declare
  a record;
begin
  select * into a from ops.model_data_authorized(pg_temp.id('a.tenant'), 'health', 'decision.shadow_evaluate', 'jev', 'jev-x');
  if a.p_authorized then
    raise exception 'K1: protected data was authorized for the shadow provider';
  end if;
  select * into a from ops.model_data_authorized(pg_temp.id('a.tenant'), 'synthetic', 'decision.shadow_evaluate', 'jev', 'jev-x');
  if not a.p_authorized or a.p_authorization_id is not null then
    raise exception 'K1: synthetic data was refused to the shadow provider';
  end if;
  select * into a from ops.model_data_authorized(pg_temp.id('a.tenant'), 'health', 'decision.shadow_evaluate', 'fake', 'fake-rules');
  if not a.p_authorized then
    raise exception 'K1: the in-process fake decision provider was refused';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = 'ops.start_shadow_decision(text, text, text)'::regprocedure)
       !~ 'ops\.model_data_authorized\(' then
    raise exception 'K2: the decision-shadow start does not run the data gate';
  end if;
  if (select p.prosrc from pg_proc p where p.oid = 'ops.start_agent_run(text, text, text, text, integer)'::regprocedure)
       !~ 'ops\.model_data_authorized\(' then
    raise exception 'K2: the agent run start does not run the data gate';
  end if;
end
$$;

-- ===========================================================================
-- L. The admission derives the class from provenance.
-- ===========================================================================

do $$
declare
  v jsonb;
begin
  v := ops.admit_inbound_message(pg_temp.id('a.tenant'), pg_temp.id('a.company'), pg_temp.id('a.agent'), 'synthetic',
                                 'q8-ext-1', 'synthetic:q8-contact', 'SENTINEL-Q8-ADMITTED synthetic text', 'q8-suite',
                                 false, now());
  if (select t.data_class from ops.tasks t where t.id = (v ->> 'task_id')::uuid) <> 'synthetic'
     or (select r.data_class from ops.agent_runs r where r.id = (v ->> 'agent_run_id')::uuid) <> 'synthetic'
     or (select r.job_id from ops.agent_runs r where r.id = (v ->> 'agent_run_id')::uuid) is null then
    raise exception 'L1: a synthetic admission did not become a synthetic task and a synthetic run with a job';
  end if;
end
$$;

rollback;
