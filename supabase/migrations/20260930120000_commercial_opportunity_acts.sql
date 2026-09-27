-- Phase 3B.2: the operational commercial funnel, the commercial layer.
--
-- AUTHORITY, UNCHANGED. The Atomic CRM's public.deals is the ONE commercial
-- source of truth. This migration adds no opportunity, deal, stage or outcome
-- store of its own: the four commercial acts change public.deals itself, and
-- the stage-transition ledger (20260929120000) stays history only.
--
-- THE PATH OF AN ACT (owner decision R, 2026-09-26; the exposed functions and
-- their identity gates are 20260930130000_company_os_commercial_acts.sql):
--
--   company_os_api.<act>  ->  ops.gate_<act>  ->  ops.<act>_as_member
--       ->  ops.crm_<verb>_deal  ->  public.deals
--
--   ops.<act>_as_member     the narrow commercial act: provider-neutral, it
--       reads nothing in schema public. It calls its one CRM adapter write,
--       then, in the same transaction, the follow-up bridge and the act log.
--   ops.crm_<verb>_deal     the CRM adapter writes, with the Phase 3B.1 read
--       adapter the ONLY functions that know the Atomic CRM's tables. Each
--       serves only the tenant that owns the local CRM (decided before any CRM
--       row is read), locks the deal row, checks the caller's revision against
--       the locked row, validates against the CRM's STORED stage configuration
--       and changes exactly the columns its act owns.
--
-- THE FOUR ACTS, and nothing else: move to another configured, non-converted
-- stage; set or clear the deal's own next_action_at; convert into a configured
-- converted stage (converted_at from the database clock, next action cleared);
-- lose with an active configured loss reason (lost_at from the database clock,
-- next action cleared). No create, delete, reopen, amount, title, contact,
-- salesperson, company, category or closing-date edit exists, and no act takes
-- a table, a column, SQL text or a generic operation name.
--
-- CONCURRENCY. A revision is an opaque digest of the deal row's state
-- (ops.crm_deal_revision). Every act locks the row, recomputes the revision
-- and refuses a stale one with OS409, so of two acts made from the same
-- revision exactly one commits. A repeat of an act whose result already holds
-- (the same stage, the same next action, the same conversion, the same loss)
-- answers "unchanged" and changes nothing.
--
-- OUTCOMES. The CRM's own form lets a person set lost_at and converted_at
-- independently, and the Phase 3B.1 funnel counts a deal carrying both as
-- "conflicting". A table constraint would break that CRM write path, so none
-- is added (report §8). The acts themselves never create both: converting
-- refuses a lost deal and losing refuses a converted one, under the row lock.
--
-- THE FOLLOW-UP BRIDGE is configuration-bound. With no enabled configuration,
-- setting a next action schedules nothing. With one, it plans the Phase 3A
-- follow-up cadence the owner pinned, through ops.schedule_follow_up_plan, so
-- the plan's first occurrence is due exactly at the next action. Only plans
-- the bridge itself created (ops.commercial_follow_up_plans) are ever
-- superseded or cancelled by it; a plan anyone else created for the same
-- subject is never touched. Nothing here sends a message, writes an outbound
-- row or calls a model: a due follow-up is operator work.
--
-- AUDIT. The stage ledger records every stage change. ops.commercial_acts
-- records each act that changed something: which act, on which deal, by which
-- principal, when, and a minimised fact (a stage code, an instant, a loss
-- reason code, the follow-up outcome). ops.events is not used: every event
-- belongs to a Company OS company, and a CRM deal names none (report §9).

-- ---------------------------------------------------------------------------
-- 1. The CRM adapter's shared reads: the stored stage configuration, the
--    revision and each card's allowed acts.
-- ---------------------------------------------------------------------------

-- The CRM's STORED stage configuration, as its Settings save it: the ordered
-- stages with their labels, and the converted stages. Missing or malformed is
-- stated, never guessed (ADR 0013). Callers decide the tenant first.
create function ops.crm_stage_configuration() returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  c_max_stages   constant pg_catalog.int4 := 30;
  v_config       pg_catalog.jsonb;
  v_stages       pg_catalog.jsonb;
  v_converted_in pg_catalog.jsonb;
begin
  v_config := coalesce((select c.config from public.configuration c where c.id = 1), '{}'::pg_catalog.jsonb);
  v_stages := v_config -> 'dealStages';
  v_converted_in := v_config -> 'dealPipelineStatuses';
  if v_stages is null then
    return '{"ok": false, "reason": "missing"}'::pg_catalog.jsonb;
  end if;
  -- Each test only runs once the previous one holds: SQL does not promise the
  -- order of an OR, and jsonb_array_length refuses a non-array.
  if pg_catalog.jsonb_typeof(v_stages) <> 'array'
     or pg_catalog.jsonb_typeof(v_converted_in) is distinct from 'array' then
    return '{"ok": false, "reason": "invalid"}'::pg_catalog.jsonb;
  end if;
  if pg_catalog.jsonb_array_length(v_stages) not between 1 and c_max_stages
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_stages) e
                 where pg_catalog.jsonb_typeof(e) <> 'object') then
    return '{"ok": false, "reason": "invalid"}'::pg_catalog.jsonb;
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
    return '{"ok": false, "reason": "invalid"}'::pg_catalog.jsonb;
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'stages', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', e.value ->> 'value',
                                                                         'label', e.value ->> 'label') order by e.n)
                 from pg_catalog.jsonb_array_elements(v_stages) with ordinality as e (value, n)),
    'converted', (select coalesce(pg_catalog.jsonb_agg(distinct e.value #>> '{}'), '[]'::pg_catalog.jsonb)
                    from pg_catalog.jsonb_array_elements(v_converted_in) as e (value)));
end
$$;

-- The configured stage codes, in their configured order.
create function ops.crm_stage_codes(p_configuration pg_catalog.jsonb) returns pg_catalog.text[]
language sql immutable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(s.value ->> 'code' order by s.n), '{}'::pg_catalog.text[])
    from pg_catalog.jsonb_array_elements(coalesce(p_configuration -> 'stages', '[]'::pg_catalog.jsonb))
         with ordinality as s (value, n);
$$;

-- The configured converted stage codes.
create function ops.crm_converted_codes(p_configuration pg_catalog.jsonb) returns pg_catalog.text[]
language sql immutable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(c.value #>> '{}'), '{}'::pg_catalog.text[])
    from pg_catalog.jsonb_array_elements(coalesce(p_configuration -> 'converted', '[]'::pg_catalog.jsonb)) as c (value);
$$;

-- A deal's revision: an opaque digest of the row's state, never a timestamp
-- the browser could compare or forge. It changes with every write, because
-- the CRM's pipeline trigger stamps updated_at on each one. Instants enter as
-- epoch text, so no session time zone or float setting changes the digest.
create function ops.crm_deal_revision(d public.deals) returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select 'r1.' || pg_catalog.left(pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      'deal-revision', d.id, d.pipeline_stage,
      (extract(epoch from d.stage_entered_at))::pg_catalog.text,
      (extract(epoch from d.next_action_at))::pg_catalog.text,
      (extract(epoch from d.converted_at))::pg_catalog.text,
      (extract(epoch from d.lost_at))::pg_catalog.text,
      d.loss_reason_id,
      (extract(epoch from d.archived_at))::pg_catalog.text,
      (extract(epoch from d.updated_at))::pg_catalog.text)::pg_catalog.text, 'UTF8')), 'hex'), 32);
