#!/usr/bin/env node
// Refuses to ship a frontend build that contains a server-side secret.
//
//   node scripts/scan-build-artifacts.mjs [dir]      # default: dist
//
// WHY THIS EXISTS. The boundary that keeps `SERVICE_ROLE_KEY` out of the bundle
// is Vite's `VITE_` prefix rule — a convention enforced by a build tool, not by
// anything in this repository. It holds today (proven: building in `e2e` mode,
// where `.env.e2e` carries a service_role JWT, leaves it absent from every
// artifact). One `VITE_` typo on a secret variable silently inverts that, and
// the result is a credential published to a static host.
//
// WHAT IT IS NOT. It is not entropy detection. A generic high-entropy scan over
// a 2 MB minified bundle produces constant false positives, gets muted, and then
// protects nothing. Every rule below names a specific credential CLASS.
//
// NO REAL SECRET IS STORED HERE. The rules are patterns and variable names, and
// the tests use synthetic fixtures. Matches are reported by type, location and a
// sha256 fingerprint — never by value, and for private key material not even by
// a redacted prefix.
//
// ONE CHECK IS NOT A CLASS. The committed development signing key
// (supabase/signing_keys.json, SEC-1BS-04) is also looked for by its own bytes:
// a private component copied into a plain string constant has no `kty` and no
// PEM header, so it would pass every class rule below. The bytes stay inside
// `scripts/dev-signing-key.mjs`; this file only asks it yes-or-no questions.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { loadDevSigningKeys } from "./dev-signing-key.mjs";

/**
 * Formats that cannot carry a usable literal. Everything else is read, whatever
 * its extension or lack of one: a list of extensions WORTH reading once let a
 * private key through as `.well-known/jwks`, `dev.jwk` and `keys.pem`.
 */
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|br|tgz|mp3|mp4|webm|mov|wasm)$/i;

/** Roles that must never appear as a JWT `role` claim in a browser artifact. */
const FORBIDDEN_JWT_ROLES = new Set([
  "service_role",
  "supabase_admin",
  "postgres",
]);

/** How far either side of a JWK `d` member to look for its `kty`. */
const JWK_WINDOW = 400;

/** What a finding shows in place of private key material. */
const WITHHELD = "<withheld: private key material>";

const decodeJwtRole = (token) => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = Buffer.from(
      payload.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    return JSON.parse(json).role ?? null;
  } catch {
    return null;
  }
};

/**
 * Each rule finds one credential class.
 *
 * `verify` lets a rule look past the regex — the JWT rule uses it to tell an
 * `anon` token (expected in the bundle, and NOT a finding) from a
 * `service_role` one (fatal). Without that distinction this gate would either
 * flag every build or miss the thing it exists to catch.
 */
