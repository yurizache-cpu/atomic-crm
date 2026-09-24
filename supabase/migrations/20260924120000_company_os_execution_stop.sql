-- Phase 2C (S7.2): the second browser mutation, a member's execution stop trip.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_2C_BRIEF.md §9 row 17 and the trip
-- coordinates table, §15; owner decision S0-B; ADR 0019):
--
--   1. ops.trip_stop_in_tenant: the one callee of the new gate. It refuses a
--      global or job_kind scope (OS403) and any other scope outside tenant,
--      company, department and agent (OS400); resolves the target inside the
--      caller's tenant first (a foreign or missing id is the same OS404);
--      derives the coordinates the brief's table fixes; then ALWAYS calls the
--      authoritative ops.trip_execution_stop, under its exclusive lock, with
--      the principal as the actor and a fixed server reason. There is no
--      lock-free "already stopped" pre-check: a concurrent CLI clear must not
--      lose the member's stop (deny wins). The outcome is `stopped` only when
--      this call recorded the stop (the CLI's own test: tripped now, by this
--      actor, with this reason), otherwise `already_stopped`.
--   2. ops.gate_trip_stop: the identity gate. Resolver first, exactly that
--      callee, no-store, the same fixed data-free errors as every gate, plus
--      the bound of owner decision S0-B: `lock_timeout = 2s`, and a lock
--      wait past it answered with the one generic, retryable refusal (OS429).
--   3. company_os_api.trip_stop(p_scope, p_target_id): the act, owned by
--      ops_operator_api. The browser names a scope and, except for the
--      tenant, a target; never a tenant, a company it does not select, an
--      actor or a reason.
--   4. operator_context now reports tripStop true.
--
-- WHAT IT DELIBERATELY DOES NOT DO: clear, resume, untrip, delete or edit any
-- stop (clearing stays an owner CLI act); trip a global, system or job_kind
-- stop; take a free-text reason from the browser; write an event (tripping
-- a stop writes none, as in the CLI: the stop row is the record); touch a
-- job, a run, a send, the CRM or any other governance state; or bypass the Q8
-- scope for any role or setting.
--
-- OD-8a (brief §7.6; owner decisions S0-E, S0-F): this file is the third exact,
-- allowlisted migration. It runs the whole lifecycle itself, in one
-- transaction, for exactly the function it creates.

-- ---------------------------------------------------------------------------
-- 1. The measured migration identity, and one transaction.
-- ---------------------------------------------------------------------------

do $identity$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'company_os_execution_stop: must run as the measured migration identity postgres, not %/%',
      current_user, session_user;
  end if;
  perform pg_catalog.set_config('company_os.migration_txid', pg_catalog.txid_current()::pg_catalog.text, true);
end
$identity$;

-- ---------------------------------------------------------------------------
-- 2. The callee: the target, found in the tenant, then tripped.
-- ---------------------------------------------------------------------------

create function ops.trip_stop_in_tenant(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                        p_scope pg_catalog.text, p_target_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  -- Fixed by the server: the browser supplies no text a stop would persist.
  c_reason     constant pg_catalog.text := 'owner requested execution stop via Company OS';
  v_company    pg_catalog.uuid;
  v_department pg_catalog.uuid;
  v_agent      pg_catalog.uuid;
  v_stop       pg_catalog.uuid;
  v_recorded   pg_catalog.bool;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  -- A stop wider than the tenant, or of a job kind, is never the browser's.
  if p_scope in ('global', 'job_kind') then
    raise exception using errcode = 'OS403', message = 'no access';
  end if;
  if p_scope is null or p_scope not in ('tenant', 'company', 'department', 'agent')
     or (p_scope = 'tenant') <> (p_target_id is null) then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;

  -- The target inside the caller's tenant, before anything else: another
  -- tenant's row and a row that does not exist are the same OS404. The
  -- coordinates follow the brief's table.
  if p_scope = 'company' then
    select c.id into v_company from ops.companies c where c.id = p_target_id and c.tenant_id = p_tenant_id;
  elsif p_scope = 'department' then
    select d.company_id, d.id into v_company, v_department
      from ops.departments d where d.id = p_target_id and d.tenant_id = p_tenant_id;
  elsif p_scope = 'agent' then
    select a.company_id, a.id into v_company, v_agent
      from ops.agents a where a.id = p_target_id and a.tenant_id = p_tenant_id;
  end if;
  if p_scope <> 'tenant' and v_company is null then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;

  -- Always the authoritative trip and its lock (no lock-free pre-check).
  v_stop := ops.trip_execution_stop(p_scope, c_reason, p_actor, p_tenant_id, v_company, v_department, v_agent, null);
  select s.tripped_at = now() and s.tripped_by = p_actor and s.reason = c_reason into v_recorded
    from ops.execution_stops s where s.id = v_stop;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()),
    'stopId', v_stop,
    'outcome', case when v_recorded then 'stopped' else 'already_stopped' end);
end
$$;

