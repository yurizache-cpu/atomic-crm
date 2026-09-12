-- Phase 1A — attacks on the tenant-safe execution substrate.
--
-- The question this file exists to answer: can a background worker lease and
-- execute a job for exactly one tenant, without being able to read or mutate
-- another tenant's rows, and without relying on service_role or BYPASSRLS?
--
-- WHY THIS SUITE COMMITS, unlike the other two in this directory.
-- `rls_tenant_isolation.sql` and `worker_tenant_context.sql` are one rolled-back
-- transaction each. That shape cannot test the property that matters most here:
-- whether tenant context survives a COMMIT onto a reused connection. A rollback
-- reverts a plain `SET` as well as a `SET LOCAL`, so a rolled-back test passes
-- either way — Phase 0.5 hit exactly that and had to be corrected. So this file
-- commits real fixtures on one psql connection, and cleans up at both ends.
-- Every fixture is keyed by the `phase1a-test-` slug prefix, and the first
-- statement removes anything left by a previous failed run, so it is rerunnable.
--
-- Concurrency (case G) needs two simultaneous connections and therefore cannot
-- live in this file at all; it is driven from scripts/run-db-tests.mjs.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Idempotent start: clear anything a previous failed run committed.
-- ---------------------------------------------------------------------------
delete from ops.job_events e
 using ops.tenants t
 where e.tenant_id = t.id and t.slug like 'phase1a-test-%';
delete from ops.jobs j
 using ops.tenants t
 where j.tenant_id = t.id and t.slug like 'phase1a-test-%';
delete from ops.tenants where slug like 'phase1a-test-%';

-- Membership is needed to `set role ops_worker`. `grant <role> to current_user`
-- SEGFAULTS this server build (observed 2026-09-11, Postgres 15.8); interpolate.
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants, two jobs each.
-- ---------------------------------------------------------------------------
insert into ops.tenants (slug, name) values
  ('phase1a-test-alpha', 'Tenant Alpha'),
  ('phase1a-test-beta',  'Tenant Beta');

select ops.enqueue_job(t.id, 'probe', jsonb_build_object('owner', t.slug), 100)
  from ops.tenants t where t.slug = 'phase1a-test-alpha';
select ops.enqueue_job(t.id, 'probe-two', jsonb_build_object('owner', t.slug), 200)
  from ops.tenants t where t.slug = 'phase1a-test-alpha';
select ops.enqueue_job(t.id, 'probe', jsonb_build_object('owner', t.slug), 100)
  from ops.tenants t where t.slug = 'phase1a-test-beta';
select ops.enqueue_job(t.id, 'probe-two', jsonb_build_object('owner', t.slug), 200)
  from ops.tenants t where t.slug = 'phase1a-test-beta';

-- ===========================================================================
-- E. THE WORKER ROLE CARRIES NO BLANKET CAPABILITY
--    Asserted first because every case below is vacuous if it fails.
-- ===========================================================================
do $$
declare r record;
begin
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
    into r from pg_roles where rolname = 'ops_worker';
  if r.rolsuper      then raise exception 'E: ops_worker is SUPERUSER'; end if;
  if r.rolbypassrls  then raise exception 'E: ops_worker has BYPASSRLS'; end if;
  if r.rolcreaterole then raise exception 'E: ops_worker has CREATEROLE'; end if;
  if r.rolcreatedb   then raise exception 'E: ops_worker has CREATEDB'; end if;
  if r.rolcanlogin   then raise exception 'E: ops_worker can LOGIN'; end if;
end
$$;

-- ===========================================================================
-- RLS is enabled AND forced on every ops table.
--    FORCE does not constrain `postgres` (rolbypassrls = true), so it changes
--    nothing for the worker today -- the worker is not the owner. It is
--    asserted because ownership is exactly the kind of thing that changes
--    quietly, and the day an ops table is owned by a non-bypass role, FORCE is
--    the only thing standing between that role and every tenant.
-- ===========================================================================
do $$
declare v_bad text;
begin
  select string_agg(c.relname, ', ')
    into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'ops table(s) % lack ENABLE + FORCE row level security', v_bad;
  end if;
