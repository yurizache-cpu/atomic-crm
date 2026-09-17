-- An explicit, recorded path to the first CRM owner (Phase 1D.2, finding 2).
--
-- Since 20260911232039_pending_delta.sql, public.is_admin() requires
-- administrator = true AND role = 'owner' AND disabled = false. No code path
-- creates that row:
--   - signup is disabled;
--   - handle_new_user always writes administrator = false, role = 'operator';
--   - authenticated holds only SELECT on sales;
--   - the `users` edge function promotes users only when called by an owner.
-- A fresh deployment therefore has no owner, and neither has an upgraded one
-- (20260917180300 explains why its legacy administrators are not promoted
-- automatically).
--
-- This migration adds the one path that fills that gap, for a PERSON who holds
-- the database credential (the Supabase SQL editor or psql as postgres):
--
--   select public.bootstrap_owner('<auth user id>', '<who>', '<why>');
--
-- The rules:
--   - It works only while no active owner exists. Further owners are promoted
--     by an owner in the application, so two people running this cannot make
--     two owners. The table lock serialises them, and the function refuses to
--     run at any isolation level above READ COMMITTED, where its check could
--     read a snapshot older than the lock.
--   - The user is named by auth user id, never by email or user metadata. It
--     must have a CRM user row that is not disabled, and an auth account that
--     is confirmed, not banned and not deleted.
--   - It sets role and administrator together, the way the users edge function
--     does, and records the act in public.owner_provisioning_log.
--   - No application role can call it: EXECUTE is revoked from PUBLIC, anon,
--     authenticated and service_role. It is SECURITY INVOKER, so even a leaked
--     grant would run with the caller's own (absent) write privilege on sales.
--
-- public.owner_provisioning_log is backend-only: RLS is on with no policy, and
-- no application role holds any privilege on it.
-- Runbook: docs/PERMISSIONS.md, "Owner bootstrap".

create table public.owner_provisioning_log (
    id bigint generated always as identity not null,
    sales_id bigint not null,
    user_id uuid not null,
    action text not null,
    actor text not null,
    reason text not null,
    created_at timestamp with time zone not null default now(),
    constraint owner_provisioning_log_pkey primary key (id),
    constraint owner_provisioning_log_sales_id_fkey foreign key (sales_id) references public.sales (id),
    constraint owner_provisioning_log_action_check check (action in ('bootstrap_owner', 'legacy_administrator_demoted')),
    constraint owner_provisioning_log_actor_check check (btrim(actor) <> '' and length(actor) <= 200),
    constraint owner_provisioning_log_reason_check check (btrim(reason) <> '' and length(reason) <= 500)
);

alter table public.owner_provisioning_log enable row level security;

revoke all on table public.owner_provisioning_log from public, anon, authenticated, service_role;
revoke all on sequence public.owner_provisioning_log_id_seq from public, anon, authenticated, service_role;

create or replace function public.bootstrap_owner(p_user_id uuid, p_actor text, p_reason text)
 returns bigint
 language plpgsql
 set search_path to ''
as $function$
declare
  v_sales_id bigint;
  v_disabled boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'bootstrap_owner must run at READ COMMITTED, not %',
      current_setting('transaction_isolation');
  end if;
  if p_user_id is null
     or coalesce(btrim(p_actor), '') = ''
     or coalesce(btrim(p_reason), '') = '' then
    raise exception 'bootstrap_owner needs an auth user id, an actor and a reason';
  end if;

  -- Serialises two bootstraps, and any concurrent write to sales, so the check
  -- below reads the state this update commits into. Held until commit.
  lock table public.sales in share row exclusive mode;

  if exists (
    select 1
      from public.sales s
     where s.role = 'owner'
       and s.administrator
       and not s.disabled
  ) then
    raise exception 'an active owner already exists; further owners are promoted by an owner in the application';
  end if;

  select s.id, s.disabled
    into v_sales_id, v_disabled
    from public.sales s
   where s.user_id = p_user_id;
  if v_sales_id is null then
    raise exception 'no CRM user belongs to auth user %', p_user_id;
  end if;
  if v_disabled then
    raise exception 'CRM user % is disabled', v_sales_id;
  end if;
  if not exists (
    select 1
      from auth.users u
     where u.id = p_user_id
       and u.email_confirmed_at is not null
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  ) then
    raise exception 'auth user % is unconfirmed, banned or deleted', p_user_id;
  end if;

  update public.sales
     set role = 'owner',
         administrator = true
   where id = v_sales_id;

  insert into public.owner_provisioning_log (sales_id, user_id, action, actor, reason)
  values (v_sales_id, p_user_id, 'bootstrap_owner', btrim(p_actor), btrim(p_reason));

  return v_sales_id;
end;
$function$
;

revoke all on function public.bootstrap_owner(uuid, text, text) from public, anon, authenticated, service_role;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(v_role, 'public.bootstrap_owner(uuid, text, text)', 'execute') then
      raise exception '% can execute public.bootstrap_owner: only a person with the database credential may', v_role;
    end if;
    if has_table_privilege(v_role, 'public.owner_provisioning_log', 'select, insert, update, delete, truncate, references, trigger')
       or has_sequence_privilege(v_role, 'public.owner_provisioning_log_id_seq', 'usage, select, update') then
      raise exception '% holds a privilege on public.owner_provisioning_log', v_role;
    end if;
  end loop;

  if exists (
    select 1
      from pg_proc p
     where p.oid = 'public.bootstrap_owner(uuid, text, text)'::regprocedure
       and (p.prosecdef or p.proacl is null)
  ) then
    raise exception 'public.bootstrap_owner must be SECURITY INVOKER with an explicit ACL';
  end if;

  if not exists (
    select 1
      from pg_class c
     where c.oid = 'public.owner_provisioning_log'::regclass
       and c.relrowsecurity
  ) then
    raise exception 'public.owner_provisioning_log has row level security disabled';
  end if;
end
$$;
