# ADR 0017 — Runtime governance: versioned prices, bounded spend, one kill switch for every external job

**Status:** Accepted (2026-09-17, owner review, with the addendum at the end of this record). Proposed 2026-09-17 · **Date:** 2026-09-17 (Phase 1D.1)
**Implemented by:** `supabase/migrations/20260917120000_runtime_governance.sql`, `engine/worker/externalCall.ts`, `engine/handlers/agentRunExecute.ts`, `engine/worker/jobKinds.ts`, `engine/domain/modelPrices.ts`, `engine/domain/spendLimits.ts`, `engine/domain/runtimeReadModel.ts`, `engine/cli/operator.ts`

## Context

Phase 1D ([ADR 0016](0016-agent-runs-and-model-providers.md)) lets one agent call a model once about one task. It records usage but no cost, because no versioned price source existed. [ADR 0010](0010-cost-control-and-kill-switch.md) Decisions 3 and 4 (budgets and a global daily spend ceiling) stayed owed. Its addendum also left the kill switch checking agent runs only: nothing held any other job at the lease.

The next major phase connects the runtime to a real business flow, with externally triggered jobs and integrations that retry. Before that, four gaps close:

- **Cost:** a run's spend must be computable and auditable, never invented.
- **Spend:** a daily ceiling must refuse a new call before it is made. Two workers racing at the limit must not both spend.
- **Stops:** the one kill switch must hold any external job, not only agent runs, without a second switch.
- **Retries:** a retried Phase 1C create must not duplicate business work (PHASE_1C_REPORT Appendix A item 8).

Five facts shaped the decisions. Each was read from the code on 2026-09-17.

- **At-most-once needs a durable start before the call** (ADR 0016 §3). A budget check that is to prevent a call must therefore live in the transaction that commits `running`: `ops.start_agent_run`.
- **Under READ COMMITTED, a summed total is a stale read.** Two starts that each read "spent 4.95 of 5.00", and each reserve 0.09, would both admit. They must be serialised.
- **A run's reported usage is not always final.** An `indeterminate` run may have been billed for more than it reported, or reported nothing.
- **A lease consumes an attempt** (`ops.lease_job` increments `attempts`). A stop enforced by leasing and then failing a job would retire it. ADR 0010's Phase 1C addendum requires a settlement that consumes none.
- **Token bounds.**
  - For the OpenAI Responses API, `max_output_tokens` includes reasoning tokens.
  - A byte-level tokenizer never emits more tokens than its text has UTF-8 bytes.
  - So a request's output is bounded by its route policy, and its input by the size of its serialised text plus framing.

## Decision

### 1. Prices are versioned owner data, never constraints and never migration rows

`ops.model_prices` holds one immutable row per price version:

- `provider` and `model`;
- USD per million input tokens, cached-input tokens and output tokens;
- whether reported reasoning tokens are already inside output tokens;
- `effective_from` and `expires_at`;
- `source`, `recorded_by` and `recorded_at`.

**Recording is an owner act** (`ops.record_model_price`, `npm run ops -- price record`). No migration ships a price: a shipped price would be stale on arrival, a number nobody checked. Tests use synthetic prices. The recording service and the CLI refuse a rate with more than six decimals rather than round it; a raw owner insert into the `numeric(14,6)` column would round.

**Versions are unique** per `(provider, model, effective_from)`. Replaying the same version returns it. A different version at the same moment is refused, so a correction is a new version with a later `effective_from`.

**The database chooses the price** at start. It takes the version with the latest `effective_from` at or before the start.

- **No stale price.** If that version has reached `expires_at` (a version prices runs only while `now()` is before it), there is no price, and nothing falls back to an older version. `expires_at` is at most 366 days after `effective_from`, so a price must be re-confirmed, as a new version, at least yearly.
- **No price, no call.** A run with no current price is recorded `cancelled` / `refused` / `price_unavailable` before any call.

**The price is keyed on the configured model id.** A route should name a pinned snapshot. The operator CLI shows each run's requested and reported model side by side, so a moved alias is visible.

**Immutability.** A version is immutable (an `ENABLE ALWAYS` guard), and a version any run references cannot be deleted. An unreferenced version can still be deleted by a raw owner act. Deleting the latest one makes the previous version current again, unless that one has expired, like any owner act outside the boundary (SI-22). No CLI command deletes a price.

### 2. The database derives cost; the worker only reports usage

`ops.agent_runs` gains `price_id`, `reserved_cost_micros`, `estimated_cost_micros`, `charged_cost_micros` and `spend_limit_id`. Money is `bigint` micro-USD and rates are `numeric`. Each cost is one exact expression, rounded up once.

No column is ever taken from the worker:
- **The price version and the reservation** are derived by `ops.start_agent_run`. The run guard requires both at start, requires the version to be one of the run's own provider and model, and fixes both from then on. An owner's raw UPDATE that states other values is, like every owner act, outside the boundary (SI-22, SI-23).
- **The estimate and the charge** are derived by the run guard on every write path, an owner's raw UPDATE included.

