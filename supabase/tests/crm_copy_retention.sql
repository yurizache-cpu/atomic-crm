-- ADR 0026 §C — attacks on the CRM copy's retention.
--
-- The question: when a number is erased, is the CRM contact the system
-- created for it deleted with it, and only then: never while another
-- conversation whose number is not erased still names it (whichever is erased
-- first), never once a person worked on it (an edit of the contact, its lead
-- profile or an attribution, a note, a task, a deal), never a contact the
-- system did not create; are the system's own writes kept out of the edit
-- marks; and can anyone read, change or empty the marks?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: the marks, the deletion adapter and the erasure, called as the
--     owner would in SQL.
--   * There (engine/domain/crmCopyRetention.dbtest.ts): signed deliveries
--     through the gateway's own login, the retention job, and a person's note
--     written from another connection while the erasure runs.
--
-- ONE TRANSACTION, ROLLED BACK. ALL DATA IS SYNTHETIC.

\set ON_ERROR_STOP on

begin;

create temporary table cr_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into cr_ids (name, id) values (p_name, p_id) returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from cr_ids where name = p_name;
$$;

-- The contact a number resolves to, or null.
create function pg_temp.contact_of(p_number text) returns bigint
language sql stable as $$
  select c.id from public.contacts c, jsonb_array_elements(c.phone_jsonb) e
   where regexp_replace(e ->> 'number', '[^0-9]', '', 'g') = p_number;
$$;

-- One message from a number to a channel; answers its conversation.
create function pg_temp.message(p_target text, p_wamid text, p_number text) returns uuid
language sql as $$
  select (ops.receive_whatsapp_message(p_target, p_wamid, p_number, 'Synthetic retention message', now())
          ->> 'conversation_id')::uuid;
$$;

create function pg_temp.conversation(p_channel text, p_number text) returns uuid
language sql stable as $$
  select c.id from ops.conversations c
   where c.channel_id = pg_temp.id(p_channel) and c.contact_ref = p_number;
$$;

create function pg_temp.acts(p_contact bigint) returns text
language sql stable as $$
  -- Sorted by name: acts of one transaction share their instant.
  select coalesce(string_agg(a.act, ', ' order by a.act), '')
    from ops.crm_contact_acts a where a.crm_contact_ref = 'crm:contact:' || p_contact::text;
$$;

do $$
declare
  c_source constant text := 'crm-copy-retention-suite';
  ta uuid;
  ca uuid;
  da uuid;
  v_agent uuid;
  v_number text;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('cr-test-alpha', 'CR Alpha', true) returning id into ta;
  perform pg_temp.remember('tenant_a', ta);
  ca := pg_temp.remember('company_a', ops.create_company(ta, 'retention-a', 'Retention A', c_source));
  da := ops.create_department(ta, ca, 'intake', 'Intake', c_source);
  v_agent := ops.create_agent(ta, ca, da, 'front-desk', 'Front Desk', 'Desk assistant', c_source);
  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'cr-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'cr-test: sql suite ceiling', 'cr-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'cr-test: budget', 'cr-owner', ta);
  perform pg_temp.remember('chan_a', ops.configure_whatsapp_channel(
    ta, ca, v_agent, '300000000000095', 'test', 'A test', 'cr-owner'));
  perform pg_temp.remember('chan_b', ops.configure_whatsapp_channel(
    ta, ca, v_agent, '300000000000096', 'test', 'B test', 'cr-owner'));
  foreach v_number in array array['5511900000951', '5511900000952', '5511900000953', '5511900000954',
                                  '5511900000955', '5511900000956', '5511900000957', '5511900000958',
                                  '5511900000959', '5511900000960'] loop
    perform ops.register_test_sender(ta, pg_temp.id('chan_a'), v_number, 'cr-owner');
    perform ops.register_test_sender(ta, pg_temp.id('chan_b'), v_number, 'cr-owner');
  end loop;
  perform ops.record_crm_lead_policy(ta, 50, 'America/Sao_Paulo', 'Contato Teste', 'cr-owner');
end
$$;

-- ---------------------------------------------------------------------------
-- R1. Access: no role reaches the marks or the adapter.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s to %s', p, r), ', ') into v_bad
    from unnest(array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api']) r,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
   where has_table_privilege(r, 'public.crm_contact_edits', p);
  if v_bad is not null then
    raise exception 'R1: the edit marks are reachable: %', v_bad;
  end if;
  select string_agg(format('%s to %s', f, r), ', ') into v_bad
    from unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway',
                      'ops_operator_api']) r,
         unnest(array['public.mark_crm_contact_edit()', 'public.crm_contact_edits_append_only()',
                      'ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)']) f
   where has_function_privilege(r, f, 'execute');
  if v_bad is not null then
    raise exception 'R1: a copy-retention function is executable: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- R2. The marks: the system's own writes leave none; a person's do, once.
