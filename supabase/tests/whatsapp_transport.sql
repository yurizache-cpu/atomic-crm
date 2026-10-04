-- Phase 2B — attacks on the WhatsApp transport and on the send of an accepted review.
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
-- ADR 0021 (sections P and N): the privacy notice on the first reply of a
-- conversation, and the sender number's retention clock and erasure.
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
  da := pg_temp.remember('dept_a', ops.create_department(ta, ca, 'intake', 'Intake', c_source));
  db := ops.create_department(tb, cb, 'intake', 'Intake', c_source);
  perform pg_temp.remember('agent_a', ops.create_agent(ta, ca, da, 'lead-triage', 'Lead Triage', 'Intake assistant', c_source));
  perform pg_temp.remember('agent_b', ops.create_agent(tb, cb, db, 'lead-triage', 'Lead Triage', 'Intake assistant', c_source));

  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'p2b-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'p2b-test: sql suite ceiling', 'p2b-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'p2b-test: budget', 'p2b-owner', ta);
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'p2b-test: budget', 'p2b-owner', tb);

  -- Channels: A test, A production (inactive: the real-data gate is closed), B test.
  perform pg_temp.remember('chan_a_test', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000001', 'test', 'A test', 'p2b-owner'));
  perform pg_temp.remember('chan_a_prod', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000002', 'production', 'A production', 'p2b-owner', false));
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

  -- B3. An unknown target, and an inactive one, are unrouted: nothing is
  --     admitted or stored, and the gateway does not acknowledge them.
  if ops.receive_whatsapp_message('399999999999999', 'wamid.B3', '5511900000001', 'hello', now())
       <> '{"state": "unrouted", "reason": "unknown_target"}'::jsonb then
    raise exception 'B3: an unknown target was not unrouted';
  end if;
  perform ops.configure_whatsapp_channel(
    pg_temp.id('tenant_b'), pg_temp.id('company_b'), pg_temp.id('agent_b'),
    '300000000000003', 'test', 'B test', 'p2b-owner', false);
  if ops.receive_whatsapp_message('300000000000003', 'wamid.B3b', '5511900000001', 'hello', now())
       <> '{"state": "unrouted", "reason": "channel_not_live"}'::jsonb then
    raise exception 'B3: an inactive target was not unrouted';
  end if;
  if exists (select 1 from ops.inbound_messages where external_message_id in ('wamid.B3', 'wamid.B3b'))
     or exists (select 1 from ops.events where type like 'communication.%'
                 and payload ->> 'channel_id' = pg_temp.id('chan_b_test')::text
                 and type <> 'communication.channel_configured') then
    raise exception 'B3: an unrouted message left a trace';
  end if;

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
  -- C1. Through the gateway function: a production target is never live, so
  --     its message is unrouted (not acknowledged), and nothing is stored.
  v_result := ops.receive_whatsapp_message('300000000000002', 'wamid.C1', '5511900000001', 'real content', now());
  if v_result <> '{"state": "unrouted", "reason": "channel_not_live"}'::jsonb then
    raise exception 'C1: a production channel''s message was not unrouted: %', v_result;
  end if;
  if exists (select 1 from ops.inbound_messages where channel_id = pg_temp.id('chan_a_prod'))
     or exists (select 1 from ops.conversations where channel_id = pg_temp.id('chan_a_prod'))
     or exists (select 1 from ops.events where type in ('communication.inbound_held', 'communication.inbound_refused')) then
    raise exception 'C1: a production channel''s message was stored or recorded';
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

  -- E5. BASELINE Q8: a production conversation can never be sent to, whatever
  --     its contact's consent (the Q8 reason comes first), and the table itself
  --     refuses a send on a production channel, to the owner too.
  if ops.whatsapp_send_eligibility(pg_temp.id('tenant_a'),
       (select id from ops.conversations where channel_id = pg_temp.id('chan_a_prod') limit 1)) ->> 'reason'
     <> 'q8_production_channel' then
    raise exception 'E5: a production conversation was not refused by the Q8 gate first';
  end if;
  begin
    insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                       task_id, status, requested_by, authorized_check)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('chan_a_prod'),
            (select id from ops.conversations where channel_id = pg_temp.id('chan_a_prod') limit 1),
            v_review, (v_admitted ->> 'task_id')::uuid, 'authorized', 'p2b', '{}'::jsonb);
    raise exception 'E5: a send on a production channel was stored';
  exception when sqlstate 'OS403' then null;
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

