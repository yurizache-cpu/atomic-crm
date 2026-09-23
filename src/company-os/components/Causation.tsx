import { useState, type ReactNode } from "react";

import type { EventSummary } from "../../../contracts/company-os-api/index.ts";
import { IdText } from "./display";
import {
  EventsInView,
  createEventRegistry,
  focusEventEntry,
  useEventRegistry,
} from "./eventsInView";

// Causation links (docs/PHASE_2C_BRIEF.md §12 Activity: "the per-task and
// per-run chains with causation links"). An event names the event that caused
// it by id; where that event is shown on the same page, the id is a link that
// moves the focus to its entry, and each entry lists, the same way, the events
// on the page it caused. Where it is not shown (an older page not loaded, a
// chain of another subject), the id stays plain text: a link is never offered
// to something the page does not show. The links move the focus only; they
// read and change nothing.

/** One registry per page: OperatorFrame wraps every screen in it. */
export const EventsInViewProvider = ({ children }: { children: ReactNode }) => {
  const [registry] = useState(createEventRegistry);
  return (
    <EventsInView.Provider value={registry}>{children}</EventsInView.Provider>
  );
};

const EventLink = ({ id }: { id: string }) => (
  <button
    type="button"
    aria-label={`Go to event ${id}`}
    onClick={() => focusEventEntry(id)}
    className="font-mono text-xs underline underline-offset-4"
  >
    {id}
  </button>
);

/** An event's cause and its effects, each a link where it is on the page. */
export const Causation = ({ event }: { event: EventSummary }) => {
  const registry = useEventRegistry();
  const inView = (id: string) => registry?.has(id) ?? false;
  const effects = registry?.effectsOf(event.id) ?? [];
  if (event.causationId === null && effects.length === 0) {
    return <IdText id={null} />;
  }
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {event.causationId === null ? null : (
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">caused by</span>
          {inView(event.causationId) ? (
            <EventLink id={event.causationId} />
          ) : (
            <IdText id={event.causationId} />
          )}
        </span>
      )}
      {effects.length === 0 ? null : (
        <span className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">caused</span>
          {effects.map((id) => (
            <EventLink key={id} id={id} />
          ))}
        </span>
      )}
    </span>
  );
};
