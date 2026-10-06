-- ADR 0023 §L, closed (the automated review of PR #29, 2026-10-05): a reply the
-- contact's newer message made stale is never sent, whatever that message was
-- and whenever it arrived.
--
-- 1. A REFUSED MESSAGE COUNTS. A follow-up the database refuses on the record
--    (an image, an empty or an oversized text) creates no ops.inbound_messages
--    row, so the predicate of 20261012120000 never saw it: the contact could
--    send the photo of a receipt and the old draft would still go. The
--    predicate now also reads what every message leaves, refused or admitted:
--      - the conversation's clock (last_inbound_at), which every message with
--        a sender advances by the provider's timestamp;
--      - the order in which the database recorded them: a conversation's
--        messages are recorded one at a time (each waits on the conversation's
--        row at the upsert of ops.receive_whatsapp_message), so the insertion
--        order of their facts (ops.events.seq) is their arrival order. An
--        admitted message or a refusal recorded after the reviewed message's
--        admission supersedes it, whatever timestamp the provider gave it.
--    Two messages the provider delivers out of order therefore hold both
--    replies for a person (fail closed); a refusal recorded before the
--    reviewed message, with an older timestamp, does not.
--
-- 2. NOTHING ARRIVES BETWEEN THE LAST CHECK AND THE CALL. begin_outbound_send
--    commits `sending` before the provider call, as at-most-once requires, so
--    a message committed after its check went unseen. ops.confirm_outbound_send
--    is the last gate now: it locks the conversation's row, reads the
--    predicate again, and the caller makes the one call and settles it in that
--    same transaction (engine/domain/outboundSend.ts). While it is open, the
--    contact's next message waits at its admission, so the reply that leaves
--    was the latest when it left. A send stopped here was never called: it
--    settles `failed` with the class `newer_message`, through
--    ops.settle_outbound_send, and nothing about the state machine changes.
--
-- No exposed function changes and no grant is added: this is not an OD-8a
-- migration.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The predicate: did the contact write again after this message?
-- ---------------------------------------------------------------------------

create or replace function ops.cos_review_superseded(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select exists (
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
              and e.payload ->> 'conversation_id' = mine.conversation_id::pg_catalog.text)));
$$;

comment on function ops.cos_review_superseded(pg_catalog.uuid, ops.review_items) is
  'ADR 0023 §L: true when the contact wrote again after the review''s message, in the same conversation: a newer message by the provider''s clock, or any message, admitted or refused, the database recorded after it. The send refuses such a review (newer_message) and the review page says so.';

-- ---------------------------------------------------------------------------
-- 2. The last gate, held through the call.
-- ---------------------------------------------------------------------------

create function ops.confirm_outbound_send(p_tenant_id uuid, p_outbound_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out ops.outbound_messages;
begin
  select * into v_out from ops.outbound_messages
   where id = p_outbound_id and tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.confirm_outbound_send: send not found in this tenant';
  end if;
  -- The conversation first, then the send. Until this transaction ends, the
  -- contact's next message waits at its admission (the conversation upsert of
  -- ops.receive_whatsapp_message), and the caller makes the one call and
  -- settles it inside this transaction.
  perform 1 from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = v_out.conversation_id
     for no key update;
  select * into v_out from ops.outbound_messages
   where id = p_outbound_id and tenant_id = p_tenant_id
     for update;
  if v_out.status <> 'sending' then
    -- A person recorded it, or another attempt settled it: no call.
    return jsonb_build_object('state', v_out.status);
  end if;
  if exists (select 1 from ops.review_items v
              where v.tenant_id = p_tenant_id and v.id = v_out.review_item_id
                and ops.cos_review_superseded(p_tenant_id, v)) then
    -- Never called: failed, by the state machine's own definition.
    perform ops.settle_outbound_send(p_tenant_id, v_out.id, 'failed', null, null, 'newer_message');
    return jsonb_build_object('state', 'failed', 'reason', 'newer_message');
  end if;
  return jsonb_build_object('state', 'send');
end
$function$;

comment on function ops.confirm_outbound_send(uuid, uuid) is
  'ADR 0023 §L: the last gate before the provider call. Locks the send''s conversation, so the contact''s next message waits at its admission, and reads the stale-reply predicate again; the caller makes the one call and settles it in the same transaction. A send it stops was never called: failed, newer_message.';

-- ---------------------------------------------------------------------------
-- 3. Access: owner only, like every other send service.
-- ---------------------------------------------------------------------------

revoke all on function ops.confirm_outbound_send(uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 4. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  v_src pg_catalog.text;
begin
  select pg_catalog.string_agg(r.rolname, ', ') into v_bad
    from pg_catalog.pg_proc p
    cross join (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                       ('ops_operator_api')) as r (rolname)
   where p.oid = 'ops.confirm_outbound_send(uuid, uuid)'::pg_catalog.regprocedure
     and ((r.rolname = 'public' and exists (
            select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
          or (r.rolname <> 'public' and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a role can execute the last send gate: %', v_bad;
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.confirm_outbound_send(uuid, uuid)'::pg_catalog.regprocedure
                    and p.prosecdef = false and p.provolatile = 'v'
                    and p.proconfig = array['search_path=""']) then
    raise exception 'the last send gate is not an invoker, volatile, pinned function';
  end if;
  select p.prosrc into v_src from pg_catalog.pg_proc p
   where p.oid = 'ops.confirm_outbound_send(uuid, uuid)'::pg_catalog.regprocedure;
  if pg_catalog.strpos(v_src, 'for no key update') = 0 or pg_catalog.strpos(v_src, 'cos_review_superseded') = 0 then
    raise exception 'the last send gate does not hold the conversation and read the predicate';
  end if;
  select p.prosrc into v_src from pg_catalog.pg_proc p
   where p.oid = 'ops.cos_review_superseded(pg_catalog.uuid, ops.review_items)'::pg_catalog.regprocedure;
  if pg_catalog.strpos(v_src, 'communication.inbound_refused') = 0 or pg_catalog.strpos(v_src, 'last_inbound_at') = 0 then
    raise exception 'the stale-reply predicate does not count a refused message';
  end if;
end
$end_state$;
