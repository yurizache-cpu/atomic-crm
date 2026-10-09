-- ADR 0026 §E, slice 5: the browser inbox's callees (decision S). The fifth
-- exact OD-8a migration, 20261021130000_company_os_browser_inbox.sql, exposes
-- them; this one holds every callee and helper, as 20260930120000 does for the
-- commercial acts.
--
--   * The read: ops.read_conversation(tenant, task), one waiting conversation
--     of the tenant, reached by any task of its own inbound messages: for a
--     test line, a number not erased and a newest message of synthetic or
--     test class, the last 50 turns (an admitted message's raw text only where
--     its own task is synthetic or test and not redacted; a refused message as
--     its reason; a reply once it left or may have left, or a person's reply
--     asked for from the inbox), the holder, whether an opt-out is open, the
--     first word of the contact's CRM first name, the window's end, the
--     revision and the acts the server allows now; otherwise a state
--     (withheld, not_waiting), never an access refusal.
--   * The reply: ops.reply_to_conversation_as_member, a person's own reply,
--     only while a person holds the conversation at the revision the member
--     saw, with the member's session's authenticator-app factor verified
--     within the hour (by a factor older than the session) and the send's own
--     gates open now: one person review the member accepts, one send request of
--     the new kind person_reply, which the send table's guard admits only in
--     that act, and one outbound.reply_send job, which carries it under every
--     gate of a fixed text but the published-policy check, its window as its
--     bound, after any earlier person's reply of the conversation.
--   * The release: ops.release_conversation_as_member, the owner's release at
--     the revision the member saw, never while an opt-out is open.
--   Every refusal is an answer state; nothing is written when the act refuses.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The send kind: a person's own reply, carried by the worker's reply job.
-- ---------------------------------------------------------------------------

alter table ops.outbound_messages drop constraint outbound_messages_authorization_kind_check;
alter table ops.outbound_messages add constraint outbound_messages_authorization_kind_check
  check (authorization_kind in ('operator', 'fixed_text', 'person_reply'));
alter table ops.outbound_messages drop constraint outbound_messages_policy_shape;
-- A send a job carries (a published fixed text, or a person's own reply asked
-- for from the browser inbox) names its job and the instant it stops being
-- fresh; only a fixed text names a key and a version.
alter table ops.outbound_messages add constraint outbound_messages_policy_shape check (
      (authorization_kind in ('fixed_text', 'person_reply')) = (job_id is not null)
  and (authorization_kind = 'fixed_text') = (fixed_text_key is not null)
  and (authorization_kind = 'fixed_text') = (fixed_messages_version_id is not null)
  and (authorization_kind in ('fixed_text', 'person_reply')) = (fresh_until is not null)
  and (fixed_text_key is null or fixed_text_key = any (ops.automatic_fixed_text_keys())));
comment on column ops.outbound_messages.authorization_kind is
  'ADR 0026 §B, §E: operator (npm run messaging -- send of an accepted review), fixed_text (a published fixed text authorized as policy) or person_reply (a person''s own reply written and asked to be sent in one act from the browser inbox); the last two are carried by the worker''s outbound.reply_send job.';
comment on column ops.outbound_messages.fresh_until is
  'ADR 0026 §B, §E: a job''s send not begun by this instant is blocked: fixed_text_expired, 30 minutes after the earlier of its message''s provider timestamp and admission; outside_service_window, at the end of the contact''s 24-hour window for a person''s reply.';

-- ---------------------------------------------------------------------------
-- 2. The read graph (SI-87): STABLE INVOKERs no role executes, under the read
--    graph's rules (company_os_api.sql P5): read only, ops and pg_catalog
--    names, no dynamic SQL; their only CRM read is the first-name adapter.
-- ---------------------------------------------------------------------------

-- The conversation an inbound message's task belongs to, in the tenant.
create function ops.cos_inbox_conversation(p_tenant pg_catalog.uuid, p_task_id pg_catalog.uuid)
returns pg_catalog.uuid
language sql stable security invoker set search_path = '' as $$
  select m.conversation_id from ops.inbound_messages m
   where m.tenant_id = p_tenant and m.task_id = p_task_id and m.conversation_id is not null
   order by m.received_at desc, m.created_at desc
   limit 1;
$$;

-- A conversation a member may read and act on: a test line, a number not
-- erased, and its newest message of a synthetic or test task (SI-87).
create function ops.cos_conversation_visible(p_tenant pg_catalog.uuid, p_conversation pg_catalog.uuid)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from ops.conversations c
                   join ops.communication_channels ch on ch.tenant_id = c.tenant_id and ch.id = c.channel_id
                  where c.tenant_id = p_tenant and c.id = p_conversation
                    and ch.mode = 'test' and c.contact_erased_at is null)
     and coalesce((select t.data_class in ('synthetic', 'test')
                     from ops.inbound_messages m
                     join ops.tasks t on t.tenant_id = m.tenant_id and t.id = m.task_id
                    where m.tenant_id = p_tenant and m.conversation_id = p_conversation
                    order by m.received_at desc, m.created_at desc
                    limit 1), false);
$$;

-- Whether the conversation waits for a person: the waiting list's own rule.
create function ops.cos_conversation_waiting(p_tenant pg_catalog.uuid, p_conversation pg_catalog.uuid)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from ops.exceptions e
                  where e.tenant_id = p_tenant and e.conversation_id = p_conversation
                    and e.kind in ('person_requested', 'message_waiting') and e.resolved_at is null);
$$;

-- The first word of the contact's CRM first name, for a synthetic or test
-- conversation whose newest message found its CRM contact: letters, hyphens
-- and apostrophes only, at most 40, never kept.
create function ops.cos_conversation_first_name(p_tenant pg_catalog.uuid, p_conversation pg_catalog.uuid)
returns pg_catalog.text
language sql stable security invoker set search_path = '' as $$
  select nullif(pg_catalog.left(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
           pg_catalog.regexp_replace(pg_catalog.regexp_replace(x.name, '^[[:space:]]+', ''), '[[:space:]].*$', ''),
           '[^[:alpha:]''-]', '', 'g'), '^[''-]+', ''), 40), '')
    from (select case when t.data_class in ('synthetic', 'test') and m.contact_resolution = 'found'
                      then ops.crm_contact_first_name(p_tenant, m.crm_contact_ref) end as name
            from ops.inbound_messages m
            join ops.tasks t on t.tenant_id = m.tenant_id and t.id = m.task_id
           where m.tenant_id = p_tenant and m.conversation_id = p_conversation
           order by m.received_at desc, m.created_at desc
           limit 1) x;
$$;

-- The do-not-contact snapshot a review of this task takes (one source for the
-- review and for the inbox's refusal): an opt-out the message lifted no longer
-- applies to it; no admission at all reads as do-not-contact.
create function ops.cos_message_do_not_contact(p_tenant pg_catalog.uuid, p_task_id pg_catalog.uuid)
returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.bool_or(m.do_not_contact
                    and not exists (select 1 from ops.inbound_screenings s
                                     where s.tenant_id = m.tenant_id and s.task_id = m.task_id
                                       and s.opt_out_cleared)), true)
    from ops.inbound_messages m
   where m.tenant_id = p_tenant and m.task_id = p_task_id;
$$;

