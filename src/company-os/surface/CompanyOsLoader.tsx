import { Suspense, type ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import { BackToCrmLink, LoadingState } from "../shell/AccessStates";
import { DataBanner } from "../shell/DataBanner";

// The lazily loaded Company OS as src/App.tsx mounts it (docs/PHASE_2C_BRIEF.md
// §6.2). Its code arrives as a separate chunk, so loading it can fail, and an
// error thrown before its own router exists has nothing inside the module to
// catch it. Uncaught, either would unmount the whole application root, the
// CRM included, until a reload. This boundary keeps such a failure on the
// Company OS surface: it shows fixed text, never the error, and the switch
// mounts the CRM again as soon as the hash leaves the prefix. The boundary is
// inside the Company OS surface, so leaving the surface discards it and a
// later visit starts afresh.

export const COMPANY_OS_LOAD_FAILED_TEXT =
  "The Company OS could not be loaded.";

export const CompanyOsUnavailable = () => (
  <div className="flex min-h-screen flex-col bg-background text-foreground">
    <DataBanner />
    <main className="mx-auto flex w-full max-w-xl flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">Company OS unavailable</h1>
      <p className="text-sm">{COMPANY_OS_LOAD_FAILED_TEXT}</p>
      <BackToCrmLink />
    </main>
  </div>
);

export const CompanyOsLoader = ({ children }: { children: ReactNode }) => (
  <ErrorBoundary fallback={<CompanyOsUnavailable />}>
    <Suspense fallback={<LoadingState />}>{children}</Suspense>
  </ErrorBoundary>
);
