-- Phase 3A.2: the scheduling and booking foundation.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_3A_REPORT.md):
--
--   1. Generic scheduling configuration, all tenant data: a tenant's
--      scheduling time zone (ops.scheduling_settings), resources a booking
--      reserves (ops.booking_resources: a professional, a room, a machine; the
--      kind and label are the tenant's words), booking types
--      (ops.booking_types: a duration, buffers before and after, and the step
--      between offered start times) and weekly availability rules
--      (ops.availability_rules: a weekday, a local start and end time, an IANA
--      time zone, and the dates the rule is in effect).
--   2. ops.bookings. An authoritative instant is a timestamptz; a local clock
--      time exists only inside a rule, always with its zone. A booking
--      snapshots its type's duration and buffers, so a later configuration
--      change never moves an existing booking.
--   3. CONFLICT PREVENTION AT THE AUTHORITY BOUNDARY: a GiST exclusion
--      constraint. No two BOOKED bookings of one resource may overlap, each
--      occupying its time plus its buffers. It is core PostgreSQL only (no
--      extension): every resource has an internal, never-exposed slot_key,
--      and the constraint compares int8range(slot_key, slot_key) with && as
--      the equality on the resource. PostgreSQL enforces it under every
--      isolation level and for every writer, so two racing bookings of one
--      resource cannot both commit: the second waits for the first and fails.
--      Cancelled and rescheduled bookings leave the constraint and so free
--      their time.
--   4. Deterministic availability: ops.available_slots computes offered start
--      times from the rules, the type's duration, step and buffers, and the
--      booked bookings, over an explicit range of at most 31 days and at most
--      500 slots. No model is involved in any of it.
--   5. Owner services (executable by no application role): configure, create
--      a booking once per tenant-scoped idempotency key, reschedule ATOMICALLY
--      (the old booking and its successor change in one statement, so a failed
--      new slot leaves the old booking booked), and cancel idempotently. A
--      booking is never deleted while booked; history keeps every change.
--
-- WHAT IT DELIBERATELY DOES NOT DO. No calendar is called here (the calendar
-- sync is a separate, adapter-side record: 20260928140000). No name, phone,
-- email, note or message is stored: a booking names a task, a conversation or
-- an opaque reference. No company_os_api function is added, so the browser
-- still has exactly its two acts and cannot book, reschedule or cancel.

-- ---------------------------------------------------------------------------
-- 0. Engine vocabulary: the same for every tenant.
-- ---------------------------------------------------------------------------

create function ops.booking_status_transitions()
returns table (from_status text, to_status text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('booked', 'cancelled'),
    ('booked', 'rescheduled')
  ) as t (from_status, to_status);
$$;

-- An IANA zone name this database knows. The CHECKs below only bound the
-- shape; the guards and services ask this.
create function ops.is_time_zone(p_zone text)
returns boolean
language sql stable set search_path = '' as $$
  select p_zone is not null
     and p_zone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'
     and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone);
$$;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

create table ops.scheduling_settings (
  tenant_id  uuid primary key references ops.tenants (id) on delete restrict,
  timezone   text not null,
  set_by     text not null,
  set_at     timestamptz not null default now(),
  constraint scheduling_settings_timezone_format check (timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  constraint scheduling_settings_actor_length    check (char_length(btrim(set_by)) between 1 and 200)
);

comment on table ops.scheduling_settings is
  'A tenant''s scheduling time zone: which local day "today" is in its agenda. Configuration, never an authoritative instant.';

create table ops.booking_resources (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references ops.tenants (id) on delete restrict,
  company_id    uuid not null,
  department_id uuid not null,
  -- Internal only (SI-26): the exclusion constraint's handle on the resource.
  -- Never returned by any projection.
  slot_key      bigint generated always as identity,
  key           text not null,
  label         text not null,
  kind          text not null,
  active        boolean not null default true,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  constraint booking_resources_key_format    check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(key) <= 63),
  constraint booking_resources_label_length  check (char_length(btrim(label)) between 1 and 200),
  constraint booking_resources_kind_format   check (kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint booking_resources_actor_length  check (char_length(btrim(created_by)) between 1 and 200),
  constraint booking_resources_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint booking_resources_department_fkey
    foreign key (tenant_id, company_id, department_id)
    references ops.departments (tenant_id, company_id, id) on delete restrict,
  constraint booking_resources_tenant_key    unique (tenant_id, key),
  constraint booking_resources_slot_key_key  unique (slot_key),
  constraint booking_resources_scope_id_key  unique (tenant_id, company_id, id),
  constraint booking_resources_booking_key   unique (tenant_id, company_id, department_id, id, slot_key)
);

comment on table ops.booking_resources is
  'What a booking reserves: a professional, a room, a machine. Kind and label are tenant vocabulary (data).';

create table ops.booking_types (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  company_id            uuid not null,
  key                   text not null,
  label                 text not null,
  duration_minutes      integer not null,
  buffer_before_minutes integer not null default 0,
  buffer_after_minutes  integer not null default 0,
  slot_step_minutes     integer not null,
  active                boolean not null default true,
  created_by            text not null,
  created_at            timestamptz not null default now(),
  constraint booking_types_key_format     check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(key) <= 63),
  constraint booking_types_label_length   check (char_length(btrim(label)) between 1 and 200),
  constraint booking_types_duration_range check (duration_minutes between 5 and 720),
  constraint booking_types_buffers_range  check (buffer_before_minutes between 0 and 240
                                                 and buffer_after_minutes between 0 and 240),
  constraint booking_types_step_range     check (slot_step_minutes between 5 and 720),
  constraint booking_types_actor_length   check (char_length(btrim(created_by)) between 1 and 200),
  constraint booking_types_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint booking_types_tenant_key     unique (tenant_id, key),
  constraint booking_types_scope_id_key   unique (tenant_id, company_id, id)
);

