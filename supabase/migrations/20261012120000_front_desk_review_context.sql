-- ADR 0023 §L (owner decision, 2026-10-05): the review shows what the agent
-- read and what would be sent, and a reply the contact's newer message made
-- stale is never sent.
--
-- 1. WHAT THE REVIEW SHOWS. get_review gains `conversation`. For a
--    browser-decidable review (ops.cos_review_decidable: lead_triage, a task
--    whose data class is synthetic or test, a synthetic or test-channel
--    origin) it carries:
--      - the front desk's screening of the message, when one exists: its class,
--        its disposition, the fixed text's key, and the SCREENED text, which is
--        exactly what a model and Jev read (ops.inbound_screenings.model_input).
--        Never the task's description: the raw message stays in the raw store.
--      - the reply draft the send act would carry (the review's
--        response_draft), until the task's content is redacted.
--      - whether the contact wrote again after this message.
--    Any other review reads `unavailable`. This amends SI-52 and SI-56: a
--    reviewer must see what they accept, which the 2026-10-05 staging send
--    showed the blind acceptance could not give.
--
-- 2. A STALE REPLY IS NEVER SENT. ops.cos_review_superseded is true when the
--    review's message has a newer inbound message in its conversation (by the
--    provider's timestamp, the admission instant breaking a tie). The send
--    request refuses it (newer_message) and the last gate before the provider
--    call blocks it on the record, so a message that arrives between the two
--    still stops the call. The browser shows the same predicate.
--
-- No exposed function changes: company_os_api.get_review already reaches
-- ops.read_review_detail through its gate, so this is not an OD-8a migration.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The one predicate: did the contact write again after this message?
-- ---------------------------------------------------------------------------

create function ops.cos_review_superseded(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1
      from ops.inbound_messages mine
      join ops.inbound_messages later
        on later.tenant_id = mine.tenant_id
       and later.conversation_id = mine.conversation_id
       and later.id <> mine.id
       and (later.received_at > mine.received_at
            or (later.received_at = mine.received_at and later.created_at > mine.created_at))
     where mine.tenant_id = p_tenant_id
       and mine.task_id = p_item.task_id
       and mine.conversation_id is not null);
$$;

comment on function ops.cos_review_superseded(pg_catalog.uuid, ops.review_items) is
  'ADR 0023 §L: true when the contact wrote again after the review''s message, in the same conversation. The send refuses such a review (newer_message) and the review page says so.';

-- ---------------------------------------------------------------------------
-- 2. What the review shows.
-- ---------------------------------------------------------------------------

create function ops.cos_review_conversation(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_s ops.inbound_screenings;
begin
  -- Browser-decidable only: lead_triage, a task of synthetic or test data, a
  -- synthetic or test-channel origin (Q8).
  if not ops.cos_review_decidable(p_tenant_id, p_item) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  -- The screening of the run the review came from: the screened text only.
  select s.* into v_s from ops.inbound_screenings s
   where s.tenant_id = p_tenant_id and s.agent_run_id = p_item.agent_run_id;
  return pg_catalog.jsonb_build_object(
    'status', 'available',
    'screening', case when v_s.id is null then null else pg_catalog.jsonb_build_object(
      'messageClass', v_s.message_class,
      'disposition', v_s.disposition,
      'fixedMessageKey', v_s.fixed_message_key,
      'screenedMessage', v_s.model_input) end,
    'replyDraft', case when p_item.content_redacted_at is null
                       then p_item.proposed ->> 'response_draft' end,
    'contentRedacted', p_item.content_redacted_at is not null,
    'newerMessage', ops.cos_review_superseded(p_tenant_id, p_item));
end
$$;

comment on function ops.cos_review_conversation(pg_catalog.uuid, ops.review_items) is
  'ADR 0023 §L: get_review''s conversation block, for a browser-decidable review of synthetic or test data only: the screening (class, disposition, fixed key, the screened text a model read; never the raw description), the reply draft the send would carry, and whether the contact wrote again.';

create or replace function ops.read_review_detail(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()))
    || ops.cos_review_summary(p_tenant_id, v_item)
    || pg_catalog.jsonb_build_object(
      'decisionNote', v_item.decision_note,
      'allowedDecisions', case when v_item.status <> 'pending' or not ops.cos_review_decidable(p_tenant_id, v_item)
                                 then '[]'::pg_catalog.jsonb
                               when v_item.do_not_contact then '["rejected", "needs_edit"]'::pg_catalog.jsonb
                               else '["accepted", "rejected", "needs_edit"]'::pg_catalog.jsonb end,
      -- Phase 2D.1: advisory only. Nothing about it changes allowedDecisions.
      'shadowDecision', ops.cos_review_shadow_decision(p_tenant_id, v_item),
      -- ADR 0022: advisory only, likewise.
      'structuredDecisions', ops.cos_review_structured_decisions(p_tenant_id, v_item),
      -- ADR 0023 §L: what the agent read and what the send would carry.
      'conversation', ops.cos_review_conversation(p_tenant_id, v_item));
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The send refuses a stale reply, at the request and at the last gate.
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
-- 4. Access: backend only, like every other projection.
-- ---------------------------------------------------------------------------

revoke all on function
  ops.cos_review_superseded(pg_catalog.uuid, ops.review_items),
  ops.cos_review_conversation(pg_catalog.uuid, ops.review_items)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 5. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
begin
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p
    cross join (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                       ('ops_operator_api')) as r (rolname)
   where p.pronamespace = 'ops'::pg_catalog.regnamespace
     and p.proname in ('cos_review_superseded', 'cos_review_conversation')
     and ((r.rolname = 'public' and exists (
            select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
          or (r.rolname <> 'public' and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a role can execute a review conversation projection: %', v_bad;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where p.pronamespace = 'ops'::pg_catalog.regnamespace
         and p.proname in ('cos_review_superseded', 'cos_review_conversation')
         and p.prosecdef = false and p.provolatile = 's'
         and p.proconfig = array['search_path=""']) <> 2 then
    raise exception 'the review conversation projections are not two invoker, stable, pinned functions';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.read_review_detail(pg_catalog.uuid, pg_catalog.uuid)'::pg_catalog.regprocedure),
                        'cos_review_conversation') = 0 then
    raise exception 'get_review does not carry the conversation';
  end if;
  -- The projection reads the screened text, never a task's description.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.cos_review_conversation(pg_catalog.uuid, ops.review_items)'::pg_catalog.regprocedure),
                        'description') > 0 then
    raise exception 'the review conversation projection reads a description';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.request_outbound_send(uuid, uuid, text, text)'::pg_catalog.regprocedure),
                        'cos_review_superseded') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_outbound_send(uuid, uuid)'::pg_catalog.regprocedure),
                           'cos_review_superseded') = 0 then
    raise exception 'a send path does not refuse a stale reply';
  end if;
end
$end_state$;
