-- ADR 0026 §C, slice 3d: the CRM copy of a WhatsApp lead follows the
-- number's retention.
--
-- A contact the system created for a number (slice 3a) holds that number and
-- the first name the sender chose. When the number is erased (at the end of
-- its retention, or on the owner's act), such a contact is deleted with it,
-- unless a person worked on it:
--   * public.crm_contact_edits marks a contact a person changed: any write to
--     the contact, its lead profile or its attributions that no backend
--     adapter marked as its own (ops.crm_write = 'system'). Content-free,
--     append-only, read by no application role.
--   * ops.crm_delete_unedited_lead deletes a contact only when a 'created' act
--     names it, and, after it holds the contact, its lead profile and its
--     attributions: no edit mark, no note, no task, no deal naming it, no
--     consent change of a person or of the contact's own opt-out, and no
--     other conversation whose number is not erased names it (an admission
--     or its own creation). Otherwise the contact is kept. Either way the act
--     is recorded, with no number or name.
--   * ops.erase_contact_identifier asks it about every contact the erased
--     conversation created or its admissions found, so a lead found by a
--     second conversation goes once both numbers are erased, whichever first.
--   * The lead adapter and the two opt-out adapters mark their own writes, so
--     only a person's work keeps a contact.
--
-- ALL DATA IS SYNTHETIC OR TEST (BASELINE Q8). PRODUCTION REAL-DATA
-- AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. The edit marks. Match supabase/schemas (01_tables, 02_functions,
--    04_triggers, 05_policies, 06_grants).
-- ---------------------------------------------------------------------------

create table public.crm_contact_edits (
    -- No foreign key: a mark outlives a merge or a contact's deletion.
    contact_id bigint primary key,
    first_edited_at timestamp with time zone not null
);

CREATE OR REPLACE FUNCTION "public"."mark_crm_contact_edit"() RETURNS trigger
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
    declare
      v_contact bigint;
    begin
      -- A backend adapter's own write (the lead's creation, the contact's own
      -- opt-out or its lift) is not a person's work on the contact.
      if pg_catalog.current_setting('ops.crm_write', true) = 'system' then
        return null;
      end if;
      if tg_table_name = 'contacts' then
        v_contact := new.id;
      else
        v_contact := new.contact_id;
      end if;
      insert into public.crm_contact_edits (contact_id, first_edited_at)
      values (v_contact, pg_catalog.clock_timestamp())
      on conflict (contact_id) do nothing;
      return null;
    end;
    $$;

CREATE OR REPLACE FUNCTION "public"."crm_contact_edits_append_only"() RETURNS trigger
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
    begin
      raise exception 'public.crm_contact_edits is append-only: % refused', lower(tg_op)
        using errcode = '42501';
    end;
    $$;

create or replace trigger mark_crm_contact_edit_trigger
    after update on public.contacts
    for each row execute function public.mark_crm_contact_edit();

create or replace trigger mark_crm_contact_edit_trigger
    after insert or update on public.lead_profiles
    for each row execute function public.mark_crm_contact_edit();

create or replace trigger mark_crm_contact_edit_trigger
    after insert or update on public.acquisition_attributions
    for each row execute function public.mark_crm_contact_edit();

create or replace trigger crm_contact_edits_append_only_trigger
    before update or delete on public.crm_contact_edits
    for each row execute function public.crm_contact_edits_append_only();

create or replace trigger crm_contact_edits_refuse_truncate_trigger
    before truncate on public.crm_contact_edits
    for each statement execute function public.crm_contact_edits_append_only();

alter table public.crm_contact_edits enable row level security;

revoke all on table public.crm_contact_edits from public, anon, authenticated, service_role;
revoke all on function public.mark_crm_contact_edit() from public, anon, authenticated, service_role;
revoke all on function public.crm_contact_edits_append_only() from public, anon, authenticated, service_role;

-- The acts this slice records.
alter table ops.crm_contact_acts drop constraint crm_contact_acts_act_check;
alter table ops.crm_contact_acts add constraint crm_contact_acts_act_check check (act in (
  'created', 'skipped:cap', 'skipped:no_cap', 'skipped:possible_match', 'skipped:error',
  'opted_out', 'opt_out_unresolved', 'opt_out_dismissed', 'opt_out_lifted', 'deleted', 'kept'));
