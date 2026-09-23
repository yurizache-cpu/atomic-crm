import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

// What the Company OS shows instead of its screens (docs/PHASE_2C_BRIEF.md
// §6.2). Every link out of the module crosses the #/company-os prefix, so it is
// a plain anchor to a constant hash, never a router Link and never an href
// built from data.

const CRM_HOME_HREF = "#/";
// Signing in goes through the CRM's root, never straight to #/login: without a
// session the CRM's own auth check fails there and runs the CRM's logout, which
// drops whatever identity the CRM still caches, before it shows its login page.
// #/login skips that check, so a cached identity would outlive the session.
const CRM_SIGN_IN_HREF = CRM_HOME_HREF;

const linkClass = "text-sm font-medium underline underline-offset-4";

export const BackToCrmLink = () => (
  <a className={linkClass} href={CRM_HOME_HREF}>
    Back to the CRM
  </a>
);

const StateCard = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <main className="mx-auto flex w-full max-w-xl flex-col gap-3 p-6">
    <h1 className="text-lg font-semibold">{title}</h1>
    {children}
  </main>
);

export const LoadingState = () => (
  <main className="p-6">
    <p className="text-sm text-muted-foreground">Loading Company OS…</p>
  </main>
);

export const SignedOutState = ({
  signOutFailed,
}: {
  signOutFailed: boolean;
}) => (
  <StateCard title="Signed out">
    <p className="text-sm">Sign in through the CRM to use the Company OS.</p>
    {signOutFailed ? (
      <p className="text-sm">
        Sign-out did not reach the server: the session may still be active in
        the CRM.
      </p>
    ) : null}
    <a className={linkClass} href={CRM_SIGN_IN_HREF}>
      Sign in through the CRM
    </a>
  </StateCard>
);

export const NoAccessState = ({
  reason,
}: {
  reason: "membership" | "read-refused";
}) => (
  <StateCard title="No Company OS access">
    {reason === "membership" ? (
      <p className="text-sm">
        This account holds no active Company OS membership. Memberships are
        granted and revoked only through the operator CLI.
      </p>
    ) : (
      <p className="text-sm">
        A Company OS read was refused again right after access was checked, so
        nothing is shown. Return to the CRM and open the Company OS again to
        retry.
      </p>
    )}
    <BackToCrmLink />
  </StateCard>
);

export const UnavailableState = ({ onRetry }: { onRetry: () => void }) => (
  <StateCard title="Company OS unavailable">
    <p className="text-sm">The operator context could not be read.</p>
    <div className="flex items-center gap-4">
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
      <BackToCrmLink />
    </div>
  </StateCard>
);
