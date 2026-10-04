-- ADR 0023: the front-desk agent (owner correction of 2026-10-04).
--
-- A conversational agent answers a tenant's inbound contacts on administrative
-- and commercial matters. Before any part of an inbound message reaches a model
-- provider or the structured-decision layer, the worker screens it locally
-- (engine/frontDesk/messageSanitizer.ts) and records the screening here; the
-- model and the decision layer then read ONLY the screened text this table
-- holds. This migration adds:
--
--   1. ops.agent_configuration_versions: the agent's versioned configuration
--      in four kinds (operating policy, playbook, knowledge, fixed messages).
--      Draft, published, superseded; only the published version is ever read;
--      a version is immutable once written.
--   2. ops.conversation_states and ops.conversation_transitions: who holds a
--      conversation (the agent or a person), the contact's party kind
--      (prospect or client, derived from the CRM), and the phase; every change
--      recorded once.
--   3. ops.inbound_screenings: one per screened run, with the class, the
--      counts, the versions used, the disposition and the screened text the
--      model may see. Redacted with the task's content (D6/D7, SI-72).
--   4. Two lease-bound worker capabilities: the agent's policy for the run,
--      and recording a screening (which decides the disposition, opens a fixed
--      reply's review or holds the conversation, and returns the bounded
--      context a model run may use).
--   5. A run trigger: a lead triage run of an agent with a published operating
--      policy cannot start without a screening that sent it to the model.
--   6. The structured-decision input reads the screened text, never the raw
--      message, for such an agent.
--   7. Owner acts: draft and publish a configuration version, take over and
--      release a conversation, and record a person's reply.
--
-- Nothing here opens real-data authorization: the task's data class and Q8
-- still decide what may reach a provider (ADR 0020, SI-70, SI-78). Nothing here
-- sends: a reply still needs an accepted review and the separate send act.

-- ---------------------------------------------------------------------------
-- 1. Versioned agent configuration.
-- ---------------------------------------------------------------------------

create function ops.agent_configuration_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['operating_policy', 'playbook', 'knowledge', 'fixed_messages']::text[];
$function$;

-- The fixed texts every published set must hold: the cases where the reply
-- must not depend on a model.
create function ops.fixed_message_keys()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['safety', 'human_handoff_ack', 'sensitive_only_prospect', 'sensitive_only_client',
               'clarification', 'out_of_scope', 'service_unavailable', 'opt_out_ack']::text[];
$function$;

