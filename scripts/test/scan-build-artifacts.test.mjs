import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevSigningKeys } from "../dev-signing-key.mjs";
import { scanDirectory } from "../scan-build-artifacts.mjs";

// Every fixture below is SYNTHETIC. No real credential is stored in this
// repository, which is the whole point of a secret gate whose rules are
// patterns rather than values.

let dir;
const write = (name, content) => {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
};

/** Builds a syntactically valid JWT with the given role. Unsigned — the gate
 *  reads the payload, it does not verify signatures. */
const jwt = (role) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ iss: "test", role })}.AAAAAAAAAAAAAAAAAAAAAAAA`;
};

/** A `VITE_` variable name, assembled at runtime: the source-level boundary
 *  test (engine/models/providerSecretsBoundary.test.ts) reads this file, and a
 *  literal provider name here would be a finding there. */
const viteName = (suffix) => "VITE" + "_" + suffix;

const BROWSER_PROVIDER = "browser-model-provider-variable";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "scan-build-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the gate refuses a build carrying a server-side credential", () => {
  it("catches a Supabase secret key", () => {
    write("assets/app.js", `const k="sb_secret_AAAAAAAAAAAAAAAAAAAA";`);
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
      `const u="postgresql://worker:hunter2@db.example.com:5432/postgres";`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("postgres-connection-string");
  });

  it("catches a PEM private key", () => {
    write(
      "assets/app.js",
      `const k=\`-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----\`;`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("private-key-block");
  });

  it("catches a GitHub token", () => {
    write(
      "assets/app.js",
      `const t="ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("github-token");
  });

  it("catches the VITE_-typo shape: a server-only NAME assigned a value", () => {
    // The realistic regression: someone renames the variable to make it
    // reachable from the frontend, and the name itself survives minification.
    write("assets/app.js", `SERVICE_ROLE_KEY:"aaaaaaaaaaaaaaaaaaaa"`);
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toContain("assigned-server-secret");
  });

  // Model provider key fixtures are assembled by concatenation, so no literal
  // in this file has the shape a push-protection scanner looks for.
  it("catches an OpenAI API key under each of its prefixes", () => {
    const body = "A".repeat(40);
    write("assets/legacy.js", `const k="${"sk-" + body}";`);
    write("assets/project.js", `const k="${"sk-" + "proj-" + body}";`);
    write("assets/service.js", `const k='${"sk-" + "svcacct-" + body}';`);
    write("assets/admin.js", `k=\`${"sk-" + "admin-" + body}\``);
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(
      findings.map((f) => `${f.rule} ${f.severity} ${f.file}`).sort(),
    ).toEqual([
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
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(
      findings.map((f) => `${f.rule} ${f.severity} ${f.file}`).sort(),
    ).toEqual([
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
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(
      findings.map((f) => `${f.rule} ${f.severity} ${f.file}`).sort(),
    ).toEqual([
      "anthropic-api-key critical assets/oat01.js",
      "anthropic-api-key critical assets/ort01.js",
      "anthropic-api-key critical assets/sid01.js",
    ]);
  });

  it("catches a model provider key NAME assigned a value that is not key-shaped", () => {
    // A placeholder-looking value is still a value: the name alone says it is
    // a server-side credential that has no business in a bundle.
    write(
      "assets/app.js",
      `OPENAI_API_KEY="replace-me-later";const c={ANTHROPIC_API_KEY:"replace-me-later"};`,
    );
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => [f.rule, f.detail])).toEqual([
      [
        "assigned-server-secret",
        "server-only variable assigned a value (OPENAI_API_KEY)",
      ],
      [
        "assigned-server-secret",
        "server-only variable assigned a value (ANTHROPIC_API_KEY)",
      ],
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
      JSON.stringify({
        sourcesContent: [`const e = {"${name}": "${value}"};`],
      }),
    );
    // An embedded .env line inside sourcesContent: `\n` puts a word character
    // right before the name.
    write(
      "assets/dotenv.js.map",
      JSON.stringify({ sourcesContent: [`# env\n${name}=${value}`] }),
    );
    // The first letter spelled as an escape, in each JavaScript form, and once
    // more escaped by a source map.
    write("assets/unicode.js", `e["\\u0056${rest}"]`);
    write("assets/braced.js", `e["\\u{56}${rest}"]`);
    write("assets/hex.js", `e["\\x56${rest}"]`);
    write(
      "assets/escaped.js.map",
      JSON.stringify({ sourcesContent: [`e["\\u0056${rest}"]`] }),
    );
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(
      findings.map((f) => `${f.rule} ${f.severity} ${f.file}`).sort(),
    ).toEqual(
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
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => `${f.rule} ${f.detail}`).sort()).toEqual(
      names
        .map(
          (name) =>
            `${BROWSER_PROVIDER} model provider variable exposed to the browser (${name})`,
        )
        .sort(),
    );
  });
});

