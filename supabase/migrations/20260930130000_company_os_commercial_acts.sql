-- Phase 3B.2: the four commercial browser acts (owner decision R, 2026-09-26).
--
-- OWNER DECISION R amends ADR 0019's count of browser mutations, never its
-- least-privilege architecture: the browser gains exactly four narrowly
-- scoped commercial acts, each with its own exact contract and gate, making
-- six browser acts in all (decide_review, trip_stop and these four). No
-- generic CRUD, no generic "mutate opportunity" operation and no operation
-- name, table, column or SQL text supplied by the caller exist.
--
-- WHAT THIS MIGRATION ADDS, for each act, in the pattern of decide_review and
-- trip_stop:
--
--   ops.gate_<act>      the identity gate: the resolver first, exactly one
--       callee (the narrow commercial act of
--       20260930120000_commercial_opportunity_acts.sql), no-store, one fixed
--       data-free message per SQLSTATE, and the bound of trip_stop:
--       `lock_timeout = 2s`, a lock wait past it answered with the one
--       generic, retryable refusal (OS429), so a browser act never hangs on a
--       deal row another writer holds.
--   company_os_api.<act>  the act, owned by ops_operator_api. The browser
--       names the deal (its CRM reference, as the funnel shows it), the
--       revision it saw and the act's own input; never a tenant, company,
--       actor, salesperson, source or reason text.
--
--     move_opportunity(p_deal_ref, p_target_stage, p_expected_revision)
--     set_opportunity_next_action(p_deal_ref, p_next_action_at, p_expected_revision)
--     convert_opportunity(p_deal_ref, p_target_stage, p_expected_revision)
--     lose_opportunity(p_deal_ref, p_loss_reason, p_expected_revision)
--
--   ops.read_operator_context reports the four acts as allowed exactly when
--   the member's tenant owns the local CRM, which each act decides again.
--
-- WHAT IT DELIBERATELY DOES NOT DO: create, delete, reopen or edit anything
-- else of a deal; send, resend or authorise a message; write an outbound row;
-- clear, trip or change a stop; touch money, units or governance; take a
-- tenant or an actor from the browser.
--
-- OD-8a (brief §7.6; owner decisions S0-E, S0-F): this file is the fourth
-- exact, allowlisted migration. It runs the whole lifecycle itself, in one
-- transaction, for exactly the four functions it creates.

-- ---------------------------------------------------------------------------
-- 1. The measured migration identity, and one transaction.
-- ---------------------------------------------------------------------------

do $identity$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'company_os_commercial_acts: must run as the measured migration identity postgres, not %/%',
      current_user, session_user;
  end if;
  perform pg_catalog.set_config('company_os.migration_txid', pg_catalog.txid_current()::pg_catalog.text, true);
end
$identity$;

-- ---------------------------------------------------------------------------
-- 2. The four identity gates, each bounded like the trip.
-- ---------------------------------------------------------------------------

create function ops.gate_move_opportunity(p_deal_ref pg_catalog.int8, p_target_stage pg_catalog.text,
                                          p_expected_revision pg_catalog.text) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.move_opportunity_as_member(v.tenant_id, v.actor, p_deal_ref, p_target_stage, p_expected_revision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.move_opportunity: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.move_opportunity: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.move_opportunity: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.move_opportunity: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.move_opportunity: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.move_opportunity: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.move_opportunity: internal error';
end
$$;

create function ops.gate_set_opportunity_next_action(p_deal_ref pg_catalog.int8, p_next_action_at pg_catalog.timestamptz,
                                                     p_expected_revision pg_catalog.text) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.set_opportunity_next_action_as_member(v.tenant_id, v.actor, p_deal_ref, p_next_action_at, p_expected_revision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.set_opportunity_next_action: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.set_opportunity_next_action: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.set_opportunity_next_action: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.set_opportunity_next_action: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.set_opportunity_next_action: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.set_opportunity_next_action: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.set_opportunity_next_action: internal error';
end
$$;

create function ops.gate_convert_opportunity(p_deal_ref pg_catalog.int8, p_target_stage pg_catalog.text,
                                             p_expected_revision pg_catalog.text) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.convert_opportunity_as_member(v.tenant_id, v.actor, p_deal_ref, p_target_stage, p_expected_revision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.convert_opportunity: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.convert_opportunity: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.convert_opportunity: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.convert_opportunity: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.convert_opportunity: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.convert_opportunity: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.convert_opportunity: internal error';
end
$$;

create function ops.gate_lose_opportunity(p_deal_ref pg_catalog.int8, p_loss_reason pg_catalog.text,
                                          p_expected_revision pg_catalog.text) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.lose_opportunity_as_member(v.tenant_id, v.actor, p_deal_ref, p_loss_reason, p_expected_revision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.lose_opportunity: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.lose_opportunity: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.lose_opportunity: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.lose_opportunity: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.lose_opportunity: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.lose_opportunity: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.lose_opportunity: internal error';
end
$$;

-- ---------------------------------------------------------------------------
-- 3. operator_context: the four commercial acts, allowed exactly when the
--    member's tenant owns the local CRM.
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
    -- The review decision (S7.1), the trip (S7.2; there is no clear) and the
    -- four commercial acts (Phase 3B.2).
    'allowedActions', pg_catalog.jsonb_build_object(
      'decideReview', true, 'tripStop', true, 'viewAdvice', true,
      'moveOpportunity', ops.cos_commercial_acts_available(p_tenant_id),
      'setOpportunityNextAction', ops.cos_commercial_acts_available(p_tenant_id),
      'convertOpportunity', ops.cos_commercial_acts_available(p_tenant_id),
      'loseOpportunity', ops.cos_commercial_acts_available(p_tenant_id)),
    'serverTime', ops.cos_ts(pg_catalog.clock_timestamp()));
$$;

revoke all on function
  ops.gate_move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.gate_set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text),
  ops.gate_convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.gate_lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 4. Each gate's one grant, and the four exposed acts.
-- ---------------------------------------------------------------------------

grant execute on function ops.gate_move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) to ops_operator_api;
grant execute on function ops.gate_set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text) to ops_operator_api;
grant execute on function ops.gate_convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) to ops_operator_api;
grant execute on function ops.gate_lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) to ops_operator_api;

