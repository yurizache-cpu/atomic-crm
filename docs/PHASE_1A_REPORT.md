# Phase 1A — tenant-safe execution core

**Date:** 2026-09-12 · **Branch:** `feature/clinical-phase-1` · **Status: READY FOR PHASE 1B**

One question had to be answered before any autonomous work exists:

> Can a background worker lease and execute a job for exactly one tenant, without being able to read or mutate another tenant's data, and without relying on `service_role` / `BYPASSRLS`?

**Yes, demonstrably** — and the demonstration is `npm run test:db`, not this document.

No agents, no LLM, no departments, no UI. The substrate they will depend on, and nothing else.

---

## 1. Architecture implemented

```
ops.tenants ── ops.jobs ── ops.job_events
                   │
     ops.lease_job(worker, seconds)        SECURITY DEFINER, owned by postgres
       1. clear any context this transaction carried
       2. reap expired leases
       3. UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)
       4. install app.worker_id + app.job_id, transaction-local
       5. write the 'leased' audit row
                   │
     ops.current_tenant_id()               resolves the tenant FROM THE LEASE
                   │
     every ops policy reads that one helper
                   │
     ops.complete_job / ops.fail_job       verify the lease, then settle
```

`engine/worker/runOneJob.ts` is the application-side counterpart: lease → verify → execute → settle, with the database client injected so the project commits to no driver while [ADR 0001](adr/0001-runtime-execution-substrate.md) is still Proposed. There is no daemon, no scheduler and no handler.

**Three tables, and each earns its place.** `tenants` makes `tenant_id` mean something (FK, not a loose uuid); `jobs` is the queue; `job_events` is the audit trail §14 of the brief asks for. Nothing else was added.

## 2. Worker role and privileges

| | `ops_worker` |
| --- | --- |
| superuser / `BYPASSRLS` / `CREATEROLE` / `CREATEDB` | **no** — asserted by the migration *and* by the test suite |
| `LOGIN` | **no.** A password in a migration is a secret in git. Production creates a login role at deploy time and grants it `ops_worker`; the worker does `set local role ops_worker` per transaction — the same shape PostgREST uses to reach `authenticated`, and the shape the tests exercise. |
| `public` schema | nothing |
| `ops` | `SELECT` on the three tables, all RLS-filtered to the leased tenant |
| writes | **none, anywhere** |
| enqueue | **no** — `ops.enqueue_job` is `service_role` only |

The worker holding no write verb is not tidiness. Every transition goes through a function that checks the lease first, so the worker cannot extend its own lease, reassign a job, or settle another tenant's work — and the attempts to do so fail at the **privilege layer**, which is a stronger guarantee than "the policy matched no rows".

## 3. Tenant-context mechanism — and why it is not what ADR 0012 proposed

Two probes changed the design. Both were measured before any code was written ([PHASE_1A_DESIGN_NOTE.md](PHASE_1A_DESIGN_NOTE.md)).

**P5 — a bare `app.tenant_id` GUC is forgeable by the worker.** `set_config` is executable by PUBLIC; the probe set the GUC to another tenant and read that tenant's row. Under ADR 0012 as written, *which tenant am I* was an assertion by the worker rather than a fact the database checks.

**P3 — `set_config(…, is_local := true)` inside a `SECURITY DEFINER` function propagates to the caller's transaction.** That is what makes the fix possible.

So `ops.current_tenant_id()` reads no tenant GUC. It resolves:

```
app.worker_id + app.job_id  →  an ops.jobs row that is leased, unexpired,
                               and owned by that worker  →  its tenant_id
```

A worker can only act as a tenant **for which it holds live, server-recorded work**. It cannot invent a tenant, cannot act on a tenant with nothing in flight, and every tenant-scoped statement is attributable to one job row.

Missing context returns NULL (every policy matches nothing). A malformed `app.job_id` **raises**. The asymmetry is deliberate: "no context" is a normal state for any connection, while a non-uuid in that GUC is never normal and should be loud. Both yield zero unauthorised access.

