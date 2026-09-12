# PHASE 1B FINAL SIGNOFF
## Production worker runtime, recovery, and the first deterministic handler

**Date:** 2026-09-12 · **Branch:** `feature/clinical-phase-1` · **Commits:** `37f9a528` (build), `7989d6a0` (driver-backed run + fixes), `54116f54` (CI fix)
**CI:** [run 34704880023](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34704880023) on `54116f54` (the last code commit) and [run 34705326375](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34705326375) on `f34262a3` — both green on everything Phase 1B touches.

---

## 1. Runtime architecture

```
  ops.enqueue_job  (service_role: an edge function, an operator, a scheduler)
          |
          v
  ops.jobs ─────────────────────────────────────────── the source of truth
          |
          |  TX1   set local role ops_worker
          |        ops.lease_job(worker_id, seconds)  ->  COMMIT
          v
  ┌──────────────────────────────────────────────────────────────┐
  │ worker process                       engine/worker/main.ts   │
  │   boot   assertWorkerIdentity()  <- refuses postgres/service │
  │   loop   reaper tick | heartbeat | runOneJob | backoff       │
  │   stop   SIGINT/SIGTERM -> stop leasing, finish what is live │
  └──────────────────────────────────────────────────────────────┘
          |
          |  TX2   ops.resume_lease -> tenant context (re-read, not carried)
          |        registry[kind]   -> handler or REFUSE
          |        handler(job, capabilities)   <- no client, no SQL
          |        ops.complete_job(id, detail) -> COMMIT
          v
     TX3 (failure only)  classify -> ops.settle_job_failure
     TX2 rolled back, so partial work is gone; the reason is not.
```

**Three transactions, and each boundary is load-bearing.** This is the most important change from Phase 1A, and it came from a measurement rather than a preference.

Phase 1A ran lease + execute + settle in **one** transaction. Verified directly: leasing inside a transaction and rolling it back leaves `status = queued, attempts = 0`. A worker that dies mid-job therefore leaves **no trace at all**, and two things follow:

1. **A job that reliably crashes the worker is a poison pill.** `attempts` never rises, `max_attempts` never retires it, and it is re-leased forever.
2. **"Died before leasing" and "died just after leasing" are indistinguishable**, so lease expiry — the mechanism §8 and §9 rest on — has nothing to recover.

Committing the lease first fixes both. The tenant then has to survive that boundary without travelling in application memory, or the payload-cannot-choose-tenancy property dies with it: `ops.resume_lease(worker_id, job_id)` re-reads the trusted row under exactly the checks `ops.current_tenant_id()` applies and re-installs the transaction-local context. This *strengthens* ADR 0012 item 3 — the job row used for execution is now read **inside** the execution transaction, under the lease check.

**Deliberately absent:** no broker, no scheduler service, no leader election, no Redis, Kafka, Temporal or Kubernetes. `FOR UPDATE SKIP LOCKED` is the entire concurrency mechanism. Still a modular monolith.

## 2. Real worker identity

`ops_worker` is `NOLOGIN` and holds no credential — a password in a migration is a secret in git. A deployment runs one extra step, `scripts/provision-worker-role.mjs`, creating:

> `ops_worker_login` — LOGIN, **NOINHERIT**, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, member of `ops_worker`, holding **nothing** directly.

**NOINHERIT is the part that matters.** With INHERIT the login role would carry `ops_worker`'s privileges implicitly and `set local role ops_worker` would be decorative — removing it would change nothing and nobody would notice.

Measured through the real `pg` pool (`pooling.dbtest.ts`), not asserted:

| Check | Result |
| --- | --- |
| `current_user` | `ops_worker_login` |
| `rolsuper` / `rolbypassrls` | `false` / `false` |
| member of `ops_worker` | `true` |
| any `ops` access **without** `set local role` | `ERROR: permission denied for schema ops` |
| `public.inbound_emails` / `public.contacts`, select **and** delete, while holding a live lease | `42501` |

