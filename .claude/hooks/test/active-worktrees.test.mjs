// Regression test for the defect that made validate-on-stop validate NOTHING
// on Windows.
//
// `getActiveWorktrees` filters `git worktree list` output by `ctx.worktreeBase`.
// git prints POSIX separators on every platform; `worktreeBase` comes from
// node's `join()`. On Windows the filter therefore matched nothing, the caller
// read that as `no_active_worktree`, and every validation step was skipped —
// silently, with a green result. A unit test on the helper alone would not have
// caught it, so this drives the real function against a real git worktree.
//
// The assertions are platform-independent on purpose: this file must fail on
// Windows if the canonicalisation is ever removed, and keep passing on Linux.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_ID = "ef56ab78-1111-2222-3333-444455556666";

let TMP;
let APP_DIR;
let TMP_ROOT;
let WORKTREE_BASE;

const g = (...args) =>
  spawnSync("git", ["-C", APP_DIR, ...args], { encoding: "utf8" });

/**
 * Runs getActiveWorktrees in a child process, because lib/paths.mjs resolves
 * REPO and TMP_ROOT from the environment at import time.
 */
const activeWorktrees = (worktreeBase) => {
  const script = `
    import { getActiveWorktrees } from ${JSON.stringify(pathToFileURL(join(HERE, "..", "lib", "validation.mjs")).href)};
    const ctx = { repo: process.env.APP_DIR, worktreeBase: process.env.WT_BASE, log: () => {} };
    process.stdout.write(JSON.stringify(getActiveWorktrees(ctx)));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      APP_DIR,
      HARNESS_TMP_ROOT: TMP_ROOT,
      WT_BASE: worktreeBase,
      VALIDATE_WORKTREE: "",
    },
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "active-wt-test-"));
  APP_DIR = join(TMP, "app");
  TMP_ROOT = join(TMP, "wtroot");
  mkdirSync(APP_DIR, { recursive: true });
  mkdirSync(TMP_ROOT, { recursive: true });

  g("init", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(APP_DIR, "a.txt"), "a\n");
  g("add", "-A");
  g("commit", "-m", "init");

  WORKTREE_BASE = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(WORKTREE_BASE, { recursive: true });
  g("worktree", "add", "-b", "s/TASK-001", join(WORKTREE_BASE, "TASK-001"));
  g("worktree", "add", "-b", "s/TASK-002", join(WORKTREE_BASE, "TASK-002"));
});

afterAll(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe("getActiveWorktrees", () => {
  test("finds the session's worktrees on this platform", () => {
    // The defect: this returned [] on Windows, so validate-on-stop reported
    // `no_active_worktree` and ran no checks at all.
    const found = activeWorktrees(WORKTREE_BASE);
    expect(found).toHaveLength(2);
  });

  test("returns paths that exist on disk", () => {
    // Guards against "matches, but hands back a string nothing can cd into".
    for (const p of activeWorktrees(WORKTREE_BASE)) {
      expect(spawnSync("git", ["-C", p, "rev-parse", "--git-dir"]).status).toBe(
        0,
      );
    }
  });

  test("excludes worktrees belonging to another session", () => {
    // Cross-session isolation must not be collateral damage of the fix.
    const otherBase = join(TMP_ROOT, sanitizePath(APP_DIR), "99999999-0000");
    mkdirSync(otherBase, { recursive: true });
    expect(activeWorktrees(otherBase)).toHaveLength(0);
  });

  test("does not match a sibling directory sharing the base's prefix", () => {
    // `startsWith(base)` without the separator would swallow `<base>-other`.
    const sibling = `${WORKTREE_BASE}-other`;
    mkdirSync(sibling, { recursive: true });
    g("worktree", "add", "-b", "s/OTHER", join(sibling, "TASK-009"));
    expect(activeWorktrees(WORKTREE_BASE)).toHaveLength(2);
  });
});
