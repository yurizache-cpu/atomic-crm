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
--   D12 (2D.2) the policy registry: immutable, one current version, a v1
--       evaluation still stored and read under v1, a request made under a
--       retired version refused at its start, never evaluated under it;
--   D13 (2D.2) the closed reason vocabulary: a v2 vector with a code outside
--       it is never valid, never settled completed, never storable;
--   D14 (2D.2) recovery: every outcome, a started evaluation never asked
--       again, a settled one never rewritten, the scope and the stops
--       honoured, idempotent, and nothing decided, sent or written;
--   D15 (2D.3) calibration: aggregate counts only, agreement never accuracy,
--       per policy and provider version, and nothing across tenants;
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

-- The evaluation of a review under the current policy (else its latest), and its job.
create function pg_temp.eval(p_review uuid) returns ops.decision_evaluations
language sql as $$
  select e.* from ops.decision_evaluations e where e.review_item_id = p_review
   order by (e.policy_version = ops.current_shadow_policy_version()) desc, e.requested_at desc limit 1;
$$;

-- Start a requested evaluation as the worker, returning what the start answered.
create function pg_temp.start(p_review uuid, p_kind text default 'fake', p_id text default 'fake-rules',
                              p_version text default '2')
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
    'version', 'decision_vector.v2', 'mode', 'shadow', 'recommendation', 'accept', 'confidence', 0.82,
    'caution', 'low', 'reasonCodes', jsonb_build_array('triage_complete', 'intent_information'),
    'provider', jsonb_build_object('kind', 'fake', 'id', 'fake-rules', 'version', '2'),
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
    'version', 'decision_vector.v2', 'mode', 'shadow', 'recommendation', 'accept', 'confidence', 0.82,
    'caution', 'low', 'reasonCodes', jsonb_build_array('triage_complete'),
    'provider', jsonb_build_object('kind', 'fake', 'id', 'fake-rules', 'version', '2'),
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
      ('an unknown version', jsonb_build_object('version', 'decision_vector.v3')),
      ('a null version', '{"version": null}'::jsonb),
      ('a null provider kind', '{"provider": {"kind": null, "id": "fake-rules", "version": "2"}}'::jsonb),
      ('a code outside the vocabulary', jsonb_build_object('reasonCodes', jsonb_build_array('maria_silva_anxiety'))),
      ('a known and an unknown code', jsonb_build_object('reasonCodes', jsonb_build_array('flag_spam', 'legacy_reason'))),
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
    if ops.decision_policy_outcome('decision_shadow.v2', c || r.patch) is not null then
      raise exception 'D1: the policy classified a vector with %', r.label;
    end if;
  end loop;
  -- A version's policy classifies only its own vector version; an unknown
  -- policy classifies nothing; the 2D.1 function keeps its v1 meaning.
  if ops.decision_policy_outcome('decision_shadow.v1', c) is not null
     or ops.decision_policy_outcome('decision_shadow.v3', c) is not null
     or ops.decision_policy_outcome(null, c) is not null
     or ops.decision_shadow_policy(c) is not null
     or ops.decision_policy_outcome('decision_shadow.v2', c || '{"version": "decision_vector.v1"}') is not null then
    raise exception 'D1: a policy classified a vector of another version';
  end if;
  -- History: a v1 vector's pattern-checked codes stay valid as stored.
  if not ops.decision_vector_valid(c || '{"version": "decision_vector.v1", "reasonCodes": ["legacy_reason"]}') then
    raise exception 'D1: a stored v1 vector is no longer valid history';
  end if;
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
    if ops.decision_policy_outcome('decision_shadow.v2',
                                   c || jsonb_build_object('recommendation', r.rec, 'confidence', r.conf, 'caution', r.caution))
       is distinct from r.expected then
      raise exception 'D1: the policy classified % % % wrongly', r.rec, r.conf, r.caution;
    end if;
    -- v1 classifies a v1 vector exactly as it did in 2D.1.
    if ops.decision_shadow_policy(c || jsonb_build_object('version', 'decision_vector.v1', 'recommendation', r.rec,
                                                          'confidence', r.conf, 'caution', r.caution))
       is distinct from r.expected then
      raise exception 'D1: the v1 policy no longer classifies % % % as it did', r.rec, r.conf, r.caution;
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
     or e.policy_version <> 'decision_shadow.v2'
     or e.idempotency_key <> 'review:' || pg_temp.id('review.accept') || ':decision_shadow.v2'
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
     or s ->> 'inputFingerprint' <> e.input_fingerprint
     or s ->> 'policyVersion' <> 'decision_shadow.v2' or s ->> 'vectorVersion' <> 'decision_vector.v2' then
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
       array['caution', 'confidence', 'mode', 'policy', 'policyVersion', 'provider', 'reasonCodes', 'recommendation',
             'refusal', 'requestedAt', 'settledAt', 'status']
     or v ->> 'status' <> 'completed' or v ->> 'recommendation' <> 'accept' or (v ->> 'confidence')::numeric <> 0.82
     or v ->> 'policyVersion' <> 'decision_shadow.v2'
     or v -> 'policy' <> '{"outcome": "recommendation_available", "humanReviewRequired": true}'::jsonb
     or v -> 'provider' <> '{"kind": "fake", "id": "fake-rules", "version": "2"}'::jsonb
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
                       'cos_review_shadow_decision', 'lead_triage_reason_codes_v1', 'decision_policy_vector_version',
                       'decision_policy_outcome', 'current_shadow_policy_version', 'recover_shadow_decision',
                       'cos_decision_intelligence', 'guard_decision_policy_change', 'refuse_decision_policy_truncate')
     and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
     and not (r.rolname = 'ops_worker'
              and p.proname in ('request_shadow_decision_for_settled_job', 'start_shadow_decision', 'settle_shadow_decision'));
  if v_bad is not null then
    raise exception 'D11: a role executes a decision function it must not: %', v_bad;
  end if;
  select string_agg(r.rolname, ', ') into v_bad
    from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where has_table_privilege(r.rolname, 'ops.decision_evaluations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege(r.rolname, 'ops.decision_policies', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'D11: a role holds a privilege on the decision tables: %', v_bad;
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
-- D12. The policy registry, and history under a retired version.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  co uuid := pg_temp.id('a.company');
  ag uuid := pg_temp.id('a.agent');
  h1 uuid;
  h2 uuid;
  v1 jsonb;
  e_id uuid;
  before jsonb;
  s jsonb;
  e ops.decision_evaluations;
  c record;
begin
  -- v1 recorded and retired; v2 the one current version.
  if (select jsonb_agg(jsonb_build_array(p.version, p.vector_version, p.reason_vocabulary, p.retired_at is null)
                       order by p.version) from ops.decision_policies p)
     is distinct from '[["decision_shadow.v1", "decision_vector.v1", null, false],
                        ["decision_shadow.v2", "decision_vector.v2", "lead_triage_reasons.v1", true]]'::jsonb
     or ops.current_shadow_policy_version() is distinct from 'decision_shadow.v2' then
    raise exception 'D12: the registry is not v1 retired and v2 current';
  end if;
  -- Immutable: never edited, deleted, truncated, revived or retired twice; one
  -- current version; no version without an executable meaning.
  perform set_config('client_min_messages', 'warning', true);
  for c in select * from (values
      ('edit a description', 'update ops.decision_policies set description = ''x'' where version = ''decision_shadow.v2'''),
      ('change a vector version', 'update ops.decision_policies set vector_version = ''decision_vector.v1'' where version = ''decision_shadow.v2'''),
      ('revive v1', 'update ops.decision_policies set retired_at = null where version = ''decision_shadow.v1'''),
      ('retire v1 again', 'update ops.decision_policies set retired_at = now() - interval ''1 day'' where version = ''decision_shadow.v1'''),
      ('delete v1', 'delete from ops.decision_policies where version = ''decision_shadow.v1'''),
      ('truncate the registry', 'truncate ops.decision_policies cascade'),
      ('add a second current version', 'insert into ops.decision_policies (version, vector_version, description) values (''decision_shadow.v9'', ''decision_vector.v2'', ''x'')'),
      ('register a version with no executable meaning', 'insert into ops.decision_policies (version, vector_version, description, retired_at) values (''decision_shadow.v9'', ''decision_vector.v2'', ''x'', now())')
    ) as x (label, stmt) loop
    begin
      execute c.stmt;
      raise exception 'D12: the registry let "%" through', c.label;
    exception
      when sqlstate 'OS409' or unique_violation or check_violation then null;
    end;
  end loop;

  -- History: an evaluation made under v1 stays stored and read under v1, and a
  -- v2 request is a new evaluation beside it (idempotency per version).
  h1 := pg_temp.review('h1', ta, co, ag, pg_temp.triage('triaged', 'information', 'normal', '[]'));
  insert into ops.decision_evaluations (tenant_id, company_id, department_id, agent_id, review_item_id, subject,
                                        trigger_source, policy_version, idempotency_key, status)
  select r.tenant_id, r.company_id, pg_temp.id('a.department'), ag, r.id, 'lead_triage.review', 'review.opened',
         'decision_shadow.v1', 'review:' || r.id || ':decision_shadow.v1', 'pending'
    from ops.review_items r where r.id = h1
  returning id into e_id;
  update ops.decision_evaluations
     set status = 'running', started_at = now(), provider_kind = 'fake', provider_id = 'fake-rules',
         provider_version = '1', input_fingerprint = 'sha256:' || repeat('b', 64)
   where id = e_id;
  v1 := jsonb_build_object(
    'version', 'decision_vector.v1', 'mode', 'shadow', 'recommendation', 'reject', 'confidence', 0.7,
    'caution', 'medium', 'reasonCodes', jsonb_build_array('legacy_reason'),
    'provider', jsonb_build_object('kind', 'fake', 'id', 'fake-rules', 'version', '1'),
    'inputFingerprint', 'sha256:' || repeat('b', 64), 'evaluatedAt', '2026-09-24T12:00:00.000Z');
  begin
    update ops.decision_evaluations
       set status = 'completed', vector = v1 || '{"version": "decision_vector.v2", "reasonCodes": ["flag_spam"]}',
           policy_outcome = 'recommendation_available', settled_at = now()
     where id = e_id;
    raise exception 'D12: a v2 vector was stored under v1';
  exception when check_violation then null;
  end;
  update ops.decision_evaluations
     set status = 'completed', vector = v1, policy_outcome = ops.decision_policy_outcome('decision_shadow.v1', v1),
         settled_at = now()
   where id = e_id;
  before := to_jsonb((select x from ops.decision_evaluations x where x.id = e_id));
  if (pg_temp.eval(h1)).policy_outcome <> 'recommendation_available'
     or ops.read_review_detail(ta, h1) #>> '{shadowDecision,policyVersion}' <> 'decision_shadow.v1'
     or ops.read_review_detail(ta, h1) #>> '{shadowDecision,recommendation}' <> 'reject' then
    raise exception 'D12: a v1 evaluation is not stored and read under v1: %', ops.read_review_detail(ta, h1) -> 'shadowDecision';
  end if;
  perform ops.request_shadow_decision(ta, h1, 'owner.request');
  if (select count(*) from ops.decision_evaluations x where x.review_item_id = h1) <> 2
     or to_jsonb((select x from ops.decision_evaluations x where x.id = e_id)) is distinct from before
     or (pg_temp.eval(h1)).policy_version <> 'decision_shadow.v2'
     or ops.read_review_detail(ta, h1) #>> '{shadowDecision,policyVersion}' <> 'decision_shadow.v2'
     or ops.read_review_detail(ta, h1) #>> '{shadowDecision,status}' <> 'pending' then
    raise exception 'D12: a v2 request did not become a new evaluation beside the v1 history';
  end if;

  -- A request made under a version since retired is refused at its start,
  -- never evaluated under it.
  h2 := pg_temp.review('h2', ta, co, ag, pg_temp.triage('triaged', 'information', 'normal', '[]'));
  insert into ops.decision_evaluations (tenant_id, company_id, department_id, agent_id, review_item_id, subject,
                                        trigger_source, policy_version, idempotency_key, status)
  select r.tenant_id, r.company_id, pg_temp.id('a.department'), ag, r.id, 'lead_triage.review', 'review.opened',
         'decision_shadow.v1', 'review:' || r.id || ':decision_shadow.v1', 'pending'
    from ops.review_items r where r.id = h2
  returning id into e_id;
  update ops.decision_evaluations
     set job_id = ops.enqueue_job(ta, 'decision.shadow_evaluate', jsonb_build_object('decision_evaluation_id', e_id),
                                  100, now(), 3, 'decision:' || e_id)
   where id = e_id;
  s := pg_temp.start(h2);
  e := pg_temp.eval(h2);
  if s ->> 'status' <> 'refused' or e.status <> 'refused' or e.refusal_code <> 'policy_retired'
     or e.started_at is not null or e.provider_kind is not null or e.input_fingerprint is not null then
    raise exception 'D12: a request under a retired version was evaluated: % %', s, to_jsonb(e);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D13. The closed reason vocabulary.
