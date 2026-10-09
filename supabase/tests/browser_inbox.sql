-- ADR 0026 §E, slice 5 — attacks on the browser inbox (SI-87).
--
-- The question: can a member read a conversation that is not a waiting test
-- conversation of their own tenant, see in it what SI-87 keeps out (a number,
-- an identifier, an actor, an event order, a draft that never left), reply
-- without a second factor verified within the hour by a factor older than the
-- session, reply to a conversation that moved, is not a person's, cannot be
-- answered or would be refused by the send, write anything on a refusal, or
-- send a reply by any path but its own act's job, out of order or past its
-- window?
--
-- WHAT THIS SUITE PROVES, in the order the sections run:
--   * A: the catalogue. Every inbox function and every replaced one keeps its
--     pinned mode, volatility, search path, owner and ACL; ops_operator_api
--     executes exactly the 24 gates; the send table holds the person_reply
--     kind under its shape check and its always-enabled guard.
--   * B: get_conversation. The available answer's exact keys; the turns, in
--     order, of every kind; the 50-turn window; the first word of the CRM
--     first name; a sweep for what must never leave; every withheld and
--     closed state; one OS404 for every ref that is not a task of the tenant's
--     conversations; a split conversation; and the read writes nothing.
--   * C: reply_to_conversation. The one recorded act (a person review the
--     principal accepted, a person_reply send request and its job, events of
--     source company-os-ui), and every refusal as an answer state that writes
--     nothing: the second factor (missing, stale, another method, another
--     session, a factor enrolled during the session), stale, not held, not
--     waiting, withheld, every send gate, nothing to answer, content erased,
--     the five-reply limit, a repeat already recorded; a malformed request is
--     OS400; a stop of every scope holds the send instead of refusing it; two
--     members reply on their own. Each refusal agrees with the read's
--     allowedActs and replyUnavailable (B11).
--   * D: the send table's guard admits a person_reply row only from its act.
--   * E: release_conversation, and what a release leaves running.
--   * F: the acts' paths, pinned from the live catalogue.
--   * G: the reply job, through the worker's own capabilities under a
--     simulated lease: its body, its window, every gate, the order of a
--     conversation's replies, a stop, the reaper, and the opt-out record.
--   * H: the owner's CLI reply keeps its answer, source and messages.
--   Left to engine/domain/browserInbox.dbtest.ts: the real worker loop, the
--   2 s bound measured, races on two connections, and the model's input.
--
-- ONE TRANSACTION, ROLLED BACK. ALL DATA IS SYNTHETIC: numbers, names and
-- texts are invented. Nothing here is a real person.

\set ON_ERROR_STOP on

begin;

-- A lock another session's open transaction holds fails this suite instead of
-- hanging it.
set local lock_timeout = '20s';

-- Membership is needed to `set role ops_worker` for the worker's capabilities.
-- `grant <role> to current_user` crashes this server build (owner decision
-- S0-F): interpolate, and only inside this transaction.
do $$ begin execute format('grant ops_worker to %I', current_user); end $$;

-- ---------------------------------------------------------------------------
-- Helpers. Temporary, so they vanish with the transaction.
-- ---------------------------------------------------------------------------

create temporary table bi_ids (name text primary key, id uuid not null) on commit drop;
create temporary sequence bi_device_seq start 100;

create function pg_temp.remember(p_name text, p_id uuid) returns uuid
language sql as $$
  insert into bi_ids (name, id) values (p_name, p_id)
  on conflict (name) do update set id = excluded.id returning id;
$$;

-- Volatile on purpose: a STABLE call with constant arguments may be planned
-- under a snapshot that misses an id a block has just remembered.
create function pg_temp.id(p_name text) returns uuid
language plpgsql volatile as $$
declare v uuid;
begin
  select id into v from bi_ids where name = p_name;
  if v is null then
    raise exception 'setup: no fixture named %', p_name;
  end if;
  return v;
end
$$;

-- The claims PostgREST sets after verifying a JWT, at assurance level 2.
create function pg_temp.claims(p_who text, p_session text default null) returns text
language plpgsql volatile as $f$
begin
  return jsonb_build_object(
    'sub', pg_temp.id('user.' || p_who), 'role', 'authenticated', 'aud', 'authenticated',
    'session_id', pg_temp.id('session.' || coalesce(p_session, p_who)), 'is_anonymous', false, 'aal', 'aal2',
    'iss', 'http://127.0.0.1:54341/auth/v1', 'exp', extract(epoch from now() + interval '1 hour')::bigint)::text;
end
$f$;

-- One simulated PostgREST request: the verified claims, then the call as
-- authenticated. The body, or the refusal as (SQLSTATE, message, detail,
-- hint). An error rolls the subtransaction back, role included.
create function pg_temp.api(p_claims text, p_call text) returns jsonb
language plpgsql as $f$
declare
  v_body   jsonb;
  v_state  text;
  v_msg    text;
  v_detail text;
  v_hint   text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, ''), true);
  begin
    set local role authenticated;
    execute 'select ' || p_call into v_body;
    reset role;
    return jsonb_build_object('ok', true, 'body', v_body);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text,
                            v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    return jsonb_build_object('ok', false, 'code', v_state, 'message', v_msg,
                              'detail', v_detail, 'hint', v_hint);
  end;
end
$f$;

-- Every answer the suite received, for the sweep of what must never leave.
create temporary table bi_out (n serial primary key, label text not null, body jsonb not null) on commit drop;

-- get_conversation as a member; its body, or the named failure.
create function pg_temp.read(p_label text, p_task uuid, p_who text default 'm_a') returns jsonb
language plpgsql as $f$
declare
  v jsonb := pg_temp.api(pg_temp.claims(p_who), format('company_os_api.get_conversation(%L)', p_task));
begin
  if not (v ->> 'ok')::boolean then
    raise exception '%: get_conversation was refused: %', p_label, v;
  end if;
  insert into bi_out (label, body) values (p_label, v -> 'body');
  return v -> 'body';
end
$f$;

-- The two acts as a member, raw (a body or a refusal); every body is kept
-- for the sweep.
create function pg_temp.reply(p_task uuid, p_text text, p_revision int, p_who text default 'm_a',
                              p_session text default null) returns jsonb
language plpgsql as $f$
declare
  v jsonb := pg_temp.api(pg_temp.claims(p_who, p_session),
                         format('company_os_api.reply_to_conversation(%L, %L, %s)', p_task, p_text, p_revision));
begin
  if (v ->> 'ok')::boolean then
    insert into bi_out (label, body) values ('reply', v -> 'body');
  end if;
  return v;
end
$f$;

create function pg_temp.release(p_task uuid, p_revision int, p_who text default 'm_a') returns jsonb
language plpgsql as $f$
declare
  v jsonb := pg_temp.api(pg_temp.claims(p_who), format('company_os_api.release_conversation(%L, %s)', p_task, p_revision));
begin
  if (v ->> 'ok')::boolean then
    insert into bi_out (label, body) values ('release', v -> 'body');
  end if;
  return v;
end
$f$;

-- An act answered this outcome (and, unless null, this reason), writing
-- nothing: this backend's own writes are the same before and after.
create function pg_temp.refused(p_label text, p_call jsonb, p_outcome text, p_reason text default null,
                                p_before jsonb default null) returns void
language plpgsql as $f$
begin
  if not (p_call ->> 'ok')::boolean
     or p_call -> 'body' ->> 'outcome' is distinct from p_outcome
     or (p_reason is not null and p_call -> 'body' ->> 'reason' is distinct from p_reason) then
    raise exception '%: expected % (%), got %', p_label, p_outcome, coalesce(p_reason, '-'), p_call;
  end if;
  if p_before is not null and p_before is distinct from pg_temp.own_writes() then
    raise exception '%: the refusal wrote: before %, after %', p_label, p_before, pg_temp.own_writes();
  end if;
end
$f$;

-- An act's answer, stripped of asOf, which only says when it was answered.
create function pg_temp.answer(p_result jsonb) returns jsonb
language sql immutable as $$
  select case when (p_result ->> 'ok')::boolean then (p_result -> 'body') - 'asOf' else p_result end;
$$;

-- The conversation's revision, as the read reports it.
create function pg_temp.rev(p_conv uuid) returns int
language sql volatile as $$
  select ops.cos_conversation_revision(pg_temp.id('tenant_a'), p_conv);
$$;

-- Every object key path of an output, array positions folded to [].
create function pg_temp.key_paths(p jsonb, p_path text default '') returns setof text
language plpgsql immutable as $f$
declare
  k text;
  v jsonb;
begin
  if jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      return next p_path || '.' || k;
      return query select * from pg_temp.key_paths(v, p_path || '.' || k);
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select * from jsonb_array_elements(p) loop
      return query select * from pg_temp.key_paths(v, p_path || '[]');
    end loop;
  end if;
end
$f$;

-- Every number in an output, with its path: SI-87 keeps any event order,
-- sequence or count but the revision out of the answer.
create function pg_temp.number_paths(p jsonb, p_path text default '') returns setof text
language plpgsql immutable as $f$
declare
  k text;
  v jsonb;
begin
  if jsonb_typeof(p) = 'number' then
    return next p_path;
  elsif jsonb_typeof(p) = 'object' then
    for k, v in select * from jsonb_each(p) loop
      return query select * from pg_temp.number_paths(v, p_path || '.' || k);
    end loop;
  elsif jsonb_typeof(p) = 'array' then
    for v in select * from jsonb_array_elements(p) loop
      return query select * from pg_temp.number_paths(v, p_path || '[]');
    end loop;
  end if;
end
$f$;

-- This backend's own writes in this transaction, per table: rows inserted,
-- updated and deleted, counted as attempted. Only this backend moves these
-- counters, so another session writing at the same time never shows here.
create function pg_temp.own_writes() returns jsonb
language sql volatile as $$
  select coalesce(jsonb_object_agg(c.oid::regclass::text, w.n), '{}')
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace,
         lateral (select pg_stat_get_xact_tuples_inserted(c.oid) + pg_stat_get_xact_tuples_updated(c.oid)
                           + pg_stat_get_xact_tuples_deleted(c.oid) as n) w
   where c.relkind in ('r', 'p', 'm') and ns.nspname !~ '^pg_(temp|toast)' and w.n > 0;
$$;

-- A lease on one job, taken the way ops.lease_job takes it but only on that
-- job, so a job some other session left queued is never leased here.
create function pg_temp.lease_job(p_job uuid, p_worker text default 'bi-worker') returns uuid
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

-- The screening the front-desk engine would produce for a message.
create function pg_temp.screening(p_class text, p_text text default null, p_person boolean default false,
                                  p_opt_out boolean default false) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'sanitizerVersion', 'front_desk_screen.v3', 'packId', 'health_pt_br.v1',
    'messageClass', p_class, 'safetyClass', case when p_class = 'safety' then 'crisis' else 'none' end,
    'safeText', p_text, 'sensitiveContentPresent', false, 'fullyBlocked', p_text is null,
    'segmentsRedacted', 0, 'segmentsSensitive', 0, 'segmentsUnrecognised', 0,
    'administrativeIntent', p_class = 'administrative', 'humanRequested', p_person,
    'optOutRequested', p_opt_out, 'requiresHuman', p_person or p_opt_out);
$$;

-- A valid lead_triage result carrying a draft.
create function pg_temp.triage(p_draft text) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'outcome', 'triaged', 'intent', 'book_appointment', 'priority', 'normal',
    'summary', 'A synthetic person asks about a first appointment.',
    'recommended_next_action', 'Offer two synthetic slots.',
    'response_draft', p_draft, 'needs_human_review', false, 'flags', '[]'::jsonb);
$$;

-- The worker's handling of an admitted message's run, through its own
-- capabilities: the screening; for a model disposition with a draft, the
-- start, the settlement and the review opened after it; the job completed.
create function pg_temp.screen(p_task uuid, p_screening jsonb, p_draft text default null) returns text
language plpgsql as $f$
declare
  v_run  uuid;
  v_job  uuid;
  v_disp text;
begin
  select m.agent_run_id into v_run from ops.inbound_messages m where m.task_id = p_task;
  select r.job_id into v_job from ops.agent_runs r where r.id = v_run;
  perform pg_temp.lease_job(v_job);
  set local role ops_worker;
  v_disp := ops.record_inbound_screening(p_screening) ->> 'disposition';
  if v_disp = 'model' and p_draft is not null then
    perform ops.claim_agent_run();
    if ops.start_agent_run('fake', 'bi-model-1', 'lead_triage.v3',
                           encode(sha256(convert_to(v_run::text, 'UTF8')), 'hex'), 8000) <> 'running' then
      raise exception 'setup: the run of task % did not start', p_task;
    end if;
    perform ops.complete_agent_run(pg_temp.triage(p_draft), 'bi-model-1', 'completed',
                                   'bi-provider-req', 'bi-provider-resp', 120, 60, 180, 0, 0, 42);
    perform ops.complete_job(v_job);
    perform ops.open_review_for_settled_job('bi-worker', v_job);
  elsif v_disp <> 'model' then
    perform ops.complete_job(v_job);
  end if;
  reset role;
  return v_disp;
end
$f$;

-- One WhatsApp message from a device on tenant A's test line.
create function pg_temp.receive(p_device text, p_body text, p_at timestamptz default now(),
                                p_target text default '300000000000510') returns jsonb
language plpgsql as $f$
declare
  v jsonb;
begin
  v := ops.receive_whatsapp_message(p_target, 'wamid.BI-' || gen_random_uuid(), p_device, p_body, p_at);
  if v ->> 'state' not in ('admitted', 'refused') then
    raise exception 'setup: a message was not stored: %', v;
  end if;
  return v;
end
$f$;

-- Each conversation's device and, when it has one, its CRM contact.
create temporary table bi_devices (key text primary key, device text not null, contact bigint) on commit drop;

-- A registered test device of tenant A's test line, and a CRM contact for
-- it unless p_first is null.
create function pg_temp.device(p_key text, p_first text default 'Bia', p_register boolean default true) returns text
language plpgsql as $f$
declare
  v_device  text := '5511987651' || lpad(nextval('bi_device_seq')::text, 3, '0');
  v_contact bigint;
begin
  if p_register then
    perform pg_temp.remember(p_key || '.sender',
      ops.register_test_sender(pg_temp.id('tenant_a'), pg_temp.id('channel_a'), v_device, 'bi-owner'));
  end if;
  if p_first is not null then
    insert into public.contacts (first_name, last_name, phone_jsonb)
    values (p_first, 'bi-test Synthetic',
            jsonb_build_array(jsonb_build_object('number', '+55 ' || substr(v_device, 3), 'type', 'Mobile')))
    returning id into v_contact;
  end if;
  insert into bi_devices (key, device, contact) values (p_key, v_device, v_contact);
  return v_device;
end
$f$;

create function pg_temp.device_of(p_key text) returns text
language sql volatile as $$ select device from bi_devices where key = p_key; $$;

create function pg_temp.contact_of(p_key text) returns bigint
language sql volatile as $$ select contact from bi_devices where key = p_key; $$;

-- A conversation waiting for a person: one admitted request for a person,
-- screened (its acknowledgement drafted and waiting for a person), the
-- conversation held by a person with an open person_requested.
create function pg_temp.waiting(p_key text, p_first text default 'Bia', p_at timestamptz default now() - interval '5 minutes')
returns uuid
language plpgsql as $f$
declare
  v_device text := pg_temp.device(p_key, p_first);
  v jsonb;
