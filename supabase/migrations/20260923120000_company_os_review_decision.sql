-- Phase 2C (S7.1): the first browser mutation, a member's review decision.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_2C_BRIEF.md §9 row 16, §7.5, §15, §19;
-- ADR 0019), after the S7 user-management prerequisite
-- (supabase/functions/users/userManagement.ts):
--
--   1. ops.decide_review_as_member: the one callee of the new gate. It finds
--      the review inside the caller's tenant first (a foreign or missing id is
--      the same OS404), refuses any review the browser may not decide (a
--      capability other than lead_triage, or an origin other than a synthetic
--      admission or a WhatsApp test channel: BASELINE Q8 is open, so real data
--      stays out of reach), then records the decision through the one
--      authoritative operation the owner CLI also uses,
--      ops.record_review_decision, with the source company-os-ui.
--   2. ops.gate_decide_review: the identity gate. Resolver first, exactly that
--      callee, no-store, the same fixed data-free errors as every gate.
--   3. company_os_api.decide_review(p_review_id, p_decision): the one act, owned
--      by ops_operator_api like every exposed function. The browser supplies a
--      review id and a decision, nothing else: the tenant and the actor come
--      from ops.operator_scope() only.
--   4. operator_context now reports decideReview true; tripStop stays false.
--   5. ops.cos_review_decidable: the one browser-decidable rule, shared by the
--      act and by get_review, whose allowedDecisions now lists only what the
--      act would accept, so no screen offers a decision the server refuses.
--
-- WHAT IT DELIBERATELY DOES NOT DO: send anything. Recording a decision
-- writes the review row and one lead_triage.reviewed event, as the CLI does,
-- and creates no outbound row, no job and no send authorisation (SI-45): an
-- accepted review is not a message approved for sending. It adds no stop
-- action, no table privilege, no generic entry point, and no bypass of the Q8
-- scope for any role or setting.
--
-- CONCURRENCY: ops.record_review_decision locks the review row (FOR UPDATE) and
-- a decision is final once, so of two concurrent decisions one is recorded and
-- the other is refused with OS409, except the same principal repeating the same
-- decision, which is answered as already recorded (recorded false).
--
-- OD-8a (brief §7.6; owner decisions S0-E, S0-F): this file is the second exact,
-- allowlisted migration. It runs the whole lifecycle itself, in one
-- transaction, for exactly the function it creates: assert the measured
-- migration identity; grant the capability role to that identity; grant it
-- CREATE on company_os_api; transfer the one catalogued function (ACL set
-- first); revoke CREATE; revoke the membership; assert the end state.

-- ---------------------------------------------------------------------------
-- 1. The measured migration identity, and one transaction.
-- ---------------------------------------------------------------------------

do $identity$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'company_os_review_decision: must run as the measured migration identity postgres, not %/%',
      current_user, session_user;
  end if;
  perform pg_catalog.set_config('company_os.migration_txid', pg_catalog.txid_current()::pg_catalog.text, true);
end
$identity$;

-- ---------------------------------------------------------------------------
-- 2. The callee: the review, found in the tenant, eligible, then decided.
-- ---------------------------------------------------------------------------

-- Whether the browser may decide a review at all: a lead_triage review whose
-- admission is synthetic, or WhatsApp on a channel still in test mode, read
-- now. BASELINE Q8 is open, so real data stays out of reach. No admission
-- row, any other kind, or a channel no longer in test mode is not decidable.
create function ops.cos_review_decidable(p_tenant pg_catalog.uuid, r ops.review_items) returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select r.capability = 'lead_triage' and exists (
    select 1 from ops.inbound_messages i
      left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
     where i.tenant_id = p_tenant and i.task_id = r.task_id
       and (i.source_kind = 'synthetic' or (i.source_kind = 'whatsapp' and ch.mode = 'test')));
$$;

create function ops.decide_review_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                            p_review_id pg_catalog.uuid, p_decision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_item   ops.review_items;
  v_result pg_catalog.jsonb;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'rejected', 'needs_edit') then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  -- The tenant lookup first, before any other branch: a review of another
  -- tenant and a review that does not exist are the same OS404.
  select * into v_item from ops.review_items r
   where r.id = p_review_id and r.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  -- Only a lead_triage review of a synthetic or test origin (BASELINE Q8).
  if not ops.cos_review_decidable(p_tenant_id, v_item) then
    raise exception using errcode = 'OS403', message = 'no access';
  end if;

  -- The one authoritative operation, shared with the owner CLI: final once,
  -- OS409 on any change, OS403 on accepting a do-not-contact lead. It sends
  -- nothing and writes nothing outside the review and its event.
  v_result := ops.record_review_decision(p_tenant_id, p_review_id, p_decision, p_actor, 'company-os-ui', null);
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()),
    'reviewItemId', v_result ->> 'review_item_id',
    'status', v_result ->> 'status',
    'recorded', (v_result ->> 'recorded')::pg_catalog.bool);