end
$$;

-- ===========================================================================
-- THE LEASE BINDING ITSELF -- the property this design turns on.
--
--    ops.current_tenant_id() resolves the tenant from a LIVE LEASE, not from a
--    tenant GUC the worker can write. Measured in Phase 1A's probes: a worker
--    CAN set any GUC it likes (set_config is executable by PUBLIC), so a bare
--    `app.tenant_id` would make "which tenant am I" an assertion by the worker
--    rather than a fact the database checks.
--
--    These three forgeries must all resolve to NO tenant.
-- ===========================================================================
do $$
declare
  v_alpha  uuid;
  v_beta   uuid;
  v_job_b  uuid;
begin
  select id into v_alpha from ops.tenants where slug = 'phase1a-test-alpha';
  select id into v_beta  from ops.tenants where slug = 'phase1a-test-beta';
  select id into v_job_b from ops.jobs where tenant_id = v_beta and status = 'queued' limit 1;

  -- 1. Naming a QUEUED job of another tenant: not leased, so no tenant.
  perform set_config('app.worker_id', 'forger', true);
  perform set_config('app.job_id', v_job_b::text, true);
  if ops.current_tenant_id() is not null then
    raise exception 'forgery 1: naming another tenant''s QUEUED job resolved to a tenant';
  end if;

  -- 2. Naming a job that IS leased, but by a different worker.
  update ops.jobs
     set status = 'leased', lease_owner = 'the-real-worker', leased_at = now(),
         lease_expires_at = now() + interval '1 hour'
   where id = v_job_b;
  perform set_config('app.worker_id', 'forger', true);
  perform set_config('app.job_id', v_job_b::text, true);
  if ops.current_tenant_id() is not null then
    raise exception 'forgery 2: a lease held by another worker resolved to a tenant. lease_owner is not being checked.';
  end if;

  -- 3. The right worker, but an EXPIRED lease.
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = v_job_b;
  perform set_config('app.worker_id', 'the-real-worker', true);
  perform set_config('app.job_id', v_job_b::text, true);
  if ops.current_tenant_id() is not null then
    raise exception 'forgery 3: an EXPIRED lease still resolved to a tenant';
  end if;

  -- Sanity: the same identifiers, with a live lease, DO resolve. Without this
  -- the three assertions above could pass because the helper always returns
  -- null, which would be a broken guard rather than a working one.
  update ops.jobs set lease_expires_at = now() + interval '1 hour' where id = v_job_b;
  if ops.current_tenant_id() is distinct from v_beta then
    raise exception 'the lease binding resolves to nothing even for a valid live lease; the helper is simply broken';
  end if;

  -- Put it back.
  update ops.jobs
     set status = 'queued', lease_owner = null, leased_at = null, lease_expires_at = null
   where id = v_job_b;
  perform set_config('app.worker_id', '', true);
  perform set_config('app.job_id', '', true);
end
$$;

-- ===========================================================================
-- B. NO CONTEXT READS NOTHING
--    Not "reads its own rows" — nothing. A worker between jobs holds no tenant.
-- ===========================================================================
begin;
set local role ops_worker;
do $$
declare n bigint;
begin
  if ops.current_tenant_id() is not null then
    raise exception 'B: current_tenant_id() is non-null with no lease held';
  end if;
  select count(*) into n from ops.jobs;
  if n <> 0 then raise exception 'B: % job rows visible with no lease; missing context must fail closed, not open', n; end if;
  select count(*) into n from ops.tenants;
  if n <> 0 then raise exception 'B: % tenant rows visible with no lease', n; end if;
  select count(*) into n from ops.job_events;
  if n <> 0 then raise exception 'B: % job_event rows visible with no lease', n; end if;
end
$$;
rollback;

