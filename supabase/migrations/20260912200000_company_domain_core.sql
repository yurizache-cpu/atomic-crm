-- Phase 1C — the Company OS domain core.
--
-- The organisational primitives future AI workers will operate on:
--
--   ops.tenants (Phase 1A, the security boundary)
--     └─ ops.companies        a business entity; a tenant may hold several
--          └─ ops.departments an organisational unit of one company
--               └─ ops.agents configuration and identity of a virtual employee
--          └─ ops.tasks       business work requested by the company
--          └─ ops.events      durable facts, derived from the rows above
--   ops.task_jobs             the bridge from a task to the ops.jobs it requested
--
-- DETERMINISTIC ONLY. No model, provider, prompt, memory or tool appears here.
-- An agent is a row of configuration; it cannot run. Nothing below executes one.
--
-- THE DISTINCTIONS THIS SCHEMA KEEPS (docs/adr/0015-company-os-domain-core.md):
--   Tenant  != Company   tenant_id is the isolation boundary; a company is an
--                        organisational partition INSIDE it, not a second one.
--   Agent   != Worker    ops.agents is configuration; the worker is a process.
--   Task    != Job       ops.tasks is business intent; ops.jobs is execution.
--                        The dependency points one way: domain -> execution.
--   Event   != Audit     ops.events holds business facts; ops.job_events stays
--                        the execution audit trail, and nothing is duplicated.
--   ops.companies is NOT public.companies, which means CRM customer account and
--   is adapter-internal. Every reference here is schema-qualified.
--
-- WHO CAN WRITE THIS, IN PHASE 1C: nobody but the owner.
--   * No application role (anon, authenticated, service_role, ops_worker) holds
--     any privilege on any table below, and no PUBLIC EXECUTE survives on any
--     function below. Asserted at the end of this file and on every test run.
--   * Every function is SECURITY INVOKER. They take an explicit p_tenant_id —
--     "the tenant scope the caller is already authorised for" — and treat every
--     other id as untrusted: it must resolve INSIDE that scope, otherwise the
--     answer is "not found" (OS404), whether it exists in another tenant or not.
--     INVOKER is load-bearing: an EXECUTE grant to any other role would still hit
--     42501 on the tables, so no function here can become a forgeable-tenancy
--     primitive by being granted. A future runtime caller gets a thin wrapper that
--     takes NO tenant argument and resolves it (ADR 0015).
--   * The lease-bound SELECT policies are declared with NO grant. They are inert
--     today and fix the scope of any future read grant before it can exist.
--
-- INTEGRITY THAT HOLDS FOR EVERY ROLE BUT THE OWNER. Composite foreign keys that
-- carry tenant_id (and company_id) make a cross-tenant or cross-company reference
-- unstorable; guard triggers make immutable columns immutable, closed tasks
-- closed, and events unrewritable. The owner is outside that boundary by design,
-- exactly as it is for RLS (BYPASSRLS): it can DISABLE TRIGGER, and on Supabase it
-- can set session_replication_role = replica, which skips ORIGIN triggers and
-- foreign-key checks. The UPDATE-path guards are therefore ENABLE ALWAYS, so
-- replica mode does not silence them; INSERT-path validators and event emission
-- stay ORIGIN, so an owner data restore in replica mode neither re-validates nor
-- duplicates history.
--
-- ERRORS. Domain refusals use their own SQLSTATE class, so a native 42501 (a real
-- privilege failure — a misconfigured connection) is never mistaken for one:
--   OS400 invalid argument     OS401 no tenant scope     OS403 refused
--   OS404 not found in scope   OS409 invalid state
-- Constraint violations keep their native codes (23503, 23505, 23514).

-- ---------------------------------------------------------------------------
-- 0. Engine vocabulary. Every value below is the same for every tenant, which is
--    ADR 0013's test for when an enumeration belongs in the schema.
-- ---------------------------------------------------------------------------

-- The namespaces whose events are DERIVED from state changes by the triggers in
-- this file. Nothing may record them directly. `job` is reserved too: job
-- lifecycle lives in ops.job_events, so a `job.*` fact here could only be forged.
create or replace function ops.derived_event_namespaces()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['company', 'department', 'agent', 'task', 'job']::text[];
$function$;

-- The task state machine, as a relation. The BEFORE UPDATE trigger on ops.tasks
-- is its only enforcement point; engine/domain/taskStateMachine.ts mirrors it
-- for typing and a driver-backed test asserts the two sets are equal.
create or replace function ops.task_status_transitions()
returns table (from_status text, to_status text)
language sql
immutable
set search_path to ''
as $function$
  select * from (values
    ('queued',      'assigned'),
    ('queued',      'cancelled'),
    ('assigned',    'in_progress'),
    ('assigned',    'cancelled'),
    ('in_progress', 'waiting'),
    ('in_progress', 'completed'),
    ('in_progress', 'failed'),
    ('in_progress', 'cancelled'),
    ('waiting',     'in_progress'),
    ('waiting',     'failed'),
    ('waiting',     'cancelled')
  ) as t (from_status, to_status);
$function$;

create or replace function ops.task_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select exists (
    select 1 from ops.task_status_transitions() t
     where t.from_status = p_from and t.to_status = p_to
  );
$function$;

-- The job kinds a task may request. EMPTY in Phase 1C, deliberately: the only
-- registered handler (postmark.ledger_retention) is tenant-wide CRM maintenance,
-- not a company's business work, and a company-scoped task must not be able to
-- trigger it. Adding a kind is a reviewed migration, the same way adding a
-- handler is a reviewed edit of engine/worker/registry.ts.
create or replace function ops.task_executable_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array[]::text[];
$function$;

