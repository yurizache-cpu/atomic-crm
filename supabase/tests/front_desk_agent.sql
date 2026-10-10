-- ADR 0023 — attacks on the front-desk agent's database half.
--
-- The question: can any application role read or change the agent's
-- configuration, a conversation's state or a screening; can a published
-- configuration be edited or an autonomous send mode be written; can a
-- screening carry text it must not, or change after the fact; can a front-desk
-- run start without a screening that sent it to the model; and does a
-- screening's text leave with its task's content?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: the access posture, the configuration and screening guards, the
--     run trigger, the redaction trigger, the owner acts on a conversation,
--     and what a review shows (ADR 0023 §L).
--   * There (engine/domain/frontDeskPipeline.dbtest.ts): signed deliveries
--     through the gateway's own login, the real worker, the local screen, the
--     dispositions, the bounded context, and the proof that an omitted clause
--     reaches neither the model nor Jev.
--
-- ONE TRANSACTION, ROLLED BACK.

\set ON_ERROR_STOP on

begin;

create temporary table fd_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into fd_ids (name, id) values (p_name, p_id) returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from fd_ids where name = p_name;
$$;

create function pg_temp.policy(p_send_mode text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('sendMode', p_send_mode, 'sanitizerPack', 'health_pt_br.v1', 'contextTurns', 4,
                            'aiDisclosure', 'Synthetic virtual assistant.');
$$;

create function pg_temp.fixed() returns jsonb
language sql immutable as $$
  select jsonb_build_object('messages', (select jsonb_object_agg(k, 'Synthetic fixed text ' || k)
                                           from unnest(ops.fixed_message_keys()) k));
$$;

do $$
declare
  c_source constant text := 'front-desk-suite';
  ta uuid;
  tb uuid;
  ca uuid;
  da uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('fd-test-alpha', 'FD Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('fd-test-beta', 'FD Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  ca := pg_temp.remember('company_a', ops.create_company(ta, 'desk-a', 'Desk A', c_source));
  da := ops.create_department(ta, ca, 'intake', 'Intake', c_source);
  perform pg_temp.remember('agent_a', ops.create_agent(ta, ca, da, 'front-desk', 'Front Desk', 'Desk assistant', c_source));
  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'fd-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'fd-test: sql suite ceiling', 'fd-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'fd-test: budget', 'fd-owner', ta);
  perform pg_temp.remember('chan_a', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000071', 'test', 'A test', 'fd-owner'));
  perform ops.register_test_sender(ta, pg_temp.id('chan_a'), '5511900000071', 'fd-owner');
end
$$;

-- ---------------------------------------------------------------------------
-- F1. Access.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s on %s to %s', v.p, v.t, v.r), ', ') into v_bad
    from (select t, r, p
            from unnest(array['ops.agent_configuration_versions', 'ops.conversation_states',
                              'ops.conversation_transitions', 'ops.inbound_screenings']) t,
                 unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway',
                              'ops_operator_api']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, v.t, v.p);
  if v_bad is not null then
    raise exception 'F1: a front-desk table is reachable: %', v_bad;
  end if;

  -- The worker executes exactly its two new capabilities among the new functions.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('agent_configuration_kinds', 'fixed_message_keys', 'configured_text_valid',
                       'agent_configuration_valid', 'published_agent_configuration', 'draft_agent_configuration',
                       'publish_agent_configuration', 'move_conversation_state', 'crm_contact_is_client',
                       'open_scripted_review', 'take_over_conversation', 'release_conversation',
                       'record_person_reply', 'redact_task_screenings', 'require_inbound_screening')
     and (has_function_privilege('ops_worker', p.oid, 'execute') or has_function_privilege('ops_gateway', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('ops_operator_api', p.oid, 'execute'));
  if v_bad is not null then
    raise exception 'F1: an application role executes an owner act or a helper: %', v_bad;
  end if;
  if not has_function_privilege('ops_worker', 'ops.front_desk_policy_for_run()', 'execute')
     or not has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'execute')
     or has_function_privilege('ops_gateway', 'ops.record_inbound_screening(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'ops.record_inbound_screening(jsonb)', 'execute') then
    raise exception 'F1: the two worker capabilities are not exactly the worker''s';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- F2. Configuration versions.
-- ---------------------------------------------------------------------------

do $$
declare
  v1      uuid;
  v2      uuid;
  v_state jsonb;
  v_ok    boolean;
begin
  -- An autonomous send mode is not a policy: neither the act nor the table takes it.
  begin
    perform ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy',
                                          pg_temp.policy('autonomous'), 'fd-owner');
    raise exception 'F2: an autonomous send mode was drafted';
  exception when sqlstate 'OS400' then null;
  end;
  begin
    insert into ops.agent_configuration_versions (tenant_id, company_id, agent_id, kind, version, content,
                                                  content_sha256, drafted_by)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'), 'operating_policy', 99,
            pg_temp.policy('autonomous'), repeat('a', 64), 'fd-owner');
    raise exception 'F2: an autonomous send mode was inserted';
  exception when check_violation then null;
  end;
  -- A fixed set missing one text is refused.
  begin
    perform ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'fixed_messages',
                                          jsonb_build_object('messages', (pg_temp.fixed() -> 'messages') - 'safety'::text),
                                          'fd-owner');
    raise exception 'F2: a fixed set without the safety text was drafted';
  exception when sqlstate 'OS400' then null;
  end;
  -- The people a contact may ask for by name are a short list of names
  -- (20261015120000): a string, a number or a pattern is not one.
  begin
    perform ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy',
                                          pg_temp.policy('supervised') || '{"handoffNames": "Rafael"}'::jsonb,
                                          'fd-owner');
    raise exception 'F2: a name list that is not a list was drafted';
  exception when sqlstate 'OS400' then null;
  end;
  begin
    perform ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy',
                                          pg_temp.policy('supervised') || '{"handoffNames": ["(?:.*)"]}'::jsonb,
                                          'fd-owner');
    raise exception 'F2: a pattern was drafted as a name';
  exception when sqlstate 'OS400' then null;
  end;
  if not ops.agent_configuration_valid('operating_policy',
           pg_temp.policy('supervised') || '{"handoffNames": ["Rafael", "Dra. Helena"]}'::jsonb) then
    raise exception 'F2: a list of names was refused';
  end if;

  v1 := ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy',
                                      pg_temp.policy('supervised'), 'fd-owner');
  -- A draft is not read by anyone.
  if (ops.published_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy')).id is not null then
    raise exception 'F2: a draft was read as published';
  end if;
  v_state := ops.publish_agent_configuration(pg_temp.id('tenant_a'), v1, 'fd-owner');
  if v_state ->> 'state' <> 'published' then
    raise exception 'F2: publishing a draft answered %', v_state;
  end if;
  if ops.publish_agent_configuration(pg_temp.id('tenant_a'), v1, 'fd-owner') ->> 'state' <> 'already_published' then
    raise exception 'F2: publishing twice was not idempotent';
  end if;
  -- A published version is never edited, never set back to draft, never deleted.
  begin
    update ops.agent_configuration_versions set content = pg_temp.policy('staging') where id = v1;
    raise exception 'F2: a published version was edited';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    update ops.agent_configuration_versions set status = 'draft', published_at = null, published_by = null where id = v1;
    raise exception 'F2: a published version went back to draft';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.agent_configuration_versions where id = v1;
    raise exception 'F2: a version was deleted while its agent exists';
  exception when sqlstate 'OS403' then null;
  end;
  -- A second version supersedes the first; one published per kind.
  v2 := ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy',
                                      pg_temp.policy('staging'), 'fd-owner');
  v_state := ops.publish_agent_configuration(pg_temp.id('tenant_a'), v2, 'fd-owner');
  if (v_state ->> 'superseded_id')::uuid is distinct from v1 then
    raise exception 'F2: the second publication did not supersede the first: %', v_state;
  end if;
  select (select status from ops.agent_configuration_versions where id = v1) = 'superseded'
     and (ops.published_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy')).id = v2
    into v_ok;
  if not v_ok then
    raise exception 'F2: the published version is not exactly the second';
  end if;
  begin
    perform ops.publish_agent_configuration(pg_temp.id('tenant_a'), v1, 'fd-owner');
    raise exception 'F2: a superseded version was published again';
  exception when sqlstate 'OS409' then null;
  end;
  -- Another tenant cannot publish this tenant's version.
  begin
    perform ops.publish_agent_configuration(pg_temp.id('tenant_b'), v2, 'fd-owner');
    raise exception 'F2: another tenant reached this version';
  exception when sqlstate 'OS404' then null;
  end;
  -- The fixed texts, for the screenings below.
  perform ops.publish_agent_configuration(pg_temp.id('tenant_a'),
    ops.draft_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'fixed_messages', pg_temp.fixed(), 'fd-owner'),
    'fd-owner');
