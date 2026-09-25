-- Phase 2A — attacks on the synthetic lead triage pilot.
--
-- The question: can the same inbound message be admitted twice, can a message
-- reach another tenant's company, can a review item exist without a valid model
-- answer, can a decision be changed after it is made, and can an item whose lead
-- must not be contacted be accepted anyway?
--
-- WHAT THIS SUITE PROVES, and what it leaves to the driver-backed suite:
--   * Here: admission identity, the conflict, tenant and company scoping, the
--     immutability of an admission and of a decision, the consent refusal, and
--     the access posture of the two new tables.
--   * There (engine/domain/leadTriagePilot.dbtest.ts): the whole path with a
--     real worker — the run is executed by the runtime, the trigger derives the
--     review item from a SUCCEEDED run, and nothing is called when the kill
--     switch or the budget refuses.
--
-- ONE TRANSACTION, ROLLED BACK.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures: two tenants, so every scoping case has somewhere to fail to reach.
-- ---------------------------------------------------------------------------

create temporary table pilot_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into pilot_ids (name, id) values (p_name, p_id) returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language sql stable as $$
  select id from pilot_ids where name = p_name;
$$;

do $$
declare
  c_source constant text := 'phase2a-suite';
  ta uuid;
  tb uuid;
  ca uuid;
  cb uuid;
  da uuid;
  db uuid;
begin
  insert into ops.tenants (slug, name) values ('p2a-test-alpha', 'P2A Alpha') returning id into ta;
  insert into ops.tenants (slug, name) values ('p2a-test-beta', 'P2A Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);

  ca := pg_temp.remember('company_a', ops.create_company(ta, 'clinic-a', 'Clinic A', c_source));
  cb := pg_temp.remember('company_b', ops.create_company(tb, 'clinic-b', 'Clinic B', c_source));
  da := pg_temp.remember('dept_a', ops.create_department(ta, ca, 'intake', 'Intake', c_source));
  db := pg_temp.remember('dept_b', ops.create_department(tb, cb, 'intake', 'Intake', c_source));

  perform pg_temp.remember('agent_a',
    ops.create_agent(ta, ca, da, 'lead-triage', 'Lead Triage', 'Intake assistant', c_source));
  perform pg_temp.remember('agent_b',
    ops.create_agent(tb, cb, db, 'lead-triage', 'Lead Triage', 'Intake assistant', c_source));
end
$$;

-- Governance, so a request is not refused for a reason this suite is not about:
-- ops.request_agent_run cancels a run when no price, ceiling or budget exists
-- (ADR 0017, owner decision A), and that refusal is runtime_governance.sql's
-- subject. One synthetic price and limits too large ever to refuse, inside this
-- rolled-back transaction.
do $$
begin
  perform ops.record_model_price(
    'fake', 'fake-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'p2a-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'p2a-test: sql suite ceiling', 'p2a-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'p2a-test: sql suite budget', 'p2a-owner',
                              pg_temp.id('tenant_a'));
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'p2a-test: sql suite budget', 'p2a-owner',
                              pg_temp.id('tenant_b'));
end
$$;

-- ---------------------------------------------------------------------------
-- A. Admission: one message, one unit of work, however many times it arrives.
-- ---------------------------------------------------------------------------

do $$
declare
  c_body constant text := 'Oi, vi o site e queria entender como funciona a primeira consulta.';
  first  jsonb;
  again  jsonb;
  v_tasks integer;
  v_runs  integer;
  v_rows  integer;
