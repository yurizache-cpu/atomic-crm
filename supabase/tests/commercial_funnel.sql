-- Phase 3B.1 — the commercial funnel and the deal stage-transition ledger,
-- attacked in SQL.
--
-- The questions: does the ledger record exactly one row per stage entry or
-- change, inside the deal write's own transaction, and nothing else; can
-- anyone but its trigger write it, or anyone change it; does a CRM user's
-- ordinary write still work; is every funnel number exact; is a deal's origin
-- never guessed; does the funnel carry anything personal; and can a tenant
-- that does not own the local CRM read anything of it?
--
--   F1  the CRM adapter, pinned: INVOKER, owned by postgres, reachable by no
--       role, read only, and reading exactly the five CRM tables it needs;
--   L1  ledger access: no application or capability role holds a privilege,
--       RLS is on with no policy, and the triggers are enabled;
--   L2  ledger semantics: entry, A -> B, B -> C, no row for C -> C or another
--       column, none for a refused write or a rolled-back one; append-only;
--       a deal's deletion cascades;
--   L3  a CRM user, as the browser: an ordinary insert and stage change work
--       and are observed; the ledger itself is unreadable and unwritable;
--   M   the funnel's numbers, exact, against a fixed as-of instant: stage
--       order, totals, the unconfigured bucket, active, next-action states,
--       stage age, outcomes, conflicts, the closing denominator, attention
--       lists, recent movement and the configuration states;
--   A   origin: one recorded source, several, none, several contacts, and a
--       value shaped like an identifier;
--   N   minimisation: no title, name, contact id, click id, campaign or note;
--   T   tenancy: only the tenant that owns the local CRM reads it; another
--       reads not_configured, byte for byte, whatever the CRM holds;
--   X   deliberate breaks, each caught by its own check.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

create temporary table cf_ids (name text primary key, id bigint, uid uuid) on commit drop;

-- Refused with this SQLSTATE, or the suite fails naming the case.
create function pg_temp.expect_refused(p_case text, p_state text, p_sql text) returns void
language plpgsql as $f$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_state then
      raise exception '%: expected SQLSTATE %, got % (%)', p_case, p_state, sqlstate, sqlerrm;
    end if;
    return;
  end;
  raise exception '%: was accepted', p_case;
end
$f$;

create function pg_temp.id(p_name text) returns bigint language sql stable as $$
  select id from cf_ids where name = p_name;
$$;
create function pg_temp.uid(p_name text) returns uuid language sql stable as $$
  select uid from cf_ids where name = p_name;
$$;

-- The CRM starts empty inside this transaction; nothing another suite or the
-- seed wrote is counted.
delete from public.deals;
delete from public.acquisition_attributions;

-- Two tenants. A owns the local CRM; B does not.
do $$
declare
  t uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  foreach t in array array[gen_random_uuid(), gen_random_uuid()] loop
    insert into ops.tenants (id, slug, name) values (t, 'cf-' || left(t::text, 8), 'CF synthetic');
  end loop;
  insert into cf_ids (name, uid)
  select 'ta', id from ops.tenants where slug like 'cf-%' order by id limit 1;
  insert into cf_ids (name, uid)
  select 'tb', id from ops.tenants where slug like 'cf-%' and id <> pg_temp.uid('ta');
  update ops.tenants set owns_local_crm = true where id = pg_temp.uid('ta');
  perform ops.set_scheduling_timezone(pg_temp.uid('ta'), 'America/Sao_Paulo', 'cf-owner');
end
$$;

-- ===========================================================================
-- F1. The CRM adapter, pinned.
-- ===========================================================================

