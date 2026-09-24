import type { RenderResult } from "vitest-browser-react";

import { MEMBER_TRIP_REASON } from "../../../../contracts/company-os-api/index.ts";
import {
  TRIP_ALREADY_STOPPED_TEXT,
  TRIP_BLOCKS_TEXT,
  TRIP_BUSY_TEXT,
  TRIP_COVERED_LABEL,
  TRIP_NOT_ALLOWED_TEXT,
  TRIP_NOT_CONFIRMED_TEXT,
  TRIP_PANEL_NOTE,
  TRIP_REASON_TEXT,
  TRIP_RUNNING_LABEL,
  TRIP_STOPPED_LABEL,
  TRIP_STOPPED_TEXT,
  TRIP_UNKNOWN_TEXT,
} from "../../copy";
import { ok, refused, type FakeSession } from "../../testing/fakeSession";
import { createRecordedSession, recorded } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// The second act (S7.2; docs/PHASE_2C_BRIEF.md §9 row 17) on the Execution
// stops screen, over the recorded tenant: one "Interromper execução" per named
// target inside its group, none for a target stopped at its own scope; each
// behind a confirmation that names the target and focuses Cancelar; called
// once with the scope and the target only, never retried; after a lost answer
// the active stops are read again and the owner is told what they show; and
// nothing anywhere clears a stop.

const STOPS = "#/company-os/stops";
const TENANT = "COS Contract Tenant";
const LEAD = recorded("list_agents").items.find(
  (agent) => agent.name === "Lead Triage",
)!;
const LEAD_CONTROL = "Interromper execução: Agente Lead Triage";
const TENANT_CONTROL = `Interromper execução: Toda a empresa (${TENANT})`;

/** The stop a trip of Lead Triage records, as list_stops then answers it. */
const LEAD_STOP = {
  id: "00000000-0000-4000-8000-0000000f0001",
  scope: "agent",
  jobKind: null,
  origin: "owner",
  target: {
    companyId: LEAD.company.id,
    departmentId: null,
    agentId: LEAD.id,
    name: LEAD.name,
  },
  trippedAt: "2026-09-23T15:00:00.000000Z",
  reason: MEMBER_TRIP_REASON,
  clearedAt: null,
  clearedReason: null,
} as const;

const tripped = (outcome: "stopped" | "already_stopped") =>
  ok({
    v: 1,
    asOf: "2026-09-23T15:00:00.000000Z",
    stopId: LEAD_STOP.id,
    outcome,
  });

/**
 * trip_stop answers `act`; list_stops answers as recorded until the act has
 * been called, and from then on with Lead Triage's stop (`true`), as recorded
 * (`false`), or not at all (`"fail"`).
 */
const tripThen = (
  session: FakeSession,
  act: () => ReturnType<typeof ok>,
  after: boolean | "fail",
) => {
  session.answer("trip_stop", act);
  session.answer("list_stops", (args) => {
    const page = recorded("list_stops", args);
    if (session.callsOf("trip_stop").length === 0 || after === false) {
      return ok(page);
    }
    if (after === "fail") return refused("OS500");
    return ok({ ...page, items: [LEAD_STOP, ...page.items] });
  });
};

const tripGroup = (screen: RenderResult) =>
  screen.getByRole("group", { name: "Interromper execução" });

const targetRow = (name: string) =>
  [...document.querySelectorAll("[aria-label='Alvos'] [role='listitem']")].find(
    (row) => row.querySelector(".font-medium")?.textContent === name,
  );

/** Long enough for a stray retry to have reached the port. */
const outlastStrayCalls = () =>
  new Promise((resolve) => setTimeout(resolve, 150));

/** Opens Lead Triage's confirmation and confirms it. */
const confirmLeadTrip = async (screen: RenderResult) => {
  await tripGroup(screen).getByRole("button", { name: LEAD_CONTROL }).click();
  await screen
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirmar interrupção" })
    .click();
};

