-- ADR 0022: the model registry, model pools, agent profiles, and the database
-- as the boundary of which model a run may call.
--
-- WHAT CHANGES
--   1. ops.model_registry: one row per (gateway, exact model), owner data with
--      its classes and an enabled switch. Never seeded: a model id is a vendor
--      decision, recorded by the owner like a price (ADR 0017).
--   2. ops.model_pools (architecture, seeded) and ops.model_pool_members (owner
--      data): a capability asks for a POOL, never a model.
--   3. ops.agent_profiles: what an agent is (objective, capabilities, review and
--      escalation policy, a daily cost ceiling, a pool per capability). Versioned
--      owner data; an agent is not a model.
--   4. ops.start_agent_run: for every provider but the in-process fake, the
--      announced (provider, model) must be one of the run's AUTHORIZED
--      CANDIDATES (its pool's enabled members, authorized for its data class by
--      Q8, with a current price), else the run is refused model_not_authorized,
--      or model_route_unavailable when no candidate exists. Then the agent's
--      daily ceiling: agent_budget_exhausted. The route chosen is recorded in
--      ops.agent_run_routes (pool, candidates, gateway, model).
--   5. ops.agent_run_model_candidates(): the worker's lease-bound read of those
--      candidates, so its router chooses only among them.
--   6. ops.record_agent_run_gateway_report(): the worker's lease-bound record of
--      the upstream provider and the gateway's own cost report. Audit only.
--   7. Q8: OpenRouter can never be authorized for person_text or health here:
--      an authorization would have to bind the upstream provider route, and
--      that binding is not built (ADR 0022 §D).
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. Nothing here authorizes data.

-- ---------------------------------------------------------------------------
-- 1. The registry.
-- ---------------------------------------------------------------------------

