# ADR 0008 — Fork posture: hard-fork, stop publishing the registry

**Status:** Proposed · **Date:** 2026-09-10

## Context

41 modified files sit directly inside `src/components/atomic-crm`, contradicting the fork's own policy in `docs/product/07-upstream-strategy.md:27-31` (new code in separate modules).

`registry.json` contains one item with 223 files — **214 of them under `src/components/atomic-crm`** and **zero** from `src/components/admin` or `src/components/ui`. `.husky/pre-commit` regenerates it on every commit, and `deploy.yml:43,49` republishes it to gh-pages on every push to `main`. So every domain file added there becomes public distributed content. (It is already stale: `LeadCommercialPanel.tsx` is absent from it.)

`AGENTS.md:105-107,189` tells agents to modify `src/components/admin` and `src/components/ui` directly; `07-upstream-strategy.md:30` says avoid them precisely because the registry overwrites them. `CLAUDE.md` `@`-imports `AGENTS.md`, so agents follow the riskier rule.

The branch is 0 commits ahead of `origin/main`.

## Decision

1. **Hard-fork.** Stop tracking `upstream` for merges.
2. **Stop publishing the registry**, and remove `make registry-gen` from `.husky/pre-commit` — it already fails silently on machines without `make`.
3. **`src/components/admin` and `src/components/ui` are read-only inbound registry content.** `07-upstream-strategy.md` wins; the contradicting `AGENTS.md` guidance is **deleted**, not left to precedence.
4. **Engine code lives outside `src/components/`.**

## Alternatives

- **Keep merging upstream.** Rejected: chasing marmelab while inverting the architecture taxes every merge and buys nothing.
- **Vendor Atomic CRM as a dependency behind the adapter.** Attractive long-term and fully compatible with this decision; not worth the packaging work during Phase 0.5.

## Consequences

- Upstream security fixes must be cherry-picked deliberately, and someone must own watching for them.
- The MIT attribution to Francois Zaninotto / Marmelab remains binding. `package.json` currently declares **no `license` field and no `"private": true`** — fix both.
- Note one inherited coupling that a hard-fork does not remove: `src/components/admin/login-page.tsx:8` and `src/components/supabase/layout.tsx:3` import `useConfigurationContext` from `atomic-crm`, so the "generic" vendored layer already depends on domain code.
