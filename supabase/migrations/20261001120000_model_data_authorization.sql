-- BASELINE Q8 enforcement at the model boundary (ADR 0020 §D and §G; owner
-- decisions D1-D10, 2026-09-27).
--
-- Before this migration Q8 was held at ingress and by convention: the start of an
-- agent run (ops.start_agent_run) checked the kill switch, the price and the spend
-- limits, and nothing about the data, so a task created directly with real text,
-- followed by a requested run, would have reached the configured provider. This
-- migration puts one fail-closed gate at the boundary itself.
--
--   1. A closed data classification. ops.tasks.data_class is set by the trusted
--      creator from provenance and immutable afterwards (SI-71). The admission
--      derives synthetic from the synthetic ingress, and test ONLY for a message
--      on an owner-configured test channel from a sender the owner registered
--      for it (D8: a test channel is not test data); any other free text a lead
--      or patient wrote is presumed health (D3). A direct ops.create_task names
--      a class or is unclassified. Nothing inspects content, and nothing reads a
--      class from a payload or the browser.
--   2. ops.model_data_authorizations: versioned, tenant-scoped owner data, the
--      ADR 0017 pattern. Never a migration row; recorded and retired only by an
--      owner act (npm run ops -- data-auth). Each version binds one tenant, one
--      class, one capability (the purpose), one provider and one exact model, and
--      carries the evidence references the owner decisions require.
--   3. ops.model_data_authorized: the one check. synthetic and test pass with no
--      authorization (today's behaviour), the in-process fake provider passes
--      (nothing leaves the process), and every other class needs a matching
--      authorization in force. Absence denies.
--   4. The gate runs at ops.start_agent_run (the authority: lease-bound, after the
--      kill switch, before the price and the spend reservation), at
--      ops.request_agent_run (an early refusal on the record, with no job) and at
--      the decision-shadow start. A miss is cancelled / data_not_authorized, with
--      no provider call, no retry and no fallback (SI-70).
--   5. Audit: every run records the data class it carried and the authorization
--      version it relied on; a refusal records its code. Codes and ids only.
--
-- What this does NOT do: it records no authorization, enables no real data flow,
-- changes no provider configuration, and does not open the ADR 0018 WhatsApp
-- gate. Content redaction and retention (D6, D7) are the next batch; an
-- authorization carries the retention policy it was granted under.

-- ---------------------------------------------------------------------------
-- 1. Vocabulary.
-- ---------------------------------------------------------------------------

-- The closed classification (ADR 0020 §B), about sensitivity and provenance, not
-- tenant vocabulary. `unclassified` is what a task that named no class is.
create or replace function ops.data_classes()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['synthetic', 'test', 'operational', 'identifier', 'person_text', 'health',
               'clinical_record', 'derived', 'unclassified']::text[];
$function$;

-- The classes an owner may ever authorize for an external model (D2). identifier
-- and clinical_record never are; derived inherits its source's class, so it is
-- authorized as that class; synthetic and test need no authorization.
create or replace function ops.model_authorizable_data_classes()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['operational', 'person_text', 'health']::text[];
$function$;

-- What passes the gate with no authorization: synthetic and test data under their
-- existing rules, and the in-process fake provider, from which nothing leaves. The
-- deployed worker cannot select the fake (engine/models/routingConfig.ts).
create or replace function ops.model_data_class_exempt(p_data_class text, p_provider text)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(p_data_class in ('synthetic', 'test') or p_provider = 'fake', false);
$function$;

-- The capabilities whose input builder minimises person content (ADR 0020 §D8:
-- a field allowlist and structured-identifier redaction, engine/models/
-- leadTriage.ts). Person content is authorized for these only, so an
-- authorization can never open a path that sends identifiers unredacted.
create or replace function ops.person_content_capabilities()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['lead_triage']::text[];
$function$;

-- D1: the clinic is the controller operating Company OS for itself, so person
-- content is authorized only for the tenant that owns the local CRM. Another
-- tenant needs D1 reopened (a processor agreement) first. The one reader of the
-- flag for Q8.
create or replace function ops.model_data_controller_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select coalesce((select t.owns_local_crm from ops.tenants t where t.id = p_tenant_id), false);
$function$;

-- ---------------------------------------------------------------------------
-- 2. The task's class. Added with a constant default (no rewrite, no trigger),
--    then backfilled from the admission for tasks that can still run.
-- ---------------------------------------------------------------------------

alter table ops.tasks add column if not exists data_class text not null default 'unclassified';
alter table ops.tasks drop constraint if exists tasks_data_class_check;
alter table ops.tasks add constraint tasks_data_class_check check (
  data_class in ('synthetic', 'test', 'operational', 'identifier', 'person_text', 'health',
                 'clinical_record', 'derived', 'unclassified'));

-- An admitted task takes its admission's class. No test sender can have been
-- registered before this migration (section 6b creates the registry), so every
-- admitted WhatsApp message, on a test channel or not, is presumed health (D3,
-- D8: a test channel is not test data). A closed task is immutable
-- (tasks_guard_update) and can never be run again, so it keeps unclassified,
-- which denies.
update ops.tasks t
   set data_class = a.data_class
  from (select m.tenant_id, m.task_id,
               case when m.source_kind = 'synthetic' then 'synthetic'
                    else 'health' end as data_class
          from ops.inbound_messages m
         where m.task_id is not null) a
 where t.tenant_id = a.tenant_id and t.id = a.task_id
   and t.status not in ('completed', 'failed', 'cancelled')
   and t.data_class is distinct from a.data_class;

-- ---------------------------------------------------------------------------
-- 3. Authorizations: versioned owner data.
-- ---------------------------------------------------------------------------

create table if not exists ops.model_data_authorizations (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references ops.tenants (id) on delete restrict,
  data_class              text not null,
  -- The purpose: one agent run capability.
  capability              text not null,
  provider                text not null,
  -- The exact model or snapshot, as ops.model_prices names it.
  model                   text not null,
  valid_from              timestamptz not null,
  expires_at              timestamptz not null,
  -- Evidence REFERENCES: opaque pointers to the owner's records, never their
  -- content. The provider/project/model evidence of ADR 0020 §C, and when it was
  -- verified; an authorization expires within 366 days of that verification.
  provider_evidence_ref   text not null,
  evidence_verified_at    timestamptz not null,
  -- D5: API data not used for training, as verified.
  training_excluded       boolean not null,
  -- D5: the contract covers the intended sensitive processing; the DPA.
  contract_ref            text,
  dpa_ref                 text,
  -- D5: zero data retention enabled, or an owner-approved equivalent; the
  -- provider's retention behaviour verified. store:false is neither.
  zero_retention_ref      text,
  retention_evidence_ref  text,
  -- D9: the documented international-transfer mechanism.
  transfer_mechanism_ref  text,
  -- D4: the recorded lawful basis (e.g. a versioned consent record).
  lawful_basis_ref        text,
  -- D6: days AI working content of this class is kept after its review is decided.
  content_retention_days  integer,
  recorded_by             text not null,
  recorded_at             timestamptz not null default now(),
  retired_at              timestamptz,
  retired_by              text,
  retire_reason           text,
  constraint model_data_authorizations_tenant_id_key unique (tenant_id, id),
  constraint model_data_authorizations_class_check check (
    data_class in ('operational', 'person_text', 'health')),
  constraint model_data_authorizations_capability_format check (
    capability ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint model_data_authorizations_provider_format check (
    provider ~ '^[a-z][a-z0-9_]{0,31}$' and provider <> 'fake'),
  constraint model_data_authorizations_model_format check (
    model ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'),
  constraint model_data_authorizations_validity check (
    expires_at > valid_from
    and valid_from >= evidence_verified_at
    and expires_at <= evidence_verified_at + interval '366 days'),
  constraint model_data_authorizations_refs_format check (
        provider_evidence_ref ~ '^[\x21-\x7e]{1,200}$'
    and (contract_ref is null or contract_ref ~ '^[\x21-\x7e]{1,200}$')
    and (dpa_ref is null or dpa_ref ~ '^[\x21-\x7e]{1,200}$')
    and (zero_retention_ref is null or zero_retention_ref ~ '^[\x21-\x7e]{1,200}$')
    and (retention_evidence_ref is null or retention_evidence_ref ~ '^[\x21-\x7e]{1,200}$')
    and (transfer_mechanism_ref is null or transfer_mechanism_ref ~ '^[\x21-\x7e]{1,200}$')
    and (lawful_basis_ref is null or lawful_basis_ref ~ '^[\x21-\x7e]{1,200}$')),
  -- D4, D5, D6, D9: the strict bar for person content. Every reference, training
  -- excluded, and a retention period of at most the owner's 30 days.
  constraint model_data_authorizations_person_content_bar check (
    data_class = 'operational'
    or (contract_ref is not null and dpa_ref is not null and zero_retention_ref is not null
        and retention_evidence_ref is not null and transfer_mechanism_ref is not null
        and lawful_basis_ref is not null and training_excluded)),
  constraint model_data_authorizations_retention_days check (
    (data_class = 'operational' and content_retention_days is null)
    or (data_class <> 'operational' and content_retention_days is not null
        and content_retention_days between 1 and 30)),
  constraint model_data_authorizations_recorded_by_format check (
    recorded_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint model_data_authorizations_retired_whole check (
    (retired_at is null) = (retired_by is null) and (retired_at is null) = (retire_reason is null)),
  constraint model_data_authorizations_retired_by_format check (
    retired_by is null or retired_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint model_data_authorizations_retire_reason_length check (
    retire_reason is null or char_length(btrim(retire_reason)) between 1 and 500)
);

comment on table ops.model_data_authorizations is
  'BASELINE Q8 (ADR 0020): versioned, tenant-scoped owner authorizations for one data class to reach one provider and exact model for one capability. Recorded and retired only by an owner act, never shipped by a migration; absence denies every class but synthetic and test. Evidence columns hold references, never content. Do not put personal data in a retire reason.';

-- One version in force per exact binding; a new one supersedes it.
create unique index if not exists model_data_authorizations_active_binding_key
  on ops.model_data_authorizations (tenant_id, data_class, capability, provider, model)
  where retired_at is null;

alter table ops.model_data_authorizations enable row level security;
alter table ops.model_data_authorizations force  row level security;

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
  -- D1: person content only for the tenant that owns the local CRM.
  if new.data_class <> 'operational' and not ops.model_data_controller_tenant(new.tenant_id) then
    raise exception using
      errcode = 'OS403',
      message = 'ops.model_data_authorizations: person content is authorized only for the tenant that owns the local CRM (owner decision D1)';
  end if;
  -- The database's clock: a recording cannot be backdated.
  new.recorded_at := now();
  return new;
end
$function$;

-- An authorization changes in exactly one way: it is retired once, with who and why.
create or replace function ops.guard_model_data_authorization_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.retired_at is not null then
    raise exception using
      errcode = 'OS409',
      message = format('ops.model_data_authorizations: authorization %s is retired, and a retired version is history', old.id);
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.data_class is distinct from old.data_class
     or new.capability is distinct from old.capability
     or new.provider is distinct from old.provider
     or new.model is distinct from old.model
     or new.valid_from is distinct from old.valid_from
     or new.expires_at is distinct from old.expires_at
     or new.provider_evidence_ref is distinct from old.provider_evidence_ref
     or new.evidence_verified_at is distinct from old.evidence_verified_at
     or new.training_excluded is distinct from old.training_excluded
     or new.contract_ref is distinct from old.contract_ref
     or new.dpa_ref is distinct from old.dpa_ref
     or new.zero_retention_ref is distinct from old.zero_retention_ref
     or new.retention_evidence_ref is distinct from old.retention_evidence_ref
     or new.transfer_mechanism_ref is distinct from old.transfer_mechanism_ref
     or new.lawful_basis_ref is distinct from old.lawful_basis_ref
     or new.content_retention_days is distinct from old.content_retention_days
     or new.recorded_by is distinct from old.recorded_by
     or new.recorded_at is distinct from old.recorded_at
     or new.retired_by is null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.model_data_authorizations: an authorization version is never rewritten; it is only retired, and a change is a new version';
  end if;
  new.retired_at := now();
  return new;
end
$function$;

-- A version in force is never deleted; a retired one is history the owner may
-- delete only while no run relied on it (the runs' foreign key keeps those).
create or replace function ops.guard_model_data_authorization_delete()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.retired_at is null then
    raise exception using
      errcode = 'OS409',
      message = format('ops.model_data_authorizations: authorization %s is in force; it is retired, with who and why, before it can be deleted', old.id);
  end if;
  return old;
end
$function$;

create or replace function ops.refuse_model_data_authorization_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'OS409',
    message = 'ops.model_data_authorizations is never truncated: an authorization is removed only by retiring it';
end
$function$;

drop trigger if exists model_data_authorizations_guard_insert on ops.model_data_authorizations;
create trigger model_data_authorizations_guard_insert
  before insert on ops.model_data_authorizations
  for each row execute function ops.guard_model_data_authorization_insert();
alter table ops.model_data_authorizations enable always trigger model_data_authorizations_guard_insert;

drop trigger if exists model_data_authorizations_guard_update on ops.model_data_authorizations;
create trigger model_data_authorizations_guard_update
  before update on ops.model_data_authorizations
  for each row execute function ops.guard_model_data_authorization_update();
alter table ops.model_data_authorizations enable always trigger model_data_authorizations_guard_update;

drop trigger if exists model_data_authorizations_guard_delete on ops.model_data_authorizations;
create trigger model_data_authorizations_guard_delete
  before delete on ops.model_data_authorizations
  for each row execute function ops.guard_model_data_authorization_delete();
alter table ops.model_data_authorizations enable always trigger model_data_authorizations_guard_delete;

drop trigger if exists model_data_authorizations_refuse_truncate on ops.model_data_authorizations;
create trigger model_data_authorizations_refuse_truncate
  before truncate on ops.model_data_authorizations
  for each statement execute function ops.refuse_model_data_authorization_truncate();
alter table ops.model_data_authorizations enable always trigger model_data_authorizations_refuse_truncate;

-- ---------------------------------------------------------------------------
-- 4. The one check.
-- ---------------------------------------------------------------------------

-- The authorization in force NOW for exactly this binding, or NULL. Exact match on
-- every coordinate; person content only for the tenant that owns the local CRM.
create or replace function ops.model_data_authorization_in_force(
  p_tenant_id  uuid,
  p_data_class text,
  p_capability text,
  p_provider   text,
  p_model      text
)
returns uuid
language sql
stable
security invoker
set search_path to ''
as $function$
  select a.id
    from ops.model_data_authorizations a
   where a.tenant_id = p_tenant_id
     and a.data_class = p_data_class
     and a.capability = p_capability
     and a.provider = p_provider
     and a.model = p_model
     and a.retired_at is null
     and a.valid_from <= now()
     and a.expires_at > now()
     and (a.data_class = 'operational' or ops.model_data_controller_tenant(a.tenant_id))
   order by a.valid_from desc
   limit 1;
$function$;

-- Whether data of this class may cross to this provider and model for this
-- capability now, and the authorization version that allows it (NULL when the
-- class or the provider is exempt). Absence answers false.
create or replace function ops.model_data_authorized(
  p_tenant_id  uuid,
  p_data_class text,
  p_capability text,
  p_provider   text,
  p_model      text
)
returns table (p_authorized boolean, p_authorization_id uuid)
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if ops.model_data_class_exempt(p_data_class, p_provider) then
    return query select true, null::uuid;
    return;
  end if;
  v_id := ops.model_data_authorization_in_force(p_tenant_id, p_data_class, p_capability, p_provider, p_model);
  return query select v_id is not null, v_id;
end
$function$;

comment on function ops.model_data_authorized(uuid, text, text, text, text) is
  'BASELINE Q8 (ADR 0020 §D3): whether data of one class may reach one provider and exact model for one capability now, and the authorization version that allows it. synthetic, test and the in-process fake pass with no authorization; every other class needs a version in force; absence answers false.';

-- The early check at request time, before any provider is known: whether ANY
-- provider could take this class for this capability now.
create or replace function ops.model_data_class_admissible(
  p_tenant_id  uuid,
  p_data_class text,
  p_capability text
)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select coalesce(p_data_class in ('synthetic', 'test'), false)
      or exists (
        select 1
          from ops.model_data_authorizations a
         where a.tenant_id = p_tenant_id
           and a.data_class = p_data_class
           and a.capability = p_capability
           and a.retired_at is null
           and a.valid_from <= now()
           and a.expires_at > now()
           and (a.data_class = 'operational' or ops.model_data_controller_tenant(a.tenant_id)));
$function$;

-- ---------------------------------------------------------------------------
-- 5. The run records its class and the authorization it relied on.
-- ---------------------------------------------------------------------------

alter table ops.agent_runs
  add column if not exists data_class            text,
  add column if not exists data_authorization_id uuid,
  -- The request may pin a run to the in-process provider (the only value):
  -- then no provider but it may start the run. Fixed at creation.
  add column if not exists pinned_provider       text;

-- Unfinished runs take their task's class now, under the Phase 1D.1 guard (which
-- does not yet know the column). A finished run is immutable and keeps NULL: it
-- was recorded before this gate existed.
update ops.agent_runs r
   set data_class = t.data_class
  from ops.tasks t
 where t.tenant_id = r.tenant_id and t.id = r.task_id
   and r.status in ('pending', 'running')
   and r.data_class is null;

-- From here on a row that bypasses the insert guard is unclassified, which denies.
alter table ops.agent_runs alter column data_class set default 'unclassified';

alter table ops.agent_runs drop constraint if exists agent_runs_data_class_check;
alter table ops.agent_runs add constraint agent_runs_data_class_check check (
  data_class is null
  or data_class in ('synthetic', 'test', 'operational', 'identifier', 'person_text', 'health',
                    'clinical_record', 'derived', 'unclassified'));
alter table ops.agent_runs drop constraint if exists agent_runs_data_class_when_open;
alter table ops.agent_runs add constraint agent_runs_data_class_when_open check (
  data_class is not null or status in ('succeeded', 'failed', 'indeterminate', 'cancelled'));
alter table ops.agent_runs drop constraint if exists agent_runs_data_authorization_fkey;
alter table ops.agent_runs add constraint agent_runs_data_authorization_fkey
  foreign key (tenant_id, data_authorization_id)
  references ops.model_data_authorizations (tenant_id, id) on delete restrict;
alter table ops.agent_runs drop constraint if exists agent_runs_pinned_provider_check;
alter table ops.agent_runs add constraint agent_runs_pinned_provider_check check (
  pinned_provider is null or pinned_provider = 'fake');
alter table ops.agent_runs drop constraint if exists agent_runs_pinned_provider_started;
alter table ops.agent_runs add constraint agent_runs_pinned_provider_started check (
  pinned_provider is null or provider is null or provider = pinned_provider);
alter table ops.agent_runs drop constraint if exists agent_runs_authorization_only_when_started;
alter table ops.agent_runs add constraint agent_runs_authorization_only_when_started check (
  data_authorization_id is null or started_at is not null);
create index if not exists agent_runs_data_authorization_idx
  on ops.agent_runs (data_authorization_id)
  where data_authorization_id is not null;

-- A database-only refusal: a worker cannot make its own failure read as one.
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
               'route_provider_mismatch']::text[];
$function$;

-- The Phase 1D.1 insert guard, plus the class: derived from the task, never
-- taken from the caller, and no authorization before a start.
create or replace function ops.guard_agent_run_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_parent_status text;
  v_class         text;
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
     or new.charged_cost_micros is not null or new.spend_limit_id is not null
     or new.data_authorization_id is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.agent_runs: a run is born pending, with no job and no execution fact; every later fact is reached through a transition';
  end if;

  -- A task not found in this company leaves unclassified, which denies; the
  -- composite foreign key then refuses the row.
  select t.data_class into v_class
    from ops.tasks t
   where t.id = new.task_id and t.tenant_id = new.tenant_id and t.company_id = new.company_id;
  new.data_class := coalesce(v_class, 'unclassified');

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

-- The Phase 1D.1 state machine guard (20260917120000, section 5), plus Q8: the
-- class is fixed at creation, and on every write path a run of data that is not
-- exempt starts only with an authorization in force for its exact binding, which
-- is then fixed like the price version.
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

-- ---------------------------------------------------------------------------
-- 6. The task class is immutable (SI-71).
-- ---------------------------------------------------------------------------

create or replace function ops.guard_task_data_class()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.data_class is distinct from old.data_class then
    raise exception using
      errcode = 'OS409',
      message = 'ops.tasks: a task''s data class is fixed at creation by its trusted creator';
  end if;
  return new;
end
$function$;

drop trigger if exists tasks_data_class_immutable on ops.tasks;
create trigger tasks_data_class_immutable
  before update on ops.tasks
  for each row execute function ops.guard_task_data_class();
alter table ops.tasks enable always trigger tasks_data_class_immutable;

-- ---------------------------------------------------------------------------
-- 6b. Registered test senders (owner decision D8). A test channel is NOT test
--     data: anyone may write to a test number. A person-originated message is
--     test data only when it arrives on an owner-configured test channel FROM a
--     sender the owner registered for that channel (a controlled test device).
--     Owner data like the channel itself: never a migration row, never the
--     browser; registered and retired only with the owner's credential.
-- ---------------------------------------------------------------------------

create table if not exists ops.communication_test_senders (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references ops.tenants (id) on delete restrict,
  company_id    uuid not null,
  channel_id    uuid not null,
  -- The sender as the provider attests it in its signed webhook (WhatsApp:
  -- digits with the country code), never a value a payload body claims.
  sender        text not null,
  registered_by text not null,
  registered_at timestamptz not null default now(),
  retired_at    timestamptz,
  retired_by    text,
  retire_reason text,
  constraint communication_test_senders_sender_format check (sender ~ '^[0-9]{6,20}$'),
  constraint communication_test_senders_registered_by_format check (
    registered_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint communication_test_senders_retired_whole check (
    (retired_at is null) = (retired_by is null) and (retired_at is null) = (retire_reason is null)),
  constraint communication_test_senders_retired_by_format check (
    retired_by is null or retired_by ~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$'),
  constraint communication_test_senders_retire_reason_length check (
    retire_reason is null or char_length(btrim(retire_reason)) between 1 and 500),
  constraint communication_test_senders_channel_fkey
    foreign key (tenant_id, company_id, channel_id)
    references ops.communication_channels (tenant_id, company_id, id) on delete restrict
);

comment on table ops.communication_test_senders is
  'BASELINE Q8, owner decision D8: the senders whose messages on one owner-configured test channel are test data. Any other person-originated message is presumed health. Registered and retired only by the owner; never shipped by a migration.';

create unique index if not exists communication_test_senders_active_key
  on ops.communication_test_senders (channel_id, sender)
  where retired_at is null;

alter table ops.communication_test_senders enable row level security;
alter table ops.communication_test_senders force  row level security;

create or replace function ops.guard_test_sender_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if new.retired_at is not null or new.retired_by is not null or new.retire_reason is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.communication_test_senders: a registration is born in force; retiring it is a separate, recorded act';
  end if;
  if not exists (select 1 from ops.communication_channels c
                  where c.tenant_id = new.tenant_id and c.company_id = new.company_id
                    and c.id = new.channel_id and c.mode = 'test') then
    raise exception using
      errcode = 'OS409',
      message = 'ops.communication_test_senders: a test sender is registered only on a test channel';
  end if;
  new.registered_at := now();
  return new;
end
$function$;

-- A registration changes in exactly one way: it is retired once, with who and why.
create or replace function ops.guard_test_sender_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.retired_at is not null
     or new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.channel_id is distinct from old.channel_id
     or new.sender is distinct from old.sender
     or new.registered_by is distinct from old.registered_by
     or new.registered_at is distinct from old.registered_at
     or new.retired_by is null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.communication_test_senders: a registration is never rewritten; it is only retired, once';
  end if;
  new.retired_at := now();
  return new;
end
$function$;

create or replace function ops.guard_test_sender_delete()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.retired_at is null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.communication_test_senders: a registration in force is retired, with who and why, before it can be deleted';
  end if;
  return old;
end
$function$;

create or replace function ops.refuse_test_sender_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using
    errcode = 'OS409',
    message = 'ops.communication_test_senders is never truncated: a registration is removed only by retiring it';
end
$function$;

drop trigger if exists communication_test_senders_guard_insert on ops.communication_test_senders;
create trigger communication_test_senders_guard_insert
  before insert on ops.communication_test_senders
  for each row execute function ops.guard_test_sender_insert();
alter table ops.communication_test_senders enable always trigger communication_test_senders_guard_insert;

drop trigger if exists communication_test_senders_guard_update on ops.communication_test_senders;
create trigger communication_test_senders_guard_update
  before update on ops.communication_test_senders
  for each row execute function ops.guard_test_sender_update();
alter table ops.communication_test_senders enable always trigger communication_test_senders_guard_update;

drop trigger if exists communication_test_senders_guard_delete on ops.communication_test_senders;
create trigger communication_test_senders_guard_delete
  before delete on ops.communication_test_senders
  for each row execute function ops.guard_test_sender_delete();
alter table ops.communication_test_senders enable always trigger communication_test_senders_guard_delete;

drop trigger if exists communication_test_senders_refuse_truncate on ops.communication_test_senders;
create trigger communication_test_senders_refuse_truncate
  before truncate on ops.communication_test_senders
  for each statement execute function ops.refuse_test_sender_truncate();
alter table ops.communication_test_senders enable always trigger communication_test_senders_refuse_truncate;

-- Whether this sender is registered, now, for this channel, and the channel is a
-- test channel. The one predicate the admission asks.
create or replace function ops.registered_test_sender(p_tenant_id uuid, p_channel_id uuid, p_sender text)
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select exists (
    select 1
      from ops.communication_test_senders s
      join ops.communication_channels c
        on c.tenant_id = s.tenant_id and c.company_id = s.company_id and c.id = s.channel_id
     where s.tenant_id = p_tenant_id and s.channel_id = p_channel_id and s.sender = p_sender
       and s.retired_at is null and c.mode = 'test');
$function$;

-- Register a controlled test device on one test channel. The same registration
-- again returns it. SECURITY INVOKER, EXECUTE granted to no role.
create or replace function ops.register_test_sender(
  p_tenant_id  uuid,
  p_channel_id uuid,
  p_sender     text,
  p_actor      text
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_channel ops.communication_channels;
  v_id      uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.register_test_sender: no tenant scope';
  end if;
  if p_sender is null or p_sender !~ '^[0-9]{6,20}$' then
    raise exception using errcode = 'OS400', message = 'ops.register_test_sender: the sender is digits with the country code, 6 to 20 of them';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.register_test_sender: the actor is missing or malformed';
  end if;
  select c.* into v_channel from ops.communication_channels c
   where c.tenant_id = p_tenant_id and c.id = p_channel_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.register_test_sender: channel not found in this tenant';
  end if;
  if v_channel.mode <> 'test' then
    raise exception using errcode = 'OS409', message = 'ops.register_test_sender: a test sender is registered only on a test channel';
  end if;
  select s.id into v_id from ops.communication_test_senders s
   where s.channel_id = p_channel_id and s.sender = p_sender and s.retired_at is null;
  if found then
    return v_id; -- already registered
  end if;
  insert into ops.communication_test_senders (tenant_id, company_id, channel_id, sender, registered_by)
  values (p_tenant_id, v_channel.company_id, p_channel_id, p_sender, p_actor)
  returning id into v_id;
  return v_id;
end
$function$;

-- Retire a registration: that sender's later messages are health again.
create or replace function ops.retire_test_sender(
  p_test_sender_id uuid,
  p_reason         text,
  p_actor          text
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = 'OS400', message = 'ops.retire_test_sender: a reason is required, at most 500 characters';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.retire_test_sender: the actor is missing or malformed';
  end if;
  perform 1 from ops.communication_test_senders s where s.id = p_test_sender_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.retire_test_sender: registration not found';
  end if;
  update ops.communication_test_senders
     set retired_by = p_actor, retire_reason = p_reason
   where id = p_test_sender_id and retired_at is null;
  return found;
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. Classification at creation.
-- ---------------------------------------------------------------------------

-- The Phase 1D.1 create (20260917120000), plus the class. A caller that names none
-- creates an unclassified task, which no model may read. The same idempotency key
-- for the same request under another class is refused, never answered with a task
-- of a class the caller did not ask for.
drop function if exists ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid, text);
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
  p_idempotency_key text default null,
  p_data_class      text default null
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_context        jsonb;
  v_company        text;
  v_department     text;
  v_id             uuid;
  v_fingerprint    text;
  v_existing_id    uuid;
  v_existing_fp    text;
  v_existing_class text;
  v_class          text := coalesce(p_data_class, 'unclassified');
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.create_task: no tenant scope';
  end if;
  if not (v_class = any (ops.data_classes())) then
    raise exception using errcode = 'OS400', message = 'ops.create_task: the data class is not one of the closed classification';
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
    select t.id, t.request_fingerprint, t.data_class into v_existing_id, v_existing_fp, v_existing_class
      from ops.tasks t
     where t.tenant_id = p_tenant_id and t.idempotency_key = p_idempotency_key;
    if found then
      if v_existing_fp = v_fingerprint and v_existing_class = v_class then
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
    type, title, description, priority, due_at, idempotency_key, data_class)
  values (
    p_tenant_id, p_company_id, p_department_id, p_parent_task_id,
    p_type, p_title, p_description, coalesce(p_priority, 100), p_due_at, p_idempotency_key, v_class)
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_id;
  perform ops.pop_event_context(v_context);

  if v_id is null then
    -- A concurrent create with this key committed first: answer as a replay would.
    select t.id, t.request_fingerprint, t.data_class into v_existing_id, v_existing_fp, v_existing_class
      from ops.tasks t
     where t.tenant_id = p_tenant_id and t.idempotency_key = p_idempotency_key;
    if v_existing_fp = v_fingerprint and v_existing_class = v_class then
      return v_existing_id;
    end if;
    raise exception using
      errcode = 'OS409',
      message = 'ops.create_task: that idempotency key already names a different task request';
  end if;
  return v_id;
end
$function$;

-- The one admission (20260918150000, section 8), plus the class it derives from
-- provenance: synthetic from the synthetic ingress; test only for a message on an
-- owner-configured test channel from a sender registered for it (D8: a test
-- channel is not test data); and health for any other free text a lead or
-- patient wrote (D3), an unknown sender on a test channel included.
create or replace function ops.admit_inbound_core(
  p_tenant_id           uuid,
  p_company_id          uuid,
  p_agent_id            uuid,
  p_source_kind         text,
  p_external_message_id text,
  p_contact_ref         text,
  p_body                text,
  p_source              text,
  p_do_not_contact      boolean,
  p_received_at         timestamptz,
  p_channel_id          uuid,
  p_conversation_id     uuid,
  p_contact_resolution  text,
  p_crm_contact_ref     text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_fingerprint text;
  v_key         text;
  v_id          uuid;
  v_existing    ops.inbound_messages;
  v_task        uuid;
  v_run         uuid;
  v_class       text;
begin
  if p_tenant_id is null or p_company_id is null then
    raise exception using errcode = 'OS401', message = 'admission: no tenant scope';
  end if;
  if p_source_kind is null or p_source_kind not in ('synthetic', 'whatsapp') then
    raise exception using errcode = 'OS403', message = 'admission: unknown source kind';
  end if;
  if p_external_message_id is null or p_external_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400',
      message = 'admission: an external message id is 1 to 200 printable characters';
  end if;
  if p_contact_ref is null or p_contact_ref !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400',
      message = 'admission: a contact reference is 1 to 200 printable characters';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_.:-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'admission: the source is missing or malformed';
  end if;
  -- Bounded well below the task description's 10000, so an oversize body is a
  -- typed refusal here rather than a CHECK violation whose DETAIL would print it.
  if p_body is null or p_body !~ '\S' or char_length(p_body) > 4000 then
    raise exception using errcode = 'OS400',
      message = 'admission: the message body is empty or longer than 4000 characters';
  end if;
  if p_received_at is null or p_received_at > now() + interval '1 minute' then
    raise exception using errcode = 'OS400', message = 'admission: received_at is missing or in the future';
  end if;

  perform 1 from ops.companies c
   where c.id = p_company_id and c.tenant_id = p_tenant_id
     for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'admission: company not found in this tenant';
  end if;

  -- BASELINE Q8: the class comes from provenance, never from the payload or the
  -- content, and nothing downgrades it.
  v_class := case
    when p_source_kind = 'synthetic' then 'synthetic'
    when p_source_kind = 'whatsapp'
         and ops.registered_test_sender(p_tenant_id, p_channel_id, p_contact_ref) then 'test'
    else 'health'
  end;

  -- Injective: every field is its own element of a jsonb array.
  v_fingerprint := encode(sha256(convert_to(
    jsonb_build_array('inbound.v2', p_source_kind, p_contact_ref, p_body)::text, 'UTF8')), 'hex');
  v_key := format('inbound:%s:%s', p_source_kind,
                  encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex'));

  insert into ops.inbound_messages (
    tenant_id, company_id, source_kind, external_message_id,
    contact_ref, do_not_contact, body_fingerprint, received_at,
    channel_id, conversation_id, contact_resolution, crm_contact_ref)
  values (
    p_tenant_id, p_company_id, p_source_kind, p_external_message_id,
    p_contact_ref, coalesce(p_do_not_contact, true), v_fingerprint, p_received_at,
    p_channel_id, p_conversation_id, p_contact_resolution, p_crm_contact_ref)
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
      raise exception using errcode = 'OS429',
        message = 'admission: the admission this message conflicted with no longer exists; retry';
    end if;
    if v_existing.body_fingerprint <> v_fingerprint then
      raise exception using errcode = 'OS409',
        message = 'admission: that message id was already admitted with a different message';
    end if;
    if v_existing.company_id <> p_company_id
       or v_existing.channel_id is distinct from p_channel_id then
      raise exception using errcode = 'OS409',
        message = 'admission: that message id was already admitted for another company or channel';
    end if;
    if v_existing.task_id is not null and v_existing.agent_run_id is not null then
      -- A replay: answer with the work it already became, and do nothing else.
      return jsonb_build_object(
        'inbound_message_id', v_existing.id,
        'task_id', v_existing.task_id,
        'agent_run_id', v_existing.agent_run_id,
        'replayed', true);
    end if;
    v_id := v_existing.id;
  end if;

  -- The task carries the body, because the runtime's prompt context is built
  -- from the task. The title is a constant: no sender reaches the prompt.
  v_task := ops.create_task(
    p_tenant_id, p_company_id, 'lead_triage', 'Lead triage', p_source, p_body,
    null, null, 100, null, null, null, v_key, v_class);

  perform ops.assign_task(p_tenant_id, v_task, p_agent_id, p_source);

  v_run := ops.request_agent_run(
    p_tenant_id, v_task, p_agent_id, 'lead_triage', v_key, p_source);

  update ops.inbound_messages
     set task_id = coalesce(task_id, v_task),
         agent_run_id = coalesce(agent_run_id, v_run)
   where id = v_id;

  -- Identifiers and shape only: never the body, the sender or a fingerprint.
  perform ops.record_event(
    p_tenant_id, p_company_id, 'communication.received', p_source, 'task', v_task,
    jsonb_strip_nulls(jsonb_build_object(
      'inbound_message_id', v_id,
      'source_kind', p_source_kind,
      'conversation_id', p_conversation_id,
      'contact_resolution', p_contact_resolution,
      'do_not_contact', coalesce(p_do_not_contact, true))),
    null, null, format('%s:received', v_key));

  perform ops.record_event(
    p_tenant_id, p_company_id, 'lead_triage.admitted', p_source, 'task', v_task,
    jsonb_build_object('inbound_message_id', v_id, 'agent_run_id', v_run),
    null, null, format('%s:admitted', v_key));

  return jsonb_build_object(
    'inbound_message_id', v_id,
    'task_id', v_task,
    'agent_run_id', v_run,
    'replayed', false);
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. The gate: at the request (early), at the start (the authority) and at the
--    decision-shadow start.
-- ---------------------------------------------------------------------------

-- The Phase 1D.1 request (20260917120000), plus the early Q8 refusal: after the
-- kill switch (a stop refuses first, owner decision E), before spend, a class no
-- authorization of any provider covers for this capability is refused on the
-- record, with no job. A request may instead pin the run to the in-process
-- provider (`fake`, the only value): nothing leaves the process, so the early
-- refusal does not apply, and the start refuses any other provider for that run
-- (route_provider_mismatch). An unpinned request is refused exactly as before.
drop function if exists ops.request_agent_run(uuid, uuid, uuid, text, text, text, uuid);
create or replace function ops.request_agent_run(
  p_tenant_id       uuid,
  p_task_id         uuid,
  p_agent_id        uuid,
  p_capability      text,
  p_idempotency_key text,
  p_source          text,
  p_retry_of_run_id uuid default null,
  p_pinned_provider text default null
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
  if p_pinned_provider is not null and p_pinned_provider <> 'fake' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.request_agent_run: a run can be pinned only to the in-process provider';
  end if;
  perform ops.require_read_committed('ops.request_agent_run');

  -- The v1 fingerprint, unchanged for an unpinned request; a pin is part of the
  -- request, so the same key with another pin is a different request.
  v_fingerprint := encode(sha256(convert_to(concat_ws('|',
    'agent_run.request.v1', coalesce(p_task_id::text, ''), coalesce(p_agent_id::text, ''),
    coalesce(p_capability, ''), coalesce(p_retry_of_run_id::text, '')), 'UTF8')), 'hex');
  if p_pinned_provider is not null then
    v_fingerprint := encode(sha256(convert_to(concat_ws('|', v_fingerprint, 'pinned', p_pinned_provider), 'UTF8')), 'hex');
  end if;

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
    capability, model_route, idempotency_key, request_fingerprint, correlation_id, requested_by,
    pinned_provider)
  values (
    p_tenant_id, v_task.company_id, v_agent.department_id, p_task_id, p_agent_id, p_retry_of_run_id,
    p_capability, v_route, p_idempotency_key, v_fingerprint, v_correlation, p_source,
    p_pinned_provider)
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

  -- BASELINE Q8, at request time (ADR 0020 §D4): data no authorization of any
  -- provider covers for this capability is refused now, with no job. The start
  -- re-checks the exact binding; this can only refuse early, never admit a call.
  if p_pinned_provider is null
     and not ops.model_data_class_admissible(p_tenant_id, v_task.data_class, p_capability) then
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused', error_code = 'data_not_authorized'
     where id = v_run;
    perform ops.pop_event_context(v_context);
    return v_run;
  end if;

  -- Spend, at request time (20260917120000, unchanged).
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

-- The Phase 1D.1 start (20260917120000), plus the AUTHORITATIVE Q8 gate (SI-70):
-- lease-bound, after the kill switch (a stop holds, owner decision B) and before
-- the route, the price and the spend reservation. The task's class, the run's
-- capability and the provider and model this worker would call must match an
-- authorization in force, unless the class or the provider is exempt. A miss is
-- cancelled / data_not_authorized: no call, no retry, no other provider. The
-- authorization relied on is recorded on the run.
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

  if v_code is null and v_run.pinned_provider is not null and p_provider is distinct from v_run.pinned_provider then
    -- Admitted at its request only because it was pinned to the in-process
    -- provider: any other provider is a route that request never proved.
    v_code := 'route_provider_mismatch';
  end if;

  if v_code is null then
    -- BASELINE Q8 (ADR 0020 §D4): the authoritative gate. The class is the task's,
    -- fixed at creation; the binding is exact. Not transient, so a miss refuses.
    select a.p_authorized, a.p_authorization_id into v_auth
      from ops.model_data_authorized(v_run.tenant_id, v_task.data_class, v_run.capability, p_provider, p_model) a;
    if not coalesce(v_auth.p_authorized, false) then
      v_code := 'data_not_authorized';
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
         job_attempt = v_attempt, price_id = v_price, reserved_cost_micros = v_reserved,
         data_authorization_id = v_auth.p_authorization_id
   where id = v_run.id;
  perform ops.pop_event_context(v_context);
  return 'running';
end
$function$;

comment on function ops.start_agent_run(text, text, text, text, integer) is
  'Re-checks every gate, the execution stops, the BASELINE Q8 data authorization, the price and the spend limits under lock, then records the run as running with its price version, reservation and the data authorization it relied on. The caller commits this BEFORE calling the provider, and only the returned token running means call. A covering execution stop answers stopped and writes nothing: the caller defers the job (ops.defer_job) in the same transaction. Data no authorization in force covers for this exact provider and model is cancelled data_not_authorized. A run another attempt started is settled indeterminate; a run is started once. Resolves the run from the live lease; takes no id.';

-- A shadow evaluation refused for its data is refused on the record.
alter table ops.decision_evaluations drop constraint decision_evaluations_refusal_code_check;
alter table ops.decision_evaluations
  add constraint decision_evaluations_refusal_code_check
    check (refusal_code in ('stopped', 'not_eligible', 'policy_retired', 'data_not_authorized'));

-- The Phase 2D.2 start (20260926120000), plus the same Q8 check (ADR 0020 §D4),
-- after the stop (which holds) and before the provider is asked. The existing
-- origin gate stays as defence in depth. The purpose is the job kind, which no
-- authorization can name, so only exempt data or the in-process fake ever passes.
create or replace function ops.start_shadow_decision(p_provider_kind pg_catalog.text, p_provider_id pg_catalog.text,
                                                     p_provider_version pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job        ops.jobs := ops.leased_job();
  v_eval       ops.decision_evaluations;
  v_item       ops.review_items;
  v_input      pg_catalog.jsonb;
  v_print      pg_catalog.text;
  v_class      pg_catalog.text;
  v_authorized pg_catalog.bool;
begin
  if p_provider_kind is null or p_provider_kind not in ('fake', 'jev', 'none')
     or p_provider_id is null or p_provider_id !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     or p_provider_version is null or p_provider_version !~ '^[a-z0-9][a-z0-9._-]{0,63}$' then
    raise exception using errcode = 'OS400', message = 'ops.start_shadow_decision: bad provider identity';
  end if;
  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = v_job.tenant_id and e.job_id = v_job.id
     for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'missing');
  end if;
  if v_eval.status = 'running' then
    update ops.decision_evaluations
       set status = 'indeterminate', policy_outcome = 'provider_indeterminate',
           error_code = 'attempt_interrupted', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'indeterminate', 'evaluationId', v_eval.id);
  end if;
  if v_eval.status <> 'pending' then
    return pg_catalog.jsonb_build_object('status', v_eval.status, 'evaluationId', v_eval.id);
  end if;

  -- A request made under a policy since retired is not evaluated under it.
  if exists (select 1 from ops.decision_policies p where p.version = v_eval.policy_version and p.retired_at is not null) then
    update ops.decision_evaluations
       set status = 'refused', refusal_code = 'policy_retired', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'refused', 'evaluationId', v_eval.id);
  end if;

  select * into v_item from ops.review_items r where r.tenant_id = v_eval.tenant_id and r.id = v_eval.review_item_id;
  v_input := ops.decision_input_for_review(v_eval.tenant_id, v_eval.review_item_id);
  if not ops.cos_review_decidable(v_eval.tenant_id, v_item) or v_input is null then
    update ops.decision_evaluations
       set status = 'refused', refusal_code = 'not_eligible', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'refused', 'evaluationId', v_eval.id);
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.covering_execution_stop(v_eval.tenant_id, v_job.kind, v_eval.company_id, v_eval.department_id,
                                 v_eval.agent_id) is not null then
    return pg_catalog.jsonb_build_object('status', 'stopped', 'evaluationId', v_eval.id);
  end if;

  -- BASELINE Q8: the evaluated content derives from the reviewed task, so it
  -- carries that task's class (derived inherits its source).
  select t.data_class into v_class
    from ops.tasks t
   where t.tenant_id = v_item.tenant_id and t.id = v_item.task_id;
  select a.p_authorized into v_authorized
    from ops.model_data_authorized(v_eval.tenant_id, v_class, 'decision.shadow_evaluate',
                                   p_provider_kind, p_provider_id) a;
  if not coalesce(v_authorized, false) then
    update ops.decision_evaluations
       set status = 'refused', refusal_code = 'data_not_authorized', settled_at = now()
     where id = v_eval.id;
    return pg_catalog.jsonb_build_object('status', 'refused', 'evaluationId', v_eval.id);
  end if;

  v_print := 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_input::pg_catalog.text, 'UTF8')), 'hex');
  update ops.decision_evaluations
     set status = 'running', started_at = now(), provider_kind = p_provider_kind,
         provider_id = p_provider_id, provider_version = p_provider_version, input_fingerprint = v_print
   where id = v_eval.id;
  return pg_catalog.jsonb_build_object('status', 'running', 'evaluationId', v_eval.id,
                                       'policyVersion', v_eval.policy_version,
                                       'vectorVersion', ops.decision_policy_vector_version(v_eval.policy_version),
                                       'inputFingerprint', v_print, 'input', v_input);
end
$$;


-- ---------------------------------------------------------------------------
-- 8b. The browser and the decision shadow take their test scope from the
--     trusted class (owner decision D8: a test channel is not test data). A
--     review is browser-decidable, its advice shown on explicit open, and its
--     decision-shadow input built only when its task is synthetic or test; the
--     origin checks stay as defence in depth. The admission already decided
--     the class; nothing here repeats the test-sender rule.
-- ---------------------------------------------------------------------------

create or replace function ops.cos_review_decidable(p_tenant pg_catalog.uuid, r ops.review_items) returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select r.capability = 'lead_triage'
     and exists (select 1 from ops.tasks t
                  where t.tenant_id = p_tenant and t.id = r.task_id and t.data_class in ('synthetic', 'test'))
     and exists (
    select 1 from ops.inbound_messages i
      left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
     where i.tenant_id = p_tenant and i.task_id = r.task_id
       and (i.source_kind = 'synthetic' or (i.source_kind = 'whatsapp' and ch.mode = 'test')));
$$;

create or replace function ops.read_review_advice(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  -- The tenant lookup first, before any other branch: a foreign review is OS404.
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  if v_item.capability <> 'lead_triage' then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'withheld', 'capability_not_pinned');
  end if;
  -- The origin, read at call time: a synthetic admission, or a WhatsApp
  -- admission on a channel that is still in test mode. No admission row, any
  -- other kind, or a channel no longer in test mode is withheld.
  if not exists (
    select 1 from ops.inbound_messages i
      left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
     where i.tenant_id = p_tenant_id and i.task_id = v_item.task_id
       and (i.source_kind = 'synthetic' or (i.source_kind = 'whatsapp' and ch.mode = 'test')))
     or not exists (select 1 from ops.tasks t
                     where t.tenant_id = p_tenant_id and t.id = v_item.task_id
                       and t.data_class in ('synthetic', 'test')) then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'withheld', 'origin_not_synthetic_or_test');
  end if;
  if not ops.agent_run_result_valid('lead_triage', v_item.proposed) then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'withheld', 'contract_invalid');
  end if;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'reviewId', v_item.id, 'capability', 'lead_triage',
    'outcome', v_item.proposed -> 'outcome', 'intent', v_item.proposed -> 'intent',
    'priority', v_item.proposed -> 'priority', 'needsHumanReview', v_item.proposed -> 'needs_human_review',
    'flags', v_item.proposed -> 'flags', 'summary', v_item.proposed -> 'summary',
    'recommendedNextAction', v_item.proposed -> 'recommended_next_action');
