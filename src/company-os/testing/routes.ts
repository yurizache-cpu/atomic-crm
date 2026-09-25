import type { RenderResult } from "vitest-browser-react";

import { recorded, rid } from "./recorded";
import { goTo } from "./renderCompanyOs";

// Every page of the Company OS, list and detail, with text that shows its
// recorded answer has rendered (not just its heading): the cross-screen sweeps
// (read-only controls, storage sentinel) visit each one in turn. Every marker
// is a value the real projection returned (testing/recorded/).

export interface RouteVisit {
  readonly hash: string;
  /** The page's h1. */
  readonly heading: string;
  /** Exact texts that appear only once the page's reads have answered. */
  readonly markers: readonly string[];
}

/** The pending review whose structured advice the sweeps open. */
export const ADVICE_REVIEW = rid("review:opened");

/** The pending review a member can decide from the browser (S7.1). */
export const OPEN_REVIEW = rid("review:open");

const adviceSummary = (): string => {
  const advice = recorded("get_review_advice", {
    p_review_id: ADVICE_REVIEW,
  });
  if (!("summary" in advice))
    throw new Error("The recorded advice is withheld.");
  return advice.summary;
};

export const EVERY_ROUTE: readonly RouteVisit[] = [
  {
    hash: "#/company-os",
    heading: "Visão geral",
    markers: ["Decisões pendentes"],
  },
  {
    hash: "#/company-os/agenda",
    heading: "Agenda",
    // The recorded tenant has no scheduling rows: its agenda is empty and
    // local-only (the populated agenda is testing/recorded/agenda.json).
    markers: [
      "Nenhum atendimento hoje.",
      "Nenhuma agenda com disponibilidade configurada.",
    ],
  },
  {
    hash: "#/company-os/health",
    heading: "Saúde operacional",
    markers: ["Modelo de IA (execuções de agente)", "Precisa de atenção"],
  },
  {
    hash: "#/company-os/activity",
    heading: "Atividade",
    markers: ["Envio falhou", "Synthetic pause of the follow-up desk"],
  },
  {
    hash: `#/company-os/activity/task/${rid("task:succeeded")}`,
    heading: "Cadeia da tarefa",
    markers: [
      "communication.received",
      "agent_run.succeeded",
      "Trabalho assumido por um trabalhador",
    ],
  },
  {
    hash: `#/company-os/activity/run/${rid("run:succeeded")}`,
    heading: "Cadeia da execução",
    markers: ["agent_run.started", "Trabalho assumido por um trabalhador"],
  },
  {
    hash: "#/company-os/tasks",
    heading: "Tarefas",
    markers: ["Triagem de novo lead"],
  },
  {
    hash: `#/company-os/tasks/${rid("task:accepted-1")}`,
    heading: "Tarefa",
    markers: ["Synthetic test line", "131047"],
  },
  {
    hash: "#/company-os/agents",
    heading: "Equipe de IA",
    markers: ["Lead Triage", "Queue Desk"],
  },
  {
    hash: `#/company-os/agents/${rid("agent:lead-triage")}`,
    heading: "Agente",
    markers: ["Resultado incerto"],
  },
  {
    hash: "#/company-os/runs",
    heading: "Execuções",
    markers: ["Triagem de novo lead"],
  },
  {
    hash: `#/company-os/runs/${rid("run:held")}`,
    heading: "Execução",
    markers: ["Trabalho adiado por uma pausa"],
  },
  {
    hash: "#/company-os/reviews",
    heading: "Decisões",
    markers: ["Aguardando sua revisão"],
  },
  ...(["accepted", "rejected", "needs_edit"] as const).map((status) => ({
    hash: `#/company-os/reviews?status=${status}`,
    heading: "Decisões",
    markers: [
      {
        accepted: "Aceita",
        rejected: "Rejeitada",
        needs_edit: "Precisa de ajuste",
      }[status],
    ],
  })),
  {
    // Phase 2D.3: the shadow calibration tab, read only.
    hash: "#/company-os/reviews?view=intelligence",
    heading: "Decisões",
    markers: ["Avaliações em sombra"],
  },
  {
    hash: `#/company-os/reviews/${rid("review:accepted-1")}`,
    heading: "Decisão",
    markers: ["Call back tomorrow"],
  },
  {
    // Pending and do-not-contact: no acceptance is offered.
    hash: `#/company-os/reviews/${ADVICE_REVIEW}`,
    heading: "Decisão",
    markers: [
      "Aceitar não está disponível: este contato pediu para não ser contatado.",
    ],
  },
  {
    // Pending, synthetic, decidable: the three decisions (S7.1).
    hash: `#/company-os/reviews/${OPEN_REVIEW}`,
    heading: "Decisão",
    markers: ["Aceitar"],
  },
  {
    hash: "#/company-os/stops",
    heading: "Pausas",
    markers: ["Synthetic pause of the follow-up desk"],
  },
  {
    hash: "#/company-os/stops?include=cleared",
    heading: "Pausas",
    markers: ["Drill over", "Synthetic annex pause"],
  },
  {
    hash: "#/company-os/costs",
    heading: "Custos",
    markers: ["US$ 100.000,00", "dbtest-cos-contract-model"],
  },
  {
    hash: "#/company-os/communications",
    heading: "Comunicações",
    markers: ["Synthetic test line", "Production line"],
  },
];

/** Navigates the mounted module to `route` and waits for its data. */
export const visit = async (screen: RenderResult, route: RouteVisit) => {
  if (window.location.hash !== route.hash) goTo(route.hash);
  await expect
    .element(
      screen.getByRole("heading", {
        name: route.heading,
        exact: true,
        level: 1,
      }),
    )
    .toBeVisible();
  for (const marker of route.markers) {
    await expect
      .element(screen.getByText(marker, { exact: true }).first())
      .toBeVisible();
  }
};

/** Opens the pending review's advice and waits for it. */
export const openAdvice = async (screen: RenderResult) => {
  await screen.getByRole("button", { name: "Ver análise" }).click();
  await expect
    .element(screen.getByText(adviceSummary(), { exact: true }))
    .toBeVisible();
};

/** The advice's summary, the one model-written text the sweeps open. */
export const ADVICE_SUMMARY = adviceSummary();
