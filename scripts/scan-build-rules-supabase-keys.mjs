// Build scanner rules (scripts/scan-build-artifacts.mjs): the Supabase
// secret key, and JWTs whose role claim is not the public anon role. The
// public API key, in either of its formats, is meant to be in the bundle.

/**
 * Roles that must never appear as a JWT `role` claim in a browser artifact:
 * the platform's administrative roles and every Company OS role. A token that
 * names one was signed for a server-side caller. The Supabase admin roles are
 * the ones the S0.2 spike measured holding CREATEROLE or reaching
 * `ops_operator_api` (S0-G); `authenticator` is the role PostgREST logs in as.
 */
const FORBIDDEN_JWT_ROLES = new Set([
  "service_role",
  "supabase_admin",
  "postgres",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "authenticator",
  "ops_worker",
  "ops_gateway",
  "ops_operator_api",
]);

/**
 * The one JWT role a bundle legitimately carries: the legacy public API key
 * (`VITE_SUPABASE_ANON_KEY`). Its new-format twin is `sb_publishable_…`.
 */
const PUBLIC_JWT_ROLE = "anon";
const PUBLISHABLE_KEY_PREFIX = "sb_publishable_";

const decodeJwtRole = (token) => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    const role = JSON.parse(json).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
};

/** The public API key, in either of its formats: meant to be in the bundle. */
export const isPublicApiKey = (value) =>
  value.startsWith(PUBLISHABLE_KEY_PREFIX) ||
  decodeJwtRole(value) === PUBLIC_JWT_ROLE;

/** The Supabase secret key, then every JWT whose role claim is not anon. */
export const SUPABASE_KEY_RULES = [
  {
    id: "supabase-secret-key",
    severity: "critical",
    pattern: /sb_secret_[A-Za-z0-9_-]{8,}/g,
    describe: () => "Supabase secret key (sb_secret_…)",
  },
  {
    id: "privileged-jwt",
    severity: "critical",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g,
    verify: (m) => FORBIDDEN_JWT_ROLES.has(decodeJwtRole(m) ?? ""),
    describe: (m) => `JWT whose role claim is "${decodeJwtRole(m)}"`,
  },
  {
    id: "non-anon-jwt",
    severity: "high",
    // Any other role claim but `anon`. An `authenticated` token is a signed-in
    // person's session: the SPA receives one from GoTrue at runtime and never
    // needs one in its code, so a literal one is somebody's live session baked
    // into a static file. Any other role is refused too, because PostgREST
    // switches to whatever role a trusted token names, so an unknown role is
    // not known to be harmless. A token with no role claim is left alone:
    // PostgREST treats it as anon. Measured 2026-09-23: 0 in the build, 0 in
    // all of node_modules (48,371 text files).
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g,
    verify: (m) => {
      const role = decodeJwtRole(m);
      return (
        role !== null &&
        role !== PUBLIC_JWT_ROLE &&
        !FORBIDDEN_JWT_ROLES.has(role)
      );
    },
    describe: (m) => `JWT whose role claim is "${decodeJwtRole(m)}", not anon`,
  },
];
