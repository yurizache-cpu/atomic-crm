-- PRODUCTION SECURITY GATE A (2026-09-28): the repository-controlled database
-- half of what a hosted Company OS must satisfy before it could ever be
-- authorized for real clinic data. It enables nothing: PRODUCTION REAL-DATA
-- AUTHORIZATION stays CLOSED and REAL PATIENT MODEL TRAFFIC stays DISABLED.
--
-- 1. The PUBLIC helper debt (PHASE_2B_REPORT R-16, ADR 0018 amendment 3).
--    Since the CRM's first migration, 21 functions in `public` were executable
--    by PUBLIC, and explicitly by `anon`, so by every role, the Company OS
--    capability roles included. Each caller was traced (the report, §2):
--      - the six row-security helpers are called only by policies granted
--        `TO authenticated`, and by each other inside their own SECURITY
--        DEFINER bodies;
--      - get_avatar_for_email and get_domain_favicon are called only by the
--        SECURITY INVOKER triggers that stamp a contact's avatar and a
--        company's logo, so a role that writes contacts or companies needs
--        them (`authenticated`, and `service_role`, which keeps its explicit
--        grants: it is the backend trust root and bypasses row security,
--        SI-06);
--      - get_note_attachments_function_url is called only by a SECURITY
--        DEFINER trigger;
--      - public.merge_contacts(bigint, bigint) has no caller: the browser calls
--        the merge_contacts edge function, which merges through the sealed
--        owner-session pool as `authenticated` statement by statement (SI-27);
--      - the other eleven are trigger functions, which no role calls directly
--        and whose EXECUTE is never checked when they fire.
--    So PUBLIC and `anon` lose all 21; `authenticated` keeps exactly the eight
--    it needs. The declared intent (supabase/schemas/06_grants.sql) is the
--    same, and new functions in `public` already get no PUBLIC EXECUTE (the
--    `postgres` default privileges measured on 2026-09-28).
--
-- 2. Multi-factor assurance at the Company OS authority boundary. Every
--    company_os_api function resolves its caller through ONE resolver,
--    ops.operator_scope(). It now also requires the session to hold
--    authenticator assurance level 2, as the auth provider recorded it: both
--    the verified JWT's `aal` claim and the provider's own auth.sessions row
--    (`aal`), which a request cannot set. Anything less is refused as OS401:
--    the caller is not signed in at the required assurance. Every gate already
--    delivers OS401 unchanged, so no gate and no browser contract changes; the
--    browser learns WHY by asking the provider for its own session's level,
--    which only chooses the screen it shows. No browser value reaches the
--    check.
--
--    The explicit non-production path is an owner-recorded exemption row
--    (ops.operator_assurance_exemption). No migration creates it: only the local
--    development seed (supabase/seed.sql), which never reaches a hosted
--    project (SI-25), and the owner's own credential. A hosted project built
--    from migrations requires MFA from its first request.

-- ---------------------------------------------------------------------------
-- 1. The PUBLIC helper privileges.
-- ---------------------------------------------------------------------------

revoke execute on function public.can_access_contact(bigint) from public, anon;
revoke execute on function public.can_access_deal(bigint) from public, anon;
revoke execute on function public.can_manage_sales_id(bigint) from public, anon;
revoke execute on function public.current_sales_id() from public, anon;
revoke execute on function public.is_active_sales_user() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.get_avatar_for_email(text) from public, anon;
revoke execute on function public.get_domain_favicon(text) from public, anon;

revoke execute on function public.get_note_attachments_function_url() from public, anon, authenticated;
revoke execute on function public.merge_contacts(bigint, bigint) from public, anon, authenticated;

revoke execute on function public.cleanup_note_attachments() from public, anon, authenticated;
revoke execute on function public.create_lead_profile_for_contact() from public, anon, authenticated;
revoke execute on function public.handle_company_saved() from public, anon, authenticated;
revoke execute on function public.handle_contact_note_created_or_updated() from public, anon, authenticated;
revoke execute on function public.handle_contact_saved() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_update_user() from public, anon, authenticated;
revoke execute on function public.lowercase_email_jsonb() from public, anon, authenticated;
revoke execute on function public.set_lead_profile_updated_at() from public, anon, authenticated;
revoke execute on function public.set_sales_id_default() from public, anon, authenticated;
revoke execute on function public.synchronize_deal_pipeline() from public, anon, authenticated;

