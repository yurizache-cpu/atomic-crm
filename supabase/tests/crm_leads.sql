-- ADR 0026 §C — attacks on the gateway's lead creation.
--
-- The question: can any role reach the lead policy, the contact acts or the
-- lead adapter; can a policy be edited, or a lead be created without one,
-- past its cap, for a sender the owner did not register, twice for one
-- conversation, on a redelivery, for a tenant that does not own the CRM, or
-- for a number another contact already carries under another format; and
-- what does a created lead hold?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: access, the guards, and the receive function's lead step called
--     as the owner would see it in SQL.
--   * There (engine/domain/whatsappLeads.dbtest.ts): signed deliveries through
--     the gateway's own login, the profile name rule, concurrent duplicate
--     deliveries, and the first message answered.
--
-- ONE TRANSACTION, ROLLED BACK. ALL DATA IS SYNTHETIC.

\set ON_ERROR_STOP on

begin;

create temporary table cl_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into cl_ids (name, id) values (p_name, p_id) returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from cl_ids where name = p_name;
$$;

create function pg_temp.contacts_with(p_number text) returns bigint
language sql stable as $$
  select count(*) from public.contacts c, jsonb_array_elements(c.phone_jsonb) e
   where regexp_replace(e ->> 'number', '[^0-9]', '', 'g') = p_number;
$$;

do $$
declare
  c_source constant text := 'crm-leads-suite';
  ta uuid;
  tb uuid;
  ca uuid;
  da uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('cl-test-alpha', 'CL Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('cl-test-beta', 'CL Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  ca := pg_temp.remember('company_a', ops.create_company(ta, 'leads-a', 'Leads A', c_source));
  da := ops.create_department(ta, ca, 'intake', 'Intake', c_source);
  perform pg_temp.remember('agent_a', ops.create_agent(ta, ca, da, 'front-desk', 'Front Desk', 'Desk assistant', c_source));
  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'cl-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'cl-test: sql suite ceiling', 'cl-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'cl-test: budget', 'cl-owner', ta);
  perform pg_temp.remember('chan_a', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000081', 'test', 'A test', 'cl-owner'));
  perform ops.register_test_sender(ta, pg_temp.id('chan_a'), '5511900000081', 'cl-owner');
  perform ops.register_test_sender(ta, pg_temp.id('chan_a'), '5511900000082', 'cl-owner');
  perform ops.register_test_sender(ta, pg_temp.id('chan_a'), '5511900000083', 'cl-owner');
  perform ops.register_test_sender(ta, pg_temp.id('chan_a'), '5511900000084', 'cl-owner');
  perform ops.register_test_sender(ta, pg_temp.id('chan_a'), '5511900000085', 'cl-owner');
end
$$;

-- ---------------------------------------------------------------------------
-- L1. Access: no role reaches the policy, the acts or the adapter; the gateway
--     executes exactly its two entry points.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s on %s to %s', v.p, v.t, v.r), ', ') into v_bad
    from (select t, r, p
            from unnest(array['ops.crm_lead_policies', 'ops.crm_contact_acts']) t,
                 unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway',
                              'ops_operator_api']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, v.t, v.p);
  if v_bad is not null then
    raise exception 'L1: a lead table is reachable: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('crm_create_whatsapp_lead', 'crm_phone_suffix_match', 'record_crm_lead_policy',
                       'retire_crm_lead_policy', 'guard_crm_lead_policy', 'guard_crm_contact_act')
     and (p.prosecdef
          or exists (select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker',
                                                'ops_gateway', 'ops_operator_api']) r
                      where has_function_privilege(r, p.oid, 'execute')));
  if v_bad is not null then
    raise exception 'L1: a lead function is a DEFINER or reachable by a role: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and has_function_privilege('ops_gateway', p.oid, 'execute');
  if v_bad is distinct from
       'ops.receive_whatsapp_message(text,text,text,text,timestamp with time zone,text), ops.receive_whatsapp_status(text,text,text,timestamp with time zone,text,text,text)' then
    raise exception 'L1: the gateway executes %, not exactly its two entry points', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- L2. The policy: owner data, recorded in force, never edited, retired once.
-- ---------------------------------------------------------------------------

do $$
declare
  v1 uuid;
  v2 uuid;
