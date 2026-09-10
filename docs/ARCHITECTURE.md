# Architecture — AI Company OS

**Status:** proposed target architecture, pending owner approval.
**Date:** 2026-09-10
**Basis:** [BASELINE_REPORT.md](BASELINE_REPORT.md). Decisions D1–D8 there are the load-bearing choices; this document is what follows from them.

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

- **Postgres is the durable substrate**: the queue (`ops.jobs`), the scheduler table, the outbox, and all state. The repo already proves the DB → `pg_net` → function hop works (`02_functions.sql:34-45`); it proves nothing can run for ninety seconds.
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

`supabase/config.toml:11` exposes schemas by explicit allowlist. Leaving `ops` out of it makes the engine unreachable from any browser by construction — a hard boundary, not a policy that can be misconfigured. The browser reaches engine data only through the worker's API.

This also avoids rewriting the 43 inherited `public` policies, and it means tenant two can have a different CRM, or none.

### Conventions for every `ops` table

- **UUID/ULID primary keys (D3)**, client-generatable so inserts are idempotent.
- **`tenant_id uuid not null`** on every table, with RLS routed through a helper function, following the pattern at `02_functions.sql:462-511`.
- **`force row level security`** — the baseline has none, so today the owner role (which the MCP pool uses) bypasses every policy.
- **No foreign key into `public.*`, ever.** The CRM is referenced as `(crm_provider, crm_entity, crm_id)` text. One bigint FK into `deals` would weld Atomic CRM to the core and make "replaceable adapter" a slogan.
- **`created_at` and `updated_at` on everything.** The baseline has 9 of 13 tables without `created_at`.
- **History tables are append-only**, enforced by `REVOKE UPDATE, DELETE`. The repo already has this shape: `lead_profiles` has no INSERT or DELETE policy and is written only by a SECURITY DEFINER trigger.
- **Enumerations are reference rows, not CHECK constraints**, unless the set is genuinely engine-owned (e.g. `task.status`). Tenant vocabulary is data. The nine-value psychology CHECK on `deals` is the counter-example to avoid.

### Core entities

**Organization** — `companies` (tenants; note the name collision with `public.companies`, which means *CRM customer account* — the engine table is `ops.tenants`), `departments`, `principals`.

**Principals (D4).** One table, `kind in ('human','agent','service')`. An agent is configuration, not a running process: role, instructions, tools, permissions, model policy, budget, memory policy, department. A `sales` row is created only when an agent must act *through* the CRM adapter, and the mapping is recorded so "agent X acted on behalf of Y" is expressible.

**Work** — `tasks` (engine tasks, distinct from `public.tasks`), `jobs` (the queue), `workflows` + `workflow_versions` + `workflow_runs` + `workflow_steps`.

**Execution & cost** — `agent_runs` (one row per LLM invocation: provider, model, input/cached/output tokens, cost, latency, status), `tool_invocations`, `budgets`.

**Communication** — `events` (append-only, the spine), `agent_messages` (structured, typed, never free-form chat), `outbox`.

**Governance** — `decisions`, `reviews`, `approvals`, `risk_policies`, `audit_log` (append-only).

**Knowledge** — `memories` with `scope` (agent/department/company), `source`, `confidence`, `expires_at`, and a `kind` that distinguishes **fact / memory / inference / recommendation / decision**. An agent may never write a `fact`; only deterministic code derived from database state may.

---

## 5. Ports and adapters

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

Inherently high/critical: large ad-budget changes, deleting data, billing changes, sending sensitive information, touching clinical data, changing security settings, mass messaging, irreversible external actions.

### Maker → Checker → Approver

The maker agent produces work; a **different** agent reviews it; the policy engine or a human approves. Every stage writes an audit row. The repo already contains a structurally-enforced version of this at dev time (`.claude/hooks/block-merger-without-review.mjs` refuses a merge until a review flag exists) — port the shape, but note it exits 0 when it cannot identify a ticket, which is exactly the fail-open default to invert.

### Confidence

Confidence is **routing metadata, not probability**. `≥0.90` normal flow; `0.70–0.89` review; `<0.70` escalate or gather more evidence. **Risk always overrides confidence.**

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

---

## 8. Events, jobs and reliability

**Event-driven, not polling.** Agents wake on events, schedules and tasks. This is most of the cost control.

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
