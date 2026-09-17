-- Owner provisioning (Phase 1D.2, finding 2).
--
-- public.bootstrap_owner (20260917180200) is the only path to an owner outside
-- the application: a person holding the database credential runs it, and only
-- while no active owner exists. This suite proves:
--   A. no application role can reach it or its log, through grants or roles;
--   B. it refuses every user it must refuse, and every isolation level at which
--      its check could read a stale snapshot;
--   C. it makes exactly one owner, records the act, and holds the lock that
--      serialises a concurrent bootstrap until commit;
--   D. a second bootstrap is refused while an owner is active, and allowed
--      again only when no owner is active;
--   E. is_admin() still requires role = 'owner' AND disabled = false, and the
--      signup trigger still ignores metadata that claims ownership.
--
-- HOW IT RUNS: npm run test:db. Every transaction ends in ROLLBACK, and any
-- failed assertion raises, which makes psql exit non-zero. Synthetic users only.

\set ON_ERROR_STOP on

-- ===========================================================================
-- B1. Refused above READ COMMITTED. Its own transaction: the isolation level
--     can only be chosen before the first statement.
-- ===========================================================================

begin isolation level repeatable read;

do $$
begin
  begin
    perform public.bootstrap_owner('00000000-0000-0000-0000-0000000000b1', 'suite', 'isolation probe');
    raise exception 'bootstrap_owner ran at REPEATABLE READ, where its owner check can read a stale snapshot';
  exception
    when raise_exception then
      -- Any other refusal means the function read the database first.
      if sqlerrm not like 'bootstrap_owner must run at READ COMMITTED%' then
        raise exception 'bootstrap_owner ran at REPEATABLE READ instead of refusing it first (it said: %)', sqlerrm;
      end if;
  end;
end
$$;

rollback;

begin;

-- ---------------------------------------------------------------------------
-- Helpers. Both run as postgres and switch role inside, like PostgREST.
-- ---------------------------------------------------------------------------

create function pg_temp.is_admin_as(p_user uuid) returns boolean
language plpgsql as $$
declare
  v_result boolean;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_result := public.is_admin();
  execute 'reset role';
  return v_result;
end
$$;

-- Runs p_sql and requires it to fail with a message LIKE p_message.
create function pg_temp.expect_refusal(p_sql text, p_message text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception
    when others then
      if sqlerrm like p_message then
        return;
      end if;
      raise exception 'expected a refusal like "%", got "%": %', p_message, sqlerrm, p_sql;
  end;
  raise exception 'expected a refusal like "%", but it succeeded: %', p_message, p_sql;
end
$$;

-- ===========================================================================
-- A. No application role reaches the bootstrap or its log.
-- ===========================================================================

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_role, 'public.bootstrap_owner(uuid, text, text)', 'execute') then
      raise exception '% can execute public.bootstrap_owner', v_role;
    end if;
    if has_table_privilege(v_role, 'public.owner_provisioning_log',
                           'select, insert, update, delete, truncate, references, trigger')
       or has_sequence_privilege(v_role, 'public.owner_provisioning_log_id_seq', 'usage, select, update') then
      raise exception '% holds a privilege on public.owner_provisioning_log', v_role;
    end if;
  end loop;

  if exists (
    select 1
      from pg_proc p, aclexplode(p.proacl) a
     where p.oid = 'public.bootstrap_owner(uuid, text, text)'::regprocedure
       and a.grantee = 0
  ) then
    raise exception 'PUBLIC can execute public.bootstrap_owner';
  end if;

  if (select prosecdef from pg_proc
       where oid = 'public.bootstrap_owner(uuid, text, text)'::regprocedure) then
    raise exception 'public.bootstrap_owner is SECURITY DEFINER: a leaked grant would run it as its owner';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.owner_provisioning_log'::regclass)
     or exists (select 1 from pg_policy
                 where polrelid = 'public.owner_provisioning_log'::regclass) then
    raise exception 'public.owner_provisioning_log must have RLS on and no policy';
  end if;
end
$$;