end
$$;

create or replace function ops.decision_input_for_review(p_tenant_id pg_catalog.uuid, p_review_item_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item   ops.review_items;
  v_result pg_catalog.jsonb;
  v_source pg_catalog.text;
begin
  select * into v_item from ops.review_items r where r.tenant_id = p_tenant_id and r.id = p_review_item_id;
  if not found or v_item.capability <> 'lead_triage' then
    return null;
  end if;
  select r.result into v_result from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.id = v_item.agent_run_id and r.status = 'succeeded';
  if v_result is null or pg_catalog.jsonb_typeof(v_result) <> 'object' then
    return null;
  end if;
  select case when i.source_kind = 'synthetic' then 'synthetic'
              when i.source_kind = 'whatsapp' and ch.mode = 'test' then 'whatsapp_test' end
    into v_source
    from ops.inbound_messages i
    left join ops.communication_channels ch on ch.tenant_id = i.tenant_id and ch.id = i.channel_id
   where i.tenant_id = p_tenant_id and i.task_id = v_item.task_id
   limit 1;
  if v_source is null or not exists (select 1 from ops.tasks t
                                      where t.tenant_id = p_tenant_id and t.id = v_item.task_id
                                        and t.data_class in ('synthetic', 'test')) then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'version', 'decision_input.v1',
    'subject', 'lead_triage.review',
    'sourceClass', v_source,
    'contactPolicy', case when v_item.do_not_contact then 'do_not_contact' else 'contactable' end,
    'triage', pg_catalog.jsonb_build_object(
      'outcome', case when v_result ->> 'outcome' in ('triaged', 'needs_input', 'out_of_scope')
                      then v_result ->> 'outcome' end,
      'intent', case when v_result ->> 'intent' in ('book_appointment', 'pricing', 'information', 'support', 'other')
                     then v_result ->> 'intent' end,
      'priority', case when v_result ->> 'priority' in ('low', 'normal', 'high') then v_result ->> 'priority' end,
      'flags', coalesce((select pg_catalog.jsonb_agg(distinct f order by f)
                           from pg_catalog.jsonb_array_elements_text(
                                  case when pg_catalog.jsonb_typeof(v_result -> 'flags') = 'array'
                                       then v_result -> 'flags' else '[]'::pg_catalog.jsonb end) f
                          where f in ('possible_crisis', 'minor', 'out_of_scope', 'already_a_patient', 'spam', 'unclear')),
                        '[]'::pg_catalog.jsonb),
      'needsHumanReview', case when pg_catalog.jsonb_typeof(v_result -> 'needs_human_review') = 'boolean'
                               then (v_result ->> 'needs_human_review')::pg_catalog.bool end));
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Owner services. SECURITY INVOKER, EXECUTE granted to no role.
-- ---------------------------------------------------------------------------

