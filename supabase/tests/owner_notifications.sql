-- ADR 0026 §D — attacks on the owner's notification.
--
-- The question: can any role reach the target, the notifications or their
-- helpers; can a target be edited, kept with its number after it is retired,
-- or recorded for a number a conversation or a CRM contact holds; can an
-- error carry the number; can a notification be forged, moved outside its
-- state machine, or sent from a channel that is not live; can a failure of
-- the notification fail the admission that raised it; is the owner's number
-- ever admitted as a lead; can a status for another recipient settle a
-- notification; and does the number live anywhere but the target?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: access, the guards, the owner's acts, the quiet-hour helpers, the
--     gateway's recognition of the number, the gateway's intent and its
--     isolation, status callbacks, the waiting list's shape, and a sweep of
--     every text and json column for the number.
--   * There (engine/domain/ownerNotifications.dbtest.ts): signed deliveries,
--     the screening's intents, the worker's send with debounce, quiet hours,
--     caps, stops, coalescing, at most one call, and the reaper.
--
-- ONE TRANSACTION, ROLLED BACK. ALL DATA IS SYNTHETIC.

\set ON_ERROR_STOP on

begin;

create temporary table on_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into on_ids (name, id) values (p_name, p_id)
  on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from on_ids where name = p_name;
$$;

