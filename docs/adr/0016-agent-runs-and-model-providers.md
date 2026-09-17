# ADR 0016 — Agent runs: one bounded model call, at most once, behind a provider boundary

**Status:** Accepted (2026-09-16, owner review, with the amendment recorded at the end) · **Date:** 2026-09-14
**Implemented by:** `supabase/migrations/20260914120000_agent_runtime.sql` and `20260916120000_agent_run_ambiguous_provider_failures.sql`, `engine/models/`, `engine/handlers/agentRunExecute.ts`, the `external_call` handler shape in `engine/worker/`, `engine/domain/agentRuns.ts`, `engine/domain/executionStops.ts`, `engine/cli/executionStop.ts`

## Context

Phase 1D is the first phase in which an agent may invoke a language model. Until now an agent was a row of configuration ([ADR 0015](0015-company-os-domain-core.md) §5). Phase 1D adds the smallest durable primitive that lets one agent think once about one task, and nothing more: no tools, no memory, no loop, no side effect.

Five facts shaped every decision below. Each was measured or read from source on 2026-09-14.

1. **A model call cannot be made idempotent by the provider.** The OpenAI Responses API declares no idempotency header for `POST /responses`; the only `Idempotency-Key` in its OpenAPI spec belongs to an unrelated endpoint. A request whose answer never reached us may still have run and been billed.
2. **The worker's execution transaction wraps the handler.** Since Phase 1B, TX2 resumes the lease, runs the handler and completes the job in one transaction ([ADR 0012](0012-worker-tenant-context.md), Phase 1B addendum). Holding it open across a network call pins a pooled connection for the length of the call, and a rollback there discards the record of a call that already happened.
3. **The official OpenAI SDK retries by default.** openai-node retries connection errors, timed-out requests, 408, 409, 429 and every status of 500 or above, twice unless told otherwise; `maxRetries: 0`, per client or per request, turns that off. An adapter that kept the default would re-issue paid requests without the runtime knowing, so zero retries has to be explicit wherever a request is made. *(Corrected 2026-09-16, owner review, and checked that day against the openai-node README: an earlier wording implied the SDK could not be used without retries.)*
4. **The tenant boundary is the lease** ([ADR 0012](0012-worker-tenant-context.md)). A job's payload is the untrusted surface, and from this phase model output is too.
5. **No kill switch existed.** [ADR 0010](0010-cost-control-and-kill-switch.md) and ROADMAP sequencing rule 3 require one before any agent runs. The owner decided on 2026-09-14 to build its minimal agent-run form in this phase.

## Decision

### 1. An agent run is one invocation, for one agent, about one task it is assigned

`ops.agent_runs` holds one row per model invocation. Every run names its tenant, company, the agent's department, its task and its agent, all through composite keys that carry `tenant_id` and `company_id`, so a cross-tenant or cross-company run cannot be stored (the SI-22 shape). There are no free-floating runs: the task is the business anchor, and the agent must be the task's current assignee, both when the run is requested and again immediately before the call.

A run never changes its task. Its result is advisory data on the run row.

### 2. A small state machine, where "we do not know" is a state

```
pending ──► running ──► succeeded
   │           ├──────► failed
   │           └──────► indeterminate
   ├──► cancelled        (a deterministic gate refused it before any call)
   └──► failed           (it could not even be attempted: no configured route, or its job ended)
```

- **Six edges**, enforced by one `ENABLE ALWAYS` BEFORE UPDATE trigger. A finished run refuses any update, replica mode included. A run is born `pending` with no job and no fact of execution.
- **`indeterminate`** means a model call may have happened and the system lost the information needed to know. It is never reported as `failed`, and it is never retried automatically.
- **A retry is a new run** that names the run it repeats (`retry_of_run_id`, same task, same agent, same capability, parent finished). History is never rewritten.
- **The database decides what a failure means.** The worker reports an error category, and `ops.agent_run_error_status()` maps it to `failed` or `indeterminate`; a CHECK constraint holds the same pairs. An unrecognised category becomes `unknown`, which is indeterminate, so an unclassified failure can never read as a known one.
- **Codes the database assigns are reserved.** `execution_stopped`, `execution_interrupted`, `database_contract`, `job_failed` and `job_ended_before_start` are written only by the database itself. The same code supplied by a worker is dropped by `fail_agent_run` and replaced by `configuration` in `refuse_agent_run`, so a worker cannot make a failure read as a stop or an interruption.

