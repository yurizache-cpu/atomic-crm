# ADR 0015 — Company OS domain core

**Status:** **Accepted** (owner decision 2026-09-13, WITH the owner addendum at the end of this record) · **Date:** 2026-09-12 (accepted 2026-09-13)
**Implemented by:** `supabase/migrations/20260912200000_company_domain_core.sql`, `engine/domain/`

## Context

Phases 1A and 1B built a tenant-safe execution substrate: `ops.tenants`, `ops.jobs`, a lease-bound tenant context, and a worker that runs one deterministic handler. Nothing in the system represented the company itself. Phase 1C adds the organisational primitives future AI workers will operate on — companies, departments, agents, tasks and events — still deterministic, with no model, prompt, tool or UI.

Several of the choices below are expensive to reverse once agents and tenants depend on them. An adversarial design review (88 findings, 6 lenses, 2 verifiers) changed several of them before any SQL existed, and an adversarial pass over the built surface changed two more (the bridge's idempotency under concurrency, and the scope of PL/pgSQL's privilege caching). This record states the decisions and the reasons the obvious alternatives were rejected.

## Decision

### 1. The domain lives in `ops`, not a new schema

[ADR 0002](0002-tenancy-model.md) already puts engine tables in `ops`, off the PostgREST allowlist. Every guard this repository has for `ops` — ENABLE + FORCE RLS on every table, policies that read `ops.current_tenant_id()`, no write verb for `ops_worker`, no reach for `anon`/`authenticated`, `security_invoker` on views — covers a new `ops` table the day it is created. A separate `company` schema would need all of them duplicated, a cross-schema dependency on the tenancy helper, and a USAGE decision per role, to buy a separation that dependency direction already provides.

`ops.companies` and its `company_id` columns are NOT `public.companies`, which means CRM customer account and is adapter-internal. Every reference is schema-qualified, and the table comment says so. The CLAUDE.md rule "do not repurpose `company_id`" is about `public.*`.

### 2. Tenant is the isolation boundary; company is not

A tenant may hold several companies ~~(a clinic now, a 3D-printing business later)~~. *(Corrected 2026-09-13 by owner decisions 3 and 4 in the addendum: a clinic and a 3D-printing business need independent data isolation, so each is its own tenant; several companies in one tenant are organisation only.)* A company is an **organisational partition inside a tenant, not a data-isolation boundary**: businesses that must not see each other's data are separate tenants. Consequently, any capability reached from company-scoped work must authorise against a company-level binding — never against the tenant-level `ops.tenants.owns_local_crm` alone.

`owns_local_crm` stays a tenant-level boolean in 1C, decided deliberately as Phase 1B asked: no capability needs company-level CRM resolution yet, and the proper model is a company ↔ CRM-adapter binding `(crm_provider, crm_entity, crm_id)` ([ADR 0003](0003-identifier-strategy.md)) when one first does.

### 3. Structural integrity through composite keys

Every Company OS table carries `tenant_id`; every reference to another Company OS row is a composite foreign key that includes `tenant_id` (and `company_id`), so a cross-tenant or cross-company row cannot be stored. Where a foreign key cannot say it, a guard trigger does: a task's parent must already exist in the same company (a foreign key is checked at the end of the statement, so one multi-row INSERT could otherwise store a cycle), an event's subject and cause must live in its company, and org-unit ownership columns are immutable (a composite key only checks the new parent exists, so an unreferenced department could otherwise move to another tenant). When a task is department-scoped and assigned, a four-column key pins the agent to that department. Moving an agent means creating a new agent.

### 4. Backend-only authority, and why every function is SECURITY INVOKER

No runtime caller exists in 1C (no UI, no agent, no API), so **no application role — `anon`, `authenticated`, `service_role`, `ops_worker` — holds any privilege on a Company OS table or function.** The domain functions take an explicit `p_tenant_id` meaning "the tenant scope the caller is already authorised for", and resolve every other id inside it: an id outside the scope is "not found", in the same statement that reads its state, so a status of another tenant's row is never observable.