create function pg_temp.check_adapter() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(p.proname || ' (' || concat_ws(' ',
           case when p.prosecdef then 'DEFINER' end,
           case when p.proowner <> 'postgres'::regrole then 'owner' end,
           case when p.proacl is distinct from '{postgres=X/postgres}'::aclitem[] then 'acl ' || coalesce(p.proacl::text, 'PUBLIC') end,
           case when p.proconfig is distinct from '{"search_path=\"\""}'::text[] then 'config' end,
           case when p.provolatile not in ('s', 'i') then 'volatile' end) || ')', ', ') into v_bad
    from pg_proc p
   where p.pronamespace = 'ops'::regnamespace and p.proname ~ '^crm_(commercial_funnel|deal_card|deal_origin|text_ok|safe_amount)$'
     and (p.prosecdef or p.proowner <> 'postgres'::regrole
          or p.proacl is distinct from '{postgres=X/postgres}'::aclitem[]
          or p.proconfig is distinct from '{"search_path=\"\""}'::text[] or p.provolatile not in ('s', 'i'));
  if v_bad is not null then
    raise exception 'F1: a CRM adapter function is DEFINER, reachable, unpinned or volatile: %', v_bad;
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'ops'::regnamespace
       and p.proname ~ '^crm_(commercial_funnel|deal_card|deal_origin|text_ok|safe_amount)$') <> 5 then
    raise exception 'F1: the CRM adapter is not exactly its five functions';
  end if;
  -- Read only: no write verb and no dynamic SQL in the code (string literals
  -- are data and emptied first).
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p,
         lateral (select regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '''([^'']|'''')*''', '''''', 'g') as code) c
   where p.pronamespace = 'ops'::regnamespace and p.proname ~ '^crm_(commercial_funnel|deal_card|deal_origin|text_ok|safe_amount)$'
     and (c.code ~* '\m(insert|update|delete|truncate|merge|copy|execute|perform)\M');
  if v_bad is not null then
    raise exception 'F1: a CRM adapter function writes or runs dynamic SQL: %', v_bad;
  end if;
  -- Exactly the five CRM tables, and nothing else of schema public.
  select string_agg(distinct m[1], ', ') into v_bad
    from pg_proc p, lateral regexp_matches(p.prosrc, 'public\.([a-z_]+)', 'g') m
   where p.pronamespace = 'ops'::regnamespace and p.proname ~ '^crm_(commercial_funnel|deal_card|deal_origin|text_ok|safe_amount)$'
     and m[1] not in ('deals', 'configuration', 'acquisition_attributions', 'loss_reasons', 'deal_stage_transitions');
  if v_bad is not null then
    raise exception 'F1: the CRM adapter reads % beyond its five tables', v_bad;
  end if;
  -- It calls only its own helpers and the timestamp formatter in ops.
  select string_agg(distinct m[1], ', ') into v_bad
    from pg_proc p, lateral regexp_matches(p.prosrc, 'ops\.([a-z_0-9]+)\s*\(', 'g') m
   where p.pronamespace = 'ops'::regnamespace and p.proname ~ '^crm_(commercial_funnel|deal_card|deal_origin|text_ok|safe_amount)$'
     and m[1] !~ '^crm_(deal_card|deal_origin|text_ok|safe_amount)$' and m[1] <> 'cos_ts';
  if v_bad is not null then
    raise exception 'F1: the CRM adapter calls %', v_bad;
  end if;
  -- The neutral entry reads nothing of the CRM itself and calls it only
  -- through crm_commercial_funnel.
  if (select p.prosrc from pg_proc p where p.oid = 'ops.cos_commercial_funnel(uuid, timestamptz)'::regprocedure)
       ~* '\mpublic\.|owns_local_crm|crm_(deal|text|safe)' then
    raise exception 'F1: ops.cos_commercial_funnel reaches the CRM other than through crm_commercial_funnel';
  end if;
end
$f$;

select pg_temp.check_adapter();

-- ===========================================================================
-- L1. Ledger access.
-- ===========================================================================

create function pg_temp.check_ledger_access() returns void
language plpgsql as $f$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_table_privilege(v_role, 'public.deal_stage_transitions', 'select, insert, update, delete, truncate, references, trigger')
       or has_sequence_privilege(v_role, 'public.deal_stage_transitions_id_seq', 'usage, select, update')
       or has_function_privilege(v_role, 'public.record_deal_stage_transition()', 'execute')
       or has_function_privilege(v_role, 'public.deal_stage_transitions_append_only()', 'execute') then
      raise exception 'L1: % holds a privilege on the deal stage-transition ledger', v_role;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.deal_stage_transitions'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.deal_stage_transitions'::regclass) then
    raise exception 'L1: the ledger must have RLS on and no policy';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.record_deal_stage_transition()'::regprocedure) then
    raise exception 'L1: the ledger writer must be SECURITY DEFINER, or a CRM user''s deal write would fail';
  end if;
end
$f$;

select pg_temp.check_ledger_access();

-- ===========================================================================
-- L2. Ledger semantics.
-- ===========================================================================

create function pg_temp.ledger_of(p_deal bigint) returns text language sql stable as $$
  select coalesce(string_agg(coalesce(t.from_stage, '()') || '>' || t.to_stage, ' ' order by t.id), '')
    from public.deal_stage_transitions t where t.deal_id = p_deal;