-- Record one authorization version. The same values while that version is in
-- force return it; different values supersede it, recorded on the old version.
-- Every field is explicit: there is no default evidence, basis or retention.
create or replace function ops.record_model_data_authorization(
  p_tenant_id              uuid,
  p_data_class             text,
  p_capability             text,
  p_provider               text,
  p_model                  text,
  p_valid_from             timestamptz,
  p_expires_at             timestamptz,
  p_provider_evidence_ref  text,
  p_evidence_verified_at   timestamptz,
  p_training_excluded      boolean,
  p_contract_ref           text,
  p_dpa_ref                text,
  p_zero_retention_ref     text,
  p_retention_evidence_ref text,
  p_transfer_mechanism_ref text,
  p_lawful_basis_ref       text,
  p_content_retention_days integer,
  p_actor                  text
)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_active ops.model_data_authorizations;
  v_id     uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.record_model_data_authorization: no tenant scope';
  end if;
  if p_data_class is null or not (p_data_class = any (ops.model_authorizable_data_classes())) then
    raise exception using
      errcode = 'OS403',
      message = 'ops.record_model_data_authorization: only operational, person_text or health data can be authorized; identifier, clinical_record, derived and unclassified never are, and synthetic and test need none';
  end if;
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,31}$' or p_provider = 'fake'
     or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$' then
    raise exception using
      errcode = 'OS400',
      message = 'ops.record_model_data_authorization: a real provider and an exact model are required and well formed';
  end if;
  if p_training_excluded is null then
    raise exception using errcode = 'OS400', message = 'ops.record_model_data_authorization: whether API data is excluded from training must be stated';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_model_data_authorization: the actor is missing or malformed';
  end if;
  perform 1 from ops.tenants t where t.id = p_tenant_id for share;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.record_model_data_authorization: tenant not found';
  end if;

  -- Serialised per binding, so two recordings cannot both find nothing in force.
  perform pg_advisory_xact_lock(hashtext('ops.model_data_authorizations'),
    hashtext(concat_ws(':', p_tenant_id::text, p_data_class, p_capability, p_provider, p_model)));

  select a.* into v_active
    from ops.model_data_authorizations a
   where a.tenant_id = p_tenant_id and a.data_class = p_data_class and a.capability = p_capability
     and a.provider = p_provider and a.model = p_model and a.retired_at is null
     for update;
  if found then
    if v_active.valid_from = p_valid_from and v_active.expires_at = p_expires_at
       and v_active.provider_evidence_ref = p_provider_evidence_ref
       and v_active.evidence_verified_at = p_evidence_verified_at
       and v_active.training_excluded = p_training_excluded
       and v_active.contract_ref is not distinct from p_contract_ref
       and v_active.dpa_ref is not distinct from p_dpa_ref
       and v_active.zero_retention_ref is not distinct from p_zero_retention_ref
       and v_active.retention_evidence_ref is not distinct from p_retention_evidence_ref
       and v_active.transfer_mechanism_ref is not distinct from p_transfer_mechanism_ref
       and v_active.lawful_basis_ref is not distinct from p_lawful_basis_ref
       and v_active.content_retention_days is not distinct from p_content_retention_days then
      return v_active.id; -- already in force: nothing to change
    end if;
    update ops.model_data_authorizations
       set retired_by = p_actor, retire_reason = 'superseded'
     where id = v_active.id;
  end if;

  -- Every other rule is the table's: a violated one refuses the whole act.
  insert into ops.model_data_authorizations (
    tenant_id, data_class, capability, provider, model, valid_from, expires_at,
    provider_evidence_ref, evidence_verified_at, training_excluded, contract_ref, dpa_ref,
    zero_retention_ref, retention_evidence_ref, transfer_mechanism_ref, lawful_basis_ref,
    content_retention_days, recorded_by)
  values (
    p_tenant_id, p_data_class, p_capability, p_provider, p_model, p_valid_from, p_expires_at,
    p_provider_evidence_ref, p_evidence_verified_at, p_training_excluded, p_contract_ref, p_dpa_ref,
    p_zero_retention_ref, p_retention_evidence_ref, p_transfer_mechanism_ref, p_lawful_basis_ref,
    p_content_retention_days, p_actor)
  returning id into v_id;
  return v_id;
