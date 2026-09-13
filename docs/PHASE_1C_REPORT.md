# PHASE 1C REPORT

## Company OS domain core — tenant, company, department, agent, task, event

**Dates:** built 2026-09-12, signoff pass 2026-09-13 · **Branch:** `feature/clinical-phase-1` · **Base:** `7d41efff` · **Commits:** see §22

**CI:** **VERIFIED** — [run 34770182266](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34770182266) on `e160debb`. Green: database security and reproducibility, the Phase 1C SQL suites, the Data API `ops` probe, the worker runtime, unit tests, typecheck, ESLint, build, the secret scan and the migration/security guards. `e2e-test` and Prettier are red, identical to the baseline [run 34715191426](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34715191426) on `7d41efff`, so the run's overall conclusion is `failure`, as the baseline's was. See §22.

Phase 1C gives the Company OS its first organisational model. It is deterministic end to end: no LLM, no prompt, no model provider, no agent memory, no Tool Gateway, no WhatsApp, no Ads, no browser automation, no approval engine, no UI. [ADR 0015](adr/0015-company-os-domain-core.md) records every decision and the alternatives rejected. SI-21 to SI-24 in [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md) are the properties that must now hold.

**How it was built.**
1. A design was drafted from the repository, then attacked before any SQL existed: a six-lens design review with two verifiers produced 88 findings and changed several decisions.
2. The built surface was attacked again by an abbreviated adversarial pass restricted to the new surface (§17).
3. Every load-bearing invariant was mutated on a live database (§16).

The signoff pass on 2026-09-13 re-ran all of it from a clean database. It found one real gap (M16, §16) and closed it.

---

## 1. Schema and domain architecture

```
ops.tenants                          the isolation boundary (Phase 1A)
  └─ ops.companies                   a business entity; a tenant may hold several
       ├─ ops.departments            an organisational unit of one company
       │    └─ ops.agents            configuration + identity of a virtual employee
       ├─ ops.tasks                  business work (parent -> child, same company)
       │    └─ ops.task_jobs ──────► ops.jobs     domain -> execution, never the reverse
       └─ ops.events                 durable business facts, derived from the rows above
```

| Distinction | What keeps it |
| --- | --- |
| Tenant ≠ Company | `tenant_id` on every row; a company is a partition inside a tenant, never an isolation boundary |
| Agent ≠ Worker | `ops.agents` is configuration; the worker is a process and holds no privilege on it |
| Task ≠ Job | separate tables; `ops.task_jobs` is owned by the domain; creating a task enqueues nothing; settling a job changes no task |
| Event ≠ Audit log | `ops.events` holds business facts; execution audit stays in `ops.job_events` |

| Piece | Where |
| --- | --- |
| Tables, constraints, guards, event emission, services, grants, 13 end-state assertions | `supabase/migrations/20260912200000_company_domain_core.sql` (hand-written, idempotent) |
| Typed boundary: services, error mapping, state-machine mirror | `engine/domain/companyOs.ts`, `errors.ts`, `taskStateMachine.ts` |
| Attack suite (SQL) | `supabase/tests/company_domain_core.sql` |
| Data API attack (HTTP) | `supabase/tests/opsDataApiExposure.mjs` |
| Driver-backed tests | `engine/domain/companyOs.dbtest.ts` |
| Static guard extensions | `supabase/invariants/{parse,rules,replay,doBlocks,sqlStatements}.mjs` |
| Development bootstrap | `supabase/seed.sql`: a `dev` tenant, company `psychology-clinic`, departments `reception`/`marketing`/`operations`, agents `reception-agent`/`marketing-analyst`, all created through the domain functions |

**SQL functions (23, every one revoked from PUBLIC).**

- **Services (11, SECURITY INVOKER, explicit tenant scope):** `create_company`, `set_company_status`, `create_department`, `set_department_status`, `create_agent`, `set_agent_status`, `create_task`, `assign_task`, `transition_task`, `record_event`, `request_task_execution`.
- **Helpers (6):** `derived_event_namespaces`, `task_status_transitions`, `task_transition_allowed`, `task_executable_kinds`, `push_event_context`, `pop_event_context`.
- **Trigger functions (6):** `guard_update_immutable`, `refuse_update`, `guard_task_insert`, `guard_task_update`, `guard_event_insert`, `emit_lifecycle_event`.

**TypeScript services (11):** `createCompany`, `setCompanyStatus`, `createDepartment`, `setDepartmentStatus`, `createAgent`, `setAgentStatus`, `createTask`, `assignTask`, `transitionTask`, `recordEvent`, `requestTaskExecution`.
- Each validates its tenant scope and source before the database is reached.
- Each calls exactly one function and maps domain SQLSTATEs to typed codes.
- A native `42501` is left untouched, so a misconfigured connection is never mistaken for a domain refusal.

| SQLSTATE | Typed code | Meaning |
| --- | --- | --- |
| `OS400` | `invalid_argument` | bad input, including a change with no declared provenance |
| `OS401` | `missing_tenant_scope` | no tenant scope |
| `OS403` | `refused` | a kind that is not task-executable; a reserved lifecycle namespace |
| `OS404` | `not_found` | not found **in this tenant or company**, whether or not it exists elsewhere |
| `OS409` | `invalid_state` | inactive entity, closed task, illegal transition, immutable column, idempotency conflict |
| `22P02` / `23505` / `23514`, `23503` | `malformed_identifier` / `duplicate` / `constraint_violation` | native |

## 2. Schema-location decision

**`ops`, not a new schema** (ADR 0015 §1). Every guard this repository already has for `ops` applies to a new table the day it exists:
- ENABLE + FORCE RLS, and lease-bound policies;
- no write verb for `ops_worker`, and no reach for `anon` or `authenticated`;
- absence from the PostgREST allowlist;
- the static migration guard's `ops` rules.

A `company` schema would have needed each of those duplicated, plus a cross-schema tenancy dependency and a USAGE decision per role. `ops.companies` is not `public.companies`, which is the CRM's customer account: every reference is schema-qualified, and the table comment says so.

## 3. Tenant / company distinction

Tenant is the isolation boundary; company is an organisational partition inside it (ADR 0015 §2). Businesses that must not see each other's data are separate tenants.

Two consequences are recorded rather than deferred:
- A capability reached from company-scoped work must authorise against a company-level binding, never against `ops.tenants.owns_local_crm` alone.
- That flag stays tenant-level in 1C, because no capability yet needs company-level CRM resolution.

~~FireForge 3D is onboarded as data (a company, departments and agents in a tenant), with no migration.~~ **Corrected 2026-09-13 (ADR 0015 owner addendum):** FireForge 3D is not onboarded. When it is, it is data in its own tenant (a tenant row, then its company, departments and agents), with no migration.

## 4. Company model

`ops.companies (id, tenant_id, slug, name, status, created_at, updated_at)`.
- `status` is `active | inactive`.
- `slug` is unique per tenant, and `(tenant_id, id)` is unique so every child can reference it compositely.
- `id`, `tenant_id` and `created_at` are immutable (an `ENABLE ALWAYS` guard), and `updated_at` is derived.
- Deactivating a company refuses new departments, agents, tasks and execution requests under it. Existing tasks can still be assigned and closed out.

Not implemented: a `settings` blob (no consumer, no schema).

## 5. Department model

