// @vitest-environment node
//
// The worker's reply transport from its environment (ADR 0026 §B): none unless
// one is named, a fake only on a developer's machine, Meta only with a token,
// and a misspelt value refused rather than read as none. Every value is
// synthetic.
import { describe, expect, it } from "vitest";
import { UNCONFIGURED_REPLY_TRANSPORT } from "../replyTransport.ts";
import { DEFAULT_SEND_TIMEOUT_MS, type FetchLike } from "./metaSender.ts";
import { replyTransportFromEnv } from "./replyTransportFromEnv.ts";

const TOKEN = "unit-test-access-token-SENTINEL";

describe("the reply transport a worker starts with", () => {
  it("is none when REPLY_TRANSPORT is unset or empty", () => {
    expect(replyTransportFromEnv({}, "production")).toBe(
      UNCONFIGURED_REPLY_TRANSPORT,
    );
    expect(replyTransportFromEnv({ REPLY_TRANSPORT: "" }, "staging")).toBe(
      UNCONFIGURED_REPLY_TRANSPORT,
    );
  });

  it("is the fake only on a developer's machine", () => {
    const local = replyTransportFromEnv({ REPLY_TRANSPORT: "fake" }, "local");
    expect(local.kind).toBe("fake");
    // ADR 0026 §D: the owner's notifications ride the same transport.
    expect(local.templates).toBe(local.transport);
    expect(local.timeoutMs).toBe(DEFAULT_SEND_TIMEOUT_MS);
    for (const environment of ["staging", "production"] as const) {
      expect(() =>
        replyTransportFromEnv({ REPLY_TRANSPORT: "fake" }, environment),
      ).toThrow(/only a local environment allows/);
    }
  });

  it("is Meta only with a token, and sends through it once", async () => {
    expect(() =>
      replyTransportFromEnv({ REPLY_TRANSPORT: "meta" }, "staging"),
    ).toThrow(/WHATSAPP_ACCESS_TOKEN is not set/);
    expect(() =>
      replyTransportFromEnv(
        { REPLY_TRANSPORT: "meta", WHATSAPP_ACCESS_TOKEN: "   " },
        "staging",
      ),
    ).toThrow(/WHATSAPP_ACCESS_TOKEN is not set/);

    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ messages: [{ id: "wamid.OUT1" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    const meta = replyTransportFromEnv(
      {
        REPLY_TRANSPORT: "meta",
        WHATSAPP_ACCESS_TOKEN: TOKEN,
        REPLY_TRANSPORT_TIMEOUT_MS: "2500",
      },
      "staging",
      { fetch },
    );
    expect(meta.kind).toBe("meta");
    expect(meta.timeoutMs).toBe(2500);
    expect(meta.templates).toBe(meta.transport);
    expect(UNCONFIGURED_REPLY_TRANSPORT.templates).toBeNull();
    expect(
      await meta.transport?.send({
        providerTarget: "200000000000001",
        to: "5511900000001",
        body: "Texto fixo fictício.",
        correlation: "0b8f5a1e-0000-4000-8000-000000000001",
      }),
    ).toEqual({ kind: "accepted", providerMessageId: "wamid.OUT1" });
    expect(urls).toHaveLength(1);
  });

  it.each(["Meta", "whatsapp", "none", " meta"])(
    "refuses the misspelt value %j instead of starting without a transport",
    (value) => {
      expect(() =>
        replyTransportFromEnv(
          { REPLY_TRANSPORT: value, WHATSAPP_ACCESS_TOKEN: TOKEN },
          "local",
        ),
      ).toThrow(/must be unset, "meta" or "fake"/);
    },
  );

  it.each(["0", "60001", "1e3", "abc", "-5"])(
    "refuses the timeout %j",
    (value) => {
      expect(() =>
        replyTransportFromEnv(
          { REPLY_TRANSPORT: "fake", REPLY_TRANSPORT_TIMEOUT_MS: value },
          "local",
        ),
      ).toThrow(/must be 1 to 60000/);
    },
  );

  it("never repeats the token in a refusal", () => {
    let message = "";
    try {
      replyTransportFromEnv(
        {
          REPLY_TRANSPORT: "meta",
          WHATSAPP_ACCESS_TOKEN: TOKEN,
          REPLY_TRANSPORT_TIMEOUT_MS: "nope",
        },
        "staging",
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must be 1 to 60000/);
    expect(message).not.toContain(TOKEN);
  });
});
