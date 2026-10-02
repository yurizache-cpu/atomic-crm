#!/usr/bin/env node
// The ONE way the frontend reaches a Netlify site (owner cost-first decision,
// 2026-09-29: the owner's existing Netlify account; docs/COST_FIRST_STAGING.md;
// SI-77).
//
//   node scripts/publish-netlify.mjs --environment staging \
//        --site-id <Netlify site id> --hostname <site>.netlify.app [--dist dist]
//
// It reads the environment the build was made with (VITE_SUPABASE_URL,
// VITE_SB_PUBLISHABLE_KEY) and NETLIFY_UPLOAD_GRANT, the one-time upload URL
// the Netlify connector's deploy-site operation issues (a credential: never
// printed, logged or committed), then, in this order and in this one process:
//
//   1. stages a COPY of the build as `site/` (the build itself is never
//      changed), writes into it `_headers` (the declared set for the
//      configured API) and `_redirects` (index.html for a path with no file),
//      and puts beside it, outside what is served, a netlify.toml that
//      publishes `site/` as it is (no build command: Netlify installs and
//      builds nothing);
//   2. runs the production preflight over exactly that `site/` and the
//      environment; a blocking finding stops here, before anything is uploaded;
//   3. uploads ONLY the staged directory with the pinned Netlify uploader, so
//      no source file, environment file or key can leave this machine;
//   4. holds the live site's actual response to the host contract, bound to
//      this build (scripts/live-release.mjs); a failure exits 1 and says how to
//      restore the previous deploy.
//
// Exit 0 published and verified, 1 refused or not verified, 2 could not run.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HEADERS_FILE, renderHeadersFile } from "./host-headers-file.mjs";
import {
  RELEASE_FILE,
  VERIFY_ATTEMPTS,
  VERIFY_INTERVAL_MS,
  assertPublishTarget,
  releaseFileText,
  releaseIdentifier,
  verifyLiveRelease,
} from "./live-release.mjs";
import { uploaderEnvironment } from "./publisher-environment.mjs";
import { parseFlags, report } from "./production-contract-report.mjs";
import { preflightFindings } from "./production-preflight.mjs";
import { readDeployedOrigin } from "./verify-production-host.mjs";

/** The uploader release this repository read and measured; change it deliberately. */
export const NETLIFY_UPLOADER = "@netlify/mcp@1.15.1";

export const REDIRECTS_FILE = "_redirects";
export const SPA_FALLBACK = "/* /index.html 200\n";
export const STAGED_SITE = "site";
export const STAGED_CONFIG = `[build]\n  publish = "${STAGED_SITE}"\n`;

const SITE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Only Netlify's own upload proxy; the token is base64url segments and dots,
// which also keeps it inert on a command line.
const UPLOAD_GRANT =
  /^https:\/\/netlify-mcp\.netlify\.app\/proxy\/[A-Za-z0-9._-]+$/;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

const defaultUpload = ({ cwd, siteId, grant, env }) =>
  spawnSync(
    "npx",
    ["--yes", NETLIFY_UPLOADER, "--site-id", siteId, "--proxy-path", grant],
    {
      cwd,
      env,
      stdio: "inherit",
      timeout: UPLOAD_TIMEOUT_MS,
      shell: process.platform === "win32",
    },
  ).status;

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The publish, with its outside effects injectable for the tests: `upload`
 * sends the staged directory (returns an exit status), `readOrigin` reads the
 * deployed origin, `sleep` waits between verification attempts. Returns the
 * exit status.
 */
export async function publish({
  dist,
  environment,
  siteId,
  hostname,
  env,
  upload = defaultUpload,
  readOrigin = readDeployedOrigin,
  sleep = defaultSleep,
  attempts = VERIFY_ATTEMPTS,
  intervalMs = VERIFY_INTERVAL_MS,
  write = (line) => console.error(line),
}) {
  const supabaseUrl = env.VITE_SUPABASE_URL;
  // Everything is validated before anything is written.
  assertPublishTarget({ environment, hostname });
  if (typeof siteId !== "string" || !SITE_ID.test(siteId)) {
    throw new Error("the site id must be the Netlify site's id (a UUID)");
  }
  const grant = env.NETLIFY_UPLOAD_GRANT;
  if (typeof grant !== "string" || !UPLOAD_GRANT.test(grant)) {
    throw new Error(
      "NETLIFY_UPLOAD_GRANT must be the upload URL the Netlify connector's deploy-site operation issued",
    );
  }

  const staged = mkdtempSync(join(tmpdir(), "netlify-publish-"));
  let status;
  try {
    // 1. The staged site, and what the host is to send for this build's API.
    const site = join(staged, STAGED_SITE);
    cpSync(dist, site, { recursive: true });
    if (typeof supabaseUrl === "string" && supabaseUrl !== "") {
      writeFileSync(
        join(site, HEADERS_FILE),
        renderHeadersFile({ supabaseUrl }),
      );
    }
    writeFileSync(join(site, REDIRECTS_FILE), SPA_FALLBACK);
    writeFileSync(
      join(site, RELEASE_FILE),
      releaseFileText(releaseIdentifier(dist)),
    );
    writeFileSync(join(staged, "netlify.toml"), STAGED_CONFIG);

    // 2. The preflight over exactly what would be served.
    const preflight = preflightFindings({ dist: site, env });
    if (report(`production preflight (${environment})`, preflight) !== 0) {
      return 1;
    }

    // 3. The upload of the staged directory and nothing else.
    // The uploader is a third-party process: it gets what npx needs and
    // nothing else from this shell, the grant only on its command line.
    status = upload({
      cwd: staged,
      siteId,
      grant,
      env: uploaderEnvironment(env),
    });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  if (status !== 0) {
    write(
      `the upload to Netlify site ${siteId} failed (exit ${status}); nothing was verified`,
    );
    return 1;
  }

  // 4. The live site's actual response, held to the contract and bound to
  // THIS build.
  const verified = await verifyLiveRelease({
    dist,
    hostname,
    supabaseUrl,
    readOrigin,
    sleep,
    attempts,
    intervalMs,
  });
  if (verified !== 0) {
    write(
      `\nThe new deploy is live on ${hostname} but does NOT meet the host contract. Restore the previous deploy now:\n` +
        "  Netlify > the site > Deploys > the last verified deploy > Publish deploy\n" +
        "(docs/COST_FIRST_STAGING.md, Rollback)",
    );
  }
  return verified;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2), [
      "environment",
      "site-id",
      "hostname",
      "dist",
    ]);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const dist = flags.dist ?? "dist";
  if (!existsSync(dist)) {
    console.error(`no build at "${dist}": run \`npm run build\` first`);
    process.exit(2);
  }
  try {
    process.exit(
      await publish({
        dist,
        environment: flags.environment,
        siteId: flags["site-id"],
        hostname: flags.hostname,
        env: process.env,
      }),
    );
  } catch (error) {
    console.error(`the publish could not run: ${error.message}`);
    process.exit(2);
  }
}
