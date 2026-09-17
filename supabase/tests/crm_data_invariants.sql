-- CRM data invariants that the Phase 1D.2 backfills established and that the
-- application relies on, checked on whatever data the database holds.
--
--   1. Every contact has exactly one lead profile. Without one, the contact's
--      do_not_contact flag cannot be recorded at all: authenticated holds no
--      INSERT on lead_profiles (20260917180100).
--   2. Every deal's stage equals its pipeline_stage. The board reads
--      pipeline_stage and synchronize_deal_pipeline() copies it over stage on
--      every write, so a row where they differ loses its stage on its next
--      edit (20260917180000).
--   3. Both triggers that keep 1 and 2 true on new rows are present and on.
--
-- A trigger switched off, or a restore run with triggers disabled, can break
-- 1 or 2 without any statement naming it; this suite is where that shows.
-- The upgrade replay (npm run test:db:upgrade) proves the backfills on legacy
-- data; this proves the invariant on the database under test.
--
-- HOW IT RUNS: npm run test:db. One transaction ending in ROLLBACK.

\set ON_ERROR_STOP on

begin;

do $$
declare
  v_bad text;
begin
  -- 3. The triggers exist and fire.
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.contacts'::regclass
                    and tgname = 'create_lead_profile_after_contact_insert'
                    and tgenabled = 'O') then
    raise exception 'create_lead_profile_after_contact_insert is missing or not enabled';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.deals'::regclass
                    and tgname = 'synchronize_deal_pipeline_trigger'
                    and tgenabled = 'O') then
    raise exception 'synchronize_deal_pipeline_trigger is missing or not enabled';
  end if;

  -- Positive control: the data below is not vacuously empty.
  insert into public.contacts (first_name, last_name)
  values ('Invariant', 'Probe');
  insert into public.deals (name, contact_ids, "index")
  values ('Invariant probe deal', '{}', 0);

  -- 1. One profile per contact.
  select string_agg(format('contact %s has %s', c.id, coalesce(n.profiles, 0)), ', ')
    into v_bad
    from public.contacts c
    left join (select contact_id, count(*) as profiles
                 from public.lead_profiles
                group by contact_id) n
      on n.contact_id = c.id
   where coalesce(n.profiles, 0) <> 1;
  if v_bad is not null then
    raise exception 'contacts without exactly one lead profile: %', v_bad;
  end if;

  -- 2. Stage and pipeline stage agree.
  select string_agg(format('deal %s: %s/%s', id, stage, pipeline_stage), ', ')
    into v_bad
    from public.deals
   where stage is distinct from pipeline_stage;
  if v_bad is not null then
    raise exception 'deals whose stage and pipeline_stage disagree: %', v_bad;
  end if;

  if (select count(*) from public.contacts) = 0
     or (select count(*) from public.deals) = 0 then
    raise exception 'the positive control rows are missing';
  end if;
end
$$;

rollback;
