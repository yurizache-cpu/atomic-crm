// @vitest-environment node
//
// The Meta transport's approved templates (ADR 0026 §D), against a fake fetch:
// the request it builds, the requests it refuses uncalled, and an outcome read
// exactly as a text's. At most one call, never a retry, and nothing sensitive
// in an outcome. Every value is synthetic.
import { describe, expect, it } from "vitest";
import type { OutboundTemplateRequest } from "../types.ts";
import { META_GRAPH_API_VERSION } from "./metaApi.ts";
import { createMetaWhatsAppTransport, type FetchLike } from "./metaSender.ts";

const TOKEN = "unit-test-access-token-SENTINEL";

const REQUEST: OutboundTemplateRequest = Object.freeze({
  providerTarget: "200000000000001",
  to: "5511900000977",
  templateName: "aviso_fila_conversa",
  languageCode: "pt_BR",
  bodyParameters: Object.freeze(["Maria", "14:35"]),
  correlation: "owner-notification:0b8f5a1e-0000-4000-8000-000000000001",
});

const fakeFetch = (answer: () => Response) => {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetch, calls };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const transportWith = (fetch: FetchLike) =>
  createMetaWhatsAppTransport({ accessToken: TOKEN, fetch, timeoutMs: 1000 });

describe("a template send", () => {
  it("is one POST of the named template, its language and its positional body parameters, with the correlation", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.TPL0001", message_status: "accepted" }],
      }),
    );
    const outcome = await transportWith(fetch).sendTemplate(REQUEST);

    expect(outcome).toEqual({
      kind: "accepted",
      providerMessageId: "wamid.TPL0001",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/200000000000001/messages`,
    );
    expect(calls[0].init.redirect).toBe("error");
    expect(JSON.parse(calls[0].init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+5511900000977",
      type: "template",
      template: {
        name: "aviso_fila_conversa",
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Maria" },
              { type: "text", text: "14:35" },
            ],
          },
        ],
      },
      biz_opaque_callback_data: REQUEST.correlation,
    });
  });

  it("is never made for a template, language, recipient or parameter the provider could only refuse", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const transport = transportWith(fetch);
    for (const bad of [
      { ...REQUEST, to: "+5511900000977" },
      { ...REQUEST, providerTarget: "abc" },
      { ...REQUEST, templateName: "Aviso Fila" },
      { ...REQUEST, languageCode: "portuguese" },
      { ...REQUEST, bodyParameters: [] },
      { ...REQUEST, bodyParameters: Array.from({ length: 11 }, () => "x") },
      { ...REQUEST, bodyParameters: ["Maria", " "] },
      { ...REQUEST, bodyParameters: ["Maria\nSilva", "14:35"] },
      { ...REQUEST, bodyParameters: ["Maria    Silva", "14:35"] },
      { ...REQUEST, bodyParameters: ["x".repeat(61), "14:35"] },
      { ...REQUEST, correlation: "x".repeat(513) },
    ]) {
      expect(await transport.sendTemplate(bad)).toEqual({
        kind: "rejected",
        errorCode: null,
        errorClass: "invalid_request",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("reads a refusal and an uncertain end exactly as a text's, never repeating the call", async () => {
    const refused = fakeFetch(() =>
      json(400, { error: { code: 132001, message: "SENTINEL template" } }),
    );
    expect(await transportWith(refused.fetch).sendTemplate(REQUEST)).toEqual({
      kind: "rejected",
      errorCode: "132001",
      errorClass: "provider_rejected",
    });
    const uncertain = fakeFetch(() => json(503, {}));
    expect(await transportWith(uncertain.fetch).sendTemplate(REQUEST)).toEqual({
      kind: "ambiguous",
      errorClass: "provider_5xx",
    });
    expect(refused.calls).toHaveLength(1);
    expect(uncertain.calls).toHaveLength(1);
    expect(
      JSON.stringify(await transportWith(refused.fetch).sendTemplate(REQUEST)),
    ).not.toContain("SENTINEL");
  });
});