comment on table ops.booking_types is
  'A kind of booking: its duration, buffers and offered-start step. The label is tenant vocabulary; a new duration is a new type.';

create table ops.availability_rules (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references ops.tenants (id) on delete restrict,
  company_id      uuid not null,
  resource_id     uuid not null,
  weekday         smallint not null,
  local_start     time not null,
  local_end       time not null,
  timezone        text not null,
  effective_from  date not null,
  effective_until date,
  active          boolean not null default true,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  -- ISO weekday: 1 Monday .. 7 Sunday. A window never crosses midnight.
  constraint availability_rules_weekday_range check (weekday between 1 and 7),
  constraint availability_rules_window_order  check (local_end > local_start),
  constraint availability_rules_whole_minutes check (extract(second from local_start) = 0
                                                     and extract(second from local_end) = 0),
  constraint availability_rules_dates_order   check (effective_until is null or effective_until >= effective_from),
  constraint availability_rules_timezone_format check (timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  constraint availability_rules_actor_length  check (char_length(btrim(created_by)) between 1 and 200),
  constraint availability_rules_resource_fkey
    foreign key (tenant_id, company_id, resource_id)
    references ops.booking_resources (tenant_id, company_id, id) on delete restrict
);

comment on table ops.availability_rules is
  'A weekly window a resource can be booked in: local times in an IANA zone, in effect between two dates. Only a rule carries a local clock time, always with its zone.';

create index availability_rules_resource_idx on ops.availability_rules (tenant_id, resource_id, weekday) where active;

create table ops.bookings (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  company_id            uuid not null,
  department_id         uuid not null,
  resource_id           uuid not null,
  resource_slot_key     bigint not null,
  booking_type_id       uuid not null,
  start_at              timestamptz not null,
  end_at                timestamptz not null,
  buffer_before_minutes integer not null,
  buffer_after_minutes  integer not null,
  -- The time the booking holds its resource: its span plus both buffers,
  -- half-open, so a booking ending when the next one's buffer starts is not a
  -- conflict. Derived by the insert guard, never by a caller.
  occupied              tstzrange not null,
  -- The zone of the rule the booking was made in: how its local time is shown.
  timezone              text not null,
  status                text not null default 'booked',
  task_id               uuid,
  conversation_id       uuid,
  subject_ref           text,
  source                text not null,
  idempotency_key       text not null,
  request_fingerprint   text not null,
  rescheduled_from_id   uuid,
  created_by            text not null,
  created_at            timestamptz not null default now(),
  cancelled_at          timestamptz,
  cancelled_by          text,
  cancel_reason         text,
  rescheduled_at        timestamptz,
  rescheduled_by        text,
  constraint bookings_status_check          check (status in ('booked', 'cancelled', 'rescheduled')),
  constraint bookings_span_order            check (end_at > start_at),
  constraint bookings_occupied_bounds       check (lower(occupied) <= start_at and upper(occupied) >= end_at
                                                   and lower_inc(occupied) and not upper_inc(occupied)),
  constraint bookings_subject_present       check (num_nonnulls(task_id, conversation_id, subject_ref) >= 1),
  constraint bookings_subject_ref_format    check (subject_ref is null
                                                   or subject_ref ~ '^[a-z][a-z0-9_]{0,31}:[A-Za-z0-9._-]{1,64}$'),
  constraint bookings_timezone_format       check (timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  constraint bookings_source_format         check (source ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  constraint bookings_idempotency_format    check (idempotency_key ~ '^[\x21-\x7e]{1,200}$'),
  constraint bookings_fingerprint_format    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint bookings_actor_length          check (char_length(btrim(created_by)) between 1 and 200),
  constraint bookings_cancelled_iff         check ((status = 'cancelled')
                                                   = (cancelled_at is not null and cancelled_by is not null
                                                      and cancel_reason is not null)),
  constraint bookings_cancelled_fields      check (num_nonnulls(cancelled_at, cancelled_by, cancel_reason) in (0, 3)),
  constraint bookings_cancel_reason_format  check (cancel_reason is null or cancel_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint bookings_rescheduled_iff       check ((status = 'rescheduled')
                                                   = (rescheduled_at is not null and rescheduled_by is not null)),
  constraint bookings_rescheduled_fields    check (num_nonnulls(rescheduled_at, rescheduled_by) in (0, 2)),
  constraint bookings_not_own_predecessor   check (rescheduled_from_id is distinct from id),
  constraint bookings_resource_fkey
    foreign key (tenant_id, company_id, department_id, resource_id, resource_slot_key)
    references ops.booking_resources (tenant_id, company_id, department_id, id, slot_key) on delete restrict,
  constraint bookings_type_fkey
    foreign key (tenant_id, company_id, booking_type_id)
    references ops.booking_types (tenant_id, company_id, id) on delete restrict,
  constraint bookings_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint bookings_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id)
    references ops.conversations (tenant_id, company_id, id) on delete restrict,
  constraint bookings_idempotency_key       unique (tenant_id, idempotency_key),
  constraint bookings_scope_id_key          unique (tenant_id, company_id, id),
  -- One successor at most: a reschedule is a chain, never a fork.
  constraint bookings_successor_key         unique (rescheduled_from_id),
  constraint bookings_predecessor_fkey
    foreign key (tenant_id, company_id, rescheduled_from_id)
    references ops.bookings (tenant_id, company_id, id) on delete restrict,
  -- THE conflict rule. Booked bookings of one resource never overlap.
  constraint bookings_no_overlap
    exclude using gist ((int8range(resource_slot_key, resource_slot_key, '[]')) with &&, occupied with &&)
    where (status = 'booked')
);

comment on table ops.bookings is
  'One reservation of one resource, as authoritative instants. No two booked bookings of a resource overlap (an exclusion constraint). A reschedule closes a booking and chains a successor; nothing booked is ever deleted.';

create index bookings_agenda_idx on ops.bookings (tenant_id, start_at);

alter table ops.scheduling_settings enable row level security;
alter table ops.scheduling_settings force  row level security;
alter table ops.booking_resources   enable row level security;
alter table ops.booking_resources   force  row level security;
alter table ops.booking_types       enable row level security;
alter table ops.booking_types       force  row level security;
alter table ops.availability_rules  enable row level security;
alter table ops.availability_rules  force  row level security;
alter table ops.bookings            enable row level security;
alter table ops.bookings            force  row level security;

-- ---------------------------------------------------------------------------
-- 2. Guards. Update, delete and truncate guards are ENABLE ALWAYS.
-- ---------------------------------------------------------------------------

-- Configuration keeps its meaning: a zone must be one the database knows, and
-- only a resource's or a type's label and active flag, or a rule's active
-- flag and end date, change after creation.
create function ops.guard_scheduling_settings_write()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not ops.is_time_zone(new.timezone) then
    raise exception using errcode = 'OS400', message = format('ops.scheduling_settings: %L is not a time zone this database knows', new.timezone);
  end if;
  new.set_at := now();
  return new;
end
$$;

create function ops.guard_scheduling_configuration_update()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_moving text[];
begin
  v_moving := case tg_table_name
    when 'booking_resources' then array['label', 'active']
    when 'booking_types' then array['label', 'active']
    when 'availability_rules' then array['active', 'effective_until']
  end;
  if v_moving is null
     or (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception using errcode = 'OS409', message = format('ops.%s: only %s change after creation', tg_table_name,
                                                              array_to_string(coalesce(v_moving, '{}'), ' and '));
  end if;
  return new;
end
$$;

create function ops.guard_availability_rule_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if not ops.is_time_zone(new.timezone) then
    raise exception using errcode = 'OS400', message = format('ops.availability_rules: %L is not a time zone this database knows', new.timezone);
  end if;
  new.created_at := now();
  return new;
end
$$;

-- A booking is born booked. Its unit, its resource's slot key, its end, its
-- buffers and the time it occupies are DERIVED here from the resource and the
-- type, never taken from the caller, and its zone must be one the database
-- knows.
create function ops.guard_booking_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_resource ops.booking_resources;
  v_type     ops.booking_types;
begin
  select r.* into v_resource from ops.booking_resources r
   where r.tenant_id = new.tenant_id and r.id = new.resource_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.bookings: resource not found in this tenant';
  end if;
  select t.* into v_type from ops.booking_types t
   where t.tenant_id = new.tenant_id and t.company_id = v_resource.company_id and t.id = new.booking_type_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.bookings: booking type not found in the resource''s company';
  end if;
  if new.status <> 'booked'
     or num_nonnulls(new.cancelled_at, new.cancelled_by, new.cancel_reason, new.rescheduled_at, new.rescheduled_by) > 0 then
    raise exception using errcode = 'OS400', message = 'ops.bookings: a booking is created booked';
  end if;
  if not ops.is_time_zone(new.timezone) then
    raise exception using errcode = 'OS400', message = 'ops.bookings: the booking''s zone is not one this database knows';
  end if;
  new.company_id := v_resource.company_id;
  new.department_id := v_resource.department_id;
  new.resource_slot_key := v_resource.slot_key;
  new.end_at := new.start_at + make_interval(mins => v_type.duration_minutes);
  new.buffer_before_minutes := v_type.buffer_before_minutes;
  new.buffer_after_minutes := v_type.buffer_after_minutes;
  new.occupied := tstzrange(new.start_at - make_interval(mins => v_type.buffer_before_minutes),
                            new.end_at + make_interval(mins => v_type.buffer_after_minutes), '[)');
  new.created_at := now();
  return new;
end
$$;

-- The booking state machine: booked -> cancelled or rescheduled, stamped with
-- the database's time. Nothing else changes, and a closed booking never does.
create function ops.guard_booking_update()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'cancelled_at', 'cancelled_by', 'cancel_reason',
                                    'rescheduled_at', 'rescheduled_by'];
begin
  if (to_jsonb(new) - c_moving) is distinct from (to_jsonb(old) - c_moving) then
    raise exception using errcode = 'OS409', message = 'ops.bookings: a booking''s resource, type, time and subject are fixed; a new time is a reschedule';
  end if;
  if old.status <> 'booked' then
    raise exception using errcode = 'OS409', message = format('ops.bookings: a %s booking is closed and never changes', old.status);
  end if;
  if not exists (select 1 from ops.booking_status_transitions() t
                  where t.from_status = old.status and t.to_status = new.status) then
    raise exception using errcode = 'OS409', message = format('ops.bookings: %s -> %s is not a booking transition', old.status, new.status);
  end if;
  new.cancelled_at := case when new.status = 'cancelled' then now() end;
  new.rescheduled_at := case when new.status = 'rescheduled' then now() end;
  return new;
end
$$;

-- Open work is never deleted: a booked booking is cancelled, never removed. A
-- closed booking is history, which only the owner may delete (retention).
create function ops.guard_booking_delete()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status = 'booked' then
    raise exception using errcode = 'OS409', message = 'ops.bookings: a booked booking is cancelled, never deleted';
  end if;
  return old;
end
$$;

drop trigger if exists scheduling_settings_guard_write on ops.scheduling_settings;
create trigger scheduling_settings_guard_write
  before insert or update on ops.scheduling_settings
  for each row execute function ops.guard_scheduling_settings_write();
alter table ops.scheduling_settings enable always trigger scheduling_settings_guard_write;

drop trigger if exists booking_resources_guard_update on ops.booking_resources;
create trigger booking_resources_guard_update
  before update on ops.booking_resources
  for each row execute function ops.guard_scheduling_configuration_update();
alter table ops.booking_resources enable always trigger booking_resources_guard_update;

drop trigger if exists booking_types_guard_update on ops.booking_types;
create trigger booking_types_guard_update
  before update on ops.booking_types
  for each row execute function ops.guard_scheduling_configuration_update();
alter table ops.booking_types enable always trigger booking_types_guard_update;

drop trigger if exists availability_rules_guard_insert on ops.availability_rules;
create trigger availability_rules_guard_insert
  before insert on ops.availability_rules
  for each row execute function ops.guard_availability_rule_insert();

drop trigger if exists availability_rules_guard_update on ops.availability_rules;
create trigger availability_rules_guard_update
  before update on ops.availability_rules
  for each row execute function ops.guard_scheduling_configuration_update();
alter table ops.availability_rules enable always trigger availability_rules_guard_update;

drop trigger if exists bookings_guard_insert on ops.bookings;
create trigger bookings_guard_insert
  before insert on ops.bookings
  for each row execute function ops.guard_booking_insert();

drop trigger if exists bookings_guard_update on ops.bookings;
create trigger bookings_guard_update
  before update on ops.bookings
  for each row execute function ops.guard_booking_update();
alter table ops.bookings enable always trigger bookings_guard_update;

drop trigger if exists bookings_guard_delete on ops.bookings;
create trigger bookings_guard_delete
  before delete on ops.bookings
  for each row execute function ops.guard_booking_delete();
alter table ops.bookings enable always trigger bookings_guard_delete;

drop trigger if exists bookings_refuse_truncate on ops.bookings;
create trigger bookings_refuse_truncate
  before truncate on ops.bookings
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.bookings enable always trigger bookings_refuse_truncate;

drop trigger if exists availability_rules_refuse_truncate on ops.availability_rules;
create trigger availability_rules_refuse_truncate
  before truncate on ops.availability_rules
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.availability_rules enable always trigger availability_rules_refuse_truncate;

-- ---------------------------------------------------------------------------
-- 3. Deterministic availability. STABLE and SECURITY INVOKER: owner-side and
--    read-model helpers, executable by no application role.
-- ---------------------------------------------------------------------------

-- The zone of an active rule whose window, on the booking's own local date in
-- that zone, contains [start, end); NULL when none does.
create function ops.booking_window_zone(p_tenant_id uuid, p_resource_id uuid, p_start timestamptz, p_end timestamptz)
returns text
language sql stable set search_path = '' as $$
  select r.timezone
    from ops.availability_rules r
   where r.tenant_id = p_tenant_id and r.resource_id = p_resource_id and r.active
     and r.weekday = extract(isodow from (p_start at time zone r.timezone))::integer
     and (p_start at time zone r.timezone)::date >= r.effective_from
     and (r.effective_until is null or (p_start at time zone r.timezone)::date <= r.effective_until)
     and (((p_start at time zone r.timezone)::date + r.local_start) at time zone r.timezone) <= p_start
     and (((p_start at time zone r.timezone)::date + r.local_end) at time zone r.timezone) >= p_end
   order by r.created_at, r.id
   limit 1;
$$;

-- The offered start times of one booking type on one resource in [from,
-- until), never in the past: every step of every active rule window, in the
-- rule's zone, whose appointment fits in the window and whose occupied time
-- (with the type's buffers) overlaps no booked booking. Dates are walked as
-- whole days from the range's UTC dates, one day either side, so no session
-- time zone or daylight-saving arithmetic enters it; each local window is
-- anchored in its own zone. Bounded: at most 31 days and 500 slots.
create function ops.available_slots(
  p_tenant_id       uuid,
  p_resource_id     uuid,
  p_booking_type_id uuid,
  p_from            timestamptz,
  p_until           timestamptz,
  p_limit           integer default 100
)
returns table (start_at timestamptz, end_at timestamptz)
language plpgsql stable set search_path = '' as $$
declare
  v_resource ops.booking_resources;
  v_type     ops.booking_types;
  v_from     timestamptz;
  v_days     integer;
begin
  if p_from is null or p_until is null or p_until <= p_from or p_until - p_from > interval '31 days' then
    raise exception using errcode = 'OS400', message = 'ops.available_slots: a range is non-empty and at most 31 days';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception using errcode = 'OS400', message = 'ops.available_slots: a limit is 1 to 500 slots';
  end if;
  select r.* into v_resource from ops.booking_resources r where r.tenant_id = p_tenant_id and r.id = p_resource_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.available_slots: resource not found in this tenant';
  end if;
  select t.* into v_type from ops.booking_types t
   where t.tenant_id = p_tenant_id and t.company_id = v_resource.company_id and t.id = p_booking_type_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.available_slots: booking type not found in the resource''s company';
  end if;
  if not v_resource.active or not v_type.active then
    return;
  end if;
  v_from := greatest(p_from, now());
  if v_from >= p_until then
    return;
  end if;
  v_days := ((p_until at time zone 'UTC')::date - (v_from at time zone 'UTC')::date) + 2;

  return query
  with days as (
    select (v_from at time zone 'UTC')::date + i as day from generate_series(-1, v_days) as i
  ),
  windows as (
    select ((d.day + r.local_start) at time zone r.timezone) as w_start,
           ((d.day + r.local_end) at time zone r.timezone) as w_end
      from days d
      join ops.availability_rules r
        on r.tenant_id = p_tenant_id and r.resource_id = p_resource_id and r.active
       and r.weekday = extract(isodow from d.day)::integer
       and d.day >= r.effective_from and (r.effective_until is null or d.day <= r.effective_until)
  ),
  candidates as (
    select distinct w.w_start + make_interval(mins => k * v_type.slot_step_minutes) as s
      from windows w
     cross join lateral generate_series(
       0, floor(extract(epoch from (w.w_end - w.w_start)) / 60 / v_type.slot_step_minutes)::integer) as k
     where w.w_start + make_interval(mins => k * v_type.slot_step_minutes + v_type.duration_minutes) <= w.w_end
  )
  select c.s, c.s + make_interval(mins => v_type.duration_minutes)
    from candidates c
   where c.s >= v_from and c.s < p_until
     and not exists (
       select 1 from ops.bookings b
        where b.tenant_id = p_tenant_id and b.resource_id = p_resource_id and b.status = 'booked'
          and b.occupied && tstzrange(c.s - make_interval(mins => v_type.buffer_before_minutes),
                                      c.s + make_interval(mins => v_type.duration_minutes + v_type.buffer_after_minutes),
                                      '[)'))
   order by c.s
   limit p_limit;
end
$$;

comment on function ops.available_slots(uuid, uuid, uuid, timestamptz, timestamptz, integer) is
  'Deterministic offered start times of a booking type on a resource in [from, until): rule windows in their own zones, the type''s step, duration and buffers, minus booked time. At most 31 days and 500 slots; never in the past.';

-- ---------------------------------------------------------------------------
-- 4. Owner services. SECURITY INVOKER, executable by no application role.
-- ---------------------------------------------------------------------------

create function ops.set_scheduling_timezone(p_tenant_id uuid, p_timezone text, p_actor text)
returns text
language plpgsql security invoker set search_path = '' as $$
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.set_scheduling_timezone');
  if p_tenant_id is null or not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.set_scheduling_timezone: tenant not found';
  end if;
  insert into ops.scheduling_settings (tenant_id, timezone, set_by)
  values (p_tenant_id, p_timezone, p_actor)
  on conflict (tenant_id) do update set timezone = excluded.timezone, set_by = excluded.set_by;
  return p_timezone;
end
$$;

-- Defines a resource once per key: the same definition returns the same id;
-- a different one under that key is refused (only the label may be renamed,
-- through a new definition with the same unit and kind).
create function ops.define_booking_resource(
  p_tenant_id     uuid,
  p_company_id    uuid,
  p_department_id uuid,
  p_key           text,
  p_label         text,
  p_kind          text,
  p_actor         text
)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_existing ops.booking_resources;
  v_id       uuid;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.define_booking_resource');
  perform pg_advisory_xact_lock(hashtextextended('ops.booking_resources:' || coalesce(p_tenant_id::text, '') || ':' || coalesce(p_key, ''), 0));
  select r.* into v_existing from ops.booking_resources r where r.tenant_id = p_tenant_id and r.key = p_key;
  if found then
    if v_existing.company_id is distinct from p_company_id or v_existing.department_id is distinct from p_department_id
       or v_existing.kind is distinct from p_kind then
      raise exception using errcode = 'OS409', message = 'ops.define_booking_resource: that key already names a different resource';
    end if;
    if v_existing.label is distinct from p_label then
      update ops.booking_resources set label = p_label where id = v_existing.id;
    end if;
    return v_existing.id;
  end if;
  insert into ops.booking_resources (tenant_id, company_id, department_id, key, label, kind, created_by)
  values (p_tenant_id, p_company_id, p_department_id, p_key, p_label, p_kind, p_actor)
  returning id into v_id;
  return v_id;
end
$$;

create function ops.define_booking_type(
  p_tenant_id             uuid,
  p_company_id            uuid,
  p_key                   text,
  p_label                 text,
  p_duration_minutes      integer,
  p_buffer_before_minutes integer,
  p_buffer_after_minutes  integer,
  p_slot_step_minutes     integer,
  p_actor                 text
)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_existing ops.booking_types;
  v_id       uuid;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.define_booking_type');
  perform pg_advisory_xact_lock(hashtextextended('ops.booking_types:' || coalesce(p_tenant_id::text, '') || ':' || coalesce(p_key, ''), 0));
  select t.* into v_existing from ops.booking_types t where t.tenant_id = p_tenant_id and t.key = p_key;
  if found then
    if v_existing.company_id is distinct from p_company_id
       or v_existing.duration_minutes is distinct from p_duration_minutes
       or v_existing.buffer_before_minutes is distinct from p_buffer_before_minutes
       or v_existing.buffer_after_minutes is distinct from p_buffer_after_minutes
       or v_existing.slot_step_minutes is distinct from p_slot_step_minutes then
      raise exception using
        errcode = 'OS409',
        message = 'ops.define_booking_type: that key already names a type with other times; a new duration is a new type';
    end if;
    if v_existing.label is distinct from p_label then
      update ops.booking_types set label = p_label where id = v_existing.id;
    end if;
    return v_existing.id;
  end if;
  insert into ops.booking_types (tenant_id, company_id, key, label, duration_minutes, buffer_before_minutes,
                                 buffer_after_minutes, slot_step_minutes, created_by)
  values (p_tenant_id, p_company_id, p_key, p_label, p_duration_minutes, p_buffer_before_minutes,
          p_buffer_after_minutes, p_slot_step_minutes, p_actor)
  returning id into v_id;
  return v_id;
end
$$;

-- Adds a weekly window; the same window twice is the same rule.
create function ops.add_availability_rule(
  p_tenant_id       uuid,
  p_resource_id     uuid,
  p_weekday         integer,
  p_local_start     time,
  p_local_end       time,
  p_timezone        text,
  p_effective_from  date,
  p_effective_until date,
  p_actor           text
)
returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_resource ops.booking_resources;
  v_id       uuid;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.add_availability_rule');
  select r.* into v_resource from ops.booking_resources r where r.tenant_id = p_tenant_id and r.id = p_resource_id for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.add_availability_rule: resource not found in this tenant';
  end if;
  select r.id into v_id from ops.availability_rules r
   where r.tenant_id = p_tenant_id and r.resource_id = p_resource_id and r.active
     and r.weekday = p_weekday and r.local_start = p_local_start and r.local_end = p_local_end
     and r.timezone = p_timezone and r.effective_from = p_effective_from
     and r.effective_until is not distinct from p_effective_until;
  if found then
    return v_id;
  end if;
  insert into ops.availability_rules (tenant_id, company_id, resource_id, weekday, local_start, local_end, timezone,
                                      effective_from, effective_until, created_by)
  values (p_tenant_id, v_resource.company_id, p_resource_id, p_weekday, p_local_start, p_local_end, p_timezone,
          p_effective_from, p_effective_until, p_actor)
  returning id into v_id;
  return v_id;
end
$$;

-- Books one appointment, once per tenant-scoped idempotency key. The start is
-- an INSTANT; the appointment must fit a window of an active rule, lie in the
-- future and overlap no booked booking of the resource. The overlap check is
-- the exclusion constraint itself, not a read before the write: a racing
-- booking of the same time waits for this one and is refused.
create function ops.create_booking(
  p_tenant_id       uuid,
  p_resource_id     uuid,
  p_booking_type_id uuid,
  p_start_at        timestamptz,
  p_task_id         uuid,
  p_conversation_id uuid,
  p_subject_ref     text,
  p_idempotency_key text,
  p_actor           text,
  p_source          text
)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_type        ops.booking_types;
  v_resource    ops.booking_resources;
  v_fingerprint text;
  v_existing    ops.bookings;
  v_zone        text;
  v_booking     ops.bookings;
  v_context     jsonb;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_booking: no tenant scope';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.create_booking: an idempotency key is 1 to 200 printable characters';
  end if;
  perform ops.require_scheduling_actor(p_actor, 'ops.create_booking');
  if p_start_at is null then
    raise exception using errcode = 'OS400', message = 'ops.create_booking: a booking starts at an instant';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ops.bookings:key:' || p_tenant_id::text || ':' || p_idempotency_key, 0));

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'resource', p_resource_id, 'type', p_booking_type_id, 'start', extract(epoch from p_start_at)::text,
    'task', p_task_id, 'conversation', p_conversation_id, 'subject', p_subject_ref)::text, 'UTF8')), 'hex');
  select b.* into v_existing from ops.bookings b where b.tenant_id = p_tenant_id and b.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint = v_fingerprint and v_existing.rescheduled_from_id is null then
      return jsonb_build_object('booking_id', v_existing.id, 'created', false);
    end if;
    raise exception using errcode = 'OS409', message = 'ops.create_booking: that idempotency key already names a different booking';
  end if;

  select r.* into v_resource from ops.booking_resources r where r.tenant_id = p_tenant_id and r.id = p_resource_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_booking: resource not found in this tenant';
  end if;
  select t.* into v_type from ops.booking_types t
   where t.tenant_id = p_tenant_id and t.company_id = v_resource.company_id and t.id = p_booking_type_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_booking: booking type not found in the resource''s company';
  end if;
  if not v_resource.active or not v_type.active then
    raise exception using errcode = 'OS409', message = 'ops.create_booking: the resource and the booking type must be active';
  end if;
  if p_start_at <= now() then
    raise exception using errcode = 'OS409', message = 'ops.create_booking: a booking starts in the future';
  end if;
  v_zone := ops.booking_window_zone(p_tenant_id, p_resource_id, p_start_at,
                                    p_start_at + make_interval(mins => v_type.duration_minutes));
  if v_zone is null then
    raise exception using errcode = 'OS409', message = 'ops.create_booking: that time is outside the resource''s availability';
  end if;

  v_context := ops.push_event_context(p_source, null, null);
  begin
    insert into ops.bookings (tenant_id, company_id, department_id, resource_id, resource_slot_key, booking_type_id,
                              start_at, end_at, buffer_before_minutes, buffer_after_minutes, occupied, timezone,
                              task_id, conversation_id, subject_ref, source, idempotency_key, request_fingerprint,
                              created_by)
    values (p_tenant_id, v_resource.company_id, v_resource.department_id, p_resource_id, v_resource.slot_key,
            p_booking_type_id, p_start_at, p_start_at, 0, 0, tstzrange(p_start_at, p_start_at, '[]'), v_zone,
            p_task_id, p_conversation_id, p_subject_ref, p_source, p_idempotency_key, v_fingerprint, p_actor)
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception using errcode = 'OS409', message = 'ops.create_booking: that time is no longer available for this resource';
  end;
  perform ops.record_event(p_tenant_id, v_booking.company_id, 'booking.created', p_source, null, null,
    jsonb_build_object('booking_id', v_booking.id, 'resource_id', v_booking.resource_id), v_booking.id);
  perform ops.pop_event_context(v_context);
  return jsonb_build_object('booking_id', v_booking.id, 'created', true);