begin
  v := pg_temp.receive(v_device, 'Quero falar com uma pessoa, por favor.', p_at);
  perform pg_temp.remember(p_key || '.task', (v ->> 'task_id')::uuid);
  perform pg_temp.remember(p_key || '.conv', (v ->> 'conversation_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('unknown', null, true));
  if (select s.holder from ops.conversation_states s where s.conversation_id = (v ->> 'conversation_id')::uuid) <> 'person'
     or not ops.cos_conversation_waiting(pg_temp.id('tenant_a'), (v ->> 'conversation_id')::uuid) then
    raise exception 'setup: conversation % is not waiting for a person', p_key;
  end if;
  return (v ->> 'task_id')::uuid;
end
$f$;

-- The reply job of a send, as the worker runs it: begin, then (for a start)
-- the last gate and the settlement; a stop defers the job with its attempt
-- given back; a job the database gave back is left queued; any other end
-- completes it. Returns what each step answered.
create function pg_temp.carry(p_out uuid, p_transport text default 'fake', p_outcome text default 'sent')
returns jsonb
language plpgsql as $f$
declare
  v_job     uuid := (select o.job_id from ops.outbound_messages o where o.id = p_out);
  v_begin   jsonb;
  v_confirm jsonb;
  v_settle  text;
begin
  update ops.jobs set available_at = now() where id = v_job and status = 'queued';
  perform pg_temp.lease_job(v_job);
  set local role ops_worker;
  v_begin := ops.begin_reply_send(p_transport);
  if v_begin ->> 'action' = 'start' then
    v_confirm := ops.confirm_reply_send();
    if v_confirm ->> 'action' = 'send' then
      v_settle := ops.settle_reply_send(p_outcome, 'wamid.BI-SENT-' || p_out,
                                        case when p_outcome = 'failed' then '131026' end,
                                        case when p_outcome = 'failed' then 'recipient_unavailable' end);
    end if;
  end if;
  if v_begin ->> 'action' = 'stopped' then
    perform ops.defer_job();
  elsif v_begin ->> 'action' = 'settled'
        or (v_begin ->> 'action' = 'start' and v_confirm ->> 'action' in ('send', 'settled')) then
    perform ops.complete_job(v_job);
  end if;
  reset role;
  if v_settle is not null then
    perform ops.sync_send_exceptions(pg_temp.id('tenant_a'), p_out, 'agent-runtime');
  end if;
  return jsonb_strip_nulls(jsonb_build_object('begin', v_begin, 'confirm', v_confirm, 'settle', v_settle));
end
$f$;

-- B5. Every answer the suite received carries none of what SI-87 keeps out:
-- an identifier of a conversation, a message, a task, a review, a send, a
-- run, a job, an exception, a principal or a session; a number in either
-- form; a CRM reference or a provider message id; an actor label; a draft
-- that never left or a message of another class; and no number but the
-- envelope's version and the revision (no event order, sequence or count).
create function pg_temp.sweep(p_label text) returns void
language plpgsql as $f$
declare
  ta    constant uuid := pg_temp.id('tenant_a');
  v_bad text;
begin
  with forbidden (label, value) as (
    select 'conversation id', c.id::text from ops.conversations c where c.tenant_id = ta
    union all select 'number', c.contact_ref from ops.conversations c where c.tenant_id = ta and c.contact_ref ~ '^[0-9]+$'
    union all select 'number', d.device from bi_devices d
    union all select 'national number', substr(d.device, 3) from bi_devices d
    union all select 'message id', m.id::text from ops.inbound_messages m where m.tenant_id = ta
    union all select 'task id', t.id::text from ops.tasks t where t.tenant_id = ta
    union all select 'review id', r.id::text from ops.review_items r where r.tenant_id = ta
    union all select 'send id', o.id::text from ops.outbound_messages o where o.tenant_id = ta
    union all select 'run id', r.id::text from ops.agent_runs r where r.tenant_id = ta
    union all select 'job id', j.id::text from ops.jobs j where j.tenant_id = ta
    union all select 'exception id', e.id::text from ops.exceptions e where e.tenant_id = ta
    union all select 'fixture id', i.id::text from bi_ids i where i.name ~ '^(principal|session|user|factor)\.'
    union all select 'marker', x from unnest(array[
      'crm:contact:', 'wamid.', 'principal:', 'policy:fixed-text', 'sentinel-bi-reviewer', 'sentinel-bi-requested-by',
      'bi-person', 'operator-cli', 'company-os-ui', 'SENTINEL-UNSENT-DRAFT', 'SENTINEL-FIXED-HUMAN_HANDOFF_ACK',
      'SENTINEL-FIXED-CLARIFICATION', 'SENTINEL-HEALTH-BODY', 'SENTINEL-SPLIT-HEALTH', 'SENTINEL-SPLIT2-HEALTH',
      'SENTINEL-SPLIT-TEST']) x)
  select string_agg(distinct format('%s carries a %s', o.label, f.label), '; ') into v_bad
    from bi_out o join forbidden f on strpos(o.body::text, f.value) > 0;
  if v_bad is not null then
    raise exception '% (B5): an answer carries what SI-87 keeps out: %', p_label, v_bad;
  end if;
  select string_agg(distinct format('%s %s', o.label, p), ', ') into v_bad
    from bi_out o, pg_temp.number_paths(o.body) p
   where p not in ('.v', '.revision');
  if v_bad is not null then
    raise exception '% (B5): an answer carries a number besides its version and revision: %', p_label, v_bad;
  end if;
  if (select count(*) from bi_out) < 20 then
    raise exception '% (B5): only % answers were swept', p_label, (select count(*) from bi_out);
  end if;
end
$f$;

-- The newest person_reply send of a conversation.
create function pg_temp.last_reply(p_conv uuid) returns ops.outbound_messages
language sql volatile as $$
  select o.* from ops.outbound_messages o
   where o.conversation_id = p_conv and o.authorization_kind = 'person_reply'
   order by o.created_at desc, (select e.seq from ops.events e
                                 where e.idempotency_key = format('review:%s:pending', o.review_item_id)) desc
   limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Setup. Tenant A owns the local CRM for the length of this transaction;
-- tenant B does not.
-- ---------------------------------------------------------------------------

do $$
declare
  c_source constant text := 'browser-inbox-suite';
  ta uuid; tb uuid; ca uuid; da uuid; cb uuid; db uuid;
begin
  update ops.tenants set owns_local_crm = false where owns_local_crm;
  insert into ops.tenants (slug, name, owns_local_crm) values ('bi-test-alpha', 'BI Alpha', true) returning id into ta;
  insert into ops.tenants (slug, name) values ('bi-test-beta', 'BI Beta') returning id into tb;
  perform pg_temp.remember('tenant_a', ta);
  perform pg_temp.remember('tenant_b', tb);
  ca := pg_temp.remember('company_a', ops.create_company(ta, 'inbox-a', 'Inbox A', c_source));
  da := pg_temp.remember('department_a', ops.create_department(ta, ca, 'intake', 'Intake', c_source));
  perform pg_temp.remember('agent_a', ops.create_agent(ta, ca, da, 'front-desk', 'Front Desk', 'Desk assistant', c_source));
  cb := ops.create_company(tb, 'inbox-b', 'Inbox B', c_source);
  db := ops.create_department(tb, cb, 'intake', 'Intake', c_source);
  perform pg_temp.remember('agent_b', ops.create_agent(tb, cb, db, 'front-desk', 'Front Desk B', 'Desk assistant', c_source));

  perform ops.record_model_price(
    'fake', 'bi-model-1', 1.25, 2.5, true, now() - interval '1 minute', now() + interval '1 day',
    'sql suite synthetic price', 'bi-owner', 0.125);
  perform ops.set_spend_limit('global', 1000000000000, 'UTC', 'bi-test: sql suite ceiling', 'bi-owner');
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'bi-test: budget', 'bi-owner', ta);
  perform ops.set_spend_limit('tenant', 1000000000000, 'UTC', 'bi-test: budget', 'bi-owner', tb);

  -- The receptionist's published configuration: the safety and clarification
  -- texts leave on their own; the handoff acknowledgement waits for a person.
  perform ops.publish_agent_configuration(ta, ops.draft_agent_configuration(
    ta, pg_temp.id('agent_a'), 'operating_policy',
    jsonb_build_object('sendMode', 'supervised', 'sanitizerPack', 'health_pt_br.v1', 'contextTurns', 4,
                       'aiDisclosure', 'Synthetic virtual assistant.',
                       'automaticFixedTexts', jsonb_build_array('safety', 'clarification')), 'bi-owner'), 'bi-owner');
  perform ops.publish_agent_configuration(ta, ops.draft_agent_configuration(
    ta, pg_temp.id('agent_a'), 'fixed_messages',
    jsonb_build_object('messages', (select jsonb_object_agg(k, 'Synthetic fixed text ' || k || ' SENTINEL-FIXED-' || upper(k))
                                      from unnest(ops.fixed_message_keys()) k)), 'bi-owner'), 'bi-owner');

  perform pg_temp.remember('channel_a', ops.configure_whatsapp_channel(
    ta, ca, pg_temp.id('agent_a'), '300000000000510', 'test', 'BI test', 'bi-owner'));
  perform pg_temp.remember('channel_b', ops.configure_whatsapp_channel(
    tb, cb, pg_temp.id('agent_b'), '300000000000511', 'test', 'BI test B', 'bi-owner'));
end
$$;

-- Members of tenant A: two principals, each with an authenticator-app factor
-- enrolled two days ago and a session begun three hours ago at level 2, which
-- verified it ten minutes ago. Synthetic, and only in this transaction.
do $$
declare
  v_user    uuid;
  v_factor  uuid;
  v_session uuid;
  v_who     text;
begin
  foreach v_who in array array['m_a', 'm_a2'] loop
    v_user := pg_temp.remember('user.' || v_who, gen_random_uuid());
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                            created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
    values (v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            format('bi-%s@example.test', replace(v_who, '_', '-')), 'x', now(), now(), now(), '{}',
            jsonb_build_object('first_name', 'Synthetic', 'last_name', v_who));
    v_factor := pg_temp.remember('factor.' || v_who, gen_random_uuid());
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (v_factor, v_user, 'bi app', 'totp', 'verified', now() - interval '2 days', now() - interval '2 days',
            'bi-synthetic-secret');
    v_session := pg_temp.remember('session.' || v_who, gen_random_uuid());
    insert into auth.sessions (id, user_id, created_at, updated_at, aal, factor_id)
    values (v_session, v_user, now() - interval '3 hours', now(), 'aal2', v_factor);
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), v_session, 'totp', now() - interval '3 hours', now() - interval '10 minutes');
    perform ops.grant_membership(pg_temp.id('tenant_a'), v_user, 'Synthetic ' || v_who, 'bi-owner',
                                 'synthetic suite member');
    perform pg_temp.remember('principal.' || v_who, (select p.id from ops.principals p where p.subject = v_user));
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The main conversation, built through the gateway's admission and the
-- worker's screening: a priced question the agent answered (sent), a second
-- one whose draft still waits, a crisis whose safety text was delivered on
-- its own, an unclear message whose clarification was blocked because the
-- contact wrote again, a request for a person (its acknowledgement waiting),
-- and an image the store refused while a person held the conversation.
-- ---------------------------------------------------------------------------

do $$
declare
  ta     constant uuid := pg_temp.id('tenant_a');
  v_dev  text := pg_temp.device('main', '  Ana-Maria Souza');
  v      jsonb;
  v_rev  uuid;
  v_out  uuid;
