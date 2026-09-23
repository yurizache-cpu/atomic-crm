import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { render } from "vitest-browser-react";

import CompanyOsApp from "../CompanyOsApp";
import { createFakeSession, ok } from "../testing/fakeSession";
import {
  TENANT_A,
  USER_A,
  operatorContext,
  syntheticId,
  withheldAdvice,
} from "../testing/samples";
import { useReviewAdvice } from "./useReviewAdvice";

// The one content read (docs/PHASE_2C_BRIEF.md §13 item 3): read only on an
// explicit open, never again behind the operator's back, and gone from the
// cache the moment the advice view closes.

const REVIEW_ID = syntheticId(401);

const AdviceView = () => {
  const advice = useReviewAdvice(REVIEW_ID);
  const answer = advice.data;
  return (
    <p>
      {answer !== undefined && "withheld" in answer
        ? `Advice withheld: ${answer.withheld}`
        : "Reading advice"}
    </p>
  );
};

const createAdviceProbe = () => {
  let captured: QueryClient | undefined;
  const Screen = () => {
    captured = useQueryClient();
    const [open, setOpen] = useState(false);
    return (
      <section aria-label="Advice probe">
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? "Close advice" : "Open advice"}
        </button>
        {open ? <AdviceView /> : null}
      </section>
    );
  };
  const adviceQueries = () =>
    captured
      ?.getQueryCache()
      .getAll()
      .filter((query) => query.queryKey.includes("get_review_advice")) ?? [];
  return { Screen, adviceQueries };
};

describe("the review advice read", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("is read on explicit open only, once, and leaves the cache when its view closes", async () => {
    const session = createFakeSession(USER_A);
    session.answer("operator_context", () =>
      ok(operatorContext(TENANT_A, "Synthetic Clinic")),
    );
    session.answer("get_review_advice", () => ok(withheldAdvice(REVIEW_ID)));
    const probe = createAdviceProbe();
    history.replaceState(null, "", "#/company-os");
    const screen = await render(
      <CompanyOsApp
        session={session.port}
        screens={{ overview: probe.Screen }}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Open advice" }))
      .toBeVisible();
    expect(session.callsOf("get_review_advice")).toEqual([]);

    await screen.getByRole("button", { name: "Open advice" }).click();
    await expect
      .element(
        screen.getByText("Advice withheld: origin_not_synthetic_or_test"),
      )
      .toBeVisible();
    expect(probe.adviceQueries()).toHaveLength(1);
    // The tab becomes visible again: the advice is not read again.
    window.dispatchEvent(new Event("visibilitychange"));

    await screen.getByRole("button", { name: "Close advice" }).click();

    await expect.poll(() => probe.adviceQueries()).toEqual([]);
    expect(session.callsOf("get_review_advice")).toEqual([
      { operation: "get_review_advice", args: { p_review_id: REVIEW_ID } },
    ]);
  });
});
