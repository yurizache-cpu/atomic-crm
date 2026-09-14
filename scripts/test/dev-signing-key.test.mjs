import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  DEV_SIGNING_KEYS_FILE,
  KNOWN_DEVELOPMENT_PUBLIC_KEYS,
  checkRemoteJwks,
  checkRepository,
  jwkThumbprint,
  linkedProjectRef,
  loadDevSigningKeys,
  projectUrl,
  readTrackedFiles,
} from "../dev-signing-key.mjs";

// Every key below is GENERATED AT TEST TIME. The committed development key is
// touched only through `loadDevSigningKeys`, and nothing derived from its
// private component reaches `expect`: a failing assertion prints its
// arguments, and a CI log is a published artifact too.

const SCRIPT = fileURLToPath(
  new URL("../dev-signing-key.mjs", import.meta.url),
);

// RFC 7638 thumbprint of the committed development key. Computed from public
// members only (crv, kty, x, y), so it is safe to pin. If it changes, the key
// file was replaced: find out with what before updating the pin.
const DEV_KEY_THUMBPRINT = "CNdS5CVgQ-lJMyWfcK9MheIqmMJkQyQJw8_ZOzqKNVM";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dev-key-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A synthetic key set shaped exactly like the committed development key file,
 * loaded with its own public half pinned — as the real one is.
 */
const syntheticKeySet = () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { d, x, y, crv } = privateKey.export({ format: "jwk" });
  const publicJwk = {
    kty: "EC",
    kid: randomUUID(),
    use: "sig",
    alg: "ES256",
    crv,
    x,
    y,
  };
  const text = JSON.stringify([
    { ...publicJwk, key_ops: ["sign", "verify"], ext: true, d },
  ]);
  const path = join(dir, `keys-${randomUUID()}.json`);
  writeFileSync(path, text);
  return {
    d,
    text,
    path,
    privateKey,
    publicJwk,
    devKeys: loadDevSigningKeys(path, { pinned: [publicJwk] }),
  };
};

const unrelatedPublicJwk = () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...publicKey.export({ format: "jwk" }), kid: "unrelated" };
};

const describeViolations = (violations) =>
  violations.map((v) => `${v.rule} ${v.file}${v.line ? `:${v.line}` : ""}`);

const check = (path, content, devKeys = null) =>
  describeViolations(checkRepository([{ path, content }], { devKeys }));

describe("jwkThumbprint", () => {
  it("matches the RFC 7638 §3.1 example", () => {
    const rfcExample = {
      kty: "RSA",
      e: "AQAB",
      alg: "RS256",
      kid: "2011-04-29",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
    };
    expect(jwkThumbprint(rfcExample)).toBe(
      "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs",
    );
  });

  it("is the same for a private key and its public half, whatever the kid", () => {
    const key = syntheticKeySet();
    const [privateJwk] = JSON.parse(key.text);
    expect(jwkThumbprint({ ...privateJwk, kid: "renamed" })).toBe(
      jwkThumbprint(key.publicJwk),
    );
  });

  it("refuses a key it cannot fingerprint instead of guessing", () => {
    expect(() => jwkThumbprint({ kty: "oct", k: "c2VjcmV0" })).toThrow(
      /unsupported/,
    );
    expect(() => jwkThumbprint({ kty: "EC", crv: "P-256" })).toThrow(/missing/);
  });
});

