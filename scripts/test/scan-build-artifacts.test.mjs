import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevSigningKeys } from "../dev-signing-key.mjs";
import {
  isPrivilegedViteName,
  scanDirectory,
} from "../scan-build-artifacts.mjs";
import {
  ASSIGNED,
  BASE64URL,
  BROWSER_PROVIDER,
  PRIVATE_KEY,
  dir,
  githubToken,
  jwt,
  pem,
  postgresUrl,
  repositoryViteNames,
  revealed,
  rulesByFile,
  sbSecret,
  scan,
  scratchBuildPerTest,
  sourceMap,
  synthetic,
  viteName,
  write,
} from "./scan-build-helpers.mjs";

// Every fixture below is SYNTHETIC. No real credential is stored in this
// repository, which is the whole point of a secret gate whose rules are
// patterns rather than values.
//
// Every credential-shaped fixture is also ASSEMBLED AT RUNTIME (a split prefix
// and a generated body), so this file holds no literal that this scanner, a
// push-protection scanner or the repository's own guards would read as a
// credential. And no assertion names a fixture value: a failing assertion
// prints its arguments, so they compare rule ids, labels, counts and booleans.

// The fixture builders are in ./scan-build-helpers.mjs, and the tests of each
// credential class in the other scripts/test/scan-build-*.test.mjs files.
// This file keeps the tests the security invariants name (SI-20, SI-33,
// SI-59) and every fixture that names the development key file, which only
// this file and the guards themselves may name (scripts/dev-signing-key.mjs).

scratchBuildPerTest();

