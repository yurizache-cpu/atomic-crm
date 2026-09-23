import { createHashRouter, type RouteObject } from "react-router";

import { NotFoundScreen } from "../screens/NotFoundScreen";
import {
  DEFAULT_SCREENS,
  SCREENS,
  type ScreenComponents,
} from "../screens/screens";
import { Shell } from "../shell/Shell";
import { CompanyOsUnavailable } from "../surface/CompanyOsLoader";

// The Company OS module's own hash router (docs/PHASE_2C_BRIEF.md §6.2),
// created once per mount and disposed on unmount (useOwnedRouter). The Shell
// wraps every route, so a deep link such as #/company-os/reviews/<id> renders
// the signed-out or no-access state like any other page, and each screen owns
// everything below its path.
//
// A render error anywhere below the root lands on the root's errorElement,
// which shows fixed text and never the error: without it, react-router's
// default error page would print the error's message (and, in development,
// its stack), where a projection value could appear.

const screenRoutes = (overrides: Partial<ScreenComponents>): RouteObject[] =>
  SCREENS.map(({ id, path }) => {
    const Screen = overrides[id] ?? DEFAULT_SCREENS[id];
    return path === ""
      ? { index: true, element: <Screen /> }
      : { path: `${path}/*`, element: <Screen /> };
  });

export const createCompanyOsRouter = (
  overrides: Partial<ScreenComponents> = {},
) =>
  createHashRouter([
    {
      path: "/",
      element: <Shell />,
      errorElement: <CompanyOsUnavailable />,
      children: [
        {
          path: "company-os",
          children: [
            ...screenRoutes(overrides),
            { path: "*", element: <NotFoundScreen /> },
          ],
        },
        { path: "*", element: <NotFoundScreen /> },
      ],
    },
  ]);
