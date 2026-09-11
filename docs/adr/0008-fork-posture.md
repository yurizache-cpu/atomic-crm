# ADR 0008 — Fork posture: hard-fork, stop publishing the registry

**Status:** Proposed · **Date:** 2026-09-10

## Context

**33 files** (32 modified + 1 added) sit directly inside `src/components/atomic-crm`, contradicting the fork's own policy in `docs/product/07-upstream-strategy.md:27-31` (new code in separate modules). *(Corrected 2026-09-11: this originally read "41 modified files", which was the whole-tree count misattributed to one directory. The substantive point stands — `07-upstream-strategy.md:27` prescribes new modules under `src/components/clinical-growth/`, and the one genuinely new file, `LeadCommercialPanel.tsx`, went to `src/components/atomic-crm/contacts/` instead.)*

`registry.json` contains one item with 223 files — **214 of them under `src/components/atomic-crm`** and **zero** from `src/components/admin` or `src/components/ui`. `.husky/pre-commit` regenerates it on every commit, and `deploy.yml:44,50` republishes it to gh-pages on every push to `main`.

*Refined 2026-09-11, in both directions.* Publication reads the **committed** `registry.json` — `npx shadcn build` compiles the listed paths and never rescans the tree — so a **new** file becomes public only after `registry:gen` runs and the regenerated JSON is committed (and `registry:gen` runs only from the husky hook, which is currently dead for want of `make`). That makes the "every file added becomes public" framing too strong. But the 32 **modified** `atomic-crm` files are already listed, so their new content — pt-BR clinic vocabulary, pipeline stages, `authProvider` changes — **republishes verbatim on the next push to `main` with no regeneration needed**. And it has never fired: `git ls-remote --heads origin` returns only `main`, and the fork has no `gh-pages` branch. This is a **latent trigger**, which makes decision 2 a cheap pre-emptive fix rather than a retraction of already-public code.

`AGENTS.md:105-107,189` tells agents to modify `src/components/admin` and `src/components/ui` directly; `07-upstream-strategy.md:30` says avoid them precisely because the registry overwrites them. `CLAUDE.md` `@`-imports `AGENTS.md`, so agents follow the riskier rule.

*(Updated 2026-09-11.)* The branch is **4 commits ahead** of `origin/main` and 0 behind, and has never been pushed — `origin` still holds only `main` at the pre-fork `a863e2a0`. The `upstream` remote **is** configured and fetchable, so decision 1 below is not yet mechanically implemented; the ADR is still `Proposed`, so that is a pending action rather than a broken one.

## Decision

1. **Hard-fork.** Stop tracking `upstream` for merges.
2. **Stop publishing the registry**, and remove `make registry-gen` from `.husky/pre-commit`. *(Corrected 2026-09-11: it does not "fail silently" on machines without `make` — husky runs the hook under `sh -e`, so it exits 127 and **blocks every commit**. That strengthens this decision: removing the line also unblocks committing on any machine without `make`.)*
5. **Delete or rewrite `doc/src/content/docs/developers/getting-updates.mdx`.** *(Added 2026-09-11.)* It instructs the reader to run `npx shadcn add https://marmelab.com/atomic-crm/r/atomic-crm.json -o -y` and explains that `-o` "replaces local files with the upstream version" — which would overwrite all 214 registered `src/components/atomic-crm/**` files, including every clinical change. It is the only prose in the repo describing how to get upstream updates, it is published from the fork's own site, and a hard-fork decision that leaves it in place is a decision in name only.
3. **`src/components/admin` and `src/components/ui` are read-only inbound registry content.** `07-upstream-strategy.md` wins; the contradicting `AGENTS.md` guidance is **deleted**, not left to precedence.
4. **Engine code lives outside `src/components/`.**

## Alternatives

- **Keep merging upstream.** Rejected: chasing marmelab while inverting the architecture taxes every merge and buys nothing.
- **Vendor Atomic CRM as a dependency behind the adapter.** Attractive long-term and fully compatible with this decision; not worth the packaging work during Phase 0.5.

## Consequences

- Upstream security fixes must be cherry-picked deliberately, and someone must own watching for them.
- The MIT attribution to Francois Zaninotto / Marmelab remains binding. `package.json` currently declares **no `license` field and no `"private": true`** — fix both.
- Note one inherited coupling that a hard-fork does not remove: `src/components/admin/login-page.tsx:8` and `src/components/supabase/layout.tsx:3` import `useConfigurationContext` from `atomic-crm`, so the "generic" vendored layer already depends on domain code.
