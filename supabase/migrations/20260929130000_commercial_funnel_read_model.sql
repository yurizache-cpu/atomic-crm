-- Phase 3B.1: the commercial funnel read model, behind one provider seam.
--
-- AUTHORITY. The Atomic CRM's public.deals is the ONE commercial source of
-- truth. Company OS stores no opportunity, deal or stage of its own: this
-- migration only READS, and adds no browser act.
--
-- THE SEAM, the convention Phase 2B set with ops.crm_contact_by_phone:
--   ops.cos_commercial_funnel(tenant, as_of)   the provider-neutral entry, read
--       by the existing overview. Like every cos_, read_ and gate_ body, it
--       reads nothing in schema public (company_os_api.sql M2). The tenant is
--       the caller's membership, resolved by the gate, never a value the
--       browser supplies.
--   ops.crm_commercial_funnel(tenant, zone, as_of) and its helpers crm_*
--       the ONLY functions that know the Atomic CRM's tables: public.deals,
--       public.configuration, public.acquisition_attributions,
--       public.loss_reasons and public.deal_stage_transitions. It serves only
--       the tenant that owns the local CRM (ops.tenants.owns_local_crm, at
--       most one tenant); any other tenant reads not_configured and nothing of
--       the CRM. Replacing the CRM replaces these functions; the projection's
--       shape (contracts/company-os-api/funnel.ts) and the screen stay.
--
-- STAGES ARE DATA (ADR 0013). The ordered stage codes, their labels and the
-- converted stages come from the CRM's own stored configuration
-- (public.configuration: dealStages, dealPipelineStatuses), exactly as its
-- Settings save them. No stage code or label appears in this file. When that
-- configuration is absent or malformed, the answer is stages_not_configured,
-- never a guessed list.
--
-- FACTS, NOT INFERENCES.
--   * Open: not archived, not lost, not converted (no converted_at, and not
--     in a configured converted stage). Converted and lost are the CRM's own
--     dated facts, converted_at and lost_at. A deal carrying both is counted
--     as neither and reported as conflicting.
--   * Stage age uses stage_entered_at, the current stage only. Past stage
--     durations were never recorded.
--   * The next action is the deal's own next_action_at. The contact-level
--     lead_profiles.next_action_at is a different field and is not read.
--   * Movement comes only from public.deal_stage_transitions, which starts at
--     20260929120000. coverageStart is its first observation, and nothing
--     earlier is known.
--
-- MINIMISED. An opportunity is its CRM id ("Oportunidade #id"), stage code,
-- instants, next-action state, outcome, informed amount and origin. No title,
-- contact, contact id, email, phone, note, description, actor, UTM value,
-- campaign, keyword or click id. A deal's origin is the recorded acquisition
-- `source` of its ONE linked contact, shown as recorded and never mapped to an
-- invented category. Several contacts or differing sources read "multiple",
-- and none reads "unknown". A value shaped like an identifier (a long run of
-- digits, symbols, more than 40 characters) is withheld.
--
-- BOUNDED. At most 25 cards per stage, each stage with its exact total; 10
-- items per attention and outcome list; 15 recent movements; the top 8
-- origins. The windows are 30 days for new deals, outcomes and movements, and
-- 90 days for origins, as fixed hours so no session zone moves them. "Today"
-- is the tenant's scheduling zone, as on the Agenda, else UTC.

-- A configured CRM label or code: 1 to p_max characters, not blank, and no
-- control characters.
create function ops.crm_text_ok(p_text pg_catalog.text, p_max pg_catalog.int4) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select p_text is not null
     and pg_catalog.char_length(p_text) between 1 and p_max
     and pg_catalog.btrim(p_text) <> ''
     and p_text !~ '[[:cntrl:]]';
$$;

-- An amount the browser can hold exactly as a JSON number, else null.
create function ops.crm_safe_amount(p_amount pg_catalog.numeric) returns pg_catalog.numeric
language sql immutable security invoker set search_path = '' as $$
  select case when p_amount between -9007199254740991 and 9007199254740991 then p_amount end;
$$;

