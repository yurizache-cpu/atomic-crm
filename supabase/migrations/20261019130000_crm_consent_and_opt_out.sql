-- ADR 0026 §C, slice 3b: the opt-out reaches the CRM, after its
-- acknowledgement, and every change of the CRM's opt-out flag is recorded.
--
-- Until now an opt-out never left the Company OS: the screening opened the
-- opt_out exception and a person was told to record it in the CRM. From this
-- migration:
--   * The CRM's consent ledger, public.lead_consent_changes (SI-66's pattern:
--     append-only, written only by its trigger, read by no application role),
--     records every change of lead_profiles.do_not_contact, the CRM form's
--     included, with its origin: a person, or the system recording the
--     contact's own opt-out (and, from slice 3c, lifting it). A write that
--     names the flag with true is a person's opt-out even when the value does
--     not change, so a merge that folds in another contact's opt-out records
--     it as a person's (the merge names the flag only then).
--   * Every screening that detects an opt-out queues one internal
--     crm.opt_out_record job, due at the end of the 24-hour window and moved
--     to now when the acknowledgement's send settles (but for a newer
--     message's). It is the worker's one CRM write path: ops.crm_record_opt_out
--     resolves the contact afresh, sets lead_profiles.do_not_contact = true
--     and nothing else, records the act and lead.opted_out, and reconciles the
--     opt_out exception. No stop holds it (an opt-out is protective). It waits,
--     a bounded time, while an acknowledgement is still on its way, so the
--     flag never refuses the acknowledgement itself.
--   * A person who dismisses the opt_out exception (a false positive, such as
--     "para de me mandar audio") stops it: nothing is recorded, and an unsent
--     automatic acknowledgement of it is stale.
--   * A number's erasure first settles its conversation's pending opt-out,
--     while the number still resolves the contact.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The CRM's consent ledger (SI-66's pattern). Matches supabase/schemas
--    (01_tables, 02_functions, 04_triggers, 05_policies, 06_grants).
-- ---------------------------------------------------------------------------

create table public.lead_consent_changes (
    id bigint generated always as identity primary key,
    -- No foreign key: the history outlives a merge or a contact's deletion.
    contact_id bigint not null,
    from_value boolean,
    to_value boolean not null,
    origin text not null,
    reason_ref text,
    changed_at timestamp with time zone not null,
    constraint lead_consent_changes_origin_check check (origin in ('person', 'system_opt_out', 'system_lift')),
    constraint lead_consent_changes_reason_format check (
      reason_ref is null or reason_ref ~ '^task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    constraint lead_consent_changes_reason_matches_origin check ((origin = 'person') = (reason_ref is null))
);

create index lead_consent_changes_contact_idx on public.lead_consent_changes using btree (contact_id, changed_at, id);

CREATE OR REPLACE FUNCTION "public"."record_lead_consent_change"() RETURNS trigger
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    declare
      v_mark   text := pg_catalog.current_setting('ops.consent_origin', true);
      v_origin text := 'person';
      v_reason text;
    begin
      -- A system write names its origin and the message it answers in a
      -- transaction-local mark set by the backend adapter that writes the
      -- flag; it is consumed here. Without it the write is a person's.
      if v_mark ~ '^(system_opt_out|system_lift):task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_origin := pg_catalog.split_part(v_mark, ':', 1);
        v_reason := pg_catalog.substr(v_mark, pg_catalog.length(v_origin) + 2);
        perform pg_catalog.set_config('ops.consent_origin', '', true);
      end if;
      if tg_op = 'INSERT' then
        if new.do_not_contact then
          insert into public.lead_consent_changes (contact_id, from_value, to_value, origin, reason_ref, changed_at)
          values (new.contact_id, null, true, v_origin, v_reason, pg_catalog.clock_timestamp());
        end if;
        return null;
      end if;
      -- A write that names the flag: every system write, a change, and a
      -- person's true even when unchanged (a merge folding in an opt-out).
      if v_origin <> 'person' or new.do_not_contact or old.do_not_contact is distinct from new.do_not_contact then
        insert into public.lead_consent_changes (contact_id, from_value, to_value, origin, reason_ref, changed_at)
        values (new.contact_id, old.do_not_contact, new.do_not_contact, v_origin, v_reason, pg_catalog.clock_timestamp());
      end if;
      return null;
    end;
    $$;

CREATE OR REPLACE FUNCTION "public"."lead_consent_changes_append_only"() RETURNS trigger
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
    begin
      raise exception 'public.lead_consent_changes is append-only: % refused', lower(tg_op)
        using errcode = '42501';
    end;
    $$;

create or replace trigger record_lead_consent_change_trigger
    after insert or update of do_not_contact on public.lead_profiles
    for each row execute function public.record_lead_consent_change();

create or replace trigger lead_consent_changes_append_only_trigger
    before update or delete on public.lead_consent_changes
    for each row execute function public.lead_consent_changes_append_only();

create or replace trigger lead_consent_changes_refuse_truncate_trigger
    before truncate on public.lead_consent_changes
    for each statement execute function public.lead_consent_changes_append_only();

alter table public.lead_consent_changes enable row level security;

revoke all on table public.lead_consent_changes from public, anon, authenticated, service_role;
revoke all on sequence public.lead_consent_changes_id_seq from public, anon, authenticated, service_role;
revoke all on function public.record_lead_consent_change() from public, anon, authenticated, service_role;
revoke all on function public.lead_consent_changes_append_only() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. One request per opt-out message to record it in the CRM: bound to the
--    opt_out episode it opened or counted on, and to its one internal job.
-- ---------------------------------------------------------------------------

create table ops.crm_opt_out_requests (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  company_id      uuid not null,
  conversation_id uuid not null,
  -- The opt-out message's task.
  task_id         uuid not null,
  -- The opt_out episode it opened or counted on: a person who dismisses it
  -- stops the record.
  exception_id    uuid not null references ops.exceptions (id) on delete cascade,
  due_at          timestamptz not null,
  job_id          uuid not null references ops.jobs (id) on delete restrict,
  outcome         text,
  settled_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint crm_opt_out_requests_conversation_fkey
    foreign key (tenant_id, company_id, conversation_id) references ops.conversations (tenant_id, company_id, id)
    on delete cascade,
  constraint crm_opt_out_requests_task_fkey
    foreign key (tenant_id, company_id, task_id) references ops.tasks (tenant_id, company_id, id)
    on delete cascade,
  constraint crm_opt_out_requests_task_key unique (task_id),
  constraint crm_opt_out_requests_job_key unique (job_id),
  constraint crm_opt_out_requests_outcome_check check (
    outcome is null or outcome in ('recorded', 'already_recorded', 'unresolved', 'dismissed', 'erased')),
  constraint crm_opt_out_requests_settle_shape check ((outcome is null) = (settled_at is null))
);

comment on table ops.crm_opt_out_requests is
  'ADR 0026 §C, SI-84: one request per opt-out message to record it in the CRM, due at the end of the 24-hour window and moved earlier when its acknowledgement''s send settles; bound to its opt_out episode and its one crm.opt_out_record job; settled once (recorded, already_recorded, unresolved, dismissed by a person, erased).';

create index crm_opt_out_requests_open_idx on ops.crm_opt_out_requests (tenant_id, conversation_id) where outcome is null;

-- Its identity never changes; it is settled once; its job may be moved while
-- it is open; it leaves only with its conversation.
create function ops.guard_crm_opt_out_request()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.outcome is not null or new.settled_at is not null then
      raise exception using errcode = 'OS403', message = 'ops.crm_opt_out_requests: a request is born open';
    end if;
    new.created_at := now();
    return new;
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from ops.conversations c where c.id = old.conversation_id) then
      raise exception using errcode = 'OS403', message = 'ops.crm_opt_out_requests: a request leaves only with its conversation';
    end if;
    return old;
  end if;
  if old.outcome is not null
     or (to_jsonb(new) - array['job_id', 'outcome', 'settled_at'])
        is distinct from (to_jsonb(old) - array['job_id', 'outcome', 'settled_at']) then
    raise exception using errcode = 'OS403',
      message = 'ops.crm_opt_out_requests: a request''s identity is immutable, and it is settled once';
  end if;
  if new.outcome is not null then
    new.settled_at := now();
  end if;
  return new;
