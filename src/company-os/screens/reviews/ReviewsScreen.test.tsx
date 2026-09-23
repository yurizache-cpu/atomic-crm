import { CONTRACT_ERROR_TEXT } from "../../components/queryErrors";
import {
  ALLOWED_DECISIONS_NOTE,
  NEEDS_EDIT_TEXT,
  REPLY_DRAFT_NOTE,
  REVIEW_DECISIONS_CLI_NOTE,
  REVIEW_NOT_A_SEND_NOTE,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import {
  cachedOperations,
  createCacheCapture,
  goTo,
  renderCompanyOs,
} from "../../testing/renderCompanyOs";
import { ADVICE_SUMMARY, openAdvice } from "../../testing/routes";
import { WITHHELD_TEXT } from "./reviewLabels";
import { ReviewsScreen } from "./ReviewsScreen";

// Screen 6 (docs/PHASE_2C_BRIEF.md §7.5, §9, §12, §13 item 3), fed with the
// reviews the real projection returned: pending first, a tab per status, a
// detail with the decision note and the server's allowed decisions as
// information only, and no decision control; the structured advice read only
// on an explicit open, kept for no time and dropped from the cache on close;
// every withheld reason; never the reply draft.

const reviewDetail = (label: string) => `#/company-os/reviews/${rid(label)}`;

/** Long enough for a read a render would start to have reached the port. */
const outlastStrayReads = () =>
  new Promise((resolve) => setTimeout(resolve, 150));

/** The pending review of a do-not-contact lead: never accepted. */
const DO_NOT_CONTACT_DECISIONS = "Rejeitada, Pede ajuste";

describe("the Reviews screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("opens on the pending tab, oldest first, lists the other statuses as tabs, and says decisions are recorded in the CLI and never send", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/reviews");

    const list = screen.getByRole("list", { name: "Decisões" });
    await expect
      .element(
        list.getByRole("link", {
          name: `Ver análise da revisão ${rid("review:opened")}`,
        }),
      )
      .toBeVisible();
    const order = [
      ...document.querySelectorAll('[aria-label="Decisões"] [role="listitem"]'),
    ].map((item) =>
      item
        .querySelector('a[aria-label^="Ver análise da revisão"]')
        ?.getAttribute("aria-label"),
    );
    expect(order).toEqual([
      `Ver análise da revisão ${rid("review:opened")}`,
      `Ver análise da revisão ${rid("review:no-origin")}`,
    ]);
    await expect
      .element(
        screen.getByRole("link", {
          name: "Aguardando sua revisão",
          exact: true,
        }),
      )
      .toHaveAttribute("aria-current", "page");
    await expect
      .element(
        screen.getByText(
          `${REVIEW_DECISIONS_CLI_NOTE} ${REVIEW_NOT_A_SEND_NOTE}`,
        ),
      )
      .toBeVisible();
    expect(session.callsOf("list_reviews")[0].args.p_status).toBe("pending");

    await screen
      .getByRole("link", { name: "Pede ajuste", exact: true })
      .click();

    await expect
      .element(screen.getByText(`Pede ajuste: ${NEEDS_EDIT_TEXT}`).first())
      .toBeVisible();
    expect(session.callsOf("list_reviews").at(-1)?.args.p_status).toBe(
      "needs_edit",
    );
  });

  it("names an accepted review's outbound record by what it is, and never as a message approved or awaiting a send", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/reviews?status=accepted",
    );

    const list = screen.getByRole("list", { name: "Decisões" });
    await expect.element(list).toHaveTextContent("Envio incerto");
    await expect.element(list).toHaveTextContent("Envio bloqueado");
    await expect.element(list).toHaveTextContent("Envio falhou");
    expect(document.body.textContent).not.toMatch(
      /approved|awaiting|waiting to be sent|ready to send|aprovad|aguardando envio|pronta para envio/i,
    );
  });

  it("shows the decisions the server would accept as information only, with no decision control", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewDetail("review:no-origin"),
    );

    await expect
      .element(
        screen.getByText("Aceita, Rejeitada, Pede ajuste", { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText(ALLOWED_DECISIONS_NOTE))
      .toBeVisible();
    const buttons = document.querySelectorAll("button");
    expect(
      [...buttons].map((button) => button.textContent?.trim()).sort(),
    ).toEqual(["Sair", "Ver análise"]);
  });

  it("never offers accepting a do-not-contact lead's review", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewDetail("review:opened"),
    );

    await expect
      .element(screen.getByText(DO_NOT_CONTACT_DECISIONS, { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("region", { name: "Revisão", exact: true }))
      .toHaveTextContent("Não contatarSim");
  });

  it("shows a decided review's note, and an empty note as a note", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewDetail("review:accepted-1"),
    );

    await expect
      .element(screen.getByText("Call back tomorrow", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("nenhuma: esta revisão não está pendente"))
      .toBeVisible();

    goTo(reviewDetail("review:invalid"));

    await expect
      .element(screen.getByRole("region", { name: "Revisão", exact: true }))
      .toHaveTextContent("Tem nota de decisãoSim");
    expect(screen.getByText("sem nota", { exact: true }).query()).toBeNull();
  });

  it("reads the advice only when opened, drops it from the cache when closed, and reads it afresh when reopened", async () => {
    const session = createRecordedSession();
    const capture = createCacheCapture();
    const screen = await renderCompanyOs(
      session,
      reviewDetail("review:opened"),
      { screens: { reviews: capture.wrap(ReviewsScreen) } },
    );
    await expect
      .element(screen.getByRole("button", { name: "Ver análise" }))
      .toBeVisible();
    expect(session.callsOf("get_review_advice")).toEqual([]);
    expect(document.body.textContent).not.toContain(ADVICE_SUMMARY);

    await openAdvice(screen);

    const advice = screen.getByRole("region", { name: "Análise estruturada" });
    await expect
      .element(advice)
      .toHaveTextContent("Offer two synthetic slots.");
    await expect.element(advice).toHaveTextContent("AlertasPouco claro");
    await expect.element(advice).toHaveTextContent(REPLY_DRAFT_NOTE);
    expect(session.callsOf("get_review_advice")).toHaveLength(1);
    expect(cachedOperations(capture.client())).toContain("get_review_advice");

    await screen.getByRole("button", { name: "Ocultar análise" }).click();

    await expect
      .element(screen.getByText(ADVICE_SUMMARY))
      .not.toBeInTheDocument();
    expect(cachedOperations(capture.client())).not.toContain(
      "get_review_advice",
    );
    expect(
      JSON.stringify(
        capture
          .client()
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(ADVICE_SUMMARY);

    await openAdvice(screen);

    expect(session.callsOf("get_review_advice")).toHaveLength(2);
  });

  it.each([
    { move: "Back", reach: () => history.back() },
    {
      move: "a typed address",
      reach: () => goTo(reviewDetail("review:opened")),
    },
  ])(
    "never reads or shows a review's advice after $move from another review whose advice was open",
    async ({ reach }) => {
      const session = createRecordedSession();
      const screen = await renderCompanyOs(
        session,
        reviewDetail("review:opened"),
      );
      await expect
        .element(screen.getByText(DO_NOT_CONTACT_DECISIONS, { exact: true }))
        .toBeVisible();
      goTo(reviewDetail("review:no-origin"));
      await expect
        .element(
          screen.getByText("Aceita, Rejeitada, Pede ajuste", { exact: true }),
        )
        .toBeVisible();
      await screen.getByRole("button", { name: "Ver análise" }).click();
      await expect.element(screen.getByText(/^Análise retida/)).toBeVisible();

      reach();

      await expect
        .element(screen.getByText(DO_NOT_CONTACT_DECISIONS, { exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByRole("button", { name: "Ver análise" }))
        .toHaveAttribute("aria-expanded", "false");
      await outlastStrayReads();
      expect(
        session.callsOf("get_review_advice").map((call) => call.args),
      ).toEqual([{ p_review_id: rid("review:no-origin") }]);
      expect(document.body.textContent).not.toContain(ADVICE_SUMMARY);

      await openAdvice(screen);

      expect(session.callsOf("get_review_advice").at(-1)?.args).toEqual({
        p_review_id: rid("review:opened"),
      });
    },
  );

  it.each([
    ["review:no-origin", WITHHELD_TEXT.origin_not_synthetic_or_test],
    ["review:not-pinned", WITHHELD_TEXT.capability_not_pinned],
    ["review:invalid", WITHHELD_TEXT.contract_invalid],
  ])(
    "shows why the advice of %s is withheld, and nothing else of it",
    async (label, reason) => {
      const screen = await renderCompanyOs(
        createRecordedSession(),
        reviewDetail(label),
      );

      await screen.getByRole("button", { name: "Ver análise" }).click();

      await expect
        .element(screen.getByText(`Análise retida: ${reason}.`))
        .toBeVisible();
      expect(
        screen.getByText("Classificação", { exact: true }).query(),
      ).toBeNull();
      expect(screen.getByText("Resumo", { exact: true }).query()).toBeNull();
    },
  );

  it("renders an error, never the draft, when the advice carries a reply draft", async () => {
    // Hand-built on purpose: the projection never returns the draft, so only a
    // tampered answer reaches the contract's tripwire. It is the recorded
    // advice with a draft added.
    const draft = "Synthetic reply draft that a CLI send would transmit";
    const session = createRecordedSession();
    session.answer("get_review_advice", (args) =>
      ok({ ...recorded("get_review_advice", args), response_draft: draft }),
    );
    const screen = await renderCompanyOs(
      session,
      reviewDetail("review:opened"),
    );

    await screen.getByRole("button", { name: "Ver análise" }).click();

    await expect.element(screen.getByText(CONTRACT_ERROR_TEXT)).toBeVisible();
    expect(document.body.textContent).not.toContain(draft);
    expect(document.body.textContent).not.toContain(ADVICE_SUMMARY);
  });

  it("offers no advice view when operator_context says advice is not available", async () => {
    // Hand-built on purpose: the read surface always reports viewAdvice true
    // today; the hint is here for the phases that narrow it.
    const session = createRecordedSession();
    const context = recorded("operator_context");
    session.answer("operator_context", () =>
      ok({
        ...context,
        allowedActions: { ...context.allowedActions, viewAdvice: false },
      }),
    );
    const screen = await renderCompanyOs(
      session,
      reviewDetail("review:opened"),
    );

    await expect
      .element(
        screen.getByText("A análise não está disponível para este operador."),
      )
      .toBeVisible();
    expect(
      screen.getByRole("button", { name: "Ver análise" }).query(),
    ).toBeNull();
  });
});
