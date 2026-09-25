-- Phase 3A — follow-ups, bookings and the calendar mirror, attacked in SQL.
--
-- The question: can any role but the owner reach scheduling state, can a
-- follow-up or a booking leave its state machine, be deleted while open or
-- cross a tenant, can two booked bookings of one resource overlap, can the
-- worker reach a follow-up or a sync its lease is not bound to, and can a
-- real calendar be connected?
--
--   S1  access: no application or capability role holds a privilege on any
--       scheduling table; the worker executes exactly its three capabilities
--       and nothing else of Phase 3A; every table is ENABLE + FORCE RLS;
--   S2  the worker, actually switched to: it reads no scheduling table and
--       calls no owner service, and its capabilities need a live lease;
--   S3  the follow-up state machine: only the declared transitions, only the
--       due job makes one due, a closed one never changes, open work is never
--       deleted, and nothing is truncated;
--   S4  structure: a plan, an occurrence, a booking and a sync cannot name
--       another tenant's unit, plan, resource, type or booking;
--   S5  the conflict rule: an overlapping booked booking is refused whoever
--       writes it, an adjacent one and another resource are not, and a
--       cancellation frees the time; a booking's time is fixed;
--   S6  the calendar gate: only the fake provider can be connected, no
--       credential column exists, and a sync never changes a booking;
--   S7  the agenda projection: exactly the tenant's rows, no subject
--       reference, actor label, key or provider event id;
--   X   deliberate breaks, each caught by its own check.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

-- `set role ops_worker` for the worker's capabilities; interpolated, never
-- `grant ... to current_user` (owner decision S0-F).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

create temporary table fs_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into fs_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from fs_ids where name = p_name;
$$;

-- Refused with this SQLSTATE, or the suite fails naming the case.
create function pg_temp.expect_refused(p_case text, p_state text, p_sql text) returns void
language plpgsql as $f$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_state then
      raise exception '%: expected SQLSTATE %, got % (%)', p_case, p_state, sqlstate, sqlerrm;
    end if;
    return;
  end;
  raise exception '%: was accepted', p_case;
end
$f$;

-- Two tenants, each with a company, a department, a resource, a type, rules,
-- a policy, one plan and one booking.
do $$
declare
  t uuid; c uuid; d uuid; r uuid; bt uuid; p jsonb; b jsonb; day date; s timestamptz;
