import { join, resolve, sep } from "node:path";
import { exec } from "./process.mjs";

// APP_DIR / CLAUDE_PROJECT_DIR override the detected root (used by hook tests).
function getRepo() {
  if (process.env.APP_DIR) return process.env.APP_DIR;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const top = exec("git", ["rev-parse", "--show-toplevel"]);
  if (top.status === 0 && top.stdout.trim()) return top.stdout.trim();
  return process.cwd();
}

export const REPO = getRepo();

export const CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "/root", ".claude");
// HARNESS_TMP_ROOT is the neutral name; CRM_TMP_ROOT is the deprecated fallback
// kept for one release so existing launchers / tests keep working.
export const TMP_ROOT =
  process.env.HARNESS_TMP_ROOT || process.env.CRM_TMP_ROOT || "/tmp";

// Flattens an absolute repo path into a single directory name.
// Windows separators and the drive colon must be folded too: leaving them in
// produces a middle segment like `<tmp>/C:\Users\me\app/<id>`, which every
// mkdir below TMP_ROOT then rejects with ENOENT.
// POSIX behaviour is unchanged (`/home/u/app` -> `_home_u_app`), so session
// directories created on Linux/CI keep their existing names.
// NOTE: `.claude/scripts/harness-monitor.mjs` keeps an identical copy — change
// both together or the monitor watches a different directory than the hooks.
export function sanitizePath(p) {
  return String(p ?? "").replace(/[/\\:]/g, "_");
}

// Canonical form for comparing a path we built with `join()` against one git
// reported. `git worktree list --porcelain` prints POSIX separators on EVERY
// platform, so on Windows the two forms never compare equal — which silently
// turns every such comparison into "no match". That has bitten four call sites:
// the worktree sweep (which then deleted live worktrees), session teardown,
// and `getActiveWorktrees` (which made validate-on-stop validate nothing).
//
// Absolutizing is required, not cosmetic: TMP_ROOT defaults to the literal
// "/tmp", which Node resolves to a DRIVE-RELATIVE path on Windows, while git
// always reports an absolute drive-lettered one.
//
// On POSIX `sep` is "/", so this is the identity function and `resolve()` is
// never reached — the harness's real deployment target is untouched.
export function toGitPath(p) {
  const s = String(p ?? "");
  return sep === "/" ? s : resolve(s).split(sep).join("/");
}
