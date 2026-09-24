import { PauseCircle } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { cn } from "@/lib/utils";

import { Note, ScreenLayout } from "../../components/display";
import { PageControls, PagesView } from "../../components/queryStates";
import { LIST_PATHS } from "../../components/recordPaths";
import {
  STOP_CLEAR_NOTE,
  STOP_JOB_KIND_NOTE,
  STOP_PLATFORM_NOTE,
} from "../../copy";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { EmptyState } from "../../components/owner";
import { useOperatorScope } from "../../session/runtime";
import { StopTable } from "./StopTable";
import { TripStopPanel } from "./TripStopPanel";

// Screen 7, Execution stops (docs/PHASE_2C_BRIEF.md §12): the active stops
// naming this tenant, or all of them with the cleared ones, each a committed
// row, and, when operator_context allows it, the one control that adds a stop
// (S7.2, TripStopPanel). Clearing stays an operator CLI act; a job_kind stop
// naming the tenant is listed read-only like every other. While the trip is
// offered, the stops are read again every cycle so each target's state stays
// current.

const VIEWS = [
  { include: false, label: "Ativas", search: "" },
  { include: true, label: "Ativas e encerradas", search: "?include=cleared" },
] as const;

const ViewTabs = ({ includeCleared }: { includeCleared: boolean }) => (
  <nav
    aria-label="Visualização das pausas"
    className="flex flex-wrap gap-1 border-b"
  >
    {VIEWS.map((view) => (
      <Link
        key={view.label}
        to={`${LIST_PATHS.stops}${view.search}`}
        aria-current={view.include === includeCleared ? "page" : undefined}
        className={cn(
          "rounded-t-md px-3 py-2 text-sm",
          view.include === includeCleared
            ? "bg-accent font-medium"
            : "hover:bg-accent/50",
        )}
      >
        {view.label}
      </Link>
    ))}
  </nav>
);

const always = () => true;

export const ExecutionStopsScreen = () => {
  const [params] = useSearchParams();
  const { context } = useOperatorScope();
  const canTrip = context.allowedActions.tripStop;
  const includeCleared = params.get("include") === "cleared";
  const stops = useCompanyOsPages(
    "list_stops",
    { p_include_cleared: includeCleared },
    canTrip ? { poll: always } : {},
  );
  const items = itemsOf(stops.data);
  return (
    <ScreenLayout
      title="Pausas"
      description="O que está impedido de iniciar novas execuções, e por quê."
    >
      <Note>{STOP_CLEAR_NOTE}</Note>
      <Note>{STOP_JOB_KIND_NOTE}</Note>
      <Note>{STOP_PLATFORM_NOTE}</Note>
      {canTrip && stops.data !== undefined ? (
        <TripStopPanel stops={items} stopsReceivedAt={stops.dataUpdatedAt} />
      ) : null}
      <ViewTabs includeCleared={includeCleared} />
      <PagesView query={stops} what="as pausas">
        <StopTable stops={items} label="Pausas" />
        {items.length === 0 ? (
          <EmptyState
            icon={PauseCircle}
            title="Nenhuma pausa por aqui."
            text="Nada está impedido de iniciar novas execuções."
          />
        ) : null}
        <PageControls query={stops} />
      </PagesView>
    </ScreenLayout>
  );
};