end
$$;

-- ---------------------------------------------------------------------------
-- F3. A front-desk run starts only after a screening sent it to the model;
--     a screening never carries text it must not, and never changes.
-- ---------------------------------------------------------------------------

do $$
declare
  v_answer jsonb;
  v_task   uuid;
  v_run    uuid;
  v_policy uuid;
begin
  v_answer := ops.receive_whatsapp_message('300000000000071', 'wamid.FD1', '5511900000071',
                                           'Synthetic question about prices', now() - interval '10 minutes');
  if v_answer ->> 'state' <> 'admitted' then
    raise exception 'setup: the test message was not admitted: %', v_answer;
  end if;
  select m.task_id, m.agent_run_id into v_task, v_run from ops.inbound_messages m where m.external_message_id = 'wamid.FD1';
  perform pg_temp.remember('task_1', v_task);
  perform pg_temp.remember('run_1', v_run);
  v_policy := (ops.published_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy')).id;

  -- Isolate the trigger under test from the runtime guard that would refuse a
  -- direct update first (the transaction is rolled back).
  alter table ops.agent_runs disable trigger agent_runs_guard_update;
  begin
    update ops.agent_runs
       set status = 'running', started_at = now(), job_attempt = 1, provider = 'fake', model = 'fake-model-1',
           prompt_version = 'lead_triage.v3', input_fingerprint = repeat('a', 64)
     where id = v_run;
    raise exception 'F3: a front-desk run started without a screening';
  exception when sqlstate 'OS403' then null;
  end;

  -- Shapes a screening can never have.
  begin
    insert into ops.inbound_screenings (tenant_id, company_id, task_id, agent_run_id, screener_version, pack_id,
      message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
      administrative_intent, person_requested, opt_out_requested, model_input, party_kind, disposition,
      policy_version_id)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_task, v_run, 'front_desk_screen.v2', 'health_pt_br.v1',
      'sensitive_only', 'none', 1, 1, 0, false, false, false, 'any text', 'prospect', 'model', v_policy);
    raise exception 'F3: a sensitive-only screening carried text to the model';
  exception when check_violation then null;
  end;
  begin
    insert into ops.inbound_screenings (tenant_id, company_id, task_id, agent_run_id, screener_version, pack_id,
      message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
      administrative_intent, person_requested, opt_out_requested, model_input, party_kind, disposition,
      policy_version_id)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_task, v_run, 'front_desk_screen.v2', 'health_pt_br.v1',
      'unknown', 'none', 1, 0, 1, false, false, false, null, 'prospect', 'model', v_policy);
    raise exception 'F3: an unknown screening was sent to the model';
  exception when check_violation then null;
  end;
  begin
    insert into ops.inbound_screenings (tenant_id, company_id, task_id, agent_run_id, screener_version, pack_id,
      message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
      administrative_intent, person_requested, opt_out_requested, model_input, party_kind, disposition,
      policy_version_id)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_task, v_run, 'front_desk_screen.v2', 'health_pt_br.v1',
      'safety', 'none', 1, 1, 0, false, false, false, null, 'prospect', 'held_for_person', v_policy);
    raise exception 'F3: a safety class without the crisis safety class was stored';
  exception when check_violation then null;
  end;

  -- The screening the worker records, then the start passes the trigger.
  insert into ops.inbound_screenings (tenant_id, company_id, task_id, agent_run_id, screener_version, pack_id,
    message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
    administrative_intent, person_requested, opt_out_requested, model_input, party_kind, disposition,
    policy_version_id)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_task, v_run, 'front_desk_screen.v2', 'health_pt_br.v1',
    'administrative', 'none', 0, 0, 0, true, false, false, 'Synthetic question about prices', 'prospect', 'model',
    v_policy);
  -- Past the trigger now: only the run's own shape (cost, price) can refuse
  -- this hand-made start, and an OS403 would not be caught here.
  begin
    update ops.agent_runs
       set status = 'running', started_at = now(), job_attempt = 1, provider = 'fake', model = 'fake-model-1',
           prompt_version = 'lead_triage.v3', input_fingerprint = repeat('a', 64)
     where id = v_run;
  exception when check_violation then null;
  end;
  alter table ops.agent_runs enable always trigger agent_runs_guard_update;

  begin
    update ops.inbound_screenings set message_class = 'mixed' where agent_run_id = v_run;
    raise exception 'F3: a screening changed';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    update ops.inbound_screenings set model_input = null, content_redacted_at = now() where agent_run_id = v_run;
    raise exception 'F3: a screening''s text was redacted without its task';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.inbound_screenings where agent_run_id = v_run;
    raise exception 'F3: a screening was deleted while its task exists';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- F4. The screened text leaves with its task's content.
