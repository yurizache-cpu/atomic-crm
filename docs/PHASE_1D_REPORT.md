# PHASE 1D REPORT

## Agent runtime, model router and the first model call

**Date:** built 2026-09-14 · **Branch:** `feature/clinical-phase-1` · **Base:** `60cbc2b5` · **Commits** (2026-09-16, on the owner's instruction; not yet pushed): `58429b0a` database, domain and runtime; `0e5243f5` providers, router, handler and driver-backed proofs; `d846263b` security guards and invariants; `009cd862` documentation; and the ADR 0016 owner-review amendment commit that carries this revision of the report (`git log 60cbc2b5..HEAD`).

**CI:** **PENDING PUSH.** The commits are local; the owner pushes, and no CI run covers Phase 1D until then. Every result below was measured locally on Windows 11 against the isolated e2e stack (`atomic-crm-e2e`, loopback only).

Phase 1D lets one agent call a language model **once**, about **one** task it is assigned, and nothing follows from what the model says. There are no tools, Tool Gateway, MCP, memory, retrieval, multiple agents, loops, autonomous triggers, approvals, UI, CRM reads or writes, or clinical data. [ADR 0016](adr/0016-agent-runs-and-model-providers.md) records every decision and the alternatives rejected. The minimal kill switch discharges part of [ADR 0010](adr/0010-cost-control-and-kill-switch.md), whose addendum maps it part by part. SI-28 to SI-34 in [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md) are the properties that must now hold; SI-21 and SI-24 were restated.

**How it was built.**
1. **Rehydration and design.** The repository, ADRs and git state were read first. A design and three implementation specs were written before any code.
2. **The owner decided one question (2026-09-14):** build the minimal agent-run stop in this phase, because ROADMAP sequencing rule 3 forbids an agent before a kill switch.
3. **Adversarial review of the migration before it was applied beyond the local stack.** 18 findings, 2 Medium. All Medium and Low findings were fixed in a revised migration (v2); see §21.
4. **Parallel implementation streams**, each followed by an independent adversarial reviewer who fixed what it could confirm: models, worker runtime, guards, domain and CLI, the SQL attack suite, the handler, and guard gap closure.
5. **Mutation testing of every load-bearing guard** on a live database and in TypeScript (§20).
6. **Driver-backed proofs through real worker processes**, including crashes during a model call (§19).
7. **A read-only adversarial seam review** across the migration, runtime, handler, models and documentation (§21).

---

## 1. Agent Run architecture

```
owner ── ops.request_agent_run(tenant, task, agent, capability, idempotency key, source [, retry_of])
           gates: task in tenant · agent in task's company · assignee · capability · active org · kill switch
           run: pending ── bridge ── ops.jobs  kind agent_run.execute, payload {agent_run_id}  (a reference only)
                                         │
worker  TX1   lease ─────────────────────┤ COMMIT
        TX2a  prepare  claim_agent_run   the run bound to the LIVE LEASE, never the payload
                       start_agent_run   gates + stops again ── COMMIT "running"
                                         any other token: settle now, never call
        ────  call     ModelRouter.executeStructured(route, prompt, contract, signal)
                       no transaction, no capabilities; signal = shutdown or lease deadline
        TX2b  settle   complete_agent_run | fail_agent_run  +  ops.complete_job ── COMMIT
        tick  sweep    settle_stale_agent_runs: running under a dead or superseded attempt -> indeterminate
```

| Distinction | What keeps it |
| --- | --- |
| Agent ≠ model | `ops.agents` carries no model, prompt or provider; routes belong to capabilities |
| Run ≠ job | a run is the business record of one invocation; the job only carries it, and a job retry cannot re-issue the call |
| Idempotency ≠ correlation ≠ causation | a key is tenant-scoped caller data; correlation is generated or inherited by the database; causation is derived from the run's own facts |
| Result ≠ action | the result is advisory data on the run row and changes nothing else |
| Stop ≠ agent status | `ops.execution_stops` is the audited, deny-wins switch; `ops.agents.status` stays lifecycle configuration |

| Piece | Where |
| --- | --- |
| Tables, guards, events, owner services, worker capabilities, grants, end-state assertions | `supabase/migrations/20260914120000_agent_runtime.sql` (hand-written, idempotent) |
| Provider boundary, adapters, router, output contract, prompt, fingerprint | `engine/models/` (`types`, `errors`, `openaiResponses`, `fakeModelProvider`, `router`, `routingConfig`, `outputContract`, `taskAssessment`, `fingerprint`, `testSupport/providerContract`) |
| The `external_call` handler shape | `engine/worker/handlerRegistry.ts`, `runOneJob.ts`, `runWorker.ts` |
| The handler and its capabilities | `engine/handlers/agentRunExecute.ts`, `engine/worker/capabilities.ts`, `registry.ts`, boot gate in `main.ts` |
| Typed owner boundary | `engine/domain/agentRuns.ts`, `executionStops.ts`, `agentRunStateMachine.ts` |
| Stop CLI and smoke command | `engine/cli/executionStop.ts` (`npm run execution-stop`), `engine/cli/agentRunSmoke.ts` (`npm run agent-runtime:smoke`) |
| SQL attack suite | `supabase/tests/agent_runtime.sql` (sections A–N, I3) |
| Driver-backed proofs | `engine/domain/agentRunRuntime.dbtest.ts`, `engine/domain/agentRuns.dbtest.ts`, `engine/worker/testSupport/agentRunWorker.ts` |
| Guards | `scripts/scan-build-artifacts.mjs`, `engine/models/providerSecretsBoundary.test.ts`, `eslint.config.js` |

## 2. Schema and state machine

**`ops.agent_runs`**, one row per model invocation:

- **Identity and scope:** `tenant_id`, `company_id`, `department_id` (the agent's), `task_id`, `agent_id`, with composite foreign keys that carry `tenant_id` and `company_id`; `job_id` to `(tenant_id, job_id)`; `retry_of_run_id` to a run of the same tenant.
- **Request:** `capability`, `model_route`, `idempotency_key` (unique per tenant), `request_fingerprint`, `correlation_id`, `requested_by`, all fixed at creation.
- **Execution facts:** `prompt_version`, `input_fingerprint`, `provider`, `model`, `job_attempt`, `started_at`.
- **Outcome:** `status`, `result`, `error_category`, `error_code`, `stop_id`, `response_model`, `finish_reason`, `provider_request_id`, `provider_response_id`, five token counts, `latency_ms`, `completed_at`.
- **Coherence CHECKs:** status implies which facts exist; `stop_id` is set exactly when the code is `execution_stopped`; the result is an object of at most 16 KB; the category pairs with the status. No model id appears in any constraint, and there is no cost column (§14).

**`ops.execution_stops`:** a scope (`global`, `tenant`, `company`, `department`, `agent`), the target coordinates that scope requires, `reason`, `tripped_by`, `tripped_at`, and the clearing (`cleared_by`, `cleared_reason`, `cleared_at`). One active stop per target.

**State machine: six edges**, enforced by `agent_runs_guard_update` (`ENABLE ALWAYS`):

```
pending ──► running ──► succeeded
   │           ├──────► failed
   │           └──────► indeterminate
   ├──► cancelled        a deterministic gate or a stop refused it before any call
   └──► failed           it could not be attempted: no route, or its job ended
```

- A finished run refuses any update, including a no-op, in replica mode too (H3, H6).
- `succeeded` requires a contract-valid result, even through a raw owner UPDATE (N13).
- A retry is a new run (`retry_of_run_id`: same task, agent and capability; parent finished).
- **The database decides what a failure means:**

| Status | Categories |
| --- | --- |
| `failed` | `configuration`, `authentication`, `rate_limit`, `invalid_request`, `invalid_response`, `schema_validation`, `job_failed` |
| `indeterminate` | `timeout`, `transport`, `provider_5xx`, `cancelled`, `unknown`, `interrupted` |
| `cancelled` | `refused` |

An unrecognised category is stored as `unknown`, which is indeterminate. Codes the database assigns (`execution_stopped`, `execution_interrupted`, `database_contract`, `job_failed`, `job_ended_before_start`) are reserved: a worker-supplied one is dropped or replaced (N5).

**Owner review (2026-09-16).** A run is `failed` only when the provider was never called, or its answer settles the outcome. Whenever the model may have run and its completion cannot be proven, the run is `indeterminate`, and a 5xx is such a case: `provider_5xx` moved from `failed` to `indeterminate` in a forward migration (`20260916120000_agent_run_ambiguous_provider_failures.sql`), in the function and in the table's CHECK. ADR 0016 §2 gives the full evidence table. The router follows the same rule: a provider that resolves no response, or a response with no content, is `unknown`. Proven by L3 and N15 (not even a raw owner UPDATE can store a provider server error as `failed`), by the driver-backed mirror, by the migration's own assertion over the stored CHECK body, and by the adapter's exhaustive status sweep (§20).

**Proven:** H1 attempts every ordered pair of the six statuses with a raw UPDATE against a literal edge list; H2 checks the database helpers against the same list; the migration asserts the edges and the category map at apply time; a driver-backed test asserts the TypeScript mirror equals the database relation in both directions (§19).

## 3. Task → Agent Run → Job flow

1. **Request** (`ops.request_agent_run`, SECURITY INVOKER, owner only). In one transaction:
   - validate tenant scope, key and source;
   - replay or refuse on the idempotency key (§4);
   - lock and resolve the task inside the tenant (`OS404` otherwise), the agent inside the task's company, and the capability's route (`OS403`);
   - refuse a closed task, an agent that is not the assignee, or an inactive company, department or agent (`OS409`);
   - resolve a retry parent with a plain read (no lock, finding AR-07);
   - insert the run;
   - take the kill-switch lock shared, then read the stops. A covering stop records the run `cancelled` / `refused` / `execution_stopped` naming the stop, with no job;
   - otherwise create the job through `ops.request_task_execution`: tenant from the task row, kind `agent_run.execute`, payload stored canonically as `{"agent_run_id": "<lowercase uuid>"}`, task-scoped job key `agent_run:<run id>`.
2. **Lease** (TX1) commits alone, as since Phase 1B.
3. **Prepare** (TX2a): `claim_agent_run` returns the bounded prompt context or a settled status; the handler cross-checks the payload's id (a mismatch is a security failure), refuses an unsupported capability or an unresolvable route (`failed` / `configuration`), refuses a call budget under 5 s as transient (nothing durable yet), builds the prompt and the exact provider request, fingerprints it, and calls `start_agent_run`. Only the token `running` leads to a call.
4. **Call:** exactly one `executeStructured`, with no transaction open and no capability in reach.
5. **Settle** (TX2b): `complete_agent_run` or `fail_agent_run`, then `ops.complete_job`, in one transaction. A status token the capability cannot have recorded, including `not_running`, raises a security error and rolls the settlement back.
6. **Sweep:** after each reaper tick, `settle_stale_agent_runs` in its own transaction.

The task is never changed by any step (L1, §19).

## 4. Idempotency model

- **The key is caller-chosen, tenant-scoped data:** 1–200 printable characters, unique per `(tenant_id, idempotency_key)`. It grants nothing and selects no tenant.
- **The request is fingerprinted** as sha256 of `agent_run.request.v1 | task | agent | capability | retry parent`, every field coalesced so a missing one cannot collide.
- **Same key, same request:** the existing run id, with no second run, fact, job or link (F1, F3, F5), including after the run finished.
- **Same key, different request:** `OS409`, surfaced by the domain as `invalid_state` (F2).
- **Another tenant's key** is independent (F4).
- **Concurrency:** `INSERT … ON CONFLICT DO NOTHING` waits for the first transaction, then answers as a replay. **Measured with two connections:** two concurrent requests with one key resolve to one run and one job, the second proven waiting in `pg_stat_activity` before the first commits; the same key reused concurrently for a different task is refused after the wait and creates nothing (§19). Mutations that drop `on conflict`, or return the existing run without comparing fingerprints, fail those cases (§20).
- **The job** is idempotent under the task-scoped key `agent_run:<run id>`; replaying the bridge request writes nothing (J3).
- **No provider idempotency is relied on.** The Responses API declares none for `POST /responses`; at-most-once comes from the database (§6).

## 5. Correlation / causation model

| Identifier | Meaning | Source | Never |
| --- | --- | --- | --- |
| Idempotency key | the same request | the caller, per tenant | grants scope, selects a tenant, stands in for lineage |
| Correlation id | one chain of work | generated by the database per request, or inherited from the retried run | supplied by a caller or a model: `request_agent_run` has no such parameter (A4) |
| Causation id | this fact happened because of that fact | derived from the run's own lifecycle facts: `started` ← `requested`, terminal ← `started`, a retry's `requested` ← the parent's last fact, the job's `task.execution_requested` ← the run's `requested` | supplied by a caller or a model |

**Proven:** G1 (every fact carries the run's correlation), G2–G3 (causation chain), G4 (a retry inherits correlation and is caused by the parent's last fact), G5 (a caller's transaction settings reach neither), G6 (independent requests get independent correlations), N8 and N14 (a business fact about the run, or a look-alike type such as `agent_runs.requested` or `agentxrun.noted`, never becomes a cause).

**Residual, recorded:** the Phase 1C owner services still accept a caller-declared `correlation_id` for their own events; agent run facts never read it.

## 6. Crash and indeterminate semantics

`indeterminate` means a call may have happened and the system cannot know. It is never reported as `failed` and never retried automatically.

| Where the worker stops | What the database holds | What happens next |
| --- | --- | --- |
| Before the lease commits | nothing changed | the job is leased again |
| After the lease, before prepare commits | run `pending`; the lease attempt is spent | after expiry the job is re-leased; no call was made |
| After `running` commits: before, during or after the call, before settle commits | run `running` with `job_attempt` | a later attempt's claim or start, or the sweep, settles it `indeterminate` / `interrupted`; **no second call** |
| Settle transaction fails (database error, lease lost) | settlement rolled back, run `running` | the failure transaction records the job failure; the run is settled `indeterminate` as above |
| The lease deadline passes during the call | — | the runtime aborts the call at `lease remaining − 10 s`; the run is recorded `indeterminate` / `timeout` / `deadline` |
| Shutdown during the call | — | the call is aborted and recorded `indeterminate` / `cancelled`; the job completes; the loop stops |
| Shutdown during a reaper or heartbeat step | — | nothing is leased |

**Why nothing runs twice, and no call outruns its lease:**
- Every run capability share-locks the leased job and requires its lease to be live on `clock_timestamp()` when it begins.
- `start_agent_run` checks the lease on the clock again after its own lock waits, before any write.
- The handler asks the runtime how much of the lease is left after the start answers `running`, and rolls the prepare transaction back below 5 s.
- The runtime starts no call whose deadline has already passed.
- Only the attempt that committed `running` may settle the run.
- A job held by an open worker transaction is skipped by the reaper and the sweep.

**Proven in SQL:**
- L4: a second start answers `already_running`, and the starting attempt cannot claim again.
- L7 and N3: a later attempt settles the run, never starts it.
- N4: a later attempt cannot complete or fail it.
- N1: a lease already run out when a capability begins is refused.
- M1–M7 and N6: the sweep settles exactly the dead runs, on the wall clock.

**With two sessions and through real processes:** §19.

## 7. Model provider abstraction

`ModelProvider { name; execute(request, signal): Promise<ModelResponse> }` in `engine/models/types.ts`. A request holds a model id, instructions, one input string, a named JSON schema and an output-token ceiling. A response holds the raw structured content, the response model, finish reason, provider request and response ids, normalised usage and latency.

- **Errors:** every failure is a `ModelError` with a category (§2's eleven model categories), a shape-checked code, and any ids, usage and latency the call produced. Its message is fixed text: provider text, keys and prompts never reach it, and it carries no `cause`.
- **Numbers are storable:** token counts are non-negative integers at most 2³¹−1, latency is rounded, and a finish reason that does not fit the column becomes `unknown`.
- **Contract suite:** `engine/models/testSupport/providerContract.ts` runs against the fake provider and the OpenAI adapter. It checks the response shape, usage keys, abort behaviour, fixed error messages, and that no prompt sentinel or key appears anywhere, including `util.inspect` with hidden fields.
- **Nothing outside `engine/models` knows a provider.** The run schema, tenancy, events and idempotency are provider-neutral, and ESLint keeps the model layer free of the database, the worker, handlers and the domain, statically and at run time.

## 8. Router design

| Tier | Output ceiling | Timeout | Configured by |
| --- | --- | --- | --- |
| `economy` | 2 000 tokens | 20 s | `AGENT_MODEL_ECONOMY` |
| `standard` | 8 000 tokens | 45 s | `AGENT_MODEL_STANDARD` |
| `reasoning` | 25 000 tokens | 90 s | `AGENT_MODEL_REASONING` |

- **Capability → tier** lives in the database (`ops.agent_run_capabilities()`: `task_assessment` → `standard`), reviewed like the allowlist.
- **Tier → provider and model** lives in the environment: `AGENT_MODEL_PROVIDER` must be unset, empty or `openai`; the fake provider cannot be selected from the environment. `OPENAI_API_KEY` is required with `openai`. A malformed model id or a key pasted into a tier variable is refused by variable name, never by value.
- **Tier → policy** is code.
- **One call:** `executeStructured` resolves the route, builds the request with the exported `buildModelRequest` (which the handler also fingerprints), invokes the provider once, and validates the output. No retry, no fallback, no escalation.
- **Unknown or unconfigured route:** `resolve` returns nothing; the handler refuses the run as `failed` / `configuration` / `route_unavailable` before any call. A route object the router did not configure is refused as `configuration`.
- **Timeout and abort:** the route timeout is `timeout`; the caller's abort is `cancelled`; a provider that ignores its abort is not waited for. The handler records a lease-deadline abort as `timeout` / `deadline` and a shutdown as `cancelled`.
- **Boot gate:** the worker refuses to start when `OPS_WORKER_LEASE_SECONDS` cannot hold the 5 s prepare allowance, the longest configured route timeout and the 10 s safety margin. The default 60 s lease fits `standard` and refuses `reasoning`, naming the variable, never its value.

## 9. Real provider implementation

**OpenAI Responses over native `fetch`** (`engine/models/openaiResponses.ts`).

**SDK versus `fetch`, evaluated** *(reworded 2026-09-16, owner review)*:
- The official SDK retries connection errors, timeouts, 408, 409, 429 and 5xx twice by default (openai-node README, checked 2026-09-16). `maxRetries: 0` turns that off, per client or per request, so the SDK is usable; keeping `fetch` is a choice, not a necessity.
- With `fetch`, zero retries is explicit at the HTTP boundary, and correctness depends on no SDK default.
- The `external_call` runtime controls the whole request lifecycle: the deadline, the abort and the body read.
- The exact request, the redirect policy, the body cap and the abort are directly testable, and the dependency surface is smaller; a new package would need the owner's dependency review.
- `output_text` is an SDK convenience, not a wire field.

**Request:** `POST https://api.openai.com/v1/responses` with `model`, `instructions`, one `input` message, `text.format` as a strict named JSON schema, `max_output_tokens` and `store: false`. Nothing else: no tools, tool choice, reasoning request, metadata, stream or previous response id. A test pins the exact key set. The key travels only in the `Authorization` header; `redirect: "error"` keeps it from following a redirect.

**Response:**
- The body is read with a 2 MB byte cap, raced against the abort.
- `output_text` parts are concatenated in order. A `reasoning` item is ignored. Any other output item is refused as `invalid_response`.
- Ids come from `x-request-id` and the body; any provider string that contains the key is dropped.
- Usage maps `input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens` and `output_tokens_details.reasoning_tokens`.
- A 200 is a known answer only once its body is read and names a terminal status. The following are recorded `failed`:
  - an unusable `completed` answer, which is `invalid_response`;
  - an `incomplete` response, which is `invalid_response` with its reason as the code;
  - a terminal `failed` response, which is `invalid_response`, or `rate_limit` for a rate-limit failure.
- A 200 whose body is not JSON or is over the byte cap is `unknown` and recorded `indeterminate`. So is one that names no terminal status: `in_progress`, `queued`, no status, or one nobody defined.

**Status mapping** *(amended 2026-09-16, owner review):*

| HTTP status | Category | Run status |
| --- | --- | --- |
| 400, 413, 422 | `invalid_request` | `failed` |
| 401, 403 | `authentication` | `failed` |
| 404 | `configuration` | `failed` |
| 429 | `rate_limit` | `failed` |
| 408, 504 | `timeout` | `indeterminate` |
| 502 | `transport` | `indeterminate` |
| every other 5xx | `provider_5xx` | `indeterminate` |
| 409, and any other status | `unknown` | `indeterminate` |
| a redirect (refused, never followed) | `transport` | `indeterminate` |

Only the seven statuses in the first four rows are definitive refusals, which prove the model never ran. A status is never a known failure merely because it is an error, and a 5xx does not prove the model did not run. An exhaustive test checks every status from 100 to 599 against this rule.

**Live smoke:** `npm run agent-runtime:smoke -- --live` builds the router from the environment and prints `{"skipped": …}` when no provider is configured. **No live call was made in Phase 1D:** no key exists on this machine, and none was requested.

## 10. Fake provider implementation

`createFakeModelProvider(behavior)` (`engine/models/fakeModelProvider.ts`) is deterministic:

- **Behaviours:** `respond` (fixed content, usage and ids), `fail` (a given category and code), `delay` (then another behaviour), `hang` (until aborted), and `ignore_abort` (never settles, to test abandonment).
- **Call record:** it records every request it receives as a frozen snapshot, so tests count calls and fingerprint the exact request sent.
- **Honours the contract:** it passes the same suite as the real adapter.
- **Reachable only from code:** routing configuration refuses the name `fake`.

Every CI test, the driver-backed proofs and the default smoke run use it. The spawned test worker (`engine/worker/testSupport/agentRunWorker.ts`) writes `{"event":"model_call_started"}` when a call starts, so crash tests kill it during a call deterministically.

## 11. Structured-output contract

`task_assessment` (`engine/models/taskAssessment.ts`):

```json
{ "outcome": "completed | needs_input | blocked",
  "summary": "≤ 1000 characters",
  "proposed_next_steps": ["≤ 10 items, each ≤ 300 characters"] }
```

- **Provider:** a strict JSON schema, every object closed and every property required.
- **Worker:** zod, strict. Text must be non-blank and storable (no U+0000, no unpaired surrogate), because a value the database would refuse must fail as `schema_validation`, not abort the settle transaction. A test proves the JSON schema is never looser than the local schema.
- **Database:** `ops.agent_run_result_valid` re-validates the envelope. A result it refuses is stored as `failed` / `schema_validation` / `database_contract` with no result. The update guard refuses `succeeded` without a valid result.
- **Malformed output** (not JSON, wrong shape, extra keys) is `failed` / `schema_validation`, keeping usage and ids, quoting none of the output.
- **The result is advisory.** It changes nothing; output that looks like a tenant id, job kind, SQL or a URL is stored only as opaque data.
- **No reasoning is requested or stored.**

## 12. Prompt and version strategy

- **One versioned prompt:** `task_assessment.v1`. Changing instructions, context shape or limits is a new version.
- **Deterministic:** byte-identical for equal inputs, whatever the clock.
- **Instructions are fixed text.** The agent's name and role appear only as JSON-quoted strings.
- **Tenant data is data:** agent `{name, role, description}` and task `{type, title, description, priority, due_at}` go into the input as one JSON document with a fixed key order. An instruction-shaped task field stays inside the document.
- **Minimised:** no ids, slugs, tenant or company names, timestamps other than the due date, CRM data, events or earlier runs.
- **Truncated deterministically** at the database's own limits: task description 4 000, agent description 2 000, name and role 200, title 300, type 100 characters, marked when cut, never splitting a surrogate pair.
- **Persisted at start:** `prompt_version` and `input_fingerprint`, the sha256 of the canonical request (`prompt_version`, `provider`, `model`, `instructions`, `input`, `output_name`, `output_schema` with keys sorted recursively, `max_output_tokens`). The prompt text itself is never stored. The fingerprint is computed from the same builder the router sends with, and a test proves it equals the fingerprint of the request the provider received.

## 13. Secret handling

- **Where the key lives:** the worker process's environment, as `OPENAI_API_KEY`. Nowhere else: not the database, a job or event payload, a log line, the browser bundle, a URL, a test fixture (key-shaped fixtures are built by concatenation) or CI.
- **Configuration errors** name variables, never values. A key pasted into a tier variable is refused.
- **Adapter:** the key only in the `Authorization` header; redirects refused; any provider string containing the key dropped; fixed error messages with no `cause`.
- **Worker:** handler details carry ids, statuses, route, provider, model, token counts and category only. `main.ts` boot messages repeat no environment value.
- **Stop CLI:** a server error is printed with its message only when it was raised inside the open transaction. Anything raised before the transaction opened, whatever its SQLSTATE, prints the code only, and so do classes 08, 28 and 3D at any point. The user name, database name and host therefore never appear. *(Widened after the seam review: 53300, 55000 and a connect-time 42501 also name the role or database.)*
- **Build scan** (`npm run scan:build`, a required CI step): OpenAI keys under every prefix, every `sk-ant-` family, and any `VITE_`-prefixed model-provider variable name in any quoting or escaping, with the value never echoed.
- **Source boundary** (`providerSecretsBoundary.test.ts`): no `VITE_` provider name in any tracked build input (source, env files, vite configs, workflows, `package.json`, `makefile`); no reference to the `process` global in `engine/models` or `engine/handlers`, including aliases of the global object.
- **ESLint:** `engine/models` and `engine/handlers` cannot import the driver, `engine/db`, the domain, or a module loader, statically or through `import()` / `require()`.
- **CI needs no key**, and nothing here asked the owner for one.

## 14. Usage and cost accounting

- **Recorded in the settling transaction:** input, output, total, cached-input and reasoning tokens; latency; response model; finish reason; provider request and response ids. A malformed or out-of-range figure is dropped, never allowed to cost the result.
- **Cost is not recorded.** There is no cost column, because no versioned price source exists and a fabricated number is worse than none (ADR 0016 §10).
- **An `indeterminate` run has unknown usage**, and possibly unknown spend.
- **ADR 0010 status:** usage-in-the-same-transaction is partly built; budgets and the global daily spend ceiling are not built and remain owed before autonomous or high-volume execution.

## 15. Events

- **Types:** `agent_run.requested`, `started`, `succeeded`, `failed`, `indeterminate`, `cancelled`, derived by an AFTER trigger, exactly one per change, in the same statement (I1, I2). The request also writes `task.execution_requested` through the bridge.
- **Reserved:** `agent_run` is a lifecycle namespace. `ops.record_event` and the table guard refuse forging one, including in replica mode (A6, I4, I5).
- **Minimised payloads:** at most `task_id`, `agent_id`, `capability`, `model_route`, `retry_of_run_id`, `from_status`, `to_status`, `error_category`, `error_code` and a contract `outcome`. Never the result text, prompt, task text, provider text or usage. I3 inspects every agent run fact every section produced, with a positive control that each type was produced.
- **Subject integrity:** an event about a run must live in the run's own company (I6), and a legitimate business fact about a run can still be recorded (I7).
- **SI-26 holds:** no reader of `events.seq` or `job_events.id` was added, and nothing tenant-facing exists.

## 16. Tenant and company isolation

- **Structural:** composite foreign keys make a run in another tenant's or company's task, agent, department or job unstorable (D1–D11), and a stop's target must live in its own tenant and company (D8, K10).
- **Request scope before state:** tenant B's task, agent, closed task or inactive agent is "not found" through tenant A (E1–E8); a refused request writes nothing (E8).
- **Worker reach:** each capability resolves the run bound to `(lease tenant, app.job_id)`. No lease, a forged job id, another worker's lease, or an expired lease reaches nothing (C1–C5); a live lease claims exactly its run (C6). A payload naming another run chooses nothing (C7).
- **The claim leaks no identifier** beyond the run id, and no other agent's or task's text (L1).
- **The handler** refuses a payload that does not name the claimed run before any other capability and any call.
- **Through real workers:** an `agent_run.execute` job for tenant A forged to name tenant B's run is refused by the database's claim; a legitimate job whose payload the owner rewrote to name tenant B's run reaches the handler's security refusal. In both, tenant B's run is untouched and the provider is never called (§19).
- **Tenant is the boundary; a company is organisation only** (ADR 0015 owner addendum). Company, department and agent scopes on a stop are organisational controls, not isolation.

## 17. Worker privileges

- **New EXECUTE grants to `ops_worker`, and nothing else:** `claim_agent_run()`, `refuse_agent_run(text)`, `start_agent_run(text, text, text, text)`, `complete_agent_run(jsonb, …)`, `fail_agent_run(text, …)`, `settle_stale_agent_runs()`. All six are SECURITY DEFINER; the first five are lease-bound, and the sweep, like the reaper, checks no lease.
- **No table privilege:** `ops_worker` gains none on runs, stops, tasks or agents. A leased worker is refused at the privilege layer on every agent runtime table and owner service (B).
- **Pinned surfaces:** the EXECUTE surface of the application roles (`company_domain_core.sql` A4; `agent_runtime.sql` A1–A3, A9) and the SECURITY DEFINER set (A5, and the migration's own end-state assertion) are pinned by name; the new helpers are executable by no application role (A9).
- **The worker now calls seventeen pinned `ops` functions**, four of which check no lease.
- **Capabilities in TypeScript:** five new entries in `CAPABILITY_NAMES`, each one fixed statement with bound parameters and no id of any kind. The handler declares prepare and settle capabilities separately, and the runtime revokes each set after its phase.

## 18. Data API exposure

**No new reachable surface.** `ops` stays off the PostgREST allowlist, and `opsDataApiExposure.mjs` now also requires `ops.agent_runs`, `ops.execution_stops`, `request_agent_run`, `claim_agent_run` and `trip_execution_stop` to exist, so a probe run against a database without Phase 1D fails instead of passing vacuously.

**Final result (2026-09-14, after a clean reset):** 13 `ops` relations and 60 `ops` functions, 5 credentials (no key, publishable, anon JWT, service_role JWT, secret key), **495 requests over REST and GraphQL, none reached `ops`**. Phase 1C's run measured 11 relations and 35 functions with 340 requests. The live PostgREST schema allowlist and search path still exclude `ops`.

## 19. Crash and recovery test results

`engine/domain/agentRunRuntime.dbtest.ts` and `engine/domain/agentRuns.dbtest.ts` run through the real `pg` pool, the real worker runtime and handler, the fake provider, and real worker processes spawned from `engine/worker/testSupport/agentRunWorker.ts`. Every wait is on an observable event: a stdout line, a process exit, a `pg_stat_activity` lock wait, the provider's call-started signal, or lease expiry polled on the database clock. None uses a sleep as synchronisation. Both files ran three times in a row with identical results. Both test workers and the fixture refuse any database that is not on this machine, before connecting.

**The first demonstration flow.** A synthetic task, "Prepare next week's office supply order", in a fixture company, assigned to its agent:

- **Run:** `requestAgentRun`, then one worker `runOneJob` with the real handler. The run is `succeeded`, with provider `fake`, prompt `task_assessment.v1`, a 64-hex input fingerprint, job attempt 1, usage and latency.
- **Fingerprint:** it equals the fingerprint of the request the provider actually received. That request carries no id.
- **Events:** exactly `requested`, `started`, `succeeded`, sharing one correlation, with causation chained in that order.
- **Minimisation:** no column of the run and no event payload contains the task or agent description (a sentinel was checked), the job ledger holds no summary, and the job detail is an exact metadata-only string.
- **Task:** unchanged (status, assignee, `updated_at`).
- **Provider:** exactly one call.

**Crash, recovery and at most once:**

| Scenario | Result |
| --- | --- |
| A worker process killed while its call is in flight (TerminateProcess on Windows) | Run `running`, job `leased` at the kill. After expiry, the sweep settles it `indeterminate` / `interrupted`, and a fresh worker drains the queue with **0** provider calls. Without the sweep, the job's next attempt settles it the same way, again with 0 calls. |
| A second process sharing the worker id of a call in flight (review finding AR-03) | It cannot claim or restart the run while the call is in flight. The crash that follows is recovered without a second call. |
| A retried attempt that reaches start holding a stale claim | Start settles the crashed attempt's run; the provider is called once in total. |
| The worker dies after the provider answered, before settlement | The run stays `running`, is recovered `indeterminate`, and there is no second call. |
| The lease runs out during the call | With a 2 s margin: `indeterminate` / `timeout` / `deadline`, one call. With no margin, the lease is already gone at settlement; the sweep settles the run, and it never reads `succeeded`. |
| Settlement fails after a successful call | Whether the lease ran out, or the failure was transient and the runtime scheduled the job's retry, the provider is **not** called again. |
| Every model error category | The TypeScript mirror equals `ops.agent_run_error_status` for every category, and a real run lands each one in the status the database decides. Malformed output is `failed` / `schema_validation`, keeping usage and storing no result. |
| Kill switch, end to end | Refused at request under a global stop (`cancelled`, no job) and at start under an agent stop (0 calls); runs once cleared. |
| Payload forgery across tenants | See §16: refused, the other tenant's run untouched, 0 calls. |
| Pooling | On one backend, the next transaction carries no role, lease, tenant or event provenance, and the run capabilities refuse on it. |
| Graceful shutdown during a call | In process, the provider's own signal aborts, the run is `indeterminate` / `cancelled`, its job settles, and the loop stops within 10 s. A real worker process asked to stop mid-call exits 0 with the same record. |
| State machines | TypeScript and the database agree on all 36 status pairs, in both directions, and on the status set. |

**Concurrency** (`agentRuns.dbtest.ts`):

| Proof | Result |
| --- | --- |
| Idempotency race | Two concurrent requests with one key produce one run and one job, and the second is proven waiting before the first commits. The same key reused concurrently for a different task is refused after the wait and creates nothing. |
| Scope through the typed boundary | Another tenant's task or agent, or another company's agent, is `not_found`; the wrong assignee is `invalid_state`. A leased worker gets a native `42501`, not a domain refusal. |
| A capability holding its job past the lease | While a claim, or a committed `running` run's settlement, is still open past expiry, the reaper, a re-lease and the sweep all skip it; they act once it ends. |
| The sweep beside a held row | A stale running run, and a pending run whose job failed, are skipped while the run row or the job row is held, and settled once released. |
| Kill-switch serialisation | A trip waits for a start in flight, and a later start refuses. A start waits for a trip in flight, and refuses once it commits. The same holds both ways for a request. A trip waits for a clearing of the same target, then records a new active stop. Every wait is proven as `Lock` / `advisory`. |
| Lock-free refusals (AR-07) | With a worker holding a run after its claim, a retry of it and a second job for it are refused without waiting. The worker's start then still returns `running`. |
| Lease runs out while start waits on a lock | The owner holds the task row while a worker's start waits on it (proven through `pg_stat_activity` and `pg_blocking_pids`), and the 3 s lease runs out on the database clock. The start raises `42501` **before any write**: the transaction's write count is unchanged across a savepoint. After rollback the run is `pending`, with no job attempt, no provider and only its `requested` fact. |
| Stop CLI, end to end | Trip, list, a covered run recorded `cancelled`, clear, list, `list --all`, then a request that succeeds. No piece of the connection string appears in any output; a wrong password is reported as `28P01` only. |
| `listExecutionStops` | Active only by default; every stop, newest first, with `includeCleared`. |

**Smoke** (`npm run agent-runtime:smoke`, local and manual only): on the fake provider the run succeeded in one step, with events `requested`, `started`, `succeeded`. With `--live` and no provider configured it printed `{"skipped": …}` and exited 0. **No live provider call was made in Phase 1D.**

**Not yet measured:**
- None of these cases has run in CI.
- On Windows `SIGKILL` is TerminateProcess; only Linux CI exercises the real signal and the SIGTERM stop path.
- Four timing-dependent cases (4a leaves about 0.9 s of prepare slack) can fail on a slow runner but cannot pass wrongly.
- The lock-wait probes need `pg_read_all_stats` to see another role's wait events.

## 20. Mutation testing

### Database, SQL attack suite (single session)

Method: each mutation replaced one function, trigger or grant on the live e2e database in autocommit as `postgres`, from its live definition; the suite ran exactly as `run-db-tests.mjs` runs it; the original was restored at once. A mutation counts as caught only if the error names the assertion that targets it. An `ops` catalogue fingerprint (every function definition with grants, owner and comment; trigger definitions and modes; constraints; policies; relation ACLs; RLS flags) matched the baseline after every one of 89 restores.

- **Coverage pass:** 43 of 47 reverts of the fourteen v2 revisions failed at exactly the named assertion; the other four need two sessions.
- **Adversarial pass:** 16 revisions, 75 mutations including adversarial variants.
  - First run: 10 variants passed the suite undetected. All ten were closed by tightening the suite (N8, N11e, N11j, N14 look-alike types, the H6 probe, the N14d outcome anchor) and re-run: caught.
  - Final: every mutation caught at its named label, except four expected two-session survivors (M03 job share lock, M25 sweep job lock, M30 trip lock order, M34 start lock order) and one equivalent mutation (M63: the contract function never returns NULL).

### Database, two-session guards, and TypeScript runtime (driver-backed suites)

Same method: each SQL mutation applied in autocommit from `pg_get_functiondef` and restored immediately, the definition re-read, and the `ops` catalogue fingerprint compared with the baseline after every restore. TypeScript files were restored byte-identical (sha256). A mutation counts only if a named test fails for the targeted reason.

| Mutation | Caught by |
| --- | --- |
| M03: lease helper without `for share` | both "capability holding its job past the lease" cases (the reaper requeues the job) |
| M25: sweep locks only the run (both passes, and each pass alone) | both "sweep beside a held row" cases, while the job row is held |
| M30: trip takes the kill-switch lock after its insert | "a trip waits for a clearing of the same target" (`OS409`) |
| M34: start reads the stops before the lock | "a start waits for a trip in flight" (returns `running`) |
| M34r: request reads the stops before the lock | "a request waits for a trip in flight" (records `pending`) |
| M28, M32, M35: a party takes no lock | the serialisation case on that side ("finished before seen waiting") |
| AR-07: the retry parent locked `for share`; the bridge locks the run first | the lock-free refusal case (`55P03`) |
| The reaper without `skip locked` | both job-lock cases |
| The idempotency race path returns the existing run without comparing; the race path without `on conflict` | the two concurrent request cases |
| The stop list filter always true, or ignoring `includeCleared` | the CLI case and the list case |
| v1 claim: settles a running run of its own attempt | **survived at first**; now the shared-worker-id case |
| v1 start: answers `running` for a running run | **survived at first**; now the shared-worker-id case and the stale-claim case (provider called twice) |
| Handler calls on a token other than `running` | the unit test, and now the stale-claim case |
| `runOneJob` sends a call error to the failure transaction (job retry) | the lease-deadline, category, malformed-output, shutdown and process-stop cases |
| `runOneJob` completes the job inside prepare, or calls before prepare commits | 16 cases, including the demonstration flow; the kill cases |
| Handler ignores the shutdown signal | **survived at first** (the runtime's abandonment hid it); now the tightened shutdown case asserts the provider's own signal aborted |
| `runWorker` drops the signal | the shutdown case, bounded at 10 s |
| The spawned test worker ignores its stop | **survived at first**; now the real-process stop case |
| The loopback guard removed from the test worker or the fixture | the two loopback cases |
| The lease re-check inside start removed | the lease-runs-out-while-start-waits case (the start answers `running`) |
| The re-check moved after the `running` update | **survived at first** (a rollback erases both orders alike); now the same case, through the savepoint write count |
| The smoke's local-database refusal removed, its same-database comparison disabled, or moved after the pools open | 6, 2 and 5 unit tests |
| The local-database rule: whitespace and bad percent-escapes, `port`/`database`/`dbname` query overrides, a missing database name | 4, 4 and 2 tests |
| The concurrency test worker without its loopback refusal | its remote-refusal driver case |

Four survivors were test gaps, and each was closed with a new or tightened case that was then re-run against its mutation. No migration defect was found.

### Unit-level mutation checks, per stream

Each implementer and reviewer broke its own guards one at a time and restored each file byte-identical (sha256):

| Stream | Mutations | Caught |
| --- | --- | --- |
| Models (implementer + reviewer) | 20 | 20 |
| Worker runtime (implementer + reviewer) | 16 | 16 |
| Domain and CLI (implementer + reviewer) | 9 | 8, and 1 equivalent (a regex length bound that `requireShape`'s separate limit duplicates) |
| Guards, scanner and ESLint (three passes) | 37 | 37 |
| Handler, boot gate, settle tokens (implementer + reviewer + final) | 27 | 27 |
| Seam-review fixes: CLI connection phase, fixed `ModelError` message, live remaining time, recheck after start, no call past the deadline | 5 | 5 |

### ADR 0016 owner-review amendment (2026-09-16)

Same method: each TypeScript mutation was restored from a pristine copy and checked by sha256; each database mutation was restored by re-applying the migration in one transaction and checked against the `ops` fingerprint (`a500ce88…252f`, 61 functions, 25 triggers, 121 constraints, 10 policies). **22 mutations, 22 caught, no survivor.**

| Mutation | Caught by |
| --- | --- |
| T1: `provider_5xx` → `failed` in `errors.ts` | 7 tests: the `errors.test.ts` 5xx case, the provider contract case for the fake and the adapter, the handler's 5xx case, the exhaustive status sweep |
| T2: every status ≥ 500 → `invalid_request` | 10 tests, including the 500–599 status cases, the byte-cap case and the sweep |
| T3: an unlisted 4xx → `invalid_request` (the old fall-through) | 5 tests: the 405/410/418/499 cases and the sweep |
| T4: 503 listed as `invalid_request` | 4 tests, including the sweep (eight known-failure statuses where seven are expected) |
| T5: 502 → `invalid_request` | 3 tests |
| T6: a fetch rejection → `invalid_request` | 4 tests, including the adapter contract's transport case |
| T7: a body broken mid-read → `invalid_response` | 2 tests |
| T8: a 200 that is not JSON → `invalid_response` | 2 tests |
| T9: a 200 over the byte cap → `invalid_response` | 3 tests |
| T10: a 200 naming no terminal status → `invalid_response` | 6 tests: the four no-terminal-status cases, the not-an-object case, the ambiguous-outcome list |
| T11: a terminal `failed` answer's server error → `provider_5xx` | 2 tests, including "records a complete, terminal answer it cannot use as a known failure" |
| T12: `unknown` → `failed` in `errors.ts` | 7 tests |
| The adapter's last-resort catch → `invalid_response` | **survived at first** (review finding 1); now "records a failure nobody classified, after the request left, as unknown and indeterminate" |
| R1: the router records a non-response as `invalid_response` | "records something other than a response as unknown and indeterminate" |
| R2: the router accepts a response with no content | "records a response with no content as unknown, with what the call cost" |
| R3: the router records a response with no content as `invalid_response` | the same case |
| R4: the router treats present `null` content as missing | "still records present content that fails the contract as a known failure", and the existing malformed-output case |
| D1: the function maps `provider_5xx` → `failed` | `agent_runtime.sql` L3 (through the CHECK violation; with L3's row removed, N15a by name); the driver-backed mirror and the real-run case |
| D2: the CHECK accepts `provider_5xx` in both branches | N15b, by name (`ACCEPTED, expected a refusal with SQLSTATE 23514`) |
| D3: the CHECK drops `provider_5xx` from the indeterminate branch | L3 (through the CHECK violation; with L3's row removed, N15c by name) |
| D4: the function and the CHECK back to the pre-amendment mapping | L3, by name |
| The migration's own end state, over six mutated CHECK bodies (both branches, the old mapping, dropped from indeterminate, an extra failed category, no cancelled branch, a wrong cancelled category) | each refused by the migration's assertion; the reviewed body passes |
| The migration's preflight, with a run already recorded `failed`/`provider_5xx` under the old CHECK | refused with its own message; a control run recorded `cancelled` passes |

## 21. Security and adversarial findings

### Migration review, before v2 (18 findings)

| Id | Severity | Finding | Closed by |
| --- | --- | --- | --- |
| AR-01 | Medium | Start checked the lease only on entry and could commit `running` for an expired lease, recording the successor's attempt. | Every run capability share-locks the leased job and requires the lease live on `clock_timestamp()`; N1. The seam review found the "committed after a long lock wait" half still open. The start now re-checks after its waits, before any write; see seam findings #1 and #3 below. |
| AR-02 / EVK-03 | Medium / Low | Start answered `running` for a run already started; complete and fail checked no attempt. | Distinct tokens; another attempt's start settles the run; attempt check; L4, N3, N4. |
| AR-03 | Low | A claim could settle a run whose own attempt was live (shared worker id). | The starting attempt's claim is refused (L4); `OPS_WORKER_ID` now gets a per-process suffix. |
| AR-04 | Low | Sweep and settle used different clocks; a job could succeed while its paid result was dropped. | Sweep locks run and job, skips locked rows, uses the wall clock; `not_running` rolls settle back; N6. |
| AR-05 / EVK-09 | Low / Info | A confirmed trip did not stop a start already reading the stops. | Advisory lock, exclusive for trip and clear, shared for start and request; N7. |
| AR-06 / AR-1 | Low | A worker-supplied `execution_stopped` code aborted settlement. | Reserved codes; N5. |
| AR-07 | Info | Retry parent and bridge locks could deadlock with a worker. | Plain reads before the task lock. |
| AR-08 | Info | The bridge stored a non-canonical run id. | Canonical payload; N9. |
| EVK-01 | Low | A trip racing a clear could return nothing. | `OS409`; N7f. |
| EVK-02 | Low | An active stop could be deleted or truncated. | `ENABLE ALWAYS` delete and truncate guards; N12. |
| EVK-04 | Low | Any fact about a run could become a lifecycle cause. | Type-filtered causation; N8, N14. |
| EVK-05 | Low | Result contract held in one function; outcome text copied to events. | Guard requires valid result; enum-only copy; N13, N14d, I3. |
| EVK-06 | Low | A run could name a stop that did not cover it. | Active and covering stop required; N13. |
| EVK-07 | Low | Stop free text could never be rectified. | Redaction to `[redacted]` only; N11. |
| EVK-08 | Info | A row-security-filtered read would answer "no stop". | `OS403`; N10. |
| EVK-10 | Info | Owner-side forging paths for run facts. | Recorded as owner tripwires (SI-22, SI-23). |

### Stream reviews (each defect fixed with a test that fails without the fix)

- **Models:** strings with U+0000 or an unpaired surrogate passed the contract and would have aborted settlement; token counts above 2³¹−1 and fractional latency could not be stored; one provider string skipped the key check.
- **Worker runtime:** a fractional safety margin, a fractional remaining lease, or a lease above ~24.8 days could crash the run after `running` committed (timer limits); two guards had no test.
- **Guards:** OAuth, refresh and session `sk-ant-` tokens were caught by neither key rule; dynamic `import("node:module")` and case-varied dynamic imports got past the lint boundary; aliases of the global object got past the `process` check; `package.json` and `makefile` were outside the build-input scope; the ESLint boundary had no committed test.
- **Domain and CLI:** the CLI printed connection-phase server messages carrying the user and database name; listed timestamps depended on the session time zone.
- **Handler:** no test covered a NULL agent description, task description or due date, the common case; an unexpected settlement token would have completed the job (fixed to fail closed).
- **Test-suite defects found while running the SQL suite:** two cases read a run with a snapshot taken before it existed, and one read the run table as the worker. These were test bugs, not migration defects.
- **Driver-backed proofs:**
  - The test workers and fixture accepted any `OPS_WORKER_DATABASE_URL`, the production worker's variable. A shell exporting it would have made fake-provider workers answer a real queue with canned results. They now refuse anything not on this machine, before connecting.
  - Four mutations survived as test gaps; each was closed (§20).
- **Final fixes:**
  - The local-database rule could still be bypassed three ways: a leading space (`pg` then dials another host), a `?port=` override (it reached the other working copy's port), and a URL with no database name. All three are refused now, with an agreement test against `pg`'s own parser.
  - The lease-recheck case could not tell a refusal before the write from one after it; it now counts writes across a savepoint.
  - Spawned test workers no longer inherit model-provider variables.

### Seam review (read-only, four lenses, one skeptic per finding)

Four independent finders (at-most-once, tenancy, secrets, documentation claims) read the whole Phase 1D surface without database access. Each finding went to a skeptic told to refute it. **12 findings; 7 confirmed, all Low or Info; none breaks at-most-once, tenancy or secrecy.**

| # | Lens | Finding | Verdict | Disposition |
| --- | --- | --- | --- | --- |
| 1, 3 | at-most-once, tenancy | The lease was checked when `start_agent_run` began, and the call budget before it. A long lock wait inside the start could commit `running` with the budget spent, or after the lease ran out, and the call then went out on a deadline already past, because `AbortSignal.timeout(0)` fires only on a later timer tick. At most one call still held. | Low | **Fixed in three layers:** (1) the start re-checks the lease after its waits, before any write; (2) the handler re-reads the time left after the start and rolls back below 5 s; (3) the runtime starts no call past its deadline. Each has a two-session or unit test, and each is mutation-checked. |
| 5 | secrets | The stop CLI printed connection refusals outside classes 08, 28 and 3D (53300, 55000, a connect-time 42501), which name the role or database. | Low | **Fixed:** any error before the transaction opens prints its code only; three tests, mutation-checked. |
| 7 | claims | SI-31's "serialised with tripping" had no two-session proof; N7b checks which lock is held, not that it is taken before the read. | Low | **Fixed:** SI-31 now cites the two-session serialisation cases, which catch M30, M34 and M34r. N7b and N7c say what one session proves. |
| 9 | claims | PERMISSIONS §11 said a lease expiring during the transaction is refused; each capability checked it only when it began. | Low | **Fixed** by #1/#3, and PERMISSIONS §11 now states exactly what is checked when. |
| 11 | claims | "ModelError messages are fixed text" was false: the message appended a code a provider may have reported. | Info | **Fixed in code:** the message is the category's fixed text alone; the code stays its own field; mutation-checked. |
| 12 | claims | ADR 0016 §4 listed `request_agent_run`'s checks in an order the code does not run. | Info | **Fixed:** ADR 0016 §4 now lists the code's order. |
| 10 | claims | SECURITY.md said the `VITE_` source test covers "all tracked source"; it covers build inputs, which is what SI-33 states. | Refuted (wording) | Wording corrected. |
| 2 | at-most-once | A shutdown during prepare commits `running` for a call never sent. | Refuted | Already recorded (§27 item 9). |
| 4 | tenancy | The prompt is built from an unlocked claim snapshot, so a raw owner text edit racing the start is not honoured. | Refuted | No service edits task or agent text; the start's gates are status, assignment and stops. Becomes a requirement if a text-editing or rectification service is added. |
| 6 | secrets | Worker logs name the database host and login role on connection failures. | Refuted | Neither is a credential; the project ref is public. Recorded for a future single logging policy. |
| 8 | claims | Under an active stop, a run a worker refuses for a missing route is recorded `configuration`, not against the stop. | Refuted | The stop is read at request and at start, as documented; no call is possible. |

### Owner review of ADR 0016 (2026-09-16)

The amendment went through the mutation pass above and an adversarial review of the classification. **Verdict: PASS.** No path was found where an outcome that may have run is recorded `failed`.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | The adapter's last-resort catch had no test. | **Fixed:** a test, mutation-checked. |
| 2 | The router recorded a provider contract breach (not a response; no content) as `invalid_response`, a known failure. | **Fixed:** `unknown` / `provider_contract`, with what the call cost; three tests, four mutations caught. |
| 3 | The migration asserted the function's mapping but not the CHECK body. | **Fixed:** the end state reads the stored CHECK body and checks every category's branch and each branch's size. |
| 4 | An existing `failed`/`provider_5xx` row would make the new CHECK unaddable with a bare constraint error. | **Fixed:** a preflight stops with a clear message. None can exist outside a development database. |
| 5 | Some provable-A outcomes (an abort before sending, a call never started past its deadline) are recorded indeterminate. | **Kept:** the safe direction; ADR 0016 §2 now says so. |
| 6 | Documents called the amendment committed before the commit existed. | **Resolved** by the commit itself. |
| 7 | DECISIONS.md omitted "never called" from the rule. | **Fixed.** |
| 8 | Report counts and sections were stale. | **Fixed** here (§20, §22–§25). |
| 9 | ADR 0016 §2 did not place redirects (`transport`) or a call never started past its deadline (`timeout`). | **Fixed.** |
| 10 | The SDK retry claim was unverified. | **Checked** against the openai-node README on 2026-09-16: connection errors, timeouts, 408, 409, 429 and 5xx are retried twice by default, and `maxRetries` is configurable per client and per request. |
| 11 | A describe title in the adapter tests still said a 200 that cannot be used is `invalid_response`. | **Fixed:** renamed to a neutral title. |

## 22. Test counts

| Suite | Result |
| --- | --- |
| Unit, `functions` project (engine, models, handlers, CLI, static guards, invariants) | 40 files, **1000 passed** (983 when Phase 1D was built; the owner-review amendment added the rest) |
| Unit, `claude` project | 43 files, **494 passed**, 1 skipped (a stale worktree under `.claude/worktrees/`, created 2026-09-12 and git-excluded, adds 54 failures when not excluded; it is not this repository's code) |
| Unit, `app` project (real Chromium, run after the database work finished) | 30 files, **234 passed**, 1 skipped |
| Database suites, `npm run test:db` | **10 passed**: `agent_runtime.sql` (new), `company_domain_core.sql`, `ops_execution_core.sql`, `owner_session_pool.sql`, `rls_tenant_isolation.sql`, `worker_tenant_context.sql`, `jobLeasingConcurrency.mjs`, `opsDataApiExposure.mjs`, `ownerSessionPool.mjs`, `referenceData.mjs` |
| Driver-backed suites, `npm run test:db:engine` | 6 files, **85 passed**: `agentRunRuntime.dbtest.ts` 23 (new), `agentRuns.dbtest.ts` 19 (new), `workerRuntime.dbtest.ts` 21, `companyOs.dbtest.ts` 10, `pooling.dbtest.ts` 6, `concurrency.dbtest.ts` 6 |
| Static migration guard and schema reproducibility | 142 passed (inside the `functions` count) |
| Security invariants | 41 checks passed: 33 invariants (SI-01 to SI-34, SI-07 retired), every enforcement marker present, and the document in sync with the code |

Baseline before Phase 1D: 9 database suites and 42 driver-backed cases, all green.

The owner-review amendment (2026-09-16) re-ran the `functions` project, the static guards, the invariants, and the database and driver suites after a clean reset. It changed no file in the `claude` or `app` projects, so their counts are from the Phase 1D build and were not re-run for it.

## 23. `db reset`

**Final:** `npx supabase db reset --workdir .supabase-e2e --local` succeeded on 2026-09-16, applying every migration including `20260914120000_agent_runtime.sql`, the owner-review amendment `20260916120000_agent_run_ambiguous_provider_failures.sql`, and the seed. The first Phase 1D reset was on 2026-09-14. Its end-state assertions passed, so the apply did not abort. Before the reset, every migration under `supabase/migrations/` was byte-compared with its `.supabase-e2e` copy, with no difference. The full `test:db` and `test:db:engine` runs above followed it.

Resets during the phase:
- **Every applied revision** (v1, v2, and v2 with the start re-check) was applied through a clean reset before its suites ran.
- **The mutation campaigns** reset at their start and end, and after any restore they could not verify by fingerprint. Every restore in fact verified.

**Nothing left behind:** after the final driver run, `ops.jobs`, `job_events`, `agent_runs`, `execution_stops`, `task_jobs`, `tasks` and `worker_instances` are empty. The seeded development baseline is unchanged: 6 events, 2 agents, 1 company, 1 tenant. Measured with one query after the run: `jobs=0 job_events=0 agent_runs=0 execution_stops=0 task_jobs=0 tasks=0 events=6 agents=2 companies=1 tenants=1 worker_instances=0`.

## 24. Build, secret scan and guards

| Check | Result |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run scan:build` | 18 text files, **0 blocking, 0 advisory** |
| `npm run check:production-scope` | OK: 5 reviewed functions, reviewed dependencies only, no generic SQL endpoint, no development seed on a remote path |
| `node scripts/dev-signing-key.mjs` | development signing key confined to local tooling |
| `npm run typecheck` | exit 0 (covers `engine/`) |
| `npm run lint` | exit 0, **0 errors**. Its 64 warnings are all unused-disable directives inside the stale, git-excluded `.claude/worktrees/loving-mendel-123ece` copy, none in the repository's own files. |
| Prettier on every changed or new file | 65 code files and every changed document: all formatted |
| `npm run check:local-exposure` | OK: every Supabase CLI stack, 20 containers, 16 published bindings, loopback only on Docker and on the host |
| Key-shaped literals in touched files | none (`sk-` plus 20 or more key characters). At commit time three test fixtures in `engine/models/errors.test.ts` and `routingConfig.test.ts` were still literals; they were changed to concatenation, and those two files were re-run (27 passed). No other file changed after the final validation. |
| Static migration guard + schema reproducibility | 142 passed (inside the `functions` count) |

## 25. CI status

**Pending the owner's push.** The four Phase 1D commits and the ADR 0016 owner-review commit are local on `feature/clinical-phase-1`; pushing them runs `check.yml`. Expected pre-existing reds, unrelated to Phase 1D: `e2e-test` and Prettier, as on every run since the Phase 1C baseline.

## 26. ADR changes

| ADR | Change |
| --- | --- |
| [0016](adr/0016-agent-runs-and-model-providers.md) | **New; Accepted by the owner on 2026-09-16**, with two amendments: ambiguous provider outcomes, a 5xx included, are `indeterminate`, and the SDK rationale is corrected. Agent runs, at-most-once call, provider boundary, router, output contract, usage without cost, the minimal kill switch; revised after the adversarial review (attempt binding, lock serialisation, reserved codes, stop immutability). |
| [0010](adr/0010-cost-control-and-kill-switch.md) | Addendum 2026-09-14: which parts the minimal agent-run stop builds, and which remain owed (UI, lease-time refusal for every kind, integration and tool scopes, budgets, spend ceiling). Status unchanged: Proposed. |
| [0015](adr/0015-company-os-domain-core.md) | Addendum 2026-09-14: the allowlist gains `agent_run.execute`; `agent_run` becomes a reserved namespace and an event subject; six DEFINER capabilities; still no model configuration on agents. |
| [0003](adr/0003-identifier-strategy.md) | Dated note: a configured `OPS_WORKER_ID` gets a per-process suffix. |
| [DECISIONS.md](DECISIONS.md) | Row for ADR 0016, Accepted. |

## 27. Remaining risks

1. **Provider data processing is live.** Task and agent text leaves for the provider; `store: false` does not remove abuse-monitoring retention. BASELINE Q8 (multi-tenant processor roles, LGPD) must be decided before a hosted tenant sends real task text. Until then, synthetic data only.
2. **No cost, budgets or spend ceiling.** Usage is recorded, cost is not; ADR 0010 Decisions 3 and 4 remain owed before autonomous or high-volume execution.
3. **At most once, not exactly once.** A crash or a failed settlement makes a run `indeterminate` even when the call succeeded, and a paid result can be discarded. A person decides on a retry.
4. **The kill switch does not interrupt a call in flight**, has no UI, and does not refuse leasing other job kinds.
5. **Prompt injection is expected input.** A result can carry injected text; nothing acts on it in Phase 1D, and any future reader that acts on results inherits the risk.
6. **Provider error codes are stored as reported**, up to 100 characters, if they fit the code shape.
7. **The build scan reads provider names through source maps**; the older `assigned-server-secret` rule still misses prefixed and JSON-quoted forms of its existing names.
8. **`runOneJob.ts` is near the 800-line ceiling**; the `external_call` flow should move into its own module before it grows.
9. **A shutdown that lands during prepare** records `indeterminate` for a call that never left the process: safe, pessimistic.
10. **Unchanged from earlier phases:** SI-06 (edge functions as `service_role`), ADR 0008's registry publication scope, the stale `.claude/worktrees/` copy that breaks an unfiltered `claude` test run.

11. **Nothing here has run in CI.** On Windows, `SIGKILL` is TerminateProcess and only the stdin stop channel runs; Linux CI exercises the real signals. Four timing-dependent driver cases can fail on a slow runner but cannot pass wrongly. The lock-wait probes need `pg_read_all_stats`, and the write-count proof needs `track_counts` (the default).
12. **Waits after the lease re-check.** The `running` update and its event insert take foreign-key share locks after the check, so an owner session holding `ops.tenants` `FOR UPDATE` could still delay a start past it. The handler's time-left check still bounds the call itself.
13. **The smoke's race.** A job enqueued between the smoke's empty-queue check and its lease would be answered by the smoke's provider. Fake mode is refused except against a database on this machine, which confines that race to local development data.
14. **Driver test files exceed the size guideline:** `agentRunRuntime.dbtest.ts` is about 1 660 lines and `agentRuns.dbtest.ts` about 1 250, against an 800-line maximum. Split them by concern before they grow.
15. **Minor, recorded:**
    - `agentRuns.dbtest.ts` spawns the stop CLI with the inherited environment (it reads no model configuration).
    - A bracketed IPv6 loopback URL passes the local-database rule, but `pg` probably cannot dial it (not measured).
    - Worker logs name the database host and login role on connection failures, where the stop CLI withholds them (seam finding #6: not a credential, but two policies).

## 28. Proposed Phase 2A scope

> **Status (2026-09-16, owner):** a proposed follow-up list only, **not accepted** as the next phase. The next major milestone will be decided in a separate roadmap review, aimed at a real, testable clinic flow. Nothing below is scheduled.

**Theme: make agent runs safe to leave on.** Phase 1D proves one run is bounded, isolated and at most once. Phase 2A should make many runs affordable, stoppable everywhere and inspectable, still with no tool, integration or autonomy. Deterministic throughout; the only model call remains Phase 1D's.

1. **Review gate.** The owner reviews the ADR 0010 addendum (ADR 0016 was accepted on 2026-09-16). Phase 1D is committed and verified by CI. BASELINE Q8 (processor roles, provider retention, data classification of task text) is decided and recorded before any live provider receives non-synthetic text.
2. **A versioned price source, as data.** A reviewed table of per-provider, per-model token prices with effective dates, shipped as reference data (SI-25), never a constraint. A run's cost is computed in the settling transaction only when a price covers it, and is NULL otherwise.
3. **Budgets** (ADR 0010 Decision 3), per tenant, company and agent, daily and monthly. They are checked deterministically at request and again at start, under the same serialisation as the stop. A refusal is recorded like a stop refusal. An `indeterminate` run counts at its ceiling (its `max_output_tokens` and input size), never at zero.
4. **A global daily spend ceiling** (ADR 0010 Decision 3) that trips a global execution stop automatically, recorded as a system trip with its reason. Clearing it stays a human act.
5. **Kill switch completion.** Lease-time refusal for every job kind, settled without consuming an attempt (ADR 0010, Phase 1C addendum), so a stop also holds work that is not an agent run. Integration and tool scopes stay unbuilt until a tool exists.
6. **An owner-only operator view.** A CLI, not a UI, over runs, stops, usage, cost and `indeterminate` runs awaiting a decision, including an explicit "request a retry" act that creates a new run with lineage. No tenant-facing reader: a tenant-scoped or opaque cursor is designed in an ADR first (SI-26).
7. **Domain idempotency and lineage residuals** (PHASE_1C_REPORT Appendix A items 7–8). The Phase 1C create services become idempotent, and the caller-declared `correlation_id` on the Phase 1C owner services is removed or bound to the same trust model as agent runs.
8. **Runtime hygiene.** Move the `external_call` flow out of `runOneJob.ts` without changing behaviour, proven by the existing unit, driver and mutation suites.

**Explicitly not in Phase 2A:** the Tool Gateway or any tool, WhatsApp, CRM-writing agents, Google Ads, browser control, RAG or memory, multi-agent delegation, autonomous loops or event-triggered runs, the approval engine, any UI, and clinical data.

---

## Classification

# READY FOR PHASE 2A — pending CI

**Why READY:**
- Every Phase 1D deliverable exists and is proven.
- Every final gate is green on a clean database: 10 SQL suites, 85 driver-backed cases, 1000 + 494 + 234 unit tests, typecheck, lint, build, secret scan, production scope, signing key, local exposure, and invariant sync.
- Every load-bearing guard was mutation-tested and caught by a named assertion. The survivors were closed, or are recorded as equivalent.
- Four independent adversarial passes found no Critical or High finding, and every confirmed Medium and Low was fixed with a test that fails without it.
- At most one provider call per run holds through real worker processes killed mid-call.

**What this classification does NOT claim, and what must happen first:**
1. **CI has not run.** The commits are local and not yet pushed. The first CI run must be green apart from the pre-existing `e2e-test` and Prettier reds before this reads "CI VERIFIED".
2. **ADR 0016 is Accepted** by the owner (2026-09-16), with the ambiguous-failure amendment. The ADR 0010 addendum is still unreviewed.
3. **No live model call was made.** The OpenAI adapter is proven against its contract suite and a fake transport, not against the live API; no key exists here and none was requested.
4. **BASELINE Q8 is open.** Until it is decided, only synthetic task text may reach a live provider (§27 item 1).
