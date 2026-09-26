-- Upgrade assertions (scripts/run-db-upgrade-test.mjs, Phase 1D.2).
--
-- Runs after legacy_fixture.sql was loaded at 20260911130000 and every later
-- migration was applied over it, with the idempotent backfills applied twice.
-- Each block names the Codex finding it closes. Findings 1-3 were reproduced
-- on exactly this fixture before their fix (docs/PHASE_1D2_REPORT.md), and
-- each assertion below failed against the unfixed chain.
--
-- One transaction ending in ROLLBACK: the behaviour probes write rows, and
-- nothing they write may outlive the file. Any failed assertion raises, which
-- aborts the transaction and makes psql exit non-zero.

\set ON_ERROR_STOP on
-- Only failures matter; errors still reach stderr.
\o /dev/null

begin;

-- Act as a sales user through the real `authenticated` role, the way
-- PostgREST does: a JWT subject and SET ROLE, never a bypass.
create function pg_temp.act_as(p_email text) returns void
language plpgsql as $$
declare
  v_user uuid;
begin
  select user_id into strict v_user from public.sales where email = p_email;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end
$$;

-- ===========================================================================
-- 0. The chain really ran over the fixture.
-- ===========================================================================

do $$
begin
  if (select max(version) from supabase_migrations.schema_migrations) < '20260917180300' then
    raise exception 'the upgrade did not reach the Phase 1D.2 migrations';
  end if;
  if (select count(*) from public.deals where name like 'Legacy deal [%') <> 8
     or (select count(*) from public.sales where email like '%@upgrade.test') <> 5
     or (select count(*) from public.contacts where last_name in ('WithDates', 'NoFirstSeen', 'OfOperator', 'WithNote', 'NoDates')) <> 5 then
    raise exception 'the legacy fixture is not in the upgraded database';
  end if;
end
$$;

-- ===========================================================================
-- 1. FINDING 1: legacy deals keep their stage.
-- ===========================================================================

do $$
declare
  v_bad text;
begin
  -- 1a. Each deal's pipeline_stage is its legacy stage, unchanged; an empty
  --     stage takes the trigger's default.
  select string_agg(format('%s -> %s/%s', name, stage, pipeline_stage), '; ')
    into v_bad
    from public.deals
   where name like 'Legacy deal [%'
     and (pipeline_stage is distinct from coalesce(nullif(substring(name from '\[(.*)\]'), ''), 'new_lead')
          or stage is distinct from pipeline_stage);
  if v_bad is not null then
    raise exception 'legacy deals lost their stage in the upgrade: %', v_bad;
  end if;

  -- 1b. The correction is not a user edit: updated_at keeps its legacy value.
  if exists (select 1 from public.deals
              where name like 'Legacy deal [%'
                and updated_at <> timestamptz '2025-02-02 00:00+00') then
    raise exception 'the legacy deal backfill rewrote updated_at';
  end if;

  -- 1c. Every non-empty legacy stage is still a column of the tenant's board.
  select string_agg(d.pipeline_stage, ', ') into v_bad
    from public.deals d
   where d.name like 'Legacy deal [%'
     and d.name <> 'Legacy deal []'
     and not exists (
           select 1
             from public.configuration c,
                  jsonb_array_elements(c.config -> 'dealStages') s
            where s ->> 'value' = d.pipeline_stage);
  if v_bad is not null then
    raise exception 'legacy deals sit in stages the board does not show: %', v_bad;
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.deals'::regclass
                    and tgname = 'synchronize_deal_pipeline_trigger'
                    and tgenabled = 'O') then
    raise exception 'synchronize_deal_pipeline_trigger is not enabled after the upgrade';
  end if;
end
$$;

-- 1d. An ordinary edit after the upgrade (the operator renames two of their
--     legacy deals) keeps the stage. Before the fix this is what overwrote
--     `won` and `in-negociation` with `new_lead`.
select pg_temp.act_as('operator@upgrade.test');
update public.deals
   set name = name || ' (edited)'
 where name in ('Legacy deal [won]', 'Legacy deal [in-negociation]');
