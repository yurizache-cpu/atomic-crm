import type { LeadProfile } from "../../../types";
import type { Db } from "./types";

/**
 * One lead profile per contact, mirroring the commercial fields the contact
 * already carries. In Supabase those fields reach the contact through the
 * `contacts_summary` view, which joins `lead_profiles` — so generating them
 * from the contact keeps the demo database internally consistent instead of
 * inventing a second, conflicting source of truth.
 */
export const generateLeadProfiles = (db: Db): LeadProfile[] => {
  return db.contacts.map((contact, id) => ({
    id,
    contact_id: contact.id,
    acquired_at: contact.acquired_at ?? contact.first_seen,
    last_interaction_at: contact.last_interaction_at ?? contact.last_seen,
    next_action_at: contact.next_action_at ?? null,
    operational_status: contact.operational_status ?? "active",
    do_not_contact: contact.do_not_contact ?? false,
    created_at: contact.first_seen,
    updated_at: contact.last_seen,
  }));
};
