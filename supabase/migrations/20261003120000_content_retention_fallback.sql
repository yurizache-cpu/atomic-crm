-- BASELINE Q8 D6/D7, final internal-retention correction (owner policy,
-- 2026-09-28): no health or person_text AI working content may remain
-- indefinitely merely because its flow never reached a decided review.
--
-- Before this, the retention clock (20261002120000) started only at a decided
-- review, so a flow whose run failed, was refused or is indeterminate, whose
-- review was never decided, or that never got a run at all, kept its content
-- until the owner erased it. Now every protected task has ONE effective
-- retention state from its creation, derived deterministically from its own
-- authoritative rows, in this order of precedence:
--
--   A  review_decided           the latest decided review's reviewed_at, for the
--                               relied-on authorization's content_retention_days,
--                               or 30 (unchanged D6);
--   B  review_undecided         otherwise, the latest review's created_at + 30;
--   C  terminal_without_review  otherwise, the latest finished run's
--                               completed_at + 30 (succeeded, failed,
--                               indeterminate or cancelled: the run vocabulary);
--   D  task_created             otherwise, the task's created_at + 30.
--
-- The clock only moves forward, and a decided review, once it anchors the clock,
-- is never displaced by a fallback. The state is applied when the task is
-- created, when a review of it opens, when one is decided, and again whenever
-- its job fires or the owner sweeps it. A run's terminal instant is READ then,
-- never written inside a run's settlement: nothing here can roll a paid
-- settlement back (the Phase 2A §16 lesson).
--
-- ONE job per flow: the flow's bound job is rescheduled in place while it is
-- queued; a new one is queued and bound only when the bound one is already
-- running or finished. Automatic expiry is held only by a run pending or
-- running (a worker may still need the content); a review left undecided past
-- its fallback no longer holds it. The owner's erasure keeps its stricter rule.
-- Redaction itself is unchanged.

-- ---------------------------------------------------------------------------
-- 1. The ledger records why its clock is anchored.
-- ---------------------------------------------------------------------------

alter table ops.content_retention add column if not exists anchor_reason text;

comment on column ops.content_retention.anchor_reason is
  'Why the clock is anchored where it is: review_decided (D6), review_undecided, terminal_without_review or task_created (the owner''s fallbacks). NULL only for a flow erased before it had a clock.';

-- The precedence of the reasons at an equal anchor instant.
create or replace function ops.content_anchor_rank(p_reason text)
returns integer
language sql
immutable
set search_path to ''
as $function$
  select case p_reason
           when 'task_created' then 1
           when 'terminal_without_review' then 2
           when 'review_undecided' then 3
           when 'review_decided' then 4
           else 0
         end;
$function$;

-- The ledger guard of 20261002120000, with the reason: the clock moves only
-- forward (or, at an equal instant, to a reason of higher precedence), a
-- decided review's anchor is never displaced by a fallback, and a row anchored
-- before reasons existed is classified once.
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
  -- Before this migration every anchor was a decided review's.
  if old.anchor_reason is null and old.anchored_at is not null and new.anchor_reason = 'review_decided'
     and (to_jsonb(new) - array['anchor_reason', 'updated_at'])
         = (to_jsonb(old) - array['anchor_reason', 'updated_at']) then
    return new;
  end if;
  if old.redacted_at is not null then
    raise exception using
      errcode = 'OS409',
      message = 'ops.content_retention: the content is redacted, and a redaction is final';
  end if;
  if new.anchored_at is distinct from old.anchored_at
     or new.anchor_reason is distinct from old.anchor_reason then
    if old.anchored_at is null or new.anchored_at is null then
      raise exception using
        errcode = 'OS409',
        message = 'ops.content_retention: a clock is never removed';
    end if;
    if old.anchor_reason = 'review_decided' and new.anchor_reason is distinct from 'review_decided' then
      raise exception using
        errcode = 'OS409',
        message = 'ops.content_retention: a decided review''s clock is never displaced by a fallback';
    end if;
    if not (new.anchored_at > old.anchored_at
            or (new.anchored_at = old.anchored_at
                and ops.content_anchor_rank(new.anchor_reason) > ops.content_anchor_rank(old.anchor_reason))) then
      raise exception using
        errcode = 'OS409',
        message = 'ops.content_retention: the clock only moves forward';
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

update ops.content_retention set anchor_reason = 'review_decided' where anchored_at is not null;

