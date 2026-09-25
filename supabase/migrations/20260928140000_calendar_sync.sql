-- Phase 3A.2: the external calendar as an ADAPTER, never the authority.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_3A_REPORT.md):
--
--   1. ops.calendar_connections: whether a company's bookings are mirrored to
--      an external calendar, with which provider and under which generic event
--      title (the owner's data). The only provider kind
--      that can be configured is `fake`, the deterministic provider of the
--      tests and the synthetic demo (the Company OS shows it as "Simulado").
--      REAL GOOGLE CALENDAR IS NOT CONNECTED: no authentication model, token
--      storage or data-processing contract is approved, so none is invented,
--      and adding a real provider kind is a reviewed migration after those
--      decisions. No credential or token column exists.
--   2. ops.calendar_syncs: one record per (booking, operation), requested in
--      the same transaction as the booking change it mirrors (an AFTER
--      trigger on ops.bookings), with its own lifecycle: pending -> running ->
--      synced, failed or indeterminate; pending -> skipped or failed when no
--      call can be made. Company OS booking state is settled BEFORE and
--      independently of it: a sync never changes a booking.
--   3. Three EXTERNAL job kinds, calendar.create, calendar.update and
--      calendar.cancel, on the existing queue: the one kill switch holds them
--      at the lease and again before the call, and a job_kind stop can name
--      each of them.
--   4. The worker's two lease-bound capabilities, in the shape every external
--      call uses (engine/worker/externalCall.ts): ops.start_calendar_sync
--      records `running` BEFORE the provider is called, and a start that finds
--      an earlier attempt's `running` settles it indeterminate instead of
--      calling again (AT MOST ONCE); ops.settle_calendar_sync stores the
--      outcome. A provider event id is stored only on an unambiguous success.
--      Nothing retries an ambiguous call.
--   5. The minimised request: a generic title the owner configured (the demo
--      uses "Atendimento"), the start and end instants, the zone and an opaque
--      reference. Never a name, phone, email, note, message, model output,
--      triage text, resource or booking-type label.

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

create table ops.calendar_connections (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references ops.tenants (id) on delete restrict,
  company_id    uuid not null,
  provider_kind text not null,
  event_title   text not null,
  active        boolean not null default true,
  configured_by text not null,
  configured_at timestamptz not null default now(),
  -- The real-provider gate: only the deterministic fake can be configured.
  -- A real calendar (Google Calendar) needs an approved authentication,
  -- credential-storage and data-processing contract first; then a reviewed
  -- migration widens this, and nothing else can.
  constraint calendar_connections_provider_gate  check (provider_kind in ('fake')),
  constraint calendar_connections_title_format   check (char_length(btrim(event_title)) between 1 and 40
                                                        and event_title !~ '[[:cntrl:]]'),
  constraint calendar_connections_actor_length   check (char_length(btrim(configured_by)) between 1 and 200),
  constraint calendar_connections_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint calendar_connections_company_key    unique (tenant_id, company_id),
  constraint calendar_connections_scope_id_key   unique (tenant_id, company_id, id)
);

comment on table ops.calendar_connections is
  'Whether a company''s bookings are mirrored to an external calendar. Only the deterministic fake provider can be configured; real Google Calendar is not connected. No credential is stored.';

create table ops.calendar_syncs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references ops.tenants (id) on delete restrict,
  company_id        uuid not null,
  department_id     uuid not null,
  booking_id        uuid not null,
  connection_id     uuid not null,
  operation         text not null,
  status            text not null default 'pending',
  job_id            uuid,
  job_attempt       integer,
  provider_kind     text,
  -- create: stored only on an unambiguous success. update and cancel: the
  -- event the call was asked to change, recorded when it starts.
  external_event_id text,
  error_code        text,
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  settled_at        timestamptz,
  constraint calendar_syncs_operation_check  check (operation in ('create', 'update', 'cancel')),
  constraint calendar_syncs_status_check     check (status in ('pending', 'running', 'synced', 'failed',
                                                               'indeterminate', 'skipped')),
  constraint calendar_syncs_started_iff      check ((status = 'running') <= (started_at is not null and job_attempt is not null)),
  constraint calendar_syncs_settled_iff      check ((status in ('synced', 'failed', 'indeterminate', 'skipped'))
                                                    = (settled_at is not null)),
  constraint calendar_syncs_created_event    check (operation <> 'create'
                                                    or (external_event_id is not null) = (status = 'synced')),
  constraint calendar_syncs_changed_event    check (operation = 'create'
                                                    or status in ('pending', 'skipped')
                                                    or (status = 'failed' and started_at is null)
                                                    or external_event_id is not null),
  constraint calendar_syncs_event_format     check (external_event_id is null
                                                    or external_event_id ~ '^[A-Za-z0-9._:@-]{1,255}$'),
  constraint calendar_syncs_error_format     check (error_code is null or error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint calendar_syncs_provider_format  check (provider_kind is null or provider_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint calendar_syncs_booking_fkey
    foreign key (tenant_id, company_id, booking_id) references ops.bookings (tenant_id, company_id, id) on delete restrict,
  constraint calendar_syncs_connection_fkey
    foreign key (tenant_id, company_id, connection_id)
    references ops.calendar_connections (tenant_id, company_id, id) on delete restrict,
  constraint calendar_syncs_job_fkey
    foreign key (tenant_id, job_id) references ops.jobs (tenant_id, id) on delete restrict,
  constraint calendar_syncs_booking_operation_key unique (booking_id, operation),
  constraint calendar_syncs_job_key               unique (tenant_id, job_id)
);

comment on table ops.calendar_syncs is
  'One external calendar action for one booking change, at most once: running is recorded before the call, an ambiguous outcome is indeterminate and never retried, and an event id is stored only on an unambiguous success. Never changes a booking.';

create index calendar_syncs_open_idx on ops.calendar_syncs (tenant_id, status)
  where status in ('pending', 'running', 'indeterminate', 'failed');

alter table ops.calendar_connections enable row level security;
alter table ops.calendar_connections force  row level security;
alter table ops.calendar_syncs       enable row level security;
alter table ops.calendar_syncs       force  row level security;

-- ---------------------------------------------------------------------------
-- 2. The sync lifecycle, enforced; and the request, derived from bookings.
-- ---------------------------------------------------------------------------

create function ops.calendar_sync_transitions()
returns table (from_status text, to_status text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('pending', 'running'),
    ('pending', 'skipped'),
    ('pending', 'failed'),
    ('running', 'synced'),
    ('running', 'failed'),
    ('running', 'indeterminate')
  ) as t (from_status, to_status);
$$;

create function ops.guard_calendar_sync_update()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'job_id', 'job_attempt', 'provider_kind', 'external_event_id',
                                    'error_code', 'started_at', 'settled_at'];
begin
  if (to_jsonb(new) - c_moving) is distinct from (to_jsonb(old) - c_moving) then
    raise exception using errcode = 'OS409', message = 'ops.calendar_syncs: a sync''s booking, connection and operation are fixed';
  end if;
  if old.status in ('synced', 'failed', 'indeterminate', 'skipped') then
    raise exception using errcode = 'OS409', message = format('ops.calendar_syncs: a %s sync is settled and never changes', old.status);
  end if;
  if new.status = old.status then
    -- Without a transition only a pending sync's job is named, once.
    if old.status <> 'pending' or old.job_id is not null or new.job_id is null
       or (to_jsonb(new) - 'job_id') is distinct from (to_jsonb(old) - 'job_id') then
      raise exception using errcode = 'OS409', message = 'ops.calendar_syncs: without a transition only the job is named, once';
    end if;
    return new;
  end if;
  if new.job_id is distinct from old.job_id then
    raise exception using errcode = 'OS409', message = 'ops.calendar_syncs: a transition never re-points the job';
  end if;
  if not exists (select 1 from ops.calendar_sync_transitions() t where t.from_status = old.status and t.to_status = new.status) then
    raise exception using errcode = 'OS409', message = format('ops.calendar_syncs: %s -> %s is not a sync transition', old.status, new.status);
  end if;
  -- A settled outcome never re-points what the start recorded.
  if old.status = 'running' and (new.job_attempt is distinct from old.job_attempt
                                 or new.provider_kind is distinct from old.provider_kind
                                 or (old.operation <> 'create' and new.external_event_id is distinct from old.external_event_id)) then
    raise exception using errcode = 'OS409', message = 'ops.calendar_syncs: a settlement keeps what the start recorded';
  end if;
  if new.status = 'running' then
    new.started_at := now();
  else
    new.settled_at := now();
  end if;
  return new;
end
$$;

create function ops.guard_calendar_sync_delete()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status in ('pending', 'running') then
    raise exception using errcode = 'OS409', message = 'ops.calendar_syncs: an open sync is settled, never deleted';
  end if;
  return old;
end
$$;

-- A booking change a connected company's calendar must mirror requests ONE
-- sync, with ONE job on the existing queue, in the same transaction: a new
-- booking is a create, a rescheduled successor an update of its chain's event,
-- a cancellation a cancel. A company with no active connection is local-only:
-- nothing is requested. Under an execution stop the request is still recorded
-- and its job held by the stop at the lease, never destroyed.
create function ops.request_calendar_sync()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_operation  text;
  v_connection ops.calendar_connections;
  v_sync       uuid;
  v_job        uuid;
  v_source     text := coalesce(nullif(current_setting('app.event_source', true), ''), 'operator-cli');
begin
  if tg_op = 'INSERT' then
    v_operation := case when new.rescheduled_from_id is null then 'create' else 'update' end;
  elsif old.status = 'booked' and new.status = 'cancelled' then
    v_operation := 'cancel';
  else
    return null;
  end if;
  select c.* into v_connection from ops.calendar_connections c
   where c.tenant_id = new.tenant_id and c.company_id = new.company_id and c.active;
  if not found then
    return null;
  end if;

  insert into ops.calendar_syncs (tenant_id, company_id, department_id, booking_id, connection_id, operation)
  values (new.tenant_id, new.company_id, new.department_id, new.id, v_connection.id, v_operation)
  returning id into v_sync;
  v_job := ops.enqueue_job(new.tenant_id, 'calendar.' || v_operation, jsonb_build_object('calendar_sync_id', v_sync),
                           100, now(), 5, 'calendar_sync:' || v_sync::text);
  update ops.calendar_syncs set job_id = v_job where id = v_sync;
  perform ops.record_event(new.tenant_id, new.company_id, 'calendar.sync_requested', v_source, null, null,
    jsonb_build_object('calendar_sync_id', v_sync, 'booking_id', new.id, 'operation', v_operation), new.id);
  return null;
end
$$;

drop trigger if exists calendar_syncs_guard_update on ops.calendar_syncs;
create trigger calendar_syncs_guard_update
  before update on ops.calendar_syncs
  for each row execute function ops.guard_calendar_sync_update();
alter table ops.calendar_syncs enable always trigger calendar_syncs_guard_update;

drop trigger if exists calendar_syncs_guard_delete on ops.calendar_syncs;
create trigger calendar_syncs_guard_delete
  before delete on ops.calendar_syncs
  for each row execute function ops.guard_calendar_sync_delete();
alter table ops.calendar_syncs enable always trigger calendar_syncs_guard_delete;

drop trigger if exists calendar_syncs_refuse_truncate on ops.calendar_syncs;
create trigger calendar_syncs_refuse_truncate
  before truncate on ops.calendar_syncs
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.calendar_syncs enable always trigger calendar_syncs_refuse_truncate;

drop trigger if exists bookings_request_calendar_sync on ops.bookings;
create trigger bookings_request_calendar_sync
  after insert or update of status on ops.bookings
  for each row execute function ops.request_calendar_sync();

-- ---------------------------------------------------------------------------
-- 3. The kinds, and the stop that covers one of their jobs.
-- ---------------------------------------------------------------------------

create or replace function ops.external_job_kinds()
returns text[]
language sql immutable set search_path = '' as $$
  select array['agent_run.execute', 'decision.shadow_evaluate',
               'calendar.create', 'calendar.update', 'calendar.cancel']::text[];
$$;

-- Phase 3A.2 adds the calendar jobs, held by the stops of the booking's unit
-- (its company and department; no agent is involved, so an agent stop in that
-- company covers them too: unknown fails closed). The rest is 20260928120000's.
create or replace function ops.job_covering_stop(p_tenant_id uuid, p_job_id uuid, p_job_kind text)
returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_company    uuid;
  v_department uuid;
  v_agent      uuid;
begin
  if p_job_kind = any (ops.internal_job_kinds()) then
    return null; -- administration stays up: the switch never holds maintenance
  end if;
  if p_job_kind = 'follow_up.due' then
    select p.company_id, p.department_id, p.agent_id into v_company, v_department, v_agent
      from ops.follow_ups f
      join ops.follow_up_plans p on p.tenant_id = f.tenant_id and p.company_id = f.company_id and p.id = f.plan_id
     where f.tenant_id = p_tenant_id and f.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  if p_job_kind in ('calendar.create', 'calendar.update', 'calendar.cancel') then
    select s.company_id, s.department_id into v_company, v_department
      from ops.calendar_syncs s
     where s.tenant_id = p_tenant_id and s.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, null);
  end if;
  select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.job_id = p_job_id;
  if not found then
    -- A shadow decision is held by the stops of the unit whose run it evaluates.
    select d.company_id, d.department_id, d.agent_id into v_company, v_department, v_agent
      from ops.decision_evaluations d
     where d.tenant_id = p_tenant_id and d.job_id = p_job_id;
  end if;
  if not found then
    select l.company_id into v_company
      from ops.task_jobs l
     where l.tenant_id = p_tenant_id and l.job_id = p_job_id;
  end if;
  return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The worker's two capabilities. SECURITY DEFINER, lease-bound: neither
