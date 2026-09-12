-- Phase 1B — the production worker runtime's database surface.
--
-- Phase 1A proved the substrate: a worker can lease and execute a job for
-- exactly one tenant without service_role and without BYPASSRLS. This migration
-- adds only what a REAL, continuously-running process needs on top of it:
--
--   * a failure taxonomy, so not every exception becomes a retry;
--   * bounded, deterministic backoff computed in the DATABASE, where `attempts`
--     lives and where the worker cannot forge it;
--   * worker liveness, so a job leased to a process that has disappeared is
--     diagnosable rather than merely stale;
--   * ONE narrow capability for the first real handler, which is the shape
--     every later capability must copy;
--   * a metrics view.
--
-- It builds NO agents, NO LLM path, NO domain model. `ops_worker` gains five
-- function grants and not one write verb.

-- ---------------------------------------------------------------------------
-- 1. Failure classification.
--
-- Engine vocabulary, not tenant vocabulary: every tenant's jobs fail in exactly
-- these four ways, so ADR 0013's test ("would tenant two need a different
-- set?") answers no and a CHECK is the right tool.
--
--   transient  an infrastructure failure that may succeed later -> retry
--   permanent  invalid input or an unrunnable job                -> terminal
--   security   a trust-boundary violation                        -> terminal, loud
--   unknown    an unanalysed failure                             -> retry, bounded
--
-- `unknown` retries on purpose. An unanalysed failure is not a proven-hopeless
-- one, and the cost of guessing wrong is a bounded number of extra attempts
-- rather than silently discarded work. This is the same reasoning
-- `classifyFailureStatus` already applies to the Postmark webhook.
-- ---------------------------------------------------------------------------

alter table ops.jobs
  add column if not exists last_error_class text,
  add column if not exists last_duration_ms integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'ops.jobs'::regclass and conname = 'jobs_last_error_class_check'
  ) then
    alter table ops.jobs add constraint jobs_last_error_class_check
      check (last_error_class is null
             or last_error_class in ('transient', 'permanent', 'security', 'unknown'));
  end if;
end
$$;

-- `job_events.event` gains nothing: a classified failure is still a 'failed' or
-- 'retry' event, and the class travels in `detail`. Adding event names would
-- force every existing reader to learn them for no new information.

-- ---------------------------------------------------------------------------
-- 2. The tenant that owns this deployment's CRM.
--
-- ADR 0002 decides that `public.*` IS tenant one's CRM instance: it carries no
-- tenant column and never will. `ops` is multi-tenant. So any capability that
-- reaches from `ops` into `public` must know WHICH tenant that CRM belongs to.
-- Without this marker such a capability would be unscoped, and every tenant's
-- job could act on tenant one's data.
--
-- This is the smallest possible bridge: one boolean, at most one tenant,
-- consulted by capability functions only. It is NOT a domain model.
-- ---------------------------------------------------------------------------

alter table ops.tenants
  add column if not exists owns_local_crm boolean not null default false;

-- At most one. A second would make "which tenant owns public" ambiguous, and an
-- ambiguous answer here is a cross-tenant capability.
create unique index if not exists tenants_single_local_crm
  on ops.tenants ((true)) where owns_local_crm;

-- ---------------------------------------------------------------------------
-- 3. Worker liveness.
--
-- Deliberately NOT a fleet manager. It answers one question: is a job leased to
-- a worker that has stopped reporting? Lease expiry remains the authoritative
-- recovery mechanism; this only makes the cause visible.
--
-- No tenant_id: a worker instance is fleet infrastructure, not tenant data. RLS
-- is enabled AND forced with NO policy at all, so the table is unreachable
-- except through the SECURITY DEFINER functions below. That keeps the `ops`
-- invariant "every table has ENABLE + FORCE RLS" true without inventing a
-- tenant column that would mean nothing. The definer functions reach it the
-- same way ops.lease_job already reaches the forced ops.jobs.
-- ---------------------------------------------------------------------------

create table if not exists ops.worker_instances (
  worker_id    text primary key,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  stopped_at   timestamptz,
  detail       text
);

alter table ops.worker_instances enable row level security;
alter table ops.worker_instances force  row level security;

create index if not exists worker_instances_last_seen_idx
  on ops.worker_instances (last_seen_at);