$$;

create function pg_temp.check_ledger_records() returns void
language plpgsql as $f$
declare
  v_deal bigint;
begin
  insert into public.deals (name, stage, pipeline_stage) values ('CF-SENTINEL ledger', 'a', 'a') returning id into v_deal;
  if pg_temp.ledger_of(v_deal) <> '()>a' then
    raise exception 'L2: an inserted deal must record exactly its entry, got "%"', pg_temp.ledger_of(v_deal);
  end if;
  update public.deals set pipeline_stage = 'b' where id = v_deal;
  update public.deals set pipeline_stage = 'c' where id = v_deal;
  if pg_temp.ledger_of(v_deal) <> '()>a a>b b>c' then
    raise exception 'L2: A -> B -> C must record one row each, got "%"', pg_temp.ledger_of(v_deal);
  end if;
  update public.deals set pipeline_stage = 'c' where id = v_deal;
  update public.deals set amount = 7, next_action_at = now() where id = v_deal;
  if pg_temp.ledger_of(v_deal) <> '()>a a>b b>c' then
    raise exception 'L2: a same-stage or other-column update must record nothing, got "%"', pg_temp.ledger_of(v_deal);
  end if;
  delete from public.deals where id = v_deal;
end
$f$;

select pg_temp.check_ledger_records();

do $$
declare
  v_deal bigint;
begin
  insert into public.deals (name, stage, pipeline_stage) values ('CF-SENTINEL refused', 'a', 'a') returning id into v_deal;
  insert into cf_ids (name, id) values ('refused', v_deal);
  -- A refused write (lost without a reason) changes nothing and records nothing.
  perform pg_temp.expect_refused('L2 refused write', '23514',
    format('update public.deals set pipeline_stage = %L, lost_at = now() where id = %s', 'b', v_deal));
  if pg_temp.ledger_of(v_deal) <> '()>a' or (select pipeline_stage from public.deals where id = v_deal) <> 'a' then
    raise exception 'L2: a refused deal write must record nothing and keep the stage';
  end if;
  -- A rolled-back change takes its observation with it.
  begin
    update public.deals set pipeline_stage = 'b' where id = v_deal;
    raise exception using errcode = 'P0001', message = 'cf-rollback';
  exception when sqlstate 'P0001' then
    null;
  end;
  if pg_temp.ledger_of(v_deal) <> '()>a' or (select pipeline_stage from public.deals where id = v_deal) <> 'a' then
    raise exception 'L2: a rolled-back change must roll back both the stage and its observation';
  end if;
  -- Append-only, the owner included.
  perform pg_temp.expect_refused('L2 update a ledger row', '42501',
    format('update public.deal_stage_transitions set to_stage = %L where deal_id = %s', 'x', v_deal));
  perform pg_temp.expect_refused('L2 delete a ledger row', '42501',
    format('delete from public.deal_stage_transitions where deal_id = %s', v_deal));
  -- Deleting the deal cascades: erasure stays possible.
  delete from public.deals where id = v_deal;
  if exists (select 1 from public.deal_stage_transitions where deal_id = v_deal) then
    raise exception 'L2: a deleted deal''s observations must cascade';
  end if;
end
$$;

-- ===========================================================================
-- L3. A CRM user, as the browser.
-- ===========================================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values ('cf000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'cf-sentinel@test.local', 'x', now(), now(), now(), '{}',
        '{"first_name":"CF-SENTINEL","last_name":"Operator"}');

do $$
declare
  v_deal bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cf000000-0000-4000-8000-000000000001"}';
  insert into public.deals (name, stage, pipeline_stage) values ('CF-SENTINEL browser', 'a', 'a') returning id into v_deal;
  update public.deals set pipeline_stage = 'b' where id = v_deal;
  begin
    perform 1 from public.deal_stage_transitions limit 1;
    raise exception 'L3: a CRM user read the ledger';
  exception when insufficient_privilege then
    null;
  end;
  begin
    insert into public.deal_stage_transitions (deal_id, from_stage, to_stage, changed_at) values (v_deal, 'x', 'y', now());
    raise exception 'L3: a CRM user wrote the ledger';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  if pg_temp.ledger_of(v_deal) <> '()>a a>b' then
    raise exception 'L3: a CRM user''s own writes must be observed, got "%"', pg_temp.ledger_of(v_deal);
  end if;
  delete from public.deals where id = v_deal;