--    takes a tenant, booking, sync or job argument.
-- ---------------------------------------------------------------------------

-- Settles a sync's start-time outcome that made no call, with its fact.
create function ops.settle_calendar_sync_without_call(p_sync ops.calendar_syncs, p_status text, p_error_code text)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_context jsonb := ops.push_event_context('agent-runtime', p_sync.booking_id, null);
begin
  update ops.calendar_syncs set status = p_status, error_code = p_error_code where id = p_sync.id;
  if p_status = 'skipped' then
    perform ops.record_event(p_sync.tenant_id, p_sync.company_id, 'calendar.sync_skipped', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', p_sync.id, 'operation', p_sync.operation, 'error_code', p_error_code),
      p_sync.booking_id);
  elsif p_status = 'failed' then
    perform ops.record_event(p_sync.tenant_id, p_sync.company_id, 'calendar.sync_failed', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', p_sync.id, 'operation', p_sync.operation, 'error_code', p_error_code),
      p_sync.booking_id);
  elsif p_status = 'indeterminate' then
    perform ops.record_event(p_sync.tenant_id, p_sync.company_id, 'calendar.sync_indeterminate', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', p_sync.id, 'operation', p_sync.operation, 'error_code', p_error_code),
      p_sync.booking_id);
  else
    raise exception using errcode = 'OS400', message = 'ops.settle_calendar_sync_without_call: not an outcome without a call';
  end if;
  perform ops.pop_event_context(v_context);
  return p_status;