**The bound, stated rather than implied.** GUCs are readable and writable by any role, so no design of this shape is unforgeable against a fully malicious worker *process*; against one the limit is `ops_worker`'s grants. What the lease binding defends against is the threat that actually matters: a worker **bug** that forgets the context, a worker that takes the tenant from the **payload**, and — from Phase 1B — LLM output or external input reaching the tenant decision. The payload is the untrusted surface, and tenancy is now unreachable from it.

### The circularity ADR 0012 did not see

ADR 0012 item 3 has the worker read `tenant_id` off the leased row itself. To lease, it must read `ops.jobs`; at that moment there is no context, so a tenant-scoped policy shows it **zero rows**. Fail-closed made the ADR's own flow impossible. Leasing therefore goes through a definer function that returns exactly one job and leaves the transaction already scoped — the worker never composes an unscoped query.

## 4. Job and leasing model

`ops.jobs` carries tenant ownership, a four-state machine (`queued`/`leased`/`succeeded`/`failed`), `priority`, `attempts`/`max_attempts`, `available_at` for backoff, the lease triple (`lease_owner`, `leased_at`, `lease_expires_at`), `idempotency_key`, `last_error` and timestamps. A CHECK refuses a `leased` row with an incomplete lease. `kind` is free text — it is tenant/product vocabulary, and enumerating it in DDL is the mistake [ADR 0013](adr/0013-pipeline-stages-are-configuration.md) exists to prevent; `status` is engine state and is constrained.

Deduplication is `unique (tenant_id, kind, idempotency_key) where idempotency_key is not null` — per tenant, because two tenants may legitimately use the same key. The pattern is established, not exercised: nothing external is called yet.

Leasing is `UPDATE … WHERE id = (SELECT … ORDER BY priority, available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1)`.

## 5. RLS isolation results

All against a live Postgres, via `npm run test:db`.

| | |
| --- | --- |
| Tenant A sees only A — base tables *and* audit rows | pass |
| **Symmetrically**, tenant B sees only B | pass |
| Cross-tenant write: 5 attempts (update / delete / insert jobs / insert events / update tenants) | all 5 refused at the privilege layer |
| Settling a job the worker does not hold | refused |
| Missing context → zero rows in jobs, events and tenants | pass |
| Malformed `app.job_id` → raises | pass |
| Unknown job id → no tenant | pass |
| Forging a **queued** job of another tenant | no tenant |
| Forging a job **leased by another worker** | no tenant |
| Forging an **expired** lease | no tenant |
| A valid live lease still resolves (so the three above are not passing because the helper is simply broken) | pass |
| `ENABLE` + `FORCE` row level security on every `ops` table | asserted |
| `anon` / `authenticated` can reach nothing in `ops` | asserted |

**`service_role`, characterised not relied on:** it carries `BYPASSRLS` (so RLS would not stop it) *and* holds no table privilege in `ops` (so the grant layer does). Both are asserted, because the first is the reason the second matters.

## 6. Connection-leakage results

This is the case that forced `ops_execution_core.sql` to **commit**, unlike the other suites. A rollback reverts a plain `SET` as well as a `SET LOCAL`, so a rolled-back test passes either way — Phase 0.5 hit exactly that and had to be corrected.

On one psql connection: lease as tenant A and **COMMIT** → a new transaction carries no `app.job_id`, no `app.worker_id`, `current_tenant_id()` is NULL and zero rows are visible → lease again and the context is the *new* lease's, not a merge → after a ROLLBACK, no context survives either.

## 7. Concurrency results

Real simultaneous connections, because one psql connection cannot race itself (`supabase/tests/jobLeasingConcurrency.mjs`).

- **12 workers, 6 jobs → 6 leases, 6 distinct ids, 6 distinct owners, every job at `attempts = 1`.** No double-lease and no contention; the six losers returned empty rather than blocking.
- **Drained queue → 4 late workers leased nothing** and stole no live lease.
- **A row held by another transaction is skipped, not waited on.** One connection holds the head of the queue; a second worker with a 2s `statement_timeout` takes the *next* job. Without `SKIP LOCKED` it blocks and times out.

