-- Phase 1A — the tenant-safe execution substrate.
--
-- This creates the smallest thing that can answer one question: can a
-- background worker lease and execute a job for exactly one tenant, without
-- being able to read or mutate another tenant's rows, and without relying on
-- service_role or BYPASSRLS?
--
-- It builds NO engine, NO agents, NO LLM path, and no business logic. The job
-- payload is data the worker never interprets here.
--
-- TWO REVISIONS TO ADR 0012, both forced by measurement — see
-- docs/PHASE_1A_DESIGN_NOTE.md for the probe results.
--
--   1. Leasing cannot happen under a tenant-scoped policy. To lease, the worker
--      must read ops.jobs; at that moment there is no tenant context, so a
--      tenant-scoped policy shows it ZERO rows and it can never lease anything.
--      Fail-closed correctly makes the ADR's own flow impossible. Leasing
--      therefore goes through ops.lease_job(), a SECURITY DEFINER function that
--      returns exactly one job and leaves the transaction already scoped.
--
--   2. A bare `app.tenant_id` GUC is forgeable BY THE WORKER. `set_config` is
--      executable by PUBLIC: measured, a worker role set the GUC to another
--      tenant and read that tenant's row. Under ADR 0012 as written, "which
--      tenant am I" is an assertion by the worker rather than a fact the
--      database checks. So ops.current_tenant_id() does not read a tenant GUC.
--      It resolves the tenant from a LIVE LEASE:
--
--        app.worker_id + app.job_id  ->  a leased, unexpired ops.jobs row owned
--                                        by that worker  ->  its tenant_id
--
--      A worker can therefore only act as a tenant for which it holds live,
--      server-recorded work. It cannot invent a tenant, cannot act on a tenant
--      with nothing in flight, and every tenant-scoped statement is
--      attributable to one job row.
--
-- WHAT THIS DOES NOT DEFEND AGAINST, stated plainly: GUCs are readable and
-- writable by any role, so no GUC-transport design is unforgeable against a
-- fully malicious worker PROCESS. Against one, the bound is ops_worker's
-- grants: no BYPASSRLS, nothing in public, no arbitrary SQL, no DDL. What the
-- lease binding does defend against is the threat that actually matters here —
-- a worker bug that forgets the context, a worker that takes the tenant from
-- the PAYLOAD, and (Phase 1B) LLM output or external input reaching the tenant
-- decision. The payload is the untrusted surface; tenancy is now unreachable
-- from it.

create schema if not exists ops;

-- `ops` is deliberately absent from `schemas` in supabase/config.toml, so
-- PostgREST does not expose it. That is one channel, not a boundary — see
-- ADR 0011 for the second (a direct libpq connection).
revoke all on schema ops from public;

-- ---------------------------------------------------------------------------
-- The worker role.
--
-- NOLOGIN on purpose: no credential is created here, because a password in a
-- migration is a secret in git. Production creates a login role as a
-- deployment step and grants it `ops_worker`; the worker then does
-- `set local role ops_worker` per transaction, which is exactly how PostgREST
-- reaches `authenticated`. Tests exercise the same path.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ops_worker') then
    create role ops_worker nologin;
  end if;
end
$$;

grant usage on schema ops to ops_worker;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists ops.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

comment on table ops.tenants is
  'The engine tenant. Distinct from public.companies, which means CRM customer account.';

create table if not exists ops.jobs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references ops.tenants (id) on delete restrict,
  -- `kind` is free text on purpose. It is tenant/product vocabulary, and a
  -- CHECK enumerating it here is the mistake ADR 0013 exists to prevent.
  kind             text not null,
  payload          jsonb not null default '{}'::jsonb,
  -- `status` is engine state, not tenant vocabulary: the same four values hold
  -- for every tenant, so constraining them is correct.
  status           text not null default 'queued'
                     check (status in ('queued', 'leased', 'succeeded', 'failed')),
  priority         integer not null default 100,
  attempts         integer not null default 0,
  max_attempts     integer not null default 5 check (max_attempts >= 1),
  idempotency_key  text,
  available_at     timestamptz not null default now(),
  leased_at        timestamptz,
  lease_expires_at timestamptz,
  lease_owner      text,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz,
  -- A leased row must carry the whole lease, or "leased" means nothing.
  constraint jobs_lease_is_whole check (
    (status <> 'leased')
    or (lease_owner is not null and leased_at is not null and lease_expires_at is not null)
  )
);

