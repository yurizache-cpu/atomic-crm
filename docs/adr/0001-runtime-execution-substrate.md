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
- The repo already proves the DB → `pg_net` → function hop works (`02_functions.sql:34-45`) and already demonstrates its failure modes: fire-and-forget, no retry, no delivery reconciliation, and a silent no-op whenever there is no end-user `Authorization` header. Design against those.
- Job leasing uses `FOR UPDATE SKIP LOCKED`. Provider API keys live only in the worker.
- **Reversing this rewrites every tool call**, which is why it is decision #1.
