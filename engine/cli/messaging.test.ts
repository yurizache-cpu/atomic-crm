// @vitest-environment node
//
// What the messaging tool accepts and refuses before it reaches a database or
// the provider, and what it never prints. Sending itself is proven against a
// real database in engine/domain/whatsappOutbound.dbtest.ts.
import { describe, expect, it } from "vitest";
import type { WorkerDatabase } from "../db/types.ts";
import type { OutboundTransport } from "../communication/types.ts";
import { parseMessagingArgs, runMessagingCli } from "./messaging.ts";

const TENANT = "00000000-0000-4000-8000-00000000000a";
const REVIEW = "00000000-0000-4000-8000-00000000000b";
const ADMIN = "postgres://postgres:SENTINEL-DB-PW@127.0.0.1:54342/postgres";
const TOKEN = "SENTINEL-ACCESS-TOKEN";
const SEND = [
  "send",
  "--review",
  REVIEW,
  "--tenant",
  TENANT,
  "--operator",
  "unit operator",
];

function harness(options: { readonly failWith?: unknown } = {}) {
  const out: string[] = [];
  const opened = { databases: 0, transports: 0, calls: 0 };
  const database = {
    async withTransaction() {
      throw options.failWith ?? new Error("unexpected");
    },
    async identity() {
      throw new Error("unused");
    },
    async close() {},
  } as unknown as WorkerDatabase;
  const transport: OutboundTransport = {
    provider: "meta_whatsapp",
    async send() {
      opened.calls += 1;
      return { kind: "accepted", providerMessageId: "wamid.UNIT" };
    },
  };
  return {
    out,
    opened,
    deps: (env: Record<string, string | undefined>) => ({
      env,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => out.push(line),
      openDatabase: () => {
        opened.databases += 1;
        return database;
      },
      openTransport: () => {
        opened.transports += 1;
        return transport;
      },
    }),
  };
}

describe("parsing messaging arguments", () => {
  it("offers no way to resend or retry a message", () => {
    for (const argv of [
      ["resend"],
      ["retry"],
      ["outbound", "resend"],
      ["outbound", "retry"],
    ]) {
      expect(parseMessagingArgs(argv).kind).toBe("usage_error");
    }
  });

  it("requires the review, the tenant and the operator to send", () => {
    expect(parseMessagingArgs(SEND).kind).toBe("send");
    for (const flag of ["--review", "--tenant", "--operator"]) {
      const at = SEND.indexOf(flag);
      const argv = [...SEND.slice(0, at), ...SEND.slice(at + 2)];
      expect(parseMessagingArgs(argv).kind, flag).toBe("usage_error");
    }
  });

  it("refuses a channel mode other than test or production", () => {
    const argv = [
      "channels",
      "set",
      "--tenant",
      TENANT,
      "--company",
      TENANT,
      "--agent",
      TENANT,
      "--target",
      "200000000000001",
      "--label",
      "x",
      "--actor",
      "unit",
      "--mode",
    ];
    expect(parseMessagingArgs([...argv, "test"]).kind).toBe("channels set");
    expect(parseMessagingArgs([...argv, "live"])).toEqual({
      kind: "usage_error",
      message: "--mode must be test or production",
    });
  });
});

describe("running the messaging tool", () => {
  it("refuses to send without an access token, before opening a database or a transport", async () => {
    const { out, opened, deps } = harness();
    const code = await runMessagingCli(
      SEND,
      deps({ ADMIN_DATABASE_URL: ADMIN }),
    );
    expect(code).toBe(2);
    expect(opened).toEqual({ databases: 0, transports: 0, calls: 0 });
    expect(out.join("\n")).toMatch(/WHATSAPP_ACCESS_TOKEN is required to send/);
  });

  it("prints neither the access token nor the database password when the database refuses", async () => {
    const refusal = Object.assign(
      new Error(`password authentication failed ${ADMIN}`),
      {
        code: "28P01",
      },
    );
    const { out, opened, deps } = harness({ failWith: refusal });
    const code = await runMessagingCli(
      SEND,
      deps({ ADMIN_DATABASE_URL: ADMIN, WHATSAPP_ACCESS_TOKEN: TOKEN }),
    );
    expect(code).toBe(1);
    expect(opened.calls).toBe(0);
    expect(out.join("\n")).not.toMatch(/SENTINEL/);
  });
});
