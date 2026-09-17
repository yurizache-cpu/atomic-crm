# PHASE 1D.1 RUNTIME GOVERNANCE REPORT

**Date:** built 2026-09-16/17
**Branch:** `feature/runtime-governance` (local only, not pushed), created from `a2d0c37c` on `feature/clinical-phase-1`
**Commits:** four, local only, on top of `a2d0c37c`:
- `c1761702` the schema and the domain services;
- `cd9d3b3f` the engine, the CLIs and the driver-backed proofs;
- `4bdcfb42` the security invariants;
- the documentation commit that carries this report.

Each of the first three typechecks on its own. The verified state is the last commit.
**CI:** not run. CI runs only on pushed branches, and agents never push.

**Preconditions, confirmed before any change (2026-09-16):**
- **Phase 1D is CI verified.** Checked independently through the public GitHub API:
  - run 35129049291 on `c4382b9b` and run 35130378950 on `a2d0c37c` (HEAD);
  - every Phase 1D job is green;
  - only `e2e-test` and `Prettier` are red, identical to the baseline.
- **ADR 0016** is Accepted.
- **Branch state:** `feature/clinical-phase-1` was clean and identical to `origin`, with no uncommitted work.

## Owner review (2026-09-17)

**The owner accepted the Phase 1D.1 architecture and [ADR 0017](adr/0017-runtime-governance.md), with four decisions** (recorded in the ADR's owner-review addendum):
- **A. Fail closed without governance configuration.** No model call begins unless an active price version, the global daily ceiling, the tenant daily budget and any configured company limit all resolve. There are no default prices and no unlimited budgets.
- **B. Stopped jobs are held or deferred, never cancelled.** A stopped job consumes no attempt, never calls the provider, becomes eligible only after an explicit clear, and does not spin while stopped.
- **C. A request may wait for a prepare in progress,** bounded by the existing lock order and timeouts, with no duplicate run, job or provider call.
- **D. The spend-ceiling stop is cleared by a person.** A new day, a budget or price change, or lower spend never resumes model execution on its own.

The owner did not decide ADR 0010, which stays Proposed; its 2026-09-17 addendum records what is built. ADR 0015 and ADR 0016 stay Accepted, and their 2026-09-17 addenda stand as corrected.

**One blocking verification finding: decision B was not met for an agent run whose job was leased before a trip.** `ops.start_agent_run` recorded the covering stop as `cancelled` / `refused` / `execution_stopped`. The job completed on that attempt, and clearing the stop resumed nothing. **Fixed in code:**
- **The start holds the run.** When an active stop covers the run, `ops.start_agent_run` answers the new token `stopped` before any other gate and writes nothing. The run stays `pending`, with no stop, error code, price or charge.
- **The handler reports it.** `stopped` maps to a new prepare outcome, `held` (`engine/handlers/agentRunExecute.ts`, typed in `engine/worker/handlerRegistry.ts`).
- **The runtime defers the job.** `deferHeldJob` (`engine/worker/externalCall.ts`) releases the prepare savepoint, which has nothing to discard, and calls `ops.defer_job()` in the same transaction.
  - The start's kill-switch lock is still held, so the stop cannot be cleared in between.
  - The job returns to `queued` with its attempt restored, 30 s later, with a `deferred` job event naming the stop.
  - While the stop stays active, the lease holds the job. After an explicit clear, the next lease runs the same run, and every gate is checked again at its start.
  - If the deferral finds no covering stop, the two readings disagree: the whole prepare rolls back, the attempt fails through the transient path, and nothing is called.
- **Request-time refusal is unchanged.** A request made under a covering stop is recorded `cancelled` / `refused` / `execution_stopped`, naming the stop, and no job is created. No job is created, the provider is not called, and nothing is deferred. **The owner confirmed this as decision E (2026-09-17):** a stop before admission refuses new work; a stop after admission holds the work already admitted (§13, item 12).
- **Tests.** SQL K3 in `agent_runtime.sql`; driver tests in `externalCallDeferral`, `agentRunRuntime` and `agentRuns` (two sessions); unit tests in `agentRunExecute.test.ts`. SI-31 and SI-37 were restated.

**The spend status is unambiguous.** `ops.spend_status()` renames `exhausted` to `settled_exhausted` and adds `new_run_admission` (`blocked` or `conditional`). `npm run ops -- status` also reports `globalCeilingConfigured`. The budget model is unchanged (§2).

**The lease refuses an unreadable switch.** `ops.lease_job` raises `OS403` when row security would hide the stops, like every other reader of the switch (ADR 0010: fail closed).

**New SQL cases** in `runtime_governance.sql`:
- **A13:** a missing tenant budget beside a global ceiling that settled spend already reaches is refused `budget_exhausted`, naming the global version, at start and at request, before any job.
- **E8:** decision D as a named regression guard.
  - While the system stop is active, a new ceiling version with room and a new current price version leave it uncleared, the sweep answers NULL, and a queued agent run stays held at the lease.
  - A tenant or company budget exhausted by settled spend never trips a stop.
  - The sweep's body has no statement that could clear or rewrite a stop.
- **G7:** the `OS403` refusal, pinned in the bodies of the four readers of the switch.
- **L11** now links a `blocked` row to admission: `ops.spend_admission` for reservations of 3001, 3000 and 0.

**How it was verified.** An adversarial workflow read ADR 0017 against the code:
- nine section readers reported discrepancies;
- one skeptic per discrepancy then tried to refute it.

33 discrepancies survived. All were wording except the decision B gap, and all were applied; §8 groups them as findings 27 to 34. The code changes were mutation-tested with 12 mutants, all caught (§10).

**Phase 2A.** The owner accepted the direction as **PHASE 2A — SYNTHETIC LEAD TRIAGE PILOT** (ROADMAP, owner review 2026-09-17).
- **Flow:** inbound test ingress → idempotent task → `lead_triage` capability → agent run → structured advisory triage → human review → operator queue.
- **Allowed:** verified inbound webhook infrastructure; synthetic or test messages; a minimal message ledger, without the message body wherever possible; idempotent `create_task`; `lead_triage` structured output; read-only CRM and contact lookup; a response draft that a person reviews; the current pricing, budget and kill-switch governance; operator CLI visibility; consent, `do_not_contact` and retention enforcement.
- **Not allowed:** the model sending WhatsApp messages on its own; the model writing CRM data; generic tools; browser automation; RAG or memory; multi-agent delegation; autonomous loops; real clinical or patient text sent to a model while Q8 is open; UI or isometric work.
- **Not started.** It waits for the Phase 1D.1 CI result and its own brief. Where §14 differs from the roadmap, the roadmap governs.

**BASELINE Q8 is unchanged and explicit.** It blocks real patient data, not synthetic Phase 2A development and testing. Until the owner decides it, no real patient message body, clinical text, psychotherapy information or health data may be sent to a real LLM provider (§13, item 1).

---

This is a short bridge phase. It closes the runtime governance gaps Phase 1D left, before the agent runtime is connected to a real clinic flow. [ADR 0017](adr/0017-runtime-governance.md) records the decisions (Accepted by the owner 2026-09-17, with an owner-review addendum). The addenda to ADR 0010, 0015 and 0016 record what each earlier decision now is. SI-35 to SI-39 are the new invariants; SI-13, SI-14 and SI-31 were restated.

**Not built, as the brief required:** WhatsApp, CRM-writing agents, tools, browser automation, a UI, the Tool Gateway, and real patient data. **No live provider call was made.**

**How it was built:**
1. **Rehydration.** Parallel read-only readers mapped the domain services, the worker runtime, the test and guard infrastructure, the CLIs, and the job substrate.
2. **Design.** ADR 0017 was drafted. An adversarial review then ran four lenses (concurrency, cost, security, regression), with one skeptic per finding. 39 findings; 36 survived, none High after verification, about ten Medium. Every Medium changed the design before any SQL was applied (§8).
3. **Migration.** One hand-written migration, `supabase/migrations/20260917120000_runtime_governance.sql`, re-asserts the whole `ops` end state. It was dry-run in a rolled-back transaction, then applied through a clean reset.
4. **Implementation.** Three parallel streams (SQL suites; engine runtime; domain and CLIs) had strict file ownership, and each was followed by an adversarial reviewer who mutation-tested and fixed what they could confirm. A rate limit interrupted the streams once; they resumed from the working tree.
5. **Driver proofs.** Driver-backed proofs were written in sequence (they share one database), then reviewed adversarially with SQL and TypeScript mutations (§10).

---

## 1. Pricing architecture

**`ops.model_prices`** holds one immutable row per price version.

**Columns:**
- `provider`, `model`;
- `input_usd_per_mtok`, `cached_input_usd_per_mtok` (NULL means cached input is billed in full), `output_usd_per_mtok`;
- `reasoning_in_output`: whether reported reasoning tokens are already inside the output tokens;
- `effective_from`, `expires_at`;
- `source`, `recorded_by`, `recorded_at`, with the database's clock.

**Rules:**
- **Owner data, never a constraint and never a migration row.** A price is recorded by `ops.record_model_price` (`npm run ops -- price record`). The migration asserts that it ships no rows. `referenceData.mjs --without-seed` asserts that none exists after a migrations-only replay.
- **Versioned and immutable.** Versions are unique on `(provider, model, effective_from)`.
  - A replay of the same version returns it; a different version at the same moment is `OS409`.
  - An `ENABLE ALWAYS` guard refuses UPDATE and TRUNCATE.
  - A version a run references cannot be deleted.
  - The recording service and the CLI (`ops.record_model_price`, `money.ts`) refuse a rate with more than six decimals instead of rounding it. A raw owner insert into the `numeric(14,6)` column would round.
- **Never silently stale.**
  - Every version expires at most 366 days after it takes effect.
  - The version that applies is the latest with `effective_from` at or before the start. If that version has reached its `expires_at` there is no price (a version prices runs only while `now()` is before it): nothing falls back to an older version.
  - No price means no call. The start records `cancelled` / `refused` / `price_unavailable`.
- **Chosen by the database at start** for the run's own provider and model, and recorded on the run (`price_id`). The reservation and the final estimate use that same version, even if a new version takes effect during the call.
- **Cost dimensions:**
  - uncached input at the input rate;
  - cached input at the cached rate, only when one was recorded;
  - output at the output rate;
  - reasoning added on top only when the version says it is not already inside output.

  Each cost is one exact `numeric` expression, rounded up once, stored as `bigint` micro-USD. A rate is USD per million tokens, so tokens × rate is micro-USD.
- **Auditable.** A run's estimate can be recomputed from its token counts and its `price_id` row.

## 2. Budget model

**`ops.spend_limits`** holds versioned daily limits.

**Scopes and what they answer:**
- **`global`** is ADR 0010's daily spend ceiling.
- **`tenant`** is a tenant's daily budget.
- **`company`** is an optional limit for one company inside a tenant. It is organisation only, not an isolation boundary (ADR 0015).
- **The window** is local midnight in the limit's IANA time zone, computed from the transaction timestamp that becomes the run's `started_at`.
- **Changes:**
  - A new value supersedes the active version (`ops.set_spend_limit`), and the same value changes nothing.
  - A time-zone change is refused unless the limit is retired first.
  - Retiring is a recorded act (`ops.retire_spend_limit`).
  - An active version cannot be deleted, and a version is never rewritten except to redact free text.

**The questions the brief asks,** answered by `ops.spend_status()`, `npm run ops -- spend` and `status`:

| Question | Answer |
| --- | --- |
| Spend today | `charged_micros` (what admission counts, calls in flight at their reservation), `settled_micros` (runs no longer running), `estimated_micros` (known estimates) |
| Configured limit | `daily_limit_micros`, `timezone`, `window_start` |
| Remaining | `remaining_micros` = limit − charged, which can go below zero |
| Whether execution should be refused | per limit, `newRunAdmission`: `blocked` once charged spend has reached the limit (no run with a reservation above zero is admitted), `conditional` otherwise (see below); `settledExhausted` = settled ≥ limit, and on the global row the ceiling sweep trips when `settledExhausted` is true or `refusedRuns` > 0; a missing global ceiling refuses every run, and a missing tenant budget refuses that tenant's runs: `status` lists tenants without a budget and reports `globalCeilingConfigured`, and `routes` shows whether each route's model has a current price |

**Reading the status (clarified at the owner review, 2026-09-17).**

The start decides admission for one run's reservation, so no status row can promise that a run will start. `ops.spend_status()` therefore reports two things separately:
- **`settled_exhausted`** (`settledExhausted`) is settled ≥ limit.
  - On the global row, the ceiling sweep trips when it is true or when `refused_runs` (`refusedRuns`) > 0, that is, when the version in force refused a run today as `budget_exhausted`.
  - A tenant or company limit never trips a stop.
  - A `false` never means that a run can start, nor that the sweep will not trip.
- **`new_run_admission`** (`newRunAdmission`) says what this limit alone does to the next start:
  - `blocked`: charged ≥ limit, so no run with a reservation above zero is admitted by this limit.
    - A run whose reservation settled spend cannot absorb (settled + reservation > limit) is refused `budget_exhausted`, even when `settled_exhausted` is false. On the global ceiling, such a refusal trips the ceiling stop.
    - Any other run is contended: its start raises `OS429`, and its job retries on its backoff. That may end in admission, in exhaustion, or in job failure after the last attempt (five by default).
  - `conditional`: a run is admitted by this limit only if its reservation fits `remainingMicros`. The price, every other applicable limit and the stops still decide whether it starts; `npm run ops -- routes` shows reservation sizes. It says nothing about a limit that does not exist.
- **`globalCeilingConfigured`** (`npm run ops -- status`) is derived from the spend rows. Without an active global ceiling every run is refused `spend_ceiling_unconfigured`, and the status says so explicitly instead of by a missing row.

The budget model is unchanged: this renames the old `exhausted` column and adds one column derived from the same totals. SQL L11 matches a `blocked` row against `ops.spend_admission`.

**Charging a run:**

| Run state | Charge |
| --- | --- |
| started | the worst-case **reservation**: the input ceiling (from the claimed context, measured after JSON escaping, name and role counted twice, plus 8192) at the input rate, plus the route's output ceiling at the output rate (counted twice when the price version bills reasoning on top of output), rounded up once |
| `indeterminate` | the greater of the reservation and any estimate |
| finished with complete, consistent usage | the estimate |
| a refusal with no usage, no response id and no response model | 0 |
| anything else | the reservation |

The run guard derives the estimate and the charge on every write path. `ops.start_agent_run` derives the price version and the reservation.

**Fail closed (owner decision A).** A run starts only when a current price, a global ceiling and its tenant's budget all exist. Only those two limits must exist; every configured limit, a company limit included, must absorb the reservation.

## 3. Concurrency enforcement

- **Per-scope locks.** `ops.spend_admission` takes three transaction advisory locks exclusively (global, then tenant, then company), each in its own statement, in a namespace separate from the kill-switch lock. It then reads totals. Under READ COMMITTED each later statement takes a fresh snapshot, so a start that waited sees every reservation committed before it.
- **Read committed is enforced.** The start, the request, spend admission and the lease refuse to run under any other isolation level. The start refuses before it reads stops, prices or spend totals; its early branches for runs that are not pending read none of them.
- **The lock order.** A prepare (the claim, then the start) takes its locks in this order:
  1. job (share);
  2. run;
  3. task and agent (share: the claim takes them, and they are held until the prepare commits);
  4. company and department (share);
  5. the kill-switch lock (shared);
  6. the global, tenant and company spend locks.

  No path waits for a lock earlier in this order while it holds a later one.
  - **The request path** takes the task FOR UPDATE, then the agent, company and department FOR SHARE, then the kill-switch lock shared, and no spend lock. Its only later run-row locks are on its own new run or on a finished retry parent, which a claim never pairs with a task lock.
  - **Trip** share-locks its target's tenant, company, department and agent rows, then takes the kill-switch lock exclusively. **Clear** takes the kill-switch lock exclusively, then its own stop row, which is not a lock of the chain. Neither takes a lock of the chain after the kill-switch lock, and trip's row locks are FOR SHARE, as the start's are.
  - **Setting or retiring a limit** takes no advisory lock other than its own scope's spend lock, then its limit row. Setting one share-locks its tenant and company rows first.
  - **The ceiling sweep** takes only the kill-switch lock, through a global trip.
  - **The smoke command** records its configuration in its own transaction, committed before it requests the run.
  - **Non-blocking exceptions to the literal order:**
    - a lock the transaction already holds (the request's task and company, the pre-call check's job and kill-switch lock);
    - `lease_job`'s SKIP LOCKED job rows;
    - the lease holder strengthening its own job-row lock in `defer_job` and `complete_job`;
    - a row the transaction just inserted;
    - the bridge locking a pending run with no job.
- **Exhaustion versus contention:**

  | Result | Condition | What happens |
  | --- | --- | --- |
  | exhausted | settled spend plus the reservation exceeds a limit | the run is recorded `cancelled` / `budget_exhausted`, naming the limit version; exhaustion anywhere wins over contention |
  | contended | the reservation fits settled spend, but not beside calls in flight | the start raises `OS429` and records nothing; the prepare rolls back, and the job retries on its backoff (classified transient) |
  | missing budget beside a contended ceiling | no tenant budget | recorded as `budget_unconfigured`, naming no limit (test A12, a review finding) |
  | missing budget beside an exhausted ceiling | no tenant budget, and settled spend on the global ceiling cannot absorb the reservation | recorded `budget_exhausted`, naming the global version (test A13, owner review) |

  **Precedence.** Scopes are walked global, tenant, company, and the first refusal wins. For each scope the limit must exist (global and tenant are mandatory, company is optional), then exhaustion is tested. A contention is remembered and returned only when no later scope refuses. So a missing global ceiling is `spend_ceiling_unconfigured`; an exhausted global ceiling is `budget_exhausted` even beside a missing tenant budget; a missing tenant budget is `budget_unconfigured` and wins only over contention; and a missing company limit is skipped.
- **Settlement:** lowering a charge takes no lock. Raising one (an estimate above its reservation) takes the spend locks first.
- **Stalled holders:** every worker transaction sets `idle_in_transaction_session_timeout` (10 s). A stalled holder's session is ended, its uncommitted start rolls back, and no call follows. The connection adapter no longer crashes the process when the server ends a checked-out session. A wait inside a statement is bounded by the worker's `statement_timeout` (30 s by default) instead. An owner session opened outside `createWorkerDatabase` has no idle bound (§13, item 14).
- **Calls in flight** are never interrupted because a limit was crossed during them.
- **Proven** by the SQL suite (lock witnesses W1–W7 and the admission cases A1–A13) and by driver-backed two-session and multi-worker races (§9).

## 4. Kill-switch changes

There is still **one switch** (`ops.execution_stops`) and now **one evaluator**: `ops.execution_stop_covers`, applied by `ops.covering_execution_stop`.

- **Total classification.**
  - `ops.external_job_kinds()` returns `{agent_run.execute}`; `ops.internal_job_kinds()` returns `{postmark.ledger_retention}`.
  - `engine/worker/jobKinds.ts` mirrors both. The worker refuses a registry in which an external kind is not an `external_call` handler, or an internal kind is not transactional.
  - A kind nobody classified is treated as holdable.
- **The lease.** `ops.lease_job` takes the kill-switch lock shared and passes over every queued job whose kind is not internal and that an active stop covers. The job stays queued and **consumes no attempt**; this is ADR 0010's "no new job is leased". The cost is nothing without stops, and one comparison per job under a global stop. Only organisational stops make each held job's coordinates be read. Since the owner review, the lease refuses (`OS403`) when row security would hide the stops, like every other reader of the switch, so an unreadable switch leases nothing (SQL G7).
- **A new scope, `job_kind`:** one external kind, for one tenant or for all. Tripping it for a kind that is not external is refused, both by the owner service and by the insert guard on every write path.
- **Origin.** `origin` (`owner` | `system`) is derived from the actor and is part of the one-active-stop-per-target key. The spend ceiling's automatic stop and an owner's incident stop are separate rows, and neither absorbs nor clears the other. The stop CLI reports `already_stopped`, with the existing actor, when a trip found a stop instead of recording one.
- **Coordinates.** They come only from facts fixed when the job was requested (the agent run, or the requesting task's company), never from a task's current department or assignee. An unknown coordinate fails closed inside its tenant.
- **Before the call.** The `external_call` runtime takes a savepoint before the handler's prepare.
  - **Agent runs are held at start** (owner decision B, 2026-09-17).
    - When an active stop covers the run, `ops.start_agent_run` answers `stopped` before any other gate and writes nothing: the run stays `pending`, with no stop, error code, price or charge.
    - The handler maps that answer to a `held` prepare outcome. The runtime then calls `ops.defer_job()` in the same transaction, while the start's shared kill-switch lock is still held, so the stop cannot be cleared in between.
    - The job returns to the queue with its attempt restored, 30 s later, with a `deferred` job event naming the stop. The lease holds it while the stop stays active. After an explicit clear, the next lease runs the same run, and every gate is checked again at its start.
    - If the deferral finds no covering stop, the two readings disagree: the whole prepare rolls back, the attempt fails through the transient path, and nothing is called.
  - **Other external handlers keep the generic check, unchanged.**
    - After a prepare that answered `call`, the runtime asks `ops.job_execution_stop()`.
    - A covering stop rolls back to the savepoint, discarding the handler's durable start. `ops.defer_job()` then returns the job to the queue with its attempt restored, 30 s later, with a `deferred` job event naming the stop. Nothing is called.
    - A malformed answer fails closed.
    - For agent runs this check cannot find a stop: the start has already evaluated the stops under the same shared lock, which is still held, and it answers `stopped` rather than `running` when one covers the run.
  - **The generic race (a residual).** A stop cleared between the generic check and the deferral leaves `ops.defer_job()` nothing to defer. The attempt then fails through the transient path: one attempt is spent, and nothing is called. The agent-run path cannot meet this race (§13, item 13).
- **The global ceiling.** `ops.enforce_spend_ceiling()` runs on the worker's reaper tick. It trips a `system:spend_ceiling` global stop when the active ceiling version is exhausted: settled spend has reached it, or it refused a run today that settled spend alone could not absorb. It never trips on reservations in flight, and it never clears a stop: only a person does (owner decision D, SQL E8).
- **Unchanged:**
  - request-time refusal of agent runs: a request under a covering stop is recorded `cancelled` / `refused` / `execution_stopped`, naming the stop, and creates no job (§13, item 12);
  - the reserved error code `execution_stopped`, and the run guard's rules tying it to `stop_id`;
  - no interruption of a call in flight;
  - audited clearing by a person;
  - deny-wins.

## 5. Domain idempotency

**Scope:** `ops.create_task` and `ops.record_event`, the two Phase 1C creates that future integrations will retry (PHASE_1C_REPORT Appendix A item 8). Each gains an optional, trailing `p_idempotency_key`. The old signatures were dropped, so every positional caller resolves to the one overload, which the migration asserts.

| Case | Behaviour |
| --- | --- |
| same tenant, same key, same semantic request | the existing id; no second row, no second `task.created` or event |
| same key, different request | `OS409` (`invalid_state`) |
| concurrent duplicates | `INSERT … ON CONFLICT DO NOTHING` on a partial unique index waits for the first transaction, then re-reads and compares |
| same key in another tenant | independent |
| no key | today's behaviour, unchanged |

**The fingerprint:**
- sha256 of a JSON array: an unambiguous encoding, so a `|` in a title cannot make two requests collide.
- The due date is taken as epoch seconds, so the session time zone cannot change it.
- For a task it covers company, department, parent, type, title, description, priority and due date. For an event it covers company, type, source, subject, payload (jsonb, so key order does not matter) and causation.
- It is **derived by an insert trigger** from the stored row: a caller never supplies it. An `ENABLE ALWAYS` guard fixes the key and fingerprint on tasks; events were already never updated.

**Not changed:**
- **The other creates.** `create_company`, `create_department` and `create_agent` already refuse a retry through their slug keys, so they cannot duplicate work, and onboarding is not an integration retry path.
- **Transitions** cannot duplicate work.
- **The correlation residual.** The caller-declared `correlation_id` (Appendix A item 7) remains recorded and open. Correlation is part of neither fingerprint.

**Typed boundary.** `engine/domain/companyOs.ts` validates the key before any SQL, and `CreateTaskInput` and `RecordEventInput` gain `idempotencyKey`.

## 6. external_call boundary

**The extraction.** The prepare / call / settle flow moved out of `engine/worker/runOneJob.ts` (802 lines) into `engine/worker/externalCall.ts`. The helpers both paths share (lease resume, tenant check, job completion, failure settlement) moved into `engine/worker/attempt.ts`. `runOneJob.ts` keeps the lease, the dispatch and the transactional path, and re-exports what earlier importers used.

- **Verification:** the extraction was checked line by line against HEAD, and the existing unit, driver and mutation cases pass unchanged.
- **The one additive change** is the pre-call stop check with its savepoint and deferral (§4), plus the new `deferred` outcome that `runWorker` counts. At the owner review, a `held` prepare outcome joined it: the runtime defers a job whose start found a covering stop (§4).
- **Preserved:**
  - prepare (committed) → call (no transaction, no capabilities) → settle (with job completion);
  - the durable start before the call, and only the token `running` means call;
  - a call's failure is the run's outcome, never a job retry;
  - a run found running by anyone but its own attempt is settled `indeterminate`;
  - the lease-derived deadline, abandonment after abort, and capability revocation per phase.
- **The output ceiling.** `ops.start_agent_run` takes the output ceiling the handler will send, and refuses a mismatch with the database's route policy.
- **Isolation.** The SI-14 marker (`tenant context mismatch`) now lives in `attempt.ts`; SI-14 cites it there.
- **Idle bound.** Every worker transaction is bounded by an idle-in-transaction timeout (§3).

## 7. Operator CLI

The command is `npm run ops -- <command>` (`engine/cli/operator.ts`). It connects over `ADMIN_DATABASE_URL`, the only variable it reads.

| Command | Shows |
| --- | --- |
| `status` | active stops by scope and origin; today's runs by status; queued jobs a stop holds (scan capped at 10 000, reported); runs needing attention; spend per limit; whether a global ceiling is configured (`globalCeilingConfigured`); tenants without a budget |
| `stops [--all]` | execution stops, with `jobKind` and `origin` |
| `routes` | the route summary (provider, model, ceilings) published by each of the 50 most recently seen workers, stopped and crashed ones included; each row carries `lastSeenAt` and `stoppedAt`, so liveness is the operator's judgement, not a filter; whether the model has a current price; the database's ceiling and whether it matches; the smallest and largest reservation under that price, for text within the Phase 1C length checks |
| `prices [--all]` | price versions: current, expired, future (and superseded with `--all`) |
| `limits [--all]` | spend limit versions |
| `spend [--tenant]` | charged, settled, estimated, remaining, running, unknown-cost and refused runs, `settledExhausted`, `newRunAdmission` |
| `runs [--tenant] [--status] [--limit]` | recent runs: ids, statuses, categories, codes, provider, requested and reported model, the five token counts, latency, attempt, price, reservation, estimate, charge, stop and limit |
| `indeterminate [--tenant]` | indeterminate runs that no retry names, and running runs whose job lost its lease |

**The three mutations:**
- `price record` (requires `--source` and `--actor`);
- `limit set` (requires `--reason` and `--actor`);
- `limit retire`.

Amounts are parsed as exact decimals, never floats. Tripping and clearing stops stay in `npm run execution-stop`, which gains `--kind` and the `already_stopped` answer.

**Guarantees:**
- **Read-only by default.** Every read command runs `set transaction read only` first; a driver test proves a write inside it fails with `25006`.
- **No secrets and no content.** A test wraps the environment in a Proxy: the tool reads only `ADMIN_DATABASE_URL`, and nothing on a usage error. It prints no result, prompt, task or agent text, idempotency key or connection string; connection failures print only a SQLSTATE.
- **No key in `routes`.** It reads what each worker published in its heartbeat detail (`engine/models/routeSummary.ts`: tier, provider, model and policy, strictly parsed). It never reads routing variables from its own environment, so the provider key and the owner connection string never share a process. A key-shaped value a worker published is withheld.

## 8. Security impact

**No new reachable surface.**
- **Data API.** `ops` stays off it. The exposure probe now also requires `model_prices`, `spend_limits` and the five new functions to exist: 15 relations and 96 functions (Phase 1D measured 13 and 60), 5 credentials, 705 requests over REST and GraphQL, and none reached `ops`.
- **Grants.** No application role holds anything on prices or limits. `ops_worker` gains EXECUTE on three argument-less, lease-bound (or lease-free sweep) SECURITY DEFINER capabilities, plus the new start signature, and no table privilege. The migration pins the SECURITY DEFINER set (20 functions) and the complete application-role EXECUTE surface (21 entries) by name, in both directions. The SQL suites pin them again.

**Invariants.**
- **New:**
  - SI-35: cost is never invented.
  - SI-36: spend is bounded before any call.
  - SI-37: one switch, held at the lease and before every external call.
  - SI-38: idempotent domain creates.
  - SI-39: the operator view is read-only and content-free.
- **Restated:**
  - SI-13: the worker is granted twenty pinned function signatures (it calls eighteen), five of which check no lease.
  - SI-14: the marker moved.
  - SI-31: the agent-run part of the switch, pointing to SI-36 and SI-37.
  - SI-31 and SI-37, again at the owner review: a stop found at start holds the run and defers its job (decision B, §4).
- **Preserved:**
  - tenant comes from the live lease, and a company is not a tenant;
  - no `service_role` or `postgres` for ordinary execution;
  - model output stays untrusted and advisory;
  - no tools, loops, browser, SQL for agents or MCP;
  - provider keys stay server-only (the build scan and source tests are green);
  - no new prompt or result persistence;
  - global monotonic ids stay internal (the operator CLI prints no `seq` or job-event id);
  - local Supabase stays loopback-only;
  - the production seed policy is unchanged (the production-scope guard is green on the simulated committed tree).

**Adversarial findings and dispositions.**

| # | Source | Finding | Severity | Disposition |
| --- | --- | --- | --- | --- |
| 1 | design review | The input reservation was computed from rows that could change between claim and start | Medium | The claim share-locks task and agent. The ceiling is measured after JSON escaping, with name and role counted twice. A driver test uses adversarial text and a concurrent edit. |
| 2 | design review | A billed 200 failure with no usage would be charged 0 | Medium | Zero requires no usage, no response id and no response model. The adapter contract is pinned for every non-2xx status. |
| 3 | design review | The ceiling sweep would trip a fleet-wide stop on in-flight reservations | Medium | It trips on settled spend only; contention raises `OS429` and records nothing. |
| 4 | design review | A system trip absorbed an owner's trip on the same target | Medium | `origin` is part of the target. |
| 5 | design review | A stalled worker held the fleet-wide spend lock | Medium | Idle-in-transaction timeout; the adapter survives a server-ended session. |
| 6 | design review | Usage inconsistencies (cached > input, and others) could drive a negative or low charge | Medium | The estimate is NULL unless usage is complete and consistent, and costs are CHECKed non-negative. |
| 7 | design review | Admission read "today" and dated runs on different clocks; isolation was assumed, not enforced | Low | Both use `now()`; READ COMMITTED is enforced. |
| 8 | design review | Job coordinates could come from a task's current department or assignee | Low | Only facts fixed at request time are used; unknown coordinates fail closed. |
| 9 | design review | A listed external kind registered as transactional would escape the pre-call check | Low | The registry classification is enforced in both directions. |
| 10 | design review | A time-zone change could move today's window | Low | A new version keeps the zone; changing it needs retire, then set. |
| 11 | design review | The new refusal codes could be recorded by a worker | Low | Five more reserved codes; `spend_limit_id` is tied to `budget_exhausted` by a CHECK and a guard. |
| 12 | design review | `routes` would read the operator's environment and push provider keys into operator shells | Low | Workers publish a key-free summary in their heartbeat. |
| 13 | SQL review (D1) | A missing tenant budget beside a contended ceiling failed on a constraint instead of being recorded | Medium | Fixed in the migration; test A12. |
| 14 | SQL review (D2) | The ceiling sweep lacked the row-security refusal | Low | `OS403`. |
| 15 | SQL review | A raw insert could create a `job_kind` stop on a kind that holds nothing | Low | The insert guard refuses it. |
| 16 | CLI review | `spend.exhausted` counted in-flight reservations | Low | `settled_micros` added; `exhausted` = settled ≥ limit. At the owner review it became `settledExhausted`, beside `newRunAdmission`, so a false value never reads as room to start (§2). |
| 17 | CLI review | The smoke took a spend lock before the kill-switch lock, in one transaction | Low | Configuration commits in its own transaction first. |
| 18 | CLI review | The operator test file was over 800 lines; two SQL/outcome branches had no tests | Low | Split; tests added and mutation-checked. |
| 19 | runtime review | A test file with raw NUL bytes was read by git as binary; two claimed properties were untested | Medium (test) | Fixed and mutation-checked. |
| 20 | guard run | A template literal in `money.ts` tripped the production-scope glob rule (the CI failure class from Phase 1D) | Blocking in CI | Rewritten as concatenation; the guard was run on a simulated committed tree. |
| 21 | SQL review | An owner's raw UPDATE may state a reservation; the guard checks only its shape and the price's model | Info | Kept: owner acts are outside the boundary (SI-22). ADR 0017 §2 is worded accordingly. |
| 22 | CLI review | Phase 1C length checks trim only spaces, so an owner can store over-long title, name or role | Info | Recorded: reservations still hold because they are computed from the real text. A raw-length CHECK is an owner decision. |
| 23 | driver review (D1) | A request for a task whose run is mid-prepare now waits for that prepare (the claim's share lock) | Info | By design, and bounded by the worker's statement and idle-in-transaction timeouts. A driver test proves the order in which the claim locks first: a retry of the run being prepared ("only a finished run can be retried") and a second `agent_run.execute` job for it ("already has its job") are refused once the start commits, and one run and one job remain. A request under a new idempotency key waits, then is admitted as its own run and job: a new request, not a duplicate. The reverse order is argued from the lock order (§3), not tested. ADR 0017 Consequences records it. |
| 24 | driver review (R) | Two ceiling sweeps racing could both answer "tripped", so a fleet would log one trip per worker | Low | The sweep answers with the stop only when its own transaction recorded it (`tripped_at = now()`); new two-session driver test, mutation-checked. |
| 25 | driver review (R) | SQL witnesses W1, W6 and W7 said "before reading the stops" but prove only that the lock is held afterwards | Low (test) | Messages reworded; the order is proven by two new two-session driver tests (killSwitchLease, preCallStopCheck). |
| 26 | final scan | A raw U+0001 byte in a comment of `runtime_governance.sql` made the suite read as binary data | Low (test) | Written as `<U+0001>`; no file this phase touches holds a control byte or a CR. |
| 27 | owner-review verification | Decision B was not met for an agent run whose job was leased before a trip: the start cancelled the run, the job spent its attempt, and nothing resumed after the clear | Blocking (against owner decision B) | Fixed in code: the start answers `stopped` and writes nothing, the handler reports `held`, and the runtime defers the job under the held lock (§4). SQL K3 (`agent_runtime.sql`), three driver tests (`externalCallDeferral`, `agentRunRuntime`, `agentRuns`) and unit tests; SI-31 and SI-37 restated. |
| 28 | owner-review verification | The admission precedence was worded as if a missing tenant budget always decided; beside a ceiling already exhausted, the ceiling's refusal wins | Wording | Precedence stated (§3); test A13 added. |
| 29 | owner-review verification | The spend-status field comments tied an exhausted refusal to `settled_exhausted` and called it the sweep's only condition | Wording | Fixed in the code comments and in §2; L11 matches a `blocked` row against admission. |
| 30 | owner-review verification | "Nothing takes the lock order in reverse" and "trip and clear take only the kill-switch lock" were literally false, although no lock cycle exists | Wording | Fixed: no path waits for an earlier lock while it holds a later one, and the non-blocking exceptions are listed (§3). |
| 31 | owner-review verification | The resuming text could be read as if a new day or a new ceiling version resumed execution on its own | Wording | Fixed: only a person clears the ceiling's stop; a new version must leave room above today's settled spend before the clear (ADR 0017 §5). |
| 32 | owner-review verification | `ops.lease_job` read the stops without the row-security refusal the other readers have, so an unreadable switch would lease held jobs | Low | `OS403` added; SQL G7 pins it in the four readers. |
| 33 | owner-review verification | Decision D rested on the absence of a code path, with no named regression guard | Low | SQL E8 added. |
| 34 | owner-review verification | An owner session opened outside `createWorkerDatabase` has no idle bound, so an open global limit change makes waiting starts time out and spend attempts | Info | Recorded (§13, item 14): make owner limit changes through `npm run ops`. |

## 9. Test counts

Final runs, 2026-09-17, after the owner-review changes and a clean reset. The "before" column is Phase 1D's CI run 35129049291.

| Suite | Result | Before |
| --- | --- | --- |
| Unit, `functions` project (engine, models, handlers, CLIs, static guards, invariants) | 54 files, **1414 passed** (1408 before the owner review) | 40 files, 1000 |
| Unit, `claude` project (`--exclude ".claude/worktrees/**"`) | 43 files, **494 passed**, 1 skipped | 494, 1 skipped |
| Unit, `app` project (real Chromium, run with no database work alongside) | 30 files, **234 passed**, 1 skipped (before the owner review; the review changed no file this project runs) | 234, 1 skipped |
| Database suites, `npm run test:db` | **11 passed**: `runtime_governance.sql` (new) plus the ten Phase 1D suites | 10 |
| Driver-backed suites, `npm run test:db:engine` | 28 files, **181 passed**, about 120 s (the owner review rewrote four cases and added none) | 6 files, 85 |
| Static migration guard and schema reproducibility | 131 + 12 = **143 passed** (inside the `functions` count) | 142 |
| Security invariants | **46 checks passed**: 38 invariants (SI-01 to SI-39, SI-07 retired), every enforcement marker present, the document in sync with the code | 41 |

**`runtime_governance.sql`** has 85 labelled cases, counted as the distinct labels its failure messages name (82 before the owner review, which added A13, E8 and G7; an earlier count of 75 missed the labels that appear only in refusal checks), in 11 sections: R (read committed), W (lock witnesses), P (prices), C (cost), L (limits), A (admission), K (kill switch), E (ceiling sweep), I (idempotency), G (grants and surface) and Z (nothing left behind). It runs in one transaction in about 3 s and rolls back.

**The driver set:**
- **The six Phase 1D files** now form ten, with 87 tests (85 before, plus 2): `workerRuntime` 21, `agentRuns` 14, `companyOs` 10, `agentRunRuntime` 9, `agentRunContracts` 8, `agentRunInterruptions` 6, `concurrency` 6, `pooling` 6, `agentRunHeldRuns` 4, `executionStopCli` 3. The split kept every test name.
- **18 new files, 94 tests:**

  | Area | Files |
  | --- | --- |
  | Pricing and cost | `spendSettlement` 17, `runtimeGovernanceMirrors` 5, `operatorCatalog` 3, `claimContext` 2 |
  | Budget and concurrency | `spendRefusals` 10, `spendAdmission` 3, `spendCeiling` 3, `spendCeilingInFlight` 2, `idleTransaction` 2, `spendCeilingRace` 1 |
  | Kill switch | `killSwitchLease` 15, `externalCallDeferral` 7, `executionStopOutcome` 3, `preCallStopCheck` 1 |
  | Domain idempotency | `domainIdempotency` 7 |
  | Operator CLI | `operatorReadOnly` 9, `operatorRuntime` 3, `operatorRoutes` 1 |

- **Twice, and nothing left behind.** The driver set passed twice in a row during the driver-proof review, and again on the final database.

**The new unit files (14):** `operator` 33, `operatorArgs` 51, `cliOutput` 14, `money` 60, `spendLimits` 37, `modelPrices` 34, `runtimeReadModelRuns` 23, `runtimeReadModel` 14, `runtimeReadModelRoutes` 11, `routeSummary` 15, `requestSize` 6, `jobKinds` 8, `workerDatabase` 8, `gatedModelProvider` 4. The existing files that grew: `executionStops` 72, `executionStop` 61, `openaiResponses` 75, `runOneJob` 63, `agentRunExecute` 47, `agentRunSmoke` 27, `runWorker` 26, `capabilities` 24, `companyOs` 17, `failures` 13, `main` 12.

**The tests the brief requires, and where each is proven:**

| Required | Proven by |
| --- | --- |
| Pricing lookup and version selection | SQL P; `operatorCatalog` (the version the next start records, before and after a newer one takes effect); `modelPrices.test.ts` |
| Cost calculation | SQL C (hand-checked arithmetic); `spendSettlement` (charges hand-computed per outcome); `money.test.ts` |
| Missing-price behaviour | SQL P and A; `operatorCatalog` (an expired latest version never falls back, and the run is refused `price_unavailable` with no call) |
| Daily budget enforcement | SQL L and A; `spendRefusals`; `spendCeiling`; `operatorRuntime` (settled exhaustion and the next start's admission reported separately, including a budget that is not exhausted but blocks) |
| Concurrent workers racing at the limit | SQL W; `spendAdmission` (two sessions, and a worker fleet held to the admissible number of calls); `spendCeilingInFlight`; `spendCeilingRace`; `idleTransaction` |
| Kill-switch interaction | SQL K and E; `killSwitchLease` (seven covering scopes, five non-covering, deny wins, internal kinds still run); `externalCallDeferral`; `preCallStopCheck`; `executionStopOutcome`; `spendCeiling` |
| Domain idempotency (same, different, concurrent) | SQL I; `domainIdempotency` (two sessions, rollback, another time zone, two tenants); `companyOs.test.ts` |
| No provider call on budget refusal | `spendRefusals` and `operatorCatalog`, which count calls on a gated provider |
| No regression to ADR 0016 at-most-once | `agent_runtime.sql` and the ten Phase 1D driver files unchanged in substance, including crashes through killed worker processes; `runOneJob.test.ts`; `externalCallDeferral` (called exactly once after a deferral) |
| Operator CLI read paths | `operator.test.ts`, `operatorArgs.test.ts`; `operatorRuntime`, `operatorReadOnly`, `operatorCatalog`, `operatorRoutes` against the real database |
| Cross-tenant isolation | SQL K and I; `killSwitchLease` and `externalCallDeferral` (a stop in another tenant holds nothing); `domainIdempotency` (independent keys per tenant); `spendRefusals` (one tenant's budget refusal beside another tenant's call); the Phase 1C/1D isolation suites unchanged |
| Data API exposure | `opsDataApiExposure.mjs`: 15 relations and 96 functions, 5 credentials, 705 requests, none reached `ops`; SQL G |
| Security and migration invariants | `securityInvariants.test.ts` 46; `migrationInvariants.test.ts` 131; `schemaReproducibility.test.ts` 12; the migration's 17 end-state assertions |

## 10. Mutation testing

Every load-bearing guard was broken on purpose, one at a time, and the named tests were run. Database mutants were applied to the local stack (or inside a rolled-back transaction) and restored. The restores were verified by function-definition md5, owner, grants, SECURITY DEFINER, configuration and comment; code mutants were restored from backups and compared byte for byte. Every restore verified.

| Campaign | Mutants | First result | Final |
| --- | --- | --- | --- |
| SQL suite author (stream A) | 19 migration functions, in a rolled-back transaction | 19 caught | 19 caught |
| SQL reviewer | 17 function mutants, plus grant and gate mutants | 4 test gaps, and one migration defect (finding 13) | all caught; defect fixed, test A12 |
| Runtime reviewer (stream B) | 22: savepoint placement, kind classification, request size, route parsing, tenant check, poisoned client, boot heartbeat, stop id, and others | 20 caught | 22 caught (2 tests added) |
| Domain and CLI reviewer (stream C) | 22: read-only transaction, `system:` prefix, trip outcome, key withholding, result columns, key validation, decimals, smoke configuration, held-job count, environment reads, price validity, and others | 20 caught (M5 trip outcome, M19 price expiry survived) | 22 caught (2 tests added) |
| Driver proofs D1 | 3: start without its lease re-check, lease without the stop filter, claim without its share locks | 3 caught | 3 caught |
| Driver proofs D2 | 9: admission without spend locks, input ceiling without its allowance or counting characters, sweep on charged spend, sweep on any limit version, sweep adopting an owner stop, zero charge ignoring the response id, claim without the task or the agent lock | 9 caught | 9 caught |
| Driver proofs D3 | 5: pre-call check always clear, deferral keeping the attempt, `create_task` without `ON CONFLICT`, no rollback to the savepoint, trip outcome ignored | 5 caught | 5 caught |
| Driver-proof reviewer R | 26 across admission locks, exhaustion versus contention, the claim, the lease filter and lock, deferral, idempotency, the sweep, zero charge, the pre-call lock, the savepoint, the idle timeout, the output ceiling and the ceiling tick | 7 survived the driver suites | 26 caught (6 tests added) |
| Lead, after R | 1: the sweep answers with a stop it did not record | caught by the new race test | caught |
| Owner review | 12. SQL (6): `spend_status` blocked on `>` instead of `>=` (L11), blocked on settled instead of charged spend (L11), the start ignoring a stop (K3), the lease reading an unreadable switch (G7), a missing budget checked before global exhaustion (A13), the sweep able to clear a stop (E8). TypeScript (6): the admission mapping accepting an unknown value, the handler settling a stopped start, the runtime rolling back before deferring a held job, the runtime ignoring a held prepare, a held deferral with no stop treated as deferred, the status claiming a ceiling that does not exist | 12 caught | 12 caught |

**What the survivors taught** (each closed by a test that fails for the right reason):
- **Lock order needs two sessions.**
  - The lease without its shared lock (R M4b) survived 84 driver tests. The lease taking the lock in the statement that reads the stops (M4d) passed SQL W1 too. The pre-call check had the same pair (M9a, M9b).
  - The new `killSwitchLease` and `preCallStopCheck` tests start a trip, hold it uncommitted, and prove that the worker waits and then sees it.
- **Exhaustion must win over contention.** Global contention could hide a tenant's exhaustion (M2b). The new `spendRefusals` test records `budget_exhausted` while another tenant's call contends the ceiling.
- **The zero charge needs its category list.** Without it (M8b), a failed run was charged 0 instead of 8290. Two `spendSettlement` tests now pin that.
- **What is sent must equal what is reserved.** A router sending twice the ceiling (T3e) survived the driver tests, which compared against the router itself. The new mirrors test compares against the database's route policy.
- **The trip outcome** is decided by the transaction clock (C M5 and the lead's race mutant); unit and two-session driver tests pin it.
- **The price listing's expired and future branches** (C M19) are pinned by unit tests and proven against the database by `operatorCatalog`.

**Not mutation-tested,** as recorded by the reviewers:
- the concurrent `record_event` path (only `create_task` was);
- an admission waiting for a settlement that raises a charge (SQL W4 checks only that the lock is taken);
- reasoning billed on top of output, and company limits, through real runs (both are covered by SQL C and L).

## 11. DB reset

**Final:** `npx supabase db reset --workdir .supabase-e2e --local` succeeded on 2026-09-17, applying every migration, including `20260917120000_runtime_governance.sql`, and the seed.
- **End-state assertions.** The migration's 17 end-state assertions passed; otherwise the apply would have aborted.
- **Copies in sync.** Before the reset, every file under `supabase/migrations/` was compared with its `.supabase-e2e` copy, with no difference.
- **Suites on the reset database.** The final `test:db` and `test:db:engine` runs above ran on it.
- **Nothing left behind.** After the final driver run, one query measured `jobs=0 job_events=0 agent_runs=0 execution_stops=0 model_prices=0 spend_limits=0 task_jobs=0 tasks=0 events=6 agents=2 companies=1 tenants=1 worker_instances=0`. That is the seeded development baseline, unchanged.

**The CI sequence, replayed locally:**
1. `db reset --no-seed`, then `referenceData.mjs --without-seed`. It passed, and asserted that no price and no limit exist.
2. A seeded reset, then `test:db`: 11 of 11.

**After the owner review (2026-09-17),** the whole sequence ran again on the final migration: the held start, the `lease_job` refusal, the `spend_status` columns and the corrected comments.
- The `.supabase-e2e` copies were re-synced and compared: no difference.
- A clean reset applied every migration, with its end-state assertions.
- `test:db` passed 11 of 11: 15 relations, 96 functions, 705 requests, none reached `ops`.
- `test:db:engine` passed 28 files and 181 cases.
- The leftover query read the same seeded baseline as above.
- `db reset --no-seed` and `referenceData.mjs --without-seed` passed again.
- A final seeded reset left the local database clean.

**During the phase:**
- **Revisions.** Every migration revision was applied through a clean reset before its suites ran.
- **A stale database.** The driver-proof review found the local database and the `.supabase-e2e` copy older than the migration file, differing only in `ops.enforce_spend_ceiling`. The copy was re-synced, the database reset, and the function body verified, and every suite was re-run.
- **The preflight.** The migration refuses to apply to a database where any agent run has started. A development database with smoke history is therefore rebuilt with a reset, not `migration up`. No hosted project exists.

**Manual smoke,** local only, on the reset database:
- `npm run worker:provision` created `ops_worker_login` (LOGIN, NOINHERIT, member of `ops_worker`, no BYPASSRLS).
- `npm run agent-runtime:smoke` (fake provider) configured its synthetic price and limits in their own transaction. It then ran one run to `succeeded`, with events requested, started and succeeded, a reservation of 166 and a charge of 2 micro-USD.
- `--live` skipped itself: no provider is configured, and no live call was made.
- `npm run ops -- status | spend | runs | prices | limits` showed that run and its governance. A wrong password printed only `{"error":"28P01",…}` and exited 1.
- The database was then reset again, before the final suites.

## 12. Build/guards

| Check | Result |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run scan:build` | 18 text files, **0 blocking, 0 advisory** |
| `node scripts/production-scope.mjs` | OK: 5 reviewed functions, reviewed dependencies only, no generic SQL endpoint, no development seed on a remote path |
| `node scripts/dev-signing-key.mjs` | development signing key confined to local tooling |
| `npm run typecheck` | exit 0 (covers `engine/`) |
| `npm run lint` | exit 0, **0 errors**; its 64 warnings are all in the stale, git-excluded `.claude/worktrees/loving-mendel-123ece` copy, none in the repository's own files |
| Prettier on every changed or new code and document file | 105 files, all formatted (SQL is outside Prettier, as before) |
| `npm run check:local-exposure` | OK: 19 containers, 16 published bindings, loopback only on Docker and on the host |
| Static migration guard | green inside `migrationInvariants.test.ts` (131): closed grammar, no worker write verb, grants as reviewed |
| Control bytes and CRs | none in the 109 files this phase touches (finding 26) |
| Key-shaped literals | none. The connection strings in touched tests are the pre-existing fixtures (`*.invalid`, TEST-NET or loopback hosts, placeholder passwords). |

**The tracked-file guards ran on a simulated commit.** Phase 1D's first CI run failed because its guards had been run while its files were untracked (PHASE_1D_REPORT §24). This time, both guards also ran against a copy of the git index to which every changed and new file under `engine`, `supabase`, `docs` and `scripts`, plus `package.json` and `CLAUDE.md`, was added (109 files after the owner review). The run caught finding 20.

The simulation did not touch the real index. The phase was committed afterwards, locally and not pushed (§13, item 2).

**The CI path is ready.** `check.yml` needs no change:
- **Driver suites.** `test:db:engine` picks up the new `*.dbtest.ts` files, and the fixture's `REQUIRED_MIGRATION` names this migration.
- **Clean-replay step.** The `--no-seed` step now also asserts that no price and no limit ships.
- **Unit suites.** The three projects run as before.

## 13. Remaining blockers

**Before Phase 2A handles REAL patient data:**
1. **BASELINE Q8, the LGPD processor question, is open and is an explicit blocker** (DECISIONS.md, ROADMAP 2026-09-17). Task and agent text leaves the database for the model provider. Before any real patient or clinical text may reach a model, the owner must decide:
   - the processor roles for each tenant;
   - the provider's retention and zero-data-retention status (`store: false` does not remove abuse-monitoring retention);
   - the DPA and DPIA;
   - the data classification of task text.

   Until then, Phase 2A is built and tested with synthetic data only. Nothing in this phase answers Q8 by assumption.

**Before this phase counts as closed:**

2. **CI has not run.** The phase is committed locally on `feature/runtime-governance`, in four commits (schema and domain; engine, CLIs and the driver-backed proofs (they compile only with the new start signature, so they ship with it); security invariants; documentation), and is not pushed. The owner pushes it; CI then has to show every check this phase touches green, with only the historical `e2e-test` and Prettier red. A local simulation of the committed tree is green on the tracked-file guards, but only CI proves the Linux side: real SIGTERM and SIGKILL, the absence of a `SUPABASE_DB_PORT`, and one stack.
3. ~~**Owner reviews:**~~
   - ~~ADR 0017 (Proposed);~~
   - ~~the ADR 0010 addendum (ADR 0010 is still Proposed);~~
   - ~~the ADR 0015 and 0016 addenda;~~
   - ~~four behaviour decisions:~~
     - ~~fail-closed configuration (no price, ceiling or budget means no run);~~
     - ~~held, not cancelled, jobs at the lease;~~
     - ~~requests waiting for an in-flight prepare;~~
     - ~~a spend-ceiling stop that stays until a person clears it.~~

   *(Done 2026-09-17, see "Owner review" above.)*
   - **ADR 0017** is accepted, with decisions A to D in its owner-review addendum: fail closed without a price, a ceiling or a budget; stopped jobs held or deferred, never cancelled; a bounded wait for a prepare in progress; a spend-ceiling stop that only a person clears.
   - **The ADR 0010 addendum** was reviewed. The owner did not decide ADR 0010, which stays Proposed.
   - **The ADR 0015 and 0016 addenda** stand as corrected, and both ADRs stay Accepted.
   - **Decision B** was not met by the code for a job leased before a trip. The code now meets it (§4).

**Before any deployment runs agents:**

4. **Governance configuration is required.** The migration ships no price and no limit, so every run is refused until the owner has done all three:
   - recorded a current price for the configured model (`npm run ops -- price record`);
   - set a global ceiling (`limit set --scope global`);
   - set each tenant's budget.

   Size the ceiling above (worker processes + 1) × the largest reservation that `npm run ops -- routes` reports. That figure assumes text within the Phase 1C length checks (item 17).

**Recorded residuals, not blockers:**

5. Agent and task budgets; a UI for stops and spend; a tool scope. None is needed yet.
6. The caller-declared `correlation_id` on the Phase 1C owner services (Appendix A item 7).
7. Owner acts stay outside the boundary: an owner's raw UPDATE can state a reservation, and an owner can erase today's runs, which frees today's budget.
8. The Phase 1C length checks trim only spaces.
9. Estimates are list-price estimates, not invoices; provider billing remains the reconciliation source.
10. Some test files remain over 800 lines, all of them already over it at HEAD:
    - `agent_runtime.sql` and `runtime_governance.sql` (SQL suites, by precedent);
    - `runOneJob.test.ts`, `agentRunExecute.test.ts` and `openaiResponses.test.ts`, whose fakes would have to move to `testSupport` first.
11. **A day-boundary flake window.** The spend driver suites read "today" in UTC, so a case that crosses 00:00 UTC while it runs could fail spuriously, on CI as locally. The remedy, recorded and not taken, is to give the fixture limits a time zone far from the moment the suites run.

**Recorded at the owner review (2026-09-17):**

12. **Request-time refusal under a stop.** A request made while a stop covers it is recorded `cancelled` / `refused` / `execution_stopped` and creates no job. No job exists yet, so the refusal is outside decision B, which is about work already admitted. *(Decided 2026-09-17: the owner confirmed this as decision E, recorded in ADR 0017's owner review. No code changed.)*
13. **The generic pre-call race.** For an external handler other than the agent run, a stop cleared between the pre-call check and the deferral makes the attempt fail through the transient path: one attempt is spent, and nothing is called (§4). The agent-run path cannot meet it.
14. **The owner-session idle bound.** Three kinds of transaction hold the global spend lock:
    - a start, only for the end of its transaction;
    - a settlement whose charge rises, for the rest of its transaction;
    - a global `set_spend_limit` or `retire_spend_limit`, for the rest of its transaction.

    Transactions opened through `createWorkerDatabase` (the worker and every `npm run` CLI) have the idle bound; an owner session opened elsewhere (psql, Studio) does not. If such a session leaves a global limit change open, every start waiting behind it fails at its `statement_timeout` (57014, transient). Each failure spends a job attempt, and after the last attempt the job fails and the run is recorded `failed` / `job_failed`. Make owner limit changes through `npm run ops`.
15. **Zero-priced reservations.** A zero reservation (a zero-priced model) is admitted under a limit that settled spend has exactly reached, so request time is then stricter than the start. No behaviour change.
16. **Deleting a price version.** A raw owner act can delete an unreferenced version. Deleting the latest one makes the previous version current again, like any owner act outside the boundary (SI-22). No CLI command deletes a price.
17. **The sizing figure.** `npm run ops -- routes` reports the largest reservation for text within the Phase 1C length checks. Those checks trim only spaces, so a name, role or title padded with edge spaces reserves more. Its own start still reserves for the real text, so the budget holds, but the reported figure is not an upper bound for it.

## 14. Exact proposed Phase 2A scope

> **Status (2026-09-17, owner):** the direction is accepted as **PHASE 2A — SYNTHETIC LEAD TRIAGE PILOT** (ROADMAP, owner review 2026-09-17). Where this list differs, the roadmap governs. The phase is not started; it waits for the Phase 1D.1 CI result and its own brief.

**Theme: one inbound lead is triaged by one agent, with a person in the loop, on synthetic data until Q8 closes.**

1. **Gate.** Before real data, all of these hold:
   - ADR 0017 is accepted, and Phase 1D.1 is CI verified *(ADR 0017 accepted 2026-09-17; CI pending)*;
   - Q8 is decided (until then, synthetic data only);
   - an ADR for the channel is accepted. WhatsApp Business Platform is the likely one, since the ROADMAP places it at Phase 8 with its own LGPD floor: rule 7 means that floor moves forward with it.
2. **Inbound ingress.** One externally triggered source, **read-only**: an edge function or webhook receives an inbound message, verifies the provider's signature, and records a minimised ledger row.
   - **The row holds** the message id, the channel, the sender reference and a pointer. It never puts the message body in an event.
   - **Idempotency:** keyed on the provider message id, with the SI-10 shape.
   - **It creates** a task through `ops.create_task` with an idempotency key derived from that message id. Retries converge (SI-38).
   - **It assigns** the task to a configured intake agent. The agent's configuration is data, not DDL.
3. **One new capability, `lead_triage`.** It gets:
   - a versioned prompt and a strict output contract, validated twice;
   - a `standard` route;
   - a price and limits configured by the owner.

   It is requested through `ops.request_agent_run`. The result stays advisory: a classification and a proposed reply draft, stored on the run and shown to a person.
4. **External kinds.** The ingress job kind is registered as external, with the job-kind stop and the pre-call check that Phase 1D.1 built. No integration-specific stop logic is added.
5. **Read-only CRM access.** A hand-written, minimal `CRMProvider` port (ROADMAP Phase 4 ordering note) provides contact lookup by sender reference, with no writes. The agent sees only the minimised fields the prompt needs.
6. **LGPD floor for what is ingested** (ROADMAP rule 7):
   - a retention window and a purge job (a transactional internal kind);
   - an erasure path that also clears derived run results;
   - `do_not_contact` and consent respected before any draft is shown;
   - a data classification for the ledger.
7. **Operator surface.** `npm run ops` gains the triage queue: runs awaiting a person, and their advisory output. There is still no UI.
8. **Tests.** Synthetic fixtures only:
   - signature verification;
   - duplicate delivery giving one ledger row, one task and one run;
   - kill switch and budget refusal before any provider call;
   - cross-tenant isolation;
   - a Data API probe of any new surface;
   - driver-backed end-to-end proofs;
   - mutation testing of the load-bearing guards.

**Explicitly not in Phase 2A:**
- outbound messages sent by an agent (a reply is a draft a person sends);
- CRM writes by agents;
- tools or the Tool Gateway;
- browser automation;
- memory or RAG;
- multi-agent delegation;
- autonomous loops, or runs triggered without the explicit request step;
- a UI, or isometric work;
- real clinical or patient text sent to a model while Q8 is open.

## Classification

**READY FOR PHASE 2A: synthetic data only. Verified locally; CI pending.**

**Why:**
- **Scope.** Every item in the brief is built.
- **Tests.** The required tests exist and pass, and so does every earlier suite.
- **Guards.** The load-bearing guards were mutation-tested, and every survivor is closed.
- **Resets.** A clean reset and the CI sequence pass locally.
- **Security.** No security invariant was weakened.

**What the classification does not cover:**
- **Real patient data.** It does **not** cover it. BASELINE Q8 blocks any real patient or clinical text from reaching a model (§13, item 1).
- **CI.** The phase is committed locally and not pushed. The classification becomes CI VERIFIED only after the owner pushes this branch, and CI shows every check this phase touches green, with only the historical `e2e-test` and Prettier checks red (§13, item 2).
- **Owner decisions.** The owner accepted ADR 0017 on 2026-09-17, with decisions A to D ("Owner review" above; §13, item 3). ADR 0010 stays Proposed. The owner also confirmed decision E on 2026-09-17: a request made under a stop is refused before any job exists (§13, item 12). No owner decision is pending for this phase.
- **Phase 2A scope.** The owner accepted the direction as PHASE 2A — SYNTHETIC LEAD TRIAGE PILOT (ROADMAP, owner review 2026-09-17). Where §14 differs, the roadmap governs.

**Phase 2A has not been started.**