end
$$;

-- Moves a booked booking to a new start on the same resource and type, in ONE
-- statement: the booking is closed as rescheduled (freeing its time) and its
-- successor is inserted under the exclusion constraint. If the new time is
-- refused, the statement fails as a whole and the original booking is still
-- booked, never zero bookings and never two. Once per idempotency key: a
-- replay returns the same successor; a concurrent reschedule of the same
-- booking waits for this one and then finds it closed.
create function ops.reschedule_booking(
  p_tenant_id       uuid,
  p_booking_id      uuid,
  p_new_start_at    timestamptz,
  p_idempotency_key text,
  p_actor           text,
  p_source          text
)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_old         ops.bookings;
  v_existing    ops.bookings;
  v_type        ops.booking_types;
  v_fingerprint text;
  v_zone        text;
  v_new         ops.bookings;
  v_context     jsonb;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.reschedule_booking: no tenant scope';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.reschedule_booking: an idempotency key is 1 to 200 printable characters';
  end if;
  perform ops.require_scheduling_actor(p_actor, 'ops.reschedule_booking');
  if p_new_start_at is null then
    raise exception using errcode = 'OS400', message = 'ops.reschedule_booking: a booking starts at an instant';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ops.bookings:key:' || p_tenant_id::text || ':' || p_idempotency_key, 0));

  select b.* into v_old from ops.bookings b where b.tenant_id = p_tenant_id and b.id = p_booking_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.reschedule_booking: booking not found in this tenant';
  end if;
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'reschedule', p_booking_id, 'start', extract(epoch from p_new_start_at)::text)::text, 'UTF8')), 'hex');

  select b.* into v_existing from ops.bookings b where b.tenant_id = p_tenant_id and b.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint = v_fingerprint and v_existing.rescheduled_from_id = p_booking_id then
      return jsonb_build_object('booking_id', v_existing.id, 'rescheduled_from_id', p_booking_id, 'created', false);
    end if;
    raise exception using errcode = 'OS409', message = 'ops.reschedule_booking: that idempotency key already names a different booking';
  end if;
  if v_old.status <> 'booked' then
    raise exception using errcode = 'OS409', message = format('ops.reschedule_booking: a %s booking cannot be moved', v_old.status);
  end if;
  if p_new_start_at <= now() then
    raise exception using errcode = 'OS409', message = 'ops.reschedule_booking: a booking starts in the future';
  end if;
  select t.* into v_type from ops.booking_types t where t.tenant_id = p_tenant_id and t.id = v_old.booking_type_id;
  v_zone := ops.booking_window_zone(p_tenant_id, v_old.resource_id, p_new_start_at,
                                    p_new_start_at + make_interval(mins => v_type.duration_minutes));
  if v_zone is null then
    raise exception using errcode = 'OS409', message = 'ops.reschedule_booking: that time is outside the resource''s availability';
  end if;

  v_context := ops.push_event_context(p_source, v_old.id, null);
  update ops.bookings set status = 'rescheduled', rescheduled_by = p_actor where id = v_old.id;
  begin
    insert into ops.bookings (tenant_id, company_id, department_id, resource_id, resource_slot_key, booking_type_id,
                              start_at, end_at, buffer_before_minutes, buffer_after_minutes, occupied, timezone,
                              task_id, conversation_id, subject_ref, source, idempotency_key, request_fingerprint,
                              rescheduled_from_id, created_by)
    values (p_tenant_id, v_old.company_id, v_old.department_id, v_old.resource_id, v_old.resource_slot_key,
            v_old.booking_type_id, p_new_start_at, p_new_start_at, 0, 0, tstzrange(p_new_start_at, p_new_start_at, '[]'),
            v_zone, v_old.task_id, v_old.conversation_id, v_old.subject_ref, p_source, p_idempotency_key, v_fingerprint,
            v_old.id, p_actor)
    returning * into v_new;
  exception when exclusion_violation then
    -- Raised out of the function: the statement fails as a whole, so the
    -- update above is undone with it and the booking stays booked.
    raise exception using errcode = 'OS409', message = 'ops.reschedule_booking: that time is no longer available for this resource';
  end;
  perform ops.record_event(p_tenant_id, v_old.company_id, 'booking.rescheduled', p_source, null, null,
    jsonb_build_object('booking_id', v_new.id, 'rescheduled_from_id', v_old.id, 'resource_id', v_old.resource_id),
    v_old.id);
  perform ops.pop_event_context(v_context);
  return jsonb_build_object('booking_id', v_new.id, 'rescheduled_from_id', v_old.id, 'created', true);
