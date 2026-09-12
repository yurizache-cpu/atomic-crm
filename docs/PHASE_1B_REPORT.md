# PHASE 1B EXECUTIVE REPORT
## Production worker runtime, recovery, and the first deterministic handler

**Date:** 2026-09-12 · **Branch:** `feature/clinical-phase-1`

> **Read this first.** Every engineering deliverable is built, and 16 of 16 mutations against the runtime's trust boundaries are caught. But **four driver-backed test suites have been written and not executed**, because installing `pg` is blocked by this repository's own dependency policy and neither `npm install pg` nor a bare `npm install` is permitted to an agent here. Sections 3, 10, 11 and 12 therefore report *written, not run*. The classification in §20 follows from that and from nothing else.

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

**Three transactions, and each boundary is load-bearing.** This is the single most important change from Phase 1A, and it came from a measurement rather than a preference.

Phase 1A ran lease + execute + settle in **one** transaction. Verified directly: leasing inside a transaction and rolling it back leaves `status = queued, attempts = 0`. So a worker that dies mid-job leaves **no trace whatsoever**, and two things follow:

1. **A job that reliably crashes the worker is a poison pill.** `attempts` never rises, `max_attempts` never retires it, and it is re-leased forever.
2. **"Died before leasing" and "died just after leasing" are indistinguishable**, so lease expiry — the mechanism the brief's §12 and §13 rest on — has nothing to recover.

Committing the lease first fixes both. The tenant then has to survive that boundary without travelling in application memory, or the payload-cannot-choose-tenancy property dies with it: `ops.resume_lease(worker_id, job_id)` re-reads the trusted row under exactly the checks `ops.current_tenant_id()` applies and re-installs the transaction-local context. This *strengthens* ADR 0012 item 3 — the job row used for execution is now read inside the execution transaction, under the lease check.

**What is deliberately absent:** no broker, no scheduler service, no leader election, no Redis, Kafka, Temporal or Kubernetes. `FOR UPDATE SKIP LOCKED` is the entire concurrency mechanism. Still a modular monolith.

## 2. Real worker identity

`ops_worker` is `NOLOGIN` and holds no credential — a password in a migration is a secret in git. A deployment therefore runs one extra step, `scripts/provision-worker-role.mjs`, which creates:

> `ops_worker_login` — LOGIN, **NOINHERIT**, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, member of `ops_worker`, holding **nothing** directly.

**NOINHERIT is the part that matters.** With INHERIT the login role would carry `ops_worker`'s privileges implicitly and `set local role ops_worker` in the runtime would be decorative — removing it would change nothing and nobody would notice. Verified against the live database:

| Check | Result |
| --- | --- |
| `current_user` | `ops_worker_login` |
| `rolsuper` / `rolbypassrls` | `f` / `f` |
| `pg_has_role(current_user, 'ops_worker', 'member')` | `t` |
| `select count(*) from ops.jobs` **without** `set role` | `ERROR: permission denied for schema ops` |
| the same **with** `set role ops_worker` | `0` — fail-closed, no lease means no rows |

**The process refuses to boot** on `postgres`, `service_role`, `supabase_admin`, any superuser, anything with `BYPASSRLS`, or anything that cannot assume `ops_worker` (`engine/db/workerIdentity.ts`). This is a boot gate rather than a lint because the failure is otherwise **invisible**: a worker connected as `postgres` runs every job correctly and leaks every tenant.

**Two Supabase constraints, measured rather than assumed:**

- `create role … login` works as the project's `postgres` role (`rolcreaterole = true`). No dashboard step, no support ticket.
- `alter role … nosuperuser | nobypassrls` **fails**: *"Only roles with the SUPERUSER attribute may alter roles with the SUPERUSER attribute"*, and Supabase's `postgres` is `rolsuper = false`. The script therefore sets only what it may set on the rotation path and its verification block **refuses** a pre-existing role carrying either attribute rather than silently trying to strip it.
- The password never touches `argv` (where `ps` can read it); it is interpolated into SQL delivered on stdin. psql variables would not have worked anyway — `:'var'` is not substituted inside a dollar-quoted block.

