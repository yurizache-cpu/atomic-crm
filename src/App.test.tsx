import { StrictMode } from "react";
import { CoreAdminContext, Form, useInput } from "ra-core";
import { render } from "vitest-browser-react";

import { testI18nProvider } from "@/components/atomic-crm/providers/commons/i18nProvider";
import { createDataProvider } from "@/components/atomic-crm/providers/fakerest";
import { CRM } from "@/components/atomic-crm/root/CRM";
import { createCrmDb, createTestAuthProvider } from "@/test/StoryWrapper";

import { SurfaceSwitch } from "./company-os/surface/SurfaceSwitch";
import { trackWindowListeners } from "./company-os/testing/windowListeners";

// The application shell around the REAL, unedited CRM (owner decision S0-A;
// docs/PHASE_2C_REPORT.md §3.1). The switch's own tests use a stand-in for
// <CRM/>; this one mounts the CRM itself, on the in-browser FakeRest provider
// with a test auth provider (as CRM.security.test.tsx does), to measure what
// ra-core does with the router the application gives it: under StrictMode,
// across Back and Forward over the prefix. And, because no CRM form blocks
// navigation today (supabase/tests/crmNavigationBlockers.test.ts), a
// test-only ra-core <Form warnWhenUnsavedChanges> stands where such a form
// would be, to prove ra-core's blocker sees the application's DATA router
// (useCanBlock) and that a Back crossing the prefix is neither blocked nor
// turned into a reload. All data synthetic.

const DASHBOARD_TEXT = "Synthetic CRM dashboard";
const Dashboard = () => <p>{DASHBOARD_TEXT}</p>;

const theCrm = () => (
  <CRM
    dataProvider={createDataProvider({
      db: createCrmDb(),
      silent: true,
      latency: 0,
    })}
    authProvider={createTestAuthProvider()}
    i18nProvider={testI18nProvider}
    dashboard={Dashboard}
    disableTelemetry
  />
);

const CompanyOsStandIn = () => <p>Company OS stand-in</p>;

/** What a CRM edit form holds: one ra-core input, warning when unsaved. */
const NameInput = () => {
  const { field } = useInput({ source: "name" });
  return <input aria-label="Name" {...field} value={field.value ?? ""} />;
};

const UnsavedFormHarness = () => (
  <CoreAdminContext
    dataProvider={createDataProvider({
      db: createCrmDb(),
      silent: true,
      latency: 0,
    })}
    authProvider={createTestAuthProvider()}
    i18nProvider={testI18nProvider}
  >
    <Form warnWhenUnsavedChanges record={{ id: 1, name: "" }}>
      <NameInput />
    </Form>
  </CoreAdminContext>
);

/** A marker only the same page can still hold: a reload would drop it. */
const PAGE_MARKER = "companyOsAppShellTestMarker";
const markPage = () => {
  const marker = {};
  Reflect.set(window, PAGE_MARKER, marker);
  return marker;
};

/** Moves through history and waits for the hash to change. */
const traverse = async (move: () => void) => {
  const moved = new Promise((resolve) =>
    window.addEventListener("hashchange", resolve, { once: true }),
  );
  move();
  await moved;
};

const crossTo = async (hash: string) => {
  const moved = new Promise((resolve) =>
    window.addEventListener("hashchange", resolve, { once: true }),
  );
  location.hash = hash;
  await moved;
};

