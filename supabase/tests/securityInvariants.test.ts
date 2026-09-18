// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// THE SECURITY BASELINE, IN EXECUTABLE FORM.
//
// This file is the canonical list of security invariants for the repository.
// `docs/SECURITY_INVARIANTS.md` is a human-readable index OF this list, and the
// last test here fails if the two drift — so the document cannot quietly become
// aspirational the way `07_storage.sql` and `06_grants.sql` did, where a rule
// was declared in the repository and present in no database.
//
// WHAT THIS FILE DOES AND DOES NOT DO
// It does not re-prove the invariants. Each is proven by the guard named in its
// `enforcedBy` list — an assertion inside a migration, a live-database suite, or
// a unit test. What this file proves is that **every invariant still has a live
// enforcement point**: the file exists and still contains the assertion. Delete
// a guard, gut a migration's `raise exception` block, or rename a check, and the
// invariant it was protecting goes red BY NAME.
//
// That is the gap this closes. The guards were scattered across SQL migrations,
// two database suites, three vitest projects and an edge function; nothing tied
// them to the properties they exist to protect, so removing one was invisible.
//
// Adding an invariant: add it here, add the row to the markdown, point it at a
// guard that actually runs. An invariant with no enforcement point is prose, and
// the shape of this file is meant to make that obvious rather than comfortable.

const ROOT = process.cwd();
const DOC_PATH = join(ROOT, "docs", "SECURITY_INVARIANTS.md");

/** How an invariant is actually proven, not merely asserted. */
type ProvenBy =
  | "live database" // supabase/tests/*.sql via `npm run test:db`
  | "migration assertion" // a `raise exception` block that runs on every apply
  | "unit test" // vitest, runs in CI with no Docker
  | "static guard"; // vitest, scans committed SQL / config text

interface Invariant {
  id: string;
  statement: string;
  provenBy: ProvenBy[];
  /** Each entry must exist AND still contain its marker. */
  enforcedBy: Array<{ file: string; marker: RegExp }>;
  /** Recorded so a reader knows what is NOT covered. */
  caveat?: string;
}

