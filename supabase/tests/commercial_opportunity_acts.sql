-- Phase 3B.2 — the four commercial acts, the follow-up bridge and the act log,
-- attacked in SQL (owner decision R).
--
-- The questions: can a tenant that does not own the local CRM change a deal;
-- does each act change exactly what it owns, against the CRM's STORED stage
-- configuration, and refuse a stale revision; is a repeat harmless; can the
-- acts ever leave a deal both converted and lost; does the bridge plan, move
-- and cancel only the follow-up plans it created, with the first occurrence
-- due exactly at the next action; does anything send, run or stop; and does
-- the act log hold only minimised facts?
--
--   F2  the write path, pinned: INVOKER, owner-only, an empty search path,
--       each function calling only its pinned callees, public.deals the one
--       CRM table written, nothing that sends, runs, stops or touches
--       lead_profiles; the three tables backend-only and append-only;
--   A   authority: another tenant, no tenant or actor, an id the browser was
--       never shown, a missing and an archived deal; CRM ownership moved;
--   M   move; N  next action (no bridge); B  the follow-up bridge;
--   C   convert; L  lose; O  outcomes never both; S  no send, run or stop;
--   G   the act log;
--   X   deliberate breaks, each caught by its own check.
--
-- The acts are called here as their gates call them, with the resolved
-- tenant and actor (the identity gates and the member path are
-- company_os_api.sql's; concurrency is engine/domain/
-- commercialOpportunityActs.dbtest.ts's). ONE TRANSACTION, ROLLED BACK: every
-- now() below is the same instant. Synthetic data only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

create temporary table ca_ids (name text primary key, id bigint, uid uuid) on commit drop;

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
  select id from ca_ids where name = p_name;
$$;
create function pg_temp.uid(p_name text) returns uuid language sql stable as $$
  select uid from ca_ids where name = p_name;
$$;

-- The principal every act below is made by.
create function pg_temp.actor() returns text language sql immutable as $$
  select 'principal:00000000-0000-4000-8000-0000000000c1'::text;
$$;

-- The CRM starts empty inside this transaction.
delete from public.deals;

-- Two tenants: A owns the local CRM, B does not. A has two companies, each
-- with a department, and one follow-up cadence (1 hour, 1 day, 2 days).
do $$
declare
  ta  uuid := gen_random_uuid();
  tb  uuid := gen_random_uuid();
  co  uuid;
  co2 uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (id, slug, name) values (ta, 'ca-' || left(ta::text, 8), 'CA synthetic A'),
                                                  (tb, 'ca-' || left(tb::text, 8), 'CA synthetic B');
  update ops.tenants set owns_local_crm = true where id = ta;
  perform ops.set_scheduling_timezone(ta, 'America/Sao_Paulo', 'ca-owner');
  co := ops.create_company(ta, 'ca-sales', 'CA Sales', 'ca-suite');
  co2 := ops.create_company(ta, 'ca-other', 'CA Other', 'ca-suite');
  insert into ca_ids (name, uid) values
    ('ta', ta), ('tb', tb), ('co', co), ('co2', co2),
    ('dep', ops.create_department(ta, co, 'ca-desk', 'CA Desk', 'ca-suite')),
    ('dep2', ops.create_department(ta, co2, 'ca-desk-2', 'CA Desk 2', 'ca-suite')),
    ('co_b', ops.create_company(tb, 'ca-b', 'CA B', 'ca-suite')),
    ('pol', (ops.define_follow_up_policy_version(ta, 'ca-cadence', 'CA cadence', array[60, 1440, 2880], 'ca-owner')
             ->> 'version_id')::uuid);
end
$$;

-- The CRM's stored configuration: five stages, two of them converted.
update public.configuration set config = jsonb_build_object(
  'currency', 'BRL',
  'dealStages', jsonb_build_array(
    jsonb_build_object('value', 'lead', 'label', 'Lead'),
    jsonb_build_object('value', 'contact', 'label', 'Contato'),
    jsonb_build_object('value', 'proposal', 'label', 'Proposta'),
    jsonb_build_object('value', 'won', 'label', 'Ganha'),
    jsonb_build_object('value', 'enrolled', 'label', 'Matriculada')),
  'dealPipelineStatuses', jsonb_build_array('won', 'enrolled'))
 where id = 1;

-- Loss reasons of this suite: two active, one retired.
insert into public.loss_reasons (code, label, active, sort_order) values
  ('ca_price', 'CA Preço', true, 1), ('ca_timing', 'CA Momento', true, 2), ('ca_retired', 'CA Antigo', false, 3);

-- A deal, entered into its stage five days ago.
create function pg_temp.deal(p_name text, p_stage text, p_next timestamptz = null) returns bigint
language plpgsql as $f$
declare
  v_id bigint;
begin
  insert into public.deals (name, stage, pipeline_stage, next_action_at, stage_entered_at, description)
  values ('CA-SENTINEL ' || p_name, p_stage, p_stage, p_next, now() - interval '5 days', 'CA-SENTINEL note')
  returning id into v_id;
  insert into ca_ids (name, id) values (p_name, v_id);
  return v_id;
end
$f$;

create function pg_temp.row(p_name text) returns public.deals language sql stable as $$
  select d.* from public.deals d where d.id = pg_temp.id(p_name);
$$;
create function pg_temp.rev(p_name text) returns text language sql stable as $$
  select ops.crm_deal_revision(d) from public.deals d where d.id = pg_temp.id(p_name);
$$;

-- The four acts, as their gates call them, for tenant A by default.
create function pg_temp.move(p_name text, p_stage text, p_rev text = null, p_tenant text = 'ta') returns jsonb
language sql volatile as $$
  select ops.move_opportunity_as_member(pg_temp.uid(p_tenant), pg_temp.actor(), pg_temp.id(p_name), p_stage,
                                        coalesce(p_rev, pg_temp.rev(p_name)));
$$;
create function pg_temp.next(p_name text, p_at timestamptz, p_rev text = null, p_tenant text = 'ta') returns jsonb
language sql volatile as $$
  select ops.set_opportunity_next_action_as_member(pg_temp.uid(p_tenant), pg_temp.actor(), pg_temp.id(p_name), p_at,
                                                   coalesce(p_rev, pg_temp.rev(p_name)));
$$;
create function pg_temp.conv(p_name text, p_stage text, p_rev text = null, p_tenant text = 'ta') returns jsonb
language sql volatile as $$
  select ops.convert_opportunity_as_member(pg_temp.uid(p_tenant), pg_temp.actor(), pg_temp.id(p_name), p_stage,
                                           coalesce(p_rev, pg_temp.rev(p_name)));
$$;
create function pg_temp.lose(p_name text, p_reason text, p_rev text = null, p_tenant text = 'ta') returns jsonb
language sql volatile as $$
  select ops.lose_opportunity_as_member(pg_temp.uid(p_tenant), pg_temp.actor(), pg_temp.id(p_name), p_reason,
                                        coalesce(p_rev, pg_temp.rev(p_name)));
$$;

-- The follow-up plans for a deal's opaque subject in tenant A, by status.
create function pg_temp.plans(p_name text, p_status text = 'active') returns bigint language sql stable as $$
  select count(*) from ops.follow_up_plans p
   where p.tenant_id = pg_temp.uid('ta') and p.subject_ref = 'deal:' || pg_temp.id(p_name) and p.status = p_status;
$$;
create function pg_temp.active_plan(p_name text) returns ops.follow_up_plans language sql stable as $$
  select p.* from ops.follow_up_plans p
   where p.tenant_id = pg_temp.uid('ta') and p.subject_ref = 'deal:' || pg_temp.id(p_name) and p.status = 'active';
$$;
create function pg_temp.ledger(p_name text) returns bigint language sql stable as $$
  select count(*) from public.deal_stage_transitions t where t.deal_id = pg_temp.id(p_name);
$$;
create function pg_temp.acts(p_name text) returns bigint language sql stable as $$
  select count(*) from ops.commercial_acts a where a.tenant_id = pg_temp.uid('ta') and a.deal_ref = pg_temp.id(p_name);
$$;

-- What no act may touch.
create function pg_temp.untouched() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'outbound', (select count(*) from ops.outbound_messages),
    'runs', (select count(*) from ops.agent_runs),
    'tasks', (select count(*) from ops.tasks),
    'stops', (select count(*) from ops.execution_stops),
    'reviews', (select count(*) from ops.review_items),
    'communication', (select count(*) from ops.events e where e.type like 'communication.%'),
    'other_jobs', (select count(*) from ops.jobs j where j.kind <> 'follow_up.due'),
    'lead_profiles', (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by l.id), '')) from public.lead_profiles l));
