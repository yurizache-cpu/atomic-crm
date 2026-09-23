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
    Voltar ao CRM
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
    <p className="text-sm text-muted-foreground">Carregando o Company OS…</p>
  </main>
);

export const SignedOutState = ({
  signOutFailed,
}: {
  signOutFailed: boolean;
}) => (
  <StateCard title="Você saiu">
    <p className="text-sm">Entre pelo CRM para usar o Company OS.</p>
    {signOutFailed ? (
      <p className="text-sm">
        A saída não chegou ao servidor: a sessão ainda pode estar ativa no CRM.
      </p>
    ) : null}
    <a className={linkClass} href={CRM_SIGN_IN_HREF}>
      Entrar pelo CRM
    </a>
  </StateCard>
);

export const NoAccessState = ({
  reason,
}: {
  reason: "membership" | "read-refused";
}) => (
  <StateCard title="Sem acesso ao Company OS">
    {reason === "membership" ? (
      <p className="text-sm">
        Esta conta não tem um acesso ativo ao Company OS. Os acessos são
        concedidos e revogados apenas pelo operador.
      </p>
    ) : (
      <p className="text-sm">
        Uma leitura foi recusada de novo logo depois da verificação de acesso,
        por isso nada é mostrado. Volte ao CRM e abra o Company OS de novo.
      </p>
    )}
    <BackToCrmLink />
  </StateCard>
);

export const UnavailableState = ({ onRetry }: { onRetry: () => void }) => (
  <StateCard title="Company OS indisponível">
    <p className="text-sm">
      Não foi possível carregar o contexto da sua empresa.
    </p>
    <div className="flex items-center gap-4">
      <Button variant="outline" size="sm" onClick={onRetry}>
        Tentar de novo
      </Button>
      <BackToCrmLink />
    </div>
  </StateCard>
);
