// The front desk's pure modules (ADR 0023 §D, §E): the grounding check, the
// prompt built from the database's context, and the authoring shapes. All
// content is synthetic.

import { describe, expect, it } from "vitest";
import { checkGrounding } from "./grounding.ts";
import {
  buildFrontDeskPrompt,
  FRONT_DESK_PROMPT_VERSION,
  frontDeskContextSchema,
  groundingFacts,
  HIDDEN_TURN_MARKER,
  screeningAnswerSchema,
  type FrontDeskContext,
} from "./prompt.ts";
import { FIXED_MESSAGE_KEYS, validateConfiguration } from "./configuration.ts";
import { OMISSION_MARKER } from "./messageSanitizer.ts";

const CONTEXT: FrontDeskContext = frontDeskContextSchema.parse({
  message: `${OMISSION_MARKER} queria saber se tem horário terça.`,
  partyKind: "prospect",
  phase: "new",
  turns: [
    { role: "contact", text: "Oi" },
    { role: "agent", text: null },
  ],
  policy: {
    aiDisclosure: "Sou a assistente virtual.",
    scope: ["Agendamento"],
    prohibited: ["Sintomas"],
  },
  playbook: null,
  knowledge: {
    domains: {
      pricing: "A primeira sessão custa R$ 200.",
      hours: "Atendemos às 19h e às 20:30.",
    },
  },
  availability: {
    status: "connected",
    timezone: "America/Sao_Paulo",
    slots: ["2026-10-13T19:00", "2026-10-13T20:30"],
  },
  upcomingBooking: null,
});

describe("the grounding check", () => {
  const facts = groundingFacts(CONTEXT);

  it("accepts a reply whose facts are all given, in another notation", () => {
    expect(
      checkGrounding(
        "Custa R$ 200,00 e tenho 19:00 ou 20h30 no dia 13/10.",
        facts,
      ),
    ).toEqual({
      grounded: true,
      unsupported: 0,
    });
  });

  it("refuses a price, a time, a date, a link or a number the agent was not given", () => {
    for (const reply of [
      "Custa R$ 250.",
      "Tenho às 07:30.",
      "Pode ser dia 14/10?",
      "Pague em https://pague.example.test/x",
      "Ligue para (27) 99999-0000.",
      "Escreva para contato@example.test",
    ]) {
      expect(checkGrounding(reply, facts).grounded, reply).toBe(false);
    }
  });

  it("counts every unsupported fact", () => {
    expect(checkGrounding("R$ 999 às 07:30", facts).unsupported).toBe(2);
  });

  it("has nothing to check in prose", () => {
    expect(
      checkGrounding("Posso pedir para uma pessoa confirmar.", facts).grounded,
    ).toBe(true);
  });
});

describe("the front-desk prompt", () => {
  const prompt = buildFrontDeskPrompt(
    { name: "Lia", role: "front desk" },
    CONTEXT,
  );

  it("is the lead triage capability at prompt version v3", () => {
    expect(prompt.promptVersion).toBe(FRONT_DESK_PROMPT_VERSION);
    expect(FRONT_DESK_PROMPT_VERSION).toMatch(/^[a-z][a-z0-9_]*\.v[0-9]{1,4}$/);
  });

  it("carries the screened message, the knowledge and the availability, and nothing else of the contact", () => {
    expect(prompt.input).toContain(
      `${OMISSION_MARKER} queria saber se tem horário terça.`,
    );
    expect(prompt.input).toContain("A primeira sessão custa R$ 200.");
    expect(prompt.input).toContain("2026-10-13T19:00");
    // A turn the model may not read is a marker, never a text.
    expect(prompt.input).toContain(HIDDEN_TURN_MARKER);
  });

  it("tells the model never to ask about an omission or invent a fact", () => {
    expect(prompt.instructions).toContain(OMISSION_MARKER);
    expect(prompt.instructions).toMatch(/Never ask about them/);
    expect(prompt.instructions).toMatch(/Never invent a price, a time/);
    expect(prompt.instructions).toMatch(/Never claim to be a person/);
  });

  it("is deterministic", () => {
    expect(
      buildFrontDeskPrompt({ name: "Lia", role: "front desk" }, CONTEXT),
    ).toEqual(prompt);
  });

  it("accepts exactly the three dispositions the database answers", () => {
    expect(
      screeningAnswerSchema.safeParse({
        disposition: "held_for_person",
        screeningId: "x",
      }).success,
    ).toBe(true);
    expect(
      screeningAnswerSchema.safeParse({
        disposition: "autonomous_send",
        screeningId: "x",
      }).success,
    ).toBe(false);
    expect(
      screeningAnswerSchema.safeParse({
        disposition: "model",
        screeningId: "x",
        context: { message: "" },
      }).success,
    ).toBe(false);
  });
});

describe("the authoring shapes", () => {
  const policy = {
    sendMode: "supervised",
    sanitizerPack: "health_pt_br.v1",
    contextTurns: 6,
    aiDisclosure: "Sou a assistente virtual.",
    scope: ["Agendamento"],
    prohibited: [],
    partyPolicy: { prospect: [], client: [] },
  };

  it("accepts a supervised policy and refuses an autonomous one or an unknown pack", () => {
    expect(validateConfiguration("operating_policy", policy).ok).toBe(true);
    expect(
      validateConfiguration("operating_policy", {
        ...policy,
        sendMode: "autonomous",
      }).ok,
    ).toBe(false);
    expect(
      validateConfiguration("operating_policy", {
        ...policy,
        sanitizerPack: "none.v1",
      }).ok,
    ).toBe(false);
    expect(
      validateConfiguration("operating_policy", { ...policy, extra: 1 }).ok,
    ).toBe(false);
  });

  it("requires every fixed message", () => {
    const messages = Object.fromEntries(
      FIXED_MESSAGE_KEYS.map((key) => [key, `Texto ${key}`]),
    );
    expect(validateConfiguration("fixed_messages", { messages }).ok).toBe(true);
    const { safety: _dropped, ...withoutSafety } = messages;
    expect(
      validateConfiguration("fixed_messages", { messages: withoutSafety }).ok,
    ).toBe(false);
  });

  it("reports problem paths, never content", () => {
    const result = validateConfiguration("knowledge", {
      domains: { pricing: "" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(" ")).not.toContain("R$");
  });
});
