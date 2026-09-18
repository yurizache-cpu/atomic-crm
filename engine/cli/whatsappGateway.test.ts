// @vitest-environment node
//
// The gateway process over a real loopback socket, with a fake store: the body
// bound, the signature header as Node delivers it, and a start that names a
// missing variable but never prints a value. The database half is proven in
// engine/domain/whatsappInbound.dbtest.ts. Every value is synthetic.
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GatewayConfig,
  GatewayStore,
} from "../communication/whatsapp/webhookGateway.ts";
import {
  createGatewayServer,
  startWhatsAppGateway,
} from "./whatsappGateway.ts";

const CONFIG: GatewayConfig = Object.freeze({
  appSecret: "unit-server-secret-SENTINEL",
  verifyToken: "unit-server-verify",
  path: "/webhooks/whatsapp",
});

const payload = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "100000000000001",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550000001",
              phone_number_id: "200000000000001",
            },
            messages: [
              {
                from: "5511900000009",
                id: "wamid.SERVER0001",
                timestamp: "1789732800",
                type: "text",
                text: { body: "Synthetic SENTINEL-BODY" },
              },
            ],
          },
        },
      ],
    },
  ],
});

const sign = (body: string) =>
  `sha256=${createHmac("sha256", CONFIG.appSecret).update(body).digest("hex")}`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function serve(maxBodyBytes?: number) {
  const calls: string[] = [];
  const logs: string[] = [];
  const store: GatewayStore = {
    async receiveMessage(message) {
      calls.push(message.externalMessageId);
      return "admitted";
    },
    async receiveStatus() {
      calls.push("status");
      return "updated";
    },
  };
  const server = createGatewayServer({
    config: CONFIG,
    store,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    maxBodyBytes,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${CONFIG.path}`, calls, logs };
}

describe("the gateway server", () => {
  it("admits a signed delivery through the real socket and header", async () => {
    const { url, calls } = await serve();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual(["wamid.SERVER0001"]);
  });

  it("answers 413 past the body bound and hands nothing to the store", async () => {
    const { url, calls, logs } = await serve(256);
    const oversize = payload.padEnd(4096, " ");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sign(oversize),
      },
      body: oversize,
    });
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
    expect(logs).toEqual([
      JSON.stringify({ event: "gateway.rejected", reason: "too_large" }),
    ]);
  });

  it("answers 401 to an unsigned delivery over the socket", async () => {
    const { url, calls } = await serve();
    const response = await fetch(url, { method: "POST", body: payload });
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("starting the gateway", () => {
  it("names the missing variable and never prints a value it was given", async () => {
    const env = {
      OPS_GATEWAY_DATABASE_URL:
        "postgres://ops_gateway_login:SENTINEL-PW@127.0.0.1:1/postgres",
      WHATSAPP_APP_SECRET: "SENTINEL-APP-SECRET",
    };
    const error = await startWhatsAppGateway(env, () => {}).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("WHATSAPP_VERIFY_TOKEN is required");
    expect((error as Error).message).not.toMatch(/SENTINEL/);
  });

  it("refuses a port that is not one before connecting anywhere", async () => {
    const error = await startWhatsAppGateway(
      {
        OPS_GATEWAY_DATABASE_URL: "postgres://x:y@127.0.0.1:1/postgres",
        WHATSAPP_APP_SECRET: "s",
        WHATSAPP_VERIFY_TOKEN: "t",
        WHATSAPP_GATEWAY_PORT: "80a",
      },
      () => {},
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      "WHATSAPP_GATEWAY_PORT is not a port",
    );
  });
});