-- ---------------------------------------------------------------------------
-- 1. Event provenance context.
--
-- Lifecycle events are emitted by triggers, which take no arguments, so the
-- provenance of a change travels in three TRANSACTION-LOCAL settings. This is a
-- tripwire, not an authority: any role can write a GUC, and only the owner holds
-- DML here. What it buys is that raw DML which forgot to declare its provenance
-- is refused instead of recording an anonymous fact.
--
-- Push saves the previous values and pop restores them, rather than clearing,
-- so nested domain calls compose. An exception reverts set_config(..., true)
-- with the subtransaction, so a failed call leaves nothing behind.
-- ---------------------------------------------------------------------------

create or replace function ops.push_event_context(
  p_source         text,
  p_correlation_id uuid,
  p_causation_id   uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_previous constant jsonb := jsonb_build_object(
    'source',      current_setting('app.event_source', true),
    'correlation', current_setting('app.event_correlation_id', true),
    'causation',   current_setting('app.event_causation_id', true)
  );
begin
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using
      errcode = 'OS400',
      message = format('ops: event source %L is missing or malformed. Every Company OS change declares its provenance.', p_source);
  end if;

  perform set_config('app.event_source', p_source, true);
  perform set_config('app.event_correlation_id', coalesce(p_correlation_id::text, ''), true);
  perform set_config('app.event_causation_id', coalesce(p_causation_id::text, ''), true);
  return v_previous;
end
$function$;

create or replace function ops.pop_event_context(p_previous jsonb)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  perform set_config('app.event_source', coalesce(p_previous ->> 'source', ''), true);
  perform set_config('app.event_correlation_id', coalesce(p_previous ->> 'correlation', ''), true);
  perform set_config('app.event_causation_id', coalesce(p_previous ->> 'causation', ''), true);
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------

-- A composite key the bridge's foreign key needs. A unique INDEX rather than an
-- ADD CONSTRAINT: it takes ShareLock instead of AccessExclusiveLock on the hot
-- queue table, and `if not exists` re-applies cleanly. ops.jobs gains no column
-- and no reference to the domain.
create unique index if not exists jobs_tenant_id_id_key on ops.jobs (tenant_id, id);

create table if not exists ops.companies (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references ops.tenants (id) on delete restrict,
  slug       text not null,
  name       text not null,
  status     text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_slug_format   check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 63),
  constraint companies_name_length   check (char_length(btrim(name)) between 1 and 200),
  constraint companies_status_check  check (status in ('active', 'inactive')),
  constraint companies_tenant_slug_key unique (tenant_id, slug),
  constraint companies_scope_id_key    unique (tenant_id, id)
);

comment on table ops.companies is
  'A business entity inside a tenant. NOT public.companies, which means CRM customer account. A company is an organisational partition, not an isolation boundary: isolation between businesses requires separate tenants.';

create table if not exists ops.departments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references ops.tenants (id) on delete restrict,
  company_id uuid not null,
  slug       text not null,
  name       text not null,
  status     text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint departments_slug_format  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 63),
  constraint departments_name_length  check (char_length(btrim(name)) between 1 and 200),
  constraint departments_status_check check (status in ('active', 'inactive')),
  constraint departments_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint departments_company_slug_key unique (company_id, slug),
  constraint departments_scope_id_key     unique (tenant_id, company_id, id)
);

comment on table ops.departments is
  'An organisational unit of one company. Names are tenant vocabulary (data), never schema.';

create table if not exists ops.agents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references ops.tenants (id) on delete restrict,
  company_id    uuid not null,
  department_id uuid not null,
  slug          text not null,
  name          text not null,
  role          text not null,
  description   text,
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint agents_slug_format         check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 63),
  constraint agents_name_length         check (char_length(btrim(name)) between 1 and 200),
  constraint agents_role_length         check (char_length(btrim(role)) between 1 and 200),
  constraint agents_description_length  check (description is null or char_length(description) <= 2000),
  constraint agents_status_check        check (status in ('active', 'inactive')),
  constraint agents_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint agents_department_fkey
    foreign key (tenant_id, company_id, department_id)
    references ops.departments (tenant_id, company_id, id) on delete restrict,
  constraint agents_company_slug_key        unique (company_id, slug),
  constraint agents_scope_id_key            unique (tenant_id, company_id, id),
  constraint agents_department_scope_id_key unique (tenant_id, company_id, department_id, id)
);

comment on table ops.agents is
  'Configuration and identity of a virtual employee. NOT a process, NOT a worker, NOT a model call. Carries no provider, prompt, tool or memory. Status is lifecycle configuration and is never how a kill switch is implemented (ADR 0010).';

