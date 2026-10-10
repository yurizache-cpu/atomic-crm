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
-- N1b. The registration exempts a number channel by channel, as the gateway
--      does; a CRM contact stored under another format is still a lead; the
--      fallback word is one the template transport always accepts.
-- ---------------------------------------------------------------------------

do $$
declare
  ta   constant uuid := pg_temp.id('tenant');
  ch   constant uuid := pg_temp.id('chan');
  v_b  uuid;
  v_r  text;
begin
  -- The device is registered on the test line only; a second test channel
  -- holds a conversation with it, where it is not a registered sender.
  v_b := ops.configure_whatsapp_channel(ta, pg_temp.id('company'), pg_temp.id('agent'), '300000000000088', 'test',
                                        'ON test B', 'on-owner');
  insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
  values (ta, pg_temp.id('company'), v_b, '5511900000086', now());
  for v_r in
    select pg_temp.refusal(format(
      'select ops.record_owner_notification_target(%L, %L, %L, %L, %L, %L)',
      ta, c, '5511900000086', 'aviso_a', 'aviso_b', 'on-owner'))
      from unnest(array[ch, v_b]) c
  loop
    if v_r is null or v_r !~ '^OS409' or not pg_temp.valueless(v_r) then
      raise exception 'N1b: a number a conversation on another channel holds was recorded: %', v_r;
    end if;
  end loop;
  delete from ops.conversations where tenant_id = ta;

  -- A CRM contact whose phone was saved without the country code.
  update ops.tenants set owns_local_crm = false where owns_local_crm and id <> ta;
  update ops.tenants set owns_local_crm = true where id = ta;
  insert into public.contacts (first_name, last_name, phone_jsonb)
  values ('on-test', 'Synthetic', '[{"number": "(11) 90000-0902", "type": "Mobile"}]'::jsonb);
  v_r := pg_temp.refusal(format('select ops.record_owner_notification_target(%L, %L, %L, %L, %L, %L)',
                                ta, ch, '5511900000902', 'aviso_a', 'aviso_b', 'on-owner'));
  if v_r is null or v_r !~ '^OS409.*CRM contact' or not pg_temp.valueless(v_r) then
    raise exception 'N1b: a number a CRM contact carries under another format was recorded: %', v_r;
  end if;
  delete from public.contacts where first_name = 'on-test';
  update ops.tenants set owns_local_crm = false where id = ta;

  -- Runs of spaces, or a space at an end, the template transport refuses.
  for v_r in
    select pg_temp.refusal(format(
      'select ops.record_owner_notification_target(%L, %L, %L, %L, %L, %L, %L, %L::text[], %L::time, %L::time, %L, 10, 30, %L)',
      ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'on-owner', 'pt_BR', '{person_requested}', '22:00', '08:00',
      'America/Sao_Paulo', f))
      from unnest(array['Novo    contato', 'Novo  contato', ' Contato', 'Contato ', 'Umnomemuitolongodemais']) f
  loop
    if v_r is null or v_r !~ '^OS400' then
      raise exception 'N1b: a fallback word the transport refuses was recorded: %', v_r;
    end if;
  end loop;
  perform ops.record_owner_notification_target(ta, ch, '5511900000087', 'aviso_a', 'aviso_b', 'on-owner', 'pt_BR',
                                               array['person_requested'], '22:00', '08:00', 'America/Sao_Paulo',
                                               10, 30, 'Novo contato');
  perform ops.retire_owner_notification_target(ta, 'on-test retire', 'on-owner');
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
-- N6b. Delivery news after a failure keeps the notification failed (it never
--      takes back a gap a later message used); a status for a send still
--      settling is refused as transient, for the provider to deliver again.
-- ---------------------------------------------------------------------------

do $$
declare
  note constant uuid := pg_temp.id('note');
  v_a  jsonb;
  v_r  text;
