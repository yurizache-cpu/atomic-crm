-- Phase 2C (S2): the Company OS operator surface, read-only.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_2C_BRIEF.md §7-§13, ADR 0019):
--
--   1. ops.principals and ops.tenant_memberships: an explicit human principal
--      keyed to the Supabase Auth user id (never an email), and a
--      tenant-generic membership. Immutable bindings, FORCE RLS, no policy, no
--      grant. Written only by the owner services ops.grant_membership and
--      ops.revoke_membership, which only the owner CLI calls.
--   2. ops.membership_tenant_eligible: the ONE Phase 2C eligibility predicate
--      (the tenant that owns the local CRM). A temporary policy, not a data
--      model constraint.
--   3. ops.operator_scope(): the resolver. The ONLY source of a browser
--      caller's tenant and actor: verified PostgREST claims, a live session, an
--      unbanned auth user, an enabled human principal, exactly one active,
--      eligible membership.
--   4. Minimised, tenant-scoped read projections (ops.read_*,
--      ops.agent_operational_state): explicit column lists, every emitted
--      reference classified, no raw actor label, no body, number, draft,
--      secret, global sequence value or platform identifier.
--   5. One identity gate per operation (ops.gate_<op>): resolver first, one
--      pinned callee, no-store, fixed data-free errors.
--   6. ops_operator_api: a NOLOGIN capability role that owns the exposed
--      functions and can execute only the gates.
--   7. company_os_api: a function-only schema of 15 read RPCs, each exactly one
--      call to its gate, executable only by authenticated.
--
-- WHAT IT DELIBERATELY DOES NOT DO: create either browser mutation
-- (decide_review, trip_stop: S8, after the S7 prerequisite), expose ops, grant
-- any application role anything on ops, read an email on the browser path,
-- accept a tenant, company, actor or reviewer from a caller, or read or write
-- anything in schema public.
--
-- OD-8a (brief §7.6; owner decisions S0-E, S0-F): this file is one of the two
-- exact, allowlisted migrations. It runs the whole lifecycle itself, in one
-- transaction: (1) assert the measured migration identity; (2) grant the
-- capability role to that literal identity; (3) grant CREATE on
-- company_os_api to the role; (4) transfer ownership of exactly the catalogued
-- functions it creates, ACLs set first; (5) revoke CREATE; (6) revoke the
-- membership; (7) assert the end state. The trusted migration owner can still
-- drop and recreate a function it no longer owns (it owns the schema): the
-- static migration guard and the live pins, not PostgreSQL, stop that.

-- ---------------------------------------------------------------------------
-- 1. The measured migration identity, and one transaction.
-- ---------------------------------------------------------------------------

do $identity$
begin
  if current_user <> 'postgres' or session_user <> 'postgres' then
    raise exception 'company_os_read_surface: must run as the measured migration identity postgres, not %/%',
      current_user, session_user;
  end if;
  -- Local to this transaction: the end-state assertion (section 12) reads it
  -- back, so a migration applied statement by statement, in autocommit, fails.
  perform pg_catalog.set_config('company_os.migration_txid', pg_catalog.txid_current()::pg_catalog.text, true);
end
$identity$;

-- ---------------------------------------------------------------------------
-- 2. Principals and memberships.
-- ---------------------------------------------------------------------------

