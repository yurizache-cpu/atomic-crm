import { describe, expect, it } from "vitest";
import {
  ASSIGNED,
  BASE64URL,
  escapedValue,
  jwt,
  metaToken,
  revealed,
  rulesByFile,
  scan,
  scratchBuildPerTest,
  sourceMap,
  synthetic,
  write,
} from "./scan-build-helpers.mjs";

// The JWT rules of scripts/scan-build-rules-supabase-keys.mjs, and the Meta,
// bearer and credential-field rules of scripts/scan-build-rules-tokens.mjs.
//
// Every fixture is SYNTHETIC and assembled at runtime, and no assertion names
// a fixture value: see ./scan-build-helpers.mjs.

scratchBuildPerTest();

const FORBIDDEN_ROLES = [
  "service_role",
  "supabase_admin",
  "postgres",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_functions_admin",
  "authenticator",
  "ops_worker",
  "ops_gateway",
  "ops_operator_api",
];

describe("service-role and other non-anon JWTs", () => {
  it.each(FORBIDDEN_ROLES)(
    "refuses a JWT whose role is %s, as critical",
    (role) => {
      write("assets/app.js", `const t="${jwt(role)}";`);
      write("assets/app.js.map", sourceMap(`const t = "${jwt(role)}";`));
      expect(rulesByFile(scan())).toEqual([
        "privileged-jwt critical assets/app.js",
        "privileged-jwt critical assets/app.js.map",
      ]);
    },
  );

  it("refuses an authenticated JWT: a signed-in user's session baked into a file", () => {
    write("assets/app.js", `const t="${jwt("authenticated")}";`);
    expect(scan().map((f) => [f.rule, f.severity, f.detail])).toEqual([
      [
        "non-anon-jwt",
        "high",
        'JWT whose role claim is "authenticated", not anon',
      ],
    ]);
  });

  it("refuses a JWT naming any other role, since PostgREST would switch to it", () => {
    write("assets/app.js", `const t="${jwt("clinic_reporting")}";`);
    expect(rulesByFile(scan())).toEqual(["non-anon-jwt high assets/app.js"]);
  });

  it("accepts an anon JWT and a JWT with no role claim", () => {
    write(
      "assets/app.js",
      `const a="${jwt("anon")}";const b="${jwt(undefined)}";`,
    );
    expect(scan()).toEqual([]);
  });
});

describe("Meta access tokens", () => {
  it("catches a Meta token in code, an env object, a source map and a bare line", () => {
    const token = metaToken("meta");
    write("assets/code.js", `fetch(u,{headers:{a:"${token}"}});`);
    write("assets/object.js", `const e={"TOKEN":"${token}"};`);
    write(
      "assets/app.js.map",
      sourceMap(`const t = "${token}";`, `TOKEN=${token}`),
    );
    write("assets/bare.txt", `first line\n${token}\nlast line`);
    expect(rulesByFile(scan())).toEqual(
      [
        "assets/app.js.map",
        "assets/bare.txt",
        "assets/code.js",
        "assets/object.js",
      ].map((file) => `meta-access-token critical ${file}`),
    );
  });

  it("reports the token once more under its name, and never its value", () => {
    const token = metaToken("meta-named");
    write("assets/app.js", `const e={"WHATSAPP_ACCESS_TOKEN":"${token}"};`);
    const found = scan();
    expect(found.map((f) => f.rule).sort()).toEqual([
      ASSIGNED,
      "meta-access-token",
    ]);
    expect(revealed(JSON.stringify(found), { token })).toEqual([]);
  });

  it("never matches inside base64, a wrapped blob, a source map's mappings or a short run", () => {
    const run = metaToken("blob", 150);
    write(
      "assets/app.js",
      [
        // Inside a base64 string: a base64 character on either side.
        `const a="data:font/woff2;base64,QUJD${run}";`,
        `const b="${run}+/xyz==";`,
        `const c="Zm9v+${run}";`,
        // A base64 blob wrapped by line continuations (Storybook ships one).
        `const d="AAAA\\\n${run}\\\nAAAA";`,
        // Too short to be a token.
        `const e="${metaToken("short", 99)}";`,
      ].join("\n"),
    );
    write(
      "assets/app.js.map",
      JSON.stringify({
        mappings: Array.from({ length: 80 }, () => "EAAA").join(","),
      }),
    );
    expect(scan()).toEqual([]);
  });
});

