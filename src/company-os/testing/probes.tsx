import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { useCompanyOsQuery } from "../query/useCompanyOsQuery";

// A screen for the shell's browser tests: it reads list_stops through the
// module's own query hook, renders each stop's reason, and exposes the query
// client the shell gave it, so a test can check what the cache still holds.

export interface StopsProbe {
  readonly Screen: () => React.JSX.Element;
  /** The shell's query client, once the probe has rendered. */
  client(): QueryClient;
}

export const createStopsProbe = (): StopsProbe => {
  let captured: QueryClient | undefined;

  const Screen = () => {
    captured = useQueryClient();
    const stops = useCompanyOsQuery("list_stops", {});
    return (
      <section aria-label="Stops probe">
        <h1>Stops probe</h1>
        {stops.data?.items.map((stop) => (
          <p key={stop.id}>{stop.reason}</p>
        ))}
        <button type="button" onClick={() => void stops.refetch()}>
          Read stops again
        </button>
      </section>
    );
  };

  return {
    Screen,
    client: () => {
      if (captured === undefined) throw new Error("The probe never rendered.");
      return captured;
    },
  };
};

/** Every cached key and value, as one string to search for a sentinel. */
export const cachedText = (client: QueryClient): string =>
  JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
  );