| Column | Set when | Value |
| --- | --- | --- |
| `price_id` | the run starts | the version chosen at start, fixed for the run's life; it must be the version of the run's own provider and model |
| `reserved_cost_micros` | the run starts | the worst case: the input ceiling times the input rate (cached input is never assumed), plus the route's output ceiling times the output rate (counted twice when reasoning is billed separately) |
| `estimated_cost_micros` | the run finishes | usage times the recorded version, only when the usage is **complete and consistent**: input and output known, cached ≤ input, reasoning ≤ output (or known, when billed separately), and a reported total ≥ input + output. Otherwise NULL |
| `charged_cost_micros` | the run starts, and again when it finishes | what counts against budgets, decided status first (below) |

**How the charge is decided:**

- **`running`:** the reservation.
- **`indeterminate`:** the greater of the reservation and the estimate. Usage, even when reported, is not proven final.
- **`succeeded` or `failed` with an estimate:** the estimate.
- **`failed` with proof that no response body arrived:** 0. The proof is all of these:
  - a refusal category (`authentication`, `invalid_request`, `configuration` or `rate_limit`);
  - no usage;
  - no provider response id;
  - no response model.

  Provider adapters record a response model for every 2xx answer whose body they parse (the requested model when the body names none), a response id only when that body carries a well-formed one, and neither for an HTTP refusal. The adapter contract tests pin this. A 2xx whose body cannot be read or parsed carries neither, but its outcome is `unknown`, so the run is `indeterminate` and charged at least its reservation. A 200 with a terminal `failed` status always carries a response model, so it is never charged 0.
- **Anything else:** the reservation.

**Where the bounds come from:**

- **The output ceiling** is the database's own route policy, `ops.agent_run_route_policies()`. It is mirrored by `MODEL_ROUTE_POLICIES` and asserted equal by a driver-backed test. The worker reports the ceiling it will send, and a disagreement is refused as `route_policy_mismatch`.
- **The input ceiling** is computed by `ops.start_agent_run` from the task and agent rows that `ops.claim_agent_run` returned. The claim share-locks those rows for the rest of the prepare transaction, so no edit can shorten the text between claim and start. The size is taken after JSON escaping, never as raw field bytes:
  - the jsonb text of the full, untruncated context;
  - plus the escaped name and role again, because the instructions quote them;
  - plus an 8192-token allowance for instructions, schema and framing.

  The worker never supplies the size. A driver-backed test with adversarial text (control characters, quotes, backslashes, 4-byte characters, over-long fields) proves the real request stays under the ceiling.

**A charge above its reservation means a bound was wrong.** When a settlement would raise a charge, the update guard first takes the spend locks (§4).

### 3. Spend limits are versioned owner data, and absence refuses

`ops.spend_limits` holds versioned daily limits:

- a `scope`: `global`, `tenant` or `company`;
- a target;
- `daily_limit_micros`;
- an IANA `timezone` for the day boundary;
- who set it and why.

**Changing a limit:**

- Setting a new value supersedes the active version (`ops.set_spend_limit`). Setting the same value changes nothing.
- A new version keeps the time zone. Changing the zone is a deliberate retire-then-set, because a new zone moves today's window under spend already counted.
- Retiring is a recorded act (`ops.retire_spend_limit`).
- An active version is never deleted, and a version is never rewritten except to redact free text.

**What each scope means.** The global limit is ADR 0010's daily spend ceiling. The tenant limit is the tenant's daily budget. A company limit is optional, and is organisation only, not isolation (ADR 0015 owner decision 2).

**Fail closed.** A run starts only when a global ceiling **and** its tenant's budget are configured. Without either it is always refused, never admitted. A company limit is optional. The code recorded for a refusal follows the admission order below.

**"Today"** runs from each limit's local midnight in its own zone. It is computed from `now()`, the same transaction timestamp the run records as `started_at`, so a start that waits across midnight is checked and counted on the same day.

**Admission** walks the scopes in the order global, tenant, company, and stops at the first refusal. For each scope, the limit must first exist (global and tenant are mandatory; a missing company limit is skipped). Then the run's reservation is compared with two totals: settled spend (runs no longer `running`), and all charged spend (which adds the reservations of calls in flight). A contention is remembered, and returned only when no later scope refuses. So:

- no global ceiling: `spend_ceiling_unconfigured`;
- a global ceiling already exhausted for this reservation: `budget_exhausted`, naming the global version, even when the tenant budget is also missing (SQL A13);
- otherwise, no tenant budget: `budget_unconfigured`, which wins over contention on the global ceiling (SQL A12);
- `budget_exhausted` names the **first** exhausted limit version in that order.

