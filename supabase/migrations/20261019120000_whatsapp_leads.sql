-- ADR 0026 §C, slice 3a: every new WhatsApp number becomes a CRM lead.
--
-- The owner decided (decision 4, 2026-10-08) that a number the CRM does not
-- know becomes a lead automatically, and that the receptionist answers it.
-- Until now the transport only read the CRM (SI-48) and an unknown number was
-- unreachable (ADR 0021 W6 (a)). From this migration the gateway's admission
-- creates ONE CRM contact for such a number, its lead profile (the CRM's own
-- trigger) and one whatsapp attribution, before it reads the CRM, so the
-- admission's snapshot reads `found` and the first message is answered.
--
-- What bounds it (SI-84):
--   * Only for a sender the owner registered on a test channel while BASELINE
--     Q8 and the production gate are closed; only for the tenant that owns the
--     local CRM; never for a redelivery; once per conversation.
--   * Only within a daily cap the owner recorded with the tool (with none in
--     force, nothing is created), named with the owner's placeholder unless
--     the gateway passed a first name its screen found benign.
--   * A contact whose phone digits end with the sender's last eight blocks the
--     creation (`possible_match`) and raises contact_unresolved for a person;
--     it never blocks a safety text (ADR 0026 §B).
--   * A lock wait, a serialization failure or a deadlock answers the gateway
--     500, so Meta delivers again; any other failure is recorded and the
--     message goes on as an unknown number.
--   * Every decision is recorded in ops.crm_contact_acts (no number, no name)
--     and a creation emits lead.created (the channel and the conversation).
--
-- Writes `public.contacts` and `public.acquisition_attributions` only through
-- ops.crm_create_whatsapp_lead, which no role executes; the receive function
-- (a DEFINER only ops_gateway executes) is its only caller.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The owner's lead policy: how many leads a day, the day's time zone, and
--    the name a lead gets when its sender's profile name is not used. Owner
--    data, one in force per tenant, recorded and retired by the owner's tool;
--    never a migration row. With none in force, nothing is created.
-- ---------------------------------------------------------------------------

create table ops.crm_lead_policies (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references ops.tenants (id) on delete restrict,
  daily_cap        integer not null,
  time_zone        text not null,
  name_placeholder text not null,
  recorded_by      text not null,
  recorded_at      timestamptz not null default now(),
  retired_by       text,
  retired_at       timestamptz,
  retire_reason    text,
  constraint crm_lead_policies_cap_range check (daily_cap between 1 and 1000),
  constraint crm_lead_policies_time_zone_format check (time_zone ~ '^[A-Za-z0-9_+/-]{1,64}$'),
  constraint crm_lead_policies_placeholder_format check (
    name_placeholder ~ '^[^[:cntrl:][:digit:]=+@<>"\\/:;]{1,40}$' and name_placeholder !~ '^[[:space:].''-]'),
  constraint crm_lead_policies_actor_format check (
        recorded_by ~ '^[A-Za-z0-9._:@-]{1,200}$'
    and (retired_by is null or retired_by ~ '^[A-Za-z0-9._:@-]{1,200}$')),
  constraint crm_lead_policies_retire_shape check (
        (retired_at is null) = (retired_by is null)
    and (retired_at is null) = (retire_reason is null)
    and (retire_reason is null or char_length(retire_reason) between 1 and 200))
);

comment on table ops.crm_lead_policies is
  'ADR 0026 §C: the owner''s lead policy: at most daily_cap WhatsApp leads a day (the day in time_zone), named name_placeholder unless the gateway passed a benign first name. One in force per tenant; recorded and retired by the owner, never edited; with none in force no lead is created.';

create unique index crm_lead_policies_one_in_force on ops.crm_lead_policies (tenant_id) where retired_at is null;

