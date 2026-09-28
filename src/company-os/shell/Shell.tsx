import { useAccess } from "../session/runtime";
import { LoadingState, NoAccessState } from "./AccessStates";
import { ContextGate } from "./ContextGate";
import { DataBanner } from "./DataBanner";
import { SignedOutOrSecondFactor } from "./SecondFactor";

/**
 * The root of every Company OS route: the persistent data-class banner, then
 * whatever the caller's access allows. A deep link renders the same state as
 * the module's index.
 */
export const Shell = () => {
  const access = useAccess();
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <DataBanner />
      {access.status === "checking" ? <LoadingState /> : null}
      {access.status === "signed-out" ? (
        <SignedOutOrSecondFactor signOutFailed={access.signOutFailed} />
      ) : null}
      {access.status === "no-access" ? (
        <NoAccessState reason={access.reason} />
      ) : null}
      {access.status === "signed-in" ? <ContextGate access={access} /> : null}
    </div>
  );
};
