// @vitest-environment node
//
// The Meta transport, against a fake fetch: the request it builds, and the
// honest account it gives of every way a POST can end. At most one call, never a
// retry, and nothing sensitive in an outcome. Every value is synthetic.
import { describe, expect, it } from "vitest";
import type { OutboundRequest } from "../types.ts";
import { META_GRAPH_API_VERSION } from "./metaApi.ts";
import { createMetaWhatsAppTransport, type FetchLike } from "./metaSender.ts";

const TOKEN = "unit-test-access-token-SENTINEL";
const BODY = "Oi! A primeira consulta dura 50 minutos. SENTINEL-TEXT";

const REQUEST: OutboundRequest = Object.freeze({
  providerTarget: "200000000000001",
  to: "5511900000001",
  body: BODY,
  correlation: "0b8f5a1e-0000-4000-8000-000000000001",
});

interface Recorded {
  calls: { url: string; init: Parameters<FetchLike>[1] }[];
}

const fakeFetch = (
  answer: (recorded: Recorded) => Promise<Response>,
): { fetch: FetchLike; recorded: Recorded } => {
  const recorded: Recorded = { calls: [] };
  return {
    recorded,
    fetch: async (url, init) => {
      recorded.calls.push({ url, init });
      return answer(recorded);
    },
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const transportWith = (fetch: FetchLike) =>
  createMetaWhatsAppTransport({ accessToken: TOKEN, fetch, timeoutMs: 1000 });

describe("the request", () => {
  it("is one POST to the pinned version's messages endpoint, with the correlation", async () => {
    const { fetch, recorded } = fakeFetch(async () =>
      json(200, {
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.OUT0001" }],
      }),
    );
    await transportWith(fetch).send(REQUEST);

    expect(recorded.calls).toHaveLength(1);
    const [{ url, init }] = recorded.calls;
    expect(url).toBe(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/200000000000001/messages`,
    );
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+5511900000001",
      type: "text",
      text: { preview_url: false, body: BODY },
      biz_opaque_callback_data: REQUEST.correlation,
    });
  });

  it("is never made for a request the provider could only refuse", async () => {
    const { fetch, recorded } = fakeFetch(async () => json(200, {}));
    const transport = transportWith(fetch);
    for (const bad of [
      { ...REQUEST, to: "+5511900000001" },
      { ...REQUEST, providerTarget: "abc" },
      { ...REQUEST, body: "   " },
      { ...REQUEST, body: "x".repeat(4097) },
    ]) {
      expect(await transport.send(bad)).toEqual({
        kind: "rejected",
        errorCode: null,
        errorClass: "invalid_request",
      });
    }
    expect(recorded.calls).toHaveLength(0);
  });
});

describe("the outcome of the one call", () => {
  const cases: [string, () => Promise<Response>, unknown][] = [
    [
      "a 2xx with a message id is accepted",
      async () => json(200, { messages: [{ id: "wamid.OUT0001" }] }),
      { kind: "accepted", providerMessageId: "wamid.OUT0001" },
    ],
    [
      "a 4xx with Meta's error body is a definitive rejection, classified by code",
      async () =>
        json(400, {
          error: {
            message: `Re-engagement message ${BODY}`,
            type: "OAuthException",
            code: 131047,
            fbtrace_id: "x",
          },
        }),
      {
        kind: "rejected",
        errorCode: "131047",
        errorClass: "service_window_closed",
      },
    ],
    [
      "an expired token is rejected, never ambiguous",
      async () =>
        json(401, {
          error: { code: 190, message: "Error validating access token" },
        }),
      {
        kind: "rejected",
        errorCode: "190",
        errorClass: "access_token_invalid",
      },
    ],
    [
      "a 429 without a body is a rate-limit rejection",
      async () => new Response("", { status: 429 }),
      { kind: "rejected", errorCode: null, errorClass: "rate_limited" },
    ],
    [
      "a 5xx is ambiguous: Meta may have taken the message",
      async () =>
        json(500, { error: { code: 131000, message: "Something went wrong" } }),
      { kind: "ambiguous", errorClass: "provider_5xx" },
    ],
    [
      "a 4xx carrying Meta's generic 'something went wrong' code is ambiguous, never failed",
      async () =>
        json(400, { error: { code: 131000, message: "Something went wrong" } }),
      { kind: "ambiguous", errorClass: "provider_unknown_error" },
    ],
    [
      "a 408 is ambiguous",
      async () => new Response("", { status: 408 }),
      { kind: "ambiguous", errorClass: "unexpected_status" },
    ],
    [
      "a 2xx without a message id is ambiguous",
      async () => json(200, { messaging_product: "whatsapp" }),
      { kind: "ambiguous", errorClass: "malformed_success" },
    ],
    [
      "an oversize 2xx is ambiguous",
      async () => new Response("x".repeat(70 * 1024), { status: 200 }),
      { kind: "ambiguous", errorClass: "response_too_large" },
    ],
    [
      "a timeout is ambiguous",
      async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
      { kind: "ambiguous", errorClass: "timeout" },
    ],
    [
      "a network error or a refused redirect is ambiguous",
      async () => {
        throw new TypeError("fetch failed");
      },
      { kind: "ambiguous", errorClass: "network_error" },
    ],
  ];

  it.each(cases)("%s", async (_name, answer, expected) => {
    const { fetch, recorded } = fakeFetch(answer);
    const outcome = await transportWith(fetch).send(REQUEST);
    expect(outcome).toEqual(expected);
    // Exactly one call, whatever happened: no retry of any kind.
    expect(recorded.calls).toHaveLength(1);
    // An outcome carries a code and a class: never the token, the text or the recipient.
    const text = JSON.stringify(outcome);
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("5511900000001");
  });
});

describe("construction", () => {
  it("refuses to exist without an access token or with an unbounded timeout", () => {
    expect(() => createMetaWhatsAppTransport({ accessToken: "" })).toThrow(
      /access token/,
    );
    expect(() =>
      createMetaWhatsAppTransport({ accessToken: TOKEN, timeoutMs: 0 }),
    ).toThrow(/timeout/);
  });
});
