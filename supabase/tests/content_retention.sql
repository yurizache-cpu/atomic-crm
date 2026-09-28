-- BASELINE Q8, owner decisions D6 and D7 (ADR 0020 §H), attacked in SQL.
--
-- The question: does protected AI working content leave the database's rows
-- when its retention ends or the owner erases it, while every content-free
-- fact that proves the flow stays, and can anything but the recorded
-- redaction, or anyone but the owner and the worker's bound job, do it?
--
--   A  the clock: a decided review of a health task anchors it at the
--      database's reviewed_at; 30 days on the in-process provider with no
--      authorization; the relied-on authorization's own days when one applied;
--      no clock for synthetic or test; one internal job at the due instant;
--   B  before the deadline nothing is redacted, by the job or the sweep;
--   C  at the deadline the job redacts the task, run and review content and
--      every unkeyed content fingerprint, and the audit facts stay;
--   D  a repeat, by the job, the sweep or an erasure, changes nothing;
--   E  the owner's erasure redacts at once, deletes nothing, refuses a flow in
--      progress and anything that is not protected content;
--   F  one tenant cannot erase another's content;
--   G  the guards admit a recorded redaction and nothing else: no marker
--      without the ledger, no content written back, no marker cleared, no
--      ledger rewritten, no run requested about a redacted task;
--   H  only the owner (and the worker, through its one lease-bound capability)
--      can redact; no role reads the ledger;
--   I  a redacted review's send is blocked, never attempted;
--   J  a later decided review moves the clock forward; the earlier job is
--      superseded.
--
-- ONE TRANSACTION, ROLLED BACK. Synthetic data and fake evidence references only.

\set ON_ERROR_STOP on

begin;

set local lock_timeout = '20s';

do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

create temporary table cr_ids (name text primary key, id uuid not null) on commit drop;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into cr_ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id;
$$;