describe("the application shell around the unedited CRM", () => {
  beforeEach(() => {
    history.replaceState(null, "", "#/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, "", "#/");
  });

  it("mounts the CRM inside the one router it owns, so ra-core creates none, across repeated crossings", async () => {
    const livePopstate = trackWindowListeners("popstate");
    const screen = await render(
      <SurfaceSwitch crm={theCrm()} companyOs={<CompanyOsStandIn />} />,
    );
    await expect.element(screen.getByText(DASHBOARD_TEXT)).toBeVisible();
    expect(livePopstate()).toBe(1);

    for (let round = 0; round < 3; round += 1) {
      await crossTo("#/company-os");
      await expect
        .element(screen.getByText("Company OS stand-in"))
        .toBeVisible();
      expect(livePopstate()).toBe(0);

      await crossTo("#/");
      await expect.element(screen.getByText(DASHBOARD_TEXT)).toBeVisible();
      expect(livePopstate()).toBe(1);
    }

    await screen.unmount();
    expect(livePopstate()).toBe(0);
  });

  it("runs the real CRM under StrictMode inside one router, across Back and Forward over the prefix, without a reload or a leaked router", async () => {
    const marker = markPage();
    const livePopstate = trackWindowListeners("popstate");
    const screen = await render(
      <StrictMode>
        <SurfaceSwitch crm={theCrm()} companyOs={<CompanyOsStandIn />} />
      </StrictMode>,
    );
    await expect.element(screen.getByText(DASHBOARD_TEXT)).toBeVisible();
    expect(livePopstate()).toBe(1);

    await crossTo("#/company-os");
    await expect.element(screen.getByText("Company OS stand-in")).toBeVisible();
    expect(livePopstate()).toBe(0);

    for (let round = 0; round < 3; round += 1) {
      await traverse(() => history.back());
      await expect.element(screen.getByText(DASHBOARD_TEXT)).toBeVisible();
      expect(livePopstate()).toBe(1);

      await traverse(() => history.forward());
      await expect
        .element(screen.getByText("Company OS stand-in"))
        .toBeVisible();
      expect(livePopstate()).toBe(0);
    }

    expect(Reflect.get(window, PAGE_MARKER)).toBe(marker);
    await screen.unmount();
    expect(livePopstate()).toBe(0);
  });

  it("gives ra-core's unsaved-changes blocker the application's data router: a Back inside the CRM asks, and is held", async () => {
    history.replaceState({ idx: 3, key: "list", usr: null }, "", "#/contacts");
    history.pushState({ idx: 4, key: "edit", usr: null }, "", "#/contacts/1");
    const screen = await render(
      <SurfaceSwitch
        crm={<UnsavedFormHarness />}
        companyOs={<CompanyOsStandIn />}
      />,
    );
    await screen.getByLabelText("Name").fill("Synthetic unsaved name");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});

    await traverse(() => history.back());

    // useCanBlock saw a data router: the blocker held the POP, reverted it,
    // and ra-core asked the person, who kept their changes.
    await expect.poll(() => confirm.mock.calls.length).toBe(1);
    expect(go.mock.calls).toEqual([[1]]);
    await expect
      .element(screen.getByLabelText("Name"))
      .toHaveValue("Synthetic unsaved name");
  });

  it("lets a Back that crosses the prefix leave the unsaved form: not blocked, not reverted, not reloaded", async () => {
    const marker = markPage();
    history.replaceState(
      { idx: 3, key: "company-os", usr: null },
      "",
      "#/company-os/tasks",
    );
    history.pushState({ idx: 4, key: "edit", usr: null }, "", "#/contacts/1");
    const screen = await render(
      <SurfaceSwitch
        crm={<UnsavedFormHarness />}
        companyOs={<CompanyOsStandIn />}
      />,
    );
    await screen.getByLabelText("Name").fill("Synthetic unsaved name");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});

    await traverse(() => history.back());

    await expect.element(screen.getByText("Company OS stand-in")).toBeVisible();
    expect(confirm).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(Reflect.get(window, PAGE_MARKER)).toBe(marker);
  });

  // The measurement behind S0-A, kept as the control that proves the count
  // sees ra-core's routers: mounted with no router around it, the CRM leaves
  // routers listening after it is gone. Last in the file, because what it
  // leaks stays in this page.
  it("control: without the application's router, ra-core leaves routers listening after the CRM unmounts", async () => {
    const livePopstate = trackWindowListeners("popstate");
    const screen = await render(theCrm());
    await expect.element(screen.getByText(DASHBOARD_TEXT)).toBeVisible();

    await screen.unmount();

    expect(livePopstate()).toBeGreaterThan(0);
  });
});