-- Why a person's reply could not be recorded on the conversation's newest
-- message at this revision, or null: no message a reply can answer, its
-- content gone under retention, five replies already answer it, or the
-- contact must not be contacted (the review's own snapshot).
create function ops.cos_person_reply_refusal(p_tenant pg_catalog.uuid, p_conversation pg_catalog.uuid,
                                             p_revision pg_catalog.int4)
returns pg_catalog.text
language sql stable security invoker set search_path = '' as $$
  select case
    when m.id is null or r.id is null then 'nothing_to_answer'
    when t.content_redacted_at is not null then 'content_erased'
    when (select pg_catalog.count(*) from ops.review_items ri
           where ri.tenant_id = p_tenant and ri.agent_run_id = r.id and ri.author = 'person'
             and ri.conversation_revision = p_revision) >= 5 then 'reply_limit'
    when ops.cos_message_do_not_contact(p_tenant, m.task_id) then 'do_not_contact'
  end
    from (select 1) one
    left join lateral (select x.* from ops.inbound_messages x
                        where x.tenant_id = p_tenant and x.conversation_id = p_conversation
                        order by x.received_at desc, x.created_at desc
                        limit 1) m on true
    left join ops.agent_runs r on r.tenant_id = p_tenant and r.id = m.agent_run_id
    left join ops.tasks t on t.tenant_id = p_tenant and t.id = m.task_id;
$$;

-- The last 50 turns, oldest first, and whether earlier ones exist (SI-87): an
-- admitted message's text only for its own synthetic or test task, not
-- redacted; a refused message as its reason; a reply once it left or may have
-- left, or a person's reply asked for from the inbox, with its delivery (held
-- while a stop of its unit holds its job). Never an identifier. An admitted
-- message stands at the provider's time, a refused one at its event's (D10).
create function ops.cos_conversation_turns(p_tenant pg_catalog.uuid, p_conversation pg_catalog.uuid)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  with turns as (
    select m.received_at as at, 0 as rank, m.id as tie,
           pg_catalog.jsonb_build_object(
             'kind', 'inbound', 'at', ops.cos_ts(m.received_at),
             'text', case when t.data_class in ('synthetic', 'test') and t.content_redacted_at is null
                               and m.content_redacted_at is null
                               and pg_catalog.char_length(t.description) between 1 and 4000
                          then t.description end,
             'hidden', case when t.content_redacted_at is not null or m.content_redacted_at is not null then 'erased'
                            when t.id is null or t.data_class not in ('synthetic', 'test') or t.description is null
                                 or pg_catalog.char_length(t.description) not between 1 and 4000 then 'withheld' end) as turn
      from ops.inbound_messages m
      left join ops.tasks t on t.tenant_id = m.tenant_id and t.id = m.task_id
     where m.tenant_id = p_tenant and m.conversation_id = p_conversation
    union all
    select e.created_at, 0, e.id,
           pg_catalog.jsonb_build_object(
             'kind', 'refused', 'at', ops.cos_ts(e.created_at),
             'reason', case when e.payload ->> 'reason' ~ '^[a-z][a-z0-9_]{0,63}$' then e.payload ->> 'reason'
                            else 'other' end)
      from ops.events e
     where e.tenant_id = p_tenant and e.type = 'communication.inbound_refused'
       and e.payload ->> 'conversation_id' = p_conversation::pg_catalog.text
    union all
    select coalesce(o.sending_at, o.authorized_at), 1, o.id,
           pg_catalog.jsonb_build_object(
             'kind', 'reply', 'at', ops.cos_ts(coalesce(o.sending_at, o.authorized_at)),
             'author', ri.author,
             'fixedKey', case when ri.author = 'fixed' then s.fixed_message_key end,
             'automatic', o.authorization_kind = 'fixed_text',
             'text', case when t.data_class in ('synthetic', 'test') and t.content_redacted_at is null
                               and ri.content_redacted_at is null
                               and pg_catalog.char_length(ri.proposed ->> 'response_draft') between 1 and 2000
                          then ri.proposed ->> 'response_draft' end,
             'hidden', case when t.content_redacted_at is not null or ri.content_redacted_at is not null then 'erased'
                            when t.data_class not in ('synthetic', 'test') or ri.proposed ->> 'response_draft' is null
                                 or pg_catalog.char_length(ri.proposed ->> 'response_draft') not between 1 and 2000
                            then 'withheld' end,
             'delivery', case
                           when o.status = 'authorized' and o.job_id is not null
                                and ops.cos_tenant_covering_stop(p_tenant, 'outbound.reply_send', r.company_id,
                                                                 r.department_id, r.agent_id) is not null then 'held'
                           when o.status in ('authorized', 'sending') then 'queued'
                           when o.status = 'indeterminate' then 'uncertain'
                           else o.status end,
             'reason', case o.status when 'blocked' then o.blocked_reason
                                     when 'failed' then o.error_class
                                     when 'indeterminate' then o.error_class end,
             'withPrivacyNotice', o.privacy_notice_id is not null)
      from ops.outbound_messages o
      join ops.review_items ri on ri.tenant_id = o.tenant_id and ri.id = o.review_item_id
      join ops.tasks t on t.tenant_id = ri.tenant_id and t.id = ri.task_id
      left join ops.agent_runs r on r.tenant_id = ri.tenant_id and r.id = ri.agent_run_id
      left join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
     where o.tenant_id = p_tenant and o.conversation_id = p_conversation
       and (o.status in ('sent', 'delivered', 'read', 'indeterminate') or o.authorization_kind = 'person_reply'))
  select pg_catalog.jsonb_build_object(
    'earlierTurns', (select pg_catalog.count(*) from turns) > 50,
    'turns', coalesce((select pg_catalog.jsonb_agg(l.turn order by l.at, l.rank, l.tie)
                         from (select x.* from turns x order by x.at desc, x.rank desc, x.tie desc limit 50) l),
                      '[]'::pg_catalog.jsonb));
$$;

-- One waiting conversation for the browser inbox (SI-87), reached by any task
-- of its own inbound messages; a withheld or a closed conversation is a state.
create function ops.read_conversation(p_tenant_id pg_catalog.uuid, p_task_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_conv    ops.conversations;
  v_holder  pg_catalog.text;
  v_rev     pg_catalog.int4;
  v_optout  pg_catalog.bool;
  v_open    pg_catalog.bool;
  v_why     pg_catalog.text;
  v_turns   pg_catalog.jsonb;
begin
  select c.* into v_conv from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = ops.cos_inbox_conversation(p_tenant_id, p_task_id);
  if v_conv.id is null then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  if not ops.cos_conversation_visible(p_tenant_id, v_conv.id) then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'status', 'withheld',
      'reason', case when v_conv.contact_erased_at is not null then 'erased' else 'not_test' end);
  end if;
  if not ops.cos_conversation_waiting(p_tenant_id, v_conv.id) then
    return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'status', 'not_waiting');
  end if;
  v_holder := coalesce((select s.holder from ops.conversation_states s
                         where s.tenant_id = p_tenant_id and s.conversation_id = v_conv.id), 'agent');
  v_rev := ops.cos_conversation_revision(p_tenant_id, v_conv.id);
  v_optout := exists (select 1 from ops.exceptions e
                       where e.tenant_id = p_tenant_id and e.conversation_id = v_conv.id
                         and e.kind = 'opt_out' and e.resolved_at is null);
  v_open := v_conv.last_inbound_at is not null and v_conv.last_inbound_at >= now() - interval '24 hours';
  -- Why a reply cannot be asked for now, in the act's own order; the act may
  -- still refuse what only the CRM can tell (not_sendable).
  v_why := case
    when v_holder <> 'person' then 'not_held'
    when not v_open then 'window_closed'
    when v_optout then 'opt_out_open'
    else ops.cos_person_reply_refusal(p_tenant_id, v_conv.id, v_rev) end;
  v_turns := ops.cos_conversation_turns(p_tenant_id, v_conv.id);
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'status', 'available',
    'revision', v_rev, 'holder', v_holder, 'optOutOpen', v_optout,
    'firstName', ops.cos_conversation_first_name(p_tenant_id, v_conv.id),
    'lastMessageAt', ops.cos_ts(v_conv.last_inbound_at),
    'windowEndsAt', ops.cos_ts(v_conv.last_inbound_at + interval '24 hours'),
    'allowedActs', pg_catalog.jsonb_build_object(
      'reply', v_why is null,
      'release', v_holder = 'person' and not v_optout),
    'replyUnavailable', v_why,
    'earlierTurns', v_turns -> 'earlierTurns',
    'turns', v_turns -> 'turns');
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The acts' helpers and callees (SI-87): INVOKERs no role executes, run by
--    the OD-8a gates as their owner. No name says send, outbound or clear.
-- ---------------------------------------------------------------------------

