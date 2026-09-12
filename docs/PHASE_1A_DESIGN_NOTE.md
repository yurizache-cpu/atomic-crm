# Phase 1A — design note: two revisions to ADR 0012, with the evidence

**Date:** 2026-09-12 · Written *before* implementation, per the Phase 1A brief's instruction to document any discrepancy with the ADR rather than implement over it.

[ADR 0012](adr/0012-worker-tenant-context.md) proposes a scoped non-superuser role plus a transaction-local `app.tenant_id` GUC. Phase 0.5 proved that *mechanism* in isolation (`supabase/tests/worker_tenant_context.sql`). Building the real substrate surfaced two things the ADR does not address. Both were measured, not reasoned about.

## Probe results

Run against the local Supabase Postgres 15.8 inside a rolled-back transaction:

| # | Question | Result |
| --- | --- | --- |
| P1 | Does a `SECURITY DEFINER` function owned by `postgres` bypass `FORCE ROW LEVEL SECURITY`? | **Yes** — 3 of 3 rows with no tenant context. `postgres` is `rolsuper=false` but `rolbypassrls=true`. |
| P2 | Does a non-`BYPASSRLS` worker with no context read zero rows directly? | **Yes** — 0 rows. Fail-closed holds. |
| P3 | Does `set_config(…, is_local := true)` **inside** a `SECURITY DEFINER` function propagate to the **caller's** transaction? | **Yes** — the value is visible outside the function and the caller's subsequent reads are scoped by it. |
| P4 | Does a policy calling a definer function that reads the *same* RLS-protected table recurse? | **No** — 1 row, no error. The definer's bypass cuts the loop. |
| P5 | Can the worker set the tenant GUC itself? | **Yes** — it set tenant B and read tenant B's row. |
| P6 | Role attributes | `postgres`: super=f, **bypassrls=t**. Worker role: super=f, bypassrls=f. |

## Discrepancy 1 — leasing cannot happen under a tenant-scoped policy

ADR 0012 item 3 says the worker "leases a job (`FOR UPDATE SKIP LOCKED`) and reads `tenant_id` off the leased row inside the same transaction."

That is circular. To lease, the worker must read `ops.jobs`; at that moment there is no tenant context; a tenant-scoped policy therefore shows it **zero rows** and it can never lease anything. Fail-closed correctly makes the ADR's own flow impossible.

**Resolution.** Leasing goes through a `SECURITY DEFINER` function, `ops.lease_job()`, owned by `postgres`. P1 shows it can see every tenant's queue; P3 shows it can install the resulting tenant context into the caller's transaction before returning. The worker therefore never runs an unscoped query — it calls one narrow function that returns exactly one job and leaves the transaction already scoped.

This *strengthens* the ADR's intent rather than weakening it: the trusted persistence layer the brief describes is now a function with a fixed signature, not a query the worker composes.

## Discrepancy 2 — a bare `app.tenant_id` GUC is forgeable by the worker

P5 is the important one. `set_config` is executable by PUBLIC, so **a worker holding the `ops_worker` credential can name any tenant it likes** and RLS will scope it to that tenant. Under ADR 0012 as written, "which tenant am I" is an assertion by the worker, not a fact the database checks.

**Resolution.** `ops.current_tenant_id()` does not read a tenant GUC. It resolves the tenant from a **live lease**:

```
app.worker_id + app.job_id  ->  ops.jobs row that is
                                  leased, unexpired, and owned by that worker
                              ->  that row's tenant_id
```

Forging `app.job_id` to another tenant's job yields NULL unless that job is *also* currently leased by the same `app.worker_id`. The consequence that matters: a worker can only ever act as a tenant **for which it holds live, server-recorded work**. It cannot invent a tenant, and it cannot act on a tenant that has no job in flight. Every tenant-scoped statement is attributable to one job row.

### What this does and does not defend against — stated plainly

GUCs are readable and writable by any role, so no GUC-transport design can be unforgeable against a *fully malicious worker process*. Against one, the real bound is `ops_worker`'s grants: no `BYPASSRLS`, no `public.*`, no arbitrary SQL, no DDL.

What the lease-bound design does defend against is the threat that actually matters here, and that a bare GUC does not:

- a worker **bug** that forgets to set context (fails closed — zero rows),
- a worker that takes the tenant from the **job payload** rather than the job row,
- and, once Phase 1B adds them, **LLM output or external input** reaching the tenant decision.

The payload is the untrusted surface in this system. Binding tenancy to the lease means the payload can never influence it.

## Consequences for the ADR

ADR 0012's items 1, 2, 5 and 6 stand as written. Item 3's *mechanism* changes (a definer lease function installs the context, rather than the worker reading the row and setting it) and item 4's helper resolves from the lease rather than from `app.tenant_id`. ADR 0012 is updated at the end of Phase 1A with the implementation evidence; it stays **Proposed** until the tests in `supabase/tests/ops_execution_core.sql` pass and are mutation-verified.
