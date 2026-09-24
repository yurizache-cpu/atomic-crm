import { cursorOf } from "../../../../contracts/company-os-api/index.ts";
import { CONTRACT_ERROR_TEXT } from "../../components/queryErrors";
import {
  LIFECYCLE_STATUS_LABEL,
  LIFECYCLE_STATUS_NOTE,
  NEEDS_EDIT_TEXT,
  STATE_UNKNOWN_NOTE,
  TASK_RUNS_CAPPED_NOTE,
  TASK_RUNS_LIMIT,
} from "../../copy";
import { STATE_UNKNOWN_AFTER_MS } from "../../query/freshness";
import { POLL_INTERVAL_MS } from "../../query/queryClient";
import { ok, refused } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { goTo, renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 3 (docs/PHASE_2C_BRIEF.md §9, §10, §11, §12), fed with the tasks the
// real projection returned: filtered through list_tasks' own arguments and
// paged with the opaque cursor the server returned; a task's detail with the
// derived pipeline, runs, review, single outbound record, inbound facts and
// events; the lifecycle status labelled structural; never a title or a
// description; a live run's status "unknown" once the answer is too old.

const taskHref = (label: string) => `#/company-os/tasks/${rid(label)}`;

/** Lets the fetches an interval started reach the fake port. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("the Tasks screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("pages with exactly the cursor the server returned, restarts from the first page when the server refuses one, and ends", async () => {
    // The paging SEQUENCE is scripted: at the screen's page size (50) the
    // database would need more than 50 tasks for a second page, and the
    // refusal needs a task erased between two reads. The pages hold recorded
    // tasks, and each nextCursor names its page's last task, as the server
    // builds it. The Activity feed pages through real recorded pages.
    const [first, second, third] = recorded("list_tasks").items;
    const firstCursor = cursorOf("tk", first.id);
    const restartedCursor = cursorOf("tk", second.id);
    let restarted = false;
    const pageOf = (task: object, nextCursor: string | null) =>
      ok({ ...recorded("list_tasks"), items: [task], nextCursor });
    const session = createRecordedSession();
    session.answer("list_tasks", (args) => {
      if (args.p_cursor === null || args.p_cursor === undefined) {
        return restarted
          ? pageOf(second, restartedCursor)
          : pageOf(first, firstCursor);
      }
      if (args.p_cursor === restartedCursor) return pageOf(third, null);
      restarted = true;
      return refused("OS400");
    });
    const screen = await renderCompanyOs(session, "#/company-os/tasks");
    const taskLink = (id: string) =>
      screen.getByRole("link", { name: `Abrir tarefa ${id}`, exact: true });
    await expect.element(taskLink(first.id)).toBeVisible();

    await screen.getByRole("button", { name: "Carregar mais" }).click();

    await expect
      .element(
        screen.getByText(
          "O pedido foi recusado. Volte para a primeira página.",
        ),
      )
      .toBeVisible();
    await expect.element(taskLink(first.id)).toBeVisible();

    await screen.getByRole("button", { name: "Tentar de novo" }).click();

    await expect.element(taskLink(second.id)).toBeVisible();
    await screen.getByRole("button", { name: "Carregar mais" }).click();
    await expect.element(taskLink(third.id)).toBeVisible();
    await expect.element(screen.getByText("Fim da lista.")).toBeVisible();
    expect(
      session.callsOf("list_tasks").map((call) => call.args.p_cursor),
    ).toEqual([null, firstCursor, null, restartedCursor]);
  });

  it("filters by lifecycle status and agent through list_tasks' own arguments", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/tasks");
    await expect
      .poll(() =>
        document.querySelector(`option[value="${rid("agent:lead-triage")}"]`),
      )
      .not.toBeNull();

    await screen
      .getByLabelText("Situação estrutural", { exact: true })
      .selectOptions("assigned");
    await screen
      .getByLabelText("Agente", { exact: true })
      .selectOptions("Lead Triage");

    await expect
      .poll(() => session.callsOf("list_tasks").at(-1)?.args)
      .toEqual({
        p_status: "assigned",
        p_agent_id: rid("agent:lead-triage"),
        p_cursor: null,
      });
    await expect
      .element(
        screen.getByRole("link", {
          name: `Abrir tarefa ${rid("task:accepted-1")}`,
        }),
      )
      .toBeVisible();
    expect(
      screen
        .getByRole("link", {
          name: `Abrir tarefa ${rid("task:bare")}`,
          exact: true,
        })
        .query(),
    ).toBeNull();
    await expect
      .element(
        screen.getByText(LIFECYCLE_STATUS_LABEL, { exact: true }).first(),
      )
      .toBeVisible();
    await expect.element(screen.getByText(LIFECYCLE_STATUS_NOTE)).toBeVisible();
    expect(session.unmatched).toEqual([]);
  });

  it("shows the agent filter in the address as selected before list_agents answers, and by name once it has", async () => {
    let answerAgents: (() => void) | undefined;
    const session = createRecordedSession();
    session.answer(
      "list_agents",
      () =>
        new Promise((resolve) => {
          answerAgents = () => resolve(ok(recorded("list_agents")));
        }),
    );
    const agent = rid("agent:lead-triage");
    const screen = await renderCompanyOs(
      session,
      `#/company-os/tasks?agent=${agent}`,
    );
    const select = screen.getByLabelText("Agente", { exact: true });

    await expect.element(select).toHaveDisplayValue(`agente ${agent}`);
    await expect.poll(() => answerAgents).toBeDefined();
    answerAgents?.();

    await expect.element(select).toHaveDisplayValue("Lead Triage");
    expect(session.callsOf("list_tasks")[0].args.p_agent_id).toBe(agent);
  });

  it("opens a task with its pipeline, runs, review, outbound record, inbound facts and events", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      taskHref("task:accepted-1"),
    );

    const inbound = screen.getByRole("region", {
      name: "Recebimento",
      exact: true,
    });
    await expect.element(inbound).toHaveTextContent("Synthetic test line");
    await expect
      .element(inbound)
      .toHaveTextContent("Contato no CRMNão encontrado");
    await expect
      .element(screen.getByRole("region", { name: "Tarefa", exact: true }))
      .toHaveTextContent(`${LIFECYCLE_STATUS_LABEL}Atribuída`);
    await expect
      .element(
        screen.getByRole("link", {
          name: `Última execução ${rid("run:accepted-1")}`,
        }),
      )
      .toHaveAttribute("href", `#/company-os/runs/${rid("run:accepted-1")}`);
    await expect
      .element(screen.getByRole("list", { name: "Execuções desta tarefa" }))
      .toHaveTextContent(rid("run:accepted-1"));
    const outbound = screen.getByRole("region", {
      name: "Envio",
      exact: true,
    });
    await expect
      .element(outbound)
      .toHaveTextContent("Código de erro do provedor131047");
    await expect.element(outbound).toHaveTextContent(rid("review:accepted-1"));
    await expect
      .element(screen.getByRole("list", { name: "Eventos desta tarefa" }))
      .toHaveTextContent("lead_triage.reviewed");
    expect(
      screen
        .getByText(
          "Os eventos mais antigos desta tarefa estão na cadeia da tarefa.",
        )
        .query(),
    ).toBeNull();
    await expect
      .element(screen.getByRole("link", { name: "Ver cadeia da tarefa" }))
      .toHaveAttribute(
        "href",
        `#/company-os/activity/task/${rid("task:accepted-1")}`,
      );
  });

  it("says a needs_edit review in the pipeline has no follow-up path, in the list and in the detail", async () => {
    const needsEdit = `Precisa de ajuste: ${NEEDS_EDIT_TEXT}`;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/tasks",
    );

    await expect
      .element(screen.getByRole("list", { name: "Tarefas" }))
      .toHaveTextContent(needsEdit);

    goTo(taskHref("task:indeterminate"));

    await expect
      .element(screen.getByRole("region", { name: "Etapas", exact: true }))
      .toHaveTextContent(needsEdit);
  });

  it("says no send is recorded for a task without an outbound record, never that one is awaited", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession(),
      taskHref("task:working"),
    );

    await expect
      .element(screen.getByText("Nenhum envio registrado para esta tarefa."))
      .toBeVisible();
    expect(document.body.textContent).not.toMatch(
      /awaiting|waiting to be sent|aguardando envio/i,
    );
  });

  it("shows a live run's status as unknown on the task once the answer is older than two polling intervals, and a settled one's as it is", async () => {
    let skew = 0;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      taskHref("task:working"),
      { clock: () => Date.now() + skew },
    );
    const runs = screen.getByRole("list", { name: "Execuções desta tarefa" });
    await expect.element(runs).toHaveTextContent("Executando");

    skew = STATE_UNKNOWN_AFTER_MS + 1_000;

    await expect.element(screen.getByText(STATE_UNKNOWN_NOTE)).toBeVisible();
    await expect.element(runs).not.toHaveTextContent("Executando");
    await expect.element(runs).toHaveTextContent("Desconhecido");
    const steps = screen.getByRole("region", { name: "Etapas", exact: true });
    await expect.element(steps).toHaveTextContent("IA processouDesconhecido");
    await expect.element(steps).not.toHaveTextContent("Executando");

    goTo(taskHref("task:failed"));
    await expect
      .element(screen.getByRole("list", { name: "Execuções desta tarefa" }))
      .toHaveTextContent("Falhou");
    expect(screen.getByText(STATE_UNKNOWN_NOTE).query()).toBeNull();
  });

  it("reads a task with a live run again every 15 s while visible, and a settled task never", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const session = createRecordedSession();
      const reads = (label: string) =>
        session
          .callsOf("get_task")
          .filter((call) => call.args.p_task_id === rid(label)).length;
      const screen = await renderCompanyOs(session, taskHref("task:working"));
      await expect
        .element(screen.getByRole("list", { name: "Execuções desta tarefa" }))
        .toHaveTextContent("Executando");
      expect(reads("task:working")).toBe(1);

      vi.advanceTimersByTime(POLL_INTERVAL_MS);
      await expect.poll(() => reads("task:working")).toBe(2);

      goTo(taskHref("task:failed"));
      await expect
        .element(screen.getByRole("list", { name: "Execuções desta tarefa" }))
        .toHaveTextContent("Falhou");
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      await settle();
      expect(reads("task:failed")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says, on the task and on its chain, when only the task's 20 most recent runs are read", async () => {
    const task = rid("task:refused-by-budget");
    const screen = await renderCompanyOs(
      createRecordedSession("task-many-runs"),
      `#/company-os/tasks/${task}`,
    );

    await expect.element(screen.getByText(TASK_RUNS_CAPPED_NOTE)).toBeVisible();
    expect(
      screen
        .getByRole("list", { name: "Execuções desta tarefa" })
        .getByRole("listitem")
        .elements(),
    ).toHaveLength(TASK_RUNS_LIMIT);

    goTo(`#/company-os/activity/task/${task}`);

    await expect
      .element(
        screen.getByRole("heading", { name: "Cadeia da tarefa", level: 1 }),
      )
      .toBeVisible();
    await expect.element(screen.getByText(TASK_RUNS_CAPPED_NOTE)).toBeVisible();

    goTo(taskHref("task:retried"));

    await expect
      .element(screen.getByRole("list", { name: "Execuções desta tarefa" }))
      .toHaveTextContent(rid("run:retry"));
    expect(screen.getByText(TASK_RUNS_CAPPED_NOTE).query()).toBeNull();
  });

  it("renders an error, not the task, when the answer carries a title", async () => {
    // Hand-built on purpose: no projection returns a title, so only a
    // tampered answer reaches the contract's tripwire. It is the recorded
    // task with a title added.
    const session = createRecordedSession();
    const title = "Synthetic task title from the inbound message";
    session.answer("get_task", (args) =>
      ok({ ...recorded("get_task", args), title }),
    );

    const screen = await renderCompanyOs(session, taskHref("task:accepted-1"));

    await expect.element(screen.getByText(CONTRACT_ERROR_TEXT)).toBeVisible();
    expect(document.body.textContent).not.toContain(title);
    expect(document.body.textContent).not.toContain("Synthetic test line");
  });
});