-- ---------------------------------------------------------------------------
-- H. The BASELINE Q8 real-data gate is closed, and has no enabled value.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- H1. The normal service refuses a live production channel: new, and by
  --     re-activating the existing inactive one.
  begin
    perform ops.configure_whatsapp_channel(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      '300000000000004', 'production', 'A live', 'p2b-owner');
    raise exception 'H1: the configure service made a production channel live';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    perform ops.configure_whatsapp_channel(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      '300000000000002', 'production', 'A production', 'p2b-owner', true);
    raise exception 'H1: the configure service re-activated a production channel';
  exception when sqlstate 'OS403' then null;
  end;
  -- ...or turns a live test channel into production.
  begin
    perform ops.configure_whatsapp_channel(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      '300000000000001', 'production', 'A test', 'p2b-owner');
    raise exception 'H1: the configure service turned a live test channel into production';
  exception when sqlstate 'OS403' then null;
  end;

  -- H2. The owner's own statements meet the same gate: an insert, a
  --     re-activation and a mode flip on a live channel.
  begin
    insert into ops.communication_channels (tenant_id, company_id, agent_id, provider, provider_target,
                                            mode, label, configured_by, active)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'), 'meta_whatsapp',
            '300000000000005', 'production', 'direct', 'p2b-owner', true);
    raise exception 'H2: an owner insert made a production channel live';
  exception when check_violation then null;
  end;
  begin
    update ops.communication_channels set active = true where id = pg_temp.id('chan_a_prod');
    raise exception 'H2: an owner update re-activated a production channel';
  exception when check_violation then null;
  end;
  begin
    update ops.communication_channels set mode = 'production' where id = pg_temp.id('chan_a_test');
    raise exception 'H2: an owner update turned a live test channel into production';
  exception when check_violation then null;
  end;

  -- H3. The gate is a validated constraint, and nothing opens it: no setting
  --     is read by the gateway's functions, the configure service or the send
  --     eligibility rule.
  if not exists (select 1 from pg_constraint
                  where conname = 'communication_channels_q8_real_data_gate'
                    and conrelid = 'ops.communication_channels'::regclass and convalidated) then
    raise exception 'H3: the real-data gate constraint is missing or not validated';
  end if;
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('receive_whatsapp_message', 'receive_whatsapp_status', 'configure_whatsapp_channel',
                       'whatsapp_send_eligibility', 'request_outbound_send', 'begin_outbound_send')
     and p.prosrc ~* '(current_setting|set_config|pg_settings)';
  if v_bad is not null then
    raise exception 'H3: a gate reads a setting: %', v_bad;
  end if;

  -- H4. A payload cannot alter a channel: neither gateway function writes one.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname in ('receive_whatsapp_message', 'receive_whatsapp_status')
     and p.prosrc ~* '(update|insert\s+into|delete\s+from)\s+ops\.communication_channels';
  if v_bad is not null then
    raise exception 'H4: a gateway function writes a channel: %', v_bad;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- I. Acknowledged only once it became work or a durable, content-free fact.
-- ---------------------------------------------------------------------------

do $$
declare
  v_result jsonb;
  v_task   uuid;
  v_bad    text;
