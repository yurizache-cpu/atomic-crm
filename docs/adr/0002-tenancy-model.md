# ADR 0002 — Tenancy model

**Status:** **Accepted** 2026-09-13 by the owner, under the acceptance bar of the final pre-1D closure (see the last addendum) · **Date:** 2026-09-10 (isolation claim retracted and re-scoped 2026-09-11)

## Context

No tenant discriminator exists: no ~~`company_id` /~~ `tenant_id` / `org_id` on any of the 13 tables. *(Corrected 2026-09-13: `public.contacts.company_id` and `public.deals.company_id` existed then and still do; they reference `public.companies`, the CRM customer account, not a tenant.)* The only scoping axis is `sales_id` — a per-*user* column — baked into 43 RLS policies and 6 helper functions.

- `public.companies` already means *CRM customer account*, not tenant.
- `public.configuration` is pinned to one row by `check (id = 1)` **and** read as `getOne("configuration", { id: 1 })`, so "add a nullable tenant column" is not available.
- `supabase/config.toml:11` exposes schemas to PostgREST by explicit allowlist.
- An empty `private` schema already exists (`01_tables.sql:11`), proving `create schema` survives the workflow.

## Decision

**`tenant_id` + RLS, but only on engine tables in a new `ops` schema that is kept OUT of the PostgREST allowlist.** `public.*` is treated as tenant-one's CRM instance.

## Alternatives

- **Tenant column on `public.*`.** Rejected: requires dropping a CHECK constraint, rewriting 43 policies and every `configuration` reader — for a CRM that is meant to be replaceable anyway.
- **Schema per tenant.** Rejected for now: N schemas × M tables of DDL, and cross-tenant platform queries become painful.
- **Supabase project per tenant.** `scripts/supabase-remote-init.mjs` already automates provisioning, so this stays viable for hard isolation — but cross-tenant operation and cost aggregation get much harder.

## Consequences

- Tenant two can have a different CRM, or none at all.
- ~~The engine is unreachable from any browser **by construction**, not by policy.~~ **Retracted 2026-09-11 — this was materially false and is the reason this ADR cannot be accepted as originally written.** The PostgREST allowlist governs exactly one channel. `supabase/functions/mcp/index.ts:22-25` opens a direct libpq `Pool` whose connection string defaults to the `postgres` ~~**superuser**~~ role *(corrected 2026-09-13: on Supabase `postgres` is `rolsuper=false`, `rolbypassrls=true`)*, and exposes `query`/`mutate` with no schema restriction. A raw libpq connection ignores the allowlist entirely, and a ~~superuser~~ `BYPASSRLS` role ignores `force row level security`. The correct, narrower claim is: **`ops` is unreachable *through PostgREST* by construction.** Reaching it through the MCP function is prevented by [ADR 0011](0011-mcp-trust-boundary.md), not by this decision. Any isolation test for this ADR must exercise **both** channels; a PostgREST-only test proves nothing about the second.
- Every `ops` table ~~carries `tenant_id` and~~ uses `force row level security` (no table in the repo does today, so the owner role currently bypasses every policy). *(Corrected 2026-09-13: `ops.tenants` is the tenant row and `ops.worker_instances` is fleet infrastructure, so neither carries `tenant_id`; the other eight `ops` tables do. The parenthetical was true when written, but FORCE would not have changed it: the owner, `postgres`, carries `BYPASSRLS` and bypasses every policy with or without FORCE. See the 2026-09-13 addendum.)*
- ⚠️ **The RLS helper pattern this ADR originally pointed at cannot serve the engine.** `02_functions.sql:462-509`'s helpers all resolve through `auth.uid()`, which reads a Supabase JWT claim — and the always-on worker of [ADR 0001](0001-runtime-execution-substrate.md), the only process that touches `ops.*`, holds no end-user JWT. Copy the *shape* (one SECURITY DEFINER helper referenced by every policy), never the `auth.uid()` source. The mechanism is decided in [ADR 0012](0012-worker-tenant-context.md).

---

## Addendum 2026-09-11 — status of the isolation claim (Phase 0.5C)

This ADR's acceptance rests on a mechanism it does not itself specify. [ADR 0012](0012-worker-tenant-context.md) supplies it, and Phase 0.5C verified that mechanism in isolation (`supabase/tests/worker_tenant_context.sql`): a non-superuser, non-`BYPASSRLS` role scoped by a transaction-local GUC, where absent context yields zero rows and `force row level security` binds even the owning role.

