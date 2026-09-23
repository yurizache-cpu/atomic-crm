import { ArrowLeft, Building2, LogOut } from "lucide-react";
import { NavLink, Outlet } from "react-router";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { OperatorContext } from "../../../contracts/company-os-api/index.ts";
import { EventsInViewProvider } from "../components/Causation";
import { tenantDisplayName } from "../format/displayNames";
import { SCREEN_GROUPS, SCREENS, screenPath } from "../screens/screens";

// The Company OS frame once operator_context has answered: the grouped left
// navigation, the context bar and the screen. The bar names the tenant and the
// environment; the role enum is a small detail. Never a display name, an email
// or any other label about the person (docs/PHASE_2C_BRIEF.md §9, §13 item 2).
//
// Why a hand-rolled navigation and not src/components/ui/sidebar: that
// sidebar persists its open state by writing a `sidebar_state` cookie
// (document.cookie) on every toggle, and nothing of the Company OS may write
// browser storage, cookies included (§13 item 6, SI-59; the module's lint
// refuses document.cookie). A list of NavLinks needs no state at all.

const CRM_HOME_HREF = "#/";

const Navigation = () => (
  <nav
    aria-label="Company OS"
    className="flex flex-col gap-4 border-b bg-muted/30 p-3 md:w-60 md:shrink-0 md:border-r md:border-b-0"
  >
    <div className="flex items-center gap-2 px-2 pt-1">
      <span className="rounded-lg bg-primary p-1.5 text-primary-foreground">
        <Building2 aria-hidden className="size-4" />
      </span>
      <span className="text-sm font-semibold">Company OS</span>
    </div>
    {SCREEN_GROUPS.map((group) => (
      <div key={group} className="flex flex-col gap-1">
        <p className="px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {group}
        </p>
        <ul className="flex flex-wrap gap-1 md:flex-col">
          {SCREENS.filter((screen) => screen.group === group).map((screen) => (
            <li key={screen.id}>
              <NavLink
                to={screenPath(screen)}
                end={screen.path === ""}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-foreground/80 hover:bg-accent",
                  )
                }
              >
                <screen.icon aria-hidden className="size-4 shrink-0" />
                {screen.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </div>
    ))}
    <a
      href={CRM_HOME_HREF}
      className="mt-auto flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-accent"
    >
      <ArrowLeft aria-hidden className="size-4" />
      Voltar ao CRM
    </a>
  </nav>
);

const ContextBar = ({
  context,
  onSignOut,
}: {
  context: OperatorContext;
  onSignOut: () => void;
}) => (
  <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
    <div
      role="group"
      aria-label="Contexto"
      className="flex flex-wrap items-center gap-3"
    >
      <span className="text-base font-semibold">
        {tenantDisplayName(context.tenant.name)}
      </span>
      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300">
        Ambiente de teste
      </span>
      <span
        className="text-xs text-muted-foreground"
        title="Seu papel nesta empresa"
      >
        {context.role === "tenant_operator" ? "Operador" : context.role}
      </span>
    </div>
    <Button variant="ghost" size="sm" onClick={onSignOut}>
      <LogOut aria-hidden className="size-4" />
      Sair
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
      <ContextBar context={context} onSignOut={onSignOut} />
      <main className="flex-1 bg-muted/10 p-4 md:p-8">
        <EventsInViewProvider>
          <Outlet />
        </EventsInViewProvider>
      </main>
    </div>
  </div>
);