They are **SECURITY INVOKER**, and that is load-bearing. An explicit-tenant SECURITY DEFINER function becomes a forgeable-tenancy primitive the moment anyone grants it — the exact thing [ADR 0012](0012-worker-tenant-context.md)'s revision 2 removed. An INVOKER function granted to another role still hits `42501` on the tables.

Two measured facts constrain this:

- PostgreSQL gives every new function EXECUTE to PUBLIC, and the Phase 1A per-schema default-privilege revoke does not remove it. Every function is revoked explicitly; a pinned per-run EXECUTE set catches a forgotten one.
- **EXECUTE on an inner helper is not a boundary.** PL/pgSQL does not re-check EXECUTE on every call. For a helper called with constant or no arguments — the IMMUTABLE helpers the guard triggers call, such as `ops.derived_event_namespaces()` — the check is folded into the cached plan and lasts for the life of the backend, across transactions, rollbacks and role switches, until that function's catalogue row changes. A helper called with parameters is re-checked per transaction. (Measured in the Phase 1C adversarial pass; an earlier draft of this ADR said "per transaction" for both.) Table and schema privileges, by contrast, are re-checked on every execution. The boundary is therefore table privileges plus the wrapper below; a future non-owner writer role must be granted the trigger helpers deliberately, or whether a guard raises a native `42501` will depend on what that pooled backend ran before.

**The future wrapper contract.** A runtime caller gets a thin SECURITY DEFINER wrapper that takes **no tenant, company, source or causation argument**: it resolves the tenant from the lease (worker) or a membership (human), then calls the internals. Worker *reads* should prefer a direct SELECT grant under the lease-bound policies, which are already declared on every domain table with no grant behind them, so RLS stays the backstop where it can.

The owner (`postgres`, BYPASSRLS) is outside this boundary by design. It can `DISABLE TRIGGER`, and on Supabase it can set `session_replication_role = replica`, which skips ORIGIN triggers and foreign-key checks. The UPDATE-path guards are therefore `ENABLE ALWAYS`; insert validation and event emission stay ORIGIN, so an owner data restore in replica mode neither re-validates nor duplicates history. The static migration guard rejects a migration that disables, downgrades, drops without re-creating, or CASCADE-drops an `ops` trigger, and one that sets `session_replication_role`.

### 5. Agents are configuration

`ops.agents` holds identity and configuration only: name, role, description, department, status. No provider, model, prompt, temperature, tool, memory, autonomy level or manager. Lifecycle is `active | inactive`. A third `disabled` state was not implemented: until something distinguishes it from `inactive` it is vocabulary without behaviour, and an administrative stop is the kill switch's job ([ADR 0010](0010-cost-control-and-kill-switch.md): deny-wins, audited, scoped). `agents.status` is never how a kill switch is implemented. Deactivating an agent does not touch its open tasks; they keep their assignee until reassigned or closed.

`ops.agents` precedes [ADR 0004](0004-principal-model.md)'s `ops.principals`. The intended mapping is a shared key: when principals land, an agent's principal row uses the agent's id, so no reference is remapped.

### 6. Tasks are business work, with the state machine in the database

`queued → assigned → in_progress → completed`, with `waiting`, `failed` and `cancelled` — 11 edges, engine vocabulary. A task is born queued and unassigned; `assigned` is reached only by an assignment; there is no edge back to `queued`; a closed task (completed, failed, cancelled) refuses **any** update; a retry is a new task. `completed_at` and `updated_at` are derived, never supplied. The BEFORE UPDATE trigger is the only enforcement point. `engine/domain/taskStateMachine.ts` mirrors the relation for typing, authorises nothing, and a driver-backed test asserts equality.

Assignment is deterministic: the agent must exist in the task's tenant and company, be active, and belong to the task's department if it has one. Domain functions lock rows before checking them, so a reassignment racing a completion is refused rather than landing after it.

