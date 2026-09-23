import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { AgentRunSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  MoneyText,
  None,
  RecordLink,
  StateBadge,
  Timestamp,
} from "../../components/display";
import { shownRunStatus } from "./liveness";

// Agent runs as a table (docs/PHASE_2C_BRIEF.md §12 screen 5): capability,
// route, provider and model, status, attention, timing and the charged cost as
// the server's string. Never the result text; a run carries none. Every table
// passes `current`, whether its answer is younger than two polling intervals
// (§10): once it is not, a run that can still change reads "unknown", and a
// settled run keeps its final status (liveness.ts).

const RunRow = ({
  run,
  current,
}: {
  run: AgentRunSummary;
  current: boolean;
}) => (
  <TableRow>
    <TableCell>
      <RecordLink kind="run" id={run.id} />
    </TableCell>
    <TableCell>
      <span className="flex flex-wrap gap-1">
        {shownRunStatus(run, current) === "unknown" ? (
          <StateBadge value="unknown" />
        ) : (
          <>
            <StateBadge value={run.status} />
            {run.attention === null ? null : (
              <StateBadge value={run.attention} />
            )}
          </>
        )}
      </span>
    </TableCell>
    <TableCell>{run.capability}</TableCell>
    <TableCell>{run.modelRoute}</TableCell>
    <TableCell>
      {run.provider === null ? (
        <None />
      ) : (
        <span>{`${run.provider} / ${run.model ?? "no model"}`}</span>
      )}
    </TableCell>
    <TableCell>
      <RecordLink kind="agent" id={run.agentId} />
    </TableCell>
    <TableCell>
      <RecordLink kind="task" id={run.taskId} />
    </TableCell>
    <TableCell>
      <Timestamp value={run.createdAt} />
    </TableCell>
    <TableCell>
      <Timestamp value={run.completedAt} />
    </TableCell>
    <TableCell>
      <MoneyText value={run.chargedCost} />
    </TableCell>
  </TableRow>
);

export const RunTable = ({
  runs,
  label,
  current,
}: {
  runs: readonly AgentRunSummary[];
  label: string;
  /** Whether the answer the runs came in is still current (§10). */
  current: boolean;
}) => (
  <Table aria-label={label}>
    <TableHeader>
      <TableRow>
        <TableHead>Run</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Capability</TableHead>
        <TableHead>Route</TableHead>
        <TableHead>Provider / model</TableHead>
        <TableHead>Agent</TableHead>
        <TableHead>Task</TableHead>
        <TableHead>Created</TableHead>
        <TableHead>Completed</TableHead>
        <TableHead>Charged</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} current={current} />
      ))}
    </TableBody>
  </Table>
);
