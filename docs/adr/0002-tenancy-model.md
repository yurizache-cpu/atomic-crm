# ADR 0002 — Tenancy model

**Status:** Proposed · **Date:** 2026-09-10

## Context

No tenant discriminator exists: no `company_id` / `tenant_id` / `org_id` on any of the 13 tables. The only scoping axis is `sales_id` — a per-*user* column — baked into 43 RLS policies and 6 helper functions.

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
- ~~The engine is unreachable from any browser **by construction**, not by policy.~~ **Retracted 2026-09-11 — this was materially false and is the reason this ADR cannot be accepted as originally written.** The PostgREST allowlist governs exactly one channel. `supabase/functions/mcp/index.ts:22-25` opens a direct libpq `Pool` whose connection string defaults to the `postgres` **superuser**, and exposes `query`/`mutate` with no schema restriction. A raw libpq connection ignores the allowlist entirely, and a superuser ignores `force row level security`. The correct, narrower claim is: **`ops` is unreachable *through PostgREST* by construction.** Reaching it through the MCP function is prevented by [ADR 0011](0011-mcp-trust-boundary.md), not by this decision. Any isolation test for this ADR must exercise **both** channels; a PostgREST-only test proves nothing about the second.
- Every `ops` table carries `tenant_id` and uses `force row level security` (no table in the repo does today, so the owner role currently bypasses every policy).
- ⚠️ **The RLS helper pattern this ADR originally pointed at cannot serve the engine.** `02_functions.sql:462-509`'s helpers all resolve through `auth.uid()`, which reads a Supabase JWT claim — and the always-on worker of [ADR 0001](0001-runtime-execution-substrate.md), the only process that touches `ops.*`, holds no end-user JWT. Copy the *shape* (one SECURITY DEFINER helper referenced by every policy), never the `auth.uid()` source. The mechanism is decided in [ADR 0012](0012-worker-tenant-context.md).