Deliberately not implemented: `risk_level` (risk is evaluator output per [ADR 0009](0009-governance-envelope.md) Decision 1, and no evaluator exists — a caller-set label would be trusted by the first gate that read it), `input`/`result` references (no consumer; a typed `(crm_provider, crm_entity, crm_id)` reference is the likely shape when one exists), company `settings` and agent `configuration` blobs (no consumer, no schema). Task priority orders work within a company and is never copied into `ops.jobs.priority`, which is platform-assigned.

### 7. Lifecycle events are derived from state, never asserted

AFTER triggers write exactly one event per change in the same statement — `company.created`, `*.status_changed`, `task.assigned` (carrying the status change of `queued → assigned`), `task.completed|failed|cancelled`, `task.status_changed`, `task.execution_requested` — so a change and its fact commit or fail together on every write path, not only on paths that remember to call an emitter. A no-op change emits nothing (`WHEN OLD IS DISTINCT FROM NEW`).

Provenance, correlation and causation travel in transaction-local settings the domain functions push and pop around their DML (save and restore, so nested calls compose); the emitting trigger refuses a change with no declared provenance. That is a tripwire, not an authority: any role can write a GUC, and only the owner holds DML. `company`, `department`, `agent`, `task` and `job` are reserved namespaces that `ops.record_event` and direct inserts cannot use.

An event is never rewritten: an `ENABLE ALWAYS` trigger refuses every UPDATE, replica mode included. It is **not** append-only against the owner: DELETE is unguarded, because the only role holding it is the owner, and tenant erasure (LGPD) and retention need it. Events carry an identity `seq` for in-transaction order and ~~hold no free text a human typed~~ (task titles and descriptions never enter an event payload). *(Narrowed 2026-09-13: no trigger-derived payload includes a task title or description, but lifecycle payloads do carry organisational labels, a company's, department's or agent's `slug` and `name` and an agent's `role`, and `ops.record_event` stores any JSON object of at most 16 KB, unfiltered; its EXECUTE is revoked from PUBLIC and granted to no role.)*

Events are business facts, not the audit log: execution audit stays in `ops.job_events`. The events table written in the domain transaction is the durable outbox; delivery order across commits and consumer cursors are a Phase 1D decision. **Narrowed 2026-09-13 (owner addendum, decision 5):** any tenant-facing cursor must be tenant-scoped or opaque; `seq` is internal only.

### 8. Task ≠ job, and the bridge points one way

`ops.task_jobs` (owned by the domain) links a task to the jobs it requested; `ops.jobs` gains a unique `(tenant_id, id)` and no reference to the domain. `ops.request_task_execution` takes the job's tenant from the **task row**, never from the payload; enqueues only a kind in `ops.task_executable_kinds()`; scopes its idempotency key to the task (`task:<task_id>:<key>`, the caller's part bounded at 200 characters) and refuses to adopt a job the task did not request. Creating a task never enqueues anything, and settling a job never changes a task — business completion may need review.

**The bridge inserts its own job rather than calling `ops.enqueue_job`.** That function's idempotent path returns whichever row holds the key. The adversarial pass measured, with two real connections, a `service_role` caller committing a job under a task's namespaced key between the bridge's idempotency check and its enqueue — and the bridge then linking that job as a request the task had made. A plain INSERT turns the race into a unique violation, which the bridge refuses with `OS409`; it writes the same `enqueued` row in `ops.job_events` that `enqueue_job` would. A driver-backed test runs the race.

**The allowlist is empty in 1C.** The only registered handler, `postmark.ledger_retention`, is tenant-wide CRM maintenance: a company-scoped task must not be able to trigger it, or shorten its retention window through the payload. The bridge's success path is proven with an allowlist replaced inside a rolled-back test transaction.

A link restricts deleting its job, so any future job retention must decide what to do with linked jobs. In 1C the runtime does not read domain tables and `engine/worker` does not import `engine/domain` (ESLint-enforced). A later phase may still resolve a job's company or department through `ops.task_jobs` at lease time — the kill switch's company/department/agent scopes will need exactly that — and a kill-switch refusal must then be a settlement that does not consume an attempt.

