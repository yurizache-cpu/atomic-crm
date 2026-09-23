import { NavLink, Outlet } from "react-router";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { OperatorContext } from "../../../contracts/company-os-api/index.ts";
import { EventsInViewProvider } from "../components/Causation";
import { SCREENS, screenPath } from "../screens/screens";
import { BackToCrmLink } from "./AccessStates";

// The Company OS frame once operator_context has answered: the left
// navigation, the operator context header and the screen. The header names the
// tenant, the data policy and the role enum; never a display name, an email or
// any other label about the person (docs/PHASE_2C_BRIEF.md §9, §13 item 2).
//
// Why a hand-rolled navigation and not src/components/ui/sidebar: that
// sidebar persists its open state by writing a `sidebar_state` cookie
// (document.cookie) on every toggle, and nothing of the Company OS may write
// browser storage, cookies included (§13 item 6, SI-59; the module's lint
// refuses document.cookie). A list of NavLinks needs no state at all.

const DATA_POLICY_LABELS: Readonly<
  Record<OperatorContext["dataPolicy"], string>
> = {
  synthetic_or_test_only: "Synthetic or test data only",
};

const Navigation = () => (
  <nav
    aria-label="Company OS"
    className="flex flex-col gap-3 border-b p-3 md:w-56 md:shrink-0 md:border-r md:border-b-0"
  >
    <ul className="flex flex-wrap gap-1 md:flex-col">
      {SCREENS.map((screen) => (
        <li key={screen.id}>
          <NavLink
            to={screenPath(screen)}
            end={screen.path === ""}
            className={({ isActive }) =>
              cn(
                "block rounded-md px-3 py-2 text-sm",
                isActive ? "bg-accent font-medium" : "hover:bg-accent/50",
              )
            }
          >
            {screen.label}
          </NavLink>
        </li>
      ))}
    </ul>
    <div className="px-3">
      <BackToCrmLink />
    </div>
  </nav>
);

const HeaderField = ({
  term,
  children,
}: {
  term: string;
  children: string;
}) => (
  <div>
    <dt className="text-xs text-muted-foreground">{term}</dt>
    <dd className="text-sm font-medium">{children}</dd>
  </div>
);

const OperatorHeader = ({
  context,
  onSignOut,
}: {
  context: OperatorContext;
  onSignOut: () => void;
}) => (
  <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
    <dl
      aria-label="Operator context"
      className="flex flex-wrap gap-x-8 gap-y-2"
    >
      <HeaderField term="Tenant">{context.tenant.name}</HeaderField>
      <HeaderField term="Data policy">
        {DATA_POLICY_LABELS[context.dataPolicy]}
      </HeaderField>
      <HeaderField term="Role">{context.role}</HeaderField>
    </dl>
    <Button variant="outline" size="sm" onClick={onSignOut}>
      Sign out
    </Button>
  </header>
);

export const OperatorFrame = ({
  context,
  onSignOut,
}: {
  context: OperatorContext;
  onSignOut: () => void;
}) => (
  <div className="flex flex-1 flex-col md:flex-row">
    <Navigation />
    <div className="flex min-w-0 flex-1 flex-col">
      <OperatorHeader context={context} onSignOut={onSignOut} />
      <main className="flex-1 p-4 md:p-6">
        <EventsInViewProvider>
          <Outlet />
        </EventsInViewProvider>
      </main>
    </div>
  </div>
);