begin
  -- m1: answered by the agent and sent by the operator's send.
  v := pg_temp.receive(v_dev, 'Olá! Quanto custa a primeira sessão? SENTINEL-INBOUND-1', now() - interval '40 minutes');
  perform pg_temp.remember('main.task1', (v ->> 'task_id')::uuid);
  perform pg_temp.remember('main.conv', (v ->> 'conversation_id')::uuid);
  perform pg_temp.remember('main.message1', (select m.id from ops.inbound_messages m where m.task_id = (v ->> 'task_id')::uuid));
  if pg_temp.screen((v ->> 'task_id')::uuid,
                    pg_temp.screening('administrative', 'Olá! Quanto custa a primeira sessão?'),
                    'A primeira sessão custa R$ 200. SENTINEL-AGENT-SENT') <> 'model' then
    raise exception 'setup: m1 was not sent to the model';
  end if;
  select ri.id into v_rev from ops.review_items ri where ri.task_id = (v ->> 'task_id')::uuid;
  perform ops.record_review_decision(ta, v_rev, 'accepted', 'sentinel-bi-reviewer', 'operator-cli', null);
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id,
                                     task_id, status, requested_by, authorized_check)
  values (ta, pg_temp.id('company_a'), pg_temp.id('channel_a'), pg_temp.id('main.conv'), v_rev,
          (v ->> 'task_id')::uuid, 'authorized', 'sentinel-bi-requested-by', '{}'::jsonb)
  returning id into v_out;
  update ops.outbound_messages set status = 'sending', sending_at = now() - interval '38 minutes' where id = v_out;
  perform ops.settle_outbound_send(ta, v_out, 'sent', 'wamid.BI-M1-PROVIDER', null, null);

  -- m1b: the agent's draft, never sent.
  v := pg_temp.receive(v_dev, 'Vocês atendem online? SENTINEL-INBOUND-1B', now() - interval '35 minutes');
  perform pg_temp.remember('main.task1b', (v ->> 'task_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('administrative', 'Vocês atendem online?'),
                         'Sim, atendemos online. SENTINEL-UNSENT-DRAFT');

  -- m2: a crisis; its safety text leaves on its own and is delivered.
  v := pg_temp.receive(v_dev, 'Não quero mais viver. SENTINEL-INBOUND-2', now() - interval '25 minutes');
  perform pg_temp.remember('main.task2', (v ->> 'task_id')::uuid);
  if pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('safety')) <> 'fixed_reply' then
    raise exception 'setup: the crisis was not answered with its fixed text';
  end if;
  select o.id into v_out from ops.outbound_messages o where o.task_id = (v ->> 'task_id')::uuid;
  v := pg_temp.carry(v_out);
  if v ->> 'settle' is distinct from 'sent' then
    raise exception 'setup: the safety text did not leave: %', v;
  end if;
  update ops.outbound_messages set sending_at = now() - interval '24 minutes' where id = v_out;
  v := ops.receive_whatsapp_status('300000000000510', 'wamid.BI-SENT-' || v_out, 'delivered', now(), v_dev, null, null);

  -- m3: unclear; its clarification is authorized, then the contact writes again.
  v := pg_temp.receive(v_dev, 'quero falar com o Bruno SENTINEL-INBOUND-3', now() - interval '15 minutes');
  perform pg_temp.remember('main.task3', (v ->> 'task_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('unknown'));
  select o.id into v_out from ops.outbound_messages o where o.task_id = (v ->> 'task_id')::uuid;
  perform pg_temp.remember('main.clarification', v_out);

  -- m4: a request for a person; the conversation goes to a person.
  v := pg_temp.receive(v_dev, 'Quero falar com uma pessoa, por favor. SENTINEL-INBOUND-4', now() - interval '10 minutes');
  perform pg_temp.remember('main.task4', (v ->> 'task_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('unknown', null, true));

  -- The clarification's job runs now, and finds itself stale.
  v := pg_temp.carry(pg_temp.id('main.clarification'));
  if (select o.status || '/' || o.blocked_reason from ops.outbound_messages o where o.id = pg_temp.id('main.clarification'))
     <> 'blocked/newer_message' then
    raise exception 'setup: the clarification was not blocked as stale: %', v;
  end if;

  -- An image the store refuses on the record, now.
  v := pg_temp.receive(v_dev, null, now());
  if v ->> 'reason' <> 'unsupported_content' then
    raise exception 'setup: the image was not refused as unsupported: %', v;
  end if;
  if (select s.holder from ops.conversation_states s where s.conversation_id = pg_temp.id('main.conv')) <> 'person'
     or (select array_agg(e.kind order by e.kind) from ops.exceptions e
          where e.conversation_id = pg_temp.id('main.conv') and e.resolved_at is null)
        <> array['message_waiting', 'person_requested'] then
    raise exception 'setup: the main conversation is not held by a person with its two episodes';
  end if;
end
$$;

-- Tenant B's own WhatsApp conversation: its task is a stranger to A.
do $$
declare
  v jsonb;
begin
  perform ops.register_test_sender(pg_temp.id('tenant_b'), pg_temp.id('channel_b'), '5511987659901', 'bi-owner');
  v := ops.receive_whatsapp_message('300000000000511', 'wamid.BI-B-1', '5511987659901',
                                    'Quero falar com uma pessoa.', now() - interval '5 minutes');
  perform pg_temp.remember('b.task', (v ->> 'task_id')::uuid);
end
$$;

-- ===========================================================================
-- A. THE CATALOGUE, pinned from the live database.
-- ===========================================================================

do $$
declare
  v_bad text;
begin
  -- A1. Every inbox callee and helper, and every function this slice
  --     replaced but the worker's two: a pinned INVOKER, owned by postgres,
  --     of its volatility, that no role executes.
  select string_agg(p.sig, ', ') into v_bad
    from (values ('ops.cos_inbox_conversation(uuid,uuid)', 's'), ('ops.cos_conversation_visible(uuid,uuid)', 's'),
                 ('ops.cos_conversation_waiting(uuid,uuid)', 's'), ('ops.cos_conversation_first_name(uuid,uuid)', 's'),
                 ('ops.cos_message_do_not_contact(uuid,uuid)', 's'),
                 ('ops.cos_person_reply_refusal(uuid,uuid,integer)', 's'), ('ops.cos_conversation_turns(uuid,uuid)', 's'),
                 ('ops.read_conversation(uuid,uuid)', 's'), ('ops.operator_second_factor_recent()', 's'),
                 ('ops.review_is_person_reply(ops.review_items)', 's'),
                 ('ops.person_reply_waits_for_earlier(ops.outbound_messages)', 's'),
                 ('ops.inbox_preflight(uuid,uuid,integer,text)', 'v'),
                 ('ops.open_person_reply_review(uuid,uuid,text,text,integer,text)', 'v'),
                 ('ops.authorize_person_reply(uuid,text,jsonb)', 'v'),
                 ('ops.reply_to_conversation_as_member(uuid,text,uuid,text,integer)', 'v'),
                 ('ops.release_conversation_as_member(uuid,text,uuid,integer)', 'v'),
                 ('ops.record_person_reply(uuid,uuid,text,text,integer)', 'v'),
                 ('ops.open_scripted_review(ops.agent_runs,text,text,text,text)', 'v'),
                 ('ops.guard_outbound_message()', 'v'), ('ops.sync_send_exceptions(uuid,uuid,text)', 'v')) p (sig, vol)
    left join pg_proc f on f.oid = to_regprocedure(p.sig)
   where f.oid is null or f.prosecdef or pg_get_userbyid(f.proowner) <> 'postgres'
      or f.proconfig is distinct from array['search_path=""'] or f.provolatile <> p.vol
      or f.proacl is null or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0)
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway',
                                            'ops_operator_api']) r
                  where has_function_privilege(r, f.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A1: an inbox function is missing, reachable, not a pinned INVOKER or of the wrong volatility: %', v_bad;
  end if;

  -- A2. The worker's two reply-send capabilities: pinned DEFINERs only the
  --     worker executes.
  select string_agg(p.sig, ', ') into v_bad
    from (values ('ops.begin_reply_send(text)'), ('ops.settle_stale_reply_sends()')) p (sig)
    left join pg_proc f on f.oid = to_regprocedure(p.sig)
   where f.oid is null or not f.prosecdef or f.proconfig is distinct from array['search_path=""']
      or not has_function_privilege('ops_worker', f.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0)
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'ops_gateway', 'ops_operator_api']) r
                  where has_function_privilege(r, f.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A2: a reply-send capability is not a pinned DEFINER the worker alone executes: %', v_bad;
  end if;

  -- A3. The three gates: DEFINERs only ops_operator_api executes, the acts
  --     bounded (2 s) and VOLATILE, the read STABLE and unbounded; and
  --     ops_operator_api executes exactly the 24 gates.
  select string_agg(p.sig, ', ') into v_bad
    from (values ('ops.gate_get_conversation(uuid)', 's', array['search_path=""']),
                 ('ops.gate_reply_to_conversation(uuid,text,integer)', 'v', array['search_path=""', 'lock_timeout=2s']),
                 ('ops.gate_release_conversation(uuid,integer)', 'v', array['search_path=""', 'lock_timeout=2s'])) p (sig, vol, cfg)
    left join pg_proc f on f.oid = to_regprocedure(p.sig)
   where f.oid is null or not f.prosecdef or f.provolatile <> p.vol or f.proconfig is distinct from p.cfg
      or pg_get_userbyid(f.proowner) <> 'postgres'
      or not has_function_privilege('ops_operator_api', f.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0)
      or exists (select 1 from unnest(array['anon', 'authenticated', 'service_role', 'ops_worker', 'ops_gateway']) r
                  where has_function_privilege(r, f.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A3: an inbox gate is not exactly pinned: %', v_bad;
  end if;
  if (select count(*) from pg_proc f
       where f.pronamespace = 'ops'::regnamespace and has_function_privilege('ops_operator_api', f.oid, 'EXECUTE')) <> 24
     or exists (select 1 from pg_proc f
                 where f.pronamespace = 'ops'::regnamespace and f.proname !~ '^gate_'
                   and has_function_privilege('ops_operator_api', f.oid, 'EXECUTE')) then
    raise exception 'A3: ops_operator_api does not execute exactly the 24 gates';
  end if;

  -- A4. The three exposed functions: owned by ops_operator_api, executable by
  --     authenticated alone among the application roles, each one call to
  --     its own gate.
  select string_agg(p.sig, ', ') into v_bad
    from (values ('company_os_api.get_conversation(uuid)', 's', 'gate_get_conversation'),
                 ('company_os_api.reply_to_conversation(uuid,text,integer)', 'v', 'gate_reply_to_conversation'),
                 ('company_os_api.release_conversation(uuid,integer)', 'v', 'gate_release_conversation')) p (sig, vol, gate)
    left join pg_proc f on f.oid = to_regprocedure(p.sig)
   where f.oid is null or not f.prosecdef or f.provolatile <> p.vol
      or pg_get_userbyid(f.proowner) <> 'ops_operator_api'
      or f.prosrc !~ ('^\s*select ops\.' || p.gate || '\(')
      or not has_function_privilege('authenticated', f.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(f.proacl) a where a.grantee = 0)
      or exists (select 1 from unnest(array['anon', 'service_role', 'ops_worker', 'ops_gateway']) r
                  where has_function_privilege(r, f.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'A4: an exposed inbox function is not exactly pinned: %', v_bad;
  end if;

  -- A5. The send table: the person_reply kind, its shape, and the guard
  --     enabled always.
  if pg_get_constraintdef((select c.oid from pg_constraint c
                            where c.conrelid = 'ops.outbound_messages'::regclass
                              and c.conname = 'outbound_messages_authorization_kind_check')) !~ 'person_reply'
     or (select t.tgenabled from pg_trigger t
          where t.tgrelid = 'ops.outbound_messages'::regclass and t.tgname = 'outbound_messages_guard') <> 'A' then
    raise exception 'A5: the send table does not hold the person_reply kind under its always-enabled guard';
  end if;
end
$$;

-- A6. The shape check alone (the guard set aside inside a subtransaction that
--     is rolled back, which also gives its lock back): a person_reply row
--     names its job and its bound, and never a fixed text's key or version.
do $$
declare
  ta    constant uuid := pg_temp.id('tenant_a');
  v_job uuid;
  v_rev uuid;
  v_got text[] := array[]::text[];
  v_case record;
begin
  select ri.id into v_rev from ops.review_items ri where ri.task_id = pg_temp.id('main.task1b');
  begin
    alter table ops.outbound_messages disable trigger outbound_messages_guard;
    v_job := ops.enqueue_job(ta, 'outbound.reply_send', jsonb_build_object('outbound_message_id', gen_random_uuid()));
    for v_case in
      select * from (values
        ('complete', v_job, now() + interval '1 hour', null::text),
        ('no job', null::uuid, now() + interval '1 hour', null),
        ('no bound', v_job, null::timestamptz, null),
        ('a key', v_job, now() + interval '1 hour', 'safety')) c (label, job, fresh, fixed_key)
    loop
      begin
        insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
                                           status, requested_by, authorized_check, authorization_kind, job_id,
                                           fresh_until, fixed_text_key)
        values (ta, pg_temp.id('company_a'), pg_temp.id('channel_a'), pg_temp.id('main.conv'), v_rev,
                pg_temp.id('main.task1'), 'authorized', 'principal:' || gen_random_uuid(), '{}', 'person_reply',
                v_case.job, v_case.fresh, v_case.fixed_key);
        v_got := v_got || (v_case.label || ':accepted');
        raise exception using errcode = 'C1CAC', message = 'undo';
      exception
        when sqlstate 'C1CAC' then null;
        when check_violation then v_got := v_got || (v_case.label || ':refused');
      end;
    end loop;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_got <> array['complete:accepted', 'no job:refused', 'no bound:refused', 'a key:refused'] then
    raise exception 'A6: the person_reply shape is not exactly a job and a bound, no key: %', v_got;
  end if;
  if (select t.tgenabled from pg_trigger t
       where t.tgrelid = 'ops.outbound_messages'::regclass and t.tgname = 'outbound_messages_guard') <> 'A' then
    raise exception 'A6: the guard stayed set aside';
  end if;
end
$$;

-- ===========================================================================
-- B. get_conversation (SI-87, the read).
-- ===========================================================================

-- B1, B2. The available answer: its exact keys, and its turns in the order
--     shown, each kind as SI-87 states it; what never left is absent.
do $$
declare
  v       jsonb := pg_temp.read('B1 main', pg_temp.id('main.task1'));
  v_turns jsonb := v -> 'turns';
  v_paths text[];
  v_conv  ops.conversations;
begin
  select array_agg(distinct x order by x) into v_paths from pg_temp.key_paths(v) x;
  if v_paths <> array['.allowedActs', '.allowedActs.release', '.allowedActs.reply', '.asOf', '.earlierTurns',
                      '.firstName', '.holder', '.lastMessageAt', '.optOutOpen', '.replyUnavailable', '.revision',
                      '.status', '.turns', '.turns[].at', '.turns[].author', '.turns[].automatic', '.turns[].delivery',
                      '.turns[].fixedKey', '.turns[].hidden', '.turns[].kind', '.turns[].reason', '.turns[].text',
                      '.turns[].withPrivacyNotice', '.v', '.windowEndsAt'] then
    raise exception 'B1: the available answer''s keys are %', v_paths;
  end if;
  select * into v_conv from ops.conversations where id = pg_temp.id('main.conv');
  if v ->> 'status' <> 'available' or (v ->> 'revision')::int <> 6 or v ->> 'holder' <> 'person'
     or (v ->> 'optOutOpen')::boolean or v ->> 'firstName' <> 'Ana-Maria'
     or v ->> 'lastMessageAt' <> ops.cos_ts(v_conv.last_inbound_at)
     or v ->> 'windowEndsAt' <> ops.cos_ts(v_conv.last_inbound_at + interval '24 hours')
     or v -> 'allowedActs' <> '{"reply": true, "release": true}'::jsonb
     or v -> 'replyUnavailable' <> 'null'::jsonb or (v ->> 'earlierTurns')::boolean then
    raise exception 'B1: the available answer is not as the conversation stands: %', v - 'turns';
  end if;

  if (select array_agg(t ->> 'kind' order by i) from jsonb_array_elements(v_turns) with ordinality x (t, i))
       <> array['inbound', 'reply', 'inbound', 'inbound', 'reply', 'inbound', 'inbound', 'refused']
     or exists (select 1 from jsonb_array_elements(v_turns) with ordinality a (t, i)
                  join jsonb_array_elements(v_turns) with ordinality b (t, i) on b.i = a.i + 1
                 where (a.t ->> 'at') > (b.t ->> 'at')) then
    raise exception 'B2: the turns are not in the order shown: %', v_turns;
  end if;
  if v_turns -> 0 <> jsonb_build_object('kind', 'inbound', 'at', v_turns -> 0 -> 'at', 'hidden', null,
                                        'text', 'Olá! Quanto custa a primeira sessão? SENTINEL-INBOUND-1')
     or v_turns -> 1 <> jsonb_build_object('kind', 'reply', 'at', v_turns -> 1 -> 'at', 'author', 'agent',
                                           'fixedKey', null, 'automatic', false, 'hidden', null, 'delivery', 'sent',
                                           'reason', null, 'withPrivacyNotice', false,
                                           'text', 'A primeira sessão custa R$ 200. SENTINEL-AGENT-SENT')
     or v_turns -> 4 <> jsonb_build_object('kind', 'reply', 'at', v_turns -> 4 -> 'at', 'author', 'fixed',
                                           'fixedKey', 'safety', 'automatic', true, 'hidden', null,
                                           'delivery', 'delivered', 'reason', null, 'withPrivacyNotice', false,
                                           'text', 'Synthetic fixed text safety SENTINEL-FIXED-SAFETY')
     or v_turns -> 7 <> jsonb_build_object('kind', 'refused', 'at', v_turns -> 7 -> 'at',
                                           'reason', 'unsupported_content')
     or v_turns -> 6 ->> 'text' <> 'Quero falar com uma pessoa, por favor. SENTINEL-INBOUND-4' then
    raise exception 'B2: a turn is not as SI-87 states it: %', v_turns;
  end if;
  -- A draft that never left (the agent's, the waiting acknowledgement, the
  -- clarification blocked as stale) is no turn.
  if v_turns::text ~ '(SENTINEL-UNSENT-DRAFT|SENTINEL-FIXED-HUMAN_HANDOFF_ACK|SENTINEL-FIXED-CLARIFICATION)' then
    raise exception 'B2: a draft that never left is a turn';
  end if;
end
$$;

-- B2b. A reply that left with no draft of 1 to 2000 characters on its review
--      shows no text and says it is withheld, so the answer still parses.
do $$
declare
  v_review uuid;
  v        jsonb;
begin
  select o.review_item_id into strict v_review
    from ops.outbound_messages o join ops.review_items ri on ri.id = o.review_item_id
   where o.conversation_id = pg_temp.id('main.conv') and ri.author = 'agent' and o.status = 'sent';
  begin
    alter table ops.review_items disable trigger review_items_guard_update;
    update ops.review_items set proposed = proposed - 'response_draft' where id = v_review;
    alter table ops.review_items enable always trigger review_items_guard_update;
    v := pg_temp.read('B2b no draft', pg_temp.id('main.task1'));
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v -> 'turns' -> 1 ->> 'kind' is distinct from 'reply' or v -> 'turns' -> 1 -> 'text' is distinct from 'null'::jsonb
     or v -> 'turns' -> 1 ->> 'hidden' is distinct from 'withheld' then
    raise exception 'B2b: a reply with no draft is %', v -> 'turns' -> 1;
  end if;
end
$$;

-- B3. The last 50 of 55 turns, oldest first, and that earlier ones exist.
do $$
declare
  v_dev text := pg_temp.device('many');
  v     jsonb;
begin
  v := pg_temp.receive(v_dev, 'Mensagem 1: quero falar com uma pessoa.', now() - interval '60 minutes');
  perform pg_temp.remember('many.task', (v ->> 'task_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('unknown', null, true));
  for i in 2 .. 55 loop
    perform pg_temp.receive(v_dev, 'Mensagem ' || i, now() - make_interval(mins => 61 - i));
  end loop;
  v := pg_temp.read('B3 many', pg_temp.id('many.task'));
  if jsonb_array_length(v -> 'turns') <> 50 or not (v ->> 'earlierTurns')::boolean
     or v -> 'turns' -> 0 ->> 'text' <> 'Mensagem 6' or v -> 'turns' -> 49 ->> 'text' <> 'Mensagem 55' then
    raise exception 'B3: 55 turns did not give the newest 50, oldest first, with earlier ones flagged: % turns, % ... %',
      jsonb_array_length(v -> 'turns'), v -> 'turns' -> 0, v -> 'turns' -> 49;
  end if;
end
$$;

-- B4. The first word of the CRM first name: letters, hyphens and
--     apostrophes, leading hyphens and apostrophes stripped, at most 40, null
--     when nothing is left; read as the CRM holds it now; null without a
--     CRM contact, and never for a conversation whose newest message is not
--     of test data.
do $$
declare
  v_case record;
  v_got  jsonb;
begin
  for v_case in
    select * from (values
      (repeat('a', 41) || ' Souza', to_jsonb(repeat('a', 40))),
      ('1234', 'null'::jsonb),
      ('-Çağla2 X', '"Çağla"'::jsonb),
      (E'\nMaria\tClara', '"Maria"'::jsonb),
      ('O''Brien', '"O''Brien"'::jsonb),
      ('   ', 'null'::jsonb),
      ('  Ana-Maria Souza', '"Ana-Maria"'::jsonb)) c (stored, shown)
  loop
    update public.contacts set first_name = v_case.stored where id = pg_temp.contact_of('main');
    v_got := pg_temp.read('B4 name', pg_temp.id('main.task1')) -> 'firstName';
    if v_got is distinct from v_case.shown then
      raise exception 'B4: the first name % is shown as %, expected %', to_jsonb(v_case.stored), v_got, v_case.shown;
    end if;
  end loop;
  -- No CRM contact for the number.
  perform pg_temp.waiting('nf', null);
  if pg_temp.read('B4 not found', pg_temp.id('nf.task')) -> 'firstName' <> 'null'::jsonb then
    raise exception 'B4: a number the CRM does not know has a first name';
  end if;
end
$$;

-- B6, B7. A conversation that is not test data, or whose number was erased,
--     is withheld; one no longer waiting is not_waiting: states, never a
--     refusal, and nothing else.
do $$
declare
  v_dev text := pg_temp.device('health', 'Bia', false);
  v     jsonb;
begin
  -- An unregistered number on the test line: health, never shown.
  v := pg_temp.receive(v_dev, 'Quero falar com uma pessoa. SENTINEL-HEALTH-BODY');
  perform pg_temp.remember('health.task', (v ->> 'task_id')::uuid);
  perform pg_temp.remember('health.conv', (v ->> 'conversation_id')::uuid);
  if (select t.data_class from ops.tasks t where t.id = pg_temp.id('health.task')) <> 'health' then
    raise exception 'setup: an unregistered number''s message is not of the health class';
  end if;
  v := pg_temp.read('B6 health', pg_temp.id('health.task'));
  if v - 'asOf' <> '{"v": 1, "status": "withheld", "reason": "not_test"}'::jsonb then
    raise exception 'B6: a health conversation answered %', v;
  end if;

  -- An erased number.
  perform pg_temp.waiting('erased');
  perform ops.erase_contact_identifier(pg_temp.id('tenant_a'), pg_temp.id('erased.conv'), 'erasure', 'bi-owner');
  v := pg_temp.read('B6 erased', pg_temp.id('erased.task'));
  if v - 'asOf' <> '{"v": 1, "status": "withheld", "reason": "erased"}'::jsonb then
    raise exception 'B6: an erased conversation answered %', v;
  end if;

  -- The test line moved to production (inactive), inside a subtransaction.
  begin
    perform ops.configure_whatsapp_channel(pg_temp.id('tenant_a'), pg_temp.id('company_a'), pg_temp.id('agent_a'),
                                           '300000000000510', 'production', 'BI test', 'bi-owner', false);
    v := pg_temp.read('B6 production', pg_temp.id('main.task1'));
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v - 'asOf' <> '{"v": 1, "status": "withheld", "reason": "not_test"}'::jsonb then
    raise exception 'B6: a conversation on a production line answered %', v;
  end if;

  -- Released by the owner: no longer waiting.
  perform pg_temp.waiting('released');
  perform ops.release_conversation(pg_temp.id('tenant_a'), pg_temp.id('released.conv'), 'bi-person');
  v := pg_temp.read('B7 released', pg_temp.id('released.task'));
  if v - 'asOf' <> '{"v": 1, "status": "not_waiting"}'::jsonb then
    raise exception 'B7: a released conversation answered %', v;
  end if;

  -- Only a request for a person or a waiting message makes it wait: a number
  -- the CRM does not know stays listed for a person after the release, and
  -- the conversation is not waiting.
  perform pg_temp.waiting('unknown', null);
  perform ops.release_conversation(pg_temp.id('tenant_a'), pg_temp.id('unknown.conv'), 'bi-person');
  if not exists (select 1 from ops.exceptions e
                  where e.conversation_id = pg_temp.id('unknown.conv') and e.kind = 'contact_unresolved'
                    and e.resolved_at is null) then
    raise exception 'setup: the unknown number''s conversation has no other open exception';
  end if;
  v := pg_temp.read('B7 another exception', pg_temp.id('unknown.task'));
  if v - 'asOf' <> '{"v": 1, "status": "not_waiting"}'::jsonb then
    raise exception 'B7: a conversation with only another open exception answered %', v;
  end if;
end
$$;

-- B8. One OS404, byte-identical to a random uuid's, for another tenant's
--     task, a task of no conversation, a review id and a run id.
do $$
declare
  v_random jsonb := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.get_conversation(%L)', gen_random_uuid()));
  v_ref    uuid;
  v_got    jsonb;
begin
  if v_random ->> 'code' <> 'OS404' or v_random ->> 'message' <> 'company_os_api.get_conversation: not found' then
    raise exception 'B8: a random uuid answered %', v_random;
  end if;
  foreach v_ref in array array[
      pg_temp.id('b.task'),
      ops.create_task(pg_temp.id('tenant_a'), pg_temp.id('company_a'), 'crm.follow_up', 'Plain follow-up', 'bi-suite'),
      (select ri.id from ops.review_items ri where ri.task_id = pg_temp.id('main.task1')),
      (select m.agent_run_id from ops.inbound_messages m where m.task_id = pg_temp.id('main.task1')),
      pg_temp.id('main.conv'), pg_temp.id('main.message1')] loop
    v_got := pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.get_conversation(%L)', v_ref));
    if v_got is distinct from v_random then
      raise exception 'B8: % answered unlike a random uuid: %', v_ref, v_got;
    end if;
  end loop;
end
$$;

-- B9. A conversation split between classes: a newer message of another
--     class withholds the whole conversation; an older one shows as withheld
--     alone.
do $$
declare
  v_dev text := pg_temp.device('split');
  v     jsonb;
begin
  v := pg_temp.receive(v_dev, 'Quero falar com uma pessoa. SENTINEL-SPLIT-TEST', now() - interval '20 minutes');
  perform pg_temp.remember('split.task', (v ->> 'task_id')::uuid);
  perform pg_temp.remember('split.conv', (v ->> 'conversation_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('unknown', null, true));
  perform ops.retire_test_sender(pg_temp.id('split.sender'), 'bi-test: the device is lent out', 'bi-owner');
  perform pg_temp.receive(v_dev, 'Outra mensagem. SENTINEL-SPLIT-HEALTH', now() - interval '10 minutes');
  v := pg_temp.read('B9 newer health', pg_temp.id('split.task'));
  if v - 'asOf' <> '{"v": 1, "status": "withheld", "reason": "not_test"}'::jsonb then
    raise exception 'B9: a conversation whose newest message is health answered %', v;
  end if;
  if ops.cos_conversation_first_name(pg_temp.id('tenant_a'), pg_temp.id('split.conv')) is not null then
    raise exception 'B9: a conversation whose newest message is health has a first name';
  end if;

  -- The reverse: an older health message, a newer test one.
  v_dev := pg_temp.device('split2', 'Bia', false);
  perform pg_temp.receive(v_dev, 'Primeira mensagem. SENTINEL-SPLIT2-HEALTH', now() - interval '20 minutes');
  perform ops.register_test_sender(pg_temp.id('tenant_a'), pg_temp.id('channel_a'), v_dev, 'bi-owner');
  v := pg_temp.receive(v_dev, 'Quero falar com uma pessoa. SENTINEL-SPLIT2-TEST', now() - interval '10 minutes');
  perform pg_temp.remember('split2.task', (v ->> 'task_id')::uuid);
  perform pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('unknown', null, true));
  v := pg_temp.read('B9 older health', pg_temp.id('split2.task'));
  if v ->> 'status' <> 'available' or jsonb_array_length(v -> 'turns') <> 2
     or v -> 'turns' -> 0 <> jsonb_build_object('kind', 'inbound', 'at', v -> 'turns' -> 0 -> 'at', 'text', null,
                                                'hidden', 'withheld')
     or v -> 'turns' -> 1 ->> 'text' <> 'Quero falar com uma pessoa. SENTINEL-SPLIT2-TEST' then
    raise exception 'B9: an older health turn is not withheld alone: %', v;
  end if;
end
$$;

-- B10. The read writes nothing: this backend's own writes are the same
--      after a read of every state.
do $$
declare
  v_before jsonb := pg_temp.own_writes();
  v_task   uuid;
begin
  if coalesce((v_before ->> 'ops.events')::bigint, 0) = 0 then
    raise exception 'B10: the write counters show none of the setup''s events, so they would prove nothing';
  end if;
  foreach v_task in array array[pg_temp.id('main.task1'), pg_temp.id('main.task4'), pg_temp.id('health.task'),
                                pg_temp.id('erased.task'), pg_temp.id('released.task'), pg_temp.id('split.task'),
                                pg_temp.id('many.task')] loop
    perform pg_temp.read('B10', v_task);
  end loop;
  perform pg_temp.api(pg_temp.claims('m_a'), format('company_os_api.get_conversation(%L)', gen_random_uuid()));
  if v_before is distinct from pg_temp.own_writes() then
    raise exception 'B10: a read wrote: before %, after %', v_before, pg_temp.own_writes();
  end if;
end
$$;

do $$ begin perform pg_temp.sweep('B'); end $$;

-- ===========================================================================
-- C. reply_to_conversation (SI-87, the act). Every refusal is an answer
--    state that writes nothing, and agrees with what the read offered (B11).
-- ===========================================================================

-- C1. Queued: one person review the principal accepted, at the revision the
--     member saw, one person_reply send request and its one queued job, each
--     fact of source company-os-ui; the answer names the revision.
do $$
declare
  ta      constant uuid := pg_temp.id('tenant_a');
  v_task  uuid := pg_temp.waiting('c1', 'Clara');
  v_conv  uuid := pg_temp.id('c1.conv');
  c_text  constant text := 'Olá, aqui é a equipe da clínica. SENTINEL-PERSON-C1';
  v_read  jsonb := pg_temp.read('C1 before', v_task);
  v       jsonb;
  v_rev   ops.review_items;
  v_out   ops.outbound_messages;
  v_job   ops.jobs;
  v_paths text[];
begin
  if v_read -> 'allowedActs' <> '{"reply": true, "release": true}'::jsonb or v_read -> 'replyUnavailable' <> 'null'::jsonb then
    raise exception 'B11: a conversation the reply is queued for was not offered it: %', v_read - 'turns';
  end if;
  v := pg_temp.reply(v_task, c_text, (v_read ->> 'revision')::int);
  if pg_temp.answer(v) <> '{"v": 1, "outcome": "queued", "revision": 1, "reason": null}'::jsonb then
    raise exception 'C1: the reply answered %', v;
  end if;
  select array_agg(x order by x) into v_paths from pg_temp.key_paths(v -> 'body') x;
  if v_paths <> array['.asOf', '.outcome', '.reason', '.revision', '.v'] then
    raise exception 'C1: the reply''s answer has the keys %', v_paths;
  end if;

  select ri.* into v_rev from ops.review_items ri
   where ri.tenant_id = ta and ri.task_id = v_task and ri.author = 'person';
  select o.* into v_out from ops.outbound_messages o where o.review_item_id = v_rev.id;
  select j.* into v_job from ops.jobs j where j.id = v_out.job_id;
  if v_rev.id is null or v_rev.status <> 'accepted' or v_rev.decision_basis <> 'person'
     or v_rev.reviewer <> 'principal:' || pg_temp.id('principal.m_a') or v_rev.conversation_revision <> 1
     or v_rev.proposed ->> 'response_draft' <> c_text
     or v_rev.agent_run_id <> (select m.agent_run_id from ops.inbound_messages m where m.task_id = v_task)
     or (select count(*) from ops.review_items ri where ri.task_id = v_task and ri.author = 'person') <> 1 then
    raise exception 'C1: the person review is not as the act records it: %', to_jsonb(v_rev);
  end if;
  if v_out.id is null or v_out.status <> 'authorized' or v_out.authorization_kind <> 'person_reply'
     or v_out.requested_by <> v_rev.reviewer or v_out.conversation_id <> v_conv or v_out.task_id <> v_task
     or v_out.channel_id <> pg_temp.id('channel_a') or v_out.fixed_text_key is not null
     or v_out.fixed_messages_version_id is not null or v_out.transport is not null
     or v_out.fresh_until <> (select c.last_inbound_at + interval '24 hours' from ops.conversations c where c.id = v_conv) then
    raise exception 'C1: the send request is not as the act records it: %', to_jsonb(v_out);
  end if;
  if v_job.kind <> 'outbound.reply_send' or v_job.status <> 'queued' or v_job.max_attempts <> 5
     or v_job.payload <> jsonb_build_object('outbound_message_id', v_out.id)
     or v_job.idempotency_key <> format('reply_send:%s', v_out.id)
     or (select count(*) from ops.jobs j where j.tenant_id = ta and j.kind = 'outbound.reply_send'
                                          and j.payload ->> 'outbound_message_id' = v_out.id::text) <> 1 then
    raise exception 'C1: the reply job is not as the act queues it: %', to_jsonb(v_job);
  end if;
  if (select array_agg(e.type || '/' || e.source order by e.seq) from ops.events e
       where e.tenant_id = ta and (e.payload ->> 'review_item_id' = v_rev.id::text))
     <> array['lead_triage.review_pending/company-os-ui', 'lead_triage.reviewed/company-os-ui',
              'communication.outbound_authorized/company-os-ui'] then
    raise exception 'C1: the act''s facts are not one each, of source company-os-ui';
  end if;

  -- The member sees their own reply queued.
  v := pg_temp.read('C1 after', v_task);
  if (select count(*) from jsonb_array_elements(v -> 'turns') t
       where t = jsonb_build_object('kind', 'reply', 'at', t -> 'at', 'author', 'person', 'fixedKey', null,
                                    'automatic', false, 'text', c_text, 'hidden', null, 'delivery', 'queued',
                                    'reason', null, 'withPrivacyNotice', false)) <> 1 then
    raise exception 'C1: the member''s own reply is not shown queued: %', v -> 'turns';
  end if;
end
$$;

-- C18. The same member asking again for the same text at the same revision
--      (a second click, a resubmit after a lost answer) is answered with what
--      it recorded, writing nothing; C17, another member's own reply at the
--      same revision is their own, queued.
do $$
declare
  v_task   constant uuid := pg_temp.id('c1.task');
  v_before jsonb := pg_temp.own_writes();
  v        jsonb;
begin
  v := pg_temp.reply(v_task, 'Olá, aqui é a equipe da clínica. SENTINEL-PERSON-C1', 1);
  if pg_temp.answer(v) <> '{"v": 1, "outcome": "already_recorded", "revision": 1, "reason": null}'::jsonb then
    raise exception 'C18: a repeated reply answered %', v;
  end if;
  perform pg_temp.refused('C18', v, 'already_recorded', null, v_before);

  v := pg_temp.reply(v_task, 'Oi! Aqui é a Bruna. SENTINEL-PERSON-C17', 1, 'm_a2');
  perform pg_temp.refused('C17', v, 'queued');
  if (select array_agg(ri.reviewer order by ri.reviewer) from ops.review_items ri
       where ri.task_id = v_task and ri.author = 'person')
       <> (select array_agg('principal:' || pg_temp.id(p) order by 'principal:' || pg_temp.id(p))
             from unnest(array['principal.m_a', 'principal.m_a2']) p)
     or (select count(distinct o.job_id) from ops.outbound_messages o
           join ops.review_items ri on ri.id = o.review_item_id
          where ri.task_id = v_task and ri.author = 'person' and o.requested_by = ri.reviewer) <> 2 then
    raise exception 'C17: two members'' replies are not each their own, with its own job';
  end if;
end
$$;

-- C15. A malformed request is OS400, before anything is read: an empty or
--      blank text, more than 2000 characters, a control character but the
--      line break, a negative revision.
do $$
declare
  v_task constant uuid := pg_temp.id('c1.task');
  v_case record;
  v      jsonb;
begin
  for v_case in
    select * from (values ('', 1), ('   ', 1), (repeat('x', 2001), 1), ('a' || chr(9) || 'b', 1),
                          ('a' || chr(13) || 'b', 1), ('a' || chr(127) || 'b', 1), ('a' || chr(133) || 'b', 1),
                          ('a' || chr(159) || 'b', 1), ('Oi', -1)) c (body, rev)
  loop
    v := pg_temp.reply(v_task, v_case.body, v_case.rev);
    if v - 'hint' - 'detail' <> '{"ok": false, "code": "OS400", "message": "company_os_api.reply_to_conversation: bad request"}'::jsonb then
      raise exception 'C15: % (revision %) answered %', to_jsonb(left(v_case.body, 20)), v_case.rev, v;
    end if;
  end loop;
  -- A line break is the one control character a reply may carry.
  perform pg_temp.refused('C15 a line break', pg_temp.reply(v_task, 'Linha um.' || chr(10) || 'Linha dois.', 1), 'queued');
end
$$;

-- C7. Stale: the contact wrote after the member read the conversation (a
--     message the store refused moves the revision too).
do $$
declare
  v_task   constant uuid := pg_temp.id('c1.task');
  v_before jsonb;
begin
  perform pg_temp.receive(pg_temp.device_of('c1'), null);
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C7', pg_temp.reply(v_task, 'Uma resposta atrasada.', 1), 'stale', null, v_before);
  if pg_temp.answer(pg_temp.reply(v_task, 'Uma resposta atrasada.', 1)) ->> 'revision' <> '2' then
    raise exception 'C7: a stale reply does not name the revision now';
  end if;
end
$$;

-- C1b. Any task of the conversation reaches it: through the oldest message's
--      task, the reply answers the newest message.
do $$
declare
  v_before int := (select count(*) from ops.review_items ri where ri.task_id = pg_temp.id('main.task4') and ri.author = 'person');
begin
  perform pg_temp.refused('C1b', pg_temp.reply(pg_temp.id('main.task1'), 'Resposta pela tarefa mais antiga.', 6), 'queued');
  if (select count(*) from ops.review_items ri where ri.task_id = pg_temp.id('main.task4') and ri.author = 'person')
     <> v_before + 1 then
    raise exception 'C1b: a reply through an older task did not answer the newest message';
  end if;
end
$$;

-- C2 to C6. The second factor: the caller's own session must have verified,
--     within the hour, an authenticator-app factor the user had before the
--     session began. Without the non-production exemption (deleted inside a
--     subtransaction that is rolled back), anything less answers
--     second_factor_required, before the ref is read, writing nothing.
do $$
declare
  v_task   uuid := pg_temp.waiting('c2f');
  s1       constant uuid := pg_temp.id('session.m_a');
  v_before jsonb;
  v_queued jsonb;
begin
  begin
    delete from ops.operator_assurance_exemption;
    -- C2: no claim at all; an unknown ref answers the same.
    delete from auth.mfa_amr_claims where session_id = s1;
    v_before := pg_temp.own_writes();
    perform pg_temp.refused('C2 no claim', pg_temp.reply(v_task, 'Oi.', 1), 'second_factor_required', null, v_before);
    if pg_temp.answer(pg_temp.reply(v_task, 'Oi.', 1)) <> '{"v": 1, "outcome": "second_factor_required", "revision": null, "reason": null}'::jsonb
       or pg_temp.answer(pg_temp.reply(gen_random_uuid(), 'Oi.', 1))
          <> '{"v": 1, "outcome": "second_factor_required", "revision": null, "reason": null}'::jsonb then
      raise exception 'C2: a missing factor did not answer second_factor_required before the ref';
    end if;
    -- C3: verified 61 minutes ago.
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), s1, 'totp', now() - interval '3 hours', now() - interval '61 minutes');
    v_before := pg_temp.own_writes();
    perform pg_temp.refused('C3 stale claim', pg_temp.reply(v_task, 'Oi.', 1), 'second_factor_required', null, v_before);
    -- C4: a fresh claim of another method.
    update auth.mfa_amr_claims set authentication_method = 'password', updated_at = now() where session_id = s1;
    v_before := pg_temp.own_writes();
    perform pg_temp.refused('C4 password', pg_temp.reply(v_task, 'Oi.', 1), 'second_factor_required', null, v_before);
    -- C5: another session of the same user verified just now.
    insert into auth.sessions (id, user_id, created_at, updated_at, aal, factor_id)
    values (pg_temp.remember('session.m_a_other', gen_random_uuid()), pg_temp.id('user.m_a'), now() - interval '1 hour',
            now(), 'aal2', pg_temp.id('factor.m_a'));
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), pg_temp.id('session.m_a_other'), 'totp', now(), now());
    v_before := pg_temp.own_writes();
    perform pg_temp.refused('C5 another session', pg_temp.reply(v_task, 'Oi.', 1), 'second_factor_required', null, v_before);
    -- C5b: a factor enrolled during the session (as a stolen session could)
    --      and verified just now.
    insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret)
    values (pg_temp.remember('factor.m_a_new', gen_random_uuid()), pg_temp.id('user.m_a'), 'bi new app', 'totp',
            'verified', now() - interval '1 hour', now() - interval '1 hour', 'bi-synthetic-secret-2');
    update auth.sessions set factor_id = pg_temp.id('factor.m_a_new') where id = s1;
    insert into auth.mfa_amr_claims (id, session_id, authentication_method, created_at, updated_at)
    values (gen_random_uuid(), s1, 'totp', now() - interval '1 minute', now() - interval '1 minute');
    v_before := pg_temp.own_writes();
    perform pg_temp.refused('C5b a factor newer than the session', pg_temp.reply(v_task, 'Oi.', 1),
                            'second_factor_required', null, v_before);
    -- C6: the session's own factor, verified 59 minutes ago: queued.
    update auth.sessions set factor_id = pg_temp.id('factor.m_a') where id = s1;
    update auth.mfa_amr_claims set updated_at = now() - interval '59 minutes'
     where session_id = s1 and authentication_method = 'totp';
    v_queued := pg_temp.reply(v_task, 'Oi.', 1);
    perform pg_temp.refused('C6 a recent factor', v_queued, 'queued');
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if not exists (select 1 from ops.operator_assurance_exemption) then
    raise exception 'C2: the exemption outlived its subtransaction''s rollback';
  end if;
end
$$;

-- C8 (and B11 for a conversation the agent holds): a crisis that also asks
--     for a person keeps the conversation with the agent, waiting.
do $$
declare
  v_dev    text := pg_temp.device('crisisp', 'Duda');
  v        jsonb;
  v_task   uuid;
  v_before jsonb;
begin
  v := pg_temp.receive(v_dev, 'Não quero mais viver. Quero falar com uma pessoa.');
  v_task := pg_temp.remember('crisisp.task', (v ->> 'task_id')::uuid);
  perform pg_temp.remember('crisisp.conv', (v ->> 'conversation_id')::uuid);
  perform pg_temp.screen(v_task, pg_temp.screening('safety', null, true));
  v := pg_temp.read('C8 crisis', v_task);
  if v ->> 'holder' <> 'agent' or v -> 'allowedActs' <> '{"reply": false, "release": false}'::jsonb
     or v ->> 'replyUnavailable' <> 'not_held' then
    raise exception 'B11: a conversation the agent holds offered %', v - 'turns';
  end if;
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C8', pg_temp.reply(v_task, 'Oi.', 1), 'not_held', null, v_before);
end
$$;

-- C9 (not waiting: taken over again, with nothing open), C10 (withheld).
do $$
declare
  ta       constant uuid := pg_temp.id('tenant_a');
  v_task   uuid := pg_temp.waiting('idle');
  v_before jsonb;
begin
  perform ops.release_conversation(ta, pg_temp.id('idle.conv'), 'bi-person');
  perform ops.take_over_conversation(ta, pg_temp.id('idle.conv'), 'bi-person');
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C9', pg_temp.reply(v_task, 'Oi.', 1), 'not_waiting', null, v_before);
  perform pg_temp.refused('C8 released', pg_temp.reply(pg_temp.id('released.task'), 'Oi.', 1), 'not_held', null, v_before);
  if pg_temp.answer(pg_temp.reply(pg_temp.id('health.task'), 'Oi.', 1))
     <> '{"v": 1, "outcome": "withheld", "revision": null, "reason": null}'::jsonb then
    raise exception 'C10: a health conversation was not answered withheld without its revision';
  end if;
  perform pg_temp.refused('C10 erased', pg_temp.reply(pg_temp.id('erased.task'), 'Oi.', 1), 'withheld', null, v_before);
  if v_before is distinct from pg_temp.own_writes() then
    raise exception 'C10: a refusal wrote';
  end if;
end
$$;

-- C11 to C13 (and B11): what the send would refuse now is refused before
--     anything is written, with its reason: the window, an open opt-out, the
--     admission's do-not-contact snapshot, and what only the CRM can tell.
do $$
declare
  ta       constant uuid := pg_temp.id('tenant_a');
  v_task   uuid;
  v        jsonb;
  v_before jsonb;
begin
  -- C11: the contact last wrote 25 hours ago.
  v_task := pg_temp.waiting('late');
  update ops.conversations set last_inbound_at = now() - interval '25 hours' where id = pg_temp.id('late.conv');
  v := pg_temp.read('C11', v_task);
  if v -> 'allowedActs' <> '{"reply": false, "release": true}'::jsonb or v ->> 'replyUnavailable' <> 'window_closed'
     or v ->> 'windowEndsAt' <> ops.cos_ts(now() - interval '1 hour') then
    raise exception 'B11: a closed window offered %', v - 'turns';
  end if;
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C11', pg_temp.reply(v_task, 'Oi.', 1), 'not_sendable', 'outside_service_window', v_before);

  -- C12: an opt-out open on the conversation.
  v_task := pg_temp.waiting('optout');
  perform ops.open_exception(ta, pg_temp.id('company_a'), v_task, 'opt_out', pg_temp.id('optout.conv'), null, null, 'bi-suite');
  v := pg_temp.read('C12', v_task);
  if not (v ->> 'optOutOpen')::boolean or v -> 'allowedActs' <> '{"reply": false, "release": false}'::jsonb
     or v ->> 'replyUnavailable' <> 'opt_out_open' then
    raise exception 'B11: an open opt-out offered %', v - 'turns';
  end if;
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C12', pg_temp.reply(v_task, 'Oi.', 1), 'not_sendable', 'opt_out_open', v_before);

  -- C13: the CRM marked the contact do-not-contact before the message came.
  perform pg_temp.device('dnc', 'Eva');
  update public.lead_profiles set do_not_contact = true where contact_id = pg_temp.contact_of('dnc');
  v := pg_temp.receive(pg_temp.device_of('dnc'), 'Quero falar com uma pessoa, por favor.');
  v_task := pg_temp.remember('dnc.task', (v ->> 'task_id')::uuid);
  perform pg_temp.screen(v_task, pg_temp.screening('unknown', null, true));
  v := pg_temp.read('C13', v_task);
  if v -> 'allowedActs' <> '{"reply": false, "release": true}'::jsonb or v ->> 'replyUnavailable' <> 'do_not_contact' then
    raise exception 'B11: a do-not-contact snapshot offered %', v - 'turns';
  end if;
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C13', pg_temp.reply(v_task, 'Oi.', 1), 'not_sendable', 'do_not_contact', v_before);

  -- C13b: the CRM no longer holds the number. The read cannot tell (it never
  --       asks the CRM), so it offers the reply; the act refuses it.
  v_task := pg_temp.waiting('gone');
  begin
    update public.contacts set phone_jsonb = '[]'::jsonb where id = pg_temp.contact_of('gone');
    v := pg_temp.read('C13b', v_task);
    v_before := pg_temp.own_writes();
    perform pg_temp.refused('C13b', pg_temp.reply(v_task, 'Oi.', 1), 'not_sendable', 'contact_not_found', v_before);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if (v -> 'allowedActs' ->> 'reply')::boolean is not true then
    raise exception 'C13b: the read refused what only the CRM can tell: %', v - 'turns';
  end if;
end
$$;

-- C14 (and B11): nothing a reply can answer, the newest message's content
--     erased, and five replies already answering this revision.
do $$
declare
  ta       constant uuid := pg_temp.id('tenant_a');
  v_task   uuid;
  v        jsonb;
  v_read   jsonb;
  v_before jsonb;
begin
  -- The newest message has no run (constructed directly, inside a
  -- subtransaction that is rolled back).
  v_task := pg_temp.waiting('norun');
  begin
    alter table ops.inbound_messages disable trigger inbound_messages_guard_update;
    update ops.inbound_messages set agent_run_id = null where task_id = v_task;
    alter table ops.inbound_messages enable always trigger inbound_messages_guard_update;
    v_read := pg_temp.read('C14 nothing', v_task);
    v_before := pg_temp.own_writes();
    v := pg_temp.reply(v_task, 'Oi.', 1);
    perform pg_temp.refused('C14 nothing', v, 'nothing_to_answer', null, v_before);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_read -> 'allowedActs' ->> 'reply' <> 'false' or v_read ->> 'replyUnavailable' <> 'nothing_to_answer' then
    raise exception 'B11: nothing to answer offered %', v_read - 'turns';
  end if;

  -- The newest message's content was erased. The owner's erasure refuses
  -- test data (only health and person_text content is AI working content
  -- under D6), so the redaction is stamped as the retention ledger would
  -- stamp it, inside a subtransaction that is rolled back.
  v_task := pg_temp.waiting('wiped');
  begin
    alter table ops.tasks disable trigger tasks_guard_update;
    alter table ops.tasks disable trigger tasks_request_identity_update;
    update ops.tasks set description = null, request_fingerprint = null, content_redacted_at = now() where id = v_task;
    alter table ops.tasks enable always trigger tasks_guard_update;
    alter table ops.tasks enable always trigger tasks_request_identity_update;
    v_read := pg_temp.read('C14 erased', v_task);
    v_before := pg_temp.own_writes();
    v := pg_temp.reply(v_task, 'Oi.', 1);
    perform pg_temp.refused('C14 erased', v, 'content_erased', null, v_before);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_read -> 'allowedActs' ->> 'reply' <> 'false' or v_read ->> 'replyUnavailable' <> 'content_erased'
     or v_read -> 'turns' -> 0 <> jsonb_build_object('kind', 'inbound', 'at', v_read -> 'turns' -> 0 -> 'at',
                                                     'text', null, 'hidden', 'erased') then
    raise exception 'B11: an erased message offered %', v_read;
  end if;

  -- Five replies at one revision, one of them 2000 code points outside the
  -- basic plane; the sixth is refused.
  v_task := pg_temp.waiting('limit');
  perform pg_temp.refused('C14 limit ' || i, pg_temp.reply(v_task, case when i = 5 then repeat(chr(128512), 2000)
                                                                         else 'Resposta ' || i end, 1), 'queued')
    from generate_series(1, 5) i;
  v := pg_temp.read('C14 limit', v_task);
  if v -> 'allowedActs' ->> 'reply' <> 'false' or v ->> 'replyUnavailable' <> 'reply_limit' then
    raise exception 'B11: a sixth reply was offered: %', v - 'turns';
  end if;
  v_before := pg_temp.own_writes();
  perform pg_temp.refused('C14 limit 6', pg_temp.reply(v_task, 'Resposta 6', 1), 'reply_limit', null, v_before);
  if (select count(*) from ops.review_items ri where ri.task_id = v_task and ri.author = 'person') <> 5 then
    raise exception 'C14: the limit is not five replies';
  end if;
end
$$;

-- C16. A stop of any scope holds the reply instead of refusing it: queued,
--      its job covered by the stop, and shown held until the stop is cleared.
do $$
declare
  ta     constant uuid := pg_temp.id('tenant_a');
  v_task uuid := pg_temp.waiting('stops');
  v_stop uuid;
  v_case record;
  v_out  ops.outbound_messages;
  v      jsonb;
begin
  for v_case in
    select * from (values ('tenant'), ('company'), ('department'), ('agent'), ('job_kind')) c (scope)
  loop
    insert into ops.execution_stops (scope, tenant_id, company_id, department_id, agent_id, job_kind, reason, tripped_by)
    values (v_case.scope, ta,
            case when v_case.scope in ('company', 'department', 'agent') then pg_temp.id('company_a') end,
            case when v_case.scope = 'department' then pg_temp.id('department_a') end,
            case when v_case.scope = 'agent' then pg_temp.id('agent_a') end,
            case when v_case.scope = 'job_kind' then 'outbound.reply_send' end,
            'bi-test: synthetic pause', 'bi-owner')
    returning id into v_stop;
    perform pg_temp.refused('C16 ' || v_case.scope, pg_temp.reply(v_task, 'Durante a pausa: ' || v_case.scope, 1), 'queued');
    v_out := pg_temp.last_reply(pg_temp.id('stops.conv'));
    if ops.job_covering_stop(ta, v_out.job_id, 'outbound.reply_send') is distinct from v_stop then
      raise exception 'C16: a % stop does not cover the reply''s job', v_case.scope;
    end if;
    v := pg_temp.read('C16 held', v_task);
    if exists (select 1 from jsonb_array_elements(v -> 'turns') t
                where t ->> 'author' = 'person' and t ->> 'delivery' <> 'held') then
      raise exception 'C16: under a % stop a reply is not shown held: %', v_case.scope, v -> 'turns';
    end if;
    update ops.execution_stops set cleared_at = now(), cleared_by = 'bi-owner', cleared_reason = 'bi-test: over'
     where id = v_stop;
    v := pg_temp.read('C16 cleared', v_task);
    if exists (select 1 from jsonb_array_elements(v -> 'turns') t
                where t ->> 'author' = 'person' and t ->> 'delivery' <> 'queued') then
      raise exception 'C16: once the % stop is cleared a reply is not shown queued: %', v_case.scope, v -> 'turns';
    end if;
  end loop;
end
$$;

-- ===========================================================================
-- D. THE SEND TABLE'S GUARD: a person_reply row is admitted only in the act
--    that accepted its review: this transaction's mark for that review, a
--    person review of test data the same principal accepted in this
--    transaction, its own queued reply job, and the contact's window as its
--    bound. Each attempt runs in a subtransaction that is rolled back.
-- ===========================================================================

-- One attempt to insert a send row; 'accepted', or the refusal's SQLSTATE.
create function pg_temp.try_send(p_review uuid, p_requested_by text, p_mark uuid, p_job_kind text default 'outbound.reply_send',
                                 p_payload_self boolean default true, p_fresh_delta interval default '0',
                                 p_kind text default 'person_reply') returns text
language plpgsql as $f$
declare
  v_rev  ops.review_items;
  v_conv ops.conversations;
  v_id   uuid := gen_random_uuid();
  v_job  uuid;
  v_got  text;
begin
  select * into v_rev from ops.review_items where id = p_review;
  select c.* into v_conv from ops.conversations c
   where c.id = (select m.conversation_id from ops.inbound_messages m where m.task_id = v_rev.task_id);
  begin
    if p_kind = 'person_reply' then
      v_job := ops.enqueue_job(v_rev.tenant_id, p_job_kind,
                               jsonb_build_object('outbound_message_id', case when p_payload_self then v_id else gen_random_uuid() end));
    end if;
    perform set_config('ops.person_reply_send', coalesce(p_mark::text, ''), true);
    insert into ops.outbound_messages (id, tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
                                       status, requested_by, authorized_check, authorization_kind, job_id, fresh_until)
    values (v_id, v_rev.tenant_id, v_rev.company_id, v_conv.channel_id, v_conv.id, v_rev.id, v_rev.task_id,
            'authorized', p_requested_by, '{}', p_kind, v_job,
            case when p_kind = 'person_reply' then v_conv.last_inbound_at + interval '24 hours' + p_fresh_delta end);
    v_got := 'accepted';
    raise exception using errcode = 'C1CAC', message = 'undo';
  exception
    when sqlstate 'C1CAC' then null;
    when others then v_got := sqlstate || ': ' || sqlerrm;
  end;
  return v_got;
end
$f$;

do $$
declare
  ta      constant uuid := pg_temp.id('tenant_a');
  c_guard constant text := 'OS403: ops.outbound_messages: a person''s reply is sent only by the act that accepted it';
  v_task  uuid := pg_temp.waiting('dguard');
  v_conv  uuid := pg_temp.id('dguard.conv');
  p_a     text := 'principal:' || pg_temp.id('principal.m_a');
  p_a2    text := 'principal:' || pg_temp.id('principal.m_a2');
  r_a     uuid;
  r_b     uuid;
  r_a2    uuid;
  v_agent uuid := (select ri.id from ops.review_items ri where ri.task_id = pg_temp.id('main.task1b'));
  v_got   text;
  v_case  record;
begin
  r_a := (ops.open_person_reply_review(ta, v_conv, 'Resposta D-a.', p_a, 1, 'company-os-ui') ->> 'review_item_id')::uuid;
  r_b := (ops.open_person_reply_review(ta, v_conv, 'Resposta D-b.', p_a, 1, 'company-os-ui') ->> 'review_item_id')::uuid;
  r_a2 := (ops.open_person_reply_review(ta, v_conv, 'Resposta D-a2.', p_a2, 1, 'company-os-ui') ->> 'review_item_id')::uuid;

  for v_case in
    select * from (values
      ('D0 the act''s own row', pg_temp.try_send(r_a, p_a, r_a), 'accepted'),
      ('D1 no mark', pg_temp.try_send(r_a, p_a, null), c_guard),
      ('D2 the mark of another review', pg_temp.try_send(r_a, p_a, r_b), c_guard),
      ('D3 another principal''s acceptance', pg_temp.try_send(r_a2, p_a, r_a2), c_guard),
      ('D3 an actor that is no principal', pg_temp.try_send(r_a, 'bi-person', r_a), c_guard),
      ('D6 a job of another kind', pg_temp.try_send(r_a, p_a, r_a, 'crm.opt_out_record'), c_guard),
      ('D6 a job carrying another send', pg_temp.try_send(r_a, p_a, r_a, 'outbound.reply_send', false), c_guard),
      ('D7 a bound past the window', pg_temp.try_send(r_a, p_a, r_a, 'outbound.reply_send', true, '1 second'), c_guard),
      ('D8 an operator send of the same review', pg_temp.try_send(r_a, p_a, null, null, true, '0', 'operator'), 'accepted'))
      c (label, got, expected)
  loop
    if v_case.got is distinct from v_case.expected then
      raise exception '%: expected %, got %', v_case.label, v_case.expected, v_case.got;
    end if;
  end loop;

  -- D4: a review accepted in an earlier transaction.
  begin
    alter table ops.review_items disable trigger review_items_guard_update;
    update ops.review_items set reviewed_at = now() - interval '1 minute' where id = r_b;
    alter table ops.review_items enable always trigger review_items_guard_update;
    v_got := pg_temp.try_send(r_b, p_a, r_b);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_got is distinct from c_guard then
    raise exception 'D4 an earlier acceptance: expected the guard, got %', v_got;
  end if;

  -- D5: the agent's review, accepted by a principal.
  begin
    perform ops.record_review_decision(ta, v_agent, 'accepted', p_a, 'company-os-ui', null);
    v_got := pg_temp.try_send(v_agent, p_a, v_agent);
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_got is distinct from c_guard then
    raise exception 'D5 an agent''s review: expected the guard, got %', v_got;
  end if;

  -- D9: the operator's send never carries a person's reply a job carries.
  v_got := null;
  begin
    perform ops.request_outbound_send(ta, (select ri.id from ops.review_items ri
                                            where ri.task_id = pg_temp.id('c1.task') and ri.author = 'person'
                                              and ri.reviewer = p_a and ri.proposed ->> 'response_draft' like '%SENTINEL-PERSON-C1'),
                                      'bi-operator', 'operator-cli');
  exception when others then
    v_got := sqlstate || ': ' || sqlerrm;
  end;
  if v_got is distinct from 'OS403: ops.request_outbound_send: refused: carried_by_job' then
    raise exception 'D9: the operator''s send of a person''s reply answered %', v_got;
  end if;
end
$$;

-- ===========================================================================
-- E. release_conversation (SI-87): the owner's release at the revision the
--    member saw, never while an opt-out is open; every refusal a state that
--    writes nothing.
-- ===========================================================================

-- E1. Released: the agent holds the conversation again, and the request for
--     a person and the waiting message are closed as released by the
--     principal. A reply already queued still leaves (v2 SEND-2 a).
do $$
declare
  ta      constant uuid := pg_temp.id('tenant_a');
  v_task  uuid := pg_temp.waiting('rel1');
  v_conv  uuid := pg_temp.id('rel1.conv');
  v       jsonb;
  v_out   ops.outbound_messages;
  v_paths text[];
begin
  perform pg_temp.receive(pg_temp.device_of('rel1'), null);
  perform pg_temp.refused('E1 queued', pg_temp.reply(v_task, 'Resposta antes da devolução.', 2), 'queued');
  v_out := pg_temp.last_reply(v_conv);
  v := pg_temp.release(v_task, 2);
  if pg_temp.answer(v) <> '{"v": 1, "outcome": "released", "revision": 2}'::jsonb then
    raise exception 'E1: the release answered %', v;
  end if;
  select array_agg(x order by x) into v_paths from pg_temp.key_paths(v -> 'body') x;
  if v_paths <> array['.asOf', '.outcome', '.revision', '.v'] then
    raise exception 'E1: the release''s answer has the keys %', v_paths;
  end if;
  if (select s.holder from ops.conversation_states s where s.conversation_id = v_conv) <> 'agent'
     or (select array_agg(e.kind || '/' || e.resolution || '/' || e.resolved_by order by e.kind) from ops.exceptions e
          where e.conversation_id = v_conv)
        <> array['message_waiting/released/principal:' || pg_temp.id('principal.m_a'),
                 'person_requested/released/principal:' || pg_temp.id('principal.m_a')] then
    raise exception 'E1: the release did not give the conversation back, closing its episodes as released by the principal';
  end if;
  if pg_temp.read('E1 after', v_task) - 'asOf' <> '{"v": 1, "status": "not_waiting"}'::jsonb then
    raise exception 'E1: a released conversation is still offered';
  end if;
  v := pg_temp.carry(v_out.id);
  if v ->> 'settle' is distinct from 'sent' then
    raise exception 'E1: a reply queued before the release did not leave: %', v;
  end if;
end
$$;

-- E1b (v2 SEND-2 b). A message the screening had not read at the release is
--     screened with the agent holding the conversation: no waiting message.
do $$
declare
  v_task uuid := pg_temp.waiting('rel2');
  v      jsonb;
begin
  v := pg_temp.receive(pg_temp.device_of('rel2'), 'Qual o valor da primeira sessão?');
  perform pg_temp.refused('E1b', pg_temp.release(v_task, 2), 'released');
  if pg_temp.screen((v ->> 'task_id')::uuid, pg_temp.screening('administrative', 'Qual o valor da primeira sessão?'))
     <> 'model'
     or exists (select 1 from ops.exceptions e
                 where e.conversation_id = pg_temp.id('rel2.conv') and e.resolved_at is null) then
    raise exception 'E1b: a message pending at the release was not screened for the agent';
  end if;
end
$$;

-- E1c. Any task of the conversation reaches it: the oldest of 55.
do $$
begin
  perform pg_temp.refused('E1c', pg_temp.release(pg_temp.id('many.task'), 55), 'released');
end
$$;

-- E2 to E8. Refusals: the agent holds it, an opt-out is open, stale, not
--     waiting, withheld; an unknown ref is OS404 and a malformed request
--     OS400.
do $$
declare
  v_before jsonb := pg_temp.own_writes();
  v        jsonb;
begin
  perform pg_temp.refused('E2', pg_temp.release(pg_temp.id('crisisp.task'), 1), 'already_with_agent', null, v_before);
  perform pg_temp.refused('E3', pg_temp.release(pg_temp.id('optout.task'), 1), 'opt_out_open', null, v_before);
  perform pg_temp.refused('E4', pg_temp.release(pg_temp.id('main.task1'), 5), 'stale', null, v_before);
  perform pg_temp.refused('E5', pg_temp.release(pg_temp.id('idle.task'), 1), 'not_waiting', null, v_before);
  if pg_temp.answer(pg_temp.release(pg_temp.id('health.task'), 1)) <> '{"v": 1, "outcome": "withheld", "revision": null}'::jsonb
     or pg_temp.answer(pg_temp.release(pg_temp.id('main.task1'), 5)) <> '{"v": 1, "outcome": "stale", "revision": 6}'::jsonb then
    raise exception 'E6: a withheld or stale release did not name what it should';
  end if;
  if (select s.holder from ops.conversation_states s where s.conversation_id = pg_temp.id('optout.conv')) <> 'person' then
    raise exception 'E3: a release under an open opt-out moved the holder';
  end if;
  foreach v in array array[pg_temp.release(gen_random_uuid(), 1), pg_temp.release(pg_temp.id('b.task'), 1)] loop
    if v - 'hint' - 'detail' <> '{"ok": false, "code": "OS404", "message": "company_os_api.release_conversation: not found"}'::jsonb then
      raise exception 'E7: an unknown ref answered %', v;
    end if;
  end loop;
  foreach v in array array[pg_temp.reply(gen_random_uuid(), 'Oi.', 1), pg_temp.reply(pg_temp.id('b.task'), 'Oi.', 1)] loop
    if v - 'hint' - 'detail' <> '{"ok": false, "code": "OS404", "message": "company_os_api.reply_to_conversation: not found"}'::jsonb then
      raise exception 'E7: an unknown ref answered the reply with %', v;
    end if;
  end loop;
  v := pg_temp.release(pg_temp.id('main.task1'), -1);
  if v - 'hint' - 'detail' <> '{"ok": false, "code": "OS400", "message": "company_os_api.release_conversation: bad request"}'::jsonb then
    raise exception 'E8: a negative revision answered %', v;
  end if;
  if v_before is distinct from pg_temp.own_writes() then
    raise exception 'E2: a refused release wrote: before %, after %', v_before, pg_temp.own_writes();
  end if;
end
$$;

-- ===========================================================================
-- F. THE ACTS' PATHS, pinned from the live catalogue (the P5b pattern).
-- ===========================================================================

-- A body as code only, lower-cased: every comment removed and every string
-- literal emptied (''), each found by scanning (company_os_api.sql P5).
create function pg_temp.code_only(p text) returns text
language plpgsql immutable as $f$
declare
  v_rest text := lower(p);
  v_out  text := '';
  v_q    int;
  v_line int;
  v_blk  int;
  v_at   int;
  v_end  int;
begin
  loop
    v_q := nullif(strpos(v_rest, ''''), 0);
    v_line := nullif(strpos(v_rest, '--'), 0);
    v_blk := nullif(strpos(v_rest, '/*'), 0);
    v_at := least(v_q, v_line, v_blk);
    if v_at is null then
      return v_out || v_rest;
    end if;
    v_out := v_out || substr(v_rest, 1, v_at - 1);
    v_rest := substr(v_rest, v_at);
    if v_at = v_q then
      v_end := 2;
      loop
        v_at := strpos(substr(v_rest, v_end), '''');
        if v_at = 0 then
          return v_out || '''''';
        end if;
        v_end := v_end + v_at - 1;
        exit when substr(v_rest, v_end + 1, 1) <> '''';
        v_end := v_end + 2;
      end loop;
      v_out := v_out || '''''';
      v_rest := substr(v_rest, v_end + 1);
    elsif v_at = v_line then
      v_at := strpos(v_rest, E'\n');
      if v_at = 0 then
        return v_out;
      end if;
      v_rest := substr(v_rest, v_at);
    else
      v_at := strpos(substr(v_rest, 3), '*/');
      if v_at = 0 then
        return v_out;
      end if;
      v_out := v_out || ' ';
      v_rest := substr(v_rest, v_at + 4);
    end if;
  end loop;
end
$f$;

-- The ops functions a body's code calls (the table of an insert is no call).
create function pg_temp.callees(p regprocedure) returns text[]
language sql stable as $$
  select coalesce(array_agg(distinct m[1] order by m[1]), '{}')
    from pg_proc f,
         regexp_matches(regexp_replace(pg_temp.code_only(f.prosrc), 'insert\s+into\s+ops\.[a-z_0-9]+', ' ', 'g'),
                        'ops\."?([a-z_0-9]+)"?\s*\(', 'g') m
   where f.oid = p;
$$;

do $$
declare
  c_reply   constant regprocedure[] := array[
    'company_os_api.reply_to_conversation(uuid, text, integer)'::regprocedure,
    'ops.gate_reply_to_conversation(uuid, text, integer)'::regprocedure,
    'ops.reply_to_conversation_as_member(uuid, text, uuid, text, integer)'::regprocedure,
    'ops.inbox_preflight(uuid, uuid, integer, text)'::regprocedure,
    'ops.open_person_reply_review(uuid, uuid, text, text, integer, text)'::regprocedure,
    'ops.authorize_person_reply(uuid, text, jsonb)'::regprocedure];
  c_release constant regprocedure[] := array[
    'company_os_api.release_conversation(uuid, integer)'::regprocedure,
    'ops.gate_release_conversation(uuid, integer)'::regprocedure,
    'ops.release_conversation_as_member(uuid, text, uuid, integer)'::regprocedure,
    'ops.inbox_preflight(uuid, uuid, integer, text)'::regprocedure];
  c_read    constant regprocedure[] := array[
    'ops.gate_get_conversation(uuid)'::regprocedure, 'ops.read_conversation(uuid, uuid)'::regprocedure,
    'ops.cos_inbox_conversation(uuid, uuid)'::regprocedure, 'ops.cos_conversation_visible(uuid, uuid)'::regprocedure,
    'ops.cos_conversation_waiting(uuid, uuid)'::regprocedure, 'ops.cos_conversation_first_name(uuid, uuid)'::regprocedure,
    'ops.cos_message_do_not_contact(uuid, uuid)'::regprocedure,
    'ops.cos_person_reply_refusal(uuid, uuid, integer)'::regprocedure,
    'ops.cos_conversation_turns(uuid, uuid)'::regprocedure];
  v_case record;
  v_bad  text;
begin
  -- F1. Each act's layers call exactly their pinned callees.
  for v_case in
    select * from (values
      ('company_os_api.reply_to_conversation(uuid, text, integer)', array['gate_reply_to_conversation']),
      ('ops.gate_reply_to_conversation(uuid, text, integer)', array['operator_scope', 'reply_to_conversation_as_member']),
      ('ops.reply_to_conversation_as_member(uuid, text, uuid, text, integer)',
       array['authorize_person_reply', 'cos_person_reply_refusal', 'cos_ts', 'inbox_preflight', 'open_person_reply_review',
             'operator_second_factor_recent', 'reply_send_eligibility']),
      ('ops.authorize_person_reply(uuid, text, jsonb)', array['enqueue_job', 'record_event', 'review_is_person_reply']),
      ('ops.open_person_reply_review(uuid, uuid, text, text, integer, text)',
       array['open_scripted_review', 'record_review_decision']),
      ('ops.inbox_preflight(uuid, uuid, integer, text)',
       array['cos_conversation_revision', 'cos_conversation_visible', 'cos_conversation_waiting', 'cos_inbox_conversation']),
      ('company_os_api.release_conversation(uuid, integer)', array['gate_release_conversation']),
      ('ops.gate_release_conversation(uuid, integer)', array['operator_scope', 'release_conversation_as_member']),
      ('ops.release_conversation_as_member(uuid, text, uuid, integer)',
       array['cos_ts', 'inbox_preflight', 'release_conversation']),
      ('company_os_api.get_conversation(uuid)', array['gate_get_conversation']),
      ('ops.gate_get_conversation(uuid)', array['operator_scope', 'read_conversation'])) c (fn, expected)
  loop
    if pg_temp.callees(v_case.fn::regprocedure) is distinct from v_case.expected then
      raise exception 'F1: % calls %, not exactly %', v_case.fn, pg_temp.callees(v_case.fn::regprocedure), v_case.expected;
    end if;
  end loop;

  -- F2. Neither act's path names a send's begin, last gate or settlement, a
  --     transport, a token, a stop's clear, a takeover or an exception act.
  select string_agg(f.oid::regprocedure::text, ', ') into v_bad
    from pg_proc f
   where f.oid = any (c_reply || c_release)
     and pg_temp.code_only(f.prosrc) ~ '(begin_|confirm_|settle_|transport|token|clear|resume|untrip|take_over|resolve_exception)';
  if v_bad is not null then
    raise exception 'F2: an act''s path names a send step, a transport, a clear, a takeover or an exception act: %', v_bad;
  end if;

  -- F3. The release's path, the owner's release included, names no send, no
  --     job, no run, no WhatsApp service and no CRM.
  select string_agg(f.oid::regprocedure::text, ', ') into v_bad
    from pg_proc f
   where f.oid = any (c_release || 'ops.release_conversation(uuid, uuid, text)'::regprocedure)
     and pg_temp.code_only(f.prosrc) ~ '(outbound|send|enqueue|_jobs?\M|\mjobs?\M|agent_runs?\M|whatsapp|crm_)';
  if v_bad is not null then
    raise exception 'F3: the release''s path names a send, a job, a run, WhatsApp or the CRM: %', v_bad;
  end if;

  -- F4. The two callees and the preflight write nothing themselves: every
  --     write is a named writer's (a row lock is no write).
  select string_agg(f.oid::regprocedure::text, ', ') into v_bad
    from pg_proc f
   where f.oid = any (array['ops.reply_to_conversation_as_member(uuid, text, uuid, text, integer)'::regprocedure,
                            'ops.release_conversation_as_member(uuid, text, uuid, integer)'::regprocedure,
                            'ops.inbox_preflight(uuid, uuid, integer, text)'::regprocedure])
     and regexp_replace(pg_temp.code_only(f.prosrc), 'for\s+(no\s+key\s+)?update', ' ', 'g')
         ~ '\m(insert|update|delete|truncate|merge|copy)\M';
  if v_bad is not null then
    raise exception 'F4: an act''s own layer writes: %', v_bad;
  end if;

  -- F5. The read's path is the read graph's (company_os_api.sql P5 reads every
  --     ops function named gate_, read_ or cos_): STABLE, read only, ops and
  --     pg_catalog names only, its callees read callees or the first-name
  --     adapter, never VOLATILE.
  select string_agg(f.oid::regprocedure::text, ', ') into v_bad
    from pg_proc f
   where f.oid = any (c_read)
     and (f.proname !~ '^(gate_|read_|cos_)' or f.provolatile <> 's'
          or regexp_replace(f.prosrc, '''([^'']|'''')*''', '''''', 'g') ~* '\m(insert|update|delete|truncate|merge|copy)\M'
          or f.prosrc ~* '(\mpublic\.|email|(^|[\s;])execute\s)'
          or exists (select 1 from unnest(pg_temp.callees(f.oid)) c
                      where not (c ~ '^(gate_|read_|cos_)' or c in ('operator_scope', 'crm_contact_first_name'))
                         or exists (select 1 from pg_proc x where x.pronamespace = 'ops'::regnamespace
                                       and x.proname = c and x.provolatile = 'v')));
  if v_bad is not null then
    raise exception 'F5: a function on the read''s path is outside the read graph''s rules: %', v_bad;
  end if;
end
$$;

-- ===========================================================================
-- G. THE REPLY JOB, through the worker's own capabilities under a simulated
--    lease (begin, the last gate, the settlement, the reaper).
-- ===========================================================================

-- The tenant's privacy notice rides each conversation's first reply.
do $$
begin
  perform pg_temp.remember('notice', ops.record_privacy_notice(
    pg_temp.id('tenant_a'), 'v1', 'https://clinic.example.test/privacy',
    'Aviso de privacidade sintético: https://clinic.example.test/privacy', 'lgpd:art7-v+art11-ii-f', 'bi-owner'));
end
$$;

-- G1. Begun with a transport: the body is the person's text and, on the
--     conversation's first reply, the notice; sent to the conversation's
--     number; shown sent.
do $$
declare
  v_task uuid := pg_temp.waiting('g1');
  c_text constant text := 'Primeira resposta da equipe. SENTINEL-PERSON-G1';
  v_out  ops.outbound_messages;
  v      jsonb;
begin
  perform pg_temp.refused('G1', pg_temp.reply(v_task, c_text, 1), 'queued');
  v_out := pg_temp.last_reply(pg_temp.id('g1.conv'));
  v := pg_temp.carry(v_out.id);
  if v -> 'begin' ->> 'action' <> 'start'
     or v -> 'begin' -> 'request' ->> 'body'
        <> c_text || repeat(chr(10), 2) || 'Aviso de privacidade sintético: https://clinic.example.test/privacy'
     or v -> 'begin' -> 'request' ->> 'to' <> pg_temp.device_of('g1')
     or v -> 'confirm' ->> 'action' <> 'send' or v ->> 'settle' <> 'sent' then
    raise exception 'G1: the reply job did not carry the text and the notice to the contact: %', v;
  end if;
  v := pg_temp.read('G1 sent', v_task);
  if (select count(*) from jsonb_array_elements(v -> 'turns') t
       where t ->> 'author' = 'person' and t ->> 'delivery' = 'sent' and (t ->> 'withPrivacyNotice')::boolean
         and t ->> 'text' = c_text) <> 1 then
    raise exception 'G1: the sent reply is not shown sent with its notice: %', v -> 'turns';
  end if;
end
$$;

-- G2. Past the contact's window: without a transport, transport_not_configured;
--     with one, outside_service_window; both listed for a person (the bound
--     moved inside a subtransaction that is rolled back).
do $$
declare
  v_task   uuid := pg_temp.waiting('g2');
  v_conv   uuid := pg_temp.id('g2.conv');
  r1       uuid;
  r2       uuid;
  v_status text[];
  v_open   int;
begin
  perform pg_temp.refused('G2 first', pg_temp.reply(v_task, 'Resposta G2 um.', 1), 'queued');
  r1 := (pg_temp.last_reply(v_conv)).id;
  perform pg_temp.refused('G2 second', pg_temp.reply(v_task, 'Resposta G2 dois.', 1), 'queued');
  r2 := (pg_temp.last_reply(v_conv)).id;
  begin
    alter table ops.outbound_messages disable trigger outbound_messages_guard;
    update ops.outbound_messages set fresh_until = now() - interval '1 second' where id in (r1, r2);
    alter table ops.outbound_messages enable always trigger outbound_messages_guard;
    perform pg_temp.carry(r1, null);
    perform pg_temp.carry(r2, 'fake');
    select array_agg(o.status || '/' || o.blocked_reason order by o.id = r2) into v_status
      from ops.outbound_messages o where o.id in (r1, r2);
    select count(*) into v_open from ops.exceptions e
     where e.outbound_message_id in (r1, r2) and e.kind = 'send_blocked' and e.resolved_at is null;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_status <> array['blocked/transport_not_configured', 'blocked/outside_service_window'] or v_open <> 2 then
    raise exception 'G2: a reply past its window was not blocked and listed: %, % listed', v_status, v_open;
  end if;
end
$$;

-- G3 (an opt-out opened after the request: blocked and listed), G4 (the
--     contact wrote after it: blocked as stale, listed for no one).
do $$
declare
  ta     constant uuid := pg_temp.id('tenant_a');
  v_task uuid;
  v_out  ops.outbound_messages;
begin
  v_task := pg_temp.waiting('g3');
  perform pg_temp.refused('G3', pg_temp.reply(v_task, 'Resposta G3.', 1), 'queued');
  perform ops.open_exception(ta, pg_temp.id('company_a'), v_task, 'opt_out', pg_temp.id('g3.conv'), null, null, 'bi-suite');
  v_out := pg_temp.last_reply(pg_temp.id('g3.conv'));
  perform pg_temp.carry(v_out.id);
  select * into v_out from ops.outbound_messages where id = v_out.id;
  if v_out.status <> 'blocked' or v_out.blocked_reason <> 'opt_out_open'
     or not exists (select 1 from ops.exceptions e where e.outbound_message_id = v_out.id and e.kind = 'send_blocked') then
    raise exception 'G3: a reply under a later opt-out was not blocked and listed: %', to_jsonb(v_out);
  end if;

  v_task := pg_temp.waiting('g4');
  perform pg_temp.refused('G4', pg_temp.reply(v_task, 'Resposta G4.', 1), 'queued');
  perform pg_temp.receive(pg_temp.device_of('g4'), null);
  v_out := pg_temp.last_reply(pg_temp.id('g4.conv'));
  perform pg_temp.carry(v_out.id);
  select * into v_out from ops.outbound_messages where id = v_out.id;
  if v_out.status <> 'blocked' or v_out.blocked_reason <> 'newer_message'
     or exists (select 1 from ops.exceptions e where e.outbound_message_id = v_out.id) then
    raise exception 'G4: a reply the contact''s newer message made stale was not blocked unlisted: %', to_jsonb(v_out);
  end if;
end
$$;

-- G5. A conversation's replies leave in the order they were written: the
--     later one's job is given back while the earlier is still to leave.
--     G5b (v2 SEND-3): an earlier reply the contact's newer message made
--     stale never holds a later one.
do $$
declare
  v_task uuid := pg_temp.waiting('g5');
  v_conv uuid := pg_temp.id('g5.conv');
  r1 uuid; r2 uuid; r3 uuid; r4 uuid;
  v  jsonb;
begin
  perform pg_temp.refused('G5 first', pg_temp.reply(v_task, 'Primeira.', 1), 'queued');
  r1 := (pg_temp.last_reply(v_conv)).id;
  perform pg_temp.refused('G5 second', pg_temp.reply(v_task, 'Segunda.', 1), 'queued');
  r2 := (pg_temp.last_reply(v_conv)).id;
  v := pg_temp.carry(r2);
  if v -> 'begin' ->> 'action' <> 'released'
     or (select o.status from ops.outbound_messages o where o.id = r2) <> 'authorized'
     or (select je.detail from ops.job_events je
          where je.job_id = (select o.job_id from ops.outbound_messages o where o.id = r2) and je.event = 'deferred')
        <> 'waiting for an earlier reply of the conversation' then
    raise exception 'G5: a later reply did not wait for the earlier: %', v;
  end if;
  if pg_temp.carry(r1) ->> 'settle' <> 'sent' or pg_temp.carry(r2) ->> 'settle' <> 'sent' then
    raise exception 'G5: the two replies did not leave in their order';
  end if;

  perform pg_temp.refused('G5b third', pg_temp.reply(v_task, 'Terceira.', 1), 'queued');
  r3 := (pg_temp.last_reply(v_conv)).id;
  perform pg_temp.receive(pg_temp.device_of('g5'), null);
  perform pg_temp.refused('G5b fourth', pg_temp.reply(v_task, 'Quarta.', 2), 'queued');
  r4 := (pg_temp.last_reply(v_conv)).id;
  v := pg_temp.carry(r4);
  if v ->> 'settle' is distinct from 'sent' then
    raise exception 'G5b: a stale earlier reply held a later one: %', v;
  end if;
  perform pg_temp.carry(r3);
  if (select o.status || '/' || o.blocked_reason from ops.outbound_messages o where o.id = r3) <> 'blocked/newer_message' then
    raise exception 'G5b: the stale earlier reply was not blocked as stale';
  end if;
end
$$;

-- G6. A stop holds the job without consuming an attempt; once cleared, the
--     reply leaves.
do $$
declare
  ta     constant uuid := pg_temp.id('tenant_a');
  v_task uuid := pg_temp.waiting('g6');
  v_out  ops.outbound_messages;
  v_stop uuid;
  v      jsonb;
begin
  perform pg_temp.refused('G6', pg_temp.reply(v_task, 'Resposta G6.', 1), 'queued');
  v_out := pg_temp.last_reply(pg_temp.id('g6.conv'));
  insert into ops.execution_stops (scope, tenant_id, reason, tripped_by)
  values ('tenant', ta, 'bi-test: synthetic pause', 'bi-owner') returning id into v_stop;
  v := pg_temp.carry(v_out.id);
  if v -> 'begin' ->> 'action' <> 'stopped'
     or (select j.status || '/' || j.attempts from ops.jobs j where j.id = v_out.job_id) <> 'queued/0'
     or (select o.status from ops.outbound_messages o where o.id = v_out.id) <> 'authorized' then
    raise exception 'G6: a stop did not hold the reply job: %', v;
  end if;
  update ops.execution_stops set cleared_at = now(), cleared_by = 'bi-owner', cleared_reason = 'bi-test: over'
   where id = v_stop;
  if pg_temp.carry(v_out.id) ->> 'settle' is distinct from 'sent' then
    raise exception 'G6: the reply did not leave once the stop was cleared';
  end if;
end
$$;

-- G7. The reaper, for a reply job that failed: a send still authorized is
--     blocked job_failed and listed; one begun is indeterminate, never sent
--     again.
do $$
declare
  ta     constant uuid := pg_temp.id('tenant_a');
  v_task uuid := pg_temp.waiting('g7');
  v_conv uuid := pg_temp.id('g7.conv');
  r1 ops.outbound_messages;
  r2 ops.outbound_messages;
  v_n int;
begin
  perform pg_temp.refused('G7 first', pg_temp.reply(v_task, 'Resposta G7 um.', 1), 'queued');
  r1 := pg_temp.last_reply(v_conv);
  perform pg_temp.refused('G7 second', pg_temp.reply(v_task, 'Resposta G7 dois.', 1), 'queued');
  r2 := pg_temp.last_reply(v_conv);
  -- The first begins and its worker dies before the call; both jobs then fail.
  perform pg_temp.lease_job(r1.job_id);
  set local role ops_worker;
  if ops.begin_reply_send('fake') ->> 'action' <> 'start' then
    raise exception 'G7: the first reply did not begin';
  end if;
  reset role;
  update ops.jobs set status = 'failed', lease_owner = null, leased_at = null, lease_expires_at = null
   where id in (r1.job_id, r2.job_id);
  set local role ops_worker;
  v_n := ops.settle_stale_reply_sends();
  reset role;
  if (select array_agg(o.status || '/' || coalesce(o.blocked_reason, o.error_class) order by o.id = r2.id)
        from ops.outbound_messages o where o.id in (r1.id, r2.id))
       <> array['indeterminate/execution_interrupted', 'blocked/job_failed']
     or (select array_agg(e.kind order by e.kind) from ops.exceptions e where e.outbound_message_id in (r1.id, r2.id))
       <> array['send_blocked', 'send_indeterminate']
     or v_n < 2 then
    raise exception 'G7: the reaper did not settle the failed reply jobs as it should (% settled)', v_n;
  end if;
end
$$;

-- G8 (correction §0.3). A person's reply to an opt-out message moves no
--     opt-out record to now when it settles; an acknowledgement of the
--     opt-out a person accepted still does.
do $$
declare
  ta     constant uuid := pg_temp.id('tenant_a');
  v      jsonb;
  v_task uuid;
  v_conv uuid;
  v_out  uuid;
  v_ack  uuid;
  v_job  uuid;
begin
  -- The person's own reply.
  v := pg_temp.receive(pg_temp.device('g8p', 'Gil'), 'Não quero mais receber mensagens.');
  v_task := (v ->> 'task_id')::uuid;
  v_conv := (v ->> 'conversation_id')::uuid;
  perform pg_temp.screen(v_task, pg_temp.screening('unknown', null, false, true));
  select r.job_id into v_job from ops.crm_opt_out_requests r where r.task_id = v_task;
  if v_job is null or (select j.available_at from ops.jobs j where j.id = v_job) <= now() then
    raise exception 'setup: the opt-out''s record is not due later';
  end if;
  perform ops.resolve_exception(ta, e.id, 'resolved', 'bi-person', e.occurrences)
     from ops.exceptions e where e.conversation_id = v_conv and e.kind = 'opt_out';
  perform pg_temp.receive(pg_temp.device_of('g8p'), null);
  perform pg_temp.refused('G8 reply', pg_temp.reply(v_task, 'Entendido, obrigado.', 2), 'queued');
  if pg_temp.carry((pg_temp.last_reply(v_conv)).id) ->> 'settle' is distinct from 'sent' then
    raise exception 'setup: the person''s reply to the opt-out message did not leave';
  end if;
  if (select j.available_at from ops.jobs j where j.id = v_job) <= now() then
    raise exception 'G8: a person''s reply moved the opt-out''s record to now';
  end if;

  -- The acknowledgement a person accepted, sent by the operator's send.
  v := pg_temp.receive(pg_temp.device('g8f', 'Ivo'), 'Não quero mais receber mensagens.');
  v_task := (v ->> 'task_id')::uuid;
  v_conv := (v ->> 'conversation_id')::uuid;
  perform pg_temp.screen(v_task, pg_temp.screening('unknown', null, false, true));
  select r.job_id into v_job from ops.crm_opt_out_requests r where r.task_id = v_task;
  select ri.id into v_ack from ops.review_items ri where ri.task_id = v_task and ri.author = 'fixed';
  perform ops.record_review_decision(ta, v_ack, 'accepted', 'bi-person', 'operator-cli', null);
  insert into ops.outbound_messages (tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
                                     status, requested_by, authorized_check)
  values (ta, pg_temp.id('company_a'), pg_temp.id('channel_a'), v_conv, v_ack, v_task, 'authorized', 'bi-operator', '{}')
  returning id into v_out;
  update ops.outbound_messages set status = 'sending', sending_at = now() where id = v_out;
  perform ops.settle_outbound_send(ta, v_out, 'sent', 'wamid.BI-G8-ACK', null, null);
  perform ops.sync_send_exceptions(ta, v_out, 'operator-cli');
  if (select j.available_at from ops.jobs j where j.id = v_job) <> now() then
    raise exception 'G8: the acknowledgement a person accepted did not move the opt-out''s record to now';
  end if;
end
$$;

-- G9. The owner's sync blocks a reply its job could not begin before the
--     window ended: outside_service_window, listed (the bound moved inside a
--     subtransaction that is rolled back).
do $$
declare
  v_task uuid := pg_temp.waiting('g9');
  v_out  ops.outbound_messages;
  v_got  text;
begin
  perform pg_temp.refused('G9', pg_temp.reply(v_task, 'Resposta G9.', 1), 'queued');
  v_out := pg_temp.last_reply(pg_temp.id('g9.conv'));
  begin
    alter table ops.outbound_messages disable trigger outbound_messages_guard;
    update ops.outbound_messages set fresh_until = now() - interval '1 second' where id = v_out.id;
    alter table ops.outbound_messages enable always trigger outbound_messages_guard;
    perform ops.sync_send_exceptions(pg_temp.id('tenant_a'), v_out.id, 'operator-cli');
    select o.status || '/' || o.blocked_reason || '/' ||
           (select count(*) from ops.exceptions e where e.outbound_message_id = o.id and e.kind = 'send_blocked')
      into v_got from ops.outbound_messages o where o.id = v_out.id;
    raise exception using errcode = 'C1CAC', message = 'rolled back';
  exception when sqlstate 'C1CAC' then null;
  end;
  if v_got is distinct from 'blocked/outside_service_window/1' then
    raise exception 'G9: the sync did not block an expired reply as outside its window: %', v_got;
  end if;
end
$$;

-- ===========================================================================
-- H. THE OWNER'S CLI REPLY stays what it was: its answer, its source, its
--    pinned messages, and no send of its own.
-- ===========================================================================

do $$
declare
  ta       constant uuid := pg_temp.id('tenant_a');
  v_task   uuid := pg_temp.waiting('h');
  v_conv   uuid := pg_temp.id('h.conv');
  v_before jsonb := pg_temp.own_writes();
  v        jsonb;
  v_got    text;
  v_case   record;
begin
  v := ops.record_person_reply(ta, v_conv, 'Resposta pelo terminal.', 'bi-person', 1);
  if (select array_agg(k order by k) from jsonb_object_keys(v) k) <> array['decision', 'review_item_id', 'revision', 'state']
     or v ->> 'state' <> 'recorded' or v ->> 'decision' <> 'accepted' or v ->> 'revision' <> '1' then
    raise exception 'H: the CLI reply answered %', v;
  end if;
  if (select array_agg(e.type || '/' || e.source order by e.seq) from ops.events e
       where e.tenant_id = ta and e.payload ->> 'review_item_id' = v ->> 'review_item_id')
       <> array['lead_triage.review_pending/operator-cli', 'lead_triage.reviewed/operator-cli']
     or (select ri.reviewer from ops.review_items ri where ri.id = (v ->> 'review_item_id')::uuid) <> 'bi-person'
     or coalesce((pg_temp.own_writes() ->> 'ops.outbound_messages')::bigint, 0)
        <> coalesce((v_before ->> 'ops.outbound_messages')::bigint, 0)
     or coalesce((pg_temp.own_writes() ->> 'ops.jobs')::bigint, 0) <> coalesce((v_before ->> 'ops.jobs')::bigint, 0) then
    raise exception 'H: the CLI reply recorded another source, another reviewer, a send or a job';
  end if;
  for v_case in
    select * from (values
      (pg_temp.id('crisisp.conv'), 1, 'OS409: ops.record_person_reply: take the conversation over first'),
      (pg_temp.id('late.conv'), 1, 'OS409: ops.record_person_reply: the contact last wrote more than 24 hours ago'),
      (v_conv, 0, 'OS409: ops.record_person_reply: the conversation is at revision 1, not 0; list it again'))
      c (conv, rev, expected)
  loop
    v_got := null;
    begin
      perform ops.record_person_reply(ta, v_case.conv, 'Oi.', 'bi-person', v_case.rev);
    exception when others then
      v_got := sqlstate || ': ' || sqlerrm;
    end;
    if v_got is distinct from v_case.expected then
      raise exception 'H: expected "%", got "%"', v_case.expected, v_got;
    end if;
  end loop;
end
$$;

-- Everything every act and read answered, swept once more.
do $$ begin perform pg_temp.sweep('end'); end $$;

rollback;

-- Nothing above committed.
do $$
begin
  if exists (select 1 from ops.tenants where slug like 'bi-test-%') then
    raise exception 'browser_inbox.sql left fixtures behind';
  end if;
end
$$;