`ops.departments (id, tenant_id, company_id, slug, name, status, created_at, updated_at)`.
- A composite foreign key `(tenant_id, company_id) → ops.companies (tenant_id, id)` makes a department in another tenant's company unstorable.
- `slug` is unique per company.
- Ownership columns are immutable. A composite key only checks that the *new* parent exists, so without the guard an unreferenced department could be moved into another tenant.
- Department names are data (`reception`, `marketing`, `operations` in the seed). The vocabulary guard in `schemaReproducibility.test.ts` refuses clinic words in Phase 1 migrations.

## 6. Agent model

`ops.agents (id, tenant_id, company_id, department_id, slug, name, role, description, status, created_at, updated_at)`.
- **Configuration and identity only:** no provider, model, prompt, temperature, tool, memory, autonomy level or manager.
- `status` is `active | inactive`, with no fake runtime status.
- `(tenant_id, company_id, department_id) → ops.departments` pins an agent to one department in its own company. Moving an agent means creating a new one.
- `ops.agents` precedes ADR 0004's principals, with a shared-key mapping recorded in that ADR's addendum.

Not implemented, deliberately:
- a third `disabled` status: vocabulary without behaviour, since an administrative stop is the kill switch's job (ADR 0010);
- manager hierarchy, deferred by the brief;
- a `configuration` blob.

## 7. Task model and state machine

`ops.tasks (id, tenant_id, company_id, department_id?, assigned_agent_id?, parent_task_id?, type, title, description?, status, priority, due_at?, completed_at?, created_at, updated_at)`.