create function pg_temp.id(p_name text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  select id into v from cr_ids where name = p_name;
  if v is null then raise exception 'setup: no id named %', p_name; end if;
  return v;
end
$$;

create function pg_temp.attempt(p_sql text) returns text
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return sqlstate;
  end;
  return null;
end
$$;

create function pg_temp.expect(p_label text, p_state text, p_sql text) returns void
language plpgsql as $$
declare v text := pg_temp.attempt(p_sql);
begin
  if v is distinct from p_state then
    raise exception '%: expected SQLSTATE %, got %', p_label, coalesce(p_state, 'success'), coalesce(v, 'success');
  end if;
end
$$;

-- An assigned lead_triage task of the given class.
create function pg_temp.task(p_key text, p_class text, p_tenant text default 'a') returns uuid
language plpgsql as $f$
declare v uuid;
begin
  v := ops.create_task(pg_temp.id(p_tenant || '.tenant'), pg_temp.id(p_tenant || '.company'), 'lead_triage',
                       'Lead triage', 'cr-suite', 'SENTINEL-CR-BODY-' || p_key || ' synthetic text',
                       p_data_class => p_class);
  perform ops.assign_task(pg_temp.id(p_tenant || '.tenant'), v, pg_temp.id(p_tenant || '.agent'), 'cr-suite');
  return pg_temp.remember('task.' || p_key, v);
end
$f$;

create function pg_temp.run(p_key text) returns ops.agent_runs
language sql as $$ select r.* from ops.agent_runs r where r.id = pg_temp.id('run.' || p_key); $$;

create function pg_temp.task_row(p_key text) returns ops.tasks
language sql as $$ select t.* from ops.tasks t where t.id = pg_temp.id('task.' || p_key); $$;

create function pg_temp.review(p_key text) returns ops.review_items
language sql as $$ select v.* from ops.review_items v where v.id = pg_temp.id('review.' || p_key); $$;

create function pg_temp.ledger(p_key text) returns ops.content_retention
language sql as $$ select r.* from ops.content_retention r where r.task_id = pg_temp.id('task.' || p_key); $$;

-- Lease a queued job as the worker and install its context.
create function pg_temp.lease(p_job uuid) returns void
language plpgsql as $f$
begin
  update ops.jobs
     set status = 'leased', lease_owner = 'cr-worker', leased_at = now(),
         lease_expires_at = now() + interval '10 minutes', attempts = attempts + 1, updated_at = now()
   where id = p_job and status = 'queued';
  if not found then
    raise exception 'setup: job % is not queued', p_job;
  end if;
  insert into ops.job_events (job_id, tenant_id, event, worker_id, attempt, detail)
  select j.id, j.tenant_id, 'leased', 'cr-worker', j.attempts, j.kind from ops.jobs j where j.id = p_job;
  perform set_config('app.worker_id', 'cr-worker', true);
  perform set_config('app.job_id', p_job::text, true);
end
$f$;

-- Request, start and settle a lead_triage run of the task, and open its review.
create function pg_temp.flow_run(p_key text, p_provider text, p_model text, p_tenant text default 'a',
                                 p_pin text default null) returns uuid
language plpgsql as $f$
declare
  v_job uuid;
  v     text;
begin
  perform pg_temp.remember('run.' || p_key,
    ops.request_agent_run(pg_temp.id(p_tenant || '.tenant'), pg_temp.id('task.' || p_key),
                          pg_temp.id(p_tenant || '.agent'), 'lead_triage', 'cr-' || p_key, 'cr-suite',
                          p_pinned_provider => p_pin));
  v_job := (pg_temp.run(p_key)).job_id;
  if v_job is null then
    raise exception 'setup: the run of % was refused at its request (%)', p_key, (pg_temp.run(p_key)).error_code;
  end if;
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  v := ops.start_agent_run(p_provider, p_model, 'lead_triage.v2',
                           encode(sha256(convert_to('SENTINEL-CR-INPUT-' || p_key, 'UTF8')), 'hex'), 8000);
  if v <> 'running' then
    execute 'reset role';
    raise exception 'setup: the run of % did not start (%)', p_key, v;
  end if;
  perform ops.complete_agent_run(
    jsonb_build_object('outcome', 'triaged', 'intent', 'information', 'priority', 'normal', 'flags', '[]'::jsonb,
                       'summary', 'SENTINEL-CR-SUMMARY-' || p_key, 'recommended_next_action', 'SENTINEL-CR-NEXT',
                       'response_draft', 'SENTINEL-CR-DRAFT-' || p_key, 'needs_human_review', true),
    p_model, 'completed', null, null, 120, 60, 180, 0, 0, 42);
  perform ops.complete_job(v_job);
  perform ops.open_review_for_settled_job('cr-worker', v_job);
  execute 'reset role';
  return pg_temp.remember('review.' || p_key,
    (select r.id from ops.review_items r where r.agent_run_id = pg_temp.id('run.' || p_key)));
end
$f$;

create function pg_temp.decide(p_key text, p_decision text default 'rejected', p_tenant text default 'a')
returns void
language sql as $$
  select ops.record_review_decision(pg_temp.id(p_tenant || '.tenant'), pg_temp.id('review.' || p_key), p_decision,
                                    'cr-reviewer', 'cr-suite', 'SENTINEL-CR-NOTE-' || p_key);
$$;

-- Moves a flow's clock into the past: the one way to reach a deadline inside
-- one transaction. The owner's DISABLE TRIGGER, rolled back with the suite.
create function pg_temp.backdate(p_key text, p_by interval) returns void
language plpgsql as $f$
begin
  alter table ops.content_retention disable trigger content_retention_guard_update;
  update ops.content_retention
     set anchored_at = anchored_at - p_by, due_at = due_at - p_by
   where task_id = pg_temp.id('task.' || p_key);
  alter table ops.content_retention enable always trigger content_retention_guard_update;
end
$f$;

-- Runs the flow's bound retention job as the worker, and answers its status.
create function pg_temp.retention_job(p_key text) returns text
language plpgsql as $f$
declare
  v_job uuid := (pg_temp.ledger(p_key)).job_id;
  v     text;
begin
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  v := ops.redact_due_content();
  execute 'reset role';
  update ops.jobs set status = 'queued', lease_owner = null, leased_at = null, lease_expires_at = null
   where id = v_job;
  return v;
end
$f$;

create function pg_temp.authorize(p_retention_days integer, p_tenant text default 'a') returns uuid
language sql as $$
  select ops.record_model_data_authorization(
    pg_temp.id(p_tenant || '.tenant'), 'health', 'lead_triage', 'openai', 'cr-model', now() - interval '1 hour',
    now() + interval '30 days', 'fixture:provider-evidence:v1', now() - interval '2 hours', true,
    'fixture:contract:v1', 'fixture:dpa:v1', 'fixture:zdr:v1', 'fixture:retention:v1', 'fixture:transfer:v1',
    'fixture:lawful-basis:v1', p_retention_days, 'cr-suite');
$$;

-- Whether any row of this flow still carries a sentinel of its content.
create function pg_temp.content_left(p_key text) returns boolean
language sql as $$
  select exists (select 1 from ops.tasks t where t.id = pg_temp.id('task.' || p_key) and t::text like '%SENTINEL-CR%')
      or exists (select 1 from ops.agent_runs r where r.task_id = pg_temp.id('task.' || p_key)
                  and (r::text like '%SENTINEL-CR%' or r.input_fingerprint is not null))
      or exists (select 1 from ops.review_items v where v.task_id = pg_temp.id('task.' || p_key)
                  and v::text like '%SENTINEL-CR%');
$$;

do $$
declare
  ta uuid; tb uuid; co uuid; d uuid; cob uuid; db uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('cr-test-alpha', 'CR Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('cr-test-beta', 'CR Beta') returning id into tb;
  perform pg_temp.remember('a.tenant', ta);
  perform pg_temp.remember('b.tenant', tb);
  perform ops.record_model_price('openai', 'cr-model', 1.25, 2.5, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'cr price source', 'cr-suite');
  perform ops.record_model_price('fake', 'cr-fake', 1.25, 2.5, true, now() - interval '1 minute',
                                 now() + interval '1 day', 'cr price source', 'cr-suite');
  perform ops.set_spend_limit('global', 900000000000, 'UTC', 'cr ceiling', 'cr-suite');
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'cr budget', 'cr-suite', ta);
  perform ops.set_spend_limit('tenant', 900000000000, 'UTC', 'cr budget', 'cr-suite', tb);
  co := pg_temp.remember('a.company', ops.create_company(ta, 'cr-clinic', 'CR Clinic', 'cr-suite'));
  d := ops.create_department(ta, co, 'intake', 'Intake', 'cr-suite');
  perform pg_temp.remember('a.agent', ops.create_agent(ta, co, d, 'triage', 'CR Triage', 'Synthetic role', 'cr-suite'));
  cob := pg_temp.remember('b.company', ops.create_company(tb, 'cr-clinic-b', 'CR Clinic B', 'cr-suite'));
  db := ops.create_department(tb, cob, 'intake', 'Intake B', 'cr-suite');
  perform pg_temp.remember('b.agent', ops.create_agent(tb, cob, db, 'triage', 'CR Triage B', 'Synthetic role', 'cr-suite'));
end
$$;

-- ===========================================================================
-- A. The clock.
-- ===========================================================================

do $$
declare
  l   ops.content_retention;
  v   ops.review_items;
  j   ops.jobs;
  v_auth uuid;
begin
  -- A1 health on the in-process provider, zero authorizations: 30 days after
  -- the database's decision instant, one internal job at that instant.
  perform pg_temp.task('a-fake', 'health');
  perform pg_temp.flow_run('a-fake', 'fake', 'cr-fake', 'a', 'fake');
  if exists (select 1 from ops.content_retention r where r.task_id = pg_temp.id('task.a-fake')) then
    raise exception 'A1: a pending review started a retention clock';
  end if;
  perform pg_temp.decide('a-fake');
  v := pg_temp.review('a-fake');
  l := pg_temp.ledger('a-fake');
  if l.id is null or l.anchored_at is distinct from v.reviewed_at or l.review_item_id <> v.id
     or l.retention_days <> 30 or l.data_authorization_id is not null or l.data_class <> 'health'
     or l.due_at <> v.reviewed_at + interval '720 hours' or l.redacted_at is not null then
    raise exception 'A1: the in-process health flow was not anchored at reviewed_at for 30 days (%)', row_to_json(l);
  end if;
  select * into j from ops.jobs where id = l.job_id;
  if j.kind <> 'content.retention_due' or j.status <> 'queued' or j.available_at <> l.due_at
     or j.tenant_id <> l.tenant_id or not ('content.retention_due' = any (ops.internal_job_kinds()))
     or j.payload::text like '%SENTINEL%' then
    raise exception 'A1: the flow''s one internal job is not queued at its due instant (%)', row_to_json(j);
  end if;
  if exists (select 1 from ops.model_data_authorizations a where a.tenant_id = pg_temp.id('a.tenant')) then
    raise exception 'A1: the in-process path created an authorization';
  end if;
  if (select r::text from ops.content_retention r where r.id = l.id) like '%SENTINEL%' then
    raise exception 'A1: the ledger holds content';
  end if;

  -- A2 an authorized external run: that authorization's own 7 days.
  v_auth := pg_temp.remember('a.auth', pg_temp.authorize(7));
  perform pg_temp.task('a-auth', 'health');
  perform pg_temp.flow_run('a-auth', 'openai', 'cr-model');
  perform pg_temp.decide('a-auth', 'needs_edit');
  l := pg_temp.ledger('a-auth');
  if l.retention_days <> 7 or l.data_authorization_id is distinct from v_auth
     or l.due_at <> (pg_temp.review('a-auth')).reviewed_at + interval '168 hours' then
    raise exception 'A2: the relied-on authorization''s 7 days were not applied (%)', row_to_json(l);
  end if;

  -- A3 synthetic and test content has no D6 clock.
  perform pg_temp.task('a-synthetic', 'synthetic');
  perform pg_temp.flow_run('a-synthetic', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.decide('a-synthetic');
  perform pg_temp.task('a-test', 'test');
  perform pg_temp.flow_run('a-test', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.decide('a-test');
  if exists (select 1 from ops.content_retention r
              where r.task_id in (pg_temp.id('task.a-synthetic'), pg_temp.id('task.a-test'))) then
    raise exception 'A3: synthetic or test content got a D6 clock';
  end if;

  -- A4 the days never exceed 30, whatever an authorization says: the record
  -- itself refuses more (D6), and the clock applies the least.
  if ops.content_retention_days(null) <> 30 or ops.content_retention_days(v_auth) <> 7
     or ops.content_retention_max_days() <> 30 then
    raise exception 'A4: the retention days are not bounded by D6';
  end if;
  perform pg_temp.expect('A4 an authorization for 31 days', '23514', format($q$
    select ops.record_model_data_authorization(%L, 'health', 'lead_triage', 'openai', 'cr-model-31',
      now() - interval '1 hour', now() + interval '1 day', 'fixture:e', now() - interval '2 hours', true,
      'fixture:c', 'fixture:d', 'fixture:z', 'fixture:r', 'fixture:t', 'fixture:l', 31, 'cr-suite')$q$,
    pg_temp.id('a.tenant')));
end
$$;

-- ===========================================================================
-- B. Before the deadline nothing is redacted.
-- ===========================================================================

do $$
declare
  v jsonb;
begin
  if pg_temp.retention_job('a-fake') <> 'not_due' then
    raise exception 'B1: the job redacted a flow before its due instant';
  end if;
  v := ops.sweep_content_retention(1000, 'cr-owner');
  if (v ->> 'redacted')::int <> 0 then
    raise exception 'B2: the sweep redacted content before its due instant (%)', v;
  end if;
  if not pg_temp.content_left('a-fake') or (pg_temp.task_row('a-fake')).content_redacted_at is not null
     or (pg_temp.ledger('a-fake')).redacted_at is not null then
    raise exception 'B3: content before its deadline is not intact';
  end if;
end
$$;

-- ===========================================================================
-- C. At the deadline: the WhatsApp-admitted, authorized flow, whose rows carry
--    every fingerprint.
-- ===========================================================================

do $$
declare
  v_line   uuid;
  v_job    uuid;
  v        jsonb;
  t0 ops.tasks; t1 ops.tasks;
  r0 ops.agent_runs; r1 ops.agent_runs;
  w0 ops.review_items; w1 ops.review_items;
  m0 ops.inbound_messages; m1 ops.inbound_messages;
  l  ops.content_retention;
  v_events bigint;
begin
  v_line := pg_temp.remember('a.line',
    ops.configure_whatsapp_channel(pg_temp.id('a.tenant'), pg_temp.id('a.company'), pg_temp.id('a.agent'),
                                   '309000000000001', 'test', 'CR line', 'cr-suite'));
  -- An unregistered sender on a test line: health (D8), run on the authorized binding.
  v := ops.receive_whatsapp_message('309000000000001', 'wamid.CR-C1', '5511900001001',
                                    'SENTINEL-CR-BODY-c synthetic hello', now());
  perform pg_temp.remember('task.c', (v ->> 'task_id')::uuid);
  perform pg_temp.remember('run.c', (v ->> 'agent_run_id')::uuid);
  perform pg_temp.remember('inbound.c', (v ->> 'inbound_message_id')::uuid);
  v_job := (pg_temp.run('c')).job_id;
  perform pg_temp.lease(v_job);
  execute 'set local role ops_worker';
  perform ops.claim_agent_run();
  if ops.start_agent_run('openai', 'cr-model', 'lead_triage.v2',
                         encode(sha256(convert_to('SENTINEL-CR-INPUT-c', 'UTF8')), 'hex'), 8000) <> 'running' then
    raise exception 'C: setup: the admitted run did not start';
  end if;
  perform ops.complete_agent_run(
    jsonb_build_object('outcome', 'triaged', 'intent', 'information', 'priority', 'normal', 'flags', '[]'::jsonb,
                       'summary', 'SENTINEL-CR-SUMMARY-c', 'recommended_next_action', 'SENTINEL-CR-NEXT',
                       'response_draft', 'SENTINEL-CR-DRAFT-c', 'needs_human_review', true),
    'cr-model', 'completed', null, null, 120, 60, 180, 0, 0, 42);
  perform ops.complete_job(v_job);
  perform ops.open_review_for_settled_job('cr-worker', v_job);
  execute 'reset role';
  perform pg_temp.remember('review.c', (select r.id from ops.review_items r where r.agent_run_id = pg_temp.id('run.c')));
  perform pg_temp.decide('c', 'rejected');

  t0 := pg_temp.task_row('c'); r0 := pg_temp.run('c'); w0 := pg_temp.review('c');
  select * into m0 from ops.inbound_messages where id = pg_temp.id('inbound.c');
  if t0.request_fingerprint is null or r0.input_fingerprint is null or m0.body_fingerprint is null
     or t0.data_class <> 'health' or r0.data_authorization_id is null then
    raise exception 'C: setup: the flow does not carry its fingerprints and authorization';
  end if;
  select count(*) into v_events from ops.events e where e.tenant_id = t0.tenant_id;

  -- Its deadline passes (the authorization's 7 days, and more).
  perform pg_temp.backdate('c', interval '8 days');
  if pg_temp.retention_job('c') <> 'redacted' then
    raise exception 'C1: the due job did not redact the flow';
  end if;

  t1 := pg_temp.task_row('c'); r1 := pg_temp.run('c'); w1 := pg_temp.review('c');
  select * into m1 from ops.inbound_messages where id = pg_temp.id('inbound.c');
  l := pg_temp.ledger('c');

  -- Content and the unkeyed digests of it: gone.
  if t1.description is not null or t1.request_fingerprint is not null or r1.result is not null
     or r1.input_fingerprint is not null or w1.proposed is not null or w1.decision_note is not null
     or m1.body_fingerprint is not null or pg_temp.content_left('c') then
    raise exception 'C2: protected content or a content fingerprint remains after its deadline';
  end if;
  if t1.content_redacted_at is null or t1.content_redacted_at <> l.redacted_at
     or r1.content_redacted_at <> l.redacted_at or w1.content_redacted_at <> l.redacted_at
     or m1.content_redacted_at <> l.redacted_at
     or l.redaction_reason <> 'retention_expired' or l.redacted_by <> 'system:content-retention'
     or l.redacted_at < l.due_at then
    raise exception 'C3: the redaction is not recorded on every row at the ledger''s instant (%)', row_to_json(l);
  end if;

  -- The audit facts that prove the flow: unchanged.
  if (to_jsonb(t1) - array['description', 'request_fingerprint', 'content_redacted_at'])
       is distinct from (to_jsonb(t0) - array['description', 'request_fingerprint', 'content_redacted_at']) then
    raise exception 'C4: the task''s audit facts changed (%)', to_jsonb(t1);
  end if;
  if (to_jsonb(r1) - array['result', 'input_fingerprint', 'content_redacted_at'])
       is distinct from (to_jsonb(r0) - array['result', 'input_fingerprint', 'content_redacted_at']) then
    raise exception 'C4: the run''s audit facts changed';
  end if;
  if (to_jsonb(w1) - array['proposed', 'decision_note', 'content_redacted_at'])
       is distinct from (to_jsonb(w0) - array['proposed', 'decision_note', 'content_redacted_at']) then
    raise exception 'C4: the review''s decision facts changed';
  end if;
  if (to_jsonb(m1) - array['body_fingerprint', 'content_redacted_at'])
       is distinct from (to_jsonb(m0) - array['body_fingerprint', 'content_redacted_at']) then
    raise exception 'C4: the admission''s facts changed';
  end if;
  if t1.data_class <> 'health' or r1.data_class <> 'health' or r1.data_authorization_id is distinct from r0.data_authorization_id
     or r1.provider <> 'openai' or r1.model <> 'cr-model' or r1.status <> 'succeeded' or r1.capability <> 'lead_triage'
     or w1.status <> 'rejected' or w1.reviewer <> 'cr-reviewer' or w1.reviewed_at <> w0.reviewed_at
     or t1.idempotency_key is null then
    raise exception 'C4: the class, authorization, provider, model, decision or key did not survive';
  end if;
  if (select count(*) from ops.events e where e.tenant_id = t0.tenant_id) <> v_events then
    raise exception 'C4: the redaction wrote or removed events';
  end if;
  -- The authorization the run relied on is still provable, and still undeletable.
  if not exists (select 1 from ops.model_data_authorizations a
                  where a.id = r1.data_authorization_id and a.content_retention_days = 7) then
    raise exception 'C5: the authorization the run relied on is no longer provable';
  end if;
  perform ops.retire_model_data_authorization(r1.data_authorization_id, 'cr retire', 'cr-suite');
  perform pg_temp.expect('C5 deleting an authorization a redacted run relied on', '23503',
    format('delete from ops.model_data_authorizations where id = %L', r1.data_authorization_id));
end
$$;

-- ===========================================================================
-- D. A repeat changes nothing.
-- ===========================================================================

do $$
declare
  l0 ops.content_retention := pg_temp.ledger('c');
  v  jsonb;
begin
  if pg_temp.retention_job('c') <> 'already_redacted' then
    raise exception 'D1: the replayed job did not answer already_redacted';
  end if;
  v := ops.sweep_content_retention(1000, 'cr-owner');
  if (v ->> 'redacted')::int <> 0 then
    raise exception 'D2: a sweep after redaction redacted again (%)', v;
  end if;
  if (ops.erase_task_content(pg_temp.id('a.tenant'), pg_temp.id('task.c'), 'cr-owner')) ->> 'status'
       <> 'already_redacted' then
    raise exception 'D3: erasing a redacted flow did not answer already_redacted';
  end if;
  if to_jsonb(pg_temp.ledger('c')) is distinct from to_jsonb(l0) then
    raise exception 'D4: a repeat rewrote the ledger';
  end if;

  -- The owner's sweep takes a due flow the job has not reached.
  perform pg_temp.backdate('a-fake', interval '31 days');
  v := ops.sweep_content_retention(1000, 'cr-owner');
  if (v ->> 'redacted')::int <> 1 or pg_temp.content_left('a-fake')
     or (pg_temp.ledger('a-fake')).redacted_by <> 'cr-owner' then
    raise exception 'D5: the sweep did not redact the one due flow (%)', v;
  end if;
  if pg_temp.retention_job('a-fake') <> 'already_redacted'
     or (ops.sweep_content_retention(1000, 'cr-owner') ->> 'redacted')::int <> 0 then
    raise exception 'D6: after the sweep, the job or a second sweep did something';
  end if;
  perform pg_temp.expect('D7 a sweep bound above 1000', 'OS400', $q$select ops.sweep_content_retention(1001, 'cr-owner')$q$);
end
$$;

-- ===========================================================================
-- E. The owner's erasure.
-- ===========================================================================

do $$
declare
  v_counts jsonb;
  v        jsonb;
  l        ops.content_retention;
begin
  -- E1 a decided flow, due in 30 days, erased now.
  perform pg_temp.task('e-decided', 'health');
  perform pg_temp.flow_run('e-decided', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.decide('e-decided');
  v_counts := jsonb_build_array(
    (select count(*) from ops.tasks where tenant_id = pg_temp.id('a.tenant')),
    (select count(*) from ops.agent_runs where tenant_id = pg_temp.id('a.tenant')),
    (select count(*) from ops.review_items where tenant_id = pg_temp.id('a.tenant')),
    (select count(*) from ops.events where tenant_id = pg_temp.id('a.tenant')));
  v := ops.erase_task_content(pg_temp.id('a.tenant'), pg_temp.id('task.e-decided'), 'cr-owner');
  l := pg_temp.ledger('e-decided');
  if v ->> 'status' <> 'redacted' or pg_temp.content_left('e-decided') or l.redaction_reason <> 'erasure'
     or l.redacted_by <> 'cr-owner' or l.due_at <= l.redacted_at or (pg_temp.review('e-decided')).status <> 'rejected' then
    raise exception 'E1: the owner''s erasure did not redact a decided flow before its deadline (%)', v;
  end if;
  if v_counts is distinct from jsonb_build_array(
    (select count(*) from ops.tasks where tenant_id = pg_temp.id('a.tenant')),
    (select count(*) from ops.agent_runs where tenant_id = pg_temp.id('a.tenant')),
    (select count(*) from ops.review_items where tenant_id = pg_temp.id('a.tenant')),
    (select count(*) from ops.events where tenant_id = pg_temp.id('a.tenant'))) then
    raise exception 'E1: the erasure deleted or added a row';
  end if;
  -- Its queued job then finds the flow redacted.
  if pg_temp.retention_job('e-decided') <> 'already_redacted' then
    raise exception 'E1: the erased flow''s job did not answer already_redacted';
  end if;

  -- E2 a flow in progress is refused, and stays intact.
  perform pg_temp.task('e-pending', 'health');
  perform pg_temp.flow_run('e-pending', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.expect('E2 erasing a flow whose review is undecided', 'OS409',
    format('select ops.erase_task_content(%L, %L, %L)', pg_temp.id('a.tenant'), pg_temp.id('task.e-pending'), 'cr-owner'));
  if not pg_temp.content_left('e-pending') then
    raise exception 'E2: a refused erasure removed content';
  end if;

  -- E3 a flow that never reached a review (its run was refused): no clock, but
  -- erasable; the ledger records an erasure with no anchor.
  perform pg_temp.task('e-refused', 'health');
  perform pg_temp.remember('run.e-refused',
    ops.request_agent_run(pg_temp.id('a.tenant'), pg_temp.id('task.e-refused'), pg_temp.id('a.agent'),
                          'lead_triage', 'cr-e-refused', 'cr-suite'));
  if (pg_temp.run('e-refused')).status <> 'cancelled' then
    raise exception 'E3: setup: the unauthorized request was not refused';
  end if;
  v := ops.erase_task_content(pg_temp.id('a.tenant'), pg_temp.id('task.e-refused'), 'cr-owner');
  l := pg_temp.ledger('e-refused');
  if v ->> 'status' <> 'redacted' or l.anchored_at is not null or l.redaction_reason <> 'erasure'
     or (pg_temp.task_row('e-refused')).description is not null
     or (pg_temp.run('e-refused')).content_redacted_at is null then
    raise exception 'E3: a flow with no decided review was not erasable (%)', row_to_json(l);
  end if;

  -- E4 only health and person_text content is erased by this act.
  perform pg_temp.expect('E4 erasing synthetic content', 'OS409',
    format('select ops.erase_task_content(%L, %L, %L)', pg_temp.id('a.tenant'), pg_temp.id('task.a-synthetic'), 'cr-owner'));
  perform pg_temp.expect('E4 erasing without an actor', 'OS400',
    format('select ops.erase_task_content(%L, %L, null)', pg_temp.id('a.tenant'), pg_temp.id('task.e-pending')));

  -- E5 a person_text flow is D6 content too.
  perform pg_temp.task('e-person', 'person_text');
  perform pg_temp.flow_run('e-person', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.decide('e-person');
  if (pg_temp.ledger('e-person')).retention_days <> 30 then
    raise exception 'E5: a person_text flow got no 30-day clock';
  end if;
end
$$;

-- ===========================================================================
-- F. One tenant cannot erase another's content.
-- ===========================================================================

do $$
begin
  perform pg_temp.task('f-b', 'health', 'b');
  perform pg_temp.flow_run('f-b', 'fake', 'cr-fake', 'b', 'fake');
  perform pg_temp.decide('f-b', 'rejected', 'b');
  perform pg_temp.expect('F1 tenant a erasing tenant b''s task', 'OS404',
    format('select ops.erase_task_content(%L, %L, %L)', pg_temp.id('a.tenant'), pg_temp.id('task.f-b'), 'cr-owner'));
  if not pg_temp.content_left('f-b') or (pg_temp.ledger('f-b')).redacted_at is not null then
    raise exception 'F1: another tenant''s erasure touched tenant b''s content';
  end if;
  -- A worker holding tenant a's retention job reaches only the flow bound to it.
  if pg_temp.retention_job('a-auth') <> 'not_due' or not pg_temp.content_left('f-b') then
    raise exception 'F2: a tenant a job reached another flow';
  end if;
end
$$;

-- ===========================================================================
-- G. The guards admit a recorded redaction and nothing else.
-- ===========================================================================

do $$
declare
  v_task uuid := pg_temp.id('task.e-pending');
  v_run  uuid := pg_temp.id('run.e-pending');
begin
  -- G1 a marker no ledger row records: refused on every table.
  perform pg_temp.expect('G1 task marker without the ledger', 'OS403',
    format('update ops.tasks set description = null, content_redacted_at = now() where id = %L', v_task));
  perform pg_temp.expect('G1 review marker without the ledger', 'OS403',
    format('update ops.review_items set proposed = null, content_redacted_at = now() where task_id = %L', v_task));
  perform pg_temp.expect('G1 run marker without the ledger', 'OS403',
    format('update ops.agent_runs set result = null, input_fingerprint = null, content_redacted_at = now() where id = %L', v_run));

  -- G2 on a redacted flow: content written back, a marker cleared or moved, or
  -- another column changed alongside, all refused.
  perform pg_temp.expect('G2 description written back', '23514',
    format('update ops.tasks set description = %L where id = %L', 'back', pg_temp.id('task.c')));
  perform pg_temp.expect('G2 task marker cleared', 'OS403',
    format('update ops.tasks set content_redacted_at = null where id = %L', pg_temp.id('task.c')));
  perform pg_temp.expect('G2 run result written back', 'OS409',
    format($q$update ops.agent_runs set result = '{"summary": "back"}' where id = %L$q$, pg_temp.id('run.c')));
  perform pg_temp.expect('G2 review content written back', 'OS403',
    format($q$update ops.review_items set proposed = '{"summary": "back"}' where id = %L$q$, pg_temp.id('review.c')));
  perform pg_temp.expect('G2 fingerprint written back', 'OS403',
    format('update ops.inbound_messages set body_fingerprint = repeat(%L, 64) where id = %L', 'a', pg_temp.id('inbound.c')));
  perform pg_temp.expect('G2 the ledger rewritten', 'OS409',
    format('update ops.content_retention set redaction_reason = %L where task_id = %L', 'erasure', pg_temp.id('task.c')));

  -- G3 a redaction the ledger DOES record at that instant still changes
  --    nothing but content: one that also rewrites who decided is refused.
  declare
    v_at timestamptz := clock_timestamp();
  begin
    update ops.content_retention
       set redacted_at = v_at, redaction_reason = 'erasure', redacted_by = 'cr-g3'
     where task_id = pg_temp.id('task.e-person');
    update ops.review_items
       set proposed = null, decision_note = null, reviewer = 'cr-someone-else', content_redacted_at = v_at
     where id = pg_temp.id('review.e-person');
    raise exception 'G3: a recorded redaction also rewrote the reviewer';
  exception when sqlstate 'OS403' then
    null; -- refused, and the subtransaction took the ledger change back with it
  end;
  if (pg_temp.ledger('e-person')).redacted_at is not null or not pg_temp.content_left('e-person') then
    raise exception 'G3: the refused redaction left a trace';
  end if;

  -- G4 the clock never moves back.
  perform pg_temp.expect('G4 the anchor moved back', 'OS409',
    format($q$update ops.content_retention set anchored_at = anchored_at - interval '1 day',
                  due_at = due_at - interval '1 day' where task_id = %L$q$, pg_temp.id('task.e-person')));

  -- G5 no new run about a redacted task.
  perform pg_temp.expect('G5 a run requested about a redacted task', 'OS409',
    format($q$select ops.request_agent_run(%L, %L, %L, 'lead_triage', 'cr-g5', 'cr-suite', p_pinned_provider => 'fake')$q$,
           pg_temp.id('a.tenant'), pg_temp.id('task.e-decided'), pg_temp.id('a.agent')));

  -- G6 the class never changes, redaction included.
  if (pg_temp.task_row('e-decided')).data_class <> 'health' then
    raise exception 'G6: a redacted task lost its class';
  end if;
end
$$;

-- ===========================================================================
-- H. Only the owner, and the worker's bound job, can redact.
-- ===========================================================================

do $$
declare
  v_role  text;
  v_fn    text;
  v_state text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway', 'ops_operator_api'] loop
    if has_table_privilege(v_role, 'ops.content_retention', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'H1: % holds a privilege on ops.content_retention', v_role;
    end if;
    foreach v_fn in array array[
      'ops.erase_task_content(uuid, uuid, text)',
      'ops.sweep_content_retention(integer, text)',
      'ops.redact_task_content(uuid, uuid, text, text)',
      'ops.schedule_content_retention(uuid)',
      'ops.content_redaction_permitted(jsonb, jsonb, text[], uuid, uuid)',
      'ops.content_flow_in_progress(uuid, uuid)',
      'ops.content_retention_days(uuid)'] loop
      if has_function_privilege(v_role, v_fn, 'EXECUTE') then
        raise exception 'H1: % can execute %', v_role, v_fn;
      end if;
    end loop;
    if has_function_privilege(v_role, 'ops.redact_due_content()', 'EXECUTE') <> (v_role = 'ops_worker') then
      raise exception 'H1: the worker''s one capability is not exactly the worker''s (%)', v_role;
    end if;
  end loop;

  -- The worker cannot call the owner's acts even inside a lease.
  v_fn := format('select ops.erase_task_content(%L, %L, %L)',
                 pg_temp.id('a.tenant'), pg_temp.id('task.e-person'), 'cr-attacker');
  set local role ops_worker;
  v_state := pg_temp.attempt(v_fn);
  reset role;
  if v_state is distinct from '42501' then
    raise exception 'H1: the worker reached the erasure (%)', coalesce(v_state, 'success');
  end if;

  -- H2 the worker's capability needs a live lease of a retention job.
  set local role ops_worker;
  v_state := pg_temp.attempt('select ops.redact_due_content()');
  reset role;
  if v_state is distinct from '42501' then
    raise exception 'H2: the capability ran without a lease (%)', coalesce(v_state, 'success');
  end if;
  if not pg_temp.content_left('e-person') then
    raise exception 'H: a refused attempt removed content';
  end if;
end
$$;

-- ===========================================================================
-- I. A redacted review's send is blocked, never attempted.
-- ===========================================================================

do $$
declare
  v_out  uuid;
  v      jsonb;
  m      ops.inbound_messages;
begin
  select * into m from ops.inbound_messages where id = pg_temp.id('inbound.c');
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
                                     status, requested_by, authorized_check)
  values (m.tenant_id, m.company_id, m.channel_id, m.conversation_id, pg_temp.id('review.c'), pg_temp.id('task.c'),
          'authorized', 'cr-owner', '{}'::jsonb)
  returning id into v_out;
  v := ops.begin_outbound_send(m.tenant_id, v_out);
  if v ->> 'state' <> 'blocked' or v ->> 'reason' <> 'content_redacted' or v ? 'body'
     or (select o.blocked_reason from ops.outbound_messages o where o.id = v_out) <> 'content_redacted' then
    raise exception 'I1: a redacted review''s send was not blocked (%)', v;
  end if;
end
$$;

-- ===========================================================================
-- J. A later decided review moves the clock forward.
-- ===========================================================================

do $$
declare
  l0 ops.content_retention;
  l1 ops.content_retention;
begin
  perform pg_temp.task('j', 'health');
  perform pg_temp.flow_run('j', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.decide('j');
  perform pg_temp.backdate('j', interval '2 days');
  l0 := pg_temp.ledger('j');
  -- A second run about the same task, reviewed and decided now.
  perform pg_temp.remember('task.j2', pg_temp.id('task.j'));
  perform pg_temp.flow_run('j2', 'fake', 'cr-fake', 'a', 'fake');
  perform pg_temp.decide('j2');
  l1 := pg_temp.ledger('j');
  if l1.id <> l0.id or l1.review_item_id <> pg_temp.id('review.j2') or l1.anchored_at <= l0.anchored_at
     or l1.due_at <> l1.anchored_at + interval '720 hours' or l1.job_id = l0.job_id then
    raise exception 'J1: the later decision did not move the clock forward (%)', row_to_json(l1);
  end if;
  -- The earlier anchor's job finds no binding.
  perform pg_temp.lease(l0.job_id);
  set local role ops_worker;
  if ops.redact_due_content() <> 'superseded' then
    reset role;
    raise exception 'J2: the earlier job was not superseded';
  end if;
  reset role;
  if not pg_temp.content_left('j') then
    raise exception 'J2: the superseded job removed content';
  end if;
end
$$;

select 'content_retention: PASS' as result;

rollback;
