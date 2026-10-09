-- ADR 0026 §D, slice 4: the waiting list, read only, returned by the EXISTING
-- overview.
--
--   ops.cos_waiting_list(tenant, as_of): the conversations that wait for a
--   person now (an open request for a person or a waiting message), oldest
--   first, at most 50 shown with the exact total: each by an opaque reference
--   to the task of its oldest open episode, its kinds and their counts, since
--   when it waits, the contact's last message and the end of its 24-hour
--   window, and the state of the owner's notification about it. Instants
--   only, never an age computed here, so a recording stays byte-stable.
--   Never a text, a number, a name, a conversation id or an event order.
--
-- No company_os_api function is added and the browser gains no act: the
-- overview it already reads carries one more key (SI-82, SI-86).
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

create function ops.cos_waiting_list(p_tenant pg_catalog.uuid, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with eps as (
    select e.id, e.conversation_id, e.kind, e.task_id, e.raised_at, e.occurrences
      from ops.exceptions e
     where e.tenant_id = p_tenant and e.resolved_at is null
       and e.kind in ('person_requested', 'message_waiting') and e.raised_at <= p_as_of),
  convs as (
    select x.conversation_id, pg_catalog.min(x.raised_at) as since,
           (pg_catalog.array_agg(x.task_id order by x.raised_at, x.id))[1] as ref_task,
           pg_catalog.array_agg(distinct x.kind order by x.kind) as kinds,
           pg_catalog.jsonb_object_agg(x.kind, x.occurrences) as counts,
           pg_catalog.array_agg(x.id) as episode_ids
      from eps x
     group by x.conversation_id),
  waiting as (
    select c.since, ops.cos_ref_id(p_tenant, 'task', c.ref_task) as ref, c.kinds, c.counts, v.last_inbound_at,
           case coalesce(case when n.status = 'coalesced' then k.status else n.status end, 'none')
             when 'none' then 'none'
             when 'pending' then 'pending'
             when 'sending' then 'pending'
             when 'sent' then 'sent'
             when 'delivered' then 'delivered'
             when 'read' then 'read'
             when 'failed' then 'failed'
             when 'carrier_failed' then 'failed'
             when 'indeterminate' then 'indeterminate'
             when 'skipped_resolved' then 'skipped'
             when 'skipped_answered' then 'skipped'
             else 'blocked' end as nstate,
           case when n.status = 'coalesced'
                then coalesce(k.read_at, k.delivered_at, k.settled_at, k.sending_at, k.recorded_at)
                else coalesce(n.read_at, n.delivered_at, n.settled_at, n.sending_at, n.recorded_at) end as nat
      from convs c
      join ops.conversations v on v.tenant_id = p_tenant and v.id = c.conversation_id
      left join lateral (select o.* from ops.owner_notifications o
                          where o.tenant_id = p_tenant and o.exception_id = any (c.episode_ids)
                            and o.recorded_at <= p_as_of
                          order by o.recorded_at desc, o.id desc
                          limit 1) n on true
      left join ops.owner_notifications k on k.tenant_id = p_tenant and k.id = n.carried_by)
  select pg_catalog.jsonb_build_object(
    'total', (select count(*) from waiting),
    'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ref', r.ref,
        'kinds', pg_catalog.to_jsonb(r.kinds),
        'counts', r.counts,
        'waitingSince', ops.cos_ts(r.since),
        'lastMessageAt', ops.cos_ts(r.last_inbound_at),
        'windowEndsAt', ops.cos_ts(r.last_inbound_at + interval '24 hours'),
        'notification', pg_catalog.jsonb_build_object('state', r.nstate, 'at', ops.cos_ts(r.nat)))
        order by r.since, r.ref)
      from (select w.* from waiting w order by w.since, w.ref limit 50) r), '[]'::pg_catalog.jsonb));
$$;

comment on function ops.cos_waiting_list(pg_catalog.uuid, pg_catalog.timestamptz) is
  'ADR 0026 §D, SI-82, SI-86: the conversations waiting for a person, oldest first (50 shown, the exact total), by an opaque task reference: kinds, counts, instants and the owner notification''s state. Read only; returned by ops.read_overview as waitingList.';

-- As 20260929130000, with the waiting list.
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
    'operationalHealth', ops.cos_operational_health(p_tenant_id, v_as_of, v_today),
    -- Phase 3A: the agenda, deterministic in its rows and this instant.
    'agenda', ops.cos_agenda(p_tenant_id, v_as_of),
    -- Phase 3B.1: the commercial funnel, read from the local CRM behind the
    -- provider seam, for the tenant that owns it only.
    'funnel', ops.cos_commercial_funnel(p_tenant_id, v_as_of),
    -- ADR 0026 §D: who waits for a person now, oldest first.
    'waitingList', ops.cos_waiting_list(p_tenant_id, v_as_of));
end
$$;

revoke all on function ops.cos_waiting_list(pg_catalog.uuid, pg_catalog.timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_bad  pg_catalog.text;
  v_list pg_catalog.jsonb;
begin
  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                 ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_function_privilege(r.rolname,
           'ops.cos_waiting_list(pg_catalog.uuid, pg_catalog.timestamptz)', 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute the waiting list projection: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid = 'ops.cos_waiting_list(pg_catalog.uuid, pg_catalog.timestamptz)'::pg_catalog.regprocedure
                and (p.provolatile <> 's' or p.prosecdef or p.proconfig is distinct from array['search_path=""']
                     or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
                     or p.prosrc ~* '(insert\s|update\s|delete\s|truncate\s|merge\s|enqueue_job|record_event|execute\s)')) then
    raise exception 'the waiting list must be a pinned STABLE INVOKER that only reads';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.read_overview(pg_catalog.uuid)'::pg_catalog.regprocedure),
                       'cos_waiting_list') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.read_overview(pg_catalog.uuid)'::pg_catalog.regprocedure),
                          'cos_commercial_funnel') = 0 then
    raise exception 'the overview does not carry the waiting list beside the funnel';
  end if;
  v_list := ops.read_overview('00000000-0000-4000-8000-000000000000'::pg_catalog.uuid) -> 'waitingList';
  if v_list is distinct from '{"total": 0, "items": []}'::pg_catalog.jsonb then
    raise exception 'an unknown tenant''s waiting list is not empty: %', v_list;
  end if;
end
$end_state$;
