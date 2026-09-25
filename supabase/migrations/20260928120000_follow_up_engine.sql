-- Phase 3A.1: the follow-up engine.
--
-- WHAT THIS MIGRATION ADDS (docs/PHASE_3A_REPORT.md):
--
--   1. Versioned, tenant-scoped follow-up POLICIES: ops.follow_up_policies (a
--      key and a label) and ops.follow_up_policy_versions (an ordered list of
--      offsets, in minutes, from an anchor). A cadence is tenant configuration:
--      nothing here knows "3, 7 and 10 days", which is only the synthetic
--      demo's data. A version is immutable; a new cadence is a new version, and
--      a plan stays bound to the version it was created with.
--   2. ops.follow_up_plans: one plan per subject (a task, a conversation or an
--      opaque reference, never a name, phone, email or message), created once
--      per tenant-scoped idempotency key. A new plan for the same subject
--      SUPERSEDES the active one: at most one active plan per subject, held by
--      a partial unique index.
--   3. ops.follow_ups: one occurrence per (plan, step), never two. Its due time
--      is the plan's anchor plus the step's offset as a FIXED duration, derived
--      by the database and independent of any session time zone.
--   4. The occurrence state machine, enforced by an ENABLE ALWAYS trigger:
--      scheduled -> due -> completed; scheduled or due -> cancelled; scheduled
--      -> superseded. A closed occurrence is never reopened. Open work (an
--      active plan, a scheduled or due occurrence) is never deleted, and no
--      service deletes anything: closing is a transition that keeps the row.
--      Only the owner can delete CLOSED history, a retention and erasure act.
--   5. The due job: every occurrence gets ONE `follow_up.due` job on the
--      existing queue, available at its due time (ops.enqueue_job's
--      available_at). No scheduler, cron or second queue exists. The kind is
--      GOVERNED: database-only work the one kill switch holds, at the lease and
--      again at the start of its transaction (engine/worker/runOneJob.ts), so a
--      covering stop keeps the occurrence scheduled and its job queued, with no
--      attempt consumed, until the stop is cleared.
--   6. ops.mark_follow_up_due(): the worker's one lease-bound capability. It
--      moves the occurrence bound to the leased job from scheduled to due, and
--      nothing else. A replay finds it already due or closed and changes
--      nothing.
--   7. Owner services (executable by no application role): define a policy
--      version, schedule a plan, complete or cancel one follow-up, cancel a
--      plan. Each records a content-free fact through ops.record_event.
--
-- WHAT IT DELIBERATELY DOES NOT DO. A due follow-up is a piece of operator
-- work, not a permission to contact anyone: nothing here sends a message,
-- writes an outbound row, calls a model or a provider, touches the CRM, or
-- decides a review. No message body is copied: a plan points at the task or
-- conversation it follows up. No company_os_api function is added, so the
-- browser still has exactly its two acts.

-- ---------------------------------------------------------------------------
-- 0. Engine vocabulary: the same for every tenant (ADR 0013's test).
-- ---------------------------------------------------------------------------

-- The occurrence state machine, as a relation. The BEFORE UPDATE trigger on
-- ops.follow_ups is its only enforcement point; engine/domain/followUps.ts
-- mirrors it and a driver-backed test asserts the two sets are equal.
create function ops.follow_up_status_transitions()
returns table (from_status text, to_status text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('scheduled', 'due'),
    ('scheduled', 'cancelled'),
    ('scheduled', 'superseded'),
    ('due',       'completed'),
    ('due',       'cancelled')
  ) as t (from_status, to_status);
$$;

-- GOVERNED job kinds: database-only work a company unit owns. Unlike an
-- internal kind (maintenance, never held) the kill switch holds them; unlike
-- an external kind they call nothing, so their handler is transactional.
-- engine/worker/jobKinds.ts mirrors this set and a driver-backed test asserts
-- equality. ops.lease_job already holds every queued kind that is not
-- internal, so a governed kind needs no change there.
create function ops.governed_job_kinds()
returns text[]
language sql immutable set search_path = '' as $$
  select array['follow_up.due']::text[];
$$;

-- A cadence: 1 to 12 steps, each 1 minute to 365 days after the anchor, in
-- strictly increasing order.
create function ops.follow_up_offsets_valid(p_offsets integer[])
returns boolean
language sql immutable set search_path = '' as $$
  select p_offsets is not null
     and array_ndims(p_offsets) = 1
     and array_lower(p_offsets, 1) = 1
     and cardinality(p_offsets) between 1 and 12
     and not exists (
       select 1
         from unnest(p_offsets) with ordinality as o (minutes, position)
        where o.minutes is null
           or o.minutes < 1
           or o.minutes > 525600
           or (o.position > 1 and o.minutes <= p_offsets[(o.position - 1)::integer]));
$$;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

create table ops.follow_up_policies (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references ops.tenants (id) on delete restrict,
  key        text not null,
  label      text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint follow_up_policies_key_format    check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(key) <= 63),
  constraint follow_up_policies_label_length  check (char_length(btrim(label)) between 1 and 200),
  constraint follow_up_policies_actor_length  check (char_length(btrim(created_by)) between 1 and 200),
  constraint follow_up_policies_tenant_key    unique (tenant_id, key),
  constraint follow_up_policies_scope_id_key  unique (tenant_id, id)
);

comment on table ops.follow_up_policies is
  'A tenant''s named follow-up cadence. Its steps live in immutable versions; the label is tenant vocabulary (data).';

create table ops.follow_up_policy_versions (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references ops.tenants (id) on delete restrict,
  policy_id            uuid not null,
  version              integer not null,
  step_offsets_minutes integer[] not null,
  created_by           text not null,
  created_at           timestamptz not null default now(),
  constraint follow_up_policy_versions_version_positive check (version >= 1),
  constraint follow_up_policy_versions_offsets_valid    check (ops.follow_up_offsets_valid(step_offsets_minutes)),
  constraint follow_up_policy_versions_actor_length     check (char_length(btrim(created_by)) between 1 and 200),
  constraint follow_up_policy_versions_policy_fkey
    foreign key (tenant_id, policy_id) references ops.follow_up_policies (tenant_id, id) on delete restrict,
  constraint follow_up_policy_versions_policy_version_key unique (policy_id, version),
  constraint follow_up_policy_versions_scope_id_key       unique (tenant_id, id)
);

comment on table ops.follow_up_policy_versions is
  'One immutable cadence: the offsets, in minutes after a plan''s anchor, of each step. A new cadence is a new version.';

