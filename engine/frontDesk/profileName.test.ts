// @vitest-environment node
//
// The first name a new lead may take from its sender's WhatsApp profile name
// (ADR 0026 §C). Every value is synthetic.
import { describe, expect, it } from "vitest";
import { HEALTH_PT_BR_V4 } from "./packs/healthPtBr.ts";
import type { SanitizerPack } from "./messageSanitizer.ts";
import { profileFirstName } from "./profileName.ts";

describe("a profile name a lead may take its first name from", () => {
  it.each([
    ["Maria Silva", "Maria"],
    ["José", "José"],
    ["  Ana  Paula ", "Ana"],
    ["D'Ávila Souza", "D'Ávila"],
    ["Jean-Luc", "Jean-Luc"],
    ["=Carla", "Carla"],
    ["+ @Bruna", "Bruna"],
    ["Zoë\u0007", "Zoë"],
    ["Ma​ria", "Ma"],
  ])("reads %j as the first name %j", (raw, expected) => {
    expect(profileFirstName(raw)).toBe(expected);
  });

  it.each([
    ["no name", null],
    ["an empty name", ""],
    ["blank", "   "],
    ["too long", "a".repeat(257)],
    ["digits", "Ana 2024"],
    ["a phone number", "+55 11 90000-0001"],
    ["an email address", "ana@example.com"],
    ["a link", "www.example.com"],
    ["a scheme", "https://example.com"],
    ["a request to stop", "Pare de me mandar"],
    ["a request for a person", "Quero falar com uma pessoa"],
    ["danger", "Não quero mais viver"],
    ["a sensitive word", "Ansiosa"],
    ["a sensitive word after a name", "Ana Depressiva"],
    ["a diagnosis", "Bipolar"],
    ["a first word that is not a name", "¿Hola"],
  ])("gives no first name for %s", (_case, raw) => {
    expect(profileFirstName(raw as string | null)).toBeNull();
  });

  it("gives no first name for a word longer than its bound", () => {
    expect(profileFirstName("A".repeat(41))).toBeNull();
    expect(profileFirstName("A".repeat(40))).toBe("A".repeat(40));
  });

  it("gives no first name, and does not throw, when the screen fails", () => {
    const broken = new Proxy(HEALTH_PT_BR_V4, {
      get() {
        throw new Error("screen failure");
      },
    }) as SanitizerPack;
    expect(profileFirstName("Maria", broken)).toBeNull();
  });
});
