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
| `postgres` | ~~Superuser.~~ Not a superuser on Supabase (`rolsuper=false`), but `BYPASSRLS` *(corrected 2026-09-13)*. ~~**The MCP function's pool defaults to it**~~ The MCP function that pooled as it was removed on 2026-09-13 — see [SECURITY.md](SECURITY.md) |

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
