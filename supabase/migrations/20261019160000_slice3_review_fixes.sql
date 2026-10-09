-- ADR 0026 §C, slice 3: the branch's adversarial review (five lenses, each
-- finding verified against the code) found these, answered here:
--   * A flag a person set could be cleared by a message: the record job's
--     renewal named the contact's opt-out as the flag's newest origin. The
--     lift now keeps the flag whenever a person's flag is part of the opt-out
--     (a person turned it on, named it on again, or it was on before the
--     ledger existed), records the contact's own opt-out as lifted, and the
--     person may then clear it.
--   * The CRM form's guard decided from the newest entry, so naming the flag
--     on again and then off cleared the contact's own opt-out: a person's
--     unchanged "on" no longer decides.
--   * A merge, or a person's deletion, removing the contact while the record
--     or the lift reads it lost the write: either now tries again (40001), so
--     the number resolves the contact it names now. merge_contacts holds both
--     contacts and both lead profiles before it reads them.
--   * A person's dismissal that committed while the record ran was missed:
--     the settlement reads it under the episode's lock.
--   * An automatic acknowledgement brought the record forward within seconds,
--     so a false positive could not be dismissed: only an acknowledgement a
--     person accepted does; an automatic one leaves the record at the
--     window's end.
--   * A number's erasure, the screening and the record job could wait on each
--     other in a cycle: the erasure holds every conversation of the number
--     (and the sweep its batch's), in id order, before any CRM row.
--   * A takeover of a conversation held for an opt-out left no trace, so the
--     contact's later message gave it back to the agent: it is recorded.
--   * The CRM copy kept a lead forever once it ever opted out: an opt-out
--     keeps it only while in force.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The CRM adapters: a flag a person set is never cleared by a message,
--    and a contact that vanished mid-read is tried again. As 20261019150000.
-- ---------------------------------------------------------------------------

create or replace function ops.crm_record_opt_out(
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
  v_was     boolean;
begin
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    v_crm := jsonb_build_object('state', 'unavailable');
  else
    v_crm := ops.crm_contact_by_phone(p_tenant_id, p_sender);
  end if;
  if v_crm ->> 'state' = 'found' then
    v_ref := v_crm ->> 'crm_contact_ref';
    v_contact := substring(v_ref from '^crm:contact:([0-9]{1,19})$')::bigint;
    select lp.do_not_contact into v_was from public.lead_profiles lp where lp.contact_id = v_contact for update;
    if v_was is null then
      -- A merge or a person's deletion removed the contact after the CRM was
      -- read: try again, so the number resolves the contact it names now.
      if not exists (select 1 from public.contacts c where c.id = v_contact) then
        raise exception using errcode = '40001', message = 'ops.crm_record_opt_out: the contact changed while it was read; try again';
      end if;
    end if;
  end if;
  if v_was is null then
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, task_id)
    values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opt_out_unresolved', p_task_id);
    return 'unresolved';
  end if;
  perform pg_catalog.set_config('ops.consent_origin', format('system_opt_out:task:%s', p_task_id), true);
  perform pg_catalog.set_config('ops.crm_write', 'system', true);
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  perform pg_catalog.set_config('ops.crm_write', '', true);
  perform pg_catalog.set_config('ops.consent_origin', '', true);
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref, task_id)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opted_out', v_ref, p_task_id);
  return case when v_was then 'already_recorded' else 'recorded' end;
end
$function$;

