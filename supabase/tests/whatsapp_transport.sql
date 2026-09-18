-- Phase 2B — attacks on the WhatsApp transport and human-approved outbound.
--
-- The question: can a payload choose a tenant, can a production channel's
-- content become work while BASELINE Q8 is open (even by the owner's own
-- insert), can the CRM adapter write or guess, can a send move backwards or
-- be re-sent, and can any application role, the worker or the gateway reach
-- more than it was granted?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suites:
--   * Here: the access posture, attempted role by role; the trusted mapping;
--     the Q8 triggers; the CRM adapter's answers; the send state machine.
--   * There (engine/domain/whatsappInbound.dbtest.ts and
--     whatsappOutbound.dbtest.ts): signed deliveries through the gateway's own
--     login, a real worker, a counting transport, fresh consent, crashes and
--     status reconciliation.
--
-- ONE TRANSACTION, ROLLED BACK.

\set ON_ERROR_STOP on

begin;

create temporary table p2b_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into p2b_ids (name, id) values (p_name, p_id) returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from p2b_ids where name = p_name;
$$;

-- Two tenants; A owns this deployment's CRM for the length of the transaction.
do $$
declare
  c_source constant text := 'phase2b-suite';
  ta uuid;
  tb uuid;
  ca uuid;
  cb uuid;
  da uuid;
  db uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('p2b-test-alpha', 'P2B Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('p2b-test-beta', 'P2B Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  ca := pg_temp.remember('company_a', ops.create_company(ta, 'clinic-a', 'Clinic A', c_source));
  cb := pg_temp.remember('company_b', ops.create_company(tb, 'clinic-b', 'Clinic B', c_source));
  da := ops.create_department(ta, ca, 'intake', 'Intake', c_source);
  db := ops.create_department(tb, cb, 'intake', 'Intake', c_source);
  perform pg_temp.remember('agent_a', ops.create_agent(ta, ca, da, 'lead-triage', 'Lead Triage', 'Intake assistant', c_source));
  perform pg_temp.remember('agent_b', ops.create_agent(tb, cb, db, 'lead-triage', 'Lead Triage', 'Intake assistant', c_source));

  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'p2b-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'p2b-test: sql suite ceiling', 'p2b-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'p2b-test: budget', 'p2b-owner', ta);
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'p2b-test: budget', 'p2b-owner', tb);

  -- Channels: A test, A production, B test.
  perform pg_temp.remember('chan_a_test', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000001', 'test', 'A test', 'p2b-owner'));
  perform pg_temp.remember('chan_a_prod', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000002', 'production', 'A production', 'p2b-owner'));
  perform pg_temp.remember('chan_b_test', ops.configure_whatsapp_channel(
    tb, cb, pg_temp.id('agent_b'), '300000000000003', 'test', 'B test', 'p2b-owner'));
end
$$;

-- ---------------------------------------------------------------------------
-- A. Access, attempted role by role.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- A1. RLS enabled and forced on every Phase 2B table.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname in ('communication_channels', 'conversations', 'outbound_messages')
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'A1: RLS is not enabled and forced on %', v_bad;
  end if;

  -- A2. No role holds anything on the Phase 2B tables.
  select string_agg(format('%s on %s to %s', v.p, v.t, v.r), ', ') into v_bad
    from (select t, r, p
            from unnest(array['ops.communication_channels', 'ops.conversations', 'ops.outbound_messages',
                              'ops.inbound_messages', 'ops.review_items']) t,
                 unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, v.t, v.p);
  if v_bad is not null then
    raise exception 'A2: a Phase 2B table is reachable: %', v_bad;
  end if;

  -- A3. The gateway executes exactly its two functions; nobody else executes
  --     them; no application role executes an owner service.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and has_function_privilege('ops_gateway', p.oid, 'execute')
     and p.proname not in ('receive_whatsapp_message', 'receive_whatsapp_status');
  if v_bad is not null then
    raise exception 'A3: ops_gateway executes more than its two functions: %', v_bad;
  end if;
  select string_agg(format('%s to %s', p.proname, r.rolname), ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r(rolname)
   where n.nspname = 'ops'
     and p.proname in ('receive_whatsapp_message', 'receive_whatsapp_status', 'configure_whatsapp_channel',
                       'request_outbound_send', 'begin_outbound_send', 'settle_outbound_send',
                       'mark_outbound_indeterminate', 'crm_contact_by_phone', 'whatsapp_send_eligibility',
                       'admit_inbound_core')
     and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_bad is not null then
    raise exception 'A3: a Phase 2B function is executable by an application role: %', v_bad;
  end if;
  if (select rolcanlogin or rolsuper or rolbypassrls from pg_roles where rolname = 'ops_gateway') then
    raise exception 'A3: ops_gateway can log in, or carries a blanket attribute';
  end if;

  -- A5. The gateway's two functions are the only Phase 2B DEFINERs, and both
  --     pin an empty search path. Every owner service stays INVOKER.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('receive_whatsapp_message', 'receive_whatsapp_status', 'configure_whatsapp_channel',
                       'request_outbound_send', 'begin_outbound_send', 'settle_outbound_send',
                       'mark_outbound_indeterminate', 'crm_contact_by_phone', 'whatsapp_send_eligibility',
                       'admit_inbound_core', 'admit_inbound_message')
     and (p.prosecdef <> (p.proname in ('receive_whatsapp_message', 'receive_whatsapp_status'))
          or not coalesce(p.proconfig @> array['search_path=""'], false));
  if v_bad is not null then
    raise exception 'A5: a Phase 2B function has the wrong security or search path: %', v_bad;
  end if;
end
$$;

-- A4. Not only the catalogue: each role, ACTUALLY switched to, is refused at
--     the door (the schema, the function or the table itself).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;
do $$ begin execute format('grant ops_gateway to %I', current_user); end $$;

do $$
declare
  v_role    text;
  v_attempt text;
  v_reached text[] := array[]::text[];
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway'] loop
    foreach v_attempt in array array[
      format($q$select ops.configure_whatsapp_channel(%L, %L, %L, '399999999999999', 'test', 'x', 'probe')$q$,
             pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a')),
      format($q$select ops.request_outbound_send(%L, gen_random_uuid(), 'probe', 'probe')$q$, pg_temp.id('tenant_a')),
      format($q$select ops.begin_outbound_send(%L, gen_random_uuid())$q$, pg_temp.id('tenant_a')),
      format($q$select ops.settle_outbound_send(%L, gen_random_uuid(), 'sent', 'wamid.x', null, null)$q$, pg_temp.id('tenant_a')),
      format($q$select ops.crm_contact_by_phone(%L, '5511900000001')$q$, pg_temp.id('tenant_a')),
      'select count(*) from ops.communication_channels',
      'select count(*) from ops.conversations',
      'select count(*) from ops.outbound_messages',
      $q$update ops.outbound_messages set status = 'sent'$q$
    ] loop
      begin
        execute format('set local role %I', v_role);
        execute v_attempt;
        v_reached := v_reached || format('%s: %s', v_role, v_attempt);
      exception when insufficient_privilege then
        if sqlerrm !~ '^permission denied for (schema ops|function (configure_whatsapp_channel|request_outbound_send|begin_outbound_send|settle_outbound_send|crm_contact_by_phone)|table (communication_channels|conversations|outbound_messages))$' then
          v_reached := v_reached || format('%s: %s (%s)', v_role, v_attempt, sqlerrm);
        end if;
      end;
      reset role;
    end loop;
  end loop;
  -- And the gateway's own functions are refused to everyone but the gateway.
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker'] loop
    begin
      execute format('set local role %I', v_role);
      perform ops.receive_whatsapp_message('300000000000001', 'wamid.A4', '5511900000001', 'probe', now());
      v_reached := v_reached || format('%s: receive_whatsapp_message', v_role);
    exception when insufficient_privilege then null;
    end;
    reset role;
  end loop;
  if cardinality(v_reached) > 0 then
    raise exception 'A4: a role reached the transport: %', array_to_string(v_reached, ' | ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- B. The trusted mapping.
-- ---------------------------------------------------------------------------

do $$
begin
  -- B1. Another tenant cannot configure (or take over) a target that exists.
  begin
    perform ops.configure_whatsapp_channel(
      pg_temp.id('tenant_b'), pg_temp.id('company_b'), pg_temp.id('agent_b'),
      '300000000000001', 'test', 'hijack', 'p2b-owner');
    raise exception 'B1: another tenant took over a configured provider target';
  exception when sqlstate 'OS409' then null;
  end;

  -- B2. A channel's tenant and target are immutable, even to the owner.
  begin
    update ops.communication_channels set provider_target = '300000000000009'
     where id = pg_temp.id('chan_a_test');
    raise exception 'B2: a channel''s provider target changed';
  exception when sqlstate 'OS403' then null;
  end;

  -- B3. An unknown target, and an inactive one, admit nothing.
  begin
    perform ops.receive_whatsapp_message('399999999999999', 'wamid.B3', '5511900000001', 'hello', now());
    raise exception 'B3: an unknown target admitted a message';
  exception when sqlstate 'OS404' then null;
  end;
  perform ops.configure_whatsapp_channel(
    pg_temp.id('tenant_b'), pg_temp.id('company_b'), pg_temp.id('agent_b'),
    '300000000000003', 'test', 'B test', 'p2b-owner', false);
  begin
    perform ops.receive_whatsapp_message('300000000000003', 'wamid.B3b', '5511900000001', 'hello', now());
    raise exception 'B3: an inactive target admitted a message';
  exception when sqlstate 'OS404' then null;
  end;

  -- B4. Malformed input is a typed refusal.
  begin
    perform ops.receive_whatsapp_message('not-a-target', 'wamid.B4', '5511900000001', 'hello', now());
    raise exception 'B4: a malformed target was accepted';
  exception when sqlstate 'OS400' then null;
  end;
  begin
    perform ops.receive_whatsapp_message('300000000000001', 'wamid.B4b', '+55 11', 'hello', now());
    raise exception 'B4: a malformed sender was accepted';
  exception when sqlstate 'OS400' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- C. BASELINE Q8: production content never becomes work.
-- ---------------------------------------------------------------------------

do $$
declare
  v_result jsonb;
  v_conv   uuid;
begin
  -- C1. Through the gateway function: held, and nothing stored.
  v_result := ops.receive_whatsapp_message('300000000000002', 'wamid.C1', '5511900000001', 'real content', now());
  if v_result ->> 'state' <> 'held' then
    raise exception 'C1: a production channel''s message was not held: %', v_result;
  end if;
  if exists (select 1 from ops.inbound_messages where channel_id = pg_temp.id('chan_a_prod'))
     or exists (select 1 from ops.conversations where channel_id = pg_temp.id('chan_a_prod')) then
    raise exception 'C1: a production channel''s message was stored';
  end if;

  -- C2. Even the owner's direct insert is refused by the Q8 trigger.
  insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('chan_a_prod'), '5511900000001')
  returning id into v_conv;
  begin
    insert into ops.inbound_messages (
      tenant_id, company_id, source_kind, external_message_id, contact_ref, do_not_contact,
      body_fingerprint, received_at, channel_id, conversation_id, contact_resolution)
    values (
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), 'whatsapp', 'wamid.C2', '5511900000001', true,
      repeat('a', 64), now(), pg_temp.id('chan_a_prod'), v_conv, 'not_found');
    raise exception 'C2: a production channel''s message was admitted by a direct insert';
  exception when sqlstate 'OS403' then null;
  end;

  -- C3. A synthetic row cannot name a channel; a WhatsApp row must.
  begin
    insert into ops.inbound_messages (
      tenant_id, company_id, source_kind, external_message_id, contact_ref, do_not_contact,
      body_fingerprint, received_at, channel_id)
    values (
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), 'synthetic', 'syn.C3', 'synthetic:x', true,
      repeat('a', 64), now(), pg_temp.id('chan_a_test'));
    raise exception 'C3: a synthetic row carried a channel';
  exception when check_violation then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- D. The CRM adapter: answers, never writes, never guesses.
-- ---------------------------------------------------------------------------

do $$
declare
  v_found    bigint;
  v_contacts bigint;
begin
  insert into public.contacts (first_name, phone_jsonb)
  values ('p2b-suite', '[{"number": "+55 (11) 90000-0111", "type": "Mobile"}]'::jsonb) returning id into v_found;
  insert into public.contacts (first_name, phone_jsonb)
  values ('p2b-suite', '[{"number": "+55 11 90000 0222", "type": "Work"}]'::jsonb),
         ('p2b-suite', '[{"number": "5511900000222", "type": "Mobile"}]'::jsonb),
         ('p2b-suite', '[{"number": "11 90000-0333", "type": "Mobile"}]'::jsonb);
  select count(*) into v_contacts from public.contacts;

  if ops.crm_contact_by_phone(pg_temp.id('tenant_a'), '5511900000111')
     <> jsonb_build_object('state', 'found', 'crm_contact_ref', 'crm:contact:' || v_found, 'do_not_contact', false) then
    raise exception 'D1: a single matching contact was not found with its opt-out flag';
  end if;
  if ops.crm_contact_by_phone(pg_temp.id('tenant_a'), '5511900000222') ->> 'state' <> 'ambiguous' then
    raise exception 'D2: two matching contacts were not ambiguous';
  end if;
  -- A number stored without its country code is not guessed at.
  if ops.crm_contact_by_phone(pg_temp.id('tenant_a'), '5511900000333') ->> 'state' <> 'not_found' then
    raise exception 'D3: a number without its country code was matched';
  end if;
  if ops.crm_contact_by_phone(pg_temp.id('tenant_b'), '5511900000111') ->> 'state' <> 'unavailable' then
    raise exception 'D4: a tenant that does not own the CRM read it';
  end if;
  if ops.crm_contact_by_phone(pg_temp.id('tenant_a'), '+5511900000111') ->> 'state' <> 'not_found' then
    raise exception 'D5: a malformed WhatsApp id was matched';
  end if;
  if (select count(*) from public.contacts) <> v_contacts then
    raise exception 'D6: the adapter changed the CRM';
  end if;
  -- D7. Read-only by construction: no DML in the adapter or the eligibility rule.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname in ('crm_contact_by_phone', 'whatsapp_send_eligibility')
                and p.prosrc ~* '\m(insert|update|delete|truncate)\M') then
    raise exception 'D7: the CRM adapter or the eligibility rule contains a write';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- E. The send state machine, against the owner's own statements.
-- ---------------------------------------------------------------------------

do $$
declare
  v_admitted jsonb;
  v_review   uuid;
  v_out      uuid;
begin
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.E1', '5511900000111', 'hello', now());
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed,
                                do_not_contact, status, reviewer, reviewed_at)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), (v_admitted ->> 'task_id')::uuid, gen_random_uuid(),
          'lead_triage', '{"response_draft": "synthetic draft"}'::jsonb, false, 'accepted', 'p2b', now())
  returning id into v_review;

  -- E1. A send begins authorized, and only on a test channel.
  begin
    insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                       task_id, status, requested_by, authorized_check, provider_message_id, sending_at)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('chan_a_test'),
            (v_admitted ->> 'conversation_id')::uuid, v_review, (v_admitted ->> 'task_id')::uuid,
            'sent', 'p2b', '{}'::jsonb, 'wamid.E1', now());
    raise exception 'E1: a send was born sent';
  exception when sqlstate 'OS403' then null;
  end;
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('chan_a_test'),
          (v_admitted ->> 'conversation_id')::uuid, v_review, (v_admitted ->> 'task_id')::uuid,
          'authorized', 'p2b', '{}'::jsonb)
  returning id into v_out;

  -- E2. It cannot skip the call, or be re-sent once it may have left.
  begin
    update ops.outbound_messages set status = 'sent', provider_message_id = 'wamid.E2' where id = v_out;
    raise exception 'E2: an authorized send became sent without being sent';
  exception when sqlstate 'OS409' then null;
  end;
  update ops.outbound_messages set status = 'sending', sending_at = now() where id = v_out;
  begin
    update ops.outbound_messages set status = 'authorized' where id = v_out;
    raise exception 'E2: a send in flight was made sendable again';
  exception when sqlstate 'OS409' then null;
  end;
  update ops.outbound_messages set status = 'indeterminate' where id = v_out;
  begin
    update ops.outbound_messages set status = 'sending' where id = v_out;
    raise exception 'E2: an indeterminate send was sent again';
  exception when sqlstate 'OS409' then null;
  end;

  -- E3. What was authorized, and the provider id once set, never change.
  begin
    update ops.outbound_messages set review_item_id = gen_random_uuid() where id = v_out;
    raise exception 'E3: a send moved to another review';
  exception when sqlstate 'OS403' then null;
  end;
  update ops.outbound_messages set status = 'sent', provider_message_id = 'wamid.E3' where id = v_out;
  begin
    update ops.outbound_messages set provider_message_id = 'wamid.other' where id = v_out;
    raise exception 'E3: a provider message id was replaced';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    update ops.outbound_messages set status = 'sending' where id = v_out;
    raise exception 'E3: a sent message was sent again';
  exception when sqlstate 'OS409' then null;
  end;

  -- E4. One send per review.
  begin
    insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                       task_id, status, requested_by, authorized_check)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('chan_a_test'),
            (v_admitted ->> 'conversation_id')::uuid, v_review, (v_admitted ->> 'task_id')::uuid,
            'authorized', 'p2b', '{}'::jsonb);
    raise exception 'E4: a second send of one review was stored';
  exception when unique_violation then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- F. Status callbacks match only this channel's sends.
