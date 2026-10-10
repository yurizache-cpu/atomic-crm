-- ADR 0026 §C, slice 3c: a contact who asked to stop and writes again takes
-- messages back (owner decision 9).
--
-- The contact's own opt-out, once the CRM recorded it, is lifted by that
-- contact's own later message that is not itself an opt-out:
--   * The screening asks ops.crm_lift_opt_out for every such WhatsApp
--     message. It reads the CRM as it is now, not the admission's snapshot:
--     it lifts only when the exact contact's flag is true, the consent
--     ledger's newest entry is the system's record of an opt-out from a
--     message older than this one, and no opt-out was requested for a newer
--     message of the same number. So a message sent before the opt-out never
--     lifts it, a newer opt-out is never undone by an older message, and a
--     flag a person set is never lifted by a message.
--   * A message whose opt-out was lifted (or found already lifted) is
--     reachable again: the screening, the reviews it opens and the policy's
--     predicate read the effective flag, and the conversation the opt-out
--     handed to a person goes back to the agent, unless a person took it
--     over or replied since, or another reason for a person is open.
--   * For a crisis message, no failure of the lift holds the screening: the
--     safety text never needed the lift.
--   * The CRM form can set the flag and clear one a person set, never the
--     contact's own system-recorded opt-out (a guard on lead_profiles, with
--     its own message).
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. Whether the screening found the admission's opt-out lifted, and the
--    acts this slice records.
-- ---------------------------------------------------------------------------

alter table ops.inbound_screenings add column opt_out_cleared boolean not null default false;

comment on column ops.inbound_screenings.opt_out_cleared is
  'ADR 0026 §C: the admission recorded the contact as opted out, and this message lifted the contact''s own opt-out (or found it already lifted): the message is reachable, whatever its admission''s snapshot said.';

alter table ops.crm_contact_acts drop constraint crm_contact_acts_act_check;
alter table ops.crm_contact_acts add constraint crm_contact_acts_act_check check (act in (
  'created', 'skipped:cap', 'skipped:no_cap', 'skipped:possible_match', 'skipped:error',
  'opted_out', 'opt_out_unresolved', 'opt_out_dismissed', 'opt_out_lifted'));
alter table ops.crm_contact_acts drop constraint crm_contact_acts_created_names_contact;
alter table ops.crm_contact_acts add constraint crm_contact_acts_created_names_contact check (
  (act in ('created', 'opted_out', 'opt_out_lifted')) = (crm_contact_ref is not null));
alter table ops.crm_contact_acts drop constraint crm_contact_acts_opt_out_names_message;
alter table ops.crm_contact_acts add constraint crm_contact_acts_opt_out_names_message check (
  (act in ('opted_out', 'opt_out_unresolved', 'opt_out_dismissed', 'opt_out_lifted')) = (task_id is not null));

-- ---------------------------------------------------------------------------
-- 2. The lift adapter. Executable by no role; called only by the screening.
-- ---------------------------------------------------------------------------

-- Answers lifted (the contact's own opt-out cleared, named after this
-- message), clear (the flag is false), kept (a person set it, or it is not
-- from an older message, or a newer message opted out) or unresolved (no
-- single contact, no lead profile, or a tenant that does not own the CRM).
create function ops.crm_lift_opt_out(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_conversation_id uuid,
  p_channel_id      uuid,
  p_sender          text,
  p_task_id         uuid)
returns text
language plpgsql
volatile
security invoker
set search_path to ''
set lock_timeout to '2s'
as $function$
declare
  v_crm     jsonb;
  v_ref     text;
  v_contact bigint;
  v_flag    boolean;
  v_latest  public.lead_consent_changes;
  v_mine    ops.inbound_messages;
  v_reason  ops.inbound_messages;
