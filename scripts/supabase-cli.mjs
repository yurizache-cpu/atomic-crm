// The one Supabase CLI that every database-gate and deploy path runs.
//
// The Phase 2C ownership mechanics were measured on exactly this CLI version
// (spike S0.4, docs/PHASE_2C_REPORT.md §3.2): a temporary role membership, a
// temporary CREATE and a catalogue-bound ownership transfer inside one
// allowlisted migration. The CLI decides how a migration is applied: as whom,
// and one transaction per file.
//
// An unpinned `npx supabase` runs whatever release is latest. On 2026-09-25,
// CI (Check #72) picked up 2.118.0 minutes after its release, and
// scripts/run-db-tests.mjs stopped it. Since then nothing on those paths runs
// an unpinned CLI:
//   - the scripts run `npx --yes supabase@<version>` through these helpers;
//   - .github/workflows/database.yml spells the same package, and
//     scripts/production-scope-database-gate.mjs refuses any other;
//   - .github/workflows/deploy.yml pins supabase/setup-cli to the same version
//     and runs that binary (scripts/test/supabase-cli.test.mjs).
// Re-measure S0.4 before changing the version: a newer CLI is not adopted by
// editing this line alone.

export const MEASURED_SUPABASE_CLI = "2.117.0";

/** The measured CLI as an exact npm package spec. */
export const SUPABASE_CLI_PACKAGE = `supabase@${MEASURED_SUPABASE_CLI}`;

/** npx arguments that run exactly the measured CLI, never the latest release. */
export const pinnedSupabaseArgs = (args) => [
  "--yes",
  SUPABASE_CLI_PACKAGE,
  ...args,
];

/** The same invocation as one command line, for callers that use a shell. */
export const pinnedSupabaseCommand = (args) =>
  ["npx", ...pinnedSupabaseArgs(args)].join(" ");