describe("loading a key set never exposes its private component", () => {
  it("identifies the key without keeping the secret anywhere printable", () => {
    const key = syntheticKeySet();
    expect(key.devKeys.privateMemberCount).toBe(1);
    const printed = [
      JSON.stringify(key.devKeys),
      inspect(key.devKeys, { depth: 10, showHidden: true }),
    ].join("\n");
    expect(printed.includes(key.d)).toBe(false);
  });

  it("recognises the private component however it was written down", () => {
    const key = syntheticKeySet();
    const bytes = Buffer.from(key.d, "base64url");
    const pkcs8 = key.privateKey.export({ type: "pkcs8", format: "pem" });
    const copies = {
      base64url: `const s = "${key.d}";`,
      base64: `KEY=${bytes.toString("base64")}`,
      hex: `const s = "${bytes.toString("hex").toUpperCase()}";`,
      pkcs8: pkcs8,
      sec1: key.privateKey.export({ type: "sec1", format: "pem" }),
      "PEM inside a string literal": `export const pem = ${JSON.stringify(pkcs8)};`,
    };
    const recognised = Object.entries(copies).map(([encoding, text]) => [
      encoding,
      key.devKeys.containsPrivateMaterial(text),
    ]);
    expect(recognised).toEqual(
      Object.keys(copies).map((encoding) => [encoding, true]),
    );
  });

  it("does not mistake another private key for the development key", () => {
    const key = syntheticKeySet();
    const { privateKey: other } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const pem = other.export({ type: "pkcs8", format: "pem" });
    expect(key.devKeys.containsPrivateMaterial(pem)).toBe(false);
  });

  it("recognises its public key", () => {
    const key = syntheticKeySet();
    expect(key.devKeys.isDevKey(key.publicJwk)).toBe(true);
    expect(key.devKeys.containsPublicKey(JSON.stringify(key.publicJwk))).toBe(
      true,
    );
    expect(key.devKeys.isDevKey(unrelatedPublicJwk())).toBe(false);
  });

  it("does not quote a malformed key file in its error", () => {
    const path = join(dir, "broken.json");
    writeFileSync(path, '[{"d":"SYNTHETICSECRETVALUE0123456789", oops');
    let message = "";
    try {
      loadDevSigningKeys(path);
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message.includes("SYNTHETICSECRET")).toBe(false);
  });

  it("still knows the development key when the private file is gone", () => {
    // The key stays public in git history; removing the file must not turn
    // the deploy check into a pass.
    const devKeys = loadDevSigningKeys(join(dir, "absent.json"));
    expect(devKeys?.privateMemberCount).toBe(0);
    expect(devKeys?.isDevKey(KNOWN_DEVELOPMENT_PUBLIC_KEYS[0])).toBe(true);
  });

  it("returns null only when there is neither a file nor a pinned key", () => {
    expect(
      loadDevSigningKeys(join(dir, "absent.json"), { pinned: [] }),
    ).toBeNull();
  });
});

describe("the repository guard: copies of the key", () => {
  it("flags the private component copied into a file that deploys", () => {
    const key = syntheticKeySet();
    const violations = checkRepository(
      [
        { path: DEV_SIGNING_KEYS_FILE, content: key.text },
        {
          path: "supabase/functions/_shared/signing.ts",
          content: `export const key = "${key.d}";`,
        },
      ],
      { devKeys: key.devKeys },
    );
    expect(describeViolations(violations)).toEqual([
      "dev-key-material-copied supabase/functions/_shared/signing.ts",
    ]);
    expect(JSON.stringify(violations).includes(key.d)).toBe(false);
  });

  it("flags the private component re-encoded as PEM in a tracked env file", () => {
    const key = syntheticKeySet();
    const pem = key.privateKey.export({ type: "pkcs8", format: "pem" });
    expect(
      check(
        "supabase/functions/.env",
        `SIGNING_KEY="${pem.replace(/\n/g, "\\n")}"`,
        key.devKeys,
      ),
    ).toEqual(["dev-key-material-copied supabase/functions/.env"]);
  });

  it("flags the public component pinned in a function", () => {
    // A function that verifies tokens against this JWKS accepts any token
    // minted with the committed private key.
    const key = syntheticKeySet();
    const { x, y, crv, kty } = key.publicJwk;
    expect(
      check(
        "supabase/functions/_shared/jwks.ts",
        `export const JWKS = { keys: [{ kty: "${kty}", crv: "${crv}", x: "${x}", y: "${y}" }] };`,
        key.devKeys,
      ),
    ).toEqual(["dev-key-public-copied supabase/functions/_shared/jwks.ts"]);
  });

  it("refuses to pass vacuously when it cannot read the key it protects", () => {
    const key = syntheticKeySet();
    const publicOnly = join(dir, "public-only.json");
    writeFileSync(publicOnly, JSON.stringify([key.publicJwk]));
    const tracked = [{ path: DEV_SIGNING_KEYS_FILE, content: "[]" }];

    expect(
      checkRepository(tracked, {
        devKeys: loadDevSigningKeys(publicOnly, { pinned: [key.publicJwk] }),
      }).map((v) => v.rule),
    ).toEqual(["dev-key-unidentifiable"]);
    expect(
      checkRepository(tracked, { devKeys: null }).map((v) => v.rule),
    ).toEqual(["dev-key-unidentifiable"]);
  });

  it("flags a key file whose public half is not pinned", () => {
    const key = syntheticKeySet();
    const unpinned = loadDevSigningKeys(key.path, { pinned: [] });
    expect(
      checkRepository([{ path: DEV_SIGNING_KEYS_FILE, content: key.text }], {
        devKeys: unpinned,
      }).map((v) => v.rule),
    ).toEqual(["dev-key-unpinned"]);
  });
});

