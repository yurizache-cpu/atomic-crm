-- Phase 2E.2: operational intelligence, from AUTHORITATIVE Company OS state.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_2E_REPORT.md):
--
--   ops.cos_operational_health(tenant, as_of, today): exact, tenant-scoped
--   operational facts for the owner's "Saúde operacional" screen, returned by
--   the existing overview read as `operationalHealth`:
--     * the work queue: ready, scheduled, running and expired-lease jobs, the
--       oldest ready job's time, and jobs that ended in the last 24 hours, in
--       total and per job kind;
--     * agent runs created in the last 24 hours by status, and the provider
--       latency of those that succeeded: a sample size always, a median only
--       from 5 samples and a 95th percentile only from 20, never from one or
--       two observations;
--     * shadow decision evaluations requested in the last 24 hours by outcome,
--       and those pending now;
--     * WhatsApp sends created in the last 24 hours by status;
--     * spend: charged today (the tenant's budget day), in the last 24 hours
--       and the last 7 days, keyed on started_at exactly as the spend limits
--       count it (ops.spend_window_total), and what running calls hold
--       reserved now, in exact integer micros.
--
-- WHERE IT COMES FROM: PostgreSQL rows only (ops.jobs, ops.agent_runs,
-- ops.decision_evaluations, ops.outbound_messages), never Prometheus or any
-- telemetry. It is correct with the observability stack offline, and
-- telemetry has no authority over any of it.
--
-- WHAT IT DOES NOT DO: judge. No score, no health percentage and no SLA:
-- ages and counts are shown as they are, and "needs attention" is decided in
-- the screen from concrete states only. It carries no id, name, body, draft,
-- phone, email, prompt, answer or error text. It adds no company_os_api
-- function (still 17, exactly two of them acts) and no write of any kind.

create function ops.cos_operational_health(p_tenant_id pg_catalog.uuid, p_as_of pg_catalog.timestamptz,
                                           p_today pg_catalog.timestamptz)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  with bounds as (
    select p_as_of - interval '24 hours' as since, p_as_of - interval '7 days' as week_since
  ),
  -- Jobs that are live now, or ended inside the window.
  j as (
    select case when x.kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and pg_catalog.char_length(x.kind) <= 64
                then x.kind else 'other' end as kind,
           x.status, x.available_at, x.lease_expires_at, x.completed_at
      from ops.jobs x
     where x.tenant_id = p_tenant_id
       and (x.status in ('queued', 'leased') or x.completed_at >= (select since from bounds))
  ),
  k as (
    select j.kind,
           count(*) filter (where j.status = 'queued' and j.available_at <= p_as_of) as ready,
           count(*) filter (where j.status = 'queued' and j.available_at > p_as_of) as scheduled,
           count(*) filter (where j.status = 'leased' and j.lease_expires_at > p_as_of) as running,
           count(*) filter (where j.status = 'leased' and j.lease_expires_at <= p_as_of) as expired_leases,
           count(*) filter (where j.status = 'succeeded') as succeeded_in_window,
           count(*) filter (where j.status = 'failed') as failed_in_window,
           min(j.available_at) filter (where j.status = 'queued' and j.available_at <= p_as_of) as oldest_ready_at
      from j group by j.kind
  ),
  latency as (
    select count(*) as n,
           percentile_disc(0.5) within group (order by r.latency_ms) as p50,
           percentile_disc(0.95) within group (order by r.latency_ms) as p95
      from ops.agent_runs r
     where r.tenant_id = p_tenant_id and r.status = 'succeeded' and r.latency_ms is not null
       and r.created_at >= (select since from bounds)
  ),
  d as (
    select e.status, e.vector ->> 'recommendation' as recommendation, e.requested_at
      from ops.decision_evaluations e
     where e.tenant_id = p_tenant_id
       and (e.status in ('pending', 'running') or e.requested_at >= (select since from bounds))
  ),
  -- Keyed on started_at, as the budget is: a run held by a stop and started
  -- after the clear is charged to the day it started. A started run always
  -- carries its charge (agent_runs_cost_iff_started).
  spend as (
    select coalesce(sum(r.charged_cost_micros) filter (where r.started_at >= p_today), 0)::pg_catalog.int8 as today,
           coalesce(sum(r.charged_cost_micros) filter (where r.started_at >= (select since from bounds)), 0)::pg_catalog.int8 as in_window,
           coalesce(sum(r.charged_cost_micros) filter (where r.started_at >= (select week_since from bounds)), 0)::pg_catalog.int8 as week,
           coalesce(sum(r.charged_cost_micros) filter (where r.status = 'running'), 0)::pg_catalog.int8 as reserved
      from ops.agent_runs r
     where r.tenant_id = p_tenant_id
       and (r.started_at >= least(p_today, (select week_since from bounds)) or r.status = 'running')
  )
  select pg_catalog.jsonb_build_object(
    'windowHours', 24,
    'queue', (select pg_catalog.jsonb_build_object(
                'ready', coalesce(sum(k.ready), 0), 'scheduled', coalesce(sum(k.scheduled), 0),
                'running', coalesce(sum(k.running), 0), 'expiredLeases', coalesce(sum(k.expired_leases), 0),
                'oldestReadyAt', ops.cos_ts(min(k.oldest_ready_at)),
                'succeededInWindow', coalesce(sum(k.succeeded_in_window), 0),
                'failedInWindow', coalesce(sum(k.failed_in_window), 0))
                from k),
    'queueByKind', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'kind', k.kind, 'ready', k.ready, 'scheduled', k.scheduled, 'running', k.running,
                    'expiredLeases', k.expired_leases, 'succeededInWindow', k.succeeded_in_window,
                    'failedInWindow', k.failed_in_window) order by k.kind)
                    from k), '[]'::pg_catalog.jsonb),
    'agentRuns', pg_catalog.jsonb_build_object(
      'inWindowByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                      from (select r.status, count(*) as n from ops.agent_runs r
                                             where r.tenant_id = p_tenant_id and r.created_at >= (select since from bounds)
                                             group by r.status) s), '{}'::pg_catalog.jsonb),
      'latency', (select pg_catalog.jsonb_build_object(
                    'sampleSize', l.n,
                    'p50Ms', case when l.n >= 5 then l.p50 end,
                    'p95Ms', case when l.n >= 20 then l.p95 end,
                    'minSamplesP50', 5, 'minSamplesP95', 20)
                    from latency l)),
    'decisions', pg_catalog.jsonb_build_object(
      'inWindow', pg_catalog.jsonb_build_object(
        'completed', (select count(*) from d where d.requested_at >= (select since from bounds)
                         and d.status = 'completed' and d.recommendation is distinct from 'abstain'),
        'abstained', (select count(*) from d where d.requested_at >= (select since from bounds)
                         and d.status = 'completed' and d.recommendation = 'abstain'),
        'invalid', (select count(*) from d where d.requested_at >= (select since from bounds) and d.status = 'invalid'),
        'failed', (select count(*) from d where d.requested_at >= (select since from bounds) and d.status = 'failed'),
        'indeterminate', (select count(*) from d where d.requested_at >= (select since from bounds) and d.status = 'indeterminate'),
        'refused', (select count(*) from d where d.requested_at >= (select since from bounds) and d.status = 'refused')),
      'pendingNow', (select count(*) from d where d.status in ('pending', 'running'))),
    'outbound', pg_catalog.jsonb_build_object(
      'inWindowByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                      from (select o.status, count(*) as n from ops.outbound_messages o
                                             where o.tenant_id = p_tenant_id and o.created_at >= (select since from bounds)
                                             group by o.status) s), '{}'::pg_catalog.jsonb)),
    'spend', (select pg_catalog.jsonb_build_object(
                'chargedToday', ops.cos_money(s.today), 'chargedInWindow', ops.cos_money(s.in_window),
                'chargedLast7Days', ops.cos_money(s.week), 'reservedInFlight', ops.cos_money(s.reserved))
                from spend s));
