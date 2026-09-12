#!/usr/bin/env node
// The ONE way this repository publishes to GitHub Pages.
//
//   node scripts/publish-pages.mjs <gh-pages CLI arguments>
//   node scripts/publish-pages.mjs --remote production -d dist -b gh-pages
//
// It runs scripts/scan-build-artifacts.mjs over the directory named by
// -d/--dist, and hands the arguments to the gh-pages CLI only if that scan
// passes. The scan and the publish are one command, so no workflow or makefile
// edit can reorder them, drop the scan or make it non-blocking while keeping the
// publish.
//
// WHY NOT A SEPARATE CI STEP. That was this gate's first shape, and an
// adversarial review broke it: deploy-doc publishes through `make`, the
// makefile and `npm run ghpages:deploy` publish outside any workflow, and a
// regex over workflow lines missed `--dist`, Pages actions and a comment after
// `jobs:`. Proving that every publish has a scan in front of it is a parsing
// problem. Making the publish scan is not. `scripts/dev-signing-key.mjs` (rule
// `direct-pages-publish`) rejects every other way of invoking gh-pages.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCANNER = fileURLToPath(
  new URL("./scan-build-artifacts.mjs", import.meta.url),
);

/** The directory gh-pages would publish: `-d <dir>`, `--dist <dir>` or `--dist=<dir>`. */
export function publishedDirectory(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-d" || args[i] === "--dist") return args[i + 1] ?? null;
    const inline = args[i].match(/^--dist=(.+)$/);
    if (inline) return inline[1];
  }
  return null;
}

// A child killed by a signal has no status. That is not a pass.
const runNode = (script, args) =>
  spawnSync(process.execPath, [script, ...args], { stdio: "inherit" }).status ??
  2;

/**
 * Scans, then publishes. Returns the exit code: the scanner's when it refused,
 * gh-pages' otherwise. `scan` and `ghPages` are injectable for tests only.
 */
export function publishPages(
  args,
  {
    scan = (dir) => runNode(SCANNER, [dir]),
    ghPages = (argv) =>
      runNode(
        createRequire(import.meta.url).resolve("gh-pages/bin/gh-pages.js"),
        argv,
      ),
  } = {},
) {
  const dir = publishedDirectory(args);
  if (!dir) {
    console.error(
      "publish-pages: no -d/--dist directory was given, so nothing can be scanned. Refusing to publish.",
    );
    return 2;
  }
  const scanned = scan(dir);
  if (scanned !== 0) {
    console.error(
      `publish-pages: the scan of "${dir}" did not pass (exit ${scanned}). Nothing was published.`,
    );
    return scanned;
  }
  return ghPages(args);
}

const isEntryPoint = () =>
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint()) {
  process.exit(publishPages(process.argv.slice(2)));
}