create or replace function ops.worker_heartbeat(
  p_worker_id text,
  p_detail    text default null
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'ops.worker_heartbeat requires a worker id';
  end if;

  insert into ops.worker_instances (worker_id, detail)
  values (p_worker_id, p_detail)
  on conflict (worker_id) do update
    set last_seen_at = now(),
        stopped_at   = null,
        detail       = coalesce(excluded.detail, ops.worker_instances.detail);
end
$function$;

create or replace function ops.worker_stopped(p_worker_id text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  update ops.worker_instances
     set stopped_at = now(), last_seen_at = now()
   where worker_id = p_worker_id;
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. Classified settlement, with bounded backoff computed here.
--
-- The worker classifies; the DATABASE decides whether that classification earns
-- a retry and when. Backoff is a pure function of `attempts`, which the worker
-- cannot write, so a buggy or hostile worker cannot arrange a hot retry loop.
--
-- Additive: ops.fail_job(uuid, text, interval) from Phase 1A is left exactly as
-- it is, so nothing that already depends on it changes behaviour.
-- ---------------------------------------------------------------------------

create or replace function ops.retry_delay(p_attempts integer)
returns interval
language sql
immutable
set search_path to ''
as $function$
  -- 5s, 10s, 20s, 40s ... capped at one hour. Exponential so a dependency that
  -- is down is not hammered; capped so a long outage still recovers promptly.
  select make_interval(
    secs => least(3600, (5 * power(2, least(greatest(coalesce(p_attempts, 1), 1), 10) - 1))::int)
  );
$function$;

create or replace function ops.settle_job_failure(
  p_job_id uuid,
  p_class  text,
  p_error  text
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_worker  text := nullif(current_setting('app.worker_id', true), '');
  v_job     ops.jobs;
  v_class   text := coalesce(nullif(btrim(p_class), ''), 'unknown');
  v_retries boolean;
begin
  if v_worker is null then
    raise exception 'ops.settle_job_failure: no lease is held in this transaction';
  end if;

  -- An unrecognised class becomes 'unknown', never "no class": a caller that
  -- invents a class must not thereby escape the taxonomy.
  if v_class not in ('transient', 'permanent', 'security', 'unknown') then
    v_class := 'unknown';
  end if;

  select (v_class in ('transient', 'unknown')) and j.attempts < j.max_attempts
    into v_retries
    from ops.jobs j
   where j.id = p_job_id
     and j.lease_owner = v_worker
     and j.status = 'leased'
     and j.lease_expires_at > now();

  -- Not ours, not leased, or expired. Refusing is the point.
  if v_retries is null then
    return 'refused';
  end if;

  update ops.jobs j
     set status           = case when v_retries then 'queued' else 'failed' end,
         available_at     = case when v_retries then now() + ops.retry_delay(j.attempts)
                                 else j.available_at end,
         completed_at     = case when v_retries then null else now() end,
         last_error       = p_error,
         last_error_class = v_class,
         last_duration_ms = case when j.leased_at is null then null
                                 else (extract(epoch from (now() - j.leased_at)) * 1000)::int end,
         lease_owner      = null,
         leased_at        = null,
         lease_expires_at = null,
         updated_at       = now()
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_owner = v_worker
  returning j.* into v_job;

  if v_job.id is null then
    return 'refused';
  end if;

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job.id, v_job.tenant_id,
          case when v_retries then 'retry' else 'failed' end,
          v_worker, v_job.attempts,
          format('[%s] %s', v_class, coalesce(p_error, '')));

  return case when v_retries then 'retry' else 'failed' end;
end
$function$;

-- Completion with a detail line. Additive overload; the Phase 1A one-argument
-- form is untouched.
create or replace function ops.complete_job(p_job_id uuid, p_detail text)
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
     set status           = 'succeeded',
         completed_at     = now(),
         last_duration_ms = case when j.leased_at is null then null
                                 else (extract(epoch from (now() - j.leased_at)) * 1000)::int end,
         lease_owner      = null,
         leased_at        = null,
         lease_expires_at = null,
         last_error       = null,
         last_error_class = null,
         updated_at       = now()
   where j.id = p_job_id
     and j.status = 'leased'
     and j.lease_owner = v_worker
     and j.lease_expires_at > now()
  returning j.* into v_job;

  if v_job.id is null then
    return false;
  end if;

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job.id, v_job.tenant_id, 'succeeded', v_worker, v_job.attempts, p_detail);

  return true;
end
$function$;

-- ---------------------------------------------------------------------------
-- 4b. Resuming a committed lease — what makes crash recovery possible at all.
--
-- MEASURED DEFECT IN THE PHASE 1A SHAPE. Phase 1A ran lease + execute + settle
-- in ONE transaction. That is atomic, but it means a worker that dies mid-job
-- leaves NO TRACE: the lease is rolled back with everything else, `attempts`
-- returns to its previous value, and the job is queued again unchanged.
-- Verified directly — leasing inside a transaction and rolling it back leaves
-- `status=queued attempts=0`. Two consequences, both unacceptable for a
-- production runtime:
--
--   1. A job that reliably crashes the worker is a POISON PILL. It never
--      accumulates attempts, so `max_attempts` never retires it and it is
--      re-leased forever.
--   2. "Died before leasing" and "died just after leasing" are indistinguishable,
--      so lease expiry — the mechanism §12 and §13 rest on — has nothing to
--      recover.
--
-- Phase 1B therefore commits the lease in its own transaction and executes in a
-- second one. The tenant must survive that boundary WITHOUT being carried in
-- application memory, or the payload-cannot-choose-tenancy property dies with
-- it. `ops.resume_lease` is how: it re-reads the trusted row under exactly the
-- checks `ops.current_tenant_id()` applies, and re-installs the transaction-
-- local context. A worker naming a job it does not hold gets nothing.
--
-- The execution transaction still contains the handler's side effects AND the
-- settlement, so "did the work but did not record it" remains impossible.
-- ---------------------------------------------------------------------------

create or replace function ops.resume_lease(
  p_worker_id text,
  p_job_id    uuid
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
    raise exception 'ops.resume_lease requires a worker id';
  end if;

  -- Clear first, so a refused resume can never leave a previous job's context
  -- installed in this transaction.
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);

  select j.* into v_job
    from ops.jobs j
   where j.id = p_job_id
     and j.lease_owner = p_worker_id
     and j.status = 'leased'
     and j.lease_expires_at > now();

  -- Not ours, not leased, or expired. No context is installed, so every
  -- tenant-scoped statement in this transaction sees nothing.
  if v_job.id is null then
    return null;
  end if;

  perform set_config('app.worker_id', p_worker_id, true);
  perform set_config('app.job_id', v_job.id::text, true);

  return v_job;
end
$function$;

comment on function ops.resume_lease(text, uuid) is
  'Re-installs transaction-local tenant context for a lease this worker already holds. The tenant is re-read from the trusted row, never carried across the transaction boundary by the caller.';

-- ---------------------------------------------------------------------------
-- 5. The first real capability.
--
-- This is the shape §8 of the Phase 1B brief calls an early Tool Gateway: the
-- handler is handed a CAPABILITY, never a client. It cannot widen the
-- capability, cannot choose the tenant, and cannot name the rows.
--
-- WHY THIS OPERATION. `public.inbound_emails` carries inbound email bodies,
-- which under the LGPD are personal data belonging to a psychology clinic's
-- correspondents. Its own migration specifies a retention policy and then says:
-- "Phase 0.5 has no scheduler ... so the policy is documented and manual". The
-- blocker was the absence of a worker. Phase 1B removes it. This is therefore a
-- real, pre-existing, already-specified obligation and not a demo.
--
-- WHY NOT THE INGESTION REPLAY. Re-running an ingestion means creating
-- contacts, companies, notes and storage objects across `public.*`. That path
-- lives in Deno and runs as service_role. Moving it into the worker would mean
-- either handing the worker a service_role client or granting `ops_worker`
-- broad write privileges on `public.*` — the two things §8 and §28 forbid. The
-- recovery half of the same ledger is expressible as one narrow capability; the
-- ingestion half is not, and pretending otherwise would have cost the isolation
-- Phase 1A just bought. See docs/PHASE_1B_REPORT.md §5.
--
-- FAIL CLOSED, three ways:
--   1. No live lease  -> no tenant -> raise.
--   2. A tenant that does not own this deployment's CRM -> raise.
--   3. A retention window shorter than the floor is RAISED TO the floor, so a
--      payload cannot talk the capability into deleting recent data.
-- ---------------------------------------------------------------------------

create or replace function ops.purge_inbound_email_ledger(
  p_retention_days integer default 90,
  p_limit          integer default 5000
)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  -- The floor is the security property. A caller may ask for a LONGER
  -- retention than policy; it can never ask for a shorter one.
  c_floor_days constant integer := 30;
  c_max_rows   constant integer := 50000;
  v_tenant uuid := ops.current_tenant_id();
  v_days   integer := greatest(coalesce(p_retention_days, 90), c_floor_days);
  v_limit  integer := least(greatest(coalesce(p_limit, 5000), 1), c_max_rows);
  v_purged integer;
begin
  if v_tenant is null then
    raise exception
      'ops.purge_inbound_email_ledger: no live lease, so no tenant. This capability is reachable only from a leased job.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from ops.tenants t where t.id = v_tenant and t.owns_local_crm
  ) then
    raise exception
      'ops.purge_inbound_email_ledger: tenant % does not own this deployment CRM; public.* is tenant one data (ADR 0002)', v_tenant
      using errcode = '42501';
  end if;

  -- Resolved rows only. `pending` and `failed_transient` are excluded because
  -- they are the reason the ledger exists — deleting them would destroy exactly
  -- the records a human still has to act on.
  with doomed as (
    select e.id
      from public.inbound_emails e
     where e.received_at < now() - make_interval(days => v_days)
       and e.status in ('ingested', 'failed_permanent')
     order by e.received_at
     limit v_limit
  )
  delete from public.inbound_emails e
   using doomed d
   where e.id = d.id;

  get diagnostics v_purged = row_count;
  return v_purged;