-- ---------------------------------------------------------------------------

do $$
declare
  v_at timestamptz := now();
begin
  -- The recorded redaction of the task, as the retention ledger would stamp it.
  alter table ops.tasks disable trigger tasks_guard_update;
  alter table ops.tasks disable trigger tasks_request_identity_update;
  update ops.tasks set description = null, request_fingerprint = null, content_redacted_at = v_at
   where id = pg_temp.id('task_1');
  alter table ops.tasks enable always trigger tasks_guard_update;
  alter table ops.tasks enable always trigger tasks_request_identity_update;
  if exists (select 1 from ops.inbound_screenings s
              where s.task_id = pg_temp.id('task_1')
                and (s.model_input is not null or s.content_redacted_at is distinct from v_at)) then
    raise exception 'F4: the screened text outlived its task''s content';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- F5. Owner acts on a conversation, and its history.
-- ---------------------------------------------------------------------------

do $$
declare
  v_conv uuid;
  v_n    integer;
begin
  select m.conversation_id into v_conv from ops.inbound_messages m where m.external_message_id = 'wamid.FD1';
  if ops.take_over_conversation(pg_temp.id('tenant_a'), v_conv, 'fd-person') ->> 'state' <> 'taken_over'
     or ops.take_over_conversation(pg_temp.id('tenant_a'), v_conv, 'fd-person') ->> 'state' <> 'already_held' then
    raise exception 'F5: take-over is not recorded once';
  end if;
  begin
    perform ops.take_over_conversation(pg_temp.id('tenant_b'), v_conv, 'fd-person');
    raise exception 'F5: another tenant took the conversation over';
  exception when sqlstate 'OS404' then null;
  end;
  -- ADR 0026 §A: a person's reply names the revision the person saw; a
  -- conversation that moved since is refused, and so is a reply to a message
  -- whose content is gone (task_1 was redacted in F4).
  begin
    perform ops.record_person_reply(pg_temp.id('tenant_a'), v_conv, 'Synthetic reply', 'fd-person',
                                    ops.cos_conversation_revision(pg_temp.id('tenant_a'), v_conv) + 1);
    raise exception 'F5: a reply was recorded naming a revision the conversation is not at';
  exception when sqlstate 'OS409' then
    if sqlerrm not like '%list it again%' then
      raise exception 'F5: a stale revision was refused for another reason: %', sqlerrm;
    end if;
  end;
  begin
    perform ops.record_person_reply(pg_temp.id('tenant_a'), v_conv, 'Synthetic reply', 'fd-person',
                                    ops.cos_conversation_revision(pg_temp.id('tenant_a'), v_conv));
    raise exception 'F5: a reply was recorded to a message whose content was erased';
  exception when sqlstate 'OS409' then
    if sqlerrm not like '%erased under retention%' then
      raise exception 'F5: an erased message was refused for another reason: %', sqlerrm;
    end if;
  end;
  begin
    perform ops.record_person_reply(pg_temp.id('tenant_a'), v_conv, '', 'fd-person', 0);
    raise exception 'F5: an empty reply was accepted';
  exception when sqlstate 'OS400' then null;
  end;
  begin
    perform ops.record_person_reply(pg_temp.id('tenant_a'), v_conv, 'Synthetic reply', 'fd-person', null);
    raise exception 'F5: a reply naming no revision was accepted';
  exception when sqlstate 'OS400' then null;
  end;
  if ops.release_conversation(pg_temp.id('tenant_a'), v_conv, 'fd-person') ->> 'state' <> 'released' then
    raise exception 'F5: the release was not recorded';
  end if;
  select count(*) into v_n from ops.conversation_transitions t
   where t.conversation_id = v_conv and t.dimension = 'holder';
  if v_n <> 2 then
    raise exception 'F5: the holder history has % rows, expected 2', v_n;
  end if;
  begin
    update ops.conversation_transitions set reason = 'rewritten' where conversation_id = v_conv;
    raise exception 'F5: the history was rewritten';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.conversation_transitions where conversation_id = v_conv;
    raise exception 'F5: the history was deleted while its conversation exists';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- F6. The structured-decision input reads the screened text, never the raw.
