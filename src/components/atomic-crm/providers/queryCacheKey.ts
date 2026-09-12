/**
 * The localStorage key under which EARLIER BUILDS persisted the React Query
 * cache. Nothing writes it any more.
 *
 * Until the Phase 1B-S closure, `root/CRM.tsx` wrapped the mobile app in a
 * persister that serialised every query the user had viewed — contacts, notes,
 * lead profiles, email addresses, phone numbers, `do_not_contact` state — into
 * this key for 24 hours, surviving browser restarts. For the first tenant, an
 * online psychology clinic, that is other people's clinical data under the
 * LGPD, and no product requirement needed it on disk. The persister is gone
 * (SEC-1BS-01, docs/SECURITY_AUDIT_1BS_REPORT.md); the cache lives in memory.
 *
 * The key survives for one purpose: removing what an earlier build left behind.
 * A device that ran such a build still holds the cache, and with the persister
 * gone nothing reads it back to expire it, so without an explicit removal it
 * would stay forever. It is removed at startup (`purgePersistedQueryCache`,
 * called by `root/CRM.tsx`) and on logout (`providers/supabase/authProvider.ts`).
 */
export const QUERY_CACHE_STORAGE_KEY = "REACT_QUERY_OFFLINE_CACHE";

/**
 * Removes a React Query cache persisted by an earlier build.
 *
 * Touching `localStorage` throws in some contexts (site data disabled, sandboxed
 * frames). Such a context cannot hold a cache this build wrote either, so the
 * error is not rethrown: failing to delete a value that cannot be there must not
 * take the application down with it.
 */
export const purgePersistedQueryCache = (): void => {
  try {
    window.localStorage.removeItem(QUERY_CACHE_STORAGE_KEY);
  } catch {
    // Storage unavailable: see above.
  }
};