-- A short configured text: a JSON string of 1 to p_max characters, with no
-- control character but the line break.
create function ops.configured_text_valid(p_value jsonb, p_max integer)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return false;
  end if;
  return char_length(p_value #>> '{}') between 1 and p_max
     and (p_value #>> '{}') !~ '[\x01-\x09\x0B-\x1F\x7F]';
end
$function$;

-- The shape each kind must have. The authoring tool validates the full shape
-- (engine/frontDesk/configuration.ts); the database holds what the runtime
-- relies on, including that a send mode is never autonomous (ADR 0023 §F).
create function ops.agent_configuration_valid(p_kind text, p_content jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_stage jsonb;
  v_key   text;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' or pg_column_size(p_content) > 65536 then
    return false;
  end if;
  if p_kind = 'operating_policy' then
    if coalesce(p_content ->> 'sendMode', '') not in ('staging', 'supervised')
       or coalesce(p_content ->> 'sanitizerPack', '') !~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'
       or jsonb_typeof(p_content -> 'contextTurns') is distinct from 'number'
       or (p_content ->> 'contextTurns') !~ '^[0-9]{1,2}$'
       or not ops.configured_text_valid(p_content -> 'aiDisclosure', 300) then
      return false;
    end if;
    return (p_content ->> 'contextTurns')::integer between 0 and 12;
  end if;
  if p_kind = 'playbook' then
    if jsonb_typeof(p_content -> 'stages') is distinct from 'array' then
      return false;
    end if;
    if jsonb_array_length(p_content -> 'stages') not between 1 and 20 then
      return false;
    end if;
    for v_stage in select s from jsonb_array_elements(p_content -> 'stages') s loop
      if jsonb_typeof(v_stage) <> 'object'
         or coalesce(v_stage ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$'
         or not ops.configured_text_valid(v_stage -> 'objective', 500) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if p_kind = 'knowledge' then
    if jsonb_typeof(p_content -> 'domains') is distinct from 'object' then
      return false;
    end if;
    return exists (select 1 from jsonb_object_keys(p_content -> 'domains'));
  end if;
  if p_kind = 'fixed_messages' then
    if jsonb_typeof(p_content -> 'messages') is distinct from 'object' then
      return false;
    end if;
    foreach v_key in array ops.fixed_message_keys() loop
      if not ops.configured_text_valid(p_content -> 'messages' -> v_key, 1000) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return false;
end
$function$;

create table ops.agent_configuration_versions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  company_id      uuid not null,
  agent_id        uuid not null,
  kind            text not null,
  version         integer not null,
  status          text not null default 'draft',
  content         jsonb not null,
  content_sha256  text not null,
  drafted_by      text not null,
  drafted_at      timestamptz not null default now(),
  published_by    text,
  published_at    timestamptz,
  superseded_at   timestamptz,
  constraint agent_configuration_versions_agent_fkey
    foreign key (tenant_id, company_id, agent_id) references ops.agents (tenant_id, company_id, id)
    on delete cascade,
  constraint agent_configuration_versions_version_key unique (tenant_id, agent_id, kind, version),
  constraint agent_configuration_versions_kind_check check (kind = any (ops.agent_configuration_kinds())),
  constraint agent_configuration_versions_version_range check (version between 1 and 100000),
  constraint agent_configuration_versions_status_check check (status in ('draft', 'published', 'superseded')),
  constraint agent_configuration_versions_content_valid check (ops.agent_configuration_valid(kind, content)),
  constraint agent_configuration_versions_sha_format check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint agent_configuration_versions_actor_format check (
        drafted_by ~ '^[A-Za-z0-9._:@-]{1,200}$'
    and (published_by is null or published_by ~ '^[A-Za-z0-9._:@-]{1,200}$')),
  constraint agent_configuration_versions_published_shape check (
    (status = 'draft') = (published_at is null) and (published_at is null) = (published_by is null)),
  constraint agent_configuration_versions_superseded_shape check ((status = 'superseded') = (superseded_at is not null))
);

-- One published version per agent and kind.
create unique index agent_configuration_versions_one_published
  on ops.agent_configuration_versions (tenant_id, agent_id, kind) where status = 'published';

create function ops.guard_agent_configuration_version()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- History leaves only with its agent.
  if tg_op = 'DELETE' then
    if exists (select 1 from ops.agents a where a.id = old.agent_id) then
      raise exception using errcode = 'OS403',
        message = 'ops.agent_configuration_versions: a configuration version is history and leaves only with its agent';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.published_at is not null or new.superseded_at is not null then
      raise exception using errcode = 'OS403', message = 'ops.agent_configuration_versions: a version is born a draft';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'published_by', 'published_at', 'superseded_at'])
       is distinct from (to_jsonb(old) - array['status', 'published_by', 'published_at', 'superseded_at']) then
    raise exception using errcode = 'OS403',
      message = 'ops.agent_configuration_versions: a version is immutable; only its status moves';
  end if;
  if old.status = 'draft' and new.status = 'published' and new.superseded_at is null then
    return new;
  end if;
  if old.status = 'published' and new.status = 'superseded'
     and new.published_at = old.published_at and new.published_by = old.published_by then
    return new;
  end if;
  raise exception using errcode = 'OS403',
    message = 'ops.agent_configuration_versions: a version moves only from draft to published, then to superseded';
end
$function$;

create function ops.refuse_agent_configuration_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.agent_configuration_versions: history is never truncated';
end
$function$;

create trigger agent_configuration_versions_guard
  before insert or update or delete on ops.agent_configuration_versions
  for each row execute function ops.guard_agent_configuration_version();
alter table ops.agent_configuration_versions enable always trigger agent_configuration_versions_guard;

create trigger agent_configuration_versions_no_truncate
  before truncate on ops.agent_configuration_versions
  for each statement execute function ops.refuse_agent_configuration_truncate();
alter table ops.agent_configuration_versions enable always trigger agent_configuration_versions_no_truncate;

-- The published version of one kind for one agent, or an empty row.
create function ops.published_agent_configuration(p_tenant_id uuid, p_agent_id uuid, p_kind text)
returns ops.agent_configuration_versions
language sql
stable
security invoker
set search_path to ''
as $function$
  select v.* from ops.agent_configuration_versions v
   where v.tenant_id = p_tenant_id and v.agent_id = p_agent_id and v.kind = p_kind and v.status = 'published';
$function$;

-- The owner's act: a new draft version of one kind.
create function ops.draft_agent_configuration(
  p_tenant_id uuid, p_agent_id uuid, p_kind text, p_content jsonb, p_actor text)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_agent   ops.agents;
  v_version integer;
  v_id      uuid;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.draft_agent_configuration: the actor label is malformed';
  end if;
  if p_kind is null or not (p_kind = any (ops.agent_configuration_kinds())) then
    raise exception using errcode = 'OS400', message = 'ops.draft_agent_configuration: unknown configuration kind';
  end if;
  if not ops.agent_configuration_valid(p_kind, p_content) then
    raise exception using errcode = 'OS400',
      message = format('ops.draft_agent_configuration: the content does not have the %s shape', p_kind);
  end if;
  select a.* into v_agent from ops.agents a where a.tenant_id = p_tenant_id and a.id = p_agent_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.draft_agent_configuration: agent not found in this tenant';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(format('agent_configuration:%s:%s', p_agent_id, p_kind), 0));
  select coalesce(max(v.version), 0) + 1 into v_version
    from ops.agent_configuration_versions v
   where v.tenant_id = p_tenant_id and v.agent_id = p_agent_id and v.kind = p_kind;
  insert into ops.agent_configuration_versions (
    tenant_id, company_id, agent_id, kind, version, content, content_sha256, drafted_by)
  values (
    p_tenant_id, v_agent.company_id, p_agent_id, p_kind, v_version, p_content,
    encode(sha256(convert_to(p_content::text, 'UTF8')), 'hex'), p_actor)
  returning id into v_id;
  return v_id;
end
$function$;

-- The owner's act: publish a draft, superseding the published version of its kind.
create function ops.publish_agent_configuration(p_tenant_id uuid, p_version_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_row        ops.agent_configuration_versions;
  v_superseded uuid;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.publish_agent_configuration: the actor label is malformed';
  end if;
  select v.* into v_row from ops.agent_configuration_versions v
   where v.tenant_id = p_tenant_id and v.id = p_version_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.publish_agent_configuration: version not found in this tenant';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(format('agent_configuration:%s:%s', v_row.agent_id, v_row.kind), 0));
  select v.* into v_row from ops.agent_configuration_versions v where v.id = p_version_id for update;
  if v_row.status = 'published' then
    return jsonb_build_object('state', 'already_published', 'id', v_row.id, 'kind', v_row.kind, 'version', v_row.version);
  end if;
  if v_row.status <> 'draft' then
    raise exception using errcode = 'OS409', message = 'ops.publish_agent_configuration: a superseded version is not published again';
  end if;
  update ops.agent_configuration_versions v
     set status = 'superseded', superseded_at = now()
   where v.tenant_id = v_row.tenant_id and v.agent_id = v_row.agent_id and v.kind = v_row.kind
     and v.status = 'published'
  returning v.id into v_superseded;
  update ops.agent_configuration_versions
     set status = 'published', published_by = p_actor, published_at = now()
   where id = v_row.id;
  return jsonb_strip_nulls(jsonb_build_object(
    'state', 'published', 'id', v_row.id, 'kind', v_row.kind, 'version', v_row.version,
    'superseded_id', v_superseded));
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. Conversation state and its history.
-- ---------------------------------------------------------------------------

create table ops.conversation_states (
  conversation_id   uuid primary key,
  tenant_id         uuid not null,
  company_id        uuid not null,
  party_kind        text not null default 'prospect',
  phase             text not null default 'new',
  holder            text not null default 'agent',
  holder_reason     text,
  holder_changed_at timestamptz,
  holder_changed_by text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint conversation_states_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id) references ops.conversations (tenant_id, company_id, id)
    on delete cascade,
  constraint conversation_states_party_kind_check check (party_kind in ('prospect', 'client', 'unknown')),
  constraint conversation_states_phase_check check (phase in ('new', 'engaged', 'closed')),
  constraint conversation_states_holder_check check (holder in ('agent', 'person')),
  constraint conversation_states_holder_reason_check check (
    holder_reason is null or holder_reason in ('person_requested', 'safety', 'opt_out', 'operator')),
  constraint conversation_states_held_shape check ((holder = 'person') = (holder_reason is not null)),
  constraint conversation_states_actor_format check (
    holder_changed_by is null or holder_changed_by ~ '^[A-Za-z0-9._:@-]{1,200}$')
);

create table ops.conversation_transitions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  company_id      uuid not null,
  conversation_id uuid not null,
  dimension       text not null,
  from_value      text,
  to_value        text not null,
  reason          text not null,
  actor           text not null,
  occurred_at     timestamptz not null default now(),
  constraint conversation_transitions_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id) references ops.conversations (tenant_id, company_id, id)
    on delete cascade,
  constraint conversation_transitions_dimension_check check (dimension in ('holder', 'party_kind', 'phase')),
  constraint conversation_transitions_value_format check (
        (from_value is null or from_value ~ '^[a-z][a-z_]{0,39}$') and to_value ~ '^[a-z][a-z_]{0,39}$'),
  constraint conversation_transitions_reason_format check (reason ~ '^[a-z][a-z_]{0,39}$'),
  constraint conversation_transitions_actor_format check (actor ~ '^[A-Za-z0-9._:@-]{1,200}$')
);
create index conversation_transitions_conversation_idx
  on ops.conversation_transitions (tenant_id, conversation_id, occurred_at);

