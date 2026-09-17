# ADR 0010 — Cost control: per-run ledger, budgets, and a fleet-wide kill switch

**Status:** Proposed · **Date:** 2026-09-11

## Context

The brief requires cost accounting "from the beginning" and forbids accidental runaway API costs. `ARCHITECTURE.md` §7 specifies the ledger (provider, model, token counts, cost, agent, department, task, workflow) and per-agent daily/monthly/per-task budgets. `ROADMAP.md` Phase 4 carries `ops.budgets` with warn/throttle/fallback/require-approval behaviour.

The gap found on 2026-09-11: **per-agent budgets do not bound the fleet.** Twenty agents each inside budget, a retry storm, or a workflow that spawns runs in a loop all stay within every per-agent limit while the total is unbounded. The only control that stops that was mentioned exactly once in the whole document set — inside a Phase 4 *Risks* note ("Budgets and a kill switch land in this phase, not later") — and appeared in no Scope, no Tests, no Acceptance list, and nowhere in `ARCHITECTURE.md`. A control that is a sentence in a risk column does not exist.

There is no LLM provider dependency in `package.json` today, so this is decided before the first token is spent — the cheapest possible moment.

## Decision

1. **The cost row is written in the same transaction as the run**, never asynchronously and never best-effort. An unrecorded cost hides every other cost problem, so a run that cannot record its cost is a failed run. This includes runs that error mid-flight: a provider error still writes what was spent.
2. **A single, deterministic, fleet-wide kill switch** that (a) is enforced in the worker's pre-flight, outside any prompt; (b) halts new `agent_runs` across every tenant and department at once; (c) is reachable by the owner in one action from the Phase-1 UI *and* from a CLI that does not depend on the UI being up; (d) has a test that trips it and asserts the next run is refused.

### Kill-switch scopes and semantics *(added 2026-09-11, Phase 0.5 brief, Workstream I)*

**Scopes**, evaluated most-specific-first but with **any** matching stop winning — a switch can only ever subtract capability:

| Scope | Stops |
| --- | --- |
| `global` | every autonomous external action, every tenant |
| `company` (tenant) | one tenant's automation |
| `department` | one department within a tenant |
| `agent` | one agent definition |
| `integration` / `tool` | one external capability everywhere (e.g. all WhatsApp sends), across every agent |

The integration scope is the one that matters most in an incident: the usual real-world need is *"stop messaging patients"*, not *"stop agent 7"*.

**Invariants:**

- **Deny wins.** If any scope covering an action is stopped, the action is refused. There is no override flag, and no "force" parameter — an escape hatch is how a kill switch becomes advisory.
- **Fail closed on an unreadable switch.** If the state cannot be read (database unreachable, malformed row), the answer is *stopped*, not *running*. A kill switch that fails open during an outage is worthless precisely when it is needed.
- **Enforced in deterministic pre-flight**, in the worker, before any provider call. Never by instructing a model to stop — a prompt is not a control (security principle 1).
- **Observability and administration stay up.** The switch blocks *new autonomous external actions*. It must not block reads, the UI, the audit log, or the owner's ability to inspect and un-trip it — an operator blinded by their own kill switch cannot diagnose the incident.

**Already-running jobs.** Tripping the switch does not kill in-flight work mid-transaction, because a half-applied external action is worse than a completed one. Instead: (a) no new job is leased; (b) a running job completes its current step and then stops at the next pre-flight check, which every step boundary performs; (c) any step whose next act is an *external* side effect re-checks immediately before it and aborts there, leaving the job in a resumable state; (d) the trip is recorded with who, when, why, and every action refused while it was active.

**Un-tripping is a deliberate, audited act** — the same record as tripping. A switch that anything other than a human can clear is not a control.

### Implementation status

**Designed, not built.** The enforcement point is the worker's pre-flight, and there is ~~no worker, no `ops` schema and~~ no agent runtime yet *(corrected 2026-09-13: the `ops` schema exists since Phase 1A and the worker since Phase 1B)* — all Phase 2–4. Implementing the evaluator now would mean either inventing a home for engine code (open question Q13, deliberately undecided) or writing a module with no caller and no way to prove it enforces anything. Both are worse than an explicit, dated gap. The obligation is recorded here and in the Phase 0.5 report; the first phase that can run an agent must ship this with it, per sequencing rule 3.
3. **A global daily spend ceiling trips the same switch automatically.** Per-agent budgets remain, and are the diagnostic layer; the global ceiling is the safety layer.
4. **Budgets and the kill switch ship in the same phase as the agent runtime**, with their own acceptance criteria — not as a follow-up. Sequencing rule 3.
5. **Model routing starts at the cheapest tier that can do the job and escalates only on stated triggers**, so cost control is structural rather than a limit that gets hit.

## Alternatives

- **Provider-side spend caps only.** Rejected as the primary control: they are per-key, coarse, often lagging, and give no per-agent attribution to diagnose *what* ran away.
- **Per-agent budgets alone.** Rejected — the failure mode above is precisely the one they cannot see.
- **Asynchronous cost aggregation from provider billing exports.** Rejected as the system of record; useful only as a reconciliation check against the ledger.
- **Kill switch as an environment variable requiring a redeploy.** Rejected — the moment it is needed is the moment a deploy is slowest and riskiest.

