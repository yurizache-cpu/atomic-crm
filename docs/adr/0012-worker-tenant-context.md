# ADR 0012 — Worker tenant context: scoped role + transaction-local GUC

**Status:** **Accepted** (owner decision, Phase 1B brief §0 — accepted WITH the Phase 1A addendum, not as originally written) · **Date:** 2026-09-11 (implemented 2026-09-12, accepted 2026-09-12)
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
- **Test obligation, and it is the acceptance criterion for ADR 0002:** two tenants' rows in one `ops` table; assert tenant A's context sees only A's rows; assert an **unset** GUC sees zero rows (not all rows); assert a job that sets tenant A cannot update a row of tenant B; assert the value does not survive into the next transaction on the same pooled connection. ~~These require a live database and are therefore Docker-blocked today.~~ **Partly discharged 2026-09-11 — see the addendum below.**
- Pooling is safe only because the GUC is transaction-local. Any future code path that sets it outside a transaction reintroduces cross-tenant leakage, so that shape should be blocked in review.
- This ADR specifies a mechanism; it builds nothing. `ops` does not exist yet, and Phase 0.5 does not create it.

---

## Addendum 2026-09-11 — What is now proven, and why the status is still Proposed (Phase 0.5C)

Phase 0.5C's instruction was that this ADR must not be accepted until executable tests prove its properties. That created a deadlock: the acceptance criterion above is written against `ops.*`, and `ops` does not exist because Phase 0.5 must not build the engine. Left alone, the ADR would stay unfalsifiable indefinitely.

`supabase/tests/worker_tenant_context.sql` (run by `npm run test:db`) breaks the deadlock by testing the **mechanism** rather than the engine. It builds a throwaway schema, role, table and policies with exactly the shape this ADR specifies, asserts against them, and rolls everything back — it creates no `ops` schema, no engine table and no persistent role, and it asserts that afterwards.

### Proven

| Property | ADR item | Result |
| --- | --- | --- |
| Worker role is not superuser and has no `BYPASSRLS`/`CREATEROLE`/`CREATEDB` | 1 | pass |
| Explicit tenant context scopes reads to that tenant | 2, 4 | pass |
| **Absent** context yields **zero** rows, not all rows | 5 | pass |
| A malformed tenant id does not degrade to "see everything" | 5 | pass |
| Unqualified `UPDATE`/`DELETE`/`INSERT` cannot cross the tenant boundary | 5 | pass |
| `force row level security` binds the role that **owns** the table | 5 | pass |
| Transaction-local context does not survive a **committed** transaction on a reused connection | 2 | pass |

Each was mutation-tested — the assertion was shown to fail when the property is deliberately broken (unset GUC made to match all rows, `force` removed, `BYPASSRLS` granted, `with check` unscoped, `set_config` made connection-level). Two of those mutations initially went undetected and the suite was corrected; without mutation testing it would have shipped green and blind. Specifically, checking GUC leakage after a **rollback** proves nothing, because a plain `SET` is rolled back too — only the committed case discriminates.

### Not proven — and this is why the status does not change

1. **Tenant id derived from the leased job row** (item 3). This is the property that makes the context server-side rather than caller-supplied, and it is the heart of the design. It cannot be tested until a job table and a leasing path exist.
2. **No production path sets the GUC outside a transaction.** A convention today, not an enforced constraint.
3. **Engine components do not use `service_role`.** Not merely unproven — currently **false**. The edge functions run as `service_role`, which carries `BYPASSRLS`; `rls_tenant_isolation.sql` section 6 and `worker_tenant_context.sql` block F assert that bypass explicitly so that a green RLS suite can never be mistaken for worker isolation.
4. **`postgres` itself carries `BYPASSRLS`** on Supabase (measured: `rolsuper=false`, `rolbypassrls=true`). Anything connecting as `postgres` — including every migration — is outside RLS. The `ops_worker` role must never be `postgres`.

**Conclusion: Proposed.** The mechanism is no longer a hypothesis; the integration is entirely unbuilt. Accepting it requires items 1–3 above, which is Phase 1 work.