end
$$;

comment on function ops.decide_review_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text) is
  'The one callee of ops.gate_decide_review: finds the review in the caller''s tenant (OS404 otherwise), refuses a capability other than lead_triage or an origin outside the synthetic and test scope (OS403), then records the decision through ops.record_review_decision with the source company-os-ui. Sends nothing.';

-- ---------------------------------------------------------------------------
-- 3. The identity gate.
-- ---------------------------------------------------------------------------

create function ops.gate_decide_review(p_review_id pg_catalog.uuid, p_decision pg_catalog.text) returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.decide_review_as_member(v.tenant_id, v.actor, p_review_id, p_decision);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.decide_review: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.decide_review: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.decide_review: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.decide_review: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.decide_review: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.decide_review: internal error';
end
$$;

-- ---------------------------------------------------------------------------
-- 4. operator_context: the decision is now an allowed action.
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
    -- The review decision exists (S7.1); the trip does not (S8).
    'allowedActions', pg_catalog.jsonb_build_object('decideReview', true, 'tripStop', false, 'viewAdvice', true),
    'serverTime', ops.cos_ts(pg_catalog.clock_timestamp()));
$$;

-- get_review: the decisions listed are exactly those the act would accept.
create or replace function ops.read_review_detail(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()))
    || ops.cos_review_summary(p_tenant_id, v_item)
    || pg_catalog.jsonb_build_object(
      'decisionNote', v_item.decision_note,
      'allowedDecisions', case when v_item.status <> 'pending' or not ops.cos_review_decidable(p_tenant_id, v_item)
                                 then '[]'::pg_catalog.jsonb
                               when v_item.do_not_contact then '["rejected", "needs_edit"]'::pg_catalog.jsonb
                               else '["accepted", "rejected", "needs_edit"]'::pg_catalog.jsonb end);
end
$$;

revoke all on function
  ops.cos_review_decidable(pg_catalog.uuid, ops.review_items),
  ops.decide_review_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.text),
  ops.gate_decide_review(pg_catalog.uuid, pg_catalog.text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 5. The gate's one grant, and the exposed act.
-- ---------------------------------------------------------------------------

grant execute on function ops.gate_decide_review(pg_catalog.uuid, pg_catalog.text) to ops_operator_api;

create function company_os_api.decide_review(p_review_id pg_catalog.uuid, p_decision pg_catalog.text) returns pg_catalog.jsonb
language sql volatile security definer set search_path = '' as $$ select ops.gate_decide_review(p_review_id, p_decision) $$;

revoke all on function company_os_api.decide_review(pg_catalog.uuid, pg_catalog.text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function company_os_api.decide_review(pg_catalog.uuid, pg_catalog.text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. OD-8a lifecycle, steps 2 to 6, for exactly this function.
-- ---------------------------------------------------------------------------

grant ops_operator_api to postgres;
grant create on schema company_os_api to ops_operator_api;
alter function company_os_api.decide_review(pg_catalog.uuid, pg_catalog.text) owner to ops_operator_api;
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
    'company_os_api.decide_review(uuid,text)'];
  -- The one act; every other exposed function stays a read.
  c_acts constant pg_catalog.text[] := array['company_os_api.decide_review(uuid,text)'];
  v_bad pg_catalog.text;
begin
  if pg_catalog.current_setting('company_os.migration_txid', true) is distinct from pg_catalog.txid_current()::pg_catalog.text then
    raise exception 'company_os_review_decision: the migration did not run in one transaction';
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
  -- Exactly one act: the reads stay STABLE, and only decide_review writes.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and (p.provolatile <> 's') is distinct from
         (pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') = any (c_acts));
  if v_bad is not null then
    raise exception 'company_os_api function whose volatility contradicts the one act: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'company_os_api')
     or exists (select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'company_os_api') then
    raise exception 'company_os_api holds a relation, sequence or type';
  end if;

  -- In ops it executes exactly the gates, now 16; it touches no relation.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')
     and p.proname !~ '^gate_';
  if v_bad is not null then
    raise exception 'ops_operator_api can execute a non-gate ops function: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname ~ '^gate_' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')) <> 16 then
    raise exception 'ops_operator_api does not execute exactly the 16 gates';
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

  -- The browser still reaches no send: no application or capability role
  -- executes the outbound request or the send path, directly.
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              cross join (values ('authenticated'), ('ops_operator_api')) as r(role)
              where n.nspname = 'ops' and p.proname ~ '(outbound|send)'
                and pg_catalog.has_function_privilege(r.role, p.oid, 'EXECUTE')) then
    raise exception 'a browser-facing role can execute an outbound or send function';
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
