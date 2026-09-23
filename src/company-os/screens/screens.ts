import type { ComponentType } from "react";

import { ActivityScreen } from "./activity/ActivityScreen";
import { AgentsScreen } from "./agents/AgentsScreen";
import { CommunicationsScreen } from "./communications/CommunicationsScreen";
import { CostsScreen } from "./costs/CostsScreen";
import { OverviewScreen } from "./overview/OverviewScreen";
import { AgentRunsScreen } from "./runs/RunsScreen";
import { ReviewsScreen } from "./reviews/ReviewsScreen";
import { ExecutionStopsScreen } from "./stops/ExecutionStopsScreen";
import { TasksScreen } from "./tasks/TasksScreen";

// The screens of docs/PHASE_2C_BRIEF.md §12, in navigation order: the eight
// core screens, then the optional, narrow Communications status view. Every
// one is read-only: no screen renders a decision, a stop, a send, a draft or
// any configuration change, and each one's h1 is its label.

export type ScreenId =
  | "overview"
  | "activity"
  | "tasks"
  | "agents"
  | "runs"
  | "reviews"
  | "stops"
  | "costs"
  | "communications";

export interface ScreenDefinition {
  readonly id: ScreenId;
  readonly label: string;
  /** Below /company-os; "" is the module's index. */
  readonly path: string;
}

export const SCREENS: readonly ScreenDefinition[] = [
  { id: "overview", label: "Overview", path: "" },
  { id: "activity", label: "Activity", path: "activity" },
  { id: "tasks", label: "Tasks", path: "tasks" },
  { id: "agents", label: "Agents", path: "agents" },
  { id: "runs", label: "Agent runs", path: "runs" },
  { id: "reviews", label: "Reviews", path: "reviews" },
  { id: "stops", label: "Execution stops", path: "stops" },
  { id: "costs", label: "Costs", path: "costs" },
  {
    id: "communications",
    label: "Communications status",
    path: "communications",
  },
];

export type ScreenComponents = Readonly<Record<ScreenId, ComponentType>>;

export const DEFAULT_SCREENS: ScreenComponents = {
  overview: OverviewScreen,
  activity: ActivityScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
  runs: AgentRunsScreen,
  reviews: ReviewsScreen,
  stops: ExecutionStopsScreen,
  costs: CostsScreen,
  communications: CommunicationsScreen,
};

/** The router path of a screen. */
export const screenPath = ({ path }: ScreenDefinition): string =>
  path === "" ? "/company-os" : `/company-os/${path}`;