-- ---------------------------------------------------------------------------

do $$
declare
  v_decision ops.structured_decisions;
  v_input    jsonb;
begin
  v_decision.tenant_id := pg_temp.id('tenant_a');
  v_decision.task_id := pg_temp.id('task_1');
  v_decision.agent_run_id := pg_temp.id('run_1');
  v_decision.decision_kind := 'business_route';
  -- The task's text is redacted now (F4): nothing is left to decide on.
  if ops.structured_decision_input(v_decision) is not null then
    raise exception 'F6: a business route was built after the screened text was redacted';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- F7. ADR 0023 §L: a review shows the screened text and the draft the send
--     would carry, never the raw message; the contact's newer message marks
--     it superseded; anything outside synthetic or test data reads unavailable.
-- ---------------------------------------------------------------------------

do $$
declare
  v_run    ops.agent_runs;
  v_item   ops.review_items;
  v_health ops.review_items;
  v_conv   jsonb;
  v_detail text;
  v_policy uuid;
  v_review uuid;
begin
  perform ops.receive_whatsapp_message('300000000000071', 'wamid.FD7A', '5511900000071',
                                       'FD7-RAW-MARKER synthetic worry, and what is the price', now() - interval '5 minutes');
  select r.* into v_run from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD7A');
  v_policy := (ops.published_agent_configuration(pg_temp.id('tenant_a'), pg_temp.id('agent_a'), 'operating_policy')).id;
  insert into ops.inbound_screenings (tenant_id, company_id, task_id, agent_run_id, screener_version, pack_id,
    message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
    administrative_intent, person_requested, opt_out_requested, model_input, party_kind, disposition,
    policy_version_id)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_run.task_id, v_run.id, 'front_desk_screen.v2',
    'health_pt_br.v1', 'mixed', 'none', 1, 1, 0, true, false, false, '[trecho omitido] what is the price',
    'prospect', 'model', v_policy);
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_run.task_id, v_run.id, 'lead_triage',
          jsonb_build_object('outcome', 'triaged', 'summary', 'Synthetic advice.', 'intent', 'other', 'priority', 'normal',
                             'recommended_next_action', 'Send the reply after review.', 'response_draft', 'FD7 synthetic draft',
                             'needs_human_review', true, 'flags', '[]'::jsonb),
          false)
  returning id into v_review;
  select r.* into v_item from ops.review_items r where r.id = v_review;

  v_conv := ops.read_review_detail(pg_temp.id('tenant_a'), v_item.id) -> 'conversation';
  if v_conv is distinct from jsonb_build_object(
       'status', 'available', 'author', 'agent',
       'screening', jsonb_build_object('messageClass', 'mixed', 'disposition', 'model', 'fixedMessageKey', null,
                                       'screenedMessage', '[trecho omitido] what is the price'),
       'replyDraft', 'FD7 synthetic draft', 'contentRedacted', false, 'answeredByPerson', false,
       'newerMessage', false) then
    raise exception 'F7: the review does not show the screened text and the draft: %', v_conv;
  end if;
  v_detail := ops.read_review_detail(pg_temp.id('tenant_a'), v_item.id)::text;
  if strpos(v_detail, 'FD7-RAW-MARKER') > 0 or strpos(v_detail, 'worry') > 0 then
    raise exception 'F7: the raw message reached the review';
  end if;

  -- The contact writes again: the reply is now out of context.
  perform ops.receive_whatsapp_message('300000000000071', 'wamid.FD7B', '5511900000071',
                                       'Synthetic follow-up question', now() - interval '1 minute');
  if not (ops.read_review_detail(pg_temp.id('tenant_a'), v_item.id) #>> '{conversation,newerMessage}')::boolean
     or not ops.cos_review_superseded(pg_temp.id('tenant_a'), v_item) then
    raise exception 'F7: a newer message did not mark the review superseded';
  end if;
  -- The newer message's own reply is not superseded by the older message.
  select r.* into v_run from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD7B');
  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_run.task_id, v_run.id, 'lead_triage',
          jsonb_build_object('outcome', 'triaged', 'summary', 'Synthetic advice.', 'intent', 'other', 'priority', 'normal',
                             'recommended_next_action', 'Send the reply after review.', 'response_draft', 'FD7 second draft',
                             'needs_human_review', true, 'flags', '[]'::jsonb),
          false)
  returning id into v_review;
  if ops.cos_review_superseded(pg_temp.id('tenant_a'), (select r from ops.review_items r where r.id = v_review)) then
    raise exception 'F7: the newest message read as superseded';
  end if;

  -- Once its content is redacted, the review shows no draft.
  v_health := v_item;
  v_health.content_redacted_at := now();
  if (ops.cos_review_conversation(pg_temp.id('tenant_a'), v_health) ->> 'replyDraft') is not null
     or not (ops.cos_review_conversation(pg_temp.id('tenant_a'), v_health) ->> 'contentRedacted')::boolean then
    raise exception 'F7: a redacted review still showed its draft';
  end if;

  -- Outside synthetic or test data, or another capability: nothing of it.
  v_health := v_item;
  v_health.capability := 'task_assessment';
  if ops.cos_review_conversation(pg_temp.id('tenant_a'), v_health) <> '{"status": "unavailable"}'::jsonb then
    raise exception 'F7: another capability showed its conversation';
  end if;
  alter table ops.tasks disable trigger tasks_guard_update;
  alter table ops.tasks disable trigger tasks_data_class_immutable;
  update ops.tasks set data_class = 'health' where id = v_item.task_id;
  alter table ops.tasks enable always trigger tasks_data_class_immutable;
  alter table ops.tasks enable always trigger tasks_guard_update;
  if ops.cos_review_conversation(pg_temp.id('tenant_a'), v_item) <> '{"status": "unavailable"}'::jsonb then
    raise exception 'F7: a review of health data showed its conversation';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- F7b. ADR 0026 §A: who wrote a review is bound at insert. The earlier turns