-- ===========================================================================
-- C. MALFORMED CONTEXT DOES NOT BROADEN ACCESS
--    A non-uuid in app.job_id raises rather than degrading to "no context".
--    Both fail closed; raising is chosen because garbage in that GUC is never
--    a normal state and should be loud.
-- ===========================================================================
begin;
set local role ops_worker;
do $$
declare
  n       bigint;
  raised  boolean := false;
begin
  perform set_config('app.worker_id', 'attacker', true);
  perform set_config('app.job_id', 'not-a-uuid', true);
  begin
    select count(*) into n from ops.jobs;
  exception when others then
    raised := true;
  end;
  if not raised and n <> 0 then
    raise exception 'C: a malformed app.job_id exposed % rows', n;
  end if;
end
$$;
rollback;

-- A well-formed but unknown job id is the quieter case: it must resolve to no
-- tenant, not to an arbitrary one.
begin;
set local role ops_worker;
do $$
declare n bigint;
begin
  perform set_config('app.worker_id', 'attacker', true);
  perform set_config('app.job_id', '00000000-0000-0000-0000-000000000000', true);
  if ops.current_tenant_id() is not null then
    raise exception 'C: an unknown job id resolved to a tenant';
  end if;
  select count(*) into n from ops.jobs;
  if n <> 0 then raise exception 'C: an unknown job id exposed % rows', n; end if;
end
$$;
rollback;

-- ===========================================================================
-- A + I. TENANT ISOLATION UNDER A REAL LEASE
--
--    The worker leases whatever the queue hands it, then must see that tenant
--    and only that tenant — including in `job_events`, which is the closest
--    thing to tenant business data that exists in this phase.
-- ===========================================================================
begin;
set local role ops_worker;
do $$
declare
  v_job    ops.jobs;
  v_tenant uuid;
  v_other  uuid;
  n        bigint;
begin
  v_job := ops.lease_job('worker-A', 60);
  if v_job.id is null then raise exception 'A: nothing could be leased'; end if;
  v_tenant := v_job.tenant_id;

  if ops.current_tenant_id() is distinct from v_tenant then
    raise exception 'A: current_tenant_id() (%) does not match the leased job''s tenant (%)',
      ops.current_tenant_id(), v_tenant;
  end if;

  select t.id into v_other from ops.tenants t
   where t.slug like 'phase1a-test-%' and t.id <> v_tenant limit 1;
  -- read as postgres would be blocked here, so resolve the other tenant the
  -- only way the worker could: it cannot. Fetch it through the definer helper
  -- the test owns, outside the role switch, below.

  -- Own tenant: visible.
  select count(*) into n from ops.tenants;
  if n <> 1 then raise exception 'A: worker sees % tenant rows, expected exactly its own 1', n; end if;

  select count(*) into n from ops.jobs where tenant_id = v_tenant;
  if n <> 2 then raise exception 'A: worker sees % of its own tenant''s 2 jobs', n; end if;

  -- Every visible row belongs to the leased tenant. Written as "no row escapes"
  -- rather than "the count is right", so a widened policy cannot pass by
  -- coincidence.
  select count(*) into n from ops.jobs where tenant_id <> v_tenant;
  if n <> 0 then raise exception 'A: % job rows from another tenant are visible', n; end if;

  select count(*) into n from ops.job_events where tenant_id <> v_tenant;
  if n <> 0 then raise exception 'I: % job_event rows from another tenant are visible', n; end if;

  select count(*) into n from ops.tenants where id <> v_tenant;
  if n <> 0 then raise exception 'A: % other tenant rows are visible', n; end if;
end
$$;
rollback;

-- ===========================================================================
-- A (writes). THE WORKER HOLDS NO WRITE VERB AT ALL.
--    Cross-tenant mutation is not merely filtered here, it is ungranted — so
--    the attempt fails at the privilege layer, which is a stronger guarantee
--    than "the policy matched no rows".
-- ===========================================================================
begin;
set local role ops_worker;
do $$
declare
  v_job     ops.jobs;
  v_blocked integer := 0;
