-- ADR 0021 (decided 2026-10-04 by owner delegation): the LGPD minimum for the
-- WhatsApp channel, built before any production opening.
--
--   1. THE PRIVACY NOTICE. A tenant's notice is versioned owner data: the URL of
--      the full notice, the short text a WhatsApp reply carries and the lawful
--      basis reference (W2: art. 7 V for the reply and the contact, art. 11 II
--      f for health content, recorded as the reference, never as legal text).
--      Recording a new version supersedes the previous one; nothing is deleted.
--   2. THE FIRST REPLY CARRIES IT. When a send begins, the reply carries the
--      tenant's current notice unless a reply in the same conversation already
--      reached the person with that very version. The send records which version
--      it carried. The text is never copied into the send: it is rebuilt from
--      the review's draft and the notice row.
--   3. THE PHONE IDENTIFIER HAS A CLOCK (W5). A conversation's number is erased
--      12 months after the person's last message, or at once on the owner's act.
--      Erasure leaves a tombstone ('erased:' || the conversation id), never a
--      number, on the conversation and on every admission of it; a later message
--      from the same number opens a new conversation. One INTERNAL job per
--      conversation, moved forward while it is queued (the D6/D7 pattern: no
--      cron), erases it at its due time; the kill switch never holds it.
--
-- Nothing opens: the production gate (communication_channels_q8_real_data_gate)
-- is untouched, and no model is authorized for real messages (W1).
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The privacy notice.
-- ---------------------------------------------------------------------------

