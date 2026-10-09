// A WhatsApp profile name as a CRM first name (ADR 0026 §C).
//
// The sender chooses their profile name, so it is untrusted text. A lead the
// gateway creates takes its first word as the contact's first name only when
// it reads as a name: bounded, no control characters or formula prefix, no
// digits, address or link, and nothing the reviewed screen would omit or act
// on (a sensitive phrase, danger, a request to stop or for a person). Words the
// screen does not recognise are expected: no pack knows a name. Anything else,
// and any failure here, gives null, and the database uses the owner's
// placeholder. The name is never logged; it reaches only the CRM contact, at
// creation, and the database checks it again.

import { HEALTH_PT_BR_V4 } from "./packs/healthPtBr.ts";
import { sanitizeMessage, type SanitizerPack } from "./messageSanitizer.ts";

export const PROFILE_FIRST_NAME_MAX_LENGTH = 40;
const RAW_MAX_LENGTH = 256;

/** One word of letters, marks, apostrophes, hyphens and dots, a letter first. */
const FIRST_NAME = /^\p{L}[\p{L}\p{M}'’.-]{0,39}$/u;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const FORMULA_PREFIX = /^[=+\-@\s]+/u;
const NOT_A_NAME = /[0-9@/:\\]|www\./iu;

/**
 * The first name a lead may take from its sender's profile name, or null. The
 * newest reviewed pack screens it: the gateway cannot read the agent's
 * published policy, and the newest pack is the strictest.
 */
export function profileFirstName(
  raw: string | null | undefined,
  pack: SanitizerPack = HEALTH_PT_BR_V4,
): string | null {
  try {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      raw.length > RAW_MAX_LENGTH
    ) {
      return null;
    }
    const text = raw
      .normalize("NFC")
      .replace(CONTROL, " ")
      .trim()
      .replace(FORMULA_PREFIX, "");
    if (text === "" || NOT_A_NAME.test(text)) return null;
    const screened = sanitizeMessage(text, pack);
    if (
      screened.messageClass === "safety" ||
      screened.segmentsSensitive > 0 ||
      screened.optOutRequested ||
      screened.humanRequested
    ) {
      return null;
    }
    const first = text.split(/\s+/u)[0] ?? "";
    return FIRST_NAME.test(first) &&
      first.length <= PROFILE_FIRST_NAME_MAX_LENGTH
      ? first
      : null;
  } catch {
    return null;
  }
}
