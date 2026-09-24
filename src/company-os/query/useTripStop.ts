import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  CompanyOsApiError,
  type ExecutionStopList,
  type ExecutionStopSummary,
  type TripStopScope,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { QUERY_ROOT } from "./keys";

// The second browser act (S7.2): trip an execution stop at tenant, company,
// department or agent scope (docs/PHASE_2C_BRIEF.md §9 row 17). The browser
// names the scope and the target only; the server derives the tenant, the
// actor and a fixed reason. Nothing here, or anywhere in the module, clears a
// stop: that stays an operator CLI act.
//
// Called once per explicit human confirmation and NEVER retried
// (`retry: false`, on top of the client's default): a person decides whether
// to try again. OS429 is the server saying the kill-switch lock was busy and
// nothing was recorded, so the person may try again. When the answer is lost
// (OS500: a dropped connection, an overloaded server, a broken contract), the
// outcome is unknown, so the active stops are read again: an active stop at
// exactly this target is a success; a complete read without one says the trip
// could not be confirmed and may be tried again; a read that fails leaves the
// outcome unknown, and the owner is told so.

/** One target a member may stop: the tenant, or one organisational unit. */
export interface TripTarget {
  readonly scope: TripStopScope;
  /** null for the tenant. */
  readonly id: string | null;
}

/** What the owner is told once the act settles. */
export type TripOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "already_stopped" }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "not_found" }
  | { readonly kind: "busy" }
  | { readonly kind: "refused" }
  | { readonly kind: "not_confirmed" }
  | { readonly kind: "unknown" };

/** Every read whose answer a trip changes. */
const AFFECTED_READS: ReadonlySet<string> = new Set([
  "list_stops",
  "list_agents",
  "get_agent",
  "overview",
  "list_runs",
  "get_run",
]);

/** How many pages of active stops the re-read follows before giving up. */
const REREAD_PAGES = 10;

/** Whether `stop` is an active stop at exactly `target`. */
export const stopsExactly = (
  stop: ExecutionStopSummary,
  target: TripTarget,
): boolean => {
  if (stop.clearedAt !== null || stop.scope !== target.scope) return false;
  switch (target.scope) {
    case "tenant":
      return stop.target === null;
    case "company":
      return (
        stop.target?.companyId === target.id &&
        stop.target.departmentId === null &&
        stop.target.agentId === null
      );
    case "department":
      return stop.target?.departmentId === target.id;
    case "agent":
      return stop.target?.agentId === target.id;
  }
};

const codeOf = (error: unknown): string | null =>
  error instanceof CompanyOsApiError ? error.code : null;

export const useTripStop = () => {
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

  /**
   * Reads the active stops again, from the server: whether one stops exactly
   * `target`, or null when that cannot be told.
   */
  const isStopped = async (target: TripTarget): Promise<boolean | null> => {
    try {
      let cursor: string | null = null;
      for (let page = 0; page < REREAD_PAGES; page++) {
        const answer: ExecutionStopList = await api.call(
          "list_stops",
          { p_include_cleared: false, p_cursor: cursor },
          { expectedUserId: scope.userId },
        );
        if (answer.items.some((stop) => stopsExactly(stop, target))) {
          return true;
        }
        if (answer.nextCursor === null) return false;
        cursor = answer.nextCursor;
      }
      return null;
    } catch {
      return null;
    }
  };

  return useMutation({
    retry: false,
    mutationFn: async (target: TripTarget): Promise<TripOutcome> => {
      try {
        const result = await api.act(
          "trip_stop",
          target.scope === "tenant"
            ? { p_scope: "tenant" }
            : { p_scope: target.scope, p_target_id: target.id },
          { expectedUserId: scope.userId },
        );
        await refresh();
        return { kind: result.outcome };
      } catch (error) {
        const code = codeOf(error);
        // A refusal is definitive: the server's transaction did not commit.
        if (code === "OS429") return { kind: "busy" };
        if (code === "OS401" || code === "OS403") {
          await refresh();
          return { kind: "not_allowed" };
        }
        if (code === "OS404") return { kind: "not_found" };
        if (code === "OS400") return { kind: "refused" };
        // Anything else leaves the outcome unknown: ask the server.
        const stopped = await isStopped(target);
        await refresh();
        if (stopped === null) return { kind: "unknown" };
        return stopped ? { kind: "stopped" } : { kind: "not_confirmed" };
      }
    },
  });
};