create function ops.guard_conversation_state()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' and (new.conversation_id, new.tenant_id, new.company_id, new.created_at)
       is distinct from (old.conversation_id, old.tenant_id, old.company_id, old.created_at) then
    raise exception using errcode = 'OS403', message = 'ops.conversation_states: identity is immutable';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end
$function$;

-- Append-only: the history leaves only with its conversation.
create function ops.guard_conversation_transition()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = 'OS403', message = 'ops.conversation_transitions: history is never rewritten';
  end if;
  if exists (select 1 from ops.conversations c where c.id = old.conversation_id) then
    raise exception using errcode = 'OS403',
      message = 'ops.conversation_transitions: history leaves only with its conversation';
  end if;
  return old;
end
$function$;

create function ops.refuse_conversation_state_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'conversation state and history are never truncated';
end
$function$;

create trigger conversation_states_guard
  before update on ops.conversation_states
  for each row execute function ops.guard_conversation_state();
alter table ops.conversation_states enable always trigger conversation_states_guard;
create trigger conversation_states_no_truncate
  before truncate on ops.conversation_states
  for each statement execute function ops.refuse_conversation_state_truncate();
alter table ops.conversation_states enable always trigger conversation_states_no_truncate;

create trigger conversation_transitions_guard
  before update or delete on ops.conversation_transitions
  for each row execute function ops.guard_conversation_transition();
alter table ops.conversation_transitions enable always trigger conversation_transitions_guard;
create trigger conversation_transitions_no_truncate
  before truncate on ops.conversation_transitions
  for each statement execute function ops.refuse_conversation_state_truncate();
alter table ops.conversation_transitions enable always trigger conversation_transitions_no_truncate;

-- One change of one dimension, recorded once. Returns whether it changed.
create function ops.move_conversation_state(
  p_conversation_id uuid, p_dimension text, p_to text, p_reason text, p_actor text)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_state ops.conversation_states;
  v_from  text;
