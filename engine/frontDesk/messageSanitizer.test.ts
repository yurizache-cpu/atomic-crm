// The front desk's pre-model screen (ADR 0023 §B). All texts are synthetic.

import { describe, expect, it } from "vitest";
import {
  foldForScreening,
  MAX_SCREENED_LENGTH,
  OMISSION_MARKER,
  sanitizeMessage,
  SANITIZER_VERSION,
} from "./messageSanitizer.ts";
import {
  HEALTH_PT_BR_V1,
  HEALTH_PT_BR_V2,
  SANITIZER_PACKS,
} from "./packs/healthPtBr.ts";

describe("the six owner cases", () => {
  it("case 1: an administrative question passes whole", () => {
    const screened = sanitizeMessage("Qual o valor da sessão?");
    expect(screened).toMatchObject({
      messageClass: "administrative",
      safeText: "Qual o valor da sessão?",
      segmentsRedacted: 0,
      fullyBlocked: false,
      sensitiveContentPresent: false,
    });
  });

  it("case 2: a mixed message keeps the scheduling request and omits the sensitive clause", () => {
    const screened = sanitizeMessage(
      "Estou tendo muita ansiedade e queria saber se tem horário terça.",
    );
    expect(screened).toMatchObject({
      messageClass: "mixed",
      safeText: `${OMISSION_MARKER} queria saber se tem horário terça.`,
      segmentsSensitive: 1,
      administrativeIntent: true,
      sensitiveContentPresent: true,
    });
    expect(screened.safeText).not.toMatch(/ansiedade/i);
  });

  it("case 3: sensitive content alone leaves nothing to send", () => {
    const screened = sanitizeMessage(
      "Tenho tido crises de pânico, não durmo direito.",
    );
    expect(screened).toMatchObject({
      messageClass: "sensitive_only",
      safeText: null,
      fullyBlocked: true,
    });
  });

  it("case 4: a client's logistics pass, and being in care is omitted", () => {
    expect(
      sanitizeMessage("Preciso remarcar a sessão de quinta para sexta às 19h.")
        .messageClass,
    ).toBe("administrative");
    const screened = sanitizeMessage("Sou paciente, preciso remarcar quinta.");
    expect(screened.safeText).toBe(
      `${OMISSION_MARKER}, preciso remarcar quinta.`,
    );
  });

  it("case 5: a request for a person is recognised whatever else the message says", () => {
    for (const text of [
      "Quero falar com uma pessoa, por favor.",
      "Posso falar com um atendente?",
      "Você é um robô?",
      "Queria atendimento humano",
    ]) {
      expect(sanitizeMessage(text)).toMatchObject({
        humanRequested: true,
        requiresHuman: true,
      });
    }
    expect(sanitizeMessage("Qual o valor?").humanRequested).toBe(false);
  });

  it("case 6: an unrecognised message is held back, not guessed at", () => {
    expect(sanitizeMessage("as coisas estão pesadas")).toMatchObject({
      messageClass: "unknown",
      safeText: null,
      segmentsUnrecognised: 1,
    });
  });
});

describe("safety", () => {
  it("classifies danger on the whole message, before any clause is kept", () => {
    for (const text of [
      "Não quero mais viver",
      "às vezes penso em suicídio, mas queria marcar",
      "quero morrer",
      "tenho vontade de me matar",
      "ele me bate todo dia",
      "é uma emergência",
    ]) {
      const screened = sanitizeMessage(text);
      expect(screened, text).toMatchObject({
        messageClass: "safety",
        safetyClass: "crisis",
        safeText: null,
        requiresHuman: true,
      });
    }
  });
});

