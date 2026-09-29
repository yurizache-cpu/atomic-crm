#!/usr/bin/env node
// The ONE way the frontend reaches its production or staging host (Production
// Hosting, SI-77).
//
//   node scripts/publish-cloudflare.mjs --environment staging|production \
//        --hostname app.example.org [--dist dist]
//
// It reads the environment the build was made with (VITE_SUPABASE_URL,
// VITE_SB_PUBLISHABLE_KEY) and the Cloudflare credentials (CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID), then, in this order and in this one process:
//
//   1. writes the `_headers` file for the configured API into the build;
//   2. runs the production preflight over the build and that environment
//      (the secret scan, the page policy, no local endpoint, no demo build, the
//      headers file itself); a blocking finding stops here, before any upload;
//   3. uploads with the pinned Wrangler (one assets-only Worker per environment,
//      served only on its custom domain: scripts/cloudflare-config.mjs);
//   4. reads the deployed origin back and holds its ACTUAL response to the host
//      contract (scripts/verify-production-host.mjs), retrying while the new
//      version propagates; a failure exits 1 and prints the rollback command.
//
// The steps are one command so that no workflow edit can reorder them, drop the
// preflight or skip the check: the same reason scripts/publish-pages.mjs scans
// in the command that publishes. Nothing here prints a token, key or URL value.
//
// Exit 0 published and verified, 1 refused or not verified, 2 could not run.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cloudflareWorkerConfig } from "./cloudflare-config.mjs";
import { HEADERS_FILE, renderHeadersFile } from "./host-headers-file.mjs";
import {
  auditHostResponse,
  pageAssetPaths,
} from "./production-contract-host.mjs";
import { parseFlags, report } from "./production-contract-report.mjs";
import { preflightFindings } from "./production-preflight.mjs";
import { readDeployedOrigin } from "./verify-production-host.mjs";

/** The Wrangler release this repository measured; change it deliberately. */
export const WRANGLER_VERSION = "4.129.1";

const VERIFY_ATTEMPTS = 8;
const VERIFY_INTERVAL_MS = 15_000;

const defaultRun = (args, env) =>
  spawnSync("npx", ["--yes", `wrangler@${WRANGLER_VERSION}`, ...args], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }).status;

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The publish, with its outside effects injectable for the tests: `run` is the
 * Wrangler invocation (returns an exit status), `readOrigin` reads the deployed
 * origin, `sleep` waits between verification attempts. Returns the exit status.
 */
export async function publish({
  dist,
  environment,
  hostname,
  env,
  run = defaultRun,
  readOrigin = readDeployedOrigin,
  sleep = defaultSleep,
  attempts = VERIFY_ATTEMPTS,
  intervalMs = VERIFY_INTERVAL_MS,
  write = (line) => console.error(line),
}) {
  const supabaseUrl = env.VITE_SUPABASE_URL;
  // Validates the environment and the hostname before anything is written.
  const config = cloudflareWorkerConfig({
    environment,
    hostname,
    assetsDirectory: resolve(dist),
  });
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required (GitHub environment secret and variable)",
    );
  }

  // 1. The headers the host is to send, for the API this build was made for.
  if (typeof supabaseUrl === "string" && supabaseUrl !== "") {
    writeFileSync(join(dist, HEADERS_FILE), renderHeadersFile({ supabaseUrl }));
  }

  // 2. The preflight: nothing is uploaded past a blocking finding.
  const preflight = preflightFindings({ dist, env });
  if (report(`production preflight (${environment})`, preflight) !== 0) {
    return 1;
  }

  // 3. The upload, with a generated configuration outside the build.
  const configDir = mkdtempSync(join(tmpdir(), "cloudflare-config-"));
  const configPath = join(configDir, "wrangler.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  let status;
  try {
    status = run(["deploy", "--config", configPath], env);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  if (status !== 0) {
    write(
      `the upload to ${config.name} failed (exit ${status}); nothing was verified`,
    );
    return 1;
  }

  // 4. The deployed origin's actual response, held to the contract, and
  // bound to THIS build: its page must load the hashed scripts of the build
  // just uploaded, or a previous release (or a cached one) would pass for it.
  const url = `https://${hostname}/`;
  const uploaded = pageAssetPaths(
    readFileSync(join(dist, "index.html"), "utf8"),
  )
    .sort()
    .join(" ");
  let findings = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const facts = await readOrigin(url);
      findings = auditHostResponse(facts.response, {
        supabaseUrl,
        expectedHost: hostname,
      });
      const live = pageAssetPaths(facts.response.html ?? "")
        .sort()
        .join(" ");
      if (live !== uploaded) {
        findings.push({
          rule: "stale-release",
          severity: "blocking",
          detail:
            "the live page does not load the scripts of the build just uploaded (a previous or cached release, or not yet propagated)",
        });
      }
    } catch (error) {
      findings = [
        {
          rule: "origin-unreadable",
          severity: "blocking",
          detail: `the deployed origin could not be read (${error?.name ?? "error"})`,
        },
      ];
    }
    if (!findings.some((f) => f.severity === "blocking")) break;
    if (attempt < attempts) await sleep(intervalMs);
  }
  const verified = report(`deployed origin ${hostname}`, findings);
  if (verified !== 0) {
    write(
      `\nThe new version is live on ${hostname} but does NOT meet the host contract. Roll back now:\n` +
        `  npx --yes wrangler@${WRANGLER_VERSION} rollback --name ${config.name}\n` +
        "(docs/PRODUCTION_DEPLOYMENT.md, Rollback)",
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
        hostname: flags.hostname,
        env: process.env,
      }),
    );
  } catch (error) {
    console.error(`the publish could not run: ${error.message}`);
    process.exit(2);
  }
}