## 3. Pooling / tenant-isolation proof — **written, NOT RUN**

`engine/worker/pooling.dbtest.ts`. The design is the part I can report with confidence; the execution is pending §20's blocker.

The suite runs the real `pg` Pool at `max: 1`, so connection reuse is **certain** rather than likely, and asserts `pg_backend_pid()` is identical across transactions so the test cannot pass by accidentally getting a fresh connection. It then runs a job for tenant A, and on that same backend opens a transaction with no lease and asserts: `app.job_id` empty, `app.worker_id` empty, `ops.current_tenant_id()` NULL, `count(*) from ops.jobs` = 0, `count(*) from ops.tenants` = 0. Then a job for tenant B, asserting it sees only B.

**The adapter deliberately does not `RESET ALL` between checkouts.** A reset would make this suite pass without the transaction-local guarantee holding at all. The guarantee is the architecture; the reset would be a blindfold.

## 4. Handler registry

`engine/worker/handlerRegistry.ts` + `engine/worker/registry.ts`. One file whose entire content is the list, so adding a handler is a visible code change rather than a config value or a database row.

It is a **`Map`**, not an object literal — deliberately. On a plain object, `handlers["constructor"]` and `handlers["toString"]` resolve to *functions*, so a job of kind `toString` would "find a handler" and the runtime would call it with a job and a capability bag. A Map has no prototype chain to walk, so fail-closed is the default rather than something a lookup guard has to remember to impose.

No dynamic import. No lookup by a payload-supplied function name. No `eval`. An unknown kind is a **permanent** failure with a recorded reason — never a retry, never a silent drop.

## 5. First handler — and why it is not the ingestion replay

`postmark.ledger_retention` (`engine/handlers/postmarkLedgerRetention.ts`).

The brief named Postmark ledger **replay/recovery** as the preferred candidate and asked me to verify it was actually the safest available use case. It is not, and the reason is structural rather than a matter of effort.

Replaying an **ingestion** means creating contacts, companies, notes and storage objects across `public.*`. That code is Deno (`supabase/functions/postmark/addNoteToContact.ts`) and runs as `service_role`. Moving it into the worker would require either handing the worker a `service_role` client or granting `ops_worker` broad write privileges on `public.*` — the two things the brief's §8 and §28 forbid. A third option, re-POSTing stored payloads at the webhook, would hand the worker the Postmark auth secret and the ability to inject arbitrary inbound email into the CRM: a privilege *increase* over what the job needs.

The **retention** half of the same ledger is expressible as one narrow capability, and it is not a demo. `20260912090000_inbound_email_ledger.sql` writes the policy down and then says it is *"documented and manual"* because *"Phase 0.5 has no scheduler … building a worker is explicitly out of scope"*. The obligation predates this phase; only the mechanism was missing. It is also the sharpest kind of obligation this project has: inbound email bodies are, under the LGPD, other people's personal data held by a psychology clinic.

**The capability, and the shape every later one must copy.** The handler receives a frozen object holding exactly what its registry entry declared — never a database client, never SQL. `ops.purge_inbound_email_ledger` is `SECURITY DEFINER` and:

- takes **no tenant argument**; it resolves the tenant from `ops.current_tenant_id()`, i.e. from the live lease;
- raises `42501` if there is no lease at all;
- raises `42501` unless that tenant carries `owns_local_crm`;
- **floors** the retention window at 30 days in the database, so a payload cannot talk it into deleting recent data;
- deletes only `ingested` / `failed_permanent` rows — `pending` and `failed_transient` are the reason the ledger exists.

