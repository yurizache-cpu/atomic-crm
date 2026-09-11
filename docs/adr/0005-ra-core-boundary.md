# ADR 0005 — react-admin does not cross the engine boundary

**Status:** Proposed · **Date:** 2026-09-10

## Context

Every *entity* type in `src/components/atomic-crm/types.ts` is `& Pick<RaRecord, "id">` (13 of 24 exports; the rest are DTO/helper shapes, and `Activity` is the full `RaRecord &`). **The fork widened this rather than containing it:** all three types `2b5f20bb` added for the clinical/commercial domain — `LeadProfile`, `AcquisitionAttribution`, `LossReason` — were themselves written `& Pick<RaRecord, "id">`, so the fork's own Phase-1 domain data is already react-admin-shaped.

**156 of the 254** tracked `.ts`/`.tsx` files under `src/components/atomic-crm/` import from `ra-core` (168 import statements), and 80 of them call a `ra-core` data or context hook directly against literal resource names. *(Corrected 2026-09-11: this originally read "about 40 files", understating it by 2–4× depending on how you count. The decision is unaffected — `ra-core` stays in the CRM screens and is forbidden in the engine — but the number matters for sizing any future extraction.)*

`providers/types.ts` is a one-line re-export of the Supabase implementation's own type, and `CrmDataProvider` is `ReturnType<typeof getDataProviderWithCustomMethods>` — a type derived *from* an implementation, which is the actual defect. *(Corrected 2026-09-11: an earlier version said both providers reach it "only by an unsafe cast" and that "neither implementation is actually type-checked against the contract". Both halves were wrong. `withLifecycleCallbacks` is typed `<T extends DataProvider>(dp: T, …) => T`, so the `as CrmDataProvider` at `dataProvider.ts:343` asserts a type the expression already has — a redundant no-op, not an unsafe cast. And FakeRest reaches it by plain **annotation** — `createDataProvider(...): CrmDataProvider` and `const dataProviderWithCustomMethod: CrmDataProvider = {…}` — which are real assignability checks. The correct criticism is narrower and still sufficient: the contract is derived from one implementation, so conformance to it proves nothing about replaceability.)*

## Decision

**Keep `ra-core` for CRM screens. Forbid it in `packages/engine-core`, `packages/policy`, `packages/ports` and `services/worker`** — enforced by a lint rule or a test, not by convention.

## Alternatives

- **Reuse `ra-core` types for engine entities.** Tempting (free guessers, `CanAccess`, bulk actions) but unwinding `RaRecord` from agent / run / approval types later is a full rewrite.
- **Drop `ra-core` entirely now.** Rejected: it is precisely what makes the ugly Phase-1 screens cheap.

## Consequences

- Engine types are plain TypeScript with zod schemas. (Resolve the `zod` v4-app / v3-edge split before sharing schemas across the worker, the functions and the browser.)
- Phase-1 ops screens may still use `ra-core` in the *presentation* layer against the worker's API; the domain packages may not.
