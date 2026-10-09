-- ADR 0026 §C — attacks on the CRM's consent ledger and the opt-out record.
--
-- The question: does every change of the CRM's opt-out flag reach the ledger
-- with the right origin (a person, or the system naming the message); can
-- anyone read, change or empty the ledger; can a person's write pass for the
-- system's; can an opt-out request be changed after the fact, settled twice or
-- removed on its own; and does the CRM adapter set the flag and nothing else?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: the ledger's writer and guards, the request's guards, the two
--     adapters (the record and the lift) called as the owner would in SQL, and
--     the CRM form's clear guard as the owner, service_role and an owner at
--     aal2 through the CRM's row rules.
--   * There (engine/domain/crmOptOut.dbtest.ts): the screening's request, the
--     acknowledgement's move, the worker's record job, a dismissal, an
--     erasure, and the screening's lift with the conversation given back.
--
-- ONE TRANSACTION, ROLLED BACK. ALL DATA IS SYNTHETIC.

\set ON_ERROR_STOP on

begin;

create temporary table cc_ids (name text primary key, id text not null) on commit drop;

create function pg_temp.remember(p_name text, p_id text) returns text
language sql as $$
  insert into cc_ids (name, id) values (p_name, p_id) returning id;
$$;

create function pg_temp.id(p_name text) returns text
language sql stable as $$
  select id from cc_ids where name = p_name;
$$;

create function pg_temp.entries(p_contact bigint) returns text
language sql stable as $$
  select coalesce(string_agg(format('%s>%s:%s', coalesce(from_value::text, '-'), to_value::text, origin), ', '
                             order by changed_at, id), '')
    from public.lead_consent_changes where contact_id = p_contact;
$$;

do $$
declare
  v_contact bigint;
begin
  insert into public.contacts (first_name, last_name, phone_jsonb)
  values ('cc-test', 'Consent', '[{"number": "+5511900000091", "type": "Mobile"}]')
  returning id into v_contact;
  perform pg_temp.remember('contact', v_contact::text);
end
$$;

-- ---------------------------------------------------------------------------
-- C1. The writer: every change, with its origin.
-- ---------------------------------------------------------------------------

do $$
declare
  v_contact bigint := pg_temp.id('contact')::bigint;
  v_task    text := 'task:00000000-0000-4000-8000-000000000091';