create table ops.privacy_notices (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references ops.tenants (id) on delete restrict,
  version          text not null,
  notice_url       text not null,
  whatsapp_text    text not null,
  lawful_basis_ref text not null,
  recorded_by      text not null,
  recorded_at      timestamptz not null default now(),
  superseded_at    timestamptz,
  constraint privacy_notices_version_format check (version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  constraint privacy_notices_url_format check (char_length(notice_url) <= 500 and notice_url ~ '^https://[\x21-\x7e]+$'),
  -- At most 1000 characters, so a 2000-character draft, the separator and the
  -- notice stay inside the provider's 4096 (engine/communication/whatsapp).
  constraint privacy_notices_text_shape check (
    char_length(whatsapp_text) between 1 and 1000 and whatsapp_text ~ '\S'
    and whatsapp_text !~ '[\x01-\x09\x0b-\x1f\x7f]'),
  constraint privacy_notices_basis_format check (lawful_basis_ref ~ '^[a-z0-9][a-z0-9_.:+-]{0,127}$'),
  constraint privacy_notices_recorded_by_format check (recorded_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint privacy_notices_superseded_after check (superseded_at is null or superseded_at >= recorded_at),
  constraint privacy_notices_version_key unique (tenant_id, version)
);

-- One current notice per tenant.
create unique index privacy_notices_current_key on ops.privacy_notices (tenant_id) where superseded_at is null;

comment on table ops.privacy_notices is
  'ADR 0021: a tenant''s privacy notice, versioned owner data (the full notice''s URL, the short WhatsApp text, the lawful basis reference). Recorded by ops.record_privacy_notice only; a new version supersedes the current one. The current notice is never deleted, and a version a send carried is held by the send''s foreign key.';

create function ops.guard_privacy_notice()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- The current notice is never deleted; a superseded one only when no send
  -- carried it (the send's foreign key holds that one forever).
  if tg_op = 'DELETE' then
    if old.superseded_at is null then
      raise exception using errcode = 'OS403', message = 'ops.privacy_notices: the current notice is never deleted';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.superseded_at is not null then
      raise exception using errcode = 'OS403', message = 'ops.privacy_notices: a notice is born current';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at')
     or old.superseded_at is not null or new.superseded_at is null then
    raise exception using errcode = 'OS403',
      message = 'ops.privacy_notices: a notice is immutable; it is only superseded, once';
  end if;
  return new;
end
$function$;

create function ops.refuse_privacy_notice_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.privacy_notices: a notice is history and is never truncated';
end
$function$;

create trigger privacy_notices_guard
  before insert or update or delete on ops.privacy_notices
  for each row execute function ops.guard_privacy_notice();
alter table ops.privacy_notices enable always trigger privacy_notices_guard;

create trigger privacy_notices_no_truncate
  before truncate on ops.privacy_notices
  for each statement execute function ops.refuse_privacy_notice_truncate();
alter table ops.privacy_notices enable always trigger privacy_notices_no_truncate;

-- The owner's act: record a version, superseding the current one.
create function ops.record_privacy_notice(p_tenant_id uuid, p_version text, p_notice_url text,
                                          p_whatsapp_text text, p_lawful_basis_ref text, p_actor text)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_tenant_id is null or not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.record_privacy_notice: unknown tenant';
  end if;
  if exists (select 1 from ops.privacy_notices n where n.tenant_id = p_tenant_id and n.version = p_version) then
    raise exception using errcode = 'OS409', message = 'ops.record_privacy_notice: that version is already recorded';
  end if;
  -- Serialize recordings of one tenant: the current row is locked first.
  perform 1 from ops.tenants t where t.id = p_tenant_id for update;
  update ops.privacy_notices set superseded_at = now()
   where tenant_id = p_tenant_id and superseded_at is null;
  insert into ops.privacy_notices (tenant_id, version, notice_url, whatsapp_text, lawful_basis_ref, recorded_by)
  values (p_tenant_id, p_version, p_notice_url, p_whatsapp_text, p_lawful_basis_ref, p_actor)
  returning id into v_id;
  return v_id;
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. The first reply of a conversation carries the notice.
-- ---------------------------------------------------------------------------

alter table ops.outbound_messages add column privacy_notice_id uuid references ops.privacy_notices (id) on delete restrict;

-- Attached when the send begins, never on an authorized or blocked send.
alter table ops.outbound_messages add constraint outbound_messages_notice_when_begun
  check (privacy_notice_id is null or status not in ('authorized', 'blocked'));

create index outbound_messages_conversation_idx on ops.outbound_messages (tenant_id, conversation_id);

-- The Phase 2B guard, plus: the notice is attached once, as the send begins,
-- and only the tenant's own.
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
  if new.privacy_notice_id is distinct from old.privacy_notice_id
     and not (old.privacy_notice_id is null and old.status = 'authorized' and new.status = 'sending'
              and exists (select 1 from ops.privacy_notices n
                           where n.id = new.privacy_notice_id and n.tenant_id = new.tenant_id)) then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the privacy notice is the tenant''s own, attached once as the send begins';
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

-- The send's one transaction that answers the text (D7 body, unchanged), plus:
-- the reply carries the tenant's current notice unless a reply in this
-- conversation already reached the person with that version (sent, delivered
-- or read). A send whose outcome is unknown does not count: a repeated notice
-- is harmless, a missing one is not.
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
  v_notice  ops.privacy_notices;
  v_check   jsonb;
  v_body    text;
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
  -- D7: a review whose content was redacted has no draft left to send.
  if exists (select 1 from ops.review_items v
              where v.tenant_id = p_tenant_id and v.id = v_out.review_item_id
                and v.content_redacted_at is not null) then
    v_check := jsonb_build_object('eligible', false, 'reason', 'content_redacted');
  end if;
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
  v_body := v_review.proposed ->> 'response_draft';

  select n.* into v_notice from ops.privacy_notices n
   where n.tenant_id = p_tenant_id and n.superseded_at is null;
  if found and exists (select 1 from ops.outbound_messages o
                        where o.tenant_id = p_tenant_id and o.conversation_id = v_out.conversation_id
                          and o.privacy_notice_id = v_notice.id and o.status in ('sent', 'delivered', 'read')) then
    v_notice := null;
  end if;
  if v_notice.id is not null then
    v_body := v_body || pg_catalog.repeat(pg_catalog.chr(10), 2) || v_notice.whatsapp_text;
  end if;

  update ops.outbound_messages
     set status = 'sending', sending_at = now(), send_check = v_check, privacy_notice_id = v_notice.id
   where id = v_out.id;
  perform ops.record_event(
    p_tenant_id, v_out.company_id, 'communication.outbound_attempted', 'operator-cli', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id));

  return jsonb_build_object(
    'state', 'send',
    'outbound_message_id', v_out.id,
    'provider_target', v_channel.provider_target,
    'to', v_conv.contact_ref,
    'body', v_body);
end
$function$;

-- ---------------------------------------------------------------------------
-- 3. The phone identifier's clock (W5).
-- ---------------------------------------------------------------------------

alter table ops.conversations add column contact_erased_at timestamptz;
alter table ops.conversations drop constraint conversations_contact_ref_format;
alter table ops.conversations add constraint conversations_contact_ref_format check (
  (contact_erased_at is null and contact_ref ~ '^[0-9]{6,20}$')
  or (contact_erased_at is not null and contact_ref = 'erased:' || id::text));

alter table ops.inbound_messages add column contact_erased_at timestamptz;
alter table ops.inbound_messages add constraint inbound_messages_contact_erased_shape check (
  contact_erased_at is null or (conversation_id is not null and contact_ref = 'erased:' || conversation_id::text));

-- The retention period of a sender's number after their last message.
create function ops.contact_identifier_retention_period()
returns interval
language sql
immutable
set search_path to ''
as $function$
  select interval '12 months';
$function$;

create table ops.contact_identifier_retention (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references ops.tenants (id) on delete restrict,
  -- The clock lives and dies with its conversation (a conversation is never
  -- deleted in operation; a test fixture's cleanup may).
  conversation_id uuid not null references ops.conversations (id) on delete cascade,
  last_message_at timestamptz not null,
  due_at          timestamptz not null,
  job_id          uuid references ops.jobs (id) on delete restrict,
  erased_at       timestamptz,
  erasure_reason  text,
  erased_by       text,
  constraint contact_identifier_retention_conversation_key unique (conversation_id),
  constraint contact_identifier_retention_job_key unique (job_id),
  constraint contact_identifier_retention_due check (due_at = last_message_at + ops.contact_identifier_retention_period()),
  constraint contact_identifier_retention_reason check (erasure_reason in ('retention_expired', 'erasure')),
  constraint contact_identifier_retention_by_format check (erased_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint contact_identifier_retention_erasure_shape check (
    (erased_at is null) = (erasure_reason is null) and (erased_at is null) = (erased_by is null)),
  constraint contact_identifier_retention_expiry_not_early check (
    erasure_reason is distinct from 'retention_expired' or erased_at >= due_at)
);

create index contact_identifier_retention_due_idx on ops.contact_identifier_retention (due_at) where erased_at is null;

comment on table ops.contact_identifier_retention is
  'ADR 0021 W5: one row per WhatsApp conversation, holding no number: when the sender''s last message was, when the number is due for erasure (12 months on), the one job bound to it, and the erasure (when, why, by whom).';

create function ops.guard_contact_identifier_retention()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    -- Only the cascade from its conversation's deletion: the parent is gone.
    if exists (select 1 from ops.conversations c where c.id = old.conversation_id) then
      raise exception using errcode = 'OS403',
        message = 'ops.contact_identifier_retention: a clock goes only with its conversation';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.erased_at is not null or not exists (
         select 1 from ops.conversations c where c.id = new.conversation_id and c.tenant_id = new.tenant_id) then
      raise exception using errcode = 'OS403',
        message = 'ops.contact_identifier_retention: a clock is born for a conversation of its own tenant, not erased';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.conversation_id is distinct from old.conversation_id then
    raise exception using errcode = 'OS403', message = 'ops.contact_identifier_retention: a clock''s identity is fixed';
  end if;
  if old.erased_at is not null and (to_jsonb(new) - 'job_id') is distinct from (to_jsonb(old) - 'job_id') then
    raise exception using errcode = 'OS403', message = 'ops.contact_identifier_retention: an erasure is final';
  end if;
  if new.last_message_at < old.last_message_at then
    raise exception using errcode = 'OS403', message = 'ops.contact_identifier_retention: the clock only moves forward';
  end if;
  return new;
end
$function$;

create function ops.refuse_contact_identifier_retention_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.contact_identifier_retention: the ledger is never truncated';
end
$function$;

create trigger contact_identifier_retention_guard
  before insert or update or delete on ops.contact_identifier_retention
  for each row execute function ops.guard_contact_identifier_retention();
alter table ops.contact_identifier_retention enable always trigger contact_identifier_retention_guard;

create trigger contact_identifier_retention_no_truncate
  before truncate on ops.contact_identifier_retention
  for each statement execute function ops.refuse_contact_identifier_retention_truncate();
alter table ops.contact_identifier_retention enable always trigger contact_identifier_retention_no_truncate;

-- The maintenance kind that erases a number at its due time. INTERNAL: the
-- kill switch never holds it (ops.job_covering_stop), because an erasure
-- obligation does not pause with execution.
create or replace function ops.internal_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['postmark.ledger_retention', 'content.retention_due', 'contact.identifier_retention_due']::text[];
$function$;

-- Keeps ONE job bound to the conversation, available at its due instant: moved
-- while queued; otherwise (running, or finished) a new one is queued and bound.
create function ops.bind_contact_identifier_job(p_retention_id uuid, p_available_at timestamptz)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_row ops.contact_identifier_retention;
  v_job uuid;
begin
  select r.* into v_row from ops.contact_identifier_retention r where r.id = p_retention_id;
  update ops.jobs
     set available_at = p_available_at, updated_at = now()
   where tenant_id = v_row.tenant_id and id = v_row.job_id and status = 'queued'
  returning id into v_job;
  if v_job is null then
    -- The payload is a reference; the capability resolves the conversation
    -- from the leased job's binding, never from it.
    v_job := ops.enqueue_job(v_row.tenant_id, 'contact.identifier_retention_due',
                             jsonb_build_object('contact_identifier_retention_id', v_row.id),
                             100, p_available_at, 10, null);
    update ops.contact_identifier_retention set job_id = v_job where id = v_row.id;
  end if;
  return v_job;
end
$function$;

-- Anchors (or moves forward) a conversation's clock at the sender's last
-- message and binds its one job. An erased conversation has no clock left.
create function ops.refresh_contact_identifier_retention(p_conversation_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv ops.conversations;
  v_last timestamptz;
  v_row  ops.contact_identifier_retention;
begin
  select c.* into v_conv from ops.conversations c where c.id = p_conversation_id;
  if not found or v_conv.contact_erased_at is not null then
    return null;
  end if;
  v_last := coalesce(v_conv.last_inbound_at, v_conv.created_at);
  insert into ops.contact_identifier_retention as r (tenant_id, conversation_id, last_message_at, due_at)
  values (v_conv.tenant_id, v_conv.id, v_last, v_last + ops.contact_identifier_retention_period())
  on conflict (conversation_id) do update
     set last_message_at = greatest(r.last_message_at, excluded.last_message_at),
         due_at = greatest(r.last_message_at, excluded.last_message_at) + ops.contact_identifier_retention_period()
   where r.erased_at is null
  returning r.* into v_row;
  if v_row.id is null then
    return null;
  end if;
  return ops.bind_contact_identifier_job(v_row.id, v_row.due_at);
end
$function$;

create function ops.schedule_contact_identifier_retention()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  perform ops.refresh_contact_identifier_retention(new.id);
  return null;
end
$function$;

create trigger conversations_schedule_identifier_retention
  after insert or update of last_inbound_at on ops.conversations
  for each row execute function ops.schedule_contact_identifier_retention();
alter table ops.conversations enable always trigger conversations_schedule_identifier_retention;

-- An erasure changes exactly the number and its marker, at the instant the
-- ledger recorded, to the conversation's tombstone, and nothing else.
create function ops.contact_erasure_permitted(p_old jsonb, p_new jsonb, p_tenant_id uuid, p_conversation_id uuid)
returns boolean
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  c_cols constant text[] := array['contact_ref', 'contact_erased_at'];
  v_at timestamptz;
begin
  if p_conversation_id is null
     or coalesce(p_old -> 'contact_erased_at', 'null'::jsonb) <> 'null'::jsonb
     or coalesce(p_new -> 'contact_erased_at', 'null'::jsonb) = 'null'::jsonb then
    return false;
  end if;
  v_at := (p_new ->> 'contact_erased_at')::timestamptz;
  if p_new ->> 'contact_ref' is distinct from 'erased:' || p_conversation_id::text then
    raise exception using errcode = 'OS403', message = 'contact erasure: the number becomes the conversation''s tombstone';
  end if;
  if (p_old - c_cols) is distinct from (p_new - c_cols) then
    raise exception using errcode = 'OS403', message = 'contact erasure: an erasure changes the number and nothing else';
  end if;
  if row_security_active('ops.contact_identifier_retention') then
    raise exception using errcode = 'OS403',
      message = 'contact erasure: row security would hide the identifier ledger from this caller';
  end if;
  perform 1 from ops.contact_identifier_retention r
   where r.tenant_id = p_tenant_id and r.conversation_id = p_conversation_id and r.erased_at = v_at;
  if not found then
    raise exception using errcode = 'OS403', message = 'contact erasure: no recorded erasure of this conversation at that instant';
  end if;
  return true;
end
$function$;

-- The Phase 2B identity guard, plus a conversation's recorded erasure.
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
  elsif ops.contact_erasure_permitted(to_jsonb(old), to_jsonb(new), old.tenant_id, old.id) then
    return new;
  elsif new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id or new.channel_id is distinct from old.channel_id
     or new.contact_ref is distinct from old.contact_ref or new.created_at is distinct from old.created_at
     or new.contact_erased_at is distinct from old.contact_erased_at then
    raise exception using errcode = 'OS403',
      message = 'ops.conversations: a conversation''s identity is immutable';
  end if;
  return new;
end
$function$;

-- The D7 admission guard, plus the conversation's recorded erasure.
create or replace function ops.guard_inbound_message_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- D7: a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['body_fingerprint'], old.tenant_id, old.task_id) then
    return new;
  end if;
  -- ADR 0021 W5: a recorded erasure replaces the number and changes nothing else.
  if ops.contact_erasure_permitted(to_jsonb(old), to_jsonb(new), old.tenant_id, old.conversation_id) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.source_kind is distinct from old.source_kind
     or new.external_message_id is distinct from old.external_message_id
     or new.contact_ref is distinct from old.contact_ref
     or new.contact_erased_at is distinct from old.contact_erased_at
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

-- The erasure core: the ledger instant first, then the number on the
-- conversation and on every admission of it. 'retention_expired' waits for
-- the due instant; 'erasure' (the owner's act) does not.
create function ops.erase_contact_identifier(p_tenant_id uuid, p_conversation_id uuid, p_reason text, p_actor text)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv ops.conversations;
  v_row  ops.contact_identifier_retention;
  v_at   timestamptz;
begin
  if p_reason is null or p_reason not in ('retention_expired', 'erasure') then
    raise exception using errcode = 'OS400', message = 'ops.erase_contact_identifier: unknown reason';
  end if;
  select c.* into v_conv from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = p_conversation_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.erase_contact_identifier: conversation not found in this tenant';
  end if;
  if v_conv.contact_erased_at is not null then
    return 'already_erased';
  end if;
  select r.* into v_row from ops.contact_identifier_retention r
   where r.conversation_id = v_conv.id
     for update;
  if not found then
    perform ops.refresh_contact_identifier_retention(v_conv.id);
    select r.* into v_row from ops.contact_identifier_retention r where r.conversation_id = v_conv.id for update;
  end if;
  if p_reason = 'retention_expired' and v_row.due_at > clock_timestamp() then
    return 'not_due';
  end if;
  v_at := clock_timestamp();
  update ops.contact_identifier_retention
     set erased_at = v_at, erasure_reason = p_reason, erased_by = p_actor
   where id = v_row.id;
  update ops.conversations
     set contact_ref = 'erased:' || id::text, contact_erased_at = v_at
   where id = v_conv.id;
  update ops.inbound_messages
     set contact_ref = 'erased:' || p_conversation_id::text, contact_erased_at = v_at
   where tenant_id = p_tenant_id and conversation_id = p_conversation_id and contact_erased_at is null;
  return 'erased';
end
$function$;

-- The worker's capability: the leased job's conversation, at its due time.
create function ops.erase_due_contact_identifier()
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job    ops.jobs := ops.leased_job();
  v_row    ops.contact_identifier_retention;
  v_status text;
begin
  if v_job.kind <> 'contact.identifier_retention_due' then
    raise exception using errcode = '42501',
      message = 'ops.erase_due_contact_identifier: the leased job is not an identifier retention job';
  end if;
  select r.* into v_row
    from ops.contact_identifier_retention r
   where r.tenant_id = v_job.tenant_id and r.job_id = v_job.id;
  if not found then
    return 'superseded';
  end if;
  v_status := ops.erase_contact_identifier(v_row.tenant_id, v_row.conversation_id, 'retention_expired',
                                           'system:contact-retention');
  if v_status <> 'not_due' then
    return v_status;
  end if;
  -- A later message moved the clock while this job was running: if this job
  -- is still the bound one, the next is queued at the new due instant.
  select r.* into v_row from ops.contact_identifier_retention r where r.id = v_row.id;
  if v_row.job_id = v_job.id then
    perform ops.bind_contact_identifier_job(v_row.id, v_row.due_at);
  end if;
  return 'deferred';
end
$function$;

-- The owner's act: a person asks for their number to be erased. Every
-- conversation of the tenant with that number loses it, and the AI working
-- content of every protected flow it admitted is erased with it (the D7 act,
-- which refuses, OS409, while a flow is in progress: nothing is erased then).
create function ops.erase_contact_by_number(p_tenant_id uuid, p_number text, p_actor text)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv  uuid;
  v_task  uuid;
  v_count integer := 0;
begin
  if p_number is null or p_number !~ '^[0-9]{6,20}$' then
    raise exception using errcode = 'OS400', message = 'ops.erase_contact_by_number: a number is 6 to 20 digits';
  end if;
  for v_task in
    select distinct i.task_id
      from ops.conversations c
      join ops.inbound_messages i on i.tenant_id = c.tenant_id and i.conversation_id = c.id
      join ops.content_retention r on r.tenant_id = i.tenant_id and r.task_id = i.task_id
     where c.tenant_id = p_tenant_id and c.contact_ref = p_number and r.redacted_at is null
  loop
    perform ops.erase_task_content(p_tenant_id, v_task, p_actor);
  end loop;
  for v_conv in
    select c.id from ops.conversations c where c.tenant_id = p_tenant_id and c.contact_ref = p_number
  loop
    if ops.erase_contact_identifier(p_tenant_id, v_conv, 'erasure', p_actor) = 'erased' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$function$;

-- The owner's sweep (the D6 sweep's shape): erase now, bounded, every number
-- whose retention has ended and the worker has not reached.
create function ops.sweep_contact_identifier_retention(p_limit integer, p_actor text)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_row   record;
  v_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'OS400', message = 'ops.sweep_contact_identifier_retention: the limit is 1 to 1000';
  end if;
  for v_row in
    select r.tenant_id, r.conversation_id
      from ops.contact_identifier_retention r
     where r.erased_at is null and r.due_at <= clock_timestamp()
     order by r.due_at
     limit p_limit
  loop
    if ops.erase_contact_identifier(v_row.tenant_id, v_row.conversation_id, 'retention_expired', p_actor) = 'erased' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$function$;

-- Every existing conversation gets its clock and its one job.
do $backfill$
declare
  v_id uuid;
begin
  for v_id in select c.id from ops.conversations c where c.contact_erased_at is null loop
    perform ops.refresh_contact_identifier_retention(v_id);
  end loop;
end
$backfill$;

-- ---------------------------------------------------------------------------
-- 4. Access: backend only. The worker reaches the ledger only through its one
--    lease-bound capability; the owner acts are not granted to anyone.
-- ---------------------------------------------------------------------------

alter table ops.privacy_notices enable row level security;
alter table ops.privacy_notices force row level security;
alter table ops.contact_identifier_retention enable row level security;
alter table ops.contact_identifier_retention force row level security;

revoke all on table ops.privacy_notices, ops.contact_identifier_retention
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.guard_privacy_notice(),
  ops.refuse_privacy_notice_truncate(),
  ops.record_privacy_notice(uuid, text, text, text, text, text),
  ops.guard_outbound_message(),
  ops.begin_outbound_send(uuid, uuid),
  ops.contact_identifier_retention_period(),
  ops.guard_contact_identifier_retention(),
  ops.refuse_contact_identifier_retention_truncate(),
  ops.bind_contact_identifier_job(uuid, timestamptz),
  ops.refresh_contact_identifier_retention(uuid),
  ops.schedule_contact_identifier_retention(),
  ops.contact_erasure_permitted(jsonb, jsonb, uuid, uuid),
  ops.guard_communication_identity(),
  ops.guard_inbound_message_update(),
  ops.erase_contact_identifier(uuid, uuid, text, text),
  ops.erase_due_contact_identifier(),
  ops.erase_contact_by_number(uuid, text, text),
  ops.sweep_contact_identifier_retention(integer, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

grant execute on function ops.erase_due_contact_identifier() to ops_worker;

-- ---------------------------------------------------------------------------
-- 5. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad text;
begin
  if not (select c.relrowsecurity and c.relforcerowsecurity from pg_catalog.pg_class c
           where c.oid = 'ops.privacy_notices'::regclass)
     or not (select c.relrowsecurity and c.relforcerowsecurity from pg_catalog.pg_class c
               where c.oid = 'ops.contact_identifier_retention'::regclass) then
    raise exception 'the privacy notice or identifier ledger lacks ENABLE + FORCE row level security';
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where has_table_privilege(r.rolname, 'ops.privacy_notices', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege(r.rolname, 'ops.contact_identifier_retention', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on the privacy notice or identifier ledger: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where t.tgrelid in ('ops.privacy_notices'::regclass, 'ops.contact_identifier_retention'::regclass)
         and not t.tgisinternal and t.tgenabled = 'A') <> 4
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = 'ops.conversations'::regclass
                       and t.tgname = 'conversations_schedule_identifier_retention' and t.tgenabled = 'A') then
    raise exception 'the privacy notice, ledger and scheduling triggers are not all ENABLE ALWAYS';
  end if;
  if not ('contact.identifier_retention_due' = any (ops.internal_job_kinds()))
     or 'contact.identifier_retention_due' = any (ops.task_executable_kinds()) then
    raise exception 'the identifier retention kind is not exactly an internal, non-task kind';
  end if;
  -- Exactly one new worker capability, lease-bound and SECURITY DEFINER.
  if not has_function_privilege('ops_worker', 'ops.erase_due_contact_identifier()', 'EXECUTE')
     or not (select p.prosecdef from pg_catalog.pg_proc p
              where p.oid = 'ops.erase_due_contact_identifier()'::regprocedure) then
    raise exception 'ops_worker cannot execute its identifier retention capability, or it is not SECURITY DEFINER';
  end if;
  select string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'ops'::regnamespace
     and p.proname in ('record_privacy_notice', 'erase_contact_identifier', 'erase_contact_by_number',
                       'sweep_contact_identifier_retention', 'refresh_contact_identifier_retention',
                       'bind_contact_identifier_job', 'contact_erasure_permitted')
     and (has_function_privilege('ops_worker', p.oid, 'EXECUTE') or has_function_privilege('ops_gateway', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'an application role can execute an owner act or a retention helper: %', v_bad;
  end if;
  -- Every live conversation has its clock and one queued job.
  if exists (select 1 from ops.conversations c
              where c.contact_erased_at is null
                and not exists (select 1 from ops.contact_identifier_retention r
                                  join ops.jobs j on j.id = r.job_id and j.status = 'queued'
                                 where r.conversation_id = c.id and r.erased_at is null)) then
    raise exception 'a live conversation has no identifier clock with a queued job';
  end if;
  -- The production gate is untouched.
  if not exists (select 1 from pg_catalog.pg_constraint c
                  where c.conrelid = 'ops.communication_channels'::regclass
                    and c.conname = 'communication_channels_q8_real_data_gate' and c.convalidated) then
    raise exception 'the BASELINE Q8 real-data gate is missing';
  end if;
end
$end_state$;
