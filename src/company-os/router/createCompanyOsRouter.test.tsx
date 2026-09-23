import { NOT_FOUND_TEXT } from "../components/queryErrors";
import { DATA_BANNER_TEXT } from "../shell/DataBanner";
import { createRecordedSession } from "../testing/recorded";
import { renderCompanyOs } from "../testing/renderCompanyOs";
import { COMPANY_OS_LOAD_FAILED_TEXT } from "../surface/CompanyOsLoader";

// The Company OS router's own guarantees: a render error anywhere below its
// root shows fixed text, never the error (docs/PHASE_2C_BRIEF.md §6.2: no
// projection value may reach an error page), and a record id in the address
// that the input contract would refuse is "not found" with no read sent, never
// a server contract failure.

const FAILURE_TEXT = "Synthetic render failure naming a projection value";

const Throwing = () => {
  throw new Error(FAILURE_TEXT);
};

/** Long enough for any read a render would start to have been sent. */
const outlastStrayReads = () =>
  new Promise((resolve) => setTimeout(resolve, 150));

describe("the Company OS router", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, "", "#/");
  });

  it("shows fixed text, never the error or its stack, when a screen throws while it renders", async () => {
    // React and react-router report the error they caught; nothing to see here.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const screen = await renderCompanyOs(
      createRecordedSession(),
      "#/company-os/tasks",
      { screens: { tasks: Throwing } },
    );

    await expect
      .element(screen.getByText(COMPANY_OS_LOAD_FAILED_TEXT))
      .toBeVisible();
    await expect.element(screen.getByText(DATA_BANNER_TEXT)).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Voltar ao CRM" }))
      .toHaveAttribute("href", "#/");
    const text = document.body.textContent ?? "";
    expect(text).not.toContain(FAILURE_TEXT);
    expect(text).not.toMatch(/Unexpected Application Error|at Throwing/);
  });

  it.each([
    "#/company-os/tasks/not-a-uuid",
    "#/company-os/runs/00000000-0000-4000-8000-00000000000G",
    "#/company-os/reviews/00000000-0000-4000-8000-0000000000AB",
    "#/company-os/agents/%00",
    "#/company-os/activity/task/12345",
    "#/company-os/activity/run/00000000000040008000000000000001",
  ])("renders %s as not found and sends no read for it", async (hash) => {
    const session = createRecordedSession();

    const screen = await renderCompanyOs(session, hash);

    await expect.element(screen.getByText(NOT_FOUND_TEXT)).toBeVisible();
    await outlastStrayReads();
    expect(
      session.calls.filter(
        (call) =>
          call.operation !== "operator_context" &&
          call.operation !== "list_agents",
      ),
    ).toEqual([]);
    expect(document.body.textContent).not.toMatch(/contract/);
  });
});