end
$function$;

-- Retire a version without replacing it. It takes effect at the next start; a
-- call already in flight cannot be recalled.
create or replace function ops.retire_model_data_authorization(
  p_authorization_id uuid,
  p_reason           text,
  p_actor            text
)
returns boolean
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception using errcode = 'OS400', message = 'ops.retire_model_data_authorization: a reason is required, at most 500 characters';
  end if;
  if p_actor is null or p_actor !~ '^[a-z0-9][a-z0-9_.:@-]{0,127}$' then
    raise exception using errcode = 'OS400', message = 'ops.retire_model_data_authorization: the actor is missing or malformed';
  end if;
  perform 1 from ops.model_data_authorizations a where a.id = p_authorization_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.retire_model_data_authorization: authorization not found';
  end if;
  update ops.model_data_authorizations
     set retired_by = p_actor, retire_reason = p_reason
   where id = p_authorization_id and retired_at is null;
  return found;
end
$function$;

-- ---------------------------------------------------------------------------
-- 10. Privileges. Deny first; nothing is granted. The worker reaches the gate
--     only through ops.start_agent_run and ops.start_shadow_decision, whose
--     grants are unchanged.
-- ---------------------------------------------------------------------------

revoke all on table ops.model_data_authorizations
  from public, anon, authenticated, service_role, ops_worker;