-- Born in force with a real time zone, never edited, retired once; only a
-- retired policy may be deleted (a fixture's cleanup), never the one in force.
create function ops.guard_crm_lead_policy()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.retired_at is not null or new.retired_by is not null or new.retire_reason is not null then
      raise exception using errcode = 'OS403', message = 'ops.crm_lead_policies: a policy is recorded in force';
    end if;
    if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.time_zone) then
      raise exception using errcode = 'OS400', message = 'ops.crm_lead_policies: unknown time zone';
    end if;
    new.recorded_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.retired_at is null then
      raise exception using errcode = 'OS403', message = 'ops.crm_lead_policies: retire a policy before it is deleted';
    end if;
    return old;
  end if;
  if old.retired_at is not null
     or (to_jsonb(new) - array['retired_by', 'retired_at', 'retire_reason'])
        is distinct from (to_jsonb(old) - array['retired_by', 'retired_at', 'retire_reason'])
     or new.retired_by is null or new.retire_reason is null then
    raise exception using errcode = 'OS403',
      message = 'ops.crm_lead_policies: a policy is never edited; it is retired once';
  end if;
  new.retired_at := now();
  return new;
end
$function$;

create trigger crm_lead_policies_guard
  before insert or update or delete on ops.crm_lead_policies
  for each row execute function ops.guard_crm_lead_policy();
alter table ops.crm_lead_policies enable always trigger crm_lead_policies_guard;

create function ops.refuse_crm_lead_policy_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.crm_lead_policies: the policies are never truncated';
end
$function$;

create trigger crm_lead_policies_refuse_truncate
  before truncate on ops.crm_lead_policies
  for each statement execute function ops.refuse_crm_lead_policy_truncate();
alter table ops.crm_lead_policies enable always trigger crm_lead_policies_refuse_truncate;

-- The owner's two acts. A new policy retires the one in force in the same
-- transaction, so there is never a moment with two or, by accident, none.
create function ops.record_crm_lead_policy(
  p_tenant_id uuid, p_daily_cap integer, p_time_zone text, p_name_placeholder text, p_actor text)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_tenant_id is null or not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.record_crm_lead_policy: unknown tenant';
  end if;
  update ops.crm_lead_policies
     set retired_by = p_actor, retire_reason = 'superseded by a new policy'
   where tenant_id = p_tenant_id and retired_at is null;
  insert into ops.crm_lead_policies (tenant_id, daily_cap, time_zone, name_placeholder, recorded_by)
  values (p_tenant_id, p_daily_cap, p_time_zone, p_name_placeholder, p_actor)
  returning id into v_id;
  return v_id;
end
$function$;

create function ops.retire_crm_lead_policy(p_tenant_id uuid, p_reason text, p_actor text)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  update ops.crm_lead_policies
     set retired_by = p_actor, retire_reason = p_reason
   where tenant_id = p_tenant_id and retired_at is null;
  return found;
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. The Company OS's acts on CRM contacts: append-only, per conversation, no
--    number and no name. This slice records the creations and the creations
--    skipped; the opt-out's record, its lift and the CRM copy's retention add
--    their acts with their migrations.
-- ---------------------------------------------------------------------------

create table ops.crm_contact_acts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  company_id      uuid not null,
  conversation_id uuid not null,
  channel_id      uuid not null,
  act             text not null,
  crm_contact_ref text,
  task_id         uuid,
  recorded_at     timestamptz not null default now(),
  constraint crm_contact_acts_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id) references ops.conversations (tenant_id, company_id, id)
    on delete cascade,
  constraint crm_contact_acts_channel_fkey
    foreign key (tenant_id, company_id, channel_id) references ops.communication_channels (tenant_id, company_id, id)
    on delete cascade,
  constraint crm_contact_acts_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id)
    on delete cascade,
  constraint crm_contact_acts_act_check check (act in (
    'created', 'skipped:cap', 'skipped:no_cap', 'skipped:possible_match', 'skipped:error')),
  constraint crm_contact_acts_ref_format check (
    crm_contact_ref is null or crm_contact_ref ~ '^crm:contact:[0-9]{1,19}$'),
  constraint crm_contact_acts_created_names_contact check ((act = 'created') = (crm_contact_ref is not null))
);

