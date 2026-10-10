-- ADR 0026 §C, PR #36 review (Codex, P1): a person naming the opt-out flag
-- on again must not hide the contact's own opt-out from its lift.
--
-- When the CRM saves a profile whose do_not_contact is already true, the
-- consent ledger records a person's true-to-true entry. ops.crm_lift_opt_out
-- read the newest entry as it stood, so that entry made the contact's next
-- message keep the flag without recording the contact's lift, while
-- public.refuse_system_opt_out_clear, which skips such entries, still found the
-- contact's own opt-out underneath and refused a person's clear: the contact
-- stayed opted out for good. The lift now skips the same entries the guard
-- skips; a person who named the flag on again still keeps the flag on, as SI-84
-- states, and the lift is recorded, so the person may clear it.
--
-- One function replaced in place from its latest definition (20261019160000);
-- its grants are kept.

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
  v_off     public.lead_consent_changes;
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
    -- A merge or a person's deletion removed the contact after the CRM was
    -- read: try again, so the number resolves the contact it names now.
    if not exists (select 1 from public.contacts c where c.id = v_contact) then
      raise exception using errcode = '40001', message = 'ops.crm_lift_opt_out: the contact changed while it was read; try again';
    end if;
  end if;
  if v_flag is null then
    return 'unresolved';
  elsif not v_flag then
    return 'clear';
  end if;

  -- The contact's own opt-out, from an older message, and no newer one. A
  -- person naming the flag on again (the CRM saving a profile whose flag is
  -- already on) takes nothing over, as the CRM form's clear guard reads it.
  select c.* into v_latest from public.lead_consent_changes c
   where c.contact_id = v_contact
     and not (c.origin = 'person' and coalesce(c.from_value, false) and c.to_value)
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

  -- A flag a person set is never cleared by a message (owner decision 9).
  -- When a person's flag is part of this opt-out (a person turned the flag on,
  -- named it on again, or it was on before the ledger existed), the contact's
  -- own opt-out is recorded as lifted and the flag stays: the person may then
  -- clear it from the form.
  select c.* into v_off from public.lead_consent_changes c
   where c.contact_id = v_contact and not c.to_value
   order by c.changed_at desc, c.id desc
   limit 1;
  if not exists (select 1 from public.lead_consent_changes c
                  where c.contact_id = v_contact and c.to_value and not coalesce(c.from_value, false)
                    and (v_off.id is null or (c.changed_at, c.id) > (v_off.changed_at, v_off.id)))
     or exists (select 1 from public.lead_consent_changes c
                 where c.contact_id = v_contact and c.to_value and c.origin = 'person'
                   and (v_off.id is null or (c.changed_at, c.id) > (v_off.changed_at, v_off.id))) then
    perform pg_catalog.set_config('ops.consent_origin', format('system_lift:task:%s', p_task_id), true);
    perform pg_catalog.set_config('ops.crm_write', 'system', true);
    update public.lead_profiles set do_not_contact = true where contact_id = v_contact;
    perform pg_catalog.set_config('ops.crm_write', '', true);
    perform pg_catalog.set_config('ops.consent_origin', '', true);
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

do $end_state$
begin
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure),
                       'and not (c.origin = ''person'' and coalesce(c.from_value, false) and c.to_value)') = 0
     or pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                            where p.oid = 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure),
                          'v_off.id is null') = 0 then
    raise exception 'the lift does not skip a person naming the flag on again, or lost its earlier correction';
  end if;
  if exists (select 1 from pg_catalog.pg_proc p
              where p.oid = 'ops.crm_lift_opt_out(uuid, uuid, uuid, uuid, text, uuid)'::pg_catalog.regprocedure
                and (p.proacl is null
                     or exists (select 1 from pg_catalog.aclexplode(p.proacl) a where a.grantee = 0)
                     or exists (select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'),
                                                      ('ops_gateway'), ('ops_operator_api')) as r (rolname)
                                 where pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')))) then
    raise exception 'the lift became reachable';
  end if;
end
$end_state$;
