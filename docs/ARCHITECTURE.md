# Architecture — AI Company OS

**Status:** proposed target architecture, pending owner approval.
**Date:** 2026-09-10 · **Updated 2026-09-11** (Phase 0.5).
**Basis:** [BASELINE_REPORT.md](BASELINE_REPORT.md). Decisions D1–D8 there are the load-bearing choices; this document is what follows from them.

> **Phase 0.5 changed three things in this document's assumptions, and they matter more than the prose around them:**
> 1. The isolation claim was **false** and is retracted — `ops` is unreachable *through PostgREST*, not "from any browser". The MCP function is a second, unguarded channel ([ADR 0011](adr/0011-mcp-trust-boundary.md)).
> 2. The tenant-RLS pattern this document pointed at **cannot work for the worker** (`auth.uid()`, no JWT). The mechanism is now [ADR 0012](adr/0012-worker-tenant-context.md).
> 3. Pipeline stage vocabulary is **configuration, not DDL** — both CHECK constraints removed before any migration froze them ([ADR 0013](adr/0013-pipeline-stages-are-configuration.md)).
>
> Current state and what remains unverified: [PHASE_0_5_REPORT.md](PHASE_0_5_REPORT.md).

Nothing described here is built yet. What exists today is an Atomic CRM fork; see the baseline report.

---

## 1. What this system is

An operating system for a company staffed by AI employees. It represents companies, departments, agents, tools, tasks, events, decisions, reviews, approvals, workflows, budgets and audit trails as **first-class data**, and executes work against them under explicit governance.

The first tenant is an online psychology clinic in Brazil. A later tenant might be a 3D-printing business. **Nothing in the engine may be specific to either.** Tenant vocabulary — pipeline stages, department names, task types, loss reasons — is data, never DDL and never a prompt constant.

Atomic CRM is a **replaceable adapter**, not the foundation.

---

## 2. Principles

1. **The database is the source of operational state.** An LLM conversation is never application state. Agents are stateless workers plus retrieved context.
2. **Deterministic code owns anything code can do reliably.** Arithmetic, permission checks, risk evaluation, budget checks, threshold detection, CRUD, state transitions. LLMs own language, interpretation, classification where rules are insufficient, analysis and recommendation. This is a boundary, not a preference — it is most of the reliability and most of the cost control.
3. **Nothing important happens without an audit row.** Who, what, when, why, which tool, which evidence, what cost, what result.
4. **Governed communication only.** Agents do not call each other freely. They exchange tasks, events and structured messages. This is what prevents uncontrolled multi-agent loops.
5. **Fail closed.** Every gate denies by default. The repo's existing gates fail *open* (`canAccess` returns `true` for unknown resources; the harness approval hook exits 0 when it cannot identify a ticket). Port the shapes; invert the defaults.
6. **Facts, memories, inferences, recommendations and decisions are different things** and are stored differently. An agent never promotes an inference to a fact.
7. **External content is untrusted.** A WhatsApp message, a CRM note, an email or a web page may contain instructions. Tool permissions are enforced outside the model, always.
8. **Modular monolith.** Clean boundaries, one deployable worker. No microservices, no Kubernetes, no custom infrastructure where a managed service works.

---

## 3. Runtime topology (D1)

The single hardest constraint in the baseline: **Supabase Edge Functions are per-request Deno isolates**. There is no `EdgeRuntime.waitUntil` anywhere in the repo, no cron and no queue. A multi-minute agent turn has nowhere to run today.

```
                         ┌───────────────────────────────┐
   Browser  ────────────►│ ops-web (Phase-1 admin UI)    │
                         └──────────────┬────────────────┘
                                        │ HTTP (authenticated)
                         ┌──────────────▼────────────────┐
   Webhooks ────────────►│  worker  (always-on process)  │
   (WhatsApp, Ads,       │  • leases jobs from ops.jobs  │
    Postmark, …)         │  • runs agents + tools        │
                         │  • writes runs, costs, audit  │
                         │  • scheduler tick             │
                         └──────┬─────────────────┬──────┘
                                │                 │
                  ┌─────────────▼──────┐   ┌──────▼─────────────┐
                  │ Postgres (Supabase)│   │ LLM / external APIs│
                  │  ops.*   engine    │   │ via ports+adapters │
                  │  public.* CRM      │   └────────────────────┘
                  └────────────────────┘
                                ▲
                                │ PostgREST (public.* only)
                         ┌──────┴──────┐
                         │  crm-web    │  the existing Atomic CRM SPA
                         └─────────────┘
```

