import { describe, expect, it } from "vitest";
import {
  ASSIGNED,
  BROWSER_PROVIDER,
  EARLIER_SERVER_NAMES,
  HEX,
  PHASE_2C_SERVER_NAMES,
  PRIVILEGED_VITE,
  assignmentForms,
  escapedValue,
  repositoryViteNames,
  revealed,
  rulesByFile,
  scan,
  scratchBuildPerTest,
  sourceMap,
  synthetic,
  viteName,
  write,
} from "./scan-build-helpers.mjs";

// The name rules of scripts/scan-build-rules-names.mjs: a server-only name
// assigned a value, and a privileged `VITE_` name.
//
// Every fixture is SYNTHETIC and assembled at runtime, and no assertion names
// a fixture value: see ./scan-build-helpers.mjs.

scratchBuildPerTest();

describe("server-only variable names, in every spelling a build produces", () => {
  it.each(PHASE_2C_SERVER_NAMES)("refuses %s assigned a value", (name) => {
    const forms = assignmentForms(name, synthetic(name, 24));
    for (const [file, content] of Object.entries(forms)) write(file, content);
    expect(rulesByFile(scan())).toEqual(
      Object.keys(forms)
        .map((file) => `${ASSIGNED} high ${file}`)
        .sort(),
    );
    expect(new Set(scan().map((f) => f.detail))).toEqual(
      new Set([`server-only variable assigned a value (${name})`]),
    );
  });

  it.each([...EARLIER_SERVER_NAMES, ...PHASE_2C_SERVER_NAMES])(
    "refuses %s assigned a value that holds escape sequences",
    (name) => {
      // `\\`, `\n` and `\/` inside the value, as code writes them and as a
      // source map escapes them once more. A backslash once ended the value,
      // so such a secret was no finding.
      const value = escapedValue(name);
      const forms = assignmentForms(name, value);
      for (const [file, content] of Object.entries(forms)) write(file, content);
      const found = scan();
      expect(rulesByFile(found)).toEqual(
        Object.keys(forms)
          .map((file) => `${ASSIGNED} high ${file}`)
          .sort(),
      );
      expect(revealed(JSON.stringify(found), { value })).toEqual([]);
    },
  );

  it("reads an unquoted .env value only to the end of its line", () => {
    // In a source map the line ends at an escaped newline: the value must not
    // run on into the next variable, which is a finding of its own.
    const first = synthetic("first-line", 16);
    const second = synthetic("second-line", 16);
    write(
      "assets/env.js.map",
      sourceMap(
        `# env\nOPS_WORKER_PASSWORD=${first}\nOPS_GATEWAY_PASSWORD=${second}\n`,
      ),
    );
    const found = scan();
    expect(found.map((f) => f.detail).sort()).toEqual([
      "server-only variable assigned a value (OPS_GATEWAY_PASSWORD)",
      "server-only variable assigned a value (OPS_WORKER_PASSWORD)",
    ]);
    expect(revealed(JSON.stringify(found), { first, second })).toEqual([]);
  });

  it("still refuses every earlier name, now in the inlined and escaped forms too", () => {
    for (const name of EARLIER_SERVER_NAMES) {
      const forms = assignmentForms(name, synthetic(name, 24));
      write(`${name}/inlined.js`, forms["inlined.js"]);
      write(`${name}/quoted.js.map`, forms["quoted.js.map"]);
    }
    const found = scan();
    expect(found.every((f) => f.rule === ASSIGNED)).toBe(true);
    expect(found.map((f) => f.file).sort()).toEqual(
      EARLIER_SERVER_NAMES.flatMap((name) => [
        `${name}/inlined.js`,
        `${name}/quoted.js.map`,
      ]).sort(),
    );
  });

  it("refuses the prefixed spelling of every server name by its name alone", () => {
    // The name rule does not read `VITE_NAME`: the name classes do, so one
    // leak is one finding.
    const names = [...EARLIER_SERVER_NAMES, ...PHASE_2C_SERVER_NAMES];
    names.forEach((name) =>
      write(`${name}.js`, `const v=import.meta.env.${viteName(name)};`),
    );
    const found = scan();
    expect(found.map((f) => f.file).sort()).toEqual(
      names.map((name) => `${name}.js`).sort(),
    );
    expect(
      found.every((f) => [PRIVILEGED_VITE, BROWSER_PROVIDER].includes(f.rule)),
    ).toBe(true);
  });

  it("accepts code that names a server variable without holding its value", () => {
    for (const name of PHASE_2C_SERVER_NAMES) {
      write(
        `${name}.js.map`,
        sourceMap(
          `const v = env.${name};`,
          `const schema = { ${name}: z.string() };`,
          `throw new Error("${name} is required");`,
          // The idiom engine/cli/agentRunSmoke.ts uses to name its variables.
          `export const ${name} = "${name}";`,
          `const c = { ${name}: "short" };`,
          `const d = { ${name}: \`\${value}\` };`,
        ),
      );
    }
    expect(scan()).toEqual([]);
  });
});

