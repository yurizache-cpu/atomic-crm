import {
  ACCEPTED_WITHOUT_SEND_LABEL,
  OVERVIEW_PROOF_NOTE,
  PLATFORM_ADMISSION_LABEL,
  STATE_UNKNOWN_NOTE,
} from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { POLL_INTERVAL_MS } from "../../query/queryClient";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 1 (docs/PHASE_2C_BRIEF.md §12), fed with the overview the real
// projection returned for the recorded tenant: the server's counts, each
// linking to the list that proves it; the platform admission boolean;
// accepted reviews with no send recorded as a count, never as awaiting a send
// (§7.5); read every 15 s while visible, never while hidden, and "unknown"
// once the answer is older than two polling intervals (§10).

const PROOF_LINKS: readonly (readonly [string, string])[] = [
  ["Agents: 8", "#/company-os/agents"],
  ["Working: 1", "#/company-os/agents?activity=working"],
  ["Held: 1", "#/company-os/agents?activity=held"],
  ["Queued: 1", "#/company-os/agents?activity=queued"],
  ["Stale: 1", "#/company-os/agents?activity=stale"],
  ["Stopped: 2", "#/company-os/agents?availability=stopped"],
  ["Inactive: 3", "#/company-os/agents?availability=inactive"],
  ["Runs working now: 1", "#/company-os/agents?activity=working"],
  ["Runs needing attention: 2", "#/company-os/runs?attention=1"],
  ["Reviews pending: 2", "#/company-os/reviews"],
  ["Active stops naming this tenant: 3", "#/company-os/stops"],
  ["Tenant admission: conditional", "#/company-os/costs"],
];

/** Counts whose list cannot narrow to them yet: each says what its list shows. */
const WIDER_LISTS: readonly (readonly [string, string])[] = [
  [
    "Runs today: failed: 1 (the list shows failed runs of every day)",
    "#/company-os/runs?status=failed",
  ],
  [
    "Runs today: pending: 6 (the list shows pending runs of every day)",
    "#/company-os/runs?status=pending",
  ],
  [
    "Outbound records today: blocked: 1 (the list shows every task: see its pipeline column)",
    "#/company-os/tasks",
  ],
  [
    "Indeterminate sends open: 1 (the list shows every task: see its pipeline column)",
    "#/company-os/tasks",
  ],
  [
    `${ACCEPTED_WITHOUT_SEND_LABEL}: 0 (the list shows every accepted review: see its outbound record column)`,
    "#/company-os/reviews?status=accepted",
  ],
];

const hideThePage = () => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("visibilitychange"));
};

const showThePage = () => {
  delete (document as { visibilityState?: unknown }).visibilityState;
};

/** Lets the fetches an interval started reach the fake port. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("the Overview screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("links every count to the list that proves it", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os",
    );

    for (const [name, href] of PROOF_LINKS) {
      await expect
        .element(screen.getByRole("link", { name, exact: true }))
        .toHaveAttribute("href", href);
    }
  });

  it("says, beside each count its list cannot narrow to yet, what that list shows instead", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os",
    );

    for (const [name, href] of WIDER_LISTS) {
      await expect
        .element(screen.getByRole("link", { name, exact: true }))
        .toHaveAttribute("href", href);
    }
    await expect
      .element(screen.getByText("(the list shows failed runs of every day)"))
      .toBeVisible();
    await expect.element(screen.getByText(OVERVIEW_PROOF_NOTE)).toBeVisible();
  });

  it("shows the platform admission as a boolean, set only by a platform stop, and the accepted reviews with no send as a plain count", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os",
    );
    await expect
      .element(screen.getByRole("region", { name: "Admission" }))
      .toHaveTextContent(`${PLATFORM_ADMISSION_LABEL}no`);
    await expect
      .element(screen.getByText(ACCEPTED_WITHOUT_SEND_LABEL, { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /awaiting|waiting to be sent/i,
    );
    await screen.unmount();

    const blocked = await renderCompanyOs(
      createRecordedSession("platform-stop"),
      "#/company-os",
    );

    await expect
      .element(blocked.getByRole("region", { name: "Admission" }))
      .toHaveTextContent(`${PLATFORM_ADMISSION_LABEL}yes`);
    // The platform stop holds the queued run: its agent reads held.
    await expect
      .element(blocked.getByRole("link", { name: "Queued: 0", exact: true }))
      .toBeVisible();
  });

  it("names an authorized outbound record as a send request, never as the acceptance", async () => {
    const session = createRecordedSession();
    const overview = recorded("overview");
    session.answer("overview", () =>
      ok({
        ...overview,
        outbound: { ...overview.outbound, todayByStatus: { authorized: 1 } },
      }),
    );
    const screen = await renderCompanyOs(session, "#/company-os");

    await expect
      .element(
        screen.getByRole("link", {
          name: "Outbound records today: send authorized by an operator send request: 1 (the list shows every task: see its pipeline column)",
          exact: true,
        }),
      )
      .toBeVisible();
  });

  it("renders every value as unknown once the answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os",
      { clock: () => Date.now() + skew },
    );
    await expect
      .element(screen.getByRole("link", { name: "Reviews pending: 2" }))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Reviews pending: 2" }).query(),
    ).toBeNull();
    expect(
      screen.getByText("unknown", { exact: true }).elements().length,
    ).toBeGreaterThanOrEqual(PROOF_LINKS.length);
  });

  it("says no run was created today only while the answer is current", async () => {
    // A state the recording has no day for: the overview of a tenant with no
    // run today, built from the recorded answer.
    let skew = 0;
    const session = createRecordedSession();
    const overview = recorded("overview");
    session.answer("overview", () =>
      ok({ ...overview, runs: { ...overview.runs, todayByStatus: {} } }),
    );
    const screen = await renderCompanyOs(session, "#/company-os", {
      clock: () => Date.now() + skew,
    });
    await expect
      .element(screen.getByText("No run was created today."))
      .toBeVisible();

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    expect(screen.getByText("No run was created today.").query()).toBeNull();
  });

  it("reads the overview again every 15 s while the page is visible, and never while it is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const session = createRecordedSession();
      const screen = await renderCompanyOs(session, "#/company-os");
      await expect
        .element(screen.getByRole("link", { name: "Reviews pending: 2" }))
        .toBeVisible();
      const reads = () => session.callsOf("overview").length;
      expect(reads()).toBe(1);

      vi.advanceTimersByTime(POLL_INTERVAL_MS - 1);
      await settle();
      expect(reads()).toBe(1);
      vi.advanceTimersByTime(1);
      await expect.poll(reads).toBe(2);

      hideThePage();
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 4);
      await settle();
      expect(reads()).toBe(2);
    } finally {
      showThePage();
      vi.useRealTimers();
    }
  });
});
