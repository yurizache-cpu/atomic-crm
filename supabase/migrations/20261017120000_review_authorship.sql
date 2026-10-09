-- ADR 0026 §A (slice 1): who wrote a review, and a person's reply to the
-- newest message.
--
--   * ops.review_items.author records who wrote a review: the agent's model
--     (`agent`), the owner's published fixed text (`fixed`) or a person
--     (`person`). It is backfilled exactly from each run's ending, immutable
--     afterwards, and bound at insert: a fixed text only on a run the front
--     desk settled with one, a person's reply only inside its own act, and
--     the agent never on a run the front desk settled without a model. No
--     review opens on a redacted task (SI-72).
--   * The model's earlier turns become an allowlist keyed on that author: the
--     agent's own reply (from a run whose screening went to the model), and
--     the clarification, handoff and opt-out acknowledgements verbatim;
--     anything else, a person's reply included, as the neutral marker. A key
--     added later stays hidden (W1, SI-80).
--   * A person replies to the newest admitted message of a conversation the
--     person holds, while Meta's 24-hour window is open, naming the
--     conversation revision the person saw: the count of the contact's
--     messages, admitted or refused. The reply is stale only when the contact
--     wrote again after that revision; a refused message (an audio, an image)
--     inside it does not make it stale. Up to five person replies per
--     message and revision; a run still waiting (an execution stop, an idle
--     worker) does not hold the person back. A reply the agent or a fixed
--     text drafted for that message is stale once a person replied to it,
--     but for the safety text and the opt-out acknowledgement, which only
--     the contact's next message makes stale.
--   * One review per run but a person's: a partial unique index, and every
--     review event is keyed on the review, never the run. Everything that
--     looks a review up by its run reads the agent's review.
--   * The safety text and the opt-out acknowledgement are drafted whoever
--     holds the conversation; the message still waits for the person. A
--     refused message in a conversation a person holds is counted on
--     message_waiting too.
--
-- Nothing here sends, reaches a model, writes the CRM or adds a capability to
-- an application role. No exposed function changes: this is not an OD-8a
-- migration.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. Who wrote a review, and the revision a person's reply answered.
-- ---------------------------------------------------------------------------

alter table ops.review_items add column author text;
alter table ops.review_items add column conversation_revision integer;

-- The backfill passes the update guard once: this body admits exactly a first
-- fill of the two new columns and nothing else. It is replaced again below,
-- in this transaction, before anything else can write the table.
create or replace function ops.guard_review_item_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  if old.author is null and new.author is not null
     and (to_jsonb(new) - array['author', 'conversation_revision'])
         is not distinct from (to_jsonb(old) - array['author', 'conversation_revision']) then
    return new;
  end if;
  raise exception using errcode = 'OS403', message = 'ops.review_items: only the authorship backfill may write now';
end
$function$;

-- Each run's ending says who wrote its review: the front desk settles a fixed
-- text and a person's reply on runs it cancelled, the agent's model answers
-- on a run that succeeded. A person's reply written before this migration
-- keeps the verdict of the stale rule it was written under (20261013120000,
-- still installed here; section 4 replaces it): a stale one gets revision 0,
-- which every conversation has passed, a fresh one the conversation's
-- current revision, which its contact's next message passes.
update ops.review_items ri
   set author = case r.error_code
                  when 'front_desk_fixed_reply' then 'fixed'
                  when 'front_desk_held_for_person' then 'person'
                  else 'agent' end,
       conversation_revision = case when r.error_code is distinct from 'front_desk_held_for_person' then null
                                    when ops.cos_review_superseded(ri.tenant_id, ri) then 0
                                    else coalesce((
         select (select count(*) from ops.inbound_messages m
                  where m.tenant_id = ri.tenant_id and m.conversation_id = i.conversation_id)
              + (select count(*) from ops.events e
                  where e.tenant_id = ri.tenant_id and e.type = 'communication.inbound_refused'
                    and e.payload ->> 'conversation_id' = i.conversation_id::text)
           from ops.inbound_messages i
          where i.tenant_id = ri.tenant_id and i.task_id = ri.task_id and i.conversation_id is not null
          order by i.received_at desc
          limit 1), 0) end
  from ops.agent_runs r
 where r.tenant_id = ri.tenant_id and r.id = ri.agent_run_id;
-- A review whose run no longer exists (never on a deployment; only a test
-- fixture builds one) was the agent's.
update ops.review_items set author = 'agent' where author is null;

alter table ops.review_items alter column author set default 'agent';
alter table ops.review_items alter column author set not null;
alter table ops.review_items add constraint review_items_author_check
  check (author in ('agent', 'fixed', 'person'));
alter table ops.review_items add constraint review_items_person_revision
  check ((author = 'person') = (conversation_revision is not null)
         and (conversation_revision is null or conversation_revision >= 0));

comment on column ops.review_items.author is
  'ADR 0026: who wrote the review: agent (the agent''s model), fixed (a published fixed text) or person (a person''s own reply). Immutable; bound at insert by ops.guard_review_item_insert.';
