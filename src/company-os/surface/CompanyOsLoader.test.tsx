import { lazy, type ReactNode } from "react";
import { useLocation, useNavigation } from "react-router";
import { render } from "vitest-browser-react";

import { DATA_BANNER_TEXT } from "../shell/DataBanner";
import {
  COMPANY_OS_LOAD_FAILED_TEXT,
  CompanyOsLoader,
} from "./CompanyOsLoader";
import { SurfaceSwitch } from "./SurfaceSwitch";

// The loader src/App.tsx wraps the lazy Company OS in (docs/PHASE_2C_BRIEF.md
// §6.2): a chunk that fails to load, or an error thrown before the module's
// own router exists, stays on the Company OS surface. The page shows fixed
// text and never the error, and the CRM comes back as soon as the hash leaves
// the prefix. The real switch; a stand-in for <CRM/>. All data synthetic.

const FAILURE_TEXT = "Synthetic failure in /assets/CompanyOsApp-synthetic.js";

/** Renders only inside the application's data router, as the CRM does. */
const CrmStandIn = () => {
  useNavigation();
  const location = useLocation();
  return <p>{`CRM at ${location.pathname}`}</p>;
};

const crossTo = async (hash: string) => {
  const moved = new Promise((resolve) =>
    window.addEventListener("hashchange", resolve, { once: true }),
  );
  location.hash = hash;
  await moved;
};

const FailingChunk = lazy(() => Promise.reject(new Error(FAILURE_TEXT)));

const ThrowingOnMount = (): ReactNode => {
  throw new Error(FAILURE_TEXT);
};

describe("the Company OS loader", () => {
  beforeEach(() => {
    // React reports an error a boundary caught; this test needs no report.
    vi.spyOn(console, "error").mockImplementation(() => {});
    history.replaceState(null, "", "#/contacts");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    history.replaceState(null, "", "#/");
  });

  it.each([
    { failure: "a chunk that fails to load", CompanyOs: FailingChunk },
    { failure: "an error thrown while it mounts", CompanyOs: ThrowingOnMount },
  ])(
    "keeps $failure on the Company OS surface, shows no error text, and gives the CRM back when the hash leaves the prefix",
    async ({ CompanyOs }) => {
      const screen = await render(
        <SurfaceSwitch
          crm={<CrmStandIn />}
          companyOs={
            <CompanyOsLoader>
              <CompanyOs />
            </CompanyOsLoader>
          }
        />,
      );
      await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();

      await crossTo("#/company-os");

      await expect
        .element(screen.getByText(COMPANY_OS_LOAD_FAILED_TEXT))
        .toBeVisible();
      await expect.element(screen.getByText(DATA_BANNER_TEXT)).toBeVisible();
      await expect
        .element(screen.getByRole("link", { name: "Voltar ao CRM" }))
        .toHaveAttribute("href", "#/");
      expect(document.body.textContent).not.toContain(FAILURE_TEXT);

      await crossTo("#/contacts");

      await expect.element(screen.getByText("CRM at /contacts")).toBeVisible();
    },
  );
});
