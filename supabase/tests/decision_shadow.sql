-- Phase 2D.1 — the shadow decision layer, attacked in SQL.
--
-- The question: can a shadow decision decide anything, see anything it must
-- not, run outside the synthetic and test scope, run twice, ignore a stop,
-- store a malformed vector, or reach another tenant?
--
--   D1  the strict vector check and the deterministic policy, case by case;
--   D2  the allowlisted input: exact keys, vocabulary values only, no body,
--       draft, summary, contact, name or id, and nothing across tenants;
--   D3  the request: out of scope (Q8) is never requested; once per review;
--       one job of the shadow kind that no task can request; a foreign review
--       is not found;
--   D4  a request under an active stop is recorded refused, with no job;
--   D5  the lease-bound lifecycle: running before the provider is asked, a
--       valid vector completed with its policy, and the review, its outbound
--       state, the CRM and the stops untouched;
--   D6  at most once: an interrupted attempt is indeterminate, never asked
--       again, and its settlement refused;
--   D7  every vector outcome, and every malformed or mismatched vector stored
--       invalid, never as a recommendation; human review required whatever the
--       confidence;
--   D8  the record's guard: identity, transitions, the constant;
--   D9  the stops at the start, and a job_kind stop naming the new kind;
--   D10 the read projection: minimised, advisory, and allowedDecisions
--       unchanged by any recommendation;
--   D11 access: nobody but the worker reaches the three functions, nobody
--       the table, and the capabilities need a live lease;
--   X   deliberate breaks, each caught by its own check.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

-- `set role ops_worker` for the worker's capabilities; interpolated, never
-- `grant ... to current_user` (owner decision S0-F).
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Helpers and fixtures.
-- ---------------------------------------------------------------------------

create temporary table ds_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into ds_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from ds_ids where name = p_name;
  if v is null then raise exception 'setup: no id named %', p_name; end if;
  return v;
end
$$;

-- A lead triage result carrying sentinels in every free-text field.
create function pg_temp.triage(p_outcome text, p_intent text, p_priority text, p_flags jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'outcome', p_outcome, 'intent', p_intent, 'priority', p_priority, 'flags', p_flags,
    'summary', 'SENTINEL-DS-SUMMARY a synthetic person asks about a first session.',
    'recommended_next_action', 'SENTINEL-DS-NEXT offer two synthetic slots.',
    'response_draft', 'SENTINEL-DS-DRAFT Oi!', 'needs_human_review', true);
$$;

-- Lease a job as the given worker, as ops.lease_job does, and bind the session to it.
create function pg_temp.lease(p_job uuid, p_worker text) returns uuid
language plpgsql as $f$
begin
  update ops.jobs
     set status = 'leased', lease_owner = p_worker, leased_at = now(),
         lease_expires_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
   where id = p_job and status = 'queued';
  if not found then
    raise exception 'setup: job % is not queued', p_job;
  end if;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  select j.id, j.tenant_id, 'leased', p_worker, j.attempts, j.kind from ops.jobs j where j.id = p_job;
  perform set_config('app.worker_id', p_worker, true);
  perform set_config('app.job_id', p_job::text, true);
  return p_job;
end
$f$;

-- A synthetic admission through to its open review, through the worker's own
-- capabilities: admitted, started, completed, the job completed, the review
-- opened after the settlement.
create function pg_temp.review(p_key text, p_tenant uuid, p_company uuid, p_agent uuid, p_result jsonb)
returns uuid
language plpgsql as $f$
declare
  c_worker constant text := 'ds-worker';
  v   jsonb;
  run uuid;
  job uuid;
  st  text;
begin
  v := ops.admit_inbound_message(p_tenant, p_company, p_agent, 'synthetic', 'ds-ext-' || p_key,
                                 'synthetic:SENTINEL-DS-CONTACT-' || p_key || '@example.test',
                                 'SENTINEL-DS-BODY-' || p_key || ' Maria Silva +5511999990000 asks about anxiety.',
                                 'ds-suite', false, now());
  run := (v ->> 'agent_run_id')::uuid;
  select r.job_id into job from ops.agent_runs r where r.id = run;
  perform pg_temp.lease(job, c_worker);
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  st := ops.start_agent_run('fake', 'ds-model-1', 'lead_triage.v1',
                            encode(sha256(convert_to(run::text, 'UTF8')), 'hex'), 8000);
  if st is distinct from 'running' then
    execute 'reset role';
    raise exception 'setup: run % did not start (%)', run, st;
  end if;
  perform ops.complete_agent_run(p_result, 'ds-model-1', 'completed', null, null, 120, 60, 180, 0, 0, 42);
  perform ops.complete_job(job);
  perform ops.open_review_for_settled_job(c_worker, job);
  execute 'reset role';
  return pg_temp.remember('review.' || p_key, (select r.id from ops.review_items r where r.agent_run_id = run));
