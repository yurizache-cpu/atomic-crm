-- Phase 2B: the official WhatsApp Cloud API transport, and human-approved outbound.
--
-- WHAT THIS MIGRATION ADDS, and the boundary each part holds:
--
--   1. ops_gateway: a NOLOGIN role for the internet-facing webhook gateway. It
--      may execute exactly two SECURITY DEFINER functions (section 9) and
--      nothing else. The gateway verifies Meta's signature before it calls
--      either; the database never trusts a payload to name a tenant.
--   2. ops.communication_channels: the TRUSTED mapping from a provider target
--      (a WhatsApp phone number id) to one tenant, one company and the triage
--      agent. Owner-configured. A provider target maps to one channel across
--      ALL tenants, so a payload's target selects a tenant only through a row
--      the owner wrote. An unknown or inactive target fails closed.
--   3. ops.conversations: communication GROUPING (one channel, one contact).
--      NOT work: each inbound message still becomes its own task.
--   4. ops.inbound_messages gains the channel, the conversation and the CRM
--      resolution, and a Q8 gate: a row of any kind but `synthetic` is refused
--      unless its channel is configured `test`. While BASELINE Q8 is open no
--      production channel's content can become a task, and so none can reach
--      an agent run.
--   5. ops.outbound_messages: one explicitly requested send of one ACCEPTED
--      review's draft, with a state machine that never re-sends by itself.
--      The draft is NOT copied: the text sent is the review's immutable
--      `proposed.response_draft`.
--   6. ops.crm_contact_by_phone: the ONE read-only adapter over the CRM
--      (public.contacts, public.lead_profiles). No other ops code knows the
--      CRM's phone shape, and nothing here writes to public.*.
--   7. Owner services (SECURITY INVOKER, no application role): configure a
--      channel, request / begin / settle a send, mark a stale send
--      indeterminate. Only the owner's CLI calls them.
--
-- WHAT IT DELIBERATELY DOES NOT DO: send anything by itself, retry a send,
-- create or change a CRM record, admit production content, or add a job kind.

-- ---------------------------------------------------------------------------
-- 1. The gateway role.
-- ---------------------------------------------------------------------------

do $role$
begin
  if not exists (select 1 from pg_roles where rolname = 'ops_gateway') then
    create role ops_gateway nologin;
  end if;
end
$role$;

grant usage on schema ops to ops_gateway;

-- ---------------------------------------------------------------------------
-- 2. The trusted provider-target mapping.
-- ---------------------------------------------------------------------------

create table if not exists ops.communication_channels (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references ops.tenants (id) on delete restrict,
  company_id      uuid not null,
  -- The triage agent every admitted message is assigned to.
  agent_id        uuid not null,
  provider        text not null,
  -- The provider's own identifier for the receiving number: for Meta, the
  -- phone number id. Unique across tenants: one target, one owner.
  provider_target text not null,
  -- `test` carries synthetic traffic only and may create work. `production`
  -- may not create work or send while BASELINE Q8 is open (sections 4 and 8).
  mode            text not null,
  active          boolean not null default true,
  label           text not null,
  configured_by   text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint communication_channels_provider_check check (provider in ('meta_whatsapp')),
  constraint communication_channels_target_format check (provider_target ~ '^[0-9]{1,32}$'),
  constraint communication_channels_mode_check check (mode in ('test', 'production')),
  constraint communication_channels_label_format check (label ~ '^[\x20-\x7e]{1,100}$' and label ~ '\S'),
  constraint communication_channels_configured_by_format check (configured_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint communication_channels_target_key unique (provider, provider_target),
  constraint communication_channels_scope_id_key unique (tenant_id, company_id, id),
  constraint communication_channels_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint communication_channels_agent_fkey
    foreign key (tenant_id, company_id, agent_id) references ops.agents (tenant_id, company_id, id) on delete restrict
);

comment on table ops.communication_channels is
  'The trusted mapping from a provider target (a WhatsApp phone number id) to one tenant, company and triage agent. Owner-configured; a webhook payload selects a tenant only through a row here. mode = test carries synthetic traffic only; production creates no work and sends nothing while BASELINE Q8 is open.';

-- ---------------------------------------------------------------------------
-- 3. Conversations: grouping, not work.
-- ---------------------------------------------------------------------------

create table if not exists ops.conversations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references ops.tenants (id) on delete restrict,
  company_id      uuid not null,
  channel_id      uuid not null,
  -- The contact as the provider names it (a WhatsApp id: digits). Personal
  -- data, held once per conversation; an outbound message points here instead
  -- of copying it.
  contact_ref     text not null,
  last_inbound_at timestamptz,
  created_at      timestamptz not null default now(),
  constraint conversations_contact_ref_format check (contact_ref ~ '^[0-9]{6,20}$'),
  constraint conversations_identity_key unique (tenant_id, channel_id, contact_ref),
  constraint conversations_scope_id_key unique (tenant_id, company_id, id),
  constraint conversations_channel_fkey
    foreign key (tenant_id, company_id, channel_id)
    references ops.communication_channels (tenant_id, company_id, id) on delete restrict
);

comment on table ops.conversations is
  'Communication grouping: one channel, one contact. It links inbound and outbound messages; it is NOT a unit of work, carries no message content, and never merges tasks or prompts.';

-- ---------------------------------------------------------------------------
-- 4. The admission ledger learns the transport, behind the Q8 gate.
-- ---------------------------------------------------------------------------

alter table ops.inbound_messages add column if not exists channel_id uuid;
alter table ops.inbound_messages add column if not exists conversation_id uuid;
-- found | not_found | ambiguous | unavailable: what the read-only CRM adapter
-- answered at admission. NULL for a synthetic message, which has no CRM.
alter table ops.inbound_messages add column if not exists contact_resolution text;
-- An opaque reference to the CRM contact the adapter found. Text, never a
-- foreign key into public.* (CLAUDE.md rule 1).
alter table ops.inbound_messages add column if not exists crm_contact_ref text;