describe("the gate does not cry wolf", () => {
  it("accepts the publishable key, which is meant to be in the bundle", () => {
    write("assets/app.js", `const k="sb_publishable_AAAAAAAAAAAAAAAAAAAA";`);
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts an anon JWT", () => {
    write("assets/app.js", `const t="${jwt("anon")}";`);
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts an authenticated JWT", () => {
    write("assets/app.js", `const t="${jwt("authenticated")}";`);
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts a bare host:port with no credentials", () => {
    write(
      "assets/app.js",
      `const u="postgresql://db.example.com:5432/postgres";`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts the library JSDoc that merely MENTIONS service_role", () => {
    // @supabase/auth-js ships exactly this text, and it is in every source map.
    // A gate that flags it is a gate that gets switched off.
    write(
      "assets/app.js.map",
      `{"sourcesContent":["/** Never expose your \`service_role\` key in the browser. */","process.env.SUPABASE_SERVICE_ROLE_KEY"]}`,
    );
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("ignores binary assets", () => {
    write("appIcon/192.png", "sb_secret_AAAAAAAAAAAAAAAAAAAA");
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts ordinary text and CSS that merely contain sk-", () => {
    // The long identifiers carry 20+ key-body characters after their `sk-`;
    // only the `\b` before `sk` keeps them out, because their `s` follows a
    // letter.
    write(
      "assets/app.js",
      [
        `const a="risk-assessment";`,
        `const b="task-management-long-identifier-xyz";`,
        `const c="risk-assessment-summary-for-every-reviewer";`,
        `const d=["ask-for-confirmation-before-deleting-records"];`,
      ].join("\n"),
    );
    write(
      "assets/index.css",
      `.desk-top{display:flex}.desk-top-navigation-container-wide{gap:4px}`,
    );
    // The Slovak locale tag and a hashed chunk named after it DO follow a
    // non-word character, and are far too short to be a key.
    write("assets/i18n.js", `const l="sk-SK";import("./sk-B3xYz9Q1.js");`);
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings).toEqual([]);
  });

  it("accepts server code that reads a model provider key without a value", () => {
    // What the worker's own routing config looks like if it ever reaches a
    // source map: names, a schema and an error message, but no value.
    write(
      "assets/app.js.map",
      `{"sourcesContent":["const key = env.OPENAI_API_KEY;","const schema = {ANTHROPIC_API_KEY: z.string()};","throw new Error('OPENAI_API_KEY is required')"]}`,
    );
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings).toEqual([]);
  });

  it("accepts the VITE_ variables the SPA legitimately reads", () => {
    // Every VITE_ name in the repository on 2026-09-14 (src, demo, the vite
    // configs, the .env files and deploy.yml), with values shaped like real ones.
    const env = {
      BASE_URL: "/",
      MODE: "production",
      VITE_SUPABASE_URL: "https://project-ref.supabase.co",
      VITE_SB_PUBLISHABLE_KEY: "sb_publishable_AAAAAAAAAAAAAAAAAAAA",
      VITE_SUPABASE_ANON_KEY: jwt("anon"),
      VITE_IS_DEMO: "false",
      VITE_INBOUND_EMAIL: "inbound@example.org",
      VITE_ATTACHMENTS_BUCKET: "attachments",
      VITE_GOOGLE_WORKPLACE_DOMAIN: "example.org",
      VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION: "false",
    };
    write("assets/app.js", `const e=${JSON.stringify(env)};`);
    write(
      "assets/app.js.map",
      JSON.stringify({
        sourcesContent: [
          `const e = ${JSON.stringify(env)};`,
          "const url = import.meta.env.VITE_SUPABASE_URL;",
        ],
      }),
    );
    // Names that border the rule without naming a provider.
    write(
      "assets/near.js",
      `const a=import.meta.env.VITE_DATA_MODEL_VERSION;const b=import.meta.env.VITE_OPENING_HOURS;const c=import.meta.env.VITE_AGENT_NAME;`,
    );
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings).toEqual([]);
  });
});