end
$f$;

-- The evaluation of a review, and its job.
create function pg_temp.eval(p_review uuid) returns ops.decision_evaluations
language sql as $$ select e.* from ops.decision_evaluations e where e.review_item_id = p_review; $$;

-- Start a requested evaluation as the worker, returning what the start answered.
create function pg_temp.start(p_review uuid, p_kind text default 'fake', p_id text default 'fake-rules',
                              p_version text default '1')
returns jsonb
language plpgsql as $f$
declare v jsonb;
begin
  perform pg_temp.lease((pg_temp.eval(p_review)).job_id, 'ds-worker');
  execute 'set local role ops_worker';
  v := ops.start_shadow_decision(p_kind, p_id, p_version);
  execute 'reset role';
  return v;
end
$f$;

-- Settle the evaluation whose job this session holds, as the worker.
create function pg_temp.settle(p_outcome text, p_vector jsonb, p_code text default null) returns text
language plpgsql as $f$
declare v text;
begin
  execute 'set local role ops_worker';
  v := ops.settle_shadow_decision(p_outcome, p_vector, p_code);
  execute 'reset role';
  return v;
end
$f$;

-- A vector for a started evaluation, with any keys replaced.
create function pg_temp.vector(p_review uuid, p_patch jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object(
    'version', 'decision_vector.v1', 'mode', 'shadow', 'recommendation', 'accept', 'confidence', 0.82,
    'caution', 'low', 'reasonCodes', jsonb_build_array('triage_complete', 'intent_information'),
    'provider', jsonb_build_object('kind', 'fake', 'id', 'fake-rules', 'version', '1'),
    'inputFingerprint', (pg_temp.eval(p_review)).input_fingerprint,
    'evaluatedAt', '2026-09-24T12:00:00.000Z') || p_patch;
$$;

-- What a shadow decision must never touch, per tenant.
create function pg_temp.untouched(p_tenant uuid) returns jsonb
language sql as $$
  select jsonb_build_object(
    'reviews', (select jsonb_agg(jsonb_build_array(r.id, r.status, r.reviewer, r.reviewed_at, r.decision_note) order by r.id)
                  from ops.review_items r where r.tenant_id = p_tenant),
    'outbound', (select count(*) from ops.outbound_messages o where o.tenant_id = p_tenant),
    'events', (select count(*) from ops.events e where e.tenant_id = p_tenant),
    'tasks', (select jsonb_agg(jsonb_build_array(t.id, t.status) order by t.id) from ops.tasks t where t.tenant_id = p_tenant),
    'runs', (select jsonb_agg(jsonb_build_array(r.id, r.status) order by r.id) from ops.agent_runs r where r.tenant_id = p_tenant),
    'stops', (select count(*) from ops.execution_stops s where s.tenant_id = p_tenant),
    'limits', (select count(*) from ops.spend_limits l where l.tenant_id = p_tenant),
    'channels', (select count(*) from ops.communication_channels c where c.tenant_id = p_tenant),
    'crm_contacts', (select count(*) from public.contacts));
$$;

do $$
declare
  ta uuid; tb uuid; co uuid; d uuid; ag uuid; ag2 uuid; cob uuid; db uuid; agb uuid;
  task uuid; run uuid; job uuid;
begin
  insert into ops.tenants (slug, name) values ('ds-test-alpha', 'DS Alpha') returning id into ta;
  insert into ops.tenants (slug, name) values ('ds-test-beta', 'DS Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  perform ops.record_model_price('fake', 'ds-model-1', 1.25, 2.5, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'ds price source', 'ds-suite', 0.125);
  perform ops.set_spend_limit('global', 900000000000, 'UTC', 'ds ceiling', 'ds-suite');
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'ds budget', 'ds-suite', ta);
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'ds budget', 'ds-suite', tb);

  co := pg_temp.remember('a.company', ops.create_company(ta, 'ds-clinic', 'DS Clinic', 'ds-suite'));
  d := pg_temp.remember('a.department', ops.create_department(ta, co, 'intake', 'Intake', 'ds-suite'));
  ag := pg_temp.remember('a.agent', ops.create_agent(ta, co, d, 'triage', 'DS Triage', 'Synthetic role', 'ds-suite'));
  ag2 := pg_temp.remember('a.agent2', ops.create_agent(ta, co, d, 'triage-2', 'DS Triage 2', 'Synthetic role', 'ds-suite'));
  cob := pg_temp.remember('b.company', ops.create_company(tb, 'ds-clinic-b', 'DS Clinic B', 'ds-suite'));
  db := pg_temp.remember('b.department', ops.create_department(tb, cob, 'intake', 'Intake B', 'ds-suite'));
  agb := pg_temp.remember('b.agent', ops.create_agent(tb, cob, db, 'triage', 'DS Triage B', 'Synthetic role', 'ds-suite'));

  perform pg_temp.review('accept', ta, co, ag, pg_temp.triage('triaged', 'information', 'normal', '[]'));
  for i in 1..9 loop
    perform pg_temp.review('v' || i, ta, co, ag, pg_temp.triage('triaged', 'pricing', 'normal', '[]'));
  end loop;
  perform pg_temp.review('stopped', ta, co, ag2, pg_temp.triage('triaged', 'pricing', 'normal', '[]'));
  perform pg_temp.review('odd', ta, co, ag, pg_temp.triage('triaged', 'support', 'high', '["spam"]'));
  perform pg_temp.review('b', tb, cob, agb, pg_temp.triage('triaged', 'information', 'normal', '[]'));

  -- A lead triage review of a task NO synthetic or test admission created: the
  -- stand-in for a real-origin review while BASELINE Q8 is open.
  task := ops.create_task(ta, co, 'lead_triage', 'Lead triage: real origin', 'ds-suite',
                          'SENTINEL-DS-REAL-BODY', null, null, 100, null, null, null, 'ds-real-origin');
  perform ops.assign_task(ta, task, ag, 'ds-suite');
  run := ops.request_agent_run(ta, task, ag, 'lead_triage', 'ds-real-origin', 'ds-suite');
  select r.job_id into job from ops.agent_runs r where r.id = run;
  perform pg_temp.lease(job, 'ds-worker');
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  perform ops.start_agent_run('fake', 'ds-model-1', 'lead_triage.v1', encode(sha256(convert_to(run::text, 'UTF8')), 'hex'), 8000);
  perform ops.complete_agent_run(pg_temp.triage('triaged', 'information', 'normal', '[]'), 'ds-model-1', 'completed',
                                 null, null, 120, 60, 180, 0, 0, 42);
  perform ops.complete_job(job);
  perform ops.open_review_for_settled_job('ds-worker', job);
  execute 'reset role';
  perform pg_temp.remember('review.real', (select r.id from ops.review_items r where r.agent_run_id = run));