create table ops.follow_up_plans (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references ops.tenants (id) on delete restrict,
  company_id            uuid not null,
  department_id         uuid not null,
  agent_id              uuid,
  policy_version_id     uuid not null,
  anchor_at             timestamptz not null,
  task_id               uuid,
  conversation_id       uuid,
  subject_ref           text,
  subject_key           text generated always as (
                          case
                            when task_id is not null then 'task:' || task_id::text
                            when conversation_id is not null then 'conversation:' || conversation_id::text
                            else 'ref:' || subject_ref
                          end) stored,
  status                text not null default 'active',
  superseded_by_plan_id uuid,
  idempotency_key       text not null,
  request_fingerprint   text not null,
  created_by            text not null,
  created_at            timestamptz not null default now(),
  closed_by             text,
  closed_at             timestamptz,
  constraint follow_up_plans_status_check        check (status in ('active', 'cancelled', 'superseded')),
  constraint follow_up_plans_subject_present     check (num_nonnulls(task_id, conversation_id, subject_ref) >= 1),
  constraint follow_up_plans_subject_ref_format  check (subject_ref is null
                                                        or subject_ref ~ '^[a-z][a-z0-9_]{0,31}:[A-Za-z0-9._-]{1,64}$'),
  constraint follow_up_plans_idempotency_format  check (idempotency_key ~ '^[\x21-\x7e]{1,200}$'),
  constraint follow_up_plans_fingerprint_format  check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint follow_up_plans_actor_length        check (char_length(btrim(created_by)) between 1 and 200),
  constraint follow_up_plans_closed_iff_ended    check ((status = 'active') = (closed_at is null)),
  constraint follow_up_plans_closed_by_iff       check ((closed_at is null) = (closed_by is null)),
  constraint follow_up_plans_superseded_iff      check ((status = 'superseded') = (superseded_by_plan_id is not null)),
  constraint follow_up_plans_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint follow_up_plans_department_fkey
    foreign key (tenant_id, company_id, department_id)
    references ops.departments (tenant_id, company_id, id) on delete restrict,
  constraint follow_up_plans_agent_fkey
    foreign key (tenant_id, company_id, department_id, agent_id)
    references ops.agents (tenant_id, company_id, department_id, id) on delete restrict,
  constraint follow_up_plans_version_fkey
    foreign key (tenant_id, policy_version_id) references ops.follow_up_policy_versions (tenant_id, id) on delete restrict,
  constraint follow_up_plans_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id) on delete restrict,
  constraint follow_up_plans_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id)
    references ops.conversations (tenant_id, company_id, id) on delete restrict,
  constraint follow_up_plans_idempotency_key unique (tenant_id, idempotency_key),
  constraint follow_up_plans_scope_id_key    unique (tenant_id, company_id, id),
  -- Deferred: the superseding plan's id is named before its row exists, in the
  -- one transaction that supersedes and creates.
  constraint follow_up_plans_superseded_by_fkey
    foreign key (tenant_id, company_id, superseded_by_plan_id)
    references ops.follow_up_plans (tenant_id, company_id, id) on delete restrict
    deferrable initially deferred
);

comment on table ops.follow_up_plans is
  'One follow-up cadence applied to one subject (a task, a conversation or an opaque reference; never a name, number, email or message). At most one active plan per subject; a new plan supersedes it.';

-- At most one ACTIVE plan per subject: structural, whoever writes.
create unique index follow_up_plans_one_active_per_subject
  on ops.follow_up_plans (tenant_id, company_id, subject_key) where status = 'active';