-- The row-security helpers and the two stamping helpers, for the one role whose
-- policies and triggers call them.
grant execute on function public.can_access_contact(bigint) to authenticated;
grant execute on function public.can_access_deal(bigint) to authenticated;
grant execute on function public.can_manage_sales_id(bigint) to authenticated;
grant execute on function public.current_sales_id() to authenticated;
grant execute on function public.is_active_sales_user() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.get_avatar_for_email(text) to authenticated;
grant execute on function public.get_domain_favicon(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The non-production assurance exemption: at most one row, owner-only.
-- ---------------------------------------------------------------------------

create table if not exists ops.operator_assurance_exemption (
  singleton   boolean primary key default true,
  reason      text not null,
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  constraint operator_assurance_exemption_singleton check (singleton),
  constraint operator_assurance_exemption_reason check (char_length(btrim(reason)) between 1 and 500),
  constraint operator_assurance_exemption_actor check (recorded_by ~ '^[\x21-\x7e][\x20-\x7e]{0,199}$')
);

comment on table ops.operator_assurance_exemption is
  'Production Security Gate A: while this one row exists, the Company OS accepts a session below authenticator assurance level 2. Local development and test only: no migration creates it; the development seed does, and it never reaches a hosted project (SI-25). A hosted project requires MFA.';

alter table ops.operator_assurance_exemption enable row level security;
alter table ops.operator_assurance_exemption force row level security;
revoke all on table ops.operator_assurance_exemption from public, anon, authenticated, service_role, ops_worker;

-- ---------------------------------------------------------------------------
-- 3. The resolver (20260922120000, section 5), with the assurance check after
--    the live session and the account, before any membership is read.
-- ---------------------------------------------------------------------------

create or replace function ops.operator_scope(
  out principal_id pg_catalog.uuid, out tenant_id pg_catalog.uuid, out role pg_catalog.text, out actor pg_catalog.text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  c_uuid   constant pg_catalog.text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_claims pg_catalog.jsonb;
  v_sub    pg_catalog.uuid;
  v_sid    pg_catalog.uuid;
  v_aal    pg_catalog.text;
  v_count  pg_catalog.int4;
begin
  begin
    v_claims := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb;
  exception when others then
    v_claims := null;
  end;
  if v_claims is null or pg_catalog.jsonb_typeof(v_claims) <> 'object'
     or (v_claims ->> 'role') is distinct from 'authenticated'
     or (v_claims ->> 'aud') is distinct from 'authenticated'
     or coalesce(v_claims ->> 'is_anonymous', 'false') <> 'false'
     or coalesce(v_claims ->> 'sub', '') !~ c_uuid
     or coalesce(v_claims ->> 'session_id', '') !~ c_uuid then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  v_sub := (v_claims ->> 'sub')::pg_catalog.uuid;
  v_sid := (v_claims ->> 'session_id')::pg_catalog.uuid;

  -- A live session: a sign-out or a revocation takes effect on the next call.
  select s.aal::pg_catalog.text into v_aal from auth.sessions s
   where s.id = v_sid and s.user_id = v_sub and (s.not_after is null or s.not_after > now());
  if not found then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  perform 1 from auth.users u
   where u.id = v_sub and u.deleted_at is null and u.is_anonymous is not true
     and (u.banned_until is null or u.banned_until <= now());
  if not found then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;

  -- Production Security Gate A: multi-factor assurance, as the provider
  -- recorded it on the session AND as the verified token states it; only an
  -- owner-recorded non-production exemption waives it.
  if not (coalesce(v_aal, '') in ('aal2', 'aal3')
          and coalesce(v_claims ->> 'aal', '') in ('aal2', 'aal3'))
     and not exists (select 1 from ops.operator_assurance_exemption) then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;

  select count(*) into v_count
    from ops.principals p
    join ops.tenant_memberships m on m.principal_id = p.id and m.principal_kind = p.kind
   where p.issuer = 'supabase_auth' and p.subject = v_sub and p.kind = 'human'
     and p.disabled_at is null and m.revoked_at is null;
  if v_count = 0 then
    raise exception using errcode = 'OS403', message = 'no access';
  elsif v_count > 1 then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;

  select p.id, m.tenant_id, m.role into principal_id, tenant_id, role
    from ops.principals p
    join ops.tenant_memberships m on m.principal_id = p.id and m.principal_kind = p.kind
   where p.issuer = 'supabase_auth' and p.subject = v_sub and p.kind = 'human'
     and p.disabled_at is null and m.revoked_at is null;
  if not ops.membership_tenant_eligible(tenant_id) then
    raise exception using errcode = 'OS403', message = 'no access';
  end if;
  actor := 'principal:' || principal_id::pg_catalog.text;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Assertions.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'Gate A: a public function is executable by PUBLIC or anon: %', v_bad;
  end if;

  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', '
                    order by p.proname || '(' || oidvectortypes(p.proargtypes) || ')') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_bad is distinct from
     'can_access_contact(bigint), can_access_deal(bigint), can_manage_sales_id(bigint), current_sales_id(), '
     || 'get_avatar_for_email(text), get_domain_favicon(text), is_active_sales_user(), is_admin()' then
    raise exception 'Gate A: authenticated executes other than the eight reviewed public functions: %', v_bad;
  end if;

  if exists (select 1 from ops.operator_assurance_exemption) then
    raise exception 'Gate A: a migration shipped the non-production assurance exemption';
  end if;
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a
              where c.oid = 'ops.operator_assurance_exemption'::regclass and a.grantee <> c.relowner) then
    raise exception 'Gate A: ops.operator_assurance_exemption is granted to a role';
  end if;
end
$$;
