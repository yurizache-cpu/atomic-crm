import type { OverviewSummary } from "../../../../contracts/company-os-api/index.ts";
import { WAITING_LIST_EMPTY, WAITING_WINDOW_CLOSED } from "../../copy";
import { ok } from "../../testing/fakeSession";
import {
  createRecordedSession,
  overviewWithRecordedWaitingList,
  recordedWaitingList,
} from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// ADR 0026 §D: the overview's waiting list, fed with the list the real
// projection returned at a fixed instant (five synthetic conversations, a
// notification in each state). Oldest first; each row opens the conversation
// in the Fila de atendimento, by the task of its oldest open episode; no
// text, number or name is shown.

const sessionWith = (
  waitingList: OverviewSummary["waitingList"] = recordedWaitingList(),
) => {
  const session = createRecordedSession();
  session.answer("overview", () =>
    ok({ ...overviewWithRecordedWaitingList(), waitingList }),
  );
  return session;
};

/** The overview as an older database answers it: no waiting list at all. */
const sessionWithout = () => {
  const session = createRecordedSession();
  const { waitingList: _absent, ...overview } =
    overviewWithRecordedWaitingList();
  session.answer("overview", () => ok(overview));
  return session;
};

describe("the overview's waiting list", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("lists who waits for a person, oldest first, each opening its conversation, with the notification's state", async () => {
    const screen = await renderCompanyOs(sessionWith(), "#/company-os");

    await expect
      .element(screen.getByRole("heading", { name: "Fila de atendimento" }))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("link", {
          name: "Mensagem aguardando (2 mensagens)",
        }),
      )
      .toHaveAttribute(
        "href",
        "#/company-os/inbox/00000000-0000-4000-8000-000000000003",
      );
    const list = screen.getByRole("region", { name: "Fila de atendimento" });
    expect(
      list
        .getByRole("link")
        .elements()
        .map((link) => link.textContent),
    ).toEqual([
      "Mensagem aguardando (2 mensagens)",
      "Pediu uma pessoa (1 mensagem)",
      "Mensagem aguardando (3 mensagens) · Pediu uma pessoa (1 mensagem)",
      "Pediu uma pessoa (1 mensagem)",
      "Mensagem aguardando (1 mensagem)",
    ]);
    for (const state of [
      "Aviso falhou",
      "Aviso entregue",
      "Aviso na fila",
      "Sem aviso",
    ]) {
      await expect.element(list.getByText(state).first()).toBeVisible();
    }
    // The oldest contact's last message was 25 hours ago: its window closed.
    await expect.element(list.getByText(WAITING_WINDOW_CLOSED)).toBeVisible();
    expect(
      list.getByText(/^Janela de 24 h até \d{2}:\d{2}$/).elements(),
    ).toHaveLength(4);
    // No number appears anywhere on the list.
    expect(list.element().textContent).not.toMatch(/\d{6,}/);
  });

  it("says when no one waits, and how many are not shown past the fifty oldest", async () => {
    const empty = await renderCompanyOs(
      sessionWith({ total: 0, items: [] }),
      "#/company-os",
    );
    await expect.element(empty.getByText(WAITING_LIST_EMPTY)).toBeVisible();
    await empty.unmount();

    const list = recordedWaitingList();
    const capped = await renderCompanyOs(
      sessionWith({ ...list, total: 57 }),
      "#/company-os",
    );
    await expect
      .element(
        capped.getByText("57 conversas aguardam; mostrando as 5 mais antigas."),
      )
      .toBeVisible();
  });

  it("shows nothing of it while the database does not carry it yet", async () => {
    const screen = await renderCompanyOs(sessionWithout(), "#/company-os");
    await expect
      .element(screen.getByRole("heading", { name: "Equipe" }))
      .toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Fila de atendimento" }).elements(),
    ).toHaveLength(0);
  });
});
