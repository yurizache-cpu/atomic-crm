// How leads ask for a person (ADR 0023 §C, pack health_pt_br.v4). All texts
// are synthetic; staff names are fictional.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeMessage, type SanitizerPack } from "./messageSanitizer.ts";
import { HEALTH_PT_BR_V3, HEALTH_PT_BR_V4 } from "./packs/healthPtBr.ts";
import { PERSON_REQUEST_PT_BR } from "./packs/personRequestPtBr.ts";

interface CorpusEntry {
  readonly text: string;
  /** The judged label: the message asks for a person. */
  readonly person: boolean;
}

// Synthetic messages judged by two independent readers (ADR 0023 §C). The
// tenant in them names its team: these are the configured names.
const corpus = JSON.parse(
  readFileSync(
    new URL("./testSupport/personRequestCorpus.json", import.meta.url),
    "utf8",
  ),
) as { handoffNames: string[]; entries: CorpusEntry[] };
const PERSON_REQUEST_CORPUS = corpus.entries;
const NAMES = { handoffNames: corpus.handoffNames };

const requests = PERSON_REQUEST_CORPUS.filter((entry) => entry.person);
const others = PERSON_REQUEST_CORPUS.filter((entry) => !entry.person);
const asksForPerson = (text: string, pack: SanitizerPack) =>
  sanitizeMessage(text, pack).humanRequested;

describe("pack v4: how leads ask for a person", () => {
  it("recognises every request for a person in the corpus", () => {
    const missed = requests
      .filter((entry) => !asksForPerson(entry.text, HEALTH_PT_BR_V4))
      .map((entry) => entry.text);
    expect(missed).toEqual([]);
  });

  it("flags no message that does not ask for one", () => {
    const flagged = others
      .filter((entry) => asksForPerson(entry.text, HEALTH_PT_BR_V4))
      .map((entry) => entry.text);
    expect(flagged).toEqual([]);
  });

  it("moves the conversation to a person and sends nothing to a model", () => {
    for (const text of [
      "nao quero falar com robo",
      "quero falar com o Rafael",
      "me liga quando puder",
      "tem alguem ai?",
      "to com mta ansiedade esses dias e nao quero falar com robo, tem alguem ai?",
    ]) {
      expect(sanitizeMessage(text, HEALTH_PT_BR_V4)).toMatchObject({
        humanRequested: true,
        requiresHuman: true,
      });
    }
  });

  it("changes nothing else: every text reaches a model exactly as under v3", () => {
    for (const { text } of PERSON_REQUEST_CORPUS) {
      const v3 = sanitizeMessage(text, HEALTH_PT_BR_V3);
      const v4 = sanitizeMessage(text, HEALTH_PT_BR_V4);
      const rest = (screened: typeof v3) => {
        const {
          packId: _packId,
          humanRequested: _humanRequested,
          requiresHuman: _requiresHuman,
          ...kept
        } = screened;
        return kept;
      };
      expect(rest(v4)).toEqual(rest(v3));
      if (v3.humanRequested) expect(v4.humanRequested).toBe(true);
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
      expect(asksForPerson(text, HEALTH_PT_BR_V4)).toBe(false);
    }
  });

  it("records why v4 exists: v3 missed these", () => {
    for (const text of [
      "nao quero falar com robo",
      "quero falar com o Rafael",
      "me passa pra secretaria por favor",
      "tem alguem ai?",
      "me liga quando puder",
    ]) {
      expect(asksForPerson(text, HEALTH_PT_BR_V3)).toBe(false);
      expect(asksForPerson(text, HEALTH_PT_BR_V4)).toBe(true);
    }
  });

  it("needs every pattern it adds: removing any one misses a request", () => {
    const unneeded = PERSON_REQUEST_PT_BR.flatMap((removed, index) => {
      const without: SanitizerPack = {
        ...HEALTH_PT_BR_V4,
        humanRequest: HEALTH_PT_BR_V4.humanRequest.filter(
          (pattern) => pattern !== removed,
        ),
      };
      const stillCaught = requests.every((entry) =>
        asksForPerson(entry.text, without),
      );
      return stillCaught ? [`#${index} ${removed.source.slice(0, 60)}`] : [];
    });
    expect(unneeded).toEqual([]);
  });
});