describe("the screen's mechanics", () => {
  it("never splits an administrative phrase that names a sensitive word", () => {
    expect(
      sanitizeMessage("Qual a diferença entre psicólogo e psiquiatra?"),
    ).toMatchObject({
      messageClass: "administrative",
      safeText: "Qual a diferença entre psicólogo e psiquiatra?",
    });
    // The rest of that clause must still be clean.
    expect(
      sanitizeMessage("Quanto tempo dura o tratamento de depressão?")
        .messageClass,
    ).toBe("sensitive_only");
  });

  it('never reads the verb "é" as the connector "e"', () => {
    expect(
      sanitizeMessage("Meu nome é Ana, queria marcar uma consulta").safeText,
    ).toBe("Meu nome é Ana, queria marcar uma consulta");
  });

  it("removes structured identifiers before splitting, so an address is never cut in two", () => {
    expect(
      sanitizeMessage("Vocês aceitam convênio? Meu email é ana@x.com").safeText,
    ).toBe("Vocês aceitam convênio? Meu email é [email]");
    expect(
      sanitizeMessage("Pode ligar no (27) 99999-0000 para marcar").safeText,
    ).not.toMatch(/9999/);
  });

  it("merges neighbouring omissions into one marker, and gives no reason", () => {
    const screened = sanitizeMessage(
      "Estou triste, ando sem dormir e queria marcar na quinta.",
    );
    expect(screened.safeText).toBe(
      `${OMISSION_MARKER}, queria marcar na quinta.`,
    );
    expect(screened.safeText).not.toMatch(/sensitive|clinic|saúde/i);
  });

  it("splits clauses at line breaks before anything else normalises them (PR #28 review, P1)", () => {
    const screened = sanitizeMessage("as coisas estão pesadas\nQual o valor?");
    expect(screened.messageClass).toBe("mixed");
    expect(screened.safeText).toBe(`${OMISSION_MARKER} Qual o valor?`);
    expect(screened.safeText).not.toMatch(/pesadas/);
    // A danger phrase broken across lines is still one phrase.
    expect(sanitizeMessage("quero\nmorrer").messageClass).toBe("safety");
    expect(sanitizeMessage("Quero falar com\numa pessoa").humanRequested).toBe(
      true,
    );
  });

  it("treats an empty or punctuation-only message as nothing to answer", () => {
    expect(sanitizeMessage("").messageClass).toBe("unknown");
    expect(sanitizeMessage("   ").messageClass).toBe("unknown");
  });

  it("omits what lies beyond the screened length", () => {
    const long = `Qual o valor? ${"a ".repeat(MAX_SCREENED_LENGTH)}`;
    const screened = sanitizeMessage(long);
    expect(screened.segmentsUnrecognised).toBeGreaterThan(0);
    expect((screened.safeText ?? "").length).toBeLessThan(long.length);
  });

  it("records its version and the pack it used, and the counts add up", () => {
    const screened = sanitizeMessage(
      "Oi, estou ansiosa e queria saber o valor",
    );
    expect(screened.sanitizerVersion).toBe(SANITIZER_VERSION);
    expect(screened.packId).toBe("health_pt_br.v2");
    expect(sanitizeMessage("Qual o valor?", HEALTH_PT_BR_V1).packId).toBe(
      "health_pt_br.v1",
    );
    expect(screened.segmentsRedacted).toBe(
      screened.segmentsSensitive + screened.segmentsUnrecognised,
    );
  });

  it("is deterministic", () => {
    const text = "Tenho TOC e queria saber se atendem online às 19h";
    expect(sanitizeMessage(text)).toEqual(sanitizeMessage(text));
  });

  it("folds accents and case one unit per unit, so offsets survive", () => {
    const text = "Ãnsia, Sessão às 19h";
    expect(foldForScreening(text)).toHaveLength(text.length);
    expect(foldForScreening(text)).toBe("ansia, sessao as 19h");
  });

  it("lists exactly its reviewed packs", () => {
    expect(Object.keys(SANITIZER_PACKS)).toEqual([
      HEALTH_PT_BR_V1.id,
      HEALTH_PT_BR_V2.id,
    ]);
  });
});

// The synthetic corpus: every entry names the clause that must NEVER reach a
// model (`omit`) and the request that SHOULD (`keep`). Leaks are a hard fail;
// over-omission is measured and bounded.
interface Entry {
  readonly text: string;
  readonly omit: readonly string[];
  readonly keep: readonly string[];
}