revoke all on function ops.data_classes() from public;
revoke all on function ops.model_authorizable_data_classes() from public;
revoke all on function ops.model_data_class_exempt(text, text) from public;
revoke all on function ops.model_data_controller_tenant(uuid) from public;
revoke all on function ops.person_content_capabilities() from public;
revoke all on function ops.guard_model_data_authorization_insert() from public;
revoke all on function ops.guard_model_data_authorization_update() from public;
revoke all on function ops.guard_model_data_authorization_delete() from public;
revoke all on function ops.refuse_model_data_authorization_truncate() from public;
revoke all on function ops.model_data_authorization_in_force(uuid, text, text, text, text) from public;
revoke all on function ops.model_data_authorized(uuid, text, text, text, text) from public;
revoke all on function ops.model_data_class_admissible(uuid, text, text) from public;
revoke all on function ops.agent_run_reserved_error_codes() from public;
revoke all on function ops.guard_agent_run_insert() from public;
revoke all on function ops.guard_agent_run_update() from public;
revoke all on function ops.guard_task_data_class() from public;
revoke all on function ops.create_task(uuid, uuid, text, text, text, text, uuid, uuid, integer, timestamptz, uuid, uuid, text, text) from public;
revoke all on function ops.admit_inbound_core(uuid, uuid, uuid, text, text, text, text, text, boolean, timestamptz, uuid, uuid, text, text) from public;
revoke all on function ops.request_agent_run(uuid, uuid, uuid, text, text, text, uuid, text) from public;
revoke all on function ops.start_agent_run(text, text, text, text, integer) from public;
revoke all on function ops.start_shadow_decision(text, text, text) from public;
revoke all on function ops.record_model_data_authorization(uuid, text, text, text, text, timestamptz, timestamptz, text, timestamptz, boolean, text, text, text, text, text, text, integer, text) from public;
revoke all on function ops.retire_model_data_authorization(uuid, text, text) from public;
revoke all on table ops.communication_test_senders
  from public, anon, authenticated, service_role, ops_worker;