end
$$;

-- Starts the sync bound to the leased job, for a worker whose calendar
-- provider is p_provider_kind ('none' when it has none). Answers:
--   {action: settled, status}  nothing to call (already settled; an earlier
--                              attempt's running settled indeterminate; not
--                              connected; this worker has no such provider;
--                              no confirmed event to change);
--   {action: stopped}          a covering stop: nothing recorded, the runtime
--                              defers the job;
--   {action: wait}             an earlier sync of the booking's chain is
--                              still unsettled: nothing recorded, retry later
--                              (on the job's last attempt: failed instead);
--   {action: start, ...}       running is recorded; call exactly once with
--                              exactly this minimised request.
create function ops.start_calendar_sync(p_provider_kind text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job        ops.jobs := ops.leased_job();
  v_sync       ops.calendar_syncs;
  v_connection ops.calendar_connections;
  v_head       ops.bookings;
  v_chain      uuid[];
  v_root       uuid;
  v_create     ops.calendar_syncs;
  v_event      text;
begin
  if v_job.kind not in ('calendar.create', 'calendar.update', 'calendar.cancel') then
    raise exception using errcode = '42501', message = 'ops.start_calendar_sync: the leased job is not a calendar job';
  end if;
  select s.* into v_sync from ops.calendar_syncs s
   where s.tenant_id = v_job.tenant_id and s.job_id = v_job.id
     for update;
  if not found or 'calendar.' || v_sync.operation <> v_job.kind then
    raise exception using errcode = '42501', message = 'ops.start_calendar_sync: no calendar sync of this kind is bound to the leased job';
  end if;

  if v_sync.status = 'running' then
    if v_sync.job_attempt is not distinct from v_job.attempts then
      raise exception using errcode = '42501', message = 'ops.start_calendar_sync: this attempt already started the sync; a call is never made twice';
    end if;
    -- An earlier attempt started the call and never settled it: it may have
    -- reached the provider. Never call again.
    update ops.calendar_syncs set status = 'indeterminate', error_code = 'execution_interrupted' where id = v_sync.id;
    perform ops.record_event(v_sync.tenant_id, v_sync.company_id, 'calendar.sync_indeterminate', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', v_sync.id, 'operation', v_sync.operation, 'error_code', 'execution_interrupted'),
      v_sync.booking_id);
    return jsonb_build_object('action', 'settled', 'status', 'indeterminate', 'calendarSyncId', v_sync.id);
  end if;
  if v_sync.status <> 'pending' then
    return jsonb_build_object('action', 'settled', 'status', v_sync.status, 'calendarSyncId', v_sync.id);
  end if;

  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind) is not null then
    return jsonb_build_object('action', 'stopped', 'calendarSyncId', v_sync.id);
  end if;

  select c.* into v_connection from ops.calendar_connections c
   where c.tenant_id = v_sync.tenant_id and c.company_id = v_sync.company_id and c.id = v_sync.connection_id;
  if not v_connection.active then
    return jsonb_build_object('action', 'settled', 'calendarSyncId', v_sync.id,
      'status', ops.settle_calendar_sync_without_call(v_sync, 'skipped', 'calendar_not_connected'));
  end if;
  if p_provider_kind is distinct from v_connection.provider_kind then
    return jsonb_build_object('action', 'settled', 'calendarSyncId', v_sync.id,
      'status', ops.settle_calendar_sync_without_call(v_sync, 'failed', 'provider_not_configured'));
  end if;

  -- The booking's chain: its root (walking back through reschedules) and every
  -- booking chained from it. A chain never forks, so it has one HEAD: the
  -- booking as it is now.
  with recursive back as (
    select b.id, b.rescheduled_from_id from ops.bookings b
     where b.tenant_id = v_sync.tenant_id and b.id = v_sync.booking_id
    union all
    select p.id, p.rescheduled_from_id from ops.bookings p
      join back c on p.id = c.rescheduled_from_id
     where p.tenant_id = v_sync.tenant_id
  )
  select c.id into v_root from back c where c.rescheduled_from_id is null;
  with recursive fwd as (
    select b.id from ops.bookings b where b.tenant_id = v_sync.tenant_id and b.id = v_root
    union all
    select s.id from ops.bookings s join fwd f on s.rescheduled_from_id = f.id
     where s.tenant_id = v_sync.tenant_id
  )
  select array_agg(f.id) into v_chain from fwd f;
  select b.* into v_head from ops.bookings b
   where b.tenant_id = v_sync.tenant_id and b.id = any (v_chain)
     and not exists (select 1 from ops.bookings s where s.tenant_id = b.tenant_id and s.rescheduled_from_id = b.id);

  -- A chain's syncs run in the order they were requested: this one waits
  -- (nothing recorded, the job retries) while an earlier one is unsettled, so
  -- two changes of one booking never reach the provider out of order. On its
  -- job's last attempt it stops waiting and fails, calling nothing: never left
  -- pending with no job to settle it, and shown to the owner as failed.
  if exists (select 1 from ops.calendar_syncs s
              where s.tenant_id = v_sync.tenant_id and s.booking_id = any (v_chain) and s.id <> v_sync.id
                and s.status in ('pending', 'running')
                and (s.requested_at, s.id) < (v_sync.requested_at, v_sync.id)) then
    if v_job.attempts >= v_job.max_attempts then
      return jsonb_build_object('action', 'settled', 'calendarSyncId', v_sync.id,
        'status', ops.settle_calendar_sync_without_call(v_sync, 'failed', 'earlier_sync_not_settled'));
    end if;
    return jsonb_build_object('action', 'wait', 'calendarSyncId', v_sync.id);
  end if;

  -- A create or an update carries the HEAD's current times, so the mirror
  -- converges on the booking as it is now, whatever happened while this sync
  -- waited; a head that is no longer booked is not mirrored (its cancel sync
  -- cancels the event, if there is one).
  if v_sync.operation <> 'cancel' and v_head.status <> 'booked' then
    return jsonb_build_object('action', 'settled', 'calendarSyncId', v_sync.id,
      'status', ops.settle_calendar_sync_without_call(v_sync, 'skipped', 'booking_not_booked'));
  end if;
  if v_sync.operation <> 'create' then
    -- The chain's event: the root booking's create, when it succeeded.
    select s.* into v_create from ops.calendar_syncs s
     where s.tenant_id = v_sync.tenant_id and s.booking_id = v_root and s.operation = 'create';
    if not found or v_create.status <> 'synced' then
      return jsonb_build_object('action', 'settled', 'calendarSyncId', v_sync.id,
        'status', ops.settle_calendar_sync_without_call(v_sync, 'skipped', 'no_confirmed_event'));
    end if;
    v_event := v_create.external_event_id;
  end if;

  update ops.calendar_syncs
     set status = 'running', job_attempt = v_job.attempts, provider_kind = p_provider_kind, external_event_id = v_event
   where id = v_sync.id;
  return jsonb_build_object(
    'action', 'start',
    'calendarSyncId', v_sync.id,
    'operation', v_sync.operation,
    'externalEventId', v_event,
    'request', case when v_sync.operation = 'cancel' then null
                    else jsonb_build_object(
                      'title', v_connection.event_title,
                      'startAt', ops.cos_ts(v_head.start_at),
                      'endAt', ops.cos_ts(v_head.end_at),
                      'timeZone', v_head.timezone,
                      'reference', v_sync.id) end);
end
$$;

comment on function ops.start_calendar_sync(text) is
  'Starts the calendar sync bound to the live lease''s job: records running before any call and returns the minimised request, or settles without a call, or answers stopped or wait recording nothing. An earlier attempt''s running is settled indeterminate, never called again. Takes no id.';

-- Stores the outcome of THIS attempt's call. `not_running` when the sync is not
-- this attempt's to settle. A create's event id is required on success and
-- refused otherwise.
create function ops.settle_calendar_sync(p_outcome text, p_external_event_id text, p_error_code text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job     ops.jobs := ops.leased_job();
  v_sync    ops.calendar_syncs;
  v_context jsonb;
begin
  if p_outcome is null or p_outcome not in ('synced', 'failed', 'indeterminate') then
    raise exception using errcode = 'OS400', message = 'ops.settle_calendar_sync: an outcome is synced, failed or indeterminate';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception using errcode = 'OS400', message = 'ops.settle_calendar_sync: an error code is a snake_case code';
  end if;
  select s.* into v_sync from ops.calendar_syncs s
   where s.tenant_id = v_job.tenant_id and s.job_id = v_job.id
     for update;
  if not found or v_sync.status <> 'running' or v_sync.job_attempt is distinct from v_job.attempts then
    return 'not_running';
  end if;
  if v_sync.operation = 'create' and (p_outcome = 'synced') <> (p_external_event_id is not null) then
    raise exception using errcode = 'OS400', message = 'ops.settle_calendar_sync: a created event''s id is stored exactly when it succeeded';
  end if;
  if v_sync.operation <> 'create' and p_external_event_id is not null then
    raise exception using errcode = 'OS400', message = 'ops.settle_calendar_sync: an update or cancel keeps the event it changed';
  end if;

  v_context := ops.push_event_context('agent-runtime', v_sync.booking_id, null);
  update ops.calendar_syncs
     set status = p_outcome,
         external_event_id = case when v_sync.operation = 'create' then p_external_event_id else external_event_id end,
         error_code = case when p_outcome = 'synced' then null else coalesce(p_error_code, 'provider_error') end
   where id = v_sync.id;
  if p_outcome = 'synced' then
    perform ops.record_event(v_sync.tenant_id, v_sync.company_id, 'calendar.sync_completed', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', v_sync.id, 'operation', v_sync.operation), v_sync.booking_id);
  elsif p_outcome = 'failed' then
    perform ops.record_event(v_sync.tenant_id, v_sync.company_id, 'calendar.sync_failed', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', v_sync.id, 'operation', v_sync.operation,
                         'error_code', coalesce(p_error_code, 'provider_error')), v_sync.booking_id);
  else
    perform ops.record_event(v_sync.tenant_id, v_sync.company_id, 'calendar.sync_indeterminate', 'agent-runtime', null, null,
      jsonb_build_object('calendar_sync_id', v_sync.id, 'operation', v_sync.operation,
                         'error_code', coalesce(p_error_code, 'provider_error')), v_sync.booking_id);
  end if;
  perform ops.pop_event_context(v_context);
  return p_outcome;
end
$$;

comment on function ops.settle_calendar_sync(text, text, text) is
  'Stores this attempt''s calendar call outcome for the sync bound to the live lease''s job, once: synced, failed or indeterminate. Answers not_running otherwise. Takes no id.';

-- The owner's configuration act: which provider mirrors a company's bookings,
-- under what generic title. Only `fake` exists (the provider gate above).
create function ops.configure_calendar_connection(
  p_tenant_id     uuid,
  p_company_id    uuid,
  p_provider_kind text,
  p_event_title   text,
  p_active        boolean,
  p_actor         text
)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.configure_calendar_connection');
  if p_event_title is null then
    raise exception using errcode = 'OS400', message = 'ops.configure_calendar_connection: a connection names the generic title its events carry';
  end if;
  insert into ops.calendar_connections (tenant_id, company_id, provider_kind, event_title, active, configured_by)
  values (p_tenant_id, p_company_id, p_provider_kind, p_event_title, coalesce(p_active, true), p_actor)
  on conflict (tenant_id, company_id) do update
     set provider_kind = excluded.provider_kind, event_title = excluded.event_title, active = excluded.active,
         configured_by = excluded.configured_by, configured_at = now()
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The activity feed learns the calendar facts, deny by default: the
--    operation and, when one ended without success, its error code. The body
--    is 20260928130000's with the five types added.
-- ---------------------------------------------------------------------------

create or replace function ops.cos_event_known(p_type pg_catalog.text) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select p_type in (
    'company.created', 'company.status_changed', 'department.created', 'department.status_changed',
    'agent.created', 'agent.status_changed',
    'task.created', 'task.assigned', 'task.status_changed', 'task.completed', 'task.failed', 'task.cancelled',
    'task.execution_requested',
    'agent_run.requested', 'agent_run.started', 'agent_run.succeeded', 'agent_run.failed',
    'agent_run.indeterminate', 'agent_run.cancelled',
    'lead_triage.admitted', 'lead_triage.review_pending', 'lead_triage.reviewed',
    'communication.received', 'communication.inbound_refused', 'communication.inbound_held',
    'communication.channel_configured', 'communication.outbound_authorized', 'communication.outbound_attempted',
    'communication.outbound_blocked', 'communication.outbound_sent', 'communication.outbound_failed',
    'communication.outbound_indeterminate', 'communication.delivery_updated',
    'follow_up.scheduled', 'follow_up.due', 'follow_up.completed', 'follow_up.cancelled', 'follow_up.superseded',
    'booking.created', 'booking.rescheduled', 'booking.cancelled',
    'calendar.sync_requested', 'calendar.sync_completed', 'calendar.sync_failed', 'calendar.sync_indeterminate',
    'calendar.sync_skipped');
$$;

create or replace function ops.cos_event_facts(p_tenant pg_catalog.uuid, p_type pg_catalog.text, p_payload pg_catalog.jsonb)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select case
    when p_type = 'lead_triage.reviewed' then
      pg_catalog.jsonb_build_object('decision', case when p_payload ->> 'decision' in ('accepted', 'rejected', 'needs_edit')
                                                      then p_payload ->> 'decision' end)
    when p_type in ('company.status_changed', 'department.status_changed', 'agent.status_changed',
                    'task.status_changed', 'task.completed', 'task.failed', 'task.cancelled', 'task.assigned',
                    'agent_run.started', 'agent_run.succeeded', 'agent_run.failed',
                    'agent_run.indeterminate', 'agent_run.cancelled') then
      pg_catalog.jsonb_build_object(
        'from_status', case when p_payload ->> 'from_status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'from_status' end,
        'to_status', case when p_payload ->> 'to_status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'to_status' end)
    when p_type in ('communication.inbound_refused', 'communication.inbound_held') then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid),
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    when p_type = 'communication.channel_configured' then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid),
        'mode', case when p_payload ->> 'mode' in ('test', 'production') then p_payload ->> 'mode' end,
        'active', case when pg_catalog.jsonb_typeof(p_payload -> 'active') = 'boolean' then p_payload -> 'active' end)
    when p_type = 'communication.outbound_authorized' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'review_item_id', ops.cos_ref_id(p_tenant, 'review_item', nullif(p_payload ->> 'review_item_id', '')::pg_catalog.uuid))
    when p_type = 'communication.outbound_blocked' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    when p_type in ('communication.outbound_attempted', 'communication.outbound_sent', 'communication.outbound_failed',
                    'communication.outbound_indeterminate') then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid))
    when p_type = 'communication.delivery_updated' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'status', case when p_payload ->> 'status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'status' end,
        'previous', case when p_payload ->> 'previous' ~ '^[a-z_]{1,32}$' then p_payload ->> 'previous' end)
    when p_type in ('follow_up.scheduled', 'follow_up.due', 'follow_up.completed', 'follow_up.cancelled',
                    'follow_up.superseded') then
      pg_catalog.jsonb_build_object(
        'step', case when pg_catalog.jsonb_typeof(p_payload -> 'step') = 'number'
                          and (p_payload ->> 'step') ~ '^[0-9]{1,2}$' then p_payload -> 'step' end,
        'reason', case when p_type = 'follow_up.cancelled' and p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$'
                       then p_payload ->> 'reason' end)
    when p_type = 'booking.cancelled' then
      pg_catalog.jsonb_build_object(
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    -- Phase 3A.2: which calendar operation, and why it ended without success.
    when p_type in ('calendar.sync_requested', 'calendar.sync_completed', 'calendar.sync_failed',
                    'calendar.sync_indeterminate', 'calendar.sync_skipped') then
      pg_catalog.jsonb_build_object(
        'operation', case when p_payload ->> 'operation' in ('create', 'update', 'cancel') then p_payload ->> 'operation' end,
        'error_code', case when p_type in ('calendar.sync_failed', 'calendar.sync_indeterminate', 'calendar.sync_skipped')
                                and p_payload ->> 'error_code' ~ '^[a-z][a-z0-9_]{0,63}$'
                           then p_payload ->> 'error_code' end)
    else '{}'::pg_catalog.jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Access. Backend only; the worker reaches the syncs only through its two
--    capabilities.
-- ---------------------------------------------------------------------------

revoke all on table ops.calendar_connections, ops.calendar_syncs
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.calendar_sync_transitions(),
  ops.guard_calendar_sync_update(),
  ops.guard_calendar_sync_delete(),
  ops.request_calendar_sync(),
  ops.external_job_kinds(),
  ops.job_covering_stop(uuid, uuid, text),
  ops.settle_calendar_sync_without_call(ops.calendar_syncs, text, text),
  ops.start_calendar_sync(text),
  ops.settle_calendar_sync(text, text, text),
  ops.configure_calendar_connection(uuid, uuid, text, text, boolean, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

grant execute on function
  ops.start_calendar_sync(text),
  ops.settle_calendar_sync(text, text, text)
  to ops_worker;

-- ---------------------------------------------------------------------------
-- 7. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_tables constant pg_catalog.text[] := array['calendar_connections', 'calendar_syncs'];
  c_fns constant pg_catalog.text[] := array[
    'calendar_sync_transitions', 'guard_calendar_sync_update', 'guard_calendar_sync_delete', 'request_calendar_sync',
    'settle_calendar_sync_without_call', 'start_calendar_sync', 'settle_calendar_sync', 'configure_calendar_connection'];
begin
  select pg_catalog.string_agg(c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'calendar table(s) lack ENABLE + FORCE row level security: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || t.relname, ', ') into v_bad
    from pg_catalog.unnest(c_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.' || t.relname, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a calendar table: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker' and p.proname in ('start_calendar_sync', 'settle_calendar_sync'));
  if v_bad is not null then
    raise exception 'a role can execute a calendar function it must not: %', v_bad;
  end if;

  -- No credential or token column exists anywhere in the calendar tables.
  select pg_catalog.string_agg(a.attrelid::pg_catalog.regclass || '.' || a.attname, ', ') into v_bad
    from pg_catalog.pg_attribute a
   where a.attrelid in ('ops.calendar_connections'::pg_catalog.regclass, 'ops.calendar_syncs'::pg_catalog.regclass)
     and a.attnum > 0 and not a.attisdropped
     and a.attname ~* '(token|secret|password|credential|oauth|refresh|api_key|client_id)';
  if v_bad is not null then
    raise exception 'a calendar table holds a credential-shaped column: %', v_bad;
  end if;

  if ops.external_job_kinds() is distinct from
       array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update',
             'calendar.cancel']::pg_catalog.text[]
     or ops.external_job_kinds() && ops.governed_job_kinds()
     or ops.external_job_kinds() && ops.internal_job_kinds()
     or array['calendar.create', 'calendar.update', 'calendar.cancel']::pg_catalog.text[] && ops.task_executable_kinds() then
    raise exception 'the calendar kinds are not exactly three external, non-task kinds';
  end if;

  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
       where t.tgrelid = 'ops.calendar_syncs'::pg_catalog.regclass and not t.tgisinternal and t.tgenabled = 'A') <> 3 then
    raise exception 'the calendar sync guards are not all ENABLE ALWAYS';
  end if;

  -- A CALENDAR SYNC NEVER ACTS ON THE COMPANY OS: no calendar function names a
  -- send, an outbound row, a model or decision call, a review decision, the
  -- CRM, a stop act, a budget, a price, a channel or a membership, writes a
  -- booking, or runs dynamic SQL.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp|send_|agent_run|shadow_decision|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels|grant_membership|revoke_membership|update\s+ops\.bookings|insert\s+into\s+ops\.bookings|execute\s)';
  if v_bad is not null then
    raise exception 'a calendar function reaches beyond mirroring: %', v_bad;
  end if;
end
$end_state$;
