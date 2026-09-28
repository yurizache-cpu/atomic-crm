-- PRODUCTION SECURITY GATE A, attacked in SQL.
--
-- The question: can any role still execute the CRM's public helpers through
-- PUBLIC, can the roles that need them still work, and can anyone reach the
-- Company OS authority below multi-factor assurance, or waive it from a
-- request?
--
--   A  the reviewed public functions: no PUBLIC or anon EXECUTE; exactly eight
--      for authenticated, whose policies and triggers still run; nothing for
--      the Company OS capability roles; no browser path into those roles;
--      tenant isolation unchanged;
--   B  multi-factor assurance at ops.operator_scope(), the one resolver every
--      company_os_api function calls: aal2 on BOTH the provider's session row
--      and the verified claims, or OS401; a request can raise neither; the
--      existing refusals still apply at aal2 (no membership, a revoked one,
--      another tenant, an ended session);
--   C  the non-production exemption: it waives only the assurance level, no
--      application role can read or write it, at most one row, and no
--      migration ships it (20261004120000 asserts that).
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only.

\set ON_ERROR_STOP on

begin;

create temporary table ps_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into ps_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from ps_ids where name = p_name;
  if v is null then raise exception 'setup: no id named %', p_name; end if;
  return v;
end
$$;

create function pg_temp.attempt(p_sql text) returns text
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return sqlstate;
  end;
  return null;
end
$$;

-- Verified claims for a user's session, at an assurance level.
create function pg_temp.claims(p_who text, p_aal text, p_session text default null) returns text
language sql as $$
  select jsonb_build_object(
    'sub', pg_temp.id('user.' || p_who), 'role', 'authenticated', 'aud', 'authenticated',
    'session_id', pg_temp.id('session.' || coalesce(p_session, p_who)), 'is_anonymous', false,
    'aal', p_aal, 'exp', extract(epoch from now() + interval '1 hour')::bigint)::text;
$$;

-- One simulated PostgREST request: the claims, then the call as authenticated.
-- Answers {ok, body} or {ok: false, code}.
create function pg_temp.api(p_claims text, p_call text, p_legacy_aal text default null) returns jsonb
language plpgsql as $f$
declare
  v_body  jsonb;
  v_state text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  perform set_config('request.jwt.claim.aal', coalesce(p_legacy_aal, ''), true);
  begin
    set local role authenticated;
    execute 'select ' || p_call into v_body;
    reset role;
    return jsonb_build_object('ok', true, 'body', v_body);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    return jsonb_build_object('ok', false, 'code', v_state);
  end;
end
$f$;

create function pg_temp.expect_code(p_label text, p_answer jsonb, p_code text) returns void
language plpgsql as $$
begin
  if (p_answer ->> 'ok')::boolean or p_answer ->> 'code' is distinct from p_code then
    raise exception '%: expected %, got %', p_label, p_code, p_answer;
  end if;
end
$$;

-- ===========================================================================
-- A. The reviewed public functions.
-- ===========================================================================

do $$
declare
  v_bad text;
  v_role text;
