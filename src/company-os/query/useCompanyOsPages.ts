import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";

import type {
  OperationInput,
  OperationResult,
} from "../../../contracts/company-os-api/index.ts";
import { useOperatorScope, useRuntime } from "../session/runtime";
import { pagesKey } from "./keys";
import { POLL_INTERVAL_MS } from "./queryClient";

// A cursor-paged company_os_api read (docs/PHASE_2C_BRIEF.md §11). The cursor
// is opaque: the first page is read with a null cursor, and every next page
// with exactly the `nextCursor` the previous page returned, never one the
// browser built. A refetch (focus, "Try again") starts again from the first
// page; there is no "newer than" cursor.

export type PagedOperation =
  | "list_tasks"
  | "list_runs"
  | "list_reviews"
  | "list_events"
  | "list_stops";

/** A paged read's arguments; the cursor belongs to the hook. */
export type PageInput<O extends PagedOperation> = Omit<
  OperationInput<O>,
  "p_cursor"
>;

export type PagesResult<O extends PagedOperation> = UseInfiniteQueryResult<
  InfiniteData<OperationResult<O>, string | null>
>;

const nextCursorOf = (page: unknown): string | null =>
  (page as { nextCursor: string | null }).nextCursor;

/** One item of a paged read's answer. */
export type PageItem<O extends PagedOperation> =
  OperationResult<O>["items"][number];

interface Page<O extends PagedOperation> {
  readonly items: readonly PageItem<O>[];
}

export interface PagesOptions<O extends PagedOperation> {
  /**
   * Re-read every loaded page every POLL_INTERVAL_MS while visible, as long
   * as the items read so far say the state can still change.
   */
  readonly poll?: (items: readonly PageItem<O>[]) => boolean;
}

export const useCompanyOsPages = <O extends PagedOperation>(
  operation: O,
  input: PageInput<O>,
  options: PagesOptions<O> = {},
): PagesResult<O> => {
  const { api, generation } = useRuntime();
  const scope = useOperatorScope();
  const { poll } = options;
  return useInfiniteQuery({
    queryKey: pagesKey(scope, operation, input),
    queryFn: async ({ pageParam, signal }) => {
      const page = await api.call(
        operation,
        { ...input, p_cursor: pageParam } as OperationInput<O>,
        { expectedUserId: scope.userId, signal },
      );
      // Shown only under the generation the server still resolves.
      await generation.confirm(scope);
      return page;
    },
    initialPageParam: null as string | null,
    // null ends the list: TanStack reads null as "no next page".
    getNextPageParam: nextCursorOf,
    refetchInterval: (query) =>
      poll !== undefined &&
      query.state.data !== undefined &&
      poll(
        (query.state.data.pages as readonly Page<O>[]).flatMap(
          (page) => page.items,
        ),
      )
        ? POLL_INTERVAL_MS
        : false,
  });
};

/** Every item read so far, in the server's order. */
export const itemsOf = <T>(
  data: InfiniteData<{ readonly items: readonly T[] }, unknown> | undefined,
): readonly T[] => data?.pages.flatMap((page) => page.items) ?? [];