- **Postgres is the durable substrate**: the queue (`ops.jobs`), the scheduler table, the outbox, and all state. ⚠️ **Correction (2026-09-11):** an earlier draft said "the repo already proves the DB → `pg_net` → function hop works (`02_functions.sql:34-45`)". The *function* survives and still calls `net.http_post` at `:35`, but the fork's `04_triggers.sql:55-57` deliberately installs **no trigger that fires it** — so the hop is live only in a database built from the old migrations, and the single migration Phase 0.5 generates will `DROP TRIGGER` the last of them. Treat the outbox as **greenfield**: if the `pg_net` primitive is wanted, it must be re-declared in `supabase/schemas/` (trigger *and* `create extension pg_net`) as a deliberate act. What the repo does prove is the negative: nothing here can run for ninety seconds.
- **One always-on worker** leases jobs with `FOR UPDATE SKIP LOCKED`. It is the only thing that runs agents. It is the only thing that holds provider API keys.
- **Edge Functions stay** for what they are good at: thin, fast, authenticated HTTP — webhook ingress that writes to the outbox and returns immediately.
- Reversing D1 rewrites every tool call, which is why it is decision #1.

---

## 4. Data architecture

### Schema separation (D2)

| Schema | Contents | PostgREST |
| --- | --- | --- |
| `public` | The CRM. Unchanged. Tenant one's Atomic CRM instance. | Exposed (as today) |
| `ops` | The engine. Every table below. | **Not exposed** |

`supabase/config.toml:11` exposes schemas by explicit allowlist. Leaving `ops` out of it makes the engine unreachable **through PostgREST** by construction — a hard boundary, not a policy that can be misconfigured. The browser reaches engine data only through the worker's API.

> ⚠️ **That is not the same as "unreachable from any browser", and an earlier draft of this section and of [ADR 0002](adr/0002-tenancy-model.md) overstated it.** The allowlist governs one channel. `supabase/functions/mcp/index.ts:22-25` opens a direct libpq `Pool` whose connection string defaults to the `postgres` **superuser**, and exposes `query` and `mutate` with no schema restriction — `validateSql.ts` contains no reference to `search_path`, schema names or `public.`. A raw libpq connection ignores the PostgREST allowlist entirely, and a superuser ignores `force row level security`. So **the MCP function is a second, unguarded channel into `ops`**, and it must be removed, downgraded to a non-superuser role, or schema-restricted *before* `ops` exists. §9 already says "no arbitrary SQL as an agent capability"; this is the same decision, arriving one phase earlier. The isolation test for Phase 2 must exercise **both** channels — a PostgREST-only test proves nothing about this one. Tracked as `BASELINE_REPORT.md` §13 Q12.

This also avoids rewriting the 43 inherited `public` policies, and it means tenant two can have a different CRM, or none.

### Conventions for every `ops` table

