import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { MfaPort, MfaStatus, TotpEnrollment } from "../ports";
import { useRuntime } from "../session/runtime";
import { BackToCrmLink, SignedOutState } from "./AccessStates";

// Production Security Gate A: the Company OS server refuses a session below
// multi-factor assurance level 2 as "not signed in" (ops.operator_scope). When
// the auth provider still holds a session that lacks its second factor, this
// screen completes it with the provider's own authenticator-app factor:
// enrolment (the provider's QR code and key) the first time, then a code. The
// provider verifies the code; nothing here computes one, and nothing here can
// grant access: after a verified code the server is asked again, and it alone
// decides. Anything else is the plain signed-out state.

type Step =
  | { readonly kind: "checking" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "code"; readonly factorId: string }
  | { readonly kind: "enroll" }
  | { readonly kind: "enrolled"; readonly enrollment: TotpEnrollment };

const stepOf = (status: MfaStatus | null): Step => {
  if (status === null || !status.needsSecondFactor) {
    return { kind: "signed-out" };
  }
  return status.factorId === null
    ? { kind: "enroll" }
    : { kind: "code", factorId: status.factorId };
};

const CodeForm = ({ mfa, factorId }: { mfa: MfaPort; factorId: string }) => {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setRefused(false);
    try {
      // A verified code makes the provider announce the stronger session,
      // which the access controller follows by asking the server again.
      if (!(await mfa.verifyTotp(factorId, code.trim()))) setRefused(true);
    } catch {
      setRefused(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <Label htmlFor="company-os-totp-code">Código de 6 dígitos</Label>
      <Input
        id="company-os-totp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      {refused ? (
        <p className="text-sm" role="alert">
          O código não foi aceito. Confira o aplicativo e tente de novo.
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={busy || code.length !== 6}>
          Verificar
        </Button>
      </div>
    </form>
  );
};

const SecondFactorStep = ({ mfa, step }: { mfa: MfaPort; step: Step }) => {
  const [current, setCurrent] = useState(step);
  const [failed, setFailed] = useState(false);

  const enroll = async () => {
    setFailed(false);
    try {
      setCurrent({ kind: "enrolled", enrollment: await mfa.enrollTotp() });
    } catch {
      setFailed(true);
    }
  };

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">Verificação em duas etapas</h1>
      <p className="text-sm">
        O Company OS exige um segundo fator: um código do seu aplicativo
        autenticador.
      </p>
      {current.kind === "enroll" ? (
        <div>
          <Button size="sm" onClick={() => void enroll()}>
            Configurar o aplicativo autenticador
          </Button>
        </div>
      ) : null}
      {current.kind === "enrolled" ? (
        <>
          <p className="text-sm">
            Leia o código QR no aplicativo autenticador, ou digite a chave.
          </p>
          <img
            src={current.enrollment.qrCode}
            alt="Código QR do aplicativo autenticador"
            className="h-48 w-48"
          />
          <p className="font-mono text-sm break-all">
            {current.enrollment.secret}
          </p>
          <CodeForm mfa={mfa} factorId={current.enrollment.factorId} />
        </>
      ) : null}
      {current.kind === "code" ? (
        <CodeForm mfa={mfa} factorId={current.factorId} />
      ) : null}
      {failed ? (
        <p className="text-sm" role="alert">
          Não foi possível iniciar a configuração. Tente de novo.
        </p>
      ) : null}
      <BackToCrmLink />
    </main>
  );
};

/** The signed-out state, or the second factor a live session still needs. */
export const SignedOutOrSecondFactor = ({
  signOutFailed,
}: {
  signOutFailed: boolean;
}) => {
  const { mfa } = useRuntime();
  const [step, setStep] = useState<Step>(
    mfa === undefined || signOutFailed
      ? { kind: "signed-out" }
      : { kind: "checking" },
  );

  useEffect(() => {
    if (mfa === undefined || signOutFailed) return;
    let active = true;
    mfa.status().then(
      (status) => {
        if (active) setStep(stepOf(status));
      },
      () => {
        if (active) setStep({ kind: "signed-out" });
      },
    );
    return () => {
      active = false;
    };
  }, [mfa, signOutFailed]);

  if (step.kind === "checking") return null;
  if (step.kind === "signed-out" || mfa === undefined) {
    return <SignedOutState signOutFailed={signOutFailed} />;
  }
  return <SecondFactorStep mfa={mfa} step={step} />;
};
