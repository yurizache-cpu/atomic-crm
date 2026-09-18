-- Phase 2A, final review: the review of a paid answer is opened AFTER the
-- answer's settlement commits, in a transaction of its own.
--
-- THE DEFECT (engine/domain/leadTriageSettlement.dbtest.ts, red before this
-- migration). 20260918090000 moved the review derivation into its own
-- subtransaction inside the AFTER UPDATE trigger on ops.agent_runs. That catches
-- every ordinary ERROR, but PL/pgSQL's `when others` does not catch
-- QUERY_CANCELED (57014), and 57014 is exactly what the worker's
-- statement_timeout and pg_cancel_backend raise. A lock wait in the derivation
-- that outlasted the worker's statement timeout, or a cancellation while it ran,
-- still aborted the statement that settles the run: the run stayed `running`,
-- its next lease settled it `indeterminate`, and the valid, already-paid answer
-- was lost. Measured both ways: an insert into the review queue that is
-- cancelled, and a real lock on the queue held from a second connection past a
-- two-second statement timeout.
--
-- THE FIX is to take the review out of the settlement.
--   1. The trigger no longer opens anything. Its function is emptied: it
--      returns before it reads a row, so the statement that settles a run no
--      longer touches the review queue at all. TX2b settles the run, completes
--      its job and commits, exactly as it does for every other capability. The
--      trigger itself is kept, inert, because the static migration guard
--      treats every dropped ops trigger as a removed invariant
--      (supabase/invariants/rules.mjs, `trigger-dropped`). This one carried no
--      invariant (it was a derivation), but dropping it is an exception only the
--      owner can approve through an Accepted ADR. Until then it stays, fires,
--      and does nothing.
--   2. ops.open_review_for_settled_job(worker, job). The worker runtime calls it
--      AFTER that commit, in a transaction of its own
--      (engine/worker/afterSettlement.ts). Whatever happens to that transaction
--      (an error, a lock wait, a timeout, a cancellation, a crash before it
--      starts), the settlement is already durable, the job is already complete,
--      and nothing can call the provider again. A review it could not open is
--      opened later, once, by ops.open_missing_reviews
--      (npm run ops -- triage recover).
--
-- The new function belongs to the worker, and it is narrow:
--   * It takes no tenant, run, result or consent argument. It names a JOB and
--     the worker that completed it. The tenant and the run are read from the
--     trusted rows, and ops.open_review_for_run derives the review from what the
--     database stored, exactly as before.
--   * It serves only the worker that completed that job, as its `succeeded` job
--     event records. This is the trust model of ops.resume_lease: a worker names
--     its own work, and any other worker is refused.
--   * It is idempotent. A run is reviewed once, so asking again opens nothing.
--   * It is SECURITY DEFINER because the lease ended with the settlement, and
--     with the lease the tenant context a capability runs in. ops_worker still
--     holds no privilege on either pilot table, and still cannot execute the
--     derivation or the recovery directly.

-- ---------------------------------------------------------------------------
-- 1. The settlement no longer opens the review. The body is empty on purpose:
--    no read, no lock, no call. Anything it did here would run inside the
--    statement that settles a paid answer.
-- ---------------------------------------------------------------------------

create or replace function ops.open_review_item()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  return null;
end
$function$;

comment on function ops.open_review_item() is
  'Inert since 20260918120000. It fired inside the statement that settles an agent run and opened the lead triage review there, where a cancelled or timed-out review could roll the paid settlement back. The review is now opened after the settlement commits (ops.open_review_for_settled_job). Kept only because dropping an ops trigger needs an owner-approved exception.';

-- ---------------------------------------------------------------------------
-- 2. The worker's post-settlement step.
-- ---------------------------------------------------------------------------

