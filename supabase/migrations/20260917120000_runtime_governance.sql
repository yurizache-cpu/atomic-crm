-- Phase 1D.1 — runtime governance: versioned prices, bounded spend, one kill switch
-- for every external job, and idempotent domain creates.
--
--   ops.model_prices ──┐                      ops.spend_limits
--                      │ price chosen at start      │ daily limits, checked under lock
--                      ▼                            ▼
--   ops.agent_runs ── reserved / estimated / charged cost, derived by the database
--        │
--        └── ops.jobs ── held at the lease, and before every external call, by
--                        ops.execution_stops (the one kill switch)
--
-- WHY (docs/adr/0017-runtime-governance.md). Phase 1D recorded usage and no cost,
-- and its kill switch covered agent runs only. Before a real business flow is
-- connected, four gaps close here:
--   1. COST. A run's spend is derived by the database from its usage and an
--      immutable, versioned price recorded by an owner act. No migration ships a
--      price; a missing or expired price refuses the run before any call.
--   2. SPEND. A global daily ceiling and a tenant daily budget (and optionally a
--      company one) must be configured, and must absorb a run's worst-case
--      reservation, before its start commits. The check runs under per-scope
--      locks, so two starts racing at a limit cannot both admit on a stale total.
--      An unknown outcome stays charged at its reservation. Reaching the global
--      ceiling trips the existing kill switch.
--   3. STOPS. The same switch now holds queued jobs of every external kind at the
--      lease, without consuming an attempt, can name one external kind, and is
--      checked by the runtime before any external call. There is still one switch
--      and one evaluator.
--   4. RETRIES. ops.create_task and ops.record_event take an optional tenant-scoped
--      idempotency key, with a fingerprint the database derives.
--
-- Forward only. No earlier migration is edited; this file re-asserts the whole ops
-- end state it leaves behind.

-- ---------------------------------------------------------------------------
-- 0. Preflight. Runs that started before this migration have no price and no
--    charge, and the new coherence constraints would refuse them. No hosted project
--    has run the agent runtime, so this can only be a development database.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from ops.agent_runs r where r.started_at is not null) then
    raise exception 'ops.agent_runs holds runs started before runtime governance existed; reset the local database before applying 20260917120000_runtime_governance';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Engine vocabulary. Code, reviewed like the task allowlist: the same for every
--    tenant. Prices and limits are NOT here; they are owner data.
-- ---------------------------------------------------------------------------

-- Every job kind is classified, and the classification is total. EXTERNAL kinds act
-- outside the database and are always external_call handlers; INTERNAL kinds are
-- database maintenance and are always transactional. The kill switch holds every
-- queued kind that is NOT internal, so a kind nobody classified is held, never
-- leased past a stop. engine/worker/jobKinds.ts mirrors both sets, the worker refuses
-- a registry that disagrees with them, and a driver-backed test asserts equality.
create or replace function ops.external_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['agent_run.execute']::text[];
$function$;

create or replace function ops.internal_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['postmark.ledger_retention']::text[];
$function$;

-- The kill switch and spend admission both rely on READ COMMITTED: a statement that
-- runs after a lock wait takes a fresh snapshot and sees what the lock serialised. A
-- changed default isolation level would make both admit on a stale read, so they
-- refuse to run under any other level.
create or replace function ops.require_read_committed(p_caller text)
returns void
language plpgsql
stable
set search_path to ''
as $function$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using
      errcode = 'OS400',
      message = format('%s: runs only under READ COMMITTED, because it reads what a lock serialised', p_caller);
  end if;
end
$function$;

-- The output-token ceiling of each model route. engine/models/router.ts
-- (MODEL_ROUTE_POLICIES) mirrors it and a driver-backed test asserts equality. The
-- start refuses a worker that reports a different ceiling, so the reservation
-- below always bounds what the request may generate.
create or replace function ops.agent_run_route_policies()
returns table (model_route text, max_output_tokens integer)
language sql
immutable
set search_path to ''
as $function$
  select * from (values
    ('economy', 2000),
    ('standard', 8000),
    ('reasoning', 25000)
  ) as p (model_route, max_output_tokens);
$function$;

