-- Phase 2E.1: the worker's queue-depth gauge (docs/PHASE_2E_REPORT.md).
--
-- WHAT THIS MIGRATION ADDS: ops.worker_queue_depth(), ONE count: the queued
-- jobs whose available time has come, across the deployment. The worker reads
-- it on its reaper tick, only when metrics are enabled, and publishes it as
-- the Prometheus gauge company_os_worker_queue_depth.
--
-- WHY IT IS SAFE TO GIVE THE WORKER: it answers a number and nothing else: no
-- tenant, job, kind, payload or time. The worker already leases jobs from
-- every tenant (ops.lease_job is deployment-wide by design), so a count of
-- that same queue reveals nothing it could not already see; it grants no
-- write, no lease and no tenant context. It is read-only (STABLE) and takes no
-- argument, so a caller cannot aim it.
--
-- WHAT IT DOES NOT DO: decide anything. Telemetry has no authority: nothing
-- reads this count back to lease, hold, stop, admit, retry or send.

create function ops.worker_queue_depth()
returns pg_catalog.int8
language sql
stable
security definer
set search_path to ''
as $function$
  select pg_catalog.count(*)
    from ops.jobs j
   where j.status = 'queued' and j.available_at <= pg_catalog.now();
$function$;

comment on function ops.worker_queue_depth() is
  'Phase 2E.1: the number of queued jobs ready to run, deployment-wide, for the worker''s metrics gauge. A count only; no tenant, job or content. Observation, never authority.';

revoke all on function ops.worker_queue_depth() from public, anon, authenticated, service_role, ops_gateway;
grant execute on function ops.worker_queue_depth() to ops_worker;

do $end_state$
declare
  v_bad pg_catalog.text;
begin
  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_function_privilege(r.rolname, 'ops.worker_queue_depth()', 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role other than ops_worker can execute ops.worker_queue_depth(): %', v_bad;
  end if;
  if not pg_catalog.has_function_privilege('ops_worker', 'ops.worker_queue_depth()', 'EXECUTE') then
    raise exception 'ops_worker cannot execute ops.worker_queue_depth()';
  end if;
  if (select p.provolatile from pg_catalog.pg_proc p where p.oid = 'ops.worker_queue_depth()'::pg_catalog.regprocedure) <> 's' then
    raise exception 'ops.worker_queue_depth() must be STABLE: it reads and never writes';
  end if;
end
$end_state$;
