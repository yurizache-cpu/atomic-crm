// Tests for lib/paths.mjs path canonicalisation.
//
// `toGitPath` exists because `git worktree list --porcelain` prints POSIX
// separators on EVERY platform, while the hooks build their paths with
// node's `join()`. Comparing the two forms directly silently matched nothing
// on Windows, which turned four guards into no-ops — including the one in
// front of a recursive `rmSync` and the one deciding whether validate-on-stop
// has anything to validate. These tests pin both halves of the contract:
// the POSIX no-op, and the Windows canonical form.

import { resolve, sep } from "node:path";
import { describe, expect, test } from "vitest";
import { sanitizePath, toGitPath } from "../lib/paths.mjs";

const onWindows = sep === "\\";

describe("sanitizePath", () => {
  test("flattens a POSIX repo path into one directory name", () => {
    expect(sanitizePath("/home/user/atomic-crm")).toBe("_home_user_atomic-crm");
    expect(sanitizePath("/workspaces/atomic-crm")).toBe(
      "_workspaces_atomic-crm",
    );
  });

  test("folds Windows separators and the drive colon", () => {
    // Left in, these produce a middle segment like `<tmp>/C:\Users\me\app/<id>`,
    // which every mkdir below TMP_ROOT rejects with ENOENT.
    expect(sanitizePath("C:\\Users\\me\\app")).toBe("C__Users_me_app");
    expect(sanitizePath("D:\\download\\CRM - claude")).toBe(
      "D__download_CRM - claude",
    );
  });

  test("never leaves a separator that could reopen a path segment", () => {
    for (const p of [
      "/home/u/app",
      "C:\\Users\\me\\app",
      "//unc/share/app",
      "",
    ]) {
      expect(sanitizePath(p)).not.toMatch(/[/\\:]/);
    }
  });

  test("tolerates null and undefined", () => {
    expect(sanitizePath(null)).toBe("");
    expect(sanitizePath(undefined)).toBe("");
  });
});

describe("toGitPath", () => {
  test("emits forward slashes only", () => {
    expect(toGitPath(resolve("a", "b"))).not.toContain("\\");
  });

  test("is idempotent", () => {
    const once = toGitPath(resolve("a", "b"));
    expect(toGitPath(once)).toBe(once);
  });

  test("agrees with itself across separator spellings of one path", () => {
    // The whole point: a path built with join() and the same path as git
    // reports it must canonicalise to the same string.
    const posixForm = toGitPath(resolve("x", "y", "z"));
    const nativeForm = toGitPath(resolve("x", "y", "z").split("/").join(sep));
    expect(nativeForm).toBe(posixForm);
  });

  test("tolerates null and undefined", () => {
    expect(() => toGitPath(null)).not.toThrow();
    expect(() => toGitPath(undefined)).not.toThrow();
  });

  test.skipIf(onWindows)("is the identity on POSIX", () => {
    // Guards the harness's real deployment target: nothing is rewritten, so
    // no existing Linux/CI path can change meaning.
    for (const p of [
      "/tmp/_home_u_app/sid",
      "/home/user/atomic-crm",
      "/a/b\\c",
      "",
    ]) {
      expect(toGitPath(p)).toBe(p);
    }
  });

  test.skipIf(!onWindows)("absolutizes a drive-relative path on Windows", () => {
    // TMP_ROOT defaults to the literal "/tmp", which Windows treats as
    // drive-relative while git always reports an absolute drive-lettered
    // path. Folding separators without resolving leaves the two unequal.
    const out = toGitPath("/tmp/_app/sid");
    expect(out).toMatch(/^[A-Za-z]:\//);
    expect(out.endsWith("/tmp/_app/sid")).toBe(true);
  });
});