-- ---------------------------------------------------------------------------

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  co uuid := pg_temp.id('a.company');
  ag uuid := pg_temp.id('a.agent');
  q uuid;
  code text;
  st text;
  e ops.decision_evaluations;
  c record;
begin
  if ops.lead_triage_reason_codes_v1() is distinct from array[
       'triage_complete', 'intent_book_appointment', 'intent_pricing', 'intent_information',
       'flag_possible_crisis', 'flag_minor', 'flag_spam', 'contact_do_not_contact',
       'outcome_out_of_scope', 'outcome_needs_input', 'insufficient_signal'] then
    raise exception 'D13: lead_triage_reasons.v1 changed; a new code is a new vocabulary version';
  end if;
  foreach code in array ops.lead_triage_reason_codes_v1() loop
    if not ops.decision_vector_valid(pg_temp.vector(pg_temp.id('review.accept'),
                                                    jsonb_build_object('reasonCodes', jsonb_build_array(code)))) then
      raise exception 'D13: the vocabulary code % was refused', code;
    end if;
  end loop;

  -- A provider's answer outside the vocabulary, or of the retired vector
  -- version, is settled invalid: never stored, never a recommendation.
  for c in select * from (values
      ('q1', '{"reasonCodes": ["maria_silva_anxiety"]}'::jsonb),
      ('q2', '{"reasonCodes": ["triage_complete", "because_the_patient_said_so"]}'::jsonb),
      ('q3', '{"version": "decision_vector.v1"}'::jsonb)
    ) as x (key, patch) loop
    q := pg_temp.review(c.key, ta, co, ag, pg_temp.triage('triaged', 'pricing', 'normal', '[]'));
    perform ops.request_shadow_decision(ta, q, 'owner.request');
    perform pg_temp.start(q);
    st := pg_temp.settle('completed', pg_temp.vector(q, c.patch));
    e := pg_temp.eval(q);
    if st <> 'invalid' or e.status <> 'invalid' or e.policy_outcome <> 'provider_invalid' or e.vector is not null then
      raise exception 'D13: % was not settled invalid: % %', c.key, st, to_jsonb(e);
    end if;
  end loop;

  -- Nor can a direct write store one: the table refuses it.
  q := pg_temp.review('q4', ta, co, ag, pg_temp.triage('triaged', 'pricing', 'normal', '[]'));
  perform ops.request_shadow_decision(ta, q, 'owner.request');
  perform pg_temp.start(q);
  e := pg_temp.eval(q);
  for c in select * from (values
      ('a code outside the vocabulary', '{"reasonCodes": ["maria_silva_anxiety"]}'::jsonb),
      ('the retired vector version', '{"version": "decision_vector.v1"}'::jsonb)
    ) as x (label, patch) loop
    begin
      update ops.decision_evaluations
         set status = 'completed', vector = pg_temp.vector(q, c.patch), policy_outcome = 'recommendation_available',
             settled_at = now()
       where id = e.id;
      raise exception 'D13: the table stored a vector with %', c.label;
    exception when check_violation then null;
    end;
  end loop;
  st := pg_temp.settle('completed', pg_temp.vector(q, '{"recommendation": "reject", "reasonCodes": ["flag_spam", "intent_pricing"]}'));
  if st <> 'completed' or (pg_temp.eval(q)).vector -> 'reasonCodes' <> '["flag_spam", "intent_pricing"]'::jsonb then
    raise exception 'D13: a vector from the vocabulary was not settled completed';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D14. Recovery.
