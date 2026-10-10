import {
  Activity,
  Bot,
  CalendarDays,
  Filter,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  PauseCircle,
  PlayCircle,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { ActivityScreen } from "./activity/ActivityScreen";
import { AgendaScreen } from "./agenda/AgendaScreen";
import { FunnelScreen } from "./funnel/FunnelScreen";
import { AgentsScreen } from "./agents/AgentsScreen";
import { CommunicationsScreen } from "./communications/CommunicationsScreen";
import { CostsScreen } from "./costs/CostsScreen";
import { HealthScreen } from "./health/HealthScreen";
import { InboxScreen } from "./inbox/InboxScreen";
import { OverviewScreen } from "./overview/OverviewScreen";
import { AgentRunsScreen } from "./runs/RunsScreen";
import { ReviewsScreen } from "./reviews/ReviewsScreen";
import { ExecutionStopsScreen } from "./stops/ExecutionStopsScreen";
import { TasksScreen } from "./tasks/TasksScreen";

// The screens of docs/PHASE_2C_BRIEF.md §12, in navigation order: the eight
// core screens, the optional, narrow Communications status view, Phase
// 2E.2's Saúde operacional, Phase 3A's Agenda and Phase 3B.1's Funil comercial
// (all read from the overview), and ADR 0026 §E's Fila de atendimento. Every
// one is read-only apart from the acts of Decisões, Pausas, Funil comercial
// and Fila de atendimento: no screen renders a draft or any configuration
// change, the one send is a member's own reply in the Fila de atendimento
// (SI-87), and each screen's h1 is its label.

export type ScreenId =
  | "overview"
  | "inbox"
  | "agenda"
  | "funnel"
  | "health"
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
    id: "inbox",
    label: "Fila de atendimento",
    path: "inbox",
    group: "Operação",
    icon: MessagesSquare,
  },
  {
    id: "agenda",
    label: "Agenda",
    path: "agenda",
    group: "Operação",
    icon: CalendarDays,
  },
  {
    id: "funnel",
    label: "Funil comercial",
    path: "funnel",
    group: "Operação",
    icon: Filter,
  },
  {
    id: "health",
    label: "Saúde operacional",
    path: "health",
    group: "Operação",
    icon: HeartPulse,
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
  inbox: InboxScreen,
  agenda: AgendaScreen,
  funnel: FunnelScreen,
  health: HealthScreen,
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