begin
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return 'unresolved';
  end if;
  v_crm := ops.crm_contact_by_phone(p_tenant_id, p_sender);
  if v_crm ->> 'state' is distinct from 'found' then
    return 'unresolved';
  end if;
  v_ref := v_crm ->> 'crm_contact_ref';
  v_contact := substring(v_ref from '^crm:contact:([0-9]{1,19})$')::bigint;
  select lp.do_not_contact into v_flag from public.lead_profiles lp where lp.contact_id = v_contact for update;
  if v_flag is null then
    return 'unresolved';
  elsif not v_flag then
    return 'clear';
  end if;

  -- The contact's own opt-out, from an older message, and no newer one.
  select c.* into v_latest from public.lead_consent_changes c
   where c.contact_id = v_contact
   order by c.changed_at desc, c.id desc
   limit 1;
  select m.* into v_mine from ops.inbound_messages m where m.tenant_id = p_tenant_id and m.task_id = p_task_id;
  if v_latest.origin is distinct from 'system_opt_out' or v_mine.id is null then
    return 'kept';
  end if;
  select m.* into v_reason from ops.inbound_messages m
   where m.tenant_id = p_tenant_id and m.task_id = substr(v_latest.reason_ref, 6)::uuid;
  if v_reason.id is null
     or (v_reason.received_at, v_reason.created_at) >= (v_mine.received_at, v_mine.created_at)
     or exists (select 1
                  from ops.crm_opt_out_requests q
                  join ops.inbound_messages qm on qm.tenant_id = q.tenant_id and qm.task_id = q.task_id
                 where q.tenant_id = p_tenant_id and qm.contact_ref = p_sender
                   and (qm.received_at, qm.created_at) > (v_mine.received_at, v_mine.created_at)) then
    return 'kept';
  end if;

  perform pg_catalog.set_config('ops.consent_origin', format('system_lift:task:%s', p_task_id), true);
  update public.lead_profiles set do_not_contact = false where contact_id = v_contact;
  perform pg_catalog.set_config('ops.consent_origin', '', true);
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref, task_id)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opt_out_lifted', v_ref, p_task_id);
  return 'lifted';
end
$function$;

comment on function ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid) is
  'ADR 0026 §C, SI-84: clears the exact contact''s do_not_contact only when the consent ledger''s newest entry is the system''s record of an opt-out from a message older than this one and no newer message of the number opted out; recorded as the system''s lift, naming this message. Executable by no role.';

-- ---------------------------------------------------------------------------
-- 3. The CRM form clears a flag a person set, never the contact's own
--    system-recorded opt-out. Matches supabase/schemas (02_functions,
--    04_triggers, 06_grants).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."refuse_system_opt_out_clear"() RETURNS trigger
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    declare
      v_origin text;
    begin
      -- Only a clear concerns it; the system's own lift names its message.
      if not (old.do_not_contact and not new.do_not_contact) then
        return new;
      end if;
      if pg_catalog.current_setting('ops.consent_origin', true)
         ~ '^system_lift:task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return new;
      end if;
      select c.origin into v_origin from public.lead_consent_changes c
       where c.contact_id = old.contact_id
       order by c.changed_at desc, c.id desc
       limit 1;
      if v_origin = 'system_opt_out' then
        raise exception using errcode = 'OS403',
          message = 'this contact asked to stop by message: only the contact''s own later message lifts it';
      end if;
      return new;
    end;
    $$;

create or replace trigger refuse_system_opt_out_clear_trigger
    before update of do_not_contact on public.lead_profiles
    for each row execute function public.refuse_system_opt_out_clear();