begin
  v_job := ops.lease_job('worker-A', 60);

  begin
    update ops.jobs set status = 'succeeded';
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;
  begin
    delete from ops.jobs;
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;
  begin
    insert into ops.jobs (tenant_id, kind) values (v_job.tenant_id, 'planted');
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;
  begin
    insert into ops.job_events (job_id, tenant_id, event)
    values (v_job.id, v_job.tenant_id, 'succeeded');
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;
  begin
    update ops.tenants set name = 'hijacked';
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;

  if v_blocked <> 5 then
    raise exception 'A: only % of 5 write attempts were refused; the worker must hold no write verb in ops', v_blocked;
  end if;
end
$$;
rollback;

-- ===========================================================================
-- Settlement is bound to the lease: a worker cannot settle a job it does not
-- hold, which is what stops it reaching into another tenant's queue through
-- the one API it does have.
-- ===========================================================================
begin;
set local role ops_worker;
do $$
declare
  v_mine  ops.jobs;
  v_other uuid;
begin
  v_mine := ops.lease_job('worker-A', 60);

  -- A job belonging to the other tenant, named directly. The worker cannot
  -- READ it, but naming an id is free — so the function must refuse on the
  -- lease, not on visibility.
  select j.id into v_other
    from ops.jobs j
   where j.tenant_id <> v_mine.tenant_id
   limit 1;

  if ops.complete_job(v_mine.id) is not true then
    raise exception 'settlement: the worker could not complete its OWN job';
  end if;
end
$$;
rollback;

-- The cross-tenant half, resolved as postgres so the id is actually known.
do $$
declare
  v_alpha uuid;
  v_beta  uuid;
  v_job_b uuid;
  v_ok    boolean;
begin
  select id into v_alpha from ops.tenants where slug = 'phase1a-test-alpha';
  select id into v_beta  from ops.tenants where slug = 'phase1a-test-beta';
  select id into v_job_b from ops.jobs where tenant_id = v_beta limit 1;

  -- Pretend to hold a lease, then try to settle Beta's job.
  perform set_config('app.worker_id', 'worker-A', true);
  begin
    v_ok := ops.complete_job(v_job_b);
  exception when others then
    v_ok := false;
  end;
  if v_ok then
    raise exception 'settlement: a worker holding no lease completed another tenant''s job';
  end if;
  perform set_config('app.worker_id', '', true);
end
$$;

-- ===========================================================================
-- D. service_role IS CHARACTERISED, NOT RELIED ON
--
--    service_role carries BYPASSRLS, so RLS would not stop it. In `ops` it is
--    stopped one layer earlier: it holds no table privilege here at all. Both
--    facts are asserted, because the first is the reason the second matters.
-- ===========================================================================
do $$
declare
  v_bypass boolean;
  v_reads  boolean;
begin
  select rolbypassrls into v_bypass from pg_roles where rolname = 'service_role';
  if not v_bypass then
    raise exception 'D: service_role no longer has BYPASSRLS. That is a platform change — revisit ADR 0012 and SI-06 together.';
  end if;

  v_reads := has_table_privilege('service_role', 'ops.jobs', 'SELECT');
  if v_reads then
    raise exception 'D: service_role can SELECT ops.jobs. Its BYPASSRLS means that is unfiltered access to every tenant.';
  end if;

  if has_table_privilege('service_role', 'ops.job_events', 'SELECT')
     or has_table_privilege('service_role', 'ops.tenants', 'SELECT') then
    raise exception 'D: service_role holds table privileges in ops';
  end if;
end
$$;

-- ===========================================================================
-- H. LEASE RECOVERY
--    A worker that dies mid-execution must not strand the job forever, and a
--    live lease must not be stolen from a worker that is still running.
-- ===========================================================================
do $$
declare
  v_alpha  uuid;
  v_job    uuid;
  v_status text;
  v_owner  text;
  v_reaped integer;