const CORPUS: readonly Entry[] = [
  { text: "Qual o valor da sessão?", omit: [], keep: ["valor da sessão"] },
  { text: "Vocês atendem online?", omit: [], keep: ["atendem online"] },
  {
    text: "Bom dia! Tem horário amanhã à tarde?",
    omit: [],
    keep: ["horário amanhã"],
  },
  { text: "Aceitam pix ou cartão?", omit: [], keep: ["pix"] },
  { text: "Quanto custa o pacote mensal?", omit: [], keep: ["pacote mensal"] },
  { text: "Queria remarcar para sexta às 18h", omit: [], keep: ["remarcar"] },
  {
    text: "Preciso cancelar a consulta de amanhã",
    omit: [],
    keep: ["cancelar"],
  },
  { text: "Onde fica o endereço de vocês?", omit: [], keep: ["endereço"] },
  {
    text: "Atendem adolescentes de 15 anos?",
    omit: [],
    keep: ["adolescentes"],
  },
  { text: "Dá recibo para reembolso do plano?", omit: [], keep: ["reembolso"] },
  {
    text: "Estou com depressão, queria marcar",
    omit: ["depressão"],
    keep: ["queria marcar"],
  },
  {
    text: "Tenho TDAH e queria saber o valor",
    omit: ["TDAH"],
    keep: ["valor"],
  },
  {
    text: "Meu psiquiatra indicou, tem vaga na segunda?",
    omit: ["psiquiatra"],
    keep: ["vaga na segunda"],
  },
  {
    text: "Tomo sertralina, posso marcar na quinta?",
    omit: ["sertralina"],
    keep: ["marcar na quinta"],
  },
  {
    text: "Estou passando por um divórcio e queria agendar",
    omit: ["divórcio"],
    keep: ["agendar"],
  },
  {
    text: "Perdi minha mãe mês passado, quanto custa a sessão?",
    omit: ["Perdi minha mãe"],
    keep: ["custa a sessão"],
  },
  { text: "Tenho crises de pânico", omit: ["pânico"], keep: [] },
  { text: "Não consigo dormir há semanas", omit: ["dormir"], keep: [] },
  {
    text: "Estou muito triste e sozinha",
    omit: ["triste", "sozinha"],
    keep: [],
  },
  {
    text: "Meu marido é abusivo, queria horário",
    omit: ["abusivo"],
    keep: ["horário"],
  },
  {
    text: "Tenho compulsão alimentar e queria valores",
    omit: ["compulsão"],
    keep: ["valores"],
  },
  {
    text: "Bebo demais e queria ajuda, quanto custa?",
    omit: ["Bebo demais"],
    keep: ["quanto custa"],
  },
  {
    text: "Fui diagnosticada com bipolar, atendem online?",
    omit: ["bipolar", "diagnosticada"],
    keep: ["atendem online"],
  },
  {
    text: "Estou grávida e ansiosa, tem horário?",
    omit: ["grávida", "ansiosa"],
    keep: ["horário"],
  },
  {
    text: "Sofro de insônia; qual o preço?",
    omit: ["insônia"],
    keep: ["preço"],
  },
  {
    text: "Tenho medo de tudo, posso marcar?",
    omit: ["medo"],
    keep: ["marcar"],
  },
  { text: "Ando sem vontade de nada", omit: ["sem vontade"], keep: [] },
  {
    text: "as coisas estão difíceis em casa, queria marcar",
    omit: ["difíceis em casa"],
    keep: ["queria marcar"],
  },
  {
    text: "minha cabeça está a mil, tem vaga hoje?",
    omit: ["cabeça está a mil"],
    keep: ["vaga hoje"],
  },
  {
    text: "Sou gay e queria saber se atendem online",
    omit: ["gay"],
    keep: ["atendem online"],
  },
];

