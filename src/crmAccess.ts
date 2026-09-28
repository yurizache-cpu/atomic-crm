import type { SupabaseClient } from "@supabase/supabase-js";

import { isPublicAuthPage } from "@/components/atomic-crm/providers/supabase/authProvider";
import { getSupabaseClient } from "@/components/atomic-crm/providers/supabase/supabase";

// Whether the CRM may be shown to the current session (Production Security
// Gate A.1). Convenience only: the database is the authority. Every CRM row
// policy decides through helpers that answer a session below authenticator
// assurance level 2 nothing, so at level 1 the CRM would load empty screens
// and generic errors; this asks the provider whether a second factor is
// missing and, if so, asks the SERVER whether it really refuses this session
// (the caller's own `sales` row is invisible to it). It never grants anything:
// showing the CRM to a session shows it nothing the database does not return,
// and a session the server accepts at level 1 (the local development
// exemption) is not sent through a second factor the server does not need.
//
// It lives beside src/companyOsSession.ts, outside src/company-os (which may
// not import the CRM or Supabase) and outside every registry glob.

export type CrmAccess = "allowed" | "second-factor";

export const createCrmAccessProbe =
  (client: SupabaseClient = getSupabaseClient()) =>
  async (): Promise<CrmAccess> => {
    // A link from an email opens these before any second factor can exist.
    if (isPublicAuthPage()) return "allowed";
    // The level the token states, read locally: no network for the usual case
    // of a session at level 2 or of no session at all (the login page).
    const { data: level, error: levelError } =
      await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (levelError !== null || level.currentLevel !== "aal1") return "allowed";
    const { data, error } = await client.from("sales").select("id").limit(1);
    // A failed question is not a refusal: the CRM's own calls report it.
    if (error !== null) return "allowed";
    return data.length > 0 ? "allowed" : "second-factor";
  };
