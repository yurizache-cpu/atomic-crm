-- BASELINE Q8, owner decisions D6 and D7 (ADR 0020 §H): AI working content is
-- kept at most 30 days after the review that completes its flow, then redacted
-- in place; an owner may erase it earlier. Content goes; the content-free audit
-- history stays.
--
-- WHAT IS CONTENT (ADR 0020 §A and §D9, traced from the lead-triage input to
-- the decision): the task's description (the admitted body), the run's result
-- (the model's advice and reply draft), the review's copy of that result and
-- the reviewer's free-text note. The UNKEYED digests of that content are nulled
-- with it: the task's request fingerprint (sha256 over its description), the
-- run's input fingerprint (sha256 over the minimised prompt input) and the
-- admission's body fingerprint (sha256 over the body). Nothing is re-keyed.
--
-- WHAT STAYS: every id, class, status, decision, reviewer, timestamp, cost,
-- usage count, refusal code, provider and model fact, authorization reference,
-- idempotency key, event and act log. The contact reference and every WhatsApp
-- identifier are ADR 0018's to decide, not this batch's.
--
-- SCOPE. Only `health` and `person_text` tasks (D6). The clock starts when a
-- review of the task is DECIDED, at the database's own `reviewed_at`; a later
-- decided review of the same task moves it forward, never back. Every
-- authorized person-content capability (`lead_triage`, the only one) reaches a
-- review; a flow that never has a decided review (its run failed, was refused
-- or is indeterminate) has no clock, and explicit erasure covers it. The days
-- are the relied-on authorization's `content_retention_days` (1 to 30), or 30
-- where no authorization applied (the in-process provider); never more.
--
-- MECHANISM. One ledger row per protected task (ops.content_retention), never
-- a copy of the content; an INTERNAL job per scheduled flow, available at its
-- due time on the existing queue (the Phase 3A.1 follow-up pattern: no cron,
-- no second queue), whose one capability redacts that flow; a bounded owner
-- sweep for anything left due; and an owner-only erasure of one task's flow.
-- The guards that make these rows immutable admit exactly one more change: a
-- recorded redaction, which removes the named content, sets the row's
-- `content_redacted_at` to the ledger's instant, and changes nothing else.

-- ---------------------------------------------------------------------------
-- 1. The redaction marker on each row that holds content, and the shape a
--    redacted row keeps.
-- ---------------------------------------------------------------------------

alter table ops.tasks            add column if not exists content_redacted_at timestamptz;
alter table ops.agent_runs       add column if not exists content_redacted_at timestamptz;
alter table ops.review_items     add column if not exists content_redacted_at timestamptz;
alter table ops.inbound_messages add column if not exists content_redacted_at timestamptz;

comment on column ops.tasks.content_redacted_at is
  'When this task''s AI working content (description, request fingerprint) was redacted under D6/D7; the instant ops.content_retention records.';
comment on column ops.agent_runs.content_redacted_at is
  'When this run''s result and input fingerprint were redacted under D6/D7. Everything else on the run stays.';
comment on column ops.review_items.content_redacted_at is
  'When this review''s proposed copy and note were redacted under D6/D7. The decision, reviewer and instants stay.';
comment on column ops.inbound_messages.content_redacted_at is
  'When this admission''s body fingerprint was nulled under D7.';

-- A key without a fingerprint now means exactly one thing: the fingerprint was
-- redacted with the content it was derived from.
alter table ops.tasks drop constraint if exists tasks_request_fingerprint_iff_key;
alter table ops.tasks add constraint tasks_request_fingerprint_iff_key check (
      ((idempotency_key is null) = (request_fingerprint is null)
       or (idempotency_key is not null and request_fingerprint is null and content_redacted_at is not null))
  and (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'));
alter table ops.tasks drop constraint if exists tasks_redacted_content_absent;
alter table ops.tasks add constraint tasks_redacted_content_absent check (
  content_redacted_at is null or (description is null and request_fingerprint is null));

alter table ops.agent_runs drop constraint if exists agent_runs_succeeded_shape;
alter table ops.agent_runs add constraint agent_runs_succeeded_shape check (
  status <> 'succeeded' or (started_at is not null and provider is not null and model is not null
                            and prompt_version is not null
                            and (input_fingerprint is not null or content_redacted_at is not null)));
alter table ops.agent_runs drop constraint if exists agent_runs_result_iff_succeeded;
alter table ops.agent_runs add constraint agent_runs_result_iff_succeeded check (
  (result is not null) = (status = 'succeeded' and content_redacted_at is null));
alter table ops.agent_runs drop constraint if exists agent_runs_redacted_content_absent;
alter table ops.agent_runs add constraint agent_runs_redacted_content_absent check (
  content_redacted_at is null
  or (status in ('succeeded', 'failed', 'indeterminate', 'cancelled')
      and result is null and input_fingerprint is null));

alter table ops.review_items alter column proposed drop not null;
alter table ops.review_items drop constraint if exists review_items_redacted_content;
alter table ops.review_items add constraint review_items_redacted_content check (
      (proposed is null) = (content_redacted_at is not null)
  and (content_redacted_at is null or (decision_note is null and status <> 'pending')));

alter table ops.inbound_messages alter column body_fingerprint drop not null;
alter table ops.inbound_messages drop constraint if exists inbound_messages_redacted_fingerprint;
alter table ops.inbound_messages add constraint inbound_messages_redacted_fingerprint check (
  (body_fingerprint is null) = (content_redacted_at is not null));

-- ---------------------------------------------------------------------------
-- 2. The retention ledger: one row per protected task. What is subject to
--    retention, when it became due, whether and when it was redacted, why and
--    by whom. It never holds content.
-- ---------------------------------------------------------------------------

create table if not exists ops.content_retention (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  company_id            uuid not null,
  task_id               uuid not null,
  -- The task's own class, copied so the row explains itself.
  data_class            text not null,
  -- The latest decided review of the task, and its database decision instant.
  review_item_id        uuid,
  anchored_at           timestamptz,
  retention_days        integer,
  -- The authorization the anchoring review's run relied on, when one applied.
  data_authorization_id uuid,
  due_at                timestamptz,
  -- The one queued job that redacts this flow at due_at (the latest anchor's).
  job_id                uuid,
  redacted_at           timestamptz,
  redaction_reason      text,
  redacted_by           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint content_retention_class_check check (data_class in ('health', 'person_text')),
  constraint content_retention_days_range check (retention_days is null or retention_days between 1 and 30),
  -- Days of 24 hours: timestamptz + hours does not depend on the session's zone.
  constraint content_retention_anchor_shape check (
        (review_item_id is null) = (anchored_at is null)
    and (anchored_at is null) = (retention_days is null)
    and (anchored_at is null) = (due_at is null)
    and (due_at is null or due_at = anchored_at + retention_days * interval '24 hours')),
  -- A flow with no decided review has no clock; it is only ever erased.
  constraint content_retention_unanchored_is_erasure check (
    anchored_at is not null or redaction_reason = 'erasure'),
  constraint content_retention_redaction_shape check (
        (redacted_at is null) = (redaction_reason is null)
    and (redacted_at is null) = (redacted_by is null)
    and (redaction_reason is null or redaction_reason in ('retention_expired', 'erasure'))
    and (redacted_by is null or redacted_by ~ '^[\x21-\x7e][\x20-\x7e]{0,199}$')),
  constraint content_retention_expiry_after_due check (
    redaction_reason is distinct from 'retention_expired' or redacted_at >= due_at),
  constraint content_retention_task_key unique (tenant_id, task_id),
  constraint content_retention_job_key unique (tenant_id, job_id),
  constraint content_retention_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint content_retention_review_fkey
    foreign key (tenant_id, company_id, review_item_id)
    references ops.review_items (tenant_id, company_id, id) on delete restrict,
  constraint content_retention_authorization_fkey
    foreign key (tenant_id, data_authorization_id)
    references ops.model_data_authorizations (tenant_id, id) on delete restrict,
  constraint content_retention_job_fkey
    foreign key (tenant_id, job_id) references ops.jobs (tenant_id, id) on delete restrict
);

comment on table ops.content_retention is
  'BASELINE Q8 D6/D7: one row per health or person_text task whose AI working content is subject to retention: the decided review that anchors the clock, the days, the due instant, and whether, when, why and by whom the content was redacted. Holds no content.';

create index if not exists content_retention_due_idx
  on ops.content_retention (due_at)
  where redacted_at is null;

-- NOT a delete guard, for the reason ops.review_items and ops.events have none
-- (20260917190000, section 5): no application role holds any privilege here,
-- and the database owner is outside this boundary by design (ADR 0015).

create or replace function ops.guard_content_retention_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_class text;
begin
  select t.data_class into v_class
    from ops.tasks t
   where t.tenant_id = new.tenant_id and t.company_id = new.company_id and t.id = new.task_id;
  if v_class is distinct from new.data_class then
    raise exception using
      errcode = 'OS409',
      message = 'ops.content_retention: the class is the task''s own';
  end if;
  return new;
end
$function$;

create or replace function ops.guard_content_retention_update()
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
     or new.data_class is distinct from old.data_class
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS403',
      message = 'ops.content_retention: the task, its class and the row''s creation are fixed';
  end if;
  if old.redacted_at is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.content_retention: the content is redacted, and a redaction is final';
  end if;
  if new.anchored_at is distinct from old.anchored_at then
    if old.anchored_at is null or new.anchored_at is null or new.anchored_at <= old.anchored_at then
      raise exception using
        errcode = 'OS409',
        message = 'ops.content_retention: the clock only moves to a later decided review';
    end if;
  elsif new.review_item_id is distinct from old.review_item_id
        or new.retention_days is distinct from old.retention_days
        or new.data_authorization_id is distinct from old.data_authorization_id
        or new.due_at is distinct from old.due_at then
    raise exception using
      errcode = 'OS409',
      message = 'ops.content_retention: the anchor''s review, days and due instant change only with the anchor';
  end if;
  new.updated_at := now();
  return new;
end
$function$;

drop trigger if exists content_retention_guard_insert on ops.content_retention;
create trigger content_retention_guard_insert
  before insert on ops.content_retention
  for each row execute function ops.guard_content_retention_insert();
alter table ops.content_retention enable always trigger content_retention_guard_insert;

drop trigger if exists content_retention_guard_update on ops.content_retention;
create trigger content_retention_guard_update
  before update on ops.content_retention
  for each row execute function ops.guard_content_retention_update();
alter table ops.content_retention enable always trigger content_retention_guard_update;

-- ---------------------------------------------------------------------------
-- 3. Vocabulary and the one test every content guard asks first.
-- ---------------------------------------------------------------------------

-- D6: the longest AI working content is kept after its flow completes.
create or replace function ops.content_retention_max_days()
returns integer
language sql
immutable
set search_path to ''
as $function$
  select 30;
$function$;

-- The days an anchor gets: the relied-on authorization's own, or the D6
-- maximum where none applied (the in-process provider); never more.
create or replace function ops.content_retention_days(p_authorization_id uuid)
returns integer
language sql
stable
set search_path to ''
as $function$
  select least(
    coalesce((select a.content_retention_days
                from ops.model_data_authorizations a
               where a.id = p_authorization_id),
             ops.content_retention_max_days()),
    ops.content_retention_max_days());
$function$;

-- Whether this row update is a recorded redaction. Answers false when the
-- marker does not change (the table's own guard then decides as before), true
-- for a valid redaction, and refuses everything else: a marker set twice or
-- cleared, content written instead of removed, any other column changed, or a
-- marker no ledger row of this tenant's task records at that instant.
create or replace function ops.content_redaction_permitted(
  p_old       jsonb,
  p_new       jsonb,
  p_content   text[],
  p_tenant_id uuid,
  p_task_id   uuid
)
returns boolean
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  c_markers constant text[] := array['content_redacted_at', 'updated_at'];
  v_key     text;
  v_at      timestamptz;
begin
  if (p_old -> 'content_redacted_at') is not distinct from (p_new -> 'content_redacted_at') then
    return false;
  end if;
  if coalesce(p_old ->> 'content_redacted_at', '') <> '' then
    raise exception using
      errcode = 'OS403',
      message = 'content redaction: a redaction is final';
  end if;
  v_at := (p_new ->> 'content_redacted_at')::timestamptz;
  if v_at is null then
    raise exception using errcode = 'OS403', message = 'content redaction: a redaction is final';
  end if;
  foreach v_key in array p_content loop
    if coalesce(p_new -> v_key, 'null'::jsonb) <> 'null'::jsonb then
      raise exception using
        errcode = 'OS403',
        message = 'content redaction: a redaction only removes content';
    end if;
  end loop;
  if (p_old - p_content - c_markers) is distinct from (p_new - p_content - c_markers) then
    raise exception using
      errcode = 'OS403',
      message = 'content redaction: a redaction removes content and changes nothing else';
  end if;
  if row_security_active('ops.content_retention') then
    raise exception using
      errcode = 'OS403',
      message = 'content redaction: row security would hide the retention ledger from this caller';
  end if;
  perform 1
     from ops.content_retention r
    where r.tenant_id = p_tenant_id and r.task_id = p_task_id and r.redacted_at = v_at;
  if not found then
    raise exception using
      errcode = 'OS403',
      message = 'content redaction: no recorded redaction of this flow at that instant';
  end if;
  return true;
end
$function$;

-- A flow is in progress while a run of its task may still write a result or a
-- review of it is still undecided; its content is never redacted then.
create or replace function ops.content_flow_in_progress(p_tenant_id uuid, p_task_id uuid)
returns boolean
language sql
stable
set search_path to ''
as $function$
  select exists (select 1 from ops.agent_runs r
                  where r.tenant_id = p_tenant_id and r.task_id = p_task_id
                    and r.status in ('pending', 'running'))
      or exists (select 1 from ops.review_items v
                  where v.tenant_id = p_tenant_id and v.task_id = p_task_id
                    and v.status = 'pending');
$function$;

-- ---------------------------------------------------------------------------
-- 4. The immutability guards admit a recorded redaction, and nothing else new.
--    Each body is the one in force (20260912200000, 20260917120000,
--    20261001120000, 20260917190000, 20260918150000) with one branch first.
-- ---------------------------------------------------------------------------

create or replace function ops.guard_task_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_agent_status text;
begin
  -- D7 (this migration): a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['description', 'request_fingerprint'], old.tenant_id, old.id) then
    return new;
  end if;
  if old.status in ('completed', 'failed', 'cancelled') then
    raise exception using
      errcode = 'OS409',
      message = format('ops.tasks: task %s is %s, and a closed task is immutable', old.id, old.status);
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.department_id is distinct from old.department_id
     or new.parent_task_id is distinct from old.parent_task_id
     or new.type is distinct from old.type
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS409',
      message = 'ops.tasks: id, tenant, company, department, parent, type and created_at are fixed at creation';
  end if;

  if new.status is distinct from old.status
     and not ops.task_transition_allowed(old.status, new.status) then
    raise exception using
      errcode = 'OS409',
      message = format('ops.tasks: %s -> %s is not a task transition', old.status, new.status);
  end if;

  if new.assigned_agent_id is distinct from old.assigned_agent_id and new.assigned_agent_id is not null then
    -- FOR SHARE: a concurrent deactivation of the agent waits for this
    -- assignment, instead of both committing.
    select a.status into v_agent_status
      from ops.agents a
     where a.id = new.assigned_agent_id
       and a.tenant_id = new.tenant_id
       and a.company_id = new.company_id
       for share;
    if not found then
      raise exception using
        errcode = 'OS404',
        message = 'ops.tasks: agent not found in this company';
    end if;
    if v_agent_status <> 'active' then
      raise exception using
        errcode = 'OS409',
        message = 'ops.tasks: a task can only be assigned to an active agent';
    end if;
  end if;

  -- Derived, never taken from the caller.
  new.completed_at := case when new.status in ('completed', 'failed', 'cancelled') then now() else null end;
  new.updated_at := now();
  return new;
end
$function$;


create or replace function ops.guard_task_request_identity()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- D7 (this migration): a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['description', 'request_fingerprint'], old.tenant_id, old.id) then
    return new;
  end if;
  if new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint then
    raise exception using
      errcode = 'OS409',
      message = 'ops.tasks: the idempotency key and request fingerprint are fixed at creation';
  end if;
  return new;
end
$function$;


create or replace function ops.guard_agent_run_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_estimate bigint;
begin
  -- D7 (this migration): a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['result', 'input_fingerprint'], old.tenant_id, old.task_id) then
    return new;
  end if;
  if old.status in ('succeeded', 'failed', 'indeterminate', 'cancelled') then
    raise exception using
      errcode = 'OS409',
      message = format('ops.agent_runs: run %s is %s, and a finished run is immutable', old.id, old.status);
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.department_id is distinct from old.department_id
     or new.task_id is distinct from old.task_id
     or new.agent_id is distinct from old.agent_id
     or new.retry_of_run_id is distinct from old.retry_of_run_id
     or new.capability is distinct from old.capability
     or new.model_route is distinct from old.model_route
     or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint
     or new.correlation_id is distinct from old.correlation_id
     or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at
     or new.data_class is distinct from old.data_class
     or new.pinned_provider is distinct from old.pinned_provider then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: tenant, company, department, task, agent, capability, route, key, fingerprint, correlation, lineage, data class and pinned provider are fixed at creation';
  end if;

  if new.job_id is distinct from old.job_id
     and (old.job_id is not null or old.status <> 'pending' or new.status <> 'pending') then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: a run is linked to its job once, while it is pending';
  end if;

  if new.status is not distinct from old.status then
    if new.started_at is distinct from old.started_at
       or new.completed_at is distinct from old.completed_at
       or new.job_attempt is distinct from old.job_attempt
       or new.prompt_version is distinct from old.prompt_version
       or new.input_fingerprint is distinct from old.input_fingerprint
       or new.provider is distinct from old.provider
       or new.model is distinct from old.model
       or new.response_model is distinct from old.response_model
       or new.provider_request_id is distinct from old.provider_request_id
       or new.provider_response_id is distinct from old.provider_response_id
       or new.finish_reason is distinct from old.finish_reason
       or new.input_tokens is distinct from old.input_tokens
       or new.output_tokens is distinct from old.output_tokens
       or new.total_tokens is distinct from old.total_tokens
       or new.cached_input_tokens is distinct from old.cached_input_tokens
       or new.reasoning_tokens is distinct from old.reasoning_tokens
       or new.latency_ms is distinct from old.latency_ms
       or new.result is distinct from old.result
       or new.error_category is distinct from old.error_category
       or new.error_code is distinct from old.error_code
       or new.stop_id is distinct from old.stop_id
       or new.price_id is distinct from old.price_id
       or new.reserved_cost_micros is distinct from old.reserved_cost_micros
       or new.estimated_cost_micros is distinct from old.estimated_cost_micros
       or new.charged_cost_micros is distinct from old.charged_cost_micros
       or new.spend_limit_id is distinct from old.spend_limit_id
       or new.data_authorization_id is distinct from old.data_authorization_id then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: an execution fact changes only through a status transition';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if not ops.agent_run_transition_allowed(old.status, new.status) then
    raise exception using
      errcode = 'OS409',
      message = format('ops.agent_runs: %s -> %s is not an agent run transition', old.status, new.status);
  end if;

  if old.status = 'pending' and new.status <> 'running' then
    -- Refused or failed before any call: no fact of a call, and no cost, may appear.
    if new.job_attempt is not null or new.prompt_version is not null or new.input_fingerprint is not null
       or new.provider is not null or new.model is not null or new.response_model is not null
       or new.provider_request_id is not null or new.provider_response_id is not null
       or new.finish_reason is not null or new.input_tokens is not null or new.output_tokens is not null
       or new.total_tokens is not null or new.cached_input_tokens is not null or new.reasoning_tokens is not null
       or new.latency_ms is not null or new.result is not null
       or new.price_id is not null or new.reserved_cost_micros is not null
       or new.estimated_cost_micros is not null or new.charged_cost_micros is not null
       or new.data_authorization_id is not null then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run that never started carries no fact of a model call and no cost';
    end if;
  end if;

  if old.status = 'pending' and new.status = 'running' then
    -- ops.start_agent_run derives both (the current price version, and the one
    -- reservation ops.agent_run_reservation_for computes). On every write path the
    -- guard requires them, requires the version to be one of this run's own provider
    -- and model, and fixes them from here on. An owner's raw UPDATE that states other
    -- values is, like every owner act, outside the boundary (SI-22, SI-23). The charge
    -- begins at the reservation.
    if new.price_id is null or new.reserved_cost_micros is null or new.reserved_cost_micros < 0
       or not exists (
         select 1 from ops.model_prices p
          where p.id = new.price_id and p.provider = new.provider and p.model = new.model) then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run starts only with a reservation and the price version of its own provider and model';
    end if;
    -- A run pinned to the in-process provider starts only on it.
    if new.pinned_provider is not null and new.provider is distinct from new.pinned_provider then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run pinned to the in-process provider starts only on it';
    end if;
    -- BASELINE Q8 (SI-70): exempt data starts with no authorization; any other
    -- data only with the version in force for its exact binding.
    if ops.model_data_class_exempt(new.data_class, new.provider) then
      if new.data_authorization_id is not null then
        raise exception using
          errcode = 'OS409',
          message = 'ops.agent_runs: synthetic, test or in-process data relies on no data authorization';
      end if;
    elsif new.data_authorization_id is null
       or new.data_authorization_id is distinct from ops.model_data_authorization_in_force(
            new.tenant_id, new.data_class, new.capability, new.provider, new.model) then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run of protected or unclassified data starts only with the data authorization in force for its tenant, class, capability, provider and model';
    end if;
    new.estimated_cost_micros := null;
    new.charged_cost_micros := new.reserved_cost_micros;
  end if;

  if old.status = 'running'
     and (new.job_attempt is distinct from old.job_attempt
          or new.prompt_version is distinct from old.prompt_version
          or new.input_fingerprint is distinct from old.input_fingerprint
          or new.provider is distinct from old.provider
          or new.model is distinct from old.model
          or new.price_id is distinct from old.price_id
          or new.reserved_cost_micros is distinct from old.reserved_cost_micros
          or new.data_authorization_id is distinct from old.data_authorization_id) then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: what was started, and what it reserved, is fixed once the run is running';
  end if;

  if old.status = 'running' then
    -- Derived from usage and the version recorded at start (20260917120000,
    -- section 5, unchanged).
    v_estimate := ops.agent_run_estimated_cost_micros(
      old.price_id, new.input_tokens, new.cached_input_tokens, new.output_tokens,
      new.reasoning_tokens, new.total_tokens);
    new.estimated_cost_micros := v_estimate;
    new.charged_cost_micros := case
      when new.status = 'indeterminate' then greatest(old.reserved_cost_micros, coalesce(v_estimate, 0))
      when v_estimate is not null then v_estimate
      when new.status = 'failed'
           and new.error_category in ('authentication', 'rate_limit', 'invalid_request', 'configuration')
           and new.provider_response_id is null and new.response_model is null
           and new.input_tokens is null and new.output_tokens is null and new.total_tokens is null
           and new.cached_input_tokens is null and new.reasoning_tokens is null
        then 0
      else old.reserved_cost_micros
    end;
    if new.charged_cost_micros > old.charged_cost_micros then
      perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('global', null, null));
      perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('tenant', old.tenant_id, null));
      perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('company', old.tenant_id, old.company_id));
    end if;
  end if;

  if new.status = 'succeeded' and not coalesce(ops.agent_run_result_valid(new.capability, new.result), false) then
    raise exception using
      errcode = 'OS400',
      message = 'ops.agent_runs: a run succeeds only with a result that satisfies its capability''s output contract';
  end if;

  if new.stop_id is not null then
    if new.status <> 'cancelled' or not exists (
      select 1 from ops.execution_stops s
       where s.id = new.stop_id
         and s.cleared_at is null
         and ops.execution_stop_covers(s.scope, s.tenant_id, s.company_id, s.department_id, s.agent_id, s.job_kind,
                                       new.tenant_id, 'agent_run.execute', new.company_id, new.department_id, new.agent_id)
    ) then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run records only an active stop that covers it, and only when that stop cancelled it';
    end if;
  end if;

  if new.spend_limit_id is not null then
    if new.status <> 'cancelled' or not exists (
      select 1 from ops.spend_limits l
       where l.id = new.spend_limit_id
         and l.ended_at is null
         and (   l.scope = 'global'
              or (l.scope = 'tenant'  and l.tenant_id = new.tenant_id)
              or (l.scope = 'company' and l.tenant_id = new.tenant_id and l.company_id = new.company_id))
    ) then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run records only an active limit that applies to it, and only when that limit refused it';
    end if;
  end if;

  new.started_at := case when new.status = 'running' then now() else old.started_at end;
  new.completed_at := case when new.status in ('succeeded', 'failed', 'indeterminate', 'cancelled') then now() end;
  new.updated_at := now();
  return new;
