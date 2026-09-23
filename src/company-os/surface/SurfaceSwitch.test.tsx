import { StrictMode } from "react";
import {
  Link,
  createHashRouter,
  useBlocker,
  useLocation,
  useNavigation,
} from "react-router";
import { render } from "vitest-browser-react";

import CompanyOsApp from "../CompanyOsApp";
import { createFakeSession, ok } from "../testing/fakeSession";
import { TENANT_A, USER_A, operatorContext } from "../testing/samples";
import { trackWindowListeners } from "../testing/windowListeners";
import { SurfaceSwitch } from "./SurfaceSwitch";

// The top-level switch and the router lifecycle (owner decision S0-A,
// docs/PHASE_2C_REPORT.md §3.1, docs/PHASE_2C_BRIEF.md §16 "Browser").
//
// The REAL switch, router host and POP guard, with a small stand-in for <CRM/>
// passed through the same prop App.tsx passes the CRM through. The stand-in
// renders only inside a data router (useNavigation, useBlocker): the one the
// application owns, because ra-core creates none when it finds one. Navigation is real: anchors, history.back() and history.forward() in
// the test page, which fire popstate and hashchange as a browser does.

const CrmView = () => {
  const location = useLocation();
  return (
    <section aria-label="CRM stand-in">
      <p>{`CRM at ${location.pathname}${location.search}`}</p>
      <a href="#/company-os">Open the Company OS</a>
    </section>
  );
};

/** Renders only inside a data router (useNavigation throws elsewhere). */
const CrmStandIn = () => {
  useNavigation();
  return <CrmView />;
};

/** A CRM form with unsaved changes: it blocks every navigation it is asked about. */
const BlockingCrmStandIn = () => {
  useBlocker(true);
  return <CrmView />;
};

/** A CRM page that navigates into the Company OS with its own router. */
const CrmRouterLinkStandIn = () => {
  useNavigation();
  return (
    <section aria-label="CRM stand-in">
      <CrmView />
      <Link to="/company-os">Company OS through the CRM router</Link>
    </section>
  );
};

/** A Company OS screen that navigates out of the prefix with its router. */
const LeavingScreen = () => (
  <section aria-label="Leaving screen">
    <h1>Leaving screen</h1>
    <Link to="/contacts">CRM contacts through the Company OS router</Link>
  </section>
);

const CompanyOsStandIn = () => (
  <section aria-label="Company OS stand-in">
    <p>Company OS</p>
    <a href="#/">Back to the CRM</a>
  </section>
);

const nextEvent = (type: string) =>
  new Promise((resolve) =>
    window.addEventListener(type, resolve, { once: true }),
  );

/**
 * Moves through history and waits for the hash to change. Not for popstate:
 * the guard stops a popstate that crosses the prefix before any listener
 * added after it, this one included.
 */
const traverse = async (move: () => void) => {
  const moved = nextEvent("hashchange");
  move();
  await moved;
};

/** A marker only the same page can still hold: a reload would drop it. */
const PAGE_MARKER = "companyOsSurfaceTestMarker";
const markPage = () => {
  const marker = {};
  Reflect.set(window, PAGE_MARKER, marker);
  return marker;
};

const signedInSession = () => {
  const session = createFakeSession(USER_A);
  session.answer("operator_context", () =>
    ok(operatorContext(TENANT_A, "Synthetic Clinic")),
  );
  return session;
};

