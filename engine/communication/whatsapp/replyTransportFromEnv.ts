// The worker's reply transport from its environment (ADR 0026 §B), read once at
// start, never by a handler (SI-33):
//
//   REPLY_TRANSPORT             unset: none (policy sends wait, then are
//                               blocked for a person); "meta"; or "fake",
//                               which only DEPLOYMENT_ENVIRONMENT=local allows.
//   WHATSAPP_ACCESS_TOKEN       required by "meta". On staging, only a token
//                               whose system user holds the test WhatsApp
//                               Business Account alone.
//   REPLY_TRANSPORT_TIMEOUT_MS  optional, 1 to 60000 (default 15000).
//
// A misspelt value is refused, never read as none.

import type { DeploymentEnvironment } from "../../runtime/deploymentEnvironment.ts";
import {
  createFakeOutboundTransport,
  UNCONFIGURED_REPLY_TRANSPORT,
  type ReplyTransport,
} from "../replyTransport.ts";
import type { FetchLike } from "./metaSender.ts";
import {
  createMetaWhatsAppTransport,
  DEFAULT_SEND_TIMEOUT_MS,
} from "./metaSender.ts";

type Env = Readonly<Record<string, string | undefined>>;

export function replyTransportFromEnv(
  env: Env,
  environment: DeploymentEnvironment,
  options: { readonly fetch?: FetchLike } = {},
): ReplyTransport {
  const kind = env.REPLY_TRANSPORT;
  if (kind === undefined || kind === "") return UNCONFIGURED_REPLY_TRANSPORT;
  const rawTimeout = env.REPLY_TRANSPORT_TIMEOUT_MS;
  const timeoutMs =
    rawTimeout === undefined || rawTimeout === ""
      ? DEFAULT_SEND_TIMEOUT_MS
      : /^[0-9]{1,5}$/.test(rawTimeout)
        ? Number(rawTimeout)
        : Number.NaN;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error(
      "REPLY_TRANSPORT_TIMEOUT_MS must be 1 to 60000; refusing to start",
    );
  }
  if (kind === "fake") {
    if (environment !== "local") {
      throw new Error(
        'REPLY_TRANSPORT is "fake", which only a local environment allows; refusing to start',
      );
    }
    return Object.freeze({
      kind: "fake",
      transport: createFakeOutboundTransport(),
      timeoutMs,
    });
  }
  if (kind === "meta") {
    const accessToken = env.WHATSAPP_ACCESS_TOKEN;
    if (accessToken === undefined || accessToken.trim() === "") {
      throw new Error(
        'REPLY_TRANSPORT is "meta" but WHATSAPP_ACCESS_TOKEN is not set; refusing to start',
      );
    }
    return Object.freeze({
      kind: "meta",
      transport: createMetaWhatsAppTransport({
        accessToken,
        timeoutMs,
        fetch: options.fetch,
      }),
      timeoutMs,
    });
  }
  throw new Error(
    'REPLY_TRANSPORT must be unset, "meta" or "fake"; refusing to start',
  );
}
