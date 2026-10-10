-- PRODUCTION SECURITY GATE A.1, attacked in SQL.
--
-- The questions: (1) does saving a contact or a company still reach a third
-- party, or leave a callable function that could; (2) can a browser session
-- below multi-factor assurance level 2 read or write any real CRM data, and
-- does level 2 change what the existing row rules already allow?
--
--   A  no automatic avatar or favicon enrichment: no trigger, no function, no
--      egress for an authenticated OR a service_role write; stored values
--      untouched; the public function surface is exactly the six row-security
--      helpers;
--   B  the CRM surface at the database authority: every browser-visible table
--      and view answers nothing at aal1 and, at aal2, exactly what it answers
--      under the local development exemption (MFA is an ADDITIONAL
--      prerequisite, never a widening); writes at aal1 change nothing; aal2 is
--      still bounded by tenant of ownership, sales assignment and the owner
--      flag; a stale pre-second-factor token, a made-up claim, another user's
--      session, an ended one and a legacy per-claim setting all fail;
--   C  the local exemption waives only the level, is one row, and the
--      predicate agrees with ops.operator_scope() on every combination.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only. The production state (no
-- exemption row) is set up inside the transaction, whatever the seed did.

\set ON_ERROR_STOP on

begin;

create temporary table ca_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into ca_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from ca_ids where name = p_name;
  if v is null then raise exception 'setup: no id named %', p_name; end if;
  return v;
end
$$;

-- Verified claims for a user's session, at a level ('none' leaves the claim out).
create function pg_temp.claims(p_who text, p_aal text, p_session text default null) returns text
language sql as $$
  select (jsonb_build_object(
    'sub', pg_temp.id('user.' || p_who), 'role', 'authenticated', 'aud', 'authenticated',
    'session_id', pg_temp.id('session.' || coalesce(p_session, p_who || '.aal2')), 'is_anonymous', false,
    'exp', extract(epoch from now() + interval '1 hour')::bigint)
    || case when p_aal = 'none' then '{}'::jsonb else jsonb_build_object('aal', p_aal) end)::text;
$$;