begin
  select id into v_alpha from ops.tenants where slug = 'phase1a-test-alpha';

  -- Lease one as postgres so the row stays committed for this test.
  perform set_config('app.worker_id', '', true);
  select j.id into v_job from ops.jobs j where j.tenant_id = v_alpha and j.status = 'queued' limit 1;
  update ops.jobs
     set status = 'leased', lease_owner = 'dead-worker', leased_at = now(),
         lease_expires_at = now() + interval '1 hour', attempts = attempts + 1
   where id = v_job;

  -- A live lease is NOT reaped.
  v_reaped := ops.reap_expired_leases();
  select status, lease_owner into v_status, v_owner from ops.jobs where id = v_job;
  if v_status <> 'leased' or v_owner is distinct from 'dead-worker' then
    raise exception 'H: a live lease was stolen (status=%, owner=%)', v_status, v_owner;
  end if;

  -- Now expire it: the worker died.
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = v_job;
  v_reaped := ops.reap_expired_leases();
  if v_reaped < 1 then raise exception 'H: an expired lease was not reaped'; end if;

  select status, lease_owner into v_status, v_owner from ops.jobs where id = v_job;
  if v_status <> 'queued' then
    raise exception 'H: an expired lease left the job in status % rather than returning it to the queue', v_status;
  end if;
  if v_owner is not null then
    raise exception 'H: an expired lease left lease_owner set to %', v_owner;
  end if;
  if not exists (select 1 from ops.job_events where job_id = v_job and event = 'reaped') then
    raise exception 'H: reaping wrote no audit row';
  end if;

  -- A job that has burned its attempts is retired rather than requeued forever.
  update ops.jobs
     set status = 'leased', lease_owner = 'dead-worker', leased_at = now(),
         lease_expires_at = now() - interval '1 second', attempts = max_attempts
   where id = v_job;
  perform ops.reap_expired_leases();
  select status into v_status from ops.jobs where id = v_job;
  if v_status <> 'failed' then
    raise exception 'H: a job past max_attempts was requeued (status=%) instead of being retired', v_status;
  end if;
end
$$;

-- ===========================================================================
-- H2. RECOVERY MUST HAPPEN ON THE NORMAL PATH.
--
--    Phase 1A has no scheduler, so ops.lease_job() reaping before it selects is
--    the ONLY thing that returns a stranded job to circulation. Testing
--    ops.reap_expired_leases() directly does not prove that: removing the call
--    from lease_job left the suite green until this case existed (mutation M10).
-- ===========================================================================
do $$
declare
  v_alpha    uuid;
  v_stranded uuid;
  v_leased   uuid;
begin
  select id into v_alpha from ops.tenants where slug = 'phase1a-test-alpha';

  -- Retire everything so exactly one job is eligible, and strand that one with
  -- an expired lease as if the worker holding it had died.
  update ops.jobs set status = 'succeeded', completed_at = now(),
         lease_owner = null, leased_at = null, lease_expires_at = null
   where tenant_id in (select id from ops.tenants where slug like 'phase1a-test-%');

  select id into v_stranded from ops.jobs where tenant_id = v_alpha limit 1;
  update ops.jobs
     set status = 'leased', lease_owner = 'worker-that-died', leased_at = now() - interval '1 hour',
         lease_expires_at = now() - interval '1 minute', attempts = 1, completed_at = null
   where id = v_stranded;

  -- A fresh worker asks for work through the ordinary entry point.
  perform set_config('app.worker_id', '', true);
  perform set_config('app.job_id', '', true);
  select id into v_leased from ops.lease_job('recovery-worker', 60);

  if v_leased is null then
    raise exception
      'H2: leasing returned nothing while a job sat with an expired lease. Nothing reaps on the normal path, so a crashed worker strands its job until something else intervenes -- and in this phase nothing else exists.';
  end if;
  if v_leased <> v_stranded then
    raise exception 'H2: leasing returned % rather than the stranded job %', v_leased, v_stranded;
  end if;

  -- The attempt counter must reflect both tries, or a job that crashes the
  -- worker retries without bound.
  if (select attempts from ops.jobs where id = v_stranded) <> 2 then
    raise exception 'H2: the recovered job shows % attempts, expected 2 (the crash plus this lease)',
      (select attempts from ops.jobs where id = v_stranded);
  end if;

  perform set_config('app.worker_id', '', true);
  perform set_config('app.job_id', '', true);
