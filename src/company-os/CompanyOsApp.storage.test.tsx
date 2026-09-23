import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import CompanyOsApp from "./CompanyOsApp";
import { SCREENS, screenPath } from "./screens/screens";
import { createFakeSession, ok, type FakeSession } from "./testing/fakeSession";
import { cachedText, createStopsProbe } from "./testing/probes";
import { createRecordedSession, rid } from "./testing/recorded";
import { renderCompanyOs } from "./testing/renderCompanyOs";
import {
  ADVICE_REVIEW,
  ADVICE_SUMMARY,
  EVERY_ROUTE,
  openAdvice,
  visit,
} from "./testing/routes";
import {
  TENANT_A,
  TENANT_B,
  USER_A,
  operatorContext,
  stopList,
} from "./testing/samples";

// SI-59 and docs/PHASE_2C_BRIEF.md §6.3 item 4, §13 item 6: nothing the
// Company OS reads reaches durable browser storage, and its in-memory query
// cache is emptied on sign-out and on a change of tenant. Modelled on
// src/components/atomic-crm/root/CRM.security.test.tsx, and stricter: storage
// is compared with a snapshot taken before the module mounted, so a key the
// page already held (the Supabase session, ra-core's store, the chunk-reload
// guard, the sidebar cookie) is tolerated only when it is left untouched, and
// IndexedDB and Cache Storage are read as well as the two Web Storage areas.
//
// Two more places a page can keep what it showed are checked on every page:
// history.state (react-router writes `{ usr, key, idx }` there, `usr` being
// the state a navigation carries; the module passes none) and document.title
// (the module never sets it). And react-router 7.17's data router writes to
// sessionStorage on `pagehide` (the view transitions it applied, under
// `remix-router-transitions`) while it is alive, and only after a navigation
// that asked for a view transition, which the module never does (measured in
// node_modules/react-router, 2026-09-23): so `pagehide` is fired while the
// module and its router are still mounted, as well as after they are gone.
// The screens read answers recorded from the real projections.

const TENANT_NAME = "Sentineltenant Synthetic Clinic";
const STOP_REASON = "Sentinel stop reason: synthetic maintenance window";
const SECOND_TENANT_NAME = "Second synthetic clinic";
const SECOND_STOP_REASON = "Stop reason of the second tenant";
/** What the screens render from the recordings: free texts, ids, amounts. */
const SCREEN_DATA = [
  "COS Contract Tenant",
  "Lead Triage",
  "Clinic Annex",
  "Paused Desk",
  "Synthetic pause of the follow-up desk",
  "Synthetic annex pause",
  "Drill over",
  "Call back tomorrow",
  "Synthetic test line",
  "Production line",
  ADVICE_SUMMARY,
  "Offer two synthetic slots.",
  "dbtest-cos-contract-model",
  "100000.000000",
  "131047",
  rid("tenant:main"),
  rid("principal:member"),
  rid("task:accepted-1"),
  rid("run:working"),
  rid("review:opened"),
  rid("stop:agent"),
  USER_A.userId,
];

// A persister writes on a throttle (1000 ms by default). Wait past it, as the
// CRM's own sentinel test does, so one cannot pass by not having written yet.
const outlastPersisterThrottle = () =>
  new Promise((resolve) => setTimeout(resolve, 2000));

const COOKIE = "sidebar_state=true";

/** What a signed-in CRM user's browser already holds before the module loads. */
const seedPreExistingState = () => {
  localStorage.setItem("sb-127-auth-token", "synthetic-session-placeholder");
  localStorage.setItem("RaStoreCRM.theme", '"light"');
  sessionStorage.setItem("chunk-reload", "1");
  document.cookie = `${COOKIE}; path=/`;
};

const entriesOf = (storage: Storage) =>
  Object.keys(storage)
    .sort()
    .map((key) => [key, storage.getItem(key)]);

const browserStorage = async () => ({
  localStorage: entriesOf(localStorage),
  sessionStorage: entriesOf(sessionStorage),
  cookies: document.cookie.split("; ").filter(Boolean).sort(),
  indexedDB: (await indexedDB.databases()).map((db) => db.name).sort(),
  cacheStorage: (await caches.keys()).sort(),
});

/** Every sentinel any test in this file makes the module read. */
const EVERY_SENTINEL = [
  ...SCREEN_DATA,
  TENANT_NAME,
  STOP_REASON,
  SECOND_TENANT_NAME,
  SECOND_STOP_REASON,
];

const expectNoSentinelIn = async (when: string) => {
  const stored = JSON.stringify(await browserStorage());
  for (const sentinel of EVERY_SENTINEL) {
    expect(
      stored,
      `"${sentinel}" reached browser storage ${when}`,
    ).not.toContain(sentinel);
  }
};

/**
 * The current history entry holds no navigation state and nothing the page
 * showed, and the title is the one the page had before the module mounted.
 */
const expectNothingKeptInThePage = (where: string, title: string) => {
  const state = (history.state ?? {}) as { usr?: unknown };
  expect(state.usr ?? null, `history.state.usr on ${where}`).toBeNull();
  const kept = JSON.stringify(history.state);
  for (const sentinel of EVERY_SENTINEL) {
    expect(kept, `"${sentinel}" in history.state on ${where}`).not.toContain(
      sentinel,
    );
  }
  expect(document.title, `document.title on ${where}`).toBe(title);
};

