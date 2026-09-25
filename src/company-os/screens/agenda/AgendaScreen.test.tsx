import { STATE_UNKNOWN_NOTE } from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { ok, refused } from "../../testing/fakeSession";
import {
  createRecordedSession,
  overviewWithRecordedAgenda,
  recordedAgenda,
} from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Agenda (Phase 3A), fed with the agenda the real projection returned for a
// fictional clinic's Monday, 2030-03-04 10:30 in São Paulo
// (testing/recorded/agenda.json): three appointments booked today, one
// cancelled and one moved to Wednesday; three more this week; one follow-up
// overdue since Thursday and one due this morning, one waiting for the worker,
// two closed; two agendas with free times; a simulated calendar with one
// uncertain sync. Every value is the server's, and nothing here can book,
// move, cancel or complete anything.

const HASH = "#/company-os/agenda";

const withRecordedAgenda = () => {
  const session = createRecordedSession();
  session.answer("overview", () => ok(overviewWithRecordedAgenda()));
  return session;
};

describe("the Agenda screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows today's count, the week ahead, overdue and today's follow-ups, the next free time and the calendar state", async () => {
    const screen = await renderCompanyOs(withRecordedAgenda(), HASH);

    await expect
      .element(screen.getByRole("heading", { name: "Agenda", level: 1 }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Veja horários, próximos atendimentos e follow-ups que precisam de ação.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("Follow-ups vencidos", { exact: true }))
      .toBeVisible();
    const card = (label: string) =>
      screen.getByText(label, { exact: true }).element().closest("div")
        ?.parentElement?.textContent ?? "";
    expect(card("Hoje")).toContain("3");
    expect(card("Próximos 7 dias")).toContain("3");
    expect(card("Follow-ups vencidos")).toContain("1");
    expect(card("Follow-ups vencidos")).toContain("2 precisam de ação");
    expect(card("Follow-ups hoje")).toContain("2");
    // The earliest free time: Agenda B at 11:00 today, in the agenda's zone.
    expect(card("Próximo horário livre")).toContain("seg., 04/03 às 11:00");
    expect(card("Próximo horário livre")).toContain(
      "Agenda Profissional B · Atendimento inicial",
    );
    expect(card("Sincronização")).toContain("Simulado");
    expect(card("Sincronização")).toContain(
      "1 sincronização incerta ou com falha",
    );
  });

  it("lists today's appointments in the agenda's time zone, with their state, reason and calendar mirror", async () => {
    const screen = await renderCompanyOs(withRecordedAgenda(), HASH);
    const today = screen.getByRole("list", { name: "Atendimentos de hoje" });

    await expect.element(today).toBeVisible();
    const rows = today
      .getByRole("listitem")
      .elements()
      .map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toContain("09:00–09:50");
    expect(rows[0]).toContain("Agenda Profissional A");
    expect(rows[0]).toContain("Calendário sincronizado");
    expect(rows[2]).toContain("14:00–14:50");
    expect(rows[2]).toContain("Sincronização incerta");
    expect(rows[3]).toContain("Cancelado");
    expect(rows[3]).toContain("Motivo: a pedido do cliente");
    expect(rows[4]).toContain("Remarcado para qua., 06/03 às 10:00");
    await expect
      .element(
        screen.getByText(
          "segunda-feira, 4 de março · horários em America/Sao_Paulo",
        ),
      )
      .toBeVisible();
  });

  it("lists the follow-ups that need action, the scheduled ones and the recently closed ones", async () => {
    const screen = await renderCompanyOs(withRecordedAgenda(), HASH);
    const texts = (name: string) =>
      screen
        .getByRole("list", { name })
        .getByRole("listitem")
        .elements()
        .map((row) => row.textContent ?? "");

    await expect
      .element(screen.getByRole("list", { name: "Precisam de ação" }))
      .toBeVisible();
    expect(texts("Precisam de ação")).toEqual([
      expect.stringContaining("Follow-up 1 de 3"),
      expect.stringContaining("Follow-up 2 de 3"),
    ]);
    expect(texts("Precisam de ação")[0]).toContain(
      "Venceu qui., 28/02 às 10:00",
    );
    expect(texts("Agendados")[0]).toContain("Aguardando processamento");
    expect(texts("Encerrados recentemente")).toEqual([
      expect.stringContaining("Cancelado"),
      expect.stringContaining("Concluído"),
    ]);
    expect(texts("Encerrados recentemente")[0]).toContain(
      "Motivo: o contato respondeu",
    );
    await expect
      .element(
        screen.getByText(
          "Um follow-up que precisa de ação é trabalho do operador: o Company OS não envia mensagens sozinho.",
        ),
      )
      .toBeVisible();
  });

  it("shows each agenda's next free times and says Google Calendar is not connected", async () => {
    const screen = await renderCompanyOs(withRecordedAgenda(), HASH);
    const agenda = recordedAgenda();

    await expect
      .element(
        screen.getByRole("article", {
          name: "Agenda Profissional A · Atendimento inicial",
        }),
      )
      .toHaveTextContent("seg., 04/03 às 14:00");
    expect(agenda.availability[0].nextSlots).toHaveLength(5);
    await expect
      .element(screen.getByText("Google Agenda: não conectado").first())
      .toBeVisible();
    await expect
      .element(screen.getByLabelText("Sincronização dos próximos atendimentos"))
      .toHaveTextContent("Sincronização incerta1");
  });

  it("shows an empty, local-only agenda for a tenant with no scheduling", async () => {
    const screen = await renderCompanyOs(createRecordedSession(), HASH);

    await expect
      .element(screen.getByText("Nenhum atendimento hoje."))
      .toBeVisible();
    await expect
      .element(screen.getByText("Nenhum follow-up precisa de ação agora."))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Nenhuma agenda com disponibilidade configurada."),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Os agendamentos existem apenas no Company OS. Nenhum calendário externo está conectado.",
        ),
      )
      .toBeVisible();
  });

  it("says it is loading until the overview answers, and offers only a retry when it cannot be read", async () => {
    const pending = createRecordedSession();
    pending.answer("overview", () => new Promise(() => {}));
    const loading = await renderCompanyOs(pending, HASH);
    await expect.element(loading.getByText("Carregando…")).toBeVisible();
    await loading.unmount();

    const failing = createRecordedSession();
    failing.answer("overview", () => refused("OS500"));
    const screen = await renderCompanyOs(failing, HASH);
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Tentar de novo" }))
      .toBeVisible();
    expect(screen.getByText("Agenda de hoje").query()).toBeNull();
  });

  it("renders every headline as unknown, and no list, once the answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(withRecordedAgenda(), HASH, {
      clock: () => Date.now() + skew,
    });
    await expect
      .element(screen.getByRole("list", { name: "Atendimentos de hoje" }))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(
      screen.getByRole("list", { name: "Atendimentos de hoje" }).query(),
    ).toBeNull();
    expect(
      screen.getByText("Desconhecido", { exact: true }).elements().length,
    ).toBe(6);
  });

  it("offers no control that books, moves, cancels or completes anything, and shows no subject or contact", async () => {
    const screen = await renderCompanyOs(withRecordedAgenda(), HASH);
    await expect
      .element(screen.getByRole("list", { name: "Atendimentos de hoje" }))
      .toBeVisible();
    const page = screen
      .getByRole("heading", { name: "Agenda", level: 1 })
      .element()
      .closest("div")?.parentElement;

    expect(
      page?.querySelectorAll("button, input, select, textarea, form"),
    ).toHaveLength(0);
    expect(page?.textContent).not.toMatch(/lead:|REC-|@|\+55/);
    expect(page?.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});