begin
  first := ops.admit_inbound_message(
    pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
    'synthetic', 'msg-0001', 'synthetic:lead-one', c_body, 'phase2a-suite', false, now());

  -- A1. It produced exactly one of each.
  if (first ->> 'inbound_message_id') is null
     or (first ->> 'task_id') is null
     or (first ->> 'agent_run_id') is null then
    raise exception 'A1: an admission did not name its work: %', first;
  end if;
  perform pg_temp.remember('task_one', (first ->> 'task_id')::uuid);
  perform pg_temp.remember('run_one', (first ->> 'agent_run_id')::uuid);
  perform pg_temp.remember('inbound_one', (first ->> 'inbound_message_id')::uuid);

  -- A2. The same delivery again converges on the same three ids.
  again := ops.admit_inbound_message(
    pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
    'synthetic', 'msg-0001', 'synthetic:lead-one', c_body, 'phase2a-suite', false, now());
  if again is distinct from first then
    raise exception 'A2: a redelivery produced different work: % then %', first, again;
  end if;

  select count(*) into v_rows from ops.inbound_messages
   where tenant_id = pg_temp.id('tenant_a') and external_message_id = 'msg-0001';
  select count(*) into v_tasks from ops.tasks
   where tenant_id = pg_temp.id('tenant_a') and type = 'lead_triage';
  select count(*) into v_runs from ops.agent_runs
   where tenant_id = pg_temp.id('tenant_a') and capability = 'lead_triage';
  if v_rows <> 1 or v_tasks <> 1 or v_runs <> 1 then
    raise exception 'A2: a redelivery created more work: % ledger, % tasks, % runs', v_rows, v_tasks, v_runs;
  end if;

  -- A3. The body is the task's description, and the ledger holds only its hash.
  if (select description from ops.tasks where id = pg_temp.id('task_one')) is distinct from c_body then
    raise exception 'A3: the admitted body is not the task description';
  end if;
  if (select body_fingerprint from ops.inbound_messages where id = pg_temp.id('inbound_one')) !~ '^[0-9a-f]{64}$' then
    raise exception 'A3: the ledger did not record a fingerprint';
  end if;

  -- A4. The task is assigned to the agent the run was requested for, and the
  --     run is pending with a job: nothing has been called.
  if (select assigned_agent_id from ops.tasks where id = pg_temp.id('task_one'))
     is distinct from pg_temp.id('agent_a') then
    raise exception 'A4: the admitted task is not assigned to the triage agent';
  end if;
  if not exists (select 1 from ops.agent_runs
                  where id = pg_temp.id('run_one')
                    and status = 'pending' and job_id is not null
                    and model_route = 'standard' and capability = 'lead_triage') then
    raise exception 'A4: the admitted run is not a pending lead_triage run with a job';
  end if;

  -- A5. Both facts were recorded, once each.
  if (select count(*) from ops.events
       where tenant_id = pg_temp.id('tenant_a')
         and type in ('communication.received', 'lead_triage.admitted')) <> 2 then
    raise exception 'A5: the admission facts were not recorded exactly once each';
  end if;
  -- ... and neither carries the lead's words.
  if exists (select 1 from ops.events
              where tenant_id = pg_temp.id('tenant_a')
                and type in ('communication.received', 'lead_triage.admitted')
                and payload::text like '%primeira consulta%') then
    raise exception 'A5: an event payload carries the message body';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- B. The conflict: the same identity may not name a different message.
-- ---------------------------------------------------------------------------

do $$
declare
  v_state text;
begin
  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'synthetic', 'msg-0001', 'synthetic:lead-one', 'A different message entirely.',
      'phase2a-suite', false, now());
    raise exception 'B1: a reused message id with a different body was admitted';
  exception when sqlstate 'OS409' then null;
  end;

  -- B2. The same body from a different sender is a different message, so the
  --     fingerprint refuses it too: identity is the pair, not the text.
  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'synthetic', 'msg-0001', 'synthetic:lead-two',
      'Oi, vi o site e queria entender como funciona a primeira consulta.',
      'phase2a-suite', false, now());
    raise exception 'B2: a reused message id with a different sender was admitted';
  exception when sqlstate 'OS409' then null;
  end;

  -- B3. Nothing was created by either refusal.
  if (select count(*) from ops.tasks where tenant_id = pg_temp.id('tenant_a') and type = 'lead_triage') <> 1 then
    raise exception 'B3: a refused admission still created work';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- C. Scope. The caller states the tenant; nothing in the message can move it.
