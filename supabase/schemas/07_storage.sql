--
-- Storage
-- Attachments are intentionally disabled for the clinical commercial CRM.
-- Keep the upstream bucket private so an explicit, audited future opt-in can
-- reuse it without exposing historical objects.
--

update storage.buckets
set public = false
where id = 'attachments';

drop policy if exists "Attachments 1mt4rzk_0" on storage.objects;
drop policy if exists "Attachments 1mt4rzk_1" on storage.objects;
drop policy if exists "Attachments 1mt4rzk_3" on storage.objects;