/** The page is being left: what a browser fires before it unloads it. */
const leaveThePage = () => {
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: false }),
  );
  document.dispatchEvent(new Event("visibilitychange"));
};

const signedInWithSentinels = (): FakeSession => {
  const session = createFakeSession(USER_A);
  session.answer("operator_context", () =>
    ok(operatorContext(TENANT_A, TENANT_NAME)),
  );
  session.answer("list_stops", () => ok(stopList(STOP_REASON)));
  return session;
};

const renderWithProbe = async (session: FakeSession) => {
  const probe = createStopsProbe();
  history.replaceState(null, "", "#/company-os");
  const screen = await render(
    <CompanyOsApp
      session={session.port}
      screens={{ overview: probe.Screen }}
    />,
  );
  await expect.element(screen.getByText(STOP_REASON)).toBeVisible();
  await expect.element(screen.getByText(TENANT_NAME)).toBeVisible();
  return { screen, probe };
};

describe("the Company OS keeps what it reads out of browser storage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    seedPreExistingState();
  });

  afterEach(async () => {
    // Unmount now, not in the next test's beforeEach, and look before
    // clearing: a write made while the module unmounts must still be seen.
    await cleanup();
    try {
      await expectNoSentinelIn("once the module unmounted");
    } finally {
      localStorage.clear();
      sessionStorage.clear();
      document.cookie = `${COOKIE}; path=/; max-age=0`;
      history.replaceState(null, "", "#/");
    }
  });

  it("the sweep reaches every screen of the navigation", () => {
    for (const screen of SCREENS) {
      const path = `#${screenPath(screen)}`;
      expect(
        EVERY_ROUTE.some(
          (route) => route.hash === path || route.hash.startsWith(`${path}?`),
        ),
        path,
      ).toBe(true);
    }
  });

  it.each([
    { layout: "mobile", width: 375, height: 812 },
    { layout: "desktop", width: 1600, height: 900 },
  ])(
    "the $layout shell leaves every storage area, the history entries and the title exactly as it found them after every screen renders its data",
    async ({ width, height }) => {
      await page.viewport(width, height);
      const before = await browserStorage();
      const title = document.title;
      const screen = await renderCompanyOs(
        createRecordedSession(),
        EVERY_ROUTE[0].hash,
      );

      for (const route of EVERY_ROUTE) {
        await visit(screen, route);
        expectNothingKeptInThePage(route.hash, title);
      }
      await visit(
        screen,
        EVERY_ROUTE.find((route) => route.hash.endsWith(ADVICE_REVIEW))!,
      );
      await openAdvice(screen);
      expectNothingKeptInThePage("the opened advice", title);
      // The page is left while the module, its router and the advice are
      // still mounted: react-router's own pagehide handler runs now.
      leaveThePage();
      await outlastPersisterThrottle();

      expect(await browserStorage()).toEqual(before);
      await expectNoSentinelIn("while every screen was read and left");

      // Then the advice view closes, the module unmounts and the page is left:
      // a write on any of those must be seen as well.
      await screen.getByRole("button", { name: "Hide advice" }).click();
      await expect
        .element(screen.getByText(ADVICE_SUMMARY, { exact: true }))
        .not.toBeInTheDocument();
      await screen.unmount();
      leaveThePage();
      await outlastPersisterThrottle();

      expect(await browserStorage()).toEqual(before);
      expectNothingKeptInThePage("after the module unmounted", title);
      await expectNoSentinelIn(
        "after the advice closed and the module unmounted",
      );
    },
    60_000,
  );

  it("empties the query cache on SIGNED_OUT, and storage still holds nothing of it", async () => {
    const before = await browserStorage();
    const session = signedInWithSentinels();
    const { screen, probe } = await renderWithProbe(session);

    session.emit("SIGNED_OUT", null);

    await expect
      .element(screen.getByRole("heading", { name: "Signed out" }))
      .toBeVisible();
    expect(probe.client().getQueryCache().getAll()).toEqual([]);
    expect(await browserStorage()).toEqual(before);
  });

  it("empties the query cache when the tenant changes, before the new tenant's data is read", async () => {
    const session = signedInWithSentinels();
    const { screen, probe } = await renderWithProbe(session);
    const cache = probe.client().getQueryCache();
    let secondTenantServed = false;
    let emptiedAfterTheChange = false;
    const stopWatching = cache.subscribe(() => {
      if (secondTenantServed && cache.getAll().length === 0) {
        emptiedAfterTheChange = true;
      }
    });
    session.answer("operator_context", () => {
      secondTenantServed = true;
      return ok(operatorContext(TENANT_B, SECOND_TENANT_NAME));
    });
    session.answer("list_stops", () => ok(stopList(SECOND_STOP_REASON)));

    // The tab becomes visible again: operator_context is read on focus.
    window.dispatchEvent(new Event("visibilitychange"));

    await expect.element(screen.getByText(SECOND_STOP_REASON)).toBeVisible();
    await expect.element(screen.getByText(SECOND_TENANT_NAME)).toBeVisible();
    stopWatching();
    expect(emptiedAfterTheChange).toBe(true);
    const cached = cachedText(probe.client());
    expect(cached).not.toContain(STOP_REASON);
    expect(cached).not.toContain(TENANT_NAME);
    expect(cached).not.toContain(TENANT_A);
  });
});