begin
  foreach t in array array[gen_random_uuid(), gen_random_uuid()] loop
    insert into ops.tenants (id, slug, name) values (t, 'fs-' || left(t::text, 8), 'FS synthetic');
    c := ops.create_company(t, 'clinica', 'Clínica sintética', 'seed');
    d := ops.create_department(t, c, 'atendimento', 'Atendimento', 'seed');
    perform ops.set_scheduling_timezone(t, 'America/Sao_Paulo', 'fs-owner');
    r := ops.define_booking_resource(t, c, d, 'agenda-a', 'Agenda A', 'professional', 'fs-owner');
    perform ops.define_booking_resource(t, c, d, 'agenda-b', 'Agenda B', 'professional', 'fs-owner');
    bt := ops.define_booking_type(t, c, 'inicial', 'Atendimento inicial', 50, 0, 10, 60, 'fs-owner');
    for i in 1..7 loop
      perform ops.add_availability_rule(t, r, i, '08:00', '20:00', 'America/Sao_Paulo', current_date - 1, null, 'fs-owner');
      perform ops.add_availability_rule(t, (select id from ops.booking_resources where tenant_id = t and key = 'agenda-b'),
                                        i, '08:00', '20:00', 'America/Sao_Paulo', current_date - 1, null, 'fs-owner');
    end loop;
    perform ops.define_follow_up_policy_version(t, 'cadence', 'Cadência', array[4320, 10080, 14400], 'fs-owner');
    p := ops.schedule_follow_up_plan(t, c, d, null, 'cadence', now() - interval '72 hours 1 minute', null, null,
                                     'lead:FS-SUBJECT-SENTINEL', 'fs-plan', 'fs-owner', 'seed');
    day := (now() at time zone 'America/Sao_Paulo')::date + 2;
    s := (day + time '09:00') at time zone 'America/Sao_Paulo';
    b := ops.create_booking(t, r, bt, s, null, null, 'lead:FS-SUBJECT-SENTINEL', 'fs-booking', 'fs-owner', 'seed');
    if not exists (select 1 from fs_ids where name = 'ta') then
      perform pg_temp.remember('ta', t); perform pg_temp.remember('ca', c); perform pg_temp.remember('da', d);
      perform pg_temp.remember('ra', r); perform pg_temp.remember('bta', bt);
      perform pg_temp.remember('plana', (p ->> 'plan_id')::uuid);
      perform pg_temp.remember('booka', (b ->> 'booking_id')::uuid);
    else
      perform pg_temp.remember('tb', t); perform pg_temp.remember('cb', c); perform pg_temp.remember('db', d);
      perform pg_temp.remember('rb', r); perform pg_temp.remember('btb', bt);
      perform pg_temp.remember('planb', (p ->> 'plan_id')::uuid);
      perform pg_temp.remember('bookb', (b ->> 'booking_id')::uuid);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- S1. Access.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  c_tables constant text[] := array['follow_up_policies', 'follow_up_policy_versions', 'follow_up_plans', 'follow_ups',
                                    'scheduling_settings', 'booking_resources', 'booking_types', 'availability_rules',
                                    'bookings', 'calendar_connections', 'calendar_syncs'];
begin
  select string_agg(r.rolname || ':' || t.relname, ', ') into v_bad
    from unnest(c_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                      ('ops_operator_api')) as r (rolname)
   where has_table_privilege(r.rolname, 'ops.' || t.relname, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'S1: a role holds a privilege on a scheduling table: %', v_bad;
  end if;
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables) and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'S1: a scheduling table lacks ENABLE + FORCE row level security: %', v_bad;
  end if;
  -- Every Phase 3A function any application or capability role can execute:
  -- exactly the worker's three capabilities.
  select string_agg(r.rolname || ':' || p.oid::regprocedure, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                      ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops'
     and p.proname ~ '(follow_up|booking|availab|scheduling|calendar|slots|agenda|time_zone)'
     and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker'
              and p.proname in ('mark_follow_up_due', 'start_calendar_sync', 'settle_calendar_sync'));
  if v_bad is not null then
    raise exception 'S1: a role can execute a scheduling function it must not: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- S2. The worker, actually switched to.
-- ---------------------------------------------------------------------------
do $$
declare
  v_ta uuid := pg_temp.id('ta');
  v_ra uuid := pg_temp.id('ra');
  v_bta uuid := pg_temp.id('bta');
begin
  execute 'set local role ops_worker';
  perform pg_temp.expect_refused('S2 the worker reading follow-ups', '42501', 'select count(*) from ops.follow_ups');
  perform pg_temp.expect_refused('S2 the worker reading bookings', '42501', 'select count(*) from ops.bookings');
  perform pg_temp.expect_refused('S2 the worker reading calendar syncs', '42501', 'select count(*) from ops.calendar_syncs');
  perform pg_temp.expect_refused('S2 the worker completing a follow-up', '42501',
    format('select ops.complete_follow_up(%L, gen_random_uuid(), %L, %L)', v_ta, 'x', 'seed'));
  perform pg_temp.expect_refused('S2 the worker creating a booking', '42501',
    format('select ops.create_booking(%L, %L, %L, now() + interval ''1 day'', null, null, %L, %L, %L, %L)',
           v_ta, v_ra, v_bta, 'lead:X', 'k', 'x', 'seed'));
  -- Its capabilities without a lease reach nothing.
  perform pg_temp.expect_refused('S2 marking due without a lease', '42501', 'select ops.mark_follow_up_due()');
  perform pg_temp.expect_refused('S2 starting a sync without a lease', '42501', 'select ops.start_calendar_sync(''fake'')');
  perform pg_temp.expect_refused('S2 settling a sync without a lease', '42501',
    'select ops.settle_calendar_sync(''synced'', ''fake-x'', null)');
  execute 'reset role';
