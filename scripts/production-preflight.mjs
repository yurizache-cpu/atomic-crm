#!/usr/bin/env node
// The production PREFLIGHT: refuses a build, before it is published to any
// host, that a production deployment must not carry.
//
//   node scripts/production-preflight.mjs [--dist dist] [--services] [--json]
//
// It reads the environment the build was made with (process.env) and the built
// directory, and checks both against the production contract:
//
//   environment  not a demo build, an https public API, a publishable key that
//                is not the local stack's, no privileged or unaudited VITE_
//                variable; with --services also the worker's own environment
//                (no fake provider, no synthetic ingress, no local database)
//   artifact     the secret scan the publish step runs, plus no local endpoint
//                in any page or script, no published component registry, and a
//                page policy made for THIS API
//
// It names a provider nowhere: it runs in front of whichever host is chosen.
// Exit 0 pass, 1 a blocking finding, 2 it could not check.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditClientEnvironment,
  auditServiceEnvironment,
} from "./production-contract-env.mjs";
import {
  auditArtifactFiles,
  auditPageAgainstEnvironment,
} from "./production-contract-host.mjs";
import { HEADERS_FILE, auditHeadersFile } from "./host-headers-file.mjs";
import { parseFlags, report } from "./production-contract-report.mjs";
import { scanDirectory } from "./scan-build-artifacts.mjs";

const TEXT = /\.(html?|[cm]?js|css|json|txt|webmanifest|map)$/i;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Every finding for a build directory and the environment it was built with. */
export function preflightFindings({ dist, env, services = false }) {
  const findings = auditClientEnvironment(env);
  if (services) findings.push(...auditServiceEnvironment(env));

  const scan = scanDirectory(dist);
  for (const f of scan.findings) {
    findings.push({
      rule: f.rule,
      severity:
        f.severity === "critical" || f.severity === "high"
          ? "blocking"
          : "advisory",
      file: f.file,
      detail: f.detail,
    });
  }
  const files = [...walk(dist)]
    .filter((file) => TEXT.test(file) && !/\.map$/i.test(file))
    .map((file) => ({
      rel: relative(dist, file).split("\\").join("/"),
      text: readFileSync(file, "utf8"),
    }));
  findings.push(
    ...auditArtifactFiles(files, {
      hasRegistryDirectory: existsSync(join(dist, "r")),
    }),
  );
  const index = files.find((file) => file.rel === "index.html");
  if (index === undefined) {
    findings.push({
      rule: "index-missing",
      severity: "blocking",
      detail: "the build has no index.html",
    });
  } else if (env.VITE_SUPABASE_URL) {
    try {
      findings.push(
        ...auditPageAgainstEnvironment(index.text, env.VITE_SUPABASE_URL),
      );
    } catch {
      // An unreadable API URL is already a blocking finding above.
    }
  }
  // A headers file in the build is what a static host will be told to send:
  // it must be exactly the declared set for the configured API.
  const headersFile = join(dist, HEADERS_FILE);
  if (existsSync(headersFile) && env.VITE_SUPABASE_URL) {
    try {
      findings.push(
        ...auditHeadersFile(readFileSync(headersFile, "utf8"), {
          supabaseUrl: env.VITE_SUPABASE_URL,
        }),
      );
    } catch {
      // An unreadable API URL is already a blocking finding above.
    }
  }
  if (scan.sourceMaps > 0) {
    findings.push({
      rule: "source-maps",
      severity: "advisory",
      detail: `${scan.sourceMaps} source map(s) are published; the source is public in the repository and the scan reads the maps, so this is a decision, not a leak`,
    });
  }
  return findings;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2), ["dist"]);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const dist = flags.dist ?? "dist";
  if (!existsSync(dist)) {
    console.error(
      `no build at "${dist}": run \`npm run build\` first. A preflight that cannot look is not a pass.`,
    );
    process.exit(2);
  }
  let findings;
  try {
    findings = preflightFindings({
      dist,
      env: process.env,
      services: flags.services === true,
    });
  } catch (error) {
    console.error(`the preflight could not finish: ${error.message}`);
    process.exit(2);
  }
  process.exit(
    report("production preflight", findings, { json: flags.json === true }),
  );
}
