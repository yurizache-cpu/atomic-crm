-- The upgrade halted where it must (scripts/run-db-upgrade-test.mjs, Phase 1D.2).
--
-- Runs right after the first `supabase migration up`, which the owner guard
-- (20260917180300) stopped because the legacy fixture holds active
-- administrators and no owner. Proves the halt left the database in the state
-- the runbook describes: everything before the guard applied, the bootstrap
-- function available, nothing promoted, nothing demoted.

\set ON_ERROR_STOP on

begin;

do $$
begin
  if (select max(version) from supabase_migrations.schema_migrations) <> '20260917180200' then
    raise exception 'the upgrade stopped at %, expected right after 20260917180200_owner_bootstrap',
      (select max(version) from supabase_migrations.schema_migrations);
  end if;
  if to_regprocedure('public.bootstrap_owner(uuid, text, text)') is null then
    raise exception 'the upgrade halted without the bootstrap function a person needs to continue';
  end if;
  if exists (select 1 from public.sales where role = 'owner') then
    raise exception 'an owner exists before any person chose one';
  end if;
  if (select count(*) from public.sales where administrator and not disabled) <> 2
     or (select count(*) from public.sales where administrator) <> 3 then
    raise exception 'the halted upgrade changed the legacy administrator flags';
  end if;
  if exists (select 1 from public.owner_provisioning_log) then
    raise exception 'the halted upgrade recorded an owner change';
  end if;
end
$$;

rollback;
