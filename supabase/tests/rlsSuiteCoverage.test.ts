// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The real RLS assertions live in `rls_tenant_isolation.sql` and need a running
// Postgres, so they run via `npm run test:db`, not here. This file is the guard
// that runs EVERYWHERE, including CI with no Docker: it verifies the suite still
// exists and still covers each property Phase 0.5C requires.
//
// Why a static guard is worth having: the database suite is invisible to the
// default test run, so deleting it, or quietly gutting one of its blocks, would
// turn a security guarantee off without turning anything red. This file turns
// that into a failing test.
//
// It deliberately does NOT try to parse SQL or prove the assertions are correct
// -- only that each required property is still asserted somewhere. Correctness
// is established by running the suite against a database and by the mutation
// testing recorded in docs/PHASE_0_5_REPORT.md.

const SUITE_PATH = join(
  process.cwd(),
  "supabase",
  "tests",
  "rls_tenant_isolation.sql",
);
const RUNNER_PATH = join(process.cwd(), "scripts", "run-db-tests.mjs");

const suite = existsSync(SUITE_PATH) ? readFileSync(SUITE_PATH, "utf8") : "";

describe("the database RLS suite is present and wired", () => {
  it("exists", () => {
    expect(existsSync(SUITE_PATH), `missing: ${SUITE_PATH}`).toBe(true);
    expect(suite.length).toBeGreaterThan(1000);
  });

  it("has a runner that fails closed when no database is reachable", () => {
    expect(existsSync(RUNNER_PATH), `missing: ${RUNNER_PATH}`).toBe(true);
    const runner = readFileSync(RUNNER_PATH, "utf8");
    // The runner must exit non-zero rather than pass when it cannot connect.
    expect(runner).toMatch(/process\.exit\(1\)/);
    expect(runner).toMatch(/not a skip/i);
  });

  it("is reachable through an npm script", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    );
    expect(pkg.scripts["test:db"]).toBe("node ./scripts/run-db-tests.mjs");
  });

  it("leaves the database as it found it", () => {
    // Fixtures are created and rolled back; a suite that committed them would
    // pollute the database it is asserting against.
    expect(suite).toMatch(/^begin;/m);
    expect(suite).toMatch(/^rollback;/m);
  });
});

describe("every property Phase 0.5C requires is still asserted", () => {
  // Each entry is [what the brief asked for, a marker that must survive].
  const required: Array<[string, RegExp]> = [
    ["anon is denied", /anon reached %/],
    [
      "tenant A cannot READ tenant B",
      /operator A can read operator B'+s contact through the base table/,
    ],
    [
      "the view applies the caller's RLS",
      /the view is not applying the caller'+s RLS/,
    ],
    [
      "tenant A cannot UPDATE tenant B",
      /operator A updated % of operator B'+s contact rows/,
    ],
    [
      "tenant A cannot DELETE tenant B",
      /operator A deleted % of operator B'+s contact rows/,
    ],
    [
      "tenant A cannot INSERT into tenant B",
      /operator A inserted a contact owned by operator B/,
    ],
    [
      "an UNQUALIFIED update is scoped",
      /an UNQUALIFIED update by operator A rewrote/,
    ],
    [
      "an UNQUALIFIED delete is scoped",
      /an UNQUALIFIED delete by operator A removed/,
    ],
    ["missing context fails closed", /missing context must fail closed/],
    ["an unknown JWT fails closed", /a JWT with no matching sales row read/],
    ["a disabled user fails closed", /a DISABLED sales user read/],
    ["the consent flag is scoped", /do_not_contact consent flag/],
    [
      "service_role is characterised as a bypass",
      /service_role saw % of % contacts/,
    ],
    ["anon holds no grant in public", /anon holds privileges in schema public/],
    [
      "authenticated holds no RLS-defeating grant",
      /authenticated holds RLS-defeating privileges/,
    ],
    ["RLS is on for every base table", /have RLS disabled/],
    [
      "the database is not an egress channel",
      /the database is an egress channel/,
    ],
  ];

  it.each(required)("still asserts: %s", (_label, marker) => {
    expect(suite).toMatch(marker);
  });

  it("states that service_role is NOT a tenant-security mechanism", () => {
    // This one is prose, not an assertion, and it is load-bearing: a green RLS
    // suite must not be read as evidence that background workers are isolated.
    expect(suite).toMatch(/tenant-isolation mechanism/);
    expect(suite).toMatch(/ADR 0012/);
  });
});