$$;

-- The shape of a revision a caller may send.
create function ops.crm_revision_ok(p_revision pg_catalog.text) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select coalesce(p_revision ~ '^r1\.[0-9a-f]{32}$', false);
$$;

-- An active configured loss reason a browser may choose: code and label only.
create function ops.crm_loss_reason_ok(r public.loss_reasons) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select r.active and ops.crm_text_ok(r.code, 64) and ops.crm_text_ok(r.label, 80);
$$;

-- Whether a deal is OPEN for the acts: not archived, not lost, not converted,
-- and not in a configured converted stage.
create function ops.crm_deal_is_open(d public.deals, p_converted pg_catalog.text[]) returns pg_catalog.bool
language sql immutable security invoker set search_path = '' as $$
  select d.archived_at is null and d.lost_at is null and d.converted_at is null
     and not (d.pipeline_stage = any (p_converted));
$$;

-- The acts the server would accept on a deal now, by the same rules the acts
-- apply. Hints for the screen; every refusal still comes from the act.
create function ops.crm_deal_actions(d public.deals, p_codes pg_catalog.text[], p_converted pg_catalog.text[])
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'move', ops.crm_deal_is_open(d, p_converted)
            and exists (select 1 from pg_catalog.unnest(p_codes) c (code)
                         where c.code <> all (p_converted) and c.code <> d.pipeline_stage),
    'setNextAction', ops.crm_deal_is_open(d, p_converted),
    'convert', d.archived_at is null and d.lost_at is null and d.converted_at is null
               and pg_catalog.cardinality(p_converted) > 0,
    'lose', ops.crm_deal_is_open(d, p_converted)
            and exists (select 1 from public.loss_reasons r where ops.crm_loss_reason_ok(r)));
$$;

-- One opportunity card (Phase 3B.1), now with the revision an act must name
-- and the acts the server would accept. Still never a title, contact or free
-- text.
create or replace function ops.crm_deal_card(
  d public.deals, p_as_of pg_catalog.timestamptz, p_zone pg_catalog.text,
  p_tomorrow pg_catalog.timestamptz, p_codes pg_catalog.text[], p_converted pg_catalog.text[])
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'dealRef', d.id,
    'stage', case when d.pipeline_stage = any (p_codes) then d.pipeline_stage end,
    'stageEnteredAt', ops.cos_ts(ops.crm_instant(d.stage_entered_at)),
    'stageAgeDays', pg_catalog.int4larger(0,
        (p_as_of at time zone p_zone)::pg_catalog.date
        - (ops.crm_instant(d.stage_entered_at) at time zone p_zone)::pg_catalog.date),
    'nextActionAt', ops.cos_ts(ops.crm_instant(d.next_action_at)),
    'nextAction', case when d.next_action_at is null then 'none'
                       when d.next_action_at < p_as_of then 'overdue'
                       when d.next_action_at < p_tomorrow then 'today'
                       else 'future' end,
    'amount', ops.crm_safe_amount(d.amount),
    'origin', ops.crm_deal_origin(d.contact_ids),
    'outcome', case when d.converted_at is not null or d.pipeline_stage = any (p_converted)
                    then 'converted' else 'open' end,
    'revision', ops.crm_deal_revision(d),
    'actions', ops.crm_deal_actions(d, p_codes, p_converted));
$$;

-- ---------------------------------------------------------------------------
-- 2. The read adapter, now reading its configuration through the shared
--    helper and listing the active loss reasons an act may name.
-- ---------------------------------------------------------------------------

create or replace function ops.crm_commercial_funnel(
  p_tenant_id pg_catalog.uuid, p_zone pg_catalog.text, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  c_card_cap     constant pg_catalog.int4 := 25;
  c_list_cap     constant pg_catalog.int4 := 10;
  c_movement_cap constant pg_catalog.int4 := 15;
  c_origin_cap   constant pg_catalog.int4 := 8;
  c_reason_cap   constant pg_catalog.int4 := 50;
  v_config       pg_catalog.jsonb;
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
  v_config := ops.crm_stage_configuration();
  if not (v_config ->> 'ok')::pg_catalog.bool then
    return pg_catalog.jsonb_build_object('status', 'stages_not_configured', 'reason', v_config ->> 'reason');
  end if;
  v_codes := ops.crm_stage_codes(v_config);
  v_converted := ops.crm_converted_codes(v_config);

  return pg_catalog.jsonb_build_object(
    'status', 'available',
    'currency', (select case when c.config ->> 'currency' ~ '^[A-Z]{3}$' then c.config ->> 'currency' end
                   from public.configuration c where c.id = 1),
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
                              and d.id between 1 and 9007199254740991
                            order by 2, d.id
                            limit c_card_cap) x), '[]'::pg_catalog.jsonb))
             order by s.n)
        from (select e.value ->> 'code' as code, e.value ->> 'label' as label, e.n
                from pg_catalog.jsonb_array_elements(v_config -> 'stages') with ordinality as e (value, n)) s),
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
                     and d.id between 1 and 9007199254740991
                   order by d.stage_entered_at, d.id
                   limit c_card_cap) x), '[]'::pg_catalog.jsonb)),
    -- The active loss reasons an act may name: code and label only.
    'lossReasons', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('code', r.code, 'label', pg_catalog.btrim(r.label))
                                    order by r.sort_order, r.id)
          from (select r.code, r.label, r.sort_order, r.id
                  from public.loss_reasons r
                 where ops.crm_loss_reason_ok(r)
                 order by r.sort_order, r.id
                 limit c_reason_cap) r), '[]'::pg_catalog.jsonb),
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
                       and d.id between 1 and 9007199254740991
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
                       and d.id between 1 and 9007199254740991
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
                     and t.deal_id between 1 and 9007199254740991
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
                       and d.id between 1 and 9007199254740991
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
                       and d.id between 1 and 9007199254740991
                     order by d.lost_at desc, d.id desc
                     limit c_list_cap) x), '[]'::pg_catalog.jsonb))));
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Company OS tables: the bridge configuration, the bridge's provenance and
--    the act log. Backend only: RLS forced, no policy, no grant.
-- ---------------------------------------------------------------------------