| Status | Categories |
| --- | --- |
| `failed` | `configuration`, `authentication`, `rate_limit`, `invalid_request`, `invalid_response`, `schema_validation`, `job_failed` |
| `indeterminate` | `timeout`, `transport`, `provider_5xx`, `cancelled`, `unknown`, `interrupted` |
| `cancelled` | `refused` |

**The evidence decides the status** *(amended 2026-09-16, owner review)*. `failed` means the outcome is known. `indeterminate` means a model call may have happened and nobody can say how it ended.

| Evidence | What produces it | Category | Status |
| --- | --- | --- | --- |
| **A.** The provider was never called | no configured route or key | `configuration` | `failed` |
| | a run whose job ended before it started | `job_failed` | `failed` |
| **B.** The provider answered, and the answer settles the outcome | a refusal that proves the model never ran: HTTP 400, 413, 422 | `invalid_request` | `failed` |
| | HTTP 401, 403 | `authentication` | `failed` |
| | HTTP 404 | `configuration` | `failed` |
| | HTTP 429 | `rate_limit` | `failed` |
| | a 200 whose body names a terminal status: `completed` with unusable output, `incomplete`, or `failed` | `invalid_response` (`rate_limit` for a terminal rate-limit failure) | `failed` |
| | output that fails the contract | `schema_validation` | `failed` |
| **C.** The model may have run, and completion is uncertain | every 5xx other than 502 and 504 | `provider_5xx` | `indeterminate` |
| | HTTP 502; a redirect, which is refused rather than followed; a connection lost before or after the request was sent; a body broken mid-read | `transport` | `indeterminate` |
| | HTTP 408 and 504; the route or lease deadline, including a call the runtime never starts because its deadline has already passed | `timeout` | `indeterminate` |
| | an abort while the request is in flight | `cancelled` | `indeterminate` |
| | HTTP 409 and every status not listed above; a 200 whose body cannot be read (not JSON, over the byte cap) or names no terminal status; a provider that resolves no response, or a response with no content (`provider_contract`); a failure nobody classified | `unknown` | `indeterminate` |
| | an attempt that died after the start | `interrupted` | `indeterminate` |
| Refused by a gate or a stop before any call | | `refused` | `cancelled` |