**The process refuses to boot** on `postgres`, `service_role`, `supabase_admin`, any superuser, anything with `BYPASSRLS`, or anything that cannot assume `ops_worker`. A boot gate rather than a lint, because the failure is otherwise **invisible**: a worker connected as `postgres` runs every job correctly and leaks every tenant.

**Two Supabase constraints, measured:**

- `create role … login` works as the project's `postgres` role (`rolcreaterole = true`). No dashboard step.
- `alter role … nosuperuser | nobypassrls` **fails** — *"Only roles with the SUPERUSER attribute may alter roles with the SUPERUSER attribute"* — and Supabase's `postgres` is `rolsuper = false`. The script sets only what it may set and its verification block **refuses** a pre-existing role carrying either attribute rather than silently trying to strip it.
- The password never touches `argv` (visible to `ps`); it is interpolated into SQL delivered on stdin. psql variables would not have worked anyway — `:'var'` is not substituted inside a dollar-quoted block.

## 3. Pooling / tenant-isolation proof — **RUN, GREEN**

`engine/worker/pooling.dbtest.ts`, through the real `pg` Pool at `max: 1`.

`pg_backend_pid()` is asserted **identical** across transactions, so the test cannot pass by accidentally getting a fresh connection. On that same backend, after a completed job for tenant A, a transaction with no lease sees:

| | |
| --- | --- |
| `app.job_id` / `app.worker_id` | both empty |
| `ops.current_tenant_id()` | NULL |
| `count(*) from ops.jobs` | **0** |
| `count(*) from ops.tenants` | **0** |

Then a job for tenant B is executed on that same connection and is scoped to B. A leased transaction with both tenants queued sees **exactly one** tenant's rows, and it is the leased one.

**The adapter deliberately does not `RESET ALL` between checkouts.** A reset would make this suite pass without the transaction-local guarantee holding at all. Mutation S5 proves the suite is sensitive to it: switching `set_config(…, true)` to session scope in `ops.resume_lease` is caught by this file.

**Transactions use an explicitly checked-out client.** `withTransaction` calls `pool.connect()`, runs `begin` / work / `commit` on that one client, and releases it in `finally` (destroying it if even the rollback failed). `pool.query()` is not reachable for tenant-scoped work — the adapter exposes no way to express it.

## 4. Handler registry

`engine/worker/handlerRegistry.ts` + `registry.ts`. One file whose entire content is the list, so adding a handler is a visible code change rather than a config value or a database row.

It is a **`Map`**, not an object literal. On a plain object, `handlers["constructor"]` and `handlers["toString"]` resolve to *functions*, so a job of kind `toString` would "find a handler" and the runtime would call it with a job and a capability bag. A Map has no prototype chain to walk, so fail-closed is the default. Proven both ways: unit test, and a live job of kind `toString` recorded as a permanent failure.

No dynamic import, no lookup by a payload-supplied function name, no `eval`.

## 5. First handler — and why it is not the ingestion replay

`postmark.ledger_retention` (`engine/handlers/postmarkLedgerRetention.ts`).

The brief named Postmark **replay/recovery** as preferred and asked me to verify it was the safest available use case. It is not, and the reason is structural.

Replaying an **ingestion** means creating contacts, companies, notes and storage objects across `public.*`. That code is Deno (`supabase/functions/postmark/addNoteToContact.ts`) and runs as `service_role`. Moving it into the worker would require either handing the worker a `service_role` client or granting `ops_worker` broad write privileges on `public.*` — the two things §8 and §28 forbid. A third option, re-POSTing stored payloads at the webhook, would hand the worker the Postmark auth secret and the ability to inject arbitrary inbound email into the CRM: a privilege *increase* over what the job needs.

