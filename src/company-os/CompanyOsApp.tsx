import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { RouterProvider } from "react-router/dom";

import { createCompanyOsApi } from "./api/companyOsApi";
import type { SessionPort } from "./ports";
import { createCompanyOsRouter } from "./router/createCompanyOsRouter";
import type { ScreenComponents } from "./screens/screens";
import { createAccessController } from "./session/accessController";
import { createGenerationConfirmer } from "./session/generation";
import { RuntimeContext, type CompanyOsRuntime } from "./session/runtime";
import { useOwnedRouter } from "./surface/useOwnedRouter";

// The Company OS operator surface (docs/PHASE_2C_BRIEF.md §6, §12), mounted by
// src/App.tsx under #/company-os, read-only in this phase: no screen offers a
// decision, a stop, a send, a draft or any configuration change.
//
// It owns, for the length of one mount, an in-memory query client (inside the
// access controller), its own hash router and the session subscription; all
// three end on unmount, the cache cleared first.

export interface CompanyOsAppProps {
  /** The session, read once per mount. */
  readonly session: SessionPort;
  /** Screen components by id; every one not given is the real screen. */
  readonly screens?: Partial<ScreenComponents>;
  /** The clock the "state unknown" rule reads; Date.now unless a test sets one. */
  readonly clock?: () => number;
}

const systemClock = () => Date.now();

const CompanyOsApp = ({ session, screens, clock }: CompanyOsAppProps) => {
  const [runtime] = useState<CompanyOsRuntime>(() => {
    const api = createCompanyOsApi(session);
    const controller = createAccessController(session);
    const generation = createGenerationConfirmer(api, (scope, context) =>
      // Deferred: this runs inside a query's fetch, and the reset it causes
      // clears the cache that query belongs to.
      queueMicrotask(() =>
        controller.bindTenant(
          scope.epoch,
          context.tenant.id,
          context.principal.id,
        ),
      ),
    );
    return { api, controller, generation, now: clock ?? systemClock };
  });
  const router = useOwnedRouter(() => createCompanyOsRouter(screens));

  useEffect(() => runtime.controller.start(), [runtime]);

  if (router === null) return null;
  return (
    <QueryClientProvider client={runtime.controller.queryClient}>
      <RuntimeContext.Provider value={runtime}>
        <RouterProvider router={router} />
      </RuntimeContext.Provider>
    </QueryClientProvider>
  );
};

export default CompanyOsApp;
