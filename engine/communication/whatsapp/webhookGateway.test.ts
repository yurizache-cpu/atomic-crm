// @vitest-environment node
//
// The gateway's request handling with a fake store: authenticity before
// anything else, what Meta is answered, and logs that carry no content. The
// database half is proven in engine/domain/whatsappInbound.dbtest.ts.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  WhatsAppInboundMessage,
  WhatsAppStatusUpdate,
} from "./metaWebhook.ts";
import {
  handleWebhookRequest,
  PermanentStoreError,
  type GatewayConfig,
  type GatewayStore,
} from "./webhookGateway.ts";

const CONFIG: GatewayConfig = Object.freeze({
  appSecret: "unit-gateway-secret-SENTINEL",
  verifyToken: "unit-verify-token",
  path: "/webhooks/whatsapp",
});

const BODY_TEXT = "Synthetic enquiry SENTINEL-BODY";
const SENDER = "5511900000009";

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
                from: SENDER,
                id: "wamid.IN0001",
                timestamp: "1789732800",
                type: "text",
                text: { body: BODY_TEXT },
              },
            ],
            statuses: [
              {
                id: "wamid.OUT0001",
                status: "delivered",
                timestamp: "1789732801",
                recipient_id: SENDER,
              },
            ],
          },
        },
      ],
    },
  ],
});

const signed = (body: string, secret = CONFIG.appSecret) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const post = (body: string, signature: string | undefined) => ({
  method: "POST",
  url: "/webhooks/whatsapp",
  signature,
  body: Buffer.from(body, "utf8"),
});

const recordingStore = (
  behaviour: {
    message?: () => Promise<"admitted">;
    status?: () => Promise<"updated">;
  } = {},
) => {
  const seen: {
    messages: WhatsAppInboundMessage[];
    statuses: WhatsAppStatusUpdate[];
  } = {
    messages: [],
    statuses: [],
  };
  const store: GatewayStore = {
    async receiveMessage(message) {
      seen.messages.push(message);
      return behaviour.message ? behaviour.message() : "admitted";
    },
    async receiveStatus(status) {
      seen.statuses.push(status);
      return behaviour.status ? behaviour.status() : "updated";
    },
  };
  return { store, seen };
};

const recordingLog = () => {
  const lines: string[] = [];
  return {
    lines,
    log: (event: string, fields: Readonly<Record<string, string | number>>) => {
      lines.push(JSON.stringify({ event, ...fields }));
    },
  };
};

describe("the subscription handshake", () => {
  it("answers the challenge with 200, and anything else with 403", async () => {
    const { store } = recordingStore();
    const { log } = recordingLog();
    const ok = await handleWebhookRequest(
      {
        method: "GET",
        url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=unit-verify-token&hub.challenge=1158201444",
        signature: undefined,
        body: new Uint8Array(),
      },
      CONFIG,
      store,
      log,
    );
    expect(ok).toEqual({ status: 200, body: "1158201444" });
    const refused = await handleWebhookRequest(
      {
        method: "GET",
        url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1",
        signature: undefined,
        body: new Uint8Array(),
      },
      CONFIG,
      store,
      log,
    );
    expect(refused.status).toBe(403);
  });
});

describe("an event delivery", () => {
  it("is refused with 401 and never parsed or stored without a valid signature", async () => {
    for (const signature of [
      undefined,
      signed(payload, "another-secret"),
      "sha256=00",
    ]) {
      const { store, seen } = recordingStore();
      const { log } = recordingLog();
      const answer = await handleWebhookRequest(
        post(payload, signature),
        CONFIG,
        store,
        log,
      );
      expect(answer.status).toBe(401);
      expect(seen.messages).toHaveLength(0);
      expect(seen.statuses).toHaveLength(0);
    }
  });

  it("hands each authenticated item to the store and answers 200", async () => {
    const { store, seen } = recordingStore();
    const { log } = recordingLog();
    const answer = await handleWebhookRequest(
      post(payload, signed(payload)),
      CONFIG,
      store,
      log,
    );
    expect(answer.status).toBe(200);
    expect(seen.messages.map((m) => m.externalMessageId)).toEqual([
      "wamid.IN0001",
    ]);
    expect(seen.statuses.map((s) => s.providerMessageId)).toEqual([
      "wamid.OUT0001",
    ]);
  });

  it("answers 400 for an authenticated body that is not a WhatsApp notification", async () => {
    const { store } = recordingStore();
    const { log } = recordingLog();
    const notJson = "{not json";
    expect(
      (
        await handleWebhookRequest(
          post(notJson, signed(notJson)),
          CONFIG,
          store,
          log,
        )
      ).status,
    ).toBe(400);
    const other = JSON.stringify({ object: "page", entry: [] });
    expect(
      (
        await handleWebhookRequest(
          post(other, signed(other)),
          CONFIG,
          store,
          log,
        )
      ).status,
    ).toBe(400);
  });

  it("answers 200 when the store refuses permanently, so Meta does not redeliver forever", async () => {
    const { store } = recordingStore({
      message: async () => {
        throw new PermanentStoreError("OS404");
      },
    });
    const { log } = recordingLog();
    expect(
      (
        await handleWebhookRequest(
          post(payload, signed(payload)),
          CONFIG,
          store,
          log,
        )
      ).status,
    ).toBe(200);
  });

  it("answers 500 when the store fails transiently, so Meta delivers again", async () => {
    const { store } = recordingStore({
      status: async () => {
        throw new Error("connection terminated");
      },
    });
    const { log } = recordingLog();
    expect(
      (
        await handleWebhookRequest(
          post(payload, signed(payload)),
          CONFIG,
          store,
          log,
        )
      ).status,
    ).toBe(500);
  });

  it("serves one path and two methods", async () => {
    const { store } = recordingStore();
    const { log } = recordingLog();
    expect(
      (
        await handleWebhookRequest(
          { ...post(payload, signed(payload)), url: "/other" },
          CONFIG,
          store,
          log,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleWebhookRequest(
          { ...post(payload, signed(payload)), method: "PUT" },
          CONFIG,
          store,
          log,
        )
      ).status,
    ).toBe(405);
  });
});

describe("what the gateway logs", () => {
  it("is counts and outcomes: never a body, a sender, a secret or a signature", async () => {
    const { lines, log } = recordingLog();
    const { store } = recordingStore({
      message: async () => {
        throw new Error(`insert failed for ${SENDER}: ${BODY_TEXT}`);
      },
    });
    await handleWebhookRequest(
      post(payload, signed(payload)),
      CONFIG,
      store,
      log,
    );
    await handleWebhookRequest(post(payload, "sha256=bad"), CONFIG, store, log);
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain("SENTINEL");
    expect(all).not.toContain(SENDER);
    expect(all).not.toContain(signed(payload));
  });
});