create table ops.model_registry (
  id                uuid primary key default gen_random_uuid(),
  gateway           text not null check (gateway ~ '^[a-z][a-z0-9_]{0,31}$' and gateway <> 'fake'),
  model             text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  family            text not null check (family ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  accepted_builds   text[] not null default '{}'
                    check (cardinality(accepted_builds) <= 8
                           and array_position(accepted_builds, null) is null),
  structured_output boolean not null,
  reasoning         boolean not null,
  tools             boolean not null,
  context_class     text not null check (context_class in ('short', 'long')),
  latency_class     text not null check (latency_class in ('fast', 'medium', 'slow')),
  cost_class        text not null check (cost_class in ('low', 'medium', 'high')),
  enabled           boolean not null default true,
  source            text not null check (char_length(source) between 1 and 500),
  recorded_by       text not null check (recorded_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  recorded_at       timestamptz not null default now(),
  changed_by        text check (changed_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  changed_at        timestamptz,
  change_reason     text check (char_length(change_reason) between 1 and 500),
  constraint model_registry_binding_key unique (gateway, model),
  -- An alias moves to another build under the evidence recorded for this one.
  constraint model_registry_pinned check (left(model, 1) <> '~'),
  constraint model_registry_change_recorded check (
    (changed_at is null) = (changed_by is null) and (changed_at is null) = (change_reason is null))
);

comment on table ops.model_registry is
  'ADR 0022: the models the Company OS may route to, one row per gateway and exact model, with the classes the router reads and an enabled switch. Owner data recorded by ops.record_model, never shipped by a migration; only the switch ever changes (ops.set_model_enabled). Q8 authorizations and prices stay separate: a registered model is not an authorized one.';

create function ops.guard_model_registry_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS409', message = 'ops.model_registry: a model is disabled, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.changed_at is not null or new.changed_by is not null then
      raise exception using errcode = 'OS409', message = 'ops.model_registry: a model is born unchanged';
    end if;
    -- Every accepted build is a model id of its own.
    if exists (select 1 from pg_catalog.unnest(new.accepted_builds) b
                where b !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$') then
      raise exception using errcode = 'OS400', message = 'ops.model_registry: an accepted build is not a model id';
    end if;
    new.recorded_at := now();
    return new;
  end if;
  if (pg_catalog.to_jsonb(new) - array['enabled', 'changed_by', 'changed_at', 'change_reason'])
       is distinct from (pg_catalog.to_jsonb(old) - array['enabled', 'changed_by', 'changed_at', 'change_reason']) then
    raise exception using errcode = 'OS409',
      message = 'ops.model_registry: a model''s identity and classes are fixed; only its switch changes';
  end if;
  if new.changed_by is null then
    raise exception using errcode = 'OS409', message = 'ops.model_registry: a switch is recorded with who and why';
  end if;
  new.changed_at := now();
  return new;
end
$$;

create trigger model_registry_guard
  before insert or update or delete on ops.model_registry
  for each row execute function ops.guard_model_registry_change();
alter table ops.model_registry enable always trigger model_registry_guard;

alter table ops.model_registry enable row level security;
alter table ops.model_registry force  row level security;

-- ---------------------------------------------------------------------------
-- 2. Pools. The definitions are architecture; the members are owner data.
-- ---------------------------------------------------------------------------

create table ops.model_pools (
  name        text primary key check (name ~ '^[a-z][a-z0-9_]{0,63}$'),
  purpose     text not null check (char_length(purpose) between 1 and 300),
  model_route text not null check (model_route in ('economy', 'standard', 'reasoning'))
);

comment on table ops.model_pools is
  'ADR 0022: a named set of candidate models a capability or an agent asks for, with the route tier (output ceiling and timeout) its runs use. Definitions ship here; members are owner data (ops.model_pool_members).';

insert into ops.model_pools (name, purpose, model_route) values
  ('reception_low_cost', 'Reception work: triage of inbound enquiries at the lowest cost that handles it.', 'standard'),
  ('general_fast', 'General internal assessments: fast and inexpensive.', 'standard'),
  ('reasoning_medium', 'Escalation for complex work that needs extended reasoning. Unused until a rule escalates to it.', 'reasoning');

create function ops.guard_model_pool_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using errcode = 'OS409', message = 'ops.model_pools: pool definitions change only by a reviewed migration';
end
$$;

create trigger model_pools_guard
  before update or delete on ops.model_pools
  for each row execute function ops.guard_model_pool_change();
alter table ops.model_pools enable always trigger model_pools_guard;

alter table ops.model_pools enable row level security;
alter table ops.model_pools force  row level security;

create table ops.model_pool_members (
  id             uuid primary key default gen_random_uuid(),
  pool           text not null references ops.model_pools (name) on delete restrict,
  registry_id    uuid not null references ops.model_registry (id) on delete restrict,
  rank           integer not null check (rank between 1 and 100),
  added_by       text not null check (added_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  added_at       timestamptz not null default now(),
  removed_by     text check (removed_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  removed_at     timestamptz,
  remove_reason  text check (char_length(remove_reason) between 1 and 500),
  constraint model_pool_members_removal check (
    (removed_at is null) = (removed_by is null) and (removed_at is null) = (remove_reason is null))
);

create unique index model_pool_members_active_member on ops.model_pool_members (pool, registry_id)
  where removed_at is null;
create unique index model_pool_members_active_rank on ops.model_pool_members (pool, rank)
  where removed_at is null;

comment on table ops.model_pool_members is
  'ADR 0022: which registered models a pool offers, in rank order (1 first). Owner data; a member is removed once, with who and why, never deleted. Membership is not authorization: Q8 and the price still filter every candidate.';

create function ops.guard_model_pool_member_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS409', message = 'ops.model_pool_members: a member is removed, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.removed_at is not null then
      raise exception using errcode = 'OS409', message = 'ops.model_pool_members: a member is born active';
    end if;
    new.added_at := now();
    return new;
  end if;
  if old.removed_at is not null then
    raise exception using errcode = 'OS409', message = 'ops.model_pool_members: a removed member is history';
  end if;
  if (pg_catalog.to_jsonb(new) - array['removed_by', 'removed_at', 'remove_reason'])
       is distinct from (pg_catalog.to_jsonb(old) - array['removed_by', 'removed_at', 'remove_reason'])
     or new.removed_by is null then
    raise exception using errcode = 'OS409', message = 'ops.model_pool_members: a member changes only by its recorded removal';
  end if;
  new.removed_at := now();
  return new;
end
$$;

create trigger model_pool_members_guard
  before insert or update or delete on ops.model_pool_members
  for each row execute function ops.guard_model_pool_member_change();
alter table ops.model_pool_members enable always trigger model_pool_members_guard;

alter table ops.model_pool_members enable row level security;
alter table ops.model_pool_members force  row level security;

-- The default pool of each agent run capability. Code, like the capability list.
create function ops.capability_default_pools()
returns table (capability text, pool text)
language sql immutable set search_path = '' as $$
  values ('lead_triage'::pg_catalog.text, 'reception_low_cost'::pg_catalog.text),
         ('task_assessment', 'general_fast');
$$;

-- ---------------------------------------------------------------------------
-- 3. Agent profiles: an agent is not a model.
-- ---------------------------------------------------------------------------

create table ops.agent_profiles (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references ops.tenants (id) on delete restrict,
  company_id                uuid not null,
  agent_id                  uuid not null,
  objective                 text not null check (char_length(objective) between 1 and 1000),
  capabilities              text[] not null check (cardinality(capabilities) between 1 and 16),
  tools                     text[] not null default '{}' check (cardinality(tools) = 0),
  data_classes              text[] not null check (cardinality(data_classes) between 1 and 8),
  escalation_policy         text not null check (escalation_policy in ('human_review_always')),
  review_policy             text not null check (review_policy in ('human_review_required')),
  daily_cost_ceiling_micros bigint not null check (daily_cost_ceiling_micros between 1 and 100000000),
  timezone                  text not null,
  capability_pools          jsonb not null default '{}'::jsonb check (jsonb_typeof(capability_pools) = 'object'),
  recorded_by               text not null check (recorded_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  recorded_at               timestamptz not null default now(),
  superseded_at             timestamptz,
  constraint agent_profiles_agent_fkey foreign key (tenant_id, company_id, agent_id)
    references ops.agents (tenant_id, company_id, id) on delete restrict
);

create unique index agent_profiles_one_current on ops.agent_profiles (tenant_id, agent_id)
  where superseded_at is null;

comment on table ops.agent_profiles is
  'ADR 0022 §G: what an agent is, as versioned owner data: objective, capabilities, tools (none yet), the data classes it may handle, escalation and review policy, a daily cost ceiling the database enforces, and a model pool per capability. No model is named here: the model is chosen per run, among the pool''s authorized candidates. A new version supersedes the current one.';

create function ops.guard_agent_profile_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_key   pg_catalog.text;
  v_value pg_catalog.jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS409', message = 'ops.agent_profiles: a profile is superseded, never deleted';
  end if;
  if tg_op = 'UPDATE' then
    if old.superseded_at is not null
       or (pg_catalog.to_jsonb(new) - 'superseded_at') is distinct from (pg_catalog.to_jsonb(old) - 'superseded_at')
       or new.superseded_at is null then
      raise exception using errcode = 'OS409', message = 'ops.agent_profiles: a profile changes only by being superseded, once';
    end if;
    return new;
  end if;
  if new.superseded_at is not null then
    raise exception using errcode = 'OS409', message = 'ops.agent_profiles: a profile is born current';
  end if;
  if exists (select 1 from pg_catalog.unnest(new.capabilities) c
              where c is null or not exists (select 1 from ops.agent_run_capabilities() k where k.capability = c)) then
    raise exception using errcode = 'OS400', message = 'ops.agent_profiles: a capability is not an agent run capability';
  end if;
  if exists (select 1 from pg_catalog.unnest(new.data_classes) c
              where c is null or c not in ('synthetic', 'test', 'operational', 'identifier', 'person_text', 'health',
                                           'clinical_record', 'derived', 'unclassified')) then
    raise exception using errcode = 'OS400', message = 'ops.agent_profiles: a data class is not one of the closed set';
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception using errcode = 'OS400', message = 'ops.agent_profiles: the time zone is not an IANA name';
  end if;
  for v_key, v_value in select * from pg_catalog.jsonb_each(new.capability_pools) loop
    if not (v_key = any (new.capabilities)) or pg_catalog.jsonb_typeof(v_value) <> 'string'
       or not exists (select 1 from ops.model_pools p where p.name = v_value #>> '{}') then
      raise exception using errcode = 'OS400',
        message = 'ops.agent_profiles: a capability pool names a capability the agent lacks or a pool that does not exist';
    end if;
  end loop;
  new.recorded_at := now();
  return new;
end
$$;

create trigger agent_profiles_guard
  before insert or update or delete on ops.agent_profiles
  for each row execute function ops.guard_agent_profile_change();
alter table ops.agent_profiles enable always trigger agent_profiles_guard;

alter table ops.agent_profiles enable row level security;
alter table ops.agent_profiles force  row level security;

-- ---------------------------------------------------------------------------
-- 4. The candidates: Q8 and the policy filter BEFORE any router.
-- ---------------------------------------------------------------------------

-- The pool a run of this agent and capability uses: the agent's current
-- profile's choice, else the capability's default. Only a pool whose tier is
-- the run's route counts; anything else is no pool.
create function ops.agent_run_pool(p_tenant_id uuid, p_agent_id uuid, p_capability text, p_model_route text)
returns text
language sql stable security invoker set search_path = '' as $$
  select p.name
    from ops.model_pools p
   where p.model_route = p_model_route
     and p.name = coalesce(
           (select ap.capability_pools ->> p_capability
              from ops.agent_profiles ap
             where ap.tenant_id = p_tenant_id and ap.agent_id = p_agent_id and ap.superseded_at is null),
           (select d.pool from ops.capability_default_pools() d where d.capability = p_capability));
$$;

-- The authorized candidates of a pool for a tenant's data of one class and one
-- capability, in rank order: enabled, authorized by Q8 (or exempt), priced now.
create function ops.model_pool_candidates(p_tenant_id uuid, p_pool text, p_data_class text, p_capability text)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'gateway', r.gateway, 'model', r.model, 'rank', m.rank, 'family', r.family,
           'acceptedBuilds', pg_catalog.to_jsonb(r.accepted_builds),
           'structuredOutput', r.structured_output, 'reasoning', r.reasoning,
           'contextClass', r.context_class, 'latencyClass', r.latency_class, 'costClass', r.cost_class)
           order by m.rank), '[]'::pg_catalog.jsonb)
    from ops.model_pool_members m
    join ops.model_registry r on r.id = m.registry_id
   where m.pool = p_pool
     and m.removed_at is null
     and r.enabled
     and r.structured_output
     and ops.current_model_price(r.gateway, r.model, now()) is not null
     and exists (select 1 from ops.model_data_authorized(p_tenant_id, p_data_class, p_capability, r.gateway, r.model) a
                  where a.p_authorized);
$$;

-- The route a started run took, append-only: what the database authorized and
-- what the worker chose. The gateway report is added once, at settlement.
create table ops.agent_run_routes (
  agent_run_id          uuid primary key references ops.agent_runs (id) on delete restrict,
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  agent_id              uuid not null,
  capability            text not null,
  model_pool            text not null references ops.model_pools (name) on delete restrict,
  candidates            jsonb not null check (jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) >= 1),
  gateway               text not null,
  model                 text not null,
  provider_route        text check (provider_route ~ '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$'),
  reported_cost_micros  bigint check (reported_cost_micros between 0 and 1000000000),
  reported_at           timestamptz,
  created_at            timestamptz not null default now()
);

comment on table ops.agent_run_routes is
  'ADR 0022: one row per started run that a gateway executes: the pool, the authorized candidates at start, and the exact gateway and model chosen. The upstream provider and the gateway''s own cost report are added once at settlement, for audit and reconciliation; the charged cost stays the owner''s price (ADR 0017).';

create function ops.guard_agent_run_route_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'OS409', message = 'ops.agent_run_routes: a route is history';
  end if;
  if tg_op = 'INSERT' then
    if new.provider_route is not null or new.reported_cost_micros is not null or new.reported_at is not null then
      raise exception using errcode = 'OS409', message = 'ops.agent_run_routes: a route is born without a gateway report';
    end if;
    return new;
  end if;
  if old.reported_at is not null
     or (pg_catalog.to_jsonb(new) - array['provider_route', 'reported_cost_micros', 'reported_at'])
          is distinct from (pg_catalog.to_jsonb(old) - array['provider_route', 'reported_cost_micros', 'reported_at']) then
    raise exception using errcode = 'OS409', message = 'ops.agent_run_routes: a route gains its gateway report once, and nothing else changes';
  end if;
  new.reported_at := now();
  return new;
end
$$;

create trigger agent_run_routes_guard
  before insert or update or delete on ops.agent_run_routes
  for each row execute function ops.guard_agent_run_route_change();
alter table ops.agent_run_routes enable always trigger agent_run_routes_guard;

alter table ops.agent_run_routes enable row level security;
alter table ops.agent_run_routes force  row level security;

-- The worker's read of the candidates for the run bound to its leased job.
-- Lease-bound; takes no tenant, run or pool.
create function ops.agent_run_model_candidates()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := ops.current_tenant_id();
  v_job    uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run    ops.agent_runs;
  v_class  text;
  v_pool   text;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job;
  if not found then
    raise exception 'ops.agent_run_model_candidates: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  select t.data_class into v_class from ops.tasks t where t.tenant_id = v_run.tenant_id and t.id = v_run.task_id;
  v_pool := ops.agent_run_pool(v_run.tenant_id, v_run.agent_id, v_run.capability, v_run.model_route);
  return pg_catalog.jsonb_build_object(
    'pool', v_pool,
    'candidates', case when v_pool is null then '[]'::pg_catalog.jsonb
                       else ops.model_pool_candidates(v_run.tenant_id, v_pool, v_class, v_run.capability) end);
end
$$;

-- The worker's record of what the gateway reported for the run it is settling.
-- Lease-bound; audit only, never cost.
create function ops.record_agent_run_gateway_report(p_provider_route text, p_reported_cost_micros bigint)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tenant uuid := ops.current_tenant_id();
  v_job    uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run    ops.agent_runs;
begin
  if (p_provider_route is not null and p_provider_route !~ '^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$')
     or (p_reported_cost_micros is not null and (p_reported_cost_micros < 0 or p_reported_cost_micros > 1000000000)) then
    raise exception using errcode = 'OS400', message = 'ops.record_agent_run_gateway_report: a malformed report';
  end if;
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job;
  if not found or v_run.status <> 'running' then
    return 'not_running';
  end if;
  update ops.agent_run_routes
     set provider_route = p_provider_route, reported_cost_micros = p_reported_cost_micros
   where agent_run_id = v_run.id and tenant_id = v_run.tenant_id and reported_at is null;
  return case when found then 'recorded' else 'no_route' end;
end
$$;

-- The agent's own charges today, in its profile's time zone.
create function ops.agent_spend_today(p_tenant_id uuid, p_agent_id uuid, p_timezone text)
returns bigint
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.sum(r.charged_cost_micros), 0)::bigint
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.agent_id = p_agent_id
     and r.started_at >= ops.spend_window_start(p_timezone, now());
$$;

-- The codes only the database decides. A worker's refusal naming one is
-- recorded as `configuration` instead (ops.refuse_agent_run), so a worker
-- cannot dress its own refusal up as one of these gates.
create or replace function ops.agent_run_reserved_error_codes()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['execution_stopped', 'execution_interrupted', 'database_contract',
               'job_failed', 'job_ended_before_start',
               'price_unavailable', 'route_policy_mismatch', 'spend_ceiling_unconfigured',
               'budget_unconfigured', 'budget_exhausted', 'data_not_authorized',
               'route_provider_mismatch',
               'model_route_unavailable', 'model_not_authorized', 'agent_budget_exhausted']::text[];
$function$;

-- ---------------------------------------------------------------------------
-- 5. The start: the candidate gate and the agent ceiling. The 20261001120000
--    function, with two gates added and the route recorded; nothing removed.
-- ---------------------------------------------------------------------------

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
  v_auth       record;
  v_context    jsonb;
  v_pool       text;
  v_candidates jsonb;
  v_profile    ops.agent_profiles;
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
    return 'stopped';
  end if;

  v_code := case
    when v_task.status in ('completed', 'failed', 'cancelled') then 'task_closed'
    when v_task.assigned_agent_id is distinct from v_run.agent_id then 'task_reassigned'
    when v_company is distinct from 'active' then 'company_inactive'
    when v_department is distinct from 'active' then 'department_inactive'
    when v_agent.status is distinct from 'active' then 'agent_inactive'
  end;

  if v_code is null and v_run.pinned_provider is not null and p_provider is distinct from v_run.pinned_provider then
    v_code := 'route_provider_mismatch';
  end if;

  if v_code is null then
    -- BASELINE Q8 (ADR 0020 §D4): the authoritative gate, unchanged.
    select a.p_authorized, a.p_authorization_id into v_auth
      from ops.model_data_authorized(v_run.tenant_id, v_task.data_class, v_run.capability, p_provider, p_model) a;
    if not coalesce(v_auth.p_authorized, false) then
      v_code := 'data_not_authorized';
    end if;
  end if;

  -- ADR 0022 §D: every provider that leaves this process must be one of the
  -- run's authorized candidates. The in-process fake is the only exception.
  if v_code is null and p_provider <> 'fake' then
    v_pool := ops.agent_run_pool(v_run.tenant_id, v_run.agent_id, v_run.capability, v_run.model_route);
    v_candidates := case when v_pool is null then '[]'::jsonb
                         else ops.model_pool_candidates(v_run.tenant_id, v_pool, v_task.data_class, v_run.capability) end;
    if jsonb_array_length(v_candidates) = 0 then
      v_code := 'model_route_unavailable';
    elsif not exists (select 1 from jsonb_array_elements(v_candidates) c
                       where c ->> 'gateway' = p_provider and c ->> 'model' = p_model) then
      v_code := 'model_not_authorized';
    end if;
  end if;

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
      raise exception using
        errcode = 'OS429',
        message = 'ops.start_agent_run: the spend limits cannot absorb this run beside the calls in flight; try again after they settle';
    end if;
    v_code := v_spend.p_code;
    v_limit := v_spend.p_limit_id;
  end if;

  -- ADR 0022 §G: the agent's own daily ceiling, serialised per agent after the
  -- spend locks. Charges include calls still in flight, at their reservation.
  if v_code is null then
    select ap.* into v_profile from ops.agent_profiles ap
     where ap.tenant_id = v_run.tenant_id and ap.agent_id = v_run.agent_id and ap.superseded_at is null;
    if found then
      perform pg_advisory_xact_lock(hashtextextended('ops.agent_budget:' || v_run.agent_id::text, 0));
      if ops.agent_spend_today(v_run.tenant_id, v_run.agent_id, v_profile.timezone) + v_reserved
           > v_profile.daily_cost_ceiling_micros then
        v_code := 'agent_budget_exhausted';
      end if;
    end if;
  end if;

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
         job_attempt = v_attempt, price_id = v_price, reserved_cost_micros = v_reserved,
         data_authorization_id = v_auth.p_authorization_id
   where id = v_run.id;
  if v_pool is not null then
    insert into ops.agent_run_routes (agent_run_id, tenant_id, agent_id, capability, model_pool, candidates, gateway, model)
    values (v_run.id, v_run.tenant_id, v_run.agent_id, v_run.capability, v_pool, v_candidates, p_provider, p_model);
  end if;
  perform ops.pop_event_context(v_context);
  return 'running';
end
$function$;

comment on function ops.start_agent_run(text, text, text, text, integer) is
  'Re-checks every gate, the execution stops, the BASELINE Q8 data authorization, then (ADR 0022) that a provider other than the in-process fake is one of the run''s authorized pool candidates, the price, the spend limits and the agent''s daily ceiling under lock, then records the run as running with its price version, reservation and data authorization, and the route it took. The caller commits this BEFORE calling the provider, and only the returned token running means call. A covering execution stop answers stopped and writes nothing. Codes: data_not_authorized, model_route_unavailable (no authorized candidate), model_not_authorized (not one of them), agent_budget_exhausted. Resolves the run from the live lease; takes no id.';

-- ---------------------------------------------------------------------------
-- 6. Q8: no protected class through OpenRouter until a route binding exists.
-- ---------------------------------------------------------------------------

create or replace function ops.guard_model_data_authorization_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.retired_at is not null or new.retired_by is not null or new.retire_reason is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.model_data_authorizations: an authorization is born in force; retiring it is a separate, recorded act';
  end if;
  if not exists (select 1 from ops.agent_run_capabilities() c where c.capability = new.capability) then
    raise exception using
      errcode = 'OS403',
      message = format('ops.model_data_authorizations: %L is not an agent run capability, so it names no purpose', new.capability);
  end if;
  if new.evidence_verified_at > now() then
    raise exception using
      errcode = 'OS400',
      message = 'ops.model_data_authorizations: evidence cannot be verified in the future';
  end if;
  if new.data_class <> 'operational' and not (new.capability = any (ops.person_content_capabilities())) then
    raise exception using
      errcode = 'OS403',
      message = format('ops.model_data_authorizations: person content is authorized only for a capability whose input is minimised, and %L is not one', new.capability);
  end if;
  if new.data_class <> 'operational' and not ops.model_data_controller_tenant(new.tenant_id) then
    raise exception using
      errcode = 'OS403',
      message = 'ops.model_data_authorizations: person content is authorized only for the tenant that owns the local CRM (owner decision D1)';
  end if;
  -- ADR 0022 §D: a gateway that may route a model to several upstream providers
  -- cannot carry protected data until an authorization binds the provider route.
  if new.provider = 'openrouter' and new.data_class in ('person_text', 'health') then
    raise exception using
      errcode = 'OS403',
      message = 'ops.model_data_authorizations: OpenRouter cannot be authorized for person_text or health until the authorization binds the upstream provider route (ADR 0022)';
  end if;
  new.recorded_at := now();
  return new;
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. Owner acts. The owner credential only; nothing else executes them.
-- ---------------------------------------------------------------------------

create function ops.record_model(
  p_gateway text, p_model text, p_family text, p_accepted_builds text[], p_structured_output boolean,
  p_reasoning boolean, p_tools boolean, p_context_class text, p_latency_class text, p_cost_class text,
  p_source text, p_actor text)
returns uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into ops.model_registry (gateway, model, family, accepted_builds, structured_output, reasoning, tools,
                                  context_class, latency_class, cost_class, source, recorded_by)
  values (p_gateway, p_model, p_family, coalesce(p_accepted_builds, '{}'), p_structured_output, p_reasoning, p_tools,
          p_context_class, p_latency_class, p_cost_class, p_source, p_actor)
  on conflict (gateway, model) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception using errcode = 'OS409', message = 'ops.record_model: that gateway and model are already registered';
  end if;
  return v_id;
end
$$;

create function ops.set_model_enabled(p_gateway text, p_model text, p_enabled boolean, p_reason text, p_actor text)
returns text
language plpgsql volatile security invoker set search_path = '' as $$
begin
  update ops.model_registry
     set enabled = p_enabled, changed_by = p_actor, change_reason = p_reason
   where gateway = p_gateway and model = p_model;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.set_model_enabled: that model is not registered';
  end if;
  return case when p_enabled then 'enabled' else 'disabled' end;
end
$$;

create function ops.add_model_pool_member(p_pool text, p_gateway text, p_model text, p_rank integer, p_actor text)
returns uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_registry uuid;
  v_id       uuid;
begin
  select r.id into v_registry from ops.model_registry r where r.gateway = p_gateway and r.model = p_model;
  if v_registry is null then
    raise exception using errcode = 'OS404', message = 'ops.add_model_pool_member: that model is not registered';
  end if;
  insert into ops.model_pool_members (pool, registry_id, rank, added_by)
  values (p_pool, v_registry, p_rank, p_actor)
  returning id into v_id;
  return v_id;
end
$$;

create function ops.remove_model_pool_member(p_pool text, p_gateway text, p_model text, p_reason text, p_actor text)
returns text
language plpgsql volatile security invoker set search_path = '' as $$
begin
  update ops.model_pool_members m
     set removed_by = p_actor, remove_reason = p_reason
    from ops.model_registry r
   where m.registry_id = r.id and m.pool = p_pool and r.gateway = p_gateway and r.model = p_model
     and m.removed_at is null;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.remove_model_pool_member: that model is not an active member of the pool';
  end if;
  return 'removed';
end
$$;

create function ops.record_agent_profile(
  p_tenant_id uuid, p_agent_id uuid, p_objective text, p_capabilities text[], p_data_classes text[],
  p_daily_cost_ceiling_micros bigint, p_timezone text, p_capability_pools jsonb, p_actor text)
returns uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_agent ops.agents;
  v_id    uuid;
begin
  select a.* into v_agent from ops.agents a where a.tenant_id = p_tenant_id and a.id = p_agent_id for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.record_agent_profile: no such agent in that tenant';
  end if;
  update ops.agent_profiles set superseded_at = now()
   where tenant_id = p_tenant_id and agent_id = p_agent_id and superseded_at is null;
  insert into ops.agent_profiles (tenant_id, company_id, agent_id, objective, capabilities, data_classes,
                                  escalation_policy, review_policy, daily_cost_ceiling_micros, timezone,
                                  capability_pools, recorded_by)
  values (p_tenant_id, v_agent.company_id, p_agent_id, p_objective, p_capabilities, p_data_classes,
          'human_review_always', 'human_review_required', p_daily_cost_ceiling_micros, p_timezone,
          coalesce(p_capability_pools, '{}'::jsonb), p_actor)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Access. Backend only. The worker reaches the registry only through its
--    two lease-bound capabilities.
-- ---------------------------------------------------------------------------

revoke all on table ops.model_registry, ops.model_pools, ops.model_pool_members, ops.agent_profiles,
                    ops.agent_run_routes
  from public, anon, authenticated, service_role, ops_worker, ops_gateway, ops_operator_api;

revoke all on function
  ops.guard_model_registry_change(),
  ops.guard_model_pool_change(),
  ops.guard_model_pool_member_change(),
  ops.capability_default_pools(),
  ops.guard_agent_profile_change(),
  ops.agent_run_pool(uuid, uuid, text, text),
  ops.model_pool_candidates(uuid, text, text, text),
  ops.guard_agent_run_route_change(),
  ops.agent_run_model_candidates(),
  ops.record_agent_run_gateway_report(text, bigint),
  ops.agent_spend_today(uuid, uuid, text),
  ops.agent_run_reserved_error_codes(),
  ops.start_agent_run(text, text, text, text, integer),
  ops.guard_model_data_authorization_insert(),
  ops.record_model(text, text, text, text[], boolean, boolean, boolean, text, text, text, text, text),
  ops.set_model_enabled(text, text, boolean, text, text),
  ops.add_model_pool_member(text, text, text, integer, text),
  ops.remove_model_pool_member(text, text, text, text, text),
  ops.record_agent_profile(uuid, uuid, text, text[], text[], bigint, text, jsonb, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway, ops_operator_api;

grant execute on function
  ops.start_agent_run(text, text, text, text, integer),
  ops.agent_run_model_candidates(),
  ops.record_agent_run_gateway_report(text, bigint)
  to ops_worker;

-- ---------------------------------------------------------------------------
-- 9. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_tables constant pg_catalog.text[] := array['model_registry', 'model_pools', 'model_pool_members',
                                               'agent_profiles', 'agent_run_routes'];
  c_fns constant pg_catalog.text[] := array[
    'guard_model_registry_change', 'guard_model_pool_change', 'guard_model_pool_member_change',
    'capability_default_pools', 'guard_agent_profile_change', 'agent_run_pool', 'model_pool_candidates',
    'guard_agent_run_route_change', 'agent_run_model_candidates', 'record_agent_run_gateway_report',
    'agent_spend_today', 'record_model', 'set_model_enabled', 'add_model_pool_member',
    'remove_model_pool_member', 'record_agent_profile'];
begin
  select pg_catalog.string_agg(c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'model gateway table(s) lack ENABLE + FORCE row level security: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || t.relname, ', ') into v_bad
    from pg_catalog.unnest(c_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.' || t.relname, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a model gateway table: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker' and p.proname in ('agent_run_model_candidates', 'record_agent_run_gateway_report'));
  if v_bad is not null then
    raise exception 'a role can execute a model gateway function it must not: %', v_bad;
  end if;

  -- No model is shipped: the registry and the pool members are owner data.
  if exists (select 1 from ops.model_registry) or exists (select 1 from ops.model_pool_members) then
    raise exception 'a migration must not ship a model or a pool member';
  end if;

  -- Every capability has a default pool on its own route tier.
  if exists (select 1 from ops.agent_run_capabilities() c
              where not exists (select 1 from ops.capability_default_pools() d
                                  join ops.model_pools p on p.name = d.pool
                                 where d.capability = c.capability and p.model_route = c.model_route)) then
    raise exception 'an agent run capability has no default pool on its route tier';
  end if;

  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
       where t.tgrelid in ('ops.model_registry'::pg_catalog.regclass, 'ops.model_pools'::pg_catalog.regclass,
                           'ops.model_pool_members'::pg_catalog.regclass, 'ops.agent_profiles'::pg_catalog.regclass,
                           'ops.agent_run_routes'::pg_catalog.regclass)
         and not t.tgisinternal and t.tgenabled = 'A') <> 5 then
    raise exception 'the model gateway guards are not all ENABLE ALWAYS';
  end if;

  -- No credential-shaped column anywhere in the new tables.
  select pg_catalog.string_agg(a.attrelid::pg_catalog.regclass || '.' || a.attname, ', ') into v_bad
    from pg_catalog.pg_attribute a
   where a.attrelid in ('ops.model_registry'::pg_catalog.regclass, 'ops.model_pool_members'::pg_catalog.regclass,
                        'ops.agent_profiles'::pg_catalog.regclass, 'ops.agent_run_routes'::pg_catalog.regclass)
     and a.attnum > 0 and not a.attisdropped
     and a.attname ~* '(token|secret|password|credential|api_key|apikey)';
  if v_bad is not null then
    raise exception 'a model gateway table holds a credential-shaped column: %', v_bad;
  end if;
end
$end_state$;
