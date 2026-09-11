# Proposal 0001 — Repository structure (open question Q13)

**Status: PROPOSAL. No decision, no migration.** The owner deferred Q13 in the Phase 0.5 brief: *"Do not perform a monorepo migration in Phase 0.5."* This document exists so the decision can be made on evidence later.

## What exists today, measured

| | |
| --- | --- |
| Shape | **Single package.** `package.json` has no `workspaces` key, no `private: true`, no `license`. |
| Directories | No `apps/`, no `packages/`, no `services/`. |
| Tracked files | `src` 405 · `.claude` 146 · `doc` 93 · `supabase` 63 · `public` 41 · `docs` 21 · `.devcontainer` 13 · `.github` 7 · `e2e` 5 · `scripts` 3 |
| TS config | Solution-style root (`files: []` + two references), which nothing ever builds — `npm run typecheck` targets `tsconfig.app.json` directly. |
| Second npm project | `doc/` has its own lockfile and is built and published by `deploy.yml`. |

So the repository is *already* two npm projects with one of them undeclared — the question is not "should we adopt structure" but "how much".

**The load-bearing constraint:** `ARCHITECTURE.md` and several ADRs describe `apps/crm-web`, `apps/ops-web`, `packages/engine-core`, `packages/policy`, `packages/ports`, `packages/adapters/crm-atomic` and `services/worker` as though they existed. None does. Until something does, every boundary in the architecture — most importantly [ADR 0005](../adr/0005-ra-core-boundary.md)'s "`ra-core` never crosses into the engine" — is a **convention**, and conventions do not survive a deadline. ADR 0005 itself says the rule must be "enforced by a lint rule or a test, not by convention".

A second constraint that is easy to miss: **every file added under `src/components/atomic-crm/` is registry-publishable content** (`registry.json` lists 214 such files). Engine code must live outside `src/components/` for that reason alone, independent of any monorepo decision.

## Option A — Stay single-package, put engine code in a top-level directory

Engine code goes in e.g. `src/engine/` or a top-level `engine/`, enforced by an ESLint `no-restricted-imports` boundary rule rather than by package resolution.

- **Benefits.** Zero migration. No tooling change, no CI change, no lockfile churn. The boundary still becomes *mechanical* (a lint rule that fails the build), which is 80% of what ADR 0005 actually asks for.
- **Drawbacks.** Nothing physically prevents an import — only the rule does, and a rule can be disabled inline. No independent versioning or independent build. The worker and the SPA share one `package.json`, so a Node-only dependency ships in the browser dependency tree unless carefully managed.
- **Migration cost.** ~0. One lint rule plus a directory.
- **Token/dev cost.** Very low.
- **Reversal cost.** Very low — moving directories later is mechanical.

## Option B — Incremental modularisation (npm workspaces, packages added only when needed)

Declare `workspaces` in the root `package.json`, add `private: true`, and create packages **one at a time as a phase needs them** (`packages/ports` first, then `packages/policy`, then `services/worker`). `src/` stays exactly where it is and becomes a workspace only if and when that is convenient.

- **Benefits.** The boundary becomes real: `packages/engine-core` simply cannot `import "ra-core"` if it is not a dependency there — enforced by resolution, not by lint. Per-package dependencies keep Node-only code out of the browser bundle. Adopted gradually, so no big-bang. tsconfig project references start to earn their keep.
- **Drawbacks.** Some tooling friction: Vite aliases, the vitest projects, and `registry.json` path assumptions all need checking. Two weeks of small papercuts spread over several phases.
- **Migration cost.** Low to moderate, and — critically — **paid incrementally**, at the phase that benefits.
- **Token/dev cost.** Moderate, spread out.
- **Reversal cost.** Low. Removing the `workspaces` key and hoisting a package back is a contained change.

## Option C — Full monorepo migration now (`apps/` + `packages/` + `services/`)

Move `src/` to `apps/crm-web/`, create every package the architecture names, adopt a task runner (Turborepo/Nx) if justified.

- **Benefits.** The repository matches the documentation exactly. Clean per-app builds and caching.
- **Drawbacks.** A very large, very wide diff over a codebase that has **never been pushed and has never run in CI**. It would touch `registry.json`'s 214 paths, `deploy.yml`, `vitest.config.ts`, the e2e setup, and the `.claude/` harness's path assumptions — the last of which just produced a class of Windows defects that took a full workstream to clear. It buys structure for components that do not exist yet, which is the definition of speculative.
- **Migration cost.** High.
- **Token/dev cost.** High, concentrated in one change.
- **Reversal cost.** **High** — the worst property on this list, for a decision with no forcing function.

## Recommendation

**Option B, started at Phase 2 — not now.**

Reasoning, in order of weight:

1. **Nothing currently forces the decision.** No engine code exists. Deciding now spends the option early and buys nothing this phase.
2. **Phase 2 is the forcing function.** It is the first phase that creates `packages/engine-core`, and it is where ADR 0005's boundary must become mechanical. Adopting workspaces *as part of* that work is the cheapest possible moment.
3. **Option C's reversal cost is the disqualifier.** The same argument the roadmap already applies to tenancy applies here: when ordering two changes, do the reversible one first. Option B is Option C's first step anyway, so choosing B forecloses nothing.
4. **Option A is not sufficient alone**, but its lint-rule component should be adopted regardless of B or C — it is the cheapest enforcement available and it works today.

**Do not adopt any option in Phase 0.5.** The concrete next step is: when Phase 2 begins, add `workspaces` + `private: true` and create `packages/ports` as its first package, with the ESLint boundary rule landing in the same change.