create table ops.principals (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  issuer       text not null,
  subject      uuid not null,
  display_name text not null,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz,
  disabled_by  text,
  constraint principals_kind_check check (kind in ('human', 'agent', 'service')),
  constraint principals_issuer_format check (issuer ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  -- An owner-typed label, never an identifier: no '@', so no command can print
  -- an email-shaped label, and no control or format character.
  constraint principals_display_name_format check (
    char_length(display_name) between 1 and 200
    and position('@' in display_name) = 0
    and display_name !~ '[\u0001-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁯﻿]'),
  constraint principals_created_by_format check (created_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint principals_disabled_pair check ((disabled_at is null) = (disabled_by is null)),
  constraint principals_disabled_by_format check (disabled_by is null or disabled_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint principals_identity_key unique (issuer, subject),
  constraint principals_id_kind_key unique (id, kind)
);

create table ops.tenant_memberships (
  id                    uuid primary key default gen_random_uuid(),
  principal_id          uuid not null,
  principal_kind        text not null default 'human',
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  role                  text not null default 'tenant_operator',
  email_at_grant_sha256 text not null,
  granted_by            text not null,
  grant_reason          text not null,
  granted_at            timestamptz not null default now(),
  revoked_by            text,
  revoke_reason         text,
  revoked_at            timestamptz,
  constraint tenant_memberships_human_only check (principal_kind = 'human'),
  constraint tenant_memberships_role_check check (role = 'tenant_operator'),
  constraint tenant_memberships_email_hash_format check (email_at_grant_sha256 ~ '^[0-9a-f]{64}$'),
  constraint tenant_memberships_granted_by_format check (granted_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint tenant_memberships_grant_reason_format check (
    char_length(grant_reason) between 1 and 500
    and grant_reason !~ '[\u0001-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁯﻿]'),
  constraint tenant_memberships_revoke_triple check (
    (revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null)),
  constraint tenant_memberships_revoked_by_format check (revoked_by is null or revoked_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint tenant_memberships_revoke_reason_format check (
    revoke_reason is null or (char_length(revoke_reason) between 1 and 500
    and revoke_reason !~ '[\u0001-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁯﻿]')),
  constraint tenant_memberships_principal_fkey foreign key (principal_id, principal_kind)
    references ops.principals (id, kind) on delete restrict
);

-- One active membership per person in Phase 2C: a Phase 2C limit, not a
-- property of the tenant-generic model (brief §7.4).
create unique index tenant_memberships_one_active on ops.tenant_memberships (principal_id) where revoked_at is null;
create index tenant_memberships_tenant on ops.tenant_memberships (tenant_id);

alter table ops.principals enable row level security;
alter table ops.principals force row level security;
alter table ops.tenant_memberships enable row level security;
alter table ops.tenant_memberships force row level security;
revoke all on table ops.principals, ops.tenant_memberships
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 3. The bindings are immutable (ENABLE ALWAYS).
-- ---------------------------------------------------------------------------

create function ops.guard_principal_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS403', message = 'ops.principals: a principal is never deleted';
  end if;
  if new.id is distinct from old.id or new.kind is distinct from old.kind
     or new.issuer is distinct from old.issuer or new.subject is distinct from old.subject
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'OS403', message = 'ops.principals: a principal''s identity is immutable';
  end if;
  if old.disabled_at is not null
     and (new.disabled_at is distinct from old.disabled_at or new.disabled_by is distinct from old.disabled_by) then
    raise exception using errcode = 'OS409', message = 'ops.principals: a disable is recorded once';
  end if;
  return new;
end
$$;

create function ops.guard_membership_change() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS403', message = 'ops.tenant_memberships: a membership is never deleted';
  end if;
  if new.id is distinct from old.id or new.principal_id is distinct from old.principal_id
     or new.principal_kind is distinct from old.principal_kind or new.tenant_id is distinct from old.tenant_id
     or new.role is distinct from old.role or new.email_at_grant_sha256 is distinct from old.email_at_grant_sha256
     or new.granted_by is distinct from old.granted_by or new.grant_reason is distinct from old.grant_reason
     or new.granted_at is distinct from old.granted_at then
    raise exception using errcode = 'OS403', message = 'ops.tenant_memberships: a grant is immutable';
  end if;
  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by
          or new.revoke_reason is distinct from old.revoke_reason) then
    raise exception using errcode = 'OS409', message = 'ops.tenant_memberships: a revocation is recorded once';
  end if;
  return new;
end
$$;

create function ops.refuse_identity_truncate() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'OS403', message = format('ops.%s: rows are never removed', tg_table_name);
end
$$;

create trigger principals_guard_change before update or delete on ops.principals
  for each row execute function ops.guard_principal_change();
create trigger principals_refuse_truncate before truncate on ops.principals
  for each statement execute function ops.refuse_identity_truncate();
create trigger tenant_memberships_guard_change before update or delete on ops.tenant_memberships
  for each row execute function ops.guard_membership_change();
create trigger tenant_memberships_refuse_truncate before truncate on ops.tenant_memberships
  for each statement execute function ops.refuse_identity_truncate();
alter table ops.principals enable always trigger principals_guard_change;
alter table ops.principals enable always trigger principals_refuse_truncate;
alter table ops.tenant_memberships enable always trigger tenant_memberships_guard_change;
alter table ops.tenant_memberships enable always trigger tenant_memberships_refuse_truncate;

-- ---------------------------------------------------------------------------
-- 4. The Phase 2C eligibility policy, and the owner membership services.
-- ---------------------------------------------------------------------------

-- The ONE place Phase 2C reads owns_local_crm (brief §7.4). Lifting the policy
-- changes this predicate only.
create function ops.membership_tenant_eligible(p_tenant_id pg_catalog.uuid) returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select coalesce((select t.owns_local_crm from ops.tenants t where t.id = p_tenant_id), false);
$$;

-- Owner only. Takes the auth user id, never an email; reads auth.users only.
create function ops.grant_membership(
  p_tenant_id pg_catalog.uuid, p_auth_user_id pg_catalog.uuid, p_display_name pg_catalog.text,
  p_actor pg_catalog.text, p_reason pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_email     pg_catalog.text;
  v_principal pg_catalog.uuid;
  v_active    ops.tenant_memberships;
  v_id        pg_catalog.uuid;
begin
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'
     or p_actor like 'system:%' or p_actor like 'principal:%' then
    raise exception using errcode = 'OS400', message = 'ops.grant_membership: the actor is missing or malformed';
  end if;
  if p_tenant_id is null or p_auth_user_id is null or p_display_name is null or p_reason is null then
    raise exception using errcode = 'OS400', message = 'ops.grant_membership: tenant, auth user, display name and reason are required';
  end if;
  perform 1 from ops.tenants t where t.id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.grant_membership: tenant not found';
  end if;
  if not ops.membership_tenant_eligible(p_tenant_id) then
    raise exception using errcode = 'OS403',
      message = 'ops.grant_membership: in Phase 2C only the tenant that owns the local CRM is eligible';
  end if;
  select u.email into v_email
    from auth.users u
   where u.id = p_auth_user_id
     and u.email_confirmed_at is not null
     and u.deleted_at is null
     and (u.banned_until is null or u.banned_until <= now());
  if not found or v_email is null then
    raise exception using errcode = 'OS404', message = 'ops.grant_membership: the auth user is missing, unconfirmed, banned or deleted';
  end if;

  insert into ops.principals (kind, issuer, subject, display_name, created_by)
  values ('human', 'supabase_auth', p_auth_user_id, p_display_name, p_actor)
  on conflict (issuer, subject) do nothing
  returning id into v_principal;
  if v_principal is null then
    select p.id into v_principal from ops.principals p
     where p.issuer = 'supabase_auth' and p.subject = p_auth_user_id and p.kind = 'human';
    if v_principal is null then
      raise exception using errcode = 'OS409', message = 'ops.grant_membership: that subject is not a human principal';
    end if;
  end if;

  select * into v_active from ops.tenant_memberships m where m.principal_id = v_principal and m.revoked_at is null;
  if found then
    if v_active.tenant_id = p_tenant_id then
      return pg_catalog.jsonb_build_object('principalId', v_principal, 'membershipId', v_active.id, 'recorded', false);
    end if;
    raise exception using errcode = 'OS409', message = 'ops.grant_membership: the principal already has an active membership';
  end if;

  insert into ops.tenant_memberships (principal_id, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
  values (v_principal, p_tenant_id,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(v_email), 'UTF8')), 'hex'),
          p_actor, p_reason)
  returning id into v_id;
  return pg_catalog.jsonb_build_object('principalId', v_principal, 'membershipId', v_id, 'recorded', true);
end
$$;

-- Owner only. The Company OS off-switch for one person; effective on the next call.
create function ops.revoke_membership(p_membership_id pg_catalog.uuid, p_actor pg_catalog.text, p_reason pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_row ops.tenant_memberships;
begin
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'
     or p_actor like 'system:%' or p_actor like 'principal:%' then
    raise exception using errcode = 'OS400', message = 'ops.revoke_membership: the actor is missing or malformed';
  end if;
  if p_membership_id is null or p_reason is null then
    raise exception using errcode = 'OS400', message = 'ops.revoke_membership: membership and reason are required';
  end if;
  select * into v_row from ops.tenant_memberships m where m.id = p_membership_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.revoke_membership: membership not found';
  end if;
  if v_row.revoked_at is not null then
    return pg_catalog.jsonb_build_object('membershipId', v_row.id, 'revoked', false);
  end if;
  update ops.tenant_memberships
     set revoked_at = now(), revoked_by = p_actor, revoke_reason = p_reason
   where id = p_membership_id;
  return pg_catalog.jsonb_build_object('membershipId', v_row.id, 'revoked', true);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The resolver.
-- ---------------------------------------------------------------------------

-- STABLE, never IMMUTABLE: an IMMUTABLE call with no argument could be folded
-- at plan time and outlive a pooled request. It reads the claims JSON that
-- PostgREST sets after verifying the JWT, not auth.uid(), which prefers the
-- legacy per-claim setting the sealed merge_contacts pool uses.
create function ops.operator_scope(
  out principal_id pg_catalog.uuid, out tenant_id pg_catalog.uuid, out role pg_catalog.text, out actor pg_catalog.text)
language plpgsql stable security invoker set search_path = '' as $$
declare
  c_uuid   constant pg_catalog.text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_claims pg_catalog.jsonb;
  v_sub    pg_catalog.uuid;
  v_sid    pg_catalog.uuid;
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
  perform 1 from auth.sessions s
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
-- 6. Projection helpers. Every one is owner-only and STABLE or IMMUTABLE.
-- ---------------------------------------------------------------------------

-- A timestamp as the browser receives it: UTC, microseconds, 'Z'.
create function ops.cos_ts(p_at pg_catalog.timestamptz) returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select pg_catalog.to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

-- Money: bigint micros as a string, and USD with exactly six decimals, both
-- computed here; the browser does no arithmetic.
create function ops.cos_money(p_micros pg_catalog.int8) returns pg_catalog.jsonb
language sql immutable security invoker set search_path = '' as $$
  select case when p_micros is null then null else pg_catalog.jsonb_build_object(
    'micros', p_micros::pg_catalog.text,
    'usd', case when p_micros < 0 then '-' else '' end
           || (pg_catalog.abs(p_micros) / 1000000)::pg_catalog.text || '.'
           || pg_catalog.lpad((pg_catalog.abs(p_micros) % 1000000)::pg_catalog.text, 6, '0')) end;
$$;

-- An opaque cursor '<kind>1:<uuid>'. Anything else is the one data-free OS400.
create function ops.cos_cursor(p_cursor pg_catalog.text, p_kind pg_catalog.text) returns pg_catalog.uuid
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_cursor is null then
    return null;
  end if;
  if p_cursor !~ ('^' || p_kind || '1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception using errcode = 'OS400', message = 'restart from the first page';
  end if;
  return pg_catalog.substr(p_cursor, pg_catalog.char_length(p_kind) + 3)::pg_catalog.uuid;
end
$$;

create function ops.cos_limit(p_limit pg_catalog.int4) returns pg_catalog.int4
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_limit is null then
    return 50;
  end if;
  if p_limit < 1 or p_limit > 100 then
    raise exception using errcode = 'OS400', message = 'limit out of range';
  end if;
  return p_limit;
end
$$;

-- Reference classification (brief §7.4): a row id leaves only when the row
-- belongs to the caller's tenant; a platform-scoped row (tenant_id null) or a
-- dangling id leaves as null; a row of another tenant is an internal error
-- (OS500), never data. One explicit query per kind: no dynamic SQL.
create function ops.cos_ref_id(p_tenant pg_catalog.uuid, p_kind pg_catalog.text, p_id pg_catalog.uuid)
returns pg_catalog.uuid
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_tenant pg_catalog.uuid;
  v_found  pg_catalog.bool := false;
begin
  if p_id is null then
    return null;
  end if;
  case p_kind
    when 'task' then select t.tenant_id, true into v_tenant, v_found from ops.tasks t where t.id = p_id;
    when 'agent_run' then select r.tenant_id, true into v_tenant, v_found from ops.agent_runs r where r.id = p_id;
    when 'review_item' then select r.tenant_id, true into v_tenant, v_found from ops.review_items r where r.id = p_id;
    when 'outbound_message' then select o.tenant_id, true into v_tenant, v_found from ops.outbound_messages o where o.id = p_id;
    when 'company' then select c.tenant_id, true into v_tenant, v_found from ops.companies c where c.id = p_id;
    when 'department' then select d.tenant_id, true into v_tenant, v_found from ops.departments d where d.id = p_id;
    when 'agent' then select a.tenant_id, true into v_tenant, v_found from ops.agents a where a.id = p_id;
    when 'channel' then select c.tenant_id, true into v_tenant, v_found from ops.communication_channels c where c.id = p_id;
    when 'conversation' then select c.tenant_id, true into v_tenant, v_found from ops.conversations c where c.id = p_id;
    when 'event' then select e.tenant_id, true into v_tenant, v_found from ops.events e where e.id = p_id;
    when 'stop' then select s.tenant_id, true into v_tenant, v_found from ops.execution_stops s where s.id = p_id;
    when 'spend_limit' then select l.tenant_id, true into v_tenant, v_found from ops.spend_limits l where l.id = p_id;
    else
      return null;
  end case;
  if not v_found or v_tenant is null then
    return null;
  end if;
  if v_tenant <> p_tenant then
    raise exception using errcode = 'OS500', message = 'foreign reference';
  end if;
  return p_id;
end
$$;

create function ops.cos_ref(p_tenant pg_catalog.uuid, p_kind pg_catalog.text, p_id pg_catalog.uuid)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select case when ops.cos_ref_id(p_tenant, p_kind, p_id) is null then null
              else pg_catalog.jsonb_build_object('id', p_id) end;
$$;

-- A stop naming the tenant, as {id, scope, origin}; a platform stop is null.
create function ops.cos_stop(p_tenant pg_catalog.uuid, p_stop pg_catalog.uuid) returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select case when ops.cos_ref_id(p_tenant, 'stop', p_stop) is null then null
              else (select pg_catalog.jsonb_build_object('id', s.id, 'scope', s.scope, 'origin', s.origin)
                      from ops.execution_stops s where s.id = p_stop) end;
$$;

-- The earliest active stop NAMING the tenant that covers work of this kind at
-- these coordinates. ops.covering_execution_stop returns a platform stop
-- first, which would mask the tenant's own stop (S0 finding); this reads only
-- stops whose tenant_id is the caller's.
create function ops.cos_tenant_covering_stop(
  p_tenant pg_catalog.uuid, p_kind pg_catalog.text, p_company pg_catalog.uuid,
  p_department pg_catalog.uuid, p_agent pg_catalog.uuid)
returns pg_catalog.uuid
language sql stable security invoker set search_path = '' as $$
  select s.id from ops.execution_stops s
   where s.tenant_id = p_tenant and s.cleared_at is null
     and ops.execution_stop_covers(s.scope, s.tenant_id, s.company_id, s.department_id, s.agent_id, s.job_kind,
                                   p_tenant, p_kind, p_company, p_department, p_agent)
   order by s.tripped_at, s.id
   limit 1;
$$;

-- The ONE platform-derived field (brief §9, OD-7).
create function ops.cos_global_admission_blocked() returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from ops.execution_stops s
                  where s.cleared_at is null and s.tenant_id is null
                    and (s.scope = 'global' or (s.scope = 'job_kind' and s.job_kind = 'agent_run.execute')))
      or exists (select 1 from ops.spend_status() x where x.scope = 'global' and x.new_run_admission = 'blocked');
$$;

-- The start of "today" for a tenant: its budget's spend window, else UTC.
create function ops.cos_today_start(p_tenant pg_catalog.uuid) returns pg_catalog.timestamptz
language sql stable security invoker set search_path = '' as $$
  select ops.spend_window_start(
    coalesce((select l.timezone from ops.spend_limits l
               where l.scope = 'tenant' and l.tenant_id = p_tenant and l.ended_at is null
               order by l.set_at desc limit 1), 'UTC'),
    now());
$$;

-- An event's source: a pinned provenance label, or 'other' (events.source is
-- caller-supplied; measured at implementation from migrations and engine).
-- 'company-os-ui' has no writer yet: brief §7.4 and §9 name it as the source
-- of the two browser acts, which only the S8 gates will write.
create function ops.cos_event_source(p_source pg_catalog.text) returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case when p_source in ('agent-runtime', 'agent-runtime-smoke', 'company-os-ui', 'lead-triage-demo',
                                'operator-cli', 'seed', 'whatsapp-gateway')
              then p_source else 'other' end;
$$;

-- The event types the migrations emit. A type outside this set gets {} and
-- factsWithheld; supabase/tests/companyOsEventAllowlist.test.ts fails when a
-- migration emits a type missing here.
create function ops.cos_event_known(p_type pg_catalog.text) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select p_type in (
    'company.created', 'company.status_changed', 'department.created', 'department.status_changed',
    'agent.created', 'agent.status_changed',
    'task.created', 'task.assigned', 'task.status_changed', 'task.completed', 'task.failed', 'task.cancelled',
    'task.execution_requested',
    'agent_run.requested', 'agent_run.started', 'agent_run.succeeded', 'agent_run.failed',
    'agent_run.indeterminate', 'agent_run.cancelled',
    'lead_triage.admitted', 'lead_triage.review_pending', 'lead_triage.reviewed',
    'communication.received', 'communication.inbound_refused', 'communication.inbound_held',
    'communication.channel_configured', 'communication.outbound_authorized', 'communication.outbound_attempted',
    'communication.outbound_blocked', 'communication.outbound_sent', 'communication.outbound_failed',
    'communication.outbound_indeterminate', 'communication.delivery_updated');
$$;

-- The payload keys that may leave, per type (deny by default, brief §11).
-- Every id is classified; an enum-shaped value must match its format.
create function ops.cos_event_facts(p_tenant pg_catalog.uuid, p_type pg_catalog.text, p_payload pg_catalog.jsonb)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select case
    when p_type = 'lead_triage.reviewed' then
      pg_catalog.jsonb_build_object('decision', case when p_payload ->> 'decision' in ('accepted', 'rejected', 'needs_edit')
                                                      then p_payload ->> 'decision' end)
    when p_type in ('company.status_changed', 'department.status_changed', 'agent.status_changed',
                    'task.status_changed', 'task.completed', 'task.failed', 'task.cancelled', 'task.assigned',
                    'agent_run.started', 'agent_run.succeeded', 'agent_run.failed',
                    'agent_run.indeterminate', 'agent_run.cancelled') then
      pg_catalog.jsonb_build_object(
        'from_status', case when p_payload ->> 'from_status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'from_status' end,
        'to_status', case when p_payload ->> 'to_status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'to_status' end)
    when p_type in ('communication.inbound_refused', 'communication.inbound_held') then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid),
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    when p_type = 'communication.channel_configured' then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid),
        'mode', case when p_payload ->> 'mode' in ('test', 'production') then p_payload ->> 'mode' end,
        'active', case when pg_catalog.jsonb_typeof(p_payload -> 'active') = 'boolean' then p_payload -> 'active' end)
    when p_type = 'communication.outbound_authorized' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'review_item_id', ops.cos_ref_id(p_tenant, 'review_item', nullif(p_payload ->> 'review_item_id', '')::pg_catalog.uuid))
    when p_type = 'communication.outbound_blocked' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    when p_type in ('communication.outbound_attempted', 'communication.outbound_sent', 'communication.outbound_failed',
                    'communication.outbound_indeterminate') then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid))
    when p_type = 'communication.delivery_updated' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'status', case when p_payload ->> 'status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'status' end,
        'previous', case when p_payload ->> 'previous' ~ '^[a-z_]{1,32}$' then p_payload ->> 'previous' end)
    else '{}'::pg_catalog.jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Summaries shared by several projections.