The **retention** half of the same ledger is one narrow capability, and it is not a demo. `20260912090000_inbound_email_ledger.sql` writes the policy down and then says it is *"documented and manual"* because *"Phase 0.5 has no scheduler … building a worker is explicitly out of scope"*. The obligation predates this phase; only the mechanism was missing. It is also the sharpest obligation this project has: inbound email bodies are, under the LGPD, other people's personal data held by a psychology clinic.

**Measured behaviour.** With five ledger rows seeded — two resolved and old, two unresolved and old, one recent — the handler reports `purged=2 retention_days=90 limit=5000` and leaves exactly `dbtest-new-ingested`, `dbtest-old-pending`, `dbtest-old-transient`. Unresolved rows are the reason the ledger exists; age must not reach them.

**The capability, and the shape every later one must copy.** The handler receives a frozen object holding exactly what its registry entry declared — never a database client, never SQL. `ops.purge_inbound_email_ledger` is `SECURITY DEFINER` and:

- takes **no tenant argument**; it resolves the tenant from the live lease;
- raises `42501` with *"no live lease, so no tenant"* when there is none;
- raises `42501` unless that tenant carries `owns_local_crm`;
- **floors** the retention window at 30 days in the database;
- deletes only `ingested` / `failed_permanent` rows.

**One piece of domain modelling was unavoidable.** `public.*` carries no tenant column and never will (ADR 0002), while `ops` is multi-tenant. Any capability reaching from one into the other must know *which* tenant owns this deployment's CRM, or it is unscoped. `ops.tenants.owns_local_crm` is that bridge: one boolean, at most one tenant (partial unique index), consulted only by capability functions. It is the first thread of a tenant↔CRM model, and Phase 1C should decide deliberately whether it stays this shape.

## 6. Retry model

Bounded, and computed where the worker cannot reach it.

| | |
| --- | --- |
| Counter | `ops.jobs.attempts`, incremented **at lease time** so a crash still counts |
| Ceiling | `ops.jobs.max_attempts` (default 5) |
| Backoff | `ops.retry_delay(attempts)` — 5s, 10s, 20s, 40s … **capped at one hour** |
| Where | In the DATABASE. `attempts` is not writable by the worker, so a buggy or hostile worker cannot arrange a hot retry loop or a zero delay. |
| Terminal | `status = 'failed'`, `completed_at` set, `last_error` and `last_error_class` retained |

Measured: three consecutive transient failures produced strictly increasing `available_at` deltas, each ≤ 3600s. A job with `max_attempts = 2` reached `failed` on the second attempt with its error and class intact, and its event trail read exactly `enqueued → leased → retry → leased → failed`.

## 7. Failure model

`engine/worker/failures.ts`. Deterministic — error type first, then SQLSTATE. No model is involved.

| Class | Meaning | Behaviour |
| --- | --- | --- |
| `transient` | infrastructure that may work later (`08006`, `40P01`, `57014`, `ECONNREFUSED` …) | bounded retry |
| `permanent` | invalid input, unrunnable job (`22P02`, `23514`, `42P01` …) | **terminal immediately**, even with attempts remaining |
| `security` | trust-boundary refusal (`42501`, `28000`) | **terminal immediately**. A security refusal that retries is an attack on a schedule. |
| `unknown` | anything unrecognised | bounded retry, **recorded as unanalysed** |

**The default is `unknown`, never `transient`.** Both retry; only one says "nobody has looked at this". Filing an unanalysed failure as understood infrastructure noise is how a real defect hides in a dashboard.

Measured: a payload with `retention_days: -1` reached `failed` on attempt 1 of 5, class `permanent`. Terminal jobs are never deleted — job id, tenant, kind, attempts, class, last error, timestamps and worker identity all remain, with the ordered trail in `ops.job_events`.

## 8. Lease recovery

**Chosen: a reaper tick on the worker's own clock** (default 30s), independent of whether anything is queued. Phase 1A recovered expired leases only inside `ops.lease_job`, making recovery a side effect of new work arriving.

