-- Phase 2A — synthetic lead triage pilot.
--
-- The first end-to-end Company OS workflow, and deliberately the smallest one
-- that proves the path: a synthetic inbound message is admitted exactly once,
-- becomes exactly one lead_triage task, which explicitly requests exactly one
-- agent run, which the Phase 1D/1D.1 runtime executes under the kill switch,
-- the price, the spend limits and at-most-once external-call semantics. The
-- run's advisory answer opens a human review item. A person decides. Nothing is
-- sent, and nothing in the CRM is written.
--
-- WHAT THIS ADDS
--   1. A second agent-run capability, `lead_triage`, and its output contract,
--      checked by the database exactly as `task_assessment` is.
--   2. ops.inbound_messages — the minimal admission ledger. It proves inbound
--      idempotency and NOTHING else: no conversation, no thread, no history.
--   3. ops.review_items — the minimal human-review primitive: one advisory
--      result, one decision, terminal once decided.
--   4. ops.admit_inbound_message — the one ingress service. It creates work; it
--      never calls a model. The model is reached only through the existing
--      request → job → runtime path.
--   5. A trigger that derives a review item from a run that SUCCEEDED, in the
--      same statement that settles the run, so a review item cannot exist for a
--      run that did not produce a valid result.
--   6. ops.record_review_decision — the one way a decision is recorded.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
--   No job kind (the existing `agent_run.execute` carries the run), no outbound
--   transport, no CRM write, no scheduling, no conversation model, and no new
--   privilege for any application role.
--
-- Q8 (BASELINE): still open. Every row this migration makes possible carries
-- SYNTHETIC content in Phase 2A. `ops.inbound_messages.source_kind` admits only
-- 'synthetic' here; adding a real transport is Phase 2B's migration, and it is
-- the point at which Q8 must already be answered.
--
-- WHERE THE MESSAGE BODY LIVES, and why it is not here. The model's prompt
-- context comes from ops.claim_agent_run, which reads the TASK's title and
-- description. So the admitted body is the task's description — the row the
-- runtime already bounds, fingerprints and share-locks — and this ledger keeps
-- only a sha256 of it. One copy, in the place the work already needed it.

-- ---------------------------------------------------------------------------
-- 1. The capability catalogue, with the pilot's capability added.
--
--    `lead_triage` routes to the standard tier, as `task_assessment` does: the
--    work is short, structured and not reasoning-heavy, and the route's output
--    ceiling (8000) bounds the reservation the spend gate makes for it.
-- ---------------------------------------------------------------------------

create or replace function ops.agent_run_capabilities()
returns table (capability text, model_route text)
language sql
immutable
set search_path to ''
as $function$
  select * from (values
    ('task_assessment', 'standard'),
    ('lead_triage', 'standard')
  ) as c (capability, model_route);
$function$;

comment on function ops.agent_run_capabilities() is
  'The agent run capabilities and the model route of each. A capability exists here or a run of it cannot be requested. Mirrored by engine/models: task_assessment.ts and leadTriage.ts.';

-- ---------------------------------------------------------------------------
-- 2. The output contract of each capability, checked by the DATABASE as well as
--    by the worker, so a worker defect cannot store an unvalidated model answer.
--
--    task_assessment is unchanged, character for character.
--
--    lead_triage is the pilot's advisory shape. Every field is bounded and the
--    three vocabulary fields are enums, so a model cannot widen the contract by
--    inventing a value. `response_draft` is a DRAFT: no code path sends it, and
--    §7 below refuses to accept a review whose contact must not be contacted.
--    `needs_human_review` is recorded but never trusted to be true — Phase 2A
--    reviews every successful run regardless of what the model says about it.
-- ---------------------------------------------------------------------------

