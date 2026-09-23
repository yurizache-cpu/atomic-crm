// Fixture builders shared by the build scanner's tests
// (scripts/test/scan-build-*.test.mjs). Not a test file itself.
//
// Every fixture built here is SYNTHETIC. No real credential is stored in this
// repository, which is the whole point of a secret gate whose rules are
// patterns rather than values.
//
// Every credential-shaped fixture is also ASSEMBLED AT RUNTIME (a split prefix
// and a generated body), so this file holds no literal that this scanner, a
// push-protection scanner or the repository's own guards would read as a
// credential. And no assertion names a fixture value: a failing assertion
// prints its arguments, so they compare rule ids, labels, counts and booleans.

import { afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanDirectory } from "../scan-build-artifacts.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The running test's scratch build directory. A live binding: each test in a
 * file that calls scratchBuildPerTest() gets a fresh, empty one.
 */
export let dir;

/** Gives each test in the calling file its own scratch build directory. */
export const scratchBuildPerTest = () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scan-build-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
};

export const write = (name, content) => {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
};

export const scan = () => scanDirectory(dir, { devSigningKeys: null }).findings;
export const rulesByFile = (findings) =>
  findings.map((f) => `${f.rule} ${f.severity} ${f.file}`).sort();

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const HEX = "0123456789abcdef";

/**
 * A deterministic synthetic credential body, different for every tag and
 * without repeats, so an 8-character window of it cannot show up in a report
 * by chance.
 */
export const synthetic = (tag, length, alphabet = ALNUM) => {
  let state = 7;
  for (const c of tag) state = (state * 31 + c.charCodeAt(0)) % 2147483647;
  let out = "";
  for (let i = 0; i < length; i += 1) {
    state = (state * 48271) % 2147483647 || 1;
    out += alphabet[state % alphabet.length];
  }
  return out;
};

/** Builds a syntactically valid JWT with the given role (none if undefined).
 *  Unsigned — the gate reads the payload, it does not verify signatures. */
export const jwt = (role, tag = `jwt-${role}`) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ iss: "test", role })}.${synthetic(tag, 43, BASE64URL)}`;
};

export const sbSecret = (tag) => "sb" + "_secret_" + synthetic(tag, 24);
export const githubToken = (tag) => "gh" + "p_" + synthetic(tag, 36);
export const metaToken = (tag, length = 160) =>
  "EA" + "A" + synthetic(tag, length);
export const pem = (label, body = "AAAA") =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
export const PRIVATE_KEY = "PRIVATE" + " KEY";
export const POSTGRES_SCHEME = "postgres" + "ql:";
export const postgresUrl = (user, password, host = "db.example.invalid:5432") =>
  `${POSTGRES_SCHEME}//${user}:${password}@${host}/postgres`;
export const BACKSLASH = "\\";
/** A synthetic value holding the escapes a JavaScript string can carry: an
 *  escaped backslash, `\n` and `\/`. */
export const escapedValue = (tag) =>
  [
    synthetic(`${tag}-a`, 10),
    synthetic(`${tag}-b`, 6),
    synthetic(`${tag}-c`, 6),
    synthetic(`${tag}-d`, 6),
  ].join(BACKSLASH + BACKSLASH) +
  BACKSLASH +
  "n" +
  synthetic(`${tag}-e`, 6) +
  BACKSLASH +
  "/" +
  synthetic(`${tag}-f`, 6);
export const sourceMap = (...sources) =>
  JSON.stringify({ sourcesContent: sources });

/** A `VITE_` variable name, assembled at runtime: the source-level boundary
 *  test (engine/models/providerSecretsBoundary.test.ts) reads this file, and a
 *  literal provider name here would be a finding there. */
export const viteName = (suffix) => "VITE" + "_" + suffix;

export const BROWSER_PROVIDER = "browser-model-provider-variable";
export const PRIVILEGED_VITE = "privileged-vite-variable";
export const ASSIGNED = "assigned-server-secret";

/** Every run of `size` consecutive characters of a value. */
const windows = (value, size = 8) =>
  Array.from({ length: Math.max(0, value.length - size + 1) }, (_, i) =>
    value.slice(i, i + size),
  );

/** The LABELS of planted values the text reveals, whole or by any 8-char run. */
export const revealed = (text, planted) =>
  Object.entries(planted)
    .filter(([, value]) => windows(value).some((w) => text.includes(w)))
    .map(([label]) => label);

/** Every spelling of `NAME = value` a build produces, one file each. */
export const assignmentForms = (name, value) => ({
  "plain.js": `const c={${name}:"${value}"};`,
  "spaced.js": `const c = { ${name} : '${value}' };`,
  "template.js": `c.${name}=\`${value}\`;`,
  "inlined.js": `const e=${JSON.stringify({ BASE_URL: "/", [name]: value })};`,
  "quoted.js.map": sourceMap(`const e = {"${name}": "${value}"};`),
  "assigned.js.map": sourceMap(`${name}="${value}"`),
  "dotenv.js.map": sourceMap(`# env\r\n${name}=${value}\r\n`),
  "quoted-dotenv.js.map": sourceMap(`# env\n${name}="${value}"\n`),
  "dotenv.txt": `# env\n${name}=${value}\n`,
});

/** Brief §15: the names scan:build learns in Phase 2C. */
export const PHASE_2C_SERVER_NAMES = [
  "ADMIN_DATABASE_URL",
  "OPS_GATEWAY_PASSWORD",
  "OPS_GATEWAY_DATABASE_URL",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
];
export const EARLIER_SERVER_NAMES = [
  "SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_PASSWORD",
  "POSTMARK_WEBHOOK_PASSWORD",
  "SUPABASE_ACCESS_TOKEN",
  "JWT_SECRET",
  "DEPLOY_TOKEN",
  "OPS_WORKER_PASSWORD",
  "OPS_WORKER_DATABASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

/** Every `VITE_` name the files that feed a build read today. */
export const repositoryViteNames = () => {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  )
    .split("\0")
    .filter(
      (file) =>
        /^(src|demo|\.github)\//.test(file) ||
        /(^|\/)\.env(\.[\w.-]+)?$/.test(file) ||
        /^vite(st)?(\.[\w-]+)?\.config\.[cm]?[jt]s$/.test(file) ||
        file === "index.html" ||
        file === "package.json" ||
        /^makefile$/i.test(file),
    )
    .filter((file) => !/\.(png|jpe?g|gif|webp|ico|svg|woff2?)$/i.test(file));
  const names = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      continue; // listed but deleted in the working tree
    }
    for (const m of text.matchAll(/VITE_[A-Za-z0-9_]+/g)) names.add(m[0]);
  }
  return [...names].sort();
};