**One small piece of domain modelling was unavoidable and is worth flagging.** `public.*` carries no tenant column and never will (ADR 0002), while `ops` is multi-tenant. Any capability reaching from one into the other must know *which* tenant owns this deployment's CRM, or it is unscoped. `ops.tenants.owns_local_crm` is that bridge: one boolean, at most one tenant (partial unique index), consulted only by capability functions. It is not a domain model, but it is the first thread of one, and Phase 1C should decide deliberately whether it stays this shape.

## 6. Retry model

Bounded, and computed where the worker cannot reach it.

| | |
| --- | --- |
| Counter | `ops.jobs.attempts`, incremented **at lease time** so a crash still counts |
| Ceiling | `ops.jobs.max_attempts` (default 5) |
| Backoff | `ops.retry_delay(attempts)` — 5s, 10s, 20s, 40s … **capped at one hour** |
| Where | In the DATABASE. `attempts` is not writable by the worker, so a buggy or hostile worker cannot arrange a hot retry loop or a zero delay. |
| Terminal | `status = 'failed'`, `completed_at` set, `last_error` and `last_error_class` retained |

The worker classifies; the database decides whether that classification earns a retry and when.

## 7. Failure model

`engine/worker/failures.ts`. Deterministic — error type first, then SQLSTATE. No model is involved in classification.

| Class | Meaning | Behaviour |
| --- | --- | --- |
| `transient` | infrastructure that may work later (`08006`, `40P01`, `57014`, `ECONNREFUSED` …) | bounded retry |
| `permanent` | invalid input, unrunnable job (`22P02`, `23514`, `42P01` …) | **terminal immediately**, even with attempts remaining |
| `security` | trust-boundary refusal (`42501`, `28000`) — a lease that is not ours, a capability refused | **terminal immediately**. A security refusal that retries is an attack on a schedule. |
| `unknown` | anything unrecognised | bounded retry, **recorded as unanalysed** |

**The default is `unknown`, never `transient`,** and that distinction is the whole point of having four classes. Both retry; only one says "nobody has looked at this". Filing an unanalysed failure as understood infrastructure noise is how a real defect hides in a dashboard.

Terminal jobs are never deleted. `job id, tenant, kind, attempts, class, last error, timestamps, worker identity` all remain on the row, and `ops.job_events` holds the ordered trail (`enqueued → leased → retry → leased → failed`).

## 8. Lease recovery

**Chosen: a reaper tick on the worker's own clock** (`reapIntervalMs`, default 30s), independent of whether anything is queued. Phase 1A recovered expired leases only inside `ops.lease_job`, making recovery a side effect of new work arriving.

**pg_cron was evaluated, not hand-waved.** It is present in `shared_preload_libraries` on this image; I installed it, scheduled a job, confirmed it registered, then removed it. It was rejected because:

- it adds an **extension** to a baseline whose entire posture is that an extension is a capability decision (`declaration.json#extensions`), and
- what it buys over the tick is recovery *while the whole fleet is down* — a state in which nothing needs recovering, because nothing is executing either. The first worker to start reaps on its first tick.

`pg_net` was **not** reintroduced. Nothing here makes an HTTP call.

**The residual gap, stated plainly:** a worker that is alive but wedged does not reap, and with a single worker nothing else will. The heartbeat (`ops.worker_instances`: `started_at`, `last_seen_at`, `stopped_at`) is what makes that visible rather than silent. If the fleet is ever one process and that gap matters, pg_cron is the answer and the measurement above says it will work.

## 9. Shutdown and crash behaviour

**Shutdown.** `SIGINT`/`SIGTERM` abort an `AbortSignal`; the loop stops leasing new work and the job in flight is awaited to completion, then `ops.worker_stopped` is recorded. A second signal exits immediately — leases expire and the reaper resolves whatever was in flight. Signal handling lives in `main.ts`, not in `runWorker`, so the loop stays a plain async function tests can drive.