create or replace function ops.crm_lift_opt_out(
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
  v_off     public.lead_consent_changes;
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
    -- A merge or a person's deletion removed the contact after the CRM was
    -- read: try again, so the number resolves the contact it names now.
    if not exists (select 1 from public.contacts c where c.id = v_contact) then
      raise exception using errcode = '40001', message = 'ops.crm_lift_opt_out: the contact changed while it was read; try again';
    end if;
  end if;
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

  -- A flag a person set is never cleared by a message (owner decision 9).
  -- When a person's flag is part of this opt-out (a person turned the flag on,
  -- named it on again, or it was on before the ledger existed), the contact's
  -- own opt-out is recorded as lifted and the flag stays: the person may then
  -- clear it from the form.
  select c.* into v_off from public.lead_consent_changes c
   where c.contact_id = v_contact and not c.to_value
   order by c.changed_at desc, c.id desc
   limit 1;
  if not exists (select 1 from public.lead_consent_changes c
                  where c.contact_id = v_contact and c.to_value and not coalesce(c.from_value, false)
                    and (v_off.id is null or (c.changed_at, c.id) > (v_off.changed_at, v_off.id)))
     or exists (select 1 from public.lead_consent_changes c
                 where c.contact_id = v_contact and c.to_value and c.origin = 'person'
                   and (v_off.id is null or (c.changed_at, c.id) > (v_off.changed_at, v_off.id))) then
    perform pg_catalog.set_config('ops.consent_origin', format('system_lift:task:%s', p_task_id), true);
    perform pg_catalog.set_config('ops.crm_write', 'system', true);
    update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
    perform pg_catalog.set_config('ops.crm_write', '', true);
    perform pg_catalog.set_config('ops.consent_origin', '', true);
    return 'kept';
  end if;

  perform pg_catalog.set_config('ops.consent_origin', format('system_lift:task:%s', p_task_id), true);
  perform pg_catalog.set_config('ops.crm_write', 'system', true);
  update public.lead_profiles set do_not_contact = false where contact_id = v_contact;
  perform pg_catalog.set_config('ops.crm_write', '', true);
  perform pg_catalog.set_config('ops.consent_origin', '', true);
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref, task_id)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opt_out_lifted', v_ref, p_task_id);
  return 'lifted';
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. The CRM form's guard. As 20261019140000; matches supabase/schemas
--    (02_functions).
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
      -- A person naming the flag on again (a merge, a direct write) does not
      -- take the contact's own opt-out over.
      select c.origin into v_origin from public.lead_consent_changes c
       where c.contact_id = old.contact_id
         and not (c.origin = 'person' and coalesce(c.from_value, false) and c.to_value)
       order by c.changed_at desc, c.id desc
       limit 1;
      if v_origin = 'system_opt_out' then
        raise exception using errcode = 'OS403',
          message = 'this contact asked to stop by message: only the contact''s own later message lifts it';
      end if;
      return new;
    end;
    $$;

-- ---------------------------------------------------------------------------
-- 3. The opt-out record: a dismissal read under the episode's lock, and
--    only a person-accepted acknowledgement brings it forward. As
--    20261019130000.
-- ---------------------------------------------------------------------------

create or replace function ops.settle_crm_opt_out_request(
  p_request ops.crm_opt_out_requests, p_conversation ops.conversations, p_actor text)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_outcome text;
begin
  -- The episode first: a person's dismissal that commits meanwhile is seen,
  -- or waits for this settlement.
  perform 1 from ops.exceptions e where e.id = p_request.exception_id for update;
  if exists (select 1 from ops.exceptions e where e.id = p_request.exception_id and e.resolution = 'dismissed') then
    update ops.crm_opt_out_requests set outcome = 'dismissed' where id = p_request.id;
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, task_id)
    values (p_request.tenant_id, p_request.company_id, p_request.conversation_id, p_conversation.channel_id,
            'opt_out_dismissed', p_request.task_id);
    return 'dismissed';
  end if;
  if p_conversation.contact_erased_at is not null then
    update ops.crm_opt_out_requests set outcome = 'erased' where id = p_request.id;
    return 'erased';
  end if;
  v_outcome := ops.crm_record_opt_out(p_request.tenant_id, p_request.company_id, p_request.conversation_id,
                                      p_conversation.channel_id, p_conversation.contact_ref, p_request.task_id);
  update ops.crm_opt_out_requests set outcome = v_outcome where id = p_request.id;
  if v_outcome in ('recorded', 'already_recorded') then
    if exists (select 1 from ops.exceptions e where e.id = p_request.exception_id and e.resolved_at is null) then
      perform ops.close_exception(p_request.exception_id, 'reconciled', p_actor);
    end if;
  end if;
  if v_outcome = 'recorded' then
    perform ops.record_event(
      p_request.tenant_id, p_request.company_id, 'lead.opted_out', 'agent-runtime', 'task', p_request.task_id,
      '{}'::jsonb, null, null, format('lead:%s:opted_out', p_request.id));
  end if;
  return v_outcome;
