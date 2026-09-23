import { Route, Routes } from "react-router";

import { EventTable } from "../../components/EventTable";
import { Note, ScreenLayout, Section } from "../../components/display";
import { PageControls, PagesView } from "../../components/queryStates";
import { STOP_EVENTS_LABEL } from "../../copy";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { StopTable } from "../stops/StopTable";
import { RunChain } from "./RunChain";
import { TaskChain } from "./TaskChain";

// Screen 2, Activity (docs/PHASE_2C_BRIEF.md §12): the tenant's event feed,
// newest first, one opaque-cursor page at a time, and the stops naming the
// tenant read from their own rows, because a stop trip writes no event. The
// per-task and per-run chains (§11) open from a task, a run or an entry here.
// The feed is a view, not a ledger: a late commit lands on an older page, and
// reading again starts from the first page.

const EventFeed = () => {
  const events = useCompanyOsPages("list_events", {});
  return (
    <Section title="Eventos">
      <PagesView query={events} what="a atividade">
        <EventTable
          events={itemsOf(events.data)}
          label="Atividade da empresa"
        />
        <PageControls query={events} />
      </PagesView>
    </Section>
  );
};

const StopFeed = () => {
  const stops = useCompanyOsPages("list_stops", { p_include_cleared: true });
  const items = itemsOf(stops.data);
  return (
    <Section title={`Pausas (${STOP_EVENTS_LABEL.toLowerCase()})`}>
      <Note>
        {`${STOP_EVENTS_LABEL}: estas entradas vêm dos registros de pausa desta empresa, não do feed de eventos.`}
      </Note>
      <PagesView query={stops} what="as pausas">
        <StopTable
          stops={items}
          label="Pausas a partir dos próprios registros"
        />
        {items.length === 0 ? <Note>Nenhuma pausa nesta empresa.</Note> : null}
        <PageControls query={stops} />
      </PagesView>
    </Section>
  );
};

const ActivityFeed = () => (
  <ScreenLayout
    title="Atividade"
    description="Tudo o que aconteceu na sua empresa, do mais recente para o mais antigo."
  >
    <EventFeed />
    <StopFeed />
  </ScreenLayout>
);

export const ActivityScreen = () => (
  <Routes>
    <Route index element={<ActivityFeed />} />
    <Route path="task/:taskId" element={<TaskChain />} />
    <Route path="run/:runId" element={<RunChain />} />
  </Routes>
);