end
$$;

-- ---------------------------------------------------------------------------
-- D1. The vector check and the policy.
-- ---------------------------------------------------------------------------

do $$
declare
  c jsonb := jsonb_build_object(
    'version', 'decision_vector.v1', 'mode', 'shadow', 'recommendation', 'accept', 'confidence', 0.82,
    'caution', 'low', 'reasonCodes', jsonb_build_array('triage_complete'),
    'provider', jsonb_build_object('kind', 'fake', 'id', 'fake-rules', 'version', '1'),
    'inputFingerprint', 'sha256:' || repeat('a', 64), 'evaluatedAt', '2026-09-24T12:00:00.000Z');
  r record;
begin
  if not ops.decision_vector_valid(c) then
    raise exception 'D1: a complete vector was refused';
  end if;
  for r in select * from (values
      ('an unknown recommendation', jsonb_build_object('recommendation', 'approve')),
      ('confidence below 0', jsonb_build_object('confidence', -0.01)),
      ('confidence above 1', jsonb_build_object('confidence', 1.01)),
      ('confidence as text', jsonb_build_object('confidence', '0.9')),
      ('a huge confidence', '{"confidence": 1e400}'::jsonb),
      ('an unknown version', jsonb_build_object('version', 'decision_vector.v2')),
      ('a mode other than shadow', jsonb_build_object('mode', 'enforce')),
      ('an unknown caution', jsonb_build_object('caution', 'extreme')),
      ('a malformed reason code', jsonb_build_object('reasonCodes', jsonb_build_array('Because I said so'))),
      ('no reason code', jsonb_build_object('reasonCodes', '[]'::jsonb)),
      ('a repeated reason code', jsonb_build_object('reasonCodes', jsonb_build_array('flag_spam', 'flag_spam'))),
      ('a malformed fingerprint', jsonb_build_object('inputFingerprint', 'sha256:xyz')),
      ('a malformed timestamp', jsonb_build_object('evaluatedAt', 'yesterday')),
      ('an unknown provider kind', jsonb_build_object('provider', jsonb_build_object('kind', 'gpt', 'id', 'x', 'version', '1'))),
      ('an extra provider key', jsonb_build_object('provider', jsonb_build_object('kind', 'fake', 'id', 'x', 'version', '1', 'url', 'x'))),
      ('prose reasoning', jsonb_build_object('reasoning', 'SENTINEL-DS-COT step by step'))
    ) as x (label, patch) loop
    if ops.decision_vector_valid(c || r.patch) then
      raise exception 'D1: a vector with % was accepted', r.label;
    end if;
    if ops.decision_shadow_policy(c || r.patch) is not null then
      raise exception 'D1: the policy classified a vector with %', r.label;
    end if;
  end loop;
  if ops.decision_vector_valid(c - 'caution') or ops.decision_vector_valid('[]'::jsonb) or ops.decision_vector_valid(null) then
    raise exception 'D1: an incomplete vector, an array or null was accepted';
  end if;
  for r in select * from (values
      ('accept', 0.82, 'low', 'recommendation_available'),
      ('accept', 1.0, 'low', 'recommendation_available'),
      ('reject', 0.99, 'medium', 'recommendation_available'),
      ('needs_edit', 0.9, 'high', 'high_caution'),
      ('accept', 0.59, 'low', 'low_confidence'),
      ('abstain', 0.9, 'high', 'abstained')
    ) as x (rec, conf, caution, expected) loop
    if ops.decision_shadow_policy(c || jsonb_build_object('recommendation', r.rec, 'confidence', r.conf, 'caution', r.caution))
       is distinct from r.expected then
      raise exception 'D1: the policy classified % % % wrongly', r.rec, r.conf, r.caution;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D2. The allowlisted input.