-- ---------------------------------------------------------------------------

create function ops.cos_run_summary(p_tenant pg_catalog.uuid, r ops.agent_runs, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', r.id, 'companyId', r.company_id, 'taskId', r.task_id, 'agentId', r.agent_id,
    'retryOfRunId', ops.cos_ref_id(p_tenant, 'agent_run', r.retry_of_run_id),
    'capability', r.capability, 'modelRoute', r.model_route, 'status', r.status,
    'errorCategory', r.error_category, 'errorCode', r.error_code,
    'provider', r.provider, 'model', r.model, 'responseModel', r.response_model,
    'inputTokens', r.input_tokens, 'outputTokens', r.output_tokens, 'totalTokens', r.total_tokens,
    'cachedInputTokens', r.cached_input_tokens, 'reasoningTokens', r.reasoning_tokens,
    'latencyMs', r.latency_ms, 'jobAttempt', r.job_attempt,
    'reservedCost', ops.cos_money(r.reserved_cost_micros),
    'estimatedCost', ops.cos_money(r.estimated_cost_micros),
    'chargedCost', ops.cos_money(r.charged_cost_micros),
    'createdAt', ops.cos_ts(r.created_at), 'startedAt', ops.cos_ts(r.started_at),
    'completedAt', ops.cos_ts(r.completed_at),
    'attention', case
      when r.status = 'indeterminate'
           and not exists (select 1 from ops.agent_runs x where x.tenant_id = p_tenant and x.retry_of_run_id = r.id)
        then 'indeterminate_not_retried'
      when r.status = 'running'
           and not exists (select 1 from ops.jobs j
                            where j.tenant_id = p_tenant and j.id = r.job_id and j.status = 'leased'
                              and j.lease_expires_at > p_as_of and j.attempts = r.job_attempt)
        then 'running_without_live_lease'
    end,
    'stopRef', ops.cos_ref(p_tenant, 'stop', r.stop_id),
    'spendLimitRef', case when ops.cos_ref_id(p_tenant, 'spend_limit', r.spend_limit_id) is null then null
                          else (select pg_catalog.jsonb_build_object('id', l.id, 'scope', l.scope)
                                  from ops.spend_limits l where l.id = r.spend_limit_id) end);
$$;

create function ops.cos_review_summary(p_tenant pg_catalog.uuid, r ops.review_items) returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', r.id, 'taskId', r.task_id, 'agentRunId', ops.cos_ref_id(p_tenant, 'agent_run', r.agent_run_id),
    'capability', r.capability, 'status', r.status, 'doNotContact', r.do_not_contact,
    'reviewedAt', ops.cos_ts(r.reviewed_at), 'createdAt', ops.cos_ts(r.created_at),
    'hasNote', r.decision_note is not null,
    'outboundStatus', (select o.status from ops.outbound_messages o
                        where o.tenant_id = p_tenant and o.review_item_id = r.id
                        order by o.created_at desc, o.id desc limit 1));
$$;

create function ops.cos_outbound_summary(p_tenant pg_catalog.uuid, o ops.outbound_messages) returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', o.id, 'status', o.status, 'reviewItemId', ops.cos_ref_id(p_tenant, 'review_item', o.review_item_id),
    'taskId', o.task_id, 'channelId', ops.cos_ref_id(p_tenant, 'channel', o.channel_id),
    'blockedReason', o.blocked_reason, 'errorClass', o.error_class, 'errorCode', o.error_code,
    'authorizedAt', ops.cos_ts(o.authorized_at), 'sendingAt', ops.cos_ts(o.sending_at),
    'settledAt', ops.cos_ts(o.settled_at), 'deliveredAt', ops.cos_ts(o.delivered_at),
    'readAt', ops.cos_ts(o.read_at));
$$;

create function ops.cos_task_summary(p_tenant pg_catalog.uuid, t ops.tasks) returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', t.id, 'type', t.type, 'lifecycleStatus', t.status, 'priority', t.priority,
    'dueAt', ops.cos_ts(t.due_at), 'createdAt', ops.cos_ts(t.created_at),
    'company', (select pg_catalog.jsonb_build_object('id', c.id, 'name', c.name)
                  from ops.companies c where c.tenant_id = p_tenant and c.id = t.company_id),
    'department', (select pg_catalog.jsonb_build_object('id', d.id, 'name', d.name)
                     from ops.departments d where d.tenant_id = p_tenant and d.id = t.department_id),
    'assignedAgent', (select pg_catalog.jsonb_build_object('id', a.id, 'name', a.name)
                        from ops.agents a where a.tenant_id = p_tenant and a.id = t.assigned_agent_id),
    'pipeline', pg_catalog.jsonb_build_object(
      'latestRun', (select pg_catalog.jsonb_build_object('id', r.id, 'status', r.status)
                      from ops.agent_runs r where r.tenant_id = p_tenant and r.task_id = t.id
                      order by r.created_at desc, r.id desc limit 1),
      'review', (select pg_catalog.jsonb_build_object('id', v.id, 'status', v.status)
                   from ops.review_items v where v.tenant_id = p_tenant and v.task_id = t.id
                   order by v.created_at desc, v.id desc limit 1),
      'outbound', (select pg_catalog.jsonb_build_object('id', o.id, 'status', o.status)
                     from ops.outbound_messages o where o.tenant_id = p_tenant and o.task_id = t.id
                     order by o.created_at desc, o.id desc limit 1)));
$$;

create function ops.cos_event_summary(p_tenant pg_catalog.uuid, e ops.events) returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', e.id, 'type', e.type, 'source', ops.cos_event_source(e.source),
    'subjectType', e.subject_type,
    'subjectId', case when e.subject_type in ('task', 'agent_run', 'company', 'department', 'agent')
                      then ops.cos_ref_id(p_tenant, e.subject_type, e.subject_id) end,
    'causationId', ops.cos_ref_id(p_tenant, 'event', e.causation_id),
    'createdAt', ops.cos_ts(e.created_at),
    'facts', ops.cos_event_facts(p_tenant, e.type, e.payload),
    'factsWithheld', not ops.cos_event_known(e.type));
$$;

-- ---------------------------------------------------------------------------
-- 8. The L2 read projections (brief §9-§11).
-- ---------------------------------------------------------------------------

create function ops.read_operator_context(p_tenant_id pg_catalog.uuid, p_principal_id pg_catalog.uuid, p_role pg_catalog.text)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()),
    'principal', pg_catalog.jsonb_build_object('id', p_principal_id),
    'tenant', (select pg_catalog.jsonb_build_object('id', t.id, 'name', t.name) from ops.tenants t where t.id = p_tenant_id),
    'role', p_role,
    'dataPolicy', 'synthetic_or_test_only',
    -- Both acts are false while their functions do not exist (S7, S8).
    'allowedActions', pg_catalog.jsonb_build_object('decideReview', false, 'tripStop', false, 'viewAdvice', true),
    'serverTime', ops.cos_ts(pg_catalog.clock_timestamp()));
$$;

-- Agent state (brief §10): two axes plus attention, computed from facts at one
-- instant; "working" only with a live lease and the run's id as evidence.
-- p_agent_id narrows the agents BEFORE the list cap, so one agent's state is
-- computed wherever it sorts; null lists the first 500 by name (brief §8 row 3).
-- p_every_agent lifts the cap for the overview's counts, which must be exact
-- however many agents the tenant has; list_agents never passes it.
create function ops.agent_operational_state(p_tenant_id pg_catalog.uuid, p_agent_id pg_catalog.uuid default null,
                                            p_every_agent pg_catalog.bool default false)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_items pg_catalog.jsonb;