alter table ops.content_retention drop constraint if exists content_retention_anchor_shape;
alter table ops.content_retention add constraint content_retention_anchor_shape check (
      (anchor_reason is null) = (anchored_at is null)
  and (anchored_at is null) = (retention_days is null)
  and (anchored_at is null) = (due_at is null)
  and (review_item_id is not null) = coalesce(anchor_reason in ('review_decided', 'review_undecided'), false)
  and (data_authorization_id is null or anchor_reason = 'review_decided')
  and (anchor_reason is null or anchor_reason = 'review_decided' or retention_days = 30)
  and (due_at is null or due_at = anchored_at + retention_days * interval '24 hours'));
alter table ops.content_retention drop constraint if exists content_retention_reason_check;
alter table ops.content_retention add constraint content_retention_reason_check check (
  anchor_reason is null
  or anchor_reason in ('review_decided', 'review_undecided', 'terminal_without_review', 'task_created'));

-- Automatic expiry may now redact a review left undecided past its fallback;
-- a redacted row still carries no content and no note.
alter table ops.review_items drop constraint if exists review_items_redacted_content;
alter table ops.review_items add constraint review_items_redacted_content check (
      (proposed is null) = (content_redacted_at is not null)
  and (content_redacted_at is null or decision_note is null));

-- ---------------------------------------------------------------------------
-- 2. The effective clock, and the one job that serves it.
-- ---------------------------------------------------------------------------

-- The task's effective anchor, from its own rows, by the precedence above.
create or replace function ops.content_retention_anchor(
  p_tenant_id               uuid,
  p_task_id                 uuid,
  out anchor_reason         text,
  out anchored_at           timestamptz,
  out retention_days        integer,
  out review_item_id        uuid,
  out data_authorization_id uuid
)
language plpgsql
stable
set search_path to ''
as $function$
begin
  select v.id, v.reviewed_at, r.data_authorization_id
    into review_item_id, anchored_at, data_authorization_id
    from ops.review_items v
    left join ops.agent_runs r on r.tenant_id = v.tenant_id and r.id = v.agent_run_id
   where v.tenant_id = p_tenant_id and v.task_id = p_task_id and v.status <> 'pending'
   order by v.reviewed_at desc, v.id desc
   limit 1;
  if found then
    anchor_reason := 'review_decided';
    retention_days := ops.content_retention_days(data_authorization_id);
    return;
  end if;
  data_authorization_id := null;
  retention_days := ops.content_retention_max_days();

  select v.id, v.created_at into review_item_id, anchored_at
    from ops.review_items v
   where v.tenant_id = p_tenant_id and v.task_id = p_task_id
   order by v.created_at desc, v.id desc
   limit 1;
  if found then
    anchor_reason := 'review_undecided';
    return;
  end if;
  review_item_id := null;

  select max(r.completed_at) into anchored_at
    from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.task_id = p_task_id
     and r.status in ('succeeded', 'failed', 'indeterminate', 'cancelled');
  if anchored_at is not null then
    anchor_reason := 'terminal_without_review';
    return;
  end if;

  select t.created_at into anchored_at
    from ops.tasks t
   where t.tenant_id = p_tenant_id and t.id = p_task_id;
  anchor_reason := 'task_created';
end
$function$;

-- Keeps ONE job bound to the flow, available at its due instant: the bound job
-- is moved while it is still queued; otherwise (running, or finished) a new one
-- is queued and bound.
create or replace function ops.bind_content_retention_job(p_retention_id uuid, p_available_at timestamptz)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_row ops.content_retention;
  v_job uuid;
begin
  select r.* into v_row from ops.content_retention r where r.id = p_retention_id;
  update ops.jobs
     set available_at = p_available_at, updated_at = now()
   where tenant_id = v_row.tenant_id and id = v_row.job_id and status = 'queued'
  returning id into v_job;
  if v_job is null then
    -- The payload is a reference; the capability resolves the flow from the
    -- leased job's binding, never from it.
    v_job := ops.enqueue_job(v_row.tenant_id, 'content.retention_due',
                             jsonb_build_object('content_retention_id', v_row.id),
                             100, p_available_at, 10, null);
    update ops.content_retention set job_id = v_job where id = v_row.id;
  end if;
  return v_job;
end
$function$;

