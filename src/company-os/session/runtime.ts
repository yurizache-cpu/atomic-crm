import { createContext, useContext, useSyncExternalStore } from "react";

import type { OperatorContext } from "../../../contracts/company-os-api/index.ts";
import type { CompanyOsApi } from "../ports";
import type { DataScope } from "../query/keys";
import type { AccessController, AccessState } from "./accessController";
import type { GenerationConfirmer } from "./generation";

// What every Company OS component reads through React context: the API, the
// access controller and, once operator_context has answered, the operator
// scope. They sit above the module's router, so every route element sees them.

export interface CompanyOsRuntime {
  readonly api: CompanyOsApi;
  readonly controller: AccessController;
  /** Binds a data answer to the operator_context generation (session/generation.ts). */
  readonly generation: GenerationConfirmer;
  /** Milliseconds since the epoch; how old a read is, for the "unknown" rule. */
  readonly now: () => number;
}

export const RuntimeContext = createContext<CompanyOsRuntime | null>(null);

export const useRuntime = (): CompanyOsRuntime => {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error("A Company OS component rendered outside <CompanyOsApp>.");
  }
  return runtime;
};

export const useAccess = (): AccessState => {
  const { controller } = useRuntime();
  return useSyncExternalStore(controller.subscribe, controller.getState);
};

/** The caller as operator_context described them, and the key scope of their data. */
export interface OperatorScope extends DataScope {
  readonly context: OperatorContext;
}

export const OperatorScopeContext = createContext<OperatorScope | null>(null);

/** Only screens rendered behind a successful operator_context have one. */
export const useOperatorScope = (): OperatorScope => {
  const scope = useContext(OperatorScopeContext);
  if (scope === null) {
    throw new Error(
      "Company OS data was read before operator_context answered.",
    );
  }
  return scope;
};
