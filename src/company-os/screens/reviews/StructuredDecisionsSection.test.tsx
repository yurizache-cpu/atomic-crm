import type { RenderResult } from "vitest-browser-react";

import {
  SHADOW_BADGE,
  SHADOW_POLICY_REQUIRED,
  SHADOW_STATE_TEXT,
  STRUCTURED_EMPTY,
  STRUCTURED_NOTE,
  STRUCTURED_REFUSAL_TEXT,
  STRUCTURED_STATE_TEXT,
  STRUCTURED_TITLE,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";
import { decisionModelLabel } from "./shadowLabels";

// ADR 0022's structured decisions on a review's page, from the recorded
// projection and hand-built states: read only, labelled shadow mode, each
// answer beside the route the deterministic path took, never an answer that
// was not stored, and the codes, the build and the cost only under the
// technical details. The decisions a person may make are the same with it or
// without it.

const reviewPage = (label: string) => `#/company-os/reviews/${rid(label)}`;

const region = (screen: RenderResult) =>
  screen.getByRole("region", { name: STRUCTURED_TITLE });

const RECORDED = recorded("get_review", {
  p_review_id: rid("review:opened"),
}).structuredDecisions;

/** get_review for `label`, as recorded, with its structured decisions replaced. */
const withDecisions = (label: string, structuredDecisions: unknown) => {
  const session = createRecordedSession();
  session.answer("get_review", (args) =>
    ok(
      args.p_review_id === rid(label)
        ? { ...recorded("get_review", args), structuredDecisions }
        : recorded("get_review", args),
    ),
  );
  return session;
};

const businessRoute = (overrides: Record<string, unknown>) => {
  if (RECORDED.status !== "available" || RECORDED.businessRoute === null) {
    throw new Error("the recording lost its business route");
  }
  return {
    ...RECORDED,
    businessRoute: { ...RECORDED.businessRoute, ...overrides },
  };
};

describe("the structured decisions on a review", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows each answer beside the route taken, in shadow mode, next to the person's own decisions", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, reviewPage("review:opened"));

    const section = region(screen);
    await expect.element(section).toBeVisible();
    for (const text of [
      SHADOW_BADGE,
      SHADOW_POLICY_REQUIRED,
      STRUCTURED_NOTE,
      // The business route: the decision model would send it elsewhere.
      "IntençãoPedido administrativo de cliente · 91%",
      "Departamento sugeridoNight Desk · 99%",
      "Departamento usadoIntake",
      "Mesmo departamentoNão",
      "Capacidade sugeridaTriagem de contato · 70%",
      "ComplexidadeBaixa",
      "Chance de precisar de uma pessoa antes30%",
      // The lead's signals, as levels and labels, never percentages.
      "Prontidão para contratarMédia",
      "Prontidão para agendarBaixa",
      "Prioridade de retornoAlta",
      "Objeção percebidaPreço ou forma de pagamento",
      "Próximo passo sugeridoEnviar valores e pacotes",
      // The model advice beside the model that executed.
      "Modelo usadodbtest-cos-contract-model",
      "Modelo sugeridodbtest/cheaper-model · 64%",
      "Mesmo modeloNão",
      "Modelo de decisãoJev 1.13",
    ]) {
      await expect.element(section).toHaveTextContent(text);
    }
    // No control of its own; the person's decisions are untouched.
    expect(section.getByRole("button").elements()).toHaveLength(0);
    await expect
      .element(
        screen
          .getByRole("group", { name: "Registrar decisão" })
          .getByRole("button", { name: "Rejeitar" }),
      )
      .toBeVisible();
    expect(session.callsOf("decide_review")).toEqual([]);
    // Codes, the build and the question set only under the technical details.
    const owner = [...section.element().querySelectorAll("dl[aria-label]")]
      .map((list) => list.textContent)
      .join(" ");
    expect(owner).not.toMatch(
      /existing_client_admin|night-desk|business_routing|typesafe\//,
    );
    const technical = [...section.element().querySelectorAll("details")]
      .map((details) => details.textContent)
      .join(" ");
    expect(technical).toContain("business_routing.v1");
    expect(technical).toContain("typesafe/jev-1.13-20260917");
    expect(document.body.textContent).not.toMatch(
      /sha256|fingerprint|probabilities/,
    );
  });

  it("says why a decision has no answer: refused, pending, or never asked", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewPage("review:accepted-1"),
    );

    const section = region(screen);
    await expect
      .element(section)
      .toHaveTextContent(STRUCTURED_REFUSAL_TEXT.stopped);
    await expect
      .element(section)
      .toHaveTextContent(STRUCTURED_STATE_TEXT.pending);
    await expect.element(section).toHaveTextContent(STRUCTURED_STATE_TEXT.none);
    expect(
      section.getByText("Departamento sugerido", { exact: true }).query(),
    ).toBeNull();
  });

  it("says a review outside the synthetic and test scope is not evaluated", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewPage("review:no-origin"),
    );

    await expect
      .element(region(screen))
      .toHaveTextContent(SHADOW_STATE_TEXT.unavailable);
  });

  it("says when no structured decision was asked for the review", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewPage("review:open"),
    );

    await expect.element(region(screen)).toHaveTextContent(STRUCTURED_EMPTY);
  });

  it.each([
    ["indeterminate", STRUCTURED_STATE_TEXT.indeterminate],
    ["invalid", STRUCTURED_STATE_TEXT.invalid],
    ["failed", STRUCTURED_STATE_TEXT.failed],
  ] as const)(
    "shows a %s business route as no answer",
    async (status, text) => {
      const screen = await renderCompanyOs(
        withDecisions(
          "review:opened",
          businessRoute({
            status,
            answer: null,
            errorCode: "model_substituted",
          }),
        ),
        reviewPage("review:opened"),
      );

      const section = region(screen);
      await expect.element(section).toHaveTextContent(text);
      expect(
        section.getByText("Departamento sugerido", { exact: true }).query(),
      ).toBeNull();
      await expect
        .element(section)
        .toHaveTextContent("Prontidão para contratarMédia");
    },
  );

  it("names the department by the human route when no department carries the slug", async () => {
    const screen = await renderCompanyOs(
      withDecisions(
        "review:opened",
        businessRoute({
          answer: {
            ...(RECORDED.status === "available"
              ? RECORDED.businessRoute?.answer
              : {}),
            department: { slug: "human_review", name: null },
          },
        }),
      ),
      reviewPage("review:opened"),
    );

    await expect
      .element(region(screen))
      .toHaveTextContent("Departamento sugeridoRevisão humana · 99%");
  });
});

describe("the decision model's label", () => {
  it("names a Jev build by its version and any other build by its id", () => {
    expect(decisionModelLabel("typesafe/jev-1.13-20260917")).toBe("Jev 1.13");
    expect(decisionModelLabel("typesafe/jev-2")).toBe("Jev 2");
    expect(decisionModelLabel("other/decider-1")).toBe("other/decider-1");
  });
});