alter table ops.inbound_messages drop constraint if exists inbound_messages_source_kind_check;
alter table ops.inbound_messages add constraint inbound_messages_source_kind_check
  check (source_kind in ('synthetic', 'whatsapp'));
alter table ops.inbound_messages drop constraint if exists inbound_messages_transport_shape;
alter table ops.inbound_messages add constraint inbound_messages_transport_shape check (
     (source_kind = 'synthetic' and channel_id is null and conversation_id is null
      and contact_resolution is null and crm_contact_ref is null)
  or (source_kind = 'whatsapp' and channel_id is not null and conversation_id is not null
      and contact_resolution in ('found', 'not_found', 'ambiguous', 'unavailable')
      and (crm_contact_ref is null or crm_contact_ref ~ '^crm:contact:[0-9]{1,19}$')
      and (contact_resolution = 'found') = (crm_contact_ref is not null)));
alter table ops.inbound_messages drop constraint if exists inbound_messages_channel_fkey;
alter table ops.inbound_messages add constraint inbound_messages_channel_fkey
  foreign key (tenant_id, company_id, channel_id)
  references ops.communication_channels (tenant_id, company_id, id) on delete restrict;
alter table ops.inbound_messages drop constraint if exists inbound_messages_conversation_fkey;
alter table ops.inbound_messages add constraint inbound_messages_conversation_fkey
  foreign key (tenant_id, company_id, conversation_id)
  references ops.conversations (tenant_id, company_id, id) on delete restrict;

create index if not exists inbound_messages_conversation_idx
  on ops.inbound_messages (tenant_id, conversation_id)
  where conversation_id is not null;

comment on table ops.inbound_messages is
  'The admission ledger: proof that one inbound message becomes one unit of work. NOT an inbox. It holds no message body: the admitted body is the task description the runtime already bounds. A row of any source kind but synthetic is refused unless its channel is configured test (BASELINE Q8).';

-- The admission record stays immutable: the Phase 2A columns and the four
-- Phase 2B ones never change after insert.
create or replace function ops.guard_inbound_message_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.source_kind is distinct from old.source_kind
     or new.external_message_id is distinct from old.external_message_id
     or new.contact_ref is distinct from old.contact_ref
     or new.do_not_contact is distinct from old.do_not_contact
     or new.body_fingerprint is distinct from old.body_fingerprint
     or new.received_at is distinct from old.received_at
     or new.created_at is distinct from old.created_at
     or new.channel_id is distinct from old.channel_id
     or new.conversation_id is distinct from old.conversation_id
     or new.contact_resolution is distinct from old.contact_resolution
     or new.crm_contact_ref is distinct from old.crm_contact_ref then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: an admission record is immutable apart from the work it links to';
  end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: the admitted task is set once';
  end if;
  if old.agent_run_id is not null and new.agent_run_id is distinct from old.agent_run_id then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: the admitted agent run is set once';
  end if;
  return new;
end
$function$;

-- THE Q8 GATE, in the database. A transport row is admitted only from a
-- channel configured `test`: while BASELINE Q8 is open, no production content
-- can become a task, and so none can reach an agent run. Opening this gate is
-- a reviewed migration after the owner decides Q8, never configuration.
create or replace function ops.guard_inbound_message_q8()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.source_kind <> 'synthetic' and not exists (
    select 1 from ops.communication_channels c
     where c.id = new.channel_id and c.tenant_id = new.tenant_id and c.mode = 'test') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: BASELINE Q8 is open; only a channel configured test may admit a message as work';
  end if;
  return new;
end
$function$;

drop trigger if exists inbound_messages_q8_gate on ops.inbound_messages;
create trigger inbound_messages_q8_gate
  before insert on ops.inbound_messages
  for each row execute function ops.guard_inbound_message_q8();
alter table ops.inbound_messages enable always trigger inbound_messages_q8_gate;

-- ---------------------------------------------------------------------------
-- 5. Outbound: one explicitly requested send of one accepted review.
-- ---------------------------------------------------------------------------

create table if not exists ops.outbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references ops.tenants (id) on delete restrict,
  company_id          uuid not null,
  channel_id          uuid not null,
  conversation_id     uuid not null,
  -- One send per accepted review. The text sent is that review's immutable
  -- proposed.response_draft, read at send time and never copied here.
  review_item_id      uuid not null,
  task_id             uuid not null,
  status              text not null,
  requested_by        text not null,
  -- What the read-only CRM adapter and the eligibility rule answered when the
  -- send was authorized, and again immediately before the provider call. Ids
  -- and states only.
  authorized_check    jsonb not null,
  send_check          jsonb,
  blocked_reason      text,
  -- The provider's message id (for Meta, a wamid), once known.
  provider_message_id text,
  -- A sanitised provider error: a numeric code and a class, never provider text.
  error_code          text,
  error_class         text,
  authorized_at       timestamptz not null default now(),
  sending_at          timestamptz,
  settled_at          timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint outbound_messages_status_check check (
    status in ('authorized', 'blocked', 'sending', 'sent', 'delivered', 'read', 'failed', 'indeterminate')),
  constraint outbound_messages_requested_by_format check (requested_by ~ '^[\x21-\x7e][\x20-\x7e]{0,199}$'),
  constraint outbound_messages_blocked_reason_format check (
    (status = 'blocked') = (blocked_reason is not null)
    and (blocked_reason is null or blocked_reason ~ '^[a-z][a-z0-9_]{0,63}$')),
  constraint outbound_messages_provider_id_format check (
    provider_message_id is null or provider_message_id ~ '^[\x21-\x7e]{1,200}$'),
  constraint outbound_messages_provider_id_when_sent check (
    status not in ('sent', 'delivered', 'read') or provider_message_id is not null),
  constraint outbound_messages_error_format check (
    (error_code is null or error_code ~ '^[0-9]{1,10}$')
    and (error_class is null or error_class ~ '^[a-z][a-z0-9_]{0,63}$')),
  constraint outbound_messages_sending_stamped check (
    status in ('authorized', 'blocked') or sending_at is not null),
  constraint outbound_messages_review_key unique (review_item_id),
  constraint outbound_messages_provider_id_key unique (tenant_id, provider_message_id),
  constraint outbound_messages_scope_id_key unique (tenant_id, company_id, id),
  constraint outbound_messages_channel_fkey
    foreign key (tenant_id, company_id, channel_id)
    references ops.communication_channels (tenant_id, company_id, id) on delete restrict,
  constraint outbound_messages_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id)
    references ops.conversations (tenant_id, company_id, id) on delete restrict,
  constraint outbound_messages_review_fkey
    foreign key (tenant_id, company_id, review_item_id)
    references ops.review_items (tenant_id, company_id, id) on delete restrict,
  constraint outbound_messages_task_fkey
    foreign key (tenant_id, company_id, task_id)
    references ops.tasks (tenant_id, company_id, id) on delete restrict
);

