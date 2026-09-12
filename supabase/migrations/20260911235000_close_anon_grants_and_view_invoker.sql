-- Close two holes that the GENERATED migration 20260911232039_pending_delta.sql
-- opened, and that applying it successfully did not reveal.
--
-- Both were measured against a live Postgres on 2026-09-11, not inferred.
--
-- HOLE 1: `security_invoker` is silently dropped by `db diff`
-- `supabase/schemas/03_views.sql` declares all four views `with (security_invoker
-- = on)`. `db diff` emits only the view's QUERY, never its reloptions, so the
-- generated migration recreated `contacts_summary` and `init_state` WITHOUT it.
-- Measured after a clean reset:
--     activity_log      -> {security_invoker=on}   (untouched by the diff)
--     companies_summary -> {security_invoker=on}   (untouched by the diff)
--     contacts_summary  -> (none)                  <-- recreated by the diff
--     init_state        -> (none)                  <-- recreated by the diff
-- A view without `security_invoker` executes as its OWNER (postgres), so RLS on
-- contacts / companies / tasks / lead_profiles does not apply to it at all.
--
-- HOLE 2: `anon` holds GRANT ALL on seven objects. TWO distinct causes, both
-- verified by reading the SQL and confirming the resulting ACLs:
--
--   (a) The FOUR VIEWS - an explicit, still-live migration.
--       `20260601120000_grant_init_state_to_api_roles.sql` issues
--       `grant all on table public.<view> to anon` for activity_log,
--       companies_summary, contacts_summary and init_state. It was written when
--       Supabase stopped auto-exposing objects, to keep the pre-auth
--       `init_state` probe working, and it granted ALL rather than SELECT to all
--       four. Two of those views have since stopped being security_invoker
--       (hole 1), which is what turns this from over-broad into exploitable.
--
--   (b) The THREE NEW TABLES - Supabase's default privileges.
--       `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
--       authenticated, service_role` is still present in `pg_default_acl`
--       (grantor postgres). `06_grants.sql:62-67` revokes it, but
--       `ALTER DEFAULT PRIVILEGES` is not DDL that `db diff` can emit, so -
--       exactly like the storage-bucket lockdown in `07_storage.sql` - the
--       hardening exists in the declarative schema and in NO migrated database.
--       The diff names the three new tables only in GRANTs to authenticated and
--       service_role; it revokes anon on the ten PRE-EXISTING tables only.
--
-- Confirmed ACL on all seven: `anon=arwdDxt/postgres`.
--
-- MEASURED IMPACT (both reproduced, the destructive one inside a rollback)
-- 1. Unauthenticated read of every contact, over plain HTTP, anon key only:
--      GET /rest/v1/contacts_summary?select=id,first_name,last_name
--      -> 200 [{"id":9,...},{"id":10,...}]
--    while the base table correctly refuses:
--      GET /rest/v1/contacts -> 42501 permission denied for table contacts
--    Under LGPD these are patient contact records. RLS was not bypassed by a
--    policy bug; the view simply never applied it.
-- 2. RLS does NOT gate TRUNCATE. As anon: `truncate public.lead_profiles` ->
--    2 rows to 0. So the anon grant is exploitable even where RLS is on.

-- 1. Reinstate caller-scoped execution on the two views the diff flattened.
--    `alter view ... set` changes only the reloption, so the query text stays
--    byte-identical and the next `db diff` sees no phantom change.
alter view public.contacts_summary set (security_invoker = on);
alter view public.init_state set (security_invoker = on);

-- 2. Strip the default-privilege grants from every object in `public`, then
--    re-grant exactly what `06_grants.sql` declares and nothing more.
--    Deny first, grant back: a verb missing here is denied, which is the point.
do $$
declare
  v_obj text;
begin
  for v_obj in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v')
  loop
    execute format('revoke all on table public.%I from anon', v_obj);
    execute format('revoke all on table public.%I from authenticated', v_obj);
  end loop;

  for v_obj in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence public.%I from anon', v_obj);
    execute format('revoke all on sequence public.%I from authenticated', v_obj);
  end loop;
end
$$;