-- ---------------------------------------------------------------------------

do $$
begin
  -- C1. Another tenant's company is simply not found inside this tenant.
  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_b'), pg_temp.id('agent_a'),
      'synthetic', 'msg-0002', 'synthetic:lead-one', 'Hello', 'phase2a-suite', false, now());
    raise exception 'C1: a message reached another tenant''s company';
  exception when sqlstate 'OS404' then null;
  end;

  -- C2. Another company's agent is not found either.
  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_b'),
      'synthetic', 'msg-0003', 'synthetic:lead-one', 'Hello', 'phase2a-suite', false, now());
    raise exception 'C2: a message was assigned to another company''s agent';
  exception when sqlstate 'OS404' then null;
  end;

  -- C3. The same external id in ANOTHER tenant is a different message, and is
  --     admitted: the identity is tenant-scoped, so no tenant can block or
  --     claim another's identifiers.
  perform ops.admit_inbound_message(
    pg_temp.id('tenant_b'), pg_temp.id('company_b'), pg_temp.id('agent_b'),
    'synthetic', 'msg-0001', 'synthetic:lead-one', 'A message to the other clinic.',
    'phase2a-suite', false, now());
  if (select count(*) from ops.inbound_messages where external_message_id = 'msg-0001') <> 2 then
    raise exception 'C3: the admission identity is not tenant-scoped';
  end if;

  -- C4. Only the synthetic transport exists in this phase.
  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'whatsapp', 'msg-0004', 'synthetic:lead-one', 'Hello', 'phase2a-suite', false, now());
    raise exception 'C4: a non-synthetic transport was admitted in Phase 2A';
  exception when sqlstate 'OS403' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- D. Malformed input is a typed refusal, never a stored row.
-- ---------------------------------------------------------------------------

do $$
declare
  v_before integer;
  v_after  integer;
begin
  select count(*) into v_before from ops.inbound_messages;

  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'synthetic', 'msg with spaces', 'synthetic:lead-one', 'Hello', 'phase2a-suite', false, now());
    raise exception 'D1: a malformed message id was admitted';
  exception when sqlstate 'OS400' then null;
  end;

  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'synthetic', 'msg-0005', 'synthetic:lead-one', '   ', 'phase2a-suite', false, now());
    raise exception 'D2: a blank body was admitted';
  exception when sqlstate 'OS400' then null;
  end;

  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'synthetic', 'msg-0006', 'synthetic:lead-one', repeat('a', 4001), 'phase2a-suite', false, now());
    raise exception 'D3: an oversize body was admitted';
  exception when sqlstate 'OS400' then null;
  end;

  begin
    perform ops.admit_inbound_message(
      pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
      'synthetic', 'msg-0007', 'synthetic:lead-one', 'Hello', 'phase2a-suite', false,
      now() + interval '1 day');
    raise exception 'D4: a message from the future was admitted';
  exception when sqlstate 'OS400' then null;
  end;

  select count(*) into v_after from ops.inbound_messages;
  if v_after <> v_before then
    raise exception 'D5: a refused admission stored a row (% then %)', v_before, v_after;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- E. The admission record is immutable, and it is never deleted.
-- ---------------------------------------------------------------------------

do $$
begin
  begin
    update ops.inbound_messages set body_fingerprint = repeat('0', 64)
     where id = pg_temp.id('inbound_one');
    raise exception 'E1: an admission''s fingerprint was rewritten';
  exception when sqlstate 'OS403' then null;
  end;

  begin
    update ops.inbound_messages set do_not_contact = true where id = pg_temp.id('inbound_one');
    raise exception 'E2: an admission''s consent state was rewritten';
  exception when sqlstate 'OS403' then null;
  end;

  begin
    update ops.inbound_messages set task_id = null where id = pg_temp.id('inbound_one');
    raise exception 'E3: an admission''s task link was cleared';
  exception when sqlstate 'OS403' then null;
  end;

  -- E4. The guard is ENABLE ALWAYS, so a session that switched ordinary
  --     triggers off still meets it.
  if not exists (select 1 from pg_trigger
                  where tgname = 'inbound_messages_guard_update' and tgenabled = 'A') then
    raise exception 'E4: the admission guard is not ENABLE ALWAYS';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- F. The decision. A review item is fixture data here; the trigger that DERIVES