**pg_cron was evaluated, not hand-waved.** It is in `shared_preload_libraries` on this image; I installed it, scheduled a job, confirmed it registered, then removed it. Rejected because it adds an **extension** to a baseline whose entire posture is that an extension is a capability decision, and what it buys over the tick is recovery *while the whole fleet is down* — a state in which nothing needs recovering, because nothing is executing either.

`pg_net` was **not** reintroduced. Nothing here makes an HTTP call.

**Residual gap, stated plainly:** a worker that is alive but wedged does not reap, and with a single worker nothing else will. The heartbeat (`ops.worker_instances`) makes that visible rather than silent. If the fleet is ever one process and that gap matters, pg_cron is the answer and the measurement says it works.

## 9. Shutdown and crash behaviour

**Shutdown.** `SIGINT`/`SIGTERM` abort an `AbortSignal`; the loop stops leasing and the job in flight is awaited to completion, then `ops.worker_stopped` is recorded. A second signal exits immediately.

Measured with a real process: SIGTERM sent 900ms into a 1200ms handler → the job still completed, `stats.succeeded = 1`, the job row `succeeded`, and `stopped_at` set. Mutation M10 (fire-and-forget instead of awaiting) is caught.

> **Platform note.** On win32, `child.kill("SIGTERM")` is `TerminateProcess` — measured: the handler never runs and the child exits with code `null`. The test worker therefore has an equivalent stdin stop channel reaching the same `AbortSignal`, used on Windows; POSIX uses the real signal. The *behaviour* is proven on both; the *signal wiring* is proven on Linux, i.e. in CI.

**Crash**, measured with a real `SIGKILL`ed process:

| Scenario | Observed |
| --- | --- |
| dies before leasing | nothing happened |
| dies immediately after leasing | committed lease, `attempts = 1`, `lease_owner` set |
| that lease expires | a fresh worker recovers and runs it on its **reaper tick alone**, no new work enqueued; final `attempts = 2` — the crashed attempt was counted, not forgiven |
| dies during the handler | TX2 rolls back; the ledger delete was undone and the job returned to `queued` with class `transient` |
| repeatedly crashes | reaches `failed` at `max_attempts = 3` instead of looping |
| database connection drops | `worker.poll_failed`, exponential backoff (1s→30s), process stays up |
| settlement itself fails | not escalated: the lease expires and the reaper settles the job |
| unknown kind / malformed payload | `permanent`, recorded, never executed |

One case deserves naming: **if `ops.complete_job` returns false — the lease expired while the handler ran — the runtime throws, rolling the handler's work back.** Committing would double-apply work another worker may already be redoing.

## 10. Concurrency results — **RUN, GREEN**

`engine/worker/concurrency.dbtest.ts` spawns actual `node` processes running the actual loop. It asserts on what each process reports it **executed**, not on the end state of the table — which cannot tell a job that ran once from a job that ran twice and was settled once.

| Case | Result |
| --- | --- |
| 8 jobs, 2 real processes | 8 executions, **all distinct**, set equal to the enqueued ids; both processes did work; all 8 `succeeded` |
| 4 + 4 jobs across two tenants, 2 processes | 8 distinct executions, and **every** execution ran under its own job's tenant |
| 1 slow job + 5 quick, 2 processes with a 2.5s handler | no duplicate execution; all 5 quick jobs completed — a slow job does not block unrelated work |

## 11. Idempotency results — **RUN, GREEN**

| Shape | Result |
| --- | --- |
| the same job twice | second run reports `purged=0`; ledger unchanged |
| the same external identity twice | `ops.enqueue_job` with the same `idempotency_key` returns the **same job id**; one row in `ops.jobs` |
| crash after the side effect, before completion | the delete and the settlement share TX2, so the rollback discarded both; ledger count unchanged, job back to `queued` |

## 12. Adversarial tests — **RUN, GREEN**

All twelve fail closed.

