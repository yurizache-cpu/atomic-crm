import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanDirectory } from "../scan-build-artifacts.mjs";
import {
  ASSIGNED,
  BASE64URL,
  BROWSER_PROVIDER,
  HEX,
  PHASE_2C_SERVER_NAMES,
  POSTGRES_SCHEME,
  PRIVATE_KEY,
  PRIVILEGED_VITE,
  assignmentForms,
  dir,
  escapedValue,
  jwt,
  metaToken,
  pem,
  postgresUrl,
  revealed,
  sbSecret,
  scan,
  scratchBuildPerTest,
  sourceMap,
  synthetic,
  viteName,
  write,
} from "./scan-build-helpers.mjs";

// The gate as a whole: what it must not flag, which files it reads, its
// advisory findings, how it fails closed, and what its command line prints.
//
// Every fixture is SYNTHETIC and assembled at runtime, and no assertion names
// a fixture value: see ./scan-build-helpers.mjs.

const SCANNER = fileURLToPath(
  new URL("../scan-build-artifacts.mjs", import.meta.url),
);

scratchBuildPerTest();

describe("the gate does not cry wolf", () => {
  it("accepts the publishable key, which is meant to be in the bundle", () => {
    write("assets/app.js", `const k="sb_publishable_${synthetic("pub", 20)}";`);
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts an anon JWT", () => {
    write("assets/app.js", `const t="${jwt("anon")}";`);
    const { findings } = scanDirectory(dir);
    expect(findings).toEqual([]);
  });

  it("accepts a bare host:port with no credentials", () => {
    write(
      "assets/app.js",
      `const u="${"postgres"}ql://db.example.com:5432/postgres";`,
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
    write("appIcon/192.png", sbSecret("png"));
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
    expect(scan()).toEqual([]);
  });

  it("accepts server code that reads a model provider key without a value", () => {
    // What the worker's own routing config looks like if it ever reaches a
    // source map: names, a schema and an error message, but no value.
    write(
      "assets/app.js.map",
      `{"sourcesContent":["const key = env.OPENAI_API_KEY;","const schema = {ANTHROPIC_API_KEY: z.string()};","throw new Error('OPENAI_API_KEY is required')"]}`,
    );
    expect(scan()).toEqual([]);
  });

  it("accepts the VITE_ variables the SPA legitimately reads", () => {
    // Every VITE_ name in the repository on 2026-09-14 (src, demo, the vite
    // configs, the .env files and deploy.yml), with values shaped like real ones.
    const env = {
      BASE_URL: "/",
      MODE: "production",
      VITE_SUPABASE_URL: "https://project-ref.supabase.co",
      VITE_SB_PUBLISHABLE_KEY: "sb_publishable_" + synthetic("spa", 20),
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
      sourceMap(
        `const e = ${JSON.stringify(env)};`,
        "const url = import.meta.env.VITE_SUPABASE_URL;",
      ),
    );
    // Names that border the rule without naming a provider.
    write(
      "assets/near.js",
      `const a=import.meta.env.VITE_DATA_MODEL_VERSION;const b=import.meta.env.VITE_OPENING_HOURS;const c=import.meta.env.VITE_AGENT_NAME;`,
    );
    expect(scan()).toEqual([]);
  });
});

describe("the gate reads what a host would serve", () => {
  it("reads a file whatever its extension, or none", () => {
    // A list of extensions worth reading once let key material through as
    // `.well-known/jwks`, `dev.jwk` and `keys.pem`.
    write(".well-known/jwks", `{"k":"${sbSecret("jwks")}"}`);
    write("keys.pem", pem(PRIVATE_KEY));
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

describe("the gate fails closed", () => {
  it("throws when there is no build to scan", () => {
    // A missing dist must not read as "clean".
    expect(() => scanDirectory(join(dir, "does-not-exist"))).toThrow(
      /no build to scan/,
    );
  });

  it("never returns the matched value", () => {
    const secret = sbSecret("never");
    write("assets/app.js", `const k="${secret}";`);
    const { findings } = scanDirectory(dir);
    // The class prefix is public and named by the finding; the body is not.
    const body = secret.slice(secret.lastIndexOf("_") + 1);
    expect(revealed(JSON.stringify(findings), { body })).toEqual([]);
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
    const findings = scan();
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
    write("assets/env.js.map", sourceMap(`${name}=${value}`));
    const findings = scan();
    expect(findings.map((f) => f.rule)).toEqual([
      BROWSER_PROVIDER,
      BROWSER_PROVIDER,
    ]);
    // Booleans, not the strings: a failing assertion prints its arguments.
    expect(JSON.stringify(findings).includes("MUST-NOT-LEAK")).toBe(false);
  });

  it("prints no planted credential, nor any 8-character run of one, from the command line", () => {
    // One fixture per Phase 2C name and per class. The report may show a rule,
    // a file, a name, a redacted edge of at most six characters and a
    // fingerprint; the leak check reads every line the command prints.
    const planted = {
      nameValue: synthetic("cli-name", 24),
      viteValue: synthetic("cli-vite", 32, HEX),
      pgPassword: synthetic("cli-pg", 20),
      libpqPassword: synthetic("cli-libpq", 20),
      jwtBody: jwt("ops_operator_api", "cli-jwt").split(".").slice(1).join("."),
      sessionBody: jwt("authenticated", "cli-session")
        .split(".")
        .slice(1)
        .join("."),
      metaToken: metaToken("cli-meta"),
      bearer: synthetic("cli-bearer", 40, BASE64URL),
      field: synthetic("cli-field", 40, BASE64URL),
      pemBody: synthetic("cli-pem", 64),
      escapedNameValue: escapedValue("cli-escaped"),
      queryPassword: synthetic("cli-query", 20),
      octSecret: synthetic("cli-oct", 43, BASE64URL),
    };
    PHASE_2C_SERVER_NAMES.forEach((name) =>
      write(
        `names/${name}.js.map`,
        assignmentForms(name, planted.nameValue)["quoted.js.map"],
      ),
    );
    write(
      "names/escaped.js",
      assignmentForms("OPS_WORKER_PASSWORD", planted.escapedNameValue)[
        "plain.js"
      ],
    );
    write(
      "assets/query.js",
      `const q="${POSTGRES_SCHEME}//db.example.invalid/db?user=u&password=${planted.queryPassword}";`,
    );
    write("assets/oct.js", `const o={kty:"oct",k:"${planted.octSecret}"};`);
    write(
      "assets/env.js",
      `const e=${JSON.stringify({ [viteName("OPS_GATEWAY_PASSWORD")]: planted.viteValue })};`,
    );
    write(
      "assets/pg.js",
      `const u="${postgresUrl("ops_gateway_login", planted.pgPassword)}";`,
    );
    write(
      "assets/libpq.js",
      `const c="host=db user=u password=${planted.libpqPassword}";`,
    );
    write("assets/jwt.js", `const a="${jwt("ops_operator_api", "cli-jwt")}";`);
    write(
      "assets/session.js",
      `const b="${jwt("authenticated", "cli-session")}";`,
    );
    write("assets/meta.js", `const m="${planted.metaToken}";`);
    write("assets/bearer.js", `const h="Bearer ${planted.bearer}";`);
    write("assets/field.js", `const s={refresh_token:"${planted.field}"};`);
    write("keys.pem", pem("ENCRYPTED " + PRIVATE_KEY, planted.pemBody));

    const run = spawnSync(process.execPath, [SCANNER, dir], {
      encoding: "utf8",
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.status).toBe(1);
    const reported = (rule) =>
      output.split("\n").filter((line) => line.includes(`] ${rule} `)).length;
    expect(
      Object.fromEntries(
        [
          ASSIGNED,
          PRIVILEGED_VITE,
          "postgres-connection-string",
          "libpq-connection-string",
          "privileged-jwt",
          "non-anon-jwt",
          "meta-access-token",
          "bearer-credential",
          "assigned-token-literal",
          "private-key-block",
          "symmetric-jwk",
        ].map((rule) => [rule, reported(rule)]),
      ),
    ).toEqual({
      [ASSIGNED]: PHASE_2C_SERVER_NAMES.length + 1,
      [PRIVILEGED_VITE]: 1,
      "postgres-connection-string": 2,
      "libpq-connection-string": 1,
      "privileged-jwt": 1,
      "non-anon-jwt": 1,
      "meta-access-token": 1,
      "bearer-credential": 1,
      "assigned-token-literal": 1,
      "private-key-block": 1,
      "symmetric-jwk": 1,
    });
    expect(revealed(output, planted)).toEqual([]);
  });
});

describe("the gate says what a build without source maps hides", () => {
  const runScanner = () =>
    spawnSync(process.execPath, [SCANNER, dir], { encoding: "utf8" });

  it("notes a build that ships scripts and no source map, without failing it", () => {
    // Vite writes a `VITE_` name into a bundle mostly through its source map,
    // so a build without maps is one the name rules barely read.
    write("assets/app.js", "const a=1;");
    const run = runScanner();
    expect(run.status).toBe(0);
    expect(run.stderr.includes("no source map")).toBe(true);
  });

  it("says nothing more when the maps are there", () => {
    write("assets/app.js", "const a=1;");
    write("assets/app.js.map", sourceMap("const a = 1;"));
    const run = runScanner();
    expect(run.status).toBe(0);
    expect(run.stderr.includes("no source map")).toBe(false);
  });
});