end
$$;

-- ---------------------------------------------------------------------------
-- S3. The follow-up state machine and history.
-- ---------------------------------------------------------------------------
do $$
declare
  v_first uuid := (select id from ops.follow_ups where plan_id = pg_temp.id('plana') and step_number = 1);
  v_second uuid := (select id from ops.follow_ups where plan_id = pg_temp.id('plana') and step_number = 2);
begin
  perform pg_temp.expect_refused('S3 scheduled -> completed', 'OS409',
    format('update ops.follow_ups set status = ''completed'', closed_by = ''x'', close_reason = ''completed'' where id = %L', v_first));
  perform pg_temp.expect_refused('S3 moving a due time', 'OS409',
    format('update ops.follow_ups set due_at = due_at + interval ''1 day'' where id = %L', v_first));
  perform pg_temp.expect_refused('S3 re-pointing the due job', 'OS409',
    format('update ops.follow_ups set job_id = (select id from ops.jobs where kind = ''follow_up.due'' and id <> job_id limit 1) where id = %L', v_first));
  perform pg_temp.expect_refused('S3 deleting open work', 'OS409', format('delete from ops.follow_ups where id = %L', v_first));
  perform pg_temp.expect_refused('S3 deleting an active plan', 'OS409',
    format('delete from ops.follow_up_plans where id = %L', pg_temp.id('plana')));
  perform pg_temp.expect_refused('S3 truncating follow-ups', 'OS409', 'truncate ops.follow_ups cascade');
  perform pg_temp.expect_refused('S3 rewriting a cadence', 'OS409',
    'update ops.follow_up_policy_versions set step_offsets_minutes = ''{60}''');
  -- Due through its job's transition, then completed; then closed for good.
  update ops.follow_ups set status = 'due' where id = v_first;
  if ops.complete_follow_up(pg_temp.id('ta'), v_first, 'fs-owner', 'seed') <> 'completed' then
    raise exception 'S3: a due follow-up was not completed';
  end if;
  perform pg_temp.expect_refused('S3 reopening a completed follow-up', 'OS409',
    format('update ops.follow_ups set status = ''due'', completed_at = null, closed_by = null, close_reason = null where id = %L', v_first));
  perform pg_temp.expect_refused('S3 cancelling a completed follow-up', 'OS409',
    format('select ops.cancel_follow_up(%L, %L, %L, %L, %L)', pg_temp.id('ta'), v_first, 'lead_replied', 'x', 'seed'));
  -- A free-text reason is refused: a reason is a code.
  perform pg_temp.expect_refused('S3 a free-text reason', 'OS400',
    format('select ops.cancel_follow_up(%L, %L, %L, %L, %L)', pg_temp.id('ta'), v_second, 'Patient said no', 'x', 'seed'));
end
$$;

