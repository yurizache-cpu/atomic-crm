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
// protects nothing. Every rule names a specific credential CLASS.
//
// NO REAL SECRET IS STORED HERE. The rules are patterns and variable names, and
// the tests use synthetic fixtures. Matches are reported by type, location and a
// sha256 fingerprint — never by value, and for private key material not even by
// a redacted prefix.
//
// ONE CHECK IS NOT A CLASS. The committed development signing key
// (supabase/signing_keys.json, SEC-1BS-04) is also looked for by its own bytes:
// a private component copied into a plain string constant has no `kty` and no
// PEM header, so it would pass every class rule. The bytes stay inside
// `scripts/dev-signing-key.mjs`; this file only asks it yes-or-no questions.
//
// NAMES AND CLASSES (Phase 2C, owner decision S0-H, 2026-09-23). The S0.6
// spike planted each Phase 2C server secret in a build. The admin database URL
// was caught, but only by its connection-string class; WHATSAPP_ACCESS_TOKEN,
// WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN and OPS_GATEWAY_PASSWORD were
// missed. The name rule then knew none of them, it anchored on `\b` and an
// unescaped quote, so it could not read the object Vite inlines
// (`{"NAME":"…"}`) or a source map's escaped copy of it (`\"NAME\":\"…\"`), and
// no name rule can see a bare token. So the exact names stay, now read in every
// spelling a build produces, and a class rule stands behind each kind of server
// secret: a privileged `VITE_` name, private or signing key material, a
// database connection string, a service-role or any other non-anon JWT, a Meta
// access token, and a bearer- or token-shaped literal. Each class was measured
// against the real build and against node_modules on 2026-09-23 (the numbers
// are next to each rule).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { loadDevSigningKeys } from "./dev-signing-key.mjs";
import { CONNECTION_STRING_RULES } from "./scan-build-rules-connections.mjs";
import { KEY_MATERIAL_RULES } from "./scan-build-rules-key-material.mjs";
import { NAME_RULES } from "./scan-build-rules-names.mjs";
import { SUPABASE_KEY_RULES } from "./scan-build-rules-supabase-keys.mjs";
import { TOKEN_RULES } from "./scan-build-rules-tokens.mjs";

export { isPrivilegedViteName } from "./scan-build-vite-names.mjs";

/**
 * Formats that cannot carry a usable literal. Everything else is read, whatever
 * its extension or lack of one: a list of extensions WORTH reading once let a
 * private key through as `.well-known/jwks`, `dev.jwk` and `keys.pem`.
 */
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|br|tgz|mp3|mp4|webm|mov|wasm)$/i;

/** What a finding shows in place of private key material. */
const WITHHELD = "<withheld: private key material>";

/**
 * Each rule finds one credential class.
 *
 * `verify` lets a rule look past the regex — the JWT rule uses it to tell an
 * `anon` token (expected in the bundle, and NOT a finding) from a
 * `service_role` one (fatal). Without that distinction this gate would either
 * flag every build or miss the thing it exists to catch.
 *
 * The rules live in one module per credential class
 * (scripts/scan-build-rules-*.mjs). A file's findings come in this order.
 */
const RULES = [
  ...SUPABASE_KEY_RULES,
  ...CONNECTION_STRING_RULES,
  ...KEY_MATERIAL_RULES,
  ...TOKEN_RULES,
  ...NAME_RULES,
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
 * Runs every rule over one file's text and returns its findings.
 * Exported for measurement over trees that are not a build (node_modules).
 *
 * @param {string} rel  the file's path, as reported
 * @param {string} content
 */
export function scanText(rel, content) {
  const findings = [];
  // Each normalisation runs once per file, however many rules share it.
  const normalised = new Map();
  const textFor = (rule) => {
    if (!rule.normalize) return content;
    if (!normalised.has(rule.normalize)) {
      normalised.set(rule.normalize, rule.normalize(content));
    }
    return normalised.get(rule.normalize);
  };

  for (const rule of RULES) {
    const text = textFor(rule);
    rule.pattern.lastIndex = 0;
    const seen = new Set();
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (seen.has(value)) continue;
      seen.add(value);
      if (rule.verify && !rule.verify(value, text, match.index)) continue;
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
  return findings;
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
  let scripts = 0;
  let sourceMaps = 0;
  for (const file of walk(dir)) {
    const rel = relative(dir, file).split("\\").join("/");
    if (/\.[cm]?js$/i.test(rel)) scripts += 1;
    if (/\.map$/i.test(rel)) sourceMaps += 1;

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

    findings.push(...scanText(rel, content));

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

  return { scanned, scripts, sourceMaps, findings };
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

  if (result.scripts > 0 && result.sourceMaps === 0) {
    // Not a finding: a build without maps is not a leak. But the name rules
    // read a `VITE_` name only where the build keeps it, which is mostly the
    // maps, so say what this pass could not see.
    console.error(
      "\nnote: this build ships scripts and no source map, so a `VITE_` variable's NAME mostly does not survive into it " +
        "and privileged-vite-variable / browser-model-provider-variable see little. The source-level checks " +
        "(scripts/test/scan-build-artifacts.test.mjs, engine/models/providerSecretsBoundary.test.ts) still hold the build inputs.",
    );
  }

  if (blocking.length > 0) {
    console.error(
      "\nA server-side credential is present in a browser artifact. Do not deploy this build. " +
        "Rotate the credential, then find the variable: only `VITE_`-prefixed values are meant to reach the bundle.",
    );
    if (blocking.some((f) => f.rule === "browser-model-provider-variable")) {
      console.error(
        "A model provider variable carries the `VITE_` prefix. Provider credentials and configuration are backend-only: " +
          "drop the prefix and let the worker read it from its own environment.",
      );
    }
    if (blocking.some((f) => f.rule === "privileged-vite-variable")) {
      console.error(
        "A server secret carries the `VITE_` prefix, so Vite hands its value to every browser: " +
          "drop the prefix, keep the value in the server's environment, and rotate it.",
      );
    }
    process.exit(1);
  }
}
