# ADR 0013 — Pipeline stages are tenant configuration, not schema semantics

**Status:** **Accepted** · **Date:** 2026-09-11
**Decided by:** owner, Phase 0.5 brief (Q4)

## Context

`CLAUDE.md` rule 2 names one specific mistake to not repeat: the nine-value CHECK constraint enumerating clinic pipeline stages on `public.deals`. The fork then added a **second** instance — a five-value CHECK on `lead_profiles.operational_status`.

The platform must run a psychology clinic today and, say, a 3D-printing business later. Stage names like *initial session scheduled* or *continuity converted* mean nothing to the second tenant, so encoding them in DDL means onboarding tenant two requires a schema migration. That is the definition of a domain-specific engine.

**The decisive fact, verified 2026-09-11:** `grep -rln "pipeline_stage" supabase/migrations/` and the same for `operational_status` both return **nothing**. Neither CHECK exists in any migration. They live only in the declarative `supabase/schemas/`, which — as the Phase-0 audit established — has never reached any database. There is therefore **no applied history to reverse.**

## Decision

**The database validates generic structural integrity. Business-stage semantics are data.**

1. **Both value-enumerating CHECKs are removed from `supabase/schemas/01_tables.sql`** — before the first migration is generated, so they never enter migration history at all.
2. **What the database keeps enforcing** is structural and domain-neutral: `pipeline_stage text not null default 'new_lead'`, the partial index on it, and `deals_lost_requires_reason` (if a deal is lost it must carry a reason). These constrain *shape*, not vocabulary.
3. **What stays legitimately enumerated in DDL:** `sales.role in ('owner','operator')` — that is *engine* vocabulary (platform authority levels), not tenant vocabulary, and it is the same set for every tenant. `configuration_singleton check (id = 1)` is structural. The test for whether a CHECK belongs is: *would tenant two need a different set?*
4. **`loss_reasons` is the pattern to follow** — the fork already built a reference table with `code`, `label`, `sort_order` and an `active` flag. Stage configuration follows that shape, not a CHECK.

### Forward migration strategy (the safest one available)

Because nothing was ever applied, the safe path is **not** a reversing migration:

- **Remove the constraints from the declarative schema now** (done), so the single Phase-0.5 migration generated from the pending delta simply never contains them. No `DROP CONSTRAINT` is needed, and no historical migration is rewritten — which also honours the rule against editing applied migrations.
- **If a database is ever found that already has these constraints** (e.g. one built by hand from `schemas/`), the forward fix is an additive migration doing `alter table public.deals drop constraint if exists deals_pipeline_stage_check;` — `if exists` so it is idempotent and safe on a database that never had it.

### Stage configuration model (designed, deliberately NOT built in Phase 0.5)

The owner's requirements — company-scoped, ordered, stable ids, editable labels, activation/deactivation — need a tenant discriminator to be *company*-scoped, and no tenant concept exists yet (see [ADR 0002](0002-tenancy-model.md); `public.companies` means *CRM customer account*, not tenant). Building tenant-scoped pipeline tables now would either hardcode single-tenancy or pre-empt Phase 2.

So the shape is recorded and deferred:

- `pipelines` — one per tenant per entity type; `id`, `tenant_id`, `entity` (`deal`…), `name`, `is_default`.
- `pipeline_stages` — `id` (stable, never reused), `pipeline_id`, `code` (stable machine identifier), `label` (freely editable), `sort_order`, `is_active`, optional `is_won` / `is_lost` semantics flags.
- `deals.pipeline_stage` continues to hold the **stable `code`**, not the label and not a numeric position. A code is already what the column stores today, so no data migration is implied and renaming a stage in the UI cannot orphan a row.
- Deactivating a stage hides it from pickers without rewriting historical rows — which is why `is_active` exists rather than deletion.

Until those tables exist, the tenant's stage list is the configuration row the app already reads (`defaultConfiguration.ts` → the `configuration` JSONB), which is configuration in the required sense: changing it needs no DDL.

## Alternatives

- **Keep the CHECK, add tenant two's values to it.** Rejected: every onboarding becomes a migration, and the constraint grows to the union of all tenants' vocabularies, validating nothing meaningful for any of them.
- **Foreign key from `deals.pipeline_stage` to a stage table, now.** The right end state, but it requires the tenant model. Doing it single-tenant now means redoing it in Phase 2.
- **Drop `pipeline_stage` and reuse upstream's `stage`.** Rejected — the fork's own funnel is the product direction; the duplication between the two columns is a separate defect (below), not an argument for reverting.

## Consequences

- An invalid stage string can now be written to `deals.pipeline_stage` without the database objecting. That is the intended trade: validation moves to the application/configuration layer, where it can differ per tenant. The importer already resolves an incoming cell against the configured stage list and falls back to the first configured stage, so the write path is guarded where it should be.
- The **`stage` vs `pipeline_stage` duplication remains** and is now the biggest inconsistency in this area: upstream's `stage` is still `not null`, and `synchronize_deal_pipeline` force-overwrites it from `pipeline_stage` on every write, so any non-Atomic writer that sets `stage` has its write silently discarded. Resolving that is its own change with a data migration, and is not attempted here.
- Phase 2 must create the pipeline tables with `tenant_id` from the first commit, not retrofit it.