create table ops.follow_ups (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references ops.tenants (id) on delete restrict,
  company_id    uuid not null,
  plan_id       uuid not null,
  step_number   integer not null,
  step_count    integer not null,
  due_at        timestamptz not null,
  status        text not null default 'scheduled',
  job_id        uuid,
  created_at    timestamptz not null default now(),
  due_marked_at timestamptz,
  completed_at  timestamptz,
  cancelled_at  timestamptz,
  superseded_at timestamptz,
  closed_by     text,
  close_reason  text,
  constraint follow_ups_status_check        check (status in ('scheduled', 'due', 'completed', 'cancelled', 'superseded')),
  constraint follow_ups_step_range          check (step_count between 1 and 12 and step_number between 1 and step_count),
  constraint follow_ups_due_marked_iff      check ((status = 'scheduled' or status = 'superseded') = (due_marked_at is null)
                                                   or status = 'cancelled'),
  constraint follow_ups_completed_at_iff    check ((status = 'completed') = (completed_at is not null)),
  constraint follow_ups_cancelled_at_iff    check ((status = 'cancelled') = (cancelled_at is not null)),
  constraint follow_ups_superseded_at_iff   check ((status = 'superseded') = (superseded_at is not null)),
  constraint follow_ups_closed_by_iff       check ((status in ('completed', 'cancelled', 'superseded')) = (closed_by is not null)),
  constraint follow_ups_close_reason_iff    check ((status in ('completed', 'cancelled', 'superseded')) = (close_reason is not null)),
  constraint follow_ups_closed_by_length    check (closed_by is null or char_length(btrim(closed_by)) between 1 and 200),
  constraint follow_ups_close_reason_format check (close_reason is null or close_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint follow_ups_plan_fkey
    foreign key (tenant_id, company_id, plan_id) references ops.follow_up_plans (tenant_id, company_id, id) on delete restrict,
  constraint follow_ups_job_fkey
    foreign key (tenant_id, job_id) references ops.jobs (tenant_id, id) on delete restrict,
  constraint follow_ups_plan_step_key   unique (plan_id, step_number),
  constraint follow_ups_job_key         unique (tenant_id, job_id),
  constraint follow_ups_scope_id_key    unique (tenant_id, company_id, id)
);

comment on table ops.follow_ups is
  'One follow-up occurrence: step N of a plan, due at the plan''s anchor plus that step''s fixed offset. Due means operator work, never a permission to contact. Never deleted; a closed occurrence is immutable.';

create index follow_ups_open_idx on ops.follow_ups (tenant_id, status, due_at)
  where status in ('scheduled', 'due');
create index follow_ups_plan_idx on ops.follow_ups (tenant_id, plan_id);

alter table ops.follow_up_policies        enable row level security;
alter table ops.follow_up_policies        force  row level security;
alter table ops.follow_up_policy_versions enable row level security;
alter table ops.follow_up_policy_versions force  row level security;
alter table ops.follow_up_plans           enable row level security;
alter table ops.follow_up_plans           force  row level security;
alter table ops.follow_ups                enable row level security;
alter table ops.follow_ups                force  row level security;

-- ---------------------------------------------------------------------------
-- 2. Guards. Update, delete and truncate guards are ENABLE ALWAYS, so replica
--    mode does not silence them; insert validation stays ORIGIN, as elsewhere.
-- ---------------------------------------------------------------------------

-- Scheduling history is never rewritten: policies and versions are never
-- updated (a version still referenced by a plan cannot be deleted either, by
-- its foreign key), and no scheduling table is truncated, which would skip the
-- row guards below.
create function ops.refuse_scheduling_history_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using
    errcode = 'OS409',
    message = format('ops.%s: scheduling history is never %s', tg_table_name,
                     case tg_op when 'UPDATE' then 'rewritten' when 'DELETE' then 'deleted' else 'truncated' end);
end
$$;

-- A version's number is the policy's next one, under a lock on the policy, so
-- two definitions cannot both claim it; its time is the database's.
create function ops.guard_follow_up_policy_version_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from ops.follow_up_policies p
   where p.tenant_id = new.tenant_id and p.id = new.policy_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.follow_up_policy_versions: policy not found in this tenant';
  end if;
  new.version := coalesce((select max(v.version) from ops.follow_up_policy_versions v where v.policy_id = new.policy_id), 0) + 1;
  new.created_at := now();
  return new;
end
$$;

-- A plan is born active, against the unit it names being active, and its
-- times are the database's. Everything but its closing is fixed.
create function ops.guard_follow_up_plan_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.status <> 'active' or new.closed_at is not null or new.superseded_by_plan_id is not null then
    raise exception using errcode = 'OS400', message = 'ops.follow_up_plans: a plan is created active';
  end if;
  if not exists (select 1 from ops.companies c where c.tenant_id = new.tenant_id and c.id = new.company_id and c.status = 'active')
     or not exists (select 1 from ops.departments d
                     where d.tenant_id = new.tenant_id and d.company_id = new.company_id
                       and d.id = new.department_id and d.status = 'active') then
    raise exception using errcode = 'OS409', message = 'ops.follow_up_plans: the company and department must be active';
  end if;
  new.created_at := now();
  return new;
end
$$;

-- Open work is never deleted: an active plan is cancelled, never removed. A
-- closed plan is history, which only the owner may delete (retention).
create function ops.guard_follow_up_plan_delete()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status = 'active' then
    raise exception using errcode = 'OS409', message = 'ops.follow_up_plans: an active plan is cancelled, never deleted';
  end if;
  return old;
end
$$;

create function ops.guard_follow_up_delete()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.status in ('scheduled', 'due') then
    raise exception using errcode = 'OS409', message = 'ops.follow_ups: an open follow-up is cancelled, never deleted';
  end if;
  return old;
end
$$;

create function ops.guard_follow_up_plan_update()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  -- subject_key is generated from the fixed subject columns, and a BEFORE
  -- trigger sees a stored generated column as not yet computed.
  c_moving constant text[] := array['status', 'superseded_by_plan_id', 'closed_by', 'closed_at', 'subject_key'];
begin
  if (to_jsonb(new) - c_moving) is distinct from (to_jsonb(old) - c_moving) then
    raise exception using errcode = 'OS409', message = 'ops.follow_up_plans: a plan is fixed at creation; only its closing changes';
  end if;
  if old.status <> 'active' then
    raise exception using errcode = 'OS409', message = format('ops.follow_up_plans: a %s plan is closed and never changes', old.status);
  end if;
  if new.status not in ('cancelled', 'superseded') then
    raise exception using errcode = 'OS409', message = 'ops.follow_up_plans: an active plan is only cancelled or superseded';
  end if;
  new.closed_at := now();
  return new;
end
$$;

-- An occurrence is born scheduled, with no job yet, and its due time is
-- DERIVED here from the plan's anchor and the version's offset: a fixed
-- number of minutes, so no session time zone or daylight-saving rule can move
-- it. A caller's due time that disagrees is refused rather than trusted.
create function ops.guard_follow_up_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_plan    ops.follow_up_plans;
  v_offsets integer[];
begin
  select p.* into v_plan from ops.follow_up_plans p
   where p.tenant_id = new.tenant_id and p.company_id = new.company_id and p.id = new.plan_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.follow_ups: plan not found in this company';
  end if;
  if v_plan.status <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.follow_ups: a closed plan schedules nothing';
  end if;
  select v.step_offsets_minutes into v_offsets from ops.follow_up_policy_versions v
   where v.tenant_id = new.tenant_id and v.id = v_plan.policy_version_id;
  if new.step_count <> cardinality(v_offsets) or new.step_number not between 1 and cardinality(v_offsets) then
    raise exception using errcode = 'OS400', message = 'ops.follow_ups: the step is not one of the plan''s cadence';
  end if;
  if new.due_at is distinct from v_plan.anchor_at + make_interval(mins => v_offsets[new.step_number]) then
    raise exception using errcode = 'OS400', message = 'ops.follow_ups: the due time is the plan''s anchor plus the step''s offset';
  end if;
  if new.status <> 'scheduled' or new.job_id is not null
     or num_nonnulls(new.due_marked_at, new.completed_at, new.cancelled_at, new.superseded_at, new.closed_by, new.close_reason) > 0 then
    raise exception using errcode = 'OS400', message = 'ops.follow_ups: an occurrence is created scheduled, before its job';
  end if;
  new.created_at := now();
  return new;
end
$$;

-- The state machine. A transition along the declared relation, stamped with
-- the database's time; a job named once; nothing else changes, and a closed
-- occurrence never changes at all.
create function ops.guard_follow_up_update()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  c_moving constant text[] := array['status', 'job_id', 'due_marked_at', 'completed_at', 'cancelled_at',
                                    'superseded_at', 'closed_by', 'close_reason'];
begin
  if (to_jsonb(new) - c_moving) is distinct from (to_jsonb(old) - c_moving) then
    raise exception using errcode = 'OS409', message = 'ops.follow_ups: an occurrence''s plan, step and due time are fixed';
  end if;
  if old.status in ('completed', 'cancelled', 'superseded') then
    raise exception using errcode = 'OS409', message = format('ops.follow_ups: a %s follow-up is closed and never changes', old.status);
  end if;

  if new.status = old.status then
    -- The only change without a transition: naming the due job, once.
    if old.job_id is not null or new.job_id is null
       or (to_jsonb(new) - 'job_id') is distinct from (to_jsonb(old) - 'job_id') then
      raise exception using errcode = 'OS409', message = 'ops.follow_ups: without a transition only the due job is named, once';
    end if;
    return new;
  end if;

  if new.job_id is distinct from old.job_id then
    raise exception using errcode = 'OS409', message = 'ops.follow_ups: a transition never re-points the due job';
  end if;
  if not exists (select 1 from ops.follow_up_status_transitions() t
                  where t.from_status = old.status and t.to_status = new.status) then
    raise exception using errcode = 'OS409', message = format('ops.follow_ups: %s -> %s is not a follow-up transition', old.status, new.status);
  end if;
  if new.status = 'due' then
    if old.job_id is null then
      raise exception using errcode = 'OS409', message = 'ops.follow_ups: only the due job makes a follow-up due';
    end if;
    if new.closed_by is not null or new.close_reason is not null then
      raise exception using errcode = 'OS400', message = 'ops.follow_ups: a due follow-up is still open';
    end if;
    new.due_marked_at := now();
    return new;
  end if;

  new.due_marked_at := old.due_marked_at;
  new.completed_at := case when new.status = 'completed' then now() end;
  new.cancelled_at := case when new.status = 'cancelled' then now() end;
  new.superseded_at := case when new.status = 'superseded' then now() end;
  return new;
end
$$;

drop trigger if exists follow_up_policies_refuse_update on ops.follow_up_policies;
create trigger follow_up_policies_refuse_update
  before update on ops.follow_up_policies
  for each row execute function ops.refuse_scheduling_history_change();
alter table ops.follow_up_policies enable always trigger follow_up_policies_refuse_update;

drop trigger if exists follow_up_policies_refuse_truncate on ops.follow_up_policies;
create trigger follow_up_policies_refuse_truncate
  before truncate on ops.follow_up_policies
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.follow_up_policies enable always trigger follow_up_policies_refuse_truncate;

drop trigger if exists follow_up_policy_versions_guard_insert on ops.follow_up_policy_versions;
create trigger follow_up_policy_versions_guard_insert
  before insert on ops.follow_up_policy_versions
  for each row execute function ops.guard_follow_up_policy_version_insert();

drop trigger if exists follow_up_policy_versions_refuse_update on ops.follow_up_policy_versions;
create trigger follow_up_policy_versions_refuse_update
  before update on ops.follow_up_policy_versions
  for each row execute function ops.refuse_scheduling_history_change();
alter table ops.follow_up_policy_versions enable always trigger follow_up_policy_versions_refuse_update;

drop trigger if exists follow_up_policy_versions_refuse_truncate on ops.follow_up_policy_versions;
create trigger follow_up_policy_versions_refuse_truncate
  before truncate on ops.follow_up_policy_versions
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.follow_up_policy_versions enable always trigger follow_up_policy_versions_refuse_truncate;

drop trigger if exists follow_up_plans_guard_insert on ops.follow_up_plans;
create trigger follow_up_plans_guard_insert
  before insert on ops.follow_up_plans
  for each row execute function ops.guard_follow_up_plan_insert();

drop trigger if exists follow_up_plans_guard_update on ops.follow_up_plans;
create trigger follow_up_plans_guard_update
  before update on ops.follow_up_plans
  for each row execute function ops.guard_follow_up_plan_update();
alter table ops.follow_up_plans enable always trigger follow_up_plans_guard_update;

drop trigger if exists follow_up_plans_guard_delete on ops.follow_up_plans;
create trigger follow_up_plans_guard_delete
  before delete on ops.follow_up_plans
  for each row execute function ops.guard_follow_up_plan_delete();
alter table ops.follow_up_plans enable always trigger follow_up_plans_guard_delete;

drop trigger if exists follow_up_plans_refuse_truncate on ops.follow_up_plans;
create trigger follow_up_plans_refuse_truncate
  before truncate on ops.follow_up_plans
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.follow_up_plans enable always trigger follow_up_plans_refuse_truncate;

drop trigger if exists follow_ups_guard_insert on ops.follow_ups;
create trigger follow_ups_guard_insert
  before insert on ops.follow_ups
  for each row execute function ops.guard_follow_up_insert();

drop trigger if exists follow_ups_guard_update on ops.follow_ups;
create trigger follow_ups_guard_update
  before update on ops.follow_ups
  for each row execute function ops.guard_follow_up_update();
alter table ops.follow_ups enable always trigger follow_ups_guard_update;

drop trigger if exists follow_ups_guard_delete on ops.follow_ups;
create trigger follow_ups_guard_delete
  before delete on ops.follow_ups
  for each row execute function ops.guard_follow_up_delete();
alter table ops.follow_ups enable always trigger follow_ups_guard_delete;

drop trigger if exists follow_ups_refuse_truncate on ops.follow_ups;
create trigger follow_ups_refuse_truncate
  before truncate on ops.follow_ups
  for each statement execute function ops.refuse_scheduling_history_change();
alter table ops.follow_ups enable always trigger follow_ups_refuse_truncate;

-- ---------------------------------------------------------------------------
-- 3. Owner services. SECURITY INVOKER, executable by no application role: the
--    owner's credential (the scheduling CLI, the synthetic demo) calls them.
-- ---------------------------------------------------------------------------

-- A label a person or a tool gave itself: 1 to 200 characters once trimmed.
create function ops.require_scheduling_actor(p_actor text, p_caller text)
returns void
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_actor is null or char_length(btrim(p_actor)) not between 1 and 200 then
    raise exception using errcode = 'OS400', message = format('%s: an actor label is 1 to 200 characters', p_caller);
  end if;
end
$$;

-- Defines the next version of a policy, creating the policy on first use. The
-- same cadence as the latest version is that version, not a new one, so a
-- repeated definition changes nothing.
create function ops.define_follow_up_policy_version(
  p_tenant_id            uuid,
  p_policy_key           text,
  p_label                text,
  p_step_offsets_minutes integer[],
  p_actor                text
)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_policy  ops.follow_up_policies;
  v_latest  ops.follow_up_policy_versions;
  v_version ops.follow_up_policy_versions;
begin
  if p_tenant_id is null or not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.define_follow_up_policy_version: tenant not found';
  end if;
  perform ops.require_scheduling_actor(p_actor, 'ops.define_follow_up_policy_version');
  if not ops.follow_up_offsets_valid(p_step_offsets_minutes) then
    raise exception using
      errcode = 'OS400',
      message = 'ops.define_follow_up_policy_version: a cadence is 1 to 12 offsets, each 1 minute to 365 days, strictly increasing';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ops.follow_up_policies:' || p_tenant_id::text || ':' || coalesce(p_policy_key, ''), 0));

  select p.* into v_policy from ops.follow_up_policies p where p.tenant_id = p_tenant_id and p.key = p_policy_key;
  if not found then
    insert into ops.follow_up_policies (tenant_id, key, label, created_by)
    values (p_tenant_id, p_policy_key, p_label, p_actor)
    returning * into v_policy;
  end if;

  select v.* into v_latest from ops.follow_up_policy_versions v
   where v.policy_id = v_policy.id order by v.version desc limit 1;
  if found and v_latest.step_offsets_minutes = p_step_offsets_minutes then
    return jsonb_build_object('policy_id', v_policy.id, 'version_id', v_latest.id, 'version', v_latest.version,
                              'created', false);
  end if;

  insert into ops.follow_up_policy_versions (tenant_id, policy_id, version, step_offsets_minutes, created_by)
  values (p_tenant_id, v_policy.id, 0, p_step_offsets_minutes, p_actor)
  returning * into v_version;
  return jsonb_build_object('policy_id', v_policy.id, 'version_id', v_version.id, 'version', v_version.version,
                            'created', true);
end
$$;

-- Schedules the latest version of a policy for one subject, once per
-- tenant-scoped idempotency key: the same request returns the same plan and
-- creates nothing; a different request under that key is refused. A plan for
-- a subject that already has an active plan supersedes it: that plan's
-- scheduled occurrences become superseded (a due one stays open work).
-- Every occurrence gets one `follow_up.due` job, available at its due time.
-- Scheduling is admitted even under an execution stop: the due jobs are held
-- by the stop at the lease, never destroyed, and run once it is cleared.
create function ops.schedule_follow_up_plan(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_department_id   uuid,
  p_agent_id        uuid,
  p_policy_key      text,
  p_anchor_at       timestamptz,
  p_task_id         uuid,
  p_conversation_id uuid,
  p_subject_ref     text,
  p_idempotency_key text,
  p_actor           text,
  p_source          text
)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_version     ops.follow_up_policy_versions;
  v_subject     text;
  v_fingerprint text;
  v_existing    ops.follow_up_plans;
  v_previous    ops.follow_up_plans;
  v_plan_id     uuid := gen_random_uuid();
  v_context     jsonb;
  v_step        integer;
  v_steps       integer;
  v_follow_up   uuid;
  v_job         uuid;
  v_due         timestamptz;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.schedule_follow_up_plan: no tenant scope';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.schedule_follow_up_plan: an idempotency key is 1 to 200 printable characters';
  end if;
  perform ops.require_scheduling_actor(p_actor, 'ops.schedule_follow_up_plan');
  if p_anchor_at is null or p_anchor_at < now() - interval '30 days' or p_anchor_at > now() + interval '366 days' then
    raise exception using errcode = 'OS400', message = 'ops.schedule_follow_up_plan: the anchor is within 30 days before and 366 days after now';
  end if;
  v_subject := case
    when p_task_id is not null then 'task:' || p_task_id::text
    when p_conversation_id is not null then 'conversation:' || p_conversation_id::text
    when p_subject_ref is not null then 'ref:' || p_subject_ref
  end;
  if v_subject is null then
    raise exception using
      errcode = 'OS400',
      message = 'ops.schedule_follow_up_plan: a plan names what it follows up: a task, a conversation or an opaque reference';
  end if;

  -- One request per key, and one plan change per subject, at a time: the key
  -- first, then the subject, always in that order.
  perform pg_advisory_xact_lock(hashtextextended('ops.follow_up_plans:key:' || p_tenant_id::text || ':' || p_idempotency_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'ops.follow_up_plans:subject:' || p_tenant_id::text || ':' || coalesce(p_company_id::text, '') || ':' || v_subject, 0));

  -- The fingerprint is of the REQUEST (the policy by key, the anchor as epoch
  -- seconds), so a replay after a cadence change still names the same plan.
  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'company', p_company_id, 'department', p_department_id, 'agent', p_agent_id, 'policy', p_policy_key,
    'anchor', extract(epoch from p_anchor_at)::text, 'subject', v_subject)::text, 'UTF8')), 'hex');

  select p.* into v_existing from ops.follow_up_plans p
   where p.tenant_id = p_tenant_id and p.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_fingerprint = v_fingerprint then
      return jsonb_build_object('plan_id', v_existing.id, 'created', false, 'superseded_plan_id', null);
    end if;
    raise exception using errcode = 'OS409', message = 'ops.schedule_follow_up_plan: that idempotency key already names a different plan';
  end if;

  select v.* into v_version
    from ops.follow_up_policy_versions v
    join ops.follow_up_policies p on p.tenant_id = v.tenant_id and p.id = v.policy_id
   where p.tenant_id = p_tenant_id and p.key = p_policy_key
   order by v.version desc
   limit 1;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.schedule_follow_up_plan: no follow-up policy with that key in this tenant';
  end if;
  v_steps := cardinality(v_version.step_offsets_minutes);

  v_context := ops.push_event_context(p_source, v_plan_id, null);

  select p.* into v_previous from ops.follow_up_plans p
   where p.tenant_id = p_tenant_id and p.company_id = p_company_id and p.subject_key = v_subject and p.status = 'active'
     for update;
  if found then
    for v_follow_up in
      update ops.follow_ups f
         set status = 'superseded', closed_by = p_actor, close_reason = 'plan_superseded'
       where f.tenant_id = p_tenant_id and f.plan_id = v_previous.id and f.status = 'scheduled'
      returning f.id
    loop
      perform ops.record_event(p_tenant_id, p_company_id, 'follow_up.superseded', p_source, null, null,
        jsonb_build_object('follow_up_id', v_follow_up, 'plan_id', v_previous.id, 'superseded_by_plan_id', v_plan_id),
        v_previous.id);
    end loop;
    update ops.follow_up_plans
       set status = 'superseded', superseded_by_plan_id = v_plan_id, closed_by = p_actor
     where id = v_previous.id;
  end if;

  insert into ops.follow_up_plans (
    id, tenant_id, company_id, department_id, agent_id, policy_version_id, anchor_at,
    task_id, conversation_id, subject_ref, idempotency_key, request_fingerprint, created_by)
  values (
    v_plan_id, p_tenant_id, p_company_id, p_department_id, p_agent_id, v_version.id, p_anchor_at,
    p_task_id, p_conversation_id, p_subject_ref, p_idempotency_key, v_fingerprint, p_actor);

  for v_step in 1 .. v_steps loop
    v_due := p_anchor_at + make_interval(mins => v_version.step_offsets_minutes[v_step]);
    insert into ops.follow_ups (tenant_id, company_id, plan_id, step_number, step_count, due_at)
    values (p_tenant_id, p_company_id, v_plan_id, v_step, v_steps, v_due)
    returning id into v_follow_up;
    -- The payload is a reference; the worker resolves the occurrence from the
    -- leased job, never from it.
    v_job := ops.enqueue_job(p_tenant_id, 'follow_up.due', jsonb_build_object('follow_up_id', v_follow_up),
                             100, v_due, 5, 'follow_up.due:' || v_follow_up::text);
    update ops.follow_ups set job_id = v_job where id = v_follow_up;
    perform ops.record_event(p_tenant_id, p_company_id, 'follow_up.scheduled', p_source, null, null,
      jsonb_build_object('follow_up_id', v_follow_up, 'plan_id', v_plan_id, 'step', v_step, 'step_count', v_steps),
      v_plan_id);
  end loop;

  perform ops.pop_event_context(v_context);
  return jsonb_build_object('plan_id', v_plan_id, 'created', true, 'superseded_plan_id', v_previous.id);