- **UUID/ULID primary keys (D3)**, client-generatable so inserts are idempotent.
- **`tenant_id uuid not null`** on every table, with RLS routed through a helper function. ⚠️ **Do not copy the `02_functions.sql:462-509` pattern literally.** Every helper there resolves through `auth.uid()`, which reads a Supabase JWT claim — and the worker, the *only* process that touches `ops.*` (§3), holds no end-user JWT. The engine needs a different tenant-context mechanism: a `SET LOCAL`-scoped GUC (`set_config('app.tenant_id', …, true)`) read by the policy, set by the worker on a **non-superuser** role, per leased job. Copy the *shape* — one SECURITY DEFINER helper, referenced by every policy — not the `auth.uid()` source. Unresolved: `BASELINE_REPORT.md` §13 Q11. Settle it before the first `ops` policy is written.
- **`force row level security`** — the baseline has none, so today the owner role (which the MCP pool uses) bypasses every policy.
- **No foreign key into `public.*`, ever.** The CRM is referenced as `(crm_provider, crm_entity, crm_id)` text. One bigint FK into `deals` would weld Atomic CRM to the core and make "replaceable adapter" a slogan.
- **`created_at` and `updated_at` on everything.** The baseline has 9 of 13 tables without `created_at`.
- **History tables are append-only**, enforced by `REVOKE UPDATE, DELETE`. ⚠️ **Correction (2026-09-11): the repo has no example of this, and `lead_profiles` is the inverse.** Append-only means INSERT permitted, UPDATE/DELETE revoked. `lead_profiles` has no INSERT and no DELETE policy but **does** have `lead_profile_update_scoped` (`05_policies.sql:175-180`) and an explicit `grant select, update` (`06_grants.sql:25`) — a mutable current-state row that only a trigger may create. Copying it onto `ops.audit_log` would produce an audit log any authenticated user can rewrite in place, which is precisely the failure mode principle 5 exists to prevent. The append-only shape has to be **invented here**, not inherited.
- **Enumerations are reference rows, not CHECK constraints**, unless the set is genuinely engine-owned (e.g. `task.status`). Tenant vocabulary is data. The nine-value psychology CHECK on `deals` is the counter-example to avoid.

### Core entities

**Organization** — `tenants`, `companies`, `departments`, `agents`, `principals`.

> **Corrected 2026-09-12 (Phase 1C).** This line used to read "`companies` (tenants …) — the engine table is `ops.tenants`", treating company and tenant as one entity. They are two: `ops.tenants` is the **isolation boundary**, and `ops.companies` is a **business entity inside a tenant** — one tenant may hold a clinic and, later, a 3D-printing business. A company is an organisational partition, not an isolation boundary. `ops.companies` is still NOT `public.companies` (CRM customer account). Agents are configuration rows in `ops.agents`; `principals` is deferred with a shared-key mapping. See [ADR 0015](adr/0015-company-os-domain-core.md) and §15.

**Principals (D4).** One table, `kind in ('human','agent','service')`. An agent is configuration, not a running process: role, instructions, tools, permissions, model policy, budget, memory policy, department. A `sales` row is created only when an agent must act *through* the CRM adapter, and the mapping is recorded so "agent X acted on behalf of Y" is expressible.

**Work** — `tasks` (engine tasks, distinct from `public.tasks`), `jobs` (the queue), `workflows` + `workflow_versions` + `workflow_runs` + `workflow_steps`.

**Execution & cost** — `agent_runs` (one row per LLM invocation: provider, model, input/cached/output tokens, cost, latency, status), `tool_invocations`, `budgets`.

**Communication** — `events` (append-only, the spine), `agent_messages` (structured, typed, never free-form chat), `outbox`.

**Governance** — `decisions`, `reviews`, `approvals`, `risk_policies`, `audit_log` (append-only).

**Knowledge** — `memories` with `scope` (agent/department/company), `source`, `confidence`, `expires_at`, and a `kind` that distinguishes **fact / memory / inference / recommendation / decision**. An agent may never write a `fact`; only deterministic code derived from database state may.

---

## 5. Ports and adapters

> **None of the workspace layout in this document exists yet.** There is no `apps/`, `packages/` or `services/` directory, and `package.json` has no `workspaces` key — this is a single-package Vite app. Creating the workspace (package manager workspaces, tsconfig project references, and the **lint rule** [ADR 0005](adr/0005-ra-core-boundary.md) says must enforce the `ra-core` boundary "mechanically, not by convention") is itself a scoped piece of work and must be an explicit step in the first phase that needs it. Until it lands, every boundary described below is a convention, and conventions do not survive a deadline. Tracked as `BASELINE_REPORT.md` §13 Q13.

Interfaces live in `packages/ports`. They are hand-written contracts, and implementations are checked against them — unlike today's `CrmDataProvider`, which is `ReturnType<typeof getDataProviderWithCustomMethods>` (a type derived *from* the Supabase implementation) that both providers reach only via an unsafe cast.

