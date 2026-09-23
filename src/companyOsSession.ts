import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { getAuthProvider } from "@/components/atomic-crm/providers/supabase/authProvider";
import { getSupabaseClient } from "@/components/atomic-crm/providers/supabase/supabase";

import { COMPANY_OS_API_SCHEMA } from "../contracts/company-os-api/index.ts";
import type { SessionPort, SessionUser } from "./company-os/ports";

// The one SessionPort implementation (docs/PHASE_2C_BRIEF.md §6.2, OD-10):
// the CRM's own supabase-js client, never a second createClient. It lives here,
// outside src/company-os (which may not import @supabase/* or the CRM) and
// outside every registry glob, and src/App.tsx builds it only when the Company
// OS mounts.
//
// Nothing of supabase-js crosses the port: a user id instead of a session (no
// token, no email), an event name, and for a failed call the error's code
// alone (the server's message, details and hint stay behind).

/** What the port is built over: the CRM's client and the CRM's own logout. */
export interface SessionPortDependencies {
  readonly client: SupabaseClient;
  /** Ends the session as every CRM sign-out does; rejects when it could not. */
  readonly logout: () => Promise<unknown>;
}

const crmDependencies = (): SessionPortDependencies => ({
  client: getSupabaseClient(),
  // The CRM's logout (authProvider.ts) first drops the CRM's cached identity,
  // the sale row with its administrator and role hint, and then ends the
  // supabase-js session. Ending the session alone would leave that row for the
  // next person who signs in on this browser: the CRM would read it back as
  // theirs.
  logout: () => getAuthProvider().logout({}),
});

const userOf = (session: Session | null): SessionUser | null =>
  session === null ? null : { userId: session.user.id };

export const createSupabaseSessionPort = (
  { client, logout }: SessionPortDependencies = crmDependencies(),
): SessionPort => ({
  async currentUser() {
    try {
      // The stored session, refreshed when expired; a failed refresh is none.
      const { data, error } = await client.auth.getSession();
      return error === null ? userOf(data.session) : null;
    } catch {
      return null;
    }
  },

  onAuthStateChange(listener) {
    let active = true;
    const { data } = client.auth.onAuthStateChange((event, session) => {
      const user = event === "SIGNED_OUT" ? null : userOf(session);
      // supabase-js calls this while holding its auth lock. Delivered on a
      // later task, a listener that makes the next call read the session
      // cannot wait on the lock it was called under.
      setTimeout(() => {
        if (active) listener(event, user);
      }, 0);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  },

  async signOut() {
    try {
      await logout();
    } catch {
      throw new Error("The session could not be ended.");
    }
  },

  async rpc(operation, args, signal) {
    // PostgREST's rpc() is a POST, so no response enters the HTTP cache.
    const call = client.schema(COMPANY_OS_API_SCHEMA).rpc(operation, args);
    const { data, error } = await (signal === undefined
      ? call
      : call.abortSignal(signal));
    return {
      data,
      error:
        error === null
          ? null
          : { code: typeof error.code === "string" ? error.code : "" },
    };
  },
});
