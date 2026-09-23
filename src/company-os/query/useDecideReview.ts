import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  CompanyOsApiError,
  type ReviewDecision,
  type ReviewDetail,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { QUERY_ROOT, dataKey } from "./keys";

// The one browser act (S7.1): record a decision on an open review
// (docs/PHASE_2C_BRIEF.md §9 row 16). Accepting a review is not sending: the
// server writes the review and one event, and nothing else.
//
// Called once per explicit human confirmation. It is NEVER retried
// (`retry: false`, on top of the client's default): a repeated call is either
// harmless (the same decision by the same principal is answered as already
// recorded) or a conflict, but a person decides, not a loop. When the answer
// is lost (OS500: a dropped connection, an overloaded server, a broken
// contract), the outcome is unknown, so the review is read again and the
// owner is told what the server now holds, never that the decision failed.

/** What the owner is told once the act settles. */
export type DecisionOutcome =
  | { readonly kind: "recorded"; readonly status: ReviewDecision }
  | { readonly kind: "already_decided"; readonly status: string | null }
  | { readonly kind: "not_allowed" }
  | { readonly kind: "not_found" }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

/** Every read whose answer a decision changes. */
const AFFECTED_READS: ReadonlySet<string> = new Set([
  "get_review",
  "list_reviews",
  "overview",
  "list_events",
  "get_task",
  "list_tasks",
]);

const codeOf = (error: unknown): string | null =>
  error instanceof CompanyOsApiError ? error.code : null;

export const useDecideReview = (reviewId: string) => {
  const { api } = useRuntime();
  const scope = useOperatorScope();
  const queryClient = useQueryClient();
  const reviewKey = dataKey(scope, "get_review", { p_review_id: reviewId });

  /** Re-reads every affected read; resolves to the review as the server now holds it, or null. */
  const reread = async (): Promise<ReviewDetail | null> => {
    const since = Date.now();
    await queryClient.invalidateQueries(
      {
        predicate: (query) =>
          query.queryKey[0] === QUERY_ROOT &&
          AFFECTED_READS.has(String(query.queryKey[5])),
      },
      { throwOnError: false },
    );
    const state = queryClient.getQueryState<ReviewDetail>(reviewKey);
    return state?.status === "success" && state.dataUpdatedAt >= since
      ? (state.data ?? null)
      : null;
  };

  return useMutation({
    retry: false,
    mutationFn: async (decision: ReviewDecision): Promise<DecisionOutcome> => {
      try {
        const result = await api.act(
          "decide_review",
          { p_review_id: reviewId, p_decision: decision },
          { expectedUserId: scope.userId },
        );
        await reread();
        return { kind: "recorded", status: result.status };
      } catch (error) {
        const code = codeOf(error);
        // A refusal is definitive: the server's transaction did not commit.
        if (code === "OS409") {
          const review = await reread();
          return { kind: "already_decided", status: review?.status ?? null };
        }
        if (code === "OS401" || code === "OS403") {
          await reread();
          return { kind: "not_allowed" };
        }
        if (code === "OS404") return { kind: "not_found" };
        if (code === "OS400") return { kind: "refused" };
        // Anything else leaves the outcome unknown: ask the server.
        const review = await reread();
        if (review === null || review.status === "pending") {
          return { kind: "unknown" };
        }
        return review.status === decision
          ? { kind: "recorded", status: decision }
          : { kind: "already_decided", status: review.status };
      }
    },
  });
};
