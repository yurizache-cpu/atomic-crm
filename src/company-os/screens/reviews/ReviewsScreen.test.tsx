import { CONTRACT_ERROR_TEXT } from "../../components/queryErrors";
import {
  DECISION_ALREADY_RECORDED_TEXT,
  DECISION_NOT_ALLOWED_TEXT,
  DECISION_RECORDS_TEXT,
  DECISION_UNKNOWN_TEXT,
  DO_NOT_CONTACT_ACCEPT_NOTE,
  NEEDS_EDIT_TEXT,
  NO_MESSAGE_SENT_TEXT,
  NO_MESSAGE_WAS_SENT_TEXT,
  REPLY_DRAFT_NOTE,
  REVIEW_DECISIONS_NOTE,
  REVIEW_NOT_A_SEND_NOTE,
} from "../../copy";
import { ok, refused, type FakeSession } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import {
  cachedOperations,
  createCacheCapture,
  goTo,
  renderCompanyOs,
} from "../../testing/renderCompanyOs";
import { ADVICE_SUMMARY, openAdvice } from "../../testing/routes";
import { NO_REPLY_SENT_TEXT, WITHHELD_TEXT } from "./reviewLabels";
import { ReviewsScreen } from "./ReviewsScreen";
import type { RenderResult } from "vitest-browser-react";

// Screen 6 (docs/PHASE_2C_BRIEF.md §7.5, §9, §12, §13 item 3), fed with the
// reviews the real projection returned: pending first, a tab per status, a
// detail with the decision note and, for an open review the server would let
// this member decide, the one act (S7.1): the decisions it lists, each behind
// a confirmation, called once and never retried, which sends nothing; the
// structured advice read only on an explicit open, kept for no time and
// dropped from the cache on close; every withheld reason; never the reply
// draft.

const reviewDetail = (label: string) => `#/company-os/reviews/${rid(label)}`;

/** Long enough for a read a render would start to have reached the port. */
const outlastStrayReads = () =>
  new Promise((resolve) => setTimeout(resolve, 150));

/** The decision surface of an open review. */
const decisionGroup = (screen: { getByRole: RenderResult["getByRole"] }) =>
  screen.getByRole("group", { name: "Registrar decisão" });

/** The recorded open review, as get_review answers it once it is decided. */
const decidedOpenReview = (status: "accepted" | "rejected" | "needs_edit") => ({
  ...recorded("get_review", { p_review_id: rid("review:open") }),
  status,
  reviewedAt: "2026-09-23T15:00:00.000000Z",
  allowedDecisions: [],
});

/**
 * get_review for the open review answers as recorded until the act has been
 * called, and as `after` from then on (null: always as recorded).
 */
const decideThen = (
  session: FakeSession,
  act: () => ReturnType<typeof ok>,
  after: ReturnType<typeof decidedOpenReview> | null,
) => {
  session.answer("decide_review", act);
  session.answer("get_review", (args) =>
    ok(
      args.p_review_id === rid("review:open") &&
        after !== null &&
        session.callsOf("decide_review").length > 0
        ? after
        : recorded("get_review", args),
    ),
  );
};

