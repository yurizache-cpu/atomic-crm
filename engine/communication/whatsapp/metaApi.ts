// The Meta WhatsApp Cloud API facts this adapter depends on, in one place.
//
// VERIFIED 2026-09-18 against Meta's OFFICIAL developer documentation only
// (docs/PHASE_2B_REPORT.md §3 lists every page and what it said):
//
//   * Graph API changelog / versioning: the latest version is v26.0
//     (2026-07-29); v25.0 is supported until 2028-07-29.
//   * WhatsApp Message API reference: documents v23.0, v24.0 and v25.0, and
//     its send examples and OpenAPI spec use v25.0.
//
// PINNED TO v25.0: the newest version the WhatsApp reference itself documents,
// with the longest remaining support. The version is an adapter concern: no
// Company Engine semantics depend on it.
//
// UPGRADE STRATEGY. Read the Graph API changelog and the WhatsApp changelog,
// change META_GRAPH_API_VERSION in a reviewed commit, re-run the adapter's unit
// tests (engine/communication/whatsapp/*.test.ts) and, when test credentials
// exist, the live test-number probe. Never a runtime override: a version an
// environment variable could change would be a version nobody reviewed.

export const META_GRAPH_API_VERSION = "v25.0";
export const META_GRAPH_API_VERSION_VERIFIED_ON = "2026-09-18";
export const META_GRAPH_ORIGIN = "https://graph.facebook.com";

/** The provider name ops.communication_channels records for this adapter. */
export const META_WHATSAPP_PROVIDER = "meta_whatsapp" as const;

/** "Maximum 4096 characters" for a text message body (Meta, text messages). */
export const WHATSAPP_TEXT_MAX_LENGTH = 4096;

/**
 * biz_opaque_callback_data: 512 characters since 2024-01-26 (WhatsApp
 * changelog). Echoed in status webhooks only when set on the send.
 */
export const BIZ_OPAQUE_CALLBACK_DATA_MAX_LENGTH = 512;

/**
 * Webhook payloads "can be up to 3 MB" (Meta, webhooks overview). The gateway
 * reads a little more than that before refusing, so a legitimate batch is never
 * cut off.
 */
export const WEBHOOK_MAX_BODY_BYTES = 3 * 1024 * 1024 + 256 * 1024;

/** Status values the webhook reference documents. */
export const WHATSAPP_STATUS_VALUES = Object.freeze([
  "sent",
  "delivered",
  "read",
  "failed",
  "played",
] as const);
