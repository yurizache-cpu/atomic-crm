# Baseline Report — AI Company OS, Phase 0

**Date:** 2026-09-10
**Repository:** fork of [marmelab/atomic-crm](https://github.com/marmelab/atomic-crm) at `github.com/yurizache-cpu/atomic-crm`
**Commit audited:** `a863e2a0` (branch `feature/clinical-phase-1`, which is **0 commits ahead of and 0 behind `origin/main`**)
**Working tree:** 41 modified tracked files + 9 untracked files, none staged, no stash
**Method:** 21 parallel inspection and adversarial-verification agents over the whole repository, plus direct verification of every load-bearing claim below.

> **Language:** this document is in English because `.claude/rules/english-only.md` is an in-force repository rule that mandates English for source, Markdown docs, agent prompts and default config values. The prior product docs under `docs/product/` are Portuguese and therefore already violate that rule. See [Open questions](#13-open-questions), Q1.

---

## 0. Read this first — the three facts that matter most

These are separate findings that are only meaningful together. Each was verified directly.

1. **A push to `main` deploys without passing CI.** `.github/workflows/deploy.yml:2-5` triggers on push to `main` and carries no `needs:` dependency on `check.yml`. Typecheck, lint, unit tests and e2e run *in parallel with* the deploy, not before it. A red build ships.

2. **The entire schema and security rewrite reaches no database.** All seven files in `supabase/schemas/` are modified in the working tree — three new tables, a 43-policy RLS rewrite, new grants, storage lockdown. `supabase/migrations/` contains **none** of it, and `supabase db push` (the only path to production, `deploy.yml:149`) applies migrations only. The deeper cause: `supabase/config.toml` **has no `[db.migrations] schema_paths` key**, so the declarative workflow that `AGENTS.md:33` documents as the source of truth is not actually wired to the CLI. Verified: `grep -n "schema_paths\|\[db.migrations\]" supabase/config.toml` → no match.

3. **Consequently, a deployed instance would be locked out for everyone.** The SPA and the edge functions *do* deploy (they need no migration). `src/components/atomic-crm/providers/supabase/authProvider.ts:61` selects `sales.role` — a column that exists in `supabase/schemas/01_tables.sql:118` and in **zero migrations** (verified). Every login would fail with PostgREST error 42703, which `authProvider.ts:66` interprets as a disabled account and `:119` reports to the user as *"Your account is disabled or has not been provisioned."*

> **Confirmed by the owner, 2026-09-10: no hosted Supabase project exists yet — development is local-only.** This is the single most fortunate fact in the report. Fact 3 is therefore a **latent trap that fires on first deploy**, not a live outage, and every critical security finding in §7 can be fixed *before* any real clinical data exists. That window is the reason Phase 0.5 and Phase 1 are cheap now and expensive later.

The half of the change set that can deploy, deploys. The half that cannot, does not. The result is worse than either alone.

**Immediate corollary — the work is unbacked.** ~1,480 changed lines plus ~800 lines of untracked new files exist only in a working tree, with nothing staged and an empty stash. One `git clean`, one bad rebase, or one disk failure and Phase 0 is gone. See [§10](#10-recommended-first-implementation-phase) — this is the first thing to fix, ahead of any architecture work.

---

## 1. Current architecture

A single-tenant, browser-only CRM SPA talking to a managed Supabase backend. There is **no server-side process that outlives an HTTP request** anywhere in the repository.

```
Browser (React 19 SPA, static files on GitHub Pages)
   │
   ├── ra-core dataProvider ──► PostgREST  ──► Postgres (public schema, RLS)
   ├── supabase-js auth      ──► GoTrue
   ├── supabase-js storage   ──► Storage (attachments bucket)
   └── functions.invoke()    ──► 6 Deno Edge Functions (per-request isolates)
                                    │
                                    └── service-role client / direct pg Pool
```

| Layer | State |
| --- | --- |
| Frontend | Vite 7 + React 19 SPA. `src/main.tsx` → `src/App.tsx` → `<CRM />`. Three layers: `src/components/ui/` (35 shadcn files, ~3.5k LOC), `src/components/admin/` (87 shadcn-admin-kit files, ~11.8k LOC — a generic headless CRUD toolkit over `ra-core`), `src/components/atomic-crm/` (18 subfolders, 260 files, ~25.8k LOC — the CRM domain). |
| Routing | Not a routes file. `<Resource>` and `<CustomRoutes>` are literal JSX inside `root/CRM.tsx:243-266` (desktop) and `:302-327` (mobile). |
| Desktop/mobile | Two separate application trees chosen at render time by `useIsMobile()` (`CRM.tsx:167,215`). Crossing the 768px breakpoint unmounts and remounts the whole app. |
| Data access | One react-admin `DataProvider` from `providers/supabase/dataProvider.ts`, wrapping `ra-supabase-core` → `@raphiniert/ra-data-postgrest`. 9 CRUD methods + 9 custom methods + 7 `withLifecycleCallbacks` hooks. A second implementation for FakeRest powers the offline demo. |
| Backend compute | 6 Deno Edge Functions (`users`, `update_password`, `merge_contacts`, `delete_note_attachments`, `postmark`, `mcp`), ~3,500 LOC. All declared `verify_jwt = false`. |
| Database | Postgres. 13 tables, 4 views, 22 functions, 15 triggers, 43 RLS policies, 10 indexes — all in `public`, plus an empty `private` schema created at `01_tables.sql:11`. |
| Config | Runtime domain options live in a single JSONB row (`configuration`, pinned by `check (id = 1)`) mirrored into a browser `localStorage` blob under key `app.configuration`. |
| Deployment | GitHub Actions on push to `main`: `supabase db push` + `supabase functions deploy` + `gh-pages` publish of `dist/`. No container, no worker, no scheduler, no queue. |

### What the fork has already changed

The fork is not a clean checkout of upstream. Uncommitted in the working tree:

- **Schema:** new tables `lead_profiles`, `acquisition_attributions`, `loss_reasons`; six new `deals` columns (`pipeline_stage`, `stage_entered_at`, `loss_reason_id`, `lost_at`, `converted_at`, `next_action_at`); new column `sales.role`; a nine-value psychology-clinic CHECK constraint at `01_tables.sql:86-96`; eight new functions; three new triggers.
- **Security:** RLS rewritten from upstream's permissive `using (true)` to per-`sales_id` scoping through six SECURITY DEFINER helpers (`02_functions.sql:462-511`); `anon` grants revoked (`06_grants.sql:8-12`) with a default-deny footer (`:62-67`); attachments bucket set private and its policies dropped.
- **Product:** BRL currency, the title "CRM Comercial", nine Portuguese funnel stages hardcoded in `root/defaultConfiguration.ts:11-41`; pt-BR string literals scattered directly into components; the Companies tab removed from navigation while `<Resource name="companies">` stays registered; file uploads disabled; the first-user bootstrap UI deleted from `StartPage.tsx`.

---

## 2. Current stack

| Concern | Choice | Notes |
| --- | --- | --- |
| Language | TypeScript ~5.8.3 | `tsconfig.app.json:35` includes only `src`, `demo`, `vitest-browser.d.ts`. `e2e/`, `supabase/functions/`, `.claude/`, `scripts/` and the config files are typechecked by **nothing**. |
| UI | React 19.1, Tailwind 4, Radix / shadcn, `lucide-react`, `@nivo/bar` | |
| Admin framework | `ra-core` 5.14.7 + shadcn-admin-kit (vendored, not a dependency) | |
| Backend SDK | `ra-supabase-core` 3.5.2; `@raphiniert/ra-data-postgrest` 2.5.1 is **transitive only** | So PostgREST wire syntax is a de-facto public API with no declared dependency. |
| Build | Vite 7, `vite-plugin-pwa`, `rollup-plugin-visualizer` | |
| Validation | `zod` ^4.1.12 declared — **imported in exactly one file**, `supabase/functions/mcp/index.ts:6`, which pins `zod@^3.25`. A major-version split. |
| Database | Postgres via Supabase; extensions `http`, `citext` declared; `pg_net`, `pgjwt` exist only in migrations | |
| Testing | Vitest 4 (three projects), Playwright 1.60 (4 e2e specs), Storybook 9 | |
| Runtime (server) | **None.** No Express/Fastify/Hono; the only Dockerfile is `.devcontainer/Dockerfile`. | |
| Node | v22.23.1 local. No `engines` field in `package.json`; `.nvmrc` is read by neither CI workflow. | |

**Integrations that exist:** inbound email (Postmark) and outbound favicon fetching. That is all. A repo-wide grep for `whatsapp|twilio|stripe|calendly|google.calendar|mercadopago|pagarme` across `src`, `supabase` and `scripts` returns zero files.

---

## 3. Existing database model

13 tables, all in `public`, all `bigint generated by default as identity` except `configuration` (`integer`, pinned to 1).

| Table | Role |
| --- | --- |
| `sales` | Identity + authorization. FK `user_id uuid → auth.users`. Carries `administrator boolean`, `role text check (role in ('owner','operator'))`, `disabled boolean`. |
| `companies` | CRM **customer accounts** — *not* tenants. |
| `contacts` | People. `email_jsonb` / `phone_jsonb` arrays, `tags bigint[]`. |
| `deals` | Opportunities. `contact_ids bigint[]`, `stage text`, plus the fork's `pipeline_stage` CHECK. |
| `tasks` | Human to-dos. `contact_id bigint **not null**`. |
| `contact_notes`, `deal_notes` | Free text + attachments. |
| `tags`, `favicons_excluded_domains` | Lookups. |
| `configuration` | Singleton JSONB settings blob. |
| `lead_profiles`, `acquisition_attributions`, `loss_reasons` | Fork additions (unmigrated). |

Views: `activity_log`, `companies_summary`, `contacts_summary`, `init_state` — all `security_invoker`.

### Structural facts that constrain everything downstream

- **No tenant discriminator exists.** No `company_id`, `tenant_id`, `org_id` or `workspace_id` on any table. The only scoping axis is `sales_id` — a *per-user* column — baked into 43 policies and 6 helper functions. Note the name collision: `company_id` already means "CRM customer account".
- **No audit or event table.** `activity_log` (`03_views.sql:6-72`) is a `UNION ALL` **view** over `created_at` columns that can only ever emit `<entity>.created`. Updates are invisible; a deleted row erases its own history. It will be mistaken for an audit log.
- **Timestamp coverage is thin.** 9 of 13 tables have no `created_at`, 10 have no `updated_at`, 6 have no timestamp at all. Even a naive reconstruction of history is impossible.
- **Referential integrity is partly delegated to array columns** (`contacts.tags`, `deals.contact_ids`) with no FK and no GIN index.
- **No index on `sales_id` on any table**, while every RLS predicate filters on it through a SECURITY DEFINER function call.
- **12 of 22 functions are SECURITY DEFINER** — that is the inherited privilege surface.
- **No table uses `force row level security`**, so the table owner (`postgres` — the role the MCP function's connection pool uses) bypasses every policy.
- Two schemas exist, not one: `private` is created empty at `01_tables.sql:11`. This is the repo's only proof that `create schema` survives the declarative workflow.
- `supabase/config.toml:11` exposes schemas to PostgREST by **explicit allowlist** (`public`, `storage`, `graphql_public`) — a ready-made hard boundary for anything that must not be browser-reachable.

---

## 4. Existing CRM capabilities

Genuinely working and worth keeping: contacts, companies, deals with a Kanban pipeline, tasks, notes (contact + deal), tags, a sales/user directory, CSV import with mapping, an activity feed, a configurable-options settings page, full-text search over contacts and companies, an offline FakeRest demo mode, PWA install with a precaching service worker, and desktop + mobile UIs.

The `dataProvider` exposes 9 custom methods beyond CRUD: `signUp`, `salesCreate`, `salesUpdate`, `updatePassword`, `unarchiveDeal`, `isInitialized`, `mergeContacts`, `getConfiguration`, `updateConfiguration`. Three of them are unreachable dead code (`updateConfiguration` has zero callers outside the provider).

**Domain options are genuinely runtime-configurable** — stages, categories, note statuses, task types, sectors, currency, title, logos all live in the `configuration` JSONB blob and are editable in Settings. This is the repo's existing "configuration, not hardcode" precedent, and it is the right shape. The fork has partly abandoned it by hardcoding pt-BR literals into components (`DealsChart.tsx:21-22` replaced configurable stage lookups with the literals `"Continuidade convertida"` / `"Perdida"`).

---

## 5. Reusable components

Ordered by how much they are worth.

| Asset | Evidence | Why it survives |
| --- | --- | --- |
| **Deny-by-default grants pattern** | `06_grants.sql:8-12`, `:62-67` | The one security primitive that generalizes. Caveat: scoped `for role postgres` **and** `in schema public`, so it must be re-declared per schema and per creating role. Not automatic. |
| **RLS helper-function indirection** | `02_functions.sql:462-511`, used by all 43 policies | Correct shape for tenant predicates: policies call a function instead of inlining a predicate. |
| **`security_invoker` views as read models** | `03_views.sql:6,74,102,146` | Aggregate in the database, not the browser. |
| **JWKS JWT verification middleware** | `_shared/authentication.ts:6-30`; `mcp/index.ts:57-80` | A working, standards-shaped agent authentication path. Keep the auth; discard the tools it guards. |
| **Per-transaction RLS downgrade** | `mcp/index.ts:220-237` | `BEGIN; set_config('role','authenticated',true); set_config('request.jwt.claims',…,true); … COMMIT` — parameterized, deliberate, correct. |
| **AST-based SQL allowlist** | `mcp/validateSql.ts` + its tests | Incomplete (see §7) but the only thing standing between a model and `DROP TABLE`. Extend, do not rewrite. |
| **DB trigger → `pg_net` → Edge Function** | `02_functions.sql:34-45` | The only working async primitive in the repo, and the seed of an outbox. It already exhibits the exact failure modes to design against. |
| **`.claude/adapters/supabase/manifest.json`** | 30 lines | The closest thing in the repo to the `CRMProvider` design the brief demands: a declared capability with detect/generate/apply/review/guard hooks, active *iff* its config block exists. **Copy this shape.** |
| **Harness policy-gate patterns** | `.claude/hooks/` (~4.2k LOC) | A real maker-checker (`block-merger-without-review.mjs` refuses a merge until a review flag exists), a real circuit breaker (`circuit-breaker.mjs:27`, `ITERATION_LIMIT = 45`), a real per-role model router (`harness.config.json:84-97`). Port the *shapes*; **invert the fail-open defaults**. |
| **shadcn-admin-kit + guessers** | `src/components/admin/` (79 exports), `list-guesser.tsx`, `edit-guesser.tsx` | This is how Phase-1's deliberately ugly Agents/Tasks/Events/Decisions/Approvals/Costs screens get built in hours instead of weeks. |
| **Disposable-Supabase e2e harness** | `config.e2e.toml`, `.env.e2e`, `makefile:63-81` | The only place tests touch real Postgres. Load-bearing for CI. |
| **`supabase/schemas/` file-per-concern layout** | 7 files | Reviewable and diffable — **conditional on D6 in §9 being resolved.** |

---

## 6. Technical debt

- **Schema/migration divergence.** The headline item; see §0. Additionally the drift runs *both* ways: migrations create `pgjwt` and `pg_net`, which the declarative schema does not declare; and `20251204201317` explicitly dropped a `merge_contacts` SQL function that `02_functions.sql` still declares — so the next `db diff` will resurrect it.
- **Two contradictory, both-documented migration processes.** `AGENTS.md:33,36` prescribes `supabase db diff` from `supabase/schemas/`; `.claude/skills/writing-migrations/SKILL.md` hand-authors SQL from the TypeScript diff. Neither is enforced, and the declarative one is not even configured.
- **`supabase db reset` is broken right now.** `seed.sql:105` inserts into `loss_reasons`, which no migration creates. Local reset, `supabase start`, and the e2e CI bootstrap all fail.
- **The e2e suite is red for at least three independent reasons**: the seed failure above; `onboarding.spec.ts` drives the signup flow this branch deleted; and every fixture user is created without `role`, so all of them fail the new `is_admin()` gate.
- **Typecheck and lint are red** — 5 and 2 errors respectively, all attributable to the in-flight work (see §12).
- **`npm run build` does not typecheck.** `package.json:11` is `"tsc && vite build"`, but `tsconfig.json` is a solution-style config (`"files": []` + `references`), so bare `tsc` compiles nothing. Build is effectively `vite build` and is always green. The only real gate is `npm run typecheck`.
- **The harness's own build loop is unreliable.** It smoke-tests against FakeRest (`harness.config.json:60`, `demoMode: true`), scopes unit tests to `--changed` (a ticket touching untested files runs zero tests and reports green), and 47 of its own tests fail on this machine.
- **`.husky/pre-commit` blocks every commit on this machine.** Line 1 is `make registry-gen`, and `make` is not installed (verified). Husky aborts the commit with `pre-commit script failed (code 127)` — it does **not** continue to `npx lint-staged`. Confirmed empirically: a commit attempt was rejected and `HEAD` did not move. Any Windows developer without `make` therefore cannot commit at all. Related: `registry.json` is already stale (`LeadCommercialPanel.tsx` is absent from its 223 files), because the step has not run successfully in some time.
- **The fork publishes its own domain code.** `registry.json` contains one item with 223 files, **214 of them under `src/components/atomic-crm`**, republished to gh-pages on every push (`deploy.yml:43,49`). Every domain file added there becomes public distributed content.
- **Reverse dependency in the vendored layer.** `src/components/admin/login-page.tsx:8` and `src/components/supabase/layout.tsx:3` import `useConfigurationContext` from `atomic-crm`. This is in the committed tree, from upstream. `src/components/admin` is therefore not a drop-in generic kit.
- **Governance conflict.** `AGENTS.md:105-107,189` says modify `src/components/admin` and `src/components/ui` freely; `docs/product/07-upstream-strategy.md:30` says avoid them. `CLAUDE.md` `@`-imports `AGENTS.md`, so an agent follows the riskier rule. Settleable on the evidence: `registry.json` lists 214 `atomic-crm` files and **zero** `admin`/`ui` files — those two directories are inbound registry content. **07-upstream-strategy wins.**
- **Dual source of truth for the funnel.** The fork added `pipeline_stage` alongside upstream's `stage` and left both on the type with `??` fallbacks through the Kanban code. `synchronize_deal_pipeline` (`02_functions.sql:539-559`) force-overwrites `stage` on every write, so any non-Atomic writer that sets `stage` has its write silently discarded.
- **`Contact` and `LeadProfile` are denormalized twins** — five lead fields on both types, read from both places.
- **Read/write model conflation.** `getOne("contacts")` transparently reads `contacts_summary`, so a form holds 12 columns that do not exist on `public.contacts`, with nothing stripping them before `update()`.
- Broken script wiring: `makefile:170,173,176` invoke `node scripts/harness-monitor.mjs`, which lives at `.claude/scripts/`. `make watch`/`monitor`/`sessions` all fail.
- No `license` field and no `"private": true` in `package.json` — a publish footgun on an MIT-derived commercial fork.

---

## 7. Security risks

### Critical

1. **Secrets are committed to git, by design.** `.gitignore:36` ignores `.env`; `.gitignore:42` then re-includes it with `!supabase/functions/.env`. Tracked today: `supabase/functions/.env` (Postmark webhook user/password), `.env.development`, `.env.e2e`, and **`supabase/signing_keys.json`, which contains the EC P-256 private scalar `d`**. The `SERVICE_ROLE_KEY` in `.env.e2e` is signed by that key and does not expire until ~2036. These are upstream's dev values — but the *mechanism* means any real secret written there commits by default, and an AI layer's provider keys (`ANTHROPIC_API_KEY`, WhatsApp tokens) would land in exactly that file.

2. **`delete_note_attachments` — any authenticated user can delete any file in the bucket.** `index.ts:57-59` wraps only `AuthMiddleware` (signature + issuer, nothing else) around a handler that reads storage paths from the request body and passes them to `supabaseAdmin.storage.remove()` with the **service-role key**. No owner check, no shared secret.

3. **The MCP edge function is an arbitrary-SQL endpoint.** It exposes `query` (arbitrary SELECT) and **`mutate` (arbitrary INSERT/UPDATE/DELETE)** to any holder of a signature-valid user JWT. Compounding factors, each verified:
   - The pool connects as `SUPABASE_DB_URL` with a hardcoded fallback of `postgresql://postgres:postgres@db:5432/postgres` — i.e. **superuser**. Since no table uses `force row level security`, that role bypasses every policy in the new model.
   - `jwtVerify` is called with `{ issuer }` alone — **no audience check**, so any Supabase-issued token for this project is accepted (confused deputy).
   - `validateSql` descends only one level into CTEs, so a nested `WITH` hides DML from the read-only check — turning the `readOnlyHint: true` `query` tool into a write primitive.
   - OAuth metadata and the 401 challenge are built from the attacker-controllable `x-forwarded-host` header.
   - `get_schema` runs on the raw connection with no role downgrade, returning the full schema map.
   - Full SQL statements — including names, emails and note text — are logged verbatim (`:322`, `:377`). Under LGPD that is an uncontrolled secondary store of personal data.
   - The pool is size **1**, so the whole agent tool surface has a concurrency ceiling of one statement per isolate, and `pg_sleep` is an accepted SELECT.

4. **`users`/`patchUser` privilege-escalation ordering bug.** The fork tightened the second gate to `isOwner`, but `:206` still gates the self/other check on the bare `administrator` flag, and `:210` mutates the user's auth email and ban state **before** the owner check at `:227` runs.

5. **Frontend authorization is fail-open.** `providers/commons/canAccess.ts` (verified in full) returns `true` for admin, `false` for exactly two resources (`sales`, `configuration`), and **`return true`** for everything else. It is a deny-list, not an allow-list. Every future engine resource — agents, approvals, costs, decisions, audit — is readable and writable by any authenticated non-admin the moment it exists.

### High

6. **Bootstrap deadlock.** `is_admin()` requires `role = 'owner'`; `handle_new_user` hardcodes `administrator = false, role = 'operator'`; signup is disabled in three places in `config.toml`; `authenticated` has no INSERT/UPDATE policy on `sales`; the invite endpoint requires an existing owner; and the fork deleted the first-user bootstrap UI from `StartPage.tsx`. **No owner can be created by any path in the repository.** Downstream consequence: marking a deal lost is structurally impossible, because the CHECK requires a `loss_reason_id`, `loss_reasons` is populated only by `seed.sql`, and inserting into it requires `is_admin()`.
7. **Deployed `handle_new_user` still makes the first signup an administrator** (`20260128165057_sso_handling.sql:20-28`) — the schema fix is unmigrated.
8. **Any `auth.users` row becomes an active CRM operator.** No pending/approval state. Anyone who obtains an account by any route gets write access to contacts and notes.
9. **Postmark webhook IP allowlist is spoofable.** `ips.some(ip => authorizedIPs.includes(ip))` over a client-supplied `X-Forwarded-For` that Supabase *appends* to. Combined with the committed Basic-auth password, the webhook's gates are both defeated.
10. **PostgREST filter injection** from inbound-email display names into `.or(\`website.eq.${website},name.eq.${companyName}…\`)`, executed as service role.
11. **Auth config hardening never reaches production.** The `enable_signup = false` flips live in `config.toml`; on a hosted project those settings live in the dashboard, and the pipeline never runs `config push`.
12. **Identity and role are cached in `localStorage` and revalidated only on logout.** Disabling a user or demoting an owner has no effect on an open session.

### Medium / notable

13. **Production sourcemaps and a bundle-analysis page are published to public gh-pages** (`vite.config.ts:64`, `deploy.yml:200-203`).
14. **A telemetry beacon fires on every production load** to `atomic-crm-telemetry.marmelab.com` with the deployment hostname. `App.tsx:34` renders `<CRM />` with no props, so `disableTelemetry` is `undefined`.
15. **CORS is `Access-Control-Allow-Origin: *`** on the shared helper (note: `delete_note_attachments` does not import it at all).
16. **`verify_jwt = false` on all six functions** — no platform-level auth layer, so one missing middleware call is a full bypass, which is exactly what happened in #2.
17. **No rate limiting, quota or cost ceiling** at any layer, including the two functions that execute arbitrary SQL and `update_password`, which sends an email per call.
18. **No prompt-injection defenses.** Notes written by the Postmark webhook are indistinguishable in the database from notes a human typed. There is no provenance or trust-level column.
19. **No supply-chain automation** in `.github/` — no Dependabot, no CodeQL, no secret scanning — on a repository that already has committed key material.
20. **Attachments are three-way inconsistent**: disabled in the UI (`dataProvider.ts:26,245,269` throw), still written by inbound email (`postmark/index.ts:101,126`, minting public URLs that cannot resolve), still deletable by any JWT holder, with the legitimate cleanup trigger uninstalled. One defect, not three. Attachment filenames are generated with `Math.random()`.

---

## 8. Missing infrastructure

Every capability the brief's sections 6–12, 28–34 and 46–47 require, checked by repo-wide grep across `src`, `supabase`, `scripts`, `e2e`, `.github` and `package.json`.

| Capability | Present? | Evidence |
| --- | --- | --- |
| Job queue / background jobs | **Absent** | `pgmq`, `bullmq`, `graphile`, `inngest`, `trigger.dev`, `temporal` → 0 hits |
| Scheduler / cron | **Absent** | `pg_cron`, `Deno.cron` → 0 hits; no `schedule:` in either workflow |
| Long-running compute | **Absent** | No server process; `EdgeRuntime.waitUntil` → 0 hits |
| Event bus / outbox | **Absent** | No `outbox`, no `pg_notify`/LISTEN, no `business_events`. Only fire-and-forget `pg_net` |
| Durable run/step state | **Absent** | No run, attempt or job table anywhere |
| LLM / AI SDK | **Absent** | `@anthropic-ai`, `openai`, `langchain`, `ai` → 0 hits |
| Model router | **Absent** | (the harness has one for *dev-time* roles: `harness.config.json:84-97`) |
| Cost / token accounting | **Absent** | `input_tokens`, `output_tokens`, `cost`, `spend` → 0 product hits |
| Memory / retrieval | **Absent** | `pgvector`, `embedding` → 0 hits |
| Observability | **Absent** | `sentry`, `opentelemetry`, `pino` → 0 hits; `[analytics] enabled = false`; 49 raw `console.*` |
| Audit trail | **Absent** (`activity_log` is a decoy) | `03_views.sql:6-72` |
| Idempotency | **Absent** | The single `idempot` hit is an MCP protocol *hint* |
| Retry / backoff / DLQ | **Absent** | Every `retry` hit is an i18n string or `retry: false` |
| Rate limiting / quota | **Absent** | 0 hits |
| Autonomy levels | **Absent** | `autonomy`, `hitl`, `guardrail` → 0 hits |
| Risk policy | **Absent** | `risk_level`, `risk_polic` → 0 hits |
| Maker-checker / approval queue | **Absent in the product** | All 4 `approval` hits are in `.claude/` dev tooling |
| State machines | **Partial** | Two CHECK-constrained enumerations exist; **transitions and guards** are what is missing |
| Multi-tenancy | **Absent and structurally blocked** | No tenant column; `configuration` is CHECK-pinned to one row |
| RBAC beyond a boolean | **Absent** | `role in ('owner','operator')` + two booleans |
| Concurrency control | **Absent** | No version column, no `for update`, no advisory locks. Last-write-wins |
| Feature flags / kill switch | **Absent** | 0 hits |
| Contract validation | **Effectively absent** | `zod` unused in `src/`, and version-split v4/v3 |
| Secret management | **Worse than absent** | See §7.1 |
| RLS / policy tests | **Absent** | 0 policy assertions across 29 unit files and 4 e2e specs |

---

## 9. Recommended target architecture

Full detail in [ARCHITECTURE.md](ARCHITECTURE.md). The eight decisions that must be settled before Phase-1 code, with recommendations:

| # | Decision | Recommendation | Why it is expensive to reverse |
| --- | --- | --- | --- |
| **D1** | Where does the runtime execute? | **Postgres as durable queue + scheduler, plus one small always-on worker that leases jobs.** | Edge Functions are per-request Deno isolates; a multi-minute agent turn has nowhere to run. Reversing this rewrites every tool call. |
| **D2** | Tenancy shape | **`tenant_id` + RLS, but only on engine tables in a NEW schema.** Treat `public.*` as tenant-one's CRM instance. | Avoids rewriting 43 inherited policies; makes the CRM genuinely swappable; uses the PostgREST allowlist as a hard browser boundary. `configuration`'s singleton CHECK means "add a nullable column" is not available anyway. |
| **D3** | Id strategy at the seam | **UUID/ULID engine PKs; never a FK into `public.*`.** Reference the CRM as `(crm_provider, crm_entity, crm_id)`. | One bigint FK into `deals` silently welds Atomic CRM to the core and makes "replaceable adapter" a slogan. |
| **D4** | What is a principal? | **Engine-owned `principals` table** (human / agent / service), with a mapped `sales` row only when an agent must act *through* the CRM adapter. | Putting agents in `sales` pollutes the human directory, inherits a two-value role CHECK, and makes "agent X acted on behalf of Y" inexpressible. |
| **D5** | Does `ra-core` cross the engine boundary? | **Keep `ra-core` for CRM screens; forbid it in the engine.** | Every type in `types.ts` is `& Pick<RaRecord,"id">`. Unwinding `RaRecord` from agent/run/approval types later is a full rewrite. |
| **D6** | Declarative schema or hand-written migrations | **Make declarative real this week**: add `schema_paths`, add a CI job asserting `supabase db diff` is empty, gate `deploy.yml` on `check.yml`. | This single missing config key is the direct cause of a ~1,000-line security rewrite reaching no database. |
| **D7** | Relationship to the existing chat-service launcher | **Owner must answer.** See §13 Q2. | `harness.config.json:104-109` and `.claude/rules/launcher-interface.md` show an external product ("CRM Builder's chat-service") already drives this repo. Whether the Company OS *is* that launcher, is driven by it, or replaces it determines whether `.claude/` is an asset or dead weight. |
| **D8** | Fork posture | **Hard-fork.** Stop tracking upstream, stop publishing the registry, put the engine outside `src/components/`. | 41 modified files already contradict the fork's own upstream policy; the registry republishes 214 of them. Chasing marmelab while inverting the architecture taxes every merge and buys nothing. |

### Shape

```
apps/
  crm-web/          the existing Atomic CRM SPA, mounted as one module
  ops-web/          Phase-1 admin screens (ugly, guesser-based)
packages/
  engine-core/      domain: company, department, agent, task, event, decision,
                    review, approval, workflow, run, audit. No ra-core, no Supabase.
  policy/           autonomy levels, risk classification, budget checks — pure functions
  ports/            CRMProvider, LLMProvider, MessagingProvider, AdsProvider … interfaces only
  adapters/
    crm-atomic/     implements CRMProvider over the existing dataProvider
    llm-anthropic/
services/
  worker/           the always-on process: leases jobs, runs agents, writes runs+costs
supabase/
  schemas/          public.* (CRM, unchanged) + ops.* (engine, new schema)
```

**Non-negotiables that fall out of the audit:**
- Engine tables live in a schema **not** in `config.toml:11`'s PostgREST allowlist. The browser reaches them only through the worker's API.
- Every engine table carries `tenant_id`, and every policy routes through a helper, following `02_functions.sql:462-511`.
- Every engine table is append-only where it records history, enforced by `REVOKE UPDATE, DELETE` — following the `lead_profiles` precedent, which already has no INSERT/DELETE policy and is written only by a SECURITY DEFINER trigger.
- `force row level security` on every engine table, so the owner role does not bypass policy.
- Deterministic code owns arithmetic, permission checks, risk evaluation, budget checks and threshold detection. LLMs own language, interpretation, classification and recommendation. This is a hard boundary, not a preference.

---

## 10. Migration strategy

**Do not migrate anything yet.** The first move is custodial, not architectural.

**Step 0 — make the work safe (hours, not days).** Fix the 5 typecheck and 2 lint errors, then commit the working tree in reviewable parts on `feature/clinical-phase-1` and push. `make` is absent, so `.husky/pre-commit`'s first line fails harmlessly (verified: husky does not `set -e`); the real gate is `npx lint-staged` → eslint, which the ProfilePage fixes clear. Nothing else in this report can be safely acted on while ~2,300 lines exist only in a working tree.

**Step 1 — restore deployability.** Wire `[db.migrations] schema_paths` into `config.toml`, generate exactly one reviewed migration from the pending schema delta, gate `deploy.yml` on `check.yml`, and add a CI job asserting `supabase db diff` produces empty output. Fix `seed.sql`/`loss_reasons` so `db reset` works again.

**Step 2 — close the bootstrap deadlock and the four critical security holes** (§7 items 1–5) before any real data exists.

**Step 3 — build the engine beside the CRM, never inside it.** New schema, new package, adapter boundary from the first commit. The CRM keeps working untouched throughout; that is the test that the adapter is real.

**Step 4 — retire, don't rewrite.** When the engine owns workflows, the psychology CHECK constraint on `deals` becomes one migration to drop. Deliberately leave it in place until then.

---

## 11. Phase-by-phase implementation plan

See [ROADMAP.md](ROADMAP.md). Summary:

| Phase | Goal |
| --- | --- |
| **0** | Baseline (this document) |
| **0.5** | **Custody & deployability** — commit the work, wire declarative migrations, gate deploy on CI |
| **1** | Security floor — bootstrap an owner, close the critical holes, first RLS tests |
| **2** | Engine foundation — `ops` schema, tenancy, principals, append-only audit |
| **3** | Event + task infrastructure — outbox, queue, worker, scheduler, idempotency |
| **4** | Agent runtime — model router, structured outputs, agent runs, cost accounting |
| **5** | Governance — autonomy levels, risk policy, maker-checker-approver, approval queue |
| **6** | CRM abstraction — `CRMProvider` port + `AtomicCRMAdapter` |
| **7** | Phase-1 UI — ugly admin screens over the engine |
| **8+** | WhatsApp, marketing, finance, growth, Chief of Staff, browser automation, hardening |

---

## 12. Test / build / lint status

Run on this machine (Windows 11, Node v22.23.1, npm 10.9.8, Docker 29.7.2, Supabase CLI 2.117.0). Note that the prior audit recorded `npm install` failing and Docker unavailable — **both blockers are now resolved**: `node_modules` holds 674 packages and 180 binaries.

| Command | Result |
| --- | --- |
| `npm run typecheck` | ❌ **FAIL** — 5 errors |
| `npm run lint` | ❌ **FAIL** — 2 errors |
| `npx vitest run` (app + functions) | ✅ **PASS** — 286 passed, 28 skipped, **0 failed** |
| `npx vitest run` (claude harness project) | ❌ 47 failed / 51 FAIL lines, all in `.claude/hooks/test/*.mjs` |
| Browser-mode tests | ⚠️ **BLOCKED** — Playwright Chromium not installed (`npx playwright install`) |
| `npm run build` | ⚠️ Green, but **does not typecheck** (see §6) |
| e2e | ⚠️ **NOT RUN** — and would be red for three independent reasons (§6) |

**All 7 typecheck/lint errors are attributable to the uncommitted work** (verified). Two of the five failing files are not even modified — `fakerest/dataGenerator/contacts.ts` and `frenchCrmMessages.ts` break *because* `types.ts` gained required fields (`acquired_at`, `operational_status`, …) and `englishCrmMessages.ts` gained a key that their counterparts never got. The branch is half-applied.

```
src/components/atomic-crm/deals/DealListContent.tsx(97,38): TS2339 'pipeline_stage' does not exist on type '{ stage: string; index: number; }'
src/components/atomic-crm/providers/commons/frenchCrmMessages.ts(278,9): TS2353 'note_or_attachment_required' not in MessageSchema
src/components/atomic-crm/providers/fakerest/dataGenerator/contacts.ts(31,3): TS2322 missing acquired_at, last_interaction_at, next_action_at, operational_status, and 4 more
src/components/atomic-crm/settings/ProfilePage.tsx(96,9): TS6133 'record' declared but never read
src/components/atomic-crm/settings/ProfilePage.tsx(97,21): TS6133 'refetch' declared but never read
```

The 47 harness failures are Windows environment incompatibilities (git worktrees, symlinks, POSIX paths) in dev tooling, not product defects. **Zero failures in the `app` and `functions` projects.**

---

## 13. Open questions

Ordered by how much they block. Q1–Q4 need answers before Phase 2.

**Q1 — Documentation language.** `.claude/rules/english-only.md` mandates English for docs and default config values; `docs/product/*.md` (624 lines) is Portuguese, and pt-BR literals are already in `defaultConfiguration.ts` and `seed.sql`. Is the rule in force? The clean resolution: English for everything structural, tenant vocabulary as *data* in `docs/project-context.json` (which `.claude/skills/setup-interview` exists to produce and which **does not exist yet**).

**Q2 — What is the Company OS relative to the chat-service launcher?** ✅ **ANSWERED 2026-09-10** — decision delegated to the architect and recorded in [ADR 0007](adr/0007-launcher-relationship.md): the Company OS supersedes chat-service; the `launcher` block is inert dev-harness config and constrains nothing in the engine. Grounds: `launcher-interface.md` documents every consumer as inert when unset, all four extension points are development mechanics, and all 20 readers of `CHAT_SESSION_DIR` live under `.claude/` — zero product code reads it.

**Q3 — Does a hosted Supabase project exist, and what state is its database in?** ✅ **ANSWERED 2026-09-10 — no. Development is local-only, nothing is deployed.** Consequences: the login lockout (§0.3) is latent rather than live; every §7 critical item can be closed before real data exists; and `supabase db push` must not be run against any project until Phase 0.5 has packaged the pending migration.

**Q4 — Is the psychology pipeline tenant configuration or engine schema?** Today it is a CHECK constraint on the shared `deals` table (`01_tables.sql:86-96`) — the exact thing the brief forbids. Making it configuration means dropping a constraint the current uncommitted work depends on.

**Q5** — Are `docs/product/01-07` formally superseded, retained as dated tenant-one requirements, or still current? They are untracked, so an edit is unrecoverable. Note the reconciliation is narrower than it first appears: the prior docs do not forbid agents outright — they defer them and impose conditions (explainability, scoped tools, approval for writes, audit). Their human-approval posture is **directly adoptable** as the OS approvals model. The genuine conflicts are: AI must not become a second administration interface (`01:79`), and the ban on "distributed architecture" (`01:38`) versus D1's worker.

**Q6** — Is the MCP function an end-user connector (as `doc/` describes, for Claude.ai/ChatGPT) or the internal tool surface for the company's own agents? Do `query`/`mutate` survive at all? They are the fastest agent-to-data path and the largest blast radius, and they are structurally incompatible with "Atomic CRM is a replaceable adapter".

**Q7** — Is inbound email (Postmark) in scope? It is the only untrusted external channel that currently reaches the database, it has the committed webhook password, and it still uploads attachments to a disabled bucket.

**Q8** — Multi-tenant LGPD scope: does each tenant get its own legal basis, retention policy, DPA and DPIA, and does the platform operator become a processor for its tenants?

**Q9** — Must the engine be emulated by the FakeRest provider (`AGENTS.md:137-141`), or is FakeRest scoped to the CRM adapter only? This roughly doubles or halves the cost of every engine table.

**Q10** — Is the marmelab telemetry beacon acceptable in this deployment? One-word fix, but a product/legal decision.

---

## 14. What should NOT be changed yet

- **`supabase/migrations/` history.** Never hand-edit an applied migration. Reconcile via a new generated migration.
- **The exact `pg_dump` formatting of `02_functions.sql`.** `AGENTS.md:33` warns that any deviation produces phantom diffs forever. Regenerate with `npx supabase db dump --local --schema public`, never hand-format.
- **Do not run `supabase db diff` casually.** The next diff emits ONE migration mixing the clinic pipeline, the 43-policy rewrite, the grants and the storage change. Packaging it is a deliberate act (Phase 0.5), not a side effect.
- **The `auth.users → sales` triggers and the `sales` table.** Every policy, helper and the `users` function depend on them.
- **`public.companies` and the `company_id` name.** 30+ call sites plus RLS helpers depend on the current meaning. Introduce a distinct name for tenancy; never repurpose this one.
- **`deals.stage`.** Force-overwritten and redundant, but `not null` and still read by upstream-derived UI. Removing it is a coordinated frontend change.
- **`public.tasks` and its `contact_id not null` FK.** A live feature with e2e coverage and an MCP tool bound to it. The engine needs its own task table; do not overload this one.
- **`.claude/` harness internals.** 30+ hooks depend on each other's `/tmp` state and git topology. Study it for patterns; do not refactor it.
- **`mcp/validateSql.ts`.** Incomplete, but the only guard between a model and `DROP TABLE`. Extend it and its tests; do not rewrite.
- **`config.toml [auth.oauth_server] enabled = false`.** Leave off until MCP token validation gains audience/resource checks and `getBaseUrl` stops trusting `x-forwarded-host`.
- **The attachments bucket.** Do not flip it public or restore the upload path until there is a per-tenant path convention, short-lived signed URLs and a MIME/size allowlist.
- **`supabase/signing_keys.json` and `.env.e2e`.** Do not delete in place — `config.toml:85`, `makefile:73` and `e2e/fixtures.ts:6` depend on them. Rotate deliberately, as its own change.
- **`docs/product/*.md`.** Untracked prior art. Supersede with a dated note; do not edit during reconciliation.
- **The removed signup routes stay removed**, but keep `SignupPage.tsx` and `e2e/onboarding.spec.ts` — they document the flow that owner-provisioning has to replace.
- **The `MobileAdmin` tree.** A separate app with its own offline semantics and resource set. A second, independent scope.
- **Unrelated defects** (`make watch`, the ghpages exit code, the duplicate index) — real, but do not bundle them into schema or deploy changes.

---

## Appendix — how this report was produced

Ten inspection agents (frontend, data layer, database, migrations/deploy, edge functions, security, testing/CI, in-flight work, prior docs, capability gap), each followed by an independent adversarial verifier that re-opened the files and graded every headline claim `CONFIRMED` / `PARTIALLY_TRUE` / `REFUTED` / `UNVERIFIABLE` and reported what the reader missed; then one completeness critic over the merged result. 21 agents, ~3.1M tokens, 1,065 tool calls, zero agent errors.

Several headline claims were corrected by verification and the corrections are reflected above — most importantly that `canAccess` is a **default-allow deny-list**, not an allow-list; that the deploy failure mode is **PostgREST 42703 on every login**, not "no owner can be created"; that `npm run build` **does not typecheck**, so it is not a gate; and that the prior product docs **defer and condition** agents rather than forbidding them.

Claims that remain **UNVERIFIED** are marked as such in §13 (Q3 above all: whether a hosted Supabase project exists and what its database actually contains). Everything else reasons from files in this checkout.