reset role;

do $$
begin
  if (select count(*) from public.deals where name like '% (edited)') <> 2 then
    raise exception 'the operator could not edit their own legacy deals';
  end if;
  if exists (select 1 from public.deals
              where name like '% (edited)'
                and (pipeline_stage <> substring(name from '\[(.*)\]')
                     or stage <> pipeline_stage)) then
    raise exception 'editing a legacy deal after the upgrade overwrote its stage';
  end if;
end
$$;

-- 1e. New deals still get the intended default, and an explicit stage wins.
select pg_temp.act_as('operator@upgrade.test');
insert into public.deals (name, contact_ids, "index")
values ('New deal [default]', '{}', 0);
insert into public.deals (name, pipeline_stage, contact_ids, "index")
values ('New deal [contact_started]', 'contact_started', '{}', 0);
reset role;

do $$
begin
  if (select pipeline_stage from public.deals where name = 'New deal [default]') <> 'new_lead'
     or (select stage from public.deals where name = 'New deal [default]') <> 'new_lead' then
    raise exception 'a new deal no longer defaults to new_lead';
  end if;
  if (select pipeline_stage from public.deals where name = 'New deal [contact_started]') <> 'contact_started'
     or (select stage from public.deals where name = 'New deal [contact_started]') <> 'contact_started' then
    raise exception 'a new deal lost the stage it was created with';
  end if;
end
$$;

-- ===========================================================================
-- 2. FINDING 2: the upgrade halted until a person chose the owner; that owner
--    administers, the other legacy administrators became recorded operators,
--    and nothing was promoted on trust.
-- ===========================================================================

do $$
declare
  v_bad text;
begin
  -- 2a. Only the user the person bootstrapped is an owner.
  select string_agg(format('%s administrator=%s disabled=%s role=%s',
                           email, administrator, disabled, role), '; ')
    into v_bad
    from public.sales
   where email like '%@upgrade.test'
     and (role is distinct from (case when email = 'first-admin@upgrade.test'
                                      then 'owner' else 'operator' end)
          or administrator is distinct from (email = 'first-admin@upgrade.test'));
  if v_bad is not null then
    raise exception 'sales roles after the upgrade are wrong: %', v_bad;
  end if;

  -- 2b. No half-state row survives: administrator and role move together, as
  --     the users edge function writes them.
  if exists (select 1 from public.sales where administrator <> (role = 'owner')) then
    raise exception 'a sales row has administrator and role out of step';
  end if;

  -- 2c. Exactly one owner: the upgrade itself promoted no one.
  if (select count(*) from public.sales where role = 'owner') <> 1 then
    raise exception 'the upgrade created % owners, expected the 1 a person chose',
      (select count(*) from public.sales where role = 'owner');
  end if;

  -- 2d. Metadata that claims ownership was not trusted.
  if (select role from public.sales where email = 'claims-owner@upgrade.test') <> 'operator' then
    raise exception 'user metadata claiming ownership was trusted';
  end if;

  -- 2e. Every change is recorded, once, even though the guard ran twice.
  select string_agg(format('%s:%s:%s', s.email, l.action, l.actor), '; ' order by l.id)
    into v_bad
    from public.owner_provisioning_log l
    join public.sales s on s.id = l.sales_id
   where s.user_id <> l.user_id;
  if v_bad is not null then
    raise exception 'owner_provisioning_log rows name the wrong auth user: %', v_bad;
  end if;
  if (select array_agg(format('%s:%s', s.email, l.action) order by s.email, l.action)
        from public.owner_provisioning_log l
        join public.sales s on s.id = l.sales_id)
     is distinct from array[
       'disabled-admin@upgrade.test:legacy_administrator_demoted',
       'first-admin@upgrade.test:bootstrap_owner',
       'promoted-admin@upgrade.test:legacy_administrator_demoted'] then
    raise exception 'owner_provisioning_log does not hold exactly the bootstrap and the two demotions: %',
      (select array_agg(format('%s:%s', s.email, l.action) order by s.email, l.action)
         from public.owner_provisioning_log l join public.sales s on s.id = l.sales_id);
  end if;
  if (select actor from public.owner_provisioning_log where action = 'bootstrap_owner') <> 'upgrade replay operator' then
    raise exception 'the bootstrap did not record the person who ran it';
  end if;
