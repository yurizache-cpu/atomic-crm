import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  CompanyOsApiError,
  CompanyOsInputError,
  type ReleaseOutcomeCode,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { QUERY_ROOT } from "./keys";

// The browser inbox's release (ADR 0026 §E, SI-87): the conversation a person
// holds goes back to the agent, at the revision the screen showed, never while
// the contact's opt-out is open. It sends nothing.
//
// Called once per explicit human confirmation and NEVER retried
// (`retry: false`): the server answers every refusal as an outcome with
// nothing written, and the affected reads are read again after every answer
// and every error. OS429 says the conversation was busy; OS401, OS403 and
// OS409 come only from the identity gate (access is checked again); any other
// failure leaves the outcome unknown, and the member is told to check the
// conversation before trying again.

/** What the member is told once the release settles. */
export type ReleaseResultKind =
  | ReleaseOutcomeCode
  | "busy"
  | "not_allowed"
  | "not_found"
  | "refused"
  | "unknown";

export interface ReleaseRequest {
  /** Any task of the conversation's own inbound messages (its route reference). */
  readonly taskRef: string;
  /** The revision the open conversation showed. */
  readonly revision: number;
}

/** Every read whose answer a release changes. */
const AFFECTED_READS: ReadonlySet<string> = new Set([
  "get_conversation",
  "overview",
  "list_events",
  "get_task",
]);

const codeOf = (error: unknown): string | null =>
  error instanceof CompanyOsApiError ? error.code : null;

const KIND_OF_CODE: Readonly<Record<string, ReleaseResultKind>> = {
  OS429: "busy",
  OS401: "not_allowed",
  OS403: "not_allowed",
  OS409: "not_allowed",
  OS404: "not_found",
  OS400: "refused",
};

export const useReleaseConversation = () => {
  const { api } = useRuntime();
  const scope = useOperatorScope();
  const queryClient = useQueryClient();

  const refresh = () =>
    queryClient.invalidateQueries(
      {
        predicate: (query) =>
          query.queryKey[0] === QUERY_ROOT &&
          AFFECTED_READS.has(String(query.queryKey[5])),
      },
      { throwOnError: false },
    );

  return useMutation({
    retry: false,
    mutationFn: async (request: ReleaseRequest): Promise<ReleaseResultKind> => {
      try {
        const result = await api.act(
          "release_conversation",
          {
            p_task_id: request.taskRef,
            p_expected_revision: request.revision,
          },
          { expectedUserId: scope.userId },
        );
        await refresh();
        return result.outcome;
      } catch (error) {
        // The browser refused its own input: no request left.
        if (error instanceof CompanyOsInputError) return "refused";
        await refresh();
        return KIND_OF_CODE[codeOf(error) ?? ""] ?? "unknown";
      }
    },
  });
};
