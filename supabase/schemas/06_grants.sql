--
-- Grants
-- RLS is the row-level boundary. These grants provide only the verbs needed by
-- the browser application; anon receives no access to commercial data.
--

grant usage on schema public to postgres, authenticated, service_role;
revoke usage on schema public from anon;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Browser data access. Policies in 05_policies.sql further constrain every row.
grant select, insert, update, delete on table public.companies to authenticated;
grant select, insert, update, delete on table public.contacts to authenticated;
grant select, insert, update, delete on table public.contact_notes to authenticated;
grant select, insert, update, delete on table public.deals to authenticated;
grant select, insert, update, delete on table public.deal_notes to authenticated;
grant select on table public.sales to authenticated;
grant select, insert, update, delete on table public.tags to authenticated;
grant select, insert, update, delete on table public.tasks to authenticated;
grant select, update on table public.configuration to authenticated;
grant select on table public.favicons_excluded_domains to authenticated;
grant select, update on table public.lead_profiles to authenticated;
grant select, insert, update, delete on table public.acquisition_attributions to authenticated;
grant select, insert, update, delete on table public.loss_reasons to authenticated;

-- Views are read-only API resources. security_invoker views apply the caller's
-- RLS policies on their source tables.
grant select on table public.activity_log to authenticated;
grant select on table public.companies_summary to authenticated;
grant select on table public.contacts_summary to authenticated;

-- Identity sequences require USAGE for inserts performed through PostgREST.
grant usage on sequence public.companies_id_seq to authenticated;
grant usage on sequence public."contactNotes_id_seq" to authenticated;
grant usage on sequence public.contacts_id_seq to authenticated;
grant usage on sequence public."dealNotes_id_seq" to authenticated;
grant usage on sequence public.deals_id_seq to authenticated;
grant usage on sequence public.tags_id_seq to authenticated;
grant usage on sequence public.tasks_id_seq to authenticated;
grant usage on sequence public.acquisition_attributions_id_seq to authenticated;
grant usage on sequence public.loss_reasons_id_seq to authenticated;

-- Policy helper functions are executable by authenticated callers only. The
-- remaining functions are trigger/internal or service-role-only operations.
grant execute on function public.current_sales_id() to authenticated;
grant execute on function public.is_active_sales_user() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.can_manage_sales_id(bigint) to authenticated;
grant execute on function public.can_access_contact(bigint) to authenticated;
grant execute on function public.can_access_deal(bigint) to authenticated;
grant execute on function public.get_user_id_by_email(text) to service_role;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- New objects are private by default. Add explicit grants above when a browser
-- capability is intentionally introduced.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;