const INVARIANTS: Invariant[] = [
  {
    id: "SI-01",
    statement:
      "Every view an application role can read applies the caller's RLS (security_invoker = on).",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/tests/rls_tenant_isolation.sql",
        marker: /bypass RLS yet are readable by an application role/,
      },
      {
        file: "supabase/migrations/20260911235000_close_anon_grants_and_view_invoker.sql",
        marker:
          /alter view public\.contacts_summary set \(security_invoker = on\)/,
      },
    ],
    caveat:
      "`supabase db diff` never emits view reloptions, so a generated migration silently strips this. That is how an unauthenticated read of every contact shipped.",
  },
  {
    id: "SI-02",
    statement:
      "pg_net is absent. Its functions are granted to anon by supabase_admin and cannot be revoked by this project, so its presence alone is the failure.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/tests/rls_tenant_isolation.sql",
        marker: /pg_net is installed\./,
      },
      {
        file: "supabase/migrations/20260911235500_drop_pg_net.sql",
        marker: /schema "net" survived dropping pg_net/,
      },
    ],
    caveat:
      "Reinstalling it re-opens outbound HTTP for anon AND authenticated, permanently. See ADR 0011.",
  },
  {
    id: "SI-03",
    statement:
      "Arbitrary SQL is not a capability any deployed edge function offers: the generic MCP SQL function is removed; edge functions are a reviewed allowlist in one canonical tree at canonical configuration paths, loading only reviewed modules; no function names a known MCP server or SQL parser or imports another function's files, and a raw SQL call the parser can name receives only a literal, values travelling as bound parameters; and only deploy.yml and the makefile deploy functions, by name, after a blocking repository scope check and a blocking check that the target project serves no function outside the allowlist.",
    provenBy: ["static guard", "unit test"],
    enforcedBy: [
      {
        file: "docs/adr/0011-mcp-trust-boundary.md",
        marker: /No AI agent receives arbitrary SQL execution/i,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-not-allowlisted"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"functions-tree-outside-canonical"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-config-not-allowlisted"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-config-path-not-canonical"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-import-map-unreadable"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-dependency-unreviewed"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-imports-outside-functions"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-dynamic-import"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"generic-sql-endpoint"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"raw-sql-non-literal"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"postgres-pool-consumer"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /by absolute path/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"functions-deploy-all"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"functions-deploy-unlisted"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"functions-deploy-unresolvable"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"functions-deploy-outside-pipeline"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"supabase-workdir-remote"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"deploy-before-scope-check"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"deploy-before-remote-scope-check"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"workflow-env-mutation"/,
      },
      {
        file: "scripts/production-scope-remote.mjs",
        marker: /export function checkRemoteFunctions/,
      },
      {
        file: "scripts/production-scope-remote.mjs",
        marker: /This check deletes nothing/,
      },
      {
        file: "scripts/source-facts.mjs",
        marker: /export function moduleLoads/,
      },
      {
        file: "scripts/source-facts.mjs",
        marker: /export function methodCalls/,
      },
      {
        file: "scripts/source-facts.mjs",
        marker: /export function literalVectors/,
      },
      {
        file: "scripts/test/production-scope-functions.test.mjs",
        marker:
          /refuses the function directory coming back with its MCP server/,
      },
      {
        file: "scripts/test/production-scope-functions.test.mjs",
        marker: /reads every way a module is loaded/,
      },
      {
        file: "scripts/test/production-scope-functions.test.mjs",
        marker:
          /refuses caller input handed to a raw SQL call under any alias, wrapper or literal member name/,
      },
      {
        file: "scripts/test/production-scope-functions.test.mjs",
        marker: /refuses any interpolated template/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker: /refuses a scope check that cannot stop the deploy/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker:
          /refuses a deploy or push no blocking hosted check precedes under the same condition/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker: /reads a step condition only as one plain line/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker:
          /refuses a deploy aimed at a project other than the one the hosted check asked about/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"deploy-target-mismatch"/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker:
          /refuses deploying functions from anywhere but deploy\.yml and the makefile/,
      },
      {
        file: "scripts/test/production-scope-remote.test.mjs",
        marker:
          /fails a project still serving the removed MCP function, or any other/,
      },
      {
        file: "scripts/test/production-scope-remote.test.mjs",
        marker: /fails closed whenever it cannot get a readable answer/,
      },
      {
        file: ".github/workflows/deploy.yml",
        marker: /^\s*run: node scripts\/production-scope\.mjs\s*$/m,
      },
      {
        file: ".github/workflows/deploy.yml",
        marker:
          /^\s*run: node scripts\/production-scope\.mjs --project-ref "\$SUPABASE_PROJECT_ID"\s*$/m,
      },
      {
        file: "makefile",
        marker: /^\tnode scripts\/production-scope\.mjs\s*$/m,
      },
      {
        file: "makefile",
        marker: /^\tnode scripts\/production-scope\.mjs --linked\s*$/m,
      },
    ],
    caveat:
      "Static: the repository check reads committed files other than prose, its own modules and tests, and reviewed fixtures, and covers edge functions and their deploy paths. Out of reach: a person running the CLI by hand; a command or module name assembled where no literal shows it; a raw method reached through a computed member name or reflection, which is why SI-27 seals the owner-session files; SQL reaching the database through a method other than the raw ones it names, or caller-chosen identifiers handed to a query builder; code outside supabase/functions, such as an engine module or a database function executing dynamic SQL. The hosted check sees what the named project serves when a deploy runs, not a function deployed after it or to a project no deploy names, and it deletes nothing. PRODUCTION_FUNCTIONS and REVIEWED_FUNCTION_DEPENDENCIES are the review points, and a function that executes caller-supplied SQL must not pass review (ADR 0011 item 3).",
  },
  {
    id: "SI-04",
    statement:
      "Permission checks deny by default: an unknown resource is refused, never allowed.",
    provenBy: ["unit test"],
    enforcedBy: [
      {
        file: "src/components/atomic-crm/providers/commons/canAccess.ts",
        marker: /NON_ADMIN_RESOURCES/,
      },
      {
        file: "src/components/atomic-crm/providers/commons/canAccess.test.ts",
        marker: /describe\(/,
      },
    ],
  },
  {
    id: "SI-05",
    statement:
      "Missing tenant context reads zero rows, never all rows — for an absent JWT, an unknown user, a disabled user, and an unset worker GUC.",
    provenBy: ["live database"],
    enforcedBy: [
      {
        file: "supabase/tests/rls_tenant_isolation.sql",
        marker: /missing context must fail closed/,
      },
      {
        file: "supabase/tests/worker_tenant_context.sql",
        marker: /missing context must fail closed, not open/,
      },
    ],
  },
  {
    id: "SI-06",
    statement:
      "service_role is a full RLS bypass and must not be the ordinary worker identity. The same applies to postgres, which also carries BYPASSRLS on Supabase.",
    provenBy: ["live database"],
    enforcedBy: [
      {
        file: "supabase/tests/rls_tenant_isolation.sql",
        marker: /never be, a tenant-isolation mechanism/,
      },
      {
        file: "supabase/tests/worker_tenant_context.sql",
        marker: /the worker role has BYPASSRLS/,
      },
    ],
    caveat:
      "ACCEPTED RISK today: the edge functions DO run as service_role, except merge_contacts, whose pool logs in as postgres and assumes authenticated per transaction (SI-27, 2026-09-13). Both suites assert the bypass explicitly so a green RLS run cannot be mistaken for worker isolation. Closing it is ADR 0012's integration work.",
  },
  // SI-07 (retired 2026-09-13): "The SQL read path is read-only in the database
  // itself, not only in the parser." Its only subject was the MCP function's
  // query tool, removed with the function; SI-03 now holds the stronger
  // property that no such path exists. The id is not reused.
  {
    id: "SI-08",
    statement: "The attachments storage bucket is private.",
    provenBy: ["migration assertion"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260911120000_close_attachments_bucket.sql",
        marker: /raise exception/,
      },
      {
        file: "supabase/schemaReproducibility.test.ts",
        marker: /close_attachments_bucket/,
      },
    ],
  },
  {
    id: "SI-09",
    statement:
      "Merging contacts is conservative about consent: if either side opted out, the merged contact is opted out. Never winner-wins.",
    provenBy: ["unit test"],
    enforcedBy: [
      {
        file: "supabase/functions/merge_contacts/mergeLeadProfile.ts",
        marker: /do_not_contact/,
      },
      {
        file: "supabase/functions/merge_contacts/mergeLeadProfile.test.ts",
        marker: /describe\(/,
      },
    ],
  },
  {
    id: "SI-10",
    statement:
      "Inbound email ingestion is idempotent and fails closed: no unconditional 200, a durable record for every failure, and a synthetic key never reaches the ingest path.",
    provenBy: ["unit test", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/functions/postmark/ingestionOutcome.ts",
        marker: /isUsableIdempotencyKey/,
      },
      {
        file: "supabase/functions/postmark/ingestionOutcome.test.ts",
        marker: /a synthetic key must never reach the work/,
      },
      {
        file: "supabase/migrations/20260912090000_inbound_email_ledger.sql",
        marker: /raise exception/,
      },
    ],
  },
  {
    id: "SI-11",
    statement:
      "anon holds no privilege on any table or view in public, and authenticated holds no TRUNCATE, TRIGGER or REFERENCES anywhere.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/tests/rls_tenant_isolation.sql",
        marker: /anon holds privileges in schema public/,
      },
      {
        file: "supabase/migrations/20260911235000_close_anon_grants_and_view_invoker.sql",
        marker: /anon still holds privileges in schema public/,
      },
    ],
    caveat:
      "RLS does not gate TRUNCATE: a TRUNCATE grant empties an RLS-protected table outright. Measured.",
  },
  {
    id: "SI-12",
    statement:
      "The declarative schema is not an automatically trusted migration. Generated output must be reviewed, and a generated migration that regresses security is rejected.",
    provenBy: ["static guard"],
    enforcedBy: [
      {
        file: "docs/SECURITY_INVARIANTS.md",
        marker: /DECLARATIVE SCHEMA != automatically trusted migration output/,
      },
      {
        // Until 2026-09-11 this invariant's ONLY enforcement point was the
        // marker above — a sentence in a markdown file. It now has a guard that
        // replays every migration in order and rejects a diff that regresses
        // SI-01, SI-02 or SI-11. Listing it here is what makes DELETING that
        // guard fail by name, which is the whole purpose of this file.
        file: "supabase/tests/migrationInvariants.test.ts",
        marker: /a security-regressing migration is REJECTED/,
      },
      {
        file: "supabase/invariants/declaration.json",
        marker: /"pg_net"/,
      },
    ],
    caveat:
      "`supabase db diff` currently emits `create extension pg_net` and recreates three views without security_invoker. Applying it unreviewed regresses SI-01 and SI-02. The guard rejects that output statically, with no Docker; it does not and cannot prove a running database is correct — that is `rls_tenant_isolation.sql`'s job.",
  },
  // ── Phase 1A: the tenant-safe execution substrate ────────────────────────
  {
    id: "SI-13",
    statement:
      "The engine worker holds no write verb anywhere in ops and no BYPASSRLS. Every job state transition goes through a SECURITY DEFINER function that verifies the lease first.",
    provenBy: ["live database", "migration assertion", "static guard"],
    enforcedBy: [
      {
        file: "supabase/tests/ops_execution_core.sql",
        marker: /the worker must hold no write verb in ops/,
      },
      {
        file: "supabase/migrations/20260912120000_ops_execution_core.sql",
        marker: /ops_worker holds write privileges in ops/,
      },
      {
        // The static guard scrutinises ops_worker rather than exempting it, so
        // a migration granting it a write verb is rejected before it applies.
        file: "supabase/invariants/parse.mjs",
        marker: /OPS_WORKER_PRIVILEGES/,
      },
    ],
    caveat:
      "A worker that could write ops.jobs directly could extend its own lease or settle another tenant's job.",
  },
  {
    id: "SI-14",
    statement:
      "Tenant context is derived from a live lease, never asserted by the worker, and dies with the transaction that holds it.",
    provenBy: ["live database"],
    enforcedBy: [
      {
        file: "supabase/tests/ops_execution_core.sql",
        marker: /a lease held by another worker resolved to a tenant/,
      },
      {
        file: "supabase/tests/ops_execution_core.sql",
        marker: /tenant context survived a COMMIT on the same connection/,
      },
      {
        file: "supabase/migrations/20260912120000_ops_execution_core.sql",
        marker: /Resolves the tenant from the live lease/,
      },
      {
        // Moved from runOneJob.ts with the shared attempt helpers (Phase 1D.1).
        file: "engine/worker/attempt.ts",
        marker: /tenant context mismatch/,
      },
      {
        // The SQL suites prove this with psql. That says nothing about the
        // application driver, which keeps sockets in a pool and hands the same
        // backend to unrelated transactions.
        file: "engine/worker/pooling.dbtest.ts",
        marker:
          /leaves no context behind on a reused connection, and it IS reused/,
      },
    ],
    caveat:
      "Measured: a worker CAN set any GUC (set_config is executable by PUBLIC), so a bare app.tenant_id would make tenancy an assertion by the worker. Binding it to the lease means the job PAYLOAD -- where LLM output arrives in Phase 1B -- can never influence it. Against a fully malicious worker PROCESS the bound is ops_worker's grants, not one tenant.",
  },
  {
    id: "SI-15",
    statement:
      "The ops schema is unreachable by anon and authenticated, is absent from the PostgREST allowlist, and no PostgREST request reaches it with any credential, service_role included.",
    provenBy: ["live database", "migration assertion", "static guard"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260912120000_ops_execution_core.sql",
        marker: /can reach schema ops/,
      },
      {
        file: "supabase/config.toml",
        // The allowlist must NOT name ops. Asserted as the exact current value
        // so adding a schema is a deliberate, reviewable diff.
        marker: /schemas = \["public", "storage", "graphql_public"\]/,
      },
      {
        // Phase 1C: a REQUEST, not a config file. Every ops relation and
        // function in the live catalogue, through Kong over REST and GraphQL,
        // with no key, the publishable key, the anon JWT, the service_role JWT
        // and the secret key, each behind a positive control.
        file: "supabase/tests/opsDataApiExposure.mjs",
        marker: /none reached ops/,
      },
      {
        // Phase 1C: bypass roles were exempt from the grant rules everywhere,
        // so `grant select on ops.x to service_role` passed statically.
        file: "supabase/invariants/rules.mjs",
        marker: /"ops-grant"/,
      },
      {
        file: "supabase/tests/migrationInvariants.test.ts",
        marker: /a read on an ops table granted to service_role \(BYPASSRLS\)/,
      },
    ],
    caveat:
      "The allowlist governs one channel. A direct libpq connection ignores it -- see ADR 0011. The probe attacks the Data API only, over REST and GraphQL, and asserts the live PostgREST search path excludes ops; it holds no signed-in authenticated JWT, because minting one needs the development signing key (SI-20) or a sign-up that writes. On the LOCAL CLI stack three unauthenticated paths run SQL as postgres -- Kong POST /pg/query, Studio POST /api/platform/pg-meta/default/query, and Postgres with the default password -- and Docker Desktop publishes them on every interface, IPv6 included, unless its Port binding behavior is Localhost only (measured 2026-09-12): a local-development exposure this invariant does not cover, detected by npm run check:local-exposure. A hosted project's gateway is not measured by anything here. The probe never writes: every REST write and RPC attempt carries an unparseable body, which a closed schema refuses with 406 before parsing and an open one rejects with 400 without executing, and the GraphQL request is introspection only.",
  },
  // -- Phase 1B: the production worker runtime ------------------------------
  {
    id: "SI-16",
    statement:
      "The worker PROCESS refuses to start unless its database identity is a non-superuser, non-BYPASSRLS role that can assume ops_worker.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "engine/db/workerIdentity.ts",
        marker: /Refusing to start: the worker's database identity/,
      },
      {
        // The gate is useless if the entry point stops calling it.
        file: "engine/worker/main.ts",
        marker: /assertWorkerIdentity\(await db\.identity\(\)\)/,
      },
      {
        file: "scripts/provision-worker-role.mjs",
        marker:
          /login noinherit nosuperuser nocreatedb nocreaterole nobypassrls/,
      },
      {
        file: "engine/worker/pooling.dbtest.ts",
        marker: /is not a superuser, carries no BYPASSRLS/,
      },
    ],
    caveat:
      "This is a BOOT gate because the failure it catches is invisible at runtime: a worker connected as postgres or service_role runs every job correctly and leaks every tenant. The login role is NOINHERIT, so `set local role ops_worker` is load-bearing rather than decorative.",
  },
  {
    id: "SI-17",
    statement:
      "An unknown job kind fails closed and permanently. The runtime never dispatches on a name a payload supplies, and never loads code from one.",
    provenBy: ["unit test", "live database"],
    enforcedBy: [
      {
        file: "engine/worker/handlerRegistry.ts",
        marker: /No dynamic import/,
      },
      {
        file: "engine/worker/handlerRegistry.test.ts",
        marker: /does not resolve inherited object properties/,
      },
      {
        file: "engine/worker/workerRuntime.dbtest.ts",
        marker: /names an object prototype member/,
      },
    ],
    caveat:
      'The registry is a Map, so there is no prototype chain for a kind like "toString" to resolve against. On a plain object literal that lookup returns a function.',
  },
  {
    id: "SI-18",
    statement:
      "A capability reaching from ops into public takes its tenant from the live lease, refuses any tenant that does not own this deployment's CRM, and clamps its parameters to a hard floor.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260912160000_ops_worker_runtime.sql",
        marker: /does not own this deployment CRM/,
      },
      {
        file: "engine/worker/capabilities.ts",
        marker: /tenant argument would hand tenancy back to the caller/,
      },
      {
        file: "engine/worker/workerRuntime.dbtest.ts",
        marker: /floors a retention window the payload tried to shorten/,
      },
    ],
    caveat:
      "public.* carries no tenant column and never will (ADR 0002), so `ops.tenants.owns_local_crm` is the whole bridge. The retention floor is in the DATABASE, not the handler, so it holds against a handler that never validated anything.",
  },
  {
    id: "SI-19",
    statement:
      "No CRM record data (contacts, notes, lead profiles, email addresses, consent state) is written to durable browser storage. The React Query cache lives in memory only, a cache persisted by an earlier build is purged at startup, and logout clears it.",
    provenBy: ["unit test"],
    enforcedBy: [
      {
        file: "src/components/atomic-crm/root/CRM.security.test.tsx",
        marker:
          /keeps contacts, notes, emails and consent state out of storage/,
      },
      {
        file: "src/components/atomic-crm/root/CRM.security.test.tsx",
        marker: /purges a cache that an earlier build left on the device/,
      },
      {
        file: "src/components/atomic-crm/providers/supabase/authProvider.security.test.ts",
        marker: /removes the persisted React Query cache/,
      },
      {
        file: "eslint.config.js",
        marker: /group: \["@tanstack\/\*persist\*"\]/,
      },
    ],
    caveat:
      "Measured in localStorage and sessionStorage behind the real <CRM> root, mobile and desktop trees, with the FakeRest providers: a cache added inside the Supabase provider layer would not be seen by that test. Two API responses persist by design, the tenant's configuration and the signed-in user's own sales row, as do the Supabase session and ra-core's preference store. That store includes list filters the user typed, so a searched patient name survives until logout (SEC-1BS-13). The service worker precaches static assets only.",
  },
  {
    id: "SI-20",
    statement:
      "The committed development JWT signing key never leaves local tooling: no other tracked file carries its private or public component, only local and test configuration names it, every GitHub Pages publish scans what it ships, and every push to Supabase in deploy.yml or the makefile is preceded by a blocking check that refuses a project trusting the key.",
    provenBy: ["static guard", "unit test"],
    enforcedBy: [
      {
        file: "scripts/dev-signing-key.mjs",
        marker: /rule: "dev-key-material-copied"/,
      },
      {
        file: "scripts/dev-signing-key.mjs",
        marker: /rule: "direct-pages-publish"/,
      },
      {
        file: "scripts/dev-signing-key.mjs",
        marker: /rule: "deploy-without-key-check"/,
      },
      {
        file: "scripts/test/dev-signing-key.test.mjs",
        marker: /confines the development signing key to local tooling/,
      },
      {
        file: "scripts/test/dev-signing-key.test.mjs",
        marker:
          /reads a pinned CLI version, an executable name and global flags/,
      },
      {
        file: "scripts/dev-signing-key.mjs",
        marker: /export const mayContinueOnError/,
      },
      {
        file: "scripts/publish-pages.mjs",
        marker: /Nothing was published/,
      },
      {
        file: "scripts/scan-build-artifacts.mjs",
        marker: /rule: "dev-signing-key"/,
      },
      {
        file: ".github/workflows/deploy.yml",
        marker:
          /node scripts\/dev-signing-key\.mjs --project-ref "\$SUPABASE_PROJECT_ID"/,
      },
      {
        file: "makefile",
        marker: /node scripts\/dev-signing-key\.mjs --linked/,
      },
    ],
    caveat:
      "Catches verbatim, base64, hex and PEM copies; a deliberately obfuscated copy is out of scope. No Supabase CLI command uploads signing keys, so a hosted project trusts this key only if a person imports it: the JWKS check sees that and fails closed, but only when a deploy runs. scripts/supabase-remote-init.mjs provisions a brand-new project, which generates its own keys, and its initial push is not gated.",
  },
  // -- Phase 1C: the Company OS domain core ----------------------------------
  {
    id: "SI-21",
    statement:
      "Company OS data is backend-only: no application role (anon, authenticated, service_role, ops_worker, ops_gateway) holds any privilege on a Company OS table or can execute a Company OS service, no ops function is executable by PUBLIC, every Company OS service is SECURITY INVOKER, and the only SECURITY DEFINER functions ops_worker or ops_gateway can execute are a pinned set: the worker's lease-bound capabilities and runtime functions, and the gateway's two functions bound to a configured provider target.",
    provenBy: [
      "live database",
      "migration assertion",
      "static guard",
      "unit test",
    ],
    enforcedBy: [
      // Phase 2B (2026-09-18): the gateway role and its two DEFINER functions.
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /A5: a Phase 2B function has the wrong security or search path/,
      },
      // Phase 1D (2026-09-14): the agent run and execution stop tables, and the
      // six lease-bound capabilities, the only DEFINER functions it adds.
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /A1: an agent runtime table is reachable by an application role/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /A3: an agent runtime owner service is reachable by an application role/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /B: a leased worker reached agent runtime data or services/,
      },
      {
        file: "supabase/migrations/20260914120000_agent_runtime.sql",
        marker:
          /the SECURITY DEFINER surface in ops drifted from the pinned set/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /A1: Company OS table reachable by an application role/,
      },
      {
        // The whole EXECUTE surface of the application roles in ops, pinned: a
        // function born reachable, or a grant nobody reviewed, fails by name.
        file: "supabase/tests/company_domain_core.sql",
        marker: /A4: the ops EXECUTE surface drifted from the pinned set/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /B: a leased worker reached Company OS data or services/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /E8: an EXECUTE grant alone let a worker write Company OS data/,
      },
      {
        file: "supabase/migrations/20260912200000_company_domain_core.sql",
        marker: /ops function\(s\) executable by PUBLIC/,
      },
      {
        file: "supabase/invariants/rules.mjs",
        marker: /default-privileges:ops:/,
      },
      {
        file: "engine/domain/companyOs.dbtest.ts",
        marker: /refuses a leased worker at the privilege layer/,
      },
      {
        // A native permission failure is a misconfigured connection — never
        // dressed up as a domain refusal the caller would handle and move past.
        file: "engine/domain/errors.test.ts",
        marker: /leaves a native permission failure alone/,
      },
    ],
    caveat:
      "The owner (postgres) is outside this boundary by design, exactly as it is for RLS. The lease-bound read policies on the Company OS tables are declared with NO grant and are proven only through a grant that exists inside a rolled-back transaction: policy-shape evidence for a future reader, not a live read path. PostgreSQL gives every new function EXECUTE to PUBLIC and the Phase 1A per-schema default-privilege revoke does not remove it (measured), so each function is revoked explicitly and the pinned per-run EXECUTE set is what catches a forgotten one.",
  },
  {
    id: "SI-22",
    statement:
      "Tenant and company consistency is structural: every reference between Company OS rows carries tenant_id and company_id through a composite foreign key or an insert guard, org units cannot be re-parented, and an id outside the caller's tenant scope is not found before any of its state is read — so no role but the owner can store a cross-tenant or cross-company row.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /D1 a tenant-A department in a tenant-B company/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /D4 a tenant-A task assigned a tenant-B agent \(foreign key\)/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /D8 a parent-task cycle in one multi-row INSERT/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /D11 moving a department to another tenant/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /E4 tenant B''s inactive agent through tenant A/,
      },
      {
        file: "supabase/migrations/20260912200000_company_domain_core.sql",
        marker: /composite foreign key\(s\) missing/,
      },
    ],
    caveat:
      "The owner can DISABLE TRIGGER and, on Supabase, set session_replication_role = replica, which skips foreign-key checks and ORIGIN triggers; the UPDATE-path guards are ENABLE ALWAYS so replica mode does not silence them, but insert validation and foreign keys are not. A company is an organisational partition inside a tenant, NOT an isolation boundary: businesses that need isolation from each other must be separate tenants, and a capability reached from company-scoped work must authorise against a company-level binding.",
  },
  {
    id: "SI-23",
    statement:
      "Task status changes only along the declared state machine and a closed task is immutable, for every role but the owner; every lifecycle change writes exactly one event in the same statement, a change without declared provenance is refused, lifecycle facts cannot be recorded directly, and events are never updated.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /F1: illegal task transition accepted/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /F2 a task born completed/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /G1: a lifecycle operation did not emit exactly its one event/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /G4: a mutation survived the failure of its event/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /G6 a raw insert forging company.status_changed/,
      },
      {
        // The function's own check, proven with the table guard off: the two
        // layers raise the same SQLSTATE, so G6 alone cannot tell them apart.
        file: "supabase/tests/company_domain_core.sql",
        marker:
          /G6b record_event forging task.completed with the table guard off/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /D12: replica mode silenced the closed-task guard/,
      },
      {
        file: "engine/domain/companyOs.dbtest.ts",
        marker: /on every task transition, in both directions/,
      },
      {
        // The guards are triggers; a migration that drops one without
        // re-creating it, or brings an ALWAYS one back as ORIGIN, is refused.
        file: "supabase/invariants/replay.mjs",
        marker: /"trigger-dropped"/,
      },
      {
        file: "supabase/tests/migrationInvariants.test.ts",
        marker: /dropping an ALWAYS guard trigger outright/,
      },
    ],
    caveat:
      "The provenance settings are a tripwire, not an authority: any role can write a GUC, and only the owner holds DML. The reserved-namespace check is likewise a tripwire against the owner. engine/domain/taskStateMachine.ts authorises nothing; the trigger is the only enforcement point, and a driver-backed test asserts the two relations are equal.",
  },
  {
    id: "SI-24",
    statement:
      "A task can request execution only for an allowlisted job kind — exactly agent_run.execute since Phase 1D, and only for a pending agent run of the same task that has no job — and the job's tenant is the task row's, never the payload's; a task never adopts a job it did not request, and a cross-tenant task/job link cannot be stored.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      // Phase 1D (2026-09-14): the allowlist holds exactly one kind, and the
      // bridge creates it only for a pending run of the same task.
      {
        file: "supabase/migrations/20260914120000_agent_runtime.sql",
        marker:
          /ops\.task_executable_kinds\(\) is not exactly \{agent_run\.execute\}/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /A5: ops\.task_executable_kinds\(\) is not exactly \{agent_run\.execute\}/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /J1 an agent run job with an extra key/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /J4: the bridge created a job outside its task/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /H1: a non-allowlisted kind was enqueued/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /H2: a task job took its tenant from the payload/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /H4: the bridge adopted a job its task did not request/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /D10 linking a tenant-A task to a tenant-B job/,
      },
      {
        file: "supabase/migrations/20260912200000_company_domain_core.sql",
        marker: /Phase 1C ships no executable task kind/,
      },
      {
        file: "engine/domain/companyOs.dbtest.ts",
        marker: /that every kind a task may request has a registered handler/,
      },
    ],
    caveat:
      "postmark.ledger_retention is tenant-wide CRM maintenance, so it is deliberately NOT task-executable: a company-scoped task must not be able to trigger it. Since Phase 1D the bridge's success path runs against the real allowlist, through ops.request_agent_run. Settling a job never changes a task.",
  },
  // -- Pre-1D closure: production scope ---------------------------------------
  {
    id: "SI-25",
    statement:
      "The development seed never reaches a remote project through a committed path: no tracked file outside prose, the guard and reviewed fixtures pushes it with the CLI's include-seed flag, resets a linked or non-loopback database, changes the seed paths, or names a seed SQL file, or a glob that can expand to one, outside a reviewed list of local uses; and global reference data a production database needs exists after migrations alone.",
    provenBy: ["static guard", "unit test", "live database"],
    enforcedBy: [
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"remote-seed"/,
      },
      {
        file: "scripts/production-scope-commands.mjs",
        marker: /"remote-db-reset"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"seed-file-reference"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /changes the seed files a reset applies/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /export function seedGlobs/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker: /refuses a remote reset, however it is spelled/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker:
          /refuses a seed file named anywhere outside the reviewed local uses/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker: /refuses a glob that can expand to the seed file, in any file/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker:
          /refuses seed configuration in an inline table, however it is spelled/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker: /refuses the seed glob spellings the closure review found/,
      },
      {
        file: "scripts/test/production-scope.test.mjs",
        marker:
          /refuses changed seed paths, an inline seed table and a remote seed table/,
      },
      {
        file: "supabase/migrations/20260913120000_favicons_excluded_domains_reference.sql",
        marker: /favicons_excluded_domains is missing % of % reference domains/,
      },
      {
        file: "supabase/tests/referenceData.mjs",
        marker: /no Company OS tenant/,
      },
      {
        file: ".github/workflows/database.yml",
        marker: /run: node supabase\/tests\/referenceData\.mjs --without-seed/,
      },
    ],
    caveat:
      "Static: a person seeding by hand, a command or path assembled from string fragments, and a directory-wide glob such as supabase/* are outside it. So is a seeded local database dumped and restored elsewhere. Local supabase start and db reset, and the CI local stacks, still seed on purpose. Since 2026-09-13 global reference data (favicons_excluded_domains) ships in a migration and CI proves it after a migrations-only replay; tenant vocabulary such as loss_reasons stays out of migrations and waits for an explicit onboarding path, so a hosted tenant cannot mark a deal lost until it has one.",
  },
  {
    id: "SI-26",
    statement:
      "Global monotonic identifiers (ops.events.seq, ops.job_events.id and any future sequence shared across tenants) are internal only: anon and authenticated cannot reach schema ops, no application role holds a privilege on a Company OS table, and the static migration guard rejects any grant on ops to anon, authenticated or PUBLIC and any bypass-role grant beyond the pinned set.",
    provenBy: ["static guard", "migration assertion", "live database"],
    enforcedBy: [
      {
        file: "docs/adr/0015-company-os-domain-core.md",
        marker: /GLOBAL MONOTONIC IDENTIFIERS ARE INTERNAL ONLY/,
      },
      {
        file: "supabase/invariants/rules.mjs",
        marker: /ops is backend-only \(SI-15, SI-21\)/,
      },
      {
        file: "supabase/tests/migrationInvariants.test.ts",
        marker: /ops-grant:supabase_read_only_user:ops\\\.events:select/,
      },
      {
        file: "supabase/migrations/20260912200000_company_domain_core.sql",
        marker: /role % can reach schema ops/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /A1: Company OS table reachable by an application role/,
      },
    ],
    caveat:
      "It guards grants, not what code does with a value. ops_worker reads ops.job_events.id under the lease-bound policy and is not tenant-facing. A worker capability, edge function or future API that reads a global sequence through ops_worker, service_role or the owner and returns it to a tenant is outside it and is a review event under ADR 0015's owner clarification. A tenant-scoped or opaque cursor must be designed before any tenant-facing event or job-event reader exists.",
  },
  {
    id: "SI-27",
    statement:
      "The owner-session Postgres pool reaches nothing in ops and carries nothing between requests: the pool is private to db.ts, whose only use is runAsUser, which assumes authenticated for one transaction with the caller's id as a bound parameter; merge_contacts, the only function that loads it, sends fixed statements through it, and both files are sealed; authenticated holds no privilege in ops; and after COMMIT, ROLLBACK or an error inside the transaction the one pooled session is again the owner, with no role, identity, tenant context or open transaction.",
    provenBy: ["live database", "static guard", "unit test"],
    enforcedBy: [
      {
        file: "supabase/functions/_shared/db.ts",
        marker: /CompiledQuery\.raw\("SET LOCAL ROLE authenticated"\)/,
      },
      {
        file: "supabase/functions/_shared/db.ts",
        marker: /^const db = new Kysely<Database>\(/m,
      },
      {
        file: "supabase/tests/ownerSessionSeal.test.ts",
        marker: /const OWNER_SESSION_SEAL/,
      },
      {
        file: "supabase/tests/ownerSessionSeal.test.ts",
        marker: /"supabase\/functions\/_shared\/db\.ts":\s*"[0-9a-f]{64}"/,
      },
      {
        file: "supabase/tests/ownerSessionSeal.test.ts",
        marker:
          /"supabase\/functions\/merge_contacts\/index\.ts":\s*"[0-9a-f]{64}"/,
      },
      {
        file: "supabase/functions/_shared/db.ts",
        marker: /"SELECT set_config\('request\.jwt\.claim\.sub', \$1, true\)"/,
      },
      {
        file: "supabase/functions/merge_contacts/index.ts",
        marker: /return await runAsUser\(userId,/,
      },
      {
        file: "supabase/tests/owner_session_pool.sql",
        marker: /B: the downgraded transaction ran/,
      },
      {
        file: "supabase/tests/owner_session_pool.sql",
        marker: /C\/D: the role survived/,
      },
      {
        file: "supabase/tests/owner_session_pool.sql",
        marker: /characterisation changed: RESET ROLE/,
      },
      {
        file: "supabase/tests/ownerSessionPool.mjs",
        marker: /every transaction ran on backend/,
      },
      {
        file: "supabase/tests/ownerSessionPool.mjs",
        marker: /is refused at the schema/,
      },
      {
        file: "supabase/tests/ownerSessionPool.probe.ts",
        marker: /ownerPoolForProbe as db,/,
      },
      {
        file: "supabase/tests/ownerSessionPool.mjs",
        marker: /const PROBE_EXPORT = "export \{ db as ownerPoolForProbe \};"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"postgres-pool-consumer"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"raw-sql-non-literal"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker: /"function-imports-other-function"/,
      },
      {
        file: "scripts/test/production-scope-functions.test.mjs",
        marker: /refuses a function that imports another function's files/,
      },
    ],
    caveat:
      "The role switch is not a privilege boundary: the owner session can RESET ROLE, and both suites characterise that it does. Containment rests on code: the pool is private to db.ts and runAsUser is its only use; db.ts and merge_contacts/index.ts are sealed (tests/ownerSessionSeal.test.ts), because the static guard cannot read a raw method reached through a computed member name or reflection; only merge_contacts may import the pool, and no function imports another's files (SI-03); and authenticated holds nothing in ops (SI-15, SI-21). The seal runs with the unit tests that gate every CI deploy, not in the makefile. The real-driver suite runs db.ts, plus one appended line that hands its probe the private pool, as a main service on a direct connection in the local edge runtime; a hosted SUPABASE_DB_URL that names a pooler is not measured. A COMMIT that itself fails and a connection that breaks mid-transaction are not exercised.",
  },
  // -- Phase 1D: agent runs, model providers and the execution stop -----------
  {
    id: "SI-28",
    statement:
      "An agent run is one bounded model invocation for one agent about one task it is assigned: every run carries its tenant, company, department, task and agent through composite keys, the agent must be the task's assignee in an active company and department both when the run is requested and immediately before the call, and a run never changes its task.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260914120000_agent_runtime.sql",
        marker: /composite foreign key\(s\) missing/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /E3 an agent the task is not assigned to/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /E8: a refused agent run request wrote something/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /L9: a run whose gate changed since the request/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /L1: an agent run changed its task/,
      },
    ],
    caveat:
      "Tenant is the isolation boundary and a company is organisation only (ADR 0015). The owner is outside this boundary exactly as for SI-22: raw DML with foreign-key checks skipped in replica mode, or DISABLE TRIGGER, can store what the services refuse.",
  },
  {
    id: "SI-29",
    statement:
      "A model call is issued at most once per run: the start commits running before any call and only that token authorises one; a run found running by anyone but its own live attempt is settled indeterminate and never started again; a call's failure is recorded as the run's outcome, never retried by its job; the adapter and router make exactly one request with no retry or fallback; and a retry is a new run naming the finished run it repeats.",
    provenBy: ["live database", "migration assertion", "unit test"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260914120000_agent_runtime.sql",
        marker: /agent run error categories map to the wrong status/,
      },
      {
        // ADR 0016 owner review (2026-09-16): an ambiguous provider outcome,
        // a 5xx included, is indeterminate in the database, the table and the
        // adapter, and never a known failure.
        file: "supabase/migrations/20260916120000_agent_run_ambiguous_provider_failures.sql",
        marker:
          /agent run error categories map to the wrong status after the owner review/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /N15b: a raw update recording a provider server error as a known failure/,
      },
      {
        file: "engine/models/openaiResponses.test.ts",
        marker:
          /classifies every HTTP status outside the definitive refusals as indeterminate/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /L4: a second start changed a running run/,
      },
      {
        // Through real processes: a worker killed while its call is in flight.
        file: "engine/domain/agentRunRuntime.dbtest.ts",
        marker:
          /is recovered by the stale-run sweep as indeterminate, and the next worker never calls the provider/,
      },
      {
        file: "engine/domain/agentRunRuntime.dbtest.ts",
        marker:
          /never calls again for a run whose answer arrived but was never settled/,
      },
      {
        file: "engine/domain/agentRunRuntime.dbtest.ts",
        marker:
          /does not call the provider again when settlement failed transiently and the runtime scheduled the job/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /L7: a run left running by an earlier attempt was not settled indeterminate on its next claim/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /N3b: a run another attempt started was not settled indeterminate by a later start/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /M1: a running run whose lease expired was not settled indeterminate/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /N6a: the sweep left a run whose lease ran out on the wall clock/,
      },
      {
        file: "engine/handlers/agentRunExecute.test.ts",
        marker: /settles without calling on every other token start returns/,
      },
      {
        file: "engine/handlers/agentRunExecute.test.ts",
        marker:
          /issues exactly one call whatever the provider does, and never retries/,
      },
      {
        file: "engine/models/router.test.ts",
        marker:
          /invokes a failing provider once, passes its category through, and never tries another route/,
      },
      {
        file: "engine/worker/runOneJob.test.ts",
        marker:
          /hands the error to settle and completes the job without recording a failure/,
      },
    ],
    caveat:
      "At most once, not exactly once: a run whose attempt died, or whose settle transaction failed after the provider answered, is indeterminate even when the call succeeded or never left the process, and a person decides whether to request a retry. No provider idempotency exists for the Responses API, so nothing below the database can deduplicate a call. A stop tripped after a start commits does not interrupt that call; it is bounded by the route timeout and the lease deadline.",
  },
  {
    id: "SI-30",
    statement:
      "The worker reaches agent runs only through lease-bound capabilities that take no tenant, run, task, agent or job argument and require a lease live on the current clock; the job payload is a reference cross-checked against the leased run, never authority; and ops_worker holds no privilege on agent runs, execution stops, tasks or agents.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /A2: an agent run capability is not a lease-bound definer/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /C6: claiming one run changed runs/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /C7: a job payload chose the agent run a lease reached/,
      },
      {
        file: "engine/domain/agentRuns.dbtest.ts",
        marker:
          /keeps the reaper and a re-lease off a job whose claim is still open, and lets them act once it ends/,
      },
      {
        // The lease on the clock again after start_agent_run's own lock waits.
        file: "engine/domain/agentRuns.dbtest.ts",
        marker:
          /refuses a start whose lease ran out while it waited on the task lock, and leaves the run pending/,
      },
      {
        file: "engine/domain/agentRunRuntime.dbtest.ts",
        marker: /fails a forged agent_run.execute job as a security refusal/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /A4: the ops EXECUTE surface drifted from the pinned set/,
      },
      {
        file: "engine/worker/capabilities.test.ts",
        marker:
          /carries no tenant, run, task, agent or job id, even one smuggled onto its input/,
      },
      {
        file: "engine/handlers/agentRunExecute.test.ts",
        marker:
          /refuses a payload that does not name the claimed run, before any other capability and any call/,
      },
    ],
    caveat:
      "The bound is the same as SI-14's: a fully malicious worker process holding a legitimate lease can misreport its own run's outcome or usage, but cannot reach another run, another tenant or any table. The sweep checks no lease, like ops.reap_expired_leases, and touches only runs whose attempt is provably dead. The claim returns agent and task text to the worker, which sends it to the provider.",
  },
  {
    id: "SI-31",
    statement:
      "An active execution stop refuses every new agent run it covers at request time, recording the refusal naming the stop, and holds every run it covers again immediately before the call, recording nothing, so that run's job is deferred and the same run starts only after the stop is cleared; both checks are serialised with tripping so a returned trip is seen by every later request and start; any covering stop wins over a cleared narrower one; a stop that cannot be read refuses; and a stop is cleared only by a recorded owner act, and cannot be deleted while active, truncated, or rewritten except by redaction.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /K1: a global stop did not refuse another tenant/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /K2: an active tenant stop did not refuse a run whose narrower stop was cleared/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /K3: a stop tripped after the lease did not hold the run at start/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /K11 reading the switch without a tenant/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /N7b: ops.start_agent_run does not hold the kill-switch lock shared once it has read the stops/,
      },
      {
        // The ORDER, lock before read, needs two sessions.
        file: "engine/domain/agentRuns.dbtest.ts",
        marker:
          /makes a start wait for a trip in flight, and the start holds its run once the trip commits, deferring its job under that stop/,
      },
      {
        file: "engine/domain/agentRuns.dbtest.ts",
        marker:
          /makes a request wait for a trip in flight, and records the request as refused by that stop once the trip commits/,
      },
      {
        file: "engine/domain/agentRuns.dbtest.ts",
        marker:
          /makes a trip wait for a clearing of the same target, and records a new active stop once the clearing commits/,
      },
      {
        file: "engine/domain/agentRunRuntime.dbtest.ts",
        marker:
          /refuses a run at request under a global stop and holds it at the lease and at start under an agent stop, with no provider call, and runs that same run once cleared/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /N7d: ops\.trip_execution_stop did not take the kill-switch lock exclusively/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /N10a: a caller for whom row security hides the stops read the switch as/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /A7: agent runtime guard trigger\(s\) missing or not ENABLE ALWAYS/,
      },
      {
        file: "engine/domain/executionStops.test.ts",
        marker:
          /offers no force or override, and never forwards one set on the act or the target/,
      },
      {
        file: "engine/cli/executionStop.test.ts",
        marker:
          /trips a stop in one owner transaction and prints one JSON line/,
      },
    ],
    caveat:
      "It states the agent-run part of the switch. Holding every external job at the lease, the job_kind scope and the pre-call re-check for every handler are SI-37 (Phase 1D.1); the spend ceiling that trips the switch is SI-36. There is no tool scope (no tools exist) and no UI. The owner can DISABLE TRIGGER, as for SI-22 and SI-23. A stop does not interrupt a call already started.",
  },
  {
    id: "SI-32",
    statement:
      "Model output is untrusted, advisory data: the request declares no tools and asks for no reasoning, the answer must satisfy a strict structured contract validated in the worker and again by the database before a run can succeed, it is stored only on the run row, it selects nothing and changes no task, job or CRM row, and events about a run carry no content.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "engine/models/openaiResponses.test.ts",
        marker:
          /sends exactly the documented body keys, and none that grant a capability or retain state/,
      },
      {
        file: "engine/models/openaiResponses.test.ts",
        marker: /ignores reasoning items entirely, wherever they appear/,
      },
      {
        file: "engine/models/router.test.ts",
        marker:
          /rejects malformed output as schema_validation, carrying what the call cost/,
      },
      {
        file: "engine/models/taskAssessment.test.ts",
        marker:
          /keeps an instruction-shaped task field inside the document and out of the instructions/,
      },
      {
        file: "engine/handlers/agentRunExecute.test.ts",
        marker:
          /stores output that looks like a tenant id, a job kind, SQL or a URL only as opaque result data/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /L2: an envelope with/,
      },
      {
        file: "engine/domain/agentRunRuntime.dbtest.ts",
        marker:
          /assesses an assigned task with one provider call, stores the facts of that call, and never touches the task/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /I3: an agent_run fact carries a payload key outside the minimised set/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker:
          /I3: an agent_run fact carries an outcome outside the three-valued contract/,
      },
    ],
    caveat:
      "Advisory does not mean harmless to read: a summary or proposed step can carry prompt-injected text, and any future reader that acts on it inherits that risk; nothing in Phase 1D acts on it. Task and agent text is sent to the provider, whose abuse-monitoring retention applies despite store: false; only synthetic data may reach a live provider until the processor question (BASELINE Q8) is decided.",
  },
  {
    id: "SI-33",
    statement:
      "Model provider credentials are backend-only: no VITE_-prefixed provider variable exists in tracked build inputs or the build, no provider key shape reaches the build, the model and handler layers never read the process environment, provider strings that echo the key are dropped and errors surface as fixed messages, and CI needs no provider key.",
    provenBy: ["static guard", "unit test"],
    enforcedBy: [
      {
        file: "scripts/scan-build-artifacts.mjs",
        marker: /browser-model-provider-variable/,
      },
      {
        file: "scripts/test/scan-build-artifacts.test.mjs",
        marker:
          /refuses a VITE_ model provider variable however a build spells it/,
      },
      {
        file: "scripts/test/scan-build-artifacts.test.mjs",
        marker: /catches an OpenAI API key under each of its prefixes/,
      },
      {
        file: "engine/models/providerSecretsBoundary.test.ts",
        marker: /holds for every build input in the repository/,
      },
      {
        file: "engine/models/providerSecretsBoundary.test.ts",
        marker:
          /holds for every file under engine\/models and engine\/handlers/,
      },
      {
        file: "engine/models/openaiResponses.test.ts",
        marker:
          /drops an id or model that echoes the key, even when it is well formed/,
      },
      {
        file: "engine/models/routingConfig.test.ts",
        marker:
          /refuses any other provider, including the test-only fake, without echoing the value/,
      },
    ],
    caveat:
      "The build scan reads names through source maps: without them, a provider value that is not key-shaped could ship under a VITE_ name with no finding. The older assigned-server-secret rule still misses prefixed and JSON-quoted forms of its existing names. Providers other than OpenAI and Anthropic are not named. Nothing inspects the worker's runtime environment or a person running the smoke command with a live key.",
  },
  {
    id: "SI-34",
    statement:
      "Agent run lineage cannot be chosen by a caller or a model: correlation is generated or inherited by the database, causation is derived from the run's own lifecycle facts, and an idempotency key is tenant-scoped data that returns the same run for the same request and refuses a different one.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /A4: ops\.request_agent_run takes lineage from its caller/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /G4: a retry did not inherit its parent/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /G6: two independent requests share a correlation/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /F1: replaying the same request returned another run/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /F4: the same key in tenant B returned tenant A/,
      },
      {
        file: "engine/domain/agentRuns.dbtest.ts",
        marker:
          /resolves two concurrent requests with one key to one run and one job, the second waiting for the first to commit/,
      },
      {
        file: "supabase/tests/agent_runtime.sql",
        marker: /N14a: agent_run\.started was caused by/,
      },
      {
        file: "engine/domain/agentRuns.test.ts",
        marker:
          /never forwards lineage or a tenant smuggled onto the context or the input/,
      },
    ],
    caveat:
      "The Phase 1C owner services still accept a caller-declared correlation_id for their own lifecycle events (ADR 0016 §5 residual); agent run facts never read it. An idempotency key is not a secret and grants nothing: it names a request inside one tenant.",
  },
  {
    id: "SI-35",
    statement:
      "Model cost is never invented: a run starts only with a current, unexpired price version of its own provider and model, recorded by an owner act, immutable once recorded, never shipped by a migration, and never replaced by an older version when the latest has expired; the start records that version and the worst-case reservation the database derives from the claimed context and the route ceiling; the estimate and the charge are derived by the database from complete, consistent usage on every write path; an outcome whose cost is unknown stays charged at its reservation; and only a refusal with no response body is charged nothing.",
    provenBy: ["live database", "migration assertion", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /P7: an expired latest price version fell back to an older unexpired one/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /P11: an application role reached the model prices/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /a refusal that carries a provider response id is charged its reservation/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /C4: a raw settlement kept a caller''s figures instead of deriving them/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /A10: a run whose model has no current price \(%\) was not refused before any call/,
      },
      {
        file: "supabase/tests/referenceData.mjs",
        marker: /model_prices/,
      },
      {
        file: "supabase/migrations/20260917120000_runtime_governance.sql",
        marker:
          /runtime governance shipped price or limit rows; both are owner data/,
      },
      {
        // The database's zero charge relies on this adapter contract.
        file: "engine/models/openaiResponses.test.ts",
        marker:
          /rejects every non-2xx answer with no response id, no model and no usage, whatever its body claims/,
      },
      {
        file: "engine/handlers/agentRunExecute.test.ts",
        marker:
          /reports to the start the same output ceiling the request carries, which is the route's/,
      },
      {
        file: "engine/domain/spendSettlement.dbtest.ts",
        marker:
          /records its price version, an estimate from complete and consistent usage, and a charge equal to that estimate/,
      },
      {
        file: "engine/domain/spendSettlement.dbtest.ts",
        marker: /that carries no response id, no response model and no usage/,
      },
      {
        file: "engine/domain/runtimeGovernanceMirrors.dbtest.ts",
        marker:
          /is never exceeded by the request the handler sends, for adversarial agent and task text at every column limit/,
      },
      {
        file: "engine/domain/runtimeGovernanceMirrors.dbtest.ts",
        marker:
          /has the database's route output ceilings equal to MODEL_ROUTE_POLICIES/,
      },
      {
        file: "engine/domain/claimContext.dbtest.ts",
        marker:
          /waits until the prepare transaction ends when it edits the claimed/,
      },
      {
        file: "engine/domain/operatorCatalog.dbtest.ts",
        marker: /never fall back to an older version of an expired model/,
      },
      {
        file: "engine/domain/runtimeGovernanceMirrors.dbtest.ts",
        marker:
          /sends the provider exactly the output ceiling the database reserved for/,
      },
      {
        // The zero charge is only for the four refusal categories.
        file: "engine/domain/spendSettlement.dbtest.ts",
        marker: /is charged its reservation for a failed run of category/,
      },
    ],
    caveat:
      "An estimate is usage times a recorded list price, not an invoice. The reservation assumes a byte-level tokenizer and that max_output_tokens bounds every generated token; a provider that breaks either needs another ceiling before it is priced. An owner's raw UPDATE that states a reservation is outside the boundary, like every owner act (SI-22). Prices are keyed on the configured model id, so a route should name a pinned snapshot. The Phase 1C length checks trim only spaces, so an owner can store text longer than its nominal limit; the start then reserves for the real text.",
  },
  {
    id: "SI-36",
    statement:
      "Spend is bounded before any call: a run starts only when an active global daily ceiling and its tenant's daily budget exist and every applicable limit can absorb its worst-case reservation, checked under per-scope locks taken after the kill-switch lock and only under READ COMMITTED, so two starts racing at a limit cannot both admit on a stale total; exhaustion by settled spend is recorded naming the limit version, contention with calls in flight records nothing and retries, and no worker can record a spend refusal; a stalled worker cannot hold the spend locks past its idle-transaction bound; and a global ceiling exhausted by settled spend trips a system execution stop that never absorbs or clears an owner's stop and that only a person clears.",
    provenBy: ["live database", "migration assertion", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /A1: a run started with no global ceiling configured/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /A4: a start settled spend cannot absorb was not recorded cancelled by that limit version/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /A5: a start that fits settled spend but not the calls in flight was not refused with OS429/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /A12: a missing tenant budget beside a contended ceiling was not refused as unconfigured with no limit/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /A9: a worker recorded budget_exhausted through fail_agent_run/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /W4: a settlement that raised a charge above its reservation did not take the spend locks first/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /ran under REPEATABLE READ instead of refusing/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /E2: the ceiling sweep tripped on reservations still in flight/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /E7: the ceiling sweep tripped on a refusal recorded before the day of the ceiling began/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /K2: clearing the system global stop cleared or uncovered the owner/,
      },
      {
        file: "engine/db/workerDatabase.test.ts",
        marker:
          /sets a statement timeout and an idle-in-transaction timeout, transaction-locally, before the work/,
      },
      {
        file: "engine/worker/runWorker.test.ts",
        marker:
          /runs the ceiling check after the stale-run sweep, in its own transaction, as ops_worker/,
      },
      {
        file: "engine/worker/failures.test.ts",
        marker:
          /treats spend contention with calls in flight as transient, so the job retries on its backoff/,
      },
      {
        file: "engine/domain/spendAdmission.dbtest.ts",
        marker:
          /the second waits on the spend lock, then raises OS429 and records nothing/,
      },
      {
        file: "engine/domain/spendAdmission.dbtest.ts",
        marker: /lets only the admissible number of calls happen at once/,
      },
      {
        file: "engine/domain/spendRefusals.dbtest.ts",
        marker:
          /records a start that settled spend cannot absorb as cancelled, refused, budget_exhausted naming the budget version, with no provider call/,
      },
      {
        file: "engine/domain/idleTransaction.dbtest.ts",
        marker:
          /is ended by the server, lets the admission waiting on its lock proceed in bounded time/,
      },
      {
        file: "engine/domain/spendCeilingInFlight.dbtest.ts",
        marker:
          /never trips the ceiling stop for a start refused only by contention/,
      },
      {
        file: "engine/domain/spendCeiling.dbtest.ts",
        marker: /keeps an owner's global stop as a separate row/,
      },
      {
        file: "engine/domain/executionStopOutcome.dbtest.ts",
        marker: /is recorded as its own stop and printed stopped/,
      },
      {
        file: "engine/domain/spendRefusals.dbtest.ts",
        marker: /as budget_exhausted, not as a contended retry/,
      },
      {
        file: "engine/domain/spendCeilingRace.dbtest.ts",
        marker:
          /record one system stop, and only the sweep whose own transaction recorded it answers with its id/,
      },
    ],
    caveat:
      "A call already in flight is never interrupted because a limit was crossed during it; its outcome is recorded and the next start sees the total. A run refused only by contention retries on its job's backoff and fails after five attempts. Tenant and company budgets refuse but never trip a stop. The global spend lock serialises every start fleet-wide. Erasing today's runs frees today's budget; erasure is an owner act. Agent and task budgets are not built.",
  },
  {
    id: "SI-37",
    statement:
      "There is one execution stop evaluator, and it holds work at the lease as well as before every external call: every job kind is classified external or internal and the worker refuses a registry that disagrees; no queued job whose kind is not internal is leased while an active stop covers it, and holding it consumes no attempt; a stop may name one external kind and never any other kind; organisational coordinates come only from facts fixed when the job was requested, and an unknown one fails closed within its tenant; and a stop found after the lease, by the runtime's pre-call check or by the handler's own start, returns the job to the queue with its attempt restored, keeps no durable start and calls nothing.",
    provenBy: ["live database", "migration assertion", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /W1: ops\.lease_job does not hold the kill-switch lock shared once it has read the stops/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /W6: ops\.job_execution_stop does not hold the kill-switch lock shared once it has read the stops/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /W7: ops\.defer_job does not hold the kill-switch lock shared once it has read the stops/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /a queued job an active stop covers was leased or spent an attempt/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /a job whose task has a department and an assignee/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /K5: a deferral did not return the job to the queue 30 seconds later with its attempt restored/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /K1 a raw kind stop on an internal kind/,
      },
      {
        file: "engine/worker/runOneJob.test.ts",
        marker:
          /discards the handler's durable start, defers the job, and never calls or settles when a stop covers it/,
      },
      {
        file: "engine/worker/runOneJob.test.ts",
        marker:
          /fails closed, rolling the prepare back with no call, when the stop check answers anything but one stop id or none/,
      },
      {
        file: "engine/worker/jobKinds.test.ts",
        marker:
          /refuses an external kind registered as a transactional handler, which the stop check would never hold before a call/,
      },
      {
        file: "engine/domain/killSwitchLease.dbtest.ts",
        marker:
          /stop with no attempt spent and no job event, and runs with exactly one provider call once the stop is cleared/,
      },
      {
        file: "engine/domain/killSwitchLease.dbtest.ts",
        marker: /the postmark ledger retention job purges under a global stop/,
      },
      {
        file: "engine/domain/externalCallDeferral.dbtest.ts",
        marker: /prepared, never called or settled, its attempt restored/,
      },
      {
        file: "engine/domain/externalCallDeferral.dbtest.ts",
        marker:
          /is held at the lease by a company stop in its own tenant, whose company it does not know/,
      },
      {
        file: "engine/domain/runtimeGovernanceMirrors.dbtest.ts",
        marker:
          /has the database's external and internal job kinds equal to EXTERNAL_JOB_KINDS and INTERNAL_JOB_KINDS/,
      },
      {
        // The ORDER, lock before read, needs two sessions.
        file: "engine/domain/killSwitchLease.dbtest.ts",
        marker:
          /waits for the trip to commit, then leases nothing the stop covers/,
      },
      {
        file: "engine/domain/preCallStopCheck.dbtest.ts",
        marker: /waits for the trip to commit, then defers the job it covers/,
      },
    ],
    caveat:
      "A stop does not interrupt a call already started. An agent run whose job was leased before the trip is still cancelled at start (SI-31); one not yet leased is held and runs once the stop is cleared. A job that no agent run or task names is covered only by global, tenant and kind stops unless an unknown coordinate matches within its tenant. The held-job scan costs a coordinate lookup per queued job only while an organisational stop is active. The owner can DISABLE TRIGGER, as for SI-22.",
  },
  {
    id: "SI-38",
    statement:
      "The domain creates that integrations will retry are idempotent: ops.create_task and ops.record_event, given a tenant-scoped key, return the row the same semantic request created with no second row or fact, refuse a different request under that key, and converge under concurrency; the request fingerprint is derived by the database from the stored row, independent of the session time zone, and fixed once stored.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /I1: replaying a task create stored a second task or a second task\.created fact/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /I2: % conflicting creates ran \(expected 11\), or one stored a task/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /I5: a raw insert with a key and no fingerprint was not given one/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /I6: replica mode silenced tasks_request_identity_update; the guard must be ENABLE ALWAYS/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker:
          /I7: the request fingerprint changed with the session time zone/,
      },
      {
        file: "supabase/tests/runtime_governance.sql",
        marker: /I9: replaying an event recorded a second fact/,
      },
      {
        file: "engine/domain/companyOs.test.ts",
        marker:
          /forwards a task's idempotency key as the thirteenth and last argument of ops\.create_task/,
      },
      {
        file: "engine/domain/domainIdempotency.dbtest.ts",
        marker:
          /converge on one task and one task\.created fact when the requests match, the second waiting for the first to commit/,
      },
      {
        file: "engine/domain/domainIdempotency.dbtest.ts",
        marker: /converge on one event when the facts match/,
      },
    ],
    caveat:
      "The key is optional: a caller without one keeps the non-deduplicated create, and the future wrapper contract (ADR 0015 §4) must require one from every integration. create_company, create_department and create_agent refuse a retry through their slug keys instead of returning the row. The caller-declared correlation_id residual (PHASE_1C_REPORT Appendix A item 7) is still open, and correlation is not part of either fingerprint.",
  },
  {
    id: "SI-39",
    statement:
      "The operator view is read-only by default and backend-only: its read commands run inside read-only transactions over the owner connection, it reads no environment variable but ADMIN_DATABASE_URL and never a provider key or a routing variable, it never prints a result, prompt, task or agent text, idempotency key or connection string, it withholds any key-shaped value a worker published, and its only acts are recording a price version and setting or retiring a spend limit.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        file: "engine/cli/operator.test.ts",
        marker:
          /reads only ADMIN_DATABASE_URL from its environment, never a provider key or a model routing variable/,
      },
      {
        file: "engine/cli/operator.test.ts",
        marker: /in a read-only transaction/,
      },
      {
        file: "engine/domain/runtimeReadModelRoutes.test.ts",
        marker:
          /never prints a key-shaped model id or worker id that a worker published/,
      },
      {
        file: "engine/domain/executionStops.test.ts",
        marker:
          /decides that this act recorded the stop by the transaction clock/,
      },
      {
        file: "engine/domain/operatorReadOnly.dbtest.ts",
        marker: /with SQLSTATE 25006/,
      },
      {
        file: "engine/domain/operatorRuntime.dbtest.ts",
        marker:
          /prints no task or agent text, result, idempotency key or connection string/,
      },
    ],
    caveat:
      "It is an owner tool: anyone holding ADMIN_DATABASE_URL can do more than it offers. Its lists are bounded (runs 200, prices and limits 500, workers 50) and only the held-job count reports hitting its cap. Worker routes are what each worker published at boot, not a live read of its environment.",
  },
  {
    id: "SI-40",
    statement:
      "No hosted Supabase deploy runs before the live-database suites pass on the commit it ships, in the same workflow run: every workflow job that can reach a hosted project, by a hosted command, a credential or a machine GitHub does not host, has no job-level condition, directly needs a plain call of .github/workflows/database.yml, deploys the tree it checked out and runs only on push or workflow_dispatch; database.yml is exactly the reviewed job, running test:db, test:db:engine, the upgrade replay over legacy data, a migrations-only replay with the reference data check and a clean reconstruction followed by test:db, in that order, with nothing that can skip, change or replace a suite; and check.yml calls the same definition and runs no copy of it.",
    provenBy: ["static guard", "unit test", "live database"],
    enforcedBy: [
      {
        file: "scripts/production-scope-database-gate.mjs",
        marker:
          /export const DATABASE_GATE_RULE = "deploy-without-database-gate"/,
      },
      {
        file: "scripts/production-scope.mjs",
        marker:
          /violations = \[\.\.\.checkProductionScope\(files\), \.\.\.checkDeployGate\(files\)\]/,
      },
      {
        file: "scripts/test/production-scope-database-gate.test.mjs",
        marker:
          /refuses a hosted deploy that does not directly wait for a plain call of the gate/,
      },
      {
        file: "scripts/test/production-scope-database-gate.test.mjs",
        marker:
          /refuses a database gate that can pass without running every suite/,
      },
      {
        file: "scripts/test/production-scope-database-gate.test.mjs",
        marker:
          /refuses a broken gate from the command line deploy-supabase runs/,
      },
      {
        file: ".github/workflows/deploy.yml",
        marker: /^\s*needs: \[gate, database\]\s*$/m,
      },
      {
        file: ".github/workflows/deploy.yml",
        marker: /^\s*uses: \.\/\.github\/workflows\/database\.yml\s*$/m,
      },
      {
        file: ".github/workflows/database.yml",
        marker: /^\s*workflow_call:\s*$/m,
      },
      {
        file: ".github/workflows/database.yml",
        marker: /^\s*run: npm run test:db:upgrade -- --workdir \.\s*$/m,
      },
      {
        file: ".github/workflows/check.yml",
        marker: /^\s*uses: \.\/\.github\/workflows\/database\.yml\s*$/m,
      },
    ],
    caveat:
      "The workflows are proven by reading them; GitHub has run neither until the owner pushes. The guard is line-based and refuses what it cannot read, but it does not follow an npm or node script, a third-party action's code or a credential held in a configuration variable. The makefile's deploy target, run by a person, is not gated by the live suites (SI-03's caveat). Branch protection is repository configuration, and check.yml's database check is now reported under its caller's name.",
  },
  {
    id: "SI-41",
    statement:
      "No application role can make a CRM owner, and no upgrade makes one on trust: the signup trigger writes only operators, whatever the user metadata says; the only path outside the application is public.bootstrap_owner, which no application role can execute, which runs only at READ COMMITTED under a lock on sales held until commit, only while no active owner exists, and only for an enabled CRM user whose auth account is confirmed, unbanned and not deleted, and which sets both owner columns and records the act; an upgrade that finds an active legacy administrator and no active owner halts until a person runs it, and every remaining administrator without the owner role then becomes a recorded operator; and is_admin() requires the owner role, the administrator flag and an enabled row.",
    provenBy: ["live database", "migration assertion", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker: /can execute public\.bootstrap_owner/,
      },
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker:
          /bootstrap_owner does not hold SHARE ROW EXCLUSIVE on public\.sales until commit/,
      },
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker: /ran at REPEATABLE READ instead of refusing it first/,
      },
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker: /an active owner already exists%/,
      },
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker:
          /is_admin\(\) accepted administrator = true without role = owner/,
      },
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker: /is_admin\(\) accepted a disabled owner/,
      },
      {
        file: "supabase/tests/owner_provisioning.sql",
        marker: /handle_new_user trusted metadata that claims ownership/,
      },
      {
        file: "supabase/migrations/20260917180200_owner_bootstrap.sql",
        marker: /lock table public\.sales in share row exclusive mode;/,
      },
      {
        file: "supabase/migrations/20260917180200_owner_bootstrap.sql",
        marker:
          /revoke all on function public\.bootstrap_owner\(uuid, text, text\) from public, anon, authenticated, service_role;/,
      },
      {
        file: "supabase/migrations/20260917180300_legacy_administrators_upgrade_guard.sql",
        marker: /upgrade halted: active administrator\(s\)/,
      },
      {
        file: "supabase/migrations/20260917180300_legacy_administrators_upgrade_guard.sql",
        marker: /are still administrators without the owner role/,
      },
      {
        file: "supabase/tests/upgrade/upgrade_assertions.sql",
        marker: /the upgrade created % owners, expected the 1 a person chose/,
      },
      {
        file: "supabase/tests/upgrade/halted_assertions.sql",
        marker: /an owner exists before any person chose one/,
      },
      {
        file: "supabase/tests/referenceData.mjs",
        marker:
          /no CRM owner or administrator: a person bootstraps the first one/,
      },
      {
        file: "scripts/test/run-db-upgrade-test.test.mjs",
        marker: /the owner guard halt is the only accepted halt/,
      },
    ],
    caveat:
      "Whoever holds the database credential can do anything, and once every owner is disabled the bootstrap works again (break glass); the function makes that act explicit, checked and recorded. In-app promotions by an owner write no log row. The users edge function still creates an administrator without the owner role when it reuses an existing auth account, and still lets such a row edit other users' auth email and ban state (SECURITY.md, patchUser); e2e fixtures create the same half state.",
  },
  {
    id: "SI-42",
    statement:
      "Every contact has exactly one lead profile, so its do_not_contact opt-out can always be recorded by an application user who may access the contact and never by one who may not: new contacts get one from their insert trigger, contacts that predate lead profiles get one from an idempotent backfill that never changes an existing profile, and an upgrade replay over legacy data proves it.",
    provenBy: ["live database", "migration assertion", "unit test"],
    enforcedBy: [
      {
        file: "supabase/tests/crm_data_invariants.sql",
        marker: /contacts without exactly one lead profile/,
      },
      {
        file: "supabase/tests/crm_data_invariants.sql",
        marker:
          /create_lead_profile_after_contact_insert is missing or not enabled/,
      },
      {
        file: "supabase/migrations/20260917180100_backfill_legacy_lead_profiles.sql",
        marker: /still have no lead profile after the legacy backfill/,
      },
      {
        file: "supabase/tests/upgrade/upgrade_assertions.sql",
        marker:
          /the operator cannot record do_not_contact for their own legacy contact/,
      },
      {
        file: "supabase/tests/upgrade/upgrade_assertions.sql",
        marker:
          /the operator changed the consent flag of a contact they do not own/,
      },
      {
        file: "supabase/tests/rls_tenant_isolation.sql",
        marker: /do_not_contact consent flag/,
      },
      {
        file: "scripts/run-db-upgrade-test.mjs",
        marker: /"20260917180100_backfill_legacy_lead_profiles\.sql"/,
      },
    ],
    caveat:
      "A backfilled profile starts with do_not_contact false: the legacy schema had no opt-out field, and an opt-out recorded only in notes or tags cannot be read by a migration. A restore run with triggers disabled can break the invariant again; crm_data_invariants.sql is where that shows. The SQL function public.merge_contacts, unlike the edge function, still deletes the loser without folding its profile (SI-09 covers the edge function).",
  },
  {
    id: "SI-43",
    statement:
      "An inbound message becomes work at most once. The admission identity is (tenant, source kind, external message id), and the task and the agent run are created under that same tenant-scoped key, so a redelivery converges on the one task and the one run and calls a provider no second time; the same identity carrying a different message is refused rather than answered.",
    provenBy: ["live database", "driver-backed test"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260917190000_lead_triage_pilot.sql",
        marker: /that message id was already admitted with a different message/,
      },
      {
        file: "supabase/migrations/20260917190000_lead_triage_pilot.sql",
        marker: /constraint inbound_messages_identity_key unique/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /A2: a redelivery created more work/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /B1: a reused message id with a different body was admitted/,
      },
      {
        file: "engine/domain/leadTriagePilot.dbtest.ts",
        marker: /is admitted once and calls the provider once/,
      },
    ],
    caveat:
      "Identity is what the transport reports. A transport that reuses an id for a genuinely different message makes the second one a conflict, not a second admission — which is the fail-closed direction, and the reason the fingerprint covers the sender and the body. A redelivery arriving while the first admission is still uncommitted waits on its row lock and then converges.",
  },
  {
    id: "SI-44",
    statement:
      "The synthetic ingress admits only synthetic messages, and only in a process that was explicitly told to admit them: ops.admit_inbound_message refuses every other source kind, and the transport does not exist unless COMPANY_OS_SYNTHETIC_INGRESS is exactly 'enabled'. No HTTP route, edge function or webhook reaches the synthetic ingress at all. A real message reaches the database only through the WhatsApp gateway, on the terms of SI-46 and SI-47.",
    provenBy: ["live database", "unit test"],
    enforcedBy: [
      {
        // Phase 2B redefines the synthetic service; it still refuses every
        // other source kind, which now has its own path (SI-46, SI-47).
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /only synthetic messages are admitted through this service/,
      },
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /constraint inbound_messages_source_kind_check/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /C4: a non-synthetic transport was admitted in Phase 2A/,
      },
      {
        file: "engine/communication/syntheticIngress.test.ts",
        marker: /stays off when the flag is/,
      },
      {
        file: "engine/communication/syntheticIngress.test.ts",
        marker: /is off when the flag is absent/,
      },
      {
        // "No edge function reaches it": an edge function importing anything
        // outside supabase/functions, engine/ included, is refused.
        file: "scripts/production-scope.mjs",
        marker: /"function-imports-outside-functions"/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /G5: an application role reached the pilot/,
      },
    ],
    caveat:
      "Whoever holds the database credential can insert a row directly, and whoever runs the process can set the variable; this keeps the synthetic ingress from being reached by accident or by configuration drift, not from a deliberate act. The WhatsApp transport Phase 2B adds is a separate path with its own gate (SI-47): while Q8 is open it admits work only on a channel configured test.",
  },
  {
    id: "SI-45",
    statement:
      "A model's answer never acts. A lead triage result opens a human review item, derived by the database from a run that SUCCEEDED and never written by the worker, and opened only AFTER the run's settlement has committed, in a transaction of its own, so no failure to open it (an error, a lock wait, a statement timeout or a cancellation) can undo the settlement: the paid answer is kept, nothing can call the provider again, and the review is recovered from the stored result. A person's decision is recorded once and is final. Accepting is refused unless a TRUSTED consent source said the lead may be contacted: consent never comes from the delivery, is inherited by every run on the admitted task, and is do-not-contact wherever no admission established it. Accepting performs no action: it creates no send and calls no provider, a reply leaves only by a separate, explicit operator send that reads consent again (SI-49), and no CRM write path exists.",
    provenBy: ["live database", "driver-backed test", "unit test"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260917190000_lead_triage_pilot.sql",
        marker:
          /this lead must not be contacted, so its draft cannot be accepted/,
      },
      {
        file: "supabase/migrations/20260917190000_lead_triage_pilot.sql",
        marker: /this item is already %s, and a decision is final/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /F8: a draft for a do-not-contact lead was accepted/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /F4: a decided item was decided again/,
      },
      {
        file: "engine/domain/leadTriagePilot.dbtest.ts",
        marker: /opens no review when the model answers outside its contract/,
      },
      {
        file: "engine/domain/leadTriagePilot.dbtest.ts",
        marker: /the draft can never be accepted/,
      },
      {
        file: "supabase/migrations/20260918120000_lead_triage_review_after_settlement.sql",
        marker:
          /a trigger on ops\.agent_runs opens a review inside the settlement/,
      },
      {
        file: "supabase/tests/lead_triage_pilot.sql",
        marker: /I1: a review is still opened inside the settlement/,
      },
      {
        file: "engine/domain/leadTriageSettlement.dbtest.ts",
        marker: /a paid answer whose review is cancelled while it opens/,
      },
      {
        file: "engine/domain/leadTriageSettlement.dbtest.ts",
        marker:
          /a paid answer whose review waits on a lock until the statement times out/,
      },
      {
        file: "engine/communication/syntheticIngress.test.ts",
        marker: /offers no way to send anything/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /accepting a review sends nothing: only the explicit send calls the provider/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /G1: a trigger creates or begins a send/,
      },
    ],
    caveat:
      "The review item is opened by the worker runtime's post-settlement step (ops.open_review_for_settled_job), in its own transaction after the settlement committed; if it fails, or the worker dies before it runs, the run stays settled and ops.open_missing_reviews (npm run ops -- triage recover) opens it later, and until then the answer waits unreviewed with only the worker's log line to say so. The database owner is outside it as it is outside every other guard. Consent is SNAPSHOTTED at admission for the decision: a later opt-out does not reach an admitted message's review. Phase 2B reads it again on the acting side (SI-49), so an accepted review whose lead opted out afterwards is refused at the send.",
  },
  {
    id: "SI-46",
    statement:
      "A WhatsApp delivery is acted on only when its X-Hub-Signature-256 is the HMAC-SHA256 of the exact raw bytes under the app secret, compared in constant time before the body is parsed, and the subscription handshake answers only the configured verify token. The tenant, company and agent come only from the ONE owner-configured channel for the provider target the delivery names, never from any other payload field; an unknown or inactive target admits nothing, and no tenant can configure a target another tenant holds. The gateway connects as a member of ops_gateway, which holds no table and executes exactly two functions.",
    provenBy: [
      "unit test",
      "live database",
      "driver-backed test",
      "static guard",
    ],
    enforcedBy: [
      {
        file: "engine/communication/whatsapp/metaWebhook.ts",
        marker: /timingSafeEqual\(provided, expected\)/,
      },
      {
        file: "engine/communication/whatsapp/metaWebhook.test.ts",
        marker:
          /refuses another secret, a changed body, and any malformed header/,
      },
      {
        file: "engine/communication/whatsapp/webhookGateway.test.ts",
        marker:
          /is refused with 401 and never parsed or stored without a valid signature/,
      },
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /unknown or inactive provider target/,
      },
      {
        file: "engine/domain/whatsappInbound.dbtest.ts",
        marker:
          /routes each target to its own tenant, and a payload field cannot pick another/,
      },
      {
        file: "engine/domain/whatsappInbound.dbtest.ts",
        marker:
          /refuses an unknown or inactive target without admitting anything/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /B1: another tenant took over a configured provider target/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /A3: ops_gateway executes more than its two functions/,
      },
      {
        file: "supabase/tests/company_domain_core.sql",
        marker: /\('ops_gateway',\s+'ops\.receive_whatsapp_message/,
      },
      {
        file: "supabase/invariants/rules.mjs",
        marker: /The internet-facing gateway holds no table privilege/,
      },
      {
        file: "engine/cli/whatsappGateway.ts",
        marker: /never the owner or service_role/,
      },
    ],
    caveat:
      "The app secret is the whole of authenticity: whoever holds it can sign any delivery, including one that names another configured target. The provider target is Meta's phone number id, which is not a secret; what binds it to a tenant is the owner's configuration. The gateway binds to loopback by default; TLS and the public name belong to a reverse proxy or tunnel in front of it, which this phase does not provide. It reads at most WEBHOOK_MAX_BODY_BYTES and answers 413 beyond that; there is no rate limit beyond the server's request timeouts.",
  },
  {
    id: "SI-47",
    statement:
      "While BASELINE Q8 is open, WhatsApp content becomes work, and a message is sent, only on a channel the owner configured test. Whether a channel is test or production is trusted owner configuration, never a payload field: a production channel's message is acknowledged and recorded as a held fact carrying no body, sender or ledger row, and the database refuses a transport admission row, a send, or the start of a send on any channel not configured test, to the owner's own statements too. Opening the gate is a reviewed migration after the owner decides Q8, never configuration.",
    provenBy: ["live database", "driver-backed test"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker:
          /BASELINE Q8 is open; only a channel configured test may admit a message as work/,
      },
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /BASELINE Q8 is open; only a channel configured test may send/,
      },
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker:
          /BASELINE Q8 is open; only an active channel configured test may send/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /C1: a production channel''s message was not held/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker:
          /C2: a production channel''s message was admitted by a direct insert/,
      },
      {
        file: "engine/domain/whatsappInbound.dbtest.ts",
        marker:
          /holds a message to a production target: no ledger row, no task, no run, only the fact/,
      },
    ],
    caveat:
      "A test channel is still a real WhatsApp number: 'test' is the owner's declaration that only synthetic or consenting test data flows through it, which the system cannot verify. A message to a test channel reaches an agent run, and so a model provider, exactly as a synthetic one does. The owner can DISABLE TRIGGER, as for SI-22. A held message is not stored, so it cannot be recovered after Q8 is decided, and Meta does not redeliver a message the gateway acknowledged.",
  },
  {
    id: "SI-48",
    statement:
      "The transport reads the CRM and never writes it. ops.crm_contact_by_phone answers found, not_found, ambiguous or unavailable from an exact match of the number's digits, only for the tenant that owns this deployment's CRM, and contains no write; an unknown number creates no contact, and no country code is guessed. It returns an opaque reference and the opt-out flag, never a name.",
    provenBy: ["live database", "driver-backed test"],
    enforcedBy: [
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /D6: the adapter changed the CRM/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /D7: the CRM adapter or the eligibility rule contains a write/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /D4: a tenant that does not own the CRM read it/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /D3: a number without its country code was matched/,
      },
      {
        file: "engine/domain/whatsappInbound.dbtest.ts",
        marker:
          /resolves found, not found and ambiguous without creating or changing a contact/,
      },
    ],
    caveat:
      "The match is exact on digits, so a contact whose number was stored without its country code is not found and cannot be replied to: the fail-closed direction, visible as contact_not_found. public.contacts is not tenant-scoped; one deployment's CRM belongs to the one tenant marked owns_local_crm, and every other tenant reads unavailable. A phone number is not proof of identity: two people sharing a number are ambiguous only when both are in the CRM.",
  },
  {
    id: "SI-49",
    statement:
      "A reply leaves only by an explicit operator send of one ACCEPTED review (npm run messaging -- send), a separate act after the decision; nothing sends on acceptance, on a model's answer or on a timer. The basis for a reply is the contact's own message within the last 24 hours, never do_not_contact = false on its own. It is checked afresh from the CRM when the send is requested and again immediately before the provider call, under the kill-switch lock: exactly one CRM contact for the number, an opt-out recorded and false, an active test channel, and no execution stop covering it. Anything else refuses the request or blocks the send.",
    provenBy: ["live database", "driver-backed test"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /only an accepted review can be sent/,
      },
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /ops\.request_outbound_send: refused: %s/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /accepting a review sends nothing: only the explicit send calls the provider/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /refuses a lead who opted out after admission, although the review was accepted/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /blocks a send whose consent changes between the request and the call/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker: /refuses a reply outside the 24-hour window the contact opened/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker: /refuses while an execution stop covers the tenant/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /G1: a trigger creates or begins a send/,
      },
    ],
    caveat:
      "Whether a service reply to a contact who wrote first is a lawful basis under LGPD is an owner decision this phase records and does not make; the rule runs on test channels only. The CRM holds only an opt-out, so a contact with no lead profile (consent_unknown) and an unknown number (contact_not_found) are refused. The check and the call are not atomic with the CRM: an opt-out recorded after the pre-call check and before the provider answers is not seen by that send. The 24-hour window is measured from when this system recorded the contact's last message, not by Meta's clock; a send near the edge that Meta refuses (131047) is recorded failed.",
  },
  {
    id: "SI-50",
    statement:
      "A send calls the provider at most once. The database moves it to sending, and commits that, before the one call; a send in flight, sent, failed or indeterminate can never be made sendable again, and a repeated or concurrent send answers with the same send. Only a provider answer that settles the outcome records failed; a 5xx, a timeout, a lost connection, an unreadable or oversize answer and a transport exception record indeterminate, and a send a crash left sending stays sending until an operator marks it indeterminate. No command, service or timer resends a message.",
    provenBy: ["live database", "driver-backed test", "unit test"],
    enforcedBy: [
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /a send cannot move from %s to %s/,
      },
      {
        file: "supabase/migrations/20260918150000_whatsapp_transport.sql",
        marker: /may still be in flight/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /E2: an indeterminate send was sent again/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /E2: a send in flight was made sendable again/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /E4: a second send of one review was stored/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker: /makes one call when several operators send at once/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /records an ambiguous outcome as indeterminate and never calls again/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker: /never calls again after a crash once the send was in flight/,
      },
      {
        file: "engine/communication/whatsapp/metaSender.test.ts",
        marker: /a 5xx is ambiguous: Meta may have taken the message/,
      },
      {
        file: "engine/domain/outboundSend.ts",
        marker: /errorClass: "transport_threw"/,
      },
      {
        file: "engine/cli/messaging.test.ts",
        marker: /offers no way to resend or retry a message/,
      },
    ],
    caveat:
      "At most once, not exactly once. Meta documents no idempotency key for the messages endpoint, so nothing below the database could deduplicate a second call; the durable sending state is the whole mechanism. A failed or indeterminate send is not retried at all in this phase: a person who wants to reply again needs a new review. A network error before any byte left (DNS, a refused connection) is recorded indeterminate too, because fetch does not distinguish it; a status callback or the operator resolves it.",
  },
  {
    id: "SI-51",
    statement:
      "A provider status moves only a send of the channel whose target reported it, and so only inside that channel's tenant: it matches the provider message id or, for a send whose outcome is unknown, the correlation this system sent AND the recipient of its conversation. A duplicate, an older status and an undocumented one change nothing, each step is recorded once, and delivery evidence wins over an earlier failure. A status never sends and never makes a send sendable again.",
    provenBy: ["live database", "driver-backed test"],
    enforcedBy: [
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /F2: another tenant''s target reached a send/,
      },
      {
        file: "supabase/tests/whatsapp_transport.sql",
        marker: /F3: an undocumented delivery state moved a send/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /moves a send forward, ignores duplicates and older news, and records one fact per step/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /resolves an indeterminate send only when the correlation AND the recipient match/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker: /cannot reach another tenant's send through its own target/,
      },
    ],
    caveat:
      "A status for a send this system does not know is acknowledged as unmatched and stored nowhere; played (voice) is acknowledged as unsupported. Status order comes from the provider's own ranking, not arrival time, so a late sent after delivered is ignored.",
  },
  {
    id: "SI-52",
    statement:
      "Message content lives in one place. An inbound body is stored only as its task's description, which is what an agent run reads, and a reply is read from its accepted review at the moment of sending and copied nowhere. No event, outbound row, gateway log line or messaging tool output carries a body, a draft, a sender's number or a secret, and the gateway logs counts and outcomes only.",
    provenBy: ["driver-backed test", "unit test"],
    enforcedBy: [
      {
        file: "engine/domain/whatsappInbound.dbtest.ts",
        marker: /records no body or sender in any event, and logs neither/,
      },
      {
        file: "engine/communication/whatsapp/webhookGateway.test.ts",
        marker:
          /is counts and outcomes: never a body, a sender, a secret or a signature/,
      },
      {
        file: "engine/domain/whatsappOutbound.dbtest.ts",
        marker:
          /links the send to the inbound conversation and holds no text or recipient/,
      },
      {
        file: "engine/cli/messaging.test.ts",
        marker:
          /prints neither the access token nor the database password when the database refuses/,
      },
      {
        file: "engine/cli/whatsappGateway.test.ts",
        marker:
          /names the missing variable and never prints a value it was given/,
      },
    ],
    caveat:
      "The sender's WhatsApp id, a phone number, is stored as contact_ref in the admission ledger and the conversation, because a reply needs it; the body is in ops.tasks.description, readable by the owner and sent to the model provider by an agent run. Neither has a retention or erasure rule yet: both are owner decisions to make before Q8.",
  },
];

