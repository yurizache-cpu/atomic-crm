import { CONTRACT_ERROR_TEXT } from "../../components/queryErrors";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 4 (docs/PHASE_2C_BRIEF.md §10, §12, §16 "Working state"), fed with
// the agents the real projection returned: "working" appears only with at
// least one working run id, each linking to its run; stopped and working show
// together when both hold (the recorded tenant under an active job_kind stop);
// the ids that prove a state are shown; a state older than two polling
// intervals is "unknown"; and an agent whose state breaks its contract is not
// rendered at all.

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
    const row = screen.getByRole("row").filter({ hasText: "Lead Triage" });

    await expect.element(row).toHaveTextContent("availability: stopped");
    await expect.element(row).toHaveTextContent("activity: working");
    await expect
      .element(row.getByRole("link", { name: rid("run:working") }))
      .toHaveAttribute("href", runHref(rid("run:working")));
    await expect
      .element(row.getByText(rid("stop:kind-active"), { exact: true }))
      .toBeVisible();
  });

  it("shows every activity the projection computed, each beside the ids that prove it", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/agents",
    );
    const rowOf = (name: string) =>
      screen.getByRole("row").filter({ hasText: name });

    await expect
      .element(rowOf("Night Desk Agent"))
      .toHaveTextContent(`activity: stalestale runs:${rid("run:stale")}`);
    await expect
      .element(rowOf("Follow Up"))
      .toHaveTextContent(`held runs:${rid("run:held")}`);
    await expect
      .element(rowOf("Queue Desk"))
      .toHaveTextContent(`queued runs:${rid("run:queued")}`);
    await expect
      .element(rowOf("Archive"))
      .toHaveTextContent(
        "availability: inactiveactivity: idleinactive unit:agent",
      );
    await expect
      .element(rowOf("Closed Desk"))
      .toHaveTextContent("inactive unit:company");
  });

  it("filters the one list it read by activity, without another read", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/agents");
    await expect
      .element(screen.getByRole("link", { name: "Agent Queue Desk" }))
      .toBeVisible();

    await screen
      .getByLabelText("Activity", { exact: true })
      .selectOptions("working");

    await expect
      .element(screen.getByRole("link", { name: "Agent Queue Desk" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("link", { name: "Agent Lead Triage" }))
      .toBeVisible();
    expect(session.callsOf("list_agents")).toHaveLength(1);
  });

  it("opens an agent with every id that proves its state, and its recent runs", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/agents/${rid("agent:lead-triage")}`,
    );

    const evidence = screen.getByLabelText("Agent state evidence");
    await expect
      .element(evidence.getByRole("link", { name: rid("run:indeterminate") }))
      .toHaveAttribute("href", runHref(rid("run:indeterminate")));
    await expect
      .element(evidence.getByRole("link", { name: rid("run:working") }))
      .toHaveAttribute("href", runHref(rid("run:working")));
    await expect
      .element(evidence)
      .toHaveTextContent("no stop naming this tenant covers this agent");
    await expect
      .element(screen.getByRole("table", { name: "Recent runs" }))
      .toHaveTextContent(rid("run:succeeded"));
  });

  it("names the stop that covers a stopped agent, with its scope and origin", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/agents/${rid("agent:follow-up")}`,
    );

    await expect
      .element(screen.getByLabelText("Agent state evidence"))
      .toHaveTextContent(`${rid("stop:agent")}scope agent, origin owner`);
  });

  it("renders the state as unknown, and no working run, once the answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/agents",
      { clock: () => Date.now() + skew },
    );
    await expect
      .element(screen.getByText("activity: working", { exact: true }))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(
      screen.getByText("activity: working", { exact: true }).query(),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: rid("run:working") }).query(),
    ).toBeNull();
    await expect
      .element(screen.getByText("activity: unknown", { exact: true }).first())
      .toBeVisible();
  });

  it("renders a live recent run's status as unknown once the answer is too old, and keeps a settled run's", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/agents/${rid("agent:lead-triage")}`,
      { clock: () => Date.now() + skew },
    );
    const recentRuns = screen.getByRole("table", { name: "Recent runs" });
    await expect.element(recentRuns).toHaveTextContent("running");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    await expect.element(recentRuns).toHaveTextContent("unknown");
    await expect.element(recentRuns).not.toHaveTextContent("running");
    await expect.element(recentRuns).not.toHaveTextContent("pending");
    await expect.element(recentRuns).toHaveTextContent("succeeded");
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
    expect(document.body.textContent).not.toContain("activity: working");
  });
});
