import { describe, expect, it } from "vitest";
import {
  REDACTION_MARKERS,
  redactNullable,
  redactStructuredIdentifiers,
} from "./identifierRedaction.ts";

describe("structured identifier redaction (ADR 0020 §D8)", () => {
  it.each([
    ["a formatted mobile", "me liga (11) 98765-4321 amanhã", "[phone]"],
    ["an international number", "whats +55 11 98765-4321", "[phone]"],
    ["an unformatted mobile", "meu número 11987654321", "[phone]"],
    ["a dotted landline", "fixo 11.3456.7890", "[phone]"],
    ["an e-mail address", "escreve para joao.silva+x@example.test", "[email]"],
    ["a formatted CPF", "meu CPF é 123.456.789-09", "[cpf]"],
    ["a URL", "vi em https://example.test/perfil?id=9", "[url]"],
    ["a bare www address", "no site www.example.test/agenda", "[url]"],
  ])("removes %s", (_case, text, marker) => {
    const redacted = redactStructuredIdentifiers(text);
    expect(redacted).toContain(marker);
    expect(redacted).not.toMatch(/\d{4}|@|example\.test/);
  });

  it("keeps a bare date, a time and an amount, which identify nobody", () => {
    const text =
      "pode ser 2026-10-02 ou 02.10.2026 às 10:30? quanto custa R$ 1.500,00?";
    expect(redactStructuredIdentifiers(text)).toBe(text);
  });

  it("is not anonymisation: a name and a story in free text stay", () => {
    expect(
      redactStructuredIdentifiers("Sou a Maria Silva, moro na Rua Augusta"),
    ).toBe("Sou a Maria Silva, moro na Rua Augusta");
  });

  it("is deterministic, keeps null, and uses only its fixed markers", () => {
    const text = "ligue 11987654321 ou mande para a@b.test";
    expect(redactStructuredIdentifiers(text)).toBe(
      redactStructuredIdentifiers(text),
    );
    expect(redactNullable(null)).toBeNull();
    expect(redactStructuredIdentifiers(text)).toBe(
      `ligue ${REDACTION_MARKERS.phone} ou mande para ${REDACTION_MARKERS.email}`,
    );
  });
});