-- ---------------------------------------------------------------------------

do $$
begin
  if ops.receive_whatsapp_status('300000000000001', 'wamid.unknown', 'delivered', now(), '5511900000111', null, null)
       ->> 'state' <> 'unmatched' then
    raise exception 'F1: an unknown provider id matched a send';
  end if;
  -- The send settled in E belongs to channel A; channel B's target cannot name it.
  if ops.receive_whatsapp_status('300000000000003', 'wamid.E3', 'read', now(), '5511900000111', null, null)
       ->> 'state' <> 'unmatched' then
    raise exception 'F2: another tenant''s target reached a send';
  end if;
  if ops.receive_whatsapp_status('300000000000001', 'wamid.E3', 'played', now(), '5511900000111', null, null)
       ->> 'state' <> 'unsupported' then
    raise exception 'F3: an undocumented delivery state moved a send';
  end if;
  if ops.receive_whatsapp_status('300000000000001', 'wamid.E3', 'delivered', now(), '5511900000111', null, null)
       ->> 'state' <> 'updated' then
    raise exception 'F4: a delivery status did not move its send';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- G. Accepting sends nothing: no trigger anywhere turns a decision into a send.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(t.tgname || ' on ' || c.relname, ', ') into v_bad
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
   where n.nspname = 'ops' and not t.tgisinternal
     and c.relname <> 'outbound_messages'
     and p.prosrc ~* 'outbound_messages|begin_outbound_send|request_outbound_send';
  if v_bad is not null then
    raise exception 'G1: a trigger creates or begins a send: %', v_bad;
  end if;
end
$$;

rollback;
