# Production Security Gate A — report

**Status: PRODUCTION SECURITY GATE A: INTEGRATED WITH A.1 CORRECTION PENDING.**
- **Gate A (§1–§6) is integrated:** PR #19, normal merge `234f7a895ee2a71118c346a757da23150d7ff475` into `feature/clinical-phase-1` (parents `c4938029` and `f17c306e`). The source branch `feature/production-security-gate-a` is retained at `f17c306ea144604028c5b76a124b78a4bffa8e35`, and `main` is unchanged at `a863e2a084fae8c7adf7a2efc547ad7ce38e699b`.
- **Post-merge CI:** Test, Build, Typecheck, ESLint and Database security & reproducibility PASS. The workflow stays red only for the accepted historical baseline: e2e exactly 9 failed and 1 skipped, and Prettier exactly 2 errors. No new regression.
- **Two repository-controlled gaps remained**, and are closed by **A.1 (§7)**, implemented on `feature/production-security-gate-a1` (from `feature/clinical-phase-1` at `234f7a89`) for one PR into `feature/clinical-phase-1`: the automatic third-party avatar and favicon enrichment (§2, §4, §5 below record the state Gate A left), and multi-factor assurance only at the Company OS (§3, §5). "Gate A: COMPLETE" is recorded only after A.1 is integrated.

**What it is:** the repository-controlled security blockers that must be closed before a hosted Company OS could ever be authorized for real clinic data. It enables nothing. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**
**Invariants:** SI-73 (PUBLIC helpers, and no cosmetic third-party egress since A.1), SI-74 (multi-factor assurance, the CRM included since A.1), SI-75 (browser policy).

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
- **Kept:** `authenticated` kept exactly eight functions, as the declared schema (`supabase/schemas/06_grants.sql`) already intended. *(A.1 removed the two avatar and favicon functions, so it is now exactly six; §7.)* `service_role` keeps its explicit grants: it is the backend trust root and bypasses row security (SI-06).
- **Now executed by the Company OS roles:** `ops_worker`, `ops_gateway` and `ops_operator_api` execute nothing in `public`. The P8 pin in `company_os_api.sql` and the K3 pin in `whatsapp_transport.sql` now fail by name if that changes.
- **New functions:** a new `public` function is born without PUBLIC EXECUTE (the `postgres` default privileges, measured).
- **Related debt Gate A left (closed by A.1, §7.1):** `get_avatar_for_email` calls `extensions.http_get` to ask Gravatar for a hash of the email. `service_role` can reach `extensions`, so a contact written by the service-role Postmark path discloses that hash to a third party. This is upstream CRM behaviour and needed an owner decision before real patient data.

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
- **Blocked on purpose:** the CRM's own browser-side avatar lookups and the upstream telemetry beacon. Each discloses data to a third party; the CRM falls back to initials when they fail. *(A.1 removed the avatar and favicon lookups themselves; the policy would still refuse one.)*
- **Headers only a host can send:** CSP with `frame-ancestors 'none'`, HSTS, `nosniff`, the referrer policy and a permissions policy. They are declared in `hostedSecurityHeaders()` and served by `vite preview`.
- **Measured in a browser:** the production-mode build ran under both the meta and the header policy. The application works, the configured API is reachable and an off-policy origin is refused.
- **Separation:** the development server has no CSP (it needs inline HMR). Every production build has one, and a build without it fails the scan.

## 5. Remaining major blockers (not closed by this gate)

- **Hosting:** the committed frontend deploy target (GitHub Pages) cannot send response headers. A real-data Company OS needs a host that sends `hostedSecurityHeaders()`, and hosting is undecided.
- **Hosted auth configuration:** a hosted Supabase project must enable TOTP MFA in its own auth settings, must never hold the exemption row, and must never receive the seed (SI-25).
- ~~**CRM data outside the Company OS:** the Atomic CRM's own screens reach contacts through row security with no MFA requirement.~~ *(Owner decision 2026-09-28: the CRM requires level 2 for real clinic data too. Closed by A.1, §7.2.)*
- ~~**The Gravatar disclosure** from service-role contact writes (§2).~~ *(Closed by A.1, §7.1.)*
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

## 7. A.1 correction (migration `20261005120000_production_security_gate_a1.sql`)

A narrow corrective milestone for the two repository-controlled gaps §5 listed. It does not reopen Gate A's architecture: PUBLIC and anon still execute nothing in `public`; `ops.operator_scope()` is unchanged; the exemption is still the one seed-only row; the TOTP flow, the CSP and the build scan stand. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

### 7.1 No automatic third-party enrichment (owner policy 2026-09-28)

