-- ADR 0026 §D, PR #37 review (Codex, P1): the owner's notification checks
-- again, at its send, that the target's number is still nobody's lead.
--
-- ops.record_owner_notification_target refuses a number a conversation or a
-- CRM contact holds (SI-86), but only when the owner records the target. A
-- contact created, edited or imported later with that number (exactly or by
-- its last eight digits), or a conversation it opens, made the send reach a
-- lead's number. ops.begin_owner_notification now applies the recording's own
-- test before every send and blocks the notification (target_held) when it
-- fails; the registered device stays exempt, as at the recording.
--
-- One check added to the notification's block reasons; one helper; one
-- function replaced in place from its latest definition (20261020120000), its
-- grants kept.

alter table ops.owner_notifications drop constraint owner_notifications_block_shape;
alter table ops.owner_notifications add constraint owner_notifications_block_shape check (
      (status = 'blocked') = (block_reason is not null)
  and (block_reason is null
       or block_reason in ('no_target', 'target_changed', 'channel_not_live', 'job_failed', 'target_held')));

-- Whether a conversation of the tenant or a CRM contact holds the target's
-- number, as ops.record_owner_notification_target tests it: a conversation on
-- a channel where the number is not a registered sender; a CRM contact that
-- carries it exactly or by its last eight digits, unless the number is a
-- sender the owner registered on the target's channel. A retired target (its
-- number erased) holds nothing.
create function ops.owner_target_number_held(p_target ops.owner_notification_targets)
returns boolean
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_form text;
  v_crm  jsonb;
begin
  if p_target.digits is null then
    return false;
  end if;
  foreach v_form in array ops.owner_number_forms(p_target.digits) loop
    if exists (select 1 from ops.conversations c
                where c.tenant_id = p_target.tenant_id and c.contact_ref = v_form
                  and not ops.registered_test_sender(p_target.tenant_id, c.channel_id, v_form)) then
      return true;
    end if;
    if not ops.registered_test_sender(p_target.tenant_id, p_target.channel_id, v_form) then
      v_crm := ops.crm_contact_by_phone(p_target.tenant_id, v_form);
      if v_crm ->> 'state' in ('found', 'ambiguous')
         or (v_crm ->> 'state' is distinct from 'unavailable' and ops.crm_phone_suffix_match(v_form)) then
        return true;
      end if;
    end if;
  end loop;
  return false;
end
$function$;