end
$function$;

create trigger crm_opt_out_requests_guard
  before insert or update or delete on ops.crm_opt_out_requests
  for each row execute function ops.guard_crm_opt_out_request();
alter table ops.crm_opt_out_requests enable always trigger crm_opt_out_requests_guard;

create function ops.refuse_crm_opt_out_request_truncate()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  raise exception using errcode = 'OS403', message = 'ops.crm_opt_out_requests: the requests are never truncated';
end
$function$;

create trigger crm_opt_out_requests_refuse_truncate
  before truncate on ops.crm_opt_out_requests
  for each statement execute function ops.refuse_crm_opt_out_request_truncate();
alter table ops.crm_opt_out_requests enable always trigger crm_opt_out_requests_refuse_truncate;

-- The acts this slice records: the opt-out recorded, or why it was not.
alter table ops.crm_contact_acts drop constraint crm_contact_acts_act_check;
alter table ops.crm_contact_acts add constraint crm_contact_acts_act_check check (act in (
  'created', 'skipped:cap', 'skipped:no_cap', 'skipped:possible_match', 'skipped:error',
  'opted_out', 'opt_out_unresolved', 'opt_out_dismissed'));
alter table ops.crm_contact_acts drop constraint crm_contact_acts_created_names_contact;
alter table ops.crm_contact_acts add constraint crm_contact_acts_created_names_contact check (
  (act in ('created', 'opted_out')) = (crm_contact_ref is not null));
alter table ops.crm_contact_acts add constraint crm_contact_acts_opt_out_names_message check (
  (act in ('opted_out', 'opt_out_unresolved', 'opt_out_dismissed')) = (task_id is not null));

-- The internal kind: leased whatever stop is in force, as an opt-out is
-- protective.
create or replace function ops.internal_job_kinds()
returns text[]
language sql
immutable
set search_path to ''
as $function$
  select array['postmark.ledger_retention', 'content.retention_due', 'contact.identifier_retention_due',
               'crm.opt_out_record']::text[];
$function$;

-- ---------------------------------------------------------------------------
-- 3. The record: the CRM adapter, the one settlement the job and the erasure
--    share, the request the screening makes, the move the acknowledgement's
--    settlement makes, and the worker's capability.
-- ---------------------------------------------------------------------------

-- Sets the exact contact's do_not_contact to true and nothing else, with the
-- consent mark naming the opt-out message, even when it is already true (the
-- ledger's newest entry then names the newest opt-out). Answers recorded,
-- already_recorded or unresolved (no single contact for the number, no lead
-- profile, or a tenant that does not own the local CRM). Executable by no role.
create function ops.crm_record_opt_out(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_conversation_id uuid,
  p_channel_id      uuid,
  p_sender          text,
  p_task_id         uuid)
returns text
language plpgsql
volatile
security invoker
set search_path to ''
set lock_timeout to '2s'
as $function$
declare
  v_crm     jsonb;
  v_ref     text;
  v_contact bigint;
  v_was     boolean;
begin
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    v_crm := jsonb_build_object('state', 'unavailable');
  else
    v_crm := ops.crm_contact_by_phone(p_tenant_id, p_sender);
  end if;
  if v_crm ->> 'state' = 'found' then
    v_ref := v_crm ->> 'crm_contact_ref';
    v_contact := substring(v_ref from '^crm:contact:([0-9]{1,19})$')::bigint;
    select lp.do_not_contact into v_was from public.lead_profiles lp where lp.contact_id = v_contact for update;
  end if;
  if v_was is null then
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, task_id)
    values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opt_out_unresolved', p_task_id);
    return 'unresolved';
  end if;
  perform pg_catalog.set_config('ops.consent_origin', format('system_opt_out:task:%s', p_task_id), true);
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  perform pg_catalog.set_config('ops.consent_origin', '', true);
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref, task_id)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opted_out', v_ref, p_task_id);
  return case when v_was then 'already_recorded' else 'recorded' end;
end
$function$;

comment on function ops.crm_record_opt_out(uuid, uuid, uuid, uuid, text, uuid) is
  'ADR 0026 §C, SI-84: the worker''s one CRM write for an opt-out: resolves the exact contact afresh and sets lead_profiles.do_not_contact to true and nothing else, recorded in the consent ledger as the system''s, naming the opt-out message. Executable by no role.';

-- Settles one open request, its caller holding the conversation and the
-- request: a person's dismissal stops it; an erased number records nothing
-- (defensive: the erasure settles first); otherwise the opt-out is recorded,
-- its episode reconciled and lead.opted_out emitted. Not granted.
create function ops.settle_crm_opt_out_request(
  p_request ops.crm_opt_out_requests, p_conversation ops.conversations, p_actor text)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_outcome text;
begin
  if exists (select 1 from ops.exceptions e where e.id = p_request.exception_id and e.resolution = 'dismissed') then
    update ops.crm_opt_out_requests set outcome = 'dismissed' where id = p_request.id;
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, task_id)
    values (p_request.tenant_id, p_request.company_id, p_request.conversation_id, p_conversation.channel_id,
            'opt_out_dismissed', p_request.task_id);
    return 'dismissed';
  end if;
  if p_conversation.contact_erased_at is not null then
    update ops.crm_opt_out_requests set outcome = 'erased' where id = p_request.id;
    return 'erased';
  end if;
  v_outcome := ops.crm_record_opt_out(p_request.tenant_id, p_request.company_id, p_request.conversation_id,
                                      p_conversation.channel_id, p_conversation.contact_ref, p_request.task_id);
  update ops.crm_opt_out_requests set outcome = v_outcome where id = p_request.id;
  if v_outcome in ('recorded', 'already_recorded') then
    if exists (select 1 from ops.exceptions e where e.id = p_request.exception_id and e.resolved_at is null) then
      perform ops.close_exception(p_request.exception_id, 'reconciled', p_actor);
    end if;
  end if;
  if v_outcome = 'recorded' then
    perform ops.record_event(
      p_request.tenant_id, p_request.company_id, 'lead.opted_out', 'agent-runtime', 'task', p_request.task_id,
      '{}'::jsonb, null, null, format('lead:%s:opted_out', p_request.id));
  end if;
  return v_outcome;
end
$function$;

