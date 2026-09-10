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
- The engine is unreachable from any browser **by construction**, not by policy.
- Every `ops` table carries `tenant_id`, uses `force row level security` (no table in the repo does today, so the owner role currently bypasses every policy), and routes policy through a helper following `02_functions.sql:462-511`.