/** Every privileged word has a name here that carries it and no other word,
 *  so dropping a word from the rule fails this list by name. */
const PRIVILEGED_SUFFIXES = [
  // Words and compounds, wherever they stand.
  "SUPABASE_SERVICE_ROLE_KEY", // SERVICE_ROLE
  "SUPABASE_SERVICE_KEY", // SERVICE_KEY
  "PRIVATE_KEY_PEM", // PRIVATE
  "SIGNING_KEY_ID", // SIGNING
  "SUPABASE_DATABASE_URL", // DATABASE_URL
  "MAIN_DATABASE_URI", // DATABASE_URI
  "SUPABASE_DB_URL", // DB_URL
  "MAIN_DB_URI", // DB_URI
  "MAIN_POSTGRES_URL", // POSTGRES_URL
  "MAIN_POSTGRES_URI", // POSTGRES_URI
  "MAIN_PG_URL", // PG_URL
  "MAIN_PG_URI", // PG_URI
  "MAIN_DB_CONNECTION", // DB_CONNECTION
  "MAIN_DATABASE_CONNECTION", // DATABASE_CONNECTION
  "PG_CONNECTION_POOL", // PG_CONNECTION
  "APP_CONNECTION_STRING", // CONNECTION_STRING
  "APP_CONNECTION_URL", // CONNECTION_URL
  "APP_CONNECTION_URI", // CONNECTION_URI
  "APP_CONN_STRING", // CONN_STRING
  "APP_CONN_STR", // CONN_STR
  "SUPABASE_ADMIN_EMAIL", // ADMIN
  "OPS_WORKER_ID", // OPS_WORKER
  "OPS_GATEWAY_HOST", // OPS_GATEWAY
  "MAIN_WORKER_KEY", // WORKER_KEY
  "MAIN_GATEWAY_KEY", // GATEWAY_KEY
  "WHATSAPP_PHONE_NUMBER_ID", // WHATSAPP
  // The same compounds written as one word.
  "SERVICEROLE_KEY", // SERVICEROLE
  "SUPABASE_SERVICEKEY", // SERVICEKEY
  "RSA_PRIVATEKEY", // PRIVATEKEY
  "JWT_SIGNINGKEY", // SIGNINGKEY
  "MAIN_DATABASEURL", // DATABASEURL
  "MONGO_DBURL", // DBURL
  "MAIN_PGURL", // PGURL
  "MAIN_POSTGRESURL", // POSTGRESURL
  // Credential words, anywhere and at the end of a word.
  "SMTP_PASSWORD", // PASSWORD
  "DB_PASSWD_FILE", // PASSWD
  "SSH_PASSPHRASE", // PASSPHRASE
  "JWT_SECRET", // SECRET, and the brief's JWT_SECRET
  "WHATSAPP_APP_SECRET", // the brief's APP_SECRET
  "APP_SECRETS_JSON", // SECRETS
  "GITHUB_TOKEN", // TOKEN
  "SUPABASE_ACCESS_TOKEN_JSON", // the brief's ACCESS_TOKEN
  "WEBHOOK_VERIFY_TOKEN_VALUE", // the brief's VERIFY_TOKEN
  "META_TOKEN_VALUE", // the brief's META_TOKEN
  "JWTSECRET", // SECRET, glued
  "DBPASSWORD", // PASSWORD, glued
  "ACCESSTOKEN", // TOKEN, glued
  "DB_PASSWORD_PROD", // a qualifier after the word
  "DB_PASSWORD_2",
  "SESSION_TOKEN_PROD",
  "PASSWORD2", // a number glued on
  "SECRET2",
  // Abbreviations, as the last word.
  "DB_PASS", // PASS
  "SMTP_PASS2",
  "PG_PWD", // PWD
  "DB_PWD_PROD",
  // Other spellings.
  "smtpPassword", // camelCase
  "jwt_secret", // lower case
];