-- The provider's own record of the caller's session: its authenticator-app
-- factor, one the user had before this session began (a factor enrolled
-- during the session, as a stolen session could, never counts), verified
-- within the hour. Only SI-74's non-production row waives it. Read after
-- ops.operator_scope() verified the session.
create function ops.operator_second_factor_recent()
returns boolean
language plpgsql stable security invoker set search_path to '' as $function$
declare
  c_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_claims jsonb;
begin
  if exists (select 1 from ops.operator_assurance_exemption) then
    return true;
  end if;
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  exception when others then
    return false;
  end;
  if v_claims is null or jsonb_typeof(v_claims) <> 'object'
     or coalesce(v_claims ->> 'sub', '') !~ c_uuid or coalesce(v_claims ->> 'session_id', '') !~ c_uuid then
    return false;
  end if;
  return exists (
    select 1
      from auth.sessions s
      join auth.mfa_factors f on f.id = s.factor_id
      join auth.mfa_amr_claims a on a.session_id = s.id
     where s.id = (v_claims ->> 'session_id')::uuid
       and s.user_id = (v_claims ->> 'sub')::uuid
       and f.user_id = s.user_id
       and f.factor_type::text = 'totp' and f.status::text = 'verified'
       and f.created_at < s.created_at
       and a.authentication_method = 'totp'
       and a.updated_at > now() - interval '1 hour');
end
$function$;

-- Holds a waiting conversation for an inbox act as every writer of it takes
-- them (the conversation, then its state), and says why the act cannot
-- proceed, or null. OS404 for a task no conversation of the tenant answers.
create function ops.inbox_preflight(
  p_tenant_id uuid, p_task_id uuid, p_expected_revision integer, p_act text,
  out conversation ops.conversations, out holder text, out revision integer, out refusal text)
language plpgsql volatile security invoker set search_path to '' as $function$
declare
  v_id uuid := ops.cos_inbox_conversation(p_tenant_id, p_task_id);
begin
  if v_id is null then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  select c.* into conversation from ops.conversations c
   where c.tenant_id = p_tenant_id and c.id = v_id
     for no key update;
  select s.holder into holder from ops.conversation_states s
   where s.tenant_id = p_tenant_id and s.conversation_id = v_id
     for update;
  holder := coalesce(holder, 'agent');
  -- Exact: the contact's next message waits at its admission until this ends.
  revision := ops.cos_conversation_revision(p_tenant_id, v_id);
  refusal := case
    when not ops.cos_conversation_visible(p_tenant_id, v_id) then 'withheld'
    when holder <> 'person' then case p_act when 'reply' then 'not_held' else 'already_with_agent' end
    when not ops.cos_conversation_waiting(p_tenant_id, v_id) then 'not_waiting'
    when revision <> p_expected_revision then 'stale'
  end;
end
$function$;

-- A person's reply to the conversation's newest admitted message, as a review
-- the person's own act accepts. The caller holds the conversation (for no key
-- update) and its state (for update), and checked the holder, the window and
-- the revision. Shared by the owner's CLI and the browser inbox; only the
-- source differs.
create function ops.open_person_reply_review(
  p_tenant_id uuid, p_conversation_id uuid, p_text text, p_actor text, p_revision integer, p_source text)
returns jsonb
language plpgsql security invoker set search_path to '' as $function$
declare
  v_inbound ops.inbound_messages;
  v_run     ops.agent_runs;
  v_review  uuid;
  v_result  jsonb;
begin
  -- The newest admitted message, whatever happened to it.
  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = p_tenant_id and m.conversation_id = p_conversation_id
   order by m.received_at desc, m.created_at desc
   limit 1;
  select r.* into v_run from ops.agent_runs r
   where r.tenant_id = p_tenant_id and r.id = v_inbound.agent_run_id;
  if v_run.id is null then
    raise exception using errcode = 'OS409', message = 'ops.open_person_reply_review: no message in this conversation can be answered';
  end if;
  -- SI-72: the newest message's content is gone; nothing new is written about it.
  if exists (select 1 from ops.tasks t
              where t.tenant_id = p_tenant_id and t.id = v_inbound.task_id and t.content_redacted_at is not null) then
    raise exception using errcode = 'OS409',
      message = 'ops.open_person_reply_review: the newest message''s content was erased under retention; a reply waits for the contact''s next message';
  end if;
  -- A run still waiting (an execution stop holds it, or no worker took it
  -- yet) does not hold the person back: its screening, under a person, drafts
  -- at most a protective text, and a draft the agent wrote meanwhile is stale
  -- once a person answered the message.
  perform set_config('ops.person_reply_revision', p_revision::text, true);
  v_review := ops.open_scripted_review(v_run, p_text, 'person', null, p_source);
  perform set_config('ops.person_reply_revision', '', true);
  v_result := ops.record_review_decision(p_tenant_id, v_review, 'accepted', p_actor, p_source, null);
  return jsonb_build_object(
    'state', 'recorded', 'review_item_id', v_review, 'decision', v_result ->> 'status', 'revision', p_revision);
end
$function$;

-- Whether a review is a person's own accepted reply a person_reply send may
-- carry: test or synthetic data, accepted by a principal, not redacted.
create function ops.review_is_person_reply(p_item ops.review_items)
returns boolean
language sql stable security invoker set search_path to '' as $function$
  select p_item.author = 'person' and p_item.status = 'accepted' and p_item.decision_basis = 'person'
     and p_item.reviewer ~ '^principal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and p_item.content_redacted_at is null
     and exists (select 1 from ops.tasks t
                  where t.tenant_id = p_item.tenant_id and t.id = p_item.task_id
                    and t.data_class in ('synthetic', 'test') and t.content_redacted_at is null);
$function$;

-- Asks for the send of a person's reply the same act accepted and queues the
-- one job that carries it (SI-87). The table's guard admits the row only under
-- this act's mark.
create function ops.authorize_person_reply(p_review_id uuid, p_actor text, p_check jsonb)
returns uuid
language plpgsql security invoker set search_path to '' as $function$
declare
  v_item    ops.review_items;
  v_inbound ops.inbound_messages;
  v_conv    ops.conversations;
  v_out     uuid := gen_random_uuid();
  v_job     uuid;