end
$function$;

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

  -- ADR 0026 §C: an acknowledgement of an opt-out a person accepted, once
  -- settled (but for a newer message's, whose own acknowledgement decides),
  -- makes every opt-out of the conversation up to its message due now. An
  -- automatic acknowledgement leaves the record at the window's end, so a
  -- person can still dismiss an opt-out the screen read wrongly.
  if v_out.status in ('sent', 'delivered', 'read', 'failed', 'indeterminate', 'blocked')
     and v_out.blocked_reason is distinct from 'newer_message'
     and v_out.error_class is distinct from 'newer_message'
     and exists (select 1
                   from ops.review_items ri
                   join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
                  where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                    and s.fixed_message_key = 'opt_out_ack' and ri.decision_basis = 'person') then
    perform ops.move_crm_opt_out_records(v_out.tenant_id, v_out.conversation_id, v_out.task_id);
  end if;

  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. A number's erasure holds its conversations before any CRM row. As
--    20261010120000.
-- ---------------------------------------------------------------------------

create or replace function ops.erase_contact_by_number(p_tenant_id uuid, p_number text, p_actor text)
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
  -- ADR 0026 §C: every conversation of the number, in id order, before any
  -- CRM row, the order the screening and the record job take.
  perform 1 from ops.conversations c
   where c.tenant_id = p_tenant_id and c.contact_ref = p_number
   order by c.id
     for update;
  for v_conv in
    select c.id from ops.conversations c where c.tenant_id = p_tenant_id and c.contact_ref = p_number
     order by c.id
  loop
    if ops.erase_contact_identifier(p_tenant_id, v_conv, 'erasure', p_actor) = 'erased' then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$function$;

create or replace function ops.sweep_contact_identifier_retention(p_limit integer, p_actor text)
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
  -- ADR 0026 §C: the batch's conversations, in id order, before any CRM row.
  perform 1 from ops.conversations c
   where c.id in (select r.conversation_id from ops.contact_identifier_retention r
                   where r.erased_at is null and r.due_at <= clock_timestamp()
                   order by r.due_at
                   limit p_limit)
   order by c.id
     for update;
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

-- ---------------------------------------------------------------------------
-- 5. A takeover is recorded whoever held the conversation. As
--    20261011120000.
-- ---------------------------------------------------------------------------

create or replace function ops.take_over_conversation(p_tenant_id uuid, p_conversation_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv  ops.conversations;
  v_state ops.conversation_states;
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
  -- ADR 0026 §C: a person who takes over a conversation held for another
  -- reason (an opt-out, a request for a person) is recorded as holding it, so
  -- the contact's later message never gives it back to the agent.
  select s.* into v_state from ops.conversation_states s where s.conversation_id = v_conv.id for update;
  if v_state.holder = 'person' and v_state.holder_reason is distinct from 'operator' then
    update ops.conversation_states
       set holder_reason = 'operator', holder_changed_at = now(), holder_changed_by = p_actor
     where conversation_id = v_conv.id;
    insert into ops.conversation_transitions (
      tenant_id, company_id, conversation_id, dimension, from_value, to_value, reason, actor)
    values (v_conv.tenant_id, v_conv.company_id, v_conv.id, 'holder', 'person', 'person', 'operator', p_actor);
    return jsonb_build_object('state', 'taken_over');
  end if;
  return jsonb_build_object('state',
    case when ops.move_conversation_state(v_conv.id, 'holder', 'person', 'operator', p_actor)
         then 'taken_over' else 'already_held' end);
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. The CRM copy's retention. As 20261019150000.
-- ---------------------------------------------------------------------------

create or replace function ops.crm_delete_unedited_lead(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_conversation_id uuid,
  p_channel_id      uuid,
  p_contact_ref     text)
returns text
language plpgsql
volatile
security invoker
set search_path to ''
set lock_timeout to '2s'
as $function$
declare
  v_contact bigint := substring(p_contact_ref from '^crm:contact:([0-9]{1,19})$')::bigint;
  v_keep    boolean := false;
begin
  if v_contact is null or p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm)
     or not exists (select 1 from ops.crm_contact_acts a
                     where a.tenant_id = p_tenant_id and a.act = 'created' and a.crm_contact_ref = p_contact_ref) then
    return 'not_created';
  end if;

  -- Hold the contact, its lead profile and its attributions before any
  -- check: a person's note, task or attribution then waits for this
  -- transaction and is seen (or fails its key), and so does a person's edit
  -- of the profile or of an attribution, which never locks the contact.
  perform 1 from public.contacts c where c.id = v_contact for update;
  if not found then
    return 'absent';
  end if;
  perform 1 from public.lead_profiles lp where lp.contact_id = v_contact for update;
  perform 1 from public.acquisition_attributions aa where aa.contact_id = v_contact for update;

  -- Each check its own statement, so each sees what committed while it waited.
  if exists (select 1 from public.crm_contact_edits e where e.contact_id = v_contact) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.contact_notes n where n.contact_id = v_contact) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.tasks t where t.contact_id = v_contact) then
    v_keep := true;
  end if;
  -- A person's consent decision, or an opt-out in force (one the contact's
  -- own later message lifted no longer keeps the number).
  if not v_keep and (exists (select 1 from public.lead_consent_changes c
                              where c.contact_id = v_contact and c.origin = 'person')
                     or coalesce((select lp.do_not_contact from public.lead_profiles lp
                                   where lp.contact_id = v_contact), false)) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.deals d where d.contact_ids @> array[v_contact]) then
    v_keep := true;
  end if;
  if not v_keep and (
       exists (select 1
                 from ops.inbound_messages m
                 join ops.conversations c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
                where m.tenant_id = p_tenant_id and m.crm_contact_ref = p_contact_ref
                  and m.conversation_id <> p_conversation_id and c.contact_erased_at is null)
       or exists (select 1
                    from ops.crm_contact_acts a
                    join ops.conversations c on c.tenant_id = a.tenant_id and c.id = a.conversation_id
                   where a.tenant_id = p_tenant_id and a.act = 'created' and a.crm_contact_ref = p_contact_ref
                     and a.conversation_id <> p_conversation_id and c.contact_erased_at is null)) then
    v_keep := true;
  end if;

  if not v_keep then
    delete from public.contacts where id = v_contact;
  end if;
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id,
          case when v_keep then 'kept' else 'deleted' end, p_contact_ref);
  return case when v_keep then 'kept' else 'deleted' end;
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. The end state. Every function above was replaced in place, so it keeps
--    its grants; this checks that each carries its correction and that none
--    became reachable.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad text;
begin
  select pg_catalog.string_agg(f.sig, ', ') into v_bad
    from (values
      ('ops.crm_record_opt_out(uuid, uuid, uuid, uuid, text, uuid)', 'errcode = ''40001'''),
      ('ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)', 'v_off.id is null'),
      ('ops.settle_crm_opt_out_request(ops.crm_opt_out_requests, ops.conversations, text)',
       'e.id = p_request.exception_id for update'),
      ('ops.sync_send_exceptions(uuid, uuid, text)', 'ri.decision_basis = ''person'''),
      ('ops.erase_contact_by_number(uuid, text, text)', 'order by c.id'),
      ('ops.sweep_contact_identifier_retention(integer, text)', 'order by c.id'),
      ('ops.take_over_conversation(uuid, uuid, text)', 'holder_reason is distinct from ''operator'''),
      ('ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)', 'c.origin = ''person'')'),
      ('public.refuse_system_opt_out_clear()', 'coalesce(c.from_value, false) and c.to_value')) as f (sig, marker)
   where pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                             where p.oid = f.sig::pg_catalog.regprocedure), f.marker) = 0;
  if v_bad is not null then
    raise exception 'a review correction is missing from: %', v_bad;
  end if;

  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array[
           'ops.crm_record_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure,
           'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure,
           'ops.settle_crm_opt_out_request(ops.crm_opt_out_requests, ops.conversations, text)'::pg_catalog.regprocedure,
           'ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)'::pg_catalog.regprocedure,
           'public.refuse_system_opt_out_clear()'::pg_catalog.regprocedure])
     and (p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a corrected CRM function became reachable: %', v_bad;
  end if;
end
$end_state$;
