import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { EventSummary } from "../../../contracts/company-os-api/index.ts";
import { Causation } from "./Causation";
import { IdText, None, RecordLink, Timestamp } from "./display";
import { eventEntryId, useShownEvents } from "./eventsInView";

// ops.events rows as the projection returns them (docs/PHASE_2C_BRIEF.md §9,
// §11): the source exactly as given ("other" included), the subject as a
// link, the causing and the caused events as links where they are on the page
// (Causation.tsx), and the allowlisted facts as key/value text. An event type
// the allowlist does not know shows that its facts were withheld.

const Facts = ({ event }: { event: EventSummary }) => {
  if (event.factsWithheld) {
    return <None>facts withheld: the type is not on the allowlist</None>;
  }
  const entries = Object.entries(event.facts);
  if (entries.length === 0) return <None />;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-mono text-muted-foreground">{key}</dt>
          <dd className="font-mono">
            {value === null ? "null" : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
};

/** The subject as a link where the module has a page for it, else as text. */
export const EventSubject = ({ event }: { event: EventSummary }) => {
  if (event.subjectType === null || event.subjectId === null) return <None />;
  const id = event.subjectId;
  const link =
    event.subjectType === "task" ? (
      <RecordLink kind="task" id={id} />
    ) : event.subjectType === "agent_run" ? (
      <RecordLink kind="run" id={id} />
    ) : event.subjectType === "agent" ? (
      <RecordLink kind="agent" id={id} />
    ) : (
      <IdText id={id} />
    );
  const chain =
    event.subjectType === "task" ? (
      <RecordLink kind="taskChain" id={id} label={`Chain of task ${id}`}>
        chain
      </RecordLink>
    ) : event.subjectType === "agent_run" ? (
      <RecordLink kind="runChain" id={id} label={`Chain of run ${id}`}>
        chain
      </RecordLink>
    ) : null;
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{event.subjectType}</span>
      {link}
      {chain}
    </span>
  );
};

export const EventTable = ({
  events,
  label,
}: {
  events: readonly EventSummary[];
  label: string;
}) => {
  useShownEvents(events);
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead>At</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Causation</TableHead>
          <TableHead>Facts</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <TableRow key={event.id} id={eventEntryId(event.id)} tabIndex={-1}>
            <TableCell>
              <Timestamp value={event.createdAt} />
            </TableCell>
            <TableCell className="font-mono text-xs">{event.type}</TableCell>
            <TableCell>{event.source}</TableCell>
            <TableCell>
              <EventSubject event={event} />
            </TableCell>
            <TableCell>
              <Causation event={event} />
            </TableCell>
            <TableCell>
              <Facts event={event} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
