import type {
  AvailableConversation,
  ConversationTurn,
} from "../../../../contracts/company-os-api/index.ts";
import { STATE_UNKNOWN_NOTE, WAITING_LIST_EMPTY } from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { ok } from "../../testing/fakeSession";
import {
  overviewWithRecordedInbox,
  RECORDED_INBOX_AS_OF,
} from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";
import {
  CONVERSATION_NOT_WAITING,
  CONVERSATION_WITHHELD,
  HIDDEN_MARKER,
  INBOX_NOT_AVAILABLE,
  NO_FIRST_NAME,
  REPLY_UNAVAILABLE_TEXT,
} from "./inboxCopy";
import {
  CONVERSATION_HASH,
  RELEASED,
  WAITING,
  WITHHELD,
  createInboxSession,
  recordedConversation,
} from "./inboxTesting";

// ADR 0026 §E, SI-87: the Fila de atendimento lists who waits for a person
// (the overview's waiting list, no text, number or name) and opens one
// conversation on explicit open, as the real projection answered it at a
// fixed instant: the contact's own words where the server sent them, a
// refused message by its reason only, the replies with their delivery, and
// the acts the server allows now. Text is plain text, line breaks kept.

const at = (minutes: number) =>
  new Date(Date.parse(RECORDED_INBOX_AS_OF) + minutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, ".000000Z");

/** One turn of every kind the recording does not hold. */
const MORE_TURNS: readonly ConversationTurn[] = [
  { kind: "inbound", at: at(1), text: null, hidden: "erased" },
  { kind: "refused", at: at(2), reason: "body_too_long" },
  {
    kind: "reply",
    at: at(3),
    author: "agent",
    fixedKey: null,
    automatic: false,
    text: "Resposta da IA (sintética).",
    hidden: null,
    delivery: "read",
    reason: null,
    withPrivacyNotice: true,
  },
  {
    kind: "reply",
    at: at(4),
    author: "fixed",
    fixedKey: "safety",
    automatic: true,
    text: "Texto fixo de segurança (sintético).",
    hidden: null,
    delivery: "delivered",
    reason: null,
    withPrivacyNotice: false,
  },
  {
    kind: "reply",
    at: at(5),
    author: "person",
    fixedKey: null,
    automatic: false,
    text: "Resposta retida (sintética).",
    hidden: null,
    delivery: "held",
    reason: null,
    withPrivacyNotice: false,
  },
  {
    kind: "reply",
    at: at(6),
    author: "person",
    fixedKey: null,
    automatic: false,
    text: "Resposta bloqueada (sintética).",
    hidden: null,
    delivery: "blocked",
    reason: "contact_ambiguous",
    withPrivacyNotice: false,
  },
  {
    kind: "reply",
    at: at(7),
    author: "agent",
    fixedKey: null,
    automatic: false,
    text: "Resposta incerta (sintética).",
    hidden: null,
    delivery: "uncertain",
    reason: "timeout",
    withPrivacyNotice: false,
  },
];

const listItems = (screen: Awaited<ReturnType<typeof renderCompanyOs>>) =>
  screen
    .getByRole("list", { name: "Mensagens da conversa" })
    .getByRole("listitem")
    .elements()
    .map((item) => item.textContent ?? "");

