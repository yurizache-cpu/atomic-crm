import { render } from "vitest-browser-react";

import type { CommercialRequest } from "../../query/useCommercialAct";
import { recordedFunnel } from "../../testing/recorded";
import {
  CHANGED_WHILE_OPEN_TEXT,
  OpportunityActionPanel,
} from "./OpportunityActions";

// An open act panel keeps the revision the card showed when it opened
// (Phase 3B.2, final review): the funnel is read again every 15 s, and a card
// that changed under an open panel must never lend it its newer revision, or
// the act would overwrite the change instead of being refused as stale.

const funnel = recordedFunnel();
const card = funnel.stages
  .find((s) => s.code === "contact_started")!
  .cards.find((c) => c.dealRef === 103)!;
const NEWER = `r1.${"e".repeat(32)}`;

describe("an open commercial act panel", () => {
  it("sends the revision it was opened on, and refuses to confirm once the card changed under it", async () => {
    const sent: CommercialRequest[] = [];
    const panel = (shown = card) => (
      <OpportunityActionPanel
        kind="next"
        card={shown}
        funnel={funnel}
        revision={card.revision}
        pending={false}
        onSubmit={(request) => sent.push(request)}
        onCancel={() => {}}
      />
    );
    const screen = await render(panel());

    // Opened on the card as shown: a new instant goes with that revision.
    await screen.getByLabelText("Horário").fill("15:45");
    await screen.getByRole("button", { name: "Salvar próxima ação" }).click();
    expect(sent.map((r) => r.input.p_expected_revision)).toEqual([
      card.revision,
    ]);

    // Another person changed the opportunity; the poll brought it in.
    await screen.rerender(
      panel({
        ...card,
        revision: NEWER,
        nextActionAt: "2030-03-09T18:00:00.000000Z",
        nextAction: "future",
      }),
    );
    await expect
      .element(screen.getByText(CHANGED_WHILE_OPEN_TEXT))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Salvar próxima ação" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Remover próxima ação" }))
      .toBeDisabled();
    // The owner's own input still reflects what they saw, not the new value.
    await expect.element(screen.getByLabelText("Horário")).toHaveValue("15:45");
    expect(sent).toHaveLength(1);
  });

  it("does not offer to save an existing next action left untouched", async () => {
    const screen = await render(
      <OpportunityActionPanel
        kind="next"
        card={card}
        funnel={funnel}
        revision={card.revision}
        pending={false}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Salvar próxima ação" }))
      .toBeDisabled();
    await screen.getByLabelText("Horário").fill("11:00");
    await expect
      .element(screen.getByRole("button", { name: "Salvar próxima ação" }))
      .toBeEnabled();
  });
});