-- A deal's origin from its linked contacts: unknown, multiple, withheld or
-- the one recorded source.
create function ops.crm_deal_origin(p_contact_ids pg_catalog.int8[]) returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  with contacts as (
    select distinct c.id from pg_catalog.unnest(p_contact_ids) as c (id) where c.id is not null
  ), sources as (
    select distinct pg_catalog.btrim(pg_catalog.regexp_replace(a.source, '\s+', ' ', 'g')) as label
      from public.acquisition_attributions a
     where (select count(*) from contacts) = 1
       and a.contact_id = (select c.id from contacts c)
       and pg_catalog.btrim(coalesce(a.source, '')) <> ''
  )
  select case
    when (select count(*) from contacts) = 0 then '{"kind": "unknown"}'::pg_catalog.jsonb
    when (select count(*) from contacts) > 1 then '{"kind": "multiple"}'::pg_catalog.jsonb
    when (select count(*) from sources) = 0 then '{"kind": "unknown"}'::pg_catalog.jsonb
    when (select count(*) from sources) > 1 then '{"kind": "multiple"}'::pg_catalog.jsonb
    when (select s.label from sources s) ~ '^[[:alpha:][:digit:] ._&/+()-]{1,40}$'
     and (select s.label from sources s) !~ '([0-9][^0-9]*){5}'
      then pg_catalog.jsonb_build_object('kind', 'recorded', 'label', (select s.label from sources s))
    else '{"kind": "withheld"}'::pg_catalog.jsonb
  end;
$$;

-- One opportunity card: never a title, contact or free text.
create function ops.crm_deal_card(
  d public.deals, p_as_of pg_catalog.timestamptz, p_zone pg_catalog.text,
  p_tomorrow pg_catalog.timestamptz, p_codes pg_catalog.text[], p_converted pg_catalog.text[])
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'dealRef', d.id,
    'stage', case when d.pipeline_stage = any (p_codes) then d.pipeline_stage end,
    'stageEnteredAt', ops.cos_ts(d.stage_entered_at),
    'stageAgeDays', pg_catalog.int4larger(0,
        (p_as_of at time zone p_zone)::pg_catalog.date - (d.stage_entered_at at time zone p_zone)::pg_catalog.date),
    'nextActionAt', ops.cos_ts(d.next_action_at),
    'nextAction', case when d.next_action_at is null then 'none'
                       when d.next_action_at < p_as_of then 'overdue'
                       when d.next_action_at < p_tomorrow then 'today'
                       else 'future' end,
    'amount', ops.crm_safe_amount(d.amount),
    'origin', ops.crm_deal_origin(d.contact_ids),
    'outcome', case when d.converted_at is not null or d.pipeline_stage = any (p_converted)
                    then 'converted' else 'open' end);
$$;

