import type { RenderResult } from "vitest-browser-react";

import type { DecisionIntelligenceGroup } from "../../../../contracts/company-os-api/index.ts";
import {
  DECISION_INTELLIGENCE_CARDS,
  DECISION_INTELLIGENCE_DESCRIPTION,
  DECISION_INTELLIGENCE_DISTRIBUTION_HIDDEN,
  DECISION_INTELLIGENCE_EMPTY,
  DECISION_INTELLIGENCE_EXPLANATION,
  DECISION_INTELLIGENCE_SMALL_SAMPLE,
  DECISION_INTELLIGENCE_TAB,
  SHADOW_BADGE,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Phase 2D.3: Decisões → Inteligência, the shadow calibration counts, read
// only. Agreement is shown with its sample, a rate only once the sample allows
// it, and never as accuracy or a score; the distribution only with enough
// evaluations; and the page offers no control.

const PAGE = "#/company-os/reviews?view=intelligence";

const group = (
  overrides: Partial<DecisionIntelligenceGroup>,
): DecisionIntelligenceGroup => ({
  policyVersion: "decision_shadow.v2",
  provider: { kind: "fake", id: "fake-rules", version: "2" },
  evaluations: 0,
  recommendations: 0,
  abstained: 0,
  pending: 0,
  indeterminate: 0,
  invalid: 0,
  failed: 0,
  refused: 0,
  withHumanDecision: 0,
  comparable: 0,
  agreements: 0,
  disagreements: 0,
  byRecommendation: { accept: 0, needs_edit: 0, reject: 0, abstain: 0 },
  byHumanOutcome: { pending: 0, accepted: 0, rejected: 0, needs_edit: 0 },
  ...overrides,
});

/** The recorded overview, with its calibration groups replaced. */
const withGroups = (groups: DecisionIntelligenceGroup[]) => {
  const session = createRecordedSession();
  session.answer("overview", () =>
    ok({
      ...recorded("overview"),
      decisionIntelligence: {
        mode: "shadow",
        currentPolicyVersion: "decision_shadow.v2",
        groups,
      },
    }),
  );
  return session;
};

/** A card's label: the first match, ahead of the distribution's own terms. */
const card = (screen: RenderResult, label: string) =>
  screen.getByText(label, { exact: true }).first();

/** Twelve v2 evaluations with their human outcomes, and one older v1 group. */
const BUSY = [
  group({
    evaluations: 12,
    recommendations: 9,
    abstained: 2,
    indeterminate: 1,
    withHumanDecision: 10,
    comparable: 8,
    agreements: 6,
    disagreements: 2,
    byRecommendation: { accept: 5, needs_edit: 2, reject: 2, abstain: 2 },
    byHumanOutcome: { pending: 2, accepted: 5, rejected: 2, needs_edit: 3 },
  }),
  group({
    policyVersion: "decision_shadow.v1",
    provider: { kind: "fake", id: "fake-rules", version: "1" },
    evaluations: 3,
    recommendations: 3,
    withHumanDecision: 3,
    comparable: 3,
    agreements: 1,
    disagreements: 2,
    byRecommendation: { accept: 3, needs_edit: 0, reject: 0, abstain: 0 },
    byHumanOutcome: { pending: 0, accepted: 1, rejected: 1, needs_edit: 1 },
  }),
];

describe("the decision intelligence view", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("is a tab of Decisões, in shadow mode, with its explanation", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/reviews",
    );

    await screen
      .getByRole("link", { name: DECISION_INTELLIGENCE_TAB, exact: true })
      .click();

    await expect
      .element(screen.getByText(DECISION_INTELLIGENCE_EXPLANATION))
      .toBeVisible();
    await expect
      .element(screen.getByText(SHADOW_BADGE, { exact: true }))
      .toBeVisible();
    // Neutral: the decisions compared are the recorded ones, which in a
    // synthetic demo are fixtures, never "your" decisions.
    await expect
      .element(screen.getByText(DECISION_INTELLIGENCE_DESCRIPTION))
      .toBeVisible();
    expect(document.body.textContent).not.toMatch(/suas decisões/);
    expect(location.hash).toBe(PAGE);
  });

  it("counts the current version: every card, agreement with its denominator, and a rate only with enough comparisons", async () => {
    const screen = await renderCompanyOs(withGroups(BUSY), PAGE);

    for (const [key, value] of [
      ["evaluations", 12],
      ["withHumanDecision", 10],
      ["agreements", 6],
      ["disagreements", 2],
      ["abstained", 2],
      ["indeterminate", 1],
    ] as const) {
      const label = card(screen, DECISION_INTELLIGENCE_CARDS[key]);
      await expect.element(label).toBeVisible();
      // The card's value sits right under its label.
      expect(
        label.element().parentElement?.nextElementSibling?.textContent,
      ).toBe(String(value));
    }
    await expect
      .element(screen.getByText("Concordância: 6 de 8 comparáveis (75%)"))
      .toBeVisible();
    // The older version is listed apart, never added to the current one.
    await expect
      .element(screen.getByText(/Política v1 \(anterior\)/))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          `3 avaliações · concordância 1 de 3 comparáveis. ${DECISION_INTELLIGENCE_SMALL_SAMPLE}`,
        ),
      )
      .toBeVisible();
    // The distribution, by recommendation and by human outcome.
    expect(
      screen.getByLabelText("Recomendações do motor").element().textContent,
    ).toBe("Aceitar5Precisa de ajuste2Rejeitar2Sem recomendação2");
    expect(
      screen.getByLabelText("Decisões humanas").element().textContent,
    ).toBe("Aguardando sua revisão2Aceita5Rejeitada2Precisa de ajuste3");
    // No control, and never accuracy, precision or a score outside the
    // explanation that says it is none of them.
    expect(
      screen.getByRole("button", { name: /Aceitar|Rejeitar/ }).query(),
    ).toBeNull();
    const text = (document.body.textContent ?? "").replace(
      DECISION_INTELLIGENCE_EXPLANATION,
      "",
    );
    expect(text).not.toMatch(
      /acur[áa]cia|precis[ãa]o|pontua[çc][ãa]o|score|nota do motor/i,
    );
  });

  it("shows counts but no rate and no distribution on a small sample", async () => {
    const screen = await renderCompanyOs(
      withGroups([
        group({
          evaluations: 3,
          recommendations: 3,
          withHumanDecision: 2,
          comparable: 2,
          agreements: 1,
          disagreements: 1,
          byRecommendation: { accept: 3, needs_edit: 0, reject: 0, abstain: 0 },
          byHumanOutcome: {
            pending: 1,
            accepted: 1,
            rejected: 0,
            needs_edit: 1,
          },
        }),
      ]),
      PAGE,
    );

    await expect
      .element(
        screen.getByText(
          `Concordância: 1 de 2 comparáveis. ${DECISION_INTELLIGENCE_SMALL_SAMPLE}`,
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText(DECISION_INTELLIGENCE_DISTRIBUTION_HIDDEN))
      .toBeVisible();
    expect(document.body.textContent).not.toMatch(/\d+%/);
  });

  it("says when nothing was evaluated yet", async () => {
    const screen = await renderCompanyOs(withGroups([]), PAGE);

    await expect
      .element(screen.getByText(DECISION_INTELLIGENCE_EMPTY))
      .toBeVisible();
  });
});