end
$function$;

comment on function ops.purge_inbound_email_ledger(integer, integer) is
  'LGPD retention for public.inbound_emails. Tenant comes from the live lease; only the tenant that owns this deployment CRM may call it; the retention window has a hard floor.';

-- ---------------------------------------------------------------------------
-- 6. Metrics.
--
-- A view, not a dashboard. security_invoker is mandatory here for the same
-- reason it is mandatory everywhere in this repository (PHASE_0_5_REPORT §16.1):
-- without it the view executes as its OWNER and hands over every tenant's
-- counts regardless of RLS on ops.jobs.
-- ---------------------------------------------------------------------------

create or replace view ops.queue_metrics with (security_invoker = on) as
select
  j.tenant_id,
  count(*) filter (where j.status = 'queued')                     as queued,
  count(*) filter (where j.status = 'leased')                     as running,
  count(*) filter (where j.status = 'succeeded')                  as succeeded,
  count(*) filter (where j.status = 'failed')                     as failed,
  count(*) filter (where j.status = 'queued' and j.attempts > 0)  as awaiting_retry,
  count(*) filter (where j.status = 'leased'
                     and j.lease_expires_at <= now())             as expired_leases,
  extract(epoch from now() - min(j.available_at)
            filter (where j.status = 'queued'))::bigint           as oldest_queued_age_seconds,
  avg(j.last_duration_ms) filter (where j.last_duration_ms is not null)::bigint
                                                                  as avg_duration_ms,
  (select count(*) from ops.job_events e
    where e.tenant_id = j.tenant_id and e.event = 'reaped')       as lease_recoveries