```
CRMProvider        createContact, updateContact, getContact, findContacts,
                   createLead, updateLeadStage, addNote, getPipeline, createActivity, …
LLMProvider        complete(request) -> {output, usage, cost}
MessagingProvider  send, receive (WhatsApp Cloud API first)
AdsProvider        getCampaignMetrics, proposeChange, applyChange
AnalyticsProvider  getMetrics
CalendarProvider   getAvailability, book
```

Rules:
- The engine imports **ports only**, never an adapter.
- Adapters own their wire formats. PostgREST filter syntax (`field@ilike`, `tags@cs`), react-admin idioms, view names like `contacts_summary`, JSONB email/phone shapes and array columns are all **adapter-internal** and must not appear in engine code. There are ~50 such occurrences in UI files today.
- **`ra-core` never crosses into the engine (D5).** Every current domain type is `& Pick<RaRecord,"id">`; the engine's types must not be.
- `.claude/adapters/supabase/manifest.json` is the prior art to copy: a declared capability with detect/generate/apply/review/guard hooks, active *iff* its config block is present.

`AtomicCRMAdapter` implements `CRMProvider` over the existing dataProvider. When a native CRM replaces it, only that package changes. The test that the boundary is real: the CRM app keeps working, untouched, while the engine is built.

---

## 6. Governance

### Autonomy levels

| Level | Name | May |
| --- | --- | --- |
| 0 | Observer | read permitted data |
| 1 | Analyst | + create recommendations |
| 2 | Operator | + low-risk reversible operations |
| 3 | Supervised | + act within predefined policies and limits |
| 4 | High | + act within explicit budgets and governance rules |

Human override always exists, at every level.

### Risk

`LOW | MEDIUM | HIGH | CRITICAL`, evaluated by **deterministic code** in `packages/policy` against configurable rules — never scattered through application logic, never decided by a model.

| Risk | Default path |
| --- | --- |
| LOW | execute |
| MEDIUM | independent AI review |
| HIGH | AI review + human approval |
| CRITICAL | human approval mandatory; blocked by default |

**The default for an unmatched action is `CRITICAL`, not `LOW`.** An action that matches no rule is an action nobody has classified, and principle 5 applies to the risk engine itself before it applies to anything else. The natural implementation of "evaluate against configurable rules" — iterate, return the highest match, fall through to the bottom — is exactly the `return true` shape this repo already ships in `canAccess.ts`. Invert it: fall through to deny, and make "an unclassified action was attempted" a visible event, so the gap gets a rule instead of a silent pass.

Inherently high/critical: large ad-budget changes, deleting data, billing changes, sending sensitive information, touching clinical data, changing security settings, mass messaging, irreversible external actions. **This list is seeded rows in `ops.risk_policies`, not constants in `packages/policy`.** It is tenant-shaped — "touching clinical data" means nothing to a 3D-printing tenant — and hardcoding it would repeat the `deals` CHECK mistake in the component that is hardest to change safely. The engine ships the *evaluator*; the rules are data, versioned and auditable like any other tenant configuration.

### Maker → Checker → Approver

The maker agent produces work; a **different** agent reviews it; the policy engine or a human approves. Every stage writes an audit row. The repo already contains a structurally-enforced version of this at dev time (`.claude/hooks/block-merger-without-review.mjs` refuses a merge until a review flag exists) — port the shape, but note it exits 0 when it cannot identify a ticket, which is exactly the fail-open default to invert.

### Confidence

Confidence is **routing metadata, not probability**. `≥0.90` normal flow; `0.70–0.89` review; `<0.70` escalate or gather more evidence. **Risk always overrides confidence.**

⚠️ **Confidence is self-reported by the maker, so it must never be the only thing standing between the maker and the checker.** A maker that emits `0.95` routes itself past review for everything the risk engine rates LOW or MEDIUM — "risk overrides confidence" only rescues HIGH and CRITICAL. Two constraints follow, and both are testable: (1) whether an action *class* requires a checker is decided by **risk and autonomy level**, never by the maker's own number — confidence may only escalate review, never skip it; (2) reported confidence is recorded on `agent_runs` and **calibrated against outcomes**, so an agent whose 0.95s are wrong 30% of the time is detected as a defect rather than trusted forever.