$$;

create temporary table ca_before (v jsonb) on commit drop;
insert into ca_before select pg_temp.untouched();

-- ===========================================================================
-- F2. The write path, pinned.
-- ===========================================================================

create temporary table ca_path (fn text primary key, callees text[] not null) on commit drop;
insert into ca_path values
  ('move_opportunity_as_member', '{crm_move_deal,cos_ts}'),
  ('set_opportunity_next_action_as_member',
   '{crm_set_deal_next_action,commercial_follow_up_cancel,commercial_follow_up_plan_next_action,cos_ts}'),
  ('convert_opportunity_as_member', '{crm_convert_deal,commercial_follow_up_cancel,cos_ts}'),
  ('lose_opportunity_as_member', '{crm_lose_deal,commercial_follow_up_cancel,cos_ts}'),
  ('crm_lock_deal', '{}'),
  ('crm_act_configuration', '{crm_stage_configuration}'),
  ('crm_move_deal', '{crm_text_ok,crm_revision_ok,crm_lock_deal,crm_act_configuration,crm_converted_codes,crm_deal_is_open,crm_stage_codes,crm_deal_revision}'),
  ('crm_set_deal_next_action', '{crm_revision_ok,crm_lock_deal,crm_deal_is_open,crm_converted_codes,crm_act_configuration,crm_deal_revision,cos_ts}'),
  ('crm_convert_deal', '{crm_text_ok,crm_revision_ok,crm_lock_deal,crm_converted_codes,crm_act_configuration,crm_deal_revision}'),
  ('crm_lose_deal', '{crm_text_ok,crm_revision_ok,crm_lock_deal,crm_converted_codes,crm_act_configuration,crm_loss_reason_ok,crm_deal_revision}'),
  ('commercial_follow_up_cancel', '{cancel_follow_up_plan}'),
  ('commercial_follow_up_plan_next_action', '{cos_commercial_follow_up_bridge,commercial_follow_up_cancel,schedule_follow_up_plan}'),
  ('cos_commercial_follow_up_bridge', '{}'),
  ('cos_commercial_acts_available', '{}'),
  ('configure_commercial_follow_up_bridge', '{require_scheduling_actor}');

-- A body's code only: comments removed and string literals emptied.
create function pg_temp.code(p_src text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(regexp_replace(lower(p_src), '--[^\n]*', ' ', 'g'), '''([^'']|'''')*''', '''''', 'g'),
                        'for\s+(no\s+key\s+)?(update|share)', ' ', 'g');
$$;

create function pg_temp.check_path() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  -- Each function: INVOKER, owned by postgres, executable by nobody else, an
  -- empty search path, and present.
  select string_agg(c.fn, ', ') into v_bad
    from ca_path c
    left join pg_proc p on p.pronamespace = 'ops'::regnamespace and p.proname = c.fn
   where p.oid is null or p.prosecdef or p.proowner <> 'postgres'::regrole
      or p.proacl is distinct from '{postgres=X/postgres}'::aclitem[]
      or p.proconfig is distinct from '{"search_path=\"\""}'::text[];
  if v_bad is not null then
    raise exception 'F2: a write-path function is missing, DEFINER, reachable or unpinned: %', v_bad;
  end if;
  -- Each calls only its pinned ops callees.
  select string_agg(distinct c.fn || ' calls ' || m[1], ', ') into v_bad
    from ca_path c
    join pg_proc p on p.pronamespace = 'ops'::regnamespace and p.proname = c.fn,
         lateral regexp_matches(pg_temp.code(p.prosrc), 'ops\."?([a-z_0-9]+)"?\s*\(', 'g') m
   where m[1] <> all (c.callees)
     and exists (select 1 from pg_proc x where x.pronamespace = 'ops'::regnamespace and x.proname = m[1]);
  if v_bad is not null then
    raise exception 'F2: a write-path function reaches beyond its pinned callees: %', v_bad;
  end if;
  -- Nothing on the path sends, runs a model, stops, clears, touches a lead
  -- profile, an email or a message, or runs dynamic SQL.
  select string_agg(c.fn, ', ') into v_bad
    from ca_path c join pg_proc p on p.pronamespace = 'ops'::regnamespace and p.proname = c.fn
   where pg_temp.code(p.prosrc) ~ '(outbound|send|whatsapp|agent_run|enqueue|execution_stop|\mtrip_|\mclear_|lead_profiles|email|(^|[\s;])execute\s)';
  if v_bad is not null then
    raise exception 'F2: a write-path function names a send, a run, a stop, a lead profile or dynamic SQL: %', v_bad;
  end if;
  -- Schema public: only the CRM adapter names it, and only these tables;
  -- public.deals is the one it writes, by UPDATE, in the four act adapters.
  select string_agg(distinct c.fn || ':' || m[1], ', ') into v_bad
    from ca_path c join pg_proc p on p.pronamespace = 'ops'::regnamespace and p.proname = c.fn,
         lateral regexp_matches(pg_temp.code(p.prosrc), 'public\.([a-z_]+)', 'g') m
   where c.fn !~ '^crm_' or m[1] not in ('deals', 'loss_reasons');
  if v_bad is not null then
    raise exception 'F2: schema public is named outside the CRM adapter or beyond its tables: %', v_bad;
  end if;
  select string_agg(c.fn, ', ') into v_bad
    from ca_path c join pg_proc p on p.pronamespace = 'ops'::regnamespace and p.proname = c.fn
   where (pg_temp.code(p.prosrc) ~ '\m(update|insert|delete|truncate|merge)\M')
         <> (c.fn in ('crm_move_deal', 'crm_set_deal_next_action', 'crm_convert_deal', 'crm_lose_deal',
                      'move_opportunity_as_member', 'set_opportunity_next_action_as_member',
                      'convert_opportunity_as_member', 'lose_opportunity_as_member',
                      'commercial_follow_up_plan_next_action', 'configure_commercial_follow_up_bridge'))
      or (c.fn ~ '^crm_' and pg_temp.code(p.prosrc) ~ '\m(insert|delete|truncate|merge)\M')
      or (c.fn ~ '^crm_' and pg_temp.code(p.prosrc) ~ '\mupdate\M'
          and pg_temp.code(p.prosrc) !~ 'update\s+public\.deals\s+set\s')
      or (c.fn ~ '_as_member$' and pg_temp.code(p.prosrc) ~ '\m(update|delete|truncate|merge)\M')
      or (c.fn ~ '_as_member$' and pg_temp.code(p.prosrc) ~ 'insert into ops\.(?!commercial_acts\M)');
  if v_bad is not null then
    raise exception 'F2: a write-path function writes beyond its own table: %', v_bad;
  end if;
