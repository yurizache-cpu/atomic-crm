-- Phase 1D — the agent runtime: one bounded, auditable model invocation.
--
--   ops.tasks ── ops.agent_runs ── ops.jobs          business anchor -> one run -> scheduling
--                     │
--                     └── ops.execution_stops         the kill switch that can refuse a run
--
-- WHAT AN AGENT RUN IS. One model invocation, for one agent, about one task it is
-- assigned. Not a session, not a loop, not a conversation. It ends in exactly one
-- terminal state, and a retry is a NEW run that names the one it repeats.
--
-- WHAT IT IS NOT (docs/adr/0016-agent-runs-and-model-providers.md):
--   Agent Run != Job     the run is the audited business record; ops.jobs only
--                        schedules the attempt to carry it out.
--   Agent Run != Task    a run never changes its task. Its result is advisory.
--   Model != Agent       ops.agents gains no provider, model or prompt column; the
--                        route a run uses is decided by its capability and resolved
--                        to a provider and model by deployment configuration.
--
-- NO BLIND RETRIES. A provider may bill a request whose answer never reached us, and
-- no provider idempotency key can be relied on. So a run is started ONCE, the start
-- is committed BEFORE the external call, and a run found still `running` by anyone
-- other than the attempt that started it is settled `indeterminate` — never started
-- again. The job that carries a run may be retried; the run it carries may not.
--
-- WHO CAN DO WHAT:
--   * owner only (SECURITY INVOKER, explicit tenant scope, EXECUTE granted to no
--     role): ops.request_agent_run, ops.trip_execution_stop, ops.clear_execution_stop.
--   * ops_worker, through six SECURITY DEFINER capabilities that take NO tenant, run
--     or task argument: each resolves its run from the live lease's job, the same way
--     ops.purge_inbound_email_ledger resolves its tenant (SI-18).
--   * nobody else. No application role holds any privilege on either new table.
--
-- VOCABULARY. Capabilities, routes, statuses and error categories below are engine
-- vocabulary — the same for every tenant (ADR 0013's test) — so they are code. Model
-- ids and prices are NOT: model catalogues change, so no constraint names a model.

-- ---------------------------------------------------------------------------
-- 0. Engine vocabulary.
-- ---------------------------------------------------------------------------

-- The capabilities a run may be asked for, and the deterministic route each uses.
-- Adding one is a reviewed migration, exactly as adding a task-executable kind is.
create or replace function ops.agent_run_capabilities()
returns table (capability text, model_route text)
language sql
immutable
set search_path to ''
as $function$
  select * from (values
    ('task_assessment', 'standard')
  ) as c (capability, model_route);
$function$;

-- The agent run state machine, as a relation. The BEFORE UPDATE trigger on
-- ops.agent_runs is its only enforcement point; engine/domain/agentRunStateMachine.ts
-- mirrors it and a driver-backed test asserts the two are equal.
create or replace function ops.agent_run_status_transitions()
returns table (from_status text, to_status text)
language sql
immutable
set search_path to ''
as $function$
  select * from (values
    ('pending', 'running'),
    ('pending', 'cancelled'),
    ('pending', 'failed'),
    ('running', 'succeeded'),
    ('running', 'failed'),
    ('running', 'indeterminate')
  ) as t (from_status, to_status);
$function$;

create or replace function ops.agent_run_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select exists (
    select 1 from ops.agent_run_status_transitions() t
     where t.from_status = p_from and t.to_status = p_to
  );
$function$;

-- What we KNOW about a run that ended with this category.
--   failed         the outcome is known and unusable: the provider refused the
--                  request, or answered with something that failed its contract.
--   indeterminate  a model call may have happened and we cannot tell: issuing it
--                  again could duplicate work or cost.
--   cancelled      a deterministic gate refused the run before any call.
-- engine/models/errors.ts mirrors the worker-reportable part of this mapping, and a
-- driver-backed test asserts equality. An unknown category is NULL, so a CHECK below
-- refuses it.
create or replace function ops.agent_run_error_status(p_category text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_category in ('configuration', 'authentication', 'rate_limit', 'invalid_request',
                        'provider_5xx', 'invalid_response', 'schema_validation', 'job_failed')
      then 'failed'
    when p_category in ('timeout', 'transport', 'cancelled', 'unknown', 'interrupted')
      then 'indeterminate'
    when p_category = 'refused'
      then 'cancelled'
  end;
$function$;

-- The output contract of each capability, checked by the DATABASE as well as by the
-- worker, so a worker defect cannot store an unvalidated model answer. The rules are
-- the ones engine/models/taskAssessment.ts enforces; the worker's are never looser
-- (a JS string's length counts UTF-16 units, char_length counts code points).
create or replace function ops.agent_run_result_valid(p_capability text, p_result jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_keys text[];
  v_step jsonb;
begin
  if p_capability is distinct from 'task_assessment' then
    return false;
  end if;
  if p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 16384 then
    return false;
  end if;

  select array_agg(k collate "C" order by k collate "C") into v_keys
    from jsonb_object_keys(p_result) as k;
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
end
$function$;

-- The lifecycle namespaces derived from state. `agent_run` joins the five Phase 1C
-- reserved: an agent run fact comes from a state change, never from a caller, so
-- ops.record_event must not be able to forge `agent_run.succeeded`.
create or replace function ops.derived_event_namespaces()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['company', 'department', 'agent', 'task', 'job', 'agent_run']::text[];
$function$;

-- The job kinds a task may request. Exactly one since Phase 1D: the job that carries
-- an agent run. ops.request_task_execution creates that kind only for a pending run
-- of the same task, so the allowlist entry is not a generic door (section 6).
create or replace function ops.task_executable_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['agent_run.execute']::text[];
$function$;

-- The one advisory lock that serialises the kill switch with every check of it.
-- Tripping or clearing a stop takes it exclusively; reading the stops before a run is
-- requested or started takes it shared, in an earlier statement, so the read sees
-- every stop whose trip has returned (READ COMMITTED takes a snapshot per statement).
create or replace function ops.execution_stop_lock_key()
returns bigint
language sql
immutable
set search_path to ''
as $function$
  select hashtextextended('ops.execution_stops', 0);
$function$;

-- Error codes only the database records. A worker may not claim them: a run the
-- database never stopped must not read "execution_stopped".
create or replace function ops.agent_run_reserved_error_codes()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['execution_stopped', 'execution_interrupted', 'database_contract',
               'job_failed', 'job_ended_before_start']::text[];
$function$;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

-- The kill switch (ADR 0010), in the minimal shape the owner chose for Phase 1D:
-- a stop refuses NEW agent runs at a scope; any active stop that covers a run
-- refuses it (deny wins); nothing clears a stop but an owner act that is recorded on
-- the row. A stop is never rewritten, and an active stop is never deleted. A global
-- stop has no tenant at all, like ops.worker_instances.
create table if not exists ops.execution_stops (
  id             uuid primary key default gen_random_uuid(),
  scope          text not null,
  tenant_id      uuid references ops.tenants (id) on delete restrict,
  company_id     uuid,
  department_id  uuid,
  agent_id       uuid,
  reason         text not null,
  tripped_by     text not null,
  tripped_at     timestamptz not null default now(),
  cleared_by     text,
  cleared_reason text,
  cleared_at     timestamptz,
  constraint execution_stops_scope_check check (scope in ('global', 'tenant', 'company', 'department', 'agent')),
  constraint execution_stops_scope_shape check (
       (scope = 'global'     and tenant_id is null     and company_id is null     and department_id is null     and agent_id is null)
    or (scope = 'tenant'     and tenant_id is not null and company_id is null     and department_id is null     and agent_id is null)
    or (scope = 'company'    and tenant_id is not null and company_id is not null and department_id is null     and agent_id is null)
    or (scope = 'department' and tenant_id is not null and company_id is not null and department_id is not null and agent_id is null)
    or (scope = 'agent'      and tenant_id is not null and company_id is not null and department_id is null     and agent_id is not null)),
  constraint execution_stops_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint execution_stops_tripped_by_format check (tripped_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint execution_stops_cleared_whole check (
    (cleared_at is null) = (cleared_by is null) and (cleared_at is null) = (cleared_reason is null)),
  constraint execution_stops_cleared_by_format check (cleared_by is null or cleared_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint execution_stops_cleared_reason_length check (
    cleared_reason is null or char_length(btrim(cleared_reason)) between 1 and 500),
  constraint execution_stops_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint execution_stops_department_fkey
    foreign key (tenant_id, company_id, department_id)
    references ops.departments (tenant_id, company_id, id) on delete restrict,
  constraint execution_stops_agent_fkey
    foreign key (tenant_id, company_id, agent_id)
    references ops.agents (tenant_id, company_id, id) on delete restrict
);

comment on table ops.execution_stops is
  'The agent-run kill switch (ADR 0010, minimal Phase 1D shape). An active stop refuses every new agent run it covers, at request time and again immediately before the provider call. Deny wins. Only an owner clears a stop, recorded on the row; an active stop is never deleted, and free text is never rewritten except by redaction. Do not put personal data in a reason.';

-- One ACTIVE stop per exact target, so tripping twice is idempotent and clearing is
-- unambiguous. NULLS NOT DISTINCT: without it every global stop would be "distinct".
create unique index if not exists execution_stops_active_target_key
  on ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id) nulls not distinct
  where cleared_at is null;

create table if not exists ops.agent_runs (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references ops.tenants (id) on delete restrict,
  company_id           uuid not null,
  -- The AGENT's department, so a department-scoped stop is a plain comparison.
  department_id        uuid not null,
  task_id              uuid not null,
  agent_id             uuid not null,
  -- The job that carries the run. NULL only between the run's insert and its link,
  -- inside ops.request_agent_run, or for a run refused before any job existed.
  job_id               uuid,
  retry_of_run_id      uuid,
  capability           text not null,
  model_route          text not null,
  status               text not null default 'pending',
  -- Caller-chosen, tenant-scoped, and DATA: it deduplicates a request and grants
  -- nothing (ADR 0003, reconciled Decision 4).
  idempotency_key      text not null,
  -- sha256 of the semantic request (task, agent, capability, retry parent), so a
  -- reused key for a different request is refused instead of answered.
  request_fingerprint  text not null,
  -- System lineage: generated by the database, or inherited from the run retried.
  -- Never supplied by a caller and never by a model.
  correlation_id       uuid not null,
  requested_by         text not null,
  -- Facts of the start, committed before the provider call.
  prompt_version       text,
  input_fingerprint    text,
  provider             text,
  model                text,
  job_attempt          integer,
  -- Facts of the outcome.
  response_model       text,
  provider_request_id  text,
  provider_response_id text,
  finish_reason        text,
  input_tokens         integer,
  output_tokens        integer,
  total_tokens         integer,
  cached_input_tokens  integer,
  reasoning_tokens     integer,
  latency_ms           integer,
  result               jsonb,
  error_category       text,
  error_code           text,
  stop_id              uuid references ops.execution_stops (id) on delete restrict,
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz not null default now(),
  constraint agent_runs_status_check check (
    status in ('pending', 'running', 'succeeded', 'failed', 'indeterminate', 'cancelled')),
  constraint agent_runs_capability_format check (
    capability ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(capability) <= 100),
  constraint agent_runs_model_route_format check (model_route ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint agent_runs_idempotency_key_format check (idempotency_key ~ '^[\x21-\x7e]{1,200}$'),
  constraint agent_runs_request_fingerprint_format check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint agent_runs_requested_by_format check (requested_by ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  constraint agent_runs_prompt_version_format check (
    prompt_version is null or prompt_version ~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'),
  constraint agent_runs_input_fingerprint_format check (
    input_fingerprint is null or input_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint agent_runs_provider_format check (provider is null or provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint agent_runs_model_format check (model is null or model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  constraint agent_runs_response_model_format check (
    response_model is null or response_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  constraint agent_runs_provider_request_id_format check (
    provider_request_id is null or provider_request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  constraint agent_runs_provider_response_id_format check (
    provider_response_id is null or provider_response_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  constraint agent_runs_finish_reason_format check (finish_reason is null or finish_reason ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint agent_runs_error_code_format check (error_code is null or error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'),
  constraint agent_runs_tokens_non_negative check (
        coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0 and coalesce(total_tokens, 0) >= 0
    and coalesce(cached_input_tokens, 0) >= 0 and coalesce(reasoning_tokens, 0) >= 0),
  constraint agent_runs_latency_range check (latency_ms is null or latency_ms between 0 and 86400000),
  constraint agent_runs_job_attempt_positive check (job_attempt is null or job_attempt >= 1),
  constraint agent_runs_not_own_retry check (retry_of_run_id is distinct from id),
  -- Status coherence. The facts a state implies are present, and nothing else is.
  constraint agent_runs_completed_at_iff_finished check (
    (status in ('succeeded', 'failed', 'indeterminate', 'cancelled')) = (completed_at is not null)),
  constraint agent_runs_started_at_iff_started check (
    (started_at is not null) = (job_attempt is not null)),
  constraint agent_runs_running_shape check (
    status <> 'running' or (started_at is not null and provider is not null and model is not null
                            and prompt_version is not null and input_fingerprint is not null)),
  constraint agent_runs_succeeded_shape check (
    status <> 'succeeded' or (started_at is not null and provider is not null and model is not null
                              and prompt_version is not null and input_fingerprint is not null)),
  constraint agent_runs_result_iff_succeeded check ((result is not null) = (status = 'succeeded')),
  constraint agent_runs_result_object check (
    result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 16384)),
  constraint agent_runs_error_iff_unsuccessful check (
    (status in ('failed', 'indeterminate', 'cancelled')) = (error_category is not null)),
  constraint agent_runs_category_status_pair check (
       error_category is null
    or (status = 'failed' and error_category in ('configuration', 'authentication', 'rate_limit', 'invalid_request',
                                                 'provider_5xx', 'invalid_response', 'schema_validation', 'job_failed'))
    or (status = 'indeterminate' and error_category in ('timeout', 'transport', 'cancelled', 'unknown', 'interrupted'))
    or (status = 'cancelled' and error_category = 'refused')),
  constraint agent_runs_stop_iff_stopped check ((stop_id is not null) = (error_code is not distinct from 'execution_stopped')),
  -- Keys. Every reference carries tenant and company, as in Phase 1C (SI-22).
  constraint agent_runs_idempotency_key_key unique (tenant_id, idempotency_key),
  constraint agent_runs_job_key unique (tenant_id, job_id),
  constraint agent_runs_task_scope_id_key unique (tenant_id, company_id, task_id, id),
  constraint agent_runs_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint agent_runs_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id) on delete restrict,
  -- Pins the agent to ITS department in the run's company: no cross-company agent,
  -- and department_id cannot disagree with the agent's.
  constraint agent_runs_agent_fkey
    foreign key (tenant_id, company_id, department_id, agent_id)
    references ops.agents (tenant_id, company_id, department_id, id) on delete restrict,
  constraint agent_runs_job_fkey
    foreign key (tenant_id, job_id) references ops.jobs (tenant_id, id) on delete restrict,
  -- A retry repeats a run of the SAME task. NO ACTION rather than RESTRICT, so erasing
  -- a task's whole run history in one statement is not refused row by row.
  constraint agent_runs_retry_fkey
    foreign key (tenant_id, company_id, task_id, retry_of_run_id)
    references ops.agent_runs (tenant_id, company_id, task_id, id)
);

comment on table ops.agent_runs is
  'One bounded model invocation for one agent about one assigned task. NOT ops.jobs, which only schedules the attempt; NOT the task, which it never changes. Started once and committed as running before the provider call; a run found running by anyone else settles indeterminate and is never started again. A retry is a new run that names the one it repeats.';

create index if not exists agent_runs_task_idx
  on ops.agent_runs (tenant_id, company_id, task_id, created_at);
create index if not exists agent_runs_agent_idx
  on ops.agent_runs (tenant_id, company_id, agent_id, created_at);
-- The stale-run sweep reads only unfinished runs.
create index if not exists agent_runs_unfinished_idx
  on ops.agent_runs (status, started_at)
  where status in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- 2. Row level security. ENABLE and FORCE, as on every ops table.
--
-- ops.agent_runs gets the same lease-bound read policy as every Company OS table,
-- with NO grant behind it: the worker reaches runs only through the capabilities in
-- section 7, which return exactly one run's bounded context. ops.execution_stops has
-- no policy at all: a global stop belongs to no tenant, so a tenant policy could only
-- hide the stops that matter most. It is reached only by owner and definer code, and
-- ops.active_execution_stop refuses to read it where row security would filter it.
-- ---------------------------------------------------------------------------

alter table ops.execution_stops enable row level security;
alter table ops.execution_stops force  row level security;
alter table ops.agent_runs      enable row level security;
alter table ops.agent_runs      force  row level security;

drop policy if exists agent_runs_read_leased_tenant on ops.agent_runs;
create policy agent_runs_read_leased_tenant on ops.agent_runs
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

-- ---------------------------------------------------------------------------
-- 3. Guard triggers. SECURITY INVOKER, as in Phase 1C: they confer nothing.
-- ---------------------------------------------------------------------------

create or replace function ops.guard_execution_stop_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.cleared_at is not null or new.cleared_by is not null or new.cleared_reason is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.execution_stops: a stop is born active; clearing it is a separate, recorded act';
  end if;
  -- The database's clock, not the caller's: a stop cannot be backdated.
  new.tripped_at := now();
  return new;
end
$function$;

-- A stop changes in exactly two ways: it is cleared once, with who and why; or its free
-- text is replaced by the redaction marker, so a name typed in an incident can be erased
-- without rewriting what happened.
create or replace function ops.guard_execution_stop_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.id is distinct from old.id
     or new.scope is distinct from old.scope
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.department_id is distinct from old.department_id
     or new.agent_id is distinct from old.agent_id
     or new.tripped_by is distinct from old.tripped_by
     or new.tripped_at is distinct from old.tripped_at then
    raise exception using
      errcode = 'OS409',
      message = 'ops.execution_stops: a stop is never rewritten; it is only cleared, or its free text redacted';
  end if;

  if old.cleared_at is null and new.cleared_by is not null then
    if new.reason is distinct from old.reason then
      raise exception using
        errcode = 'OS409',
        message = 'ops.execution_stops: clearing a stop does not rewrite why it was tripped';
    end if;
    new.cleared_at := now();
    return new;
  end if;

  if new.cleared_by is distinct from old.cleared_by or new.cleared_at is distinct from old.cleared_at then
    raise exception using
      errcode = 'OS409',
      message = format('ops.execution_stops: stop %s is cleared once, with who and why, and a cleared stop is history', old.id);
  end if;
  if new.reason is not distinct from old.reason and new.cleared_reason is not distinct from old.cleared_reason then
    raise exception using
      errcode = 'OS409',
      message = 'ops.execution_stops: the only updates to a stop are its clearing and the redaction of its free text';
  end if;
  if (new.reason is distinct from old.reason and new.reason <> '[redacted]')
     or (new.cleared_reason is distinct from old.cleared_reason and new.cleared_reason is distinct from '[redacted]') then
    raise exception using
      errcode = 'OS409',
      message = 'ops.execution_stops: free text is never rewritten, only replaced by [redacted]';
  end if;
  return new;
end
$function$;

-- An active stop is the switch itself: deleting it would turn the switch off with no
-- record. Clear it first; a cleared stop may be erased.
create or replace function ops.guard_execution_stop_delete()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.cleared_at is null then
    raise exception using
      errcode = 'OS409',
      message = format('ops.execution_stops: stop %s is active; it is cleared, with who and why, before it can be deleted', old.id);
  end if;
  return old;
end
$function$;

create or replace function ops.refuse_execution_stop_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'OS409',
    message = 'ops.execution_stops is never truncated: an active stop is removed only by clearing it';
end
$function$;

-- A run is born pending, with no job and no fact of execution. A retry's parent must
-- ALREADY exist, finished, on the same task: a foreign key is checked at the end of
-- the statement, so one multi-row INSERT could otherwise invent its own lineage.
create or replace function ops.guard_agent_run_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_parent_status text;
begin
  if new.status is distinct from 'pending'
     or new.job_id is not null or new.started_at is not null or new.completed_at is not null
     or new.job_attempt is not null or new.prompt_version is not null or new.input_fingerprint is not null
     or new.provider is not null or new.model is not null or new.response_model is not null
     or new.provider_request_id is not null or new.provider_response_id is not null
     or new.finish_reason is not null or new.input_tokens is not null or new.output_tokens is not null
     or new.total_tokens is not null or new.cached_input_tokens is not null or new.reasoning_tokens is not null
     or new.latency_ms is not null or new.result is not null or new.error_category is not null
     or new.error_code is not null or new.stop_id is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: a run is born pending, with no job and no execution fact; every later fact is reached through a transition';
  end if;

  if new.retry_of_run_id is not null then
    select p.status into v_parent_status
      from ops.agent_runs p
     where p.id = new.retry_of_run_id
       and p.tenant_id = new.tenant_id
       and p.company_id = new.company_id
       and p.task_id = new.task_id;
    if not found then
      raise exception using
        errcode = 'OS404',
        message = 'ops.agent_runs: the run retried was not found on this task';
    end if;
    if v_parent_status not in ('succeeded', 'failed', 'indeterminate', 'cancelled') then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: only a finished run can be retried';
    end if;
  end if;

  new.created_at := now();
  new.updated_at := now();
  return new;
end
$function$;

-- The agent run state machine, for every role but the owner. A finished run refuses
-- ANY update. The request is fixed at creation. Without a transition the only change
-- is the one link to the job; with one, only the facts that transition records.
create or replace function ops.guard_agent_run_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
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
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: tenant, company, department, task, agent, capability, route, key, fingerprint, correlation and lineage are fixed at creation';
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
       or new.stop_id is distinct from old.stop_id then
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
    -- Refused or failed before any call: no fact of a call may appear.
    if new.job_attempt is not null or new.prompt_version is not null or new.input_fingerprint is not null
       or new.provider is not null or new.model is not null or new.response_model is not null
       or new.provider_request_id is not null or new.provider_response_id is not null
       or new.finish_reason is not null or new.input_tokens is not null or new.output_tokens is not null
       or new.total_tokens is not null or new.cached_input_tokens is not null or new.reasoning_tokens is not null
       or new.latency_ms is not null or new.result is not null then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run that never started carries no fact of a model call';
    end if;
  end if;

  if old.status = 'running'
     and (new.job_attempt is distinct from old.job_attempt
          or new.prompt_version is distinct from old.prompt_version
          or new.input_fingerprint is distinct from old.input_fingerprint
          or new.provider is distinct from old.provider
          or new.model is distinct from old.model) then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: what was started is fixed once the run is running';
  end if;

  -- The output contract holds on EVERY write path, not only in the capability that
  -- normally records a result.
  if new.status = 'succeeded' and not coalesce(ops.agent_run_result_valid(new.capability, new.result), false) then
    raise exception using
      errcode = 'OS400',
      message = 'ops.agent_runs: a run succeeds only with a result that satisfies its capability''s output contract';
  end if;

  -- A run records only an ACTIVE stop that COVERS it, with the same scope rule the
  -- switch itself applies.
  if new.stop_id is not null then
    if new.status <> 'cancelled' or not exists (
      select 1 from ops.execution_stops s
       where s.id = new.stop_id
         and s.cleared_at is null
         and (   s.scope = 'global'
              or (s.scope = 'tenant'     and s.tenant_id = new.tenant_id)
              or (s.scope = 'company'    and s.tenant_id = new.tenant_id and s.company_id = new.company_id)
              or (s.scope = 'department' and s.tenant_id = new.tenant_id and s.company_id = new.company_id
                                         and s.department_id = new.department_id)
              or (s.scope = 'agent'      and s.tenant_id = new.tenant_id and s.company_id = new.company_id
                                         and s.agent_id = new.agent_id))
    ) then
      raise exception using
        errcode = 'OS409',
        message = 'ops.agent_runs: a run records only an active stop that covers it, and only when that stop cancelled it';
    end if;
  end if;

  -- Derived, never taken from the caller.
  new.started_at := case when new.status = 'running' then now() else old.started_at end;
  new.completed_at := case when new.status in ('succeeded', 'failed', 'indeterminate', 'cancelled') then now() end;
  new.updated_at := now();
  return new;
end
$function$;

-- The events table's guard, with `agent_run` as a subject. Everything else is the
-- Phase 1C body unchanged (20260912200000, section 4).
create or replace function ops.guard_event_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_found boolean;
begin
  -- A lifecycle fact comes from a state change, never from a caller. The
  -- emitting trigger runs at depth 1, so its insert fires this at depth 2; a
  -- direct insert, or ops.record_event, fires it at depth 1. A tripwire against
  -- the owner, who can disable triggers — not a boundary.
  if split_part(new.type, '.', 1) = any (ops.derived_event_namespaces())
     and pg_trigger_depth() < 2 then
    raise exception using
      errcode = 'OS403',
      message = format('ops.events: %L is a derived lifecycle event and cannot be recorded directly', new.type);
  end if;

  if new.subject_type is not null then
    v_found := case new.subject_type
      when 'company' then new.subject_id = new.company_id
      when 'department' then exists (
        select 1 from ops.departments d
         where d.id = new.subject_id and d.tenant_id = new.tenant_id and d.company_id = new.company_id)
      when 'agent' then exists (
        select 1 from ops.agents a
         where a.id = new.subject_id and a.tenant_id = new.tenant_id and a.company_id = new.company_id)
      when 'task' then exists (
        select 1 from ops.tasks t
         where t.id = new.subject_id and t.tenant_id = new.tenant_id and t.company_id = new.company_id)
      when 'agent_run' then exists (
        select 1 from ops.agent_runs r
         where r.id = new.subject_id and r.tenant_id = new.tenant_id and r.company_id = new.company_id)
      else false
    end;
    if not v_found then
      raise exception using
        errcode = 'OS404',
        message = format('ops.events: %s %s not found in this company', new.subject_type, new.subject_id);
    end if;
  end if;

  if new.causation_id is not null and not exists (
    select 1 from ops.events e
     where e.id = new.causation_id
       and e.tenant_id = new.tenant_id
       and e.company_id = new.company_id
  ) then
    raise exception using
      errcode = 'OS404',
      message = 'ops.events: causation event not found in this company';
  end if;

  new.created_at := now();
  return new;
end
$function$;

alter table ops.events drop constraint if exists events_subject_type_check;
alter table ops.events add constraint events_subject_type_check check (
  subject_type is null or subject_type in ('company', 'department', 'agent', 'task', 'agent_run'));

-- ---------------------------------------------------------------------------
-- 4. Agent run events. Exactly one per change, in the same statement.
--
-- CORRELATION is the run's own column, which the database generated or inherited:
-- never the transaction setting a caller wrote. CAUSATION is the run's previous
-- LIFECYCLE fact (for a retry's request, the last lifecycle fact of the run it
-- repeats); a business fact recorded about the run cannot graft itself into that
-- chain. The payload carries identifiers, statuses, categories and the three-valued
-- outcome — never the result's text, a summary, a prompt, a title or usage — and
-- never a global sequence value (SI-26).
-- ---------------------------------------------------------------------------

create or replace function ops.emit_agent_run_event()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_source constant text := nullif(current_setting('app.event_source', true), '');
  v_type    text;
  v_payload jsonb;
  v_cause   uuid;
begin
  if v_source is null then
    raise exception using
      errcode = 'OS400',
      message = 'ops.agent_runs: this change carries no event provenance. Agent runs change through the ops functions, which declare it.';
  end if;

  if tg_op = 'INSERT' then
    v_type := 'agent_run.requested';
    v_payload := jsonb_build_object(
      'task_id', new.task_id, 'agent_id', new.agent_id, 'capability', new.capability,
      'model_route', new.model_route, 'retry_of_run_id', new.retry_of_run_id);
    if new.retry_of_run_id is not null then
      select e.id into v_cause
        from ops.events e
       where e.tenant_id = new.tenant_id and e.company_id = new.company_id
         and e.subject_type = 'agent_run' and e.subject_id = new.retry_of_run_id
         and split_part(e.type, '.', 1) = 'agent_run'
       order by e.seq desc
       limit 1;
    end if;
  else
    v_type := 'agent_run.' || case new.status when 'running' then 'started' else new.status end;
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'from_status', old.status, 'to_status', new.status,
      'error_category', new.error_category, 'error_code', new.error_code,
      'outcome', case when new.result ->> 'outcome' in ('completed', 'needs_input', 'blocked')
                      then new.result ->> 'outcome' end));
    select e.id into v_cause
      from ops.events e
     where e.tenant_id = new.tenant_id and e.company_id = new.company_id
       and e.subject_type = 'agent_run' and e.subject_id = new.id
       and split_part(e.type, '.', 1) = 'agent_run'
     order by e.seq desc
     limit 1;
  end if;

  insert into ops.events (
    tenant_id, company_id, type, source, subject_type, subject_id,
    payload, correlation_id, causation_id)
  values (
    new.tenant_id, new.company_id, v_type, v_source, 'agent_run', new.id,
    v_payload, new.correlation_id, v_cause);

  return null;
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. Triggers. Update-path and removal guards ENABLE ALWAYS, so replica mode does not
--    silence them; insert validation and emission stay ORIGIN, as in Phase 1C.
-- ---------------------------------------------------------------------------

drop trigger if exists execution_stops_guard_insert on ops.execution_stops;
create trigger execution_stops_guard_insert
  before insert on ops.execution_stops
  for each row execute function ops.guard_execution_stop_insert();

drop trigger if exists execution_stops_guard_update on ops.execution_stops;
create trigger execution_stops_guard_update
  before update on ops.execution_stops
  for each row execute function ops.guard_execution_stop_update();
alter table ops.execution_stops enable always trigger execution_stops_guard_update;

drop trigger if exists execution_stops_guard_delete on ops.execution_stops;
create trigger execution_stops_guard_delete
  before delete on ops.execution_stops
  for each row execute function ops.guard_execution_stop_delete();
alter table ops.execution_stops enable always trigger execution_stops_guard_delete;

drop trigger if exists execution_stops_refuse_truncate on ops.execution_stops;
create trigger execution_stops_refuse_truncate
  before truncate on ops.execution_stops
  for each statement execute function ops.refuse_execution_stop_truncate();
alter table ops.execution_stops enable always trigger execution_stops_refuse_truncate;

drop trigger if exists agent_runs_guard_insert on ops.agent_runs;
create trigger agent_runs_guard_insert
  before insert on ops.agent_runs
  for each row execute function ops.guard_agent_run_insert();

drop trigger if exists agent_runs_guard_update on ops.agent_runs;
create trigger agent_runs_guard_update
  before update on ops.agent_runs
  for each row execute function ops.guard_agent_run_update();
alter table ops.agent_runs enable always trigger agent_runs_guard_update;

drop trigger if exists agent_runs_emit_requested on ops.agent_runs;
create trigger agent_runs_emit_requested
  after insert on ops.agent_runs
  for each row execute function ops.emit_agent_run_event();

drop trigger if exists agent_runs_emit_changed on ops.agent_runs;
create trigger agent_runs_emit_changed
  after update of status on ops.agent_runs
  for each row when (old.status is distinct from new.status)
  execute function ops.emit_agent_run_event();

-- ---------------------------------------------------------------------------
-- 6. Owner services. SECURITY INVOKER, explicit authorised tenant scope, every
--    other id resolved INSIDE that scope before any of its state is read.
-- ---------------------------------------------------------------------------

-- The stop that refuses a run, if any: global first, then the narrowest scopes.
-- Deny wins, so the order only decides which stop is recorded. A switch that cannot be
-- read is a stopped one: a missing coordinate raises, and so does a caller for whom row
-- security would silently filter the stops to nothing.
create or replace function ops.active_execution_stop(
  p_tenant_id     uuid,
  p_company_id    uuid,
  p_department_id uuid,
  p_agent_id      uuid
)
returns uuid
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_stop uuid;
begin
  if p_tenant_id is null or p_company_id is null or p_department_id is null or p_agent_id is null then
    raise exception using
      errcode = 'OS400',
      message = 'ops.active_execution_stop: a run has a tenant, company, department and agent; without all four the switch cannot be read, and an unreadable switch refuses';
  end if;
  if row_security_active('ops.execution_stops') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.active_execution_stop: row security would hide the stops from this caller, and a switch that cannot be read refuses';
  end if;

  select s.id into v_stop
    from ops.execution_stops s
   where s.cleared_at is null
     and (   s.scope = 'global'
          or (s.scope = 'tenant'     and s.tenant_id = p_tenant_id)
          or (s.scope = 'company'    and s.tenant_id = p_tenant_id and s.company_id = p_company_id)
          or (s.scope = 'department' and s.tenant_id = p_tenant_id and s.company_id = p_company_id
                                     and s.department_id = p_department_id)
          or (s.scope = 'agent'      and s.tenant_id = p_tenant_id and s.company_id = p_company_id
                                     and s.agent_id = p_agent_id))
   order by case s.scope when 'global' then 0 when 'tenant' then 1 when 'company' then 2
                         when 'department' then 3 else 4 end,
            s.tripped_at
   limit 1;

  return v_stop;
end
$function$;

create or replace function ops.trip_execution_stop(
  p_scope         text,
  p_reason        text,
  p_actor         text,
  p_tenant_id     uuid default null,
  p_company_id    uuid default null,
  p_department_id uuid default null,
  p_agent_id      uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_scope is null or p_scope not in ('global', 'tenant', 'company', 'department', 'agent') then
    raise exception using errcode = 'OS400', message = format('ops.trip_execution_stop: %L is not a stop scope', p_scope);
  end if;
  if p_scope <> 'global' and p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.trip_execution_stop: a scoped stop needs its tenant';
  end if;
  if (p_scope = 'global' and (p_tenant_id is not null or p_company_id is not null or p_department_id is not null or p_agent_id is not null))
     or (p_scope = 'tenant' and (p_company_id is not null or p_department_id is not null or p_agent_id is not null))
     or (p_scope = 'company' and (p_company_id is null or p_department_id is not null or p_agent_id is not null))
     or (p_scope = 'department' and (p_company_id is null or p_department_id is null or p_agent_id is not null))
     or (p_scope = 'agent' and (p_company_id is null or p_agent_id is null or p_department_id is not null)) then
    raise exception using errcode = 'OS400', message = format('ops.trip_execution_stop: the target does not match scope %s', p_scope);
  end if;

  if p_tenant_id is not null then
    perform 1 from ops.tenants t where t.id = p_tenant_id for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.trip_execution_stop: tenant not found';
    end if;
  end if;
  if p_company_id is not null then
    perform 1 from ops.companies c where c.id = p_company_id and c.tenant_id = p_tenant_id for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.trip_execution_stop: company not found in this tenant';
    end if;
  end if;
  if p_department_id is not null then
    perform 1 from ops.departments d
     where d.id = p_department_id and d.tenant_id = p_tenant_id and d.company_id = p_company_id for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.trip_execution_stop: department not found in this company';
    end if;
  end if;
  if p_agent_id is not null then
    perform 1 from ops.agents a
     where a.id = p_agent_id and a.tenant_id = p_tenant_id and a.company_id = p_company_id for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.trip_execution_stop: agent not found in this company';
    end if;
  end if;

  -- Waits for every request or start that is reading the stops right now; every later
  -- one waits for this trip and sees it.
  perform pg_advisory_xact_lock(ops.execution_stop_lock_key());

  insert into ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id, reason, tripped_by)
  values (p_scope, p_tenant_id, p_company_id, p_department_id, p_agent_id, p_reason, p_actor)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Already stopped at exactly this target: tripping again changes nothing. The lock
    -- also serialises clearing, so the stop that blocked the insert is still active.
    select s.id into v_id
      from ops.execution_stops s
     where s.cleared_at is null
       and s.scope = p_scope
       and s.tenant_id is not distinct from p_tenant_id
       and s.company_id is not distinct from p_company_id
       and s.department_id is not distinct from p_department_id
       and s.agent_id is not distinct from p_agent_id;
    if v_id is null then
      raise exception using
        errcode = 'OS409',
        message = 'ops.trip_execution_stop: the stop could neither be recorded nor found; nothing was tripped';
    end if;
  end if;
  return v_id;
end
$function$;

create or replace function ops.clear_execution_stop(
  p_stop_id uuid,
  p_reason  text,
  p_actor   text
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  perform pg_advisory_xact_lock(ops.execution_stop_lock_key());
  perform 1 from ops.execution_stops s where s.id = p_stop_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.clear_execution_stop: stop not found';
  end if;

  update ops.execution_stops
     set cleared_by = p_actor, cleared_reason = p_reason
   where id = p_stop_id and cleared_at is null;
  return found;
end
$function$;

-- The explicit request for ONE agent run. Creating or changing a task never calls a
-- model; only this does, and only for the agent the task is assigned to.
--
-- IDEMPOTENCY. (tenant, key) names one request. The same key for the same semantic
-- request returns the run it created; the same key for a different request is
-- refused. The key is looked up only inside the caller's tenant.
--
-- LINEAGE. No correlation or causation argument exists. The correlation is generated
-- here, or inherited from the run a retry names; the causation of every agent_run
-- fact is derived from the run's own history.
create or replace function ops.request_agent_run(
  p_tenant_id       uuid,
  p_task_id         uuid,
  p_agent_id        uuid,
  p_capability      text,
  p_idempotency_key text,
  p_source          text,
  p_retry_of_run_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_fingerprint text;
  v_existing    ops.agent_runs;
  v_task        ops.tasks;
  v_agent       ops.agents;
  v_parent      ops.agent_runs;
  v_route       text;
  v_company     text;
  v_department  text;
  v_correlation uuid;
  v_context     jsonb;
  v_run         uuid;
  v_stop        uuid;
  v_requested   uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.request_agent_run: no tenant scope';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.request_agent_run: an agent run request needs an idempotency key of 1 to 200 printable characters';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.request_agent_run: the request source is missing or malformed';
  end if;

  -- concat_ws skips NULLs, so every field is coalesced: a missing field must not let
  -- two different requests hash alike.
  v_fingerprint := encode(sha256(convert_to(concat_ws('|',
    'agent_run.request.v1', coalesce(p_task_id::text, ''), coalesce(p_agent_id::text, ''),
    coalesce(p_capability, ''), coalesce(p_retry_of_run_id::text, '')), 'UTF8')), 'hex');

  select r.* into v_existing
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return v_existing.id; -- the same request, already made: no second run, no second fact
    end if;
    raise exception using
      errcode = 'OS409',
      message = 'ops.request_agent_run: that idempotency key already names a different agent run request';
  end if;

  select t.* into v_task
    from ops.tasks t
   where t.id = p_task_id and t.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.request_agent_run: task not found in this tenant';
  end if;
  -- Resolved inside the TASK's company: another company's agent is simply not found.
  select a.* into v_agent
    from ops.agents a
   where a.id = p_agent_id and a.tenant_id = p_tenant_id and a.company_id = v_task.company_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.request_agent_run: agent not found in this company';
  end if;

  select c.model_route into v_route
    from ops.agent_run_capabilities() c
   where c.capability = p_capability;
  if v_route is null then
    raise exception using
      errcode = 'OS403',
      message = format('ops.request_agent_run: %L is not an agent run capability', p_capability);
  end if;

  if v_task.status in ('completed', 'failed', 'cancelled') then
    raise exception using errcode = 'OS409', message = format('ops.request_agent_run: the task is %s', v_task.status);
  end if;
  if v_task.assigned_agent_id is distinct from p_agent_id then
    raise exception using
      errcode = 'OS409',
      message = 'ops.request_agent_run: the task is not assigned to this agent, and an agent runs only for its own work';
  end if;
  select c.status into v_company from ops.companies c
   where c.id = v_task.company_id and c.tenant_id = p_tenant_id for share;
  select d.status into v_department from ops.departments d
   where d.id = v_agent.department_id and d.tenant_id = p_tenant_id and d.company_id = v_task.company_id for share;
  if v_company <> 'active' or v_department <> 'active' or v_agent.status <> 'active' then
    raise exception using
      errcode = 'OS409',
      message = 'ops.request_agent_run: the company, department or agent is inactive';
  end if;

  if p_retry_of_run_id is not null then
    -- No row lock: a run that can be retried is finished, and a finished run never
    -- changes. Locking it here would take locks in the opposite order to a worker that
    -- holds the run and then reads the task.
    select r.* into v_parent
      from ops.agent_runs r
     where r.id = p_retry_of_run_id and r.tenant_id = p_tenant_id and r.task_id = p_task_id;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.request_agent_run: the run retried was not found on this task';
    end if;
    if v_parent.agent_id <> p_agent_id or v_parent.capability <> p_capability then
      raise exception using
        errcode = 'OS409',
        message = 'ops.request_agent_run: a retry repeats the same agent and capability';
    end if;
    if v_parent.status not in ('succeeded', 'failed', 'indeterminate', 'cancelled') then
      raise exception using errcode = 'OS409', message = 'ops.request_agent_run: only a finished run can be retried';
    end if;
    v_correlation := v_parent.correlation_id;
  else
    v_correlation := gen_random_uuid();
  end if;

  v_context := ops.push_event_context(p_source, v_correlation, null);

  insert into ops.agent_runs (
    tenant_id, company_id, department_id, task_id, agent_id, retry_of_run_id,
    capability, model_route, idempotency_key, request_fingerprint, correlation_id, requested_by)
  values (
    p_tenant_id, v_task.company_id, v_agent.department_id, p_task_id, p_agent_id, p_retry_of_run_id,
    p_capability, v_route, p_idempotency_key, v_fingerprint, v_correlation, p_source)
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_run;

  if v_run is null then
    -- A concurrent request with this key committed first. Answer as a replay would.
    perform ops.pop_event_context(v_context);
    select r.* into v_existing
      from ops.agent_runs r
     where r.tenant_id = p_tenant_id and r.idempotency_key = p_idempotency_key;
    if v_existing.request_fingerprint = v_fingerprint then
      return v_existing.id;
    end if;
    raise exception using
      errcode = 'OS409',
      message = 'ops.request_agent_run: that idempotency key already names a different agent run request';
  end if;

  -- The kill switch, at request time. A refusal is RECORDED: the run exists, cancelled,
  -- naming the stop, and no job is ever created for it (ADR 0010). The shared lock is
  -- taken in its own statement, so the read after it sees every trip that has returned.
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.active_execution_stop(p_tenant_id, v_task.company_id, v_agent.department_id, p_agent_id);
  if v_stop is not null then
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped', stop_id = v_stop
     where id = v_run;
    perform ops.pop_event_context(v_context);
    return v_run;
  end if;

  -- The job, through the task -> job bridge: allowlisted kind, tenant from the task
  -- row, task-scoped idempotency, and a payload that is only a reference. The
  -- task.execution_requested fact is caused by this run's agent_run.requested fact.
  select e.id into v_requested
    from ops.events e
   where e.tenant_id = p_tenant_id and e.company_id = v_task.company_id
     and e.subject_type = 'agent_run' and e.subject_id = v_run
     and e.type = 'agent_run.requested'
   order by e.seq desc
   limit 1;
  perform ops.request_task_execution(
    p_tenant_id, p_task_id, 'agent_run.execute', p_source,
    jsonb_build_object('agent_run_id', v_run), format('agent_run:%s', v_run),
    v_correlation, v_requested);

  perform ops.pop_event_context(v_context);
  return v_run;
end
$function$;

-- The task -> job bridge (Phase 1C), with one branch for the agent run kind. Every
-- Phase 1C property is unchanged: tenant from the task row, allowlisted kind, the
-- same refusal order, task-scoped idempotency, and its own job insert so a
-- concurrently enqueued key is refused rather than adopted.
--
-- An `agent_run.execute` job exists only for a PENDING run of THIS task that has no
-- job yet, and its payload is exactly that run's id, stored in canonical form. The run
-- is resolved inside the task's tenant and task, so a forged id is "not found", and
-- the job link is written on the run in the same transaction that creates the job.
create or replace function ops.request_task_execution(
  p_tenant_id       uuid,
  p_task_id         uuid,
  p_kind            text,
  p_source          text,
  p_payload         jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_correlation_id  uuid default null,
  p_causation_id    uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context    jsonb;
  v_task       ops.tasks;
  v_company    text;
  v_key        text;
  v_existing   uuid;
  v_job        uuid;
  v_payload    jsonb := coalesce(p_payload, '{}'::jsonb);
  v_run_id     uuid;
  v_run_status text;
  v_run_job    uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.request_task_execution: no tenant scope';
  end if;
  select t.* into v_task
    from ops.tasks t
   where t.id = p_task_id and t.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.request_task_execution: task not found in this tenant';
  end if;
  if p_kind is null or not (p_kind = any (ops.task_executable_kinds())) then
    raise exception using
      errcode = 'OS403',
      message = format('ops.request_task_execution: %L is not a kind a task may request', p_kind);
  end if;
  if v_task.status in ('completed', 'failed', 'cancelled') then
    raise exception using errcode = 'OS409', message = format('ops.request_task_execution: the task is %s', v_task.status);
  end if;
  select c.status into v_company from ops.companies c
   where c.id = v_task.company_id and c.tenant_id = v_task.tenant_id
     for share;
  if v_company <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.request_task_execution: the company is inactive';
  end if;
  if p_payload is not null and jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = 'OS400', message = 'ops.request_task_execution: the payload must be a JSON object';
  end if;
  -- Bounded, so an oversize key is a typed refusal rather than a btree
  -- "index row size exceeds maximum" from the idempotency index.
  if char_length(p_idempotency_key) > 200 then
    raise exception using errcode = 'OS400', message = 'ops.request_task_execution: the idempotency key is longer than 200 characters';
  end if;

  if p_kind = 'agent_run.execute' then
    if p_payload is null
       or (select array_agg(k) from jsonb_object_keys(p_payload) as k) is distinct from array['agent_run_id']::text[]
       or jsonb_typeof(p_payload -> 'agent_run_id') is distinct from 'string'
       or (p_payload ->> 'agent_run_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using
        errcode = 'OS400',
        message = 'ops.request_task_execution: an agent run job carries exactly one field, agent_run_id';
    end if;
    v_run_id := (p_payload ->> 'agent_run_id')::uuid;
    v_payload := jsonb_build_object('agent_run_id', v_run_id);
    -- A plain read first: a run that is not linkable is refused without taking a row
    -- lock, so a doomed request never waits on, or deadlocks with, a worker holding it.
    select r.status, r.job_id into v_run_status, v_run_job
      from ops.agent_runs r
     where r.id = v_run_id and r.tenant_id = v_task.tenant_id and r.task_id = p_task_id;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.request_task_execution: agent run not found on this task';
    end if;
  end if;

  if p_idempotency_key is not null then
    v_key := format('task:%s:%s', p_task_id, p_idempotency_key);
    select j.id into v_existing
      from ops.jobs j
     where j.tenant_id = v_task.tenant_id and j.kind = p_kind and j.idempotency_key = v_key;
    if found then
      if exists (
        select 1 from ops.task_jobs l
         where l.tenant_id = v_task.tenant_id and l.job_id = v_existing and l.task_id = p_task_id
      ) and (p_kind <> 'agent_run.execute' or v_run_job is not distinct from v_existing) then
        return v_existing; -- the same request, already made: no second link, no second fact
      end if;
      raise exception using
        errcode = 'OS409',
        message = 'ops.request_task_execution: that idempotency key already names a job this task did not request';
    end if;
  end if;

  if p_kind = 'agent_run.execute' then
    if v_run_job is null and v_run_status = 'pending' then
      -- Only now lock it. A pending run with no job has no lease on it, so no worker
      -- can be holding it.
      select r.status, r.job_id into v_run_status, v_run_job
        from ops.agent_runs r
       where r.id = v_run_id and r.tenant_id = v_task.tenant_id
         for update;
    end if;
    if v_run_job is not null or v_run_status <> 'pending' then
      raise exception using
        errcode = 'OS409',
        message = 'ops.request_task_execution: that agent run already has its job, or is no longer pending';
    end if;
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  -- The bridge inserts its own job instead of calling ops.enqueue_job. That
  -- function's idempotent path returns WHATEVER row holds the key — including a
  -- job a concurrent service_role caller committed between the check above and
  -- this insert — and the bridge would then record a request the task never made
  -- (measured with two real connections in the Phase 1C adversarial pass). A
  -- plain insert turns that race into a unique violation, refused here.
  begin
    insert into ops.jobs (tenant_id, kind, payload, priority, available_at, max_attempts, idempotency_key)
    values (v_task.tenant_id, p_kind, v_payload, 100, now(), 5, v_key)
    returning id into v_job;
  exception when unique_violation then
    raise exception using
      errcode = 'OS409',
      message = 'ops.request_task_execution: a job with that idempotency key was enqueued by someone other than this task';
  end;
  insert into ops.job_events (job_id, tenant_id, event, detail)
  values (v_job, v_task.tenant_id, 'enqueued', p_kind);
  insert into ops.task_jobs (tenant_id, job_id, company_id, task_id)
  values (v_task.tenant_id, v_job, v_task.company_id, p_task_id);
  if p_kind = 'agent_run.execute' then
    update ops.agent_runs set job_id = v_job where id = v_run_id and tenant_id = v_task.tenant_id;
  end if;
  perform ops.pop_event_context(v_context);
  return v_job;
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. Worker capabilities.
--
-- The shape every capability copies (SI-18): SECURITY DEFINER, NO tenant, run, task
-- or agent argument, and the one run it may touch resolved from the LIVE LEASE:
-- ops.agent_run_lease_attempt() proves app.worker_id + app.job_id name a job this
-- worker holds, live on the clock NOW, and share-locks that job row for the rest of
-- the transaction — so neither the reaper nor the sweep can take it away mid-step. That
-- check runs when a capability begins; ops.start_agent_run, the one step whose answer
-- leads to a paid call, checks the lease on the clock again after its own lock waits,
-- so a lease that ran out while it waited starts nothing. The run is the one whose
-- job_id is that job. A forged run id has nowhere to go, and a payload is never
-- read.
--
-- The worker's sequence, and why each step is its own function:
--   claim     read the run's bounded context; settle a run an EARLIER attempt left
--             `running` indeterminate instead of starting it again.
--   start     re-check every gate and the kill switch under lock, then commit
--             `running` BEFORE the provider call (or cancel the run). Only the token
--             `running` means "call"; nothing else ever does.
--   complete  store a result the database itself validates, for this attempt only.
--   fail      store what went wrong; the DATABASE decides failed vs indeterminate.
--   refuse    a run this worker cannot even attempt (no configured route).
--   settle_stale_agent_runs  the sweep for runs whose attempt died.
-- ---------------------------------------------------------------------------

-- The attempt number of the job this transaction's live lease holds, with that job row
-- share-locked. Not granted to any role: only the definer capabilities below call it.
create or replace function ops.agent_run_lease_attempt()
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_tenant  uuid := ops.current_tenant_id();
  v_worker  text := nullif(current_setting('app.worker_id', true), '');
  v_job     uuid;
  v_attempt integer;
begin
  if v_tenant is null then
    raise exception
      'ops agent run capability: no live lease, so no tenant. An agent run is reachable only from its own leased job.'
      using errcode = '42501';
  end if;
  v_job := nullif(current_setting('app.job_id', true), '')::uuid;

  select j.attempts into v_attempt
    from ops.jobs j
   where j.id = v_job
     and j.tenant_id = v_tenant
     and j.lease_owner = v_worker
     and j.status = 'leased'
     and j.lease_expires_at > clock_timestamp()
     for share;
  if not found then
    raise exception 'ops agent run capability: the lease on this job is no longer live'
      using errcode = '42501';
  end if;
  return v_attempt;
end
$function$;

create or replace function ops.claim_agent_run()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt integer := ops.agent_run_lease_attempt();
  v_tenant  uuid := ops.current_tenant_id();
  v_job     uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run     ops.agent_runs;
  v_task    ops.tasks;
  v_agent   ops.agents;
  v_context jsonb;
begin
  select r.* into v_run
    from ops.agent_runs r
   where r.tenant_id = v_tenant and r.job_id = v_job
     for update;
  if not found then
    raise exception 'ops.claim_agent_run: no agent run is bound to the leased job'
      using errcode = '42501';
  end if;

  if v_run.status = 'running' then
    if v_run.job_attempt is not distinct from v_attempt then
      -- This very attempt started the run: claiming it again is a worker defect, and
      -- settling it would discard a call that may still be in flight.
      raise exception 'ops.claim_agent_run: this attempt already started the run; a run is never claimed twice'
        using errcode = '42501';
    end if;
    -- An earlier attempt started this run and did not settle it. Whether its call
    -- reached the provider cannot be known here, so it is never issued again.
    v_context := ops.push_event_context('agent-runtime', null, null);
    update ops.agent_runs
       set status = 'indeterminate', error_category = 'interrupted', error_code = 'execution_interrupted'
     where id = v_run.id;
    perform ops.pop_event_context(v_context);
    return jsonb_build_object('action', 'settled', 'agent_run_id', v_run.id, 'status', 'indeterminate');
  end if;

  if v_run.status <> 'pending' then
    return jsonb_build_object('action', 'settled', 'agent_run_id', v_run.id, 'status', v_run.status);
  end if;

  select t.* into v_task from ops.tasks t
   where t.id = v_run.task_id and t.tenant_id = v_run.tenant_id and t.company_id = v_run.company_id;
  select a.* into v_agent from ops.agents a
   where a.id = v_run.agent_id and a.tenant_id = v_run.tenant_id and a.company_id = v_run.company_id;

  -- Exactly what the prompt needs, and nothing that identifies the tenant, company,
  -- task or agent: no ids, no slugs, no timestamps beyond the task's due date.
  return jsonb_build_object(
    'action', 'start',
    'agent_run_id', v_run.id,
    'capability', v_run.capability,
    'model_route', v_run.model_route,
    'agent', jsonb_build_object('name', v_agent.name, 'role', v_agent.role, 'description', v_agent.description),
    'task', jsonb_build_object(
      'type', v_task.type, 'title', v_task.title, 'description', v_task.description,
      'priority', v_task.priority, 'due_at', v_task.due_at));
end
$function$;

comment on function ops.claim_agent_run() is
  'Returns the bounded prompt context of the agent run bound to the live lease, or settles it. A run an earlier attempt left running is settled indeterminate, never started again. Resolves the run from the live lease; takes no id.';

create or replace function ops.refuse_agent_run(p_code text)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt integer := ops.agent_run_lease_attempt();
  v_tenant  uuid := ops.current_tenant_id();
  v_job     uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run     ops.agent_runs;
  v_context jsonb;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.refuse_agent_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.status <> 'pending' then
    return v_run.status;
  end if;

  v_context := ops.push_event_context('agent-runtime', null, null);
  update ops.agent_runs
     set status = 'failed', error_category = 'configuration',
         error_code = case when p_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'
                            and not (p_code = any (ops.agent_run_reserved_error_codes()))
                           then p_code else 'configuration' end
   where id = v_run.id;
  perform ops.pop_event_context(v_context);
  return 'failed';
end
$function$;

create or replace function ops.start_agent_run(
  p_provider          text,
  p_model             text,
  p_prompt_version    text,
  p_input_fingerprint text
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt    integer := ops.agent_run_lease_attempt();
  v_tenant     uuid := ops.current_tenant_id();
  v_job        uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run        ops.agent_runs;
  v_task       ops.tasks;
  v_agent      text;
  v_company    text;
  v_department text;
  v_stop       uuid;
  v_code       text;
  v_context    jsonb;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.start_agent_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;

  if v_run.status = 'running' then
    if v_run.job_attempt is distinct from v_attempt then
      -- Another attempt started it and never settled it: the call may have happened.
      v_context := ops.push_event_context('agent-runtime', null, null);
      update ops.agent_runs
         set status = 'indeterminate', error_category = 'interrupted', error_code = 'execution_interrupted'
       where id = v_run.id;
      perform ops.pop_event_context(v_context);
      return 'indeterminate';
    end if;
    return 'already_running'; -- never `running`: that token alone means "call"
  end if;
  if v_run.status <> 'pending' then
    return v_run.status; -- started once, never twice
  end if;

  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,31}$'
     or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
     or p_prompt_version is null or p_prompt_version !~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'
     or p_input_fingerprint is null or p_input_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.start_agent_run: provider, model, prompt version and input fingerprint are required and well formed';
  end if;

  -- Every gate again, under lock, immediately before the call: the task may have
  -- been closed or reassigned, the agent or its organisation deactivated, or a stop
  -- tripped, since the request.
  select t.* into v_task from ops.tasks t
   where t.id = v_run.task_id and t.tenant_id = v_run.tenant_id and t.company_id = v_run.company_id
     for share;
  select a.status into v_agent from ops.agents a
   where a.id = v_run.agent_id and a.tenant_id = v_run.tenant_id and a.company_id = v_run.company_id for share;
  select c.status into v_company from ops.companies c
   where c.id = v_run.company_id and c.tenant_id = v_run.tenant_id for share;
  select d.status into v_department from ops.departments d
   where d.id = v_run.department_id and d.tenant_id = v_run.tenant_id and d.company_id = v_run.company_id for share;
  -- Serialised with tripping: every stop whose trip has returned is visible to the read
  -- after this statement, and no trip can land between that read and this commit.
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.active_execution_stop(v_run.tenant_id, v_run.company_id, v_run.department_id, v_run.agent_id);

  v_code := case
    when v_stop is not null then 'execution_stopped'
    when v_task.status in ('completed', 'failed', 'cancelled') then 'task_closed'
    when v_task.assigned_agent_id is distinct from v_run.agent_id then 'task_reassigned'
    when v_company is distinct from 'active' then 'company_inactive'
    when v_department is distinct from 'active' then 'department_inactive'
    when v_agent is distinct from 'active' then 'agent_inactive'
  end;

  -- The lease again, on the clock, now that every lock this start waited on is held:
  -- the task, agent, company and department rows and the kill-switch lock can each
  -- wait, and a lease that ran out meanwhile must not commit a start. The job row is
  -- already share-locked by this transaction, so this read cannot wait. Raising
  -- records nothing: the run stays pending for the job's next attempt.
  if not exists (
    select 1
      from ops.jobs j
     where j.id = v_job
       and j.tenant_id = v_tenant
       and j.lease_owner = nullif(current_setting('app.worker_id', true), '')
       and j.status = 'leased'
       and j.attempts = v_attempt
       and j.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'ops.start_agent_run: the lease on this job ran out while the start waited; nothing was started'
      using errcode = '42501';
  end if;

  v_context := ops.push_event_context('agent-runtime', null, null);
  if v_code is not null then
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = v_code, stop_id = v_stop
     where id = v_run.id;
    perform ops.pop_event_context(v_context);
    return 'cancelled';
  end if;

  update ops.agent_runs
     set status = 'running', provider = p_provider, model = p_model,
         prompt_version = p_prompt_version, input_fingerprint = p_input_fingerprint,
         job_attempt = v_attempt
   where id = v_run.id;
  perform ops.pop_event_context(v_context);
  return 'running';
end
$function$;

comment on function ops.start_agent_run(text, text, text, text) is
  'Re-checks every gate and the execution stops under lock, then records the run as running. The caller commits this BEFORE calling the provider, and only the returned token running means call. A run another attempt started is settled indeterminate; a run is started once. Resolves the run from the live lease; takes no id.';

-- An identifier or usage figure outside its shape is dropped to NULL rather than
-- refused: a provider's odd request id must not cost the result it came with. The
-- RESULT is not treated that way: section 0's contract decides it.
create or replace function ops.complete_agent_run(
  p_result               jsonb,
  p_response_model       text,
  p_finish_reason        text,
  p_provider_request_id  text,
  p_provider_response_id text,
  p_input_tokens         integer,
  p_output_tokens        integer,
  p_total_tokens         integer,
  p_cached_input_tokens  integer,
  p_reasoning_tokens     integer,
  p_latency_ms           integer
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt integer := ops.agent_run_lease_attempt();
  v_tenant  uuid := ops.current_tenant_id();
  v_job     uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run     ops.agent_runs;
  v_valid   boolean;
  v_context jsonb;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.complete_agent_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.status <> 'running' or v_run.job_attempt is distinct from v_attempt then
    return 'not_running'; -- not running, or started by another attempt: never this attempt's to settle
  end if;

  v_valid := coalesce(ops.agent_run_result_valid(v_run.capability, p_result), false);

  v_context := ops.push_event_context('agent-runtime', null, null);
  update ops.agent_runs
     set status               = case when v_valid then 'succeeded' else 'failed' end,
         result               = case when v_valid then p_result end,
         error_category       = case when v_valid then null else 'schema_validation' end,
         error_code           = case when v_valid then null else 'database_contract' end,
         response_model       = case when p_response_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$' then p_response_model end,
         finish_reason        = case when p_finish_reason ~ '^[a-z][a-z0-9_]{0,39}$' then p_finish_reason end,
         provider_request_id  = case when p_provider_request_id ~ '^[A-Za-z0-9._:-]{1,200}$' then p_provider_request_id end,
         provider_response_id = case when p_provider_response_id ~ '^[A-Za-z0-9._:-]{1,200}$' then p_provider_response_id end,
         input_tokens         = case when p_input_tokens >= 0 then p_input_tokens end,
         output_tokens        = case when p_output_tokens >= 0 then p_output_tokens end,
         total_tokens         = case when p_total_tokens >= 0 then p_total_tokens end,
         cached_input_tokens  = case when p_cached_input_tokens >= 0 then p_cached_input_tokens end,
         reasoning_tokens     = case when p_reasoning_tokens >= 0 then p_reasoning_tokens end,
         latency_ms           = case when p_latency_ms between 0 and 86400000 then p_latency_ms end
   where id = v_run.id;
  perform ops.pop_event_context(v_context);
  return case when v_valid then 'succeeded' else 'failed' end;
end
$function$;

create or replace function ops.fail_agent_run(
  p_category             text,
  p_code                 text,
  p_response_model       text,
  p_provider_request_id  text,
  p_provider_response_id text,
  p_input_tokens         integer,
  p_output_tokens        integer,
  p_total_tokens         integer,
  p_cached_input_tokens  integer,
  p_reasoning_tokens     integer,
  p_latency_ms           integer
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt  integer := ops.agent_run_lease_attempt();
  v_tenant   uuid := ops.current_tenant_id();
  v_job      uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run      ops.agent_runs;
  v_category text;
  v_status   text;
  v_context  jsonb;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.fail_agent_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.status <> 'running' or v_run.job_attempt is distinct from v_attempt then
    return 'not_running'; -- not running, or started by another attempt: never this attempt's to settle
  end if;

  -- The worker reports a category; the DATABASE decides what it means. A category the
  -- worker may not report, or one nobody defined, is `unknown` — which is
  -- indeterminate, so an unclassified failure can never read as a known one.
  v_category := case
    when p_category in ('configuration', 'authentication', 'rate_limit', 'invalid_request', 'provider_5xx',
                        'invalid_response', 'schema_validation', 'timeout', 'transport', 'cancelled', 'unknown')
      then p_category
    else 'unknown'
  end;
  v_status := ops.agent_run_error_status(v_category);

  v_context := ops.push_event_context('agent-runtime', null, null);
  update ops.agent_runs
     set status               = v_status,
         error_category       = v_category,
         error_code           = case when p_code ~ '^[a-z0-9][a-z0-9_.:-]{0,99}$'
                                      and not (p_code = any (ops.agent_run_reserved_error_codes()))
                                     then p_code end,
         response_model       = case when p_response_model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$' then p_response_model end,
         provider_request_id  = case when p_provider_request_id ~ '^[A-Za-z0-9._:-]{1,200}$' then p_provider_request_id end,
         provider_response_id = case when p_provider_response_id ~ '^[A-Za-z0-9._:-]{1,200}$' then p_provider_response_id end,
         input_tokens         = case when p_input_tokens >= 0 then p_input_tokens end,
         output_tokens        = case when p_output_tokens >= 0 then p_output_tokens end,
         total_tokens         = case when p_total_tokens >= 0 then p_total_tokens end,
         cached_input_tokens  = case when p_cached_input_tokens >= 0 then p_cached_input_tokens end,
         reasoning_tokens     = case when p_reasoning_tokens >= 0 then p_reasoning_tokens end,
         latency_ms           = case when p_latency_ms between 0 and 86400000 then p_latency_ms end
   where id = v_run.id;
  perform ops.pop_event_context(v_context);
  return v_status;
end
$function$;

-- The sweep for runs whose attempt died. Like ops.reap_expired_leases it checks no
-- lease and serves every tenant, and like it, it can only touch work that is already
-- dead:
--   * `running`, and its job no longer holds the live lease of the attempt that
--     started it  -> indeterminate. The call may have happened.
--   * `pending`, and its job already ended -> failed. No call happened.
-- It locks the run AND its job, skipping either when held: a capability holds its job
-- for its whole transaction, so a step in progress is never swept from under it, and a
-- step that starts after a sweep finds its lease judged on the clock again.
create or replace function ops.settle_stale_agent_runs()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_running integer;
  v_pending integer;
begin
  v_context := ops.push_event_context('agent-runtime', null, null);

  with stale as (
    select r.id
      from ops.agent_runs r
      join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
     where r.status = 'running'
       and not (j.status = 'leased' and j.lease_expires_at > clock_timestamp() and j.attempts = r.job_attempt)
     order by r.started_at
     limit 500
       for update of r, j skip locked
  )
  update ops.agent_runs r
     set status = 'indeterminate', error_category = 'interrupted', error_code = 'execution_interrupted'
    from stale s
   where r.id = s.id;
  get diagnostics v_running = row_count;

  with orphaned as (
    select r.id, j.status as job_status
      from ops.agent_runs r
      join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
     where r.status = 'pending'
       and j.status in ('failed', 'succeeded')
     order by r.created_at
     limit 500
       for update of r, j skip locked
  )
  update ops.agent_runs r
     set status = 'failed', error_category = 'job_failed',
         error_code = case when o.job_status = 'failed' then 'job_failed' else 'job_ended_before_start' end
    from orphaned o
   where r.id = o.id;
  get diagnostics v_pending = row_count;

  perform ops.pop_event_context(v_context);
  return v_running + v_pending;
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. Privileges. Deny first; then six worker capabilities and nothing else.
-- ---------------------------------------------------------------------------

revoke all on table ops.agent_runs, ops.execution_stops
  from public, anon, authenticated, service_role, ops_worker;

revoke all on function ops.agent_run_capabilities() from public;
revoke all on function ops.agent_run_status_transitions() from public;
revoke all on function ops.agent_run_transition_allowed(text, text) from public;
revoke all on function ops.agent_run_error_status(text) from public;
revoke all on function ops.agent_run_result_valid(text, jsonb) from public;
revoke all on function ops.derived_event_namespaces() from public;
revoke all on function ops.task_executable_kinds() from public;
revoke all on function ops.execution_stop_lock_key() from public;
revoke all on function ops.agent_run_reserved_error_codes() from public;
revoke all on function ops.guard_execution_stop_insert() from public;
revoke all on function ops.guard_execution_stop_update() from public;
revoke all on function ops.guard_execution_stop_delete() from public;
revoke all on function ops.refuse_execution_stop_truncate() from public;
revoke all on function ops.guard_agent_run_insert() from public;
revoke all on function ops.guard_agent_run_update() from public;
revoke all on function ops.guard_event_insert() from public;
revoke all on function ops.emit_agent_run_event() from public;
revoke all on function ops.active_execution_stop(uuid, uuid, uuid, uuid) from public;
revoke all on function ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid) from public;
revoke all on function ops.clear_execution_stop(uuid, text, text) from public;
revoke all on function ops.request_agent_run(uuid, uuid, uuid, text, text, text, uuid) from public;
revoke all on function ops.request_task_execution(uuid, uuid, text, text, jsonb, text, uuid, uuid) from public;
revoke all on function ops.agent_run_lease_attempt() from public;
revoke all on function ops.claim_agent_run() from public;
revoke all on function ops.refuse_agent_run(text) from public;
revoke all on function ops.start_agent_run(text, text, text, text) from public;
revoke all on function ops.complete_agent_run(jsonb, text, text, text, text, integer, integer, integer, integer, integer, integer) from public;
revoke all on function ops.fail_agent_run(text, text, text, text, text, integer, integer, integer, integer, integer, integer) from public;
revoke all on function ops.settle_stale_agent_runs() from public;

grant execute on function ops.claim_agent_run()                                  to ops_worker;
grant execute on function ops.refuse_agent_run(text)                             to ops_worker;
grant execute on function ops.start_agent_run(text, text, text, text)            to ops_worker;
grant execute on function ops.complete_agent_run(jsonb, text, text, text, text, integer, integer, integer, integer, integer, integer) to ops_worker;
grant execute on function ops.fail_agent_run(text, text, text, text, text, integer, integer, integer, integer, integer, integer)   to ops_worker;
grant execute on function ops.settle_stale_agent_runs()                          to ops_worker;

-- ---------------------------------------------------------------------------
-- 9. Assert the end state. Everything earlier phases promised for ops is re-asserted
--    over the objects this phase adds, and the new surface is pinned by name.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_r   record;
  c_domain_tables constant text[] := array[
    'companies', 'departments', 'agents', 'tasks', 'events', 'task_jobs', 'agent_runs', 'execution_stops'];
  -- Every SECURITY DEFINER function in ops: the Phase 1A/1B set plus the six agent
  -- run capabilities. Nothing an application role can call takes a tenant.
  c_definer constant text[] := array[
    'claim_agent_run', 'complete_agent_run', 'complete_job', 'current_tenant_id', 'enqueue_job',
    'fail_agent_run', 'fail_job', 'lease_job', 'purge_inbound_email_ledger', 'reap_expired_leases',
    'refuse_agent_run', 'resume_lease', 'settle_job_failure', 'settle_stale_agent_runs', 'start_agent_run',
    'worker_heartbeat', 'worker_stopped'];
  -- The complete EXECUTE surface of the application roles in ops, by signature.
  c_surface constant text[] := array[
    'service_role|ops.enqueue_job(uuid, text, jsonb, integer, timestamptz, integer, text)',
    'ops_worker|ops.lease_job(text, integer)',
    'ops_worker|ops.complete_job(uuid)',
    'ops_worker|ops.complete_job(uuid, text)',
    'ops_worker|ops.fail_job(uuid, text, interval)',
    'ops_worker|ops.current_tenant_id()',
    'ops_worker|ops.worker_heartbeat(text, text)',
    'ops_worker|ops.worker_stopped(text)',
    'ops_worker|ops.settle_job_failure(uuid, text, text)',
    'ops_worker|ops.purge_inbound_email_ledger(integer, integer)',
    'ops_worker|ops.resume_lease(text, uuid)',
    'ops_worker|ops.reap_expired_leases()',
    'ops_worker|ops.claim_agent_run()',
    'ops_worker|ops.refuse_agent_run(text)',
    'ops_worker|ops.start_agent_run(text, text, text, text)',
    'ops_worker|ops.complete_agent_run(jsonb, text, text, text, text, integer, integer, integer, integer, integer, integer)',
    'ops_worker|ops.fail_agent_run(text, text, text, text, text, integer, integer, integer, integer, integer, integer)',
    'ops_worker|ops.settle_stale_agent_runs()'];
  c_always_triggers constant text[] := array[
    'companies_guard_update', 'departments_guard_update', 'agents_guard_update',
    'tasks_guard_update', 'events_refuse_update', 'task_jobs_refuse_update',
    'agent_runs_guard_update', 'execution_stops_guard_update', 'execution_stops_guard_delete',
    'execution_stops_refuse_truncate'];
  c_origin_triggers constant text[] := array[
    'agent_runs_guard_insert', 'agent_runs_emit_requested', 'agent_runs_emit_changed',
    'execution_stops_guard_insert', 'events_guard_insert'];
  c_composite_fkeys constant text[] := array[
    'agent_runs_company_fkey', 'agent_runs_task_fkey', 'agent_runs_agent_fkey', 'agent_runs_job_fkey',
    'agent_runs_retry_fkey', 'execution_stops_company_fkey', 'execution_stops_department_fkey',
    'execution_stops_agent_fkey'];
begin
  -- 1. The worker role still carries no blanket capability.
  select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
    into v_r from pg_roles where rolname = 'ops_worker';
  if v_r is null then raise exception 'ops_worker is missing'; end if;
  if v_r.rolsuper or v_r.rolbypassrls or v_r.rolcreaterole or v_r.rolcreatedb or v_r.rolcanlogin then
    raise exception 'ops_worker carries a blanket capability';
  end if;

  -- 2. ENABLE + FORCE row level security on every ops table.
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'ops table(s) % lack ENABLE + FORCE row level security', v_bad;
  end if;

  -- 3. No application role holds ANY privilege on a Company OS table, agent runs and
  --    execution stops included.
  select string_agg(format('%s:%s:%s', r.rolname, t.relname, p.priv), ', ') into v_bad
    from unnest(c_domain_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r (rolname)
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where has_table_privilege(r.rolname, format('ops.%I', t.relname), p.priv);
  if v_bad is not null then
    raise exception 'Company OS tables are reachable by an application role: %', v_bad;
  end if;

  -- 4. The worker holds no write verb anywhere in ops.
  select string_agg(format('%s:%s', c.relname, p.priv), ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where n.nspname = 'ops' and c.relkind = 'r'
     and has_table_privilege('ops_worker', c.oid, p.priv);
  if v_bad is not null then
    raise exception 'ops_worker holds write privileges in ops: %', v_bad;
  end if;

  -- 5. anon and authenticated cannot reach the schema at all.
  foreach v_bad in array array['anon', 'authenticated'] loop
    if has_schema_privilege(v_bad, 'ops', 'USAGE') then
      raise exception 'role % can reach schema ops', v_bad;
    end if;
  end loop;

  -- 6. Every ops policy still routes through the one lease-bound helper.
  select string_agg(p.polname, ', ') into v_bad
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops'
     and pg_get_expr(p.polqual, p.polrelid) not like '%current_tenant_id()%';
  if v_bad is not null then
    raise exception 'ops polic(ies) % do not read ops.current_tenant_id()', v_bad;
  end if;

  -- 7. No function in ops is callable by PUBLIC.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'ops function(s) executable by PUBLIC: %', v_bad;
  end if;

  -- 8. The SECURITY DEFINER surface is exactly the pinned set, in both directions.
  select string_agg(x, ', ') into v_bad from (
    (select distinct p.proname as x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ops' and p.prosecdef and not (p.proname = any (c_definer)))
    union all
    (select d.name from unnest(c_definer) as d (name)
      where not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'ops' and p.prosecdef and p.proname = d.name))
  ) drift;
  if v_bad is not null then
    raise exception 'the SECURITY DEFINER surface in ops drifted from the pinned set: %', v_bad;
  end if;

  -- 9. A function that takes an explicit tenant is callable by the owner only, with
  --    the one Phase 1A exception.
  select string_agg(format('%s:%s', r.rolname, p.oid::regprocedure), ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r (rolname)
   where n.nspname = 'ops'
     and 'p_tenant_id' = any (p.proargnames)
     and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'service_role' and p.proname = 'enqueue_job');
  if v_bad is not null then
    raise exception 'explicit-tenant ops function(s) callable by an application role: %', v_bad;
  end if;

  -- 10. The complete EXECUTE surface of the application roles, pinned by signature.
  select string_agg(d, ', ') into v_bad from (
    (select 'unexpected ' || r.rolname || ':' || p.oid::regprocedure::text as d
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r (rolname)
      where n.nspname = 'ops' and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
        and not exists (
          select 1 from unnest(c_surface) as s (entry)
           where split_part(s.entry, '|', 1) = r.rolname
             and split_part(s.entry, '|', 2)::regprocedure = p.oid))
    union all
    (select 'missing ' || s.entry
       from unnest(c_surface) as s (entry)
      where not has_function_privilege(split_part(s.entry, '|', 1),
                                       split_part(s.entry, '|', 2)::regprocedure, 'EXECUTE'))
  ) drift;
  if v_bad is not null then
    raise exception 'the ops EXECUTE surface of the application roles drifted from the pinned set: %', v_bad;
  end if;

  -- 11. Guard triggers exist and survive replica mode; the rest exist in ORIGIN mode.
  select string_agg(g.name, ', ') into v_bad
    from unnest(c_always_triggers) as g (name)
   where not exists (
     select 1 from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and tg.tgname = g.name and tg.tgenabled = 'A');
  if v_bad is not null then
    raise exception 'guard trigger(s) missing or not ENABLE ALWAYS: %', v_bad;
  end if;
  select string_agg(g.name, ', ') into v_bad
    from unnest(c_origin_triggers) as g (name)
   where not exists (
     select 1 from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and tg.tgname = g.name and tg.tgenabled = 'O');
  if v_bad is not null then
    raise exception 'trigger(s) missing or not in ORIGIN mode: %', v_bad;
  end if;

  -- 12. Every composite key that makes a cross-scope run or stop unstorable.
  select string_agg(f.name, ', ') into v_bad
    from unnest(c_composite_fkeys) as f (name)
   where not exists (
     select 1 from pg_constraint k
      join pg_namespace n on n.oid = k.connamespace
     where n.nspname = 'ops' and k.conname = f.name and k.contype = 'f');
  if v_bad is not null then
    raise exception 'composite foreign key(s) missing: %', v_bad;
  end if;

  -- 13. The one executable kind, the reserved namespaces, the one capability.
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'ops.task_executable_kinds() is not exactly {agent_run.execute}';
  end if;
  if not (ops.derived_event_namespaces() @> array['company', 'department', 'agent', 'task', 'job', 'agent_run']::text[]) then
    raise exception 'ops.derived_event_namespaces() lost a reserved lifecycle namespace';
  end if;
  if (select array_agg(c.capability || '=' || c.model_route order by c.capability) from ops.agent_run_capabilities() c)
     is distinct from array['task_assessment=standard']::text[] then
    raise exception 'ops.agent_run_capabilities() drifted from the reviewed set';
  end if;

  -- 14. What a category means is decided in one place and agrees with the table's
  --     constraint for every category.
  select string_agg(c.category, ', ') into v_bad
    from (values
      ('configuration', 'failed'), ('authentication', 'failed'), ('rate_limit', 'failed'),
      ('invalid_request', 'failed'), ('provider_5xx', 'failed'), ('invalid_response', 'failed'),
      ('schema_validation', 'failed'), ('job_failed', 'failed'),
      ('timeout', 'indeterminate'), ('transport', 'indeterminate'), ('cancelled', 'indeterminate'),
      ('unknown', 'indeterminate'), ('interrupted', 'indeterminate'),
      ('refused', 'cancelled')) as c (category, status)
   where ops.agent_run_error_status(c.category) is distinct from c.status;
  if v_bad is not null then
    raise exception 'agent run error categories map to the wrong status: %', v_bad;
  end if;
  if (select count(*) from ops.agent_run_status_transitions()) <> 6 then
    raise exception 'the agent run state machine drifted from its six declared edges';
  end if;
end
$$;