begin
  select ri.* into v_item from ops.review_items ri where ri.id = p_review_id for update;
  if not found or not ops.review_is_person_reply(v_item) or v_item.reviewer is distinct from p_actor then
    raise exception using errcode = 'OS500', message = 'ops.authorize_person_reply: not this act''s accepted reply';
  end if;
  select m.* into v_inbound from ops.inbound_messages m
   where m.tenant_id = v_item.tenant_id and m.task_id = v_item.task_id
     and m.source_kind = 'whatsapp' and m.conversation_id is not null
   order by m.received_at desc
   limit 1;
  select c.* into v_conv from ops.conversations c
   where c.tenant_id = v_item.tenant_id and c.id = v_inbound.conversation_id;
  v_job := ops.enqueue_job(v_item.tenant_id, 'outbound.reply_send',
                           jsonb_build_object('outbound_message_id', v_out), 100, now(), 5,
                           format('reply_send:%s', v_out));
  perform set_config('ops.person_reply_send', v_item.id::text, true);
  insert into ops.outbound_messages (
    id, tenant_id, company_id, channel_id, conversation_id, review_item_id, task_id,
    status, requested_by, authorized_check, authorization_kind, job_id, fresh_until)
  values (
    v_out, v_item.tenant_id, v_item.company_id, v_inbound.channel_id, v_conv.id, v_item.id, v_item.task_id,
    'authorized', p_actor, p_check, 'person_reply', v_job, v_conv.last_inbound_at + interval '24 hours');
  perform set_config('ops.person_reply_send', '', true);
  perform ops.record_event(
    v_item.tenant_id, v_item.company_id, 'communication.outbound_authorized', 'company-os-ui', 'task', v_item.task_id,
    jsonb_build_object('outbound_message_id', v_out, 'review_item_id', v_item.id));
  return v_out;
end
$function$;

-- Whether an earlier person's reply of the same conversation is still to
-- leave: the later one waits, so replies leave in the order they were written
-- (the order of their review events, recorded under the conversation's lock).
-- An earlier reply the contact's newer message made stale never holds it.
-- Whether a message of a person's reply's conversation, the one it answers
-- included, is admitted and still to be screened: the reply waits, so that an
-- opt-out or a crisis in it is seen before the reply leaves (ADR 0026 §E).
create function ops.person_reply_message_unscreened(p_out ops.outbound_messages)
returns boolean
language sql stable security invoker set search_path to '' as $function$
  select exists (
    select 1
      from ops.inbound_messages m
      join ops.agent_runs r on r.tenant_id = m.tenant_id and r.id = m.agent_run_id
     where m.tenant_id = p_out.tenant_id and m.conversation_id = p_out.conversation_id
       and r.status in ('pending', 'running')
       and not exists (select 1 from ops.inbound_screenings s
                        where s.tenant_id = r.tenant_id and s.agent_run_id = r.id));
$function$;

create function ops.person_reply_waits_for_earlier(p_out ops.outbound_messages)
returns boolean
language sql stable security invoker set search_path to '' as $function$
  select exists (
    select 1
      from ops.outbound_messages p
      join ops.review_items pr on pr.tenant_id = p.tenant_id and pr.id = p.review_item_id
      join ops.events pe on pe.tenant_id = p.tenant_id
                        and pe.idempotency_key = format('review:%s:pending', p.review_item_id)
      join ops.events me on me.tenant_id = p_out.tenant_id
                        and me.idempotency_key = format('review:%s:pending', p_out.review_item_id)
     where p.tenant_id = p_out.tenant_id and p.conversation_id = p_out.conversation_id
       and p.authorization_kind = 'person_reply' and p.id <> p_out.id
       and p.status in ('authorized', 'sending') and pe.seq < me.seq
       and not ops.cos_review_superseded(p.tenant_id, pr));
$function$;

-- The browser inbox's reply (SI-87). Every refusal is an answer state, with
-- nothing written; errors are a malformed request (OS400), an unknown ref
-- (OS404) and what the gate adds (OS401/403/409, OS429, OS500).
create function ops.reply_to_conversation_as_member(
  p_tenant_id uuid, p_actor text, p_task_id uuid, p_text text, p_expected_revision integer)
returns jsonb
language plpgsql volatile security invoker set search_path to '' as $function$
declare
  v_pre     record;
  v_refusal text;
  v_reason  text;
  v_anchor  uuid;
  v_probe   ops.outbound_messages;
  v_check   jsonb;
  v_rec     jsonb;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  if p_text is null or char_length(p_text) not between 1 and 2000 or p_text !~ '[^[:space:]]'
     or p_text ~ '[\x01-\x09\x0B-\x1F\x7F-\x9F]'
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  -- Before the ref is read: without a recent factor nothing about it is learnt.
  if not ops.operator_second_factor_recent() then
    return jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()), 'outcome', 'second_factor_required',
                              'revision', null, 'reason', null);
  end if;
  select * into v_pre from ops.inbox_preflight(p_tenant_id, p_task_id, p_expected_revision, 'reply');
  v_refusal := v_pre.refusal;
  -- The same member asking again for the same text at the same revision (a
  -- second click, a resubmit after a lost answer) is answered with what it
  -- already recorded, unless that send failed or was blocked.
  if v_refusal is null and exists (
       select 1
         from ops.review_items ri
         join ops.inbound_messages m on m.tenant_id = ri.tenant_id and m.task_id = ri.task_id
         left join ops.outbound_messages o on o.tenant_id = ri.tenant_id and o.review_item_id = ri.id
        where ri.tenant_id = p_tenant_id and m.conversation_id = (v_pre.conversation).id
          and ri.author = 'person' and ri.reviewer = p_actor and ri.conversation_revision = v_pre.revision
          and ri.proposed ->> 'response_draft' = p_text
          and (o.id is null or o.status not in ('failed', 'blocked'))) then
    v_refusal := 'already_recorded';
  end if;
  if v_refusal is null then
    v_reason := ops.cos_person_reply_refusal(p_tenant_id, (v_pre.conversation).id, v_pre.revision);
    if v_reason = 'do_not_contact' then
      v_refusal := 'not_sendable';
    elsif v_reason is not null then
      v_refusal := v_reason;
      v_reason := null;
    end if;
  end if;
  if v_refusal is null then
    -- The send's own gates, now: what the send would refuse is refused here,
    -- with nothing written; a stop holds the send instead.
    select m.task_id into v_anchor from ops.inbound_messages m
     where m.tenant_id = p_tenant_id and m.conversation_id = (v_pre.conversation).id
     order by m.received_at desc, m.created_at desc
     limit 1;
    v_probe.tenant_id := p_tenant_id;
    v_probe.conversation_id := (v_pre.conversation).id;
    v_probe.task_id := v_anchor;
    v_check := ops.reply_send_eligibility(p_tenant_id, v_probe);
    if not (v_check ->> 'eligible')::boolean and v_check ->> 'reason' is distinct from 'execution_stopped' then
      v_refusal := 'not_sendable';
      v_reason := v_check ->> 'reason';
    end if;
  end if;
  if v_refusal is null then
    v_rec := ops.open_person_reply_review(p_tenant_id, (v_pre.conversation).id, p_text, p_actor,
                                          v_pre.revision, 'company-os-ui');
    perform ops.authorize_person_reply((v_rec ->> 'review_item_id')::uuid, p_actor, v_check);
  end if;
  return jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'outcome', coalesce(v_refusal, 'queued'),
    'revision', case when v_refusal = 'withheld' then null else v_pre.revision end,
    'reason', case when v_refusal = 'not_sendable' then coalesce(v_reason, 'do_not_contact') end);
