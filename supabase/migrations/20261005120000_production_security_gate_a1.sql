-- PRODUCTION SECURITY GATE A.1 (2026-09-28): the two repository-controlled
-- gaps Gate A (20261004120000) left. It enables nothing: PRODUCTION REAL-DATA
-- AUTHORIZATION stays CLOSED and REAL PATIENT MODEL TRAFFIC stays DISABLED.
--
-- 1. No automatic third-party identity enrichment.
--    Saving a contact ran get_avatar_for_email(), which hashed the contact's
--    email with SHA-256 and asked Gravatar for it through extensions.http_get,
--    then fell back to the email's domain at favicon.show; saving a company ran
--    get_domain_favicon() on its website. That is database egress a browser
--    Content-Security-Policy cannot stop, and for a hosted clinic profile it
--    discloses a hash of every contact's email (and every company's website
--    domain) to a cosmetic provider. The application roles could not reach it
--    (USAGE on `extensions` was revoked from them, 20260911130000, so for them
--    the helper answered its error literal), but service_role could: the inbound
--    email path (Postmark) really did ask Gravatar. The two triggers and the
--    four functions are dropped, not merely revoked, so no role holds a
--    callable egress function and nothing replaces the provider. A stored
--    contact avatar or company logo is untouched; the interface already falls
--    back to initials and a default mark when none is stored.
--
-- 2. Multi-factor assurance on the CRM's real-data surface.
--    Gate A required authenticator assurance level 2 only at the Company OS's
--    resolver, ops.operator_scope(). The ordinary CRM screens read contacts,
--    companies, deals, notes, tasks, lead profiles and attributions through
--    PostgREST as `authenticated`, and every one of those row-security
--    policies decides through two helpers: public.current_sales_id() (via
--    is_active_sales_user(), can_manage_sales_id(), can_access_contact() and
--    can_access_deal()) or public.is_admin() alone (the owner-only writes and
--    the inbound-email ledger). The views are security_invoker, so they inherit.
--    Those two helpers are the one place every browser policy already passes
--    through, so the requirement lives there, once, and no policy changes:
--
--      permission = (the existing row rule) AND (assurance satisfied)
--
--    The assurance rule is ops.session_assurance_satisfied(), the same rule
--    ops.operator_scope() applies: the provider's own auth.sessions row AND the
--    verified token's `aal` claim are both aal2 or above, for the session and
--    user the claims name (a stale aal1 token, an ended session and a claim a
--    request made up all fail), unless the ONE owner-recorded non-production
--    exemption row exists (ops.operator_assurance_exemption, Gate A). No second
--    exemption exists and no migration inserts one: only the local development
--    seed does, and it never reaches a hosted project (SI-25).
--
--    The predicate cannot broaden anything: a session that passes it is still
--    judged by the same sales row, role, administrator flag and assignment as
--    before, so MFA never turns a non-admin into an admin, crosses a tenant or
--    reaches a row the policy did not.

-- ---------------------------------------------------------------------------
-- 1. Remove the automatic enrichment.
-- ---------------------------------------------------------------------------

-- Each stamping function goes with the one trigger that calls it: company_saved
-- on public.companies and "20_contact_saved" on public.contacts, and nothing
-- else depends on either (the assertions below and tests/crm_assurance.sql A2
-- name the triggers that remain). The trigger name "20_contact_saved" is a
-- quoted identifier the static migration guard cannot classify in a DROP
-- TRIGGER, so the functions are dropped with CASCADE, in public only.
drop function if exists public.handle_company_saved() cascade;
drop function if exists public.handle_contact_saved() cascade;
drop function if exists public.get_avatar_for_email(text);
drop function if exists public.get_domain_favicon(text);

-- ---------------------------------------------------------------------------
-- 2. The shared assurance predicate.
--    SECURITY DEFINER because it reads auth.sessions and the exemption row,
--    which no browser role may. Only the two row-security helpers below call
--    it, and they too are definers owned by the migration role; nobody else
--    holds EXECUTE, so it is not part of any role's callable surface.
-- ---------------------------------------------------------------------------

create or replace function ops.session_assurance_satisfied()
returns pg_catalog.bool
language plpgsql stable security definer set search_path = '' as $$
declare
  c_uuid   constant pg_catalog.text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_claims pg_catalog.jsonb;
  v_sub    pg_catalog.uuid;
  v_sid    pg_catalog.uuid;
  v_aal    pg_catalog.text;
