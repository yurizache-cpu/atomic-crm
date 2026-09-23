import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { ReviewAdvice } from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { dataKey } from "./keys";

/**
 * The one content read (docs/PHASE_2C_BRIEF.md §13 item 3): a review's
 * structured advice, on explicit open only. Mount it when the operator opens
 * the advice view and unmount it when they close it: the answer is kept for no
 * time at all (gcTime 0), never re-read behind their back, and removed from the
 * cache the moment the view closes.
 */
export const useReviewAdvice = (
  reviewId: string,
): UseQueryResult<ReviewAdvice> => {
  const { api, generation } = useRuntime();
  const queryClient = useQueryClient();
  const scope = useOperatorScope();
  const { userId, epoch, tenantId, principalId } = scope;
  const queryKey = useMemo(
    () =>
      dataKey({ userId, epoch, tenantId, principalId }, "get_review_advice", {
        p_review_id: reviewId,
      }),
    [userId, epoch, tenantId, principalId, reviewId],
  );

  useEffect(
    () => () => queryClient.removeQueries({ queryKey, exact: true }),
    [queryClient, queryKey],
  );

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const advice = await api.call(
        "get_review_advice",
        { p_review_id: reviewId },
        { expectedUserId: userId, signal },
      );
      // Shown only under the generation the server still resolves.
      await generation.confirm({ userId, epoch, tenantId, principalId });
      return advice;
    },
    gcTime: 0,
    staleTime: 0,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
};