--    one from a succeeded run is proven by the driver-backed suite, which has a
--    real runtime to succeed one with.
-- ---------------------------------------------------------------------------

do $$
declare
  c_proposed constant jsonb := jsonb_build_object(
    'outcome', 'triaged', 'summary', 'Wants to know how a first session works.',
    'intent', 'information', 'priority', 'normal',
    'recommended_next_action', 'Reply with how a first session works.',
    'response_draft', 'Oi! A primeira consulta dura 50 minutos.',
    'needs_human_review', true, 'flags', '[]'::jsonb);
  v_open uuid;
  v_blocked uuid;
  v_result jsonb;
begin
  -- The advice this fixture carries is what the contract admits, so a case
  -- below cannot pass on a result the database would have refused.
  if not ops.agent_run_result_valid('lead_triage', c_proposed) then
    raise exception 'F0: the fixture advice is not a valid lead_triage result';
  end if;

  insert into ops.review_items (tenant_id, company_id, task_id, agent_run_id, capability, proposed)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('task_one'),
          pg_temp.id('run_one'), 'lead_triage', c_proposed)
  returning id into v_open;

  -- F1. It starts pending, named by nobody.
  if not exists (select 1 from ops.review_items
                  where id = v_open and status = 'pending'
                    and reviewer is null and reviewed_at is null) then
    raise exception 'F1: a new review item is not pending and unattributed';
  end if;

  -- F2. A person decides, once.
  v_result := ops.record_review_decision(
    pg_temp.id('tenant_a'), v_open, 'accepted', 'owner', 'phase2a-suite', 'reads fine');
  if (v_result ->> 'status') <> 'accepted' or (v_result ->> 'recorded') <> 'true' then
    raise exception 'F2: the decision was not recorded: %', v_result;
  end if;
  if not exists (select 1 from ops.review_items
                  where id = v_open and status = 'accepted'
                    and reviewer = 'owner' and reviewed_at is not null) then
    raise exception 'F2: the decision named nobody or no time';
  end if;

  -- F3. The same decision again is the same fact, not a second one.
  v_result := ops.record_review_decision(
    pg_temp.id('tenant_a'), v_open, 'accepted', 'owner', 'phase2a-suite');
  if (v_result ->> 'recorded') <> 'false' then
    raise exception 'F3: a repeated decision was recorded twice: %', v_result;
  end if;
  if (select count(*) from ops.events
       where tenant_id = pg_temp.id('tenant_a') and type = 'lead_triage.reviewed') <> 1 then
    raise exception 'F3: a repeated decision recorded a second fact';
  end if;

  -- F4. A different answer to a decided item is refused, by the function...
  begin
    perform ops.record_review_decision(
      pg_temp.id('tenant_a'), v_open, 'rejected', 'someone else', 'phase2a-suite');
    raise exception 'F4: a decided item was decided again';
  exception when sqlstate 'OS409' then null;
  end;
  -- ... and by the guard, for a raw UPDATE that goes around it.
  begin
    update ops.review_items set status = 'rejected' where id = v_open;
    raise exception 'F4: a raw update changed a decided item';
  exception when sqlstate 'OS409' then null;
  end;

  -- F5. What was reviewed never changes.
  begin
    update ops.review_items set proposed = '{"outcome":"triaged"}'::jsonb where id = v_open;
    raise exception 'F5: the advice under a decision was rewritten';
  exception when sqlstate 'OS403' then null;
  end;

  -- F6. The decision guard is ENABLE ALWAYS: a session that switched ordinary
  --     triggers off still cannot rewrite a decision.
  if not exists (select 1 from pg_trigger
                  where tgname = 'review_items_guard_update' and tgenabled = 'A') then
    raise exception 'F6: the decision guard is not ENABLE ALWAYS';
  end if;

  -- F7. Nothing may be decided in another tenant's name.
  begin
    perform ops.record_review_decision(
      pg_temp.id('tenant_b'), v_open, 'rejected', 'owner', 'phase2a-suite');
    raise exception 'F7: another tenant decided this item';
  exception when sqlstate 'OS404' then null;
  end;

  -- F8. CONSENT. An item whose lead must not be contacted cannot be accepted,
  --     but it can be rejected: refusing to answer is always available.
  insert into ops.review_items (
    tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('task_one'),
          gen_random_uuid(), 'lead_triage', c_proposed, true)
  returning id into v_blocked;

  begin
    perform ops.record_review_decision(
      pg_temp.id('tenant_a'), v_blocked, 'accepted', 'owner', 'phase2a-suite');
    raise exception 'F8: a draft for a do-not-contact lead was accepted';
  exception when sqlstate 'OS403' then null;
  end;

  v_result := ops.record_review_decision(
    pg_temp.id('tenant_a'), v_blocked, 'rejected', 'owner', 'phase2a-suite');
  if (v_result ->> 'status') <> 'rejected' then
    raise exception 'F8: a do-not-contact item could not be rejected';
  end if;

  -- F9. An invented decision is refused before anything is read.
  begin
    perform ops.record_review_decision(
      pg_temp.id('tenant_a'), v_open, 'approved', 'owner', 'phase2a-suite');
    raise exception 'F9: an invented decision was recorded';
  exception when sqlstate 'OS400' then null;
  end;

  -- F10. A decision always names a person.
  begin
    perform ops.record_review_decision(
      pg_temp.id('tenant_a'), v_blocked, 'rejected', null, 'phase2a-suite');
    raise exception 'F10: a decision was recorded by nobody';
  exception when sqlstate 'OS400' then null;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- G. Access. Neither table is reachable by an application role, and neither
