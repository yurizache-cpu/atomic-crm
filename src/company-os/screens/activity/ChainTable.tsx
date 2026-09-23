import type { ReactNode } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type {
  AgentRunDetail,
  EventSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { Causation } from "../../components/Causation";
import { EventSubject } from "../../components/EventTable";
import { Timestamp } from "../../components/display";
import { eventEntryId } from "../../components/eventsInView";
import { ABSENT_STEP_TEXT, NOT_LOADED_STEP_TEXT } from "../../copy";
import { jobStepLabel } from "../../format/ptBR";
import { eventsOfStep, type ChainStep } from "./chainSteps";

// A chain as a table of steps: each row names a step and lists the durable
// facts that record it with their own times, or says the step is absent. A
// step is absent only once every page of the subject's facts has been read:
// the facts come newest first, so while older pages remain unread, an empty
// step says that instead (docs/PHASE_2C_BRIEF.md §11, "never inferred").

const Absent = () => (
  <span className="text-muted-foreground">{ABSENT_STEP_TEXT}</span>
);

const NotLoaded = () => (
  <span className="text-muted-foreground">{NOT_LOADED_STEP_TEXT}</span>
);

const EventFact = ({ event }: { event: EventSummary }) => (
  <li
    id={eventEntryId(event.id)}
    tabIndex={-1}
    className="flex flex-wrap items-center gap-x-3 gap-y-1"
  >
    <span className="font-mono text-xs">{event.type}</span>
    <Timestamp value={event.createdAt} />
    <span className="text-xs text-muted-foreground">{`origem ${event.source}`}</span>
    <Causation event={event} />
  </li>
);

export const EventFacts = ({
  events,
  complete,
}: {
  events: readonly EventSummary[];
  /** Whether every page of the subject's facts has been read. */
  complete: boolean;
}) =>
  events.length === 0 ? (
    complete ? (
      <Absent />
    ) : (
      <NotLoaded />
    )
  ) : (
    <ul className="flex flex-col gap-1">
      {events.map((event) => (
        <EventFact key={event.id} event={event} />
      ))}
    </ul>
  );

export const JobStepFacts = ({
  steps,
}: {
  steps: AgentRunDetail["jobSteps"];
}) =>
  steps.length === 0 ? (
    <Absent />
  ) : (
    <ul className="flex flex-col gap-1">
      {steps.map((step, index) => (
        <li
          key={`${step.at}-${step.step}-${index}`}
          className="flex flex-wrap items-center gap-x-3"
        >
          <span>{jobStepLabel(step.step)}</span>
          <span className="text-xs text-muted-foreground">{`tentativa ${step.attempt ?? "—"}`}</span>
          <Timestamp value={step.at} />
        </li>
      ))}
    </ul>
  );

export const ChainRow = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <TableRow>
    <TableHead scope="row" className="align-top">
      {label}
    </TableHead>
    <TableCell className="whitespace-normal">{children}</TableCell>
  </TableRow>
);

/** One step whose facts are events; `complete` once every page is read. */
export const EventStepRow = ({
  step,
  events,
  complete,
}: {
  step: ChainStep;
  events: readonly EventSummary[];
  complete: boolean;
}) => (
  <ChainRow label={step.label}>
    <EventFacts events={eventsOfStep(events, step)} complete={complete} />
  </ChainRow>
);

export const ChainTable = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <Table aria-label={label}>
    <TableHeader>
      <TableRow>
        <TableHead>Etapa</TableHead>
        <TableHead>Registros que comprovam</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>{children}</TableBody>
  </Table>
);

/** Facts on the subject that no step claims, so nothing is hidden. */
export const OtherFacts = ({ events }: { events: readonly EventSummary[] }) =>
  events.length === 0 ? null : (
    <ul className="flex flex-col gap-1">
      {events.map((event) => (
        <li
          key={event.id}
          id={eventEntryId(event.id)}
          tabIndex={-1}
          className="flex flex-wrap items-center gap-x-3"
        >
          <span className="font-mono text-xs">{event.type}</span>
          <Timestamp value={event.createdAt} />
          <EventSubject event={event} />
          <Causation event={event} />
        </li>
      ))}
    </ul>
  );