comment on column ops.review_items.conversation_revision is
  'ADR 0026: for a person''s reply, the conversation revision the person saw (ops.cos_conversation_revision). The reply is stale once the conversation has moved past it.';

-- The latest guard (20261002120000), with who wrote it and the revision it
-- answered among what is immutable.
create or replace function ops.guard_review_item_update()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- D7: a recorded redaction removes content and changes nothing else.
  if ops.content_redaction_permitted(to_jsonb(old), to_jsonb(new), array['proposed', 'decision_note'], old.tenant_id, old.task_id) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.task_id is distinct from old.task_id
     or new.agent_run_id is distinct from old.agent_run_id
     or new.capability is distinct from old.capability
     or new.proposed is distinct from old.proposed
     or new.do_not_contact is distinct from old.do_not_contact
     or new.author is distinct from old.author
     or new.conversation_revision is distinct from old.conversation_revision
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'OS403',
      message = 'ops.review_items: what was reviewed is immutable';
  end if;
  if old.status <> 'pending' then
    raise exception using
      errcode = 'OS409',
      message = format('ops.review_items: this item is already %s, and a decision is final', old.status);
  end if;
  if new.status = 'pending' then
    raise exception using
      errcode = 'OS403',
      message = 'ops.review_items: a decision is a decision; it cannot answer pending';
  end if;
  new.updated_at := now();
  return new;
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. Who wrote it is bound at insert. A tripwire on the database's own code
--    (no application role writes this table): the earlier turns trust it.
-- ---------------------------------------------------------------------------

create function ops.guard_review_item_insert()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run ops.agent_runs;
begin
  -- SI-72: a redacted task's content is gone; nothing new is written about it.
  if exists (select 1 from ops.tasks t
              where t.tenant_id = new.tenant_id and t.id = new.task_id and t.content_redacted_at is not null) then
    raise exception using errcode = 'OS409', message = 'ops.review_items: no review opens on a redacted task';
  end if;
  select r.* into v_run from ops.agent_runs r where r.tenant_id = new.tenant_id and r.id = new.agent_run_id;
  if new.author = 'fixed' then
    -- A fixed text only on a run the front desk settled with one.
    if v_run.id is null or v_run.status <> 'cancelled' or v_run.error_code is distinct from 'front_desk_fixed_reply'
       or not exists (select 1 from ops.inbound_screenings s
                       where s.tenant_id = new.tenant_id and s.agent_run_id = new.agent_run_id
                         and s.disposition = 'fixed_reply') then
      raise exception using errcode = 'OS403', message = 'ops.review_items: a fixed text answers only a run the front desk settled with one';
    end if;
  elsif new.author = 'person' then
    -- A person's reply only inside its own act, which marks the transaction
    -- with the revision the person saw (ops.record_person_reply).
    if v_run.id is null
       or coalesce(current_setting('ops.person_reply_revision', true), '') <> coalesce(new.conversation_revision::text, '-') then
      raise exception using errcode = 'OS403', message = 'ops.review_items: a person''s reply is written only by its own act';
    end if;
  elsif v_run.error_code in ('front_desk_fixed_reply', 'front_desk_held_for_person') then
    -- The agent's model never answered a run the front desk settled without one.
    raise exception using errcode = 'OS403', message = 'ops.review_items: the agent did not answer a run the front desk settled';
  end if;
  return new;
end
$function$;

drop trigger if exists review_items_guard_insert on ops.review_items;
create trigger review_items_guard_insert
  before insert on ops.review_items
  for each row execute function ops.guard_review_item_insert();
alter table ops.review_items enable always trigger review_items_guard_insert;

-- One review per run, but a person may answer the same message more than once.
alter table ops.review_items drop constraint review_items_run_key;
create unique index review_items_one_drafted_per_run
  on ops.review_items (agent_run_id) where author <> 'person';
create index review_items_run_idx on ops.review_items (tenant_id, agent_run_id);