## Consequences

- `ops.agent_runs` is on the write path of every invocation, so its insert must be cheap and must not become a contention point.
- A kill switch checked per-run pre-flight is one more read per run; keep it in a single row a worker can cache briefly, and accept a bounded delay in *arming*, never in *enforcing*.
- Tripping the switch is an incident with an audit trail: who tripped it, when, why, what was refused while it was active.
- Cost by agent / department / task / workflow / model must be queryable from day one of the runtime — the dashboards the brief names are then a view, not a migration.

---

## Addendum 2026-09-12 — `company` no longer means tenant (Phase 1C)

The scope table above has a row "`company` (tenant)". Since Phase 1C those are two different things ([ADR 0015](0015-company-os-domain-core.md)): a **tenant** is the isolation boundary, and a **company** (`ops.companies`) is an organisational partition inside a tenant, of which one tenant may hold several. The kill switch therefore needs both scopes:

| Scope | Stops |
| --- | --- |
| `tenant` | every autonomous action of one tenant, across all its companies |
| `company` | one company's automation inside a tenant |

Department and agent scopes now name real rows (`ops.departments`, `ops.agents`). Two constraints Phase 1C adds for whoever builds this:

- **`ops.agents.status` is not the kill switch.** It is lifecycle configuration (`active | inactive`), changed without the audit and deny-wins semantics this ADR requires.
- **Enforcing a company, department or agent scope at lease time** needs the job's organisational context, which only `ops.task_jobs` holds. Resolving it there is allowed. A refusal must be recorded as a settlement that does **not** consume one of the job's attempts — today every lease increments `attempts`, so a scoped stop would otherwise retire a job to `failed` within its backoff window instead of leaving it resumable.

---

## Addendum 2026-09-14 — the minimal agent-run stop is built (Phase 1D, owner decision)

**Owner decision (2026-09-14):** Phase 1D is the first phase that can invoke a model. No kill switch existed, so building the agent runtime without one would have broken sequencing rule 3 and Decision 4. The owner chose to build the part of this ADR that agent runs need, and nothing broader. The design is recorded in [ADR 0016](0016-agent-runs-and-model-providers.md) §11; this addendum records which parts of this ADR it discharges.

| This ADR | Phase 1D |
| --- | --- |
| Deterministic pre-flight, outside any prompt (Decision 2a, "Enforced in deterministic pre-flight") | **Built.** `ops.start_agent_run` evaluates the stops in the transaction that commits `running`, before the provider call. `ops.request_agent_run` evaluates them again at request time. Both read the stops only after taking a shared advisory lock that trip and clear take exclusively, so a trip that has returned is seen by every later start. |
| Halts new agent runs across every tenant at once (2b) | **Built** for agent runs: a `global` stop. |
| Scopes (tenant and company addendum) | **Built:** `global`, `tenant`, `company`, `department`, `agent`. **Not built:** `integration` / `tool`, because nothing in Phase 1D calls a tool. |
| Deny wins; no override or force parameter | **Built.** Any active stop covering a run refuses it. No function or CLI flag overrides a stop, and the CLI parser refuses unknown flags. |
| Fail closed on an unreadable switch | **Built.** `ops.active_execution_stop` raises on a missing coordinate. An error reading the stops aborts the transaction that would have recorded `running`, so no call follows. |
| Observability and administration stay up | **Holds.** A stop refuses new runs only. It does not block reads, the audit trail, the queue, or the owner's ability to inspect and clear it. |
| Running work: stops at the next pre-flight, and an external side effect re-checks immediately before it | **Built** at the one boundary that exists: the check runs immediately before the model call. A call already in flight when a stop is tripped completes; see "Bounded delay" below. |
| The trip is recorded with who, when and why, plus every action refused while it was active | **Built.** `tripped_by`, `tripped_at` and `reason` are on the stop row. Every refused run is recorded `cancelled` / `refused` / `execution_stopped` with the stop's id. |
| Un-tripping is a deliberate, audited act; nothing but a human clears a stop | **Built.** `ops.clear_execution_stop` records `cleared_by`, `cleared_reason` and `cleared_at` on the row. A cleared stop is never rewritten, and no code path clears one. |
| Reachable in one action from a CLI that does not depend on a UI (2c) | **Built:** `npm run execution-stop -- trip --scope global --reason … --actor …`, run with the owner connection (`ADMIN_DATABASE_URL`). |
| Reachable from the Phase-1 UI (2c) | **Not built.** No UI exists. |
| A test that trips it and asserts the next run is refused (2d) | **Built.** Per scope, in `supabase/tests/agent_runtime.sql` K and the driver-backed agent runtime suite. |
| No new job is leased while stopped (running jobs, a) | **Not built.** Lease-time refusal for every job kind needs the non-consuming settlement the 1C addendum describes. For agent runs the effect is equivalent: a covered run is cancelled before any call, and its job completes without a provider request. |
| The cost row is written in the same transaction as the run (Decision 1) | **Partly built.** Usage (tokens, latency, provider ids) is written in the transaction that settles the run. There is no cost column: no versioned price source exists (ADR 0016 §10). An `indeterminate` run has unknown usage. |
| Per-agent budgets; global daily spend ceiling (Decisions 3, 4) | **Not built.** Both need a price source. They remain owed before autonomous or high-volume execution. |
| Model routing starts cheapest and escalates only on stated triggers (Decision 5) | **Partly built.** Routing is deterministic by capability tier (ADR 0016 §9). No escalation trigger is defined, so there is no escalation. |

