// @vitest-environment node
// The browser inbox's contract (contracts/company-os-api/conversation.ts;
// ADR 0026 §E, SI-87): each refinement refuses the answer it exists to refuse,
// the reply's text is bounded exactly as the act bounds it, and the acts'
// answers say what they recorded.
//
// The samples are companyOsContractMinimisation.test.ts's: every turn kind,
// hidden reason and delivery state. Each case below takes one valid answer and
// breaks one rule, so a refinement that is deleted or loosened fails by name.
// What the live projection emits is companyOsContracts.dbtest.ts's subject.
// It lives in engine/domain because it runs in the `functions` project, with
// the other contract unit tests.

import { describe, expect, it } from "vitest";
import * as contracts from "../../contracts/company-os-api/index.ts";
import { CONVERSATION_AVAILABLE } from "./testSupport/companyOsContractSamples.ts";

const {
  ConversationSchema,
  ReleaseConversationInputSchema,
  ReleaseConversationResultSchema,
  ReplyTextSchema,
  ReplyToConversationInputSchema,
  ReplyToConversationResultSchema,
} = contracts;

type Turn = Record<string, unknown>;

const AT = "2026-09-22T12:30:00.000000Z";
const TASK = "00000000-0000-4000-8000-00000000abcd";
const ENVELOPE = { v: 1, asOf: AT } as const;

const parses =
  (schema: { safeParse(v: unknown): { success: boolean } }) =>
  (value: unknown): boolean =>
    schema.safeParse(value).success;
const conversationParses = parses(ConversationSchema);
const replyResultParses = parses(ReplyToConversationResultSchema);
const releaseResultParses = parses(ReleaseConversationResultSchema);

/** The available sample with `patch` applied at its top level. */
const conversation = (patch: Record<string, unknown> = {}) => ({
  ...structuredClone(CONVERSATION_AVAILABLE),
  ...patch,
});

/** The available sample holding exactly `turns`. */
const withTurns = (turns: readonly Turn[]) => conversation({ turns });

const turnsOf = (kind: string): Turn[] =>
  (CONVERSATION_AVAILABLE.turns as Turn[]).filter((t) => t.kind === kind);
const INBOUND = turnsOf("inbound").find((t) => t.text !== null) as Turn;
const PERSON_SENT = turnsOf("reply").find(
  (t) => t.author === "person" && t.delivery === "sent",
) as Turn;

// Characters built from their code points: the source holds no escape a tool
// could decode, and no raw control character.
const char = (code: number): string => String.fromCodePoint(code);
const ASTRAL = char(0x1f600);

describe("the conversation's own sample", () => {
  it("parses, every turn kind, hidden reason and delivery state included", () => {
    const parsed = ConversationSchema.safeParse(CONVERSATION_AVAILABLE);
    expect(parsed.error?.issues ?? []).toEqual([]);
    const turns = CONVERSATION_AVAILABLE.turns as Turn[];
    expect(new Set(turns.map((t) => t.kind))).toEqual(
      new Set(["inbound", "refused", "reply"]),
    );
    expect(new Set(turns.flatMap((t) => (t.hidden ? [t.hidden] : [])))).toEqual(
      new Set(contracts.TURN_HIDDEN_REASONS),
    );
    expect(
      new Set(turns.flatMap((t) => (t.delivery ? [t.delivery] : []))),
    ).toEqual(new Set(contracts.REPLY_DELIVERY_STATES));
    expect(new Set(turns.flatMap((t) => (t.author ? [t.author] : [])))).toEqual(
      new Set(contracts.REVIEW_AUTHORS),
    );
  });
});

describe("a turn shows its text or says why not", () => {
  it.each([
    ["an inbound message", INBOUND],
    ["a reply", PERSON_SENT],
  ])(
    "refuses %s with both a text and a hidden reason, or neither",
    (_l, turn) => {
      expect(conversationParses(withTurns([turn]))).toBe(true);
      for (const hidden of contracts.TURN_HIDDEN_REASONS) {
        expect(
          conversationParses(withTurns([{ ...turn, hidden }])),
          hidden,
        ).toBe(false);
        expect(
          conversationParses(withTurns([{ ...turn, text: null, hidden }])),
          hidden,
        ).toBe(true);
      }
      expect(conversationParses(withTurns([{ ...turn, text: null }]))).toBe(
        false,
      );
    },
  );

  it("bounds an inbound text at 4000 code points and a reply at 2000, never empty", () => {
    const at = (turn: Turn, text: string) =>
      conversationParses(withTurns([{ ...turn, text }]));
    expect(at(INBOUND, ASTRAL.repeat(4000))).toBe(true);
    expect(at(INBOUND, "x".repeat(4001))).toBe(false);
    expect(at(PERSON_SENT, ASTRAL.repeat(2000))).toBe(true);
    expect(at(PERSON_SENT, "x".repeat(2001))).toBe(false);
    expect(at(INBOUND, "")).toBe(false);
    expect(at(PERSON_SENT, "")).toBe(false);
  });

  it("names a refused message by its reason code alone", () => {
    const refused = turnsOf("refused")[0];
    expect(conversationParses(withTurns([refused]))).toBe(true);
    expect(
      conversationParses(
        withTurns([{ ...refused, reason: "Image, not text" }]),
      ),
    ).toBe(false);
    expect(
      conversationParses(withTurns([{ ...refused, text: "a caption" }])),
    ).toBe(false);
  });
});