### Approval queue

One human-facing queue. The owner must not be asked to approve trivial operations — approval fatigue defeats the entire control. Everything LOW-risk executes and is merely *visible*.

---

## 7. Agent runtime

An agent is **configuration + policy**, never a running model. When work exists, an `agent_run` is created. When there is no work, the agent costs nothing.

```
event / schedule / task
        ↓
   policy engine        permissions, risk, budget — deterministic, pre-flight
        ↓
   model router         cheapest tier that can do the job
        ↓
   agent run            structured output, schema-validated
        ↓
   checker              independent review where risk requires it
        ↓
   approver             policy or human
        ↓
   execution            idempotent, audited, reversible where possible
```

**Model router.** Four tiers — T1 classification/extraction/routing, T2 routine analysis and review, T3 strategy and complex reasoning, T4 frontier for rare hard problems and executive synthesis. Start cheap, escalate on low confidence or detected complexity. Provider-agnostic behind `LLMProvider`.

**Structured outputs are mandatory.** Schema-validated objects, never parsed prose. Note the baseline has `zod` declared at v4 but imported only in one edge function at v3 — that split must be resolved before schemas are shared across the worker, the functions and the browser.

**Memory is retrieved, not accumulated.** Short-term task context, then agent / department / company memory by retrieval. The whole company history is never sent to a model.

**Cost accounting is not optional.** Every invocation records provider, model, token counts, cost, agent, department, task and workflow. Budgets are per-agent daily / monthly / per-task. Exceeding one warns, throttles, falls back or requires approval — it never silently continues.

**A fleet-wide kill switch is a deliverable, not a footnote.** Per-agent budgets bound one agent; they do not bound twenty agents each behaving within budget, a retry storm, or a workflow that spawns runs in a loop. The engine therefore ships a single, deterministic stop that (a) is enforced in the worker's pre-flight, not in a prompt, (b) halts new `agent_runs` across every tenant and department at once, (c) is reachable by the owner from the Phase-1 UI in one click and from a CLI without the UI, and (d) is **tested** — a test that trips it and asserts the next run is refused. Alongside it, a global daily spend ceiling that trips the same switch automatically. This belongs in the same phase as the runtime, with its own acceptance criterion.

---

## 8. Events, jobs and reliability

**Event-driven, not polling** — *at the agent layer.* Agents wake on events, schedules and tasks; no agent is ever invoked to go and look for work. This is most of the cost control, and it is the claim that matters, because agent wake-ups cost money.

Be precise about the layer below, though: the **transport** is a poll. Job leasing with `FOR UPDATE SKIP LOCKED` (§3) and the scheduler tick are both loops against Postgres, and an earlier draft of this section read as if they were not. That is a deliberate trade — a Postgres-backed queue is the right substrate at this scale ([ADR 0001](adr/0001-runtime-execution-substrate.md)) — but it has to be stated with its numbers, because "event-driven" without a latency budget is how a 30-second poll ends up behind a WhatsApp reply:

- **Idle poll interval and target wake-up latency are configuration with explicit defaults**, not incidental constants. A webhook-triggered job should start in single-digit seconds.
- **Use `LISTEN`/`NOTIFY` to collapse the idle latency**: the outbox write issues a `pg_notify`, the worker blocks on `LISTEN` and falls back to the timed poll. The poll remains the correctness mechanism (notifications are not durable); the notify is only there to make the common case fast.
- A polling loop with zero jobs costs one cheap query and **zero tokens**. That is the distinction the principle is actually protecting.

**Outbox pattern.** Domain writes and their event rows commit in the same transaction; the worker publishes from the outbox. The repo's existing `pg_net` trigger is the transport primitive and also a catalogue of what to avoid: fire-and-forget, no retry, no delivery reconciliation, and a silent no-op whenever there is no end-user `Authorization` header.

