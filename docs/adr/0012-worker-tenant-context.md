# ADR 0012 — Worker tenant context: scoped role + transaction-local GUC

**Status:** Proposed · **Date:** 2026-09-11
**Decided by:** owner, Phase 0.5 brief (Q11) — design only; no engine code is built in Phase 0.5.

## Context

[ADR 0002](0002-tenancy-model.md) puts every engine table in an `ops` schema with a `tenant_id` column and RLS. It originally said each policy should route through a helper "following `02_functions.sql:462-511`".

Reading those helpers: `current_sales_id()` is `select s.id from public.sales s where s.user_id = auth.uid()`, and `is_active_sales_user()`, `can_manage_sales_id()`, `can_access_contact()` and `can_access_deal()` all derive from it. **Every one resolves through `auth.uid()`**, which reads a claim from a Supabase end-user JWT.

But [ADR 0001](0001-runtime-execution-substrate.md) makes an always-on worker the only process that touches `ops.*`, and that worker holds **no end-user JWT**. It wakes on an event or a schedule, not on an HTTP request from a signed-in person. So the cited pattern cannot supply tenant context to the only caller that needs it, and no alternative was specified anywhere.

The owner's requirements are explicit: every tenant-scoped job carries a tenant identifier; worker access is scoped to it; no superuser; avoid `BYPASSRLS`; tenant context validated server-side, never taken from LLM output or client input; auditable; cross-tenant access fails closed; automated isolation tests.

## Decision

**A dedicated non-superuser database role plus a transaction-scoped tenant GUC, with the tenant id derived from the job row rather than accepted as an argument.**

1. **Role.** The worker connects as a purpose-made role (`ops_worker`) that is **not** superuser and does **not** carry `BYPASSRLS`. It is granted only what the engine needs on `ops.*`, and nothing on `public.*` beyond what the CRM adapter legitimately requires.

2. **Tenant context is set per transaction, never per connection.** Each unit of work runs inside one transaction that begins with `set_config('app.tenant_id', <id>, true)` — `is_local = true`, so the value dies with the transaction and cannot leak into the next job on a pooled connection. Connection-level `SET` is rejected for exactly that reason.

3. **The id comes from the claimed job row, not from the caller.** The worker leases a job (`FOR UPDATE SKIP LOCKED`) and reads `tenant_id` off the leased row inside the same transaction. It is never passed in by an agent, an LLM output, a webhook payload, or a tool argument. This is what makes the context server-side by construction: the only way to influence it is to already have written a row that RLS let you write.

4. **Policies read the GUC through one SECURITY DEFINER helper**, e.g. `ops.current_tenant_id()` returning `nullif(current_setting('app.tenant_id', true), '')::uuid`. Every `ops` policy is written against that helper, so there is one place to audit.

5. **Fail closed, enforced in the database.** `current_setting(..., true)` returns NULL when unset, and every policy is written so that a NULL tenant matches **no rows** — not all rows. Combined with `force row level security` on every `ops` table (so even the table owner is subject to policy), a worker that forgets to set the GUC sees an empty database rather than everyone's data.

6. **Auditable.** The tenant id is on the job row, on every `ops.audit_log` entry written in that transaction, and in the worker's structured log line for the run.

## Alternatives

- **Keep `auth.uid()` and mint a service JWT per tenant.** Rejected: it invents a synthetic user per tenant, puts a forgeable-looking credential in the worker's hands, and conflates "which human" with "which tenant" — the exact conflation `sales_id` already causes in `public.*`.
- **Superuser or `BYPASSRLS` worker, tenant filtering in application code.** Rejected outright by the brief, and rightly: it makes every `WHERE tenant_id = …` a hand-written guard, so one missing clause is a cross-tenant leak with no backstop. RLS exists precisely so the database is the backstop.
- **One database role per tenant.** Genuinely stronger isolation, and kept on the table for a future high-assurance tenant. Rejected as the default: N roles × M grants of DDL per onboarding, connection pools fragment per tenant, and cross-tenant platform queries (cost aggregation, the executive briefing) become painful.
- **Schema per tenant.** Same trade-off as ADR 0002 already recorded; unchanged here.

## Consequences

- The worker needs a migration creating `ops_worker` and its grants; the connection string for that role becomes a deployment secret, and it must never be the one the MCP function uses.
- **Test obligation, and it is the acceptance criterion for ADR 0002:** two tenants' rows in one `ops` table; assert tenant A's context sees only A's rows; assert an **unset** GUC sees zero rows (not all rows); assert a job that sets tenant A cannot update a row of tenant B; assert the value does not survive into the next transaction on the same pooled connection. These require a live database and are therefore Docker-blocked today.
- Pooling is safe only because the GUC is transaction-local. Any future code path that sets it outside a transaction reintroduces cross-tenant leakage, so that shape should be blocked in review.
- This ADR specifies a mechanism; it builds nothing. `ops` does not exist yet, and Phase 0.5 does not create it.