create function company_os_api.move_opportunity(p_deal_ref pg_catalog.int8, p_target_stage pg_catalog.text,
                                                p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_move_opportunity(p_deal_ref, p_target_stage, p_expected_revision) $$;

create function company_os_api.set_opportunity_next_action(p_deal_ref pg_catalog.int8, p_next_action_at pg_catalog.timestamptz,
                                                           p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_set_opportunity_next_action(p_deal_ref, p_next_action_at, p_expected_revision) $$;

create function company_os_api.convert_opportunity(p_deal_ref pg_catalog.int8, p_target_stage pg_catalog.text,
                                                   p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_convert_opportunity(p_deal_ref, p_target_stage, p_expected_revision) $$;

create function company_os_api.lose_opportunity(p_deal_ref pg_catalog.int8, p_loss_reason pg_catalog.text,
                                                p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_lose_opportunity(p_deal_ref, p_loss_reason, p_expected_revision) $$;

revoke all on function
  company_os_api.move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  company_os_api.set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text),
  company_os_api.convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  company_os_api.lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function company_os_api.move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) to authenticated;
grant execute on function company_os_api.set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text) to authenticated;
grant execute on function company_os_api.convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) to authenticated;
grant execute on function company_os_api.lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. OD-8a lifecycle, steps 2 to 6, for exactly these four functions.
-- ---------------------------------------------------------------------------

grant ops_operator_api to postgres;
grant create on schema company_os_api to ops_operator_api;
alter function company_os_api.move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) owner to ops_operator_api;
alter function company_os_api.set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text) owner to ops_operator_api;
alter function company_os_api.convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) owner to ops_operator_api;
alter function company_os_api.lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text) owner to ops_operator_api;
revoke create on schema company_os_api from ops_operator_api;
revoke ops_operator_api from postgres;

-- ---------------------------------------------------------------------------
-- 6. OD-8a step 7: assert the end state of the whole surface.
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
    'company_os_api.decide_review(uuid,text)', 'company_os_api.trip_stop(text,uuid)',
    'company_os_api.move_opportunity(bigint,text,text)',
    'company_os_api.set_opportunity_next_action(bigint,timestampwithtimezone,text)',
    'company_os_api.convert_opportunity(bigint,text,text)',
    'company_os_api.lose_opportunity(bigint,text,text)'];
  -- The six acts; every other exposed function stays a read.
  c_acts constant pg_catalog.text[] := array[
    'company_os_api.decide_review(uuid,text)', 'company_os_api.trip_stop(text,uuid)',
    'company_os_api.move_opportunity(bigint,text,text)',
    'company_os_api.set_opportunity_next_action(bigint,timestampwithtimezone,text)',
    'company_os_api.convert_opportunity(bigint,text,text)',
    'company_os_api.lose_opportunity(bigint,text,text)'];
  -- The gates bounded by a 2 s lock wait: the trip and the commercial acts.
  c_bounded constant pg_catalog.regprocedure[] := array[
    'ops.gate_trip_stop(pg_catalog.text, pg_catalog.uuid)'::pg_catalog.regprocedure,
    'ops.gate_move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)'::pg_catalog.regprocedure];
  v_bad pg_catalog.text;
begin
  if pg_catalog.current_setting('company_os.migration_txid', true) is distinct from pg_catalog.txid_current()::pg_catalog.text then
    raise exception 'company_os_commercial_acts: the migration did not run in one transaction';
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
  -- Exactly the six acts are VOLATILE; every read stays STABLE.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and (p.provolatile <> 's') is distinct from
         (pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') = any (c_acts));
  if v_bad is not null then
    raise exception 'company_os_api function whose volatility contradicts the six acts: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'company_os_api')
     or exists (select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'company_os_api') then
    raise exception 'company_os_api holds a relation, sequence or type';
  end if;

  -- In ops it executes exactly the gates, now 21; it touches no relation.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')
     and p.proname !~ '^gate_';
  if v_bad is not null then
    raise exception 'ops_operator_api can execute a non-gate ops function: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname ~ '^gate_' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')) <> 21 then
    raise exception 'ops_operator_api does not execute exactly the 21 gates';
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

  -- The trip gate and the four commercial gates carry the 2 s bound; nothing
  -- a browser-facing role can run clears a stop, sends, or reaches the
  -- outbound path.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (c_bounded) and p.proconfig is distinct from array['search_path=""', 'lock_timeout=2s'];
  if v_bad is not null then
    raise exception 'a bounded gate does not carry exactly the 2 s lock_timeout: %', v_bad;
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
