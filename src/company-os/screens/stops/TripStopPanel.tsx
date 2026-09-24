import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type {
  AgentSummary,
  ExecutionStopSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { Note, Section } from "../../components/display";
import { StatusChip } from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import {
  TRIP_ACTION_LABEL,
  TRIP_ALREADY_STOPPED_TEXT,
  TRIP_BLOCKS_TEXT,
  TRIP_BUSY_TEXT,
  TRIP_CONFIRM_LABEL,
  TRIP_CONFIRM_TITLE,
  TRIP_COVERED_LABEL,
  TRIP_NOT_ALLOWED_TEXT,
  TRIP_NOT_CONFIRMED_TEXT,
  TRIP_NOT_FOUND_TEXT,
  TRIP_PANEL_NOTE,
  TRIP_REFUSED_TEXT,
  TRIP_RUNNING_LABEL,
  TRIP_STATE_UNKNOWN_LABEL,
  TRIP_STOPPED_LABEL,
  TRIP_STOPPED_TEXT,
  TRIP_UNKNOWN_TEXT,
} from "../../copy";
import { agentDisplayName, tenantDisplayName } from "../../format/displayNames";
import { stopScopeLabel } from "../../format/ptBR";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import {
  stopsExactly,
  useTripStop,
  type TripOutcome,
  type TripTarget,
} from "../../query/useTripStop";
import { useOperatorScope } from "../../session/runtime";

// The second browser act (S7.2): interrupt the execution of the whole tenant,
// a company, a department or an agent, each behind its own confirmation, none
// preselected or focused by default. The targets are the units the tenant's
// agents belong to (list_agents), so a unit with no agent is not offered.
// A target stopped at exactly its own scope offers nothing; nothing on this
// screen clears a stop. Every refusal still comes from the server, and the
// server answers a repeated trip with the stop that already holds the target.

interface TargetRow {
  readonly key: string;
  readonly target: TripTarget;
  /** The unit's name as the owner reads it. */
  readonly name: string;
  readonly companyId: string | null;
  readonly departmentId: string | null;
}

/** "Agente Lead Triage": the scope and the name, for a label or a message. */
const labelOf = (row: TargetRow) =>
  row.target.scope === "tenant"
    ? `${stopScopeLabel("tenant")} (${row.name})`
    : `${stopScopeLabel(row.target.scope)} ${row.name}`;

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, "pt-BR");

/** The tenant, then each company with its departments and their agents. */
const targetsOf = (
  tenantName: string,
  agents: readonly AgentSummary[],
): TargetRow[] => {
  const rows: TargetRow[] = [
    {
      key: "tenant",
      target: { scope: "tenant", id: null },
      name: tenantName,
      companyId: null,
      departmentId: null,
    },
  ];
  const companies = [
    ...new Map(agents.map((a) => [a.company.id, a.company])).values(),
  ].sort(byName);
  for (const company of companies) {
    rows.push({
      key: `company:${company.id}`,
      target: { scope: "company", id: company.id },
      name: company.name,
      companyId: company.id,
      departmentId: null,
    });
    const inCompany = agents.filter((a) => a.company.id === company.id);
    const departments = [
      ...new Map(
        inCompany.map((a) => [a.department.id, a.department]),
      ).values(),
    ].sort(byName);
    for (const department of departments) {
      rows.push({
        key: `department:${department.id}`,
        target: { scope: "department", id: department.id },
        name: department.name,
        companyId: company.id,
        departmentId: department.id,
      });
      for (const agent of inCompany
        .filter((a) => a.department.id === department.id)
        .map((a) => ({ ...a, name: agentDisplayName(a.name) }))
        .sort(byName)) {
        rows.push({
          key: `agent:${agent.id}`,
          target: { scope: "agent", id: agent.id },
          name: agent.name,
          companyId: company.id,
          departmentId: department.id,
        });
      }
    }
  }
  return rows;
};

/** Whether an active stop broader than `row`'s own scope holds it. */
const coveredByBroader = (
  stop: ExecutionStopSummary,
  row: TargetRow,
): boolean => {
  if (stop.clearedAt !== null || stopsExactly(stop, row.target)) return false;
  switch (stop.scope) {
    case "tenant":
      return true;
    case "company":
      return (
        row.target.scope !== "tenant" &&
        stop.target?.companyId === row.companyId
      );
    case "department":
      return (
        row.target.scope === "agent" &&
        stop.target?.departmentId === row.departmentId
      );
    default:
      return false;
  }
};

const OUTCOME_TEXT: Record<TripOutcome["kind"], string> = {
  stopped: TRIP_STOPPED_TEXT,
  already_stopped: TRIP_ALREADY_STOPPED_TEXT,
  not_allowed: TRIP_NOT_ALLOWED_TEXT,
  not_found: TRIP_NOT_FOUND_TEXT,
  busy: TRIP_BUSY_TEXT,
  refused: TRIP_REFUSED_TEXT,
  not_confirmed: TRIP_NOT_CONFIRMED_TEXT,
  unknown: TRIP_UNKNOWN_TEXT,
};