begin
  -- I1. A routed message that cannot become work is refused ON THE RECORD:
  --     no content, no ledger row, no task, and one fact per message id.
  if ops.receive_whatsapp_message('300000000000001', 'wamid.I1a', '5511900000444', null, now()) ->> 'reason'
       <> 'unsupported_content'
     or ops.receive_whatsapp_message('300000000000001', 'wamid.I1b', null, 'SENTINEL-I1 hello', now()) ->> 'reason'
       <> 'no_sender_number'
     or ops.receive_whatsapp_message('300000000000001', 'wamid.I1c', '5511900000444', '   ', now()) ->> 'reason'
       <> 'empty_body'
     or ops.receive_whatsapp_message('300000000000001', 'wamid.I1d', '5511900000444', 'SENTINEL-I1' || repeat('x', 4000), now()) ->> 'reason'
       <> 'body_too_long' then
    raise exception 'I1: an unadmittable message was not refused on the record';
  end if;
  v_result := ops.receive_whatsapp_message('300000000000001', 'wamid.I1d', '5511900000444', 'SENTINEL-I1' || repeat('x', 4000), now());
  if v_result ->> 'state' <> 'refused' then
    raise exception 'I1: a redelivered refusal was answered %', v_result;
  end if;
  if (select count(*) from ops.events where type = 'communication.inbound_refused'
        and tenant_id = pg_temp.id('tenant_a')) <> 4 then
    raise exception 'I1: the refusals are not exactly one fact per message id';
  end if;
  select string_agg(e.payload::text, ' | ') into v_bad
    from ops.events e
   where e.type = 'communication.inbound_refused'
     and (e.payload::text like '%SENTINEL%' or e.payload::text like '%5511900000444%'
          or exists (select 1 from jsonb_object_keys(e.payload) k where k not in ('channel_id', 'conversation_id', 'reason')));
  if v_bad is not null then
    raise exception 'I1: a refusal carries more than its channel, conversation and reason: %', v_bad;
  end if;
  if exists (select 1 from ops.inbound_messages where external_message_id like 'wamid.I1%')
     or exists (select 1 from ops.tasks where description like '%SENTINEL-I1%') then
    raise exception 'I1: a refused message became a ledger row or a task';
  end if;

  -- I2. A reused message id carrying another message is refused on the
  --     record; the original admission stands.
  if ops.receive_whatsapp_message('300000000000001', 'wamid.E1', '5511900000111', 'another message', now()) ->> 'reason'
     <> 'admission_refused' then
    raise exception 'I2: a reused message id was not refused on the record';
  end if;
  if (select count(*) from ops.inbound_messages where external_message_id = 'wamid.E1') <> 1 then
    raise exception 'I2: the original admission did not stand';
  end if;

  -- I3. The gateway's clock cannot refuse a message: a received_at in the
  --     future is admitted at the database's now.
  v_result := ops.receive_whatsapp_message('300000000000001', 'wamid.I3', '5511900000555', 'hello', now() + interval '1 hour');
  if v_result ->> 'state' <> 'admitted'
     or (select received_at from ops.inbound_messages where external_message_id = 'wamid.I3') > now() then
    raise exception 'I3: a skewed clock refused or post-dated a message: %', v_result;
  end if;

  -- I4. A paused agent, department or company is unrouted, not refused, and
  --     leaves nothing; re-activated, the same message is admitted.
  perform ops.set_agent_status(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'inactive', 'phase2b-suite');
  if ops.receive_whatsapp_message('300000000000001', 'wamid.I4', '5511900000555', 'hello', now())
       <> '{"state": "unrouted", "reason": "organisation_inactive"}'::jsonb then
    raise exception 'I4: a message for a paused agent was not unrouted';
  end if;
  perform ops.set_agent_status(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'active', 'phase2b-suite');
  perform ops.set_department_status(pg_temp.id('tenant_a'), pg_temp.id('dept_a'), 'inactive', 'phase2b-suite');
  if ops.receive_whatsapp_message('300000000000001', 'wamid.I4', '5511900000555', 'hello', now()) ->> 'state'
     <> 'unrouted' then
    raise exception 'I4: a message for a paused department was not unrouted';
  end if;
  perform ops.set_department_status(pg_temp.id('tenant_a'), pg_temp.id('dept_a'), 'active', 'phase2b-suite');
  if exists (select 1 from ops.inbound_messages where external_message_id = 'wamid.I4') then
    raise exception 'I4: an unrouted message left a ledger row';
  end if;
  v_result := ops.receive_whatsapp_message('300000000000001', 'wamid.I4', '5511900000555', 'hello', now());
  if v_result ->> 'state' <> 'admitted' then
    raise exception 'I4: the redelivered message was not admitted once the units were active: %', v_result;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- J. Status collisions: another channel of the same tenant, another send's
--    recipient, no recipient, and a send that failed without a provider id.
-- ---------------------------------------------------------------------------

do $$
declare
  v_admitted jsonb;
  v_review   uuid;
  v_out      uuid;