comment on function ops.trip_stop_in_tenant(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid) is
  'The one callee of ops.gate_trip_stop: refuses a global or job_kind scope (OS403), resolves the target in the caller''s tenant (OS404 otherwise), then always calls ops.trip_execution_stop with the principal as actor and a fixed reason. Clears nothing; writes no event.';

-- ---------------------------------------------------------------------------
-- 3. The identity gate, bounded by owner decision S0-B.
-- ---------------------------------------------------------------------------

create function ops.gate_trip_stop(p_scope pg_catalog.text, p_target_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.trip_stop_in_tenant(v.tenant_id, v.actor, p_scope, p_target_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.trip_stop: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.trip_stop: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.trip_stop: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.trip_stop: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.trip_stop: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.trip_stop: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.trip_stop: internal error';
end
$$;

-- ---------------------------------------------------------------------------
-- 4. operator_context: the trip is now an allowed action.
-- ---------------------------------------------------------------------------

create or replace function ops.read_operator_context(p_tenant_id pg_catalog.uuid, p_principal_id pg_catalog.uuid,
                                                     p_role pg_catalog.text)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()),
    'principal', pg_catalog.jsonb_build_object('id', p_principal_id),
    'tenant', (select pg_catalog.jsonb_build_object('id', t.id, 'name', t.name) from ops.tenants t where t.id = p_tenant_id),
    'role', p_role,
    'dataPolicy', 'synthetic_or_test_only',
    -- The review decision (S7.1) and the trip (S7.2); there is no clear.
    'allowedActions', pg_catalog.jsonb_build_object('decideReview', true, 'tripStop', true, 'viewAdvice', true),
    'serverTime', ops.cos_ts(pg_catalog.clock_timestamp()));
$$;

