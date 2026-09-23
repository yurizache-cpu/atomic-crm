import {
  Bot,
  CheckCircle2,
  CircleDot,
  Inbox,
  MessageSquare,
  PlayCircle,
  type LucideIcon,
} from "lucide-react";

import type { EventSummary } from "../../../contracts/company-os-api/index.ts";
import { eventSentence, sourceLabel } from "../format/ptBR";
import { Causation } from "./Causation";
import { None, RecordLink } from "./display";
import { eventEntryId, useShownEvents } from "./eventsInView";
import { RelativeTime, TechnicalDetails } from "./owner";

// ops.events rows as the owner reads them (docs/PHASE_2C_BRIEF.md §9, §11):
// what happened as a sentence, when, and a link to the task or run it is
// about. The event type, the source exactly as given ("other" included), the
// ids, the causing and caused events and the allowlisted facts stay under
// "Detalhes técnicos". An event type the allowlist does not know shows that its
// facts were withheld. No actor is named: the projection carries none.

const iconOf = (type: string): LucideIcon => {
  if (type.startsWith("lead_triage.review")) return Inbox;
  if (type.startsWith("lead_triage") || type.startsWith("communication"))
    return MessageSquare;
  if (type === "agent_run.succeeded" || type === "task.completed")
    return CheckCircle2;
  if (type.startsWith("agent_run")) return PlayCircle;
  if (type.startsWith("agent")) return Bot;
  return CircleDot;
};

const Facts = ({ event }: { event: EventSummary }) => {
  if (event.factsWithheld) {
    return <None>fatos retidos: o tipo não está na lista permitida</None>;
  }
  const entries = Object.entries(event.facts);
  if (entries.length === 0) return <None />;
  return (
    <span className="flex flex-col">
      {entries.map(([key, value]) => (
        <span
          key={key}
        >{`${key}: ${value === null ? "null" : String(value)}`}</span>
      ))}
    </span>
  );
};

/** The task or run the event is about, as a link where the module has a page. */
export const EventSubject = ({ event }: { event: EventSummary }) => {
  if (event.subjectType === null || event.subjectId === null) return null;
  const id = event.subjectId;
  if (event.subjectType === "task") {
    return (
      <span className="flex flex-wrap gap-3 text-xs">
        <RecordLink kind="task" id={id} label={`Tarefa ${id}`}>
          Ver tarefa
        </RecordLink>
        <RecordLink kind="taskChain" id={id} label={`Cadeia da tarefa ${id}`}>
          Ver cadeia
        </RecordLink>
      </span>
    );
  }
  if (event.subjectType === "agent_run") {
    return (
      <span className="flex flex-wrap gap-3 text-xs">
        <RecordLink kind="run" id={id} label={`Execução ${id}`}>
          Ver execução
        </RecordLink>
        <RecordLink kind="runChain" id={id} label={`Cadeia da execução ${id}`}>
          Ver cadeia
        </RecordLink>
      </span>
    );
  }
  if (event.subjectType === "agent") {
    return (
      <span className="text-xs">
        <RecordLink kind="agent" id={id} label={`Agente ${id}`}>
          Ver agente
        </RecordLink>
      </span>
    );
  }
  return null;
};

/** One event as a feed entry. */
export const EventItem = ({ event }: { event: EventSummary }) => {
  const Icon = iconOf(event.type);
  return (
    <li
      id={eventEntryId(event.id)}
      tabIndex={-1}
      className="flex gap-3 rounded-lg px-2 py-3 outline-none focus:bg-accent/50"
    >
      <span className="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-medium">{eventSentence(event.type)}</span>
          <span className="text-xs text-muted-foreground">
            <RelativeTime value={event.createdAt} />
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {`Origem: ${sourceLabel(event.source)}`}
        </span>
        <EventSubject event={event} />
        <TechnicalDetails
          rows={[
            ["Tipo", event.type],
            ["Origem", event.source],
            ["Evento", event.id],
            ["Assunto", `${event.subjectType ?? "—"} ${event.subjectId ?? ""}`],
            ["Momento (UTC)", event.createdAt],
            ["Causação", <Causation key="c" event={event} />],
            ["Fatos", <Facts key="f" event={event} />],
          ]}
        />
      </div>
    </li>
  );
};

/** ops.events rows as a readable feed; `label` names the list for assistive tech. */
export const EventTable = ({
  events,
  label,
}: {
  events: readonly EventSummary[];
  label: string;
}) => {
  useShownEvents(events);
  return (
    <ul aria-label={label} className="flex flex-col divide-y">
      {events.map((event) => (
        <EventItem key={event.id} event={event} />
      ))}
    </ul>
  );
};