-- ---------------------------------------------------------------------------
-- S4. Structure across tenants.
-- ---------------------------------------------------------------------------
do $$
begin
  -- Its insert guard finds no such active company in the plan's tenant first.
  perform pg_temp.expect_refused('S4 a plan naming another tenant''s company', 'OS409',
    format($q$insert into ops.follow_up_plans (tenant_id, company_id, department_id, policy_version_id, anchor_at,
             subject_ref, idempotency_key, request_fingerprint, created_by)
           select %L, %L, %L, v.id, now(), 'lead:X', 'fs-x', repeat('a', 64), 'x'
             from ops.follow_up_policy_versions v where v.tenant_id = %L limit 1$q$,
           pg_temp.id('ta'), pg_temp.id('cb'), pg_temp.id('db'), pg_temp.id('ta')));
  perform pg_temp.expect_refused('S4 an occurrence of another tenant''s plan', 'OS404',
    format('insert into ops.follow_ups (tenant_id, company_id, plan_id, step_number, step_count, due_at) values (%L, %L, %L, 1, 3, now())',
           pg_temp.id('ta'), pg_temp.id('ca'), pg_temp.id('planb')));
  perform pg_temp.expect_refused('S4 a booking of another tenant''s resource', 'OS404',
    format('select ops.create_booking(%L, %L, %L, now() + interval ''2 days'', null, null, %L, %L, %L, %L)',
           pg_temp.id('ta'), pg_temp.id('rb'), pg_temp.id('bta'), 'lead:X', 'fs-cross', 'x', 'seed'));
  perform pg_temp.expect_refused('S4 cancelling another tenant''s booking', 'OS404',
    format('select ops.cancel_booking(%L, %L, %L, %L, %L)', pg_temp.id('ta'), pg_temp.id('bookb'), 'patient_request', 'x', 'seed'));
  perform pg_temp.expect_refused('S4 slots of another tenant''s resource', 'OS404',
    format('select * from ops.available_slots(%L, %L, %L, now(), now() + interval ''1 day'')',
           pg_temp.id('ta'), pg_temp.id('rb'), pg_temp.id('btb')));
  perform pg_temp.expect_refused('S4 a calendar connection for another tenant''s company', '23503',
    format('select ops.configure_calendar_connection(%L, %L, %L, null, true, %L)', pg_temp.id('ta'), pg_temp.id('cb'), 'fake', 'x'));
end
$$;

-- ---------------------------------------------------------------------------
-- S5. The conflict rule, whoever writes.
-- ---------------------------------------------------------------------------
do $$
declare
  v_booking ops.bookings := (select b from ops.bookings b where b.id = pg_temp.id('booka'));
  v_other uuid := (select id from ops.booking_resources where tenant_id = pg_temp.id('ta') and key = 'agenda-b');
  v_raw text := $q$insert into ops.bookings (tenant_id, company_id, department_id, resource_id, resource_slot_key,
                    booking_type_id, start_at, end_at, buffer_before_minutes, buffer_after_minutes, occupied, timezone,
                    subject_ref, source, idempotency_key, request_fingerprint, created_by)
                  select %L, company_id, department_id, id, slot_key, %L, %L::timestamptz, %L::timestamptz, 0, 0,
                         tstzrange(%L::timestamptz, %L::timestamptz, '[]'), 'America/Sao_Paulo', 'lead:X', 'seed', %L,
                         repeat('b', 64), 'x'
                    from ops.booking_resources where id = %L$q$;
