-- ADR 0026 §E, owner decision S (2026-10-08): the browser inbox. One read and
-- two acts, making 24 functions and eight browser acts.
--
-- OWNER DECISION S amends ADR 0019's count of browser surface again, never its
-- least-privilege architecture: a member reads one waiting conversation of
-- test data, writes their own reply to a conversation a person holds, and
-- releases it back to the agent. Each has its own exact contract and gate. No
-- generic operation and no operation name, table, column or SQL text supplied
-- by the caller exist.
--
-- WHAT THIS MIGRATION ADDS, in the pattern of the commercial acts:
--
--   ops.gate_<op>      the identity gate: the resolver first, exactly one
--       callee (of 20261021120000_browser_inbox_acts.sql), no-store, one fixed
--       data-free message per SQLSTATE. The two acts carry the trip's bound:
--       `lock_timeout = 2s`, a lock wait past it answered with the one
--       generic, retryable refusal (OS429). The read is unbounded.
--   company_os_api.<op>  owned by ops_operator_api. The browser names a task of
--       the conversation (any of its inbound messages), the revision it saw
--       and, for a reply, its own text; never a tenant, conversation, actor,
--       number, contact or reason.
--
--     get_conversation(p_task_id)
--     reply_to_conversation(p_task_id, p_text, p_expected_revision)
--     release_conversation(p_task_id, p_expected_revision)
--
-- WHAT IT DELIBERATELY DOES NOT DO: take a conversation over; make an exception
-- act; show, edit or send an AI draft; resend, retry or mark a send; clear,
-- trip or change a stop; change operator_context; take a tenant or an actor
-- from the browser.
--
-- OD-8a (brief §7.6; owner decisions S0-E, S0-F): this file is the fifth
-- exact, allowlisted migration. It runs the whole lifecycle itself, in one
-- transaction, for exactly the three functions it creates.

-- ---------------------------------------------------------------------------
-- 1. The measured migration identity, and one transaction.
-- ---------------------------------------------------------------------------

do $identity$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'company_os_browser_inbox: must run as the measured migration identity postgres, not %/%',
      current_user, session_user;
  end if;
  perform pg_catalog.set_config('company_os.migration_txid', pg_catalog.txid_current()::pg_catalog.text, true);
end
$identity$;

-- ---------------------------------------------------------------------------
-- 2. The three identity gates: the read unbounded, the two acts bounded like
--    the trip.
-- ---------------------------------------------------------------------------

