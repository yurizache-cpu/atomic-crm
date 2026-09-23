// The surface store and the POP guard (owner decision S0-A;
// docs/PHASE_2C_REPORT.md §3.1).
//
// THE HAZARD. A react-router data router listens to `popstate` on window. On a
// POP navigation with a blocker registered, it computes `delta` from the
// `idx` it stored in history.state and reverts with `history.go(-delta)`. Two
// routers that write `idx` into the same session history (the CRM's and the
// Company OS's) count in different index spaces, so a router asked to judge a
// POP onto the other surface's entry can compute any delta: `go(-1)` traps the
// user on the surface they are leaving, and `go(0)` is a full reload. ra-core
// 5.14.7 made that worse by leaving an undisposed router behind on every CRM
// render; the app-owned router in CrmRouterHost removes those, and this guard
// removes the crossing case itself.
//
// THE GUARD. One `popstate` listener, installed when this module is first
// evaluated, which is before any router exists: App.tsx imports this module
// statically, and every router is created later, in a layout effect. Listeners
// on window run in registration order, the capture flag notwithstanding
// (measured in Chromium, 2026-09-23), so it runs before every router's. When a
// POP lands on the other side of the `#/company-os` prefix from the surface
// that is mounted, it stops the event there: no router, live or stale, ever
// judges a POP that crosses the prefix, so none can call `history.go` across
// it. It then tells the switch, which unmounts the surface being left (its
// router is disposed) and mounts the other, whose new router reads the current
// location. A POP that stays on one side goes through untouched to that
// surface's live router, blockers included.
//
// Two layers, measured: React flushes the switch's update in the microtask
// checkpoint that follows this listener, so the live router of the surface
// being left is disposed, and its listener removed, before it would have run;
// the stop does not rely on that timing, and it is the only thing that keeps a
// router nobody disposed from judging the POP (SurfaceSwitch.test.tsx, "a
// stale router").
//
// What it does not do: protect an unsaved CRM form against a Back that leaves
// the CRM (the surface is unmounted without a prompt, as it is by an address
// bar edit), or re-check a POP that jumps between two entries of one surface
// across the other surface's entries (that router computes a delta in a mixed
// index space; harmless without a blocker). No CRM form blocks navigation
// today; supabase/tests/crmNavigationBlockers.test.ts fails the day one does,
// so the cross-surface tests can be extended to exercise it. Until then
// src/App.test.tsx proves the path with a test-only ra-core form: its blocker
// holds a Back inside the CRM, and a Back across the prefix leaves it.

import { surfaceOfHash, type Surface } from "./prefix";

let mountedSurface: Surface | null = null;
const subscribers = new Set<() => void>();

const notify = () => {
  for (const subscriber of subscribers) subscriber();
};

/** The surface the current location belongs to. */
export const readSurface = (): Surface => surfaceOfHash(window.location.hash);

/**
 * A navigation the switch cannot hear: a router's own PUSH or REPLACE is a
 * pushState or replaceState, which fires neither popstate nor hashchange.
 * useOwnedRouter calls this on every navigation of the routers it owns, so a
 * router Link or navigate() that crosses the prefix switches surfaces too.
 */
export const notifySurfaceChange = (): void => notify();

export const subscribeToSurface = (subscriber: () => void): (() => void) => {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
};

/**
 * The switch reports the surface it renders, so the guard can tell a crossing
 * POP from one that stays. Returns the release for the layout effect.
 */
export const mountSurface = (surface: Surface): (() => void) => {
  mountedSurface = surface;
  return () => {
    if (mountedSurface === surface) mountedSurface = null;
  };
};

const guardPop = (event: PopStateEvent) => {
  if (mountedSurface !== null && readSurface() !== mountedSurface) {
    event.stopImmediatePropagation();
  }
  notify();
};

window.addEventListener("popstate", guardPop, { capture: true });
// A fragment navigation fires popstate too; hashchange is the second signal
// for the switch, and no router listens to it.
window.addEventListener("hashchange", notify);
