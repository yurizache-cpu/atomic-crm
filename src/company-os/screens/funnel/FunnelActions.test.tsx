import type { AvailableFunnel } from "../../../../contracts/company-os-api/index.ts";
import { ok, refused, type Responder } from "../../testing/fakeSession";
import {
  createRecordedSession,
  overviewWithRecordedFunnel,
  recorded,
  recordedFunnel,
} from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";
import { STALE_TEXT, UNKNOWN_TEXT } from "./OpportunityActions";

// The four commercial acts on the Funil comercial (Phase 3B.2, owner decision
// R), against the recorded funnel of a fictional clinic on 2030-03-04 in São
// Paulo. Opportunity #103 is open in "Contato iniciado" with an overdue next
// action; #113 is converted. Every act needs a second, deliberate click, is
// sent once with the revision the card showed, and the board changes only when
// the server's answer arrives and the funnel is read again.

const HASH = "#/company-os/funnel";
const AS_OF = "2030-03-04T13:31:00.000000Z";
/** The recording's stand-in revision of a deal (companyOsFunnelRecording). */
const revisionOf = (dealRef: number) =>
  `r1.${dealRef.toString(16).padStart(32, "0")}`;

const sessionWith = (
  funnel: AvailableFunnel = recordedFunnel(),
  allowed: Partial<Record<string, boolean>> = {},
) => {
  const session = createRecordedSession();
  session.answer("overview", () => ok(overviewWithRecordedFunnel(funnel)));
  const context = recorded("operator_context");
  session.answer("operator_context", () =>
    ok({
      ...context,
      allowedActions: { ...context.allowedActions, ...allowed },
    }),
  );
  return session;
};

const moved = {
  v: 1,
  asOf: AS_OF,
  dealRef: 103,
  outcome: "moved",
  revision: `r1.${"a".repeat(32)}`,
  stage: "initial_session_scheduled",
};

/** A responder whose answer waits until the test releases it. */
const held = (answer: () => ReturnType<Responder>) => {
  let release = () => {};
  const responder: Responder = () =>
    new Promise((resolve) => {
      release = () => resolve(answer());
    });
  return { responder, release: () => release() };
};

const cardText = (
  screen: Awaited<ReturnType<typeof renderCompanyOs>>,
  stage: string,
) =>
  screen
    .getByRole("list", { name: `Oportunidades em ${stage}` })
    .getByRole("listitem")
    .elements()
    .map((row) => row.textContent ?? "");