begin
  -- The CRM's own trigger made a profile with the flag false: no entry.
  if pg_temp.entries(v_contact) <> '' then
    raise exception 'C1: a new profile with no opt-out made an entry';
  end if;
  -- A person sets it (the CRM form), then saves it again unchanged (a merge
  -- folding in an opt-out names it): both are a person's.
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  -- A person clears it; clearing it again changes nothing and records nothing.
  update public.lead_profiles set do_not_contact = false where contact_id = v_contact;
  update public.lead_profiles set do_not_contact = false where contact_id = v_contact;
  -- A write that does not name the flag records nothing.
  update public.lead_profiles set operational_status = 'active' where contact_id = v_contact;
  if pg_temp.entries(v_contact) <> 'false>true:person, true>true:person, true>false:person' then
    raise exception 'C1: a person''s writes were recorded as %', pg_temp.entries(v_contact);
  end if;

  -- The system's write names the message, and the mark is spent on it.
  perform set_config('ops.consent_origin', 'system_opt_out:' || v_task, true);
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  if current_setting('ops.consent_origin', true) <> ''
     or (select origin || ' ' || reason_ref from public.lead_consent_changes
          where contact_id = v_contact order by changed_at desc, id desc limit 1)
        is distinct from 'system_opt_out ' || v_task then
    raise exception 'C1: the system''s write was not recorded with its message, or its mark survived';
  end if;
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  if (select origin from public.lead_consent_changes
       where contact_id = v_contact order by changed_at desc, id desc limit 1) <> 'person' then
    raise exception 'C1: a write after the system''s passed for the system''s';
  end if;

  -- A malformed mark is a person's write.
  perform set_config('ops.consent_origin', 'system_lift:task:not-a-task', true);
  update public.lead_profiles set do_not_contact = false where contact_id = v_contact;
  if (select origin from public.lead_consent_changes
       where contact_id = v_contact order by changed_at desc, id desc limit 1) <> 'person' then
    raise exception 'C1: a malformed mark was taken for the system';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- C2. The ledger: append-only, read by no application role.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  begin
    update public.lead_consent_changes set origin = 'person';
    raise exception 'C2: a ledger entry was changed';
  exception when sqlstate '42501' then null;
  end;
  begin
    delete from public.lead_consent_changes;
    raise exception 'C2: a ledger entry was deleted';
  exception when sqlstate '42501' then null;
  end;
  begin
    truncate public.lead_consent_changes;
    raise exception 'C2: the ledger was truncated';
  exception when sqlstate '42501' then null;
  end;
  select string_agg(format('%s to %s', p, r), ', ') into v_bad
    from unnest(array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api']) r,
         unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
   where has_table_privilege(r, 'public.lead_consent_changes', p);
  if v_bad is not null then
    raise exception 'C2: the consent ledger is reachable: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- C3. The adapter sets the flag and nothing else; the request is settled once.
-- ---------------------------------------------------------------------------

do $$
declare
  c_source constant text := 'crm-consent-suite';
  ta      uuid;
  ca      uuid;
  da      uuid;
  v_agent uuid;
  v_chan  uuid;
  v_ans   jsonb;
  v_conv  uuid;
  v_task  uuid;
  v_req   uuid;
  v_before jsonb;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('cc-test-alpha', 'CC Alpha', true) returning id into ta;
  ca := ops.create_company(ta, 'consent-a', 'Consent A', c_source);
  da := ops.create_department(ta, ca, 'intake', 'Intake', c_source);
  v_agent := ops.create_agent(ta, ca, da, 'front-desk', 'Front Desk', 'Desk assistant', c_source);
  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'cc-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'cc-test: sql suite ceiling', 'cc-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'cc-test: budget', 'cc-owner', ta);
  v_chan := ops.configure_whatsapp_channel(ta, ca, v_agent, '300000000000091', 'test', 'A test', 'cc-owner');
  perform ops.register_test_sender(ta, v_chan, '5511900000091', 'cc-owner');
  v_ans := ops.receive_whatsapp_message('300000000000091', 'wamid.CC1', '5511900000091', 'Synthetic consent message', now());
  v_conv := (v_ans ->> 'conversation_id')::uuid;
  v_task := (v_ans ->> 'task_id')::uuid;

  -- The adapter: the flag true, the profile otherwise untouched, the act.
  update public.lead_profiles set do_not_contact = false where contact_id = pg_temp.id('contact')::bigint;
  select to_jsonb(lp) - 'do_not_contact' - 'updated_at' into v_before
    from public.lead_profiles lp where lp.contact_id = pg_temp.id('contact')::bigint;
  -- One statement each: an expression reads the snapshot taken before its own calls.
  if ops.crm_record_opt_out(ta, ca, v_conv, v_chan, '5511900000091', v_task) <> 'recorded' then
    raise exception 'C3: the adapter did not record the opt-out';
  end if;
  if ops.crm_record_opt_out(ta, ca, v_conv, v_chan, '5511900000091', v_task) <> 'already_recorded' then
    raise exception 'C3: the adapter did not answer an opt-out already recorded';
  end if;
  if not (select do_not_contact from public.lead_profiles where contact_id = pg_temp.id('contact')::bigint)
     or (select to_jsonb(lp) - 'do_not_contact' - 'updated_at' from public.lead_profiles lp
          where lp.contact_id = pg_temp.id('contact')::bigint) is distinct from v_before
     or (select count(*) from ops.crm_contact_acts where conversation_id = v_conv and act = 'opted_out') <> 2 then
    raise exception 'C3: the adapter did more than set the flag, or did not record its act';
  end if;
  if ops.crm_record_opt_out(ta, ca, v_conv, v_chan, '5511900000099', v_task) <> 'unresolved' then
    raise exception 'C3: an opt-out was recorded for a number no contact has';
  end if;

  -- The request: open at birth, identity fixed, settled once, never removed
  -- on its own.
  insert into ops.exceptions (tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
                              conversation_id, raised_by, last_task_id)
  values (ta, ca, v_task, 'opt_out', 'normal', 'conversation', v_conv, v_conv, 'cc-suite', v_task);
  v_req := ops.request_crm_opt_out_record(ta, ca, v_conv, v_task);
  if v_req is null or ops.request_crm_opt_out_record(ta, ca, v_conv, v_task) is not null then
    raise exception 'C3: the request was not made once per message';
  end if;
  begin
    update ops.crm_opt_out_requests set due_at = now() where id = v_req;
    raise exception 'C3: a request''s due instant was changed';
  exception when sqlstate 'OS403' then null;
  end;
  update ops.crm_opt_out_requests set outcome = 'recorded' where id = v_req;
  begin
    update ops.crm_opt_out_requests set outcome = 'dismissed' where id = v_req;
    raise exception 'C3: a request was settled twice';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.crm_opt_out_requests where id = v_req;
    raise exception 'C3: a request was deleted while its conversation exists';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    truncate ops.crm_opt_out_requests;
    raise exception 'C3: the requests were truncated';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- C4. The CRM form clears a flag a person set, never the contact's own
--     system-recorded opt-out: not as the owner in SQL, not as service_role,
--     not as an owner at aal2 through the CRM's row rules, and no mark but the
--     system's well-formed lift opens it.
-- ---------------------------------------------------------------------------