end
$f$;

create function pg_temp.check_tables() returns void
language plpgsql as $f$
declare
  v_bad text;
begin
  select string_agg(r.rolname || ':' || c.relname, ', ') into v_bad
    from pg_class c cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                                       ('ops_operator_api')) as r (rolname)
   where c.relnamespace = 'ops'::regnamespace
     and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')
     and has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'G: a role holds a privilege on a commercial table: %', v_bad;
  end if;
  if exists (select 1 from pg_class c where c.relnamespace = 'ops'::regnamespace
              and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')
              and not (c.relrowsecurity and c.relforcerowsecurity))
     or exists (select 1 from pg_policy p join pg_class c on c.oid = p.polrelid
                 where c.relnamespace = 'ops'::regnamespace
                   and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')) then
    raise exception 'G: a commercial table is not RLS-forced with no policy';
  end if;
  if (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'ops'::regnamespace and not t.tgisinternal and t.tgenabled = 'A'
         and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')) <> 8 then
    raise exception 'G: a commercial table guard is missing or not ENABLE ALWAYS';
  end if;
end
$f$;

select pg_temp.check_path();
select pg_temp.check_tables();

-- ===========================================================================
-- A. Authority.
-- ===========================================================================

select pg_temp.deal('a1', 'lead');
select pg_temp.deal('a_archived', 'lead');
update public.deals set archived_at = now() where id = pg_temp.id('a_archived');

create function pg_temp.check_authority() returns void
language plpgsql as $f$
declare
  c record;
begin
  -- Another tenant is refused before anything of the CRM is read, whatever
  -- the id: a real deal and a missing one answer the same.
  for c in select * from (values
      ('move', format('select pg_temp.move(''a1'', ''contact'', null, ''tb'')')),
      ('next', format('select pg_temp.next(''a1'', now() + interval ''1 day'', null, ''tb'')')),
      ('convert', format('select pg_temp.conv(''a1'', ''won'', null, ''tb'')')),
      ('lose', format('select pg_temp.lose(''a1'', ''ca_price'', null, ''tb'')')),
      ('move a missing deal', format('select ops.move_opportunity_as_member(%L, %L, 9007199254740990, ''contact'', %L)',
                                     pg_temp.uid('tb'), pg_temp.actor(), 'r1.' || repeat('0', 32)))) as x (label, sql) loop
    perform pg_temp.expect_refused('A tenant B ' || c.label, 'OS403', c.sql);
  end loop;
  if (pg_temp.row('a1')).pipeline_stage <> 'lead' or (pg_temp.row('a1')).next_action_at is not null then
    raise exception 'A: tenant B changed tenant A''s CRM';
  end if;
end
$f$;

select pg_temp.check_authority();

do $$
declare
  v_zero text := 'r1.' || repeat('0', 32);
begin
  perform pg_temp.expect_refused('A no tenant', 'OS401',
    format('select ops.move_opportunity_as_member(null, %L, %s, ''contact'', %L)', pg_temp.actor(), pg_temp.id('a1'), v_zero));
  perform pg_temp.expect_refused('A no actor', 'OS401',
    format('select ops.lose_opportunity_as_member(%L, null, %s, ''ca_price'', %L)', pg_temp.uid('ta'), pg_temp.id('a1'), v_zero));
  -- Ids no browser was shown, and a missing one: the same OS404.
  perform pg_temp.expect_refused('A id 0', 'OS404',
    format('select ops.move_opportunity_as_member(%L, %L, 0, ''contact'', %L)', pg_temp.uid('ta'), pg_temp.actor(), v_zero));
  perform pg_temp.expect_refused('A negative id', 'OS404',
    format('select ops.convert_opportunity_as_member(%L, %L, -5, ''won'', %L)', pg_temp.uid('ta'), pg_temp.actor(), v_zero));
  perform pg_temp.expect_refused('A id past 2^53', 'OS404',
    format('select ops.set_opportunity_next_action_as_member(%L, %L, 9007199254740992, null, %L)', pg_temp.uid('ta'), pg_temp.actor(), v_zero));
  perform pg_temp.expect_refused('A missing id', 'OS404',
    format('select ops.lose_opportunity_as_member(%L, %L, 9007199254740990, ''ca_price'', %L)', pg_temp.uid('ta'), pg_temp.actor(), v_zero));
  -- An archived deal is closed to every act.
  perform pg_temp.expect_refused('A archived move', 'OS409', 'select pg_temp.move(''a_archived'', ''contact'')');
  perform pg_temp.expect_refused('A archived next', 'OS409', 'select pg_temp.next(''a_archived'', now() + interval ''1 day'')');
  perform pg_temp.expect_refused('A archived convert', 'OS409', 'select pg_temp.conv(''a_archived'', ''won'')');
  perform pg_temp.expect_refused('A archived lose', 'OS409', 'select pg_temp.lose(''a_archived'', ''ca_price'')');
  -- CRM ownership moved: tenant A is refused on the next call, B still too
  -- (at most one tenant owns the local CRM, and here it is B's turn).
  begin
    update ops.tenants set owns_local_crm = false where id = pg_temp.uid('ta');
    update ops.tenants set owns_local_crm = true where id = pg_temp.uid('tb');
    perform pg_temp.expect_refused('A ownership moved away', 'OS403', 'select pg_temp.move(''a1'', ''contact'')');
    if ops.cos_commercial_acts_available(pg_temp.uid('ta')) or not ops.cos_commercial_acts_available(pg_temp.uid('tb')) then
      raise exception 'A: the operator context hint does not follow CRM ownership';
    end if;
    raise exception using errcode = 'P0002', message = 'ca-undo-ownership';
  exception when sqlstate 'P0002' then null;
  end;
  if not ops.cos_commercial_acts_available(pg_temp.uid('ta')) then
    raise exception 'A: CRM ownership did not come back to tenant A';
  end if;
  -- No application or capability role executes any of the path.
  if exists (select 1 from ca_path c join pg_proc p on p.pronamespace = 'ops'::regnamespace and p.proname = c.fn
              cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                                 ('ops_operator_api')) as r (rolname)
              where has_function_privilege(r.rolname, p.oid, 'EXECUTE')) then
    raise exception 'A: a role can execute the commercial write path directly';
  end if;
end
$$;

-- ===========================================================================
-- M. Move.
-- ===========================================================================

select pg_temp.deal('m1', 'lead');
select pg_temp.deal('m_legacy', 'CA-legacy');
select pg_temp.deal('m_lost', 'contact');
update public.deals set lost_at = now(), loss_reason_id = (select id from public.loss_reasons where code = 'ca_price')
 where id = pg_temp.id('m_lost');
select pg_temp.deal('m_converted', 'contact');
update public.deals set converted_at = now() where id = pg_temp.id('m_converted');
select pg_temp.deal('m_won', 'won');

create function pg_temp.check_stale_move() returns void
language plpgsql as $f$
declare
  v_id  bigint := pg_temp.deal('m_stale_' || gen_random_uuid(), 'lead');
  v_old text := (select ops.crm_deal_revision(d) from public.deals d where d.id = v_id);
begin
  perform ops.move_opportunity_as_member(pg_temp.uid('ta'), pg_temp.actor(), v_id, 'contact', v_old);
  perform pg_temp.expect_refused('M stale revision', 'OS409',
    format('select ops.move_opportunity_as_member(%L, %L, %s, ''proposal'', %L)', pg_temp.uid('ta'), pg_temp.actor(),
           v_id, v_old));
end
$f$;

do $$
declare
  v_rev    text := pg_temp.rev('m1');
  v_ledger bigint := pg_temp.ledger('m1');
  v        jsonb;
  d        public.deals;
begin
  v := pg_temp.move('m1', 'contact');
  d := pg_temp.row('m1');
  if v - 'asOf' is distinct from jsonb_build_object('v', 1, 'dealRef', d.id, 'outcome', 'moved',
                                                    'revision', ops.crm_deal_revision(d), 'stage', 'contact')
     or d.pipeline_stage <> 'contact' or d.stage <> 'contact' or d.stage_entered_at <> now()
     or ops.crm_deal_revision(d) = v_rev then
    raise exception 'M: a move answered % and left %', v, to_jsonb(d) - 'name' - 'description';
  end if;
  -- The ledger observed exactly this change; the act log recorded it.
  if pg_temp.ledger('m1') <> v_ledger + 1
     or not exists (select 1 from public.deal_stage_transitions t where t.deal_id = d.id and t.from_stage = 'lead'
                      and t.to_stage = 'contact')
     or (select count(*) from ops.commercial_acts a where a.deal_ref = d.id and a.act = 'moved'
          and a.facts = '{"toStage": "contact"}' and a.actor = pg_temp.actor() and a.recorded_at = now()) <> 1 then
    raise exception 'M: the move was not observed once by the ledger and recorded once by the act log';
  end if;
  -- The same stage again: unchanged, and nothing recorded, whatever the revision.
  v := pg_temp.move('m1', 'contact', v_rev);
  if v ->> 'outcome' <> 'unchanged' or v ->> 'revision' <> pg_temp.rev('m1')
     or pg_temp.ledger('m1') <> v_ledger + 1 or pg_temp.acts('m1') <> 1 then
    raise exception 'M: a repeated move changed something: %', v;
  end if;
  -- Refused: an unknown stage, a converted one (converting is its own act),
  -- a closed deal, a malformed stage or revision.
  perform pg_temp.expect_refused('M unknown stage', 'OS409', 'select pg_temp.move(''m1'', ''nowhere'')');
  perform pg_temp.expect_refused('M a converted stage', 'OS409', 'select pg_temp.move(''m1'', ''won'')');
  perform pg_temp.expect_refused('M lost deal', 'OS409', 'select pg_temp.move(''m_lost'', ''proposal'')');
  perform pg_temp.expect_refused('M converted deal', 'OS409', 'select pg_temp.move(''m_converted'', ''proposal'')');
  perform pg_temp.expect_refused('M deal in a converted stage', 'OS409', 'select pg_temp.move(''m_won'', ''proposal'')');
  perform pg_temp.expect_refused('M blank stage', 'OS400', 'select pg_temp.move(''m1'', '' '')');
  perform pg_temp.expect_refused('M no stage', 'OS400', 'select pg_temp.move(''m1'', null)');
  perform pg_temp.expect_refused('M malformed revision', 'OS400', 'select pg_temp.move(''m1'', ''proposal'', ''r1.XYZ'')');
  -- A deal in a stage the configuration does not list may move into one.
  v := pg_temp.move('m_legacy', 'lead');
  if v ->> 'outcome' <> 'moved' or (pg_temp.row('m_legacy')).pipeline_stage <> 'lead' then
    raise exception 'M: a deal in an unconfigured stage could not move into a configured one';
  end if;
  -- Missing or malformed configuration closes every act; no default is read.
  begin
    update public.configuration set config = '{}' where id = 1;
    perform pg_temp.expect_refused('M configuration missing', 'OS409', 'select pg_temp.move(''m1'', ''proposal'')');
    perform pg_temp.expect_refused('M configuration missing (next)', 'OS409', 'select pg_temp.next(''m1'', now() + interval ''1 day'')');
    update public.configuration set config = '{"dealStages": "lead", "dealPipelineStatuses": []}' where id = 1;
    perform pg_temp.expect_refused('M configuration malformed', 'OS409', 'select pg_temp.move(''m1'', ''proposal'')');
    raise exception using errcode = 'P0002', message = 'ca-undo-config';
  exception when sqlstate 'P0002' then null;
  end;
end
$$;

select pg_temp.check_stale_move();

-- ===========================================================================
-- N. Next action, with no bridge configured.
-- ===========================================================================

select pg_temp.deal('n1', 'contact');

do $$
declare
  -- 09:30 on the day after tomorrow, on the tenant's own wall clock.
  v_at  timestamptz := (((now() at time zone 'America/Sao_Paulo')::date + 2) + time '09:30') at time zone 'America/Sao_Paulo';
  v_rev text;
  v     jsonb;
begin
  v := pg_temp.next('n1', v_at);
  if v - 'asOf' - 'revision' is distinct from jsonb_build_object(
       'v', 1, 'dealRef', pg_temp.id('n1'), 'outcome', 'set', 'nextActionAt', ops.cos_ts(v_at),
       'followUp', '{"status": "not_configured", "reason": null}'::jsonb)
     or (pg_temp.row('n1')).next_action_at <> v_at
     or to_char((pg_temp.row('n1')).next_action_at at time zone 'America/Sao_Paulo', 'HH24:MI') <> '09:30' then
    raise exception 'N: a next action answered % and stored %', v, (pg_temp.row('n1')).next_action_at;
  end if;
  -- Exactly the instant, with its zone round trip; the stage is untouched.
  if (pg_temp.row('n1')).pipeline_stage <> 'contact' or (pg_temp.row('n1')).stage_entered_at <> now() - interval '5 days' then
    raise exception 'N: setting a next action touched the stage';
  end if;
  -- No bridge: no plan for the deal.
  if pg_temp.plans('n1') + pg_temp.plans('n1', 'superseded') + pg_temp.plans('n1', 'cancelled') <> 0 then
    raise exception 'N: a follow-up was planned with no bridge configured';
  end if;
  -- The same instant again: unchanged, nothing recorded.
  v_rev := pg_temp.rev('n1');
  if pg_temp.next('n1', v_at) ->> 'outcome' <> 'unchanged' or pg_temp.rev('n1') <> v_rev or pg_temp.acts('n1') <> 1 then
    raise exception 'N: a repeated next action changed something';
  end if;
  -- Refused: an infinity, an instant out of range, a stale revision.
  perform pg_temp.expect_refused('N infinity', 'OS400', 'select pg_temp.next(''n1'', ''infinity'')');
  perform pg_temp.expect_refused('N minus infinity', 'OS400', 'select pg_temp.next(''n1'', ''-infinity'')');
  perform pg_temp.expect_refused('N too far ahead', 'OS400', 'select pg_temp.next(''n1'', now() + interval ''367 days'')');
  perform pg_temp.expect_refused('N too far back', 'OS400', 'select pg_temp.next(''n1'', now() - interval ''31 days'')');
  perform pg_temp.expect_refused('N stale revision', 'OS409',
    format('select pg_temp.next(''n1'', now() + interval ''4 days'', %L)', 'r1.' || repeat('a', 32)));
  -- Cleared.
  v := pg_temp.next('n1', null);
  if v ->> 'outcome' <> 'cleared' or v -> 'nextActionAt' <> 'null'::jsonb or (pg_temp.row('n1')).next_action_at is not null
     or v -> 'followUp' <> '{"status": "none", "reason": null}'::jsonb
     or (select a.facts from ops.commercial_acts a where a.deal_ref = pg_temp.id('n1') and a.act = 'next_action_cleared')
        <> '{"followUp": "none"}'::jsonb then
    raise exception 'N: clearing answered %', v;
  end if;
  perform pg_temp.expect_refused('N closed deal', 'OS409', 'select pg_temp.next(''m_lost'', now() + interval ''1 day'')');
end
$$;

-- ===========================================================================
-- B. The follow-up bridge.
-- ===========================================================================

-- A plan someone else created: for another deal's subject in the bridge's
-- company, and one for deal b_manual's own subject.
select pg_temp.deal('b_other', 'lead');
select pg_temp.deal('b_manual', 'lead');
do $$
begin
  perform ops.schedule_follow_up_plan(pg_temp.uid('ta'), pg_temp.uid('co'), pg_temp.uid('dep'), null, 'ca-cadence',
    now() + interval '1 day', null, null, 'deal:' || pg_temp.id('b_other'), 'ca-manual-other', 'ca-owner', 'ca-suite');
  perform ops.schedule_follow_up_plan(pg_temp.uid('ta'), pg_temp.uid('co'), pg_temp.uid('dep'), null, 'ca-cadence',
    now() + interval '1 day', null, null, 'deal:' || pg_temp.id('b_manual'), 'ca-manual-own', 'ca-owner', 'ca-suite');
end
$$;

-- The bridge never touches a plan it did not create.
create function pg_temp.check_unrelated() returns void
language plpgsql as $f$
begin
  if ops.commercial_follow_up_cancel(pg_temp.uid('ta'), pg_temp.actor(), pg_temp.id('b_manual'), 'ca_probe', null) <> 0
     or pg_temp.plans('b_manual') <> 1 or pg_temp.plans('b_other') <> 1 then
    raise exception 'B: the bridge cancelled a follow-up plan it did not create';
  end if;
end
$f$;

select pg_temp.check_unrelated();

do $$
declare
  v_at  timestamptz := date_trunc('minute', now()) + interval '2 days';
  v_at2 timestamptz := date_trunc('minute', now()) + interval '3 days 2 hours';
  v     jsonb;
  p     ops.follow_up_plans;
  p2    ops.follow_up_plans;
  v_due text;
begin
  -- Configuring: refused while incomplete, for an inactive or foreign unit, or
  -- for a policy version that is not its policy's latest.
  perform pg_temp.expect_refused('B incomplete', 'OS400',
    format('select ops.configure_commercial_follow_up_bridge(%L, true, %L, null, null, %L, ''ca-owner'')',
           pg_temp.uid('ta'), pg_temp.uid('co'), pg_temp.uid('pol')));
  perform pg_temp.expect_refused('B disabled naming a unit', 'OS400',
    format('select ops.configure_commercial_follow_up_bridge(%L, false, %L, null, null, null, ''ca-owner'')',
           pg_temp.uid('ta'), pg_temp.uid('co')));
  perform pg_temp.expect_refused('B another tenant''s company', 'OS409',
    format('select ops.configure_commercial_follow_up_bridge(%L, true, %L, %L, null, %L, ''ca-owner'')',
           pg_temp.uid('ta'), pg_temp.uid('co_b'), pg_temp.uid('dep'), pg_temp.uid('pol')));
  perform pg_temp.expect_refused('B no actor', 'OS400',
    format('select ops.configure_commercial_follow_up_bridge(%L, true, %L, %L, null, %L, '' '')',
           pg_temp.uid('ta'), pg_temp.uid('co'), pg_temp.uid('dep'), pg_temp.uid('pol')));
  if ops.cos_commercial_funnel(pg_temp.uid('ta'), now()) ->> 'followUpBridge' <> 'not_configured' then
    raise exception 'B: an unconfigured bridge was reported otherwise';
  end if;

  v := ops.configure_commercial_follow_up_bridge(pg_temp.uid('ta'), true, pg_temp.uid('co'), pg_temp.uid('dep'), null,
                                                 pg_temp.uid('pol'), 'ca-owner');
  if not (v ->> 'created')::boolean or (v ->> 'version')::int <> 1
     or (ops.configure_commercial_follow_up_bridge(pg_temp.uid('ta'), true, pg_temp.uid('co'), pg_temp.uid('dep'), null,
                                                   pg_temp.uid('pol'), 'ca-owner') ->> 'created')::boolean then
    raise exception 'B: configuring answered %, or a repeat recorded a new version', v;
  end if;
  if ops.cos_commercial_funnel(pg_temp.uid('ta'), now()) ->> 'followUpBridge' <> 'configured' then
    raise exception 'B: a configured bridge was not reported';
  end if;

  -- Setting a next action plans the cadence so step 1 is due exactly then;
  -- the other steps keep their relative cadence (a day and two days after the
  -- anchor, the anchor being an hour before the next action).
  perform pg_temp.deal('b1', 'contact');
  v := pg_temp.next('b1', v_at);
  p := pg_temp.active_plan('b1');
  select string_agg(format('%s@%s', f.step_number, extract(epoch from f.due_at - v_at)::bigint / 60), ' ' order by f.step_number)
    into v_due from ops.follow_ups f where f.plan_id = p.id;
  if v -> 'followUp' <> '{"status": "scheduled", "reason": null}'::jsonb or p.id is null
     or p.company_id <> pg_temp.uid('co') or p.department_id <> pg_temp.uid('dep') or p.agent_id is not null
     or p.policy_version_id <> pg_temp.uid('pol') or p.anchor_at <> v_at - interval '60 minutes'
     or p.created_by <> pg_temp.actor() or v_due <> '1@0 2@1380 3@2820'
     or not exists (select 1 from ops.commercial_follow_up_plans c where c.plan_id = p.id and c.deal_ref = pg_temp.id('b1'))
     or exists (select 1 from ops.follow_ups f join ops.jobs j on j.tenant_id = f.tenant_id and j.id = f.job_id
                 where f.plan_id = p.id and (j.kind <> 'follow_up.due' or j.available_at <> f.due_at)) then
    raise exception 'B: the planned cadence is wrong: % plan % steps %', v, to_jsonb(p), v_due;
  end if;

  -- Changing it supersedes that plan (its scheduled steps become superseded,
  -- history kept) and plans again; one active plan, two bridge plans.
  v := pg_temp.next('b1', v_at2);
  p2 := pg_temp.active_plan('b1');
  if v -> 'followUp' ->> 'status' <> 'scheduled' or p2.id = p.id or p2.anchor_at <> v_at2 - interval '60 minutes'
     or (select status from ops.follow_up_plans where id = p.id) <> 'superseded'
     or (select superseded_by_plan_id from ops.follow_up_plans where id = p.id) <> p2.id
     or exists (select 1 from ops.follow_ups f where f.plan_id = p.id and f.status <> 'superseded')
     or pg_temp.plans('b1') <> 1
     or (select count(*) from ops.commercial_follow_up_plans c where c.deal_ref = pg_temp.id('b1')) <> 2 then
    raise exception 'B: changing the next action did not supersede the bridge plan: %', v;
  end if;
  -- The same instant again: nothing new.
  if pg_temp.next('b1', v_at2) -> 'followUp' <> '{"status": "unchanged", "reason": null}'::jsonb
     or (select count(*) from ops.commercial_follow_up_plans c where c.deal_ref = pg_temp.id('b1')) <> 2 then
    raise exception 'B: a repeated next action planned again';
  end if;
  -- Clearing it cancels the bridge plan, every open step with its reason.
  v := pg_temp.next('b1', null);
  if v -> 'followUp' <> '{"status": "cancelled", "reason": null}'::jsonb or pg_temp.plans('b1') <> 0
     or (select status from ops.follow_up_plans where id = p2.id) <> 'cancelled'
     or exists (select 1 from ops.follow_ups f where f.plan_id = p2.id
                 and (f.status <> 'cancelled' or f.close_reason <> 'commercial_next_action_cleared')) then
    raise exception 'B: clearing did not cancel the bridge plan: %', v;
  end if;

  -- A deal whose subject already has a plan someone else created: the next
  -- action is set, no plan is superseded or created, and it is said.
  v := pg_temp.next('b_manual', v_at);
  if v -> 'followUp' <> '{"status": "not_scheduled", "reason": "existing_plan"}'::jsonb
     or (pg_temp.row('b_manual')).next_action_at <> v_at or pg_temp.plans('b_manual') <> 1
     or exists (select 1 from ops.commercial_follow_up_plans c where c.deal_ref = pg_temp.id('b_manual')) then
    raise exception 'B: a plan someone else created was superseded, or the answer hid it: %', v;
  end if;

  -- An anchor the Phase 3A service would refuse: the act stands, nothing is
  -- planned, and it is said.
  perform pg_temp.deal('b_window', 'contact');
  v := pg_temp.next('b_window', now() - interval '30 days' + interval '30 minutes');
  if v -> 'followUp' <> '{"status": "not_scheduled", "reason": "outside_window"}'::jsonb
     or pg_temp.plans('b_window') <> 0 or (pg_temp.row('b_window')).next_action_at is null then
    raise exception 'B: an anchor outside the window answered %', v;
  end if;

  -- A newer version of the pinned policy makes the bridge invalid: the next
  -- action stands, the deal's bridge plan is cancelled, nothing new is planned.
  perform pg_temp.deal('b_invalid', 'contact');
  perform pg_temp.next('b_invalid', v_at);
  p := pg_temp.active_plan('b_invalid');
  perform ops.define_follow_up_policy_version(pg_temp.uid('ta'), 'ca-cadence', 'CA cadence', array[30, 1440], 'ca-owner');
  if ops.cos_commercial_funnel(pg_temp.uid('ta'), now()) ->> 'followUpBridge' <> 'invalid' then
    raise exception 'B: a bridge pinned to an old policy version was not reported invalid';
  end if;
  v := pg_temp.next('b_invalid', v_at2);
  if v -> 'followUp' <> '{"status": "not_scheduled", "reason": "configuration_invalid"}'::jsonb
     or (select status from ops.follow_up_plans where id = p.id) <> 'cancelled'
     or exists (select 1 from ops.follow_ups f where f.plan_id = p.id and f.close_reason <> 'commercial_next_action_changed')
     or pg_temp.plans('b_invalid') <> 0 then
    raise exception 'B: an invalid bridge answered %', v;
  end if;
  perform pg_temp.expect_refused('B pinning an old version', 'OS409',
    format('select ops.configure_commercial_follow_up_bridge(%L, true, %L, %L, null, %L, ''ca-owner'')',
           pg_temp.uid('ta'), pg_temp.uid('co'), pg_temp.uid('dep'), pg_temp.uid('pol')));

  -- Re-pinned to the latest version, in the other company: the next plan
  -- lives there, and a bridge plan left in the first company is cancelled.
  update ca_ids set uid = (select v2.id from ops.follow_up_policy_versions v2
                            join ops.follow_up_policies pp on pp.id = v2.policy_id
                           where pp.tenant_id = pg_temp.uid('ta') and pp.key = 'ca-cadence' and v2.version = 2)
   where name = 'pol';
  perform ops.configure_commercial_follow_up_bridge(pg_temp.uid('ta'), true, pg_temp.uid('co'), pg_temp.uid('dep'), null,
                                                    pg_temp.uid('pol'), 'ca-owner');
  perform pg_temp.deal('b_moved', 'contact');
  perform pg_temp.next('b_moved', v_at);
  p := pg_temp.active_plan('b_moved');
  perform ops.configure_commercial_follow_up_bridge(pg_temp.uid('ta'), true, pg_temp.uid('co2'), pg_temp.uid('dep2'), null,
                                                    pg_temp.uid('pol'), 'ca-owner');
  v := pg_temp.next('b_moved', v_at2);
  p2 := pg_temp.active_plan('b_moved');
  if v -> 'followUp' ->> 'status' <> 'scheduled' or p2.company_id <> pg_temp.uid('co2')
     or p2.anchor_at <> v_at2 - interval '30 minutes'
     or (select status from ops.follow_up_plans where id = p.id) <> 'cancelled'
     or exists (select 1 from ops.follow_ups f where f.plan_id = p.id and f.close_reason <> 'commercial_bridge_reassigned') then
    raise exception 'B: a reassigned bridge answered % (old %, new %)', v, to_jsonb(p), to_jsonb(p2);
  end if;

  -- Disabled: setting a next action cancels the deal's bridge plan and plans
  -- nothing.
  perform ops.configure_commercial_follow_up_bridge(pg_temp.uid('ta'), false, null, null, null, null, 'ca-owner');
  v := pg_temp.next('b_moved', v_at);
  if v -> 'followUp' <> '{"status": "not_configured", "reason": null}'::jsonb or pg_temp.plans('b_moved') <> 0
     or (select status from ops.follow_up_plans where id = p2.id) <> 'cancelled' then
    raise exception 'B: a disabled bridge answered %', v;
  end if;
  if (select count(*) from ops.commercial_follow_up_bridges b where b.tenant_id = pg_temp.uid('ta')) <> 4
     or exists (select 1 from ops.commercial_follow_up_bridges b where b.tenant_id = pg_temp.uid('ta')
                 and b.created_at <> now()) then
    raise exception 'B: the bridge versions are not exactly the four recorded changes';
  end if;
  -- Enabled again for the conversion and loss cases below.
  perform ops.configure_commercial_follow_up_bridge(pg_temp.uid('ta'), true, pg_temp.uid('co'), pg_temp.uid('dep'), null,
                                                    pg_temp.uid('pol'), 'ca-owner');
end
$$;

select pg_temp.check_unrelated();

-- ===========================================================================
-- C. Convert.
-- ===========================================================================

select pg_temp.deal('c1', 'proposal');
select pg_temp.deal('c_undated', 'won');
select pg_temp.deal('c_lost', 'proposal');
update public.deals set lost_at = now(), loss_reason_id = (select id from public.loss_reasons where code = 'ca_price')
 where id = pg_temp.id('c_lost');

do $$
declare
  v_rev    text;
  v_ledger bigint;
  v        jsonb;
  d        public.deals;
  p        ops.follow_up_plans;
begin
  perform pg_temp.next('c1', date_trunc('minute', now()) + interval '2 days');
  p := pg_temp.active_plan('c1');
  if p.id is null then
    raise exception 'C: the conversion case has no bridge plan to cancel';
  end if;
  -- Refused: a normal or unknown target, a stale revision.
  perform pg_temp.expect_refused('C normal stage', 'OS409', 'select pg_temp.conv(''c1'', ''contact'')');
  perform pg_temp.expect_refused('C unknown stage', 'OS409', 'select pg_temp.conv(''c1'', ''nowhere'')');
  perform pg_temp.expect_refused('C stale revision', 'OS409',
    format('select pg_temp.conv(''c1'', ''won'', %L)', 'r1.' || repeat('b', 32)));
  perform pg_temp.expect_refused('C blank stage', 'OS400', 'select pg_temp.conv(''c1'', '''')');
  begin
    update public.configuration set config = jsonb_set(config, '{dealPipelineStatuses}', '[]') where id = 1;
    perform pg_temp.expect_refused('C no converted stage configured', 'OS409', 'select pg_temp.conv(''c1'', ''won'')');
    raise exception using errcode = 'P0002', message = 'ca-undo-converted';
  exception when sqlstate 'P0002' then null;
  end;

  v_rev := pg_temp.rev('c1');
  v_ledger := pg_temp.ledger('c1');
  v := pg_temp.conv('c1', 'won');
  d := pg_temp.row('c1');
  if v - 'asOf' is distinct from jsonb_build_object('v', 1, 'dealRef', d.id, 'outcome', 'converted',
       'revision', ops.crm_deal_revision(d), 'stage', 'won', 'followUp', '{"status": "cancelled", "reason": null}'::jsonb)
     or d.pipeline_stage <> 'won' or d.converted_at <> now() or d.next_action_at is not null or d.lost_at is not null then
    raise exception 'C: converting answered % and left %', v, to_jsonb(d) - 'name' - 'description';
  end if;
  if pg_temp.ledger('c1') <> v_ledger + 1 or pg_temp.plans('c1') <> 0
     or exists (select 1 from ops.follow_ups f where f.plan_id = p.id
                 and (f.status <> 'cancelled' or f.close_reason <> 'opportunity_converted'))
     or (select a.facts from ops.commercial_acts a where a.deal_ref = d.id and a.act = 'converted')
        <> '{"stage": "won", "followUp": "cancelled"}'::jsonb then
    raise exception 'C: the conversion was not observed once, or its follow-up not cancelled';
  end if;
  -- A repeat with the revision the browser saw before: unchanged. Another
  -- converted stage: refused, never a second outcome.
  v := pg_temp.conv('c1', 'won', v_rev);
  if v ->> 'outcome' <> 'unchanged' or pg_temp.ledger('c1') <> v_ledger + 1 or (pg_temp.row('c1')).converted_at <> now() then
    raise exception 'C: a repeated conversion changed something: %', v;
  end if;
  perform pg_temp.expect_refused('C another converted stage', 'OS409', format('select pg_temp.conv(''c1'', ''enrolled'', %L)', v_rev));
  perform pg_temp.expect_refused('C lost deal', 'OS409', 'select pg_temp.conv(''c_lost'', ''won'')');
  -- A deal already in a converted stage but undated: dated, stage unchanged,
  -- so the ledger observes nothing; and the second converted stage works.
  v_ledger := pg_temp.ledger('c_undated');
  v := pg_temp.conv('c_undated', 'won');
  if v ->> 'outcome' <> 'converted' or (pg_temp.row('c_undated')).converted_at <> now()
     or pg_temp.ledger('c_undated') <> v_ledger then
    raise exception 'C: an undated conversion was not dated in place';
  end if;
  perform pg_temp.deal('c2', 'contact');
  if pg_temp.conv('c2', 'enrolled') ->> 'stage' <> 'enrolled' then
    raise exception 'C: the second converted stage was not accepted when chosen';
  end if;
end
$$;

-- ===========================================================================
-- L. Lose.
-- ===========================================================================

select pg_temp.deal('l1', 'proposal');

do $$
declare
  v_rev    text;
  v_ledger bigint;
  v        jsonb;
  d        public.deals;
  p        ops.follow_up_plans;
begin
  perform pg_temp.next('l1', date_trunc('minute', now()) + interval '2 days');
  p := pg_temp.active_plan('l1');
  perform pg_temp.expect_refused('L no reason', 'OS400', 'select pg_temp.lose(''l1'', null)');
  perform pg_temp.expect_refused('L unknown reason', 'OS409', 'select pg_temp.lose(''l1'', ''ca_nothing'')');
  perform pg_temp.expect_refused('L retired reason', 'OS409', 'select pg_temp.lose(''l1'', ''ca_retired'')');
  perform pg_temp.expect_refused('L stale revision', 'OS409',
    format('select pg_temp.lose(''l1'', ''ca_price'', %L)', 'r1.' || repeat('c', 32)));
  perform pg_temp.expect_refused('L converted deal', 'OS409', 'select pg_temp.lose(''c1'', ''ca_price'')');
  perform pg_temp.expect_refused('L deal in a converted stage', 'OS409', 'select pg_temp.lose(''m_won'', ''ca_price'')');

  v_rev := pg_temp.rev('l1');
  v_ledger := pg_temp.ledger('l1');
  v := pg_temp.lose('l1', 'ca_price');
  d := pg_temp.row('l1');
  if v - 'asOf' is distinct from jsonb_build_object('v', 1, 'dealRef', d.id, 'outcome', 'lost',
       'revision', ops.crm_deal_revision(d), 'followUp', '{"status": "cancelled", "reason": null}'::jsonb)
     or d.lost_at <> now() or d.loss_reason_id <> (select id from public.loss_reasons where code = 'ca_price')
     or d.next_action_at is not null or d.pipeline_stage <> 'proposal' or d.converted_at is not null then
    raise exception 'L: losing answered % and left %', v, to_jsonb(d) - 'name' - 'description';
  end if;
  if pg_temp.ledger('l1') <> v_ledger or pg_temp.plans('l1') <> 0
     or exists (select 1 from ops.follow_ups f where f.plan_id = p.id
                 and (f.status <> 'cancelled' or f.close_reason <> 'opportunity_lost'))
     or (select a.facts from ops.commercial_acts a where a.deal_ref = d.id and a.act = 'lost')
        <> '{"lossReason": "ca_price", "followUp": "cancelled"}'::jsonb then
    raise exception 'L: the loss was observed by the ledger, or its follow-up not cancelled';
  end if;
  v := pg_temp.lose('l1', 'ca_price', v_rev);
  if v ->> 'outcome' <> 'unchanged' or (select count(*) from ops.commercial_acts a where a.deal_ref = d.id) <> 2 then
    raise exception 'L: a repeated loss changed something: %', v;
  end if;
  perform pg_temp.expect_refused('L another reason', 'OS409', format('select pg_temp.lose(''l1'', ''ca_timing'', %L)', v_rev));
end
$$;

-- ===========================================================================
-- O, S, G. Outcomes, nothing else moved, the act log.
-- ===========================================================================

do $$
declare
  v_bad text;
begin
  -- The CRM of this transaction holds only this suite's deals: none is both.
  if exists (select 1 from public.deals d where d.lost_at is not null and d.converted_at is not null) then
    raise exception 'O: a deal is both converted and lost';
  end if;
  if (select v from ca_before) is distinct from pg_temp.untouched() then
    raise exception 'S: an act touched a send, a run, a task, a stop, a review, a lead profile or a non-follow-up job: % -> %',
      (select v from ca_before), pg_temp.untouched();
  end if;
  -- The act log: the principal, the database time, a minimised fact.
  select string_agg(a.act || ':' || a.facts::text, ', ') into v_bad
    from ops.commercial_acts a
   where a.tenant_id = pg_temp.uid('ta')
     and (a.actor <> pg_temp.actor() or a.recorded_at <> now()
          or not (select coalesce(array_agg(k), '{}') from jsonb_object_keys(a.facts) k)
                 <@ case a.act when 'moved' then '{toStage}'::text[]
                              when 'next_action_set' then '{nextActionAt,followUp,followUpReason}'::text[]
                              when 'next_action_cleared' then '{followUp}'::text[]
                              when 'converted' then '{stage,followUp}'::text[]
                              when 'lost' then '{lossReason,followUp}'::text[] end
          or a.facts::text ~* 'sentinel');
  if v_bad is not null then
    raise exception 'G: an act log row carries more than its minimised fact: %', v_bad;
  end if;
  if (select count(*) from ops.commercial_acts a where a.tenant_id = pg_temp.uid('ta')) < 20 then
    raise exception 'G: too few acts were recorded for the log checks to mean anything';
  end if;
  -- Nothing of a deal's title or note reached the follow-up state or events.
  if exists (select 1 from ops.events e where e.tenant_id = pg_temp.uid('ta') and e.payload::text ~* 'sentinel')
     or exists (select 1 from ops.follow_up_plans p where p.tenant_id = pg_temp.uid('ta') and to_jsonb(p)::text ~* 'sentinel') then
    raise exception 'G: a deal''s free text reached the follow-up state or an event';
  end if;
  -- History is never rewritten.
  perform pg_temp.expect_refused('G an act rewritten', 'OS409', 'update ops.commercial_acts set act = act');
  perform pg_temp.expect_refused('G a bridge version rewritten', 'OS409', 'update ops.commercial_follow_up_bridges set enabled = enabled');
  perform pg_temp.expect_refused('G a provenance row rewritten', 'OS409', 'update ops.commercial_follow_up_plans set deal_ref = deal_ref');
  perform pg_temp.expect_refused('G the act log truncated', 'OS409', 'truncate ops.commercial_acts');
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
      raise exception using errcode = 'P0002', message = 'ca-caught';
    end;
    raise exception '%: the break was not caught', p_case;
  exception when sqlstate 'P0002' then
    null;
  end;
end
$f$;

-- X1. A revision that never changes lets a stale move through.
select pg_temp.expect_caught('X1',
  $x$create or replace function ops.crm_deal_revision(d public.deals) returns text
     language sql immutable security invoker set search_path = '' as $b$ select 'r1.' || repeat('0', 32) $b$;$x$,
  'select pg_temp.check_stale_move()', '^M stale revision');

-- X2. A lock that ignores the tenant hands tenant A's CRM to tenant B.
select pg_temp.expect_caught('X2',
  $x$create or replace function ops.crm_lock_deal(p_tenant_id uuid, p_deal_ref int8) returns public.deals
     language plpgsql volatile security invoker set search_path = '' as $b$
     declare v public.deals;
     begin
       select d.* into v from public.deals d where d.id = p_deal_ref for update;
       if not found then raise exception using errcode = 'OS404', message = 'not found'; end if;
       return v;
     end $b$;$x$,
  'select pg_temp.check_authority()', '^A tenant B');

-- X3. A cancel that selects by subject alone cancels a plan someone else made.
select pg_temp.expect_caught('X3',
  $x$create or replace function ops.commercial_follow_up_cancel(p_tenant_id uuid, p_actor text, p_deal_ref int8,
                                                                p_reason text, p_keep_company uuid) returns int4
     language plpgsql volatile security invoker set search_path = '' as $b$
     declare v uuid; n int4 := 0;
     begin
       for v in select p.id from ops.follow_up_plans p
                 where p.tenant_id = p_tenant_id and p.subject_ref = 'deal:' || p_deal_ref and p.status = 'active' loop
         perform ops.cancel_follow_up_plan(p_tenant_id, v, p_reason, p_actor, 'company-os-ui');
         n := n + 1;
       end loop;
       return n;
     end $b$;$x$,
  'select pg_temp.check_unrelated()', '^B: the bridge cancelled');

-- X4. A browser grant on the act log.
select pg_temp.expect_caught('X4',
  'grant select on ops.commercial_acts to authenticated',
  'select pg_temp.check_tables()', '^G: a role holds');

-- X5. A narrow act that also writes the contact-level next action.
select pg_temp.expect_caught('X5',
  $x$create or replace function ops.move_opportunity_as_member(p_tenant_id uuid, p_actor text, p_deal_ref int8,
                                                               p_target_stage text, p_expected_revision text) returns jsonb
     language plpgsql volatile security invoker set search_path = '' as $b$
     begin
       update public.lead_profiles set next_action_at = null where false;
       return ops.crm_move_deal(p_tenant_id, p_deal_ref, p_target_stage, p_expected_revision);
     end $b$;$x$,
  'select pg_temp.check_path()', '^F2:');

do $$ begin raise notice 'commercial acts: every check held, every deliberate break was caught'; end $$;

rollback;