-- One simulated PostgREST request: the claims (and, when given, the legacy
-- per-claim settings), then one statement as authenticated returning a number.
-- Answers {ok, n} or {ok: false, code}.
create function pg_temp.q(p_claims text, p_sql text, p_legacy_aal text default null, p_legacy_sub text default null)
returns jsonb
language plpgsql as $f$
declare
  v_n     bigint;
  v_state text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  perform set_config('request.jwt.claim.aal', coalesce(p_legacy_aal, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(p_legacy_sub, ''), true);
  begin
    set local role authenticated;
    execute p_sql into v_n;
    reset role;
    return jsonb_build_object('ok', true, 'n', v_n);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    return jsonb_build_object('ok', false, 'code', v_state);
  end;
end
$f$;

create function pg_temp.n(p_answer jsonb) returns bigint
language plpgsql as $$
begin
  if not (p_answer ->> 'ok')::boolean then
    raise exception 'expected an answer, got %', p_answer;
  end if;
  return (p_answer ->> 'n')::bigint;
end
$$;

create function pg_temp.expect_code(p_label text, p_answer jsonb, p_code text) returns void
language plpgsql as $$
begin
  if (p_answer ->> 'ok')::boolean or p_answer ->> 'code' is distinct from p_code then
    raise exception '%: expected %, got %', p_label, p_code, p_answer;
  end if;
end
$$;

create function pg_temp.expect_n(p_label text, p_answer jsonb, p_n bigint) returns void
language plpgsql as $$
begin
  if not (p_answer ->> 'ok')::boolean or (p_answer ->> 'n')::bigint is distinct from p_n then
    raise exception '%: expected %, got %', p_label, p_n, p_answer;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures: an alpha operator, a beta operator and an owner, each with an aal2
-- session and an aal1 session, and one row of everything for alpha and beta.
-- ---------------------------------------------------------------------------

do $$
declare
  v_who    text;
  v_user   uuid;
  v_sales  bigint;
  v_contact bigint;
  v_deal   bigint;
begin
  foreach v_who in array array['alpha', 'beta', 'owner'] loop
    v_user := pg_temp.remember('user.' || v_who, gen_random_uuid());
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            format('ca-%s@test.local', v_who), 'x', now(), now(), now(), '{}',
            jsonb_build_object('first_name', 'Synthetic', 'last_name', v_who));
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    values (pg_temp.remember('session.' || v_who || '.aal2', gen_random_uuid()), v_user, now(), now(), 'aal2');
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    values (pg_temp.remember('session.' || v_who || '.aal1', gen_random_uuid()), v_user, now(), now(), 'aal1');
  end loop;
  -- The signup trigger can only make an operator; promote one to owner.
  update public.sales set role = 'owner', administrator = true where user_id = pg_temp.id('user.owner');

  foreach v_who in array array['alpha', 'beta'] loop
    select s.id into v_sales from public.sales s where s.user_id = pg_temp.id('user.' || v_who);
    insert into public.companies (name, sales_id) values ('Company Of ' || v_who, v_sales);
    insert into public.contacts (first_name, last_name, sales_id)
    values ('Contact', 'Of' || v_who || 'CA', v_sales) returning id into v_contact;
    insert into public.deals (name, stage, sales_id, contact_ids)
    values ('Deal Of ' || v_who, 'opportunity', v_sales, array[v_contact]) returning id into v_deal;
    insert into public.contact_notes (contact_id, sales_id, text) values (v_contact, v_sales, 'note ' || v_who);
    insert into public.deal_notes (deal_id, sales_id, text) values (v_deal, v_sales, 'note ' || v_who);
    insert into public.tasks (contact_id, sales_id, text) values (v_contact, v_sales, 'task ' || v_who);
    insert into public.acquisition_attributions (contact_id) values (v_contact);
  end loop;
  insert into public.tags (name, color) values ('ca-tag', '#000000');
  insert into public.loss_reasons (code, label) values ('ca-reason', 'Synthetic reason');
  insert into public.inbound_emails (message_id, payload) values ('ca-message', '{}');

  -- The production state, whatever the development seed recorded.
  delete from ops.operator_assurance_exemption;
end
$$;

-- ===========================================================================
-- A. No automatic third-party enrichment.
-- ===========================================================================

do $$
declare
  v_bad text;
  v_role text;
