import type { RenderResult } from "vitest-browser-react";

import { ok, refused } from "../../testing/fakeSession";
import { renderCompanyOs } from "../../testing/renderCompanyOs";
import {
  CHANGED_WHILE_OPEN,
  NO_FACTOR,
  REPLY_OUTCOME_TEXT,
  STEP_UP_DONE,
  STEP_UP_SIGN_OUT,
  STEP_UP_TEXT,
  STEP_UP_UNAVAILABLE,
} from "./inboxCopy";
import {
  CONVERSATION_HASH,
  WAITING,
  WAITING_FIRST,
  createFakeMfa,
  createInboxSession,
  inboundTurn,
  personReplyTurn,
  recordedConversation,
  replyAnswer,
  type InboxSession,
} from "./inboxTesting";

// ADR 0026 §E, SI-87: the member's own reply. Written by the member (nothing
// prefilled), asked for, confirmed (the safe choice focused), sent as one act
// per confirmation and never retried; refused with the server's reason; a
// missing recent second factor asks for the authenticator code here, and the
// member confirms the send again. The text survives a failed read.

const TEXT = "Resposta sintética: temos horário às 16h.";
const CODE = "654321";

const replyGroup = (screen: RenderResult) =>
  screen.getByRole("group", { name: "Responder ao contato" });

const open = async (session: InboxSession) => {
  const screen = await renderCompanyOs(session, CONVERSATION_HASH);
  await expect.element(screen.getByText("Ana-Maria")).toBeVisible();
  return screen;
};

const write = async (screen: RenderResult, text = TEXT) => {
  await replyGroup(screen).getByLabelText("Sua resposta").fill(text);
};

/** Asks for the reply and confirms it. */
const send = async (screen: RenderResult) => {
  await screen.getByRole("button", { name: "Enviar resposta" }).click();
  await screen.getByRole("button", { name: "Enviar", exact: true }).click();
};

const replies = (session: InboxSession) =>
  session.callsOf("reply_to_conversation");