comment on table ops.outbound_messages is
  'One explicitly requested send of one ACCEPTED review draft. Created only by ops.request_outbound_send, moved only by the owner services and by provider status callbacks, never re-sent by the system. authorized -> sending -> sent | failed | indeterminate; blocked when the fresh check refuses; an indeterminate send is resolved only by provider evidence.';

create index if not exists outbound_messages_status_idx
  on ops.outbound_messages (tenant_id, status, updated_at);

-- The state machine. Identity never changes; status moves only along these
-- edges; and a send, once it may have left, is never made sendable again.
create or replace function ops.guard_outbound_message()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'authorized' then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: a send begins authorized';
    end if;
    if not exists (select 1 from ops.communication_channels c
                    where c.id = new.channel_id and c.tenant_id = new.tenant_id and c.mode = 'test') then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: BASELINE Q8 is open; only a channel configured test may send';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.channel_id is distinct from old.channel_id
     or new.conversation_id is distinct from old.conversation_id
     or new.review_item_id is distinct from old.review_item_id
     or new.task_id is distinct from old.task_id
     or new.authorized_at is distinct from old.authorized_at
     or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: what was authorized is immutable';
  end if;
  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the provider message id is set once';
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'authorized'    and new.status in ('sending', 'blocked'))
    or (old.status = 'blocked'       and new.status = 'authorized')
    or (old.status = 'sending'       and new.status in ('sent', 'failed', 'indeterminate', 'delivered', 'read'))
    or (old.status = 'indeterminate' and new.status in ('sent', 'delivered', 'read', 'failed'))
    or (old.status = 'sent'          and new.status in ('delivered', 'read', 'failed'))
    or (old.status = 'delivered'     and new.status = 'read')
    -- The provider can report one message both failed and delivered (several
    -- devices); delivered means at least one device received it, so delivery
    -- evidence wins over an earlier failure.
    or (old.status = 'failed'        and new.status in ('delivered', 'read'))) then
    raise exception using errcode = 'OS409',
      message = format('ops.outbound_messages: a send cannot move from %s to %s', old.status, new.status);
  end if;
  if new.status = 'sending' and old.status <> 'sending' and not exists (
    select 1 from ops.communication_channels c
     where c.id = new.channel_id and c.tenant_id = new.tenant_id and c.mode = 'test' and c.active) then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: BASELINE Q8 is open; only an active channel configured test may send';
  end if;
  new.updated_at := now();
  return new;
end
$function$;

drop trigger if exists outbound_messages_guard on ops.outbound_messages;
create trigger outbound_messages_guard
  before insert or update on ops.outbound_messages
  for each row execute function ops.guard_outbound_message();
alter table ops.outbound_messages enable always trigger outbound_messages_guard;

-- Channel and conversation identities never change.
create or replace function ops.guard_communication_identity()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_table_name = 'communication_channels' then
    if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
       or new.company_id is distinct from old.company_id or new.provider is distinct from old.provider
       or new.provider_target is distinct from old.provider_target
       or new.created_at is distinct from old.created_at then
      raise exception using errcode = 'OS403',
        message = 'ops.communication_channels: a channel''s tenant, company and provider target are immutable';
    end if;
    new.updated_at := now();
  elsif new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id or new.channel_id is distinct from old.channel_id
     or new.contact_ref is distinct from old.contact_ref or new.created_at is distinct from old.created_at then
    raise exception using errcode = 'OS403',
      message = 'ops.conversations: a conversation''s identity is immutable';
  end if;
  return new;
end
$function$;

drop trigger if exists communication_channels_guard_update on ops.communication_channels;
create trigger communication_channels_guard_update
  before update on ops.communication_channels
  for each row execute function ops.guard_communication_identity();
alter table ops.communication_channels enable always trigger communication_channels_guard_update;

drop trigger if exists conversations_guard_update on ops.conversations;
create trigger conversations_guard_update
  before update on ops.conversations
  for each row execute function ops.guard_communication_identity();
alter table ops.conversations enable always trigger conversations_guard_update;

-- Backend only, as every ops table.
alter table ops.communication_channels enable row level security;
alter table ops.communication_channels force  row level security;
alter table ops.conversations          enable row level security;
alter table ops.conversations          force  row level security;
alter table ops.outbound_messages      enable row level security;
alter table ops.outbound_messages      force  row level security;

-- ---------------------------------------------------------------------------
-- 6. The read-only CRM adapter. The ONE place ops code knows the CRM's shape.
--
--    CONSENT SEMANTICS, as the CRM actually records them: the CRM has one
--    consent-related field, lead_profiles.do_not_contact, an OPT-OUT flag that
--    defaults to false. It is NOT a record of affirmative consent, and this
--    adapter never presents it as one: it reports what it found, and the
--    eligibility rule (section 7) decides.
--
--    MATCHING: a WhatsApp id is the sender's number as digits with its country
--    code. A CRM contact matches when one of its phone numbers, reduced to
--    digits, is exactly that string. Nothing is guessed: a number stored
--    without its country code does not match, two matching contacts are
--    `ambiguous`, and only the tenant that owns this deployment's CRM
--    (ops.tenants.owns_local_crm) can read it at all.
-- ---------------------------------------------------------------------------

create or replace function ops.crm_contact_by_phone(p_tenant_id uuid, p_phone text)
returns jsonb
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_count integer;
  v_id    bigint;
  v_dnc   boolean;