begin
  -- A1 PUBLIC and anon execute nothing in public.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A1: a public function is still executable by PUBLIC or anon: %', v_bad;
  end if;

  -- A2 authenticated executes exactly the eight reviewed functions.
  select string_agg(p.proname || '(' || oidvectortypes(p.proargtypes) || ')', ', '
                    order by p.proname || '(' || oidvectortypes(p.proargtypes) || ')') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_bad is distinct from
     'can_access_contact(bigint), can_access_deal(bigint), can_manage_sales_id(bigint), current_sales_id(), '
     || 'get_avatar_for_email(text), get_domain_favicon(text), is_active_sales_user(), is_admin()' then
    raise exception 'A2: authenticated executes other than the eight reviewed public functions: %', v_bad;
  end if;

  -- A3 the Company OS capability roles execute nothing in public, and no
  --    browser role is a member of one.
  foreach v_role in array array['ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    select string_agg(p.oid::regprocedure::text, ', ') into v_bad
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege(v_role, p.oid, 'EXECUTE');
    if v_bad is not null then
      raise exception 'A3: % executes public functions: %', v_role, v_bad;
    end if;
    if pg_has_role('authenticated', v_role, 'MEMBER') or pg_has_role('anon', v_role, 'MEMBER') then
      raise exception 'A3: a browser role is a member of %', v_role;
    end if;
  end loop;
end
$$;

-- The CRM's own users, as rls_tenant_isolation.sql makes them.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ps-alpha@test.local', 'x', now(), now(), now(), '{}', '{"first_name":"Alpha","last_name":"Operator"}'),
  ('bbbbbbbb-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'ps-beta@test.local', 'x', now(), now(), now(), '{}', '{"first_name":"Beta","last_name":"Operator"}');

insert into public.contacts (first_name, last_name, sales_id)
select 'Contact', 'OfBetaPS', s.id from public.sales s where s.user_id = 'bbbbbbbb-0000-0000-0000-0000000000b2';

do $$
declare
  v_state text;
  v_n     int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1"}';

  -- A4 the policies still run their helpers, and the stamping triggers theirs.
  insert into public.contacts (first_name, last_name, sales_id, email_jsonb)
  values ('Synthetic', 'OfAlphaPS', public.current_sales_id(),
          '[{"email": "synthetic.alpha@example.test", "type": "Work"}]');
  insert into public.companies (name, website, sales_id)
  values ('Synthetic Company PS', 'https://example.test', public.current_sales_id());
  select count(*) into v_n from public.contacts where last_name = 'OfAlphaPS';
  if v_n <> 1 then
    raise exception 'A4: authenticated could not read back its own contact';
  end if;

  -- A5 tenant isolation is unchanged: another operator's contact stays hidden.
  select count(*) into v_n from public.contacts where last_name = 'OfBetaPS';
  if v_n <> 0 then
    raise exception 'A5: operator A reads operator B''s contact';
  end if;

  -- A6 what authenticated lost: the uncalled merge function and the internal
  --    URL helper. (Membership of a capability role is A3's: SET ROLE is
  --    checked against the session user, so it cannot be probed from here.)
  foreach v_state in array array[
    pg_temp.attempt('select public.merge_contacts(1, 2)'),
    pg_temp.attempt('select public.get_note_attachments_function_url()')] loop
    if v_state is distinct from '42501' then
      reset role;
      raise exception 'A6: authenticated still reached a revoked function (%)', coalesce(v_state, 'success');
    end if;
  end loop;
  reset role;

  -- A7 anon reaches no helper at all.
  set local role anon;
  v_state := pg_temp.attempt('select public.is_admin()');
  reset role;
  if v_state is distinct from '42501' then
    raise exception 'A7: anon executed a row-security helper (%)', coalesce(v_state, 'success');
  end if;
end
$$;

-- ===========================================================================
-- B. Multi-factor assurance at the Company OS authority boundary.
-- ===========================================================================

do $$
declare
  ta uuid; tb uuid;
  v_user uuid;
  v_who text;
  v_principal uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('ps-alpha', 'PS Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('ps-beta', 'PS Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);

  foreach v_who in array array['member', 'nonmember', 'revoked', 'beta'] loop
    v_user := pg_temp.remember('user.' || v_who, gen_random_uuid());
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            format('ps-mfa-%s@test.local', v_who), 'x', now(), now(), now(), '{}',
            jsonb_build_object('first_name', 'Synthetic', 'last_name', v_who));
    -- One session at assurance level 2 for everyone ...
    insert into auth.sessions (id, user_id, created_at, updated_at, aal)
    values (pg_temp.remember('session.' || v_who, gen_random_uuid()), v_user, now(), now(), 'aal2');
  end loop;
  -- ... and, for the member, one at level 1 and one that has ended.
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (pg_temp.remember('session.member_aal1', gen_random_uuid()), pg_temp.id('user.member'), now(), now(), 'aal1');
  insert into auth.sessions (id, user_id, created_at, updated_at, aal, not_after)
  values (pg_temp.remember('session.member_ended', gen_random_uuid()), pg_temp.id('user.member'),
          now() - interval '2 hours', now() - interval '2 hours', 'aal2', now() - interval '1 minute');

  foreach v_who in array array['member', 'revoked'] loop
    perform pg_temp.remember('membership.' || v_who, (ops.grant_membership(
      ta, pg_temp.id('user.' || v_who), 'PS ' || v_who, 'ps-owner', 'synthetic suite member') ->> 'membershipId')::uuid);
  end loop;
  perform ops.revoke_membership(pg_temp.id('membership.revoked'), 'ps-owner', 'synthetic revoke');
  -- A member of tenant B, which the eligibility policy refuses: an owner fixture.
  insert into ops.principals (kind, issuer, subject, display_name, created_by)
  values ('human', 'supabase_auth', pg_temp.id('user.beta'), 'PS beta', 'ps-owner')
  returning id into v_principal;
  insert into ops.tenant_memberships (principal_id, tenant_id, email_at_grant_sha256, granted_by, grant_reason)
  values (v_principal, tb, repeat('b', 64), 'ps-owner', 'owner fixture');

  -- The production state: no non-production exemption.
  delete from ops.operator_assurance_exemption;
end
$$;

do $$
declare
  v jsonb;