--      trust the author, so a mislabelled review is refused, and none opens on
--      a redacted task; one review per run, but a person's.
-- ---------------------------------------------------------------------------

do $$
declare
  v_run    ops.agent_runs;
  v_review uuid;
  v_fixed  ops.agent_runs;
  v_ctx    jsonb;
begin
  select r.* into v_run from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD7A');
  -- A fixed text only on a run the front desk settled with one.
  begin
    perform ops.open_scripted_review(v_run, 'FD7b fixed', 'fixed', 'clarification', 'front-desk-suite');
    raise exception 'F7b: a fixed text answered a run the front desk did not settle with one';
  exception when sqlstate 'OS403' then null;
  end;
  -- A person's reply only inside its own act.
  begin
    perform ops.open_scripted_review(v_run, 'FD7b person', 'person', null, 'front-desk-suite');
    raise exception 'F7b: a person''s reply was written outside its own act';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    perform ops.open_scripted_review(v_run, 'FD7b person', 'nobody', null, 'front-desk-suite');
    raise exception 'F7b: a review of no known author was opened';
  exception when sqlstate 'OS400' then null;
  end;
  -- One review per run: the agent's review of FD7A is there already (F7).
  begin
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_run.task_id, v_run.id, 'lead_triage', '{}'::jsonb, false);
    raise exception 'F7b: a run got a second review';
  exception when unique_violation then null;
  end;
  -- Who wrote it never changes.
  begin
    update ops.review_items set author = 'person', conversation_revision = 1
     where agent_run_id = v_run.id and author = 'agent';
    raise exception 'F7b: a review''s author changed';
  exception when sqlstate 'OS403' then null;
  end;

  -- The agent's model never answered a run the front desk settled without one.
  perform ops.receive_whatsapp_message('300000000000071', 'wamid.FD7C', '5511900000071',
                                       'Synthetic question for the guard', now());
  select r.* into v_fixed from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD7C');
  alter table ops.agent_runs disable trigger agent_runs_guard_update;
  v_ctx := ops.push_event_context('agent-runtime', null, null);
  update ops.agent_runs
     set status = 'cancelled', error_category = 'refused', error_code = 'front_desk_fixed_reply', completed_at = now()
   where id = v_fixed.id;
  perform ops.pop_event_context(v_ctx);
  alter table ops.agent_runs enable always trigger agent_runs_guard_update;
  begin
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_fixed.task_id, v_fixed.id, 'lead_triage', '{}'::jsonb, false);
    raise exception 'F7b: the agent was recorded as answering a run the front desk settled';
  exception when sqlstate 'OS403' then null;
  end;
  -- A fixed text still needs its screening's fixed disposition.
  select r.* into v_fixed from ops.agent_runs r where r.id = v_fixed.id;
  begin
    perform ops.open_scripted_review(v_fixed, 'FD7b fixed', 'fixed', 'clarification', 'front-desk-suite');
    raise exception 'F7b: a fixed text answered a run with no fixed screening';
  exception when sqlstate 'OS403' then null;
  end;
  -- Nor on a run the front desk held for a person.
  perform ops.receive_whatsapp_message('300000000000071', 'wamid.FD7D', '5511900000071',
                                       'Synthetic question held for a person', now());
  select r.* into v_fixed from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD7D');
  alter table ops.agent_runs disable trigger agent_runs_guard_update;
  v_ctx := ops.push_event_context('agent-runtime', null, null);
  update ops.agent_runs
     set status = 'cancelled', error_category = 'refused', error_code = 'front_desk_held_for_person', completed_at = now()
   where id = v_fixed.id;
  perform ops.pop_event_context(v_ctx);
  alter table ops.agent_runs enable always trigger agent_runs_guard_update;
  begin
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_fixed.task_id, v_fixed.id, 'lead_triage', '{}'::jsonb, false);
    raise exception 'F7b: the agent was recorded as answering a run held for a person';
  exception when sqlstate 'OS403' then
    if sqlerrm not like '%did not answer a run the front desk settled%' then
      raise exception 'F7b: the held run was refused for another reason: %', sqlerrm;
    end if;
  end;

  -- SI-72: no review opens on a redacted task (task_1's content went in F4).
  select r.* into v_run from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD1');
  begin
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_run.task_id, v_run.id, 'lead_triage', null, true);
    raise exception 'F7b: a review opened on a redacted task';
  exception when sqlstate 'OS409' then
    if sqlerrm not like '%redacted task%' then
      raise exception 'F7b: the redacted task was refused for another reason: %', sqlerrm;
    end if;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- F8. ADR 0025: the exception queue's store. Backend only; raised open, once
