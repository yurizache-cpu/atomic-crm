import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { ExecutionStopSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  IdText,
  None,
  RecordLink,
  StateBadge,
  Timestamp,
} from "../../components/display";
import { humanize } from "../../format/labels";
import { useOperatorScope } from "../../session/runtime";

// Stops naming the caller's tenant, from their own rows
// (docs/PHASE_2C_BRIEF.md §9 ExecutionStopSummary): scope, target, origin,
// times, the reason and the clear reason. Never who tripped or cleared a stop
// (the stored labels are free-form); the origin says whether a person or the
// system did. Every stop is shown read-only: there is no clear and no trip.

/** A tenant or job_kind stop names the caller's own tenant, by its name. */
const TenantTarget = ({ jobKind }: { jobKind: string | null }) => {
  const { context } = useOperatorScope();
  return (
    <span className="flex flex-col gap-0.5">
      <span>{`tenant ${context.tenant.name}`}</span>
      {jobKind === null ? null : (
        <span className="font-mono text-xs">{`job kind ${jobKind}`}</span>
      )}
    </span>
  );
};

const Target = ({ stop }: { stop: ExecutionStopSummary }) => {
  if (stop.target === null) return <TenantTarget jobKind={stop.jobKind} />;
  const { target } = stop;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{target.name}</span>
      {target.agentId === null ? (
        <IdText id={target.departmentId ?? target.companyId} />
      ) : (
        <RecordLink kind="agent" id={target.agentId} />
      )}
    </span>
  );
};

const StopRow = ({ stop }: { stop: ExecutionStopSummary }) => (
  <TableRow>
    <TableCell>
      <StateBadge
        value={stop.clearedAt === null ? "stopped" : "cleared"}
        label={stop.clearedAt === null ? "active" : "cleared"}
      />
    </TableCell>
    <TableCell>
      <span className="flex flex-wrap gap-1">
        <span>{humanize(stop.scope)}</span>
        {stop.scope === "job_kind" ? (
          <StateBadge value="read_only" label="read-only" />
        ) : null}
      </span>
    </TableCell>
    <TableCell>
      <Target stop={stop} />
    </TableCell>
    <TableCell>{stop.origin}</TableCell>
    <TableCell>
      <Timestamp value={stop.trippedAt} />
    </TableCell>
    <TableCell className="whitespace-pre-wrap">{stop.reason}</TableCell>
    <TableCell>
      <Timestamp value={stop.clearedAt} />
    </TableCell>
    <TableCell className="whitespace-pre-wrap">
      {stop.clearedReason === null ? <None /> : stop.clearedReason}
    </TableCell>
    <TableCell>
      <IdText id={stop.id} />
    </TableCell>
  </TableRow>
);

export const StopTable = ({
  stops,
  label,
}: {
  stops: readonly ExecutionStopSummary[];
  label: string;
}) => (
  <Table aria-label={label}>
    <TableHeader>
      <TableRow>
        <TableHead>State</TableHead>
        <TableHead>Scope</TableHead>
        <TableHead>Target</TableHead>
        <TableHead>Origin</TableHead>
        <TableHead>Tripped</TableHead>
        <TableHead>Reason</TableHead>
        <TableHead>Cleared</TableHead>
        <TableHead>Clear reason</TableHead>
        <TableHead>Stop id</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {stops.map((stop) => (
        <StopRow key={stop.id} stop={stop} />
      ))}
    </TableBody>
  </Table>
);