$$;

comment on function ops.cos_operational_health(pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz) is
  'Phase 2E.2: exact, tenant-scoped operational facts (queue, runs, latency, decisions, sends, spend) from authoritative rows. Counts, times and integer micros only. Read by ops.read_overview; never telemetry.';

-- The overview gains the operational health section; nothing else in it changes.
create or replace function ops.read_overview(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
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
    'platform', pg_catalog.jsonb_build_object('globalAdmissionBlocked', ops.cos_global_admission_blocked()),
    -- Phase 2D.3: shadow calibration, aggregate and advisory.
    'decisionIntelligence', ops.cos_decision_intelligence(p_tenant_id),
    -- Phase 2E.2: operational health, exact and tenant-scoped.
    'operationalHealth', ops.cos_operational_health(p_tenant_id, v_as_of, v_today));
end
$$;

revoke all on function ops.cos_operational_health(pg_catalog.uuid, pg_catalog.timestamptz, pg_catalog.timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_bad pg_catalog.text;
  v_health pg_catalog.jsonb;
begin
  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_function_privilege(r.rolname,
           'ops.cos_operational_health(uuid, timestamptz, timestamptz)', 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute ops.cos_operational_health: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid = 'ops.cos_operational_health(uuid, timestamptz, timestamptz)'::pg_catalog.regprocedure
                and (p.provolatile <> 's' or p.prosecdef)) then
    raise exception 'ops.cos_operational_health must be STABLE and SECURITY INVOKER';
  end if;
  -- An unknown tenant reads zeros and nothing else: every section present.
  v_health := ops.read_overview('00000000-0000-4000-8000-000000000000'::pg_catalog.uuid) -> 'operationalHealth';
  if v_health is null
     or (v_health -> 'queue' ->> 'ready')::pg_catalog.int8 <> 0
     or v_health -> 'queueByKind' <> '[]'::pg_catalog.jsonb
     or (v_health -> 'agentRuns' -> 'latency' ->> 'sampleSize')::pg_catalog.int8 <> 0
     or v_health -> 'spend' -> 'chargedToday' ->> 'micros' <> '0' then
    raise exception 'the overview''s operationalHealth is missing or not zero for an unknown tenant';
  end if;
end
$end_state$;
