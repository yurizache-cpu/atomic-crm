import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { MfaPort, MfaStatus, TotpEnrollment } from "../ports";

// The second factor a live session still needs, completed with the provider's
// own authenticator-app factor (Production Security Gate A and A.1): enrolment
// (the provider's QR code and key) the first time, then a code. The provider
// verifies the code; nothing here computes one, and nothing here can grant
// access: after a verified code the server is asked again, and it alone decides.
//
// One screen for both surfaces that need it. The Company OS server refuses a
// session below level 2 as "not signed in" (ops.operator_scope), and the CRM's
// row-security policies answer such a session nothing; either way this is the
// same flow, and only what wraps it differs (`subject`, `footer`, `fallback`).
// It is a leaf: it imports no session, router or CRM module.

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
      // which the surface follows by asking the server again.
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

const SecondFactorStep = ({
  mfa,
  step,
  subject,
  footer,
}: {
  mfa: MfaPort;
  step: Step;
  subject: string;
  footer: ReactNode;
}) => {
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
        {subject} exige um segundo fator: um código do seu aplicativo
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
      {footer}
    </main>
  );
};

/**
 * The second factor the session still needs, or `fallback` when the provider
 * says none is needed (or there is no session, or it cannot say).
 */
export const SecondFactorFlow = ({
  mfa,
  subject,
  footer,
  fallback,
}: {
  readonly mfa: MfaPort;
  /** Who requires it, as the sentence's subject, e.g. "O Company OS". */
  readonly subject: string;
  /** The way out of the screen: a link back, or a sign-out. */
  readonly footer: ReactNode;
  readonly fallback: ReactNode;
}) => {
  const [step, setStep] = useState<Step>({ kind: "checking" });

  useEffect(() => {
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
  }, [mfa]);

  if (step.kind === "checking") return null;
  if (step.kind === "signed-out") return <>{fallback}</>;
  return (
    <SecondFactorStep mfa={mfa} step={step} subject={subject} footer={footer} />
  );
};