begin
  -- A1 the two triggers and the four functions are gone, and no function in
  --    public names a third-party avatar or favicon lookup.
  if to_regprocedure('public.get_avatar_for_email(text)') is not null
     or to_regprocedure('public.get_domain_favicon(text)') is not null
     or to_regprocedure('public.handle_contact_saved()') is not null
     or to_regprocedure('public.handle_company_saved()') is not null then
    raise exception 'A1: an enrichment function still exists';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~* '(gravatar|favicon\.show|extensions\.http_)';
  if v_bad is not null then
    raise exception 'A1: a public function names a third-party lookup: %', v_bad;
  end if;

  -- A2 every trigger on contacts and companies is one of the five reviewed
  --    (ADR 0026 §C added the edit mark, which writes only its own table),
  --    and none of their functions reaches a network or a lookup.
  select string_agg(c.relname || '.' || t.tgname, ', ' order by c.relname, t.tgname) into v_bad
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where not t.tgisinternal and c.oid in ('public.contacts'::regclass, 'public.companies'::regclass);
  if v_bad is distinct from
     'companies.set_company_sales_id_trigger, contacts.10_lowercase_contact_emails, '
     || 'contacts.create_lead_profile_after_contact_insert, contacts.mark_crm_contact_edit_trigger, '
     || 'contacts.set_contact_sales_id_trigger' then
    raise exception 'A2: the triggers on contacts and companies changed: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal and t.tgrelid in ('public.contacts'::regclass, 'public.companies'::regclass)
     and p.prosrc ~* '(http|gravatar|favicon|net\.)';
  if v_bad is not null then
    raise exception 'A2: a trigger function on contacts or companies names a network call: %', v_bad;
  end if;

  -- A3 PUBLIC and anon execute nothing in public; authenticated exactly the
  --    six row-security helpers; no Company OS capability role executes
  --    anything in public and no browser role is a member of one.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A3: a public function is executable by PUBLIC or anon: %', v_bad;
  end if;
  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', '
                    order by p.proname || '(' || oidvectortypes(p.proargtypes) || ')') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_bad is distinct from
     'can_access_contact(bigint), can_access_deal(bigint), can_manage_sales_id(bigint), current_sales_id(), '
     || 'is_active_sales_user(), is_admin()' then
    raise exception 'A3: authenticated executes other than the six row-security helpers: %', v_bad;
  end if;
  foreach v_role in array array['ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    select string_agg(p.oid::regprocedure::text, ', ') into v_bad
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then
      raise exception 'A3: % executes public functions: %', v_role, v_bad;
    end if;
  end loop;

  -- A4 the assurance predicate is nobody's callable surface.
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_function_privilege(v_role, 'ops.session_assurance_satisfied()', 'EXECUTE') then
      raise exception 'A4: % can execute the assurance predicate', v_role;
    end if;
  end loop;
end
$$;

do $$
declare
  v_alpha_sales bigint;
  v_c bigint;
  v_avatar jsonb;
begin
  select id into v_alpha_sales from public.sales where user_id = pg_temp.id('user.alpha');

  -- A5 an authenticated (aal2) contact insert and update succeed, and stamp
  --    nothing: no avatar is looked up or derived from the email.
  perform pg_temp.expect_n('A5 insert',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with i as (insert into public.contacts (first_name, last_name, sales_id, email_jsonb)
                values ('Synthetic', 'EnrichA', %s, '[{"email": "synthetic.a@example.test", "type": "Work"}]')
                returning 1) select count(*) from i$s$, v_alpha_sales)), 1);
  select id, avatar into v_c, v_avatar from public.contacts where last_name = 'EnrichA';
  if v_avatar is not null then
    raise exception 'A5: an insert stamped an avatar: %', v_avatar;
  end if;
  perform pg_temp.expect_n('A5 update',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with u as (update public.contacts set email_jsonb = '[{"email": "changed.a@example.test", "type": "Home"}]'
                where id = %s returning 1) select count(*) from u$s$, v_c)), 1);
  select avatar into v_avatar from public.contacts where id = v_c;
  if v_avatar is not null then
    raise exception 'A5: an update stamped an avatar: %', v_avatar;
  end if;

  -- A6 an avatar already stored stays as stored, through an insert and an update.
  perform pg_temp.expect_n('A6 insert with an avatar',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with i as (insert into public.contacts (first_name, last_name, sales_id, email_jsonb, avatar)
                values ('Synthetic', 'EnrichKept', %s, '[{"email": "kept@example.test", "type": "Work"}]',
                        '{"src": "stored:avatar-1"}') returning 1) select count(*) from i$s$, v_alpha_sales)), 1);
  select id into v_c from public.contacts where last_name = 'EnrichKept';
  perform pg_temp.expect_n('A6 update beside an avatar',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with u as (update public.contacts set first_name = 'Renamed' where id = %s returning 1)
                select count(*) from u$s$, v_c)), 1);
  if (select avatar from public.contacts where id = v_c) is distinct from '{"src": "stored:avatar-1"}'::jsonb then
    raise exception 'A6: a stored avatar changed';
  end if;

  -- A7 a company insert and update succeed and stamp no logo from its
  --    website; a stored logo stays as stored.
  perform pg_temp.expect_n('A7 company insert',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with i as (insert into public.companies (name, website, sales_id)
                values ('Enrich Company', 'https://enrich.example.test', %s) returning 1)
                select count(*) from i$s$, v_alpha_sales)), 1);
  if (select logo from public.companies where name = 'Enrich Company') is not null then
    raise exception 'A7: a company insert stamped a logo';
  end if;
  perform pg_temp.expect_n('A7 company update',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      $s$with u as (update public.companies set website = 'https://other.example.test'
                where name = 'Enrich Company' returning 1) select count(*) from u$s$), 1);
  if (select logo from public.companies where name = 'Enrich Company') is not null then
    raise exception 'A7: a company update stamped a logo';
  end if;
  perform pg_temp.expect_n('A7 company with a logo',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with i as (insert into public.companies (name, website, sales_id, logo)
                values ('Kept Logo Company', 'https://kept.example.test', %s, '{"src": "stored:logo-1", "title": "Stored"}')
                returning 1) select count(*) from i$s$, v_alpha_sales)), 1);
  perform pg_temp.expect_n('A7 update beside a logo',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      $s$with u as (update public.companies set website = 'https://moved.example.test'
                where name = 'Kept Logo Company' returning 1) select count(*) from u$s$), 1);
  if (select logo from public.companies where name = 'Kept Logo Company')
       is distinct from '{"src": "stored:logo-1", "title": "Stored"}'::jsonb then
    raise exception 'A7: a stored logo changed';
  end if;