describe("the repository guard: naming the key file", () => {
  it("flags a workflow that names the key file", () => {
    expect(
      check(
        ".github/workflows/deploy.yml",
        "jobs:\n    deploy:\n        steps:\n            - run: cp supabase/signing_keys.json build/",
      ),
    ).toEqual(["dev-key-referenced .github/workflows/deploy.yml:4"]);
  });

  it("flags a new line in a file whose existing mention is permitted", () => {
    const makefile = [
      "start-supabase-e2e:",
      "\tcp supabase/signing_keys.json .supabase-e2e/supabase/signing_keys.json",
      "deploy-keys:",
      "\tscp supabase/signing_keys.json prod:/etc/supabase/",
    ].join("\n");
    expect(check("makefile", makefile)).toEqual([
      "dev-key-referenced makefile:4",
    ]);
  });

  it("flags application code that names the key file", () => {
    expect(
      check(
        "src/lib/verifyToken.ts",
        'import keys from "../../supabase/signing_keys.json";',
      ),
    ).toEqual(["dev-key-referenced src/lib/verifyToken.ts:1"]);
  });

  it("flags an MDX page that imports the key file, since MDX is compiled", () => {
    expect(
      check(
        "doc/src/content/docs/developers/keys.mdx",
        'import keys from "../../../../../supabase/signing_keys.json";',
      ),
    ).toEqual([
      "dev-key-referenced doc/src/content/docs/developers/keys.mdx:1",
    ]);
  });

  it("accepts local tooling and plain Markdown", () => {
    const violations = checkRepository(
      [
        {
          path: "supabase/config.toml",
          content: '[auth]\r\nsigning_keys_path = "./signing_keys.json"\r\n',
        },
        {
          path: "makefile",
          content:
            "\tcp supabase/signing_keys.json .supabase-e2e/supabase/signing_keys.json",
        },
        {
          path: ".claude/scripts/e2e-smoke.sh",
          content: "for f in seed.sql signing_keys.json; do",
        },
        {
          path: "docs/SECURITY.md",
          content: "Never reuse supabase/signing_keys.json.",
        },
      ],
      { devKeys: null },
    );
    expect(violations).toEqual([]);
  });

  it("flags a hosted branch config pointing at a key file, even with a permitted line", () => {
    const config = [
      "[auth]",
      'signing_keys_path = "./signing_keys.json"',
      "[remotes.production]",
      'project_id = "abcdefghijklmnop"',
      "[remotes.production.auth]",
      'signing_keys_path = "./signing_keys.json"',
    ].join("\n");
    expect(check("supabase/config.toml", config)).toEqual([
      "remote-config-uses-key-file supabase/config.toml:6",
    ]);
  });

  it("accepts a hosted branch config that names no key file", () => {
    // No CLI command uploads signing keys, so an inherited local
    // `signing_keys_path` reaches no hosted project.
    const config = [
      "[auth]",
      'signing_keys_path = "./signing_keys.json"',
      "[remotes.staging]",
      'project_id = "abcdefghijklmnop"',
    ].join("\n");
    expect(check("supabase/config.toml", config)).toEqual([]);
  });
});

