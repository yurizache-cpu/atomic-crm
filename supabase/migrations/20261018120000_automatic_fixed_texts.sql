-- ADR 0026 §B (slice 2): the owner's published fixed texts leave on their own.
--
--   * The operating policy may list, in automaticFixedTexts, the fixed texts
--     the owner lets leave without a person: a closed vocabulary of fixed-text
--     keys, so no field can ever name a model's output. Absent or empty, every
--     reply stays supervised. AI-written replies stay supervised whatever the
--     policy says: their autonomy needs its own record.
--   * When the deterministic screen selects a listed text, the screening's own
--     transaction accepts the review AS POLICY (decision basis
--     published_fixed_text, reviewer policy:fixed-text, never a person),
--     requests the send (authorization kind fixed_text) and queues one
--     outbound.reply_send job. Only test or synthetic data, while BASELINE Q8
--     is open. The predicate ops.review_is_published_fixed_text binds it: a
--     fixed review, its run settled with that text, the screening's key and
--     fixed-messages version, the draft byte-equal to that version's text, the
--     key listed in the policy the screening recorded and in the one published
--     when the send begins, and a reachable contact unless the key is a safety
--     text.
--   * The worker carries the send: begin (under the kill switch and every send
--     gate, plus freshness, the opt-out rule and the stale rule), confirm
--     (holding the conversation through the one provider call, so the
--     contact's next message waits), settle; an earlier attempt's send found
--     sending is recorded indeterminate without a call. A text not begun within
--     30 minutes of its message is blocked; past three automatic texts in an
--     hour (the safety texts exempt) a person holds the conversation. A blocked
--     or refused automatic text raises send_blocked.
--   * Two safety texts: safety for a conversation's first crisis message,
--     safety_followup (optional in a published set) after it. They form one
--     family: only a newer automatic text of the same family makes one stale,
--     so two close crisis messages send one text, and an opt-out on a newer
--     message stops it. The safety texts may also reach a contact the CRM does
--     not know or knows as opted out (owner decision 9, 2026-10-08); never an
--     ambiguous or erased number.
--   * The operator's send never carries a send a job carries.
--
-- Nothing here makes a model's reply leave, writes the CRM or adds a browser
-- act. No exposed function changes: this is not an OD-8a migration.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The vocabulary: a second safety text, and the texts the owner may let
--    leave on their own.
-- ---------------------------------------------------------------------------

-- Every fixed-text key a set may hold, and a screening may name. The second
-- safety text is new; a published set need not hold it.
create or replace function ops.fixed_message_keys()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['safety', 'safety_followup', 'human_handoff_ack', 'sensitive_only_prospect', 'sensitive_only_client',
               'clarification', 'out_of_scope', 'service_unavailable', 'opt_out_ack']::text[];
$function$;

-- The fixed texts every published set must hold: the cases where the reply
-- must not depend on a model. A stored set without the second safety text
-- stays valid (a superseded version is re-checked when it is superseded).
create function ops.required_fixed_message_keys()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['safety', 'human_handoff_ack', 'sensitive_only_prospect', 'sensitive_only_client',
               'clarification', 'out_of_scope', 'service_unavailable', 'opt_out_ack']::text[];
$function$;

-- The texts an operating policy may let leave without a person: only those the
-- screen selects by itself, never a model's output.
create function ops.automatic_fixed_text_keys()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['safety', 'safety_followup', 'human_handoff_ack', 'opt_out_ack', 'clarification',
               'sensitive_only_prospect', 'sensitive_only_client']::text[];
$function$;

-- The safety texts: one family.
create function ops.safety_fixed_text_keys()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['safety', 'safety_followup']::text[];
$function$;

-- ---------------------------------------------------------------------------
-- 2. The agent's configuration: automaticFixedTexts, and the second safety
--    text optional in a published set. As 20261015120000, with both.
-- ---------------------------------------------------------------------------

create or replace function ops.agent_configuration_valid(p_kind text, p_content jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_stage jsonb;
  v_key   text;
  v_name  jsonb;
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
    if p_content ? 'handoffNames' then
      if jsonb_typeof(p_content -> 'handoffNames') is distinct from 'array'
         or jsonb_array_length(p_content -> 'handoffNames') > 20 then
        return false;
      end if;
      for v_name in select n from jsonb_array_elements(p_content -> 'handoffNames') n loop
        if jsonb_typeof(v_name) <> 'string'
           or (v_name #>> '{}') !~ '^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .''-]{0,59}$' then
          return false;
        end if;
      end loop;
    end if;
    -- ADR 0026 §B: the fixed texts the owner lets leave without a person, from
    -- a closed vocabulary of fixed-text keys; absent or empty, every reply is
    -- supervised. No key can name a model's output.
    if p_content ? 'automaticFixedTexts' then
      if jsonb_typeof(p_content -> 'automaticFixedTexts') is distinct from 'array'
         or jsonb_array_length(p_content -> 'automaticFixedTexts') > 20 then
        return false;
      end if;
      for v_name in select n from jsonb_array_elements(p_content -> 'automaticFixedTexts') n loop
        if jsonb_typeof(v_name) <> 'string'
           or not ((v_name #>> '{}') = any (ops.automatic_fixed_text_keys())) then
          return false;
        end if;
      end loop;
      if (select count(distinct n) from jsonb_array_elements_text(p_content -> 'automaticFixedTexts') n)
         <> jsonb_array_length(p_content -> 'automaticFixedTexts') then
        return false;
      end if;
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
    foreach v_key in array ops.required_fixed_message_keys() loop
      if not ops.configured_text_valid(p_content -> 'messages' -> v_key, 1000) then
        return false;
      end if;
    end loop;
    -- The second safety text is optional; when present it is a text like the rest.
    if p_content -> 'messages' ? 'safety_followup'
       and not ops.configured_text_valid(p_content -> 'messages' -> 'safety_followup', 1000) then
      return false;
    end if;
    return true;
  end if;
  return false;
end
$function$;

-- ---------------------------------------------------------------------------
-- 3. Past the hourly cap a person holds the conversation, and a blocked
--    automatic text waits for a person.
-- ---------------------------------------------------------------------------

alter table ops.conversation_states drop constraint conversation_states_holder_reason_check;
alter table ops.conversation_states add constraint conversation_states_holder_reason_check check (
  holder_reason is null or holder_reason in ('person_requested', 'safety', 'opt_out', 'operator', 'automatic_cap'));

-- send_blocked: on the send it blocked, or on the conversation when no send
-- was ever requested (the cap, a text already out of date). High priority:
-- an automatic text did not leave.
alter table ops.exceptions drop constraint exceptions_kind_check;
alter table ops.exceptions add constraint exceptions_kind_check check (kind in (
  'opt_out', 'person_requested', 'configuration_missing', 'message_waiting',
  'contact_unresolved', 'do_not_contact', 'send_failed', 'send_indeterminate', 'send_blocked'));
alter table ops.exceptions drop constraint exceptions_priority_matches_kind;
alter table ops.exceptions add constraint exceptions_priority_matches_kind check (priority = case
  when kind in ('person_requested', 'configuration_missing', 'contact_unresolved', 'send_indeterminate', 'send_blocked')
  then 'high' else 'normal' end);
alter table ops.exceptions drop constraint exceptions_subject_shape;
alter table ops.exceptions add constraint exceptions_subject_shape check (
      (kind not in ('send_failed', 'send_indeterminate') or subject_kind = 'outbound_message')
  and (subject_kind <> 'outbound_message' or kind in ('send_failed', 'send_indeterminate', 'send_blocked'))
  and (subject_kind = 'outbound_message') = (outbound_message_id is not null)
  and subject_kind in ('conversation', 'outbound_message')
  and subject_id = coalesce(outbound_message_id, conversation_id));

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
    else '{}'::pg_catalog.jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Who decided a review: a person, or the owner's published policy.
-- ---------------------------------------------------------------------------

alter table ops.review_items add column decision_basis text;

-- The backfill passes the update guard once: this body admits exactly a first
-- fill of the basis on a decided review, and nothing else. It is replaced
-- again below, in this transaction.
create or replace function ops.guard_review_item_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.decision_basis is null and new.decision_basis = 'person' and old.status <> 'pending'
     and (to_jsonb(new) - 'decision_basis') is not distinct from (to_jsonb(old) - 'decision_basis') then
    return new;
  end if;
  raise exception using errcode = 'OS403', message = 'ops.review_items: only the decision-basis backfill may write now';
end
$function$;

-- Every review decided before this migration was decided by a person.
update ops.review_items set decision_basis = 'person' where status <> 'pending';

alter table ops.review_items add constraint review_items_decision_basis check (
      (status = 'pending') = (decision_basis is null)
  and (decision_basis is null or decision_basis in ('person', 'published_fixed_text'))
  and (decision_basis is distinct from 'published_fixed_text'
       or (author = 'fixed' and status = 'accepted' and reviewer = 'policy:fixed-text')));

comment on column ops.review_items.decision_basis is
  'ADR 0026 §B: who decided the review: person (a person''s own act), or published_fixed_text (the owner''s operating policy let the published fixed text the screen selected leave on its own; reviewer policy:fixed-text). Null while pending.';

-- The predicate every automatic send rests on (SI-83 draft). True only for a
-- fixed review of test or synthetic data whose run the front desk settled
-- with that text: the run's one screening recorded the fixed reply, its key
-- and the fixed-messages version; the draft is byte-equal to that version's
-- text for that key; the key is one the screen selects by itself, listed in
-- automaticFixedTexts of the policy the screening recorded and, when one is
-- named, of the policy published when the send begins; the contact was
-- reachable at admission unless the key is a safety text; nothing is redacted.
create function ops.review_is_published_fixed_text(p_item ops.review_items, p_current_policy_id uuid)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select p_item.author = 'fixed'
     and p_item.content_redacted_at is null
     and exists (
       select 1
         from ops.agent_runs r
         join ops.inbound_screenings s on s.tenant_id = r.tenant_id and s.agent_run_id = r.id
         join ops.agent_configuration_versions f
           on f.tenant_id = s.tenant_id and f.id = s.fixed_messages_version_id and f.kind = 'fixed_messages'
         join ops.agent_configuration_versions p
           on p.tenant_id = s.tenant_id and p.id = s.policy_version_id and p.kind = 'operating_policy'
         join ops.tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
        where r.tenant_id = p_item.tenant_id and r.id = p_item.agent_run_id
          and r.task_id = p_item.task_id
          and r.status = 'cancelled' and r.error_code = 'front_desk_fixed_reply'
          and s.disposition = 'fixed_reply'
          and s.fixed_message_key = any (ops.automatic_fixed_text_keys())
          and (p_item.proposed ->> 'response_draft') is not null
          and (p_item.proposed ->> 'response_draft') = (f.content -> 'messages' ->> s.fixed_message_key)
          and coalesce(p.content -> 'automaticFixedTexts', '[]'::jsonb) ? s.fixed_message_key
          and (p_current_policy_id is null or exists (
                select 1 from ops.agent_configuration_versions c
                 where c.tenant_id = p_item.tenant_id and c.id = p_current_policy_id
                   and c.kind = 'operating_policy' and c.agent_id = p.agent_id
                   and coalesce(c.content -> 'automaticFixedTexts', '[]'::jsonb) ? s.fixed_message_key))
          and t.data_class in ('synthetic', 'test')
          and t.content_redacted_at is null
          and (not p_item.do_not_contact or s.fixed_message_key = any (ops.safety_fixed_text_keys())));
$function$;

comment on function ops.review_is_published_fixed_text(ops.review_items, uuid) is
  'ADR 0026 §B, SI-83 draft: true only for a fixed review of test or synthetic data that the published fixed text the screen selected answered, byte-equal, with its key listed in automaticFixedTexts of the policy the screening recorded and, when named, of the policy published now; the contact reachable unless the key is a safety text. Every automatic send rests on it.';

-- The latest guards (20261017120000), with the basis of a decision.
create or replace function ops.guard_review_item_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- D7: a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['proposed', 'decision_note'], old.tenant_id, old.task_id) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.task_id is distinct from old.task_id
     or new.agent_run_id is distinct from old.agent_run_id
     or new.capability is distinct from old.capability
     or new.proposed is distinct from old.proposed
     or new.do_not_contact is distinct from old.do_not_contact
     or new.author is distinct from old.author
     or new.conversation_revision is distinct from old.conversation_revision
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS403',
      message = 'ops.review_items: what was reviewed is immutable';
  end if;
  if old.status <> 'pending' then
    raise exception using
      errcode = 'OS409',
      message = format('ops.review_items: this item is already %s, and a decision is final', old.status);
  end if;
  if new.status = 'pending' then
    raise exception using
      errcode = 'OS403',
      message = 'ops.review_items: a decision is a decision; it cannot answer pending';
  end if;
  -- ADR 0026 §B: a decision names its basis. The owner's policy decides only a
  -- published fixed text the screen selected; a person's decision names a person.
  if new.decision_basis is null then
    raise exception using errcode = 'OS403', message = 'ops.review_items: a decision names its basis';
  end if;
  if new.decision_basis = 'published_fixed_text'
     and not (new.status = 'accepted' and new.reviewer = 'policy:fixed-text'
              and ops.review_is_published_fixed_text(new, null)) then
    raise exception using errcode = 'OS403',
      message = 'ops.review_items: only a published fixed text the screen selected is accepted as policy';
  end if;
  if new.decision_basis = 'person' and new.reviewer ~ '^(policy|system):' then
    raise exception using errcode = 'OS403', message = 'ops.review_items: a person''s decision names a person';
  end if;
  new.updated_at := now();
  return new;
end
$function$;

create or replace function ops.guard_review_item_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run ops.agent_runs;
begin
  -- ADR 0026 §B: the owner's policy decides only by its own act on a pending
  -- review. A review written already decided (a test fixture) was a person's.
  if new.decision_basis = 'published_fixed_text' then
    raise exception using errcode = 'OS403', message = 'ops.review_items: the policy decides only a pending review';
  end if;
  if new.status <> 'pending' and new.decision_basis is null then
    new.decision_basis := 'person';
  end if;
  -- SI-72: a redacted task's content is gone; nothing new is written about it.
  if exists (select 1 from ops.tasks t
              where t.tenant_id = new.tenant_id and t.id = new.task_id and t.content_redacted_at is not null) then
    raise exception using errcode = 'OS409', message = 'ops.review_items: no review opens on a redacted task';
  end if;
  select r.* into v_run from ops.agent_runs r where r.tenant_id = new.tenant_id and r.id = new.agent_run_id;
  if new.author = 'fixed' then
    -- A fixed text only on a run the front desk settled with one.
    if v_run.id is null or v_run.status <> 'cancelled' or v_run.error_code is distinct from 'front_desk_fixed_reply'
       or not exists (select 1 from ops.inbound_screenings s
                       where s.tenant_id = new.tenant_id and s.agent_run_id = new.agent_run_id
                         and s.disposition = 'fixed_reply') then
      raise exception using errcode = 'OS403', message = 'ops.review_items: a fixed text answers only a run the front desk settled with one';
    end if;
  elsif new.author = 'person' then
    -- A person's reply only inside its own act, which marks the transaction
    -- with the revision the person saw (ops.record_person_reply).
    if v_run.id is null
       or coalesce(current_setting('ops.person_reply_revision', true), '') <> coalesce(new.conversation_revision::text, '-') then
      raise exception using errcode = 'OS403', message = 'ops.review_items: a person''s reply is written only by its own act';
    end if;
  elsif v_run.error_code in ('front_desk_fixed_reply', 'front_desk_held_for_person') then
    -- The agent's model never answered a run the front desk settled without one.
    raise exception using errcode = 'OS403', message = 'ops.review_items: the agent did not answer a run the front desk settled';
  end if;
  return new;
end
$function$;

-- The person's decision (20260917190000), naming its basis, and never a
-- policy's label.
create or replace function ops.record_review_decision(
  p_tenant_id  uuid,
  p_review_id  uuid,
  p_decision   text,
  p_reviewer   text,
  p_source     text,
  p_note       text default null
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_item ops.review_items;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.record_review_decision: no tenant scope';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'rejected', 'needs_edit') then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_review_decision: a decision is accepted, rejected or needs_edit';
  end if;
  if p_reviewer is null or p_reviewer !~ '^[\x21-\x7e][\x20-\x7e]{0,199}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_review_decision: a decision names the person who made it';
  end if;
  -- ADR 0026 §B: these labels name the owner's policy or the system, never a
  -- person; only the policy's own path writes them.
  if p_reviewer ~ '^(policy|system):' then
    raise exception using errcode = 'OS400',
      message = 'ops.record_review_decision: a decision names the person who made it, not a policy';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_review_decision: the source is missing or malformed';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then
    raise exception using errcode = 'OS400', message = 'ops.record_review_decision: the note is longer than 1000 characters';
  end if;

  select r.* into v_item
    from ops.review_items r
   where r.id = p_review_id and r.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.record_review_decision: review item not found in this tenant';
  end if;

  if v_item.status <> 'pending' then
    if v_item.status = p_decision and v_item.reviewer = p_reviewer then
      -- The same person recording the same decision again: the retry of a
      -- delivery, not a second decision.
      return jsonb_build_object('review_item_id', v_item.id, 'status', v_item.status, 'recorded', false);
    end if;
    raise exception using
      errcode = 'OS409',
      message = format('ops.record_review_decision: this item is already %s, and a decision is final', v_item.status);
  end if;

  if p_decision = 'accepted' and v_item.do_not_contact then
    raise exception using
      errcode = 'OS403',
      message = 'ops.record_review_decision: this lead must not be contacted, so its draft cannot be accepted';
  end if;

  update ops.review_items
     set status = p_decision, reviewer = p_reviewer, decision_note = p_note, reviewed_at = now(),
         decision_basis = 'person'
   where id = v_item.id;

  perform ops.record_event(
    p_tenant_id, v_item.company_id, 'lead_triage.reviewed', p_source, 'task', v_item.task_id,
    jsonb_build_object(
      'review_item_id', v_item.id,
      'agent_run_id', v_item.agent_run_id,
      'decision', p_decision),
    null, null, format('review:%s:%s', v_item.id, p_decision));

  return jsonb_build_object('review_item_id', v_item.id, 'status', p_decision, 'recorded', true);
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. A send records what authorized it, and the job that carries it.
-- ---------------------------------------------------------------------------

alter table ops.outbound_messages
  add column authorization_kind text not null default 'operator',
  add column job_id uuid,
  add column fixed_text_key text,
  add column fixed_messages_version_id uuid,
  add column fresh_until timestamptz,
  add column transport text,
  add column job_attempt integer;

alter table ops.outbound_messages add constraint outbound_messages_authorization_kind_check
  check (authorization_kind in ('operator', 'fixed_text'));
-- A send authorized as policy names its job, its fixed text and version, and
-- the instant it stops being fresh; the operator's names none of them.
alter table ops.outbound_messages add constraint outbound_messages_policy_shape check (
      (authorization_kind = 'fixed_text') = (job_id is not null)
  and (authorization_kind = 'fixed_text') = (fixed_text_key is not null)
  and (authorization_kind = 'fixed_text') = (fixed_messages_version_id is not null)
  and (authorization_kind = 'fixed_text') = (fresh_until is not null)
  and (fixed_text_key is null or fixed_text_key = any (ops.automatic_fixed_text_keys())));
-- The transport and the attempt that began it are recorded when a job's send
-- begins, never before, and never on the operator's send.
alter table ops.outbound_messages add constraint outbound_messages_transport_shape check (
      (transport is null or transport in ('meta', 'fake'))
  and (job_id is not null or (transport is null and job_attempt is null))
  and (job_id is null or (status in ('authorized', 'blocked')) = (transport is null))
  and (transport is null) = (job_attempt is null));
alter table ops.outbound_messages add constraint outbound_messages_job_fkey
  foreign key (tenant_id, job_id) references ops.jobs (tenant_id, id);
alter table ops.outbound_messages add constraint outbound_messages_job_key unique (tenant_id, job_id);
create index outbound_messages_policy_conversation_idx
  on ops.outbound_messages (tenant_id, conversation_id, authorized_at)
  where authorization_kind = 'fixed_text';

comment on column ops.outbound_messages.authorization_kind is
  'ADR 0026 §B: operator (the operator''s send of an accepted review, npm run messaging -- send) or fixed_text (a published fixed text authorized as policy and carried by the worker''s outbound.reply_send job).';
comment on column ops.outbound_messages.fresh_until is
  'ADR 0026 §B: a policy send not begun by this instant (30 minutes after the earlier of its message''s provider timestamp and admission) is blocked fixed_text_expired.';

-- The latest guard (20261010120000), with what authorized the send.
create or replace function ops.guard_outbound_message()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_unbegun boolean;
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
    -- ADR 0026 §B: a send authorized as policy rests on a review the policy
    -- accepted under the predicate, for the text that review carries.
    if new.authorization_kind = 'fixed_text' and not exists (
         select 1
           from ops.review_items v
           join ops.inbound_screenings s on s.tenant_id = v.tenant_id and s.agent_run_id = v.agent_run_id
          where v.tenant_id = new.tenant_id and v.id = new.review_item_id
            and v.status = 'accepted' and v.decision_basis = 'published_fixed_text'
            and s.fixed_message_key = new.fixed_text_key
            and s.fixed_messages_version_id = new.fixed_messages_version_id
            and ops.review_is_published_fixed_text(v, null)) then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: a policy send rests on a published fixed text the policy accepted';
    end if;
    if new.transport is not null or new.job_attempt is not null then
      raise exception using errcode = 'OS403', message = 'ops.outbound_messages: a send begins with no transport';
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
     or new.created_at is distinct from old.created_at
     or new.authorization_kind is distinct from old.authorization_kind
     or new.job_id is distinct from old.job_id
     or new.fixed_text_key is distinct from old.fixed_text_key
     or new.fixed_messages_version_id is distinct from old.fixed_messages_version_id
     or new.fresh_until is distinct from old.fresh_until then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: what was authorized is immutable';
  end if;
  -- ADR 0026 §B: the one edge back. A job's send its last gate found a reason
  -- to wait on, before any call: it returns to authorized as if it had never
  -- begun, its begin's marks cleared.
  v_unbegun := old.job_id is not null and old.status = 'sending' and new.status = 'authorized'
               and old.provider_message_id is null and new.provider_message_id is null
               and new.sending_at is null and new.send_check is null and new.privacy_notice_id is null
               and new.transport is null and new.job_attempt is null and new.settled_at is null;
  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the provider message id is set once';
  end if;
  if new.privacy_notice_id is distinct from old.privacy_notice_id and not v_unbegun
     and not (old.privacy_notice_id is null and old.status = 'authorized' and new.status = 'sending'
              and exists (select 1 from ops.privacy_notices n
                           where n.id = new.privacy_notice_id and n.tenant_id = new.tenant_id)) then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the privacy notice is the tenant''s own, attached once as the send begins';
  end if;

  -- The transport and the attempt are recorded once, as a job's send begins.
  if (new.transport is distinct from old.transport or new.job_attempt is distinct from old.job_attempt)
     and not v_unbegun
     and not (old.transport is null and old.status = 'authorized' and new.status = 'sending') then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the transport and the attempt are recorded once, as the send begins';
  end if;
  -- A send a job carries is never asked for again: a person writes a new reply.
  if old.job_id is not null and old.status = 'blocked' and new.status = 'authorized' then
    raise exception using errcode = 'OS409', message = 'ops.outbound_messages: a send a job carries is never asked for again';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'authorized'    and new.status in ('sending', 'blocked'))
    or (old.status = 'blocked'       and new.status = 'authorized')
    or v_unbegun
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

-- ---------------------------------------------------------------------------
-- 6. The job kind, and the stop that covers it. As 20261007120000, with
--    outbound.reply_send.
-- ---------------------------------------------------------------------------

create or replace function ops.external_job_kinds()
returns text[]
language sql immutable set search_path = '' as $$
  select array['agent_run.execute', 'decision.shadow_evaluate',
               'calendar.create', 'calendar.update', 'calendar.cancel',
               'decision.structured_evaluate', 'outbound.reply_send']::text[];
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
-- 7. Whether a policy send may leave now: every gate of the operator's send
--    (SI-49), the safety texts' contact rule, and the opt-out rule. The stop
--    is judged last, so it never hides a contact the send would refuse.
-- ---------------------------------------------------------------------------

-- The operator send's gates (ops.whatsapp_send_eligibility, 20260918170000)
-- but the kill switch, in the same order and with the same reasons.
create function ops.whatsapp_contact_eligibility(p_tenant_id uuid, p_conversation_id uuid)
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
  v_reason  text;
begin
  select * into v_conv from ops.conversations
   where id = p_conversation_id and tenant_id = p_tenant_id;
  if not found then
    return jsonb_build_object('eligible', false, 'reason', 'conversation_not_found');
  end if;
  select * into v_channel from ops.communication_channels
   where id = v_conv.channel_id and tenant_id = p_tenant_id;
  v_crm := ops.crm_contact_by_phone(p_tenant_id, v_conv.contact_ref);
  v_reason := case
    when v_channel.mode <> 'test' then 'q8_production_channel'
    when not v_channel.active then 'channel_inactive'
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
    'stop_id', null,
    'checked_at', now());
end
$function$;

-- The safety texts may also reach a number the CRM does not know, knows with
-- no recorded consent, or knows as opted out (owner decision 9, 2026-10-08),
-- and a CRM the tenant cannot read; never an ambiguous or an erased number,
-- and never past Meta's window. An opt-out stops every other text but its own
-- acknowledgement while it is open; a safety text only when the contact asked
-- to stop in a message newer than the one it answers. Then, and only for a
-- send every other gate lets leave, the kill switch: a stop holds it.
create function ops.reply_send_eligibility(p_tenant_id uuid, p_outbound ops.outbound_messages)
returns jsonb
language plpgsql
volatile
security invoker
set search_path to ''
as $function$
declare
  v_check   jsonb;
  v_reason  text;
  v_mine    ops.inbound_messages;
  v_company uuid;
  v_stop    uuid;
begin
  v_check := ops.whatsapp_contact_eligibility(p_tenant_id, p_outbound.conversation_id);
  v_reason := v_check ->> 'reason';
  if p_outbound.fixed_text_key = any (ops.safety_fixed_text_keys())
     and v_reason in ('crm_unavailable', 'contact_not_found', 'consent_unknown', 'do_not_contact')
     and exists (select 1 from ops.conversations c
                  where c.tenant_id = p_tenant_id and c.id = p_outbound.conversation_id
                    and c.contact_erased_at is null
                    and c.last_inbound_at >= now() - interval '24 hours') then
    v_check := v_check || jsonb_build_object('eligible', true, 'reason', null, 'relaxed', v_reason);
    v_reason := null;
  end if;
  if v_reason is not null then
    return v_check;
  end if;

  select m.* into v_mine from ops.inbound_messages m
   where m.tenant_id = p_tenant_id and m.task_id = p_outbound.task_id and m.conversation_id is not null
   order by m.received_at desc
   limit 1;
  if p_outbound.fixed_text_key = any (ops.safety_fixed_text_keys()) then
    if exists (select 1 from ops.inbound_screenings s
                join ops.inbound_messages m on m.tenant_id = s.tenant_id and m.task_id = s.task_id
               where s.tenant_id = p_tenant_id and s.conversation_id = p_outbound.conversation_id
                 and s.opt_out_requested
                 and (m.received_at > v_mine.received_at
                      or (m.received_at = v_mine.received_at and m.created_at > v_mine.created_at))) then
      return v_check || jsonb_build_object('eligible', false, 'reason', 'opted_out_since');
    end if;
  elsif p_outbound.fixed_text_key is distinct from 'opt_out_ack'
        and exists (select 1 from ops.exceptions e
                     where e.tenant_id = p_tenant_id and e.conversation_id = p_outbound.conversation_id
                       and e.kind = 'opt_out' and e.resolved_at is null) then
    return v_check || jsonb_build_object('eligible', false, 'reason', 'opt_out_open');
  end if;

  -- The kill switch, read under its lock as every other gate reads it.
  select c.company_id into v_company from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = p_outbound.conversation_id;
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  select s.id into v_stop
    from ops.execution_stops s
   where s.cleared_at is null
     and (s.scope = 'global'
          or (s.scope = 'tenant' and s.tenant_id = p_tenant_id)
          or (s.scope = 'company' and s.tenant_id = p_tenant_id and s.company_id = v_company))
   limit 1;
  if v_stop is not null then
    return v_check || jsonb_build_object('eligible', false, 'reason', 'execution_stopped', 'stop_id', v_stop);
  end if;
  return v_check;
end
$function$;

comment on function ops.reply_send_eligibility(uuid, ops.outbound_messages) is
  'ADR 0026 §B: the gates a policy send passes: the operator send''s contact and window gates (SI-49), relaxed for the safety texts (a number the CRM does not know, knows with no consent or as opted out, a CRM it cannot read; never ambiguous, erased or past the window), then the opt-out rule (an open opt-out stops every text but its acknowledgement; a safety text only an opt-out on a newer message), then the kill switch, which holds a send every other gate lets leave.';

-- ---------------------------------------------------------------------------
-- 8. The screening authorizes a listed fixed text as policy, in its own
--    transaction. It never raises for a reason the send would refuse: a
--    raise here would roll the screening back and the job would retry it.
--    It answers what it did: authorized, supervised (not a policy text, or
--    a contact the send would refuse now: the review waits for a person and
--    the contact's exceptions say why), expired or capped (send_blocked).
-- ---------------------------------------------------------------------------

create function ops.authorize_fixed_reply(p_review_id uuid)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_item    ops.review_items;
  v_s       ops.inbound_screenings;
  v_inbound ops.inbound_messages;
  v_out     uuid := gen_random_uuid();
  v_job     uuid;
  v_fresh   timestamptz;
  v_probe   ops.outbound_messages;
  v_check   jsonb;
begin
  select ri.* into v_item from ops.review_items ri where ri.id = p_review_id for update;
  if not found or v_item.status <> 'pending' or not ops.review_is_published_fixed_text(v_item, null) then
    return 'supervised';
  end if;
  select s.* into v_s from ops.inbound_screenings s
   where s.tenant_id = v_item.tenant_id and s.agent_run_id = v_item.agent_run_id;
  -- Only a reply the transport can carry: a WhatsApp message in a conversation.
  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = v_item.tenant_id and m.task_id = v_item.task_id
     and m.source_kind = 'whatsapp' and m.conversation_id is not null
   order by m.received_at desc
   limit 1;
  if not found then
    return 'supervised';
  end if;

  -- Fresh for 30 minutes after the earlier of the provider's timestamp and
  -- the admission: a late redelivery is born out of date.
  v_fresh := least(v_inbound.received_at, v_inbound.created_at) + interval '30 minutes';
  if now() >= v_fresh then
    perform ops.open_exception(v_item.tenant_id, v_item.company_id, v_item.task_id, 'send_blocked',
                               v_inbound.conversation_id, null, null, 'front-desk');
    return 'expired';
  end if;

  -- At most three automatic texts per conversation per hour, the safety texts
  -- exempt; past it a person holds the conversation, which ends a loop with
  -- another automatic responder. The screening holds the conversation's state
  -- row, so concurrent screenings of one conversation count in turn.
  if not (v_s.fixed_message_key = any (ops.safety_fixed_text_keys()))
     and (select count(*) from ops.outbound_messages o
           where o.tenant_id = v_item.tenant_id and o.conversation_id = v_inbound.conversation_id
             and o.authorization_kind = 'fixed_text'
             and not (o.fixed_text_key = any (ops.safety_fixed_text_keys()))
             and o.authorized_at > now() - interval '1 hour'
             -- Only texts that left, may have left or can still leave: one a
             -- newer message replaced, or one that was blocked, never fed a loop.
             and (o.status in ('sending', 'sent', 'delivered', 'read', 'indeterminate')
                  or (o.status = 'authorized' and not exists (
                        select 1 from ops.review_items ri
                         where ri.tenant_id = o.tenant_id and ri.id = o.review_item_id
                           and ops.cos_review_superseded(o.tenant_id, ri))))) >= 3 then
    perform ops.move_conversation_state(v_inbound.conversation_id, 'holder', 'person', 'automatic_cap', 'front-desk');
    perform ops.open_exception(v_item.tenant_id, v_item.company_id, v_item.task_id, 'send_blocked',
                               v_inbound.conversation_id, null, null, 'front-desk');
    return 'capped';
  end if;

  -- The gates the send will pass again at its begin. A stop holds the send,
  -- it does not refuse it.
  v_probe.tenant_id := v_item.tenant_id;
  v_probe.conversation_id := v_inbound.conversation_id;
  v_probe.task_id := v_item.task_id;
  v_probe.fixed_text_key := v_s.fixed_message_key;
  v_check := ops.reply_send_eligibility(v_item.tenant_id, v_probe);
  if not (v_check ->> 'eligible')::boolean and v_check ->> 'reason' is distinct from 'execution_stopped' then
    return 'supervised';
  end if;

  -- Accepted as policy, never as a person's decision.
  update ops.review_items
     set status = 'accepted', reviewer = 'policy:fixed-text', decision_basis = 'published_fixed_text',
         reviewed_at = now()
   where id = v_item.id;
  perform ops.record_event(
    v_item.tenant_id, v_item.company_id, 'lead_triage.reviewed', 'agent-runtime', 'task', v_item.task_id,
    jsonb_build_object('review_item_id', v_item.id, 'agent_run_id', v_item.agent_run_id,
                       'decision', 'accepted', 'basis', 'published_fixed_text'),
    null, null, format('review:%s:accepted', v_item.id));

  v_job := ops.enqueue_job(v_item.tenant_id, 'outbound.reply_send',
                           jsonb_build_object('outbound_message_id', v_out), 100, now(), 5,
                           format('reply_send:%s', v_out));
  insert into ops.outbound_messages (
    id, tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
    status, requested_by, authorized_check, authorization_kind, job_id, fixed_text_key,
    fixed_messages_version_id, fresh_until)
  values (
    v_out, v_item.tenant_id, v_item.company_id, v_inbound.channel_id, v_inbound.conversation_id, v_item.id,
    v_item.task_id, 'authorized', 'policy:fixed-text', v_check, 'fixed_text', v_job, v_s.fixed_message_key,
    v_s.fixed_messages_version_id, v_fresh);
  perform ops.record_event(
    v_item.tenant_id, v_item.company_id, 'communication.outbound_authorized', 'agent-runtime', 'task', v_item.task_id,
    jsonb_build_object('outbound_message_id', v_out, 'review_item_id', v_item.id));
  return 'authorized';
end
$function$;

comment on function ops.authorize_fixed_reply(uuid) is
  'ADR 0026 §B: inside the screening''s transaction, accepts a fixed review as policy (published_fixed_text, policy:fixed-text) when ops.review_is_published_fixed_text holds, the text is fresh, the hourly cap allows it and the send''s gates pass (a stop holds, it does not refuse), then requests the send and queues one outbound.reply_send job. Raises nothing the send would refuse. Answers authorized, supervised, expired or capped.';

-- ---------------------------------------------------------------------------
-- 9. The stale rule for an automatic acknowledgement, and the second safety
--    text among the protective ones. As 20261017120000, with both.
-- ---------------------------------------------------------------------------

create or replace function ops.cos_review_answered_by_person(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select p_item.author <> 'person'
     and exists (select 1 from ops.review_items p
                  where p.tenant_id = p_tenant_id and p.task_id = p_item.task_id and p.author = 'person')
     and not (p_item.author = 'fixed' and exists (
       select 1 from ops.inbound_screenings s
        where s.tenant_id = p_tenant_id and s.agent_run_id = p_item.agent_run_id
          and s.disposition = 'fixed_reply' and s.fixed_message_key in ('safety', 'safety_followup', 'opt_out_ack')));
$$;

create or replace function ops.cos_review_superseded(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select case
  -- A person's reply: stale only when the contact wrote again, admitted or
  -- refused, after the conversation revision the person saw. A refused
  -- message inside that revision does not make it stale.
  when p_item.author = 'person' then coalesce((
    select ops.cos_conversation_revision(p_tenant_id, mine.conversation_id) > p_item.conversation_revision
      from ops.inbound_messages mine
     where mine.tenant_id = p_tenant_id and mine.task_id = p_item.task_id and mine.conversation_id is not null
     order by mine.received_at desc
     limit 1), true)
  -- A reply a person's reply already answered.
  when ops.cos_review_answered_by_person(p_tenant_id, p_item) then true
  -- ADR 0026 §B: an automatic safety text, handoff or opt-out acknowledgement
  -- answers the request, not the words around it. Only a newer automatic text
  -- of its family makes it stale (the two safety texts are one family), and a
  -- safety text also an opt-out on a newer message.
  when p_item.decision_basis = 'published_fixed_text' and exists (
         select 1 from ops.inbound_screenings s
          where s.tenant_id = p_tenant_id and s.agent_run_id = p_item.agent_run_id
            and s.fixed_message_key in ('safety', 'safety_followup', 'human_handoff_ack', 'opt_out_ack')) then
    coalesce((
      select exists (
               select 1
                 from ops.review_items other
                 join ops.inbound_screenings os on os.tenant_id = other.tenant_id and os.agent_run_id = other.agent_run_id
                 join ops.inbound_messages om on om.tenant_id = other.tenant_id and om.task_id = other.task_id
                where other.tenant_id = p_tenant_id and other.id <> p_item.id
                  and other.decision_basis = 'published_fixed_text'
                  and om.conversation_id = mine.conversation_id
                  and (case when os.fixed_message_key in ('safety', 'safety_followup') then 'safety' else os.fixed_message_key end)
                    = (case when ms.fixed_message_key in ('safety', 'safety_followup') then 'safety' else ms.fixed_message_key end)
                  and (om.received_at > mine.received_at
                       or (om.received_at = mine.received_at and om.created_at > mine.created_at)))
          or (ms.fixed_message_key in ('safety', 'safety_followup') and exists (
               select 1
                 from ops.inbound_screenings os
                 join ops.inbound_messages om on om.tenant_id = os.tenant_id and om.task_id = os.task_id
                where os.tenant_id = p_tenant_id and os.conversation_id = mine.conversation_id
                  and os.opt_out_requested
                  and (om.received_at > mine.received_at
                       or (om.received_at = mine.received_at and om.created_at > mine.created_at))))
        from ops.inbound_messages mine
        join ops.inbound_screenings ms on ms.tenant_id = mine.tenant_id and ms.agent_run_id = p_item.agent_run_id
       where mine.tenant_id = p_tenant_id and mine.task_id = p_item.task_id and mine.conversation_id is not null
       order by mine.received_at desc
       limit 1), true)
  else exists (
    select 1
      from ops.inbound_messages mine
      join ops.conversations c
        on c.tenant_id = mine.tenant_id and c.id = mine.conversation_id
      -- The admission's own fact: the first event of the task it created.
      cross join lateral (
        select pg_catalog.min(e.seq) as seq
          from ops.events e
         where e.tenant_id = mine.tenant_id and e.subject_type = 'task' and e.subject_id = mine.task_id) admitted
     where mine.tenant_id = p_tenant_id
       and mine.task_id = p_item.task_id
       and mine.conversation_id is not null
       and (
         -- a. A newer message by the provider's clock, admitted or refused.
         c.last_inbound_at > mine.received_at
         -- b. The same instant, admitted after it.
         or exists (
           select 1 from ops.inbound_messages later
            where later.tenant_id = mine.tenant_id
              and later.conversation_id = mine.conversation_id
              and later.id <> mine.id
              and (later.received_at > mine.received_at
                   or (later.received_at = mine.received_at and later.created_at > mine.created_at)))
         -- c. A message the database recorded after it, whatever its
         --    timestamp: admitted ...
         or exists (
           select 1
             from ops.inbound_messages later
            cross join lateral (
              select pg_catalog.min(e.seq) as seq
                from ops.events e
               where e.tenant_id = later.tenant_id and e.subject_type = 'task' and e.subject_id = later.task_id) la
            where later.tenant_id = mine.tenant_id
              and later.conversation_id = mine.conversation_id
              and later.id <> mine.id
              and la.seq > admitted.seq)
         --    ... or refused on the record.
         or exists (
           select 1 from ops.events e
            where e.tenant_id = mine.tenant_id
              and e.company_id = c.company_id
              and e.seq > admitted.seq
              and e.type = 'communication.inbound_refused'
              and e.payload ->> 'conversation_id' = mine.conversation_id::pg_catalog.text)))
  end;
$$;

-- ---------------------------------------------------------------------------
-- 10. The scripted review knows the second safety text, and the screening
--     chooses it and authorizes a listed text. As 20261017120000, with both.
-- ---------------------------------------------------------------------------

create or replace function ops.open_scripted_review(
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
  v_revision integer;
begin
  if p_kind is null or p_kind not in ('fixed', 'person') or (p_kind = 'fixed') <> (p_key is not null) then
    raise exception using errcode = 'OS400', message = 'ops.open_scripted_review: a fixed text names its key; a person''s reply names none';
  end if;
  v_proposed := jsonb_build_object(
    'outcome', case when p_key = 'clarification' then 'needs_input' else 'triaged' end,
    'summary', case when p_kind = 'person'
                    then 'A reply written by a person.'
                    else format('Fixed reply %s; no model was called.', p_key) end,
    'intent', 'other',
    'priority', case when p_key in ('safety', 'safety_followup') then 'high' else 'normal' end,
    'recommended_next_action', case p_key
      when 'safety' then 'Send the safety text.'
      when 'safety_followup' then 'Send the safety text.'
      when 'human_handoff_ack' then 'A person takes over this conversation.'
      when 'opt_out_ack' then 'Send the acknowledgement, then record the opt-out in the CRM.'
      else 'Send the reply after review.' end,
    'response_draft', p_draft,
    'needs_human_review', true,
    'flags', case p_key when 'safety' then '["possible_crisis"]'::jsonb
                        when 'safety_followup' then '["possible_crisis"]'::jsonb
                        when 'clarification' then '["unclear"]'::jsonb
                        else '[]'::jsonb end);
  if not ops.agent_run_result_valid('lead_triage', v_proposed) then
    raise exception using errcode = 'OS400', message = 'ops.open_scripted_review: the reply does not fit the review contract';
  end if;
  select coalesce(bool_or(m.do_not_contact), true) into v_dnc
    from ops.inbound_messages m
   where m.tenant_id = p_run.tenant_id and m.task_id = p_run.task_id;
  if p_kind = 'fixed' then
    insert into ops.review_items (
      tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact, author)
    values (p_run.tenant_id, p_run.company_id, p_run.task_id, p_run.id, 'lead_triage', v_proposed, v_dnc, 'fixed')
    on conflict (agent_run_id) where author <> 'person' do nothing
    returning id into v_review;
    if v_review is null then
      raise exception using errcode = 'OS409', message = 'ops.open_scripted_review: this run already has its review';
    end if;
  else
    -- The person's own act names the revision the person saw.
    v_revision := nullif(current_setting('ops.person_reply_revision', true), '')::integer;
    -- At most five replies in a row: a new message from the contact, even one
    -- the store refused, moves the revision and opens room for five more.
    if (select count(*) from ops.review_items ri
         where ri.tenant_id = p_run.tenant_id and ri.agent_run_id = p_run.id and ri.author = 'person'
           and ri.conversation_revision = v_revision) >= 5 then
      raise exception using errcode = 'OS409', message = 'ops.open_scripted_review: five replies from a person already answer this revision';
    end if;
    insert into ops.review_items (
      tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact, author, conversation_revision)
    values (p_run.tenant_id, p_run.company_id, p_run.task_id, p_run.id, 'lead_triage', v_proposed, v_dnc, 'person', v_revision)
    returning id into v_review;
  end if;
  perform ops.record_event(
    p_run.tenant_id, p_run.company_id, 'lead_triage.review_pending', p_source, 'task', p_run.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', p_run.id),
    p_run.correlation_id, null, format('review:%s:pending', v_review));
  return v_review;
end
$function$;

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
  v_review            uuid;
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
  v_key := case
    when v_safety = 'crisis' then 'safety'
    when v_person then 'human_handoff_ack'
    when v_opt_out then 'opt_out_ack'
    when v_class = 'sensitive_only' then
      case when v_party = 'client' then 'sensitive_only_client' else 'sensitive_only_prospect' end
    when v_class = 'unknown' then 'clarification'
    else null end;
  if v_state.holder = 'person' then
    -- A conversation a person holds stays with the person, and the message
    -- waits for them. Only the protective texts are drafted whoever holds
    -- (ADR 0026 §A): the safety text, and the acknowledgement of an opt-out.
    v_waiting := true;
    v_key := case when v_safety = 'crisis' then 'safety' when v_opt_out then 'opt_out_ack' end;
  end if;
  -- ADR 0026 §B: a crisis after the conversation already got a safety text
  -- gets the second one, when the owner published it. The state row this
  -- screening holds orders concurrent screenings of one conversation.
  if v_key = 'safety' and v_inbound.conversation_id is not null
     and coalesce(v_fixed.content -> 'messages' ->> 'safety_followup', '') <> ''
     and exists (select 1 from ops.inbound_screenings p
                  where p.tenant_id = v_tenant and p.conversation_id = v_inbound.conversation_id
                    and p.agent_run_id <> v_run.id and p.disposition = 'fixed_reply'
                    and p.fixed_message_key in ('safety', 'safety_followup')) then
    v_key := 'safety_followup';
  end if;
  if v_waiting and v_key is null then
    v_disposition := 'held_for_person';
  else
    -- Owner decision, 2026-10-08: danger gets the fixed safety text and the
    -- conversation stays with the agent; it is no person's to take. In a
    -- conversation a person holds, the holder does not move.
    v_reason := case when v_waiting then null
                     when v_safety = 'crisis' then null
                     when v_person then 'person_requested'
                     when v_opt_out then 'opt_out' end;
    if not v_waiting and v_reason is null and v_safety <> 'crisis'
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
      v_reason := case when v_waiting then null else coalesce(v_reason, 'operator') end;
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
      v_review := ops.open_scripted_review(v_run, v_fixed.content -> 'messages' ->> v_key, 'fixed', v_key, 'agent-runtime');
      -- ADR 0026 §B: a text the owner listed for automatic sending is accepted
      -- as policy and carried by a job; the answer to the worker is unchanged.
      if coalesce(v_policy.content -> 'automaticFixedTexts', '[]'::jsonb) ? v_key then
        perform ops.authorize_fixed_reply(v_review);
      end if;
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'disposition', v_disposition, 'screeningId', v_screening, 'fixedMessageKey', v_key));
  end if;

  -- The bounded context: the earlier turns of this conversation as the model
  -- may see them, keyed on who wrote each reply (ADR 0026 §A): a contact's
  -- screened text; the agent's own reply, from a run whose screening went to
  -- the model; a fixed clarification, handoff or opt-out acknowledgement.
  -- Anything else is shown as the marker: a person's reply, the safety and
  -- sensitive-subject texts (each would say what the contact wrote, W1,
  -- SI-80), and any fixed text added later.
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
                   case when ri.author = 'agent' and s.disposition = 'model'
                          then ri.proposed ->> 'response_draft'
                        when ri.author = 'fixed' and s.disposition = 'fixed_reply'
                             and s.fixed_message_key in ('clarification', 'human_handoff_ack', 'opt_out_ack')
                          then ri.proposed ->> 'response_draft' end) as turn
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
-- 11. The operator's send never carries a send a job carries. As
--     20261012120000, with that refusal.
-- ---------------------------------------------------------------------------

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
  -- ADR 0026 §B: a send the owner's policy authorized is the worker's job's.
  if found and v_out.job_id is not null then
    raise exception using errcode = 'OS403', message = 'ops.request_outbound_send: refused: carried_by_job';
  end if;
  if v_review.decision_basis = 'published_fixed_text' then
    raise exception using errcode = 'OS403', message = 'ops.request_outbound_send: refused: carried_by_job';
  end if;
  if found and v_out.status <> 'blocked' then
    return jsonb_build_object('outbound_message_id', v_out.id, 'status', v_out.status, 'created', false);
  end if;

  v_check := ops.whatsapp_send_eligibility(p_tenant_id, v_inbound.conversation_id);
  if not (v_check ->> 'eligible')::boolean then
    raise exception using errcode = 'OS403',
      message = format('ops.request_outbound_send: refused: %s', v_check ->> 'reason');
  end if;
  -- ADR 0023 §L: a reply answers the message it was drafted for. Once the
  -- contact wrote again, it is out of context and is never sent.
  if ops.cos_review_superseded(p_tenant_id, v_review) then
    raise exception using errcode = 'OS403', message = 'ops.request_outbound_send: refused: newer_message';
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
  if v_out.job_id is not null then
    raise exception using errcode = 'OS403', message = 'ops.begin_outbound_send: refused: carried_by_job';
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
  -- ADR 0023 §L: the last gate reads the conversation again, so a message
  -- that arrived after the request blocks the reply it made stale.
  if (v_check ->> 'eligible')::boolean and exists (
       select 1 from ops.review_items v
        where v.tenant_id = p_tenant_id and v.id = v_out.review_item_id
          and ops.cos_review_superseded(p_tenant_id, v)) then
    v_check := jsonb_build_object('eligible', false, 'reason', 'newer_message');
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
                          and o.privacy_notice_id = v_notice.id and o.status in ('delivered', 'read')) then
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
-- 12. The worker carries the send: four lease-bound capabilities, which take
--     no tenant, review, send or text. The leased job names its send.
-- ---------------------------------------------------------------------------

-- Gives the leased job back to the queue without a stop: its attempt restored,
-- available again at p_until or in 30 seconds, whichever is sooner. Not
-- granted: only begin calls it, and only while the send is still fresh.
create function ops.release_reply_job(p_job ops.jobs, p_until timestamptz, p_detail text)
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
         available_at = least(now() + interval '30 seconds', p_until),
         updated_at = now()
   where id = p_job.id;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (p_job.id, p_job.tenant_id, 'deferred', p_job.lease_owner, p_job.attempts, p_detail);
  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
end
$function$;

-- Whether a message of the send's conversation newer than the one it answers
-- is admitted and still to be screened. Not granted.
create function ops.reply_newer_message_unscreened(p_out ops.outbound_messages)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select exists (
    select 1
      from ops.inbound_messages mine
      join ops.inbound_messages m on m.tenant_id = mine.tenant_id and m.conversation_id = p_out.conversation_id
      join ops.agent_runs r on r.tenant_id = m.tenant_id and r.id = m.agent_run_id
     where mine.tenant_id = p_out.tenant_id and mine.task_id = p_out.task_id
       and mine.conversation_id = p_out.conversation_id
       and (m.received_at > mine.received_at
            or (m.received_at = mine.received_at and m.created_at > mine.created_at))
       and r.status in ('pending', 'running')
       and not exists (select 1 from ops.inbound_screenings s
                        where s.tenant_id = r.tenant_id and s.agent_run_id = r.id));
$function$;

-- A send the reply job began but never called goes back to authorized, as if
-- it had not begun, and the job back to the queue: the last gate found a
-- reason to wait. Not granted: only the last gate calls it, before any call.
create function ops.unbegin_reply_send(p_out ops.outbound_messages, p_job ops.jobs, p_detail text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  update ops.outbound_messages
     set status = 'authorized', sending_at = null, send_check = null, privacy_notice_id = null,
         transport = null, job_attempt = null
   where id = p_out.id;
  perform ops.release_reply_job(p_job, p_out.fresh_until, p_detail);
  return jsonb_build_object('action', 'released', 'outboundMessageId', p_out.id);
end
$function$;

-- Blocks a policy send that never began, on the record, and lists it for a
-- person (send_blocked), unless the contact's newer message made it stale.
create function ops.block_reply_send(p_out ops.outbound_messages, p_check jsonb)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  update ops.outbound_messages
     set status = 'blocked', blocked_reason = p_check ->> 'reason', send_check = p_check
   where id = p_out.id;
  perform ops.record_event(
    p_out.tenant_id, p_out.company_id, 'communication.outbound_blocked', 'agent-runtime', 'task', p_out.task_id,
    jsonb_build_object('outbound_message_id', p_out.id, 'reason', p_check ->> 'reason'));
  perform ops.sync_send_exceptions(p_out.tenant_id, p_out.id, 'agent-runtime');
  return jsonb_build_object('action', 'settled', 'status', 'blocked', 'outboundMessageId', p_out.id);
end
$function$;

-- TX2a. Answers, for the send the lease is bound to:
--   {action: settled, ...}  nothing to call (settled before, blocked now, or an
--                           earlier attempt's send recorded indeterminate);
--   {action: stopped}       an execution stop covers it: held, nothing recorded;
--   {action: released}      it waits (no transport here, or a newer message is
--                           not screened yet): the job is back in the queue;
--   {action: start, ...}    sending is recorded; call exactly once.
create function ops.begin_reply_send(p_transport text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job     ops.jobs := ops.leased_job();
  v_out     ops.outbound_messages;
  v_review  ops.review_items;
  v_conv    ops.conversations;
  v_channel ops.communication_channels;
  v_notice  ops.privacy_notices;
  v_policy  uuid;
  v_check   jsonb;
  v_body    text;
begin
  if v_job.kind <> 'outbound.reply_send' then
    raise exception using errcode = '42501', message = 'ops.begin_reply_send: the leased job is not a reply send';
  end if;
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id
     for update;
  if not found then
    raise exception using errcode = '42501', message = 'ops.begin_reply_send: no send is bound to the leased job';
  end if;

  if v_out.status = 'sending' then
    if v_out.job_attempt is not distinct from v_job.attempts then
      raise exception using errcode = '42501', message = 'ops.begin_reply_send: this attempt already began the send; a send is never made twice';
    end if;
    -- An earlier attempt began the call and never settled it: it may have
    -- reached the provider. Never call again; a person resolves it.
    update ops.outbound_messages
       set status = 'indeterminate', settled_at = now(), error_class = 'execution_interrupted'
     where id = v_out.id;
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_indeterminate', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
    perform ops.sync_send_exceptions(v_out.tenant_id, v_out.id, 'agent-runtime');
    return jsonb_build_object('action', 'settled', 'status', 'indeterminate', 'outboundMessageId', v_out.id);
  end if;
  if v_out.status <> 'authorized' then
    return jsonb_build_object('action', 'settled', 'status', v_out.status, 'outboundMessageId', v_out.id);
  end if;

  -- The kill switch, for every scope the job's unit has (SI-37).
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind) is not null then
    return jsonb_build_object('action', 'stopped', 'outboundMessageId', v_out.id);
  end if;

  -- A text the contact's newer message replaced is no one's to chase: the
  -- stale rule first, so it never raises send_blocked.
  select ri.* into v_review from ops.review_items ri
   where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id;
  if ops.cos_review_superseded(v_out.tenant_id, v_review) then
    return ops.block_reply_send(v_out, jsonb_build_object('eligible', false, 'reason', 'newer_message'));
  end if;

  -- Fresh, and carried by a worker that has a transport; a worker without one
  -- gives the job back until the text is out of date.
  if now() >= v_out.fresh_until then
    return ops.block_reply_send(v_out, jsonb_build_object(
      'eligible', false,
      'reason', case when p_transport in ('meta', 'fake') then 'fixed_text_expired' else 'transport_not_configured' end));
  end if;
  if p_transport is null or p_transport not in ('meta', 'fake') then
    perform ops.release_reply_job(v_job, v_out.fresh_until, 'waiting for a worker with a reply transport');
    return jsonb_build_object('action', 'released', 'outboundMessageId', v_out.id);
  end if;

  -- An acknowledgement answers the request, not the words around it: it waits
  -- while a newer message of the conversation is still to be screened, so that
  -- a newer opt-out or a newer text of its family is seen first (ADR 0026 §B).
  if v_out.fixed_text_key in ('safety', 'safety_followup', 'human_handoff_ack', 'opt_out_ack')
     and ops.reply_newer_message_unscreened(v_out) then
    perform ops.release_reply_job(v_job, v_out.fresh_until, 'waiting for a newer message to be screened');
    return jsonb_build_object('action', 'released', 'outboundMessageId', v_out.id);
  end if;

  -- Every gate again: the send's eligibility and the opt-out rule (the stop
  -- last), the policy as published now, and the redaction.
  v_check := ops.reply_send_eligibility(v_out.tenant_id, v_out);
  if v_check ->> 'reason' = 'execution_stopped' then
    return jsonb_build_object('action', 'stopped', 'outboundMessageId', v_out.id);
  end if;
  v_policy := (ops.published_agent_configuration(
                 v_out.tenant_id,
                 (select r.agent_id from ops.agent_runs r where r.tenant_id = v_review.tenant_id and r.id = v_review.agent_run_id),
                 'operating_policy')).id;
  if (v_check ->> 'eligible')::boolean and not ops.review_is_published_fixed_text(v_review, v_policy) then
    v_check := jsonb_build_object('eligible', false, 'reason',
      case when v_review.content_redacted_at is not null then 'content_redacted' else 'not_automatic' end);
  end if;
  if not (v_check ->> 'eligible')::boolean then
    return ops.block_reply_send(v_out, v_check);
  end if;

  select c.* into v_conv from ops.conversations c where c.tenant_id = v_out.tenant_id and c.id = v_out.conversation_id;
  select h.* into v_channel from ops.communication_channels h where h.tenant_id = v_out.tenant_id and h.id = v_out.channel_id;
  v_body := v_review.proposed ->> 'response_draft';
  -- The privacy notice rides the conversation's first reply (SI-79), as on the
  -- operator's send.
  select n.* into v_notice from ops.privacy_notices n
   where n.tenant_id = v_out.tenant_id and n.superseded_at is null;
  if found and exists (select 1 from ops.outbound_messages o
                        where o.tenant_id = v_out.tenant_id and o.conversation_id = v_out.conversation_id
                          and o.privacy_notice_id = v_notice.id and o.status in ('delivered', 'read')) then
    v_notice := null;
  end if;
  if v_notice.id is not null then
    v_body := v_body || pg_catalog.repeat(pg_catalog.chr(10), 2) || v_notice.whatsapp_text;
  end if;

  update ops.outbound_messages
     set status = 'sending', sending_at = now(), send_check = v_check, privacy_notice_id = v_notice.id,
         transport = p_transport, job_attempt = v_job.attempts
   where id = v_out.id;
  perform ops.record_event(
    v_out.tenant_id, v_out.company_id, 'communication.outbound_attempted', 'agent-runtime', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id));
  return jsonb_build_object(
    'action', 'start',
    'outboundMessageId', v_out.id,
    'request', jsonb_build_object(
      'providerTarget', v_channel.provider_target,
      'to', v_conv.contact_ref,
      'body', v_body));
end
$function$;

-- TX2b, before the call. Takes the conversation first, then the send: until
-- this transaction ends, the contact's next message waits at its admission
-- (SI-81). It waits for the conversation (another call in flight holds it) at
-- most five seconds, and never more than half the statement's own bound, so the
-- wait ends here and not in a cancelled statement; then, or when a newer
-- message is still to be screened for
-- an acknowledgement, the send goes back to authorized, never called, and the
-- job back to the queue. No eligibility read here: it would hold the
-- kill-switch lock through the call. Answers {action: send}, {action:
-- released}, or {action: settled, status} with nothing to call (a send another
-- path settled, one the newer message made stale, settled failed newer_message,
-- or one whose number was erased, settled failed contact_erased).
create function ops.confirm_reply_send()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job    ops.jobs := ops.leased_job();
  v_out    ops.outbound_messages;
  v_wait   text := pg_catalog.current_setting('lock_timeout');
  v_bound  interval := pg_catalog.current_setting('statement_timeout')::interval;
  v_limit  interval := interval '5 seconds';
begin
  if v_bound > interval '0' then
    v_limit := least(v_limit, v_bound / 2);
  end if;
  if v_job.kind <> 'outbound.reply_send' then
    raise exception using errcode = '42501', message = 'ops.confirm_reply_send: the leased job is not a reply send';
  end if;
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id;
  if not found then
    raise exception using errcode = '42501', message = 'ops.confirm_reply_send: no send is bound to the leased job';
  end if;
  -- The subtransaction's rollback restores the caller's lock timeout on a
  -- timeout; the normal path restores it by hand.
  begin
    perform pg_catalog.set_config(
      'lock_timeout',
      greatest(1, pg_catalog.floor(pg_catalog.date_part('epoch', v_limit) * 1000))::bigint::text || 'ms',
      true);
    perform 1 from ops.conversations c
     where c.tenant_id = v_out.tenant_id and c.id = v_out.conversation_id
       for no key update;
    perform pg_catalog.set_config('lock_timeout', v_wait, true);
  exception when lock_not_available then
    select o.* into v_out from ops.outbound_messages o
     where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id
       for update;
    if v_out.status <> 'sending' or v_out.job_attempt is distinct from v_job.attempts then
      return jsonb_build_object('action', 'settled', 'status', v_out.status, 'outboundMessageId', v_out.id);
    end if;
    return ops.unbegin_reply_send(v_out, v_job, 'waiting for the conversation');
  end;
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id
     for update;
  if v_out.status <> 'sending' or v_out.job_attempt is distinct from v_job.attempts then
    return jsonb_build_object('action', 'settled', 'status', v_out.status, 'outboundMessageId', v_out.id);
  end if;
  -- A message admitted since begin, now visible, is screened first.
  if v_out.fixed_text_key in ('safety', 'safety_followup', 'human_handoff_ack', 'opt_out_ack')
     and ops.reply_newer_message_unscreened(v_out) then
    return ops.unbegin_reply_send(v_out, v_job, 'waiting for a newer message to be screened');
  end if;
  -- A number erased since begin is never written to.
  if exists (select 1 from ops.conversations c
              where c.tenant_id = v_out.tenant_id and c.id = v_out.conversation_id
                and c.contact_erased_at is not null) then
    update ops.outbound_messages
       set status = 'failed', settled_at = now(), error_class = 'contact_erased'
     where id = v_out.id;
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_failed', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
    return jsonb_build_object('action', 'settled', 'status', 'failed', 'outboundMessageId', v_out.id);
  end if;
  if exists (select 1 from ops.review_items ri
              where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                and ops.cos_review_superseded(v_out.tenant_id, ri)) then
    -- Never called: failed, by the state machine's own definition.
    update ops.outbound_messages
       set status = 'failed', settled_at = now(), error_class = 'newer_message'
     where id = v_out.id;
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_failed', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
    return jsonb_build_object('action', 'settled', 'status', 'failed', 'outboundMessageId', v_out.id);
  end if;
  return jsonb_build_object('action', 'send', 'outboundMessageId', v_out.id);
end
$function$;

-- TX2b, after the call: records what the one call produced, for this attempt's
-- send only. Answers the outcome, or not_sending.
create function ops.settle_reply_send(
  p_outcome text, p_provider_message_id text, p_error_code text, p_error_class text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job ops.jobs := ops.leased_job();
  v_out ops.outbound_messages;
begin
  if v_job.kind <> 'outbound.reply_send' then
    raise exception using errcode = '42501', message = 'ops.settle_reply_send: the leased job is not a reply send';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'indeterminate') then
    raise exception using errcode = 'OS400', message = 'ops.settle_reply_send: unknown outcome';
  end if;
  if p_outcome = 'sent' and (p_provider_message_id is null or p_provider_message_id !~ '^[\x21-\x7e]{1,200}$') then
    raise exception using errcode = 'OS400', message = 'ops.settle_reply_send: a sent message needs its provider id';
  end if;
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id
     for update;
  if not found or v_out.status <> 'sending' or v_out.job_attempt is distinct from v_job.attempts then
    return 'not_sending';
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
  if p_outcome = 'sent' then
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_sent', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
  elsif p_outcome = 'failed' then
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_failed', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
  else
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_indeterminate', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
  end if;
  return p_outcome;
end
$function$;

-- The worker's post-settlement step, in a transaction of its own AFTER the
-- settlement committed: the send's exceptions (a failure, an uncertain
-- outcome). Only for the worker that completed the job; no tenant, send or
-- content argument; idempotent.
create function ops.sync_send_exceptions_for_settled_job(p_worker_id text, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job ops.jobs;
  v_out uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or p_job_id is null then
    raise exception using errcode = 'OS400',
      message = 'ops.sync_send_exceptions_for_settled_job requires a worker id and a job id';
  end if;
  select j.* into v_job from ops.jobs j
   where j.id = p_job_id and j.kind = 'outbound.reply_send' and j.status = 'succeeded';
  if not found then
    return null;
  end if;
  if not exists (select 1 from ops.job_events e
                  where e.job_id = v_job.id and e.tenant_id = v_job.tenant_id
                    and e.event = 'succeeded' and e.worker_id = p_worker_id) then
    raise exception using errcode = 'OS403',
      message = 'ops.sync_send_exceptions_for_settled_job: that job was not completed by this worker';
  end if;
  select o.id into v_out from ops.outbound_messages o
   where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id;
  if v_out is null then
    return null;
  end if;
  return ops.sync_send_exceptions(v_job.tenant_id, v_out, 'agent-runtime');
end
$function$;


-- The worker's reaper tick: a policy send whose job ended without settling it
-- (its attempts ran out, or a worker died with the last one) is settled on
-- the record and listed for a person, never sent. Authorized: blocked
-- job_failed (newer_message when a newer message replaced it). Sending, with no
-- live lease of the attempt that began it: indeterminate, never called again.
-- At most 500 a tick; a send a transaction holds is left to its own act.
create function ops.settle_stale_reply_sends()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row     record;
  v_out     ops.outbound_messages;
  v_settled integer := 0;
begin
  for v_row in
    select o.id, j.status as job_status
      from ops.outbound_messages o
      join ops.jobs j on j.tenant_id = o.tenant_id and j.id = o.job_id
     where o.authorization_kind = 'fixed_text'
       and j.status in ('failed', 'succeeded')
       and o.status in ('authorized', 'sending')
     order by o.created_at, o.id
     limit 500
       for update of o skip locked
  loop
    select * into v_out from ops.outbound_messages where id = v_row.id;
    if v_out.status = 'authorized' then
      perform ops.block_reply_send(v_out, jsonb_build_object('eligible', false, 'reason',
        case when exists (select 1 from ops.review_items ri
                           where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                             and ops.cos_review_superseded(v_out.tenant_id, ri))
             then 'newer_message' else 'job_failed' end));
    else
      update ops.outbound_messages
         set status = 'indeterminate', settled_at = now(), error_class = 'execution_interrupted'
       where id = v_out.id;
      perform ops.record_event(
        v_out.tenant_id, v_out.company_id, 'communication.outbound_indeterminate', 'agent-runtime', 'task', v_out.task_id,
        jsonb_build_object('outbound_message_id', v_out.id));
      perform ops.sync_send_exceptions(v_out.tenant_id, v_out.id, 'agent-runtime');
    end if;
    v_settled := v_settled + 1;
  end loop;
  return v_settled;
end
$function$;

-- ---------------------------------------------------------------------------
-- 13. A blocked automatic text waits for a person. As 20261016120000, with
--     send_blocked and the job sends the owner's sync must read.
-- ---------------------------------------------------------------------------

create or replace function ops.sync_send_exceptions(p_tenant_id uuid, p_outbound_id uuid, p_actor text)
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
  v_expired text;
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

  -- ADR 0026 §B: an automatic text that did not leave waits for a person,
  -- unless the contact's newer message made it stale. One its job could not
  -- begin while it was fresh (the job retired, or no worker took it) is
  -- blocked now, on the record.
  if v_out.job_id is not null and v_out.status = 'authorized' and now() >= v_out.fresh_until
     and not exists (select 1 from ops.jobs j
                      where j.tenant_id = v_out.tenant_id and j.id = v_out.job_id
                        and j.status = 'leased' and j.lease_expires_at > now()) then
    v_expired := case when exists (select 1 from ops.review_items ri
                                    where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                                      and ops.cos_review_superseded(v_out.tenant_id, ri))
                      then 'newer_message' else 'fixed_text_expired' end;
    update ops.outbound_messages
       set status = 'blocked', blocked_reason = v_expired,
           send_check = jsonb_build_object('eligible', false, 'reason', v_expired)
     where id = v_out.id
    returning * into v_out;
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_blocked', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id, 'reason', v_expired));
  end if;
  if v_out.job_id is not null and v_out.status = 'blocked' and v_out.blocked_reason is distinct from 'newer_message'
     and not exists (select 1 from ops.exceptions e
                      where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
                        and e.kind = 'send_blocked') then
    if ops.open_exception(v_out.tenant_id, v_out.company_id, v_out.task_id, 'send_blocked',
                          v_out.conversation_id, v_out.id, null, p_actor) is not null then
      v_opened := v_opened + 1;
    end if;
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

create or replace function ops.sync_tenant_send_exceptions(p_tenant_id uuid)
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
     where o.tenant_id = p_tenant_id
       and (o.status not in ('authorized', 'blocked') or o.job_id is not null)
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

-- ---------------------------------------------------------------------------
-- 14. Access, and the end state.
-- ---------------------------------------------------------------------------

revoke all on function ops.required_fixed_message_keys() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.automatic_fixed_text_keys() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.safety_fixed_text_keys() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.review_is_published_fixed_text(ops.review_items, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.whatsapp_contact_eligibility(uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.reply_send_eligibility(uuid, ops.outbound_messages)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.authorize_fixed_reply(uuid) from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.release_reply_job(ops.jobs, timestamptz, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.block_reply_send(ops.outbound_messages, jsonb)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.reply_newer_message_unscreened(ops.outbound_messages)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.unbegin_reply_send(ops.outbound_messages, ops.jobs, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- The worker's four new capabilities and its reaper step: its alone.
revoke all on function ops.begin_reply_send(text) from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.confirm_reply_send() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.settle_reply_send(text, text, text, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.sync_send_exceptions_for_settled_job(text, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.settle_stale_reply_sends() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function ops.begin_reply_send(text) to ops_worker;
grant execute on function ops.confirm_reply_send() to ops_worker;
grant execute on function ops.settle_reply_send(text, text, text, text) to ops_worker;
grant execute on function ops.sync_send_exceptions_for_settled_job(text, uuid) to ops_worker;
grant execute on function ops.settle_stale_reply_sends() to ops_worker;

do $end_state$
declare
  v_bad text;
  c_invokers constant text[] := array[
    'ops.required_fixed_message_keys()', 'ops.automatic_fixed_text_keys()', 'ops.safety_fixed_text_keys()',
    'ops.review_is_published_fixed_text(ops.review_items, uuid)',
    'ops.whatsapp_contact_eligibility(uuid, uuid)',
    'ops.reply_send_eligibility(uuid, ops.outbound_messages)', 'ops.authorize_fixed_reply(uuid)',
    'ops.release_reply_job(ops.jobs, timestamptz, text)', 'ops.block_reply_send(ops.outbound_messages, jsonb)',
    'ops.reply_newer_message_unscreened(ops.outbound_messages)',
    'ops.unbegin_reply_send(ops.outbound_messages, ops.jobs, text)'];
  c_capabilities constant text[] := array[
    'ops.begin_reply_send(text)', 'ops.confirm_reply_send()', 'ops.settle_reply_send(text, text, text, text)',
    'ops.sync_send_exceptions_for_settled_job(text, uuid)', 'ops.settle_stale_reply_sends()'];
begin
  -- Every stored configuration still passes the check it is held to, and no
  -- published policy lets a text leave before the owner lists one.
  select pg_catalog.string_agg(v.id::pg_catalog.text, ', ') into v_bad
    from ops.agent_configuration_versions v
   where not ops.agent_configuration_valid(v.kind, v.content);
  if v_bad is not null then
    raise exception 'a stored configuration no longer passes its check: %', v_bad;
  end if;
  if exists (select 1 from ops.agent_configuration_versions v
              where v.kind = 'operating_policy' and v.content ? 'automaticFixedTexts') then
    raise exception 'a stored policy already names automatic texts: the owner lists them after this migration';
  end if;

  -- Every decided review names its basis; only the policy writes its label.
  if exists (select 1 from ops.review_items ri
              where (ri.status = 'pending') <> (ri.decision_basis is null)
                 or (ri.decision_basis = 'person' and ri.reviewer ~ '^(policy|system):')) then
    raise exception 'a review''s decision basis does not match its decision';
  end if;

  -- The kind is external, held by the kill switch, and no task may request it.
  if not ('outbound.reply_send' = any (ops.external_job_kinds()))
     or 'outbound.reply_send' = any (ops.task_executable_kinds()) then
    raise exception 'outbound.reply_send is not an external kind only the database queues';
  end if;

  -- The helpers are pinned INVOKERs no role reaches; the capabilities are
  -- pinned DEFINERs only the worker executes.
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
    raise exception 'an automatic-text helper is reachable or not a pinned INVOKER: %', v_bad;
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
    raise exception 'a reply-send capability is not a pinned DEFINER the worker alone executes: %', v_bad;
  end if;

  -- The last gate holds the conversation through the call, waits for it a
  -- bounded time, and nothing in it takes the kill-switch lock a stop trip
  -- waits on.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.confirm_reply_send()'::pg_catalog.regprocedure), 'for no key update') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.confirm_reply_send()'::pg_catalog.regprocedure), 'lock_not_available') = 0
     or (select p.prosrc from pg_catalog.pg_proc p
          where p.oid = 'ops.confirm_reply_send()'::pg_catalog.regprocedure)
        ~ '(execution_stop_lock_key|whatsapp_send_eligibility|reply_send_eligibility)' then
    raise exception 'the reply''s last gate does not hold the conversation, or takes the kill-switch lock';
  end if;

  -- The operator's send refuses a send a job carries.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.request_outbound_send(uuid, uuid, text, text)'::pg_catalog.regprocedure),
                       'refused: carried_by_job') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_outbound_send(uuid, uuid)'::pg_catalog.regprocedure),
                          'refused: carried_by_job') = 0 then
    raise exception 'the operator''s send would carry a send a job carries';
  end if;

  -- The screening capability keeps its definer, search path and one grantee.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.record_inbound_screening(jsonb)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, 'ops.authorize_fixed_reply') > 0) then
    raise exception 'the screening capability lost its definer, its pinned search path or the policy authorization';
  end if;
  if not pg_catalog.has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('ops_gateway', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.record_inbound_screening(jsonb)', 'EXECUTE') then
    raise exception 'the screening capability is no longer the worker''s alone';
  end if;
end
$end_state$;