end
$function$;


create or replace function ops.guard_review_item_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- D7 (this migration): a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['proposed', 'decision_note'], old.tenant_id, old.task_id) then
    return new;
  end if;
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


create or replace function ops.guard_inbound_message_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- D7 (this migration): a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['body_fingerprint'], old.tenant_id, old.task_id) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.source_kind is distinct from old.source_kind
     or new.external_message_id is distinct from old.external_message_id
     or new.contact_ref is distinct from old.contact_ref
     or new.do_not_contact is distinct from old.do_not_contact
     or new.body_fingerprint is distinct from old.body_fingerprint
     or new.received_at is distinct from old.received_at
     or new.created_at is distinct from old.created_at
     or new.channel_id is distinct from old.channel_id
     or new.conversation_id is distinct from old.conversation_id
     or new.contact_resolution is distinct from old.contact_resolution
     or new.crm_contact_ref is distinct from old.crm_contact_ref then
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


-- A redacted task is finished work: no new run may be requested about it,
-- since its prompt context is gone and a new result would carry no clock.
create or replace function ops.refuse_run_for_redacted_task()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if exists (select 1 from ops.tasks t
              where t.tenant_id = new.tenant_id and t.id = new.task_id
                and t.content_redacted_at is not null) then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: the task''s content is redacted, so no run may be requested about it';
  end if;
  return new;