describe("the Fila de atendimento", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("lists who waits for a person, each row opening its conversation, and reads no conversation until one is opened", async () => {
    const session = createInboxSession();
    const screen = await renderCompanyOs(session, "#/company-os/inbox");

    const row = screen.getByRole("link", {
      name: "Mensagem aguardando (1 mensagem)",
    });
    await expect.element(row).toHaveAttribute("href", CONVERSATION_HASH);
    expect(session.callsOf("get_conversation")).toEqual([]);

    await row.click();

    await expect
      .element(screen.getByRole("heading", { name: "Conversa", level: 1 }))
      .toBeVisible();
    await expect.element(screen.getByText("Ana-Maria")).toBeVisible();
    expect(session.callsOf("get_conversation")).toEqual([
      { operation: "get_conversation", args: { p_task_id: WAITING } },
    ]);
  });

  it("says when no one waits, and when the database does not carry the queue yet", async () => {
    const session = createInboxSession();
    session.answer("overview", () =>
      ok({
        ...overviewWithRecordedInbox(),
        waitingList: { total: 0, items: [] },
      }),
    );
    const empty = await renderCompanyOs(session, "#/company-os/inbox");
    await expect.element(empty.getByText(WAITING_LIST_EMPTY)).toBeVisible();
    await empty.unmount();

    const { waitingList: _absent, ...older } = overviewWithRecordedInbox();
    session.answer("overview", () => ok(older));
    const absent = await renderCompanyOs(session, "#/company-os/inbox");
    await expect.element(absent.getByText(INBOX_NOT_AVAILABLE)).toBeVisible();
  });

  it("shows the contact's first name, who holds the conversation, its window and its turns in order, as plain text", async () => {
    const screen = await renderCompanyOs(
      createInboxSession(),
      CONVERSATION_HASH,
    );

    await expect.element(screen.getByText("Ana-Maria")).toBeVisible();
    await expect
      .element(screen.getByText("Com uma pessoa da equipe"))
      .toBeVisible();
    await expect
      .element(screen.getByText(/^Janela de 24 h até \d{2}:\d{2}$/))
      .toBeVisible();
    expect(listItems(screen).map((text) => text.replace(/\s+/g, " "))).toEqual([
      expect.stringContaining(HIDDEN_MARKER.withheld),
      expect.stringContaining(
        "Oi, queria saber como funciona a primeira sessão.",
      ),
      expect.stringMatching(
        /^Pessoa da equipe.*Oi! A primeira sessão dura 50 minutos e é online\.Enviada$/,
      ),
      expect.stringContaining("Tem horário na quinta? Pode ser à tarde."),
      expect.stringContaining(
        "[mensagem não exibida: áudio, imagem ou outro formato]",
      ),
      expect.stringMatching(
        /^Pessoa da equipe.*Temos sim, às 15h\. Pode ser\?Na fila de envio$/,
      ),
    ]);
    // The contact's line break is kept, as text: never markup.
    const multiline = screen.getByText(
      "Tem horário na quinta?\nPode ser à tarde.",
    );
    await expect.element(multiline).toHaveClass("whitespace-pre-wrap");
    expect(multiline.element().childElementCount).toBe(0);
    expect(multiline.element().textContent).toBe(
      "Tem horário na quinta?\nPode ser à tarde.",
    );
    // No number or identifier of the conversation is on the page.
    expect(document.body.textContent).not.toMatch(/\d{6,}/);
    await expect
      .element(screen.getByRole("link", { name: "Ver a tarefa" }))
      .toHaveAttribute("href", `#/company-os/tasks/${WAITING}`);
  });

  it("labels every author, delivery, reason and marker a turn can carry", async () => {
    const session = createInboxSession();
    const base = recordedConversation();
    session.show({ ...base, turns: [...base.turns, ...MORE_TURNS] });
    const screen = await renderCompanyOs(session, CONVERSATION_HASH);

    await expect.element(screen.getByText(HIDDEN_MARKER.erased)).toBeVisible();
    const items = listItems(screen).slice(base.turns.length);
    expect(items).toEqual([
      expect.stringContaining(HIDDEN_MARKER.erased),
      expect.stringContaining("[mensagem não exibida: texto longo demais]"),
      expect.stringMatching(/^IA.*Lida · Com o aviso de privacidade\.$/),
      expect.stringMatching(
        /^Texto fixo publicado, automático: aviso de segurança \(CVV\).*Entregue$/,
      ),
      expect.stringMatching(/Retida por uma pausa$/),
      expect.stringMatching(
        /Não enviada: mais de um contato do CRM tem este número$/,
      ),
      expect.stringMatching(/Envio incerto: o WhatsApp não respondeu a tempo$/),
    ]);
  });

  it("says when earlier turns are not shown, and names a contact with no CRM first name", async () => {
    const session = createInboxSession();
    const base = recordedConversation();
    const turns = Array.from({ length: 50 }, (_, n) =>
      n < base.turns.length
        ? base.turns[n]
        : ({
            kind: "inbound",
            at: at(n),
            text: `Mensagem sintética ${n}`,
            hidden: null,
          } as const),
    );
    session.show({ ...base, firstName: null, earlierTurns: true, turns });
    const screen = await renderCompanyOs(session, CONVERSATION_HASH);

    await expect
      .element(screen.getByText("Mostrando as 50 mensagens mais recentes."))
      .toBeVisible();
    await expect.element(screen.getByText(NO_FIRST_NAME)).toBeVisible();
    expect(listItems(screen)).toHaveLength(50);
  });

  it("offers neither act once the answer is too old to be current, and keeps what the member wrote", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createInboxSession(),
      CONVERSATION_HASH,
      { clock: () => Date.now() + skew },
    );
    await expect
      .element(screen.getByRole("button", { name: "Enviar resposta" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Devolver à IA" }))
      .toBeVisible();
    await screen.getByLabelText("Sua resposta").fill("Texto sintético.");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    for (const name of ["Enviar resposta", "Devolver à IA"]) {
      expect(
        screen.getByRole("button", { name }).elements(),
        name,
      ).toHaveLength(0);
    }
    await expect
      .element(screen.getByLabelText("Sua resposta"))
      .toHaveValue("Texto sintético.");
  });

  it("shows a first name of up to 40 characters as given, and nothing of an answer whose name is longer", async () => {
    const session = createInboxSession();
    const base = recordedConversation();
    const forty = `Ana${"a".repeat(37)}`;
    session.show({ ...base, firstName: forty });
    const screen = await renderCompanyOs(session, CONVERSATION_HASH);
    await expect
      .element(screen.getByText(forty, { exact: true }))
      .toBeVisible();

    session.show({ ...base, firstName: `${forty}a` });
    window.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(
        screen.getByText(
          "A resposta não veio no formato esperado, por isso não é mostrada.",
        ),
      )
      .toBeVisible();
    expect(screen.getByText(`${forty}a`).elements()).toHaveLength(0);
    expect(screen.getByText(forty, { exact: true }).elements()).toHaveLength(0);
  });

  it("explains, by the server's own reason, why a reply cannot be asked for, and offers no field or button", async () => {
    const session = createInboxSession();
    const base = recordedConversation();
    const unavailable = (
      reason: keyof typeof REPLY_UNAVAILABLE_TEXT,
    ): AvailableConversation => {
      const optOutOpen = reason === "opt_out_open";
      const holder = reason === "not_held" ? "agent" : "person";
      return {
        ...base,
        holder,
        optOutOpen,
        windowEndsAt:
          reason === "window_closed" ? base.asOf : base.windowEndsAt,
        allowedActs: {
          reply: false,
          release: holder === "person" && !optOutOpen,
        },
        replyUnavailable: reason,
      };
    };
    session.show(unavailable("not_held"));
    const screen = await renderCompanyOs(session, CONVERSATION_HASH);
    const group = screen.getByRole("group", { name: "Responder ao contato" });

    for (const reason of Object.keys(
      REPLY_UNAVAILABLE_TEXT,
    ) as (keyof typeof REPLY_UNAVAILABLE_TEXT)[]) {
      session.show(unavailable(reason));
      window.dispatchEvent(new Event("visibilitychange"));
      await expect
        .element(group.getByText(REPLY_UNAVAILABLE_TEXT[reason]))
        .toBeVisible();
      expect(group.getByRole("textbox").elements(), reason).toHaveLength(0);
      expect(group.getByRole("button").elements(), reason).toHaveLength(0);
    }
    // Held by the agent: no release either.
    session.show(unavailable("not_held"));
    window.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(screen.getByText("Com a IA", { exact: true }))
      .toBeVisible();
    expect(
      screen.getByRole("button", { name: "Devolver à IA" }).elements(),
    ).toHaveLength(0);
  });

  it("shows a withheld or a closed conversation as a state, with the way back and the task", async () => {
    const withheld = await renderCompanyOs(
      createInboxSession(),
      `#/company-os/inbox/${WITHHELD}`,
    );
    await expect
      .element(withheld.getByText(CONVERSATION_WITHHELD.not_test))
      .toBeVisible();
    await expect
      .element(withheld.getByRole("link", { name: "Ver a tarefa" }))
      .toHaveAttribute("href", `#/company-os/tasks/${WITHHELD}`);
    expect(withheld.getByRole("textbox").elements()).toHaveLength(0);
    await withheld.unmount();

    const released = await renderCompanyOs(
      createInboxSession(),
      `#/company-os/inbox/${RELEASED}`,
    );
    await expect
      .element(released.getByText(CONVERSATION_NOT_WAITING))
      .toBeVisible();
    expect(
      released
        .getByRole("button")
        .elements()
        .map((b) => b.textContent),
    ).not.toContain("Enviar resposta");
  });

  it("answers an unknown or malformed reference as not found, and reads nothing for a malformed one", async () => {
    const session = createInboxSession();
    const screen = await renderCompanyOs(
      session,
      "#/company-os/inbox/not-a-uuid",
    );
    await expect.element(screen.getByText("Não encontrado.")).toBeVisible();
    expect(session.callsOf("get_conversation")).toEqual([]);

    window.location.hash = `#/company-os/inbox/${"0".repeat(8)}-0000-4000-8000-${"9".repeat(12)}`;
    await expect.element(screen.getByText("Não encontrado.")).toBeVisible();
  });
});