const RULES = [
  {
    id: "supabase-secret-key",
    severity: "critical",
    pattern: /sb_secret_[A-Za-z0-9_-]{8,}/g,
    describe: () => "Supabase secret key (sb_secret_…)",
  },
  {
    id: "privileged-jwt",
    severity: "critical",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/g,
    verify: (m) => FORBIDDEN_JWT_ROLES.has(decodeJwtRole(m) ?? ""),
    describe: (m) => `JWT whose role claim is "${decodeJwtRole(m)}"`,
  },
  {
    id: "postgres-connection-string",
    severity: "critical",
    // Only with credentials in it; a bare host:port is not a secret.
    pattern: /postgres(?:ql)?:\/\/[^\s"'`:]+:[^\s"'`@]+@[^\s"'`/]+/g,
    describe: () => "PostgreSQL connection string with credentials",
  },
  {
    id: "private-key-block",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    describe: () => "PEM private key block",
  },
  {
    id: "private-jwk",
    severity: "critical",
    // The private member of a JSON Web Key, as JSON or as the object literal a
    // bundler turns an imported .json file into. `verify` insists on a `kty`
    // nearby, so an unrelated `d:"…"` is not a finding.
    pattern: /(?:"d"|\bd)\s*:\s*["'`][A-Za-z0-9_-]{32,}["'`]/g,
    verify: (_match, content, index) =>
      /["']?\bkty["']?\s*:/.test(
        content.slice(Math.max(0, index - JWK_WINDOW), index + JWK_WINDOW),
      ),
    withholdValue: true,
    describe: () => "JSON Web Key carrying its private component",
  },
  {
    id: "github-token",
    severity: "critical",
    pattern:
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    describe: () => "GitHub token",
  },
  {
    id: "aws-access-key",
    severity: "critical",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    describe: () => "AWS access key id",
  },
  {
    id: "assigned-server-secret",
    severity: "high",
    // A server-only variable NAME with a non-trivial value next to it. Catches
    // the `VITE_`-typo case, where the name survives into the bundle.
    pattern:
      /\b(SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_PASSWORD|POSTMARK_WEBHOOK_PASSWORD|SUPABASE_ACCESS_TOKEN|JWT_SECRET|DEPLOY_TOKEN|OPS_WORKER_PASSWORD|OPS_WORKER_DATABASE_URL)\s*[:=]\s*["'`][^"'`\s]{8,}["'`]/g,
    describe: (m) =>
      `server-only variable assigned a value (${m.split(/[:=]/)[0].trim()})`,
  },
];

/**
 * Files that are not secrets but should not be published either.
 *
 * Separate from the rules above because the remedy is different: these are
 * build outputs to stop emitting, not credentials to rotate.
 */
const UNWANTED_ARTIFACTS = [
  {
    id: "bundle-visualizer",
    severity: "low",
    match: (rel) => /(^|\/)stats\.html$/.test(rel),
    describe: () =>
      "rollup-plugin-visualizer report: publishes the full module graph, every source path and dependency inventory",
  },
  {
    id: "signing-keys-file",
    severity: "critical",
    match: (rel) => /(^|\/)signing_keys\.json$/i.test(rel),
    describe: () =>
      "a Supabase signing key file: JWT signing keys are server-side secrets and never belong in a published build",
  },
];

const fingerprint = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const redact = (value) =>
  value.length <= 12
    ? `${value.slice(0, 2)}…`
    : `${value.slice(0, 6)}…${value.slice(-4)}`;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * @param {string} dir
 * @param {{devSigningKeys?: ReturnType<typeof loadDevSigningKeys>}} [options]
 *   `devSigningKeys` defaults to the repository's own development key. Tests
 *   pass a synthetic key set, or `null` for none.
 */
export function scanDirectory(dir, { devSigningKeys } = {}) {
  const findings = [];
  if (!existsSync(dir)) {
    throw new Error(
      `no build to scan at "${dir}". Run \`npm run build\` first — a gate that silently passes on a missing build protects nothing.`,
    );
  }
  const devKeys =
    devSigningKeys === undefined ? loadDevSigningKeys() : devSigningKeys;

  let scanned = 0;
  for (const file of walk(dir)) {
    const rel = relative(dir, file).split("\\").join("/");

    for (const artifact of UNWANTED_ARTIFACTS) {
      if (artifact.match(rel)) {
        findings.push({
          rule: artifact.id,
          severity: artifact.severity,
          file: rel,
          detail: artifact.describe(),
        });
      }
    }

    if (BINARY.test(file)) continue;
    scanned += 1;
    const content = readFileSync(file, "utf8");

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      const seen = new Set();
      for (const match of content.matchAll(rule.pattern)) {
        const value = match[0];
        if (seen.has(value)) continue;
        seen.add(value);
        if (rule.verify && !rule.verify(value, content, match.index)) continue;
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: rel,
          detail: rule.describe(value),
          // Never the value itself.
          redacted: rule.withholdValue ? WITHHELD : redact(value),
          sha256: fingerprint(value),
        });
      }
    }

    if (devKeys?.containsPrivateMaterial(content)) {
      findings.push({
        rule: "dev-signing-key",
        severity: "critical",
        file: rel,
        detail:
          "the committed DEVELOPMENT signing key's private component: a token it signs as service_role bypasses RLS on any project that trusts it",
      });
    } else if (devKeys?.containsPublicKey(content)) {
      findings.push({
        rule: "dev-signing-key-public",
        severity: "high",
        file: rel,
        detail:
          "the committed DEVELOPMENT signing key's public component: this build carries, and so may trust, the development key set",
      });
    }
  }

  return { scanned, findings };
}

const isEntryPoint = async () => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await isEntryPoint()) {
  const dir = process.argv[2] ?? "dist";
  let result;
  try {
    result = scanDirectory(dir);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const blocking = result.findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  );

  for (const f of result.findings) {
    const where = `${f.file}`;
    const id = `[${f.severity.toUpperCase()}] ${f.rule}`;
    console.error(
      f.sha256
        ? `${id} ${where}: ${f.detail} — ${f.redacted} (sha256:${f.sha256})`
        : `${id} ${where}: ${f.detail}`,
    );
  }

  console.error(
    `\nscanned ${result.scanned} text file(s) in "${dir}": ` +
      `${blocking.length} blocking, ${result.findings.length - blocking.length} advisory.`,
  );

  if (blocking.length > 0) {
    console.error(
      "\nA server-side credential is present in a browser artifact. Do not deploy this build. " +
        "Rotate the credential, then find the variable: only `VITE_`-prefixed values are meant to reach the bundle.",
    );
    process.exit(1);
  }
}