comment on table ops.crm_contact_acts is
  'ADR 0026 §C, SI-84: what the Company OS did, or decided not to do, to a CRM contact for a conversation: created (with the contact''s reference) or a skipped creation and why. Append-only; no number, no name; it leaves only with its conversation.';

-- A conversation creates at most one contact: its one creation slot.
create unique index crm_contact_acts_one_creation
  on ops.crm_contact_acts (conversation_id) where act = 'created';
create index crm_contact_acts_tenant_recorded_idx on ops.crm_contact_acts (tenant_id, recorded_at);
create index crm_contact_acts_ref_idx on ops.crm_contact_acts (tenant_id, crm_contact_ref)
  where crm_contact_ref is not null;

-- Append-only: an act is never changed; it leaves only with its conversation
-- (a fixture's cleanup; a conversation is never deleted in operation).
create function ops.guard_crm_contact_act()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.recorded_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from ops.conversations c where c.id = old.conversation_id) then
      raise exception using errcode = 'OS403', message = 'ops.crm_contact_acts: an act leaves only with its conversation';
    end if;
    return old;
  end if;
  raise exception using errcode = 'OS403', message = 'ops.crm_contact_acts: an act is never changed';
end
$function$;

create trigger crm_contact_acts_guard
  before insert or update or delete on ops.crm_contact_acts
  for each row execute function ops.guard_crm_contact_act();
alter table ops.crm_contact_acts enable always trigger crm_contact_acts_guard;

create function ops.refuse_crm_contact_act_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.crm_contact_acts: the acts are never truncated';
end
$function$;

create trigger crm_contact_acts_refuse_truncate
  before truncate on ops.crm_contact_acts
  for each statement execute function ops.refuse_crm_contact_act_truncate();
alter table ops.crm_contact_acts enable always trigger crm_contact_acts_refuse_truncate;

-- ---------------------------------------------------------------------------
-- 3. The lead adapter. Reaches the CRM's tables (ADR 0005: the one place the
--    Company OS writes a contact at admission), executable by no role, called
--    only by the receive function.
-- ---------------------------------------------------------------------------

-- Whether some contact's phone ends with the sender's last eight digits: the
-- same person under another country code or format. Read-only; it only ever
-- refuses a creation, never resolves a contact (SI-48).
create function ops.crm_phone_suffix_match(p_sender text)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select p_sender ~ '^[0-9]{6,20}$' and exists (
    select 1
      from public.contacts c
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(c.phone_jsonb) = 'array' then c.phone_jsonb else '[]'::pg_catalog.jsonb end) e
     where pg_catalog.jsonb_typeof(e) = 'object'
       and pg_catalog.right(pg_catalog.regexp_replace(coalesce(e ->> 'number', ''), '[^0-9]', '', 'g'), 8)
           = pg_catalog.right(p_sender, 8)
       and pg_catalog.char_length(pg_catalog.regexp_replace(coalesce(e ->> 'number', ''), '[^0-9]', '', 'g')) >= 8);
$function$;

-- Answers created, existing, ambiguous, unavailable or skipped:<reason>;
-- records created and every skipped creation in ops.crm_contact_acts. Never
-- raises for a reason a redelivery could not change: the receive function
-- turns any other error into skipped:error, and a lock, serialization or
-- deadlock failure into a 500 for Meta to deliver again.
create function ops.crm_create_whatsapp_lead(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_channel_id      uuid,
  p_conversation_id uuid,
  p_sender          text,
  p_first_name      text,
  p_received_at     timestamptz)
