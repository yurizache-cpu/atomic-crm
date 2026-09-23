import { createContext, useContext, type ReactNode } from "react";
import { createHashRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

import { useOwnedRouter } from "./useOwnedRouter";

// The application-owned router around the UNEDITED CRM (owner decision S0-A,
// docs/PHASE_2C_REPORT.md §3.1).
//
// ra-core's AdminRouter creates its own hash router only when it is not
// already inside one (RouterWrapper, `useInRouterContext()`), and that
// internal router is created on every render and never disposed. Mounted
// here, the CRM finds a router and creates none. The shape mirrors ra-core's
// own, one catch-all route, and it is a DATA router (createHashRouter plus
// RouterProvider, not <HashRouter>): ra-core's `useCanBlock` needs the data
// router context, so an unsaved-changes blocker keeps working.
//
// The route element reads the CRM through a context rather than capturing it
// when the router is created, so the router lives for the whole CRM mount
// while the element stays whatever App renders now.

const CrmElement = createContext<ReactNode>(null);

const CrmRoute = () => useContext(CrmElement);

const createCrmRouter = () =>
  createHashRouter([{ path: "*", element: <CrmRoute /> }]);

export const CrmRouterHost = ({ children }: { children: ReactNode }) => {
  const router = useOwnedRouter(createCrmRouter);
  if (router === null) return null;
  return (
    <CrmElement.Provider value={children}>
      <RouterProvider router={router} />
    </CrmElement.Provider>
  );
};