-- ---------------------------------------------------------------------------

create function pg_temp.recover(p_review uuid, p_tenant uuid default null) returns text
language sql as $$
  select ops.recover_shadow_decision(coalesce(p_tenant, pg_temp.id('tenant_a')), p_review) ->> 'outcome';
$$;

-- Every shadow job ever enqueued for a review's evaluations.
create function pg_temp.shadow_jobs(p_review uuid) returns bigint
language sql as $$
  select count(*) from ops.jobs j
   where j.kind = 'decision.shadow_evaluate'
     and j.payload ->> 'decision_evaluation_id' in
         (select d.id::text from ops.decision_evaluations d where d.review_item_id = p_review);
$$;

do $$
declare
  ta uuid := pg_temp.id('tenant_a');
  co uuid := pg_temp.id('a.company');
  ag uuid := pg_temp.id('a.agent');
  ag2 uuid := pg_temp.id('a.agent2');
  r_new uuid;
  r_pend uuid;
  r_stop uuid;
  before jsonb;
  snap jsonb;
  e ops.decision_evaluations;
  v_stop uuid;
  c record;
begin
  r_new := pg_temp.review('r_new', ta, co, ag, pg_temp.triage('triaged', 'information', 'normal', '[]'));
  r_pend := pg_temp.review('r_pend', ta, co, ag, pg_temp.triage('triaged', 'information', 'normal', '[]'));
  r_stop := pg_temp.review('r_stop', ta, co, ag2, pg_temp.triage('triaged', 'information', 'normal', '[]'));
  perform ops.request_shadow_decision(ta, r_pend, 'review.opened');
  before := pg_temp.untouched(ta) - 'stops';

  -- Outside the scope (BASELINE Q8): nothing. Another tenant's review: not found.
  if pg_temp.recover(pg_temp.id('review.real')) <> 'not_eligible'
     or exists (select 1 from ops.decision_evaluations d where d.review_item_id = pg_temp.id('review.real')) then
    raise exception 'D14: a review outside the synthetic and test scope was recovered';
  end if;
  begin
    perform pg_temp.recover(pg_temp.id('review.b'));
    raise exception 'D14: another tenant''s review was recovered';
  exception when sqlstate 'OS404' then null;
  end;

  -- created: nothing under the current version; then in progress, and again.
  if pg_temp.recover(r_new) <> 'created' then
    raise exception 'D14: a missing request was not created';
  end if;
  e := pg_temp.eval(r_new);
  if e.status <> 'pending' or e.trigger_source <> 'operator.recover' or e.policy_version <> 'decision_shadow.v2'
     or pg_temp.shadow_jobs(r_new) <> 1 or pg_temp.recover(r_new) <> 'in_progress'
     or pg_temp.recover(r_new) <> 'in_progress' or pg_temp.shadow_jobs(r_new) <> 1
     or (select count(*) from ops.decision_evaluations d where d.review_item_id = r_new) <> 1 then
    raise exception 'D14: a created request is not one pending evaluation with one job, in progress: %', to_jsonb(e);
  end if;

  -- repaired: its job ended without ever starting it. One new job, once.
  update ops.jobs set status = 'failed', last_error_class = 'permanent', updated_at = now() where id = e.job_id;
  if pg_temp.recover(r_new) <> 'repaired' or pg_temp.recover(r_new) <> 'in_progress' or pg_temp.shadow_jobs(r_new) <> 2
     or (pg_temp.eval(r_new)).job_id = e.job_id or (pg_temp.eval(r_new)).status <> 'pending'
     or (select j.status from ops.jobs j where j.id = (pg_temp.eval(r_new)).job_id) <> 'queued'
     or (select j.idempotency_key from ops.jobs j where j.id = (pg_temp.eval(r_new)).job_id) <> 'decision:' || e.id || ':1' then
    raise exception 'D14: a request whose job ended unstarted was not repaired once';
  end if;

  -- A start under a live lease is in progress. Once the lease is gone it may
  -- have reached the provider: reported for a person, never asked again.
  perform pg_temp.start(r_new);
  e := pg_temp.eval(r_new);
  if e.status <> 'running' or pg_temp.recover(r_new) <> 'in_progress' then
    raise exception 'D14: a live start was not in progress';
  end if;
  update ops.jobs set lease_expires_at = now() - interval '1 second' where id = e.job_id;
  snap := to_jsonb(pg_temp.eval(r_new));
  if pg_temp.recover(r_new) <> 'indeterminate_requires_human_operator'
     or to_jsonb(pg_temp.eval(r_new)) is distinct from snap or pg_temp.shadow_jobs(r_new) <> 2 then
    raise exception 'D14: a started evaluation was recovered';
  end if;

  -- Indeterminate, completed, invalid and refused: never asked again, never rewritten.
  for c in select * from (values
      ('review.v1', 'indeterminate_requires_human_operator'),
      ('review.v9', 'indeterminate_requires_human_operator'),
      ('review.accept', 'already_complete'),
      ('review.v6', 'already_complete'),
      ('review.stopped', 'already_complete')
    ) as x (key, outcome) loop
    snap := jsonb_build_object('eval', to_jsonb(pg_temp.eval(pg_temp.id(c.key))), 'jobs', pg_temp.shadow_jobs(pg_temp.id(c.key)));
    if pg_temp.recover(pg_temp.id(c.key)) is distinct from c.outcome
       or jsonb_build_object('eval', to_jsonb(pg_temp.eval(pg_temp.id(c.key))), 'jobs', pg_temp.shadow_jobs(pg_temp.id(c.key)))
          is distinct from snap then
      raise exception 'D14: % was not reported % and left untouched', c.key, c.outcome;
    end if;
  end loop;

  -- Under a stop a repair does nothing and records nothing, for a missing
  -- request and a pending one alike; after the clear it does its work.
  v_stop := ops.trip_execution_stop('agent', 'ds recover stop', 'ds-suite', ta, co, null, ag2, null);
  if pg_temp.recover(r_stop) <> 'stopped'
     or exists (select 1 from ops.decision_evaluations d where d.review_item_id = r_stop)
     or pg_temp.shadow_jobs(r_stop) <> 0 then
    raise exception 'D14: a recovery under a stop created, recorded or enqueued something';
  end if;
  perform ops.clear_execution_stop(v_stop, 'ds clear', 'ds-suite');
  if pg_temp.recover(r_stop) <> 'created' or pg_temp.shadow_jobs(r_stop) <> 1 then
    raise exception 'D14: a recovery after the clear did not create the request';
  end if;
  e := pg_temp.eval(r_pend);
  update ops.jobs set status = 'failed', last_error_class = 'permanent', updated_at = now() where id = e.job_id;
  v_stop := ops.trip_execution_stop('tenant', 'ds recover stop', 'ds-suite', ta, null, null, null, null);
  snap := to_jsonb(pg_temp.eval(r_pend));
  if pg_temp.recover(r_pend) <> 'stopped' or to_jsonb(pg_temp.eval(r_pend)) is distinct from snap
     or pg_temp.shadow_jobs(r_pend) <> 1 then
    raise exception 'D14: a pending request was changed under a stop';
  end if;
  perform ops.clear_execution_stop(v_stop, 'ds clear', 'ds-suite');
  if pg_temp.recover(r_pend) <> 'repaired' or pg_temp.shadow_jobs(r_pend) <> 2 then
    raise exception 'D14: a pending request was not repaired after the clear';
  end if;

  -- Recovery decided nothing, sent nothing and wrote no CRM row.
  if pg_temp.untouched(ta) - 'stops' is distinct from before then
    raise exception 'D14: a recovery touched the review, a task, a run, an event, a send, money, a channel or the CRM';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- D15. Calibration: aggregate counts, agreement never accuracy.
