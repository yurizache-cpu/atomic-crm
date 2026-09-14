-- The owner-session pool channel into ops (ADR 0002, SI-27), as PostgreSQL
-- sees it. merge_contacts' pool logs in as postgres and runs every merge
-- through runAsUser (supabase/functions/_shared/db.ts):
--
--   begin; SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', $1, true); ...; commit | rollback
--
-- This suite replays that shape on ONE session, the way the pool reuses its one
-- connection, and fails by name if the downgraded transaction can reach ops, or
-- if the role, the caller's identity or any tenant context outlives the
-- transaction. ownerSessionPool.mjs proves the same through the real Deno
-- driver and Kysely.
--
-- It writes nothing outside a temporary table: every ops attempt is refused.

\set ON_ERROR_STOP 1

-- The session every transaction below must come back to.
create temporary table owner_session_probe (pid integer not null);
insert into owner_session_probe values (pg_backend_pid());

create function pg_temp.assert_clean(p_after text) returns void
language plpgsql as $$
begin
  if pg_backend_pid() <> (select pid from owner_session_probe) then
    raise exception 'E: % ran on another backend', p_after;
  end if;
  if now() <> statement_timestamp() then
    raise exception 'C/D: a transaction is still open after %', p_after;
  end if;
  if current_user <> 'postgres' or session_user <> 'postgres'
     or current_setting('role') <> 'none' then
    raise exception 'C/D: the role survived %: current_user=%, role=%',
      p_after, current_user, current_setting('role');
  end if;
  if coalesce(current_setting('request.jwt.claim.sub', true), '') <> ''
     or coalesce(current_setting('request.jwt.claims', true), '') <> '' then
    raise exception 'E: the request identity survived %', p_after;
  end if;
  if coalesce(current_setting('app.worker_id', true), '') <> ''
     or coalesce(current_setting('app.job_id', true), '') <> '' then
    raise exception 'E: a tenant context survived %', p_after;
  end if;
  if auth.uid() is not null or ops.current_tenant_id() is not null then
    raise exception 'E: an identity or a tenant still resolves after %', p_after;
  end if;
end
$$;

select pg_temp.assert_clean('the start');

-- A and B: a transaction in the merge shape runs as authenticated, as the
-- caller, and every ops read, write and function call is refused at the schema.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000c0de', true);
do $$
declare
  v_attempt text;
begin
  if current_user <> 'authenticated' or session_user <> 'postgres' then
    raise exception 'A: the downgraded transaction runs as current_user=%, session_user=%',
      current_user, session_user;
  end if;
  if auth.uid() is distinct from '00000000-0000-4000-8000-00000000c0de'::uuid then
    raise exception 'A: auth.uid() is % inside the transaction', auth.uid();
  end if;
  foreach v_attempt in array array[
    'select count(*) from ops.tenants',
    'select count(*) from ops.events',
    'insert into ops.companies (tenant_id, slug, name) values (gen_random_uuid(), ''probe'', ''Probe'')',
    'update ops.tasks set title = title',
    'delete from ops.events',
    'select ops.current_tenant_id()',
    'select ops.lease_job(''probe'', 30)',
    'select ops.enqueue_job(gen_random_uuid(), ''probe'', ''{}''::jsonb, 0, now(), 1, ''probe'')',
    'select ops.create_company(gen_random_uuid(), ''probe'', ''Probe'', ''probe'')'
  ] loop
    begin
      execute v_attempt;
      raise exception 'B: the downgraded transaction ran: %', v_attempt;
    exception when insufficient_privilege then
      if sqlerrm not like 'permission denied for schema ops%' then
        raise exception 'B: % was refused, but not at the schema: %', v_attempt, sqlerrm;
      end if;
    end;
  end loop;
  if current_user <> 'authenticated' then
    raise exception 'B: the refusals changed the role to %', current_user;
  end if;
end
$$;
commit;

-- C: COMMIT ends the role and the identity.
select pg_temp.assert_clean('COMMIT');

-- D: ROLLBACK ends them too.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000beef', true);
do $$
begin
  if current_user <> 'authenticated'
     or auth.uid() is distinct from '00000000-0000-4000-8000-00000000beef'::uuid then
    raise exception 'D: the second transaction is not the second caller';
  end if;
end
$$;
rollback;
select pg_temp.assert_clean('ROLLBACK');

-- F: a database error aborts the downgraded transaction. Whether the client
-- then sends ROLLBACK or COMMIT, nothing survives. The two errors below are
-- expected: permission denied for schema ops.
\echo 'owner_session_pool: the next two permission-denied errors are expected'
\set ON_ERROR_STOP 0
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000c0de', true);
select count(*) from ops.tenants;
rollback;
\set ON_ERROR_STOP 1
select pg_temp.assert_clean('a database error and ROLLBACK');

\set ON_ERROR_STOP 0
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000c0de', true);
select ops.current_tenant_id();
commit;
\set ON_ERROR_STOP 1
select pg_temp.assert_clean('a database error and COMMIT');

-- Characterisation, not a guarantee: the owner session CAN switch back, so the
-- role switch is not a privilege boundary. Containment rests on the pool
-- running only fixed statements (SI-03) and on authenticated holding nothing
-- in ops. If this ever stops returning postgres, revisit SI-27's wording.
begin;
set local role authenticated;
do $$
begin
  execute 'reset role';
  if current_user <> 'postgres' then
    raise exception 'characterisation changed: RESET ROLE now yields %', current_user;
  end if;
end
$$;
rollback;
select pg_temp.assert_clean('the characterisation');

drop table owner_session_probe;
\echo 'owner_session_pool: the downgraded transaction reaches nothing in ops, and nothing outlives it'
