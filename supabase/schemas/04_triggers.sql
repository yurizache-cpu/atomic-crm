--
-- Triggers
-- This file declares all triggers.
--

-- Auto-populate sales_id from current auth user on insert
create or replace trigger set_company_sales_id_trigger
    before insert on public.companies
    for each row execute function public.set_sales_id_default();

create or replace trigger set_contact_sales_id_trigger
    before insert on public.contacts
    for each row execute function public.set_sales_id_default();

create or replace trigger set_contact_notes_sales_id_trigger
    before insert on public.contact_notes
    for each row execute function public.set_sales_id_default();

create or replace trigger set_deal_sales_id_trigger
    before insert on public.deals
    for each row execute function public.set_sales_id_default();

create or replace trigger synchronize_deal_pipeline_trigger
    before insert or update on public.deals
    for each row execute function public.synchronize_deal_pipeline();

-- Phase 3B.1: each observed stage entry or change, in the deal write's own
-- transaction (AFTER, so only a write that happens is observed).
create or replace trigger record_deal_stage_transition_trigger
    after insert or update on public.deals
    for each row execute function public.record_deal_stage_transition();

create or replace trigger deal_stage_transitions_append_only_trigger
    before update or delete on public.deal_stage_transitions
    for each row execute function public.deal_stage_transitions_append_only();

-- ADR 0026 §C: every change of the opt-out flag, with its origin, in the
-- profile write's own transaction; the ledger is append-only.
create or replace trigger record_lead_consent_change_trigger
    after insert or update of do_not_contact on public.lead_profiles
    for each row execute function public.record_lead_consent_change();

create or replace trigger lead_consent_changes_append_only_trigger
    before update or delete on public.lead_consent_changes
    for each row execute function public.lead_consent_changes_append_only();

create or replace trigger lead_consent_changes_refuse_truncate_trigger
    before truncate on public.lead_consent_changes
    for each statement execute function public.lead_consent_changes_append_only();

create or replace trigger set_deal_notes_sales_id_trigger
    before insert on public.deal_notes
    for each row execute function public.set_sales_id_default();

create or replace trigger set_task_sales_id_trigger
    before insert on public.tasks
    for each row execute function public.set_sales_id_default();

-- Lowercase contact emails before insert or update
create or replace trigger "10_lowercase_contact_emails"
    before insert or update on public.contacts
    for each row execute function public.lowercase_email_jsonb();

-- No automatic avatar or favicon enrichment (Production Security Gate A.1,
-- 20261005120000_production_security_gate_a1.sql): saving a contact or a company
-- sends nothing to a third party, and no trigger stamps a stored avatar or logo.

-- Update contact.last_seen when a contact note is created
create or replace trigger on_public_contact_notes_created_or_updated
    after insert on public.contact_notes
    for each row execute function public.handle_contact_note_created_or_updated();

-- The clinical configuration keeps note attachments disabled. The upstream
-- cleanup function remains isolated for a future opt-in restoration, but no
-- attachment-triggered network call is installed in this profile.

create or replace trigger create_lead_profile_after_contact_insert
    after insert on public.contacts
    for each row execute function public.create_lead_profile_for_contact();

create or replace trigger set_lead_profile_updated_at_trigger
    before update on public.lead_profiles
    for each row execute function public.set_lead_profile_updated_at();

-- Auth triggers: sync auth.users to public.sales
create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

create or replace trigger on_auth_user_updated
    after update on auth.users
    for each row execute function public.handle_update_user();