create or replace function ops.agent_run_result_valid(p_capability text, p_result jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_keys text[];
  v_step jsonb;
  v_flag jsonb;
  v_seen text[];
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 16384 then
    return false;
  end if;

  select array_agg(k collate "C" order by k collate "C") into v_keys
    from jsonb_object_keys(p_result) as k;

  if p_capability = 'task_assessment' then
    if v_keys is distinct from array['outcome', 'proposed_next_steps', 'summary']::text[] then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'outcome') is distinct from 'string'
       or (p_result ->> 'outcome') not in ('completed', 'needs_input', 'blocked') then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'summary') is distinct from 'string'
       or char_length(p_result ->> 'summary') not between 1 and 1000
       or (p_result ->> 'summary') !~ '\S' then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'proposed_next_steps') is distinct from 'array'
       or jsonb_array_length(p_result -> 'proposed_next_steps') > 10 then
      return false;
    end if;
    for v_step in select s.value from jsonb_array_elements(p_result -> 'proposed_next_steps') as s loop
      if jsonb_typeof(v_step) <> 'string'
         or char_length(v_step #>> '{}') not between 1 and 300
         or (v_step #>> '{}') !~ '\S' then
        return false;
      end if;
    end loop;

    return true;
  end if;

  if p_capability = 'lead_triage' then
    -- In C collation order, which is the order v_keys was built in.
    if v_keys is distinct from array['flags', 'intent', 'needs_human_review', 'outcome',
                                     'priority', 'recommended_next_action', 'response_draft',
                                     'summary']::text[] then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'outcome') is distinct from 'string'
       or (p_result ->> 'outcome') not in ('triaged', 'needs_input', 'out_of_scope') then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'intent') is distinct from 'string'
       or (p_result ->> 'intent') not in ('book_appointment', 'pricing', 'information',
                                          'support', 'other') then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'priority') is distinct from 'string'
       or (p_result ->> 'priority') not in ('low', 'normal', 'high') then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'needs_human_review') is distinct from 'boolean' then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'summary') is distinct from 'string'
       or char_length(p_result ->> 'summary') not between 1 and 1000
       or (p_result ->> 'summary') !~ '\S' then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'recommended_next_action') is distinct from 'string'
       or char_length(p_result ->> 'recommended_next_action') not between 1 and 300
       or (p_result ->> 'recommended_next_action') !~ '\S' then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'response_draft') is distinct from 'string'
       or char_length(p_result ->> 'response_draft') not between 1 and 2000
       or (p_result ->> 'response_draft') !~ '\S' then
      return false;
    end if;

    if jsonb_typeof(p_result -> 'flags') is distinct from 'array'
       or jsonb_array_length(p_result -> 'flags') > 5 then
      return false;
    end if;
    v_seen := array[]::text[];
    for v_flag in select f.value from jsonb_array_elements(p_result -> 'flags') as f loop
      if jsonb_typeof(v_flag) <> 'string'
         or (v_flag #>> '{}') not in ('possible_crisis', 'minor', 'out_of_scope',
                                      'already_a_patient', 'spam', 'unclear') then
        return false;
      end if;
      -- A repeated flag is not a second fact; refusing it keeps the array a set.
      if (v_flag #>> '{}') = any (v_seen) then
        return false;
      end if;
      v_seen := v_seen || (v_flag #>> '{}');
    end loop;

    return true;
  end if;

  return false;
end
$function$;

comment on function ops.agent_run_result_valid(text, jsonb) is
  'The output contract of each capability, enforced by ops.complete_agent_run so a worker defect cannot store an unvalidated model answer. Mirrored by engine/models/taskAssessment.ts and engine/models/leadTriage.ts, which are never looser.';

-- ---------------------------------------------------------------------------
-- 3. The admission ledger.
--
--    Its ONLY job is to prove that the same inbound message is admitted once.
--    It is not an inbox: no thread, no direction, no participants, no history,
--    and no body. `body_fingerprint` is the semantic identity of the payload —
--    the same key with a different body is a conflict, not a second delivery.
-- ---------------------------------------------------------------------------

create table if not exists ops.inbound_messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references ops.tenants (id) on delete restrict,
  company_id          uuid not null,
  -- Phase 2A admits ONE kind. A real transport is a Phase 2B migration, and Q8
  -- must be answered before that kind exists.
  source_kind         text not null,
  -- The transport's own identifier for the message. Caller data, tenant-scoped,
  -- and a grant of nothing.
  external_message_id text not null,
  -- The sender as the transport names it. Synthetic in Phase 2A; never a CRM
  -- foreign key (CLAUDE.md rule 1: no bigint FK into public.*).
  contact_ref         text not null,
  -- The consent state the ingress resolved BEFORE admission, carried so a
  -- decision can be refused without the reviewer having to look it up.
  do_not_contact      boolean not null default false,
  -- sha256 of the admitted body. The body itself is the task's description.
  body_fingerprint    text not null,
  received_at         timestamptz not null,
  task_id             uuid,
  agent_run_id        uuid,
  created_at          timestamptz not null default now(),
  constraint inbound_messages_source_kind_check check (source_kind in ('synthetic')),
  constraint inbound_messages_external_id_format check (external_message_id ~ '^[\x21-\x7e]{1,200}$'),
  constraint inbound_messages_contact_ref_format check (contact_ref ~ '^[\x21-\x7e]{1,200}$'),
  constraint inbound_messages_fingerprint_format check (body_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint inbound_messages_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint inbound_messages_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint inbound_messages_scope_id_key unique (tenant_id, company_id, id),
  -- The admission identity. Tenant-scoped, so another tenant's identifier
  -- selects nothing here.
  constraint inbound_messages_identity_key unique (tenant_id, source_kind, external_message_id)
);

comment on table ops.inbound_messages is
  'The admission ledger of the synthetic pilot: proof that one inbound message becomes one unit of work. NOT an inbox and NOT a conversation store. It holds no message body — the admitted body is the task description the runtime already bounds.';

create index if not exists inbound_messages_company_idx
  on ops.inbound_messages (tenant_id, company_id, received_at desc);

-- ---------------------------------------------------------------------------
-- 4. The human review queue.
--
--    One advisory result, one decision, terminal once decided. `proposed` is
--    the run's own validated result, copied at the moment the run succeeded so
--    a later raw UPDATE of the run cannot change what a person reviewed.
-- ---------------------------------------------------------------------------

create table if not exists ops.review_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references ops.tenants (id) on delete restrict,
  company_id     uuid not null,
  task_id        uuid not null,
  agent_run_id   uuid not null,
  capability     text not null,
  proposed       jsonb not null,
  -- Carried from the admission, so the decision gate below does not have to
  -- trust a lookup made at decision time.
  do_not_contact boolean not null default false,
  status         text not null default 'pending',
  decision_note  text,
  reviewer       text,
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz,
  updated_at     timestamptz not null default now(),
  constraint review_items_status_check check (status in ('pending', 'accepted', 'rejected', 'needs_edit')),
  constraint review_items_capability_format check (
    capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(capability) <= 100),
  constraint review_items_reviewer_format check (reviewer is null or reviewer ~ '^[\x21-\x7e][\x20-\x7e]{0,199}$'),
  constraint review_items_note_length check (decision_note is null or char_length(decision_note) <= 1000),
  -- A decided item names who decided it and when; a pending one names neither.
  constraint review_items_decided_iff_reviewed check (
    (status <> 'pending') = (reviewed_at is not null and reviewer is not null)),
  -- One review per run: a run succeeds once, so a second row would be a second
  -- decision about the same advice.
  constraint review_items_run_key unique (agent_run_id),
  constraint review_items_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint review_items_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint review_items_scope_id_key unique (tenant_id, company_id, id)
);

comment on table ops.review_items is
  'One advisory agent-run result awaiting a person. Created only by ops.open_review_item, from a run that SUCCEEDED; decided only by ops.record_review_decision; terminal once decided. Nothing in Phase 2A acts on an accepted item — acceptance records approval and no more.';

create index if not exists review_items_pending_idx
  on ops.review_items (tenant_id, company_id, created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 5. Guards. Every guard function is SECURITY INVOKER: a trigger runs as the
--    user whose statement fired it, so none of them confers anything.
-- ---------------------------------------------------------------------------

-- The ledger is an admission record, not a workspace: only the two links the
-- admission itself fills in may ever change, and only from NULL.
create or replace function ops.guard_inbound_message_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.source_kind is distinct from old.source_kind
     or new.external_message_id is distinct from old.external_message_id
     or new.contact_ref is distinct from old.contact_ref
     or new.do_not_contact is distinct from old.do_not_contact
     or new.body_fingerprint is distinct from old.body_fingerprint
     or new.received_at is distinct from old.received_at
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: an admission record is immutable apart from the work it links to';
  end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: the admitted task is set once';
  end if;
  if old.agent_run_id is not null and new.agent_run_id is distinct from old.agent_run_id then
    raise exception using
      errcode = 'OS403',
      message = 'ops.inbound_messages: the admitted agent run is set once';
  end if;
  return new;
end
$function$;

drop trigger if exists inbound_messages_guard_update on ops.inbound_messages;
create trigger inbound_messages_guard_update
  before update on ops.inbound_messages
  for each row execute function ops.guard_inbound_message_update();
alter table ops.inbound_messages enable always trigger inbound_messages_guard_update;

-- A review decision is terminal. The status may leave 'pending' exactly once,
-- and what was reviewed never changes.
create or replace function ops.guard_review_item_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.task_id is distinct from old.task_id
     or new.agent_run_id is distinct from old.agent_run_id
     or new.capability is distinct from old.capability
     or new.proposed is distinct from old.proposed
     or new.do_not_contact is distinct from old.do_not_contact
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS403',
      message = 'ops.review_items: what was reviewed is immutable';
  end if;
  if old.status <> 'pending' then
    raise exception using
      errcode = 'OS409',
      message = format('ops.review_items: this item is already %s, and a decision is final', old.status);
  end if;
  if new.status = 'pending' then
    raise exception using
      errcode = 'OS403',
      message = 'ops.review_items: a decision is a decision; it cannot answer pending';
  end if;
  new.updated_at := now();
  return new;
end
$function$;

drop trigger if exists review_items_guard_update on ops.review_items;
create trigger review_items_guard_update
  before update on ops.review_items
  for each row execute function ops.guard_review_item_update();
alter table ops.review_items enable always trigger review_items_guard_update;

-- NOT a delete guard, deliberately. Both tables are an audit trail, and both
-- are protected the way ops.events and ops.tasks are: no application role holds
-- any privilege on them (section 9), so nothing the product runs can delete a
-- row. The database owner can, as it can delete an event or a task; the owner
-- is outside this boundary by design (ADR 0015), and inventing a refusal only
-- here would protect the pilot's rows more strictly than the events the whole
-- Company OS is audited by, while still not protecting them from the owner.

-- ---------------------------------------------------------------------------
-- 6. Ingress. The one service that admits an inbound message.
--
--    It creates WORK. It never calls a model: the only path to a provider is
--    the agent run it requests, which becomes a job the runtime leases, and
--    every gate of Phase 1D/1D.1 sits on that path.
--
--    TENANCY. `p_tenant_id` and `p_company_id` are the scope the CALLER is
--    already authorised for. Nothing about them is read from the message: a
--    payload that names another tenant selects nothing, because it is never
--    looked at. The idempotency keys are tenant-scoped for the same reason.
--
--    IDEMPOTENCY, three deep and all on the same identity:
--      the ledger's unique (tenant, source_kind, external_message_id),
--      ops.create_task's tenant-scoped key,
--      ops.request_agent_run's tenant-scoped key.
--    Two concurrent deliveries of the same message therefore converge: whoever
--    loses the ledger insert still calls the same two idempotent services with
--    the same keys and resolves to the same task and the same run.
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
  p_do_not_contact      boolean default false,
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
  -- typed refusal here rather than a CHECK violation two calls later.
  if p_body is null or btrim(p_body) = '' or char_length(p_body) > 4000 then
    raise exception using
      errcode = 'OS400',
      message = 'ops.admit_inbound_message: the message body is empty or longer than 4000 characters';
  end if;
  if p_received_at is null or p_received_at > now() + interval '1 minute' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.admit_inbound_message: received_at is missing or in the future';
  end if;

  -- The company is resolved INSIDE the caller's tenant, and before anything is
  -- written: a company of another tenant is not found here, rather than being a
  -- foreign key violation from the ledger insert two statements later.
  perform 1 from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using
      errcode = 'OS404',
      message = 'ops.admit_inbound_message: company not found in this tenant';
  end if;

  -- The semantic identity of the payload: the same key with a different message
  -- is a conflict, not a redelivery.
  v_fingerprint := encode(sha256(convert_to(concat_ws('|',
    'inbound.v1', p_source_kind, p_contact_ref, p_body), 'UTF8')), 'hex');
  v_key := format('inbound:%s:%s', p_source_kind, p_external_message_id);

  insert into ops.inbound_messages (
    tenant_id, company_id, source_kind, external_message_id,
    contact_ref, do_not_contact, body_fingerprint, received_at)
  values (
    p_tenant_id, p_company_id, p_source_kind, p_external_message_id,
    p_contact_ref, coalesce(p_do_not_contact, false), v_fingerprint, p_received_at)
  on conflict (tenant_id, source_kind, external_message_id) do nothing
  returning id into v_id;

  if v_id is null then
    select m.* into v_existing
      from ops.inbound_messages m
     where m.tenant_id = p_tenant_id
       and m.source_kind = p_source_kind
       and m.external_message_id = p_external_message_id
       for update;
    if not found then
      -- The concurrent admission rolled back, leaving nothing to converge on.
      raise exception using
        errcode = 'OS429',
        message = 'ops.admit_inbound_message: a concurrent admission of this message did not complete; retry';
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
    v_id := v_existing.id;
  end if;

  -- The task carries the body, because the runtime's prompt context is built
  -- from the task (ops.claim_agent_run). Title is derived, never the body: it
  -- appears in operator listings, and a lead's own words do not belong in a
  -- list view.
  v_title := format('Lead triage: %s', p_contact_ref);
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

  -- Two facts, both idempotent on the admission identity, so a replay records
  -- neither a second time. Payloads carry identifiers and shape only: never the
  -- body, never the contact's own words.
  perform ops.record_event(
    p_tenant_id, p_company_id, 'communication.received', p_source, 'task', v_task,
    jsonb_build_object(
      'inbound_message_id', v_id,
      'source_kind', p_source_kind,
      'body_fingerprint', v_fingerprint,
      'do_not_contact', coalesce(p_do_not_contact, false)),
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
  'Admits one synthetic inbound message: one ledger row, one lead_triage task, one requested agent run, all on the same tenant-scoped identity, so a redelivery converges and a reused id with a different body is refused. Creates work only; it never calls a model.';

-- ---------------------------------------------------------------------------
-- 7. The review item, DERIVED from a run that succeeded.
--
--    Not written by the worker, and not by the ingress: the same statement that
--    settles a lead_triage run as `succeeded` opens its review. That is what
--    makes "a review item exists only for a valid result" true by construction,
--    and it inherits the run's at-most-once settlement for free — a run
--    succeeds once, and ops.review_items.agent_run_id is unique.
-- ---------------------------------------------------------------------------

create or replace function ops.open_review_item()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_inbound ops.inbound_messages;
  v_review  uuid;
begin
  if new.capability <> 'lead_triage' or new.status <> 'succeeded' or old.status = 'succeeded' then
    return null;
  end if;

  select m.* into v_inbound
    from ops.inbound_messages m
   where m.tenant_id = new.tenant_id and m.agent_run_id = new.id;

  insert into ops.review_items (
    tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact)
  values (
    new.tenant_id, new.company_id, new.task_id, new.id, new.capability, new.result,
    coalesce(v_inbound.do_not_contact, false))
  on conflict (agent_run_id) do nothing
  returning id into v_review;

  if v_review is null then
    return null; -- already opened: a run is reviewed once
  end if;

  perform ops.record_event(
    new.tenant_id, new.company_id, 'lead_triage.review_pending', 'agent-runtime', 'task', new.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', new.id),
    new.correlation_id, null, format('review:%s:pending', new.id));

  return null;
end
$function$;

drop trigger if exists agent_runs_open_review on ops.agent_runs;
create trigger agent_runs_open_review
  after update of status on ops.agent_runs
  for each row execute function ops.open_review_item();
alter table ops.agent_runs enable always trigger agent_runs_open_review;

-- ---------------------------------------------------------------------------
-- 8. The decision. The one way a review leaves 'pending'.
--
--    CONSENT. An `accepted` decision is the only one that could ever authorise
--    a reply, so it is the one refused when the admission recorded
--    do_not_contact. Phase 2A sends nothing, so this refusal proves the policy
--    boundary rather than a transport: the loophole is closed BEFORE the
--    transport exists, which is the only order in which it can be closed
--    honestly.
-- ---------------------------------------------------------------------------

create or replace function ops.record_review_decision(
  p_tenant_id  uuid,
  p_review_id  uuid,
  p_decision   text,
  p_reviewer   text,
  p_source     text,
  p_note       text default null
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_item ops.review_items;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.record_review_decision: no tenant scope';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'rejected', 'needs_edit') then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_review_decision: a decision is accepted, rejected or needs_edit';
  end if;
  if p_reviewer is null or p_reviewer !~ '^[\x21-\x7e][\x20-\x7e]{0,199}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_review_decision: a decision names the person who made it';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_review_decision: the source is missing or malformed';
  end if;
  if p_note is not null and char_length(p_note) > 1000 then
    raise exception using errcode = 'OS400', message = 'ops.record_review_decision: the note is longer than 1000 characters';
  end if;

  select r.* into v_item
    from ops.review_items r
   where r.id = p_review_id and r.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.record_review_decision: review item not found in this tenant';
  end if;

  if v_item.status <> 'pending' then
    if v_item.status = p_decision and v_item.reviewer = p_reviewer then
      -- The same person recording the same decision again: the retry of a
      -- delivery, not a second decision.
      return jsonb_build_object('review_item_id', v_item.id, 'status', v_item.status, 'recorded', false);
    end if;
    raise exception using
      errcode = 'OS409',
      message = format('ops.record_review_decision: this item is already %s, and a decision is final', v_item.status);
  end if;

  if p_decision = 'accepted' and v_item.do_not_contact then
    raise exception using
      errcode = 'OS403',
      message = 'ops.record_review_decision: this lead must not be contacted, so its draft cannot be accepted';
  end if;

  update ops.review_items
     set status = p_decision, reviewer = p_reviewer, decision_note = p_note, reviewed_at = now()
   where id = v_item.id;

  perform ops.record_event(
    p_tenant_id, v_item.company_id, 'lead_triage.reviewed', p_source, 'task', v_item.task_id,
    jsonb_build_object(
      'review_item_id', v_item.id,
      'agent_run_id', v_item.agent_run_id,
      'decision', p_decision),
    null, null, format('review:%s:%s', v_item.id, p_decision));

  return jsonb_build_object('review_item_id', v_item.id, 'status', p_decision, 'recorded', true);
end
$function$;

comment on function ops.record_review_decision(uuid, uuid, text, text, text, text) is
  'Records a person''s decision about one advisory result. Pending to accepted, rejected or needs_edit, once; recording the same decision again is a no-op, and any other change is refused. Accepting is refused when the admission recorded do_not_contact. Recording a decision performs no downstream action: Phase 2A sends nothing and writes nothing to the CRM.';

-- ---------------------------------------------------------------------------
-- 9. Access. The Phase 1C posture, unchanged: backend only.
-- ---------------------------------------------------------------------------

alter table ops.inbound_messages enable row level security;
alter table ops.inbound_messages force  row level security;
alter table ops.review_items     enable row level security;
alter table ops.review_items     force  row level security;

-- No policy, and no grant: the worker has no reason to read either table, and
-- the operator reads them as the database owner. A policy without a grant would
-- only look like access control that is doing something.
revoke all on table ops.inbound_messages, ops.review_items
  from public, anon, authenticated, service_role, ops_worker;

revoke all on function ops.guard_inbound_message_update() from public;
revoke all on function ops.guard_review_item_update() from public;
revoke all on function ops.open_review_item() from public;
revoke all on function ops.admit_inbound_message(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz)
  from public, anon, authenticated, service_role, ops_worker;
revoke all on function ops.record_review_decision(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role, ops_worker;

-- ---------------------------------------------------------------------------
-- 10. Assert the end state.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
  c_tables constant text[] := array['inbound_messages', 'review_items'];
  c_always constant text[] := array[
    'inbound_messages_guard_update', 'review_items_guard_update',
    'agent_runs_open_review'];
begin
  -- 1. Both capabilities exist and route to a policy the router knows.
  if not exists (select 1 from ops.agent_run_capabilities() c
                  where c.capability = 'lead_triage' and c.model_route = 'standard') then
    raise exception 'lead_triage is not a capability';
  end if;
  if not exists (select 1 from ops.agent_run_capabilities() c where c.capability = 'task_assessment') then
    raise exception 'task_assessment stopped being a capability';
  end if;
  select string_agg(c.capability, ', ') into v_bad
    from ops.agent_run_capabilities() c
   where not exists (select 1 from ops.agent_run_route_policies() p where p.model_route = c.model_route);
  if v_bad is not null then
    raise exception 'capabilities routed to an unknown model route: %', v_bad;
  end if;

  -- 2. The output contract answers for both capabilities, and refuses the
  --    other's shape: a validator that accepted anything would make
  --    ops.complete_agent_run's check vacuous.
  if not ops.agent_run_result_valid('task_assessment',
        '{"outcome":"completed","summary":"ok","proposed_next_steps":[]}'::jsonb) then
    raise exception 'the task_assessment contract rejects its own valid shape';
  end if;
  if not ops.agent_run_result_valid('lead_triage', jsonb_build_object(
        'outcome', 'triaged', 'summary', 'ok', 'intent', 'information', 'priority', 'normal',
        'recommended_next_action', 'reply', 'response_draft', 'hello',
        'needs_human_review', true, 'flags', '[]'::jsonb)) then
    raise exception 'the lead_triage contract rejects its own valid shape';
  end if;
  if ops.agent_run_result_valid('lead_triage',
        '{"outcome":"completed","summary":"ok","proposed_next_steps":[]}'::jsonb) then
    raise exception 'the lead_triage contract accepts a task_assessment result';
  end if;
  if ops.agent_run_result_valid('task_assessment', jsonb_build_object(
        'outcome', 'triaged', 'summary', 'ok', 'intent', 'information', 'priority', 'normal',
        'recommended_next_action', 'reply', 'response_draft', 'hello',
        'needs_human_review', true, 'flags', '[]'::jsonb)) then
    raise exception 'the task_assessment contract accepts a lead_triage result';
  end if;
  if ops.agent_run_result_valid('lead_triage', null) then
    raise exception 'the lead_triage contract accepts a missing result';
  end if;

  -- 3. Row level security on both new tables, forced.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'ops tables without forced row level security: %', v_bad;
  end if;

  -- 4. No application role holds anything on either table.
  select string_agg(format('%s on %s to %s', p.privilege_type, p.table_name, p.grantee), ', ')
    into v_bad
    from information_schema.table_privileges p
   where p.table_schema = 'ops' and p.table_name = any (c_tables)
     and p.grantee in ('public', 'anon', 'authenticated', 'service_role', 'ops_worker');
  if v_bad is not null then
    raise exception 'the pilot tables are reachable: %', v_bad;
  end if;

  -- 5. Every guard is ENABLE ALWAYS, so a replica or a session that disabled
  --    ordinary triggers cannot write past it.
  select string_agg(t.tgname, ', ') into v_bad
    from pg_trigger t
   where t.tgname = any (c_always) and t.tgenabled <> 'A';
  if v_bad is not null then
    raise exception 'pilot guards not ENABLE ALWAYS: %', v_bad;
  end if;
  select string_agg(n, ', ') into v_bad
    from unnest(c_always) as n
   where not exists (select 1 from pg_trigger t where t.tgname = n);
  if v_bad is not null then
    raise exception 'pilot guards missing: %', v_bad;
  end if;

  -- 6. The ingress creates no execution of its own: the only job kind a task
  --    may request is still the agent run's.
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'the task to job allowlist changed: %', ops.task_executable_kinds();
  end if;

  -- 7. Neither new function is a definer, so neither confers anything.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('admit_inbound_message', 'record_review_decision', 'open_review_item')
     and p.prosecdef;
  if v_bad is not null then
    raise exception 'pilot functions are SECURITY DEFINER: %', v_bad;
  end if;
end
$$;