/** Names that border the rule and must stay out of it. */
const BORDERING_SUFFIXES = [
  "PASSWORD_RESET_URL", // PASSWORD, then a word about it
  "passwordMinLength",
  "TOKEN_REFRESH_INTERVAL",
  "OAUTH_TOKEN_URL",
  "TOKEN_ENDPOINT",
  "PASSWORD_POLICY",
  "ADMINISTRATOR_EMAIL", // ADMIN only whole
  "SECRETARY_EMAIL", // SECRET only whole or at the end of a word
  "PASS_THROUGH_PROXY", // PASS only last
  "BYPASS_CACHE",
  "COMPASS_URL",
  "PASSKEY_ENABLED",
  "MAX_TOKENS", // TOKENS is not TOKEN
  "DESIGN_TOKENS",
  "CONNECTION_TIMEOUT_MS",
  "GATEWAY_URL", // GATEWAY only as OPS_GATEWAY or GATEWAY_KEY
  "WORKER_POOL_SIZE", // WORKER only as OPS_WORKER or WORKER_KEY
  "PRIVACY_POLICY_URL",
  "SIGNUP_URL",
  "SENTRY_DSN",
  "S3_BUCKET",
];

/** Vite 7.3.2's own `VITE_` names and placeholders (node_modules/vite/dist,
 *  measured 2026-09-23). */
const VITE_OWN_NAMES = [
  "__VITE_PRELOAD__",
  "__VITE_ASSET__",
  "__VITE_PUBLIC_ASSET__",
  "__VITE_WORKER_ASSET__",
  "__VITE_IS_MODERN__",
  "__VITE_CSS_URL__",
  "__VITE_INLINE_CSS__",
  "VITE_USER_NODE_ENV",
  "VITE_DEBUG_FILTER",
  "VITE_SOURCEMAP_COMBINE_FILTER",
  "VITE_PACKAGE_DIR",
  "VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS",
];

describe("privileged VITE_ variables", () => {
  // Its source-level test stays in scan-build-artifacts.test.mjs, where SI-59
  // names it.
  it("refuses a VITE_ name carrying each privileged word", () => {
    const names = PRIVILEGED_SUFFIXES.map(viteName);
    names.forEach((name, i) =>
      write(`assets/chunk-${i}.js`, `const v=import.meta.env.${name};`),
    );
    const found = scan();
    expect(
      found.map((f) => `${f.rule} ${f.severity} ${f.detail}`).sort(),
    ).toEqual(
      names
        .map(
          (name) =>
            `${PRIVILEGED_VITE} critical privileged variable exposed to the browser (${name})`,
        )
        .sort(),
    );
  });

  it("refuses a privileged VITE_ name however a build spells it, and never reports its value", () => {
    const name = viteName("WHATSAPP_APP_SECRET");
    const value = synthetic("vite-value", 32, HEX);
    write("assets/inlined.js", `const e=${JSON.stringify({ [name]: value })};`);
    write(
      "assets/quoted.js.map",
      sourceMap(`const e = {"${name}": "${value}"};`),
    );
    write("assets/dotenv.js.map", sourceMap(`# env\n${name}=${value}`));
    write("assets/escaped.js", `e["\\u0056${name.slice(1)}"]`);
    const found = scan();
    expect(rulesByFile(found)).toEqual(
      [
        "assets/dotenv.js.map",
        "assets/escaped.js",
        "assets/inlined.js",
        "assets/quoted.js.map",
      ].map((file) => `${PRIVILEGED_VITE} critical ${file}`),
    );
    expect(revealed(JSON.stringify(found), { value })).toEqual([]);
  });

  it("accepts every VITE_ name the repository reads, Vite's own names and the bordering ones", () => {
    const repository = repositoryViteNames();
    // The listing must reach the SPA's variables: an empty one proves nothing.
    expect(repository).toEqual(
      expect.arrayContaining([
        "VITE_SUPABASE_URL",
        "VITE_SB_PUBLISHABLE_KEY",
        "VITE_IS_DEMO",
        "VITE_INBOUND_EMAIL",
        "VITE_ATTACHMENTS_BUCKET",
        "VITE_GOOGLE_WORKPLACE_DOMAIN",
        "VITE_DISABLE_EMAIL_PASSWORD_AUTHENTICATION",
      ]),
    );
    const names = [
      ...repository,
      "VITE_SUPABASE_ANON_KEY",
      ...VITE_OWN_NAMES,
      ...BORDERING_SUFFIXES.map(viteName),
    ];
    write(
      "assets/app.js",
      names.map((name) => `import.meta.env.${name};`).join("\n"),
    );
    write("assets/app.js.map", sourceMap(JSON.stringify(names)));
    expect(scan().filter((f) => f.rule === PRIVILEGED_VITE)).toEqual([]);
  });
});