describe("the Funil comercial's commercial acts", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("offers an act only where both the operator context and the card allow it", async () => {
    const funnel = recordedFunnel();
    const contact = funnel.stages.find((s) => s.code === "contact_started")!;
    contact.cards[1] = {
      ...contact.cards[1],
      actions: { ...contact.cards[1].actions, lose: false },
    };
    const screen = await renderCompanyOs(
      sessionWith(funnel, { convertOpportunity: false }),
      HASH,
    );
    const open = screen.getByRole("group", {
      name: "Ações da Oportunidade #103",
    });
    await expect.element(open).toBeVisible();
    expect(
      open
        .getByRole("button")
        .elements()
        .map((b) => b.textContent),
    ).toEqual(["Mover etapa", "Definir próxima ação", "Marcar como perdida"]);
    // The card's own hint: #104 may not be lost.
    expect(
      screen
        .getByRole("group", { name: "Ações da Oportunidade #104" })
        .getByRole("button")
        .elements()
        .map((b) => b.textContent),
    ).toEqual(["Mover etapa", "Definir próxima ação"]);
    // A converted opportunity offers nothing.
    expect(
      screen.getByRole("group", { name: "Ações da Oportunidade #113" }).query(),
    ).toBeNull();
  });

  it("offers no act at all when the operator context allows none", async () => {
    const none = await renderCompanyOs(
      sessionWith(recordedFunnel(), {
        moveOpportunity: false,
        setOpportunityNextAction: false,
        convertOpportunity: false,
        loseOpportunity: false,
      }),
      HASH,
    );
    await expect
      .element(none.getByRole("group", { name: "Quadro do funil" }))
      .toBeVisible();
    expect(
      none.getByRole("button", { name: /Mover etapa/ }).query(),
    ).toBeNull();
  });

  it("moves only after a confirmed choice, with the card's revision, and shows the new state only once the server answered", async () => {
    const session = sessionWith();
    const answer = held(() => ok(moved));
    session.answer("move_opportunity", answer.responder);
    const screen = await renderCompanyOs(session, HASH);

    await screen
      .getByRole("button", { name: "Mover etapa: Oportunidade #103" })
      .click();
    const dialog = screen.getByRole("alertdialog", {
      name: "Mover a Oportunidade #103 para outra etapa?",
    });
    await expect.element(dialog).toBeVisible();
    // Every configured stage but the current one and the converted one.
    expect(
      dialog
        .getByRole("radio")
        .elements()
        .map((r) => (r as HTMLInputElement).value),
    ).toEqual([
      "new_lead",
      "conversation_active",
      "initial_session_scheduled",
      "initial_session_paid",
      "initial_session_attended",
      "continuity_offered",
      "continuity_accepted",
    ]);
    const confirm = dialog.getByRole("button", { name: "Mover" });
    await expect.element(confirm).toBeDisabled();
    expect(session.callsOf("move_opportunity")).toHaveLength(0);

    await dialog
      .getByRole("radio", { name: "Sessão inicial agendada" })
      .click();
    await confirm.click();
    await expect
      .element(dialog.getByRole("button", { name: "Salvando…" }))
      .toBeDisabled();
    expect(session.callsOf("move_opportunity")).toEqual([
      {
        operation: "move_opportunity",
        args: {
          p_deal_ref: 103,
          p_target_stage: "initial_session_scheduled",
          p_expected_revision: revisionOf(103),
        },
      },
    ]);
    // No optimistic move and no success before the answer.
    expect(cardText(screen, "Contato iniciado")[0]).toContain(
      "Oportunidade #103",
    );
    expect(screen.getByText(/movida para/).query()).toBeNull();

    const reads = session.callsOf("overview").length;
    answer.release();
    await expect
      .element(
        screen.getByText(
          "Oportunidade #103 movida para Sessão inicial agendada.",
        ),
      )
      .toBeVisible();
    expect(session.callsOf("overview").length).toBeGreaterThan(reads);
    expect(screen.getByRole("alertdialog").query()).toBeNull();
  });

  it("tells a stale view apart, reads the funnel again, and says the result is unknown when the answer is lost", async () => {
    const session = sessionWith();
    session.answer("move_opportunity", () => refused("OS409"));
    const screen = await renderCompanyOs(session, HASH);
    const move = async () => {
      await screen
        .getByRole("button", { name: "Mover etapa: Oportunidade #103" })
        .click();
      await screen.getByRole("radio", { name: "Conversa ativa" }).click();
      await screen.getByRole("button", { name: "Mover", exact: true }).click();
    };

    const reads = session.callsOf("overview").length;
    await move();
    await expect
      .element(screen.getByText(new RegExp(STALE_TEXT)))
      .toBeVisible();
    expect(session.callsOf("overview").length).toBeGreaterThan(reads);

    session.answer("move_opportunity", () => refused("OS429"));
    await move();
    await expect
      .element(
        screen.getByText(
          "O CRM estava ocupado e nada foi alterado. Tente novamente em instantes.",
        ),
      )
      .toBeVisible();

    // A broken or lost answer: never "failed", never "done".
    session.answer("move_opportunity", () => ok({ unexpected: true }));
    await move();
    await expect.element(screen.getByText(UNKNOWN_TEXT)).toBeVisible();
    expect(session.callsOf("move_opportunity")).toHaveLength(3);
  });

  it("sets the next action from the funnel's zone as an absolute instant, says what the follow-up bridge will do, and can clear it", async () => {
    const funnel = {
      ...recordedFunnel(),
      followUpBridge: "configured" as const,
    };
    const session = sessionWith(funnel);
    session.answer("set_opportunity_next_action", (args) =>
      ok({
        v: 1,
        asOf: AS_OF,
        dealRef: 103,
        outcome: args.p_next_action_at === null ? "cleared" : "set",
        revision: `r1.${"b".repeat(32)}`,
        nextActionAt:
          args.p_next_action_at === null ? null : "2030-03-06T12:30:00.000000Z",
        followUp:
          args.p_next_action_at === null
            ? { status: "cancelled", reason: null }
            : { status: "scheduled", reason: null },
      }),
    );
    const screen = await renderCompanyOs(session, HASH);
    const open = () =>
      screen
        .getByRole("button", {
          name: "Definir próxima ação: Oportunidade #103",
        })
        .click();

    await open();
    const dialog = screen.getByRole("alertdialog", {
      name: "Próxima ação da Oportunidade #103",
    });
    await expect
      .element(
        dialog.getByText(
          "Os follow-ups configurados serão ajustados a partir desta próxima ação.",
        ),
      )
      .toBeVisible();
    await dialog.getByLabelText("Data").fill("2030-03-06");
    await dialog.getByLabelText("Horário").fill("09:30");
    await expect
      .element(
        dialog.getByText(
          "Será registrada para 06/03 às 09:30 (America/Sao_Paulo).",
        ),
      )
      .toBeVisible();
    await dialog.getByRole("button", { name: "Salvar próxima ação" }).click();
    await expect
      .element(
        screen.getByText(
          "Próxima ação da Oportunidade #103 registrada para 06/03 às 09:30. Os follow-ups configurados foram ajustados a partir desta próxima ação.",
        ),
      )
      .toBeVisible();

    await open();
    await screen.getByRole("button", { name: "Remover próxima ação" }).click();
    await expect
      .element(
        screen.getByText(
          "Próxima ação da Oportunidade #103 removida. O follow-up automático desta oportunidade foi cancelado.",
        ),
      )
      .toBeVisible();
    expect(
      session
        .callsOf("set_opportunity_next_action")
        .map((c) => c.args.p_next_action_at),
    ).toEqual(["2030-03-06T12:30:00.000Z", null]);
  });

  it("never claims a follow-up when none is configured", async () => {
    const screen = await renderCompanyOs(sessionWith(), HASH);
    await screen
      .getByRole("button", { name: "Definir próxima ação: Oportunidade #103" })
      .click();
    const dialog = screen.getByRole("alertdialog");
    await expect
      .element(
        dialog.getByText("Nenhum follow-up automático está configurado."),
      )
      .toBeVisible();
    expect(dialog.element().textContent).not.toMatch(/serão ajustados/);
  });

  it("converts into the one configured converted stage, or the one chosen when there are several, and never mentions a payment", async () => {
    const session = sessionWith();
    session.answer("convert_opportunity", (args) =>
      ok({
        v: 1,
        asOf: AS_OF,
        dealRef: 103,
        outcome: "converted",
        revision: `r1.${"c".repeat(32)}`,
        stage: args.p_target_stage,
        followUp: { status: "none", reason: null },
      }),
    );
    const screen = await renderCompanyOs(session, HASH);
    await screen
      .getByRole("button", { name: "Converter: Oportunidade #103" })
      .click();
    const dialog = screen.getByRole("alertdialog", {
      name: "Marcar esta oportunidade como convertida?",
    });
    await expect
      .element(dialog.getByText("Etapa de conversão: Continuidade convertida"))
      .toBeVisible();
    expect(dialog.element().textContent).not.toMatch(
      /pagamento|pago|paciente|pacote/i,
    );
    await dialog.getByRole("button", { name: "Converter" }).click();
    await expect
      .element(
        screen.getByText(
          "Oportunidade #103 marcada como convertida em Continuidade convertida.",
        ),
      )
      .toBeVisible();
    expect(session.callsOf("convert_opportunity")[0].args.p_target_stage).toBe(
      "continuity_converted",
    );
  });

  it("asks which converted stage when several are configured", async () => {
    const funnel = recordedFunnel();
    funnel.stages = funnel.stages.map((s) =>
      s.code === "continuity_accepted" ? { ...s, converted: true } : s,
    );
    const several = await renderCompanyOs(sessionWith(funnel), HASH);
    await several
      .getByRole("button", { name: "Converter: Oportunidade #103" })
      .click();
    const choose = several.getByRole("alertdialog");
    await expect
      .element(choose.getByRole("button", { name: "Converter" }))
      .toBeDisabled();
    expect(choose.getByRole("radio").elements()).toHaveLength(2);
  });

  it("marks lost only with a configured reason chosen, and no free text", async () => {
    const session = sessionWith();
    session.answer("lose_opportunity", () =>
      ok({
        v: 1,
        asOf: AS_OF,
        dealRef: 103,
        outcome: "lost",
        revision: `r1.${"d".repeat(32)}`,
        followUp: { status: "none", reason: null },
      }),
    );
    const screen = await renderCompanyOs(session, HASH);
    await screen
      .getByRole("button", { name: "Marcar como perdida: Oportunidade #103" })
      .click();
    const dialog = screen.getByRole("alertdialog", {
      name: "Marcar esta oportunidade como perdida?",
    });
    const confirm = dialog.getByRole("button", { name: "Marcar como perdida" });
    await expect.element(confirm).toBeDisabled();
    expect(
      dialog.element().querySelectorAll("textarea, input[type='text']"),
    ).toHaveLength(0);
    await dialog.getByRole("radio", { name: "Preço" }).click();
    await confirm.click();
    await expect
      .element(
        screen.getByText("Oportunidade #103 marcada como perdida (Preço)."),
      )
      .toBeVisible();
    expect(session.callsOf("lose_opportunity")[0].args).toEqual({
      p_deal_ref: 103,
      p_loss_reason: "price",
      p_expected_revision: revisionOf(103),
    });
  });
});