end
$$;

-- Records that a person did a due follow-up. Only a due one can be completed;
-- a repeat is harmless.
create function ops.complete_follow_up(
  p_tenant_id    uuid,
  p_follow_up_id uuid,
  p_actor        text,
  p_source       text
)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_follow_up ops.follow_ups;
  v_context   jsonb;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.complete_follow_up');
  select f.* into v_follow_up from ops.follow_ups f
   where f.tenant_id = p_tenant_id and f.id = p_follow_up_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.complete_follow_up: follow-up not found in this tenant';
  end if;
  if v_follow_up.status = 'completed' then
    return 'already_completed';
  end if;
  if v_follow_up.status <> 'due' then
    raise exception using
      errcode = 'OS409',
      message = format('ops.complete_follow_up: a %s follow-up cannot be completed; only a due one can', v_follow_up.status);
  end if;
  v_context := ops.push_event_context(p_source, v_follow_up.plan_id, null);
  update ops.follow_ups
     set status = 'completed', closed_by = p_actor, close_reason = 'completed'
   where id = v_follow_up.id;
  perform ops.record_event(p_tenant_id, v_follow_up.company_id, 'follow_up.completed', p_source, null, null,
    jsonb_build_object('follow_up_id', v_follow_up.id, 'plan_id', v_follow_up.plan_id, 'step', v_follow_up.step_number),
    v_follow_up.plan_id);
  perform ops.pop_event_context(v_context);
  return 'completed';