create function ops.crm_commercial_funnel(
  p_tenant_id pg_catalog.uuid, p_zone pg_catalog.text, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  c_card_cap     constant pg_catalog.int4 := 25;
  c_list_cap     constant pg_catalog.int4 := 10;
  c_movement_cap constant pg_catalog.int4 := 15;
  c_origin_cap   constant pg_catalog.int4 := 8;
  c_max_stages   constant pg_catalog.int4 := 30;
  v_config       pg_catalog.jsonb;
  v_stages       pg_catalog.jsonb;
  v_converted_in pg_catalog.jsonb;
  v_codes        pg_catalog.text[];
  v_converted    pg_catalog.text[];
  v_today        pg_catalog.date := (p_as_of at time zone p_zone)::pg_catalog.date;
  v_tomorrow     pg_catalog.timestamptz := ((v_today + 1)::pg_catalog.timestamp) at time zone p_zone;
  v_window       pg_catalog.timestamptz := p_as_of - interval '720 hours';
  v_origin_from  pg_catalog.timestamptz := p_as_of - interval '2160 hours';
begin
  -- The local CRM belongs to at most one tenant (tenants_single_local_crm).
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    return '{"status": "not_configured"}'::pg_catalog.jsonb;
  end if;
  -- Nothing of the CRM is read before the tenant is known to own it.
  v_config := coalesce((select c.config from public.configuration c where c.id = 1), '{}'::pg_catalog.jsonb);
  v_stages := v_config -> 'dealStages';
  v_converted_in := v_config -> 'dealPipelineStatuses';
  if v_stages is null then
    return '{"status": "stages_not_configured", "reason": "missing"}'::pg_catalog.jsonb;
  end if;
  -- Each test only runs once the previous one holds: SQL does not promise the
  -- order of an OR, and jsonb_array_length refuses a non-array.
  if pg_catalog.jsonb_typeof(v_stages) <> 'array'
     or pg_catalog.jsonb_typeof(v_converted_in) is distinct from 'array' then
    return '{"status": "stages_not_configured", "reason": "invalid"}'::pg_catalog.jsonb;
  end if;
  if pg_catalog.jsonb_array_length(v_stages) not between 1 and c_max_stages
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_stages) e
                 where pg_catalog.jsonb_typeof(e) <> 'object') then
    return '{"status": "stages_not_configured", "reason": "invalid"}'::pg_catalog.jsonb;
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(v_stages) e
              where pg_catalog.jsonb_typeof(e -> 'value') is distinct from 'string'
                 or pg_catalog.jsonb_typeof(e -> 'label') is distinct from 'string'
                 or not ops.crm_text_ok(e ->> 'value', 64)
                 or not ops.crm_text_ok(e ->> 'label', 80))
     or (select count(distinct e ->> 'value') from pg_catalog.jsonb_array_elements(v_stages) e)
        <> pg_catalog.jsonb_array_length(v_stages)
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_converted_in) e
                 where pg_catalog.jsonb_typeof(e) <> 'string'
                    or not exists (select 1 from pg_catalog.jsonb_array_elements(v_stages) s
                                    where s ->> 'value' = e #>> '{}')) then
    return '{"status": "stages_not_configured", "reason": "invalid"}'::pg_catalog.jsonb;
  end if;

  select pg_catalog.array_agg(e.value ->> 'value' order by e.n) into v_codes
    from pg_catalog.jsonb_array_elements(v_stages) with ordinality as e (value, n);
  select coalesce(pg_catalog.array_agg(distinct e.value #>> '{}'), '{}') into v_converted
    from pg_catalog.jsonb_array_elements(v_converted_in) as e (value);

  return pg_catalog.jsonb_build_object(
    'status', 'available',
    'currency', case when v_config ->> 'currency' ~ '^[A-Z]{3}$' then v_config ->> 'currency' end,
    'perStageCap', c_card_cap,
    -- The configured stages, in their configured order, each with its exact
    -- total of current (not archived, not lost) deals and its first cards:
    -- open stages oldest first, converted stages most recent first.
    'stages', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'code', s.code, 'label', pg_catalog.btrim(s.label), 'position', s.n,
               'converted', s.code = any (v_converted),
               'total', (select count(*) from public.deals d
                          where d.pipeline_stage = s.code and d.archived_at is null and d.lost_at is null),
               'amountTotal', ops.crm_safe_amount(
                   (select sum(d.amount) from public.deals d
                     where d.pipeline_stage = s.code and d.archived_at is null and d.lost_at is null)),
               'amountCount', (select count(d.amount) from public.deals d
                                where d.pipeline_stage = s.code and d.archived_at is null and d.lost_at is null),
               'cards', coalesce((
                   select pg_catalog.jsonb_agg(x.card order by x.k, x.id)
                     from (select ops.crm_deal_card(d, p_as_of, p_zone, v_tomorrow, v_codes, v_converted) as card,
                                  case when s.code = any (v_converted)
                                       then -pg_catalog.date_part('epoch', coalesce(d.converted_at, d.stage_entered_at))
                                       else pg_catalog.date_part('epoch', d.stage_entered_at) end as k,
                                  d.id
                             from public.deals d
                            where d.pipeline_stage = s.code and d.archived_at is null and d.lost_at is null
                            order by 2, d.id
                            limit c_card_cap) x), '[]'::pg_catalog.jsonb))
             order by s.n)
        from (select e.value ->> 'value' as code, e.value ->> 'label' as label, e.n
                from pg_catalog.jsonb_array_elements(v_stages) with ordinality as e (value, n)) s),
    -- Current deals whose stage is not a configured one: counted and shown,
    -- never placed in a column.
    'unconfigured', pg_catalog.jsonb_build_object(
      'total', (select count(*) from public.deals d
                 where d.archived_at is null and d.lost_at is null and d.pipeline_stage <> all (v_codes)),
      'cards', coalesce((
          select pg_catalog.jsonb_agg(x.card order by x.k, x.id)
            from (select ops.crm_deal_card(d, p_as_of, p_zone, v_tomorrow, v_codes, v_converted) as card,
                         d.stage_entered_at as k, d.id
                    from public.deals d
                   where d.archived_at is null and d.lost_at is null and d.pipeline_stage <> all (v_codes)
                   order by d.stage_entered_at, d.id
                   limit c_card_cap) x), '[]'::pg_catalog.jsonb)),
    'summary', pg_catalog.jsonb_build_object(
      'active', (select count(*) from public.deals d
                  where d.archived_at is null and d.lost_at is null and d.converted_at is null
                    and d.pipeline_stage <> all (v_converted)),
      'overdue', (select count(*) from public.deals d
                   where d.archived_at is null and d.lost_at is null and d.converted_at is null
                     and d.pipeline_stage <> all (v_converted) and d.next_action_at < p_as_of),
      'dueToday', (select count(*) from public.deals d
                    where d.archived_at is null and d.lost_at is null and d.converted_at is null
                      and d.pipeline_stage <> all (v_converted)
                      and d.next_action_at >= p_as_of and d.next_action_at < v_tomorrow),
      'noNextAction', (select count(*) from public.deals d
                        where d.archived_at is null and d.lost_at is null and d.converted_at is null
                          and d.pipeline_stage <> all (v_converted) and d.next_action_at is null),
      -- Current deals in a converted stage with no converted_at: converted by
      -- the configuration, but with no date, so no period counts them.
      'convertedUndated', (select count(*) from public.deals d
                            where d.archived_at is null and d.lost_at is null and d.converted_at is null
                              and d.pipeline_stage = any (v_converted)),
      'windowDays', 30,
      'newDeals', (select count(*) from public.deals d
                    where d.created_at > v_window and d.created_at <= p_as_of),
      'converted', (select count(*) from public.deals d
                     where d.converted_at > v_window and d.converted_at <= p_as_of and d.lost_at is null),
      'lost', (select count(*) from public.deals d
                where d.lost_at > v_window and d.lost_at <= p_as_of and d.converted_at is null),
      'conflicting', (select count(*) from public.deals d
                       where d.converted_at is not null and d.lost_at is not null
                         and ((d.converted_at > v_window and d.converted_at <= p_as_of)
                           or (d.lost_at > v_window and d.lost_at <= p_as_of)))),
    'attention', pg_catalog.jsonb_build_object(
      'cap', c_list_cap,
      'overdue', pg_catalog.jsonb_build_object(
        'total', (select count(*) from public.deals d
                   where d.archived_at is null and d.lost_at is null and d.converted_at is null
                     and d.pipeline_stage <> all (v_converted) and d.next_action_at < p_as_of),
        'items', coalesce((
            select pg_catalog.jsonb_agg(x.card order by x.k, x.id)
              from (select ops.crm_deal_card(d, p_as_of, p_zone, v_tomorrow, v_codes, v_converted) as card,
                           d.next_action_at as k, d.id
                      from public.deals d
                     where d.archived_at is null and d.lost_at is null and d.converted_at is null
                       and d.pipeline_stage <> all (v_converted) and d.next_action_at < p_as_of
                     order by d.next_action_at, d.id
                     limit c_list_cap) x), '[]'::pg_catalog.jsonb)),
      'noNextAction', pg_catalog.jsonb_build_object(
        'total', (select count(*) from public.deals d
                   where d.archived_at is null and d.lost_at is null and d.converted_at is null
                     and d.pipeline_stage <> all (v_converted) and d.next_action_at is null),
        'items', coalesce((
            select pg_catalog.jsonb_agg(x.card order by x.k, x.id)
              from (select ops.crm_deal_card(d, p_as_of, p_zone, v_tomorrow, v_codes, v_converted) as card,
                           d.stage_entered_at as k, d.id
                      from public.deals d
                     where d.archived_at is null and d.lost_at is null and d.converted_at is null
                       and d.pipeline_stage <> all (v_converted) and d.next_action_at is null
                     order by d.stage_entered_at, d.id
                     limit c_list_cap) x), '[]'::pg_catalog.jsonb))),
    -- Observed movement only, from the ledger's first observation on.
    'movements', pg_catalog.jsonb_build_object(
      'coverageStart', ops.cos_ts((select min(t.changed_at) from public.deal_stage_transitions t)),
      'windowDays', 30,
      'totalInWindow', (select count(*) from public.deal_stage_transitions t
                         where t.changed_at > v_window and t.changed_at <= p_as_of),
      'items', coalesce((
          select pg_catalog.jsonb_agg(x.m order by x.changed_at desc, x.id desc)
            from (select pg_catalog.jsonb_build_object(
                           'dealRef', t.deal_id,
                           'entered', t.from_stage is null,
                           'fromStage', case when t.from_stage = any (v_codes) then t.from_stage end,
                           'toStage', case when t.to_stage = any (v_codes) then t.to_stage end,
                           'at', ops.cos_ts(t.changed_at)) as m,
                         t.changed_at, t.id
                    from public.deal_stage_transitions t
                   where t.changed_at > v_window and t.changed_at <= p_as_of
                   order by t.changed_at desc, t.id desc
                   limit c_movement_cap) x), '[]'::pg_catalog.jsonb)),
    -- Where the deals created in the last 90 days came from.
    'origins', (
      with o as (
        select ops.crm_deal_origin(d.contact_ids) as origin
          from public.deals d
         where d.created_at > v_origin_from and d.created_at <= p_as_of
      ), g as (
        select o.origin, count(*) as n from o group by o.origin
      ), recorded as (
        select g.origin ->> 'label' as label, g.n,
               pg_catalog.row_number() over (order by g.n desc, g.origin ->> 'label') as r
          from g where g.origin ->> 'kind' = 'recorded'
      )
      select pg_catalog.jsonb_build_object(
        'windowDays', 90,
        'total', (select count(*) from o),
        'items', coalesce((select pg_catalog.jsonb_agg(i.item order by i.k1, i.k2)
                             from (select pg_catalog.jsonb_build_object('kind', 'recorded', 'label', r.label, 'count', r.n) as item,
                                          0 as k1, r.r as k2
                                     from recorded r where r.r <= c_origin_cap
                                   union all
                                   select pg_catalog.jsonb_build_object('kind', 'other', 'label', null, 'count', sum(r.n)),
                                          1, 0
                                     from recorded r where r.r > c_origin_cap having count(*) > 0
                                   union all
                                   select pg_catalog.jsonb_build_object('kind', g.origin ->> 'kind', 'label', null, 'count', g.n),
                                          2, case g.origin ->> 'kind' when 'unknown' then 0 when 'multiple' then 1 else 2 end
                                     from g where g.origin ->> 'kind' <> 'recorded') i),
                          '[]'::pg_catalog.jsonb))),
    'outcomes', pg_catalog.jsonb_build_object(
      'windowDays', 30,
      'cap', c_list_cap,
      'converted', pg_catalog.jsonb_build_object(
        'items', coalesce((
            select pg_catalog.jsonb_agg(x.o order by x.at desc, x.id desc)
              from (select pg_catalog.jsonb_build_object(
                             'dealRef', d.id, 'at', ops.cos_ts(d.converted_at),
                             'amount', ops.crm_safe_amount(d.amount),
                             'origin', ops.crm_deal_origin(d.contact_ids)) as o,
                           d.converted_at as at, d.id
                      from public.deals d
                     where d.converted_at > v_window and d.converted_at <= p_as_of and d.lost_at is null
                     order by d.converted_at desc, d.id desc
                     limit c_list_cap) x), '[]'::pg_catalog.jsonb)),
      'lost', pg_catalog.jsonb_build_object(
        'items', coalesce((
            select pg_catalog.jsonb_agg(x.o order by x.at desc, x.id desc)
              from (select pg_catalog.jsonb_build_object(
                             'dealRef', d.id, 'at', ops.cos_ts(d.lost_at),
                             'stage', case when d.pipeline_stage = any (v_codes) then d.pipeline_stage end,
                             'reason', case when ops.crm_text_ok(lr.label, 80) then pg_catalog.btrim(lr.label) end,
                             'origin', ops.crm_deal_origin(d.contact_ids)) as o,
                           d.lost_at as at, d.id
                      from public.deals d
                      left join public.loss_reasons lr on lr.id = d.loss_reason_id
                     where d.lost_at > v_window and d.lost_at <= p_as_of and d.converted_at is null
                     order by d.lost_at desc, d.id desc
                     limit c_list_cap) x), '[]'::pg_catalog.jsonb))));