returns text
language plpgsql
volatile
security invoker
set search_path to ''
set lock_timeout to '2s'
as $function$
declare
  v_policy  ops.crm_lead_policies;
  v_crm     jsonb;
  v_created integer;
  v_name    text;
  v_contact bigint;
  v_skip    text;
begin
  -- The tenant must own the local CRM, decided before anything of it is read.
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return 'unavailable';
  end if;
  if p_sender is null or p_sender !~ '^[0-9]{6,20}$' or p_received_at is null then
    return 'skipped:error';
  end if;

  -- One number at a time across the tenant's channels.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ops.crm_contact_acts:number:' || p_tenant_id::text || ':' || p_sender, 0));

  -- The conversation's one creation slot, then the exact match afresh.
  if exists (select 1 from ops.crm_contact_acts a
              where a.conversation_id = p_conversation_id and a.act = 'created') then
    return 'skipped:conversation_used';
  end if;
  v_crm := ops.crm_contact_by_phone(p_tenant_id, p_sender);
  if v_crm ->> 'state' = 'found' then
    return 'existing';
  elsif v_crm ->> 'state' in ('ambiguous', 'unavailable') then
    return v_crm ->> 'state';
  end if;

  -- The same person under another format: a person decides.
  if ops.crm_phone_suffix_match(p_sender) then
    v_skip := 'skipped:possible_match';
  else
    select p.* into v_policy from ops.crm_lead_policies p
     where p.tenant_id = p_tenant_id and p.retired_at is null;
    if not found then
      v_skip := 'skipped:no_cap';
    else
      -- The day's count, one tenant at a time so two admissions cannot both
      -- take the last place.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('ops.crm_contact_acts:cap:' || p_tenant_id::text, 0));
      select count(*) into v_created
        from ops.crm_contact_acts a
       where a.tenant_id = p_tenant_id and a.act = 'created'
         and (a.recorded_at at time zone v_policy.time_zone)::date = (now() at time zone v_policy.time_zone)::date;
      if v_created >= v_policy.daily_cap then
        v_skip := 'skipped:cap';
      end if;
    end if;
  end if;
  if v_skip is not null then
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act)
    values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, v_skip);
    return v_skip;
  end if;

  -- The sender chose the profile name: the gateway passes a first name only
  -- when its screen found it benign; it is checked again here and otherwise
  -- the owner's placeholder is used. A first name only, at creation only.
  v_name := case
    when p_first_name is not null
     and p_first_name ~ '^[^[:cntrl:][:space:][:digit:][:punct:]=+@<>"\\/:;,!?#$%&*()\[\]{}|_~^`.''-][^[:cntrl:][:space:][:digit:]=+@<>"\\/:;,!?#$%&*()\[\]{}|_~^`]{0,39}$'
    then p_first_name
    else v_policy.name_placeholder
  end;

  insert into public.contacts (first_name, last_name, phone_jsonb, email_jsonb, tags, first_seen, last_seen, sales_id)
  values (v_name, '', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('number', '+' || p_sender, 'type', 'Other')),
          '[]'::pg_catalog.jsonb, '{}'::bigint[], p_received_at, p_received_at, null)
  returning id into v_contact;
  -- The CRM's own trigger added the lead profile (acquired at first_seen).
  insert into public.acquisition_attributions (contact_id, acquired_at, source)
  values (v_contact, p_received_at, 'whatsapp');

  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'created', 'crm:contact:' || v_contact::text);
  perform ops.record_event(
    p_tenant_id, p_company_id, 'lead.created', 'whatsapp-gateway', 'company', p_company_id,
    pg_catalog.jsonb_build_object('channel_id', p_channel_id, 'conversation_id', p_conversation_id),
    null, null, pg_catalog.format('lead:%s:created', p_conversation_id));
  return 'created';
end
$function$;