begin
  begin
    perform ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 50, 'Mars/Olympus_Mons', 'Contato Teste', 'cl-owner');
    raise exception 'L2: a policy with an unknown time zone was recorded';
  exception when sqlstate 'OS400' then null;
  end;
  begin
    perform ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 0, 'America/Sao_Paulo', 'Contato Teste', 'cl-owner');
    raise exception 'L2: a cap of zero was recorded';
  exception when check_violation then null;
  end;
  begin
    perform ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 5, 'America/Sao_Paulo', '=cmd', 'cl-owner');
    raise exception 'L2: a placeholder starting a formula was recorded';
  exception when check_violation then null;
  end;
  v1 := ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 5, 'America/Sao_Paulo', 'Contato Teste', 'cl-owner');
  begin
    update ops.crm_lead_policies set daily_cap = 900 where id = v1;
    raise exception 'L2: a policy was edited';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.crm_lead_policies where id = v1;
    raise exception 'L2: the policy in force was deleted';
  exception when sqlstate 'OS403' then null;
  end;
  -- A new policy retires the one in force: one at a time.
  v2 := ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 2, 'America/Sao_Paulo', 'Contato Teste', 'cl-owner');
  if (select count(*) from ops.crm_lead_policies where tenant_id = pg_temp.id('tenant_a') and retired_at is null) <> 1
     or (select retired_at from ops.crm_lead_policies where id = v1) is null then
    raise exception 'L2: recording a policy did not retire the one before it';
  end if;
  begin
    update ops.crm_lead_policies set retired_by = 'cl-owner', retire_reason = 'again' where id = v1;
    raise exception 'L2: a retired policy was retired again';
  exception when sqlstate 'OS403' then null;
  end;
  delete from ops.crm_lead_policies where id = v1;
  if not ops.retire_crm_lead_policy(pg_temp.id('tenant_a'), 'L2 pause', 'cl-owner')
     or ops.retire_crm_lead_policy(pg_temp.id('tenant_a'), 'L2 pause', 'cl-owner') then
    raise exception 'L2: retiring the policy in force did not answer once';
  end if;
  perform pg_temp.remember('policy_2', v2);
end
$$;

-- ---------------------------------------------------------------------------
-- L3. The lead step at admission.
-- ---------------------------------------------------------------------------

do $$
declare
  v_answer jsonb;
  v_conv   uuid;
  v_ref    text;
  v_id     bigint;
begin
  -- No policy in force: nothing is created, and the message goes on as an
  -- unknown number.
  v_answer := ops.receive_whatsapp_message('300000000000081', 'wamid.CL1', '5511900000081',
                                           'Synthetic lead question one', now());
  v_conv := (v_answer ->> 'conversation_id')::uuid;
  perform pg_temp.remember('conv_81', v_conv);
  if v_answer ->> 'state' <> 'admitted'
     or pg_temp.contacts_with('5511900000081') <> 0
     or (select array_agg(act) from ops.crm_contact_acts where conversation_id = v_conv) is distinct from array['skipped:no_cap']
     or (select contact_resolution from ops.inbound_messages where external_message_id = 'wamid.CL1') <> 'not_found' then
    raise exception 'L3: with no policy a lead was created, or the skip was not recorded';
  end if;

  -- With a policy, the conversation's next message creates the lead before the
  -- CRM is read: the admission finds it.
  perform ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 2, 'America/Sao_Paulo', 'Contato Teste', 'cl-owner');
  v_answer := ops.receive_whatsapp_message('300000000000081', 'wamid.CL2', '5511900000081',
                                           'Synthetic lead question two', now() - interval '1 minute', 'Maria');
  select crm_contact_ref into v_ref from ops.crm_contact_acts where conversation_id = v_conv and act = 'created';
  v_id := substring(v_ref from 'crm:contact:([0-9]+)')::bigint;
  if v_answer ->> 'state' <> 'admitted' or v_ref is null
     or (select contact_resolution from ops.inbound_messages where external_message_id = 'wamid.CL2') <> 'found'
     or (select do_not_contact from ops.inbound_messages where external_message_id = 'wamid.CL2')
     or (select crm_contact_ref from ops.inbound_messages where external_message_id = 'wamid.CL2') <> v_ref then
    raise exception 'L3: the lead was not created before the admission read the CRM';
  end if;
  if not exists (select 1 from public.contacts c
                  where c.id = v_id and c.first_name = 'Maria' and c.last_name = '' and c.sales_id is null
                    and c.tags = '{}'::bigint[] and c.email_jsonb = '[]'::jsonb
                    and c.phone_jsonb = '[{"number": "+5511900000081", "type": "Other"}]'::jsonb)
     or not exists (select 1 from public.lead_profiles p where p.contact_id = v_id and not p.do_not_contact)
     or (select count(*) from public.acquisition_attributions a where a.contact_id = v_id and a.source = 'whatsapp') <> 1 then
    raise exception 'L3: the created lead is not the contact, the lead profile and the one whatsapp attribution';
  end if;
  if (select count(*) from ops.events e
       where e.tenant_id = pg_temp.id('tenant_a') and e.type = 'lead.created'
         and e.idempotency_key = format('lead:%s:created', v_conv)
         and e.payload = jsonb_build_object('channel_id', pg_temp.id('chan_a'), 'conversation_id', v_conv)) <> 1 then
    raise exception 'L3: lead.created was not emitted once with the channel and the conversation';
  end if;

  -- A redelivery of either message, and the conversation's next message,
  -- create nothing more.
  perform ops.receive_whatsapp_message('300000000000081', 'wamid.CL2', '5511900000081',
                                       'Synthetic lead question two', now() - interval '1 minute', 'Maria');
  perform ops.receive_whatsapp_message('300000000000081', 'wamid.CL3', '5511900000081',
                                       'Synthetic lead question three', now());
  if pg_temp.contacts_with('5511900000081') <> 1
     or (select count(*) from ops.crm_contact_acts where conversation_id = v_conv) <> 2 then
    raise exception 'L3: a redelivery or a later message created or recorded again';
  end if;

  -- A sender the owner did not register stays unknown.
  v_answer := ops.receive_whatsapp_message('300000000000081', 'wamid.CL4', '5511900000089',
                                           'Synthetic unregistered question', now());
  if pg_temp.contacts_with('5511900000089') <> 0
     or exists (select 1 from ops.crm_contact_acts where conversation_id = (v_answer ->> 'conversation_id')::uuid) then
    raise exception 'L3: a sender the owner did not register became a lead';
  end if;

  -- A refused message (an audio) creates the lead too; the name the database
  -- does not accept falls back to the placeholder.
  v_answer := ops.receive_whatsapp_message('300000000000081', 'wamid.CL5', '5511900000082', null, now(), '=cmd');
  if v_answer ->> 'state' <> 'refused' or pg_temp.contacts_with('5511900000082') <> 1
     or not exists (select 1 from public.contacts c, jsonb_array_elements(c.phone_jsonb) e
                     where e ->> 'number' = '+5511900000082' and c.first_name = 'Contato Teste') then
    raise exception 'L3: a refused message did not create the lead, or an unsafe name was used';
  end if;

  -- The day's cap: two created, the third is skipped and recorded.
  v_answer := ops.receive_whatsapp_message('300000000000081', 'wamid.CL6', '5511900000083',
                                           'Synthetic lead question four', now());
  if pg_temp.contacts_with('5511900000083') <> 0
     or (select array_agg(act) from ops.crm_contact_acts
          where conversation_id = (v_answer ->> 'conversation_id')::uuid) is distinct from array['skipped:cap'] then
    raise exception 'L3: the daily cap did not stop the third lead';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- L4. A near-duplicate is a person's; another tenant's adapter reads nothing.
