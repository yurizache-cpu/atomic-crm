import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The router hazard is latent: an alarm for the day it becomes live
// (docs/PHASE_2C_REPORT.md §3.1, owner decision S0-A).
//
// A navigation blocker in the CRM (an unsaved-changes warning) is what turns
// the router hazard into a user-visible fault: a blocked POP reverts with
// history.go(-1) or reloads with history.go(0). The application-owned router
// (src/company-os/surface/CrmRouterHost.tsx) and the POP guard
// (src/company-os/surface/popGuard.ts) are in place, and the cross-surface
// tests exercise a stand-in react-router blocker
// (src/company-os/surface/SurfaceSwitch.test.tsx) and ra-core's own blocker
// path, a test-only <Form warnWhenUnsavedChanges> under the application's
// router (src/App.test.tsx). When a real CRM form starts blocking navigation,
// S0-A requires those tests to exercise IT: this test fails first, naming the
// file, and the file joins REVIEWED_BLOCKERS only once they do.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCANNED_ROOT = join(ROOT, "src", "components");

/** The ra-core and react-router APIs that block a navigation. */
const BLOCKER_APIS =
  /\b(warnWhenUnsavedChanges|useBlocker|unstable_usePrompt|usePrompt)\b/g;

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NOT_SHIPPED = /\.(test|spec|stories)\.[^.]+$/;

/**
 * Repository paths (POSIX separators) whose blocker the cross-surface tests
 * exercise. Empty: no CRM form blocks navigation at the base commit.
 */
const REVIEWED_BLOCKERS: readonly string[] = [];

interface BlockerUse {
  readonly file: string;
  readonly line: number;
  readonly api: string;
}

const findBlockerUses = (file: string, text: string): BlockerUse[] =>
  text.split(/\r?\n/).flatMap((content, index) =>
    [...content.matchAll(BLOCKER_APIS)].map((match) => ({
      file,
      line: index + 1,
      api: match[1],
    })),
  );

const shippedSources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return shippedSources(path);
    return SOURCE.test(entry.name) && !NOT_SHIPPED.test(entry.name)
      ? [path]
      : [];
  });

const repositoryPath = (path: string): string =>
  relative(ROOT, path).split(sep).join("/");

describe("no CRM form blocks navigation without a cross-surface test (S0-A)", () => {
  it("finds every blocker API by name, and nothing that merely contains one", () => {
    const text = [
      "const blocker = useBlocker(isDirty);",
      "<Form warnWhenUnsavedChanges>",
      "unstable_usePrompt({ when: dirty, message });",
      "usePrompt(true);",
      "const useBlockerish = 1; // not an API",
    ].join("\n");

    expect(
      findBlockerUses("x.tsx", text).map(({ api, line }) => [api, line]),
    ).toEqual([
      ["useBlocker", 1],
      ["warnWhenUnsavedChanges", 2],
      ["unstable_usePrompt", 3],
      ["usePrompt", 4],
    ]);
  });

  it("scans the shipped sources under src/components", () => {
    const files = shippedSources(SCANNED_ROOT).map(repositoryPath);

    expect(files).toContain("src/components/atomic-crm/root/CRM.tsx");
    expect(files).toContain("src/components/admin/simple-form.tsx");
    expect(files.some((file) => NOT_SHIPPED.test(file))).toBe(false);
  });

  it("finds no unreviewed navigation blocker under src/components", () => {
    const uses = shippedSources(SCANNED_ROOT)
      .map((path) => repositoryPath(path))
      .filter((file) => !REVIEWED_BLOCKERS.includes(file))
      .flatMap((file) =>
        findBlockerUses(file, readFileSync(join(ROOT, file), "utf8")),
      )
      .map(({ file, line, api }) => `${file}:${line} ${api}`);

    expect(
      uses,
      "A CRM file now blocks navigation, so the router hazard of docs/PHASE_2C_REPORT.md §3.1 is live. " +
        "Extend src/company-os/surface/SurfaceSwitch.test.tsx so the cross-surface navigation tests exercise this blocker (owner decision S0-A), " +
        "then add the file to REVIEWED_BLOCKERS in this test.",
    ).toEqual([]);
  });
});