-- ---------------------------------------------------------------------------

do $$
declare
  v_contact bigint;
begin
  perform pg_temp.message('300000000000095', 'wamid.CR21', '5511900000951');
  v_contact := pg_temp.contact_of('5511900000951');
  if v_contact is null or pg_temp.acts(v_contact) <> 'created' then
    raise exception 'R2 setup: the lead was not created';
  end if;
  if exists (select 1 from public.crm_contact_edits where contact_id = v_contact) then
    raise exception 'R2: the system''s creation of a lead was marked as a person''s work';
  end if;

  -- A person's edit of the lead profile marks the contact, once.
  update public.lead_profiles set operational_status = 'active' where contact_id = v_contact;
  update public.contacts set first_name = 'Synthetic' where id = v_contact;
  if (select count(*) from public.crm_contact_edits where contact_id = v_contact) <> 1 then
    raise exception 'R2: a person''s edits were not marked once';
  end if;

  -- The marks are append-only.
  begin
    update public.crm_contact_edits set first_edited_at = now();
    raise exception 'R2: an edit mark was changed';
  exception when sqlstate '42501' then null;
  end;
  begin
    delete from public.crm_contact_edits;
    raise exception 'R2: an edit mark was deleted';
  exception when sqlstate '42501' then null;
  end;
  begin
    truncate public.crm_contact_edits;
    raise exception 'R2: the edit marks were truncated';
  exception when sqlstate '42501' then null;
  end;

  -- So the erasure keeps it.
  perform ops.erase_contact_by_number(pg_temp.id('tenant_a'), '5511900000951', 'cr-owner');
  if pg_temp.contact_of('5511900000951') is null or pg_temp.acts(v_contact) <> 'created, kept' then
    raise exception 'R2: a contact a person edited was deleted with its number: %', pg_temp.acts(v_contact);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- R3. A lead no one worked on goes with its number; a lead two conversations
--     name goes once both numbers are erased, whichever first.
-- ---------------------------------------------------------------------------

do $$
declare
  v_contact bigint;
  v_a uuid;
  v_b uuid;
begin
  -- One conversation: the lead, its profile and its attribution are deleted.
  perform pg_temp.message('300000000000095', 'wamid.CR31', '5511900000952');
  v_contact := pg_temp.contact_of('5511900000952');
  if ops.erase_contact_identifier(pg_temp.id('tenant_a'), pg_temp.conversation('chan_a', '5511900000952'),
                                  'erasure', 'cr-owner') <> 'erased' then
    raise exception 'R3: the erasure did not answer erased';
  end if;
  if exists (select 1 from public.contacts where id = v_contact)
     or exists (select 1 from public.lead_profiles where contact_id = v_contact)
     or exists (select 1 from public.acquisition_attributions where contact_id = v_contact)
     or pg_temp.acts(v_contact) <> 'created, deleted' then
    raise exception 'R3: a lead no one worked on outlived its number: %', pg_temp.acts(v_contact);
  end if;

  -- Two conversations, the creating one erased first: kept, then deleted.
  v_a := pg_temp.message('300000000000095', 'wamid.CR32', '5511900000953');
  v_b := pg_temp.message('300000000000096', 'wamid.CR33', '5511900000953');
  v_contact := pg_temp.contact_of('5511900000953');
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_a, 'erasure', 'cr-owner');
  if pg_temp.contact_of('5511900000953') is null then
    raise exception 'R3: a lead another live conversation names was deleted';
  end if;
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_b, 'erasure', 'cr-owner');
  if exists (select 1 from public.contacts where id = v_contact)
     or pg_temp.acts(v_contact) <> 'created, deleted, kept' then
    raise exception 'R3: the lead outlived both its numbers (creator first): %', pg_temp.acts(v_contact);
  end if;

  -- The other order: the finding conversation erased first.
  v_a := pg_temp.message('300000000000095', 'wamid.CR34', '5511900000954');
  v_b := pg_temp.message('300000000000096', 'wamid.CR35', '5511900000954');
  v_contact := pg_temp.contact_of('5511900000954');
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_b, 'erasure', 'cr-owner');
  if pg_temp.contact_of('5511900000954') is null then
    raise exception 'R3: a lead its live creating conversation names was deleted';
  end if;
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_a, 'erasure', 'cr-owner');
  if exists (select 1 from public.contacts where id = v_contact)
     or pg_temp.acts(v_contact) <> 'created, deleted, kept' then
    raise exception 'R3: the lead outlived both its numbers (finder first): %', pg_temp.acts(v_contact);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- R4. A person's work keeps it: a note, a task, a deal, an attribution, a
--     person's opt-out; and a contact the system did not create is never
--     deleted.
-- ---------------------------------------------------------------------------

