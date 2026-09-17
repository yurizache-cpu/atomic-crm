-- Every contact has exactly one lead profile, legacy contacts included
-- (Phase 1D.2, finding 3).
--
-- 20260911232039_pending_delta.sql created public.lead_profiles and an AFTER
-- INSERT trigger on contacts that creates a profile for each NEW contact. It
-- never created one for the contacts an instance already had. Measured on an
-- upgraded database (docs/PHASE_1D2_REPORT.md):
--   - contacts_summary shows no acquisition date, status or consent flag for
--     those contacts;
--   - `authenticated` holds UPDATE but no INSERT on lead_profiles, so the
--     application can never create the missing row. An update of
--     do_not_contact matches zero rows, so a contact's LGPD opt-out cannot be
--     recorded at all.
--
-- Values: the ones the profile would hold had the trigger and the note trigger
-- existed when the contact was created.
--   - acquired_at: first_seen, as the insert trigger uses it. When first_seen is
--     empty, the earliest evidence the row carries (last_seen or its first note)
--     is used instead of the upgrade time. The upgrade time would date a legacy
--     contact after its own interactions. now() is the last resort, as in the
--     trigger.
--   - last_interaction_at: the later of last_seen and the latest note date.
--     handle_contact_note_created_or_updated keeps it at the latest note date,
--     and the legacy note trigger only exists since 20260127140209 and never
--     moved an empty last_seen, so last_seen alone can be older than the notes.
--   - every other column keeps its table default: operational_status 'active',
--     do_not_contact false. The legacy schema had no consent flag to carry over.
--
-- Additive and idempotent. A contact that already has a profile is skipped, so
-- existing profile data is never touched, and running this again inserts
-- nothing. NOT EXISTS keeps identity values from being spent on skipped rows,
-- and ON CONFLICT covers a concurrent insert. A profile belongs to its own
-- contact through contact_id, and RLS scopes it through that contact
-- (can_access_contact), so no row can be attached across an ownership boundary.
-- The block raises if any contact is still without a profile.

insert into public.lead_profiles (contact_id, acquired_at, last_interaction_at)
select c.id,
       coalesce(c.first_seen, least(c.last_seen, n.first_note_at), now()),
       greatest(c.last_seen, n.last_note_at)
  from public.contacts c
  left join lateral (
         select min(cn.date) as first_note_at,
                max(cn.date) as last_note_at
           from public.contact_notes cn
          where cn.contact_id = c.id
       ) n on true
 where not exists (
         select 1 from public.lead_profiles lp where lp.contact_id = c.id
       )
on conflict (contact_id) do nothing;

do $$
declare
  v_missing bigint;
begin
  select count(*) into v_missing
    from public.contacts c
   where not exists (
           select 1 from public.lead_profiles lp where lp.contact_id = c.id
         );
  if v_missing > 0 then
    raise exception '% contact(s) still have no lead profile after the legacy backfill', v_missing;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.lead_profiles'::regclass
       and conname = 'lead_profiles_contact_id_key'
       and contype = 'u'
  ) then
    raise exception 'lead_profiles.contact_id is no longer unique, so a contact could hold two profiles';
  end if;
end
$$;
