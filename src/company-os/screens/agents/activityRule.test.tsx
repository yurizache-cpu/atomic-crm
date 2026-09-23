import { MemoryRouter } from "react-router";
import { render } from "vitest-browser-react";

import type { AgentSummary } from "../../../../contracts/company-os-api/index.ts";
import { recorded, rid } from "../../testing/recorded";
import { shownActivity } from "./activityRule";
import { AgentStateBadges, ListEvidence } from "./AgentState";

// The UI's own rule for "working" (docs/PHASE_2C_BRIEF.md §10, SI-57):
// "working" is printed only beside at least one working run id, whatever the
// activity value says. The response contract refuses such an answer first
// (AgentsScreen.test.tsx), so this rule is the second line: it is tested here
// on its own, with the contract bypassed, by rendering the state components
// directly with an agent the contract would never let through.

const recordedWorkingAgent = (): AgentSummary =>
  recorded("list_agents").items.find(
    (agent) => agent.id === rid("agent:lead-triage"),
  )!;

/** The recorded working agent, with its working run ids removed. */
const workingWithoutEvidence = (): AgentSummary => {
  const agent = recordedWorkingAgent();
  return {
    ...agent,
    activity: "working",
    evidence: { ...agent.evidence, workingRunIds: [] },
  };
};

describe("the working rule of the agent state", () => {
  it("prints working for an agent whose working run id is shown", () => {
    const agent = recordedWorkingAgent();

    expect(agent.evidence.workingRunIds).toEqual([rid("run:working")]);
    expect(shownActivity(agent)).toBe("working");
  });

  it("prints unknown, never working, for a working agent with no working run id, even when its answer is current", async () => {
    const agent = workingWithoutEvidence();

    const screen = await render(
      <MemoryRouter>
        <AgentStateBadges agent={agent} current />
        <ListEvidence agent={agent} current />
      </MemoryRouter>,
    );

    expect(shownActivity(agent)).toBe("unknown");
    await expect
      .element(screen.getByText("activity: unknown", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("activity: working");
    expect(document.body.textContent).not.toContain("working runs");
  });

  it("leaves every other activity as the server computed it", () => {
    const agent = recordedWorkingAgent();

    for (const activity of ["stale", "held", "queued", "idle"] as const) {
      expect(shownActivity({ ...agent, activity })).toBe(activity);
    }
  });
});
