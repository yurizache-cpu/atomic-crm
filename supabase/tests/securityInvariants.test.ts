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
        file: "engine/worker/runOneJob.ts",
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
      "Company OS data is backend-only: no application role (anon, authenticated, service_role, ops_worker) holds any privilege on a Company OS table or function, no ops function is executable by PUBLIC, and every Company OS function is SECURITY INVOKER.",
    provenBy: [
      "live database",
      "migration assertion",
      "static guard",
      "unit test",
    ],
    enforcedBy: [
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
      "A task can request execution only for an allowlisted job kind — none in Phase 1C — and the job's tenant is the task row's, never the payload's; a task never adopts a job it did not request, and a cross-tenant task/job link cannot be stored.",
    provenBy: ["live database", "migration assertion"],
    enforcedBy: [
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
      "The only registered handler, postmark.ledger_retention, is tenant-wide CRM maintenance, so it is deliberately NOT task-executable: a company-scoped task must not be able to trigger it. The bridge's success path is proven through an allowlist replaced inside a rolled-back transaction. Settling a job never changes a task.",
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
        file: ".github/workflows/check.yml",
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