revoke all on function ops.guard_test_sender_insert() from public;
revoke all on function ops.guard_test_sender_update() from public;
revoke all on function ops.guard_test_sender_delete() from public;
revoke all on function ops.refuse_test_sender_truncate() from public;
revoke all on function ops.registered_test_sender(uuid, uuid, text) from public;
revoke all on function ops.register_test_sender(uuid, uuid, text, text) from public;
revoke all on function ops.retire_test_sender(uuid, text, text) from public;

-- ---------------------------------------------------------------------------
-- 11. Assertions.
-- ---------------------------------------------------------------------------

do $assert$
begin
  if exists (select 1 from ops.communication_test_senders) then
    raise exception 'Q8 enforcement shipped a registered test sender; registrations are owner data (D8)';
  end if;
  if exists (select 1 from ops.model_data_authorizations) then
    raise exception 'Q8 enforcement shipped a data authorization; authorizations are owner data, recorded by an owner act';
  end if;
  if exists (select 1 from ops.tasks t where not (t.data_class = any (ops.data_classes()))) then
    raise exception 'a task carries a data class outside the closed classification';
  end if;
  if exists (select 1 from ops.agent_runs r where r.status in ('pending', 'running') and r.data_class is null) then
    raise exception 'an unfinished agent run carries no data class';
  end if;
  if not (ops.agent_run_reserved_error_codes() @> array['data_not_authorized']) then
    raise exception 'data_not_authorized is not a database-only refusal';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname = 'create_task') <> 1 then
    raise exception 'ops.create_task has more than one signature';
  end if;
  if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'ops' and p.proname = 'request_agent_run') <> 1 then
    raise exception 'ops.request_agent_run has more than one signature';
  end if;
  if not has_function_privilege('ops_worker', 'ops.start_agent_run(text, text, text, text, integer)', 'EXECUTE') then
    raise exception 'the worker lost its start';
  end if;
  if has_function_privilege('ops_worker', 'ops.record_model_data_authorization(uuid, text, text, text, text, timestamptz, timestamptz, text, timestamptz, boolean, text, text, text, text, text, text, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'ops.record_model_data_authorization(uuid, text, text, text, text, timestamptz, timestamptz, text, timestamptz, boolean, text, text, text, text, text, text, integer, text)', 'EXECUTE') then
    raise exception 'a data authorization can be recorded by a role other than the owner';
  end if;
end
$assert$;