## Alternatives

- **A dedicated `company` or `core` schema.** Rejected: duplicated guards, cross-schema tenancy, and ADR 0002 amended for a separation dependency direction already gives.
- **SECURITY DEFINER domain functions.** Rejected: with an explicit tenant argument they are forgeable-tenancy primitives the moment they are granted.
- **Granting `ops_worker` SELECT on the domain now.** Rejected: no Phase 1C flow reads it, and the brief forbids broadening the worker by default. The policies are declared so a future grant is born scoped.
- **Explicit event inserts in each function.** Rejected: a later code path that forgets one loses the fact silently. Triggers make emission a property of the write.
- **Allowlisting `postmark.ledger_retention` so the bridge runs end to end.** Rejected in design review: it would let company-scoped work trigger tenant-wide CRM deletion.
- **A reference table for task statuses.** Rejected: the set is engine vocabulary (ADR 0013's test), and a function plus trigger is reviewed code, not a row an owner can edit.
- **Having `ops.enqueue_job` refuse `task:`-prefixed keys from other callers.** Rejected: it changes a Phase 1A function other callers depend on to protect a Phase 1C invariant, and still leaves the bridge trusting a function whose idempotent path returns another caller's row.

## Consequences

- Company OS writes are isolated by function code, grants and composite keys — not by RLS — on every path that exists in 1C. The DoD's "missing/malformed tenant context fails closed" holds on the function path (no scope, unknown scope, malformed scope) and, for the lease-bound policies, only as shape evidence through a transaction-scoped grant: a lease owned by another worker, an expired lease and no lease all read nothing.
- ~~Onboarding FireForge 3D is data: a company, departments and agents in a tenant.~~ **Corrected 2026-09-13 by the owner addendum:** onboarding FireForge 3D is data in **its own tenant** — a tenant row, then its company, departments and agents. No migration.
- Every future ops function must be revoked from PUBLIC explicitly, and the pinned EXECUTE set in `company_domain_core.sql` must be updated in the same change that grants anything — a deliberate, reviewable diff.
- The `waiting → failed` edge exists; `waiting → completed` does not (work resumes, then completes).
- A data-only restore of Company OS rows must run in replica mode, or the emission triggers either refuse it (no provenance) or duplicate its events.
- Deactivating a company refuses new departments, agents, tasks and execution requests under it, but existing tasks can still be assigned and moved through their lifecycle, so open work can be closed out. Stopping work is the kill switch's job, not company status.
- `ops.events.seq` is one identity across tenants, so a reader of one tenant's events could infer other tenants' event volume from the gaps. Nothing but the owner reads events in 1C; a per-tenant cursor belongs with the consumer design in Phase 1D. **Binding since 2026-09-13:** `seq` is internal only, and a tenant-scoped or opaque cursor must be designed before any tenant-facing reader exists (owner addendum, decision 5). **Extended 2026-09-13:** the same rule covers `ops.job_events.id` and any future global monotonic sequence (owner clarification below).
- Platform roles outside this project's grants — members of `pg_read_all_data`, and `supabase_read_only_user` — can read `ops` as they can read everything. That is a hosting-level privilege, not a Company OS grant, and the static guard rejects any migration granting them more.
- ADRs 0002, 0003 and this one should be accepted or amended before Phase 1D builds agent runs on them. *(2026-09-13: this record was accepted with the owner addendum below. ADRs 0002 and 0003 were reconciled with it on 2026-09-13 and remain Proposed, so they must still be accepted or amended before Phase 1D builds agent runs on them.)*

---

## Addendum 2026-09-13 — owner decisions recorded on acceptance

**Accepted by the owner on 2026-09-13, with the decisions below.** They bind Phase 1D and every later phase. Where one narrows a statement above, that statement is corrected in place and points here.

1. **Tenant is the security and isolation boundary.** Nothing else in the Company OS is one.
2. **Company is an organisational entity only.** It is not a security boundary. No guard, grant, policy or capability may be described as isolating one company from another inside a tenant, or relied on to do so.
3. **Businesses that need independent data isolation are separate tenants.** The psychology clinic is one tenant, and FireForge 3D is another. They must not be modelled as two companies inside the same tenant.
4. **A tenant may still hold several companies structurally.** The composite keys of Decision section 3 support it. That is organisation, and it must never be read as security isolation between those companies.
5. **`ops.events.seq` is internal only.** It is one identity across all tenants, so its gaps reveal the global event count, other tenants' activity and their relative volume. Before Phase 1D creates any tenant-facing event consumer, polling API, cursor, Agent Runtime reader or event subscription, a tenant-scoped or opaque cursor mechanism must be designed. No tenant may be able to infer from sequence gaps:
   - the global event count;
   - another tenant's activity;
   - another tenant's relative event volume.

   `seq` is never exposed to a tenant, directly or as a cursor.
6. **Event payloads follow data minimisation.** Events are not a second CRM or clinical datastore.
   - **Prefer:** identifiers, the event type, structural metadata and references.
   - **Do not copy:** message bodies, notes, emails, clinical information or sensitive CRM records.

   The only exception is a future event that explicitly requires such content, and only once its retention and security policy has been defined.
7. **Database owner privileges stay outside the tenant isolation boundary.** The database owner (`postgres`) and `service_role` must never become an ordinary Company OS agent or worker identity.

**Reconciliation notes (not owner decisions).**
- Decision section 7's Phase 1C rule, no task title or description in a trigger-derived payload, is narrower than owner decision 6: lifecycle payloads also carry organisational labels (`slug`, `name`, an agent's `role`), and `ops.record_event` accepts any object. Owner decision 6 therefore has to be enforced by whatever wrapper first exposes `record_event`, and by every new event type.
- Under owner decision 7, ordinary execution runs as `ops_worker` under a live lease ([ADR 0012](0012-worker-tenant-context.md)). A future runtime caller reaches the domain only through the wrapper contract of Decision section 4, which takes its tenant from a lease or a membership, never from an argument.

