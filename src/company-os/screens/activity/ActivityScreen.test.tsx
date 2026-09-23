import { cursorOf } from "../../../../contracts/company-os-api/index.ts";
import { eventEntryId } from "../../components/eventsInView";
import {
  ABSENT_STEP_TEXT,
  NOT_LOADED_STEP_TEXT,
  STOP_EVENTS_LABEL,
} from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 2 (docs/PHASE_2C_BRIEF.md §11, §12), fed with the events the real
// projection returned: the tenant's feed paged with the opaque cursor the
// server returned; each event's source exactly as given ("other" included) and
// its allowlisted facts as key/value text; causation ids as links to the
// causing and caused entries on the page; the stops naming the tenant from
// their own rows, labelled "stop trips write no event"; and the per-task and
// per-run chains laid out by step, each fact with its own time, a step with no
// durable fact shown as absent.

const rowOf = (text: string) =>
  [...document.querySelectorAll("tr")].find((row) =>
    row.textContent?.includes(text),
  );

/** The chain row of `step`, as the text of its cells. */
const stepRow = (step: string) =>
  [...document.querySelectorAll("tr")]
    .filter((row) => row.querySelector("th")?.textContent === step)
    .map((row) => row.querySelector("td")?.textContent ?? "");

const FEED = () =>
  recorded("list_events").items.concat(
    recorded("list_events", {
      p_cursor: recorded("list_events").nextCursor,
    }).items,
  );