--     per subject and kind while open (a repeat is counted), with its kind's
--     priority; identity immutable; resolved once, by a person only for the
--     count the person saw; never deleted or truncated on its own; a release
--     resolves what it ends, and waits for a person on an opt-out.
--     (Where each kind is raised: exceptionQueue.dbtest.ts and
--     whatsappOutbound.dbtest.ts.)
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad    text;
  v_conv   uuid;
  v_task   uuid;
  v_id     uuid;
  v_again  uuid;
  v_n      integer;
  v_answer jsonb;
  ta       uuid := pg_temp.id('tenant_a');
  ca       uuid := pg_temp.id('company_a');
begin
  select string_agg(format('%s on ops.exceptions to %s', v.p, v.r), ', ') into v_bad
    from (select r, p
            from unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway',
                              'ops_operator_api']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, 'ops.exceptions', v.p);
  if v_bad is not null then
    raise exception 'F8: the exception store is reachable: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('guard_exception', 'refuse_exception_truncate', 'open_exception', 'close_exception',
                       'sync_send_exceptions', 'sync_tenant_send_exceptions', 'resolve_exception')
     and (p.prosecdef
          or has_function_privilege('ops_worker', p.oid, 'execute') or has_function_privilege('ops_gateway', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('ops_operator_api', p.oid, 'execute'));
  if v_bad is not null then
    raise exception 'F8: an exception function is a definer or reachable: %', v_bad;
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'ops.exceptions'::regclass and not t.tgisinternal and t.tgenabled = 'A') <> 2 then
    raise exception 'F8: the exception store''s two guards are not both ENABLE ALWAYS';
  end if;

  select m.conversation_id, m.task_id into v_conv, v_task from ops.inbound_messages m
   where m.external_message_id = 'wamid.FD1';

  -- Raised open, once while open, with its kind's priority and one event.
  v_id := ops.open_exception(ta, ca, v_task, 'person_requested', v_conv, null, null, 'fd-suite');
  v_again := ops.open_exception(ta, ca, v_task, 'person_requested', v_conv, null, null, 'fd-suite');
  if v_id is null or v_again is not null then
    raise exception 'F8: an open episode was raised twice';
  end if;
  if (select e.occurrences from ops.exceptions e where e.id = v_id) <> 2 then
    raise exception 'F8: a repeat of an open episode was not counted';
  end if;
  if (select e.priority from ops.exceptions e where e.id = v_id) <> 'high' then
    raise exception 'F8: a request for a person is not high priority';
  end if;
  select count(*) into v_n from ops.events e
   where e.tenant_id = ta and e.type = 'exception.raised' and e.payload ->> 'exception_id' = v_id::text
     and e.source = 'exception-queue' and e.subject_type = 'task' and e.subject_id = v_task;
  if v_n <> 1 then
    raise exception 'F8: the raise recorded % events about its task, expected 1', v_n;
  end if;

  -- Shapes the store refuses.
  begin
    insert into ops.exceptions (tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
                                conversation_id, raised_by)
    values (ta, ca, v_task, 'person_requested', 'normal', 'conversation', v_conv, v_conv, 'fd-suite');
    raise exception 'F8: a request for a person was stored below high';
  exception when check_violation then null;
  end;
  begin
    insert into ops.exceptions (tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
                                conversation_id, raised_by)
    values (ta, ca, v_task, 'send_failed', 'normal', 'conversation', v_conv, v_conv, 'fd-suite');
    raise exception 'F8: a send exception was stored about a conversation';
  exception when check_violation then null;
  end;
  begin
    insert into ops.exceptions (tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
                                conversation_id, raised_by)
    values (ta, ca, v_task, 'contact_unresolved', 'high', 'conversation', v_conv, v_conv, 'fd-suite');
    raise exception 'F8: an unresolved contact was stored without why';
  exception when check_violation then null;
  end;
  begin
    insert into ops.exceptions (tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
                                conversation_id, raised_by, resolved_at, resolved_by, resolution)
    values (ta, ca, v_task, 'message_waiting', 'normal', 'conversation', v_conv, v_conv, 'fd-suite',
            now(), 'fd-suite', 'dismissed');
    raise exception 'F8: an exception was born resolved';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    insert into ops.exceptions (tenant_id, company_id, task_id, kind, priority, subject_kind, subject_id,
                                conversation_id, raised_by)
    values (ta, ca, v_task, 'person_requested', 'high', 'conversation', v_conv, v_conv, 'fd-suite');
    raise exception 'F8: a second open episode was stored';
  exception when unique_violation then null;
  end;

  -- Identity immutable; never deleted or truncated on its own.
  begin
    update ops.exceptions set kind = 'opt_out', priority = 'normal' where id = v_id;
    raise exception 'F8: an exception changed kind';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    update ops.exceptions set occurrences = occurrences + 2 where id = v_id;
    raise exception 'F8: a count jumped by more than one occurrence';
  exception when sqlstate 'OS403' then null;
  end;
  begin
    delete from ops.exceptions where id = v_id;
    raise exception 'F8: an exception was deleted while its subject exists';
  exception when sqlstate 'OS403' then null;
  end;
  -- A plain truncate is refused by the opt-out requests' foreign key (ADR
  -- 0026 §C) before the guard; a cascading one reaches the guards.
  begin
    truncate ops.exceptions;
    raise exception 'F8: the exception store was truncated';
  exception when sqlstate 'OS403' or sqlstate '0A000' then null;
  end;
  begin
    truncate ops.exceptions cascade;
    raise exception 'F8: the exception store was truncated with its dependants';
  exception when sqlstate 'OS403' then null;
  end;

  -- The release resolves what it ends, once, by the person who released it.
  perform ops.take_over_conversation(ta, v_conv, 'fd-person');
  if ops.release_conversation(ta, v_conv, 'fd-person') ->> 'state' <> 'released' then
    raise exception 'F8: the release was not recorded';
  end if;
  if not exists (select 1 from ops.exceptions e
                  where e.id = v_id and e.resolution = 'released' and e.resolved_by = 'fd-person'
                    and e.resolved_at is not null) then
    raise exception 'F8: the release did not resolve the request for a person';
  end if;
  select count(*) into v_n from ops.events e
   where e.tenant_id = ta and e.type = 'exception.resolved' and e.payload ->> 'exception_id' = v_id::text
     and e.payload ->> 'resolution' = 'released';
  if v_n <> 1 then
    raise exception 'F8: the resolution recorded % events, expected 1', v_n;
  end if;
  if ops.close_exception(v_id, 'dismissed', 'fd-suite') then
    raise exception 'F8: a resolved exception was resolved again';
  end if;
  begin
    update ops.exceptions set resolution = 'dismissed', resolved_by = 'fd-suite' where id = v_id;
    raise exception 'F8: a resolved exception changed';
  exception when sqlstate 'OS403' then null;
  end;
  v_answer := ops.resolve_exception(ta, v_id, 'dismissed', 'fd-person', 2);
  if v_answer ->> 'state' <> 'already_resolved' or v_answer ->> 'resolution' <> 'released' then
    raise exception 'F8: a repeated resolution did not answer the recorded one: %', v_answer;
  end if;

  -- A new occurrence is a new episode.
  v_again := ops.open_exception(ta, ca, v_task, 'person_requested', v_conv, null, null, 'fd-suite');
  if v_again is null or v_again = v_id then
    raise exception 'F8: a resolved episode absorbed a new occurrence';
  end if;

  -- An opt-out is resolved by a person, never by a release, and only for
  -- the occurrences the person saw. Danger is no kind at all (owner decision,
  -- 2026-10-08: the front desk answers leads, not patients).
  begin
    perform ops.open_exception(ta, ca, v_task, 'safety', v_conv, null, null, 'fd-suite');
    raise exception 'F8: danger was raised as an exception';
  exception when check_violation then null;
  end;
  v_id := ops.open_exception(ta, ca, v_task, 'opt_out', v_conv, null, null, 'fd-suite');
  perform ops.open_exception(ta, ca, v_task, 'opt_out', v_conv, null, null, 'fd-suite');
  begin
    perform ops.resolve_exception(ta, v_id, 'resolved', 'fd-person', 1);
    raise exception 'F8: a person resolved an opt-out without seeing its repeat';
  exception when sqlstate 'OS409' then null;
  end;
  perform ops.take_over_conversation(ta, v_conv, 'fd-person');
  begin
    perform ops.release_conversation(ta, v_conv, 'fd-person');
    raise exception 'F8: a conversation was released with an opt-out open';
  exception when sqlstate 'OS409' then null;
  end;
  begin
    perform ops.resolve_exception(pg_temp.id('tenant_b'), v_id, 'resolved', 'fd-person', 2);
    raise exception 'F8: another tenant resolved the exception';
  exception when sqlstate 'OS404' then null;
  end;
  begin
    perform ops.resolve_exception(ta, v_id, 'released', 'fd-person', 2);
    raise exception 'F8: a person recorded a release as a resolution';
  exception when sqlstate 'OS400' then null;
  end;
  begin
    perform ops.resolve_exception(ta, v_id, 'resolved', 'two words', 2);
    raise exception 'F8: a malformed actor resolved an exception';
  exception when sqlstate 'OS400' then null;
  end;
  -- One statement each: an expression reads the snapshot taken before its own calls.
  if ops.resolve_exception(ta, v_id, 'resolved', 'fd-person', 2) ->> 'state' <> 'resolved' then
    raise exception 'F8: a person could not resolve the opt-out';
  end if;
  if ops.release_conversation(ta, v_conv, 'fd-person') ->> 'state' <> 'released' then
    raise exception 'F8: the conversation was not released once the opt-out was resolved';
  end if;
  if exists (select 1 from ops.exceptions e where e.conversation_id = v_conv and e.resolved_at is null) then
    raise exception 'F8: the release left an exception open';
  end if;

  -- A send the tenant does not have syncs to nothing, and raises nothing.
  if ops.sync_send_exceptions(ta, gen_random_uuid(), 'fd-suite') <> '{"opened": 0, "closed": 0}'::jsonb then
    raise exception 'F8: an unknown send was synced';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- F9. ADR 0026 §B: the texts the owner lets leave on their own are a closed
