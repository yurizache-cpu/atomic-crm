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
- **Owner bootstrap.** Today no code path can create the first owner (`is_admin()` requires `role='owner'`; the trigger hardcodes `operator`; signup is off; `authenticated` has no INSERT on `sales`; the bootstrap UI was deleted). Build a deliberate, auditable provisioning procedure and document it. *(2026-09-17, Phase 1D.2: built. `public.bootstrap_owner` is a person's act with the database credential, recorded in `public.owner_provisioning_log`; an upgrade with legacy administrators halts until a person runs it. Runbook: PERMISSIONS.md §3, "Owner bootstrap"; SI-41. The `users`/`patchUser` item below is still open.)*
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

**Phase 1D — agent runtime, model router and the first model call — built, committed and pushed on 2026-09-16. CI VERIFIED by run 35129049291 on `c4382b9b`: only the pre-existing `e2e-test` and Prettier checks are red, identical to the baseline. The first run (35125528392 on `0a4bcfec`) failed two Phase 1D test-surface checks, which `c4382b9b` fixed. ADR 0016 was accepted by the owner on 2026-09-16, with an amendment.** This is the smallest slice of *Phase 4 — Agent runtime*: one agent calls a model **once**, about **one** task it is assigned, and nothing follows from what it says. See [PHASE_1D_REPORT.md](PHASE_1D_REPORT.md) and [ADR 0016](adr/0016-agent-runs-and-model-providers.md) (Accepted 2026-09-16: ambiguous provider outcomes, a 5xx included, are `indeterminate`).

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

**Next:** the owner's review of the report's classification. The next major milestone is decided in a separate roadmap review, aimed at a real, testable clinic flow. The report's §28 is a list of proposed follow-up work, not an accepted phase. *(2026-09-17: decided; see the owner review under Status update 2026-09-17.)*

---

## Status update 2026-09-17

**Phase 1D.1, runtime governance closure, is built, committed and pushed on `feature/runtime-governance`, and CI VERIFIED (run 35220094426 on `b4dee040`, 2026-09-17; only the historical `e2e-test` and Prettier checks are red, identical to the baseline).** It is a short bridge phase between the first model call and the first real clinic flow. See [PHASE_1D1_REPORT.md](PHASE_1D1_REPORT.md) and [ADR 0017](adr/0017-runtime-governance.md) (Accepted by the owner 2026-09-17, below). It discharges most of what ADR 0010 left owed; see that ADR's 2026-09-17 addendum.

**Built:**
- **Prices:** versioned, owner-recorded model prices. They are never shipped by a migration, never used after they expire, and never replaced by an older version.
- **Cost:** derived by the database from usage and the price version recorded at start. An unknown outcome stays charged at its reservation.
- **Spend limits:** a global daily ceiling, tenant daily budgets and optional company limits. The global ceiling and the tenant budget must exist; every configured limit, company limits included, must absorb a run's worst-case reservation before the run starts. They are checked under per-scope locks, so two workers racing at a limit cannot both spend.
- **Ceiling stop:** a global ceiling exhausted by settled spend trips the existing kill switch, with origin `system`.
- **Kill switch:** the same switch now holds every non-internal job at the lease, without consuming an attempt. It can name one external job kind, and the runtime re-checks it before any external call. A stop an agent run's start finds holds that run, and the runtime defers its job.
- **Domain retries:** `create_task` and `record_event` are idempotent under a tenant-scoped key.
- **Runtime module:** the `external_call` flow lives in its own module.
- **Operator view:** `npm run ops`, read-only by default.

**Not built, deliberately:** a UI, tools, WhatsApp, CRM-writing agents, browser automation, agent and task budgets, and any live provider call.

**Explicit blocker: BASELINE Q8.** Real patient or clinical text may not reach a model until the owner decides:
- the multi-tenant processor roles;
- the provider's retention and zero-data-retention status;
- the DPA/DPIA;
- the classification of task text.

Phase 2A may be built and tested with synthetic data before then. See DECISIONS.md.

~~**Next:** the owner reviews ADR 0017, the ADR 0010 addendum and the report's classification; the owner pushes the branch and CI verifies it. The first real clinic flow (Phase 2A) is scoped in the report's final section, as a proposal only.~~ *(Superseded by the owner review below.)*

### Owner review 2026-09-17

**The owner accepts the Phase 1D.1 runtime governance architecture, and ADR 0017 is Accepted.** Four owner decisions come with it, recorded in the ADR's owner-review addendum:
- **A. Fail closed.** Without governance configuration there is no model call.
- **B. Stopped jobs are held.** A stopped job is held or deferred, never cancelled: no attempt is spent because it is stopped, nothing is called, and it runs only after an explicit clear.
  - **Made true at the review:** an agent run leased before a trip is now held at its start, and the runtime defers its job; the same run runs once the stop is cleared. See [PHASE_1D1_REPORT.md](PHASE_1D1_REPORT.md).
  - **E. Confirmed by the owner, 2026-09-17:** a new request made while a stop covers it is still refused at request time. It is recorded `cancelled` / `execution_stopped`, no job is created, no provider is called and nothing is deferred. A stop before admission refuses new work; a stop after admission holds the work already admitted.
- **C. Waiting is allowed.** A request may wait, bounded, for a prepare in progress.
- **D. The spend-ceiling stop stays.** It is cleared only by a person. A new day, a budget change, a price change or lower observed spend never resumes execution.

~~**Committed locally, not pushed.**~~ *(2026-09-17: pushed by the owner and CI VERIFIED, run 35220094426 on `b4dee040`, which adds owner decision E.)* The phase is committed on `feature/runtime-governance` in four commits: schema and domain; engine, CLIs and the driver-backed proofs (they compile only with the new start signature, so they ship with it); security invariants; documentation. CI runs once the owner pushes it, and the phase is CI VERIFIED only after that.

**Next phase: PHASE 2A — SYNTHETIC LEAD TRIAGE PILOT. The owner accepts the direction. The phase is NOT started.** It waits for the Phase 1D.1 CI result and its own brief. *(The CI result came in on 2026-09-17: verified, run 35220094426.)* Where the report's §14 (the proposed Phase 2A scope) differs, this section governs.

**Flow:** inbound test ingress → idempotent task → `lead_triage` capability → agent run → structured advisory triage → human review → operator queue.

**Allowed in 2A:**
- verified inbound webhook infrastructure;
- synthetic or test messages;
- a minimal message ledger, without persisting the message body wherever possible;
- idempotent `create_task`;
- `lead_triage` structured output;
- read-only CRM and contact lookup;
- a response draft that a person reviews;
- the current pricing, budget and kill-switch governance;
- operator CLI visibility;
- consent, `do_not_contact` and retention enforcement.

**Not allowed in 2A:**
- the model sending WhatsApp messages on its own;
- the model writing CRM data;
- generic tools;
- browser automation;
- RAG or memory;
- multi-agent delegation;
- autonomous loops;
- real clinical or patient text sent to a model while Q8 is open;
- UI or isometric work.

**BASELINE Q8 stays open and explicit.** It blocks REAL PATIENT DATA, not synthetic Phase 2A development and testing. It is not answered by assumption. Until the owner decides it, none of these may be sent to a real LLM provider:
- a real patient's message body;
- clinical text;
- psychotherapy information;
- health data.

Synthetic data is allowed.

### Phase 1D.2 — pre-main safety closure (2026-09-17)

**Built on `feature/pre-main-safety` (from `feature/clinical-phase-1` at `c0c07c37`), ~~not pushed~~ pushed by the owner, and CI VERIFIED (run 35247254334 on `c00082fb`, 2026-09-17; only the historical `e2e-test` and Prettier checks are red, identical to the baseline). Not merged.** A debt-closure phase that exists only to settle four automated-review (Codex) findings on PR #1 before anything reaches `main`. It adds no product functionality and does not start Phase 2A. See [PHASE_1D2_REPORT.md](PHASE_1D2_REPORT.md).

- Three findings in `20260911232039_pending_delta.sql` were reproduced on legacy data and fixed by forward migrations: legacy deals keep their stage; legacy contacts get their lead profile, so an opt-out can be recorded; legacy administrators are neither silently dropped nor promoted on trust, and the owner bootstrap above closes the fresh-deployment deadlock.
- The fourth finding was confirmed from source and fixed: `deploy.yml` now runs the same live-database gate as `check.yml`, from one reusable workflow, in the same run and on the same commit, before any hosted Supabase push.
- A new upgrade replay (`npm run test:db:upgrade`) runs in that gate, so a migration that mishandles existing rows is no longer invisible.

Phase 2A's position is unchanged: it waits for this phase's CI result and its own brief. *(2026-09-17: the CI result is in, verified; Phase 2A now waits only for its brief, and is not started.)*

**Owner review 2026-09-17: the three implementation choices are accepted** (PHASE_1D2_REPORT.md §16):
- **F. Legacy administrators are never promoted automatically.** The upgrade is a two-step operational procedure: the chain halts at `20260917180300` while no active owner exists, a person runs `public.bootstrap_owner` for the chosen user, the same deploy runs again, and the remaining legacy administrators become recorded operators. A production deployment can intentionally stop there (PERMISSIONS.md §3).
- **G. The deal-stage repair preserves the business `updated_at`.** A representation repair must not manufacture an interaction timestamp.
- **H. A backfilled lead profile's `acquired_at` is derived** from the contact's earliest trustworthy evidence, never overwrites an existing profile, stays one per contact and idempotent, and is documented as derived.

**Production-readiness gate (recorded, not part of this phase).** These do not block Phase 1D.2 CI, and they remain blockers or risks to a real production deployment where they apply: the `users` edge function (`patchUser` ordering, half-state administrator paths); `delete_note_attachments`; committed development-secret debt; and the makefile deploy path, which does not use the database gate. BASELINE Q8 is separate and still blocks real patient or clinical data from reaching an LLM provider.

### Architecture acceleration review (2026-09-17) — owner decisions I–O accepted

**Open-source-first, adapter-first, core stays ours.** Where a mature capability exists as genuinely free, self-hostable open source, integrate it behind one of our adapters; otherwise build it with Claude Code. Source-available, fair-code and Enterprise-gated software does not qualify; AGPL/GPL is flagged, never adopted silently. Read [ARCHITECTURE_ACCELERATION_REVIEW.md](ARCHITECTURE_ACCELERATION_REVIEW.md): a research document that changed no code, added no dependency and cloned nothing. Its §14 decisions were **accepted by the owner on 2026-09-17** and its §15 source-reuse policy was **approved as written**.

- **Never replaced:** tenancy, the Company OS domain, the engine (leases, idempotency, events), provider routing, spend accounting, the kill switch, governance and approval semantics.
- **Integrate soon, each behind one port:** pgvector (PostgreSQL License) for RAG; OpenTelemetry and Prometheus (Apache-2.0) for observability; Umami (MIT) for site analytics; Playwright (Apache-2.0, already here) for browser work.
- **Rejected under the owner's policy:** n8n (Sustainable Use License), Evolution API (added branding conditions and a phone-home licence gate), WAHA Plus (paid closed image), Arize Phoenix (Elastic License 2.0), and every unofficial WhatsApp gateway for the production patient channel (ban risk).
- **Deferred:** Qdrant, Gotify, Grafana (AGPL), Langfuse (MIT core, Enterprise `ee/`), Node-RED, Kestra (OSS has no tenancy, RBAC or audit log), Chatwoot (MIT core + proprietary `enterprise/`, and it would hold patient conversations).
- **Phase 2A takes no new dependency.** The revised sequence puts WhatsApp (2B), the operator surface (2C), observability (2D), scheduling and follow-up (3A), RAG (3B) and growth (3C) after it, each adding a dependency only in the phase that needs it. *(2026-09-22: superseded for sequencing by decision P — 2D is the decision engine and Jev; observability moves to 2E.)*

**Owner decisions I–O, accepted 2026-09-17** (review §14; [DECISIONS.md](DECISIONS.md)). They continue the letter sequence — A–E belong to ADR 0017, F–H to Phase 1D.2:

- **I. Open-source-first, adapter-first** is confirmed as stated above.
- **J. WhatsApp runs on the official Meta Cloud API** (paid, not open source) behind our own `CommunicationPort`; every unofficial gateway is rejected for the production patient channel, because a banned number is a patient-channel outage. This is a cost and data-processing decision, separate from Q8, and it means we build that adapter: one HTTPS call out, one webhook in, the ledger ours.
- **K. cal.diy is reference only**, despite the MIT relicensing; revisit only if scheduling grows beyond one clinic.
- **L. AGPL posture:** Grafana is allowed only as an internal, unmodified, self-hosted viewer if we ever need it, and Twenty is reference only. No AGPL/GPL/LGPL code enters proprietary Company OS source without owner review of that specific dependency and use.
- **M. An omnichannel inbox is not a Phase 2 goal.** Chatwoot and any external patient conversation store stay deferred; conversation state stays authoritative in our database.
- **N. Observability lands in Phase 2D**, after the first real flow exists. *(2026-09-22: superseded for sequencing by decision P — observability moves to Phase 2E; the requirement is unchanged.)*
- **O. Q8 remains OPEN**, unchanged by this review.

**OSS source reuse is approved** (review §15). Once a component is approved for implementation, cloning, downloading, running, modifying and forking its upstream repository is allowed and encouraged where it materially reduces engineering work; cloning candidates merely to evaluate them during a research review is not. **Fork is not the default.** Choose the mode by shape: a library or package → **package**; a large standalone application → **external service behind an adapter**; substantial persistent source modifications → **fork**; a small, clearly permissive reusable module → **source extraction**; adoption dearer than building → **reference only, build it ourselves**. The objective is not to avoid forks — it is the lowest total implementation + maintenance + upgrade + exit cost. Every reuse passes the license gate (§15.1) first, and the first real adoption creates `docs/OSS_PROVENANCE.md` with the fields listed in §15.3; no placeholder is created before then.

### Phase 2A — synthetic lead triage pilot (2026-09-17/18) — INTEGRATED

**Built on `feature/phase-2a-synthetic-triage`, from `feature/clinical-phase-1` at `d2843913`, then merged into `feature/clinical-phase-1` by PR #4 on 2026-09-18.** The merge commit is `3a124a421ce8ab12a78c52b69cfaee41aa11f20a` and the final implementation head is `e5bef7530904ebac67785ccd03a70328a5ab340f`. The integrated commits are `35ea6c03`, `d944d860` and `e5bef753`. `main` is untouched, and no production deploy took place. The first end-to-end Company OS workflow, and deliberately the smallest one that proves the path. Read [PHASE_2A_REPORT.md](PHASE_2A_REPORT.md) (§17 records the integration).

- **The flow:** a synthetic message is admitted once → one `lead_triage` task carrying the message → one explicitly requested agent run → the Phase 1D/1D.1 runtime executes it under the kill switch, the price, the spend limits and at-most-once external-call semantics → the provider's validated result is settled, and its job completed, in one transaction that commits first → the human review item is derived in a SEPARATE transaction afterwards → a person decides, once, and the decision is final.
- **What was added:** one capability (`lead_triage`, standard route, its output contract enforced by the database as well as the worker), two tables (`ops.inbound_messages`, `ops.review_items`), one ingress service, one review service, one post-settlement step (`engine/worker/afterSettlement.ts` → `ops.open_review_for_settled_job`, a job-bound worker function), a minimal `CommunicationPort` with a synthetic adapter, and the `npm run ops -- triage` subcommands. The derivation trigger this step replaced is still present, but INERT. **No new job kind, no new dependency, no new worker capability.**
- **What was reused:** the whole engine. `agent_run.execute` already existed, and the pilot rides it.
- **Boundaries, enforced rather than promised:** only `synthetic` messages are admitted and only when `COMPANY_OS_SYNTHETIC_INGRESS=enabled` (SI-44); an inbound message becomes work at most once (SI-43); a model's answer never acts, accepting is refused for a do-not-contact lead, and accepting performs no action because no outbound transport and no CRM write path exist (SI-45). Phase 2A introduces no CRM mutation path. Existing worker capabilities may touch non-CRM public-schema infrastructure such as `public.inbound_emails`.
- **Final evidence (CI run 35377851431 on `e5bef753`):**
  - `test:db` 14/14;
  - `test:db:engine` 205/205 in 30 files, including the settlement regression (3/3) and the lead triage pilot (20/20);
  - `functions` 1570/1570;
  - security invariants 52/52;
  - migration guard 131/131;
  - upgrade replay PASS;
  - typecheck, ESLint, build, secret scan, production scope and signing key green.

  Only the accepted baseline reds remain: e2e 9 failed / 1 skipped, and Prettier on `sampleCsv.test.ts` and `canAccess.test.ts`. Phase 2A caused no new regressions. There is also a reproducible demonstration (`npm run lead-triage:demo`).
- **Q8 is unchanged and still open.** No real provider was called; there is no live mode.
- **Focused pre-push review (2026-09-18, report §15):** three P1s fixed in one fix commit — a review-queue failure could discard a paid answer (the settlement now never waits on the queue, and `triage recover` restores a missing review); consent could come from the untrusted envelope (it now comes only from a trusted `ContactPolicy`); and consent failed open for a retried run (it is now found by task and fails closed). Each fix was red before and green after.
- **Final review (2026-09-18, report §16):** the §15 subtransaction did not isolate the settlement, because a statement timeout or a cancellation still rolled a paid settlement back (reproduced red). Settlement and review are now separate transactions. TX A settles the AgentRun, persists the result, completes the job and commits. TX B then derives the review on its own. If TX B fails, the run stays succeeded, the result stays durable, the provider is not called again, and `triage recover` derives the review idempotently.

### Phase 2B — official WhatsApp transport and human-approved outbound (2026-09-18/21) — INTEGRATED

**Built on `feature/phase-2b-whatsapp-transport`, from `feature/clinical-phase-1` at `1e582d43`, then merged into `feature/clinical-phase-1` by PR #5 on 2026-09-21 with a normal merge commit.** The merge commit is `8d6d47d53d6859f140952bd5e0502a0d52608e8d` and the final reviewed head is `1afed8652887d9cb40001077968f55f649a2e764`. The integrated commits are `04a6b87c` (implementation), `25952e91` (focused pre-push review fix, report §17), and `a3ca00e5` and `1afed865` (the ADR 0018 owner decision record and its correction). `main` is untouched, and no production deploy took place. Read [PHASE_2B_REPORT.md](PHASE_2B_REPORT.md) (§18 records the integration) and [ADR 0018](adr/0018-whatsapp-transport-and-human-send.md), **Accepted with amendment by the owner on 2026-09-21**.

- **Inbound:** the official Meta Cloud API, pinned to Graph API v25.0, verified against Meta's documentation on 2026-09-18. `npm run whatsapp:gateway` checks `X-Hub-Signature-256` over the raw bytes before parsing, then calls `ops.receive_whatsapp_message` as the new `ops_gateway` role. That role holds no table and executes exactly two functions. The owner-configured provider target alone selects the tenant; a signed test-channel message becomes one Phase 2A triage, exactly once.
- **Q8 on the channel:** each channel is `test` or `production`, set by the owner. The real-data gate is closed and has no enabled value: a production channel can exist only inactive (a CHECK the owner's own statements meet; dropping it is a static-guard finding), so no real number is a live target, and the database refuses a transport admission or a send on any non-test channel (SI-47).
- **Nothing is acknowledged in silence (SI-53, pre-push review):** a message is admitted, refused on the record as a content-free fact, or unrouted and answered 503 so Meta keeps it.
- **Read-only CRM `ContactPolicy`:** `ops.crm_contact_by_phone` answers found, not_found, ambiguous or unavailable, and never writes the CRM (SI-48).
- **Outbound:** accepting a review still sends nothing. `npm run messaging -- send` is a second, explicit act. The database checks the 24-hour window, exactly one CRM contact, an opt-out flag that is false (preconditions, not a lawful basis or consent), a test channel and no stop, at the request and again immediately before the one provider call (SI-49). The send is at most once: ambiguity is `indeterminate`, and nothing resends (SI-50). Status callbacks reconcile idempotently inside the channel's tenant (SI-51).
- **Conversations** group messages per (tenant, channel, contact); every message stays its own task and run.
- **No new dependency, no new job kind, no worker capability, no CRM write path.**
- **Local evidence after the pre-push review (not CI):**
  - `test:db` 15/15;
  - `test:db:engine` 240/240 in 32 files;
  - `functions` 1638/1638;
  - security invariants 60/60 (SI-46 to SI-53 added);
  - migration guard 139/139;
  - upgrade replay PASS;
  - typecheck, ESLint, build, secret scan, production scope and signing key green;
  - 18 deliberate guard breaks, each caught by name.
- **CI evidence:** the final PR CI (run 35621760834 on `1afed865`) and the post-merge CI (run 35634882090 on `8d6d47d5`).
  - Build, Test, ESLint, Typecheck and Database security & reproducibility were green in both.
  - Post-merge: `test:db` 15/15 before and after the clean reconstruction, `test:db:engine` 240/240 in 32 files, and upgrade replay PASS.
  - Only the accepted baseline reds remain, case by case: e2e 9 failed / 1 skipped, and Prettier on `sampleCsv.test.ts` and `canAccess.test.ts`. Phase 2B caused no new regression.
- **Not performed:** a live Meta call; no test credentials exist. Where `biz_opaque_callback_data` goes in a send is UNVERIFIED. The live Meta test probe must settle it, and it is mandatory before any production WhatsApp enablement (ADR 0018 amendment 2).
- **Owner decisions recorded, not made:**
  - Q8;
  - the lawful basis for a service reply;
  - retention and erasure of bodies and phone numbers;
  - whether an unknown number may be answered;
  - gateway hosting and TLS.
- **ADR 0018 ACCEPTED WITH AMENDMENT (owner decision 2026-09-21):** (1) opening the production real-data gate requires a NEW, explicitly owner-approved, Accepted ADR, never a migration alone, and that ADR must settle Q8, the lawful basis, the representation of real WhatsApp consent and opt-in, and the retention and erasure of message bodies and phone identifiers; (2) before any production WhatsApp enablement, a live probe in Meta's official test/development environment is mandatory (a Meta test/development number, a controlled test recipient, synthetic content only, no real patient traffic), verifying send request compatibility, the selected Graph API version, the provider message id, the status callback format, webhook signature behaviour and the actual placement and behaviour of `biz_opaque_callback_data`, which stays UNVERIFIED until then; (3) ADR 0018 does NOT approve the pre-existing PUBLIC EXECUTE surface of the CRM row-level-security helpers: it remains separate security debt, no additional PUBLIC helper may appear, and the existing grants need their own explicit review and decision before real production patient traffic.

**Classification: PHASE 2B INTEGRATED — CLOSED.** Q8 is OPEN, the production real-data gate is CLOSED, and no production WhatsApp channel can become active.

**NEXT: PHASE 2C — NOT STARTED.** Integrating Phase 2B does not change the prerequisites for real patient traffic. They hold independently of any phase:

- Q8 decided;
- the Phase 2B owner decisions made;
- a new, owner-approved, Accepted ADR to open the production real-data gate (ADR 0018 amendment 1);
- the live Meta test probe run (amendment 2);
- an explicit decision on the CRM's PUBLIC row-level-security helper grants (amendment 3).

Until then no phase, Phase 2C included, may carry real patient data.

Q8 must be resolved before real patient message content is sent to a real LLM.

### Phase 2C — operator surface — ARCHITECTURE INTEGRATED, IMPLEMENTATION NOT STARTED (brief 2026-09-21; owner review, final confirmation and pre-push review 2026-09-22; merged by PR #6 on 2026-09-22)

**Planned on `feature/phase-2c-operator-surface`, from `feature/clinical-phase-1` at `d1819f25`; documentation only; pushed 2026-09-22 (architecture commit `509c3ef5`, then the lifecycle sync `70f49824`, the PR #6 architecture-review fix `d8570e66` and the final-review correction `95bf2faa`), and merged into `feature/clinical-phase-1` by PR #6 on 2026-09-22 with a normal merge commit, `fe7976c5f6064d15cb173b54b1a01480a048c1a5`.** Its parents are `d1819f25cb2f2bf39e388d6923dbefdacd5b2bc5` and the reviewed head `95bf2faab9c1842009571a34b36087637ab7f85a`, and its tree is identical to that head's. Four documentation commits and 8 documentation files were integrated (`509c3ef5`, `70f49824`, `d8570e66`, `95bf2faa`): no source, SQL, migration, executable test, workflow or dependency change. The architecture branch `feature/phase-2c-operator-surface` is **retained** at `95bf2faa`, `main` is unchanged at `a863e2a084fae8c7adf7a2efc547ad7ce38e699b`, and there was no production deploy. **Post-merge CI:** run 35767741221 (workflow Check #51, event push, head `fe7976c5`) completed with overall conclusion **failure**; it is not green. Build, Typecheck, Test, ESLint and Database security & reproducibility passed. The only red job categories were e2e-test and Prettier, the accepted historical baseline categories, so no new functional or security regression was identified; the exact failing cases and files of this run were not independently retrieved. Read [PHASE_2C_BRIEF.md](PHASE_2C_BRIEF.md) and [ADR 0019](adr/0019-company-os-operator-surface.md), **Accepted for implementation by the owner on 2026-09-22**, with owner-approved addenda to ADR 0004 and ADR 0010 and the owner's final confirmation the same day. Nothing is implemented. For the operator surface, ADR 0019 supersedes the Phase 7 "Phase-1 UI" scope above (`apps/ops-web` on admin guessers).

- **Goal:** make the existing Company OS observable and narrowly operable by the owner through a real UI over real durable backend state only. An agent shown as working has a running AgentRun with a live job lease; a review shown is a `review_items` row; a cost shown is computed in SQL; a stop shown as created is a committed row. No simulated activity. The frontend never becomes the authority.
- **Approved shape (owner decisions OD-1 to OD-15, the final confirmation and the pre-push review, [DECISIONS.md](DECISIONS.md)):**
  - **Frontend (OD-1):** an in-app, ra-core-free module at `src/company-os/`, selected by a top-level switch in `src/App.tsx`. `<CRM/>` is not edited, and nothing is added to `src/components/atomic-crm`, `admin` or `ui`. No workspace, no second app; a separate Vite entry only if spike S0.1 proves it necessary.
  - **API (OD-2):** a function-only PostgREST RPC schema, `company_os_api`, of at most 17 functions: no CRUD, arbitrary SQL, table exposure, generic operation argument or generic `ops` proxy; every RPC pinned; `ops` stays unexposed, and no application role (`anon`, `authenticated`, `service_role`) gains any privilege on it; no browser-reachable function takes a tenant, company, actor, reviewer, source or causation argument.
  - **Privilege (OD-8; OD-8a accepted with a strict pinned guard exception):** the exposed functions are owned by a new role, `ops_operator_api` (NOLOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS, NOINHERIT), which holds USAGE on `ops` and EXECUTE only on one identity gate per operation, no table or sequence privilege beyond PUBLIC's catalogue reads, no CREATE and no member through which the browser, PostgREST or an application login could become it. The capability graph, not function ownership, is the boundary. The PostgreSQL 15 ownership transfer uses a temporary role membership granted only to the proven migration identity and a temporary CREATE on `company_os_api` only, both revoked in the same allowlisted migration, with ownership transfer bound to the exact RPC catalogue; every other role-membership grant stays refused, and every other function ownership change or ownership path naming the role becomes a non-overridable finding of the static guard. Each allowlisted migration (the S2 read-only and S8 acts migrations) is pinned by its exact file name and runs the whole lifecycle itself; there is no standing exception for later ownership, replace, drop, EXECUTE-grant, default-privilege, ACL or membership changes, which need a new forward migration, an explicit static-guard update, reviewed tests and owner or governance review (the owner's pre-push review, brief §7.6 A); and any `ALTER DEFAULT PRIVILEGES` naming `company_os_api` or `ops_operator_api`, any GRANT form with no `IN SCHEMA` clause and any GRANT form with `ops` in its schema list are non-overridable findings in every migration (PR #6 architecture review, brief §7.6 A and §15).
  - **Identity (OD-3; final confirmation):** an explicit Company OS membership keyed to the auth user id (`auth.uid()`), never an email (same email ≠ same principal; the email at grant is detection only), written only by the owner CLI (`npm run ops -- membership grant|revoke`; `list` reads), never inferred from the CRM owner or administrator state or from a browser-supplied id. The membership model is tenant-generic; in Phase 2C a temporary eligibility policy limits it to the tenant that owns the local CRM, because every Supabase Auth user is also a CRM user of that tenant.
  - **Browser acts (OD-4, OD-6):** decide a review (accept, reject, needs_edit) through `ops.record_review_decision`, and **trip** a stop (tenant, company, department or agent scope, inside the caller's tenant, with a required reason) through `ops.trip_execution_stop` under its lock, with a bounded request and a generic, retryable contention failure (the ADR 0010 addendum, amending the UI half of its Decision 2(c)). **Accepting sends nothing:** a browser decision decides the structured triage review, never the hidden reply draft, authorises no send and is never presented as a message approved for sending (brief §7.5). Both acts stay disabled at the backend until the user-management prerequisite is fixed and tested. Clearing a stop, send, resend, mark-indeterminate, channels, prices, limits, recovery and run retry stay CLI-only.
  - **Minimisation (OD-5, OD-7):** projections, never rows. No stored body or phone number, no reply draft, run result, job error, provider id, global sequence or platform-wide identifier, and no Auth or CRM email, email hash or raw free-form actor or reviewer label (PR #6 architecture review), reaches the browser (the model-written summary may echo the message, which is why the advice is limited to synthetic or test origins); the one platform field is the derived boolean `globalAdmissionBlocked`. The review advice (classification enums, summary and recommended next action) appears only on explicit open, through a capability-pinned projection, for synthetic or test origins, and is never stored durably; the reply draft stays visible only in the owner CLI (`triage show`).
  - **Invariants:** SI-54 to SI-59 proposed; SI-15, SI-21, SI-39 and SI-52 amended by owner decision, approved in principle, with the final, owner-approved exact texts in brief §15. The owner's pre-push review corrected SI-21 (direct Company OS authority denied to every application and capability role; pinned SECURITY DEFINER capabilities allowed only as catalogued) and SI-39 (the operator CLI's real act allowlist: price record, limit set and retire, triage accept, reject, needs-edit and recover, and membership grant and revoke; its print clause also names `triage show`'s existing display of the stored proposal, reply draft included, owner-approved as existing owner-CLI behaviour, not new authority). The CLI's comments and tests that still say "three narrow governance acts" are reconciled during implementation.
  - **Screens (OD-9):** Overview, Activity, Tasks, Agents, Agent Runs, Reviews / Decision Queue, Execution Stops, Costs; Communications optional as a narrow status view of counts.
  - **Browser handling (OD-10):** no bundle secret, no durable content storage, `no-store`, safe session expiry, explicit sign-out, no analytics receiving content.
  - **Residual trust (final confirmation):** CRM-admin account capture accepted only for local, synthetic and test Phase 2C; token theft a known residual (membership limits what a valid principal may access, not whether the token was stolen); kill-switch contention accepted with a bounded generic failure; the reply draft's exclusion from the browser accepted by the owner, with the unread-draft residual (a browser acceptance never shows the reply draft a later CLI send transmits, and reading it with `triage show` is not enforced) recorded for the owner, not decided (brief §14 item 11).
  - **Mutations last (OD-11):** read-only screens first; the `users` edge function's `patchUser` / `createSale` authority and ordering debt is fixed and tested before either act exists.
  - **Local and test only (OD-12);** notifications deferred (OD-13); **no new dependency, process, origin or public generic API (OD-15).**
- **Push and first CI (2026-09-22):** Run 35754696270 (workflow Check #44, event push, head `509c3ef549ee6bf5241bc2ec797e34e15aea2f69`) completed with overall conclusion **failure**; it is not green. Typecheck, Test, ESLint, Build and Database security & reproducibility passed. The only red job categories were e2e-test and Prettier, the same historical accepted baseline categories. No new functional or security regression was identified. The exact failed cases and files of this run were not independently re-fetched, because the GitHub job-log endpoint returned 404.
- **Before any code:** planning spikes S0.1 to S0.6 (the in-app boundary, identity from authenticated RPC, cross-tenant refusal, the least-privilege role and capability graph including the proven migration identity and the contention bound, output minimisation, no bundle secret) pass and are recorded. Spike code is discarded. A material contradiction stops the phase for owner review.
- **Before a hosted operator surface or any real data:** the OD-12 readiness step, the user-management prerequisite, session hardening, an MFA decision and implementation, a CSP, a hosted exposure review, and every Phase 2B gate below.
- **Phase 2B gates are unchanged:** Q8 is OPEN, the production WhatsApp real-data gate is CLOSED, the live Meta probe stays mandatory before any production enablement, and the PUBLIC CRM helper grants remain separate security debt. Phase 2C carries synthetic and test data only.

### Sequence after Phase 2B — owner decision P (2026-09-22)

| Phase | Name | Direction |
| --- | --- | --- |
| **2C** | Operator surface | [PHASE_2C_BRIEF.md](PHASE_2C_BRIEF.md), [ADR 0019](adr/0019-company-os-operator-surface.md) — owner-approved architecture, not started |
| **2D** | Decision engine and Jev | STARTED. **2D.2 + 2D.3 — decision quality, recovery and calibration: owner visual review PASS, SI-39 extension owner-approved (2026-09-24; [PHASE_2D23_REPORT.md](PHASE_2D23_REPORT.md))**: versioned immutable policies, a closed reason vocabulary, an owner-only idempotent recovery that never re-asks a started evaluation, and read-only aggregate agreement counts (never accuracy) on a Decisões tab; no authority, no browser mutation, no Jev connectivity. **2D.1 — decision engine foundation + shadow mode: integrated by PR #10 (merge `6adc4a7e`, 2026-09-24; [PHASE_2D1_REPORT.md](PHASE_2D1_REPORT.md))**: DecisionPort, a deterministic fake provider and an unconnected Jev boundary (no approved Jev contract exists), a strict DecisionVector, a deterministic policy that keeps human review required, stored shadow evaluations for synthetic and test lead triage reviews only, a read-only review-page section; no execution authority and no browser mutation added. The planned shape: a provider-neutral DecisionPort with a JevDecisionProvider, a RulesDecisionProvider and a FakeDecisionProvider, producing a DecisionVector (likely route, task type, complexity, risk signal or classification metadata, urgency, ambiguity, required capabilities, and a confidence or probability distribution). Jev enters in shadow mode first, measured against actual routing outcomes, human decisions, model outcomes, latency, cost, calibration and escalation quality. **Jev is not authoritative** for permission, the tenant boundary, budgets, the kill switch, lawful basis, consent, risk-policy enforcement or irreversible actions; the deterministic Company Engine stays authoritative. No real patient data until every prerequisite for real patient traffic is met (Q8, the Phase 2B owner decisions, the ADR 0018 amendment-1 ADR, the live Meta probe, the PUBLIC helper decision) |
| **2E** | Observability and intelligence | **2E.1 + 2E.2 INTEGRATED** (PR #12, merge `c375d326`, 2026-09-24; [PHASE_2E_REPORT.md](PHASE_2E_REPORT.md)). Originally planned: decision quality, Jev calibration, model performance, latency, cost, escalation metrics, failure and indeterminate rates, agent, run and workflow visibility, provider health |
| **3A** | Scheduling and follow-up | **3A.1 + 3A.2 INTEGRATED** (PR #13, merge `7c72e226`, 2026-09-25; [PHASE_3A_REPORT.md](PHASE_3A_REPORT.md)): the follow-up engine and the booking foundation on the existing queue, a provider-neutral CalendarPort (Google Calendar NOT CONNECTED), and the read-only Agenda |
| **3B** | Commercial funnel | **3B.1 INTEGRATED** (PR #14, merge `8aa65873`, 2026-09-25; [PHASE_3B_REPORT.md](PHASE_3B_REPORT.md)). **3B.2 INTEGRATED** (PR #15, merge `336802ec`, 2026-09-27; [PHASE_3B2_REPORT.md](PHASE_3B2_REPORT.md)): the four narrow commercial acts (owner decision R) and the configuration-bound follow-up bridge. 3B.1: the read-only Funil comercial from the local CRM through one adapter, and the deal stage-transition ledger. Moved ahead of memory and RAG by owner decision Q (sequencing only) |
| **after 3B** | Memory and RAG | Deferred by sequencing (decision Q), not rejected or redesigned. Existing gates, not new direction: Q8 and LGPD erasure of agent memory and derived summaries |
| **3C** | Growth | — |

- **Decision P supersedes decision N** ("Observability lands in Phase 2D", above and in [DECISIONS.md](DECISIONS.md)) for sequencing only. The former sequence (2B WhatsApp → 2C operator surface → 2D observability → 3A → 3B → 3C) gains a decision-engine phase at 2D, and observability moves to 2E, widened to observability and intelligence. The owner directed this order on 2026-09-21 and approved it on 2026-09-22; no further rationale was recorded. The observability requirement itself is unchanged, and N stays in the record, marked superseded.
- **Sequencing rule 2** ("No integration before governance") has already been inverted by Phase 2B and still needs its own restatement. **Sequencing rule 8** is satisfied for Phase 2C by ADR 0019, the owner-approved ADR 0004 and ADR 0010 addenda and the owner's final confirmation; ADR 0004, ADR 0009 and ADR 0010 remain Proposed as whole records, and Phase 2D will need ADR 0009 or a successor.
- **"Jev"** is recorded only as the owner's name for the future provider behind the DecisionPort. Its definition and data flows are proposed, and its Q8 impact assessed, in the Phase 2D brief and presented for the owner's explicit decision. Phase 2C adds no Jev SDK, API call, environment variable, schema or migration.

**Classification: PHASE 2C ARCHITECTURE INTEGRATED — IMPLEMENTATION NOT STARTED.** The owner's final confirmation is recorded and the architecture is merged into `feature/clinical-phase-1` by PR #6 (merge commit `fe7976c5`, reviewed head `95bf2faa`, branch retained); the post-merge run 35767741221 concluded failure with only the accepted baseline reds, so it is not green and no new regression was identified. The implementation stage has not started: it begins from `feature/clinical-phase-1` at the integration record, the planning spikes S0.1 to S0.6 come first, and the S7 user-management prerequisite stays binding before any mutable browser act. Q8 is OPEN, the production WhatsApp gate is CLOSED, no real patient data is permitted, and no production deployment is approved.

### Phase 2E.1 + 2E.2 — observability foundation and operational intelligence (2026-09-24) — IMPLEMENTED, OWNER VISUAL REVIEW PASS, OTLP WORKER EXPORT VERIFIED

Built on `feature/phase-2e-observability` from `feature/clinical-phase-1` at `b3d67c8f` (the PR #11 merge that integrated 2D.2 + 2D.3); local commits, not pushed. Read [PHASE_2E_REPORT.md](PHASE_2E_REPORT.md).

- **2E.1:** a provider-neutral TelemetryPort (no-op default, one sanitising, failure-isolating boundary, an allowlist catalogue: SI-60), the governed runtime traced and counted without any authority (SI-61), a private worker `GET /metrics`, and a local Collector + Prometheus stack from official, digest-pinned images ([OSS_PROVENANCE.md](OSS_PROVENANCE.md)).
- **2E.2:** `ops.cos_operational_health`, exact and tenant-scoped, in the existing overview read, and the read-only screen Saúde operacional.
- **OpenTelemetry SDK:** first refused by the repository's dependency guard, then approved by the owner as exactly three pins and installed by the owner (2026-09-24). The real worker's spans reach the local Collector over OTLP/HTTP (report §3, §7).
- **Unchanged:** the Company Engine / PostgreSQL is authoritative; telemetry has no authority; browser mutable RPCs 2; Q8 OPEN; real Jev pending a verified provider contract.
- **Next:** the owner's final confirmation, then the single remote integration cycle. Later in 2E (not started): whatever intelligence the owner asks for next. *(2026-09-25: integrated by PR #12, merge `c375d326`; post-merge Check #71 red only on the historical e2e and Prettier baseline.)*

### Phase 3A.1 + 3A.2 — follow-up engine and scheduling / booking foundation (2026-09-25) — IMPLEMENTED LOCALLY, OWNER VISUAL REVIEW REQUIRED

Built on `feature/phase-3a-followup-scheduling` from `feature/clinical-phase-1` at `c375d326`; local commits, not pushed. Read [PHASE_3A_REPORT.md](PHASE_3A_REPORT.md).

- **3A.1:** versioned tenant cadences, one plan per subject, one occurrence per step with a database-derived, time-zone-independent due time, a database-enforced state machine, and one `follow_up.due` job per occurrence on the existing queue. The job is the first GOVERNED kind: transactional, held by the one kill switch at the lease and at the start of its transaction. A due follow-up is operator work, never a send (SI-62).
- **3A.2:** generic resources, booking types and weekly availability rules in IANA zones; bookings as instants; a core-PostgreSQL exclusion constraint so booked bookings of a resource never overlap under any race or writer; atomic, idempotent reschedule; idempotent cancel; deterministic, bounded slots (SI-63).
- **Calendar:** a provider-neutral CalendarPort, a deterministic fake provider, and an at-most-once sync lifecycle with a minimised request; only the fake can be connected (SI-64). **Google Calendar is NOT CONNECTED**: no approved authentication, token storage or data-processing contract exists, and none was invented (report §6).
- **Company OS:** the read-only Agenda from the existing overview; the scheduling tool's five owner acts (SI-65). Browser mutable RPCs still 2.
- **Unchanged:** the Company Engine / PostgreSQL is authoritative; Q8 OPEN; no real patient data; no autonomous sending.
- **Next:** the owner's visual review, then the single remote integration cycle. Browser scheduling actions and Google Calendar are separate owner decisions (report §13). *(2026-09-25: owner visual review PASS; integrated by PR #13, normal merge `7c72e226`; post-merge Check #75 red only on the historical e2e and Prettier baseline. The CI and deploy Supabase CLI is pinned to the measured 2.117.0 after upstream drift broke Check #72.)*

### Phase 3B.1 — commercial funnel and funnel intelligence (2026-09-25) — IMPLEMENTED, OWNER VISUAL REVIEW PASS

Built on `feature/phase-3b-commercial-funnel` from `feature/clinical-phase-1` at `7c72e226`; local commits, not pushed. Owner decision Q put it ahead of memory and RAG (sequencing only). Read [PHASE_3B_REPORT.md](PHASE_3B_REPORT.md).

- **Authority:** the Atomic CRM's `public.deals` stays the one commercial source of truth. There is no second commercial store, and Company OS reads through one adapter (`ops.crm_commercial_funnel`), only for the tenant that owns the local CRM (SI-67).
- **Funnel:** the configured stages in order, with counts, stage age, next-action states, new, converted and lost counts over 30 days, a closing rate with its denominator, attention lists, origins as recorded, and recent outcomes. Stages come from the CRM's stored configuration (ADR 0013).
- **History:** `public.deal_stage_transitions` observes stage entries and changes from its migration on, in the deal write's transaction, append-only, with nothing backfilled (SI-66). Stage-to-stage conversion before it is unknown.
- **Company OS:** the read-only screen Funil comercial. Browser mutable RPCs still 2, and no company_os_api function added.
- **Unchanged:** Q8 OPEN; no real patient data; Google Ads API, Umami, CPL, CAC and ROAS not built; no browser commercial mutation.
- **Next:** the owner's visual review, then the single remote integration cycle. Commercial authority in Company OS is a separate owner decision. *(2026-09-25: integrated by PR #14, merge `8aa65873`. 2026-09-26: commercial authority is owner decision R, Phase 3B.2 below.)*

### Phase 3B.2 — operational commercial funnel (2026-09-26/27) — INTEGRATED

Built on `feature/phase-3b2-operational-funnel` from `feature/clinical-phase-1` at `8aa65873` (Phase 3B.1 integrated by PR #14). Integrated on 2026-09-27 by PR #15, normal merge `336802ecd36e6961b896bdb7300bdce04bfeef7c`; the source branch is retained at `726f4a3c`, and `main` is unchanged at `a863e2a0`. Read [PHASE_3B2_REPORT.md](PHASE_3B2_REPORT.md) §18.

- **Owner decision R:** the browser gains exactly four narrow commercial acts: move an opportunity to another configured stage, set or clear its next action, convert it, lose it with a configured reason. Browser mutable RPCs: 6; `company_os_api` functions: 21 (the fourth exact OD-8a migration). No generic CRUD.
- **Authority:** the Atomic CRM's `public.deals` stays the one commercial source of truth; each act reaches it through one CRM adapter write, for the tenant that owns the local CRM only, under the deal's row lock and an opaque revision (a stale view is OS409).
- **Follow-up bridge:** owner configuration only; with it, a next action plans the Phase 3A cadence so its first occurrence is due exactly then; changing supersedes, clearing, converting and losing cancel, only plans the bridge created.
- **Company OS:** the Funil comercial's cards offer the acts the server allows, each behind its own confirmation; nothing moves before the server answers. The 3B.1 UX backlog (overdue and due today apart, eight movements with Ver todas, the scroll hint) is taken.
- **Unchanged:** Q8 OPEN; no real patient data; no send; `lead_profiles.next_action_at` not synced; sales visibility and RBAC open; no RAG.
- **Owner visual review (2026-09-27): PASS** (report §17). Carried without change: legacy outcome consistency, the canonical next action, commercial RBAC, follow-up bridge administration and the review's P3 residuals.
- **Integration (2026-09-27):** the final review found no P0 or P1. Post-merge Check #81 (run 36349867884) passed Test, Build, Typecheck, ESLint and Database security & reproducibility. The workflow stays red only for the accepted historical baseline: e2e exactly 9 failed and 1 skipped, and Prettier exactly 2 historical errors. There is no new regression. Q8 is OPEN; no real patient data was used; no production deploy occurred.
- **Next:** not decided here; the owner chooses the next milestone separately.

### Q8 — real-data / model authorization (2026-09-27) — OWNER DECISION PACKET PROPOSED

A decision milestone, not an implementation, on the local branch `feature/q8-real-data-authorization` from `feature/clinical-phase-1` at `156977dd`. Read [ADR 0020](adr/0020-real-data-model-authorization.md).

- **Finding:** today Q8 is held at ingress and by convention. The model boundary itself (`ops.start_agent_run`) checks no data class.
- **Proposed:**
  - a closed classification assigned from provenance;
  - the provider evidence to verify from current official sources;
  - one fail-closed gate on the ADR 0017 pattern: versioned, tenant-scoped owner authorizations, checked where a run starts, where it is requested and where a shadow decision starts;
  - absence denies everything but `synthetic` and `test`.
- **Owner decisions D1–D10:** roles, the allowed classes, the free-text presumption, the lawful basis, the provider bar, retention, erasure, test channels, international transfer and who authorizes.
- **Unchanged:** Q8 OPEN; no real patient data; no provider change; no Jev; the ADR 0018 WhatsApp gate CLOSED and not superseded; no RAG.
- **Next:** the owner answers D1–D10. Only then does the one implementation batch in ADR 0020 §G start. *(2026-09-27: answered and implemented; see below.)*

### Q8 enforcement batch (2026-09-27) — INTEGRATED (2026-09-28)

The owner answered D1–D10 (ADR 0020 §H) and the §G batch was built on the same branch and integrated by PR #16. Read [PHASE_Q8_ENFORCEMENT_REPORT.md](PHASE_Q8_ENFORCEMENT_REPORT.md).

- **The gate is at the model boundary.** `ops.start_agent_run` refuses, as `data_not_authorized` and before any call, a run whose task's class is neither synthetic nor test, unless an owner authorization is in force for exactly its tenant, class, capability, provider and model; the in-process fake is exempt. `ops.request_agent_run` refuses early with no job; the decision-shadow start runs the same check; the run guard enforces it on every write path (SI-70).
- **Classification from provenance,** immutable (SI-71): synthetic; `test` only from a sender the owner registered on a configured test channel (D8: a test channel is not test data); `health` for any other lead or patient free text (D3); a direct task names a class or is `unclassified`.
- **Owner authorization,** versioned and tenant-scoped, recorded and retired only by `npm run ops -- data-auth` (D10). Person content needs every evidence reference, training excluded, at most 30 days of content retention, the CRM-owning tenant (D1) and a minimising capability (`lead_triage`).
- **Minimisation** of the lead-triage input: a field allowlist and structured-identifier redaction, which is NOT anonymisation.
- **Unchanged:** no authorization recorded; real patient model traffic DISABLED; no provider change; no Jev; the ADR 0018 WhatsApp gate CLOSED; no RAG.
- **Integration (2026-09-28):** PR #16, normal merge `097b4b3cfdd7e18f65bc0b057820dd9eac998aa1` into `feature/clinical-phase-1` (parents `156977dd`, `697745a8`); the source branch is retained at `697745a8`, and `main` is unchanged at `a863e2a0`. The Codex review's P1 (the lead-triage model input still carried the task's title and type) was fixed before the merge in `697745a8`. Post-merge Check #87 (run 36362501229) passed Test, Build, Typecheck, ESLint and Database security & reproducibility; the workflow stays red only for the accepted historical baseline: e2e exactly 9 failed and 1 skipped, and Prettier exactly 2 historical errors (`sampleCsv.test.ts`, `canAccess.test.ts`). There is no new regression.
- **Status:** Q8 ENFORCEMENT: INTEGRATED (the technical fail-closed enforcement). PRODUCTION REAL-DATA AUTHORIZATION: CLOSED: no model-data authorization exists, and ADR 0020 stays Proposed. REAL PATIENT MODEL TRAFFIC: DISABLED. No production provider enablement, no production WhatsApp enablement, no Jev, no RAG. Strict MVP: ~91% (directional).
- **Next:** the next technical Q8 sub-batch is expected to address the retention / redaction lifecycle (D6, D7). *(2026-09-28: implemented; see below.)*

### Q8 D6/D7 — AI working-content retention and redaction (2026-09-28) — INTEGRATED

Built on `feature/q8-retention-redaction` from `feature/clinical-phase-1` at `99666512` and integrated by one PR into `feature/clinical-phase-1`. Read [PHASE_Q8_RETENTION_REPORT.md](PHASE_Q8_RETENTION_REPORT.md) and ADR 0020 §I.

- **What is redacted:**
  - the AI working content of a `health` or `person_text` task: its description, every run's result, and every review's proposed copy and note;
  - the unkeyed fingerprints derived from it (task request, run input, admission body).

  The redaction happens in place. No row is deleted, and every content-free audit fact stays.
- **When:** at most 30 days after the database's `reviewed_at` of the task's latest decided review, or the relied-on authorization's own `content_retention_days` when fewer. The worker redacts on the one INTERNAL `content.retention_due` job queued at the due instant (the follow-up pattern: no cron).
- **Owner acts:** `npm run ops -- retention erase` (one task, its own tenant, now) and `retention sweep` (bounded); `retention list` reads. SI-39 is extended, and SI-72 is added.
- ~~**Open for the owner:** a flow that never has a decided review has no clock; explicit erasure covers it, and an abandoned-flow policy is an owner decision.~~ *(Decided by the owner and built as the retention fallback; see below.)*
- **Integration (2026-09-28):** PR #17, normal merge `c388bf53b3236a1b5d9d0bb552c58541c06d36f0` into `feature/clinical-phase-1` (parents `99666512`, `fb234afe`); the source branch `feature/q8-retention-redaction` is retained at `fb234afe`, and `main` is unchanged at `a863e2a0`. The automated review's P1 (a due flow still in progress spent its job's retries and could be left with no job) was fixed before the merge in `fb234afe`. Post-merge Check #94 (run 36445210729): Test, Build, Typecheck, ESLint and Database security & reproducibility PASS; the workflow stays red only for the historical baseline, e2e exactly 9 failed and 1 skipped and Prettier exactly 2 errors; no new regression.
- **Unchanged:**
  - PRODUCTION REAL-DATA AUTHORIZATION: CLOSED, and REAL PATIENT MODEL TRAFFIC: DISABLED;
  - no authorization recorded, and no provider-side deletion;
  - no production WhatsApp (ADR 0018 keeps body and identifier retention), no Jev and no RAG.
- **Next:** not started; the owner decides the next milestone.

### Q8 retention fallback — final internal-retention correction (2026-09-28) — INTEGRATED; Q8 INTERNAL RETENTION LIFECYCLE COMPLETE

Built on `feature/q8-retention-fallback` from `feature/clinical-phase-1` at `c388bf53` and integrated by one PR into `feature/clinical-phase-1`. Read [PHASE_Q8_RETENTION_REPORT.md](PHASE_Q8_RETENTION_REPORT.md) §9 and ADR 0020 §I.

- **The gap closed:** a protected flow whose run failed, was refused or is indeterminate, whose review was never decided, or that never got a run, had no automatic retention clock.
- **Owner policy:** every `health` or `person_text` task has ONE retention state from its creation, with a compact `anchor_reason`: **A** `review_decided`, the latest decided review's `reviewed_at` + the relied-on authorization's `content_retention_days` or 30 (unchanged D6); **B** `review_undecided`, otherwise the latest review's `created_at` + 30; **C** `terminal_without_review`, otherwise the latest finished run's `completed_at` + 30; **D** `task_created`, otherwise the task's `created_at` + 30. The clock only moves forward and no fallback displaces a decided review's. The flow keeps exactly ONE job (moved in place while queued). Only a run pending or running defers expiry (hourly, always leaving one next job); an undecided review no longer holds it, and the owner's erasure keeps its stricter rule. A run's terminal instant is read when the flow's job fires, never written inside a run's settlement.
- **Invariant:** SI-72 extended (no protected AI working content remains indefinitely); numbering unchanged.
- **Integration (2026-09-28):** PR #18, normal merge `c4938029e9d185af0c7716892924c93199d3c5e6` into `feature/clinical-phase-1` (parents `c388bf53`, `b354be29`); the source branch `feature/q8-retention-fallback` is retained at `b354be29`, and `main` is unchanged at `a863e2a0`. The automated review's one finding (P2, in scope: two reviews decided at one instant could keep the longer period) was fixed before the merge in `b354be29`. Post-merge Check #99 (run 36457607762): Test, Build, Typecheck, ESLint and Database security & reproducibility PASS; the workflow stays red only for the historical baseline, e2e exactly 9 failed and 1 skipped and Prettier exactly 2 errors; no new regression.
- **Status:** Q8 INTERNAL RETENTION LIFECYCLE: COMPLETE. PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED. Strict MVP ~93%.
- **Unchanged:** no authorization recorded; no provider-side deletion; no production WhatsApp; no Jev; no RAG.
- **Next:** not started; the owner decides the next milestone.

### Staging real model and Meta test probe (2026-10-02) — IN PROGRESS

PR #23 is integrated: normal merge `6da21fbd5640555c220de4300248de182fcc4a73` into `feature/clinical-phase-1` (parents `501e3efd` and `53bf6d47b5993255d6a402785bc373d65e87e742`); the source branch `feature/cost-first-staging` is retained at `53bf6d47`; `main` is unchanged at `a863e2a0`. Post-merge CI: Test, Build, Typecheck, ESLint and Database security & reproducibility PASS, now on PostgreSQL 17; e2e exactly 9 failed and 1 skipped (the same ids) and Prettier exactly 2 errors, the historical baseline; no new regression. The automated review's P1 (the uploader inherited the whole shell environment) and P2 (the live check bound the release only to its script paths) were fixed before the merge in `53bf6d47` (`scripts/publisher-environment.mjs`; `release.json`, a hash of every path and byte of the build, checked live).

### Cost-first remote staging (2026-09-29) — INTEGRATED (PR #23, merge `6da21fbd`)

Remote synthetic staging works with no new recurring cost: the Netlify frontend, Supabase Free staging on PostgreSQL 17 with the canonical migrations and no seed, AAL2 in a real browser, the CRM and the Company OS on synthetic data, and the real worker loop running locally against staging through its constrained role. Read [COST_FIRST_STAGING.md](COST_FIRST_STAGING.md). Next, in order: the browser decision of the pending staging review; the Meta test probe (a free tunnel first); a real model run with synthetic content inside the US$5 cap (owner key). **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

#### Recorded when it started

PR #22 is integrated: normal merge `501e3efd2705651eb44e65a23c923e6a5b0f573c` into `feature/clinical-phase-1` (parents `889766cb` and `2eb7d337fab9b79c204666174ec66d97c3eaaea4`); the source branch `feature/production-hosting-runtime` is retained at `2eb7d337`; `main` is unchanged at `a863e2a0`. Post-merge CI: Test, Build, Typecheck, ESLint and Database security & reproducibility PASS; e2e exactly 9 failed and 1 skipped and Prettier exactly 2 errors, the historical baseline; no new regression. The automated review's P1 (the live-origin check could pass on the previous release) and three P2 (a redirect elsewhere accepted, private IPv6 and CGNAT literals, a `/healthz` webhook path) were fixed before the merge in `2eb7d337`.

**Owner cost-first adjustment (2026-09-29), before any infrastructure existed:** no new recurring paid infrastructure until product validation. The **Cloudflare frontend plan is SUPERSEDED BEFORE DEPLOYMENT** (nothing was created): the frontend goes to a NEW site on the owner's existing, already paid **Netlify** account. The **Fly.io deployment is DEFERRED** (nothing was created) until a validation step truly needs a 24/7 worker or a public webhook; the worker and gateway run LOCALLY against the hosted staging project meanwhile. The **remote staging database is ONE new Supabase Free project** (the organisation's one remaining free slot); the owner's existing active project `prisma-clinico-online` is **excluded: DO NOT TOUCH**, and no production project is created. Kept, as provider-neutral assets and a future runtime option: the host contract and verifier, the environment contract and start gate, the Dockerfile, the health endpoints, graceful shutdown and `fly.toml`. `scripts/publish-cloudflare.mjs` and `.github/workflows/deploy-hosted.yml` are no longer the current deployment path. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

### Production hosting and runtime (2026-09-29) — INTEGRATED (PR #22, merge `501e3efd`); Cloudflare SUPERSEDED before deployment, Fly DEFERRED

Built on `feature/production-hosting-runtime` from `889766cb`. Read [PRODUCTION_DEPLOYMENT.md](PRODUCTION_DEPLOYMENT.md).

- **Hosting as recommended** (packet §9, implemented after the owner said to continue; creating the accounts is the acceptance): Cloudflare Workers static assets for the frontend, Fly.io `gru` for the worker and gateway, Supabase `sa-east-1`.
- **Runtime (Milestone 3, provider-neutral parts):** the `DEPLOYMENT_ENVIRONMENT` start gate (one rule set with the Gate B preflight), `/healthz` on the worker and gateway, one digest-pinned, non-root, production-by-default image with an allowlisted build context.
- **Frontend publish:** `scripts/publish-cloudflare.mjs` (headers file, preflight, pinned Wrangler, the live origin checked); the manual `deploy-hosted.yml` per GitHub Environment, both deploy jobs behind the gate and the live-database suites (SI-40). SI-77.
- **Next:** the owner's account checklist (runbook §6); then Milestone 2 (hosted Supabase posture from the repository: migrations, Auth settings including TOTP, runtime logins and Fly secrets without a person handling passwords) and the first synthetic staging deploy. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

### Production Hosting Gate B (2026-09-28) — INTEGRATED (PR #21, merge `889766cb`); host recommendation implemented (above)

PR #21, normal merge `889766cb2d5da0711cca3df18a8b3766bfd8eb45` into `feature/clinical-phase-1` (parents `afcb7224` and `1b9353fc90a92f682d34128d5578ccb636b6a098`); the source branch `feature/production-hosting-gate-b` is retained at `1b9353fc`; `main` is unchanged at `a863e2a0`. Post-merge CI: Test, Build, Typecheck, ESLint and Database security & reproducibility PASS; the workflow stays red only for the historical baseline, e2e exactly 9 failed and 1 skipped and Prettier exactly 2 errors; no new regression. The automated review's two P1 and one P2 (a duplicated CSP directive read last-wins, a same-origin absolute script URL never read, an unreadable script silently skipped) were fixed before the merge in `1b9353fc`. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

Built on `feature/production-hosting-gate-b` from `feature/clinical-phase-1` at `afcb7224`. Read [PRODUCTION_HOSTING_DECISION_PACKET.md](PRODUCTION_HOSTING_DECISION_PACKET.md) and [PRODUCTION_HOSTING_GATE_B_REPORT.md](PRODUCTION_HOSTING_GATE_B_REPORT.md).

- **No host is chosen** (no accepted decision exists; GitHub Pages is upstream's inherited deploy, insufficient by measurement and by its terms). Three candidates are compared from official documentation: Cloudflare Workers static assets (preferred technical fit, not a decision), Netlify, Vercel. **OWNER ACTION REQUIRED**; nothing paid or provider-specific was created.
- **Built, provider-neutral (SI-76):** the host contract; `production:preflight` in the production deploy job; `verify:production-host`; `verify:hosted-supabase`; `production:headers`; the production and staging environment contract.
- **Next:** on the owner's host decision, the provider-specific step (header file, prebuilt-directory deploy behind the preflight, a post-deploy host check, a synthetic-only staging project), about half a day of engineering. Hosting of the worker and the WhatsApp gateway is a separate decision. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

### Production Security Gate A.1 (2026-09-28) — INTEGRATED (PR #20, merge `afcb7224`); PRODUCTION SECURITY GATE A: COMPLETE

Gate A is integrated in two PRs into `feature/clinical-phase-1`, neither into `main`: PR #19 (merge `234f7a89`, source retained at `f17c306e`) and its A.1 correction PR #20 (normal merge `afcb722435026f745536caef3f7b167b52195da5`, parents `234f7a89` and `c81f1cba`, source `feature/production-security-gate-a1` retained at `c81f1cba`; `main` unchanged at `a863e2a0`). Post-merge CI: Test, Build, Typecheck, ESLint and Database PASS, with only the historical e2e (9 failed, 1 skipped) and Prettier (2 errors) red. Read [PRODUCTION_SECURITY_GATE_A_REPORT.md](PRODUCTION_SECURITY_GATE_A_REPORT.md) §7. **PRODUCTION SECURITY GATE A: COMPLETE.** It includes PUBLIC helper hardening, AAL2 for the Company OS and for the CRM protected data surface, no automatic Gravatar or favicon enrichment, the CSP and build policy, the local-only assurance exemption, and no AAL1 real-data browser bypass.

- **No automatic third-party enrichment** (owner policy 2026-09-28): the two enrichment triggers and the four functions behind them (Gravatar by a hash of the email, the domain's favicon) are dropped, and the browser-side twin in the FakeRest demo is removed; stored avatars and logos are untouched; `authenticated` executes exactly the six row-security helpers (SI-73).
- **MFA for the CRM's real-data surface** (owner policy 2026-09-28): `ops.session_assurance_satisfied()` (the same rule as `ops.operator_scope()`, the same single exemption) is required by the two roots every CRM row policy decides through, `current_sales_id()` and `is_admin()`; no policy changed and MFA never widens what a row rule allows. `merge_contacts` (owner-session channel) and the `users` function carry the caller's verified session. The shell sends a level-1 session the server refuses through the Company OS's own second-factor flow (SI-74).
- **Still open:** a host that sends the declared headers (GitHub Pages cannot; hosting undecided), TOTP enabled on a hosted project, ADR 0020 §C evidence, production WhatsApp. **PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.**

### Production Security Gate A (2026-09-28) — INTEGRATED (PR #19, merge `234f7a89`); corrected by A.1 (PR #20)

Built on `feature/production-security-gate-a` from `feature/clinical-phase-1` at `c4938029` and integrated by one PR into `feature/clinical-phase-1`. Read [PRODUCTION_SECURITY_GATE_A_REPORT.md](PRODUCTION_SECURITY_GATE_A_REPORT.md).

- **PUBLIC helper debt closed** (R-16, ADR 0018 amendment 3): PUBLIC and `anon` execute nothing in `public`; `authenticated` executed exactly eight reviewed functions (six since A.1); the Company OS capability roles execute none (SI-73).
- **MFA at the Company OS authority:** `ops.operator_scope()` requires `aal2` on both the provider's session row and the verified token, or refuses. The non-production exemption lives only in the local seed. The browser completes the provider's own TOTP factor (SI-74).
- **Browser policy:** a Content-Security-Policy and a strict referrer policy in every production page, enforced by the build scan. The host header set is declared in one module and served by `vite preview` (SI-75).
- **Remaining production-readiness blockers:**
  - a host that sends the declared headers (hosting undecided; GitHub Pages cannot);
  - TOTP enabled on a hosted Supabase project;
  - ~~CRM screens outside the Company OS not MFA-gated~~ and ~~the Gravatar lookup from service-role contact writes~~ (both closed by A.1);
  - ADR 0020 §C evidence and production WhatsApp.
- **Unchanged:** PRODUCTION REAL-DATA AUTHORIZATION: CLOSED. REAL PATIENT MODEL TRAFFIC: DISABLED.
- **Next:** not started; the owner decides the next milestone.
