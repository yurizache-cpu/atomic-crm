import type { RenderResult } from "vitest-browser-react";

import { ok, refused } from "../../testing/fakeSession";
import { renderCompanyOs } from "../../testing/renderCompanyOs";
import {
  CONVERSATION_NOT_WAITING,
  OPT_OUT_OPEN_RELEASE,
  RELEASE_CHANGED_WHILE_OPEN,
  RELEASE_OUTCOME_TEXT,
} from "./inboxCopy";
import {
  CONVERSATION_HASH,
  WAITING,
  createInboxSession,
  inboundTurn,
  recordedConversation,
  releaseAnswer,
  type InboxSession,
} from "./inboxTesting";

// ADR 0026 §E, SI-87: the release gives the conversation back to the agent,
// behind a confirmation (the safe choice focused) at the revision shown; it
// sends nothing, is never offered while the contact's opt-out is open, is one
// act per confirmation, and its answer stays on the page when the
// conversation leaves the queue.

const open = async (session: InboxSession) => {
  const screen = await renderCompanyOs(session, CONVERSATION_HASH);
  await expect.element(screen.getByText("Ana-Maria")).toBeVisible();
  return screen;
};

const release = async (screen: RenderResult) => {
  await screen.getByRole("button", { name: "Devolver à IA" }).click();
  await screen.getByRole("button", { name: "Devolver", exact: true }).click();
};

const releases = (session: InboxSession) =>
  session.callsOf("release_conversation");

describe("the inbox's release", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("asks for a confirmation whose safe choice has the focus, and does nothing on Cancelar", async () => {
    const session = createInboxSession();
    const screen = await open(session);

    await screen.getByRole("button", { name: "Devolver à IA" }).click();
    const dialog = screen.getByRole("alertdialog", {
      name: "Devolver esta conversa à IA?",
    });
    await expect
      .element(dialog.getByRole("button", { name: "Cancelar" }))
      .toHaveFocus();
    await expect
      .element(dialog.getByText(/Respostas suas já na fila ainda saem\.$/))
      .toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();

    expect(releases(session)).toEqual([]);
  });

  it("releases once, at the revision shown, and keeps its answer when the conversation leaves the queue", async () => {
    const session = createInboxSession();
    session.answer("release_conversation", () => {
      session.show({
        v: 1,
        asOf: recordedConversation().asOf,
        status: "not_waiting",
      });
      return ok(releaseAnswer("released"));
    });
    const screen = await open(session);

    await release(screen);

    await expect
      .element(screen.getByText(CONVERSATION_NOT_WAITING))
      .toBeVisible();
    await expect
      .element(screen.getByText(RELEASE_OUTCOME_TEXT.released))
      .toBeVisible();
    expect(releases(session)).toEqual([
      {
        operation: "release_conversation",
        args: {
          p_task_id: WAITING,
          p_expected_revision: recordedConversation().revision,
        },
      },
    ]);
  });

  it("cannot be confirmed once the contact wrote again", async () => {
    const session = createInboxSession();
    const screen = await open(session);
    await screen.getByRole("button", { name: "Devolver à IA" }).click();

    const base = recordedConversation();
    session.show({
      ...base,
      revision: base.revision + 1,
      turns: [...base.turns, inboundTurn("Mensagem sintética nova.")],
    });
    window.dispatchEvent(new Event("visibilitychange"));

    await expect
      .element(screen.getByText(RELEASE_CHANGED_WHILE_OPEN))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Devolver", exact: true }))
      .toBeDisabled();
    expect(releases(session)).toEqual([]);
  });

  it("is not offered while the contact's opt-out is open", async () => {
    const session = createInboxSession();
    const base = recordedConversation();
    session.show({
      ...base,
      optOutOpen: true,
      allowedActs: { reply: false, release: false },
      replyUnavailable: "opt_out_open",
    });
    const screen = await open(session);

    await expect.element(screen.getByText(OPT_OUT_OPEN_RELEASE)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Devolver à IA" }).elements(),
    ).toHaveLength(0);
  });

  it("tells each answer apart, and never asks twice for one confirmation", async () => {
    const session = createInboxSession();
    const screen = await open(session);
    const cases: readonly (readonly [() => unknown, string])[] = [
      [() => ok(releaseAnswer("stale")), RELEASE_OUTCOME_TEXT.stale],
      [
        () => ok(releaseAnswer("opt_out_open")),
        RELEASE_OUTCOME_TEXT.opt_out_open,
      ],
      [() => refused("OS429"), RELEASE_OUTCOME_TEXT.busy],
      [() => refused("OS409"), RELEASE_OUTCOME_TEXT.not_allowed],
      [() => refused("OS404"), RELEASE_OUTCOME_TEXT.not_found],
      [() => refused("OS400"), RELEASE_OUTCOME_TEXT.refused],
      [() => refused("OS500"), RELEASE_OUTCOME_TEXT.unknown],
    ];
    for (const [answer, text] of cases) {
      session.answer(
        "release_conversation",
        answer as Parameters<InboxSession["answer"]>[1],
      );
      await release(screen);
      await expect.element(screen.getByText(text)).toBeVisible();
    }
    expect(releases(session)).toHaveLength(cases.length);
  });
});