end
$$;

-- ===========================================================================
-- M, A, N. The funnel, against a fixed CRM.
-- ===========================================================================

-- Stages stored out of alphabetical order: the funnel must keep this order.
update public.configuration set config = jsonb_build_object(
  'currency', 'BRL',
  'dealStages', jsonb_build_array(
    jsonb_build_object('value', 'zeta', 'label', 'Etapa Z'),
    jsonb_build_object('value', 'alpha', 'label', 'Etapa A'),
    jsonb_build_object('value', 'mid', 'label', 'Etapa M'),
    jsonb_build_object('value', 'won', 'label', 'Fechada')),
  'dealPipelineStatuses', jsonb_build_array('won'))
 where id = 1;

-- Contacts: every name and click id carries the sentinel.
do $$
declare
  c bigint;
  v_name text;
begin
  foreach v_name in array array['c1', 'c2', 'c3', 'c4', 'c6'] loop
    insert into public.contacts (first_name, last_name) values ('CF-SENTINEL', v_name) returning id into c;
    insert into cf_ids (name, id) values (v_name, c);
  end loop;
  insert into public.acquisition_attributions (contact_id, source, campaign, gclid, keyword) values
    (pg_temp.id('c1'), 'Google Ads', 'CF-SENTINEL campaign', 'CF-SENTINEL-gclid', 'CF-SENTINEL keyword'),
    (pg_temp.id('c1'), '  Google   Ads ', null, null, null),
    (pg_temp.id('c2'), 'Google Ads', null, null, null),
    (pg_temp.id('c2'), 'Orgânico', null, null, null),
    (pg_temp.id('c3'), 'Orgânico', null, null, null),
    (pg_temp.id('c4'), '5511999998888', null, null, null),
    (pg_temp.id('c6'), 'Indicação', null, null, null);
end
$$;

create function pg_temp.deal(
  p_name text, p_stage text, p_created interval, p_entered interval,
  p_next timestamptz = null, p_contacts bigint[] = null, p_amount bigint = null,
  p_archived boolean = false, p_lost interval = null, p_converted interval = null) returns bigint
language plpgsql as $f$
declare
  v_id bigint;
begin
  insert into public.deals (name, stage, pipeline_stage, contact_ids, amount, description,
                            created_at, stage_entered_at, next_action_at, archived_at,
                            lost_at, loss_reason_id, converted_at)
  values ('CF-SENTINEL ' || p_name, p_stage, p_stage, p_contacts, p_amount, 'CF-SENTINEL note',
          now() - p_created, now() - p_entered, p_next,
          case when p_archived then now() - interval '1 hour' end,
          now() - p_lost,
          case when p_lost is not null then (select id from public.loss_reasons where code = 'price') end,
          now() - p_converted)
  returning id into v_id;
  insert into cf_ids (name, id) values (p_name, v_id);
  return v_id;
end
$f$;

do $$
begin
  -- Open, overdue, 8 days in stage, one recorded origin (c1: one source, twice).
  perform pg_temp.deal('d1', 'zeta', '1 day', '8 days', now() - interval '1 hour', array[pg_temp.id('c1')], 100);
  -- Open, due today, 2 days in stage, two differing sources (c2): multiple.
  perform pg_temp.deal('d2', 'zeta', '1 day', '2 days', now(), array[pg_temp.id('c2')], 200);
  -- Open, no next action, entered today, two contacts: multiple.
  perform pg_temp.deal('d3', 'alpha', '1 day', '0 hours', null, array[pg_temp.id('c1'), pg_temp.id('c3')]);
  -- Archived: off the board and the counts, but a dated fact.
  perform pg_temp.deal('d4', 'alpha', '1 day', '1 day', p_archived => true);
  -- Lost 3 days ago with a reason.
  perform pg_temp.deal('d5', 'mid', '1 day', '4 days', p_lost => '3 days');
  -- Converted 5 days ago, in the converted stage; one recorded origin (c6).
  perform pg_temp.deal('d6', 'won', '20 days', '5 days', null, array[pg_temp.id('c6')], 900, p_converted => '5 days');
  -- In the converted stage with no converted_at: converted by configuration only.
  perform pg_temp.deal('d7', 'won', '1 day', '1 day');
  -- converted_at 10 days ago, in an open stage: converted, not active.
  perform pg_temp.deal('d8', 'mid', '1 day', '12 days', p_converted => '10 days');
  -- A stage the configuration does not list: counted apart, and active.
  perform pg_temp.deal('d9', 'CF-SENTINEL-legacy', '1 day', '20 days');
  -- Converted 40 days ago: outside the window.
  perform pg_temp.deal('d10', 'mid', '45 days', '41 days', p_converted => '40 days');
  -- Lost AND converted 2 days ago: conflicting, in neither outcome.
  perform pg_temp.deal('d11', 'mid', '1 day', '3 days', p_lost => '2 days', p_converted => '2 days');
  -- Open, future action, its one contact's source looks like a phone: withheld.
  perform pg_temp.deal('d12', 'mid', '1 day', '1 day', now() + interval '3 days', array[pg_temp.id('c4')]);
  -- Created 100 days ago and archived: outside every window.
  perform pg_temp.deal('d14', 'alpha', '100 days', '100 days', null, array[pg_temp.id('c1')], p_archived => true);