| Result | When | What happens |
| --- | --- | --- |
| `spend_ceiling_unconfigured` / `budget_unconfigured` | the global ceiling, or the tenant budget, is missing when its scope is reached | recorded `cancelled` / `refused`, naming no limit. It wins over contention on an earlier scope |
| `budget_exhausted` | settled + reservation > limit, for the first such limit | recorded `cancelled` / `refused`, naming the limit version. Exhaustion is final for the day under that limit version, so it wins over contention. A raised tenant or company budget re-admits the same day; a raised global ceiling still needs its system stop cleared by a person (§5) |
| `budget_contended` | every mandatory limit exists and settled + reservation fits every limit, but charged + reservation does not fit at least one | **not recorded**. The start raises `OS429`, the prepare rolls back, and the job retries on its backoff, because calls in flight settle within their own deadlines |
| admitted | every limit absorbs the reservation | the run starts |

**Request time** refuses early, with no job, when a limit is missing or already exhausted by settled spend. Contention never refuses a request. Start time is authoritative.

**A zero reservation** (a zero-priced model) is admitted at start under a limit that settled spend has exactly reached, while request time refuses it: request time is then stricter than the start. Recorded; no behaviour change.

**What the operator sees.** `ops.spend_status()` (`npm run ops -- spend`, and the spend part of `status`) returns one row per active limit. Two of its fields were clarified at the owner review; neither promises a start:

- `settled_exhausted` (`settledExhausted`, renamed from `exhausted`): settled spend has reached the limit. On the global row, the ceiling sweep trips when it is true **or** when `refused_runs` > 0 (§5). A false value never means a run can start, nor that the sweep will not trip.
- `new_run_admission` (`newRunAdmission`):
  - `blocked` when charged spend has reached the limit: no run with a reservation above zero is admitted by this limit. A run that settled spend cannot absorb is refused `budget_exhausted` even when `settled_exhausted` is false, and on the global ceiling that refusal trips the ceiling stop. Any other run is contended: its start raises `OS429`, and its job retries on its backoff, which may end in admission, in exhaustion, or in job failure after the last attempt (five by default);
  - `conditional` otherwise: this limit admits a run only if its reservation fits `remaining_micros`. The price, every other applicable limit and the stops still decide, and it says nothing about a limit that does not exist.
- A missing limit has no row. `status` therefore lists tenants without a budget, and reports `globalCeilingConfigured`: without an active global ceiling, every run is refused `spend_ceiling_unconfigured`, and the status says so explicitly.

The budget model itself is unchanged.

### 4. Concurrency: per-scope locks, taken in a fixed order, before the read

`ops.start_agent_run` takes a transaction advisory lock exclusively for each scope, in the order global, tenant, company, each in its own statement. Only then does it read totals.

- **Why this is safe.** Under READ COMMITTED each later statement takes a fresh snapshot, so a start that waited sees every reservation committed before it. Two workers racing at a limit therefore admit at most what the limit allows.
- **The isolation premise is enforced.** `ops.start_agent_run`, `ops.request_agent_run`, `ops.spend_admission` and `ops.lease_job` refuse any level other than READ COMMITTED. `ops.start_agent_run` refuses before it reads stops, prices or spend totals; its early branches for a run that is not pending read none of them.
- **Namespace.** The spend locks use the two-key form, apart from the kill-switch lock.
- **The lock order** of a prepare (claim, then start) is: the job (share), the run, the task and agent (share), company and department (share), the kill-switch lock (shared), then the global, tenant and company spend locks. No path **waits** for a lock earlier in this order while it holds a later one:
  - **Trip** share-locks its target's tenant, company, department and agent rows, then takes the kill-switch lock exclusively. **Clear** takes the kill-switch lock exclusively, then its own stop row, which is not a lock of the chain. Neither waits for a lock of the chain after the kill-switch lock (trip's foreign-key checks re-lock only rows it already holds), and trip's row locks are FOR SHARE, as the start's are.
  - **Setting or retiring a limit** takes no advisory lock other than its own scope's spend lock, then its limit row.
  - **The ceiling sweep** takes only the kill-switch lock, through a global trip that names no row.
  - **The request path** takes the task FOR UPDATE, then the agent, company and department FOR SHARE, then the kill-switch lock shared, and no spend lock. Its only later run-row locks are on its own new run or on a finished retry parent, which a claim never pairs with a task lock.
- **Non-blocking exceptions to the literal order.** None of these can wait on another transaction:
  - a lock the transaction already holds (the request's task and company, the pre-call check's job and kill-switch lock);
  - `ops.lease_job`'s SKIP LOCKED job rows;
  - the lease holder strengthening its own job-row lock in `ops.defer_job` and `ops.complete_job`;
  - a row the transaction just inserted;
  - the bridge locking a pending run that has no job.
