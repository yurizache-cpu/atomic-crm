# SECURITY AUDIT — PHASE 1B-S
## Frontend exposure, API attack surface and data-leak audit

**Date:** 2026-09-12 · **Baseline:** `cf6054c8` (Phase 1B, tree clean, in sync with `origin/feature/clinical-phase-1`)
**CI:** [run 34709371204](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34709371204) on `75a73519` — database, test, typecheck, ESLint, build all green, and the new `No secrets in the production build` step passed. `e2e-test` and `Prettier` remain red, unchanged from before this audit.
**Environment:** isolated `atomic-crm-e2e` stack only (API `127.0.0.1:54341`, DB `54342`). The `atomic-crm-demo` stack belongs to a second working copy and was not touched.

---

## EXECUTIVE SUMMARY

**No confirmed Critical or High vulnerability.** The Phase 0.5 grant/RLS work holds up under direct attack: across 46 adversarial checks driven through the same Data API the browser uses, an anonymous caller obtained **nothing** (401/42501 on all 18 tables and views, and on writes), and an authenticated user could not read, modify or delete another user's records by any route tried — including the destructive `merge_contacts` RPC, unqualified mass-delete, mass assignment of `sales_id`, and self-escalation to `administrator`.

**One MEDIUM was found and fixed.** Logging out cleared two auth hints and left the *persisted React Query cache* — every contact, note, email address and consent flag the user had viewed — in `localStorage` for 24 hours, across browser restarts. For the first tenant, an online psychology clinic, that is other people's clinical data remaining on a device after its user explicitly ended the session. Fixed, regression-tested, mutation-verified.

**The single most important thing on this page is not a bug in the code.** `supabase/signing_keys.json` is a tracked **private** JWT signing key (inherited from upstream, marked "development"). I proved the consequence rather than assuming it: a token signed with that key and claiming `role: service_role` is accepted by the Data API and bypasses RLS. It is harmless today — it is upstream's public dev key, used only by the local CLI, and no deploy path ships it — but **if it is ever used for a hosted project, anyone who can read the repository can mint a service_role token.** That must never happen; hosted Supabase generates its own keys.

Also fixed: the production build was emitting `dist/stats.html` (a 1.6 MB module-graph report) into the directory `gh-pages` publishes wholesale. And a new CI gate now refuses any build containing a server-side credential.

**Classification: SECURITY GATE PASSED.** See §26.

**Final closure (2026-09-12, §27).** The gate was accepted with two questions open, and both are now closed by code and measurement.

1. **CRM records are no longer persisted in the browser at all.** The mobile persister was an inherited upstream "offline mode" that no product requirement asked for, so it was removed rather than allow-listed.
2. **The development signing key is confined by executable guards.** They include a deploy-time check that asks the target project's own JWKS whether it trusts the key.

An adversarial review of the closure found no Critical or High issue, and every gap it did find was fixed before the closure was signed off. All 39 mutations were caught. One new LOW finding is recorded: **SEC-1BS-13**, list filters the user types persist until logout.

---

## 1. THREAT MODEL

**Trust boundaries** (outermost first):

```
  [A] anonymous browser ─┐
  [D] malicious client   ├─► Kong ─► PostgREST ─► RLS + GRANTS ─► public.*
  [E] bundle + [H] key  ─┘              │
  [B] authenticated user ───────────────┘   (role: anon | authenticated, from a signed JWT)
  [C] another user ─────────────────────┘

  [F] edge functions ──► service_role ──────► public.*     (INSIDE the boundary; SI-06)
  [J] worker process ──► ops_worker_login ──► ops.* only   (Phase 1A/1B; no BYPASSRLS)
  [I] leaked JWT ──────► whatever its `role` claim says    (the key IS the boundary)
```

The boundary that actually enforces confidentiality is **grants + RLS in Postgres**, not the frontend. Everything the browser does is a request any attacker can replay with `curl`; the UI is not a control. `ops.*` sits behind a second boundary (absent from the PostgREST allowlist) and a third (`ops_worker` has no `public` privileges at all).

**Assets, ranked by what losing them costs:** inbound email bodies and contact notes (clinical, LGPD) → contact/lead PII and `do_not_contact` consent state → session credentials → database and worker credentials → deployment credentials → operational job data.

**Actors A–J** from the brief were each exercised; §28 records what each achieved.

---

## 2. ATTACK SURFACE INVENTORY

| Surface | Exposed | Notes |
| --- | --- | --- |
| PostgREST tables/views | 18 objects, `authenticated` only | anon holds **zero** privileges on every one |
| PostgREST RPC | 10 functions reachable by `anon` | all fail closed; see §16 |
| Edge functions | 6 (`users`, `postmark`, `merge_contacts`, `delete_note_attachments`, `mcp`, `update_password`) | all 401/404 to anon |
| Storage | 1 bucket (`attachments`), `public = false` | upload path currently closed |
| Auth | `/auth/v1/*`; email logins **disabled** in config | |
| `ops` schema | **not** in the PostgREST allowlist | 404 to `authenticated`, verified |
| Frontend artifacts | 60 files, 15 MB, incl. 4 source maps | published by `gh-pages -d dist` |

---

## 3. FRONTEND EXPOSURE

Built exactly as shipped (`npm run build`) and audited the **generated artifacts**, not the source.

- **No key-shaped literal of any kind** in the shipped JS/HTML/JSON.
- The only `service_role` occurrences anywhere are **JSDoc comments from `@supabase/auth-js`** inside a source map (*"Never expose your `service_role` key in the browser"*). Not a key. The build gate's test suite pins this exact string as a must-not-flag case, because a gate that cries wolf here gets switched off.
- The publishable key **is** inlined when a `.env` supplies it — expected, and INFORMATIONAL per §30.

