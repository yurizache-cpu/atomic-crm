# ADR 0006 — Declarative schema is the source of truth, and it must actually be wired

**Status:** Proposed · **Date:** 2026-09-10

## Context

`AGENTS.md:33,36` declares `supabase/schemas/` the source of truth, generated into migrations by `supabase db diff`. `.claude/skills/writing-migrations/SKILL.md` instead hand-authors SQL from the session's TypeScript diff. Neither is enforced, and **`supabase/config.toml` contains no `[db.migrations] schema_paths` key** (verified) — which is what registers those files with the CLI. The documented command would not read them.

The direct results, both live today: a ~1,000-line security rewrite that reaches no database, and a `seed.sql` that inserts into a table no migration creates, breaking `supabase db reset`.

## Decision

**Make the declarative workflow real.** Add `[db.migrations] schema_paths`; generate migrations only via `supabase db diff`; add a CI job asserting the diff produces empty output; gate `deploy.yml` on `check.yml`. Retire the hand-authoring skill, or scope it explicitly to repair work.

## Alternatives

- **Hand-written migrations only.** Simpler and honest, but discards a reviewable file-per-concern schema the team already maintains and that the docs already describe.
- **Leave both processes documented.** Rejected — this ambiguity is the direct cause of the current undeployable state.

## Consequences

- `supabase/schemas/02_functions.sql` must keep exact `pg_dump` formatting, or every future diff emits phantom changes. Regenerate with `npx supabase db dump --local --schema public`; never hand-format.
- The pending ~500-line clinical delta must be packaged as **one deliberately reviewed migration** (Phase 0.5), never as a side effect of unrelated work.
- CI gains a schema-parity gate — the check whose absence caused all of this.
