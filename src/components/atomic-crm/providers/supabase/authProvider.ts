import type { AuthProvider } from "ra-core";
import { supabaseAuthProvider } from "ra-supabase-core";

import { canAccess } from "../commons/canAccess";
import { QUERY_CACHE_STORAGE_KEY } from "../queryCacheKey";
import { getSupabaseClient } from "./supabase";

const getBaseAuthProvider = () =>
  supabaseAuthProvider(getSupabaseClient(), {
    getIdentity: async () => {
      const sale = await getSale();

      if (sale == null) {
        throw new Error();
      }

      return {
        id: sale.id,
        fullName: `${sale.first_name} ${sale.last_name}`,
        avatar: sale.avatar?.src,
      };
    },
  });

// To speed up checks, we cache the initialization state
// and the current sale in the local storage. They are cleared on logout.
const IS_INITIALIZED_CACHE_KEY = "RaStore.auth.is_initialized";
const CURRENT_SALE_CACHE_KEY = "RaStore.auth.current_sale";

function getLocalStorage(): Storage | null {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

/**
 * The two pages a person reaches with only a link from an email, before any
 * session that could pass the second factor exists: setting a first password
 * and asking for a reset. checkAuth lets them through, and so does the
 * application shell's second-factor gate (src/crmAccess.ts).
 */
export const isPublicAuthPage = () =>
  window.location.pathname === "/set-password" ||
  window.location.hash.includes("#/set-password") ||
  window.location.pathname === "/forgot-password" ||
  window.location.hash.includes("#/forgot-password");

/**
 * The provider holds a session that has not yet passed its second factor. The
 * database answers such a session nothing (Production Security Gate A.1), so
 * the missing sale is not proof of a disabled account.
 */
const sessionAwaitsSecondFactor = async () => {
  const { data, error } =
    await getSupabaseClient().auth.mfa.getAuthenticatorAssuranceLevel();
  return error === null && data.currentLevel === "aal1";
};

export async function getIsInitialized() {
  // Phase 1 removes the public first-user bootstrap. An owner is provisioned
  // through the controlled Supabase/admin procedure documented for deployment.
  // Keeping this function avoids a broad upstream refactor while ensuring the
  // browser never probes a public initialization endpoint.
  return true;
}

const getSale = async () => {
  const storage = getLocalStorage();
  const cachedValue = storage?.getItem(CURRENT_SALE_CACHE_KEY);
  if (cachedValue != null) {
    return JSON.parse(cachedValue);
  }

  const { data: dataSession, error: errorSession } =
    await getSupabaseClient().auth.getSession();

  // Shouldn't happen after login but just in case
  if (dataSession?.session?.user == null || errorSession) {
    return undefined;
  }

  const { data: dataSale, error: errorSale } = await getSupabaseClient()
    .from("sales")
    .select("id, first_name, last_name, avatar, administrator, role, disabled")
    .match({ user_id: dataSession?.session?.user.id })
    .single();

  // Shouldn't happen either as all users are sales but just in case
  if (dataSale == null || errorSale || dataSale.disabled) {
    return undefined;
  }

  storage?.setItem(CURRENT_SALE_CACHE_KEY, JSON.stringify(dataSale));
  return dataSale;
};

function clearCache() {
  const storage = getLocalStorage();
  storage?.removeItem(IS_INITIALIZED_CACHE_KEY);
  storage?.removeItem(CURRENT_SALE_CACHE_KEY);
  // A React Query cache persisted by an EARLIER build. Nothing writes this key
  // any more (the persister was removed, SEC-1BS-01), but a device that ran
  // such a build still holds every contact, note, email and consent flag it
  // viewed. CRM.tsx purges it at startup too. See providers/queryCacheKey.ts.
  storage?.removeItem(QUERY_CACHE_STORAGE_KEY);
}

export const getAuthProvider = (): AuthProvider => {
  const baseAuthProvider = getBaseAuthProvider();
  return {
    ...baseAuthProvider,
    login: async (params) => {
      if (params.ssoDomain) {
        const { error } = await getSupabaseClient().auth.signInWithSSO({
          domain: params.ssoDomain,
        });
        if (error) {
          throw error;
        }
        return;
      }
      return baseAuthProvider.login(params);
    },
    logout: async (params) => {
      clearCache();
      return baseAuthProvider.logout(params);
    },
    checkAuth: async (params) => {
      // Users are on the set-password or forgot-password page, nothing to do
      if (isPublicAuthPage()) return;
      await baseAuthProvider.checkAuth(params);
      if (await getSale()) return;

      // A session still below its second factor is not a disabled account. The
      // application shell asks for the factor (src/crmAccess.ts); ending the
      // session here would make it unreachable.
      if (await sessionAwaitsSecondFactor()) return;

      await getSupabaseClient().auth.signOut();
      throw new Error("Your account is disabled or has not been provisioned.");
    },
    canAccess: async (params) => {
      // Get the current user
      const sale = await getSale();
      if (sale == null) return false;

      // Compute access rights from the sale role
      const role =
        sale.administrator && sale.role === "owner" ? "admin" : "user";
      return canAccess(role, params);
    },
    getAuthorizationDetails(authorizationId: string) {
      return getSupabaseClient().auth.oauth.getAuthorizationDetails(
        authorizationId,
      );
    },
    approveAuthorization(authorizationId: string) {
      return getSupabaseClient().auth.oauth.approveAuthorization(
        authorizationId,
      );
    },
    denyAuthorization(authorizationId: string) {
      return getSupabaseClient().auth.oauth.denyAuthorization(authorizationId);
    },
  };
};
