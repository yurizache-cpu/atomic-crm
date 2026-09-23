import type { OperatorContext } from "../../../contracts/company-os-api/index.ts";
import type { CompanyOsApi } from "../ports";
import type { DataScope } from "../query/keys";

// Binds every data answer to the operator_context generation it is shown under
// (docs/PHASE_2C_BRIEF.md §6.2 "Server state", §7.4).
//
// A data answer names no tenant: the server derives the tenant from the
// caller's membership at the moment it answers. So when a membership moves to
// another tenant, every read answered after the move returns that tenant's
// data, and the screens would show it under the tenant name the last
// operator_context reported until the next one is read (at most 15 s later).
//
// Every data read therefore ends with a confirmation: an operator_context read
// SENT AFTER the answer arrived. It names the tenant and the principal the
// server resolves now; if either differs from the generation the answer is to
// be shown under, the answer is discarded (CompanyOsGenerationError) and the
// access controller learns the new generation, which clears the cache and
// reads everything again for it. Confirmations requested within one task share
// one read, sent on the next task, so each still starts after every answer it
// confirms arrived.
//
// The one residue: a membership that moves away and back between an answer
// and its confirmation, within one round trip.

/** A data answer read under a tenant or principal the server no longer names. */
export class CompanyOsGenerationError extends Error {
  constructor() {
    super("company_os_api: the operator context changed under this read");
    this.name = "CompanyOsGenerationError";
  }
}

export interface GenerationConfirmer {
  /** Resolves when a later operator_context names the same tenant and principal as `scope`. */
  confirm(scope: DataScope): Promise<void>;
}

/** The generation the server resolves now differs from the one a read belonged to. */
export type GenerationChange = (
  scope: DataScope,
  context: OperatorContext,
) => void;

const nextTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

interface Batch {
  readonly userId: string;
  readonly context: Promise<OperatorContext>;
}

export const createGenerationConfirmer = (
  api: CompanyOsApi,
  onChange: GenerationChange,
): GenerationConfirmer => {
  // The batch still open for joining: it has not been sent yet.
  let open: Batch | null = null;

  const contextSentAfterNow = (userId: string): Promise<OperatorContext> => {
    if (open !== null && open.userId === userId) return open.context;
    const batch: Batch = {
      userId,
      context: nextTask().then(() => {
        // Sent now: an answer that arrives from here on needs a later read.
        if (open === batch) open = null;
        return api.call("operator_context", {}, { expectedUserId: userId });
      }),
    };
    open = batch;
    return batch.context;
  };

  return {
    confirm: async (scope) => {
      const context = await contextSentAfterNow(scope.userId);
      if (
        context.tenant.id !== scope.tenantId ||
        context.principal.id !== scope.principalId
      ) {
        onChange(scope, context);
        throw new CompanyOsGenerationError();
      }
    },
  };
};
