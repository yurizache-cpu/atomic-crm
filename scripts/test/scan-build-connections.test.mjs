import { describe, expect, it } from "vitest";
import {
  BACKSLASH,
  POSTGRES_SCHEME,
  postgresUrl,
  revealed,
  rulesByFile,
  scan,
  scratchBuildPerTest,
  sourceMap,
  synthetic,
  write,
} from "./scan-build-helpers.mjs";

// The connection-string rules of scripts/scan-build-rules-connections.mjs.
//
// Every fixture is SYNTHETIC and assembled at runtime, and no assertion names
// a fixture value: see ./scan-build-helpers.mjs.

scratchBuildPerTest();

describe("database connection strings", () => {
  it("catches a postgres URL escaped in a source map, slashes included", () => {
    const password = synthetic("pg-map", 16);
    write(
      "assets/app.js.map",
      sourceMap(`const u = "${postgresUrl("ops_worker_login", password)}";`),
    );
    write(
      "assets/escaped.json",
      `{"u":"${postgresUrl("ops_gateway_login", password).replace(/\//g, "\\/")}"}`,
    );
    expect(rulesByFile(scan())).toEqual([
      "postgres-connection-string critical assets/app.js.map",
      "postgres-connection-string critical assets/escaped.json",
    ]);
  });

  it("catches a worker or gateway login URL under any variable name", () => {
    write(
      "assets/worker.js",
      `const a="${postgresUrl("ops_worker_login", synthetic("w", 16))}";`,
    );
    write(
      "assets/gateway.js",
      `const b="${postgresUrl("ops_gateway_login", synthetic("g", 16))}";`,
    );
    expect(rulesByFile(scan())).toEqual([
      "postgres-connection-string critical assets/gateway.js",
      "postgres-connection-string critical assets/worker.js",
    ]);
  });

  it("catches a libpq keyword/value connection string with a password", () => {
    const password = synthetic("libpq", 18);
    const keywords = `host=db.example.invalid port=5432 user=ops_gateway_login password=${password} dbname=postgres`;
    write("assets/plain.js", `const c="${keywords}";`);
    write(
      "assets/first.js",
      `const c='password=${password} host=db user=ops';`,
    );
    write(
      "assets/quoted.js",
      `const c="dbname=x user=y password='${password} z'";`,
    );
    write("assets/app.js.map", sourceMap(`const c = "${keywords}";`));
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      [
        "assets/app.js.map",
        "assets/first.js",
        "assets/plain.js",
        "assets/quoted.js",
      ].map((file) => `libpq-connection-string critical ${file}`),
    );
    expect(revealed(JSON.stringify(found), { password })).toEqual([]);
  });

  it("catches a password in every userinfo shape a URL allows", () => {
    // Each was missed by an earlier, narrower pattern.
    const passwords = Object.fromEntries(
      [
        "azure",
        "slash",
        "interpolatedUser",
        "afterInterpolation",
        "escaped",
        "emptyUser",
        "socket",
        "twiceEscaped",
      ].map((label) => [label, synthetic(`userinfo-${label}`, 16)]),
    );
    const scheme = POSTGRES_SCHEME;
    const files = {
      // An Azure single-server login is `user@server`.
      "azure.js": `const u="${scheme}//admin@myserver:${passwords.azure}@myserver.postgres.database.azure.invalid/db";`,
      "slash.js": `const u="${scheme}//ad/min:${passwords.slash}@db.example.invalid/db";`,
      // An interpolated user does not make a literal password code.
      "interpolated-user.js":
        "const u=`" +
        scheme +
        "//${user}:" +
        passwords.interpolatedUser +
        "@db.example.invalid/db`;",
      "after-interpolation.js":
        "const u=`" +
        scheme +
        "//admin:${p}" +
        passwords.afterInterpolation +
        "@db.example.invalid/db`;",
      "escaped.js": `const u="${scheme}//admin:${passwords.escaped.slice(0, 8)}${BACKSLASH}${BACKSLASH}${passwords.escaped.slice(8)}@db.example.invalid/db";`,
      "empty-user.js": `const u="${scheme}//:${passwords.emptyUser}@db.example.invalid/db";`,
      // A socket directory instead of a host.
      "socket.js": `const u="${scheme}//u:${passwords.socket}@/db?host=/var/run/postgresql";`,
      // JSON escapes the slashes, and a source map escapes those escapes.
      "twice-escaped.js.map": sourceMap(
        `const e = ${JSON.stringify({ u: postgresUrl("u", passwords.twiceEscaped).replace(/\//g, BACKSLASH + "/") })};`,
      ),
    };
    for (const [file, content] of Object.entries(files)) write(file, content);
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      Object.keys(files)
        .map((file) => `postgres-connection-string critical ${file}`)
        .sort(),
    );
    expect(revealed(JSON.stringify(found), passwords)).toEqual([]);
  });

  it("catches a password passed as a URI query parameter, the JDBC form too", () => {
    const password = synthetic("query-password", 16);
    const query = `db.example.invalid:5432/db?user=admin&password=${password}`;
    write("assets/uri.js", `const u="${POSTGRES_SCHEME}//${query}";`);
    write("assets/jdbc.js", `const u="jdbc:${POSTGRES_SCHEME}//${query}";`);
    write(
      "assets/app.js.map",
      sourceMap(`const u = "${POSTGRES_SCHEME}//${query}&sslmode=require";`),
    );
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      ["assets/app.js.map", "assets/jdbc.js", "assets/uri.js"].map(
        (file) => `postgres-connection-string critical ${file}`,
      ),
    );
    // The match stops before the password: the report carries none of it.
    expect(revealed(JSON.stringify(found), { password })).toEqual([]);
  });

  it("accepts connection shapes that carry no literal credential", () => {
    const password = synthetic("near", 18);
    const scheme = POSTGRES_SCHEME;
    write(
      "assets/app.js",
      [
        `const a="https://example.invalid/login?user=someone&password=${password}";`,
        `const b="password=${password}";`,
        `const c="host=db user=ops dbname=postgres";`,
        "const d=`host=${h} user=${u} password=${p}`;",
        "const g=`host=${h} password='${p}'`;",
        "const e=`" + scheme + "//${user}:${password}@${host}/db`;",
        "const h=`" + scheme + "//${user}:${a}${b}@${host}/db`;",
        "const i=`" + scheme + "//db.example.invalid/db?user=u&password=${p}`;",
        `const f="${scheme}//db.example.invalid:5432/postgres";`,
        `const j="${scheme}//db.example.invalid:5432/postgres?user=u&sslmode=require";`,
      ].join("\n"),
    );
    expect(scan()).toEqual([]);
  });
});