-- ---------------------------------------------------------------------------

create function pg_temp.input_faults(p_tenant uuid, p_review uuid) returns text
language plpgsql as $$
declare
  v jsonb := ops.decision_input_for_review(p_tenant, p_review);
begin
  if v is null then return 'no input'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v) k)
       is distinct from array['contactPolicy', 'sourceClass', 'subject', 'triage', 'version'] then
    return 'top-level keys ' || v::text;
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v -> 'triage') k)
       is distinct from array['flags', 'intent', 'needsHumanReview', 'outcome', 'priority'] then
    return 'triage keys ' || v::text;
  end if;
  if v::text ~* ('(sentinel|maria|silva|anxiety|\+55|@example|draft|summary|next|' || p_review::text || '|' || p_tenant::text || ')') then
    return 'forbidden content ' || v::text;
  end if;
  return null;
end
$$;

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  v jsonb;
  f text;
begin
  f := pg_temp.input_faults(ta, pg_temp.id('review.accept'));
  if f is not null then raise exception 'D2: %', f; end if;
  v := ops.decision_input_for_review(ta, pg_temp.id('review.accept'));
  if v is distinct from jsonb_build_object(
       'version', 'decision_input.v1', 'subject', 'lead_triage.review', 'sourceClass', 'synthetic',
       'contactPolicy', 'contactable',
       'triage', jsonb_build_object('outcome', 'triaged', 'intent', 'information', 'priority', 'normal',
                                    'flags', '[]'::jsonb, 'needsHumanReview', true)) then
    raise exception 'D2: the input is not the allowlisted projection: %', v;
  end if;
  v := ops.decision_input_for_review(ta, pg_temp.id('review.odd'));
  if v -> 'triage' is distinct from '{"outcome": "triaged", "intent": "support", "priority": "high", "flags": ["spam"], "needsHumanReview": true}'::jsonb
     or pg_temp.input_faults(ta, pg_temp.id('review.odd')) is not null then
    raise exception 'D2: the flags and enums did not arrive as stored: %', v;
  end if;
  -- Nothing across tenants, and nothing for a review outside the scope.
  if ops.decision_input_for_review(ta, pg_temp.id('review.b')) is not null
     or ops.decision_input_for_review(pg_temp.id('tenant_b'), pg_temp.id('review.accept')) is not null then
    raise exception 'D2: an input crossed tenants';
  end if;
  if ops.decision_input_for_review(ta, pg_temp.id('review.real')) is not null then
    raise exception 'D2: a review with no synthetic or test admission produced an input';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D3. The request.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  v_id uuid;
  v_again uuid;
  e ops.decision_evaluations;
  j ops.jobs;
begin
  -- BASELINE Q8: outside the synthetic and test scope, nothing is requested.
  if ops.request_shadow_decision(ta, pg_temp.id('review.real'), 'owner.request') is not null
     or exists (select 1 from ops.decision_evaluations d where d.review_item_id = pg_temp.id('review.real'))
     or exists (select 1 from ops.jobs x where x.tenant_id = ta and x.kind = 'decision.shadow_evaluate') then
    raise exception 'D3: a review outside the synthetic and test scope was requested';
  end if;
  -- Another tenant's review is not found.
  begin
    perform ops.request_shadow_decision(ta, pg_temp.id('review.b'), 'owner.request');
    raise exception 'D3: another tenant''s review was requested';
  exception when sqlstate 'OS404' then null;
  end;

  v_id := ops.request_shadow_decision(ta, pg_temp.id('review.accept'), 'review.opened');
  v_again := ops.request_shadow_decision(ta, pg_temp.id('review.accept'), 'owner.request');
  e := pg_temp.eval(pg_temp.id('review.accept'));
  select * into j from ops.jobs x where x.id = e.job_id;
  if v_id is null or v_again is distinct from v_id or e.status <> 'pending' or e.trigger_source <> 'review.opened'
     or e.agent_id <> pg_temp.id('a.agent') or e.human_review_required is not true
     or (select count(*) from ops.decision_evaluations d where d.review_item_id = pg_temp.id('review.accept')) <> 1
     or (select count(*) from ops.jobs x where x.tenant_id = ta and x.kind = 'decision.shadow_evaluate') <> 1 then
    raise exception 'D3: a request did not record exactly one pending evaluation and one job: %', to_jsonb(e);
  end if;
  if j.kind <> 'decision.shadow_evaluate' or j.status <> 'queued'
     or j.payload is distinct from jsonb_build_object('decision_evaluation_id', v_id)
     or 'decision.shadow_evaluate' = any (ops.task_executable_kinds()) then
    raise exception 'D3: the job is not one queued shadow job naming only its evaluation: %', to_jsonb(j);
  end if;
  for i in 1..9 loop
    perform ops.request_shadow_decision(ta, pg_temp.id('review.v' || i), 'owner.request');
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D4. A request under an active stop is refused and recorded, with no job.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  v_stop uuid;
  e ops.decision_evaluations;
