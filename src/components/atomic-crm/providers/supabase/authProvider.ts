import type { AuthProvider } from "ra-core";
import { supabaseAuthProvider } from "ra-supabase-core";

import { canAccess } from "../commons/canAccess";
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
      // Users are on the set-password page, nothing to do
      if (
        window.location.pathname === "/set-password" ||
        window.location.hash.includes("#/set-password")
      ) {
        return;
      }
      // Users are on the forgot-password page, nothing to do
      if (
        window.location.pathname === "/forgot-password" ||
        window.location.hash.includes("#/forgot-password")
      ) {
        return;
      }
      await baseAuthProvider.checkAuth(params);
      if (await getSale()) return;

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