**Crash.** Covered by design and by unit tests; the live-process cases are in the suites that have not run.

| Scenario | Defined outcome |
| --- | --- |
| dies before leasing | nothing happened |
| dies immediately after leasing | committed, stale lease; `attempts` already incremented; reaper requeues or retires |
| dies during the handler | TX2 rolls back — the handler's writes are gone, the lease remains and expires |
| database connection drops | `worker.poll_failed`, exponential backoff (1s→30s), the process stays up |
| settlement itself fails | not escalated: the lease expires and the reaper settles the job |
| handler throws transient / permanent | retry / terminal per §7 |
| malformed payload | `permanent`, terminal on the first attempt |
| unknown job kind | `permanent`, recorded, never executed |

One case deserves naming: **if `ops.complete_job` returns false — the lease expired while the handler ran — the runtime throws, rolling the handler's work back.** Committing would double-apply work another worker may already be redoing.

## 10. Concurrency results — **written, NOT RUN**

`engine/worker/concurrency.dbtest.ts` spawns actual `node` processes running the actual loop (`engine/worker/testSupport/concurrencyWorker.ts` builds the same adapter, asserts the same identity, runs the same `runWorker`). It asserts on what each process reports it **executed**, not on the end state of the table — which cannot tell a job that ran once from a job that ran twice and was settled once.

Cases: 8 jobs / 2 processes with no duplicate execution and both processes doing work; 4+4 jobs across two tenants with every execution asserted against its job's own tenant; a slow job not blocking unrelated ones; graceful `SIGTERM` mid-job; `SIGKILL` mid-job leaving a recoverable lease that a fresh worker picks up on its reaper tick alone.

## 11. Idempotency results — **written, NOT RUN**

Three shapes, in `engine/worker/workerRuntime.dbtest.ts`:

- **the same job twice** — the purge is a set-based delete against a predicate, so the second run reports `purged=0`;
- **the same external identity twice** — `ops.enqueue_job` with the same `idempotency_key` returns the **same job id** and creates one row;
- **a crash after the side effect, before completion** — the delete and the settlement share TX2, so the rollback discards both and the ledger count is unchanged.

## 12. Adversarial tests — **written, NOT RUN** (except where noted)

| Attack | Expected | Status |
| --- | --- | --- |
| payload carries another tenant's id | ignored entirely; tenant stays the lease's | unit ✅ + db suite written |
| payload tries to shorten the retention window | database floors it at 30 days | db suite written |
| unknown job type | permanent failure, nothing executed | unit ✅ + db suite written |
| job kind `toString` (prototype member) | no handler found | unit ✅ + db suite written |
| malformed payload | permanent, terminal on first attempt | unit ✅ + db suite written |
| forged job id in `resume_lease` | no context, no rows | db suite written |
| another worker's lease | no context, no rows | db suite written |
| expired lease + capability call | `42501`, nothing deleted | db suite written |
| no lease at all + capability call | `42501` | db suite written |
| settling a job not held | `false` / `refused`, job untouched | db suite written |
| worker queries `public.*` directly while holding a live lease | `42501` on select **and** delete | db suite written |
| connection reused after tenant A | zero rows, no context | db suite written |

## 13. Mutation-testing results — **16 / 16 caught**

Run in full, twice. The harness restores every file it touches and verifies a green baseline first.

| | Mutation | |
| --- | --- | --- |
| M1 | registry default-allows an unknown kind | caught |
| M2 | tenant taken from the payload | caught |
| M3 | lease-resume check removed | caught |
| M4 | `set local role ops_worker` removed | caught |
| M5 | capability bag unfrozen and granted whole | caught |
| M6 | registry becomes a plain object (`toString` resolves) | caught |
| M7 | security refusal classified as transient | caught |
| M8 | unrecognised error defaults to transient | caught |
| M9 | failed settlement ignored, work commits anyway | caught |
| M10 | graceful shutdown abandons the job in flight | caught |
| M11 | reaper tick removed | caught |
| M12 | boot gate accepts BYPASSRLS | caught |
| M13 | boot gate accepts postgres / service_role | caught |
| M14 | `ops_worker` granted a write verb (static guard) | caught |
| M15 | ops metrics view loses `security_invoker` (static guard) | caught |
| M16 | a log line may carry the payload | caught |