describe("the gate refuses a build carrying a server-side credential", () => {
  it("catches a Supabase secret key", () => {
    write("assets/app.js", `const k="${sbSecret("app")}";`);
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("supabase-secret-key");
    expect(findings[0].severity).toBe("critical");
  });

  it("catches a service_role JWT", () => {
    write("assets/app.js", `const t="${jwt("service_role")}";`);
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("privileged-jwt");
  });

  it("catches a privileged JWT hiding in a source map", () => {
    // Source maps are published too, and are the easiest place to forget.
    write(
      "assets/app.js.map",
      `{"sourcesContent":["const t='${jwt("supabase_admin")}'"]}`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("privileged-jwt");
  });

  it("catches a postgres connection string with a password", () => {
    write(
      "assets/app.js",
      `const u="${postgresUrl("worker", synthetic("pg", 12))}";`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("postgres-connection-string");
  });

  it("catches a PEM private key", () => {
    write("assets/app.js", `const k=\`${pem("EC " + PRIVATE_KEY)}\`;`);
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("private-key-block");
  });

  it("catches a GitHub token", () => {
    write("assets/app.js", `const t="${githubToken("gh")}";`);
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("github-token");
  });

  it("catches the VITE_-typo shape: a server-only NAME assigned a value", () => {
    // The realistic regression: someone renames the variable to make it
    // reachable from the frontend, and the name itself survives minification.
    write("assets/app.js", `SERVICE_ROLE_KEY:"${synthetic("typo", 20)}"`);
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain(ASSIGNED);
  });

  // Model provider key fixtures are assembled by concatenation, so no literal
  // in this file has the shape a push-protection scanner looks for.
  it("catches an OpenAI API key under each of its prefixes", () => {
    const body = "A".repeat(40);
    write("assets/legacy.js", `const k="${"sk-" + body}";`);
    write("assets/project.js", `const k="${"sk-" + "proj-" + body}";`);
    write("assets/service.js", `const k='${"sk-" + "svcacct-" + body}';`);
    write("assets/admin.js", `k=\`${"sk-" + "admin-" + body}\``);
    expect(rulesByFile(scan())).toEqual([
      "openai-api-key critical assets/admin.js",
      "openai-api-key critical assets/legacy.js",
      "openai-api-key critical assets/project.js",
      "openai-api-key critical assets/service.js",
    ]);
  });

  it("reports an Anthropic API key once, as an Anthropic key", () => {
    // `sk-ant-…` also starts with `sk-`: without the lookahead one key would be
    // two findings, one of them naming the wrong provider.
    const body = "B".repeat(40);
    write("assets/api.js", `const k="${"sk-" + "ant-" + "api03-" + body}";`);
    write(
      "assets/admin.js",
      `const k="${"sk-" + "ant-" + "admin01-" + body}";`,
    );
    expect(rulesByFile(scan())).toEqual([
      "anthropic-api-key critical assets/admin.js",
      "anthropic-api-key critical assets/api.js",
    ]);
  });

  it("refuses every sk-ant- credential family, not only API keys", () => {
    // The OpenAI rule skips all of `sk-ant-`, so a family the Anthropic rule
    // did not accept (OAuth access and refresh tokens, session keys) would be
    // refused by neither rule and ship.
    const body = "C".repeat(40);
    for (const family of ["oat01", "ort01", "sid01"]) {
      write(
        `assets/${family}.js`,
        `const k="${"sk-" + "ant-" + family + "-" + body}";`,
      );
    }
    expect(rulesByFile(scan())).toEqual([
      "anthropic-api-key critical assets/oat01.js",
      "anthropic-api-key critical assets/ort01.js",
      "anthropic-api-key critical assets/sid01.js",
    ]);
  });

  it("catches a model provider key NAME assigned a value that is not key-shaped", () => {
    // A placeholder-looking value is still a value: the name alone says it is
    // a server-side credential that has no business in a bundle.
    const placeholder = "replace-me" + "-later";
    write(
      "assets/app.js",
      `OPENAI_API_KEY="${placeholder}";const c={ANTHROPIC_API_KEY:"${placeholder}"};`,
    );
    expect(scan().map((f) => [f.rule, f.detail])).toEqual([
      [ASSIGNED, "server-only variable assigned a value (OPENAI_API_KEY)"],
      [ASSIGNED, "server-only variable assigned a value (ANTHROPIC_API_KEY)"],
    ]);
  });

  it("refuses a VITE_ model provider variable however a build spells it", () => {
    // Provider configuration is backend-only. The prefix alone is the finding:
    // Vite hands every VITE_ variable to the bundle, whatever its value.
    const name = viteName("OPENAI_API_KEY");
    const rest = name.slice(1); // the name without its leading "V"
    const value = "placeholder-value";
    // `import.meta.env.X`, as unminified output keeps it.
    write("assets/bare.js", `const k=import.meta.env.${name};`);
    // The env object Vite inlines when `import.meta.env` is used whole.
    write(
      "assets/inlined.js",
      `const e={"BASE_URL":"/","${name}":"${value}"};`,
    );
    // The same object inside sourcesContent, where its quotes are escaped.
    write(
      "assets/quoted.js.map",
      sourceMap(`const e = {"${name}": "${value}"};`),
    );
    // An embedded .env line inside sourcesContent: `\n` puts a word character
    // right before the name.
    write("assets/dotenv.js.map", sourceMap(`# env\n${name}=${value}`));
    // The first letter spelled as an escape, in each JavaScript form, and once
    // more escaped by a source map.
    write("assets/unicode.js", `e["\\u0056${rest}"]`);
    write("assets/braced.js", `e["\\u{56}${rest}"]`);
    write("assets/hex.js", `e["\\x56${rest}"]`);
    write("assets/escaped.js.map", sourceMap(`e["\\u0056${rest}"]`));
    expect(rulesByFile(scan())).toEqual(
      [
        "assets/bare.js",
        "assets/braced.js",
        "assets/dotenv.js.map",
        "assets/escaped.js.map",
        "assets/hex.js",
        "assets/inlined.js",
        "assets/quoted.js.map",
        "assets/unicode.js",
      ].map((file) => `${BROWSER_PROVIDER} critical ${file}`),
    );
  });

  it("refuses every model provider name family inside a VITE_ name, in any case", () => {
    // Each name carries exactly one of the provider parts, so dropping any
    // part from the rule fails this test by name.
    const names = [
      viteName("OPENAI_API_KEY"),
      viteName("AZURE_OPENAI_ENDPOINT"),
      viteName("OPEN_AI_KEY"),
      viteName("ANTHROPIC_API_KEY"),
      viteName("CLAUDE_KEY"),
      viteName("AGENT_MODEL_STANDARD"),
      viteName("DEFAULT_MODEL_PROVIDER"),
      viteName("OpenAi_Key"),
    ];
    names.forEach((name, i) =>
      write(`assets/chunk-${i}.js`, `const v=import.meta.env.${name};`),
    );
    expect(
      scan()
        .map((f) => `${f.rule} ${f.detail}`)
        .sort(),
    ).toEqual(
      names
        .map(
          (name) =>
            `${BROWSER_PROVIDER} model provider variable exposed to the browser (${name})`,
        )
        .sort(),
    );
  });
});

describe("privileged VITE_ variables", () => {
  // The build-level tests of this group are in scan-build-names.test.mjs.
  it("holds every build input to the rule at the source, source maps or not", () => {
    // The build-level rule sees a NAME only where the build keeps it: Vite
    // replaces `import.meta.env.X` with its value, so without source maps a
    // privileged name reaches the bundle as a bare value no class knows. This
    // check reads the inputs themselves, with the scanner's own predicate.
    // The predicate is not vacuous: a privileged name and a bordering one.
    expect(isPrivilegedViteName(viteName("DB_PASSWORD_PROD"))).toBe(true);
    expect(isPrivilegedViteName(viteName("PASSWORD_RESET_URL"))).toBe(false);
    const repository = repositoryViteNames();
    expect(repository).toContain("VITE_SUPABASE_URL");
    expect(repository.filter(isPrivilegedViteName)).toEqual([]);
  });
});

/**
 * A synthetic key set shaped like the committed development key file. It is
 * written OUTSIDE the scanned directory and generated per test: the real key
 * never appears in a fixture.
 */
const syntheticDevKey = () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { d, x, y, crv } = privateKey.export({ format: "jwk" });
  const keyDir = mkdtempSync(join(tmpdir(), "scan-dev-key-"));
  const path = join(keyDir, "keys.json");
  writeFileSync(
    path,
    JSON.stringify([
      { kty: "EC", kid: randomUUID(), use: "sig", alg: "ES256", crv, x, y, d },
    ]),
  );
  const devSigningKeys = loadDevSigningKeys(path);
  rmSync(keyDir, { recursive: true, force: true });
  return { d, x, y, crv, devSigningKeys };
};

describe("signing key material never reaches a published build", () => {
  it("catches a private JWK published as JSON", () => {
    const { d, x, y, crv } = syntheticDevKey();
    write("keys.json", JSON.stringify({ keys: [{ kty: "EC", crv, x, y, d }] }));
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => f.rule)).toContain("private-jwk");
  });

  it("catches a private JWK a bundler inlined as an object literal", () => {
    // What Vite emits for `import keys from "./signing_keys.json"`.
    const { d, x, y, crv } = syntheticDevKey();
    write(
      "assets/app.js",
      `const k={kty:"EC",crv:"${crv}",x:"${x}",y:"${y}",d:"${d}"};`,
    );
    expect(scan().map((f) => f.rule)).toEqual(["private-jwk"]);
  });

  it("catches a signing key file's shape escaped in a source map, and an RSA-4096 key", () => {
    // A source map carries an imported key file as an escaped string. An RSA
    // key puts its 683-character modulus between `kty` and `d`.
    const ec = syntheticDevKey();
    const file = [
      { kty: "EC", kid: "k", crv: ec.crv, x: ec.x, y: ec.y, d: ec.d },
    ];
    write("assets/app.js.map", sourceMap(JSON.stringify(file, null, 2)));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
    write(
      "assets/rsa.json",
      JSON.stringify(privateKey.export({ format: "jwk" })),
    );
    const found = scan();
    expect(rulesByFile(found)).toEqual([
      "private-jwk critical assets/app.js.map",
      "private-jwk critical assets/rsa.json",
    ]);
    expect(found.every((f) => f.redacted.startsWith("<withheld"))).toBe(true);
  });

  it("catches every PEM private key label, and withholds even its header", () => {
    const labels = [
      PRIVATE_KEY,
      "ENCRYPTED " + PRIVATE_KEY,
      "RSA " + PRIVATE_KEY,
      "DSA " + PRIVATE_KEY,
      "EC " + PRIVATE_KEY,
      "OPENSSH " + PRIVATE_KEY,
      "PGP " + PRIVATE_KEY + " BLOCK",
    ];
    labels.forEach((label, i) => write(`key-${i}.txt`, pem(label)));
    write("public.txt", pem("PUBLIC KEY") + pem("CERTIFICATE"));
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      labels.map((_, i) => `private-key-block critical key-${i}.txt`).sort(),
    );
    expect(found.every((f) => f.redacted.startsWith("<withheld"))).toBe(true);
  });

  it("catches a symmetric JWK's secret, as JSON, as an object literal and in a source map", () => {
    // `kty: "oct"` keeps an HS256 JWT secret in `k`, which can mint a
    // service_role token.
    const k = synthetic("oct", 43, BASE64URL);
    write(
      "keys.json",
      JSON.stringify({ keys: [{ kty: "oct", k, alg: "HS256" }] }),
    );
    write("assets/app.js", `const s={kty:"oct",alg:"HS256",k:"${k}"};`);
    write(
      "assets/app.js.map",
      sourceMap(
        `export default ${JSON.stringify({ kty: "oct", k }, null, 2)};`,
      ),
    );
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      ["assets/app.js", "assets/app.js.map", "keys.json"].map(
        (file) => `symmetric-jwk critical ${file}`,
      ),
    );
    expect(found.every((f) => f.redacted.startsWith("<withheld"))).toBe(true);
    expect(revealed(JSON.stringify(found), { k })).toEqual([]);
  });

  it("accepts a k member that is not a symmetric key's secret", () => {
    // Another key type, no key type at all, and a secret too short: one file
    // each, since `verify` looks for the key type around the member.
    const k = synthetic("not-oct", 43, BASE64URL);
    write("assets/ec.js", `const a={kty:"EC",k:"${k}"};`);
    write("assets/bare.js", `const b={k:"${k}"};`);
    write(
      "assets/short.js",
      `const c={kty:"oct",k:"${synthetic("short-oct", 31, BASE64URL)}"};`,
    );
    expect(scan()).toEqual([]);
  });

  it("accepts a public JWK set, which is meant to be published", () => {
    const { x, y, crv } = syntheticDevKey();
    write(
      "assets/app.js",
      JSON.stringify({ keys: [{ kty: "EC", crv, x, y }] }),
    );
    expect(scan()).toEqual([]);
  });

  it("catches the development key's private component even outside a JWK", () => {
    // No `kty`, no PEM header: no class rule can see this one.
    const key = syntheticDevKey();
    write("assets/app.js", `const s="${key.d}";`);
    const { findings } = scanDirectory(dir, {
      devSigningKeys: key.devSigningKeys,
    });
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
      ["dev-signing-key", "critical"],
    ]);
  });

  it("blocks a build that ships the development key's public component", () => {
    const key = syntheticDevKey();
    write(
      "assets/app.js",
      `const jwks={keys:[{kty:"EC",crv:"${key.crv}",x:"${key.x}",y:"${key.y}"}]};`,
    );
    const { findings } = scanDirectory(dir, {
      devSigningKeys: key.devSigningKeys,
    });
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
      ["dev-signing-key-public", "high"],
    ]);
  });

  it("refuses to publish a signing key file, whatever it contains", () => {
    write("signing_keys.json", "[]");
    expect(scan().map((f) => [f.rule, f.severity])).toEqual([
      ["signing-keys-file", "critical"],
    ]);
  });

  it("reveals not even a prefix of private key material", () => {
    const key = syntheticDevKey();
    write(
      "assets/app.js",
      `const k={kty:"EC",crv:"${key.crv}",x:"${key.x}",y:"${key.y}",d:"${key.d}"};const s="${key.d}";`,
    );
    const serialised = JSON.stringify(
      scanDirectory(dir, { devSigningKeys: key.devSigningKeys }).findings,
    );
    // Booleans, not the strings: a failing assertion prints its arguments.
    expect(serialised.includes(key.d.slice(0, 6))).toBe(false);
    expect(serialised.includes(key.d.slice(-4))).toBe(false);
  });
});