alter table ops.crm_contact_acts drop constraint crm_contact_acts_created_names_contact;
alter table ops.crm_contact_acts add constraint crm_contact_acts_created_names_contact check (
  (act in ('created', 'opted_out', 'opt_out_lifted', 'deleted', 'kept')) = (crm_contact_ref is not null));

-- ---------------------------------------------------------------------------
-- 2. The deletion adapter. Executable by no role; called only by the erasure.
-- ---------------------------------------------------------------------------

-- Answers deleted, kept (a person worked on it, or another conversation whose
-- number is not erased still names it), absent (no such contact any more) or
-- not_created (the system did not create it, or the tenant does not own the
-- CRM).
create function ops.crm_delete_unedited_lead(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_conversation_id uuid,
  p_channel_id      uuid,
  p_contact_ref     text)
returns text
language plpgsql
volatile
security invoker
set search_path to ''
set lock_timeout to '2s'
as $function$
declare
  v_contact bigint := substring(p_contact_ref from '^crm:contact:([0-9]{1,19})$')::bigint;
  v_keep    boolean := false;
begin
  if v_contact is null or p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm)
     or not exists (select 1 from ops.crm_contact_acts a
                     where a.tenant_id = p_tenant_id and a.act = 'created' and a.crm_contact_ref = p_contact_ref) then
    return 'not_created';
  end if;

  -- Hold the contact, its lead profile and its attributions before any
  -- check: a person's note, task or attribution then waits for this
  -- transaction and is seen (or fails its key), and so does a person's edit
  -- of the profile or of an attribution, which never locks the contact.
  perform 1 from public.contacts c where c.id = v_contact for update;
  if not found then
    return 'absent';
  end if;
  perform 1 from public.lead_profiles lp where lp.contact_id = v_contact for update;
  perform 1 from public.acquisition_attributions aa where aa.contact_id = v_contact for update;

  -- Each check its own statement, so each sees what committed while it waited.
  if exists (select 1 from public.crm_contact_edits e where e.contact_id = v_contact) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.contact_notes n where n.contact_id = v_contact) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.tasks t where t.contact_id = v_contact) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.lead_consent_changes c
                             where c.contact_id = v_contact and c.origin in ('person', 'system_opt_out')) then
    v_keep := true;
  end if;
  if not v_keep and exists (select 1 from public.deals d where d.contact_ids @> array[v_contact]) then
    v_keep := true;
  end if;
  if not v_keep and (
       exists (select 1
                 from ops.inbound_messages m
                 join ops.conversations c on c.tenant_id = m.tenant_id and c.id = m.conversation_id
                where m.tenant_id = p_tenant_id and m.crm_contact_ref = p_contact_ref
                  and m.conversation_id <> p_conversation_id and c.contact_erased_at is null)
       or exists (select 1
                    from ops.crm_contact_acts a
                    join ops.conversations c on c.tenant_id = a.tenant_id and c.id = a.conversation_id
                   where a.tenant_id = p_tenant_id and a.act = 'created' and a.crm_contact_ref = p_contact_ref
                     and a.conversation_id <> p_conversation_id and c.contact_erased_at is null)) then
    v_keep := true;
  end if;

  if not v_keep then
    delete from public.contacts where id = v_contact;
  end if;
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id,
          case when v_keep then 'kept' else 'deleted' end, p_contact_ref);
  return case when v_keep then 'kept' else 'deleted' end;
end
$function$;

comment on function ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text) is
  'ADR 0026 §C, SI-79, SI-84: deletes a CRM contact the system created for a number, with its lead profile and attributions, once no conversation whose number is not erased names it and no person worked on it (an edit, a note, a task, a deal, a consent change of a person or of the contact''s own opt-out); records the act. Executable by no role; called only by ops.erase_contact_identifier.';

-- ---------------------------------------------------------------------------
-- 3. The adapters mark their own writes. As 20261019120000,
--    20261019130000 and 20261019140000, each with the mark.
-- ---------------------------------------------------------------------------

