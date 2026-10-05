import type { RenderResult } from "vitest-browser-react";

import {
  CONVERSATION_NEWER_MESSAGE,
  CONVERSATION_NO_SCREENING,
  CONVERSATION_NOTE,
  CONVERSATION_REDACTED,
  CONVERSATION_TITLE,
  CONVERSATION_UNAVAILABLE,
  SCREENING_NOTHING_READ,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// ADR 0023 §L: a review shows what the assistant read (the screened text,
// never the raw message) and the reply draft the send would carry, before the
// person decides, from the recorded projection and hand-built states. It offers
// no control, and accepting still sends nothing.

const reviewPage = (label: string) => `#/company-os/reviews/${rid(label)}`;

const region = (screen: RenderResult) =>
  screen.getByRole("region", { name: CONVERSATION_TITLE });

/** get_review for review:opened, as recorded, with its conversation replaced. */
const withConversation = (conversation: unknown) => {
  const session = createRecordedSession();
  session.answer("get_review", (args) =>
    ok(
      args.p_review_id === rid("review:opened")
        ? { ...recorded("get_review", args), conversation }
        : recorded("get_review", args),
    ),
  );
  return session;
};

const available = (overrides: Record<string, unknown>) => ({
  status: "available",
  screening: {
    messageClass: "mixed",
    disposition: "model",
    fixedMessageKey: null,
    screenedMessage: "[trecho omitido] tem horário na terça à noite?",
  },
  replyDraft: "Temos terça às 19h. Posso pedir para a equipe confirmar?",
  contentRedacted: false,
  newerMessage: false,
  ...overrides,
});

describe("the message and the reply on a review", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows the recorded draft before the decision, offers no control and never the stored message", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, reviewPage("review:opened"));

    const section = region(screen);
    await expect.element(section).toBeVisible();
    await expect.element(section).toHaveTextContent(CONVERSATION_NOTE);
    await expect
      .element(section)
      .toHaveTextContent(
        "Resposta que o envio levariaA synthetic reply about opening hours.",
      );
    // The recorded review has no front-desk screening: the raw text is not shown.
    await expect.element(section).toHaveTextContent(CONVERSATION_NO_SCREENING);
    expect(document.body.textContent).not.toContain("COS-SENTINEL-BODY");
    expect(section.getByRole("button").elements()).toHaveLength(0);
    await expect
      .element(
        screen
          .getByRole("group", { name: "Registrar decisão" })
          .getByRole("button", { name: "Rejeitar" }),
      )
      .toBeVisible();
    expect(session.callsOf("decide_review")).toEqual([]);
  });

  it("shows the screened text, its class and who wrote the reply", async () => {
    const screen = await renderCompanyOs(
      withConversation(available({})),
      reviewPage("review:opened"),
    );

    const section = region(screen);
    for (const text of [
      "Mensagem que o assistente leu[trecho omitido] tem horário na terça à noite?",
      "ClassificaçãoMista: uma parte foi omitida",
      "Quem respondeuO modelo de IA escreveu a resposta",
      "Resposta que o envio levariaTemos terça às 19h. Posso pedir para a equipe confirmar?",
    ]) {
      await expect.element(section).toHaveTextContent(text);
    }
    expect(section.getByRole("alert").elements()).toHaveLength(0);
  });

  it("says why nothing was read, and names the fixed text that answers", async () => {
    const screen = await renderCompanyOs(
      withConversation(
        available({
          screening: {
            messageClass: "sensitive_only",
            disposition: "fixed_reply",
            fixedMessageKey: "sensitive_only_prospect",
            screenedMessage: null,
          },
          replyDraft: "Isso a gente conversa na primeira sessão.",
        }),
      ),
      reviewPage("review:opened"),
    );

    const section = region(screen);
    await expect
      .element(section)
      .toHaveTextContent(SCREENING_NOTHING_READ.sensitive_only);
    await expect
      .element(section)
      .toHaveTextContent("Quem respondeuTexto fixo: Assunto sensível (lead)");
  });

  it("warns that a newer message makes this reply stale", async () => {
    const screen = await renderCompanyOs(
      withConversation(available({ newerMessage: true })),
      reviewPage("review:opened"),
    );

    await expect
      .element(region(screen).getByRole("alert"))
      .toHaveTextContent(CONVERSATION_NEWER_MESSAGE);
  });

  it("shows nothing of a redacted review, and nothing outside synthetic or test data", async () => {
    const redacted = await renderCompanyOs(
      withConversation(
        available({
          screening: {
            messageClass: "mixed",
            disposition: "model",
            fixedMessageKey: null,
            screenedMessage: null,
          },
          replyDraft: null,
          contentRedacted: true,
        }),
      ),
      reviewPage("review:opened"),
    );
    await expect
      .element(region(redacted))
      .toHaveTextContent(
        `Resposta que o envio levaria${CONVERSATION_REDACTED}`,
      );
    redacted.unmount();

    const unavailable = await renderCompanyOs(
      withConversation({ status: "unavailable" }),
      reviewPage("review:opened"),
    );
    const section = region(unavailable);
    await expect.element(section).toHaveTextContent(CONVERSATION_UNAVAILABLE);
    expect(section.element().textContent).not.toContain(
      "A synthetic reply about opening hours.",
    );
  });
});