end
$function$;

-- The browser inbox's release (SI-87): the owner's release at the revision
-- the member saw, never while an opt-out is open.
create function ops.release_conversation_as_member(
  p_tenant_id uuid, p_actor text, p_task_id uuid, p_expected_revision integer)
returns jsonb
language plpgsql volatile security invoker set search_path to '' as $function$
declare
  v_pre     record;
  v_refusal text;
  v_result  jsonb;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  select * into v_pre from ops.inbox_preflight(p_tenant_id, p_task_id, p_expected_revision, 'release');
  v_refusal := v_pre.refusal;
  if v_refusal is null and exists (
       select 1 from ops.exceptions e
        where e.tenant_id = p_tenant_id and e.conversation_id = (v_pre.conversation).id
          and e.kind = 'opt_out' and e.resolved_at is null) then
    v_refusal := 'opt_out_open';
  end if;
  if v_refusal is null then
    v_result := ops.release_conversation(p_tenant_id, (v_pre.conversation).id, p_actor);
  end if;
  return jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'outcome', coalesce(v_refusal, v_result ->> 'state'),
    'revision', case when v_refusal = 'withheld' then null else v_pre.revision end);
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. The functions this slice replaces, each from its latest definition.
-- ---------------------------------------------------------------------------

-- As 20261017120000, its review and acceptance through the shared helper; the
-- owner's CLI keeps its source and its answer.
create or replace function ops.record_person_reply(
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
  -- ADR 0026 §E: the review and its acceptance, shared with the browser inbox.
  return ops.open_person_reply_review(p_tenant_id, p_conversation_id, p_text, p_actor, v_revision, 'operator-cli');
end
$function$;

-- As 20261019140000, with one do-not-contact snapshot for the review and the
-- inbox's refusal.
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
  -- ADR 0026 §C: an opt-out the message lifted no longer applies to it.
  v_dnc := ops.cos_message_do_not_contact(p_run.tenant_id, p_run.task_id);
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

-- As 20261018120000, with a person's reply admitted only from the act that
-- accepted it (SI-87).
create or replace function ops.guard_outbound_message()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_unbegun boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'authorized' then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: a send begins authorized';
    end if;
    if not exists (select 1 from ops.communication_channels c
                    where c.id = new.channel_id and c.tenant_id = new.tenant_id and c.mode = 'test') then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: BASELINE Q8 is open; only a channel configured test may send';
    end if;
    -- ADR 0026 §B: a send authorized as policy rests on a review the policy
    -- accepted under the predicate, for the text that review carries.
    if new.authorization_kind = 'fixed_text' and not exists (
         select 1
           from ops.review_items v
           join ops.inbound_screenings s on s.tenant_id = v.tenant_id and s.agent_run_id = v.agent_run_id
          where v.tenant_id = new.tenant_id and v.id = new.review_item_id
            and v.status = 'accepted' and v.decision_basis = 'published_fixed_text'
            and s.fixed_message_key = new.fixed_text_key
            and s.fixed_messages_version_id = new.fixed_messages_version_id
            and ops.review_is_published_fixed_text(v, null)) then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: a policy send rests on a published fixed text the policy accepted';
    end if;
    -- ADR 0026 §E (SI-87): a person's own reply leaves only by the act that
    -- wrote it: the same transaction's mark, the same principal's acceptance
    -- of a person review of test data in this transaction, its own queued
    -- reply job, and the contact's window as its bound.
    if new.authorization_kind = 'person_reply' and not (
         coalesce(current_setting('ops.person_reply_send', true), '') = new.review_item_id::text
         and new.requested_by ~ '^principal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and exists (select 1 from ops.review_items v
                      where v.tenant_id = new.tenant_id and v.id = new.review_item_id and v.task_id = new.task_id
                        and ops.review_is_person_reply(v) and v.reviewer = new.requested_by
                        and v.reviewed_at = now())
         and exists (select 1 from ops.jobs j
                      where j.tenant_id = new.tenant_id and j.id = new.job_id and j.kind = 'outbound.reply_send'
                        and j.status = 'queued' and j.payload ->> 'outbound_message_id' = new.id::text)
         and new.fresh_until = (select c.last_inbound_at + interval '24 hours' from ops.conversations c
                                 where c.tenant_id = new.tenant_id and c.id = new.conversation_id)) then
      raise exception using errcode = 'OS403',
        message = 'ops.outbound_messages: a person''s reply is sent only by the act that accepted it';
    end if;
    if new.transport is not null or new.job_attempt is not null then
      raise exception using errcode = 'OS403', message = 'ops.outbound_messages: a send begins with no transport';
    end if;
    return new;
  end if;

  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.company_id is distinct from old.company_id
     or new.channel_id is distinct from old.channel_id
     or new.conversation_id is distinct from old.conversation_id
     or new.review_item_id is distinct from old.review_item_id
     or new.task_id is distinct from old.task_id
     or new.authorized_at is distinct from old.authorized_at
     or new.created_at is distinct from old.created_at
     or new.authorization_kind is distinct from old.authorization_kind
     or new.job_id is distinct from old.job_id
     or new.fixed_text_key is distinct from old.fixed_text_key
     or new.fixed_messages_version_id is distinct from old.fixed_messages_version_id
     or new.fresh_until is distinct from old.fresh_until then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: what was authorized is immutable';
  end if;
  -- ADR 0026 §B: the one edge back. A job's send its last gate found a reason
  -- to wait on, before any call: it returns to authorized as if it had never
  -- begun, its begin's marks cleared.
  v_unbegun := old.job_id is not null and old.status = 'sending' and new.status = 'authorized'
               and old.provider_message_id is null and new.provider_message_id is null
               and new.sending_at is null and new.send_check is null and new.privacy_notice_id is null
               and new.transport is null and new.job_attempt is null and new.settled_at is null;
  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the provider message id is set once';
  end if;
  if new.privacy_notice_id is distinct from old.privacy_notice_id and not v_unbegun
     and not (old.privacy_notice_id is null and old.status = 'authorized' and new.status = 'sending'
              and exists (select 1 from ops.privacy_notices n
                           where n.id = new.privacy_notice_id and n.tenant_id = new.tenant_id)) then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the privacy notice is the tenant''s own, attached once as the send begins';
  end if;

  -- The transport and the attempt are recorded once, as a job's send begins.
  if (new.transport is distinct from old.transport or new.job_attempt is distinct from old.job_attempt)
     and not v_unbegun
     and not (old.transport is null and old.status = 'authorized' and new.status = 'sending') then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: the transport and the attempt are recorded once, as the send begins';
  end if;
  -- A send a job carries is never asked for again: a person writes a new reply.
  if old.job_id is not null and old.status = 'blocked' and new.status = 'authorized' then
    raise exception using errcode = 'OS409', message = 'ops.outbound_messages: a send a job carries is never asked for again';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'authorized'    and new.status in ('sending', 'blocked'))
    or (old.status = 'blocked'       and new.status = 'authorized')
    or v_unbegun
    or (old.status = 'sending'       and new.status in ('sent', 'failed', 'indeterminate', 'delivered', 'read'))
    or (old.status = 'indeterminate' and new.status in ('sent', 'delivered', 'read', 'failed'))
    or (old.status = 'sent'          and new.status in ('delivered', 'read', 'failed'))
    or (old.status = 'delivered'     and new.status = 'read')
    -- The provider can report one message both failed and delivered (several
    -- devices); delivered means at least one device received it, so delivery
    -- evidence wins over an earlier failure.
    or (old.status = 'failed'        and new.status in ('delivered', 'read'))) then
    raise exception using errcode = 'OS409',
      message = format('ops.outbound_messages: a send cannot move from %s to %s', old.status, new.status);
  end if;
  if new.status = 'sending' and old.status <> 'sending' and not exists (
    select 1 from ops.communication_channels c
     where c.id = new.channel_id and c.tenant_id = new.tenant_id and c.mode = 'test' and c.active) then
    raise exception using errcode = 'OS403',
      message = 'ops.outbound_messages: BASELINE Q8 is open; only an active channel configured test may send';
  end if;
  new.updated_at := now();
  return new;