revoke all on function
  ops.trip_stop_in_tenant(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid),
  ops.gate_trip_stop(pg_catalog.text, pg_catalog.uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 5. The gate's one grant, and the exposed act.
-- ---------------------------------------------------------------------------

grant execute on function ops.gate_trip_stop(pg_catalog.text, pg_catalog.uuid) to ops_operator_api;

create function company_os_api.trip_stop(p_scope pg_catalog.text, p_target_id pg_catalog.uuid default null)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_trip_stop(p_scope, p_target_id) $$;

revoke all on function company_os_api.trip_stop(pg_catalog.text, pg_catalog.uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function company_os_api.trip_stop(pg_catalog.text, pg_catalog.uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. OD-8a lifecycle, steps 2 to 6, for exactly this function.
-- ---------------------------------------------------------------------------

grant ops_operator_api to postgres;
grant create on schema company_os_api to ops_operator_api;
alter function company_os_api.trip_stop(pg_catalog.text, pg_catalog.uuid) owner to ops_operator_api;
revoke create on schema company_os_api from ops_operator_api;
revoke ops_operator_api from postgres;

-- ---------------------------------------------------------------------------
-- 7. OD-8a step 7: assert the end state of the whole surface.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  c_l3 constant pg_catalog.text[] := array[
    'company_os_api.operator_context()', 'company_os_api.overview()', 'company_os_api.list_agents()',
    'company_os_api.get_agent(uuid)', 'company_os_api.list_tasks(text,text,uuid,integer)',
    'company_os_api.get_task(uuid)', 'company_os_api.list_runs(text,text,uuid,boolean,integer)',
    'company_os_api.get_run(uuid)', 'company_os_api.list_reviews(text,text,integer)',
    'company_os_api.get_review(uuid)', 'company_os_api.get_review_advice(uuid)',
    'company_os_api.list_events(text,text,uuid,integer)', 'company_os_api.list_stops(boolean,text,integer)',
    'company_os_api.spend_summary()', 'company_os_api.communication_status()',
    'company_os_api.decide_review(uuid,text)', 'company_os_api.trip_stop(text,uuid)'];
  -- The two acts; every other exposed function stays a read.
  c_acts constant pg_catalog.text[] := array['company_os_api.decide_review(uuid,text)', 'company_os_api.trip_stop(text,uuid)'];
  v_bad pg_catalog.text;
begin
  if pg_catalog.current_setting('company_os.migration_txid', true) is distinct from pg_catalog.txid_current()::pg_catalog.text then
    raise exception 'company_os_execution_stop: the migration did not run in one transaction';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'ops_operator_api'
                  and not r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
                  and not r.rolbypassrls and not r.rolinherit) then
    raise exception 'ops_operator_api is missing or carries a login or a blanket attribute';
  end if;
  if exists (select 1 from pg_catalog.pg_auth_members m
              where m.roleid = 'ops_operator_api'::pg_catalog.regrole or m.member = 'ops_operator_api'::pg_catalog.regrole) then
    raise exception 'ops_operator_api has a member or a membership at rest';
  end if;
  -- No CREATE on any persistent namespace or on the database; only this
  -- session's own temporary namespace is left out, by oid (see the read
  -- surface migration, section 13).
  select pg_catalog.string_agg(n.nspname, ', ') into v_bad from pg_catalog.pg_namespace n
   where pg_catalog.has_schema_privilege('ops_operator_api', n.oid, 'CREATE')
     and n.oid <> pg_catalog.pg_my_temp_schema();
  if v_bad is not null or pg_catalog.has_database_privilege('ops_operator_api', pg_catalog.current_database(), 'CREATE') then
    raise exception 'ops_operator_api can create objects: %', coalesce(v_bad, 'the database');
  end if;
  if pg_catalog.has_schema_privilege('ops_operator_api', 'company_os_api', 'CREATE')
     or pg_catalog.has_schema_privilege('ops_operator_api', 'ops', 'CREATE')
     or pg_catalog.has_schema_privilege('ops_operator_api', 'public', 'CREATE') then
    raise exception 'ops_operator_api can create objects in company_os_api, ops or public';
  end if;

  -- It owns exactly the catalogue; each exposed function is DEFINER with an
  -- empty search path, executable by authenticated and its owner only.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p where p.proowner = 'ops_operator_api'::pg_catalog.regrole
     and pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') <> all (c_l3);
  if v_bad is not null then
    raise exception 'ops_operator_api owns an uncatalogued function: %', v_bad;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and (p.proowner <> 'ops_operator_api'::pg_catalog.regrole or not p.prosecdef or p.prokind <> 'f'
          or p.proconfig is distinct from array['search_path=""']
          or p.proacl is distinct from array['ops_operator_api=X/ops_operator_api', 'authenticated=X/ops_operator_api']::pg_catalog.aclitem[]
          or pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') <> all (c_l3));
  if v_bad is not null then
    raise exception 'company_os_api function with a wrong owner, mode, config or ACL: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'company_os_api') <> pg_catalog.array_length(c_l3, 1) then
    raise exception 'company_os_api does not hold exactly the catalogue';
  end if;
  -- Exactly the two acts are VOLATILE; every read stays STABLE.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and (p.provolatile <> 's') is distinct from
         (pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') = any (c_acts));
  if v_bad is not null then
    raise exception 'company_os_api function whose volatility contradicts the two acts: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'company_os_api')
     or exists (select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'company_os_api') then
    raise exception 'company_os_api holds a relation, sequence or type';
  end if;

  -- In ops it executes exactly the gates, now 17; it touches no relation.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')
     and p.proname !~ '^gate_';
  if v_bad is not null then
    raise exception 'ops_operator_api can execute a non-gate ops function: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname ~ '^gate_' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')) <> 17 then
    raise exception 'ops_operator_api does not execute exactly the 17 gates';
  end if;
  select pg_catalog.string_agg(c.oid::pg_catalog.regclass::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and pg_catalog.has_schema_privilege('ops_operator_api', n.oid, 'USAGE')
     and (case when c.relkind = 'S' then pg_catalog.has_sequence_privilege('ops_operator_api', c.oid, 'USAGE,SELECT,UPDATE')
               else pg_catalog.has_table_privilege('ops_operator_api', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or pg_catalog.has_any_column_privilege('ops_operator_api', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') end);
  if v_bad is not null then
    raise exception 'ops_operator_api holds a relation privilege: %', v_bad;
  end if;

  -- The trip gate carries the S0-B bound; nothing a browser-facing role can
  -- run clears a stop, sends, or reaches the outbound path.
  if (select p.proconfig from pg_catalog.pg_proc p
       where p.oid = 'ops.gate_trip_stop(pg_catalog.text, pg_catalog.uuid)'::pg_catalog.regprocedure)
     is distinct from array['search_path=""', 'lock_timeout=2s'] then
    raise exception 'ops.gate_trip_stop does not carry exactly the 2 s lock_timeout of owner decision S0-B';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              cross join (values ('authenticated'), ('ops_operator_api')) as r(role)
              where n.nspname = 'ops' and p.proname ~ '(outbound|send|clear)'
                and pg_catalog.has_function_privilege(r.role, p.oid, 'EXECUTE')) then
    raise exception 'a browser-facing role can execute a clear, outbound or send function';
  end if;

  -- No ops function is executable by PUBLIC, and no default privilege
  -- reaches ops or company_os_api.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('ops', 'company_os_api')
     and (p.proacl is null or exists (select 1 from pg_catalog.aclexplode(p.proacl) a
                                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'function executable by PUBLIC: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
              where d.defaclnamespace = 0 or n.nspname in ('ops', 'company_os_api')) then
    raise exception 'a default privilege reaches ops or company_os_api';
  end if;
  if pg_catalog.has_schema_privilege('authenticated', 'ops', 'USAGE') or pg_catalog.has_schema_privilege('anon', 'company_os_api', 'USAGE')
     or pg_catalog.has_schema_privilege('service_role', 'company_os_api', 'USAGE') then
    raise exception 'a schema privilege on ops or company_os_api is wider than the catalogue';
  end if;
end
$end_state$;
