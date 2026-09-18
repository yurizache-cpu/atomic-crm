-- Phase 2A, pre-push review: a review-queue failure must not undo a paid call.
--
-- THE DEFECT (measured before this migration, engine/domain/leadTriagePilot.dbtest.ts
-- "a review queue that fails after the provider answered"). The review item was
-- opened by an AFTER UPDATE trigger inside ops.complete_agent_run, in the same
-- statement that settles a run `succeeded` — which is the transaction AFTER the
-- provider call. If opening the review raised, that whole settlement rolled
-- back: the run stayed `running`, its next lease settled it `indeterminate`
-- (ops.claim_agent_run never starts a run twice), and the provider's valid,
-- already-paid answer was discarded with no way to recover it. At-most-once
-- held — the provider was called once — but a downstream queue could turn a
-- successful call into a lost one.
--
-- THE FIX, narrowly:
--   1. ops.open_review_for_run — the ONE derivation, idempotent, callable on
--      its own. It reads only what the database stored: the run's validated
--      result, and the consent state the admission recorded.
--   2. The trigger calls it inside its own subtransaction. If opening the
--      review fails, only that subtransaction rolls back: the run's settlement
--      and its result COMMIT, a WARNING names the run, and the job completes,
--      so nothing is left for a worker to retry and nothing can call again.
--   3. ops.open_missing_reviews — the recovery: it opens the review of every
--      succeeded lead_triage run that has none. Nothing is swallowed there:
--      a failure raises to the operator who ran it.
--
-- AND A FAIL-OPEN CLOSED (review finding). The first derivation looked the
-- admission up by RUN and defaulted do_not_contact to FALSE. A retry of the
-- admitted run (retry_of_run_id) — the very path an operator would use to
-- recover — or a second request on the same task is a different run, found no
-- admission, and opened a review a person could ACCEPT for a lead the trusted
-- source had blocked. Consent is now found by TASK, and a task no admission
-- created is do-not-contact.
--
-- AND A REPLAY THAT IS ONLY A LOOKUP (review finding). A redelivery used to
-- call ops.assign_task and ops.request_agent_run again, and ops.assign_task
-- checks a closed task and an inactive agent before its "already assigned"
-- no-op — so a replay converged only while the task was open. An admitted
-- message now answers with the work it already became, and nothing else runs.
-- That makes the payload fingerprint the only thing a replay is checked
-- against, so it is now INJECTIVE (a jsonb array, as ADR 0017 §7's request
-- fingerprints are): the old `|`-joined form let a contact reference containing
-- `|` make two different messages fingerprint alike.
--
-- No privilege changes for any application role; no SECURITY DEFINER.

-- ---------------------------------------------------------------------------
-- 1. The derivation. Opens the review of one succeeded lead_triage run, once.
--    Returns the review it OPENED, or NULL when there was nothing to open: the
--    run is of another capability, not succeeded, or already has its review.
-- ---------------------------------------------------------------------------