-- Creates or moves forward the task's one retention state, from its effective
-- anchor, and keeps its one job at the due instant. Changes nothing once the
-- content is redacted, and never displaces a decided review's clock.
create or replace function ops.refresh_content_retention(p_tenant_id uuid, p_task_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_class text;
  v_row   ops.content_retention;
  v_eff   record;
  v_due   timestamptz;
  v_id    uuid;
begin
  select t.data_class into v_class
    from ops.tasks t
   where t.tenant_id = p_tenant_id and t.id = p_task_id;
  if v_class is null or v_class not in ('health', 'person_text') then
    return null;
  end if;
  select * into v_eff from ops.content_retention_anchor(p_tenant_id, p_task_id);
  v_due := v_eff.anchored_at + v_eff.retention_days * interval '24 hours';

  insert into ops.content_retention (
    tenant_id, company_id, task_id, data_class, anchor_reason, review_item_id, anchored_at,
    retention_days, data_authorization_id, due_at)
  select t.tenant_id, t.company_id, t.id, t.data_class, v_eff.anchor_reason, v_eff.review_item_id,
         v_eff.anchored_at, v_eff.retention_days, v_eff.data_authorization_id, v_due
    from ops.tasks t
   where t.tenant_id = p_tenant_id and t.id = p_task_id
  on conflict (tenant_id, task_id) do nothing
  returning id into v_id;
  if v_id is not null then
    perform ops.bind_content_retention_job(v_id, v_due);
    return v_id;
  end if;

  select r.* into v_row
    from ops.content_retention r
   where r.tenant_id = p_tenant_id and r.task_id = p_task_id
     for update;
  if v_row.redacted_at is not null or v_row.anchored_at is null then
    return v_row.id;
  end if;
  if v_row.anchor_reason = 'review_decided' and v_eff.anchor_reason <> 'review_decided' then
    return v_row.id;
  end if;
  if v_eff.anchored_at > v_row.anchored_at
     or (v_eff.anchored_at = v_row.anchored_at
         and ops.content_anchor_rank(v_eff.anchor_reason) > ops.content_anchor_rank(v_row.anchor_reason)) then
    update ops.content_retention
       set anchor_reason = v_eff.anchor_reason, review_item_id = v_eff.review_item_id,
           anchored_at = v_eff.anchored_at, retention_days = v_eff.retention_days,
           data_authorization_id = v_eff.data_authorization_id, due_at = v_due
     where id = v_row.id;
    perform ops.bind_content_retention_job(v_row.id, v_due);
  end if;
  return v_row.id;
end
$function$;

comment on function ops.refresh_content_retention(uuid, uuid) is
  'Q8 D6/D7: creates or moves forward the one retention state of a health or person_text task from its own rows (a decided review, else an undecided review, else a finished run, else the task''s creation; at most 30 days), and keeps its one job at the due instant. Holds no content.';

-- The decided-review entry point of 20261002120000, now the same refresh.
create or replace function ops.schedule_content_retention(p_review_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_review ops.review_items;
begin
  select v.* into v_review from ops.review_items v where v.id = p_review_id;
  if not found then
    return null;
  end if;
  return ops.refresh_content_retention(v_review.tenant_id, v_review.task_id);
end
$function$;

create or replace function ops.refresh_content_retention_on_row()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_table_name = 'tasks' then
    perform ops.refresh_content_retention(new.tenant_id, new.id);
  else
    perform ops.refresh_content_retention(new.tenant_id, new.task_id);
  end if;
  return null;
end
$function$;

-- A protected task has its clock from its creation (D, the catch-all).
drop trigger if exists tasks_schedule_retention on ops.tasks;
create trigger tasks_schedule_retention
  after insert on ops.tasks
  for each row when (new.data_class in ('health', 'person_text'))
  execute function ops.refresh_content_retention_on_row();
alter table ops.tasks enable always trigger tasks_schedule_retention;

-- A review opening moves it to the undecided-review fallback (B).
drop trigger if exists review_items_schedule_retention_on_open on ops.review_items;
create trigger review_items_schedule_retention_on_open
  after insert on ops.review_items
  for each row execute function ops.refresh_content_retention_on_row();
alter table ops.review_items enable always trigger review_items_schedule_retention_on_open;

-- ---------------------------------------------------------------------------
-- 3. Redaction: automatic expiry re-reads the clock first, and only a run that
--    may still need the content holds it.
-- ---------------------------------------------------------------------------

create or replace function ops.content_run_in_progress(p_tenant_id uuid, p_task_id uuid)
returns boolean
language sql
stable
set search_path to ''
as $function$
  select exists (select 1 from ops.agent_runs r
                  where r.tenant_id = p_tenant_id and r.task_id = p_task_id
                    and r.status in ('pending', 'running'));
$function$;

-- The redaction core of 20261002120000, with two changes: automatic expiry
-- first refreshes the flow's clock (a finished run or a review opened since
-- moves it forward, never back), and it is held only by a run pending or
-- running; the owner's erasure is still refused while a review is undecided.
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

  if p_reason = 'retention_expired' then
    perform ops.refresh_content_retention(p_tenant_id, p_task_id);
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
  if (p_reason = 'retention_expired' and ops.content_run_in_progress(p_tenant_id, p_task_id))
     or (p_reason = 'erasure' and ops.content_flow_in_progress(p_tenant_id, p_task_id)) then
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
  'D6/D7: redacts one health or person_text task''s AI working content in place (task description and request fingerprint; every run''s result and input fingerprint; every review''s proposed copy and note; the admission''s body fingerprint) and records when, why and by whom in ops.content_retention. Automatic expiry refreshes the clock first and waits only for a run pending or running; erasure also waits for an undecided review. Deletes nothing and changes no other column.';

-- The worker's capability of 20261002120000: when the flow is not yet due (its
-- clock moved forward) or a run may still need its content, the flow keeps
-- exactly one bound job, the refreshed due instant's or one an hour on.
create or replace function ops.redact_due_content()
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job    ops.jobs := ops.leased_job();
  v_row    ops.content_retention;
  v_status text;
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
  v_status := ops.redact_task_content(v_row.tenant_id, v_row.task_id, 'retention_expired', 'system:content-retention');
  if v_status not in ('in_progress', 'not_due') then
    return v_status;
  end if;
  -- The refresh may already have bound the flow's next job; this job is running,
  -- so if it is still the bound one, the next is queued now.
  select r.* into v_row from ops.content_retention r where r.id = v_row.id;
  if v_row.job_id = v_job.id then
    perform ops.bind_content_retention_job(
      v_row.id,
      case when v_status = 'not_due' then v_row.due_at else clock_timestamp() + interval '1 hour' end);
  end if;
  return 'deferred';
