-- Legacy data for the upgrade replay (scripts/run-db-upgrade-test.mjs).
--
-- Loaded into a database migrated ONLY up to 20260911130000, the last migration
-- before 20260911232039_pending_delta.sql: the schema of an upstream Atomic CRM
-- instance that has not yet taken the clinic pipeline, the owner/operator role
-- model or lead profiles. Everything the upgrade must carry is described here,
-- and the expected post-upgrade value of each row is encoded IN the row (a deal's
-- name carries its legacy stage, a user's email its legacy role), so the
-- assertions need no side table that a later migration could trip over.
--
-- Deliberately NOT one transaction ending in rollback, unlike supabase/tests/*.sql:
-- the rows must survive for `supabase migration up` to upgrade them. The runner
-- resets the database first and a clean reconstruction follows it in CI.
--
-- Synthetic data only (BASELINE Q8): no real person, message or health data.

\set ON_ERROR_STOP on

begin;

-- Guard: this file describes the pre-upgrade schema. Loaded anywhere else it
-- would measure nothing, so refuse instead of passing for the wrong reason.
do $$
begin
  if (select max(version) from supabase_migrations.schema_migrations) <> '20260911130000' then
    raise exception 'legacy fixture must load at 20260911130000, the database is at %',
      (select max(version) from supabase_migrations.schema_migrations);
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'sales' and column_name = 'role')
     or to_regclass('public.lead_profiles') is not null then
    raise exception 'legacy fixture found post-upgrade objects: the reset did not stop before pending_delta';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Users, created through public.handle_new_user exactly as a real signup was:
-- in the legacy model the FIRST signup becomes the administrator and every
-- later one does not. Order matters, so one statement per user.
-- ---------------------------------------------------------------------------

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','first-admin@upgrade.test','x',now(),now(),now(),'{}',
        '{"first_name":"First","last_name":"Admin"}');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','operator@upgrade.test','x',now(),now(),now(),'{}',
        '{"first_name":"Plain","last_name":"Operator"}');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','promoted-admin@upgrade.test','x',now(),now(),now(),'{}',
        '{"first_name":"Promoted","last_name":"Admin"}');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','disabled-admin@upgrade.test','x',now(),now(),now(),'{}',
        '{"first_name":"Disabled","last_name":"Admin"}');

-- A user whose metadata CLAIMS administration. The legacy trigger never read it;
-- the upgrade must not start trusting it either.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
values ('10000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000000',
        'authenticated','authenticated','claims-owner@upgrade.test','x',now(),now(),now(),'{}',
        '{"first_name":"Claims","last_name":"Owner","administrator":true,"role":"owner"}');

-- The legacy `users` edge function (service role) is the only writer of
-- `administrator` after signup: it promoted one user and disabled another.
update public.sales set administrator = true
 where email = 'promoted-admin@upgrade.test';
update public.sales set administrator = true, disabled = true
 where email = 'disabled-admin@upgrade.test';

-- ---------------------------------------------------------------------------
-- CRM data owned by two different sales users.
-- ---------------------------------------------------------------------------

insert into public.companies (name, sales_id)
select 'Legacy Company', id from public.sales where email = 'first-admin@upgrade.test';

insert into public.contacts (first_name, last_name, sales_id, company_id,
                             first_seen, last_seen, has_newsletter, status)
select v.first_name, v.last_name, s.id, c.id, v.first_seen, v.last_seen, v.has_newsletter, v.status
from (values
  ('Legacy', 'WithDates',   'first-admin@upgrade.test', timestamptz '2025-01-10 09:00+00', timestamptz '2025-03-01 10:00+00', true,  'warm'),
  ('Legacy', 'NoFirstSeen', 'first-admin@upgrade.test', null::timestamptz,                  timestamptz '2025-02-01 10:00+00', false, 'cold'),
  ('Legacy', 'OfOperator',  'operator@upgrade.test',    timestamptz '2025-04-01 08:00+00', timestamptz '2025-04-02 08:00+00', null,  'hot'),
  ('Legacy', 'WithNote',    'operator@upgrade.test',    timestamptz '2025-05-01 08:00+00', timestamptz '2025-05-01 08:00+00', false, 'warm'),
  ('Legacy', 'NoDates',     'first-admin@upgrade.test', null::timestamptz,                  null::timestamptz,                  null,  null)
) as v(first_name, last_name, owner_email, first_seen, last_seen, has_newsletter, status)
join public.sales s on s.email = v.owner_email
cross join (select id from public.companies where name = 'Legacy Company') c;

-- Pin the dates explicitly, so the upgrade is measured against KNOWN values
-- whatever a legacy trigger did on insert.
update public.contacts set first_seen = timestamptz '2025-01-10 09:00+00', last_seen = timestamptz '2025-03-01 10:00+00' where last_name = 'WithDates';
update public.contacts set first_seen = null,                              last_seen = timestamptz '2025-02-01 10:00+00' where last_name = 'NoFirstSeen';
update public.contacts set first_seen = timestamptz '2025-04-01 08:00+00', last_seen = timestamptz '2025-04-02 08:00+00' where last_name = 'OfOperator';
update public.contacts set first_seen = timestamptz '2025-05-01 08:00+00', last_seen = timestamptz '2025-05-01 08:00+00' where last_name = 'WithNote';
update public.contacts set first_seen = null,                              last_seen = null                              where last_name = 'NoDates';

-- A note moves last_seen forward through the legacy note trigger...
insert into public.contact_notes (contact_id, text, date, sales_id, status)
select c.id, 'Synthetic legacy note', timestamptz '2025-06-15 12:00+00', c.sales_id, 'warm'
from public.contacts c where c.last_name = 'WithNote';

-- ...but never an EMPTY last_seen (`last_seen < date` is null). Two notes on a
-- contact with no dates at all: the profile must still learn from them.
insert into public.contact_notes (contact_id, text, date, sales_id, status)
select c.id, v.text, v.date, c.sales_id, 'cold'
from public.contacts c
cross join (values
  ('Synthetic first note',  timestamptz '2025-07-01 09:00+00'),
  ('Synthetic second note', timestamptz '2025-08-01 09:00+00')
) as v(text, date)
where c.last_name = 'NoDates';

-- ---------------------------------------------------------------------------
-- Deals in every upstream Atomic CRM stage, one custom stage an admin added in
-- Settings, and one empty stage. The name carries the legacy stage.
-- updated_at is pinned: the upgrade must not rewrite it.
-- ---------------------------------------------------------------------------

insert into public.deals (name, stage, sales_id, company_id, contact_ids, amount,
                          category, "index", created_at, updated_at)
select 'Legacy deal [' || v.stage || ']', v.stage, s.id, c.id, '{}', v.amount,
       'ui-design', v.idx, timestamptz '2025-01-01 00:00+00', timestamptz '2025-02-02 00:00+00'
from (values
  ('opportunity',    'first-admin@upgrade.test', 1000, 0),
  ('proposal-sent',  'first-admin@upgrade.test', 2000, 0),
  ('in-negociation', 'operator@upgrade.test',    3000, 0),
  ('won',            'operator@upgrade.test',    4000, 0),
  ('lost',           'first-admin@upgrade.test', 5000, 0),
  ('delayed',        'operator@upgrade.test',    6000, 0),
  ('qualified',      'first-admin@upgrade.test', 7000, 0),
  ('',               'operator@upgrade.test',    8000, 0)
) as v(stage, owner_email, amount, idx)
join public.sales s on s.email = v.owner_email
cross join (select id from public.companies where name = 'Legacy Company') c;

-- The tenant's own Settings: the legacy stages, stored as data.
update public.configuration
   set config = jsonb_build_object('dealStages', jsonb_build_array(
         jsonb_build_object('value', 'opportunity',    'label', 'Opportunity'),
         jsonb_build_object('value', 'proposal-sent',  'label', 'Proposal Sent'),
         jsonb_build_object('value', 'in-negociation', 'label', 'In Negotiation'),
         jsonb_build_object('value', 'won',            'label', 'Won'),
         jsonb_build_object('value', 'lost',           'label', 'Lost'),
         jsonb_build_object('value', 'delayed',        'label', 'Delayed'),
         jsonb_build_object('value', 'qualified',      'label', 'Qualified')))
 where id = 1;

-- Positive control: the fixture really holds what the assertions will look for.
do $$
begin
  if (select count(*) from public.sales where email like '%@upgrade.test') <> 5
     or (select count(*) from public.sales where administrator) <> 3
     or (select count(*) from public.sales where administrator and not disabled) <> 2
     or (select count(*) from public.contacts where last_name in ('WithDates', 'NoFirstSeen', 'OfOperator', 'WithNote', 'NoDates')) <> 5
     or (select count(*) from public.deals where name like 'Legacy deal [%') <> 8
     or (select administrator from public.sales where email = 'first-admin@upgrade.test') is not true
     or (select administrator from public.sales where email = 'claims-owner@upgrade.test') is not false
     or (select last_seen from public.contacts where last_name = 'WithNote') <> timestamptz '2025-06-15 12:00+00'
     or (select last_seen from public.contacts where last_name = 'NoDates') is not null
  then
    raise exception 'legacy fixture did not produce the expected pre-upgrade state';
  end if;
end
$$;

commit;
