import { CONTRACT_ERROR_TEXT } from "../../components/queryErrors";
import { MONEY_NOTE, PLATFORM_ADMISSION_LABEL } from "../../copy";
import { ok } from "../../testing/fakeSession";
import { createRecordedSession, recorded, rid } from "../../testing/recorded";
import { renderCompanyOs } from "../../testing/renderCompanyOs";

// Screen 8 (docs/PHASE_2C_BRIEF.md §9, §12, §13 item 5), fed with the spend
// the real projection returned: the tenant's own budget rows and today's
// charged cost by agent and by model, every amount the server's own string,
// the platform admission boolean only (set by a platform stop); an amount that
// breaks its contract is not shown at all.

const rowOf = (text: string) =>
  [...document.querySelectorAll("tr")].find((row) =>
    row.textContent?.includes(text),
  );

describe("the Costs screen", () => {
  afterEach(() => {
    history.replaceState(null, "", "#/");
  });

  it("renders every amount exactly as the server formatted it", async () => {
    const spend = recorded("spend_summary");
    const [tenantRow] = spend.tenantRows;
    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/costs",
    );

    await expect
      .element(screen.getByRole("table", { name: "Daily limits" }))
      .toBeVisible();
    const tenant = rowOf("conditional")?.textContent ?? "";
    for (const money of [
      tenantRow.dailyLimit,
      tenantRow.charged,
      tenantRow.settled,
      tenantRow.estimated,
      tenantRow.remaining,
    ]) {
      expect(tenant).toContain(`${money.usd} USD`);
    }
    const company = rowOf(rid("company:clinic-annex"))?.textContent ?? "";
    expect(company).toContain("0.000000 USD");
    expect(company).toContain("blocked");
    await expect
      .element(screen.getByRole("table", { name: "Charged today by agent" }))
      .toHaveTextContent("Lead Triage");
    await expect
      .element(screen.getByRole("table", { name: "Charged today by model" }))
      .toHaveTextContent("dbtest-cos-contract-model");
    await expect.element(screen.getByText(MONEY_NOTE)).toBeVisible();
    await expect
      .element(screen.getByLabelText("Window"))
      .toHaveTextContent(`${PLATFORM_ADMISSION_LABEL}no`);
  });

  it("shows the platform admission as blocked, and nothing else of the platform, under a platform stop", async () => {
    const screen = await renderCompanyOs(
      createRecordedSession("platform-stop"),
      "#/company-os/costs",
    );

    await expect
      .element(screen.getByLabelText("Window"))
      .toHaveTextContent(`${PLATFORM_ADMISSION_LABEL}yes`);
    expect(
      recorded("spend_summary", {}, "platform-stop").tenantRows.map(
        (row) => row.scope,
      ),
    ).toEqual(["tenant", "company"]);
  });

  it("renders an error, not the amounts, when an amount's USD string does not match its micros", async () => {
    // Hand-built on purpose: SQL formats the USD string from the micros, so
    // only a tampered answer can disagree with itself. It is the recorded
    // spend with one USD string changed.
    const spend = recorded("spend_summary");
    const [tenantRow, ...rest] = spend.tenantRows;
    const session = createRecordedSession();
    session.answer("spend_summary", () =>
      ok({
        ...spend,
        tenantRows: [
          {
            ...tenantRow,
            dailyLimit: {
              micros: tenantRow.dailyLimit.micros,
              usd: "9.999999",
            },
          },
          ...rest,
        ],
      }),
    );

    const screen = await renderCompanyOs(session, "#/company-os/costs");

    await expect.element(screen.getByText(CONTRACT_ERROR_TEXT)).toBeVisible();
    expect(document.body.textContent).not.toContain("9.999999");
    expect(document.body.textContent).not.toContain(tenantRow.dailyLimit.usd);
  });
});