-- The owner's commercial follow-up bridge configuration, one immutable
-- version per change; the tenant's current configuration is its latest
-- version. Enabled names exactly where the plans live (a company, a
-- department, optionally an agent) and which cadence they follow (one pinned
-- follow-up policy version). Nothing is inferred: disabled names nothing.
create table ops.commercial_follow_up_bridges (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references ops.tenants (id) on delete restrict,
  version           integer not null,
  enabled           boolean not null,
  company_id        uuid,
  department_id     uuid,
  agent_id          uuid,
  policy_version_id uuid,
  created_by        text not null,
  created_at        timestamptz not null default now(),
  constraint commercial_follow_up_bridges_version_positive check (version >= 1),
  constraint commercial_follow_up_bridges_enabled_complete
    check (not enabled or (company_id is not null and department_id is not null and policy_version_id is not null)),
  constraint commercial_follow_up_bridges_disabled_empty
    check (enabled or num_nonnulls(company_id, department_id, agent_id, policy_version_id) = 0),
  constraint commercial_follow_up_bridges_actor_length check (char_length(btrim(created_by)) between 1 and 200),
  constraint commercial_follow_up_bridges_company_fkey
    foreign key (tenant_id, company_id) references ops.companies (tenant_id, id) on delete restrict,
  constraint commercial_follow_up_bridges_department_fkey
    foreign key (tenant_id, company_id, department_id)
    references ops.departments (tenant_id, company_id, id) on delete restrict,
  constraint commercial_follow_up_bridges_agent_fkey
    foreign key (tenant_id, company_id, department_id, agent_id)
    references ops.agents (tenant_id, company_id, department_id, id) on delete restrict,
  constraint commercial_follow_up_bridges_policy_version_fkey
    foreign key (tenant_id, policy_version_id) references ops.follow_up_policy_versions (tenant_id, id) on delete restrict,
  constraint commercial_follow_up_bridges_tenant_version_key unique (tenant_id, version),
  constraint commercial_follow_up_bridges_scope_id_key       unique (tenant_id, id)
);

comment on table ops.commercial_follow_up_bridges is
  'The owner''s commercial follow-up bridge, one immutable version per change; the latest version is current. Enabled names the company, department, optional agent and pinned follow-up policy version its plans use. Never browser-editable.';

-- Which follow-up plans the commercial bridge created, and for which deal.
-- The bridge supersedes or cancels only these; a plan anyone else created,
-- for the same opaque subject or not, is never touched by it.
create table ops.commercial_follow_up_plans (
  plan_id    uuid primary key,
  tenant_id  uuid not null references ops.tenants (id) on delete restrict,
  company_id uuid not null,
  deal_ref   bigint not null,
  bridge_id  uuid not null,
  created_at timestamptz not null default now(),
  constraint commercial_follow_up_plans_deal_ref_range check (deal_ref between 1 and 9007199254740991),
  constraint commercial_follow_up_plans_plan_fkey
    foreign key (tenant_id, company_id, plan_id) references ops.follow_up_plans (tenant_id, company_id, id) on delete cascade,
  constraint commercial_follow_up_plans_bridge_fkey
    foreign key (tenant_id, bridge_id) references ops.commercial_follow_up_bridges (tenant_id, id) on delete restrict
);

comment on table ops.commercial_follow_up_plans is
  'Provenance: each follow-up plan the commercial bridge created, with the CRM deal reference it follows up. Only these plans are ever superseded or cancelled by the bridge.';

create index commercial_follow_up_plans_deal_idx on ops.commercial_follow_up_plans (tenant_id, deal_ref);

-- Each commercial act that changed something, by a Company OS principal.
create table ops.commercial_acts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references ops.tenants (id) on delete restrict,
  deal_ref    bigint not null,
  act         text not null,
  actor       text not null,
  facts       jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  constraint commercial_acts_deal_ref_range check (deal_ref between 1 and 9007199254740991),
  constraint commercial_acts_act_check      check (act in ('moved', 'next_action_set', 'next_action_cleared', 'converted', 'lost')),
  constraint commercial_acts_actor_format   check (actor ~ '^principal:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint commercial_acts_facts_object   check (jsonb_typeof(facts) = 'object' and pg_column_size(facts) <= 2048)
);

comment on table ops.commercial_acts is
  'One row per commercial act that changed a CRM deal through Company OS: the act, the deal reference, the principal, the database time and a minimised fact (a stage code, an instant, a loss reason code, the follow-up outcome). Never a title, contact, label or free text.';

create index commercial_acts_deal_idx on ops.commercial_acts (tenant_id, deal_ref, recorded_at);

alter table ops.commercial_follow_up_bridges enable row level security;
alter table ops.commercial_follow_up_bridges force  row level security;
alter table ops.commercial_follow_up_plans   enable row level security;
alter table ops.commercial_follow_up_plans   force  row level security;
alter table ops.commercial_acts              enable row level security;
alter table ops.commercial_acts              force  row level security;

revoke all on table ops.commercial_follow_up_bridges, ops.commercial_follow_up_plans, ops.commercial_acts
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- History is never rewritten: none of the three tables is updated or
-- truncated. Deleting stays an owner retention act (a bridge version a plan
-- still names cannot be deleted, by its foreign key).
create function ops.refuse_commercial_history_change()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  raise exception using
    errcode = 'OS409',
    message = format('ops.%s: commercial history is never %s', tg_table_name,
                     case tg_op when 'UPDATE' then 'rewritten' else 'truncated' end);
end
$$;

-- A bridge version's number is the tenant's next one, under a per-tenant lock;
-- its time is the database's.
create function ops.guard_commercial_follow_up_bridge_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('ops.commercial_follow_up_bridges:' || new.tenant_id::text, 0));
  new.version := coalesce((select max(b.version) from ops.commercial_follow_up_bridges b
                            where b.tenant_id = new.tenant_id), 0) + 1;
  new.created_at := now();
  return new;
end
$$;

-- An act is stamped with the database's time, never the caller's.
create function ops.guard_commercial_act_insert()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.recorded_at := now();
  return new;
end
$$;

create trigger commercial_follow_up_bridges_guard_insert
  before insert on ops.commercial_follow_up_bridges
  for each row execute function ops.guard_commercial_follow_up_bridge_insert();
alter table ops.commercial_follow_up_bridges enable always trigger commercial_follow_up_bridges_guard_insert;

create trigger commercial_follow_up_bridges_refuse_update
  before update on ops.commercial_follow_up_bridges
  for each row execute function ops.refuse_commercial_history_change();
alter table ops.commercial_follow_up_bridges enable always trigger commercial_follow_up_bridges_refuse_update;

create trigger commercial_follow_up_bridges_refuse_truncate
  before truncate on ops.commercial_follow_up_bridges
  for each statement execute function ops.refuse_commercial_history_change();
alter table ops.commercial_follow_up_bridges enable always trigger commercial_follow_up_bridges_refuse_truncate;

create trigger commercial_follow_up_plans_refuse_update
  before update on ops.commercial_follow_up_plans
  for each row execute function ops.refuse_commercial_history_change();
alter table ops.commercial_follow_up_plans enable always trigger commercial_follow_up_plans_refuse_update;

create trigger commercial_follow_up_plans_refuse_truncate
  before truncate on ops.commercial_follow_up_plans
  for each statement execute function ops.refuse_commercial_history_change();
alter table ops.commercial_follow_up_plans enable always trigger commercial_follow_up_plans_refuse_truncate;

create trigger commercial_acts_guard_insert
  before insert on ops.commercial_acts
  for each row execute function ops.guard_commercial_act_insert();