end
$$;

-- 2f. is_admin() through the authenticated role, user by user.
create temporary table upgrade_admin_probe (email text, is_admin boolean) on commit drop;
grant insert, select on upgrade_admin_probe to authenticated;

select pg_temp.act_as('first-admin@upgrade.test');
insert into upgrade_admin_probe select 'first-admin@upgrade.test', public.is_admin();
reset role;
select pg_temp.act_as('promoted-admin@upgrade.test');
insert into upgrade_admin_probe select 'promoted-admin@upgrade.test', public.is_admin();
reset role;
select pg_temp.act_as('disabled-admin@upgrade.test');
insert into upgrade_admin_probe select 'disabled-admin@upgrade.test', public.is_admin();
reset role;
select pg_temp.act_as('operator@upgrade.test');
insert into upgrade_admin_probe select 'operator@upgrade.test', public.is_admin();
reset role;
select pg_temp.act_as('claims-owner@upgrade.test');
insert into upgrade_admin_probe select 'claims-owner@upgrade.test', public.is_admin();
reset role;

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s is_admin=%s', email, is_admin), '; ') into v_bad
    from upgrade_admin_probe
   where is_admin is distinct from (email = 'first-admin@upgrade.test');
  if v_bad is not null or (select count(*) from upgrade_admin_probe) <> 5 then
    raise exception 'is_admin() after the upgrade is wrong: %', coalesce(v_bad, 'probe incomplete');
  end if;
end
$$;

-- 2g. The owner the person chose can change Settings; an operator cannot.
--     Before the fix no one could: the administrator's update matched zero rows.
create temporary table upgrade_settings_probe (email text, updated bigint) on commit drop;
grant insert, select on upgrade_settings_probe to authenticated;

select pg_temp.act_as('first-admin@upgrade.test');
with u as (update public.configuration set config = config || '{"title":"Upgraded"}'
            where id = 1 returning 1)
insert into upgrade_settings_probe select 'first-admin@upgrade.test', count(*) from u;
reset role;
select pg_temp.act_as('operator@upgrade.test');
with u as (update public.configuration set config = config || '{"title":"Hijacked"}'
            where id = 1 returning 1)
insert into upgrade_settings_probe select 'operator@upgrade.test', count(*) from u;
reset role;

do $$
begin
  if (select updated from upgrade_settings_probe where email = 'first-admin@upgrade.test') <> 1 then
    raise exception 'the bootstrapped owner cannot administer: a Settings update matched no row';
  end if;
  if (select updated from upgrade_settings_probe where email = 'operator@upgrade.test') <> 0 then
    raise exception 'an operator changed Settings after the upgrade';
  end if;
end
$$;

-- ===========================================================================
-- 3. FINDING 3: every legacy contact has exactly one lead profile.
-- ===========================================================================

do $$
declare
  v_bad text;