revoke all on function public.refuse_system_opt_out_clear() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. The screening lifts the contact's own opt-out and gives the
--    conversation back. As 20261019130000, with the lift.
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
  v_review            uuid;
  v_lift              text;
  v_cleared           boolean := false;
  v_newest_task       uuid;
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
    -- ADR 0026 §C (owner decision 9): the contact's own later message that is
    -- not itself an opt-out lifts the contact's own opt-out, as the CRM holds
    -- it now (the admission's snapshot may predate its record). The state row
    -- is held (the party-kind move took it), so screenings and the record job
    -- take their turns. A crisis message is never held by a failed lift: its
    -- safety text never needed it.
    if not v_opt_out then
      -- The conversation first, then the CRM: the order a number's erasure
      -- takes, so the two never wait on each other in a cycle.
      perform 1 from ops.conversations c where c.id = v_inbound.conversation_id for key share;
      begin
        v_lift := ops.crm_lift_opt_out(
          v_tenant, v_run.company_id, v_inbound.conversation_id, v_inbound.channel_id,
          (select c.contact_ref from ops.conversations c where c.id = v_inbound.conversation_id), v_run.task_id);
      exception
        when lock_not_available or serialization_failure or deadlock_detected then
          if v_safety = 'crisis' then
            v_lift := 'failed';
          else
            raise;
          end if;
        when others then
          v_lift := 'failed';
      end;
      v_cleared := v_lift = 'lifted'
                   or (v_lift = 'clear' and coalesce(v_inbound.do_not_contact, false)
                       and v_inbound.contact_resolution = 'found');
      if v_lift = 'lifted' then
        perform ops.record_event(
          v_tenant, v_run.company_id, 'lead.opt_out_lifted', 'agent-runtime', 'task', v_run.task_id,
          '{}'::jsonb, null, null, format('lead:%s:opt_out_lifted', v_run.task_id));
      end if;
      -- The conversation the opt-out handed to a person goes back to the
      -- agent, unless a person took it over or replied since, or another
      -- reason for a person is open.
      if v_cleared then
        select s.* into v_state from ops.conversation_states s where s.conversation_id = v_inbound.conversation_id;
        if v_state.holder = 'person' and v_state.holder_reason = 'opt_out'
           and not exists (select 1 from ops.exceptions e
                            where e.tenant_id = v_tenant and e.conversation_id = v_inbound.conversation_id
                              and e.kind in ('person_requested', 'configuration_missing', 'opt_out')
                              and e.resolved_at is null)
           and not exists (select 1
                             from ops.review_items ri
                             join ops.inbound_messages rm on rm.tenant_id = ri.tenant_id and rm.task_id = ri.task_id
                            where ri.tenant_id = v_tenant and rm.conversation_id = v_inbound.conversation_id
                              and ri.author = 'person' and ri.created_at >= v_state.holder_changed_at) then
          perform ops.move_conversation_state(v_inbound.conversation_id, 'holder', 'agent', 'opt_out_lifted', 'front-desk');
          for v_open in
            select e.id from ops.exceptions e
             where e.tenant_id = v_tenant and e.conversation_id = v_inbound.conversation_id
               and e.kind = 'message_waiting' and e.resolved_at is null
          loop
            perform ops.close_exception(v_open, 'reconciled', 'front-desk');
          end loop;
        end if;
      end if;
    end if;
    select s.* into v_state from ops.conversation_states s where s.conversation_id = v_inbound.conversation_id;
    -- ADR 0021 W6 (a): a reply reaches only a contact the admission found in
    -- the CRM, not marked do-not-contact. Unknown is unreachable. ADR 0026 §C:
    -- unless this message lifted the contact's own opt-out.
    v_reachable := not coalesce(v_inbound.do_not_contact, true) or v_cleared;
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
    fixed_messages_version_id, opt_out_cleared)
  values (
    v_tenant, v_run.company_id, v_run.task_id, v_run.id, v_inbound.conversation_id,
    p_screening ->> 'sanitizerVersion', p_screening ->> 'packId',
    v_class, v_safety, v_sensitive + v_unknown, v_sensitive, v_unknown,
    v_admin, v_person, v_opt_out, v_text, v_party,
    v_disposition, v_key, v_policy.id, v_playbook.id, v_knowledge.id,
    case when v_disposition = 'fixed_reply' then v_fixed.id end, v_cleared)
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
      -- ADR 0026 §C: the opt-out reaches the CRM after its acknowledgement,
      -- bound to the episode just opened or counted on.
      perform ops.request_crm_opt_out_record(v_tenant, v_run.company_id, v_inbound.conversation_id, v_run.task_id);
    end if;
    if v_text_needed then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'configuration_missing',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
    -- Whether a reply can reach the contact now is the conversation's newest
    -- admission's answer, not this message's: messages are not screened in
    -- the order they arrived (several workers, a retry), and an older message
    -- must neither reconcile a newer refusal nor reopen a settled one.
    select m.do_not_contact, m.contact_resolution, m.task_id into v_newest_dnc, v_newest_resolution, v_newest_task
      from ops.inbound_messages m
     where m.tenant_id = v_tenant and m.conversation_id = v_inbound.conversation_id
     order by m.received_at desc, m.created_at desc
     limit 1;
    -- ADR 0026 §C: the newest message lifted the contact's own opt-out.
    if v_newest_dnc and exists (select 1 from ops.inbound_screenings s
                                 where s.tenant_id = v_tenant and s.task_id = v_newest_task and s.opt_out_cleared) then
      v_newest_dnc := false;
    end if;
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
-- 5. The reviews read the effective flag. As 20261019130000 and
--    20261017120000, each with it.
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
      when 'opt_out_ack' then 'Send the acknowledgement; the opt-out is recorded after it unless you dismiss the exception.'
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
  -- ADR 0026 §C: an opt-out the message lifted no longer applies to it.
  select coalesce(bool_or(m.do_not_contact
                          and not exists (select 1 from ops.inbound_screenings s
                                           where s.tenant_id = m.tenant_id and s.task_id = m.task_id
                                             and s.opt_out_cleared)), true) into v_dnc
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

