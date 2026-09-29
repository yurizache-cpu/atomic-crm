import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  assertDeploymentEnvironment,
  deploymentEnvironmentFromEnv,
  isNonPublicHost,
  productionServiceFindings,
  serviceEnvironmentFindings,
} from "./deploymentEnvironment.ts";

// Production Hosting (SI-77): the start gate a deployed worker or gateway runs
// before anything else. All values synthetic; the connection strings carry a
// marker password so a test can prove no message repeats a value.

const SECRET = "synthetic-password-that-must-not-appear";
const HOSTED_DB = `postgresql://ops_worker_login:${SECRET}@db.project-ref.supabase.co:5432/postgres`;
const LOCAL_DB = `postgresql://ops_worker_login:${SECRET}@127.0.0.1:54342/postgres`;
const blocking = (findings: readonly { rule: string; severity: string }[]) =>
  findings.filter((f) => f.severity === "blocking").map((f) => f.rule);

describe("the declared environment", () => {
  it("is local when unset or empty, and exactly what is declared otherwise", () => {
    expect(deploymentEnvironmentFromEnv({})).toBe("local");
    expect(deploymentEnvironmentFromEnv({ DEPLOYMENT_ENVIRONMENT: "" })).toBe(
      "local",
    );
    for (const value of ["local", "staging", "production"] as const) {
      expect(
        deploymentEnvironmentFromEnv({ DEPLOYMENT_ENVIRONMENT: value }),
      ).toBe(value);
    }
  });

  it.each(["prod", "Production", "PRODUCTION", "stage", "dev", " production"])(
    "refuses the misspelt value %j instead of reading it as local",
    (value) => {
      expect(() =>
        deploymentEnvironmentFromEnv({ DEPLOYMENT_ENVIRONMENT: value }),
      ).toThrow(/must be unset, "local", "staging" or "production"/);
    },
  );
});