begin
  -- The owner's own raw insert of an overlapping time is refused by the constraint.
  perform pg_temp.expect_refused('S5 an overlapping booked booking, raw', '23P01',
    format(v_raw, pg_temp.id('ta'), pg_temp.id('bta'), v_booking.start_at + interval '30 minutes',
           v_booking.start_at, v_booking.start_at, v_booking.start_at, 'fs-raw-1', pg_temp.id('ra')));
  -- Its buffer: a booking starting inside the 10 minutes after is refused too.
  perform pg_temp.expect_refused('S5 inside the buffer after', '23P01',
    format(v_raw, pg_temp.id('ta'), pg_temp.id('bta'), v_booking.end_at + interval '5 minutes',
           v_booking.start_at, v_booking.start_at, v_booking.start_at, 'fs-raw-2', pg_temp.id('ra')));
  -- Adjacent to the buffer, and the same time on another resource: accepted.
  execute format(v_raw, pg_temp.id('ta'), pg_temp.id('bta'), v_booking.end_at + interval '10 minutes',
                 v_booking.start_at, v_booking.start_at, v_booking.start_at, 'fs-raw-3', pg_temp.id('ra'));
  execute format(v_raw, pg_temp.id('ta'), pg_temp.id('bta'), v_booking.start_at,
                 v_booking.start_at, v_booking.start_at, v_booking.start_at, 'fs-raw-4', v_other);
  -- A caller's end, buffers and occupied range are ignored: the guard derives them.
  if (select upper(occupied) - lower(occupied) from ops.bookings where idempotency_key = 'fs-raw-3') <> interval '60 minutes' then
    raise exception 'S5: a booking''s occupied time was not derived from its type';
  end if;
  -- A booking's time is fixed, and a booked one is never deleted.
  perform pg_temp.expect_refused('S5 moving a booking in place', 'OS409',
    format('update ops.bookings set start_at = start_at + interval ''1 hour'' where id = %L', v_booking.id));
  perform pg_temp.expect_refused('S5 deleting a booked booking', 'OS409',
    format('delete from ops.bookings where id = %L', v_booking.id));
  -- Cancelled, its time is free (30 minutes earlier overlaps only it).
  perform ops.cancel_booking(pg_temp.id('ta'), v_booking.id, 'patient_request', 'fs-owner', 'seed');
  execute format(v_raw, pg_temp.id('ta'), pg_temp.id('bta'), v_booking.start_at - interval '30 minutes',
                 v_booking.start_at, v_booking.start_at, v_booking.start_at, 'fs-raw-5', pg_temp.id('ra'));
end
$$;

-- ---------------------------------------------------------------------------
-- S6. The calendar gate.
-- ---------------------------------------------------------------------------
do $$
declare
  v_before jsonb;
  v_booking uuid;
  v_sync uuid;
begin
  perform pg_temp.expect_refused('S6 a real calendar provider', '23514',
    format('select ops.configure_calendar_connection(%L, %L, %L, null, true, %L)', pg_temp.id('ta'), pg_temp.id('ca'), 'google', 'x'));
  if exists (select 1 from pg_attribute a
              where a.attrelid in ('ops.calendar_connections'::regclass, 'ops.calendar_syncs'::regclass)
                and a.attnum > 0 and not a.attisdropped
                and a.attname ~* '(token|secret|password|credential|oauth|refresh|api_key)') then
    raise exception 'S6: a calendar table holds a credential-shaped column';
  end if;
  perform ops.configure_calendar_connection(pg_temp.id('ta'), pg_temp.id('ca'), 'fake', null, true, 'fs-owner');
  v_booking := (ops.create_booking(pg_temp.id('ta'), pg_temp.id('ra'), pg_temp.id('bta'),
                ((((now() at time zone 'America/Sao_Paulo')::date + 3) + time '10:00') at time zone 'America/Sao_Paulo'),
                null, null, 'lead:FS-SUBJECT-SENTINEL', 'fs-synced', 'fs-owner', 'seed') ->> 'booking_id')::uuid;
  select id into v_sync from ops.calendar_syncs where booking_id = v_booking and operation = 'create';
  if v_sync is null or (select kind from ops.jobs j join ops.calendar_syncs s on s.job_id = j.id where s.id = v_sync) <> 'calendar.create' then
    raise exception 'S6: a connected booking did not request one calendar.create job';
  end if;
  select to_jsonb(b) - 'cancelled_at' into v_before from ops.bookings b where b.id = v_booking;
  -- A create that has not succeeded carries no event id: the table refuses it.
  perform pg_temp.expect_refused('S6 an event id on a create that did not succeed', '23514',
    format('update ops.calendar_syncs set status = ''running'', job_attempt = 1, provider_kind = ''fake'', external_event_id = ''fake-x'' where id = %L', v_sync));
  -- The sync's lifecycle never re-opens and never touches the booking.
  update ops.calendar_syncs set status = 'running', job_attempt = 1, provider_kind = 'fake' where id = v_sync;
  update ops.calendar_syncs set status = 'indeterminate', error_code = 'provider_error' where id = v_sync;
  perform pg_temp.expect_refused('S6 reopening an uncertain sync', 'OS409',
    format('update ops.calendar_syncs set status = ''pending'' where id = %L', v_sync));
  perform pg_temp.expect_refused('S6 an event id added to a settled sync', 'OS409',
    format('update ops.calendar_syncs set external_event_id = ''fake-x'' where id = %L', v_sync));
  if (select to_jsonb(b) - 'cancelled_at' from ops.bookings b where b.id = v_booking) is distinct from v_before then
    raise exception 'S6: a calendar sync changed its booking';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- S7. The agenda projection.