describe("every security invariant still has a live enforcement point", () => {
  it.each(INVARIANTS.map((i) => [i.id, i] as const))(
    "%s is enforced somewhere that actually runs",
    (_id, invariant) => {
      expect(
        invariant.enforcedBy.length,
        `${invariant.id} claims no enforcement point; an invariant nothing checks is prose`,
      ).toBeGreaterThan(0);

      for (const { file, marker } of invariant.enforcedBy) {
        const path = join(ROOT, file);
        expect(existsSync(path), `${invariant.id}: missing ${file}`).toBe(true);
        expect(
          readFileSync(path, "utf8"),
          `${invariant.id}: ${file} no longer contains ${marker} — the guard for this invariant was removed or renamed`,
        ).toMatch(marker);
      }
    },
  );

  it("declares how each invariant is proven", () => {
    for (const invariant of INVARIANTS) {
      expect(
        invariant.provenBy.length,
        `${invariant.id} does not say how it is proven`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps at least one invariant proven against a live database", () => {
    // If this ever reaches zero, every guarantee below has become static text
    // analysis — which is exactly the posture this phase was trying to leave.
    const live = INVARIANTS.filter((i) => i.provenBy.includes("live database"));
    expect(live.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the ADR index cannot drift from the ADRs", () => {
  // Not a security invariant, but the same failure mode and it bit this change:
  // the Phase 1 handoff was drafted claiming two ADRs were Accepted that are
  // still Proposed. A handoff that misstates which decisions are settled is how
  // a future session builds on an unapproved foundation.
  const ADR_DIR = join(ROOT, "docs", "adr");
  const decisions = readFileSync(join(ROOT, "docs", "DECISIONS.md"), "utf8");
  const adrFiles = readdirSync(ADR_DIR)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort();

  it("indexes every ADR file", () => {
    const unindexed = adrFiles.filter((f) => !decisions.includes(f));
    expect(unindexed).toEqual([]);
  });

  it("agrees with each ADR on whether it is Accepted", () => {
    const disagreements: string[] = [];
    for (const file of adrFiles) {
      const adr = readFileSync(join(ADR_DIR, file), "utf8");
      const accepted = /\*\*Status:\*\*\s*\**\s*Accepted/.test(adr);
      const row = decisions
        .split("\n")
        .find((line) => line.includes(file) && line.startsWith("|"));
      if (!row) continue; // covered by the test above
      // `| # | Decision | Status | Reversal cost |` -> split gives a leading and
      // trailing empty cell, so the status column is index 3. A row that does
      // not have that shape is a failure, not something to skip.
      const cells = row.split("|");
      if (cells.length < 5) {
        disagreements.push(`${file}: malformed row in DECISIONS.md`);
        continue;
      }
      const indexedAccepted = /Accepted/.test(cells[3]);
      if (accepted !== indexedAccepted) {
        disagreements.push(
          `${file}: the ADR says ${accepted ? "Accepted" : "not Accepted"}, DECISIONS.md's status column says ${indexedAccepted ? "Accepted" : "not Accepted"}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe("the published index cannot drift from the code", () => {
  const doc = existsSync(DOC_PATH) ? readFileSync(DOC_PATH, "utf8") : "";

  it("exists", () => {
    expect(existsSync(DOC_PATH), `missing: ${DOC_PATH}`).toBe(true);
  });

  it("lists exactly the invariants this file defines", () => {
    const documented = [...doc.matchAll(/^\|\s*(SI-\d+)\s*\|/gm)].map(
      (m) => m[1],
    );
    expect(documented).toEqual(INVARIANTS.map((i) => i.id));
  });

  it("states each invariant the same way the code does", () => {
    // Catches the drift where the doc is softened or a caveat is dropped while
    // the executable list still claims the stronger property.
    for (const invariant of INVARIANTS) {
      const row = doc
        .split("\n")
        .find((line) => line.startsWith(`| ${invariant.id} `));
      expect(row, `${invariant.id} has no row in the document`).toBeDefined();
      expect(
        row,
        `${invariant.id}'s wording differs between the code and the document`,
      ).toContain(invariant.statement);
    }
  });

  it("names the generated-migration hazard explicitly", () => {
    expect(doc).toMatch(
      /DECLARATIVE SCHEMA != automatically trusted migration output/,
    );
  });
});