end
$$;

-- A8 the backend path: a service_role write of a contact and of a company
--    succeeds and reaches nothing (the function that asked Gravatar for it no
--    longer exists, and no trigger calls a network function: A1, A2).
do $$
declare
  v_avatar jsonb;
begin
  set local role service_role;
  insert into public.contacts (first_name, last_name, email_jsonb)
  values ('Synthetic', 'EnrichService', '[{"email": "service@example.test", "type": "Work"}]');
  insert into public.companies (name, website) values ('Service Company', 'https://service.example.test');
  reset role;
  select avatar into v_avatar from public.contacts where last_name = 'EnrichService';
  if v_avatar is not null or (select logo from public.companies where name = 'Service Company') is not null then
    raise exception 'A8: a service_role write stamped an avatar or a logo';
  end if;
end
$$;

-- ===========================================================================
-- B. The CRM's real-data surface needs multi-factor assurance.
-- ===========================================================================

-- B1 every table and view a browser role can select is one this suite checks,
--    so a future relation cannot slip past it unread.
do $$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
     and has_table_privilege('authenticated', c.oid, 'SELECT')
     and c.relname <> all (array[
       'acquisition_attributions', 'activity_log', 'companies', 'companies_summary', 'configuration',
       'contact_notes', 'contacts', 'contacts_summary', 'deal_notes', 'deals', 'favicons_excluded_domains',
       'inbound_emails', 'lead_profiles', 'loss_reasons', 'sales', 'tags', 'tasks']);
  if v_bad is not null then
    raise exception 'B1: authenticated can read relations this suite does not check: %', v_bad;
  end if;
  -- Every policy on the CRM decides through the row-security helpers, whose
  -- two roots (current_sales_id and is_admin) carry the assurance rule: a
  -- policy that did not (using (true), a bare auth.uid() test) would be a way
  -- around it.
  select string_agg(p.tablename || '.' || p.policyname, ', ' order by p.tablename, p.policyname) into v_bad
    from pg_policies p
   where p.schemaname = 'public'
     and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))
           !~ '(is_active_sales_user|is_admin|can_manage_sales_id|can_access_contact|can_access_deal|current_sales_id)()?';
  if v_bad is not null then
    raise exception 'B1: a policy decides without the row-security helpers, so without the assurance rule: %', v_bad;
  end if;
  -- And every view is security_invoker, so it inherits the source table's rows.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and has_table_privilege('authenticated', c.oid, 'SELECT')
     and coalesce((select true from unnest(c.reloptions) o where o ~ '^security_invoker=(on|true|1)$'), false) is not true;
  if v_bad is not null then
    raise exception 'B1: a browser-readable view is not security_invoker: %', v_bad;
  end if;
end
$$;

-- B2 for each relation and user: NOTHING at aal1, and at aal2 exactly what the
--    development exemption would have shown at aal1 (the row rules unchanged,
--    the level only an additional prerequisite); and some relations show
--    something to some user, so "nothing" is the level, not an empty table.
do $$
declare
  v_rel text;
  v_who text;
  v_at_aal2 bigint;
  v_visible int := 0;
  v_seen jsonb := '{}';