begin
  select s.* into v_state from ops.conversation_states s where s.conversation_id = p_conversation_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.move_conversation_state: no state for this conversation';
  end if;
  v_from := case p_dimension when 'holder' then v_state.holder
                             when 'party_kind' then v_state.party_kind
                             when 'phase' then v_state.phase end;
  if v_from is not distinct from p_to then
    return false;
  end if;
  if p_dimension = 'holder' then
    update ops.conversation_states
       set holder = p_to,
           holder_reason = case when p_to = 'person' then p_reason else null end,
           holder_changed_at = now(), holder_changed_by = p_actor
     where conversation_id = p_conversation_id;
  elsif p_dimension = 'party_kind' then
    update ops.conversation_states set party_kind = p_to where conversation_id = p_conversation_id;
  elsif p_dimension = 'phase' then
    update ops.conversation_states set phase = p_to where conversation_id = p_conversation_id;
  else
    raise exception using errcode = 'OS400', message = 'ops.move_conversation_state: unknown dimension';
  end if;
  insert into ops.conversation_transitions (
    tenant_id, company_id, conversation_id, dimension, from_value, to_value, reason, actor)
  values (v_state.tenant_id, v_state.company_id, p_conversation_id, p_dimension, v_from, p_to, p_reason, p_actor);
  return true;
end
$function$;

-- The CRM adapter for the party kind: whether the CRM contact the admission
-- resolved has a converted opportunity (a client), read only for the tenant
-- that owns this deployment's CRM. Null when it cannot tell.
create function ops.crm_contact_is_client(p_tenant_id uuid, p_crm_contact_ref text)
returns boolean
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_contact bigint;
begin
  if not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return null;
  end if;
  if p_crm_contact_ref is null or p_crm_contact_ref !~ '^crm:contact:[0-9]{1,18}$' then
    return null;
  end if;
  v_contact := substr(p_crm_contact_ref, 13)::bigint;
  return exists (select 1 from public.deals d
                  where d.contact_ids @> array[v_contact] and d.converted_at is not null);
end
$function$;

-- ---------------------------------------------------------------------------
-- 3. Inbound screenings.
-- ---------------------------------------------------------------------------

create table ops.inbound_screenings (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null,
  company_id                  uuid not null,
  task_id                     uuid not null,
  agent_run_id                uuid not null,
  conversation_id             uuid,
  screener_version            text not null,
  pack_id                     text not null,
  message_class               text not null,
  safety_class                text not null,
  segments_redacted           integer not null,
  segments_sensitive          integer not null,
  segments_unrecognised       integer not null,
  administrative_intent       boolean not null,
  person_requested            boolean not null,
  opt_out_requested           boolean not null,
  model_input                 text,
  party_kind                  text not null,
  disposition                 text not null,
  fixed_message_key           text,
  policy_version_id           uuid not null references ops.agent_configuration_versions (id),
  playbook_version_id         uuid references ops.agent_configuration_versions (id),
  knowledge_version_id        uuid references ops.agent_configuration_versions (id),
  fixed_messages_version_id   uuid references ops.agent_configuration_versions (id),
  screened_at                 timestamptz not null default now(),
  content_redacted_at         timestamptz,
  constraint inbound_screenings_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id)
    on delete cascade,
  constraint inbound_screenings_run_key unique (agent_run_id),
  constraint inbound_screenings_version_format check (
    screener_version ~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$' and pack_id ~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'),
  constraint inbound_screenings_class_check check (
    message_class in ('administrative', 'mixed', 'sensitive_only', 'safety', 'unknown')),
  constraint inbound_screenings_safety_check check (
    safety_class in ('none', 'crisis') and (safety_class = 'crisis') = (message_class = 'safety')),
  constraint inbound_screenings_counts check (
        segments_sensitive between 0 and 1000 and segments_unrecognised between 0 and 1000
    and segments_redacted = segments_sensitive + segments_unrecognised),
  constraint inbound_screenings_party_check check (party_kind in ('prospect', 'client', 'unknown')),
  constraint inbound_screenings_disposition_check check (
    disposition in ('model', 'fixed_reply', 'held_for_person')),
  constraint inbound_screenings_fixed_shape check (
    (disposition = 'fixed_reply') = (fixed_message_key is not null)
    and (fixed_message_key is null or fixed_message_key = any (ops.fixed_message_keys()))
    and (disposition <> 'fixed_reply' or fixed_messages_version_id is not null)),
  -- Only a screening that kept an administrative request sends anything.
  constraint inbound_screenings_model_shape check (
        disposition <> 'model'
     or (message_class in ('administrative', 'mixed') and (model_input is not null or content_redacted_at is not null))),
  constraint inbound_screenings_blocked_shape check (
    message_class in ('administrative', 'mixed') or model_input is null),
  constraint inbound_screenings_input_length check (model_input is null or char_length(model_input) between 1 and 4000),
  constraint inbound_screenings_redacted_shape check (content_redacted_at is null or model_input is null)
);
create index inbound_screenings_task_idx on ops.inbound_screenings (tenant_id, task_id, screened_at);
create index inbound_screenings_conversation_idx on ops.inbound_screenings (tenant_id, conversation_id);

-- Immutable but for the redaction of the screened text, which follows its
-- task's (D6/D7): at the instant the task's own content was redacted.
create function ops.guard_inbound_screening()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_task_redacted timestamptz;
begin
  -- A screening leaves only with its task.
  if tg_op = 'DELETE' then
    if exists (select 1 from ops.tasks t where t.id = old.task_id) then
      raise exception using errcode = 'OS403', message = 'ops.inbound_screenings: a screening leaves only with its task';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.content_redacted_at is not null then
      raise exception using errcode = 'OS403', message = 'ops.inbound_screenings: a screening is born unredacted';
    end if;
    return new;
  end if;
  select t.content_redacted_at into v_task_redacted from ops.tasks t where t.id = new.task_id;
  if (to_jsonb(new) - array['model_input', 'content_redacted_at'])
       is distinct from (to_jsonb(old) - array['model_input', 'content_redacted_at'])
     or old.content_redacted_at is not null
     or new.model_input is not null
     or new.content_redacted_at is null
     or new.content_redacted_at is distinct from v_task_redacted then
    raise exception using errcode = 'OS403',
      message = 'ops.inbound_screenings: a screening is immutable; its text is only redacted with its task';
  end if;
  return new;
