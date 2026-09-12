# ADR 0001 — Runtime execution substrate

**Status:** Proposed (pending owner approval) · **Date:** 2026-09-10

## Context

Nothing in this repository outlives an HTTP request. Supabase Edge Functions are per-request Deno isolates; `EdgeRuntime.waitUntil` appears nowhere (0 grep hits), there is no cron, no queue, no worker, and the only Dockerfile is `.devcontainer/Dockerfile`. Deployment is `gh-pages` + `supabase db push` + `supabase functions deploy`. An agent turn lasting minutes has literally nowhere to run.

## Decision

**Postgres as the durable substrate (queue, scheduler, outbox) plus one small always-on worker process that leases jobs.**

## Alternatives

- **Edge Functions only.** Rejected: wall-clock ceilings, no cron, no background tasks, no durable state. Cannot host an agent turn.
- **Hosted durable execution** (Temporal, Inngest, trigger.dev). Fastest to correctness, worst for data residency (LGPD) and lock-in. Reconsider only if worker ops become the bottleneck.

## Consequences

- One new ops surface — the first server process this project has ever had.
- ~~The repo already proves the DB → `pg_net` → function hop works (`02_functions.sql:34-45`)~~ **— superseded 2026-09-11, see the addendum.** The failure modes that hop demonstrated still stand as things to design against: fire-and-forget, no retry, no delivery reconciliation, and a silent no-op whenever there is no end-user `Authorization` header.
- Job leasing uses `FOR UPDATE SKIP LOCKED`. Provider API keys live only in the worker.
- **Reversing this rewrites every tool call**, which is why it is decision #1.

---

## Addendum 2026-09-11 — `pg_net` is gone; the worker must not depend on it (Phase 0.5C)

The Consequences section above cited the `DB -> pg_net -> edge function` hop as existing proof that the substrate works. **`pg_net` has since been removed from the database** ([ADR 0011](0011-mcp-trust-boundary.md) addendum, migration `20260911235500_drop_pg_net.sql`), because its functions are granted to `anon` and `authenticated` by `supabase_admin` and no privilege change this project can make revokes them. Verified before removal: `select net.http_get(...)` as `authenticated` queued a request. It was unused, so the capability was deleted rather than fenced.

Consequences for this ADR, which do not change the decision:

- **The decision stands and is, if anything, reinforced.** The worker leasing jobs from Postgres with `FOR UPDATE SKIP LOCKED` **pulls**; it never needed the database to push. The hop was cited as evidence, not as a dependency.
- **Database-initiated outbound calls are no longer available and must not be reintroduced casually.** Any future design that wants the database to call out — a webhook trigger, a notification, a Supabase Database Webhook — is reopening a channel that `anon` can also use. That is a decision with an ADR attached, not an implementation detail. It is guarded by an executable assertion: `supabase/tests/rls_tenant_isolation.sql` fails if `pg_net` or the `net` schema reappears.
- **The worker's identity is constrained by [ADR 0012](0012-worker-tenant-context.md), which is still Proposed.** Its mechanism is now verified in isolation, but the worker must not run as `service_role` (carries `BYPASSRLS`) and must not run as `postgres` (also carries `BYPASSRLS` on Supabase — measured). Both are outside RLS entirely, so either choice would make the tenant model decorative.

---

## Addendum 2026-09-12 — the database half of this decision now exists (Phase 1A)

"Postgres as the durable substrate (queue, scheduler, outbox)" is built and tested: `ops.jobs`, leasing with `FOR UPDATE SKIP LOCKED`, lease expiry and recovery, and a per-job audit trail — `20260912120000_ops_execution_core.sql`. Twelve concurrent workers leasing six jobs produced six distinct leases with no double-lease and no contention, against real simultaneous connections.

**The "always-on worker process" half is deliberately NOT built.** What exists instead is `engine/worker/runOneJob.ts`: one unit of work — lease, verify the context came from the lease, execute, settle — with the database client injected, so it commits the project to no driver while this ADR is still Proposed. There is no daemon, no scheduler, no supervisor, and no handler.

Nothing here changes the decision. Two things narrow it:

- **Job leasing needs no push.** The worker pulls, which is why removing `pg_net` (ADR 0011) cost this design nothing.
- **The worker's identity is settled by [ADR 0012](0012-worker-tenant-context.md), not by this ADR**: `ops_worker`, `NOLOGIN`, no `BYPASSRLS`, no write verb in `ops`, nothing in `public`. A worker running as `service_role` or `postgres` — both carry `BYPASSRLS` — would make the whole tenancy model decorative.
