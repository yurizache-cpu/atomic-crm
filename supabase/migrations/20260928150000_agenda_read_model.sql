-- Phase 3A: the owner's Agenda, read only, returned by the EXISTING overview.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_3A_REPORT.md):
--
--   ops.cos_agenda(tenant, as_of): an exact, tenant-scoped projection of the
--   tenant's scheduling state, returned by ops.read_overview as `agenda`, so
--   no company_os_api function is added (still 17, exactly two of them acts)
--   and the browser gains no mutation:
--     * bookings: today's (every state), the next 7 days' booked, and the
--       cancellations and reschedules inside that window, with counts and a
--       verification count of overlapping booked bookings (always zero, the
--       exclusion constraint forbids one; a non-zero value would mean it was
--       dropped);
--     * follow-ups: those that need action (due), how many are overdue, due
--       today, still waiting for the worker, scheduled in the next 7 days, and
--       the ones closed around this week;
--     * availability: the next offered slots of each active resource and
--       booking type (ops.available_slots, deterministic);
--     * calendar: local-only or simulated, and the sync states of the upcoming
--       bookings.
--
-- DETERMINISTIC. The projection is a pure function of the rows and `as_of`:
-- every window is keyed on an appointment's start or a follow-up's due time
-- in the tenant's scheduling zone, never on the moment a change was recorded.
--
-- MINIMISED. Ids of the tenant's own rows, instants, states, reason codes and
-- the owner's configuration labels (resource, booking type, policy). Never a
-- subject reference, a name, a phone, an email, a message, an actor label, an
-- idempotency key, a fingerprint, the internal slot key, a provider event id
-- or error text.

create function ops.cos_booking_summary(p_tenant pg_catalog.uuid, b ops.bookings)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', b.id,
    'startAt', ops.cos_ts(b.start_at),
    'endAt', ops.cos_ts(b.end_at),
    'timezone', b.timezone,
    'status', b.status,
    'resource', (select pg_catalog.jsonb_build_object('id', r.id, 'label', r.label)
                   from ops.booking_resources r where r.tenant_id = p_tenant and r.id = b.resource_id),
    'bookingType', (select pg_catalog.jsonb_build_object('id', t.id, 'label', t.label)
                      from ops.booking_types t where t.tenant_id = p_tenant and t.id = b.booking_type_id),
    'rescheduledFromId', (select p.id from ops.bookings p where p.tenant_id = p_tenant and p.id = b.rescheduled_from_id),
    'rescheduledTo', (select pg_catalog.jsonb_build_object('id', s.id, 'startAt', ops.cos_ts(s.start_at))
                        from ops.bookings s where s.tenant_id = p_tenant and s.rescheduled_from_id = b.id),
    'cancelReason', b.cancel_reason,
    'taskId', ops.cos_ref_id(p_tenant, 'task', b.task_id),
    'calendarSync', (select s.status from ops.calendar_syncs s
                      where s.tenant_id = p_tenant and s.booking_id = b.id
                      order by s.requested_at desc, pg_catalog.array_position(array['create', 'update', 'cancel'], s.operation) desc
                      limit 1));
$$;

create function ops.cos_follow_up_summary(p_tenant pg_catalog.uuid, f ops.follow_ups, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'id', f.id,
    'planId', f.plan_id,
    'step', f.step_number,
    'stepCount', f.step_count,
    'dueAt', ops.cos_ts(f.due_at),
    'status', f.status,
    -- Scheduled and past its due time: the worker has not marked it yet (it
    -- is not running, or an execution stop holds its job).
    'awaitingProcessing', f.status = 'scheduled' and f.due_at <= p_as_of,
    'policy', (select pg_catalog.jsonb_build_object('key', p.key, 'label', p.label)
                 from ops.follow_up_plans pl
                 join ops.follow_up_policy_versions v on v.tenant_id = pl.tenant_id and v.id = pl.policy_version_id
                 join ops.follow_up_policies p on p.tenant_id = v.tenant_id and p.id = v.policy_id
                where pl.tenant_id = p_tenant and pl.id = f.plan_id),
    -- The task it follows up, when it names one. A conversation id never
    -- leaves for the browser (the Phase 2C contracts forbid it).
    'taskId', (select ops.cos_ref_id(p_tenant, 'task', pl.task_id)
                 from ops.follow_up_plans pl where pl.tenant_id = p_tenant and pl.id = f.plan_id),
    'closeReason', f.close_reason);
