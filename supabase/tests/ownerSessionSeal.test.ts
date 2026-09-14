// SI-27 rests on code, not on the role switch: the owner session can RESET
// ROLE, so what keeps merge_contacts out of ops is that the pool is private to
// db.ts, runAsUser is its only use, and merge_contacts sends fixed statements
// through it. The static guard (scripts/production-scope.mjs) cannot read every
// spelling of a raw call, such as a computed member name or reflection, so these
// two files are sealed instead. Any change fails here until someone reviews it
// against SI-27, runs `npm run test:db` (owner_session_pool.sql and
// ownerSessionPool.mjs) and records the new digest. Line endings are
// normalised, as for the migration seal, because git checks this repository
// out CRLF on Windows and LF on Linux.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const OWNER_SESSION_SEAL: Readonly<Record<string, string>> = Object.freeze({
  "supabase/functions/_shared/db.ts":
    "ec0f11ea878affea91feefdc8304217309b2bf03786a7182975d6f59bed32a89",
  "supabase/functions/merge_contacts/index.ts":
    "76b61b1512a5e9aaf1a488d6fd2b3b43700134b40dddeb777926aa90ee4bdd70",
});

const digestOf = (path: string) =>
  createHash("sha256")
    .update(readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");

describe("the owner-session channel is sealed (SI-27)", () => {
  it.each(Object.entries(OWNER_SESSION_SEAL))(
    "%s is the reviewed version",
    (path, sealed) => {
      expect(
        digestOf(path),
        `${path} changed, and it is part of the owner-session channel (SI-27). Check that the pool stays private to db.ts, that every query runs inside runAsUser, and that nothing sent through it is built from input; run npm run test:db; then record the new digest in OWNER_SESSION_SEAL.`,
      ).toBe(sealed);
    },
  );
});
