import { CONTRACT_ERROR_TEXT } from "../../components/queryErrors";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 4 (docs/PHASE_2C_BRIEF.md §10, §12, §16 "Working state"), fed with
// the agents the real projection returned: "Trabalhando" appears only with at
// least one working run, each linking to its run; "Pausado" and "Trabalhando"
// show together when both hold (the recorded tenant under an active job_kind
// stop); the ids that prove a state stay in the card's technical details; a
// state older than two polling intervals is "Desconhecido"; and an agent whose
// state breaks its contract is not rendered at all.

const runHref = (id: string) => `#/company-os/runs/${id}`;

describe("the Agents screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows working and stopped together, with the working run and the stop that prove them", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession("tenant-kind-stop"),
      "#/company-os/agents",
    );
    const card = screen.getByRole("article", { name: "Agente Lead Triage" });

    await expect.element(card).toHaveTextContent("Pausado");
    await expect.element(card).toHaveTextContent("Trabalhando");
    await expect
      .element(
        card.getByRole("link", { name: `Execução ${rid("run:working")}` }),
      )
      .toHaveAttribute("href", runHref(rid("run:working")));
    await expect.element(card).toHaveTextContent(rid("stop:kind-active"));
  });

  it("shows every activity the projection computed, each with the ids that prove it", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/agents",
    );
    const cardOf = (name: string) =>
      screen.getByRole("article", { name: `Agente ${name}` });

    await expect
      .element(cardOf("Night Desk Agent"))
      .toHaveTextContent("Sem sinal do trabalho");
    await expect
      .element(cardOf("Night Desk Agent"))
      .toHaveTextContent(rid("run:stale"));
    await expect
      .element(cardOf("Follow Up"))
      .toHaveTextContent("Retido por pausa");
    await expect
      .element(cardOf("Follow Up"))
      .toHaveTextContent(rid("run:held"));
    await expect
      .element(cardOf("Queue Desk"))
      .toHaveTextContent("Com trabalho na fila");
    await expect
      .element(cardOf("Queue Desk"))
      .toHaveTextContent(rid("run:queued"));
    await expect
      .element(cardOf("Archive"))
      .toHaveTextContent("Inativo por decisão de configuração (agent).");
    await expect.element(cardOf("Archive")).toHaveTextContent("Ocioso");
    await expect
      .element(cardOf("Closed Desk"))
      .toHaveTextContent("Inativo por decisão de configuração (company).");
  });

  it("filters the one list it read by activity, without another read", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/agents");
    await expect
      .element(screen.getByRole("link", { name: "Abrir Queue Desk" }))
      .toBeVisible();

    await screen
      .getByLabelText("Atividade", { exact: true })
      .selectOptions("working");

    await expect
      .element(screen.getByRole("link", { name: "Abrir Queue Desk" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("link", { name: "Abrir Lead Triage" }))
      .toBeVisible();
    expect(session.callsOf("list_agents")).toHaveLength(1);
  });

  it("opens an agent with every id that proves its state, and its recent runs", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/agents/${rid("agent:lead-triage")}`,
    );

    const evidence = screen.getByLabelText("O que comprova a situação");
    await expect
      .element(
        evidence.getByRole("link", {
          name: `Execução ${rid("run:indeterminate")}`,
        }),
      )
      .toHaveAttribute("href", runHref(rid("run:indeterminate")));
    await expect
      .element(
        evidence.getByRole("link", { name: `Execução ${rid("run:working")}` }),
      )
      .toHaveAttribute("href", runHref(rid("run:working")));
    await expect
      .element(evidence)
      .toHaveTextContent("nenhuma pausa desta empresa cobre este agente");
    await expect
      .element(screen.getByRole("list", { name: "Execuções recentes" }))
      .toHaveTextContent(rid("run:succeeded"));
  });

  it("names the stop that covers a stopped agent, with its scope", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/agents/${rid("agent:follow-up")}`,
    );

    await expect
      .element(screen.getByLabelText("O que comprova a situação"))
      .toHaveTextContent(`${rid("stop:agent")}alcance: agente`);
  });

  it("renders the state as unknown, and no working run, once the answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/agents",
      { clock: () => Date.now() + skew },
    );
    const team = screen.getByRole("list", { name: "Equipe de IA" });
    await expect
      .element(team.getByText("Trabalhando", { exact: true }))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(team.getByText("Trabalhando", { exact: true }).query()).toBeNull();
    expect(
      screen
        .getByRole("link", { name: `Execução ${rid("run:working")}` })
        .query(),
    ).toBeNull();
    await expect
      .element(team.getByText("Desconhecido", { exact: true }).first())
      .toBeVisible();
  });

  it("renders a live recent run's status as unknown once the answer is too old, and keeps a settled run's", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/agents/${rid("agent:lead-triage")}`,
      { clock: () => Date.now() + skew },
    );
    const recentRuns = screen.getByRole("list", { name: "Execuções recentes" });
    await expect.element(recentRuns).toHaveTextContent("Executando");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    await expect.element(recentRuns).toHaveTextContent("Desconhecido");
    await expect.element(recentRuns).not.toHaveTextContent("Executando");
    await expect.element(recentRuns).not.toHaveTextContent("Na fila");
    await expect.element(recentRuns).toHaveTextContent("Concluída");
  });

  it("renders an error, not the agent, when a working agent comes without a working run", async () => {
    // Hand-built on purpose: the projection never answers "working" without a
    // working run id, so only a tampered answer can reach the contract's
    // tripwire. It is the recorded agent with its evidence removed.
    const session = createRecordedSession();
    const list = recorded("list_agents");
    const working = list.items.find((agent) => agent.activity === "working")!;
    const impostor = {
      ...working,
      name: "Agent Without Evidence",
      evidence: { ...working.evidence, workingRunIds: [] },
    };
    session.answer("list_agents", () => ok({ ...list, items: [impostor] }));

    const screen = await renderCompanyOs(session, "#/company-os/agents");

    await expect
      .element(screen.getByText(CONTRACT_ERROR_TEXT).first())
      .toBeVisible();
    expect(document.body.textContent).not.toContain(impostor.name);
    expect(
      screen.getByRole("list", { name: "Equipe de IA" }).query(),
    ).toBeNull();
  });
});