begin
  perform pg_temp.remember('chan_a_second', ops.configure_whatsapp_channel(
    pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
    '300000000000006', 'test', 'A second', 'p2b-owner'));

  -- J1. A provider id of channel A's send, reported through another channel of
  --     the SAME tenant, reaches nothing.
  if ops.receive_whatsapp_status('300000000000006', 'wamid.E3', 'read', now(), '5511900000111', null, null)
       ->> 'state' <> 'unmatched' then
    raise exception 'J1: another channel of the same tenant reached a send';
  end if;

  -- A send whose outcome is unknown: authorized, then sending, no provider id.
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.J', '5511900000777', 'hello', now());
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed,
                                do_not_contact, status, reviewer, reviewed_at)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), (v_admitted ->> 'task_id')::uuid, gen_random_uuid(),
          'lead_triage', '{"response_draft": "synthetic draft"}'::jsonb, false, 'accepted', 'p2b', now())
  returning id into v_review;
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('chan_a_test'),
          (v_admitted ->> 'conversation_id')::uuid, v_review, (v_admitted ->> 'task_id')::uuid,
          'authorized', 'p2b', '{}'::jsonb)
  returning id into v_out;
  update ops.outbound_messages set status = 'sending', sending_at = now() where id = v_out;

  -- J2. Its correlation reaches it only through its own channel, with its own
  --     recipient: not through another channel, not with another send's
  --     recipient, and not with no recipient at all.
  if ops.receive_whatsapp_status('300000000000006', 'wamid.J2a', 'delivered', now(), '5511900000777', v_out::text, null)
       ->> 'state' <> 'unmatched'
     or ops.receive_whatsapp_status('300000000000001', 'wamid.J2b', 'delivered', now(), '5511900000111', v_out::text, null)
       ->> 'state' <> 'unmatched'
     or ops.receive_whatsapp_status('300000000000001', 'wamid.J2c', 'delivered', now(), null, v_out::text, null)
       ->> 'state' <> 'unmatched' then
    raise exception 'J2: a correlation reached a send without its own channel and recipient';
  end if;
  if (select status from ops.outbound_messages where id = v_out) <> 'sending' then
    raise exception 'J2: a refused status moved the send';
  end if;

  -- J3. A send the provider refused synchronously (failed, no provider id) is
  --     final: even its own correlation and recipient cannot move it.
  update ops.outbound_messages set status = 'failed', settled_at = now(), error_code = '131026',
         error_class = 'undeliverable' where id = v_out;
  if ops.receive_whatsapp_status('300000000000001', 'wamid.J3', 'delivered', now(), '5511900000777', v_out::text, null)
       ->> 'state' <> 'unmatched'
     or (select status from ops.outbound_messages where id = v_out) <> 'failed' then
    raise exception 'J3: a synchronously refused send was moved by a callback';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- K. The gateway reaches nothing else: no ops relation at all, no CREATE, and
