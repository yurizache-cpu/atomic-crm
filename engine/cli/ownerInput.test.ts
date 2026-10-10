// What an owner hands a command (ADR 0026 §D): a file decoded as UTF-8 or as
// the UTF-16 Windows PowerShell writes, refused with a fixed message when it
// is neither; and digits withheld from a usage message.

import { describe, expect, it } from "vitest";
import { decodeOwnerText, withholdDigits } from "./ownerInput.ts";

const NUMBER = "5511900000977";

const utf16le = (text: string): Uint8Array =>
  Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
const utf16be = (text: string): Uint8Array =>
  Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(text, "utf16le").swap16(),
  ]);

describe("an owner's file", () => {
  it("reads UTF-8, with or without its byte-order mark, and both UTF-16 byte orders", () => {
    expect(decodeOwnerText(Buffer.from(`${NUMBER}\n`, "utf8"))).toBe(
      `${NUMBER}\n`,
    );
    expect(
      decodeOwnerText(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NUMBER)]),
      ),
    ).toBe(NUMBER);
    expect(decodeOwnerText(utf16le(`${NUMBER}\r\n`))).toBe(`${NUMBER}\r\n`);
    expect(decodeOwnerText(utf16be(NUMBER))).toBe(NUMBER);
  });

  it("refuses bytes that are neither, with a message that carries none of them", () => {
    for (const bytes of [
      Buffer.from([0x35, 0x00, 0x35, 0x00]),
      Buffer.from([0xff, 0xfe, 0x35]),
      Buffer.from([0x35, 0xc3, 0x28]),
    ]) {
      expect(() => decodeOwnerText(bytes)).toThrow(
        /^the file must be UTF-8 or UTF-16 text$/,
      );
    }
  });
});

describe("a usage message", () => {
  it("withholds every run of six digits or more, and keeps shorter ones", () => {
    expect(withholdDigits(`unexpected argument "${NUMBER}" and 12345`)).toBe(
      'unexpected argument "<digits withheld>" and 12345',
    );
  });
});