end
$$;

-- Cancels a booked booking with a reason CODE, freeing its time. A repeat is
-- harmless; a rescheduled booking is refused (its successor is the one to
-- cancel). Nothing is deleted.
create function ops.cancel_booking(
  p_tenant_id  uuid,
  p_booking_id uuid,
  p_reason     text,
  p_actor      text,
  p_source     text
)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_booking ops.bookings;
  v_context jsonb;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.cancel_booking');
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception using errcode = 'OS400', message = 'ops.cancel_booking: a reason is a snake_case code';
  end if;
  select b.* into v_booking from ops.bookings b where b.tenant_id = p_tenant_id and b.id = p_booking_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.cancel_booking: booking not found in this tenant';
  end if;
  if v_booking.status = 'cancelled' then
    return 'already_cancelled';
  end if;
  if v_booking.status <> 'booked' then
    raise exception using errcode = 'OS409', message = 'ops.cancel_booking: a rescheduled booking is closed; cancel its successor';
  end if;
  v_context := ops.push_event_context(p_source, v_booking.id, null);
  update ops.bookings set status = 'cancelled', cancelled_by = p_actor, cancel_reason = p_reason where id = v_booking.id;
  perform ops.record_event(p_tenant_id, v_booking.company_id, 'booking.cancelled', p_source, null, null,
    jsonb_build_object('booking_id', v_booking.id, 'resource_id', v_booking.resource_id, 'reason', p_reason),
    v_booking.id);
  perform ops.pop_event_context(v_context);
  return 'cancelled';
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The operator's activity feed learns the booking facts, deny by default:
--    a cancellation leaves its reason code, nothing else leaves at all. The
--    body is 20260928120000's with the three types added.
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
    'booking.created', 'booking.rescheduled', 'booking.cancelled');
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
    -- Phase 3A.2: a cancellation's reason code; no id, time or subject leaves.
    when p_type = 'booking.cancelled' then
      pg_catalog.jsonb_build_object(
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    else '{}'::pg_catalog.jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Access. Backend only: no application or capability role reaches any of
--    it, and no worker capability exists for bookings.
-- ---------------------------------------------------------------------------

revoke all on table ops.scheduling_settings, ops.booking_resources, ops.booking_types, ops.availability_rules,
  ops.bookings
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on sequence ops.booking_resources_slot_key_seq
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.booking_status_transitions(),
  ops.is_time_zone(text),
  ops.guard_scheduling_settings_write(),
  ops.guard_scheduling_configuration_update(),
  ops.guard_availability_rule_insert(),
  ops.guard_booking_insert(),
  ops.guard_booking_update(),
  ops.guard_booking_delete(),
  ops.booking_window_zone(uuid, uuid, timestamptz, timestamptz),
  ops.available_slots(uuid, uuid, uuid, timestamptz, timestamptz, integer),
  ops.set_scheduling_timezone(uuid, text, text),
  ops.define_booking_resource(uuid, uuid, uuid, text, text, text, text),
  ops.define_booking_type(uuid, uuid, text, text, integer, integer, integer, integer, text),
  ops.add_availability_rule(uuid, uuid, integer, time, time, text, date, date, text),
  ops.create_booking(uuid, uuid, uuid, timestamptz, uuid, uuid, text, text, text, text),
  ops.reschedule_booking(uuid, uuid, timestamptz, text, text, text),
  ops.cancel_booking(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 7. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_tables constant pg_catalog.text[] := array['scheduling_settings', 'booking_resources', 'booking_types',
                                               'availability_rules', 'bookings'];
  c_fns constant pg_catalog.text[] := array[
    'booking_status_transitions', 'is_time_zone', 'guard_scheduling_settings_write',
    'guard_scheduling_configuration_update', 'guard_availability_rule_insert', 'guard_booking_insert',
    'guard_booking_update', 'guard_booking_delete', 'booking_window_zone', 'available_slots',
    'set_scheduling_timezone', 'define_booking_resource', 'define_booking_type', 'add_availability_rule',
    'create_booking', 'reschedule_booking', 'cancel_booking'];
begin
  select pg_catalog.string_agg(c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'scheduling table(s) lack ENABLE + FORCE row level security: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || t.relname, ', ') into v_bad
    from pg_catalog.unnest(c_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.' || t.relname, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a scheduling table: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute a scheduling function: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = any (c_fns) and p.prosecdef) then
    raise exception 'a scheduling function is SECURITY DEFINER';
  end if;

  -- The conflict rule exists, is an exclusion constraint, and covers booked rows.
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'ops.bookings'::pg_catalog.regclass and c.conname = 'bookings_no_overlap'
                    and c.contype = 'x' and pg_catalog.pg_get_constraintdef(c.oid) ~ 'WHERE \(\(status = ''booked''::text\)\)') then
    raise exception 'ops.bookings has no exclusion constraint over booked bookings';
  end if;
  if exists (select 1 from pg_catalog.pg_extension e where e.extname = 'btree_gist') then
    raise exception 'btree_gist is installed; the booking conflict rule is core PostgreSQL only';
  end if;

  -- Every update, delete and truncate guard is ENABLE ALWAYS.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname = any (c_tables) and not t.tgisinternal and t.tgenabled = 'A') <> 8 then
    raise exception 'the scheduling guards are not all ENABLE ALWAYS';
  end if;

  -- A BOOKING IS NOT A SEND: no scheduling function names a send, an outbound
  -- row, a model or decision call, a review decision, the CRM, a stop act, a
  -- budget, a price, a channel or a membership, or runs dynamic SQL.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp|send_|agent_run|shadow_decision|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels|grant_membership|revoke_membership|execute\s)';
  if v_bad is not null then
    raise exception 'a scheduling function reaches beyond booking: %', v_bad;
  end if;
end
$end_state$;
