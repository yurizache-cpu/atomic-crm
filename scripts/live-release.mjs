// The last step of every frontend publish (SI-77): after the upload, the
// deployed origin's ACTUAL response is held to the host contract
// (scripts/production-contract-host.mjs) and bound to the build just uploaded:
// its page must load this build's hashed scripts, or a previous or cached
// release would pass for it. Retries while the new version propagates.
//
// Shared by scripts/publish-netlify.mjs and scripts/publish-cloudflare.mjs, so
// the two publishers cannot drift on what "verified" means.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditHostResponse,
  pageAssetPaths,
} from "./production-contract-host.mjs";
import { report } from "./production-contract-report.mjs";

export const ENVIRONMENTS = Object.freeze(["staging", "production"]);
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const VERIFY_ATTEMPTS = 8;
export const VERIFY_INTERVAL_MS = 15_000;

/** Throws unless the target is a known environment and a plain host name. */
export function assertPublishTarget({ environment, hostname }) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error('the environment must be "staging" or "production"');
  }
  if (typeof hostname !== "string" || !HOSTNAME_PATTERN.test(hostname)) {
    throw new Error(
      "the hostname must be a plain lower-case domain name, such as app.example.org (no scheme, path or port)",
    );
  }
}

/**
 * Reads https://<hostname>/ until it meets the contract and serves this build,
 * or the attempts run out. Returns the report's exit status: 0 verified, 1 not.
 */
export async function verifyLiveRelease({
  dist,
  hostname,
  supabaseUrl,
  readOrigin,
  sleep,
  attempts = VERIFY_ATTEMPTS,
  intervalMs = VERIFY_INTERVAL_MS,
}) {
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
  return report(`deployed origin ${hostname}`, findings);
}