describe("the synthetic corpus", () => {
  it.each([HEALTH_PT_BR_V1, HEALTH_PT_BR_V2])(
    "leaks no omitted clause under $id either (hard requirement)",
    (pack) => {
      const leaks = CORPUS.flatMap((entry) => {
        const sent = (
          sanitizeMessage(entry.text, pack).safeText ?? ""
        ).toLowerCase();
        return entry.omit
          .filter((clause) => sent.includes(clause.toLowerCase()))
          .map((clause) => `${entry.text} -> ${clause}`);
      });
      expect(leaks).toEqual([]);
    },
  );

  it("leaks no omitted clause (hard requirement)", () => {
    const leaks = CORPUS.flatMap((entry) => {
      const screened = sanitizeMessage(entry.text);
      const sent = (screened.safeText ?? "").toLowerCase();
      return entry.omit
        .filter((clause) => sent.includes(clause.toLowerCase()))
        .map((clause) => `${entry.text} -> ${clause}`);
    });
    expect(leaks).toEqual([]);
  });

  it("keeps the administrative request in nearly every case (over-omission bounded)", () => {
    const expected = CORPUS.flatMap((entry) =>
      entry.keep.map((clause) => [entry, clause] as const),
    );
    const lost = expected.filter(
      ([entry, clause]) =>
        !(sanitizeMessage(entry.text).safeText ?? "")
          .toLowerCase()
          .includes(clause.toLowerCase()),
    );
    // Measured on this corpus: every request kept. A pack change that drops
    // more than one in ten fails here, by name.
    expect(lost.map(([entry, clause]) => `${entry.text} -> ${clause}`)).toEqual(
      [],
    );
    expect(lost.length / expected.length).toBeLessThanOrEqual(0.1);
  });

  it("documents a known miss: indirect distress fused into an administrative clause passes", () => {
    // No pattern names "não está legal", and the clause holds a time word.
    // Recorded so that a pack that starts catching it fails here and updates
    // ADR 0023 §B's limits, rather than the limit staying unknown.
    const screened = sanitizeMessage(
      "Preciso marcar com urgência, minha cabeça não está legal hoje",
    );
    expect(screened.safeText).toContain("minha cabeça não está legal hoje");
  });
});

// The owner's intake form (2026-10-05): after the site's triage, a lead sends
// the first WhatsApp message the form wrote, built here exactly as the form
// builds it (synthetic names). Its middle sentence is the demand, its
// duration and a 0-10 rating: health data that must never reach a model.
const INTAKE_DEMANDS = [
  "ansiedade e excesso de pensamento",
  "burnout, exaustão e sobrecarga",
  "paralisia, procrastinação e bloqueio",
  "conflitos no trabalho ou relacionamento",
] as const;
const INTAKE_TIMES = [
  "há menos de 6 meses",
  "há algo entre 6 meses e 2 anos",
  "há mais de 2 anos",
] as const;

const intakeMessage = (
  name: string | null,
  demandLine: string,
  plan: string | null,
): string =>
  [
    name === null
      ? "Oi, Yuri! Fiz a triagem no seu site."
      : `Oi, Yuri! Sou ${name}, fiz a triagem no seu site.`,
    demandLine,
    plan === null
      ? "Queria começar pela sessão inicial de avaliação (R$ 97). Me avisa um horário que dê pra você?"
      : `Queria começar pela sessão inicial de avaliação (R$ 97), pensando em seguir ${plan} depois. Me avisa um horário que dê pra você?`,
  ].join("\n");

const INTAKE: readonly Entry[] = [
  ...INTAKE_DEMANDS.flatMap((demand) =>
    INTAKE_TIMES.flatMap((time) =>
      [2, 8].flatMap((impact) =>
        [null, "semanal"].map((plan) => ({
          text: intakeMessage(
            plan === null ? "Ana" : null,
            `O que mais tem me pegado é ${demand} ${time} (impacto ${impact}/10).`,
            plan,
          ),
          omit: [
            ...demand.split(/, | e | ou /),
            "impacto",
            `${impact}/10`,
            time,
            ...(plan === null ? ["Sou Ana"] : []),
          ],
          keep: ["sessão inicial de avaliação", "horário que dê pra você"],
        })),
      ),
    ),
  ),
  {
    text: intakeMessage(
      "Bruno",
      "Tô lidando com insônia e uso de remédio há mais de 2 anos (impacto 8/10).",
      null,
    ),
    omit: ["insônia", "remédio", "impacto", "8/10"],
    keep: ["sessão inicial de avaliação"],
  },
  {
    text: intakeMessage(
      null,
      "Tem algo que prefiro te contar pessoalmente (impacto 9/10).",
      "quinzenal",
    ),
    omit: ["prefiro te contar", "impacto", "9/10"],
    keep: ["sessão inicial de avaliação", "quinzenal"],
  },
];

