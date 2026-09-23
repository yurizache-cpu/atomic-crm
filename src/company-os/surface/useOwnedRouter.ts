import { useLayoutEffect, useState } from "react";
import type { createHashRouter } from "react-router";

import { notifySurfaceChange } from "./popGuard";

export type OwnedRouter = ReturnType<typeof createHashRouter>;

/**
 * A data router this component owns: created once per mount, disposed on
 * unmount (docs/PHASE_2C_REPORT.md §3.1, owner decision S0-A).
 *
 * `createHashRouter` initialises at once: it adds a `popstate` and a
 * `pagehide` listener to window, and only `router.dispose()` removes them. So
 * the router is created inside the effect, never during render and never in a
 * `useState` initialiser: StrictMode discards a render, and runs every effect
 * twice on mount, cleanup in between. Created in render, a discarded render
 * would leak a router; kept in state across the simulated unmount, the second
 * mount would reuse a disposed router with no history listener. Here the
 * first router is disposed and the second one is the one rendered. A layout
 * effect, so the router exists before the first paint.
 *
 * Every navigation of the router is reported to the surface switch
 * (popGuard.notifySurfaceChange): a PUSH or REPLACE fires no event the switch
 * listens to, and one that leaves this router's surface must still unmount it.
 * react-router updates the location before it notifies its subscribers.
 *
 * Returns null until the router exists; the caller renders nothing then.
 */
export const useOwnedRouter = (
  create: () => OwnedRouter,
): OwnedRouter | null => {
  // The factory of the first render; a later one is ignored, as a route table
  // is fixed for the router's life.
  const [factory] = useState(() => create);
  const [router, setRouter] = useState<OwnedRouter | null>(null);

  useLayoutEffect(() => {
    const owned = factory();
    const stopReporting = owned.subscribe(notifySurfaceChange);
    setRouter(owned);
    return () => {
      stopReporting();
      owned.dispose();
    };
  }, [factory]);

  return router;
};
