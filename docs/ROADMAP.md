# Roadmap — AI Company OS

**Status:** proposed, pending owner approval.
**Date:** 2026-09-10
**Basis:** [BASELINE_REPORT.md](BASELINE_REPORT.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Phases are small and verifiable. Each closes a cycle of value and is independently revertible. **One phase at a time**; the next starts only when acceptance criteria pass.

This is not the brief's example phase list. It is adjusted for what the audit actually found — most importantly that the repository is currently **not deployable, not committed, and locked out on login**, which inserts a custodial phase before any architecture work.

---

## Phase 0 — Baseline ✅ complete

Audit and documentation. No functional change. Deliverables: `BASELINE_REPORT.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `CLAUDE.md`, `docs/adr/0001-0008`.

---

## Phase 0.5 — Custody and deployability 🔴 **do this first**

> The most likely way this project fails is not an architecture mistake. It is that ~2,300 lines of Phase-0 work exist only in a working tree and are lost to one `git clean`. Nothing below matters until this is done.

**Goal.** Get the existing work committed, make the repository deployable again, and make CI a real gate.

**Scope.**
1. Fix 5 typecheck errors + 2 lint errors (`BASELINE_REPORT.md` §12). Two of the failing files are not modified — they break because `types.ts` and `englishCrmMessages.ts` changed without their counterparts.
2. Commit the working tree in reviewable parts on `feature/clinical-phase-1` and **push**. Suggested split: (a) security/schema, (b) clinic domain fields, (c) UI + i18n, (d) `docs/product/` prior art.
3. Add `[db.migrations] schema_paths` to `supabase/config.toml` — the declarative workflow `AGENTS.md:33` documents is not wired to the CLI.
4. Generate **one** reviewed migration from the pending schema delta. Review it line by line; it mixes three new tables, seven columns, eight functions, three triggers, the whole policy surface and the grants.
5. Fix `seed.sql` / `loss_reasons` so `supabase db reset` works.
6. Gate `deploy.yml` on `check.yml` (`needs:`), and add a CI job asserting `supabase db diff` produces empty output.
7. Repair the e2e suite: `onboarding.spec.ts` drives a deleted signup flow; fixtures create users without `role`; `e2e/fixtures.ts:11-22` does not truncate the new tables.
8. Resolve the `AGENTS.md` vs `07-upstream-strategy.md` conflict on `src/components/admin` / `src/components/ui` — state one rule, delete the other.

**Files.** `supabase/config.toml`, `supabase/seed.sql`, `supabase/migrations/<new>.sql`, `.github/workflows/{check,deploy}.yml`, `e2e/*`, `ProfilePage.tsx`, `DealListContent.tsx`, `frenchCrmMessages.ts`, `fakerest/dataGenerator/contacts.ts`, `AGENTS.md`.

**DB.** One generated migration. No new design.

**Tests.** `npm run typecheck`, `npm run lint`, unit, and a green `supabase db reset` + e2e run.

**Acceptance.** Working tree clean and pushed; typecheck/lint/unit/e2e all green; `supabase db reset` succeeds from scratch; `supabase db diff` empty; a red build cannot deploy.

**Risks.** The generated migration is large and mixes concerns — review it as if it were hand-written. Do not hand-edit historical migrations. Do not bundle unrelated fixes (`make watch`, ghpages exit code, duplicate index).

**Rollback.** Every step is a separate commit; the migration is the only irreversible artifact and is reviewed before it is applied anywhere.

---

## Phase 1 — Security floor

**Goal.** A deployed instance that a real person can log into, with the critical holes closed, before any real data exists.

**Scope.**
- **Owner bootstrap.** Today no code path can create the first owner (`is_admin()` requires `role='owner'`; the trigger hardcodes `operator`; signup is off; `authenticated` has no INSERT on `sales`; the bootstrap UI was deleted). Build a deliberate, auditable provisioning procedure and document it.
- Fix `delete_note_attachments` (any authenticated user can delete any file via the service role).
- Fix the `users`/`patchUser` ordering bug (auth email and ban state mutate before the owner check).
- Decide and act on the MCP function (Q6) — at minimum add audience validation, stop trusting `x-forwarded-host`, close the nested-CTE bypass in `validateSql`, stop logging raw SQL containing personal data, and stop connecting as superuser.
- Invert `canAccess` to deny-by-default.
- Rotate committed secrets; remove the `!supabase/functions/.env` negation from `.gitignore`; move real secrets to the deploy provider only.
- Disable the marmelab telemetry beacon (Q10); stop publishing sourcemaps and `stats.html`.
- Resolve the three-way attachments inconsistency: either undeploy the Postmark upload path or finish the bucket design.

**DB.** Migration adding the owner-provisioning mechanism; `force row level security` where appropriate.

**Tests.** **First RLS test suite** — run as owner, operator and anon, asserting scoped reads, denied writes and admin-only mutations. This is the highest-value test debt in the repo.

**Acceptance.** A fresh deployment can be bootstrapped to a working owner login; each §7 critical item has a test proving it is closed; no secret material is tracked in git.

**Risks.** Touching auth can brick login — the current state is already broken, so verify against a throwaway project first. Do not remove the `role='owner'` condition from `is_admin()` to "unblock" bootstrap; the condition is correct, the provisioning path is what is missing.

---

## Phase 2 — Engine foundation

**Goal.** The `ops` schema exists, is multi-tenant, is invisible to browsers, and records history immutably. No agents yet.

**Scope.** `ops` schema (kept out of `config.toml:11`'s PostgREST allowlist); `ops.tenants`, `ops.departments`, `ops.principals`; `ops.audit_log` (append-only, `REVOKE UPDATE, DELETE`); tenant-scoped RLS helpers; `packages/engine-core` with no `ra-core` and no Supabase import.

**DB.** New schema; UUID PKs; `tenant_id` everywhere; `force row level security`; no FK into `public.*`.

**Tests.** RLS tests proving cross-tenant isolation; a test proving `ops` is unreachable via PostgREST; a test proving audit rows cannot be updated or deleted.

**Acceptance.** Two tenants coexist with provably zero cross-visibility; the CRM is untouched and still green.

**Risks.** Getting tenancy wrong here is the most expensive mistake in the roadmap (D2). Do not add a tenant column to `public.*` — `configuration`'s singleton CHECK blocks it and 43 policies would need rewriting.

---

## Phase 3 — Events, jobs, worker, scheduler

**Goal.** Work can be scheduled, queued, executed durably and retried — with no LLM involved yet.

**Scope.** `ops.events` (append-only), `ops.outbox`, `ops.jobs`, `ops.schedules`; `services/worker` (the always-on process); job leasing via `FOR UPDATE SKIP LOCKED`; idempotency keys; classified retries with backoff and a dead-letter queue; scheduler tick; structured logging with correlation ids; webhook ingress that writes to the outbox and returns immediately.

**Tests.** **Idempotency tests** (the same event delivered twice produces one effect); retry/backoff/DLQ tests; concurrency tests (two workers, no double-execution); a scheduled job that is provably idempotent.

**Acceptance.** A webhook produces exactly one event, one job and one effect under duplicate delivery; a killed worker resumes without losing or duplicating work; a daily schedule fires once.

**Risks.** This is where a naive design silently duplicates external actions. Build idempotency in from the first commit, not after.

---

## Phase 4 — Agent runtime

**Goal.** An agent can run, produce a schema-validated structured output, and have its cost recorded.

**Scope.** `LLMProvider` port + Anthropic adapter; model router (4 tiers, cheap-first with escalation); `ops.agent_runs` and `ops.tool_invocations`; `ops.budgets` with daily/monthly/per-task limits and warn/throttle/fallback/require-approval behaviour; typed tool registry; short-term + retrieved memory with `kind` (fact/memory/inference/recommendation/decision), `source`, `confidence`, `expires_at`. Resolve the zod v4/v3 split first.

**Tests.** Structured-output validation tests (malformed model output is rejected, not parsed); router tests (escalation happens only on the stated triggers); budget tests (exceeding a limit blocks, and is recorded).

**Acceptance.** One real agent (Reception) runs end-to-end from an event, returns a validated object, and every invocation appears in `agent_runs` with tokens and cost. Cost by agent / department / task / model is queryable.

**Risks.** Runaway API cost. Budgets and a kill switch land in this phase, not later.

---

## Phase 5 — Governance

**Goal.** Risk, autonomy, maker-checker-approver and the human approval queue are real and enforced by code.

**Scope.** `packages/policy` (pure, deterministic): autonomy levels 0–4, risk classification from configurable rules, budget checks. `ops.decisions`, `ops.reviews`, `ops.approvals`, `ops.risk_policies`. Approval queue UI. Confidence used as routing metadata only, with risk overriding it.

**Tests.** **Risk-policy tests** as a table-driven matrix; maker-checker tests (the same agent cannot check its own work); approval tests (a HIGH-risk action cannot execute without a recorded human approval); fail-closed tests for every gate.

**Acceptance.** A HIGH-risk proposal cannot execute without human approval, and the whole chain — proposal, evidence, review, risk verdict, approval, execution, result — is reconstructable from `audit_log`. LOW-risk actions execute without asking the owner anything.

**Risks.** Approval fatigue kills the control. If the owner is being asked about trivial things, the risk policy is wrong — treat that as a bug.

---

## Phase 6 — CRM abstraction

**Goal.** `CRMProvider` exists as a real hand-written port, and the engine speaks only to it.

**Scope.** `packages/ports/CRMProvider`; `packages/adapters/crm-atomic` implementing it over the existing dataProvider; engine code referencing the CRM only as `(crm_provider, crm_entity, crm_id)`. PostgREST filter syntax, react-admin idioms, view names, JSONB shapes and array columns all become adapter-internal.

**Tests.** A contract test suite the adapter must pass — the same suite a future `NativeCRMAdapter` will pass. A lint rule or test asserting no engine file imports `ra-core` or `supabase-js`.

**Acceptance.** The engine compiles with the adapter package removed from its imports; the CRM app still runs untouched.

**Risks.** Adopting today's `CrmDataProvider` type would bake PostgREST into the engine — it is `ReturnType<typeof …>` of the Supabase implementation and neither provider is actually checked against it. Write the port by hand.

---

## Phase 7 — Phase-1 UI

**Goal.** The owner can see and steer the company. Deliberately ugly.

**Scope.** `apps/ops-web`: Dashboard, Agents, Departments, Tasks, Events, Decisions, Approvals, Workflows, Costs, Logs, Integrations, Settings. Tables and cards, built on `src/components/admin` guessers. The activity stream (`14:02 webhook received → 14:03 lead classified → 14:04 response sent`) with every step inspectable. `<CRM>` mounted as one module.

**Acceptance.** Every "working" status corresponds to a real run; every rendered communication is a real message. No simulated activity, ever.

---

## Phases 8+ — Operations

Each follows the same template and is sequenced by dependency, not appetite.

| Phase | Goal | Key risk |
| --- | --- | --- |
| **8 — WhatsApp** | Webhook → normalize → identify contact → classify intent → route → respond or escalate | LGPD, sensitive content, account blocking, invasive automation. Consent and opt-out are features, not settings. |
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

1. **Phase 0.5 before everything.** Uncommitted work and an undeployable repository make every other measurement unreliable.
2. **No integration before governance.** WhatsApp and Ads are Phase 8+ because an agent that can message patients or spend money before Phase 5 exists has no brake.
3. **No agent before cost accounting.** Phase 4 ships budgets in the same phase as the runtime.
4. **No tenant two before Phase 2.** Retrofitting tenancy is the most expensive reversal on this list.
5. **Answer Q1–Q4 in `BASELINE_REPORT.md` §13 before Phase 2.** Especially Q2 (the chat-service launcher) and Q3 (does a hosted Supabase project exist, and what is in it).
