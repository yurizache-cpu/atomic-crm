import type { AvailableFunnel } from "../../../../contracts/company-os-api/index.ts";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { ok, refused } from "../../testing/fakeSession";
import {
  createRecordedSession,
  overviewWithRecordedFunnel,
  recordedFunnel,
} from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Funil comercial (Phase 3B.1), fed with the funnel the real projection
// returned for a fictional clinic's opportunities on Monday 2030-03-04, 10:30
// in São Paulo (testing/recorded/funnel.json): twelve open opportunities over
// nine configured stages, two converted and three lost in the last 30 days,
// three overdue next actions and three without one, nine observed movements
// since 24/02/2030, and origins as the CRM recorded them. Every value is the
// server's, and nothing here can create, move, win or lose an opportunity.

const HASH = "#/company-os/funnel";

const withFunnel = (funnel = recordedFunnel()) => {
  const session = createRecordedSession();
  session.answer("overview", () => ok(overviewWithRecordedFunnel(funnel)));
  return session;
};

/** The recorded funnel with a CRM that holds no opportunity. */
const emptyFunnel = (): AvailableFunnel => {
  const funnel = recordedFunnel();
  return {
    ...funnel,
    stages: funnel.stages.map((s) => ({
      ...s,
      total: 0,
      amountTotal: null,
      amountCount: 0,
      cards: [],
    })),
    unconfigured: { total: 0, cards: [] },
    summary: {
      active: 0,
      overdue: 0,
      dueToday: 0,
      noNextAction: 0,
      convertedUndated: 0,
      windowDays: 30,
      newDeals: 0,
      converted: 0,
      lost: 0,
      conflicting: 0,
    },
    attention: {
      cap: 10,
      overdue: { total: 0, items: [] },
      noNextAction: { total: 0, items: [] },
    },
    movements: {
      coverageStart: null,
      windowDays: 30,
      totalInWindow: 0,
      items: [],
    },
    origins: { windowDays: 90, total: 0, items: [] },
    outcomes: {
      windowDays: 30,
      cap: 10,
      converted: { items: [] },
      lost: { items: [] },
    },
  };
};