**Idempotency is mandatory on every external action.** Idempotency keys, event ids, execution locks, dedup tables. The baseline has none — the Postmark webhook ignores the `MessageID` it is handed on every request, and returns 403 on failure specifically to stop the provider retrying, so failed ingests vanish permanently.

**Retries are classified**: safe-retry, unsafe-retry, needs-human. Exponential backoff, dead-letter queue, explicit failure states, manual retry with error context. Dangerous actions are never silently retried.

**Concurrency.** Job leasing via `FOR UPDATE SKIP LOCKED`; optimistic locking (`version` column) on anything a human and an agent can both touch. The baseline is last-write-wins with no version column anywhere.

---

## 9. Security

- **Secrets never in the database, never in prompts, never in the browser.** The baseline commits an EC private signing key and a webhook password to git via a deliberate `.gitignore` negation; the worker's provider keys must not follow that path.
- **RBAC + per-agent, per-department, per-tool permissions**, enforced in Postgres and in the worker — never in the frontend, which only hides menus.
- **Tool permissions are enforced outside the LLM.** A model asking for a capability it lacks is denied by code.
- **External content is data.** Content ingested from WhatsApp, email, web or CRM notes is stored with provenance and a trust level, and never interpreted as instructions to the system.
- **No arbitrary SQL as an agent capability.** The existing MCP `query`/`mutate` pair is the fastest agent-to-data path and the largest blast radius, and it is structurally incompatible with a replaceable CRM. Agents get typed tools.
- **Clinical data is segregated by design.** General agents work with operational, administrative, marketing, CRM, financial and scheduling data. Clinical records get separate access policies and a separate storage boundary; no general agent has a path to them. LGPD retention, erasure and data-subject requests are engine features, not later concerns.

  ⚠️ **This paragraph is currently an assertion with no schedule behind it, and that is a real gap.** "Not later concerns" has to mean something in `ROADMAP.md`: the phase that first ingests patient-adjacent content (WhatsApp) must carry data-subject rights, retention and the clinical boundary **in its own Scope, Tests and Acceptance** — not in a hardening phase after ingestion has been running. The minimum that must exist *before* the first patient message is stored: a declared lawful basis and retention period per data class; erasure that actually erases (including from agent memory and any derived summary); a stored `do_not_contact`/consent state that no code path can silently drop (the `merge_contacts` cascade in `BASELINE_REPORT.md` §7.5a is the worked example of getting this wrong); and a test proving a general agent's tool surface cannot reach clinical records. LGPD Q8 (multi-tenant processor/controller roles) is still open.

---

## 10. Frontend

Phase 1 is deliberately ugly. Simple tables and cards over: Dashboard, Agents, Departments, Tasks, Events, Decisions, Approvals, Workflows, Costs, Logs, Integrations, Settings. `src/components/admin/`'s guessers make this hours of work.

The engine exposes clean read APIs — companies, departments, agents, agent status, communications, active tasks, decisions, alerts, meetings — so a later isometric UI can *represent real backend state*. No agent ever shows "working" without a real run behind it, and no communication is rendered that is not a real message. Simulated activity is forbidden.

`<CRM>` is mounted as one module under the ops root; it is not extended. It has no `children` prop and its routes are literal JSX in two places, so making it extensible costs more than mounting it.

---

## 11. Testing

Unit, integration, workflow, **permission/RLS**, **risk-policy**, **idempotency**, failure/retry, and structured-output validation. RLS tests run as at least three principals. The baseline has **zero** policy assertions across 29 unit files and 4 e2e specs; that is the single largest test gap, because an untested policy layer is the whole platform's security boundary.

A feature is done when it works, is tested, logged, permission-controlled, cost-tracked, failure-handled, documented, observable, secure, and reversible where possible.

---

## 12. Documentation

`/docs/ARCHITECTURE.md` (this), `BASELINE_REPORT.md`, `ROADMAP.md`, `DECISIONS.md` (ADR index) exist now. `DATABASE.md`, `AGENTS.md`, `WORKFLOWS.md`, `PERMISSIONS.md`, `SECURITY.md`, `INTEGRATIONS.md`, `COSTS.md` are written **as their phase lands** — writing them before the code would be fiction. ADRs live in `/docs/adr/`.

