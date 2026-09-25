import type { OverviewSummary } from "../../../../contracts/company-os-api/index.ts";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { moneyLabel } from "../../format/ptBR";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { ok, refused } from "../../testing/fakeSession";
import { createRecordedSession, recorded } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Saúde operacional (Phase 2E.2), fed with the overview the real projection
// returned for the recorded tenant (testing/recorded/tenant.json): 5 jobs
// ready, 1 running, 1 scheduled and 1 past its lease; runs that failed, ended
// uncertain and wait; a failed, a blocked and an uncertain send; 3 pending
// reviews and 3 active stops. Every number is the server's, every control is
// a link, and nothing is a score.

const HASH = "#/company-os/health";

const withHealth = (
  patch: (overview: OverviewSummary) => OverviewSummary,
): OverviewSummary => patch(structuredClone(recorded("overview")));

const quietOverview = (): OverviewSummary =>
  withHealth((overview) => ({
    ...overview,
    runs: { ...overview.runs, needingAttention: 0 },
    stops: { tenantScopedActive: 0 },
    platform: { globalAdmissionBlocked: false },
    outbound: { ...overview.outbound, indeterminateOpen: 0 },
    operationalHealth: {
      ...overview.operationalHealth,
      queue: {
        ...overview.operationalHealth.queue,
        expiredLeases: 0,
        failedInWindow: 0,
      },
      queueByKind: overview.operationalHealth.queueByKind.map((row) => ({
        ...row,
        ready: row.ready,
        expiredLeases: 0,
        failedInWindow: 0,
      })),
      agentRuns: {
        ...overview.operationalHealth.agentRuns,
        inWindowByStatus: { succeeded: 3 },
      },
      decisions: {
        ...overview.operationalHealth.decisions,
        inWindow: {
          ...overview.operationalHealth.decisions.inWindow,
          indeterminate: 0,
          failed: 0,
          invalid: 0,
        },
      },
      outbound: { inWindowByStatus: { sent: 2 } },
    },
  }));