create or replace function ops.crm_create_whatsapp_lead(
  p_tenant_id       uuid,
  p_company_id      uuid,
  p_channel_id      uuid,
  p_conversation_id uuid,
  p_sender          text,
  p_first_name      text,
  p_received_at     timestamptz)
returns text
language plpgsql
volatile
security invoker
set search_path to ''
set lock_timeout to '2s'
as $function$
declare
  v_policy  ops.crm_lead_policies;
  v_crm     jsonb;
  v_created integer;
  v_name    text;
  v_contact bigint;
  v_skip    text;
begin
  -- The tenant must own the local CRM, decided before anything of it is read.
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return 'unavailable';
  end if;
  if p_sender is null or p_sender !~ '^[0-9]{6,20}$' or p_received_at is null then
    return 'skipped:error';
  end if;

  -- One number at a time across the tenant's channels.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ops.crm_contact_acts:number:' || p_tenant_id::text || ':' || p_sender, 0));

  -- The conversation's one creation slot, then the exact match afresh.
  if exists (select 1 from ops.crm_contact_acts a
              where a.conversation_id = p_conversation_id and a.act = 'created') then
    return 'skipped:conversation_used';
  end if;
  v_crm := ops.crm_contact_by_phone(p_tenant_id, p_sender);
  if v_crm ->> 'state' = 'found' then
    return 'existing';
  elsif v_crm ->> 'state' in ('ambiguous', 'unavailable') then
    return v_crm ->> 'state';
  end if;

  -- The same person under another format: a person decides.
  if ops.crm_phone_suffix_match(p_sender) then
    v_skip := 'skipped:possible_match';
  else
    select p.* into v_policy from ops.crm_lead_policies p
     where p.tenant_id = p_tenant_id and p.retired_at is null;
    if not found then
      v_skip := 'skipped:no_cap';
    else
      -- The day's count, one tenant at a time so two admissions cannot both
      -- take the last place.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('ops.crm_contact_acts:cap:' || p_tenant_id::text, 0));
      select count(*) into v_created
        from ops.crm_contact_acts a
       where a.tenant_id = p_tenant_id and a.act = 'created'
         and (a.recorded_at at time zone v_policy.time_zone)::date = (now() at time zone v_policy.time_zone)::date;
      if v_created >= v_policy.daily_cap then
        v_skip := 'skipped:cap';
      end if;
    end if;
  end if;
  if v_skip is not null then
    insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act)
    values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, v_skip);
    return v_skip;
  end if;

  -- The sender chose the profile name: the gateway passes a first name only
  -- when its screen found it benign; it is checked again here and otherwise
  -- the owner's placeholder is used. A first name only, at creation only.
  v_name := case
    when p_first_name is not null
     and p_first_name ~ '^[^[:cntrl:][:space:][:digit:][:punct:]=+@<>"\\/:;,!?#$%&*()\[\]{}|_~^`.''-][^[:cntrl:][:space:][:digit:]=+@<>"\\/:;,!?#$%&*()\[\]{}|_~^`]{0,39}$'
    then p_first_name
    else v_policy.name_placeholder
  end;

  -- The system's own write: no person's edit mark (ADR 0026 §C, slice 3d).
  perform pg_catalog.set_config('ops.crm_write', 'system', true);
  insert into public.contacts (first_name, last_name, phone_jsonb, email_jsonb, tags, first_seen, last_seen, sales_id)
  values (v_name, '', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('number', '+' || p_sender, 'type', 'Other')),
          '[]'::pg_catalog.jsonb, '{}'::bigint[], p_received_at, p_received_at, null)
  returning id into v_contact;
  -- The CRM's own trigger added the lead profile (acquired at first_seen).
  insert into public.acquisition_attributions (contact_id, acquired_at, source)
  values (v_contact, p_received_at, 'whatsapp');
  perform pg_catalog.set_config('ops.crm_write', '', true);

  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'created', 'crm:contact:' || v_contact::text);
  perform ops.record_event(
    p_tenant_id, p_company_id, 'lead.created', 'whatsapp-gateway', 'company', p_company_id,
    pg_catalog.jsonb_build_object('channel_id', p_channel_id, 'conversation_id', p_conversation_id),
    null, null, pg_catalog.format('lead:%s:created', p_conversation_id));
  return 'created';
