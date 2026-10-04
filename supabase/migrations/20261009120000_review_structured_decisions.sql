-- ADR 0022: the review page shows the structured decisions (Jev, shadow only)
-- recorded for the review's demand, beside the triage a person decides.
--
-- READ ONLY AND ADVISORY. get_review gains `structuredDecisions`: for a
-- browser-decidable review (lead_triage, synthetic or test data, the same
-- scope as the Phase 2D shadow decision) the business route and the lead
-- intelligence recorded for its task and the model-route advice recorded for
-- its run; any other review reads `unavailable`. Nothing about it changes the
-- decisions a person may make, and nothing reads it to act.
--
-- MINIMISED. Each decision shows its state, the build that answered, its
-- charged cost and its instants, and, once completed, only the chosen options,
-- their levels and their confidences, beside the route the deterministic path
-- actually took. Never the question spec, the input fingerprint, the
-- idempotency key, the job, the raw answers or a probability map. A department
-- the decision names is shown with the tenant's own department name (data,
-- never a label in code).
--
-- No exposed function changes: company_os_api.get_review already reaches
-- ops.read_review_detail through its gate, so this is not an OD-8a migration.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

-- ---------------------------------------------------------------------------
-- 1. One decision as the browser reads it.
-- ---------------------------------------------------------------------------