- **Settlement.** It lowers a charge from reservation to estimate without a lock, because a lower value only makes a concurrent admission more conservative. It raises a charge only after taking the spend locks.
- **The global spend lock serialises every start fleet-wide.** A worker that stalls with it held would stall every tenant. Every transaction opened through `createWorkerDatabase` (the worker and every `npm run` CLI) therefore sets `idle_in_transaction_session_timeout` (10 s), which bounds the time between statements. The lease safety margin is also 10 s today. The idle bound should stay at or below the margin, and nothing enforces that relation. A stalled holder's session is ended, its start rolls back uncommitted, and no call follows.
- **The spend locks are the last locks a start waits for by name.** Only the lease re-check and the `running` (or refusal) write follow, in the same statement. That write's foreign-key checks take FOR KEY SHARE on the price version (and, for a refusal that names one, the limit version) it references, and these never conflict with an ordinary writer. A wait inside that statement is bounded by the worker's `statement_timeout` (30 s by default), not by the idle timeout.
- **A call already in flight is never interrupted** because the budget was crossed during it. Its outcome is recorded, and the next start sees the total.

### 5. The global ceiling trips the existing kill switch, on settled spend

`ops.enforce_spend_ceiling()` runs on the worker's reaper tick, in its own transaction. It trips a **global execution stop** through `ops.trip_execution_stop`, as actor `system:spend_ceiling`, when the active ceiling **version** is exhausted by settled spend. That happens when either:

- its settled total today has reached the ceiling; or
- it refused a run today as `budget_exhausted`, a refusal contention never records.

**It never trips on in-flight reservations**, so one oversized burst of concurrent calls cannot halt the fleet.

**Resuming.** Nothing but a person clears the ceiling's stop (ADR 0010, owner decision D). A new day, a new ceiling version, a new price or lower spend leaves it active, and it keeps holding every non-internal job until a person runs `npm run execution-stop -- clear --id <stop> --reason <text> --actor <label>`. Clearing is only half of resuming: while the version in force is still exhausted, the next reaper tick trips a new stop. So, in order:

1. End the exhaustion, in one of two ways:
   - record a new ceiling version (a different amount, same time zone) whose room above today's settled spend covers the largest reservation a start can make (`npm run ops -- routes`). Refusals by the older version stop counting, but today's settled spend still counts, and a start the new version cannot absorb is refused `budget_exhausted` and trips the stop again;
   - or wait for the ceiling's next day, in its own time zone.
2. Then clear the stop.

A run whose reservation still fits can start between a clear and the next tick.

**A tenant or company budget only refuses; it never trips a stop.** A tenant therefore resumes the next day without a human act.

**Sizing rule, recorded.** The global ceiling should comfortably exceed (worker processes + 1) × the largest reservation a run can make. `npm run ops -- routes` reports, for each route that one of the 50 most recently seen workers published, the largest reservation a run whose text is within the Phase 1C length checks can make under the current price. Those checks trim only spaces, so a name, role or title padded with edge spaces reserves more. Its own start still reserves for the real text, so the budget holds, but the reported figure is not an upper bound for such a run.

**Stop origin.** `ops.execution_stops.origin` is derived from the actor (`system:` prefix → `system`, else `owner`) and is part of the one-active-stop-per-target key. A system stop and an owner's incident stop on the same target are therefore separate rows:

- clearing one never clears the other;
- an owner's trip is never absorbed by a system one;
- the sweep treats only an active **system** global stop as already tripped.

**The `system:` actor prefix is reserved.** The owner tools (`engine/domain/executionStops.ts`, behind `npm run execution-stop`) refuse it for trip and for clear. The database relies on owner-only EXECUTE, and on having no automated caller of `ops.clear_execution_stop`.

The stop CLI reports `already_stopped`, with the existing actor, when a trip found a stop instead of recording one. The sweep takes no lease and no argument, and it can only subtract capability.

### 6. One kill switch, held at the lease and before every external call

**Every job kind is classified, and the classification is total.**

- `ops.external_job_kinds()` returns exactly `{agent_run.execute}`.
- `ops.internal_job_kinds()` returns exactly `{postmark.ledger_retention}`.
- `engine/worker/jobKinds.ts` mirrors both, and a driver-backed test asserts equality.
- The worker refuses a registry in which an external kind is not an `external_call` handler, or an internal kind is not a transactional one. An external side effect is made only from an `external_call` handler's `call` phase.

**A stop can name one external kind.** The new scope `job_kind` stops every job of one external kind, for one tenant or for all. It is the generic form of ADR 0010's integration scope, and the kind is part of the stop's target.

- Tripping it for a kind that is not external is refused, so a stop can never look active while holding nothing.
- No integration-specific logic exists.

**One evaluator.** `ops.execution_stop_covers` is the one predicate, and `ops.covering_execution_stop` applies it with deny-wins. `ops.active_execution_stop` delegates to it for agent runs, and the run guard uses the same predicate.

**A job's coordinates** are only those fixed when it was requested:

- an agent run's company, department and agent; or
- the company of the requesting task.

No coordinate is read from a task's current department or assignee. **An unknown coordinate fails closed:** a company, department or agent stop covers any job in its tenant whose own coordinate is unknown, provided every coordinate the job does know matches. An agent run knows all of them, so for it matching is exact. Internal kinds are never held: administration stays up.

**Lease time.** `ops.lease_job` takes the kill-switch lock shared, in its own statement, then skips every queued job whose kind is not internal and that an active stop covers. The job stays `queued` and consumes no attempt: this is ADR 0010's "no new job is leased". Like every other reader of the switch, the lease refuses (`OS403`) when row security would hide the stops, so an unreadable switch leases nothing.

The cost of the check scales with the kind of stop:

| Active stops | Cost per queued job |
| --- | --- |
| none | nothing |
| a global stop | one comparison |
| tenant or kind stops | a read of the stop table |
| organisational stops | a lookup of the job's coordinates |

**Before the call.** The `external_call` runtime opens a savepoint before the handler's prepare. A prepare returns one of three outcomes:

- **`settled`:** it commits as it is, with no stop check, and the job completes. What the handler recorded stays recorded.
- **`held`:** the handler's own gate found a covering stop and wrote nothing. The runtime releases the savepoint (there is nothing to discard) and calls `ops.defer_job()` in the same transaction, while the kill-switch lock that gate took is still held, so the stop cannot be cleared in between. If the deferral finds no covering stop, the two readings disagree: the whole prepare rolls back, and the attempt fails through the transient path. Nothing is called either way.
- **`call`:** the runtime asks `ops.job_execution_stop()`, a stop id or NULL, and fails closed on any other answer. If a stop covers the job, the runtime:
  1. rolls back to the savepoint, discarding the handler's durable start;
  2. calls `ops.defer_job()`;
  3. commits, and calls nothing.

**`ops.defer_job()`** takes no argument and is lease-bound. It re-takes the kill-switch lock shared and re-evaluates the stops.

- **When a stop covers the job,** it:
  - returns the job to `queued`;
  - restores exactly the attempt this lease added;
  - delays it 30 seconds;
  - records a `deferred` job event naming the stop;
  - returns the stop.
- **When no stop covers it** (one was cleared meanwhile), it changes nothing and returns NULL. The runtime then fails the attempt through the normal transient path.

On the `call` path this leaves a known edge: a stop cleared between the check and the deferral makes the attempt fail through the transient path, so an attempt is spent although nothing is called. Recorded as a residual.

**For agent runs, the `held` path is the one that fires** (owner decision B). `ops.start_agent_run` evaluates the stops under the shared kill-switch lock. When one covers the run, it answers `stopped` and writes nothing, before any other gate is evaluated: the run stays `pending`, with no `stop_id`, no error code, no price and no charge. The handler maps `stopped` to `held`. Because the start still holds the kill-switch lock when the job is deferred, the agent run path cannot meet the `call` path's edge. The `call` path's check stays the generic guarantee for future handlers.

**What changes for agent runs:**

- A run whose job was leased **before** a trip is held at start, and its job is deferred: it returns to `queued` with its attempt restored, 30 seconds later, with a `deferred` job event naming the stop. While the stop stays active, the lease holds the job. After an explicit clear, the next lease runs the **same** run, and its start checks every gate again.
- A run whose job was **not yet leased** is held at the lease, and runs once the stop is explicitly cleared. Its start then re-checks every gate.
- Request-time refusal is unchanged, by owner decision E (owner review, below): a request made while a stop covers it is recorded `cancelled` / `refused` / `execution_stopped`, naming the stop. No job is created, the provider is not called, and nothing is deferred. A stop before admission refuses new work; a stop after admission holds the work already admitted.
- `execution_stopped` stays reserved, and is still used at request time.
- A call in flight is still never interrupted.
- After a deferral, attempt numbers repeat. At-most-once is unaffected, because a deferred attempt leaves no durable start behind: a `held` start wrote none, and the `call` path discards its own.

### 7. Phase 1C creates that retries will reach are idempotent

`ops.create_task` and `ops.record_event` gain an optional `p_idempotency_key`, following the ADR 0016 §5 pattern.

