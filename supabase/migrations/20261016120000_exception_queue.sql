-- ADR 0025 Part A: the exception queue. One store of the moments a person must
-- act on, raised deterministically where the facts are decided, deduplicated
-- while open, resolved once, and recorded as exception.raised and
-- exception.resolved in the one event store. A model never raises or resolves
-- one.
--
--   * ops.record_inbound_screening raises what a message tells a person,
--     whoever holds the conversation: a request for a person, an opt-out, a
--     fixed text the agent needed and has not published, each message held
--     in a conversation a person holds, and a contact no reply can reach.
--     Danger is not one (owner decision, 2026-10-08): the front desk answers
--     leads, not patients, and the owner does not take a crisis; danger gets
--     the owner's fixed safety text and the conversation stays with the agent. A message from such a contact (its admission's do-not-contact
--     snapshot) is held before any model or fixed text, without moving the
--     conversation (A3); a later message whose admission finds the contact
--     reachable reconciles the exception.
--   * ops.sync_send_exceptions derives a send's exceptions from its state. It
--     runs in the gateway's status entry and in the owner's indeterminate mark,
--     and the send act runs it in a transaction of its own AFTER the one that
--     called the provider and settled the send: never inside that settlement.
--   * ops.release_conversation resolves what the release ends, and is refused
--     while an opt-out exception is open: a person resolves it.
--
-- Nothing here reaches a model, writes the CRM, sends, or adds a capability to
-- an application role.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The store.
-- ---------------------------------------------------------------------------

create table ops.exceptions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  company_id          uuid not null,
  -- The message or send the exception came from: the subject of its events.
  task_id             uuid not null,
  kind                text not null,
  priority            text not null,
  subject_kind        text not null,
  -- The conversation, or the send, an open exception is unique for.
  subject_id          uuid not null,
  conversation_id     uuid not null,
  outbound_message_id uuid,
  -- Why a contact is unresolved: the admission's own answer.
  detail              text,
  raised_at           timestamptz not null default now(),
  raised_by           text not null,
  -- A repeat while the episode is open is counted, never absorbed in silence:
  -- how many occurrences, the latest one's instant and its message's task.
  -- A person's act names the count it saw (ops.resolve_exception).
  occurrences         integer not null default 1,
  last_raised_at      timestamptz not null default now(),
  last_task_id        uuid not null,
  resolved_at         timestamptz,
  resolved_by         text,
  resolution          text,
  constraint exceptions_occurrences_check check (occurrences between 1 and 1000000),
  constraint exceptions_last_task_fkey
    foreign key (tenant_id, company_id, last_task_id) references ops.tasks (tenant_id, company_id, id)
    on delete cascade,
  constraint exceptions_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id) references ops.conversations (tenant_id, company_id, id)
    on delete cascade,
  constraint exceptions_outbound_fkey
    foreign key (tenant_id, company_id, outbound_message_id) references ops.outbound_messages (tenant_id, company_id, id)
    on delete cascade,
  constraint exceptions_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id)
    on delete cascade,
  constraint exceptions_kind_check check (kind in (
    'opt_out', 'person_requested', 'configuration_missing', 'message_waiting',
    'contact_unresolved', 'do_not_contact', 'send_failed', 'send_indeterminate')),
  constraint exceptions_priority_matches_kind check (priority = case
    when kind in ('person_requested', 'configuration_missing', 'contact_unresolved', 'send_indeterminate') then 'high'
    else 'normal' end),
  constraint exceptions_subject_shape check (
        (kind in ('send_failed', 'send_indeterminate')) = (subject_kind = 'outbound_message')
    and (subject_kind = 'outbound_message') = (outbound_message_id is not null)
    and subject_kind in ('conversation', 'outbound_message')
    and subject_id = coalesce(outbound_message_id, conversation_id)),
  constraint exceptions_detail_shape check (
        (kind = 'contact_unresolved') = (detail is not null)
    and (detail is null or detail in ('not_found', 'ambiguous', 'unavailable', 'consent_unknown'))),
  constraint exceptions_resolution_shape check (
        (resolved_at is null) = (resolved_by is null)
    and (resolved_at is null) = (resolution is null)
    and (resolution is null or resolution in ('released', 'reconciled', 'resolved', 'dismissed'))),
  constraint exceptions_actor_format check (
        raised_by ~ '^[A-Za-z0-9._:@-]{1,200}$'
    and (resolved_by is null or resolved_by ~ '^[A-Za-z0-9._:@-]{1,200}$'))
);

comment on table ops.exceptions is
  'ADR 0025: one row per exception episode. Raised only by the database where the facts are decided, at most one open per subject and kind (a repeat is counted on it), resolved once (released, reconciled, resolved, dismissed). Its history is exception.raised and exception.resolved; the row holds no text, number or CRM id.';

