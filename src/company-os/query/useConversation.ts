import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { Conversation } from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { dataKey } from "./keys";
import { POLL_INTERVAL_MS } from "./queryClient";

/**
 * The browser inbox's one conversation (ADR 0026 §E, SI-87), read on explicit
 * open only: mount it when the member opens the conversation, unmount it when
 * they leave. The answer is kept for no time at all (gcTime 0) and removed
 * from the cache the moment the view closes. While it is open and the tab is
 * visible it is read again every POLL_INTERVAL_MS, so a reply on its way
 * turns "sent" and the contact's next message appears without a click, and a
 * tab that becomes visible again reads it at once; a reconnect alone does not.
 * Nothing prefetches it, and no list reads it.
 */
export const useConversation = (
  taskRef: string,
): UseQueryResult<Conversation> => {
  const { api, generation } = useRuntime();
  const queryClient = useQueryClient();
  const scope = useOperatorScope();
  const { userId, epoch, tenantId, principalId } = scope;
  const queryKey = useMemo(
    () =>
      dataKey({ userId, epoch, tenantId, principalId }, "get_conversation", {
        p_task_id: taskRef,
      }),
    [userId, epoch, tenantId, principalId, taskRef],
  );

  useEffect(
    () => () => queryClient.removeQueries({ queryKey, exact: true }),
    [queryClient, queryKey],
  );

  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const conversation = await api.call(
        "get_conversation",
        { p_task_id: taskRef },
        { expectedUserId: userId, signal },
      );
      // Shown only under the generation the server still resolves.
      await generation.confirm({ userId, epoch, tenantId, principalId });
      return conversation;
    },
    gcTime: 0,
    staleTime: 0,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
  });
};