end
$$;

-- The provider-neutral entry, read by the overview: the one current provider
-- is the local Atomic CRM, which answers not_configured to any tenant that
-- does not own it.
create function ops.cos_commercial_funnel(p_tenant_id pg_catalog.uuid, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_zone   pg_catalog.text := coalesce((select s.timezone from ops.scheduling_settings s
                                         where s.tenant_id = p_tenant_id), 'UTC');
  v_result pg_catalog.jsonb;
begin
  v_result := ops.crm_commercial_funnel(p_tenant_id, v_zone, p_as_of);
  if v_result ->> 'status' = 'available' then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'timezone', v_zone,
      'timezoneConfigured', exists (select 1 from ops.scheduling_settings s where s.tenant_id = p_tenant_id),
      'today', pg_catalog.to_char((p_as_of at time zone v_zone)::pg_catalog.date, 'YYYY-MM-DD'));
  end if;
  return v_result;
end
$$;

create or replace function ops.read_overview(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_as_of  pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  v_today  pg_catalog.timestamptz := ops.cos_today_start(p_tenant_id);
  -- Every agent, not list_agents' first 500: the counts are exact.
  v_agents pg_catalog.jsonb := ops.agent_operational_state(p_tenant_id, null, true) -> 'items';
begin
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(v_as_of),
    'agents', pg_catalog.jsonb_build_object(
      'total', pg_catalog.jsonb_array_length(v_agents),
      'working', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'working'),
      'held', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'held'),
      'queued', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'queued'),
      'stale', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'activity' = 'stale'),
      'stopped', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'availability' = 'stopped'),
      'inactive', (select count(*) from pg_catalog.jsonb_array_elements(v_agents) x where x ->> 'availability' = 'inactive')),
    'runs', pg_catalog.jsonb_build_object(
      'todayByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                   from (select r.status, count(*) as n from ops.agent_runs r
                                          where r.tenant_id = p_tenant_id and r.created_at >= v_today group by r.status) s),
                                '{}'::pg_catalog.jsonb),
      'workingNow', (select count(*) from ops.agent_runs r join ops.jobs j on j.tenant_id = r.tenant_id and j.id = r.job_id
                      where r.tenant_id = p_tenant_id and r.status = 'running' and j.status = 'leased'
                        and j.lease_expires_at > v_as_of and j.attempts = r.job_attempt),
      'needingAttention', (select count(*) from ops.agent_runs r
                            where r.tenant_id = p_tenant_id
                              and ((r.status = 'indeterminate'
                                    and not exists (select 1 from ops.agent_runs x where x.tenant_id = p_tenant_id and x.retry_of_run_id = r.id))
                                   or (r.status = 'running'
                                       and not exists (select 1 from ops.jobs j where j.tenant_id = p_tenant_id and j.id = r.job_id
                                                          and j.status = 'leased' and j.lease_expires_at > v_as_of
                                                          and j.attempts = r.job_attempt))))),
    'reviews', pg_catalog.jsonb_build_object(
      'pending', (select count(*) from ops.review_items v where v.tenant_id = p_tenant_id and v.status = 'pending'),
      'oldestPendingAt', ops.cos_ts((select min(v.created_at) from ops.review_items v where v.tenant_id = p_tenant_id and v.status = 'pending'))),
    'stops', pg_catalog.jsonb_build_object(
      'tenantScopedActive', (select count(*) from ops.execution_stops s where s.tenant_id = p_tenant_id and s.cleared_at is null)),
    'admission', pg_catalog.jsonb_build_object(
      'tenantAdmission', coalesce((select x.new_run_admission from ops.spend_status() x
                                    where x.scope = 'tenant' and x.tenant_id = p_tenant_id limit 1), 'unconfigured')),
    'outbound', pg_catalog.jsonb_build_object(
      'todayByStatus', coalesce((select pg_catalog.jsonb_object_agg(s.status, s.n)
                                   from (select o.status, count(*) as n from ops.outbound_messages o
                                          where o.tenant_id = p_tenant_id and o.created_at >= v_today group by o.status) s),
                                '{}'::pg_catalog.jsonb),
      'indeterminateOpen', (select count(*) from ops.outbound_messages o where o.tenant_id = p_tenant_id and o.status = 'indeterminate'),
      'acceptedWithoutSend', (select count(*) from ops.review_items v
                               where v.tenant_id = p_tenant_id and v.status = 'accepted'
                                 and not exists (select 1 from ops.outbound_messages o
                                                  where o.tenant_id = p_tenant_id and o.review_item_id = v.id))),
    'platform', pg_catalog.jsonb_build_object('globalAdmissionBlocked', ops.cos_global_admission_blocked()),
    -- Phase 2D.3: shadow calibration, aggregate and advisory.
    'decisionIntelligence', ops.cos_decision_intelligence(p_tenant_id),
    -- Phase 2E.2: operational health, exact and tenant-scoped.
    'operationalHealth', ops.cos_operational_health(p_tenant_id, v_as_of, v_today),
    -- Phase 3A: the agenda, deterministic in its rows and this instant.
    'agenda', ops.cos_agenda(p_tenant_id, v_as_of),
    -- Phase 3B.1: the commercial funnel, read from the local CRM behind the
    -- provider seam, for the tenant that owns it only.
    'funnel', ops.cos_commercial_funnel(p_tenant_id, v_as_of));