describe("the Funil comercial screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("answers at a glance: open, new, converted and lost counts, the closing rate with its denominator, and the actions due", async () => {
    const screen = await renderCompanyOs(withFunnel(), HASH);

    await expect
      .element(
        screen.getByRole("heading", { name: "Funil comercial", level: 1 }),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Acompanhe em que etapa estão as oportunidades e onde é preciso agir.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("Em andamento", { exact: true }))
      .toBeVisible();
    const card = (label: string) =>
      screen.getByText(label, { exact: true }).element().closest("div")
        ?.parentElement?.textContent ?? "";
    expect(card("Em andamento")).toContain("12");
    expect(card("Novas nos últimos 30 dias")).toContain("15");
    expect(card("Convertidas nos últimos 30 dias")).toContain("2");
    expect(card("Perdidas nos últimos 30 dias")).toContain("3");
    expect(card("Taxa de fechamento — 30 dias")).toContain("40%");
    expect(card("Taxa de fechamento — 30 dias")).toContain(
      "2 convertidas de 5 encerradas",
    );
    expect(card("Próxima ação atrasada")).toContain("3");
    expect(card("Próxima ação atrasada")).toContain("2 para hoje");
    // "Sem próxima ação" is also a card chip: find its headline by its hint.
    expect(
      screen
        .getByText("Oportunidades abertas sem ação marcada", { exact: true })
        .element()
        .closest("div")?.parentElement?.textContent,
    ).toMatch(/Sem próxima ação3/);
  });

  it("shows one column per configured stage, in the configured order, each with its count and compact cards", async () => {
    const screen = await renderCompanyOs(withFunnel(), HASH);
    const board = screen.getByRole("group", { name: "Quadro do funil" });
    await expect.element(board).toBeVisible();

    const columns = [
      ...board.element().querySelectorAll(":scope > section"),
    ].map((c) => c.getAttribute("aria-label"));
    expect(columns).toEqual([
      "Novo lead: 2",
      "Contato iniciado: 2",
      "Conversa ativa: 2",
      "Sessão inicial agendada: 2",
      "Sessão inicial paga: 1",
      "Sessão inicial realizada: 1",
      "Continuidade oferecida: 1",
      "Continuidade aceita: 1",
      "Continuidade convertida: 2",
    ]);
    const cards = (stage: string) =>
      screen
        .getByRole("list", { name: `Oportunidades em ${stage}` })
        .getByRole("listitem")
        .elements()
        .map((row) => row.textContent ?? "");
    // Open stages: longest in the stage first.
    expect(cards("Contato iniciado")[0]).toContain("Oportunidade #103");
    expect(cards("Contato iniciado")[0]).toContain("Há 3 dias");
    expect(cards("Contato iniciado")[0]).toContain(
      "Próxima ação atrasada · 02/03 às 10:30",
    );
    expect(cards("Contato iniciado")[0]).toContain("Origem: Google Ads");
    expect(cards("Contato iniciado")[0]).toMatch(/Valor informado: R\$\s250/);
    expect(cards("Contato iniciado")[1]).toContain("Oportunidade #104");
    expect(cards("Contato iniciado")[1]).toContain("Próxima ação agendada");
    expect(cards("Contato iniciado")[1]).toContain(
      "Origem: Sem origem registrada",
    );
    expect(cards("Conversa ativa")[0]).toContain("Origem: Indicação");
    expect(cards("Conversa ativa")[1]).toContain("Origem: Várias origens");
    expect(cards("Novo lead")[0]).toContain(
      "Próxima ação hoje · 04/03 às 11:00",
    );
    expect(cards("Novo lead")[1]).toContain("Hoje");
    // The converted stage: most recent first, marked converted.
    expect(cards("Continuidade convertida")).toEqual([
      expect.stringContaining("Oportunidade #113"),
      expect.stringContaining("Oportunidade #114"),
    ]);
    expect(cards("Continuidade convertida")[0]).toContain("Convertida");
  });

  it("lists what needs a commercial action: overdue next actions by due time, and open opportunities without one", async () => {
    const screen = await renderCompanyOs(withFunnel(), HASH);
    const texts = (name: string) =>
      screen
        .getByRole("list", { name })
        .getByRole("listitem")
        .elements()
        .map((row) => row.textContent ?? "");

    await expect
      .element(screen.getByRole("list", { name: "Próximas ações atrasadas" }))
      .toBeVisible();
    expect(texts("Próximas ações atrasadas")).toEqual([
      "Oportunidade #103 · Contato iniciado · prevista para 02/03 às 10:30",
      "Oportunidade #105 · Conversa ativa · prevista para 02/03 às 10:30",
      "Oportunidade #110 · Sessão inicial realizada · prevista para 02/03 às 10:30",
    ]);
    expect(texts("Sem próxima ação")).toEqual([
      "Oportunidade #111 · Continuidade oferecida · há 10 dias nesta etapa",
      "Oportunidade #106 · Conversa ativa · há 1 dia nesta etapa",
      "Oportunidade #101 · Novo lead · hoje nesta etapa",
    ]);
  });

  it("shows observed movement since the ledger's coverage start, and says nothing earlier is known", async () => {
    const screen = await renderCompanyOs(withFunnel(), HASH);
    const moves = screen.getByRole("list", { name: "Movimentações recentes" });
    await expect.element(moves).toBeVisible();

    await expect
      .element(
        screen.getByText(
          "Histórico de movimentações disponível a partir de 24/02/2030. Antes disso, as mudanças de etapa não foram registradas.",
        ),
      )
      .toBeVisible();
    const rows = moves
      .getByRole("listitem")
      .elements()
      .map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(9);
    expect(rows[0]).toContain("Oportunidade #101: Entrou em Novo lead");
    expect(rows[2]).toContain(
      "Oportunidade #113: Continuidade aceita → Continuidade convertida",
    );
    expect(rows[3]).toContain(
      "Oportunidade #107: Conversa ativa → Sessão inicial agendada",
    );
    await expect
      .element(screen.getByText("9 movimentações nos últimos 30 dias."))
      .toBeVisible();
  });

  it("shows where opportunities came from, as the CRM recorded it, and the recent outcomes with their reasons", async () => {
    const screen = await renderCompanyOs(withFunnel(), HASH);
    const texts = (name: string) =>
      screen
        .getByRole("list", { name })
        .getByRole("listitem")
        .elements()
        .map((row) => row.textContent ?? "");

    await expect
      .element(screen.getByRole("list", { name: "Origem das oportunidades" }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Oportunidades criadas nos últimos 90 dias: 17"),
      )
      .toBeVisible();
    expect(texts("Origem das oportunidades")).toEqual([
      "Google Ads7",
      "Orgânico4",
      "Indicação3",
      "Sem origem registrada2",
      "Várias origens1",
    ]);
    expect(texts("Convertidas")).toEqual([
      expect.stringContaining("Oportunidade #113 · 02/03/2030"),
      expect.stringContaining("Oportunidade #114 · 20/02/2030"),
    ]);
    expect(texts("Convertidas")[0]).toMatch(
      /Valor informado: R\$\s1\.200 · Origem: Google Ads/,
    );
    expect(texts("Perdidas")).toEqual([
      "Oportunidade #115 · 03/03/2030 · Motivo: Sem resposta · Etapa: Conversa ativa",
      "Oportunidade #116 · 26/02/2030 · Motivo: Preço · Etapa: Contato iniciado",
      "Oportunidade #117 · 12/02/2030 · Motivo: Adiado · Etapa: Sessão inicial agendada",
    ]);
  });

  it("with no opportunity, shows empty columns, no rate and no history instead of measured zeros", async () => {
    const screen = await renderCompanyOs(withFunnel(emptyFunnel()), HASH);

    await expect
      .element(screen.getByRole("group", { name: "Quadro do funil" }))
      .toBeVisible();
    expect(
      screen.getByText("Nenhuma oportunidade.", { exact: true }).elements(),
    ).toHaveLength(9);
    const rate =
      screen
        .getByText("Taxa de fechamento — 30 dias", { exact: true })
        .element()
        .closest("div")?.parentElement?.textContent ?? "";
    expect(rate).toContain("—");
    expect(rate).toContain("Nenhuma oportunidade encerrada em 30 dias");
    await expect
      .element(screen.getByText(/^Nenhuma movimentação registrada ainda\./))
      .toBeVisible();
    await expect
      .element(screen.getByText("Nenhuma conversão no período."))
      .toBeVisible();
    await expect
      .element(screen.getByText("Nenhuma perda no período."))
      .toBeVisible();
    await expect
      .element(screen.getByText("Nenhuma oportunidade criada no período."))
      .toBeVisible();
  });

  it("says plainly when there is no CRM funnel, or when its stages are not saved or not valid", async () => {
    const notConfigured = await renderCompanyOs(
      withFunnel({ status: "not_configured" } as never),
      HASH,
    );
    await expect
      .element(notConfigured.getByText("Funil comercial não configurado"))
      .toBeVisible();
    await notConfigured.unmount();

    // The shared recording's tenant owns the CRM but stores no stages.
    const missing = await renderCompanyOs(createRecordedSession(), HASH);
    await expect
      .element(missing.getByText("Etapas do funil não configuradas"))
      .toBeVisible();
    await expect
      .element(missing.getByText(/salve as etapas para que o funil apareça/))
      .toBeVisible();
    expect(
      missing.getByRole("group", { name: "Quadro do funil" }).query(),
    ).toBeNull();
    await missing.unmount();

    const invalid = await renderCompanyOs(
      withFunnel({
        status: "stages_not_configured",
        reason: "invalid",
      } as never),
      HASH,
    );
    await expect
      .element(invalid.getByText(/incompleta ou inválida/))
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
    expect(screen.getByText("Etapas do funil").query()).toBeNull();
  });

  it("renders every headline as unknown, and no board, once the answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(withFunnel(), HASH, {
      clock: () => Date.now() + skew,
    });
    await expect
      .element(screen.getByRole("group", { name: "Quadro do funil" }))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(
      screen.getByRole("group", { name: "Quadro do funil" }).query(),
    ).toBeNull();
    expect(
      screen.getByText("Desconhecido", { exact: true }).elements().length,
    ).toBe(7);
  });

  it("offers no control that creates, moves, wins or loses an opportunity, nothing draggable, and no name, contact or identifier", async () => {
    const session = withFunnel();
    const screen = await renderCompanyOs(session, HASH);
    await expect
      .element(screen.getByRole("group", { name: "Quadro do funil" }))
      .toBeVisible();
    const page = screen
      .getByRole("heading", { name: "Funil comercial", level: 1 })
      .element()
      .closest("div")?.parentElement;

    expect(
      page?.querySelectorAll("button, input, select, textarea, form"),
    ).toHaveLength(0);
    expect(page?.querySelectorAll("[draggable='true']")).toHaveLength(0);
    expect(page?.textContent).not.toMatch(
      /REC-|@|\+55|gclid|campanha|campaign|palavra-chave/i,
    );
    expect(page?.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
    // The screen only reads (the shell's operator context and the
    // overview); it never calls either browser act.
    const operations = new Set(session.calls.map((c) => c.operation));
    expect(operations.has("overview")).toBe(true);
    expect(
      [...operations].every(
        (o) => o === "overview" || o === "operator_context",
      ),
    ).toBe(true);
    expect(session.callsOf("decide_review")).toHaveLength(0);
    expect(session.callsOf("trip_stop")).toHaveLength(0);
  });
});