-- ---------------------------------------------------------------------------

do $$
declare
  tc uuid;
  co uuid;
  d uuid;
  ag uuid;
  q uuid;
  c record;
  v jsonb;
begin
  insert into ops.tenants (slug, name) values ('ds-test-gamma', 'DS Gamma') returning id into tc;
  perform pg_temp.remember('tenant_c', tc);
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'ds budget', 'ds-suite', tc);
  co := ops.create_company(tc, 'ds-clinic-c', 'DS Clinic C', 'ds-suite');
  d := ops.create_department(tc, co, 'intake', 'Intake C', 'ds-suite');
  ag := ops.create_agent(tc, co, d, 'triage', 'DS Triage C', 'Synthetic role', 'ds-suite');
  if ops.cos_decision_intelligence(tc) is distinct from
       '{"mode": "shadow", "currentPolicyVersion": "decision_shadow.v2", "groups": []}'::jsonb then
    raise exception 'D15: a tenant with no evaluation does not read empty: %', ops.cos_decision_intelligence(tc);
  end if;

  for c in select * from (values
      ('c1', 'completed', '{"recommendation": "accept"}'::jsonb, 'accepted'),
      ('c2', 'completed', '{"recommendation": "accept"}'::jsonb, 'needs_edit'),
      ('c3', 'completed', '{"recommendation": "reject"}'::jsonb, 'rejected'),
      ('c4', 'completed', '{"recommendation": "abstain"}'::jsonb, 'accepted'),
      ('c5', 'completed', '{"recommendation": "needs_edit"}'::jsonb, null),
      ('c6', 'indeterminate', null, null),
      ('c7', 'completed', '{"confidence": 7}'::jsonb, null),
      ('c8', null, null, null)
    ) as x (key, outcome, patch, human) loop
    q := pg_temp.review(c.key, tc, co, ag, pg_temp.triage('triaged', 'information', 'normal', '[]'));
    perform ops.request_shadow_decision(tc, q, 'review.opened');
    if c.outcome is not null then
      perform pg_temp.start(q);
      perform pg_temp.settle(c.outcome, case when c.outcome = 'completed' then pg_temp.vector(q, c.patch) end,
                             case when c.outcome = 'completed' then null else 'provider_error' end);
    end if;
    if c.human is not null then
      perform ops.record_review_decision(tc, q, c.human, 'ds-person', 'ds-suite', null);
    end if;
  end loop;

  -- Agreement is counted only where there is a recommendation AND a human
  -- decision; an abstention, an unsettled or failed evaluation, or an
  -- undecided review is shown, never counted as agreement or disagreement.
  v := ops.cos_decision_intelligence(tc);
  if v is distinct from '{"mode": "shadow", "currentPolicyVersion": "decision_shadow.v2", "groups": [
      {"policyVersion": "decision_shadow.v2", "provider": {"kind": "fake", "id": "fake-rules", "version": "2"},
       "evaluations": 7, "recommendations": 4, "abstained": 1, "pending": 0, "indeterminate": 1, "invalid": 1,
       "failed": 0, "refused": 0, "withHumanDecision": 4, "comparable": 3, "agreements": 2, "disagreements": 1,
       "byRecommendation": {"accept": 2, "needs_edit": 1, "reject": 1, "abstain": 1},
       "byHumanOutcome": {"pending": 3, "accepted": 2, "rejected": 1, "needs_edit": 1}},
      {"policyVersion": "decision_shadow.v2", "provider": null,
       "evaluations": 1, "recommendations": 0, "abstained": 0, "pending": 1, "indeterminate": 0, "invalid": 0,
       "failed": 0, "refused": 0, "withHumanDecision": 0, "comparable": 0, "agreements": 0, "disagreements": 0,
       "byRecommendation": {"accept": 0, "needs_edit": 0, "reject": 0, "abstain": 0},
       "byHumanOutcome": {"pending": 1, "accepted": 0, "rejected": 0, "needs_edit": 0}}]}'::jsonb then
    raise exception 'D15: the calibration counts are not the expected aggregate: %', v;
  end if;
  if ops.read_overview(tc) -> 'decisionIntelligence' is distinct from v then
    raise exception 'D15: the overview does not carry the calibration section';
  end if;
  -- Counts only: no id, name, text, input or time, and never "accuracy".
  if v::text ~* '[0-9a-f]{8}-[0-9a-f]{4}-'
     or v::text ~* '(sentinel|maria|sha256|fingerprint|@|\+55|accura|precision|score|correct|truth)'
     or v::text ~ '\d{4}-\d{2}-\d{2}' then
    raise exception 'D15: the calibration section carries more than counts: %', v;
  end if;
  -- Each tenant's counts are its own.
  if ops.cos_decision_intelligence(pg_temp.id('tenant_b')) -> 'groups' <> '[]'::jsonb
     or (select sum((g ->> 'evaluations')::int)
           from jsonb_array_elements(ops.cos_decision_intelligence(pg_temp.id('tenant_a')) -> 'groups') g)
        <> (select count(*) from ops.decision_evaluations x where x.tenant_id = pg_temp.id('tenant_a')) then
    raise exception 'D15: calibration crossed tenants';
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
                       'cos_review_shadow_decision', 'guard_decision_evaluation_update', 'guard_decision_evaluation_insert',
                       'lead_triage_reason_codes_v1', 'decision_policy_vector_version', 'decision_policy_outcome',
                       'current_shadow_policy_version', 'recover_shadow_decision', 'cos_decision_intelligence',
                       'guard_decision_policy_change', 'refuse_decision_policy_truncate')
     and p.prosrc ~*'(record_review_decision|decide_review|outbound|whatsapp_send|send_|public\.|trip_execution_stop|clear_execution_stop|spend_limit|model_price|communication_channels\s+set|grant_membership|revoke_membership|execute\s|review_items\s+set|update\s+ops\.review_items)';
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