That third case exists because the first two do **not** distinguish `SKIP LOCKED` from a plain `FOR UPDATE`: without it workers serialise rather than double-lease, so the end state is identical. Removing `SKIP LOCKED` left the suite green until this case was written.

## 8. Lease recovery

- A **live** lease is not stolen — reaping leaves it alone.
- An **expired** lease returns the job to `queued`, clears the lease triple, and writes a `reaped` audit row.
- A job past `max_attempts` is **retired to `failed`** rather than requeued forever. `attempts` is incremented at lease time, so a crash that kills the worker still counts — otherwise a job that crashes workers retries without bound.
- Recovery happens **on the normal path**: `ops.lease_job` reaps before it selects. There is no scheduler in this phase, so that is the only recovery route, and the test leases through the ordinary entry point to prove it.

## 9. Mutation testing

The substrate, 10 mutations applied to the live database:

| # | Mutation | Caught |
| --- | --- | --- |
| M1 | `FORCE` RLS removed from `ops.jobs` | ✅ |
| M2 | `ops_worker` granted `BYPASSRLS` | ✅ |
| M3 | `SET LOCAL` replaced with a persistent `SET` | ✅ |
| M4 | jobs policy unscoped to `using (true)` | ✅ |
| M5 | missing context returns an arbitrary tenant | ✅ |
| M6 | `lease_owner` ignored — any job id resolves | ✅ |
| M7 | lease expiry ignored | ✅ |
| M8 | **`SKIP LOCKED` removed** | ❌ → test corrected → ✅ |
| M9 | worker granted write verbs on `ops.jobs` | ✅ |
| M10 | **expired-lease reaping removed from `lease_job`** | ❌ → test corrected → ✅ |

Plus 4 on the invariant baseline (worker allow-list removed, `ops` added to the PostgREST allowlist, the lease-forgery assertion gutted, the document softened) — all caught. **14 of 14 after correction; 2 of them shipped green until the tests were fixed**, which is the whole reason for running them.

## 10. Test counts

| | |
| --- | --- |
| `app` | 219 passed, 1 skipped |
| `functions` | 330 passed |
| `claude` | 285 passed, 1 skipped |
| **all unit projects** | **834 passed, 2 skipped, 0 failed** (74 files) |
| database suites | 4 passed (3 SQL + 1 concurrency) |
| typecheck | PASS — and it now covers `engine/`, which nothing typechecked before |
| lint | PASS |

## 11. `db reset`

Clean reconstruction from the repository alone: **33s, exit 0**, followed by a green `npm run test:db`. The `ops` migration's own assertions run on every apply.

## 12. Security baseline regression status

**No Phase 0.5 guarantee was weakened.** All 15 invariants green; SI-13/14/15 were added for this phase. The static migration guard was **strengthened**, not relaxed: `ops_worker` is a *scrutinised* role, deliberately not in `BYPASS_ROLES`, so a migration granting it a write verb is rejected before it applies (7 attack cases rejected, `SELECT`/`EXECUTE` accepted).

Two guard defects were fixed, both found by using it:

1. **The seal was not portable — this one blocked CI entirely.** It had been computed on Windows, where git checks out CRLF; on the Linux runner the same committed bytes hash differently and every sealed file reported `seal:edited`. Confirmed exactly: the sealed value was the CRLF hash and CI reported the LF hash. Hashing and parsing now normalise line endings, the seal was regenerated (23 of 29 hashes changed; git confirms no migration content was touched), and three tests pin the portability.
2. **`EXECUTE` inside a string literal was read as dynamic SQL**, so `has_function_privilege(…, 'EXECUTE')` blocked a correct migration. A false positive is a defect, not caution.

## 13. ADR 0012

**Recommended for acceptance**, with the two revisions in its addendum — not as originally written. Items 1, 2, 5 and 6 stand; item 3's flow was circular and item 4's helper trusted the caller. The status stays `Proposed` in the file because this repository marks an ADR `Accepted` only on an owner decision, never on architectural merit alone.

[ADR 0002](adr/0002-tenancy-model.md) and [ADR 0001](adr/0001-runtime-execution-substrate.md) are reconciled: `ops` exists with `tenant_id`, RLS and `FORCE` on every table, and the substrate's database half is built while the always-on process deliberately is not.