--     list of fixed-text keys; a person's decision never names the policy,
--     and the policy decides only a published fixed text the screen selected.
-- ---------------------------------------------------------------------------

do $$
declare
  v_run    ops.agent_runs;
  v_review uuid;
begin
  -- The policy's list: fixed-text keys the screen selects, each once.
  if not ops.agent_configuration_valid('operating_policy',
       pg_temp.policy('supervised') || '{"automaticFixedTexts": ["safety", "safety_followup", "opt_out_ack"]}'::jsonb)
     or not ops.agent_configuration_valid('operating_policy',
       pg_temp.policy('supervised') || '{"automaticFixedTexts": []}'::jsonb) then
    raise exception 'F9: a valid list of automatic texts was refused';
  end if;
  if ops.agent_configuration_valid('operating_policy',
       pg_temp.policy('supervised') || '{"automaticFixedTexts": ["model"]}'::jsonb)
     or ops.agent_configuration_valid('operating_policy',
       pg_temp.policy('supervised') || '{"automaticFixedTexts": ["out_of_scope"]}'::jsonb)
     or ops.agent_configuration_valid('operating_policy',
       pg_temp.policy('supervised') || '{"automaticFixedTexts": ["safety", "safety"]}'::jsonb)
     or ops.agent_configuration_valid('operating_policy',
       pg_temp.policy('supervised') || '{"automaticFixedTexts": "safety"}'::jsonb) then
    raise exception 'F9: an automatic-text list naming something other than a fixed text the screen selects passed';
  end if;
  -- The second safety text is optional in a published set, and a text when present.
  if not ops.agent_configuration_valid('fixed_messages', pg_temp.fixed() #- '{messages,safety_followup}') then
    raise exception 'F9: a fixed set without the second safety text was refused';
  end if;
  if ops.agent_configuration_valid('fixed_messages', jsonb_set(pg_temp.fixed(), '{messages,safety_followup}', '""')) then
    raise exception 'F9: an empty second safety text passed';
  end if;

  -- A person's decision never names the policy.
  select r.* into v_run from ops.agent_runs r
   where r.id = (select m.agent_run_id from ops.inbound_messages m where m.external_message_id = 'wamid.FD7A');
  select ri.id into v_review from ops.review_items ri where ri.agent_run_id = v_run.id and ri.author = 'agent';
  begin
    perform ops.record_review_decision(pg_temp.id('tenant_a'), v_review, 'rejected', 'policy:fixed-text', 'front-desk-suite');
    raise exception 'F9: a person recorded a decision as the policy';
  exception when sqlstate 'OS400' then null;
  end;
  -- The policy decides only a published fixed text the screen selected.
  begin
    update ops.review_items
       set status = 'accepted', reviewer = 'policy:fixed-text', decision_basis = 'published_fixed_text', reviewed_at = now()
     where id = v_review;
    raise exception 'F9: the policy accepted the agent''s own draft';
  exception when sqlstate 'OS403' or sqlstate '23514' then null;
  end;
  begin
    insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact,
                                  status, reviewer, reviewed_at, decision_basis)
    values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), v_run.task_id, gen_random_uuid(), 'lead_triage', '{}'::jsonb,
            false, 'accepted', 'policy:fixed-text', now(), 'published_fixed_text');
    raise exception 'F9: a review was written already accepted as policy';
  exception when sqlstate 'OS403' then null;
  end;
  -- A send authorized as policy rests on a review the policy accepted.
  begin
    insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
                                       status, requested_by, authorized_check, authorization_kind, job_id,
                                       fixed_text_key, fixed_messages_version_id, fresh_until)
    select m.tenant_id, m.company_id, m.channel_id, m.conversation_id, v_review, v_run.task_id,
           'authorized', 'policy:fixed-text', '{}'::jsonb, 'fixed_text',
           ops.enqueue_job(m.tenant_id, 'outbound.reply_send', '{}'::jsonb, 100, now(), 5, 'fd9-forged'),
           'safety', gen_random_uuid(), now() + interval '30 minutes'
      from ops.inbound_messages m where m.external_message_id = 'wamid.FD7A';
    raise exception 'F9: a policy send was written for a review the policy never accepted';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;

rollback;
