# Permissions

**Date:** 2026-09-11 (Phase 0.5). Describes the permission model **as it exists**, and marks clearly what is designed but not built.

---

## 1. The layers, and which one is authoritative

| Layer | What it does | Is it a security boundary? |
| --- | --- | --- |
| `canAccess` (frontend) | Hides resources a role may not use | **No.** UX only. It runs in the browser. |
| PostgREST grants (`06_grants.sql`) | Which roles may touch which tables at all | **Yes** |
| RLS policies (`05_policies.sql`) | Which *rows* a principal may see and change | **Yes — the authoritative one** |
| Edge function checks | Per-endpoint authorization | Yes, where implemented |
| ~~MCP function~~ | — | **Removed 2026-09-13** and kept out of the committed deploy paths ([ADR 0011](adr/0011-mcp-trust-boundary.md), SI-03) |

**The rule:** if a permission is not expressed in RLS or a grant, it is not enforced. Anything the frontend alone prevents is a convenience.

---

## 2. Database roles

| Role | Grants |
| --- | --- |
| `anon` | Revoked. Default privileges also revoke tables, sequences and function execute. |
| `authenticated` | `usage` on `public`; per-table grants; row visibility then narrowed by RLS |
| `service_role` | `all` on all tables/sequences/functions — used by edge functions only, never reachable from a browser |
| `postgres` | ~~Superuser.~~ Not a superuser on Supabase (`rolsuper=false`), but `BYPASSRLS` *(corrected 2026-09-13)*. ~~**The MCP function's pool defaults to it**~~ The MCP function that pooled as it was removed on 2026-09-13; `merge_contacts` still pools it, as `authenticated` for each transaction (SI-27) — see [SECURITY.md](SECURITY.md) |

Default privileges revoke from `anon`/`authenticated` for future objects, so a newly created table is not accidentally world-readable. That is the correct deny-by-default shape and it should be preserved.

---

## 3. Application roles

Two, on `public.sales`:

- **`owner`** — administrative authority. `is_admin()` in `supabase/schemas/` requires `role = 'owner'` and `disabled = false`.
- **`operator`** — ordinary user. The `handle_new_user` trigger assigns this.

⚠️ **Two contradictory models are live at once**, and any work here must say which it targets:

| | `supabase/schemas/` (declarative, unmigrated) | `supabase/migrations/` (what a real database has) |
| --- | --- | --- |
| `is_admin()` | `role = 'owner' and disabled = false` | `administrator = true` — no role, no disabled check |
| First signup | `operator`, not admin | **administrator = TRUE** |
| Net effect | **No owner can ever be created** — every `is_admin()` policy is unreachable, so tag creation and settings writes are dead | A working admin exists |

The declarative model is the intended one and it has a bootstrap deadlock: signup is disabled in three places, `authenticated` has no INSERT on `sales`, the invite endpoint requires an existing owner, and the first-user bootstrap UI was deleted. Closing that needs a deliberate, audited provisioning path — it is Phase 1 security work, not a quick fix.

---

## 4. Row scoping today

`public.*` is scoped by **`sales_id`** — a per-*user* column — through SECURITY DEFINER helpers (`02_functions.sql`): `current_sales_id()`, `is_active_sales_user()`, `can_manage_sales_id()`, `can_access_contact()`, `can_access_deal()`, plus the inherited `is_admin()`.

Two consequences that matter:

1. **There is no tenant axis.** `sales_id` answers "which user", never "which company". `public.companies` means *CRM customer account*, not tenant. Multi-tenancy is [ADR 0002](adr/0002-tenancy-model.md) and does not exist. *(2026-09-13: still true of `public.*`. The engine's tenant axis exists in `ops` since Phase 1A; `ops.companies` is an organisational entity inside a tenant, never a tenant or an isolation boundary, and businesses that need independent isolation are separate tenants — ADR 0015 owner addendum.)*
2. **Every helper resolves through `auth.uid()`**, i.e. an end-user JWT claim. That is fine for a browser session and **cannot work for a background worker**, which holds no JWT — the reason for [ADR 0012](adr/0012-worker-tenant-context.md).

No table uses `force row level security`, so the table owner bypasses every policy. *(2026-09-13: true of `public.*`. Every `ops` table has used FORCE since Phase 1A, which binds only an owner without `BYPASSRLS`, not `postgres`.)*

---

## 5. Frontend gating (`canAccess`)

Changed in Phase 0.5 from a deny-list ending in `return true` to an **explicit allow-list**.

- `admin` → everything.
- `sales` and `configuration` → denied to non-admins (explicit denials, kept so intent survives an allow-list edit).
- Any other resource → allowed **only if listed**: `companies`, `companies_summary`, `contacts`, `contacts_summary`, `contact_notes`, `deals`, `deal_notes`, `tags`, `tasks`, `lead_profiles`, `acquisition_attributions`, `loss_reasons`.
- **Anything else → denied.**

Why it mattered: the old default granted access to every resource nobody had thought of — including every engine resource the Company OS will add (`ops_agents`, `ops_approvals`, `ops_audit_log`, cost tables). A gate whose default is "yes" grants access to things that do not exist yet. 24 tests now pin this, including those future names.

**Adding a resource to the app means adding it here deliberately.** Forgetting denies access, which is visible and safe.

---

## 6. Designed, not built

- ~~**Tenant scoping for the engine** — scoped non-superuser role + transaction-local `app.tenant_id` GUC, read by one SECURITY DEFINER helper, with NULL matching no rows.~~ *(Built 2026-09-12 in a different shape: the tenant is resolved from a live lease, never from a GUC the worker writes; see the Phase 1A section below.)* [ADR 0012](adr/0012-worker-tenant-context.md), Accepted 2026-09-12.
- **Autonomy levels 0–4**, risk `LOW|MEDIUM|HIGH|CRITICAL` as seeded data, maker→checker→approver, and **unmatched action → CRITICAL → refused**. [ADR 0009](adr/0009-governance-envelope.md).
- **Kill switch** with global/company/department/agent/integration scopes, deny-wins, fail-closed on an unreadable switch. [ADR 0010](adr/0010-cost-control-and-kill-switch.md).

None of these exists in code. They are recorded so the first phase that needs them builds them rather than rediscovering the requirement. *(2026-09-13: the engine tenant scoping above does, since Phase 1A.)*

---

## 7. Verification status

The `canAccess` behaviour is **verified by tests that run today**. Everything in sections 2–4 is **unverified** — it depends on a database, and Docker is not running here. In particular, no test has ever asserted an RLS outcome: that remains the largest test gap in the repository.

---

## 8. The engine worker (Phase 1A, 2026-09-12)

A fourth database identity exists, and it is the first one in this project designed for least privilege rather than inherited from Supabase.

| | `ops_worker` |
| --- | --- |
| Login | **no** — no credential exists in a migration. Production creates a login role at deploy time and grants it `ops_worker`; the worker does `set local role ops_worker` per transaction, the same shape PostgREST uses for `authenticated`. |
| `BYPASSRLS` / superuser | no (asserted by the migration and by the test suite) |
| `public` schema | nothing |
| `ops` schema | `SELECT` on `tenants`, `jobs`, `job_events` — all filtered by RLS to the leased tenant |
| Writes | **none, anywhere.** `lease_job` / `complete_job` / `fail_job` are `SECURITY DEFINER` and verify the lease first, so the worker cannot extend its own lease, reassign a job, or settle another tenant's work. |
| Enqueue | **no.** `ops.enqueue_job` is granted to `service_role` only; a worker that could create work for an arbitrary tenant would undo the lease binding. |

Row scoping in `ops` is by **tenant**, resolved from the live lease — not by `sales_id` as in `public.*`, and not from a GUC the caller writes. See [ADR 0012](adr/0012-worker-tenant-context.md).

The static migration guard treats `ops_worker` as a **scrutinised** role rather than an exempt one: it is deliberately not in `BYPASS_ROLES`, and a migration granting it a write verb is rejected before it applies.

---

## 9. How the worker actually connects (Phase 1B, 2026-09-12)

`ops_worker` is `NOLOGIN` by design: a password in a migration is a secret in git. A deployment therefore runs one extra step.

| | |
| --- | --- |
| Script | `scripts/provision-worker-role.mjs` (also `npm run worker:provision`) |
| Creates | `ops_worker_login` — LOGIN, **NOINHERIT**, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, member of `ops_worker` |
| Holds directly | **nothing.** Every privilege is reached by `set local role ops_worker` for the duration of one transaction, exactly as PostgREST reaches `authenticated`. |
| Credential | `OPS_WORKER_PASSWORD` from the environment, interpolated into SQL delivered on **stdin** — never `psql -v`, which would put it in `argv` where `ps` can read it. |
| Runtime | `OPS_WORKER_DATABASE_URL`. Never the `postgres` or `service_role` connection string; the process refuses to boot on those. |

**Supabase hosting, measured rather than assumed.** The project's `postgres` role is `rolcreaterole = true`, so `create role ... login` works over an ordinary connection — no dashboard step. What does *not* work is `alter role ... nosuperuser | nobypassrls`: naming either attribute requires the caller to **be** a superuser, and Supabase's `postgres` is `rolsuper = false`. The rotation path therefore sets only what it may set, and the script's verification block **refuses** a pre-existing role that carries either attribute rather than silently trying to strip it.

**New grants to `ops_worker` in Phase 1B**, all functions, still no write verb on any table:

| Function | Why it is safe to expose |
| --- | --- |
| `ops.resume_lease(text, uuid)` | Verifies leased + unexpired + owned-by-caller before installing any context. A forged or stolen job id yields no context, so the transaction sees nothing. |
| `ops.settle_job_failure(uuid, text, text)` | Verifies the lease. The **database** decides retry vs terminal from `attempts`, which the worker cannot write. |
| `ops.complete_job(uuid, text)` | The Phase 1A function plus a detail line. Same lease check. |
| `ops.worker_heartbeat(text, text)` / `ops.worker_stopped(text)` | Write only `ops.worker_instances`, which carries no tenant data and has RLS enabled, forced, and **no policy at all**. |
| `ops.reap_expired_leases()` | Can only touch leases that have **already** expired, so it cannot steal live work — and the worker could already trigger it indirectly through `ops.lease_job`. |
| `ops.purge_inbound_email_ledger(integer, integer)` | The one capability that reaches `public`. Tenant from the live lease; refuses any tenant without `owns_local_crm`; retention window floored at 30 days in the database. |

`ops.enqueue_job` remains **closed** to the worker. Nothing in Phase 1B needed continuation jobs, and capability added before it is needed is capability nobody reviewed.

---

## 10. The Company OS domain (Phase 1C, 2026-09-12)

`ops.companies`, `ops.departments`, `ops.agents`, `ops.tasks`, `ops.events` and `ops.task_jobs`, and the functions that change them. [ADR 0015](adr/0015-company-os-domain-core.md).

| Role | Tables | Functions |
| --- | --- | --- |
| `anon`, `authenticated` | nothing (no USAGE on `ops` at all) | nothing |
| `service_role` | nothing | nothing new — still only `ops.enqueue_job` from Phase 1A |
| `ops_worker` | **nothing** — not even SELECT | nothing |
| `postgres` (owner) | everything | everything |
| PUBLIC | — | **nothing**: every function is revoked explicitly, because PostgreSQL's default is EXECUTE to PUBLIC and the Phase 1A per-schema revoke does not remove it (measured) |

**This is a privilege boundary.** In Phase 1C the only reader and writer is the owner: the driver-backed tests and the dev seed. No operator tool ships. The first runtime caller — a worker capability or a human API — gets a SECURITY DEFINER wrapper that takes no tenant argument and resolves it itself, never a postgres connection string.

**Every Company OS function is SECURITY INVOKER** and takes an explicit `p_tenant_id`: the scope the caller is already authorised for. Every other id is untrusted and must resolve inside that scope, otherwise the answer is "not found" (`OS404`) whether or not it exists elsewhere. INVOKER is what keeps a future EXECUTE grant harmless: the grantee would still hit `42501` on the tables.

**Read policies with no grant.** Each domain table has `for select to ops_worker using (tenant_id = ops.current_tenant_id())`, the same lease binding as every `ops` policy, and no SELECT grant. The day a worker needs a read, the grant is one line and the scope already exists.

**Domain refusals have their own SQLSTATEs**, so a native permission failure is never mistaken for one:

| SQLSTATE | Meaning |
| --- | --- |
| `OS400` | invalid argument (including a change with no declared event provenance) |
| `OS401` | no tenant scope |
| `OS403` | refused: a job kind that is not task-executable, or a reserved lifecycle event namespace |
| `OS404` | not found in this tenant or company |
| `OS409` | invalid state: inactive entity, closed task, illegal transition, immutable column, idempotency conflict |

**The task → job bridge needs no new grant.** `ops.request_task_execution` inserts its job into `ops.jobs` itself, with its caller's privileges (today only the owner), instead of calling `ops.enqueue_job`: that function's idempotent path returns whichever job holds the key, and a concurrent `service_role` enqueue under a task's namespaced key was measured being adopted. The bridge refuses the resulting unique violation with `OS409` and writes the same `enqueued` row in `ops.job_events`. `service_role`'s one `ops` capability, `ops.enqueue_job`, is unchanged.

The static migration guard now also rejects, before anything applies:

- any grant on an `ops` object to `authenticated` or to a bypass role, beyond the two pinned Phase 1A `service_role` grants, keyed by privilege;
- `ALTER DEFAULT PRIVILEGES` that would reach future `ops` objects;
- disabling or downgrading an `ops` trigger;
- dropping an `ops` trigger without re-creating it at top level in the same migration, and re-enabling it `ALWAYS` if it was;
- `CREATE OR REPLACE TRIGGER` on an `ALWAYS` trigger without re-enabling it, because the replacement fires in ORIGIN mode (measured);
- any `DROP … CASCADE` that reaches `ops`;
- `SET session_replication_role`;
- a `search_path` that sends unqualified names into `ops`.

---

## 11. Agent runs and execution stops (Phase 1D, 2026-09-14)

`ops.agent_runs` and `ops.execution_stops`, and the functions that touch them. [ADR 0016](adr/0016-agent-runs-and-model-providers.md).

| Role | Tables | Functions |
| --- | --- | --- |
| `anon`, `authenticated` | nothing (no USAGE on `ops` at all) | nothing |
| `service_role` | nothing | nothing new — still only `ops.enqueue_job` |
| `ops_worker` | **nothing** — no SELECT on runs, stops, tasks or agents | EXECUTE on the six capabilities below, and nothing else new |
| `postgres` (owner) | everything | everything, including `ops.request_agent_run` and the three stop functions |
| PUBLIC | — | **nothing**: every new function is revoked explicitly |

**Why capabilities and not grants.** The handler needs one run's bounded prompt context. A SELECT grant on `ops.tasks` and `ops.agents`, even under the lease-bound read policies, would expose every task of the leased tenant. A capability returns exactly the one run bound to the lease.

| Function | Why it is safe to expose to `ops_worker` |
| --- | --- |
| `ops.claim_agent_run()` | Resolves the run bound to `(lease tenant, app.job_id)`; takes no argument. Returns the agent's name, role and description and the task's type, title, description, priority and due date — no id, slug or timestamp beyond the due date. Settles a run an earlier attempt left running; refuses (42501) a second claim by the attempt that started it. |
| `ops.start_agent_run(provider, model, prompt version, fingerprint)` | Re-checks every gate and the kill switch, serialised with tripping. Records `running` only for a pending run. Only the token `running` means "call". The arguments are facts about the call, shape-checked; none selects a row. |
| `ops.refuse_agent_run(code)` | A pending run only, recorded `failed` / `configuration`; a code the database reserves is replaced. |
| `ops.complete_agent_run(result, …)` | A run `running` under this very attempt only; otherwise `not_running`. The database re-validates the result and stores a refused one as `failed` / `schema_validation` / `database_contract`. |
| `ops.fail_agent_run(category, code, …)` | Same attempt check. The worker reports a category, and the **database** decides `failed` or `indeterminate`; an unknown category is `unknown`, which is indeterminate. A reserved code is dropped. |
| `ops.settle_stale_agent_runs()` | Checks no lease, like `ops.reap_expired_leases`. It settles only runs whose attempt is provably dead: `running` without the same attempt's live lease becomes `indeterminate`, and `pending` whose job already ended becomes `failed` / `job_failed`. It skips rows another transaction holds, so it cannot settle a run whose worker is inside its prepare or settle transaction. |

Every run capability first share-locks the leased job and requires the lease to be live on the current clock (`clock_timestamp()`) when it begins, so a job inside a worker transaction cannot be reaped underneath it. `ops.start_agent_run`, the one step whose answer leads to a paid call, checks the lease on the clock again after its own lock waits and before any write, so a lease that ran out while it waited starts nothing (`42501`). *(Corrected 2026-09-14 after the seam review: this sentence said a lease expiring at any point of the transaction was refused, while each capability checked only when it began.)*

**Execution stops are owner-only in both directions.** No application role can read, trip or clear one. The CLI runs with the owner connection (`ADMIN_DATABASE_URL`). A stop cannot be deleted while active or truncated, even by the owner outside `DISABLE TRIGGER`. `ops.active_execution_stop` raises `OS403` rather than answer "no stop" if row security would filter its read.

**SQLSTATEs added to the Phase 1C set's meanings:**

| SQLSTATE | New use |
| --- | --- |
| `OS403` | a capability that is not an agent run capability; a stop read under row security |
| `OS409` | an idempotency key naming a different agent run request; a retry of an unfinished run; a trip that found no stop in force |
| `42501` | a run capability without a live lease, with a lease no longer live, with no run bound to the job, or a second claim by the starting attempt |

## 12. Prices, spend limits and the lease-time switch (Phase 1D.1, 2026-09-17)

`ops.model_prices` and `ops.spend_limits`, the cost columns on `ops.agent_runs`, and the functions that touch them. See [ADR 0017](adr/0017-runtime-governance.md).

| Role | Tables | Functions |
| --- | --- | --- |
| `anon`, `authenticated` | nothing (no USAGE on `ops` at all) | nothing |
| `service_role` | nothing | nothing new: still only `ops.enqueue_job` |
| `ops_worker` | **nothing**, not even SELECT on prices or limits | EXECUTE on `ops.start_agent_run(text, text, text, text, integer)`, which replaces the four-argument start, and on the three capabilities below; nothing else new |
| `postgres` (owner) | everything | everything, including the owner services listed below |
| PUBLIC | — | **nothing**: every new function is revoked explicitly |

**Owner services.** All are SECURITY INVOKER and executable by no application role; `npm run ops` calls them over `ADMIN_DATABASE_URL`.

| Service | Signature and behaviour |
| --- | --- |
| `ops.record_model_price` | Signature: `(provider, model, input, output, reasoning_in_output, effective_from, expires_at, source, actor [, cached])`. |
| `ops.set_spend_limit` | Signature: `(scope, daily_limit_micros, timezone, reason, actor [, tenant, company])`. It supersedes the active version; changing the time zone needs a retire first. |
| `ops.retire_spend_limit` | Signature: `(limit, reason, actor)`. |
| `ops.spend_status` | Signature: `([at])`. It reads across tenants, which is why only the owner may call it. Each active limit's row reports `settled_exhausted` (settled spend has reached the limit, never counting calls in flight) and `new_run_admission`, what that limit alone does to the next start: `blocked` when charged spend has reached the limit, so it admits no run with a reservation above zero; `conditional` otherwise, so it admits a run only if its reservation fits `remaining_micros`, while the price, every other applicable limit and the stops still decide. A missing limit has no row. A false `settled_exhausted` never means a run can start. `at` is meaningful only for now or a future instant: for an earlier instant the row reports that day's window start but counts later runs too. |
| `ops.trip_execution_stop` | It gains a trailing `p_job_kind`. |
| `ops.create_task`, `ops.record_event` | Each gains a trailing `p_idempotency_key`. |

**Capabilities.** All three are SECURITY DEFINER and take no argument.

| Function | Why it is safe to expose to `ops_worker` |
| --- | --- |
| `ops.job_execution_stop()` | Resolves the job this transaction's live lease holds, share-locking it. It takes the kill-switch lock shared, then returns the stop covering that job, or NULL. It reads only the stop table and the job's own agent run or task link. It cannot name another job, and a job without a live lease raises `42501`. |
| `ops.defer_job()` | Resolves the same leased job. It re-evaluates the stops under the shared lock. Only when a stop covers the job does it return the job to `queued`, restore the attempt this lease spent, delay it 30 s and record a `deferred` job event. With no covering stop it changes nothing, so a worker cannot use it to keep a job alive or dodge `max_attempts`. The runtime calls it after its own pre-call check finds a stop, and after `ops.start_agent_run` answers `stopped`, in the same transaction; if it then finds no covering stop, the prepare rolls back and the attempt fails through the transient path, with nothing called. |
| `ops.enforce_spend_ceiling()` | Checks no lease, like the reaper and the sweep. It trips a global stop, as `system:spend_ceiling`, only when the database finds the active ceiling version exhausted by settled spend. It never clears a stop, and it refuses (`OS403`) if row security would hide what it reads. The most a malicious worker can do with it is trip a stop the ceiling already justifies. |

**What the start now checks, and when.** `ops.start_agent_run` works in this order:
1. It takes the kill-switch lock shared. If an active stop covers the run, it answers `stopped` at once and evaluates no other gate.
2. It checks the price and the route ceiling.
3. It takes the global, tenant and company spend locks exclusively, each in its own statement, and reads the totals.
4. It re-checks the lease on the clock before any write, as in Phase 1D.

**`stopped` writes nothing** *(owner review, 2026-09-17, decision B)*. The run stays `pending`, with no stop, error code, price or charge. The runtime defers the job with `ops.defer_job()` in the same transaction, while the start's kill-switch lock is still held, so the stop cannot be cleared in between: no attempt is spent and nothing is called. After an explicit clear, the next lease runs the same run, and every gate is checked again at its start. Only `running` still means "call". A request made while a stop covers it is still refused and recorded `cancelled` / `refused` / `execution_stopped`, naming the stop, before any job exists.

`ops.claim_agent_run` now share-locks the task and agent rows it returns until the prepare transaction ends. Every worker transaction runs with `idle_in_transaction_session_timeout` (10 s), so a stalled worker cannot hold these locks indefinitely.

**The lease.** `ops.lease_job` takes the kill-switch lock shared and passes over any queued job whose kind is not internal and that an active stop covers. It refuses (`OS403`) when row security would hide the stops, like every other reader of the switch, so an unreadable switch leases nothing. It refuses to run under any isolation level other than READ COMMITTED, as the request and spend admission do, and as the start does before it reads stops, prices or spend totals.

**SQLSTATEs added to the Phase 1D set's meanings:**

| SQLSTATE | New use |
| --- | --- |
| `OS400` | a stop on a kind that is not external; an unknown time zone; a rate with more than six decimals; an isolation level other than READ COMMITTED |
| `OS403` | a governance reader for whom row security would filter prices, limits, runs or stops |
| `OS409` | a different price version at the same moment; a limit version whose time zone differs from the active one; an idempotency key naming a different task or event request; a price, limit, stop or run rewritten outside its one allowed change |
| `OS429` | a start the limits cannot absorb beside calls in flight; nothing is recorded, and the job retries |