| Attack | Result |
| --- | --- |
| payload carries another tenant's id | ignored; tenant stays the lease's; `security`; nothing deleted |
| payload tries to shorten the retention window to 1 day | database floors it at 30; only the 45-day row was purged, the 5-day row survived |
| unknown job type | `permanent`, nothing executed |
| job kind `toString` (prototype member) | no handler found |
| malformed payload | `permanent`, terminal on the first attempt |
| forged job id in `resume_lease` | no row, no context |
| another worker's lease | no row, no context |
| expired lease + capability call | `42501`, nothing deleted |
| no lease at all + capability call | `42501`, **and the reason** — *"no live lease, so no tenant"* |
| settling a job not held | `false` / `refused`; job untouched |
| worker queries `public.*` directly while holding a live lease | `42501` on select **and** delete |
| connection reused after tenant A | zero rows, no context (§3) |

## 13. Mutation-testing results — **25 / 25 caught**

Two harnesses. Both verify a green baseline first and restore every file — and, for the SQL harness, the live database — on every exit path.

**Runtime, 16/16** (`engine/`, plus the static migration guard): unknown-kind default-allow · tenant from payload · lease-resume check removed · `set local role` removed · capability bag unfrozen and granted whole · registry as a plain object · security classified transient · unknown defaulting to transient · failed settlement ignored · shutdown abandoning work · reaper tick removed · boot gate accepting BYPASSRLS · boot gate accepting postgres · `ops_worker` granted a write verb · ops view losing `security_invoker` · a log line carrying the payload.

**Database, 9/9** (`SECURITY DEFINER` bodies, unreachable before `pg` existed): retention floor removed · `owns_local_crm` check removed · no-lease guard removed · `resume_lease` ownership check removed · session-scope instead of transaction-scope `set_config` · every class retried · `max_attempts` ignored · `current_tenant_id` unbinding the lease from the worker · the reaper forgiving the attempt.

**Four were not caught on the first run, and they are not all the same kind of finding.** Reporting "25/25" without this would be misleading:

1. **M3 — a real coverage gap.** Nothing exercised TX2's lease-resume refusal; with the guard removed the failure surfaced as an unrelated `TypeError` classified `unknown` rather than a `security` refusal. Test added.
2. **S3 — a real gap, masked by defence in depth.** Deleting the no-lease guard *still* produced `42501`, because the `owns_local_crm` check rejects a NULL tenant too. The layering worked; the test could not tell the two guards apart. It now asserts the reason, not just the SQLSTATE.
3. **M10 — a bad mutation of mine.** It added `if (signal?.aborted) break;` before the call, which changes nothing: the loop condition already says that and the in-flight job is still awaited. Redesigned as genuine fire-and-forget, it is caught.
4. **S8 / S9 — a harness scoping error of mine.** S8 was reported NOT CAUGHT because the harness ran only the driver-backed project; the lease-forgery cases live in `supabase/tests/ops_execution_core.sql`. S9's anchor had the wrong indentation. The harness now runs the **whole** guard set.

## 14. Test counts

| Suite | Result |
| --- | --- |
| `app` (browser, Chromium) | **219 passed**, 1 skipped, 27 files |
| `functions` + `claude` | **699 passed**, 1 skipped, 54 files |
| **unit total** | **918 passed, 2 skipped, 81 files** |
| of which new in Phase 1B | **92** across 8 files |
| SQL database suites (`npm run test:db`) | **4 passed** |
| driver-backed suites (`npm run test:db:engine`) | **32 passed, 3 files** |
| Mutation | **25 / 25** |

> **Correction to the pre-run report.** It said the driver-backed layer was "4 files, ~45 cases". There are **3** files and **32** cases. The count was written before the suites had ever executed and was wrong.

**Order-independence was verified explicitly.** The SQL suites were run *after* the driver-backed suites with no reset in between, and passed — after the cleanup defect in §18(3) was fixed.