-- The SQLSTATE and message a statement raised, or null when it did not.
create function pg_temp.refusal(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end
$$;

-- Whether a refusal carries no run of six digits or more.
create function pg_temp.valueless(p_refusal text) returns boolean
language sql immutable as $$
  select p_refusal is not null and p_refusal !~ '[0-9]{6}';
$$;

do $$
declare
  c_source constant text := 'owner-notifications-suite';
  ta uuid;
  ca uuid;
  da uuid;
begin
  insert into ops.tenants (slug, name) values ('on-test-alpha', 'ON Alpha') returning id into ta;
  perform pg_temp.remember('tenant', ta);
  ca := pg_temp.remember('company', ops.create_company(ta, 'notify-a', 'Notify A', c_source));
  da := pg_temp.remember('department', ops.create_department(ta, ca, 'intake', 'Intake', c_source));
  perform pg_temp.remember('agent', ops.create_agent(ta, ca, da, 'front-desk', 'Front Desk', 'Desk assistant', c_source));
  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'on-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'on-test: sql suite ceiling', 'on-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'on-test: budget', 'on-owner', ta);
  perform pg_temp.remember('chan', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent'), '300000000000086', 'test', 'ON test', 'on-owner'));
  perform pg_temp.remember('chan_prod', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent'), '300000000000087', 'production', 'ON production', 'on-owner', false));
  -- The owner's own device, registered on the test line.
  perform ops.register_test_sender(ta, pg_temp.id('chan'), '5511900000086', 'on-owner');
end
$$;

-- ---------------------------------------------------------------------------
-- N1. The target: owner data, checked before the database, never a value in
--     an error, never a number a conversation or a CRM contact holds.
-- ---------------------------------------------------------------------------

do $$
declare
  ta    constant uuid := pg_temp.id('tenant');
  ch    constant uuid := pg_temp.id('chan');
  v_r   text;
  v_one uuid;
  v_two uuid;
begin
  -- A conversation holds a number in its 12-digit form.
  insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
  values (ta, pg_temp.id('company'), ch, '551100000088', now());

  for v_r in
    select pg_temp.refusal(format(
      'select ops.record_owner_notification_target(%L, %L, %L, %L, %L, %L, %L, %L::text[], %L::time, %L::time, %L, %s, %s, %L)',
      t, c, d, e, g, 'on-owner', l, k, qs, qe, z, hc, dc, f))
      from (values
        -- an unknown tenant, the production channel, malformed digits
        (gen_random_uuid(), ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        (ta, pg_temp.id('chan_prod'), '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        (ta, ch, '+5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        (ta, ch, '0511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        -- the same template twice, an unknown time zone, an empty quiet window
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_a', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'Mars/Olympus_Mons', 10, 30, 'Contato'),
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '22:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        -- caps out of range, an hourly cap above the daily, a repeated or foreign kind
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 0, 30, 'Contato'),
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 40, 30, 'Contato'),
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested,person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{send_failed}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato'),
        -- a fallback word that is not letters
        (ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, '=1+1'),
        -- a number a conversation holds, in its other Brazil form
        (ta, ch, '5511900000088', 'aviso_a', 'aviso_b', 'pt_BR', '{person_requested}', '22:00', '08:00', 'America/Sao_Paulo', 10, 30, 'Contato')
      ) as v (t, c, d, e, g, l, k, qs, qe, z, hc, dc, f)
  loop
    if v_r is null then
      raise exception 'N1: a malformed or forbidden target was recorded';
    end if;
    if not pg_temp.valueless(v_r) or v_r !~ '^OS4' then
      raise exception 'N1: a refusal carried a value or was not an owner-facing refusal: %', v_r;
    end if;
  end loop;
  if pg_temp.refusal(format(
       'select ops.record_owner_notification_target(%L, %L, %L, %L, %L, %L)',
       ta, ch, '5511900000088', 'aviso_a', 'aviso_b', 'on-owner')) !~ 'identifiers erase --number-file' then
    raise exception 'N1: the refusal for a held number does not say how to erase it';
  end if;

  -- Recorded in force; never edited; one in force; a retired target keeps no number.
  v_one := ops.record_owner_notification_target(ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'on-owner');
  if pg_temp.refusal(format('update ops.owner_notification_targets set kinds = %L where id = %L',
                            '{person_requested}', v_one)) !~ '^OS403'
     or pg_temp.refusal(format('update ops.owner_notification_targets set digits = %L where id = %L',
                               '5511900000089', v_one)) !~ '^OS403'
     or pg_temp.refusal(format('delete from ops.owner_notification_targets where id = %L', v_one)) !~ '^OS403'
     -- Refused by its guard, or first by the notifications that reference it.
     or pg_temp.refusal('truncate ops.owner_notification_targets') !~ '^(OS403|0A000)' then
    raise exception 'N1: a target in force was edited, deleted or truncated';
  end if;
  v_two := ops.record_owner_notification_target(ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'on-owner');
  if (select count(*) from ops.owner_notification_targets where tenant_id = ta and retired_at is null) <> 1
     or (select digits from ops.owner_notification_targets where id = v_one) is not null
     or (select retired_at from ops.owner_notification_targets where id = v_one) is null then
    raise exception 'N1: a new target did not retire the old one without its number';
  end if;
  -- The owner's registered device may be the target, though a conversation holds it.
  insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
  values (ta, pg_temp.id('company'), ch, '5511900000086', now());
  perform ops.record_owner_notification_target(ta, ch, '5511900000086', 'aviso_a', 'aviso_b', 'on-owner');
  if not ops.retire_owner_notification_target(ta, 'on-test retire', 'on-owner')
     or ops.retire_owner_notification_target(ta, 'on-test retire again', 'on-owner') then
    raise exception 'N1: retiring answered wrong';
  end if;
  if exists (select 1 from ops.owner_notification_targets where tenant_id = ta and digits is not null) then
    raise exception 'N1: a retired target kept its number';
  end if;
  delete from ops.conversations where tenant_id = ta;
end
$$;

-- ---------------------------------------------------------------------------
-- N2. Quiet hours: a window that wraps midnight, its end, and the due instant.
-- ---------------------------------------------------------------------------

do $$
declare
  v_t ops.owner_notification_targets;
begin
  perform ops.record_owner_notification_target(
    pg_temp.id('tenant'), pg_temp.id('chan'), '5511900000087', 'aviso_a', 'aviso_b', 'on-owner');
  select * into v_t from ops.owner_notification_targets where tenant_id = pg_temp.id('tenant') and retired_at is null;
  -- 23:00, 21:59:30 + 60 s and 07:59:30 + 60 s in São Paulo (UTC-3).
  if ops.owner_notification_due_at(v_t, '2030-03-04 23:00:00-03') <> '2030-03-05 08:00:00-03'
     or ops.owner_notification_due_at(v_t, '2030-03-04 22:00:30-03') <> '2030-03-05 08:00:00-03'
     or ops.owner_notification_due_at(v_t, '2030-03-05 08:00:30-03') <> '2030-03-05 08:00:30-03'
     or ops.owner_notification_due_at(v_t, '2030-03-05 03:00:00-03') <> '2030-03-05 08:00:00-03'
     or ops.owner_notification_due_at(v_t, '2030-03-05 21:59:59-03') <> '2030-03-05 21:59:59-03'
     or ops.owner_notification_quiet(v_t, '2030-03-05 08:00:00-03')
     or not ops.owner_notification_quiet(v_t, '2030-03-05 22:00:00-03') then
    raise exception 'N2: the quiet hours are not [22:00, 08:00) in the target''s zone';
  end if;
  -- The owner's number in both Brazil mobile forms, and nothing else.
  if ops.owner_number_forms('5511900000087') <> array['5511900000087', '551100000087']
     or ops.owner_number_forms('551187650087') <> array['551187650087', '5511987650087']
     -- A 12-digit number whose first digit is no mobile's has one form.
     or ops.owner_number_forms('551130000087') <> array['551130000087']
     or ops.owner_number_forms('14155550123') <> array['14155550123'] then
    raise exception 'N2: the number''s forms are wrong';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- N3. The owner's number writing in: refused before any conversation is
--     written, content-free, once per message; a registered device is not.
-- ---------------------------------------------------------------------------

do $$
declare
  ta constant uuid := pg_temp.id('tenant');
  v_a jsonb;
  v_b jsonb;
  v_c jsonb;
begin
  v_a := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-OWNER-1', '5511900000087', 'Oi', now());
  v_b := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-OWNER-1', '5511900000087', 'Oi', now());
  v_c := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-OWNER-2', '551100000087', 'Oi', now());
  if v_a <> '{"state": "refused", "reason": "owner_number"}'::jsonb or v_b <> v_a or v_c <> v_a then
    raise exception 'N3: the owner''s number was not refused as itself: % % %', v_a, v_b, v_c;
  end if;
  if exists (select 1 from ops.conversations where tenant_id = ta)
     or exists (select 1 from ops.inbound_messages where tenant_id = ta)
     or exists (select 1 from ops.tasks where tenant_id = ta)
     or exists (select 1 from ops.exceptions where tenant_id = ta)
     or exists (select 1 from ops.crm_contact_acts where tenant_id = ta) then
    raise exception 'N3: the owner''s number left a conversation, an admission, a task, an exception or an act';
  end if;
  if (select count(*) from ops.events where tenant_id = ta and type = 'communication.inbound_refused') <> 2
     or exists (select 1 from ops.events where tenant_id = ta and type = 'communication.inbound_refused'
                   and (payload ? 'conversation_id' or payload::text like '%00000087%'
                        or payload <> jsonb_build_object('channel_id', pg_temp.id('chan'), 'reason', 'owner_number'))) then
    raise exception 'N3: the refusal is not one content-free fact per message';
  end if;
  -- The owner's registered device is a test sender, and is admitted.
  v_a := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-DEVICE-1', '5511900000086', 'Oi', now());
  if v_a ->> 'state' <> 'admitted' then
    raise exception 'N3: the registered device was not admitted: %', v_a;
  end if;
  perform pg_temp.remember('conv', (v_a ->> 'conversation_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------
-- N4. The gateway's intent: a refused message in a conversation a person
--     holds tells the owner once, with its own job; a failure of the intent
--     never fails the admission that raised it.
-- ---------------------------------------------------------------------------

do $$
declare
  ta   constant uuid := pg_temp.id('tenant');
  conv constant uuid := pg_temp.id('conv');
  v_a  jsonb;
  v_n  ops.owner_notifications;
  v_j  ops.jobs;
begin
  perform ops.take_over_conversation(ta, conv, 'on-person');
  -- The intent fails (an injected refusal): the message is still refused on
  -- the record and counted for the person; nothing of the intent is left.
  create function pg_temp.refuse_intent() returns trigger language plpgsql as $f$
  begin
    raise exception 'on-test: injected failure';
  end
  $f$;
  create trigger on_test_refuse_intent before insert on ops.owner_notifications
    for each row execute function pg_temp.refuse_intent();
  v_a := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-IMAGE-1', '5511900000086', null, now());
  drop trigger on_test_refuse_intent on ops.owner_notifications;
  if v_a ->> 'state' <> 'refused'
     or not exists (select 1 from ops.exceptions where tenant_id = ta and kind = 'message_waiting' and resolved_at is null)
     or exists (select 1 from ops.owner_notifications where tenant_id = ta)
     or exists (select 1 from ops.jobs where tenant_id = ta and kind = 'owner_notification.send') then
    raise exception 'N4: a failing intent failed the admission or left a trace: %', v_a;
  end if;

  -- The next waiting message records it, once.
  v_a := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-IMAGE-2', '5511900000086', null, now());
  v_a := ops.receive_whatsapp_message('300000000000086', 'wamid.ON-IMAGE-3', '5511900000086', null, now());
  if (select count(*) from ops.owner_notifications where tenant_id = ta) <> 1 then
    raise exception 'N4: the waiting messages did not record exactly one notification';
  end if;
  select * into v_n from ops.owner_notifications where tenant_id = ta;
  select * into v_j from ops.jobs where id = v_n.job_id;
  if v_n.status <> 'pending' or v_n.kind <> 'message_waiting' or v_n.follows_review_id is not null
     or v_n.conversation_id <> conv
     or v_j.kind <> 'owner_notification.send' or v_j.max_attempts <> 5 or v_j.status <> 'queued'
     or v_j.idempotency_key <> format('owner_notification:%s', v_n.id)
     or v_j.payload <> jsonb_build_object('owner_notification_id', v_n.id)
     or v_j.available_at <> v_n.due_at
     or v_n.due_at < now() + interval '59 seconds'
     or v_n.unit_agent_id <> pg_temp.id('agent') then
    raise exception 'N4: the notification or its job is not as recorded: % %', to_jsonb(v_n), to_jsonb(v_j);
  end if;
  perform pg_temp.remember('note', v_n.id);

  -- Kinds that never tell the owner, and a missing conversation.
  if ops.record_owner_notification_intent(ta, pg_temp.id('company'), gen_random_uuid(), 'opt_out', conv, null)
       <> 'not_notifying'
     or ops.record_owner_notification_intent(ta, pg_temp.id('company'), gen_random_uuid(), 'person_requested', null, null)
       <> 'not_notifying' then
    raise exception 'N4: a kind that never notifies was considered';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- N5. The notification's guard: no forged row, no edit outside its state
--     machine, never sent from a channel that is not live, never deleted.
-- ---------------------------------------------------------------------------

do $$
declare
  ta   constant uuid := pg_temp.id('tenant');
  note constant uuid := pg_temp.id('note');
  v_n  ops.owner_notifications;
begin
  select * into v_n from ops.owner_notifications where id = note;
  if pg_temp.refusal(format(
       $q$insert into ops.owner_notifications (tenant_id, company_id, exception_id, conversation_id, kind,
            trigger_seq, waiting_since, target_id, unit_company_id, unit_department_id, unit_agent_id, job_id,
            status, due_at, expires_at)
          values (%L, %L, %L, %L, 'message_waiting', 1, now(), %L, %L, %L, %L, %L, 'sent', now(), now() + interval '1 day')$q$,
       ta, v_n.company_id, v_n.exception_id, v_n.conversation_id, v_n.target_id, v_n.unit_company_id,
       v_n.unit_department_id, v_n.unit_agent_id, v_n.job_id)) !~ '^(OS403|23)'
     or pg_temp.refusal(format(
       $q$insert into ops.owner_notifications (tenant_id, company_id, exception_id, conversation_id, kind,
            trigger_seq, waiting_since, target_id, unit_company_id, unit_department_id, unit_agent_id, job_id,
            due_at, expires_at)
          values (%L, %L, %L, %L, 'person_requested', 1, now(), %L, %L, %L, %L, %L, now() + interval '1 minute', now() + interval '1 day')$q$,
       ta, v_n.company_id, v_n.exception_id, v_n.conversation_id, v_n.target_id, v_n.unit_company_id,
       v_n.unit_department_id, v_n.unit_agent_id,
       ops.enqueue_job(ta, 'owner_notification.send', jsonb_build_object('owner_notification_id', gen_random_uuid()))))
       !~ '^OS403' then
    raise exception 'N5: a forged notification was recorded';
  end if;
  if pg_temp.refusal(format('update ops.owner_notifications set kind = %L where id = %L', 'person_requested', note)) !~ '^OS403'
     or pg_temp.refusal(format('update ops.owner_notifications set status = %L, provider_message_key = %L where id = %L',
                               'sent', repeat('0', 64), note)) !~ '^OS403'
     or pg_temp.refusal(format('update ops.owner_notifications set due_at = now() where id = %L', note)) !~ '^OS403'
     or pg_temp.refusal(format('delete from ops.owner_notifications where id = %L', note)) !~ '^OS403'
     or pg_temp.refusal('truncate ops.owner_notifications') !~ '^OS403' then
    raise exception 'N5: a notification left its state machine';
  end if;
  -- Never begun on a channel that is not active and test.
  perform ops.configure_whatsapp_channel(ta, pg_temp.id('company'), pg_temp.id('agent'), '300000000000086', 'test',
                                         'ON test', 'on-owner', false);
  if pg_temp.refusal(format(
       $q$update ops.owner_notifications set status = 'sending', send_channel_id = %L, template_kind = 'episode',
            transport = 'fake', job_attempt = 1 where id = %L$q$, pg_temp.id('chan'), note)) !~ '^OS403' then
    raise exception 'N5: a notification began on an inactive channel';
  end if;
  perform ops.configure_whatsapp_channel(ta, pg_temp.id('company'), pg_temp.id('agent'), '300000000000086', 'test',
                                         'ON test', 'on-owner', true);
  -- Coalesced only into a send begun now.
  if pg_temp.refusal(format('update ops.owner_notifications set status = %L, carried_by = %L where id = %L',
                            'coalesced', gen_random_uuid(), note)) is null then
    raise exception 'N5: a notification was coalesced into no send';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- N6. Status callbacks: by the digest of the provider id, or by the
--     correlation with the target's number as recipient; no event, no
--     exception; another recipient settles nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  ta     constant uuid := pg_temp.id('tenant');
  note   constant uuid := pg_temp.id('note');
  v_seq  bigint;
  v_a    jsonb;
begin
  select coalesce(max(seq), 0) into v_seq from ops.events where tenant_id = ta;
  -- As the worker would leave them: one sent, one whose outcome is unknown.
  alter table ops.owner_notifications disable trigger owner_notifications_guard;
  update ops.owner_notifications
     set status = 'sent', send_channel_id = pg_temp.id('chan'), template_kind = 'episode', transport = 'meta',
         job_attempt = 1, sending_at = now(), settled_at = now(),
         provider_message_key = encode(sha256(convert_to('wamid.ON-NOTE-1', 'UTF8')), 'hex')
   where id = note;
  alter table ops.owner_notifications enable always trigger owner_notifications_guard;

  v_a := ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-1', 'delivered', now(), '5511900000087', null, null);
  if v_a <> '{"state": "updated", "status": "delivered", "previous": "sent"}'::jsonb then
    raise exception 'N6: a status by provider id did not settle the notification: %', v_a;
  end if;
  v_a := ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-1', 'read', now(), '5511900000087', null, null);
  if v_a ->> 'status' <> 'read' or (select status from ops.owner_notifications where id = note) <> 'read' then
    raise exception 'N6: a read status was not recorded: %', v_a;
  end if;

  alter table ops.owner_notifications disable trigger owner_notifications_guard;
  update ops.owner_notifications set status = 'indeterminate', provider_message_key = null where id = note;
  alter table ops.owner_notifications enable always trigger owner_notifications_guard;
  v_a := ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-2', 'delivered', now(), '5511900000099',
                                     format('owner-notification:%s', note), null);
  if v_a <> '{"state": "unmatched"}'::jsonb then
    raise exception 'N6: a status for another recipient matched the notification: %', v_a;
  end if;
  v_a := ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-2', 'delivered', now(), '551100000087',
                                     format('owner-notification:%s', note), null);
  if v_a ->> 'status' <> 'delivered'
     or (select provider_message_key from ops.owner_notifications where id = note)
        <> encode(sha256(convert_to('wamid.ON-NOTE-2', 'UTF8')), 'hex') then
    raise exception 'N6: an uncertain notification was not settled by its correlation: %', v_a;
  end if;
  if exists (select 1 from ops.events where tenant_id = ta and seq > v_seq)
     or exists (select 1 from ops.exceptions where tenant_id = ta and kind like 'send_%') then
    raise exception 'N6: a notification status recorded an event or an exception';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- N7. The waiting list: the conversation, by its task, its kinds and counts,
--     never a number or a conversation id; nothing for an unknown tenant.
-- ---------------------------------------------------------------------------

do $$
declare
  v_list jsonb := ops.cos_waiting_list(pg_temp.id('tenant'), clock_timestamp());
begin
  if (v_list ->> 'total')::int <> 1
     or v_list -> 'items' -> 0 -> 'kinds' <> '["message_waiting"]'::jsonb
     or (v_list -> 'items' -> 0 -> 'counts' ->> 'message_waiting')::int <> 3
     or v_list -> 'items' -> 0 -> 'notification' ->> 'state' <> 'delivered'
     or v_list::text like '%5511900000086%' or v_list::text like '%551100000086%'
     or strpos(v_list::text, pg_temp.id('conv')::text) > 0 then
    raise exception 'N7: the waiting list is not as the facts say, or carries a number or a conversation id: %', v_list;
  end if;
  if ops.cos_waiting_list(gen_random_uuid(), clock_timestamp()) <> '{"total": 0, "items": []}'::jsonb then
    raise exception 'N7: an unknown tenant has a waiting list';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- N8. The owner's number lives in the target in force and nowhere else: every
--     text, text[], json and jsonb column of every ops and public table.
-- ---------------------------------------------------------------------------

do $$
declare
  v_col record;
  v_hit boolean;
  v_bad text;
begin
  for v_col in
    select c.table_schema, c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema in ('ops', 'public') and t.table_type = 'BASE TABLE'
       and c.data_type in ('text', 'character varying', 'json', 'jsonb', 'ARRAY')
       and not (c.table_name = 'owner_notification_targets' and c.column_name = 'digits')
  loop
    execute format('select exists (select 1 from %I.%I where %I::text like %L or %I::text like %L)',
                   v_col.table_schema, v_col.table_name, v_col.column_name, '%5511900000087%',
                   v_col.column_name, '%551100000087%')
       into v_hit;
    if v_hit then
      v_bad := concat_ws(', ', v_bad, format('%s.%s.%s', v_col.table_schema, v_col.table_name, v_col.column_name));
    end if;
  end loop;
  if v_bad is not null then
    raise exception 'N8: the owner''s number is kept outside the target: %', v_bad;
  end if;
end
$$;

rollback;

-- Nothing above committed.
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'on-test-%') then
    raise exception 'owner_notifications.sql left fixtures behind';
  end if;
end
$$;