-- At most one open episode per subject and kind: raising it again while it is
-- open counts one more occurrence; after it is resolved, a new occurrence is a
-- new episode.
create unique index exceptions_one_open
  on ops.exceptions (tenant_id, subject_id, kind) where resolved_at is null;
create index exceptions_open_idx on ops.exceptions (tenant_id, raised_at) where resolved_at is null;
create index exceptions_conversation_idx on ops.exceptions (tenant_id, conversation_id);
create index exceptions_outbound_idx on ops.exceptions (tenant_id, outbound_message_id)
  where outbound_message_id is not null;

-- Raised open; its identity never changes; while open it only counts a repeat;
-- it is resolved once and is then final; it leaves only with its subject (a
-- cascade), never on its own.
create function ops.guard_exception()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  c_repeat     constant text[] := array['occurrences', 'last_raised_at', 'last_task_id'];
  c_resolution constant text[] := array['resolved_at', 'resolved_by', 'resolution'];
begin
  if tg_op = 'INSERT' then
    if new.resolved_at is not null or new.resolved_by is not null or new.resolution is not null then
      raise exception using errcode = 'OS403', message = 'ops.exceptions: an exception is raised open';
    end if;
    new.raised_at := now();
    new.last_raised_at := now();
    new.occurrences := 1;
    new.last_task_id := new.task_id;
    return new;
  end if;
  if tg_op = 'DELETE' then
    -- A foreign key's cascade deletes from inside its own trigger; a direct
    -- delete runs at depth one. A tripwire, not a boundary: the owner can
    -- disable triggers.
    if pg_catalog.pg_trigger_depth() < 2 then
      raise exception using errcode = 'OS403', message = 'ops.exceptions: an exception leaves only with its subject';
    end if;
    return old;
  end if;
  if old.resolved_at is not null then
    raise exception using errcode = 'OS403', message = 'ops.exceptions: a resolved exception is final';
  end if;
  -- One more occurrence of the open episode: nothing else changes.
  if new.resolution is null and new.resolved_by is null
     and (to_jsonb(new) - c_repeat) is not distinct from (to_jsonb(old) - c_repeat)
     and new.occurrences = old.occurrences + 1 then
    new.last_raised_at := now();
    return new;
  end if;
  if (to_jsonb(new) - c_resolution) is distinct from (to_jsonb(old) - c_resolution)
     or new.resolved_by is null or new.resolution is null then
    raise exception using errcode = 'OS403',
      message = 'ops.exceptions: an exception''s identity is immutable; it only counts a repeat, and is resolved once';
  end if;
  new.resolved_at := now();
  return new;
end
$function$;

create function ops.refuse_exception_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.exceptions: exceptions are never truncated';
end
$function$;

create trigger exceptions_guard
  before insert or update or delete on ops.exceptions
  for each row execute function ops.guard_exception();
alter table ops.exceptions enable always trigger exceptions_guard;
create trigger exceptions_no_truncate
  before truncate on ops.exceptions
  for each statement execute function ops.refuse_exception_truncate();
alter table ops.exceptions enable always trigger exceptions_no_truncate;

alter table ops.exceptions enable row level security;
alter table ops.exceptions force row level security;

-- ---------------------------------------------------------------------------
-- 2. Raising and resolving. Neither raises an error of its own: a repeat is
--    counted on the open episode, and each episode's two events are keyed on
--    its own id.
-- ---------------------------------------------------------------------------

-- Opens an episode and answers its id, or counts one more occurrence of the
-- open one and answers null.

