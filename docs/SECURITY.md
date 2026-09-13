# Security

**Date:** 2026-09-11 (Phase 0.5). **Scope:** the fork as it exists — an Atomic CRM instance plus a harness. No engine, no agents, no integrations beyond inbound email.

This document describes the **actual** posture, including what is still open. It is not an aspiration; where something is designed but not built, it says so.

---

## 1. Principles

These are enforcement rules, not preferences. Each one exists because this repository violated it at least once.

1. **Anything enforced only by an LLM prompt is not a security boundary.** A model asked to behave is not a control.
2. **Anything enforced only by frontend code is not a security boundary.** The frontend hides menus; it does not protect data.
3. **Unknown operations fail closed.** An action nobody classified is denied, not allowed. `canAccess` used to end in `return true`; that is the shape to never ship again.
4. **External content is untrusted.** A WhatsApp message, an email, a CRM note or a web page may contain instructions. It is data, always.
5. **SQL execution is privileged.** Arbitrary SQL is the largest blast radius in the system and is not an agent capability.
6. **Browser automation is privileged.** Same reasoning; it inherits every authenticated session it can reach.
7. **Cross-tenant access is structurally prevented** — by the database, not by a `WHERE` clause someone has to remember.
8. **Autonomous actions are auditable.** Who, what, when, why, which tool, which evidence, what cost, what result.
9. **Destructive actions require explicit policy.**
10. **Secrets never enter model context** unless strictly necessary.

**Defence in depth is required, not preferred.** A single validator, however good, is one bug away from being no validator.

---

## 2. Trust boundaries

| Boundary | Enforced by | State |
| --- | --- | --- |
| Browser → `public.*` | PostgREST + RLS policies | In place; RLS rewritten to per-`sales_id` scoping, **unmigrated** |
| Browser → engine (`ops.*`) | Schema left out of the PostgREST allowlist and search path; `anon` and `authenticated` hold no USAGE on `ops` | ~~Designed; `ops` does not exist yet~~ Built and probed since Phases 1A and 1C (SI-15, SI-21) — [ADR 0002](adr/0002-tenancy-model.md) |
| ~~MCP function → database~~ | ~~A superuser pool, downgraded per transaction~~ | **Removed 2026-09-13** and kept out of the committed deploy paths (SI-03) — see [ADR 0011](adr/0011-mcp-trust-boundary.md) |
| Worker → tenant data | `ops_worker` (NOLOGIN, no `BYPASSRLS`), tenant resolved from a live lease ~~Scoped role + transaction-local GUC~~ | Built and tested since Phases 1A and 1B (SI-13, SI-14, SI-16) — [ADR 0012](adr/0012-worker-tenant-context.md), Accepted 2026-09-12 |
| Frontend resource gating | `canAccess` | Deny-by-default since Phase 0.5; **UX only, never the boundary** |

The load-bearing correction of Phase 0.5: ADR 0002 claimed the engine would be "unreachable from any browser by construction". That was **false** — the MCP function holds a direct libpq superuser connection that ignores the PostgREST allowlist entirely. The claim is now narrowed to "unreachable *through PostgREST*", and the second channel is governed by ADR 0011. *(2026-09-13: `postgres` is `BYPASSRLS`, not a superuser, on Supabase; and the MCP function was removed, so that second channel no longer exists — ADR 0011 addendum, SI-03.)*

---

## 3. What Phase 0.5 closed

### Arbitrary SQL (`validateSql`)