**Two were not caught on the first run, and both findings were real in different ways.**

- **M3 was a missing test.** Nothing exercised TX2's lease-resume refusal; with the guard removed the failure surfaced as an unrelated `TypeError` classified `unknown` rather than as a `security` refusal. A test was added.
- **M10 was a bad mutation of mine**, not a gap. It added `if (signal?.aborted) break;` before the call — which changes nothing, because the loop condition already says that and the in-flight job is still awaited. Redesigned as genuine fire-and-forget, it is caught by two assertions.

I am flagging the second because "14/16, then 16/16 after fixing the tests" would be a misleading summary: only one of the two was a coverage gap.

## 14. Test counts

| Suite | Result |
| --- | --- |
| `functions` + `claude` unit projects | **699 passed, 1 skipped**, 54 files |
| of which new in Phase 1B | **92** across 8 files |
| `app` (browser) | unchanged, not re-run this phase |
| SQL database suites (`npm run test:db`) | **4 passed** — `ops_execution_core`, `rls_tenant_isolation`, `worker_tenant_context`, `jobLeasingConcurrency` |
| driver-backed suites (`npm run test:db:engine`) | **written, not run** — 4 files, ~45 cases |
| Mutation | **16 / 16** |

## 15. CI status

`.github/workflows/check.yml`'s `database` job gains one step between the RLS suites and the clean-reconstruction reset:

```yaml
- name: ⚙️ Worker runtime, pooling and concurrency
  run: npm run test:db:engine
```

It is in the `database` job rather than `test-app` because it needs a live Postgres and spawns real processes; the unit jobs must never depend on Docker.