## 14. Remaining risks

- **Edge functions still run as `service_role`** (SI-06, ACCEPTED RISK). Phase 1A moved the *worker* off it, not the CRM.
- **`postgres` carries `BYPASSRLS`**, so every migration runs outside RLS and `FORCE` does not bind it. The worker must never be `postgres`.
- **A malicious worker process can forge the GUCs.** Bounded by `ops_worker`'s grants; see §3. The realistic threat — payload-driven tenancy — is closed.
- **No scheduler.** Recovery happens only when someone calls `ops.lease_job`. An idle queue with a stranded job stays stranded until a worker next asks for work. Acceptable now; Phase 1B needs a heartbeat or a cron.
- **`supabase db diff` remains unsafe to apply unreviewed** — unchanged, and now also true of anything it would emit for `ops`.
- **No load or volume evidence.** Leasing was tested for correctness under 12 concurrent workers, not for throughput.

## 15. Operational blockers

**None.** The branch is pushed, CI has executed, and the two red items are pre-existing and out of scope:

- `e2e-test` — red before Phase 0.5 for unrelated reasons.
- The **Prettier check run** — 419 pre-existing files fail it. A correction to [PHASE_0_5_REPORT §17.2](PHASE_0_5_REPORT.md): `continue_on_error: true` keeps the *job* green, but the *check run* is still marked failure, so the overall run shows red. Formatting the repository remains an open, owner-owned decision.

Everything Phase 1A touches is green in CI, including the database job on a fresh Linux runner: [run 3](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34692769127) on `e546e7a5` -- Build, ESLint, Typecheck, all three unit projects, and the database job all pass. That job applies the `ops` migration, runs the three SQL suites **and** the concurrency suite against real simultaneous connections, so leasing, tenant isolation and context non-persistence are proven off this machine.

## 16. Recommended scope for Phase 1B

**One slice: make the substrate observable and survivable, still with no agents.**

1. **A worker process.** `engine/worker/runOneJob.ts` has no runner. Phase 1B should add the smallest real loop — connect, poll, back off when idle, shut down cleanly — plus the login-role deployment step that grants `ops_worker`. That closes ADR 0001's remaining half.
2. **Recovery without a worker.** Today reaping only happens when someone leases. A heartbeat (`pg_cron`, or the worker's own idle tick) should reap independently, so a stranded job does not wait on traffic.
3. **One real handler, chosen for being boring.** Something deterministic and already owned by this repository — the Postmark ledger's replay path is the natural candidate: it has durable state, idempotency and a failure mode that is already tested.

**Not in Phase 1B:** LLM calls, agents, a tool gateway, WhatsApp, UI. The kill switch ([ADR 0010](adr/0010-cost-control-and-kill-switch.md)) and the cost ledger must exist before anything can spend money or act autonomously — that sequencing rule has not changed.

---

## Definition of done

| | |
| --- | --- |
| worker does not use `service_role` as ordinary identity | ✅ |
| worker role has no `BYPASSRLS` | ✅ asserted twice |
| tenant comes from trusted persisted job identity | ✅ and bound to a *live lease* |
| tenant context is transaction-local | ✅ proven across COMMIT and ROLLBACK |
| missing context fails closed | ✅ |
| malformed context fails closed | ✅ (raises) |
| Tenant A cannot access Tenant B | ✅ |
| Tenant B cannot access Tenant A | ✅ symmetric case |
| pooled/reused connection does not leak context | ✅ |
| leasing prevents duplicate ownership | ✅ 12 workers, real concurrency |
| expired leases have defined recovery | ✅ including on the normal path |
| `FORCE` RLS applied where required | ✅ |
| DB tests prove isolation | ✅ |
| mutation tests attack the properties | ✅ 14/14 after correcting 2 |
| clean `db reset` succeeds | ✅ 33s |
| Phase 0.5 guards remain green | ✅ and two were strengthened |
| typecheck / lint / full suite | ✅ 834 passed |
| ADR 0012 updated on evidence | ✅ |
| no unrelated features introduced | ✅ |

# READY FOR PHASE 1B