alter table ops.commercial_acts enable always trigger commercial_acts_guard_insert;

create trigger commercial_acts_refuse_update
  before update on ops.commercial_acts
  for each row execute function ops.refuse_commercial_history_change();
alter table ops.commercial_acts enable always trigger commercial_acts_refuse_update;

create trigger commercial_acts_refuse_truncate
  before truncate on ops.commercial_acts
  for each statement execute function ops.refuse_commercial_history_change();
alter table ops.commercial_acts enable always trigger commercial_acts_refuse_truncate;

-- ---------------------------------------------------------------------------
-- 4. The CRM adapter writes. Each: the tenant first, then the deal locked,
--    then the stored configuration, then its own rules, then the revision.
-- ---------------------------------------------------------------------------

-- The deal an act changes, locked. A tenant that does not own the local CRM
-- is refused before anything of the CRM is read (OS403, whatever the id); an
-- id the browser could never have been shown and a missing one are the same
-- OS404; an archived deal is closed to every act (OS409).
create function ops.crm_lock_deal(p_tenant_id pg_catalog.uuid, p_deal_ref pg_catalog.int8) returns public.deals
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_deal public.deals;
begin
  if p_tenant_id is null
     or not exists (select 1 from ops.tenants t where t.id = p_tenant_id and t.owns_local_crm) then
    raise exception using errcode = 'OS403', message = 'no access';
  end if;
  if p_deal_ref is null or p_deal_ref not between 1 and 9007199254740991 then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  select d.* into v_deal from public.deals d where d.id = p_deal_ref for update;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  if v_deal.archived_at is not null then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  return v_deal;
end
$$;

-- The stored configuration an act validates against; mutations are closed
-- while it is missing or malformed (OS409), never read from a default.
create function ops.crm_act_configuration() returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_config pg_catalog.jsonb := ops.crm_stage_configuration();
begin
  if not (v_config ->> 'ok')::pg_catalog.bool then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  return v_config;
end
$$;

-- Moves an open deal to another configured stage that is not a converted one
-- (converting is its own act, so converted_at is never forgotten). The CRM's
-- pipeline trigger keeps stage, stage_entered_at and updated_at, and the
-- ledger trigger observes the change, in this transaction.
create function ops.crm_move_deal(p_tenant_id pg_catalog.uuid, p_deal_ref pg_catalog.int8,
                                  p_target_stage pg_catalog.text, p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_deal      public.deals;
  v_config    pg_catalog.jsonb;
  v_converted pg_catalog.text[];
  v_from      pg_catalog.text;
begin
  if not ops.crm_text_ok(p_target_stage, 64) or not ops.crm_revision_ok(p_expected_revision) then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  v_deal := ops.crm_lock_deal(p_tenant_id, p_deal_ref);
  v_config := ops.crm_act_configuration();
  v_converted := ops.crm_converted_codes(v_config);
  if not ops.crm_deal_is_open(v_deal, v_converted)
     or p_target_stage <> all (ops.crm_stage_codes(v_config))
     or p_target_stage = any (v_converted) then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  if v_deal.pipeline_stage = p_target_stage then
    return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', ops.crm_deal_revision(v_deal),
                                         'stage', v_deal.pipeline_stage);
  end if;
  if ops.crm_deal_revision(v_deal) <> p_expected_revision then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  v_from := v_deal.pipeline_stage;
  update public.deals set pipeline_stage = p_target_stage where id = v_deal.id returning * into v_deal;
  return pg_catalog.jsonb_build_object('outcome', 'moved', 'revision', ops.crm_deal_revision(v_deal),
                                       'stage', v_deal.pipeline_stage, 'fromStage', v_from);
end
$$;

-- Sets or clears an open deal's own next_action_at, and nothing else: never
-- the contact-level lead_profiles.next_action_at. An instant is absolute and
-- finite, at most 30 days before and 366 days after now.
create function ops.crm_set_deal_next_action(p_tenant_id pg_catalog.uuid, p_deal_ref pg_catalog.int8,
                                             p_next_action_at pg_catalog.timestamptz,
                                             p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_deal public.deals;
begin
  if not ops.crm_revision_ok(p_expected_revision)
     or (p_next_action_at is not null
         and (not pg_catalog.isfinite(p_next_action_at)
              or p_next_action_at < now() - interval '30 days'
              or p_next_action_at > now() + interval '366 days')) then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  v_deal := ops.crm_lock_deal(p_tenant_id, p_deal_ref);
  if not ops.crm_deal_is_open(v_deal, ops.crm_converted_codes(ops.crm_act_configuration())) then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  if v_deal.next_action_at is not distinct from p_next_action_at then
    return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', ops.crm_deal_revision(v_deal),
                                         'nextActionAt', ops.cos_ts(v_deal.next_action_at));
  end if;
  if ops.crm_deal_revision(v_deal) <> p_expected_revision then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  update public.deals set next_action_at = p_next_action_at where id = v_deal.id returning * into v_deal;
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_next_action_at is null then 'cleared' else 'set' end,
    'revision', ops.crm_deal_revision(v_deal),
    'nextActionAt', ops.cos_ts(v_deal.next_action_at));
end
$$;

-- Converts a deal into a configured converted stage: the stage, converted_at
-- from the database clock and a cleared next action, in one statement. A lost
-- deal is never converted; a converted one is answered as unchanged when the
-- stage is the same, and refused otherwise. Nothing about payment is written.
create function ops.crm_convert_deal(p_tenant_id pg_catalog.uuid, p_deal_ref pg_catalog.int8,
                                     p_target_stage pg_catalog.text, p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_deal public.deals;
begin
  if not ops.crm_text_ok(p_target_stage, 64) or not ops.crm_revision_ok(p_expected_revision) then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  v_deal := ops.crm_lock_deal(p_tenant_id, p_deal_ref);
  if v_deal.lost_at is not null
     or p_target_stage <> all (ops.crm_converted_codes(ops.crm_act_configuration())) then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  if v_deal.converted_at is not null then
    if v_deal.pipeline_stage = p_target_stage then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', ops.crm_deal_revision(v_deal),
                                           'stage', v_deal.pipeline_stage);
    end if;
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  if ops.crm_deal_revision(v_deal) <> p_expected_revision then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  update public.deals
     set pipeline_stage = p_target_stage, converted_at = now(), next_action_at = null
   where id = v_deal.id
  returning * into v_deal;
  return pg_catalog.jsonb_build_object('outcome', 'converted', 'revision', ops.crm_deal_revision(v_deal),
                                       'stage', v_deal.pipeline_stage);
end
$$;

