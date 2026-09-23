# Phase 2C — Operator surface: implementation report

| | |
| --- | --- |
| **Status** | **IMPLEMENTATION IN PROGRESS — READ-ONLY STREAMS ONLY.** The S0 planning gate passed on 2026-09-22 (§1). The owner then recorded the S0 closeout decisions S0-A to S0-H (§2) and authorised the read-only streams. The two browser mutations (`decide_review`, `trip_stop`) and their gates do not exist in any database and are not built by this work: S7 is OPEN (§4). |
| **Base** | `feature/clinical-phase-1` at `5d3a10967cbbef35761ba7777f019d34c32f3553` (the architecture integration record). |
| **Branch** | `feature/phase-2c-operator-surface-implementation`, local, created from the base after CI run 35798036778 (Check #52) passed its core jobs. |
| **Governing records** | [PHASE_2C_BRIEF.md](PHASE_2C_BRIEF.md) and [ADR 0019](adr/0019-company-os-operator-surface.md), with the S0 owner decisions below. |
| **Data** | Synthetic and test data only. BASELINE Q8 OPEN; the production WhatsApp real-data gate CLOSED; no real patient data; no production deploy; Jev not implemented. |

---

## 1. S0 planning gate (2026-09-22)

The spikes ran on a disposable Supabase stack built from the base commit's `supabase/` tree with the e2e configuration (only `project_id` and ports changed), and on a disposable copy of the repository for the frontend. Both were destroyed afterwards; nothing from them was committed. Only these recorded results remain.

**CI gate.** Run 35798036778 (Check #52, push, head `5d3a1096`): Typecheck, Test, ESLint, Build and Database security & reproducibility passed; e2e-test and Prettier failed as the accepted historical baseline (Prettier: `sampleCsv.test.ts`, `canAccess.test.ts`). The overall conclusion is failure, so the run is not green.

| Spike | Result | What was measured |
| --- | --- | --- |
| S0.1 frontend boundary | **PASS**, in-app `src/company-os/` | A prototype compiled (`tsc -p tsconfig.app.json`) and built. Two import-graph methods, each with a positive control, found no ra-core, `@supabase/*`, CRM, admin, engine or `pg` import in the module. All 394 files under `atomic-crm`, `admin`, `ui` and `supabase` stayed blob-identical. No Company OS data in localStorage, sessionStorage, IndexedDB, Cache Storage, cookies or RaStore. The CRM's auth hashes behaved as with a plain `<CRM/>`. Router finding: §3.1. |
| S0.2 authenticated RPC identity | **PASS** | Real GoTrue users, supabase-js 2.90.1. `request.jwt.claims.sub` equals `auth.uid()` inside a DEFINER gate; the access token carries `session_id`; the migration owner reads `auth.sessions` and `auth.users`; a POST to a STABLE function runs read-only; the response waits for the commit; a raising transaction drops `response.headers`. An admin email change keeps the auth user id **and existing sessions**; a new auth user with a former member's email, and a hard-deleted member re-created with the same email, hold nothing. Extra tenant fields → PGRST202; anon → 42501 (401); service_role → 42501 (403). Legacy-claim, forged-session, expired-session, banned, soft-deleted and malformed-claim shapes → OS401; disabled principal, revoked membership, ineligible tenant → OS403; two active memberships → OS409. Refusal bodies for non-member, revoked, other-tenant member and disabled principal are byte-identical. |
| S0.3 cross-tenant isolation | **PASS** | Foreign, wrong-kind and platform ids, and foreign, platform, wrong-kind, malformed and missing cursors, answer byte-identically to a fresh random uuid. Tenant B as the caller sees no tenant-A id. Tenant A's outputs are byte-identical whether tenant B is idle or busy; a platform stop changes them only at the pinned platform-derived paths. Act prototypes (only inside rolled-back transactions) on foreign targets answer exactly like a random uuid and change nothing. |
| S0.4 privilege graph, OD-8a, lock | **PASS** | §3.2 – §3.4. |
| S0.5 output minimisation | **PASS** | A sentinel sweep over every member response found no forbidden value; its positive control fires on raw rows. Legacy fixtures A–C (email-like reviewer, `tripped_by`/`cleared_by`, `requested_by`) appear nowhere; fixture D (free text and configuration labels with email-like substrings) is returned as content. Unlisted event sources come back as `other`; advice is exactly the pinned structured fields, without `response_draft`, and the withheld branches work. |
| S0.6 bundle secrets | **PASS** | The existing scanner and a copy that knew the six new names both passed on a build with the Company OS chunk; non-`VITE_` sentinels set at build time were absent; the Company OS code reads no `import.meta.env` or `process.env`. §3.5. |

No P0 or P1 was found, and no material architecture contradiction.

## 2. S0 closeout: owner decisions (2026-09-22)

These decisions close S0. They amend wording of the brief and ADR 0019 where stated; they reverse no owner decision.

- **S0-A — App router (APPROVED).** The application shell may own the top-level router boundary around the Atomic CRM mount: a narrowly scoped wrapper in `src/App.tsx` is allowed where required to guarantee clean mount and unmount routing between Atomic CRM and the Company OS. This amends the literal wording that `<CRM/>` is not wrapped in another router (brief §0 item 1, §6.2). Constraints: no edit to `CRM.tsx` for the Company OS; no Atomic CRM internal router coupling and no ra-core import in the Company OS; no Company OS route logic inside CRM resources or pages; the CRM's auth and hash routes keep their behaviour; Atomic CRM stays replaceable; the wrapper belongs to the application shell, not the CRM module; tests protect against orphan-router and blocker behaviour, and if a future CRM form introduces an unsaved-changes blocker the cross-surface navigation tests must exercise it. Not a material architecture reversal.
- **S0-B — Stop lock bound.** The browser trip gate's `lock_timeout` is **2 s** (measured: normal acquisition in milliseconds; head-of-line ~1.79 s; well under the 8 s statement and lock timeouts PostgREST applies; a bounded, generic, retryable refusal; the authoritative lock path and deny-wins preserved). No lock-free pre-check.
- **S0-C — Local auth testing.** Local and synthetic harnesses may mint sessions through admin-generated magic links; synthetic users only; password login is not enabled for tests; the auth posture is not changed for test convenience.
- **S0-D — User auth flows for S7 (recorded now, implemented only in S7).** (1) The CRM owner or an administrator may NOT choose an invitee's initial password. (2) A legitimate self-service email change uses GoTrue's normal confirmation flow. (3) A self email change is never forced through admin `updateUserById`. (4) An email never binds or transfers a Company OS principal. S7 stays OPEN.
- **S0-E — Migration owner trust root.** Measured: the repository migration identity is `postgres`, which owns the relevant schemas, holds CREATEROLE and is the trusted migration root; as the owner of `company_os_api` it can DROP and recreate a function after the temporary `ops_operator_api` membership window has closed. The documentation must not claim that the database privilege graph prevents the trusted migration owner from replacing or dropping an exposed function. The boundary against that is: repository migration review; the static migration guard; exact migration allowlists; literal catalogued function names; exact owner, ACL and `pg_default_acl` checks; the post-migration live-catalogue proof; no dynamic function, schema or role names; no standing OD-8a exception. A migration that attempts an unallowlisted CREATE, DROP, CREATE OR REPLACE, ownership transfer, ACL change, default-privilege change or role-membership change on the Company OS capability surface must fail the static guard.
- **S0-F — Literal role grants.** `GRANT <role> TO current_user` is never generated or allowed for OD-8a (S0 measured a Supabase `supautils` backend crash for that shape). The grantee is the exact literal migration identity the migration asserts; no dynamic grantee.
- **S0-G — Role-closure pinning.** Security tests recursively pin the login-role membership closure, every role with CREATEROLE, every role able to become or grant `ops_operator_api`, and the Supabase platform roles relevant to that graph. `ops_operator_api` is NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS, NOINHERIT, with zero members and no login role in its membership closure at rest.
- **S0-H — Secret scanner.** Keep the exact-name scans and add class-based checks for privileged `VITE_*` variables, private or signing key material, database or admin connection strings, service-role secrets, worker and gateway credentials, model or provider secrets, and bearer- or token-shaped leakage. Tests never print the secret they check.

## 3. S0 findings carried into implementation

### 3.1 Router lifecycle (S0.1; resolved by S0-A)

ra-core 5.14.7's internal router calls `createHashRouter` during render, without memoisation and without `dispose()`: every CRM mount leaves orphaned popstate listeners (2 per mount in production, 4 under StrictMode). With a dirty form and an unsaved-changes blocker, a stale blocker can make a Back inside the Company OS call `history.go(0)` (a full reload), and a blocked cross-prefix Back can revert with `history.go(-1)`. Both hazards are **latent at the base commit**: no CRM form enables `warnWhenUnsavedChanges`, `useBlocker` or `usePrompt`. The measured fix, now owner-approved (S0-A), is an application-owned hash router around the CRM mount (ra-core then creates none), created once and disposed on unmount, plus a module-scope guard for POP navigations that cross the `#/company-os` prefix.

### 3.2 Migration identity and ownership mechanics (S0.4)

- **Identity (M12):** on `supabase start`, `db reset` and `migration up` the Supabase CLI 2.117.0 connects as `current_user = session_user = postgres` (application `@effect/sql-pg`), one transaction per migration file; the real e2e stack showed the same identity. PostgreSQL 15.8. CI runs an unpinned `npx supabase`, so the allowlisted migration's own identity assertion is the proof there.
- **Ownership (M9):** transferring a function to `ops_operator_api` needs both the temporary membership (`must be member of role`) and CREATE on `company_os_api` (`permission denied for schema`). The ACL set before the transfer survives it (grantor rewritten). A failed migration rolled everything back, the role, schema and membership included.
- **Post-window mechanics (S0-E):** as the schema owner and a non-member, `postgres` can still DROP an `ops_operator_api`-owned function, and DROP followed by CREATE yields a `postgres`-owned SECURITY DEFINER function whose default ACL lets PUBLIC execute it. A non-owner GRANT or REVOKE EXECUTE is a WARNING-only no-op. CREATE OR REPLACE, ALTER OWNER, SECURITY INVOKER, SET and RENAME are refused (`must be owner`).
- **Default privileges:** a GRANT form with no `IN SCHEMA` creates a global entry that reaches both `ops` and `company_os_api`; `IN SCHEMA ops` and `IN SCHEMA company_os_api` GRANT forms create future EXECUTE paths; a per-schema REVOKE is a silent no-op; no `pg_default_acl` entry reached `ops` or `company_os_api` at the base.
- **Role graph (S0-G):** CREATEROLE roles: `postgres`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_storage_admin` (logins), `dashboard_user` (NOLOGIN); `supabase_admin` is a superuser. `supabase_functions_admin` can grant itself `ops_operator_api` and `SET ROLE` into it; `supabase_auth_admin` and `supabase_storage_admin` are refused self-grants by `supautils`; `authenticator` is refused. The login closure of `authenticated` includes `authenticator`, `postgres`, `supabase_realtime_admin` and, through `authenticator`, `supabase_storage_admin`. `GRANT … TO current_user` crashed the cluster (S0-F).
- **K4/K5 platform parts (M8):** the SECURITY DEFINER functions `authenticated` executes outside `ops` were the six PUBLIC CRM helpers and `graphql.get_schema_version()`, `graphql.increment_schema_version()`; outside `ops`, a role with PUBLIC's rights executes the six helpers plus `get_note_attachments_function_url()`, `get_avatar_for_email(text)`, `get_domain_favicon(text)` and `merge_contacts(bigint, bigint)` (INVOKER). These platform and CRM entries are pinned as observed, not approved.

### 3.3 Kill-switch lock (S0.4; S0-B)

`trip_execution_stop` and `clear_execution_stop` take the kill-switch advisory lock exclusively; `lease_job`, `start_agent_run`, `request_agent_run`, `defer_job`, `job_execution_stop` and `whatsapp_send_eligibility` take it shared. A function-level `lock_timeout = '2s'` bounds the wait inside `trip_execution_stop` (the generic refusal at ~2.0 s, identical whatever holds the lock and whichever tenant it belongs to, nothing created). Without it the 8 s statement timeout cancels with 57014, which PL/pgSQL cannot catch and PostgREST renders as HTTP 500. A trip waiting behind a shared holder delays other tenants' shared acquisitions for at most the bound (1.79 s measured); 8 parallel trips serialise in 18 ms. A review decision behind a held row lock ends at 8.0 s with 57014.

### 3.4 Identity and projections (S0.2, S0.3, S0.5)

- A GUC-forged claims payload carrying a member's real `(sub, live session_id)` resolves: the residual of brief §14 item 3, now known to include `supabase_storage_admin` among the roles able to `SET ROLE authenticated`.
- Email/password login is disabled on both local stacks (`GOTRUE_EXTERNAL_EMAIL_ENABLED=false` from `[auth.email] enable_signup = false`); an admin magic link plus `verifyOtp` mints a real session (S0-C).
- `ops.covering_execution_stop` returns a platform stop first, so availability and `coveringStop` must be computed from stops naming the tenant.
- Every emitted reference must be classified, including a review's `agentRunId` (`review_items.agent_run_id` has no foreign key).
- OS error codes arrive as HTTP 400; clients switch on `code`, never on the HTTP status.

### 3.5 Bundle scanner (S0.6; S0-H)

The existing `scan:build` caught a planted admin database URL only by its connection-string class and missed `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `OPS_GATEWAY_PASSWORD`; a name-based rule does not match inside sourcemaps (escaped quotes) and cannot catch a bare token. Sourcemaps and the PWA precache include the Company OS chunk (code only).

## 4. S7 — user-management prerequisite: OPEN

S7 is not fixed by this work. The browser mutations stay physically absent until a separate, owner-approved S7 change passes red-first tests. The S0 inventory of `supabase/functions/users/index.ts` (unchanged since `103e0294`) found:

- **Unsafe `patchUser` ordering:** `auth.admin.updateUserById` (email, `ban_duration`, `user_metadata`) runs before the owner check; a refused caller's side effects are already committed.
- **Cross-user administrator email mutation:** the cross-user gate checks only `administrator`, so a non-owner administrator (a half-state row, or a disabled administrator) and the active owner can change another person's login email; measured end to end, that email change followed by a recovery link yields a session for the victim's auth id, which resolves to the victim's Company OS principal, while the victim's own session keeps working.
- **Invite binding by email:** the `email_exists` branch binds a new sale to an existing auth user found by `get_user_id_by_email`.
- **Half-states:** `createSale` inserts `administrator` without `role`; `patchUser` with `administrator` omitted demotes `role` to `operator` and keeps `administrator = true`.
- **Ban inconsistency:** the invite path never bans for `disabled: true`, and a non-owner caller's ban or unban skips `sales.disabled`. Brief §14 item 2's "a CRM-disabled member with an unexpired token can lift their own ban" does not hold for auth-banned users on GoTrue v2.196.0 (a banned user's token gets 403 `user_banned` from `/auth/v1/user`); it still applies to CRM-disabled users who were never auth-banned.
- **Owner decisions for S7 (S0-D):** no owner-chosen initial password; a self email change uses the confirmation flow; failure atomicity: no partially retargeted auth or account state and no 200 on a partial failure.
- **Test harness:** the function has none today; its handlers must first move into a testable module, behaviour unchanged.

## 5. Implementation log

Recorded per stream as each stream is committed.
