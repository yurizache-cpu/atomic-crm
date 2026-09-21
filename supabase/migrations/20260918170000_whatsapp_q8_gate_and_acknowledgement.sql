-- Phase 2B, focused pre-push review: the BASELINE Q8 real-data gate is CLOSED
-- at the channel, and no inbound message is acknowledged unless it became work
-- or a durable, content-free fact.
--
-- THE DEFECTS (docs/PHASE_2B_REPORT.md §17), each measured in a rolled-back
-- transaction on 20260918150000:
--   P1  A production channel could be made ACTIVE: by the configure service, by
--       an owner INSERT, by flipping an active test channel's mode, by
--       re-activating an inactive one. A message to it was recorded as a
--       content-free `communication.inbound_held` fact and the gateway answered
--       Meta 200, so the message was acknowledged, never delivered again, and
--       stored nowhere: safe for Q8, and a permanent, silent loss of a real
--       person's message.
--   P1  An unknown or inactive target (OS404), an inactive company, department
--       or agent (OS409 from the admission), a body over the admission's 4000
--       characters (OS400), and a gateway clock ahead of the database's (OS400)
--       were all answered 200 with nothing durable.
--
-- THE FIX.
--   1. THE REAL-DATA GATE IS CLOSED, AND HAS NO ENABLED VALUE. A production
--      channel can exist only INACTIVE: CHECK (mode = 'test' or not active)
--      holds for every row and every role, the owner's own statements included,
--      and ops.configure_whatsapp_channel refuses the combination with a typed
--      OS403 first. No flag, setting, table or environment variable opens it.
--      Opening it is a reviewed migration, after the owner decides BASELINE Q8,
--      the lawful basis for replying and how consent is represented.
--   2. ops.receive_whatsapp_message answers `unrouted` (it no longer raises)
--      unless the target is an ACTIVE TEST channel whose company, department and
--      agent are active. The gateway answers `unrouted` with a non-2xx, so the
--      message is NOT acknowledged: Meta delivers it again (for up to 7 days,
--      per its documentation), and a paused test channel or unit recovers it
--      when re-activated. Nothing about an unrouted message is stored. The
--      `held` answer is gone.
--   3. A routed message that cannot become work (no sender number, content that
--      is not text, an empty body, a body over 4000 characters, or a refusal by
--      the admission itself) is acknowledged only with a durable, content-free
--      `communication.inbound_refused` fact in the channel's tenant: the
--      channel, the conversation when there is a sender number, and a reason.
--      Once per message id.
--   4. received_at is clamped to the database's clock, so gateway clock skew
--      cannot refuse a message.
--   5. ops.whatsapp_send_eligibility names the Q8 gate before `channel_inactive`,
--      which the CHECK would otherwise hide it behind.
--
-- Forward only. Nothing here grants anything: CREATE OR REPLACE keeps each
-- function's owner and ACL, and the end-state block below proves the surface.

-- ---------------------------------------------------------------------------
-- 1. The closed real-data gate.
-- ---------------------------------------------------------------------------

-- No deployment has run 20260918150000 (it was never pushed), but a local
-- database may hold an active production channel. It is deactivated, not
-- deleted: the target stays reserved to its tenant.
update ops.communication_channels
   set active = false
 where mode <> 'test' and active;

alter table ops.communication_channels
  add constraint communication_channels_q8_real_data_gate check (mode = 'test' or not active);

comment on constraint communication_channels_q8_real_data_gate on ops.communication_channels is
  'BASELINE Q8 real-data gate: CLOSED, with no enabled value. A production channel can exist only inactive, so no real number can be a live target. Opening it is a reviewed migration after the owner decides Q8, the lawful basis for replying and the consent representation.';

comment on table ops.communication_channels is
  'The trusted mapping from a provider target (a WhatsApp phone number id) to one tenant, company and triage agent. Owner-configured; a webhook payload selects a tenant only through a row here. Only an ACTIVE TEST channel is a live target. A production channel can exist only inactive while the BASELINE Q8 real-data gate is closed (communication_channels_q8_real_data_gate).';

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
  v_active   boolean := coalesce(p_active, true);
