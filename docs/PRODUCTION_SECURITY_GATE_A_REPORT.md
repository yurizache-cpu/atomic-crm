# Production Security Gate A — report

**Status:** implemented on `feature/production-security-gate-a` (from `feature/clinical-phase-1` at `c4938029`); integrated by one PR into `feature/clinical-phase-1` (the single remote integration cycle).
**What it is:** the repository-controlled security blockers that must be closed before a hosted Company OS could ever be authorized for real clinic data. It enables nothing. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
**Invariants:** SI-73 (PUBLIC helpers), SI-74 (multi-factor assurance), SI-75 (browser policy).

Real patient use now requires both the external authorization (ADR 0020 §C) and these application facts:
- reviewed database helper privileges;
- a trusted authenticated principal holding multi-factor assurance;
- the production browser security policy, served by a host that sends the declared headers.

## 1. What was open

- **PUBLIC helper debt:** PHASE_2B_REPORT R-16 and ADR 0018 amendment 3. PUBLIC, and so every role, the Company OS capability roles included, could execute 21 functions in `public`.
- **Session hardening:** no MFA at the Company OS authority (ADR 0019 residual trust).
- **Browser policy:** no Content-Security-Policy and no security headers anywhere.

## 2. PUBLIC grants (migration `20261004120000_production_security_gate_a.sql`)

Every one of the 21 functions is owned by `postgres`. Each caller was traced in the live policies, views and function bodies, and in the application and edge-function code:

| Functions | Kind | Real callers | Decision |
| --- | --- | --- | --- |
| `can_access_contact`, `can_access_deal`, `can_manage_sales_id`, `current_sales_id`, `is_active_sales_user`, `is_admin` | SECURITY DEFINER, read-only row-security helpers | row-security policies, all `TO authenticated`; each other, inside their DEFINER bodies | `authenticated` only |
| `get_avatar_for_email`, `get_domain_favicon` | INVOKER helpers | the INVOKER triggers that stamp a contact's avatar and a company's logo, so any role that writes contacts or companies | `authenticated` (and `service_role`'s existing explicit grant) |
| `get_note_attachments_function_url` | INVOKER | one SECURITY DEFINER trigger | owner only |
| `merge_contacts(bigint, bigint)` | INVOKER, mutating | none: the browser calls the `merge_contacts` edge function, which merges statement by statement as `authenticated` through the sealed owner-session pool (SI-27) | owner only |
| the other eleven | trigger functions | fired by triggers only (EXECUTE is not checked when a trigger fires) | owner only |

- **Removed:** PUBLIC and `anon` lose all 21. `authenticated` loses `merge_contacts`, `get_note_attachments_function_url` and the 11 trigger functions.
- **Kept:** `authenticated` keeps exactly eight functions, as the declared schema (`supabase/schemas/06_grants.sql`) already intended. `service_role` keeps its explicit grants: it is the backend trust root and bypasses row security (SI-06).
- **Now executed by the Company OS roles:** `ops_worker`, `ops_gateway` and `ops_operator_api` execute nothing in `public`. The P8 pin in `company_os_api.sql` and the K3 pin in `whatsapp_transport.sql` now fail by name if that changes.
- **New functions:** a new `public` function is born without PUBLIC EXECUTE (the `postgres` default privileges, measured).
- **Remaining related debt (not a PUBLIC grant):** `get_avatar_for_email` calls `extensions.http_get` to ask Gravatar for a hash of the email. `service_role` can reach `extensions`, so a contact written by the service-role Postmark path discloses that hash to a third party. This is upstream CRM behaviour and needs an owner decision before real patient data.

## 3. Authentication and session

- **Authority:** Supabase Auth issues the sessions; the CRM's single supabase-js client carries them. `company_os_api` has 21 functions and 21 gates, and every gate resolves its caller through one resolver, `ops.operator_scope()`. Before Gate A it already required:
  - the verified claims;
  - a live `auth.sessions` row, so a sign-out or revocation takes effect on the next call;
  - an account neither banned, deleted nor anonymous;
  - one active membership in an eligible tenant.
- **MFA signal:** the provider's own session row, `auth.sessions.aal`, written by Supabase Auth and never by a request, together with the verified token's `aal` claim.
- **Server enforcement:** `ops.operator_scope()` refuses a session unless both are `aal2` (or higher). The refusal is `OS401`, which every gate already delivers unchanged, so no gate and no browser contract changed. Browser state, request values, legacy per-claim settings and arguments cannot raise either signal.
- **Measured against the local Supabase Auth:** after a TOTP verification through the provider's API, the same session's row and its new token hold `aal2`; the Company OS admits it, and the older `aal1` token stays refused.
- **Non-production path:** a single owner-only row, `ops.operator_assurance_exemption`.
  - No application role can read or write it.
  - The migration asserts it ships no row, and the migrations-only reference-data check proves none exists.
  - Only the local development seed records it, and SI-25 keeps that seed off hosted projects.
- **Browser:** when the provider still holds a session below level 2, the signed-out screen offers the provider's own authenticator-app factor through an optional `MfaPort`:
  - enrolment with the provider's QR code and key, then a 6-digit code;
  - no TOTP computed by the application, no SMS, no second identity store;
  - only the server's next answer grants access.

  Local TOTP is enabled in `supabase/config.toml`.
- **Session findings:**
  - **Revocation:** already effective on the next call. The resolver reads the live session.
  - **Tokens:** the Company OS keeps none. The port carries a user id only, and the query cache is memory-only (SI-19). supabase-js keeps its session in `localStorage` (the provider default); changing that would change the auth system, so it is recorded, not changed. The CSP narrows what could read it.
  - **Development bypass:** none in a production build. The FakeRest demo has no Company OS session, and the exemption lives only in the local seed.

## 4. Browser security policy

`scripts/security-headers.mjs` is the one source:

- **In every production page:** Vite injects a Content-Security-Policy `<meta>` and a strict referrer `<meta>`.
  - `default-src 'self'`
  - `script-src 'self'`
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data: blob:` plus the configured Supabase origin
  - `font-src 'self' data:`
  - `connect-src 'self'` plus the configured Supabase https and wss origins
  - `worker-src 'self'`, `manifest-src 'self'`
  - `frame-src 'none'`, `object-src 'none'`
  - `base-uri 'self'`, `form-action 'self'`
- **Enforced:** the build scan (`scripts/scan-build-artifacts.mjs`, a required CI step) refuses a page without that policy, one weakened by `'unsafe-eval'` or a wildcard, scheme or inline script source, and any inline script on any page. The auth callback page's inline redirect moved to `public/auth-callback.js`, and that page carries its own tight policy.
- **Unsafe exceptions:** one. `style-src 'unsafe-inline'`, because the UI libraries insert `<style>` elements at runtime (six sites measured) and the page carries one inline loader style. It admits styles, never scripts.
- **Blocked on purpose:** the CRM's own browser-side avatar lookups and the upstream telemetry beacon. Each discloses data to a third party; the CRM falls back to initials when they fail.
- **Headers only a host can send:** CSP with `frame-ancestors 'none'`, HSTS, `nosniff`, the referrer policy and a permissions policy. They are declared in `hostedSecurityHeaders()` and served by `vite preview`.
- **Measured in a browser:** the production-mode build ran under both the meta and the header policy. The application works, the configured API is reachable and an off-policy origin is refused.
- **Separation:** the development server has no CSP (it needs inline HMR). Every production build has one, and a build without it fails the scan.

## 5. Remaining major blockers (not closed by this gate)

- **Hosting:** the committed frontend deploy target (GitHub Pages) cannot send response headers. A real-data Company OS needs a host that sends `hostedSecurityHeaders()`, and hosting is undecided.
- **Hosted auth configuration:** a hosted Supabase project must enable TOTP MFA in its own auth settings, must never hold the exemption row, and must never receive the seed (SI-25).
- **CRM data outside the Company OS:** the Atomic CRM's own screens reach contacts through row security with no MFA requirement. Whether the CRM must also require level 2 before real clinic data is an owner decision.
- **The Gravatar disclosure** from service-role contact writes (§2).
- **External Q8 evidence** (ADR 0020 §C) and **production WhatsApp** (ADR 0018), unchanged.

## 6. Validation (local, once at the end)

- New `supabase/tests/production_security.sql`: A (PUBLIC grants), B (MFA), C (exemption). Mutation-checked: removing the assurance check fails B1 by name.
- `test:db`: 24/24 after a clean reset.
- The migrations-only reset plus `referenceData.mjs --without-seed`: PASS (no exemption).
- `test:db:engine`: 403/403.
- The `functions` project: 2211/2211, with security invariants 82/82 and the migration guards green.
- The `app` project: 499 passed, 1 skipped, including the new second-factor browser tests (3) and adapter tests (3).
- The script tests: `security-headers.test.mjs` 8/8. The other failures in that folder fail identically at the base (the local collection issue).
- Upgrade replay: PASS.
- Typecheck green; ESLint 0 errors; build and bundle scan 0 blocking; production scope and signing key OK.
- The live local MFA probe: see §3.