The repository is the persistent project memory. Conversation history is not.

---

## 13. Phase 1A as built (2026-09-12)

Sections 3 and 8 describe the intended runtime. What exists now is its **database half**, and only that:

```
ops.tenants ── ops.jobs ── ops.job_events
                  │
        ops.lease_job(worker, seconds)      SECURITY DEFINER
          reap expired leases
          UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)
          install app.worker_id + app.job_id, transaction-local
                  │
        ops.current_tenant_id()             resolves the tenant FROM THE LEASE
                  │
        every ops policy reads that one helper
                  │
        ops.complete_job / ops.fail_job     verify the lease, then settle
```

`engine/worker/runOneJob.ts` is the application-side counterpart: one unit of work, database client injected, no driver dependency and no daemon. It encodes the ordering invariant — *trusted leased row → tenant established server-side → execute → settle* — and refuses to run a handler if the session's tenant disagrees with the lease.

**Not built, deliberately:** the always-on process, a scheduler, handlers, retry policy beyond attempts-and-backoff, an outbox, and anything agent-shaped. See [PHASE_1A_REPORT.md](PHASE_1A_REPORT.md) for what is verified and what is not.

---

## 14. Phase 1B as built (2026-09-12)

Section 13 described a database half with no process. There is now a process.

```
  ops.enqueue_job  (service_role: an edge function, an operator, a scheduler)
          |
          v
  ops.jobs  ──────────────────────────────────────────────── the source of truth
          |
          |  TX1   set local role ops_worker
          |        ops.lease_job(worker_id, seconds)   -> COMMIT
          |        (attempts += 1, lease is now visible and can go stale)
          v
  ┌─────────────────────────────────────────────────────────────────┐
  │ worker process            engine/worker/main.ts                 │
  │   boot: assertWorkerIdentity()   <- refuses postgres/service_role│
  │   loop: reaper tick | heartbeat | runOneJob                      │
  └─────────────────────────────────────────────────────────────────┘
          |
          |  TX2   set local role ops_worker
          |        ops.resume_lease(worker_id, job_id)  -> tenant context
          |        registry[job.kind]                   -> handler or REFUSE
          |        handler(job, capabilities)           <- no client, no SQL
          |        ops.complete_job(job_id, detail)     -> COMMIT
          v
  ┌─────────────────────────────────────────────────────────────────┐
  │ TX3 (only on failure)  classify -> ops.settle_job_failure        │
  │      TX2 rolled back, so partial work is gone; the reason is not │
  └─────────────────────────────────────────────────────────────────┘
```

| Piece | File | Note |
| --- | --- | --- |
| Driver adapter | `engine/db/workerDatabase.ts` | The **only** module that imports `pg`. One checked-out client per transaction; `pool.query()` is not expressible. |
| Database port | `engine/db/types.ts` | Driver-free, so handlers and their tests never depend on `pg`. |
| Boot gate | `engine/db/workerIdentity.ts` | Refuses an identity that would make RLS decorative. |
| Ordering invariant | `engine/worker/runOneJob.ts` | The three transactions above, and every refusal between them. |
| Loop | `engine/worker/runWorker.ts` | Poll, heartbeat, reaper tick, backoff, graceful stop. Signals are the caller's job. |
| Registry | `engine/worker/handlerRegistry.ts` + `registry.ts` | A `Map`, so there is no prototype chain for a kind like `toString` to resolve against. |
| Capabilities | `engine/worker/capabilities.ts` | Built per job from the handler's declared list. Frozen. |
| Failure taxonomy | `engine/worker/failures.ts` | `transient` / `permanent` / `security` / `unknown`, by error type then SQLSTATE. Default is `unknown`, never `transient`. |
| The one handler | `engine/handlers/postmarkLedgerRetention.ts` | LGPD retention for `public.inbound_emails`. |
| Deployment step | `scripts/provision-worker-role.mjs` | Creates the LOGIN role. Not a migration: a password in a migration is a secret in git. |