begin
  v_stop := ops.trip_execution_stop('agent', 'ds stop', 'ds-suite', ta, pg_temp.id('a.company'), null,
                                    pg_temp.id('a.agent2'), null);
  perform ops.request_shadow_decision(ta, pg_temp.id('review.stopped'), 'owner.request');
  e := pg_temp.eval(pg_temp.id('review.stopped'));
  if e.status <> 'refused' or e.refusal_code <> 'stopped' or e.job_id is not null or e.settled_at is null then
    raise exception 'D4: a request under a stop was not refused without a job: %', to_jsonb(e);
  end if;
  perform ops.clear_execution_stop(v_stop, 'ds clear', 'ds-suite');
  -- Refused stays refused: the clear does not revive it (owner decision E).
  perform ops.request_shadow_decision(ta, pg_temp.id('review.stopped'), 'owner.request');
  if (pg_temp.eval(pg_temp.id('review.stopped'))).status <> 'refused' then
    raise exception 'D4: a refused request was revived';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D5. The lifecycle, under a lease.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  r uuid := pg_temp.id('review.accept');
  before jsonb := pg_temp.untouched(ta);
  s jsonb;
  st text;
  e ops.decision_evaluations;
  v_allowed jsonb := ops.read_review_detail(ta, r) -> 'allowedDecisions';
begin
  s := pg_temp.start(r);
  e := pg_temp.eval(r);
  if s ->> 'status' <> 'running' or (s ->> 'evaluationId')::uuid <> e.id or e.status <> 'running'
     or e.provider_kind <> 'fake' or e.started_at is null
     or s -> 'input' is distinct from ops.decision_input_for_review(ta, r)
     or e.input_fingerprint <> 'sha256:' || encode(sha256(convert_to((s -> 'input')::text, 'UTF8')), 'hex')
     or s ->> 'inputFingerprint' <> e.input_fingerprint then
    raise exception 'D5: the start did not record running with the input''s fingerprint: % %', s, to_jsonb(e);
  end if;
  st := pg_temp.settle('completed', pg_temp.vector(r));
  e := pg_temp.eval(r);
  if st <> 'completed' or e.status <> 'completed' or e.policy_outcome <> 'recommendation_available'
     or e.vector ->> 'recommendation' <> 'accept' or e.settled_at is null or not e.human_review_required then
    raise exception 'D5: a valid vector was not completed with its policy: % %', st, to_jsonb(e);
  end if;
  if pg_temp.untouched(ta) is distinct from before
     or ops.read_review_detail(ta, r) -> 'allowedDecisions' is distinct from v_allowed then
    raise exception 'D5: a shadow decision touched the review, a task, a run, an event, a send, a stop, money, a channel or the CRM';
  end if;
  -- A settled evaluation is not settled again.
  if pg_temp.settle('completed', pg_temp.vector(r, '{"recommendation": "reject"}')) <> 'not_running' then
    raise exception 'D5: a completed evaluation was settled again';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D6. At most once.
-- ---------------------------------------------------------------------------

do $$
declare
  r uuid := pg_temp.id('review.v1');
  s jsonb;
  e ops.decision_evaluations;
begin
  perform pg_temp.start(r);
  -- The worker dies after the start committed: the lease expires and the job
  -- is leased again.
  e := pg_temp.eval(r);
  update ops.jobs set status = 'queued', lease_owner = null, leased_at = null, lease_expires_at = null where id = e.job_id;
  s := pg_temp.start(r);
  e := pg_temp.eval(r);
  if s ->> 'status' <> 'indeterminate' or e.status <> 'indeterminate' or e.policy_outcome <> 'provider_indeterminate'
     or e.error_code <> 'attempt_interrupted' or e.vector is not null then
    raise exception 'D6: an interrupted attempt was not settled indeterminate: % %', s, to_jsonb(e);
  end if;
  if pg_temp.settle('completed', pg_temp.vector(r)) <> 'not_running' then
    raise exception 'D6: the interrupted attempt''s answer was stored';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D7. Every vector outcome; nothing malformed or mismatched is a recommendation.