begin
  alter table ops.owner_notifications disable trigger owner_notifications_guard;
  update ops.owner_notifications
     set status = 'failed', delivered_at = null, read_at = null,
         provider_message_key = encode(sha256(convert_to('wamid.ON-NOTE-3', 'UTF8')), 'hex')
   where id = note;
  alter table ops.owner_notifications enable always trigger owner_notifications_guard;
  v_a := ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-3', 'delivered', now(), '5511900000087', null, null);
  if v_a <> '{"state": "ignored", "status": "failed"}'::jsonb
     or (select status from ops.owner_notifications where id = note) <> 'failed'
     or (select delivered_at from ops.owner_notifications where id = note) is null then
    raise exception 'N6b: delivery news after a failure made the notification live again: %', v_a;
  end if;

  alter table ops.owner_notifications disable trigger owner_notifications_guard;
  update ops.owner_notifications
     set status = 'sending', provider_message_key = null, settled_at = null, delivered_at = null, read_at = null,
         error_code = null, error_class = null, sending_at = now()
   where id = note;
  alter table ops.owner_notifications enable always trigger owner_notifications_guard;
  v_r := pg_temp.refusal($q$select ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-4', 'sent', now(),
                                                               '5511900000087', null, null)$q$);
  if v_r !~ '^OS429' then
    raise exception 'N6b: a status for a send still settling was not refused as transient: %', v_r;
  end if;
  if ops.receive_whatsapp_status('300000000000086', 'wamid.ON-NOTE-4', 'sent', now(), '5511900000099', null, null)
     <> '{"state": "unmatched"}'::jsonb then
    raise exception 'N6b: a status for another recipient was held for a send in flight';
  end if;

  -- Back to what N7 reads: delivered.
  alter table ops.owner_notifications disable trigger owner_notifications_guard;
  update ops.owner_notifications
     set status = 'delivered', settled_at = now(), delivered_at = now(),
         provider_message_key = encode(sha256(convert_to('wamid.ON-NOTE-2', 'UTF8')), 'hex')
   where id = note;
  alter table ops.owner_notifications enable always trigger owner_notifications_guard;
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
-- N7b. Every notification status maps to the state and instant the browser
--      shows (a carried one follows its carrier); at most 50 conversations
--      are listed, oldest first, with the exact total.
-- ---------------------------------------------------------------------------

create function pg_temp.set_note(p_id uuid, p_status text, p_carrier uuid) returns void
language plpgsql as $f$
declare
  v_sent constant boolean := p_status in ('sending', 'sent', 'delivered', 'read', 'failed', 'indeterminate');
begin
  update ops.owner_notifications
     set status = p_status,
         block_reason = case when p_status = 'blocked' then 'job_failed' end,
         carried_by = case when p_status in ('coalesced', 'carrier_failed') then p_carrier end,
         sending_at = case when v_sent then now() - interval '3 minutes' end,
         transport = case when v_sent then 'meta' end,
         job_attempt = case when v_sent then 1 end,
         send_channel_id = case when v_sent then pg_temp.id('chan') end,
         template_kind = case when v_sent then 'episode' end,
         provider_message_key = case when p_status in ('sent', 'delivered', 'read')
                                     then encode(sha256(convert_to(p_id::text, 'UTF8')), 'hex') end,
         settled_at = case when p_status not in ('pending', 'sending', 'coalesced') then now() - interval '2 minutes' end,
         delivered_at = case when p_status in ('delivered', 'read') then now() - interval '90 seconds' end,
         read_at = case when p_status = 'read' then now() - interval '1 minute' end
   where id = p_id;
end
$f$;

do $$
declare
  ta      constant uuid := pg_temp.id('tenant');
  note    constant uuid := pg_temp.id('note');
  v_n     ops.owner_notifications;
  v_carry uuid := gen_random_uuid();
  v_ep    uuid;
  v_case  record;
  v_item  jsonb;
  v_list  jsonb;
  v_task  uuid;
  v_conv  uuid;
  v_eps   uuid[] := array[]::uuid[];