-- Loses a deal with an active configured loss reason, named by its stable
-- code: lost_at from the database clock, the reason and a cleared next action,
-- in one statement. The stage is kept. A converted deal is never lost; a lost
-- one is answered as unchanged with the same reason, and refused otherwise.
create function ops.crm_lose_deal(p_tenant_id pg_catalog.uuid, p_deal_ref pg_catalog.int8,
                                  p_loss_reason pg_catalog.text, p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_deal   public.deals;
  v_reason public.loss_reasons;
begin
  if not ops.crm_text_ok(p_loss_reason, 64) or not ops.crm_revision_ok(p_expected_revision) then
    raise exception using errcode = 'OS400', message = 'bad request';
  end if;
  v_deal := ops.crm_lock_deal(p_tenant_id, p_deal_ref);
  if v_deal.converted_at is not null
     or v_deal.pipeline_stage = any (ops.crm_converted_codes(ops.crm_act_configuration())) then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  select r.* into v_reason from public.loss_reasons r where r.code = p_loss_reason;
  if v_deal.lost_at is not null then
    if v_reason.id is not null and v_deal.loss_reason_id = v_reason.id then
      return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'revision', ops.crm_deal_revision(v_deal));
    end if;
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  if v_reason.id is null or not ops.crm_loss_reason_ok(v_reason) then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  if ops.crm_deal_revision(v_deal) <> p_expected_revision then
    raise exception using errcode = 'OS409', message = 'conflict';
  end if;
  update public.deals
     set lost_at = now(), loss_reason_id = v_reason.id, next_action_at = null
   where id = v_deal.id
  returning * into v_deal;
  return pg_catalog.jsonb_build_object('outcome', 'lost', 'revision', ops.crm_deal_revision(v_deal));
end
$$;

-- ---------------------------------------------------------------------------
-- 5. The follow-up bridge.
-- ---------------------------------------------------------------------------

-- The tenant's current bridge and whether it can plan now: not_configured (no
-- version, or the latest disables it); invalid (a unit it names is inactive,
-- or its pinned policy version is no longer that policy's latest, so the
-- Phase 3A service would plan a different cadence); configured, with what a
-- plan needs. STABLE and ops-only, read by the funnel projection (the status
-- alone) and by the bridge itself.
create function ops.cos_commercial_follow_up_bridge(p_tenant_id pg_catalog.uuid) returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_bridge  ops.commercial_follow_up_bridges;
  v_version ops.follow_up_policy_versions;
  v_key     pg_catalog.text;
begin
  select b.* into v_bridge from ops.commercial_follow_up_bridges b
   where b.tenant_id = p_tenant_id order by b.version desc limit 1;
  if not found or not v_bridge.enabled then
    return '{"status": "not_configured"}'::pg_catalog.jsonb;
  end if;
  select v.* into v_version from ops.follow_up_policy_versions v
   where v.tenant_id = p_tenant_id and v.id = v_bridge.policy_version_id;
  select p.key into v_key from ops.follow_up_policies p
   where p.tenant_id = p_tenant_id and p.id = v_version.policy_id;
  if not exists (select 1 from ops.companies c
                  where c.tenant_id = p_tenant_id and c.id = v_bridge.company_id and c.status = 'active')
     or not exists (select 1 from ops.departments d
                     where d.tenant_id = p_tenant_id and d.company_id = v_bridge.company_id
                       and d.id = v_bridge.department_id and d.status = 'active')
     or (v_bridge.agent_id is not null
         and not exists (select 1 from ops.agents a
                          where a.tenant_id = p_tenant_id and a.id = v_bridge.agent_id and a.status = 'active'))
     or v_key is null
     or exists (select 1 from ops.follow_up_policy_versions n
                 where n.tenant_id = p_tenant_id and n.policy_id = v_version.policy_id
                   and n.version > v_version.version) then
    return pg_catalog.jsonb_build_object('status', 'invalid', 'bridgeId', v_bridge.id);
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'configured',
    'bridgeId', v_bridge.id,
    'companyId', v_bridge.company_id,
    'departmentId', v_bridge.department_id,
    'agentId', v_bridge.agent_id,
    'policyId', v_version.policy_id,
    'policyKey', v_key,
    'policyVersionId', v_version.id,
    'firstOffsetMinutes', v_version.step_offsets_minutes[1],
    'stepCount', pg_catalog.cardinality(v_version.step_offsets_minutes));
end
$$;

-- Cancels every ACTIVE plan the bridge created for one deal (optionally but
-- one company's), with a reason code, through the Phase 3A service. Plans the
-- bridge did not create are never read here. Answers how many it cancelled.
create function ops.commercial_follow_up_cancel(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                p_deal_ref pg_catalog.int8, p_reason pg_catalog.text,
                                                p_keep_company pg_catalog.uuid)
returns pg_catalog.int4
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_plan  pg_catalog.uuid;
  v_count pg_catalog.int4 := 0;
begin
  for v_plan in
    select p.id
      from ops.commercial_follow_up_plans c
      join ops.follow_up_plans p on p.tenant_id = c.tenant_id and p.company_id = c.company_id and p.id = c.plan_id
     where c.tenant_id = p_tenant_id and c.deal_ref = p_deal_ref and p.status = 'active'
       and (p_keep_company is null or p.company_id <> p_keep_company)
     order by p.id
  loop
    perform ops.cancel_follow_up_plan(p_tenant_id, v_plan, p_reason, p_actor, 'company-os-ui');
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- After a deal's next action was SET to a new instant: plans the configured
-- cadence so its first occurrence is due exactly at that instant (the anchor
-- is the instant minus the pinned version's first offset; the other steps
-- keep their relative cadence), superseding the previous plan the bridge
-- created for the deal. When the bridge cannot plan, the previous bridge plan
-- no longer describes the deal and is cancelled, and nothing new is planned:
--   not_configured  no enabled configuration;
--   not_scheduled   configuration_invalid, outside_window (the anchor falls
--                   outside the service's 30 days before to 366 days after
--                   now) or existing_plan (an active plan someone else
--                   created for this subject, which is never superseded).
-- The service's own lock order is taken first (the key, then the subject), so
-- no concurrent scheduler can create or supersede a plan for the subject
-- between the check and the plan. The plan's key names the act that asked
-- for it: one act, one plan.
create function ops.commercial_follow_up_plan_next_action(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                          p_deal_ref pg_catalog.int8,
                                                          p_next_action_at pg_catalog.timestamptz,
                                                          p_act_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_bridge   pg_catalog.jsonb := ops.cos_commercial_follow_up_bridge(p_tenant_id);
  v_subject  pg_catalog.text := 'deal:' || p_deal_ref::pg_catalog.text;
  v_key      pg_catalog.text := 'commercial:act:' || p_act_id::pg_catalog.text;
  v_company  pg_catalog.uuid;
  v_anchor   pg_catalog.timestamptz;
  v_active   ops.follow_up_plans;
  v_result   pg_catalog.jsonb;
  v_plan     pg_catalog.uuid;
begin
  if v_bridge ->> 'status' = 'configured' then
    -- No new version of the pinned policy while this transaction plans with
    -- it: the version insert locks the policy row FOR UPDATE.
    perform 1 from ops.follow_up_policies p
     where p.tenant_id = p_tenant_id and p.id = (v_bridge ->> 'policyId')::pg_catalog.uuid
       for share;
    v_bridge := ops.cos_commercial_follow_up_bridge(p_tenant_id);
  end if;
  if v_bridge ->> 'status' = 'not_configured' then
    perform ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'commercial_next_action_changed', null);
    return '{"status": "not_configured", "reason": null}'::pg_catalog.jsonb;
  end if;
  if v_bridge ->> 'status' <> 'configured' then
    perform ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'commercial_next_action_changed', null);
    return '{"status": "not_scheduled", "reason": "configuration_invalid"}'::pg_catalog.jsonb;
  end if;

  v_company := (v_bridge ->> 'companyId')::pg_catalog.uuid;
  v_anchor := p_next_action_at - pg_catalog.make_interval(mins => (v_bridge ->> 'firstOffsetMinutes')::pg_catalog.int4);
  if v_anchor < now() - interval '30 days' or v_anchor > now() + interval '366 days' then
    perform ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'commercial_next_action_changed', null);
    return '{"status": "not_scheduled", "reason": "outside_window"}'::pg_catalog.jsonb;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ops.follow_up_plans:key:' || p_tenant_id::pg_catalog.text || ':' || v_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'ops.follow_up_plans:subject:' || p_tenant_id::pg_catalog.text || ':' || v_company::pg_catalog.text || ':ref:' || v_subject, 0));
  select p.* into v_active from ops.follow_up_plans p
   where p.tenant_id = p_tenant_id and p.company_id = v_company and p.subject_key = 'ref:' || v_subject
     and p.status = 'active'
     for update;
  if found and not exists (select 1 from ops.commercial_follow_up_plans c
                            where c.tenant_id = p_tenant_id and c.plan_id = v_active.id) then
    perform ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'commercial_next_action_changed', null);
    return '{"status": "not_scheduled", "reason": "existing_plan"}'::pg_catalog.jsonb;
  end if;
  -- A bridge plan left in a company the bridge no longer names is cancelled;
  -- the one in the configured company is superseded by the new plan.
  perform ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'commercial_bridge_reassigned', v_company);

  v_result := ops.schedule_follow_up_plan(
    p_tenant_id, v_company, (v_bridge ->> 'departmentId')::pg_catalog.uuid, (v_bridge ->> 'agentId')::pg_catalog.uuid,
    v_bridge ->> 'policyKey', v_anchor, null, null, v_subject, v_key, p_actor, 'company-os-ui');
  v_plan := (v_result ->> 'plan_id')::pg_catalog.uuid;
  if not exists (select 1 from ops.follow_up_plans p
                  where p.tenant_id = p_tenant_id and p.id = v_plan
                    and p.policy_version_id = (v_bridge ->> 'policyVersionId')::pg_catalog.uuid) then
    raise exception using errcode = 'OS500', message = 'the planned cadence is not the pinned policy version';
  end if;
  insert into ops.commercial_follow_up_plans (plan_id, tenant_id, company_id, deal_ref, bridge_id)
  values (v_plan, p_tenant_id, v_company, p_deal_ref, (v_bridge ->> 'bridgeId')::pg_catalog.uuid)
  on conflict (plan_id) do nothing;
  return pg_catalog.jsonb_build_object('status', 'scheduled', 'reason', null);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. The narrow commercial acts: provider-neutral, ops-only, one CRM adapter