comment on function ops.crm_create_whatsapp_lead(uuid, uuid, uuid, uuid, text, text, timestamptz) is
  'ADR 0026 §C, SI-84: creates one CRM contact, its lead profile (the CRM trigger) and one whatsapp attribution for a number the CRM does not know, once per conversation, within the owner''s daily cap, for the tenant that owns the local CRM; a near-duplicate (the last eight digits) refuses it. Records the act; emits lead.created. Executable by no role; called only by ops.receive_whatsapp_message.';

-- ---------------------------------------------------------------------------
-- 4. A near-duplicate is why a contact is unresolved: possible_match joins
--    the admission's own answers as a contact_unresolved detail.
-- ---------------------------------------------------------------------------

alter table ops.exceptions drop constraint exceptions_detail_shape;
alter table ops.exceptions add constraint exceptions_detail_shape check (
      (kind = 'contact_unresolved') = (detail is not null)
  and (detail is null or detail in ('not_found', 'ambiguous', 'unavailable', 'consent_unknown', 'possible_match')));

-- ---------------------------------------------------------------------------
-- 5. The admission creates the lead. As 20261017120000, with the sender's
--    first name as a sixth parameter (default null), the conversation upserted
--    before the CRM is read, the message's identity read again after the
--    upsert (where two deliveries of one conversation serialize), the lead
--    step, and a near-duplicate raised for a person. The five-argument
--    function is dropped: a defaulted sixth parameter beside it would make
--    every call ambiguous.
-- ---------------------------------------------------------------------------

drop function ops.receive_whatsapp_message(text, text, text, text, timestamptz);

create function ops.receive_whatsapp_message(
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

-- ---------------------------------------------------------------------------
-- 6. The browser reads lead.created: its channel. As 20261016120000 and
--    20261018120000, each with the new type.
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
    'calendar.sync_skipped',
    'exception.raised', 'exception.resolved',
    'lead.created');
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
    -- ADR 0025: the exception's kind and priority, and how it was resolved;
    -- never its id or its subject's.
    when p_type = 'exception.raised' then
      pg_catalog.jsonb_build_object(
        'kind', case when p_payload ->> 'kind' in ('opt_out', 'person_requested', 'configuration_missing',
                                                    'message_waiting', 'contact_unresolved', 'do_not_contact',
                                                    'send_failed', 'send_indeterminate', 'send_blocked')
                     then p_payload ->> 'kind' end,
        'priority', case when p_payload ->> 'priority' in ('high', 'normal') then p_payload ->> 'priority' end)
    when p_type = 'exception.resolved' then
      pg_catalog.jsonb_build_object(
        'kind', case when p_payload ->> 'kind' in ('opt_out', 'person_requested', 'configuration_missing',
                                                    'message_waiting', 'contact_unresolved', 'do_not_contact',
                                                    'send_failed', 'send_indeterminate', 'send_blocked')
                     then p_payload ->> 'kind' end,
        'priority', case when p_payload ->> 'priority' in ('high', 'normal') then p_payload ->> 'priority' end,
        'resolution', case when p_payload ->> 'resolution' in ('released', 'reconciled', 'resolved', 'dismissed')
                           then p_payload ->> 'resolution' end)
    -- ADR 0026 §C: the channel a lead came from; never its conversation.
    when p_type = 'lead.created' then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid))
    else '{}'::pg_catalog.jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Access, and the end state.
-- ---------------------------------------------------------------------------