end
$function$;

create function ops.refuse_inbound_screening_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.inbound_screenings: screenings are never truncated';
end
$function$;

create trigger inbound_screenings_guard
  before insert or update or delete on ops.inbound_screenings
  for each row execute function ops.guard_inbound_screening();
alter table ops.inbound_screenings enable always trigger inbound_screenings_guard;
create trigger inbound_screenings_no_truncate
  before truncate on ops.inbound_screenings
  for each statement execute function ops.refuse_inbound_screening_truncate();
alter table ops.inbound_screenings enable always trigger inbound_screenings_no_truncate;

-- When a task's content is redacted (retention or erasure), so is the text
-- its screenings derived from it.
create function ops.redact_task_screenings()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  update ops.inbound_screenings s
     set model_input = null, content_redacted_at = new.content_redacted_at
   where s.tenant_id = new.tenant_id and s.task_id = new.id and s.content_redacted_at is null;
  return null;
end
$function$;

create trigger tasks_redact_screenings
  after update of content_redacted_at on ops.tasks
  for each row
  when (old.content_redacted_at is null and new.content_redacted_at is not null)
  execute function ops.redact_task_screenings();
alter table ops.tasks enable always trigger tasks_redact_screenings;

-- ---------------------------------------------------------------------------
-- 4. Reviews the database opens itself: a fixed reply, a person's reply.
-- ---------------------------------------------------------------------------

-- A review in the lead triage contract, so the existing review, decision and
-- send paths carry it unchanged (SI-45, SI-50).
create function ops.open_scripted_review(
  p_run ops.agent_runs, p_draft text, p_kind text, p_key text, p_source text)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_proposed jsonb;
  v_dnc      boolean;
  v_review   uuid;
begin
  v_proposed := jsonb_build_object(
    'outcome', case when p_key = 'clarification' then 'needs_input' else 'triaged' end,
    'summary', case when p_kind = 'person'
                    then 'A reply written by a person.'
                    else format('Fixed reply %s; no model was called.', p_key) end,
    'intent', 'other',
    'priority', case when p_key = 'safety' then 'high' else 'normal' end,
    'recommended_next_action', case p_key
      when 'safety' then 'A person should look at this conversation now.'
      when 'human_handoff_ack' then 'A person takes over this conversation.'
      when 'opt_out_ack' then 'Record the opt-out in the CRM, then send the acknowledgement.'
      else 'Send the reply after review.' end,
    'response_draft', p_draft,
    'needs_human_review', true,
    'flags', case p_key when 'safety' then '["possible_crisis"]'::jsonb
                        when 'clarification' then '["unclear"]'::jsonb
                        else '[]'::jsonb end);
  if not ops.agent_run_result_valid('lead_triage', v_proposed) then
    raise exception using errcode = 'OS400', message = 'ops.open_scripted_review: the reply does not fit the review contract';
  end if;
  select coalesce(bool_or(m.do_not_contact), true) into v_dnc
    from ops.inbound_messages m
   where m.tenant_id = p_run.tenant_id and m.task_id = p_run.task_id;
  insert into ops.review_items (
    tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (p_run.tenant_id, p_run.company_id, p_run.task_id, p_run.id, 'lead_triage', v_proposed, v_dnc)
  on conflict (agent_run_id) do nothing
  returning id into v_review;
  if v_review is null then
    raise exception using errcode = 'OS409', message = 'ops.open_scripted_review: this run already has its review';
  end if;
  perform ops.record_event(
    p_run.tenant_id, p_run.company_id, 'lead_triage.review_pending', p_source, 'task', p_run.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', p_run.id),
    p_run.correlation_id, null, format('review:%s:pending', p_run.id));
  return v_review;
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. The worker's two lease-bound capabilities.
-- ---------------------------------------------------------------------------

-- Whether the run bound to the leased job belongs to an agent with a
-- published operating policy, and which screening pack that policy names.
create function ops.front_desk_policy_for_run()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt integer := ops.agent_run_lease_attempt();
  v_tenant  uuid := ops.current_tenant_id();
  v_job     uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run     ops.agent_runs;
  v_policy  ops.agent_configuration_versions;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job;
  if not found then
    raise exception 'ops.front_desk_policy_for_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.capability <> 'lead_triage' then
    return jsonb_build_object('applies', false);
  end if;
  v_policy := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'operating_policy');
  if v_policy.id is null then
    return jsonb_build_object('applies', false);
  end if;
  return jsonb_build_object('applies', true, 'packId', v_policy.content ->> 'sanitizerPack');
end
$function$;

-- Records the screening of the run bound to the leased job and decides what
-- happens to it, in this order: a conversation a person holds stays with the
-- person; danger, a request for a person and an opt-out get their fixed reply
-- and move the conversation to a person; a message left with nothing to send
-- gets its fixed reply; everything else goes to the model. Every disposition
-- but `model` settles the run now, with no call. A `model` answer carries the
-- bounded context the prompt is built from: the screened text, never the raw.
create function ops.record_inbound_screening(p_screening jsonb)
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
  end if;

  -- The disposition.
  if v_state.holder = 'person' then
    v_disposition := 'held_for_person';
  else
    v_key := case
      when v_safety = 'crisis' then 'safety'
      when v_person then 'human_handoff_ack'
      when v_opt_out then 'opt_out_ack'
      when v_class = 'sensitive_only' then
        case when v_party = 'client' then 'sensitive_only_client' else 'sensitive_only_prospect' end
      when v_class = 'unknown' then 'clarification'
      else null end;
    v_reason := case when v_safety = 'crisis' then 'safety'
                     when v_person then 'person_requested'
                     when v_opt_out then 'opt_out' end;
    if v_key is null then
      v_disposition := 'model';
    elsif v_fixed.id is null then
      -- Nobody published the fixed texts: a person answers.
      v_disposition := 'held_for_person';
      v_key := null;
      v_reason := coalesce(v_reason, 'operator');
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
               now() + make_interval(days => 14), 6) sl;
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
-- 6. No front-desk run starts without a screening that sent it to the model.
-- ---------------------------------------------------------------------------