begin
  with a as (
    select ag.id, ag.slug, ag.name, ag.status, ag.company_id, ag.department_id,
           co.name as company_name, co.status as company_status, d.name as department_name, d.status as department_status,
           ops.cos_tenant_covering_stop(p_tenant_id, 'agent_run.execute', ag.company_id, ag.department_id, ag.id) as tenant_stop
      from ops.agents ag
      join ops.companies co on co.tenant_id = ag.tenant_id and co.id = ag.company_id
      join ops.departments d on d.tenant_id = ag.tenant_id and d.id = ag.department_id
     where ag.tenant_id = p_tenant_id
       and (p_agent_id is null or ag.id = p_agent_id)
     order by ag.name, ag.id
     limit case when p_every_agent then null else 500 end),
  runs as (
    select r.agent_id, r.id, r.created_at,
           (r.status = 'running' and j.status = 'leased' and j.lease_expires_at > v_as_of and j.attempts = r.job_attempt) as working,
           (r.status = 'running' and not coalesce(j.status = 'leased' and j.lease_expires_at > v_as_of and j.attempts = r.job_attempt, false)) as stale,
           (r.status = 'pending' and j.status = 'queued' and ops.job_covering_stop(p_tenant_id, j.id, j.kind) is not null) as held,
           (r.status = 'pending' and j.status = 'queued' and ops.job_covering_stop(p_tenant_id, j.id, j.kind) is null) as queued,
           (r.status = 'indeterminate'
            and not exists (select 1 from ops.agent_runs x where x.tenant_id = p_tenant_id and x.retry_of_run_id = r.id)) as indeterminate_open
      from ops.agent_runs r
      left join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
     where r.tenant_id = p_tenant_id and r.agent_id in (select id from a)),
  -- One pass over the runs, grouped by agent: the evidence of every agent at
  -- once, however many agents the uncapped overview reads.
  by_agent as (
    select x.agent_id,
           (pg_catalog.array_agg(x.id order by x.created_at desc, x.id desc) filter (where x.working))[1:20] as working_ids,
           (pg_catalog.array_agg(x.id order by x.created_at desc, x.id desc) filter (where x.stale))[1:20] as stale_ids,
           (pg_catalog.array_agg(x.id order by x.created_at desc, x.id desc) filter (where x.held))[1:20] as held_ids,
           (pg_catalog.array_agg(x.id order by x.created_at desc, x.id desc) filter (where x.queued))[1:20] as queued_ids,
           (pg_catalog.array_agg(x.id order by x.created_at desc, x.id desc) filter (where x.stale or x.indeterminate_open))[1:20] as attention_ids,
           count(*) filter (where x.stale or x.indeterminate_open) as attention_count,
           max(x.created_at) as last_run_at
      from runs x
     group by x.agent_id),
  per_agent as (
    select a.*, g.working_ids, g.stale_ids, g.held_ids, g.queued_ids, g.attention_ids,
           coalesce(g.attention_count, 0) as attention_count, g.last_run_at
      from a left join by_agent g on g.agent_id = a.id)
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', p.id, 'slug', p.slug, 'name', p.name,
      'company', pg_catalog.jsonb_build_object('id', p.company_id, 'name', p.company_name),
      'department', pg_catalog.jsonb_build_object('id', p.department_id, 'name', p.department_name),
      'availability', case when 'inactive' in (p.status, p.department_status, p.company_status) then 'inactive'
                           when p.tenant_stop is not null then 'stopped' else 'available' end,
      'activity', case when p.working_ids is not null then 'working'
                       when p.stale_ids is not null then 'stale'
                       when p.held_ids is not null then 'held'
                       when p.queued_ids is not null then 'queued'
                       else 'idle' end,
      'attentionCount', p.attention_count,
      'lastRunAt', ops.cos_ts(p.last_run_at),
      'evidence', pg_catalog.jsonb_build_object(
        'workingRunIds', pg_catalog.to_jsonb(coalesce(p.working_ids, '{}'::pg_catalog.uuid[])),
        'heldRunIds', pg_catalog.to_jsonb(coalesce(p.held_ids, '{}'::pg_catalog.uuid[])),
        'queuedRunIds', pg_catalog.to_jsonb(coalesce(p.queued_ids, '{}'::pg_catalog.uuid[])),
        'staleRunIds', pg_catalog.to_jsonb(coalesce(p.stale_ids, '{}'::pg_catalog.uuid[])),
        'attentionRunIds', pg_catalog.to_jsonb(coalesce(p.attention_ids, '{}'::pg_catalog.uuid[])),
        'stop', ops.cos_stop(p_tenant_id, p.tenant_stop),
        'inactiveUnit', case when p.status = 'inactive' then 'agent'
                             when p.department_status = 'inactive' then 'department'
                             when p.company_status = 'inactive' then 'company' end))
      order by p.name, p.id), '[]'::pg_catalog.jsonb)
    into v_items
    from per_agent p;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(v_as_of), 'items', v_items);
end
$$;

create function ops.read_agent_detail(p_tenant_id pg_catalog.uuid, p_agent_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_agent pg_catalog.jsonb;
begin
  perform 1 from ops.agents a where a.id = p_agent_id and a.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  -- The one agent's state, whatever its place in the capped list.
  v_agent := ops.agent_operational_state(p_tenant_id, p_agent_id) -> 'items' -> 0;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(v_as_of), 'agent', v_agent,
    'recentRuns', coalesce((select pg_catalog.jsonb_agg(ops.cos_run_summary(p_tenant_id, r, v_as_of) order by r.created_at desc, r.id desc)
                              from (select * from ops.agent_runs x where x.tenant_id = p_tenant_id and x.agent_id = p_agent_id
                                     order by x.created_at desc, x.id desc limit 20) r), '[]'::pg_catalog.jsonb));
end
$$;

create function ops.read_overview(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of  pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_today  pg_catalog.timestamptz := ops.cos_today_start(p_tenant_id);
  -- Every agent, not list_agents' first 500: the counts are exact.
  v_agents pg_catalog.jsonb := ops.agent_operational_state(p_tenant_id, null, true) -> 'items';
begin
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(v_as_of),
    'agents', pg_catalog.jsonb_build_object(
      'total', pg_catalog.jsonb_array_length(v_agents),
      'working', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'working'),
      'held', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'held'),
      'queued', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'queued'),
      'stale', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'stale'),
      'stopped', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'availability' = 'stopped'),
      'inactive', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'availability' = 'inactive')),
    'runs', pg_catalog.jsonb_build_object(
      'todayByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                   from (select r.status, count(*) as n from ops.agent_runs r
                                          where r.tenant_id = p_tenant_id and r.created_at >= v_today group by r.status) s),
                                '{}'::pg_catalog.jsonb),
      'workingNow', (select count(*) from ops.agent_runs r join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
                      where r.tenant_id = p_tenant_id and r.status = 'running' and j.status = 'leased'
                        and j.lease_expires_at > v_as_of and j.attempts = r.job_attempt),
      'needingAttention', (select count(*) from ops.agent_runs r
                            where r.tenant_id = p_tenant_id
                              and ((r.status = 'indeterminate'
                                    and not exists (select 1 from ops.agent_runs x where x.tenant_id = p_tenant_id and x.retry_of_run_id = r.id))
                                   or (r.status = 'running'
                                       and not exists (select 1 from ops.jobs j where j.tenant_id = p_tenant_id and j.id = r.job_id
                                                          and j.status = 'leased' and j.lease_expires_at > v_as_of
                                                          and j.attempts = r.job_attempt))))),
    'reviews', pg_catalog.jsonb_build_object(
      'pending', (select count(*) from ops.review_items v where v.tenant_id = p_tenant_id and v.status = 'pending'),
      'oldestPendingAt', ops.cos_ts((select min(v.created_at) from ops.review_items v where v.tenant_id = p_tenant_id and v.status = 'pending'))),
    'stops', pg_catalog.jsonb_build_object(
      'tenantScopedActive', (select count(*) from ops.execution_stops s where s.tenant_id = p_tenant_id and s.cleared_at is null)),
    'admission', pg_catalog.jsonb_build_object(
      'tenantAdmission', coalesce((select x.new_run_admission from ops.spend_status() x
                                    where x.scope = 'tenant' and x.tenant_id = p_tenant_id limit 1), 'unconfigured')),
    'outbound', pg_catalog.jsonb_build_object(
      'todayByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                   from (select o.status, count(*) as n from ops.outbound_messages o
                                          where o.tenant_id = p_tenant_id and o.created_at >= v_today group by o.status) s),
                                '{}'::pg_catalog.jsonb),
      'indeterminateOpen', (select count(*) from ops.outbound_messages o where o.tenant_id = p_tenant_id and o.status = 'indeterminate'),
      'acceptedWithoutSend', (select count(*) from ops.review_items v
                               where v.tenant_id = p_tenant_id and v.status = 'accepted'
                                 and not exists (select 1 from ops.outbound_messages o
                                                  where o.tenant_id = p_tenant_id and o.review_item_id = v.id))),
    'platform', pg_catalog.jsonb_build_object('globalAdmissionBlocked', ops.cos_global_admission_blocked()));
end
$$;