--    service is executable by one.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- G1. has_table_privilege, not information_schema: the latter reports the
  --     PUBLIC pseudo-role as 'PUBLIC', and an earlier form of this check
  --     compared it with 'public', so a grant to PUBLIC could not trip it.
  select string_agg(format('%s on %s to %s', v.p, v.t, v.r), ', ') into v_bad
    from (select t, r, p
            from unnest(array['ops.inbound_messages', 'ops.review_items']) t,
                 unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, v.t, v.p);
  if v_bad is not null then
    raise exception 'G1: the pilot tables are reachable: %', v_bad;
  end if;

  select string_agg(format('%s to %s', p.proname, r.rolname), ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r(rolname)
   where n.nspname = 'ops'
     and p.proname in ('admit_inbound_message', 'record_review_decision',
                       'open_review_for_run', 'open_missing_reviews')
     and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_bad is not null then
    raise exception 'G2: a pilot service is executable by an application role: %', v_bad;
  end if;

  -- G3. The pilot added no way for a task to start execution of its own.
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'G3: the task to job allowlist changed: %', ops.task_executable_kinds();
  end if;

  -- G4. And no new job kind at all. (Phase 2D.1 adds one external kind, the
  --     shadow decision, and Phase 3A the follow-up's governed kind and the
  --     three calendar kinds, none of which a task can request: G3 above.)
  if ops.external_job_kinds() is distinct from array['agent_run.execute', 'decision.shadow_evaluate', 'calendar.create', 'calendar.update', 'calendar.cancel']::text[]
     or ops.governed_job_kinds() is distinct from array['follow_up.due']::text[]
     or ops.internal_job_kinds() is distinct from array['postmark.ledger_retention']::text[] then
    raise exception 'G4: the job kinds changed';
  end if;
end
$$;

-- G5. Not only the catalogue: each application role, ACTUALLY switched to, is
--     refused every pilot service and table. A privilege check can be wrong
--     about what a role can do; an attempt cannot.
-- The owner is already a member of anon, authenticated and service_role
-- (rls_tenant_isolation.sql switches to them as it is); ops_worker needs the
-- grant, interpolated because `grant <role> to current_user` segfaults this
-- server build (ops_execution_core.sql).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

do $$
declare
  v_role    text;
  v_attempt text;
  v_reached text[] := array[]::text[];
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker'] loop
    foreach v_attempt in array array[
      format($q$select ops.admit_inbound_message(%L, %L, %L, 'synthetic', 'g5-probe', 'synthetic:g5', 'probe', 'g5-probe')$q$,
             pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a')),
      format($q$select ops.record_review_decision(%L, gen_random_uuid(), 'accepted', 'g5 probe', 'g5-probe')$q$,
             pg_temp.id('tenant_a')),
      format($q$select ops.open_missing_reviews(%L)$q$, pg_temp.id('tenant_a')),
      format($q$select ops.open_review_for_run(%L, gen_random_uuid())$q$, pg_temp.id('tenant_a')),
      'select count(*) from ops.inbound_messages',
      'select count(*) from ops.review_items',
      $q$update ops.review_items set status = 'accepted', reviewer = 'g5', reviewed_at = now()$q$
    ] loop
      begin
        execute format('set local role %I', v_role);
        execute v_attempt;
        v_reached := v_reached || format('%s: %s', v_role, v_attempt);
      exception when insufficient_privilege then
        -- Refused AT THE DOOR, as it must be: the schema, the pilot function
        -- or the pilot table itself. A denial from further in — a table the
        -- function reads — means the role got into the service, and a
        -- SECURITY INVOKER service it can enter is one grant away from working.
        if sqlerrm !~ '^permission denied for (schema ops|function (admit_inbound_message|record_review_decision|open_missing_reviews|open_review_for_run)|table (inbound_messages|review_items))$' then
          v_reached := v_reached || format('%s: %s (%s)', v_role, v_attempt, sqlerrm);
        end if;
      end;
      reset role;
    end loop;
  end loop;

  if cardinality(v_reached) > 0 then
    raise exception 'G5: an application role reached the pilot: %', array_to_string(v_reached, ' | ');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- H. The review-queue recovery (20260918090000). A run that never succeeded,
--    or of another capability, has nothing to open; the recovery is bounded.
-- ---------------------------------------------------------------------------

do $$
begin
  -- H1. The admitted run is still pending: there is nothing to review yet.
  if ops.open_review_for_run(pg_temp.id('tenant_a'), pg_temp.id('run_one')) is not null then
    raise exception 'H1: a review was opened for a run that has not succeeded';
  end if;

  -- H2. Nothing is opened across tenants: the run is not found in tenant B.
  begin
    perform ops.open_review_for_run(pg_temp.id('tenant_b'), pg_temp.id('run_one'));
    raise exception 'H2: another tenant opened this run''s review';
  exception when sqlstate 'OS404' then null;
  end;

  -- H3. Recovery finds nothing to open where no lead triage run succeeded,
  --     and refuses an unbounded scan.
  if ops.open_missing_reviews(pg_temp.id('tenant_a')) <> 0 then
    raise exception 'H3: recovery opened a review with no succeeded run to derive it from';
  end if;
  begin
    perform ops.open_missing_reviews(null, 100000);
    raise exception 'H3: recovery accepted an unbounded limit';
  exception when sqlstate 'OS400' then null;
  end;

  -- H4. The admission leaves no sender in the task: the title is a constant.
  if (select title from ops.tasks where id = pg_temp.id('task_one')) <> 'Lead triage' then
    raise exception 'H4: the admitted task title carries more than a constant';
  end if;

  -- H5. An omitted consent is do-not-contact, never eligible.
  perform ops.admit_inbound_message(
    pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
    'synthetic', 'msg-0100', 'synthetic:lead-three', 'Hello there', 'phase2a-suite');
  if not (select do_not_contact from ops.inbound_messages
           where tenant_id = pg_temp.id('tenant_a') and external_message_id = 'msg-0100') then
    raise exception 'H5: an admission with no stated consent was recorded eligible';
  end if;

  -- H6. An external id of the full 200 characters admits: the idempotency
  --     keys carry its hash, so they fit their own limit.
  perform ops.admit_inbound_message(
    pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
    'synthetic', repeat('x', 200), 'synthetic:lead-three', 'Hello again', 'phase2a-suite', false, now());
end
$$;

-- ---------------------------------------------------------------------------
-- I. The review is opened AFTER the settlement commits (20260918120000). The
--    statement that settles a run no longer touches the review queue, and the
--    worker's one way in is a step bound to a job it completed. The durability
--    itself (a real runtime, a real lock wait, a real statement timeout) is
--    proven by engine/domain/leadTriageSettlement.dbtest.ts.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad    text;
  v_job    uuid;
  v_opened uuid;
begin
  -- I1. No trigger on ops.agent_runs opens a review, so the settlement can
  --     neither wait on the review queue nor be cancelled by it. The old
  --     derivation trigger is kept only because dropping an ops trigger needs
  --     an owner-approved exception, and its function does nothing but return.
  select string_agg(t.tgname || ' -> ' || p.proname, ', ') into v_bad
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'ops.agent_runs'::regclass
     and not t.tgisinternal
     and p.prosrc ~* '(review_items|open_review_for_run|open_missing_reviews|open_review_for_settled_job)';
  if v_bad is not null then
    raise exception 'I1: a review is still opened inside the settlement: %', v_bad;
  end if;
  if regexp_replace(
       (select p.prosrc from pg_proc p where p.oid = 'ops.open_review_item()'::regprocedure),
       '\s+', ' ', 'g') <> ' begin return null; end ' then
    raise exception 'I1: the old derivation trigger does more than return';
  end if;

  -- I2. The post-settlement step is a DEFINER with an empty search path, and
  --     the worker's alone: no other application role, and not PUBLIC.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'ops.open_review_for_settled_job(text, uuid)'::regprocedure
       and p.prosecdef
       and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'I2: the post-settlement step is not a DEFINER with an empty search path';
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from unnest(array['anon', 'authenticated', 'service_role']) as r (rolname)
   where has_function_privilege(r.rolname, 'ops.open_review_for_settled_job(text, uuid)', 'execute');
  if v_bad is not null
     or not has_function_privilege('ops_worker', 'ops.open_review_for_settled_job(text, uuid)', 'execute')
     or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                 where p.oid = 'ops.open_review_for_settled_job(text, uuid)'::regprocedure
                   and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'I2: the post-settlement step is not the worker''s alone (%)',
      coalesce(v_bad, 'ops_worker lacks it, or PUBLIC holds it');
  end if;

  -- I3. As the worker: a job that is not a COMPLETED agent run job has nothing
  --     to open. The admitted run's job is still queued, and an unknown job
  --     does not exist. A blank worker id is refused.
  select r.job_id into v_job from ops.agent_runs r where r.id = pg_temp.id('run_one');
  if v_job is null then
    raise exception 'I3: the admitted run has no job; the case would prove nothing';
  end if;
  execute 'set local role ops_worker';
  v_opened := ops.open_review_for_settled_job('i3-worker', v_job);
  if v_opened is not null then
    raise exception 'I3: a queued job opened a review';
  end if;
  v_opened := ops.open_review_for_settled_job('i3-worker', gen_random_uuid());
  if v_opened is not null then
    raise exception 'I3: an unknown job opened a review';
  end if;
  begin
    perform ops.open_review_for_settled_job(' ', v_job);
    raise exception 'I3: a blank worker id was accepted';
  exception when sqlstate 'OS400' then null;
  end;
  reset role;
end
$$;

rollback;
