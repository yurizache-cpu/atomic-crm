// BASELINE Q8 minimisation (ADR 0020 §D8): deterministic removal of STRUCTURED
// identifiers from free text before a capability's input builder sends it.
//
// THIS IS NOT ANONYMISATION. It removes only what a fixed pattern recognises:
// e-mail addresses, URLs, CPF-shaped numbers and phone-shaped digit runs. A
// person's name, an address, a relative's name or any identifying story stays
// in the text, because no deterministic rule can find them and a model that
// looked for them would itself receive the text. The data keeps the class it
// had: health text with its phone numbers removed is still health, and what a
// model derives from it inherits that class.
//
// Over-redaction is preferred to leaking. Any run of 8 to 15 digits, possibly
// split by spaces, dots, dashes or parentheses and led by a plus, is removed as
// a phone number, so an order number or an ISO date-time goes with it; a bare
// date (2026-10-02, 02.10.2026, 02-10-2026) is kept. An unformatted 11-digit
// CPF is removed as a phone number; the marker differs, the removal does not.

export const REDACTION_MARKERS = Object.freeze({
  url: "[url]",
  email: "[email]",
  cpf: "[cpf]",
  phone: "[phone]",
});

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu;
const CPF = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/gu;
const PHONE = /(?<![\w+])\+?\(?\d(?:[\s().-]{0,2}\d){7,14}\)?(?!\w)/gu;
const BARE_DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{2}[.-]\d{2}[.-]\d{4})$/u;

/** The text with every structured identifier replaced by its marker, in a fixed order. */
export function redactStructuredIdentifiers(text: string): string {
  return text
    .replace(URL, REDACTION_MARKERS.url)
    .replace(EMAIL, REDACTION_MARKERS.email)
    .replace(CPF, REDACTION_MARKERS.cpf)
    .replace(PHONE, (match) =>
      BARE_DATE.test(match) ? match : REDACTION_MARKERS.phone,
    );
}

export const redactNullable = (text: string | null): string | null =>
  text === null ? null : redactStructuredIdentifiers(text);