---

## Addendum 2026-09-12 — implemented, with two revisions the evidence forced (Phase 1A)

The substrate exists: `supabase/migrations/20260912120000_ops_execution_core.sql`. Building it surfaced two things this ADR got wrong. Both were measured first — the probe results are in [PHASE_1A_DESIGN_NOTE.md](../PHASE_1A_DESIGN_NOTE.md).

### Revision 1 — item 3's flow is circular

Item 3 says the worker "leases a job (`FOR UPDATE SKIP LOCKED`) and reads `tenant_id` off the leased row inside the same transaction." To lease, it must read `ops.jobs`; at that moment there is no tenant context, so a tenant-scoped policy shows it **zero rows**. Fail-closed makes this ADR's own flow impossible.

**Implemented instead:** `ops.lease_job()`, `SECURITY DEFINER`, owned by `postgres`. Probe P1 confirmed such a function sees every tenant's queue even under `FORCE ROW LEVEL SECURITY` (`postgres` is `rolsuper=false` but `rolbypassrls=true`); probe P3 confirmed `set_config(…, is_local := true)` inside it **propagates to the caller's transaction**. The worker therefore never composes an unscoped query — it calls one function that returns exactly one job and leaves the transaction already scoped.

### Revision 2 — item 4's helper trusted the caller

Item 4 proposed `ops.current_tenant_id()` returning `current_setting('app.tenant_id')`. Probe P5: **the worker set that GUC to another tenant and read that tenant's row.** `set_config` is executable by PUBLIC, so under this ADR as written, "which tenant am I" was an assertion by the worker rather than a fact the database checks.

**Implemented instead:** the helper resolves the tenant from a **live lease** — `app.worker_id` + `app.job_id` must name an `ops.jobs` row that is `leased`, unexpired, and owned by that worker. A worker can only act as a tenant for which it holds server-recorded work in flight.

Items 1, 2, 5 and 6 stand as written.

### Evidence

`supabase/tests/ops_execution_core.sql` and `supabase/tests/jobLeasingConcurrency.mjs`, run by `npm run test:db`. Concurrency needs real simultaneous connections, so it is a Node suite — one psql connection cannot race itself.

| Property | Result |
| --- | --- |
| Worker is not superuser, no `BYPASSRLS`/`CREATEROLE`/`CREATEDB`/`LOGIN` | pass |
| Tenant A sees only A; **and symmetrically** B sees only B | pass |
| Worker holds **no write verb** in `ops` — 5 attempts, all refused at the privilege layer | pass |
| Missing context → zero rows (jobs, events, tenants) | pass |
| Malformed `app.job_id` → raises; unknown job id → no tenant | pass |
| Forging a **queued** job of another tenant → no tenant | pass |
| Forging a job **leased by another worker** → no tenant | pass |
| Forging an **expired** lease → no tenant | pass |
| Settling a job the worker does not hold → refused | pass |
| Context does not survive a **COMMIT** on a reused connection, nor a ROLLBACK | pass |
| 12 concurrent workers, 6 jobs → 6 distinct leases, no double-lease, no contention | pass |
| A row held by another transaction is **skipped**, not waited on | pass |
| Expired lease recovered **through `ops.lease_job` itself**; a live lease is not stolen; a job past `max_attempts` is retired | pass |
| `service_role` has `BYPASSRLS` **and** no table privilege in `ops` | characterised |

**Mutation-verified, 10/10.** Two were NOT caught until the tests were corrected: removing `SKIP LOCKED` (workers serialise rather than double-lease, so the end state looks identical — it took holding a row and racing it with a statement timeout to see the difference), and removing the reap call from `lease_job` (the suite was testing `reap_expired_leases()` directly, while `lease_job` is the only recovery path this phase has).

### Trade-offs and limitations, stated