-- ---------------------------------------------------------------------------

do $$
declare
  c record;
  e ops.decision_evaluations;
  st text;
begin
  for c in select * from (values
      ('v2', 'completed', '{"recommendation": "reject", "confidence": 0.9}'::jsonb, 'completed', 'recommendation_available'),
      ('v3', 'completed', '{"recommendation": "accept", "confidence": 1}'::jsonb, 'completed', 'recommendation_available'),
      ('v4', 'completed', '{"recommendation": "abstain", "confidence": 0.5}'::jsonb, 'completed', 'abstained'),
      ('v5', 'completed', '{"recommendation": "needs_edit", "caution": "high"}'::jsonb, 'completed', 'high_caution'),
      ('v6', 'completed', '{"confidence": 1.5}'::jsonb, 'invalid', 'provider_invalid'),
      ('v7', 'completed', '{"provider": {"kind": "jev", "id": "jev", "version": "1"}}'::jsonb, 'invalid', 'provider_invalid'),
      ('v8', 'completed', jsonb_build_object('inputFingerprint', 'sha256:' || repeat('d', 64)), 'invalid', 'provider_invalid'),
      ('v9', 'indeterminate', null, 'indeterminate', 'provider_indeterminate')
    ) as x (key, outcome, patch, status, policy) loop
    perform pg_temp.start(pg_temp.id('review.' || c.key));
    st := pg_temp.settle(c.outcome,
                         case when c.outcome = 'completed' then pg_temp.vector(pg_temp.id('review.' || c.key), c.patch) end,
                         case when c.outcome = 'completed' then null else 'provider_error' end);
    e := pg_temp.eval(pg_temp.id('review.' || c.key));
    if st <> c.status or e.status <> c.status or e.policy_outcome <> c.policy or not e.human_review_required
       or (c.status <> 'completed' and e.vector is not null) then
      raise exception 'D7: % settled % % (%), expected % %', c.key, st, e.policy_outcome, to_jsonb(e), c.status, c.policy;
    end if;
  end loop;
  -- A malformed settlement is refused outright.
  begin
    perform pg_temp.settle('approved', null);
    raise exception 'D7: an unknown settlement outcome was accepted';
  exception when sqlstate 'OS400' then execute 'reset role';
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- D8. The record's guard.
-- ---------------------------------------------------------------------------

do $$
declare
  r uuid := pg_temp.id('review.accept');
  e ops.decision_evaluations := pg_temp.eval(pg_temp.id('review.accept'));
  c record;
begin
  for c in select * from (values
      ('rewrite the recommendation', format('update ops.decision_evaluations set vector = vector || %L where id = %L', '{"recommendation": "reject"}', e.id)),
      ('reopen it', format('update ops.decision_evaluations set status = %L where id = %L', 'pending', e.id)),
      ('move it to another review', format('update ops.decision_evaluations set review_item_id = %L where id = %L', pg_temp.id('review.v2'), e.id)),
      ('make the policy authoritative', format('update ops.decision_evaluations set human_review_required = false where id = %L', e.id)),
      ('insert a completed evaluation', format('insert into ops.decision_evaluations (tenant_id, company_id, department_id, agent_id, review_item_id, subject, trigger_source, policy_version, idempotency_key, status, vector, policy_outcome) select tenant_id, company_id, department_id, agent_id, %L, subject, trigger_source, policy_version, %L, %L, vector, policy_outcome from ops.decision_evaluations where id = %L',
                                                pg_temp.id('review.odd'), 'ds-forged', 'completed', e.id))
    ) as x (label, stmt) loop
    begin
      execute c.stmt;
      raise exception 'D8: the guard let "%" through', c.label;
    exception
      when sqlstate 'OS409' or check_violation or unique_violation then null;
    end;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- D9. The stops at the start, and a job_kind stop naming the new kind.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  r uuid := pg_temp.id('review.odd');
  v_stop uuid;
  s jsonb;
  e ops.decision_evaluations;