-- The four cursor-paged reads (read_tasks, read_events, read_agent_runs,
-- read_reviews) plan every statement for the values of the call
-- (plan_cache_mode = force_custom_plan). A page is its index read up to the
-- limit (brief §11), and that is the custom plan. PL/pgSQL would otherwise
-- cache a generic plan whenever it costs less than the session's average
-- custom plan, an average over every filter and page the session has read:
-- measured, for list_tasks that generic plan is a sequential scan and a sort
-- of the whole table, and it stuck for every later page of the session.
-- supabase/tests/company_os_api.sql section E pins both.
create function ops.read_tasks(p_tenant_id pg_catalog.uuid, p_cursor pg_catalog.text, p_status pg_catalog.text,
                               p_agent_id pg_catalog.uuid, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
declare
  v_limit  pg_catalog.int4 := ops.cos_limit(p_limit);
  v_cursor pg_catalog.uuid := ops.cos_cursor(p_cursor, 'tk');
  v_after  ops.tasks;
  v_items  pg_catalog.jsonb;
  v_n      pg_catalog.int4;
  v_last   pg_catalog.uuid;
begin
  if p_status is not null and p_status not in ('queued', 'assigned', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled') then
    raise exception using errcode = 'OS400', message = 'bad status';
  end if;
  if p_agent_id is not null then
    perform 1 from ops.agents a where a.id = p_agent_id and a.tenant_id = p_tenant_id;
    if not found then
      raise exception using errcode = 'OS404', message = 'not found';
    end if;
  end if;
  if v_cursor is not null then
    select * into v_after from ops.tasks t where t.id = v_cursor and t.tenant_id = p_tenant_id;
    if not found then
      raise exception using errcode = 'OS400', message = 'restart from the first page';
    end if;
  end if;
  with page as (
    select t from ops.tasks t
     where t.tenant_id = p_tenant_id
       and (p_status is null or t.status = p_status)
       and (p_agent_id is null or t.assigned_agent_id = p_agent_id)
       and (v_cursor is null or (t.created_at, t.id) < (v_after.created_at, v_after.id))
     order by t.created_at desc, t.id desc
     limit v_limit)
  select coalesce(pg_catalog.jsonb_agg(ops.cos_task_summary(p_tenant_id, page.t) order by (page.t).created_at desc, (page.t).id desc), '[]'::pg_catalog.jsonb),
         count(*), (pg_catalog.array_agg((page.t).id order by (page.t).created_at asc, (page.t).id asc))[1]
    into v_items, v_n, v_last
    from page;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'items', v_items,
    'nextCursor', case when v_n = v_limit then 'tk1:' || v_last::pg_catalog.text end);
end
$$;

create function ops.read_events(p_tenant_id pg_catalog.uuid, p_cursor pg_catalog.text, p_subject_type pg_catalog.text,
                                p_subject_id pg_catalog.uuid, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
declare
  v_limit  pg_catalog.int4 := ops.cos_limit(p_limit);
  v_cursor pg_catalog.uuid := ops.cos_cursor(p_cursor, 'ev');
  v_after  ops.events;
  v_items  pg_catalog.jsonb;
  v_n      pg_catalog.int4;
  v_last   pg_catalog.uuid;
begin
  if (p_subject_type is null) <> (p_subject_id is null) then
    raise exception using errcode = 'OS400', message = 'subject type and id go together';
  end if;
  if p_subject_type is not null then
    if p_subject_type not in ('task', 'agent_run', 'company', 'department', 'agent') then
      raise exception using errcode = 'OS400', message = 'bad subject type';
    end if;
    -- The subject is a selector resolved inside the caller's tenant: another
    -- tenant's row answers exactly like a missing one. (ops.cos_ref_id
    -- classifies emitted references, and calls a foreign one an internal
    -- error, which here would tell a caller the id exists elsewhere.)
    if not (case p_subject_type
              when 'task' then exists (select 1 from ops.tasks x where x.id = p_subject_id and x.tenant_id = p_tenant_id)
              when 'agent_run' then exists (select 1 from ops.agent_runs x
                                             where x.id = p_subject_id and x.tenant_id = p_tenant_id)
              when 'company' then exists (select 1 from ops.companies x where x.id = p_subject_id and x.tenant_id = p_tenant_id)
              when 'department' then exists (select 1 from ops.departments x
                                              where x.id = p_subject_id and x.tenant_id = p_tenant_id)
              when 'agent' then exists (select 1 from ops.agents x where x.id = p_subject_id and x.tenant_id = p_tenant_id)
              -- A subject type the check above admits but this list does not
              -- name is not found, never a skipped check.
              else false
            end) then
      raise exception using errcode = 'OS404', message = 'not found';
    end if;
  end if;
  if v_cursor is not null then
    select * into v_after from ops.events e where e.id = v_cursor and e.tenant_id = p_tenant_id;
    if not found then
      raise exception using errcode = 'OS400', message = 'restart from the first page';
    end if;
  end if;
  -- seq orders events inside one transaction; it is used here only as the
  -- tie-break and never leaves (brief §11, SI-26).
  with page as (
    select e from ops.events e
     where e.tenant_id = p_tenant_id
       and (p_subject_type is null or (e.subject_type = p_subject_type and e.subject_id = p_subject_id))
       and (v_cursor is null or (e.created_at, e.seq) < (v_after.created_at, v_after.seq))
     order by e.created_at desc, e.seq desc
     limit v_limit)
  select coalesce(pg_catalog.jsonb_agg(ops.cos_event_summary(p_tenant_id, page.e) order by (page.e).created_at desc, (page.e).seq desc), '[]'::pg_catalog.jsonb),
         count(*), (pg_catalog.array_agg((page.e).id order by (page.e).created_at asc, (page.e).seq asc))[1]
    into v_items, v_n, v_last
    from page;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'items', v_items,
    'nextCursor', case when v_n = v_limit then 'ev1:' || v_last::pg_catalog.text end);
end
$$;

create function ops.read_task_detail(p_tenant_id pg_catalog.uuid, p_task_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_task  ops.tasks;
begin
  select * into v_task from ops.tasks t where t.id = p_task_id and t.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(v_as_of))
    || ops.cos_task_summary(p_tenant_id, v_task)
    || pg_catalog.jsonb_build_object(
      'runs', coalesce((select pg_catalog.jsonb_agg(ops.cos_run_summary(p_tenant_id, r, v_as_of) order by r.created_at desc, r.id desc)
                          from (select * from ops.agent_runs x where x.tenant_id = p_tenant_id and x.task_id = v_task.id
                                 order by x.created_at desc, x.id desc limit 20) r), '[]'::pg_catalog.jsonb),
      'review', (select ops.cos_review_summary(p_tenant_id, v) from ops.review_items v
                  where v.tenant_id = p_tenant_id and v.task_id = v_task.id order by v.created_at desc, v.id desc limit 1),
      'outbound', (select ops.cos_outbound_summary(p_tenant_id, o) from ops.outbound_messages o
                    where o.tenant_id = p_tenant_id and o.task_id = v_task.id order by o.created_at desc, o.id desc limit 1),
      'inbound', (select pg_catalog.jsonb_build_object(
                           'sourceKind', i.source_kind, 'channelLabel', ch.label, 'receivedAt', ops.cos_ts(i.received_at),
                           'contactResolution', i.contact_resolution, 'doNotContact', i.do_not_contact)
                    from ops.inbound_messages i
                    left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
                   where i.tenant_id = p_tenant_id and i.task_id = v_task.id
                   order by i.created_at desc, i.id desc limit 1),
      'events', ops.read_events(p_tenant_id, null, 'task', v_task.id, 50) - 'v' - 'asOf');
end
$$;

create function ops.read_agent_runs(p_tenant_id pg_catalog.uuid, p_cursor pg_catalog.text, p_status pg_catalog.text,
                                    p_agent_id pg_catalog.uuid, p_attention_only pg_catalog.bool, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
declare
  v_as_of  pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_limit  pg_catalog.int4 := ops.cos_limit(p_limit);
  v_cursor pg_catalog.uuid := ops.cos_cursor(p_cursor, 'rn');
  v_after  ops.agent_runs;
  v_items  pg_catalog.jsonb;
  v_n      pg_catalog.int4;
  v_last   pg_catalog.uuid;
begin
  if p_status is not null and p_status not in ('pending', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled') then
    raise exception using errcode = 'OS400', message = 'bad status';
  end if;
  if p_agent_id is not null then
    perform 1 from ops.agents a where a.id = p_agent_id and a.tenant_id = p_tenant_id;
    if not found then
      raise exception using errcode = 'OS404', message = 'not found';
    end if;
  end if;
  if v_cursor is not null then
    select * into v_after from ops.agent_runs r where r.id = v_cursor and r.tenant_id = p_tenant_id;
    if not found then
      raise exception using errcode = 'OS400', message = 'restart from the first page';
    end if;
  end if;
  with page as (
    select r from ops.agent_runs r
     where r.tenant_id = p_tenant_id
       and (p_status is null or r.status = p_status)
       and (p_agent_id is null or r.agent_id = p_agent_id)
       and (not coalesce(p_attention_only, false)
            or (r.status = 'indeterminate'
                and not exists (select 1 from ops.agent_runs x where x.tenant_id = p_tenant_id and x.retry_of_run_id = r.id))
            or (r.status = 'running'
                and not exists (select 1 from ops.jobs j where j.tenant_id = p_tenant_id and j.id = r.job_id
                                   and j.status = 'leased' and j.lease_expires_at > v_as_of and j.attempts = r.job_attempt)))
       and (v_cursor is null or (r.created_at, r.id) < (v_after.created_at, v_after.id))
     order by r.created_at desc, r.id desc
     limit v_limit)
  select coalesce(pg_catalog.jsonb_agg(ops.cos_run_summary(p_tenant_id, page.r, v_as_of) order by (page.r).created_at desc, (page.r).id desc), '[]'::pg_catalog.jsonb),
         count(*), (pg_catalog.array_agg((page.r).id order by (page.r).created_at asc, (page.r).id asc))[1]
    into v_items, v_n, v_last
    from page;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(v_as_of), 'items', v_items,
    'nextCursor', case when v_n = v_limit then 'rn1:' || v_last::pg_catalog.text end);
end
$$;

create function ops.read_agent_run_detail(p_tenant_id pg_catalog.uuid, p_run_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_run   ops.agent_runs;
  v_job   ops.jobs;
begin
  select * into v_run from ops.agent_runs r where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  select * into v_job from ops.jobs j where j.tenant_id = p_tenant_id and j.id = v_run.job_id;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(v_as_of))
    || ops.cos_run_summary(p_tenant_id, v_run, v_as_of)
    || pg_catalog.jsonb_build_object(
      'retriedByRunIds', coalesce((select pg_catalog.jsonb_agg(x.id order by x.created_at, x.id)
                                     from ops.agent_runs x where x.tenant_id = p_tenant_id and x.retry_of_run_id = v_run.id),
                                  '[]'::pg_catalog.jsonb),
      'job', case when v_job.id is null then null else pg_catalog.jsonb_build_object(
               'status', v_job.status, 'attempts', v_job.attempts, 'availableAt', ops.cos_ts(v_job.available_at),
               'leaseLive', (v_job.status = 'leased' and v_job.lease_expires_at > v_as_of),
               'lastErrorClass', v_job.last_error_class) end,
      -- job_events carries a global id and free-form detail: only the step,
      -- the attempt and the time leave.
      'jobSteps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                                    'step', 'job_' || je.event, 'attempt', je.attempt, 'at', ops.cos_ts(je.created_at))
                                  order by je.created_at, je.id)
                              from ops.job_events je
                             where je.tenant_id = p_tenant_id and je.job_id = v_run.job_id
                               and je.event in ('leased', 'deferred', 'retry', 'reaped')), '[]'::pg_catalog.jsonb),
      'coveringStop', case when v_job.id is null then null
                           else ops.cos_stop(p_tenant_id, ops.cos_tenant_covering_stop(
                                  p_tenant_id, v_job.kind, v_run.company_id, v_run.department_id, v_run.agent_id)) end);
end
$$;

create function ops.read_reviews(p_tenant_id pg_catalog.uuid, p_cursor pg_catalog.text, p_status pg_catalog.text, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
declare
  v_limit  pg_catalog.int4 := ops.cos_limit(p_limit);
  v_cursor pg_catalog.uuid := ops.cos_cursor(p_cursor, 'rv');
  v_status pg_catalog.text := coalesce(p_status, 'pending');
  v_after  ops.review_items;
  v_items  pg_catalog.jsonb;
  v_n      pg_catalog.int4;
  v_last   pg_catalog.uuid;
begin
  if v_status not in ('pending', 'accepted', 'rejected', 'needs_edit') then
    raise exception using errcode = 'OS400', message = 'bad status';
  end if;
  if v_cursor is not null then
    select * into v_after from ops.review_items r where r.id = v_cursor and r.tenant_id = p_tenant_id;
    if not found then
      raise exception using errcode = 'OS400', message = 'restart from the first page';
    end if;
  end if;
  -- The pending tab is oldest first; the decided tabs are newest first. One
  -- statement per direction, each ordered by plain columns, so each page is a
  -- scan of review_items_tenant_created_id (backward for the pending tab)
  -- that stops at the limit, never a sort of the tenant's whole tab.
  if v_status = 'pending' then
    with page as (
      select r from ops.review_items r
       where r.tenant_id = p_tenant_id and r.status = v_status
         and (v_cursor is null or (r.created_at, r.id) > (v_after.created_at, v_after.id))
       order by r.created_at asc, r.id asc
       limit v_limit)
    select coalesce(pg_catalog.jsonb_agg(ops.cos_review_summary(p_tenant_id, page.r) order by (page.r).created_at asc, (page.r).id asc), '[]'::pg_catalog.jsonb),
           count(*), (pg_catalog.array_agg((page.r).id order by (page.r).created_at desc, (page.r).id desc))[1]
      into v_items, v_n, v_last
      from page;
  else
    with page as (
      select r from ops.review_items r
       where r.tenant_id = p_tenant_id and r.status = v_status
         and (v_cursor is null or (r.created_at, r.id) < (v_after.created_at, v_after.id))
       order by r.created_at desc, r.id desc
       limit v_limit)
    select coalesce(pg_catalog.jsonb_agg(ops.cos_review_summary(p_tenant_id, page.r) order by (page.r).created_at desc, (page.r).id desc), '[]'::pg_catalog.jsonb),
           count(*), (pg_catalog.array_agg((page.r).id order by (page.r).created_at asc, (page.r).id asc))[1]
      into v_items, v_n, v_last
      from page;
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'items', v_items,
    'nextCursor', case when v_n = v_limit then 'rv1:' || v_last::pg_catalog.text end);