begin
  select * into v_n from ops.owner_notifications where id = note;
  -- A carrier on the conversation's request for a person, recorded earlier.
  v_ep := ops.open_exception(ta, v_n.company_id, (select task_id from ops.exceptions where id = v_n.exception_id),
                             'person_requested', v_n.conversation_id, null, null, 'on-test');
  alter table ops.owner_notifications disable trigger owner_notifications_guard;
  insert into ops.owner_notifications (
    id, tenant_id, company_id, exception_id, conversation_id, kind, trigger_seq, waiting_since, target_id,
    unit_company_id, unit_department_id, unit_agent_id, job_id, status, recorded_at, due_at, expires_at)
  values (
    v_carry, ta, v_n.company_id, v_ep, v_n.conversation_id, 'person_requested', 1, now() - interval '1 hour',
    v_n.target_id, v_n.unit_company_id, v_n.unit_department_id, v_n.unit_agent_id,
    ops.enqueue_job(ta, 'owner_notification.send', jsonb_build_object('owner_notification_id', v_carry)),
    'pending', now() - interval '1 hour', now() - interval '1 hour', now() + interval '1 day');
  perform pg_temp.set_note(v_carry, 'read', null);

  for v_case in
    select * from (values
      ('pending', 'pending', 'recorded_at'), ('sending', 'pending', 'sending_at'), ('sent', 'sent', 'settled_at'),
      ('delivered', 'delivered', 'delivered_at'), ('read', 'read', 'read_at'), ('failed', 'failed', 'settled_at'),
      ('indeterminate', 'indeterminate', 'settled_at'), ('skipped_resolved', 'skipped', 'settled_at'),
      ('skipped_answered', 'skipped', 'settled_at'), ('blocked', 'blocked', 'settled_at'),
      ('expired', 'blocked', 'settled_at'), ('carrier_failed', 'failed', 'settled_at'),
      ('coalesced', 'read', 'carrier_read_at')) as c (status, shown, instant)
  loop
    perform pg_temp.set_note(note, v_case.status, v_carry);
    select * into v_n from ops.owner_notifications where id = note;
    v_item := ops.cos_waiting_list(ta, clock_timestamp()) -> 'items' -> 0 -> 'notification';
    if v_item ->> 'state' is distinct from v_case.shown
       or v_item ->> 'at' is distinct from ops.cos_ts(case v_case.instant
            when 'recorded_at' then v_n.recorded_at when 'sending_at' then v_n.sending_at
            when 'settled_at' then v_n.settled_at when 'delivered_at' then v_n.delivered_at
            when 'read_at' then v_n.read_at
            else (select read_at from ops.owner_notifications where id = v_carry) end) then
      raise exception 'N7b: status % shows %, expected % at its %', v_case.status, v_item, v_case.shown, v_case.instant;
    end if;
  end loop;
  alter table ops.owner_notifications enable always trigger owner_notifications_guard;

  -- 51 more conversations waiting, each a minute newer than the last.
  for i in 1..51 loop
    insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
    values (ta, v_n.company_id, pg_temp.id('chan'), '55119100' || lpad(i::text, 5, '0'), now())
    returning id into v_conv;
    v_task := ops.create_task(ta, v_n.company_id, 'lead_triage', 'WhatsApp message', 'on-test', null,
                              pg_temp.id('department'), null, 100, null, null, null, null, 'test');
    v_ep := ops.open_exception(ta, v_n.company_id, v_task, 'message_waiting', v_conv, null, null, 'on-test');
    v_eps := v_eps || v_ep;
  end loop;
  alter table ops.exceptions disable trigger exceptions_guard;
  update ops.exceptions e set raised_at = now() + make_interval(mins => o.k::int)
    from unnest(v_eps) with ordinality o (id, k) where e.id = o.id;
  alter table ops.exceptions enable always trigger exceptions_guard;
  v_list := ops.cos_waiting_list(ta, now() + interval '2 hours');
  if (v_list ->> 'total')::int <> 52 or jsonb_array_length(v_list -> 'items') <> 50
     or exists (select 1 from jsonb_array_elements(v_list -> 'items') with ordinality a (item, k)
                  join jsonb_array_elements(v_list -> 'items') with ordinality b (item, k) on b.k = a.k + 1
                 where (a.item ->> 'waitingSince') > (b.item ->> 'waitingSince')) then
    raise exception 'N7b: the waiting list is not the 50 oldest of 52, oldest first';
  end if;
  -- Waiting since a later instant than the one read: not listed yet.
  if (ops.cos_waiting_list(ta, now() + interval '30 minutes 30 seconds') ->> 'total')::int <> 31 then
    raise exception 'N7b: the waiting list counted an episode raised after the instant it was read for';
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