-- A score answer's level on the three-level scales of these question sets: the
-- stored most probable level when it is a number, else the rounded
-- probability-weighted score (a number the ledger's guard has checked).
create function ops.cos_structured_level(p_answer pg_catalog.jsonb)
returns pg_catalog.text
language sql immutable security invoker set search_path = '' as $$
  select case pg_catalog.round(case when pg_catalog.jsonb_typeof(p_answer -> 'level') = 'number'
                                    then (p_answer ->> 'level')::pg_catalog.numeric
                                    when pg_catalog.jsonb_typeof(p_answer -> 'score') = 'number'
                                    then (p_answer ->> 'score')::pg_catalog.numeric end)
           when 0 then 'low' when 1 then 'medium' when 2 then 'high' end;
$$;

-- A department slug the decision names, with the name its company gives it
-- (a slug is unique within a company); null for human_review and no_action.
create function ops.cos_structured_department(p_tenant_id pg_catalog.uuid, p_company_id pg_catalog.uuid,
                                              p_slug pg_catalog.text)
returns pg_catalog.jsonb
language sql stable security invoker set search_path = '' as $$
  select case when p_slug is null then null else pg_catalog.jsonb_build_object(
    'slug', p_slug,
    'name', (select d.name from ops.departments d
              where d.tenant_id = p_tenant_id and d.company_id = p_company_id and d.slug = p_slug)) end;
$$;

create function ops.cos_structured_decision(p_d ops.structured_decisions)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_a   pg_catalog.jsonb := p_d.answers;
  v_det pg_catalog.jsonb := coalesce(p_d.deterministic_route, '{}'::pg_catalog.jsonb);
  v_answer pg_catalog.jsonb;
begin
  if p_d.status = 'completed' then
    v_answer := case p_d.decision_kind
      when 'business_route' then pg_catalog.jsonb_build_object(
        'intent', v_a #>> '{intent,choice}',
        'intentConfidence', v_a #> '{intent,confidence}',
        'department', ops.cos_structured_department(p_d.tenant_id, p_d.company_id, v_a #>> '{department,choice}'),
        'departmentConfidence', v_a #> '{department,confidence}',
        'capability', v_a #>> '{capability,choice}',
        'capabilityConfidence', v_a #> '{capability,confidence}',
        'complexity', ops.cos_structured_level(v_a -> 'complexity'),
        'humanReviewProbability', v_a #> '{human_review,noul}')
      when 'lead_intelligence' then pg_catalog.jsonb_build_object(
        'commercialReadiness', ops.cos_structured_level(v_a -> 'commercial_readiness'),
        'schedulingReadiness', ops.cos_structured_level(v_a -> 'scheduling_readiness'),
        'followUpPriority', ops.cos_structured_level(v_a -> 'follow_up_priority'),
        'objection', v_a #>> '{objection,choice}',
        'nextBestAction', v_a #>> '{next_best_action,choice}')
      else pg_catalog.jsonb_build_object(
        'suggestedModel', v_a #>> '{model,choice}',
        'confidence', v_a #> '{model,confidence}')
      end;
  end if;
  return pg_catalog.jsonb_build_object(
    'status', case when p_d.status = 'running' then 'pending' else p_d.status end,
    'questionSet', p_d.question_set,
    'refusal', p_d.refusal_code,
    'errorCode', p_d.error_code,
    'decisionModel', p_d.served_model,
    'chargedCost', ops.cos_money(p_d.charged_cost_micros),
    'requestedAt', ops.cos_ts(p_d.requested_at),
    'settledAt', ops.cos_ts(p_d.settled_at),
    'routeTaken', case p_d.decision_kind
      when 'business_route' then pg_catalog.jsonb_build_object(
        'department', ops.cos_structured_department(p_d.tenant_id, p_d.company_id, v_det ->> 'department'),
        'capability', v_det ->> 'capability')
      when 'model_route' then pg_catalog.jsonb_build_object('model', v_det ->> 'executedModel')
      else null end,
    'answer', v_answer);
end
$$;

-- ---------------------------------------------------------------------------
-- 2. A review's structured decisions: per task for the business route and the
--    lead intelligence, per run for the model-route advice (their keys).
-- ---------------------------------------------------------------------------

create function ops.cos_review_structured_decisions(p_tenant_id pg_catalog.uuid, p_item ops.review_items)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_out pg_catalog.jsonb := pg_catalog.jsonb_build_object(
    'status', 'available', 'businessRoute', null, 'leadIntelligence', null, 'modelRoute', null);
  v_d   ops.structured_decisions;
begin
  if p_item.capability <> 'lead_triage' or not ops.cos_review_decidable(p_tenant_id, p_item) then
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
-- 3. get_review carries them. The body is the Phase 2D one plus one key.
-- ---------------------------------------------------------------------------

create or replace function ops.read_review_detail(p_tenant_id pg_catalog.uuid, p_review_id pg_catalog.uuid)
returns pg_catalog.jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_item ops.review_items;
begin
  select * into v_item from ops.review_items r where r.id = p_review_id and r.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'OS404', message = 'not found';
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'asOf', ops.cos_ts(now()))
    || ops.cos_review_summary(p_tenant_id, v_item)
    || pg_catalog.jsonb_build_object(
      'decisionNote', v_item.decision_note,
      'allowedDecisions', case when v_item.status <> 'pending' or not ops.cos_review_decidable(p_tenant_id, v_item)
                                 then '[]'::pg_catalog.jsonb
                               when v_item.do_not_contact then '["rejected", "needs_edit"]'::pg_catalog.jsonb
                               else '["accepted", "rejected", "needs_edit"]'::pg_catalog.jsonb end,
      -- Phase 2D.1: advisory only. Nothing about it changes allowedDecisions.
      'shadowDecision', ops.cos_review_shadow_decision(p_tenant_id, v_item),
      -- ADR 0022: advisory only, likewise.
      'structuredDecisions', ops.cos_review_structured_decisions(p_tenant_id, v_item));
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Access: backend only, like every other projection.
-- ---------------------------------------------------------------------------

revoke all on function
  ops.cos_structured_level(pg_catalog.jsonb),
  ops.cos_structured_department(pg_catalog.uuid, pg_catalog.uuid, pg_catalog.text),
  ops.cos_structured_decision(ops.structured_decisions),
  ops.cos_review_structured_decisions(pg_catalog.uuid, ops.review_items)
  from public, anon, authenticated, service_role, ops_worker, ops_gateway;

-- ---------------------------------------------------------------------------
-- 5. Assert the end state.
-- ---------------------------------------------------------------------------

do $end_state$
declare
  v_bad pg_catalog.text;
begin
  select pg_catalog.string_agg(r.rolname || ':' || p.proname, ', ') into v_bad
    from pg_catalog.pg_proc p
    cross join (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('ops_worker'), ('ops_gateway'),
                       ('ops_operator_api')) as r (rolname)
   where p.pronamespace = 'ops'::pg_catalog.regnamespace
     and p.proname in ('cos_structured_level', 'cos_structured_department', 'cos_structured_decision',
                       'cos_review_structured_decisions')
     and ((r.rolname = 'public' and exists (
            select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
          or (r.rolname <> 'public' and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE')));
  if v_bad is not null then
    raise exception 'a role can execute a structured decision projection: %', v_bad;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.pg_proc p
       where p.pronamespace = 'ops'::pg_catalog.regnamespace
         and p.proname in ('cos_structured_level', 'cos_structured_department', 'cos_structured_decision',
                           'cos_review_structured_decisions')
         and p.prosecdef = false and p.provolatile in ('i', 's')
         and p.proconfig = array['search_path=""']) <> 4 then
    raise exception 'the structured decision projections are not four invoker, non-volatile, pinned functions';
  end if;
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.read_review_detail(pg_catalog.uuid, pg_catalog.uuid)'::pg_catalog.regprocedure),
                        'structuredDecisions') = 0 then
    raise exception 'get_review does not carry the structured decisions';
  end if;
end
$end_state$;