begin
  -- B1 a session at level 1: refused, however the rest is right.
  perform pg_temp.expect_code('B1 aal1 session, aal1 claims',
    pg_temp.api(pg_temp.claims('member', 'aal1', 'member_aal1'), 'company_os_api.operator_context()'), 'OS401');
  -- B2 the request cannot raise it: aal2 claims over an aal1 session, a legacy
  --    per-claim setting, or no aal claim at all.
  perform pg_temp.expect_code('B2 aal2 claims over an aal1 session',
    pg_temp.api(pg_temp.claims('member', 'aal2', 'member_aal1'), 'company_os_api.operator_context()'), 'OS401');
  perform pg_temp.expect_code('B2 a legacy aal claim setting',
    pg_temp.api(pg_temp.claims('member', 'aal1', 'member_aal1'), 'company_os_api.operator_context()', 'aal2'), 'OS401');
  perform pg_temp.expect_code('B2 an aal2 session whose token says aal1',
    pg_temp.api(pg_temp.claims('member', 'aal1'), 'company_os_api.operator_context()'), 'OS401');
  perform pg_temp.expect_code('B2 no aal claim',
    pg_temp.api((pg_temp.claims('member', 'aal2')::jsonb - 'aal')::text, 'company_os_api.operator_context()'), 'OS401');
  -- B3 every act and read refuses the same way, since all resolve through it.
  perform pg_temp.expect_code('B3 an act at aal1',
    pg_temp.api(pg_temp.claims('member', 'aal1', 'member_aal1'),
                format('company_os_api.trip_stop(%L, %L)', 'tenant', pg_temp.id('tenant_a'))), 'OS401');
  perform pg_temp.expect_code('B3 a read at aal1',
    pg_temp.api(pg_temp.claims('member', 'aal1', 'member_aal1'), 'company_os_api.overview()'), 'OS401');

  -- B4 at level 2 on both: the existing permissions decide.
  v := pg_temp.api(pg_temp.claims('member', 'aal2'), 'company_os_api.operator_context()');
  if not (v ->> 'ok')::boolean or (v -> 'body' -> 'tenant' ->> 'id')::uuid is distinct from pg_temp.id('tenant_a') then
    raise exception 'B4: an aal2 member did not reach its own tenant (%)', v;
  end if;
  perform pg_temp.expect_code('B4 no membership at aal2',
    pg_temp.api(pg_temp.claims('nonmember', 'aal2'), 'company_os_api.operator_context()'), 'OS403');
  perform pg_temp.expect_code('B4 a revoked membership at aal2',
    pg_temp.api(pg_temp.claims('revoked', 'aal2'), 'company_os_api.operator_context()'), 'OS403');
  perform pg_temp.expect_code('B4 another tenant at aal2',
    pg_temp.api(pg_temp.claims('beta', 'aal2'), 'company_os_api.operator_context()'), 'OS403');
  perform pg_temp.expect_code('B4 an ended session at aal2',
    pg_temp.api(pg_temp.claims('member', 'aal2', 'member_ended'), 'company_os_api.operator_context()'), 'OS401');
end
$$;

-- B5 ONE resolver: every company_os_api gate resolves its caller through it.
do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname like 'gate\_%' and p.prosrc !~ 'ops\.operator_scope\(\)';
  if v_bad is not null then
    raise exception 'B5: a company_os_api gate bypasses the resolver: %', v_bad;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'company_os_api' and p.prosrc !~ '^\s*select ops\.gate_[a-z_]+\(') then
    raise exception 'B5: a company_os_api function does not go straight to its gate';
  end if;
end
$$;

-- ===========================================================================
-- C. The non-production exemption.
-- ===========================================================================

do $$
declare
  v jsonb;
  v_role text;
begin
  -- C1 recorded by the owner, it waives the assurance level and nothing else.
  insert into ops.operator_assurance_exemption (reason, recorded_by) values ('ps suite: local only', 'ps-owner');
  v := pg_temp.api(pg_temp.claims('member', 'aal1', 'member_aal1'), 'company_os_api.operator_context()');
  if not (v ->> 'ok')::boolean then
    raise exception 'C1: the non-production exemption did not waive the assurance level (%)', v;
  end if;
  perform pg_temp.expect_code('C1 no membership under the exemption',
    pg_temp.api(pg_temp.claims('nonmember', 'aal2'), 'company_os_api.operator_context()'), 'OS403');
  -- C2 at most one row.
  if pg_temp.attempt($q$insert into ops.operator_assurance_exemption (reason, recorded_by) values ('again', 'ps-owner')$q$)
     is distinct from '23505' then
    raise exception 'C2: a second exemption row was accepted';
  end if;
  -- C3 no application role can read or write it.
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_table_privilege(v_role, 'ops.operator_assurance_exemption', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'C3: % holds a privilege on the assurance exemption', v_role;
    end if;
  end loop;
end
$$;

select 'production_security: PASS' as result;

rollback;