-- Deduplication is per tenant: two tenants may legitimately use the same key.
create unique index if not exists jobs_tenant_idempotency_key
  on ops.jobs (tenant_id, kind, idempotency_key)
  where idempotency_key is not null;

-- The leasing hot path: the queue scan, and the reaper.
create index if not exists jobs_queue_idx
  on ops.jobs (priority, available_at, created_at)
  where status = 'queued';
create index if not exists jobs_lease_expiry_idx
  on ops.jobs (lease_expires_at)
  where status = 'leased';
create index if not exists jobs_tenant_idx on ops.jobs (tenant_id);

create table if not exists ops.job_events (
  id         bigint generated by default as identity primary key,
  job_id     uuid not null references ops.jobs (id) on delete cascade,
  tenant_id  uuid not null references ops.tenants (id) on delete restrict,
  event      text not null
               check (event in ('enqueued', 'leased', 'succeeded', 'failed', 'retry', 'reaped')),
  worker_id  text,
  attempt    integer,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists job_events_job_idx on ops.job_events (job_id, created_at);
create index if not exists job_events_tenant_idx on ops.job_events (tenant_id);

comment on table ops.job_events is
  'Append-only lifecycle trail. Deterministic rows written by the ops functions; never model-generated prose.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- FORCE as well as ENABLE: without FORCE the table OWNER bypasses every policy,
-- and ownership is exactly the kind of thing that changes quietly. It does not
-- constrain `postgres` (measured: rolbypassrls = true), which is the admin
-- identity and outside this boundary by design.
-- ---------------------------------------------------------------------------

alter table ops.tenants    enable row level security;
alter table ops.tenants    force  row level security;
alter table ops.jobs       enable row level security;
alter table ops.jobs       force  row level security;
alter table ops.job_events enable row level security;
alter table ops.job_events force  row level security;

-- ---------------------------------------------------------------------------
-- ops.current_tenant_id() — the one helper every policy reads.
--
-- MISSING context returns NULL, so every policy matches no rows. MALFORMED
-- context RAISES. The asymmetry is deliberate: "no context" is a normal state
-- (a worker between jobs, or any other connection), while a non-uuid in
-- app.job_id is never normal and should be loud rather than silently behaving
-- like "no context". Both outcomes yield zero unauthorised access.
-- ---------------------------------------------------------------------------
create or replace function ops.current_tenant_id()
returns uuid
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_job_raw text := nullif(current_setting('app.job_id', true), '');
  v_worker  text := nullif(current_setting('app.worker_id', true), '');
  v_job_id  uuid;
  v_tenant  uuid;
begin
  -- No lease claimed in this transaction: no tenant. Fail closed.
  if v_job_raw is null or v_worker is null then
    return null;
  end if;

  begin
    v_job_id := v_job_raw::uuid;
  exception
    when invalid_text_representation then
      raise exception
        'ops: app.job_id is not a uuid (%). Tenant context is installed by ops.lease_job(); it is not set by hand.',
        v_job_raw
        using errcode = '22P02';
  end;

  -- The tenant is a PROPERTY OF A LIVE LEASE, never an assertion by the caller.
  select j.tenant_id
    into v_tenant
    from ops.jobs j
   where j.id = v_job_id
     and j.lease_owner = v_worker
     and j.status = 'leased'
     and j.lease_expires_at > now();

  return v_tenant;
end
$function$;

comment on function ops.current_tenant_id() is
  'Resolves the tenant from the live lease named by app.job_id + app.worker_id. NULL when there is none.';

-- ---------------------------------------------------------------------------
-- Policies. Every one reads the helper above, so there is one place to audit.
--
-- The worker gets SELECT and nothing else. Every state transition goes through
-- a function that verifies the lease, so the worker never needs UPDATE on
-- ops.jobs — which means it cannot extend its own lease, reassign a job, or
-- mark another tenant's work complete.
-- ---------------------------------------------------------------------------

drop policy if exists tenants_read_own on ops.tenants;
create policy tenants_read_own on ops.tenants
  for select to ops_worker
  using (id = ops.current_tenant_id());

drop policy if exists jobs_read_own_tenant on ops.jobs;
create policy jobs_read_own_tenant on ops.jobs
  for select to ops_worker
  using (tenant_id = ops.current_tenant_id());

drop policy if exists job_events_read_own_tenant on ops.job_events;
create policy job_events_read_own_tenant on ops.job_events
  for select to ops_worker
  using (tenant_id = ops.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Lifecycle functions. All SECURITY DEFINER, owned by postgres, search_path
-- pinned empty and every name schema-qualified.
-- ---------------------------------------------------------------------------

create or replace function ops.reap_expired_leases()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_reaped integer;
begin
  -- A worker that died mid-execution leaves a row 'leased' forever. Return it
  -- to the queue, or retire it if it has burned its attempts. `attempts` was
  -- already incremented at lease time, so a crash still counts as an attempt —
  -- otherwise a job that crashes the worker retries without bound.
  with expired as (
    select j.id, j.tenant_id, j.attempts, j.max_attempts
      from ops.jobs j
     where j.status = 'leased'
       and j.lease_expires_at <= now()
       for update skip locked
  ),
  updated as (
    update ops.jobs j
       set status = case when e.attempts >= e.max_attempts then 'failed' else 'queued' end,
           lease_owner = null,
           leased_at = null,
           lease_expires_at = null,
           available_at = now(),
           last_error = coalesce(j.last_error, 'lease expired without settlement'),
           completed_at = case when e.attempts >= e.max_attempts then now() else null end,
           updated_at = now()
      from expired e
     where j.id = e.id
    returning j.id, j.tenant_id, j.attempts, j.status
  )
  insert into ops.job_events (job_id, tenant_id, event, attempt, detail)
  select u.id, u.tenant_id, 'reaped', u.attempts,
         format('lease expired; job is now %s', u.status)
    from updated u;

  get diagnostics v_reaped = row_count;
  return v_reaped;
end
$function$;

create or replace function ops.enqueue_job(
  p_tenant_id       uuid,
  p_kind            text,
  p_payload         jsonb default '{}'::jsonb,
  p_priority        integer default 100,
  p_available_at    timestamptz default now(),
  p_max_attempts    integer default 5,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'ops.enqueue_job requires a tenant';
  end if;
  if not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception 'ops.enqueue_job: unknown tenant %', p_tenant_id;
  end if;
  if p_kind is null or btrim(p_kind) = '' then
    raise exception 'ops.enqueue_job requires a kind';
  end if;

  insert into ops.jobs (tenant_id, kind, payload, priority, available_at, max_attempts, idempotency_key)
  values (p_tenant_id, p_kind, coalesce(p_payload, '{}'::jsonb), p_priority,
          coalesce(p_available_at, now()), p_max_attempts, p_idempotency_key)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- The partial unique index rejected it: this exact work is already queued.
    select j.id into v_id
      from ops.jobs j
     where j.tenant_id = p_tenant_id
       and j.kind = p_kind
       and j.idempotency_key = p_idempotency_key;
    return v_id;
  end if;

  insert into ops.job_events (job_id, tenant_id, event, detail)
  values (v_id, p_tenant_id, 'enqueued', p_kind);

  return v_id;
end
$function$;

create or replace function ops.lease_job(
  p_worker_id      text,
  p_lease_seconds  integer default 60
)
returns ops.jobs
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job ops.jobs;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'ops.lease_job requires a worker id; it is what binds the lease to a caller';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 then
    raise exception 'ops.lease_job requires a positive lease duration';
  end if;

  -- Clear any context this transaction already carried, so a failed lease can
  -- never leave the previous job's tenant installed.
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);

  perform ops.reap_expired_leases();

  -- SKIP LOCKED is what lets two workers run concurrently without either
  -- blocking or double-leasing: a row another transaction has locked is passed
  -- over rather than waited on.
  update ops.jobs j
     set status = 'leased',
         lease_owner = p_worker_id,
         leased_at = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id = (
      select c.id
        from ops.jobs c
       where c.status = 'queued'
         and c.available_at <= now()
       order by c.priority asc, c.available_at asc, c.created_at asc
         for update skip locked
       limit 1
   )
  returning j.* into v_job;

  if v_job.id is null then
    return null;
  end if;

  -- Install the context for the CALLER's transaction. set_config(..., true) is
  -- transaction-local, and it does propagate out of a SECURITY DEFINER function
  -- (measured — see docs/PHASE_1A_DESIGN_NOTE.md, probe P3).
  perform set_config('app.worker_id', p_worker_id, true);
  perform set_config('app.job_id', v_job.id::text, true);

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job.id, v_job.tenant_id, 'leased', p_worker_id, v_job.attempts, v_job.kind);

  return v_job;
end
$function$;

create or replace function ops.complete_job(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_worker text := nullif(current_setting('app.worker_id', true), '');
  v_job    ops.jobs;
begin
  if v_worker is null then
    raise exception 'ops.complete_job: no lease is held in this transaction';
  end if;

  update ops.jobs j
     set status = 'succeeded',
         completed_at = now(),
         lease_owner = null,
         leased_at = null,
         lease_expires_at = null,
         last_error = null,
         updated_at = now()
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_owner = v_worker
     and j.lease_expires_at > now()
  returning j.* into v_job;

  if v_job.id is null then
    -- Not ours, not leased, or expired. Refusing is the point: a worker must
    -- not be able to settle another worker's — or another tenant's — job.
    return false;
  end if;

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt)
  values (v_job.id, v_job.tenant_id, 'succeeded', v_worker, v_job.attempts);

  return true;
end
$function$;

create or replace function ops.fail_job(
  p_job_id      uuid,
  p_error       text,
  p_retry_after interval default interval '30 seconds'
)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_worker  text := nullif(current_setting('app.worker_id', true), '');
  v_job     ops.jobs;
  v_retries boolean;
begin
  if v_worker is null then
    raise exception 'ops.fail_job: no lease is held in this transaction';
  end if;

  select j.attempts < j.max_attempts
    into v_retries
    from ops.jobs j
   where j.id = p_job_id and j.lease_owner = v_worker and j.status = 'leased';

  if v_retries is null then
    return false;
  end if;

  update ops.jobs j
     set status = case when v_retries then 'queued' else 'failed' end,
         available_at = case when v_retries then now() + coalesce(p_retry_after, interval '30 seconds')
                             else j.available_at end,
         completed_at = case when v_retries then null else now() end,
         lease_owner = null,
         leased_at = null,
         lease_expires_at = null,
         last_error = p_error,
         updated_at = now()
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_owner = v_worker
  returning j.* into v_job;

  if v_job.id is null then
    return false;
  end if;

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job.id, v_job.tenant_id,
          case when v_retries then 'retry' else 'failed' end,
          v_worker, v_job.attempts, p_error);

  return true;