-- ---------------------------------------------------------------------------
-- 3. A conversation's revision: how many messages its contact sent, admitted
--    or refused. Local to the conversation and only growing (no row behind it
--    is ever deleted), so it is safe to print, unlike a global sequence
--    (SI-26). Messages of one conversation are recorded one at a time (each
--    waits on the conversation's row), so a reader holding that row counts
--    every message that arrived before it.
-- ---------------------------------------------------------------------------

create index events_inbound_refused_conversation_idx
  on ops.events (tenant_id, (payload ->> 'conversation_id'))
  where type = 'communication.inbound_refused';

create function ops.cos_conversation_revision(p_tenant_id pg_catalog.uuid, p_conversation_id pg_catalog.uuid)
returns pg_catalog.int4
language sql stable security invoker set search_path = '' as $$
  select ((select pg_catalog.count(*) from ops.inbound_messages m
            where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id)
        + (select pg_catalog.count(*) from ops.events e
            where e.tenant_id = p_tenant_id and e.type = 'communication.inbound_refused'
              and e.payload ->> 'conversation_id' = p_conversation_id::pg_catalog.text))::pg_catalog.int4;
$$;

comment on function ops.cos_conversation_revision(pg_catalog.uuid, pg_catalog.uuid) is
  'ADR 0026: the number of messages the conversation''s contact sent, admitted or refused. A person''s reply names the revision the person saw, and is stale once the conversation moves past it.';

-- ---------------------------------------------------------------------------
-- 4. The stale rule, by author. As 20261013120000, with the person's branch
--    and a reply a person's reply already answered; the review page says
--    which, and who wrote the reply.
-- ---------------------------------------------------------------------------

-- A reply the agent or a fixed text drafted is answered once a person replied
-- to its message: the person's reply replaces it. The protective texts are not
-- replaced (ADR 0026 §A): danger always gets the safety text, an opt-out its
-- acknowledgement, whatever a person wrote besides.
create function ops.cos_review_answered_by_person(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select p_item.author <> 'person'
     and exists (select 1 from ops.review_items p
                  where p.tenant_id = p_tenant_id and p.task_id = p_item.task_id and p.author = 'person')
     and not (p_item.author = 'fixed' and exists (
       select 1 from ops.inbound_screenings s
        where s.tenant_id = p_tenant_id and s.agent_run_id = p_item.agent_run_id
          and s.disposition = 'fixed_reply' and s.fixed_message_key in ('safety', 'opt_out_ack')));
$$;

comment on function ops.cos_review_answered_by_person(pg_catalog.uuid, ops.review_items) is
  'ADR 0026 §A: true for a reply the agent or a fixed text drafted once a person replied to the same message; never for the safety text or the opt-out acknowledgement. The send refuses such a review (newer_message) and the review page says a person answered.';

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

-- get_review's conversation block (20261012120000), plus who wrote the reply
-- and whether a person already answered its message; newerMessage now means
-- only that the contact wrote again.
create or replace function ops.cos_review_conversation(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_s        ops.inbound_screenings;
  v_answered pg_catalog.bool;
begin
  -- Browser-decidable only: lead_triage, a task of synthetic or test data, a
  -- synthetic or test-channel origin (Q8).
  if not ops.cos_review_decidable(p_tenant_id, p_item) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  -- The screening of the run the review came from: the screened text only.
  select s.* into v_s from ops.inbound_screenings s
   where s.tenant_id = p_tenant_id and s.agent_run_id = p_item.agent_run_id;
  v_answered := ops.cos_review_answered_by_person(p_tenant_id, p_item);
  return pg_catalog.jsonb_build_object(
    'status', 'available',
    'author', p_item.author,
    'screening', case when v_s.id is null then null else pg_catalog.jsonb_build_object(
      'messageClass', v_s.message_class,
      'disposition', v_s.disposition,
      'fixedMessageKey', v_s.fixed_message_key,
      'screenedMessage', v_s.model_input) end,
    'replyDraft', case when p_item.content_redacted_at is null
                       then p_item.proposed ->> 'response_draft' end,
    'contentRedacted', p_item.content_redacted_at is not null,
    'answeredByPerson', v_answered,
    'newerMessage', not v_answered and ops.cos_review_superseded(p_tenant_id, p_item));
end
$$;

comment on function ops.cos_review_conversation(pg_catalog.uuid, ops.review_items) is
  'ADR 0023 §L, ADR 0026 §A: get_review''s conversation block, for a browser-decidable review of synthetic or test data only: who wrote the reply, the screening (class, disposition, fixed key, the screened text a model read; never the raw description), the reply draft the send would carry, whether a person already answered its message, and whether the contact wrote again.';

-- ---------------------------------------------------------------------------
-- 5. The reviews the database opens itself. As 20261011120000, with who wrote
--    it, the revision a person's reply answered, the event keyed on the
--    review, and the safety and opt-out wording.
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
    'priority', case when p_key = 'safety' then 'high' else 'normal' end,
    'recommended_next_action', case p_key
      when 'safety' then 'Send the safety text.'
      when 'human_handoff_ack' then 'A person takes over this conversation.'
      when 'opt_out_ack' then 'Send the acknowledgement, then record the opt-out in the CRM.'
      else 'Send the reply after review.' end,
    'response_draft', p_draft,
    'needs_human_review', true,
    'flags', case p_key when 'safety' then '["possible_crisis"]'::jsonb
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

-- ---------------------------------------------------------------------------
-- 6. The agent's review, and everything that looks a review up by its run:
--    the agent's review only. As their latest definitions, with the author.
-- ---------------------------------------------------------------------------

create or replace function ops.open_review_for_run(p_tenant_id uuid, p_run_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run    ops.agent_runs;
  v_dnc    boolean;
  v_review uuid;
begin
  if p_tenant_id is null then
    raise exception using errcode = 'OS401', message = 'ops.open_review_for_run: no tenant scope';
  end if;

  select r.* into v_run
    from ops.agent_runs r
   where r.id = p_run_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'ops.open_review_for_run: agent run not found in this tenant';
  end if;

  -- Only a lead triage run that succeeded, with the result the database
  -- validated when it settled, has advice for a person to review.
  if v_run.capability <> 'lead_triage' or v_run.status <> 'succeeded' or v_run.result is null then
    return null;
  end if;

  -- The consent state the ADMISSION recorded, from its trusted policy source,
  -- found by TASK rather than by run: a retry of the admitted run
  -- (retry_of_run_id), or a second request on the same task, is still that
  -- lead, and inherits what was recorded for it. A task no admission created
  -- has no established consent, and that is do-not-contact.
  select coalesce(bool_or(m.do_not_contact), true) into v_dnc
    from ops.inbound_messages m
   where m.tenant_id = v_run.tenant_id and m.task_id = v_run.task_id;

  insert into ops.review_items (
    tenant_id, company_id, task_id, agent_run_id, capability, proposed, do_not_contact, author)
  values (
    v_run.tenant_id, v_run.company_id, v_run.task_id, v_run.id, v_run.capability, v_run.result,
    v_dnc, 'agent')
  on conflict (agent_run_id) where author <> 'person' do nothing
  returning id into v_review;

  if v_review is null then
    return null; -- already opened: a run is reviewed once
  end if;

  perform ops.record_event(
    v_run.tenant_id, v_run.company_id, 'lead_triage.review_pending', 'agent-runtime', 'task', v_run.task_id,
    jsonb_build_object('review_item_id', v_review, 'agent_run_id', v_run.id),
    v_run.correlation_id, null, format('review:%s:pending', v_review));

  return v_review;
end
$function$;

create or replace function ops.open_missing_reviews(p_tenant_id uuid default null, p_limit integer default 100)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_run    record;
  v_opened integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception using errcode = 'OS400', message = 'ops.open_missing_reviews: the limit is 1 to 1000';
  end if;

  for v_run in
    select r.tenant_id, r.id
      from ops.agent_runs r
     where (p_tenant_id is null or r.tenant_id = p_tenant_id)
       and r.capability = 'lead_triage'
       and r.status = 'succeeded'
       and not exists (select 1 from ops.review_items v where v.agent_run_id = r.id and v.author <> 'person')
     order by r.completed_at, r.id
     limit p_limit
  loop
    if ops.open_review_for_run(v_run.tenant_id, v_run.id) is not null then
      v_opened := v_opened + 1;
    end if;
  end loop;
  return v_opened;
end
$function$;

create or replace function ops.request_shadow_decision_for_settled_job(p_worker_id pg_catalog.text, p_job_id pg_catalog.uuid)
returns pg_catalog.uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job    ops.jobs;
  v_review pg_catalog.uuid;
begin
  if p_worker_id is null or pg_catalog.btrim(p_worker_id) = '' or p_job_id is null then
    raise exception using errcode = 'OS400',
      message = 'ops.request_shadow_decision_for_settled_job requires a worker id and a job id';
  end if;
  select j.* into v_job from ops.jobs j
   where j.id = p_job_id and j.kind = 'agent_run.execute' and j.status = 'succeeded';
  if not found then
    return null;
  end if;
  if not exists (select 1 from ops.job_events e
                  where e.job_id = v_job.id and e.tenant_id = v_job.tenant_id
                    and e.event = 'succeeded' and e.worker_id = p_worker_id) then
    raise exception using errcode = 'OS403',
      message = 'ops.request_shadow_decision_for_settled_job: that job was not completed by this worker';
  end if;
  select ri.id into v_review
    from ops.agent_runs r join ops.review_items ri on ri.tenant_id = r.tenant_id and ri.agent_run_id = r.id
   where r.tenant_id = v_job.tenant_id and r.job_id = v_job.id and ri.author = 'agent';
  if v_review is null then
    return null;
  end if;
  return ops.request_shadow_decision(v_job.tenant_id, v_review, 'review.opened');
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
  -- Only the agent's own advice is evaluated: a fixed text or a person's
  -- reply on the same run is not the model's answer.
  if not found or v_item.capability <> 'lead_triage' or v_item.author <> 'agent' then
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

create or replace function ops.structured_decision_summary(p_tenant_id uuid)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  with d as (
    select * from ops.structured_decisions where tenant_id = p_tenant_id
  ), business as (
    select d.*, r.status as review_status
      from d
      left join ops.review_items r on r.tenant_id = d.tenant_id and r.agent_run_id = d.agent_run_id
                                  and r.author <> 'person'
     where d.decision_kind = 'business_route' and d.status = 'completed'
  ), routing as (
    select d.* from d where d.decision_kind = 'model_route' and d.status = 'completed'
  )
  select jsonb_build_object(
    'byKindAndStatus', coalesce((select jsonb_object_agg(k, v) from (
        select decision_kind as k, jsonb_object_agg(status, n) as v
          from (select decision_kind, status, count(*) n from d group by 1, 2) s group by 1) t), '{}'::jsonb),
    'businessRoute', jsonb_build_object(
      'completed', (select count(*) from business),
      'departmentAgreesWithDeterministic', (select count(*) from business
                                             where answers -> 'department' ->> 'choice' = deterministic_route ->> 'department'),
      'capabilityAgreesWithDeterministic', (select count(*) from business
                                             where answers -> 'capability' ->> 'choice' = deterministic_route ->> 'capability'),
      'byIntent', coalesce((select jsonb_object_agg(i, n) from (
          select answers -> 'intent' ->> 'choice' i, count(*) n from business group by 1) s), '{}'::jsonb),
      'byComplexityLevel', coalesce((select jsonb_object_agg(c, n) from (
          select case when (answers -> 'complexity' ->> 'score')::numeric < 0.5 then 'low'
                      when (answers -> 'complexity' ->> 'score')::numeric < 1.5 then 'medium' else 'high' end c,
                 count(*) n from business group by 1) s), '{}'::jsonb),
      'humanReviewSuggested', (select count(*) from business where (answers -> 'human_review' ->> 'noul')::numeric >= 0.5),
      'humanDecisions', coalesce((select jsonb_object_agg(coalesce(review_status, 'none'), n) from (
          select review_status, count(*) n from business group by 1) s), '{}'::jsonb)),
    'modelRoute', jsonb_build_object(
      'completed', (select count(*) from routing),
      'agreesWithExecuted', (select count(*) from routing
                              where answers -> 'model' ->> 'choice' = deterministic_route ->> 'executedModel')),
    'leadIntelligence', jsonb_build_object(
      'completed', (select count(*) from d where decision_kind = 'lead_intelligence' and status = 'completed'),
      'withOutcome', (select count(distinct o.structured_decision_id) from ops.decision_outcomes o
                        join d on d.id = o.structured_decision_id where d.decision_kind = 'lead_intelligence'),
      'calibration', 'not_calibrated'),
    'decisionCostMicros', (select coalesce(sum(charged_cost_micros), 0) from d));
$$;

create or replace function ops.cos_review_structured_decisions(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_out pg_catalog.jsonb := pg_catalog.jsonb_build_object(
    'status', 'available', 'businessRoute', null, 'leadIntelligence', null, 'modelRoute', null);
  v_d   ops.structured_decisions;
begin
  -- The decisions belong to the agent's answer: a fixed text or a person's
  -- reply on the same run shows none of them.
  if p_item.capability <> 'lead_triage' or p_item.author <> 'agent'
     or not ops.cos_review_decidable(p_tenant_id, p_item) then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;
  for v_d in
    select d.* from ops.structured_decisions d
     where d.tenant_id = p_tenant_id
       and ((d.decision_kind in ('business_route', 'lead_intelligence') and d.task_id = p_item.task_id)
            or (d.decision_kind = 'model_route' and d.agent_run_id = p_item.agent_run_id))
     order by d.requested_at, d.id
  loop
    v_out := v_out || pg_catalog.jsonb_build_object(
      case v_d.decision_kind when 'business_route' then 'businessRoute'
                             when 'lead_intelligence' then 'leadIntelligence' else 'modelRoute' end,
      ops.cos_structured_decision(v_d));
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. A person's reply to the newest message. It replaces the 20261011120000
--    act, which answered only a message held for a person: no overload
--    without the revision survives.
-- ---------------------------------------------------------------------------

drop function ops.record_person_reply(uuid, uuid, text, text);

-- A person's reply to the newest admitted message of a conversation the person
-- holds, while Meta's 24-hour window is open, naming the revision the person
-- saw: a review the person's own act accepts, sent by the usual send act.
create function ops.record_person_reply(
  p_tenant_id uuid, p_conversation_id uuid, p_text text, p_actor text, p_expected_revision integer)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_conv     ops.conversations;
  v_state    ops.conversation_states;
  v_inbound  ops.inbound_messages;
  v_run      ops.agent_runs;
  v_revision integer;
  v_review   uuid;
  v_result   jsonb;
begin
  if p_actor is null or p_actor !~ '^[A-Za-z0-9._:@-]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.record_person_reply: the actor label is malformed';
  end if;
  if p_text is null or char_length(p_text) not between 1 and 2000 or p_text ~ '[\x01-\x09\x0B-\x1F\x7F]' then
    raise exception using errcode = 'OS400',
      message = 'ops.record_person_reply: a reply has 1 to 2000 characters and no control character but the line break';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = 'OS400', message = 'ops.record_person_reply: name the revision the conversation listing showed';
  end if;
  -- The conversation first, as the last send gate takes it: until this act
  -- ends, the contact's next message waits at its admission, so the revision
  -- read below is the one the reply answers.
  select c.* into v_conv from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = p_conversation_id
     for no key update;
  select s.* into v_state from ops.conversation_states s
   where s.tenant_id = p_tenant_id and s.conversation_id = p_conversation_id for update;
  if v_conv.id is null or v_state.conversation_id is null then
    raise exception using errcode = 'OS404', message = 'ops.record_person_reply: no state for this conversation in this tenant';
  end if;
  if v_state.holder <> 'person' then
    raise exception using errcode = 'OS409', message = 'ops.record_person_reply: take the conversation over first';
  end if;
  -- Meta's customer-service window, read as the send's eligibility reads it.
  if v_conv.last_inbound_at is null or v_conv.last_inbound_at < now() - interval '24 hours' then
    raise exception using errcode = 'OS409', message = 'ops.record_person_reply: the contact last wrote more than 24 hours ago';
  end if;
  v_revision := ops.cos_conversation_revision(p_tenant_id, p_conversation_id);
  if v_revision <> p_expected_revision then
    raise exception using errcode = 'OS409',
      message = format('ops.record_person_reply: the conversation is at revision %s, not %s; list it again', v_revision, p_expected_revision);
  end if;
  -- The newest admitted message, whatever happened to it.
  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id
   order by m.received_at desc, m.created_at desc
   limit 1;
  select r.* into v_run from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.id = v_inbound.agent_run_id;
  if v_run.id is null then
    raise exception using errcode = 'OS409', message = 'ops.record_person_reply: no message in this conversation can be answered';
  end if;
  -- SI-72: the newest message's content is gone; nothing new is written about it.
  if exists (select 1 from ops.tasks t
              where t.tenant_id = p_tenant_id and t.id = v_inbound.task_id and t.content_redacted_at is not null) then
    raise exception using errcode = 'OS409',
      message = 'ops.record_person_reply: the newest message''s content was erased under retention; a reply waits for the contact''s next message';
  end if;
  -- A run still waiting (an execution stop holds it, or no worker took it
  -- yet) does not hold the person back: its screening, under a person, drafts
  -- at most a protective text, and a draft the agent wrote meanwhile is stale
  -- once a person answered the message.
  perform set_config('ops.person_reply_revision', v_revision::text, true);
  v_review := ops.open_scripted_review(v_run, p_text, 'person', null, 'operator-cli');
  perform set_config('ops.person_reply_revision', '', true);
  v_result := ops.record_review_decision(p_tenant_id, v_review, 'accepted', p_actor, 'operator-cli', null);
  return jsonb_build_object(
    'state', 'recorded', 'review_item_id', v_review, 'decision', v_result ->> 'status', 'revision', v_revision);
end
$function$;

comment on function ops.record_person_reply(uuid, uuid, text, text, integer) is
  'ADR 0026 §A: a person''s reply to the newest admitted message of a conversation the person holds, inside Meta''s 24-hour window, naming the revision the person saw. Opens a person review the act accepts; the send act carries it. Up to five per message and revision.';

-- ---------------------------------------------------------------------------
-- 8. The screening: the protective texts whoever holds, and the earlier turns
--    keyed on who wrote them. As 20261016120000, with those two changes.
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
      perform ops.open_scripted_review(v_run, v_fixed.content -> 'messages' ->> v_key, 'fixed', v_key, 'agent-runtime');
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
-- 9. A refused message waits for the person who holds its conversation. As
--    20261010120000, with the count after the refusal's fact.
-- ---------------------------------------------------------------------------

create or replace function ops.receive_whatsapp_message(
  p_provider_target     text,
  p_external_message_id text,
  p_from                text,
  p_body                text,
  p_received_at         timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_channel     ops.communication_channels;
  v_crm         jsonb;
  v_dnc         boolean;
  v_conv        uuid;
  v_received_at timestamptz;
  v_reason      text;
  v_result      jsonb;
  v_prior       ops.inbound_messages;
  v_refused     jsonb;
  v_waiting     uuid;
  v_holder      text;
begin
  -- A malformed target or message id cannot be tied to any tenant or keyed
  -- once: a typed refusal. The gateway's parser never produces one.
  if p_provider_target is null or p_provider_target !~ '^[0-9]{1,32}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed provider target';
  end if;
  if p_external_message_id is null or p_external_message_id !~ '^[\x21-\x7e]{1,200}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed message id';
  end if;
  -- The sender may be absent (a WhatsApp user known only by username); if
  -- present it is digits with the country code.
  if p_from is not null and p_from !~ '^[0-9]{6,20}$' then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: malformed sender id';
  end if;
  if p_received_at is null then
    raise exception using errcode = 'OS400', message = 'ops.receive_whatsapp_message: received_at is missing';
  end if;

  -- The TRUSTED mapping, and the closed real-data gate. Nothing in the payload
  -- names a tenant, a channel or a mode. A message that is not for a live test
  -- channel is not ours to acknowledge: the gateway answers it with a non-2xx
  -- and stores nothing.
  select * into v_channel from ops.communication_channels c
   where c.provider = 'meta_whatsapp' and c.provider_target = p_provider_target;
  if not found then
    return jsonb_build_object('state', 'unrouted', 'reason', 'unknown_target');
  end if;
  if not v_channel.active or v_channel.mode <> 'test' then
    return jsonb_build_object('state', 'unrouted', 'reason', 'channel_not_live');
  end if;
  -- The units that would own the work must be able to take it. A paused unit
  -- is recoverable: re-activating it lets Meta's redelivery through.
  if not exists (
    select 1
      from ops.agents a
      join ops.departments d on d.tenant_id = a.tenant_id and d.company_id = a.company_id and d.id = a.department_id
      join ops.companies co on co.tenant_id = a.tenant_id and co.id = a.company_id
     where a.tenant_id = v_channel.tenant_id and a.company_id = v_channel.company_id and a.id = v_channel.agent_id
       and a.status = 'active' and d.status = 'active' and co.status = 'active') then
    return jsonb_build_object('state', 'unrouted', 'reason', 'organisation_inactive');
  end if;

  -- The database's clock, not the gateway's: skew cannot refuse a message.
  v_received_at := least(p_received_at, now());

  -- ADR 0021 W5: a redelivery of a message this channel's tenant already
  -- answered never touches a conversation, so a routine provider retry cannot
  -- re-create a number that was erased. An admitted message goes on to the
  -- admission (which answers the replay, or refuses a reused id) with its own
  -- conversation; a message refused on the record gets that refusal again.
  select m.* into v_prior
    from ops.inbound_messages m
   where m.tenant_id = v_channel.tenant_id and m.source_kind = 'whatsapp'
     and m.external_message_id = p_external_message_id;
  if v_prior.id is null then
    select e.payload into v_refused
      from ops.events e
     where e.tenant_id = v_channel.tenant_id
       and e.idempotency_key = format('whatsapp:refused:%s',
                                      encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex'));
    if found then
      return jsonb_strip_nulls(jsonb_build_object(
        'state', 'refused', 'reason', v_refused ->> 'reason', 'conversation_id', v_refused ->> 'conversation_id'));
    end if;
  end if;

  if p_from is null then
    v_reason := 'no_sender_number';
  else
    v_crm := ops.crm_contact_by_phone(v_channel.tenant_id, p_from);
    -- Only a single CRM contact whose opt-out flag is false is eligible at
    -- admission; every other answer is do-not-contact.
    v_dnc := not (v_crm ->> 'state' = 'found'
                  and jsonb_typeof(v_crm -> 'do_not_contact') = 'boolean'
                  and not (v_crm ->> 'do_not_contact')::boolean);

    if v_prior.conversation_id is not null then
      v_conv := v_prior.conversation_id;
    else
      insert into ops.conversations (tenant_id, company_id, channel_id, contact_ref, last_inbound_at)
      values (v_channel.tenant_id, v_channel.company_id, v_channel.id, p_from, v_received_at)
      on conflict (tenant_id, channel_id, contact_ref) do update
        set last_inbound_at = greatest(ops.conversations.last_inbound_at, excluded.last_inbound_at)
      returning id into v_conv;
    end if;

    -- ops.admit_inbound_core's own bounds, decided here so that a refusal is on
    -- the record rather than an exception the gateway could only log.
    v_reason := case
      when p_body is null then 'unsupported_content'
      when p_body !~ '\S' then 'empty_body'
      when char_length(p_body) > 4000 then 'body_too_long'
    end;

    if v_reason is null then
      begin
        v_result := ops.admit_inbound_core(
          v_channel.tenant_id, v_channel.company_id, v_channel.agent_id, 'whatsapp',
          p_external_message_id, p_from, p_body, 'whatsapp-gateway', v_dnc, v_received_at,
          v_channel.id, v_conv, v_crm ->> 'state', v_crm ->> 'crm_contact_ref');
        return v_result || jsonb_build_object('state', 'admitted', 'conversation_id', v_conv);
      exception when sqlstate 'OS400' or sqlstate 'OS409' then
        -- The admission refused it (a reused message id carrying another
        -- message, or a unit paused since the check above): nothing it began
        -- survives, and the refusal is recorded below.
        v_reason := 'admission_refused';
      end;
    end if;
  end if;

  -- A duplicate delivery that waited on the conversation's row behind this
  -- one finds its refusal now, and is answered with it: it is counted once.
  if v_conv is not null and exists (
       select 1 from ops.events e
        where e.tenant_id = v_channel.tenant_id
          and e.idempotency_key = format('whatsapp:refused:%s',
                                         encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex'))) then
    return jsonb_strip_nulls(jsonb_build_object('state', 'refused', 'reason', v_reason, 'conversation_id', v_conv));
  end if;

  -- Acknowledged only with a durable record of it: the channel, the
  -- conversation when there is a sender number, and why. Never the body, the
  -- sender or the message id. Once per message id.
  perform ops.record_event(
    v_channel.tenant_id, v_channel.company_id, 'communication.inbound_refused', 'whatsapp-gateway',
    'company', v_channel.company_id,
    jsonb_strip_nulls(jsonb_build_object('channel_id', v_channel.id, 'conversation_id', v_conv, 'reason', v_reason)),
    null, null,
    format('whatsapp:refused:%s', encode(sha256(convert_to(p_external_message_id, 'UTF8')), 'hex')));
  -- ADR 0026 §A: a refused message (an audio, an image) in a conversation a
  -- person holds waits for that person like any other, counted on the
  -- conversation's newest admitted message. Content-free: the kind only.
  -- The holder is read under a share lock, in the order the person's reply
  -- takes them (the conversation, then its state): a release in flight either
  -- finishes first and is seen, or waits and resolves what is counted here.
  if v_conv is not null then
    select s.holder into v_holder from ops.conversation_states s
     where s.tenant_id = v_channel.tenant_id and s.conversation_id = v_conv
       for share;
  end if;
  if v_holder = 'person' then
    select m.task_id into v_waiting
      from ops.inbound_messages m
     where m.tenant_id = v_channel.tenant_id and m.conversation_id = v_conv and m.task_id is not null
     order by m.received_at desc, m.created_at desc
     limit 1;
    if v_waiting is not null then
      perform ops.open_exception(v_channel.tenant_id, v_channel.company_id, v_waiting, 'message_waiting',
                                 v_conv, null, null, 'whatsapp-gateway');
    end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('state', 'refused', 'reason', v_reason, 'conversation_id', v_conv));
end
$function$;

-- ---------------------------------------------------------------------------
-- 10. Access, and the end state.
-- ---------------------------------------------------------------------------

revoke all on function ops.guard_review_item_insert() from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.cos_conversation_revision(pg_catalog.uuid, pg_catalog.uuid)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.cos_review_answered_by_person(pg_catalog.uuid, ops.review_items)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.record_person_reply(uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_bad text;
begin
  -- Every review has its author, and the author its run's ending.
  select pg_catalog.string_agg(ri.id::pg_catalog.text, ', ') into v_bad
    from ops.review_items ri
    left join ops.agent_runs r on r.tenant_id = ri.tenant_id and r.id = ri.agent_run_id
   where ri.author is null
      or (r.id is not null and ri.author <> case r.error_code
                                               when 'front_desk_fixed_reply' then 'fixed'
                                               when 'front_desk_held_for_person' then 'person'
                                               else 'agent' end);
  if v_bad is not null then
    raise exception 'a review''s author does not match its run: %', v_bad;
  end if;

  -- The one-review-per-run constraint is gone, the partial index replaces it.
  if exists (select 1 from pg_catalog.pg_constraint c
              where c.conrelid = 'ops.review_items'::pg_catalog.regclass and c.conname = 'review_items_run_key')
     or not exists (select 1 from pg_catalog.pg_indexes i
                     where i.schemaname = 'ops' and i.indexname = 'review_items_one_drafted_per_run'
                       and i.indexdef like '%UNIQUE%' and i.indexdef like '%author <> ''person''%') then
    raise exception 'the review''s run uniqueness is not the partial index';
  end if;

  -- The insert guard is ALWAYS; the update guard still is.
  if (select count(*) from pg_catalog.pg_trigger t
       where t.tgrelid = 'ops.review_items'::pg_catalog.regclass
         and t.tgname in ('review_items_guard_insert', 'review_items_guard_update') and t.tgenabled = 'A') <> 2 then
    raise exception 'the review guards are not both ALWAYS';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.guard_review_item_update()'::pg_catalog.regprocedure),
                       'new.author is distinct from old.author') = 0 then
    raise exception 'the update guard does not keep the author immutable';
  end if;

  -- One person act, five arguments; INVOKER and unreachable, like the new
  -- helpers.
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = 'record_person_reply' and p.pronargs <> 5) then
    raise exception 'an overload of the person''s reply without the revision survives';
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid in ('ops.guard_review_item_insert()'::pg_catalog.regprocedure,
                   'ops.cos_conversation_revision(uuid, uuid)'::pg_catalog.regprocedure,
                   'ops.cos_review_answered_by_person(uuid, ops.review_items)'::pg_catalog.regprocedure,
                   'ops.cos_review_conversation(uuid, ops.review_items)'::pg_catalog.regprocedure,
                   'ops.record_person_reply(uuid, uuid, text, text, integer)'::pg_catalog.regprocedure,
                   'ops.open_scripted_review(ops.agent_runs, text, text, text, text)'::pg_catalog.regprocedure)
     and (p.prosecdef
          or p.proconfig is distinct from array['search_path=""']
          or p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a review function is reachable or not a pinned INVOKER: %', v_bad;
  end if;

  -- The two capabilities replaced here keep their definer, search path and
  -- one grantee.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.record_inbound_screening(jsonb)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, 'ri.author = ''agent'' and s.disposition = ''model''') > 0) then
    raise exception 'the screening capability lost its definer, its pinned search path or the author allowlist';
  end if;
  if not pg_catalog.has_function_privilege('ops_worker', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('ops_gateway', 'ops.record_inbound_screening(jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.record_inbound_screening(jsonb)', 'EXECUTE') then
    raise exception 'the screening capability is no longer the worker''s alone';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.receive_whatsapp_message(text, text, text, text, timestamptz)'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']
                    and pg_catalog.strpos(p.prosrc, '''message_waiting''') > 0) then
    raise exception 'the gateway''s admission lost its definer, its pinned search path or the waiting count';
  end if;
  if not pg_catalog.has_function_privilege('ops_gateway', 'ops.receive_whatsapp_message(text, text, text, text, timestamptz)', 'EXECUTE')
     or pg_catalog.has_function_privilege('ops_worker', 'ops.receive_whatsapp_message(text, text, text, text, timestamptz)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.receive_whatsapp_message(text, text, text, text, timestamptz)', 'EXECUTE') then
    raise exception 'the gateway''s admission is no longer the gateway''s alone';
  end if;
end
$end_state$;