end
$$;

create function pg_temp.funnel(p_tenant text, p_as_of timestamptz = now()) returns jsonb
language sql stable as $$
  select ops.cos_commercial_funnel(pg_temp.uid(p_tenant), p_as_of);
$$;

create function pg_temp.refs(p jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(e ->> 'dealRef', ',' order by o), '') from jsonb_array_elements(p) with ordinality as x (e, o);
$$;

create function pg_temp.named(p_refs text) returns text language sql stable as $$
  select coalesce(string_agg(i.name, ',' order by o), '')
    from unnest(string_to_array(nullif(p_refs, ''), ',')) with ordinality as r (ref, o)
    join cf_ids i on i.id = r.ref::bigint and i.name ~ '^d[0-9]+$';
$$;

create function pg_temp.check_funnel() returns void
language plpgsql as $f$
declare
  f   jsonb := pg_temp.funnel('ta');
  s   jsonb := f -> 'summary';
  v   text;
begin
  if f ->> 'status' <> 'available' or f ->> 'timezone' <> 'America/Sao_Paulo' or f ->> 'currency' <> 'BRL' then
    raise exception 'M: the owner''s funnel must be available in its scheduling zone: %', f - 'stages';
  end if;
  -- The configured order, the converted flag and the exact totals.
  select string_agg(format('%s:%s:%s:%s', e ->> 'code', e ->> 'label', e ->> 'total', e ->> 'converted'), ' ' order by (e ->> 'position')::int)
    into v from jsonb_array_elements(f -> 'stages') e;
  if v <> 'zeta:Etapa Z:2:false alpha:Etapa A:1:false mid:Etapa M:3:false won:Fechada:2:true' then
    raise exception 'M: stage order, labels or totals drifted: %', v;
  end if;
  -- Cards per stage, in order: open oldest first, converted most recent first.
  select string_agg(e ->> 'code' || '=' || pg_temp.named(pg_temp.refs(e -> 'cards')), ' ' order by (e ->> 'position')::int)
    into v from jsonb_array_elements(f -> 'stages') e;
  if v <> 'zeta=d1,d2 alpha=d3 mid=d10,d8,d12 won=d7,d6' then
    raise exception 'M: the board''s cards drifted: %', v;
  end if;
  if (f -> 'unconfigured' ->> 'total')::int <> 1 or pg_temp.named(pg_temp.refs(f -> 'unconfigured' -> 'cards')) <> 'd9'
     or (f -> 'unconfigured' -> 'cards' -> 0 ->> 'stage') is not null then
    raise exception 'M: the unconfigured-stage bucket drifted: %', f -> 'unconfigured';
  end if;
  if (select (e ->> 'amountTotal')::bigint from jsonb_array_elements(f -> 'stages') e where e ->> 'code' = 'zeta') <> 300
     or (select (e ->> 'amountCount')::int from jsonb_array_elements(f -> 'stages') e where e ->> 'code' = 'alpha') <> 0 then
    raise exception 'M: the informed amounts drifted';
  end if;
  -- Active and the next-action states, exact.
  if (s ->> 'active')::int <> 5 or (s ->> 'overdue')::int <> 1 or (s ->> 'dueToday')::int <> 1
     or (s ->> 'noNextAction')::int <> 2 or (s ->> 'convertedUndated')::int <> 1 then
    raise exception 'M: active or next-action counts drifted: %', s;
  end if;
  -- New deals, outcomes and conflicts in the 30-day window, exact.
  if (s ->> 'windowDays')::int <> 30 or (s ->> 'newDeals')::int <> 11 or (s ->> 'converted')::int <> 2
     or (s ->> 'lost')::int <> 1 or (s ->> 'conflicting')::int <> 1 then
    raise exception 'M: new, converted, lost or conflicting counts drifted: %', s;
  end if;
  -- The closing denominator is the closed outcomes of the window: 2 + 1.
  if (s ->> 'converted')::int + (s ->> 'lost')::int <> 3 then
    raise exception 'M: the closing denominator drifted';
  end if;
  -- Cards: stage age from stage_entered_at in the scheduling zone, the
  -- next-action state and the outcome.
  select string_agg(format('%s:%s:%s:%s', pg_temp.named(c ->> 'dealRef'), c ->> 'stageAgeDays', c ->> 'nextAction', c ->> 'outcome'), ' '
                    order by pg_temp.named(c ->> 'dealRef'))
    into v
    from jsonb_array_elements(f -> 'stages') e, jsonb_array_elements(e -> 'cards') c;
  if v <> 'd1:8:overdue:open d10:41:none:converted d12:1:future:open d2:2:today:open d3:0:none:open d6:5:none:converted d7:1:none:converted d8:12:none:converted' then
    raise exception 'M: a card''s age, next action or outcome drifted: %', v;
  end if;
  -- Attention: overdue by due time, no next action oldest in stage first.
  if pg_temp.named(pg_temp.refs(f -> 'attention' -> 'overdue' -> 'items')) <> 'd1'
     or (f -> 'attention' -> 'overdue' ->> 'total')::int <> 1
     or pg_temp.named(pg_temp.refs(f -> 'attention' -> 'noNextAction' -> 'items')) <> 'd9,d3'
     or (f -> 'attention' -> 'noNextAction' ->> 'total')::int <> 2 then
    raise exception 'M: the attention lists drifted: %', f -> 'attention';
  end if;
  -- Recent outcomes: converted and lost, most recent first, the conflict in neither.
  if pg_temp.named(pg_temp.refs(f -> 'outcomes' -> 'converted' -> 'items')) <> 'd6,d8'
     or pg_temp.named(pg_temp.refs(f -> 'outcomes' -> 'lost' -> 'items')) <> 'd5'
     or f -> 'outcomes' -> 'lost' -> 'items' -> 0 ->> 'reason' <> 'Preço'
     or f -> 'outcomes' -> 'lost' -> 'items' -> 0 ->> 'stage' <> 'mid' then
    raise exception 'M: the recent outcomes drifted: %', f -> 'outcomes';
  end if;