end
$function$;

-- As 20261018120000, carrying a person's reply too: its own bound, after any
-- earlier reply of the conversation, with no published-policy check.
create or replace function ops.begin_reply_send(p_transport text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_job     ops.jobs := ops.leased_job();
  v_out     ops.outbound_messages;
  v_review  ops.review_items;
  v_conv    ops.conversations;
  v_channel ops.communication_channels;
  v_notice  ops.privacy_notices;
  v_policy  uuid;
  v_check   jsonb;
  v_body    text;
begin
  if v_job.kind <> 'outbound.reply_send' then
    raise exception using errcode = '42501', message = 'ops.begin_reply_send: the leased job is not a reply send';
  end if;
  select o.* into v_out from ops.outbound_messages o
   where o.tenant_id = v_job.tenant_id and o.job_id = v_job.id
     for update;
  if not found then
    raise exception using errcode = '42501', message = 'ops.begin_reply_send: no send is bound to the leased job';
  end if;

  if v_out.status = 'sending' then
    if v_out.job_attempt is not distinct from v_job.attempts then
      raise exception using errcode = '42501', message = 'ops.begin_reply_send: this attempt already began the send; a send is never made twice';
    end if;
    -- An earlier attempt began the call and never settled it: it may have
    -- reached the provider. Never call again; a person resolves it.
    update ops.outbound_messages
       set status = 'indeterminate', settled_at = now(), error_class = 'execution_interrupted'
     where id = v_out.id;
    perform ops.record_event(
      v_out.tenant_id, v_out.company_id, 'communication.outbound_indeterminate', 'agent-runtime', 'task', v_out.task_id,
      jsonb_build_object('outbound_message_id', v_out.id));
    perform ops.sync_send_exceptions(v_out.tenant_id, v_out.id, 'agent-runtime');
    return jsonb_build_object('action', 'settled', 'status', 'indeterminate', 'outboundMessageId', v_out.id);
  end if;
  if v_out.status <> 'authorized' then
    return jsonb_build_object('action', 'settled', 'status', v_out.status, 'outboundMessageId', v_out.id);
  end if;

  -- The kill switch, for every scope the job's unit has (SI-37).
  perform pg_advisory_xact_lock_shared(ops.execution_stop_lock_key());
  if ops.job_covering_stop(v_job.tenant_id, v_job.id, v_job.kind) is not null then
    return jsonb_build_object('action', 'stopped', 'outboundMessageId', v_out.id);
  end if;

  -- A text the contact's newer message replaced is no one's to chase: the
  -- stale rule first, so it never raises send_blocked.
  select ri.* into v_review from ops.review_items ri
   where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id;
  if ops.cos_review_superseded(v_out.tenant_id, v_review) then
    return ops.block_reply_send(v_out, jsonb_build_object('eligible', false, 'reason', 'newer_message'));
  end if;

  -- Fresh, and carried by a worker that has a transport; a worker without one
  -- gives the job back until the text is out of date.
  if now() >= v_out.fresh_until then
    return ops.block_reply_send(v_out, jsonb_build_object(
      'eligible', false,
      'reason', case when p_transport is null or p_transport not in ('meta', 'fake') then 'transport_not_configured'
                     when v_out.authorization_kind = 'person_reply' then 'outside_service_window'
                     else 'fixed_text_expired' end));
  end if;
  if p_transport is null or p_transport not in ('meta', 'fake') then
    perform ops.release_reply_job(v_job, v_out.fresh_until, 'waiting for a worker with a reply transport');
    return jsonb_build_object('action', 'released', 'outboundMessageId', v_out.id);
  end if;

  -- An acknowledgement answers the request, not the words around it: it waits
  -- while a newer message of the conversation is still to be screened, so that
  -- a newer opt-out or a newer text of its family is seen first (ADR 0026 §B).
  if v_out.fixed_text_key in ('safety', 'safety_followup', 'human_handoff_ack', 'opt_out_ack')
     and ops.reply_newer_message_unscreened(v_out) then
    perform ops.release_reply_job(v_job, v_out.fresh_until, 'waiting for a newer message to be screened');
    return jsonb_build_object('action', 'released', 'outboundMessageId', v_out.id);
  end if;
  -- ADR 0026 §E: a person's replies leave in the order they were written.
  if v_out.authorization_kind = 'person_reply' and ops.person_reply_waits_for_earlier(v_out) then
    perform ops.release_reply_job(v_job, v_out.fresh_until, 'waiting for an earlier reply of the conversation');
    return jsonb_build_object('action', 'released', 'outboundMessageId', v_out.id);
  end if;
  -- ADR 0026 §E: and only once every message it may be answering is screened,
  -- so that an opt-out or a crisis in the one it answers is seen first.
  if v_out.authorization_kind = 'person_reply' and ops.person_reply_message_unscreened(v_out) then
    perform ops.release_reply_job(v_job, v_out.fresh_until, 'waiting for the contact''s messages to be screened');
    return jsonb_build_object('action', 'released', 'outboundMessageId', v_out.id);
  end if;

  -- Every gate again: the send's eligibility and the opt-out rule (the stop
  -- last), the policy as published now, and the redaction.
  v_check := ops.reply_send_eligibility(v_out.tenant_id, v_out);
  if v_check ->> 'reason' = 'execution_stopped' then
    return jsonb_build_object('action', 'stopped', 'outboundMessageId', v_out.id);
  end if;
  if (v_check ->> 'eligible')::boolean then
    if v_out.authorization_kind = 'person_reply' then
      -- ADR 0026 §E: a person's own reply, accepted by its principal, of test
      -- data: no published-policy check.
      if not ops.review_is_person_reply(v_review) then
        v_check := jsonb_build_object('eligible', false, 'reason',
          case when v_review.content_redacted_at is not null then 'content_redacted' else 'not_a_person_reply' end);
      end if;
    else
      v_policy := (ops.published_agent_configuration(
                     v_out.tenant_id,
                     (select r.agent_id from ops.agent_runs r where r.tenant_id = v_review.tenant_id and r.id = v_review.agent_run_id),
                     'operating_policy')).id;
      if not ops.review_is_published_fixed_text(v_review, v_policy) then
        v_check := jsonb_build_object('eligible', false, 'reason',
          case when v_review.content_redacted_at is not null then 'content_redacted' else 'not_automatic' end);
      end if;
    end if;
  end if;
  if not (v_check ->> 'eligible')::boolean then
    return ops.block_reply_send(v_out, v_check);
  end if;

  select c.* into v_conv from ops.conversations c where c.tenant_id = v_out.tenant_id and c.id = v_out.conversation_id;
  select h.* into v_channel from ops.communication_channels h where h.tenant_id = v_out.tenant_id and h.id = v_out.channel_id;
  v_body := v_review.proposed ->> 'response_draft';
  -- The privacy notice rides the conversation's first reply (SI-79), as on the
  -- operator's send.
  select n.* into v_notice from ops.privacy_notices n
   where n.tenant_id = v_out.tenant_id and n.superseded_at is null;
  if found and exists (select 1 from ops.outbound_messages o
                        where o.tenant_id = v_out.tenant_id and o.conversation_id = v_out.conversation_id
                          and o.privacy_notice_id = v_notice.id and o.status in ('delivered', 'read')) then
    v_notice := null;
  end if;
  if v_notice.id is not null then
    v_body := v_body || pg_catalog.repeat(pg_catalog.chr(10), 2) || v_notice.whatsapp_text;
  end if;

  update ops.outbound_messages
     set status = 'sending', sending_at = now(), send_check = v_check, privacy_notice_id = v_notice.id,
         transport = p_transport, job_attempt = v_job.attempts
   where id = v_out.id;
  perform ops.record_event(
    v_out.tenant_id, v_out.company_id, 'communication.outbound_attempted', 'agent-runtime', 'task', v_out.task_id,
    jsonb_build_object('outbound_message_id', v_out.id));
  return jsonb_build_object(
    'action', 'start',
    'outboundMessageId', v_out.id,
    'request', jsonb_build_object(
      'providerTarget', v_channel.provider_target,
      'to', v_conv.contact_ref,
      'body', v_body));
