-- Remove pg_net. This is the architectural resolution of the outbound-network
-- question, replacing the WARNING that 20260911130000 raises on every apply.
--
-- THE PROBLEM THAT COULD NOT BE FIXED WITH PRIVILEGES
-- `20260911130000_revoke_network_extension_privileges.sql` closed the `http`
-- extension by revoking USAGE on schema `extensions`. That works because
-- `postgres` OWNS `extensions`. It does not work for pg_net:
--     schema      owner            anon USAGE   authenticated USAGE
--     extensions  postgres         f            f     <- closed by the revoke
--     net         supabase_admin   t            t     <- revoke silently ignored
-- PostgreSQL lets only the GRANTOR revoke a grant. `net.http_post`'s ACL is
-- `anon=X/supabase_admin`, and `postgres` is not a member of `supabase_admin`
-- and cannot SET ROLE to it. A REVOKE issued by a migration is accepted and does
-- nothing. Verified as `authenticated` before this migration:
--     select net.http_get('http://127.0.0.1:1/exfil');  ->  request_id 1
-- The request was queued. That is a working exfiltration primitive: a
-- syntactically read-only statement that satisfies RLS and posts rows off-box,
-- which `SET TRANSACTION READ ONLY` does not stop because it is not a write.
--
-- WHY REMOVAL, NOT CONTAINMENT
-- Two options were evaluated. Containment (keep pg_net, deny every untrusted SQL
-- path to it) is strictly weaker here: the deny would have to hold in the
-- application layer forever, against a capability the database hands to `anon`.
-- Removal deletes the capability, and `DROP EXTENSION` takes the `net` schema
-- with it, so there is nothing left to reach.
--
-- IS IT USED? MEASURED, NOT ASSUMED.
-- The repository's only reference to `net.*` is `public.cleanup_note_attachments`
-- (supabase/schemas/02_functions.sql). Its four triggers were dropped by
-- 20260911232039_pending_delta.sql -- the clinical profile installs no
-- attachment-triggered network call (supabase/schemas/04_triggers.sql:55-57).
-- The live trigger on contact_notes runs a DIFFERENT function,
-- `handle_contact_note_created_or_updated`, which only touches contacts.last_seen.
-- Probed on a clean database: inserting a contact_note left
-- `net.http_request_queue` at 0 rows. `drop extension pg_net` (no CASCADE) then
-- succeeded, which is the catalogue confirming nothing depends on it.
--
-- WHAT THIS DOES NOT TOUCH
-- The `http` extension stays. `public.get_avatar_for_email` uses
-- `extensions.http_get` and its trigger IS live, and `service_role` (edge
-- functions, server-side) legitimately needs egress. It is already contained by
-- the schema-level revoke, which is effective because postgres owns that schema.

do $$
declare
  v_offender text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise notice 'pg_net is not installed; nothing to drop';
    return;
  end if;

  -- Refuse to drop it out from under a live caller. A trigger that starts
  -- failing at runtime because an extension vanished is exactly the kind of
  -- silent breakage this repository keeps finding, so check first and stop.
  select string_agg(format('%s.%s -> %s', c.relname, t.tgname, p.proname), ', ')
  into v_offender
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'public'
    and p.prosrc like '%net.http%';

  if v_offender is not null then
    raise exception
      'refusing to drop pg_net: live trigger(s) still call it (%). Remove or repoint them first, or decide deliberately to keep pg_net and document why.', v_offender;
  end if;

  drop extension pg_net;
end
$$;

-- Assert the capability is actually gone, for every application role and for
-- the schema as a whole. Without this the migration could no-op and still look
-- applied -- the failure mode that hid the REVOKE EXECUTE problem.
do $$
declare
  v_role text;
begin
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_net is still installed after the drop';
  end if;

  if exists (select 1 from pg_namespace where nspname = 'net') then
    raise exception 'schema "net" survived dropping pg_net; the egress channel is still present';
  end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    if has_schema_privilege(v_role, 'extensions', 'USAGE') then
      raise exception 'role % can reach schema extensions; the database is still an egress channel', v_role;
    end if;
  end loop;
end
$$;

-- CONSEQUENCE, recorded deliberately:
-- `public.cleanup_note_attachments` still exists and still names `net.http_post`
-- in its body. It is dormant -- no trigger calls it -- and plpgsql does not
-- resolve names until execution, so it neither blocks this migration nor breaks
-- anything today. It is kept rather than deleted because restoring note
-- attachments is a product decision, not a side effect of a security migration.
-- Whoever restores that feature must re-add pg_net explicitly and re-answer the
-- exfiltration question above; the function failing loudly with "schema net does
-- not exist" is the intended reminder. See ADR 0011.