end
$$;

-- Cancels one scheduled or due follow-up, with a reason CODE, never text. A
-- repeat is harmless; a completed or superseded one is refused.
create function ops.cancel_follow_up(
  p_tenant_id    uuid,
  p_follow_up_id uuid,
  p_reason       text,
  p_actor        text,
  p_source       text
)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_follow_up ops.follow_ups;
  v_context   jsonb;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.cancel_follow_up');
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception using errcode = 'OS400', message = 'ops.cancel_follow_up: a reason is a snake_case code';
  end if;
  select f.* into v_follow_up from ops.follow_ups f
   where f.tenant_id = p_tenant_id and f.id = p_follow_up_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.cancel_follow_up: follow-up not found in this tenant';
  end if;
  if v_follow_up.status = 'cancelled' then
    return 'already_cancelled';
  end if;
  if v_follow_up.status not in ('scheduled', 'due') then
    raise exception using
      errcode = 'OS409',
      message = format('ops.cancel_follow_up: a %s follow-up is closed', v_follow_up.status);
  end if;
  v_context := ops.push_event_context(p_source, v_follow_up.plan_id, null);
  update ops.follow_ups
     set status = 'cancelled', closed_by = p_actor, close_reason = p_reason
   where id = v_follow_up.id;
  perform ops.record_event(p_tenant_id, v_follow_up.company_id, 'follow_up.cancelled', p_source, null, null,
    jsonb_build_object('follow_up_id', v_follow_up.id, 'plan_id', v_follow_up.plan_id, 'step', v_follow_up.step_number,
                       'reason', p_reason),
    v_follow_up.plan_id);
  perform ops.pop_event_context(v_context);
  return 'cancelled';
