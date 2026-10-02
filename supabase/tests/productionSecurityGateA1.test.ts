// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// PRODUCTION SECURITY GATE A.1, as a static guard (no Docker). The live proof is
// tests/crm_assurance.sql; this file proves what text can: that the repository
// carries no automatic third-party avatar or favicon lookup, that the
// declarative schema and the migration say the same thing about the two
// row-security roots and about the function grants, that no migration ships the
// non-production assurance exemption, and that every CRM row policy decides
// through the helpers whose roots carry the assurance rule.

const ROOT = process.cwd();
const read = (path: string) =>
  readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");

/** SQL with its comments removed, so prose about a name is not a use of it. */
const stripSqlComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
/** A migration's SQL, comments removed. */
const readMigration = (file: string) =>
  stripSqlComments(
    readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(/\r\n/g, "\n"),
  );
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const A1 = "20261005120000_production_security_gate_a1.sql";

const ENRICHMENT_FUNCTIONS = [
  "get_avatar_for_email",
  "get_domain_favicon",
  "handle_contact_saved",
  "handle_company_saved",
] as const;

describe("no automatic third-party avatar or favicon enrichment (Gate A.1)", () => {
  it("has a migration that drops all four functions, the two triggers going with theirs", () => {
    expect(migrationFiles).toContain(A1);
    const sql = readMigration(A1);
    for (const name of ENRICHMENT_FUNCTIONS) {
      expect(sql, `${name} is not dropped`).toMatch(
        new RegExp(`drop function if exists public\\.${name}\\(`),
      );
    }
    // The two stamping functions are dropped with CASCADE, which removes the
    // triggers that call them; tests/crm_assurance.sql A2 pins what remains.
    for (const name of ["handle_company_saved", "handle_contact_saved"]) {
      expect(sql).toMatch(
        new RegExp(`drop function if exists public\\.${name}\\(\\) cascade;`),
      );
    }
  });

  it("re-creates none of them in any later migration", () => {
    for (const file of migrationFiles.filter((f) => f > A1)) {
      const sql = readMigration(file);
      for (const name of ENRICHMENT_FUNCTIONS) {
        expect(sql, `${file} names ${name}`).not.toContain(name);
      }
      expect(sql, `${file} installs an enrichment trigger`).not.toMatch(
        /create (or replace )?trigger\s+("20_contact_saved"|company_saved)\b/i,
      );
    }
  });

  it("keeps the declarative schema free of them: no function, trigger or grant", () => {
    for (const file of [
      "supabase/schemas/02_functions.sql",
      "supabase/schemas/04_triggers.sql",
      "supabase/schemas/06_grants.sql",
    ]) {
      const sql = stripSqlComments(read(file));
      for (const name of ENRICHMENT_FUNCTIONS) {
        expect(sql, `${file} names ${name}`).not.toContain(name);
      }
      expect(sql, `${file} names a trigger of the enrichment`).not.toMatch(
        /"?(20_contact_saved|company_saved)"?/,
      );
    }
  });

  it("names no third-party avatar or favicon host in application, function or schema source", () => {
    const roots = [
      "src",
      "engine",
      "contracts",
      "supabase/functions",
      "supabase/schemas",
      "scripts",
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), {
        withFileTypes: true,
      })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "__screenshots__")
            continue;
          walk(path);
        } else if (
          /\.(ts|tsx|mjs|js|sql)$/.test(entry.name) &&
          !/\.(test|dbtest)\.[cm]?[jt]sx?$/.test(entry.name)
        ) {
          if (/gravatar\.com|favicon\.show/i.test(read(path)))
            offenders.push(path);
        }
      }
    };
    for (const dir of roots) if (existsSync(join(ROOT, dir))) walk(dir);
    expect(offenders).toEqual([]);
  });

  // Upstream's anonymous usage beacon (an image request to a marmelab.com
  // host) fires from <CRM> unless disableTelemetry is set. The CSP blocks it,
  // measured on staging 2026-10-01, but the application must not attempt it.
  it("switches off the upstream usage beacon wherever the application renders the CRM", () => {
    const rendered = read("src/App.tsx")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join("\n")
      .match(/<CRM\b[^>]*>/g);
    expect(rendered?.length).toBeGreaterThan(0);
    for (const element of rendered ?? []) {
      expect(element).toMatch(/\bdisableTelemetry\b(?!\s*=\s*\{\s*false)/);
    }
  });
});