**Not yet exercised.** `npm ci` will fail until `package-lock.json` carries `pg`, which requires the install in §20. The two pre-existing red checks (legacy `e2e-test`, and Prettier's ~419 files) are untouched — no new formatting debt was added, and `npm run lint` is clean.

## 16. `db reset` status

**Clean.** `npx supabase db reset --workdir .supabase-e2e --local` applied all 31 migrations including `20260912160000_ops_worker_runtime.sql`, and `npm run test:db` passed all four SQL suites afterwards. The new migration's nine end-state assertions all fire on every reset, and the migration re-applies idempotently.

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
| `ops_worker` least privilege | ✅ five new function grants, **zero** new write verbs |
| Tenant-from-live-lease | ✅ strengthened — the trusted row is now re-read *inside* the execution transaction |

**The strengthening is worth spelling out.** The guard previously checked `security_invoker` only in `public` and refused to silently ignore a view elsewhere. Adding `ops` to `views.ignoredSchemas` would have been the easy fix and would have been **fail-open** for every future `ops` view. Instead `views.enforcedSchemas = ["public", "ops"]` now holds `ops` to the same rule — verified by mutation (M15), and pinned as a literal in `migrationInvariants.test.ts` so removing a schema is a diff in a test file.

Three new invariants: **SI-16** (the worker process refuses to boot on an over-privileged identity), **SI-17** (unknown job kinds fail closed; no dispatch on a payload-supplied name), **SI-18** (a capability reaching into `public` takes its tenant from the live lease, refuses any tenant without `owns_local_crm`, and clamps its parameters).

## 18. Remaining risks

1. **The driver-backed evidence is unexecuted.** Everything in §3, §10, §11 and §12 is design and code, not measurement. This is the whole of §20's classification.
2. **A single wedged worker does not reap** (§8). Visible via the heartbeat, not automatically repaired.
3. **`ops.tenants.owns_local_crm` is a bridge, and bridges become load-bearing.** It is the first piece of tenant↔CRM modelling in the repository. Phase 1C should decide deliberately whether it stays a boolean.
4. **Nothing schedules the retention job.** `ops.enqueue_job` is correctly still closed to the worker (§14 of the brief), so a recurring run needs an external trigger. Out of scope here; it is a real gap for the obligation the handler discharges.
5. **Edge functions still run as `service_role`** (SI-06), and `net.http_get` is still reachable by `authenticated` (ADR 0011). Unchanged by this phase.
6. **A malicious worker *process* is still bounded by `ops_worker`'s grants, not by one tenant.** Unchanged from Phase 1A and stated in ADR 0012.
7. **`pg` is a new supply-chain dependency.** Standard, mature, widely used — and it is now in the tree, with the adapter as the only module importing it.

## 19. ADR changes

- **[ADR 0012](adr/0012-worker-tenant-context.md) → `Accepted`**, with the Phase 1A addendum and explicitly **not** the original pure-GUC design. Items 2 and 4 of the original Decision are superseded. `DECISIONS.md` agrees, enforced by the ADR-index drift guard.
- **A Phase 1B addendum was added to ADR 0012**, recording the single-transaction defect and the `ops.resume_lease` correction. Accepting an ADR did not end the measuring, and the record should show that.
- **ADR 0002's blocker is lifted** — it could not be accepted until 0012 was. It is still `Proposed`; accepting it is the owner's call, not mine.
- No new ADR. Nothing in Phase 1B is a structural decision the existing ones do not already cover.

## 20. Recommended Phase 1C scope

**First, the one command that closes this phase:**

```bash
npm install
```

`pg@^8.13.0` and `@types/pg@^8.11.10` are declared in `package.json`. Then:

```bash
npx supabase start --workdir .supabase-e2e
SUPABASE_DB_PORT=54342 npm run test:db:engine
```

Once those are green and CI has run, Phase 1B is complete and the classification below flips.

**Then, exactly one slice** — and it is not agents:

1. **Schedule the retention job.** The handler discharges an LGPD obligation that nothing currently triggers. Decide where recurrence lives: an external scheduler, or a narrow `ops` function that enqueues *one* allow-listed kind for the `owns_local_crm` tenant. If the latter, it is the §14 continuation mechanism and should be built with the same care as the capability.
2. **A second handler, still deterministic,** to prove the registry and capability model generalise before anything non-deterministic touches them. The stale-`pending` ledger triage is the natural candidate — same table, same capability shape, real value.
3. **The kill switch and cost ledger** (ADR 0010). The roadmap's sequencing rule is unchanged and binding: **no agent before these exist.**

Do **not** start LLM integration, the tool gateway proper, or the domain model until (3) is done.

---

## Classification

# NOT READY FOR PHASE 1C

**Every engineering deliverable is built**; the blocker is evidence, and it is one command wide.

- **Engineering:** complete. 699 unit tests green, 4 SQL suites green, clean `db reset`, lint clean, typecheck clean apart from the unresolved `pg` module, 16/16 mutations caught, security baseline intact and one guard strengthened.
- **Operational blocker — NOT an engineering blocker:** `pg` cannot be installed from this session. `.claude/settings.json` denies `Bash(npm install *)` and bare `npm install` is denied here too. `.claude/rules/dependency-safety.md` reserves package additions to a human, and that rule did its job — the package was chosen by the owner, and the manifest now declares it. The install itself is the owner's to run.
- **What that leaves unproven:** the pooling guarantee through the real driver (§3), real multi-process concurrency (§10), idempotency against a real database (§11), and the live adversarial cases (§12). All are written; none have executed.

I am not classifying this READY on tests that have not run. When `npm install` and `npm run test:db:engine` are green, the only remaining item is a CI run, and the classification becomes READY FOR PHASE 1C.
