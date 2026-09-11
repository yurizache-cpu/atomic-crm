-- Close the `attachments` storage bucket, and assert it stayed closed.
--
-- WHY THIS IS HAND-WRITTEN (the repo's rule is that migrations are generated):
-- `supabase/schemas/07_storage.sql` expresses the intended state as
--   `update storage.buckets set public = false where id = 'attachments';`
-- That is DML against a data row, and `supabase db diff` emits DDL only. No
-- generated migration can ever carry it, no matter how `[db.migrations]
-- schema_paths` is configured. The documentation claimed the bucket was
-- "deliberately closed" while every database built from migrations had it
-- PUBLIC, with three open `authenticated` policies from
-- `20240730075029_init_db.sql:555-562`. Generating a diff was never going to
-- close that gap; only this file does.
--
-- The trailing assertion is the point: it makes the intended state
-- reproducible from a clean `supabase db reset` and fails loudly if a future
-- change reopens the bucket, instead of letting the docs drift from reality
-- again.

-- 1. Bucket is private. Idempotent; a no-op if the bucket does not exist.
update storage.buckets
set public = false
where id = 'attachments';

-- 2. Drop the upstream blanket policies that let any authenticated user read,
--    write and delete every object in the bucket.
drop policy if exists "Attachments 1mt4rzk_0" on storage.objects;
drop policy if exists "Attachments 1mt4rzk_1" on storage.objects;
drop policy if exists "Attachments 1mt4rzk_3" on storage.objects;

-- 3. Assert the end state. This runs on every `db reset` and every deploy, so
--    the guarantee is enforced by the database rather than by a comment.
do $$
declare
  v_public boolean;
  v_policies integer;
begin
  select public into v_public
  from storage.buckets
  where id = 'attachments';

  -- NULL means the bucket does not exist, which is also an acceptable closed
  -- state; only an existing PUBLIC bucket is a failure.
  if v_public is true then
    raise exception
      'attachments bucket is public; it must be private (see ADR 0011 / Phase 0.5 workstream G)';
  end if;

  select count(*) into v_policies
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and policyname in (
      'Attachments 1mt4rzk_0',
      'Attachments 1mt4rzk_1',
      'Attachments 1mt4rzk_3'
    );

  if v_policies > 0 then
    raise exception
      'upstream blanket attachments policies still present (% found); the bucket is not closed', v_policies;
  end if;
end
$$;