describe("the declarative schema and the migration agree (Gate A.1)", () => {
  const bodyOf = (sql: string, name: string) => {
    const header = 'create or replace function "public"."' + name + '"()';
    const start = sql.toLowerCase().indexOf(header);
    expect(start, name + " is not defined").toBeGreaterThanOrEqual(0);
    const open = sql.indexOf("$$", start);
    const close = sql.indexOf("$$", open + 2);
    return squash(sql.slice(open + 2, close));
  };

  it.each(["current_sales_id", "is_admin"])(
    "defines %s with the same body, and that body requires the assurance rule",
    (name) => {
      const declared = bodyOf(read("supabase/schemas/02_functions.sql"), name);
      const migrated = bodyOf(readMigration(A1), name);
      expect(declared).toBe(migrated);
      expect(declared).toContain("ops.session_assurance_satisfied()");
    },
  );

  it("grants authenticated exactly the six row-security helpers, and nothing else in public", () => {
    const grants = [
      ...stripSqlComments(read("supabase/schemas/06_grants.sql")).matchAll(
        /grant execute on function public\.(\w+)\(([^)]*)\) to authenticated/gi,
      ),
    ].map(([, name, args]) => `${name}(${args.trim()})`);
    expect(grants.sort()).toEqual(
      [
        "can_access_contact(bigint)",
        "can_access_deal(bigint)",
        "can_manage_sales_id(bigint)",
        "current_sales_id()",
        "is_active_sales_user()",
        "is_admin()",
      ].sort(),
    );
  });
});

describe("the non-production assurance exemption never ships (Gate A.1)", () => {
  it("is inserted by no migration", () => {
    for (const file of migrationFiles) {
      const sql = readMigration(file);
      expect(sql, `${file} inserts the exemption`).not.toMatch(
        /insert\s+into\s+ops\.operator_assurance_exemption/i,
      );
    }
  });

  it("has exactly one assurance predicate, called by exactly the two row-security roots", () => {
    const definers = migrationFiles.filter((file) =>
      /create or replace function ops\.session_assurance_satisfied\(/i.test(
        readMigration(file),
      ),
    );
    expect(definers).toEqual([A1]);
    const callers = migrationFiles.filter((file) =>
      /ops\.session_assurance_satisfied\(\)/.test(readMigration(file)),
    );
    expect(callers).toEqual([A1]);
    const declared = stripSqlComments(
      read("supabase/schemas/02_functions.sql"),
    );
    expect(
      declared.match(/ops\.session_assurance_satisfied\(\)/g),
    ).toHaveLength(2);
  });
});

describe("every CRM row policy decides through the assured helpers (Gate A.1)", () => {
  const policies = stripSqlComments(read("supabase/schemas/05_policies.sql"))
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter((statement) => /^create policy/i.test(statement));

  it("finds the policies", () => {
    expect(policies.length).toBeGreaterThan(40);
  });

  it.each(policies.map((statement) => [statement.split('"')[1], statement]))(
    "%s calls a row-security helper",
    (_name, statement) => {
      expect(statement).toMatch(
        /public\.(is_active_sales_user|is_admin|can_manage_sales_id|can_access_contact|can_access_deal|current_sales_id)\(/,
      );
    },
  );

  it("grants the browser role no policy-free table: every granted table has row security enabled", () => {
    const rls = stripSqlComments(read("supabase/schemas/05_policies.sql"));
    const grants = stripSqlComments(read("supabase/schemas/06_grants.sql"));
    const tables = [
      ...grants.matchAll(
        /grant [a-z, ]+ on table public\.(\w+) to authenticated/gi,
      ),
    ]
      .map(([, table]) => table)
      // The three views are security_invoker (SI-01), so they inherit.
      .filter(
        (table) =>
          !["activity_log", "companies_summary", "contacts_summary"].includes(
            table,
          ),
      );
    for (const table of tables) {
      expect(rls, `${table} has no row security`).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`),
      );
    }
  });
});

describe("the owner-session channel forwards the verified session (Gate A.1)", () => {
  it("sets the request claims from bound parameters inside the transaction", () => {
    const db = read("supabase/functions/_shared/db.ts");
    expect(db).toMatch(/set_config\('request\.jwt\.claims', \$1, true\)/);
    // The claims are built from the verified values, never spliced into SQL.
    expect(db).toMatch(
      /JSON\.stringify\(\{[\s\S]*session_id: session\.sessionId/,
    );
  });

  it("gives merge_contacts the verified token's session, and the users function a caller-scoped read", () => {
    const merge = read("supabase/functions/merge_contacts/index.ts");
    expect(merge).toMatch(/await getVerifiedSession\(req\)/);
    expect(merge).toMatch(/return await runAsUser\(\s*userId,/);
    const users = read("supabase/functions/users/index.ts");
    expect(users).toMatch(/await getCallerSale\(req, user\)/);
    expect(users).not.toMatch(/\bgetUserSale\(/);
    const shared = read("supabase/functions/_shared/getUserSale.ts");
    expect(shared).toMatch(
      /Authorization: req\.headers\.get\("Authorization"\)/,
    );
    expect(shared).not.toMatch(/supabaseAdmin|SERVICE_ROLE/);
  });
});
