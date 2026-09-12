import { defineConfig } from "vitest/config";

// The driver-backed worker suites: a REAL Postgres, the REAL `pg` pool, and the
// REAL constrained login role.
//
// Deliberately a SEPARATE config from `vitest.config.ts`. Everything in that
// file must run with no Docker; nothing here can run without it. Keeping them
// in one file meant `test:unit:app` — which passes no --project filter —
// dragged these suites into a CI job that has no database, and the failure read
// as a broken unit test rather than a missing dependency.
//
//   npm run test:db:engine
//
// Environment: SUPABASE_DB_PORT (54342 for the isolated e2e stack, 54322 for a
// lone CI stack) and SUPABASE_DB_CONTAINER when psql is not on PATH.
export default defineConfig({
  test: {
    name: "engine-db",
    environment: "node",
    include: ["engine/**/*.dbtest.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // Sequential and single-fork: several suites assert on the exact contents
    // of ops.jobs and public.inbound_emails, so two files racing over the same
    // two tenants would prove nothing about either.
    fileParallelism: false,
    pool: "forks",
    singleFork: true,
  },
});
