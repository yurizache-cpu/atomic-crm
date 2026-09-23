import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

import type { EventSummary } from "../../../contracts/company-os-api/index.ts";

// Causation links (docs/PHASE_2C_BRIEF.md §12 Activity: "the per-task and
// per-run chains with causation links"): the page's registry of the events it
// shows, and the hooks that fill and read it. Causation.tsx renders the links.
//
// Every list of events registers what it shows, so a task's chain links a
// task fact to the run fact that caused it although the two come from
// different reads, and a link is only ever offered to an entry on the page.

interface ShownEvent {
  readonly id: string;
  readonly causationId: string | null;
}

export interface EventRegistry {
  add(events: readonly ShownEvent[]): () => void;
  has(id: string): boolean;
  effectsOf(id: string): readonly string[];
  subscribe(listener: () => void): () => void;
  version(): number;
}

export const createEventRegistry = (): EventRegistry => {
  const shown = new Map<
    string,
    { causationId: string | null; count: number }
  >();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };
  return {
    add: (events) => {
      for (const { id, causationId } of events) {
        const entry = shown.get(id);
        shown.set(id, { causationId, count: (entry?.count ?? 0) + 1 });
      }
      changed();
      return () => {
        for (const { id } of events) {
          const entry = shown.get(id);
          if (entry === undefined) continue;
          if (entry.count <= 1) shown.delete(id);
          else shown.set(id, { ...entry, count: entry.count - 1 });
        }
        changed();
      };
    },
    has: (id) => shown.has(id),
    effectsOf: (id) =>
      [...shown.entries()]
        .filter(([, entry]) => entry.causationId === id)
        .map(([effect]) => effect),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
};

export const EventsInView = createContext<EventRegistry | null>(null);

/** Registers `events` as shown on this page while the caller is mounted. */
export const useShownEvents = (events: readonly EventSummary[]): void => {
  const registry = useContext(EventsInView);
  const shown = JSON.stringify(
    events.map((event) => [event.id, event.causationId]),
  );
  useEffect(() => {
    if (registry === null) return undefined;
    const pairs = JSON.parse(shown) as [string, string | null][];
    return registry.add(
      pairs.map(([id, causationId]) => ({ id, causationId })),
    );
  }, [registry, shown]);
};

const noSubscription = () => () => {};
const noVersion = () => 0;

/** The page's registry, re-rendering the caller whenever it changes. */
export const useEventRegistry = (): EventRegistry | null => {
  const registry = useContext(EventsInView);
  useSyncExternalStore(
    registry?.subscribe ?? noSubscription,
    registry?.version ?? noVersion,
  );
  return registry;
};

/** The DOM id of an event's entry, so a causation link can reach it. */
export const eventEntryId = (id: string): string => `company-os-event-${id}`;

/** Moves the focus to an event's entry on this page. */
export const focusEventEntry = (id: string): void => {
  const entry = document.getElementById(eventEntryId(id));
  if (entry === null) return;
  entry.scrollIntoView({ block: "nearest" });
  entry.focus();
};