end
$function$;

create or replace function ops.crm_record_opt_out(
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
  perform pg_catalog.set_config('ops.crm_write', 'system', true);
  update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
  perform pg_catalog.set_config('ops.crm_write', '', true);
  perform pg_catalog.set_config('ops.consent_origin', '', true);
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref, task_id)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opted_out', v_ref, p_task_id);
  return case when v_was then 'already_recorded' else 'recorded' end;
end
$function$;

create or replace function ops.crm_lift_opt_out(
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
  v_flag    boolean;
  v_latest  public.lead_consent_changes;
  v_mine    ops.inbound_messages;
  v_reason  ops.inbound_messages;
begin
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return 'unresolved';
  end if;
  v_crm := ops.crm_contact_by_phone(p_tenant_id, p_sender);
  if v_crm ->> 'state' is distinct from 'found' then
    return 'unresolved';
  end if;
  v_ref := v_crm ->> 'crm_contact_ref';
  v_contact := substring(v_ref from '^crm:contact:([0-9]{1,19})$')::bigint;
  select lp.do_not_contact into v_flag from public.lead_profiles lp where lp.contact_id = v_contact for update;
  if v_flag is null then
    return 'unresolved';
  elsif not v_flag then
    return 'clear';
  end if;

  -- The contact's own opt-out, from an older message, and no newer one.
  select c.* into v_latest from public.lead_consent_changes c
   where c.contact_id = v_contact
   order by c.changed_at desc, c.id desc
   limit 1;
  select m.* into v_mine from ops.inbound_messages m where m.tenant_id = p_tenant_id and m.task_id = p_task_id;
  if v_latest.origin is distinct from 'system_opt_out' or v_mine.id is null then
    return 'kept';
  end if;
  select m.* into v_reason from ops.inbound_messages m
   where m.tenant_id = p_tenant_id and m.task_id = substr(v_latest.reason_ref, 6)::uuid;
  if v_reason.id is null
     or (v_reason.received_at, v_reason.created_at) >= (v_mine.received_at, v_mine.created_at)
     or exists (select 1
                  from ops.crm_opt_out_requests q
                  join ops.inbound_messages qm on qm.tenant_id = q.tenant_id and qm.task_id = q.task_id
                 where q.tenant_id = p_tenant_id and qm.contact_ref = p_sender
                   and (qm.received_at, qm.created_at) > (v_mine.received_at, v_mine.created_at)) then
    return 'kept';
  end if;

  perform pg_catalog.set_config('ops.consent_origin', format('system_lift:task:%s', p_task_id), true);
  perform pg_catalog.set_config('ops.crm_write', 'system', true);
  update public.lead_profiles set do_not_contact = false where contact_id = v_contact;
  perform pg_catalog.set_config('ops.crm_write', '', true);
  perform pg_catalog.set_config('ops.consent_origin', '', true);
  insert into ops.crm_contact_acts (tenant_id, company_id, conversation_id, channel_id, act, crm_contact_ref, task_id)
  values (p_tenant_id, p_company_id, p_conversation_id, p_channel_id, 'opt_out_lifted', v_ref, p_task_id);
  return 'lifted';
end
$function$;

-- ---------------------------------------------------------------------------
-- 4. A number's erasure deletes the CRM copy no one worked on. As
--    20261019130000, with the deletion.
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
  v_ref  text;
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
  -- ADR 0026 §C: the CRM copy follows the number. Every contact this
  -- conversation created or its admissions found is asked about, so a lead
  -- another conversation found too goes once both numbers are erased,
  -- whichever first; one the system did not create, or a person worked on,
  -- stays.
  for v_ref in
    select a.crm_contact_ref from ops.crm_contact_acts a
     where a.tenant_id = p_tenant_id and a.conversation_id = v_conv.id and a.act = 'created'
    union
    select m.crm_contact_ref from ops.inbound_messages m
     where m.tenant_id = p_tenant_id and m.conversation_id = v_conv.id and m.crm_contact_ref is not null
    order by 1
  loop
    perform ops.crm_delete_unedited_lead(p_tenant_id, v_conv.company_id, v_conv.id, v_conv.channel_id, v_ref);
  end loop;
  return 'erased';
end
$function$;

-- ---------------------------------------------------------------------------
-- 5. Access, and the end state.
-- ---------------------------------------------------------------------------

revoke all on function ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_role text;
begin
  -- The deletion adapter is an INVOKER no role reaches, PUBLIC included; only
  -- the erasure calls it, and the three adapters mark their own writes.
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)'::pg_catalog.regprocedure
                    and not p.prosecdef and p.proacl is not null)
     or exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
                 where p.oid = 'ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)'::pg_catalog.regprocedure
                   and a.grantee = 0)
     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                 where pg_catalog.has_function_privilege(
                         r.rolname, 'ops.crm_delete_unedited_lead(uuid, uuid, uuid, uuid, text)', 'EXECUTE')) then
    raise exception 'the CRM copy deletion adapter is reachable or not an INVOKER';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.erase_contact_identifier(uuid, uuid, text, text)'::pg_catalog.regprocedure),
                       'ops.crm_delete_unedited_lead') = 0
     or exists (select 1 from pg_catalog.pg_proc p
                 where p.oid in ('ops.crm_create_whatsapp_lead(uuid, uuid, uuid, uuid, text, text, timestamptz)'::pg_catalog.regprocedure,
                                 'ops.crm_record_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure,
                                 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure)
                   and pg_catalog.strpos(p.prosrc, '''ops.crm_write'', ''system''') = 0) then
    raise exception 'the erasure does not reach the CRM copy, or an adapter does not mark its own writes';
  end if;

  -- The edit marks: RLS on, no policy, nothing for any application role, the
  -- writer a DEFINER on the three tables, the table append-only.
  if not (select c.relrowsecurity from pg_catalog.pg_class c
           where c.oid = 'public.crm_contact_edits'::pg_catalog.regclass)
     or exists (select 1 from pg_catalog.pg_policy p
                 where p.polrelid = 'public.crm_contact_edits'::pg_catalog.regclass) then
    raise exception 'public.crm_contact_edits must have RLS on and no policy';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if pg_catalog.has_table_privilege(v_role, 'public.crm_contact_edits',
         'select, insert, update, delete, truncate, references, trigger')
       or pg_catalog.has_function_privilege(v_role, 'public.mark_crm_contact_edit()', 'execute')
       or pg_catalog.has_function_privilege(v_role, 'public.crm_contact_edits_append_only()', 'execute') then
      raise exception '% holds a privilege on the CRM edit marks', v_role;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
              where p.oid in ('public.mark_crm_contact_edit()'::pg_catalog.regprocedure,
                              'public.crm_contact_edits_append_only()'::pg_catalog.regprocedure)
                and a.grantee = 0)
     or not exists (select 1 from pg_catalog.pg_proc p
                     where p.oid = 'public.mark_crm_contact_edit()'::pg_catalog.regprocedure
                       and p.prosecdef and p.proconfig = array['search_path=""']) then
    raise exception 'the edit marker is not a pinned DEFINER, or PUBLIC executes an edit-mark function';
  end if;
  if (select count(*) from pg_catalog.pg_trigger t
       where not t.tgisinternal and t.tgenabled = 'O'
         and ((t.tgname = 'mark_crm_contact_edit_trigger'
               and t.tgfoid = 'public.mark_crm_contact_edit()'::pg_catalog.regprocedure
               and t.tgrelid in ('public.contacts'::pg_catalog.regclass, 'public.lead_profiles'::pg_catalog.regclass,
                                 'public.acquisition_attributions'::pg_catalog.regclass))
           or (t.tgrelid = 'public.crm_contact_edits'::pg_catalog.regclass
               and t.tgname in ('crm_contact_edits_append_only_trigger', 'crm_contact_edits_refuse_truncate_trigger')))) <> 5 then
    raise exception 'the edit marks'' triggers are missing or disabled';
  end if;
  if exists (select 1 from public.crm_contact_edits) then
    raise exception 'public.crm_contact_edits must start empty: no work is fabricated';
  end if;
end
$end_state$;