-- ---------------------------------------------------------------------------
do $$
declare
  v_a jsonb := ops.cos_agenda(pg_temp.id('ta'), now());
  v_text text := v_a::text;
begin
  if v_text ~ '(FS-SUBJECT-SENTINEL|fs-owner|fs-booking|fs-plan|fs-raw|fake-x|provider_error|lead:)' then
    raise exception 'S7: the agenda carries a subject, an actor, a key, an event id or an error: %', v_text;
  end if;
  if v_text like '%' || pg_temp.id('bookb')::text || '%' or v_text like '%' || pg_temp.id('planb')::text || '%' then
    raise exception 'S7: tenant A''s agenda names tenant B''s rows';
  end if;
  if (v_a -> 'bookings' ->> 'conflicts')::int <> 0 then
    raise exception 'S7: the agenda found overlapping booked bookings';
  end if;
  if v_a -> 'calendar' ->> 'state' <> 'simulated' or v_a ->> 'timezone' <> 'America/Sao_Paulo' then
    raise exception 'S7: the agenda misreports the calendar or the zone';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- X. Deliberate breaks, each rolled back, each caught by its own check.
-- ---------------------------------------------------------------------------
do $$
declare
  v_caught boolean;
begin
  -- X1. Without the exclusion constraint, the raw overlap of S5 is stored.
  begin
    alter table ops.bookings drop constraint bookings_no_overlap;
    v_caught := false;
    begin
      insert into ops.bookings (tenant_id, company_id, department_id, resource_id, resource_slot_key, booking_type_id,
                                start_at, end_at, buffer_before_minutes, buffer_after_minutes, occupied, timezone,
                                subject_ref, source, idempotency_key, request_fingerprint, created_by)
      select b.tenant_id, b.company_id, b.department_id, b.resource_id, b.resource_slot_key, b.booking_type_id,
             b.start_at, b.start_at, 0, 0, tstzrange(b.start_at, b.start_at, '[]'), b.timezone, 'lead:X', 'seed',
             'fs-x1', repeat('c', 64), 'x'
        from ops.bookings b where b.tenant_id = pg_temp.id('tb') and b.status = 'booked' limit 1;
    exception when exclusion_violation then v_caught := true;
    end;
    if v_caught then
      raise exception 'X1: the break did not take';
    end if;
    raise exception using errcode = 'P0001', message = 'X1 rolled back';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'X1 rolled back' then raise; end if;
  end;
  if not exists (select 1 from pg_constraint where conname = 'bookings_no_overlap') then
    raise exception 'X1: the exclusion constraint was not restored';
  end if;
  -- X2. With a worker grant on bookings, S1's check names it.
  begin
    grant select on ops.bookings to ops_worker;
    if not has_table_privilege('ops_worker', 'ops.bookings', 'SELECT') then
      raise exception 'X2: the break did not take';
    end if;
    raise exception using errcode = 'P0001', message = 'X2 rolled back';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'X2 rolled back' then raise; end if;
  end;
  if has_table_privilege('ops_worker', 'ops.bookings', 'SELECT') then
    raise exception 'X2: the grant was not rolled back';
  end if;
end
$$;

rollback;

-- Nothing above committed.
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'fs-%') then
    raise exception 'follow_up_scheduling.sql left fixtures behind';
  end if;
end
$$;