const OutcomeMessage = ({
  outcome,
  label,
}: {
  outcome: TripOutcome;
  label: string;
}) => (
  <p
    role="status"
    className={cn(
      "rounded-lg border px-3 py-2 text-sm",
      outcome.kind === "stopped" || outcome.kind === "already_stopped"
        ? "border-emerald-500/40 bg-emerald-500/10"
        : "border-amber-500/40 bg-amber-500/10",
    )}
  >
    {OUTCOME_TEXT[outcome.kind]} Alvo: {label}.
  </p>
);

const Confirmation = ({
  row,
  pending,
  onConfirm,
  onCancel,
}: {
  row: TargetRow;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = `trip-confirm-${row.key}`;
  // The safe choice has the focus: confirming is a second, deliberate act.
  useEffect(() => cancel.current?.focus(), [row.key]);
  return (
    <div
      role="alertdialog"
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4"
    >
      <p id={titleId} className="font-medium">
        {TRIP_CONFIRM_TITLE[row.target.scope]}
      </p>
      <p className="text-sm">{labelOf(row)}</p>
      <p className="text-sm">{TRIP_BLOCKS_TEXT}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="destructive" disabled={pending} onClick={onConfirm}>
          {pending ? "Interrompendo…" : TRIP_CONFIRM_LABEL}
        </Button>
        <Button
          ref={cancel}
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          Cancelar
        </Button>
      </div>
    </div>
  );
};

const TargetState = ({
  current,
  exact,
  covered,
}: {
  current: boolean;
  exact: boolean;
  covered: boolean;
}) => {
  if (!current)
    return <StatusChip tone="gray" label={TRIP_STATE_UNKNOWN_LABEL} />;
  if (exact) return <StatusChip tone="red" label={TRIP_STOPPED_LABEL} />;
  if (covered) return <StatusChip tone="amber" label={TRIP_COVERED_LABEL} />;
  return <StatusChip tone="green" label={TRIP_RUNNING_LABEL} />;
};

const Targets = ({
  rows,
  stops,
  current,
}: {
  rows: readonly TargetRow[];
  stops: readonly ExecutionStopSummary[];
  current: boolean;
}) => {
  const trip = useTripStop();
  const [choice, setChoice] = useState<TargetRow | null>(null);
  const [last, setLast] = useState<TargetRow | null>(null);
  const outcome = trip.data;
  const closed = outcome?.kind === "not_allowed";

  const confirm = () => {
    if (choice === null || trip.isPending) return;
    setLast(choice);
    trip.mutate(choice.target, { onSettled: () => setChoice(null) });
  };

  return (
    <div className="flex flex-col gap-3">
      {outcome === undefined || last === null ? null : (
        <OutcomeMessage outcome={outcome} label={labelOf(last)} />
      )}
      <div
        role="group"
        aria-label={TRIP_ACTION_LABEL}
        className="flex flex-col gap-2"
      >
        <div role="list" aria-label="Alvos" className="flex flex-col gap-2">
          {rows.map((row) => {
            const exact = stops.some((stop) => stopsExactly(stop, row.target));
            const covered = stops.some((stop) => coveredByBroader(stop, row));
            return (
              <div
                role="listitem"
                key={row.key}
                className="flex flex-col gap-2 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-col">
                    <span className="font-medium">{row.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {stopScopeLabel(row.target.scope)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <TargetState
                      current={current}
                      exact={exact}
                      covered={covered}
                    />
                    {exact || closed ? null : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-destructive/50 text-destructive hover:text-destructive"
                        aria-label={`${TRIP_ACTION_LABEL}: ${labelOf(row)}`}
                        aria-pressed={choice?.key === row.key}
                        disabled={trip.isPending}
                        onClick={() => setChoice(row)}
                      >
                        {TRIP_ACTION_LABEL}
                      </Button>
                    )}
                  </div>
                </div>
                {choice?.key !== row.key ? null : (
                  <Confirmation
                    row={row}
                    pending={trip.isPending}
                    onConfirm={confirm}
                    onCancel={() => setChoice(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/**
 * The trip section of the Execution stops screen, shown only when
 * operator_context says the member may trip; `stops` are the stops the screen
 * has read, and `stopsReceivedAt` when.
 */
export const TripStopPanel = ({
  stops,
  stopsReceivedAt,
}: {
  stops: readonly ExecutionStopSummary[];
  stopsReceivedAt: number;
}) => {
  const { context } = useOperatorScope();
  const agents = useCompanyOsQuery("list_agents", {}, { poll: true });
  const current = useIsStateCurrent(
    Math.min(stopsReceivedAt, agents.dataUpdatedAt),
  );
  return (
    <Section title={TRIP_ACTION_LABEL}>
      <Note>{TRIP_PANEL_NOTE}</Note>
      <QueryView query={agents} what="os alvos">
        {(list) => (
          <Targets
            rows={targetsOf(tenantDisplayName(context.tenant.name), list.items)}
            stops={stops}
            current={current}
          />
        )}
      </QueryView>
    </Section>
  );
};