begin
  if p_tenant_id is null or p_phone is null or p_phone !~ '^[0-9]{6,20}$' then
    return jsonb_build_object('state', 'not_found');
  end if;
  if not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return jsonb_build_object('state', 'unavailable');
  end if;

  select count(*), min(c.id) into v_count, v_id
    from public.contacts c
   where exists (
     select 1
       from jsonb_array_elements(
              case when jsonb_typeof(c.phone_jsonb) = 'array' then c.phone_jsonb else '[]'::jsonb end) e
      where jsonb_typeof(e) = 'object'
        and regexp_replace(coalesce(e ->> 'number', ''), '[^0-9]', '', 'g') = p_phone);

  if v_count = 0 then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_count > 1 then
    return jsonb_build_object('state', 'ambiguous');
  end if;

  select lp.do_not_contact into v_dnc
    from public.lead_profiles lp
   where lp.contact_id = v_id;

  -- A contact with no lead profile has no recorded opt-out state: null, and
  -- the eligibility rule treats null as unknown, never as "may contact".
  return jsonb_build_object(
    'state', 'found',
    'crm_contact_ref', 'crm:contact:' || v_id,
    'do_not_contact', v_dnc);
end
$function$;

comment on function ops.crm_contact_by_phone(uuid, text) is
  'The read-only CRM adapter: resolves a WhatsApp id (digits) to at most one CRM contact and reports its do_not_contact opt-out flag. found | not_found | ambiguous | unavailable. Never writes; never guesses; only the tenant that owns the local CRM can read it.';

-- ---------------------------------------------------------------------------
-- 7. Eligibility to send, evaluated FRESH at every act.
--
--    A reply may be sent only when ALL hold, read now:
--      * the channel is active and configured test (BASELINE Q8);
--      * no active execution stop covers the tenant or company (the kill switch);
--      * the CRM resolves the contact to exactly one contact;
--      * that contact's opt-out flag is recorded and false;
--      * the contact wrote on this conversation within the last 24 hours, so the
--        reply answers a conversation the contact opened (the provider's
--        customer-service window).
--    The admission's snapshot never authorizes a send.
-- ---------------------------------------------------------------------------

create or replace function ops.whatsapp_send_eligibility(p_tenant_id uuid, p_conversation_id uuid)
returns jsonb
language plpgsql
volatile
security invoker
set search_path to ''
as $function$
declare
  v_conv    ops.conversations;
  v_channel ops.communication_channels;
  v_crm     jsonb;
  v_stop    uuid;
  v_reason  text;
begin
  select * into v_conv from ops.conversations
   where id = p_conversation_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'conversation_not_found');
  end if;
  select * into v_channel from ops.communication_channels
   where id = v_conv.channel_id and tenant_id = p_tenant_id;

  -- The kill switch, read under its lock as every other gate reads it.
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  select s.id into v_stop
    from ops.execution_stops s
   where s.cleared_at is null
     and (s.scope = 'global'
          or (s.scope = 'tenant' and s.tenant_id = p_tenant_id)
          or (s.scope = 'company' and s.tenant_id = p_tenant_id and s.company_id = v_conv.company_id))
   limit 1;

  v_crm := ops.crm_contact_by_phone(p_tenant_id, v_conv.contact_ref);

  v_reason := case
    when not v_channel.active then 'channel_inactive'
    when v_channel.mode <> 'test' then 'q8_production_channel'
    when v_stop is not null then 'execution_stopped'
    when v_crm ->> 'state' = 'unavailable' then 'crm_unavailable'
    when v_crm ->> 'state' = 'not_found' then 'contact_not_found'
    when v_crm ->> 'state' = 'ambiguous' then 'contact_ambiguous'
    when v_crm -> 'do_not_contact' is null or jsonb_typeof(v_crm -> 'do_not_contact') <> 'boolean' then 'consent_unknown'
    when (v_crm ->> 'do_not_contact')::boolean then 'do_not_contact'
    when v_conv.last_inbound_at is null or v_conv.last_inbound_at < now() - interval '24 hours' then 'outside_service_window'
    else null
  end;

  return jsonb_build_object(
    'eligible', v_reason is null,
    'reason', v_reason,
    'contact', v_crm ->> 'state',
    'crm_contact_ref', v_crm ->> 'crm_contact_ref',
    'do_not_contact', v_crm -> 'do_not_contact',
    'stop_id', v_stop,
    'checked_at', now());
end
$function$;

comment on function ops.whatsapp_send_eligibility(uuid, uuid) is
  'Whether a reply may be sent on a conversation NOW: active test channel (BASELINE Q8), no covering execution stop, exactly one CRM contact whose opt-out flag is recorded false, and a contact message within the last 24 hours. Fail closed on every unknown.';

-- ---------------------------------------------------------------------------
-- 8. Admission, shared. ops.admit_inbound_message keeps its signature and
--    stays synthetic-only; the WhatsApp gateway reaches the same core through
--    ops.receive_whatsapp_message.
-- ---------------------------------------------------------------------------