$$;

create function ops.cos_agenda(p_tenant_id pg_catalog.uuid, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_configured     pg_catalog.bool := exists (select 1 from ops.scheduling_settings s where s.tenant_id = p_tenant_id);
  v_zone           pg_catalog.text := coalesce((select s.timezone from ops.scheduling_settings s
                                                 where s.tenant_id = p_tenant_id), 'UTC');
  v_today          pg_catalog.date := (p_as_of at time zone v_zone)::pg_catalog.date;
  v_today_start    pg_catalog.timestamptz := (v_today::pg_catalog.timestamp) at time zone v_zone;
  v_tomorrow_start pg_catalog.timestamptz := ((v_today + 1)::pg_catalog.timestamp) at time zone v_zone;
  -- Today and the next seven days.
  v_horizon        pg_catalog.timestamptz := ((v_today + 8)::pg_catalog.timestamp) at time zone v_zone;
  v_week_before    pg_catalog.timestamptz := p_as_of - interval '7 days';
begin
  return pg_catalog.jsonb_build_object(
    'timezone', v_zone,
    'timezoneConfigured', v_configured,
    'today', pg_catalog.to_char(v_today, 'YYYY-MM-DD'),
    'bookings', pg_catalog.jsonb_build_object(
      'todayBooked', (select count(*) from ops.bookings b
                       where b.tenant_id = p_tenant_id and b.status = 'booked'
                         and b.start_at >= v_today_start and b.start_at < v_tomorrow_start),
      'next7DaysBooked', (select count(*) from ops.bookings b
                           where b.tenant_id = p_tenant_id and b.status = 'booked'
                             and b.start_at >= v_tomorrow_start and b.start_at < v_horizon),
      'cancelledInWindow', (select count(*) from ops.bookings b
                             where b.tenant_id = p_tenant_id and b.status = 'cancelled'
                               and b.start_at >= v_today_start and b.start_at < v_horizon),
      'rescheduledInWindow', (select count(*) from ops.bookings b
                               where b.tenant_id = p_tenant_id and b.status = 'rescheduled'
                                 and b.start_at >= v_today_start and b.start_at < v_horizon),
      'conflicts', (select count(*) from ops.bookings a
                      join ops.bookings b on b.tenant_id = a.tenant_id and b.resource_id = a.resource_id and b.id > a.id
                     where a.tenant_id = p_tenant_id and a.status = 'booked' and b.status = 'booked'
                       and a.start_at < v_horizon and b.start_at < v_horizon
                       and a.end_at >= v_today_start and b.end_at >= v_today_start
                       and a.occupied && b.occupied),
      'today', coalesce((select pg_catalog.jsonb_agg(ops.cos_booking_summary(p_tenant_id, x) order by x.start_at, x.id)
                           from (select b.* from ops.bookings b
                                  where b.tenant_id = p_tenant_id
                                    and b.start_at >= v_today_start and b.start_at < v_tomorrow_start
                                  order by b.start_at, b.id limit 50) x), '[]'::pg_catalog.jsonb),
      'upcoming', coalesce((select pg_catalog.jsonb_agg(ops.cos_booking_summary(p_tenant_id, x) order by x.start_at, x.id)
                              from (select b.* from ops.bookings b
                                     where b.tenant_id = p_tenant_id and b.status = 'booked'
                                       and b.start_at >= v_tomorrow_start and b.start_at < v_horizon
                                     order by b.start_at, b.id limit 50) x), '[]'::pg_catalog.jsonb),
      'changes', coalesce((select pg_catalog.jsonb_agg(ops.cos_booking_summary(p_tenant_id, x) order by x.start_at, x.id)
                             from (select b.* from ops.bookings b
                                    where b.tenant_id = p_tenant_id and b.status in ('cancelled', 'rescheduled')
                                      and b.start_at >= v_today_start and b.start_at < v_horizon
                                    order by b.start_at, b.id limit 20) x), '[]'::pg_catalog.jsonb)),
    'followUps', pg_catalog.jsonb_build_object(
      'due', (select count(*) from ops.follow_ups f where f.tenant_id = p_tenant_id and f.status = 'due'),
      'overdue', (select count(*) from ops.follow_ups f
                   where f.tenant_id = p_tenant_id and f.status = 'due' and f.due_at < v_today_start),
      'dueToday', (select count(*) from ops.follow_ups f
                    where f.tenant_id = p_tenant_id and f.status in ('scheduled', 'due')
                      and f.due_at >= v_today_start and f.due_at < v_tomorrow_start),
      'awaitingProcessing', (select count(*) from ops.follow_ups f
                              where f.tenant_id = p_tenant_id and f.status = 'scheduled' and f.due_at <= p_as_of),
      'scheduledNext7Days', (select count(*) from ops.follow_ups f
                              where f.tenant_id = p_tenant_id and f.status = 'scheduled'
                                and f.due_at > p_as_of and f.due_at < v_horizon),
      'closedRecently', (select count(*) from ops.follow_ups f
                          where f.tenant_id = p_tenant_id and f.status in ('completed', 'cancelled')
                            and f.due_at >= v_week_before and f.due_at < v_horizon),
      'needingAction', coalesce((select pg_catalog.jsonb_agg(ops.cos_follow_up_summary(p_tenant_id, x, p_as_of) order by x.due_at, x.id)
                                   from (select f.* from ops.follow_ups f
                                          where f.tenant_id = p_tenant_id and f.status = 'due'
                                          order by f.due_at, f.id limit 50) x), '[]'::pg_catalog.jsonb),
      'scheduled', coalesce((select pg_catalog.jsonb_agg(ops.cos_follow_up_summary(p_tenant_id, x, p_as_of) order by x.due_at, x.id)
                               from (select f.* from ops.follow_ups f
                                      where f.tenant_id = p_tenant_id and f.status = 'scheduled' and f.due_at < v_horizon
                                      order by f.due_at, f.id limit 50) x), '[]'::pg_catalog.jsonb),
      'recentlyClosed', coalesce((select pg_catalog.jsonb_agg(ops.cos_follow_up_summary(p_tenant_id, x, p_as_of) order by x.due_at desc, x.id)
                                    from (select f.* from ops.follow_ups f
                                           where f.tenant_id = p_tenant_id and f.status in ('completed', 'cancelled')
                                             and f.due_at >= v_week_before and f.due_at < v_horizon
                                           order by f.due_at desc, f.id limit 20) x), '[]'::pg_catalog.jsonb)),
    'availability', coalesce((
      select pg_catalog.jsonb_agg(pair order by pair -> 'resource' ->> 'label', pair -> 'bookingType' ->> 'label',
                                                pair -> 'resource' ->> 'id', pair -> 'bookingType' ->> 'id')
        from (select pg_catalog.jsonb_build_object(
                       'resource', pg_catalog.jsonb_build_object('id', r.id, 'label', r.label),
                       'bookingType', pg_catalog.jsonb_build_object('id', t.id, 'label', t.label,
                                                                    'durationMinutes', t.duration_minutes),
                       'nextSlots', coalesce((select pg_catalog.jsonb_agg(
                                                       pg_catalog.jsonb_build_object('startAt', ops.cos_ts(s.start_at),
                                                                                     'endAt', ops.cos_ts(s.end_at))
                                                       order by s.start_at)
                                                from ops.available_slots(p_tenant_id, r.id, t.id, p_as_of,
                                                                         p_as_of + interval '14 days', 5) s),
                                             '[]'::pg_catalog.jsonb)) as pair
                from ops.booking_resources r
                join ops.booking_types t on t.tenant_id = r.tenant_id and t.company_id = r.company_id
               where r.tenant_id = p_tenant_id and r.active and t.active
                 and exists (select 1 from ops.availability_rules a
                              where a.tenant_id = p_tenant_id and a.resource_id = r.id and a.active)
               order by r.label, t.label, r.id, t.id
               limit 10) pairs), '[]'::pg_catalog.jsonb),
    'calendar', pg_catalog.jsonb_build_object(
      'state', case when exists (select 1 from ops.calendar_connections c
                                  where c.tenant_id = p_tenant_id and c.active and c.provider_kind = 'fake')
                    then 'simulated' else 'local_only' end,
      'upcomingSyncs', (select pg_catalog.jsonb_build_object(
                                 'pending', count(*) filter (where s.status = 'pending'),
                                 'running', count(*) filter (where s.status = 'running'),
                                 'synced', count(*) filter (where s.status = 'synced'),
                                 'failed', count(*) filter (where s.status = 'failed'),
                                 'indeterminate', count(*) filter (where s.status = 'indeterminate'),
                                 'skipped', count(*) filter (where s.status = 'skipped'))
                          from ops.calendar_syncs s
                          join ops.bookings b on b.tenant_id = s.tenant_id and b.id = s.booking_id
                         where s.tenant_id = p_tenant_id and b.start_at >= v_today_start)));
end
$$;

comment on function ops.cos_agenda(pg_catalog.uuid, pg_catalog.timestamptz) is
  'Phase 3A: the tenant''s agenda at an instant: bookings, follow-ups, next available slots and calendar state, keyed on appointment and due instants in the tenant''s scheduling zone. Deterministic in its rows and as_of. Read by ops.read_overview; never a mutation.';

-- The overview gains the agenda section; nothing else in it changes
-- (20260927130000_operational_health.sql).
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
    'agenda', ops.cos_agenda(p_tenant_id, v_as_of));