end
$$;

create function ops.read_review_detail(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()))
    || ops.cos_review_summary(p_tenant_id, v_item)
    || pg_catalog.jsonb_build_object(
      'decisionNote', v_item.decision_note,
      'allowedDecisions', case when v_item.status <> 'pending' then '[]'::pg_catalog.jsonb
                               when v_item.do_not_contact then '["rejected", "needs_edit"]'::pg_catalog.jsonb
                               else '["accepted", "rejected", "needs_edit"]'::pg_catalog.jsonb end);
end
$$;

-- The one content exception (brief §13 item 3; the SI-52 amendment): the
-- lead_triage structured advice, on explicit open of one review of the
-- caller's tenant, for a synthetic or test origin, never the reply draft.
create function ops.read_review_advice(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  -- The tenant lookup first, before any other branch: a foreign review is OS404.
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  if v_item.capability <> 'lead_triage' then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'withheld', 'capability_not_pinned');
  end if;
  -- The origin, read at call time: a synthetic admission, or a WhatsApp
  -- admission on a channel that is still in test mode. No admission row, any
  -- other kind, or a channel no longer in test mode is withheld.
  if not exists (
    select 1 from ops.inbound_messages i
      left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
     where i.tenant_id = p_tenant_id and i.task_id = v_item.task_id
       and (i.source_kind = 'synthetic' or (i.source_kind = 'whatsapp' and ch.mode = 'test'))) then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'withheld', 'origin_not_synthetic_or_test');
  end if;
  if not ops.agent_run_result_valid('lead_triage', v_item.proposed) then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'withheld', 'contract_invalid');
  end if;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'capability', 'lead_triage',
    'outcome', v_item.proposed -> 'outcome', 'intent', v_item.proposed -> 'intent',
    'priority', v_item.proposed -> 'priority', 'needsHumanReview', v_item.proposed -> 'needs_human_review',
    'flags', v_item.proposed -> 'flags', 'summary', v_item.proposed -> 'summary',
    'recommendedNextAction', v_item.proposed -> 'recommended_next_action');
end
$$;

create function ops.read_stops_in_tenant(p_tenant_id pg_catalog.uuid, p_include_cleared pg_catalog.bool,
                                         p_cursor pg_catalog.text, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_limit  pg_catalog.int4 := ops.cos_limit(p_limit);
  v_cursor pg_catalog.uuid := ops.cos_cursor(p_cursor, 'st');
  v_all    pg_catalog.bool := coalesce(p_include_cleared, false);
  v_after  ops.execution_stops;
  v_items  pg_catalog.jsonb;
  v_n      pg_catalog.int4;
  v_last   pg_catalog.uuid;
begin
  if v_cursor is not null then
    select * into v_after from ops.execution_stops s
     where s.id = v_cursor and s.tenant_id = p_tenant_id and (v_all or s.cleared_at is null);
    if not found then
      raise exception using errcode = 'OS400', message = 'restart from the first page';
    end if;
  end if;
  -- Stops NAMING the tenant only: a platform row (tenant_id null) never leaves.
  -- No tripped_by or cleared_by label (brief §9).
  with page as (
    select s from ops.execution_stops s
     where s.tenant_id = p_tenant_id and (v_all or s.cleared_at is null)
       and (v_cursor is null or (s.tripped_at, s.id) < (v_after.tripped_at, v_after.id))
     order by s.tripped_at desc, s.id desc
     limit v_limit)
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', (page.s).id, 'scope', (page.s).scope, 'jobKind', (page.s).job_kind, 'origin', (page.s).origin,
           'target', case when (page.s).scope in ('company', 'department', 'agent') then pg_catalog.jsonb_build_object(
               'companyId', (page.s).company_id, 'departmentId', (page.s).department_id, 'agentId', (page.s).agent_id,
               'name', coalesce(
                 (select a.name from ops.agents a where a.tenant_id = p_tenant_id and a.id = (page.s).agent_id),
                 (select d.name from ops.departments d where d.tenant_id = p_tenant_id and d.id = (page.s).department_id),
                 (select c.name from ops.companies c where c.tenant_id = p_tenant_id and c.id = (page.s).company_id))) end,
           'trippedAt', ops.cos_ts((page.s).tripped_at), 'reason', (page.s).reason,
           'clearedAt', ops.cos_ts((page.s).cleared_at), 'clearedReason', (page.s).cleared_reason)
           order by (page.s).tripped_at desc, (page.s).id desc), '[]'::pg_catalog.jsonb),
         count(*), (pg_catalog.array_agg((page.s).id order by (page.s).tripped_at asc, (page.s).id asc))[1]
    into v_items, v_n, v_last
    from page;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'items', v_items,
    'nextCursor', case when v_n = v_limit then 'st1:' || v_last::pg_catalog.text end);
end
$$;

create function ops.read_spend_summary(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_today pg_catalog.timestamptz := ops.cos_today_start(p_tenant_id);
begin
  -- spend_status reports every scope; only the tenant's own tenant and company
  -- rows leave. The global row feeds the one derived boolean.
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'windowStart', ops.cos_ts(v_today),
    'tenantRows', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'scope', x.scope, 'companyId', x.company_id, 'timezone', x.timezone,
        'dailyLimit', ops.cos_money(x.daily_limit_micros), 'charged', ops.cos_money(x.charged_micros),
        'settled', ops.cos_money(x.settled_micros), 'estimated', ops.cos_money(x.estimated_micros),
        'remaining', ops.cos_money(x.remaining_micros),
        'runningRuns', x.running_runs, 'unknownCostRuns', x.unknown_cost_runs, 'refusedRuns', x.refused_runs,
        'settledExhausted', x.settled_exhausted, 'newRunAdmission', x.new_run_admission)
        order by x.scope desc, x.company_id)
      from ops.spend_status() x where x.tenant_id = p_tenant_id and x.scope in ('tenant', 'company')), '[]'::pg_catalog.jsonb),
    'today', pg_catalog.jsonb_build_object(
      'byAgent', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                             'agent', pg_catalog.jsonb_build_object('id', a.id, 'name', a.name),
                             'runs', s.runs, 'charged', ops.cos_money(s.charged)) order by a.name, a.id)
                             from (select r.agent_id, count(*) as runs, sum(coalesce(r.charged_cost_micros, 0))::pg_catalog.int8 as charged
                                     from ops.agent_runs r where r.tenant_id = p_tenant_id and r.created_at >= v_today
                                    group by r.agent_id) s
                             join ops.agents a on a.tenant_id = p_tenant_id and a.id = s.agent_id), '[]'::pg_catalog.jsonb),
      'byModel', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                             'provider', s.provider, 'model', s.model, 'runs', s.runs, 'charged', ops.cos_money(s.charged))
                             order by s.provider, s.model)
                             from (select r.provider, r.model, count(*) as runs, sum(coalesce(r.charged_cost_micros, 0))::pg_catalog.int8 as charged
                                     from ops.agent_runs r where r.tenant_id = p_tenant_id and r.created_at >= v_today
                                      and r.provider is not null
                                    group by r.provider, r.model) s), '[]'::pg_catalog.jsonb)),
    'platform', pg_catalog.jsonb_build_object('globalAdmissionBlocked', ops.cos_global_admission_blocked()));
end
$$;

-- Counts and channel labels only (OD-9): never a provider target, a contact,
-- a conversation id, a body, a draft or an individual send.
create function ops.read_communication_status(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_today pg_catalog.timestamptz := ops.cos_today_start(p_tenant_id);
begin
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(v_as_of),
    'channels', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', ch.id, 'label', ch.label, 'mode', ch.mode, 'active', ch.active,
        'agent', (select pg_catalog.jsonb_build_object('id', a.id, 'name', a.name)
                    from ops.agents a where a.tenant_id = p_tenant_id and a.id = ch.agent_id),
        'updatedAt', ops.cos_ts(ch.updated_at)) order by ch.label, ch.id)
      from ops.communication_channels ch where ch.tenant_id = p_tenant_id), '[]'::pg_catalog.jsonb),
    'inbound', pg_catalog.jsonb_build_object(
      'admittedToday', (select count(*) from ops.inbound_messages i where i.tenant_id = p_tenant_id and i.created_at >= v_today),
      'refusedTodayByReason', coalesce((select pg_catalog.jsonb_object_agg(s.reason, s.n)
          from (select e.payload ->> 'reason' as reason, count(*) as n from ops.events e
                 where e.tenant_id = p_tenant_id and e.type = 'communication.inbound_refused' and e.created_at >= v_today
                   and e.payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$'
                 group by e.payload ->> 'reason') s), '{}'::pg_catalog.jsonb)),
    'conversationsActive24h', (select count(*) from ops.conversations c
                                where c.tenant_id = p_tenant_id and c.last_inbound_at > v_as_of - interval '24 hours'),
    'outbound', pg_catalog.jsonb_build_object(
      'byStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
          from (select o.status, count(*) as n from ops.outbound_messages o where o.tenant_id = p_tenant_id group by o.status) s),
          '{}'::pg_catalog.jsonb),
      'blockedByReason', coalesce((select pg_catalog.jsonb_object_agg(s.blocked_reason, s.n)
          from (select o.blocked_reason, count(*) as n from ops.outbound_messages o
                 where o.tenant_id = p_tenant_id and o.status = 'blocked' group by o.blocked_reason) s), '{}'::pg_catalog.jsonb),
      'indeterminateOpen', (select count(*) from ops.outbound_messages o where o.tenant_id = p_tenant_id and o.status = 'indeterminate'),
      'acceptedWithoutSend', (select count(*) from ops.review_items v
                               where v.tenant_id = p_tenant_id and v.status = 'accepted'
                                 and not exists (select 1 from ops.outbound_messages o
                                                  where o.tenant_id = p_tenant_id and o.review_item_id = v.id))),
    'note', 'Unrouted deliveries are never stored.');
