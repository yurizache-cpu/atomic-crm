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
      "Arbitrary SQL is not a capability any agent receives. The MCP query/mutate path is development tooling, explicitly outside the production trust boundary.",
    provenBy: ["unit test"],
    enforcedBy: [
      {
        file: "docs/adr/0011-mcp-trust-boundary.md",
        marker: /No AI agent receives arbitrary SQL execution/i,
      },
      {
        file: "supabase/functions/mcp/validateSql.test.ts",
        marker: /describe\(/,
      },
    ],
    caveat:
      "This is an architectural decision backed by a validator, not a mechanism. The validator is defence in depth; the boundary is not shipping the tool.",
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
      "ACCEPTED RISK today: the edge functions DO run as service_role. Both suites assert the bypass explicitly so a green RLS run cannot be mistaken for worker isolation. Closing it is ADR 0012's integration work.",
  },
  {
    id: "SI-07",
    statement:
      "The SQL read path is read-only in the database itself, not only in the parser.",
    provenBy: ["unit test"],
    enforcedBy: [
      {
        file: "supabase/functions/mcp/index.ts",
        marker: /SET TRANSACTION READ ONLY/,
      },
    ],
    caveat:
      "It does not constrain side effects that are not writes — that is why SI-02 exists.",
  },
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
    ],
    caveat:
      "Measured: a worker CAN set any GUC (set_config is executable by PUBLIC), so a bare app.tenant_id would make tenancy an assertion by the worker. Binding it to the lease means the job PAYLOAD -- where LLM output arrives in Phase 1B -- can never influence it. Against a fully malicious worker PROCESS the bound is ops_worker's grants, not one tenant.",
  },
  {
    id: "SI-15",
    statement:
      "The ops schema is unreachable by anon and authenticated, and is absent from the PostgREST allowlist.",
    provenBy: ["migration assertion", "static guard"],
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
    ],
    caveat:
      "The allowlist governs one channel. A direct libpq connection ignores it -- see ADR 0011.",
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