create function ops.open_exception(
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
begin
  v_priority := case
    when p_kind in ('person_requested', 'configuration_missing', 'contact_unresolved', 'send_indeterminate') then 'high'
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

create function ops.close_exception(p_exception_id uuid, p_resolution text, p_actor text)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_row ops.exceptions;
begin
  update ops.exceptions
     set resolved_by = p_actor, resolution = p_resolution
   where id = p_exception_id and resolved_at is null
  returning * into v_row;
  if not found then
    return false;
  end if;
  perform ops.record_event(
    v_row.tenant_id, v_row.company_id, 'exception.resolved', 'exception-queue', 'task', v_row.task_id,
    jsonb_build_object(
      'exception_id', v_row.id, 'kind', v_row.kind, 'priority', v_row.priority,
      'subject_kind', v_row.subject_kind, 'resolution', v_row.resolution),
    null, null, format('exception:%s:resolved', v_row.id));
  return true;
end
$function$;

-- A send's exceptions, derived from its state. A send is uncertain once
-- (indeterminate, or left sending past the five minutes after which a person
-- may mark it) and fails at most once, so each kind is raised at most once per
-- send, and never again once a person resolved it. Leaving indeterminate (to
-- sent, delivered, read or failed) reconciles the uncertainty; delivery
-- evidence reconciles a failure. A send the stale-reply gate stopped
-- (`newer_message`, ADR 0023 §L) was never called: no exception. The send's
-- row is locked first, as every writer of it locks it.
create function ops.sync_send_exceptions(p_tenant_id uuid, p_outbound_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out    ops.outbound_messages;
  v_open   uuid;
  v_opened integer := 0;
  v_closed integer := 0;
begin
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = p_tenant_id and o.id = p_outbound_id
     for update;
  if not found then
    return jsonb_build_object('opened', 0, 'closed', 0);
  end if;

  if v_out.status = 'indeterminate'
     or (v_out.status = 'sending' and v_out.sending_at <= now() - interval '5 minutes') then
    if not exists (select 1 from ops.exceptions e
                    where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
                      and e.kind = 'send_indeterminate') then
      if ops.open_exception(v_out.tenant_id, v_out.company_id, v_out.task_id, 'send_indeterminate',
                            v_out.conversation_id, v_out.id, null, p_actor) is not null then
        v_opened := v_opened + 1;
      end if;
    end if;
  elsif v_out.status in ('sent', 'delivered', 'read', 'failed') then
    for v_open in
      select e.id from ops.exceptions e
       where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
         and e.kind = 'send_indeterminate' and e.resolved_at is null
    loop
      if ops.close_exception(v_open, 'reconciled', p_actor) then
        v_closed := v_closed + 1;
      end if;
    end loop;
  end if;

  if v_out.status = 'failed' and v_out.error_class is distinct from 'newer_message' then
    if not exists (select 1 from ops.exceptions e
                    where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
                      and e.kind = 'send_failed') then
      if ops.open_exception(v_out.tenant_id, v_out.company_id, v_out.task_id, 'send_failed',
                            v_out.conversation_id, v_out.id, null, p_actor) is not null then
        v_opened := v_opened + 1;
      end if;
    end if;
  elsif v_out.status in ('delivered', 'read') then
    for v_open in
      select e.id from ops.exceptions e
       where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
         and e.kind = 'send_failed' and e.resolved_at is null
    loop
      if ops.close_exception(v_open, 'reconciled', p_actor) then
        v_closed := v_closed + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end
$function$;

-- The owner's recovery: every send of the tenant, once, skipping a send a
-- transaction holds right now (one in flight is settled by its own act).
create function ops.sync_tenant_send_exceptions(p_tenant_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id     uuid;
  v_answer jsonb;
  v_sends  integer := 0;
  v_opened integer := 0;
  v_closed integer := 0;
begin
  if not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.sync_tenant_send_exceptions: tenant not found';
  end if;
  for v_id in
    select o.id from ops.outbound_messages o
     where o.tenant_id = p_tenant_id and o.status not in ('authorized', 'blocked')
     order by o.created_at, o.id
       for update skip locked
  loop
    v_answer := ops.sync_send_exceptions(p_tenant_id, v_id, 'operator-cli');
    v_sends  := v_sends + 1;
    v_opened := v_opened + (v_answer ->> 'opened')::integer;
    v_closed := v_closed + (v_answer ->> 'closed')::integer;
  end loop;
  return jsonb_build_object('sends', v_sends, 'opened', v_opened, 'closed', v_closed);
end
$function$;

-- The owner's act: a person resolves or dismisses one exception, naming how
-- many occurrences the person saw. If it recurred since, the act is refused
-- and the person lists it again: nobody resolves an occurrence they did not
-- see. A repeat of the act answers the recorded resolution and records
-- nothing.
create function ops.resolve_exception(
  p_tenant_id uuid, p_exception_id uuid, p_resolution text, p_actor text, p_occurrences integer)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_row ops.exceptions;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.resolve_exception: the actor label is malformed';
  end if;
  if p_resolution is null or p_resolution not in ('resolved', 'dismissed') then
    raise exception using errcode = 'OS400', message = 'ops.resolve_exception: a person resolves or dismisses an exception';
  end if;
  if p_occurrences is null or p_occurrences < 1 then
    raise exception using errcode = 'OS400', message = 'ops.resolve_exception: name the occurrences the listing showed';
  end if;
  select e.* into v_row from ops.exceptions e
   where e.tenant_id = p_tenant_id and e.id = p_exception_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.resolve_exception: exception not found in this tenant';
  end if;
  if v_row.resolved_at is not null then
    return jsonb_build_object('state', 'already_resolved', 'resolution', v_row.resolution);
  end if;
  if v_row.occurrences <> p_occurrences then
    raise exception using errcode = 'OS409',
      message = format('ops.resolve_exception: the exception has %s occurrences, not %s; list it again', v_row.occurrences, p_occurrences);
  end if;
  perform ops.close_exception(v_row.id, p_resolution, p_actor);
  return jsonb_build_object('state', p_resolution);
end
$function$;

-- ---------------------------------------------------------------------------
-- 3. The screening raises, and holds a contact no reply can reach (A3).
--    As 20261014120000, with the A3 branch and the raises after the insert.
-- ---------------------------------------------------------------------------

create or replace function ops.record_inbound_screening(p_screening jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt     integer := ops.agent_run_lease_attempt();
  v_tenant      uuid := ops.current_tenant_id();
  v_job         uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_keys        text[] := array['sanitizerVersion', 'packId', 'messageClass', 'safetyClass', 'safeText',
                                'sensitiveContentPresent', 'fullyBlocked', 'segmentsRedacted', 'segmentsSensitive',
                                'segmentsUnrecognised', 'administrativeIntent', 'humanRequested', 'optOutRequested',
                                'requiresHuman'];
  v_run         ops.agent_runs;
  v_policy      ops.agent_configuration_versions;
  v_playbook    ops.agent_configuration_versions;
  v_knowledge   ops.agent_configuration_versions;
  v_fixed       ops.agent_configuration_versions;
  v_inbound     ops.inbound_messages;
  v_state       ops.conversation_states;
  v_class       text;
  v_safety      text;
  v_text        text;
  v_sensitive   integer;
  v_unknown     integer;
  v_person      boolean;
  v_opt_out     boolean;
  v_admin       boolean;
  v_party       text := 'prospect';
  v_is_client   boolean;
  v_disposition text;
  v_key         text;
  v_reason      text;
  v_screening   uuid;
  v_context     jsonb;
  v_turns       jsonb;
  v_sched       jsonb;
  v_slots       jsonb;
  v_avail       text := 'not_configured';
  v_tz          text;
  v_booking     jsonb;
  v_turn_limit  integer;
  v_reachable   boolean;
  v_text_needed boolean := false;
  v_open        uuid;
  v_newest_dnc        boolean;
  v_newest_resolution text;
  v_waiting           boolean := false;
  v_crm               jsonb;
begin
  -- The input: exactly the screening the engine produces, nothing more.
  if p_screening is null or jsonb_typeof(p_screening) <> 'object'
     or (select count(*) from jsonb_object_keys(p_screening)) <> cardinality(v_keys)
     or exists (select 1 from jsonb_object_keys(p_screening) k where not (k = any (v_keys))) then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: the screening does not have the expected keys';
  end if;
  if jsonb_typeof(p_screening -> 'humanRequested') <> 'boolean'
     or jsonb_typeof(p_screening -> 'optOutRequested') <> 'boolean'
     or jsonb_typeof(p_screening -> 'administrativeIntent') <> 'boolean'
     or jsonb_typeof(p_screening -> 'segmentsSensitive') <> 'number'
     or jsonb_typeof(p_screening -> 'segmentsUnrecognised') <> 'number'
     or (p_screening ->> 'segmentsSensitive') !~ '^[0-9]{1,4}$'
     or (p_screening ->> 'segmentsUnrecognised') !~ '^[0-9]{1,4}$'
     or jsonb_typeof(p_screening -> 'safeText') not in ('string', 'null') then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: a screening field has the wrong type';
  end if;
  v_class     := p_screening ->> 'messageClass';
  v_safety    := p_screening ->> 'safetyClass';
  v_text      := p_screening ->> 'safeText';
  v_sensitive := (p_screening ->> 'segmentsSensitive')::integer;
  v_unknown   := (p_screening ->> 'segmentsUnrecognised')::integer;
  v_person    := (p_screening ->> 'humanRequested')::boolean;
  v_opt_out   := (p_screening ->> 'optOutRequested')::boolean;
  v_admin     := (p_screening ->> 'administrativeIntent')::boolean;
  if (v_class in ('administrative', 'mixed')) <> (v_text is not null) then
    raise exception using errcode = 'OS400',
      message = 'ops.record_inbound_screening: only an administrative or mixed screening carries text';
  end if;
  if (p_screening ->> 'segmentsRedacted') is distinct from (v_sensitive + v_unknown)::text then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: the counts do not add up';
  end if;

  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.record_inbound_screening: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.status <> 'pending' or v_run.capability <> 'lead_triage' then
    raise exception using errcode = 'OS409', message = 'ops.record_inbound_screening: only a pending lead triage run is screened';
  end if;
  v_policy := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'operating_policy');
  if v_policy.id is null then
    raise exception using errcode = 'OS409', message = 'ops.record_inbound_screening: the agent has no published operating policy';
  end if;
  if (p_screening ->> 'packId') is distinct from (v_policy.content ->> 'sanitizerPack') then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: the screening used another pack than the policy names';
  end if;
  v_playbook  := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'playbook');
  v_knowledge := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'knowledge');
  v_fixed     := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'fixed_messages');

  -- The conversation, its state and the contact's party kind.
  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = v_tenant and m.task_id = v_run.task_id
   order by m.received_at desc limit 1;
  if v_inbound.conversation_id is not null then
    insert into ops.conversation_states (conversation_id, tenant_id, company_id)
    values (v_inbound.conversation_id, v_tenant, v_inbound.company_id)
    on conflict (conversation_id) do nothing;
    if v_inbound.contact_resolution in ('ambiguous', 'unavailable') then
      v_party := 'unknown';
    elsif v_inbound.contact_resolution = 'found' then
      v_is_client := ops.crm_contact_is_client(v_tenant, v_inbound.crm_contact_ref);
      v_party := case when v_is_client is null then 'unknown' when v_is_client then 'client' else 'prospect' end;
    end if;
    perform ops.move_conversation_state(v_inbound.conversation_id, 'party_kind', v_party, 'crm_lookup', 'front-desk');
    if exists (select 1 from ops.outbound_messages o
                where o.tenant_id = v_tenant and o.conversation_id = v_inbound.conversation_id
                  and o.status in ('sent', 'delivered', 'read')) then
      select s.* into v_state from ops.conversation_states s where s.conversation_id = v_inbound.conversation_id;
      if v_state.phase = 'new' then
        perform ops.move_conversation_state(v_inbound.conversation_id, 'phase', 'engaged', 'reply_sent', 'front-desk');
      end if;
    end if;
    select s.* into v_state from ops.conversation_states s where s.conversation_id = v_inbound.conversation_id;
    -- ADR 0021 W6 (a): a reply reaches only a contact the admission found in
    -- the CRM, not marked do-not-contact. Unknown is unreachable.
    v_reachable := not coalesce(v_inbound.do_not_contact, true);
  end if;

  -- The disposition.
  if v_state.holder = 'person' then
    v_disposition := 'held_for_person';
    v_waiting := true;
  else
    v_key := case
      when v_safety = 'crisis' then 'safety'
      when v_person then 'human_handoff_ack'
      when v_opt_out then 'opt_out_ack'
      when v_class = 'sensitive_only' then
        case when v_party = 'client' then 'sensitive_only_client' else 'sensitive_only_prospect' end
      when v_class = 'unknown' then 'clarification'
      else null end;
    -- Owner decision, 2026-10-08: danger gets the fixed safety text and the
    -- conversation stays with the agent; it is no person's to take.
    v_reason := case when v_safety = 'crisis' then null
                     when v_person then 'person_requested'
                     when v_opt_out then 'opt_out' end;
    if v_reason is null and v_safety <> 'crisis'
       and v_inbound.conversation_id is not null and not v_reachable then
      -- ADR 0025 A3: no reply can reach this contact, so neither a model nor a
      -- fixed text drafts one. The agent keeps the conversation: once the
      -- contact is reachable, the next message is answered as usual.
      v_disposition := 'held_for_person';
      v_key := null;
    elsif v_key is null then
      v_disposition := 'model';
    elsif v_fixed.id is null then
      -- Nobody published the fixed texts: a person answers.
      v_disposition := 'held_for_person';
      v_key := null;
      v_reason := coalesce(v_reason, 'operator');
      v_text_needed := true;
    else
      v_disposition := 'fixed_reply';
    end if;
    if v_reason is not null and v_inbound.conversation_id is not null then
      perform ops.move_conversation_state(v_inbound.conversation_id, 'holder', 'person', v_reason, 'front-desk');
    end if;
  end if;

  insert into ops.inbound_screenings (
    tenant_id, company_id, task_id, agent_run_id, conversation_id, screener_version, pack_id,
    message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
    administrative_intent, person_requested, opt_out_requested, model_input, party_kind,
    disposition, fixed_message_key, policy_version_id, playbook_version_id, knowledge_version_id,
    fixed_messages_version_id)
  values (
    v_tenant, v_run.company_id, v_run.task_id, v_run.id, v_inbound.conversation_id,
    p_screening ->> 'sanitizerVersion', p_screening ->> 'packId',
    v_class, v_safety, v_sensitive + v_unknown, v_sensitive, v_unknown,
    v_admin, v_person, v_opt_out, v_text, v_party,
    v_disposition, v_key, v_policy.id, v_playbook.id, v_knowledge.id,
    case when v_disposition = 'fixed_reply' then v_fixed.id end)
  returning id into v_screening;

  -- ADR 0025 A2: what this message tells a person, whoever holds the
  -- conversation. An episode already open absorbs the repeat.
  if v_inbound.conversation_id is not null then
    if v_person then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'person_requested',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
    if v_opt_out then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'opt_out',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
    if v_text_needed then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'configuration_missing',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
    -- Whether a reply can reach the contact now is the conversation's newest
    -- admission's answer, not this message's: messages are not screened in
    -- the order they arrived (several workers, a retry), and an older message
    -- must neither reconcile a newer refusal nor reopen a settled one.
    select m.do_not_contact, m.contact_resolution into v_newest_dnc, v_newest_resolution
      from ops.inbound_messages m
     where m.tenant_id = v_tenant and m.conversation_id = v_inbound.conversation_id
     order by m.received_at desc, m.created_at desc
     limit 1;
    if not coalesce(v_newest_dnc, true) then
      for v_open in
        select e.id from ops.exceptions e
         where e.tenant_id = v_tenant and e.conversation_id = v_inbound.conversation_id
           and e.kind in ('contact_unresolved', 'do_not_contact') and e.resolved_at is null
      loop
        perform ops.close_exception(v_open, 'reconciled', 'front-desk');
      end loop;
    elsif v_newest_resolution = 'found' then
      -- The admission stores an unknown consent (a contact with no lead
      -- profile) as unreachable, like an opt-out. Only the label needs the
      -- difference, so it asks the read-only CRM adapter again: a recorded
      -- flag is do_not_contact, an unknown one is not an opt-out.
      v_crm := ops.crm_contact_by_phone(
        v_tenant, (select c.contact_ref from ops.conversations c where c.id = v_inbound.conversation_id));
      if v_crm ->> 'state' = 'found' and jsonb_typeof(v_crm -> 'do_not_contact') = 'boolean' then
        perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'do_not_contact',
                                   v_inbound.conversation_id, null, null, 'front-desk');
      else
        perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'contact_unresolved',
                                   v_inbound.conversation_id, null,
                                   case when v_crm ->> 'state' in ('not_found', 'ambiguous', 'unavailable')
                                        then v_crm ->> 'state' else 'consent_unknown' end,
                                   'front-desk');
      end if;
    else
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'contact_unresolved',
                                 v_inbound.conversation_id, null,
                                 case when v_newest_resolution in ('not_found', 'ambiguous')
                                      then v_newest_resolution else 'unavailable' end,
                                 'front-desk');
    end if;
    -- Every message held because a person holds the conversation is counted
    -- for that person, whatever else is open: none waits unlisted.
    if v_waiting then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'message_waiting',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
  end if;

  if v_disposition <> 'model' then
    v_context := ops.push_event_context('agent-runtime', null, null);
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused',
           error_code = case when v_disposition = 'fixed_reply' then 'front_desk_fixed_reply'
                             else 'front_desk_held_for_person' end
     where id = v_run.id;
    perform ops.pop_event_context(v_context);
    if v_disposition = 'fixed_reply' then
      perform ops.open_scripted_review(v_run, v_fixed.content -> 'messages' ->> v_key, 'fixed', v_key, 'agent-runtime');
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'disposition', v_disposition, 'screeningId', v_screening, 'fixedMessageKey', v_key));
  end if;

  -- The bounded context: the earlier turns of this conversation as the model
  -- may see them (a contact's screened text, the replies the agent or a fixed
  -- text sent; a person's reply and anything not screened stay out).
  v_turn_limit := least(greatest((v_policy.content ->> 'contextTurns')::integer, 0), 12);
  if v_inbound.conversation_id is not null and v_turn_limit > 0 then
    select coalesce(jsonb_agg(t.turn order by t.at), '[]'::jsonb) into v_turns
      from (
        select u.at, u.turn from (
          select m.received_at as at,
                 jsonb_build_object('role', 'contact', 'text',
                   (select s.model_input from ops.inbound_screenings s
                     where s.tenant_id = m.tenant_id and s.task_id = m.task_id
                     order by s.screened_at desc limit 1)) as turn
            from ops.inbound_messages m
           where m.tenant_id = v_tenant and m.conversation_id = v_inbound.conversation_id
             and m.task_id is distinct from v_run.task_id and m.received_at <= v_inbound.received_at
          union all
          select coalesce(o.sending_at, o.authorized_at) as at,
                 jsonb_build_object('role', 'agent', 'text',
                   case when s.disposition in ('model', 'fixed_reply') then ri.proposed ->> 'response_draft' end) as turn
            from ops.outbound_messages o
            join ops.review_items ri on ri.tenant_id = o.tenant_id and ri.id = o.review_item_id
            left join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
           where o.tenant_id = v_tenant and o.conversation_id = v_inbound.conversation_id
             and o.status in ('sent', 'delivered', 'read')
        ) u
        order by u.at desc
        limit v_turn_limit
      ) t;
  end if;

  -- Availability, only from the booking foundation, never from a model.
  v_tz := coalesce((select p.timezone from ops.agent_profiles p
                     where p.tenant_id = v_tenant and p.agent_id = v_run.agent_id and p.superseded_at is null),
                   'UTC');
  v_sched := v_policy.content -> 'scheduling';
  if jsonb_typeof(v_sched) = 'object'
     and coalesce(v_sched ->> 'resourceId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and coalesce(v_sched ->> 'bookingTypeId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    begin
      select coalesce(jsonb_agg(to_char(sl.start_at at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI') order by sl.start_at),
                      '[]'::jsonb)
        into v_slots
        from ops.available_slots(
               v_tenant, (v_sched ->> 'resourceId')::uuid, (v_sched ->> 'bookingTypeId')::uuid, now(),
               now() + make_interval(days => 14), 10) sl;
      v_avail := 'connected';
    exception when others then
      v_slots := null;
      v_avail := 'unavailable';
    end;
  end if;
  if v_inbound.conversation_id is not null then
    select jsonb_build_object('startsAt', to_char(b.start_at at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'))
      into v_booking
      from ops.bookings b
     where b.tenant_id = v_tenant and b.conversation_id = v_inbound.conversation_id
       and b.status = 'booked' and b.start_at > now()
     order by b.start_at
     limit 1;
  end if;

  return jsonb_build_object(
    'disposition', 'model',
    'screeningId', v_screening,
    'context', jsonb_build_object(
      'message', v_text,
      -- When the contact wrote, as the business's clock reads it: "today",
      -- "tomorrow" and "this week" mean something only against it.
      'receivedAt', to_char(v_inbound.received_at at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'),
      'partyKind', v_party,
      'phase', coalesce(v_state.phase, 'new'),
      'turns', coalesce(v_turns, '[]'::jsonb),
      'policy', v_policy.content,
      'playbook', v_playbook.content,
      'knowledge', v_knowledge.content,
      'availability', jsonb_strip_nulls(jsonb_build_object(
        'status', v_avail, 'timezone', v_tz, 'slots', v_slots)),
      'upcomingBooking', v_booking));
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. The release resolves what it ends; a person resolves an opt-out first. As 20261011120000, with the state locked first, the
--    refusal and the resolution.
-- ---------------------------------------------------------------------------

create or replace function ops.release_conversation(p_tenant_id uuid, p_conversation_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_moved boolean;
  v_open  uuid;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.release_conversation: the actor label is malformed';
  end if;
  perform 1 from ops.conversation_states s
   where s.tenant_id = p_tenant_id and s.conversation_id = p_conversation_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.release_conversation: no state for this conversation in this tenant';
  end if;
  if exists (select 1 from ops.exceptions e
              where e.tenant_id = p_tenant_id and e.conversation_id = p_conversation_id
                and e.kind = 'opt_out' and e.resolved_at is null) then
    raise exception using errcode = 'OS409',
      message = 'ops.release_conversation: an opt-out exception is open on this conversation; a person resolves it first';
  end if;
  v_moved := ops.move_conversation_state(p_conversation_id, 'holder', 'agent', 'operator', p_actor);
  for v_open in
    select e.id from ops.exceptions e
     where e.tenant_id = p_tenant_id and e.conversation_id = p_conversation_id
       and e.kind in ('person_requested', 'configuration_missing', 'message_waiting') and e.resolved_at is null
  loop
    perform ops.close_exception(v_open, 'released', p_actor);
  end loop;
  return jsonb_build_object('state', case when v_moved then 'released' else 'already_with_agent' end);
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. The send paths that move a send outside its settlement derive its
--    exceptions in the same transaction: the gateway's status entry and the
--    owner's indeterminate mark. Each as 20260918150000, with that one call.
-- ---------------------------------------------------------------------------

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

  -- ADR 0025: a failure reported after the send, or the evidence that settles
  -- an uncertain or failed one.
  perform ops.sync_send_exceptions(v_out.tenant_id, v_out.id, 'whatsapp-gateway');

  return jsonb_build_object('state', 'updated', 'status', v_next, 'previous', v_out.status);
end
$function$;

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
  -- ADR 0025: the uncertainty a person recorded reaches the queue.
  perform ops.sync_send_exceptions(p_tenant_id, v_out.id, 'operator-cli');
  return jsonb_build_object('state', 'indeterminate');
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. The browser reads exception.raised and exception.resolved: the kind, the
--    priority and the resolution. As 20260928140000 and 20260928150000, each
--    with the new types and the new source label.
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
    'exception.raised', 'exception.resolved');
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
                                                    'send_failed', 'send_indeterminate')
                     then p_payload ->> 'kind' end,
        'priority', case when p_payload ->> 'priority' in ('high', 'normal') then p_payload ->> 'priority' end)
    when p_type = 'exception.resolved' then
      pg_catalog.jsonb_build_object(
        'kind', case when p_payload ->> 'kind' in ('opt_out', 'person_requested', 'configuration_missing',
                                                    'message_waiting', 'contact_unresolved', 'do_not_contact',
                                                    'send_failed', 'send_indeterminate')
                     then p_payload ->> 'kind' end,
        'priority', case when p_payload ->> 'priority' in ('high', 'normal') then p_payload ->> 'priority' end,
        'resolution', case when p_payload ->> 'resolution' in ('released', 'reconciled', 'resolved', 'dismissed')
                           then p_payload ->> 'resolution' end)
    else '{}'::pg_catalog.jsonb
  end;
$$;

create or replace function ops.cos_event_source(p_source pg_catalog.text) returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case when p_source in ('agent-runtime', 'agent-runtime-smoke', 'company-os-ui', 'exception-queue',
                                'lead-triage-demo', 'operator-cli', 'scheduling-demo', 'seed', 'whatsapp-gateway')
              then p_source else 'other' end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Access. Backend only: no application role reaches the table or a new
--    function; the worker's and the gateway's capabilities are unchanged.
-- ---------------------------------------------------------------------------

revoke all on table ops.exceptions from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.guard_exception(),
  ops.refuse_exception_truncate(),
  ops.open_exception(uuid, uuid, uuid, text, uuid, uuid, text, text),
  ops.close_exception(uuid, text, text),
  ops.sync_send_exceptions(uuid, uuid, text),
  ops.sync_tenant_send_exceptions(uuid),
  ops.resolve_exception(uuid, uuid, text, text, integer),
  ops.release_conversation(uuid, uuid, text),
  ops.mark_outbound_indeterminate(uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 8. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad text;
  c_fns constant text[] := array[
    'guard_exception', 'refuse_exception_truncate', 'open_exception', 'close_exception', 'sync_send_exceptions',
    'sync_tenant_send_exceptions', 'resolve_exception', 'release_conversation', 'mark_outbound_indeterminate'];
begin
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = 'ops.exceptions'::pg_catalog.regclass
                    and c.relrowsecurity and c.relforcerowsecurity) then
    raise exception 'ops.exceptions lacks ENABLE + FORCE row level security';
  end if;

  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api'))
         as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.exceptions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on ops.exceptions: %', v_bad;
  end if;

  select pg_catalog.string_agg(g.name, ', ') into v_bad
    from pg_catalog.unnest(array['exceptions_guard', 'exceptions_no_truncate']) as g (name)
   where not exists (select 1 from pg_catalog.pg_trigger t
                      where t.tgrelid = 'ops.exceptions'::pg_catalog.regclass and t.tgname = g.name
                        and t.tgenabled = 'A');
  if v_bad is not null then
    raise exception 'an exceptions trigger is missing or not ENABLE ALWAYS: %', v_bad;
  end if;

  -- Every new or replaced owner function: INVOKER, a pinned search path, and
  -- executable by no application role (nor by PUBLIC).
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and (p.prosecdef
          or p.proconfig is distinct from array['search_path=""']
          or p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'an exception-queue function is reachable or not a pinned INVOKER: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname = any (c_fns)) <> pg_catalog.cardinality(c_fns) then
    raise exception 'an exception-queue function is missing or overloaded';
  end if;

  -- The two capabilities replaced here keep their definer, search path and
  -- one grantee, and carry the queue.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.record_inbound_screening(jsonb)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, 'ops.open_exception') > 0) then
    raise exception 'the screening capability lost its definer, its pinned search path or the queue';
  end if;
  if not pg_catalog.has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('ops_gateway', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.record_inbound_screening(jsonb)', 'EXECUTE') then
    raise exception 'the screening capability is no longer the worker''s alone';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, 'ops.sync_send_exceptions') > 0) then
    raise exception 'the gateway''s status entry lost its definer, its pinned search path or the queue';
  end if;
  if not pg_catalog.has_function_privilege('ops_gateway', 'ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('ops_worker', 'ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.receive_whatsapp_status(text, text, text, timestamptz, text, text, text)', 'EXECUTE') then
    raise exception 'the gateway''s status entry is no longer the gateway''s alone';
  end if;

  if not ops.cos_event_known('exception.raised') or not ops.cos_event_known('exception.resolved')
     or ops.cos_event_source('exception-queue') <> 'exception-queue' then
    raise exception 'the browser does not know the exception events or their source';
  end if;
end
$end_state$;