end
$$;

revoke all on function
  ops.crm_text_ok(pg_catalog.text, pg_catalog.int4),
  ops.crm_safe_amount(pg_catalog.numeric),
  ops.crm_deal_origin(pg_catalog.int8[]),
  ops.crm_deal_card(public.deals, pg_catalog.timestamptz, pg_catalog.text, pg_catalog.timestamptz,
                               pg_catalog.text[], pg_catalog.text[]),
  ops.crm_commercial_funnel(pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz),
  ops.cos_commercial_funnel(pg_catalog.uuid, pg_catalog.timestamptz)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_bad    pg_catalog.text;
  v_funnel pg_catalog.jsonb;
  c_names  constant pg_catalog.text[] := array['crm_text_ok', 'crm_safe_amount', 'crm_deal_origin',
                                                'crm_deal_card', 'crm_commercial_funnel',
                                                'cos_commercial_funnel'];
begin
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_names)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute a commercial funnel projection: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = any (c_names)
                and (p.provolatile not in ('s', 'i') or p.prosecdef)) then
    raise exception 'a commercial funnel projection must be STABLE or IMMUTABLE and SECURITY INVOKER';
  end if;
  -- READ ONLY: no funnel projection writes, sends, calls or acts.
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'ops' and p.proname = any (c_names)
                and p.prosrc ~* '(insert\s|update\s|delete\s|truncate\s|merge\s|enqueue_job|record_event|trip_execution_stop|execute\s)') then
    raise exception 'a commercial funnel projection reaches beyond reading';
  end if;
  -- A tenant that does not own the local CRM reads nothing of it.
  v_funnel := ops.read_overview('00000000-0000-4000-8000-000000000000'::pg_catalog.uuid) -> 'funnel';
  if v_funnel is distinct from '{"status": "not_configured"}'::pg_catalog.jsonb then
    raise exception 'the overview''s funnel must be not_configured for a tenant without the local CRM: %', v_funnel;
  end if;
end
$end_state$;