end
$function$;

comment on function ops.redact_due_content() is
  'D6: redacts the flow bound to the live lease''s content.retention_due job once its refreshed clock is due; otherwise the flow keeps exactly one bound job (at the moved due instant, or an hour on while a run is pending or running). A replay changes nothing. Resolves the flow from the lease; takes no id. Contacts nobody.';

-- ---------------------------------------------------------------------------
-- 4. Every protected task already stored gets its one state and job now.
-- ---------------------------------------------------------------------------

do $$
declare
  v_task record;
begin
  for v_task in
    select t.tenant_id, t.id
      from ops.tasks t
     where t.data_class in ('health', 'person_text')
     order by t.created_at, t.id
  loop
    perform ops.refresh_content_retention(v_task.tenant_id, v_task.id);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Access: backend only, as before. The worker's one capability is unchanged.
-- ---------------------------------------------------------------------------

revoke all on function ops.content_anchor_rank(text) from public;
revoke all on function ops.guard_content_retention_update() from public;
revoke all on function ops.content_retention_anchor(uuid, uuid) from public;
revoke all on function ops.bind_content_retention_job(uuid, timestamptz) from public;
revoke all on function ops.refresh_content_retention(uuid, uuid) from public;
revoke all on function ops.schedule_content_retention(uuid) from public;
revoke all on function ops.refresh_content_retention_on_row() from public;
revoke all on function ops.content_run_in_progress(uuid, uuid) from public;
revoke all on function ops.redact_task_content(uuid, uuid, text, text) from public;
revoke all on function ops.redact_due_content() from public;

grant execute on function ops.redact_due_content() to ops_worker;

do $$
begin
  if exists (select 1
               from ops.tasks t
              where t.data_class in ('health', 'person_text')
                and not exists (select 1 from ops.content_retention r
                                 where r.tenant_id = t.tenant_id and r.task_id = t.id)) then
    raise exception 'a health or person_text task has no retention state';
  end if;
  if exists (select 1
               from ops.content_retention r
              where r.redacted_at is null
                and not exists (select 1 from ops.jobs j
                                 where j.tenant_id = r.tenant_id and j.id = r.job_id
                                   and j.kind = 'content.retention_due' and j.status in ('queued', 'leased'))) then
    raise exception 'an unredacted retention state has no live job';
  end if;
  if exists (select 1
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops'
                and p.proname in ('content_anchor_rank', 'content_retention_anchor', 'bind_content_retention_job',
                                  'refresh_content_retention', 'content_run_in_progress', 'redact_task_content',
                                  'redact_due_content')
                and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                             where a.privilege_type = 'EXECUTE'
                               and a.grantee <> p.proowner
                               and not (p.proname = 'redact_due_content'
                                        and a.grantee = (select oid from pg_roles where rolname = 'ops_worker')))) then
    raise exception 'a retention function is executable by a role other than its owner (and the worker''s one capability)';
  end if;
end
$$;