-- X6. A vocabulary that lets a free-form code through.
create function pg_temp.vocab_faults() returns text
language plpgsql as $$
begin
  if ops.decision_vector_valid(pg_temp.vector(pg_temp.id('review.accept'), '{"reasonCodes": ["maria_silva_anxiety"]}')) then
    return 'a code outside the vocabulary is valid';
  end if;
  return null;
end
$$;
do $$ begin
  if pg_temp.vocab_faults() is not null then raise exception 'X6: the unbroken vocabulary already fails: %', pg_temp.vocab_faults(); end if;
end $$;
savepoint x6;
create or replace function ops.lead_triage_reason_codes_v1() returns text[]
language sql immutable set search_path = '' as $$
  select array['triage_complete', 'intent_book_appointment', 'intent_pricing', 'intent_information',
               'flag_possible_crisis', 'flag_minor', 'flag_spam', 'contact_do_not_contact',
               'outcome_out_of_scope', 'outcome_needs_input', 'insufficient_signal', 'maria_silva_anxiety'];
$$;
do $$ begin
  if pg_temp.vocab_faults() is null then raise exception 'X6: a vocabulary admitting a free-form code went unnoticed'; end if;
end $$;
rollback to savepoint x6;

-- X7. A recovery that asks the provider again about a started evaluation.
create function pg_temp.recovery_faults() returns text
language plpgsql as $$
declare
  r uuid := pg_temp.id('review.v1');
  snap jsonb := jsonb_build_object('eval', to_jsonb(pg_temp.eval(r)), 'jobs', pg_temp.shadow_jobs(r));
