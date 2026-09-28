import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import type { SessionPort } from "./company-os/ports";
import { SecondFactorFlow } from "./company-os/shell/SecondFactorFlow";
import type { CrmAccess } from "./crmAccess";

// The application shell's second-factor gate for the CRM (Production Security
// Gate A.1). A session that has not passed its authenticator app is refused by
// every CRM row-security policy; this shows the same second-factor screen the
// Company OS uses instead of a CRM full of empty lists. It is convenience: the
// database decides, and after a verified code the CRM is shown only because
// the server now answers the session. No session, a session the server
// accepts, an error, and the two email-link pages all show the CRM untouched.

type View = "checking" | "crm" | "second-factor";

const SignOut = ({ session }: { session: SessionPort }) => {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setFailed(false);
            session.signOut().catch(() => setFailed(true));
          }}
        >
          Sair
        </Button>
      </div>
      {failed ? (
        <p className="text-sm" role="alert">
          Não foi possível encerrar a sessão. Tente de novo.
        </p>
      ) : null}
    </div>
  );
};

export const CrmSecondFactorGate = ({
  session,
  probe,
  children,
}: {
  readonly session: SessionPort;
  readonly probe: () => Promise<CrmAccess>;
  readonly children: ReactNode;
}) => {
  const [view, setView] = useState<View>("checking");
  const signedInUser = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const decide = async () => {
      try {
        const [user, access] = await Promise.all([
          session.currentUser(),
          probe(),
        ]);
        if (!active) return;
        signedInUser.current = user?.userId ?? null;
        setView(access === "second-factor" ? "second-factor" : "crm");
      } catch {
        if (active) setView("crm");
      }
    };
    void decide();

    const stop = session.onAuthStateChange((event, user) => {
      if (!active) return;
      if (event === "SIGNED_OUT") {
        signedInUser.current = null;
        setView("crm");
        return;
      }
      if (
        event === "SIGNED_IN" ||
        event === "USER_UPDATED" ||
        event === "MFA_CHALLENGE_VERIFIED"
      ) {
        // A new person signing in must not run the CRM before the question is
        // answered; the provider repeats SIGNED_IN for the same person (a tab
        // regaining focus), and that must not unmount their screen.
        if (
          event === "SIGNED_IN" &&
          user !== null &&
          user.userId !== signedInUser.current
        ) {
          setView("checking");
        }
        void decide();
      }
    });
    // Following a link out of the email pages (set a password, then "/").
    const onHashChange = () => void decide();
    window.addEventListener("hashchange", onHashChange);
    return () => {
      active = false;
      stop();
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [session, probe]);

  if (view === "checking") return null;
  if (view === "second-factor" && session.mfa !== undefined) {
    return (
      <SecondFactorFlow
        mfa={session.mfa}
        subject="O CRM"
        footer={<SignOut session={session} />}
        fallback={children}
      />
    );
  }
  return <>{children}</>;
};