create or replace function ops.open_review_for_run(p_tenant_id uuid, p_run_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run    ops.agent_runs;
  v_dnc    boolean;
  v_review uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.open_review_for_run: no tenant scope';
  end if;

  select r.* into v_run
    from ops.agent_runs r
   where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.open_review_for_run: agent run not found in this tenant';
  end if;

  -- Only a lead triage run that succeeded, with the result the database
  -- validated when it settled, has advice for a person to review.
  if v_run.capability <> 'lead_triage' or v_run.status <> 'succeeded' or v_run.result is null then
    return null;
  end if;

  -- The consent state the ADMISSION recorded, from its trusted policy source,
  -- found by TASK rather than by run: a retry of the admitted run
  -- (retry_of_run_id), or a second request on the same task, is still that
  -- lead, and inherits what was recorded for it. A task no admission created
  -- has no established consent, and that is do-not-contact.
  -- ADR 0026 §C: an opt-out the message lifted no longer applies to it.
  select coalesce(bool_or(m.do_not_contact
                          and not exists (select 1 from ops.inbound_screenings s
                                           where s.tenant_id = m.tenant_id and s.task_id = m.task_id
                                             and s.opt_out_cleared)), true) into v_dnc
    from ops.inbound_messages m
   where m.tenant_id = v_run.tenant_id and m.task_id = v_run.task_id;

  insert into ops.review_items (
    tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact, author)
  values (
    v_run.tenant_id, v_run.company_id, v_run.task_id, v_run.id, v_run.capability, v_run.result,
    v_dnc, 'agent')
  on conflict (agent_run_id) where author <> 'person' do nothing
  returning id into v_review;

  if v_review is null then
    return null; -- already opened: a run is reviewed once
  end if;

  perform ops.record_event(
    v_run.tenant_id, v_run.company_id, 'lead_triage.review_pending', 'agent-runtime', 'task', v_run.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', v_run.id),
    v_run.correlation_id, null, format('review:%s:pending', v_review));

  return v_review;
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. The browser knows lead.opt_out_lifted, which carries no facts. As
--    20261019130000, with the new type.
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
    'lead.created', 'lead.opted_out', 'lead.opt_out_lifted');
$$;

-- ---------------------------------------------------------------------------
-- 7. Access, and the end state.
-- ---------------------------------------------------------------------------

revoke all on function ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
begin
  -- The lift adapter is an INVOKER no role reaches, PUBLIC included; only the
  -- screening, a pinned DEFINER the worker executes, calls it.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure
                    and not p.prosecdef and p.proacl is not null)
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure
                   and a.grantee = 0)
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                 where pg_catalog.has_function_privilege(
                         r.rolname, 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)', 'EXECUTE')) then
    raise exception 'the opt-out lift adapter is reachable or not an INVOKER';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.record_inbound_screening(jsonb)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, 'ops.crm_lift_opt_out') > 0
                    and pg_catalog.strpos(p.prosrc, 'ops.request_crm_opt_out_record') > 0
                    and pg_catalog.strpos(p.prosrc, 'ops.authorize_fixed_reply') > 0)
     or not pg_catalog.has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'EXECUTE') then
    raise exception 'the screening does not lift the contact''s own opt-out';
  end if;

  -- The CRM form's clear guard: a DEFINER no role executes, enabled on the
  -- profile table, before the update.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'public.refuse_system_opt_out_clear()'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""'])
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'public.refuse_system_opt_out_clear()'::pg_catalog.regprocedure and a.grantee = 0)
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role')) as r (rolname)
                 where pg_catalog.has_function_privilege(r.rolname, 'public.refuse_system_opt_out_clear()', 'EXECUTE'))
     or not exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = 'public.lead_profiles'::pg_catalog.regclass
                       and t.tgname = 'refuse_system_opt_out_clear_trigger'
                       and not t.tgisinternal and t.tgenabled = 'O'
                       and t.tgfoid = 'public.refuse_system_opt_out_clear()'::pg_catalog.regprocedure) then
    raise exception 'the CRM form can clear the contact''s own opt-out';
  end if;

  -- The reviews read the effective flag.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.open_review_for_run(uuid, uuid)'::pg_catalog.regprocedure),
                       's.opt_out_cleared') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.proname = 'open_scripted_review'
                              and p.pronamespace = 'ops'::pg_catalog.regnamespace),
                          's.opt_out_cleared') = 0 then
    raise exception 'a review does not read the effective opt-out flag';
  end if;

  if not ops.cos_event_known('lead.opt_out_lifted') then
    raise exception 'lead.opt_out_lifted is not known to the browser';
  end if;
end
$end_state$;
