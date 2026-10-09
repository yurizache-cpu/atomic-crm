-- ADR 0026 §D, slice 4: the owner's notification (decision 6).
--
-- A request for a person, or a message waiting for the person who holds a
-- conversation, may tell the owner on WhatsApp:
--   * The target (ops.owner_notification_targets): the owner's own number, the
--     test channel it is sent from, two approved utility templates, the kinds,
--     quiet hours and caps. Recorded and retired only by the owner's act
--     (npm run front-desk -- notify-target record|retire); never a migration
--     row, never printed. It is never a number a CRM contact or a conversation
--     holds, but for a sender the owner registered on a test channel.
--   * The intent (ops.owner_notifications): recorded by ops.open_exception, in
--     the transaction that raises the episode, for a request for a person or a
--     message waiting for one, only for a message newer than the person's
--     latest reply that the screen did not class as danger; once per
--     conversation between person replies. Isolated: no failure or lock wait
--     of it ever fails the admission or the screening. Never for a failure.
--   * The send: one external owner_notification.send job per intent, due after
--     a 60-second debounce or at quiet hours' end, held by every execution stop
--     of its unit, within the hourly and daily caps (waiting, never dropped);
--     every due intent of the same target coalesced into one send (a digest
--     across conversations); skipped when the episode closed or a person
--     replied since; at most one provider call, never retried. Its outcome
--     raises no exception.
--   * The owner's number is recognised at admission before any conversation is
--     written, as a content-free fact (communication.inbound_refused,
--     owner_number), unless it is a sender the owner registered on that test
--     channel.
-- No event carries a notification; no row, event, job payload, log line or
-- browser projection carries the number or a name; the provider's message id
-- (which embeds the recipient) is kept only as its digest.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.
-- ---------------------------------------------------------------------------
-- 1. The target: the owner's own number and how to tell the owner. Owner
--    data, one in force per tenant, recorded and retired by the owner's act;
--    never a migration row. A retired target keeps no number.
-- ---------------------------------------------------------------------------

-- A scope key, so a notification can name its episode with a composite key.
alter table ops.exceptions add constraint exceptions_scope_id_key unique (tenant_id, company_id, id);

