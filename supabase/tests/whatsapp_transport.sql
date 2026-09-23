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

  -- K3. Outside ops it executes no SECURITY DEFINER function but the ones
  --     PUBLIC already holds: the CRM's row-level-security helpers (read-only,
  --     answering for auth.uid()) and trigger functions (not callable). A new
  --     one shows up here by name.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema', 'ops')
     and p.prosecdef
     and has_schema_privilege('ops_gateway', n.oid, 'USAGE')
     and has_function_privilege('ops_gateway', p.oid, 'EXECUTE')
     and not (p.prorettype = 'trigger'::regtype
              or (n.nspname = 'public'
                  and p.proname in ('can_access_contact', 'can_access_deal', 'can_manage_sales_id',
                                    'current_sales_id', 'is_active_sales_user', 'is_admin')));
  if v_bad is not null then
    raise exception 'K3: ops_gateway executes a SECURITY DEFINER function outside ops: %', v_bad;
  end if;
end
$$;

rollback;