create table if not exists ops.tasks (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references ops.tenants (id) on delete restrict,
  company_id        uuid not null,
  department_id     uuid,
  assigned_agent_id uuid,
  parent_task_id    uuid,
  -- Tenant vocabulary (data). Only its shape is constrained here.
  type              text not null,
  title             text not null,
  description       text,
  status            text not null default 'queued',
  -- Orders work within a company. Never copied into ops.jobs.priority, which is
  -- platform-assigned: a tenant-controlled value there would reorder every
  -- tenant's queue.
  priority          integer not null default 100,
  due_at            timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Set when the task reaches ANY terminal status, as ops.jobs.completed_at is.
  completed_at      timestamptz,
  constraint tasks_type_format        check (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(type) <= 100),
  constraint tasks_title_length       check (char_length(btrim(title)) between 1 and 300),
  constraint tasks_description_length check (description is null or char_length(description) <= 10000),
  constraint tasks_status_check       check (status in ('queued', 'assigned', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled')),
  constraint tasks_priority_range     check (priority between 0 and 1000),
  constraint tasks_not_own_parent     check (parent_task_id is distinct from id),
  constraint tasks_queued_is_unassigned    check (status <> 'queued' or assigned_agent_id is null),
  constraint tasks_active_work_is_assigned check (status not in ('assigned', 'in_progress', 'waiting') or assigned_agent_id is not null),
  constraint tasks_completed_at_iff_closed check ((status in ('completed', 'failed', 'cancelled')) = (completed_at is not null)),
  constraint tasks_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint tasks_department_fkey
    foreign key (tenant_id, company_id, department_id)
    references ops.departments (tenant_id, company_id, id) on delete restrict,
  constraint tasks_agent_fkey
    foreign key (tenant_id, company_id, assigned_agent_id)
    references ops.agents (tenant_id, company_id, id) on delete restrict,
  -- When the task is department-scoped AND assigned, the agent must belong to
  -- that department. MATCH SIMPLE skips this while either column is NULL, and
  -- the three-column key above still pins the agent to the company.
  constraint tasks_department_agent_fkey
    foreign key (tenant_id, company_id, department_id, assigned_agent_id)
    references ops.agents (tenant_id, company_id, department_id, id) on delete restrict,
  constraint tasks_scope_id_key unique (tenant_id, company_id, id),
  constraint tasks_parent_fkey
    foreign key (tenant_id, company_id, parent_task_id)
    references ops.tasks (tenant_id, company_id, id) on delete restrict
);

comment on table ops.tasks is
  'Business work requested by a company. NOT ops.jobs: creating a task never enqueues anything. Title and description are free text a human typed and are never copied into events.';

create index if not exists tasks_company_status_idx on ops.tasks (tenant_id, company_id, status);
create index if not exists tasks_assigned_agent_idx on ops.tasks (tenant_id, company_id, assigned_agent_id)
  where assigned_agent_id is not null;
create index if not exists tasks_parent_idx on ops.tasks (tenant_id, company_id, parent_task_id)
  where parent_task_id is not null;

create table if not exists ops.events (
  id             uuid primary key default gen_random_uuid(),
  -- Insertion order. created_at is the transaction start, so every event of one
  -- domain transaction shares it and a uuid carries no order. seq orders events
  -- within a transaction; ordering ACROSS commits is a consumer design (Phase 1D).
  seq            bigint generated always as identity,
  tenant_id      uuid not null references ops.tenants (id) on delete restrict,
  company_id     uuid not null,
  type           text not null,
  source         text not null,
  subject_type   text,
  subject_id     uuid,
  payload        jsonb not null default '{}'::jsonb,
  correlation_id uuid,
  -- Deliberately NOT a foreign key: the insert guard requires the cause to exist
  -- already, in the same tenant and company, which a foreign key cannot say ("an
  -- EARLIER fact"), and without one an owner erasure of a cause is not blocked.
  causation_id   uuid,
  created_at     timestamptz not null default now(),
  constraint events_type_format   check (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and char_length(type) <= 100),
  constraint events_source_format check (source ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  constraint events_subject_type_check check (subject_type is null or subject_type in ('company', 'department', 'agent', 'task')),
  constraint events_subject_pair  check ((subject_type is null) = (subject_id is null)),
  constraint events_payload_object check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  constraint events_not_own_cause check (causation_id is distinct from id),
  constraint events_seq_key unique (seq),
  constraint events_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict
);

comment on table ops.events is
  'Durable business facts. Append-only: never updated. Lifecycle facts are derived from state changes by triggers and cannot be recorded directly. NOT the audit log: execution audit stays in ops.job_events. Payloads carry ids and states, never free text a human typed.';

create index if not exists events_company_seq_idx on ops.events (tenant_id, company_id, seq);
create index if not exists events_subject_idx on ops.events (tenant_id, subject_type, subject_id, seq)
  where subject_type is not null;

create table if not exists ops.task_jobs (
  tenant_id  uuid not null,
  job_id     uuid not null,
  company_id uuid not null,
  task_id    uuid not null,
  created_at timestamptz not null default now(),
  -- (tenant_id, job_id) rather than job_id alone: the foreign key below forces
  -- tenant_id to be the job's tenant, so this is the same "one task per job"
  -- guarantee, without a uniqueness check that could confirm another tenant's
  -- job is linked.
  constraint task_jobs_pkey primary key (tenant_id, job_id),
  constraint task_jobs_task_fkey
    foreign key (tenant_id, company_id, task_id)
    references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint task_jobs_job_fkey
    foreign key (tenant_id, job_id) references ops.jobs (tenant_id, id) on delete restrict
);

comment on table ops.task_jobs is
  'Which job a task requested. Owned by the domain; ops.jobs never references it. A link is history, so it restricts deleting the job: any future job retention must decide what to do with linked jobs.';

create index if not exists task_jobs_task_idx on ops.task_jobs (tenant_id, company_id, task_id);

-- ---------------------------------------------------------------------------
-- 3. Row level security. ENABLE and FORCE on every table, as everywhere in ops.
--
-- The policies are lease-bound like every other ops policy and there is NO
-- grant: they bind nothing today. They exist so that a future read grant to the
-- worker is born scoped to the leased tenant, and so that scope is testable now.
-- ---------------------------------------------------------------------------

alter table ops.companies   enable row level security;
alter table ops.companies   force  row level security;
alter table ops.departments enable row level security;
alter table ops.departments force  row level security;
alter table ops.agents      enable row level security;
alter table ops.agents      force  row level security;
alter table ops.tasks       enable row level security;
alter table ops.tasks       force  row level security;
alter table ops.events      enable row level security;
alter table ops.events      force  row level security;
alter table ops.task_jobs   enable row level security;
alter table ops.task_jobs   force  row level security;

drop policy if exists companies_read_leased_tenant on ops.companies;
create policy companies_read_leased_tenant on ops.companies
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

drop policy if exists departments_read_leased_tenant on ops.departments;
create policy departments_read_leased_tenant on ops.departments
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

drop policy if exists agents_read_leased_tenant on ops.agents;
create policy agents_read_leased_tenant on ops.agents
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

drop policy if exists tasks_read_leased_tenant on ops.tasks;
create policy tasks_read_leased_tenant on ops.tasks
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

drop policy if exists events_read_leased_tenant on ops.events;
create policy events_read_leased_tenant on ops.events
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

drop policy if exists task_jobs_read_leased_tenant on ops.task_jobs;
create policy task_jobs_read_leased_tenant on ops.task_jobs
  for select to ops_worker using (tenant_id = ops.current_tenant_id());

-- ---------------------------------------------------------------------------
-- 4. Guard triggers. Every function is SECURITY INVOKER: a trigger runs as the
--    user whose statement fired it, so none of them confers anything.
-- ---------------------------------------------------------------------------

-- Columns fixed at creation, and updated_at maintained by the database. A
-- composite foreign key only checks that the NEW parent exists, so without this
-- an unreferenced department could be moved to another tenant — leaving its
-- tenant-A `department.created` event pointing at a tenant-B row. Moving an
-- agent means creating a new agent.
create or replace function ops.guard_update_immutable()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_column text;
  v_old    constant jsonb := to_jsonb(old);
  v_new    constant jsonb := to_jsonb(new);
begin
  foreach v_column in array tg_argv loop
    if v_new -> v_column is distinct from v_old -> v_column then
      raise exception using
        errcode = 'OS409',
        message = format('ops.%s.%s is fixed at creation', tg_table_name, v_column);
    end if;
  end loop;
  new.updated_at := now();
  return new;
end
$function$;

-- Facts are never rewritten, and a link is history.
create or replace function ops.refuse_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'OS409',
    message = format('ops.%s rows are never updated', tg_table_name);
end
$function$;

-- A task is born queued and unassigned; every later state is a transition. And a
-- parent must ALREADY exist in the same company: a foreign key is checked at the
-- end of the statement, so one multi-row INSERT could otherwise store a cycle,
-- while a row BEFORE trigger sees only rows inserted before it.
create or replace function ops.guard_task_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.status is distinct from 'queued' or new.assigned_agent_id is not null or new.completed_at is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.tasks: a task is born queued and unassigned; every later state is reached through a transition';
  end if;

  if new.parent_task_id is not null and not exists (
    select 1 from ops.tasks p
     where p.id = new.parent_task_id
       and p.tenant_id = new.tenant_id
       and p.company_id = new.company_id
  ) then
    raise exception using
      errcode = 'OS404',
      message = 'ops.tasks: parent task not found in this company; a parent must exist before its children';
  end if;

  new.created_at := now();
  new.updated_at := now();
  return new;
end
$function$;

-- The task state machine, for every role but the owner. A closed task refuses
-- ANY update, which also closes the race where a reassignment that passed its
-- check on a stale row lands after a concurrent completion.
create or replace function ops.guard_task_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_agent_status text;
begin
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

-- What an event may claim about itself.
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

-- ---------------------------------------------------------------------------
-- 5. Lifecycle event emission. Exactly one event per change, in the same
--    statement, so a change and its fact commit or fail together.
-- ---------------------------------------------------------------------------

create or replace function ops.emit_lifecycle_event()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  -- nullif: once any transaction on a session has set a placeholder setting it
  -- reads back as '' rather than NULL, and ''::uuid would raise.
  v_source      constant text := nullif(current_setting('app.event_source', true), '');
  v_correlation constant uuid := nullif(current_setting('app.event_correlation_id', true), '')::uuid;
  v_causation   constant uuid := nullif(current_setting('app.event_causation_id', true), '')::uuid;
  v_type       text;
  v_company    uuid;
  v_subject    text;
  v_subject_id uuid;
  v_payload    jsonb;
begin
  if v_source is null then
    raise exception using
      errcode = 'OS400',
      message = format('ops.%s: this change carries no event provenance. Company OS rows change through the ops domain functions, which declare it.', tg_table_name);
  end if;

  case tg_table_name
    when 'companies' then
      v_company := new.id;
      v_subject := 'company';
      v_subject_id := new.id;
      if tg_op = 'INSERT' then
        v_type := 'company.created';
        v_payload := jsonb_build_object('slug', new.slug, 'name', new.name, 'status', new.status);
      else
        v_type := 'company.status_changed';
        v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
      end if;

    when 'departments' then
      v_company := new.company_id;
      v_subject := 'department';
      v_subject_id := new.id;
      if tg_op = 'INSERT' then
        v_type := 'department.created';
        v_payload := jsonb_build_object('slug', new.slug, 'name', new.name, 'status', new.status);
      else
        v_type := 'department.status_changed';
        v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
      end if;

    when 'agents' then
      v_company := new.company_id;
      v_subject := 'agent';
      v_subject_id := new.id;
      if tg_op = 'INSERT' then
        v_type := 'agent.created';
        v_payload := jsonb_build_object(
          'slug', new.slug, 'name', new.name, 'role', new.role,
          'department_id', new.department_id, 'status', new.status);
      else
        v_type := 'agent.status_changed';
        v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
      end if;

    when 'tasks' then
      v_company := new.company_id;
      v_subject := 'task';
      v_subject_id := new.id;
      if tg_op = 'INSERT' then
        -- No title, no description: free text a human typed may name a patient,
        -- and an append-only table is the wrong place to have to erase it from.
        v_type := 'task.created';
        v_payload := jsonb_build_object(
          'type', new.type, 'status', new.status, 'priority', new.priority,
          'department_id', new.department_id, 'parent_task_id', new.parent_task_id,
          'due_at', new.due_at);
      elsif new.assigned_agent_id is distinct from old.assigned_agent_id then
        -- One assignment, one fact — including queued -> assigned, which also
        -- changes the status and carries it.
        v_type := 'task.assigned';
        v_payload := jsonb_build_object(
          'from_agent_id', old.assigned_agent_id, 'to_agent_id', new.assigned_agent_id,
          'from_status', old.status, 'to_status', new.status);
      elsif new.status in ('completed', 'failed', 'cancelled') then
        v_type := 'task.' || new.status;
        v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
      else
        v_type := 'task.status_changed';
        v_payload := jsonb_build_object('from_status', old.status, 'to_status', new.status);
      end if;

    when 'task_jobs' then
      v_company := new.company_id;
      v_subject := 'task';
      v_subject_id := new.task_id;
      v_type := 'task.execution_requested';
      v_payload := jsonb_build_object(
        'job_id', new.job_id,
        'kind', (select j.kind from ops.jobs j where j.tenant_id = new.tenant_id and j.id = new.job_id));

    else
      raise exception using
        errcode = 'OS400',
        message = format('ops.emit_lifecycle_event is not defined for table %s', tg_table_name);
  end case;

  insert into ops.events (
    tenant_id, company_id, type, source, subject_type, subject_id,
    payload, correlation_id, causation_id)
  values (
    new.tenant_id, v_company, v_type, v_source, v_subject, v_subject_id,
    v_payload, v_correlation, v_causation);

  return null;
end
$function$;

-- ---------------------------------------------------------------------------
-- 6. Triggers. Guards on the UPDATE path are ENABLE ALWAYS; see the header.
--    Emission on UPDATE carries a WHEN clause: `UPDATE OF col` fires even when
--    the value does not change, and a no-op must not become a fact.
-- ---------------------------------------------------------------------------

drop trigger if exists companies_guard_update on ops.companies;
create trigger companies_guard_update
  before update on ops.companies
  for each row execute function ops.guard_update_immutable('id', 'tenant_id', 'slug', 'created_at');
alter table ops.companies enable always trigger companies_guard_update;

drop trigger if exists companies_emit_created on ops.companies;
create trigger companies_emit_created
  after insert on ops.companies
  for each row execute function ops.emit_lifecycle_event();

drop trigger if exists companies_emit_status on ops.companies;
create trigger companies_emit_status
  after update of status on ops.companies
  for each row when (old.status is distinct from new.status)
  execute function ops.emit_lifecycle_event();

drop trigger if exists departments_guard_update on ops.departments;
create trigger departments_guard_update
  before update on ops.departments
  for each row execute function ops.guard_update_immutable('id', 'tenant_id', 'company_id', 'slug', 'created_at');
alter table ops.departments enable always trigger departments_guard_update;

drop trigger if exists departments_emit_created on ops.departments;
create trigger departments_emit_created
  after insert on ops.departments
  for each row execute function ops.emit_lifecycle_event();

drop trigger if exists departments_emit_status on ops.departments;
create trigger departments_emit_status
  after update of status on ops.departments
  for each row when (old.status is distinct from new.status)
  execute function ops.emit_lifecycle_event();

drop trigger if exists agents_guard_update on ops.agents;
create trigger agents_guard_update
  before update on ops.agents
  for each row execute function ops.guard_update_immutable('id', 'tenant_id', 'company_id', 'department_id', 'slug', 'created_at');
alter table ops.agents enable always trigger agents_guard_update;

drop trigger if exists agents_emit_created on ops.agents;
create trigger agents_emit_created
  after insert on ops.agents
  for each row execute function ops.emit_lifecycle_event();

drop trigger if exists agents_emit_status on ops.agents;
create trigger agents_emit_status
  after update of status on ops.agents
  for each row when (old.status is distinct from new.status)
  execute function ops.emit_lifecycle_event();

drop trigger if exists tasks_guard_insert on ops.tasks;
create trigger tasks_guard_insert
  before insert on ops.tasks
  for each row execute function ops.guard_task_insert();

drop trigger if exists tasks_guard_update on ops.tasks;
create trigger tasks_guard_update
  before update on ops.tasks
  for each row execute function ops.guard_task_update();
alter table ops.tasks enable always trigger tasks_guard_update;

drop trigger if exists tasks_emit_created on ops.tasks;
create trigger tasks_emit_created
  after insert on ops.tasks
  for each row execute function ops.emit_lifecycle_event();

drop trigger if exists tasks_emit_changed on ops.tasks;
create trigger tasks_emit_changed
  after update of status, assigned_agent_id on ops.tasks
  for each row when (
    old.status is distinct from new.status
    or old.assigned_agent_id is distinct from new.assigned_agent_id)
  execute function ops.emit_lifecycle_event();

drop trigger if exists events_guard_insert on ops.events;
create trigger events_guard_insert
  before insert on ops.events
  for each row execute function ops.guard_event_insert();

drop trigger if exists events_refuse_update on ops.events;
create trigger events_refuse_update
  before update on ops.events
  for each row execute function ops.refuse_update();
alter table ops.events enable always trigger events_refuse_update;

drop trigger if exists task_jobs_refuse_update on ops.task_jobs;
create trigger task_jobs_refuse_update
  before update on ops.task_jobs
  for each row execute function ops.refuse_update();
alter table ops.task_jobs enable always trigger task_jobs_refuse_update;

drop trigger if exists task_jobs_emit_requested on ops.task_jobs;
create trigger task_jobs_emit_requested
  after insert on ops.task_jobs
  for each row execute function ops.emit_lifecycle_event();

-- ---------------------------------------------------------------------------
-- 7. Domain services. SECURITY INVOKER, explicit authorised tenant scope, every
--    other id resolved INSIDE that scope in the same statement that reads its
--    state — so an id from another tenant is "not found" before any status of
--    it can be observed. Rows are locked before they are checked, so a check and
--    its update cannot interleave with a concurrent change.
-- ---------------------------------------------------------------------------

create or replace function ops.create_company(
  p_tenant_id      uuid,
  p_slug           text,
  p_name           text,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_id      uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_company: no tenant scope';
  end if;
  perform 1 from ops.tenants t where t.id = p_tenant_id for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_company: tenant not found';
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  insert into ops.companies (tenant_id, slug, name)
  values (p_tenant_id, p_slug, p_name)
  returning id into v_id;
  perform ops.pop_event_context(v_context);
  return v_id;
end
$function$;

create or replace function ops.set_company_status(
  p_tenant_id      uuid,
  p_company_id     uuid,
  p_status         text,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_current text;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.set_company_status: no tenant scope';
  end if;
  select c.status into v_current
    from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.set_company_status: company not found in this tenant';
  end if;
  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception using errcode = 'OS400', message = format('ops.set_company_status: %L is not a company status', p_status);
  end if;
  if v_current = p_status then
    return;
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  update ops.companies set status = p_status
   where id = p_company_id and tenant_id = p_tenant_id;
  perform ops.pop_event_context(v_context);
end
$function$;

create or replace function ops.create_department(
  p_tenant_id      uuid,
  p_company_id     uuid,
  p_slug           text,
  p_name           text,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_company text;
  v_id      uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_department: no tenant scope';
  end if;
  select c.status into v_company
    from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_department: company not found in this tenant';
  end if;
  if v_company <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.create_department: the company is inactive';
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  insert into ops.departments (tenant_id, company_id, slug, name)
  values (p_tenant_id, p_company_id, p_slug, p_name)
  returning id into v_id;
  perform ops.pop_event_context(v_context);
  return v_id;
end
$function$;

create or replace function ops.set_department_status(
  p_tenant_id      uuid,
  p_department_id  uuid,
  p_status         text,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_current text;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.set_department_status: no tenant scope';
  end if;
  select d.status into v_current
    from ops.departments d
   where d.id = p_department_id and d.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.set_department_status: department not found in this tenant';
  end if;
  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception using errcode = 'OS400', message = format('ops.set_department_status: %L is not a department status', p_status);
  end if;
  if v_current = p_status then
    return;
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  update ops.departments set status = p_status
   where id = p_department_id and tenant_id = p_tenant_id;
  perform ops.pop_event_context(v_context);
end
$function$;

create or replace function ops.create_agent(
  p_tenant_id      uuid,
  p_company_id     uuid,
  p_department_id  uuid,
  p_slug           text,
  p_name           text,
  p_role           text,
  p_source         text,
  p_description    text default null,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context    jsonb;
  v_company    text;
  v_department text;
  v_id         uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_agent: no tenant scope';
  end if;
  select c.status into v_company
    from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_agent: company not found in this tenant';
  end if;
  select d.status into v_department
    from ops.departments d
   where d.id = p_department_id and d.tenant_id = p_tenant_id and d.company_id = p_company_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.create_agent: department not found in this company';
  end if;
  if v_company <> 'active' or v_department <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.create_agent: the company or department is inactive';
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  insert into ops.agents (tenant_id, company_id, department_id, slug, name, role, description)
  values (p_tenant_id, p_company_id, p_department_id, p_slug, p_name, p_role, p_description)
  returning id into v_id;
  perform ops.pop_event_context(v_context);
  return v_id;
end
$function$;

create or replace function ops.set_agent_status(
  p_tenant_id      uuid,
  p_agent_id       uuid,
  p_status         text,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_current text;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.set_agent_status: no tenant scope';
  end if;
  select a.status into v_current
    from ops.agents a
   where a.id = p_agent_id and a.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.set_agent_status: agent not found in this tenant';
  end if;
  if p_status is null or p_status not in ('active', 'inactive') then
    raise exception using errcode = 'OS400', message = format('ops.set_agent_status: %L is not an agent status', p_status);
  end if;
  if v_current = p_status then
    return;
  end if;

  -- Deactivating an agent does not touch its open tasks: they keep their
  -- assignee until they are reassigned or closed (ADR 0015).
  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  update ops.agents set status = p_status
   where id = p_agent_id and tenant_id = p_tenant_id;
  perform ops.pop_event_context(v_context);
end
$function$;

create or replace function ops.create_task(
  p_tenant_id      uuid,
  p_company_id     uuid,
  p_type           text,
  p_title          text,
  p_source         text,
  p_description    text default null,
  p_department_id  uuid default null,
  p_parent_task_id uuid default null,
  p_priority       integer default 100,
  p_due_at         timestamptz default null,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context    jsonb;
  v_company    text;
  v_department text;
  v_id         uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_task: no tenant scope';
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
    type, title, description, priority, due_at)
  values (
    p_tenant_id, p_company_id, p_department_id, p_parent_task_id,
    p_type, p_title, p_description, coalesce(p_priority, 100), p_due_at)
  returning id into v_id;
  perform ops.pop_event_context(v_context);
  return v_id;
end
$function$;

-- Deterministic assignment. No routing, no "best agent": the caller names the
-- agent, and the database decides whether that assignment is valid.
create or replace function ops.assign_task(
  p_tenant_id      uuid,
  p_task_id        uuid,
  p_agent_id       uuid,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_task    ops.tasks;
  v_agent   ops.agents;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.assign_task: no tenant scope';
  end if;
  select t.* into v_task
    from ops.tasks t
   where t.id = p_task_id and t.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.assign_task: task not found in this tenant';
  end if;
  -- Resolved inside the TASK's company: an agent of another company, or of
  -- another tenant, is simply not found.
  select a.* into v_agent
    from ops.agents a
   where a.id = p_agent_id and a.tenant_id = p_tenant_id and a.company_id = v_task.company_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.assign_task: agent not found in this company';
  end if;

  if v_task.status in ('completed', 'failed', 'cancelled') then
    raise exception using errcode = 'OS409', message = format('ops.assign_task: the task is %s', v_task.status);
  end if;
  if v_agent.status <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.assign_task: the agent is inactive';
  end if;
  if v_task.department_id is not null and v_agent.department_id <> v_task.department_id then
    raise exception using errcode = 'OS409', message = 'ops.assign_task: the agent does not belong to the task''s department';
  end if;
  if v_task.assigned_agent_id = p_agent_id then
    return; -- already assigned to this agent: no change, no fact
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  update ops.tasks
     set assigned_agent_id = p_agent_id,
         status = case when status = 'queued' then 'assigned' else status end
   where id = p_task_id and tenant_id = p_tenant_id;
  perform ops.pop_event_context(v_context);
end
$function$;

create or replace function ops.transition_task(
  p_tenant_id      uuid,
  p_task_id        uuid,
  p_to_status      text,
  p_source         text,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns void
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context jsonb;
  v_current text;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.transition_task: no tenant scope';
  end if;
  select t.status into v_current
    from ops.tasks t
   where t.id = p_task_id and t.tenant_id = p_tenant_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.transition_task: task not found in this tenant';
  end if;
  if v_current in ('completed', 'failed', 'cancelled') then
    raise exception using errcode = 'OS409', message = format('ops.transition_task: the task is %s', v_current);
  end if;
  if p_to_status = 'assigned' then
    raise exception using errcode = 'OS409', message = 'ops.transition_task: a task becomes assigned through ops.assign_task';
  end if;
  if v_current = p_to_status then
    return; -- no change, no fact
  end if;
  if p_to_status is null or not ops.task_transition_allowed(v_current, p_to_status) then
    raise exception using errcode = 'OS409', message = format('ops.transition_task: %s -> %s is not a task transition', v_current, p_to_status);
  end if;

  v_context := ops.push_event_context(p_source, p_correlation_id, p_causation_id);
  update ops.tasks set status = p_to_status
   where id = p_task_id and tenant_id = p_tenant_id;
  perform ops.pop_event_context(v_context);
end
$function$;

-- A business fact that is NOT a lifecycle change of a row here (a later phase's
-- `payment.received`, say). Lifecycle namespaces are refused: those facts come
-- from state changes only.
create or replace function ops.record_event(
  p_tenant_id      uuid,
  p_company_id     uuid,
  p_type           text,
  p_source         text,
  p_subject_type   text default null,
  p_subject_id     uuid default null,
  p_payload        jsonb default '{}'::jsonb,
  p_correlation_id uuid default null,
  p_causation_id   uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.record_event: no tenant scope';
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
    payload, correlation_id, causation_id)
  values (
    p_tenant_id, p_company_id, p_type, p_source, p_subject_type, p_subject_id,
    coalesce(p_payload, '{}'::jsonb), p_correlation_id, p_causation_id)
  returning id into v_id;
  return v_id;
end
$function$;

-- The task -> job bridge. Domain depends on execution, never the reverse.
--   * The job's tenant is the TASK ROW's tenant. The payload is passed through as
--     data and is never read for tenancy.
--   * The kind must be allowlisted by ops.task_executable_kinds(), empty in 1C.
--   * Idempotency is scoped to the task: the key is namespaced `task:<id>:<key>`,
--     and a job this task did not request is never adopted — not sequentially,
--     and not when another caller enqueues the same key concurrently.
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
  v_context  jsonb;
  v_task     ops.tasks;
  v_company  text;
  v_key      text;
  v_existing uuid;
  v_job      uuid;
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

  if p_idempotency_key is not null then
    v_key := format('task:%s:%s', p_task_id, p_idempotency_key);
    select j.id into v_existing
      from ops.jobs j
     where j.tenant_id = v_task.tenant_id and j.kind = p_kind and j.idempotency_key = v_key;
    if found then
      if exists (
        select 1 from ops.task_jobs l
         where l.tenant_id = v_task.tenant_id and l.job_id = v_existing and l.task_id = p_task_id
      ) then
        return v_existing; -- the same request, already made: no second link, no second fact
      end if;
      raise exception using
        errcode = 'OS409',
        message = 'ops.request_task_execution: that idempotency key already names a job this task did not request';
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
    values (v_task.tenant_id, p_kind, coalesce(p_payload, '{}'::jsonb), 100, now(), 5, v_key)
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
  perform ops.pop_event_context(v_context);
  return v_job;
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. Grants. Deny first, and grant nothing.
--
-- PostgreSQL gives every new function EXECUTE to PUBLIC, and the per-schema
-- `alter default privileges in schema ops revoke execute on functions from
-- public` in 20260912120000 does NOT remove that global default (measured). So
-- every function created above is revoked explicitly, trigger functions and
-- helpers included.
-- ---------------------------------------------------------------------------

revoke all on table ops.companies, ops.departments, ops.agents, ops.tasks, ops.events, ops.task_jobs
  from public, anon, authenticated, service_role, ops_worker;

revoke all on function ops.derived_event_namespaces() from public;
revoke all on function ops.task_status_transitions() from public;
revoke all on function ops.task_transition_allowed(text, text) from public;
revoke all on function ops.task_executable_kinds() from public;
revoke all on function ops.push_event_context(text, uuid, uuid) from public;
revoke all on function ops.pop_event_context(jsonb) from public;
revoke all on function ops.guard_update_immutable() from public;
revoke all on function ops.refuse_update() from public;
revoke all on function ops.guard_task_insert() from public;
revoke all on function ops.guard_task_update() from public;
revoke all on function ops.guard_event_insert() from public;
revoke all on function ops.emit_lifecycle_event() from public;
revoke all on function ops.create_company(uuid, text, text, text, uuid, uuid) from public;
revoke all on function ops.set_company_status(uuid, uuid, text, text, uuid, uuid) from public;
revoke all on function ops.create_department(uuid, uuid, text, text, text, uuid, uuid) from public;
revoke all on function ops.set_department_status(uuid, uuid, text, text, uuid, uuid) from public;
revoke all on function ops.create_agent(uuid, uuid, uuid, text, text, text, text, text, uuid, uuid) from public;
revoke all on function ops.set_agent_status(uuid, uuid, text, text, uuid, uuid) from public;
revoke all on function ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid) from public;
revoke all on function ops.assign_task(uuid, uuid, uuid, text, uuid, uuid) from public;
revoke all on function ops.transition_task(uuid, uuid, text, text, uuid, uuid) from public;
revoke all on function ops.record_event(uuid, uuid, text, text, text, uuid, jsonb, uuid, uuid) from public;
revoke all on function ops.request_task_execution(uuid, uuid, text, text, jsonb, text, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 9. Assert the end state. The Phase 1A and 1B assertions ran before any of
--    these objects existed, so everything they promised for ops is re-asserted
--    here, next to what this phase adds.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
  v_r   record;
  c_domain_tables constant text[] := array['companies', 'departments', 'agents', 'tasks', 'events', 'task_jobs'];
  -- Every SECURITY DEFINER function in ops. Phase 1C adds none.
  c_definer constant text[] := array[
    'complete_job', 'current_tenant_id', 'enqueue_job', 'fail_job', 'lease_job',
    'purge_inbound_email_ledger', 'reap_expired_leases', 'resume_lease',
    'settle_job_failure', 'worker_heartbeat', 'worker_stopped'];
  c_always_triggers constant text[] := array[
    'companies_guard_update', 'departments_guard_update', 'agents_guard_update',
    'tasks_guard_update', 'events_refuse_update', 'task_jobs_refuse_update'];
  c_origin_triggers constant text[] := array[
    'companies_emit_created', 'companies_emit_status', 'departments_emit_created',
    'departments_emit_status', 'agents_emit_created', 'agents_emit_status',
    'tasks_guard_insert', 'tasks_emit_created', 'tasks_emit_changed',
    'events_guard_insert', 'task_jobs_emit_requested'];
  c_composite_fkeys constant text[] := array[
    'departments_company_fkey', 'agents_company_fkey', 'agents_department_fkey',
    'tasks_company_fkey', 'tasks_department_fkey', 'tasks_agent_fkey',
    'tasks_department_agent_fkey', 'tasks_parent_fkey', 'events_company_fkey',
    'task_jobs_task_fkey', 'task_jobs_job_fkey'];
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

  -- 3. No application role holds ANY privilege on a Company OS table.
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

  -- 7. No function in ops is callable by PUBLIC — neither an explicit PUBLIC
  --    grant nor the NULL ACL that means "the default, which includes PUBLIC".
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'ops function(s) executable by PUBLIC: %', v_bad;
  end if;

  -- 8. The SECURITY DEFINER surface is exactly the pinned Phase 1A/1B set.
  select string_agg(distinct p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.prosecdef and not (p.proname = any (c_definer));
  if v_bad is not null then
    raise exception 'unexpected SECURITY DEFINER function(s) in ops: %', v_bad;
  end if;

  -- 9. A function that takes an explicit tenant is callable by the owner only.
  --    The one Phase 1A exception: service_role may create work through
  --    ops.enqueue_job.
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

  -- 10. The worker still cannot create work.
  if has_function_privilege('ops_worker',
       'ops.enqueue_job(uuid, text, jsonb, integer, timestamptz, integer, text)', 'EXECUTE') then
    raise exception 'ops_worker can execute ops.enqueue_job';
  end if;

  -- 11. Guard triggers exist and survive replica mode; the rest exist.
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

  -- 12. Every composite foreign key that makes a cross-scope row unstorable.
  select string_agg(f.name, ', ') into v_bad
    from unnest(c_composite_fkeys) as f (name)
   where not exists (
     select 1 from pg_constraint k
      join pg_namespace n on n.oid = k.connamespace
     where n.nspname = 'ops' and k.conname = f.name and k.contype = 'f');
  if v_bad is not null then
    raise exception 'composite foreign key(s) missing: %', v_bad;
  end if;

  -- 13. No task may request execution yet.
  if cardinality(ops.task_executable_kinds()) <> 0 then
    raise exception 'ops.task_executable_kinds() is not empty; Phase 1C ships no executable task kind';
  end if;
end
$$;