end
$function$;

-- ---------------------------------------------------------------------------
-- Grants — deny first, then the exact surface and nothing more.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema ops from public;
revoke all on all functions in schema ops from public;
revoke all on all sequences in schema ops from public;

-- The API roles have no business in `ops` at all. If PostgREST is ever pointed
-- at this schema, this is what stops it being readable.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on schema ops from %I', v_role);
      execute format('revoke all on all tables in schema ops from %I', v_role);
      execute format('revoke all on all functions in schema ops from %I', v_role);
      execute format('revoke all on all sequences in schema ops from %I', v_role);
    end if;
  end loop;
end
$$;

-- The worker reads, and calls three functions. It holds no INSERT, UPDATE or
-- DELETE anywhere in `ops`: every transition is a function that checks the
-- lease first.
grant select on ops.tenants    to ops_worker;
grant select on ops.jobs       to ops_worker;
grant select on ops.job_events to ops_worker;
grant execute on function ops.lease_job(text, integer)              to ops_worker;
grant execute on function ops.complete_job(uuid)                    to ops_worker;
grant execute on function ops.fail_job(uuid, text, interval)        to ops_worker;
grant execute on function ops.current_tenant_id()                   to ops_worker;

-- Enqueueing is not the worker's job in Phase 1A. Whatever creates work
-- (edge functions today) does so as service_role, which is inside the trust
-- boundary already and is characterised as such in SI-06.
grant usage on schema ops to service_role;
grant execute on function ops.enqueue_job(uuid, text, jsonb, integer, timestamptz, integer, text)
  to service_role;

