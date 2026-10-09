// What an owner hands a command, read so that it never leaks back out
// (ADR 0026 §D, SI-86):
//
//   * a file the owner names (a number, a text, a JSON document), decoded as
//     UTF-8 or as the UTF-16 Windows PowerShell 5.1 writes by default (`>`),
//     and refused with a fixed message, never its content, when it is neither;
//   * a usage message, which never repeats a run of six digits or more that
//     someone typed by mistake where a flag was expected.

import { readFileSync } from "node:fs";

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** A usage message never repeats a number someone typed by mistake (SI-86). */
export const withholdDigits = (text: string): string =>
  text.replace(/[0-9]{6,}/gu, "<digits withheld>");

/** A file's bytes as text: UTF-16 with its byte-order mark, or UTF-8. */
export function decodeOwnerText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if (buffer.length % 2 !== 0) {
      throw new Error("the file must be UTF-8 or UTF-16 text");
    }
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    if (buffer.length % 2 !== 0) {
      throw new Error("the file must be UTF-8 or UTF-16 text");
    }
    return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  }
  const text = buffer.toString("utf8");
  const stripped = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  if (stripped.includes(NUL) || stripped.includes(REPLACEMENT)) {
    throw new Error("the file must be UTF-8 or UTF-16 text");
  }
  return stripped;
}

/** Reads a file the owner names; its content is never echoed. */
export const readOwnerTextFile = (path: string): string =>
  decodeOwnerText(readFileSync(path));
