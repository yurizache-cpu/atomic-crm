import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

import { CrmRouterHost } from "./CrmRouterHost";
import { mountSurface, readSurface, subscribeToSurface } from "./popGuard";

// The top-level switch (docs/PHASE_2C_BRIEF.md §6.2; owner decision S0-A).
//
// `#/company-os` and below renders the Company OS; every other hash renders
// the CRM, unedited, inside the one router the application owns. Switching
// unmounts one tree and mounts the other: nothing is shared between them but
// the page, the session and the history.
//
// The switch follows popstate and hashchange through the POP guard's store,
// and every navigation of the two routers the application owns (a router's
// own PUSH or REPLACE fires neither event; useOwnedRouter reports it). A link
// out of the Company OS is still a plain <a href> to a constant hash
// (AccessStates.tsx), which a new visitor can follow and read as a link.

export interface SurfaceSwitchProps {
  /** The CRM, rendered inside the application-owned hash router. */
  readonly crm: ReactNode;
  /** The Company OS, which owns its own router. */
  readonly companyOs: ReactNode;
}

export const SurfaceSwitch = ({ crm, companyOs }: SurfaceSwitchProps) => {
  const surface = useSyncExternalStore(subscribeToSurface, readSurface);

  useLayoutEffect(() => mountSurface(surface), [surface]);

  return surface === "company-os" ? (
    companyOs
  ) : (
    <CrmRouterHost>{crm}</CrmRouterHost>
  );
};