begin
  perform ops.request_shadow_decision(ta, r, 'owner.request');
  e := pg_temp.eval(r);
  v_stop := ops.trip_execution_stop('job_kind', 'ds kind stop', 'ds-suite', ta, null, null, null, 'decision.shadow_evaluate');
  if ops.job_covering_stop(ta, e.job_id, 'decision.shadow_evaluate') is distinct from v_stop then
    raise exception 'D9: a job_kind stop naming the shadow kind does not cover its job';
  end if;
  s := pg_temp.start(r);
  if s ->> 'status' <> 'stopped' or (pg_temp.eval(r)).status <> 'pending' then
    raise exception 'D9: a start under a stop recorded something: %', s;
  end if;
  perform ops.clear_execution_stop(v_stop, 'ds clear', 'ds-suite');
  -- An agent stop covers the job through its evaluation's unit.
  v_stop := ops.trip_execution_stop('agent', 'ds agent stop', 'ds-suite', ta, pg_temp.id('a.company'), null,
                                    pg_temp.id('a.agent'), null);
  if ops.job_covering_stop(ta, e.job_id, 'decision.shadow_evaluate') is distinct from v_stop then
    raise exception 'D9: the agent''s stop does not cover its shadow decision job';
  end if;
  perform ops.clear_execution_stop(v_stop, 'ds clear', 'ds-suite');
end
$$;

-- ---------------------------------------------------------------------------
-- D10. The read projection.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  v jsonb;
begin
  v := ops.read_review_detail(ta, pg_temp.id('review.accept')) -> 'shadowDecision';
  if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from
       array['caution', 'confidence', 'mode', 'policy', 'provider', 'reasonCodes', 'recommendation', 'refusal',
             'requestedAt', 'settledAt', 'status']
     or v ->> 'status' <> 'completed' or v ->> 'recommendation' <> 'accept' or (v ->> 'confidence')::numeric <> 0.82
     or v -> 'policy' <> '{"outcome": "recommendation_available", "humanReviewRequired": true}'::jsonb
     or v -> 'provider' <> '{"kind": "fake", "id": "fake-rules", "version": "1"}'::jsonb
     or v::text ~* '(sha256|fingerprint|input|error|job|sentinel)' then
    raise exception 'D10: the completed projection is not the minimised advisory shape: %', v;
  end if;
  if ops.read_review_detail(ta, pg_temp.id('review.real')) -> 'shadowDecision' <> '{"status": "unavailable"}'::jsonb then
    raise exception 'D10: a review outside the scope does not read unavailable';
  end if;
  if ops.read_review_detail(pg_temp.id('tenant_b'), pg_temp.id('review.b')) -> 'shadowDecision' <> 'null'::jsonb then
    raise exception 'D10: a review with no request does not read null';
  end if;
  v := ops.read_review_detail(ta, pg_temp.id('review.stopped')) -> 'shadowDecision';
  if v ->> 'status' <> 'refused' or v ->> 'refusal' <> 'stopped' or v -> 'recommendation' <> 'null'::jsonb then
    raise exception 'D10: a refused request does not read refused: %', v;
  end if;
  if (ops.read_review_detail(ta, pg_temp.id('review.odd')) -> 'shadowDecision') ->> 'status' <> 'pending' then
    raise exception 'D10: a pending evaluation does not read pending';
  end if;
  -- A "reject" recommendation leaves the decisions a person may make as they were.
  if ops.read_review_detail(ta, pg_temp.id('review.v2')) -> 'allowedDecisions'
       is distinct from '["accepted", "rejected", "needs_edit"]'::jsonb then
    raise exception 'D10: a recommendation changed the decisions a person may make';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D11. Access.
-- ---------------------------------------------------------------------------

do $$
declare
  v_bad text;
begin
  select string_agg(r.rolname || ':' || p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops'
     and p.proname in ('decision_vector_valid', 'decision_shadow_policy', 'decision_input_for_review', 'request_shadow_decision',
                       'request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision',
                       'cos_review_shadow_decision')
     and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker'
              and p.proname in ('request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision'));
  if v_bad is not null then
    raise exception 'D11: a role executes a decision function it must not: %', v_bad;
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where has_table_privilege(r.rolname, 'ops.decision_evaluations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'D11: a role holds a privilege on ops.decision_evaluations: %', v_bad;
  end if;
  -- The capabilities need a live lease.
  perform set_config('app.worker_id', '', true);
  perform set_config('app.job_id', '', true);
  execute 'set local role ops_worker';
  begin
    perform ops.start_shadow_decision('fake', 'fake-rules', '1');
    raise exception 'D11: a start ran without a lease';
  exception when insufficient_privilege then null;
  end;
  begin
    perform ops.settle_shadow_decision('failed', null, 'x');
    raise exception 'D11: a settlement ran without a lease';
  exception when insufficient_privilege then null;
  end;
  begin
    perform ops.request_shadow_decision(pg_temp.id('tenant_a'), pg_temp.id('review.v2'), 'owner.request');
    raise exception 'D11: the worker requested a shadow decision directly';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  -- Browser roles reach nothing of it.
  execute 'set local role authenticated';
  begin
    perform 1 from ops.decision_evaluations;
    raise exception 'D11: authenticated read the decision table';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  -- And the browser has exactly its two acts: no decision function is exposed.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'company_os_api' and p.provolatile <> 's'
                and p.proname not in ('decide_review', 'trip_stop'))
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'company_os_api') <> 17 then
    raise exception 'D11: the browser gained a mutation';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- X. Deliberate breaks, each caught by its own check. Every break is made in a