-- A2. The same, measured through the roles themselves.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    execute format('set local role %I', v_role);
    begin
      perform public.bootstrap_owner('00000000-0000-0000-0000-0000000000a2', 'suite', 'role probe');
      raise exception '% executed public.bootstrap_owner', v_role;
    exception
      when insufficient_privilege then
        null;
    end;
    begin
      perform 1 from public.owner_provisioning_log limit 1;
      raise exception '% read public.owner_provisioning_log', v_role;
    exception
      when insufficient_privilege then
        null;
    end;
    execute 'reset role';
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Fixtures. Inserting into auth.users fires handle_new_user, the same path a
-- user added in the dashboard takes. Any owner the database already has is
-- disabled for this transaction only, so the bootstrap path is open.
-- ---------------------------------------------------------------------------

update public.sales
   set disabled = true
 where role = 'owner' and administrator and not disabled;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, banned_until, deleted_at,
                        created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('0b000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-a@test.local', 'x',
   now(), null, null, now(), now(), '{}', '{"first_name":"Boot","last_name":"Alpha"}'),
  ('0b000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-b@test.local', 'x',
   now(), null, null, now(), now(), '{}', '{"first_name":"Boot","last_name":"Beta"}'),
  ('0b000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-unconfirmed@test.local', 'x',
   null, null, null, now(), now(), '{}', '{}'),
  ('0b000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-disabled@test.local', 'x',
   now(), null, null, now(), now(), '{}', '{}'),
  ('0b000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-banned@test.local', 'x',
   now(), now() + interval '1 day', null, now(), now(), '{}', '{}'),
  ('0b000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-deleted@test.local', 'x',
   now(), null, now(), now(), now(), '{}', '{}'),
  ('0b000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'bootstrap-claims@test.local', 'x',
   now(), null, null, now(), now(), '{"role":"owner"}',
   '{"first_name":"Claims","administrator":true,"role":"owner","custom_claims":{"role":"owner"}}');

update public.sales set disabled = true
 where user_id = '0b000000-0000-0000-0000-00000000000d';

-- ===========================================================================
-- E2. The signup trigger ignores metadata that claims ownership.
-- ===========================================================================

do $$
begin
  if (select role from public.sales where user_id = '0b000000-0000-0000-0000-000000000010') <> 'operator'
     or (select administrator from public.sales where user_id = '0b000000-0000-0000-0000-000000000010') then
    raise exception 'handle_new_user trusted metadata that claims ownership';
  end if;
end
$$;

-- ===========================================================================
-- B2. Refusals. None of them may leave an owner or a log row behind.
-- ===========================================================================

select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-0000000000ff', 'suite', 'unknown user')$q$,
  'no CRM user belongs to auth user %');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000c', 'suite', 'unconfirmed')$q$,
  'auth user % is unconfirmed, banned or deleted');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000e', 'suite', 'banned')$q$,
  'auth user % is unconfirmed, banned or deleted');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000f', 'suite', 'deleted')$q$,
  'auth user % is unconfirmed, banned or deleted');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000d', 'suite', 'disabled')$q$,
  'CRM user % is disabled');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner(null, 'suite', 'no user')$q$,
  'bootstrap_owner needs an auth user id, an actor and a reason');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000a', '   ', 'blank actor')$q$,
  'bootstrap_owner needs an auth user id, an actor and a reason');
select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000a', 'suite', null)$q$,
  'bootstrap_owner needs an auth user id, an actor and a reason');

do $$
begin
  if exists (select 1 from public.sales where role = 'owner' and not disabled)
     or exists (select 1 from public.owner_provisioning_log
                 where user_id::text like '0b000000-%') then
    raise exception 'a refused bootstrap left an owner or a log row behind';
  end if;
end
$$;

-- ===========================================================================
-- C. One bootstrap: exactly one owner, one log row, and the serialising lock.
-- ===========================================================================

create temporary table bootstrap_result on commit drop as
select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000a', '  suite actor  ', '  first owner  ')
  as sales_id;

do $$
declare
  v_alpha bigint;