end
$function$;

-- As 20261018120000, for every send a job carries.
create or replace function ops.settle_stale_reply_sends()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_row     record;
  v_out     ops.outbound_messages;
  v_settled integer := 0;
begin
  for v_row in
    select o.id, j.status as job_status
      from ops.outbound_messages o
      join ops.jobs j on j.tenant_id = o.tenant_id and j.id = o.job_id
     where o.job_id is not null
       and j.status in ('failed', 'succeeded')
       and o.status in ('authorized', 'sending')
     order by o.created_at, o.id
     limit 500
       for update of o skip locked
  loop
    select * into v_out from ops.outbound_messages where id = v_row.id;
    if v_out.status = 'authorized' then
      perform ops.block_reply_send(v_out, jsonb_build_object('eligible', false, 'reason',
        case when exists (select 1 from ops.review_items ri
                           where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                             and ops.cos_review_superseded(v_out.tenant_id, ri))
             then 'newer_message' else 'job_failed' end));
    else
      update ops.outbound_messages
         set status = 'indeterminate', settled_at = now(), error_class = 'execution_interrupted'
       where id = v_out.id;
      perform ops.record_event(
        v_out.tenant_id, v_out.company_id, 'communication.outbound_indeterminate', 'agent-runtime', 'task', v_out.task_id,
        jsonb_build_object('outbound_message_id', v_out.id));
      perform ops.sync_send_exceptions(v_out.tenant_id, v_out.id, 'agent-runtime');
    end if;
    v_settled := v_settled + 1;
  end loop;
  return v_settled;
end
$function$;

