import { JOB_STEPS_NOTE, STATE_UNKNOWN_NOTE } from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { POLL_INTERVAL_MS } from "../../query/queryClient";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { goTo, renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 5 (docs/PHASE_2C_BRIEF.md §9, §10, §12), fed with the runs the real
// projection returned: filtered by status, agent and attention through
// list_runs' own arguments; read again every 15 s while a run it shows can
// still change, and such a run's status "unknown" once the answer is too old;
// a run's detail with its job's liveness, the id-free job steps, the covering
// stop, the retry links and the cost exactly as the server formatted it. A run
// carries no result text, so none can appear.

const runHref = (id: string) => `#/company-os/runs/${id}`;

/** Longer than one tick of the clock the "unknown" rule reads (1 s). */
const outlastFreshnessTick = () =>
  new Promise((resolve) => setTimeout(resolve, 1_500));

/** Lets the fetches an interval started reach the fake port. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("the Agent runs screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("filters by status, agent and attention through list_runs' own arguments", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/runs");
    await expect
      .poll(() =>
        document.querySelector(`option[value="${rid("agent:lead-triage")}"]`),
      )
      .not.toBeNull();

    await screen
      .getByLabelText("Status", { exact: true })
      .selectOptions("indeterminate");
    await screen
      .getByLabelText("Agent", { exact: true })
      .selectOptions("Lead Triage");
    await screen
      .getByLabelText("Attention", { exact: true })
      .selectOptions("Needing attention only");

    await expect
      .poll(() => session.callsOf("list_runs").at(-1)?.args)
      .toEqual({
        p_status: "indeterminate",
        p_agent_id: rid("agent:lead-triage"),
        p_attention_only: true,
        p_cursor: null,
      });
    await expect
      .element(screen.getByRole("link", { name: rid("run:indeterminate") }))
      .toHaveAttribute("href", runHref(rid("run:indeterminate")));
    // The retried indeterminate run needs no attention: its retry answered it.
    expect(
      screen.getByRole("link", { name: rid("run:retried") }).query(),
    ).toBeNull();
    expect(session.unmatched).toEqual([]);
  });

  it("shows a live run's status as unknown once the list's answer is older than two polling intervals, and a settled run's as it is", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/runs",
      { clock: () => Date.now() + skew },
    );
    const rowOf = (label: string) =>
      screen.getByRole("row").filter({ hasText: rid(label) });
    await expect.element(rowOf("run:working")).toHaveTextContent("running");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    await expect.element(rowOf("run:working")).toHaveTextContent("unknown");
    await expect.element(rowOf("run:working")).not.toHaveTextContent("running");
    await expect.element(rowOf("run:queued")).toHaveTextContent("unknown");
    await expect
      .element(rowOf("run:indeterminate"))
      .not.toHaveTextContent("indeterminate not retried");
    await expect.element(rowOf("run:succeeded")).toHaveTextContent("succeeded");
    await expect.element(rowOf("run:failed")).toHaveTextContent("failed");
    await expect
      .element(rowOf("run:retried"))
      .toHaveTextContent("indeterminate");
  });

  it("reads the list again every 15 s while it shows a run that can still change, and never once every run it shows has settled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const session = createRecordedSession();
      const reads = (status: string | undefined) =>
        session
          .callsOf("list_runs")
          .filter((call) => call.args.p_status === (status ?? null)).length;
      const screen = await renderCompanyOs(session, "#/company-os/runs");
      await expect
        .element(screen.getByRole("link", { name: rid("run:working") }))
        .toBeVisible();
      expect(reads(undefined)).toBe(1);

      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await expect.poll(() => reads(undefined)).toBe(2);

      goTo("#/company-os/runs?status=succeeded");
      await expect
        .element(screen.getByRole("link", { name: rid("run:succeeded") }))
        .toBeVisible();
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      await settle();
      expect(reads("succeeded")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a held run with its deferred job, its job steps, the stop that covers it and no cost yet", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      runHref(rid("run:held")),
    );

    const job = screen.getByLabelText("Job", { exact: true }).last();
    await expect.element(job).toHaveTextContent("Job statusqueued");
    await expect.element(job).toHaveTextContent("Live leaseno");
    const steps = screen.getByRole("table", { name: "Job steps" });
    await expect.element(steps).toHaveTextContent("job leased");
    await expect.element(steps).toHaveTextContent("job deferred");
    await expect.element(screen.getByText(JOB_STEPS_NOTE)).toBeVisible();
    await expect
      .element(screen.getByRole("region", { name: "Covering stop" }))
      .toHaveTextContent(`${rid("stop:agent")}scope agent, origin owner`);
    const cost = screen.getByLabelText("Cost", { exact: true }).last();
    await expect.element(cost).toHaveTextContent("Reservednone");
  });

  it("opens a working run with its live lease and the cost exactly as the server wrote it", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      runHref(rid("run:working")),
    );
    const reserved = recorded("get_run", {
      p_run_id: rid("run:working"),
    }).reservedCost;

    const job = screen.getByLabelText("Job", { exact: true }).last();
    await expect.element(job).toHaveTextContent("Job statusleased");
    await expect.element(job).toHaveTextContent("Live leaseyes");
    await expect
      .element(screen.getByLabelText("Cost", { exact: true }).last())
      .toHaveTextContent(`Reserved${reserved?.usd} USD`);
  });

  it("shows a live run's status, job status and lease as unknown once its answer is older than two polling intervals", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      runHref(rid("run:working")),
      { clock: () => Date.now() + skew },
    );
    const job = screen.getByLabelText("Job", { exact: true }).last();
    await expect.element(job).toHaveTextContent("Live leaseyes");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    await expect.element(job).toHaveTextContent("Job statusunknown");
    await expect.element(job).toHaveTextContent("Live leaseunknown");
    await expect
      .element(screen.getByLabelText("Run summary"))
      .toHaveTextContent("Statusunknown");
  });

  it("keeps a settled run's final state however old its answer is", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      runHref(rid("run:succeeded")),
      { clock: () => Date.now() + skew },
    );
    await expect
      .element(screen.getByLabelText("Run summary"))
      .toHaveTextContent("Statussucceeded");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;
    await outlastFreshnessTick();

    expect(screen.getByText(STATE_UNKNOWN_NOTE).query()).toBeNull();
    await expect
      .element(screen.getByLabelText("Run summary"))
      .toHaveTextContent("Statussucceeded");
  });

  it("reads a live run again every 15 s while the page is visible, and a settled run never", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const session = createRecordedSession();
      const reads = (runId: string) =>
        session
          .callsOf("get_run")
          .filter((call) => call.args.p_run_id === runId).length;
      const screen = await renderCompanyOs(
        session,
        runHref(rid("run:working")),
      );
      await expect
        .element(screen.getByLabelText("Job", { exact: true }).last())
        .toHaveTextContent("Live leaseyes");
      expect(reads(rid("run:working"))).toBe(1);

      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await expect.poll(() => reads(rid("run:working"))).toBe(2);

      goTo(runHref(rid("run:succeeded")));
      await expect
        .element(screen.getByLabelText("Run summary"))
        .toHaveTextContent("Statussucceeded");
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      await settle();
      expect(reads(rid("run:succeeded"))).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("links a retried run to the run that retried it, and the retry back to it", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      runHref(rid("run:retried")),
    );

    await expect
      .element(
        screen
          .getByRole("region", { name: "Retries" })
          .getByRole("link", { name: rid("run:retry") }),
      )
      .toHaveAttribute("href", runHref(rid("run:retry")));
    await expect
      .element(screen.getByLabelText("Run summary"))
      .toHaveTextContent("Errortransport (dbtest_provider_error)");

    goTo(runHref(rid("run:retry")));

    await expect
      .element(
        screen
          .getByRole("region", { name: "Retries" })
          .getByRole("link", { name: rid("run:retried") }),
      )
      .toHaveAttribute("href", runHref(rid("run:retried")));
  });

  it("says so when a run has no job, and flags an indeterminate run no retry answered", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      runHref(rid("run:refused-by-stop")),
    );

    await expect
      .element(screen.getByText("No job exists for this run."))
      .toBeVisible();
    await expect
      .element(screen.getByLabelText("Run summary"))
      .toHaveTextContent("Statuscancelled");

    goTo(runHref(rid("run:indeterminate")));

    await expect
      .element(screen.getByLabelText("Run summary"))
      .toHaveTextContent("Attentionindeterminate not retried");
  });
});