--    outside ops only what PUBLIC holds.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- K1. Every ops relation, not only Phase 2B's.
  select string_agg(format('%s on %s', p.priv, c.relname), ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where n.nspname = 'ops' and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege('ops_gateway', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'K1: ops_gateway reaches an ops relation: %', v_bad;
  end if;
  if has_schema_privilege('ops_gateway', 'ops', 'CREATE')
     or has_schema_privilege('ops_gateway', 'public', 'CREATE')
     or has_database_privilege('ops_gateway', current_database(), 'CREATE') then
    raise exception 'K1: ops_gateway can create objects';
  end if;

  -- K2. No table in any other schema.
  select string_agg(n.nspname || '.' || c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p', 'v', 'm', 'f')
     and n.nspname not in ('pg_catalog', 'information_schema', 'ops')
     and has_schema_privilege('ops_gateway', n.oid, 'USAGE')
     and (has_table_privilege('ops_gateway', c.oid, 'SELECT') or has_table_privilege('ops_gateway', c.oid, 'INSERT')
          or has_table_privilege('ops_gateway', c.oid, 'UPDATE') or has_table_privilege('ops_gateway', c.oid, 'DELETE'));
  if v_bad is not null then
    raise exception 'K2: ops_gateway reaches a table outside ops: %', v_bad;
  end if;

  -- K3. Outside ops it executes no SECURITY DEFINER function at all. Until
  --     Production Security Gate A (20261004120000) PUBLIC held the CRM's
  --     row-level-security helpers and trigger functions; now nothing outside
  --     ops is left to it, and a new one shows up here by name.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema', 'ops')
     and p.prosecdef
     and has_schema_privilege('ops_gateway', n.oid, 'USAGE')
     and has_function_privilege('ops_gateway', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'K3: ops_gateway executes a SECURITY DEFINER function outside ops: %', v_bad;
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- P. ADR 0021: the privacy notice is versioned owner data, and the first reply
--    of a conversation carries it, recording which version.
-- ---------------------------------------------------------------------------

create function pg_temp.accepted_reply(p_wamid text, p_from text, p_draft text) returns uuid
language plpgsql as $f$
declare
  v_admitted jsonb;
  v_review   uuid;
begin
  v_admitted := ops.receive_whatsapp_message('300000000000001', p_wamid, p_from, 'synthetic question', now());
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed,
                                do_not_contact, status, reviewer, reviewed_at)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), (v_admitted ->> 'task_id')::uuid, gen_random_uuid(),
          'lead_triage', jsonb_build_object('response_draft', p_draft), false, 'accepted', 'p2b', now())
  returning id into v_review;
  return ops.request_outbound_send(pg_temp.id('tenant_a'), v_review, 'p2b-owner', 'operator-cli') ->> 'outbound_message_id';
end
$f$;

do $$
declare
  v_n1   uuid;
  v_n2   uuid;
  v_out  uuid;
  v_first uuid;
  v_ans  jsonb;
  c_text constant text := 'Privacy notice: synthetic clinic. Details: https://clinic.example.test/privacy';
  c_nl2  constant text := repeat(chr(10), 2);
begin
  -- P1. Recorded only as owner data, with its shape held by the table.
  begin
    perform ops.record_privacy_notice(gen_random_uuid(), 'v1', 'https://clinic.example.test/privacy', c_text,
                                      'lgpd:art7-v+art11-ii-f', 'p2b-owner');
    raise exception 'P1: a notice was recorded for an unknown tenant';
  exception when sqlstate 'OS404' then null;
  end;
  begin
    perform ops.record_privacy_notice(pg_temp.id('tenant_a'), 'v1', 'http://clinic.example.test/privacy', c_text,
                                      'lgpd:art7-v+art11-ii-f', 'p2b-owner');
    raise exception 'P1: a notice without https was recorded';
  exception when check_violation then null;
  end;
  begin
    perform ops.record_privacy_notice(pg_temp.id('tenant_a'), 'v1', 'https://clinic.example.test/privacy',
                                      repeat('x', 1001), 'lgpd:art7-v+art11-ii-f', 'p2b-owner');
    raise exception 'P1: a notice longer than 1000 characters was recorded';
  exception when check_violation then null;
  end;
  begin
    perform ops.record_privacy_notice(pg_temp.id('tenant_a'), 'v1', 'https://clinic.example.test/privacy',
                                      'notice' || chr(7), 'lgpd:art7-v+art11-ii-f', 'p2b-owner');
    raise exception 'P1: a notice with a control character was recorded';
  exception when check_violation then null;
  end;
  v_n1 := ops.record_privacy_notice(pg_temp.id('tenant_a'), 'v1', 'https://clinic.example.test/privacy', c_text,
                                    'lgpd:art7-v+art11-ii-f', 'p2b-owner');
  begin
    perform ops.record_privacy_notice(pg_temp.id('tenant_a'), 'v1', 'https://clinic.example.test/privacy', c_text,
                                      'lgpd:art7-v+art11-ii-f', 'p2b-owner');
    raise exception 'P1: a version was recorded twice';
  exception when sqlstate 'OS409' then null;
  end;

  -- P2. A notice is history: never rewritten, deleted, revived or truncated.
  begin
    update ops.privacy_notices set whatsapp_text = 'rewritten' where id = v_n1;
    raise exception 'P2: a notice''s text was rewritten';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.privacy_notices where id = v_n1;
    raise exception 'P2: the current notice was deleted';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    truncate ops.privacy_notices cascade;
    raise exception 'P2: the notices were truncated';
  exception when sqlstate 'OS403' then null;
  end;

  -- P3. The first reply of a conversation carries the current notice, and the
  --     send records its version; the text is the draft and the notice only.
  v_out := pg_temp.accepted_reply('wamid.P3', '5511900000111', 'First synthetic reply');
  v_ans := ops.begin_outbound_send(pg_temp.id('tenant_a'), v_out);
  if v_ans ->> 'state' <> 'send' or v_ans ->> 'body' <> 'First synthetic reply' || c_nl2 || c_text
     or (select privacy_notice_id from ops.outbound_messages where id = v_out) is distinct from v_n1 then
    raise exception 'P3: the first reply did not carry the notice and record it: %', v_ans;
  end if;
  -- The version is attached once, as the send begins, and never changes.
  begin
    update ops.outbound_messages set privacy_notice_id = null where id = v_out;
    raise exception 'P3: a send''s notice was removed';
  exception when sqlstate 'OS403' then null;
  end;

  -- P4. Until a reply with that version reached the person, the next reply
  --     carries it again: an unknown outcome is not delivery, and neither is
  --     the provider's acceptance (sent can still become failed). Once one is
  --     delivered (or read), the next reply does not.
  perform ops.settle_outbound_send(pg_temp.id('tenant_a'), v_out, 'indeterminate', null, null, 'ambiguous');
  v_out := pg_temp.accepted_reply('wamid.P4a', '5511900000111', 'Second synthetic reply');
  v_ans := ops.begin_outbound_send(pg_temp.id('tenant_a'), v_out);
  if v_ans ->> 'body' <> 'Second synthetic reply' || c_nl2 || c_text then
    raise exception 'P4: a reply after an unknown outcome did not carry the notice again: %', v_ans;
  end if;
  perform ops.settle_outbound_send(pg_temp.id('tenant_a'), v_out, 'sent', 'wamid.P4a.out', null, null);
  v_first := v_out;
  v_out := pg_temp.accepted_reply('wamid.P4b', '5511900000111', 'Third synthetic reply');
  v_ans := ops.begin_outbound_send(pg_temp.id('tenant_a'), v_out);
  if v_ans ->> 'body' <> 'Third synthetic reply' || c_nl2 || c_text then
    raise exception 'P4: a reply after one merely accepted by the provider did not carry the notice again: %', v_ans;
  end if;
  perform ops.settle_outbound_send(pg_temp.id('tenant_a'), v_out, 'sent', 'wamid.P4b.out', null, null);
  update ops.outbound_messages set status = 'delivered', delivered_at = now() where id = v_first;
  v_out := pg_temp.accepted_reply('wamid.P4c', '5511900000111', 'Fourth synthetic reply');
  v_ans := ops.begin_outbound_send(pg_temp.id('tenant_a'), v_out);
  if v_ans ->> 'body' <> 'Fourth synthetic reply'
     or (select privacy_notice_id from ops.outbound_messages where id = v_out) is not null then
    raise exception 'P4: a reply after the notice reached the person carried it again: %', v_ans;
  end if;
  perform ops.settle_outbound_send(pg_temp.id('tenant_a'), v_out, 'sent', 'wamid.P4c.out', null, null);

  -- P5. A new version supersedes the old one, exactly one is current, and the
  --     next reply carries the new version.
  v_n2 := ops.record_privacy_notice(pg_temp.id('tenant_a'), 'v2', 'https://clinic.example.test/privacy-v2',
                                    'Updated synthetic notice', 'lgpd:art7-v+art11-ii-f', 'p2b-owner');
  if (select count(*) from ops.privacy_notices where tenant_id = pg_temp.id('tenant_a') and superseded_at is null) <> 1
     or (select superseded_at from ops.privacy_notices where id = v_n1) is null then
    raise exception 'P5: a new version did not supersede the old one';
  end if;
  begin
    update ops.privacy_notices set superseded_at = null where id = v_n1;
    raise exception 'P5: a superseded notice was revived';
  exception when sqlstate 'OS403' then null;
  end;
  -- A version a send carried is never deleted, superseded or not.
  begin
    delete from ops.privacy_notices where id = v_n1;
    raise exception 'P5: a notice a send carried was deleted';
  exception when foreign_key_violation then null;
  end;
  v_out := pg_temp.accepted_reply('wamid.P5', '5511900000111', 'Fifth synthetic reply');
  v_ans := ops.begin_outbound_send(pg_temp.id('tenant_a'), v_out);
  if v_ans ->> 'body' <> 'Fifth synthetic reply' || c_nl2 || 'Updated synthetic notice'
     or (select privacy_notice_id from ops.outbound_messages where id = v_out) is distinct from v_n2 then
    raise exception 'P5: the next reply did not carry the new version: %', v_ans;
  end if;

  -- P6. Another tenant's notice never reaches this tenant's send, and a send
  --     cannot be pointed at it.
  perform ops.record_privacy_notice(pg_temp.id('tenant_b'), 'v1', 'https://other.example.test/privacy',
                                    'Other tenant notice', 'lgpd:art7-v', 'p2b-owner');
  v_out := pg_temp.accepted_reply('wamid.P6', '5511900000111', 'Sixth synthetic reply');
  begin
    update ops.outbound_messages
       set status = 'sending', sending_at = now(),
           privacy_notice_id = (select id from ops.privacy_notices where tenant_id = pg_temp.id('tenant_b'))
     where id = v_out;
    raise exception 'P6: a send carried another tenant''s notice';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- N. ADR 0021 W5: a sender's number is erased 12 months after their last
--    message, or at once on the owner's act; erasure leaves a tombstone.
-- ---------------------------------------------------------------------------

create function pg_temp.lease(p_job uuid) returns void
language plpgsql as $f$
begin
  update ops.jobs
     set status = 'leased', lease_owner = 'p2b-worker', leased_at = now(),
         lease_expires_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
   where id = p_job and status = 'queued';
  if not found then
    raise exception 'setup: job % is not queued', p_job;
  end if;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  select j.id, j.tenant_id, 'leased', 'p2b-worker', j.attempts, j.kind from ops.jobs j where j.id = p_job;
  perform set_config('app.worker_id', 'p2b-worker', true);
  perform set_config('app.job_id', p_job::text, true);
end
$f$;

do $$
declare
  v_admitted jsonb;
  v_conv     uuid;
  v_conv2    uuid;
  v_old      uuid;
  v_row      ops.contact_identifier_retention;
  v_job      uuid;
  v_status   text;
  v_swept    integer;
begin
  -- No run may be left in progress for these synthetic senders: the company's
  -- budget is zero, so each admitted run is refused at its request.
  perform ops.set_spend_limit('company', 0, 'UTC', 'p2b-test: no runs for section N', 'p2b-owner',
                              pg_temp.id('tenant_a'), pg_temp.id('company_a'));

  -- N1. A conversation is born with its clock and one queued internal job.
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.N1', '5511900000858', 'synthetic', now());
  v_conv := (v_admitted ->> 'conversation_id')::uuid;
  select r.* into v_row from ops.contact_identifier_retention r where r.conversation_id = v_conv;
  if not found or v_row.due_at <> (select c.last_inbound_at from ops.conversations c where c.id = v_conv) + interval '12 months'
     or not exists (select 1 from ops.jobs j where j.id = v_row.job_id and j.status = 'queued'
                      and j.kind = 'contact.identifier_retention_due' and j.available_at = v_row.due_at)
     or 'contact.identifier_retention_due' = any (ops.task_executable_kinds()) then
    raise exception 'N1: a new conversation has no clock with its one queued internal job';
  end if;
  v_job := v_row.job_id;
  if v_row::text ~ '5511900000858' then
    raise exception 'N1: the ledger holds the number';
  end if;

  -- N2. A later message moves the clock forward and the same queued job with it.
  perform ops.receive_whatsapp_message('300000000000001', 'wamid.N2', '5511900000858', 'synthetic',
                                       now() + interval '1 hour');
  select r.* into v_row from ops.contact_identifier_retention r where r.conversation_id = v_conv;
  if v_row.job_id <> v_job or v_row.due_at < now() + interval '12 months'
     or (select j.available_at from ops.jobs j where j.id = v_job) <> v_row.due_at then
    raise exception 'N2: a later message did not move the clock and its job forward';
  end if;

  -- A message refused on the record (an empty body) in the same conversation.
  if ops.receive_whatsapp_message('300000000000001', 'wamid.N2e', '5511900000858', ' ', now()) ->> 'state' <> 'refused' then
    raise exception 'setup: an empty message was not refused on the record';
  end if;

  -- N3. Before its due time, expiry erases nothing.
  if ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_conv, 'retention_expired', 'p2b-owner') <> 'not_due'
     or (select contact_ref from ops.conversations where id = v_conv) <> '5511900000858' then
    raise exception 'N3: a number was erased before its due time';
  end if;

  -- N4. Without a recorded erasure, nothing rewrites the number or its marker.
  begin
    update ops.conversations set contact_ref = '5511900000898' where id = v_conv;
    raise exception 'N4: a conversation''s number was rewritten';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    update ops.conversations set contact_ref = 'erased:' || id::text, contact_erased_at = now() where id = v_conv;
    raise exception 'N4: a number was erased with no recorded erasure';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    update ops.inbound_messages set contact_ref = 'erased:' || conversation_id::text, contact_erased_at = now()
     where conversation_id = v_conv;
    raise exception 'N4: an admission''s number was erased with no recorded erasure';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.contact_identifier_retention where conversation_id = v_conv;
    raise exception 'N4: a clock was deleted while its conversation exists';
  exception when sqlstate 'OS403' then null;
  end;

  -- N5. The owner's act erases the number everywhere it is held, at once,
  --     leaving the conversation's tombstone, and reports how many.
  if ops.erase_contact_by_number(pg_temp.id('tenant_a'), '5511900000858', 'p2b-owner') <> 1 then
    raise exception 'N5: the owner''s erasure did not erase the one conversation';
  end if;
  if (select contact_ref from ops.conversations where id = v_conv) <> 'erased:' || v_conv::text
     or exists (select 1 from ops.conversations where contact_ref = '5511900000858')
     or exists (select 1 from ops.inbound_messages where contact_ref = '5511900000858')
     or (select count(*) from ops.inbound_messages
          where conversation_id = v_conv and contact_ref = 'erased:' || v_conv::text and contact_erased_at is not null) <> 2
     or (select erasure_reason from ops.contact_identifier_retention where conversation_id = v_conv) <> 'erasure' then
    raise exception 'N5: the number survived the owner''s erasure somewhere';
  end if;
  -- Its content went with it: the D7 erasure of every protected flow it admitted.
  if exists (select 1 from ops.inbound_messages i
               join ops.content_retention r on r.tenant_id = i.tenant_id and r.task_id = i.task_id
              where i.conversation_id = v_conv and r.redacted_at is null) then
    raise exception 'N5: a flow the number admitted kept its content';
  end if;
  -- Repeating it changes nothing; an erasure is final.
  if ops.erase_contact_by_number(pg_temp.id('tenant_a'), '5511900000858', 'p2b-owner') <> 0 then
    raise exception 'N5: a repeated erasure reported a conversation';
  end if;
  begin
    update ops.contact_identifier_retention set erased_at = null, erasure_reason = null, erased_by = null
     where conversation_id = v_conv;
    raise exception 'N5: an erasure was undone';
  exception when sqlstate 'OS403' then null;
  end;
  -- An erased conversation can never be sent to.
  if ops.whatsapp_send_eligibility(pg_temp.id('tenant_a'), v_conv) ->> 'eligible' <> 'false' then
    raise exception 'N5: an erased conversation stayed sendable';
  end if;

  -- N9. Meta redelivering an old message, admitted or refused, never brings
  --     the erased number back (Codex review of PR #27, P1).
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.N1', '5511900000858', 'synthetic', now());
  if v_admitted ->> 'state' <> 'admitted' or (v_admitted ->> 'replayed')::boolean is not true
     or (v_admitted ->> 'conversation_id')::uuid <> v_conv then
    raise exception 'N9: a redelivered admitted message did not replay its admission: %', v_admitted;
  end if;
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.N2e', '5511900000858', ' ', now());
  if v_admitted ->> 'state' <> 'refused' or v_admitted ->> 'reason' <> 'empty_body' then
    raise exception 'N9: a redelivered refused message did not get its refusal again: %', v_admitted;
  end if;
  if exists (select 1 from ops.conversations where contact_ref = '5511900000858') then
    raise exception 'N9: a redelivery restored an erased number';
  end if;

  -- N6. The same number writing again opens a new conversation with its own clock.
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.N6', '5511900000858', 'synthetic', now());
  v_conv2 := (v_admitted ->> 'conversation_id')::uuid;
  if v_conv2 = v_conv or not exists (select 1 from ops.contact_identifier_retention r
                                       where r.conversation_id = v_conv2 and r.erased_at is null) then
    raise exception 'N6: a returning sender did not get a new conversation with its own clock';
  end if;

  -- N7. A number whose last message is past the retention is erased by the
  --     worker's capability, through the leased job alone.
  v_admitted := ops.receive_whatsapp_message('300000000000001', 'wamid.N7', '5511900000868', 'synthetic',
                                             now() - interval '13 months');
  v_old := (v_admitted ->> 'conversation_id')::uuid;
  select r.job_id into v_job from ops.contact_identifier_retention r where r.conversation_id = v_old;
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  v_status := ops.erase_due_contact_identifier();
  execute 'reset role';
  if v_status <> 'erased' or (select contact_ref from ops.conversations where id = v_old) <> 'erased:' || v_old::text
     or (select erasure_reason from ops.contact_identifier_retention where conversation_id = v_old) <> 'retention_expired' then
    raise exception 'N7: the worker did not erase a number past its retention (%)', v_status;
  end if;
  -- The capability refuses any other leased job.
  perform pg_temp.lease((select r.job_id from ops.contact_identifier_retention r where r.conversation_id = v_conv2));
  update ops.jobs set kind = 'content.retention_due' where id = current_setting('app.job_id')::uuid;
  begin
    execute 'set local role ops_worker';
    perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), v_conv2, 'erasure', 'p2b');
    raise exception 'N7: the worker executed the owner''s erasure';
  exception when insufficient_privilege then execute 'reset role';
  end;
  execute 'reset role';

  -- N8. The owner's sweep erases what is already due, and nothing else.
  perform ops.receive_whatsapp_message('300000000000001', 'wamid.N8', '5511900000878', 'synthetic',
                                       now() - interval '13 months');
  -- The sweep runs first: an OR's terms may be evaluated in any order.
  v_swept := ops.sweep_contact_identifier_retention(100, 'p2b-owner');
  if v_swept <> 1
     or exists (select 1 from ops.conversations where contact_ref = '5511900000878')
     or (select contact_ref from ops.conversations where id = v_conv2) <> '5511900000858' then
    raise exception 'N8: the sweep did not erase exactly the due number';
  end if;
end
$$;

rollback;
