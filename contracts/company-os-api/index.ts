// The Company OS operator API contracts (docs/PHASE_2C_BRIEF.md §6.2, §8, §9).
//
// One zod `.strict()` schema per company_os_api response, mirrored by the
// jsonb the L2 projections build in
// supabase/migrations/20260922120000_company_os_read_surface.sql, shared by the
// browser module and the driver-backed tests. Two lint rules hold here, both
// pinned by engine/domain/companyOsContracts.test.ts (eslint.config.js): a
// file may import only zod and its sibling contract files, statically or at
// run time, so it cannot reach the CRM, the engine or a database driver; and
// it may name no browser, storage, network or environment global
// (localStorage, sessionStorage, indexedDB, caches, cookieStore, document,
// window, globalThis, self, fetch, XMLHttpRequest, navigator, WebSocket,
// EventSource, importScripts, process), bare or as a member, nor eval,
// Function or import.meta. What the lint cannot see (a value that reaches such
// an object through a parameter) stays a review rule.

export * from "./agents.ts";
export * from "./context.ts";
export * from "./decisions.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./governance.ts";
export * from "./health.ts";
export * from "./operations.ts";
export * from "./primitives.ts";
export * from "./reviews.ts";
export * from "./runs.ts";
export * from "./stops.ts";
export * from "./tasks.ts";
export * from "./vocabulary.ts";
