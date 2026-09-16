# Roadmap — AI Company OS

**Status:** proposed, pending owner approval.
**Date:** 2026-09-10
**Basis:** [BASELINE_REPORT.md](BASELINE_REPORT.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Phases are small and verifiable. Each closes a cycle of value and is independently revertible. **One phase at a time**; the next starts only when acceptance criteria pass.

This is not the brief's example phase list. It is adjusted for what the audit actually found — most importantly that the repository is currently **not deployable, unpushed, and locked out on login**, which inserts a custodial phase before any architecture work.

---

## Phase 0 — Baseline ✅ complete

Audit and documentation. No functional change. Deliverables: `BASELINE_REPORT.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `DECISIONS.md`, `CLAUDE.md`, `docs/adr/0001-0013`.

**Re-verified 2026-09-11** by a 77-agent adversarial pass against `729f5966`: 232 findings — 98 confirmed, 31 stale, 31 wrong, 71 previously undocumented. Corrections are folded into the documents above and marked with their date. `DATABASE.md`, `AGENTS.md`, `WORKFLOWS.md`, `PERMISSIONS.md`, `SECURITY.md`, `INTEGRATIONS.md` and `COSTS.md` are named by the brief and are deliberately **not** written yet — see `ARCHITECTURE.md` §12: each lands with its phase, because documenting a system that does not exist produces fiction that later gets trusted.

---

## Phase 0.5 — Custody and deployability 🔴 **do this first**

> **Revised 2026-09-11.** The original justification — "~2,300 lines exist only in a working tree and are lost to one `git clean`" — is obsolete: the work is committed as `652784b3`, `103e0294`, `2b5f20bb`, `729f5966`, and typecheck and lint both pass. The phase still comes first, for three *different* reasons: the branch has **never been pushed** (one disk, and CI has never run on any of it); the schema rewrite is still backed by **zero** migrations; and two of this phase's own steps are **blocked by defects inside it** (see the ordering note below).

**Goal.** Get the existing work off this machine and through CI, make the repository deployable, and make CI a real gate.

> **Ordering matters more than it looks — three steps must move.**
> - **`seed.sql` is a prerequisite, not a cleanup task.** `supabase db reset` fails on `seed.sql:105` (`loss_reasons`), and so does `.claude/scripts/apply-migrations.mjs:145-151`, which falls back to `npx supabase start`. So the automation meant to package this phase's migration is blocked by the defect this phase is meant to fix. Fix `seed.sql` **by hand, first, outside the harness**. It is now step 1.
> - **Answer Q4 before generating the migration.** Step 5 freezes the nine-value psychology `deals_pipeline_stage_check` and the five-value `operational_status` CHECK into permanent history, and this phase's acceptance criterion (`db diff` empty) makes that irreversible. `CLAUDE.md` rule 2 names this exact constraint as "the mistake to not repeat". Decide first; the answer changes what the migration contains.
> - **Preflight the environment.** Every remaining step needs a local Supabase and **the Docker daemon is not running** (verified 2026-09-11: the CLI reports 29.7.2, `docker info` fails on the named pipe). `make` is absent (use `npm run`/`npx` directly). Check Docker before starting, or the phase stalls on its first command and the failure looks like a code problem.

**Scope.**
1. **Fix `seed.sql` / `loss_reasons` so `supabase db reset` and `supabase start` work.** Blocks steps 5, 8 and the harness. Do this first.
2. **Push.** `git push -u origin feature/clinical-phase-1` and open a PR so `check.yml` runs — the first CI execution these four commits will ever get. (The owner does this; agents never push.) ~~Commit the working tree in reviewable parts~~ ✅ done, in the suggested (a)/(b)+(c)/(d) split.
3. ~~Fix 5 typecheck errors + 2 lint errors~~ ✅ **done in `2b5f20bb`**, and ✅ **the 13 `app` tests that commit broke are fixed** (2026-09-11) — the suite is green at 189 passed. Two were real product bugs, not stale tests: the deal importer grouped by `pipeline_stage` while the FakeRest generator set only `stage`, and `deals_sample.csv` still named upstream stages.
3a. **Register the three new resources, or stop using them.** ✅ *Half done (2026-09-11):* `lead_profiles` and `acquisition_attributions` now have FakeRest generators derived from the contact fields `contacts_summary` mirrors, so the demo provider no longer throws `Undefined collection`. ⚠️ *Still open:* none of the three is registered as a react-admin `<Resource>`, and `loss_reasons` has no FakeRest collection — `DealInputs.tsx:108-111` still reads it.
4. ✅ **`[db.migrations] schema_paths` added** (2026-09-11). The six schema files are registered in dependency order; `07_storage.sql` is deliberately excluded because it is DML that `db diff` cannot emit, and its intent is now carried by a hand-written migration instead. ⚠️ Unverified — needs Docker to prove the CLI reads it.
5. **Answer Q4, then** generate **one** reviewed migration from the pending schema delta. Review it line by line; it mixes three new tables, seven columns, eight functions, three triggers, the whole policy surface and the grants. Two things the generator will **not** give you, and both need hand-written SQL: the attachments-bucket lockdown (`07_storage.sql:8` is `update storage.buckets …` — DML, which `db diff` never emits) and, if the `pg_net` hop is still wanted, its trigger and `create extension`. Also expect it to **rewrite `contacts_summary`** (it now joins two unmigrated tables) and to flip `init_state` to `security_invoker = on` — a pre-auth view whose access grant assumed the old behaviour. This migration is not additive.
6. ✅ **`deploy.yml` is gated** (2026-09-11) — a `gate` job runs typecheck, lint and all three unit projects, and every deploy job `needs: gate`. The `claude` project now runs in CI too; it never did, which is how five silent hook defects shipped. ⚠️ Still to do: the CI job asserting `supabase db diff` is empty (needs Docker).
7. Repair the e2e suite. Four reasons, not three: the seed failure (step 1); `onboarding.spec.ts` drives a deleted signup flow; `config.e2e.toml` now sets `enable_signup = false` in all three places; and — correcting the original diagnosis — the fixtures' missing `role` is **not** why they fail `is_admin()`. The e2e database applies `supabase/migrations` only, so it has no `role` column and no new `is_admin()` at all; the app then selects `role` (`authProvider.ts:61`) and every identity fetch returns PostgREST 42703, breaking login for **all four specs**. Also: `e2e/fixtures.ts:11-22` does not truncate the new tables.
8. Resolve the `AGENTS.md` vs `07-upstream-strategy.md` conflict on `src/components/admin` / `src/components/ui` — state one rule, delete the other.
9. ✅ **`.husky/pre-commit` fixed** (2026-09-11) — it now calls `npm run registry:gen` + prettier directly instead of `make`. A latent Windows bug in `scripts/generate-registry.mjs` that wiped `registry.json` (223 files → 1) was fixed at the same time; `registry.json` itself is left at its committed state pending ADR 0008. Still to do here: **delete or rewrite `doc/src/content/docs/developers/getting-updates.mdx`**, which instructs the reader to overwrite all 214 registered fork files with upstream via `shadcn add … -o`.
10. **Approve or reject the ten remaining `Proposed` ADRs.** Three are now `Accepted` (0007, plus 0011 and 0013 decided by the owner in the Phase 0.5 brief). 0001, 0002 and 0012 are rated *very high* reversal cost. **0002 cannot be accepted before 0012**, which supplies the tenancy mechanism it depends on. See [DECISIONS.md](DECISIONS.md) for the reconciled table. *(2026-09-13: 0012 — the precondition for 0002 — and 0014, 0015 and 0003 are now Accepted; see DECISIONS.md for current statuses.)*

**Files.** `supabase/seed.sql`, `supabase/config.toml`, `supabase/migrations/<new>.sql`, `.github/workflows/{check,deploy}.yml`, `e2e/*`, `AGENTS.md`, `.husky/pre-commit`, `doc/src/content/docs/developers/getting-updates.mdx`.

**DB.** One generated migration, plus hand-written SQL for the storage lockdown (DML, never emitted by `db diff`). No new design.

**Tests.** `npm run typecheck`, `npm run lint`, unit, and a green `supabase db reset` + e2e run.

**Acceptance.** Branch pushed and green in CI; typecheck/lint/unit/e2e all green; `supabase db reset` succeeds from scratch; `supabase db diff` empty; a red build cannot deploy; a commit succeeds without `--no-verify`.

**Risks.** The generated migration is large and mixes concerns — review it as if it were hand-written. Do not hand-edit historical migrations. Do not bundle unrelated fixes (`make watch`, ghpages exit code, duplicate index).

**Rollback.** Every step is a separate commit; the migration is the only irreversible artifact and is reviewed before it is applied anywhere.

---

## Phase 1 — Security floor

**Goal.** A deployed instance that a real person can log into, with the critical holes closed, before any real data exists.

**Scope.**
- **Owner bootstrap.** Today no code path can create the first owner (`is_admin()` requires `role='owner'`; the trigger hardcodes `operator`; signup is off; `authenticated` has no INSERT on `sales`; the bootstrap UI was deleted). Build a deliberate, auditable provisioning procedure and document it.
- Fix `delete_note_attachments` (any authenticated user can delete any file via the service role).
- Fix the `users`/`patchUser` ordering bug (auth email and ban state mutate before the owner check).
- Decide and act on the MCP function (Q6) — at minimum add audience validation, stop trusting `x-forwarded-host`, close the nested-CTE bypass in `validateSql`, stop logging raw SQL containing personal data, and stop connecting as superuser. *(Done 2026-09-13: the function is removed and kept out of the committed deploy paths; ADR 0011 addendum, SI-03.)*
- Invert `canAccess` to deny-by-default.
- Rotate committed secrets; remove the `!supabase/functions/.env` negation from `.gitignore`; move real secrets to the deploy provider only.
- Disable the marmelab telemetry beacon (Q10); stop publishing sourcemaps and `stats.html`.
- Resolve the three-way attachments inconsistency: either undeploy the Postmark upload path or finish the bucket design.

**Files.** `supabase/schemas/{02_functions,05_policies,06_grants,07_storage}.sql`, `supabase/migrations/<new>.sql`, `supabase/functions/{delete_note_attachments,users,mcp,postmark}/`, `supabase/functions/mcp/validateSql.ts` (+ its test), `supabase/functions/merge_contacts/index.ts`, `src/components/atomic-crm/providers/commons/canAccess.ts` (+ a new test), `.gitignore`, `vite.config.ts`, `src/components/atomic-crm/root/CRM.tsx`.

**DB.** Migration adding the owner-provisioning mechanism; `force row level security` where appropriate; hand-written SQL to close the attachments bucket.

**Tests.** **First RLS test suite** — run as owner, operator and anon, asserting scoped reads, denied writes and admin-only mutations. This is the highest-value test debt in the repo. Plus a regression test per closed hole, specifically: `WITH x AS (SELECT 1) DELETE FROM contacts` must be **rejected** by `validateReadOnly` (it is accepted today — verified); `SELECT extensions.http_get(…)` must be rejected or unreachable; `merge_contacts` must preserve the loser's `lead_profiles` and `acquisition_attributions` rows (and above all `do_not_contact`); `canAccess` must deny an unknown resource.

**Rollback.** Every item is a separate commit. The auth-touching changes (owner provisioning, `force row level security`) are the only ones that can lock out a working instance — rehearse them on a throwaway project, and keep the prior migration's `down` path written before applying. The edge-function fixes are independently revertible by redeploying the previous function version.

**Acceptance.** A fresh deployment can be bootstrapped to a working owner login; each §7 critical item has a test proving it is closed; no secret material is tracked in git.

**Risks.** Touching auth can brick login — the current state is already broken, so verify against a throwaway project first. Do not remove the `role='owner'` condition from `is_admin()` to "unblock" bootstrap; the condition is correct, the provisioning path is what is missing.

---

## Phase 2 — Engine foundation

**Goal.** The `ops` schema exists, is multi-tenant, is invisible to browsers, and records history immutably. No agents yet.

**Scope.** **Step 0: create the workspace** — package-manager workspaces, tsconfig project references, and the lint rule that enforces the `ra-core` boundary mechanically ([ADR 0005](adr/0005-ra-core-boundary.md); Q13). None of `apps/`, `packages/`, `services/` exists today, so nothing below has anywhere to live. Then: `ops` schema (kept out of `config.toml:11`'s PostgREST allowlist); `ops.tenants`, `ops.departments`, `ops.principals`; `ops.audit_log` (append-only, `REVOKE UPDATE, DELETE`); tenant-scoped RLS helpers; `packages/engine-core` with no `ra-core` and no Supabase import.

**Prerequisites — answer before the first `ops` policy is written.** **Q11:** how does the worker get tenant context? The helper pattern this phase was told to copy is `auth.uid()`-based and the worker holds no JWT. **Q12:** does the MCP function survive? While it holds a superuser pool with `query`/`mutate`, `ops` is *not* unreachable, and this phase's isolation test would be testing the wrong channel. *(2026-09-13: Q11 is settled by ADR 0012 as accepted — the tenant comes from a live lease. Q12 is settled: the MCP function is removed.)*

**Files.** `package.json` (workspaces), `tsconfig*.json`, `eslint.config.js`, `supabase/schemas/*.sql`, `supabase/migrations/<new>.sql`, `supabase/config.toml`, new `packages/engine-core/`.

**DB.** New schema; UUID PKs; `tenant_id` everywhere; `force row level security`; no FK into `public.*`. Append-only enforced by `REVOKE UPDATE, DELETE` — note there is **no existing example in this repo to copy**; `lead_profiles` is the inverse shape (see `ARCHITECTURE.md` §4). *(2026-09-13, built early in Phases 1A–1C: entity tables have server-generated uuid keys and three non-entity tables use other keys (ADR 0003 as accepted); `ops.tenants` and `ops.worker_instances` carry no `tenant_id` (ADR 0002 addendum).)*

**Tests.** RLS tests proving cross-tenant isolation; a test proving `ops` is unreachable via PostgREST **and** via the MCP function's connection; a test proving audit rows cannot be updated or deleted; a lint/CI test asserting no engine file imports `ra-core` or `supabase-js`. *(2026-09-13: the Data API half is `opsDataApiExposure.mjs`, SI-15. The MCP half is moot: the function is removed and SI-03 keeps it out.)*

**Acceptance.** Two tenants coexist with provably zero cross-visibility **on every channel**; the CRM is untouched and still green.

**Risks.** Getting tenancy wrong here is the most expensive mistake in the roadmap (D2). Do not add a tenant column to `public.*` — `configuration`'s singleton CHECK blocks it and 43 policies would need rewriting.

**Rollback.** `ops` is additive and touches no CRM table, so the whole phase reverts by dropping the schema — as long as rule "no FK into `public.*`" held. That rule is what makes this phase reversible; treat a violation of it as a release blocker, not a style issue. *(2026-09-13: one capability, `ops.purge_inbound_email_ledger` (Phase 1B, SI-18), deletes `public.inbound_emails` rows. No `ops` foreign key into `public` exists, so dropping the schema still reverts `ops` without touching the CRM's structure.)*

---

## Phase 3 — Events, jobs, worker, scheduler

**Goal.** Work can be scheduled, queued, executed durably and retried — with no LLM involved yet.

**Scope.** `ops.events` (append-only), `ops.outbox`, `ops.jobs`, `ops.schedules`; `services/worker` (the always-on process); job leasing via `FOR UPDATE SKIP LOCKED`; idempotency keys; classified retries with backoff and a dead-letter queue; scheduler tick; structured logging with correlation ids; webhook ingress that writes to the outbox and returns immediately. *(2026-09-13: `ops.events` exists since Phase 1C; it is never updated but is deletable by the owner, and it is itself the outbox (ADR 0015 §7). `seq` is internal only. An event a webhook produces carries references, never the message body, notes, emails or clinical content (ADR 0015 owner decision 6).)*

**Also in scope:** resolve the `zod` v4/v3 split **here, not in Phase 4**. `package.json:97` declares `^4.1.12` while `supabase/functions/mcp/index.ts:6` imports `npm:zod@^3.25`, and this is the phase where an event payload schema first crosses the Deno/Node boundary (webhook ingress → `ops.events` → worker). Sharing a schema across a major-version split is the bug; Phase 4 is too late. *(2026-09-13: the MCP function, the v3 importer cited here, is removed; re-check the split before this phase.)*

**Files.** New `services/worker/`, `supabase/functions/<ingress>/`, `supabase/schemas/*.sql`, `supabase/migrations/<new>.sql`, `package.json` (zod alignment).

**DB.** `ops.events` (append-only), `ops.outbox`, `ops.jobs`, `ops.schedules`, `ops.idempotency_keys`; leasing columns and the partial indexes the `FOR UPDATE SKIP LOCKED` query needs. If `LISTEN`/`NOTIFY` is used to cut idle latency (`ARCHITECTURE.md` §8), the `pg_notify` trigger lands here too.

**Tests.** **Idempotency tests** (the same event delivered twice produces one effect); retry/backoff/DLQ tests; concurrency tests (two workers, no double-execution); a scheduled job that is provably idempotent; a crash test (kill the worker mid-job and assert the lease expires and the job completes exactly once).

**Acceptance.** A webhook produces exactly one event, one job and one effect under duplicate delivery; a killed worker resumes without losing or duplicating work; a daily schedule fires once; measured wake-up latency meets the stated budget.

**Risks.** This is where a naive design silently duplicates external actions. Build idempotency in from the first commit, not after. Second risk: the worker is the first always-on process in this project — it needs a deployment target, a restart policy and log shipping, none of which exist today, and none of which are a Postgres problem.

**Rollback.** Additive: no CRM behaviour depends on the worker yet. Stop the worker and the system returns to Phase 2 behaviour. Keep it that way — nothing in `public.*` may become dependent on a job running until the queue has proven itself.

---

## Phase 4 — Agent runtime

**Goal.** An agent can run, produce a schema-validated structured output, and have its cost recorded.

**Scope.** `LLMProvider` port + Anthropic adapter; model router (4 tiers, cheap-first with escalation); `ops.agent_runs` and `ops.tool_invocations`; `ops.budgets` with daily/monthly/per-task limits and warn/throttle/fallback/require-approval behaviour; typed tool registry; short-term + retrieved memory with `kind` (fact/memory/inference/recommendation/decision), `source`, `confidence`, `expires_at`. Resolve the zod v4/v3 split first.

> ⚠️ **Ordering fix (2026-09-11): the `CRMProvider` port must land here, not in Phase 6.** This phase's acceptance is "one real agent (Reception) runs end-to-end", and a clinic reception agent necessarily reads and writes contacts and leads. With the port still four phases away, its tools would reach the CRM through whatever exists — the react-admin dataProvider, PostgREST filter syntax, `contacts_summary`, JSONB email shapes — i.e. exactly the coupling [ADR 0005](adr/0005-ra-core-boundary.md) and `ARCHITECTURE.md` §5 forbid, written into the engine's first working code path and then load-bearing. The port is the **most reversible artifact in the plan and it was scheduled last.** Either pull Phase 6 forward to here, or give Reception a tool surface that touches no CRM data. Pulling the port forward is cheaper.

**Files.** `services/worker/`, new `packages/ports/`, `packages/adapters/crm-atomic/`, `supabase/schemas/*.sql`, `supabase/migrations/<new>.sql`, `src/components/atomic-crm/` (unchanged — that is the test).

**DB.** `ops.agent_runs`, `ops.tool_invocations`, `ops.budgets`, `ops.memories`, `ops.kill_switch` (or an equivalent single-row control). Cost columns on `agent_runs` are written in the same transaction as the run, never asynchronously — an unrecorded cost is the one failure mode that hides all the others.

**Tests.** Structured-output validation tests (malformed model output is rejected, not parsed); router tests (escalation happens only on the stated triggers); budget tests (exceeding a limit blocks, and is recorded); **a kill-switch test** that trips it and asserts the next run is refused; a test that a provider error mid-run still writes a cost row.

**Acceptance.** One real agent (Reception) runs end-to-end from an event, returns a validated object, and every invocation appears in `agent_runs` with tokens and cost. Cost by agent / department / task / model is queryable. The owner can stop **all** agent execution in one action, from the UI and from a CLI.

**Risks.** Runaway API cost. Budgets **and the fleet-wide kill switch** are deliverables of this phase with their own acceptance criteria — not a note. Per-agent budgets do not bound twenty agents, a retry storm, or a workflow spawning runs in a loop; only the global switch and a global daily ceiling do.

**Rollback.** The kill switch *is* the rollback for this phase: it stops execution without a deploy. Beyond that, the phase is additive — no CRM write path depends on an agent until Phase 5 wires approvals.

---

## Phase 5 — Governance

**Goal.** Risk, autonomy, maker-checker-approver and the human approval queue are real and enforced by code.

**Scope.** `packages/policy` (pure, deterministic): autonomy levels 0–4, risk classification from configurable rules, budget checks. `ops.decisions`, `ops.reviews`, `ops.approvals`, `ops.risk_policies`. Approval queue UI. Confidence used as routing metadata only, with risk overriding it.

**Files.** New `packages/policy/`, `services/worker/`, `apps/ops-web/` (approval queue), `supabase/schemas/*.sql`, `supabase/migrations/<new>.sql`.

**DB.** `ops.decisions`, `ops.reviews`, `ops.approvals`, `ops.risk_policies` (**seeded rows, not code constants** — the inherent-risk list is tenant-shaped), `ops.autonomy_levels` or an enum on `principals`. Approval records are append-only and carry the evidence snapshot they were granted against, so an approval cannot be silently re-used for a changed proposal.

**Tests.** **Risk-policy tests** as a table-driven matrix; maker-checker tests (the same agent cannot check its own work); approval tests (a HIGH-risk action cannot execute without a recorded human approval); fail-closed tests for every gate — **including the one that matters most: an action matching no rule must evaluate to CRITICAL and be refused**, not fall through to LOW; a test that a maker's self-reported confidence cannot skip a checker that risk requires.

**Acceptance.** A HIGH-risk proposal cannot execute without human approval, and the whole chain — proposal, evidence, review, risk verdict, approval, execution, result — is reconstructable from `audit_log`. LOW-risk actions execute without asking the owner anything.

**Risks.** Approval fatigue kills the control. If the owner is being asked about trivial things, the risk policy is wrong — treat that as a bug **with a ticket**, not a preference.

**Rollback.** Governance is additive but it is a *gate*: reverting it does not restore a safe state, it removes the brake. So the rollback for a bad policy change is a **policy row change**, not a code revert — which is the main argument for `risk_policies` being data. Keep the previous ruleset versioned and restorable.

---

## Phase 6 — CRM abstraction

> **Pull this forward into Phase 4** — see the ordering note there. Kept as its own phase for the work that remains once the port exists: completing the adapter surface, the contract test suite, and proving the engine compiles without it.

**Goal.** `CRMProvider` exists as a real hand-written port, and the engine speaks only to it.

**Scope.** `packages/ports/CRMProvider`; `packages/adapters/crm-atomic` implementing it over the existing dataProvider; engine code referencing the CRM only as `(crm_provider, crm_entity, crm_id)`. PostgREST filter syntax, react-admin idioms, view names, JSONB shapes and array columns all become adapter-internal.

**Files.** `packages/ports/CRMProvider.ts`, `packages/adapters/crm-atomic/`, `packages/engine-core/`, `eslint.config.js` (the boundary rule).

**DB.** None. That is the point — if this phase needs a migration, the boundary is in the wrong place.

**Tests.** A contract test suite the adapter must pass — the same suite a future `NativeCRMAdapter` will pass. A lint rule or test asserting no engine file imports `ra-core` or `supabase-js`.

**Acceptance.** The engine compiles with the adapter package removed from its imports; the CRM app still runs untouched.

**Rollback.** Pure refactor behind a stable interface; revertible by restoring the previous import paths. The risk is not rollback, it is a port designed by tracing today's calls — that reproduces PostgREST in a new shape and passes every test.

**Risks.** Adopting today's `CrmDataProvider` type would bake PostgREST into the engine — it is `ReturnType<typeof …>` of the Supabase implementation and neither provider is actually checked against it. Write the port by hand.

---

## Phase 7 — Phase-1 UI

**Goal.** The owner can see and steer the company. Deliberately ugly.

**Scope.** `apps/ops-web`: Dashboard, Agents, Departments, Tasks, Events, Decisions, Approvals, Workflows, Costs, Logs, Integrations, Settings. Tables and cards, built on `src/components/admin` guessers. The activity stream (`14:02 webhook received → 14:03 lead classified → 14:04 response sent`) with every step inspectable. `<CRM>` mounted as one module. *(2026-09-13: the Events page and the activity stream are tenant-facing event readers. They page with a tenant-scoped or opaque cursor, never `ops.events.seq` or `ops.job_events.id` (ADR 0015 owner clarification, SI-26), and show minimised payloads.)*

**Files.** New `apps/ops-web/`, reusing `src/components/admin/` guessers; `src/components/atomic-crm/root/CRM.tsx` mounted as a module (not modified).

**DB.** None beyond read APIs over existing `ops` tables.

**Tests.** A test per screen that it renders from real data; **a test that the kill switch is reachable in one action**; a test asserting no screen can render an agent as "working" without a corresponding open `agent_run` row.

**Acceptance.** Every "working" status corresponds to a real run; every rendered communication is a real message. No simulated activity, ever.

**Risks.** Two. The UI becomes the place governance is enforced — it must not be; `canAccess` returning `true` is the cautionary example, and the frontend only hides menus. And scope creep: this phase is deliberately ugly, and "while we're here" is how it stops being a week.

**Rollback.** Read-only UI over existing data; revertible by not deploying it.

---

## Phases 8+ — Operations

Each follows the same template and is sequenced by dependency, not appetite.

| Phase | Goal | Key risk |
| --- | --- | --- |
| **8 — WhatsApp** | Webhook → normalize → identify contact → classify intent → route → respond or escalate. **Ships with its own LGPD floor** (sequencing rule 7): lawful basis and retention per data class, working erasure that also clears agent memory and derived summaries, a consent/`do_not_contact` state no code path can silently drop, and a test that a general agent's tool surface cannot reach clinical records. | LGPD, sensitive content, account blocking, invasive automation. Consent and opt-out are features, not settings. `merge_contacts` silently cascading away `do_not_contact` (`BASELINE_REPORT.md` §7.5a) is the worked example of how this goes wrong quietly. |
| **9 — Marketing** | Google Ads + GA4 + CRM attribution; Ads Analyst + Reviewer | Misleading attribution; budget changes are HIGH risk by default |
| **10 — Finance** | Revenue, costs, CAC, AI spend — **deterministic services, never LLM arithmetic** | Numbers that look precise without data behind them |
| **11 — Growth & experiments** | Bottleneck detection across Marketing/CRM/Finance; `ops.experiments` with a PROPOSED→CONCLUDED lifecycle | An agent claiming an experiment succeeded without measurable evidence — forbid it structurally |
| **12 — Chief of Staff** | Weekly executive briefing from department summaries, not from micromanaging tasks | Opaque recommendations; every claim must link to data, period and rule |
| **13 — Browser automation** | Controlled fallback for interfaces without APIs | Never unrestricted access to authenticated services. Prefer official APIs always |
| **14 — Hardening** | Full test matrix, DR/backup/restore drill, LGPD retention and erasure, observability backend | Backup and restore have never been exercised; that is a Phase-1 obligation for a clinic, deferred here only because Phase 0.5–1 must come first |
| **15 — Isometric UI** | Visual company representing real backend state | Do not start before the engine is stable |

---

## Definition of done

A phase is complete when its work is: **working, tested, logged, permission-controlled, cost-tracked, failure-handled, documented, observable, secure, and reversible where possible** — and its documentation (`DATABASE.md`, `PERMISSIONS.md`, `COSTS.md`, …) has been written or updated as part of the phase, not after.

---

## Sequencing rules

1. **Phase 0.5 before everything.** An unpushed branch, a schema backed by no migration, and a repository whose own reset is broken make every other measurement unreliable. *(Revised 2026-09-11: the original wording said "uncommitted work" — that part is done.)*
2. **No integration before governance.** WhatsApp and Ads are Phase 8+ because an agent that can message patients or spend money before Phase 5 exists has no brake.
3. **No agent before cost accounting.** Phase 4 ships budgets **and the kill switch** in the same phase as the runtime.
4. **No tenant two before Phase 2.** Retrofitting tenancy is the most expensive reversal on this list.
5. **Answer the questions that actually block, at the phase that they block.** *(Revised 2026-09-11: the original rule named Q2 and Q3, which are both already answered.)* **Q4 blocks Phase 0.5** — generating the migration freezes the psychology CHECKs into permanent history. **Q1 blocks Phase 2** (where tenant vocabulary must become data). **Q11 and Q12 block Phase 2** and must be settled as part of accepting [ADR 0002](adr/0002-tenancy-model.md). **Q13** blocks the first phase that needs a package boundary, which is Phase 2. *(2026-09-13: Q11 is settled by ADR 0012, and Q12 by removing the MCP function.)*
6. **No irreversible choice before the reversible one it depends on.** The `CRMProvider` port is the cheapest artifact on this list and was scheduled last, behind the agent runtime that would couple to the CRM without it. When ordering two phases, ask which one is harder to undo and put the *other* one first.
7. **LGPD obligations ship with the data that creates them, not in a hardening phase.** Retention, erasure, consent state and the clinical boundary are Scope/Tests/Acceptance items of **Phase 8** (the first phase that stores patient-adjacent content), not Phase 14. A clinic that has been ingesting WhatsApp for six months before erasure works has a compliance problem, not a backlog item.
8. **Approve the ADRs before implementing them.** Six are still `Proposed`, two of them rated *very high* reversal cost and scheduled for Phases 2 and 3. An unapproved ADR is not a decision; building on one converts a reversible choice into an accident. *(2026-09-13: see DECISIONS.md for current statuses. 0001 and 0002 were implemented in part by Phases 1A–1C, so their review is overdue rather than upcoming.)*

---

## Status update 2026-09-12

**Phase 0.5 — complete and signed off** (engineering baseline; see [PHASE_0_5_REPORT.md §17](PHASE_0_5_REPORT.md)). The branch is pushed and CI has executed, so "it passes here" is no longer the only evidence.

**Phase 1A — the tenant-safe execution substrate — complete.** This is the part of *Phase 3 — Events, jobs, worker, scheduler* that everything else rests on, pulled forward deliberately: no engine table can be designed before tenancy is enforced rather than described. Built: `ops` schema, `ops_worker` role, job table, leasing with `FOR UPDATE SKIP LOCKED`, lease expiry and recovery, tenant context bound to a live lease, and an audit trail. Proven by two database suites, mutation-verified 10/10. See [PHASE_1A_REPORT.md](PHASE_1A_REPORT.md).

**Phase 1B — the production worker runtime — complete.** The rest of *Phase 3*: a real process that leases, dispatches, executes, settles, retries with bounded backoff, recovers stale leases on its own clock, and shuts down without abandoning work. One deterministic handler — LGPD retention for the Postmark ledger, an obligation its own migration recorded and could not discharge because no worker existed. Proven through the real `pg` pool and by real worker processes, 25/25 mutations caught, green in CI on a fresh Linux runner. No AI, no LLM, no domain model, no UI. See [PHASE_1B_REPORT.md](PHASE_1B_REPORT.md).

[ADR 0012](adr/0012-worker-tenant-context.md) is **Accepted** as of 2026-09-12 — with its Phase 1A addendum, not as originally written.

**Phase 1C — the Company OS domain core — complete: CI verified, and accepted by the owner on 2026-09-13.** The organisational half of *Phase 2 — Engine foundation*, still with no model, prompt, tool or UI: tenant → company → department → agent → task → event, in `ops`, deterministic. Companies are data inside a tenant; agents are configuration only; tasks follow an 11-edge state machine enforced in the database; every lifecycle change writes exactly one event in the same statement; a task → job bridge exists with an **empty** allowlist, so no task can cause execution. Backend-only: no application role holds any privilege on it. Proven by a SQL attack suite, driver-backed tests, a static-guard extension and database mutation testing; an adversarial pass on the new surface found no Critical, High or Medium. See [PHASE_1C_REPORT.md](PHASE_1C_REPORT.md) and [ADR 0015](adr/0015-company-os-domain-core.md), which is **Accepted** (2026-09-13) with the owner addendum: tenant is the only isolation boundary, businesses that need independent data isolation are separate tenants (a tenant may still hold several companies, as organisation only), `events.seq` internal only, minimised event payloads.

Phase 1D has not started. ~~It waits on the owner's review of ADRs 0002 and 0003, and ADR 0002 is blocked on ADR 0011 item 4 (the MCP channel).~~ *(2026-09-13, pre-1D closure: ADR 0003 is accepted, the MCP function is removed, the development seed stays off hosted projects, and global monotonic identifiers stay internal. ~~ADR 0002 stays Proposed until the `merge_contacts` owner-session pool is tested against `ops`.~~ (Final 2026-09-13: ADR 0002 is accepted; the pool is measured unable to reach `ops` or carry state, SI-27.) The Phase 1D scope, with the owner's added requirements, is PHASE_1C_REPORT.md Appendix A.)* The sequencing rule still holds: **no agent before the kill switch and cost ledger exist.** *(2026-09-14: superseded by the status below.)*

---

## Status update 2026-09-14

**Phase 1D — agent runtime, model router and the first model call — built and committed on 2026-09-16, but not yet pushed, so not yet verified by CI. ADR 0016 was accepted by the owner on 2026-09-16, with an amendment.** This is the smallest slice of *Phase 4 — Agent runtime*: one agent calls a model **once**, about **one** task it is assigned, and nothing follows from what it says. See [PHASE_1D_REPORT.md](PHASE_1D_REPORT.md) and [ADR 0016](adr/0016-agent-runs-and-model-providers.md) (Accepted 2026-09-16: ambiguous provider outcomes, a 5xx included, are `indeterminate`).

**Built:**
- **Runs:** `ops.agent_runs`, with a six-edge state machine in which `indeterminate` is a state, and a retry is always a new run with lineage.
- **At most once:** a durable start before the call, a call outside every transaction, and settlement in the transaction that completes the job. Proven with real worker processes killed mid-call.
- **Idempotency and lineage:** tenant-scoped idempotency, with correlation and causation owned by the database.
- **Explicit request:** only `ops.request_agent_run` causes a call. The allowlist holds exactly `agent_run.execute`, and the job payload is a reference, never authority.
- **Providers:** a provider-neutral `ModelProvider` with a contract suite, an OpenAI Responses adapter over plain `fetch`, and a deterministic fake for CI. Routing is by deterministic tier, and an unknown route fails closed.
- **Output:** structured and advisory, validated twice, inert. No tools, no reasoning stored, usage recorded, no cost column.
- **The minimal kill switch** (owner decision): five scopes, deny wins, serialised with the start, audited clearing, `npm run execution-stop`. The ADR 0010 addendum records what it discharges.

**Deliberately not built, and how it departs from the Phase 4 text above:**
- The first adapter is OpenAI, not Anthropic: the Phase 1D brief preferred the Responses API.
- There are three tiers, not four, and no escalation trigger, so no escalation.
- No `tool_invocations`, typed tool registry, memory, budgets, spend ceiling, UI switch or CRM access.
- The `CRMProvider` ordering note still applies before any agent reads CRM data.

**Next:** CI verification of the pushed commits, and the owner's review of the report's classification. The next major milestone is decided in a separate roadmap review, aimed at a real, testable clinic flow. The report's §28 is a list of proposed follow-up work, not an accepted phase.
