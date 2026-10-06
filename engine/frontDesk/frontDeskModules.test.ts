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

  it("never reads a configuration number or a slot's month as a price (PR #28 review, P2)", () => {
    const withPolicy = groundingFacts({
      ...CONTEXT,
      policy: { ...CONTEXT.policy, contextTurns: 6 },
    });
    expect(checkGrounding("A sessão custa R$ 6.", withPolicy).grounded).toBe(
      false,
    );
    expect(checkGrounding("A sessão custa R$ 10.", withPolicy).grounded).toBe(
      false,
    );
    expect(checkGrounding("A sessão custa R$ 200.", withPolicy).grounded).toBe(
      true,
    );
  });

  it("compares the year when a date names one (PR #28 review, P2)", () => {
    expect(checkGrounding("Pode ser 13/10/2026?", facts).grounded).toBe(true);
    expect(checkGrounding("Pode ser 13/10/26?", facts).grounded).toBe(true);
    expect(checkGrounding("Pode ser 13/10/2035?", facts).grounded).toBe(false);
    expect(checkGrounding("Pode ser 13/10?", facts).grounded).toBe(true);
  });

  it("reads hours before or after something as a duration, not a time (round two, 2026-10-05)", () => {
    for (const reply of [
      "Você recebe lembretes 24h e 5h antes da sessão.",
      "Remarcações com 12h de antecedência.",
      "Te aviso 2h antes.",
    ]) {
      expect(checkGrounding(reply, facts).grounded, reply).toBe(true);
    }
    // A time of day is still a claim, wherever it sits.
    expect(
      checkGrounding("Tenho às 5h, antes do almoço.", facts).grounded,
    ).toBe(false);
    expect(checkGrounding("Tenho às 07:30 antes.", facts).grounded).toBe(false);
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

  it("is the lead triage capability at prompt version v4", () => {
    expect(prompt.promptVersion).toBe(FRONT_DESK_PROMPT_VERSION);
    expect(FRONT_DESK_PROMPT_VERSION).toBe("lead_triage.v4");
  });

  const V4_CONTEXT: FrontDeskContext = frontDeskContextSchema.parse({
    ...CONTEXT,
    receivedAt: "2026-10-12T20:10",
    policy: {
      ...CONTEXT.policy,
      persona: { name: "Synthetic Persona" },
      locale: "pt-BR",
    },
    upcomingBooking: { startsAt: "2026-10-13T19:00" },
  });
  const v4 = buildFrontDeskPrompt(
    { name: "Lia", role: "front desk" },
    V4_CONTEXT,
  );
  const v4Document = JSON.parse(v4.input.slice(v4.input.indexOf("\n") + 1));

  it("names the assistant as the policy's persona, and as the agent without one", () => {
    expect(v4.instructions).toMatch(
      /^You are Synthetic Persona, the front desk/,
    );
    expect(v4Document.agent.name).toBe("Synthetic Persona");
    expect(prompt.instructions).toMatch(/^You are Lia, the front desk/);
  });

  it("says when the contact wrote and labels every instant in the policy's locale, keeping the instant", () => {
    expect(v4Document.receivedAt).toEqual({
      at: "2026-10-12T20:10",
      label: "segunda-feira, 12/10, 20:10",
    });
    expect(v4Document.availability.slots).toEqual([
      { at: "2026-10-13T19:00", label: "terça-feira, 13/10, 19:00" },
      { at: "2026-10-13T20:30", label: "terça-feira, 13/10, 20:30" },
    ]);
    expect(v4Document.conversation.upcomingBooking).toEqual({
      at: "2026-10-13T19:00",
      label: "terça-feira, 13/10, 19:00",
    });
    // No locale: the instant alone, never a guessed language.
    expect(
      JSON.parse(prompt.input.slice(prompt.input.indexOf("\n") + 1))
        .availability.slots[0],
    ).toEqual({
      at: "2026-10-13T19:00",
      label: null,
    });
  });

  it("accepts a context from a database that does not say when the contact wrote", () => {
    expect(frontDeskContextSchema.safeParse(CONTEXT).success).toBe(true);
    expect(
      JSON.parse(prompt.input.slice(prompt.input.indexOf("\n") + 1)).receivedAt,
    ).toBeNull();
  });

  it("speaks as an experienced receptionist: short, one next step, no repetition, no emoji the contact did not use", () => {
    expect(v4.instructions).toMatch(/one to three short sentences/);
    expect(v4.instructions).toMatch(/at most ONE next step/);
    expect(v4.instructions).toMatch(
      /Never repeat what one of your earlier turns/,
    );
    expect(v4.instructions).toMatch(/No emoji, unless the contact used one/);
    expect(v4.instructions).toMatch(
      /whether you are a robot or an AI, say yes/,
    );
  });

  it("is honest about what it cannot do: it does not book, and only the upcoming booking is booked", () => {
    expect(v4.instructions).toMatch(/You cannot book/);
    expect(v4.instructions).toMatch(
      /Only `conversation.upcomingBooking` is a booked session/,
    );
    expect(v4.instructions).toMatch(
      /do not give even a general answer: say you will check/,
    );
  });

  it("holds no tenant's words: names, tone and facts come from the configuration", () => {
    for (const word of [
      /Yuri/,
      /psic[oó]log/i,
      /\bLia\b/,
      /\bpra\b/,
      /consult[oó]rio/i,
    ]) {
      expect(v4.instructions).not.toMatch(word);
    }
  });

  it("counts the message's instant among the facts a reply may state", () => {
    expect(
      checkGrounding("Hoje, 12/10, tenho às 19:00.", groundingFacts(V4_CONTEXT))
        .grounded,
    ).toBe(true);
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

  it("accepts a persona and a locale, and refuses a malformed one", () => {
    const named = {
      ...policy,
      persona: { name: "Synthetic Persona" },
      locale: "pt-BR",
    };
    expect(validateConfiguration("operating_policy", named).ok).toBe(true);
    for (const bad of [
      { ...named, locale: "portuguese" },
      { ...named, persona: { name: "" } },
      { ...named, persona: { name: "x", tone: "y" } },
    ]) {
      expect(validateConfiguration("operating_policy", bad).ok).toBe(false);
    }
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