**Source maps** (§5): `sourcemap: true` in both `vite.config.ts` and `vite.demo.config.ts`; 9 MB of original TypeScript, including comments, is published. Assessed rather than assumed: the only frontend the workflows deploy is `deploy-demo`, which builds with `VITE_IS_DEMO=true` against FakeRest — **no backend, no real data, no credentials**. Exposure today is source structure for a fork of a public project. Recorded as SEC-1BS-03, LOW, with the condition that it changes the day a production frontend is deployed from the same config.

---

## 4. SECRET SCAN

Rules match credential **classes**, not entropy. Nothing below is printed in full anywhere.

| Class | In `dist`? |
| --- | --- |
| `sb_secret_*`, service_role/admin JWT, PG connection string with password, PEM private key, GitHub token, AWS key, assigned server-only variable | **none** |

**The decisive proof for §3** (the Vite public-prefix boundary): `.env.e2e` contains a real `SERVICE_ROLE_KEY=eyJ…` with no `VITE_` prefix. Building in that exact mode (`vite build --mode e2e`) and searching every artifact **including source maps** for it → **not present**. The boundary holds; the prefix is what enforces it.

Frontend-reachable variables are exactly: `VITE_SUPABASE_URL`, `VITE_SB_PUBLISHABLE_KEY`, `VITE_IS_DEMO`, `VITE_INBOUND_EMAIL`, `VITE_ATTACHMENTS_BUCKET`, `VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION`, `MODE`.

---

## 5. GIT HISTORY

Audited history, not just HEAD. **No secret was found that had been committed and later removed**, and no database dumps, debug logs or real-data fixtures.

Three secret-bearing files are tracked **by design**, and all three predate this project's work:

| File | Provenance | Contents |
| --- | --- | --- |
| `supabase/signing_keys.json` | upstream `d348cef1` *"Add development JWT signing keys"*, present at the pre-fork commit | EC P-256 JWK **with the private `d` component** |
| `.env.development` | upstream, initial commit | local URL + publishable key |
| `.env.e2e` | `94246053` | local URL, publishable key, local service_role JWT |
| `supabase/functions/.env` | upstream `c9e74f1e`; `.gitignore:42` deliberately un-ignores it | Postmark webhook user/password — **currently test placeholders** |

No rewrite of history was performed or is recommended: the values are upstream's public local-development defaults, so there is nothing to rotate that is not already public. See SEC-1BS-04 and SEC-1BS-05 for the conditions under which this stops being true.

---

## 6. BROWSER STORAGE

| Key | Contents | Cleared on logout? |
| --- | --- | --- |
| `REACT_QUERY_OFFLINE_CACHE` | **every CRM record the user viewed** | **was: NO** → now yes. *Closure (§27): no longer written at all, and purged at startup* |
| `RaStore.auth.is_initialized` | boolean hint | yes |
| `RaStore.auth.current_sale` | own `sales` row | yes |
| `RaStore.*` (ra-core store) | UI preferences | n/a |
| `sb-*-auth-token` (supabase-js) | session tokens | yes, by supabase-js |
| sidebar cookie | UI state | n/a |

`gcTime` is 24 hours and `localStorage` survives a browser restart. That is SEC-1BS-01. *(Closed at the root in §27: the persister is removed.)*

---

## 7. NETWORK / API MAP

Every request the browser makes is `apikey: <publishable>` plus, when signed in, `Authorization: Bearer <user JWT>`; the database role is whatever the JWT's `role` claim says. Object ids come from client input on every REST path — which is exactly why object-level authorization (§11) is the load-bearing control and was tested hardest.

Response width is the one place the API is more generous than the UI needs: `sales?select=*` returns `administrator`, `user_id`, `role`, `disabled`. Scoped to the caller's **own** row only (verified), so this is data minimisation rather than exposure — see §27.

---

## 8. AUTHENTICATION

| Case | Result |
| --- | --- |
| no token (anon apikey only) | 401 / 42501 |
| malformed JWT | 401 `PGRST301` |
| tampered signature | 401 `PGRST301` |
| expired JWT | 401 `PGRST303` |
| **valid token reused after logout** | **200 — still works** |
| validly signed token claiming `role=service_role` | **200 — escalates** |

The last two are inherent to stateless JWT: logout revokes the refresh token, not the ~1 h access token; and PostgREST trusts the `role` claim of anything signed by the configured key. Both are recorded (SEC-1BS-07, SEC-1BS-04). No brute-force testing was performed.

---

## 9. AUTHORIZATION, BOLA/IDOR, PROPERTY-LEVEL

Two users (A, B) with their own `sales` rows and contacts. Every attack below went through the REST API, not SQL.

| Attack | Result |
| --- | --- |
| A GETs B's contact by id | **0 rows** |
| A lists contacts | 1 row, 0 foreign |
| A PATCHes B's contact | **0 rows affected** |
| A DELETEs B's contact | **0 rows affected** |
| A `DELETE /contacts?id=gt.0` (mass) | deleted 1 — **its own**, 0 foreign |
| A PATCHes B's `sales` row (`disabled=true`) | 0 rows |
| A INSERTs a contact with `sales_id` = B | **403 / 42501** |
| A sets its own `sales.administrator = true` | **403 / 42501** |
| A UPDATEs `configuration` | 0 rows (`is_admin()` policy) |
| A calls `merge_contacts(loser=B's contact, winner=A's)` | **P0001 "Contact not found"** — B's contacts intact |
| A reads `contacts_summary` / `activity_log` | own rows only (1 of 3 in the table) |
| A enumerates `sales` | own row only — **no user enumeration** |

`merge_contacts` deserves its own line: it is a destructive RPC granted to `authenticated`, and it is safe only because it is `SECURITY INVOKER`, so RLS hides the row it is asked to destroy. That is a load-bearing property and it is now exercised.

---

