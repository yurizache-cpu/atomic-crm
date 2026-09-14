#!/usr/bin/env node
// Keeps the committed DEVELOPMENT JWT signing key inside local tooling.
//
//   node scripts/dev-signing-key.mjs                      # repository guard (CI)
//   node scripts/dev-signing-key.mjs --project-ref <ref>  # deploy guard: does that
//                                                         # Supabase project trust it?
//   node scripts/dev-signing-key.mjs --linked             # the same, for the project
//                                                         # `supabase link` recorded
//   node scripts/dev-signing-key.mjs --remote <url>       # the same, for any URL
//
// WHY THIS EXISTS. `supabase/signing_keys.json` is upstream's development key
// and it holds the PRIVATE component. The Phase 1B-S audit measured what that
// means: a JWT signed with it and claiming `role: service_role` is accepted by
// PostgREST and bypasses RLS. The local Supabase CLI needs the file
// (`signing_keys_path`), so it stays. Hosted projects generate their own keys;
// what must never happen is a hosted project, a deployed function or a
// published build coming to trust or carry THIS one. Until the Phase 1B-S
// closure that rested on a sentence in CLAUDE.md (SEC-1BS-04,
// docs/SECURITY_AUDIT_1BS_REPORT.md).
//
// WHAT IT CHECKS, one rule per way the key could escape:
//   dev-key-unidentifiable       the key file is tracked but unreadable, so the
//                                copy rules would pass vacuously
//   dev-key-unpinned             the key file holds a key whose public half is
//                                not pinned in KNOWN_DEVELOPMENT_PUBLIC_KEYS
//   dev-key-material-copied      its private component is in another tracked
//                                file: verbatim, as base64 or hex, or as PEM
//   dev-key-public-copied        its public component is in another tracked
//                                file (a function pinning the development JWKS)
//   dev-key-referenced           something outside local/test tooling names the
//                                key file
//   remote-config-uses-key-file  a [remotes.*] Supabase config (a hosted branch)
//                                points at a signing key file
//   direct-pages-publish         something publishes to GitHub Pages without
//                                scripts/publish-pages.mjs, which scans first
//   deploy-without-key-check     a workflow job, a make target or any other file
//                                pushes to Supabase before a blocking key check
//   --project-ref/--linked/--remote  the hosted project's JWKS lists the key
//
// WHAT IT DOES NOT NEED TO CHECK. No Supabase CLI command uploads signing keys:
// `config push` builds its auth body without them (the field is `toml:"-"`),
// and `link`, `db push` and `functions deploy` call no signing-key endpoint.
// A hosted project comes to trust a key only when a person imports it through
// the dashboard or the Management API. No repository rule can see that, which
// is why the deploy asks the project itself.
//
// WHAT IT DOES NOT TRY TO CHECK. A copy split across strings, encrypted or
// compressed. These rules catch mistakes. An insider hiding the key from the
// guard is a different threat, and the deploy-time JWKS check is the backstop.
//
// NOTHING SECRET IS PRINTED. A key is named by its RFC 7638 thumbprint, which
// is computed from public members only. Private members stay inside a closure
// and are used for comparison and nothing else: not in a return value, not in
// an error message, not in a test assertion.

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleLoads, parseSource } from "./source-facts.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const DEV_SIGNING_KEYS_FILE = "supabase/signing_keys.json";

/**
 * The committed key's PUBLIC half, pinned. The private file may one day leave
 * this checkout, but the key stays public for good in upstream's history and
 * in this repository's: a project that imported it must still be refused, and a
 * function that trusts it must still be caught. A test holds this equal to the
 * file for as long as the file exists.
 */
export const KNOWN_DEVELOPMENT_PUBLIC_KEYS = Object.freeze([
  Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: "1-VNw_pBldndnL5Xlzqdtf2rmFokpUkLUKD8jtouVWQ",
    y: "EHpnelplHQUvJZiG5METV7NTs2muYkEBr9YWcF9KqKM",
  }),
]);