describe("the inbox's reply", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("counts code points, refuses past 2000 and blank text, and asks for nothing until a confirmation", async () => {
    const session = createInboxSession();
    const screen = await open(session);
    const button = screen.getByRole("button", { name: "Enviar resposta" });
    await expect.element(button).toBeDisabled();

    await write(screen, "😀".repeat(2000));
    await expect
      .element(screen.getByText("2.000 de 2.000 caracteres"))
      .toBeVisible();
    await expect.element(button).toBeEnabled();
    await write(screen, "😀".repeat(2001));
    await expect.element(button).toBeDisabled();
    await write(screen, "   \n ");
    await expect.element(button).toBeDisabled();

    await write(screen);
    await button.click();
    const dialog = screen.getByRole("alertdialog", {
      name: "Enviar esta resposta ao contato?",
    });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(dialog.getByRole("button", { name: "Cancelar" }))
      .toHaveFocus();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    expect(replies(session)).toEqual([]);
  });

  it("sends the member's own text once, at the revision shown, then clears it and reads the conversation again", async () => {
    const session = createInboxSession();
    session.answer("reply_to_conversation", () => {
      const base = recordedConversation();
      session.show({ ...base, turns: [...base.turns, personReplyTurn(TEXT)] });
      return ok(replyAnswer("queued"));
    });
    const screen = await open(session);
    const readsBefore = session.callsOf("get_conversation").length;

    await write(screen);
    await send(screen);

    await expect
      .element(replyGroup(screen).getByText(REPLY_OUTCOME_TEXT.queued))
      .toBeVisible();
    expect(replies(session)).toEqual([
      {
        operation: "reply_to_conversation",
        args: {
          p_task_id: WAITING,
          p_text: TEXT,
          p_expected_revision: recordedConversation().revision,
        },
      },
    ]);
    await expect
      .element(replyGroup(screen).getByLabelText("Sua resposta"))
      .toHaveValue("");
    await expect.element(screen.getByText(TEXT)).toBeVisible();
    expect(session.callsOf("get_conversation").length).toBeGreaterThan(
      readsBefore,
    );
  });

  it("makes one act for two clicks on the confirmation", async () => {
    const session = createInboxSession();
    let answer: () => void = () => {};
    session.answer(
      "reply_to_conversation",
      () =>
        new Promise((resolve) => {
          answer = () => resolve(ok(replyAnswer("queued")));
        }),
    );
    const screen = await open(session);
    await write(screen);
    await screen.getByRole("button", { name: "Enviar resposta" }).click();
    const confirm = screen
      .getByRole("button", { name: "Enviar", exact: true })
      .element() as HTMLButtonElement;

    confirm.click();
    confirm.click();
    await expect.poll(() => replies(session).length).toBe(1);
    answer();
    await expect
      .element(screen.getByText(REPLY_OUTCOME_TEXT.queued))
      .toBeVisible();
    expect(replies(session)).toHaveLength(1);
  });

  it("cannot be confirmed once the contact wrote again, and a stale answer keeps the text", async () => {
    const session = createInboxSession();
    session.answer("reply_to_conversation", () => ok(replyAnswer("stale")));
    const screen = await open(session);
    await write(screen);
    await screen.getByRole("button", { name: "Enviar resposta" }).click();

    const base = recordedConversation();
    session.show({
      ...base,
      revision: base.revision + 1,
      turns: [...base.turns, inboundTurn("Mensagem sintética nova.")],
    });
    window.dispatchEvent(new Event("visibilitychange"));
    await expect.element(screen.getByText(CHANGED_WHILE_OPEN)).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Enviar", exact: true }))
      .toBeDisabled();
    await screen.getByRole("button", { name: "Cancelar" }).click();
    expect(replies(session)).toEqual([]);

    // The server's own answer: the conversation moved under the member.
    session.show(base);
    window.dispatchEvent(new Event("visibilitychange"));
    await expect
      .element(screen.getByRole("button", { name: "Enviar resposta" }))
      .toBeEnabled();
    await send(screen);
    await expect
      .element(screen.getByText(REPLY_OUTCOME_TEXT.stale))
      .toBeVisible();
    await expect
      .element(replyGroup(screen).getByLabelText("Sua resposta"))
      .toHaveValue(TEXT);
  });

  it("asks for the authenticator code when the factor is not recent, then needs a second confirmation to send", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: false, factorId: "factor-synthetic" },
      CODE,
    );
    const session = createInboxSession({ mfa: mfa.port });
    const answers = [
      replyAnswer("second_factor_required"),
      replyAnswer("queued"),
    ];
    session.answer("reply_to_conversation", () => ok(answers.shift()));
    const screen = await open(session);
    await write(screen);
    await send(screen);

    await expect.element(screen.getByText(STEP_UP_TEXT)).toBeVisible();
    await replyGroup(screen).getByLabelText("Código de 6 dígitos").fill(CODE);
    await replyGroup(screen).getByRole("button", { name: "Verificar" }).click();
    await expect.element(screen.getByText(STEP_UP_DONE)).toBeVisible();
    expect(mfa.verified).toEqual([`factor-synthetic:${CODE}`]);
    // The code alone sends nothing.
    expect(replies(session)).toHaveLength(1);
    await expect
      .element(replyGroup(screen).getByLabelText("Sua resposta"))
      .toHaveValue(TEXT);

    await send(screen);
    await expect
      .element(screen.getByText(REPLY_OUTCOME_TEXT.queued))
      .toBeVisible();
    expect(replies(session)).toHaveLength(2);
  });

  it("asks to sign in again when the server still asks after an accepted code, and says when there is no factor", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: false, factorId: "factor-synthetic" },
      CODE,
    );
    const session = createInboxSession({ mfa: mfa.port });
    session.answer("reply_to_conversation", () =>
      ok(replyAnswer("second_factor_required")),
    );
    const screen = await open(session);
    await write(screen);
    await send(screen);
    await replyGroup(screen).getByLabelText("Código de 6 dígitos").fill(CODE);
    await replyGroup(screen).getByRole("button", { name: "Verificar" }).click();
    await expect.element(screen.getByText(STEP_UP_DONE)).toBeVisible();

    await send(screen);
    await expect.element(screen.getByText(STEP_UP_SIGN_OUT)).toBeVisible();
    expect(
      replyGroup(screen).getByLabelText("Código de 6 dígitos").elements(),
    ).toHaveLength(0);
    expect(replies(session)).toHaveLength(2);
    await screen.unmount();

    const none = createFakeMfa(
      { needsSecondFactor: false, factorId: null },
      CODE,
    );
    const without = createInboxSession({ mfa: none.port });
    without.answer("reply_to_conversation", () =>
      ok(replyAnswer("second_factor_required")),
    );
    const other = await open(without);
    await write(other);
    await send(other);
    await expect.element(other.getByText(NO_FACTOR)).toBeVisible();
  });

  it("tells a provider that could not be asked from an account with no factor, and asks again on request", async () => {
    const mfa = createFakeMfa(
      { needsSecondFactor: false, factorId: "factor-synthetic" },
      CODE,
      1,
    );
    const session = createInboxSession({ mfa: mfa.port });
    session.answer("reply_to_conversation", () =>
      ok(replyAnswer("second_factor_required")),
    );
    const screen = await open(session);
    await write(screen);
    await send(screen);

    await expect.element(screen.getByText(STEP_UP_UNAVAILABLE)).toBeVisible();
    expect(screen.getByText(NO_FACTOR).elements()).toHaveLength(0);
    await replyGroup(screen)
      .getByRole("button", { name: "Tentar de novo" })
      .click();
    await expect
      .element(replyGroup(screen).getByLabelText("Código de 6 dígitos"))
      .toBeVisible();
  });

  it("gives the focus back to the button when the confirmation is cancelled", async () => {
    const session = createInboxSession();
    const screen = await open(session);
    await write(screen);
    await screen.getByRole("button", { name: "Enviar resposta" }).click();
    await screen.getByRole("button", { name: "Cancelar" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Enviar resposta" }))
      .toHaveFocus();
    expect(replies(session)).toHaveLength(0);
  });

  it("tells each refusal apart: the gates' reason, a busy conversation, no access (OS409 included) and a lost answer", async () => {
    const session = createInboxSession();
    const screen = await open(session);
    const outcome = async (text: string) => {
      await write(screen);
      await send(screen);
      await expect.element(replyGroup(screen).getByText(text)).toBeVisible();
    };

    session.answer("reply_to_conversation", () =>
      ok(replyAnswer("not_sendable", "contact_ambiguous")),
    );
    await outcome(
      "Esta resposta não pode sair agora: mais de um contato do CRM tem este número. Nada foi enviado.",
    );
    session.answer("reply_to_conversation", () => refused("OS429"));
    await outcome(REPLY_OUTCOME_TEXT.busy);
    for (const code of ["OS401", "OS403", "OS409"]) {
      const reads = session.callsOf("get_conversation").length;
      session.answer("reply_to_conversation", () => refused(code));
      await outcome(REPLY_OUTCOME_TEXT.not_allowed);
      await expect
        .poll(() => session.callsOf("get_conversation").length)
        .toBeGreaterThan(reads);
    }
    // A lost answer: the conversation read again shows no such reply.
    session.answer("reply_to_conversation", () => refused("OS500"));
    await outcome(REPLY_OUTCOME_TEXT.unknown);
    // A lost answer whose reply was recorded: the read shows one more.
    session.answer("reply_to_conversation", () => {
      const base = recordedConversation();
      session.show({ ...base, turns: [...base.turns, personReplyTurn(TEXT)] });
      return refused("OS500");
    });
    await outcome(REPLY_OUTCOME_TEXT.recorded);
    // Never retried: one act per confirmation.
    expect(replies(session)).toHaveLength(7);
  });

  it("keeps the member's text through a failed read, and starts empty on another reference", async () => {
    const session = createInboxSession();
    const screen = await open(session);
    await write(screen);

    session.refuseReads("OS500");
    window.dispatchEvent(new Event("visibilitychange"));
    const retry = screen.getByRole("button", { name: "Tentar de novo" });
    await expect.element(retry).toBeVisible();
    session.show(recordedConversation());
    await retry.click();
    await expect
      .element(replyGroup(screen).getByLabelText("Sua resposta"))
      .toHaveValue(TEXT);

    window.location.hash = `#/company-os/inbox/${WAITING_FIRST}`;
    await expect
      .element(replyGroup(screen).getByLabelText("Sua resposta"))
      .toHaveValue("");
  });
});
