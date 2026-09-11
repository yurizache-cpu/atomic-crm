--
-- Storage
-- Attachments are intentionally disabled for the clinical commercial CRM.
-- Keep the upstream bucket private so an explicit, audited future opt-in can
-- reuse it without exposing historical objects.
--
-- ⚠️ NOTHING IN THIS FILE REACHES A DATABASE THROUGH `supabase db diff`.
-- The statements below are DML (an UPDATE against a data row) and cross-schema
-- policy drops; the diff tool emits DDL for the declared schema only. This file
-- therefore records INTENT, and the enforcement lives in the hand-written
-- migration `20260911120000_close_attachments_bucket.sql`, which also asserts
-- the end state on every `db reset`. Change both together, or the intent and
-- the database will diverge again — they already did once, and the docs
-- claimed "closed" while every migrated database had the bucket public.
--

update storage.buckets
set public = false
where id = 'attachments';

drop policy if exists "Attachments 1mt4rzk_0" on storage.objects;
drop policy if exists "Attachments 1mt4rzk_1" on storage.objects;
drop policy if exists "Attachments 1mt4rzk_3" on storage.objects;