const workflow = (...jobs) =>
  ["name: deploy", "on: push", "jobs:", ...jobs].join("\n");
/** A job; a string step becomes `- run: <string>`, an array is used verbatim. */
const job = (name, ...steps) =>
  [
    `    ${name}:`,
    "        runs-on: ubuntu-latest",
    "        steps:",
    ...steps.flatMap((step) =>
      Array.isArray(step) ? step : [`            - run: ${step}`],
    ),
  ].join("\n");
const WORKFLOW = ".github/workflows/deploy.yml";

describe("the repository guard: publishing to GitHub Pages", () => {
  it("flags a workflow that calls gh-pages directly", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "demo",
            "npm run build:demo",
            "npx gh-pages --remote production -d dist",
          ),
        ),
      ),
    ).toEqual([`direct-pages-publish ${WORKFLOW}:8`]);
  });

  it("flags a make target that calls gh-pages directly", () => {
    expect(
      check(
        "makefile",
        "doc-deploy:\n\t@(cd doc && npx gh-pages -b gh-pages -d dist)",
      ),
    ).toEqual(["direct-pages-publish makefile:2"]);
  });

  it("flags the gh-pages API, an npx flag, and Pages actions", () => {
    expect(
      check("scripts/release.mjs", 'import * as ghpages from "gh-pages";'),
    ).toEqual(["direct-pages-publish scripts/release.mjs:1"]);
    expect(
      check(
        "package.json",
        '{ "scripts": { "pages": "npx --yes gh-pages@6 --dist dist" } }',
      ),
    ).toEqual(["direct-pages-publish package.json:1"]);
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "pages",
            ["            - uses: peaceiris/actions-gh-pages@v4"],
            ["            - uses: actions/deploy-pages@v4"],
          ),
        ),
      ),
    ).toEqual([
      `direct-pages-publish ${WORKFLOW}:7`,
      `direct-pages-publish ${WORKFLOW}:8`,
    ]);
  });

  it("accepts the scanning publisher, the dependency, and prose", () => {
    const violations = checkRepository(
      [
        {
          path: WORKFLOW,
          content: workflow(
            job(
              "demo",
              "node scripts/publish-pages.mjs --remote production -d dist -b ${{ vars.DEPLOY_BRANCH || 'gh-pages' }}",
            ),
          ),
        },
        {
          path: "makefile",
          content:
            "doc-deploy:\n\t@(cd doc && node ../scripts/publish-pages.mjs -b gh-pages -d dist)",
        },
        { path: "package.json", content: '    "gh-pages": "^6.3.0",' },
        {
          path: "doc/src/content/docs/developers/deploy.mdx",
          content: "Run `npx gh-pages -d dist` to publish.",
        },
      ],
      { devKeys: null },
    );
    expect(violations).toEqual([]);
  });
});

