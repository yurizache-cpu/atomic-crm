import { describe, expect, it } from "vitest";
import { parseEnvFile, stagingEnvironment } from "../with-staging.mjs";

// The staging launcher hands a child exactly one constrained role, over
// verified TLS, and never an owner URL or a value in an error.
const FILE = parseEnvFile(
  [
    "# comment",
    "STAGING_DB_PASSWORD=",
    "OPS_WORKER_PASSWORD=w0rker/secret+",
    "OPS_GATEWAY_PASSWORD=gateway-secret",
    "STAGING_PROJECT_REF=abcdefghijklmnopqrst",
    "STAGING_POOLER_HOST=aws-0-sa-east-1.pooler.supabase.com",
    "STAGING_ROOT_CA=C:/Users/x/.atomic-crm/root.crt",
    "",
  ].join("\r\n"),
);
const PARENT = {
  PATH: "/bin",
  ADMIN_DATABASE_URL: "postgresql://postgres:owner@db/postgres",
  OPS_GATEWAY_DATABASE_URL: "postgresql://other",
  DEPLOYMENT_ENVIRONMENT: "production",
};

describe("the staging launcher", () => {
  it("gives the worker one verified pooler URL and staging, and drops every other database URL", () => {
    const env = stagingEnvironment("worker", FILE, PARENT);
    const url = new URL(env.OPS_WORKER_DATABASE_URL);
    expect(decodeURIComponent(url.username)).toBe(
      "ops_worker_login.abcdefghijklmnopqrst",
    );
    expect(decodeURIComponent(url.password)).toBe("w0rker/secret+");
    expect(url.host).toBe("aws-0-sa-east-1.pooler.supabase.com:5432");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("sslrootcert")).toBe(
      "C:/Users/x/.atomic-crm/root.crt",
    );
    expect(env.DEPLOYMENT_ENVIRONMENT).toBe("staging");
    expect(env.ADMIN_DATABASE_URL).toBeUndefined();
    expect(env.OPS_GATEWAY_DATABASE_URL).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("refuses an unknown role, a missing key or a foreign host, naming keys and never values", () => {
    expect(() => stagingEnvironment("owner", FILE, PARENT)).toThrow(/--as/);
    expect(() =>
      stagingEnvironment(
        "gateway",
        { ...FILE, OPS_GATEWAY_PASSWORD: "" },
        PARENT,
      ),
    ).toThrow(/^OPS_GATEWAY_PASSWORD is missing/);
    expect(() =>
      stagingEnvironment(
        "worker",
        { ...FILE, STAGING_POOLER_HOST: "db.example.org" },
        PARENT,
      ),
    ).toThrow(/pooler host/);
    try {
      stagingEnvironment("worker", { ...FILE, STAGING_ROOT_CA: "" }, PARENT);
    } catch (error) {
      expect(error.message).not.toContain("secret");
    }
  });
});
