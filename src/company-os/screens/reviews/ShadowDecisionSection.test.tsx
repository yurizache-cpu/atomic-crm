import type { RenderResult } from "vitest-browser-react";

import {
  SHADOW_BADGE,
  SHADOW_NOTE,
  SHADOW_POLICY_REQUIRED,
  SHADOW_REASON_LABELS,
  SHADOW_REASON_UNKNOWN,
  SHADOW_STATE_TEXT,
  SHADOW_TITLE,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Phase 2D.1's shadow decision on a review's page, from the recorded
// projection and hand-built states: read only, labelled shadow mode, human
// review always required, no control of its own, and never a recommendation
// that was not stored. The decisions a person may make are the same with it
// or without it.

const reviewPage = (label: string) => `#/company-os/reviews/${rid(label)}`;

const region = (screen: RenderResult) =>
  screen.getByRole("region", { name: SHADOW_TITLE });

const COMPLETED = recorded("get_review", {
  p_review_id: rid("review:open"),
}).shadowDecision!;

/** get_review for `label`, as recorded, with its shadow decision replaced. */
const withShadow = (label: string, shadowDecision: unknown) => {
  const session = createRecordedSession();
  session.answer("get_review", (args) =>
    ok(
      args.p_review_id === rid(label)
        ? { ...recorded("get_review", args), shadowDecision }
        : recorded("get_review", args),
    ),
  );
  return session;
};

const evaluation = (overrides: Record<string, unknown>) => ({
  ...COMPLETED,
  ...overrides,
});

describe("the shadow decision on a review", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("shows the recommendation, its confidence and the policy, in shadow mode, next to the person's own decisions", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, reviewPage("review:open"));

    const shadow = region(screen);
    await expect.element(shadow).toBeVisible();
    for (const text of [
      SHADOW_BADGE,
      SHADOW_NOTE,
      "Aceitar",
      "82%",
      `Recomendação disponível · ${SHADOW_POLICY_REQUIRED}`,
      "Simulação determinística (não é o Jev)",
    ]) {
      await expect.element(shadow).toHaveTextContent(text);
    }
    // No control of its own; the person's decisions are untouched.
    expect(shadow.getByRole("button").elements()).toHaveLength(0);
    await expect
      .element(
        screen
          .getByRole("group", { name: "Registrar decisão" })
          .getByRole("button", { name: "Rejeitar" }),
      )
      .toBeVisible();
    expect(session.callsOf("decide_review")).toEqual([]);
    expect(document.body.textContent).not.toMatch(/sha256|inputFingerprint/);
  });

  it("names the reasons as the owner reads them, and the policy and provider versions, keeping the codes technical", async () => {
    const screen = await renderCompanyOs(
      withShadow(
        "review:open",
        evaluation({
          reasonCodes: [
            "intent_pricing",
            "flag_possible_crisis",
            "legacy_reason",
          ],
        }),
      ),
      reviewPage("review:open"),
    );

    const shadow = region(screen);
    await expect
      .element(shadow)
      .toHaveTextContent(
        `Motivos${SHADOW_REASON_LABELS.intent_pricing} · ${SHADOW_REASON_LABELS.flag_possible_crisis} · ${SHADOW_REASON_UNKNOWN}`,
      );
    await expect.element(shadow).toHaveTextContent("Versão da políticav2");
    await expect
      .element(shadow)
      .toHaveTextContent("Simulação determinística (não é o Jev) · versão 2");
    // The raw codes sit only under the technical details.
    const owner = shadow.element().querySelector("dl");
    const technical = shadow.element().querySelector("details");
    expect(owner?.textContent).not.toMatch(/intent_pricing|decision_shadow/);
    expect(technical?.textContent).toContain(
      "intent_pricing, flag_possible_crisis, legacy_reason",
    );
    expect(technical?.textContent).toContain("decision_shadow.v2");
  });

  it("says a review outside the synthetic and test scope is not evaluated", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      reviewPage("review:no-origin"),
    );

    await expect
      .element(region(screen))
      .toHaveTextContent(SHADOW_STATE_TEXT.unavailable);
    expect(
      region(screen).getByText("Recomendação", { exact: true }).query(),
    ).toBeNull();
  });

  it.each([
    ["no evaluation", null, SHADOW_STATE_TEXT.none],
    [
      "a pending one",
      evaluation({
        status: "pending",
        recommendation: null,
        confidence: null,
        caution: null,
        reasonCodes: [],
        policy: { outcome: null, humanReviewRequired: true },
        settledAt: null,
      }),
      SHADOW_STATE_TEXT.pending,
    ],
    [
      "an indeterminate one",
      evaluation({
        status: "indeterminate",
        recommendation: null,
        confidence: null,
        caution: null,
        reasonCodes: [],
        policy: {
          outcome: "provider_indeterminate",
          humanReviewRequired: true,
        },
      }),
      SHADOW_STATE_TEXT.indeterminate,
    ],
    [
      "an invalid one",
      evaluation({
        status: "invalid",
        recommendation: null,
        confidence: null,
        caution: null,
        reasonCodes: [],
        policy: { outcome: "provider_invalid", humanReviewRequired: true },
      }),
      SHADOW_STATE_TEXT.invalid,
    ],
    [
      "a failed one",
      evaluation({
        status: "failed",
        recommendation: null,
        confidence: null,
        caution: null,
        reasonCodes: [],
        policy: { outcome: "provider_failed", humanReviewRequired: true },
        provider: { kind: "jev", id: "jev", version: "unconnected" },
      }),
      SHADOW_STATE_TEXT.failed,
    ],
    [
      "one requested under a policy since retired",
      evaluation({
        status: "refused",
        policyVersion: "decision_shadow.v1",
        recommendation: null,
        confidence: null,
        caution: null,
        reasonCodes: [],
        policy: { outcome: null, humanReviewRequired: true },
        provider: null,
        refusal: "policy_retired",
      }),
      SHADOW_STATE_TEXT.refused_policy_retired,
    ],
    [
      "one refused under a stop",
      evaluation({
        status: "refused",
        recommendation: null,
        confidence: null,
        caution: null,
        reasonCodes: [],
        policy: { outcome: null, humanReviewRequired: true },
        provider: null,
        refusal: "stopped",
      }),
      SHADOW_STATE_TEXT.refused_stopped,
    ],
  ])(
    "says so, with no recommendation, for %s",
    async (_label, shadow, text) => {
      const screen = await renderCompanyOs(
        withShadow("review:open", shadow),
        reviewPage("review:open"),
      );

      await expect.element(region(screen)).toHaveTextContent(text);
      expect(
        region(screen).getByText("Recomendação", { exact: true }).query(),
      ).toBeNull();
      expect(
        region(screen).getByText("Confiança", { exact: true }).query(),
      ).toBeNull();
    },
  );

  it.each([
    ["the same decision", "accept", "Sim"],
    ["another decision", "reject", "Não"],
    ["an abstention", "abstain", "Não se aplica"],
  ])(
    "compares a decided review with the recommendation, observationally, for %s",
    async (_label, recommendation, agreement) => {
      const screen = await renderCompanyOs(
        withShadow("review:accepted-1", evaluation({ recommendation })),
        reviewPage("review:accepted-1"),
      );

      const shadow = region(screen);
      await expect.element(shadow).toHaveTextContent("Resultado humanoAceita");
      await expect
        .element(shadow)
        .toHaveTextContent(`Concordância com a recomendação${agreement}`);
    },
  );

  it("refuses a projection claiming the recommendation stands for the person", async () => {
    const screen = await renderCompanyOs(
      withShadow(
        "review:open",
        evaluation({
          policy: {
            outcome: "recommendation_available",
            humanReviewRequired: false,
          },
        }),
      ),
      reviewPage("review:open"),
    );

    await expect
      .element(screen.getByRole("button", { name: "Tentar de novo" }))
      .toBeVisible();
    expect(region(screen).query()).toBeNull();
  });
});