/** Secret JWK members (RFC 7518 §6.2.2, §6.3.2; RFC 8037 §2). */
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"];
const PUBLIC_KEY_MEMBERS = ["x", "y", "n"];
/** RFC 7638 §3.2: the required members, in lexicographic order. */
const THUMBPRINT_MEMBERS = {
  EC: ["crv", "kty", "x", "y"],
  OKP: ["crv", "kty", "x"],
  RSA: ["e", "kty", "n"],
};
/** Anything shorter is not key material, and would match by coincidence. */
const MIN_MATERIAL_LENGTH = 16;
const PEM_PRIVATE_KEY =
  /-----BEGIN ((?:[A-Z]+ )?)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;

/** RFC 7638 JWK thumbprint. Public members only, so safe to print and pin. */
export function jwkThumbprint(jwk) {
  const members = THUMBPRINT_MEMBERS[jwk?.kty];
  if (!members) {
    throw new Error(`unsupported JWK key type: ${String(jwk?.kty)}`);
  }
  const canonical = {};
  for (const member of members) {
    if (typeof jwk[member] !== "string") {
      throw new Error(`JWK is missing its "${member}" member`);
    }
    canonical[member] = jwk[member];
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("base64url");
}

/** The ways the same private bytes are commonly written down. */
const encodingsOf = (base64url) => {
  const bytes = Buffer.from(base64url, "base64url");
  const base64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  return [base64url, base64, base64.replace(/=+$/, ""), hex, hex.toUpperCase()];
};

/** Thumbprints of every parseable PEM private key in `text`. */
const pemThumbprints = (text) => {
  if (!text.includes("PRIVATE KEY-----")) return [];
  return [...text.matchAll(PEM_PRIVATE_KEY)].flatMap(([block]) => {
    try {
      // A PEM kept inside a string literal carries `\n` escapes.
      const pem = block.replace(/(?:\\r)?\\n/g, "\n");
      return [jwkThumbprint(createPrivateKey(pem).export({ format: "jwk" }))];
    } catch {
      return [];
    }
  });
};

const readKeyFile = (path) => {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Deliberately not the parser's message: V8 quotes the offending text.
    throw new Error(`${DEV_SIGNING_KEYS_FILE} is not valid JSON`);
  }
  return Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.keys)
      ? parsed.keys
      : [parsed];
};

/**
 * Loads the key file plus the pinned public keys, without exposing either.
 * Returns null only when there is neither a file nor a pinned key.
 *
 * The returned object holds thumbprints, counts and predicates. Printing it,
 * logging it or failing an assertion on it reveals no private member.
 */
