-- ADR 0026 §C — attacks on the CRM's consent ledger and the opt-out record.
--
-- The question: does every change of the CRM's opt-out flag reach the ledger
-- with the right origin (a person, or the system naming the message); can
-- anyone read, change or empty the ledger; can a person's write pass for the
-- system's; can an opt-out request be changed after the fact, settled twice or
-- removed on its own; and does the CRM adapter set the flag and nothing else?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: the ledger's writer and guards, the request's guards and the
--     adapter, called as the owner would in SQL.
--   * There (engine/domain/crmOptOut.dbtest.ts): the screening's request, the
--     acknowledgement's move, the worker's record job, a dismissal and an
--     erasure.
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

rollback;