describe("the top-level switch between the CRM and the Company OS", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, "", "#/");
  });

  it.each([
    ["#/", "/"],
    ["#/contacts/7/show", "/contacts/7/show"],
    ["#/set-password", "/set-password"],
    ["#/forgot-password", "/forgot-password"],
    [
      "#/auth-callback?access_token=synthetic-access&type=recovery",
      "/auth-callback?access_token=synthetic-access&type=recovery",
    ],
    [
      "#/oauth/consent?authorization_id=synthetic",
      "/oauth/consent?authorization_id=synthetic",
    ],
    ["#/login", "/login"],
    ["#/company-osx", "/company-osx"],
    ["#/company", "/company"],
    // One segment, as react-router decodes it: an encoded "/" never splits.
    ["#/company-os%2Fruns", "/company-os%2Fruns"],
    ["#/company-os%2fruns/x", "/company-os%2fruns/x"],
    // A malformed escape: react-router leaves the whole path undecoded.
    ["#/company-os%E0/tasks", "/company-os%E0/tasks"],
  ])(
    "keeps %s on the CRM, routed unchanged inside one application-owned data router",
    async (hash, routed) => {
      history.replaceState(null, "", hash);
      const livePopstate = trackWindowListeners("popstate");

      const screen = await render(
        <SurfaceSwitch crm={<CrmStandIn />} companyOs={<CompanyOsStandIn />} />,
      );

      await expect.element(screen.getByText(`CRM at ${routed}`)).toBeVisible();
      expect(
        screen.getByText("Company OS", { exact: true }).query(),
      ).toBeNull();
      expect(livePopstate()).toBe(1);
      await screen.unmount();
      expect(livePopstate()).toBe(0);
    },
  );

  it.each([
    "#/company-os",
    "#/company-os/reviews/00000000-0000-4000-8000-000000000007",
    "#/company-os?tab=pending",
    "#/Company-OS/tasks",
    "#company-os",
    // Decoded per segment, as the Company OS router matches it.
    "#/%63ompany-os/tasks",
    "#/company-os/runs%2Fx",
  ])("hands %s to the Company OS and mounts no CRM router", async (hash) => {
    history.replaceState(null, "", hash);
    const livePopstate = trackWindowListeners("popstate");

    const screen = await render(
      <SurfaceSwitch crm={<CrmStandIn />} companyOs={<CompanyOsStandIn />} />,
    );

    await expect
      .element(screen.getByText("Company OS", { exact: true }))
      .toBeVisible();
    expect(screen.getByText(/^CRM at/).query()).toBeNull();
    expect(livePopstate()).toBe(0);
  });

  it("crosses by links, Back and Forward, again and again, without a reload or a leaked router", async () => {
    const marker = markPage();
    history.replaceState(null, "", "#/contacts");
    const livePopstate = trackWindowListeners("popstate");
    const screen = await render(
      <SurfaceSwitch
        crm={<CrmStandIn />}
        companyOs={<CompanyOsApp session={signedInSession().port} />}
      />,
    );
    await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();

    for (let round = 0; round < 3; round += 1) {
      await screen.getByRole("link", { name: "Open the Company OS" }).click();
      await expect.element(screen.getByText("Synthetic Clinic")).toBeVisible();
      expect(livePopstate()).toBe(1);

      await traverse(() => history.back());
      await expect.element(screen.getByText(/^CRM at \//)).toBeVisible();
      expect(livePopstate()).toBe(1);

      await traverse(() => history.forward());
      await expect.element(screen.getByText("Synthetic Clinic")).toBeVisible();
      expect(livePopstate()).toBe(1);

      await screen.getByRole("link", { name: "Voltar ao CRM" }).click();
      await expect.element(screen.getByText("CRM at /")).toBeVisible();
      expect(livePopstate()).toBe(1);
    }

    expect(Reflect.get(window, PAGE_MARKER)).toBe(marker);
    await screen.unmount();
    expect(livePopstate()).toBe(0);
  });

  it("switches to the CRM when the Company OS router itself navigates out of its prefix, and back when the CRM router navigates in", async () => {
    const marker = markPage();
    history.replaceState(null, "", "#/company-os");
    const livePopstate = trackWindowListeners("popstate");
    const screen = await render(
      <SurfaceSwitch
        crm={<CrmRouterLinkStandIn />}
        companyOs={
          <CompanyOsApp
            session={signedInSession().port}
            screens={{ overview: LeavingScreen }}
          />
        }
      />,
    );
    await expect
      .element(screen.getByRole("heading", { name: "Leaving screen" }))
      .toBeVisible();

    await screen
      .getByRole("link", { name: "CRM contacts through the Company OS router" })
      .click();

    await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();
    expect(location.hash).toBe("#/contacts");
    expect(livePopstate()).toBe(1);

    await screen
      .getByRole("link", { name: "Company OS through the CRM router" })
      .click();

    await expect
      .element(screen.getByRole("heading", { name: "Leaving screen" }))
      .toBeVisible();
    expect(screen.getByText(/^CRM at/).query()).toBeNull();
    expect(livePopstate()).toBe(1);

    await traverse(() => history.back());
    await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();
    await traverse(() => history.back());
    await expect
      .element(screen.getByRole("heading", { name: "Leaving screen" }))
      .toBeVisible();
    expect(livePopstate()).toBe(1);
    expect(Reflect.get(window, PAGE_MARKER)).toBe(marker);
  });

  it("under StrictMode, mounts exactly one live router per surface and leaves none after unmount, every time", async () => {
    const livePopstate = trackWindowListeners("popstate");

    for (let mount = 0; mount < 3; mount += 1) {
      history.replaceState(null, "", "#/contacts");
      const crm = await render(
        <StrictMode>
          <SurfaceSwitch
            crm={<CrmStandIn />}
            companyOs={<CompanyOsStandIn />}
          />
        </StrictMode>,
      );
      await expect.element(crm.getByText("CRM at /contacts")).toBeVisible();
      expect(livePopstate()).toBe(1);
      // The live router is the one rendered, not a disposed one: a POP that
      // stays on the CRM still reaches it.
      await traverse(() => {
        location.hash = "#/deals";
      });
      await expect.element(crm.getByText("CRM at /deals")).toBeVisible();
      await crm.unmount();
      expect(livePopstate()).toBe(0);

      history.replaceState(null, "", "#/company-os");
      const companyOs = await render(
        <StrictMode>
          <SurfaceSwitch
            crm={<CrmStandIn />}
            companyOs={<CompanyOsApp session={signedInSession().port} />}
          />
        </StrictMode>,
      );
      await expect
        .element(companyOs.getByText("Synthetic Clinic"))
        .toBeVisible();
      expect(livePopstate()).toBe(1);
      await companyOs.unmount();
      expect(livePopstate()).toBe(0);
    }
  });
});