- **GUC transport is forgeable by a malicious worker *process*.** Any role can write any GUC, so no design of this shape is unforgeable against one. The bound there is `ops_worker`'s grants: no `BYPASSRLS`, nothing in `public`, no arbitrary SQL, no DDL. What the lease binding defends against is a worker **bug** that forgets the context, a worker that takes the tenant from the **payload**, and — from Phase 1B — LLM output reaching the tenant decision. The payload is the untrusted surface, and tenancy is now unreachable from it.
- **`FORCE ROW LEVEL SECURITY` does not constrain `postgres`**, which carries `BYPASSRLS`. It is set because ownership changes quietly, not because it binds the admin identity.
- **`ops_worker` is `NOLOGIN`.** No credential exists in a migration, because that would be a secret in git. Production creates a login role as a deployment step and grants it `ops_worker`; the worker does `set local role ops_worker` per transaction — the same shape PostgREST uses to reach `authenticated`.
- **Enqueueing is not the worker's capability** in this phase. `ops.enqueue_job` is granted to `service_role` only; a worker that could create work for an arbitrary tenant would undo the lease binding.
- **Edge functions still run as `service_role`.** Unchanged, and still an ACCEPTED RISK (SI-06). Phase 1A moved the *worker* off it, not the CRM.

### Recommendation

**Accepted 2026-09-12 by the owner**, explicitly *with* this addendum and explicitly *not* reverting to the original pure-GUC design. The accepted properties are: the ordinary worker identity is not `service_role`; `ops_worker` has no `BYPASSRLS`; tenant identity derives from a trusted live lease; the job payload cannot choose tenancy; a free-form worker-controlled tenant GUC is not trusted; transaction-local context disappears when the transaction ends; a missing, invalid, expired or mismatched lease fails closed; cross-tenant access stays denied; worker privileges stay least-privilege. Items 2 (superseded by revision 1) and 4 (superseded by revision 2) of the original Decision are **not** part of what was accepted.

---

## Addendum 2026-09-12 — one correction the production runtime forced (Phase 1B)

Accepting this ADR did not end the measuring. Building the real worker exposed a defect in how Phase 1A *applied* it — not in the mechanism, in the transaction boundary around it.

### The defect

Phase 1A ran lease + execute + settle in **one** transaction. That is atomic, and it was wrong for a production runtime. Verified directly: leasing inside a transaction and rolling it back leaves the job `status = queued, attempts = 0`. So a worker that dies mid-job leaves **no trace at all**, and two things follow:

1. **A job that reliably crashes the worker is a poison pill.** `attempts` never rises, `max_attempts` never retires it, and it is re-leased forever.
2. **"Died before leasing" and "died just after leasing" are indistinguishable**, so lease expiry — the mechanism this ADR relies on for recovery — has nothing to recover.

### The correction

Phase 1B commits the lease in its own transaction and executes in a second. The tenant must survive that boundary **without** travelling through application memory, or item 3's guarantee dies with it. `ops.resume_lease(worker_id, job_id)` is how: it re-reads the trusted row under exactly the checks `ops.current_tenant_id()` applies — leased, unexpired, owned by that worker — and re-installs the transaction-local context. A worker naming a job it does not hold gets no context and therefore sees nothing.

The handler's writes and the job's **settlement** still share one transaction, so "did the work but did not record it" remains impossible. A *failure* is recorded in a third transaction, because the second has to roll back to discard partial work and a rolled-back transaction cannot also record why.

This strengthens item 3 rather than weakening it: the job row used for execution is now read **inside** the execution transaction, under the lease check, instead of being carried across a boundary by the worker.

### Also proven in Phase 1B

| Property | Result |
| --- | --- |
| Transaction-local context does not leak across a **pooled `pg` connection** — same `pg_backend_pid()`, no context, zero rows | pass |
| The worker process refuses to boot as `postgres` / `service_role` / superuser / `BYPASSRLS` | pass |
| The login role is `NOINHERIT`, so `set local role ops_worker` is load-bearing (without it: `permission denied for schema ops`) | pass |
| A worker holding a live lease still cannot read or write **any** `public` table directly | pass |
| A committed lease survives a killed process and is recovered by a reaper tick alone | pass |
| A repeatedly-crashing job reaches `failed` at `max_attempts` instead of looping | pass |
