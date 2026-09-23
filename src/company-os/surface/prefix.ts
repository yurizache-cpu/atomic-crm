// Which surface a location hash belongs to (docs/PHASE_2C_BRIEF.md §6.2).
//
// `#/company-os` and everything below it is the Company OS; every other hash,
// the CRM's auth routes included (#/set-password, #/forgot-password,
// #/auth-callback, #/oauth/consent, #/login), stays the CRM's, exactly as today.
//
// The pathname is read the way react-router 7's hash history reads it (a
// missing leading slash is added unless the path starts with "."), decoded the
// way its route matching decodes it (decodePath: each segment decoded on its
// own, an encoded "/" kept as "%2F" so it never splits a segment, and the
// whole path left undecoded when any escape is malformed) and compared as its
// routes compare (case-insensitively). So "#/company-os%2Fruns" is one segment
// that is not the prefix, as the Company OS router would find too, and the
// switch never hands a router a path the other router would claim.

export type Surface = "crm" | "company-os";

export const COMPANY_OS_PATH = "/company-os";

/** The router pathname a hash carries: no query, no inner fragment, one leading slash. */
export const hashPathname = (hash: string): string => {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const end = path.search(/[?#]/);
  const pathname = end === -1 ? path : path.slice(0, end);
  return pathname.startsWith("/") || pathname.startsWith(".")
    ? pathname
    : `/${pathname}`;
};

/** react-router's decodePath: per segment, "/" re-encoded, all-or-nothing. */
export const routerDecodedPath = (pathname: string): string => {
  try {
    return pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    // A malformed escape: react-router leaves the whole path undecoded.
    return pathname;
  }
};

export const isCompanyOsHash = (hash: string): boolean => {
  const pathname = routerDecodedPath(hashPathname(hash)).toLowerCase();
  return (
    pathname === COMPANY_OS_PATH || pathname.startsWith(`${COMPANY_OS_PATH}/`)
  );
};

export const surfaceOfHash = (hash: string): Surface =>
  isCompanyOsHash(hash) ? "company-os" : "crm";
