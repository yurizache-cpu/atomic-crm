import {
  Activity,
  Bot,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Wallet,
  type LucideIcon,
} from "lucide-react";
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

export type ScreenGroup = "Operação" | "Equipe" | "Governança" | "Canais";

export interface ScreenDefinition {
  readonly id: ScreenId;
  readonly label: string;
  /** Below /company-os; "" is the module's index. */
  readonly path: string;
  readonly group: ScreenGroup;
  readonly icon: LucideIcon;
}

export const SCREENS: readonly ScreenDefinition[] = [
  {
    id: "overview",
    label: "Visão geral",
    path: "",
    group: "Operação",
    icon: LayoutDashboard,
  },
  {
    id: "activity",
    label: "Atividade",
    path: "activity",
    group: "Operação",
    icon: Activity,
  },
  {
    id: "tasks",
    label: "Tarefas",
    path: "tasks",
    group: "Operação",
    icon: ListChecks,
  },
  {
    id: "agents",
    label: "Equipe de IA",
    path: "agents",
    group: "Equipe",
    icon: Bot,
  },
  {
    id: "runs",
    label: "Execuções",
    path: "runs",
    group: "Equipe",
    icon: PlayCircle,
  },
  {
    id: "reviews",
    label: "Decisões",
    path: "reviews",
    group: "Governança",
    icon: Inbox,
  },
  {
    id: "stops",
    label: "Pausas",
    path: "stops",
    group: "Governança",
    icon: PauseCircle,
  },
  {
    id: "costs",
    label: "Custos",
    path: "costs",
    group: "Governança",
    icon: Wallet,
  },
  {
    id: "communications",
    label: "Comunicações",
    path: "communications",
    group: "Canais",
    icon: MessageSquare,
  },
];

export const SCREEN_GROUPS: readonly ScreenGroup[] = [
  "Operação",
  "Equipe",
  "Governança",
  "Canais",
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
