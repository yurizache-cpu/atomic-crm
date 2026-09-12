# Phase 1 handoff

**Date:** 2026-09-11 · **From:** Phase 0.5 (engineering baseline signed off) · **Branch:** `feature/clinical-phase-1`

Read [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md) before writing anything. This document is the short version of what you inherit and what you may not break.

---

## 1. What is now stable

The database is no longer a set of claims. It rebuilds from the repository alone (`supabase db reset`, verified twice consecutively), and the properties it enforces are proven by suites that fail closed:

| | |
| --- | --- |
| Tests | 707 unit (3 projects) + 2 live-database suites, typecheck and lint clean |
| Database | clean reconstruction ~35s; RLS, grant surface and egress asserted after every reset |
| Mutation-verified | 14 RLS mutations, 10 invariant-baseline mutations, 7 registry mutations, 2 Postmark guards — every deliberate break caught |
| CI | typecheck, lint, three unit projects, registry guard, and a `database` job that starts Supabase and runs the suites plus a clean reset |

`npm run test:db` **fails** when it cannot reach a database rather than skipping. Keep that property in anything you add: a security suite that did not run has verified nothing.

---

## 2. Constraints you inherit

These are not preferences. Each was paid for.

1. **Atomic CRM is a replaceable adapter.** No `ra-core` types, PostgREST filter syntax, view names, JSONB email shapes or bigint FKs into `public.*` from engine code. New engine code goes **outside** `src/components/` — everything under `src/components/atomic-crm/` is republished publicly.
2. **Nothing in the engine may be psychology-specific.** Tenant vocabulary is data, never DDL and never a prompt constant. Two CHECK constraints that violated this were removed before a migration froze them ([ADR 0013](adr/0013-pipeline-stages-are-configuration.md)).
3. **`public.companies` and `company_id` mean *CRM customer account*, not tenant.** Do not repurpose either. The engine's tenant discriminator needs a distinct name in a distinct schema.
4. **Generated migrations are not trusted output.** `supabase db diff` cannot emit view reloptions, `ALTER DEFAULT PRIVILEGES`, or DML — and all three gaps have already been live security holes here. Its current output still regresses two invariants. Read every statement; hand-write what the generator cannot express, with a `raise exception` block asserting its own end state.
5. **`activity_log` is not an audit log.** It is a `UNION ALL` view over `created_at` columns; a deleted row erases its own history. The engine needs a real append-only audit table.
6. **Do not extend `public.tasks`** for engine work, and do not adopt `CrmDataProvider` as the CRM port — write the port by hand.

---

## 3. Invariants Phase 1 must not violate

The full list with its guards is [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md). The four that will actually constrain your design:

- **SI-05 — missing context reads zero rows, never all rows.** Every new policy must make a NULL tenant match *nothing*. This is the difference between RLS and a `WHERE` clause you have to remember.
- **SI-06 — `service_role` is not a worker identity.** It carries `BYPASSRLS`, and so does `postgres`. A worker running as either makes the whole tenancy model decorative. This is the single biggest trap in Phase 1.
- **SI-03 — no agent gets arbitrary SQL.** Agents get typed, explicit tools. The long-term shape is a Tool Gateway; arbitrary SQL is not a stepping stone to it.
- **SI-02 — `pg_net` stays absent.** If the engine wants the database to call out, that reopens outbound HTTP for `anon` permanently and needs its own ADR, not an implementation detail.

Also inherited, and unresolved: **no code path can create the first owner** in the declarative model (`is_admin()` requires `role='owner'`; the signup trigger hardcodes `operator`; signup is off; `authenticated` has no INSERT on `sales`). Any multi-user Phase 1 feature hits this immediately.

---

## 4. ADRs

The index is [DECISIONS.md](DECISIONS.md); the status in each ADR file is authoritative. As of this handoff **only four are Accepted** — do not assume any other decision is settled:

**Accepted:** [0007](adr/0007-launcher-relationship.md) launcher relationship · [0011](adr/0011-mcp-trust-boundary.md) MCP trust boundary · [0013](adr/0013-pipeline-stages-are-configuration.md) pipeline stages are configuration · [0014](adr/0014-inbound-email-ledger-keys-on-recipient-email.md) inbound-email ledger key.

**Still Proposed and awaiting the owner:** 0001 runtime substrate, 0002 tenancy, [0003](adr/0003-identifier-strategy.md) identifiers, [0004](adr/0004-principal-model.md) principal model, [0005](adr/0005-ra-core-boundary.md) ra-core boundary, [0006](adr/0006-declarative-schema-workflow.md) declarative schema workflow, 0008 fork posture, [0009](adr/0009-governance-envelope.md) governance envelope, [0010](adr/0010-cost-control-and-kill-switch.md) cost control and kill switch, 0012 worker tenant context.

Of those, **three are one decision in three parts**, and Phase 1 is built directly on them:

| ADR | State | What blocks acceptance |
| --- | --- | --- |
| [0001](adr/0001-runtime-execution-substrate.md) runtime substrate | Proposed | Owner approval. Unaffected by the `pg_net` removal — the worker *pulls*. |
| [0002](adr/0002-tenancy-model.md) tenancy model | Proposed | `ops` does not exist; the two-channel isolation test is undischarged. |
| [0012](adr/0012-worker-tenant-context.md) worker tenant context | Proposed | **Mechanism verified, integration unbuilt.** See below. |

Also open and owner-owned: [ADR 0008](adr/0008-fork-posture.md) fork posture — the registry guard fails if its status changes, deliberately, so that decision cannot silently widen what gets published.

---

## 5. Recommended first slice

**Discharge ADR 0012's three remaining properties. Nothing else.**

`supabase/tests/worker_tenant_context.sql` already proves the *mechanism* against a throwaway schema: a non-superuser, non-`BYPASSRLS` role scoped by a transaction-local GUC, where absent context yields zero rows and `force row level security` binds even the owning role. Five mutations, all caught. What it cannot prove without real objects:

1. **Tenant id derived from the leased job row**, not passed in as an argument — the property that makes context server-side by construction.
2. **No path sets the GUC outside a transaction** — today a convention, not a constraint.
3. **Engine components do not run as `service_role`** — currently false for the edge functions.

So the slice is: the `ops` schema, the `ops_worker` role and its grants, one job table with `tenant_id` and `force row level security`, `ops.current_tenant_id()`, and job leasing with `FOR UPDATE SKIP LOCKED`. Then re-point `worker_tenant_context.sql` at the real objects and add the leased-row assertion.

**No agents, no LLM calls, no queue abstraction, no business logic in this slice.** It is deliberately boring and entirely testable.

Why this first: every engine table depends on the tenancy decision, ADR 0002 cannot be accepted until ADR 0012 is, and ADR 0012 cannot be accepted until these three properties are executable. Building anything else first means building it on a Proposed foundation and migrating it later.

**Do not start it until the branch is pushed and CI is green.** That is the one outstanding operational item, and it is the difference between "it passes here" and "it is reproducible".

---

## 6. Superseded 2026-09-12 — that slice was built

Section 5's slice is Phase 1A, and it is done: `ops` schema, `ops_worker`, the job table, `ops.current_tenant_id()`, leasing with `FOR UPDATE SKIP LOCKED`, and the leased-row assertion. Phase 1B then built the process that consumes it. [ADR 0012](adr/0012-worker-tenant-context.md) is **Accepted**, so [ADR 0002](adr/0002-tenancy-model.md)'s blocker is lifted.

Read [PHASE_1A_REPORT.md](PHASE_1A_REPORT.md) then [PHASE_1B_REPORT.md](PHASE_1B_REPORT.md). This document is kept as the dated record of what was handed over; do not plan from section 5.

