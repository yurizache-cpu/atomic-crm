import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishPages, publishedDirectory } from "../publish-pages.mjs";

const SCRIPT = fileURLToPath(new URL("../publish-pages.mjs", import.meta.url));

/** Records what ran, in order, so a test can assert that publishing never did. */
const recorder = ({ scanStatus = 0, publishStatus = 0 } = {}) => {
  const calls = [];
  return {
    calls,
    scan: (dir) => {
      calls.push(["scan", dir]);
      return scanStatus;
    },
    ghPages: (argv) => {
      calls.push(["publish", argv]);
      return publishStatus;
    },
  };
};

describe("publishing to GitHub Pages always scans first", () => {
  it("finds the published directory however gh-pages is told it", () => {
    expect(publishedDirectory(["-b", "gh-pages", "-d", "dist"])).toBe("dist");
    expect(publishedDirectory(["--dist", "doc/dist"])).toBe("doc/dist");
    expect(publishedDirectory(["--dist=public/r"])).toBe("public/r");
    expect(publishedDirectory(["-b", "gh-pages"])).toBeNull();
  });

  it("refuses to publish when no directory is named, since nothing can be scanned", () => {
    const run = recorder();
    expect(publishPages(["-b", "gh-pages"], run)).toBe(2);
    expect(run.calls).toEqual([]);
  });

  it("does not publish when the scan finds a secret", () => {
    const run = recorder({ scanStatus: 1 });
    expect(publishPages(["-d", "dist"], run)).toBe(1);
    expect(run.calls).toEqual([["scan", "dist"]]);
  });

  it("does not publish when the scan could not run", () => {
    const run = recorder({ scanStatus: 2 });
    expect(publishPages(["-d", "dist"], run)).toBe(2);
    expect(run.calls).toEqual([["scan", "dist"]]);
  });

  it("scans the exact directory it publishes, then passes every argument through", () => {
    const run = recorder();
    const args = [
      "-b",
      "gh-pages",
      "-d",
      "dist",
      "-e",
      "doc",
      "--remove",
      "doc",
    ];
    expect(publishPages(args, run)).toBe(0);
    expect(run.calls).toEqual([
      ["scan", "dist"],
      ["publish", args],
    ]);
  });

  it("reports the publisher's own failure", () => {
    const run = recorder({ publishStatus: 1 });
    expect(publishPages(["-d", "dist"], run)).toBe(1);
  });
});

describe("the command, with the real scanner", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "publish-pages-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a build carrying a server-side secret, before gh-pages is reached", () => {
    // Synthetic value. `--no-push` as well, so even a broken refusal pushes nothing.
    writeFileSync(
      join(dir, "app.js"),
      'const k="sb_secret_AAAAAAAAAAAAAAAAAAAA";',
    );
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "-d", dir, "-b", "gh-pages", "--no-push"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Nothing was published/);
  });

  it("refuses a directory that does not exist", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "-d", join(dir, "missing"), "--no-push"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
  });
});