describe("the owner's intake form (pack v2)", () => {
  it("never lets the demand, its duration or its rating through", () => {
    const leaks = INTAKE.flatMap((entry) => {
      const sent = (
        sanitizeMessage(entry.text, HEALTH_PT_BR_V2).safeText ?? ""
      ).toLowerCase();
      return entry.omit
        .filter((clause) => sent.includes(clause.toLowerCase()))
        .map((clause) => `${entry.text} -> ${clause}`);
    });
    expect(leaks).toEqual([]);
  });

  it("keeps the request for the first session and a time, as one mixed message", () => {
    for (const entry of INTAKE) {
      const screened = sanitizeMessage(entry.text, HEALTH_PT_BR_V2);
      expect(screened.messageClass, entry.text).toBe("mixed");
      for (const clause of entry.keep) {
        expect(screened.safeText ?? "", entry.text).toContain(clause);
      }
    }
  });

  it("reads like a message: one marker per run of omissions, no stray punctuation", () => {
    const screened = sanitizeMessage(
      intakeMessage(
        "Ana",
        "O que mais tem me pegado é burnout, exaustão e sobrecarga há menos de 6 meses (impacto 5/10).",
        "semanal",
      ),
      HEALTH_PT_BR_V2,
    );
    expect(screened.safeText).toBe(
      `Oi, ${OMISSION_MARKER}, fiz a triagem no seu site. ${OMISSION_MARKER}. Queria começar pela sessão inicial de avaliação (R$ 97), pensando em seguir semanal depois. Me avisa um horário que dê pra você?`,
    );
  });

  it("records why v2 exists: v1 let the form's demand sentence through", () => {
    const text = intakeMessage(
      null,
      "O que mais tem me pegado é conflitos no trabalho ou relacionamento há mais de 2 anos (impacto 7/10).",
      null,
    );
    expect(sanitizeMessage(text, HEALTH_PT_BR_V1).safeText).toContain(
      "conflitos no trabalho",
    );
    expect(sanitizeMessage(text, HEALTH_PT_BR_V2).safeText).not.toContain(
      "conflitos",
    );
  });
});

// Free text with the form's vocabulary, where an administrative word shares
// the clause: only v2's own patterns stand between it and a model.
const V2_FREE_TEXT: readonly Entry[] = [
  {
    text: "Meu relacionamento está difícil esta semana, posso marcar?",
    omit: ["relacionamento"],
    keep: ["posso marcar"],
  },
  {
    text: "Muitos conflitos em casa nesta semana, tem horário?",
    omit: ["conflitos"],
    keep: ["tem horário"],
  },
  {
    text: "Sobrecarga demais esta semana, tem horário sábado?",
    omit: ["Sobrecarga"],
    keep: ["horário sábado"],
  },
  {
    text: "O que mais tem me pegado é a rotina à noite, tem vaga de manhã?",
    omit: ["me pegado", "rotina"],
    keep: ["vaga de manhã"],
  },
  {
    text: "Procrastino tudo há meses, quanto custa a sessão?",
    omit: ["Procrastino"],
    keep: ["custa a sessão"],
  },
];

describe("the form's vocabulary in free text (pack v2)", () => {
  it("omits it even beside an administrative word", () => {
    const leaks = V2_FREE_TEXT.flatMap((entry) => {
      const sent = (
        sanitizeMessage(entry.text, HEALTH_PT_BR_V2).safeText ?? ""
      ).toLowerCase();
      return [
        ...entry.omit
          .filter((clause) => sent.includes(clause.toLowerCase()))
          .map((clause) => `${entry.text} -> leaked ${clause}`),
        ...entry.keep
          .filter((clause) => !sent.includes(clause.toLowerCase()))
          .map((clause) => `${entry.text} -> lost ${clause}`),
      ];
    });
    expect(leaks).toEqual([]);
  });
});
