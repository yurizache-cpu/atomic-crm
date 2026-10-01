import { describe, expect, it } from "vitest";
import type { WorkerDatabase } from "../db/types.ts";
import { EXIT_REFUSED, EXIT_USAGE } from "./cliOutput.ts";
import { runStagingFakeWorker } from "./stagingFakeWorker.ts";

// The canned provider must never answer outside staging, and the tool must
// never reach for a database before it knows where it is.
const STAGING_URL =
  "postgresql://ops_worker_login.ref:secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";

const attempt = async (env: Record<string, string | undefined>) => {
  const errors: string[] = [];
  let opened = false;
  const status = await runStagingFakeWorker({
    env,
    stdout: () => {},
    stderr: (line) => errors.push(line),
    openDatabase: () => {
      opened = true;
      return {} as WorkerDatabase;
    },
  });
  return { status, errors: errors.join("\n"), opened };
};

describe("the staging fake worker", () => {
  it.each([undefined, "", "local", "production"])(
    "refuses DEPLOYMENT_ENVIRONMENT=%j without opening a database",
    async (value) => {
      const result = await attempt({
        DEPLOYMENT_ENVIRONMENT: value,
        OPS_WORKER_DATABASE_URL: STAGING_URL,
      });
      expect(result.status).toBe(EXIT_REFUSED);
      expect(result.opened).toBe(false);
      expect(result.errors).toMatch(/must be staging/);
      expect(result.errors).not.toContain("secret");
    },
  );

  it("refuses a misspelt environment and a missing worker URL", async () => {
    const misspelt = await attempt({ DEPLOYMENT_ENVIRONMENT: "stagin" });
    expect(misspelt.status).toBe(EXIT_USAGE);
    expect(misspelt.opened).toBe(false);

    const missing = await attempt({ DEPLOYMENT_ENVIRONMENT: "staging" });
    expect(missing.status).toBe(EXIT_USAGE);
    expect(missing.errors).toMatch(/OPS_WORKER_DATABASE_URL/);
    expect(missing.opened).toBe(false);
  });

  it("refuses a local database in staging before opening it", async () => {
    const local = await attempt({
      DEPLOYMENT_ENVIRONMENT: "staging",
      OPS_WORKER_DATABASE_URL:
        "postgresql://ops_worker_login:secret@127.0.0.1:54342/postgres",
    });
    expect(local.status).toBe(EXIT_USAGE);
    expect(local.opened).toBe(false);
    expect(local.errors).not.toContain("secret");
  });
});