-- One update as a role, answering the SQLSTATE and the message (or 'ok').
create function pg_temp.clear_as(p_role text, p_contact bigint, p_claims text default null) returns text
language plpgsql as $f$
declare
  v_state text;
  v_msg   text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  begin
    if p_role is not null then
      execute format('set local role %I', p_role);
    end if;
    update public.lead_profiles set do_not_contact = false where contact_id = p_contact;
    reset role;
    return 'ok';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    return v_state || ' ' || v_msg;
  end;
end
$f$;

do $$
declare
  v_contact bigint := pg_temp.id('contact')::bigint;
  v_user    uuid := gen_random_uuid();
  v_session uuid := gen_random_uuid();
  v_claims  text;
  v_answer  text;
  v_before  text;
  c_refused constant text :=
    'OS403 this contact asked to stop by message: only the contact''s own later message lifts it';
begin
  -- C3 left the contact's own opt-out recorded as the system's.
  if not (select do_not_contact from public.lead_profiles where contact_id = v_contact)
     or (select origin from public.lead_consent_changes
          where contact_id = v_contact order by changed_at desc, id desc limit 1) <> 'system_opt_out' then
    raise exception 'C4 setup: the contact''s opt-out is not the system''s';
  end if;
  v_before := pg_temp.entries(v_contact);

  v_answer := pg_temp.clear_as(null, v_contact);
  if v_answer <> c_refused then
    raise exception 'C4: the owner in SQL cleared the contact''s own opt-out: %', v_answer;
  end if;
  perform set_config('ops.consent_origin', 'system_lift:task:not-a-task', true);
  if pg_temp.clear_as(null, v_contact) <> c_refused then
    raise exception 'C4: a malformed lift mark opened the guard';
  end if;
  perform set_config('ops.consent_origin', 'system_opt_out:task:00000000-0000-4000-8000-000000000091', true);
  if pg_temp.clear_as(null, v_contact) <> c_refused then
    raise exception 'C4: an opt-out mark opened the guard';
  end if;
  perform set_config('ops.consent_origin', '', true);
  if pg_temp.clear_as('service_role', v_contact) <> c_refused then
    raise exception 'C4: service_role cleared the contact''s own opt-out';
  end if;

  -- An owner at aal2, through the CRM's row rules (the browser's path).
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'cc-owner@test.local', 'x', now(), now(), now(), '{}',
          jsonb_build_object('first_name', 'Synthetic', 'last_name', 'Owner'));
  insert into auth.sessions (id, user_id, created_at, updated_at, aal) values (v_session, v_user, now(), now(), 'aal2');
  update public.sales set role = 'owner', administrator = true where user_id = v_user;
  delete from ops.operator_assurance_exemption;
  v_claims := jsonb_build_object(
    'sub', v_user, 'role', 'authenticated', 'aud', 'authenticated', 'session_id', v_session,
    'is_anonymous', false, 'aal', 'aal2', 'exp', extract(epoch from now() + interval '1 hour')::bigint)::text;
  v_answer := pg_temp.clear_as('authenticated', v_contact, v_claims);
  if v_answer <> c_refused then
    raise exception 'C4: an owner at aal2 cleared the contact''s own opt-out through the CRM: %', v_answer;
  end if;
  perform set_config('request.jwt.claims', '', true);

  if not (select do_not_contact from public.lead_profiles where contact_id = v_contact)
     or pg_temp.entries(v_contact) <> v_before then
    raise exception 'C4: a refused clear changed the flag or the ledger';
  end if;

  -- The guard has no other effect: no role executes it.
  if exists (select 1 from unnest(array['anon', 'authenticated', 'service_role']) r
              where has_function_privilege(r, 'public.refuse_system_opt_out_clear()', 'execute')) then
    raise exception 'C4: an application role executes the guard';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- C5. The lift: only the contact's own later message, as the CRM holds it
--     now; never an earlier message, never over a newer opt-out, never a flag
--     a person set; nothing else changes.
-- ---------------------------------------------------------------------------

do $$
declare
  v_contact bigint := pg_temp.id('contact')::bigint;
  v_ref     text := 'crm:contact:' || pg_temp.id('contact');
  ta        uuid;
  ca        uuid;
  v_chan    uuid;
  v_conv    uuid;
  v_m       jsonb;
  v_task    uuid;
  v_before  jsonb;
  v_other   uuid;