from ops.jobs j
group by j.tenant_id;

-- ---------------------------------------------------------------------------
-- 7. Grants. Deny first, then exactly the new surface.
-- ---------------------------------------------------------------------------

revoke all on ops.worker_instances from public;
revoke all on ops.queue_metrics from public;
revoke all on function ops.worker_heartbeat(text, text) from public;
revoke all on function ops.worker_stopped(text) from public;
revoke all on function ops.settle_job_failure(uuid, text, text) from public;
revoke all on function ops.complete_job(uuid, text) from public;
revoke all on function ops.purge_inbound_email_ledger(integer, integer) from public;
revoke all on function ops.retry_delay(integer) from public;
revoke all on function ops.resume_lease(text, uuid) from public;

-- The worker still holds NO write verb on any ops table. Everything below is a
-- function that checks the lease, or a read.
grant execute on function ops.worker_heartbeat(text, text)                to ops_worker;
grant execute on function ops.worker_stopped(text)                        to ops_worker;
grant execute on function ops.settle_job_failure(uuid, text, text)        to ops_worker;
grant execute on function ops.complete_job(uuid, text)                    to ops_worker;
grant execute on function ops.purge_inbound_email_ledger(integer, integer) to ops_worker;
grant execute on function ops.resume_lease(text, uuid)                    to ops_worker;