describe("a reply turn's refinements", () => {
  it("names a fixed text's key only on a fixed text", () => {
    for (const author of ["person", "agent"]) {
      expect(
        conversationParses(
          withTurns([{ ...PERSON_SENT, author, fixedKey: "safety" }]),
        ),
        author,
      ).toBe(false);
    }
    expect(
      conversationParses(
        withTurns([{ ...PERSON_SENT, author: "fixed", fixedKey: "safety" }]),
      ),
    ).toBe(true);
  });

  it("calls only a fixed text automatic", () => {
    for (const author of ["person", "agent"]) {
      expect(
        conversationParses(
          withTurns([{ ...PERSON_SENT, author, automatic: true }]),
        ),
        author,
      ).toBe(false);
    }
    expect(
      conversationParses(
        withTurns([
          {
            ...PERSON_SENT,
            author: "fixed",
            fixedKey: "human_handoff_ack",
            automatic: true,
          },
        ]),
      ),
    ).toBe(true);
  });

  it("gives a reason only to a send that did not leave cleanly", () => {
    for (const delivery of contracts.REPLY_DELIVERY_STATES) {
      const shown = (reason: string | null) =>
        conversationParses(withTurns([{ ...PERSON_SENT, delivery, reason }]));
      const notClean = ["failed", "blocked", "uncertain"].includes(delivery);
      expect(shown("outside_service_window"), delivery).toBe(notClean);
      // An uncertain or failed send may have no class recorded.
      expect(shown(null), delivery).toBe(true);
    }
    expect(
      conversationParses(
        withTurns([
          { ...PERSON_SENT, delivery: "blocked", reason: "Blocked!" },
        ]),
      ),
    ).toBe(false);
  });

  it("refuses an unknown author, key or delivery state, and any extra key", () => {
    for (const patch of [
      { author: "operator" },
      { fixedKey: "greeting", author: "fixed" },
      { delivery: "approved" },
      { delivery: "authorized" },
      { reviewer: "principal:" + TASK },
      { requestedBy: "principal:" + TASK },
      { draft: "an unsent draft" },
    ]) {
      expect(
        conversationParses(withTurns([{ ...PERSON_SENT, ...patch }])),
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe("the acts the server allows on an available conversation", () => {
  it("allows a reply exactly when nothing makes it unavailable", () => {
    expect(
      conversationParses(conversation({ replyUnavailable: "reply_limit" })),
    ).toBe(false);
    for (const reason of contracts.REPLY_UNAVAILABLE_REASONS) {
      const allowedActs = { reply: false, release: true };
      const patch = { allowedActs, replyUnavailable: reason };
      // An open opt-out also takes the release away, and a holder other than
      // a person takes both.
      const consistent =
        reason === "opt_out_open"
          ? {
              ...patch,
              optOutOpen: true,
              allowedActs: { ...allowedActs, release: false },
            }
          : reason === "not_held"
            ? {
                ...patch,
                holder: "agent",
                allowedActs: { reply: false, release: false },
              }
            : patch;
      expect(conversationParses(conversation(consistent)), reason).toBe(true);
      expect(
        conversationParses(
          conversation({ ...consistent, replyUnavailable: null }),
        ),
        `${reason} without its reason`,
      ).toBe(false);
    }
    expect(conversationParses(conversation({ replyUnavailable: "busy" }))).toBe(
      false,
    );
  });

  it("acts only on a conversation a person holds, without an open opt-out", () => {
    expect(conversationParses(conversation({ holder: "agent" }))).toBe(false);
    expect(conversationParses(conversation({ optOutOpen: true }))).toBe(false);
    // A reply allowed with no reason against it, the release consistent: only
    // the holder or the opt-out refuses it.
    for (const patch of [{ holder: "agent" }, { optOutOpen: true }]) {
      expect(
        conversationParses(
          conversation({
            ...patch,
            allowedActs: { reply: true, release: false },
          }),
        ),
        JSON.stringify(patch),
      ).toBe(false);
    }
    // The release follows the holder and the opt-out exactly, both ways.
    expect(
      conversationParses(
        conversation({
          holder: "agent",
          allowedActs: { reply: false, release: true },
          replyUnavailable: "not_held",
        }),
      ),
    ).toBe(false);
    expect(
      conversationParses(
        conversation({
          allowedActs: { reply: true, release: false },
        }),
      ),
    ).toBe(false);
    expect(
      conversationParses(
        conversation({
          optOutOpen: true,
          allowedActs: { reply: false, release: true },
          replyUnavailable: "opt_out_open",
        }),
      ),
    ).toBe(false);
  });

  it("refuses an act hint the inbox does not have", () => {
    expect(
      conversationParses(
        conversation({
          allowedActs: { reply: true, release: true, takeOver: false },
        }),
      ),
    ).toBe(false);
  });
});

describe("the turns shown", () => {
  const inbound = (n: number): Turn => ({
    ...INBOUND,
    text: `Synthetic message ${n}`,
  });
  const page = (n: number) => Array.from({ length: n }, (_, i) => inbound(i));

  it("says earlier turns exist only behind a full page of 50", () => {
    expect(conversationParses(withTurns(page(50)))).toBe(true);
    expect(
      conversationParses(conversation({ turns: page(50), earlierTurns: true })),
    ).toBe(true);
    expect(
      conversationParses(conversation({ turns: page(49), earlierTurns: true })),
    ).toBe(false);
    expect(conversationParses(withTurns(page(51)))).toBe(false);
  });
});

describe("the conversation's other states carry nothing of it", () => {
  it("answers withheld with its reason alone, and not_waiting with nothing", () => {
    for (const reason of contracts.CONVERSATION_WITHHELD_REASONS) {
      expect(
        conversationParses({ ...ENVELOPE, status: "withheld", reason }),
      ).toBe(true);
    }
    expect(conversationParses({ ...ENVELOPE, status: "not_waiting" })).toBe(
      true,
    );
    for (const extra of [
      { revision: 3 },
      { turns: [] },
      { holder: "person" },
      { firstName: "Ana" },
    ]) {
      expect(
        conversationParses({
          ...ENVELOPE,
          status: "withheld",
          reason: "not_test",
          ...extra,
        }),
        JSON.stringify(extra),
      ).toBe(false);
      expect(
        conversationParses({ ...ENVELOPE, status: "not_waiting", ...extra }),
        JSON.stringify(extra),
      ).toBe(false);
    }
    expect(
      conversationParses({ ...ENVELOPE, status: "withheld", reason: "health" }),
    ).toBe(false);
  });

  it("bounds the first name at 40 code points, never empty", () => {
    expect(
      conversationParses(conversation({ firstName: ASTRAL.repeat(40) })),
    ).toBe(true);
    expect(
      conversationParses(conversation({ firstName: "x".repeat(41) })),
    ).toBe(false);
    expect(conversationParses(conversation({ firstName: "" }))).toBe(false);
  });
});

describe("a person's reply text (ReplyTextSchema)", () => {
  const accepts = parses(ReplyTextSchema);

  it("takes 1 to 2000 code points, astral characters counted as one", () => {
    expect(accepts(ASTRAL.repeat(2000))).toBe(true);
    expect(accepts(ASTRAL.repeat(2001))).toBe(false);
    expect(accepts("x".repeat(2000))).toBe(true);
    expect(accepts("x".repeat(2001))).toBe(false);
    expect(accepts("Oi")).toBe(true);
  });

  it("keeps a line break, and refuses every other control character", () => {
    expect(accepts(`Oi${char(0x0a)}Tudo bem?`)).toBe(true);
    expect(accepts(`Oi${char(0xa0)}tudo bem`)).toBe(true);
    for (const code of [
      0x00, 0x01, 0x09, 0x0b, 0x0c, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9f,
    ]) {
      expect(accepts(`Oi${char(code)}tudo bem`), `U+${code.toString(16)}`).toBe(
        false,
      );
    }
  });

  it("refuses a blank or empty reply", () => {
    for (const blank of ["", " ", "   ", char(0x0a), ` ${char(0x0a)} `]) {
      expect(accepts(blank), JSON.stringify(blank)).toBe(false);
    }
  });
});

describe("the acts' inputs", () => {
  const reply = { p_task_id: TASK, p_text: "Oi", p_expected_revision: 3 };
  const release = { p_task_id: TASK, p_expected_revision: 3 };

  it("name a task, the revision the member saw and, for a reply, its text; nothing else", () => {
    expect(parses(ReplyToConversationInputSchema)(reply)).toBe(true);
    expect(parses(ReleaseConversationInputSchema)(release)).toBe(true);
    for (const extra of [
      "p_tenant_id",
      "p_actor",
      "p_conversation_id",
      "p_review_id",
      "p_draft",
    ]) {
      expect(
        parses(ReplyToConversationInputSchema)({ ...reply, [extra]: TASK }),
        extra,
      ).toBe(false);
      expect(
        parses(ReleaseConversationInputSchema)({ ...release, [extra]: TASK }),
        extra,
      ).toBe(false);
    }
    expect(
      parses(ReleaseConversationInputSchema)({ ...release, p_text: "Oi" }),
    ).toBe(false);
  });

  it("refuses a revision the database cannot hold, a malformed task and a reply the act refuses", () => {
    for (const revision of [-1, 1.5, 2_147_483_648, "3", null]) {
      expect(
        parses(ReplyToConversationInputSchema)({
          ...reply,
          p_expected_revision: revision,
        }),
        String(revision),
      ).toBe(false);
      expect(
        parses(ReleaseConversationInputSchema)({
          ...release,
          p_expected_revision: revision,
        }),
        String(revision),
      ).toBe(false);
    }
    expect(
      parses(ReplyToConversationInputSchema)({
        ...reply,
        p_expected_revision: 2_147_483_647,
      }),
    ).toBe(true);
    expect(
      parses(ReplyToConversationInputSchema)({
        ...reply,
        p_task_id: TASK.toUpperCase(),
      }),
    ).toBe(false);
    for (const text of ["", "   ", `a${char(0x09)}b`, "x".repeat(2001)]) {
      expect(
        parses(ReplyToConversationInputSchema)({ ...reply, p_text: text }),
        JSON.stringify(text.slice(0, 8)),
      ).toBe(false);
    }
  });
});

describe("the reply act's answer", () => {
  const answer = (
    outcome: string,
    revision: number | null,
    reason: string | null = null,
  ) => ({ ...ENVELOPE, outcome, revision, reason });

  it("names the revision for every outcome but a missing factor or a withheld conversation", () => {
    for (const outcome of contracts.REPLY_OUTCOMES) {
      const reason = outcome === "not_sendable" ? "opt_out_open" : null;
      const hidden =
        outcome === "second_factor_required" || outcome === "withheld";
      expect(replyResultParses(answer(outcome, 4, reason)), outcome).toBe(
        !hidden,
      );
      expect(replyResultParses(answer(outcome, null, reason)), outcome).toBe(
        hidden,
      );
    }
  });

  it("names the revision of a reply already recorded, and writes nothing new", () => {
    expect(contracts.REPLY_OUTCOMES).toContain("already_recorded");
    expect(replyResultParses(answer("already_recorded", 4))).toBe(true);
    expect(replyResultParses(answer("already_recorded", null))).toBe(false);
    expect(
      replyResultParses(answer("already_recorded", 4, "opt_out_open")),
    ).toBe(false);
  });

  it("names a reason exactly when the send's gates refuse it", () => {
    expect(replyResultParses(answer("not_sendable", 4, "opt_out_open"))).toBe(
      true,
    );
    expect(replyResultParses(answer("not_sendable", 4))).toBe(false);
    for (const outcome of contracts.REPLY_OUTCOMES.filter(
      (o) => o !== "not_sendable",
    )) {
      const revision =
        outcome === "second_factor_required" || outcome === "withheld"
          ? null
          : 4;
      expect(
        replyResultParses(answer(outcome, revision, "opt_out_open")),
        outcome,
      ).toBe(false);
    }
    expect(replyResultParses(answer("not_sendable", 4, "Not sendable"))).toBe(
      false,
    );
  });

  it("answers no access change, conflict or retry as an outcome", () => {
    for (const outcome of ["conflict", "not_allowed", "busy", "sent"]) {
      expect(replyResultParses(answer(outcome, 4)), outcome).toBe(false);
    }
    expect(replyResultParses({ ...answer("queued", 4), reviewId: TASK })).toBe(
      false,
    );
  });
});

describe("the release act's answer", () => {
  const answer = (outcome: string, revision: number | null) => ({
    ...ENVELOPE,
    outcome,
    revision,
  });

  it("hides the revision only for a withheld conversation", () => {
    for (const outcome of contracts.RELEASE_OUTCOMES) {
      const hidden = outcome === "withheld";
      expect(releaseResultParses(answer(outcome, 4)), outcome).toBe(!hidden);
      expect(releaseResultParses(answer(outcome, null)), outcome).toBe(hidden);
    }
  });

  it("knows no outcome the release cannot reach, and carries no reason", () => {
    for (const outcome of ["queued", "second_factor_required", "not_held"]) {
      expect(releaseResultParses(answer(outcome, 4)), outcome).toBe(false);
    }
    expect(
      releaseResultParses({ ...answer("released", 4), reason: null }),
    ).toBe(false);
  });
});