begin
  -- 3a. Exactly one profile per contact, legacy and new alike.
  select string_agg(c.last_name || ':' || coalesce(n.profiles, 0), ', ') into v_bad
    from public.contacts c
    left join (select contact_id, count(*) as profiles
                 from public.lead_profiles group by contact_id) n
      on n.contact_id = c.id
   where coalesce(n.profiles, 0) <> 1;
  if v_bad is not null then
    raise exception 'contacts without exactly one lead profile: %', v_bad;
  end if;
  if (select count(*) from public.lead_profiles) <> (select count(*) from public.contacts) then
    raise exception 'lead profiles exist that belong to no contact';
  end if;

  -- 3b. Each backfilled profile holds what the insert trigger and the note
  --     trigger would have given it, and the table defaults otherwise.
  select string_agg(format('%s acquired=%s last=%s', c.last_name,
                           lp.acquired_at, lp.last_interaction_at), '; ')
    into v_bad
    from (values
      ('WithDates',   timestamptz '2025-01-10 09:00+00', timestamptz '2025-03-01 10:00+00'),
      ('NoFirstSeen', timestamptz '2025-02-01 10:00+00', timestamptz '2025-02-01 10:00+00'),
      ('OfOperator',  timestamptz '2025-04-01 08:00+00', timestamptz '2025-04-02 08:00+00'),
      ('WithNote',    timestamptz '2025-05-01 08:00+00', timestamptz '2025-06-15 12:00+00'),
      ('NoDates',     timestamptz '2025-07-01 09:00+00', timestamptz '2025-08-01 09:00+00')
    ) as e(last_name, acquired_at, last_interaction_at)
    join public.contacts c on c.last_name = e.last_name
    join public.lead_profiles lp on lp.contact_id = c.id
   where lp.acquired_at <> e.acquired_at
      or lp.last_interaction_at is distinct from e.last_interaction_at
      or lp.operational_status <> 'active'
      or lp.do_not_contact
      or lp.next_action_at is not null;
  if v_bad is not null then
    raise exception 'backfilled lead profiles hold the wrong values: %', v_bad;
  end if;
end
$$;

-- 3c. The operator can now record an opt-out for their own legacy contact, and
--     still cannot touch the administrator's. Before the fix the first update
--     matched zero rows and nothing could create the row.
create temporary table upgrade_consent_probe (target text, updated bigint) on commit drop;
grant insert, select on upgrade_consent_probe to authenticated;

select pg_temp.act_as('operator@upgrade.test');
with u as (update public.lead_profiles set do_not_contact = true
            where contact_id = (select id from public.contacts where last_name = 'OfOperator')
            returning 1)
insert into upgrade_consent_probe select 'own', count(*) from u;
with u as (update public.lead_profiles set do_not_contact = true
            where contact_id = (select id from public.contacts where last_name = 'WithDates')
            returning 1)
insert into upgrade_consent_probe select 'other', count(*) from u;
insert into upgrade_consent_probe
  select 'visible', count(*) from public.lead_profiles;
reset role;

do $$
begin
  if (select updated from upgrade_consent_probe where target = 'own') <> 1 then
    raise exception 'the operator cannot record do_not_contact for their own legacy contact';
  end if;
  if (select updated from upgrade_consent_probe where target = 'other') <> 0
     or (select do_not_contact from public.lead_profiles lp
           join public.contacts c on c.id = lp.contact_id
          where c.last_name = 'WithDates') then
    raise exception 'the operator changed the consent flag of a contact they do not own';
  end if;
  -- The operator owns two legacy contacts and sees exactly their two profiles.
  if (select updated from upgrade_consent_probe where target = 'visible') <> 2 then
    raise exception 'the operator sees % lead profiles, expected their own 2',
      (select updated from upgrade_consent_probe where target = 'visible');
  end if;
end
$$;

-- ===========================================================================
-- Phase 3B.1: the deal stage-transition ledger fabricates no history.
-- ===========================================================================

do $$
begin
  -- No legacy deal has an observation: none was backfilled, and the two the
  -- operator renamed in 1d kept their stage, which records nothing.
  if exists (select 1 from public.deal_stage_transitions t
               join public.deals d on d.id = t.deal_id
              where d.name like 'Legacy deal [%') then
    raise exception 'the stage-transition ledger holds history for a legacy deal';
  end if;
  -- The two deals the operator created in 1e, as the browser, each recorded
  -- exactly their entry: the ledger's writer works for a CRM user's write.
  if (select string_agg(d.name || '=' || coalesce(t.from_stage, '()') || '>' || t.to_stage, '; ' order by d.name)
        from public.deal_stage_transitions t join public.deals d on d.id = t.deal_id)
     is distinct from 'New deal [contact_started]=()>contact_started; New deal [default]=()>new_lead' then
    raise exception 'the ledger did not record exactly the two new deals'' entries';
  end if;
end
$$;

rollback;