- `type` is dotted, engine-neutral vocabulary (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`), not an enum: task types are tenant data.
- `priority` is `0..1000`, default 100, and orders work *within a company*. It is never copied into `ops.jobs.priority`.
- CHECK constraints: not its own parent; `queued` means unassigned; active work carries an assignee; `completed_at` is set if and only if the task is closed.
- Composite keys:
  - `(tenant_id, company_id)` to the company;
  - `(tenant_id, company_id, department_id)` to the department;
  - `(tenant_id, company_id, assigned_agent_id)` to the agent;
  - when both are set, `(tenant_id, company_id, department_id, assigned_agent_id)` pins the agent to the task's department.
- A parent must already exist in the same tenant and company (insert guard). A foreign key alone is checked at the end of the statement, so one multi-row INSERT could otherwise store a cycle.

```
queued ──► assigned ──► in_progress ──► completed
   │           │            │  ▲
   │           │            ▼  │
   │           │          waiting ──► failed
   ▼           ▼            │   │
cancelled ◄────┴────────────┴───┘      in_progress ──► failed | cancelled
```

The state machine has 11 edges: `queued→assigned`, `queued→cancelled`, `assigned→in_progress`, `assigned→cancelled`, `in_progress→waiting|completed|failed|cancelled`, `waiting→in_progress|failed|cancelled`.
- A task is born `queued` and unassigned.
- `assigned` is reached only by an assignment, so `transition_task` refuses it.
- There is no edge back to `queued`, and a retry is a new task.
- A closed task (`completed`, `failed`, `cancelled`) refuses **any** update, not only a status change.

The only enforcement point is `tasks_guard_update`, a BEFORE UPDATE trigger set `ENABLE ALWAYS` so replica mode does not silence it. `engine/domain/taskStateMachine.ts` mirrors the relation for typing and authorises nothing, and a driver-backed test asserts the two relations are equal in both directions.

**Proven:**
- **F1** attempts all 42 ordered pairs of distinct statuses with a raw UPDATE as the owner. Exactly the 11 edges succeed, and each of the other 31 must be refused with `OS409` specifically.
  - Its oracle is a literal list of the 11 edges, not the database's own helper. Mutation M03 showed a self-referential oracle cannot see a helper that allows everything (§16).
  - `ops.task_status_transitions()` and `ops.task_transition_allowed()` are both checked against that same list.
- **F2** covers a task born completed or in progress.
- **F3** covers a closed task rewritten or reassigned.
- **D12** covers a closed task in replica mode.
- **Row locking:** services lock rows before checking them, so a reassignment racing a completion is refused rather than landing after it. This was measured with two real connections.

Not implemented: `risk_level` (risk is evaluator output per ADR 0009, and a caller-set label would be trusted by the first gate that read it), and `input`/`result` references (no consumer yet).

## 8. Event model

Events are **derived from state, never asserted** (ADR 0015 §7). AFTER triggers write exactly one event per change, in the same statement:
- `company.created`, `department.created` and `agent.created`, and `*.status_changed` for each;
- `task.created`, which carries no title or description;
- `task.assigned`, carrying the agent change and, for the first assignment, the `queued → assigned` status change;
- `task.completed | failed | cancelled`, and `task.status_changed` for the other transitions;
- `task.execution_requested`, carrying `job_id` and `kind`.

**Atomicity:** a change and its fact commit or fail together on every write path (G4). A no-op writes nothing (G1).

- **Provenance, correlation and causation** travel in transaction-local settings, which the services push and pop so nested calls compose (G8). The emitting trigger refuses a change with no provenance, `OS400` (G3). This is a tripwire, not an authority.
- **Reserved namespaces** `company`, `department`, `agent`, `task` and `job` are refused by `ops.record_event` **and** by the table guard, each proven alone:
  - G6 is a raw insert;
  - G6b calls the function with the table guard off;
  - G6c calls the function in replica mode.
- **Integrity:** an event's subject and cause must live in its own tenant and company (G7). An `ENABLE ALWAYS` trigger refuses every UPDATE (G5, D12).
- **Not append-only against the owner:** DELETE is unguarded, because erasure and retention need it.
- **Order and payload:** `seq` is an identity column. Payloads are JSON objects of at most 16 KB and ~~hold no free text a human typed~~ carry no task title or description (G9). *(Narrowed 2026-09-13: lifecycle payloads do carry organisational labels, `slug`, `name` and an agent's `role`, and `ops.record_event` accepts any object, with EXECUTE granted to no role.)*
- **The outbox is `ops.events` itself**, written in the domain transaction; no Kafka, no queue. Delivery order across commits and consumer cursors are Phase 1D decisions.

Events are not the audit log and do not duplicate it: execution audit is `ops.job_events`, unchanged.

## 9. Task / job boundary

`ops.task_jobs (tenant_id, job_id, company_id, task_id, created_at)` links a task to the jobs it requested:
- Its primary key is `(tenant_id, job_id)`.
- Composite foreign keys point at the task `(tenant_id, company_id, task_id)` and at the job `(tenant_id, job_id)`, backed by a new unique index on `ops.jobs (tenant_id, id)`.
- A link is never rewritten.
- `ops.jobs` gained no reference to the domain, and ESLint enforces that `engine/worker` does not import `engine/domain`.

`ops.request_task_execution` is the smallest safe bridge:
- **Tenant:** taken from the **task row**. The payload is never read for tenancy (H2).
- **Kind:** must be in `ops.task_executable_kinds()`. **That allowlist is empty in Phase 1C**, and the migration asserts it (A8, end-state assertion).
  - The only registered handler, `postmark.ledger_retention`, is tenant-wide CRM maintenance, so a company-scoped task must not be able to trigger it (H1).
  - No handler was invented. The success path is proven through an allowlist replaced inside a rolled-back test transaction (H2–H8).
- **Idempotency:** scoped to the task (`task:<task_id>:<key>`, with the caller's part at most 200 characters, H8).
  - A repeated request returns the same job, with no second link or second fact (H3).
  - Another task's job is never adopted (H4), nor is one enqueued outside the bridge (H5).
- **Concurrency:** see §14.
- **Other refusals:** a closed task (H6), an inactive company, and a non-object payload (H7).

## 10. RLS and grants

| Role | Company OS tables | Company OS functions |
| --- | --- | --- |
| `anon`, `authenticated` | nothing, and no USAGE on `ops` | nothing |
| `service_role` | nothing | nothing new (still only `ops.enqueue_job`, from Phase 1A) |
| `ops_worker` | nothing, not even SELECT | nothing |
| PUBLIC | — | nothing (explicit per-function revoke) |
| `postgres` (owner) | everything | everything |

- **RLS:** ENABLE + FORCE on all six tables. Each has a policy `for select to ops_worker using (tenant_id = ops.current_tenant_id())` with **no grant behind it**, so a future worker read is born scoped.
- **PUBLIC EXECUTE:** PostgreSQL grants EXECUTE on every new function to PUBLIC, and the Phase 1A per-schema default-privilege revoke does **not** remove it (measured). All 23 functions are revoked explicitly (A3).
- **Pinned surfaces:** the EXECUTE surface of the application roles (A4) and the set of SECURITY DEFINER functions (A5) are pinned by name.
- **INVOKER is load-bearing:** a role given EXECUTE alone still hits `42501` on the tables (E8).

**Proven, sections A–C of `company_domain_core.sql`:**
- A1–A8 check the grant surface, ALWAYS guard modes and the empty allowlist.
- B: a real leased worker gets `42501` on every Company OS table and service.
- C1–C7 prove policy shape through a grant that exists only inside the transaction:
  - no lease, an unknown job id, a lease owned by another worker, and an expired lease all read zero rows;
  - a malformed job id raises;
  - each tenant's lease reads only its own tenant.

## 11. Data API exposure

**No new reachable surface.** `ops` stays off the PostgREST allowlist, and no Company OS object is reachable through the Data API with any credential. `opsDataApiExposure.mjs` attacks this on every `npm run test:db`, reading every `ops` relation and function from the live catalogue.

- **Credentials:** five: no key, publishable, anon JWT, service_role JWT, secret key. Each passes a positive control first.
- **Per relation:** schema-profile GET and POST must return `406 PGRST106`, and bare names exactly `404 PGRST205`.
- **Per function:** schema-profile RPC must return `406 PGRST106`.
- **GraphQL:** introspection per credential. No `ops` relation or function may be reflected, and `service_role` must see the CRM tables as its own positive control.
- **Live configuration:** `PGRST_DB_SCHEMAS` and `PGRST_DB_EXTRA_SEARCH_PATH` must exclude `ops`, and the authenticator role must carry no `pgrst.*` setting naming it.
- **It never writes.** Writes and RPCs carry an unparseable body, and GraphQL is introspection only.

**Signoff result:** 11 `ops` relations and 35 functions, 5 credentials, **340 requests over REST and GraphQL, none reached `ops`**. The live schema allowlist and search path exclude `ops` (final validation, 2026-09-13).

## 12. Cross-tenant proof

Every attack runs twice: as raw owner DML, to prove the structure (section D), and through the services, to prove scope resolution (section E).

- **Unstorable by raw DML:**
  - D1: a tenant-A department in a tenant-B company;
  - D2: a tenant-A agent in a tenant-B department;
  - D4: a tenant-A task assigned a tenant-B agent, by the guard and separately by the foreign key;
  - D9: a tenant-A event about a tenant-B company;
  - D10: a tenant-A task linked to a tenant-B job, and the reverse;
  - D11: a company or department moved to another tenant.

  Each foreign-key variant switches off the row's emission trigger for the attempt, so the composite key is proven alone.
- **Not found through the services:**
  - E1: tenant A creating a department, agent or task in company B, recording an event about it, or deactivating it is `OS404`.
  - E2: tenant A assigning company B's agent or transitioning company B's task is also `OS404`.
  - E4: scope is resolved before state. Tenant B's inactive agent, closed task, and task with a refused kind are all "not found" through tenant A.
- **Fails closed:**
  - E5: a missing scope is `OS401` on every service.
  - E6: an unknown tenant finds nothing, and a malformed one never reaches a function body.
- **Through the real driver:** another tenant's company is `not_found`, and nothing is written.

## 13. Cross-company proof

Company scope is enforced *inside* one tenant. Each case is refused as raw DML (section D) and through the services (E3):
- D3: a company-A1 agent in a company-A2 department.
- D5: a company-A1 task assigned a company-A2 agent, by the guard and by the foreign key.
- D6: a reception task assigned a marketing agent of the same company, refused by the four-column key.
- D7: a parent task in another company, by the guard and by the foreign key.
- D8: a parent-task cycle in one multi-row INSERT.
- D11: an agent moved to another company or department, or a task moved to another company.
- G7: an event whose subject or cause lives in another company.

## 14. Task → job bridge race proof

**The defect, found by the adversarial pass (§17):**
- The bridge used to call `ops.enqueue_job`, whose idempotent path returns whichever job holds the key.
- A `service_role` caller that committed a job under a task's namespaced key after the bridge's own check had it adopted as the task's request.

**The fix:** the bridge inserts its own job, maps `unique_violation` to `OS409`, and writes the `enqueued` job event itself (H2).

**The proof** is the test `refuses a job another caller enqueues under the task's key while the request is in flight`, in `engine/domain/companyOs.dbtest.ts`, run through the real `pg` driver:
1. Connection 1 opens the bridge transaction, allowlists a kind inside that transaction only, creates a task, and waits.
2. Connection 2 calls `ops.enqueue_job` under `task:<task id>:k` and does not commit.
3. Connection 1 requests execution. Its insert blocks on the idempotency index, and the test confirms the block through `pg_stat_activity.wait_event_type = 'Lock'`.
4. Connection 2 commits.
5. The bridge must fail with `invalid_state`, and no `ops.task_jobs` row may link the other caller's job.

Mutation M39 restores the old `enqueue_job` call, and this test catches it (§16). Sequential variants: H3 (same request, same job), H4 (another task, same key), H5 (a key enqueued outside the bridge).

## 15. Worker privilege impact

**None.**
- `ops_worker` gained no grant: no table privilege, no function and no default privilege (A1, A4, B, E8).
- `ops_worker_login` is unchanged, and the worker runtime does not read or write the domain.
- No Phase 1C path uses `service_role`, and nothing new was granted to it.
- The static migration guard now rejects any grant on an `ops` object to a bypass role, keyed per privilege. The only exceptions are the two pinned Phase 1A `service_role` grants: USAGE on `ops` and EXECUTE on `ops.enqueue_job`.

## 16. Mutation testing — exact final result

### Method

The database mutations were run by harness v2. For each mutation it proves, and records:
1. **Applied.**
   - A database mutation must change a 179-object fingerprint of the `ops` catalogue: function definitions and ACLs, trigger definitions and modes, constraints, policies, RLS/FORCE flags, relation ACLs, indexes and the schema ACL.
   - A file mutation must change the file's bytes.
2. **Caught.** A named suite must go red, **and** its output must name the assertion the mutation targets. Red for any other reason is reported as unexpected, never as caught.
   - The three migration mutations (M35, M37, M38) count only if the migration's own end-state assertion refuses them at apply time.
3. **Restored.**
   - The fingerprint must equal the baseline again, and file bytes must be identical by sha256.
   - Row counts of every Company OS and job table must be unchanged.
   - Any doubt aborts the run.

   One suite needs a recorded exception. `ops_execution_core.sql`, the Phase 1A suite, commits `phase1a-test-*` fixtures on purpose, to prove tenant context survives a COMMIT. It removes them only at its own start and end, so when a mutation makes it fail midway its fixtures remain. Between mutations the harness runs that suite's own start-of-run cleanup, records every occasion, and then compares row counts strictly.

Every run starts from a fresh isolated reset with green baseline suites.

### Earlier runs, and why nothing from them counts

- **2026-09-12: interrupted after 28 of 40 mutations,** when its session ended.
  - The kill left mutation M05 applied: the bridge took its job's tenant from the payload.
  - The database also held two `phase1a-test-*` tenants and four leased jobs, which failed three suites. Those rows were not caused by the kill. They are `ops_execution_core.sql` fixtures left when that suite failed under an earlier mutation, and the first harness had no residue check to notice them. The M05 line was captured as evidence, and a clean reset repaired the database.
- **2026-09-13, first clean run: stopped by its own restore check after M06.**
  - M06 was caught by the right assertion (A6), and the catalogue was restored exactly.
  - The same Phase 1A fixtures remained, so row counts differed and the harness aborted. That is how the fixture mechanism was identified.

- **2026-09-13, second clean run: 40 applied, 40 restored, 38 caught by their named assertion.** The two that were red for a different reason, and one caught for the wrong reason, were investigated from their output before anything changed:
  - **M18** (`assign_task` looks the agent up without its tenant and company) was caught first by E2, the test named for its property. Tenant B's agent was found, and its state leaked as `OS409` ("the agent does not belong to the task's department") instead of "not found". The declared expectation (E4) runs later. Only the expectation was corrected.
  - **M14** (the insert guard trigger dropped) was caught first by D7's guard variant, a parent check inside the same trigger. The "born queued" check that F2 exists to prove was never reached, so F2 was never shown to be load-bearing. **Added M14b**, which removes only that check and keeps the parent check, so F2 must catch it alone.
  - **M03** (the transition helper made to allow everything) exposed a weak oracle. F1 decided which pairs were allowed by calling `ops.task_transition_allowed()`, the helper M03 mutates. Every illegal open-task transition, such as `queued -> completed`, was therefore accepted without F1 noticing. F1 failed only at `completed -> queued`, which the separate closed-task check refused. **F1 now uses a literal list of the 11 edges** as its oracle, and also checks `ops.task_status_transitions()` and the helper against that list.

None of those runs' results are used here. The final set, 41 mutations including M14b, was re-run from mutation 1 on a fresh reset, with the fixture cleanup and the corrections above.

### M16: investigated before the full run

M16 removes the reserved-namespace check from `ops.record_event` and leaves the table trigger `events_guard_insert` in place. It survived the interrupted run. Reproduced on the clean database:

| `ops.record_event(…, 'task.completed', …)` | Original | M16 |
| --- | --- | --- |
| normal call | `OS403` from `ops.record_event` | `OS403` from `ops.events` (the trigger) |
| trigger disabled | `OS403` from `ops.record_event` | **accepted: forged event written** |
| replica mode | `OS403` from `ops.record_event` | **accepted: forged event written** |

**Classification: a real coverage gap, not an equivalent mutation.**
- G6 passed because the trigger raised the same SQLSTATE in the function's place, so the test could not tell the layers apart.
- The function's check is the only guard in replica mode, which is the owner's restore mode and silences the ORIGIN trigger.

**Fix:** G6b (the function with the trigger disabled) and G6c (the function in replica mode) were added, and SI-23 now pins G6b. Re-run on its own, M16 is caught by exactly `G6b record_event forging task.completed with the table guard off: ACCEPTED with trigger events_guard_insert off`.

### Result

| Set | Result |
| --- | --- |
| Database and TypeScript boundary, 41 mutations (M01–M41 plus M14b), full clean re-run | **41 / 41 caught by their named assertion; 41 / 41 applied; 41 / 41 restored.** Run from a fresh reset with a green baseline, 2026-09-13 12:51–13:07. The count is 41, not 40, because M14b was added (above). The Phase 1A fixture cleanup ran once, after M23, and was recorded. |
| Static migration guard, G1–G6 | **6 / 6 caught** |
| Static migration guard after the adversarial pass, G7–G15 | **9 / 9 caught**. G9 survived the first run and exposed a real gap (`create or replace trigger` inside a DO block), which was fixed. |
| Data API probe (a relation made reachable) | **caught**, and wrote nothing |

Every database mutation, with the assertion observed for it. "Caught by" names the suite whose output contained the expected assertion. M35, M37 and M38 were refused by the migration's own end-state assertion, which is their expected outcome.

| Mutation | Property broken | Applied | Verdict | Caught by | Assertion observed | Restored |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | departments -> companies key loses tenant_id | yes | **caught** | db | D1 a tenant-A department in a tenant-B company: ACCEPTED with trigger departments_emit_created off, expected SQLSTATE 23503 | yes |
| M02a | task guard no longer pins the assignee to the task's company | yes | **caught** | db | D5 a company-A1 task assigned a company-A2 agent (guard): expected SQLSTATE OS404, got 23503 (insert or update on table "tasks" violates foreign key c | yes |
| M02b | tasks -> agents key loses tenant and company | yes | **caught** | db | D4 a tenant-A task assigned a tenant-B agent (foreign key): ACCEPTED with trigger tasks_guard_update off, expected SQLSTATE 23503 | yes |
| M21 | events -> companies key loses tenant_id | yes | **caught** | db | D9 an event of tenant A about a company of tenant B: ACCEPTED, expected a refusal with SQLSTATE 23503 | yes |
| M22 | department tenant/company no longer immutable | yes | **caught** | db | D11 moving a department to another tenant: expected SQLSTATE OS409, got 23503 (update or delete on table "departments" violates foreign key constraint | yes |
| M34 | task company no longer immutable | yes | **caught** | db | D11 moving a task to another company: ACCEPTED, expected a refusal with SQLSTATE OS409 | yes |
| M23 | parent need not exist before its child (cycle guard removed) | yes | **caught** | db | D7 a parent task in another company (guard): expected SQLSTATE OS404, got 23503 (insert or update on table "tasks" violates foreign key constraint "ta | yes |
| M06 | FORCE row level security removed from ops.tasks | yes | **caught** | db | A6: ops table(s) tasks lack ENABLE + FORCE row level security | yes |
| M07 | authenticated granted a read on ops.companies | yes | **caught** | db | A1: Company OS table reachable by an application role: authenticated:companies:SELECT | yes |
| M08 | ops_worker granted a read and write verbs on the domain | yes | **caught** | db | A1: Company OS table reachable by an application role: ops_worker:companies:SELECT, ops_worker:tasks:INSERT, ops_worker:tasks:UPDATE | yes |
| M09 | a domain read policy unscoped to using (true) | yes | **caught** | db | C1: 5 rows of ops.tasks visible with no lease; missing context must fail closed for Company OS data | yes |
| M10 | a domain function made SECURITY DEFINER | yes | **caught** | db | A5: unexpected SECURITY DEFINER function(s) in ops: create_company | yes |
| M11 | a domain function executable by PUBLIC | yes | **caught** | db | A3: ops function(s) executable by PUBLIC: ops.assign_task(uuid,uuid,uuid,text,uuid,uuid) | yes |
| M18 | assign_task resolves the agent outside the tenant/company scope | yes | **caught** | db | E2 tenant A assigns company B's agent: expected SQLSTATE OS404, got OS409 (ops.assign_task: the agent does not belong to the task's department) | yes |
| M03 | every task transition allowed | yes | **caught** | db | F1: illegal task transition accepted, or a legal one refused: queued -> in_progress was ACCEPTED, the state machine says forbidden | yes |
| M12 | closed tasks no longer immutable | yes | **caught** | db | F3 rewriting a closed task's title: ACCEPTED, expected a refusal with SQLSTATE OS409 | yes |
| M13 | UPDATE guard downgraded from ALWAYS to ORIGIN | yes | **caught** | db | A7: guard trigger(s) missing or not ENABLE ALWAYS: tasks_guard_update | yes |
| M14 | insert guard (born queued) dropped | yes | **caught** | db | D7 a parent task in another company (guard): expected SQLSTATE OS404, got 23503 (insert or update on table "tasks" violates foreign key constraint "ta | yes |
| M14b | born-queued check removed from the insert guard (parent check kept) | yes | **caught** | db | F2 a task born completed: ACCEPTED, expected a refusal with SQLSTATE OS409 | yes |
| M17 | inactive agents assignable (both layers) | yes | **caught** | db | F5 an inactive agent: ACCEPTED, expected a refusal with SQLSTATE OS409 | yes |
| M27 | the database gains an edge TypeScript does not have | yes | **caught** | db, engine | F1: illegal task transition accepted, or a legal one refused: waiting -> completed was ACCEPTED, the state machine says forbidden | yes |
| M04 | lifecycle event emission omitted | yes | **caught** | db | C4: tenant A sees none of its own events; the policy is simply broken | yes |
| M25 | emission fires on no-op updates (WHEN clause removed) | yes | **caught** | db | G1: a lifecycle operation did not emit exactly its one event, in order: {task.created,task.assigned,task.assigned,task.status_changed,task.status_chan | yes |
| M26 | a change with no provenance recorded as 'unknown' | yes | **caught** | db | G3 a raw company insert without provenance: ACCEPTED, expected a refusal with SQLSTATE OS400 | yes |
| M24 | pop_event_context no longer restores the caller's provenance | yes | **caught** | db | G3 a raw company insert without provenance: ACCEPTED, expected a refusal with SQLSTATE OS400 | yes |
| M15 | table-level reserved-namespace check removed | yes | **caught** | db | G6 a raw insert forging company.status_changed: ACCEPTED, expected a refusal with SQLSTATE OS403 | yes |
| M16 | function-level reserved-namespace check removed (the trigger still stands) | yes | **caught** | db | G6b record_event forging task.completed with the table guard off: ACCEPTED with trigger events_guard_insert off, expected SQLSTATE OS403 | yes |
| M32 | events can be updated (append-only trigger dropped) | yes | **caught** | db | A7: guard trigger(s) missing or not ENABLE ALWAYS: events_refuse_update | yes |
| M05 | job tenant taken from the payload | yes | **caught** | db | insert or update on table "task_jobs" violates foreign key constraint "task_jobs_job_fkey" | yes |
| M39 | the bridge enqueues through ops.enqueue_job again, adopting a concurrently enqueued job | yes | **caught** | engine | × refuses a job another caller enqueues under the task's key while the request is in flight 41ms | yes |
| M40 | the idempotency key is unbounded | yes | **caught** | db | H8: an oversize idempotency key reached the queue | yes |
| M41 | the bridge's job has no enqueued job event | yes | **caught** | db | H2: the bridge enqueued a job with no enqueued job event | yes |
| M19 | allowlist check removed from the bridge | yes | **caught** | db | H1 a real handler kind through an empty allowlist: ACCEPTED, expected a refusal with SQLSTATE OS403 | yes |
| M20 | the bridge adopts a job its task did not request | yes | **caught** | db | H5: the bridge adopted a job its task did not request (enqueued outside the bridge) | yes |
| M31 | a closed task may request execution | yes | **caught** | db | H6: a closed task requested execution | yes |
| M35 | migration ships a non-empty task allowlist | yes | **caught** | migration apply | psql:<stdin>:1645: ERROR: ops.task_executable_kinds() is not empty; Phase 1C ships no executable task kind | yes |
| M37 | migration declares a domain function SECURITY DEFINER | yes | **caught** | migration apply | psql:<stdin>:1645: ERROR: unexpected SECURITY DEFINER function(s) in ops: create_company | yes |
| M38 | migration leaves the task UPDATE guard in ORIGIN mode | yes | **caught** | migration apply | psql:<stdin>:1644: ERROR: guard trigger(s) missing or not ENABLE ALWAYS: tasks_guard_update | yes |
| M28 | TypeScript gains an edge the database does not have | yes | **caught** | unit engine/domain/taskStateMachine.test.ts, engine | ❯ \|functions\| engine/domain/taskStateMachine.test.ts (7 tests \| 2 failed) 12ms | yes |
| M29 | a native 42501 dressed up as a domain refusal | yes | **caught** | unit engine/domain, engine | × leaves a native permission failure alone, so a wrong-role connection is not mistaken for a refusal 5ms | yes |
| M30 | a malformed tenant scope reaches the database | yes | **caught** | unit engine/domain/companyOs.test.ts | ❯ \|functions\| engine/domain/companyOs.test.ts (6 tests \| 1 failed) 6ms | yes |

## 17. Abbreviated adversarial pass

### The pass over the new surface (2026-09-12)

Independent attackers covered each seam, and independent verifiers re-ran each claim against the live stack. **13 findings: no Critical, High or Medium. 5 were Low, confirmed or partially confirmed, and all were closed within the phase. 8 were informational.**

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| C1C-SEAM-01 | Low (confirmed) | A concurrent `service_role` enqueue under a task's namespaced key was adopted as the task's own request. | The bridge inserts its own job and refuses the unique violation with `OS409`; race test and mutation M39 (§14). |
| C1C-01 | Low (partially confirmed) | The static guard missed `drop trigger`, `create or replace trigger` (which resets ALWAYS to ORIGIN, measured) and `drop … cascade`. | Three rules; eleven guard cases; mutations G7–G15. |
| C1C-SEAM-02 | Low (confirmed) | ADR 0015 said PL/pgSQL caches the EXECUTE check "per transaction"; for constant-argument helpers it lasts the life of the backend. | ADR corrected: table privileges, which are re-checked on every execution, are the boundary. |
| C1C-SEAM-03 | Low (partially confirmed) | No case proved that a foreign worker's lease or an expired lease reads nothing. | Cases C6 and C7. |
| C1C-SEAM-04 | Low (partially confirmed) | The probe lacked GraphQL, the secret key, per-credential positive controls and live search-path checks, and had a branch that could never fail. | All added; the tautological branch removed. |
| C1C-02 | Info | Events are not append-only against the owner. | Wording corrected. |
| C1C-03 | Info | Platform read roles (`pg_read_all_data`, `supabase_read_only_user`) can read `ops`. | Recorded (ADR 0015). |
| SEAM-05 | Info | `events.seq` is global, so cross-tenant volume can be inferred from gaps. | Recorded; per-tenant cursor is a Phase 1D decision. |
| SEAM-06 | Info | Two leases can be taken in one transaction. | Phase 1A mechanism; no 1C impact. |
| C1C-INFO-01 | Info | The inactive-company gate is asymmetric. | Recorded as the intended semantics (§4). |
| C1C-INFO-02 | Info | An oversize idempotency key surfaced as a btree size error. | Bounded at 200 characters (`OS400`); H8, M40. |
| INFO-02 | Info | No `pg_default_acl` row for `ops`. | Covered by explicit revokes and the pinned EXECUTE set. |
| OS-1C-INFO-01 | Info | Local pg-meta was reachable without a key. | Became the local-network finding closed in §21. |

### Re-run of the Phase 1C attacks for signoff (2026-09-13)

This was not the full 1B-S audit; only the Phase 1C-relevant attacks were re-run, on the final code and a clean database:

| Attack | Where | Result |
| --- | --- | --- |
| Data API exposure of `ops` over REST, per credential | `opsDataApiExposure.mjs` | passed: every profile request returned 406 PGRST106 and every bare name 404 PGRST205, for all 5 credentials |
| GraphQL reflection of `ops` | `opsDataApiExposure.mjs` | passed: no `ops` relation or function was reflected for any credential; the `service_role` positive control saw the CRM tables |
| Exposed RPCs and functions | `opsDataApiExposure.mjs`; A3, A4, A5 | passed: every `ops` function refused by profile (406); A3 no PUBLIC EXECUTE; A4 EXECUTE surface as pinned; A5 no unexpected SECURITY DEFINER |
| Grants to `anon`, `authenticated`, `service_role` and `ops_worker` | A1, A2, A4, B, E8 | passed: no application role holds a Company OS privilege; a leased worker gets 42501; an EXECUTE grant alone writes nothing |
| Cross-tenant identifiers | D1, D2, D4, D9, D10, D11; E1, E2, E4–E6 | passed: every raw cross-tenant row refused structurally; every out-of-scope id is "not found" before its state is read |
| Cross-company identifiers | D3, D5–D8, D11; E3; G7 | passed: every cross-company row, assignment, parent, move and event refused |
| Trigger modes and security_invoker invariants | A7, the migration end-state assertions, the static guard (`migrationInvariants.test.ts`), SI-01 | passed: A7 guard triggers ENABLE ALWAYS; the migration's 13 end-state assertions at every reset; the static migration guard (inside `functions`); SI-01 `security_invoker` views (`rls_tenant_isolation.sql`) |

### Security baseline

**Not regressed.**
- SI-01 to SI-20 are unchanged, and their guards still run.
- SI-19 and SI-20 are untouched: the query persister ban, development signing-key confinement, the publish scan and the deploy guard.
- The static migration guard was strengthened, never weakened: no schema was added to `ignoredSchemas`, and every new rule has rejected and accepted cases.
- SI-15 was rescoped from a configuration fact to an attacked property.
- SI-21 to SI-24 were added and are pinned by markers.

## 18. Test counts

| Suite | Before Phase 1C (`7d41efff`) | After |
| --- | --- | --- |
| `app` (browser) | 234 passed, 1 skipped (30 files) | 234 passed, 1 skipped (30 files); unchanged |
| `functions` | 792 passed, 1 skipped (57 files), measured together with `claude` at the base commit | **485 passed** (21 files) |
| `claude` | included in the row above | **410 passed, 1 skipped** (40 files; the git-ignored `.claude/worktrees/` copy excluded) |
| **Unit total** | **1026 passed, 2 skipped** | **1129 passed, 2 skipped** (91 files) |
| Database suites (`npm run test:db`) | 4 | **6 passed**: `company_domain_core.sql`, `ops_execution_core.sql`, `rls_tenant_isolation.sql`, `worker_tenant_context.sql`, `jobLeasingConcurrency.mjs`, `opsDataApiExposure.mjs` |
| Driver-backed (`npm run test:db:engine`) | 32 | **42 passed** (4 files) |

Inside those numbers: `company_domain_core.sql` has 70 refusal cases and 64 labelled inline assertions in sections A–H; `migrationInvariants.test.ts` carries 118 migration cases; `securityInvariants.test.ts` 32 tests (SI-01 to SI-24); `engine/domain` 17 unit cases; `companyOs.dbtest.ts` 10 driver-backed cases; the local-exposure check 34 unit cases (committed in `57faa51a`).

## 19. `db reset`

**Every reset in the signoff pass exited 0.** Each was a clean isolated `npx supabase db reset --workdir .supabase-e2e --local`.

| When (2026-09-13) | Purpose | Duration |
| --- | --- | --- |
| 12:16 | clean baseline after the interrupted run | 34 s |
| 12:25 | before mutation run 1 | 34 s |
| 12:31 | before mutation run 2 | 33 s |
| 12:51 | before the final mutation run | 33 s |
| 13:08 | final validation | 34 s |

- Every migration through `20260912200000_company_domain_core.sql` applied, and its 13 end-state assertions raised nothing.
- The seed then produced exactly its data: 1 tenant, 1 company, 3 departments, 2 agents and 6 lifecycle events, with 0 jobs and an empty allowlist.
- Every suite in §18 ran against the 13:08 database.

## 20. Build and secret scan

- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0 with 0 errors and 64 warnings. 64 of the warnings come from the git-ignored `.claude/worktrees/` copy and 0 from this checkout, 0 of them in Phase 1C or local-exposure files. The warnings are unused eslint-disable directives, fast-refresh exports and type-only imports.
- Prettier: clean on all 29 changed and new files.
- `npm run build`: exit 0 (Vite built in 9.40 s).
- `npm run scan:build`: 18 text files in `dist` scanned, **0 blocking, 0 advisory**. No service_role key, secret key, connection string, private key or development signing key in the bundle.

## 21. Local-network hardening status

**Closed and verified 2026-09-12; guard committed as `57faa51a`.**

- **The finding:**
  - The Supabase CLI publishes every local port with no host address, and Docker Desktop's default ("Open") then listens on every interface.
  - Kong's `/pg/query`, Studio's query route and Postgres (default password) ran SQL as `postgres` from the LAN address and from global IPv6 addresses.
- **The mitigation is environmental, not repository state:** Docker Desktop → Settings → Resources → Network → Port binding behavior → **"Localhost only"**, with both stacks recreated. It was verified in order:
  1. A throwaway container published with no host address came up on `127.0.0.1`/`[::1]` only, and an explicit `0.0.0.0` publish was refused.
  2. Only then were the stacks recreated.
  3. Afterwards, all 16 bindings were loopback-only, every non-loopback address refused, and the WSL VM could not connect.
  4. `host.docker.internal` and container-to-container paths still worked.
- **Regression detection is committed:**
  - `npm run check:local-exposure` (`scripts/local-exposure.mjs`, 34 unit tests) reads Docker's effective bindings and the host's listening sockets, and never reports "could not check" as safe.
  - `npm run test:db` prints its verdict before the suites and again after the summary.
- **Signoff check:** `npm run check:local-exposure` exited 0: 20 containers and 16 published bindings, every one loopback-only on Docker and on the host (final validation, 13:10). `npm run test:db` printed the same verdict for the e2e stack.
- **Commit split:** the hardening's documentation (CLAUDE.md, SECURITY.md, SECURITY_INVARIANTS.md and the SI-15 caveat) lives in files Phase 1C also changes. The pre-commit hook's `git update-index --again` re-stages whole files, so it ships with the Phase 1C commit rather than being split mid-file.

## 22. CI status

**CI VERIFIED.** Evidence: [run 34770182266](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34770182266) of `✅ Check` (push, attempt 1) on `e160debb`, 2026-09-13 16:58–17:05 UTC. Every check Phase 1C is responsible for is green. The only red checks are the two pre-existing ones, and each is identical to the baseline. The run's overall conclusion is therefore `failure`, as the baseline's was: the criterion for this verification was green, or red only on those two checks and unchanged.

**Baseline:** [run 34715191426](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34715191426) on `7d41efff`, the commit Phase 1C starts from.

Commits on `feature/clinical-phase-1` since `7d41efff`, pushed together:

1. `57faa51a` — `security(local): detect local Supabase ports reachable beyond loopback`
2. `0b0c438e` — `feat(company-os): Phase 1C Company OS domain core` — migration, domain services, attack suites, static guard, invariants registry
3. `e160debb` — `docs: Phase 1C report, ADR 0015 and documentation` — this report, ADRs, architecture, permissions, security, roadmap, CLAUDE.md

A push runs `check.yml` once, on its head, so `57faa51a` and `0b0c438e` have no run of their own. The run on `e160debb` covers the cumulative change of all three; the intermediate commits have no independent CI result.

### Required checks, read from the job logs

| Check | Job → step | Result | Evidence |
| --- | --- | --- | --- |
| Database security & reproducibility | `🗄️ Database security & reproducibility`, all steps | ✅ 3 m 42 s | `supabase start` and `supabase db reset --local` each applied every migration through `20260912200000_company_domain_core.sql` and seeded; `test:db` passed before and after the reset |
| Phase 1C SQL/domain tests | `🔒 RLS, tenant isolation and grant surface`, `🔒 Same guarantees after the reset` | ✅ | `PASS company_domain_core.sql` both times; `6 database suite(s) passed` both times (baseline: 4) |
| Data API `ops` exposure probe | the same two steps | ✅ | `PASS opsDataApiExposure.mjs` both times: "11 ops relations, 35 ops functions, 5 credentials: 340 Data API requests over REST and GraphQL, none reached ops" |
| Worker/runtime regression tests | `⚙️ Worker runtime, pooling and concurrency` | ✅ | 4 files, **42 passed**: `workerRuntime` 21, `companyOs.dbtest` 10, `concurrency` 5, `pooling` 6 |
| Unit tests | `🔎 Test`: app, functions, agent harness | ✅ | `test:unit:app` passes no `--project`, so it runs every project: 91 files, **1129 passed, 2 skipped**. The `functions` step: 21 files, 485 passed. The `claude` step: 40 files, 410 passed, 1 skipped |
| Typecheck | `🏷️ Typecheck` | ✅ | exit 0; its only annotation is GitHub's Node.js 20 deprecation warning |
| ESLint | `🔬 ESLint` job and `ESLint` check run | ✅ | "ESLint found no issues", 0 annotations |
| Build | `🔨 Build` → `npm run build` | ✅ | exit 0 |
| Secret build scan | `🔒 No secrets in the production build` | ✅ | "scanned 16 text file(s) in "dist": 0 blocking, 0 advisory." (§20's 18 is the local build) |
| Migration/security guards | `functions` and `claude` steps; the migration's own assertions | ✅ | `migrationInvariants.test.ts` 131 tests (static guard and seal), `securityInvariants.test.ts` 32 (SI-01 to SI-24), `schemaReproducibility.test.ts` 8, `dev-signing-key.test.mjs` 59, `local-exposure.test.mjs` 34. `20260912200000_company_domain_core.sql` applied without error on start and on reset, so its 13 end-state assertions raised nothing |

CI reports executed tests. §18's case counts (118 migration cases, 17 `engine/domain` unit cases) were counted from the source and are not the same measure as CI's 131 and 24 (7 + 6 + 11); every test in those files passed.

### Red checks: classified before any change, neither a Phase 1C regression

| Check | `7d41efff` (baseline) | `e160debb` (Phase 1C) | Classification |
| --- | --- | --- | --- |
| `e2e-test` | `Run Playwright tests` failed (`make` exit status 2): 10 tests, **9 failed, 1 skipped** | same step, same exit status: 10 tests, **9 failed, 1 skipped** | pre-existing, unchanged |
| `Prettier` | 2 files: `dataImport/sampleCsv.test.ts`, `providers/commons/canAccess.test.ts` | the same 2 files | pre-existing, unchanged |

**`e2e-test` needed more than a matching job name.** `make test-e2e-ci` copies `supabase/migrations` and `supabase/seed.sql` into a fresh stack, so the Phase 1C migration and seed do reach this job. The two logs were therefore compared test by test:

- The same 5 tests, in 4 spec files, fail in both runs on all three attempts: `adminAccountManagerFilter.spec.ts:42` and `:79`, `bulkContactTags.spec.ts:3`, `onboarding.spec.ts:3` and `userAddingATask.spec.ts:42`. All 5 fail in `chromium`; the 4 other than `bulkContactTags` fail in `Mobile Chrome`.
- `bulkContactTags` on `Mobile Chrome` is skipped in both.
- The failure messages match too. In both logs every failure is a 5000 ms locator timeout, with identical counts: `getByRole('link', { name: 'Contacts' })` 15, `getByText('Welcome to Atomic CRM')` 6 and `getByText('Latest Activity')` 6, made up of 12 `locator.click` timeouts and 15 `toBeVisible` failures.
- Phase 1C changes nothing under `src/` or `e2e/`. The step took 326 s, against the baseline's 331 s.

**Prettier** flags the same two files in both runs, both older than Phase 1C, and no file that `7d41efff..e160debb` changes. CI's Prettier glob does not cover `.mjs` or `.sql`, so those files rest on the local check in §20.

The commit recording this verification touches only `CLAUDE.md` and this report, and is not covered by run 34770182266. When the owner pushes it, its own run is expected to show the same two red checks and nothing else. The last commit to change code or configuration is `0b0c438e`, covered by the run above.

## 23. ADR changes

| ADR | Change |
| --- | --- |
| [0015](adr/0015-company-os-domain-core.md) | **New, Proposed.** *(Accepted by the owner 2026-09-13, with an addendum.)* Schema location, tenant/company boundary, composite keys, backend-only INVOKER authority and the future wrapper contract, agents as configuration, the task state machine, derived events, the bridge. Updated after the adversarial pass (plan-cache scope, delete semantics, bridge concurrency, consequences). |
| [0004](adr/0004-principal-model.md) | Addendum: `ops.agents` precedes principals, with a shared-key mapping. |
| [0010](adr/0010-cost-control-and-kill-switch.md) | Addendum: tenant versus company scopes; `agents.status` is not the kill switch; scope resolution at lease time through `ops.task_jobs`; a kill-switch refusal must not consume an attempt. |
| [DECISIONS.md](DECISIONS.md) | Row for 0015. |

Not changed: ADR 0008 (still unresolved) and ADR 0012 (Accepted, untouched).

## 24. Remaining risks

1. **The owner is outside every boundary here.** It can DISABLE TRIGGER, use replica mode, and delete events: the same line as BYPASSRLS (SI-06).
2. **No runtime caller exists yet.** The SECURITY DEFINER wrapper contract (no tenant or company argument; scope from a lease or a membership) is designed, not built. The lease-bound read policies are proven only through a transaction-scoped grant.
3. **Layered checks that raise the same SQLSTATE are proven separately only where a test isolates them:**
   - the foreign-key variants in section D;
   - G6b and G6c for reserved namespaces.

   M16 showed what happens otherwise. The function-level and trigger-level inactive-agent checks are mutated together (M17), so each is not proven alone.
4. **Guard function bodies are not statically guarded.** A `create or replace function` that no-ops a guard is caught only by the SQL suites.
5. **PL/pgSQL helper caching.** A future non-owner writer role must be granted the trigger helpers deliberately, or a guard's SQLSTATE will depend on backend history.
6. **`ops.enqueue_job`'s idempotent path returns another caller's job.** The bridge no longer relies on it, and any future caller must not assume ownership of a returned id.
7. **A global `events.seq`** leaks cross-tenant volume to any future reader of events.
8. **Platform read roles read `ops`,** as they read everything.
9. **`ops.task_jobs` restricts deleting a linked job,** so future job retention must decide what happens to links.
10. **Probe coverage gaps:** the probe holds no signed-in `authenticated` JWT, and no hosted gateway is measured.
11. **Local-network protection depends on a machine setting.** A Docker Desktop reset or upgrade can undo it; `check:local-exposure` and the `test:db` warning detect that.
12. **The mutation harness is session tooling, not committed.** Its method and per-mutation evidence are recorded here, but CI does not re-run mutations.
13. ~~**ADRs 0002, 0003 and 0015 are still Proposed.**~~ **Corrected 2026-09-13:** ADR 0015 is Accepted with the owner addendum; ADRs 0002 and 0003 are still Proposed. *(Later 2026-09-13: 0003 accepted as reconciled.)*
14. **CI has no passing end-to-end test.** Every Playwright test fails or is skipped, and did before Phase 1C too (9 failed, 1 skipped, identical on `7d41efff` and `e160debb`; §22). No UI flow is regression-tested in CI: login, onboarding, the contact list and its account-manager filter, bulk tagging and task creation. Phase 1C changes no file under `src/` or `e2e/`, but its migration and seed do reach that job.

---

## Appendix A — proposed Phase 1D scope (for architectural review; not started)

Deterministic throughout: no LLM, prompt, provider, memory, WhatsApp, Ads, browser automation or UI. ROADMAP's sequencing rule holds: **no agent before the kill switch and cost ledger.**

1. **Review gate:** accept or amend ADRs 0002, 0003 and 0015 before anything builds on them. *(2026-09-13: 0015 accepted; 0002 and 0003 reconciled, still Proposed.)* *(Later: 0003 accepted; 0002 waits on a `merge_contacts` pool test.)*
2. **Kill switch** (ADR 0010):
   - global, tenant, company, department and agent scopes; deny-wins; fail-closed;
   - enforced at lease time through `ops.task_jobs`;
   - a refusal settles without consuming an attempt, and is audited.
3. **Cost ledger skeleton** (ADR 0010): budgets per tenant and company, and a deterministic ledger a job is charged against before it runs.
4. **The first task-executable kind:**
   - one deterministic, company-scoped handler, added to the allowlist in a reviewed migration;
   - reached through a SECURITY DEFINER worker capability that resolves tenant, company and task from the lease;
   - worker SELECT on domain tables only if that handler reads them;
   - kill switch and budget checked on that path.
5. **Event delivery:** decide the consumer model ~~(per-tenant cursor versus global `seq`)~~ and build one deterministic consumer. *(Narrowed 2026-09-13, ADR 0015 owner decision 5: `seq` is internal only, so any tenant-facing consumer, cursor or Agent Runtime reader needs a tenant-scoped or opaque cursor, designed first.)*
6. **Carry-over:** decide ADR 0008's registry publication scope.
7. **Correlation id trust model** *(added 2026-09-13, owner)*: decide how `correlation_id` is validated and trusted. Every domain function accepts a caller-supplied `correlation_id` today, and `ops.events` stores it unvalidated.
8. **Domain mutation idempotency** *(added 2026-09-13, owner)*: a retried `create_task`, `record_event` or other domain operation must not duplicate business work. Today only job creation is idempotent; the Company OS create functions are not.
9. **Tenant-facing event cursor** *(added 2026-09-13, owner)*: design a tenant-scoped or opaque cursor before any tenant-facing event or job-event reader exists. `ops.events.seq` and `ops.job_events.id` stay internal (ADR 0015 owner clarification, SI-26).

Explicitly **not** in Phase 1D: the approval engine (ADR 0009), principals and a human operator API (ADR 0004), a Tool Gateway beyond capability objects, any UI.

---

## Classification

# READY FOR PHASE 1D — CI VERIFIED

**CI:** [run 34770182266](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34770182266) on `e160debb`, 2026-09-13. Every required check is green in the job logs (§22):

- database security and reproducibility, before and after a clean reset;
- the Phase 1C SQL/domain suites (`company_domain_core.sql`, 6 of 6 database suites);
- the Data API `ops` exposure probe (340 requests, 5 credentials, none reached `ops`);
- worker/runtime regression tests (42 passed);
- unit tests (1129 passed, 2 skipped);
- typecheck, ESLint and build;
- the secret build scan (0 blocking, 0 advisory);
- the migration and security guards.

The only red checks, `e2e-test` and Prettier, are identical to the baseline [run 34715191426](https://github.com/yurizache-cpu/atomic-crm/actions/runs/34715191426) on `7d41efff`: the same 9 failed and 1 skipped Playwright tests, and the same 2 unformatted files. Neither is a Phase 1C regression.

Everything else the signoff requires was measured locally on 2026-09-13:

- **Mutation testing:** 41 / 41 caught by their named assertion, with every application and restore proven.
- **M16:** reproduced, classified as a real gap, and closed.
- **Test strength:** three further weaknesses found and fixed (M18's expectation, M14b, F1's literal oracle).
- **No placeholders:** the report has none left.
- **Clean resets:** every reset exited 0.
- **Suites:** all database, driver-backed and unit suites, typecheck, lint, build and the secret scan are green, and Prettier passes on every changed file it checks (§20; the repository-wide check has 2 pre-existing failures, §22).
- **Local network:** the exposure is closed and its regression check committed.

**Phase 1D has not started.** ~~The owner's architectural review of ADR 0015, together with ADRs 0002 and 0003 (Appendix A, item 1), is still required before anything is built on them.~~ **Updated 2026-09-13:** the owner accepted Phase 1C and ADR 0015, with an addendum. The review of ADRs 0002 and 0003 is still required before anything is built on them, and ADR 0002 is blocked on ADR 0011 item 4. *(Later 2026-09-13, pre-1D closure: ADR 0003 accepted; the MCP function removed; ADR 0002 now blocked on the `merge_contacts` owner-session pool instead.)*