*(2026-09-13: the function this section describes is removed; see ADR 0011's addendum. The section stays as the Phase 0.5 record.)*

- **Was:** `WITH x AS (SELECT 1) DELETE FROM contacts` passed the read-only gate. The classifier walked a `WITH` node's CTE bindings but never the statement the `WITH` was attached to, so the collected types were `{with, select}`. **Reproduced against the pinned parser before changing anything.**
- **Now, two independent layers:**
  1. **Database-level.** `query` runs its transaction under `SET TRANSACTION READ ONLY`. Postgres itself rejects every write, so a validator bug is no longer a write primitive. The `readOnly` parameter **defaults to true**, so a future call site that forgets to declare intent gets the restrictive mode.
  2. **AST-level.** The classifier recurses into both halves of a `WITH` and caps recursion depth; unrecognised node shapes contribute their own type and therefore land outside the allow-list — it fails closed by construction.
- **Tests:** 7 adversarial cases (CTE attached to DELETE/UPDATE/INSERT, schema-qualified, nested, comment/whitespace-split, with RETURNING). Verified by mutation: reverting the fix fails exactly those 7.

### Frontend authorization (`canAccess`)

Inverted from a deny-list ending in `return true` to an explicit allow-list. Unknown resource → denied, for every action and every role. 24 tests, including every future engine resource name (`ops_agents`, `ops_audit_log`, …) which the old code allowed. **This is a UX gate, not a security boundary** — RLS is.

### Storage

The `attachments` bucket was documented as closed and was **open in every migrated database**. `07_storage.sql` expresses the intent as DML, which `db diff` can never emit. Fixed with a hand-written migration that closes the bucket, drops the three blanket `authenticated` policies, and **asserts the end state**, so a `db reset` fails loudly if it is ever reopened.

### Harness gates (fail-open → enforced)

- `validate-on-stop` **validated nothing on Windows** — its worktree filter compared git-reported POSIX paths against `join()`-built ones and matched nothing, which the caller read as "nothing to validate".
- `cleanup-worktree` **deleted live worktrees with uncommitted work**, because the guard in front of a recursive `rmSync` failed the same way.
- `restrict-documentator-write` degenerated to deny-everything (fails safe, but broke the agent).
- `check-config-sync` and `pending-deploys` never executed their CLI block, so the config-sync gate and the orchestrator's migration gate **exited 0 without running**.
- The `claude` test project now runs in CI — it never did, which is how all of the above shipped.

---

## 4. Known-open risks

Ranked by what an attacker or an accident reaches first.

| Risk | Status |
| --- | --- |
| **`SELECT extensions.http_get(…)`** — SSRF/exfiltration from inside the database via a legal read-only statement. `SET TRANSACTION READ ONLY` does not stop it (it is not a database write). | Workstream D; needs `REVOKE EXECUTE` and a live database to verify |
| **`merge_contacts` destroys `do_not_contact`** and all acquisition attribution — the new FKs cascade and the function re-points only `tasks` and `contact_notes`. LGPD-relevant. | Workstream E |
| **Postmark webhook returns 200 on every ingestion failure** — no retry, no durable record, silent data loss. | Workstream F |
| **MCP `jwtVerify` has no audience check** — any token this project issued is accepted (confused deputy). | ~~Open~~ Closed 2026-09-13: the function is removed |
| **MCP `get_schema` runs without the role downgrade** on the superuser connection. | ~~Open~~ Closed 2026-09-13: the function is removed |
| **MCP logs full SQL statements** including names, emails and note text — an uncontrolled secondary store of personal data under LGPD. | ~~Open~~ Closed 2026-09-13: the function is removed |
| **`x-forwarded-host` is trusted** when building OAuth metadata and the 401 challenge. | ~~Open~~ Closed 2026-09-13: only the removed MCP function built that metadata |
| **Secrets are committed by design** — `.gitignore` un-ignores `supabase/functions/.env`; an EC private signing key is tracked in `supabase/signing_keys.json`; `.env.development` and `.env.e2e` match no ignore pattern at all. | Open; needs rotation, which is its own change |
| **`delete_note_attachments`** lets any authenticated user delete any file via the service role. | Open |
| **`users`/`patchUser` ordering** mutates auth email and ban state before the owner check. | Open |
| **Two contradictory auth models** — `schemas/` has an unreachable owner bootstrap; `migrations/` makes the first signup an administrator. | Open |
| **No secret scanning** anywhere in CI or the local loop. | Open |

---

## 5. Threat model for what comes next

When agents exist, the assumptions change. Recorded now so the design accounts for them:

- **An agent is an untrusted caller with credentials.** It may be steered by content it reads. Every capability it holds must be enforced outside it.
- **Prompt injection is an expected input, not an incident.** A CRM note or an inbound email is attacker-controlled text that an agent will read.
- **The blast radius of a tool is its worst call, not its intended one.** Arbitrary SQL and unrestricted browser automation both fail that test, which is why neither is an agent capability.
- **Cost is a safety property.** Unbounded spend is an availability incident; see the kill switch in [ADR 0010](adr/0010-cost-control-and-kill-switch.md).

---

## 6. Verification status

Everything above that touches the database is **unverified**, because Docker is not running in this environment. Specifically unproven: the RLS policies, the grants, the storage assertion, and any claim about what a migrated database actually contains. See the BLOCKED section of [PHASE_0_5_REPORT.md](PHASE_0_5_REPORT.md).

Application-layer and harness claims **are** verified by tests that run today.

---

## 7. Phase 1A — the tenant-safe execution substrate (2026-09-12)

The canonical, executable list is [SECURITY_INVARIANTS.md](SECURITY_INVARIANTS.md) / `supabase/tests/securityInvariants.test.ts`. Three invariants were added:

- **SI-13** — the engine worker holds no write verb anywhere in `ops` and no `BYPASSRLS`. Every job transition goes through a `SECURITY DEFINER` function that verifies the lease first.
- **SI-14** — tenant context is derived from a **live lease**, never asserted by the worker, and dies with the transaction.
- **SI-15** — `ops` is unreachable by `anon`/`authenticated` and absent from the PostgREST allowlist.

**The trust boundary moved.** Before Phase 1A, anything running server-side ran as `service_role`, which carries `BYPASSRLS` — so "background work" and "full database access" were the same thing. The worker is now `ops_worker`: `NOLOGIN`, no `BYPASSRLS`, `SELECT` on three `ops` tables, `EXECUTE` on three lease-checking functions, and nothing at all in `public`. *(2026-09-13: that was Phase 1A. Since Phase 1B `ops_worker` has SELECT on `tenants`, `jobs`, `job_events` and `queue_metrics`, and EXECUTE on the eleven functions pinned by `company_domain_core.sql` A4, three of which check no lease: `worker_heartbeat`, `worker_stopped` and `reap_expired_leases`. It still holds no privilege in `public`.)*

**The one measurement that shaped the design.** A worker can set any GUC — `set_config` is executable by PUBLIC, and a probe confirmed a worker role setting a tenant GUC and reading another tenant's row. So tenancy is not carried in a GUC the worker writes; it is resolved from an `ops.jobs` row that is leased, unexpired and owned by that worker. The bound, stated plainly: against a fully malicious worker *process* the limit is `ops_worker`'s grants, not one tenant. Against the threat that actually matters — a bug that forgets the context, or a tenant taken from the job **payload**, which is where LLM output arrives in Phase 1B — tenancy is unreachable.

Proven by `supabase/tests/ops_execution_core.sql` and `jobLeasingConcurrency.mjs` (`npm run test:db`), mutation-verified 10/10. Unchanged and still open: the edge functions run as `service_role` (SI-06).

---

## 8. Phase 1B — the production worker runtime (2026-09-12)

Phase 1A proved the substrate. Phase 1B runs a real process against it, and three things changed as a result.

**The worker's identity is now checked at boot, not assumed.** `ops_worker` is `NOLOGIN` and holds no credential, so a deployment must create a login role — `scripts/provision-worker-role.mjs` creates `ops_worker_login`: LOGIN, **NOINHERIT**, member of `ops_worker`, no `BYPASSRLS`. NOINHERIT is the part that matters: the login role holds nothing directly, so `set local role ops_worker` in the runtime is load-bearing rather than decorative, and deleting it fails with `permission denied for schema ops` instead of silently running with whatever the login role carried. The process refuses to start if its identity is `postgres`, `service_role`, a superuser, carries `BYPASSRLS`, or cannot assume `ops_worker` — because that failure is otherwise **invisible**: every job runs correctly and every tenant leaks (SI-16).

**Tenant isolation is now proven through the application driver.** The Phase 1A suites used `psql`, which says nothing about a connection pool. The runtime's own suite runs with `pg` at `max: 1`, asserts `pg_backend_pid()` is identical across transactions, and then shows that a transaction with no lease sees zero rows on that same backend. The adapter deliberately does **not** `RESET ALL` between checkouts: a reset would hide whether the transaction-local guarantee actually holds.

**A defect in the Phase 1A transaction shape was found and fixed.** Leasing and executing in one transaction meant a crashed worker left no trace — the lease rolled back and `attempts` returned to its previous value, so a job that crashes the worker was re-leased forever and lease expiry had nothing to recover. The lease now commits in its own transaction, and `ops.resume_lease` re-reads the trusted row under the same checks to re-install the context. See [ADR 0012](adr/0012-worker-tenant-context.md)'s Phase 1B addendum.

**The first capability sets the shape for every later one.** A handler receives a capability object holding exactly what its registry entry declared — never a database client, never SQL. `ops.purge_inbound_email_ledger` is `SECURITY DEFINER`, takes **no tenant argument**, resolves the tenant from the live lease, refuses any tenant that does not own this deployment's CRM, and floors the retention window in the database so a payload cannot talk it into deleting recent data (SI-18). This is the earliest form of the Tool Gateway. It is deliberately not that yet.

**Unchanged and still open:** edge functions run as `service_role` (SI-06); `net.http_get` remains reachable by `authenticated` (SI-02's residue, ADR 0011). `pg_net` is still absent and was **not** reintroduced to schedule recovery — the reaper runs on the worker's own timer instead.

---

## 9. Phase 1C — the Company OS domain core (2026-09-12)

The organisational model — companies, departments, agents, tasks and events — lives in `ops` and inherits every guard that schema already had. [ADR 0015](adr/0015-company-os-domain-core.md) records the decisions; SI-21 to SI-24 are the invariants. Results and counts are in [PHASE_1C_REPORT.md](PHASE_1C_REPORT.md).

**No principal gained anything.** No application role — `anon`, `authenticated`, `service_role`, `ops_worker` — holds any privilege on a Company OS table or function, and no `ops` function is executable by PUBLIC. That last part needed an explicit revoke per function: PostgreSQL grants EXECUTE on every new function to PUBLIC, and the Phase 1A per-schema default-privilege revoke does not remove it (measured). `ops_worker`'s privileges are unchanged, and `service_role` still holds exactly USAGE on `ops` and EXECUTE on `ops.enqueue_job`. The domain functions are SECURITY INVOKER with an explicit tenant scope, so an EXECUTE grant alone would still hit `42501` on the tables (SI-21).

**Integrity is structural, not procedural.** Composite foreign keys carry `tenant_id` and `company_id` on every reference, so a cross-tenant or cross-company row cannot be stored, even by raw DML (SI-22). The task state machine and "a closed task is immutable" are enforced by an `ENABLE ALWAYS` trigger, which `session_replication_role = replica` does not silence (SI-23). The owner stays outside this boundary, the same line SI-06 draws for BYPASSRLS.

**Execution cannot be triggered from a task.** The task → job bridge takes the job's tenant from the task row, never the payload, and its allowlist is empty: the one registered handler is tenant-wide CRM maintenance and must not be reachable from company-scoped work (SI-24).

**The adversarial pass on the new surface found no Critical, High or Medium.** Five Low findings were confirmed, and all five were closed within the phase:

| Finding | What it was | Closed by |
| --- | --- | --- |
| C1C-SEAM-01 | A `service_role` enqueue under a task's namespaced key, landing between the bridge's idempotency check and its enqueue, was adopted as the task's own request (two-connection race). | The bridge inserts its own job and refuses the unique violation with `OS409`; a driver-backed race test. |
| C1C-01 | The static guard caught `disable trigger` but not `drop trigger`, `create or replace trigger` (which resets ALWAYS to ORIGIN, measured) or `drop … cascade`. | Three rules and eleven new guard cases, each rule mutation-tested. A `create or replace trigger` inside a DO block was still unseen until mutation testing exposed it. |
| C1C-SEAM-02 | ADR 0015 said PL/pgSQL caches the EXECUTE check "per transaction"; for a constant-argument helper it lasts the life of the backend. | Wording corrected. Table privileges, re-checked on every execution, are the stated boundary. |
| C1C-SEAM-03 | No test showed that a lease owned by another worker, or an expired lease, reads nothing from the domain tables. | Cases C6 and C7 in `company_domain_core.sql`. |
| C1C-SEAM-04 | The Data API probe had no GraphQL check, no secret key, no per-credential positive control, a bare-RPC check that could never fail, and never read the live search path. | All added; the check that could never fail was removed. |

**Recorded, not changed.** `ops.events` rows are never updated, but the owner can delete them: erasure needs that. Platform read roles (`pg_read_all_data`, `supabase_read_only_user`) can read `ops`, as they can read everything. `events.seq` is one identity across tenants. An oversize idempotency key used to surface as a btree error; it is now bounded at 200 characters and refused with `OS400`. *(2026-09-13, owner: `events.seq`, `job_events.id` and every future global monotonic identifier are internal only; SI-26.)*

**Found in passing, outside Phase 1C's surface: the local stacks were reachable from the network.** Measured 2026-09-12 on both local Supabase stacks:

- Every published port — Kong, Postgres, Studio, Inbucket — listened on every interface, IPv4 and IPv6, including this machine's global IPv6 addresses.
- Three unauthenticated paths ran SQL as `postgres` from the LAN address and from a global IPv6 address: Kong `POST /pg/query`, Studio `POST /api/platform/pg-meta/default/query`, and Postgres with the default password.
- Traffic from Docker Desktop's WSL VM, which enters the host through its virtual adapter rather than loopback, reached every one of those ports.

The cause is two defaults combined: the Supabase CLI publishes ports with no host address, and Docker Desktop's "Port binding behavior" defaults to "Open". The local API keys and JWT secret are public development defaults, so no credential stands in the way either.

**Mitigation, applied by the owner and verified 2026-09-12:** Docker Desktop's "Port binding behavior" set to "Localhost only", and both stacks recreated.

What was verified, in order:
1. Throwaway containers first:
   - a publish with no host address came up on `127.0.0.1` and `[::1]` only;
   - an explicit `0.0.0.0` publish was refused by the daemon.
2. Only then were the stacks recreated.
3. After recreation:
   - all 16 bindings on 20 containers listen only on `127.0.0.1` and `[::1]`;
   - Kong's `/pg/query`, Studio's query route and Postgres answer on loopback, and refuse on the LAN address, the WSL adapter, both link-local addresses and both global IPv6 addresses;
   - every probe from the WSL VM is refused;
   - containers still reach the host through `host.docker.internal`, and each other by name;
   - `db reset` kept the bindings loopback-only;
   - `test:db` passed 6/6 and `test:db:engine` 42/42.

The cost is machine-wide: Docker now refuses any explicit non-loopback publish for every project on this machine.

Measured before choosing it:

- Explicit `127.0.0.1` / `::1` publishes are honoured end to end. Only loopback listens, the LAN, WSL-adapter and WSL VM paths are refused, and containers still reach the port through `host.docker.internal`.
- Supabase's documented recipe — a network with `host_binding_ipv4=127.0.0.1` passed via `--network-id` — is ignored by Docker Desktop 4.89 / Engine 29.7.2.
- A Windows Defender Firewall rule cannot be relied on here: two third-party firewalls are registered, and the WSL path reached the ports despite Defender's block-inbound default.

**Detection:** `npm run check:local-exposure` (`scripts/local-exposure.mjs`) checks both Docker's effective bindings and the host's actual listening sockets. It exits 1 when anything is exposed and 2 when it cannot verify. `npm run test:db` prints its verdict as a warning, and CI skips it.

**Unchanged and still open:** SI-06 (edge functions as `service_role`), SI-02's residue (`net.http_get`), and [ADR 0008](adr/0008-fork-posture.md)'s publication-scope decision.
