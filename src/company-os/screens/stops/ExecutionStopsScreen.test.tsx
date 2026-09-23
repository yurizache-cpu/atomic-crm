import {
  STOP_CLEAR_NOTE,
  STOP_JOB_KIND_NOTE,
  STOP_PLATFORM_NOTE,
} from "../../copy";
import { createRecordedSession, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 7 (docs/PHASE_2C_BRIEF.md §9, §12), fed with the stops the real
// projection returned: the active stops naming the tenant, or all of them
// with the cleared ones, each from its own row; a tenant job_kind stop listed
// read-only; who tripped or cleared a stop never shown; clearing an operator
// CLI act, and no trip or clear control.

const rowOf = (text: string) =>
  [...document.querySelectorAll("tr")].find((row) =>
    row.textContent?.includes(text),
  );

const TENANT = "COS Contract Tenant";

describe("the Execution stops screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("lists the active stops naming this tenant, each with its target, and says clearing is a CLI act", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/stops");

    await expect
      .element(
        screen.getByText("Synthetic pause of the follow-up desk", {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(
      rowOf("Synthetic pause of the follow-up desk")?.textContent,
    ).toContain("Follow Up");
    expect(rowOf("Synthetic annex pause")?.textContent).toContain(
      "Clinic Annex",
    );
    expect(rowOf("Synthetic desk pause")?.textContent).toContain("Paused Desk");
    for (const note of [
      STOP_CLEAR_NOTE,
      STOP_JOB_KIND_NOTE,
      STOP_PLATFORM_NOTE,
    ]) {
      await expect.element(screen.getByText(note)).toBeVisible();
    }
    expect(screen.getByText("Drill over").query()).toBeNull();
    expect(session.callsOf("list_stops")[0].args.p_include_cleared).toBe(false);
  });

  it("lists an active tenant job_kind stop read-only, naming the tenant and the kind", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession("tenant-kind-stop"),
      "#/company-os/stops",
    );

    await expect
      .element(
        screen.getByText("Synthetic hold of every agent run", { exact: true }),
      )
      .toBeVisible();
    const row = rowOf("Synthetic hold of every agent run")?.textContent ?? "";
    expect(row).toContain("read-only");
    expect(row).toContain(`tenant ${TENANT}job kind agent_run.execute`);
    expect(row).toContain("active");
  });

  it("adds the cleared stops with their clear reason on the second tab", async () => {
    const session = createRecordedSession();
    const screen = await renderCompanyOs(session, "#/company-os/stops");

    await screen.getByRole("link", { name: "Active and cleared" }).click();

    await expect
      .element(screen.getByText("Drill over", { exact: true }))
      .toBeVisible();
    const cleared = rowOf("Drill over")?.textContent ?? "";
    expect(cleared).toContain("cleared");
    expect(cleared).toContain(`tenant ${TENANT}`);
    expect(cleared).toContain(rid("stop:tenant"));
    const clearedKind = rowOf("Kind drill over")?.textContent ?? "";
    expect(clearedKind).toContain("read-only");
    expect(clearedKind).toContain("job kind agent_run.execute");
    expect(session.callsOf("list_stops").at(-1)?.args.p_include_cleared).toBe(
      true,
    );
  });
});