end
$$;

-- The synthetic scheduling demo's provenance label (engine/cli/schedulingDemo.ts).
create or replace function ops.cos_event_source(p_source pg_catalog.text) returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case when p_source in ('agent-runtime', 'agent-runtime-smoke', 'company-os-ui', 'lead-triage-demo',
                                'operator-cli', 'scheduling-demo', 'seed', 'whatsapp-gateway')
              then p_source else 'other' end;
$$;

revoke all on function
  ops.cos_booking_summary(pg_catalog.uuid, ops.bookings),
  ops.cos_follow_up_summary(pg_catalog.uuid, ops.follow_ups, pg_catalog.timestamptz),
  ops.cos_agenda(pg_catalog.uuid, pg_catalog.timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_bad    pg_catalog.text;
  v_agenda pg_catalog.jsonb;
begin
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname in ('cos_booking_summary', 'cos_follow_up_summary', 'cos_agenda')
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute an agenda projection: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname in ('cos_booking_summary', 'cos_follow_up_summary', 'cos_agenda')
                and (p.provolatile <> 's' or p.prosecdef)) then
    raise exception 'an agenda projection must be STABLE and SECURITY INVOKER';
  end if;
  -- READ ONLY: no agenda projection writes, sends, calls or acts.
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname in ('cos_booking_summary', 'cos_follow_up_summary', 'cos_agenda')
                and p.prosrc ~* '(insert\s|update\s|delete\s|create_booking|reschedule_booking|cancel_booking|complete_follow_up|cancel_follow_up|schedule_follow_up|enqueue_job|record_event|trip_execution_stop|execute\s)') then
    raise exception 'an agenda projection reaches beyond reading';
  end if;
  -- An unknown tenant reads an empty, local-only agenda, every section present.
  v_agenda := ops.read_overview('00000000-0000-4000-8000-000000000000'::pg_catalog.uuid) -> 'agenda';
  if v_agenda is null
     or v_agenda ->> 'timezone' <> 'UTC'
     or (v_agenda -> 'bookings' ->> 'todayBooked')::pg_catalog.int8 <> 0
     or v_agenda -> 'bookings' -> 'today' <> '[]'::pg_catalog.jsonb
     or (v_agenda -> 'followUps' ->> 'due')::pg_catalog.int8 <> 0
     or v_agenda -> 'availability' <> '[]'::pg_catalog.jsonb
     or v_agenda -> 'calendar' ->> 'state' <> 'local_only' then
    raise exception 'the overview''s agenda is missing or not empty for an unknown tenant';
  end if;
end
$end_state$;