describe("the POP guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, "", "#/");
  });

  // Each case lays out two history entries carrying react-router `idx`
  // values, so a router that judged the Back would compute a delta and, with
  // a blocker, revert with history.go(-delta): go(1) traps the user on the
  // CRM, go(0) reloads the page.
  it.each([
    { risk: "a revert", companyOsIdx: 3, crmIdx: 4 },
    { risk: "a reload", companyOsIdx: 4, crmIdx: 4 },
  ])(
    "keeps a Back that leaves a CRM with an active blocker from reaching its router ($risk)",
    async ({ companyOsIdx, crmIdx }) => {
      const marker = markPage();
      history.replaceState(
        { idx: companyOsIdx, key: "company-os", usr: null },
        "",
        "#/company-os/tasks",
      );
      history.pushState(
        { idx: crmIdx, key: "crm", usr: null },
        "",
        "#/contacts",
      );
      const screen = await render(
        <SurfaceSwitch
          crm={<BlockingCrmStandIn />}
          companyOs={<CompanyOsStandIn />}
        />,
      );
      await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();
      const go = vi.spyOn(history, "go").mockImplementation(() => {});

      await traverse(() => history.back());

      await expect
        .element(screen.getByText("Company OS", { exact: true }))
        .toBeVisible();
      expect(go).not.toHaveBeenCalled();
      expect(Reflect.get(window, PAGE_MARKER)).toBe(marker);
    },
  );

  it("keeps a stale router with an active blocker from judging a POP that crosses the prefix", async () => {
    history.replaceState({ idx: 7, key: "crm", usr: null }, "", "#/contacts");
    history.pushState(
      { idx: 8, key: "company-os", usr: null },
      "",
      "#/company-os",
    );
    const screen = await render(
      <SurfaceSwitch crm={<CrmStandIn />} companyOs={<CompanyOsStandIn />} />,
    );
    await expect
      .element(screen.getByText("Company OS", { exact: true }))
      .toBeVisible();
    // What ra-core 5.14.7 left behind on every CRM render: a router nobody
    // disposed, here holding an unsaved-changes blocker.
    const stale = createHashRouter([{ path: "*", element: null }]);
    stale.getBlocker("unsaved-form", () => true);
    const go = vi.spyOn(history, "go").mockImplementation(() => {});

    try {
      await traverse(() => history.back());

      await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();
      expect(go).not.toHaveBeenCalled();
    } finally {
      stale.dispose();
    }
  });

  it("lets a Back that stays on the CRM reach its router, blocker included", async () => {
    history.replaceState(
      { idx: 3, key: "contacts", usr: null },
      "",
      "#/contacts",
    );
    history.pushState({ idx: 4, key: "deals", usr: null }, "", "#/deals");
    const screen = await render(
      <SurfaceSwitch
        crm={<BlockingCrmStandIn />}
        companyOs={<CompanyOsStandIn />}
      />,
    );
    await expect.element(screen.getByText("CRM at /deals")).toBeVisible();
    const go = vi.spyOn(history, "go").mockImplementation(() => {});

    await traverse(() => history.back());

    // The router judged it: the blocker asked to revert the one step back.
    await expect.poll(() => go.mock.calls).toEqual([[1]]);
    expect(screen.getByText("Company OS", { exact: true }).query()).toBeNull();
  });
});