create or replace function ops.open_review_for_run(p_tenant_id uuid, p_run_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run    ops.agent_runs;
  v_dnc    boolean;
  v_review uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.open_review_for_run: no tenant scope';
  end if;

  select r.* into v_run
    from ops.agent_runs r
   where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.open_review_for_run: agent run not found in this tenant';
  end if;

  -- Only a lead triage run that succeeded, with the result the database
  -- validated when it settled, has advice for a person to review.
  if v_run.capability <> 'lead_triage' or v_run.status <> 'succeeded' or v_run.result is null then
    return null;
  end if;

  -- The consent state the ADMISSION recorded, from its trusted policy source,
  -- found by TASK rather than by run: a retry of the admitted run
  -- (retry_of_run_id), or a second request on the same task, is still that
  -- lead, and inherits what was recorded for it. A task no admission created
  -- has no established consent, and that is do-not-contact.
  select coalesce(bool_or(m.do_not_contact), true) into v_dnc
    from ops.inbound_messages m
   where m.tenant_id = v_run.tenant_id and m.task_id = v_run.task_id;

  insert into ops.review_items (
    tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (
    v_run.tenant_id, v_run.company_id, v_run.task_id, v_run.id, v_run.capability, v_run.result,
    v_dnc)
  on conflict (agent_run_id) do nothing
  returning id into v_review;

  if v_review is null then
    return null; -- already opened: a run is reviewed once
  end if;

  perform ops.record_event(
    v_run.tenant_id, v_run.company_id, 'lead_triage.review_pending', 'agent-runtime', 'task', v_run.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', v_run.id),
    v_run.correlation_id, null, format('review:%s:pending', v_run.id));

  return v_review;
end
$function$;

comment on function ops.open_review_for_run(uuid, uuid) is
  'Opens the human review of one succeeded lead_triage run from its stored, validated result, once. Returns the review it opened, or NULL when there was nothing to open. The only derivation of a review item: the settlement trigger and the recovery both call it.';

-- ---------------------------------------------------------------------------
-- 2. The trigger. The settlement of a paid call never waits on the queue.
-- ---------------------------------------------------------------------------

create or replace function ops.open_review_item()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.capability <> 'lead_triage' or new.status <> 'succeeded' or old.status = 'succeeded' then
    return null;
  end if;

  -- Its own subtransaction: a failure here rolls back the review and its fact,
  -- never the run's settlement. The run commits `succeeded` with its result,
  -- the job completes, and ops.open_missing_reviews() opens the review later.
  -- The warning names the run and the error class only — never the result.
  begin
    perform ops.open_review_for_run(new.tenant_id, new.id);
  exception when others then
    raise warning using message = format(
      'ops.open_review_item: the review of agent run %s was not opened (SQLSTATE %s); the run''s settlement stands, and ops.open_missing_reviews() opens it',
      new.id, sqlstate);
  end;
  return null;
end
$function$;

-- ---------------------------------------------------------------------------
-- 3. The recovery. Opens every missing review, bounded; raises on failure.
-- ---------------------------------------------------------------------------

create or replace function ops.open_missing_reviews(p_tenant_id uuid default null, p_limit integer default 100)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run    record;
  v_opened integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'OS400', message = 'ops.open_missing_reviews: the limit is 1 to 1000';
  end if;

  for v_run in
    select r.tenant_id, r.id
      from ops.agent_runs r
     where (p_tenant_id is null or r.tenant_id = p_tenant_id)
       and r.capability = 'lead_triage'
       and r.status = 'succeeded'
       and not exists (select 1 from ops.review_items v where v.agent_run_id = r.id)
     order by r.completed_at, r.id
     limit p_limit
  loop
    if ops.open_review_for_run(v_run.tenant_id, v_run.id) is not null then
      v_opened := v_opened + 1;
    end if;
  end loop;
  return v_opened;
end
$function$;

comment on function ops.open_missing_reviews(uuid, integer) is
  'Recovery: opens the review of every succeeded lead_triage run that has none, at most p_limit, optionally in one tenant. Returns how many it opened; running it again opens nothing twice. Unlike the settlement trigger it swallows nothing: a failure raises to the operator.';

-- ---------------------------------------------------------------------------
-- 4. Admission, redefined. Same signature and same authority; five changes:
--
--    a. A replay is a LOOKUP. An admitted message answers with the task and
--       run it already became; ops.assign_task, ops.request_agent_run and the
--       two facts are not called again, so a replay converges whatever has
--       happened to the task or the agent since.
--    b. The payload fingerprint is injective (v2: a jsonb array), because (a)
--       makes it the only check a replay meets.
--    c. The idempotency keys carry a HASH of the external id, so a valid id of
--       up to 200 characters derives keys that fit their 200-character limit
--       (an id over 173 characters used to fail at the last statement).
--    d. The `communication.received` fact no longer carries the payload
--       fingerprint: the ledger holds it, the fact had no use for it, and a
--       hash of a short message and a known sender is guessable. A body of
--       only whitespace of any kind is refused (btrim trimmed spaces only).
--    e. The task title is a constant, not "Lead triage: <sender>": the title
--       reaches the prompt and every listing, and the sender stays in the
--       ledger. An omitted consent argument is do-not-contact, not eligible.
-- ---------------------------------------------------------------------------

create or replace function ops.admit_inbound_message(
  p_tenant_id           uuid,
  p_company_id          uuid,
  p_agent_id            uuid,
  p_source_kind         text,
  p_external_message_id text,
  p_contact_ref         text,
  p_body                text,
  p_source              text,
  -- An omitted consent is do-not-contact. (It defaulted to false: eligible.)
  p_do_not_contact      boolean default true,
  p_received_at         timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_fingerprint text;
  v_key         text;
  v_title       text;
  v_id          uuid;
  v_existing    ops.inbound_messages;
  v_task        uuid;
  v_run         uuid;
begin
  if p_tenant_id is null or p_company_id is null then
    raise exception using errcode = 'OS401', message = 'ops.admit_inbound_message: no tenant scope';
  end if;
  if p_source_kind is null or p_source_kind <> 'synthetic' then
    raise exception using
      errcode = 'OS403',
      message = 'ops.admit_inbound_message: only synthetic messages are admitted in this phase';
  end if;
  if p_external_message_id is null or p_external_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.admit_inbound_message: an external message id is 1 to 200 printable characters';
  end if;
  if p_contact_ref is null or p_contact_ref !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.admit_inbound_message: a contact reference is 1 to 200 printable characters';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.admit_inbound_message: the source is missing or malformed';
  end if;
  -- Bounded well below the task description's 10000, so an oversize body is a
  -- typed refusal here rather than a CHECK violation two calls later — whose
  -- DETAIL line would print the failing row, and with it the body.
  if p_body is null or p_body !~ '\S' or char_length(p_body) > 4000 then
    raise exception using
      errcode = 'OS400',
      message = 'ops.admit_inbound_message: the message body is empty or longer than 4000 characters';
  end if;
  if p_received_at is null or p_received_at > now() + interval '1 minute' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.admit_inbound_message: received_at is missing or in the future';
  end if;

  -- The company is resolved INSIDE the caller's tenant, before anything is
  -- written.
  perform 1 from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using
      errcode = 'OS404',
      message = 'ops.admit_inbound_message: company not found in this tenant';
  end if;

  -- The semantic identity of the payload. Injective: every field is its own
  -- element of a jsonb array, so no choice of text in one can imitate another.
  v_fingerprint := encode(sha256(convert_to(
    jsonb_build_array('inbound.v2', p_source_kind, p_contact_ref, p_body)::text, 'UTF8')), 'hex');
  v_key := format('inbound:%s:%s', p_source_kind,
                  encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex'));

  insert into ops.inbound_messages (
    tenant_id, company_id, source_kind, external_message_id,
    contact_ref, do_not_contact, body_fingerprint, received_at)
  values (
    p_tenant_id, p_company_id, p_source_kind, p_external_message_id,
    p_contact_ref, coalesce(p_do_not_contact, true), v_fingerprint, p_received_at)
  on conflict (tenant_id, source_kind, external_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    -- The identity exists: a redelivery, a conflict, or a concurrent admission
    -- that committed first (this insert waited for it, and this read sees it).
    select m.* into v_existing
      from ops.inbound_messages m
     where m.tenant_id = p_tenant_id
       and m.source_kind = p_source_kind
       and m.external_message_id = p_external_message_id
       for update;
    if not found then
      -- Only if the row was deleted between the conflict and this read, which
      -- nothing but the database owner can do.
      raise exception using
        errcode = 'OS429',
        message = 'ops.admit_inbound_message: the admission this message conflicted with no longer exists; retry';
    end if;
    if v_existing.body_fingerprint <> v_fingerprint then
      raise exception using
        errcode = 'OS409',
        message = 'ops.admit_inbound_message: that message id was already admitted with a different message';
    end if;
    if v_existing.company_id <> p_company_id then
      raise exception using
        errcode = 'OS409',
        message = 'ops.admit_inbound_message: that message id was already admitted for another company';
    end if;
    if v_existing.task_id is not null and v_existing.agent_run_id is not null then
      -- A replay. The message already became work: answer with it, and do
      -- nothing else — no assignment, no request, no fact.
      return jsonb_build_object(
        'inbound_message_id', v_existing.id,
        'task_id', v_existing.task_id,
        'agent_run_id', v_existing.agent_run_id);
    end if;
    v_id := v_existing.id;
  end if;

  -- The task carries the body, because the runtime's prompt context is built
  -- from the task (ops.claim_agent_run). The title is a CONSTANT: it reaches
  -- the prompt and every task listing, and the sender's reference — a phone
  -- number once a real transport exists — belongs in the ledger, not there.
  v_title := 'Lead triage';
  v_task := ops.create_task(
    p_tenant_id, p_company_id, 'lead_triage', v_title, p_source, p_body,
    null, null, 100, null, null, null, v_key);

  perform ops.assign_task(p_tenant_id, v_task, p_agent_id, p_source);

  v_run := ops.request_agent_run(
    p_tenant_id, v_task, p_agent_id, 'lead_triage', v_key, p_source);

  update ops.inbound_messages
     set task_id = coalesce(task_id, v_task),
         agent_run_id = coalesce(agent_run_id, v_run)
   where id = v_id;

  -- Two facts. Identifiers and shape only: never the body, never the sender's
  -- own words, and no fingerprint of them.
  perform ops.record_event(
    p_tenant_id, p_company_id, 'communication.received', p_source, 'task', v_task,
    jsonb_build_object(
      'inbound_message_id', v_id,
      'source_kind', p_source_kind,
      'do_not_contact', coalesce(p_do_not_contact, true)),
    null, null, format('%s:received', v_key));

  perform ops.record_event(
    p_tenant_id, p_company_id, 'lead_triage.admitted', p_source, 'task', v_task,
    jsonb_build_object('inbound_message_id', v_id, 'agent_run_id', v_run),
    null, null, format('%s:admitted', v_key));

  return jsonb_build_object(
    'inbound_message_id', v_id,
    'task_id', v_task,
    'agent_run_id', v_run);
end
$function$;

comment on function ops.admit_inbound_message(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz) is
  'Admits one synthetic inbound message: one ledger row, one lead_triage task, one requested agent run, all on the same tenant-scoped identity. A redelivery is a lookup that answers with the work the message already became; a reused id with a different message is refused. Creates work only; it never calls a model. Consent is the caller''s trusted answer, and an unstated one is do-not-contact.';

-- The consent lookup of section 1 is by task.
create index if not exists inbound_messages_task_idx
  on ops.inbound_messages (tenant_id, task_id)
  where task_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Access: backend only, as every other ops service.
-- ---------------------------------------------------------------------------

-- Re-stated for the redefined admission: CREATE OR REPLACE keeps its ACL, and
-- this keeps the file correct on its own.
revoke all on function ops.admit_inbound_message(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz)
  from public, anon, authenticated, service_role, ops_worker;
revoke all on function ops.open_review_for_run(uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker;
revoke all on function ops.open_missing_reviews(uuid, integer)
  from public, anon, authenticated, service_role, ops_worker;

-- ---------------------------------------------------------------------------
-- 6. Assert the end state.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- The trigger still fires, on every session.
  if not exists (select 1 from pg_trigger
                  where tgname = 'agent_runs_open_review' and tgenabled = 'A') then
    raise exception 'agent_runs_open_review is missing or not ENABLE ALWAYS';
  end if;

  -- None of the three is a definer, all pin their search path, and no
  -- application role can execute any of them.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('open_review_for_run', 'open_review_item', 'open_missing_reviews',
                       'admit_inbound_message')
     and (p.prosecdef or p.proconfig is null
          or not ('search_path=""' = any (p.proconfig)));
  if v_bad is not null then
    raise exception 'review functions that are definers or float their search path: %', v_bad;
  end if;

  select string_agg(format('%s to %s', p.proname, r.rolname), ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r(rolname)
   where n.nspname = 'ops'
     and p.proname in ('open_review_for_run', 'open_missing_reviews',
                       'admit_inbound_message', 'record_review_decision')
     and has_function_privilege(r.rolname, p.oid, 'execute');
  if v_bad is not null then
    raise exception 'review recovery is executable by an application role: %', v_bad;
  end if;

  -- No role but the owner holds anything on the two pilot tables. Measured
  -- with has_table_privilege, which also sees a grant to PUBLIC: the first
  -- migration's assertion compared information_schema's grantee with
  -- lowercase 'public', which information_schema never reports, so a PUBLIC
  -- grant could not have tripped it.
  select string_agg(format('%s on %s to %s', v.p, v.t, v.r), ', ') into v_bad
    from (select t, r, p
            from unnest(array['ops.inbound_messages', 'ops.review_items']) t,
                 unnest(array['public', 'anon', 'authenticated', 'service_role', 'ops_worker']) r,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege(v.r, v.t, v.p);
  if v_bad is not null then
    raise exception 'the pilot tables are reachable: %', v_bad;
  end if;

  -- A bad limit is a typed refusal, not a scan of everything.
  begin
    perform ops.open_missing_reviews(null, 0);
    raise exception 'ops.open_missing_reviews accepted a limit of 0';
  exception when sqlstate 'OS400' then null;
  end;
end
$$;