- **What existed:** saving a contact ran `get_avatar_for_email`, which SHA-256-hashed the email and asked Gravatar through `extensions.http_get`, then fell back to the email domain at `favicon.show`; saving a company ran `get_domain_favicon` on its website. That is database egress a browser CSP cannot stop. For the application roles it could not complete (USAGE on `extensions` was revoked from them in `20260911130000`); for `service_role`, which the Postmark inbound-email path uses, it did. A browser-side twin existed in the FakeRest demo provider (`getContactAvatar`, `getCompanyAvatar`).
- **What was done:** the two triggers (`company_saved`, `20_contact_saved`) and the four functions (`get_avatar_for_email`, `get_domain_favicon`, `handle_contact_saved`, `handle_company_saved`) are dropped, not merely revoked, so no role holds a callable egress function. The migration drops the two stamping functions with `CASCADE`, which removes exactly the trigger that calls each (the guard cannot classify a `DROP TRIGGER` of the quoted name `"20_contact_saved"`); it then asserts no trigger and no `public` function names a third-party lookup. The declarative schema (`02_functions.sql`, `04_triggers.sql`, `06_grants.sql`) agrees. The FakeRest demo provider and its two helper modules (and their tests, and the domain list) are removed. Nothing replaces the provider.
- **Stored values:** untouched. A stored contact avatar or company logo is never rewritten by an insert or an update (tested). The interface already falls back to the contact's initials and the company's first letter (tested).
- **Helper surface:** `authenticated` executes exactly six functions (`can_access_contact`, `can_access_deal`, `can_manage_sales_id`, `current_sales_id`, `is_active_sales_user`, `is_admin`). PUBLIC and anon execute none; the Company OS capability roles execute none. The migration asserts it.
- **Not decided here:** any future picture source. It needs its own reviewed source and a new decision.

### 7.2 Multi-factor assurance on the CRM's real-data surface (owner policy 2026-09-28)

- **Where it lives.** Every row-security policy on the CRM decides through two roots: `public.current_sales_id()` (via `is_active_sales_user()`, `can_manage_sales_id()`, `can_access_contact()`, `can_access_deal()`) or `public.is_admin()` alone (the owner-only writes and the inbound-email ledger). The three views (`activity_log`, `companies_summary`, `contacts_summary`) are `security_invoker`. So the requirement is added **once**, in those two roots, and no policy changes:

  `permission = (the existing row rule) AND (assurance satisfied)`

- **The predicate.** `ops.session_assurance_satisfied()` (SECURITY DEFINER, executable by nobody) is true when the verified claims name a session, of the very user `auth.uid()` resolves, whose `auth.sessions.aal` **and** whose token `aal` claim are both `aal2` or above, or when the one exemption row exists (`ops.operator_assurance_exemption`; no second mechanism, no migration inserts it). `ops.operator_scope()` was not touched; `crm_assurance.sql` C4 proves the two agree on every combination of session level, token level and exemption.
- **Protected surface (traced, and checked by the suite for every browser-visible relation):** `contacts`, `companies`, `contact_notes`, `deals`, `deal_notes`, `tasks`, `lead_profiles`, `acquisition_attributions`, `contacts_summary`, `companies_summary`, `activity_log`, `sales`, `tags`, `loss_reasons`, `configuration`, `favicons_excluded_domains`, `inbound_emails`. The attachments bucket is closed (no policy). A relation added later that `authenticated` can read but the suite does not list fails B1 by name, and so does a policy that does not decide through a helper.
- **No widening.** For each of those relations and for three users (two operators and an owner) the suite requires: nothing at `aal1`, and at `aal2` exactly what the development exemption shows at `aal1` (the row rules unchanged). An operator still sees only their own rows and is still no admin at `aal2`; the owner still is one; a user without a `sales` row is still nobody.
- **Attacks that fail:** an `aal1` session with `aal1` claims; `aal2` claims over an `aal1` session; a stale pre-second-factor token over a session that has since reached `aal2`; a legacy per-claim `aal` setting; no `aal` claim; no session in the claims; claims that are not an object; another user's `aal2` session; a session id that is not a uuid; an ended session; a signed-out session; a legacy subject that differs from the claims' subject. Mutation-checked: removing the requirement from either root, trusting the claim alone, trusting the session row alone, dropping the subject binding, the owner check or the end check, re-adding a lookup function or trigger, granting the predicate to `authenticated`, and a policy that ignores the helpers are each caught by name.
- **The two backend paths that act as a caller.** (1) `merge_contacts` merges through the sealed owner-session pool as `authenticated`; that channel used to forward only the caller's id, which the CRM would now refuse in production. `runAsUser` now also sets the request claims from the caller's **verified** token (session id and level) as bound parameters; without them the database refuses (fail closed). `db.ts` and `merge_contacts/index.ts` are re-sealed, and the real-driver probe (`ownerSessionPool.mjs`, check H) and the SQL replay (G) prove the claims reach the transaction and leave nothing behind (SI-27). (2) The `users` account-management function read the caller's `sales` row with the service-role client, so an owner at `aal1` (or a stolen `aal1` token) could invite a new administrator, who could then enrol their own factor. The caller's sale is now read **as the caller** through the Data API, so the same policy refuses it below level 2.
- **Screen.** The application shell (`src/crmSecondFactor.tsx`, `src/crmAccess.ts`, wired in `src/App.tsx`) sends a session the server refuses at level 1 through the **same** second-factor flow the Company OS uses (`SecondFactorFlow.tsx`, extracted so both share it; enrolment, then a code). It asks the server whether the caller's own `sales` row is visible before showing it, so a session the server accepts (the local exemption) is not sent through a factor the server does not need, and the two email-link pages (set and reset a password) are let through. `authProvider.checkAuth` no longer ends a level-1 session whose `sales` row is invisible (it is not a disabled account; ending it would make the factor unreachable); a level-2 session with no account is still ended. This is convenience only: the database decides.
- **Local development.** The seed still records the one exemption, so local development, the SQL suites and CI's database job run without enrolling an authenticator. A database built from migrations alone (a hosted project) requires level 2 on the first CRM request. The upgrade replay records the exemption inside its own rolled-back transaction.

