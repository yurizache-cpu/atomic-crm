// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `registry.json` is PUBLISHED content: every push to `main` republishes it, and
// consumers install from it with `shadcn add`. Two things have gone wrong with it
// already, both silently, and both would have shipped:
//
//   1. `npm run registry:gen` destroyed it on Windows (223 files -> 1), because
//      `path.join` emits backslashes and `glob` treats "\" as an escape.
//   2. After that was fixed, the generator still emitted platform separators in
//      the OUTPUT ("src\\components\\atomic-crm\\types.ts"), which `shadcn add`
//      cannot resolve. The pre-commit hook regenerates the file on every commit,
//      so a single commit from a Windows machine would have published it.
//
// Neither failed a test, a build, or a lint. This file is what makes them fail.
//
// It deliberately checks VALIDITY, never freshness: the registry is intentionally
// stale pending ADR 0008, so "regenerate and compare" would be exactly the wrong
// assertion — it would demand the very publication that ADR is meant to decide.

const ROOT = process.cwd();
const REGISTRY_PATH = join(ROOT, "registry.json");
const GENERATOR_PATH = join(ROOT, "scripts", "generate-registry.mjs");
const ADR_0008_PATH = join(ROOT, "docs", "adr", "0008-fork-posture.md");

const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
const allFiles = (registry.items ?? []).flatMap((item) => item.files ?? []);

describe("registry.json is publishable", () => {
  it("parses and contains files", () => {
    expect(Array.isArray(registry.items)).toBe(true);
    expect(allFiles.length).toBeGreaterThan(100);
  });

  it("uses POSIX separators in every path", () => {
    // A backslash here is not a style issue. `shadcn add` resolves these paths
    // literally, so "src\\components\\..." resolves nowhere for every consumer.
    const withBackslashes = allFiles
      .map((file) => file.path)
      .filter((path) => path.includes("\\"));
    expect(withBackslashes).toEqual([]);
  });

  it("points only at files that exist", () => {
    const missing = allFiles
      .map((file) => file.path)
      .filter((path) => !existsSync(join(ROOT, path)));
    expect(missing).toEqual([]);
  });

  it("publishes nothing from the inbound shadcn directories", () => {
    // src/components/ui and src/components/admin are inbound registry content,
    // not ours to republish (CLAUDE.md; docs/product/07-upstream-strategy.md).
    const inbound = allFiles
      .map((file) => file.path)
      .filter(
        (path) =>
          path.startsWith("src/components/ui/") ||
          path.startsWith("src/components/admin/"),
      );
    expect(inbound).toEqual([]);
  });
});

describe("the generator cannot reintroduce platform separators", () => {
  const generator = readFileSync(GENERATOR_PATH, "utf8");

  it("normalises glob output to POSIX", () => {
    // globSync RETURNS platform separators regardless of the pattern, so the
    // posix.join calls on the INPUT patterns are not sufficient on their own.
    expect(generator).toMatch(/toPosixPath/);
    expect(generator).toMatch(/path\.sep/);
  });

  it("applies that normalisation to every glob result", () => {
    const globCalls = generator.match(/globSync\(/g) ?? [];
    const normalisations = generator.match(/\.map\(toPosixPath\)/g) ?? [];
    expect(globCalls.length).toBeGreaterThan(0);
    expect(normalisations.length).toBe(globCalls.length);
  });

  it("builds glob patterns with posix.join, not path.join", () => {
    // `glob` treats "\" as an escape character, so a path.join pattern matches
    // nothing on Windows and regenerates an almost-empty registry.
    expect(generator).not.toMatch(/globSync\(\s*path\.join\(/);
  });
});

describe("the pre-commit hook cannot silently publish an unapproved registry", () => {
  const adr = readFileSync(ADR_0008_PATH, "utf8");

  it("ADR 0008 is still Proposed", () => {
    // This assertion is the trigger, not the point. `.husky/pre-commit` runs
    // `npm run registry:gen` on every commit, so the working copy of
    // registry.json is regenerated constantly; only staging it publishes. While
    // ADR 0008 is undecided the committed registry must not grow to include the
    // fork's own components. When someone decides ADR 0008, this test goes red
    // and forces them to revisit the guard below rather than silently widening
    // what gets published.
    expect(adr).toMatch(/\*\*Status:\*\*\s*Proposed/);
  });

  it("does not publish the fork's clinical or engine components", () => {
    const published = allFiles.map((file) => file.path);
    const unapproved = [
      "LeadCommercialPanel",
      "leadProfiles",
      "acquisitionAttributions",
    ].filter((name) => published.some((path) => path.includes(name)));

    expect(
      unapproved,
      "registry.json was regenerated and committed while ADR 0008 is still Proposed; these are the fork's own components being published",
    ).toEqual([]);
  });

  it("records the deliberate staleness where the next agent will read it", () => {
    const claudeMd = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(claudeMd).toMatch(/registry\.json` is deliberately left stale/);
    expect(claudeMd).toMatch(/ADR 0008/);
  });
});