--    write each, then the bridge and the act log, in the caller's
--    transaction. The one deferred constraint a bridge plan can leave
--    pending (a superseded plan's successor) is checked before the answer
--    leaves, inside the gate, so a commit can never fail after it.
-- ---------------------------------------------------------------------------

-- Whether the tenant may act on the local CRM at all: it owns it. The
-- operator context reports it; each act decides again for itself.
create function ops.cos_commercial_acts_available(p_tenant_id pg_catalog.uuid) returns pg_catalog.bool
language sql stable security invoker set search_path = '' as $$
  select coalesce((select t.owns_local_crm from ops.tenants t where t.id = p_tenant_id), false);
$$;

create function ops.move_opportunity_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                               p_deal_ref pg_catalog.int8, p_target_stage pg_catalog.text,
                                               p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v pg_catalog.jsonb;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  v := ops.crm_move_deal(p_tenant_id, p_deal_ref, p_target_stage, p_expected_revision);
  if v ->> 'outcome' = 'moved' then
    insert into ops.commercial_acts (tenant_id, deal_ref, act, actor, facts)
    values (p_tenant_id, p_deal_ref, 'moved', p_actor, pg_catalog.jsonb_build_object('toStage', v ->> 'stage'));
  end if;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'dealRef', p_deal_ref,
    'outcome', v ->> 'outcome', 'revision', v ->> 'revision', 'stage', v ->> 'stage');
end
$$;

create function ops.set_opportunity_next_action_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                           p_deal_ref pg_catalog.int8,
                                                           p_next_action_at pg_catalog.timestamptz,
                                                           p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v         pg_catalog.jsonb;
  v_follow  pg_catalog.jsonb;
  v_act     pg_catalog.uuid := gen_random_uuid();
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  v := ops.crm_set_deal_next_action(p_tenant_id, p_deal_ref, p_next_action_at, p_expected_revision);
  if v ->> 'outcome' = 'unchanged' then
    v_follow := '{"status": "unchanged", "reason": null}'::pg_catalog.jsonb;
  elsif v ->> 'outcome' = 'cleared' then
    v_follow := case
      when ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'commercial_next_action_cleared', null) > 0
        then '{"status": "cancelled", "reason": null}'::pg_catalog.jsonb
      else '{"status": "none", "reason": null}'::pg_catalog.jsonb end;
  else
    v_follow := ops.commercial_follow_up_plan_next_action(p_tenant_id, p_actor, p_deal_ref, p_next_action_at, v_act);
  end if;
  if v ->> 'outcome' <> 'unchanged' then
    insert into ops.commercial_acts (id, tenant_id, deal_ref, act, actor, facts)
    values (v_act, p_tenant_id, p_deal_ref,
            case v ->> 'outcome' when 'set' then 'next_action_set' else 'next_action_cleared' end, p_actor,
            pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
              'nextActionAt', v ->> 'nextActionAt', 'followUp', v_follow ->> 'status', 'followUpReason', v_follow ->> 'reason')));
  end if;
  -- A superseded plan names its successor through a DEFERRED foreign key:
  -- checked here, inside the gate, and then deferred again as declared.
  set constraints ops.follow_up_plans_superseded_by_fkey immediate;
  set constraints ops.follow_up_plans_superseded_by_fkey deferred;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'dealRef', p_deal_ref,
    'outcome', v ->> 'outcome', 'revision', v ->> 'revision', 'nextActionAt', v ->> 'nextActionAt',
    'followUp', v_follow);
end
$$;

create function ops.convert_opportunity_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                                  p_deal_ref pg_catalog.int8, p_target_stage pg_catalog.text,
                                                  p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v        pg_catalog.jsonb;
  v_follow pg_catalog.jsonb := '{"status": "unchanged", "reason": null}'::pg_catalog.jsonb;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  v := ops.crm_convert_deal(p_tenant_id, p_deal_ref, p_target_stage, p_expected_revision);
  if v ->> 'outcome' = 'converted' then
    v_follow := case
      when ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'opportunity_converted', null) > 0
        then '{"status": "cancelled", "reason": null}'::pg_catalog.jsonb
      else '{"status": "none", "reason": null}'::pg_catalog.jsonb end;
    insert into ops.commercial_acts (tenant_id, deal_ref, act, actor, facts)
    values (p_tenant_id, p_deal_ref, 'converted', p_actor,
            pg_catalog.jsonb_build_object('stage', v ->> 'stage', 'followUp', v_follow ->> 'status'));
  end if;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'dealRef', p_deal_ref,
    'outcome', v ->> 'outcome', 'revision', v ->> 'revision', 'stage', v ->> 'stage', 'followUp', v_follow);