-- Nothing in `ops` is created by anyone but a migration, so no default
-- privileges are needed; revoke them anyway so a future object cannot be born
-- reachable the way three tables in `public` were.
alter default privileges in schema ops revoke all on tables from public;
alter default privileges in schema ops revoke all on sequences from public;
alter default privileges in schema ops revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Assert the end state. A migration that silently no-ops is worse than none:
-- this repository has shipped that shape three times.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_r   record;
begin
  -- 1. The worker role must carry no blanket capability. This is the single
  --    assumption every policy below rests on.
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
    into v_r from pg_roles where rolname = 'ops_worker';
  if v_r is null then
    raise exception 'ops_worker was not created';
  end if;
  if v_r.rolsuper then raise exception 'ops_worker is SUPERUSER'; end if;
  if v_r.rolbypassrls then raise exception 'ops_worker has BYPASSRLS; every policy in this migration is decorative'; end if;
  if v_r.rolcreaterole then raise exception 'ops_worker has CREATEROLE'; end if;
  if v_r.rolcreatedb then raise exception 'ops_worker has CREATEDB'; end if;
  if v_r.rolcanlogin then raise exception 'ops_worker can LOGIN; no credential should exist in a migration'; end if;

  -- 2. RLS is on AND forced on every ops table.
  select string_agg(c.relname, ', ')
    into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'ops table(s) % lack ENABLE + FORCE row level security', v_bad;
  end if;

  -- 3. The worker holds no write verb anywhere in ops.
  select string_agg(format('%s:%s', c.relname, p.priv), ', ')
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
   where n.nspname = 'ops' and c.relkind = 'r'
     and has_table_privilege('ops_worker', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'ops_worker holds write privileges in ops: %. Transitions must go through the lease-checking functions.', v_bad;
  end if;

  -- 4. anon and authenticated can reach nothing here.
  foreach v_bad in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_bad)
       and has_schema_privilege(v_bad, 'ops', 'USAGE') then
      raise exception 'role % can reach schema ops', v_bad;
    end if;
  end loop;

  -- 5. The worker cannot enqueue. Creating work is not its capability in this
  --    phase, and a worker that could enqueue for an arbitrary tenant would
  --    undo the lease binding.
  if has_function_privilege('ops_worker',
       'ops.enqueue_job(uuid, text, jsonb, integer, timestamptz, integer, text)', 'EXECUTE') then
    raise exception 'ops_worker can execute ops.enqueue_job; it must not be able to create work for an arbitrary tenant';
  end if;

  -- 6. Every policy must route through the one helper, or "one place to audit"
  --    stops being true.
  select string_agg(p.polname, ', ')
    into v_bad
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops'
     and pg_get_expr(p.polqual, p.polrelid) not like '%current_tenant_id()%';
  if v_bad is not null then
    raise exception 'ops polic(ies) % do not read ops.current_tenant_id()', v_bad;
  end if;
end
$$;
