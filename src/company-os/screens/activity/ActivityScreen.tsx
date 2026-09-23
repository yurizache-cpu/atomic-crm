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
    <Section title="Events">
      <PagesView query={events} what="the events">
        <EventTable events={itemsOf(events.data)} label="Tenant events" />
        <PageControls query={events} />
      </PagesView>
    </Section>
  );
};

const StopFeed = () => {
  const stops = useCompanyOsPages("list_stops", { p_include_cleared: true });
  const items = itemsOf(stops.data);
  return (
    <Section title={`Execution stops (${STOP_EVENTS_LABEL.toLowerCase()})`}>
      <Note>
        {`${STOP_EVENTS_LABEL}: these entries are read from the stop rows naming this tenant, not from the event feed.`}
      </Note>
      <PagesView query={stops} what="the stops">
        <StopTable stops={items} label="Stops from their own rows" />
        {items.length === 0 ? <Note>No stop names this tenant.</Note> : null}
        <PageControls query={stops} />
      </PagesView>
    </Section>
  );
};

const ActivityFeed = () => (
  <ScreenLayout
    title="Activity"
    description="Every entry is an event row, a stop row naming this tenant, or a job step read from a run's own job."
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