alter table ops.crm_lead_policies enable row level security;
alter table ops.crm_lead_policies force row level security;
alter table ops.crm_contact_acts enable row level security;
alter table ops.crm_contact_acts force row level security;
revoke all on table ops.crm_lead_policies from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on table ops.crm_contact_acts from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function ops.guard_crm_lead_policy() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.refuse_crm_lead_policy_truncate()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.record_crm_lead_policy(uuid, integer, text, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.retire_crm_lead_policy(uuid, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.guard_crm_contact_act() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.refuse_crm_contact_act_truncate()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.crm_phone_suffix_match(text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.crm_create_whatsapp_lead(uuid, uuid, uuid, uuid, text, text, timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- The gateway's entry point: its alone, as before.
revoke all on function ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function ops.receive_whatsapp_message(text, text, text, text, timestamptz, text) to ops_gateway;

do $end_state$
declare
  v_bad text;
begin
  -- The five-argument entry point is gone; the six-argument one is a pinned
  -- DEFINER only the gateway executes, and it carries the lead step and the
  -- waiting count.
  if to_regprocedure('ops.receive_whatsapp_message(text, text, text, text, timestamptz)') is not null then
    raise exception 'the five-argument receive function still exists';
  end if;
  if not exists (
       select 1 from pg_catalog.pg_proc p
        where p.oid = 'ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)'::pg_catalog.regprocedure
          and p.prosecdef and p.proconfig = array['search_path=""']
          and pg_catalog.strpos(p.prosrc, 'ops.crm_create_whatsapp_lead') > 0
          and pg_catalog.strpos(p.prosrc, 'message_waiting') > 0)
     or not pg_catalog.has_function_privilege('ops_gateway',
              'ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)', 'EXECUTE')
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                      ('ops_operator_api')) as r (rolname)
                 where pg_catalog.has_function_privilege(r.rolname,
                         'ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)', 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'ops.receive_whatsapp_message(text, text, text, text, timestamptz, text)'::pg_catalog.regprocedure
                   and a.grantee = 0) then
    raise exception 'the receive function is not the gateway''s pinned DEFINER with the lead step';
  end if;

  -- The adapter, its read helper, the owner acts and the guards: INVOKERs no
  -- role reaches (PUBLIC included).
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array[
           'ops.crm_create_whatsapp_lead(uuid, uuid, uuid, uuid, text, text, timestamptz)'::pg_catalog.regprocedure,
           'ops.crm_phone_suffix_match(text)'::pg_catalog.regprocedure,
           'ops.record_crm_lead_policy(uuid, integer, text, text, text)'::pg_catalog.regprocedure,
           'ops.retire_crm_lead_policy(uuid, text, text)'::pg_catalog.regprocedure,
           'ops.guard_crm_lead_policy()'::pg_catalog.regprocedure,
           'ops.guard_crm_contact_act()'::pg_catalog.regprocedure])
     and (p.prosecdef
          or p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a lead function is reachable or not an INVOKER: %', v_bad;
  end if;

  -- The tables: row security on and forced, no role holds a privilege, the
  -- guards ALWAYS.
  if exists (select 1 from pg_catalog.pg_class c
              where c.oid in ('ops.crm_lead_policies'::pg_catalog.regclass, 'ops.crm_contact_acts'::pg_catalog.regclass)
                and not (c.relrowsecurity and c.relforcerowsecurity))
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname),
                              (values ('ops.crm_lead_policies'), ('ops.crm_contact_acts')) as t (relname)
                 where pg_catalog.has_table_privilege(r.rolname, t.relname, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) then
    raise exception 'a lead table is readable or writable by a role, or its row security is off';
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where t.tgrelid in ('ops.crm_lead_policies'::pg_catalog.regclass, 'ops.crm_contact_acts'::pg_catalog.regclass)
         and not t.tgisinternal and t.tgenabled = 'A') <> 4 then
    raise exception 'the lead tables do not carry exactly their four ALWAYS guards';
  end if;
  if exists (select 1 from ops.crm_lead_policies) then
    raise exception 'a lead policy shipped in a migration: the owner records it';
  end if;

  -- The browser knows the event and reads only its channel.
  if not ops.cos_event_known('lead.created')
     or ops.cos_event_facts(null, 'lead.created', '{"conversation_id": "00000000-0000-0000-0000-000000000000"}') ? 'conversation_id' then
    raise exception 'lead.created is not known to the browser, or it reads the conversation';
  end if;
end
$end_state$;
