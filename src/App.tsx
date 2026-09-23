import { lazy, useState } from "react";

import { CRM } from "@/components/atomic-crm/root/CRM";

import { CompanyOsLoader } from "./company-os/surface/CompanyOsLoader";
import { SurfaceSwitch } from "./company-os/surface/SurfaceSwitch";
import { createSupabaseSessionPort } from "./companyOsSession";

// The application shell: the only file that knows both the CRM and the
// Company OS (docs/PHASE_2C_BRIEF.md §6.2; owner decision S0-A). Every hash
// outside #/company-os renders the CRM exactly as before, inside the one
// router the shell owns; #/company-os and below loads the Company OS module on
// first visit. See src/company-os/surface/ for the switch, the router host,
// the POP guard and the loader that keeps a failed load on its own surface.

const CompanyOsApp = lazy(() => import("./company-os/CompanyOsApp"));

/** The Company OS, with the CRM's own supabase-js client behind its session port. */
const CompanyOsWithSession = () => {
  // Built when the Company OS mounts, never on a CRM-only load, and inside the
  // loader's boundary, so a failure here stays on the Company OS surface too.
  const [session] = useState(() => createSupabaseSessionPort());
  return <CompanyOsApp session={session} />;
};

const CompanyOs = () => (
  <CompanyOsLoader>
    <CompanyOsWithSession />
  </CompanyOsLoader>
);

/**
 * Application entry point
 *
 * Customize Atomic CRM by passing props to the CRM component:
 *  - companySectors
 *  - darkTheme
 *  - dealCategories
 *  - dealPipelineStatuses
 *  - dealStages
 *  - lightTheme
 *  - darkModeLogo / lightModeLogo
 *  - noteStatuses
 *  - taskTypes
 *  - title
 * ... as well as all the props accepted by shadcn-admin-kit's <Admin> component.
 *
 * Logos must be an imported asset, an absolute URL, or a data URI — never a
 * route-relative path like "./img/logo.png", which breaks on nested routes.
 *
 * @example
 * import logoDark from "./logo-dark.svg";
 * import logoLight from "./logo-light.svg";
 *
 * const App = () => (
 *    <SurfaceSwitch
 *       crm={<CRM darkModeLogo={logoDark} lightModeLogo={logoLight} title="Acme CRM" />}
 *       companyOs={<CompanyOs />}
 *    />
 * );
 */
const App = () => <SurfaceSwitch crm={<CRM />} companyOs={<CompanyOs />} />;

export default App;