describe("the Saúde operacional screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows the queue, execution, failure, uncertainty, review, stop and cost headlines from the recorded answer", async () => {
    const health = recorded("overview").operationalHealth;
    const screen = await renderCompanyOs(createRecordedSession(), HASH);

    await expect
      .element(screen.getByRole("heading", { name: "Saúde operacional" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Prontos para executar · mais 1 agendados"))
      .toBeVisible();
    await expect.element(screen.getByText("1 passaram do prazo")).toBeVisible();
    for (const [name, href] of [
      ["Falhas recentes: 2", "#/company-os/runs"],
      ["Resultado incerto: 3", "#/company-os/runs?attention=1"],
      ["Revisões pendentes: 3", "#/company-os/reviews"],
      ["Pausas ativas: 3", "#/company-os/stops"],
      [
        `Custo hoje: ${moneyLabel(health.spend.chargedToday)}`,
        "#/company-os/costs",
      ],
    ] as const) {
      await expect
        .element(screen.getByRole("link", { name, exact: true }))
        .toHaveAttribute("href", href);
    }
  });

  it("lists under Precisa de atenção only concrete states, each linking to its proof", async () => {
    const screen = await renderCompanyOs(createRecordedSession(), HASH);

    for (const [text, href] of [
      [
        "1 execução passou do prazo sem concluir; um trabalhador ativo as devolve à fila na próxima verificação",
        "#/company-os/runs?attention=1",
      ],
      [
        "2 execuções de agente precisam de atenção (resultado incerto ou sem trabalho ativo)",
        "#/company-os/runs?attention=1",
      ],
      [
        "1 envio com resultado incerto em aberto",
        "#/company-os/communications",
      ],
      [
        "3 pausas ativas bloqueiam execuções desta empresa",
        "#/company-os/stops",
      ],
      ["2 falhas registradas nas últimas 24 h", "#/company-os/runs"],
    ] as const) {
      await expect
        .element(screen.getByRole("link", { name: text, exact: true }))
        .toHaveAttribute("href", href);
    }
    // No grade, no percentage, no judged age anywhere on the page.
    const page = screen
      .getByRole("heading", { name: "Saúde operacional" })
      .element()
      .closest("div")?.parentElement;
    expect(page?.textContent).toContain("Precisa de atenção");
    expect(
      page?.textContent?.match(
        /[0-9]+ ?%|pontua|score|saudável|atrasad|lento|nota /i,
      )?.[0],
    ).toBeUndefined();
  });

  it("says nothing needs attention when no concrete state calls for it", async () => {
    const session = createRecordedSession();
    session.answer("overview", () => ok(quietOverview()));
    const screen = await renderCompanyOs(session, HASH);

    await expect
      .element(screen.getByText("Nada exige atenção agora."))
      .toBeVisible();
  });

  it("shows a latency percentile only from its minimum sample, and always the sample size", async () => {
    const screen = await renderCompanyOs(createRecordedSession(), HASH);
    const latency = screen.getByLabelText("Tempo de resposta do modelo");

    await expect.element(latency).toHaveTextContent("Mediana (p50)");
    await expect
      .element(latency)
      .toHaveTextContent("Aparece a partir de 5 amostras");
    await expect
      .element(latency)
      .toHaveTextContent("Aparece a partir de 20 amostras");
    await screen.unmount();

    const session = createRecordedSession();
    session.answer("overview", () =>
      ok(
        withHealth((overview) => ({
          ...overview,
          operationalHealth: {
            ...overview.operationalHealth,
            agentRuns: {
              ...overview.operationalHealth.agentRuns,
              latency: {
                sampleSize: 25,
                p50Ms: 820,
                p95Ms: 2400,
                minSamplesP50: 5,
                minSamplesP95: 20,
              },
            },
          },
        })),
      ),
    );
    const sampled = await renderCompanyOs(session, HASH);
    const measured = sampled.getByLabelText("Tempo de resposta do modelo");
    await expect.element(measured).toHaveTextContent("25");
    await expect.element(measured).toHaveTextContent("820 ms");
    await expect.element(measured).toHaveTextContent("2400 ms");
  });

  it("shows each external service's recorded outcomes: done, failed, uncertain and waiting", async () => {
    const screen = await renderCompanyOs(createRecordedSession(), HASH);
    const row = (name: string) =>
      screen.getByRole("row").filter({ hasText: name });

    await expect
      .element(row("Modelo de IA (execuções de agente)"))
      .toHaveTextContent("Modelo de IA (execuções de agente)1128");
    await expect
      .element(row("Motor de decisão (modo sombra)"))
      .toHaveTextContent("Motor de decisão (modo sombra)1000");
    await expect
      .element(row("WhatsApp (envios)"))
      .toHaveTextContent("WhatsApp (envios)0110");
  });

  it("renders every value as unknown once the answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(createRecordedSession(), HASH, {
      clock: () => Date.now() + skew,
    });
    await expect
      .element(screen.getByRole("link", { name: "Revisões pendentes: 3" }))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Revisões pendentes: 3" }).query(),
    ).toBeNull();
    expect(
      screen.getByText("Desconhecido", { exact: true }).elements().length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("offers only a retry when the overview cannot be read", async () => {
    const session = createRecordedSession();
    session.answer("overview", () => refused("OS500"));
    const screen = await renderCompanyOs(session, HASH);

    await expect.element(screen.getByRole("alert")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Tentar de novo" }))
      .toBeVisible();
    expect(screen.getByText("Precisa de atenção").query()).toBeNull();
  });

  it("carries no identifier, only counts, times, kinds and amounts", async () => {
    const screen = await renderCompanyOs(createRecordedSession(), HASH);
    await expect
      .element(screen.getByText("Chamadas externas", { exact: true }))
      .toBeVisible();
    const page = screen
      .getByRole("heading", { name: "Saúde operacional" })
      .element()
      .closest("div")?.parentElement;
    expect(page?.textContent).toContain("agent_run.execute");
    expect(page?.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });
});