begin
  if pg_temp.recover(r) is distinct from 'indeterminate_requires_human_operator'
     or jsonb_build_object('eval', to_jsonb(pg_temp.eval(r)), 'jobs', pg_temp.shadow_jobs(r)) is distinct from snap then
    return 'a started evaluation was recovered';
  end if;
  return null;
end
$$;
do $$ begin
  if pg_temp.recovery_faults() is not null then raise exception 'X7: the unbroken recovery already fails: %', pg_temp.recovery_faults(); end if;
end $$;
savepoint x7;
create or replace function ops.recover_shadow_decision(p_tenant_id uuid, p_review_item_id uuid) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  v_eval ops.decision_evaluations;
begin
  select * into v_eval from ops.decision_evaluations e
   where e.tenant_id = p_tenant_id and e.review_item_id = p_review_item_id
   order by e.requested_at desc limit 1;
  perform ops.enqueue_job(p_tenant_id, 'decision.shadow_evaluate', jsonb_build_object('decision_evaluation_id', v_eval.id),
                          100, now(), 3, 'decision:' || v_eval.id || ':replay');
  return jsonb_build_object('outcome', 'repaired', 'evaluationId', v_eval.id);
end $$;
do $$ begin
  if pg_temp.recovery_faults() is null then raise exception 'X7: a recovery re-asking a started evaluation went unnoticed'; end if;
end $$;
rollback to savepoint x7;

rollback;