## 10. SUPABASE GRANTS / RLS

All 18 `public` objects, verified against the live catalog and then attacked through the API:

- **anon: no privilege on anything.** Not one SELECT, INSERT, UPDATE, DELETE or TRUNCATE.
- `authenticated`: CRUD on the CRM tables, SELECT-only on `sales`, `inbound_emails`, `favicons_excluded_domains`; SELECT+UPDATE on `configuration` and `lead_profiles`.
- Every table has RLS **enabled** with policies. Every table also has `relforcerowsecurity = false`, so the table *owner* bypasses policy — characterised, not new, and unlike `ops.*`, which forces it (SEC-1BS-11).
- `ops.*` is invisible to the Data API: `404 PGRST205` for tables, `404 PGRST202` for `lease_job`, `resume_lease`, `purge_inbound_email_ledger`, `enqueue_job`, `current_tenant_id`.

---

## 11. SECURITY DEFINER FUNCTIONS

The `public` schema has one: **`cleanup_note_attachments`** — `SECURITY DEFINER`, owned by `postgres`, `EXECUTE` to PUBLIC, and it calls `net.http_post` to a URL derived from the JWT `iss` claim.

That reads like a privileged SSRF. It is not, and I checked rather than inferred:

- `pg_net` was removed in Phase 0.5 — there is **no `net` schema**, so the call cannot resolve.
- It is attached to **zero triggers** (verified against `pg_trigger`).

So it is dead code that names a capability the baseline deliberately removed. Recorded as SEC-1BS-08 (LOW): harmless today, live again the moment anyone reinstalls `pg_net`.

`get_avatar_for_email` is `SECURITY INVOKER` and calls `extensions.http_get`. Probed as anon: returns `"ERROR"`, because `anon` and `authenticated` have **no `USAGE` on schema `extensions`** (verified `false` for both) and the function swallows the exception. Egress closed, by measurement.

`ops.*` definer functions were audited in Phase 1A/1B and re-confirmed unreachable here.

---

## 12. VIEWS

All four (`activity_log`, `companies_summary`, `contacts_summary`, `init_state`) carry `security_invoker = on`, and anon holds nothing on any of them. Attacked through PostgREST as user A: `contacts_summary` returned **1 row of the 3 in the base table**, all with A's own `sales_id`. The Phase 0.5 incident — base table refuses, view hands the rows over — does not reproduce.

---

## 13. STORAGE

One bucket, `attachments`, `public = false` (verified live — the Phase 0.5 migration did close it; the risk flagged in CLAUDE.md for *migrated* databases is not present here).

- anon `list` → empty, anon read of a known path → denied.
- Authenticated upload → **400 Unauthorized**: the upload path is currently closed, matching the documented decision not to reopen it before bucket privacy landed. Cross-tenant object tests are therefore **unverified** (§35) — there is no object to fetch. They must be re-run when uploads are restored.

---

## 14. XSS / INPUT HANDLING

One `dangerouslySetInnerHTML` in the whole application: `misc/Markdown.tsx`, which renders **note bodies** — and note bodies arrive from inbound email, the only untrusted external channel reaching this database.

It is sanitised: `marked.use({ hooks: { postprocess: (html) => DOMPurify.sanitize(html) } })`. Verified empirically in a real browser against 8 payload classes — `<script>`, `onerror`, `javascript:`, `<iframe>`, `<svg onload>`, `data:text/html`, `<object>`/`<embed>` — all stripped, nothing executed, and legitimate markdown still renders. Now a permanent regression suite (§32).

No `innerHTML`, `document.write`, `eval` or `new Function` anywhere in `src/`.

---

## 15. CORS / HEADERS

`Access-Control-Allow-Origin: *` with **no** `Allow-Credentials` on the Data API (Kong default). Since authorization travels in the `Authorization` header and not in cookies, a wildcard origin without credentials does not let a hostile page act as the user — the browser will send the request, but not the token. Not a finding; recorded so the conclusion is on the record rather than assumed.