**What is deliberately absent.** No broker, no scheduler service, no leader election, no Redis, no Kafka, no Temporal, no container orchestration. `FOR UPDATE SKIP LOCKED` is the entire concurrency mechanism and it is enough at this scale. Still a modular monolith.

**Recovery does not wait for business traffic.** The loop runs a reaper tick on its own clock, independent of whether anything is queued. `pg_cron` was evaluated and measured to work here (it is in `shared_preload_libraries`), and rejected: it would add an extension to a baseline whose whole posture is that an extension is a capability decision, to buy recovery while the entire fleet is down — a state in which nothing needs recovering anyway. The residual gap is a worker that is alive but wedged, which the heartbeat makes visible.

**Running it.**

```bash
npm run worker:provision      # once per environment; needs OPS_WORKER_PASSWORD
npm run worker                # needs OPS_WORKER_DATABASE_URL
```

---

## 15. Phase 1C as built (2026-09-12)

The organisational model, deterministic, with no agent able to run. [ADR 0015](adr/0015-company-os-domain-core.md) records every decision below and the alternatives rejected.

```
ops.tenants                          the isolation boundary (1A)
  └─ ops.companies                   a business entity; a tenant may hold several
       ├─ ops.departments            an organisational unit of one company
       │    └─ ops.agents            configuration + identity of a virtual employee
       ├─ ops.tasks                  business work (parent -> child, same company)
       │    └─ ops.task_jobs ──────► ops.jobs     domain -> execution, never the reverse
       └─ ops.events                 durable facts, derived from the rows above
```

| Distinction | What keeps it |
| --- | --- |
| Tenant ≠ Company | `tenant_id` on every row; a company is a partition inside a tenant, not an isolation boundary |
| Agent ≠ Worker | `ops.agents` is configuration; the worker is a process and holds no privilege on it |
| Task ≠ Job | separate tables; the bridge is `ops.task_jobs`, owned by the domain; creating a task enqueues nothing |
| Event ≠ Audit log | `ops.events` holds business facts; execution audit stays in `ops.job_events` |

| Piece | Where | Note |
| --- | --- | --- |
| Tables, guards, events, services | `supabase/migrations/20260912200000_company_domain_core.sql` | Hand-written, idempotent, 13 end-state assertions |
| Integrity | composite foreign keys + guard triggers | Cross-tenant and cross-company rows unstorable for every role but the owner |
| State machine | `ops.task_status_transitions()` + `tasks_guard_update` (ENABLE ALWAYS) | 11 edges; a closed task is immutable |
| Events | `ops.emit_lifecycle_event()` | Exactly one fact per change, in the same statement; reserved lifecycle namespaces |
| Services | `ops.create_company`, `set_company_status`, `create_department`, `set_department_status`, `create_agent`, `set_agent_status`, `create_task`, `assign_task`, `transition_task`, `record_event`, `request_task_execution` | SECURITY INVOKER, explicit authorised tenant scope, owner-only EXECUTE |
| Bridge | `ops.request_task_execution` + `ops.task_jobs` | Tenant from the task row; empty kind allowlist; task-scoped idempotency; inserts its own job so a concurrently enqueued key is refused, never adopted |
| Typed boundary | `engine/domain/companyOs.ts`, `errors.ts`, `taskStateMachine.ts` | Typed inputs and errors; authorises nothing; a native 42501 is never disguised |
| Dev bootstrap | `supabase/seed.sql` | A development tenant with one company, three departments, two agents — tenant vocabulary lives in seed data only |

**Who can touch it.** Nobody but the owner in Phase 1C. No `anon`, `authenticated`, `service_role` or `ops_worker` privilege on any table or function, no PUBLIC EXECUTE, and a pinned per-run EXECUTE set that fails by name if that changes. The lease-bound read policies on every domain table have no grant behind them; they fix the scope of a future worker read before it exists.

**Deliberately absent.** No model, prompt, tool, memory, approval, review, UI or CRM link; no `risk_level`, task input/result, company settings or agent configuration blob; no executable task kind (the allowlist is empty); no worker access to domain data. The kill switch and cost ledger ([ADR 0010](adr/0010-cost-control-and-kill-switch.md)) are still owed before any agent can run.