-- As 20261019160000, with a person's reply's own bound, and the opt-out record
-- keyed on an acknowledgement a fixed text drafted.
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
                      then 'newer_message'
                      when v_out.authorization_kind = 'person_reply' then 'outside_service_window'
                      else 'fixed_text_expired' end;
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

  -- ADR 0026 §C: an acknowledgement of an opt-out a person accepted, once
  -- settled (but for a newer message's, whose own acknowledgement decides),
  -- makes every opt-out of the conversation up to its message due now. An
  -- automatic acknowledgement leaves the record at the window's end, so a
  -- person can still dismiss an opt-out the screen read wrongly.
  if v_out.status in ('sent', 'delivered', 'read', 'failed', 'indeterminate', 'blocked')
     and v_out.blocked_reason is distinct from 'newer_message'
     and v_out.error_class is distinct from 'newer_message'
     and exists (select 1
                   from ops.review_items ri
                   join ops.inbound_screenings s on s.tenant_id = ri.tenant_id and s.agent_run_id = ri.agent_run_id
                  where ri.tenant_id = v_out.tenant_id and ri.id = v_out.review_item_id
                    and s.fixed_message_key = 'opt_out_ack' and ri.decision_basis = 'person'
                    and ri.author = 'fixed') then
    perform ops.move_crm_opt_out_records(v_out.tenant_id, v_out.conversation_id, v_out.task_id);
  end if;

  return jsonb_build_object('opened', v_opened, 'closed', v_closed);
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. Access: no role executes the new functions or the replaced ones but the
--    worker's two capabilities; the gates of 20261021130000 run them as their
--    owner.
-- ---------------------------------------------------------------------------

revoke all on function
  ops.cos_inbox_conversation(uuid, uuid), ops.cos_conversation_visible(uuid, uuid),
  ops.cos_conversation_waiting(uuid, uuid), ops.cos_conversation_first_name(uuid, uuid),
  ops.cos_message_do_not_contact(uuid, uuid), ops.cos_person_reply_refusal(uuid, uuid, integer),
  ops.cos_conversation_turns(uuid, uuid), ops.read_conversation(uuid, uuid),
  ops.operator_second_factor_recent(), ops.inbox_preflight(uuid, uuid, integer, text),
  ops.open_person_reply_review(uuid, uuid, text, text, integer, text), ops.review_is_person_reply(ops.review_items),
  ops.authorize_person_reply(uuid, text, jsonb), ops.person_reply_waits_for_earlier(ops.outbound_messages),
  ops.person_reply_message_unscreened(ops.outbound_messages),
  ops.reply_to_conversation_as_member(uuid, text, uuid, text, integer),
  ops.release_conversation_as_member(uuid, text, uuid, integer),
  ops.record_person_reply(uuid, uuid, text, text, integer), ops.open_scripted_review(ops.agent_runs, text, text, text, text),
  ops.guard_outbound_message(), ops.sync_send_exceptions(uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
revoke all on function ops.begin_reply_send(text), ops.settle_stale_reply_sends()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;
grant execute on function ops.begin_reply_send(text) to ops_worker;
grant execute on function ops.settle_stale_reply_sends() to ops_worker;

comment on function ops.read_conversation(uuid, uuid) is
  'ADR 0026 §E, SI-87: one waiting conversation of the tenant for the browser inbox, by any task of its inbound messages: turns, holder, opt-out, first word of name, window and revision for test data, or a state. Read only; called by ops.gate_get_conversation.';
comment on function ops.reply_to_conversation_as_member(uuid, text, uuid, text, integer) is
  'ADR 0026 §E, SI-87: a member''s own reply to a waiting conversation a person holds, at the revision the member saw, with a recent second factor: one accepted person review, one person_reply send request and one reply job, or a refusal state with nothing written. Called by ops.gate_reply_to_conversation.';
comment on function ops.release_conversation_as_member(uuid, text, uuid, integer) is
  'ADR 0026 §E, SI-87: the owner''s release of a waiting conversation at the revision the member saw, never while an opt-out is open, or a refusal state. Called by ops.gate_release_conversation.';
comment on function ops.operator_second_factor_recent() is
  'ADR 0026 §E, SI-74, SI-87: whether the caller''s session verified, within the hour, an authenticator-app factor the user had before the session began, by the auth provider''s own records; waived only by the non-production exemption row.';

do $end_state$
declare
  v_bad text;
  c_stable constant text[] := array[
    'ops.cos_inbox_conversation(uuid,uuid)', 'ops.cos_conversation_visible(uuid,uuid)',
    'ops.cos_conversation_waiting(uuid,uuid)', 'ops.cos_conversation_first_name(uuid,uuid)',
    'ops.cos_message_do_not_contact(uuid,uuid)', 'ops.cos_person_reply_refusal(uuid,uuid,integer)',
    'ops.cos_conversation_turns(uuid,uuid)', 'ops.read_conversation(uuid,uuid)',
    'ops.operator_second_factor_recent()', 'ops.review_is_person_reply(ops.review_items)',
    'ops.person_reply_waits_for_earlier(ops.outbound_messages)',
    'ops.person_reply_message_unscreened(ops.outbound_messages)'];
  c_volatile constant text[] := array[
    'ops.inbox_preflight(uuid,uuid,integer,text)', 'ops.open_person_reply_review(uuid,uuid,text,text,integer,text)',
    'ops.authorize_person_reply(uuid,text,jsonb)',
    'ops.reply_to_conversation_as_member(uuid,text,uuid,text,integer)',
    'ops.release_conversation_as_member(uuid,text,uuid,integer)'];
  c_read constant text[] := array[
    'ops.cos_inbox_conversation(uuid,uuid)', 'ops.cos_conversation_visible(uuid,uuid)',
    'ops.cos_conversation_waiting(uuid,uuid)', 'ops.cos_conversation_first_name(uuid,uuid)',
    'ops.cos_message_do_not_contact(uuid,uuid)', 'ops.cos_person_reply_refusal(uuid,uuid,integer)',
    'ops.cos_conversation_turns(uuid,uuid)', 'ops.read_conversation(uuid,uuid)'];
begin
  -- Every new function: a pinned INVOKER of the expected volatility that no
  -- role executes.
  select pg_catalog.string_agg(f, ', ') into v_bad
    from pg_catalog.unnest(c_stable || c_volatile) f
   where pg_catalog.to_regprocedure(f) is null;
  if v_bad is not null then
    raise exception 'an inbox function is missing: %', v_bad;
  end if;
  select pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::pg_catalog.text, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array(select f::pg_catalog.regprocedure from pg_catalog.unnest(c_stable || c_volatile) f))
     and (p.prosecdef
          or pg_catalog.pg_get_userbyid(p.proowner) <> 'postgres'
          or p.proconfig is distinct from array['search_path=""']
          or p.proacl is null
          or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
          or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                           ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                      where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE'))
          or (p.oid = any (array(select f::pg_catalog.regprocedure from pg_catalog.unnest(c_stable) f))
              and p.provolatile <> 's')
          or (p.oid = any (array(select f::pg_catalog.regprocedure from pg_catalog.unnest(c_volatile) f))
              and p.provolatile <> 'v'));
  if v_bad is not null then
    raise exception 'an inbox function is reachable, not a pinned INVOKER, or of the wrong volatility: %', v_bad;
  end if;
  -- The read graph only reads.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p
   where p.oid = any (array(select f::pg_catalog.regprocedure from pg_catalog.unnest(c_read) f))
     and p.prosrc ~* '(\m(insert|update|delete|truncate|merge|copy)\M|email|public\.|(^|[[:space:];])execute[[:space:]])';
  if v_bad is not null then
    raise exception 'an inbox read reaches beyond reading: %', v_bad;
  end if;
  -- The worker's two capabilities stay its own.
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid in ('ops.begin_reply_send(text)'::pg_catalog.regprocedure,
                              'ops.settle_stale_reply_sends()'::pg_catalog.regprocedure)
                and (not p.prosecdef or p.proconfig is distinct from array['search_path=""']
                     or not pg_catalog.has_function_privilege('ops_worker', p.oid, 'EXECUTE')
                     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'),
                                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                                 where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')))) then
    raise exception 'a reply-send capability is not a pinned DEFINER the worker alone executes';
  end if;
  -- Each replaced function kept its logic and gained its step.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.guard_outbound_message()'::pg_catalog.regprocedure), 'ops.person_reply_send') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.guard_outbound_message()'::pg_catalog.regprocedure),
                          'review_is_published_fixed_text') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_reply_send(text)'::pg_catalog.regprocedure), 'review_is_person_reply') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_reply_send(text)'::pg_catalog.regprocedure),
                          'person_reply_waits_for_earlier') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_reply_send(text)'::pg_catalog.regprocedure),
                          'person_reply_message_unscreened') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.begin_reply_send(text)'::pg_catalog.regprocedure),
                          'review_is_published_fixed_text') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.settle_stale_reply_sends()'::pg_catalog.regprocedure),
                          'authorization_kind = ''fixed_text''') > 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.sync_send_exceptions(uuid, uuid, text)'::pg_catalog.regprocedure),
                          'ri.author = ''fixed''') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.open_scripted_review(ops.agent_runs, text, text, text, text)'::pg_catalog.regprocedure),
                          'cos_message_do_not_contact') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.record_person_reply(uuid, uuid, text, text, integer)'::pg_catalog.regprocedure),
                          'open_person_reply_review') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.record_person_reply(uuid, uuid, text, text, integer)'::pg_catalog.regprocedure),
                          '''operator-cli''') = 0 then
    raise exception 'a replaced send or review function lost its step or its earlier logic';
  end if;
  -- The inbox acts take the conversation, then its state; the screening takes
  -- the state, then the conversation for key share only. They never wait on
  -- each other in a cycle only because key share admits no key update: the
  -- screening must take no stronger lock on a conversation, nor change one.
  if (select p.prosrc from pg_catalog.pg_proc p
       where p.oid = 'ops.record_inbound_screening(jsonb)'::pg_catalog.regprocedure)
     ~* '(ops\.conversations[^;]*for[[:space:]]+(update|no[[:space:]]+key[[:space:]]+update|share)|update[[:space:]]+ops\.conversations)' then
    raise exception 'the screening locks a conversation more strongly than the inbox acts allow';
  end if;
  if exists (select 1 from pg_catalog.pg_trigger t
              where t.tgrelid = 'ops.outbound_messages'::pg_catalog.regclass
                and t.tgname = 'outbound_messages_guard' and t.tgenabled <> 'A')
     or pg_catalog.strpos((select pg_catalog.pg_get_constraintdef(c.oid) from pg_catalog.pg_constraint c
                            where c.conname = 'outbound_messages_authorization_kind_check'), 'person_reply') = 0
     or exists (select 1 from ops.outbound_messages where authorization_kind = 'person_reply') then
    raise exception 'the send table does not hold the person_reply kind under its guard';
  end if;
  -- The order of person replies is the order of their events.
  if (select s.seqcache from pg_catalog.pg_sequence s
       where s.seqrelid = pg_catalog.pg_get_serial_sequence('ops.events', 'seq')::pg_catalog.regclass) <> 1 then
    raise exception 'the event order is cached: person replies could leave out of order';
  end if;
end
$end_state$;
