-- ADR 0023 §C, §D (pack health_pt_br.v4, 2026-10-06): the people a contact
-- may ask for by name. A lead who writes "quero falar com o Rafael" asks for a
-- person only if Rafael is on the team; "preciso falar com o Bruno, meu
-- marido" asks for no one. No reviewed pack can know a tenant's team, so the
-- operating policy names it (`handoffNames`, at most 20 names), and the screen
-- treats a request for one of them as a request for a person: the contact gets
-- the handoff text, the conversation moves to a person, and nothing reaches a
-- model. A name can only make a handoff; it never sends anything to a model.
--
-- Two functions of 20261011120000 change, nothing else:
-- - ops.agent_configuration_valid holds the shape of `handoffNames` when an
--   operating policy has it (an array of names: a letter first, then letters,
--   spaces, dots, apostrophes or hyphens, at most 60 characters);
-- - ops.front_desk_policy_for_run, the worker's capability, returns the names
--   with the pack id (an empty array when the policy names no one).
-- A published policy without the key is unchanged.
--
-- PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.

create or replace function ops.agent_configuration_valid(p_kind text, p_content jsonb)
returns boolean
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_stage jsonb;
  v_key   text;
  v_name  jsonb;
begin
  if p_content is null or jsonb_typeof(p_content) <> 'object' or pg_column_size(p_content) > 65536 then
    return false;
  end if;
  if p_kind = 'operating_policy' then
    if coalesce(p_content ->> 'sendMode', '') not in ('staging', 'supervised')
       or coalesce(p_content ->> 'sanitizerPack', '') !~ '^[a-z][a-z0-9_]*\.v[0-9]{1,4}$'
       or jsonb_typeof(p_content -> 'contextTurns') is distinct from 'number'
       or (p_content ->> 'contextTurns') !~ '^[0-9]{1,2}$'
       or not ops.configured_text_valid(p_content -> 'aiDisclosure', 300) then
      return false;
    end if;
    if p_content ? 'handoffNames' then
      if jsonb_typeof(p_content -> 'handoffNames') is distinct from 'array'
         or jsonb_array_length(p_content -> 'handoffNames') > 20 then
        return false;
      end if;
      for v_name in select n from jsonb_array_elements(p_content -> 'handoffNames') n loop
        if jsonb_typeof(v_name) <> 'string'
           or (v_name #>> '{}') !~ '^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .''-]{0,59}$' then
          return false;
        end if;
      end loop;
    end if;
    return (p_content ->> 'contextTurns')::integer between 0 and 12;
  end if;
  if p_kind = 'playbook' then
    if jsonb_typeof(p_content -> 'stages') is distinct from 'array' then
      return false;
    end if;
    if jsonb_array_length(p_content -> 'stages') not between 1 and 20 then
      return false;
    end if;
    for v_stage in select s from jsonb_array_elements(p_content -> 'stages') s loop
      if jsonb_typeof(v_stage) <> 'object'
         or coalesce(v_stage ->> 'key', '') !~ '^[a-z][a-z0-9_]{0,39}$'
         or not ops.configured_text_valid(v_stage -> 'objective', 500) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if p_kind = 'knowledge' then
    if jsonb_typeof(p_content -> 'domains') is distinct from 'object' then
      return false;
    end if;
    return exists (select 1 from jsonb_object_keys(p_content -> 'domains'));
  end if;
  if p_kind = 'fixed_messages' then
    if jsonb_typeof(p_content -> 'messages') is distinct from 'object' then
      return false;
    end if;
    foreach v_key in array ops.fixed_message_keys() loop
      if not ops.configured_text_valid(p_content -> 'messages' -> v_key, 1000) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  return false;
end
$function$;

-- Whether the run bound to the leased job belongs to an agent with a
-- published operating policy, which screening pack that policy names, and the
-- people a contact may ask for by name.
create or replace function ops.front_desk_policy_for_run()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_attempt integer := ops.agent_run_lease_attempt();
  v_tenant  uuid := ops.current_tenant_id();
  v_job     uuid := nullif(current_setting('app.job_id', true), '')::uuid;
  v_run     ops.agent_runs;
  v_policy  ops.agent_configuration_versions;
begin
  select r.* into v_run from ops.agent_runs r where r.tenant_id = v_tenant and r.job_id = v_job;
  if not found then
    raise exception 'ops.front_desk_policy_for_run: no agent run is bound to the leased job' using errcode = '42501';
  end if;
  if v_run.capability <> 'lead_triage' then
    return jsonb_build_object('applies', false);
  end if;
  v_policy := ops.published_agent_configuration(v_tenant, v_run.agent_id, 'operating_policy');
  if v_policy.id is null then
    return jsonb_build_object('applies', false);
  end if;
  return jsonb_build_object(
    'applies', true,
    'packId', v_policy.content ->> 'sanitizerPack',
    'handoffNames', coalesce(v_policy.content -> 'handoffNames', '[]'::jsonb));
end
$function$;

do $end_state$
begin
  -- The worker's capability returns the names, and is still the worker's alone.
  if pg_catalog.strpos((select p.prosrc from pg_catalog.pg_proc p
                         where p.oid = 'ops.front_desk_policy_for_run()'::pg_catalog.regprocedure),
                        '''handoffNames''') = 0 then
    raise exception 'the front-desk policy capability does not return the configured names';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = 'ops.front_desk_policy_for_run()'::pg_catalog.regprocedure
                    and p.prosecdef and p.proconfig = array['search_path=""']) then
    raise exception 'the front-desk policy capability lost its definer or its pinned search path';
  end if;
  if not pg_catalog.has_function_privilege('ops_worker', 'ops.front_desk_policy_for_run()', 'EXECUTE')
     or pg_catalog.has_function_privilege('ops_gateway', 'ops.front_desk_policy_for_run()', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.front_desk_policy_for_run()', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'ops.front_desk_policy_for_run()', 'EXECUTE') then
    raise exception 'the front-desk policy capability is no longer the worker''s alone';
  end if;
  if pg_catalog.has_function_privilege('ops_worker', 'ops.agent_configuration_valid(text, jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'ops.agent_configuration_valid(text, jsonb)', 'EXECUTE') then
    raise exception 'an application role can execute the configuration check';
  end if;
  -- The shape of the names is held, and the rest of the check is unchanged.
  if not ops.agent_configuration_valid('operating_policy',
       '{"sendMode":"supervised","sanitizerPack":"health_pt_br.v4","contextTurns":4,"aiDisclosure":"x","handoffNames":["Rafael","Dra. Heléna","Maria-José d''Ávila"]}'::jsonb) then
    raise exception 'a valid list of names was refused';
  end if;
  if ops.agent_configuration_valid('operating_policy',
       '{"sendMode":"supervised","sanitizerPack":"health_pt_br.v4","contextTurns":4,"aiDisclosure":"x","handoffNames":"Rafael"}'::jsonb)
     or ops.agent_configuration_valid('operating_policy',
       '{"sendMode":"supervised","sanitizerPack":"health_pt_br.v4","contextTurns":4,"aiDisclosure":"x","handoffNames":[42]}'::jsonb)
     or ops.agent_configuration_valid('operating_policy',
       '{"sendMode":"supervised","sanitizerPack":"health_pt_br.v4","contextTurns":4,"aiDisclosure":"x","handoffNames":["(?:.*)"]}'::jsonb)
     or ops.agent_configuration_valid('operating_policy',
       jsonb_build_object('sendMode', 'supervised', 'sanitizerPack', 'health_pt_br.v4', 'contextTurns', 4,
                          'aiDisclosure', 'x',
                          'handoffNames', (select jsonb_agg('Name'::text) from generate_series(1, 21)))) then
    raise exception 'a malformed list of names passed the operating policy check';
  end if;
  if ops.agent_configuration_valid('operating_policy',
       '{"sendMode":"autonomous","sanitizerPack":"health_pt_br.v1","contextTurns":4,"aiDisclosure":"x"}'::jsonb) then
    raise exception 'an autonomous send mode passed the operating policy check';
  end if;
  -- Every stored configuration still passes the check it is constrained by.
  if exists (select 1 from ops.agent_configuration_versions v
              where not ops.agent_configuration_valid(v.kind, v.content)) then
    raise exception 'a stored configuration no longer passes its check';
  end if;
end
$end_state$;