-- The screening's request, for the message that opted out, bound to the
-- conversation's open opt_out episode (opened or counted on just before) and
-- to one internal job due at the end of the 24-hour window. Not granted.
create function ops.request_crm_opt_out_record(
  p_tenant_id uuid, p_company_id uuid, p_conversation_id uuid, p_task_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_id        uuid := gen_random_uuid();
  v_exception uuid;
  v_due       timestamptz;
  v_job       uuid;
begin
  if exists (select 1 from ops.crm_opt_out_requests r where r.task_id = p_task_id) then
    return null;
  end if;
  select e.id into v_exception from ops.exceptions e
   where e.tenant_id = p_tenant_id and e.subject_id = p_conversation_id and e.kind = 'opt_out'
     and e.resolved_at is null;
  if v_exception is null then
    return null;
  end if;
  select coalesce(c.last_inbound_at, now()) + interval '24 hours' into v_due
    from ops.conversations c where c.tenant_id = p_tenant_id and c.id = p_conversation_id;
  v_job := ops.enqueue_job(p_tenant_id, 'crm.opt_out_record', jsonb_build_object('crm_opt_out_request_id', v_id),
                           100, v_due, 10, null);
  insert into ops.crm_opt_out_requests (id, tenant_id, company_id, conversation_id, task_id, exception_id, due_at, job_id)
  values (v_id, p_tenant_id, p_company_id, p_conversation_id, p_task_id, v_exception, v_due, v_job);
  return v_id;
end
$function$;

-- The acknowledgement's settlement: every open request of the conversation
-- for a message not newer than the acknowledged one becomes due now. Not
-- granted; answers how many jobs it moved.
create function ops.move_crm_opt_out_records(p_tenant_id uuid, p_conversation_id uuid, p_task_id uuid)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_ack   ops.inbound_messages;
  v_moved integer;
begin
  select m.* into v_ack from ops.inbound_messages m where m.tenant_id = p_tenant_id and m.task_id = p_task_id;
  if not found then
    return 0;
  end if;
  update ops.jobs j
     set available_at = now(), updated_at = now()
    from ops.crm_opt_out_requests r
    join ops.inbound_messages m on m.tenant_id = r.tenant_id and m.task_id = r.task_id
   where r.tenant_id = p_tenant_id and r.conversation_id = p_conversation_id and r.outcome is null
     and j.tenant_id = r.tenant_id and j.id = r.job_id and j.status = 'queued' and j.available_at > now()
     and (m.received_at, m.created_at) <= (v_ack.received_at, v_ack.created_at);
  get diagnostics v_moved = row_count;
  return v_moved;
end
$function$;

-- The worker's capability: the request the leased job is bound to. Takes the
-- conversation (share), its state row and the request in the screening's and
-- the erasure's order, so a screening, an erasure and the record never cross.
-- Answers recorded, already_recorded, unresolved, dismissed, erased, deferred
-- (not due, or an acknowledgement still on its way), superseded or
-- already_settled.
create function ops.record_due_opt_out()
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job  ops.jobs := ops.leased_job();
  v_req  ops.crm_opt_out_requests;
  v_conv ops.conversations;
  v_mine ops.inbound_messages;
  v_wait timestamptz;
begin
  if v_job.kind <> 'crm.opt_out_record' then
    raise exception using errcode = '42501', message = 'ops.record_due_opt_out: the leased job is not an opt-out record';
  end if;
  select r.* into v_req from ops.crm_opt_out_requests r
   where r.tenant_id = v_job.tenant_id and r.job_id = v_job.id;
  if not found then
    return 'superseded';
  end if;
  select c.* into v_conv from ops.conversations c
   where c.tenant_id = v_req.tenant_id and c.id = v_req.conversation_id
     for share;
  perform 1 from ops.conversation_states s
   where s.tenant_id = v_req.tenant_id and s.conversation_id = v_req.conversation_id
     for update;
  select r.* into v_req from ops.crm_opt_out_requests r where r.id = v_req.id for update;
  if v_req.outcome is not null then
    return 'already_settled';
  end if;
  if v_req.job_id is distinct from v_job.id then
    return 'superseded';
  end if;

  -- Not due, and not moved to now by its acknowledgement: wait.
  v_wait := case when v_job.available_at >= v_req.due_at and now() < v_req.due_at then v_req.due_at end;
  -- An acknowledgement of this opt-out (or a newer one) still on its way: the
  -- flag would refuse it, so wait, at most until it is out of date or the
  -- window ends; a stop holding it never holds the record past that.
  if v_wait is null then
    select m.* into v_mine from ops.inbound_messages m
     where m.tenant_id = v_req.tenant_id and m.task_id = v_req.task_id;
    select max(case when o.status = 'authorized' then o.fresh_until else now() + interval '1 minute' end)
      into v_wait
      from ops.outbound_messages o
      join ops.review_items ri on ri.tenant_id = o.tenant_id and ri.id = o.review_item_id
      join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
      join ops.inbound_messages am on am.tenant_id = ri.tenant_id and am.task_id = ri.task_id
     where o.tenant_id = v_req.tenant_id and o.conversation_id = v_req.conversation_id
       and s.fixed_message_key = 'opt_out_ack'
       and (am.received_at, am.created_at) >= (v_mine.received_at, v_mine.created_at)
       and ((o.status = 'authorized' and now() < o.fresh_until)
            or (o.status = 'sending' and o.sending_at > now() - interval '5 minutes'));
    if v_wait is not null then
      v_wait := least(v_wait, v_req.due_at);
    end if;
  end if;
  if v_wait is not null and v_wait > now() then
    update ops.crm_opt_out_requests
       set job_id = ops.enqueue_job(v_req.tenant_id, 'crm.opt_out_record',
                                    jsonb_build_object('crm_opt_out_request_id', v_req.id), 100, v_wait, 10, null)
     where id = v_req.id;
    return 'deferred';
  end if;

  return ops.settle_crm_opt_out_request(v_req, v_conv, 'agent-runtime');
end
$function$;

comment on function ops.record_due_opt_out() is
  'ADR 0026 §C, SI-84: the worker''s capability for crm.opt_out_record, bound to its request by the leased job; waits while the opt-out is not due or its acknowledgement is still on its way (at most until the acknowledgement is out of date or the window ends), records nothing for an opt-out a person dismissed, and otherwise records it in the CRM and reconciles its episode.';

-- ---------------------------------------------------------------------------
-- 4. The screening requests the record of every opt-out it detects. As
--    20261018120000, with the request.
-- ---------------------------------------------------------------------------

create or replace function ops.record_inbound_screening(p_screening jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt     integer := ops.agent_run_lease_attempt();
  v_tenant      uuid := ops.current_tenant_id();
  v_job         uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_keys        text[] := array['sanitizerVersion', 'packId', 'messageClass', 'safetyClass', 'safeText',
                                'sensitiveContentPresent', 'fullyBlocked', 'segmentsRedacted', 'segmentsSensitive',
                                'segmentsUnrecognised', 'administrativeIntent', 'humanRequested', 'optOutRequested',
                                'requiresHuman'];
  v_run         ops.agent_runs;
  v_policy      ops.agent_configuration_versions;
  v_playbook    ops.agent_configuration_versions;
  v_knowledge   ops.agent_configuration_versions;
  v_fixed       ops.agent_configuration_versions;
  v_inbound     ops.inbound_messages;
  v_state       ops.conversation_states;
  v_class       text;
  v_safety      text;
  v_text        text;
  v_sensitive   integer;
  v_unknown     integer;
  v_person      boolean;
  v_opt_out     boolean;
  v_admin       boolean;
  v_party       text := 'prospect';
  v_is_client   boolean;
  v_disposition text;
  v_key         text;
  v_reason      text;
  v_screening   uuid;
  v_context     jsonb;
  v_turns       jsonb;
  v_sched       jsonb;
  v_slots       jsonb;
  v_avail       text := 'not_configured';
  v_tz          text;
  v_booking     jsonb;
  v_turn_limit  integer;
  v_reachable   boolean;
  v_text_needed boolean := false;
  v_open        uuid;
  v_newest_dnc        boolean;
  v_newest_resolution text;
  v_waiting           boolean := false;
  v_crm               jsonb;
  v_review            uuid;
begin
  -- The input: exactly the screening the engine produces, nothing more.
  if p_screening is null or jsonb_typeof(p_screening) <> 'object'
     or (select count(*) from jsonb_object_keys(p_screening)) <> cardinality(v_keys)
     or exists (select 1 from jsonb_object_keys(p_screening) k where not (k = any (v_keys))) then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: the screening does not have the expected keys';
  end if;
  if jsonb_typeof(p_screening -> 'humanRequested') <> 'boolean'
     or jsonb_typeof(p_screening -> 'optOutRequested') <> 'boolean'
     or jsonb_typeof(p_screening -> 'administrativeIntent') <> 'boolean'
     or jsonb_typeof(p_screening -> 'segmentsSensitive') <> 'number'
     or jsonb_typeof(p_screening -> 'segmentsUnrecognised') <> 'number'
     or (p_screening ->> 'segmentsSensitive') !~ '^[0-9]{1,4}$'
     or (p_screening ->> 'segmentsUnrecognised') !~ '^[0-9]{1,4}$'
     or jsonb_typeof(p_screening -> 'safeText') not in ('string', 'null') then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: a screening field has the wrong type';
  end if;
  v_class     := p_screening ->> 'messageClass';
  v_safety    := p_screening ->> 'safetyClass';
  v_text      := p_screening ->> 'safeText';
  v_sensitive := (p_screening ->> 'segmentsSensitive')::integer;
  v_unknown   := (p_screening ->> 'segmentsUnrecognised')::integer;
  v_person    := (p_screening ->> 'humanRequested')::boolean;
  v_opt_out   := (p_screening ->> 'optOutRequested')::boolean;
  v_admin     := (p_screening ->> 'administrativeIntent')::boolean;
  if (v_class in ('administrative', 'mixed')) <> (v_text is not null) then
    raise exception using errcode = 'OS400',
      message = 'ops.record_inbound_screening: only an administrative or mixed screening carries text';
  end if;
  if (p_screening ->> 'segmentsRedacted') is distinct from (v_sensitive + v_unknown)::text then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: the counts do not add up';
  end if;

  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job for update;
  if not found then
    raise exception 'ops.record_inbound_screening: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.status <> 'pending' or v_run.capability <> 'lead_triage' then
    raise exception using errcode = 'OS409', message = 'ops.record_inbound_screening: only a pending lead triage run is screened';
  end if;
  v_policy := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'operating_policy');
  if v_policy.id is null then
    raise exception using errcode = 'OS409', message = 'ops.record_inbound_screening: the agent has no published operating policy';
  end if;
  if (p_screening ->> 'packId') is distinct from (v_policy.content ->> 'sanitizerPack') then
    raise exception using errcode = 'OS400', message = 'ops.record_inbound_screening: the screening used another pack than the policy names';
  end if;
  v_playbook  := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'playbook');
  v_knowledge := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'knowledge');
  v_fixed     := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'fixed_messages');

  -- The conversation, its state and the contact's party kind.
  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = v_tenant and m.task_id = v_run.task_id
   order by m.received_at desc limit 1;
  if v_inbound.conversation_id is not null then
    insert into ops.conversation_states (conversation_id, tenant_id, company_id)
    values (v_inbound.conversation_id, v_tenant, v_inbound.company_id)
    on conflict (conversation_id) do nothing;
    if v_inbound.contact_resolution in ('ambiguous', 'unavailable') then
      v_party := 'unknown';
    elsif v_inbound.contact_resolution = 'found' then
      v_is_client := ops.crm_contact_is_client(v_tenant, v_inbound.crm_contact_ref);
      v_party := case when v_is_client is null then 'unknown' when v_is_client then 'client' else 'prospect' end;
    end if;
    perform ops.move_conversation_state(v_inbound.conversation_id, 'party_kind', v_party, 'crm_lookup', 'front-desk');
    if exists (select 1 from ops.outbound_messages o
                where o.tenant_id = v_tenant and o.conversation_id = v_inbound.conversation_id
                  and o.status in ('sent', 'delivered', 'read')) then
      select s.* into v_state from ops.conversation_states s where s.conversation_id = v_inbound.conversation_id;
      if v_state.phase = 'new' then
        perform ops.move_conversation_state(v_inbound.conversation_id, 'phase', 'engaged', 'reply_sent', 'front-desk');
      end if;
    end if;
    select s.* into v_state from ops.conversation_states s where s.conversation_id = v_inbound.conversation_id;
    -- ADR 0021 W6 (a): a reply reaches only a contact the admission found in
    -- the CRM, not marked do-not-contact. Unknown is unreachable.
    v_reachable := not coalesce(v_inbound.do_not_contact, true);
  end if;

  -- The disposition.
  v_key := case
    when v_safety = 'crisis' then 'safety'
    when v_person then 'human_handoff_ack'
    when v_opt_out then 'opt_out_ack'
    when v_class = 'sensitive_only' then
      case when v_party = 'client' then 'sensitive_only_client' else 'sensitive_only_prospect' end
    when v_class = 'unknown' then 'clarification'
    else null end;
  if v_state.holder = 'person' then
    -- A conversation a person holds stays with the person, and the message
    -- waits for them. Only the protective texts are drafted whoever holds
    -- (ADR 0026 §A): the safety text, and the acknowledgement of an opt-out.
    v_waiting := true;
    v_key := case when v_safety = 'crisis' then 'safety' when v_opt_out then 'opt_out_ack' end;
  end if;
  -- ADR 0026 §B: a crisis after the conversation already got a safety text
  -- gets the second one, when the owner published it. The state row this
  -- screening holds orders concurrent screenings of one conversation.
  if v_key = 'safety' and v_inbound.conversation_id is not null
     and coalesce(v_fixed.content -> 'messages' ->> 'safety_followup', '') <> ''
     and exists (select 1 from ops.inbound_screenings p
                  where p.tenant_id = v_tenant and p.conversation_id = v_inbound.conversation_id
                    and p.agent_run_id <> v_run.id and p.disposition = 'fixed_reply'
                    and p.fixed_message_key in ('safety', 'safety_followup')) then
    v_key := 'safety_followup';
  end if;
  if v_waiting and v_key is null then
    v_disposition := 'held_for_person';
  else
    -- Owner decision, 2026-10-08: danger gets the fixed safety text and the
    -- conversation stays with the agent; it is no person's to take. In a
    -- conversation a person holds, the holder does not move.
    v_reason := case when v_waiting then null
                     when v_safety = 'crisis' then null
                     when v_person then 'person_requested'
                     when v_opt_out then 'opt_out' end;
    if not v_waiting and v_reason is null and v_safety <> 'crisis'
       and v_inbound.conversation_id is not null and not v_reachable then
      -- ADR 0025 A3: no reply can reach this contact, so neither a model nor a
      -- fixed text drafts one. The agent keeps the conversation: once the
      -- contact is reachable, the next message is answered as usual.
      v_disposition := 'held_for_person';
      v_key := null;
    elsif v_key is null then
      v_disposition := 'model';
    elsif v_fixed.id is null then
      -- Nobody published the fixed texts: a person answers.
      v_disposition := 'held_for_person';
      v_key := null;
      v_reason := case when v_waiting then null else coalesce(v_reason, 'operator') end;
      v_text_needed := true;
    else
      v_disposition := 'fixed_reply';
    end if;
    if v_reason is not null and v_inbound.conversation_id is not null then
      perform ops.move_conversation_state(v_inbound.conversation_id, 'holder', 'person', v_reason, 'front-desk');
    end if;
  end if;

  insert into ops.inbound_screenings (
    tenant_id, company_id, task_id, agent_run_id, conversation_id, screener_version, pack_id,
    message_class, safety_class, segments_redacted, segments_sensitive, segments_unrecognised,
    administrative_intent, person_requested, opt_out_requested, model_input, party_kind,
    disposition, fixed_message_key, policy_version_id, playbook_version_id, knowledge_version_id,
    fixed_messages_version_id)
  values (
    v_tenant, v_run.company_id, v_run.task_id, v_run.id, v_inbound.conversation_id,
    p_screening ->> 'sanitizerVersion', p_screening ->> 'packId',
    v_class, v_safety, v_sensitive + v_unknown, v_sensitive, v_unknown,
    v_admin, v_person, v_opt_out, v_text, v_party,
    v_disposition, v_key, v_policy.id, v_playbook.id, v_knowledge.id,
    case when v_disposition = 'fixed_reply' then v_fixed.id end)
  returning id into v_screening;

  -- ADR 0025 A2: what this message tells a person, whoever holds the
  -- conversation. An episode already open absorbs the repeat.
  if v_inbound.conversation_id is not null then
    if v_person then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'person_requested',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
    if v_opt_out then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'opt_out',
                                 v_inbound.conversation_id, null, null, 'front-desk');
      -- ADR 0026 §C: the opt-out reaches the CRM after its acknowledgement,
      -- bound to the episode just opened or counted on.
      perform ops.request_crm_opt_out_record(v_tenant, v_run.company_id, v_inbound.conversation_id, v_run.task_id);
    end if;
    if v_text_needed then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'configuration_missing',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
    -- Whether a reply can reach the contact now is the conversation's newest
    -- admission's answer, not this message's: messages are not screened in
    -- the order they arrived (several workers, a retry), and an older message
    -- must neither reconcile a newer refusal nor reopen a settled one.
    select m.do_not_contact, m.contact_resolution into v_newest_dnc, v_newest_resolution
      from ops.inbound_messages m
     where m.tenant_id = v_tenant and m.conversation_id = v_inbound.conversation_id
     order by m.received_at desc, m.created_at desc
     limit 1;
    if not coalesce(v_newest_dnc, true) then
      for v_open in
        select e.id from ops.exceptions e
         where e.tenant_id = v_tenant and e.conversation_id = v_inbound.conversation_id
           and e.kind in ('contact_unresolved', 'do_not_contact') and e.resolved_at is null
      loop
        perform ops.close_exception(v_open, 'reconciled', 'front-desk');
      end loop;
    elsif v_newest_resolution = 'found' then
      -- The admission stores an unknown consent (a contact with no lead
      -- profile) as unreachable, like an opt-out. Only the label needs the
      -- difference, so it asks the read-only CRM adapter again: a recorded
      -- flag is do_not_contact, an unknown one is not an opt-out.
      v_crm := ops.crm_contact_by_phone(
        v_tenant, (select c.contact_ref from ops.conversations c where c.id = v_inbound.conversation_id));
      if v_crm ->> 'state' = 'found' and jsonb_typeof(v_crm -> 'do_not_contact') = 'boolean' then
        perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'do_not_contact',
                                   v_inbound.conversation_id, null, null, 'front-desk');
      else
        perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'contact_unresolved',
                                   v_inbound.conversation_id, null,
                                   case when v_crm ->> 'state' in ('not_found', 'ambiguous', 'unavailable')
                                        then v_crm ->> 'state' else 'consent_unknown' end,
                                   'front-desk');
      end if;
    else
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'contact_unresolved',
                                 v_inbound.conversation_id, null,
                                 case when v_newest_resolution in ('not_found', 'ambiguous')
                                      then v_newest_resolution else 'unavailable' end,
                                 'front-desk');
    end if;
    -- Every message held because a person holds the conversation is counted
    -- for that person, whatever else is open: none waits unlisted.
    if v_waiting then
      perform ops.open_exception(v_tenant, v_run.company_id, v_run.task_id, 'message_waiting',
                                 v_inbound.conversation_id, null, null, 'front-desk');
    end if;
  end if;

  if v_disposition <> 'model' then
    v_context := ops.push_event_context('agent-runtime', null, null);
    update ops.agent_runs
       set status = 'cancelled', error_category = 'refused',
           error_code = case when v_disposition = 'fixed_reply' then 'front_desk_fixed_reply'
                             else 'front_desk_held_for_person' end
     where id = v_run.id;
    perform ops.pop_event_context(v_context);
    if v_disposition = 'fixed_reply' then
      v_review := ops.open_scripted_review(v_run, v_fixed.content -> 'messages' ->> v_key, 'fixed', v_key, 'agent-runtime');
      -- ADR 0026 §B: a text the owner listed for automatic sending is accepted
      -- as policy and carried by a job; the answer to the worker is unchanged.
      if coalesce(v_policy.content -> 'automaticFixedTexts', '[]'::jsonb) ? v_key then
        perform ops.authorize_fixed_reply(v_review);
      end if;
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'disposition', v_disposition, 'screeningId', v_screening, 'fixedMessageKey', v_key));
  end if;

  -- The bounded context: the earlier turns of this conversation as the model
  -- may see them, keyed on who wrote each reply (ADR 0026 §A): a contact's
  -- screened text; the agent's own reply, from a run whose screening went to
  -- the model; a fixed clarification, handoff or opt-out acknowledgement.
  -- Anything else is shown as the marker: a person's reply, the safety and
  -- sensitive-subject texts (each would say what the contact wrote, W1,
  -- SI-80), and any fixed text added later.
  v_turn_limit := least(greatest((v_policy.content ->> 'contextTurns')::integer, 0), 12);
  if v_inbound.conversation_id is not null and v_turn_limit > 0 then
    select coalesce(jsonb_agg(t.turn order by t.at), '[]'::jsonb) into v_turns
      from (
        select u.at, u.turn from (
          select m.received_at as at,
                 jsonb_build_object('role', 'contact', 'text',
                   (select s.model_input from ops.inbound_screenings s
                     where s.tenant_id = m.tenant_id and s.task_id = m.task_id
                     order by s.screened_at desc limit 1)) as turn
            from ops.inbound_messages m
           where m.tenant_id = v_tenant and m.conversation_id = v_inbound.conversation_id
             and m.task_id is distinct from v_run.task_id and m.received_at <= v_inbound.received_at
          union all
          select coalesce(o.sending_at, o.authorized_at) as at,
                 jsonb_build_object('role', 'agent', 'text',
                   case when ri.author = 'agent' and s.disposition = 'model'
                          then ri.proposed ->> 'response_draft'
                        when ri.author = 'fixed' and s.disposition = 'fixed_reply'
                             and s.fixed_message_key in ('clarification', 'human_handoff_ack', 'opt_out_ack')
                          then ri.proposed ->> 'response_draft' end) as turn
            from ops.outbound_messages o
            join ops.review_items ri on ri.tenant_id = o.tenant_id and ri.id = o.review_item_id
            left join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
           where o.tenant_id = v_tenant and o.conversation_id = v_inbound.conversation_id
             and o.status in ('sent', 'delivered', 'read')
        ) u
        order by u.at desc
        limit v_turn_limit
      ) t;
  end if;

  -- Availability, only from the booking foundation, never from a model.
  v_tz := coalesce((select p.timezone from ops.agent_profiles p
                     where p.tenant_id = v_tenant and p.agent_id = v_run.agent_id and p.superseded_at is null),
                   'UTC');
  v_sched := v_policy.content -> 'scheduling';
  if jsonb_typeof(v_sched) = 'object'
     and coalesce(v_sched ->> 'resourceId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and coalesce(v_sched ->> 'bookingTypeId', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    begin
      select coalesce(jsonb_agg(to_char(sl.start_at at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI') order by sl.start_at),
                      '[]'::jsonb)
        into v_slots
        from ops.available_slots(
               v_tenant, (v_sched ->> 'resourceId')::uuid, (v_sched ->> 'bookingTypeId')::uuid, now(),
               now() + make_interval(days => 14), 10) sl;
      v_avail := 'connected';
    exception when others then
      v_slots := null;
      v_avail := 'unavailable';
    end;
  end if;
  if v_inbound.conversation_id is not null then
    select jsonb_build_object('startsAt', to_char(b.start_at at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'))
      into v_booking
      from ops.bookings b
     where b.tenant_id = v_tenant and b.conversation_id = v_inbound.conversation_id
       and b.status = 'booked' and b.start_at > now()
     order by b.start_at
     limit 1;
  end if;

  return jsonb_build_object(
    'disposition', 'model',
    'screeningId', v_screening,
    'context', jsonb_build_object(
      'message', v_text,
      -- When the contact wrote, as the business's clock reads it: "today",
      -- "tomorrow" and "this week" mean something only against it.
      'receivedAt', to_char(v_inbound.received_at at time zone v_tz, 'YYYY-MM-DD"T"HH24:MI'),
      'partyKind', v_party,
      'phase', coalesce(v_state.phase, 'new'),
      'turns', coalesce(v_turns, '[]'::jsonb),
      'policy', v_policy.content,
      'playbook', v_playbook.content,
      'knowledge', v_knowledge.content,
      'availability', jsonb_strip_nulls(jsonb_build_object(
        'status', v_avail, 'timezone', v_tz, 'slots', v_slots)),
      'upcomingBooking', v_booking));
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. The review says what follows the acknowledgement, and an automatic
--    acknowledgement of an opt-out a person dismissed is stale. As
--    20261018120000, with each.
-- ---------------------------------------------------------------------------

create or replace function ops.open_scripted_review(
  p_run ops.agent_runs, p_draft text, p_kind text, p_key text, p_source text)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_proposed jsonb;
  v_dnc      boolean;
  v_review   uuid;
  v_revision integer;
begin
  if p_kind is null or p_kind not in ('fixed', 'person') or (p_kind = 'fixed') <> (p_key is not null) then
    raise exception using errcode = 'OS400', message = 'ops.open_scripted_review: a fixed text names its key; a person''s reply names none';
  end if;
  v_proposed := jsonb_build_object(
    'outcome', case when p_key = 'clarification' then 'needs_input' else 'triaged' end,
    'summary', case when p_kind = 'person'
                    then 'A reply written by a person.'
                    else format('Fixed reply %s; no model was called.', p_key) end,
    'intent', 'other',
    'priority', case when p_key in ('safety', 'safety_followup') then 'high' else 'normal' end,
    'recommended_next_action', case p_key
      when 'safety' then 'Send the safety text.'
      when 'safety_followup' then 'Send the safety text.'
      when 'human_handoff_ack' then 'A person takes over this conversation.'
      when 'opt_out_ack' then 'Send the acknowledgement; the opt-out is recorded after it unless you dismiss the exception.'
      else 'Send the reply after review.' end,
    'response_draft', p_draft,
    'needs_human_review', true,
    'flags', case p_key when 'safety' then '["possible_crisis"]'::jsonb
                        when 'safety_followup' then '["possible_crisis"]'::jsonb
                        when 'clarification' then '["unclear"]'::jsonb
                        else '[]'::jsonb end);
  if not ops.agent_run_result_valid('lead_triage', v_proposed) then
    raise exception using errcode = 'OS400', message = 'ops.open_scripted_review: the reply does not fit the review contract';
  end if;
  select coalesce(bool_or(m.do_not_contact), true) into v_dnc
    from ops.inbound_messages m
   where m.tenant_id = p_run.tenant_id and m.task_id = p_run.task_id;
  if p_kind = 'fixed' then
    insert into ops.review_items (
      tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact, author)
    values (p_run.tenant_id, p_run.company_id, p_run.task_id, p_run.id, 'lead_triage', v_proposed, v_dnc, 'fixed')
    on conflict (agent_run_id) where author <> 'person' do nothing
    returning id into v_review;
    if v_review is null then
      raise exception using errcode = 'OS409', message = 'ops.open_scripted_review: this run already has its review';
    end if;
  else
    -- The person's own act names the revision the person saw.
    v_revision := nullif(current_setting('ops.person_reply_revision', true), '')::integer;
    -- At most five replies in a row: a new message from the contact, even one
    -- the store refused, moves the revision and opens room for five more.
    if (select count(*) from ops.review_items ri
         where ri.tenant_id = p_run.tenant_id and ri.agent_run_id = p_run.id and ri.author = 'person'
           and ri.conversation_revision = v_revision) >= 5 then
      raise exception using errcode = 'OS409', message = 'ops.open_scripted_review: five replies from a person already answer this revision';
    end if;
    insert into ops.review_items (
      tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact, author, conversation_revision)
    values (p_run.tenant_id, p_run.company_id, p_run.task_id, p_run.id, 'lead_triage', v_proposed, v_dnc, 'person', v_revision)
    returning id into v_review;
  end if;
  perform ops.record_event(
    p_run.tenant_id, p_run.company_id, 'lead_triage.review_pending', p_source, 'task', p_run.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', p_run.id),
    p_run.correlation_id, null, format('review:%s:pending', v_review));
  return v_review;
end
$function$;

create or replace function ops.cos_review_superseded(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select case
  -- A person's reply: stale only when the contact wrote again, admitted or
  -- refused, after the conversation revision the person saw. A refused
  -- message inside that revision does not make it stale.
  when p_item.author = 'person' then coalesce((
    select ops.cos_conversation_revision(p_tenant_id, mine.conversation_id) > p_item.conversation_revision
      from ops.inbound_messages mine
     where mine.tenant_id = p_tenant_id and mine.task_id = p_item.task_id and mine.conversation_id is not null
     order by mine.received_at desc
     limit 1), true)
  -- A reply a person's reply already answered.
  when ops.cos_review_answered_by_person(p_tenant_id, p_item) then true
  -- ADR 0026 §B: an automatic safety text, handoff or opt-out acknowledgement
  -- answers the request, not the words around it. Only a newer automatic text
  -- of its family makes it stale (the two safety texts are one family), and a
  -- safety text also an opt-out on a newer message.
  when p_item.decision_basis = 'published_fixed_text' and exists (
         select 1 from ops.inbound_screenings s
          where s.tenant_id = p_tenant_id and s.agent_run_id = p_item.agent_run_id
            and s.fixed_message_key in ('safety', 'safety_followup', 'human_handoff_ack', 'opt_out_ack')) then
    coalesce((
      select exists (
               select 1
                 from ops.review_items other
                 join ops.inbound_screenings os on os.tenant_id = other.tenant_id and os.agent_run_id = other.agent_run_id
                 join ops.inbound_messages om on om.tenant_id = other.tenant_id and om.task_id = other.task_id
                where other.tenant_id = p_tenant_id and other.id <> p_item.id
                  and other.decision_basis = 'published_fixed_text'
                  and om.conversation_id = mine.conversation_id
                  and (case when os.fixed_message_key in ('safety', 'safety_followup') then 'safety' else os.fixed_message_key end)
                    = (case when ms.fixed_message_key in ('safety', 'safety_followup') then 'safety' else ms.fixed_message_key end)
                  and (om.received_at > mine.received_at
                       or (om.received_at = mine.received_at and om.created_at > mine.created_at)))
          -- ADR 0026 §C: an acknowledgement of an opt-out a person dismissed.
          or (ms.fixed_message_key = 'opt_out_ack' and exists (
               select 1
                 from ops.crm_opt_out_requests q
                 join ops.exceptions e on e.id = q.exception_id
                where q.tenant_id = p_tenant_id and q.task_id = mine.task_id and e.resolution = 'dismissed'))
          or (ms.fixed_message_key in ('safety', 'safety_followup') and exists (
               select 1
                 from ops.inbound_screenings os
                 join ops.inbound_messages om on om.tenant_id = os.tenant_id and om.task_id = os.task_id
                where os.tenant_id = p_tenant_id and os.conversation_id = mine.conversation_id
                  and os.opt_out_requested
                  and (om.received_at > mine.received_at
                       or (om.received_at = mine.received_at and om.created_at > mine.created_at))))
        from ops.inbound_messages mine
        join ops.inbound_screenings ms on ms.tenant_id = mine.tenant_id and ms.agent_run_id = p_item.agent_run_id
       where mine.tenant_id = p_tenant_id and mine.task_id = p_item.task_id and mine.conversation_id is not null
       order by mine.received_at desc
       limit 1), true)
  else exists (
    select 1
      from ops.inbound_messages mine
      join ops.conversations c
        on c.tenant_id = mine.tenant_id and c.id = mine.conversation_id
      -- The admission's own fact: the first event of the task it created.
      cross join lateral (
        select pg_catalog.min(e.seq) as seq
          from ops.events e
         where e.tenant_id = mine.tenant_id and e.subject_type = 'task' and e.subject_id = mine.task_id) admitted
     where mine.tenant_id = p_tenant_id
       and mine.task_id = p_item.task_id
       and mine.conversation_id is not null
       and (
         -- a. A newer message by the provider's clock, admitted or refused.
         c.last_inbound_at > mine.received_at
         -- b. The same instant, admitted after it.
         or exists (
           select 1 from ops.inbound_messages later
            where later.tenant_id = mine.tenant_id
              and later.conversation_id = mine.conversation_id
              and later.id <> mine.id
              and (later.received_at > mine.received_at
                   or (later.received_at = mine.received_at and later.created_at > mine.created_at)))
         -- c. A message the database recorded after it, whatever its
         --    timestamp: admitted ...
         or exists (
           select 1
             from ops.inbound_messages later
            cross join lateral (
              select pg_catalog.min(e.seq) as seq
                from ops.events e
               where e.tenant_id = later.tenant_id and e.subject_type = 'task' and e.subject_id = later.task_id) la
            where later.tenant_id = mine.tenant_id
              and later.conversation_id = mine.conversation_id
              and later.id <> mine.id
              and la.seq > admitted.seq)
         --    ... or refused on the record.
         or exists (
           select 1 from ops.events e
            where e.tenant_id = mine.tenant_id
              and e.company_id = c.company_id
              and e.seq > admitted.seq
              and e.type = 'communication.inbound_refused'
              and e.payload ->> 'conversation_id' = mine.conversation_id::pg_catalog.text)))
  end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The acknowledgement's settlement makes its opt-out due now. As
--    20261018120000, with the move.
-- ---------------------------------------------------------------------------

create or replace function ops.sync_send_exceptions(p_tenant_id uuid, p_outbound_id uuid, p_actor text)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_out    ops.outbound_messages;
  v_open   uuid;
  v_opened integer := 0;
  v_closed integer := 0;
  v_expired text;
begin
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = p_tenant_id and o.id = p_outbound_id
     for update;
  if not found then
    return jsonb_build_object('opened', 0, 'closed', 0);
  end if;

  if v_out.status = 'indeterminate'
     or (v_out.status = 'sending' and v_out.sending_at <= now() - interval '5 minutes') then
    if not exists (select 1 from ops.exceptions e
                    where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
                      and e.kind = 'send_indeterminate') then
      if ops.open_exception(v_out.tenant_id, v_out.company_id, v_out.task_id, 'send_indeterminate',
                            v_out.conversation_id, v_out.id, null, p_actor) is not null then
        v_opened := v_opened + 1;
      end if;
    end if;
  elsif v_out.status in ('sent', 'delivered', 'read', 'failed') then
    for v_open in
      select e.id from ops.exceptions e
       where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
         and e.kind = 'send_indeterminate' and e.resolved_at is null
    loop
      if ops.close_exception(v_open, 'reconciled', p_actor) then
        v_closed := v_closed + 1;
      end if;
    end loop;
  end if;

  -- ADR 0026 §B: an automatic text that did not leave waits for a person,
  -- unless the contact's newer message made it stale. One its job could not
  -- begin while it was fresh (the job retired, or no worker took it) is
  -- blocked now, on the record.
  if v_out.job_id is not null and v_out.status = 'authorized' and now() >= v_out.fresh_until
     and not exists (select 1 from ops.jobs j
                      where j.tenant_id = v_out.tenant_id and j.id = v_out.job_id
                        and j.status = 'leased' and j.lease_expires_at > now()) then
    v_expired := case when exists (select 1 from ops.review_items ri
                                    where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                                      and ops.cos_review_superseded(v_out.tenant_id, ri))
                      then 'newer_message' else 'fixed_text_expired' end;
    update ops.outbound_messages
       set status = 'blocked', blocked_reason = v_expired,
           send_check = jsonb_build_object('eligible', false, 'reason', v_expired)
     where id = v_out.id
    returning * into v_out;
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_blocked', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id, 'reason', v_expired));
  end if;
  if v_out.job_id is not null and v_out.status = 'blocked' and v_out.blocked_reason is distinct from 'newer_message'
     and not exists (select 1 from ops.exceptions e
                      where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
                        and e.kind = 'send_blocked') then
    if ops.open_exception(v_out.tenant_id, v_out.company_id, v_out.task_id, 'send_blocked',
                          v_out.conversation_id, v_out.id, null, p_actor) is not null then
      v_opened := v_opened + 1;
    end if;
  end if;

  if v_out.status = 'failed' and v_out.error_class is distinct from 'newer_message' then
    if not exists (select 1 from ops.exceptions e
                    where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
                      and e.kind = 'send_failed') then
      if ops.open_exception(v_out.tenant_id, v_out.company_id, v_out.task_id, 'send_failed',
                            v_out.conversation_id, v_out.id, null, p_actor) is not null then
        v_opened := v_opened + 1;
      end if;
    end if;
  elsif v_out.status in ('delivered', 'read') then
    for v_open in
      select e.id from ops.exceptions e
       where e.tenant_id = v_out.tenant_id and e.outbound_message_id = v_out.id
         and e.kind = 'send_failed' and e.resolved_at is null
    loop
      if ops.close_exception(v_open, 'reconciled', p_actor) then
        v_closed := v_closed + 1;
      end if;
    end loop;
  end if;

  -- ADR 0026 §C: an acknowledgement of an opt-out that settled (but for a
  -- newer message's, whose own acknowledgement decides) makes every opt-out of
  -- the conversation up to its message due now.
  if v_out.status in ('sent', 'delivered', 'read', 'failed', 'indeterminate', 'blocked')
     and v_out.blocked_reason is distinct from 'newer_message'
     and v_out.error_class is distinct from 'newer_message'
     and exists (select 1
                   from ops.review_items ri
                   join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
                  where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                    and s.fixed_message_key = 'opt_out_ack') then
    perform ops.move_crm_opt_out_records(v_out.tenant_id, v_out.conversation_id, v_out.task_id);
  end if;

  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end
$function$;

-- ---------------------------------------------------------------------------
-- 7. A number's erasure settles its pending opt-out first. As
--    20261010120000, with the settlement.
-- ---------------------------------------------------------------------------

create or replace function ops.erase_contact_identifier(p_tenant_id uuid, p_conversation_id uuid, p_reason text, p_actor text)
returns text
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv ops.conversations;
  v_row  ops.contact_identifier_retention;
  v_at   timestamptz;
  v_req  ops.crm_opt_out_requests;
begin
  if p_reason is null or p_reason not in ('retention_expired', 'erasure') then
    raise exception using errcode = 'OS400', message = 'ops.erase_contact_identifier: unknown reason';
  end if;
  select c.* into v_conv from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = p_conversation_id
     for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.erase_contact_identifier: conversation not found in this tenant';
  end if;
  if v_conv.contact_erased_at is not null then
    return 'already_erased';
  end if;
  select r.* into v_row from ops.contact_identifier_retention r
   where r.conversation_id = v_conv.id
     for update;
  if not found then
    perform ops.refresh_contact_identifier_retention(v_conv.id);
    select r.* into v_row from ops.contact_identifier_retention r where r.conversation_id = v_conv.id for update;
  end if;
  if p_reason = 'retention_expired' and v_row.due_at > clock_timestamp() then
    return 'not_due';
  end if;
  -- ADR 0026 §C: an opt-out still to be recorded is recorded now, while the
  -- number still resolves the contact (or records nothing, if a person
  -- dismissed it); an erased number is never written to afterwards.
  for v_req in
    select r.* from ops.crm_opt_out_requests r
     where r.tenant_id = p_tenant_id and r.conversation_id = v_conv.id and r.outcome is null
     order by r.created_at, r.id
       for update
  loop
    perform ops.settle_crm_opt_out_request(v_req, v_conv, p_actor);
  end loop;
  v_at := clock_timestamp();
  update ops.contact_identifier_retention
     set erased_at = v_at, erasure_reason = p_reason, erased_by = p_actor
   where id = v_row.id;
  update ops.conversations
     set contact_ref = 'erased:' || id::text, contact_erased_at = v_at
   where id = v_conv.id;
  update ops.inbound_messages
     set contact_ref = 'erased:' || p_conversation_id::text, contact_erased_at = v_at
   where tenant_id = p_tenant_id and conversation_id = p_conversation_id and contact_erased_at is null;
  return 'erased';
end
$function$;

-- ---------------------------------------------------------------------------
-- 8. The browser knows lead.opted_out, which carries no facts. As
--    20261019120000, with the new type.
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
    'follow_up.scheduled', 'follow_up.due', 'follow_up.completed', 'follow_up.cancelled', 'follow_up.superseded',
    'booking.created', 'booking.rescheduled', 'booking.cancelled',
    'calendar.sync_requested', 'calendar.sync_completed', 'calendar.sync_failed', 'calendar.sync_indeterminate',
    'calendar.sync_skipped',
    'exception.raised', 'exception.resolved',
    'lead.created', 'lead.opted_out');
$$;

-- ---------------------------------------------------------------------------
-- 9. Access, and the end state.
-- ---------------------------------------------------------------------------

alter table ops.crm_opt_out_requests enable row level security;
alter table ops.crm_opt_out_requests force row level security;
revoke all on table ops.crm_opt_out_requests from public, anon, authenticated, service_role, ops_worker, ops_gateway;

revoke all on function ops.guard_crm_opt_out_request() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.refuse_crm_opt_out_request_truncate()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.crm_record_opt_out(uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.settle_crm_opt_out_request(ops.crm_opt_out_requests, ops.conversations, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.request_crm_opt_out_record(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.move_crm_opt_out_records(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- The worker's one new capability: its alone.
revoke all on function ops.record_due_opt_out() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function ops.record_due_opt_out() to ops_worker;

do $end_state$
declare
  v_bad  text;
  v_role text;
begin
  -- The capability is a pinned DEFINER only the worker executes; the adapter
  -- and the helpers are INVOKERs no role reaches, PUBLIC included.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.record_due_opt_out()'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""'])
     or not pg_catalog.has_function_privilege('ops_worker', 'ops.record_due_opt_out()', 'EXECUTE')
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_gateway'),
                                      ('ops_operator_api')) as r (rolname)
                 where pg_catalog.has_function_privilege(r.rolname, 'ops.record_due_opt_out()', 'EXECUTE'))
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'ops.record_due_opt_out()'::pg_catalog.regprocedure and a.grantee = 0) then
    raise exception 'the opt-out record capability is not a pinned DEFINER the worker alone executes';
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array[
           'ops.crm_record_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure,
           'ops.settle_crm_opt_out_request(ops.crm_opt_out_requests, ops.conversations, text)'::pg_catalog.regprocedure,
           'ops.request_crm_opt_out_record(uuid, uuid, uuid, uuid)'::pg_catalog.regprocedure,
           'ops.move_crm_opt_out_records(uuid, uuid, uuid)'::pg_catalog.regprocedure,
           'ops.guard_crm_opt_out_request()'::pg_catalog.regprocedure])
     and (p.prosecdef
          or p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'an opt-out record function is reachable or not an INVOKER: %', v_bad;
  end if;

  -- The request table: row security on and forced, no role holds anything,
  -- its two guards ALWAYS.
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = 'ops.crm_opt_out_requests'::pg_catalog.regclass
                    and c.relrowsecurity and c.relforcerowsecurity)
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                 where pg_catalog.has_table_privilege(r.rolname, 'ops.crm_opt_out_requests',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'))
     or (select count(*) from pg_catalog.pg_trigger t
          where t.tgrelid = 'ops.crm_opt_out_requests'::pg_catalog.regclass
            and not t.tgisinternal and t.tgenabled = 'A') <> 2 then
    raise exception 'the opt-out requests are reachable, their row security is off, or a guard is missing';
  end if;

  -- The consent ledger: RLS on, no policy, nothing for any application role,
  -- its three triggers enabled, and empty (no history is fabricated).
  if not (select c.relrowsecurity from pg_catalog.pg_class c
           where c.oid = 'public.lead_consent_changes'::pg_catalog.regclass)
     or exists (select 1 from pg_catalog.pg_policy p
                 where p.polrelid = 'public.lead_consent_changes'::pg_catalog.regclass) then
    raise exception 'public.lead_consent_changes must have RLS on and no policy';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_table_privilege(v_role, 'public.lead_consent_changes',
         'select, insert, update, delete, truncate, references, trigger')
       or pg_catalog.has_sequence_privilege(v_role, 'public.lead_consent_changes_id_seq', 'usage, select, update')
       or pg_catalog.has_function_privilege(v_role, 'public.record_lead_consent_change()', 'execute')
       or pg_catalog.has_function_privilege(v_role, 'public.lead_consent_changes_append_only()', 'execute') then
      raise exception '% holds a privilege on the consent ledger', v_role;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
              where p.oid in ('public.record_lead_consent_change()'::pg_catalog.regprocedure,
                              'public.lead_consent_changes_append_only()'::pg_catalog.regprocedure)
                and a.grantee = 0)
     or not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = 'public.record_lead_consent_change()'::pg_catalog.regprocedure and p.prosecdef) then
    raise exception 'the consent ledger''s writer is not a DEFINER, or PUBLIC executes a ledger function';
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O'
         and ((t.tgrelid = 'public.lead_profiles'::pg_catalog.regclass and t.tgname = 'record_lead_consent_change_trigger')
           or (t.tgrelid = 'public.lead_consent_changes'::pg_catalog.regclass
               and t.tgname in ('lead_consent_changes_append_only_trigger',
                                'lead_consent_changes_refuse_truncate_trigger')))) <> 3 then
    raise exception 'the consent ledger''s triggers are missing or disabled';
  end if;
  if exists (select 1 from public.lead_consent_changes) then
    raise exception 'public.lead_consent_changes must start empty: no history is fabricated';
  end if;

  -- The kind is internal and no task may request it.
  if not ('crm.opt_out_record' = any (ops.internal_job_kinds()))
     or 'crm.opt_out_record' = any (ops.task_executable_kinds())
     or ops.internal_job_kinds() && ops.external_job_kinds() then
    raise exception 'crm.opt_out_record is not exactly an internal, non-task kind';
  end if;

  -- The screening requests the record, the acknowledgement moves it, the
  -- erasure settles it first; the screening keeps its definer and its grantee.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.record_inbound_screening(jsonb)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, 'ops.request_crm_opt_out_record') > 0
                    and pg_catalog.strpos(p.prosrc, 'ops.authorize_fixed_reply') > 0)
     or not pg_catalog.has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.sync_send_exceptions(uuid, uuid, text)'::pg_catalog.regprocedure),
                          'ops.move_crm_opt_out_records') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.erase_contact_identifier(uuid, uuid, text, text)'::pg_catalog.regprocedure),
                          'ops.settle_crm_opt_out_request') = 0 then
    raise exception 'the screening, the acknowledgement or the erasure does not reach the opt-out record';
  end if;

  if not ops.cos_event_known('lead.opted_out') then
    raise exception 'lead.opted_out is not known to the browser';
  end if;
end
$end_state$;