create or replace function ops.open_review_for_settled_job(p_worker_id text, p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job ops.jobs;
  v_run uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' or p_job_id is null then
    raise exception using
      errcode = 'OS400',
      message = 'ops.open_review_for_settled_job requires a worker id and a job id';
  end if;

  -- Only a COMPLETED agent run job has a settled run behind it. Anything else
  -- has nothing to open.
  select j.* into v_job
    from ops.jobs j
   where j.id = p_job_id
     and j.kind = 'agent_run.execute'
     and j.status = 'succeeded';
  if not found then
    return null;
  end if;

  -- Only the worker that completed it. The completion clears the lease, and the
  -- job's `succeeded` event is what still names that worker.
  if not exists (
    select 1
      from ops.job_events e
     where e.job_id = v_job.id
       and e.tenant_id = v_job.tenant_id
       and e.event = 'succeeded'
       and e.worker_id = p_worker_id
  ) then
    raise exception using
      errcode = 'OS403',
      message = 'ops.open_review_for_settled_job: that job was not completed by this worker';
  end if;

  select r.id into v_run
    from ops.agent_runs r
   where r.tenant_id = v_job.tenant_id
     and r.job_id = v_job.id;
  if v_run is null then
    return null;
  end if;

  -- The one derivation: a succeeded lead_triage run with a stored result, not
  -- yet reviewed. It returns NULL for anything else.
  return ops.open_review_for_run(v_job.tenant_id, v_run);
end
$function$;

comment on function ops.open_review_for_settled_job(text, uuid) is
  'The worker''s post-settlement step: opens the human review of the run a completed agent_run.execute job settled, when there is one to open, in a transaction of its own AFTER the settlement committed. Only for the worker that completed the job. No tenant, run or content argument; idempotent. A review it could not open is opened by ops.open_missing_reviews.';

comment on function ops.open_review_for_run(uuid, uuid) is
  'Opens the human review of one succeeded lead_triage run from its stored, validated result, once. Returns the review it opened, or NULL when there was nothing to open. The only derivation of a review item: the worker''s post-settlement step and the recovery both call it, and never inside the statement that settles the run.';

comment on function ops.open_missing_reviews(uuid, integer) is
  'Recovery: opens the review of every succeeded lead_triage run that has none, at most p_limit, optionally in one tenant. Returns how many it opened; running it again opens nothing twice. It swallows nothing: a failure raises to the operator.';

comment on table ops.review_items is
  'One advisory agent-run result awaiting a person. Derived only by ops.open_review_for_run from a run that SUCCEEDED, after its settlement committed; decided only by ops.record_review_decision; terminal once decided. Nothing in Phase 2A acts on an accepted item: acceptance records approval and no more.';

-- ---------------------------------------------------------------------------
-- 3. Access: the worker's alone.
-- ---------------------------------------------------------------------------

revoke all on function ops.open_review_for_settled_job(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function ops.open_review_for_settled_job(text, uuid) to ops_worker;

-- ---------------------------------------------------------------------------
-- 4. Assert the end state.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  -- The statement that settles a run touches no review: no trigger function on
  -- ops.agent_runs names the review queue, its derivation or its recovery, and
  -- the old derivation trigger's function does nothing but return.
  select string_agg(t.tgname || ' -> ' || p.proname, ', ') into v_bad
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'ops.agent_runs'::regclass
     and not t.tgisinternal
     and p.prosrc ~* '(review_items|open_review_for_run|open_missing_reviews|open_review_for_settled_job)';
  if v_bad is not null then
    raise exception 'a trigger on ops.agent_runs opens a review inside the settlement: %', v_bad;
  end if;
  if regexp_replace(
       (select p.prosrc from pg_proc p where p.oid = 'ops.open_review_item()'::regprocedure),
       '\s+', ' ', 'g') <> ' begin return null; end ' then
    raise exception 'ops.open_review_item() is not inert: a review would be opened inside the settlement';
  end if;

  -- The step is a DEFINER with an empty search path, executable by ops_worker
  -- and by no other application role, and not by PUBLIC.
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'ops.open_review_for_settled_job(text, uuid)'::regprocedure
       and p.prosecdef
       and coalesce(p.proconfig @> array['search_path=""'], false)) then
    raise exception 'ops.open_review_for_settled_job is not a DEFINER with an empty search path';
  end if;
  if not has_function_privilege('ops_worker', 'ops.open_review_for_settled_job(text, uuid)', 'execute') then
    raise exception 'ops_worker cannot execute ops.open_review_for_settled_job';
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from unnest(array['anon', 'authenticated', 'service_role']) as r (rolname)
   where has_function_privilege(r.rolname, 'ops.open_review_for_settled_job(text, uuid)', 'execute');
  if v_bad is not null then
    raise exception 'ops.open_review_for_settled_job is executable by %', v_bad;
  end if;
  if exists (select 1 from pg_proc p, aclexplode(p.proacl) a
              where p.oid = 'ops.open_review_for_settled_job(text, uuid)'::regprocedure
                and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'ops.open_review_for_settled_job is executable by PUBLIC';
  end if;

  -- The worker still reaches neither pilot table, nor the derivation or the
  -- recovery directly: only this one step, for its own completed job.
  select string_agg(format('%s on %s', v.p, v.t), ', ') into v_bad
    from (select t, p
            from unnest(array['ops.inbound_messages', 'ops.review_items']) t,
                 unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p) v
   where has_table_privilege('ops_worker', v.t, v.p);
  if v_bad is not null then
    raise exception 'ops_worker reaches a pilot table: %', v_bad;
  end if;
  if has_function_privilege('ops_worker', 'ops.open_review_for_run(uuid, uuid)', 'execute')
     or has_function_privilege('ops_worker', 'ops.open_missing_reviews(uuid, integer)', 'execute') then
    raise exception 'ops_worker can execute the derivation or the recovery directly';
  end if;
end
$$;