begin
  if p_tenant_id is null or p_company_id is null or p_agent_id is null then
    raise exception using errcode = 'OS401', message = 'ops.configure_whatsapp_channel: no scope';
  end if;
  -- The closed real-data gate, said plainly before the CHECK would say it.
  if p_mode = 'production' and v_active then
    raise exception using errcode = 'OS403',
      message = 'ops.configure_whatsapp_channel: the BASELINE Q8 real-data gate is closed; a production channel can only be configured inactive';
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
           configured_by = p_actor, active = v_active
     where id = v_existing.id;
    v_id := v_existing.id;
  else
    insert into ops.communication_channels (
      tenant_id, company_id, agent_id, provider, provider_target, mode, label, configured_by, active)
    values (p_tenant_id, p_company_id, p_agent_id, 'meta_whatsapp', p_provider_target, p_mode, p_label,
            p_actor, v_active)
    returning id into v_id;
  end if;

  perform ops.record_event(
    p_tenant_id, p_company_id, 'communication.channel_configured', 'operator-cli', 'company', p_company_id,
    jsonb_build_object('channel_id', v_id, 'mode', p_mode, 'active', v_active));
  return v_id;
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. The gateway's message function: admitted, refused on the record, or not
--    acknowledged at all.
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
  v_channel     ops.communication_channels;
  v_crm         jsonb;
  v_dnc         boolean;
  v_conv        uuid;
  v_received_at timestamptz;
  v_reason      text;
  v_result      jsonb;
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

  if p_from is null then
    v_reason := 'no_sender_number';
  else
    v_crm := ops.crm_contact_by_phone(v_channel.tenant_id, p_from);
    -- Only a single CRM contact whose opt-out flag is false is eligible at
    -- admission; every other answer is do-not-contact.
    v_dnc := not (v_crm ->> 'state' = 'found'
                  and jsonb_typeof(v_crm -> 'do_not_contact') = 'boolean'
                  and not (v_crm ->> 'do_not_contact')::boolean);

    insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
    values (v_channel.tenant_id, v_channel.company_id, v_channel.id, p_from, v_received_at)
    on conflict (tenant_id, channel_id, contact_ref) do update
      set last_inbound_at = greatest(ops.conversations.last_inbound_at, excluded.last_inbound_at)
    returning id into v_conv;

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
        return v_result || jsonb_build_object('state', 'admitted', 'conversation_id', v_conv);
      exception when sqlstate 'OS400' or sqlstate 'OS409' then
        -- The admission refused it (a reused message id carrying another
        -- message, or a unit paused since the check above): nothing it began
        -- survives, and the refusal is recorded below.
        v_reason := 'admission_refused';
      end;
    end if;
  end if;

  -- Acknowledged only with a durable record of it: the channel, the
  -- conversation when there is a sender number, and why. Never the body, the
  -- sender or the message id. Once per message id.
  perform ops.record_event(
    v_channel.tenant_id, v_channel.company_id, 'communication.inbound_refused', 'whatsapp-gateway',
    'company', v_channel.company_id,
    jsonb_strip_nulls(jsonb_build_object('channel_id', v_channel.id, 'conversation_id', v_conv, 'reason', v_reason)),
    null, null,
    format('whatsapp:refused:%s', encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex')));
  return jsonb_strip_nulls(jsonb_build_object('state', 'refused', 'reason', v_reason, 'conversation_id', v_conv));
end
$function$;

comment on function ops.receive_whatsapp_message(text, text, text, text, timestamptz) is
  'The webhook gateway''s one way to hand over a Meta message (ops_gateway only). Answers admitted (one task, one run), refused (a durable content-free fact), or unrouted (no live test channel, or a paused unit: the gateway does not acknowledge it, and nothing is stored). The provider target alone selects the tenant.';

-- ---------------------------------------------------------------------------
-- 3. The send eligibility rule names the Q8 gate first.
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
    when v_channel.mode <> 'test' then 'q8_production_channel'
    when not v_channel.active then 'channel_inactive'
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
  'Whether a reply may be sent on a conversation NOW, in Phase 2B''s test-only scope: a test channel (BASELINE Q8), active, no covering execution stop, exactly one CRM contact whose opt-out flag is false (the CRM''s default; no affirmative consent is recorded anywhere), and a contact message within Meta''s 24-hour customer-service window. These are preconditions, not a lawful basis. Fail closed on every unknown.';

-- ---------------------------------------------------------------------------
-- 4. Assert the end state.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- The gate exists, is validated, and no row is past it.
  if not exists (
    select 1 from pg_constraint
     where conname = 'communication_channels_q8_real_data_gate'
       and conrelid = 'ops.communication_channels'::regclass
       and contype = 'c' and convalidated) then
    raise exception 'the BASELINE Q8 real-data gate constraint is missing or not validated';
  end if;
  if exists (select 1 from ops.communication_channels where active and mode <> 'test') then
    raise exception 'an active production channel exists while the BASELINE Q8 real-data gate is closed';
  end if;

  -- The gateway surface is unchanged: exactly two DEFINER functions, pinned.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and has_function_privilege('ops_gateway', p.oid, 'EXECUTE')
     and p.proname not in ('receive_whatsapp_message', 'receive_whatsapp_status');
  if v_bad is not null then
    raise exception 'ops_gateway can execute more than its two functions: %', v_bad;
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker']) as r (rolname)
   where has_function_privilege(r.rolname, 'ops.receive_whatsapp_message(text, text, text, text, timestamptz)', 'EXECUTE');
  if v_bad is not null then
    raise exception 'ops.receive_whatsapp_message is executable by: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc
     where oid = 'ops.receive_whatsapp_message(text, text, text, text, timestamptz)'::regprocedure
       and prosecdef and coalesce(proconfig @> array['search_path=""'], false)
       and prosrc not like '%inbound_held%') then
    raise exception 'ops.receive_whatsapp_message is not the pinned DEFINER, or still holds content';
  end if;
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('configure_whatsapp_channel', 'whatsapp_send_eligibility')
     and (p.prosecdef or not coalesce(p.proconfig @> array['search_path=""'], false)
          or has_function_privilege('ops_gateway', p.oid, 'EXECUTE')
          or has_function_privilege('ops_worker', p.oid, 'EXECUTE')
          or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'a redefined owner service is a DEFINER, floats its search path, or is reachable: %', v_bad;
  end if;
end
$$;
