// @vitest-environment node
//
// The Meta webhook boundary: the subscription handshake, the signature over the
// raw bytes, and a parser that reads only what it can read. Payload shapes follow
// Meta's official webhook reference (docs/PHASE_2B_REPORT.md §3). Every value is
// synthetic, and no real secret appears anywhere.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  answerSubscription,
  isAuthenticWebhook,
  parseWebhook,
  WebhookPayloadError,
} from "./metaWebhook.ts";

const APP_SECRET = "unit-test-app-secret";
const sign = (body: string, secret = APP_SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
const bytes = (body: string): Uint8Array => Buffer.from(body, "utf8");

const NOW = Date.parse("2026-09-18T12:00:00Z");

/** One official-shape notification: one text message from 5511900000001. */
const textPayload = (overrides: Record<string, unknown> = {}) => ({
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
            contacts: [
              { profile: { name: "Synthetic Lead" }, wa_id: "5511900000001" },
            ],
            messages: [
              {
                from: "5511900000001",
                id: "wamid.SYNTHETIC0001",
                timestamp: "1789732800",
                type: "text",
                text: {
                  body: "Oi, gostaria de saber como funciona a primeira consulta.",
                },
                ...overrides,
              },
            ],
          },
        },
      ],
    },
  ],
});

describe("the subscription handshake", () => {
  it("answers the challenge only for subscribe with the configured token", () => {
    expect(
      answerSubscription(
        {
          mode: "subscribe",
          verifyToken: "verify-me",
          challenge: "1158201444",
        },
        "verify-me",
      ),
    ).toEqual({ ok: true, challenge: "1158201444" });
  });

  it("refuses a wrong token, a wrong mode, a missing challenge and an unset token", () => {
    const good = {
      mode: "subscribe",
      verifyToken: "verify-me",
      challenge: "42",
    };
    expect(
      answerSubscription({ ...good, verifyToken: "verify-mf" }, "verify-me").ok,
    ).toBe(false);
    expect(
      answerSubscription({ ...good, verifyToken: "short" }, "verify-me").ok,
    ).toBe(false);
    expect(
      answerSubscription({ ...good, mode: "unsubscribe" }, "verify-me").ok,
    ).toBe(false);
    expect(
      answerSubscription({ ...good, challenge: null }, "verify-me").ok,
    ).toBe(false);
    expect(
      answerSubscription({ ...good, challenge: "a b" }, "verify-me").ok,
    ).toBe(false);
    expect(answerSubscription(good, "").ok).toBe(false);
  });
});

describe("event authenticity", () => {
  const body = JSON.stringify(textPayload());

  it("accepts the HMAC-SHA256 of the raw body under the app secret", () => {
    expect(isAuthenticWebhook(bytes(body), sign(body), APP_SECRET)).toBe(true);
    // Hex case does not matter to the digest.
    expect(
      isAuthenticWebhook(
        bytes(body),
        sign(body).toUpperCase().replace("SHA256=", "sha256="),
        APP_SECRET,
      ),
    ).toBe(true);
  });

  it("refuses another secret, a changed body, and any malformed header", () => {
    expect(
      isAuthenticWebhook(bytes(body), sign(body, "another-secret"), APP_SECRET),
    ).toBe(false);
    expect(isAuthenticWebhook(bytes(`${body} `), sign(body), APP_SECRET)).toBe(
      false,
    );
    expect(isAuthenticWebhook(bytes(body), undefined, APP_SECRET)).toBe(false);
    expect(isAuthenticWebhook(bytes(body), "sha1=abc", APP_SECRET)).toBe(false);
    expect(
      isAuthenticWebhook(bytes(body), `sha256=${"0".repeat(63)}`, APP_SECRET),
    ).toBe(false);
    expect(isAuthenticWebhook(bytes(body), sign(body), "")).toBe(false);
  });

  it("signs the bytes, so a re-serialised body with the same meaning does not verify", () => {
    const pretty = JSON.stringify(textPayload(), null, 2);
    expect(isAuthenticWebhook(bytes(pretty), sign(body), APP_SECRET)).toBe(
      false,
    );
  });
});