end
$f$;

select pg_temp.check_funnel();

-- A. Origin: recorded once (whitespace aside), several sources, several
-- contacts, none, and a value shaped like an identifier.
do $$
declare
  f jsonb := pg_temp.funnel('ta');
  v text;
begin
  select string_agg(pg_temp.named(c ->> 'dealRef') || '=' || (c -> 'origin' ->> 'kind') || coalesce(':' || (c -> 'origin' ->> 'label'), ''),
                    ' ' order by pg_temp.named(c ->> 'dealRef'))
    into v
    from jsonb_array_elements(f -> 'stages') e, jsonb_array_elements(e -> 'cards') c;
  if v <> 'd1=recorded:Google Ads d10=unknown d12=withheld d2=multiple d3=multiple d6=recorded:Indicação d7=unknown d8=unknown' then
    raise exception 'A: a deal''s origin drifted: %', v;
  end if;
  -- The 90-day breakdown: recorded labels by count, then unknown, multiple, withheld.
  select string_agg((i ->> 'kind') || coalesce(':' || (i ->> 'label'), '') || '=' || (i ->> 'count'), ' ' order by o)
    into v from jsonb_array_elements(f -> 'origins' -> 'items') with ordinality as x (i, o);
  if v <> 'recorded:Google Ads=1 recorded:Indicação=1 unknown=7 multiple=2 withheld=1'
     or (f -> 'origins' ->> 'total')::int <> 12 or (f -> 'origins' ->> 'windowDays')::int <> 90 then
    raise exception 'A: the origin breakdown drifted: % (total %)', v, f -> 'origins' ->> 'total';
  end if;
end
$$;

