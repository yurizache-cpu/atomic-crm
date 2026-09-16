-- Owner review of ADR 0016 (2026-09-16): a provider server error is an AMBIGUOUS
-- outcome, and an ambiguous outcome is `indeterminate`.
--
-- 20260914120000_agent_runtime recorded the category provider_5xx as `failed`, on the
-- reading that an HTTP 500 or 503 is the provider saying it did not complete. A 5xx
-- does not prove that: the model may have run, and been billed, before the failure
-- became visible to us. Under the at-most-once model, an outcome whose execution
-- cannot be ruled out is `indeterminate`, and nothing ever retries it automatically.
--
-- The rule every category now follows:
--   failed         the provider was never called, or its answer settles the outcome:
--                  a refusal that proves the model never ran (credentials, quota, a
--                  malformed request, a missing model), or a complete response the
--                  worker read and could not use.
--   indeterminate  the model may have run and nobody can say how it ended: a server
--                  or gateway error, a timeout, a lost connection, an abort in
--                  flight, an interrupted attempt, or anything nobody classified.
--   cancelled      a deterministic gate refused the run before any call.
--
-- This migration moves provider_5xx to the indeterminate side in the one place a
-- category's meaning is decided, ops.agent_run_error_status(), and in the table's own
-- constraint, then asserts the complete mapping. The worker-side mirror is
-- engine/models/errors.ts, and a driver-backed test asserts the two agree.
--
-- Forward only. 20260914120000 is not edited: its own end-state assertion holds at
-- the moment it is applied, and this file asserts the reviewed mapping after it.

create or replace function ops.agent_run_error_status(p_category text)
returns text
language sql
immutable
set search_path to ''
as $function$
  select case
    when p_category in ('configuration', 'authentication', 'rate_limit', 'invalid_request',
                        'invalid_response', 'schema_validation', 'job_failed')
      then 'failed'
    when p_category in ('timeout', 'transport', 'provider_5xx', 'cancelled', 'unknown', 'interrupted')
      then 'indeterminate'
    when p_category = 'refused'
      then 'cancelled'
  end;
$function$;

revoke all on function ops.agent_run_error_status(text) from public;

-- A run already recorded as a failed provider server error would make the new
-- constraint unaddable. None can exist outside a development database (no hosted
-- project has run this runtime), and rewriting a settled run's outcome is not this
-- migration's call, so it stops and says why instead of failing on the constraint.
do $$
begin
  if exists (
    select 1
      from ops.agent_runs r
     where r.status = 'failed'
       and r.error_category = 'provider_5xx'
  ) then
    raise exception 'ops.agent_runs holds runs recorded as failed provider server errors; reset the local database before applying the owner review of ADR 0016';
  end if;
end
$$;

-- The table holds the same pairs, so no write path, the owner's raw DML included, can
-- store a provider server error as a known failure.
alter table ops.agent_runs drop constraint agent_runs_category_status_pair;

alter table ops.agent_runs add constraint agent_runs_category_status_pair check (
     error_category is null
  or (status = 'failed' and error_category in ('configuration', 'authentication', 'rate_limit', 'invalid_request',
                                               'invalid_response', 'schema_validation', 'job_failed'))
  or (status = 'indeterminate' and error_category in ('timeout', 'transport', 'provider_5xx', 'cancelled',
                                                      'unknown', 'interrupted'))
  or (status = 'cancelled' and error_category = 'refused'));

-- End state.
do $$
declare
  v_bad text;
  v_def text;
  v_failed text;
  v_indeterminate text;
begin
  select string_agg(c.category, ', ') into v_bad
    from (values
      ('configuration', 'failed'), ('authentication', 'failed'), ('rate_limit', 'failed'),
      ('invalid_request', 'failed'), ('invalid_response', 'failed'), ('schema_validation', 'failed'),
      ('job_failed', 'failed'),
      ('timeout', 'indeterminate'), ('transport', 'indeterminate'), ('provider_5xx', 'indeterminate'),
      ('cancelled', 'indeterminate'), ('unknown', 'indeterminate'), ('interrupted', 'indeterminate'),
      ('refused', 'cancelled')) as c (category, status)
   where ops.agent_run_error_status(c.category) is distinct from c.status;
  if v_bad is not null then
    raise exception 'agent run error categories map to the wrong status after the owner review: %', v_bad;
  end if;

  if ops.agent_run_error_status('made_up') is not null then
    raise exception 'ops.agent_run_error_status() gives a status to a category nobody defined';
  end if;

  if not exists (
    select 1
      from pg_constraint k
     where k.conrelid = 'ops.agent_runs'::regclass
       and k.conname = 'agent_runs_category_status_pair'
       and k.contype = 'c'
       and k.convalidated
  ) then
    raise exception 'ops.agent_runs lost its validated category/status constraint';
  end if;

  -- The constraint's body, as Postgres stores it: each category sits in its own
  -- status's branch and in no other, and each branch names exactly its categories.
  -- A branch that cannot be found leaves its text empty, which fails below.
  select pg_get_constraintdef(k.oid) into v_def
    from pg_constraint k
   where k.conrelid = 'ops.agent_runs'::regclass
     and k.conname = 'agent_runs_category_status_pair';
  v_failed := split_part(split_part(v_def, '(status = ''failed''::text)', 2),
                         '(status = ''indeterminate''::text)', 1);
  v_indeterminate := split_part(split_part(v_def, '(status = ''indeterminate''::text)', 2),
                                '(status = ''cancelled''::text)', 1);
  select string_agg(c.category, ', ') into v_bad
    from (values
      ('configuration', 'failed'), ('authentication', 'failed'), ('rate_limit', 'failed'),
      ('invalid_request', 'failed'), ('invalid_response', 'failed'), ('schema_validation', 'failed'),
      ('job_failed', 'failed'),
      ('timeout', 'indeterminate'), ('transport', 'indeterminate'), ('provider_5xx', 'indeterminate'),
      ('cancelled', 'indeterminate'), ('unknown', 'indeterminate'), ('interrupted', 'indeterminate'),
      ('refused', 'cancelled')) as c (category, status)
   where (c.status = 'failed')
           is distinct from (position(quote_literal(c.category) || '::text' in v_failed) > 0)
      or (c.status = 'indeterminate')
           is distinct from (position(quote_literal(c.category) || '::text' in v_indeterminate) > 0);
  if v_bad is not null
     or (length(v_failed) - length(replace(v_failed, '::text', ''))) / 6 <> 7
     or (length(v_indeterminate) - length(replace(v_indeterminate, '::text', ''))) / 6 <> 6
     or position('(status = ''cancelled''::text) AND (error_category = ''refused''::text)' in v_def) = 0 then
    raise exception 'ops.agent_runs stores error categories under the wrong status after the owner review: %',
      coalesce(v_bad, 'a branch names the wrong set of categories');
  end if;

  if has_function_privilege('public', 'ops.agent_run_error_status(text)', 'EXECUTE') then
    raise exception 'ops.agent_run_error_status(text) is executable by PUBLIC';
  end if;
end
$$;