create or replace function ops.admit_inbound_core(
  p_tenant_id           uuid,
  p_company_id          uuid,
  p_agent_id            uuid,
  p_source_kind         text,
  p_external_message_id text,
  p_contact_ref         text,
  p_body                text,
  p_source              text,
  p_do_not_contact      boolean,
  p_received_at         timestamptz,
  p_channel_id          uuid,
  p_conversation_id     uuid,
  p_contact_resolution  text,
  p_crm_contact_ref     text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_fingerprint text;
  v_key         text;
  v_id          uuid;
  v_existing    ops.inbound_messages;
  v_task        uuid;
  v_run         uuid;
begin
  if p_tenant_id is null or p_company_id is null then
    raise exception using errcode = 'OS401', message = 'admission: no tenant scope';
  end if;
  if p_source_kind is null or p_source_kind not in ('synthetic', 'whatsapp') then
    raise exception using errcode = 'OS403', message = 'admission: unknown source kind';
  end if;
  if p_external_message_id is null or p_external_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400',
      message = 'admission: an external message id is 1 to 200 printable characters';
  end if;
  if p_contact_ref is null or p_contact_ref !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400',
      message = 'admission: a contact reference is 1 to 200 printable characters';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'admission: the source is missing or malformed';
  end if;
  -- Bounded well below the task description's 10000, so an oversize body is a
  -- typed refusal here rather than a CHECK violation whose DETAIL would print it.
  if p_body is null or p_body !~ '\S' or char_length(p_body) > 4000 then
    raise exception using errcode = 'OS400',
      message = 'admission: the message body is empty or longer than 4000 characters';
  end if;
  if p_received_at is null or p_received_at > now() + interval '1 minute' then
    raise exception using errcode = 'OS400', message = 'admission: received_at is missing or in the future';
  end if;

  perform 1 from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'admission: company not found in this tenant';
  end if;

  -- Injective: every field is its own element of a jsonb array.
  v_fingerprint := encode(sha256(convert_to(
    jsonb_build_array('inbound.v2', p_source_kind, p_contact_ref, p_body)::text, 'UTF8')), 'hex');
  v_key := format('inbound:%s:%s', p_source_kind,
                  encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex'));

  insert into ops.inbound_messages (
    tenant_id, company_id, source_kind, external_message_id,
    contact_ref, do_not_contact, body_fingerprint, received_at,
    channel_id, conversation_id, contact_resolution, crm_contact_ref)
  values (
    p_tenant_id, p_company_id, p_source_kind, p_external_message_id,
    p_contact_ref, coalesce(p_do_not_contact, true), v_fingerprint, p_received_at,
    p_channel_id, p_conversation_id, p_contact_resolution, p_crm_contact_ref)
  on conflict (tenant_id, source_kind, external_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    select m.* into v_existing
      from ops.inbound_messages m
     where m.tenant_id = p_tenant_id
       and m.source_kind = p_source_kind
       and m.external_message_id = p_external_message_id
       for update;
    if not found then
      raise exception using errcode = 'OS429',
        message = 'admission: the admission this message conflicted with no longer exists; retry';
    end if;
    if v_existing.body_fingerprint <> v_fingerprint then
      raise exception using errcode = 'OS409',
        message = 'admission: that message id was already admitted with a different message';
    end if;
    if v_existing.company_id <> p_company_id
       or v_existing.channel_id is distinct from p_channel_id then
      raise exception using errcode = 'OS409',
        message = 'admission: that message id was already admitted for another company or channel';
    end if;
    if v_existing.task_id is not null and v_existing.agent_run_id is not null then
      -- A replay: answer with the work it already became, and do nothing else.
      return jsonb_build_object(
        'inbound_message_id', v_existing.id,
        'task_id', v_existing.task_id,
        'agent_run_id', v_existing.agent_run_id,
        'replayed', true);
    end if;
    v_id := v_existing.id;
  end if;

  -- The task carries the body, because the runtime's prompt context is built
  -- from the task. The title is a constant: no sender reaches the prompt.
  v_task := ops.create_task(
    p_tenant_id, p_company_id, 'lead_triage', 'Lead triage', p_source, p_body,
    null, null, 100, null, null, null, v_key);

  perform ops.assign_task(p_tenant_id, v_task, p_agent_id, p_source);

  v_run := ops.request_agent_run(
    p_tenant_id, v_task, p_agent_id, 'lead_triage', v_key, p_source);

  update ops.inbound_messages
     set task_id = coalesce(task_id, v_task),
         agent_run_id = coalesce(agent_run_id, v_run)
   where id = v_id;

  -- Identifiers and shape only: never the body, the sender or a fingerprint.
  perform ops.record_event(
    p_tenant_id, p_company_id, 'communication.received', p_source, 'task', v_task,
    jsonb_strip_nulls(jsonb_build_object(
      'inbound_message_id', v_id,
      'source_kind', p_source_kind,
      'conversation_id', p_conversation_id,
      'contact_resolution', p_contact_resolution,
      'do_not_contact', coalesce(p_do_not_contact, true))),
    null, null, format('%s:received', v_key));

  perform ops.record_event(
    p_tenant_id, p_company_id, 'lead_triage.admitted', p_source, 'task', v_task,
    jsonb_build_object('inbound_message_id', v_id, 'agent_run_id', v_run),
    null, null, format('%s:admitted', v_key));

  return jsonb_build_object(
    'inbound_message_id', v_id,
    'task_id', v_task,
    'agent_run_id', v_run,
    'replayed', false);
end
$function$;

comment on function ops.admit_inbound_core(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz, uuid, uuid, text, text) is
  'The one admission: one ledger row, one lead_triage task, one requested agent run, on one tenant-scoped identity. A redelivery is a lookup; a reused id with a different message is refused. Executable by no application role; reached through ops.admit_inbound_message (synthetic) and ops.receive_whatsapp_message (WhatsApp).';

create or replace function ops.admit_inbound_message(
  p_tenant_id           uuid,
  p_company_id          uuid,
  p_agent_id            uuid,
  p_source_kind         text,
  p_external_message_id text,
  p_contact_ref         text,
  p_body                text,
  p_source              text,
  p_do_not_contact      boolean default true,
  p_received_at         timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_result jsonb;
begin
  if p_tenant_id is null or p_company_id is null then
    raise exception using errcode = 'OS401', message = 'ops.admit_inbound_message: no tenant scope';
  end if;
  if p_source_kind is null or p_source_kind <> 'synthetic' then
    raise exception using
      errcode = 'OS403',
      message = 'ops.admit_inbound_message: only synthetic messages are admitted through this service';
  end if;
  v_result := ops.admit_inbound_core(
    p_tenant_id, p_company_id, p_agent_id, p_source_kind, p_external_message_id,
    p_contact_ref, p_body, p_source, coalesce(p_do_not_contact, true), p_received_at,
    null, null, null, null);
  -- Its Phase 2A answer, exactly: three ids.
  return v_result - 'replayed';
end
$function$;

comment on function ops.admit_inbound_message(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz) is
  'Admits one synthetic inbound message through the shared admission core. A redelivery is a lookup; a reused id with a different message is refused. Creates work only; never calls a model. Consent is the caller''s trusted answer, and an unstated one is do-not-contact.';

-- ---------------------------------------------------------------------------
-- 9. The gateway's two functions. SECURITY DEFINER because the gateway role
--    holds nothing else; each resolves the tenant from the provider target
--    through ops.communication_channels and takes no tenant argument.
-- ---------------------------------------------------------------------------

create or replace function ops.receive_whatsapp_message(
  p_provider_target     text,
  p_external_message_id text,
  p_from                text,
  p_body                text,
  p_received_at         timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_channel ops.communication_channels;
  v_crm     jsonb;
  v_dnc     boolean;
  v_conv    uuid;
  v_result  jsonb;
begin
  if p_provider_target is null or p_provider_target !~ '^[0-9]{1,32}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed provider target';
  end if;
  if p_from is null or p_from !~ '^[0-9]{6,20}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed sender id';
  end if;
  if p_external_message_id is null or p_external_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed message id';
  end if;

  -- The TRUSTED mapping. Nothing in the payload names a tenant.
  select * into v_channel from ops.communication_channels c
   where c.provider = 'meta_whatsapp' and c.provider_target = p_provider_target and c.active;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.receive_whatsapp_message: unknown or inactive provider target';
  end if;

  -- BASELINE Q8: a production channel's content never becomes work. The fact
  -- that something arrived is recorded; what it said is not stored at all.
  if v_channel.mode <> 'test' then
    perform ops.record_event(
      v_channel.tenant_id, v_channel.company_id, 'communication.inbound_held', 'whatsapp-gateway',
      'company', v_channel.company_id,
      jsonb_build_object('channel_id', v_channel.id, 'reason', 'q8_production_channel'),
      null, null,
      format('whatsapp:held:%s', encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex')));
    return jsonb_build_object('state', 'held', 'reason', 'q8_production_channel');
  end if;

  v_crm := ops.crm_contact_by_phone(v_channel.tenant_id, p_from);
  -- Only a single CRM contact with a recorded, false opt-out is eligible at
  -- admission; every other answer is do-not-contact.
  v_dnc := not (v_crm ->> 'state' = 'found'
                and jsonb_typeof(v_crm -> 'do_not_contact') = 'boolean'
                and not (v_crm ->> 'do_not_contact')::boolean);

  insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
  values (v_channel.tenant_id, v_channel.company_id, v_channel.id, p_from, p_received_at)
  on conflict (tenant_id, channel_id, contact_ref) do update
    set last_inbound_at = greatest(ops.conversations.last_inbound_at, excluded.last_inbound_at)
  returning id into v_conv;

  v_result := ops.admit_inbound_core(
    v_channel.tenant_id, v_channel.company_id, v_channel.agent_id, 'whatsapp',
    p_external_message_id, p_from, p_body, 'whatsapp-gateway', v_dnc, p_received_at,
    v_channel.id, v_conv, v_crm ->> 'state', v_crm ->> 'crm_contact_ref');

  return v_result || jsonb_build_object('state', 'admitted', 'conversation_id', v_conv);
end
$function$;

comment on function ops.receive_whatsapp_message(text, text, text, text, timestamptz) is
  'The gateway''s inbound entry, called only after the gateway verified the provider signature. Resolves tenant, company and agent from the provider target through ops.communication_channels (never the payload), holds a production channel''s message without storing it (BASELINE Q8), resolves the contact read-only, and admits through the shared core. A redelivery is a lookup.';

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

  if v_out.id is null then
    return jsonb_build_object('state', 'unmatched');
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

  return jsonb_build_object('state', 'updated', 'status', v_next, 'previous', v_out.status);
end
$function$;

comment on function ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text) is
  'The gateway''s status entry. Resolves the tenant from the provider target, matches the send by provider message id (or, for a send whose response was lost, by the correlation this system sent and the recipient), and only ever moves a send forward: duplicates and older news change nothing.';

-- ---------------------------------------------------------------------------
-- 10. Owner services. SECURITY INVOKER; no application role may execute them.
-- ---------------------------------------------------------------------------

create or replace function ops.configure_whatsapp_channel(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_agent_id        uuid,
  p_provider_target text,
  p_mode            text,
  p_label           text,
  p_actor           text,
  p_active          boolean default true
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_existing ops.communication_channels;
  v_id       uuid;
begin
  if p_tenant_id is null or p_company_id is null or p_agent_id is null then
    raise exception using errcode = 'OS401', message = 'ops.configure_whatsapp_channel: no scope';
  end if;
  select * into v_existing from ops.communication_channels
   where provider = 'meta_whatsapp' and provider_target = p_provider_target
     for update;
  if found then
    if v_existing.tenant_id <> p_tenant_id or v_existing.company_id <> p_company_id then
      raise exception using errcode = 'OS409',
        message = 'ops.configure_whatsapp_channel: that provider target belongs to another tenant or company';
    end if;
    update ops.communication_channels
       set agent_id = p_agent_id, mode = p_mode, label = p_label,
           configured_by = p_actor, active = coalesce(p_active, true)
     where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into ops.communication_channels (
      tenant_id, company_id, agent_id, provider, provider_target, mode, label, configured_by, active)
    values (p_tenant_id, p_company_id, p_agent_id, 'meta_whatsapp', p_provider_target, p_mode, p_label,
            p_actor, coalesce(p_active, true))
    returning id into v_id;
  end if;

  perform ops.record_event(
    p_tenant_id, p_company_id, 'communication.channel_configured', 'operator-cli', 'company', p_company_id,
    jsonb_build_object('channel_id', v_id, 'mode', p_mode, 'active', coalesce(p_active, true)));
  return v_id;
end
$function$;

-- Asks for a send of an ACCEPTED review. Idempotent per review: a second
-- request answers with the first. Refuses, and records nothing, unless the
-- fresh eligibility check passes now. Never calls a provider.
create or replace function ops.request_outbound_send(
  p_tenant_id    uuid,
  p_review_id    uuid,
  p_requested_by text,
  p_source       text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_review  ops.review_items;
  v_inbound ops.inbound_messages;
  v_out     ops.outbound_messages;
  v_check   jsonb;
  v_id      uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.request_outbound_send: no tenant scope';
  end if;
  if p_requested_by is null or p_requested_by !~ '^[\x21-\x7e][\x20-\x7e]{0,199}$' then
    raise exception using errcode = 'OS400', message = 'ops.request_outbound_send: the operator label is missing or malformed';
  end if;

  select * into v_review from ops.review_items
   where id = p_review_id and tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.request_outbound_send: review not found in this tenant';
  end if;
  if v_review.status <> 'accepted' then
    raise exception using errcode = 'OS409',
      message = format('ops.request_outbound_send: only an accepted review can be sent; this one is %s', v_review.status);
  end if;

  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = p_tenant_id and m.task_id = v_review.task_id and m.source_kind = 'whatsapp'
   order by m.received_at desc
   limit 1;
  if not found then
    raise exception using errcode = 'OS409',
      message = 'ops.request_outbound_send: this review did not come from a transport that can reply';
  end if;

  select * into v_out from ops.outbound_messages
   where review_item_id = v_review.id and tenant_id = p_tenant_id
     for update;
  if found and v_out.status <> 'blocked' then
    return jsonb_build_object('outbound_message_id', v_out.id, 'status', v_out.status, 'created', false);
  end if;

  v_check := ops.whatsapp_send_eligibility(p_tenant_id, v_inbound.conversation_id);
  if not (v_check ->> 'eligible')::boolean then
    raise exception using errcode = 'OS403',
      message = format('ops.request_outbound_send: refused: %s', v_check ->> 'reason');
  end if;

  if v_out.id is not null then
    -- A blocked send asked for again, and eligible now.
    update ops.outbound_messages
       set status = 'authorized', blocked_reason = null, requested_by = p_requested_by,
           authorized_check = v_check
     where id = v_out.id;
    v_id := v_out.id;
  else
    insert into ops.outbound_messages (
      tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
      status, requested_by, authorized_check)
    values (
      p_tenant_id, v_review.company_id, v_inbound.channel_id, v_inbound.conversation_id, v_review.id,
      v_review.task_id, 'authorized', p_requested_by, v_check)
    on conflict (review_item_id) do nothing
    returning id into v_id;
    if v_id is null then
      -- A concurrent request won; answer with its send.
      select * into v_out from ops.outbound_messages where review_item_id = v_review.id;
      return jsonb_build_object('outbound_message_id', v_out.id, 'status', v_out.status, 'created', false);
    end if;
  end if;

  perform ops.record_event(
    p_tenant_id, v_review.company_id, 'communication.outbound_authorized', p_source, 'task', v_review.task_id,
    jsonb_build_object('outbound_message_id', v_id, 'review_item_id', v_review.id));
  return jsonb_build_object('outbound_message_id', v_id, 'status', 'authorized', 'created', true);
end
$function$;

-- The last gate before a provider call, in the transaction that COMMITS
-- `sending` before the call leaves the process. Re-checks eligibility now; a
-- refusal is recorded as `blocked` and nothing is sent. Answers the recipient
-- and the text only when the caller may call.
create or replace function ops.begin_outbound_send(p_tenant_id uuid, p_outbound_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out     ops.outbound_messages;
  v_conv    ops.conversations;
  v_channel ops.communication_channels;
  v_review  ops.review_items;
  v_check   jsonb;
begin
  select * into v_out from ops.outbound_messages
   where id = p_outbound_id and tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.begin_outbound_send: send not found in this tenant';
  end if;
  if v_out.status <> 'authorized' then
    -- Another attempt already began it, or it is settled: never a second call.
    return jsonb_build_object('state', v_out.status);
  end if;

  v_check := ops.whatsapp_send_eligibility(p_tenant_id, v_out.conversation_id);
  if not (v_check ->> 'eligible')::boolean then
    update ops.outbound_messages
       set status = 'blocked', blocked_reason = v_check ->> 'reason', send_check = v_check
     where id = v_out.id;
    perform ops.record_event(
      p_tenant_id, v_out.company_id, 'communication.outbound_blocked', 'operator-cli', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id, 'reason', v_check ->> 'reason'));
    return jsonb_build_object('state', 'blocked', 'reason', v_check ->> 'reason');
  end if;

  select * into v_conv from ops.conversations where id = v_out.conversation_id;
  select * into v_channel from ops.communication_channels where id = v_out.channel_id;
  select * into v_review from ops.review_items where id = v_out.review_item_id;

  update ops.outbound_messages
     set status = 'sending', sending_at = now(), send_check = v_check
   where id = v_out.id;
  perform ops.record_event(
    p_tenant_id, v_out.company_id, 'communication.outbound_attempted', 'operator-cli', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id));

  return jsonb_build_object(
    'state', 'send',
    'outbound_message_id', v_out.id,
    'provider_target', v_channel.provider_target,
    'to', v_conv.contact_ref,
    'body', v_review.proposed ->> 'response_draft');
end
$function$;

-- Records what the ONE provider call produced. Only a send still `sending` is
-- settled here; one a status callback already moved is left as it is.
create or replace function ops.settle_outbound_send(
  p_tenant_id           uuid,
  p_outbound_id         uuid,
  p_outcome             text,
  p_provider_message_id text,
  p_error_code          text,
  p_error_class         text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out ops.outbound_messages;
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'indeterminate') then
    raise exception using errcode = 'OS400', message = 'ops.settle_outbound_send: unknown outcome';
  end if;
  if p_outcome = 'sent' and (p_provider_message_id is null or p_provider_message_id !~ '^[\x21-\x7e]{1,200}$') then
    raise exception using errcode = 'OS400', message = 'ops.settle_outbound_send: a sent message needs its provider id';
  end if;

  select * into v_out from ops.outbound_messages
   where id = p_outbound_id and tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.settle_outbound_send: send not found in this tenant';
  end if;
  if v_out.status <> 'sending' then
    return jsonb_build_object('state', v_out.status, 'settled', false);
  end if;

  update ops.outbound_messages
     set status              = p_outcome,
         provider_message_id = case when p_outcome = 'sent' then p_provider_message_id else provider_message_id end,
         settled_at          = now(),
         error_code          = case when p_outcome = 'sent' then null
                                    else nullif(substring(coalesce(p_error_code, '') from '^[0-9]{1,10}$'), '') end,
         error_class         = case when p_outcome = 'sent' then null
                                    else nullif(substring(coalesce(p_error_class, '') from '^[a-z][a-z0-9_]{0,63}$'), '') end
   where id = v_out.id;

  perform ops.record_event(
    p_tenant_id, v_out.company_id, 'communication.outbound_' || p_outcome, 'operator-cli', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id));
  return jsonb_build_object('state', p_outcome, 'settled', true);
end
$function$;

-- A send left `sending` by a process that died after the call may have been
-- delivered. After the client's own timeout has certainly passed, a person may
-- record that it is unknown. Nothing is sent again; a status callback can still
-- resolve it.
create or replace function ops.mark_outbound_indeterminate(
  p_tenant_id   uuid,
  p_outbound_id uuid,
  p_actor       text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out ops.outbound_messages;
begin
  select * into v_out from ops.outbound_messages
   where id = p_outbound_id and tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.mark_outbound_indeterminate: send not found in this tenant';
  end if;
  if v_out.status <> 'sending' then
    raise exception using errcode = 'OS409',
      message = format('ops.mark_outbound_indeterminate: only a send left sending can be marked; this one is %s', v_out.status);
  end if;
  if v_out.sending_at > now() - interval '5 minutes' then
    raise exception using errcode = 'OS409',
      message = 'ops.mark_outbound_indeterminate: the send began less than five minutes ago and may still be in flight';
  end if;
  update ops.outbound_messages
     set status = 'indeterminate', settled_at = now(), error_class = 'interrupted'
   where id = v_out.id;
  perform ops.record_event(
    p_tenant_id, v_out.company_id, 'communication.outbound_indeterminate', 'operator-cli', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id, 'marked_by', p_actor));
  return jsonb_build_object('state', 'indeterminate');
end
$function$;

-- ---------------------------------------------------------------------------
-- 11. Access.
-- ---------------------------------------------------------------------------

revoke all on table ops.communication_channels, ops.conversations, ops.outbound_messages
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function ops.crm_contact_by_phone(uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.whatsapp_send_eligibility(uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.admit_inbound_core(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz, uuid, uuid, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.admit_inbound_message(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.configure_whatsapp_channel(uuid, uuid, uuid, text, text, text, text, boolean)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.request_outbound_send(uuid, uuid, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.begin_outbound_send(uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.settle_outbound_send(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.mark_outbound_indeterminate(uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.guard_inbound_message_q8() from public;
revoke all on function ops.guard_outbound_message() from public;
revoke all on function ops.guard_communication_identity() from public;

revoke all on function ops.receive_whatsapp_message(text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role, ops_worker;
revoke all on function ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)
  from public, anon, authenticated, service_role, ops_worker;
grant execute on function ops.receive_whatsapp_message(text, text, text, text, timestamptz) to ops_gateway;
grant execute on function ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text) to ops_gateway;

-- ---------------------------------------------------------------------------
-- 12. Assert the end state.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- The gateway role: no login here, no blanket attribute, no table privilege
  -- anywhere in ops, and EXACTLY the two gateway functions.
  if not exists (select 1 from pg_roles r where r.rolname = 'ops_gateway'
                  and not r.rolcanlogin and not r.rolsuper and not r.rolbypassrls
                  and not r.rolcreaterole and not r.rolcreatedb) then
    raise exception 'ops_gateway is missing or carries a login or a blanket attribute';
  end if;
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where n.nspname = 'ops' and c.relkind in ('r', 'p', 'v', 'm')
     and has_table_privilege('ops_gateway', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'ops_gateway holds a table privilege in ops: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and has_function_privilege('ops_gateway', p.oid, 'EXECUTE')
     and p.proname not in ('receive_whatsapp_message', 'receive_whatsapp_status');
  if v_bad is not null then
    raise exception 'ops_gateway can execute more than its two functions: %', v_bad;
  end if;

  -- The two gateway functions are the only new DEFINERs, with an empty search
  -- path; everything else here is INVOKER with an empty search path.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('receive_whatsapp_message', 'receive_whatsapp_status')
     and (not p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false));
  if v_bad is not null then
    raise exception 'a gateway function is not a DEFINER with an empty search path: %', v_bad;
  end if;
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('crm_contact_by_phone', 'whatsapp_send_eligibility', 'admit_inbound_core',
                       'admit_inbound_message', 'configure_whatsapp_channel', 'request_outbound_send',
                       'begin_outbound_send', 'settle_outbound_send', 'mark_outbound_indeterminate',
                       'guard_inbound_message_q8', 'guard_outbound_message', 'guard_communication_identity')
     and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false));
  if v_bad is not null then
    raise exception 'a Phase 2B service is a DEFINER or floats its search path: %', v_bad;
  end if;

  -- No application role reaches the new tables or the owner services.
  select string_agg(format('%s on %s to %s', v.p, v.t, v.r), ', ') into v_bad
    from (select t, r, p
            from unnest(array['ops.communication_channels', 'ops.conversations', 'ops.outbound_messages']) t,
                 unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, v.t, v.p);
  if v_bad is not null then
    raise exception 'a Phase 2B table is reachable: %', v_bad;
  end if;

  -- The guards fire on every session.
  select string_agg(g.name, ', ') into v_bad
    from unnest(array['inbound_messages_q8_gate', 'outbound_messages_guard',
                      'communication_channels_guard_update', 'conversations_guard_update',
                      'inbound_messages_guard_update']) as g (name)
   where not exists (select 1 from pg_trigger where tgname = g.name and tgenabled = 'A');
  if v_bad is not null then
    raise exception 'guard trigger(s) missing or not ENABLE ALWAYS: %', v_bad;
  end if;
end
$$;
