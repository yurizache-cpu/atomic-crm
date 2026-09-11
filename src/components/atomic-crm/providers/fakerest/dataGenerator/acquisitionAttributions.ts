import type { AcquisitionAttribution } from "../../../types";
import type { Db } from "./types";

/**
 * One acquisition attribution per contact, mirroring the acquisition fields
 * the contact already carries — the same relationship `contacts_summary`
 * expresses in Supabase via a LATERAL join. Only the columns the contact
 * actually knows about are populated; the rest stay null, as they would for
 * a lead captured without full campaign parameters.
 */
export const generateAcquisitionAttributions = (
  db: Db,
): AcquisitionAttribution[] => {
  return db.contacts.map((contact, id) => ({
    id,
    contact_id: contact.id,
    acquired_at: contact.acquired_at ?? contact.first_seen,
    source: contact.acquisition_source ?? null,
    medium: contact.acquisition_medium ?? null,
    campaign: contact.acquisition_campaign ?? null,
    campaign_id: null,
    ad_group: null,
    ad_group_id: null,
    ad: null,
    ad_id: null,
    keyword: null,
    match_type: null,
    landing_page: null,
    utm_source: contact.acquisition_source ?? null,
    utm_medium: contact.acquisition_medium ?? null,
    utm_campaign: contact.acquisition_campaign ?? null,
    utm_content: null,
    utm_term: null,
    gclid: null,
  }));
};