end
$$;

-- Cancels a plan and every open occurrence of it. A repeat is harmless; a
-- superseded plan is refused (its successor is the plan to cancel).
create function ops.cancel_follow_up_plan(
  p_tenant_id uuid,
  p_plan_id   uuid,
  p_reason    text,
  p_actor     text,
  p_source    text
)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  v_plan      ops.follow_up_plans;
  v_follow_up ops.follow_ups;
  v_context   jsonb;
begin
  perform ops.require_scheduling_actor(p_actor, 'ops.cancel_follow_up_plan');
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception using errcode = 'OS400', message = 'ops.cancel_follow_up_plan: a reason is a snake_case code';
  end if;
  select p.* into v_plan from ops.follow_up_plans p
   where p.tenant_id = p_tenant_id and p.id = p_plan_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.cancel_follow_up_plan: plan not found in this tenant';
  end if;
  if v_plan.status = 'cancelled' then
    return 'already_cancelled';
  end if;
  if v_plan.status <> 'active' then
    raise exception using errcode = 'OS409', message = 'ops.cancel_follow_up_plan: a superseded plan is closed; cancel its successor';
  end if;
  v_context := ops.push_event_context(p_source, v_plan.id, null);
  for v_follow_up in
    update ops.follow_ups f
       set status = 'cancelled', closed_by = p_actor, close_reason = p_reason
     where f.tenant_id = p_tenant_id and f.plan_id = v_plan.id and f.status in ('scheduled', 'due')
    returning f.*
  loop
    perform ops.record_event(p_tenant_id, v_plan.company_id, 'follow_up.cancelled', p_source, null, null,
      jsonb_build_object('follow_up_id', v_follow_up.id, 'plan_id', v_plan.id, 'step', v_follow_up.step_number,
                         'reason', p_reason),
      v_plan.id);
  end loop;
  update ops.follow_up_plans set status = 'cancelled', closed_by = p_actor where id = v_plan.id;
  perform ops.pop_event_context(v_context);
  return 'cancelled';
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The worker's capability, and the stop that covers a follow-up job.
-- ---------------------------------------------------------------------------

-- Marks the follow-up bound to the leased job DUE. Takes no tenant, follow-up
-- or job argument: the occurrence is resolved from the live lease. A replay
-- finds it due or closed and changes nothing; this is the whole effect of the
-- job, and it contacts nobody. The runtime has already asked, under the
-- kill-switch lock this transaction still holds, whether a stop covers the
-- job; this re-reads it under that lock and refuses, so no path marks a
-- follow-up due under a covering stop.
create function ops.mark_follow_up_due()
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_job       ops.jobs := ops.leased_job();
  v_follow_up ops.follow_ups;
  v_context   jsonb;