describe("what each environment refuses", () => {
  const testOnly = {
    DECISION_SHADOW_PROVIDER: "fake",
    CALENDAR_PROVIDER: "fake",
    COMPANY_OS_SYNTHETIC_INGRESS: "enabled",
    OPS_WORKER_DATABASE_URL: LOCAL_DB,
  };

  it("local refuses nothing: developer machines and the tests run as before", () => {
    expect(serviceEnvironmentFindings(testOnly, "local")).toEqual([]);
  });

  it("staging refuses a local database but keeps its synthetic tools", () => {
    expect(blocking(serviceEnvironmentFindings(testOnly, "staging"))).toEqual([
      "local-database",
    ]);
  });

  it("production refuses the test providers, synthetic ingress and a local database", () => {
    expect(
      blocking(serviceEnvironmentFindings(testOnly, "production")).sort(),
    ).toEqual(
      [
        "fake-provider",
        "fake-provider",
        "local-database",
        "synthetic-ingress",
      ].sort(),
    );
  });

  it("production accepts a hosted database with every provider off", () => {
    expect(
      serviceEnvironmentFindings(
        { OPS_WORKER_DATABASE_URL: HOSTED_DB },
        "production",
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "OPS_GATEWAY_DATABASE_URL",
      `postgresql://g:${SECRET}@host.docker.internal:5432/postgres`,
    ],
    [
      "ADMIN_DATABASE_URL",
      `postgresql://a:${SECRET}@db.project-ref.supabase.co:54322/postgres`,
    ],
    [
      "OPS_WORKER_DATABASE_URL",
      `postgresql://w:${SECRET}@10.0.0.4:5432/postgres`,
    ],
  ])("refuses %s on a local host or a local Supabase port", (name, value) => {
    expect(
      blocking(serviceEnvironmentFindings({ [name]: value }, "staging")),
    ).toEqual(["local-database"]);
  });

  it("the preflight's question is always the production one", () => {
    expect(blocking(productionServiceFindings(testOnly))).toContain(
      "fake-provider",
    );
  });

  it("knows a private IPv6 literal, in the forms a URL writes it, from a public one", () => {
    for (const host of [
      "[::1]",
      "[::]",
      "[fc00::1]",
      "[fd12:3456::1]",
      "[fe80::1]",
      "[febf::1]",
      // A URL serialises an IPv4-mapped address in hex: ::ffff:127.0.0.1.
      new URL("postgresql://u:p@[::ffff:127.0.0.1]:5432/x").hostname,
      "[::ffff:c0a8:101]",
      "100.64.0.1",
    ]) {
      expect(isNonPublicHost(host), host).toBe(true);
    }
    for (const host of [
      "[2600:1f18::1]",
      "[fec0::1]",
      "[::ffff:808:808]",
      "100.128.0.1",
    ]) {
      expect(isNonPublicHost(host), host).toBe(false);
    }
    expect(
      blocking(
        serviceEnvironmentFindings(
          {
            OPS_WORKER_DATABASE_URL: `postgresql://w:${SECRET}@[fd00::5]:5432/postgres`,
          },
          "production",
        ),
      ),
    ).toEqual(["local-database"]);
  });

  it("knows a private host from a public one", () => {
    for (const host of [
      "localhost",
      "kong",
      "db.internal",
      "192.168.1.2",
      "172.16.0.1",
      "127.0.0.1",
    ]) {
      expect(isNonPublicHost(host), host).toBe(true);
    }
    for (const host of [
      "db.project-ref.supabase.co",
      "172.32.0.1",
      "8.8.8.8",
    ]) {
      expect(isNonPublicHost(host), host).toBe(false);
    }
  });
});

describe("the start gate", () => {
  it("returns the environment and its advisories when nothing blocks", () => {
    const result = assertDeploymentEnvironment(
      { DEPLOYMENT_ENVIRONMENT: "production", DECISION_SHADOW_PROVIDER: "jev" },
      "worker",
    );
    expect(result.environment).toBe("production");
    expect(result.advisories.map((f) => f.rule)).toEqual([
      "unconnected-provider",
    ]);
  });

  it("refuses with every blocking rule named, and never a value", () => {
    let message = "";
    try {
      assertDeploymentEnvironment(
        {
          DEPLOYMENT_ENVIRONMENT: "production",
          CALENDAR_PROVIDER: "fake",
          OPS_WORKER_DATABASE_URL: LOCAL_DB,
        },
        "worker",
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^Refusing to start the worker in production: /);
    expect(message).toMatch(/CALENDAR_PROVIDER is "fake"/);
    expect(message).toMatch(
      /OPS_WORKER_DATABASE_URL names a local or private database/,
    );
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("127.0.0.1");
  });
});

describe("the real processes refuse before they open anything", () => {
  const run = (script: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...env,
      },
      encoding: "utf8",
      timeout: 60_000,
    });

  it("the worker exits 1 in production with a fake provider, printing no value", () => {
    const result = run("engine/worker/main.ts", {
      DEPLOYMENT_ENVIRONMENT: "production",
      DECISION_SHADOW_PROVIDER: "fake",
      OPS_WORKER_DATABASE_URL: LOCAL_DB,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/worker\.fatal/);
    expect(result.stderr).toMatch(/Refusing to start the worker in production/);
    expect(result.stderr + result.stdout).not.toContain(SECRET);
  });

  it("the gateway exits 1 in staging with a local database, before reading its secrets", () => {
    const result = run("engine/cli/whatsappGateway.ts", {
      DEPLOYMENT_ENVIRONMENT: "staging",
      OPS_GATEWAY_DATABASE_URL: `postgresql://g:${SECRET}@127.0.0.1:54342/postgres`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing to start the gateway in staging/);
    // Refused before WHATSAPP_APP_SECRET was even looked for.
    expect(result.stderr).not.toMatch(/WHATSAPP_APP_SECRET is required/);
    expect(result.stderr + result.stdout).not.toContain(SECRET);
  });

  it("both refuse a misspelt environment", () => {
    for (const script of [
      "engine/worker/main.ts",
      "engine/cli/whatsappGateway.ts",
    ]) {
      const result = run(script, { DEPLOYMENT_ENVIRONMENT: "prod" });
      expect(result.status, script).toBe(1);
      expect(result.stderr, script).toMatch(
        /DEPLOYMENT_ENVIRONMENT must be unset/,
      );
    }
  });
});