describe("the trip on the Execution stops screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("offers one control per named target inside its group, none for a target stopped at its own scope, with each target's state", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, STOPS);

    await expect
      .element(tripGroup(screen).getByRole("button", { name: LEAD_CONTROL }))
      .toBeVisible();
    await expect.element(screen.getByText(TRIP_PANEL_NOTE)).toBeVisible();
    for (const offered of [
      TENANT_CONTROL,
      "Interromper execução: Empresa Clinic A",
      "Interromper execução: Departamento Intake",
      "Interromper execução: Agente Annex Triage",
    ]) {
      await expect
        .element(tripGroup(screen).getByRole("button", { name: offered }))
        .toBeVisible();
    }
    // Stopped at exactly their own scope: nothing to offer.
    for (const stopped of [
      "Interromper execução: Agente Follow Up",
      "Interromper execução: Empresa Clinic Annex",
      "Interromper execução: Departamento Paused Desk",
    ]) {
      expect(screen.getByRole("button", { name: stopped }).query()).toBeNull();
    }
    expect(targetRow("Lead Triage")?.textContent).toContain(TRIP_RUNNING_LABEL);
    expect(targetRow("Follow Up")?.textContent).toContain(TRIP_STOPPED_LABEL);
    expect(targetRow("Annex Triage")?.textContent).toContain(
      TRIP_COVERED_LABEL,
    );
    expect(document.querySelectorAll("[role='alertdialog']")).toHaveLength(0);
    expect(session.callsOf("trip_stop")).toEqual([]);
  });

  it("asks for a confirmation that names the target, focuses Cancelar, and calls nothing until confirmed", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, STOPS);

    await tripGroup(screen).getByRole("button", { name: LEAD_CONTROL }).click();

    const confirm = screen.getByRole("alertdialog", {
      name: "Interromper a execução deste agente?",
    });
    await expect.element(confirm).toHaveTextContent("Agente Lead Triage");
    await expect.element(confirm).toHaveTextContent(TRIP_BLOCKS_TEXT);
    await expect
      .element(confirm.getByRole("button", { name: "Cancelar" }))
      .toHaveFocus();
    expect(session.callsOf("trip_stop")).toEqual([]);

    await confirm.getByRole("button", { name: "Cancelar" }).click();

    await expect.element(confirm).not.toBeInTheDocument();
    expect(session.callsOf("trip_stop")).toEqual([]);
  });

  it("trips a confirmed target once with its scope and id only, never retries, reads the stops again and leaves no control for it", async () => {
    const session = createRecordedSession();
    tripThen(session, () => tripped("stopped"), true);
    const screen = await renderCompanyOs(session, STOPS);
    await expect
      .element(tripGroup(screen).getByRole("button", { name: LEAD_CONTROL }))
      .toBeVisible();
    const readsBefore = session.callsOf("list_stops").length;

    await confirmLeadTrip(screen);

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(`${TRIP_STOPPED_TEXT} Alvo: Agente Lead Triage.`);
    expect(session.callsOf("trip_stop").map((call) => call.args)).toEqual([
      { p_scope: "agent", p_target_id: LEAD.id },
    ]);
    expect(session.callsOf("list_stops").length).toBeGreaterThan(readsBefore);
    await expect
      .element(screen.getByRole("button", { name: LEAD_CONTROL }))
      .not.toBeInTheDocument();
    expect(targetRow("Lead Triage")?.textContent).toContain(TRIP_STOPPED_LABEL);
    // The new stop's card shows the server's fixed reason in the owner's words.
    await expect.element(screen.getByText(TRIP_REASON_TEXT)).toBeVisible();
    expect(document.body.textContent).not.toContain(MEMBER_TRIP_REASON);
    await outlastStrayCalls();
    expect(session.callsOf("trip_stop")).toHaveLength(1);
  });

  it("sends a tenant trip with its scope alone, and reports a stop that already held it", async () => {
    const session = createRecordedSession();
    tripThen(session, () => tripped("already_stopped"), false);
    const screen = await renderCompanyOs(session, STOPS);

    await tripGroup(screen)
      .getByRole("button", { name: TENANT_CONTROL })
      .click();
    await screen
      .getByRole("alertdialog", {
        name: "Interromper a execução de toda a empresa?",
      })
      .getByRole("button", { name: "Confirmar interrupção" })
      .click();

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(TRIP_ALREADY_STOPPED_TEXT);
    expect(session.callsOf("trip_stop").map((call) => call.args)).toEqual([
      { p_scope: "tenant" },
    ]);
  });

  it("says the lock was busy and nothing was recorded, and leaves a manual retry, without retrying itself", async () => {
    const session = createRecordedSession();
    tripThen(session, () => refused("OS429"), false);
    const screen = await renderCompanyOs(session, STOPS);

    await confirmLeadTrip(screen);

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(`${TRIP_BUSY_TEXT} Alvo: Agente Lead Triage.`);
    await expect
      .element(tripGroup(screen).getByRole("button", { name: LEAD_CONTROL }))
      .toBeEnabled();
    await outlastStrayCalls();
    expect(session.callsOf("trip_stop")).toHaveLength(1);
  });

  it.each([
    {
      label: "shows the stop, as a success",
      after: true,
      text: TRIP_STOPPED_TEXT,
      control: false,
    },
    {
      label: "shows no stop, as not confirmed with a manual retry",
      after: false,
      text: TRIP_NOT_CONFIRMED_TEXT,
      control: true,
    },
    {
      label: "cannot be read, as unknown",
      after: "fail" as const,
      text: TRIP_UNKNOWN_TEXT,
      control: true,
    },
  ])(
    "reads the active stops again after an answer that was lost, and reports it when the re-read $label, never calling the act again",
    async ({ after, text, control }) => {
      const session = createRecordedSession();
      tripThen(session, () => refused("OS500"), after);
      const screen = await renderCompanyOs(session, STOPS);

      await confirmLeadTrip(screen);

      await expect.element(screen.getByRole("status")).toHaveTextContent(text);
      const button = screen.getByRole("button", { name: LEAD_CONTROL });
      if (control) {
        await expect.element(button).toBeVisible();
      } else {
        await expect.element(button).not.toBeInTheDocument();
      }
      await outlastStrayCalls();
      expect(session.callsOf("trip_stop")).toHaveLength(1);
    },
  );

  it("says the member may not trip when the act is refused for access, and offers no further trip", async () => {
    const session = createRecordedSession();
    tripThen(session, () => refused("OS403"), false);
    const screen = await renderCompanyOs(session, STOPS);

    await confirmLeadTrip(screen);

    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent(TRIP_NOT_ALLOWED_TEXT);
    expect(tripGroup(screen).getByRole("button").elements()).toHaveLength(0);
    expect(session.callsOf("trip_stop")).toHaveLength(1);
  });

  it("offers no trip when operator_context withholds it", async () => {
    // Hand-built on purpose: the read surface reports tripStop true.
    const session = createRecordedSession();
    const context = recorded("operator_context");
    session.answer("operator_context", () =>
      ok({
        ...context,
        allowedActions: { ...context.allowedActions, tripStop: false },
      }),
    );
    const screen = await renderCompanyOs(session, STOPS);

    await expect
      .element(
        screen.getByText("Synthetic pause of the follow-up desk", {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(tripGroup(screen).query()).toBeNull();
    expect(session.callsOf("trip_stop")).toEqual([]);
  });
});