--    savepoint and rolled back.
-- ---------------------------------------------------------------------------

-- The advisory-only check the migration asserts, as a reusable function.
create function pg_temp.advisory_faults() returns text
language sql as $$
  select string_agg(p.proname, ', ')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops'
     and p.proname in ('decision_vector_valid', 'decision_shadow_policy', 'decision_input_for_review', 'request_shadow_decision',
                       'request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision',
                       'cos_review_shadow_decision', 'guard_decision_evaluation_update', 'guard_decision_evaluation_insert')
     and p.prosrc ~* '(record_review_decision|decide_review|outbound|whatsapp_send|send_|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels\s+set|grant_membership|revoke_membership|execute\s|review_items\s+set|update\s+ops\.review_items)';
$$;

do $$
begin
  if pg_temp.advisory_faults() is not null then
    raise exception 'X0: the unbroken decision layer already reaches beyond advice: %', pg_temp.advisory_faults();
  end if;
end
$$;

-- X1. A settlement that also decides the review.
savepoint x1;
create or replace function ops.settle_shadow_decision(p_outcome text, p_vector jsonb, p_error_code text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  perform ops.record_review_decision(null, null, 'accepted', 'jev', null, null);
  return 'completed';
end $$;
do $$ begin
  if pg_temp.advisory_faults() is null then raise exception 'X1: a settlement that decides the review went unnoticed'; end if;
end $$;
rollback to savepoint x1;

-- X2. Both lines of the synthetic and test scope removed (BASELINE Q8): the
--     scope predicate, and the input builder's own source check.
create function pg_temp.q8_faults() returns text
language plpgsql as $$
begin
  if ops.request_shadow_decision(pg_temp.id('tenant_a'), pg_temp.id('review.real'), 'owner.request') is not null
     or exists (select 1 from ops.decision_evaluations d where d.review_item_id = pg_temp.id('review.real')) then
    return 'a real-origin review was requested';
  end if;
  return null;
end
$$;
do $$ begin
  if pg_temp.q8_faults() is not null then raise exception 'X2: the unbroken scope already fails: %', pg_temp.q8_faults(); end if;
end $$;
savepoint x2;
create or replace function ops.cos_review_decidable(p_tenant uuid, r ops.review_items) returns boolean
language sql stable set search_path = '' as $$ select true; $$;
create or replace function ops.decision_input_for_review(p_tenant_id uuid, p_review_item_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('version', 'decision_input.v1', 'subject', 'lead_triage.review', 'sourceClass', 'synthetic',
                            'contactPolicy', 'contactable', 'triage', '{}'::jsonb);
$$;
do $$ begin
  if pg_temp.q8_faults() is null then raise exception 'X2: a request outside the synthetic and test scope went unnoticed'; end if;
end $$;
rollback to savepoint x2;

-- X3. An input that carries the message body to the provider.
savepoint x3;
create or replace function ops.decision_input_for_review(p_tenant_id uuid, p_review_item_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('version', 'decision_input.v1', 'subject', 'lead_triage.review', 'sourceClass', 'synthetic',
                            'contactPolicy', 'contactable', 'triage', '{}'::jsonb, 'body', t.description)
    from ops.review_items r join ops.tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
   where r.tenant_id = p_tenant_id and r.id = p_review_item_id;
$$;
do $$ begin
  if pg_temp.input_faults(pg_temp.id('tenant_a'), pg_temp.id('review.accept')) is null then
    raise exception 'X3: an input carrying the message body went unnoticed';
  end if;
end $$;
rollback to savepoint x3;

-- X4. A policy that lets a confident vector stand for the person.
savepoint x4;
do $$ begin
  begin
    alter table ops.decision_evaluations drop constraint decision_evaluations_human_review_required_check;
  exception when undefined_object then
    raise exception 'X4: the human-review constant is not a named check';
  end;
  update ops.decision_evaluations set human_review_required = false where id = (pg_temp.eval(pg_temp.id('review.accept'))).id;
  raise exception 'X4: the guard let the policy become authoritative once the check was gone';
exception when sqlstate 'OS409' then null;
end $$;
rollback to savepoint x4;

-- X5. A second browser mutation.
savepoint x5;
create function company_os_api.accept_shadow_recommendation(p_review_id uuid) returns jsonb
language sql volatile security definer set search_path = '' as $$ select '{}'::jsonb $$;
do $$ begin
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'company_os_api') = 17 then
    raise exception 'X5: a new browser mutation went unnoticed';
  end if;
end $$;
rollback to savepoint x5;

rollback;