begin
  select id into v_alpha from public.sales where user_id = '0b000000-0000-0000-0000-00000000000a';
  if (select sales_id from bootstrap_result) is distinct from v_alpha then
    raise exception 'bootstrap_owner returned %, not the sales id % of the user it promoted',
      (select sales_id from bootstrap_result), v_alpha;
  end if;
  if (select (role, administrator, disabled) from public.sales where id = v_alpha)
     is distinct from ('owner'::text, true, false) then
    raise exception 'the bootstrapped user is not an active owner';
  end if;
  if (select count(*) from public.sales where role = 'owner' and not disabled) <> 1 then
    raise exception 'the bootstrap produced % active owners, expected 1',
      (select count(*) from public.sales where role = 'owner' and not disabled);
  end if;
  if (select array_agg(format('%s|%s|%s|%s|%s', sales_id, user_id, action, actor, reason))
        from public.owner_provisioning_log
       where user_id::text like '0b000000-%')
     is distinct from array[format('%s|0b000000-0000-0000-0000-00000000000a|bootstrap_owner|suite actor|first owner', v_alpha)] then
    raise exception 'the bootstrap was not recorded exactly once, trimmed, against the right user';
  end if;

  -- The lock that makes a concurrent bootstrap wait for this one to commit and
  -- then see its owner. Without it, two bootstraps could both find no owner.
  if not exists (
    select 1
      from pg_locks
     where locktype = 'relation'
       and relation = 'public.sales'::regclass
       and pid = pg_backend_pid()
       and mode = 'ShareRowExclusiveLock'
       and granted
  ) then
    raise exception 'bootstrap_owner does not hold SHARE ROW EXCLUSIVE on public.sales until commit';
  end if;
end
$$;

do $$
begin
  if not pg_temp.is_admin_as('0b000000-0000-0000-0000-00000000000a') then
    raise exception 'the bootstrapped owner is not an administrator';
  end if;
  if pg_temp.is_admin_as('0b000000-0000-0000-0000-00000000000b') then
    raise exception 'an operator is an administrator';
  end if;
end
$$;

-- ===========================================================================
-- D. A second bootstrap is refused while an owner is active.
-- ===========================================================================

select pg_temp.expect_refusal(
  $q$select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000b', 'suite', 'second owner')$q$,
  'an active owner already exists%');

do $$
begin
  if (select role from public.sales where user_id = '0b000000-0000-0000-0000-00000000000b') <> 'operator'
     or (select count(*) from public.owner_provisioning_log where user_id::text like '0b000000-%') <> 1 then
    raise exception 'a refused second bootstrap changed a role or wrote a log row';
  end if;
end
$$;

-- ===========================================================================
-- E1. is_admin() keeps both conditions the upgrade relies on.
-- ===========================================================================

-- An administrator flag without the owner role grants nothing: the half state
-- pending_delta left behind.
update public.sales set administrator = true
 where user_id = '0b000000-0000-0000-0000-00000000000b';

-- A disabled owner is not an administrator.
update public.sales set disabled = true
 where user_id = '0b000000-0000-0000-0000-00000000000a';

do $$
begin
  if pg_temp.is_admin_as('0b000000-0000-0000-0000-00000000000b') then
    raise exception 'is_admin() accepted administrator = true without role = owner';
  end if;
  if pg_temp.is_admin_as('0b000000-0000-0000-0000-00000000000a') then
    raise exception 'is_admin() accepted a disabled owner';
  end if;
end
$$;

-- D2. With no ACTIVE owner left, a person can bootstrap again: the break-glass
--     path an instance whose owners were all disabled needs. It sets both
--     columns, whatever state the row was in.
select public.bootstrap_owner('0b000000-0000-0000-0000-00000000000b', 'suite', 'break glass');

do $$
begin
  if (select (role, administrator) from public.sales
       where user_id = '0b000000-0000-0000-0000-00000000000b')
     is distinct from ('owner'::text, true) then
    raise exception 'the second bootstrap did not make an owner';
  end if;
  if (select count(*) from public.sales where role = 'owner' and not disabled) <> 1
     or (select count(*) from public.owner_provisioning_log where user_id::text like '0b000000-%') <> 2 then
    raise exception 'the break-glass bootstrap did not leave exactly one active owner and two log rows';
  end if;
  if not pg_temp.is_admin_as('0b000000-0000-0000-0000-00000000000b') then
    raise exception 'the break-glass owner is not an administrator';
  end if;
end
$$;

rollback;