begin
  if v_job.kind <> 'follow_up.due' then
    raise exception using errcode = '42501', message = 'ops.mark_follow_up_due: the leased job is not a follow-up due job';
  end if;
  select f.* into v_follow_up from ops.follow_ups f
   where f.tenant_id = v_job.tenant_id and f.job_id = v_job.id
     for update;
  if not found then
    raise exception using errcode = '42501', message = 'ops.mark_follow_up_due: no follow-up is bound to the leased job';
  end if;
  if v_follow_up.status <> 'scheduled' then
    return case v_follow_up.status when 'due' then 'already_due' else v_follow_up.status end;
  end if;
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind) is not null then
    raise exception using errcode = 'OS423', message = 'ops.mark_follow_up_due: an execution stop covers this follow-up; the job is held, not run';
  end if;
  if v_follow_up.due_at > clock_timestamp() then
    raise exception using errcode = 'OS425', message = 'ops.mark_follow_up_due: the follow-up is not due yet';
  end if;

  v_context := ops.push_event_context('agent-runtime', v_follow_up.plan_id, null);
  update ops.follow_ups set status = 'due' where id = v_follow_up.id;
  perform ops.record_event(v_job.tenant_id, v_follow_up.company_id, 'follow_up.due', 'agent-runtime', null, null,
    jsonb_build_object('follow_up_id', v_follow_up.id, 'plan_id', v_follow_up.plan_id, 'step', v_follow_up.step_number),
    v_follow_up.plan_id);
  perform ops.pop_event_context(v_context);
  return 'due';
end
$$;

comment on function ops.mark_follow_up_due() is
  'Moves the follow-up bound to the live lease''s job from scheduled to due, once; a replay changes nothing. Refuses under a covering execution stop. Contacts nobody. Resolves the follow-up from the live lease; takes no id.';

-- The stop that covers one job. Phase 3A.1 adds the follow-up job, held by the
-- stops of the unit its plan names (company, department and, when named, the
-- agent), fixed when the plan was created. Everything else is the Phase 2D.1
-- body unchanged (20260925120000_decision_shadow.sql, section 6).
create or replace function ops.job_covering_stop(p_tenant_id uuid, p_job_id uuid, p_job_kind text)
returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_company    uuid;
  v_department uuid;
  v_agent      uuid;
begin
  if p_job_kind = any (ops.internal_job_kinds()) then
    return null; -- administration stays up: the switch never holds maintenance
  end if;
  if p_job_kind = 'follow_up.due' then
    select p.company_id, p.department_id, p.agent_id into v_company, v_department, v_agent
      from ops.follow_ups f
      join ops.follow_up_plans p on p.tenant_id = f.tenant_id and p.company_id = f.company_id and p.id = f.plan_id
     where f.tenant_id = p_tenant_id and f.job_id = p_job_id;
    return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
  end if;
  select r.company_id, r.department_id, r.agent_id into v_company, v_department, v_agent
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.job_id = p_job_id;
  if not found then
    -- A shadow decision is held by the stops of the unit whose run it evaluates.
    select d.company_id, d.department_id, d.agent_id into v_company, v_department, v_agent
      from ops.decision_evaluations d
     where d.tenant_id = p_tenant_id and d.job_id = p_job_id;
  end if;
  if not found then
    select l.company_id into v_company
      from ops.task_jobs l
     where l.tenant_id = p_tenant_id and l.job_id = p_job_id;
  end if;
  return ops.covering_execution_stop(p_tenant_id, p_job_kind, v_company, v_department, v_agent);
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The operator's activity feed learns the follow-up facts, deny by default
--    (supabase/tests/companyOsEventAllowlist.test.ts keeps the list equal to
--    what the migrations emit). Each leaves only its step and, for a
--    cancellation, its reason code; never an id, a subject or a label. The
--    Phase 2C bodies are otherwise unchanged
--    (20260922120000_company_os_read_surface.sql, section 6).
-- ---------------------------------------------------------------------------

create or replace function ops.cos_event_known(p_type pg_catalog.text) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select p_type in (
    'company.created', 'company.status_changed', 'department.created', 'department.status_changed',
    'agent.created', 'agent.status_changed',
    'task.created', 'task.assigned', 'task.status_changed', 'task.completed', 'task.failed', 'task.cancelled',
    'task.execution_requested',
    'agent_run.requested', 'agent_run.started', 'agent_run.succeeded', 'agent_run.failed',
    'agent_run.indeterminate', 'agent_run.cancelled',
    'lead_triage.admitted', 'lead_triage.review_pending', 'lead_triage.reviewed',
    'communication.received', 'communication.inbound_refused', 'communication.inbound_held',
    'communication.channel_configured', 'communication.outbound_authorized', 'communication.outbound_attempted',
    'communication.outbound_blocked', 'communication.outbound_sent', 'communication.outbound_failed',
    'communication.outbound_indeterminate', 'communication.delivery_updated',
    'follow_up.scheduled', 'follow_up.due', 'follow_up.completed', 'follow_up.cancelled', 'follow_up.superseded');
$$;

