import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  CompanyOsApiError,
  CompanyOsInputError,
  type ActInput,
  type FollowUpOutcome,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { QUERY_ROOT } from "./keys";

// The four commercial acts (Phase 3B.2, owner decision R): move an opportunity
// to another configured stage, set or clear its next action, convert it, or
// mark it lost. Each names the deal, the revision the screen showed and its
// own input; the server locks the deal, refuses a stale revision and never
// sends anything.
//
// Called once per explicit human confirmation and NEVER retried
// (`retry: false`, on top of the client's default). Success is reported only
// from the server's answer, after its transaction committed, and the funnel
// is read again; nothing moves on the screen before that. A refusal is
// definitive (nothing was written) and the funnel is read again. Any other
// failure (a dropped connection, a lost answer, a broken contract) leaves the
// outcome unknown: the funnel is read again and the owner is told to check it
// before trying again, never that the act failed or succeeded.

export type CommercialAct =
  | "move_opportunity"
  | "set_opportunity_next_action"
  | "convert_opportunity"
  | "lose_opportunity";

export type CommercialRequest =
  | {
      readonly act: "move_opportunity";
      readonly input: ActInput<"move_opportunity">;
    }
  | {
      readonly act: "set_opportunity_next_action";
      readonly input: ActInput<"set_opportunity_next_action">;
    }
  | {
      readonly act: "convert_opportunity";
      readonly input: ActInput<"convert_opportunity">;
    }
  | {
      readonly act: "lose_opportunity";
      readonly input: ActInput<"lose_opportunity">;
    };

/** What the owner is told once the act settles. */
export type CommercialOutcome =
  | {
      readonly kind: "done";
      readonly request: CommercialRequest;
      /** false: the result already held, and nothing changed. */
      readonly changed: boolean;
      readonly followUp: FollowUpOutcome | null;
    }
  | { readonly kind: "stale" }
  | { readonly kind: "busy" }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "not_found" }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

/** Every read whose answer a commercial act changes. */
const AFFECTED_READS: ReadonlySet<string> = new Set([
  "overview",
  "list_events",
]);

const codeOf = (error: unknown): string | null =>
  error instanceof CompanyOsApiError ? error.code : null;

export const useCommercialAct = () => {
  const { api } = useRuntime();
  const scope = useOperatorScope();
  const queryClient = useQueryClient();
  const options = { expectedUserId: scope.userId };

  const refresh = () =>
    queryClient.invalidateQueries(
      {
        predicate: (query) =>
          query.queryKey[0] === QUERY_ROOT &&
          AFFECTED_READS.has(String(query.queryKey[5])),
      },
      { throwOnError: false },
    );

  /** One call, typed by its act; the answer's outcome and follow-up. */
  const call = async (
    request: CommercialRequest,
  ): Promise<{ outcome: string; followUp: FollowUpOutcome | null }> => {
    switch (request.act) {
      case "move_opportunity": {
        const result = await api.act(request.act, request.input, options);
        return { outcome: result.outcome, followUp: null };
      }
      case "set_opportunity_next_action": {
        const result = await api.act(request.act, request.input, options);
        return { outcome: result.outcome, followUp: result.followUp };
      }
      case "convert_opportunity": {
        const result = await api.act(request.act, request.input, options);
        return { outcome: result.outcome, followUp: result.followUp };
      }
      case "lose_opportunity": {
        const result = await api.act(request.act, request.input, options);
        return { outcome: result.outcome, followUp: result.followUp };
      }
    }
  };

  return useMutation({
    retry: false,
    mutationFn: async (
      request: CommercialRequest,
    ): Promise<CommercialOutcome> => {
      try {
        const { outcome, followUp } = await call(request);
        await refresh();
        return {
          kind: "done",
          request,
          changed: outcome !== "unchanged",
          followUp,
        };
      } catch (error) {
        // The browser refused its own input: no request left.
        if (error instanceof CompanyOsInputError) return { kind: "refused" };
        const code = codeOf(error);
        await refresh();
        switch (code) {
          case "OS409":
            return { kind: "stale" };
          case "OS429":
            return { kind: "busy" };
          case "OS401":
          case "OS403":
            return { kind: "not_allowed" };
          case "OS404":
            return { kind: "not_found" };
          case "OS400":
            return { kind: "refused" };
          default:
            return { kind: "unknown" };
        }
      }
    },
  });
};