end
$$;

-- ---------------------------------------------------------------------------
-- 9. The identity gates: one per operation. Resolver first, then exactly one
--    pinned callee, no-store on success, and one fixed data-free message per
--    SQLSTATE. A statement cancel is not caught and surfaces as PostgREST's own
--    generic error.
-- ---------------------------------------------------------------------------

create function ops.gate_operator_context() returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_operator_context(v.tenant_id, v.principal_id, v.role);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.operator_context: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.operator_context: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.operator_context: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.operator_context: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.operator_context: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.operator_context: internal error';
end
$$;

create function ops.gate_overview() returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_overview(v.tenant_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.overview: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.overview: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.overview: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.overview: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.overview: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.overview: internal error';
end
$$;

create function ops.gate_list_agents() returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.agent_operational_state(v.tenant_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.list_agents: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.list_agents: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.list_agents: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.list_agents: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.list_agents: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.list_agents: internal error';
end
$$;

create function ops.gate_get_agent(p_agent_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_agent_detail(v.tenant_id, p_agent_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.get_agent: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.get_agent: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.get_agent: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.get_agent: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.get_agent: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.get_agent: internal error';
end
$$;

create function ops.gate_list_tasks(p_cursor pg_catalog.text, p_status pg_catalog.text, p_agent_id pg_catalog.uuid, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_tasks(v.tenant_id, p_cursor, p_status, p_agent_id, p_limit);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.list_tasks: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.list_tasks: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.list_tasks: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.list_tasks: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.list_tasks: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.list_tasks: internal error';
end
$$;

create function ops.gate_get_task(p_task_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_task_detail(v.tenant_id, p_task_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.get_task: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.get_task: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.get_task: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.get_task: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.get_task: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.get_task: internal error';
end
$$;

create function ops.gate_list_runs(p_cursor pg_catalog.text, p_status pg_catalog.text, p_agent_id pg_catalog.uuid,
                                   p_attention_only pg_catalog.bool, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_agent_runs(v.tenant_id, p_cursor, p_status, p_agent_id, p_attention_only, p_limit);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.list_runs: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.list_runs: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.list_runs: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.list_runs: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.list_runs: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.list_runs: internal error';
end
$$;

create function ops.gate_get_run(p_run_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_agent_run_detail(v.tenant_id, p_run_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.get_run: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.get_run: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.get_run: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.get_run: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.get_run: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.get_run: internal error';
end
$$;

create function ops.gate_list_reviews(p_cursor pg_catalog.text, p_status pg_catalog.text, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_reviews(v.tenant_id, p_cursor, p_status, p_limit);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.list_reviews: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.list_reviews: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.list_reviews: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.list_reviews: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.list_reviews: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.list_reviews: internal error';
end
$$;

create function ops.gate_get_review(p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_review_detail(v.tenant_id, p_review_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.get_review: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.get_review: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.get_review: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.get_review: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.get_review: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.get_review: internal error';
end
$$;

create function ops.gate_get_review_advice(p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_review_advice(v.tenant_id, p_review_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.get_review_advice: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.get_review_advice: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.get_review_advice: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.get_review_advice: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.get_review_advice: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.get_review_advice: internal error';
end
$$;

create function ops.gate_list_events(p_cursor pg_catalog.text, p_subject_type pg_catalog.text, p_subject_id pg_catalog.uuid,
                                     p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_events(v.tenant_id, p_cursor, p_subject_type, p_subject_id, p_limit);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.list_events: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.list_events: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.list_events: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.list_events: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.list_events: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.list_events: internal error';
end
$$;

create function ops.gate_list_stops(p_include_cleared pg_catalog.bool, p_cursor pg_catalog.text, p_limit pg_catalog.int4)
returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_stops_in_tenant(v.tenant_id, p_include_cleared, p_cursor, p_limit);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.list_stops: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.list_stops: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.list_stops: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.list_stops: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.list_stops: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.list_stops: internal error';
end
$$;

create function ops.gate_spend_summary() returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_spend_summary(v.tenant_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.spend_summary: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.spend_summary: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.spend_summary: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.spend_summary: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.spend_summary: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.spend_summary: internal error';
end
$$;

create function ops.gate_communication_status() returns pg_catalog.jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v record; r pg_catalog.jsonb;
begin
  select * into v from ops.operator_scope();
  r := ops.read_communication_status(v.tenant_id);
  perform pg_catalog.set_config('response.headers', '[{"Cache-Control": "no-store"}]', true);
  return r;
exception
  when sqlstate 'OS400' then raise exception using errcode = 'OS400', message = 'company_os_api.communication_status: bad request';
  when sqlstate 'OS401' then raise exception using errcode = 'OS401', message = 'company_os_api.communication_status: not signed in';
  when sqlstate 'OS403' then raise exception using errcode = 'OS403', message = 'company_os_api.communication_status: no access';
  when sqlstate 'OS404' then raise exception using errcode = 'OS404', message = 'company_os_api.communication_status: not found';
  when sqlstate 'OS409' then raise exception using errcode = 'OS409', message = 'company_os_api.communication_status: conflict';
  when others then raise exception using errcode = 'OS500', message = 'company_os_api.communication_status: internal error';
end
$$;

-- Every new ops function: no PUBLIC, no application role (A3).
revoke all on function
  ops.guard_principal_change(), ops.guard_membership_change(), ops.refuse_identity_truncate(),
  ops.membership_tenant_eligible(pg_catalog.uuid),
  ops.grant_membership(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.text),
  ops.revoke_membership(pg_catalog.uuid, pg_catalog.text, pg_catalog.text),
  ops.operator_scope(),
  ops.cos_ts(pg_catalog.timestamptz), ops.cos_money(pg_catalog.int8), ops.cos_cursor(pg_catalog.text, pg_catalog.text),
  ops.cos_limit(pg_catalog.int4), ops.cos_ref_id(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid),
  ops.cos_ref(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid), ops.cos_stop(pg_catalog.uuid, pg_catalog.uuid),
  ops.cos_tenant_covering_stop(pg_catalog.uuid, pg_catalog.text, pg_catalog.uuid, pg_catalog.uuid, pg_catalog.uuid),
  ops.cos_global_admission_blocked(), ops.cos_today_start(pg_catalog.uuid), ops.cos_event_source(pg_catalog.text),
  ops.cos_event_known(pg_catalog.text), ops.cos_event_facts(pg_catalog.uuid, pg_catalog.text, pg_catalog.jsonb),
  ops.cos_run_summary(pg_catalog.uuid, ops.agent_runs, pg_catalog.timestamptz),
  ops.cos_review_summary(pg_catalog.uuid, ops.review_items), ops.cos_outbound_summary(pg_catalog.uuid, ops.outbound_messages),
  ops.cos_task_summary(pg_catalog.uuid, ops.tasks), ops.cos_event_summary(pg_catalog.uuid, ops.events),
  ops.read_operator_context(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text),
  ops.agent_operational_state(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.bool),
  ops.read_agent_detail(pg_catalog.uuid, pg_catalog.uuid), ops.read_overview(pg_catalog.uuid),
  ops.read_tasks(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  ops.read_events(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  ops.read_task_detail(pg_catalog.uuid, pg_catalog.uuid),
  ops.read_agent_runs(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.bool, pg_catalog.int4),
  ops.read_agent_run_detail(pg_catalog.uuid, pg_catalog.uuid),
  ops.read_reviews(pg_catalog.uuid, pg_catalog.text, pg_catalog.text, pg_catalog.int4),
  ops.read_review_detail(pg_catalog.uuid, pg_catalog.uuid), ops.read_review_advice(pg_catalog.uuid, pg_catalog.uuid),
  ops.read_stops_in_tenant(pg_catalog.uuid, pg_catalog.bool, pg_catalog.text, pg_catalog.int4),
  ops.read_spend_summary(pg_catalog.uuid), ops.read_communication_status(pg_catalog.uuid),
  ops.gate_operator_context(), ops.gate_overview(), ops.gate_list_agents(), ops.gate_get_agent(pg_catalog.uuid),
  ops.gate_list_tasks(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4), ops.gate_get_task(pg_catalog.uuid),
  ops.gate_list_runs(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.bool, pg_catalog.int4),
  ops.gate_get_run(pg_catalog.uuid), ops.gate_list_reviews(pg_catalog.text, pg_catalog.text, pg_catalog.int4),
  ops.gate_get_review(pg_catalog.uuid), ops.gate_get_review_advice(pg_catalog.uuid),
  ops.gate_list_events(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  ops.gate_list_stops(pg_catalog.bool, pg_catalog.text, pg_catalog.int4), ops.gate_spend_summary(),
  ops.gate_communication_status()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 10. Indexes for the tenant-scoped, cursor-paged reads (brief §11).
-- ---------------------------------------------------------------------------

create index events_tenant_created_seq on ops.events (tenant_id, created_at desc, seq desc);
create index agent_runs_tenant_created_id on ops.agent_runs (tenant_id, created_at desc, id desc);
create index tasks_tenant_created_id on ops.tasks (tenant_id, created_at desc, id desc);
create index review_items_tenant_created_id on ops.review_items (tenant_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- 11. The capability role, the function-only schema, the gates' one grant,
--     and the 15 exposed functions.
-- ---------------------------------------------------------------------------

create role ops_operator_api nologin nosuperuser nocreatedb nocreaterole nobypassrls noinherit;

grant usage on schema ops to ops_operator_api;
grant execute on function
  ops.gate_operator_context(), ops.gate_overview(), ops.gate_list_agents(), ops.gate_get_agent(pg_catalog.uuid),
  ops.gate_list_tasks(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4), ops.gate_get_task(pg_catalog.uuid),
  ops.gate_list_runs(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.bool, pg_catalog.int4),
  ops.gate_get_run(pg_catalog.uuid), ops.gate_list_reviews(pg_catalog.text, pg_catalog.text, pg_catalog.int4),
  ops.gate_get_review(pg_catalog.uuid), ops.gate_get_review_advice(pg_catalog.uuid),
  ops.gate_list_events(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  ops.gate_list_stops(pg_catalog.bool, pg_catalog.text, pg_catalog.int4), ops.gate_spend_summary(),
  ops.gate_communication_status()
  to ops_operator_api;

create schema company_os_api;
grant usage on schema company_os_api to authenticated;

create function company_os_api.operator_context() returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_operator_context() $$;
create function company_os_api.overview() returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_overview() $$;
create function company_os_api.list_agents() returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_list_agents() $$;
create function company_os_api.get_agent(p_agent_id pg_catalog.uuid) returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_get_agent(p_agent_id) $$;
create function company_os_api.list_tasks(p_cursor pg_catalog.text default null, p_status pg_catalog.text default null,
                                          p_agent_id pg_catalog.uuid default null, p_limit pg_catalog.int4 default 50)
returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_list_tasks(p_cursor, p_status, p_agent_id, p_limit) $$;
create function company_os_api.get_task(p_task_id pg_catalog.uuid) returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_get_task(p_task_id) $$;
create function company_os_api.list_runs(p_cursor pg_catalog.text default null, p_status pg_catalog.text default null,
                                         p_agent_id pg_catalog.uuid default null, p_attention_only pg_catalog.bool default false,
                                         p_limit pg_catalog.int4 default 50)
returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_list_runs(p_cursor, p_status, p_agent_id, p_attention_only, p_limit) $$;
create function company_os_api.get_run(p_run_id pg_catalog.uuid) returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_get_run(p_run_id) $$;
create function company_os_api.list_reviews(p_cursor pg_catalog.text default null, p_status pg_catalog.text default 'pending',
                                            p_limit pg_catalog.int4 default 50)
returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_list_reviews(p_cursor, p_status, p_limit) $$;
create function company_os_api.get_review(p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_get_review(p_review_id) $$;
create function company_os_api.get_review_advice(p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_get_review_advice(p_review_id) $$;
create function company_os_api.list_events(p_cursor pg_catalog.text default null, p_subject_type pg_catalog.text default null,
                                           p_subject_id pg_catalog.uuid default null, p_limit pg_catalog.int4 default 50)
returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_list_events(p_cursor, p_subject_type, p_subject_id, p_limit) $$;
create function company_os_api.list_stops(p_include_cleared pg_catalog.bool default false, p_cursor pg_catalog.text default null,
                                          p_limit pg_catalog.int4 default 50)
returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_list_stops(p_include_cleared, p_cursor, p_limit) $$;
create function company_os_api.spend_summary() returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_spend_summary() $$;
create function company_os_api.communication_status() returns pg_catalog.jsonb
language sql stable security definer set search_path = '' as $$ select ops.gate_communication_status() $$;

-- The ACL of each exposed function is set while this migration still owns it
-- (S0.4 measured that it survives the ownership transfer).
revoke all on function
  company_os_api.operator_context(), company_os_api.overview(), company_os_api.list_agents(),
  company_os_api.get_agent(pg_catalog.uuid),
  company_os_api.list_tasks(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  company_os_api.get_task(pg_catalog.uuid),
  company_os_api.list_runs(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.bool, pg_catalog.int4),
  company_os_api.get_run(pg_catalog.uuid),
  company_os_api.list_reviews(pg_catalog.text, pg_catalog.text, pg_catalog.int4),
  company_os_api.get_review(pg_catalog.uuid), company_os_api.get_review_advice(pg_catalog.uuid),
  company_os_api.list_events(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  company_os_api.list_stops(pg_catalog.bool, pg_catalog.text, pg_catalog.int4),
  company_os_api.spend_summary(), company_os_api.communication_status()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function
  company_os_api.operator_context(), company_os_api.overview(), company_os_api.list_agents(),
  company_os_api.get_agent(pg_catalog.uuid),
  company_os_api.list_tasks(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  company_os_api.get_task(pg_catalog.uuid),
  company_os_api.list_runs(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.bool, pg_catalog.int4),
  company_os_api.get_run(pg_catalog.uuid),
  company_os_api.list_reviews(pg_catalog.text, pg_catalog.text, pg_catalog.int4),
  company_os_api.get_review(pg_catalog.uuid), company_os_api.get_review_advice(pg_catalog.uuid),
  company_os_api.list_events(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4),
  company_os_api.list_stops(pg_catalog.bool, pg_catalog.text, pg_catalog.int4),
  company_os_api.spend_summary(), company_os_api.communication_status()
  to authenticated;

-- ---------------------------------------------------------------------------
-- 12. OD-8a lifecycle, steps 2 to 6: a temporary membership for the literal
--     migration identity and a temporary CREATE on company_os_api, bracketing
--     exactly the catalogued ownership transfers, then both revoked.
-- ---------------------------------------------------------------------------

grant ops_operator_api to postgres;
grant create on schema company_os_api to ops_operator_api;
alter function company_os_api.operator_context() owner to ops_operator_api;
alter function company_os_api.overview() owner to ops_operator_api;
alter function company_os_api.list_agents() owner to ops_operator_api;
alter function company_os_api.get_agent(pg_catalog.uuid) owner to ops_operator_api;
alter function company_os_api.list_tasks(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4) owner to ops_operator_api;
alter function company_os_api.get_task(pg_catalog.uuid) owner to ops_operator_api;
alter function company_os_api.list_runs(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.bool, pg_catalog.int4) owner to ops_operator_api;
alter function company_os_api.get_run(pg_catalog.uuid) owner to ops_operator_api;
alter function company_os_api.list_reviews(pg_catalog.text, pg_catalog.text, pg_catalog.int4) owner to ops_operator_api;
alter function company_os_api.get_review(pg_catalog.uuid) owner to ops_operator_api;
alter function company_os_api.get_review_advice(pg_catalog.uuid) owner to ops_operator_api;
alter function company_os_api.list_events(pg_catalog.text, pg_catalog.text, pg_catalog.uuid, pg_catalog.int4) owner to ops_operator_api;
alter function company_os_api.list_stops(pg_catalog.bool, pg_catalog.text, pg_catalog.int4) owner to ops_operator_api;
alter function company_os_api.spend_summary() owner to ops_operator_api;
alter function company_os_api.communication_status() owner to ops_operator_api;
revoke create on schema company_os_api from ops_operator_api;
revoke ops_operator_api from postgres;

-- ---------------------------------------------------------------------------
-- 13. OD-8a step 7: assert the end state (brief §7.6 E).
-- ---------------------------------------------------------------------------

do $end_state$
declare
  c_l3 constant pg_catalog.text[] := array[
    'company_os_api.operator_context()', 'company_os_api.overview()', 'company_os_api.list_agents()',
    'company_os_api.get_agent(uuid)', 'company_os_api.list_tasks(text,text,uuid,integer)',
    'company_os_api.get_task(uuid)', 'company_os_api.list_runs(text,text,uuid,boolean,integer)',
    'company_os_api.get_run(uuid)', 'company_os_api.list_reviews(text,text,integer)',
    'company_os_api.get_review(uuid)', 'company_os_api.get_review_advice(uuid)',
    'company_os_api.list_events(text,text,uuid,integer)', 'company_os_api.list_stops(boolean,text,integer)',
    'company_os_api.spend_summary()', 'company_os_api.communication_status()'];
  v_bad pg_catalog.text;
begin
  -- One transaction, the whole lifecycle (see section 1).
  if pg_catalog.current_setting('company_os.migration_txid', true) is distinct from pg_catalog.txid_current()::pg_catalog.text then
    raise exception 'company_os_read_surface: the migration did not run in one transaction';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles r where r.rolname = 'ops_operator_api'
                  and not r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
                  and not r.rolbypassrls and not r.rolinherit) then
    raise exception 'ops_operator_api is missing or carries a login or a blanket attribute';
  end if;
  if exists (select 1 from pg_catalog.pg_auth_members m
              where m.roleid = 'ops_operator_api'::pg_catalog.regrole or m.member = 'ops_operator_api'::pg_catalog.regrole) then
    raise exception 'ops_operator_api has a member or a membership at rest';
  end if;
  select pg_catalog.string_agg(n.nspname, ', ') into v_bad from pg_catalog.pg_namespace n
   where pg_catalog.has_schema_privilege('ops_operator_api', n.oid, 'CREATE');
  if v_bad is not null or pg_catalog.has_database_privilege('ops_operator_api', pg_catalog.current_database(), 'CREATE') then
    raise exception 'ops_operator_api can create objects: %', coalesce(v_bad, 'the database');
  end if;
  if not pg_catalog.has_schema_privilege('ops_operator_api', 'ops', 'USAGE') then
    raise exception 'ops_operator_api lacks USAGE on ops';
  end if;

  -- It owns exactly the catalogue; each exposed function is DEFINER with an
  -- empty search path, and executable by authenticated and its owner only.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p where p.proowner = 'ops_operator_api'::pg_catalog.regrole
     and pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') <> all (c_l3);
  if v_bad is not null then
    raise exception 'ops_operator_api owns an uncatalogued function: %', v_bad;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'company_os_api'
     and (p.proowner <> 'ops_operator_api'::pg_catalog.regrole or not p.prosecdef or p.prokind <> 'f'
          or p.proconfig is distinct from array['search_path=""']
          or p.proacl is distinct from array['ops_operator_api=X/ops_operator_api', 'authenticated=X/ops_operator_api']::pg_catalog.aclitem[]
          or pg_catalog.replace(p.oid::pg_catalog.regprocedure::pg_catalog.text, ' ', '') <> all (c_l3));
  if v_bad is not null then
    raise exception 'company_os_api function with a wrong owner, mode, config or ACL: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'company_os_api') <> pg_catalog.array_length(c_l3, 1) then
    raise exception 'company_os_api does not hold exactly the catalogue';
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'company_os_api')
     or exists (select 1 from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'company_os_api') then
    raise exception 'company_os_api holds a relation, sequence or type';
  end if;

  -- In ops it executes exactly the gates; it touches no relation anywhere it
  -- can reach (the K2 shape).
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')
     and p.proname !~ '^gate_';
  if v_bad is not null then
    raise exception 'ops_operator_api can execute a non-gate ops function: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname ~ '^gate_' and pg_catalog.has_function_privilege('ops_operator_api', p.oid, 'EXECUTE')) <> 15 then
    raise exception 'ops_operator_api does not execute exactly the 15 gates';
  end if;
  select pg_catalog.string_agg(c.oid::pg_catalog.regclass::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname not in ('pg_catalog', 'information_schema') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and pg_catalog.has_schema_privilege('ops_operator_api', n.oid, 'USAGE')
     and (case when c.relkind = 'S' then pg_catalog.has_sequence_privilege('ops_operator_api', c.oid, 'USAGE,SELECT,UPDATE')
               else pg_catalog.has_table_privilege('ops_operator_api', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 or pg_catalog.has_any_column_privilege('ops_operator_api', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES') end);
  if v_bad is not null then
    raise exception 'ops_operator_api holds a relation privilege: %', v_bad;
  end if;

  -- No ops function is executable by PUBLIC (A3), and no default privilege
  -- reaches ops or company_os_api.
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('ops', 'company_os_api')
     and (p.proacl is null or exists (select 1 from pg_catalog.aclexplode(p.proacl) a
                                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'function executable by PUBLIC: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
              where d.defaclnamespace = 0 or n.nspname in ('ops', 'company_os_api')) then
    raise exception 'a default privilege reaches ops or company_os_api';
  end if;
  -- authenticated holds nothing on ops.
  if pg_catalog.has_schema_privilege('authenticated', 'ops', 'USAGE') or pg_catalog.has_schema_privilege('anon', 'company_os_api', 'USAGE')
     or pg_catalog.has_schema_privilege('service_role', 'company_os_api', 'USAGE') then
    raise exception 'a schema privilege on ops or company_os_api is wider than the catalogue';
  end if;
end
$end_state$;