-- N. Minimisation: no title, name, note, legacy code, click id, campaign or
-- keyword, and no key that names a contact.
create function pg_temp.check_minimised(p jsonb) returns void
language plpgsql as $f$
begin
  if p::text ~ 'CF-SENTINEL|5511999998888|cf-sentinel@' then
    raise exception 'N: the funnel carries a sentinel: %', substring(p::text from 'CF-SENTINEL.{0,40}');
  end if;
  if exists (select 1 from jsonb_path_query(p, 'strict $.**') j
              where jsonb_typeof(j) = 'object'
                and exists (select 1 from jsonb_object_keys(j) k
                             where k ~* 'contact|name|email|phone|note|description|gclid|campaign|keyword|utm|title|actor')) then
    raise exception 'N: the funnel carries a personal or free-text key';
  end if;
end
$f$;

select pg_temp.check_minimised(pg_temp.funnel('ta'));

-- Movement: the observations of this transaction's deals, newest first, with
-- the coverage start and no stage outside the configuration named. The move
-- is rolled back afterwards, so d1 keeps its stage age for the checks below.
-- (The CRM was emptied at the start, which cascaded every older observation.)
do $$
declare
  f jsonb;
  m jsonb;
begin
  begin
    update public.deals set pipeline_stage = 'alpha' where id = pg_temp.id('d1');
    f := pg_temp.funnel('ta', clock_timestamp() + interval '1 second');
    m := f -> 'movements';
    if m -> 'items' -> 0 ->> 'dealRef' <> pg_temp.id('d1')::text
       or m -> 'items' -> 0 ->> 'fromStage' <> 'zeta' or m -> 'items' -> 0 ->> 'toStage' <> 'alpha'
       or (m -> 'items' -> 0 ->> 'entered')::boolean then
      raise exception 'M: the newest movement must be d1 zeta -> alpha: %', m -> 'items' -> 0;
    end if;
    -- 13 entries (d1 to d12, d14) and the one move.
    if (m ->> 'totalInWindow')::int <> 14 or jsonb_array_length(m -> 'items') <> 14
       or (m ->> 'windowDays')::int <> 30 or m ->> 'coverageStart' is null then
      raise exception 'M: movement must carry its exact total, its items and its coverage start: %', m - 'items';
    end if;
    if not exists (select 1 from jsonb_array_elements(m -> 'items') i
                    where i ->> 'dealRef' = pg_temp.id('d9')::text and (i ->> 'entered')::boolean
                      and (i ->> 'toStage') is null) then
      raise exception 'M: a stage outside the configuration must be observed but not named';
    end if;
    raise exception using errcode = 'P0002', message = 'cf-undo-move';
  exception when sqlstate 'P0002' then
    null;
  end;
  if (select pipeline_stage from public.deals where id = pg_temp.id('d1')) <> 'zeta' then
    raise exception 'M: the movement check must leave d1 where it was';
  end if;
end
$$;

-- The configuration states: absent, malformed, a converted stage it does not
-- list, and a non-array.
do $$
declare
  v_saved jsonb := (select config from public.configuration where id = 1);
  v_case  jsonb;
begin
  update public.configuration set config = '{}' where id = 1;
  if pg_temp.funnel('ta') <> '{"status": "stages_not_configured", "reason": "missing"}' then
    raise exception 'M: an absent stage configuration must read missing: %', pg_temp.funnel('ta');
  end if;
  foreach v_case in array array[
    '{"dealStages": "x", "dealPipelineStatuses": []}',
    '{"dealStages": [{"value": "a", "label": "A"}]}',
    '{"dealStages": [{"value": "a", "label": "A"}], "dealPipelineStatuses": ["b"]}',
    '{"dealStages": [{"value": "a", "label": "A"}, {"value": "a", "label": "B"}], "dealPipelineStatuses": []}',
    '{"dealStages": [{"value": "a", "label": " "}], "dealPipelineStatuses": []}',
    '{"dealStages": [], "dealPipelineStatuses": []}']::jsonb[] loop
    update public.configuration set config = v_case where id = 1;
    if pg_temp.funnel('ta') <> '{"status": "stages_not_configured", "reason": "invalid"}' then
      raise exception 'M: a malformed stage configuration must read invalid: % -> %', v_case, pg_temp.funnel('ta');
    end if;
  end loop;
  update public.configuration set config = v_saved where id = 1;
end
$$;

-- ===========================================================================
-- T. Tenancy.
-- ===========================================================================

create function pg_temp.check_tenancy() returns void
language plpgsql as $f$
declare
  v_before jsonb := ops.read_overview(pg_temp.uid('tb')) -> 'funnel';
  v_deal   bigint;
