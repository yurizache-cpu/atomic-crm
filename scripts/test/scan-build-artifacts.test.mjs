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
});