do $$
declare
  v_number  text;
  v_contact bigint;
  v_kept    text[] := array[]::text[];
begin
  foreach v_number in array array['5511900000955', '5511900000956', '5511900000957'] loop
    perform pg_temp.message('300000000000095', 'wamid.CR4' || right(v_number, 1), v_number);
  end loop;
  insert into public.contact_notes (contact_id, text) values (pg_temp.contact_of('5511900000955'), 'A person''s note');
  insert into public.tasks (contact_id, type, text, due_date)
  values (pg_temp.contact_of('5511900000956'), 'None', 'A person''s task', now());
  insert into public.deals (name, stage, contact_ids)
  values ('cr-test deal', 'opportunity', array[pg_temp.contact_of('5511900000957')]);
  foreach v_number in array array['5511900000955', '5511900000956', '5511900000957'] loop
    v_contact := pg_temp.contact_of(v_number);
    perform ops.erase_contact_by_number(pg_temp.id('tenant_a'), v_number, 'cr-owner');
    if not exists (select 1 from public.contacts where id = v_contact) then
      v_kept := v_kept || v_number;
    end if;
  end loop;
  if cardinality(v_kept) > 0 then
    raise exception 'R4: a lead a person worked on was deleted: %', v_kept;
  end if;
  delete from public.deals where name = 'cr-test deal';

  -- The system's record of the contact's own opt-out is no person's edit, but
  -- the consent ledger keeps the contact it names.
  perform pg_temp.message('300000000000095', 'wamid.CR49', '5511900000959');
  v_contact := pg_temp.contact_of('5511900000959');
  if ops.crm_record_opt_out(pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.conversation('chan_a', '5511900000959'),
                            pg_temp.id('chan_a'), '5511900000959',
                            (select m.task_id from ops.inbound_messages m
                              where m.conversation_id = pg_temp.conversation('chan_a', '5511900000959'))) <> 'recorded' then
    raise exception 'R4 setup: the opt-out was not recorded';
  end if;
  if exists (select 1 from public.crm_contact_edits where contact_id = v_contact) then
    raise exception 'R4: the system''s opt-out record was marked as a person''s work';
  end if;
  perform ops.erase_contact_by_number(pg_temp.id('tenant_a'), '5511900000959', 'cr-owner');
  if not exists (select 1 from public.contacts where id = v_contact)
     or not (select do_not_contact from public.lead_profiles where contact_id = v_contact) then
    raise exception 'R4: the contact''s own opt-out was deleted with its number';
  end if;

  -- A contact a person made before the number wrote is found, never deleted.
  insert into public.contacts (first_name, last_name, phone_jsonb)
  values ('cr-test', 'Existing', '[{"number": "+5511900000958", "type": "Mobile"}]')
  returning id into v_contact;
  perform pg_temp.message('300000000000095', 'wamid.CR48', '5511900000958');
  perform ops.erase_contact_by_number(pg_temp.id('tenant_a'), '5511900000958', 'cr-owner');
  if not exists (select 1 from public.contacts where id = v_contact) or pg_temp.acts(v_contact) <> '' then
    raise exception 'R4: a contact the system did not create was deleted or acted on';
  end if;
  if ops.crm_delete_unedited_lead(pg_temp.id('tenant_a'), pg_temp.id('company_a'),
                                  (select c.id from ops.conversations c where c.channel_id = pg_temp.id('chan_a') limit 1),
                                  pg_temp.id('chan_a'), 'crm:contact:' || v_contact::text) is distinct from 'not_created' then
    raise exception 'R4: the adapter did not refuse a contact the system did not create';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- R5. A creating conversation whose messages were all refused on the record
--     still names its lead while its number is not erased.
-- ---------------------------------------------------------------------------

do $$
declare
  v_contact bigint;
  v_b uuid;
begin
  if ops.receive_whatsapp_message('300000000000095', 'wamid.CR51', '5511900000960', '   ', now()) ->> 'state'
     <> 'refused' then
    raise exception 'R5 setup: the empty message was not refused on the record';
  end if;
  v_contact := pg_temp.contact_of('5511900000960');
  if v_contact is null then
    raise exception 'R5 setup: the refused message did not create the lead';
  end if;
  v_b := pg_temp.message('300000000000096', 'wamid.CR52', '5511900000960');
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_b, 'erasure', 'cr-owner');
  if not exists (select 1 from public.contacts where id = v_contact) then
    raise exception 'R5: a lead its live creating conversation names (with no admission) was deleted';
  end if;
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), pg_temp.conversation('chan_a', '5511900000960'),
                                       'erasure', 'cr-owner');
  if exists (select 1 from public.contacts where id = v_contact) then
    raise exception 'R5: the lead outlived both its numbers';
  end if;
end
$$;

rollback;