describe("bearer- and token-shaped literals", () => {
  it("catches a literal bearer credential, in code and in a source map", () => {
    const credential = synthetic("bearer", 40, BASE64URL);
    write(
      "assets/code.js",
      `fetch(u,{headers:{Authorization:"Bearer ${credential}"}});`,
    );
    write("assets/upper.js", `const h='Authorization: BEARER ${credential}';`);
    write(
      "assets/app.js.map",
      sourceMap(`headers["Authorization"] = "bearer ${credential}";`),
    );
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      ["assets/app.js.map", "assets/code.js", "assets/upper.js"].map(
        (file) => `bearer-credential high ${file}`,
      ),
    );
    expect(revealed(JSON.stringify(found), { credential })).toEqual([]);
  });

  it("accepts a bearer built from a variable, prose, and the public API key", () => {
    write(
      "assets/app.js",
      [
        'const a="Bearer "+t;',
        "const b=`Bearer ${t}`;",
        'const c="Bearer ".concat(t);',
        "// Bearer tokens are sent in the Authorization header.",
        `const d="Bearer ${synthetic("short", 19)}";`,
        `const e="Bearer ${jwt("anon")}";`,
        `const f="Bearer sb_publishable_${synthetic("pub", 24)}";`,
        "const g=Bearer someVeryLongFunctionNameCall(x);",
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });

  it("catches a credential field assigned a literal", () => {
    const value = synthetic("field", 40, BASE64URL);
    write(
      "assets/access.js",
      `const s={access_token:"${value}",expires_in:3600};`,
    );
    write(
      "assets/refresh.js",
      `const s=${JSON.stringify({ refresh_token: value })};`,
    );
    write("assets/client.js", `const o={client_secret:'${value}'};`);
    write("assets/api.js.map", sourceMap(`api_key="${value}"`));
    write(
      "assets/url.js",
      `const u="https://app.example.invalid/cb#access_token=${value}&token_type=bearer";`,
    );
    const found = scan();
    expect(found.map((f) => `${f.rule} ${f.file} ${f.detail}`).sort()).toEqual([
      "assigned-token-literal assets/access.js credential field assigned a literal (access_token)",
      "assigned-token-literal assets/api.js.map credential field assigned a literal (api_key)",
      "assigned-token-literal assets/client.js credential field assigned a literal (client_secret)",
      "assigned-token-literal assets/refresh.js credential field assigned a literal (refresh_token)",
      "assigned-token-literal assets/url.js credential field assigned a literal (access_token)",
    ]);
    expect(revealed(JSON.stringify(found), { value })).toEqual([]);
  });

  it("catches a credential field whose literal holds escape sequences", () => {
    const value = escapedValue("field-escaped");
    write("assets/app.js", `const s={client_secret:"${value}"};`);
    write("assets/app.js.map", sourceMap(`const s = {"api_key": "${value}"};`));
    const found = scan();
    expect(rulesByFile(found)).toEqual([
      "assigned-token-literal high assets/app.js",
      "assigned-token-literal high assets/app.js.map",
    ]);
    expect(revealed(JSON.stringify(found), { value })).toEqual([]);
  });

  it("accepts a credential field read from code, a short value and the public API key", () => {
    write(
      "assets/app.js",
      [
        "const a={access_token:e.session.access_token};",
        'const b="grant_type=refresh_token";',
        'const c={refresh_token:"short"};',
        "const d={access_token:`${t}`};",
        `const e={api_key:"sb_publishable_${synthetic("pub", 24)}"};`,
        `const f={access_token:"${jwt("anon")}"};`,
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });
});