end
$$;

create function ops.lose_opportunity_as_member(p_tenant_id pg_catalog.uuid, p_actor pg_catalog.text,
                                               p_deal_ref pg_catalog.int8, p_loss_reason pg_catalog.text,
                                               p_expected_revision pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v        pg_catalog.jsonb;
  v_follow pg_catalog.jsonb := '{"status": "unchanged", "reason": null}'::pg_catalog.jsonb;
begin
  if p_tenant_id is null or p_actor is null then
    raise exception using errcode = 'OS401', message = 'not signed in';
  end if;
  v := ops.crm_lose_deal(p_tenant_id, p_deal_ref, p_loss_reason, p_expected_revision);
  if v ->> 'outcome' = 'lost' then
    v_follow := case
      when ops.commercial_follow_up_cancel(p_tenant_id, p_actor, p_deal_ref, 'opportunity_lost', null) > 0
        then '{"status": "cancelled", "reason": null}'::pg_catalog.jsonb
      else '{"status": "none", "reason": null}'::pg_catalog.jsonb end;
    insert into ops.commercial_acts (tenant_id, deal_ref, act, actor, facts)
    values (p_tenant_id, p_deal_ref, 'lost', p_actor,
            pg_catalog.jsonb_build_object('lossReason', p_loss_reason, 'followUp', v_follow ->> 'status'));
  end if;
  return pg_catalog.jsonb_build_object(
    'v', 1, 'asOf', ops.cos_ts(now()), 'dealRef', p_deal_ref,
    'outcome', v ->> 'outcome', 'revision', v ->> 'revision', 'followUp', v_follow);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. The owner's bridge configuration service. SECURITY INVOKER, executable
--    by no application or capability role: the owner credential calls it.
-- ---------------------------------------------------------------------------

-- Records a new bridge version. Enabled: the named units must be active in
-- the tenant, and the policy version must be its policy's latest (the Phase
-- 3A service plans a policy's latest version). The same configuration as the
-- current one records nothing.
create function ops.configure_commercial_follow_up_bridge(
  p_tenant_id pg_catalog.uuid, p_enabled pg_catalog.bool, p_company_id pg_catalog.uuid,
  p_department_id pg_catalog.uuid, p_agent_id pg_catalog.uuid, p_policy_version_id pg_catalog.uuid,
  p_actor pg_catalog.text)
returns pg_catalog.jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_current ops.commercial_follow_up_bridges;
  v_version ops.follow_up_policy_versions;
  v_id      pg_catalog.uuid;
  v_number  pg_catalog.int4;
begin
  if p_tenant_id is null or not exists (select 1 from ops.tenants t where t.id = p_tenant_id) then
    raise exception using errcode = 'OS404', message = 'ops.configure_commercial_follow_up_bridge: tenant not found';
  end if;
  perform ops.require_scheduling_actor(p_actor, 'ops.configure_commercial_follow_up_bridge');
  if p_enabled is null
     or (not p_enabled and num_nonnulls(p_company_id, p_department_id, p_agent_id, p_policy_version_id) > 0)
     or (p_enabled and (p_company_id is null or p_department_id is null or p_policy_version_id is null)) then
    raise exception using
      errcode = 'OS400',
      message = 'ops.configure_commercial_follow_up_bridge: enabled names a company, a department and a policy version; disabled names nothing';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ops.commercial_follow_up_bridges:' || p_tenant_id::pg_catalog.text, 0));
  if p_enabled then
    if not exists (select 1 from ops.companies c
                    where c.tenant_id = p_tenant_id and c.id = p_company_id and c.status = 'active')
       or not exists (select 1 from ops.departments d
                       where d.tenant_id = p_tenant_id and d.company_id = p_company_id
                         and d.id = p_department_id and d.status = 'active')
       or (p_agent_id is not null
           and not exists (select 1 from ops.agents a
                            where a.tenant_id = p_tenant_id and a.company_id = p_company_id
                              and a.department_id = p_department_id and a.id = p_agent_id and a.status = 'active')) then
      raise exception using errcode = 'OS409',
        message = 'ops.configure_commercial_follow_up_bridge: the company, department and agent must be active in this tenant';
    end if;
    select v.* into v_version from ops.follow_up_policy_versions v
     where v.tenant_id = p_tenant_id and v.id = p_policy_version_id;
    if not found then
      raise exception using errcode = 'OS404',
        message = 'ops.configure_commercial_follow_up_bridge: follow-up policy version not found in this tenant';
    end if;
    if exists (select 1 from ops.follow_up_policy_versions n
                where n.tenant_id = p_tenant_id and n.policy_id = v_version.policy_id and n.version > v_version.version) then
      raise exception using errcode = 'OS409',
        message = 'ops.configure_commercial_follow_up_bridge: pin the policy''s latest version';
    end if;
  end if;
  select b.* into v_current from ops.commercial_follow_up_bridges b
   where b.tenant_id = p_tenant_id order by b.version desc limit 1;
  if found and v_current.enabled = p_enabled
     and v_current.company_id is not distinct from p_company_id
     and v_current.department_id is not distinct from p_department_id
     and v_current.agent_id is not distinct from p_agent_id
     and v_current.policy_version_id is not distinct from p_policy_version_id then
    return pg_catalog.jsonb_build_object('bridge_id', v_current.id, 'version', v_current.version, 'created', false);
  end if;
  if not found and not p_enabled then
    return pg_catalog.jsonb_build_object('bridge_id', null, 'version', 0, 'created', false);
  end if;
  insert into ops.commercial_follow_up_bridges
    (tenant_id, version, enabled, company_id, department_id, agent_id, policy_version_id, created_by)
  values (p_tenant_id, 0, p_enabled, p_company_id, p_department_id, p_agent_id, p_policy_version_id, p_actor)
  returning id, version into v_id, v_number;
  return pg_catalog.jsonb_build_object('bridge_id', v_id, 'version', v_number, 'created', true);
end
$$;

-- ---------------------------------------------------------------------------
-- 8. The funnel projection: which acts the bridge will adjust follow-ups for.
-- ---------------------------------------------------------------------------

create or replace function ops.cos_commercial_funnel(p_tenant_id pg_catalog.uuid, p_as_of pg_catalog.timestamptz)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_zone   pg_catalog.text := coalesce((select s.timezone from ops.scheduling_settings s
                                         where s.tenant_id = p_tenant_id), 'UTC');
  v_result pg_catalog.jsonb;
begin
  begin
    v_result := ops.crm_commercial_funnel(p_tenant_id, v_zone, p_as_of);
  exception when others then
    -- A CRM fault never takes the rest of the overview down. The warning
    -- carries the SQLSTATE only, never data.
    raise warning 'the commercial funnel could not be read (SQLSTATE %)', sqlstate;
    return '{"status": "unavailable"}'::pg_catalog.jsonb;
  end;
  if v_result ->> 'status' = 'available' then
    v_result := v_result || pg_catalog.jsonb_build_object(
      'timezone', v_zone,
      'timezoneConfigured', exists (select 1 from ops.scheduling_settings s where s.tenant_id = p_tenant_id),
      'today', pg_catalog.to_char((p_as_of at time zone v_zone)::pg_catalog.date, 'YYYY-MM-DD'),
      -- Phase 3B.2: whether setting a next action adjusts follow-ups, and
      -- nothing about the bridge beyond that status.
      'followUpBridge', ops.cos_commercial_follow_up_bridge(p_tenant_id) ->> 'status');
  end if;
  return v_result;
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Privileges and the end state.
-- ---------------------------------------------------------------------------

revoke all on function
  ops.crm_stage_configuration(),
  ops.crm_stage_codes(pg_catalog.jsonb),
  ops.crm_converted_codes(pg_catalog.jsonb),
  ops.crm_deal_revision(public.deals),
  ops.crm_revision_ok(pg_catalog.text),
  ops.crm_loss_reason_ok(public.loss_reasons),
  ops.crm_deal_is_open(public.deals, pg_catalog.text[]),
  ops.crm_deal_actions(public.deals, pg_catalog.text[], pg_catalog.text[]),
  ops.crm_deal_card(public.deals, pg_catalog.timestamptz, pg_catalog.text, pg_catalog.timestamptz,
                    pg_catalog.text[], pg_catalog.text[]),
  ops.crm_commercial_funnel(pg_catalog.uuid, pg_catalog.text, pg_catalog.timestamptz),
  ops.crm_lock_deal(pg_catalog.uuid, pg_catalog.int8),
  ops.crm_act_configuration(),
  ops.crm_move_deal(pg_catalog.uuid, pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.crm_set_deal_next_action(pg_catalog.uuid, pg_catalog.int8, pg_catalog.timestamptz, pg_catalog.text),
  ops.crm_convert_deal(pg_catalog.uuid, pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.crm_lose_deal(pg_catalog.uuid, pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.cos_commercial_follow_up_bridge(pg_catalog.uuid),
  ops.commercial_follow_up_cancel(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text, pg_catalog.uuid),
  ops.commercial_follow_up_plan_next_action(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.timestamptz,
                                            pg_catalog.uuid),
  ops.cos_commercial_acts_available(pg_catalog.uuid),
  ops.move_opportunity_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.set_opportunity_next_action_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.timestamptz,
                                            pg_catalog.text),
  ops.convert_opportunity_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.lose_opportunity_as_member(pg_catalog.uuid, pg_catalog.text, pg_catalog.int8, pg_catalog.text, pg_catalog.text),
  ops.configure_commercial_follow_up_bridge(pg_catalog.uuid, pg_catalog.bool, pg_catalog.uuid, pg_catalog.uuid,
                                            pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text),
  ops.cos_commercial_funnel(pg_catalog.uuid, pg_catalog.timestamptz),
  ops.refuse_commercial_history_change(),
  ops.guard_commercial_follow_up_bridge_insert(),
  ops.guard_commercial_act_insert()
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

do $end_state$
declare
  v_bad    pg_catalog.text;
  v_funnel pg_catalog.jsonb;
  -- Every function this migration creates or replaces, by name.
  c_names  constant pg_catalog.text[] := array[
    'crm_stage_configuration', 'crm_stage_codes', 'crm_converted_codes', 'crm_deal_revision', 'crm_revision_ok',
    'crm_loss_reason_ok', 'crm_deal_is_open', 'crm_deal_actions', 'crm_deal_card', 'crm_commercial_funnel',
    'crm_lock_deal', 'crm_act_configuration', 'crm_move_deal', 'crm_set_deal_next_action', 'crm_convert_deal',
    'crm_lose_deal', 'cos_commercial_follow_up_bridge', 'commercial_follow_up_cancel',
    'commercial_follow_up_plan_next_action', 'cos_commercial_acts_available', 'move_opportunity_as_member',
    'set_opportunity_next_action_as_member', 'convert_opportunity_as_member', 'lose_opportunity_as_member',
    'configure_commercial_follow_up_bridge', 'cos_commercial_funnel', 'refuse_commercial_history_change',
    'guard_commercial_follow_up_bridge_insert', 'guard_commercial_act_insert'];
  -- The write path of the four acts.
  c_acts   constant pg_catalog.text[] := array[
    'crm_lock_deal', 'crm_act_configuration', 'crm_move_deal', 'crm_set_deal_next_action', 'crm_convert_deal',
    'crm_lose_deal', 'commercial_follow_up_cancel', 'commercial_follow_up_plan_next_action',
    'move_opportunity_as_member', 'set_opportunity_next_action_as_member', 'convert_opportunity_as_member',
    'lose_opportunity_as_member'];
begin
  -- No application or capability role reaches any new function or table.
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and p.proname = any (c_names)
     and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'a role can execute a commercial function: %', v_bad;
  end if;
  select pg_catalog.string_agg(r.rolname || ':' || c.relname, ', ') into v_bad
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   cross join (values ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'), ('ops_operator_api')) as r (rolname)
   where n.nspname = 'ops' and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')
     and pg_catalog.has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  if v_bad is not null then
    raise exception 'a role holds a privilege on a commercial table: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'ops' and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')
                and not (c.relrowsecurity and c.relforcerowsecurity))
     or exists (select 1 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
                 join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'ops' and c.relname in ('commercial_follow_up_bridges', 'commercial_follow_up_plans', 'commercial_acts')) then
    raise exception 'a commercial table is not RLS-forced with no policy';
  end if;
  -- Every new function is SECURITY INVOKER with an empty search path.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_names)
     and (p.prosecdef or p.proconfig is distinct from array['search_path=""']);
  if v_bad is not null then
    raise exception 'a commercial function is DEFINER or has no empty search path: %', v_bad;
  end if;
  -- The acts reach no send, outbound row, model run, message or stop.
  select pg_catalog.string_agg(p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'ops' and p.proname = any (c_acts)
     and p.prosrc ~* '(outbound|send|whatsapp|agent_run|enqueue_job|execution_stop|lead_profiles|execute\s)';
  if v_bad is not null then
    raise exception 'a commercial act reaches a send, a run, a stop or dynamic SQL: %', v_bad;
  end if;
  -- A tenant that does not own the local CRM still reads nothing of it.
  v_funnel := ops.read_overview('00000000-0000-4000-8000-000000000000'::pg_catalog.uuid) -> 'funnel';
  if v_funnel is distinct from '{"status": "not_configured"}'::pg_catalog.jsonb then
    raise exception 'the overview''s funnel must be not_configured for a tenant without the local CRM: %', v_funnel;
  end if;
end
$end_state$;