begin
  select t.id into ta from ops.tenants t where t.slug = 'cc-test-alpha';
  select c.id into ca from ops.companies c where c.tenant_id = ta and c.slug = 'consent-a';
  select ch.id into v_chan from ops.communication_channels ch where ch.tenant_id = ta;
  select c.id into v_conv from ops.conversations c where c.tenant_id = ta;

  -- The gateway clamps a message's instant to the transaction's, so this
  -- suite's messages are ordered in the past. The contact's own opt-out,
  -- recorded by the system from a message ten minutes ago.
  v_m := ops.receive_whatsapp_message('300000000000091', 'wamid.CC1b', '5511900000091', 'Synthetic opt-out',
                                      now() - interval '10 minutes');
  if ops.crm_record_opt_out(ta, ca, v_conv, v_chan, '5511900000091', (v_m ->> 'task_id')::uuid) <> 'already_recorded' then
    raise exception 'C5 setup: the opt-out was not recorded again';
  end if;

  -- A message from before it never lifts it.
  v_m := ops.receive_whatsapp_message('300000000000091', 'wamid.CC0', '5511900000091', 'Synthetic earlier message',
                                      now() - interval '20 minutes');
  if ops.crm_lift_opt_out(ta, ca, v_conv, v_chan, '5511900000091', (v_m ->> 'task_id')::uuid) <> 'kept' then
    raise exception 'C5: a message from before the opt-out lifted it';
  end if;

  -- A later message, while a newer message asked to stop again: kept.
  v_m := ops.receive_whatsapp_message('300000000000091', 'wamid.CC3', '5511900000091', 'Synthetic newer opt-out',
                                      now() - interval '5 minutes');
  if ops.request_crm_opt_out_record(ta, ca, v_conv, (v_m ->> 'task_id')::uuid) is null then
    raise exception 'C5 setup: the newer opt-out was not requested';
  end if;
  v_m := ops.receive_whatsapp_message('300000000000091', 'wamid.CC2', '5511900000091', 'Synthetic later message',
                                      now() - interval '7 minutes');
  if ops.crm_lift_opt_out(ta, ca, v_conv, v_chan, '5511900000091', (v_m ->> 'task_id')::uuid) <> 'kept' then
    raise exception 'C5: an older message undid a newer opt-out';
  end if;

  -- A message after every opt-out lifts it: the flag false, recorded as the
  -- system's lift naming that message, the act, and nothing else changed.
  v_m := ops.receive_whatsapp_message('300000000000091', 'wamid.CC4', '5511900000091', 'Synthetic message after',
                                      now());
  v_task := (v_m ->> 'task_id')::uuid;
  select to_jsonb(lp) - 'do_not_contact' - 'updated_at' into v_before
    from public.lead_profiles lp where lp.contact_id = v_contact;
  if ops.crm_lift_opt_out(ta, ca, v_conv, v_chan, '5511900000091', v_task) <> 'lifted' then
    raise exception 'C5: the contact''s own later message did not lift the opt-out';
  end if;
  if (select do_not_contact from public.lead_profiles where contact_id = v_contact)
     or (select to_jsonb(lp) - 'do_not_contact' - 'updated_at' from public.lead_profiles lp
          where lp.contact_id = v_contact) is distinct from v_before
     or (select format('%s>%s:%s:%s', from_value::text, to_value::text, origin, reason_ref) from public.lead_consent_changes
          where contact_id = v_contact order by changed_at desc, id desc limit 1)
        is distinct from format('true>false:system_lift:task:%s', v_task)
     or (select count(*) from ops.crm_contact_acts
          where conversation_id = v_conv and act = 'opt_out_lifted' and crm_contact_ref = v_ref
            and task_id = v_task) <> 1
     or current_setting('ops.consent_origin', true) <> '' then
    raise exception 'C5: the lift did more than clear the flag, or did not record it as the system''s';
  end if;
  if ops.crm_lift_opt_out(ta, ca, v_conv, v_chan, '5511900000091', v_task) <> 'clear' then
    raise exception 'C5: a cleared flag was not answered clear';
  end if;

  -- A flag a person set is never lifted by a message.
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  v_m := ops.receive_whatsapp_message('300000000000091', 'wamid.CC5', '5511900000091', 'Synthetic message again',
                                      now());
  if ops.crm_lift_opt_out(ta, ca, v_conv, v_chan, '5511900000091', (v_m ->> 'task_id')::uuid) <> 'kept' then
    raise exception 'C5: a message lifted a flag a person set';
  end if;
  if not (select do_not_contact from public.lead_profiles where contact_id = v_contact) then
    raise exception 'C5: a person''s flag was cleared';
  end if;

  -- No single contact, or a tenant that does not own the CRM: unresolved.
  if ops.crm_lift_opt_out(ta, ca, v_conv, v_chan, '5511900000099', v_task) <> 'unresolved' then
    raise exception 'C5: a lift was tried for a number no contact has';
  end if;
  insert into ops.tenants (slug, name) values ('cc-test-beta', 'CC Beta') returning id into v_other;
  if ops.crm_lift_opt_out(v_other, ca, v_conv, v_chan, '5511900000091', v_task) <> 'unresolved' then
    raise exception 'C5: a tenant that does not own the CRM reached it';
  end if;
end
$$;

rollback;