revoke all on function ops.owner_target_number_held(ops.owner_notification_targets)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- As 20261020120000, with the check before the send waits or calls.
create or replace function ops.begin_owner_notification(p_transport text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job     ops.jobs := ops.leased_job();
  v_own     ops.owner_notifications;
  v_target  ops.owner_notification_targets;
  v_channel ops.communication_channels;
  v_until   timestamptz;
  v_batch   uuid[];
  v_convs   uuid[];
  v_kind    text;
  v_name    text;
  v_params  text[];
begin
  if v_job.kind <> 'owner_notification.send' then
    raise exception using errcode = '42501', message = 'ops.begin_owner_notification: the leased job is not an owner notification';
  end if;
  -- The tenant's sends one at a time, and this lock before any row.
  perform pg_advisory_xact_lock(ops.owner_notification_lock_key(v_job.tenant_id));
  select n.* into v_own from ops.owner_notifications n
   where n.tenant_id = v_job.tenant_id and n.job_id = v_job.id
     for update;
  if not found then
    raise exception using errcode = '42501', message = 'ops.begin_owner_notification: no notification is bound to the leased job';
  end if;

  if v_own.status = 'sending' then
    if v_own.job_attempt is not distinct from v_job.attempts then
      raise exception using errcode = '42501', message = 'ops.begin_owner_notification: this attempt already began the send; a send is never made twice';
    end if;
    -- An earlier attempt began the call and never settled it: it may have
    -- reached the owner. Never called again.
    update ops.owner_notifications
       set status = 'indeterminate', error_class = 'execution_interrupted'
     where id = v_own.id;
    return jsonb_build_object('action', 'settled', 'status', 'indeterminate', 'ownerNotificationId', v_own.id);
  end if;
  if v_own.status <> 'pending' then
    return jsonb_build_object('action', 'settled', 'status', v_own.status, 'ownerNotificationId', v_own.id);
  end if;

  -- The kill switch, for every scope of the unit whose channel sends it (SI-37).
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind) is not null then
    return jsonb_build_object('action', 'stopped', 'ownerNotificationId', v_own.id);
  end if;

  if now() >= v_own.expires_at then
    update ops.owner_notifications set status = 'expired' where id = v_own.id;
    return jsonb_build_object('action', 'settled', 'status', 'expired', 'ownerNotificationId', v_own.id);
  end if;
  -- Sent only to the target it was recorded for, from its channel.
  select t.* into v_target from ops.owner_notification_targets t
   where t.tenant_id = v_own.tenant_id and t.id = v_own.target_id and t.retired_at is null;
  if not found then
    return ops.block_owner_notification(v_own,
      case when exists (select 1 from ops.owner_notification_targets t
                         where t.tenant_id = v_own.tenant_id and t.retired_at is null)
           then 'target_changed' else 'no_target' end);
  end if;
  select c.* into v_channel from ops.communication_channels c
   where c.tenant_id = v_target.tenant_id and c.id = v_target.channel_id;
  if not (v_channel.active and v_channel.mode = 'test') then
    return ops.block_owner_notification(v_own, 'channel_not_live');
  end if;
  -- Still nobody's lead (SI-86): a conversation or a CRM contact that came to
  -- hold the target's number after it was recorded blocks the send.
  if ops.owner_target_number_held(v_target) then
    return ops.block_owner_notification(v_own, 'target_held');
  end if;

  -- It waits: quiet hours, then the caps, then a worker with a transport.
  if ops.owner_notification_quiet(v_target, now()) then
    perform ops.release_owner_notification_job(v_job, ops.owner_notification_quiet_end(v_target, now()),
                                               'waiting for the end of the quiet hours');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end if;
  v_until := ops.owner_notification_cap_frees_at(v_own.tenant_id, v_target);
  if v_until is not null then
    perform ops.release_owner_notification_job(v_job, ops.owner_notification_due_at(v_target, v_until),
                                               'waiting for the notification cap');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end if;
  if p_transport is null or p_transport not in ('meta', 'fake') then
    perform ops.release_owner_notification_job(v_job, least(now() + interval '30 seconds', v_own.expires_at),
                                               'waiting for a worker with a reply transport');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end if;

  -- The batch: this intent and every due one of the same target, in the order
  -- they were recorded, then their episodes, so that a release committing
  -- meanwhile is seen.
  select pg_catalog.array_agg(b.id order by b.recorded_at, b.id) into v_batch
    from (select n.id, n.recorded_at from ops.owner_notifications n
           where n.tenant_id = v_own.tenant_id and n.target_id = v_own.target_id and n.status = 'pending'
             and (n.id = v_own.id
                  or (n.due_at <= now()
                      and ops.job_covering_stop(n.tenant_id, n.job_id, 'owner_notification.send') is null))
           order by n.recorded_at, n.id
             for update) b;
  begin
    perform 1 from ops.exceptions e
     where e.tenant_id = v_own.tenant_id
       and e.id in (select n.exception_id from ops.owner_notifications n where n.id = any (v_batch))
     order by e.id
       for share nowait;
  exception when lock_not_available then
    perform ops.release_owner_notification_job(v_job, now() + interval '5 seconds',
                                               'waiting for an episode a person or a screening holds');
    return jsonb_build_object('action', 'released', 'ownerNotificationId', v_own.id);
  end;
  update ops.owner_notifications n set status = 'expired'
   where n.id = any (v_batch) and n.status = 'pending' and n.expires_at <= now();
  update ops.owner_notifications n set status = 'skipped_resolved'
   where n.id = any (v_batch) and n.status = 'pending'
     and exists (select 1 from ops.exceptions e
                  where e.tenant_id = n.tenant_id and e.id = n.exception_id and e.resolved_at is not null);
  update ops.owner_notifications n set status = 'skipped_answered'
   where n.id = any (v_batch) and n.status = 'pending'
     and (select l.reply_seq from ops.owner_notification_last_reply(n.tenant_id, n.conversation_id) l) > n.trigger_seq;

  select n.* into v_own from ops.owner_notifications n where n.id = v_own.id;
  if v_own.status <> 'pending' then
    return jsonb_build_object('action', 'settled', 'status', v_own.status, 'ownerNotificationId', v_own.id);
  end if;
  select pg_catalog.array_agg(n.id order by n.recorded_at, n.id) into v_batch
    from ops.owner_notifications n where n.id = any (v_batch) and n.status = 'pending';
  select pg_catalog.array_agg(distinct n.conversation_id) into v_convs
    from ops.owner_notifications n where n.id = any (v_batch);

  -- One conversation: its first word and since when it waits. Several: how
  -- many conversations wait now.
  if pg_catalog.cardinality(v_convs) = 1 then
    v_kind := 'episode';
    v_name := ops.owner_notification_first_word(v_own.tenant_id, v_convs[1], v_target.name_fallback);
    v_params := array[
      v_name,
      to_char((select pg_catalog.min(n.waiting_since) from ops.owner_notifications n where n.id = any (v_batch))
                at time zone v_target.time_zone, 'HH24:MI')];
  else
    v_kind := 'digest';
    v_params := array[(select pg_catalog.count(distinct e.conversation_id)::text
                         from ops.exceptions e
                        where e.tenant_id = v_own.tenant_id and e.resolved_at is null
                          and e.kind in ('person_requested', 'message_waiting'))];
  end if;

  update ops.owner_notifications
     set status = 'sending', transport = p_transport, job_attempt = v_job.attempts,
         send_channel_id = v_target.channel_id, template_kind = v_kind
   where id = v_own.id;
  update ops.owner_notifications
     set status = 'coalesced', carried_by = v_own.id
   where id = any (v_batch) and id <> v_own.id;
  return jsonb_build_object(
    'action', 'start',
    'ownerNotificationId', v_own.id,
    'request', jsonb_build_object(
      'providerTarget', v_channel.provider_target,
      'to', v_target.digits,
      'templateName', case when v_kind = 'episode' then v_target.episode_template else v_target.digest_template end,
      'languageCode', v_target.template_language,
      'parameters', to_jsonb(v_params)));
end
$function$;

do $end_state$
begin
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.begin_owner_notification(text)'::pg_catalog.regprocedure),
                       'owner_target_number_held(v_target)') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_owner_notification(text)'::pg_catalog.regprocedure),
                          'owner_notification_cap_frees_at') = 0
     or pg_catalog.strpos((select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
                            where c.conname = 'owner_notifications_block_shape'), 'target_held') = 0 then
    raise exception 'the notification does not check its target again before it leaves';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid = 'ops.owner_target_number_held(ops.owner_notification_targets)'::pg_catalog.regprocedure
                and (p.prosecdef or p.proacl is null
                     or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
                     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                                 where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')))) then
    raise exception 'the target check is reachable or not an INVOKER';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.begin_owner_notification(text)'::pg_catalog.regprocedure
                    and p.prosecdef and pg_catalog.has_function_privilege('ops_worker', p.oid, 'EXECUTE')) then
    raise exception 'the notification''s begin is no longer the worker''s pinned capability';
  end if;
end
$end_state$;
