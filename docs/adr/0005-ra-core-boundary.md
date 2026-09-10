# ADR 0005 — react-admin does not cross the engine boundary

**Status:** Proposed · **Date:** 2026-09-10

## Context

Every domain type in `src/components/atomic-crm/types.ts` is `& Pick<RaRecord, "id">`. About 40 files call `ra-core` hooks directly against literal resource names. `providers/types.ts` is a one-line re-export of the Supabase implementation's own type. Both providers are reconnected to `CrmDataProvider` only by an unsafe cast (`dataProvider.ts:341`, `fakerest/dataProvider.ts:609`) — so **neither implementation is actually type-checked against the contract**, and the two are not behaviourally equivalent.

## Decision

**Keep `ra-core` for CRM screens. Forbid it in `packages/engine-core`, `packages/policy`, `packages/ports` and `services/worker`** — enforced by a lint rule or a test, not by convention.

## Alternatives

- **Reuse `ra-core` types for engine entities.** Tempting (free guessers, `CanAccess`, bulk actions) but unwinding `RaRecord` from agent / run / approval types later is a full rewrite.
- **Drop `ra-core` entirely now.** Rejected: it is precisely what makes the ugly Phase-1 screens cheap.

## Consequences

- Engine types are plain TypeScript with zod schemas. (Resolve the `zod` v4-app / v3-edge split before sharing schemas across the worker, the functions and the browser.)
- Phase-1 ops screens may still use `ra-core` in the *presentation* layer against the worker's API; the domain packages may not.