-- Lease recovery, called by the worker on its own timer so that recovery does
-- not depend on business traffic arriving. It is safe to expose: it can only
-- touch leases that have ALREADY expired, so it cannot steal live work, and the
-- worker could already trigger it indirectly through ops.lease_job.
grant execute on function ops.reap_expired_leases()                       to ops_worker;

grant select on ops.queue_metrics to ops_worker;

-- ---------------------------------------------------------------------------
-- 8. Assert the end state. A migration that silently no-ops is worse than none.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_r   record;
begin
  -- 1. The worker role STILL carries no blanket capability. Re-asserted rather
  --    than assumed: this migration grants it new functions, and every one of
  --    them is safe only because this is true.
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
    into v_r from pg_roles where rolname = 'ops_worker';
  if v_r is null then raise exception 'ops_worker is missing'; end if;
  if v_r.rolsuper then raise exception 'ops_worker is SUPERUSER'; end if;
  if v_r.rolbypassrls then raise exception 'ops_worker has BYPASSRLS'; end if;
  if v_r.rolcreaterole then raise exception 'ops_worker has CREATEROLE'; end if;
  if v_r.rolcreatedb then raise exception 'ops_worker has CREATEDB'; end if;
  if v_r.rolcanlogin then raise exception 'ops_worker can LOGIN'; end if;

  -- 2. Every ops table, including the one added here, has ENABLE + FORCE RLS.
  select string_agg(c.relname, ', ')
    into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'ops table(s) % lack ENABLE + FORCE row level security', v_bad;
  end if;

  -- 3. Still no write verb anywhere in ops for the worker.
  select string_agg(format('%s:%s', c.relname, p.priv), ', ')
    into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
   where n.nspname = 'ops' and c.relkind = 'r'
     and has_table_privilege('ops_worker', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'ops_worker holds write privileges in ops: %', v_bad;
  end if;

  -- 4. The worker holds nothing at all on public. The purge capability is a
  --    SECURITY DEFINER function precisely so this stays true.
  if has_schema_privilege('ops_worker', 'public', 'USAGE')
     and exists (
       select 1
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p(priv)
        where n.nspname = 'public' and c.relkind = 'r'
          and has_table_privilege('ops_worker', c.oid, p.priv)
     ) then
    select string_agg(distinct c.relname, ', ')
      into v_bad
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) as p(priv)
     where n.nspname = 'public' and c.relkind = 'r'
       and has_table_privilege('ops_worker', c.oid, p.priv);
    raise exception
      'ops_worker holds table privileges in public (%). It must reach public only through a narrow SECURITY DEFINER capability.', v_bad;
  end if;

  -- 5. The worker still cannot enqueue: a worker that could create work for an
  --    arbitrary tenant would undo the lease binding (Phase 1B brief §14).
  if has_function_privilege('ops_worker',
       'ops.enqueue_job(uuid, text, jsonb, integer, timestamptz, integer, text)', 'EXECUTE') then
    raise exception 'ops_worker can execute ops.enqueue_job';
  end if;

  -- 6. anon and authenticated still reach nothing here.
  foreach v_bad in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_bad)
       and has_schema_privilege(v_bad, 'ops', 'USAGE') then
      raise exception 'role % can reach schema ops', v_bad;
    end if;
  end loop;

  -- 7. Every policy in ops still routes through the one helper. worker_instances
  --    has no policy at all, which satisfies this vacuously and is the point.
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

  -- 8. The metrics view executes as its INVOKER. Without this it would hand a
  --    worker every tenant's counts.
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'ops' and c.relname = 'queue_metrics'
      and c.reloptions @> array['security_invoker=on']
  ) then
    raise exception 'ops.queue_metrics is not security_invoker; it would leak every tenant''s counts';
  end if;

  -- 9. At most one tenant owns the local CRM.
  if (select count(*) from ops.tenants where owns_local_crm) > 1 then
    raise exception 'more than one tenant is marked owns_local_crm';
  end if;
end
$$;