create or replace function ops.cos_event_facts(p_tenant pg_catalog.uuid, p_type pg_catalog.text, p_payload pg_catalog.jsonb)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select case
    when p_type = 'lead_triage.reviewed' then
      pg_catalog.jsonb_build_object('decision', case when p_payload ->> 'decision' in ('accepted', 'rejected', 'needs_edit')
                                                      then p_payload ->> 'decision' end)
    when p_type in ('company.status_changed', 'department.status_changed', 'agent.status_changed',
                    'task.status_changed', 'task.completed', 'task.failed', 'task.cancelled', 'task.assigned',
                    'agent_run.started', 'agent_run.succeeded', 'agent_run.failed',
                    'agent_run.indeterminate', 'agent_run.cancelled') then
      pg_catalog.jsonb_build_object(
        'from_status', case when p_payload ->> 'from_status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'from_status' end,
        'to_status', case when p_payload ->> 'to_status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'to_status' end)
    when p_type in ('communication.inbound_refused', 'communication.inbound_held') then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid),
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    when p_type = 'communication.channel_configured' then
      pg_catalog.jsonb_build_object(
        'channel_id', ops.cos_ref_id(p_tenant, 'channel', nullif(p_payload ->> 'channel_id', '')::pg_catalog.uuid),
        'mode', case when p_payload ->> 'mode' in ('test', 'production') then p_payload ->> 'mode' end,
        'active', case when pg_catalog.jsonb_typeof(p_payload -> 'active') = 'boolean' then p_payload -> 'active' end)
    when p_type = 'communication.outbound_authorized' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'review_item_id', ops.cos_ref_id(p_tenant, 'review_item', nullif(p_payload ->> 'review_item_id', '')::pg_catalog.uuid))
    when p_type = 'communication.outbound_blocked' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'reason', case when p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then p_payload ->> 'reason' end)
    when p_type in ('communication.outbound_attempted', 'communication.outbound_sent', 'communication.outbound_failed',
                    'communication.outbound_indeterminate') then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid))
    when p_type = 'communication.delivery_updated' then
      pg_catalog.jsonb_build_object(
        'outbound_message_id', ops.cos_ref_id(p_tenant, 'outbound_message', nullif(p_payload ->> 'outbound_message_id', '')::pg_catalog.uuid),
        'status', case when p_payload ->> 'status' ~ '^[a-z_]{1,32}$' then p_payload ->> 'status' end,
        'previous', case when p_payload ->> 'previous' ~ '^[a-z_]{1,32}$' then p_payload ->> 'previous' end)
    -- Phase 3A.1: which step of a cadence, and for a cancellation its code.
    when p_type in ('follow_up.scheduled', 'follow_up.due', 'follow_up.completed', 'follow_up.cancelled',
                    'follow_up.superseded') then
      pg_catalog.jsonb_build_object(
        'step', case when pg_catalog.jsonb_typeof(p_payload -> 'step') = 'number'
                          and (p_payload ->> 'step') ~ '^[0-9]{1,2}$' then p_payload -> 'step' end,
        'reason', case when p_type = 'follow_up.cancelled' and p_payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$'
                       then p_payload ->> 'reason' end)
    else '{}'::pg_catalog.jsonb
  end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Access. Backend only; the worker reaches the follow-ups only through its
--    one capability. ops_operator_api is never named here (the static guard
--    reserves its ACL to the OD-8a files): new objects give it nothing, and
--    the end state below asserts so.
-- ---------------------------------------------------------------------------

revoke all on table ops.follow_up_policies, ops.follow_up_policy_versions, ops.follow_up_plans, ops.follow_ups
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function
  ops.follow_up_status_transitions(),
  ops.governed_job_kinds(),
  ops.follow_up_offsets_valid(integer[]),
  ops.refuse_scheduling_history_change(),
  ops.guard_follow_up_policy_version_insert(),
  ops.guard_follow_up_plan_insert(),
  ops.guard_follow_up_plan_update(),
  ops.guard_follow_up_plan_delete(),
  ops.guard_follow_up_delete(),
  ops.guard_follow_up_insert(),
  ops.guard_follow_up_update(),
  ops.require_scheduling_actor(text, text),
  ops.define_follow_up_policy_version(uuid, text, text, integer[], text),
  ops.schedule_follow_up_plan(uuid, uuid, uuid, uuid, text, timestamptz, uuid, uuid, text, text, text, text),
  ops.complete_follow_up(uuid, uuid, text, text),
  ops.cancel_follow_up(uuid, uuid, text, text, text),
  ops.cancel_follow_up_plan(uuid, uuid, text, text, text),
  ops.mark_follow_up_due(),
  ops.job_covering_stop(uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

grant execute on function ops.mark_follow_up_due() to ops_worker;

-- ---------------------------------------------------------------------------
-- 7. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
  c_tables constant pg_catalog.text[] := array['follow_up_policies', 'follow_up_policy_versions', 'follow_up_plans', 'follow_ups'];
  c_fns constant pg_catalog.text[] := array[
    'follow_up_status_transitions', 'governed_job_kinds', 'follow_up_offsets_valid', 'refuse_scheduling_history_change',
    'guard_follow_up_policy_version_insert', 'guard_follow_up_plan_insert', 'guard_follow_up_plan_update',
    'guard_follow_up_plan_delete', 'guard_follow_up_delete',
    'guard_follow_up_insert', 'guard_follow_up_update', 'require_scheduling_actor', 'define_follow_up_policy_version',
    'schedule_follow_up_plan', 'complete_follow_up', 'cancel_follow_up', 'cancel_follow_up_plan', 'mark_follow_up_due'];
begin
  select pg_catalog.string_agg(c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ops' and c.relname = any (c_tables)
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'follow-up table(s) lack ENABLE + FORCE row level security: %', v_bad;
  end if;

  select pg_catalog.string_agg(r.rolname || ':' || t.relname, ', ') into v_bad
    from pg_catalog.unnest(c_tables) as t (relname)
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where pg_catalog.has_table_privilege(r.rolname, 'ops.' || t.relname, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a follow-up table: %', v_bad;
  end if;

  -- Every update, delete and truncate guard is ENABLE ALWAYS.
  if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
        join pg_catalog.pg_class c on c.oid = t.tgrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname = any (c_tables) and not t.tgisinternal and t.tgenabled = 'A') <> 10 then
    raise exception 'the follow-up update, delete and truncate guards are not all ENABLE ALWAYS';
  end if;

  -- Exactly the worker's one capability is executable by any application or
  -- capability role.
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker' and p.proname = 'mark_follow_up_due');
  if v_bad is not null then
    raise exception 'a role can execute a follow-up function it must not: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = any (c_fns) and p.prosecdef and p.proname <> 'mark_follow_up_due') then
    raise exception 'a follow-up service is SECURITY DEFINER; only the worker capability may be';
  end if;

  -- The governed kind is exactly one, and neither external, internal, nor one
  -- a task may request.
  if ops.governed_job_kinds() is distinct from array['follow_up.due']::pg_catalog.text[]
     or ops.governed_job_kinds() && ops.external_job_kinds()
     or ops.governed_job_kinds() && ops.internal_job_kinds()
     or ops.governed_job_kinds() && ops.task_executable_kinds() then
    raise exception 'the follow-up kind is not exactly one governed kind, disjoint from the others';
  end if;

  -- A DUE FOLLOW-UP IS WORK, NOT A SEND: no follow-up function names a send,
  -- an outbound row, a model or decision call, a review decision, the CRM, a
  -- stop act, a budget, a price, a channel or a membership, or runs dynamic SQL.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_fns)
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp|send_|agent_run|shadow_decision|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels|grant_membership|revoke_membership|execute\s)';
  if v_bad is not null then
    raise exception 'a follow-up function reaches beyond scheduling operator work: %', v_bad;
  end if;
end
$end_state$;