begin
  foreach v_who in array array['alpha', 'beta', 'owner'] loop
    foreach v_rel in array array[
      'acquisition_attributions', 'activity_log', 'companies', 'companies_summary', 'configuration',
      'contact_notes', 'contacts', 'contacts_summary', 'deal_notes', 'deals', 'favicons_excluded_domains',
      'inbound_emails', 'lead_profiles', 'loss_reasons', 'sales', 'tags', 'tasks'] loop
      -- Production: level 1 sees nothing, on either the token or the session.
      perform pg_temp.expect_n(format('B2 %s aal1 (%s)', v_rel, v_who),
        pg_temp.q(pg_temp.claims(v_who, 'aal1', v_who || '.aal1'), format('select count(*) from public.%I', v_rel)), 0);
      v_at_aal2 := pg_temp.n(pg_temp.q(pg_temp.claims(v_who, 'aal2'), format('select count(*) from public.%I', v_rel)));
      v_seen := v_seen || jsonb_build_object(v_who || '.' || v_rel, v_at_aal2);
      if v_at_aal2 > 0 then v_visible := v_visible + 1; end if;
    end loop;
  end loop;

  -- The development exemption: the same row rules at any level.
  insert into ops.operator_assurance_exemption (reason, recorded_by) values ('crm_assurance suite: local only', 'ca-owner');
  foreach v_who in array array['alpha', 'beta', 'owner'] loop
    foreach v_rel in array array[
      'acquisition_attributions', 'activity_log', 'companies', 'companies_summary', 'configuration',
      'contact_notes', 'contacts', 'contacts_summary', 'deal_notes', 'deals', 'favicons_excluded_domains',
      'inbound_emails', 'lead_profiles', 'loss_reasons', 'sales', 'tags', 'tasks'] loop
      perform pg_temp.expect_n(format('B2 %s aal2 equals the exempted aal1 (%s)', v_rel, v_who),
        pg_temp.q(pg_temp.claims(v_who, 'aal1', v_who || '.aal1'), format('select count(*) from public.%I', v_rel)),
        (v_seen ->> (v_who || '.' || v_rel))::bigint);
    end loop;
  end loop;
  delete from ops.operator_assurance_exemption;

  if v_visible < 20 then
    raise exception 'B2: only % relation/user pairs show anything at aal2, the fixtures did not exercise the gate', v_visible;
  end if;
  -- The named shapes: alpha its own rows, the owner both operators', beta's
  -- contact hidden from alpha, and the owner-only ledger hidden from operators.
  if (v_seen ->> 'alpha.contacts')::int < 1 or (v_seen ->> 'owner.contacts')::int <> (select count(*) from public.contacts)
     or (v_seen ->> 'alpha.contacts')::int >= (v_seen ->> 'owner.contacts')::int
     or (v_seen ->> 'alpha.inbound_emails')::int <> 0
     or (v_seen ->> 'owner.inbound_emails')::int <> (select count(*) from public.inbound_emails)
     or (select count(*) from public.inbound_emails) < 1
     or (v_seen ->> 'alpha.sales')::int <> 1 or (v_seen ->> 'owner.sales')::int < 3 then
    raise exception 'B2: the row rules at aal2 changed: %', v_seen;
  end if;
end
$$;

-- B3 writes at aal1 change nothing; at aal2 they are still bounded by the owner
--    of the row (no widening), and the owner flag still separates admin acts.
do $$
declare
  v_alpha_contact bigint;
  v_beta_contact bigint;
  v_alpha_sales bigint;
  v_beta_sales bigint;
  v_before bigint;