describe("the gate reads what a host would serve", () => {
  it("reads a file whatever its extension, or none", () => {
    // A list of extensions worth reading once let key material through as
    // `.well-known/jwks`, `dev.jwk` and `keys.pem`.
    write(".well-known/jwks", '{"k":"sb_secret_AAAAAAAAAAAAAAAAAAAA"}');
    write(
      "keys.pem",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    );
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => `${f.rule} ${f.file}`).sort()).toEqual([
      "private-key-block keys.pem",
      "supabase-secret-key .well-known/jwks",
    ]);
  });
});

describe("advisory findings", () => {
  it("flags a published bundle-visualizer report without blocking", () => {
    write("stats.html", "<html>module graph</html>");
    const { findings } = scanDirectory(dir);
    expect(findings.map((f) => f.rule)).toEqual(["bundle-visualizer"]);
    expect(findings[0].severity).toBe("low");
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
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => f.rule)).toEqual(["private-jwk"]);
  });

  it("accepts a public JWK set, which is meant to be published", () => {
    const { x, y, crv } = syntheticDevKey();
    write(
      "assets/app.js",
      JSON.stringify({ keys: [{ kty: "EC", crv, x, y }] }),
    );
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings).toEqual([]);
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
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => [f.rule, f.severity])).toEqual([
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

describe("the gate fails closed", () => {
  it("throws when there is no build to scan", () => {
    // A missing dist must not read as "clean".
    expect(() => scanDirectory(join(dir, "does-not-exist"))).toThrow(
      /no build to scan/,
    );
  });

  it("never returns the matched value", () => {
    write("assets/app.js", `const k="sb_secret_SUPERSECRETVALUE123";`);
    const { findings } = scanDirectory(dir);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain("SUPERSECRETVALUE123");
    expect(findings[0].sha256).toMatch(/^[0-9a-f]{12}$/);
  });

  it("never returns a model provider key, only a fingerprint", () => {
    const secretMiddle = "MIDDLEOFTHEPROVIDERKEY";
    const openAi =
      "sk-" + "proj-" + "Q".repeat(12) + secretMiddle + "Z".repeat(12);
    const anthropic =
      "sk-" +
      "ant-" +
      "api03-" +
      "R".repeat(12) +
      secretMiddle +
      "Y".repeat(12);
    write("assets/app.js", `const o="${openAi}";const a="${anthropic}";`);
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => f.rule).sort()).toEqual([
      "anthropic-api-key",
      "openai-api-key",
    ]);
    const serialised = JSON.stringify(findings);
    // Booleans, not the strings: a failing assertion prints its arguments.
    expect(serialised.includes(openAi)).toBe(false);
    expect(serialised.includes(anthropic)).toBe(false);
    expect(serialised.includes(secretMiddle)).toBe(false);
    expect(findings.every((f) => /^[0-9a-f]{12}$/.test(f.sha256))).toBe(true);
  });

  it("never returns the value beside a VITE_ model provider variable", () => {
    const name = viteName("ANTHROPIC_API_KEY");
    const value = "placeholder" + "-MUST-NOT-LEAK-0123456789";
    write("assets/app.js", `const e={"${name}":"${value}"};`);
    write(
      "assets/env.js.map",
      JSON.stringify({ sourcesContent: [`${name}=${value}`] }),
    );
    const { findings } = scanDirectory(dir, { devSigningKeys: null });
    expect(findings.map((f) => f.rule)).toEqual([
      BROWSER_PROVIDER,
      BROWSER_PROVIDER,
    ]);
    // Booleans, not the strings: a failing assertion prints its arguments.
    expect(JSON.stringify(findings).includes("MUST-NOT-LEAK")).toBe(false);
  });
});