-- 3. Re-grant the declared surface (mirrors supabase/schemas/06_grants.sql).
grant select, insert, update, delete on table public.companies to authenticated;
grant select, insert, update, delete on table public.contacts to authenticated;
grant select, insert, update, delete on table public.contact_notes to authenticated;
grant select, insert, update, delete on table public.deals to authenticated;
grant select, insert, update, delete on table public.deal_notes to authenticated;
grant select, insert, update, delete on table public.tags to authenticated;
grant select, insert, update, delete on table public.tasks to authenticated;
grant select on table public.sales to authenticated;
-- `update` is required even though `configuration_update_owner` gates it on
-- is_admin(): the grant is the outer gate and the policy the inner one, so
-- dropping it would make settings unwritable for a legitimate owner too. An
-- earlier revision of this migration granted only `select` here; `supabase db
-- diff` caught the divergence from 06_grants.sql, which is the source of truth.
grant select, update on table public.configuration to authenticated;
grant select on table public.favicons_excluded_domains to authenticated;
grant select, update on table public.lead_profiles to authenticated;
grant select, insert, update, delete on table public.acquisition_attributions to authenticated;
grant select, insert, update, delete on table public.loss_reasons to authenticated;

-- Views are read-only API resources; with security_invoker restored they apply
-- the caller's policies on their source tables.
grant select on table public.activity_log to authenticated;
grant select on table public.companies_summary to authenticated;
grant select on table public.contacts_summary to authenticated;
-- public.init_state is deliberately granted to NOBODY: it has zero references in
-- src/ (verified by grep), so nothing reads it. Re-granting it is a decision to
-- take when something needs pre-auth initialisation detection, not a default.

grant usage on sequence public.companies_id_seq to authenticated;
grant usage on sequence public."contactNotes_id_seq" to authenticated;
grant usage on sequence public.contacts_id_seq to authenticated;
grant usage on sequence public."dealNotes_id_seq" to authenticated;
grant usage on sequence public.deals_id_seq to authenticated;
grant usage on sequence public.tags_id_seq to authenticated;
grant usage on sequence public.tasks_id_seq to authenticated;
grant usage on sequence public.acquisition_attributions_id_seq to authenticated;
grant usage on sequence public.loss_reasons_id_seq to authenticated;
grant usage on sequence public.lead_profiles_id_seq to authenticated;

-- 4. Stop the NEXT table from being born public. This is the root cause: without
--    it, every object a future migration creates repeats hole 2 silently.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

-- 5. Assert the end state. A migration that silently no-ops is worse than none,
--    because it looks applied - this repository has already been bitten twice by
--    that (REVOKE EXECUTE on supabase_admin-owned functions, and the storage
--    bucket). These checks are deliberately written over the CATALOGUE rather
--    than over a fixed list, so a table added later is covered too.
do $$
declare
  v_bad text;
begin
  -- 5a. No view in `public` may bypass RLS while an application role can read it.
  select string_agg(c.relname, ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'v'
    and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=on%'
    and (has_table_privilege('anon', c.oid, 'SELECT')
         or has_table_privilege('authenticated', c.oid, 'SELECT'));
  if v_bad is not null then
    raise exception
      'view(s) % run as owner (no security_invoker) yet are readable by anon/authenticated: RLS does not apply to them', v_bad;
  end if;

  -- 5b. `anon` may hold NO privilege on any table or view in `public`. Note this
  --     has to check every verb, not just SELECT: RLS does not gate TRUNCATE, so
  --     an anon TRUNCATE grant empties an RLS-protected table (measured).
  select string_agg(format('%s:%s', c.relname, p.priv), ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
  where n.nspname = 'public'
    and c.relkind in ('r', 'v')
    and has_table_privilege('anon', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'anon still holds privileges in schema public: %', v_bad;
  end if;

  -- 5c. `authenticated` must not hold the three verbs that defeat RLS or the
  --     ownership model: TRUNCATE (not gated by RLS), TRIGGER (attach code to a
  --     table you do not own), REFERENCES (probe rows through an FK).
  select string_agg(format('%s:%s', c.relname, p.priv), ', ')
  into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
  where n.nspname = 'public'
    and c.relkind in ('r', 'v')
    and has_table_privilege('authenticated', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'authenticated holds RLS-defeating privileges: %', v_bad;
  end if;
end
$$;

-- KNOWN LIMIT, recorded rather than papered over:
-- `pg_default_acl` carries a SECOND entry for schema public whose grantor is
-- `supabase_admin`, also granting ALL on tables to anon/authenticated. Only the
-- GRANTOR may revoke a grant, and `postgres` is not a member of supabase_admin -
-- the same platform rule that makes REVOKE EXECUTE on pg_net a no-op. It applies
-- only to objects CREATED BY supabase_admin, which our migrations never do, so
-- it does not affect this schema. Assertion 5b is what catches it if that ever
-- stops being true.
