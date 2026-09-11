// Unit tests for the review-verdict path resolution (lib/reviews.mjs).
// reviewsDir() prefers CHAT_SESSION_DIR (set by a managed launcher such as CRM
// Builder's chat-service, where <session_dir> is NOT the /tmp/<repo>/<id> path the
// hooks recompute) and falls back to ctx.sessionDir otherwise. Both branches are
// pinned here so the quality-reviewer's synchronous flag write and the hooks that
// read/clear it never drift apart again.
//
// Expectations are composed with path.join rather than hardcoded "/" strings:
// reviewsDir() joins onto ctx.sessionDir (itself built with path.join in
// lib/context.mjs), so the separator is the platform's. On POSIX join() yields
// the exact strings this file always asserted; on Windows it yields the native
// backslash form the hooks actually create and read back with existsSync.

import { join } from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import { reviewsDir, reviewFlag } from "../lib/reviews.mjs";

const ORIG = process.env.CHAT_SESSION_DIR;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CHAT_SESSION_DIR;
  else process.env.CHAT_SESSION_DIR = ORIG;
});

describe("reviews path resolution", () => {
  test("falls back to ctx.sessionDir when CHAT_SESSION_DIR is unset", () => {
    delete process.env.CHAT_SESSION_DIR;
    const ctx = { sessionDir: "/tmp/_app/uuid" };
    expect(reviewsDir(ctx)).toBe(join("/tmp/_app/uuid", "reviews"));
    expect(reviewFlag(ctx, "TASK-001", "quality-reviewer")).toBe(
      join("/tmp/_app/uuid", "reviews", "TASK-001-quality-reviewer"),
    );
  });

  test("prefers CHAT_SESSION_DIR (managed launcher) over ctx.sessionDir", () => {
    process.env.CHAT_SESSION_DIR = "/chat-service/logs/uuid";
    const ctx = { sessionDir: "/tmp/_app/uuid" };
    expect(reviewsDir(ctx)).toBe(join("/chat-service/logs/uuid", "reviews"));
    expect(reviewFlag(ctx, "TASK-001", "quality-reviewer")).toBe(
      join("/chat-service/logs/uuid", "reviews", "TASK-001-quality-reviewer"),
    );
  });
});