-- An upper bound on the input tokens of a run's request, from the context the
-- database hands the worker. A byte-level tokenizer never emits more tokens than
-- the text has UTF-8 bytes. The context is counted as jsonb text (which escapes at
-- least as much as JSON.stringify and adds spaces), with the agent's name and role
-- counted again because the instructions quote them, plus a fixed allowance for the
-- instructions, the output schema and message framing. A driver-backed test proves
-- the worker's real request stays under it.
create or replace function ops.agent_run_input_token_ceiling(p_context jsonb)
returns integer
language sql
immutable
set search_path to ''
as $function$
  select (octet_length(coalesce(p_context, '{}'::jsonb)::text)
        + coalesce(octet_length((p_context #> '{agent,name}')::text), 0)
        + coalesce(octet_length((p_context #> '{agent,role}')::text), 0)
        + 8192)::integer;
$function$;

-- Error codes only the database records. Phase 1D's five, plus the governance
-- refusals: a worker must not make its own failure read as a budget or price
-- decision, and budget_exhausted is tied to a limit by a constraint.
create or replace function ops.agent_run_reserved_error_codes()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['execution_stopped', 'execution_interrupted', 'database_contract',
               'job_failed', 'job_ended_before_start',
               'price_unavailable', 'route_policy_mismatch', 'spend_ceiling_unconfigured',
               'budget_unconfigured', 'budget_exhausted']::text[];
$function$;

-- The advisory-lock namespace of spend admission, kept apart from the kill-switch
-- lock (which uses the one-key form). A key collision inside the namespace only
-- serialises two scopes that need not be; it never lets two admissions overlap.
create or replace function ops.spend_lock_namespace()
returns integer
language sql
immutable
set search_path to ''
as $function$
  select hashtext('ops.spend_limits');
$function$;

create or replace function ops.spend_lock_key(p_scope text, p_tenant_id uuid, p_company_id uuid)
returns integer
language sql
immutable
set search_path to ''
as $function$
  select hashtext(concat_ws(':', p_scope, coalesce(p_tenant_id::text, '-'), coalesce(p_company_id::text, '-')));
$function$;

-- Whether one stop covers a piece of work. The ONE predicate: the evaluator, the
-- lease filter and the agent run guard all use it. Tenant and kind are always known.
-- A company, department or agent the work does NOT know (NULL) fails closed: a stop
-- on that coordinate covers the work whenever every coordinate the work does know
-- matches. An agent run knows all four, so for it this is exact matching.
create or replace function ops.execution_stop_covers(
  p_scope          text,
  p_stop_tenant    uuid,
  p_stop_company   uuid,
  p_stop_department uuid,
  p_stop_agent     uuid,
  p_stop_job_kind  text,
  p_tenant_id      uuid,
  p_job_kind       text,
  p_company_id     uuid,
  p_department_id  uuid,
  p_agent_id       uuid
)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(case p_scope
    when 'global'     then true
    when 'tenant'     then p_stop_tenant = p_tenant_id
    when 'job_kind'   then p_stop_job_kind = p_job_kind
                           and (p_stop_tenant is null or p_stop_tenant = p_tenant_id)
    when 'company'    then p_stop_tenant = p_tenant_id
                           and (p_company_id is null or p_stop_company = p_company_id)
    when 'department' then p_stop_tenant = p_tenant_id
                           and (p_company_id is null or p_stop_company = p_company_id)
                           and (p_department_id is null or p_stop_department = p_department_id)
    when 'agent'      then p_stop_tenant = p_tenant_id
                           and (p_company_id is null or p_stop_company = p_company_id)
                           and (p_agent_id is null or p_stop_agent = p_agent_id)
  end, false);
$function$;

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------

-- A price VERSION: what one provider charged for one model from a moment on, as an
-- owner read it from a source. Immutable once recorded; a correction is a new
-- version. It expires, so a price nobody re-confirmed stops being used instead of
-- silently pricing runs. Global data with no tenant, like ops.execution_stops.
create table if not exists ops.model_prices (
  id                         uuid primary key default gen_random_uuid(),
  provider                   text not null,
  model                      text not null,
  -- USD per one million tokens.
  input_usd_per_mtok         numeric(14, 6) not null,
  -- NULL: no reliable cached rate was recorded, so cached input is billed in full.
  cached_input_usd_per_mtok  numeric(14, 6),
  output_usd_per_mtok        numeric(14, 6) not null,
  -- Whether the provider's reported reasoning tokens are already inside its output
  -- tokens (true for the OpenAI Responses API). When false they are billed on top.
  reasoning_in_output        boolean not null,
  effective_from             timestamptz not null,
  expires_at                 timestamptz not null,
  source                     text not null,
  recorded_by                text not null,
  recorded_at                timestamptz not null default now(),
  constraint model_prices_provider_format check (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint model_prices_model_format check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  constraint model_prices_rates_non_negative check (
    input_usd_per_mtok >= 0 and output_usd_per_mtok >= 0
    and (cached_input_usd_per_mtok is null
         or (cached_input_usd_per_mtok >= 0 and cached_input_usd_per_mtok <= input_usd_per_mtok))),
  constraint model_prices_validity check (
    expires_at > effective_from and expires_at <= effective_from + interval '366 days'),
  constraint model_prices_source_length check (char_length(btrim(source)) between 1 and 500),
  constraint model_prices_recorded_by_format check (recorded_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint model_prices_version_key unique (provider, model, effective_from)
);

comment on table ops.model_prices is
  'Versioned model prices, recorded by an owner act and never shipped by a migration. A run is priced by the version with the latest effective_from at its start; an expired version is never used and nothing falls back to an older one. Immutable once recorded.';

-- A daily spend limit VERSION. `global` is ADR 0010''s daily spend ceiling; `tenant`
-- is a tenant''s daily budget; `company` is an optional organisational limit (not an
-- isolation boundary). One active version per target; a new value supersedes the
-- active one, and ending a version is recorded on it.
create table if not exists ops.spend_limits (
  id                  uuid primary key default gen_random_uuid(),
  scope               text not null,
  tenant_id           uuid references ops.tenants (id) on delete restrict,
  company_id          uuid,
  -- micro-USD per day, from local midnight in `timezone`.
  daily_limit_micros  bigint not null,
  timezone            text not null,
  reason              text not null,
  set_by              text not null,
  set_at              timestamptz not null default now(),
  ended_at            timestamptz,
  ended_by            text,
  end_reason          text,
  constraint spend_limits_scope_check check (scope in ('global', 'tenant', 'company')),
  constraint spend_limits_scope_shape check (
       (scope = 'global'  and tenant_id is null     and company_id is null)
    or (scope = 'tenant'  and tenant_id is not null and company_id is null)
    or (scope = 'company' and tenant_id is not null and company_id is not null)),
  constraint spend_limits_amount_range check (daily_limit_micros between 0 and 1000000000000000),
  constraint spend_limits_timezone_format check (timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$'),
  constraint spend_limits_reason_length check (char_length(btrim(reason)) between 1 and 500),
  constraint spend_limits_set_by_format check (set_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint spend_limits_ended_whole check (
    (ended_at is null) = (ended_by is null) and (ended_at is null) = (end_reason is null)),
  constraint spend_limits_ended_by_format check (ended_by is null or ended_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint spend_limits_end_reason_length check (
    end_reason is null or char_length(btrim(end_reason)) between 1 and 500),
  constraint spend_limits_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict
);

comment on table ops.spend_limits is
  'Versioned daily spend limits (global ceiling, tenant budget, optional company limit). An agent run starts only when the global and tenant limits exist and every applicable limit can absorb its reservation. Changed only by an owner act; a version is ended, never rewritten except by redaction. Do not put personal data in a reason.';

create unique index if not exists spend_limits_active_target_key
  on ops.spend_limits (scope, tenant_id, company_id) nulls not distinct
  where ended_at is null;

-- Cost columns on the run. Every one is derived by the database (section 4).
alter table ops.agent_runs
  add column if not exists price_id              uuid,
  add column if not exists reserved_cost_micros  bigint,
  add column if not exists estimated_cost_micros bigint,
  add column if not exists charged_cost_micros   bigint,
  add column if not exists spend_limit_id        uuid;

alter table ops.agent_runs drop constraint if exists agent_runs_price_fkey;
alter table ops.agent_runs add constraint agent_runs_price_fkey
  foreign key (price_id) references ops.model_prices (id) on delete restrict;
alter table ops.agent_runs drop constraint if exists agent_runs_spend_limit_fkey;
alter table ops.agent_runs add constraint agent_runs_spend_limit_fkey
  foreign key (spend_limit_id) references ops.spend_limits (id) on delete restrict;

alter table ops.agent_runs drop constraint if exists agent_runs_costs_non_negative;
alter table ops.agent_runs add constraint agent_runs_costs_non_negative check (
      coalesce(reserved_cost_micros, 0) >= 0 and coalesce(estimated_cost_micros, 0) >= 0
  and coalesce(charged_cost_micros, 0) >= 0);
-- A started run has a price, a reservation and a charge; a run that never started
-- has none of them.
alter table ops.agent_runs drop constraint if exists agent_runs_cost_iff_started;
alter table ops.agent_runs add constraint agent_runs_cost_iff_started check (
      (started_at is not null) = (price_id is not null)
  and (started_at is not null) = (reserved_cost_micros is not null)
  and (started_at is not null) = (charged_cost_micros is not null));
alter table ops.agent_runs drop constraint if exists agent_runs_estimate_only_when_finished;
alter table ops.agent_runs add constraint agent_runs_estimate_only_when_finished check (
  estimated_cost_micros is null or status in ('succeeded', 'failed', 'indeterminate'));
alter table ops.agent_runs drop constraint if exists agent_runs_limit_iff_budget_refusal;
alter table ops.agent_runs add constraint agent_runs_limit_iff_budget_refusal check (
  (spend_limit_id is not null) = (error_code is not distinct from 'budget_exhausted'));

-- The day's total for a tenant or a company, and for everyone, read without the heap.
create index if not exists agent_runs_spend_tenant_idx
  on ops.agent_runs (tenant_id, started_at) include (company_id, charged_cost_micros)
  where started_at is not null;
create index if not exists agent_runs_spend_global_idx
  on ops.agent_runs (started_at) include (charged_cost_micros)
  where started_at is not null;
create index if not exists agent_runs_spend_limit_idx
  on ops.agent_runs (spend_limit_id, completed_at)
  where spend_limit_id is not null;

-- The kill switch gains one scope: every job of one external kind, for one tenant
-- or for all (ADR 0010's integration scope, in its generic form).
alter table ops.execution_stops add column if not exists job_kind text;

-- Who tripped a stop is part of what makes it distinct. A stop the spend ceiling
-- tripped and an owner's incident stop on the same target are two rows, so clearing
-- one never clears the other, and an owner's trip is never absorbed by a system one.
alter table ops.execution_stops add column if not exists origin text
  generated always as (case when tripped_by like 'system:%' then 'system' else 'owner' end) stored;

alter table ops.execution_stops drop constraint if exists execution_stops_scope_check;
alter table ops.execution_stops add constraint execution_stops_scope_check check (
  scope in ('global', 'tenant', 'company', 'department', 'agent', 'job_kind'));
alter table ops.execution_stops drop constraint if exists execution_stops_scope_shape;
alter table ops.execution_stops add constraint execution_stops_scope_shape check (
     (scope = 'global'     and tenant_id is null     and company_id is null     and department_id is null     and agent_id is null     and job_kind is null)
  or (scope = 'tenant'     and tenant_id is not null and company_id is null     and department_id is null     and agent_id is null     and job_kind is null)
  or (scope = 'company'    and tenant_id is not null and company_id is not null and department_id is null     and agent_id is null     and job_kind is null)
  or (scope = 'department' and tenant_id is not null and company_id is not null and department_id is not null and agent_id is null     and job_kind is null)
  or (scope = 'agent'      and tenant_id is not null and company_id is not null and department_id is null     and agent_id is not null and job_kind is null)
  or (scope = 'job_kind'                             and company_id is null     and department_id is null     and agent_id is null     and job_kind is not null));
alter table ops.execution_stops drop constraint if exists execution_stops_job_kind_format;
alter table ops.execution_stops add constraint execution_stops_job_kind_format check (
  job_kind is null or (job_kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(job_kind) <= 100));

drop index if exists ops.execution_stops_active_target_key;
create unique index if not exists execution_stops_active_target_key
  on ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id, job_kind, origin) nulls not distinct
  where cleared_at is null;

-- A job released by a stop is recorded as `deferred`.
alter table ops.job_events drop constraint if exists job_events_event_check;
alter table ops.job_events add constraint job_events_event_check check (
  event in ('enqueued', 'leased', 'succeeded', 'failed', 'retry', 'reaped', 'deferred'));

-- Idempotent domain creates. The key is caller data scoped to the tenant; the
-- fingerprint is derived by the database from the stored row (section 3).
alter table ops.tasks
  add column if not exists idempotency_key     text,
  add column if not exists request_fingerprint text;
alter table ops.tasks drop constraint if exists tasks_idempotency_key_format;
alter table ops.tasks add constraint tasks_idempotency_key_format check (
  idempotency_key is null or idempotency_key ~ '^[\x21-\x7e]{1,200}$');
alter table ops.tasks drop constraint if exists tasks_request_fingerprint_iff_key;
alter table ops.tasks add constraint tasks_request_fingerprint_iff_key check (
      (idempotency_key is null) = (request_fingerprint is null)
  and (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'));
create unique index if not exists tasks_idempotency_key
  on ops.tasks (tenant_id, idempotency_key)
  where idempotency_key is not null;

alter table ops.events
  add column if not exists idempotency_key     text,
  add column if not exists request_fingerprint text;
alter table ops.events drop constraint if exists events_idempotency_key_format;
alter table ops.events add constraint events_idempotency_key_format check (
  idempotency_key is null or idempotency_key ~ '^[\x21-\x7e]{1,200}$');
alter table ops.events drop constraint if exists events_request_fingerprint_iff_key;
alter table ops.events add constraint events_request_fingerprint_iff_key check (
      (idempotency_key is null) = (request_fingerprint is null)
  and (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'));
create unique index if not exists events_idempotency_key
  on ops.events (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 3. Row level security, and the guards. ENABLE and FORCE on both new tables, with
--    NO policy: neither is tenant data a worker reads, and a tenant policy on a
--    global row could only hide it. Guards are SECURITY INVOKER: they confer nothing.
-- ---------------------------------------------------------------------------

alter table ops.model_prices enable row level security;
alter table ops.model_prices force  row level security;
alter table ops.spend_limits enable row level security;
alter table ops.spend_limits force  row level security;

create or replace function ops.guard_model_price_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- The database's clock: a recording cannot be backdated.
  new.recorded_at := now();
  return new;
end
$function$;

create or replace function ops.refuse_model_price_change()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'OS409',
    message = 'ops.model_prices: a price version is never rewritten or truncated; record a new version instead';
end
$function$;

create or replace function ops.guard_spend_limit_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.ended_at is not null or new.ended_by is not null or new.end_reason is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.spend_limits: a limit is born active; ending it is a separate, recorded act';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception using
      errcode = 'OS400',
      message = format('ops.spend_limits: %L is not a time zone this database knows', new.timezone);
  end if;
  new.set_at := now();
  return new;
end
$function$;

-- A limit changes in exactly two ways: it is ended once, with who and why; or its
-- free text is replaced by the redaction marker.
create or replace function ops.guard_spend_limit_update()
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
     or new.daily_limit_micros is distinct from old.daily_limit_micros
     or new.timezone is distinct from old.timezone
     or new.set_by is distinct from old.set_by
     or new.set_at is distinct from old.set_at then
    raise exception using
      errcode = 'OS409',
      message = 'ops.spend_limits: a limit version is never rewritten; set a new version instead';
  end if;

  if old.ended_at is null and new.ended_by is not null then
    if new.reason is distinct from old.reason then
      raise exception using
        errcode = 'OS409',
        message = 'ops.spend_limits: ending a limit does not rewrite why it was set';
    end if;
    new.ended_at := now();
    return new;
  end if;

  if new.ended_by is distinct from old.ended_by or new.ended_at is distinct from old.ended_at then
    raise exception using
      errcode = 'OS409',
      message = format('ops.spend_limits: limit %s is ended once, with who and why, and an ended limit is history', old.id);
  end if;
  if new.reason is not distinct from old.reason and new.end_reason is not distinct from old.end_reason then
    raise exception using
      errcode = 'OS409',
      message = 'ops.spend_limits: the only updates to a limit are its ending and the redaction of its free text';
  end if;
  if (new.reason is distinct from old.reason and new.reason <> '[redacted]')
     or (new.end_reason is distinct from old.end_reason and new.end_reason is distinct from '[redacted]') then
    raise exception using
      errcode = 'OS409',
      message = 'ops.spend_limits: free text is never rewritten, only replaced by [redacted]';
  end if;
  return new;
end
$function$;

create or replace function ops.guard_spend_limit_delete()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.ended_at is null then
    raise exception using
      errcode = 'OS409',
      message = format('ops.spend_limits: limit %s is active; it is ended, with who and why, before it can be deleted', old.id);
  end if;
  return old;
end
$function$;

create or replace function ops.refuse_spend_limit_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'OS409',
    message = 'ops.spend_limits is never truncated: an active limit is removed only by ending it';
end
$function$;

-- The Phase 1D insert guard, plus the rule ops.trip_execution_stop applies, now on
-- every write path: a job_kind stop names an external kind, so a stop can never
-- look active while holding nothing.
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
  if new.scope = 'job_kind' and not (new.job_kind = any (ops.external_job_kinds())) then
    raise exception using
      errcode = 'OS400',
      message = format('ops.execution_stops: %L is not an external job kind, so a stop on it would hold nothing', new.job_kind);
  end if;
  new.tripped_at := now();
  return new;
end
$function$;

-- The stop guard, with job_kind fixed like every other coordinate. Otherwise the
-- Phase 1D body unchanged (20260914120000, section 3).
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
     or new.job_kind is distinct from old.job_kind
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

-- The semantic request of a create, as sha256 of a JSON array: an unambiguous
-- encoding, so a '|' in a title cannot make two requests collide, and the due date
-- as epoch seconds, so the session time zone cannot change it.
create or replace function ops.task_request_fingerprint(
  p_company_id     uuid,
  p_department_id  uuid,
  p_parent_task_id uuid,
  p_type           text,
  p_title          text,
  p_description    text,
  p_priority       integer,
  p_due_at         timestamptz
)
returns text
language sql
stable
set search_path to ''
as $function$
  select encode(sha256(convert_to(jsonb_build_array(
    'task.create.v1', p_company_id, p_department_id, p_parent_task_id, p_type, p_title,
    p_description, p_priority, extract(epoch from p_due_at))::text, 'UTF8')), 'hex');
$function$;

create or replace function ops.event_request_fingerprint(
  p_company_id   uuid,
  p_type         text,
  p_source       text,
  p_subject_type text,
  p_subject_id   uuid,
  p_payload      jsonb,
  p_causation_id uuid
)
returns text
language sql
stable
set search_path to ''
as $function$
  select encode(sha256(convert_to(jsonb_build_array(
    'event.record.v1', p_company_id, p_type, p_source, p_subject_type, p_subject_id,
    coalesce(p_payload, '{}'::jsonb), p_causation_id)::text, 'UTF8')), 'hex');
$function$;

-- Derived, never taken from the caller: whatever fingerprint an insert carries is
-- replaced by the one the stored row implies.
create or replace function ops.derive_task_request_identity()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  new.request_fingerprint := case when new.idempotency_key is not null then
    ops.task_request_fingerprint(new.company_id, new.department_id, new.parent_task_id, new.type,
                                 new.title, new.description, new.priority, new.due_at) end;
  return new;
end
$function$;

create or replace function ops.derive_event_request_identity()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  new.request_fingerprint := case when new.idempotency_key is not null then
    ops.event_request_fingerprint(new.company_id, new.type, new.source, new.subject_type,
                                  new.subject_id, new.payload, new.causation_id) end;
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
  if new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint then
    raise exception using
      errcode = 'OS409',
      message = 'ops.tasks: the idempotency key and request fingerprint are fixed at creation';
  end if;
  return new;
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. Evaluators and accounting helpers. None is granted to any role.
-- ---------------------------------------------------------------------------

-- The stop that covers a piece of work, if any. Deny wins; the order only decides
-- which stop is recorded. A switch that cannot be read refuses.
create or replace function ops.covering_execution_stop(
  p_tenant_id     uuid,
  p_job_kind      text,
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
  if p_tenant_id is null or p_job_kind is null then
    raise exception using
      errcode = 'OS400',
      message = 'ops.covering_execution_stop: work has a tenant and a kind; without both the switch cannot be read, and an unreadable switch refuses';
  end if;
  if row_security_active('ops.execution_stops') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.covering_execution_stop: row security would hide the stops from this caller, and a switch that cannot be read refuses';
  end if;

  select s.id into v_stop
    from ops.execution_stops s
   where s.cleared_at is null
     and ops.execution_stop_covers(s.scope, s.tenant_id, s.company_id, s.department_id, s.agent_id, s.job_kind,
                                   p_tenant_id, p_job_kind, p_company_id, p_department_id, p_agent_id)
   order by case
              when s.scope = 'global' then 0
              when s.scope = 'job_kind' and s.tenant_id is null then 1
              when s.scope = 'tenant' then 2
              when s.scope = 'job_kind' then 3
              when s.scope = 'company' then 4
              when s.scope = 'department' then 5
              else 6
            end,
            s.tripped_at
   limit 1;

  return v_stop;
end
$function$;

-- The Phase 1D reader, unchanged in contract: an agent run has all four
-- coordinates, and its kind is the agent run kind.
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
  return ops.covering_execution_stop(p_tenant_id, 'agent_run.execute', p_company_id, p_department_id, p_agent_id);
end
$function$;

-- The stop that covers one job. Its organisational coordinates are only ones fixed
-- when the job was requested: an agent run's company, department and agent, or the
-- company of the task that requested it. Nothing is read from a task's current
-- department or assignee, which can change. Every coordinate a job does not have is
-- unknown, and unknown fails closed (ops.execution_stop_covers).
create or replace function ops.job_covering_stop(p_tenant_id uuid, p_job_id uuid, p_job_kind text)
returns uuid
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_company    uuid;
  v_department uuid;
  v_agent      uuid;
begin
  if p_job_kind = any (ops.internal_job_kinds()) then
    return null; -- administration stays up: the switch never holds maintenance
  end if;
  select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.job_id = p_job_id;
  if not found then
    select l.company_id into v_company
      from ops.task_jobs l
     where l.tenant_id = p_tenant_id and l.job_id = p_job_id;
  end if;
  return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
end
$function$;

-- The price version that applies at a moment, or NULL. The latest effective version
-- is the only candidate: if it has expired, there is no price, and nothing falls
-- back to an older one.
create or replace function ops.current_model_price(p_provider text, p_model text, p_at timestamptz)
returns uuid
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_id      uuid;
  v_expires timestamptz;
begin
  if row_security_active('ops.model_prices') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.current_model_price: row security would hide the prices from this caller';
  end if;
  select p.id, p.expires_at into v_id, v_expires
    from ops.model_prices p
   where p.provider = p_provider and p.model = p_model and p.effective_from <= p_at
   order by p.effective_from desc
   limit 1;
  if v_id is null or v_expires <= p_at then
    return null;
  end if;
  return v_id;
end
$function$;

-- The worst case one run may cost: its input ceiling at the input rate (cached input
-- is never assumed), plus its output ceiling at the output rate, counted twice when
-- reasoning is billed on top of output. Rounded up to a whole micro-USD.
create or replace function ops.agent_run_reservation_micros(
  p_price_id          uuid,
  p_input_tokens      integer,
  p_max_output_tokens integer
)
returns bigint
language sql
stable
set search_path to ''
as $function$
  select ceil(p_input_tokens::numeric * p.input_usd_per_mtok
            + p_max_output_tokens::numeric * (case when p.reasoning_in_output then 1 else 2 end)
              * p.output_usd_per_mtok)::bigint
    from ops.model_prices p
   where p.id = p_price_id;
$function$;

-- The reservation of one run under one price version: its input ceiling, from the
-- task and agent rows the claim returned (and share-locked for the prepare
-- transaction), and its route's output ceiling. ops.start_agent_run admits with it
-- and records it; the worker never supplies it. NULL when the task, agent or route
-- is not found.
create or replace function ops.agent_run_reservation_for(
  p_tenant_id   uuid,
  p_company_id  uuid,
  p_task_id     uuid,
  p_agent_id    uuid,
  p_model_route text,
  p_price_id    uuid
)
returns bigint
language sql
stable
set search_path to ''
as $function$
  select ops.agent_run_reservation_micros(
           p_price_id,
           ops.agent_run_input_token_ceiling(jsonb_build_object(
             'agent', jsonb_build_object('name', a.name, 'role', a.role, 'description', a.description),
             'task', jsonb_build_object(
               'type', t.type, 'title', t.title, 'description', t.description,
               'priority', t.priority, 'due_at', t.due_at))),
           p.max_output_tokens)
    from ops.tasks t
    join ops.agents a
      on a.tenant_id = t.tenant_id and a.company_id = t.company_id and a.id = p_agent_id
    join ops.agent_run_route_policies() p
      on p.model_route = p_model_route
   where t.tenant_id = p_tenant_id and t.company_id = p_company_id and t.id = p_task_id;
$function$;

-- What a finished run is estimated to have cost, from its reported usage and the
-- price version recorded at its start. A token price times a token count is
-- micro-USD, because the rate is USD per million tokens; the sum is rounded up once.
-- NULL unless the usage is complete AND consistent, because a partial or
-- contradictory report is not a cost:
--   * input and output tokens are both known;
--   * cached input is a subset of input;
--   * a reported total is at least input plus output;
--   * reasoning is a subset of output when the version says it is inside output,
--     and is known when the version bills it on top.
create or replace function ops.agent_run_estimated_cost_micros(
  p_price_id            uuid,
  p_input_tokens        integer,
  p_cached_input_tokens integer,
  p_output_tokens       integer,
  p_reasoning_tokens    integer,
  p_total_tokens        integer
)
returns bigint
language sql
stable
set search_path to ''
as $function$
  select case
    when p_input_tokens is null or p_output_tokens is null
      or coalesce(p_cached_input_tokens, 0) > p_input_tokens
      or (p_total_tokens is not null and p_total_tokens::bigint < p_input_tokens::bigint + p_output_tokens)
      or (p.reasoning_in_output and coalesce(p_reasoning_tokens, 0) > p_output_tokens)
      or (not p.reasoning_in_output and p_reasoning_tokens is null)
      then null
    else
      ceil((p_input_tokens - coalesce(p_cached_input_tokens, 0))::numeric * p.input_usd_per_mtok
         + coalesce(p_cached_input_tokens, 0)::numeric
           * coalesce(p.cached_input_usd_per_mtok, p.input_usd_per_mtok)
         + (p_output_tokens::numeric
            + case when p.reasoning_in_output then 0 else p_reasoning_tokens end)
           * p.output_usd_per_mtok)::bigint
  end
    from ops.model_prices p
   where p.id = p_price_id;
$function$;

-- Local midnight of the day containing a moment, in a time zone.
create or replace function ops.spend_window_start(p_timezone text, p_at timestamptz)
returns timestamptz
language sql
stable
set search_path to ''
as $function$
  select (date_trunc('day', p_at at time zone p_timezone)) at time zone p_timezone;
$function$;

-- What runs started since a moment are charged, for everyone, a tenant or a company:
-- in total, and settled (every run that is no longer running). The difference is
-- the reservations of calls still in flight, which will settle at or below them.
-- STABLE: it reads with the snapshot of the statement that calls it, so a caller that
-- took the spend locks in an EARLIER statement sees every admission they serialised.
create or replace function ops.spend_window_total(
  p_scope      text,
  p_tenant_id  uuid,
  p_company_id uuid,
  p_since      timestamptz,
  out p_charged bigint,
  out p_settled bigint
)
language plpgsql
stable
security invoker
set search_path to ''
as $function$
begin
  if row_security_active('ops.agent_runs') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.spend_window_total: row security would hide runs from this caller, and a total that cannot be read refuses';
  end if;
  if p_scope = 'global' then
    select coalesce(sum(r.charged_cost_micros), 0)::bigint,
           coalesce(sum(r.charged_cost_micros) filter (where r.status <> 'running'), 0)::bigint
      into p_charged, p_settled
      from ops.agent_runs r
     where r.started_at >= p_since;
  elsif p_scope = 'tenant' and p_tenant_id is not null then
    select coalesce(sum(r.charged_cost_micros), 0)::bigint,
           coalesce(sum(r.charged_cost_micros) filter (where r.status <> 'running'), 0)::bigint
      into p_charged, p_settled
      from ops.agent_runs r
     where r.tenant_id = p_tenant_id and r.started_at >= p_since;
  elsif p_scope = 'company' and p_tenant_id is not null and p_company_id is not null then
    select coalesce(sum(r.charged_cost_micros), 0)::bigint,
           coalesce(sum(r.charged_cost_micros) filter (where r.status <> 'running'), 0)::bigint
      into p_charged, p_settled
      from ops.agent_runs r
     where r.tenant_id = p_tenant_id and r.company_id = p_company_id and r.started_at >= p_since;
  else
    raise exception using
      errcode = 'OS400',
      message = format('ops.spend_window_total: %L with these coordinates is not a spend scope', p_scope);
  end if;
end
$function$;

-- Whether work of this tenant and company may spend `p_reservation` now.
--   NULL                        admitted: every limit absorbs it, in-flight calls included.
--   spend_ceiling_unconfigured  no active global ceiling.
--   budget_unconfigured         no active tenant budget.
--   budget_exhausted            a limit cannot absorb it even from SETTLED spend alone;
--                               p_limit_id names the first such limit.
--   budget_contended            it fits settled spend, but not with the reservations of
--                               calls still in flight; p_limit_id names the limit. Those
--                               calls settle soon, so the caller should try again later.
-- Limits are checked global, then tenant, then company. With p_lock, the three scope
-- locks are taken first, in that order, each in its own statement, so every total read
-- after them includes every admission they serialised. VOLATILE, so each statement
-- takes a new snapshot. "Today" is computed from now(), the transaction timestamp,
-- which is also the started_at a run admitted here records.
create or replace function ops.spend_admission(
  p_tenant_id   uuid,
  p_company_id  uuid,
  p_reservation bigint,
  p_lock        boolean,
  out p_code     text,
  out p_limit_id uuid
)
language plpgsql
volatile
security invoker
set search_path to ''
as $function$
declare
  v_limit ops.spend_limits;
  v_now   timestamptz := now();
  v_total record;
  v_scope text;
begin
  if p_tenant_id is null or p_company_id is null or p_reservation is null or p_reservation < 0 then
    raise exception using
      errcode = 'OS400',
      message = 'ops.spend_admission: a tenant, a company and a non-negative reservation are required';
  end if;
  perform ops.require_read_committed('ops.spend_admission');
  if row_security_active('ops.spend_limits') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.spend_admission: row security would hide the limits from this caller, and a limit that cannot be read refuses';
  end if;

  if p_lock then
    perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('global', null, null));
    perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('tenant', p_tenant_id, null));
    perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key('company', p_tenant_id, p_company_id));
  end if;

  foreach v_scope in array array['global', 'tenant', 'company'] loop
    select l.* into v_limit
      from ops.spend_limits l
     where l.scope = v_scope
       and l.ended_at is null
       and (v_scope = 'global'
            or (v_scope = 'tenant' and l.tenant_id = p_tenant_id)
            or (v_scope = 'company' and l.tenant_id = p_tenant_id and l.company_id = p_company_id));
    if not found then
      if v_scope = 'global' then
        p_code := 'spend_ceiling_unconfigured';
        p_limit_id := null; -- no limit refused it, and only budget_exhausted names one
        return;
      elsif v_scope = 'tenant' then
        -- An earlier limit may have been contended; a missing budget still wins,
        -- and names no limit.
        p_code := 'budget_unconfigured';
        p_limit_id := null;
        return;
      end if;
      continue; -- a company limit is optional; an earlier contention stands
    end if;

    select t.p_charged, t.p_settled into v_total
      from ops.spend_window_total(
             v_scope,
             case when v_scope = 'global' then null else p_tenant_id end,
             case when v_scope = 'company' then p_company_id end,
             ops.spend_window_start(v_limit.timezone, v_now)) t;
    if v_total.p_settled + p_reservation > v_limit.daily_limit_micros then
      -- Exhaustion anywhere is final for the day, so it wins over contention.
      p_code := 'budget_exhausted';
      p_limit_id := v_limit.id;
      return;
    end if;
    if p_code is null and v_total.p_charged + p_reservation > v_limit.daily_limit_micros then
      p_code := 'budget_contended';
      p_limit_id := v_limit.id;
    end if;
  end loop;
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. The agent run guards, with cost derived on every write path.
-- ---------------------------------------------------------------------------

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
     or new.error_code is not null or new.stop_id is not null
     or new.price_id is not null or new.reserved_cost_micros is not null or new.estimated_cost_micros is not null
     or new.charged_cost_micros is not null or new.spend_limit_id is not null then
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

-- The Phase 1D state machine guard, plus cost. What a run COSTS is never taken from
-- a caller: the reservation is fixed at start with the price version it used, and at
-- the end the estimate and the charge are derived from the run's usage and that
-- version. An unknown outcome stays charged at its reservation.
create or replace function ops.guard_agent_run_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_estimate bigint;
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
       or new.stop_id is distinct from old.stop_id
       or new.price_id is distinct from old.price_id
       or new.reserved_cost_micros is distinct from old.reserved_cost_micros
       or new.estimated_cost_micros is distinct from old.estimated_cost_micros
       or new.charged_cost_micros is distinct from old.charged_cost_micros
       or new.spend_limit_id is distinct from old.spend_limit_id then
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
       or new.estimated_cost_micros is not null or new.charged_cost_micros is not null then
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
          or new.reserved_cost_micros is distinct from old.reserved_cost_micros) then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: what was started, and what it reserved, is fixed once the run is running';
  end if;

  if old.status = 'running' then
    -- Derived from usage and the version recorded at start, status first:
    --   indeterminate  never below the reservation: its usage, even when reported,
    --                  is not proven final.
    --   known answer   the estimate, when the usage is complete and consistent.
    --   refusal        0, only when the stored facts prove no response body arrived:
    --                  a refusal category, no usage, no response id and no response
    --                  model. The provider adapters record a response model for
    --                  every 2xx answer whose body they parse (the requested model
    --                  when the body names none), a response id only when that body
    --                  carries a well-formed one, and neither for an HTTP refusal
    --                  (pinned by the adapter contract tests). A 2xx whose body
    --                  cannot be read or parsed carries neither, but its category
    --                  is unknown, so it is indeterminate and charged at least its
    --                  reservation.
    --   otherwise      the reservation: a billed answer whose cost is unknown.
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
      -- A charge above its reservation means a bound was wrong. Serialise with every
      -- admission first, in the admission lock order, so no start admits on the
      -- lower total this write is about to replace.
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

  -- A run records only an ACTIVE stop that COVERS it, with the one predicate the
  -- switch itself applies.
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

  -- Likewise a run records only an ACTIVE limit that applies to it, and only when
  -- that limit refused it.
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

  -- Derived, never taken from the caller.
  new.started_at := case when new.status = 'running' then now() else old.started_at end;
  new.completed_at := case when new.status in ('succeeded', 'failed', 'indeterminate', 'cancelled') then now() end;
  new.updated_at := now();
  return new;
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. Triggers. Update-path and removal guards ENABLE ALWAYS; insert validation and
--    derivation stay ORIGIN, as in Phases 1C and 1D.
-- ---------------------------------------------------------------------------

drop trigger if exists model_prices_guard_insert on ops.model_prices;
create trigger model_prices_guard_insert
  before insert on ops.model_prices
  for each row execute function ops.guard_model_price_insert();

drop trigger if exists model_prices_refuse_update on ops.model_prices;
create trigger model_prices_refuse_update
  before update on ops.model_prices
  for each row execute function ops.refuse_model_price_change();
alter table ops.model_prices enable always trigger model_prices_refuse_update;

drop trigger if exists model_prices_refuse_truncate on ops.model_prices;
create trigger model_prices_refuse_truncate
  before truncate on ops.model_prices
  for each statement execute function ops.refuse_model_price_change();
alter table ops.model_prices enable always trigger model_prices_refuse_truncate;

drop trigger if exists spend_limits_guard_insert on ops.spend_limits;
create trigger spend_limits_guard_insert
  before insert on ops.spend_limits
  for each row execute function ops.guard_spend_limit_insert();

drop trigger if exists spend_limits_guard_update on ops.spend_limits;
create trigger spend_limits_guard_update
  before update on ops.spend_limits
  for each row execute function ops.guard_spend_limit_update();
alter table ops.spend_limits enable always trigger spend_limits_guard_update;

drop trigger if exists spend_limits_guard_delete on ops.spend_limits;
create trigger spend_limits_guard_delete
  before delete on ops.spend_limits
  for each row execute function ops.guard_spend_limit_delete();
alter table ops.spend_limits enable always trigger spend_limits_guard_delete;

drop trigger if exists spend_limits_refuse_truncate on ops.spend_limits;
create trigger spend_limits_refuse_truncate
  before truncate on ops.spend_limits
  for each statement execute function ops.refuse_spend_limit_truncate();
alter table ops.spend_limits enable always trigger spend_limits_refuse_truncate;

-- Named to sort after tasks_guard_insert / events_guard_insert, so the fingerprint is
-- derived from the row those guards leave.
drop trigger if exists tasks_request_identity_insert on ops.tasks;
create trigger tasks_request_identity_insert
  before insert on ops.tasks
  for each row execute function ops.derive_task_request_identity();

drop trigger if exists tasks_request_identity_update on ops.tasks;
create trigger tasks_request_identity_update
  before update on ops.tasks
  for each row execute function ops.guard_task_request_identity();
alter table ops.tasks enable always trigger tasks_request_identity_update;

drop trigger if exists events_request_identity_insert on ops.events;
create trigger events_request_identity_insert
  before insert on ops.events
  for each row execute function ops.derive_event_request_identity();

-- ---------------------------------------------------------------------------
-- 7. Owner services. SECURITY INVOKER, EXECUTE granted to no role.
-- ---------------------------------------------------------------------------

-- Record one price version. Replaying the same version returns it; a different
-- version under the same (provider, model, effective_from) is refused. A rate with
-- more than six decimals is refused rather than silently rounded.
create or replace function ops.record_model_price(
  p_provider                  text,
  p_model                     text,
  p_input_usd_per_mtok        numeric,
  p_output_usd_per_mtok       numeric,
  p_reasoning_in_output       boolean,
  p_effective_from            timestamptz,
  p_expires_at                timestamptz,
  p_source                    text,
  p_actor                     text,
  p_cached_input_usd_per_mtok numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id       uuid;
  v_existing ops.model_prices;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,31}$'
     or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_model_price: provider and model are required and well formed';
  end if;
  if p_input_usd_per_mtok is null or p_output_usd_per_mtok is null
     or p_input_usd_per_mtok < 0 or p_output_usd_per_mtok < 0
     or p_input_usd_per_mtok > 99999999 or p_output_usd_per_mtok > 99999999
     or p_input_usd_per_mtok <> round(p_input_usd_per_mtok, 6)
     or p_output_usd_per_mtok <> round(p_output_usd_per_mtok, 6)
     or (p_cached_input_usd_per_mtok is not null
         and (p_cached_input_usd_per_mtok < 0 or p_cached_input_usd_per_mtok > p_input_usd_per_mtok
              or p_cached_input_usd_per_mtok <> round(p_cached_input_usd_per_mtok, 6))) then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_model_price: rates are non-negative USD per million tokens with at most six decimals, and a cached rate is at most the input rate';
  end if;
  if p_reasoning_in_output is null then
    raise exception using errcode = 'OS400', message = 'ops.record_model_price: whether reasoning tokens are inside output tokens must be stated';
  end if;
  if p_effective_from is null or p_expires_at is null or p_expires_at <= p_effective_from
     or p_expires_at > p_effective_from + interval '366 days' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_model_price: a price version is effective from a moment and expires after it, within 366 days';
  end if;
  if p_source is null or char_length(btrim(p_source)) not between 1 and 500 then
    raise exception using errcode = 'OS400', message = 'ops.record_model_price: the source of the price is required, at most 500 characters';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_model_price: the actor is missing or malformed';
  end if;

  insert into ops.model_prices (
    provider, model, input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok,
    reasoning_in_output, effective_from, expires_at, source, recorded_by)
  values (
    p_provider, p_model, p_input_usd_per_mtok, p_cached_input_usd_per_mtok, p_output_usd_per_mtok,
    p_reasoning_in_output, p_effective_from, p_expires_at, p_source, p_actor)
  on conflict (provider, model, effective_from) do nothing
  returning id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  select p.* into v_existing
    from ops.model_prices p
   where p.provider = p_provider and p.model = p_model and p.effective_from = p_effective_from;
  if v_existing.input_usd_per_mtok = p_input_usd_per_mtok
     and v_existing.output_usd_per_mtok = p_output_usd_per_mtok
     and v_existing.cached_input_usd_per_mtok is not distinct from p_cached_input_usd_per_mtok
     and v_existing.reasoning_in_output = p_reasoning_in_output
     and v_existing.expires_at = p_expires_at then
    return v_existing.id; -- the same version, already recorded
  end if;
  raise exception using
    errcode = 'OS409',
    message = 'ops.record_model_price: a different price version is already recorded for that model from that moment';
end
$function$;

-- Set the daily limit of one target. The active version is ended and a new one
-- recorded, in one transaction that holds the target's spend lock; the same values
-- again change nothing.
create or replace function ops.set_spend_limit(
  p_scope              text,
  p_daily_limit_micros bigint,
  p_timezone           text,
  p_reason             text,
  p_actor              text,
  p_tenant_id          uuid default null,
  p_company_id         uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_active ops.spend_limits;
  v_id     uuid;
begin
  if p_scope is null or p_scope not in ('global', 'tenant', 'company') then
    raise exception using errcode = 'OS400', message = format('ops.set_spend_limit: %L is not a spend limit scope', p_scope);
  end if;
  if p_scope <> 'global' and p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.set_spend_limit: a tenant or company limit needs its tenant';
  end if;
  if (p_scope = 'global' and (p_tenant_id is not null or p_company_id is not null))
     or (p_scope = 'tenant' and p_company_id is not null)
     or (p_scope = 'company' and p_company_id is null) then
    raise exception using errcode = 'OS400', message = format('ops.set_spend_limit: the target does not match scope %s', p_scope);
  end if;
  if p_daily_limit_micros is null or p_daily_limit_micros not between 0 and 1000000000000000 then
    raise exception using errcode = 'OS400', message = 'ops.set_spend_limit: a daily limit is 0 to 10^15 micro-USD';
  end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_timezone) then
    raise exception using errcode = 'OS400', message = 'ops.set_spend_limit: the time zone is missing or unknown';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = 'OS400', message = 'ops.set_spend_limit: a reason is required, at most 500 characters';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.set_spend_limit: the actor is missing or malformed';
  end if;

  if p_tenant_id is not null then
    perform 1 from ops.tenants t where t.id = p_tenant_id for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.set_spend_limit: tenant not found';
    end if;
  end if;
  if p_company_id is not null then
    perform 1 from ops.companies c where c.id = p_company_id and c.tenant_id = p_tenant_id for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.set_spend_limit: company not found in this tenant';
    end if;
  end if;

  -- Serialised with every admission this limit governs.
  perform pg_advisory_xact_lock(ops.spend_lock_namespace(), ops.spend_lock_key(p_scope, p_tenant_id, p_company_id));

  select l.* into v_active
    from ops.spend_limits l
   where l.scope = p_scope
     and l.tenant_id is not distinct from p_tenant_id
     and l.company_id is not distinct from p_company_id
     and l.ended_at is null
     for update;
  if found then
    if v_active.timezone <> p_timezone then
      -- A new zone would move today's window under spend already counted in the old
      -- one. Changing it is a deliberate retire, then set.
      raise exception using
        errcode = 'OS409',
        message = 'ops.set_spend_limit: a new version keeps the time zone; retire the limit, then set it, to change the zone';
    end if;
    if v_active.daily_limit_micros = p_daily_limit_micros then
      return v_active.id; -- already in force: nothing to change
    end if;
    update ops.spend_limits
       set ended_by = p_actor, end_reason = 'superseded'
     where id = v_active.id;
  end if;

  insert into ops.spend_limits (scope, tenant_id, company_id, daily_limit_micros, timezone, reason, set_by)
  values (p_scope, p_tenant_id, p_company_id, p_daily_limit_micros, p_timezone, p_reason, p_actor)
  returning id into v_id;
  return v_id;
end
$function$;

-- End a limit without replacing it. For the global ceiling or a tenant budget this
-- means that tenant's runs, or every run, are refused until a limit is set again.
create or replace function ops.retire_spend_limit(
  p_limit_id uuid,
  p_reason   text,
  p_actor    text
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_limit ops.spend_limits;
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = 'OS400', message = 'ops.retire_spend_limit: a reason is required, at most 500 characters';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.retire_spend_limit: the actor is missing or malformed';
  end if;
  select l.* into v_limit from ops.spend_limits l where l.id = p_limit_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.retire_spend_limit: limit not found';
  end if;
  perform pg_advisory_xact_lock(ops.spend_lock_namespace(),
                                ops.spend_lock_key(v_limit.scope, v_limit.tenant_id, v_limit.company_id));
  update ops.spend_limits
     set ended_by = p_actor, end_reason = p_reason
   where id = p_limit_id and ended_at is null;
  return found;
end
$function$;

-- The day's spend against every active limit. Owner only: it spans tenants.
--   charged_micros     everything admission counts, calls in flight at their reservation
--   settled_micros     the part that is no longer running
--   remaining_micros   the largest reservation this limit alone admits now (limit - charged)
--   settled_exhausted  settled spend has reached the limit (settled >= limit), never
--                      in-flight reservations. On the global row the ceiling sweep
--                      (ADR 0017 §5) trips when this is true OR refused_runs > 0 (a
--                      budget_exhausted refusal by the version in force today); a
--                      tenant or company limit never trips a stop
--   new_run_admission  what this limit alone does to the next start, never a promise:
--                        blocked      charged spend has reached the limit: no run with a
--                                     reservation above zero is admitted by this limit.
--                                     A run whose reservation settled spend cannot
--                                     absorb (settled + reservation > limit) is refused
--                                     budget_exhausted even when settled_exhausted is
--                                     false, and on the global ceiling such a refusal
--                                     trips the ceiling stop. Any other run is
--                                     contended: its start raises OS429 and its job
--                                     retries on its backoff, which may end in
--                                     admission, in exhaustion, or in job failure after
--                                     the last attempt (five by default)
--                        conditional  a run is admitted by this limit only if its
--                                     reservation fits remaining_micros; the price, every
--                                     other applicable limit and the stops still decide
--                                     the start. It says nothing about a limit that does
--                                     not exist: a missing limit has no row
-- A false settled_exhausted therefore never means a run can start.
-- Nor does it mean the ceiling sweep will not trip (refused_runs, above).
-- p_at is meaningful only for now or a future instant: for an earlier instant the
-- row reports that day's window start, but counts the runs of every later day too.
create or replace function ops.spend_status(p_at timestamptz default now())
returns table (
  limit_id            uuid,
  scope               text,
  tenant_id           uuid,
  company_id          uuid,
  daily_limit_micros  bigint,
  timezone            text,
  window_start        timestamptz,
  charged_micros      bigint,
  settled_micros      bigint,
  estimated_micros    bigint,
  running_runs        bigint,
  unknown_cost_runs   bigint,
  refused_runs        bigint,
  remaining_micros    bigint,
  settled_exhausted   boolean,
  new_run_admission   text
)
language plpgsql
stable
security invoker
set search_path to ''
as $function$
begin
  if row_security_active('ops.agent_runs') or row_security_active('ops.spend_limits') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.spend_status: row security would hide runs or limits from this caller';
  end if;
  return query
  select l.id, l.scope, l.tenant_id, l.company_id, l.daily_limit_micros, l.timezone, w.since,
         coalesce(s.charged, 0)::bigint,
         coalesce(s.settled, 0)::bigint,
         coalesce(s.estimated, 0)::bigint,
         coalesce(s.running, 0)::bigint,
         coalesce(s.unknown, 0)::bigint,
         (select count(*) from ops.agent_runs x
           where x.spend_limit_id = l.id and x.completed_at >= w.since)::bigint,
         (l.daily_limit_micros - coalesce(s.charged, 0))::bigint,
         coalesce(s.settled, 0) >= l.daily_limit_micros,
         case when coalesce(s.charged, 0) >= l.daily_limit_micros then 'blocked' else 'conditional' end
    from ops.spend_limits l
   cross join lateral (select ops.spend_window_start(l.timezone, p_at) as since) w
    left join lateral (
      select sum(r.charged_cost_micros) as charged,
             sum(r.charged_cost_micros) filter (where r.status <> 'running') as settled,
             sum(r.estimated_cost_micros) as estimated,
             count(*) filter (where r.status = 'running') as running,
             count(*) filter (where r.status <> 'running' and r.estimated_cost_micros is null
                                and r.charged_cost_micros > 0) as unknown
        from ops.agent_runs r
       where r.started_at >= w.since
         and (   l.scope = 'global'
              or (l.scope = 'tenant'  and r.tenant_id = l.tenant_id)
              or (l.scope = 'company' and r.tenant_id = l.tenant_id and r.company_id = l.company_id))
    ) s on true
   where l.ended_at is null
   order by case l.scope when 'global' then 0 when 'tenant' then 1 else 2 end, l.tenant_id, l.company_id;
end
$function$;

-- The Phase 1D trip, with one more scope. A job_kind stop names an external kind,
-- for one tenant or for all; naming any other kind is refused, so a stop can never
-- look active while holding nothing.
drop function if exists ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid);
create or replace function ops.trip_execution_stop(
  p_scope         text,
  p_reason        text,
  p_actor         text,
  p_tenant_id     uuid default null,
  p_company_id    uuid default null,
  p_department_id uuid default null,
  p_agent_id      uuid default null,
  p_job_kind      text default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_scope is null or p_scope not in ('global', 'tenant', 'company', 'department', 'agent', 'job_kind') then
    raise exception using errcode = 'OS400', message = format('ops.trip_execution_stop: %L is not a stop scope', p_scope);
  end if;
  if p_scope not in ('global', 'job_kind') and p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.trip_execution_stop: a scoped stop needs its tenant';
  end if;
  if (p_scope = 'global' and (p_tenant_id is not null or p_company_id is not null or p_department_id is not null
                              or p_agent_id is not null or p_job_kind is not null))
     or (p_scope = 'tenant' and (p_company_id is not null or p_department_id is not null or p_agent_id is not null
                                 or p_job_kind is not null))
     or (p_scope = 'company' and (p_company_id is null or p_department_id is not null or p_agent_id is not null
                                  or p_job_kind is not null))
     or (p_scope = 'department' and (p_company_id is null or p_department_id is null or p_agent_id is not null
                                     or p_job_kind is not null))
     or (p_scope = 'agent' and (p_company_id is null or p_agent_id is null or p_department_id is not null
                                or p_job_kind is not null))
     or (p_scope = 'job_kind' and (p_job_kind is null or p_company_id is not null or p_department_id is not null
                                   or p_agent_id is not null)) then
    raise exception using errcode = 'OS400', message = format('ops.trip_execution_stop: the target does not match scope %s', p_scope);
  end if;
  if p_scope = 'job_kind' and not (p_job_kind = any (ops.external_job_kinds())) then
    raise exception using
      errcode = 'OS400',
      message = format('ops.trip_execution_stop: %L is not an external job kind, so a stop on it would hold nothing', p_job_kind);
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

  -- Waits for every lease, request or start that is reading the stops right now;
  -- every later one waits for this trip and sees it.
  perform pg_advisory_xact_lock(ops.execution_stop_lock_key());

  insert into ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id, job_kind, reason, tripped_by)
  values (p_scope, p_tenant_id, p_company_id, p_department_id, p_agent_id, p_job_kind, p_reason, p_actor)
  on conflict do nothing
  returning id into v_id;

  if v_id is null then
    -- Already stopped at exactly this target, by the same kind of actor: tripping
    -- again changes nothing. A system stop never absorbs an owner's trip, or the
    -- reverse, because origin is part of the target.
    select s.id into v_id
      from ops.execution_stops s
     where s.cleared_at is null
       and s.scope = p_scope
       and s.tenant_id is not distinct from p_tenant_id
       and s.company_id is not distinct from p_company_id
       and s.department_id is not distinct from p_department_id
       and s.agent_id is not distinct from p_agent_id
       and s.job_kind is not distinct from p_job_kind
       and s.origin = case when p_actor like 'system:%' then 'system' else 'owner' end;
    if v_id is null then
      raise exception using
        errcode = 'OS409',
        message = 'ops.trip_execution_stop: the stop could neither be recorded nor found; nothing was tripped';
    end if;
  end if;
  return v_id;
end
$function$;

-- The explicit request for ONE agent run: Phase 1D's body, plus the spend check at
-- request time. A request is refused early when a limit it needs is missing or
-- already spent; the start remains the authoritative check.
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
  v_spend       record;
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
  perform ops.require_read_committed('ops.request_agent_run');

  v_fingerprint := encode(sha256(convert_to(concat_ws('|',
    'agent_run.request.v1', coalesce(p_task_id::text, ''), coalesce(p_agent_id::text, ''),
    coalesce(p_capability, ''), coalesce(p_retry_of_run_id::text, '')), 'UTF8')), 'hex');

  select r.* into v_existing
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return v_existing.id;
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

  -- The kill switch, at request time.
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.active_execution_stop(p_tenant_id, v_task.company_id, v_agent.department_id, p_agent_id);
  if v_stop is not null then
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = 'execution_stopped', stop_id = v_stop
     where id = v_run;
    perform ops.pop_event_context(v_context);
    return v_run;
  end if;

  -- Spend, at request time: a missing limit, or one already spent by settled runs,
  -- refuses now, with no job. Contention with calls in flight does not refuse: those
  -- calls may settle before this run is started, and if they have not, the start
  -- raises OS429 and its job retries. No lock: the start re-checks every limit under
  -- lock, so this read can only refuse early, never admit a call. A request that
  -- races an owner's limit change may raise OS409 here instead (the run guard
  -- records only an active limit); that fails closed: the request records nothing,
  -- creates no job and calls nothing.
  select a.p_code, a.p_limit_id into v_spend
    from ops.spend_admission(p_tenant_id, v_task.company_id, 1, false) a;
  if v_spend.p_code is not null and v_spend.p_code <> 'budget_contended' then
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = v_spend.p_code,
           spend_limit_id = v_spend.p_limit_id
     where id = v_run;
    perform ops.pop_event_context(v_context);
    return v_run;
  end if;

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

-- The Phase 1C create, with an optional tenant-scoped idempotency key. The same key
-- for the same request returns the task it created, with no second task and no
-- second fact; the same key for a different request is refused.
drop function if exists ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid);
create or replace function ops.create_task(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_type            text,
  p_title           text,
  p_source          text,
  p_description     text default null,
  p_department_id   uuid default null,
  p_parent_task_id  uuid default null,
  p_priority        integer default 100,
  p_due_at          timestamptz default null,
  p_correlation_id  uuid default null,
  p_causation_id    uuid default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context     jsonb;
  v_company     text;
  v_department  text;
  v_id          uuid;
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fp text;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_task: no tenant scope';
  end if;

  if p_idempotency_key is not null then
    if p_idempotency_key !~ '^[\x21-\x7e]{1,200}$' then
      raise exception using
        errcode = 'OS400',
        message = 'ops.create_task: an idempotency key is 1 to 200 printable characters';
    end if;
    v_fingerprint := ops.task_request_fingerprint(
      p_company_id, p_department_id, p_parent_task_id, p_type, p_title, p_description,
      coalesce(p_priority, 100), p_due_at);
    select t.id, t.request_fingerprint into v_existing_id, v_existing_fp
      from ops.tasks t
     where t.tenant_id = p_tenant_id and t.idempotency_key = p_idempotency_key;
    if found then
      if v_existing_fp = v_fingerprint then
        return v_existing_id; -- the same request, already made
      end if;
      raise exception using
        errcode = 'OS409',
        message = 'ops.create_task: that idempotency key already names a different task request';
    end if;
  end if;

  select c.status into v_company
    from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_task: company not found in this tenant';
  end if;
  if p_department_id is not null then
    select d.status into v_department
      from ops.departments d
     where d.id = p_department_id and d.tenant_id = p_tenant_id and d.company_id = p_company_id
       for share;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.create_task: department not found in this company';
    end if;
  end if;
  if p_parent_task_id is not null then
    perform 1 from ops.tasks t
     where t.id = p_parent_task_id and t.tenant_id = p_tenant_id and t.company_id = p_company_id;
    if not found then
      raise exception using errcode = 'OS404', message = 'ops.create_task: parent task not found in this company';
    end if;
  end if;
  if v_company <> 'active' or coalesce(v_department, 'active') <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.create_task: the company or department is inactive';
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  insert into ops.tasks (
    tenant_id, company_id, department_id, parent_task_id,
    type, title, description, priority, due_at, idempotency_key)
  values (
    p_tenant_id, p_company_id, p_department_id, p_parent_task_id,
    p_type, p_title, p_description, coalesce(p_priority, 100), p_due_at, p_idempotency_key)
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  perform ops.pop_event_context(v_context);

  if v_id is null then
    -- A concurrent create with this key committed first: answer as a replay would.
    select t.id, t.request_fingerprint into v_existing_id, v_existing_fp
      from ops.tasks t
     where t.tenant_id = p_tenant_id and t.idempotency_key = p_idempotency_key;
    if v_existing_fp = v_fingerprint then
      return v_existing_id;
    end if;
    raise exception using
      errcode = 'OS409',
      message = 'ops.create_task: that idempotency key already names a different task request';
  end if;
  return v_id;
end
$function$;

-- The Phase 1C business fact, with an optional tenant-scoped idempotency key.
drop function if exists ops.record_event(uuid, uuid, text, text, text, uuid, jsonb, uuid, uuid);
create or replace function ops.record_event(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_type            text,
  p_source          text,
  p_subject_type    text default null,
  p_subject_id      uuid default null,
  p_payload         jsonb default '{}'::jsonb,
  p_correlation_id  uuid default null,
  p_causation_id    uuid default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id          uuid;
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fp text;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.record_event: no tenant scope';
  end if;

  if p_idempotency_key is not null then
    if p_idempotency_key !~ '^[\x21-\x7e]{1,200}$' then
      raise exception using
        errcode = 'OS400',
        message = 'ops.record_event: an idempotency key is 1 to 200 printable characters';
    end if;
    v_fingerprint := ops.event_request_fingerprint(
      p_company_id, p_type, p_source, p_subject_type, p_subject_id, coalesce(p_payload, '{}'::jsonb), p_causation_id);
    select e.id, e.request_fingerprint into v_existing_id, v_existing_fp
      from ops.events e
     where e.tenant_id = p_tenant_id and e.idempotency_key = p_idempotency_key;
    if found then
      if v_existing_fp = v_fingerprint then
        return v_existing_id; -- the same fact, already recorded
      end if;
      raise exception using
        errcode = 'OS409',
        message = 'ops.record_event: that idempotency key already names a different event';
    end if;
  end if;

  perform 1 from ops.companies c where c.id = p_company_id and c.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.record_event: company not found in this tenant';
  end if;
  if split_part(coalesce(p_type, ''), '.', 1) = any (ops.derived_event_namespaces()) then
    raise exception using
      errcode = 'OS403',
      message = format('ops.record_event: %L is a derived lifecycle event and cannot be recorded directly', p_type);
  end if;

  insert into ops.events (
    tenant_id, company_id, type, source, subject_type, subject_id,
    payload, correlation_id, causation_id, idempotency_key)
  values (
    p_tenant_id, p_company_id, p_type, p_source, p_subject_type, p_subject_id,
    coalesce(p_payload, '{}'::jsonb), p_correlation_id, p_causation_id, p_idempotency_key)
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;

  if v_id is null then
    select e.id, e.request_fingerprint into v_existing_id, v_existing_fp
      from ops.events e
     where e.tenant_id = p_tenant_id and e.idempotency_key = p_idempotency_key;
    if v_existing_fp = v_fingerprint then
      return v_existing_id;
    end if;
    raise exception using
      errcode = 'OS409',
      message = 'ops.record_event: that idempotency key already names a different event';
  end if;
  return v_id;
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. Worker capabilities. The Phase 1B/1D shape: SECURITY DEFINER, no tenant, run,
--    task, agent or job argument; whatever they touch is resolved from the live
--    lease.
-- ---------------------------------------------------------------------------

-- The Phase 1A lease, with the kill switch at the lease boundary. The shared lock is
-- taken in its own statement, so the candidate read sees every trip that has
-- returned. A queued job whose kind is not internal and that an active stop covers
-- is passed over: it stays queued and consumes no attempt. Evaluating that costs
-- nothing while no stop is active, one comparison per job under a global stop, and a
-- read of the tiny stop table under tenant or kind stops; only an organisational stop
-- makes it read each held job's coordinates. Everything else is unchanged.
create or replace function ops.lease_job(
  p_worker_id      text,
  p_lease_seconds  integer default 60
)
returns ops.jobs
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job        ops.jobs;
  v_any        boolean;
  v_global     boolean;
  v_org        boolean;
  v_internal   text[] := ops.internal_job_kinds();
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'ops.lease_job requires a worker id; it is what binds the lease to a caller';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 then
    raise exception 'ops.lease_job requires a positive lease duration';
  end if;
  perform ops.require_read_committed('ops.lease_job');
  if row_security_active('ops.execution_stops') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.lease_job: row security would hide the stops from this caller, and a switch that cannot be read leases nothing';
  end if;

  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);

  perform ops.reap_expired_leases();

  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  select coalesce(bool_or(true), false),
         coalesce(bool_or(s.scope = 'global'), false),
         coalesce(bool_or(s.scope in ('company', 'department', 'agent')), false)
    into v_any, v_global, v_org
    from ops.execution_stops s
   where s.cleared_at is null;

  update ops.jobs j
     set status = 'leased',
         lease_owner = p_worker_id,
         leased_at = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = j.attempts + 1,
         updated_at = now()
   where j.id = (
      select c.id
        from ops.jobs c
       where c.status = 'queued'
         and c.available_at <= now()
         and (not v_any
              or c.kind = any (v_internal)
              or (not v_global
                  and not exists (
                    select 1 from ops.execution_stops s
                     where s.cleared_at is null
                       and s.scope in ('tenant', 'job_kind')
                       and ops.execution_stop_covers(s.scope, s.tenant_id, s.company_id, s.department_id,
                                                     s.agent_id, s.job_kind, c.tenant_id, c.kind, null, null, null))
                  and (not v_org or ops.job_covering_stop(c.tenant_id, c.id, c.kind) is null)))
       order by c.priority asc, c.available_at asc, c.created_at asc
         for update skip locked
       limit 1
   )
  returning j.* into v_job;

  if v_job.id is null then
    return null;
  end if;

  perform set_config('app.worker_id', p_worker_id, true);
  perform set_config('app.job_id', v_job.id::text, true);

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job.id, v_job.tenant_id, 'leased', p_worker_id, v_job.attempts, v_job.kind);

  return v_job;
end
$function$;

-- Phase 1D's claim, with the context it hands out share-locked for the rest of the
-- prepare transaction. The start computes the run's input ceiling from those same
-- rows, so the reservation bounds the prompt the worker builds from this answer: no
-- edit can shorten the text between the two. The lock order is the start's own: the
-- job (share), the run, the task, the agent.
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
      raise exception 'ops.claim_agent_run: this attempt already started the run; a run is never claimed twice'
        using errcode = '42501';
    end if;
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
   where t.id = v_run.task_id and t.tenant_id = v_run.tenant_id and t.company_id = v_run.company_id
     for share;
  select a.* into v_agent from ops.agents a
   where a.id = v_run.agent_id and a.tenant_id = v_run.tenant_id and a.company_id = v_run.company_id
     for share;

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
  'Returns the bounded prompt context of the agent run bound to the live lease, share-locking the task and agent it was read from for the rest of the transaction, or settles the run. A run an earlier attempt left running is settled indeterminate, never started again. Resolves the run from the live lease; takes no id.';

-- The job this transaction's live lease holds, share-locked. Not granted: only the
-- capabilities below call it.
create or replace function ops.leased_job()
returns ops.jobs
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_tenant uuid := ops.current_tenant_id();
  v_job    ops.jobs;
begin
  if v_tenant is null then
    raise exception 'ops job capability: no live lease, so no tenant' using errcode = '42501';
  end if;
  select j.* into v_job
    from ops.jobs j
   where j.id = nullif(current_setting('app.job_id', true), '')::uuid
     and j.tenant_id = v_tenant
     and j.lease_owner = nullif(current_setting('app.worker_id', true), '')
     and j.status = 'leased'
     and j.lease_expires_at > clock_timestamp()
     for share;
  if not found then
    raise exception 'ops job capability: the lease on this job is no longer live' using errcode = '42501';
  end if;
  return v_job;
end
$function$;

-- The stop that covers the leased job right now, or NULL. The external_call runtime
-- asks this immediately before a call, in the transaction that would commit the
-- handler's durable start.
create or replace function ops.job_execution_stop()
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job ops.jobs := ops.leased_job();
begin
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  return ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind);
end
$function$;

comment on function ops.job_execution_stop() is
  'Returns the execution stop that covers the job the live lease holds, or NULL, after taking the kill-switch lock shared. Resolves the job from the live lease; takes no id.';

-- Release the leased job because a stop covers it: back to queued, the attempt this
-- lease spent restored, available again in 30 seconds, recorded as deferred. Only a
-- covering stop allows it, so a worker cannot use it to keep a job alive; with no
-- such stop it changes nothing and returns NULL.
create or replace function ops.defer_job()
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job  ops.jobs := ops.leased_job();
  v_stop uuid;
begin
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind);
  if v_stop is null then
    return null;
  end if;

  update ops.jobs
     set status = 'queued',
         lease_owner = null,
         leased_at = null,
         lease_expires_at = null,
         attempts = greatest(attempts - 1, 0),
         available_at = now() + interval '30 seconds',
         updated_at = now()
   where id = v_job.id;

  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  values (v_job.id, v_job.tenant_id, 'deferred', v_job.lease_owner, v_job.attempts,
          format('held by execution stop %s', v_stop));

  perform set_config('app.job_id', '', true);
  perform set_config('app.worker_id', '', true);
  return v_stop;
end
$function$;

comment on function ops.defer_job() is
  'Returns the leased job to the queue without consuming an attempt, only when an execution stop covers it, and returns that stop; otherwise changes nothing and returns NULL. Resolves the job from the live lease; takes no id.';

-- Phase 1D's start, with price and spend. A run starts only when its provider and
-- model have a current price, the worker's output ceiling is the route's, and every
-- applicable limit can absorb the run's reservation, checked under the spend locks
-- AFTER the kill switch, in the lock order ADR 0017 fixes. Only `running` means call.
-- A covering execution stop no longer cancels the run (owner decision B, 2026-09-17):
-- the start answers `stopped` and writes nothing, and the external_call runtime
-- defers the job in this same transaction, while this kill-switch lock is still held,
-- so the run stays pending, the lease's attempt is given back, and the next lease
-- after the stop is cleared re-checks every gate.
drop function if exists ops.start_agent_run(text, text, text, text);
create or replace function ops.start_agent_run(
  p_provider          text,
  p_model             text,
  p_prompt_version    text,
  p_input_fingerprint text,
  p_max_output_tokens integer
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
  v_agent      ops.agents;
  v_company    text;
  v_department text;
  v_stop       uuid;
  v_code       text;
  v_price      uuid;
  v_max_output integer;
  v_reserved   bigint;
  v_limit      uuid;
  v_spend      record;
  v_context    jsonb;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.start_agent_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;

  if v_run.status = 'running' then
    if v_run.job_attempt is distinct from v_attempt then
      v_context := ops.push_event_context('agent-runtime', null, null);
      update ops.agent_runs
         set status = 'indeterminate', error_category = 'interrupted', error_code = 'execution_interrupted'
       where id = v_run.id;
      perform ops.pop_event_context(v_context);
      return 'indeterminate';
    end if;
    return 'already_running';
  end if;
  if v_run.status <> 'pending' then
    return v_run.status;
  end if;

  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,31}$'
     or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'
     or p_prompt_version is null or p_prompt_version !~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'
     or p_input_fingerprint is null or p_input_fingerprint !~ '^[0-9a-f]{64}$'
     or p_max_output_tokens is null or p_max_output_tokens < 1 then
    raise exception using
      errcode = 'OS400',
      message = 'ops.start_agent_run: provider, model, prompt version, input fingerprint and output ceiling are required and well formed';
  end if;
  perform ops.require_read_committed('ops.start_agent_run');

  select t.* into v_task from ops.tasks t
   where t.id = v_run.task_id and t.tenant_id = v_run.tenant_id and t.company_id = v_run.company_id
     for share;
  select a.* into v_agent from ops.agents a
   where a.id = v_run.agent_id and a.tenant_id = v_run.tenant_id and a.company_id = v_run.company_id for share;
  select c.status into v_company from ops.companies c
   where c.id = v_run.company_id and c.tenant_id = v_run.tenant_id for share;
  select d.status into v_department from ops.departments d
   where d.id = v_run.department_id and d.tenant_id = v_run.tenant_id and d.company_id = v_run.company_id for share;
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  v_stop := ops.active_execution_stop(v_run.tenant_id, v_run.company_id, v_run.department_id, v_run.agent_id);
  if v_stop is not null then
    -- Held, not ended: nothing is written, so no gate below decides anything while
    -- the stop is active. The caller must defer the job before it commits.
    return 'stopped';
  end if;

  v_code := case
    when v_task.status in ('completed', 'failed', 'cancelled') then 'task_closed'
    when v_task.assigned_agent_id is distinct from v_run.agent_id then 'task_reassigned'
    when v_company is distinct from 'active' then 'company_inactive'
    when v_department is distinct from 'active' then 'department_inactive'
    when v_agent.status is distinct from 'active' then 'agent_inactive'
  end;

  if v_code is null then
    select p.max_output_tokens into v_max_output
      from ops.agent_run_route_policies() p
     where p.model_route = v_run.model_route;
    if v_max_output is null or v_max_output <> p_max_output_tokens then
      v_code := 'route_policy_mismatch';
    end if;
  end if;

  if v_code is null then
    v_price := ops.current_model_price(p_provider, p_model, now());
    if v_price is null then
      v_code := 'price_unavailable';
    end if;
  end if;

  if v_code is null then
    -- From the same rows ops.claim_agent_run handed the worker, so the input ceiling
    -- bounds the prompt the worker builds from them. The run guard requires a
    -- reservation and a price version of the run's own provider and model when it
    -- records the start, and fixes both; it does not recompute the reservation (an
    -- owner's raw UPDATE is outside the boundary, SI-22).
    v_reserved := ops.agent_run_reservation_for(
      v_run.tenant_id, v_run.company_id, v_run.task_id, v_run.agent_id, v_run.model_route, v_price);
    if v_reserved is null then
      raise exception using
        errcode = 'OS400',
        message = 'ops.start_agent_run: the run''s reservation could not be derived';
    end if;
    select a.p_code, a.p_limit_id into v_spend
      from ops.spend_admission(v_run.tenant_id, v_run.company_id, v_reserved, true) a;
    if v_spend.p_code = 'budget_contended' then
      -- It fits what has been spent, but not beside the calls still in flight, which
      -- settle within their own deadlines. Nothing is recorded: raising rolls the
      -- start back, the job retries on its backoff, and this run stays pending.
      raise exception using
        errcode = 'OS429',
        message = 'ops.start_agent_run: the spend limits cannot absorb this run beside the calls in flight; try again after they settle';
    end if;
    v_code := v_spend.p_code;
    v_limit := v_spend.p_limit_id;
  end if;

  -- The lease again, on the clock, now that every lock this start waited on is held,
  -- the spend locks included. Raising records nothing.
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
       set status = 'cancelled', error_category = 'refused', error_code = v_code,
           spend_limit_id = v_limit
     where id = v_run.id;
    perform ops.pop_event_context(v_context);
    return 'cancelled';
  end if;

  update ops.agent_runs
     set status = 'running', provider = p_provider, model = p_model,
         prompt_version = p_prompt_version, input_fingerprint = p_input_fingerprint,
         job_attempt = v_attempt, price_id = v_price, reserved_cost_micros = v_reserved
   where id = v_run.id;
  perform ops.pop_event_context(v_context);
  return 'running';
end
$function$;

comment on function ops.start_agent_run(text, text, text, text, integer) is
  'Re-checks every gate, the execution stops, the price and the spend limits under lock, then records the run as running with its price version and reservation. The caller commits this BEFORE calling the provider, and only the returned token running means call. A covering execution stop answers stopped and writes nothing: the caller defers the job (ops.defer_job) in the same transaction. A run another attempt started is settled indeterminate; a run is started once. Resolves the run from the live lease; takes no id.';

-- The global ceiling trips the one kill switch. Runs on the worker's reaper tick,
-- like the stale-run sweep, and checks no lease. It trips a global stop, as
-- system:spend_ceiling, only when the active ceiling VERSION is exhausted by spend
-- that has settled: its settled total today has reached it, or it refused a run today
-- that settled spend alone could not absorb (budget_exhausted, which contention with
-- calls in flight never records). It never clears a stop: only a person does (owner
-- decision D). A new ceiling version's day does NOT start clean: only the older
-- version's refusals stop counting, and today's settled spend, under every version,
-- still counts against it; a start the new version cannot absorb is refused and
-- trips the stop again. Resuming therefore needs a version in force above today's
-- settled spend, or the ceiling's next day in its own time zone, AND an explicit
-- clear by a person. A clear without either re-trips the stop on the next tick.
-- Returns the stop it tripped, or NULL.
create or replace function ops.enforce_spend_ceiling()
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_limit ops.spend_limits;
  v_since timestamptz;
  v_total record;
  v_stop  uuid;
begin
  -- A reader for whom row security filters the limits would find "no ceiling" and
  -- never trip. Refuse instead, as every other governance reader does.
  if row_security_active('ops.spend_limits') or row_security_active('ops.agent_runs')
     or row_security_active('ops.execution_stops') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.enforce_spend_ceiling: row security would hide limits, runs or stops from this sweep';
  end if;
  select l.* into v_limit
    from ops.spend_limits l
   where l.scope = 'global' and l.ended_at is null;
  if not found then
    return null; -- every start already refuses: there is no ceiling to reach
  end if;
  v_since := ops.spend_window_start(v_limit.timezone, now());
  select t.p_charged, t.p_settled into v_total
    from ops.spend_window_total('global', null, null, v_since) t;
  if v_total.p_settled < v_limit.daily_limit_micros
     and not exists (
       select 1 from ops.agent_runs r
        where r.spend_limit_id = v_limit.id
          and r.status = 'cancelled'
          and r.error_code = 'budget_exhausted'
          and r.completed_at >= v_since) then
    return null;
  end if;
  if exists (
    select 1 from ops.execution_stops s
     where s.scope = 'global' and s.origin = 'system' and s.cleared_at is null) then
    return null; -- already stopped by the ceiling
  end if;
  v_stop := ops.trip_execution_stop(
    'global',
    format('the global daily spend ceiling (limit %s) was reached on the day starting %s',
           v_limit.id, to_char(v_since at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'system:spend_ceiling');
  -- Two sweeps can race past the check above; the trip then returns the stop the
  -- other one recorded. Only the sweep whose own transaction recorded it says so.
  if exists (select 1 from ops.execution_stops s where s.id = v_stop and s.tripped_at = now()) then
    return v_stop;
  end if;
  return null;
end
$function$;

comment on function ops.enforce_spend_ceiling() is
  'Trips a global execution stop, as system:spend_ceiling, when the active global daily ceiling is reached or has refused a run today. Never clears a stop. Takes no argument and checks no lease.';

-- ---------------------------------------------------------------------------
-- 9. Privileges. Deny first; then the worker gains three capabilities and the
--    start's new signature, and nothing else.
-- ---------------------------------------------------------------------------

revoke all on table ops.model_prices, ops.spend_limits
  from public, anon, authenticated, service_role, ops_worker;

revoke all on function ops.external_job_kinds() from public;
revoke all on function ops.internal_job_kinds() from public;
revoke all on function ops.require_read_committed(text) from public;
revoke all on function ops.agent_run_route_policies() from public;
revoke all on function ops.agent_run_input_token_ceiling(jsonb) from public;
revoke all on function ops.agent_run_reserved_error_codes() from public;
revoke all on function ops.spend_lock_namespace() from public;
revoke all on function ops.spend_lock_key(text, uuid, uuid) from public;
revoke all on function ops.execution_stop_covers(text, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, uuid) from public;
revoke all on function ops.guard_model_price_insert() from public;
revoke all on function ops.refuse_model_price_change() from public;
revoke all on function ops.guard_spend_limit_insert() from public;
revoke all on function ops.guard_spend_limit_update() from public;
revoke all on function ops.guard_spend_limit_delete() from public;
revoke all on function ops.refuse_spend_limit_truncate() from public;
revoke all on function ops.guard_execution_stop_update() from public;
revoke all on function ops.task_request_fingerprint(uuid, uuid, uuid, text, text, text, integer, timestamptz) from public;
revoke all on function ops.event_request_fingerprint(uuid, text, text, text, uuid, jsonb, uuid) from public;
revoke all on function ops.derive_task_request_identity() from public;
revoke all on function ops.derive_event_request_identity() from public;
revoke all on function ops.guard_task_request_identity() from public;
revoke all on function ops.covering_execution_stop(uuid, text, uuid, uuid, uuid) from public;
revoke all on function ops.active_execution_stop(uuid, uuid, uuid, uuid) from public;
revoke all on function ops.job_covering_stop(uuid, uuid, text) from public;
revoke all on function ops.current_model_price(text, text, timestamptz) from public;
revoke all on function ops.agent_run_reservation_micros(uuid, integer, integer) from public;
revoke all on function ops.agent_run_reservation_for(uuid, uuid, uuid, uuid, text, uuid) from public;
revoke all on function ops.agent_run_estimated_cost_micros(uuid, integer, integer, integer, integer, integer) from public;
revoke all on function ops.spend_window_start(text, timestamptz) from public;
revoke all on function ops.spend_window_total(text, uuid, uuid, timestamptz) from public;
revoke all on function ops.spend_admission(uuid, uuid, bigint, boolean) from public;
revoke all on function ops.guard_agent_run_insert() from public;
revoke all on function ops.guard_agent_run_update() from public;
revoke all on function ops.record_model_price(text, text, numeric, numeric, boolean, timestamptz, timestamptz, text, text, numeric) from public;
revoke all on function ops.set_spend_limit(text, bigint, text, text, text, uuid, uuid) from public;
revoke all on function ops.retire_spend_limit(uuid, text, text) from public;
revoke all on function ops.spend_status(timestamptz) from public;
revoke all on function ops.trip_execution_stop(text, text, text, uuid, uuid, uuid, uuid, text) from public;
revoke all on function ops.request_agent_run(uuid, uuid, uuid, text, text, text, uuid) from public;
revoke all on function ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid, text) from public;
revoke all on function ops.record_event(uuid, uuid, text, text, text, uuid, jsonb, uuid, uuid, text) from public;
revoke all on function ops.lease_job(text, integer) from public;
revoke all on function ops.claim_agent_run() from public;
revoke all on function ops.leased_job() from public;
revoke all on function ops.job_execution_stop() from public;
revoke all on function ops.defer_job() from public;
revoke all on function ops.start_agent_run(text, text, text, text, integer) from public;
revoke all on function ops.enforce_spend_ceiling() from public;

grant execute on function ops.start_agent_run(text, text, text, text, integer) to ops_worker;
grant execute on function ops.job_execution_stop()                            to ops_worker;
grant execute on function ops.defer_job()                                     to ops_worker;
grant execute on function ops.enforce_spend_ceiling()                         to ops_worker;

-- ---------------------------------------------------------------------------
-- 10. Assert the end state. Everything earlier phases promised for ops is
--     re-asserted over the objects this phase adds, and the new surface is pinned.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_r   record;
  c_domain_tables constant text[] := array[
    'companies', 'departments', 'agents', 'tasks', 'events', 'task_jobs', 'agent_runs', 'execution_stops',
    'model_prices', 'spend_limits'];
  c_definer constant text[] := array[
    'claim_agent_run', 'complete_agent_run', 'complete_job', 'current_tenant_id', 'defer_job',
    'enforce_spend_ceiling', 'enqueue_job', 'fail_agent_run', 'fail_job', 'job_execution_stop', 'lease_job',
    'purge_inbound_email_ledger', 'reap_expired_leases', 'refuse_agent_run', 'resume_lease',
    'settle_job_failure', 'settle_stale_agent_runs', 'start_agent_run', 'worker_heartbeat', 'worker_stopped'];
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
    'ops_worker|ops.start_agent_run(text, text, text, text, integer)',
    'ops_worker|ops.complete_agent_run(jsonb, text, text, text, text, integer, integer, integer, integer, integer, integer)',
    'ops_worker|ops.fail_agent_run(text, text, text, text, text, integer, integer, integer, integer, integer, integer)',
    'ops_worker|ops.settle_stale_agent_runs()',
    'ops_worker|ops.job_execution_stop()',
    'ops_worker|ops.defer_job()',
    'ops_worker|ops.enforce_spend_ceiling()'];
  c_always_triggers constant text[] := array[
    'companies_guard_update', 'departments_guard_update', 'agents_guard_update',
    'tasks_guard_update', 'events_refuse_update', 'task_jobs_refuse_update',
    'agent_runs_guard_update', 'execution_stops_guard_update', 'execution_stops_guard_delete',
    'execution_stops_refuse_truncate', 'model_prices_refuse_update', 'model_prices_refuse_truncate',
    'spend_limits_guard_update', 'spend_limits_guard_delete', 'spend_limits_refuse_truncate',
    'tasks_request_identity_update'];
  c_origin_triggers constant text[] := array[
    'agent_runs_guard_insert', 'agent_runs_emit_requested', 'agent_runs_emit_changed',
    'execution_stops_guard_insert', 'events_guard_insert', 'model_prices_guard_insert',
    'spend_limits_guard_insert', 'tasks_request_identity_insert', 'events_request_identity_insert'];
  c_constraints constant text[] := array[
    'agent_runs_price_fkey', 'agent_runs_spend_limit_fkey', 'agent_runs_cost_iff_started',
    'agent_runs_limit_iff_budget_refusal', 'agent_runs_estimate_only_when_finished',
    'agent_runs_costs_non_negative', 'spend_limits_company_fkey', 'spend_limits_scope_shape',
    'model_prices_validity', 'model_prices_version_key', 'execution_stops_scope_shape',
    'execution_stops_company_fkey', 'execution_stops_department_fkey', 'execution_stops_agent_fkey',
    'tasks_request_fingerprint_iff_key', 'events_request_fingerprint_iff_key', 'job_events_event_check'];
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
  if exists (
    select 1 from pg_policy p
     where p.polrelid in ('ops.model_prices'::regclass, 'ops.spend_limits'::regclass)) then
    raise exception 'a policy exists on ops.model_prices or ops.spend_limits; both are reached only by owner and definer code';
  end if;

  -- 3. No application role holds ANY privilege on a Company OS or governance table.
  select string_agg(format('%s:%s:%s', r.rolname, t.relname, p.priv), ', ') into v_bad
    from unnest(c_domain_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker')) as r (rolname)
   cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (priv)
   where has_table_privilege(r.rolname, format('ops.%I', t.relname), p.priv);
  if v_bad is not null then
    raise exception 'Company OS or governance tables are reachable by an application role: %', v_bad;
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

  -- 8. The SECURITY DEFINER surface is exactly the pinned set, in both directions,
  --    and every definer function pins an empty search path.
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
    raise exception 'the SECURITY DEFINER surface in ops drifted from the pinned set after runtime governance: %', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.prosecdef
     and not coalesce(p.proconfig @> array['search_path=""'], false);
  if v_bad is not null then
    raise exception 'SECURITY DEFINER function(s) in ops without an empty search path: %', v_bad;
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
    raise exception 'the ops EXECUTE surface of the application roles drifted from the pinned set after runtime governance: %', v_bad;
  end if;

  -- 11. The three worker capabilities this phase adds take no argument at all.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'ops'
       and p.proname in ('job_execution_stop', 'defer_job', 'enforce_spend_ceiling')
       and p.pronargs <> 0) then
    raise exception 'a runtime governance worker capability takes an argument';
  end if;

  -- 12. Exactly one overload of every function whose signature this phase changed.
  select string_agg(format('%s x%s', f.name, f.n), ', ') into v_bad
    from (select p.proname as name, count(*) as n
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'ops'
             and p.proname in ('start_agent_run', 'trip_execution_stop', 'create_task', 'record_event')
           group by p.proname) f
   where f.n <> 1;
  if v_bad is not null then
    raise exception 'a function whose signature changed still has another overload: %', v_bad;
  end if;

  -- 13. Guard triggers exist and survive replica mode; the rest exist in ORIGIN mode.
  select string_agg(g.name, ', ') into v_bad
    from unnest(c_always_triggers) as g (name)
   where not exists (
     select 1 from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and tg.tgname = g.name and tg.tgenabled = 'A');
  if v_bad is not null then
    raise exception 'guard trigger(s) missing or not ENABLE ALWAYS after runtime governance: %', v_bad;
  end if;
  select string_agg(g.name, ', ') into v_bad
    from unnest(c_origin_triggers) as g (name)
   where not exists (
     select 1 from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and tg.tgname = g.name and tg.tgenabled = 'O');
  if v_bad is not null then
    raise exception 'trigger(s) missing or not in ORIGIN mode after runtime governance: %', v_bad;
  end if;

  -- 14. Every constraint that makes a price, a limit or a cost coherent.
  select string_agg(k.name, ', ') into v_bad
    from unnest(c_constraints) as k (name)
   where not exists (
     select 1 from pg_constraint x
      join pg_namespace n on n.oid = x.connamespace
     where n.nspname = 'ops' and x.conname = k.name and x.convalidated);
  if v_bad is not null then
    raise exception 'runtime governance constraint(s) missing or not validated: %', v_bad;
  end if;

  -- 15. The vocabulary: one external kind, the route ceilings, the reserved codes,
  --     the one executable kind and the one capability.
  if ops.external_job_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'ops.external_job_kinds() is not exactly {agent_run.execute}';
  end if;
  if (select array_agg(p.model_route || '=' || p.max_output_tokens order by p.model_route)
        from ops.agent_run_route_policies() p)
     is distinct from array['economy=2000', 'reasoning=25000', 'standard=8000']::text[] then
    raise exception 'ops.agent_run_route_policies() drifted from the reviewed ceilings';
  end if;
  if not (ops.agent_run_reserved_error_codes() @> array[
      'execution_stopped', 'execution_interrupted', 'database_contract', 'job_failed', 'job_ended_before_start',
      'price_unavailable', 'route_policy_mismatch', 'spend_ceiling_unconfigured', 'budget_unconfigured',
      'budget_exhausted']::text[]) then
    raise exception 'ops.agent_run_reserved_error_codes() lost a reserved code';
  end if;
  if ops.task_executable_kinds() is distinct from array['agent_run.execute']::text[] then
    raise exception 'ops.task_executable_kinds() is not exactly {agent_run.execute}';
  end if;
  if (select array_agg(c.capability || '=' || c.model_route order by c.capability) from ops.agent_run_capabilities() c)
     is distinct from array['task_assessment=standard']::text[] then
    raise exception 'ops.agent_run_capabilities() drifted from the reviewed set';
  end if;

  if ops.internal_job_kinds() is distinct from array['postmark.ledger_retention']::text[]
     or ops.internal_job_kinds() && ops.external_job_kinds() then
    raise exception 'ops.internal_job_kinds() is not exactly {postmark.ledger_retention}, disjoint from the external kinds';
  end if;

  -- 16. The one coverage predicate: an organisational coordinate the work does not
  --     know fails closed inside its tenant and never crosses tenants; an all-tenant
  --     kind stop covers its kind in every tenant; a known coordinate must match.
  declare
    v_tenant uuid := gen_random_uuid();
    v_company uuid := gen_random_uuid();
  begin
    if not ops.execution_stop_covers('company', v_tenant, v_company, null, null, null,
                                     v_tenant, 'agent_run.execute', null, null, null) then
      raise exception 'ops.execution_stop_covers() failed open on an unknown company';
    end if;
    if ops.execution_stop_covers('company', v_tenant, v_company, null, null, null,
                                 gen_random_uuid(), 'agent_run.execute', null, null, null) then
      raise exception 'ops.execution_stop_covers() let a company stop cross tenants';
    end if;
    if ops.execution_stop_covers('company', v_tenant, v_company, null, null, null,
                                 v_tenant, 'agent_run.execute', gen_random_uuid(), null, null) then
      raise exception 'ops.execution_stop_covers() matched another company';
    end if;
    if not ops.execution_stop_covers('job_kind', null, null, null, null, 'agent_run.execute',
                                     v_tenant, 'agent_run.execute', null, null, null) then
      raise exception 'ops.execution_stop_covers() does not let an all-tenant kind stop cover its kind';
    end if;
    if ops.execution_stop_covers('job_kind', null, null, null, null, 'agent_run.execute',
                                 v_tenant, 'other.kind', null, null, null) then
      raise exception 'ops.execution_stop_covers() let a kind stop cover another kind';
    end if;
  end;

  -- A stop's origin is derived from who tripped it, and is part of its target.
  if not exists (
    select 1 from pg_attribute a
     where a.attrelid = 'ops.execution_stops'::regclass and a.attname = 'origin'
       and a.attgenerated = 's' and not a.attisdropped) then
    raise exception 'ops.execution_stops.origin is not a stored generated column';
  end if;
  if position('origin' in (select pg_get_indexdef('ops.execution_stops_active_target_key'::regclass))) = 0 then
    raise exception 'the one-active-stop-per-target index does not include origin';
  end if;

  -- 17. No migration ships a price or a limit.
  if exists (select 1 from ops.model_prices) or exists (select 1 from ops.spend_limits) then
    raise exception 'runtime governance shipped price or limit rows; both are owner data';
  end if;
end
$$;