No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` or HSTS on API responses. For a JSON API consumed by `fetch` this is close to immaterial; for the **frontend host** it is not, and today the frontend is served by GitHub Pages, which sets none of them and cannot be configured to. SEC-1BS-10, INFORMATIONAL, with a concrete recommendation.

---

## 16. RPC SURFACE REACHABLE BY ANON

Ten functions are callable without a session. Each was invoked:

| Function | anon result |
| --- | --- |
| `current_sales_id` | `null` |
| `is_admin` | `false` |
| `is_active_sales_user` | `false` |
| `can_access_contact` / `can_access_deal` / `can_manage_sales_id` | gated helpers, resolve through `auth.uid()` |
| `get_avatar_for_email` | `"ERROR"` (egress denied) |
| `get_domain_favicon` | **401 / 42501** (`permission denied for table favicons_excluded_domains`) |
| `get_note_attachments_function_url` | returns a URL string; consumed only by the dead function in §11 |
| `merge_contacts` | requires rows RLS will not show |

Every one fails closed. The finding is not any single function but that the surface exists at all: these are PUBLIC-by-default `EXECUTE` grants from Supabase's default privileges, not deliberate decisions. SEC-1BS-09, INFORMATIONAL.

---

## 17. DEPENDENCIES

41 advisories, **none introduced by Phase 1B** (`pg` and its 13 transitive packages appear in zero of them). Classified by what they can actually reach:

| Package | Sev | Runtime? | Reachable here? |
| --- | --- | --- | --- |
| `vitest`, `@vitest/browser*` | critical ×4 | **dev/test only** | not shipped |
| `vite`, `postcss`, `nanoid`, `browserslist`, `esbuild`, `js-yaml`, `brace-expansion`, `fast-uri`, `ip-address` | high/low | build/dev | not shipped |
| `dompurify@3.4.0` | moderate | **yes — the XSS boundary** | **not obviously reachable**: every advisory is scoped to `IN_PLACE`, `setConfig`/`clearConfig`, hook mutation, `SAFE_FOR_TEMPLATES` or `CUSTOM_ELEMENT_HANDLING`. This app calls plain `DOMPurify.sanitize(html)` — string in, string out, no options, no hooks. The 8 payload tests pass on 3.4.0. |
| `react-router@7.17.0` | high | **yes** | the open redirect (`<Link>`/`useNavigate` backslash) is the only non-SSR one; no user-controlled navigation target was found. |
| `qs`, `query-string`, `ra-core`, `ra-supabase-core` | moderate | yes | transitive through the data provider; no reachable path identified |

`npm audit fix` was **not** run. Two bumps are recommended and deliberately *not* applied here: `dompurify` (defence in depth on the XSS boundary) and `react-router` 7.17 → 7.18 (a minor that touches routing app-wide — not surgical, and §31 forbids broad changes during an audit). I also cannot install packages from this session.

---

## 18. CI / DEPLOYMENT

Clean. No `pull_request_target` (so no untrusted PR can reach secrets), no artifact uploads, no secret echoed to logs. Secrets are passed as `env:`, not on command lines. `GITHUB_TOKEN`/`DEPLOY_TOKEN` appear inside a git remote URL, which is the standard `gh-pages` pattern and is masked in logs.

Added: a **build secret gate** (§33) as a required step in the `🔨 Build` job.

---

## 19. CONFIRMED FINDINGS

### SEC-1BS-01 — Persisted CRM cache survives logout — **MEDIUM** — *fixed*

**Component** `root/CRM.tsx`, `providers/supabase/authProvider.ts`
**Prerequisite** local access to the device (or same-origin script) after a user logs out
**Evidence** `clearCache()` removed `RaStore.auth.is_initialized` and `RaStore.auth.current_sale` only. `PersistQueryClientProvider` writes the whole React Query cache to `localStorage` under `REACT_QUERY_OFFLINE_CACHE` (key confirmed present in the production bundle) with `gcTime: 24 h`.
**Impact** Contacts, note bodies, email addresses, phone numbers, lead profiles and `do_not_contact` consent state remain readable on the device for up to 24 hours after logout, surviving browser restart. For an online psychology clinic this is third-party clinical data under the LGPD, retained after the user took the explicit action they would expect to clear it.
**Reproduced** yes. **Fixed** yes — the key now lives in one module (`providers/queryCacheKey.ts`), is passed explicitly to the persister, and is removed on logout. **Regression test** `authProvider.security.test.ts` (2 tests, driving the real provider). **Mutation-verified**: removing the new line turns both tests red.
**Residual** a session that *expires* rather than logging out does not pass through `logout`. Noted in §21. *(Superseded by §27: nothing is persisted, so an expired session leaves no query cache behind. It does leave ra-core's store, including typed filters — SEC-1BS-13.)*

### SEC-1BS-02 — Bundle-visualizer report published — **LOW** — *fixed*

`dist/stats.html` (1.6 MB) was emitted into the directory `npx gh-pages -d dist` publishes wholesale, exposing the full module graph, every source path and the dependency inventory. Now emitted to `node_modules/.cache/`, and the build gate flags it if it returns.

### SEC-1BS-03 — Production source maps published — **LOW** — *accepted, documented*

9 MB of original TypeScript incl. comments. Today only the FakeRest demo is deployed (no backend, no data). Recommendation in §22.

### SEC-1BS-04 — Tracked private JWT signing key — **INFORMATIONAL now, HIGH if reused** — *accepted with a control*

`supabase/signing_keys.json` holds an EC P-256 JWK **including the private component**, inherited from upstream (`d348cef1`, "development"). **Proven consequence:** a token signed with it claiming `role: service_role` is accepted by PostgREST and bypasses RLS entirely.
Not exploitable against this system: it is upstream's public dev key, referenced only by `supabase/config*.toml` for the local CLI, shipped by no deploy path, and there is no hosted project. **Required control: never configure a hosted Supabase project with this key.** Hosted projects generate their own; do not override them. *(Closure, §27.3: the control is now executable — `scripts/dev-signing-key.mjs`, the scanning publisher `scripts/publish-pages.mjs`, and a deploy-time check of the project's JWKS.)*

### SEC-1BS-05 — `.gitignore` un-ignores `supabase/functions/.env` — **LOW** — *documented*

Edge-function secrets are committed by design (`!supabase/functions/.env`). Current values are test placeholders (`testuser`/`testpw`). The structure invites a real Postmark credential into git the first time someone configures the webhook locally.

### SEC-1BS-07 — Access token valid after logout — **INFORMATIONAL** — *accepted*

Inherent to stateless JWT; logout revokes the refresh token. Mitigation is a short access-token lifetime, not a code change.

### SEC-1BS-08 — Orphaned `SECURITY DEFINER` referencing removed `pg_net` — **LOW** — *documented*

`cleanup_note_attachments`: PUBLIC `EXECUTE`, calls `net.http_post` to a JWT-`iss`-derived URL, attached to zero triggers, and `net` does not exist. Inert; would become a privileged egress path if `pg_net` returned. Dropping it is recommended but is schema surgery, deliberately not done mid-audit.

### SEC-1BS-09 — Ten RPCs reachable by anon — **INFORMATIONAL** — *documented*

All fail closed (§16). They are PUBLIC-by-default `EXECUTE` grants rather than decisions.

### SEC-1BS-10 — No security headers / no CSP — **INFORMATIONAL** — *documented*

Immaterial on the JSON API; real for the frontend host, which today is GitHub Pages and cannot set them. Becomes actionable when the production frontend gets a host that can.

### SEC-1BS-11 — `public` tables are not `FORCE`d — **INFORMATIONAL** — *characterised*

`relforcerowsecurity = false` on all 14 tables, so the owner bypasses policy. `ops.*` forces it. Pre-existing and unchanged.

### SEC-1BS-12 — No account can become `administrator` — **MEDIUM (availability, not confidentiality)** — *pre-existing, documented*

Confirmed live: both created users get `administrator = false`, and `configuration` UPDATE affects 0 rows. Every `is_admin()`-gated policy is unreachable. This fails *closed*, so it is a functional deadlock rather than a security hole — already recorded in CLAUDE.md. Flagged because Phase 1C will hit it.

---

## 20. FIXED IN THIS AUDIT

| ID | Fix | Proof |
| --- | --- | --- |
| SEC-1BS-01 | logout clears the persisted query cache; key centralised so writer and cleaner cannot drift | 2 regression tests, mutation-verified |
| SEC-1BS-02 | visualizer emits outside `dist` | build gate returns 0 advisories |
| — | **new:** CI build gate refusing any server-side credential in a browser artifact | 16 tests incl. must-not-flag cases |
| — | **new:** XSS sanitisation pinned | 9 payload tests in a real browser |

## 21. ACCEPTED RISKS

SEC-1BS-03, -04, -05, -07, -08, -09, -10, -11, and the session-expiry residual of -01. Each is documented above with the condition that would change its severity. The one requiring an operational commitment rather than a code change is **SEC-1BS-04**. *(Closure, §27: SEC-1BS-04 is now enforced by code, the -01 session-expiry residual no longer exists, and SEC-1BS-13 is added.)*

## 22. RECOMMENDATIONS (not done here, deliberately)

1. **Never reuse `signing_keys.json` for a hosted project.** The only item on this list that is not optional. *(Now enforced — §27.3.)*
2. Disable `sourcemap` for the production build, or upload maps to an error-monitoring service instead of publishing them.
3. Bump `dompurify` and `react-router` (patch/minor, both available) — defence in depth; neither is reachable today.
4. Drop `cleanup_note_attachments` and its helper, or reattach them to a supported mechanism.
5. Set a short access-token lifetime to bound SEC-1BS-07.
6. Add security headers when the production frontend gets a configurable host.
7. Re-run the storage cross-tenant tests when uploads are reopened.

## 23. UNVERIFIED AREAS

- **Storage cross-tenant object access** — no object could be created; the upload path is closed (§13).
- **Realtime** — not enabled, so not exercised.
- **A hosted deployment** — none exists; all conclusions are about the local/E2E stack and the build artifacts.
- **The `mcp` edge function's authenticated behaviour** — rejected anon (401); its authorised surface is governed by ADR 0011 and was not re-audited here.
- **Session-expiry (non-logout) cache clearing** — see SEC-1BS-01 residual.

## 24. REGRESSION TESTS ADDED

| File | Tests | Guards |
| --- | --- | --- |
| `providers/supabase/authProvider.security.test.ts` | 2 | SEC-1BS-01 |
| `misc/Markdown.security.test.tsx` | 9 | the XSS boundary |
| `scripts/test/scan-build-artifacts.test.mjs` | 16 | the build secret gate, incl. false-positive cases |
| `root/CRM.security.test.tsx` *(closure)* | 4 | SI-19: no CRM record data in browser storage, on both admin trees |
| `scripts/test/dev-signing-key.test.mjs` *(closure)* | 59 | SI-20: the development key stays in local tooling |
| `scripts/test/publish-pages.test.mjs` *(closure)* | 8 | every Pages publish scans first |
| `scripts/test/scan-build-artifacts.test.mjs` *(closure additions)* | +8 | private JWKs, the key's own bytes, extensionless files |

Unit suite **945 passed / 2 skipped / 84 files** (was 918/2/81). Database suites 4/4 and driver-backed 32/32, from a clean `db reset`. Typecheck, lint and Prettier clean on every changed file.

## 25. OWASP API TOP 10 MAPPING

| Category | Outcome |
| --- | --- |
| API1 Broken Object Level Authorization | tested hardest; **no finding** (§9) |
| API2 Broken Authentication | no finding; two characterised behaviours (SEC-1BS-04, -07) |
| API3 Broken Object Property Level Authorization | `sales_id` and `administrator` both rejected; response width noted (§27 of the brief) |
| API5 Broken Function Level Authorization | `merge_contacts`, `configuration`, `ops.*` all fail closed |
| API7 SSRF | egress closed and **proven** closed (§11) |
| API8 Security Misconfiguration | SEC-1BS-02, -03, -10 |
| API9 Improper Inventory Management | SEC-1BS-02, -08, -09 |
| API10 Unsafe Consumption of APIs | inbound email → sanitised (§14) |

---

## 26. FINAL SECURITY CLASSIFICATION

# SECURITY GATE PASSED

- **No Critical or High vulnerability was confirmed.** The one MEDIUM found (SEC-1BS-01) was reproduced, fixed, regression-tested and mutation-verified before this classification was written.
- The other MEDIUM (SEC-1BS-12) is an availability deadlock that fails *closed*, is pre-existing, and is already documented.
- All remaining findings are LOW or INFORMATIONAL and are listed as accepted risks with the conditions that would change them.
- No Phase 0.5 / 1A / 1B guarantee was weakened: `pg_net` still absent, `security_invoker` still enforced (now in `ops` too), RLS suites green, `ops_worker` still has no `BYPASSRLS` and no write verb, migration guard green.

**The classification rests on one commitment that is not enforced by code:** `supabase/signing_keys.json` must never be used for a hosted project. If that key is ever the signing key of a real deployment, this classification is void — anyone able to read the repository could mint a `service_role` token, and I proved that token is accepted.

*(2026-09-12, final closure: that commitment is now enforced by code. See §27.)*

---

## 27. FINAL CLOSURE — the two questions left open

**Date:** 2026-09-12 · **Baseline:** `8a896da3` (tree clean, in sync with `origin/feature/clinical-phase-1`, CI run 34709714015 green on every job except the pre-existing `e2e-test` and `Prettier`).

The gate above was accepted with two questions outstanding: why CRM records were persisted in the browser at all, and whether the development signing key was protected by anything stronger than a sentence. Both are answered here, by code and measurement. The rest of the audit was not reopened.

### 27.1 Question 1 — why was CRM data on disk?

**It was an inherited feature, not a requirement.** The persister existed only in the `MobileAdmin` tree, and it was upstream Atomic CRM's mobile "offline mode" (`doc/src/content/docs/users/mobile-app.mdx`). Nothing in this product asks for offline access: the eight product documents in `docs/product/` (pt-BR), `ROADMAP.md`, `ARCHITECTURE.md`, `PHASE_1_HANDOFF.md` and `SECURITY.md` contain no such requirement, and `04-security-privacy.md` asks for the opposite — minimisation and short retention. `BASELINE_REPORT.md` §14 had listed the `MobileAdmin` tree as out of scope for Phase 0.5; that is superseded narrowly. The persistence is gone, and the tree and its resource set are untouched.

**Removed, not allow-listed.** An allowlist needs something non-sensitive in the query cache that must survive a restart. There is nothing: the one candidate, the tenant configuration, is already persisted separately by ra-core's store.

| Change | Where |
| --- | --- |
| `MobileAdmin` renders `<Admin queryClient>` directly: no `PersistQueryClientProvider`, no persister. The client is created once (`useState`), in memory. `networkMode: "offlineFirst"` stays, so a screen already open survives a dropped connection. | `root/CRM.tsx` |
| A cache left by an earlier build is removed at startup. Nothing reads that key any more, so nothing else would ever expire it. Storage that throws (site data disabled) does not crash the app. | `providers/queryCacheKey.ts`, `root/CRM.tsx` |
| Logout still removes the key (the original SEC-1BS-01 fix, retained), and ra-core's logout clears the in-memory client. | `providers/supabase/authProvider.ts` |
| Importing any `@tanstack/*persist*` package from `src/` or `demo/` is a lint error. | `eslint.config.js` |
| The user documentation no longer promises offline access to records. | `mobile-app.mdx` |

**What browser storage holds now.** Measured on the real `<CRM>` root with a probe (the D0 run in §27.3), after clinic-shaped records had been viewed:

| Storage | Key | Contents | Lifetime |
| --- | --- | --- | --- |
| localStorage | `RaStoreCRM.version` | ra-core store version | until logout |
| localStorage | `RaStoreCRM.app.configuration` | tenant vocabulary: sectors, stages, note statuses, title, logos | until logout |
| localStorage, on use | `RaStoreCRM.<resource>.listParams`, `…savedQueries`, column and theme preferences | UI state, **and list filters the user types** (SEC-1BS-13) | until logout |
| localStorage, Supabase build only | `RaStore.auth.current_sale` | the signed-in user's **own** `sales` row | until logout |
| localStorage, Supabase build only | `sb-*-auth-token` | the Supabase session | until sign-out |
| Cache Storage | workbox precache | static assets only; `dist/sw.js` registers one `NavigationRoute` and no runtime caching | per deploy |
| memory | React Query cache | the records viewed in this tab | the tab; cleared on logout |

No contact, note, email address, lead profile or `do_not_contact` value appears in any of it.

### 27.2 Proof for question 1

| Test | Proves |
| --- | --- |
| `root/CRM.security.test.tsx` — mobile tree | after contacts, notes, an email address and a `do_not_contact` lead profile are loaded through the real query client, none of them is in localStorage **or** sessionStorage, and no key outside the ra-core store exists. It asserts the mobile navigation is mounted, so the "mobile" case cannot silently render the desktop tree. |
| same — desktop tree | the same, for the other query client |
| same — legacy purge | a cache written by an earlier build is gone after startup |
| same — refused storage | the app still starts when the browser throws on storage access |
| `authProvider.security.test.ts` (retained) | logout removes the key and leaves no contact data anywhere |
| ESLint | the persister packages cannot be imported |

Mutation results (§27.5): 11 of 11 persistence mutations caught. One is caught **only** by ESLint: an obfuscated persister writing under the permitted `RaStoreCRM.` prefix passes the storage test. That is the storage test's one blind spot, and the lint ban is what closes it.

### 27.3 Question 2 — the development signing key

**First, what can actually put the key into a hosted project?** Researched against the Supabase CLI source rather than assumed. **No CLI command uploads signing keys:** `SigningKeys` is `toml:"-"`, `config push` builds its auth body without it, and `link`, `db push` and `functions deploy` call no signing-key endpoint. A hosted project trusts a key only if a person imports it through the dashboard or the Management API (`POST /v1/projects/{ref}/config/auth/signing-keys`). It publishes the keys it trusts at `/auth/v1/.well-known/jwks.json` — the same endpoint both edge functions in this repository verify tokens against. So a guard that reads repository text cannot see the one real path. A guard that asks the project can.

**The guard.** `scripts/dev-signing-key.mjs`, plus one publishing entry point. It identifies the key by its RFC 7638 thumbprint `CNdS5CVgQ-lJMyWfcK9MheIqmMJkQyQJw8_ZOzqKNVM` (public members only; checked against both the RFC's own example and `jose`). The public half is pinned in code, so removing the file cannot disarm it. No private material is printed anywhere — not in output, errors, tests or CI logs.

| Rule | Refuses |
| --- | --- |
| `dev-key-material-copied` | the private component in any other tracked file: verbatim, base64, hex, or a PEM (including a PEM inside a string literal) |
| `dev-key-public-copied` | the public component in any other tracked file, such as a function pinning the development JWKS |
| `dev-key-referenced` | anything outside four allow-listed **lines** of local/test tooling naming the key file; MDX counts, since it is compiled |
| `remote-config-uses-key-file` | a `[remotes.*]` (hosted branch) config pointing at a key file |
| `dev-key-unidentifiable` / `dev-key-unpinned` | a guard that would pass vacuously |
| `direct-pages-publish` | any GitHub Pages publish not made through `scripts/publish-pages.mjs`, which scans the directory and refuses on a finding: `npx gh-pages`, its binary, its API, Pages actions |
| `deploy-without-key-check` | any `supabase db push`, `functions deploy`, `secrets set` or `config push` in a workflow job or make target not preceded by a **blocking** key check; a file whose order cannot be read fails closed |
| `--project-ref` / `--linked` / `--remote` | a project whose JWKS lists the key (exit 1), or any failure to get an answer (exit 2) |

The build scanner gained a private-JWK class rule and a rule for the key's own bytes (private → critical, public → high), refuses a published `signing_keys.json`, and now reads every non-binary file instead of a list of extensions.

**Wired in.** `deploy.yml` checks `--project-ref "$SUPABASE_PROJECT_ID"` — the same ref `supabase link` uses — before any push, and both Pages publishes go through the scanning publisher. `make supabase-deploy` runs `--linked` first; `doc-deploy`, `registry-deploy` and `npm run ghpages:deploy` all go through the publisher. The repository guard runs in CI's test job and in deploy.yml's gate job.

**Measured.**

| Check | Result |
| --- | --- |
| repository guard on this tree | exit 0 |
| `--remote` against the local e2e Auth server, which **does** trust the key | **exit 1**: fails, naming the thumbprint |
| `--linked` with no linked project | exit 2, and says why |
| the key planted into copies of the real production `dist`: key file copied, inlined object literal, bare private string, public JWKS | all 4 blocked; clean baseline passes; no key material in any output |
| production build, demo build, registry output (`public/r`), doc sources | 0 findings each |
| service worker | precaches static assets only |

`doc/dist` itself was not built: `doc/` has no installed dependencies here. Its sources scan clean, and the publisher scans it at deploy time regardless.

### 27.4 Adversarial review of this closure

A read-only workflow of 12 agents (four lenses, each material finding checked by a separate agent trying to refute it) reviewed the first version. **No finding survived as Critical or High.** It did show that the first guard claimed more than it enforced, and every such gap was fixed before this section was written.

| Finding (verified severity) | Resolution |
| --- | --- |
| The guard ignored the key's **public** half in tracked files (medium) | `dev-key-public-copied` |
| Re-encoded copies (PEM, hex, base64) and extensionless files went undetected (low) | byte-level encodings and PEM parsing; the scanner reads every non-binary file |
| `deploy-doc`, the makefile and `npm run ghpages:deploy` published unscanned; a regex over workflow lines failed open on `--dist`, Pages actions and a comment after `jobs:` (low) | replaced by one scanning publisher and `direct-pages-publish` |
| The JWKS check could target a different project than the deploy; `make supabase-deploy` had no check; the check could be moved or made non-blocking unnoticed (low) | `--project-ref` from the same secret as `link`; `--linked` in the makefile; `deploy-without-key-check` |
| The check passed if the key file was removed (low) | public half pinned; `dev-key-unpinned` |
| The storage test measured the viewport, not the mounted tree (info) | asserts the mobile navigation |
| Stale comments described the removed persister as live (low) | corrected, including CLAUDE.md |
| SI-19 said "never" while its caveat listed persisted API responses (info) | restated as "no CRM record data" |
| The storage test renders FakeRest, not the Supabase providers (info) | recorded in the SI-19 caveat |
| Typed search filters persist until logout (info) | recorded as SEC-1BS-13 |

### 27.5 Mutation testing — 39 / 39 caught

Every mutation was applied to the working tree, run against the relevant guards, and reverted by restoring the file's original bytes (sha256-verified). `git status` was identical before and after.

| # | Mutation | Caught by |
| --- | --- | --- |
| P1 | restore the original mobile persister | storage test (mobile + purge), ESLint |
| P2 | persister under an innocuous key, obfuscated | storage test (key allowlist), ESLint |
| P3 | persister to sessionStorage | storage test, ESLint |
| P4 | obfuscated persister under `RaStoreCRM.` | **ESLint only** — the storage test's blind spot |
| P5 | persister on the desktop tree | storage test (desktop), ESLint |
| P6 | startup purge removed | purge test |
| P7 | purge rethrows on refused storage | refused-storage test |
| P8 | logout forgets the key | both retained logout tests |
| P9 | P1, with the throttle wait removed | storage test — the wait is a margin, not load-bearing |
| P10 | ESLint ban matches nothing | SI-19 invariant marker |
| P11 | "mobile" case renders the desktop tree | mobile navigation assertion |
| K1 / K1b / K1c | private key verbatim, as PEM, or public JWKS in an edge function | repository guard |
| K2 | `[remotes.production.auth]` names the key file | repository guard |
| K3 | a makefile target names the key file | repository guard |
| K4 / K4b | `npx gh-pages` in deploy.yml or the makefile | `direct-pages-publish` |
| K5 | the publisher skips its scan | publisher tests (5) |
| K6 | key check removed from deploy.yml | SI-20 marker, repository guard |
| K6b / K6c | key check made `continue-on-error`, or moved below `functions deploy` | repository guard **only** — the invariant marker stays green |
| K6d | key check removed from `make supabase-deploy` | SI-20 marker, repository guard |
| K7 | the frontend imports the key file | repository guard; build succeeds and `scan:build` blocks it (critical ×2, key material withheld) |
| K8 | JWKS check never recognises the key | unit tests, **and the live e2e check exits 0** |
| K9 / K9b | unreachable project passes; any string accepted as a project ref | unit tests |
| K10 – K10d | copy, public-half, PEM or re-encoding detection disabled | unit tests |
| K11 / K12 / K12b | scanner stops matching the key's bytes, private JWKs, or goes back to an extension list | scanner tests |
| K13 / K13b | loader reads no private member; pinned key emptied | anti-vacuity rules, repository guard |
| K14 / K14b | a check in another job counts; `\|\| true` counts as blocking | unit tests |
| K15 | `[remotes.*]` rule disabled | unit test |

### 27.6 New finding

#### SEC-1BS-13 — List filters the user types persist until logout — **LOW** — *accepted, documented*

**Evidence** Mobile and desktop lists keep their filter state in ra-core's localStorage store (`RaStoreCRM.contacts.listParams`). The contact search `q` matches name, email and phone, so a typed patient name or phone number is written to disk about 500 ms after typing. It is removed on logout (`resetStore`), but closing the browser is not a logout.
**Why LOW and not fixed here** It is text the user typed, not a CRM response, and not stored "merely because the user viewed it" — the property this closure was asked to hold. Keeping filters in memory (`storeKey={false}` on patient-facing lists, or routing `*.listParams` and `*.savedQueries` to a memory store) removes remembered filters and saved queries. That is a product decision, not a security fix to slip into a gate closure.
**Recommendation** Decide it before real clinicians use the app on shared devices.

### 27.7 Validation

| Gate | Result |
| --- | --- |
| Typecheck (`npm run typecheck`) | **clean** |
| ESLint, whole repository | **clean** |
| Unit suites, each project run alone | **1026 passed, 2 skipped, 0 failed, 87 files**: app 234 + 1 skipped (30 files), functions 416 (18), claude 376 + 1 skipped (39). Up from 945 / 2 / 84: the closure adds 81 tests. |
| SQL database suites (`npm run test:db`, isolated e2e stack) | **4 / 4 passed** |
| Driver-backed engine suites (`npm run test:db:engine`) | **32 / 32 passed** |
| Production build + secret gate | **0 findings** in 18 text files; `dist/sw.js` registers one route |
| Demo build + secret gate | **0 findings** in 13 text files |
| Registry output and doc sources | 0 findings |
| Prettier on every changed file | **clean** |
| Mutation testing | **39 / 39** |
| CI | **not yet run on this commit** — agents do not push (`.claude/rules/git-policy.md`) |

A full-suite run started while the review agents were active produced 13 timeouts in `.claude/` hook tests, none in a changed file. The claude project run alone passed (344 passed, 1 skipped at that point; 376 passed, 1 skipped in the final run). This is the load sensitivity CLAUDE.md already documents, not a regression.

No Phase 0.5 / 1A / 1B / 1B-S guarantee was weakened. The database suites, `security_invoker`, `pg_net` absence, the migration guard, BOLA/IDOR isolation, `merge_contacts`, `ops` invisibility, attachment privacy, the build secret gate, the source-map/stats fix and the XSS tests are all unchanged and green. SI-19 and SI-20 were added to `supabase/tests/securityInvariants.test.ts` and `docs/SECURITY_INVARIANTS.md`.

### 27.8 The three statements the closure requires

**A. Is sensitive CRM data still persisted in browser durable storage?**
**No.** No build writes contacts, notes, email addresses, phone numbers, lead profiles, `do_not_contact` state or any other CRM record to localStorage, sessionStorage, IndexedDB or Cache Storage. The query cache is in memory, and dies with the tab and on logout. A device that ran an earlier build loses that build's cache on its next start or logout. What does remain on disk: the tenant's configuration vocabulary, the signed-in user's own `sales` row, the Supabase session, UI preferences, and **list filters the user types** (SEC-1BS-13).

**B. Why that residual is accepted.**
None of it is a record the user merely viewed. The configuration is tenant vocabulary, not personal data. The `sales` row is the operator's own profile, needed for authorisation hints. The session is how Supabase authentication works at all. The typed filters are the one item that can hold a patient's name. That is a real exposure on a shared device, which is why it is recorded as SEC-1BS-13 rather than waved through. It is LOW because it needs local access to a device whose user did not log out, and closing it is a product trade-off to make deliberately.

**C. Development signing-key deployment guard status.**
**Enforced by code, and verified.** The key's private or public component cannot enter another tracked file, nothing outside four local/test lines may name it, every Pages publish scans what it ships, and every Supabase push in `deploy.yml` or the makefile is preceded by a blocking check. That check asks the target project's own JWKS and refuses the key — measured to fail against a real Auth server that trusts it. **Limits, stated plainly:** a deliberately obfuscated copy is out of scope; a key imported through the dashboard is caught at the next deploy, not continuously; and `scripts/supabase-remote-init.mjs`'s initial push to a brand-new project (which generates its own keys) is not gated.

### 27.9 Classification

# SECURITY GATE PASSED

- **Question 1 is resolved:** CRM record data is no longer persisted; proven on both admin trees, with 11 of 11 mutations caught.
- **Question 2 is resolved:** the development key is confined by executable guards, including a deploy-time check against the real hosted answer; 28 of 28 mutations caught, plus a live negative against a server that trusts the key.
- **An adversarial review found no Critical or High issue,** and every gap it did find was closed and mutation-verified.
- **Every earlier security result remains green.**

**One verification is still outstanding, and it is not mine to perform:** CI on the pushed commit. Agents do not push. The owner should push `feature/clinical-phase-1` and confirm that the same jobs pass as on `8a896da3` — database, test, typecheck, ESLint, build — with `e2e-test` and `Prettier` still the only pre-existing reds. If any of them fails, this classification must be revisited before Phase 1C.

**Recommendation: proceed to Phase 1C.** Phase 1C has not been started.
