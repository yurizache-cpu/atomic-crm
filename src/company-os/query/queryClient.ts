import { QueryCache, QueryClient } from "@tanstack/react-query";

import { CompanyOsApiError } from "../../../contracts/company-os-api/index.ts";

// The Company OS server state (docs/PHASE_2C_BRIEF.md §6.2, §13 item 6).
//
// One QueryClient per Company OS mount, in memory only: there is no persister
// here and none can be imported (eslint.config.js), so nothing it holds reaches
// browser storage. The access controller clears it on sign-out, on a change of
// user or tenant, on every refusal that resets access, and on unmount.

/** Overview and Agents poll at most this often, and only while visible. */
export const POLL_INTERVAL_MS = 15_000;

/** How long a read counts as fresh before a focus or a remount reads it again. */
export const STALE_TIME_MS = 10_000;

/** One retry, for OS500 alone: a lost connection or an overloaded server. */
const MAX_RETRIES = 1;

/**
 * Never retry a refusal (OS4xx: signed out, no access, not found, conflict,
 * bad request) or a response that broke its contract: asking again changes
 * nothing, and an OS401 or OS403 must reach the access controller at once.
 */
export const shouldRetry = (failureCount: number, error: unknown): boolean =>
  error instanceof CompanyOsApiError &&
  error.code === "OS500" &&
  failureCount < MAX_RETRIES;

export interface QueryEvents {
  onError(error: unknown, queryKey: readonly unknown[]): void;
  onSuccess(queryKey: readonly unknown[]): void;
}

export const createCompanyOsQueryClient = (events: QueryEvents): QueryClient =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => events.onError(error, query.queryKey),
      onSuccess: (_data, query) => events.onSuccess(query.queryKey),
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: STALE_TIME_MS,
        // A tab that becomes visible again reads what went stale meanwhile;
        // an interval never fires while the document is hidden.
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        refetchOnReconnect: true,
      },
      // No act exists in this phase; a mutation would be a review event.
      mutations: { retry: false },
    },
  });
