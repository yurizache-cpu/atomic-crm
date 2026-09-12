/**
 * The localStorage key holding the persisted React Query cache.
 *
 * It lives here, on its own, because TWO places must agree about it and they
 * are in different layers: `root/CRM.tsx` writes the cache, and the auth
 * provider has to clear it on logout. When only the writer knew the key, the
 * cache outlived the session.
 *
 * WHAT IS IN IT, and why that matters here: the persister serialises every
 * query React Query has cached — contacts, notes, lead profiles, email
 * addresses, phone numbers, `do_not_contact` state. For the first tenant, an
 * online psychology clinic, that is other people's personal and clinical data
 * under the LGPD. `gcTime` is 24 hours and localStorage survives a browser
 * restart, so without an explicit removal the data stayed on the device long
 * after the user had logged out.
 *
 * `REACT_QUERY_OFFLINE_CACHE` is also the default `createAsyncStoragePersister`
 * would pick. It is passed EXPLICITLY at the call site so that a library
 * default change cannot silently orphan the cache this key is meant to clear.
 */
export const QUERY_CACHE_STORAGE_KEY = "REACT_QUERY_OFFLINE_CACHE";
