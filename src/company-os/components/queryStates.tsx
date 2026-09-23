import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseQueryResult,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { errorTextOf } from "./queryErrors";

// How a screen shows a read that is loading, failed or answered. A failed read
// shows its error and nothing else: not the refused value, and not an older
// answer the cache still holds, so a screen never mixes a stale value with a
// failure. "Try again" and "Load more" only read.

export const LoadingText = ({ what }: { what: string }) => (
  <p role="status" className="text-sm text-muted-foreground">
    {`Loading ${what}…`}
  </p>
);

export const ReadError = ({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) => (
  <div
    role="alert"
    className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 p-3 text-sm"
  >
    <span>{errorTextOf(error)}</span>
    <Button variant="outline" size="sm" onClick={onRetry}>
      Try again
    </Button>
  </div>
);

export const QueryView = <T,>({
  query,
  what,
  children,
}: {
  query: UseQueryResult<T>;
  what: string;
  children: (data: T) => ReactNode;
}) => {
  if (query.isError) {
    return (
      <ReadError error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  if (query.data === undefined) return <LoadingText what={what} />;
  return <>{children(query.data)}</>;
};

type AnyPages = UseInfiniteQueryResult<InfiniteData<unknown, unknown>>;

/**
 * A paged read: its first page, or the error that replaced it. A failure while
 * reading a LATER page keeps the pages already shown (each was its own valid
 * answer) and reports the failure under them (PageControls).
 */
export const PagesView = ({
  query,
  what,
  children,
}: {
  query: AnyPages;
  what: string;
  children: ReactNode;
}) => {
  if (query.isError && !query.isFetchNextPageError) {
    return (
      <ReadError error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  if (query.data === undefined) return <LoadingText what={what} />;
  return <>{children}</>;
};

export const PageControls = ({ query }: { query: AnyPages }) => {
  if (query.isFetchNextPageError) {
    return (
      <ReadError error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  if (!query.hasNextPage) {
    return <p className="text-xs text-muted-foreground">End of the list.</p>;
  }
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={query.isFetchingNextPage}
        onClick={() => void query.fetchNextPage()}
      >
        Load more
      </Button>
    </div>
  );
};
