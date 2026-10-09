-- ADR 0026 §B: the reply's last gate reads the kill switch again,
-- immediately before the call (the automated review of PR #35, P1).
--
-- ops.begin_reply_send (TX2a) reads the stop under the kill switch's lock and
-- commits the send as 'sending'; ops.confirm_reply_send (TX2b) then takes the
-- conversation, waiting for it up to five seconds, and the call follows. A
-- stop tripped in between did not hold the send. The last gate now reads the
-- stop again after it holds the conversation and the send: a stop puts the
-- send back to 'authorized', never called, and the job back on the queue,
-- where the stop holds it at its lease until a person clears it.
--
-- The lock is a session lock, taken for the read alone and given back before
-- the call (also when the read fails), not the transaction lock begin takes:
-- held through the call, it would make a stop's trip wait for a call in flight
-- for up to its bound.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- As 20261018120000, with the stop read again before the call.
create or replace function ops.confirm_reply_send()
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
  v_stop   uuid;
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
  -- The kill switch, read again immediately before the call: a stop committed
  -- since begin holds the send, never called, and gives the job back, which
  -- the stop then holds at its lease. The lock is a session lock taken for the
  -- read alone and given back before the call, on every path, so a stop's
  -- trip never waits for a call in flight.
  begin
    perform pg_catalog.pg_advisory_lock_shared(ops.execution_stop_lock_key());
    v_stop := ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind);
    perform pg_catalog.pg_advisory_unlock_shared(ops.execution_stop_lock_key());
  exception
    when query_canceled then
      perform pg_catalog.pg_advisory_unlock_shared(ops.execution_stop_lock_key());
      raise;
    when others then
      perform pg_catalog.pg_advisory_unlock_shared(ops.execution_stop_lock_key());
      raise;
  end;
  if v_stop is not null then
    return ops.unbegin_reply_send(v_out, v_job, 'held by an execution stop');
  end if;
  return jsonb_build_object('action', 'send', 'outboundMessageId', v_out.id);
end
$function$;

do $end_state$
declare
  v_src text := (select p.prosrc from pg_catalog.pg_proc p
                  where p.oid = 'ops.confirm_reply_send()'::pg_catalog.regprocedure);
begin
  -- The last gate holds the conversation, reads the stop under a session lock
  -- it gives back before the call, and never holds the kill switch's
  -- transaction lock or reads the send's eligibility.
  if pg_catalog.strpos(v_src, 'for no key update') = 0
     or pg_catalog.strpos(v_src, 'lock_not_available') = 0
     or pg_catalog.strpos(v_src, 'ops.job_covering_stop') = 0
     or (select count(*) from pg_catalog.regexp_matches(v_src, 'pg_advisory_unlock_shared', 'g'))
        <> 3
     or v_src ~ '(pg_advisory_xact_lock|whatsapp_send_eligibility|reply_send_eligibility)' then
    raise exception 'the reply''s last gate does not read the stop under a lock it gives back before the call';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.confirm_reply_send()'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""'])
     or not pg_catalog.has_function_privilege('ops_worker', 'ops.confirm_reply_send()', 'EXECUTE')
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_gateway'),
                                      ('ops_operator_api')) as r (rolname)
                 where pg_catalog.has_function_privilege(r.rolname, 'ops.confirm_reply_send()', 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'ops.confirm_reply_send()'::pg_catalog.regprocedure and a.grantee = 0) then
    raise exception 'the reply''s last gate is not a pinned DEFINER the worker alone executes';
  end if;
end
$end_state$;