describe("the Activity screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("pages the feed with exactly the cursor the server returned, to its end, and shows an unknown event's source and withheld facts as given", async () => {
    const session = createRecordedSession();
    const first = recorded("list_events");
    const second = recorded("list_events", { p_cursor: first.nextCursor });
    const screen = await renderCompanyOs(session, "#/company-os/activity");
    const feed = screen.getByRole("table", { name: "Tenant events" });
    await expect.element(feed).toHaveTextContent("dbtest.contract_probe");
    const reviewed = rowOf("lead_triage.reviewed")?.textContent ?? "";
    expect(reviewed).toMatch(/decision(accepted|rejected|needs_edit)/);
    expect(reviewed).toContain("operator-cli");
    const probe = rowOf("dbtest.contract_probe")?.textContent ?? "";
    expect(probe).toContain("other");
    expect(probe).toContain("facts withheld");

    await screen.getByRole("button", { name: "Load more" }).click();
    await expect
      .element(feed)
      .toHaveTextContent(second.items[second.items.length - 1].id);
    await screen.getByRole("button", { name: "Load more" }).click();

    await expect
      .element(
        screen
          .getByRole("region", { name: "Events", exact: true })
          .getByText("End of the list."),
      )
      .toBeVisible();
    const feedCursors = session
      .callsOf("list_events")
      .filter((call) => call.args.p_subject_id == null)
      .map((call) => call.args.p_cursor);
    expect(feedCursors).toEqual([null, first.nextCursor, second.nextCursor]);
    expect(session.unmatched).toEqual([]);
  });

  it("links a cause on the page to its entry and back, and leaves a cause that is not on the page as plain text", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/activity",
    );
    const feed = screen.getByRole("table", { name: "Tenant events" });
    await expect.element(feed).toHaveTextContent("dbtest.contract_probe");
    // On the second page, an agent_run.started whose agent_run.requested is
    // on the third page, not loaded yet.
    await screen.getByRole("button", { name: "Load more" }).click();
    const started = FEED().find(
      (event) =>
        event.type === "agent_run.started" &&
        !FEED().some((cause) => cause.id === event.causationId),
    )!;
    await expect.element(feed).toHaveTextContent(started.id);
    const cause = started.causationId!;
    expect(
      screen.getByRole("button", { name: `Go to event ${cause}` }).query(),
    ).toBeNull();
    expect(
      document.getElementById(eventEntryId(started.id))?.textContent,
    ).toContain(`caused by${cause}`);

    await screen.getByRole("button", { name: "Load more" }).click();

    // The cause caused more than one fact on the page: every one links to it.
    const link = screen
      .getByRole("button", { name: `Go to event ${cause}` })
      .first();
    await expect.element(link).toBeVisible();
    await link.click();
    expect(document.activeElement?.id).toBe(eventEntryId(cause));
    await screen
      .getByRole("button", { name: `Go to event ${started.id}` })
      .first()
      .click();
    expect(document.activeElement?.id).toBe(eventEntryId(started.id));
  });

  it("lists the stops naming this tenant from their own rows, labelled as writing no event", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/activity",
    );

    await expect
      .element(screen.getByRole("table", { name: "Stops from their own rows" }))
      .toHaveTextContent("Drill over");
    await expect
      .element(
        screen.getByRole("heading", {
          name: `Execution stops (${STOP_EVENTS_LABEL.toLowerCase()})`,
        }),
      )
      .toBeVisible();
  });

  it("lays a task's chain out by step, the run's steps in their own block, and shows a step with no fact as absent", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/activity/task/${rid("task:succeeded")}`,
    );
    await expect
      .element(screen.getByText("agent_run.succeeded", { exact: true }))
      .toBeVisible();
    await expect
      .poll(() =>
        stepRow("Job leased").some((cell) => cell.includes("job leased")),
      )
      .toBe(true);

    const received = stepRow("Event received")[0];
    expect(received).toContain("communication.received");
    expect(received).toContain("lead_triage.admitted");
    expect(stepRow("Task created")[0]).toContain("task.created");
    expect(stepRow("Execution requested")[0]).toContain(
      "task.execution_requested",
    );
    expect(stepRow("Run requested")[0]).toContain("agent_run.requested");
    expect(stepRow("Provider call begun")[0]).toContain("agent_run.started");
    expect(stepRow("Result settled")[0]).toContain("agent_run.succeeded");
    expect(stepRow("Review opened")[0]).toContain("lead_triage.review_pending");
    expect(stepRow("Operator decision")).toEqual([ABSENT_STEP_TEXT]);
    expect(stepRow("Outbound send requested")).toEqual([ABSENT_STEP_TEXT]);
  });

  it("names the task's and the run's request steps apart, and links the task's to the run fact that caused it", async () => {
    const task = rid("task:succeeded");
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/activity/task/${task}`,
    );
    const requested = recorded("list_events", {
      p_subject_type: "task",
      p_subject_id: task,
      p_limit: 100,
    }).items.find((event) => event.type === "task.execution_requested")!;
    const link = screen
      .getByRole("row")
      .filter({ hasText: "Execution requested" })
      .getByRole("button", { name: `Go to event ${requested.causationId}` });

    await expect.element(link).toBeVisible();
    expect(stepRow("Execution requested")).toHaveLength(1);
    expect(stepRow("Run requested")).toHaveLength(1);
    await link.click();
    expect(document.activeElement?.id).toBe(
      eventEntryId(requested.causationId!),
    );
    expect(document.activeElement?.textContent).toContain(
      "agent_run.requested",
    );
  });

  it("lays out one block of run steps per run of a retried task, and each step a run never reached as absent", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/activity/task/${rid("task:retried")}`,
    );
    await expect
      .element(screen.getByText("agent_run.indeterminate", { exact: true }))
      .toBeVisible();
    await expect.poll(() => stepRow("Provider call begun")).toHaveLength(2);

    const begun = stepRow("Provider call begun");
    expect(begun.filter((cell) => cell === ABSENT_STEP_TEXT)).toHaveLength(1);
    expect(begun.some((cell) => cell.includes("agent_run.started"))).toBe(true);
    expect(stepRow("Execution requested")[0]).toMatch(
      /task\.execution_requested.*task\.execution_requested/,
    );
  });

  it("follows a task from its message to the provider's answer to its send", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/activity/task/${rid("task:accepted-1")}`,
    );
    await expect
      .element(
        screen.getByText("communication.outbound_failed", { exact: true }),
      )
      .toBeVisible();

    expect(stepRow("Operator decision")[0]).toContain("lead_triage.reviewed");
    expect(stepRow("Outbound send requested")[0]).toContain(
      "communication.outbound_authorized",
    );
    expect(stepRow("Provider result or status")[0]).toContain(
      "communication.outbound_failed",
    );
    // Its run is still queued: nothing after the request.
    await expect
      .poll(() => stepRow("Job leased")[0] ?? "")
      .toContain(ABSENT_STEP_TEXT);
    expect(stepRow("Provider call begun")).toEqual([ABSENT_STEP_TEXT]);
  });

  it("says a step is not loaded yet, never absent, while older facts of the task remain unread", async () => {
    // The paging is scripted: a chain reads 100 facts a page, and no recorded
    // task has that many, so the recorded facts of one task are split in two
    // pages here, the second named by the first's last item as the server
    // would name it. Newest first: the facts of the oldest step, "Task
    // created" (admission writes them before the message's own), are only on
    // the second page.
    const task = rid("task:succeeded");
    const args = { p_subject_type: "task", p_subject_id: task, p_limit: 100 };
    const all = recorded("list_events", args).items;
    const split = all.findIndex((event) => event.type === "task.assigned");
    const newer = all.slice(0, split);
    const older = all.slice(split);
    const olderCursor = cursorOf("ev", newer[newer.length - 1].id);
    const session = createRecordedSession();
    session.answer("list_events", (callArgs) => {
      if (callArgs.p_subject_id !== task) {
        return ok(recorded("list_events", callArgs));
      }
      return callArgs.p_cursor === olderCursor
        ? ok({
            ...recorded("list_events", args),
            items: older,
            nextCursor: null,
          })
        : ok({
            ...recorded("list_events", args),
            items: newer,
            nextCursor: olderCursor,
          });
    });
    const screen = await renderCompanyOs(
      session,
      `#/company-os/activity/task/${task}`,
    );
    await expect
      .poll(() => stepRow("Event received")[0] ?? "")
      .toContain("communication.received");
    expect(stepRow("Task created")).toEqual([NOT_LOADED_STEP_TEXT]);

    await screen.getByRole("button", { name: "Load more" }).click();

    await expect
      .poll(() => stepRow("Task created")[0] ?? "")
      .toContain("task.created");
    expect(stepRow("Task created")[0]).toContain("task.assigned");
    expect(
      session
        .callsOf("list_events")
        .filter((call) => call.args.p_subject_id === task)
        .map((call) => call.args.p_cursor),
    ).toEqual([null, olderCursor]);
  });

  it("lays a run's chain out by step, with its job steps from the run's own job", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      `#/company-os/activity/run/${rid("run:succeeded")}`,
    );
    await expect
      .element(screen.getByText("job leased", { exact: true }))
      .toBeVisible();

    expect(stepRow("Run requested")[0]).toContain("agent_run.requested");
    expect(stepRow("Provider call begun")[0]).toContain("agent_run.started");
    expect(stepRow("Result settled")[0]).toContain("agent_run.succeeded");
    await expect
      .element(
        screen.getByRole("link", {
          name: `Task chain ${rid("task:succeeded")}`,
        }),
      )
      .toHaveAttribute(
        "href",
        `#/company-os/activity/task/${rid("task:succeeded")}`,
      );
  });
});