begin
  select id into v_alpha_contact from public.contacts where last_name = 'OfalphaCA';
  select id into v_beta_contact from public.contacts where last_name = 'OfbetaCA';
  select id into v_alpha_sales from public.sales where user_id = pg_temp.id('user.alpha');
  select id into v_beta_sales from public.sales where user_id = pg_temp.id('user.beta');
  select count(*) into v_before from public.contacts;

  perform pg_temp.expect_code('B3 insert at aal1',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'),
      format($s$with i as (insert into public.contacts (first_name, last_name, sales_id)
                values ('X', 'AtAal1', %s) returning 1) select count(*) from i$s$, v_alpha_sales)), '42501');
  perform pg_temp.expect_n('B3 update at aal1',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'),
      format($s$with u as (update public.contacts set first_name = 'Changed' where id = %s returning 1)
                select count(*) from u$s$, v_alpha_contact)), 0);
  perform pg_temp.expect_n('B3 delete at aal1',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'),
      format($s$with d as (delete from public.contacts where id = %s returning 1)
                select count(*) from d$s$, v_alpha_contact)), 0);
  perform pg_temp.expect_code('B3 an owner-only write at aal1',
    pg_temp.q(pg_temp.claims('owner', 'aal1', 'owner.aal1'),
      $s$with i as (insert into public.tags (name, color) values ('at-aal1', '#111111') returning 1)
         select count(*) from i$s$), '42501');
  perform pg_temp.expect_n('B3 an owner is not an admin at aal1',
    pg_temp.q(pg_temp.claims('owner', 'aal1', 'owner.aal1'), 'select public.is_admin()::int'), 0);
  if (select count(*) from public.contacts) <> v_before
     or (select first_name from public.contacts where id = v_alpha_contact) <> 'Contact'
     or exists (select 1 from public.tags where name = 'at-aal1') then
    raise exception 'B3: a write below level 2 changed data';
  end if;

  -- At aal2 the existing rules decide, not the level.
  perform pg_temp.expect_n('B3 own update at aal2',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with u as (update public.contacts set first_name = 'Mine' where id = %s returning 1)
                select count(*) from u$s$, v_alpha_contact)), 1);
  perform pg_temp.expect_n('B3 another operator''s update at aal2',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with u as (update public.contacts set first_name = 'Theirs' where id = %s returning 1)
                select count(*) from u$s$, v_beta_contact)), 0);
  perform pg_temp.expect_code('B3 another operator''s insert at aal2',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'),
      format($s$with i as (insert into public.contacts (first_name, last_name, sales_id)
                values ('X', 'ForBeta', %s) returning 1) select count(*) from i$s$, v_beta_sales)), '42501');
  perform pg_temp.expect_n('B3 an operator is not an admin at aal2',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'), 'select public.is_admin()::int'), 0);
  perform pg_temp.expect_n('B3 the owner is an admin at aal2',
    pg_temp.q(pg_temp.claims('owner', 'aal2'), 'select public.is_admin()::int'), 1);
  perform pg_temp.expect_n('B3 the owner updates another operator''s contact at aal2',
    pg_temp.q(pg_temp.claims('owner', 'aal2'),
      format($s$with u as (update public.contacts set first_name = 'ByOwner' where id = %s returning 1)
                select count(*) from u$s$, v_beta_contact)), 1);
  -- A user without a sales row is still nobody at aal2.
  perform pg_temp.remember('user.stranger', gen_random_uuid());
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values (pg_temp.id('user.stranger'), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'ca-stranger@test.local', 'x', now(), now(), now(), '{}', '{"first_name":"S","last_name":"S"}');
  delete from public.sales where user_id = pg_temp.id('user.stranger');
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (pg_temp.remember('session.stranger.aal2', gen_random_uuid()), pg_temp.id('user.stranger'), now(), now(), 'aal2');
  perform pg_temp.expect_n('B3 no sales row at aal2',
    pg_temp.q(pg_temp.claims('stranger', 'aal2'), 'select count(*) from public.contacts'), 0);
end
$$;

-- B4 a token from before the second factor stays refused, however the session
--    changed; and nothing the request states can raise the level.
do $$
declare
  v_alpha_sales bigint;
begin
  select id into v_alpha_sales from public.sales where user_id = pg_temp.id('user.alpha');
  -- The same session, now verified at level 2: the NEW token passes and the
  -- OLD token (its claims still say aal1) does not.
  update auth.sessions set aal = 'aal2' where id = pg_temp.id('session.alpha.aal1');
  perform pg_temp.expect_n('B4 the new token after the second factor',
    pg_temp.q(pg_temp.claims('alpha', 'aal2', 'alpha.aal1'), 'select count(*) from public.contacts where sales_id = ' || v_alpha_sales),
      (select count(*) from public.contacts where sales_id = v_alpha_sales));
  perform pg_temp.expect_n('B4 the stale pre-second-factor token',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'), 'select count(*) from public.contacts'), 0);
  update auth.sessions set aal = 'aal1' where id = pg_temp.id('session.alpha.aal1');

  -- B5 spoofing, each refused: aal2 claims over an aal1 session, a legacy
  --    per-claim setting, no aal claim, no session, another user's session, a
  --    session that is not a uuid, an ended and a deleted session, and a
  --    legacy subject that is not the claims' subject.
  perform pg_temp.expect_n('B5 aal2 claims over an aal1 session',
    pg_temp.q(pg_temp.claims('alpha', 'aal2', 'alpha.aal1'), 'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 a legacy aal claim setting',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'), 'select count(*) from public.contacts', 'aal2'), 0);
  perform pg_temp.expect_n('B5 an aal2 session whose token says aal1',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal2'), 'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 no aal claim',
    pg_temp.q(pg_temp.claims('alpha', 'none', 'alpha.aal2'), 'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 no session in the claims',
    pg_temp.q((pg_temp.claims('alpha', 'aal2')::jsonb - 'session_id')::text, 'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 claims with only a subject',
    pg_temp.q(jsonb_build_object('sub', pg_temp.id('user.alpha'))::text, 'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 another user''s aal2 session',
    pg_temp.q((pg_temp.claims('alpha', 'aal2') ::jsonb || jsonb_build_object('session_id', pg_temp.id('session.beta.aal2')))::text,
              'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 a session id that is not a uuid',
    pg_temp.q((pg_temp.claims('alpha', 'aal2')::jsonb || jsonb_build_object('session_id', 'not-a-uuid'))::text,
              'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 claims that are not an object',
    pg_temp.q('"aal2"', 'select count(*) from public.contacts'), 0);
  perform pg_temp.expect_n('B5 a legacy subject that is not the claims'' subject',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'), 'select count(*) from public.contacts', null, pg_temp.id('user.beta')::text), 0);
  -- The owner-session channel (runAsUser, merge_contacts) sets the legacy
  -- subject AND the verified claims: allowed at level 2 and refused at level 1;
  -- the legacy subject alone (its shape before Gate A.1) is refused.
  perform pg_temp.expect_n('B5 the owner-session channel at aal2',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'), 'select count(*) from public.contacts where sales_id = ' || v_alpha_sales,
              null, pg_temp.id('user.alpha')::text),
      (select count(*) from public.contacts where sales_id = v_alpha_sales));
  perform pg_temp.expect_n('B5 the owner-session channel at aal1',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'), 'select count(*) from public.contacts',
              null, pg_temp.id('user.alpha')::text), 0);
  perform pg_temp.expect_n('B5 the legacy subject alone',
    pg_temp.q('', 'select count(*) from public.contacts', null, pg_temp.id('user.alpha')::text), 0);
  update auth.sessions set not_after = now() - interval '1 minute' where id = pg_temp.id('session.alpha.aal2');
  perform pg_temp.expect_n('B5 an ended session',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'), 'select count(*) from public.contacts'), 0);
  update auth.sessions set not_after = null where id = pg_temp.id('session.alpha.aal2');
  delete from auth.sessions where id = pg_temp.id('session.alpha.aal2');
  perform pg_temp.expect_n('B5 a signed-out session',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'), 'select count(*) from public.contacts'), 0);
  -- Restore for what follows.
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (pg_temp.id('session.alpha.aal2'), pg_temp.id('user.alpha'), now(), now(), 'aal2');
  perform pg_temp.expect_n('B5 the restored session works again',
    pg_temp.q(pg_temp.claims('alpha', 'aal2'), 'select count(*) from public.contacts where sales_id = ' || v_alpha_sales),
      (select count(*) from public.contacts where sales_id = v_alpha_sales));
end
$$;

-- B6 a browser role can read or call nothing that decides the level.
do $$
declare
  v_probe text;
begin
  foreach v_probe in array array[
    'select ops.session_assurance_satisfied()',
    'select count(*) from ops.operator_assurance_exemption',
    'select count(*) from auth.sessions'] loop
    perform pg_temp.expect_code('B6 ' || v_probe,
      pg_temp.q(pg_temp.claims('alpha', 'aal2'), v_probe), '42501');
  end loop;
end
$$;

-- ===========================================================================
-- C. The one non-production exemption, and its agreement with the Company OS.
-- ===========================================================================

do $$
declare
  v_alpha_sales bigint;
  v_role text;
  v_state text;
begin
  select id into v_alpha_sales from public.sales where user_id = pg_temp.id('user.alpha');

  -- C1 recorded by the owner, it waives the level and nothing else: the claims
  --    the older suites use (only a subject) pass, an aal1 session passes, and
  --    every row rule still decides.
  insert into ops.operator_assurance_exemption (reason, recorded_by) values ('crm_assurance suite: local only', 'ca-owner');
  perform pg_temp.expect_n('C1 a subject-only claim under the exemption',
    pg_temp.q(jsonb_build_object('sub', pg_temp.id('user.alpha'))::text,
              'select count(*) from public.contacts where sales_id = ' || v_alpha_sales),
      (select count(*) from public.contacts where sales_id = v_alpha_sales));
  perform pg_temp.expect_n('C1 the rows of another operator stay hidden under the exemption',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'), 'select count(*) from public.contacts where sales_id <> ' || v_alpha_sales), 0);
  perform pg_temp.expect_n('C1 an operator is still no admin under the exemption',
    pg_temp.q(pg_temp.claims('alpha', 'aal1', 'alpha.aal1'), 'select public.is_admin()::int'), 0);
  perform pg_temp.expect_n('C1 a user without a sales row under the exemption',
    pg_temp.q(pg_temp.claims('stranger', 'aal1', 'stranger.aal2'), 'select count(*) from public.contacts'), 0);

  -- C2 at most one row.
  begin
    insert into ops.operator_assurance_exemption (reason, recorded_by) values ('again', 'ca-owner');
    raise exception 'C2: a second exemption row was accepted';
  exception when unique_violation then
    null;
  end;

  -- C3 no application role holds any privilege on it.
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_table_privilege(v_role, 'ops.operator_assurance_exemption', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'C3: % holds a privilege on the assurance exemption', v_role;
    end if;
  end loop;
end
$$;

-- C4 ONE rule: for every level on the session row and on the token, with and
--    without the exemption, the CRM predicate passes exactly when the Company
--    OS resolver gets past its assurance step (a user with no membership then
--    reaches OS403; a failed level is OS401).
do $$
declare
  v_session text;
  v_claim   text;
  v_exempt  boolean;
  v_pred    boolean;
  v_code    text;
begin
  foreach v_session in array array['aal1', 'aal2', 'aal3'] loop
    foreach v_claim in array array['aal1', 'aal2', 'aal3', 'none'] loop
      foreach v_exempt in array array[false, true] loop
        delete from ops.operator_assurance_exemption;
        if v_exempt then
          insert into ops.operator_assurance_exemption (reason, recorded_by) values ('crm_assurance suite: local only', 'ca-owner');
        end if;
        update auth.sessions set aal = v_session::auth.aal_level where id = pg_temp.id('session.alpha.aal1');
        perform set_config('request.jwt.claims', pg_temp.claims('alpha', v_claim, 'alpha.aal1'), true);
        perform set_config('request.jwt.claim.sub', '', true);
        v_pred := ops.session_assurance_satisfied();
        begin
          perform * from ops.operator_scope();
          v_code := 'ok';
        exception when others then
          get stacked diagnostics v_code = returned_sqlstate;
        end;
        if v_pred is distinct from (v_code <> 'OS401') then
          raise exception 'C4: session %, token %, exemption %: the CRM predicate says % and the Company OS says %',
            v_session, v_claim, v_exempt, v_pred, v_code;
        end if;
      end loop;
    end loop;
  end loop;
  update auth.sessions set aal = 'aal1' where id = pg_temp.id('session.alpha.aal1');
end
$$;

select 'crm_assurance: PASS' as result;

rollback;