**Bounded delay, stated.** A stop tripped after `ops.start_agent_run` commits does not interrupt a call already in flight. That call is bounded by its route timeout and the lease-derived deadline, and its result is recorded. This is the "bounded delay in arming" the Consequences section accepts: enforcement is exact at the start boundary, and a half-applied external action is not produced.

**Status unchanged: Proposed.** Accepting this record, or amending it to match what Phase 1D built, is an owner decision.

---

## Addendum 2026-09-17 — budgets, the spend ceiling and the lease-time switch (Phase 1D.1)

[ADR 0017](0017-runtime-governance.md), accepted by the owner on 2026-09-17, builds the parts of this ADR that Phase 1D left owed. It does so before the runtime is connected to any real business flow. This addendum records what it discharges, in the same shape as the 2026-09-14 table.

| This ADR | Phase 1D.1 |
| --- | --- |
| The cost row is written in the same transaction as the run (Decision 1) | **Built.** The database derives a run's reservation when it starts, and its estimate and charge when it settles. Each is written in the transaction that records the transition, from the run's usage and the price version recorded at its start. A provider error still records what was spent. An outcome whose cost is unknown stays charged at its reservation, never at zero. |
| Cost by agent, department, task, workflow and model is queryable (Consequences) | **Built for runs**, as columns on `ops.agent_runs`: `price_id`, `reserved_cost_micros`, `estimated_cost_micros` and `charged_cost_micros`. There is no workflow entity yet. `npm run ops -- runs` and `spend` read these columns. |
| A global daily spend ceiling trips the same switch automatically (Decision 3) | **Built.** It trips a global stop as the actor `system:spend_ceiling` when the active ceiling version is exhausted by settled spend. That means either its settled total reached the ceiling, or the active ceiling version refused a run today that settled spend alone could not absorb. Reservations of calls still in flight never trip it. The stop records its origin (`system`), so it never absorbs or clears an owner's stop. Nothing clears it automatically: a new day, a new ceiling version, a new price or lower spend leaves it active, and only a person clears it (owner decision D, 2026-09-17). |
| Per-agent budgets (Decision 3) | **Not built.** Tenant budgets and optional company budgets are built. A tenant budget must exist, as the global ceiling must; every configured limit, a company's included, must absorb a run's worst-case reservation under per-scope locks before the run starts. Agent and task budgets remain owed; they are the diagnostic layer. |
| Budgets and the kill switch ship with the runtime (Decision 4) | **Now satisfied** for the global ceiling and tenant budgets. With either missing, every run is refused (`spend_ceiling_unconfigured`, `budget_unconfigured`, or `budget_exhausted` on the global version when the ceiling is already spent). There is no default and no fallback (owner decision A, 2026-09-17). |
| Integration / tool scope | **Built generically:** the `job_kind` scope stops one external job kind, for one tenant or for all. It has no integration-specific logic. A tool scope waits for a tool. |
| No new job is leased while stopped (Running jobs, a) | **Built for every job kind that is not internal maintenance.** `ops.lease_job` passes over a covered job, which stays queued and **consumes no attempt**. This is the non-consuming settlement the Phase 1C addendum asked for. Internal kinds keep running, because administration stays up. |
| A step whose next act is external re-checks immediately before it (Running jobs, c) | **Built into the runtime** for every `external_call` handler. A stop found before the call discards the handler's durable start, and the job is returned to the queue with its attempt restored and a `deferred` job event naming the stop. An agent run is held at its start: `ops.start_agent_run` finds the stop, answers `stopped` and writes nothing, the run stays `pending`, and the runtime defers the job the same way, in the same transaction and under the kill-switch lock the start holds. The same run starts after an explicit clear (owner decision B, 2026-09-17). A request made while a stop covers it is still recorded as a cancelled run naming the stop, with no job. |
| Enforcing company, department or agent scope needs the job's organisational context (Phase 1C addendum) | **Built.** Coordinates come only from facts fixed when the job was requested: an agent run's company, department and agent, or the requesting task's company. An unknown coordinate fails closed inside its tenant. |
| Reachable in one action from the Phase-1 UI (2c) | **Not built.** There is still no UI. `npm run ops` is an operator view, read-only by default with three narrow governance acts (record a price, set or retire a limit), and `npm run execution-stop` trips and clears. |
| Model routing starts cheapest and escalates only on stated triggers (Decision 5) | **Unchanged.** Routing is deterministic by tier, and there is no escalation. |

**Status unchanged: Proposed.** The owner's 2026-09-17 review accepted ADR 0017, not this record. Accepting this record, or amending it, is an owner decision.