create table ops.owner_notification_targets (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references ops.tenants (id) on delete restrict,
  company_id        uuid not null,
  channel_id        uuid not null,
  digits            text,
  episode_template  text not null,
  digest_template   text not null,
  template_language text not null,
  kinds             text[] not null,
  quiet_start       time not null,
  quiet_end         time not null,
  time_zone         text not null,
  hourly_cap        integer not null,
  daily_cap         integer not null,
  name_fallback     text not null,
  recorded_by       text not null,
  recorded_at       timestamptz not null default now(),
  retired_by        text,
  retired_at        timestamptz,
  retire_reason     text,
  constraint owner_notification_targets_scope_id_key unique (tenant_id, id),
  constraint owner_notification_targets_channel_fkey foreign key (tenant_id, company_id, channel_id)
    references ops.communication_channels (tenant_id, company_id, id) on delete restrict,
  constraint owner_notification_targets_digits_shape check (
        (retired_at is null) = (digits is not null)
    and (digits is null or digits ~ '^[1-9][0-9]{7,14}$')),
  constraint owner_notification_targets_template_format check (
        episode_template ~ '^[a-z0-9_]+$' and char_length(episode_template) <= 512
    and digest_template ~ '^[a-z0-9_]+$' and char_length(digest_template) <= 512
    and episode_template <> digest_template),
  constraint owner_notification_targets_language_format check (template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  constraint owner_notification_targets_kinds check (
    cardinality(kinds) between 1 and 2 and kinds <@ array['person_requested', 'message_waiting']::text[]),
  constraint owner_notification_targets_quiet check (quiet_start <> quiet_end),
  constraint owner_notification_targets_time_zone_format check (time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$'),
  constraint owner_notification_targets_caps check (
    hourly_cap between 1 and 60 and daily_cap between 1 and 200 and hourly_cap <= daily_cap),
  constraint owner_notification_targets_fallback check (name_fallback ~ '^[[:alpha:]][[:alpha:] ]{0,19}$'),
  constraint owner_notification_targets_actor_format check (
        recorded_by ~ '^[A-Za-z0-9._:@-]{1,200}$'
    and (retired_by is null or retired_by ~ '^[A-Za-z0-9._:@-]{1,200}$')),
  constraint owner_notification_targets_retire_shape check (
        (retired_at is null) = (retired_by is null)
    and (retired_at is null) = (retire_reason is null)
    and (retire_reason is null or char_length(retire_reason) between 1 and 200))
);

comment on table ops.owner_notification_targets is
  'ADR 0026 §D, SI-86: the owner''s own number and how to tell the owner that a person is waiting: the test channel it is sent from, two approved utility templates, the kinds, quiet hours and caps. One in force per tenant; recorded and retired only by the owner''s act; a retired target keeps no number; never printed.';

create unique index owner_notification_targets_one_in_force
  on ops.owner_notification_targets (tenant_id) where retired_at is null;

-- Born in force on a test channel of its tenant with a real time zone, never
-- edited, retired once (dropping its number); only a retired target may be
-- deleted (a fixture's cleanup). Messages never carry a value.
create function ops.guard_owner_notification_target()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.retired_at is not null or new.retired_by is not null or new.retire_reason is not null then
      raise exception using errcode = 'OS403', message = 'ops.owner_notification_targets: a target is recorded in force';
    end if;
    if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone) then
      raise exception using errcode = 'OS400', message = 'ops.owner_notification_targets: unknown time zone';
    end if;
    if not exists (select 1 from ops.communication_channels c
                    where c.tenant_id = new.tenant_id and c.company_id = new.company_id and c.id = new.channel_id
                      and c.mode = 'test') then
      raise exception using errcode = 'OS409',
        message = 'ops.owner_notification_targets: a target is sent only from a test channel of its tenant';
    end if;
    if cardinality(new.kinds) <> (select count(distinct k) from unnest(new.kinds) k) then
      raise exception using errcode = 'OS400', message = 'ops.owner_notification_targets: the kinds repeat';
    end if;
    new.recorded_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.retired_at is null then
      raise exception using errcode = 'OS403', message = 'ops.owner_notification_targets: retire a target before it is deleted';
    end if;
    return old;
  end if;
  if old.retired_at is not null
     or (to_jsonb(new) - array['retired_by', 'retired_at', 'retire_reason', 'digits'])
        is distinct from (to_jsonb(old) - array['retired_by', 'retired_at', 'retire_reason', 'digits'])
     or new.retired_by is null or new.retire_reason is null or new.digits is not null then
    raise exception using errcode = 'OS403',
      message = 'ops.owner_notification_targets: a target is never edited; it is retired once, without its number';
  end if;
  new.retired_at := now();
  return new;
end
$function$;

create trigger owner_notification_targets_guard
  before insert or update or delete on ops.owner_notification_targets
  for each row execute function ops.guard_owner_notification_target();
alter table ops.owner_notification_targets enable always trigger owner_notification_targets_guard;

create function ops.refuse_owner_notification_target_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.owner_notification_targets: the targets are never truncated';
end
$function$;

create trigger owner_notification_targets_refuse_truncate
  before truncate on ops.owner_notification_targets
  for each statement execute function ops.refuse_owner_notification_target_truncate();
alter table ops.owner_notification_targets enable always trigger owner_notification_targets_refuse_truncate;

alter table ops.owner_notification_targets enable row level security;
alter table ops.owner_notification_targets force row level security;

-- A number's forms: as given, and Brazil's other mobile form (with or without
-- the ninth digit), since which one Meta reports is not verified.
create function ops.owner_number_forms(p_digits text)
returns text[]
language sql
immutable
security invoker
set search_path to ''
as $function$
  select case
    when p_digits is null or p_digits !~ '^[0-9]{6,20}$' then array[]::text[]
    when p_digits ~ '^55[1-9][0-9]9[0-9]{8}$'
      then array[p_digits, pg_catalog.substr(p_digits, 1, 4) || pg_catalog.substr(p_digits, 6)]
    when p_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$'
      then array[p_digits, pg_catalog.substr(p_digits, 1, 4) || '9' || pg_catalog.substr(p_digits, 5)]
    else array[p_digits]
  end;
$function$;

-- The key that orders the owner's acts on the target against the gateway's
-- recognition of the number (taken shared by the gateway, exclusive by the
-- acts), so a conversation never starts holding a number being recorded.
create function ops.owner_target_lock_key(p_tenant_id uuid)
returns bigint
language sql
immutable
security invoker
set search_path to ''
as $function$
  select ('x' || pg_catalog.substr(pg_catalog.md5('owner_target:' || p_tenant_id::text), 1, 16))::bit(64)::bigint;
$function$;

-- Whether a sender is the owner's own number, in either form, for the tenant.
create function ops.owner_number_matches(p_tenant_id uuid, p_from text)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select exists (
    select 1 from ops.owner_notification_targets t
     where t.tenant_id = p_tenant_id and t.retired_at is null
       and p_from = any (ops.owner_number_forms(t.digits)));
$function$;

-- The owner's two acts. Every argument is checked first, with messages that
-- never carry a value, and a constraint's refusal is answered the same way,
-- so the number never reaches an error's detail or the server's log. A new
-- target retires the one in force in the same transaction.
create function ops.record_owner_notification_target(
  p_tenant_id        uuid,
  p_channel_id       uuid,
  p_digits           text,
  p_episode_template text,
  p_digest_template  text,
  p_actor            text,
  p_language         text default 'pt_BR',
  p_kinds            text[] default array['person_requested', 'message_waiting'],
  p_quiet_start      time default '22:00',
  p_quiet_end        time default '08:00',
  p_time_zone        text default 'America/Sao_Paulo',
  p_hourly_cap       integer default 10,
  p_daily_cap        integer default 30,
  p_name_fallback    text default 'Contato')
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id      uuid;
  v_channel ops.communication_channels;
  v_form    text;
  v_held    integer;
  v_crm     jsonb;
begin
  if p_tenant_id is null or not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.record_owner_notification_target: unknown tenant';
  end if;
  if p_digits is null or p_digits !~ '^[1-9][0-9]{7,14}$' then
    raise exception using errcode = 'OS400',
      message = 'ops.record_owner_notification_target: the number is 8 to 15 digits, with its country code';
  end if;
  if p_episode_template is null or p_episode_template !~ '^[a-z0-9_]+$' or char_length(p_episode_template) > 512
     or p_digest_template is null or p_digest_template !~ '^[a-z0-9_]+$' or char_length(p_digest_template) > 512
     or p_episode_template = p_digest_template then
    raise exception using errcode = 'OS400',
      message = 'ops.record_owner_notification_target: a template name is lowercase letters, digits and underscores, and the two differ';
  end if;
  if p_language is null or p_language !~ '^[a-z]{2,3}(_[A-Z]{2})?$' then
    raise exception using errcode = 'OS400', message = 'ops.record_owner_notification_target: malformed template language';
  end if;
  if p_kinds is null or cardinality(p_kinds) not between 1 and 2
     or not (p_kinds <@ array['person_requested', 'message_waiting']::text[])
     or cardinality(p_kinds) <> (select count(distinct k) from unnest(p_kinds) k) then
    raise exception using errcode = 'OS400',
      message = 'ops.record_owner_notification_target: the kinds are person_requested and message_waiting, each once';
  end if;
  if p_quiet_start is null or p_quiet_end is null or p_quiet_start = p_quiet_end then
    raise exception using errcode = 'OS400', message = 'ops.record_owner_notification_target: the quiet hours start and end differ';
  end if;
  if p_time_zone is null or p_time_zone !~ '^[A-Za-z0-9_+/-]{1,64}$'
     or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_time_zone) then
    raise exception using errcode = 'OS400', message = 'ops.record_owner_notification_target: unknown time zone';
  end if;
  if p_hourly_cap is null or p_daily_cap is null or p_hourly_cap not between 1 and 60
     or p_daily_cap not between 1 and 200 or p_hourly_cap > p_daily_cap then
    raise exception using errcode = 'OS400',
      message = 'ops.record_owner_notification_target: the hourly cap is 1 to 60, the daily 1 to 200, and not below it';
  end if;
  if p_name_fallback is null or p_name_fallback !~ '^[[:alpha:]][[:alpha:] ]{0,19}$' then
    raise exception using errcode = 'OS400',
      message = 'ops.record_owner_notification_target: the fallback word is 1 to 20 letters';
  end if;
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_owner_notification_target: malformed actor';
  end if;
  select c.* into v_channel from ops.communication_channels c
   where c.tenant_id = p_tenant_id and c.id = p_channel_id and c.mode = 'test';
  if not found then
    raise exception using errcode = 'OS409',
      message = 'ops.record_owner_notification_target: the channel is not a test channel of this tenant';
  end if;

  -- The gateway waits while the target changes, and the target waits for the
  -- gateway's admissions in flight.
  perform pg_catalog.pg_advisory_xact_lock(ops.owner_target_lock_key(p_tenant_id));

  -- Never a lead's number: no conversation of the tenant holds it and no CRM
  -- contact carries it, in either form, but a sender the owner registered on a
  -- test channel (the owner's own device).
  foreach v_form in array ops.owner_number_forms(p_digits) loop
    if exists (select 1
                 from ops.communication_test_senders s
                 join ops.communication_channels c
                   on c.tenant_id = s.tenant_id and c.company_id = s.company_id and c.id = s.channel_id
                where s.tenant_id = p_tenant_id and s.sender = v_form and s.retired_at is null and c.mode = 'test') then
      continue;
    end if;
    select count(*) into v_held from ops.conversations c
     where c.tenant_id = p_tenant_id and c.contact_ref = v_form;
    if v_held > 0 then
      raise exception using errcode = 'OS409',
        message = format('ops.record_owner_notification_target: %s conversation(s) of this tenant already hold this number; erase them first (npm run ops -- identifiers erase --number-file <path>, both forms)', v_held);
    end if;
    v_crm := ops.crm_contact_by_phone(p_tenant_id, v_form);
    if v_crm ->> 'state' in ('found', 'ambiguous') then
      raise exception using errcode = 'OS409',
        message = 'ops.record_owner_notification_target: a CRM contact carries this number; a lead is never the target';
    end if;
  end loop;

  begin
    update ops.owner_notification_targets
       set retired_by = p_actor, retire_reason = 'superseded by a new target', digits = null
     where tenant_id = p_tenant_id and retired_at is null;
    insert into ops.owner_notification_targets (
      tenant_id, company_id, channel_id, digits, episode_template, digest_template, template_language, kinds,
      quiet_start, quiet_end, time_zone, hourly_cap, daily_cap, name_fallback, recorded_by)
    values (
      p_tenant_id, v_channel.company_id, v_channel.id, p_digits, p_episode_template, p_digest_template, p_language,
      p_kinds, p_quiet_start, p_quiet_end, p_time_zone, p_hourly_cap, p_daily_cap, p_name_fallback, p_actor)
    returning id into v_id;
  exception when check_violation or not_null_violation or unique_violation or foreign_key_violation then
    raise exception using errcode = 'OS400', message = 'ops.record_owner_notification_target: the target was refused';
  end;
  return v_id;
end
$function$;

comment on function ops.record_owner_notification_target(uuid, uuid, text, text, text, text, text, text[], time, time, text, integer, integer, text) is
  'ADR 0026 §D, SI-86: the owner''s act recording the notification target (retiring the one in force). Refuses a number a conversation or a CRM contact holds, but a sender the owner registered on a test channel; no message carries a value. Executable by no role; npm run front-desk -- notify-target record.';

create function ops.retire_owner_notification_target(p_tenant_id uuid, p_reason text, p_actor text)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if p_reason is null or char_length(p_reason) not between 1 and 200 then
    raise exception using errcode = 'OS400', message = 'ops.retire_owner_notification_target: the reason is 1 to 200 characters';
  end if;
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.retire_owner_notification_target: malformed actor';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(ops.owner_target_lock_key(p_tenant_id));
  update ops.owner_notification_targets
     set retired_by = p_actor, retire_reason = p_reason, digits = null
   where tenant_id = p_tenant_id and retired_at is null;
  return found;
end
$function$;
-- ---------------------------------------------------------------------------
-- 2. The notification: its intent and its send, one row. Never a number, a
--    name or a text; the provider's message id only as its digest.
-- ---------------------------------------------------------------------------

create table ops.owner_notifications (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  company_id           uuid not null,
  exception_id         uuid not null,
  conversation_id      uuid not null,
  kind                 text not null,
  follows_review_id    uuid,
  trigger_seq          bigint not null,
  waiting_since        timestamptz not null,
  target_id            uuid not null,
  unit_company_id      uuid not null,
  unit_department_id   uuid not null,
  unit_agent_id        uuid not null,
  job_id               uuid not null references ops.jobs (id) on delete restrict,
  status               text not null default 'pending',
  block_reason         text,
  carried_by           uuid,
  recorded_at          timestamptz not null default now(),
  due_at               timestamptz not null,
  expires_at           timestamptz not null,
  send_channel_id      uuid references ops.communication_channels (id) on delete restrict,
  template_kind        text,
  transport            text,
  job_attempt          integer,
  sending_at           timestamptz,
  settled_at           timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  provider_message_key text,
  error_code           text,
  error_class          text,
  constraint owner_notifications_scope_id_key unique (tenant_id, id),
  constraint owner_notifications_job_key unique (job_id),
  constraint owner_notifications_exception_fkey foreign key (tenant_id, company_id, exception_id)
    references ops.exceptions (tenant_id, company_id, id) on delete cascade,
  constraint owner_notifications_conversation_fkey foreign key (tenant_id, company_id, conversation_id)
    references ops.conversations (tenant_id, company_id, id) on delete cascade,
  constraint owner_notifications_review_fkey foreign key (tenant_id, company_id, follows_review_id)
    references ops.review_items (tenant_id, company_id, id) on delete cascade,
  constraint owner_notifications_target_fkey foreign key (tenant_id, target_id)
    references ops.owner_notification_targets (tenant_id, id) on delete restrict,
  constraint owner_notifications_unit_fkey foreign key (tenant_id, unit_company_id, unit_department_id, unit_agent_id)
    references ops.agents (tenant_id, company_id, department_id, id) on delete restrict,
  constraint owner_notifications_carrier_fkey foreign key (tenant_id, carried_by)
    references ops.owner_notifications (tenant_id, id) on delete cascade,
  constraint owner_notifications_kind_check check (kind in ('person_requested', 'message_waiting')),
  constraint owner_notifications_follows_shape check (kind = 'message_waiting' or follows_review_id is null),
  constraint owner_notifications_status_check check (status in (
    'pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'indeterminate',
    'coalesced', 'carrier_failed', 'skipped_resolved', 'skipped_answered', 'blocked', 'expired')),
  constraint owner_notifications_block_shape check (
        (status = 'blocked') = (block_reason is not null)
    and (block_reason is null or block_reason in ('no_target', 'target_changed', 'channel_not_live', 'job_failed'))),
  constraint owner_notifications_carried_shape check (
        (status in ('coalesced', 'carrier_failed')) = (carried_by is not null)
    and carried_by is distinct from id),
  constraint owner_notifications_send_shape check (
        (status in ('sending', 'sent', 'delivered', 'read', 'failed', 'indeterminate')) = (sending_at is not null)
    and (sending_at is null) = (transport is null)
    and (sending_at is null) = (job_attempt is null)
    and (sending_at is null) = (send_channel_id is null)
    and (sending_at is null) = (template_kind is null)
    and (transport is null or transport in ('meta', 'fake'))
    and (template_kind is null or template_kind in ('episode', 'digest'))
    and (status not in ('sent', 'delivered', 'read') or provider_message_key is not null)),
  constraint owner_notifications_codes check (
        (provider_message_key is null or provider_message_key ~ '^[0-9a-f]{64}$')
    and (error_code is null or error_code ~ '^[0-9]{1,10}$')
    and (error_class is null or error_class ~ '^[a-z][a-z0-9_]{0,63}$')),
  constraint owner_notifications_times check (due_at >= recorded_at and expires_at > recorded_at)
);

comment on table ops.owner_notifications is
  'ADR 0026 §D, SI-86: an owner notification''s intent and its send, one row per intent, recorded with the episode that raised it and carried only by its owner_notification.send job. trigger_seq is an internal copy of events.seq (SI-26), never projected. No number, name or text; the provider''s message id only as its SHA-256 digest.';

-- A conversation's gap between person replies holds one notification that
-- reached the owner or may still reach the owner: blocked, expired, skipped,
-- failed and carrier-failed intents leave the key free for a later message.
create unique index owner_notifications_one_per_reply
  on ops.owner_notifications (tenant_id, exception_id, follows_review_id) nulls not distinct
  where status in ('pending', 'sending', 'sent', 'delivered', 'read', 'indeterminate', 'coalesced');
create index owner_notifications_pending_idx on ops.owner_notifications (tenant_id, due_at) where status = 'pending';
create index owner_notifications_sending_idx on ops.owner_notifications (tenant_id, sending_at) where sending_at is not null;
create unique index owner_notifications_provider_key
  on ops.owner_notifications (send_channel_id, provider_message_key) where provider_message_key is not null;
create index owner_notifications_conversation_idx on ops.owner_notifications (tenant_id, conversation_id);
create index owner_notifications_exception_idx on ops.owner_notifications (tenant_id, exception_id);
create index owner_notifications_carrier_idx on ops.owner_notifications (tenant_id, carried_by) where carried_by is not null;

-- Born pending, for an open episode of its kind, the target in force, the
-- target channel's unit and its own queued job; then only the edges below.
-- It leaves only with its episode, conversation or reply (a cascade).
create function ops.guard_owner_notification()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  c_mutable constant text[] := array['status', 'block_reason', 'carried_by', 'send_channel_id', 'template_kind',
                                     'transport', 'job_attempt', 'sending_at', 'settled_at', 'delivered_at',
                                     'read_at', 'provider_message_key', 'error_code', 'error_class'];
  v_target  ops.owner_notification_targets;
  v_carrier ops.owner_notifications;
  v_rank_old integer;
  v_rank_new integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.block_reason is not null or new.carried_by is not null
       or new.send_channel_id is not null or new.template_kind is not null or new.transport is not null
       or new.job_attempt is not null or new.sending_at is not null or new.settled_at is not null
       or new.delivered_at is not null or new.read_at is not null or new.provider_message_key is not null
       or new.error_code is not null or new.error_class is not null then
      raise exception using errcode = 'OS403', message = 'ops.owner_notifications: a notification is recorded pending';
    end if;
    new.recorded_at := now();
    new.expires_at := now() + interval '24 hours';
    if new.due_at < now() then
      raise exception using errcode = 'OS403', message = 'ops.owner_notifications: a notification is due from now on';
    end if;
    if not exists (select 1 from ops.exceptions e
                    where e.tenant_id = new.tenant_id and e.company_id = new.company_id and e.id = new.exception_id
                      and e.conversation_id = new.conversation_id and e.kind = new.kind and e.resolved_at is null) then
      raise exception using errcode = 'OS403', message = 'ops.owner_notifications: a notification follows an open episode of its kind';
    end if;
    select t.* into v_target from ops.owner_notification_targets t
     where t.tenant_id = new.tenant_id and t.id = new.target_id and t.retired_at is null;
    if not found or not exists (select 1 from ops.communication_channels c
                                 where c.tenant_id = v_target.tenant_id and c.id = v_target.channel_id
                                   and c.company_id = new.unit_company_id and c.agent_id = new.unit_agent_id) then
      raise exception using errcode = 'OS403',
        message = 'ops.owner_notifications: a notification names the target in force and its channel''s unit';
    end if;
    if not exists (select 1 from ops.jobs j
                    where j.id = new.job_id and j.tenant_id = new.tenant_id and j.kind = 'owner_notification.send'
                      and j.status = 'queued' and j.payload ->> 'owner_notification_id' = new.id::text) then
      raise exception using errcode = 'OS403', message = 'ops.owner_notifications: a notification is carried by its own job';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if pg_catalog.pg_trigger_depth() < 2 then
      raise exception using errcode = 'OS403', message = 'ops.owner_notifications: a notification leaves only with its episode';
    end if;
    return old;
  end if;

  if (to_jsonb(new) - c_mutable) is distinct from (to_jsonb(old) - c_mutable) then
    raise exception using errcode = 'OS403', message = 'ops.owner_notifications: a notification''s identity is immutable';
  end if;
  if new.status = old.status then
    -- A provider's later news of the same state (a delivered timestamp) only.
    if new.status in ('sent', 'delivered', 'read', 'failed', 'indeterminate')
       and (to_jsonb(new) - array['settled_at', 'delivered_at', 'read_at', 'provider_message_key', 'error_code', 'error_class'])
           is not distinct from (to_jsonb(old) - array['settled_at', 'delivered_at', 'read_at', 'provider_message_key', 'error_code', 'error_class']) then
      return new;
    end if;
    raise exception using errcode = 'OS403', message = 'ops.owner_notifications: that change is not a notification''s';
  end if;

  if old.status = 'pending' and new.status = 'sending' then
    select t.* into v_target from ops.owner_notification_targets t
     where t.tenant_id = new.tenant_id and t.id = new.target_id and t.retired_at is null;
    if not found or new.send_channel_id is distinct from v_target.channel_id
       or not exists (select 1 from ops.communication_channels c
                       where c.id = new.send_channel_id and c.tenant_id = new.tenant_id
                         and c.active and c.mode = 'test') then
      raise exception using errcode = 'OS403',
        message = 'ops.owner_notifications: a notification is sent from its target''s active test channel only';
    end if;
    new.sending_at := now();
    return new;
  end if;
  if old.status = 'pending' and new.status = 'coalesced' then
    select n.* into v_carrier from ops.owner_notifications n
     where n.tenant_id = new.tenant_id and n.id = new.carried_by;
    if not found or v_carrier.status <> 'sending' or v_carrier.sending_at <> now()
       or v_carrier.target_id <> new.target_id then
      raise exception using errcode = 'OS403',
        message = 'ops.owner_notifications: a notification is coalesced only into a send of its target begun now';
    end if;
    return new;
  end if;
  if old.status = 'pending' and new.status in ('skipped_resolved', 'skipped_answered', 'expired', 'blocked') then
    new.settled_at := now();
    return new;
  end if;
  if old.status = 'coalesced' and new.status = 'carrier_failed' then
    if not exists (select 1 from ops.owner_notifications n
                    where n.tenant_id = new.tenant_id and n.id = new.carried_by and n.status = 'failed') then
      raise exception using errcode = 'OS403', message = 'ops.owner_notifications: only a failed carrier fails what it carried';
    end if;
    new.settled_at := now();
    return new;
  end if;
  if old.status = 'sending' and new.status in ('sent', 'failed', 'indeterminate') then
    new.settled_at := coalesce(new.settled_at, now());
    return new;
  end if;
  -- A provider's status: a failure, or a delivery state above the one recorded.
  v_rank_old := case old.status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  v_rank_new := case new.status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  if new.status = 'failed' and old.status in ('indeterminate', 'sent') then
    return new;
  end if;
  if v_rank_new > 0 and old.status in ('indeterminate', 'sent', 'delivered') and v_rank_new > v_rank_old then
    return new;
  end if;
  if old.status = 'failed' and new.status in ('delivered', 'read') then
    return new;
  end if;
  raise exception using errcode = 'OS403', message = 'ops.owner_notifications: that change is not a notification''s';
end
$function$;

create trigger owner_notifications_guard
  before insert or update or delete on ops.owner_notifications
  for each row execute function ops.guard_owner_notification();
alter table ops.owner_notifications enable always trigger owner_notifications_guard;

create function ops.refuse_owner_notification_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.owner_notifications: the notifications are never truncated';
end
$function$;

create trigger owner_notifications_refuse_truncate
  before truncate on ops.owner_notifications
  for each statement execute function ops.refuse_owner_notification_truncate();
alter table ops.owner_notifications enable always trigger owner_notifications_refuse_truncate;

alter table ops.owner_notifications enable row level security;
alter table ops.owner_notifications force row level security;

-- ---------------------------------------------------------------------------
-- 3. When the owner is told: the helpers, the first name, the intent, and
--    ops.open_exception, which records it. None is granted to any role.
-- ---------------------------------------------------------------------------

-- Serializes a tenant's notification sends (one digest at a time) and fixes
-- their lock order: this key first, then the rows.
create function ops.owner_notification_lock_key(p_tenant_id uuid)
returns bigint
language sql
immutable
security invoker
set search_path to ''
as $function$
  select ('x' || substr(md5('owner_notification:' || p_tenant_id::text), 1, 16))::bit(64)::bigint;
$function$;

-- The intent statuses that reached the owner or may still reach the owner.
-- A coalesced intent is carried by a send that may still reach the owner: a
-- failed carrier fails what it carried (carrier_failed).
create function ops.owner_notification_live_statuses()
returns text[]
language sql
immutable
security invoker
set search_path to ''
as $function$
  select array['pending', 'sending', 'sent', 'delivered', 'read', 'indeterminate', 'coalesced']::text[];
$function$;

-- Whether an instant falls in the target's quiet hours, a window [start, end)
-- in its own time zone that may wrap midnight.
create function ops.owner_notification_quiet(p_target ops.owner_notification_targets, p_at timestamptz)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select case
    when p_target.quiet_start > p_target.quiet_end then
         (p_at at time zone p_target.time_zone)::time >= p_target.quiet_start
      or (p_at at time zone p_target.time_zone)::time < p_target.quiet_end
    else (p_at at time zone p_target.time_zone)::time >= p_target.quiet_start
     and (p_at at time zone p_target.time_zone)::time < p_target.quiet_end
  end;
$function$;

-- The next end of the target's quiet hours after an instant.
create function ops.owner_notification_quiet_end(p_target ops.owner_notification_targets, p_at timestamptz)
returns timestamptz
language sql
stable
security invoker
set search_path to ''
as $function$
  select case
    when (((p_at at time zone p_target.time_zone)::date + p_target.quiet_end) at time zone p_target.time_zone) > p_at
      then ((p_at at time zone p_target.time_zone)::date + p_target.quiet_end) at time zone p_target.time_zone
    else (((p_at at time zone p_target.time_zone)::date + 1) + p_target.quiet_end) at time zone p_target.time_zone
  end;
$function$;

-- When a notification may leave: the instant itself, or the end of the quiet
-- hours it falls in.
create function ops.owner_notification_due_at(p_target ops.owner_notification_targets, p_at timestamptz)
returns timestamptz
language sql
stable
security invoker
set search_path to ''
as $function$
  select case when ops.owner_notification_quiet(p_target, p_at)
              then ops.owner_notification_quiet_end(p_target, p_at) else p_at end;
$function$;

-- The conversation's newest reply a person wrote, and the order of its
-- review_pending event. Both that event and a message's admission are
-- recorded while holding the conversation's row, so their events' order is
-- the order the facts happened in (SI-26: the order stays internal).
create function ops.owner_notification_last_reply(
  p_tenant_id uuid, p_conversation_id uuid, out review_id uuid, out reply_seq bigint)
language sql
stable
security invoker
set search_path to ''
as $function$
  select ri.id, e.seq
    from ops.review_items ri
    join ops.inbound_messages rm on rm.tenant_id = ri.tenant_id and rm.task_id = ri.task_id
    join ops.events e on e.tenant_id = ri.tenant_id and e.idempotency_key = format('review:%s:pending', ri.id)
   where ri.tenant_id = p_tenant_id and rm.conversation_id = p_conversation_id and ri.author = 'person'
   order by e.seq desc
   limit 1;
$function$;

-- A CRM contact's stored first name: the read-only CRM adapter, for the tenant
-- that owns the local CRM only, as ops.crm_contact_is_client. It reaches no
-- browser and no event: only the worker's send request (SI-48).
create function ops.crm_contact_first_name(p_tenant_id uuid, p_crm_contact_ref text)
returns text
language plpgsql
stable
security invoker
set search_path to ''
as $function$
begin
  if not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return null;
  end if;
  if p_crm_contact_ref is null or p_crm_contact_ref !~ '^crm:contact:[0-9]{1,18}$' then
    return null;
  end if;
  return (select c.first_name from public.contacts c where c.id = substr(p_crm_contact_ref, 13)::bigint);
end
$function$;

-- The one word the owner's notification names a conversation by: the first
-- word of the CRM contact's first name, letters only, at most 20; for test or
-- synthetic data only; otherwise the target's fallback.
create function ops.owner_notification_first_word(p_tenant_id uuid, p_conversation_id uuid, p_fallback text)
returns text
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_ref   text;
  v_class text;
  v_res   text;
  v_name  text;
  v_word  text;
begin
  select m.crm_contact_ref, t.data_class, m.contact_resolution into v_ref, v_class, v_res
    from ops.inbound_messages m
    join ops.tasks t on t.tenant_id = m.tenant_id and t.id = m.task_id
   where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id
   order by m.received_at desc, m.created_at desc
   limit 1;
  if v_class is null or v_class not in ('synthetic', 'test') or v_res is distinct from 'found' then
    return p_fallback;
  end if;
  v_name := ops.crm_contact_first_name(p_tenant_id, v_ref);
  v_word := left(regexp_replace(coalesce(substring(btrim(coalesce(v_name, '')) from '^(\S+)'), ''),
                                '[^[:alpha:]]', '', 'g'), 20);
  return coalesce(nullif(v_word, ''), p_fallback);
end
$function$;

-- Records the owner's notification for an episode that may tell the owner,
-- with its own queued job; answers what it did. It never raises for a
-- business reason (ADR 0026 §D):
--   not_notifying  not a request for a person or a message waiting for one;
--   no_target      no target in force; kind_not_listed: the target leaves it out;
--   not_eligible   not the leased run's own screened message, nor a refused one;
--   crisis         the screening classed the message as danger;
--   answered       a person replied after this message;
--   already_told   the conversation already has a live notification since the
--                  person's latest reply;
--   exists         this episode's notification for that reply exists;
--   recorded.
create function ops.record_owner_notification_intent(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_exception_id    uuid,
  p_kind            text,
  p_conversation_id uuid,
  p_task_id         uuid)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_target    ops.owner_notification_targets;
  v_job_id    uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run       ops.agent_runs;
  v_safety    text;
  v_trigger   bigint;
  v_since     timestamptz;
  v_reply     uuid;
  v_reply_seq bigint;
  v_follows   uuid;
  v_agent     ops.agents;
  v_due       timestamptz;
  v_id        uuid := gen_random_uuid();
  v_job       uuid;
begin
  if p_kind is null or p_kind not in ('person_requested', 'message_waiting') or p_conversation_id is null
     or p_exception_id is null then
    return 'not_notifying';
  end if;
  select t.* into v_target from ops.owner_notification_targets t
   where t.tenant_id = p_tenant_id and t.retired_at is null;
  if not found then
    return 'no_target';
  end if;
  if not (p_kind = any (v_target.kinds)) then
    return 'kind_not_listed';
  end if;

  -- The message that waits, and the order of its admission.
  if v_job_id is not null and ops.current_tenant_id() is not distinct from p_tenant_id then
    -- The screening: the leased run's own message, screened, not danger.
    select r.* into v_run from ops.agent_runs r where r.tenant_id = p_tenant_id and r.job_id = v_job_id;
    if not found or v_run.task_id is distinct from p_task_id then
      return 'not_eligible';
    end if;
    select s.safety_class into v_safety from ops.inbound_screenings s
     where s.tenant_id = p_tenant_id and s.agent_run_id = v_run.id;
    if not found then
      return 'not_eligible';
    end if;
    if v_safety = 'crisis' then
      return 'crisis';
    end if;
    select e.seq into v_trigger from ops.events e
     where e.tenant_id = p_tenant_id and e.type = 'lead_triage.admitted'
       and e.subject_type = 'task' and e.subject_id = p_task_id
     order by e.seq desc limit 1;
    select least(m.received_at, m.created_at) into v_since from ops.inbound_messages m
     where m.tenant_id = p_tenant_id and m.task_id = p_task_id and m.conversation_id = p_conversation_id
     order by m.received_at desc limit 1;
  elsif v_job_id is null then
    -- The gateway: a message refused on the record in the conversation, just
    -- recorded while the gateway holds the conversation's row.
    select e.seq into v_trigger from ops.events e
     where e.tenant_id = p_tenant_id and e.type = 'communication.inbound_refused'
       and e.payload ->> 'conversation_id' = p_conversation_id::text
     order by e.seq desc limit 1;
    v_since := now();
  end if;
  if v_trigger is null or v_since is null then
    return 'not_eligible';
  end if;

  select l.review_id, l.reply_seq into v_reply, v_reply_seq
    from ops.owner_notification_last_reply(p_tenant_id, p_conversation_id) l;
  if v_reply_seq is not null and v_reply_seq > v_trigger then
    return 'answered';
  end if;
  if exists (select 1 from ops.owner_notifications n
               join ops.exceptions e on e.tenant_id = n.tenant_id and e.id = n.exception_id
              where n.tenant_id = p_tenant_id and n.conversation_id = p_conversation_id
                and e.resolved_at is null and e.kind in ('person_requested', 'message_waiting')
                and n.status = any (ops.owner_notification_live_statuses())
                and n.trigger_seq > coalesce(v_reply_seq, 0)) then
    return 'already_told';
  end if;
  v_follows := case when p_kind = 'message_waiting' then v_reply end;
  if exists (select 1 from ops.owner_notifications n
              where n.tenant_id = p_tenant_id and n.exception_id = p_exception_id
                and n.follows_review_id is not distinct from v_follows
                and n.status = any (ops.owner_notification_live_statuses())) then
    return 'exists';
  end if;

  -- The unit whose channel sends it, fixed now (SI-37).
  select a.* into v_agent from ops.agents a
    join ops.communication_channels c on c.tenant_id = a.tenant_id and c.company_id = a.company_id and c.agent_id = a.id
   where c.tenant_id = p_tenant_id and c.id = v_target.channel_id;
  v_due := ops.owner_notification_due_at(v_target, now() + interval '60 seconds');
  v_job := ops.enqueue_job(p_tenant_id, 'owner_notification.send', jsonb_build_object('owner_notification_id', v_id),
                           100, v_due, 5, format('owner_notification:%s', v_id));
  insert into ops.owner_notifications (
    id, tenant_id, company_id, exception_id, conversation_id, kind, follows_review_id, trigger_seq,
    waiting_since, target_id, unit_company_id, unit_department_id, unit_agent_id, job_id, due_at, expires_at)
  values (
    v_id, p_tenant_id, p_company_id, p_exception_id, p_conversation_id, p_kind, v_follows, v_trigger,
    v_since, v_target.id, v_agent.company_id, v_agent.department_id, v_agent.id, v_job, v_due,
    now() + interval '24 hours');
  return 'recorded';
end
$function$;

-- As 20261018120000, with the owner's notification recorded after the episode
-- is opened or counted on (ADR 0026 §D, SI-86).
create or replace function ops.open_exception(
  p_tenant_id           uuid,
  p_company_id          uuid,
  p_task_id             uuid,
  p_kind                text,
  p_conversation_id     uuid,
  p_outbound_message_id uuid,
  p_detail              text,
  p_actor               text)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id       uuid;
  v_count    integer;
  v_priority text;
  v_subject  text;
  v_lock     text;
begin
  v_priority := case
    when p_kind in ('person_requested', 'configuration_missing', 'contact_unresolved', 'send_indeterminate',
                    'send_blocked') then 'high'
    else 'normal' end;
  v_subject := case when p_outbound_message_id is null then 'conversation' else 'outbound_message' end;
  insert into ops.exceptions (
    tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
    conversation_id, outbound_message_id, detail, raised_by)
  values (
    p_tenant_id, p_company_id, p_task_id, p_kind, v_priority, v_subject,
    coalesce(p_outbound_message_id, p_conversation_id), p_conversation_id, p_outbound_message_id, p_detail, p_actor)
  on conflict (tenant_id, subject_id, kind) where resolved_at is null
  do update set occurrences = ops.exceptions.occurrences + 1, last_task_id = excluded.task_id
  returning id, occurrences into v_id, v_count;
  -- ADR 0026 §D (SI-86): a request for a person or a message waiting for one
  -- may tell the owner. Recorded here, never a call; isolated, with a short
  -- lock wait, so an admission or a screening never depends on it.
  if p_kind in ('person_requested', 'message_waiting') then
    v_lock := current_setting('lock_timeout');
    begin
      perform set_config('lock_timeout', '500ms', true);
      perform ops.record_owner_notification_intent(p_tenant_id, p_company_id, v_id, p_kind, p_conversation_id, p_task_id);
      perform set_config('lock_timeout', v_lock, true);
    exception when others then
      raise warning 'owner notification intent not recorded (%)', sqlstate;
    end;
  end if;
  if v_count > 1 then
    return null;
  end if;
  perform ops.record_event(
    p_tenant_id, p_company_id, 'exception.raised', 'exception-queue', 'task', p_task_id,
    jsonb_strip_nulls(jsonb_build_object(
      'exception_id', v_id, 'kind', p_kind, 'priority', v_priority, 'subject_kind', v_subject, 'detail', p_detail)),
    null, null, format('exception:%s:raised', v_id));
  return v_id;
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. The send: the worker's three capabilities (begin, settle, the reaper)
--    and their helpers, none of which is granted.
-- ---------------------------------------------------------------------------

-- Gives the job back to the queue until an exact instant, the attempt with it:
-- quiet hours, a cap and a worker without a transport each wait, never fail.
create function ops.release_owner_notification_job(p_job ops.jobs, p_until timestamptz, p_detail text)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  update ops.jobs
     set status = 'queued',
         lease_owner = null,
         leased_at = null,
         lease_expires_at = null,
         attempts = greatest(attempts - 1, 0),
         available_at = greatest(p_until, now()),
         updated_at = now()
   where id = p_job.id;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (p_job.id, p_job.tenant_id, 'deferred', p_job.lease_owner, p_job.attempts, p_detail);
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
end
$function$;

-- When the target's caps free a send again: null while under both the hourly
-- and the daily cap. Counts sends, never the intents they carried.
create function ops.owner_notification_cap_frees_at(p_tenant_id uuid, p_target ops.owner_notification_targets)
returns timestamptz
language sql
stable
security invoker
set search_path to ''
as $function$
  select greatest(
    (select n.sending_at + interval '1 hour' from ops.owner_notifications n
      where n.tenant_id = p_tenant_id and n.sending_at > now() - interval '1 hour'
      order by n.sending_at desc offset p_target.hourly_cap - 1 limit 1),
    (select n.sending_at + interval '24 hours' from ops.owner_notifications n
      where n.tenant_id = p_tenant_id and n.sending_at > now() - interval '24 hours'
      order by n.sending_at desc offset p_target.daily_cap - 1 limit 1));
$function$;

-- A send that failed fails the intents it carried: their gaps are free again,
-- so a later message may tell the owner.
create function ops.fail_owner_notifications_carried(p_carrier ops.owner_notifications)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_count integer;
begin
  update ops.owner_notifications
     set status = 'carrier_failed'
   where tenant_id = p_carrier.tenant_id and carried_by = p_carrier.id and status = 'coalesced';
  get diagnostics v_count = row_count;
  return v_count;
end
$function$;

-- Blocks one pending intent on the record: it never leaves.
create function ops.block_owner_notification(p_note ops.owner_notifications, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  update ops.owner_notifications set status = 'blocked', block_reason = p_reason where id = p_note.id;
  return jsonb_build_object('action', 'settled', 'status', 'blocked', 'ownerNotificationId', p_note.id);
end
$function$;

-- TX2a. Answers, for the notification the lease is bound to:
--   {action: settled, ...}  nothing to call (settled, carried by another send,
--                           set aside, blocked, expired, or an earlier
--                           attempt's send recorded indeterminate);
--   {action: stopped}       an execution stop covers it: held, nothing recorded;
--   {action: released}      it waits (quiet hours, a cap, no transport here);
--   {action: start, ...}    sending is recorded, with every due intent of the
--                           same target coalesced into it; call exactly once.
-- The owner's number and the contact's first word leave only in the start
-- answer, into the handler's memory (SI-86).
create function ops.begin_owner_notification(p_transport text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job     ops.jobs := ops.leased_job();
  v_own     ops.owner_notifications;
  v_target  ops.owner_notification_targets;
  v_channel ops.communication_channels;
  v_until   timestamptz;
  v_batch   uuid[];
  v_convs   uuid[];
  v_kind    text;
  v_name    text;
  v_params  text[];
begin
  if v_job.kind <> 'owner_notification.send' then
    raise exception using errcode = '42501', message = 'ops.begin_owner_notification: the leased job is not an owner notification';
  end if;
  -- The tenant's sends one at a time, and this lock before any row.
  perform pg_advisory_xact_lock(ops.owner_notification_lock_key(v_job.tenant_id));
  select n.* into v_own from ops.owner_notifications n
   where n.tenant_id = v_job.tenant_id and n.job_id = v_job.id
     for update;
  if not found then
    raise exception using errcode = '42501', message = 'ops.begin_owner_notification: no notification is bound to the leased job';
  end if;

  if v_own.status = 'sending' then
    if v_own.job_attempt is not distinct from v_job.attempts then
      raise exception using errcode = '42501', message = 'ops.begin_owner_notification: this attempt already began the send; a send is never made twice';
    end if;
    -- An earlier attempt began the call and never settled it: it may have
    -- reached the owner. Never called again.
    update ops.owner_notifications
       set status = 'indeterminate', error_class = 'execution_interrupted'
     where id = v_own.id;
    return jsonb_build_object('action', 'settled', 'status', 'indeterminate', 'ownerNotificationId', v_own.id);
  end if;
  if v_own.status <> 'pending' then
    return jsonb_build_object('action', 'settled', 'status', v_own.status, 'ownerNotificationId', v_own.id);
  end if;

  -- The kill switch, for every scope of the unit whose channel sends it (SI-37).
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind) is not null then
    return jsonb_build_object('action', 'stopped', 'ownerNotificationId', v_own.id);
  end if;

  if now() >= v_own.expires_at then
    update ops.owner_notifications set status = 'expired' where id = v_own.id;
    return jsonb_build_object('action', 'settled', 'status', 'expired', 'ownerNotificationId', v_own.id);
  end if;
  -- Sent only to the target it was recorded for, from its channel.
  select t.* into v_target from ops.owner_notification_targets t
   where t.tenant_id = v_own.tenant_id and t.id = v_own.target_id and t.retired_at is null;
  if not found then
    return ops.block_owner_notification(v_own,
      case when exists (select 1 from ops.owner_notification_targets t
                         where t.tenant_id = v_own.tenant_id and t.retired_at is null)
           then 'target_changed' else 'no_target' end);
  end if;
  select c.* into v_channel from ops.communication_channels c
   where c.tenant_id = v_target.tenant_id and c.id = v_target.channel_id;
  if not (v_channel.active and v_channel.mode = 'test') then
    return ops.block_owner_notification(v_own, 'channel_not_live');
  end if;

  -- It waits: quiet hours, then the caps, then a worker with a transport.
  if ops.owner_notification_quiet(v_target, now()) then
    perform ops.release_owner_notification_job(v_job, ops.owner_notification_quiet_end(v_target, now()),
                                               'waiting for the end of the quiet hours');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end if;
  v_until := ops.owner_notification_cap_frees_at(v_own.tenant_id, v_target);
  if v_until is not null then
    perform ops.release_owner_notification_job(v_job, ops.owner_notification_due_at(v_target, v_until),
                                               'waiting for the notification cap');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end if;
  if p_transport is null or p_transport not in ('meta', 'fake') then
    perform ops.release_owner_notification_job(v_job, least(now() + interval '30 seconds', v_own.expires_at),
                                               'waiting for a worker with a reply transport');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end if;

  -- The batch: this intent and every due one of the same target, in the order
  -- they were recorded, then their episodes, so that a release committing
  -- meanwhile is seen.
  select pg_catalog.array_agg(b.id order by b.recorded_at, b.id) into v_batch
    from (select n.id, n.recorded_at from ops.owner_notifications n
           where n.tenant_id = v_own.tenant_id and n.target_id = v_own.target_id and n.status = 'pending'
             and (n.id = v_own.id or n.due_at <= now())
           order by n.recorded_at, n.id
             for update) b;
  perform 1 from ops.exceptions e
   where e.tenant_id = v_own.tenant_id
     and e.id in (select n.exception_id from ops.owner_notifications n where n.id = any (v_batch))
   order by e.id
     for share;
  update ops.owner_notifications n set status = 'expired'
   where n.id = any (v_batch) and n.status = 'pending' and n.expires_at <= now();
  update ops.owner_notifications n set status = 'skipped_resolved'
   where n.id = any (v_batch) and n.status = 'pending'
     and exists (select 1 from ops.exceptions e
                  where e.tenant_id = n.tenant_id and e.id = n.exception_id and e.resolved_at is not null);
  update ops.owner_notifications n set status = 'skipped_answered'
   where n.id = any (v_batch) and n.status = 'pending'
     and (select l.reply_seq from ops.owner_notification_last_reply(n.tenant_id, n.conversation_id) l) > n.trigger_seq;

  select n.* into v_own from ops.owner_notifications n where n.id = v_own.id;
  if v_own.status <> 'pending' then
    return jsonb_build_object('action', 'settled', 'status', v_own.status, 'ownerNotificationId', v_own.id);
  end if;
  select pg_catalog.array_agg(n.id order by n.recorded_at, n.id) into v_batch
    from ops.owner_notifications n where n.id = any (v_batch) and n.status = 'pending';
  select pg_catalog.array_agg(distinct n.conversation_id) into v_convs
    from ops.owner_notifications n where n.id = any (v_batch);

  -- One conversation: its first word and since when it waits. Several: how
  -- many conversations wait now.
  if pg_catalog.cardinality(v_convs) = 1 then
    v_kind := 'episode';
    v_name := ops.owner_notification_first_word(v_own.tenant_id, v_convs[1], v_target.name_fallback);
    v_params := array[
      v_name,
      to_char((select pg_catalog.min(n.waiting_since) from ops.owner_notifications n where n.id = any (v_batch))
                at time zone v_target.time_zone, 'HH24:MI')];
  else
    v_kind := 'digest';
    v_params := array[(select pg_catalog.count(distinct e.conversation_id)::text
                         from ops.exceptions e
                        where e.tenant_id = v_own.tenant_id and e.resolved_at is null
                          and e.kind in ('person_requested', 'message_waiting'))];
  end if;

  update ops.owner_notifications
     set status = 'sending', transport = p_transport, job_attempt = v_job.attempts,
         send_channel_id = v_target.channel_id, template_kind = v_kind
   where id = v_own.id;
  update ops.owner_notifications
     set status = 'coalesced', carried_by = v_own.id
   where id = any (v_batch) and id <> v_own.id;
  return jsonb_build_object(
    'action', 'start',
    'ownerNotificationId', v_own.id,
    'request', jsonb_build_object(
      'providerTarget', v_channel.provider_target,
      'to', v_target.digits,
      'templateName', case when v_kind = 'episode' then v_target.episode_template else v_target.digest_template end,
      'languageCode', v_target.template_language,
      'parameters', to_jsonb(v_params)));
end
$function$;

-- TX2b, after the call: the outcome of the attempt that began the send. The
-- provider's message id is kept only as its digest (it names the recipient).
-- No event and no exception: a notification's outcome tells no one.
create function ops.settle_owner_notification(
  p_outcome text, p_provider_message_id text, p_error_code text, p_error_class text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job  ops.jobs := ops.leased_job();
  v_note ops.owner_notifications;
begin
  if v_job.kind <> 'owner_notification.send' then
    raise exception using errcode = '42501', message = 'ops.settle_owner_notification: the leased job is not an owner notification';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'indeterminate') then
    raise exception using errcode = 'OS400', message = 'ops.settle_owner_notification: unknown outcome';
  end if;
  if p_outcome = 'sent' and (p_provider_message_id is null or p_provider_message_id !~ '^[\x21-\x7e]{1,200}$') then
    raise exception using errcode = 'OS400', message = 'ops.settle_owner_notification: a sent notification needs its provider id';
  end if;
  perform pg_advisory_xact_lock(ops.owner_notification_lock_key(v_job.tenant_id));
  select n.* into v_note from ops.owner_notifications n
   where n.tenant_id = v_job.tenant_id and n.job_id = v_job.id
     for update;
  if not found or v_note.status <> 'sending' or v_note.job_attempt is distinct from v_job.attempts then
    return 'not_sending';
  end if;
  update ops.owner_notifications
     set status               = p_outcome,
         provider_message_key = case when p_outcome = 'sent'
                                     then encode(sha256(convert_to(p_provider_message_id, 'UTF8')), 'hex') end,
         error_code           = case when p_outcome = 'sent' then null
                                     else nullif(substring(coalesce(p_error_code, '') from '^[0-9]{1,10}$'), '') end,
         error_class          = case when p_outcome = 'sent' then null
                                     else nullif(substring(coalesce(p_error_class, '') from '^[a-z][a-z0-9_]{0,63}$'), '') end
   where id = v_note.id
  returning * into v_note;
  if p_outcome = 'failed' then
    perform ops.fail_owner_notifications_carried(v_note);
  end if;
  return p_outcome;
end
$function$;

-- The worker's reaper tick: a notification whose job ended without settling
-- it is settled on the record, never sent. Pending: blocked job_failed.
-- Sending, with no live lease of the attempt that began it: indeterminate,
-- never called again. At most 500 a tick; a row a transaction holds is left
-- to its own act.
create function ops.settle_stale_owner_notifications()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row     record;
  v_settled integer := 0;
begin
  for v_row in
    select n.id, n.status
      from ops.owner_notifications n
      join ops.jobs j on j.id = n.job_id and j.tenant_id = n.tenant_id
     where j.status in ('failed', 'succeeded')
       and n.status in ('pending', 'sending')
     order by n.recorded_at, n.id
     limit 500
       for update of n skip locked
  loop
    if v_row.status = 'pending' then
      update ops.owner_notifications set status = 'blocked', block_reason = 'job_failed' where id = v_row.id;
    else
      update ops.owner_notifications
         set status = 'indeterminate', error_class = 'execution_interrupted'
       where id = v_row.id;
    end if;
    v_settled := v_settled + 1;
  end loop;
  return v_settled;
end
$function$;

-- A provider status for a notification, as ops.receive_whatsapp_status ranks
-- one for a reply; no event and no exception. A failure fails what it carried.
create function ops.apply_owner_notification_status(
  p_note ops.owner_notifications, p_status text, p_status_at timestamptz, p_provider_message_id text,
  p_error_code text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_rank    integer;
  v_current integer;
  v_next    text;
begin
  v_rank := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else null end;
  v_current := case p_note.status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  if p_status = 'failed' then
    if p_note.status not in ('indeterminate', 'sent') then
      return jsonb_build_object('state', 'ignored', 'status', p_note.status);
    end if;
    v_next := 'failed';
  elsif v_rank is null then
    return jsonb_build_object('state', 'unsupported');
  elsif p_note.status = 'failed' and v_rank >= 2 then
    v_next := p_status;
  elsif p_note.status not in ('indeterminate', 'sent', 'delivered') or v_rank <= v_current then
    return jsonb_build_object('state', 'ignored', 'status', p_note.status);
  else
    v_next := p_status;
  end if;
  update ops.owner_notifications
     set status               = v_next,
         provider_message_key = coalesce(provider_message_key,
                                         encode(sha256(convert_to(p_provider_message_id, 'UTF8')), 'hex')),
         settled_at           = coalesce(settled_at, now()),
         delivered_at         = case when v_next in ('delivered', 'read')
                                     then coalesce(delivered_at, p_status_at, now()) else delivered_at end,
         read_at              = case when v_next = 'read' then coalesce(read_at, p_status_at, now()) else read_at end,
         error_code           = case when v_next = 'failed'
                                     then nullif(substring(coalesce(p_error_code, '') from '^[0-9]{1,10}$'), '')
                                     when v_next in ('delivered', 'read') then null
                                     else error_code end,
         error_class          = case when v_next = 'failed' then 'provider_status_failed'
                                     when v_next in ('delivered', 'read') then null
                                     else error_class end
   where id = p_note.id;
  if v_next = 'failed' then
    perform ops.fail_owner_notifications_carried(p_note);
  end if;
  return jsonb_build_object('state', 'updated', 'status', v_next, 'previous', p_note.status);
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. The job kind: external, so the kill switch holds it, and held by the
--    stops of the unit whose channel sends it. Each as 20261018120000, with
--    the new kind.
-- ---------------------------------------------------------------------------

create or replace function ops.external_job_kinds()
returns text[]
language sql immutable set search_path = '' as $$
  select array['agent_run.execute', 'decision.shadow_evaluate',
               'calendar.create', 'calendar.update', 'calendar.cancel',
               'decision.structured_evaluate', 'outbound.reply_send',
               'owner_notification.send']::text[];
$$;

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
  if p_job_kind = 'outbound.reply_send' then
    -- ADR 0026 §B: held by the stops of the unit whose run drafted the text,
    -- fixed when the run was requested (SI-37).
    select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
      from ops.outbound_messages o
      join ops.review_items ri on ri.tenant_id = o.tenant_id and ri.id = o.review_item_id
      join ops.agent_runs r on r.tenant_id = ri.tenant_id and r.id = ri.agent_run_id
     where o.tenant_id = p_tenant_id and o.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  if p_job_kind = 'owner_notification.send' then
    -- ADR 0026 §D: held by the stops of the unit whose channel sends it, fixed
    -- when the intent was recorded (SI-37).
    select n.unit_company_id, n.unit_department_id, n.unit_agent_id into v_company, v_department, v_agent
      from ops.owner_notifications n
     where n.tenant_id = p_tenant_id and n.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  if p_job_kind = 'decision.structured_evaluate' then
    -- Held by the stops of the unit whose run it describes.
    select d.company_id, d.department_id, d.agent_id into v_company, v_department, v_agent
      from ops.structured_decisions d
     where d.tenant_id = p_tenant_id and d.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.job_id = p_job_id;
  if not found then
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
-- 6. The gateway. The entry point as 20261019120000, with the owner's number
--    recognised before any conversation is written.
-- ---------------------------------------------------------------------------

create or replace function ops.receive_whatsapp_message(
  p_provider_target     text,
  p_external_message_id text,
  p_from                text,
  p_body                text,
  p_received_at         timestamptz,
  p_profile_first_name  text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_channel     ops.communication_channels;
  v_crm         jsonb;
  v_dnc         boolean;
  v_conv        uuid;
  v_received_at timestamptz;
  v_reason      text;
  v_result      jsonb;
  v_prior       ops.inbound_messages;
  v_refused     jsonb;
  v_waiting     uuid;
  v_holder      text;
  v_lead        text;
  v_refusal_key text;
begin
  -- A malformed target or message id cannot be tied to any tenant or keyed
  -- once: a typed refusal. The gateway's parser never produces one.
  if p_provider_target is null or p_provider_target !~ '^[0-9]{1,32}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed provider target';
  end if;
  if p_external_message_id is null or p_external_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed message id';
  end if;
  -- The sender may be absent (a WhatsApp user known only by username); if
  -- present it is digits with the country code.
  if p_from is not null and p_from !~ '^[0-9]{6,20}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed sender id';
  end if;
  if p_received_at is null then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: received_at is missing';
  end if;
  v_refusal_key := format('whatsapp:refused:%s', encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex'));

  -- The TRUSTED mapping, and the closed real-data gate. Nothing in the payload
  -- names a tenant, a channel or a mode. A message that is not for a live test
  -- channel is not ours to acknowledge: the gateway answers it with a non-2xx
  -- and stores nothing.
  select * into v_channel from ops.communication_channels c
   where c.provider = 'meta_whatsapp' and c.provider_target = p_provider_target;
  if not found then
    return jsonb_build_object('state', 'unrouted', 'reason', 'unknown_target');
  end if;
  if not v_channel.active or v_channel.mode <> 'test' then
    return jsonb_build_object('state', 'unrouted', 'reason', 'channel_not_live');
  end if;
  -- The units that would own the work must be able to take it. A paused unit
  -- is recoverable: re-activating it lets Meta's redelivery through.
  if not exists (
    select 1
      from ops.agents a
      join ops.departments d on d.tenant_id = a.tenant_id and d.company_id = a.company_id and d.id = a.department_id
      join ops.companies co on co.tenant_id = a.tenant_id and co.id = a.company_id
     where a.tenant_id = v_channel.tenant_id and a.company_id = v_channel.company_id and a.id = v_channel.agent_id
       and a.status = 'active' and d.status = 'active' and co.status = 'active') then
    return jsonb_build_object('state', 'unrouted', 'reason', 'organisation_inactive');
  end if;

  -- The database's clock, not the gateway's: skew cannot refuse a message.
  v_received_at := least(p_received_at, now());

  -- ADR 0021 W5: a redelivery of a message this channel's tenant already
  -- answered never touches a conversation, so a routine provider retry cannot
  -- re-create a number that was erased. An admitted message goes on to the
  -- admission (which answers the replay, or refuses a reused id) with its own
  -- conversation; a message refused on the record gets that refusal again.
  select m.* into v_prior
    from ops.inbound_messages m
   where m.tenant_id = v_channel.tenant_id and m.source_kind = 'whatsapp'
     and m.external_message_id = p_external_message_id;
  if v_prior.id is null then
    select e.payload into v_refused
      from ops.events e
     where e.tenant_id = v_channel.tenant_id and e.idempotency_key = v_refusal_key;
    if found then
      return jsonb_strip_nulls(jsonb_build_object(
        'state', 'refused', 'reason', v_refused ->> 'reason', 'conversation_id', v_refused ->> 'conversation_id'));
    end if;
  end if;

  -- ADR 0026 §D: the owner's own number, recognised before any conversation
  -- is written, as a content-free fact: no conversation, task, lead or
  -- exception. A sender the owner registered on this test channel stays a
  -- test sender. Held shared against the owner's acts on the target.
  if v_prior.id is null and p_from is not null then
    perform pg_advisory_xact_lock_shared(ops.owner_target_lock_key(v_channel.tenant_id));
    if not ops.registered_test_sender(v_channel.tenant_id, v_channel.id, p_from)
       and ops.owner_number_matches(v_channel.tenant_id, p_from) then
      perform ops.record_event(
        v_channel.tenant_id, v_channel.company_id, 'communication.inbound_refused', 'whatsapp-gateway',
        'company', v_channel.company_id,
        jsonb_build_object('channel_id', v_channel.id, 'reason', 'owner_number'),
        null, null, v_refusal_key);
      return jsonb_build_object('state', 'refused', 'reason', 'owner_number');
    end if;
  end if;

  if p_from is null then
    v_reason := 'no_sender_number';
  else
    if v_prior.conversation_id is not null then
      v_conv := v_prior.conversation_id;
    else
      insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
      values (v_channel.tenant_id, v_channel.company_id, v_channel.id, p_from, v_received_at)
      on conflict (tenant_id, channel_id, contact_ref) do update
        set last_inbound_at = greatest(ops.conversations.last_inbound_at, excluded.last_inbound_at)
      returning id into v_conv;

      -- ADR 0026 §C: a duplicate delivery waited on the conversation's row
      -- behind the first one; it reads what the first one made of the message
      -- before it can make anything of it itself.
      select m.* into v_prior
        from ops.inbound_messages m
       where m.tenant_id = v_channel.tenant_id and m.source_kind = 'whatsapp'
         and m.external_message_id = p_external_message_id;
      if v_prior.id is null and exists (
           select 1 from ops.events e
            where e.tenant_id = v_channel.tenant_id and e.idempotency_key = v_refusal_key) then
        select e.payload into v_refused
          from ops.events e
         where e.tenant_id = v_channel.tenant_id and e.idempotency_key = v_refusal_key;
        return jsonb_strip_nulls(jsonb_build_object(
          'state', 'refused', 'reason', v_refused ->> 'reason', 'conversation_id', v_conv));
      end if;

      -- ADR 0026 §C: a number the CRM does not know becomes a lead, for a
      -- sender the owner registered on this test channel (BASELINE Q8), before
      -- the CRM is read, so the admission finds it. A message refused on the
      -- record creates it too. Isolated: a lock wait, a serialization failure
      -- or a deadlock answers the gateway 500 for Meta to deliver again; any
      -- other failure goes on as an unknown number, on the record.
      if v_prior.id is null
         and ops.registered_test_sender(v_channel.tenant_id, v_channel.id, p_from)
         and ops.crm_contact_by_phone(v_channel.tenant_id, p_from) ->> 'state' = 'not_found' then
        begin
          v_lead := ops.crm_create_whatsapp_lead(
            v_channel.tenant_id, v_channel.company_id, v_channel.id, v_conv, p_from,
            p_profile_first_name, v_received_at);
        exception
          when lock_not_available or serialization_failure or deadlock_detected then
            raise;
          when others then
            v_lead := 'skipped:error';
        end;
        if v_lead = 'skipped:error' then
          insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act)
          values (v_channel.tenant_id, v_channel.company_id, v_conv, v_channel.id, 'skipped:error');
        end if;
      end if;
    end if;

    v_crm := ops.crm_contact_by_phone(v_channel.tenant_id, p_from);
    -- Only a single CRM contact whose opt-out flag is false is eligible at
    -- admission; every other answer is do-not-contact.
    v_dnc := not (v_crm ->> 'state' = 'found'
                  and jsonb_typeof(v_crm -> 'do_not_contact') = 'boolean'
                  and not (v_crm ->> 'do_not_contact')::boolean);

    -- ops.admit_inbound_core's own bounds, decided here so that a refusal is on
    -- the record rather than an exception the gateway could only log.
    v_reason := case
      when p_body is null then 'unsupported_content'
      when p_body !~ '\S' then 'empty_body'
      when char_length(p_body) > 4000 then 'body_too_long'
    end;

    if v_reason is null then
      begin
        v_result := ops.admit_inbound_core(
          v_channel.tenant_id, v_channel.company_id, v_channel.agent_id, 'whatsapp',
          p_external_message_id, p_from, p_body, 'whatsapp-gateway', v_dnc, v_received_at,
          v_channel.id, v_conv, v_crm ->> 'state', v_crm ->> 'crm_contact_ref');
      exception when sqlstate 'OS400' or sqlstate 'OS409' then
        -- The admission refused it (a reused message id carrying another
        -- message, or a unit paused since the check above): nothing it began
        -- survives, and the refusal is recorded below.
        v_reason := 'admission_refused';
      end;
      if v_result is not null then
        -- A near-duplicate is a person's to resolve, on this message, before
        -- the screening's own raise counts on it (the first detail stands).
        if v_lead = 'skipped:possible_match' and not coalesce((v_result ->> 'replayed')::boolean, false) then
          perform ops.open_exception(v_channel.tenant_id, v_channel.company_id, (v_result ->> 'task_id')::uuid,
                                     'contact_unresolved', v_conv, null, 'possible_match', 'whatsapp-gateway');
        end if;
        return v_result || jsonb_build_object('state', 'admitted', 'conversation_id', v_conv);
      end if;
    end if;
  end if;

  -- A duplicate delivery that waited on the conversation's row behind this
  -- one finds its refusal now, and is answered with it: it is counted once.
  if v_conv is not null and exists (
       select 1 from ops.events e
        where e.tenant_id = v_channel.tenant_id and e.idempotency_key = v_refusal_key) then
    return jsonb_strip_nulls(jsonb_build_object('state', 'refused', 'reason', v_reason, 'conversation_id', v_conv));
  end if;

  -- Acknowledged only with a durable record of it: the channel, the
  -- conversation when there is a sender number, and why. Never the body, the
  -- sender or the message id. Once per message id.
  perform ops.record_event(
    v_channel.tenant_id, v_channel.company_id, 'communication.inbound_refused', 'whatsapp-gateway',
    'company', v_channel.company_id,
    jsonb_strip_nulls(jsonb_build_object('channel_id', v_channel.id, 'conversation_id', v_conv, 'reason', v_reason)),
    null, null, v_refusal_key);
  -- ADR 0026 §A: a refused message (an audio, an image) in a conversation a
  -- person holds waits for that person like any other, counted on the
  -- conversation's newest admitted message. Content-free: the kind only.
  -- The holder is read under a share lock, in the order the person's reply
  -- takes them (the conversation, then its state): a release in flight either
  -- finishes first and is seen, or waits and resolves what is counted here.
  if v_conv is not null then
    select s.holder into v_holder from ops.conversation_states s
     where s.tenant_id = v_channel.tenant_id and s.conversation_id = v_conv
       for share;
  end if;
  if v_conv is not null and (v_holder = 'person' or v_lead = 'skipped:possible_match') then
    select m.task_id into v_waiting
      from ops.inbound_messages m
     where m.tenant_id = v_channel.tenant_id and m.conversation_id = v_conv and m.task_id is not null
     order by m.received_at desc, m.created_at desc
     limit 1;
    if v_waiting is not null and v_holder = 'person' then
      perform ops.open_exception(v_channel.tenant_id, v_channel.company_id, v_waiting, 'message_waiting',
                                 v_conv, null, null, 'whatsapp-gateway');
    end if;
    -- ADR 0026 §C: a near-duplicate found on a refused message is raised on
    -- the conversation's newest admitted message, when there is one; the act
    -- ledger records it either way.
    if v_waiting is not null and v_lead = 'skipped:possible_match' then
      perform ops.open_exception(v_channel.tenant_id, v_channel.company_id, v_waiting, 'contact_unresolved',
                                 v_conv, null, 'possible_match', 'whatsapp-gateway');
    end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('state', 'refused', 'reason', v_reason, 'conversation_id', v_conv));
end
$function$;

-- The status entry as 20261016120000, with the owner's notifications matched
-- where no reply is.
create or replace function ops.receive_whatsapp_status(
  p_provider_target     text,
  p_provider_message_id text,
  p_status              text,
  p_status_at           timestamptz,
  p_recipient           text,
  p_correlation         text,
  p_error_code          text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_channel ops.communication_channels;
  v_out     ops.outbound_messages;
  v_conv    ops.conversations;
  v_rank    integer;
  v_current integer;
  v_next    text;
  v_note    ops.owner_notifications;
begin
  if p_provider_target is null or p_provider_target !~ '^[0-9]{1,32}$'
     or p_provider_message_id is null or p_provider_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_status: malformed status';
  end if;

  -- Statuses reconcile sends made before a channel was deactivated, so the
  -- channel need not be active; it must exist.
  select * into v_channel from ops.communication_channels c
   where c.provider = 'meta_whatsapp' and c.provider_target = p_provider_target;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.receive_whatsapp_status: unknown provider target';
  end if;

  select * into v_out from ops.outbound_messages o
   where o.tenant_id = v_channel.tenant_id and o.channel_id = v_channel.id
     and o.provider_message_id = p_provider_message_id
     for update;

  -- A send whose response was lost has no provider id yet. It is matched by
  -- the correlation this system sent with it, and only when the recipient the
  -- provider names is that conversation's contact.
  if not found and p_correlation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select o.* into v_out from ops.outbound_messages o
     where o.id = p_correlation::uuid
       and o.tenant_id = v_channel.tenant_id and o.channel_id = v_channel.id
       and o.provider_message_id is null
       and o.status in ('sending', 'indeterminate')
       for update;
    if found then
      select * into v_conv from ops.conversations where id = v_out.conversation_id;
      if p_recipient is distinct from v_conv.contact_ref then
        v_out := null;
      end if;
    end if;
  end if;

  -- ADR 0026 §D: a status for the owner's notification, matched by the digest
  -- of its provider id, or, for one whose outcome was uncertain, by its
  -- correlation and a recipient that is the target's number (compared here,
  -- never returned). No event and no exception.
  if v_out.id is null then
    select n.* into v_note from ops.owner_notifications n
     where n.tenant_id = v_channel.tenant_id and n.send_channel_id = v_channel.id
       and n.provider_message_key = encode(sha256(convert_to(p_provider_message_id, 'UTF8')), 'hex')
       for update;
    if not found
       and p_correlation ~ '^owner-notification:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select n.* into v_note
        from ops.owner_notifications n
        join ops.owner_notification_targets t on t.tenant_id = n.tenant_id and t.id = n.target_id and t.retired_at is null
       where n.id = substr(p_correlation, 20)::uuid
         and n.tenant_id = v_channel.tenant_id and n.send_channel_id = v_channel.id
         and n.provider_message_key is null and n.status = 'indeterminate'
         and p_recipient = any (ops.owner_number_forms(t.digits))
         for update of n;
    end if;
    if v_note.id is null then
      return jsonb_build_object('state', 'unmatched');
    end if;
    return ops.apply_owner_notification_status(v_note, p_status, p_status_at, p_provider_message_id, p_error_code);
  end if;

  v_rank := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else null end;
  v_current := case v_out.status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;

  if p_status = 'failed' then
    if v_out.status not in ('sending', 'indeterminate', 'sent') then
      return jsonb_build_object('state', 'ignored', 'status', v_out.status);
    end if;
    v_next := 'failed';
  elsif v_rank is null then
    -- e.g. 'played' (a voice message): not a delivery state this send tracks.
    return jsonb_build_object('state', 'unsupported');
  elsif v_out.status = 'failed' and v_rank >= 2 then
    -- Delivery evidence after a failure: at least one device received it.
    v_next := p_status;
  elsif v_out.status not in ('sending', 'indeterminate', 'sent', 'delivered') or v_rank <= v_current then
    -- A duplicate, or older news than what is recorded: nothing changes.
    return jsonb_build_object('state', 'ignored', 'status', v_out.status);
  else
    v_next := p_status;
  end if;

  update ops.outbound_messages
     set status              = v_next,
         provider_message_id = coalesce(provider_message_id, p_provider_message_id),
         settled_at          = coalesce(settled_at, now()),
         delivered_at        = case when v_next in ('delivered', 'read')
                                    then coalesce(delivered_at, p_status_at, now()) else delivered_at end,
         read_at             = case when v_next = 'read' then coalesce(read_at, p_status_at, now()) else read_at end,
         error_code          = case when v_next = 'failed'
                                    then nullif(substring(coalesce(p_error_code, '') from '^[0-9]{1,10}$'), '')
                                    when v_next in ('delivered', 'read') then null
                                    else error_code end,
         error_class         = case when v_next = 'failed' then 'provider_status_failed'
                                    when v_next in ('delivered', 'read') then null
                                    else error_class end
   where id = v_out.id;

  perform ops.record_event(
    v_out.tenant_id, v_out.company_id, 'communication.delivery_updated', 'whatsapp-gateway',
    'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id, 'status', v_next, 'previous', v_out.status),
    null, null, format('whatsapp:status:%s:%s', v_out.id, v_next));

  -- ADR 0025: a failure reported after the send, or the evidence that settles
  -- an uncertain or failed one.
  perform ops.sync_send_exceptions(v_out.tenant_id, v_out.id, 'whatsapp-gateway');

  return jsonb_build_object('state', 'updated', 'status', v_next, 'previous', v_out.status);
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. Access. The tables: no role. The helpers, the owner's acts and the
--    guards: no role. The worker's three capabilities: its alone. The gateway
--    keeps exactly its two entry points.
-- ---------------------------------------------------------------------------

revoke all on table ops.owner_notification_targets from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on table ops.owner_notifications from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function ops.guard_owner_notification_target()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.refuse_owner_notification_target_truncate()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_number_forms(text) from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_target_lock_key(uuid) from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_number_matches(uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.record_owner_notification_target(
  uuid, uuid, text, text, text, text, text, text[], time, time, text, integer, integer, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.retire_owner_notification_target(uuid, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.guard_owner_notification() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.refuse_owner_notification_truncate()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_lock_key(uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_live_statuses()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_quiet(ops.owner_notification_targets, timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_quiet_end(ops.owner_notification_targets, timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_due_at(ops.owner_notification_targets, timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_last_reply(uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.crm_contact_first_name(uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_first_word(uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.record_owner_notification_intent(uuid, uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.release_owner_notification_job(ops.jobs, timestamptz, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.owner_notification_cap_frees_at(uuid, ops.owner_notification_targets)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.fail_owner_notifications_carried(ops.owner_notifications)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.block_owner_notification(ops.owner_notifications, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.apply_owner_notification_status(ops.owner_notifications, text, timestamptz, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- The worker's two new capabilities and its reaper step: its alone.
revoke all on function ops.begin_owner_notification(text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.settle_owner_notification(text, text, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.settle_stale_owner_notifications()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function ops.begin_owner_notification(text) to ops_worker;
grant execute on function ops.settle_owner_notification(text, text, text, text) to ops_worker;
grant execute on function ops.settle_stale_owner_notifications() to ops_worker;

-- The gateway's two entry points: its alone, as before.
revoke all on function ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function ops.receive_whatsapp_message(text, text, text, text, timestamptz, text) to ops_gateway;
grant execute on function ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text) to ops_gateway;

do $end_state$
declare
  v_bad text;
  c_invokers constant text[] := array[
    'ops.guard_owner_notification_target()', 'ops.refuse_owner_notification_target_truncate()',
    'ops.owner_number_forms(text)', 'ops.owner_target_lock_key(uuid)', 'ops.owner_number_matches(uuid, text)',
    'ops.record_owner_notification_target(uuid, uuid, text, text, text, text, text, text[], time without time zone, time without time zone, text, integer, integer, text)',
    'ops.retire_owner_notification_target(uuid, text, text)',
    'ops.guard_owner_notification()', 'ops.refuse_owner_notification_truncate()',
    'ops.owner_notification_lock_key(uuid)', 'ops.owner_notification_live_statuses()',
    'ops.owner_notification_quiet(ops.owner_notification_targets, timestamp with time zone)',
    'ops.owner_notification_quiet_end(ops.owner_notification_targets, timestamp with time zone)',
    'ops.owner_notification_due_at(ops.owner_notification_targets, timestamp with time zone)',
    'ops.owner_notification_last_reply(uuid, uuid)', 'ops.crm_contact_first_name(uuid, text)',
    'ops.owner_notification_first_word(uuid, uuid, text)',
    'ops.record_owner_notification_intent(uuid, uuid, uuid, text, uuid, uuid)',
    'ops.release_owner_notification_job(ops.jobs, timestamp with time zone, text)',
    'ops.owner_notification_cap_frees_at(uuid, ops.owner_notification_targets)',
    'ops.fail_owner_notifications_carried(ops.owner_notifications)',
    'ops.block_owner_notification(ops.owner_notifications, text)',
    'ops.apply_owner_notification_status(ops.owner_notifications, text, timestamp with time zone, text, text)'];
  c_capabilities constant text[] := array[
    'ops.begin_owner_notification(text)', 'ops.settle_owner_notification(text, text, text, text)',
    'ops.settle_stale_owner_notifications()'];
begin
  -- The tables: row security on and forced, no role holds a privilege, the
  -- guards ALWAYS, and no target shipped in a migration.
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('ops.owner_notification_targets'::pg_catalog.regclass,
                              'ops.owner_notifications'::pg_catalog.regclass)
                and not (c.relrowsecurity and c.relforcerowsecurity))
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname),
                              (values ('ops.owner_notification_targets'), ('ops.owner_notifications')) as t (relname)
                 where pg_catalog.has_table_privilege(r.rolname, t.relname, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) then
    raise exception 'a notification table is readable or writable by a role, or its row security is off';
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where t.tgrelid in ('ops.owner_notification_targets'::pg_catalog.regclass,
                           'ops.owner_notifications'::pg_catalog.regclass)
         and not t.tgisinternal and t.tgenabled = 'A') <> 4 then
    raise exception 'the notification tables do not carry exactly their four ALWAYS guards';
  end if;
  if exists (select 1 from ops.owner_notification_targets) then
    raise exception 'a notification target shipped in a migration: the owner records it';
  end if;

  -- The helpers, the acts and the guards are pinned INVOKERs no role reaches;
  -- the capabilities are pinned DEFINERs only the worker executes.
  select pg_catalog.string_agg(f, ', ') into v_bad
    from pg_catalog.unnest(c_invokers || c_capabilities) f
   where pg_catalog.to_regprocedure(f) is null;
  if v_bad is not null then
    raise exception 'a notification function is missing: %', v_bad;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array(select f::pg_catalog.regprocedure from pg_catalog.unnest(c_invokers) f))
     and (p.prosecdef
          or p.proconfig is distinct from array['search_path=""']
          or p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a notification helper is reachable or not a pinned INVOKER: %', v_bad;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array(select f::pg_catalog.regprocedure from pg_catalog.unnest(c_capabilities) f))
     and (not p.prosecdef
          or p.proconfig is distinct from array['search_path=""']
          or not pg_catalog.has_function_privilege('ops_worker', p.oid, 'EXECUTE')
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a notification capability is not a pinned DEFINER the worker alone executes: %', v_bad;
  end if;

  -- The kind is external, held by the kill switch at its unit's scopes, and
  -- no task may request it; the earlier kinds and branches are kept.
  if not ('owner_notification.send' = any (ops.external_job_kinds()))
     or 'owner_notification.send' = any (ops.task_executable_kinds())
     or 'owner_notification.send' = any (ops.internal_job_kinds())
     or not (array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update',
                   'calendar.cancel', 'decision.structured_evaluate', 'outbound.reply_send'] <@ ops.external_job_kinds()) then
    raise exception 'owner_notification.send is not an external kind only the database queues';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.job_covering_stop(uuid, uuid, text)'::pg_catalog.regprocedure),
                       'owner_notifications') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.job_covering_stop(uuid, uuid, text)'::pg_catalog.regprocedure),
                          'outbound.reply_send') = 0 then
    raise exception 'the kill switch does not hold a notification at its unit''s scopes';
  end if;

  -- The order of the events is the order the facts happened in.
  if (select s.seqcache from pg_catalog.pg_sequence s
       where s.seqrelid = pg_catalog.pg_get_serial_sequence('ops.events', 'seq')::pg_catalog.regclass) <> 1 then
    raise exception 'the event order is cached: a notification''s trigger order would not be exact';
  end if;

  -- Each predecessor's logic is kept, with the new step in it.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.open_exception(uuid, uuid, uuid, text, uuid, uuid, text, text)'::pg_catalog.regprocedure),
                       'record_owner_notification_intent') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.open_exception(uuid, uuid, uuid, text, uuid, uuid, text, text)'::pg_catalog.regprocedure),
                          '''send_blocked'') then ''high''') = 0 then
    raise exception 'ops.open_exception does not record the owner''s notification, or lost its priorities';
  end if;
  if not exists (
       select 1 from pg_catalog.pg_proc p
        where p.oid = 'ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)'::pg_catalog.regprocedure
          and p.prosecdef and p.proconfig = array['search_path=""']
          and pg_catalog.strpos(p.prosrc, '''owner_number''') > 0
          and pg_catalog.strpos(p.prosrc, 'ops.owner_target_lock_key') > 0
          and pg_catalog.strpos(p.prosrc, 'ops.crm_create_whatsapp_lead') > 0
          and pg_catalog.strpos(p.prosrc, 'message_waiting') > 0)
     or not exists (
       select 1 from pg_catalog.pg_proc p
        where p.oid = 'ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)'::pg_catalog.regprocedure
          and p.prosecdef and p.proconfig = array['search_path=""']
          and pg_catalog.strpos(p.prosrc, 'apply_owner_notification_status') > 0
          and pg_catalog.strpos(p.prosrc, 'ops.sync_send_exceptions') > 0) then
    raise exception 'the gateway''s entry points lost a step';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and pg_catalog.has_function_privilege('ops_gateway', p.oid, 'EXECUTE')) <> 2 then
    raise exception 'the gateway executes another ops function than its two entry points';
  end if;
end
$end_state$;