create function ops.gate_get_conversation(p_task_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_conversation(v.tenant_id, p_task_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.get_conversation: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.get_conversation: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.get_conversation: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.get_conversation: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.get_conversation: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.get_conversation: internal error';
end
$$;

create function ops.gate_reply_to_conversation(p_task_id pg_catalog.uuid, p_text pg_catalog.text,
                                               p_expected_revision pg_catalog.int4) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.reply_to_conversation_as_member(v.tenant_id, v.actor, p_task_id, p_text, p_expected_revision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.reply_to_conversation: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.reply_to_conversation: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.reply_to_conversation: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.reply_to_conversation: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.reply_to_conversation: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.reply_to_conversation: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.reply_to_conversation: internal error';
end
$$;

create function ops.gate_release_conversation(p_task_id pg_catalog.uuid, p_expected_revision pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' set lock_timeout = '2s' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.release_conversation_as_member(v.tenant_id, v.actor, p_task_id, p_expected_revision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.release_conversation: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.release_conversation: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.release_conversation: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.release_conversation: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.release_conversation: conflict';
  when sqlstate '55P03' then raise exception using errcode = 'OS429', message = 'company_os_api.release_conversation: could not be completed yet; retry';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.release_conversation: internal error';
end
$$;

revoke all on function
  ops.gate_get_conversation(pg_catalog.uuid),
  ops.gate_reply_to_conversation(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4),
  ops.gate_release_conversation(pg_catalog.uuid, pg_catalog.int4)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 3. Each gate's one grant, and the three exposed functions.
-- ---------------------------------------------------------------------------

grant execute on function ops.gate_get_conversation(pg_catalog.uuid) to ops_operator_api;
grant execute on function ops.gate_reply_to_conversation(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4) to ops_operator_api;
grant execute on function ops.gate_release_conversation(pg_catalog.uuid, pg_catalog.int4) to ops_operator_api;

create function company_os_api.get_conversation(p_task_id pg_catalog.uuid)
returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_get_conversation(p_task_id) $$;

create function company_os_api.reply_to_conversation(p_task_id pg_catalog.uuid, p_text pg_catalog.text,
                                                     p_expected_revision pg_catalog.int4)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_reply_to_conversation(p_task_id, p_text, p_expected_revision) $$;

create function company_os_api.release_conversation(p_task_id pg_catalog.uuid, p_expected_revision pg_catalog.int4)
returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_release_conversation(p_task_id, p_expected_revision) $$;

revoke all on function
  company_os_api.get_conversation(pg_catalog.uuid),
  company_os_api.reply_to_conversation(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4),
  company_os_api.release_conversation(pg_catalog.uuid, pg_catalog.int4)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function company_os_api.get_conversation(pg_catalog.uuid) to authenticated;
grant execute on function company_os_api.reply_to_conversation(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4) to authenticated;
grant execute on function company_os_api.release_conversation(pg_catalog.uuid, pg_catalog.int4) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. OD-8a lifecycle, steps 2 to 6, for exactly these three functions.
-- ---------------------------------------------------------------------------

grant ops_operator_api to postgres;
grant create on schema company_os_api to ops_operator_api;
alter function company_os_api.get_conversation(pg_catalog.uuid) owner to ops_operator_api;
alter function company_os_api.reply_to_conversation(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4) owner to ops_operator_api;
alter function company_os_api.release_conversation(pg_catalog.uuid, pg_catalog.int4) owner to ops_operator_api;
revoke create on schema company_os_api from ops_operator_api;
revoke ops_operator_api from postgres;

-- ---------------------------------------------------------------------------
-- 5. OD-8a step 7: assert the end state of the whole surface.
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
    'company_os_api.lose_opportunity(bigint,text,text)',
    'company_os_api.get_conversation(uuid)',
    'company_os_api.reply_to_conversation(uuid,text,integer)',
    'company_os_api.release_conversation(uuid,integer)'];
  -- The eight acts; every other exposed function stays a read.
  c_acts constant pg_catalog.text[] := array[
    'company_os_api.decide_review(uuid,text)', 'company_os_api.trip_stop(text,uuid)',
    'company_os_api.move_opportunity(bigint,text,text)',
    'company_os_api.set_opportunity_next_action(bigint,timestampwithtimezone,text)',
    'company_os_api.convert_opportunity(bigint,text,text)',
    'company_os_api.lose_opportunity(bigint,text,text)',
    'company_os_api.reply_to_conversation(uuid,text,integer)',
    'company_os_api.release_conversation(uuid,integer)'];
  -- The gates bounded by a 2 s lock wait: the trip, the commercial acts and
  -- the inbox acts.
  c_bounded constant pg_catalog.regprocedure[] := array[
    'ops.gate_trip_stop(pg_catalog.text, pg_catalog.uuid)'::pg_catalog.regprocedure,
    'ops.gate_move_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_set_opportunity_next_action(pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_convert_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_lose_opportunity(pg_catalog.int8, pg_catalog.text, pg_catalog.text)'::pg_catalog.regprocedure,
    'ops.gate_reply_to_conversation(pg_catalog.uuid, pg_catalog.text, pg_catalog.int4)'::pg_catalog.regprocedure,
    'ops.gate_release_conversation(pg_catalog.uuid, pg_catalog.int4)'::pg_catalog.regprocedure];
  -- The inbox's callees and the second-factor check: INVOKER, reachable only
  -- through the gates.
  c_callees constant pg_catalog.regprocedure[] := array[
    'ops.read_conversation(pg_catalog.uuid, pg_catalog.uuid)'::pg_catalog.regprocedure,
    'ops.reply_to_conversation_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text, pg_catalog.int4)'::pg_catalog.regprocedure,
    'ops.release_conversation_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4)'::pg_catalog.regprocedure,
    'ops.operator_second_factor_recent()'::pg_catalog.regprocedure];
  v_bad pg_catalog.text;
begin
  if pg_catalog.current_setting('company_os.migration_txid', true) is distinct from pg_catalog.txid_current()::pg_catalog.text then
    raise exception 'company_os_browser_inbox: the migration did not run in one transaction';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'ops_operator_api'
                  and not r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
                  and not r.rolbypassrls and not r.rolinherit) then
    raise exception 'ops_operator_api is missing or carries a login or a blanket attribute';
  end if;
  -- PostgreSQL 16 and later give the role's creator a membership at CREATE
  -- ROLE: ADMIN OPTION without INHERIT or SET, granted by the bootstrap
  -- superuser (OID 10), which the creator cannot revoke (measured 2026-10-01
  -- on Supabase PostgreSQL 17.6). It lets the migration identity administer
  -- the membership, as CREATEROLE did on 15, and confers no use of the role's
  -- privileges. That one row is the only membership admitted at rest.
  if exists (select 1 from pg_catalog.pg_auth_members m
              where (m.roleid = 'ops_operator_api'::pg_catalog.regrole or m.member = 'ops_operator_api'::pg_catalog.regrole)
                and not (m.roleid = 'ops_operator_api'::pg_catalog.regrole
                         and m.member = 'postgres'::pg_catalog.regrole
                         and m.grantor = 10::pg_catalog.oid
                         and m.admin_option and not m.inherit_option and not m.set_option)) then
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
  -- Exactly the eight acts are VOLATILE; every read stays STABLE.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and (p.provolatile <> 's') is distinct from
         (pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') = any (c_acts));
  if v_bad is not null then
    raise exception 'company_os_api function whose volatility contradicts the eight acts: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'company_os_api')
     or exists (select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'company_os_api') then
    raise exception 'company_os_api holds a relation, sequence or type';
  end if;

  -- In ops it executes exactly the gates, now 24; it touches no relation.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')
     and p.proname !~ '^gate_';
  if v_bad is not null then
    raise exception 'ops_operator_api can execute a non-gate ops function: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname ~ '^gate_' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')) <> 24 then
    raise exception 'ops_operator_api does not execute exactly the 24 gates';
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

  -- The trip gate, the four commercial gates and the two inbox gates carry
  -- the 2 s bound; nothing a browser-facing role can run clears a stop,
  -- sends, or reaches the outbound path.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (c_bounded) and p.proconfig is distinct from array['search_path=""', 'lock_timeout=2s'];
  if v_bad is not null then
    raise exception 'a bounded gate does not carry exactly the 2 s lock_timeout: %', v_bad;
  end if;
  if pg_catalog.array_length(c_bounded, 1) <> 7 then
    raise exception 'the bounded gates are not exactly seven';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              cross join (values ('authenticated'), ('ops_operator_api')) as r(role)
              where n.nspname = 'ops' and p.proname ~ '(outbound|send|clear)'
                and pg_catalog.has_function_privilege(r.role, p.oid, 'EXECUTE')) then
    raise exception 'a browser-facing role can execute a clear, outbound or send function';
  end if;
  -- The read gate is STABLE; the inbox's callees are INVOKER functions that
  -- neither browser-facing role executes.
  if (select p.provolatile from pg_catalog.pg_proc p
       where p.oid = 'ops.gate_get_conversation(pg_catalog.uuid)'::pg_catalog.regprocedure) <> 's'
     or (select p.provolatile from pg_catalog.pg_proc p
          where p.oid = 'company_os_api.get_conversation(pg_catalog.uuid)'::pg_catalog.regprocedure) <> 's' then
    raise exception 'the conversation read is not STABLE';
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (c_callees)
     and (p.prosecdef
          or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'an inbox callee is a DEFINER or reachable by a browser-facing role: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p where p.oid = any (c_callees)) <> 4 then
    raise exception 'an inbox callee is missing';
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