describe("the repository guard: pushing to Supabase", () => {
  const KEY_CHECK =
    'node scripts/dev-signing-key.mjs --project-ref "$SUPABASE_PROJECT_ID"';
  const PUSH = "npx supabase db push";

  it("flags a job that pushes without checking the project first", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "supabase",
            "npx supabase link --project-ref $SUPABASE_PROJECT_ID",
            PUSH,
          ),
        ),
      ),
    ).toEqual([`deploy-without-key-check ${WORKFLOW}:8`]);
  });

  it("accepts a job that checks before every push", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "supabase",
            KEY_CHECK,
            "npx supabase link --project-ref $SUPABASE_PROJECT_ID",
            PUSH,
            "npx supabase functions deploy",
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("flags a check that runs only after the first push", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job("supabase", PUSH, KEY_CHECK, "npx supabase functions deploy"),
        ),
      ),
    ).toEqual([`deploy-without-key-check ${WORKFLOW}:7`]);
  });

  it("flags a check that cannot fail", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "supabase",
            [
              `            - run: ${KEY_CHECK}`,
              "              continue-on-error: true",
            ],
            PUSH,
          ),
        ),
      ),
    ).toEqual([`deploy-without-key-check ${WORKFLOW}:9`]);
    expect(
      check(WORKFLOW, workflow(job("supabase", `${KEY_CHECK} || true`, PUSH))),
    ).toEqual([`deploy-without-key-check ${WORKFLOW}:8`]);
  });

  it("does not mistake a `||` inside a workflow expression for a fallback", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "supabase",
            [
              "            - if: ${{ env.A || env.B }}",
              `              run: ${KEY_CHECK}`,
            ],
            PUSH,
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("accepts a multi-line run that checks before it pushes", () => {
    expect(
      check(
        WORKFLOW,
        workflow(
          job("supabase", [
            "            - run: |",
            `                  ${KEY_CHECK}`,
            `                  ${PUSH}`,
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("does not let a check in another job cover this one", () => {
    expect(
      check(WORKFLOW, workflow(job("guard", KEY_CHECK), job("deploy", PUSH))),
    ).toEqual([`deploy-without-key-check ${WORKFLOW}:11`]);
  });

  it("still reads a workflow with a comment after `jobs:`", () => {
    const content = [
      "name: deploy",
      "on: push",
      "jobs: # every deploy",
      job("supabase", PUSH),
    ].join("\n");
    expect(check(WORKFLOW, content)).toEqual([
      `deploy-without-key-check ${WORKFLOW}:7`,
    ]);
  });

  it("fails closed on a workflow it cannot read", () => {
    expect(check(WORKFLOW, `name: deploy\nrun: ${PUSH}`)).toEqual([
      `deploy-without-key-check ${WORKFLOW}:2`,
    ]);
  });

  it("holds make targets to the same rule", () => {
    expect(
      check(
        "makefile",
        "supabase-deploy:\n\tnpx supabase db push\n\tnpx supabase functions deploy",
      ),
    ).toEqual(["deploy-without-key-check makefile:2"]);
    expect(
      check(
        "makefile",
        "supabase-deploy:\n\tnode scripts/dev-signing-key.mjs --linked\n\tnpx supabase db push",
      ),
    ).toEqual([]);
    // make's `-` prefix ignores a failing command.
    expect(
      check(
        "makefile",
        "supabase-deploy:\n\t-node scripts/dev-signing-key.mjs --linked\n\tnpx supabase db push",
      ),
    ).toEqual(["deploy-without-key-check makefile:3"]);
  });

  it("flags a push from a file whose order no rule can read", () => {
    expect(
      check("package.json", '{ "scripts": { "deploy": "supabase db push" } }'),
    ).toEqual(["deploy-without-key-check package.json:1"]);
  });

  it("reads a pinned CLI version, an executable name and global flags (closure)", () => {
    for (const push of [
      "npx supabase@2.117.0 db push",
      "supabase@2 functions deploy users",
      "npx supabase --debug db push",
      "bunx supabase@latest config push",
      "npx supabase db --linked push",
      "npx supabase --workdir . db push",
      "supabase.exe db push",
      "npx supabase --profile prod secrets set --env-file .env",
    ]) {
      expect(check("makefile", `supabase-deploy:\n\t${push}\n`), push).toEqual([
        "deploy-without-key-check makefile:2",
      ]);
      expect(
        check(
          "makefile",
          `supabase-deploy:\n\tnode scripts/dev-signing-key.mjs --linked\n\t${push}\n`,
        ),
        push,
      ).toEqual([]);
    }
  });

  it("reads flags between a command group and its subcommand (closure)", () => {
    for (const push of [
      "supabase functions --project-ref=abcdefghijabcdefghij deploy users",
      "npx supabase@2.1.0 functions --debug=true deploy users",
      "supabase secrets --debug=true set X=1",
      "supabase config --debug=true push",
      "supabase db --db-url postgres://h/db push",
    ]) {
      expect(check("makefile", `supabase-deploy:\n\t${push}\n`), push).toEqual([
        "deploy-without-key-check makefile:2",
      ]);
    }
    for (const other of [
      "supabase functions --debug serve",
      "supabase db --linked reset",
      "supabase secrets --debug list",
    ]) {
      expect(
        check("makefile", `supabase-deploy:\n\t${other}\n`),
        other,
      ).toEqual([]);
    }
  });

  it("does not count a check a backslash continuation or a replaced shell can defeat (closure)", () => {
    for (const lead of ["\techo \\\n", "\ttrue || \\\n"]) {
      expect(
        check(
          "makefile",
          `supabase-deploy:\n${lead}\tnode scripts/dev-signing-key.mjs --linked\n\tnpx supabase db push\n`,
        ),
        lead,
      ).toEqual(["deploy-without-key-check makefile:4"]);
    }
    expect(
      check(
        WORKFLOW,
        workflow(
          job(
            "supabase",
            [
              `            - run: ${KEY_CHECK}`,
              "              shell: sh -c 'exit 0' {0}",
            ],
            PUSH,
          ),
        ),
      ),
    ).toEqual([`deploy-without-key-check ${WORKFLOW}:9`]);
  });

  it("counts a check as blocking only when continue-on-error is statically false (closure)", () => {
    const keyCheckWith = (line) =>
      workflow(
        job("supabase", [`            - run: ${KEY_CHECK}`, line], PUSH),
      );
    for (const line of [
      "              continue-on-error: ${{ true }}",
      "              continue-on-error: ${{ vars.CONTINUE }}",
      "              continue-on-error: 'false'",
      '              "continue-on-error": true',
      "              continue-on-error : true",
    ]) {
      expect(check(WORKFLOW, keyCheckWith(line)), line).toEqual([
        `deploy-without-key-check ${WORKFLOW}:9`,
      ]);
    }
    for (const line of [
      "              continue-on-error: false",
      "              continue-on-error: False",
      "              continue-on-error: ${{ false }}",
      "              continue-on-error: false # reviewed",
    ]) {
      expect(check(WORKFLOW, keyCheckWith(line)), line).toEqual([]);
    }
  });

  it("exempts only the production-scope test's fixtures, by path, and only while it loads reviewed modules", () => {
    const fixture = 'const DEPLOY_ALL = "npx supabase functions deploy";\n';
    const TEST = "scripts/test/production-scope.test.mjs";
    expect(check(TEST, fixture)).toEqual([]);
    expect(
      check(TEST, `import { execSync } from "node:child_process";\n${fixture}`),
    ).toEqual([`deploy-without-key-check ${TEST}:2`]);
    // Any other module, or a module name no review can read, ends the
    // exemption; a quotation of such a load inside a string does not.
    for (const load of [
      "await import(`node:child_process`);",
      'createRequire(import.meta.url)("child_process");',
      'import { $ } from "zx/core";',
      'const cp = require("node:child_process");',
      'export { spawn } from "node:child_process";',
    ]) {
      expect(check(TEST, `${load}\n${fixture}`)).toEqual([
        `deploy-without-key-check ${TEST}:2`,
      ]);
    }
    expect(
      check(
        TEST,
        `const quoted = 'await import("node:child_process")';\n${fixture}`,
      ),
    ).toEqual([]);
    expect(check("scripts/production-scope.mjs", fixture)).toEqual([
      "deploy-without-key-check scripts/production-scope.mjs:1",
    ]);
  });
});

describe("this repository", () => {
  it("pins the development key it protects", () => {
    const devKeys = loadDevSigningKeys();
    expect(devKeys?.fileThumbprints).toEqual([DEV_KEY_THUMBPRINT]);
    expect(devKeys?.pinnedThumbprints).toEqual([DEV_KEY_THUMBPRINT]);
    expect(devKeys?.privateMemberCount).toBe(1);
  });

  it("confines the development signing key to local tooling", () => {
    const violations = checkRepository(readTrackedFiles(), {
      devKeys: loadDevSigningKeys(),
    });
    expect(violations).toEqual([]);
  });

  it("passes the guard as a command, which is how CI runs it", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("the deploy guard: does the hosted project trust the key?", () => {
  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const serving = (response) => async () => response;
  const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";

  it("derives the project URL from the ref `supabase link` takes", () => {
    expect(projectUrl("abcdefghijklmnopqrst")).toBe(PROJECT);
    expect(projectUrl("")).toBeNull();
    expect(projectUrl("evil.example.com/x")).toBeNull();
    expect(projectUrl(undefined)).toBeNull();
  });

  it("reads the project `supabase link` recorded, and nothing when there is none", () => {
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    expect(linkedProjectRef(dir)).toBeNull();
    writeFileSync(
      join(dir, "supabase", ".temp", "project-ref"),
      "abcdefghijklmnopqrst\n",
    );
    expect(linkedProjectRef(dir)).toBe("abcdefghijklmnopqrst");
  });

  it("asks the project's own JWKS endpoint", async () => {
    const key = syntheticKeySet();
    let asked = "";
    await checkRemoteJwks(PROJECT, {
      devKeys: key.devKeys,
      fetchImpl: async (url) => {
        asked = String(url);
        return jsonResponse({ keys: [] });
      },
    });
    expect(asked).toBe(`${PROJECT}/auth/v1/.well-known/jwks.json`);
  });

  it("fails when the project trusts the development key", async () => {
    const key = syntheticKeySet();
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: key.devKeys,
      fetchImpl: serving(
        jsonResponse({ keys: [unrelatedPublicJwk(), key.publicJwk] }),
      ),
    });
    expect(result.status).toBe("fail");
  });

  it("fails even when the key was imported under a different kid", async () => {
    const key = syntheticKeySet();
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: key.devKeys,
      fetchImpl: serving(
        jsonResponse({ keys: [{ ...key.publicJwk, kid: "imported" }] }),
      ),
    });
    expect(result.status).toBe("fail");
  });

  it("fails on the pinned key even without the private file", async () => {
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: loadDevSigningKeys(join(dir, "absent.json")),
      fetchImpl: serving(
        jsonResponse({ keys: [...KNOWN_DEVELOPMENT_PUBLIC_KEYS] }),
      ),
    });
    expect(result.status).toBe("fail");
  });

  it("passes when the project trusts only its own keys", async () => {
    const key = syntheticKeySet();
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: key.devKeys,
      fetchImpl: serving(jsonResponse({ keys: [unrelatedPublicJwk()] })),
    });
    expect(result.status).toBe("pass");
  });

  it("passes a project with no asymmetric keys, and says why", async () => {
    const key = syntheticKeySet();
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: key.devKeys,
      fetchImpl: serving(jsonResponse({ keys: [] })),
    });
    expect(result).toMatchObject({
      status: "pass",
      detail: expect.stringMatching(/no asymmetric signing keys/),
    });
  });

  it.each([
    ["an HTTP error", serving(jsonResponse({ message: "down" }, 503))],
    [
      "a network failure",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
    [
      "a non-JSON answer",
      serving(new Response("<html>maintenance</html>", { status: 200 })),
    ],
    ["an answer with no keys array", serving(jsonResponse({ jwks: [] }))],
    [
      "a key it cannot fingerprint",
      serving(jsonResponse({ keys: [{ kty: "EC", kid: "no-coordinates" }] })),
    ],
  ])("refuses to pass on %s", async (_case, fetchImpl) => {
    const key = syntheticKeySet();
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: key.devKeys,
      fetchImpl,
    });
    expect(result.status).toBe("unverified");
  });

  it("refuses to pass on something that is not a URL", async () => {
    const key = syntheticKeySet();
    const result = await checkRemoteJwks("", {
      devKeys: key.devKeys,
      fetchImpl: serving(jsonResponse({ keys: [] })),
    });
    expect(result.status).toBe("unverified");
  });

  it("refuses to pass when no development key is known at all", async () => {
    const result = await checkRemoteJwks(PROJECT, {
      devKeys: null,
      fetchImpl: serving(jsonResponse({ keys: [] })),
    });
    expect(result.status).toBe("unverified");
  });

  it.each([
    [
      "--project-ref with no ref, as an unset secret would pass",
      ["--project-ref"],
    ],
    [
      "--project-ref with something that is not a ref",
      ["--project-ref", "not-a-ref"],
    ],
    ["--remote with no URL", ["--remote"]],
    ["an unreachable project", ["--remote", "http://127.0.0.1:9"]],
  ])("exits non-zero on %s", (_case, args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 25000,
    });
    expect(result.status).toBe(2);
  });
});