- **The key** is tenant-scoped.
- **The fingerprint** covers the semantic request, and is derived by an insert trigger from the stored row, never supplied on any non-owner path (an owner's raw insert in replica mode is outside the boundary, as in §2). It is sha256 of a JSON array, an unambiguous encoding, with the due date as epoch seconds so the session time zone cannot change it. The service computes the same fingerprint from its arguments to compare.
- **Same key, same request:** the existing id is returned, with no second row and no second fact.
- **Same key, different request:** refused with `OS409`.
- **Concurrent duplicates** converge through `INSERT … ON CONFLICT DO NOTHING` on a partial unique index, then a re-read and compare.
- **The key and fingerprint are fixed once stored.**
- **Optional, not required.** A caller without a key keeps today's behaviour. The future wrapper contract (ADR 0015 §4) requires one from every integration.

**Not changed:**

- `create_company`, `create_department` and `create_agent` already refuse a retry through their slug keys (`duplicate`). They do not duplicate work, and onboarding is not an integration retry path.
- Transitions cannot duplicate work: the state machine refuses them.
- The caller-declared `correlation_id` residual (Appendix A item 7) is recorded, not closed.

### 8. The external_call flow is its own module

The prepare / call / settle flow moves out of `engine/worker/runOneJob.ts` into `engine/worker/externalCall.ts`. The shared attempt helpers move into `engine/worker/attempt.ts`.

The extraction is behaviour-neutral, and the existing unit, driver and mutation suites prove that. The pre-call stop check and the `deferred` outcome are separate, additive changes on top of it, each with its own tests.

### 9. An operator CLI, read-only by default

`npm run ops -- <command>` runs over the owner connection.

**Read-only commands:** `status`, `stops`, `routes`, `prices`, `limits`, `spend`, `runs` and `indeterminate`.

- They run inside a read-only transaction.
- They print ids, statuses, categories, codes, token counts and costs.
- They never print a result, prompt or task text, a connection string or a key.
- **The CLI never reads routing or provider variables from its own environment.** `routes` reports what the database can observe:
  - the route summary (provider, model and output ceiling per tier) published by each of the 50 most recently seen workers, stopped and crashed ones included, which the worker writes into its heartbeat detail and which never holds a key. Each row carries `lastSeenAt` and `stoppedAt`, so liveness is the operator's judgement, not a filter;
  - the database's route ceilings;
  - whether each route's model has a current price, and the largest reservation a run on it can make when its text is within the Phase 1C length checks (§5).

  The provider key and the owner connection string therefore never need to share a process.

**The only mutations** are three explicit, narrow subcommands:

- `price record`;
- `limit set`;
- `limit retire`.

Each needs `--actor` and a reason or source, and parses amounts as exact decimals. Tripping and clearing stops stay in `npm run execution-stop`, which gains the `job_kind` scope.

### Schema changes that need care

- `ops.job_events`' event CHECK gains `deferred`. This departs from the Phase 1B note that new information travels in `detail`: a deferral neither fails nor consumes an attempt.
- Several signatures change, and each old one is dropped before the new one is created:
  - `ops.create_task` (12 → 13 arguments);
  - `ops.record_event` (9 → 10);
  - `ops.trip_execution_stop` (7 → 8);
  - `ops.start_agent_run` (4 → 5; the output ceiling has no default).

  The migration asserts that each has exactly one overload.
- `ops.start_agent_run` gains the answer token `stopped` (owner review): a covering stop writes nothing, and only `running` still means call.
- `ops.claim_agent_run` keeps its signature and gains share locks.
- `ops.lease_job` keeps its signature and return type. It refuses (`OS403`) when row security would hide the stops.

## Alternatives

- **Prices in a migration, as reference data** (the PHASE_1D_REPORT §28 proposal). Rejected: ADR 0016 rejected prices in migrations, and a migration row is a price nobody re-checked.
- **Prices in code or environment.** Rejected: they would not be versioned, and the database that enforces the budget could not see them.
- **Cost computed in the worker.** Rejected: the worker would assert its own spend. The database has the price and the usage.
- **A per-day counter row instead of a sum over runs.** Rejected for now: counters drift and need their own guards, while the sum runs over an index and volumes are small.
- **Charging an unknown outcome at zero, or charging 0 for every failed run without usage.** Rejected: an `indeterminate` run, or a 200 that reports failure, may have been billed.
- **Treating "no budget configured" as unlimited.** Rejected: CLAUDE.md rule 4.
- **Cancelling a run refused only by contention.** Rejected: calls in flight settle within their deadlines, so a permanent cancel would be a false refusal. The job retries instead.
- **Tripping the ceiling stop on any refusal, or on reservations in flight.** Rejected after adversarial review: one burst of concurrent calls would halt every tenant until a person cleared the stop, not only for the day, and a trip on such a refusal would trip again after any clear, until the next day or a new ceiling version.
- **Tripping the stop inside `start_agent_run`.** Rejected: the start holds the kill-switch lock shared, and upgrading it to exclusive can deadlock two starts.
- **Tenant budgets tripping tenant stops.** Rejected: a daily budget resets daily, and a stop needs a human to clear it.
- **Refusing a stopped job at lease by failing it.** Rejected: it consumes an attempt and retires the job (ADR 0010, Phase 1C addendum).
- **A second, integration-specific switch.** Rejected by the brief: one switch, one evaluator.
- **Cancelling a run whose job was leased before the trip** (the start records `execution_stopped`, and the job completes on that attempt). This was the proposed behaviour, which kept ADR 0016 §11's record of start-time refusals. Rejected by owner decision B at the owner review: a stop holds work, it never ends it, and clearing the stop must let the same work run. The start now answers `stopped`, and the job is deferred (§6).
- **Deriving job coordinates from a task's current department or assignee.** Rejected: they change. Unknown coordinates fail closed instead.
- **Idempotency on every Company OS table.** Rejected by the brief: only the creates that future integrations will retry.

## Consequences

- **Every agent run now needs governance configuration:** a current price for its provider and model, a global ceiling, and its tenant's budget. A deployment without them refuses every run, and the run row says why.
- **The worker's pinned surface grows by three functions:** `job_execution_stop`, `defer_job` and `enforce_spend_ceiling`. `start_agent_run` gains a parameter and the answer token `stopped`, and `claim_agent_run` gains share locks. The worker is now granted twenty pinned function signatures (it calls eighteen), five of which check no lease.
- **Admission is serialised fleet-wide** by the global spend lock. A start holds it only for the end of its transaction. A settlement whose charge rises, and a global `set_spend_limit` or `retire_spend_limit`, hold it for the rest of theirs.
  - Transactions opened through `createWorkerDatabase` (the worker and every `npm run` CLI) have the idle bound. An owner session opened elsewhere (psql, Studio) does not.
  - If such a session leaves a global limit change open, every start waiting behind it fails at its `statement_timeout` (57014, transient). Each failure spends a job attempt, and after the last attempt the job fails and the run is recorded `failed` / `job_failed`.
  - Recorded residual: make owner limit changes through `npm run ops`.
- **A stopped external job waits in the queue** until its stop is explicitly cleared, then runs, without consuming an attempt and without calling the provider (owner decision B). This now holds for agent runs too: a job not yet leased is held at the lease, and a job leased before the trip is held at start and deferred, so the same run starts after the clear. A deferred job is offered again only after 30 seconds, and the lease passes it over while the stop stays active, so it does not spin. A request made while a stop covers it is still refused, with no job.
- **A request for a task whose run is being prepared waits for that prepare** (owner decision C). The claim share-locks the task, and a request takes it for update. The wait is bounded by the worker's idle-in-transaction and statement timeouts. Once the start commits:
  - a retry of the run being prepared is refused ("only a finished run can be retried");
  - a second `agent_run.execute` job for that run is refused ("already has its job");
  - only one run and one job exist afterwards. A driver-backed test (`agentRunHeldRuns.dbtest.ts`) proves this in the order where the claim locks first;
  - a request under a **new** idempotency key waits, then is admitted as its own run and job: a new request, not a duplicate.

  The reverse order (a request holds the task first) is argued from the lock order (§4), not tested. The claim then waits holding only its job (share) and its own run row, which no request locks, and its wait is bounded by the worker's statement timeout. Phase 1D's lock-free refusal (AR-07) now holds only while a call's result is being settled.
- **A run refused by contention retries on its job's backoff.** After five attempts its job fails, and the sweep records the run as `failed` / `job_failed`.
- **Estimated cost is an estimate:** usage times a recorded list price. Provider invoices remain the reconciliation source (ADR 0010 Alternatives).
- **Reservations assume the token bounds in the Context.** A provider whose tokenizer or billing breaks them needs a different ceiling function before it is priced.
- **Erasing today's agent runs frees today's budget.** Erasure is an owner act, and the owner can raise a ceiling anyway; recorded, not guarded.

---

## Owner review — 2026-09-17

**Accepted**, with five owner decisions (E confirms where B ends). Every other decision above stands as corrected here.

1. **A. Fail closed without governance configuration.** A model call does not begin unless the runtime resolves an active price version, the mandatory global daily ceiling, the mandatory tenant daily budget, and any configured company limit. Missing configuration is a refusal, never a fallback: no default prices and no unlimited budgets.
   - **Guards:** the gates of `ops.start_agent_run` (§1, §3); the request-time pre-check in `ops.request_agent_run`, which refuses before any job; and the migration's assertion that no migration ships a price or a limit.
   - **Tests:** SQL A1, A2, A10, A12 and A13 (`runtime_governance.sql`); the driver-backed `operatorCatalog.dbtest.ts` and `spendRefusals.dbtest.ts`.
2. **B. Stopped jobs are held or deferred, never cancelled.** An execution stop prevents execution without destroying the business intent. A stopped job consumes no attempt merely because it is stopped, never invokes the provider, becomes eligible again only after the stop is explicitly cleared, and does not spin while stopped. There is one execution-stop architecture.
   - **Guards:** `ops.lease_job` holds every covered non-internal job at the lease. `ops.start_agent_run` answers `stopped` and writes nothing, the handler returns a `held` prepare, and the runtime calls `ops.defer_job()` while the start's kill-switch lock is still held (§6).
   - **Tests:** SQL K3 (the lease hold) and E8 in `runtime_governance.sql`, and K3 in `agent_runtime.sql` (the start answers `stopped`, and the job is deferred with its attempt given back); the driver-backed `killSwitchLease.dbtest.ts`, `externalCallDeferral.dbtest.ts`, `agentRunRuntime.dbtest.ts` and `agentRuns.dbtest.ts`.
3. **C. A concurrent request may wait for an in-progress prepare.** The wait is bounded by the existing lock and timeout rules. It never creates a duplicate run, a duplicate job, a second provider call, a reversed lock order or an unbounded wait.
   - **Guards:** `ops.claim_agent_run` locks the task FOR SHARE until the prepare commits. The wait is bounded by `idle_in_transaction_session_timeout` (10 s between statements) and `statement_timeout` (30 s within one). The locks follow the order of §4.
   - **Tests:** the driver-backed `agentRunHeldRuns.dbtest.ts`: once the start commits, the waiting retry and second job are refused, and the task still has one run and one job, with no second call.
4. **D. The spend-ceiling stop is cleared manually.** A system spend-ceiling stop never clears itself; only an explicit owner or operator act clears it. A new day, a budget change, a price change or lower observed spend never silently resumes model execution. The friction is intentional.
   - **Guards:** `ops.enforce_spend_ceiling()` can only trip (§5). The only clear is `ops.clear_execution_stop`, through `npm run execution-stop`, whose tools refuse the `system:` prefix for a human act.
   - **Tests:** SQL E4 and E8 (`runtime_governance.sql`); the driver-backed `spendCeiling.dbtest.ts` and `executionStopOutcome.dbtest.ts`.

5. **E. A stop before admission refuses new work; a stop after admission holds existing work.** Confirmed by the owner on 2026-09-17, as the final decision of the review. A new request that arrives while an applicable execution stop is active keeps today's behaviour:
   - it is recorded `cancelled` / `refused` / `execution_stopped`, naming the stop;
   - no job is created;
   - the provider is not called;
   - no deferred work is created.

   The distinction is intentional. Decision B covers only work already admitted: a job, and its run, that exists when the stop is found. Nothing is changed in code: this is what the code already does.
   - **Guards:** `ops.request_agent_run` reads the stops under the shared kill-switch lock and records the refusal before any job is enqueued (§6, ADR 0016 §11).
   - **Tests:** SQL K1 in `agent_runtime.sql` (every covering scope: recorded, refused, no job); the driver-backed `agentRuns.dbtest.ts` (a request made after a trip, and a request that waited for a trip, are recorded as refused by that stop with no job) and `agentRunRuntime.dbtest.ts` (a request under a global stop creates no job, and the worker stays idle).

### What the review changed

1. **Decision B for agent runs leased before a trip.** This was the one blocking finding of the review's verification. Before the review, the start cancelled such a run as `execution_stopped`, its job completed on that attempt, and a clear resumed nothing. The start now answers `stopped`, the handler returns `held`, and the runtime defers the job, so the same run starts after the clear (§6).
2. **Spend status clarity.** `ops.spend_status()` returns `settled_exhausted` (renamed from `exhausted`) and `new_run_admission`, and `npm run ops -- status` reports `globalCeilingConfigured` (§3, "What the operator sees"). The budget model is unchanged. SQL L11 matches a `blocked` row against `ops.spend_admission`.
3. **`ops.lease_job` refuses (`OS403`)** when row security would hide the stops, like every other reader of the switch (SQL G7).
4. **New SQL cases:** A13 (a missing tenant budget beside a global ceiling that settled spend already reaches is refused `budget_exhausted`, naming the global version), E8 (decision D as a named regression guard) and G7. Every guard the review added was mutation-tested: 12 mutants, all caught.

The remaining corrections in the body are wording, from the review's adversarial verification of this record; they change no behaviour.

### Recorded, not decided

- **The generic pre-call race.** On the `call` path, a stop cleared between the check and the deferral spends an attempt, although nothing is called (§6). The agent run path cannot meet it.
- **An owner session with no idle bound.** A global limit change left open in psql or Studio makes every waiting start fail at its statement timeout, spending attempts (Consequences).
- **Zero-priced reservations** are admitted at start under a limit that settled spend has exactly reached (§3).
- **Deleting the latest unreferenced price version** makes the previous version current again (§1).
- **ADR 0010 stays Proposed.** Its 2026-09-17 addendum records what is built; the owner did not decide it. ADR 0015 and ADR 0016 keep their Accepted status.
- **BASELINE Q8 stays open.** It blocks real patient data: no real patient message body, clinical text, psychotherapy information or health data may reach a real model provider until the owner decides it. It does not block synthetic Phase 2A development and testing.
- **The next phase** is PHASE 2A — SYNTHETIC LEAD TRIAGE PILOT (ROADMAP, owner review 2026-09-17). It has not started.