begin
  begin
    v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb;
  exception when others then
    v_claims := null;
  end;

  if v_claims is not null and pg_catalog.jsonb_typeof(v_claims) = 'object'
     and coalesce(v_claims ->> 'sub', '') ~ c_uuid
     and coalesce(v_claims ->> 'session_id', '') ~ c_uuid then
    v_sub := (v_claims ->> 'sub')::pg_catalog.uuid;
    v_sid := (v_claims ->> 'session_id')::pg_catalog.uuid;
    -- The row-security helpers read the caller through auth.uid(): the level
    -- must belong to that very user, never to another the claims also name.
    if v_sub is not distinct from auth.uid() then
      select s.aal::pg_catalog.text into v_aal from auth.sessions s
       where s.id = v_sid and s.user_id = v_sub and (s.not_after is null or s.not_after > now());
      if found and coalesce(v_aal, '') in ('aal2', 'aal3')
         and coalesce(v_claims ->> 'aal', '') in ('aal2', 'aal3') then
        return true;
      end if;
    end if;
  end if;

  -- Only an owner-recorded non-production exemption waives the level.
  return exists (select 1 from ops.operator_assurance_exemption);
end
$$;

revoke all on function ops.session_assurance_satisfied() from public;
revoke all on function ops.session_assurance_satisfied() from anon, authenticated, service_role;

comment on function ops.session_assurance_satisfied() is
  'Production Security Gate A.1: true when the session named by the verified claims holds authenticator assurance level 2 or above on both the provider''s session row and the token, or the one non-production exemption exists. Called by public.current_sales_id() and public.is_admin(), through which every browser row-security policy decides.';

-- ---------------------------------------------------------------------------
-- 3. The two row-security roots (bodies as pg_dump prints them, see
--    supabase/schemas/02_functions.sql), each with the assurance rule added.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."current_sales_id"() RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    select s.id
    from public.sales s
    where s.user_id = auth.uid()
      and s.disabled = false
      and ops.session_assurance_satisfied()
    limit 1;
    $$;

CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  return exists (
    select 1
    from public.sales
    where user_id = auth.uid()
      and administrator = true
      and role = 'owner'
      and disabled = false
      and ops.session_assurance_satisfied()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Assertions.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- The enrichment is gone: no trigger, no function, and no function in
  -- public that names a third-party avatar or favicon lookup.
  if exists (select 1 from pg_trigger t
              where not t.tgisinternal
                and t.tgname in ('company_saved', '20_contact_saved')
                and t.tgrelid in ('public.contacts'::regclass, 'public.companies'::regclass)) then
    raise exception 'Gate A.1: an enrichment trigger is still installed';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname in ('get_avatar_for_email', 'get_domain_favicon', 'handle_contact_saved', 'handle_company_saved')
          or p.prosrc ~* '(gravatar\.com|favicon\.show|extensions\.http_)');
  if v_bad is not null then
    raise exception 'Gate A.1: a public function still performs or names a third-party lookup: %', v_bad;
  end if;

  -- PUBLIC and anon execute nothing in public, and authenticated exactly the
  -- six row-security helpers.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'Gate A.1: a public function is executable by PUBLIC or anon: %', v_bad;
  end if;
  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', '
                    order by p.proname || '(' || oidvectortypes(p.proargtypes) || ')') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_bad is distinct from
     'can_access_contact(bigint), can_access_deal(bigint), can_manage_sales_id(bigint), current_sales_id(), '
     || 'is_active_sales_user(), is_admin()' then
    raise exception 'Gate A.1: authenticated executes other than the six reviewed row-security helpers: %', v_bad;
  end if;

  -- The predicate is nobody's callable surface, and both roots call it.
  select string_agg(r.rolname, ', ') into v_bad
    from pg_roles r
   where r.rolname in ('anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api')
     and has_function_privilege(r.rolname, 'ops.session_assurance_satisfied()', 'EXECUTE');
  if v_bad is not null then
    raise exception 'Gate A.1: the assurance predicate is executable by %', v_bad;
  end if;
  if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
              where p.oid = 'ops.session_assurance_satisfied()'::regprocedure
                and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'Gate A.1: the assurance predicate is executable by PUBLIC';
  end if;
  if pg_get_functiondef('public.current_sales_id()'::regprocedure) !~ 'ops\.session_assurance_satisfied\(\)'
     or pg_get_functiondef('public.is_admin()'::regprocedure) !~ 'ops\.session_assurance_satisfied\(\)' then
    raise exception 'Gate A.1: a row-security root does not require multi-factor assurance';
  end if;
end
$$;