describe("parsing an authenticated notification", () => {
  it("reads one text message with its target, id, sender, body and time", () => {
    const parsed = parseWebhook(textPayload(), NOW);
    expect(parsed.ignored).toBe(0);
    expect(parsed.statuses).toEqual([]);
    expect(parsed.messages).toEqual([
      {
        providerTarget: "200000000000001",
        externalMessageId: "wamid.SYNTHETIC0001",
        from: "5511900000001",
        body: "Oi, gostaria de saber como funciona a primeira consulta.",
        receivedAt: new Date(1789732800 * 1000),
      },
    ]);
  });

  it("never dates a message later than now", () => {
    const parsed = parseWebhook(textPayload({ timestamp: "9999999999" }), NOW);
    expect(parsed.messages[0].receivedAt).toEqual(new Date(NOW));
  });

  it("hands on every message Meta names, marking what is not text or has no sender number", () => {
    // Nothing a sender wrote is acknowledged in silence: the database admits it
    // or records a content-free refusal (ops.receive_whatsapp_message).
    const cases: [
      Record<string, unknown>,
      { from: string | null; body: string | null },
    ][] = [
      [
        { type: "image", text: undefined, image: { id: "media-1" } },
        { from: "5511900000001", body: null },
      ],
      [
        {
          type: "audio",
          text: undefined,
          audio: { id: "voice-1", voice: true },
        },
        { from: "5511900000001", body: null },
      ],
      [
        { from: undefined, from_user_id: "BR.bsuid.1" },
        {
          from: null,
          body: "Oi, gostaria de saber como funciona a primeira consulta.",
        },
      ],
      [
        { from: "not-digits" },
        {
          from: null,
          body: "Oi, gostaria de saber como funciona a primeira consulta.",
        },
      ],
      [{ text: { body: "   " } }, { from: "5511900000001", body: "   " }],
      [
        { text: { body: `before${String.fromCharCode(0)}after` } },
        { from: "5511900000001", body: null },
      ],
    ];
    for (const [overrides, expected] of cases) {
      const parsed = parseWebhook(textPayload(overrides), NOW);
      expect(parsed.ignored).toBe(0);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0]).toMatchObject({
        externalMessageId: "wamid.SYNTHETIC0001",
        ...expected,
      });
    }
  });

  it("does not bound a body's length: the database decides, in characters", () => {
    const long = "a".repeat(5000);
    const parsed = parseWebhook(textPayload({ text: { body: long } }), NOW);
    expect(parsed.messages[0].body).toBe(long);
  });

  it("dates a message with no readable timestamp now, and ignores only one with no usable id", () => {
    expect(
      parseWebhook(textPayload({ timestamp: "soon" }), NOW).messages[0]
        .receivedAt,
    ).toEqual(new Date(NOW));
    const parsed = parseWebhook(textPayload({ id: undefined }), NOW);
    expect(parsed.messages).toEqual([]);
    expect(parsed.ignored).toBe(1);
  });

  it("reads statuses with the correlation this system sent and the first error code", () => {
    const parsed = parseWebhook(
      {
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
                  statuses: [
                    {
                      id: "wamid.OUT0001",
                      status: "failed",
                      timestamp: "1789732700",
                      recipient_id: "5511900000001",
                      biz_opaque_callback_data:
                        "0b8f5a1e-0000-4000-8000-000000000001",
                      errors: [
                        { code: 131026, title: "Message undeliverable" },
                      ],
                    },
                    {
                      id: "wamid.OUT0002",
                      status: "played",
                      timestamp: "1789732701",
                      recipient_id: "5511900000001",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      NOW,
    );
    expect(parsed.messages).toEqual([]);
    expect(parsed.statuses).toEqual([
      {
        providerTarget: "200000000000001",
        providerMessageId: "wamid.OUT0001",
        status: "failed",
        statusAt: new Date(1789732700 * 1000),
        recipient: "5511900000001",
        correlation: "0b8f5a1e-0000-4000-8000-000000000001",
        errorCode: "131026",
      },
      {
        providerTarget: "200000000000001",
        providerMessageId: "wamid.OUT0002",
        status: "played",
        statusAt: new Date(1789732701 * 1000),
        recipient: "5511900000001",
        correlation: null,
        errorCode: null,
      },
    ]);
  });

  it("refuses an envelope that is not a WhatsApp Business Account notification", () => {
    expect(() => parseWebhook({ object: "page", entry: [] }, NOW)).toThrow(
      WebhookPayloadError,
    );
    expect(() => parseWebhook([], NOW)).toThrow(WebhookPayloadError);
  });

  it("ignores another field's change instead of reading it as messages", () => {
    const payload = textPayload();
    payload.entry[0].changes[0].field = "account_update";
    expect(parseWebhook(payload, NOW)).toMatchObject({
      messages: [],
      ignored: 1,
    });
  });
});
