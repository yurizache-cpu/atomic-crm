// How leads ask for a person (ADR 0023 §C, pack health_pt_br.v4). Every text
// is synthetic and every name fictional.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeMessage, type SanitizerPack } from "./messageSanitizer.ts";
import { HEALTH_PT_BR_V3, HEALTH_PT_BR_V4 } from "./packs/healthPtBr.ts";
import {
  namedPersonRequests,
  PERSON_REQUEST_PT_BR,
} from "./packs/personRequestPtBr.ts";

interface CorpusEntry {
  readonly text: string;
  /** The judged label: the message asks for a person. */
  readonly person: boolean;
}

interface Corpus {
  /** The names the corpus's tenant configures (`handoffNames`). */
  readonly handoffNames: readonly string[];
  /** Messages two independent judges labelled the same way. */
  readonly entries: readonly CorpusEntry[];
  /** Requests v4 does not recognise: an administrative one reaches the model. */
  readonly knownMisses: readonly string[];
  /** Messages v4 hands over though they ask for no one. */
  readonly knownFalseHandoffs: readonly string[];
}

const corpus = JSON.parse(
  readFileSync(
    new URL("./testSupport/personRequestCorpus.json", import.meta.url),
    "utf8",
  ),
) as Corpus;
const NAMES = { handoffNames: corpus.handoffNames };

const asksForPerson = (
  text: string,
  pack: SanitizerPack = HEALTH_PT_BR_V4,
  options = NAMES,
) => sanitizeMessage(text, pack, options).humanRequested;

/** What v4 gets wrong on the corpus, with a given pattern list. */
function errors(pack: SanitizerPack) {
  const misses: string[] = [];
  const falseHandoffs: string[] = [];
  for (const entry of corpus.entries) {
    const asked = asksForPerson(entry.text, pack);
    if (entry.person && !asked) misses.push(entry.text);
    if (!entry.person && asked) falseHandoffs.push(entry.text);
  }
  return { misses, falseHandoffs };
}

describe("pack v4: how leads ask for a person", () => {
  it("makes exactly the mistakes it is known to make on the judged corpus", () => {
    const found = errors(HEALTH_PT_BR_V4);
    expect(found.falseHandoffs).toEqual(corpus.knownFalseHandoffs);
    expect(found.misses).toEqual(corpus.knownMisses);
  });

  it("is precise: almost nothing that asks for no one is handed over", () => {
    const others = corpus.entries.filter((entry) => !entry.person).length;
    expect(corpus.knownFalseHandoffs.length / others).toBeLessThan(0.02);
  });

  it("moves the conversation to a person and sends nothing to a model", () => {
    for (const text of [
      "nao quero falar com robo",
      "quero falar com uma pessoa, por favor",
      "me liga quando puder",
      "tem alguem ai?",
      "me passa pra um atendente pfv",
      "to com mta ansiedade esses dias e nao quero falar com robo, tem alguem ai?",
    ]) {
      expect(sanitizeMessage(text, HEALTH_PT_BR_V4)).toMatchObject({
        humanRequested: true,
        requiresHuman: true,
      });
    }
  });

  it("reads a name only when the tenant configures it, and never someone else's", () => {
    expect(asksForPerson("quero falar com o Rafael")).toBe(true);
    expect(
      asksForPerson("quero falar com o Rafael", HEALTH_PT_BR_V4, {
        handoffNames: [],
      }),
    ).toBe(false);
    for (const text of [
      "preciso falar com o Bruno, meu marido, antes de pagar",
      "meu filho Rafael vai me chamar no link",
      "minha prima Marina me liga todo dia",
      "deixa eu falar com o Bruno e te falo",
      "meu filho tem 12 anos, chama Rafael",
    ]) {
      expect(asksForPerson(text)).toBe(false);
    }
  });

  it("takes a name from the configuration as written, with or without its title", () => {
    const options = { handoffNames: ["Dra. Helena", "José"] };
    expect(
      asksForPerson("posso falar com a dra helena?", HEALTH_PT_BR_V4, options),
    ).toBe(true);
    expect(
      asksForPerson("chama a Helena pfv", HEALTH_PT_BR_V4, options),
    ).toBe(true);
    expect(
      asksForPerson("quero falar com o jose", HEALTH_PT_BR_V4, options),
    ).toBe(true);
    // A name that is not a name is ignored, never compiled as a pattern.
    expect(
      namedPersonRequests(["(?:.*)", "", "1234"]).map((p) => p.source),
    ).toEqual([]);
  });

  it("reads a line break as the end of a clause", () => {
    const text = "qual o valor do pacote mensal\nme passa pra Marina por favor";
    expect(asksForPerson(text)).toBe(true);
    expect(asksForPerson("Quero falar com\numa pessoa")).toBe(true);
  });

  it("changes nothing else: every text reaches a model exactly as under v3", () => {
    const rest = (text: string, pack: SanitizerPack) => {
      const {
        packId: _packId,
        humanRequested: _humanRequested,
        requiresHuman: _requiresHuman,
        ...kept
      } = sanitizeMessage(text, pack, NAMES);
      return kept;
    };
    for (const { text } of corpus.entries) {
      expect(rest(text, HEALTH_PT_BR_V4)).toEqual(rest(text, HEALTH_PT_BR_V3));
    }
  });

  it("leaves the question about the assistant to the model, as v3 does", () => {
    for (const text of [
      "Você é um robô?",
      "isso é uma IA? kkk so curiosidade",
      "Qual seu nome mesmo?",
      "Com quem eu falo?",
      "td bem ser robo, so me manda os horarios de quinta",
    ]) {
      expect(asksForPerson(text)).toBe(false);
    }
  });

  it("records why v4 exists: what v3 missed, and what v3 handed over", () => {
    for (const text of [
      "nao quero falar com robo",
      "me passa pra secretaria por favor",
      "tem alguem ai?",
      "me liga quando puder",
    ]) {
      expect(asksForPerson(text, HEALTH_PT_BR_V3)).toBe(false);
      expect(asksForPerson(text)).toBe(true);
    }
    const family = "preciso falar com alguem da minha familia antes de decidir";
    expect(asksForPerson(family, HEALTH_PT_BR_V3)).toBe(true);
    expect(asksForPerson(family)).toBe(false);
  });

  it("needs every pattern it adds: removing any one changes a judged decision", () => {
    const baseline = errors(HEALTH_PT_BR_V4).misses.length;
    const unneeded = PERSON_REQUEST_PT_BR.flatMap((removed, index) => {
      const without: SanitizerPack = {
        ...HEALTH_PT_BR_V4,
        humanRequest: PERSON_REQUEST_PT_BR.filter((p) => p !== removed),
      };
      return errors(without).misses.length > baseline
        ? []
        : [`#${index} ${removed.source.slice(0, 50)}`];
    });
    const named = namedPersonRequests(corpus.handoffNames);
    const unneededNamed = named.flatMap((removed, index) => {
      const without: SanitizerPack = {
        ...HEALTH_PT_BR_V4,
        namedRequest: () => named.filter((p) => p !== removed),
      };
      return errors(without).misses.length > baseline
        ? []
        : [`named #${index}`];
    });
    expect([...unneeded, ...unneededNamed]).toEqual([]);
  });
});
