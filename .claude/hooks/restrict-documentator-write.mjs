#!/usr/bin/env node
// PreToolUse(Write|Edit) — restrict the documentator (DOCUMENTATOR_RUN=1 or agent_type=documentator) writes to the ledger, the runtime additions tree (CONFIG_DIR/local/**), MEMORY.md, and settings.local.json; pass-through otherwise.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHookContext } from "./lib/context.mjs";
import { REPO, CONFIG_DIR } from "./lib/paths.mjs";

// Detect the documentator EITHER by DOCUMENTATOR_RUN=1 (legacy standalone
// run — a top-level process with no agent_type) OR by agent_type ===
// "documentator" (an Agent-dispatched documentator subagent). Read the payload
// first so agent_type is available.
//
// Fail closed: a malformed payload is a block signal for this restricted agent,
// not a pass-through. Leave input empty so the !filePath guard below exits 2
// (exit 1 from an uncaught throw would let the Write through).
let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // fall through to the empty-file_path block below
}
if (
  process.env.DOCUMENTATOR_RUN !== "1" &&
  (input.agent_type || "") !== "documentator"
) {
  process.exit(0);
}
const ctx = createHookContext(input, "restrict-documentator-write");
const filePath = input.tool_input?.file_path || "";

if (!filePath) {
  ctx.error(
    "Write/Edit blocked for documentator: empty or unparseable file_path.",
  );
  process.exit(2);
}

const LEDGER = join(REPO, "docs/learnings/patterns.md");
const LOCAL_PREFIX = join(CONFIG_DIR, "local") + "/";
const SETTINGS_LOCAL = join(CONFIG_DIR, "settings.local.json");
const MEMORY = join(REPO, "MEMORY.md");

// Windows: node:path's join() emits "\" separators, while a payload's
// file_path may carry either "/" or "\" (both are valid there). The
// byte-exact comparisons then never match and every allowed path is
// blocked, so compare on a separator-folded copy instead. On POSIX fold is
// the identity function: "\" is a legal filename character there, and
// folding it would change which paths match.
const fold =
  process.platform === "win32" ? (p) => p.replace(/\\/g, "/") : (p) => p;

const isAllowedPath = (p) => {
  const q = fold(p);
  return (
    q === fold(LEDGER) ||
    q === fold(SETTINGS_LOCAL) ||
    q === fold(MEMORY) ||
    q.startsWith(fold(LOCAL_PREFIX))
  );
};

if (isAllowedPath(filePath)) {
  process.exit(0);
}

ctx.error(
  `Write/Edit blocked for documentator: ${filePath} is outside the allowed set. Allowed: ${LEDGER}, ${SETTINGS_LOCAL}, ${MEMORY}, ${LOCAL_PREFIX}**.`,
);
process.exit(2);