const accepted = (args: Readonly<Record<string, unknown>>) =>
  ok({
    v: 1,
    asOf: "2026-09-23T15:00:00.000000Z",
    reviewItemId: args.p_review_id,
    status: args.p_decision,
    recorded: true,
  });

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
      `Ver análise da revisão ${rid("review:open")}`,
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
        screen.getByText(`${REVIEW_DECISIONS_NOTE} ${REVIEW_NOT_A_SEND_NOTE}`),
      )
      .toBeVisible();
    expect(session.callsOf("list_reviews")[0].args.p_status).toBe("pending");
    // No outbound record: a fact, never a reply approved, expected or queued.
    await expect.element(list).toHaveTextContent(NO_REPLY_SENT_TEXT);
    expect(list.element().textContent).not.toMatch(
      /aprovad|aguardando envio|pronta para envio|autoriz/i,
    );

    await screen
      .getByRole("link", { name: "Precisa de ajuste", exact: true })
      .click();

    await expect
      .element(
        screen.getByText(`Precisa de ajuste: ${NEEDS_EDIT_TEXT}`).first(),
      )
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

  it("offers the three decisions on an open synthetic review, each behind a confirmation, and calls nothing until one is confirmed", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, reviewDetail("review:open"));

    const group = decisionGroup(screen);
    await expect.element(group).toBeVisible();
    expect(
      [...group.element().querySelectorAll("button")].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["Aceitar", "Precisa de ajuste", "Rejeitar"]);
    expect(screen.getByRole("alertdialog").query()).toBeNull();

    await group.getByRole("button", { name: "Aceitar" }).click();

    const confirm = screen.getByRole("alertdialog", {
      name: "Aceitar esta análise?",
    });
    await expect
      .element(confirm)
      .toHaveTextContent(`${DECISION_RECORDS_TEXT} ${NO_MESSAGE_SENT_TEXT}`);
    // The safe choice holds the focus; confirming is a second, deliberate act.
    await expect
      .element(confirm.getByRole("button", { name: "Cancelar" }))
      .toHaveFocus();
    expect(session.callsOf("decide_review")).toEqual([]);

    await confirm.getByRole("button", { name: "Cancelar" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    await decisionGroup(screen)
      .getByRole("button", { name: "Precisa de ajuste" })
      .click();
    await expect
      .element(
        screen.getByRole("alertdialog", {
          name: "Marcar como “Precisa de ajuste”?",
        }),
      )
      .toBeVisible();
    expect(session.callsOf("decide_review")).toEqual([]);
  });

  it("records a confirmed decision once, never retries it, re-reads the review and closes the controls", async () => {
    const session = createRecordedSession();
    decideThen(
      session,
      () => accepted(session.callsOf("decide_review").at(-1)!.args),
      decidedOpenReview("accepted"),
    );
    const screen = await renderCompanyOs(session, reviewDetail("review:open"));
    const readsBefore = () => session.callsOf("get_review").length;
    await decisionGroup(screen)
      .getByRole("button", { name: "Aceitar" })
      .click();
    const before = readsBefore();

    await screen
      .getByRole("alertdialog")
      .getByRole("button", { name: "Confirmar" })
      .click();

    await expect
      .element(
        screen.getByRole("status").filter({ hasText: "Decisão registrada" }),
      )
      .toHaveTextContent(
        `Decisão registrada: Aceita. ${NO_MESSAGE_WAS_SENT_TEXT}`,
      );
    expect(session.callsOf("decide_review").map((call) => call.args)).toEqual([
      { p_review_id: rid("review:open"), p_decision: "accepted" },
    ]);
    expect(readsBefore()).toBeGreaterThan(before);
    await expect.element(decisionGroup(screen)).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("region", { name: "Revisão", exact: true }))
      .toHaveTextContent("SituaçãoAceita");
    await outlastStrayReads();
    expect(session.callsOf("decide_review")).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(
      /aprovad|aguardando envio|pronta para envio/i,
    );
  });

  it("says a conflicting decision was already recorded, with the state the server now holds", async () => {
    const session = createRecordedSession();
    decideThen(session, () => refused("OS409"), decidedOpenReview("rejected"));
    const screen = await renderCompanyOs(session, reviewDetail("review:open"));
    await decisionGroup(screen)
      .getByRole("button", { name: "Aceitar" })
      .click();

    await screen
      .getByRole("alertdialog")
      .getByRole("button", { name: "Confirmar" })
      .click();

    await expect
      .element(
        screen.getByText(
          `${DECISION_ALREADY_RECORDED_TEXT} Situação atual: Rejeitada.`,
        ),
      )
      .toBeVisible();
    await expect.element(decisionGroup(screen)).not.toBeInTheDocument();
    expect(session.callsOf("decide_review")).toHaveLength(1);
  });

  it("says the member may no longer decide when the act is refused for access", async () => {
    const session = createRecordedSession();
    decideThen(session, () => refused("OS403"), null);
    const screen = await renderCompanyOs(session, reviewDetail("review:open"));
    await decisionGroup(screen)
      .getByRole("button", { name: "Rejeitar" })
      .click();

    await screen
      .getByRole("alertdialog", { name: "Rejeitar esta análise?" })
      .getByRole("button", { name: "Confirmar" })
      .click();

    await expect
      .element(screen.getByText(DECISION_NOT_ALLOWED_TEXT))
      .toBeVisible();
    expect(session.callsOf("decide_review")).toHaveLength(1);
  });

  it.each([
    {
      label: "holds the requested decision",
      after: decidedOpenReview("accepted"),
      text: `Decisão registrada: Aceita. ${NO_MESSAGE_WAS_SENT_TEXT}`,
      controls: false,
    },
    {
      label: "still shows the review open",
      after: null,
      text: DECISION_UNKNOWN_TEXT,
      controls: true,
    },
  ])(
    "re-reads the review after an answer that was lost, and reports success only when it $label, never calling the act again",
    async ({ after, text, controls }) => {
      const session = createRecordedSession();
      decideThen(session, () => refused("OS500"), after);
      const screen = await renderCompanyOs(
        session,
        reviewDetail("review:open"),
      );
      await decisionGroup(screen)
        .getByRole("button", { name: "Aceitar" })
        .click();

      await screen
        .getByRole("alertdialog")
        .getByRole("button", { name: "Confirmar" })
        .click();

      await expect.element(screen.getByText(text)).toBeVisible();
      if (controls) {
        await expect.element(decisionGroup(screen)).toBeVisible();
      } else {
        await expect.element(decisionGroup(screen)).not.toBeInTheDocument();
      }
      await outlastStrayReads();
      expect(session.callsOf("decide_review")).toHaveLength(1);
    },
  );

  it("offers no decision on a decided review, on one outside the synthetic and test scope, or when operator_context withholds it", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(
      session,
      reviewDetail("review:accepted-1"),
    );
    await expect
      .element(screen.getByText("Call back tomorrow", { exact: true }))
      .toBeVisible();
    expect(decisionGroup(screen).query()).toBeNull();

    goTo(reviewDetail("review:no-origin"));
    await expect
      .element(screen.getByRole("region", { name: "Revisão", exact: true }))
      .toHaveTextContent("Aguardando sua revisão");
    expect(decisionGroup(screen).query()).toBeNull();

    // Hand-built on purpose: the read surface reports decideReview true.
    const hidden = createRecordedSession();
    const context = recorded("operator_context");
    hidden.answer("operator_context", () =>
      ok({
        ...context,
        allowedActions: { ...context.allowedActions, decideReview: false },
      }),
    );
    history.replaceState(null, "", "#/");
    const again = await renderCompanyOs(hidden, reviewDetail("review:open"));
    await expect
      .element(again.getByRole("region", { name: "Revisão", exact: true }))
      .toBeVisible();
    expect(decisionGroup(again).query()).toBeNull();
    expect(session.callsOf("decide_review")).toEqual([]);
    expect(hidden.callsOf("decide_review")).toEqual([]);
  });

  it("never offers accepting a do-not-contact lead's review", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewDetail("review:opened"),
    );

    await expect
      .element(screen.getByText(DO_NOT_CONTACT_ACCEPT_NOTE))
      .toBeVisible();
    const group = decisionGroup(screen);
    expect(
      [...group.element().querySelectorAll("button")].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["Precisa de ajuste", "Rejeitar"]);
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
    expect(decisionGroup(screen).query()).toBeNull();

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
        .element(screen.getByText(DO_NOT_CONTACT_ACCEPT_NOTE))
        .toBeVisible();
      goTo(reviewDetail("review:no-origin"));
      await expect
        .element(screen.getByText(DO_NOT_CONTACT_ACCEPT_NOTE))
        .not.toBeInTheDocument();
      await screen.getByRole("button", { name: "Ver análise" }).click();
      await expect.element(screen.getByText(/^Análise retida/)).toBeVisible();

      reach();

      await expect
        .element(screen.getByText(DO_NOT_CONTACT_ACCEPT_NOTE))
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