**What this changes in Phase 1C: no schema and no code.**
- The seed models one business in one tenant.
- No application role (`anon`, `authenticated`, `service_role`, `ops_worker`) can read `ops.events`. The owner can; hosting-level read roles hold SELECT and read its rows only if they also carry `BYPASSRLS`, which the repository has not measured. No code path reads it, and the MCP function's `postgres` pool has not been tested against `ops` (ADR 0002, 2026-09-13 addendum §6). *(Later 2026-09-13: the MCP function is removed; ADR 0011 addendum.)*
- Trigger-derived payloads carry ids, statuses, organisational labels and structural task fields, never task titles, descriptions, notes, messages or CRM content. No application role can call `ops.record_event`: EXECUTE is revoked from PUBLIC and granted to no role, so only its owner and superusers can.
- The worker already refuses to boot as `postgres`, `service_role`, a superuser or a `BYPASSRLS` role (ADR 0012, Phase 1B addendum).

---

## Owner clarification 2026-09-13 — global monotonic identifiers

**GLOBAL MONOTONIC IDENTIFIERS ARE INTERNAL ONLY.** Owner decision 5 above named `ops.events.seq`. On 2026-09-13 the owner extended the same protection to `ops.job_events.id` and to any future global monotonic sequence.

- They may remain internal database identifiers.
- They must not become tenant-facing cursors, pagination offsets or tokens, event positions, counters or observable activity indicators, where that would let a tenant infer another tenant's activity or the global volume.
- Before any tenant-facing event or job-event reader exists, Phase 1D or a later dedicated phase must define a tenant-scoped cursor, or an opaque cursor or token.
- `ops.job_events` keeps its bigint primary key. The decision does not require changing a key unless a real need is proven.

Its executable form is SI-26: the static migration guard and the migration and database assertions keep every application role away from these tables, so no tenant-facing reader can be granted without changing a guard.
