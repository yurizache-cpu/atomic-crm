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

**Classification: SECURITY GATE PASSED.** See §37.

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
| `REACT_QUERY_OFFLINE_CACHE` | **every CRM record the user viewed** | **was: NO** → now yes |
| `RaStore.auth.is_initialized` | boolean hint | yes |
| `RaStore.auth.current_sale` | own `sales` row | yes |
| `RaStore.*` (ra-core store) | UI preferences | n/a |
| `sb-*-auth-token` (supabase-js) | session tokens | yes, by supabase-js |
| sidebar cookie | UI state | n/a |

`gcTime` is 24 hours and `localStorage` survives a browser restart. That is SEC-1BS-01.

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
**Residual** a session that *expires* rather than logging out does not pass through `logout`. Noted in §21.

### SEC-1BS-02 — Bundle-visualizer report published — **LOW** — *fixed*

`dist/stats.html` (1.6 MB) was emitted into the directory `npx gh-pages -d dist` publishes wholesale, exposing the full module graph, every source path and the dependency inventory. Now emitted to `node_modules/.cache/`, and the build gate flags it if it returns.

### SEC-1BS-03 — Production source maps published — **LOW** — *accepted, documented*

9 MB of original TypeScript incl. comments. Today only the FakeRest demo is deployed (no backend, no data). Recommendation in §22.

### SEC-1BS-04 — Tracked private JWT signing key — **INFORMATIONAL now, HIGH if reused** — *accepted with a control*

`supabase/signing_keys.json` holds an EC P-256 JWK **including the private component**, inherited from upstream (`d348cef1`, "development"). **Proven consequence:** a token signed with it claiming `role: service_role` is accepted by PostgREST and bypasses RLS entirely.
Not exploitable against this system: it is upstream's public dev key, referenced only by `supabase/config*.toml` for the local CLI, shipped by no deploy path, and there is no hosted project. **Required control: never configure a hosted Supabase project with this key.** Hosted projects generate their own; do not override them.

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

SEC-1BS-03, -04, -05, -07, -08, -09, -10, -11, and the session-expiry residual of -01. Each is documented above with the condition that would change its severity. The one requiring an operational commitment rather than a code change is **SEC-1BS-04**.

## 22. RECOMMENDATIONS (not done here, deliberately)

1. **Never reuse `signing_keys.json` for a hosted project.** The only item on this list that is not optional.
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