create function ops.require_inbound_screening()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.status = 'pending' and new.status = 'running' and new.capability = 'lead_triage'
     and (ops.published_agent_configuration(new.tenant_id, new.agent_id, 'operating_policy')).id is not null
     and not exists (select 1 from ops.inbound_screenings s
                      where s.agent_run_id = new.id and s.disposition = 'model') then
    raise exception using errcode = 'OS403',
      message = 'ops.agent_runs: a front-desk run starts only after its screening sent it to the model';
  end if;
  return new;
end
$function$;

create trigger agent_runs_require_screening
  before update of status on ops.agent_runs
  for each row execute function ops.require_inbound_screening();
alter table ops.agent_runs enable always trigger agent_runs_require_screening;

-- ---------------------------------------------------------------------------
-- 7. Owner acts on a conversation.
-- ---------------------------------------------------------------------------

create function ops.take_over_conversation(p_tenant_id uuid, p_conversation_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv ops.conversations;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.take_over_conversation: the actor label is malformed';
  end if;
  select c.* into v_conv from ops.conversations c where c.tenant_id = p_tenant_id and c.id = p_conversation_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.take_over_conversation: conversation not found in this tenant';
  end if;
  insert into ops.conversation_states (conversation_id, tenant_id, company_id)
  values (v_conv.id, v_conv.tenant_id, v_conv.company_id)
  on conflict (conversation_id) do nothing;
  return jsonb_build_object('state',
    case when ops.move_conversation_state(v_conv.id, 'holder', 'person', 'operator', p_actor)
         then 'taken_over' else 'already_held' end);
end
$function$;

create function ops.release_conversation(p_tenant_id uuid, p_conversation_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.release_conversation: the actor label is malformed';
  end if;
  if not exists (select 1 from ops.conversation_states s
                  where s.tenant_id = p_tenant_id and s.conversation_id = p_conversation_id) then
    raise exception using errcode = 'OS404', message = 'ops.release_conversation: no state for this conversation in this tenant';
  end if;
  return jsonb_build_object('state',
    case when ops.move_conversation_state(p_conversation_id, 'holder', 'agent', 'operator', p_actor)
         then 'released' else 'already_with_agent' end);
end
$function$;

-- A person's reply to the latest unanswered message of a conversation the
-- person holds: a review the person's own act accepts, sent by the usual send
-- act. One reply per message that waits for one.
create function ops.record_person_reply(p_tenant_id uuid, p_conversation_id uuid, p_text text, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_state  ops.conversation_states;
  v_run    ops.agent_runs;
  v_review uuid;
  v_result jsonb;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_person_reply: the actor label is malformed';
  end if;
  if p_text is null or char_length(p_text) not between 1 and 2000 or p_text ~ '[\x01-\x09\x0B-\x1F\x7F]' then
    raise exception using errcode = 'OS400',
      message = 'ops.record_person_reply: a reply has 1 to 2000 characters and no control character but the line break';
  end if;
  select s.* into v_state from ops.conversation_states s
   where s.tenant_id = p_tenant_id and s.conversation_id = p_conversation_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.record_person_reply: no state for this conversation in this tenant';
  end if;
  if v_state.holder <> 'person' then
    raise exception using errcode = 'OS409', message = 'ops.record_person_reply: take the conversation over first';
  end if;
  select r.* into v_run
    from ops.inbound_messages m
    join ops.agent_runs r on r.tenant_id = m.tenant_id and r.id = m.agent_run_id
   where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id
     and r.status = 'cancelled' and r.error_code = 'front_desk_held_for_person'
     and not exists (select 1 from ops.review_items ri where ri.tenant_id = r.tenant_id and ri.agent_run_id = r.id)
   order by m.received_at desc
   limit 1;
  if v_run.id is null then
    raise exception using errcode = 'OS409', message = 'ops.record_person_reply: no message in this conversation waits for a reply';
  end if;
  v_review := ops.open_scripted_review(v_run, p_text, 'person', null, 'operator-cli');
  v_result := ops.record_review_decision(p_tenant_id, v_review, 'accepted', p_actor, 'operator-cli', null);
  return jsonb_build_object('state', 'recorded', 'review_item_id', v_review, 'decision', v_result ->> 'status');
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. The structured-decision input reads the screened text.
-- ---------------------------------------------------------------------------

-- As 20261008120000, except the business route's message: for an agent with a
-- published operating policy it is the latest screening's text of the task,
-- and nothing (not eligible) when there is none. The raw description is read
-- only for an agent without a front-desk policy, whose data Q8 limits to
-- synthetic and test (SI-80).
create or replace function ops.structured_decision_input(p_decision ops.structured_decisions)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_task    ops.tasks;
  v_run     ops.agent_runs;
  v_route   ops.agent_run_routes;
  v_depts   text[];
  v_caps    text[];
  v_result  jsonb;
  v_first   timestamptz;
  v_last    timestamptz;
  v_count   integer;
  v_cplx    text;
  v_message text;
begin
  select t.* into v_task from ops.tasks t where t.tenant_id = p_decision.tenant_id and t.id = p_decision.task_id;
  select r.* into v_run from ops.agent_runs r where r.tenant_id = p_decision.tenant_id and r.id = p_decision.agent_run_id;
  if v_task.id is null or v_run.id is null then
    return null;
  end if;

  if p_decision.decision_kind = 'business_route' then
    if (ops.published_agent_configuration(v_task.tenant_id, v_run.agent_id, 'operating_policy')).id is not null
       or exists (select 1 from ops.inbound_screenings s where s.tenant_id = v_task.tenant_id and s.task_id = v_task.id) then
      select s.model_input into v_message
        from ops.inbound_screenings s
       where s.tenant_id = v_task.tenant_id and s.task_id = v_task.id
       order by s.screened_at desc
       limit 1;
    else
      v_message := v_task.description;
    end if;
    if v_message is null or btrim(v_message) = '' then
      return null;
    end if;
    select coalesce(array_agg(d.slug order by d.slug), '{}') into v_depts
      from ops.departments d
     where d.tenant_id = v_task.tenant_id and d.company_id = v_task.company_id and d.status = 'active';
    select array_agg(c.capability order by c.capability) into v_caps from ops.agent_run_capabilities() c;
    return jsonb_build_object(
      'input', jsonb_build_object('sourceClass', v_task.data_class, 'message', left(v_message, 4000),
                                  'departments', to_jsonb(v_depts), 'capabilities', to_jsonb(v_caps)),
      'spec', jsonb_build_object(
        'intent', jsonb_build_object('type', 'choice', 'options', to_jsonb(ops.business_intents_v1())),
        'department', jsonb_build_object('type', 'choice', 'options', to_jsonb(v_depts || array['human_review', 'no_action'])),
        'capability', jsonb_build_object('type', 'choice', 'options', to_jsonb(v_caps || array['none'])),
        'complexity', jsonb_build_object('type', 'score', 'levels', 3),
        'human_review', jsonb_build_object('type', 'noul')));
  end if;

  if p_decision.decision_kind = 'lead_intelligence' then
    v_result := v_run.result;
    if v_run.status <> 'succeeded' or v_result is null or jsonb_typeof(v_result) <> 'object' then
      return null;
    end if;
    select min(i.received_at), max(i.received_at), count(*)::int into v_first, v_last, v_count
      from ops.inbound_messages i
     where i.tenant_id = v_task.tenant_id
       and i.conversation_id is not null
       and i.conversation_id = (select i2.conversation_id from ops.inbound_messages i2
                                 where i2.tenant_id = v_task.tenant_id and i2.task_id = v_task.id limit 1);
    if v_count is null or v_count = 0 then
      select 1, now(), now() into v_count, v_first, v_last;
    end if;
    return jsonb_build_object(
      'input', jsonb_build_object(
        'intent', case when v_result ->> 'intent' in ('book_appointment', 'pricing', 'information', 'support', 'other')
                       then v_result ->> 'intent' else 'other' end,
        'priority', case when v_result ->> 'priority' in ('low', 'normal', 'high') then v_result ->> 'priority' else 'normal' end,
        'funnel_stage', 'unknown',
        'has_open_opportunity', 'unknown',
        'inbound_messages', least(v_count, 10000),
        'days_since_first_contact', least(greatest(extract(day from now() - v_first)::int, 0), 36500),
        'hours_since_last_inbound', least(greatest(floor(extract(epoch from now() - v_last) / 3600)::int, 0), 876000)),
      'spec', jsonb_build_object(
        'commercial_readiness', jsonb_build_object('type', 'score', 'levels', 3),
        'scheduling_readiness', jsonb_build_object('type', 'score', 'levels', 3),
        'follow_up_priority', jsonb_build_object('type', 'score', 'levels', 3),
        'objection', jsonb_build_object('type', 'choice', 'options',
          to_jsonb(array['price', 'schedule', 'modality', 'trust_or_fit', 'none', 'unknown'])),
        'next_best_action', jsonb_build_object('type', 'choice', 'options',
          to_jsonb(array['offer_slots', 'share_pricing_information', 'answer_question', 'follow_up_later', 'human_review']))));
  end if;

  -- model_route
  select r.* into v_route from ops.agent_run_routes r where r.agent_run_id = v_run.id and r.tenant_id = v_run.tenant_id;
  if v_route.agent_run_id is null or jsonb_array_length(v_route.candidates) < 2 then
    return null;
  end if;
  select case when (d.answers -> 'complexity' ->> 'score')::numeric < 0.5 then 'low'
              when (d.answers -> 'complexity' ->> 'score')::numeric < 1.5 then 'medium'
              else 'high' end
    into v_cplx
    from ops.structured_decisions d
   where d.tenant_id = p_decision.tenant_id and d.task_id = p_decision.task_id
     and d.decision_kind = 'business_route' and d.status = 'completed';
  return jsonb_build_object(
    'input', jsonb_build_object(
      'capability', v_run.capability,
      'complexity', coalesce(v_cplx, 'unknown'),
      'inputSize', case when coalesce(v_run.input_tokens, 0) <= 2000 then 'small'
                        when v_run.input_tokens <= 16000 then 'medium' else 'large' end,
      'candidates', (select jsonb_agg(jsonb_build_object(
                       'model', c ->> 'model', 'family', c ->> 'family', 'costClass', c ->> 'costClass',
                       'latencyClass', c ->> 'latencyClass', 'reasoning', (c ->> 'reasoning')::boolean,
                       'contextClass', c ->> 'contextClass') order by (c ->> 'rank')::int)
                       from jsonb_array_elements(v_route.candidates) c)),
    'spec', jsonb_build_object(
      'model', jsonb_build_object('type', 'choice', 'options',
        (select jsonb_agg(c ->> 'model' order by (c ->> 'rank')::int) from jsonb_array_elements(v_route.candidates) c))));
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Access: backend only. The worker reaches the new state only through its
--    two lease-bound capabilities; the owner acts are granted to nobody.
-- ---------------------------------------------------------------------------

alter table ops.agent_configuration_versions enable row level security;
alter table ops.agent_configuration_versions force row level security;
alter table ops.conversation_states enable row level security;
alter table ops.conversation_states force row level security;
alter table ops.conversation_transitions enable row level security;
alter table ops.conversation_transitions force row level security;
alter table ops.inbound_screenings enable row level security;
alter table ops.inbound_screenings force row level security;

revoke all on table ops.agent_configuration_versions, ops.conversation_states, ops.conversation_transitions,
  ops.inbound_screenings
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.agent_configuration_kinds(),
  ops.fixed_message_keys(),
  ops.configured_text_valid(jsonb, integer),
  ops.agent_configuration_valid(text, jsonb),
  ops.guard_agent_configuration_version(),
  ops.refuse_agent_configuration_truncate(),
  ops.published_agent_configuration(uuid, uuid, text),
  ops.draft_agent_configuration(uuid, uuid, text, jsonb, text),
  ops.publish_agent_configuration(uuid, uuid, text),
  ops.guard_conversation_state(),
  ops.guard_conversation_transition(),
  ops.refuse_conversation_state_truncate(),
  ops.move_conversation_state(uuid, text, text, text, text),
  ops.crm_contact_is_client(uuid, text),
  ops.guard_inbound_screening(),
  ops.refuse_inbound_screening_truncate(),
  ops.redact_task_screenings(),
  ops.open_scripted_review(ops.agent_runs, text, text, text, text),
  ops.front_desk_policy_for_run(),
  ops.record_inbound_screening(jsonb),
  ops.require_inbound_screening(),
  ops.take_over_conversation(uuid, uuid, text),
  ops.release_conversation(uuid, uuid, text),
  ops.record_person_reply(uuid, uuid, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

grant execute on function ops.front_desk_policy_for_run() to ops_worker;
grant execute on function ops.record_inbound_screening(jsonb) to ops_worker;

-- ---------------------------------------------------------------------------
-- 10. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ') into v_bad
    from pg_catalog.pg_class c
   where c.oid in ('ops.agent_configuration_versions'::regclass, 'ops.conversation_states'::regclass,
                   'ops.conversation_transitions'::regclass, 'ops.inbound_screenings'::regclass)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'a front-desk table lacks ENABLE + FORCE row level security: %', v_bad;
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where has_table_privilege(r.rolname, 'ops.agent_configuration_versions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege(r.rolname, 'ops.conversation_states', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege(r.rolname, 'ops.conversation_transitions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege(r.rolname, 'ops.inbound_screenings', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a front-desk table: %', v_bad;
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where t.tgrelid in ('ops.agent_configuration_versions'::regclass, 'ops.conversation_states'::regclass,
                           'ops.conversation_transitions'::regclass, 'ops.inbound_screenings'::regclass)
         and not t.tgisinternal and t.tgenabled = 'A') <> 8
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = 'ops.agent_runs'::regclass
                       and t.tgname = 'agent_runs_require_screening' and t.tgenabled = 'A')
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = 'ops.tasks'::regclass
                       and t.tgname = 'tasks_redact_screenings' and t.tgenabled = 'A') then
    raise exception 'the front-desk guards and triggers are not all ENABLE ALWAYS';
  end if;
  -- Exactly two new worker capabilities, lease-bound and SECURITY DEFINER.
  if not has_function_privilege('ops_worker', 'ops.front_desk_policy_for_run()', 'EXECUTE')
     or not has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or not (select bool_and(p.prosecdef) from pg_catalog.pg_proc p
              where p.oid in ('ops.front_desk_policy_for_run()'::regprocedure,
                              'ops.record_inbound_screening(jsonb)'::regprocedure)) then
    raise exception 'ops_worker cannot execute its two front-desk capabilities, or they are not SECURITY DEFINER';
  end if;
  select string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.pronamespace = 'ops'::regnamespace
     and p.proname in ('draft_agent_configuration', 'publish_agent_configuration', 'take_over_conversation',
                       'release_conversation', 'record_person_reply', 'move_conversation_state',
                       'open_scripted_review', 'crm_contact_is_client', 'published_agent_configuration')
     and (has_function_privilege('ops_worker', p.oid, 'EXECUTE') or has_function_privilege('ops_gateway', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'an application role can execute an owner act or a front-desk helper: %', v_bad;
  end if;
  -- An autonomous send mode is not representable.
  if ops.agent_configuration_valid('operating_policy',
       '{"sendMode":"autonomous","sanitizerPack":"health_pt_br.v1","contextTurns":4,"aiDisclosure":"x"}'::jsonb) then
    raise exception 'an autonomous send mode passed the operating policy check';
  end if;
  -- The production gate is untouched.
  if exists (select 1 from ops.communication_channels c where c.mode = 'production' and c.active) then
    raise exception 'a production channel is active';
  end if;
end
$end_state$;