A status is never a known failure merely because it is an HTTP error. A 5xx does not prove the model did not run before the failure became visible. Two outcomes that are provably A are still recorded as indeterminate, because the runtime cannot always tell them from their in-flight twins: an abort before the request was sent (`cancelled`), and a call never started because its deadline had passed (`timeout`). Both errors are on the conservative side. Content that is present but fails the contract is a known answer, `schema_validation`; a provider that returns no content at all has broken its own contract, which proves nothing about the model, so it is `unknown`. The database owns the mapping (`ops.agent_run_error_status` and the table's CHECK), `engine/models/errors.ts` mirrors it, and a driver-backed test asserts that the two agree.

### 3. At most one model call per run

The call is made **at most once**, and correctness does not depend on the provider:

1. **The start is durable before the call.** `ops.start_agent_run()` re-checks every gate under lock and records `running` with the prompt version, input fingerprint, provider, model and job attempt. That transaction commits before any byte is sent.
2. **The call runs outside every transaction**, with no database access. Its signal aborts on worker shutdown and at a deadline derived from the database-measured remaining lease.
3. **A call error is an outcome, never a job retry.** The runtime hands it to the settle step, which records the run `failed` or `indeterminate` in the same transaction that completes the job.
4. **Anyone who finds a run still `running` settles it, and never starts it.** A later attempt's `ops.claim_agent_run()` or `ops.start_agent_run()`, or the worker's `ops.settle_stale_agent_runs()` sweep, marks it `indeterminate` / `interrupted`. That covers a dead lease, a job re-leased by a later attempt, and a job exhausted by the reaper.
5. **A run is bound to the attempt that started it** *(added after adversarial review, 2026-09-14)*. `job_attempt` records the lease attempt that committed `running`.
   - Every run capability share-locks the leased job row and requires its lease to be live on the current clock (`clock_timestamp()`, not the transaction start) when it begins. A job held by an open prepare or settle transaction therefore cannot be reaped or swept underneath it: both skip locked rows.
   - The start can wait on the task, organisation and kill-switch locks, so it checks the lease on the clock again after those waits and before any write. The handler then asks the runtime how much of the lease is left and rolls the prepare transaction back below the 5 s minimum. The runtime starts no call whose deadline has already passed, because a 0 ms timer fires only after a request could already be on the wire. *(Added 2026-09-14 after the seam review.)*
   - `ops.start_agent_run` returns `running` only when this call started the run. That token alone means "call the provider". The same attempt starting again gets `already_running`, and a different attempt gets `indeterminate`.
   - The attempt that started a run cannot claim it again (42501): settling it there would discard a call that may still be in flight.
   - `ops.complete_agent_run` and `ops.fail_agent_run` answer `not_running` for a run another attempt started. The handler treats that as a security failure, which rolls its settle transaction back and leaves the run to the sweep.

The job that carries a run may still be retried. A retry cannot re-issue the call, because a second attempt finds the run already `running` or finished.

**The worker gained a second handler shape instead of a second architecture.** A transactional handler is unchanged. An `external_call` handler has three phases on the same lease: `prepare` (committed), `call` (no transaction, no capabilities) and `settle` (with job completion). The three-transaction invariant of Phase 1B still holds for everything that writes; only the external call sits between two commits.

### 4. Explicit request, through the existing bridge

`ops.request_agent_run()` is the only way to cause a model call. Creating or changing a task causes none. It is SECURITY INVOKER, takes an explicit authorised tenant, and no application role can execute it (ADR 0015 §4). In one transaction it:

- validates the tenant scope, the key and the source;
- answers a replay of the same key with the existing run, or refuses a different request under that key;
- resolves the task in the tenant and the agent in the task's company (`OS404`), then the capability's route (`OS403`);
- refuses a closed task, an agent that is not the assignee, and an inactive company, department or agent (`OS409`), then resolves a retry parent;
- inserts the run;
- checks the kill switch, and records a refusal on the run it just inserted;
- creates the job through `ops.request_task_execution`. The job's tenant still comes from the task row, and its idempotency key is still task-scoped.

That is the order the code runs, so it fixes which refusal a request with several faults receives. Scope is always resolved before state. *(Corrected 2026-09-14 after the seam review: an earlier list put the assignment before the capability and the kill switch before the insert.)*

`ops.task_executable_kinds()` becomes exactly `{agent_run.execute}`. That kind is not a generic door: the bridge creates it only for a pending run of the same task that has no job yet. The payload must be exactly `{agent_run_id}`, and the run id is resolved inside the task's tenant. The bridge stores the payload in canonical form, `{"agent_run_id": "<lowercase uuid>"}`, whatever spelling the caller passed.

**The payload is a reference, never authority.** The worker does not read it to find the run. Every capability resolves "the run bound to the live lease's job". The handler only cross-checks the payload's id, and a mismatch is a security failure.

### 5. Idempotency, correlation and causation are three different things

| Identifier | What it is | Where it comes from | What it may never do |
| --- | --- | --- | --- |
| **Idempotency key** | "This is the same request" | Chosen by the caller, scoped to the tenant, 1–200 printable characters | Grant scope, select a tenant, reveal another tenant's row, or stand in for lineage |
| **Correlation id** | "These facts belong to one chain of work" | Generated by the database for a new run, or inherited from the run a retry names | Be supplied by a caller or a model. `request_agent_run` has no such parameter |
| **Causation id** | "This fact happened because of that fact" | Derived by the database from the run's own history: `started` is caused by `requested`, a terminal fact by `started`, a retry's `requested` by the parent's last fact, and the job's `task.execution_requested` by the run's `requested` | Be supplied by a caller or a model |

The same key with the same semantic request returns the existing run; the request is fingerprinted as sha256 of task, agent, capability and retry parent. The same key with a different request is refused (`OS409`). Concurrent duplicates converge: an `INSERT … ON CONFLICT DO NOTHING` waits for the first transaction to commit, then answers as a replay.

**Residual, recorded:** the Phase 1C owner services still accept a caller-declared `correlation_id` for their own lifecycle events. They are executable only by the owner, who is outside the boundary (ADR 0015 owner decision 7), and ADR 0015 §4's future wrapper contract forbids the argument. Agent run facts never read that setting: their correlation is the run's own column.

### 6. The worker reaches runs through six lease-bound capabilities, not through grants

`claim_agent_run`, `start_agent_run`, `refuse_agent_run`, `complete_agent_run`, `fail_agent_run` and `settle_stale_agent_runs` are SECURITY DEFINER.

- **The five run capabilities** take no tenant, run, task, agent or job argument. Each resolves its run as `(ops.current_tenant_id(), app.job_id)`.
- **The sweep** checks no lease, like `ops.reap_expired_leases`. It touches only runs whose attempt is provably dead.

`ops_worker` gains no table privilege. A SELECT grant on tasks and agents under the lease-bound policies (ADR 0015 §4) was rejected here: it would expose every task of the leased tenant, while the capability returns the single run's bounded prompt context.

### 7. Model output is untrusted, advisory and structured

Each capability has one output contract. `task_assessment` returns `{outcome: completed | needs_input | blocked, summary, proposed_next_steps[]}`.

- **Validated twice:** in the worker (zod, strict) and again by the database (`ops.agent_run_result_valid`). A result the database refuses is stored as `failed` / `schema_validation` / `database_contract`, with no result. The run's update guard also refuses `succeeded` without a contract-valid result (`OS400`), so not even a raw owner UPDATE can store an invalid success.
- **It changes nothing:** no task, no job, no event beyond the run's own lifecycle, and no CRM row.
- **No tools:** the provider request carries no tools or tool choice; a unit test pins the exact request key set.
- **No hidden reasoning:** it is never requested, and the adapter ignores reasoning items.
- **Events carry no content:** ids, statuses and categories only.

### 8. The provider boundary

`ModelProvider.execute(request, signal)` returns a normalised response or rejects with a `ModelError` whose message is fixed text, never provider text. The domain, the run schema, the worker's tenancy, the events and the idempotency model know nothing about any provider. A new provider needs only an adapter that passes `engine/models/testSupport/providerContract.ts`, plus routing configuration.

**One real adapter:** the OpenAI Responses API over native `fetch`.
- **No SDK, by choice rather than necessity** *(reworded 2026-09-16, owner review)*. The official SDK can be configured for zero retries. The adapter uses `fetch` because:
  - zero retries is explicit at the HTTP boundary, and correctness depends on no SDK default;
  - the `external_call` runtime controls the whole request lifecycle: the deadline, the abort and the body read;
  - the dependency surface is smaller, and new packages are gated;
  - the exact request, the redirect policy, the body cap and the abort are directly testable.
- `store: false`.
- Strict JSON-schema output.
- A byte-capped body read.

**A deterministic fake provider** serves every test. It is reachable only by constructing it in code: routing configuration refuses any provider name other than `openai`.

### 9. The router is configuration, not a model's choice

- **Capability → tier** lives in the database (`ops.agent_run_capabilities()`; `task_assessment` → `standard`), reviewed like the task allowlist.
- **Tier → provider and model** lives in the environment (`AGENT_MODEL_PROVIDER`, `AGENT_MODEL_ECONOMY|STANDARD|REASONING`, `OPENAI_API_KEY`).
- **Tier → execution policy** (output-token ceiling, timeout) is code.

No model id appears in any constraint. An unknown or unconfigured route refuses the run as `failed` / `configuration` before any call. There is no fallback route and no escalation, since no escalation trigger is defined yet (ADR 0010 Decision 5). The worker refuses to boot if its lease is shorter than the longest configured route timeout plus a margin.

### 10. Usage is recorded; cost is not invented

The settling transaction stores input, output, total, cached and reasoning tokens, latency, and the provider's request and response ids. No versioned price source exists, so there is no cost column. A price table would be stale on arrival, and a fabricated number is worse than none. An `indeterminate` run has unknown usage by definition.

### 11. The minimal kill switch (owner decision, 2026-09-14)

`ops.execution_stops` implements [ADR 0010](0010-cost-control-and-kill-switch.md) for agent runs only.

- **Scopes:** global, tenant, company, department and agent.
- **Deny wins:** any active stop covering a run refuses it.
- **Fail closed:** a coordinate that cannot be read raises instead of passing.
- **Checked twice:**
  - at request time, where the refusal is recorded as a `cancelled` run naming the stop, with no job;
  - immediately before the call, under lock in `ops.start_agent_run`.
- **Audited clearing:** tripping and clearing are owner acts through `npm run execution-stop`, recorded on the row. A stop is never rewritten, and nothing clears one automatically.
- **Serialised with the start** *(added after adversarial review, 2026-09-14)*. Under READ COMMITTED, a row read alone would miss a stop committed between the read and the start's commit. Instead:
  - trip and clear take a transaction advisory lock exclusively (`ops.execution_stop_lock_key()`);
  - `start_agent_run` and `request_agent_run` take it shared, in a statement of its own, before reading the stops.

  A trip that has returned is therefore seen by every later start, and no trip lands between a start's read and its commit.
- **The record cannot be erased.** `ENABLE ALWAYS` triggers refuse deleting an active stop and truncating the table. A stop's free text may be replaced only by the literal `[redacted]`, and every other column is fixed once cleared.
- **A run names only a stop that governs it.** The run's update guard accepts a `stop_id` only for an active stop that covers the run.
- **A stop hidden by row security is not "no stop".** `ops.active_execution_stop` raises `OS403` when row security applies to its caller, because a policy-filtered read would answer "nothing is stopped".

**Not built, deliberately:**
- a UI;
- refusal at lease time for every job kind, which needs the non-consuming settlement ADR 0010's addendum describes;
- integration or tool scopes (there are no tools);
- budgets;
- the global daily spend ceiling, which needs a price source (§10).

## Alternatives

- **Hold TX2 open across the provider call.** Rejected: fact 2. A rollback forgets a paid call, and a lease expiring mid-call rolls it back and lets the job retry into a second call.
- **Rely on provider idempotency.** Rejected: fact 1. None exists for Responses.
- **Retry transient provider errors automatically.** Rejected: a timeout or a 502 does not tell us the call did not run. An explicit retry is a new run a caller chose.
- **Use the official SDK with `maxRetries: 0`.** Workable, and declined *(reworded 2026-09-16, owner review)*. Correctness would rest on an SDK default being overridden wherever a request is made. The `fetch` adapter instead keeps the retry policy, the exact request, the redirect policy, the body cap and the abort under direct test, with a smaller dependency surface.
- **A second worker process or queue for model calls.** Rejected by the brief, and unnecessary: one handler shape suffices.
- **Let the worker read the run from the payload.** Rejected: the payload is the untrusted surface (ADR 0012).
- **SELECT grants for the worker on runs, tasks and agents.** Rejected: §6.
- **Model, provider or prompt columns on `ops.agents`.** Rejected: ADR 0015 §5. An agent is not a model, and routes belong to capabilities.
- **Model ids or prices in constraints or migrations.** Rejected: catalogues and prices change.
- **A separate agent-run event table.** Rejected: `ops.events` is the spine, and a reserved `agent_run` namespace keeps these facts unforgeable by `record_event`.
- **A global kill switch only.** Considered and declined by the owner in favour of the five scopes.

## Consequences

- The only path from a task to a model is `ops.request_agent_run`. `ops.task_executable_kinds()` is non-empty for the first time, and SI-24 is restated.
- The pinned EXECUTE and SECURITY DEFINER surfaces grow by the six capabilities (`company_domain_core.sql` A4/A5, the migration's end-state assertions).
- **An `indeterminate` run is an operational signal.** An operator decides whether to request a retry; the system never does.
- **The worker's lease bounds model latency.** A slow reasoning route needs `OPS_WORKER_LEASE_SECONDS` raised, and the boot gate says so.
- **Provider data processing is now real:** task titles and descriptions leave the database for the provider.
  - `store: false` removes application-state retention.
  - The provider's abuse-monitoring retention remains unless the organisation has zero data retention.
  - The multi-tenant LGPD processor question (BASELINE Q8) is therefore live, not theoretical, and must be decided before a hosted tenant sends real task text.
- **No tenant-facing reader of runs or events exists.** SI-26 still requires an opaque or tenant-scoped cursor before one does.
- **ADR 0010 is partly implemented.** Its addendum records which parts.

---

## Owner review — 2026-09-16

**Accepted**, with two amendments. Every other decision above stands as written.

1. **Ambiguous provider outcomes are `indeterminate`.** As proposed, this ADR recorded `provider_5xx` as `failed`, reading HTTP 500 and 503 as the provider saying it did not complete. A 5xx does not prove that. The rule is now §2's evidence table: `failed` only when the provider was never called or its answer settles the outcome; `indeterminate` whenever the execution may have occurred and its completion cannot be proven; and never an automatic retry.
   - **Database:** a forward migration, `20260916120000_agent_run_ambiguous_provider_failures.sql`, moves `provider_5xx` to `indeterminate` in `ops.agent_run_error_status` and in the `agent_runs_category_status_pair` CHECK. It asserts the complete mapping in the function and in the CHECK body Postgres stores. It stops with a clear message, instead of failing on the constraint, if a run is already recorded as a failed provider server error. `20260914120000` is not edited.
   - **Adapter:** seven HTTP statuses are definitive refusals: 400, 401, 403, 404, 413, 422 and 429. Every other non-2xx status is indeterminate, and so is a 200 whose body cannot be read or names no terminal status. A 200 naming a terminal `failed` status is a known answer, so its server error is `invalid_response`, which is `failed`.
   - **Router:** a provider that resolves something other than a response, or a response with no content, is `unknown` (`provider_contract`), with whatever usage it reported. Content that is present but fails the contract stays `schema_validation`.
   - **Proof:**
     - an exhaustive sweep of HTTP statuses 100–599;
     - the provider contract suite, which now pins the recorded status;
     - the router's contract-breach tests and the handler tests;
     - the SQL suite: L3, and N15, in which not even a raw owner UPDATE can store a provider server error as `failed`;
     - the driver-backed mirror of the two mappings.

     PHASE_1D_REPORT §20 records the mutation results.
2. **The SDK rationale is corrected** (fact 3, §8 and Alternatives). The official SDK can run with zero retries: by default it retries connection errors, timeouts, 408, 409, 429 and 5xx twice, and `maxRetries: 0` turns that off (openai-node README, checked 2026-09-16). The `fetch` adapter stays, for the reasons §8 now gives.

---

## Addendum 2026-09-17 — what Phase 1D.1 changes in this record

[ADR 0017](0017-runtime-governance.md), accepted by the owner on 2026-09-17, builds runtime governance on top of this record. Everything above stands, except the points listed here. `supabase/migrations/20260917120000_runtime_governance.sql` makes these changes; no earlier migration was edited.

1. **§10 is superseded for cost.** Usage is still recorded as §10 describes. Cost is no longer absent: the database derives it from usage and an owner-recorded, versioned price. The price version is chosen when the run starts and recorded on the run. A run with no current, unexpired price is refused before any call (`price_unavailable`). An outcome whose cost is unknown is charged at its reservation. Prices are still never a constraint and never a migration row.
2. **§3 and §6: `ops.start_agent_run` takes a fifth argument, the output ceiling the worker will send.** A ceiling that differs from the database's route policy is refused as `route_policy_mismatch`.
   - Before `running` commits, the start also checks the price and the spend limits, under per-scope locks taken after the kill-switch lock.
   - A run that settled spend cannot absorb is recorded `cancelled` / `refused` / `budget_exhausted`, naming the limit.
   - A run that fits only once calls in flight settle raises `OS429` and records nothing. Its job retries on its backoff.
   - Only `running` means call. A new answer token, `stopped`, means an execution stop holds the run: the start checks the stops before any other gate, writes nothing, and leaves the run `pending`, and the runtime defers the job (items 5 and 6).
3. **§6: `ops.claim_agent_run` share-locks the task and agent rows it returns** for the rest of the prepare transaction. The input ceiling the start reserves is therefore computed from the same text the worker builds the prompt from.
4. **§2: the reserved error codes grow by five:** `price_unavailable`, `route_policy_mismatch`, `spend_ceiling_unconfigured`, `budget_unconfigured` and `budget_exhausted`. A worker cannot record any of them. `spend_limit_id` is set exactly when the code is `budget_exhausted`, and it must name an active limit that applies to the run.
5. **§3: the `external_call` shape moves to its own module** (`engine/worker/externalCall.ts`) without changing at-most-once.
   - The runtime re-checks the kill switch after a prepare that answered `call`, and before committing it.
   - A covering stop discards the handler's durable start at a savepoint and defers the job without consuming an attempt.
   - For agent runs the start itself finds the stop and answers `stopped`, so there is no durable start to discard. The handler reports the prepare as held, and the runtime defers the job (`ops.defer_job`) in the same transaction, under the kill-switch lock the start holds, so the stop cannot be cleared in between. If the deferral finds no covering stop, the whole prepare rolls back and the attempt fails through the transient path; nothing is called.
   - Every worker transaction bounds its idle time, so a stalled worker cannot hold the fleet-wide spend lock.
6. **§11: the kill switch now also works at the lease.**
   - A queued `agent_run.execute` job that a stop covers is not leased, and its run stays `pending` until the stop is cleared.
   - A run whose job was leased before the trip is held at start, and its job is deferred with its attempt restored and a `deferred` job event naming the stop. The run stays `pending`, and after an explicit clear the same run starts, with every gate checked again (owner decision B, 2026-09-17). This supersedes §11's recording of a start-time refusal as a `cancelled` run.
   - Request-time refusal is unchanged from §11: a request made while a stop covers it is recorded `cancelled` / `refused` / `execution_stopped`, naming the stop, with no job. No job is created and nothing is deferred. The owner confirmed this on 2026-09-17 (ADR 0017 owner review, decision E): a stop before admission refuses new work, and a stop after admission holds the work already admitted.
   - The `job_kind` scope stops every agent run at once.
   - A stop tripped by the spend ceiling has origin `system`, and never absorbs or clears an owner's stop.
   - The "not built" list loses budgets, the spend ceiling, and lease-time refusal. The UI remains unbuilt.