## 15. CI status

`.github/workflows/check.yml`'s `database` job gained one step between the RLS suites and the clean-reconstruction reset:

```yaml
- name: ⚙️ Worker runtime, pooling and concurrency
  run: npm run test:db:engine
```

It is in the `database` job rather than `test-app` because it needs a live Postgres and spawns real processes; the unit jobs must never depend on Docker.

Results in §21.

The two pre-existing red checks (legacy `e2e-test`, and Prettier's ~419 files) are untouched. **No new formatting debt:** every file this phase added or changed passes `prettier --check`.

## 16. `db reset` status

**Clean.** `npx supabase db reset --workdir .supabase-e2e --local` applied all 31 migrations including `20260912160000_ops_worker_runtime.sql`; all four SQL suites and all 32 driver-backed cases passed afterwards. The new migration's nine end-state assertions fire on every reset, and it re-applies idempotently (verified — the SQL mutation harness re-applies it eighteen times).

## 17. Security-baseline status

Nothing regressed, and one guard was **strengthened**.

| Baseline item | Status |
| --- | --- |
| `pg_net` absence | ✅ not reintroduced — the reaper runs on the worker's clock, not on a database HTTP call |
| `security_invoker` requirement | ✅ **widened**: the static guard now enforces it in `ops` as well as `public` |
| Migration replay guard | ✅ green, 93 tests |
| RLS tests | ✅ green |
| Attachment privacy | untouched |
| Postmark fail-closed behaviour | untouched — the handler reads the ledger's retention policy, not its ingestion path |
| Unknown-permission default-deny | ✅ extended to job kinds and capability names |
| SQL capability restrictions | ✅ the worker still cannot run arbitrary SQL; handlers cannot run SQL at all |
| `ops_worker` least privilege | ✅ six new function grants, **zero** new write verbs — re-asserted by the migration on every apply |
| Tenant-from-live-lease | ✅ strengthened — the trusted row is re-read *inside* the execution transaction |

**The strengthening.** The guard previously checked `security_invoker` only in `public` and refused to silently ignore a view elsewhere. Adding `ops` to `views.ignoredSchemas` would have been the easy fix and **fail-open** for every future `ops` view. Instead `views.enforcedSchemas = ["public", "ops"]` holds `ops` to the same rule — verified by mutation (M15), and pinned as a literal in `migrationInvariants.test.ts` so removing a schema is a diff in a test file.

Three new invariants: **SI-16** (the worker process refuses to boot on an over-privileged identity), **SI-17** (unknown job kinds fail closed; no dispatch on a payload-supplied name), **SI-18** (a capability reaching into `public` takes its tenant from the live lease, refuses any tenant without `owns_local_crm`, and clamps its parameters).

## 18. What running the suites found

Five defects surfaced the moment `pg` existed. **All five were in the harness, none in the runtime** — which is itself worth stating, because it is the difference between "the tests pass" and "the tests were ever executed".

1. **A deadlock of my own making.** One test expired a lease from the admin connection while the leasing transaction was still open. `ops.lease_job` leaves an uncommitted UPDATE on that row, so the admin UPDATE blocked on the row lock while the leasing transaction waited on the admin query — and **Postgres never reports it**, because one side waits on the application rather than on a lock. It hung a ten-minute run. The test now models the real flow (lease → COMMIT → expire → resume), and the fixture pool carries a `statement_timeout` so that shape fails loudly instead of hanging.
2. **A brittle assumption, not a product bug.** A pooling test asserted tenant A and got B: `lease_job` orders by `created_at` and B's job was enqueued first. The property held — the transaction saw exactly **one** tenant. It now reads the leased tenant back instead of guessing.
3. **The suites left rows in `ops.jobs`**, which broke `npm run test:db` afterwards (*"12 workers leased 11 jobs from a queue of 6"*). CI resets the database between the two and **would have hidden it**. They clean up now, and the SQL suites were re-run after them to prove order-independence.
4. **SIGTERM is not deliverable on win32** — see §9.
5. **`poolOptions` was removed in Vitest 4**, so `singleFork` was silently inert.

A sixth change is preventive rather than corrective: the fixture now **refuses to run against the wrong database**. The default port is 54322, which on this machine is the *other* working copy's `atomic-crm-demo` stack, so a forgotten `SUPABASE_DB_PORT` now fails with a legible error instead of a cascade of *"relation ops.jobs does not exist"*.

## 19. Dependency review

`npm install` added **15 packages, purely additive** — the lockfile diff has 7 hunks and **zero** removed lines; no existing package version changed.

| | |
| --- | --- |
| Direct | `pg@8.23.0`, `@types/pg@8.23.1` (dev) |
| Transitive | `pg-pool`, `pg-protocol`, `pg-types`, `pg-connection-string`, `pg-int8`, `pgpass`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, `split2`, `xtend`, `pg-cloudflare` (optional) |

**On the 41 advisories: none of them involve the pg family.** All 41 pre-existed and sit in the frontend/test toolchain — `@vitest/browser`, `vitest`, `vite`, `postcss`, `nanoid`, `react-router`, `browserslist`, `js-yaml`, `brace-expansion`, `fast-uri`, `ip-address`. Nothing in the worker's runtime path, and nothing new. `npm audit fix` was **not** run, as instructed; the pre-existing advisories are a separate decision, and several of them are in `vitest`/`vite` where a fix is a major-version bump.

## 20. Remaining risks

1. **A single wedged worker does not reap** (§8). Visible via the heartbeat, not automatically repaired.
2. **`ops.tenants.owns_local_crm` is a bridge, and bridges become load-bearing.** Phase 1C should decide deliberately whether it stays a boolean.
3. **Nothing schedules the retention job.** `ops.enqueue_job` is correctly still closed to the worker (§14 of the brief), so a recurring run needs an external trigger. A real gap for the obligation the handler discharges.
4. **Edge functions still run as `service_role`** (SI-06), and `net.http_get` is still reachable by `authenticated` (ADR 0011). Unchanged by this phase.
5. **A malicious worker *process* is still bounded by `ops_worker`'s grants, not by one tenant.** Unchanged from Phase 1A and stated in ADR 0012.
6. **The graceful-shutdown signal wiring is proven on Linux only** (§9). The behaviour is proven on both platforms.
7. **41 pre-existing advisories** in the frontend/test toolchain (§19), untouched and undecided.

## 21. CI result

[Run 34704880023](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34704880023) on `54116f54`:

| Job | |
| --- | --- |
| 🗄️ Database security & reproducibility | **PASS** |
| 🔎 Test (app + functions + claude) | **PASS** |
| 🏷️ Typecheck | **PASS** |
| 🔬 ESLint · ESLint | **PASS** |
| 🔨 Build | **PASS** |
| e2e-test | FAIL — pre-existing |
| Prettier | FAIL — pre-existing |

The database job's steps, in order, all green: `🐘 Start Supabase` → `🔒 RLS, tenant isolation and grant surface` → **`⚙️ Worker runtime, pooling and concurrency`** → `♻️ Clean reconstruction from scratch` → `🔒 Same guarantees after the reset`.

So the pooling proof, the real multi-process concurrency, the crash/recovery cases and the idempotency cases all executed **on a fresh Linux runner**, against a database built from the repository alone — including the graceful-shutdown case driven by a **real SIGTERM**, which win32 cannot deliver (§9).

**Re-run on the final commit.** [Run 34705326375](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34705326375) on `f34262a3` returned the same verdict — database, test, typecheck, ESLint and build all green, `e2e-test` and `Prettier` red. That commit and this sentence are documentation only, so the chain stops here rather than regressing: the last commit to change any code or configuration is `54116f54`, and both runs agree about it.

**The two failures are pre-existing and unchanged.** Verified by comparison: run 34692769127 on the Phase 1A commit `e546e7a5`, before any Phase 1B work, failed exactly `e2e-test` and `Prettier` and nothing else.

### One new defect CI found, and it was mine

The first Phase 1B run (34704536139) failed `🔎 Unit Tests on App`. Diagnosis: `test:unit:app` is a bare `vitest --config vitest.config.ts` with **no `--project` filter**, so adding the `engine-db` project to that file silently dragged the driver-backed suites into a job with no database.

Fixed structurally rather than by narrowing the script. This repository's rule is that a unit run never needs Docker, so the suites that cannot run without it now live in `vitest.db.config.ts`. Keeping them in the default config made the mistake *possible*; moving them makes it *unrepresentable*. Reproduced and verified locally by running the exact CI command: 81 files, 918 tests, no `dbtest` file collected.

Worth noting what this says about the evidence: the database job passed on that same run. The runtime was never wrong — the failure was in how the suites were wired into the build, which is precisely the class of defect that only a clean remote environment finds.

## 22. ADR changes

- **[ADR 0012](adr/0012-worker-tenant-context.md) → `Accepted`**, with the Phase 1A addendum and explicitly **not** the original pure-GUC design. Items 2 and 4 of the original Decision are superseded. `DECISIONS.md` agrees, enforced by the ADR-index drift guard.
- **A Phase 1B addendum was added to ADR 0012**, recording the single-transaction defect and the `ops.resume_lease` correction. Accepting an ADR did not end the measuring, and the record should show that.
- **ADR 0002's blocker is lifted** — it could not be accepted until 0012 was. It is still `Proposed`; accepting it is the owner's call.
- No new ADR. Nothing in Phase 1B is a structural decision the existing ones do not already cover.

## 23. Recommended Phase 1C scope

Exactly one slice, and it is not agents:

1. **Schedule the retention job.** The handler discharges an LGPD obligation that nothing currently triggers. Decide where recurrence lives: an external scheduler, or a narrow `ops` function that enqueues *one* allow-listed kind for the `owns_local_crm` tenant. If the latter, it is the §14 continuation mechanism and deserves the same care as the capability.
2. **A second deterministic handler**, to prove the registry and capability model generalise before anything non-deterministic touches them. Stale-`pending` ledger triage is the natural candidate — same table, same capability shape, real value.
3. **The kill switch and cost ledger** (ADR 0010). The roadmap's sequencing rule is unchanged and binding: **no agent before these exist.**

Do **not** start LLM integration, the Tool Gateway proper, or the domain model until (3) is done.

---

## Classification

# READY FOR PHASE 1C

Against the four conditions set for this signoff:

| Condition | |
| --- | --- |
| The real suites with `pg` passed | ✅ 32 cases, 3 files, green locally and in CI |
| Real pooling was proven | ✅ same `pg_backend_pid()` across transactions, zero rows and no context on the reused connection, and mutation S5 proves the suite is sensitive to the guarantee |
| CI validated the new path | ✅ run 34704880023 — the `⚙️ Worker runtime, pooling and concurrency` step green on a fresh Linux runner |
| No tenant/security guarantee weakened | ✅ nothing regressed, and the `security_invoker` guard was **widened** to `ops`; 25/25 mutations caught |

**Phase 1B engineering baseline is signed off.**

Two honest qualifications, neither of which blocks the classification:

1. **`e2e-test` and `Prettier` are still red**, exactly as they were on the Phase 1A commit. No new formatting debt was added; every file this phase touched passes `prettier --check`.
2. **The graceful-shutdown signal wiring is proven on Linux only.** On win32 `SIGTERM` is `TerminateProcess` and no handler can run — a property of the platform, not of the worker. The behaviour itself is proven on both.

Phase 1C is **not** started. See §23 for the recommended scope; the sequencing rule stands — no agent before the kill switch and cost ledger exist.