### 7.3 Caveats and what stays open

- **First enrolment.** The provider lets a person with no enrolled factor enrol one at level 1, so a stolen level-1 session of someone who has not yet enrolled can enrol its own factor. Token theft stays a known residual; enrol at onboarding.
- **A hosted project must enable TOTP** in its own auth settings, or no one reaches level 2 and the CRM and the Company OS stay closed.
- **Not browser reads of CRM data, unchanged:** `update_password` (a reset email to the caller's own address), the Postmark inbound-email webhook (service role, no browser) and the attachment cleanup function.
- **Hosting (external, not solved here).** A production host must actually send the declared headers (`hostedSecurityHeaders()`): HSTS, `nosniff`, the permissions policy and an effective `frame-ancestors`. GitHub Pages cannot, and stays unsuitable as the final clinic host.
- **Still closed and unchanged:** ADR 0020 §C evidence, production WhatsApp (ADR 0018), real patient model traffic, no Jev, no RAG, no Google Calendar.
- **Inert text, not code:** the demo build copies the deliberately stale `registry.json` into `dist/r/`, whose JSON still carries the removed upstream helper's source as text. It is never executed; ADR 0008 owns that file.

### 7.4 Validation (local, once at the end)

- **New `supabase/tests/crm_assurance.sql`** (A enrichment and helper surface, B CRM at the database authority, C exemption and agreement with the Company OS). **Mutation-checked, each caught by name:** removing the requirement from `current_sales_id`; from `is_admin`; a predicate that trusts the token claim only; the session row only; one without the subject binding; without the session owner; without the ended-session check; a public function that names Gravatar again; an enrichment trigger back; the predicate granted to `authenticated`; a policy on a bare `auth.uid()`; a policy with `using (true)`.
- **`test:db`: 25/25 suites** after a clean reset from migrations and seed (24 at Gate A); `company_domain_core.sql` A5 now names the one new DEFINER function. `owner_session_pool.sql` G and the real-driver `ownerSessionPool.mjs` H (a verified session reaches the request claims and leaves nothing behind) pass in the actual edge runtime.
- **`test:db:engine`: 403/403** in 54 files. **Upgrade replay: PASS.** **Migrations-only replay plus `referenceData.mjs --without-seed`: PASS**, including "no assurance exemption".
- **Live, against real Supabase Auth, PostgREST and the edge runtime, in the production posture (migrations only, no seed, no exemption): 33/33.** `aal1` reads nothing from 13 relations and cannot insert; `merge_contacts` at `aal1` merges nothing and at `aal2` merges through the owner-session pool; the `users` function refuses an `aal1` caller, including an owner's stale token, and an owner at `aal2` can invite; a real TOTP takes the same session to `aal2`; the old `aal1` token stays refused; a signed-out session reads nothing; a `service_role` contact and company write stamps nothing. To measure the edge functions, the local e2e stack's edge runtime expects issuer `…:54321` while its Auth signs `…:54341`; the issuer was pinned in the local e2e copy of `authentication.ts` for the run and the copy restored (nothing in the repository changed).
- **Live in the browser (Vite against the same stack):** a fresh `aal1` session sees "O CRM exige um segundo fator" instead of the CRM; enrolling, then a real 6-digit code, mounts the CRM; the contacts list shows the stored contact with its initials fallback; no console error.
- **`functions` project: 2269/2269** in 97 files (security invariants 82/82, the migration guards, the seal); script guard tests 174/174. **`app` project: 506 passed, 1 skipped** in 65 files (gate 6, probe 5, `checkAuth` 2, local fallback 3, and the second-factor screen still green for the Company OS).
- Typecheck green; ESLint 0 errors; Prettier clean on every changed file (the only local Prettier noise is the CRLF checkout of `.claude/`, and CI's two historical errors are unchanged); production build and demo build each scan 0 blocking; production scope and signing key OK.