end
$function$;

drop trigger if exists agent_runs_refuse_redacted_task on ops.agent_runs;
create trigger agent_runs_refuse_redacted_task
  before insert on ops.agent_runs
  for each row execute function ops.refuse_run_for_redacted_task();
alter table ops.agent_runs enable always trigger agent_runs_refuse_redacted_task;

-- ---------------------------------------------------------------------------
-- 5. The clock: when a review of a protected task is decided.
-- ---------------------------------------------------------------------------

-- The internal kind that redacts a flow at its due time. Maintenance: the kill
-- switch never holds it (ops.job_covering_stop), because erasure obligations
-- do not pause with execution.
create or replace function ops.internal_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['postmark.ledger_retention', 'content.retention_due']::text[];
$function$;

-- Anchors (or moves forward) the task's clock at this decided review, and
-- queues the one job that redacts the flow at its due time. A synthetic,
-- test, operational or unclassified task has no D6 clock.
create or replace function ops.schedule_content_retention(p_review_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_review ops.review_items;
  v_task   ops.tasks;
  v_auth   uuid;
  v_days   integer;
  v_due    timestamptz;
  v_row    ops.content_retention;
  v_id     uuid;
  v_job    uuid;
begin
  select v.* into v_review from ops.review_items v where v.id = p_review_id;
  if not found or v_review.status = 'pending' or v_review.reviewed_at is null then
    return null;
  end if;
  select t.* into v_task
    from ops.tasks t
   where t.tenant_id = v_review.tenant_id and t.id = v_review.task_id;
  if v_task.data_class is null or v_task.data_class not in ('health', 'person_text') then
    return null;
  end if;

  select r.data_authorization_id into v_auth
    from ops.agent_runs r
   where r.tenant_id = v_review.tenant_id and r.id = v_review.agent_run_id;
  v_days := ops.content_retention_days(v_auth);
  v_due := v_review.reviewed_at + v_days * interval '24 hours';

  insert into ops.content_retention (
    tenant_id, company_id, task_id, data_class, review_item_id, anchored_at,
    retention_days, data_authorization_id, due_at)
  values (
    v_review.tenant_id, v_review.company_id, v_review.task_id, v_task.data_class, v_review.id,
    v_review.reviewed_at, v_days, v_auth, v_due)
  on conflict (tenant_id, task_id) do nothing
  returning id into v_id;

  if v_id is null then
    select r.* into v_row
      from ops.content_retention r
     where r.tenant_id = v_review.tenant_id and r.task_id = v_review.task_id
       for update;
    if v_row.redacted_at is not null or v_row.anchored_at >= v_review.reviewed_at then
      return v_row.id; -- already redacted, or anchored at this or a later decision
    end if;
    update ops.content_retention
       set review_item_id = v_review.id, anchored_at = v_review.reviewed_at, retention_days = v_days,
           data_authorization_id = v_auth, due_at = v_due
     where id = v_row.id;
    v_id := v_row.id;
  end if;

  -- The payload is a reference; the capability resolves the flow from the
  -- leased job's binding below, never from it. An earlier anchor's job finds
  -- no binding and answers superseded.
  v_job := ops.enqueue_job(v_review.tenant_id, 'content.retention_due',
                           jsonb_build_object('content_retention_id', v_id),
                           100, v_due, 10, 'content.retention_due:' || v_review.id::text);
  update ops.content_retention set job_id = v_job where id = v_id;
  return v_id;
end
$function$;

create or replace function ops.schedule_content_retention_on_decision()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  perform ops.schedule_content_retention(new.id);
  return null;
end
$function$;

drop trigger if exists review_items_schedule_retention on ops.review_items;
create trigger review_items_schedule_retention
  after update of status on ops.review_items
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function ops.schedule_content_retention_on_decision();
alter table ops.review_items enable always trigger review_items_schedule_retention;

-- ---------------------------------------------------------------------------
-- 6. Redaction: the one core, the owner's erasure, the owner's bounded sweep,
--    and the worker's lease-bound capability.
-- ---------------------------------------------------------------------------

-- Redacts one protected task's AI working content in place, in one
-- transaction, and records it in the ledger. Answers redacted,
-- already_redacted, not_due (expiry before its due instant) or in_progress (a
-- run may still write, or a review is undecided). Locks the task first, then
-- its ledger row: every path takes them in that order.
create or replace function ops.redact_task_content(
  p_tenant_id uuid,
  p_task_id   uuid,
  p_reason    text,
  p_actor     text
)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_task ops.tasks;
  v_row  ops.content_retention;
  v_at   timestamptz := clock_timestamp();
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'content redaction: no tenant scope';
  end if;
  if p_reason is null or p_reason not in ('retention_expired', 'erasure') then
    raise exception using errcode = 'OS400', message = 'content redaction: the reason is retention_expired or erasure';
  end if;
  if p_actor is null or p_actor !~ '^[\x21-\x7e][\x20-\x7e]{0,199}$' then
    raise exception using errcode = 'OS400', message = 'content redaction: a redaction names who made it';
  end if;

  select t.* into v_task
    from ops.tasks t
   where t.tenant_id = p_tenant_id and t.id = p_task_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'content redaction: task not found in this tenant';
  end if;
  if v_task.data_class not in ('health', 'person_text') then
    raise exception using
      errcode = 'OS409',
      message = 'content redaction: only health and person_text content is AI working content under D6';
  end if;

  select r.* into v_row
    from ops.content_retention r
   where r.tenant_id = p_tenant_id and r.task_id = p_task_id
     for update;
  if found and v_row.redacted_at is not null then
    return 'already_redacted';
  end if;
  if p_reason = 'retention_expired' and (v_row.id is null or v_row.due_at > v_at) then
    return 'not_due';
  end if;
  if ops.content_flow_in_progress(p_tenant_id, p_task_id) then
    return 'in_progress';
  end if;

  if v_row.id is null then
    insert into ops.content_retention (
      tenant_id, company_id, task_id, data_class, redacted_at, redaction_reason, redacted_by)
    values (p_tenant_id, v_task.company_id, p_task_id, v_task.data_class, v_at, p_reason, p_actor);
  else
    update ops.content_retention
       set redacted_at = v_at, redaction_reason = p_reason, redacted_by = p_actor
     where id = v_row.id;
  end if;

  update ops.tasks
     set description = null, request_fingerprint = null, content_redacted_at = v_at
   where tenant_id = p_tenant_id and id = p_task_id;
  update ops.agent_runs
     set result = null, input_fingerprint = null, content_redacted_at = v_at
   where tenant_id = p_tenant_id and task_id = p_task_id and content_redacted_at is null;
  update ops.review_items
     set proposed = null, decision_note = null, content_redacted_at = v_at
   where tenant_id = p_tenant_id and task_id = p_task_id and content_redacted_at is null;
  update ops.inbound_messages
     set body_fingerprint = null, content_redacted_at = v_at
   where tenant_id = p_tenant_id and task_id = p_task_id and content_redacted_at is null;
  return 'redacted';
end
$function$;

comment on function ops.redact_task_content(uuid, uuid, text, text) is
  'D6/D7: redacts one health or person_text task''s AI working content in place (task description and request fingerprint; every run''s result and input fingerprint; every review''s proposed copy and note; the admission''s body fingerprint) and records when, why and by whom in ops.content_retention. Deletes nothing and changes no other column.';

-- D7: the owner's immediate erasure of one task's flow, in its tenant only.
-- Not granted to anyone; the owner CLI calls it with the owner credential.
create or replace function ops.erase_task_content(p_tenant_id uuid, p_task_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_status text;
begin
  v_status := ops.redact_task_content(p_tenant_id, p_task_id, 'erasure', p_actor);
  if v_status = 'in_progress' then
    raise exception using
      errcode = 'OS409',
      message = 'content erasure: the flow is in progress (a run is pending or running, or a review is undecided); finish or decide it first';
  end if;
  return jsonb_build_object('task_id', p_task_id, 'status', v_status);
end
$function$;

-- The owner's bounded sweep over every tenant's due flows. Tasks another
-- transaction holds are skipped, not waited for, so two sweeps (or a sweep and
-- a worker) never process one flow twice; a repeat finds nothing due.
create or replace function ops.sweep_content_retention(p_limit integer, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_flow        record;
  v_status      text;
  v_redacted    integer := 0;
  v_in_progress integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = 'OS400', message = 'content sweep: the limit is between 1 and 1000';
  end if;
  for v_flow in
    select r.tenant_id, r.task_id
      from ops.content_retention r
      join ops.tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
     where r.redacted_at is null and r.due_at <= clock_timestamp()
     order by r.due_at, r.id
     limit p_limit
       for update of t skip locked
  loop
    v_status := ops.redact_task_content(v_flow.tenant_id, v_flow.task_id, 'retention_expired', p_actor);
    if v_status = 'redacted' then
      v_redacted := v_redacted + 1;
    elsif v_status = 'in_progress' then
      v_in_progress := v_in_progress + 1;
    end if;
  end loop;
  return jsonb_build_object('redacted', v_redacted, 'in_progress', v_in_progress);
end
$function$;

-- The worker's one new capability: redacts the flow bound to the live lease's
-- job. Takes no tenant, task or job argument. Answers redacted,
-- already_redacted, not_due, in_progress, or superseded (a later decided review
-- moved the clock and its own job took the binding).
create or replace function ops.redact_due_content()
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job ops.jobs := ops.leased_job();
  v_row ops.content_retention;
begin
  if v_job.kind <> 'content.retention_due' then
    raise exception using errcode = '42501', message = 'ops.redact_due_content: the leased job is not a retention job';
  end if;
  select r.* into v_row
    from ops.content_retention r
   where r.tenant_id = v_job.tenant_id and r.job_id = v_job.id;
  if not found then
    return 'superseded';
  end if;
  return ops.redact_task_content(v_row.tenant_id, v_row.task_id, 'retention_expired', 'system:content-retention');
end
$function$;

comment on function ops.redact_due_content() is
  'D6: redacts the flow bound to the live lease''s content.retention_due job once it is due; a replay changes nothing. Resolves the flow from the lease; takes no id. Contacts nobody.';

-- ---------------------------------------------------------------------------
-- 7. A redacted review has no draft: its send is blocked, never attempted.
--    The Phase 2B body (20260918150000, section 11) with one check.
-- ---------------------------------------------------------------------------

create or replace function ops.begin_outbound_send(p_tenant_id uuid, p_outbound_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out     ops.outbound_messages;
  v_conv    ops.conversations;
  v_channel ops.communication_channels;
  v_review  ops.review_items;
  v_check   jsonb;
begin
  select * into v_out from ops.outbound_messages
   where id = p_outbound_id and tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.begin_outbound_send: send not found in this tenant';
  end if;
  if v_out.status <> 'authorized' then
    -- Another attempt already began it, or it is settled: never a second call.
    return jsonb_build_object('state', v_out.status);
  end if;

  v_check := ops.whatsapp_send_eligibility(p_tenant_id, v_out.conversation_id);
  -- D7: a review whose content was redacted has no draft left to send.
  if exists (select 1 from ops.review_items v
              where v.tenant_id = p_tenant_id and v.id = v_out.review_item_id
                and v.content_redacted_at is not null) then
    v_check := jsonb_build_object('eligible', false, 'reason', 'content_redacted');
  end if;
  if not (v_check ->> 'eligible')::boolean then
    update ops.outbound_messages
       set status = 'blocked', blocked_reason = v_check ->> 'reason', send_check = v_check
     where id = v_out.id;
    perform ops.record_event(
      p_tenant_id, v_out.company_id, 'communication.outbound_blocked', 'operator-cli', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id, 'reason', v_check ->> 'reason'));
    return jsonb_build_object('state', 'blocked', 'reason', v_check ->> 'reason');
  end if;

  select * into v_conv from ops.conversations where id = v_out.conversation_id;
  select * into v_channel from ops.communication_channels where id = v_out.channel_id;
  select * into v_review from ops.review_items where id = v_out.review_item_id;

  update ops.outbound_messages
     set status = 'sending', sending_at = now(), send_check = v_check
   where id = v_out.id;
  perform ops.record_event(
    p_tenant_id, v_out.company_id, 'communication.outbound_attempted', 'operator-cli', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id));

  return jsonb_build_object(
    'state', 'send',
    'outbound_message_id', v_out.id,
    'provider_target', v_channel.provider_target,
    'to', v_conv.contact_ref,
    'body', v_review.proposed ->> 'response_draft');
end
$function$;


-- ---------------------------------------------------------------------------
-- 8. The flows already decided before this migration get their clock now.
-- ---------------------------------------------------------------------------

do $$
declare
  v_review uuid;
begin
  for v_review in
    select v.id
      from ops.review_items v
      join ops.tasks t on t.tenant_id = v.tenant_id and t.id = v.task_id
     where v.status <> 'pending' and t.data_class in ('health', 'person_text')
     order by v.reviewed_at, v.id
  loop
    perform ops.schedule_content_retention(v_review);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Access: backend only. The worker gets exactly one capability.
-- ---------------------------------------------------------------------------

alter table ops.content_retention enable row level security;
alter table ops.content_retention force  row level security;

revoke all on table ops.content_retention from public, anon, authenticated, service_role, ops_worker;

revoke all on function ops.guard_content_retention_insert() from public;
revoke all on function ops.guard_content_retention_update() from public;
revoke all on function ops.content_retention_max_days() from public;
revoke all on function ops.content_retention_days(uuid) from public;
revoke all on function ops.content_redaction_permitted(jsonb, jsonb, text[], uuid, uuid) from public;
revoke all on function ops.content_flow_in_progress(uuid, uuid) from public;
revoke all on function ops.refuse_run_for_redacted_task() from public;
revoke all on function ops.internal_job_kinds() from public;
revoke all on function ops.schedule_content_retention(uuid) from public;
revoke all on function ops.schedule_content_retention_on_decision() from public;
revoke all on function ops.redact_task_content(uuid, uuid, text, text) from public;
revoke all on function ops.erase_task_content(uuid, uuid, text) from public;
revoke all on function ops.sweep_content_retention(integer, text) from public;
revoke all on function ops.redact_due_content() from public;
revoke all on function ops.guard_task_update() from public;
revoke all on function ops.guard_task_request_identity() from public;
revoke all on function ops.guard_agent_run_update() from public;
revoke all on function ops.guard_review_item_update() from public;
revoke all on function ops.guard_inbound_message_update() from public;
revoke all on function ops.begin_outbound_send(uuid, uuid) from public;

grant execute on function ops.redact_due_content() to ops_worker;

do $$
begin
  if exists (select 1 from pg_class c, aclexplode(c.relacl) a
              where c.oid = 'ops.content_retention'::regclass and a.grantee <> c.relowner) then
    raise exception 'ops.content_retention is granted to a role';
  end if;
  if ops.internal_job_kinds() is distinct from array['postmark.ledger_retention', 'content.retention_due']::text[]
     or ops.internal_job_kinds() && ops.external_job_kinds()
     or ops.internal_job_kinds() && ops.governed_job_kinds() then
    raise exception 'the internal job kinds are not exactly the two maintenance kinds';
  end if;
  if exists (select 1
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops'
                and p.proname in ('content_retention_max_days', 'content_retention_days', 'content_redaction_permitted',
                                  'content_flow_in_progress', 'schedule_content_retention', 'redact_task_content',
                                  'erase_task_content', 'sweep_content_retention', 'redact_due_content')
                and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             where a.privilege_type = 'EXECUTE'
                               and a.grantee <> p.proowner
                               and not (p.proname = 'redact_due_content'
                                        and a.grantee = (select oid from pg_roles where rolname = 'ops_worker')))) then
    raise exception 'a retention function is executable by a role other than its owner (and the worker''s one capability)';
  end if;
  if not (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'ops' and p.proname = 'redact_due_content') then
    raise exception 'ops.redact_due_content must be SECURITY DEFINER';
  end if;
end
$$;