begin
  if v_before is distinct from '{"status": "not_configured"}'::jsonb then
    raise exception 'T: a tenant without the local CRM must read not_configured: %', v_before;
  end if;
  insert into public.deals (name, stage, pipeline_stage) values ('CF-SENTINEL tenancy', 'zeta', 'zeta') returning id into v_deal;
  if (ops.read_overview(pg_temp.uid('tb')) -> 'funnel')::text <> v_before::text then
    raise exception 'T: another tenant''s funnel changed when the CRM did';
  end if;
  if (ops.read_overview(pg_temp.uid('ta')) -> 'funnel' ->> 'status') <> 'available' then
    raise exception 'T: the owning tenant must read its funnel through the overview';
  end if;
  delete from public.deals where id = v_deal;
  if ops.cos_commercial_funnel(null, now()) is distinct from '{"status": "not_configured"}'::jsonb then
    raise exception 'T: no tenant reads not_configured';
  end if;
end
$f$;

select pg_temp.check_tenancy();

-- Ownership moves: the previous owner then reads nothing.
do $$
begin
  update ops.tenants set owns_local_crm = false where id = pg_temp.uid('ta');
  update ops.tenants set owns_local_crm = true where id = pg_temp.uid('tb');
  if pg_temp.funnel('ta') is distinct from '{"status": "not_configured"}'::jsonb
     or pg_temp.funnel('tb') ->> 'status' <> 'available' then
    raise exception 'T: the funnel must follow owns_local_crm';
  end if;
  update ops.tenants set owns_local_crm = false where id = pg_temp.uid('tb');
  update ops.tenants set owns_local_crm = true where id = pg_temp.uid('ta');
end
$$;

-- The browser supplies no tenant: the overview takes none.
do $$
begin
  if (select pronargs from pg_proc where oid = 'company_os_api.overview()'::regprocedure) <> 0 then
    raise exception 'T: company_os_api.overview must take no argument';
  end if;
end
$$;

-- ===========================================================================
-- X. Deliberate breaks, each rolled back, each caught by its own check.
-- ===========================================================================

create function pg_temp.expect_caught(p_case text, p_break text, p_check text, p_message text) returns void
language plpgsql as $f$
begin
  begin
    execute p_break;
    begin
      execute p_check;
    exception when others then
      if sqlerrm !~ p_message then
        raise exception '%: caught by the wrong check: %', p_case, sqlerrm;
      end if;
      raise exception using errcode = 'P0002', message = 'cf-caught';
    end;
    raise exception '%: the break was not caught', p_case;
  exception when sqlstate 'P0002' then
    null;
  end;
end
$f$;

-- X1. Without the trigger, a stage change is not observed.
select pg_temp.expect_caught('X1',
  'alter table public.deals disable trigger record_deal_stage_transition_trigger',
  'select pg_temp.check_ledger_records()', '^L2:');

-- X2. With a browser grant on the ledger, the access check names it.
select pg_temp.expect_caught('X2',
  'grant select on public.deal_stage_transitions to authenticated',
  'select pg_temp.check_ledger_access()', '^L1:');

-- X3. An adapter that ignores the tenant hands the CRM to another tenant.
select pg_temp.expect_caught('X3',
  $x$alter function ops.crm_commercial_funnel(uuid, text, timestamptz) rename to crm_commercial_funnel_real;
     create function ops.crm_commercial_funnel(p_tenant_id uuid, p_zone text, p_as_of timestamptz) returns jsonb
     language sql stable set search_path = '' as $b$
       select ops.crm_commercial_funnel_real((select t.id from ops.tenants t where t.owns_local_crm), p_zone, p_as_of);
     $b$;$x$,
  'select pg_temp.check_tenancy()', '^T:');

-- X4. A title in the projection is caught by the minimisation check.
select pg_temp.expect_caught('X4', 'select 1',
  $x$select pg_temp.check_minimised(pg_temp.funnel('ta') || '{"title": "CF-SENTINEL title"}')$x$, '^N:');

-- X5. A stage configuration stored in another order is not re-sorted.
select pg_temp.expect_caught('X5',
  $x$update public.configuration set config = jsonb_set(config, '{dealStages}',
       (select jsonb_agg(e order by e ->> 'value') from jsonb_array_elements(config -> 'dealStages') e)) where id = 1$x$,
  'select pg_temp.check_funnel()', '^M:');

do $$ begin raise notice 'commercial funnel: every check held, every deliberate break was caught'; end $$;

rollback;
