import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BROWSER_SAFE_VITE_VARIABLES,
  auditClientEnvironment,
  auditHostedSupabase,
  auditServiceEnvironment,
} from "../production-contract-env.mjs";

// Production Hosting Gate B: the environment contract, as a pure function of
// the variables and the facts a project gives. Every rule is exercised by the
// smallest environment that breaks it; all values synthetic.

const ROOT = process.cwd();
const good = () => ({
  VITE_SUPABASE_URL: "https://project-ref.supabase.co",
  VITE_SB_PUBLISHABLE_KEY: "sb_publishable_syntheticExampleKey123456",
});
const rules = (findings, severity = "blocking") =>
  findings.filter((f) => f.severity === severity).map((f) => f.rule);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) =>
  `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;

describe("the client (build) environment", () => {
  it("passes a hosted API and a publishable key", () => {
    expect(auditClientEnvironment(good())).toEqual([]);
  });

  it("passes an anon JWT as the publishable key", () => {
    const env = {
      ...good(),
      VITE_SB_PUBLISHABLE_KEY: jwt({ role: "anon", iss: "supabase" }),
    };
    expect(auditClientEnvironment(env)).toEqual([]);
  });

  it("refuses a demo build", () => {
    expect(
      rules(auditClientEnvironment({ ...good(), VITE_IS_DEMO: "true" })),
    ).toContain("demo-build");
    expect(
      auditClientEnvironment({ ...good(), VITE_IS_DEMO: "false" }),
    ).toEqual([]);
  });

  it("requires the API URL and the key", () => {
    expect(rules(auditClientEnvironment({}))).toEqual([
      "supabase-url-missing",
      "publishable-key-missing",
    ]);
    expect(
      rules(auditClientEnvironment({ ...good(), VITE_SUPABASE_URL: "" })),
    ).toContain("supabase-url-missing");
  });

  it.each([
    "http://project-ref.supabase.co",
    "project-ref.supabase.co",
    "ftp://project-ref.supabase.co",
  ])("refuses the API URL %s as not https", (url) => {
    expect(
      rules(auditClientEnvironment({ ...good(), VITE_SUPABASE_URL: url })),
    ).toContain("supabase-url-https");
  });

  it.each([
    "https://localhost",
    "https://127.0.0.1",
    "https://kong",
    "https://db.internal",
    "https://192.168.1.10",
    "https://demo.example.org",
    "https://anything.example.com",
    "https://api.dev.test",
  ])("refuses the API URL %s as local, private or a placeholder", (url) => {
    expect(
      rules(auditClientEnvironment({ ...good(), VITE_SUPABASE_URL: url })),
    ).toContain("supabase-url-local");
  });

  it("refuses the publishable key every local Supabase stack issues, by fingerprint", () => {
    const local = /VITE_SB_PUBLISHABLE_KEY=(\S+)/.exec(
      readFileSync(join(ROOT, ".env.e2e"), "utf8"),
    )[1];
    const findings = auditClientEnvironment({
      ...good(),
      VITE_SB_PUBLISHABLE_KEY: local,
    });
    expect(rules(findings)).toEqual(["local-publishable-key"]);
    expect(JSON.stringify(findings)).not.toContain(local);
  });

  it("refuses a secret key, and a JWT that is not anon, or is from a local stack, or is not a key at all", () => {
    const cases = [
      ["sb_secret_syntheticSecretKeyValue", "publishable-key-is-secret"],
      [jwt({ role: "service_role" }), "publishable-key-role"],
      [jwt({ role: "anon", iss: "supabase-demo" }), "local-publishable-key"],
      [
        jwt({ role: "anon", iss: "http://127.0.0.1:54321/auth/v1" }),
        "local-publishable-key",
      ],
      ["just-a-string", "publishable-key-shape"],
    ];
    for (const [key, rule] of cases) {
      const findings = auditClientEnvironment({
        ...good(),
        VITE_SB_PUBLISHABLE_KEY: key,
      });
      expect(rules(findings), key).toContain(rule);
      expect(JSON.stringify(findings), key).not.toContain(key);
    }
  });

  it("refuses a VITE_ variable named like a server secret, and notes an unaudited one", () => {
    for (const name of [
      "VITE_SERVICE_ROLE_KEY",
      "VITE_DB_PASSWORD",
      // Assembled at run time: engine/models/providerSecretsBoundary.test.ts
      // refuses a provider name behind VITE_ in any build input, this file too.
      ["VITE_", "OPENAI", "_API_KEY"].join(""),
      "VITE_ADMIN_DATABASE_URL",
    ]) {
      expect(
        rules(auditClientEnvironment({ ...good(), [name]: "x" })),
        name,
      ).toContain("privileged-vite-variable");
    }
    const unknown = auditClientEnvironment({
      ...good(),
      VITE_SOMETHING_NEW: "x",
    });
    expect(rules(unknown)).toEqual([]);
    expect(rules(unknown, "advisory")).toEqual(["unknown-vite-variable"]);
  });

  it("accepts every audited browser-safe variable without comment", () => {
    const env = { ...good() };
    for (const name of BROWSER_SAFE_VITE_VARIABLES) env[name] ??= "value";
    env.VITE_IS_DEMO = "false";
    expect(auditClientEnvironment(env)).toEqual([]);
  });
});

describe("the audited browser variable list is the list the application reads", () => {
  const read = (path) => readFileSync(join(ROOT, path), "utf8");
  const walk = (dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory())
        return entry.name === "node_modules" ? [] : walk(path);
      return /\.(ts|tsx)$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !path.includes("/testing/")
        ? [path]
        : [];
    });

  it("covers every VITE_ name in application source, the build configs and the deploy workflow", () => {
    const sources = [
      ...walk("src"),
      "vite.config.ts",
      "vite.demo.config.ts",
      ".github/workflows/deploy.yml",
    ];
    const found = new Set();
    for (const path of sources) {
      for (const [name] of read(path).matchAll(/\bVITE_[A-Z0-9_]+\b/g))
        found.add(name);
    }
    const unaudited = [...found].filter(
      (name) => !BROWSER_SAFE_VITE_VARIABLES.includes(name),
    );
    expect(
      unaudited,
      "a VITE_ variable the application reads is not in BROWSER_SAFE_VITE_VARIABLES: audit that it is meant for a browser, then add it",
    ).toEqual([]);
  });
});

describe("the service (worker, gateway, operator) environment", () => {
  it("passes an environment with nothing selected (providers off)", () => {
    expect(auditServiceEnvironment({})).toEqual([]);
  });

  it.each(["DECISION_SHADOW_PROVIDER", "CALENDAR_PROVIDER"])(
    "refuses %s=fake",
    (name) => {
      expect(rules(auditServiceEnvironment({ [name]: "fake" }))).toEqual([
        "fake-provider",
      ]);
    },
  );

  it("notes a boundary that is not connected, without blocking", () => {
    const findings = auditServiceEnvironment({
      DECISION_SHADOW_PROVIDER: "jev",
      CALENDAR_PROVIDER: "google",
    });
    expect(rules(findings)).toEqual([]);
    expect(rules(findings, "advisory")).toEqual([
      "unconnected-provider",
      "unconnected-provider",
    ]);
  });

  it("refuses synthetic ingress", () => {
    expect(
      rules(
        auditServiceEnvironment({ COMPANY_OS_SYNTHETIC_INGRESS: "enabled" }),
      ),
    ).toEqual(["synthetic-ingress"]);
    expect(
      auditServiceEnvironment({ COMPANY_OS_SYNTHETIC_INGRESS: "disabled" }),
    ).toEqual([]);
  });

  it.each([
    "postgresql://u:p@127.0.0.1:54322/postgres",
    "postgresql://u:p@localhost:5432/postgres",
    "postgresql://u:p@host.docker.internal:5432/postgres",
    "postgresql://u:p@db.project-ref.supabase.co:54322/postgres",
  ])("refuses a local database %s", (url) => {
    for (const name of [
      "ADMIN_DATABASE_URL",
      "OPS_WORKER_DATABASE_URL",
      "OPS_GATEWAY_DATABASE_URL",
    ]) {
      const findings = auditServiceEnvironment({ [name]: url });
      expect(rules(findings), name).toEqual(["local-database"]);
      expect(JSON.stringify(findings)).not.toContain("u:p");
    }
  });

  it("accepts a hosted database and refuses a value that is not a URL", () => {
    expect(
      auditServiceEnvironment({
        ADMIN_DATABASE_URL:
          "postgresql://u:p@db.project-ref.supabase.co:5432/postgres",
      }),
    ).toEqual([]);
    expect(
      rules(auditServiceEnvironment({ ADMIN_DATABASE_URL: "not a url" })),
    ).toEqual(["database-url"]);
  });

  it("notes a local telemetry collector without blocking", () => {
    const findings = auditServiceEnvironment({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
    });
    expect(rules(findings)).toEqual([]);
    expect(rules(findings, "advisory")).toEqual(["local-telemetry-endpoint"]);
  });
});

describe("a hosted Supabase project", () => {
  const cleanDatabase = () => ({
    exemptionRows: 0,
    seedMarks: 0,
    appliedMigrations: ["20260101000000", "20260102000000"],
    repositoryMigrations: ["20260101000000", "20260102000000"],
  });
  const settings = { disable_signup: true, mailer_autoconfirm: false };

  it("passes a closed, unseeded, unexempted project on the repository's migrations", () => {
    expect(
      auditHostedSupabase({
        authSettings: settings,
        database: cleanDatabase(),
      }),
    ).toEqual([]);
  });

  it("checks only what was read", () => {
    expect(auditHostedSupabase({ authSettings: null, database: null })).toEqual(
      [],
    );
  });

  it("refuses open self-registration, and notes auto-confirmed email", () => {
    expect(
      rules(
        auditHostedSupabase({
          authSettings: { disable_signup: false },
          database: null,
        }),
      ),
    ).toEqual(["signup-open"]);
    const findings = auditHostedSupabase({
      authSettings: { disable_signup: true, mailer_autoconfirm: true },
      database: null,
    });
    expect(rules(findings)).toEqual([]);
    expect(rules(findings, "advisory")).toEqual(["email-autoconfirm"]);
  });

  it("refuses the local exemption row and the development seed", () => {
    const findings = auditHostedSupabase({
      authSettings: settings,
      database: { ...cleanDatabase(), exemptionRows: 1, seedMarks: 2 },
    });
    expect(rules(findings)).toEqual([
      "assurance-exemption-present",
      "development-seed-applied",
    ]);
  });

  it("refuses migrations that are not exactly the repository's, either way", () => {
    const missing = auditHostedSupabase({
      authSettings: settings,
      database: { ...cleanDatabase(), appliedMigrations: ["20260101000000"] },
    });
    expect(rules(missing)).toEqual(["migrations-missing"]);
    const unknown = auditHostedSupabase({
      authSettings: settings,
      database: {
        ...cleanDatabase(),
        appliedMigrations: [
          ...cleanDatabase().appliedMigrations,
          "29990101000000",
        ],
      },
    });
    expect(rules(unknown)).toEqual(["migrations-unknown"]);
  });
});