export function loadDevSigningKeys(
  path = join(REPO_ROOT, DEV_SIGNING_KEYS_FILE),
  { pinned = KNOWN_DEVELOPMENT_PUBLIC_KEYS } = {},
) {
  const fileKeys = existsSync(path) ? readKeyFile(path) : [];
  if (fileKeys.length === 0 && pinned.length === 0) return null;

  const secrets = [];
  const publicValues = [];
  let privateMemberCount = 0;
  for (const jwk of [...fileKeys, ...pinned]) {
    for (const member of PRIVATE_MEMBERS) {
      const value = jwk?.[member];
      if (typeof value === "string" && value.length >= MIN_MATERIAL_LENGTH) {
        privateMemberCount += 1;
        secrets.push(...encodingsOf(value));
      }
    }
    for (const member of PUBLIC_KEY_MEMBERS) {
      const value = jwk?.[member];
      if (typeof value === "string" && value.length >= MIN_MATERIAL_LENGTH) {
        publicValues.push(value);
      }
    }
  }
  const fileThumbprints = fileKeys.map(jwkThumbprint);
  const pinnedThumbprints = pinned.map(jwkThumbprint);
  const thumbprints = [...new Set([...fileThumbprints, ...pinnedThumbprints])];

  return Object.freeze({
    thumbprints: Object.freeze(thumbprints),
    fileThumbprints: Object.freeze(fileThumbprints),
    pinnedThumbprints: Object.freeze(pinnedThumbprints),
    privateMemberCount,
    containsPrivateMaterial: (text) =>
      secrets.some((s) => text.includes(s)) ||
      pemThumbprints(text).some((t) => thumbprints.includes(t)),
    containsPublicKey: (text) => publicValues.some((v) => text.includes(v)),
    isDevKey: (jwk) => {
      try {
        return thumbprints.includes(jwkThumbprint(jwk));
      } catch {
        return false;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Repository guard: naming and copying the key
// ---------------------------------------------------------------------------

const REFERENCE = /signing_keys/i;
/** Plain Markdown may name the file. MDX is compiled, and can import it. */
const PLAIN_MARKDOWN = /\.md$/i;
/** Prose about a command is not the command. */
const ANY_MARKDOWN = /\.mdx?$/i;
/** The guards have to name the file, and describe what they refuse. */
const GUARD_FILES = new Set([
  "scripts/dev-signing-key.mjs",
  "scripts/test/dev-signing-key.test.mjs",
  "scripts/scan-build-artifacts.mjs",
  "scripts/test/scan-build-artifacts.test.mjs",
]);
/**
 * The production-scope guard's test quotes the deploy commands it refuses, as
 * fixtures. It is exempt from the deploy-order rule only, by path, and only
 * while every module it loads is on FIXTURE_IMPORTS and no module name is
 * computed, so it cannot gain an unreviewed way to run a command. Every
 * signing-key rule still applies to it.
 */
const DEPLOY_RULE_FIXTURE_FILES = new Set([
  "scripts/test/production-scope.test.mjs",
]);
const FIXTURE_IMPORTS = new Set([
  "./production-scope-helpers.mjs",
  "vitest",
  "../dev-signing-key.mjs",
  "../production-scope.mjs",
]);
const loadsOnlyFixtureImports = (path, content) => {
  const { imports, computed } = moduleLoads(parseSource(path, content));
  return (
    computed.length === 0 &&
    imports.every(({ specifier }) => FIXTURE_IMPORTS.has(specifier))
  );
};
/**
 * Every other permitted mention, LINE BY LINE, so that a new line in an
 * otherwise-permitted file (a deploy target in the makefile, a remote in
 * config.toml) is still a violation.
 */
const LOCAL_TOOLING_LINES = {
  // The local Supabase CLI stack.
  "supabase/config.toml": [/^signing_keys_path = "\.\/signing_keys\.json"$/],
  // The isolated E2E stack (project atomic-crm-e2e).
  "supabase/config.e2e.toml": [
    /^signing_keys_path = "\.\/signing_keys\.json"$/,
  ],
  // `start-supabase-e2e` copies it into the gitignored .supabase-e2e workdir.
  makefile: [
    /^cp supabase\/signing_keys\.json \.supabase-e2e\/supabase\/signing_keys\.json$/,
  ],
  // Per-slot local E2E stacks for the agent harness.
  ".claude/scripts/e2e-smoke.sh": [
    /^for f in seed\.sql signing_keys\.json; do$/,
  ],
};

function unexpectedReferences(path, content) {
  if (PLAIN_MARKDOWN.test(path) || GUARD_FILES.has(path)) return [];
  const allowed = LOCAL_TOOLING_LINES[path] ?? [];
  return content.split("\n").flatMap((raw, index) => {
    const line = raw.trim();
    if (!REFERENCE.test(line) || allowed.some((re) => re.test(line))) {
      return [];
    }
    return [
      {
        rule: "dev-key-referenced",
        file: path,
        line: index + 1,
        detail: "names the development signing key outside local/test tooling",
      },
    ];
  });
}

/**
 * A `[remotes.<name>]` table configures a HOSTED branch. The line-level
 * allowlist above cannot tell `signing_keys_path` under `[auth]` from the same
 * line under a remote, so this does. No CLI release honours a key file for a
 * remote today; refusing one keeps that true if a release ever does, and a
 * remote that names a key file states the exact intent this guard exists for.
 */
function remoteConfigKeyFile(path, content) {
  let table = "";
  return content.split("\n").flatMap((raw, index) => {
    const line = raw.replace(/#.*$/, "").trim();
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      table = header[1];
      return [];
    }
    if (!table.startsWith("remotes.") || !/^signing_keys_path\s*=/.test(line)) {
      return [];
    }
    return [
      {
        rule: "remote-config-uses-key-file",
        file: path,
        line: index + 1,
        detail: `[${table}] points a hosted project at a signing key file`,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Repository guard: publishing and deploying
// ---------------------------------------------------------------------------

const PAGES_PUBLISHER = "scripts/publish-pages.mjs";
/** The spellings of "publish to GitHub Pages" refused outright. */
const PAGES_PUBLISH = [
  // `npx gh-pages …`, `npx --yes gh-pages@6 …`
  /\bnpx\s+(?:-{1,2}[\w-]+(?:=\S+)?\s+)*gh-pages(?:@\S+)?(?=[\s"'`);]|$)/,
  // a direct path to its binary
  /node_modules[\\/](?:\.bin[\\/]gh-pages|gh-pages[\\/]bin)\b/,
  // its API
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'`]gh-pages["'`]/,
  // a Pages deployment action
  /\buses:\s*["']?[\w.-]+\/[\w.-]*(?:gh-pages|deploy-pages)\b/,
];

/**
 * Every Pages publish goes through scripts/publish-pages.mjs, which scans the
 * directory and refuses to publish on a finding. Checking that a separate scan
 * step precedes each publish was this rule's first shape, and it failed open on
 * make targets, npm scripts, `--dist` and Pages actions.
 */
function directPagesPublishes(path, content) {
  if (
    ANY_MARKDOWN.test(path) ||
    path === PAGES_PUBLISHER ||
    GUARD_FILES.has(path)
  ) {
    return [];
  }
  return content.split("\n").flatMap((line, index) =>
    PAGES_PUBLISH.some((re) => re.test(line))
      ? [
          {
            rule: "direct-pages-publish",
            file: path,
            line: index + 1,
            detail:
              "publishes to GitHub Pages without scripts/publish-pages.mjs, the one path that scans what it ships",
          },
        ]
      : [],
  );
}

/**
 * A Supabase CLI push on one line. The CLI may be version-pinned
 * (`supabase@2.117.0`), called as an executable, and given flags, with or
 * without values, before the subcommand or between its words
 * (`supabase --debug db --db-url postgres://h/db push`).
 */
const CLI_FLAG = String.raw`\s+-{1,2}[\w-]+(?:=\S*|\s+(?!(?:db|functions|secrets|config)\b)[^\s-]\S*)?`;
const GROUP_FLAG = String.raw`\s+-{1,2}[\w-]+(?:=\S*|\s+(?!(?:push|deploy|set)\b)[^\s-]\S*)?`;
const SUPABASE_PUSH = new RegExp(
  String.raw`\bsupabase(?:@[^\s"'${"`"}]*)?(?:\.exe)?(?:${CLI_FLAG})*\s+(?:db(?:${GROUP_FLAG})*\s+push|functions(?:${GROUP_FLAG})*\s+deploy|secrets(?:${GROUP_FLAG})*\s+set|config(?:${GROUP_FLAG})*\s+push)\b`,
);
const KEY_CHECK =
  /\bdev-signing-key\.mjs\s+--(?:project-ref\s+\S|remote\s+\S|linked\b)/;

const indentOf = (line) => line.match(/^\s*/)[0].length;
const isComment = (line) => line.trim().startsWith("#");

const CONTINUE_ON_ERROR =
  /(?:^|[\s{,])(["']?)continue-on-error\1[ \t]*:[ \t]*((?:\$\{\{[^\n}]*\}\})?[^\n,}]*)/g;
const STATICALLY_FALSE =
  /^(?:false|False|FALSE|\$\{\{\s*false\s*\}\})[ \t]*(?:#.*)?$/;

/**
 * True when a step may carry on after it fails: any `continue-on-error` whose
 * value is not statically false. An expression counts as true, because GitHub
 * evaluates it at run time and no rule here can.
 */
export const mayContinueOnError = (text) =>
  [...text.matchAll(CONTINUE_ON_ERROR)].some(
    ([, , value]) => !STATICALLY_FALSE.test(value.trim()),
  );

/** A step that cannot fail cannot refuse anything. `${{ a || b }}` is not a fallback. */
export const isBlocking = (text, { makefile }) => {
  if (mayContinueOnError(text)) return false;
  // A replaced shell decides the exit status: `shell: sh -c 'exit 0' {0}`.
  if (!makefile && /^\s*(?:-\s+)?["']?shell["']?\s*:/m.test(text)) {
    return false;
  }
  const code = text.replace(/\$\{\{[\s\S]*?\}\}/g, "");
  if (/\|\|/.test(code)) return false;
  if (makefile && /^\t[@+]*-/.test(text)) return false;
  return true;
};

/** A workflow as jobs of steps, or null when it has no readable `jobs:` block. */
export function workflowUnits(lines) {
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsAt === -1) return null;

  const units = [];
  let jobIndent = null;
  let job = null;
  let stepsIndent = null;
  let stepIndent = null;
  let step = null;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isComment(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break; // the next top-level key ends `jobs:`
    jobIndent ??= indent;

    if (indent === jobIndent) {
      job = { unit: line.trim().replace(/:.*$/, ""), steps: [] };
      units.push(job);
      stepsIndent = stepIndent = step = null;
      continue;
    }
    if (!job) continue;

    const isStepsKey = /^\s*steps:\s*(?:#.*)?$/.test(line);
    const isItem = /^\s*-(?:\s|$)/.test(line);
    if (stepsIndent === null) {
      if (isStepsKey) stepsIndent = indent;
      continue;
    }
    if (stepIndent === null && isItem) stepIndent = indent;
    if (
      stepIndent === null ||
      indent < stepIndent ||
      (indent <= stepsIndent && !isItem)
    ) {
      // Left the steps list.
      stepsIndent = isStepsKey ? indent : null;
      stepIndent = step = null;
      continue;
    }
    if (isItem && indent === stepIndent) {
      step = { text: line, lines: [i + 1] };
      job.steps.push(step);
    } else if (step) {
      step.text += `\n${line}`;
      step.lines.push(i + 1);
    }
  }
  return units;
}

/**
 * A makefile as targets of recipe lines. make joins a recipe line that ends in
 * a backslash with the next one, so they are one step: a check there can be an
 * argument to another command, or a branch it skips.
 */
export function makefileUnits(lines) {
  const units = [];
  let target = null;
  let continued = null;
  lines.forEach((line, i) => {
    if (continued) {
      continued.text += `\n${line}`;
      continued.lines.push(i + 1);
      if (!line.endsWith("\\")) continued = null;
      return;
    }
    if (line.startsWith("\t")) {
      if (target && line.trim()) {
        const step = { text: line, lines: [i + 1] };
        target.steps.push(step);
        if (line.endsWith("\\")) continued = step;
      }
      return;
    }
    if (!line.trim() || isComment(line)) return;
    const header = line.match(/^([^:=\s#][^:=#]*?)\s*:(?![:=])/);
    target = header ? { unit: header[1].trim(), steps: [] } : null;
    if (target) units.push(target);
  });
  return units;
}

/**
 * Nothing pushes to Supabase before a blocking `dev-signing-key.mjs` check in
 * the same job or target. A file that pushes but whose order cannot be read —
 * not a workflow, not the makefile, or a workflow with no `jobs:` block — is a
 * violation, not a pass.
 */
function deployWithoutKeyCheck(path, content) {
  if (
    ANY_MARKDOWN.test(path) ||
    GUARD_FILES.has(path) ||
    (DEPLOY_RULE_FIXTURE_FILES.has(path) &&
      loadsOnlyFixtureImports(path, content))
  ) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const pushLines = lines.flatMap((line, i) =>
    !isComment(line) && SUPABASE_PUSH.test(line) ? [i + 1] : [],
  );
  if (pushLines.length === 0) return [];

  const violation = (line, detail) => ({
    rule: "deploy-without-key-check",
    file: path,
    line,
    detail,
  });
  const makefile = /(^|\/)(?:GNU)?[Mm]akefile$/.test(path);
  const units = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)
    ? workflowUnits(lines)
    : makefile
      ? makefileUnits(lines)
      : null;
  if (!units) {
    return [
      violation(
        pushLines[0],
        "pushes to Supabase from a file whose order no rule can read",
      ),
    ];
  }

  const violations = [];
  const covered = new Set();
  for (const { unit, steps } of units) {
    let checked = false;
    let reported = false;
    for (const step of steps) {
      step.lines.forEach((n) => covered.add(n));
      const pushAt = step.text.search(SUPABASE_PUSH);
      const checkAt = step.text.search(KEY_CHECK);
      if (
        checkAt !== -1 &&
        isBlocking(step.text, { makefile }) &&
        !(makefile && step.lines.length > 1) &&
        (pushAt === -1 || checkAt < pushAt)
      ) {
        checked = true;
      }
      if (pushAt !== -1 && !checked && !reported) {
        violations.push(
          violation(
            step.lines[0],
            `"${unit}" pushes to Supabase before a blocking development signing key check`,
          ),
        );
        reported = true;
      }
    }
  }
  for (const line of pushLines.filter((n) => !covered.has(n))) {
    violations.push(
      violation(line, "pushes to Supabase outside any step this rule can read"),
    );
  }
  return violations;
}

/**
 * @param {Array<{path: string, content: string}>} files  tracked files, POSIX paths
 * @param {{devKeys: ReturnType<typeof loadDevSigningKeys>}} options
 */
export function checkRepository(files, { devKeys }) {
  const violations = [];

  if (files.some((f) => f.path === DEV_SIGNING_KEYS_FILE)) {
    if (!(devKeys?.privateMemberCount > 0)) {
      violations.push({
        rule: "dev-key-unidentifiable",
        file: DEV_SIGNING_KEYS_FILE,
        detail:
          "the file is tracked but no private member could be read from it, so the copy check would pass vacuously",
      });
    }
    for (const thumbprint of devKeys?.fileThumbprints ?? []) {
      if (!devKeys.pinnedThumbprints.includes(thumbprint)) {
        violations.push({
          rule: "dev-key-unpinned",
          file: DEV_SIGNING_KEYS_FILE,
          detail: `key ${thumbprint} is not pinned in KNOWN_DEVELOPMENT_PUBLIC_KEYS, so it would stop being refused if the file were removed`,
        });
      }
    }
  }

  for (const { path, content } of files) {
    if (devKeys && path !== DEV_SIGNING_KEYS_FILE) {
      if (devKeys.containsPrivateMaterial(content)) {
        violations.push({
          rule: "dev-key-material-copied",
          file: path,
          detail: "contains the development signing key's private component",
        });
      } else if (!GUARD_FILES.has(path) && devKeys.containsPublicKey(content)) {
        violations.push({
          rule: "dev-key-public-copied",
          file: path,
          detail:
            "contains the development signing key's public component: whatever uses it trusts tokens anyone can mint",
        });
      }
    }
    violations.push(...unexpectedReferences(path, content));
    if (/\.toml$/i.test(path)) {
      violations.push(...remoteConfigKeyFile(path, content));
    }
    violations.push(...directPagesPublishes(path, content));
    violations.push(...deployWithoutKeyCheck(path, content));
  }
  return violations;
}

/** Cannot carry a usable key as text. Everything else is read, whatever its size. */
const BINARY =
  /\.(png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp3|mp4|webm|mov|wasm)$/i;

/** Every git-tracked text file, as it is in the working tree. */
export function readTrackedFiles(root = REPO_ROOT) {
  const listing = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split("\0")
    .filter(Boolean)
    .flatMap((path) => {
      if (BINARY.test(path)) return [];
      const full = join(root, path);
      // Tracked but deleted in the working tree: nothing to scan.
      if (!existsSync(full) || !statSync(full).isFile()) return [];
      return [{ path, content: readFileSync(full, "utf8") }];
    });
}

// ---------------------------------------------------------------------------
// Deploy guard: the hosted project's own answer
// ---------------------------------------------------------------------------

const JWKS_PATH = "/auth/v1/.well-known/jwks.json";
const PROJECT_REF = /^[a-z0-9]{20}$/;

/** The API URL of a hosted project, from the same ref `supabase link` takes. */
export function projectUrl(ref) {
  return PROJECT_REF.test(ref ?? "") ? `https://${ref}.supabase.co` : null;
}

/** The project ref `supabase link` recorded in this checkout, if any. */
export function linkedProjectRef(root = REPO_ROOT) {
  const file = join(root, "supabase", ".temp", "project-ref");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

/**
 * Asks a Supabase project which keys it trusts, and refuses the development one.
 *
 * The repository rules above cannot see a key imported through the dashboard.
 * This can: the JWKS endpoint is the key set the project's Auth server — and
 * every edge function verifying tokens against it — actually accepts.
 *
 * Fails CLOSED. Anything that prevents an answer is `unverified`, never `pass`.
 */
export async function checkRemoteJwks(
  supabaseUrl,
  { devKeys = loadDevSigningKeys(), fetchImpl = fetch, timeoutMs = 15000 } = {},
) {
  if (!devKeys) {
    return {
      status: "unverified",
      detail:
        "no development key is known (no key file and no pinned public key), so there is nothing to compare against",
    };
  }

  let url;
  try {
    url = new URL(JWKS_PATH, supabaseUrl);
  } catch {
    return { status: "unverified", detail: "the project URL is not a URL" };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      status: "unverified",
      detail: `the JWKS endpoint could not be reached (${error?.name ?? "error"})`,
    };
  }
  if (!response.ok) {
    return {
      status: "unverified",
      detail: `the JWKS endpoint answered HTTP ${response.status}`,
    };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return {
      status: "unverified",
      detail: "the JWKS endpoint did not answer with JSON",
    };
  }
  if (!Array.isArray(body?.keys)) {
    return {
      status: "unverified",
      detail: "the JWKS response has no keys array",
    };
  }

  // Matched by thumbprint, not `kid`: an imported key need not keep its id.
  // A key that cannot be fingerprinted cannot be ruled out.
  const unidentifiable = body.keys.filter((jwk) => {
    try {
      jwkThumbprint(jwk);
      return false;
    } catch {
      return true;
    }
  });
  if (unidentifiable.length > 0) {
    return {
      status: "unverified",
      detail: `${unidentifiable.length} published key(s) could not be fingerprinted`,
    };
  }
  if (body.keys.some((jwk) => devKeys.isDevKey(jwk))) {
    return {
      status: "fail",
      detail: `the project trusts the development signing key (thumbprint ${devKeys.thumbprints.join(", ")}). Anyone who can read this repository can mint a service_role token for it.`,
    };
  }
  if (body.keys.length === 0) {
    return {
      status: "pass",
      detail:
        "the project publishes no asymmetric signing keys (legacy shared-secret JWTs only), so it cannot verify a token signed with the development key",
    };
  }
  return {
    status: "pass",
    detail: `${body.keys.length} published key(s), none of them the development key`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isEntryPoint = async () => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

const EXIT = { pass: 0, fail: 1, unverified: 2 };
const USAGE =
  "usage: node scripts/dev-signing-key.mjs [--project-ref <ref> | --linked | --remote <supabase-url>]";

/** The URL a deploy-guard invocation names, or an error message. */
const targetOf = ([mode, value, ...rest]) => {
  if (mode === "--linked") {
    if (value !== undefined) return { error: USAGE };
    const url = projectUrl(linkedProjectRef());
    return url
      ? { url }
      : {
          error:
            "no linked project is recorded in supabase/.temp/project-ref. Run `npx supabase link` first, or pass --project-ref <ref>.",
        };
  }
  if (!value || rest.length > 0) return { error: USAGE };
  const url = mode === "--remote" ? value : projectUrl(value);
  return url ? { url } : { error: `"${value}" is not a Supabase project ref` };
};

if (await isEntryPoint()) {
  const args = process.argv.slice(2);

  if (["--project-ref", "--linked", "--remote"].includes(args[0])) {
    const target = targetOf(args);
    if (target.error) {
      console.error(`${target.error}\nNothing was verified. Refusing.`);
      process.exit(EXIT.unverified);
    }
    const result = await checkRemoteJwks(target.url);
    const summary = `[${result.status}] hosted signing keys: ${result.detail}`;
    if (result.status === "pass") {
      process.stdout.write(`${summary}\n`);
    } else {
      console.error(summary);
    }
    process.exit(EXIT[result.status]);
  }

  if (args.length > 0) {
    console.error(USAGE);
    process.exit(EXIT.unverified);
  }

  let devKeys;
  let violations;
  try {
    devKeys = loadDevSigningKeys();
    violations = checkRepository(readTrackedFiles(), { devKeys });
  } catch (error) {
    console.error(error.message);
    process.exit(EXIT.unverified);
  }

  for (const v of violations) {
    console.error(
      `[${v.rule}] ${v.file}${v.line ? `:${v.line}` : ""}: ${v.detail}`,
    );
  }
  if (violations.length > 0) {
    console.error(
      `\n${violations.length} way(s) the development signing key could leave local tooling. ` +
        "Hosted Supabase projects must use their own keys; see SEC-1BS-04.",
    );
    process.exit(EXIT.fail);
  }
  process.stdout.write(
    `development signing key confined to local tooling (thumbprint ${devKeys?.thumbprints.join(", ") ?? "none"})\n`,
  );
}