-- ---------------------------------------------------------------------------

do $$
declare
  v_answer jsonb;
  v_task   uuid;
begin
  perform ops.record_crm_lead_policy(pg_temp.id('tenant_a'), 100, 'America/Sao_Paulo', 'Contato Teste', 'cl-owner');
  -- The same person without the country code: the last eight digits match.
  insert into public.contacts (first_name, last_name, phone_jsonb)
  values ('cl-test', 'Near', '[{"number": "(11) 90000-0084", "type": "Mobile"}]');
  v_answer := ops.receive_whatsapp_message('300000000000081', 'wamid.CL7', '5511900000084',
                                           'Synthetic near duplicate question', now());
  v_task := (v_answer ->> 'task_id')::uuid;
  if pg_temp.contacts_with('5511900000084') <> 0
     or (select array_agg(act) from ops.crm_contact_acts
          where conversation_id = (v_answer ->> 'conversation_id')::uuid) is distinct from array['skipped:possible_match']
     or not exists (select 1 from ops.exceptions e
                     where e.task_id = v_task and e.kind = 'contact_unresolved' and e.detail = 'possible_match'
                       and e.resolved_at is null) then
    raise exception 'L4: a near-duplicate created a lead, or was not raised for a person';
  end if;

  -- A tenant that does not own the local CRM reads nothing and creates nothing.
  if ops.crm_create_whatsapp_lead(pg_temp.id('tenant_b'), pg_temp.id('company_a'), pg_temp.id('chan_a'),
                                  (v_answer ->> 'conversation_id')::uuid, '5511900000085', null, now())
     is distinct from 'unavailable' then
    raise exception 'L4: the adapter served a tenant that does not own the local CRM';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- L5. The acts are append-only; they leave only with their conversation.
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    update ops.crm_contact_acts set act = 'skipped:cap' where conversation_id = pg_temp.id('conv_81');
    raise exception 'L5: an act was changed';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.crm_contact_acts where conversation_id = pg_temp.id('conv_81');
    raise exception 'L5: an act was deleted while its conversation exists';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    truncate ops.crm_contact_acts;
    raise exception 'L5: the acts were truncated';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('conv_81'), pg_temp.id('chan_a'), 'created');
    raise exception 'L5: a creation naming no contact was recorded';
  exception when check_violation then null;
  end;
end
$$;

rollback;
