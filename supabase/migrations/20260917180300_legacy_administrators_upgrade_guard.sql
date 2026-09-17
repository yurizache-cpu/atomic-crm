-- Legacy administrators do not lose administration silently, and are not
-- promoted on trust (Phase 1D.2, finding 2).
--
-- Before 20260911232039_pending_delta.sql, public.is_admin() was
-- `administrator = true`. pending_delta added sales.role as
-- `text not null default 'operator'` and made is_admin() also require
-- role = 'owner'. The default filled 'operator' into every existing row, so an
-- upgraded instance kept no administrator at all (measured: every legacy
-- administrator's is_admin() is false, and their Settings update matches zero
-- rows). Those rows are also left in a half state, administrator = true with
-- role = 'operator', which the `users` edge function still trusts for editing
-- other users' accounts (supabase/functions/users/index.ts, patchUser).
--
-- Why they are not promoted automatically: the flag is not trustworthy
-- evidence of ownership. From 20240730075029_init_db.sql until
-- 20241104153231_sales_policies.sql, any authenticated user could update any
-- sales row, their own administrator flag included, and signup was open. The
-- owner is therefore chosen by a person (public.bootstrap_owner, 20260917180200).
--
-- What this migration does:
--   1. If an ACTIVE administrator is waiting and there is NO active owner, it
--      halts the upgrade with an error that names the waiting rows by id (no
--      personal data). A person runs public.bootstrap_owner for the right
--      user and deploys again. Earlier migration files stay applied, because
--      the Supabase CLI commits each file on its own (measured), so the
--      bootstrap function is already there.
--   2. Once an active owner exists, every remaining half-state row becomes a
--      plain operator (administrator = false). That only ever removes a
--      privilege, and each change is recorded in
--      public.owner_provisioning_log. An owner can promote the user again in
--      the application, which sets both columns.
--   3. It raises if any half-state row remains.
--
-- A fresh database has no sales rows, so this is a no-op there. Running it
-- again changes nothing.
-- Runbook: docs/PERMISSIONS.md, "Owner bootstrap".

do $$
declare
  v_waiting text;
begin
  if not exists (
    select 1
      from public.sales
     where role = 'owner'
       and administrator
       and not disabled
  ) then
    select string_agg(format('sales %s (auth user %s)', id, user_id), ', ' order by id)
      into v_waiting
      from public.sales
     where administrator
       and role <> 'owner'
       and not disabled;
    if v_waiting is not null then
      raise exception using
        message = format('upgrade halted: active administrator(s) from before the owner model and no active owner: %s', v_waiting),
        hint = 'A person with the database credential chooses the owner: select public.bootstrap_owner(''<auth user id>'', ''<actor>'', ''<reason>''); then deploys again. The other administrators become operators, and the owner can promote them in the application. See docs/PERMISSIONS.md, "Owner bootstrap".';
    end if;
  end if;
end
$$;

-- One statement, so every demotion and its log row commit together.
do $$
begin
  with demoted as (
    update public.sales
       set administrator = false
     where administrator
       and role <> 'owner'
    returning id, user_id
  )
  insert into public.owner_provisioning_log (sales_id, user_id, action, actor, reason)
  select id,
         user_id,
         'legacy_administrator_demoted',
         'migration 20260917180300',
         'administrator without the owner role after 20260911232039; an owner can promote this user again in the application'
    from demoted;
end
$$;

do $$
declare
  v_half bigint;
begin
  select count(*) into v_half
    from public.sales
   where administrator
     and role <> 'owner';
  if v_half > 0 then
    raise exception '% sales row(s) are still administrators without the owner role', v_half;
  end if;
end
$$;