end
$$;

-- Requeue the fixtures the case above retired, so F still has work to lease.
update ops.jobs
   set status = 'queued', completed_at = null, lease_owner = null,
       leased_at = null, lease_expires_at = null, attempts = 0, available_at = now()
 where tenant_id in (select id from ops.tenants where slug like 'phase1a-test-%');

-- ===========================================================================
-- F. CONTEXT MUST NOT LEAK ACROSS TRANSACTIONS ON A REUSED CONNECTION
--
--    This is the case that forces this file to commit. Everything below runs on
--    ONE psql connection, which is exactly the pooled-worker scenario.
-- ===========================================================================

-- F1: lease as tenant Alpha and COMMIT. The lease is taken as the worker, and
-- the transaction is COMMITTED rather than rolled back -- that is the whole
-- point of this case.
begin;
set local role ops_worker;
do $$
declare v_job ops.jobs;
begin
  v_job := ops.lease_job('worker-F', 60);
  if v_job.id is null then
    raise exception 'F1: nothing could be leased';
  end if;
  if ops.current_tenant_id() is distinct from v_job.tenant_id then
    raise exception 'F1: context was not installed by the lease';
  end if;
end
$$;
reset role;
commit;

-- F2: a NEW transaction on the SAME connection must carry no context.
do $$
declare
  v_job    text := current_setting('app.job_id', true);
  v_worker text := current_setting('app.worker_id', true);
begin
  if coalesce(v_job, '') <> '' or coalesce(v_worker, '') <> '' then
    raise exception
      'F2: tenant context survived a COMMIT on the same connection (job=%, worker=%). The next job on this pooled connection would inherit the previous tenant.',
      v_job, v_worker;
  end if;
  if ops.current_tenant_id() is not null then
    raise exception 'F2: current_tenant_id() is non-null after the committed lease transaction ended';
  end if;
end
$$;

begin;
set local role ops_worker;
do $$
declare n bigint;
begin
  select count(*) into n from ops.jobs;
  if n <> 0 then
    raise exception 'F2: % rows visible in a fresh transaction after a committed lease; context leaked', n;
  end if;
end
$$;
rollback;

-- F3: lease again on the same connection and confirm the context is the new
--     lease's, not a merge of both.
begin;
set local role ops_worker;
do $$
declare
  v_job    ops.jobs;
  n        bigint;
begin
  v_job := ops.lease_job('worker-F', 60);
  if v_job.id is null then raise exception 'F3: nothing could be leased on the second pass'; end if;
  if ops.current_tenant_id() is distinct from v_job.tenant_id then
    raise exception 'F3: context does not match the newly leased job';
  end if;
  select count(*) into n from ops.jobs where tenant_id <> v_job.tenant_id;
  if n <> 0 then
    raise exception 'F3: % rows from another tenant are visible after re-leasing on a reused connection', n;
  end if;
end
$$;
rollback;

-- A ROLLBACK must clear the context just as a COMMIT does.
do $$
begin
  if coalesce(current_setting('app.job_id', true), '') <> '' then
    raise exception 'F4: tenant context survived a ROLLBACK on the same connection';
  end if;
end
$$;

-- ===========================================================================
-- Cleanup. Committed fixtures do not belong to the next run.
-- ===========================================================================
delete from ops.job_events e using ops.tenants t
 where e.tenant_id = t.id and t.slug like 'phase1a-test-%';
delete from ops.jobs j using ops.tenants t
 where j.tenant_id = t.id and t.slug like 'phase1a-test-%';
delete from ops.tenants where slug like 'phase1a-test-%';

do $$
declare n bigint;
begin
  select count(*) into n from ops.tenants where slug like 'phase1a-test-%';
  if n <> 0 then raise exception 'cleanup left % test tenants behind', n; end if;
end
$$;