What that does **not** discharge, for this ADR specifically:

- ~~**`ops` still does not exist.**~~ **Superseded 2026-09-12 (Phase 1A).** The schema exists (`20260912120000_ops_execution_core.sql`) with three tables, ~~all carrying `tenant_id`,~~ all `enable` **and** `force row level security`, all scoped by one helper *(corrected 2026-09-13: `ops.tenants` has no `tenant_id`; it is scoped by its own `id`)*. The decision in this ADR is now implemented for the engine's own tables. What it still does not cover: `public.*` remains tenant-one's CRM instance, scoped per *user* rather than per tenant, exactly as this ADR intends.
- **The two-channel test obligation stands.** The retraction above narrowed the claim to "`ops` is unreachable *through PostgREST* by construction". The second channel — a raw libpq connection, which ignores the allowlist — is constrained only by [ADR 0011](0011-mcp-trust-boundary.md). Phase 0.5C removed one capability reachable that way (`pg_net`, see ADR 0011's addendum), which narrows the blast radius without changing who can open the connection.
- **The engine's tenant boundary is now tested.** `supabase/tests/ops_execution_core.sql` proves cross-tenant denial in both directions, three fail-closed paths, and that context does not survive a COMMIT on a reused connection — mutation-verified 10/10. The mechanism is [ADR 0012](0012-worker-tenant-context.md)'s, revised: tenancy is bound to a live lease rather than to a GUC the caller writes.
- **The existing `public.*` boundary is now tested, and it is not a tenant boundary.** `supabase/tests/rls_tenant_isolation.sql` proves per-*user* (`sales_id`) isolation: cross-user reads, unqualified cross-user writes, and three fail-closed paths for missing context. ~~That is the only isolation this repository actually enforces today.~~ *(Struck 2026-09-13: true on 2026-09-11, false from Phase 1A (2026-09-12), when the `ops` tenant boundary was enforced and tested; see the bullet above and the 2026-09-13 addendum. `public.*` keeps per-user isolation only.)* When a real tenant boundary lands, those assertions must be re-pointed at it rather than left to pass against a boundary that no longer means what it meant.

---

## Addendum 2026-09-13 — reconciled with ADR 0012, ADR 0015 and the owner decisions (after Phase 1C)

This record was re-read against the repository after Phases 1A–1C, against [ADR 0012](0012-worker-tenant-context.md) as accepted, and against [ADR 0015](0015-company-os-domain-core.md) with its owner addendum. Claims that were false are corrected in place above; this addendum states what the tenancy model now is. **Status stays Proposed:** the MCP channel (§6) is still open. *(Later 2026-09-13: the MCP channel is closed; see the second 2026-09-13 addendum. The status still stays Proposed, for the reason given there.)* *(Final 2026-09-13: accepted; see the last addendum.)*

### 1. Tenant is the only isolation boundary

- `ops.tenants` is the security and isolation boundary. Nothing else is.
- `ops.companies` is an organisational entity inside a tenant. A tenant may hold several structurally, and that is never isolation between them.
- Businesses that need independent data isolation are separate tenants: the psychology clinic is one tenant, and FireForge 3D is another.
- Neither `ops.companies` nor `public.companies` (the CRM customer account) is a tenant.

### 2. Tenant context comes from a live lease

The mechanism this record rests on is ADR 0012 **as accepted**, not the transaction-local GUC the 2026-09-11 addendum describes; probe P5 showed that one forgeable.

- `ops.current_tenant_id()` resolves the tenant from `app.worker_id` and `app.job_id` naming a leased, unexpired `ops.jobs` row owned by that worker. `ops.lease_job` and `ops.resume_lease` are the only code that installs that context. The GUCs themselves stay writable by any role, so what binds the tenant is the helper re-reading the leased row on every call; against a hostile worker process, the bound is `ops_worker`'s grants (SI-14).
- A missing, unknown, expired or foreign lease yields no tenant. A malformed `app.job_id` alongside a set `app.worker_id` raises.
- For `ops_worker`, the tenant is never selected by a GUC it writes, by an argument or by a job payload: the helper re-reads it from the leased row. Some functions do take an explicit `p_tenant_id`: every Company OS service, and `ops.enqueue_job`. Only the owner can execute them, plus `service_role` for `enqueue_job` alone (migration `20260912200000`, end-state assertion 9).
- A future runtime caller reaches the Company OS only through ADR 0015 §4's wrapper, which takes its tenant from a lease or a membership, never from an argument.

### 3. The boundary as built

`ops` holds 10 tables and 1 view (`queue_metrics`, `security_invoker`). Every table has ENABLE and FORCE row level security, asserted by each of the three migrations that create them. Eight tables carry `tenant_id`. The nine policies all read `ops.current_tenant_id()`; `ops.worker_instances` has no policy and is reached only through SECURITY DEFINER functions.

RLS is one of three layers, not the whole boundary:

1. **Privileges.**
   - `anon` and `authenticated` hold no USAGE on `ops`.
   - No application role holds any privilege on a Company OS table or function (SI-21).
   - `ops_worker` holds no write verb on any `ops` table. It has SELECT on `tenants`, `jobs`, `job_events` and `queue_metrics`, and EXECUTE on exactly the eleven SECURITY DEFINER functions pinned by `company_domain_core.sql` A4: the lease-checking transitions (both `complete_job` forms, `fail_job`, `settle_job_failure`, `resume_lease`), the lease-bound capability `purge_inbound_email_ledger`, `lease_job` and the helper `current_tenant_id`. Three of them check no lease: `worker_heartbeat` and `worker_stopped` touch fleet rows with no tenant, and `reap_expired_leases` re-queues or fails any tenant's already-expired leases (SI-13).
   - `service_role` holds USAGE on `ops` and EXECUTE on `ops.enqueue_job(p_tenant_id, …)` only. That is the pinned Phase 1A exception: no production code calls it, and the Data API cannot reach it (SI-15).
2. **RLS** scopes `ops_worker`'s reads through the lease-bound helper (SI-14). The Company OS read policies exist with no grant behind them, so they are evidence of shape only.
3. **Structure.** Company OS rows reference each other through composite tenant and company keys and guard triggers (ADR 0015 §3, SI-22).

For the Company OS tables, the Decision's "`tenant_id` + RLS" therefore describes the shape. The live isolation is privileges, SECURITY INVOKER function scope and composite keys.

### 4. Identities outside the boundary

- The owner, `postgres`, runs migrations and the seed (locally, and on a hosted project provisioned by `scripts/supabase-remote-init.mjs`; see §5) and, in Phase 1C, the Company OS services. `service_role` holds the enqueue exception. Hosting-level read roles (`pg_read_all_data` members, `supabase_read_only_user`) hold SELECT on `ops`; every policy names only `ops_worker`, so such a role reads every tenant's rows only if it also carries `BYPASSRLS`, which the repository has not measured. *(Later 2026-09-13: remote initialisation no longer pushes the seed; SI-25.)*
- `postgres` and `service_role` carry `BYPASSRLS`, so neither RLS nor FORCE binds them. No isolation claim in this record covers them.
- Neither is ever an ordinary Company OS agent or worker identity (ADR 0015 owner decision 7). The worker refuses to boot as `postgres`, `supabase_admin`, `service_role`, a superuser or a `BYPASSRLS` role (SI-16).

### 5. `public.*` stays per-user

- `public.*` now has 14 tables and 44 policies, still with no tenant column. The rejection of a tenant column on `public.*` stands.
- "Tenant one" is data: at most one `ops.tenants` row may carry `owns_local_crm`, enforced by a unique partial index (Phase 1B). No migration, seed or provisioning script creates that row, and the seeded `dev` tenant leaves the flag false; only the driver-backed test fixture (`engine/worker/testSupport/dbFixture.ts`) marks its test tenant `dbtest-a`. On a migrated or seeded database, therefore, `ops.purge_inbound_email_ledger` refuses every tenant until an operator marks one.
- A capability reaching `public.*` takes its tenant from the lease and refuses a tenant without `owns_local_crm` (SI-18); today that is `ops.purge_inbound_email_ledger`. Company-scoped work must never reach `public.*` on `owns_local_crm` alone (ADR 0015 §2).
- `public.*` will not gain a tenant axis under this decision, so `rls_tenant_isolation.sql` stays pointed at `sales_id`. There is nothing to re-point.
- `scripts/supabase-remote-init.mjs` provisions one Atomic CRM project. It is not tenant provisioning, but it is not tenant-free either: it runs `supabase db push --include-roles --include-seed`, and because `config.toml` declares no `[db.seed]`, that pushes the default seed, `supabase/seed.sql` (inferred from the CLI's default seed path; not executed). The seed creates the `dev` development tenant with one company, three departments and two agents, contradicting its own comment that a hosted project never runs it. The script sets no `owns_local_crm` and creates no `ops_worker` login. Project per tenant remains an option for hard isolation. *(Later 2026-09-13: the seed flag is removed, so a hosted project no longer receives the development tenant; SI-25. The seed's reference data is an open decision.)* *(Final 2026-09-13: the reference-data decision is made. Global reference data ships in migration 20260913120000; loss reasons are tenant vocabulary and wait for an onboarding path; SI-25.)*

### 6. Channels

- **Data API.** REST and RPC resolve only in the exposed schemas (`config.toml:11`); GraphQL reflects the extra search path (`config.toml:13`); the authenticator's `pgrst.*` settings can override both. `ops` is on neither. `opsDataApiExposure.mjs` (SI-15) attacks both channels with five credentials: 340 requests, none reached `ops`, green in CI run 34770182266. `deploy.yml` pushes no API settings, so a hosted project must be checked in that project.
- **Direct connections.** The reach of `anon`, `authenticated`, `service_role` and `ops_worker` into `ops` is bounded by the privileges in §3, which migrations and suites assert. The identities in §4 are not bounded by them.
- **The MCP function: open.** [ADR 0011](0011-mcp-trust-boundary.md) item 4 required it to be removed, restricted to a role with no rights on `ops`, or kept out of production before `ops` existed. None of the three happened: *(Closed 2026-09-13 by removing the function; see the second 2026-09-13 addendum.)*
  - `supabase/functions/mcp/index.ts` still falls back to a `postgres` pool, and the repository neither sets nor checks the production `SUPABASE_DB_URL`;
  - `deploy.yml` deploys it with every other function;
  - its `query`, `mutate` and `complete_task` tools run SQL through one helper that downgrades to `authenticated` per transaction, and `authenticated` holds no USAGE on `ops`; `get_schema` reads only `public` metadata, without the downgrade;
  - **no test exercises `ops` through this channel**, including caller SQL that re-sets `role` on the `postgres` session.

  Until item 4 is discharged and the channel is tested, "prevented by ADR 0011" is an intention, not a property.

### 7. Identifiers

`ops.events.seq` is one identity across tenants and is internal only (ADR 0015 owner decision 5). The identifier rules are in [ADR 0003](0003-identifier-strategy.md)'s 2026-09-13 addendum.

### Acceptance criterion, restated

| Criterion | Evidence | State |
| --- | --- | --- |
| Worker reads isolated by a live lease | `ops_execution_core.sql` and `runOneJob.ts` (SI-14); `pooling.dbtest.ts` for context not surviving a pooled connection | met, CI run 34770182266 |
| Company OS privileges and structure | `company_domain_core.sql` (SI-21, SI-22) | met, same run |
| No Data API reach into `ops` | `opsDataApiExposure.mjs` (SI-15) | met, same run |
| No MCP reach into `ops` | ADR 0011 item 4 discharged, and a test through that channel | ~~**not met**~~ met 2026-09-13 by removal; SI-03's static guard replaces a runtime test through a channel that no longer exists (CI pending) |

---

## Addendum 2026-09-13 (later) — MCP channel closed; the status stays Proposed

**Owner decision:** the generic MCP SQL function is not a production Company OS channel. It was removed on 2026-09-13 ([ADR 0011](0011-mcp-trust-boundary.md) addendum), and `scripts/production-scope.mjs` keeps it out of the committed deploy paths (SI-03). The development seed no longer reaches a hosted project through a committed path (SI-25).

**Re-evaluated against the repository after the removal.** Every way code in this repository reaches the database:

| Channel | Reach into `ops` | Proven by |
| --- | --- | --- |
| Data API, REST and GraphQL | none: `ops` is off the exposed schemas and the search path, and `anon` and `authenticated` hold no USAGE on it | `opsDataApiExposure.mjs` (SI-15) |
| Edge functions over supabase-js (`users`, `update_password`, `delete_note_attachments`, `postmark`) | none: PostgREST, Auth and Storage only; the one RPC is `public.get_user_id_by_email` | SI-15, which attacks `service_role` too |
| `merge_contacts`, over the shared Postgres pool | none as written: the session logs in as `postgres`, runs `SET LOCAL ROLE authenticated`, then fixed Kysely queries on `public` tables, and `authenticated` holds no USAGE on `ops` | ~~**nothing tests it**~~ SI-27 since 2026-09-13; SI-03 only keeps other functions off the pool and refuses raw SQL other than literals, compiled queries ~~and the one reviewed interpolation~~ (none remains since 2026-09-13) |
| Worker | lease-bound, as `ops_worker` | SI-13, SI-14, SI-16 |
| Owner (`postgres`) | everything; never an ordinary agent or worker identity | ADR 0015 owner decision 7 |
| MCP function | removed | SI-03 (static) |

**Why it stays Proposed.** This record's two-channel test obligation (2026-09-11 addendum) requires an isolation test through the raw-connection channel as well as the Data API. After the removal, that channel is `merge_contacts`: deployed, invoked by signed-in users, and logged in as a `BYPASSRLS` role. It cannot reach `ops` today only because of what its own code does, and no test reproduces its connection shape. Two things would let this record be accepted: *(Final 2026-09-13: condition 1 is met by SI-27. The owner accepted the record on local evidence under the final pre-1D bar, and the CI run of condition 2 is still to be recorded; see the last addendum.)*
1. a database test that connects as `postgres`, runs `SET LOCAL ROLE authenticated`, asserts `permission denied for schema ops`, and asserts the role is restored after COMMIT on the reused connection — or moving `merge_contacts` off the owner-session pool;
2. a green CI run on the commits that removed the MCP function and added SI-03 and SI-25.

Recorded for that decision: `merge_contacts` builds `set_config('request.jwt.claim.sub', …)` by interpolating the authenticated user id into the SQL on that session. A parameterised call would remove the question. *(Final 2026-09-13: the id is now a bound parameter.)*

**Acceptance criterion, restated again.**

| Criterion | State |
| --- | --- |
| Worker reads isolated by a live lease | met, CI run 34770182266 |
| Company OS privileges and structure | met, same run |
| No Data API reach into `ops` | met, same run |
| No MCP reach into `ops` | met by removal and SI-03; CI pending |
| Owner-session pool (`merge_contacts`) tested against `ops` | ~~**not met**~~ met 2026-09-13, SI-27 (see the last addendum) |

---

## Addendum 2026-09-13 (final pre-1D closure) — owner-session pool measured; accepted

**Owner decision:** accept this record once measurement shows that the `merge_contacts` channel cannot reach `ops` and cannot carry state between requests, judged against the owner's acceptance bar below. This addendum records that measurement. The evidence is local: CI has not yet run on these commits.

**What changed in the channel, and what did not.** `merge_contacts` still pools one `postgres` session (`BYPASSRLS`) and assumes `authenticated` for each merge. Two things changed. First, `runAsUser` in `supabase/functions/_shared/db.ts` now sends `SET LOCAL ROLE authenticated`, then `SELECT set_config('request.jwt.claim.sub', $1, true)` with the caller's id as a bound parameter; the id used to be interpolated into the SQL text. Second, the merge's queries now run one after another, so a rollback cannot race a query queued behind a failed one. No query was added or widened.

**Measured 2026-09-13 on the local e2e stack.**

| Proof | How | Result |
| --- | --- | --- |
| A. Inside the transaction the session is `authenticated`, acting as the caller | both suites; a merge-shaped read of `contacts` runs under RLS | met |
| B. Reads, writes and function calls on `ops` from that transaction are refused | nine attempts (a select on two tables, an insert, an update, a delete, and calls to `current_tenant_id`, `lease_job`, `enqueue_job` and `create_company`), each refused with `42501 permission denied for schema ops` | met |
| C. COMMIT ends the role and the identity | afterwards the same session is `postgres`, role `none`, with no claim | met |
| D. ROLLBACK ends them | the same checks | met |
| E. The pooled backend is reused cleanly | one backend PID for every transaction. Between transactions there is no role, identity, tenant context (`app.worker_id`, `app.job_id`, `ops.current_tenant_id()`), or open transaction. Two callers, in turn and at once, each see only their own identity | met |
| F. Error paths return a clean session | a thrown error, a missing contact and a database error inside the transaction; in psql, both a COMMIT and a ROLLBACK of an aborted transaction | met |
| G. Success and failure paths are both tested | the committed path and every failure above, through `runAsUser`, the function `merge_contacts` calls | met |

`supabase/tests/owner_session_pool.sql` proves the database side on one psql session. `supabase/tests/ownerSessionPool.mjs` runs the repository's `db.ts` through the real deno-postgres driver and Kysely, as a main service inside the local edge runtime on a direct connection, with one appended line that hands the probe the module's private pool, and checks the same properties. `npm run test:db` runs both, locally and in CI. Together they are SI-27.

**What this is: containment by code, not by role.** Both suites also record that the owner session can `RESET ROLE` back to `postgres` inside the transaction. So the channel stays out of `ops` because of code and one privilege fact:

- The pool is private to `_shared/db.ts`, and `runAsUser` is its only use.
- `merge_contacts` sends only fixed statements through it.
- Both files are sealed by `supabase/tests/ownerSessionSeal.test.ts`. A static guard cannot read every spelling of a raw call, such as a computed member name or reflection, and an independent review on 2026-09-13 found changes to these files that the guard alone accepted.
- SI-03 refuses any other function that imports the pool or another function's files.
- `authenticated` holds no privilege in `ops`.

Changing either sealed file reopens this record's two-channel obligation. The seal fails until the change has been reviewed against SI-27, `npm run test:db` passes, and the new digest is recorded.

**Not measured.** A COMMIT that itself fails, a connection that breaks mid-transaction, and a hosted `SUPABASE_DB_URL` that names a pooler rather than a direct connection. The owner-session suites should run against that connection shape before a hosted deploy relies on this record.

**The acceptance bar, row by row.**

| Criterion | State |
| --- | --- |
| The MCP production channel remains absent | met: removed 2026-09-13 (SI-03) |
| The production guard prevents its reintroduction | met: SI-03's static guard over the canonical function tree and every committed deploy path |
| A remote preflight catches stale or unexpected functions | met. Before every deploy or push, `node scripts/production-scope.mjs --project-ref "$SUPABASE_PROJECT_ID"` in `deploy.yml`, and `--linked` in the makefile, list the functions the project serves. They fail on any function outside the allowlist, `mcp` included, and delete nothing. A guard rule refuses a deploy path that skips the check (SI-03) |
| `merge_contacts` cannot reach `ops` after the role downgrade | met: SI-27, proofs A and B, held in place by the seal and SI-03 |
| Role and request state clear after COMMIT | met: SI-27, proof C |
| Role and request state clear after ROLLBACK or an error | met: SI-27, proofs D and F |
| Pooled backend reuse is clean | met: SI-27, proof E |
| Ordinary Company OS execution uses neither `service_role` nor `postgres` | met. SI-16: the worker refuses a superuser or `BYPASSRLS` identity at boot, and both roles are `BYPASSRLS`. SI-21: no application role holds any privilege on Company OS data |
| Guards and tests are green | met locally; CI pending on these commits |

Condition 1 of the previous addendum, a database test through this connection shape on a reused connection, is met by SI-27. Condition 2, a green CI run on the removal commits, has not happened yet. The owner accepted the record on local evidence under the bar above; the CI run on these commits is still to be recorded, as it was for Phase 1C. The ADR 0012 obligation that context does not survive a COMMIT or a ROLLBACK on a reused connection is now measured for this channel as well as for the worker.

**Recorded, not changed.** These were found while tracing the channel. They lie outside this record's isolation claim and are left for their own decisions.

- The SQL function `public.merge_contacts(bigint, bigint)` is SECURITY INVOKER and executable by PUBLIC, `anon`, `authenticated` and `service_role` (grants measured). Its body never touches `lead_profiles` or attribution rows before it deletes the loser (read from its definition, not executed). The edge function's 2026-09-11 fix addressed that same cascade.
- In the edge function, read from source and not executed:
  - the deal re-point compares the decoded `contact_ids` elements with the request's JSON numbers using `!==`, which never matches if the driver returns `bigint` values as BigInt or as strings;
  - a self-merge is not refused, and would delete the contact;
  - the pool connects when the function starts;
  - `db.ts` falls back to a hard-coded local owner connection string when `SUPABASE_DB_URL` is absent.
