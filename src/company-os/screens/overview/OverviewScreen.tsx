import {
  AlertTriangle,
  Bot,
  Inbox,
  PauseCircle,
  PlayCircle,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";

import {
  AGENT_RUN_STATUSES,
  OUTBOUND_STATUSES,
  type AgentSummary,
  type OverviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { EventTable } from "../../components/EventTable";
import {
  Field,
  Fields,
  Note,
  ScreenLayout,
  Section,
  StateBadge,
} from "../../components/display";
import { MoneyValue, RelativeTime, StatCard } from "../../components/owner";
import { PagesView, QueryView } from "../../components/queryStates";
import { LIST_PATHS } from "../../components/recordPaths";
import {
  ACCEPTED_WITHOUT_SEND_LABEL,
  OVERVIEW_PROOF_NOTE,
  PLATFORM_ADMISSION_LABEL,
  STATE_UNKNOWN_NOTE,
} from "../../copy";
import { admissionLabel, runStatusLabel, yesNoLabel } from "../../format/ptBR";
import { outboundStatusText } from "../../format/outbound";
import { itemsOf, useCompanyOsPages } from "../../query/useCompanyOsPages";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { AgentCard } from "../agents/AgentCard";

// Screen 1, Visão geral (docs/PHASE_2C_BRIEF.md §12): what is happening in the
// company now. Headline cards first, then what needs the owner's attention, the
// team, recent activity, and every count the server computed, each a link to
// the list that proves it. The overview is read every 15 s while the tab is
// visible, and an answer older than two polling intervals shows every value as
// "Desconhecido" (§10). No value is invented: each comes from one of the
// read projections. The accepted reviews with no send recorded are a count,
// never "awaiting a send" (§7.5).
//
// Some lists cannot yet narrow to exactly what their count counts: list_runs
// has no date filter, and neither list_tasks nor list_reviews selects by
// outbound record. Each such count says beside its link what the list shows.

const withParam = (path: string, name: string, value: string) =>
  `${path}?${new URLSearchParams({ [name]: value }).toString()}`;

/** One count as a link to its list; "Desconhecido" when the answer is too old. */
const CountLink = ({
  label,
  count,
  to,
  current,
  listShows,
}: {
  label: string;
  count: number;
  to: string;
  current: boolean;
  listShows?: string;
}) => {
  const scope = listShows === undefined ? "" : ` (${listShows})`;
  return (
    <Field term={label}>
      {current ? (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <Link
            to={to}
            aria-label={`${label}: ${count}${scope}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {count}
          </Link>
          {listShows === undefined ? null : (
            <span className="text-xs text-muted-foreground">{`(${listShows})`}</span>
          )}
        </span>
      ) : (
        <StateBadge value="unknown" />
      )}
    </Field>
  );
};

const TASK_PIPELINE_LIST =
  "a lista mostra todas as tarefas: veja as etapas de cada tarefa";

const HeadlineCards = ({
  data,
  current,
}: {
  data: OverviewSummary;
  current: boolean;
}) => {
  const spend = useCompanyOsQuery("spend_summary", {});
  const tenantRow = spend.data?.tenantRows.find(
    (row) => row.scope === "tenant",
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard
        icon={Bot}
        label="Agentes na equipe"
        value={data.agents.total}
        to={LIST_PATHS.agents}
        tone="green"
        hint={`${data.agents.inactive} inativos · ${data.agents.stopped} pausados`}
        current={current}
      />
      <StatCard
        icon={PlayCircle}
        label="Trabalhando agora"
        value={data.runs.workingNow}
        to={withParam(LIST_PATHS.agents, "activity", "working")}
        tone="blue"
        hint="Execuções com trabalho em andamento"
        current={current}
      />
      <StatCard
        icon={Inbox}
        label="Decisões pendentes"
        value={data.reviews.pending}
        to={LIST_PATHS.reviews}
        tone={data.reviews.pending > 0 ? "amber" : "green"}
        hint={
          data.reviews.oldestPendingAt === null
            ? "Nenhuma aguardando"
            : "Aguardando sua revisão"
        }
        current={current}
      />
      <StatCard
        icon={AlertTriangle}
        label="Execuções que precisam de atenção"
        value={data.runs.needingAttention}
        to={withParam(LIST_PATHS.runs, "attention", "1")}
        tone={data.runs.needingAttention > 0 ? "amber" : "green"}
        current={current}
      />
      <StatCard
        icon={PauseCircle}
        label="Pausas ativas"
        value={data.stops.tenantScopedActive}
        to={LIST_PATHS.stops}
        tone={data.stops.tenantScopedActive > 0 ? "red" : "green"}
        current={current}
      />
      <Link
        to={LIST_PATHS.costs}
        aria-label="Custo de hoje"
        className="block rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent/40"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Custo de hoje</span>
          <span className="rounded-lg border border-border bg-muted p-2 text-muted-foreground">
            <Wallet aria-hidden className="size-4" />
          </span>
        </div>
        <div className="mt-2 text-3xl font-semibold tracking-tight">
          {tenantRow === undefined ? (
            "—"
          ) : (
            <MoneyValue value={tenantRow.charged} />
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {tenantRow === undefined
            ? "Sem orçamento diário configurado"
            : "Cobrado hoje pela empresa"}
        </p>
      </Link>
    </div>
  );
};

interface AttentionItem {
  readonly icon: LucideIcon;
  readonly text: string;
  readonly to: string;
}

const attentionItems = (data: OverviewSummary): AttentionItem[] => {
  const items: AttentionItem[] = [];
  const plural = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;
  if (data.reviews.pending > 0) {
    items.push({
      icon: Inbox,
      text: `${plural(data.reviews.pending, "decisão aguardando", "decisões aguardando")} revisão`,
      to: LIST_PATHS.reviews,
    });
  }
  if (data.agents.stopped > 0) {
    items.push({
      icon: PauseCircle,
      text: plural(data.agents.stopped, "agente pausado", "agentes pausados"),
      to: withParam(LIST_PATHS.agents, "availability", "stopped"),
    });
  }
  if (data.runs.needingAttention > 0) {
    items.push({
      icon: AlertTriangle,
      text:
        plural(
          data.runs.needingAttention,
          "execução precisa",
          "execuções precisam",
        ) + " de atenção",
      to: withParam(LIST_PATHS.runs, "attention", "1"),
    });
  }
  if (data.agents.stale > 0) {
    items.push({
      icon: AlertTriangle,
      text:
        plural(data.agents.stale, "agente sem sinal", "agentes sem sinal") +
        " do trabalho",
      to: withParam(LIST_PATHS.agents, "activity", "stale"),
    });
  }
  if (data.outbound.indeterminateOpen > 0) {
    items.push({
      icon: AlertTriangle,
      text: plural(
        data.outbound.indeterminateOpen,
        "envio incerto",
        "envios incertos",
      ),
      to: LIST_PATHS.tasks,
    });
  }
  if (data.platform.globalAdmissionBlocked) {
    items.push({
      icon: PauseCircle,
      text: "A plataforma está bloqueando novas execuções",
      to: LIST_PATHS.costs,
    });
  }
  return items;
};

const NeedsAttention = ({
  data,
  current,
}: {
  data: OverviewSummary;
  current: boolean;
}) => {
  const items = current ? attentionItems(data) : [];
  return (
    <Section title="Precisa da sua atenção">
      {!current ? (
        <Note>Desconhecido: aguardando uma resposta nova.</Note>
      ) : items.length === 0 ? (
        <Note>Nada precisa da sua atenção agora.</Note>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.text}>
              <Link
                to={item.to}
                className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm hover:bg-amber-500/10"
              >
                <item.icon aria-hidden className="size-4 text-amber-600" />
                {item.text}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const Team = () => {
  const agents = useCompanyOsQuery("list_agents", {}, { poll: true });
  const current = useIsStateCurrent(agents.dataUpdatedAt);
  return (
    <Section title="Equipe">
      <QueryView query={agents} what="a equipe">
        {(data) => (
          <div className="grid gap-4 md:grid-cols-2">
            {data.items.slice(0, 6).map((agent: AgentSummary) => (
              <AgentCard key={agent.id} agent={agent} current={current} />
            ))}
          </div>
        )}
      </QueryView>
    </Section>
  );
};

const RecentActivity = () => {
  const events = useCompanyOsPages("list_events", {});
  return (
    <Section title="Atividade recente">
      <PagesView query={events} what="a atividade">
        <EventTable
          events={itemsOf(events.data).slice(0, 6)}
          label="Atividade recente"
        />
        <Link
          to={LIST_PATHS.activity}
          className="text-sm font-medium text-primary hover:underline"
        >
          Ver toda a atividade
        </Link>
      </PagesView>
    </Section>
  );
};

const DetailedCounts = ({
  data,
  current,
}: {
  data: OverviewSummary;
  current: boolean;
}) => {
  const byActivity = (activity: string) =>
    withParam(LIST_PATHS.agents, "activity", activity);
  const byAvailability = (availability: string) =>
    withParam(LIST_PATHS.agents, "availability", availability);
  const runStatuses = AGENT_RUN_STATUSES.filter(
    (s) => data.runs.todayByStatus[s] !== undefined,
  );
  const outboundStatuses = OUTBOUND_STATUSES.filter(
    (s) => data.outbound.todayByStatus[s] !== undefined,
  );
  return (
    <Section title="Indicadores detalhados">
      <Note>{OVERVIEW_PROOF_NOTE}</Note>
      <div className="grid gap-6 lg:grid-cols-2">
        <Fields label="Agentes">
          <CountLink
            label="Agentes"
            count={data.agents.total}
            to={LIST_PATHS.agents}
            current={current}
          />
          <CountLink
            label="Trabalhando"
            count={data.agents.working}
            to={byActivity("working")}
            current={current}
          />
          <CountLink
            label="Retidos por pausa"
            count={data.agents.held}
            to={byActivity("held")}
            current={current}
          />
          <CountLink
            label="Com trabalho na fila"
            count={data.agents.queued}
            to={byActivity("queued")}
            current={current}
          />
          <CountLink
            label="Sem sinal do trabalho"
            count={data.agents.stale}
            to={byActivity("stale")}
            current={current}
          />
          <CountLink
            label="Pausados"
            count={data.agents.stopped}
            to={byAvailability("stopped")}
            current={current}
          />
          <CountLink
            label="Inativos"
            count={data.agents.inactive}
            to={byAvailability("inactive")}
            current={current}
          />
        </Fields>
        <Fields label="Execuções">
          {runStatuses.map((status) => (
            <CountLink
              key={status}
              label={`Execuções hoje: ${runStatusLabel(status)}`}
              count={data.runs.todayByStatus[status] ?? 0}
              to={withParam(LIST_PATHS.runs, "status", status)}
              current={current}
              listShows="a lista mostra execuções de todos os dias"
            />
          ))}
          <CountLink
            label="Execuções trabalhando agora"
            count={data.runs.workingNow}
            to={byActivity("working")}
            current={current}
          />
          <CountLink
            label="Execuções com atenção"
            count={data.runs.needingAttention}
            to={withParam(LIST_PATHS.runs, "attention", "1")}
            current={current}
          />
        </Fields>
        <Fields label="Decisões e pausas">
          <CountLink
            label="Decisões aguardando revisão"
            count={data.reviews.pending}
            to={LIST_PATHS.reviews}
            current={current}
          />
          <Field term="Decisão pendente mais antiga">
            {current ? (
              <RelativeTime
                value={data.reviews.oldestPendingAt}
                empty="nenhuma"
              />
            ) : (
              <StateBadge value="unknown" />
            )}
          </Field>
          <CountLink
            label="Pausas ativas desta empresa"
            count={data.stops.tenantScopedActive}
            to={LIST_PATHS.stops}
            current={current}
          />
        </Fields>
        <Fields label="Envios">
          {outboundStatuses.map((status) => (
            <CountLink
              key={status}
              label={`Envios hoje: ${outboundStatusText(status)}`}
              count={data.outbound.todayByStatus[status] ?? 0}
              to={LIST_PATHS.tasks}
              current={current}
              listShows={TASK_PIPELINE_LIST}
            />
          ))}
          <CountLink
            label="Envios incertos em aberto"
            count={data.outbound.indeterminateOpen}
            to={LIST_PATHS.tasks}
            current={current}
            listShows={TASK_PIPELINE_LIST}
          />
          <CountLink
            label={ACCEPTED_WITHOUT_SEND_LABEL}
            count={data.outbound.acceptedWithoutSend}
            to={withParam(LIST_PATHS.reviews, "status", "accepted")}
            current={current}
            listShows="a lista mostra todas as decisões aceitas: veja o envio de cada decisão"
          />
        </Fields>
        <Fields label="Admissão">
          <Field term="Novas execuções desta empresa">
            {current ? (
              <Link
                to={LIST_PATHS.costs}
                aria-label={`Novas execuções desta empresa: ${admissionLabel(data.admission.tenantAdmission)}`}
              >
                <StateBadge
                  value={data.admission.tenantAdmission}
                  label={admissionLabel(data.admission.tenantAdmission)}
                />
              </Link>
            ) : (
              <StateBadge value="unknown" />
            )}
          </Field>
          <Field term={PLATFORM_ADMISSION_LABEL}>
            {current ? (
              yesNoLabel(data.platform.globalAdmissionBlocked)
            ) : (
              <StateBadge value="unknown" />
            )}
          </Field>
        </Fields>
      </div>
      {current && runStatuses.length === 0 ? (
        <Note>Nenhuma execução foi criada hoje.</Note>
      ) : null}
    </Section>
  );
};

const OverviewBody = ({
  data,
  receivedAt,
}: {
  data: OverviewSummary;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  return (
    <>
      {current ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <HeadlineCards data={data} current={current} />
      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <NeedsAttention data={data} current={current} />
        <RecentActivity />
      </div>
      <Team />
      <DetailedCounts data={data} current={current} />
      <p className="text-xs text-muted-foreground">
        Atualizado <RelativeTime value={data.asOf} />
      </p>
    </>
  );
};

export const OverviewScreen = () => {
  const overview = useCompanyOsQuery("overview", {}, { poll: true });
  return (
    <ScreenLayout
      title="Visão geral"
      description="O que está acontecendo na sua empresa agora."
    >
      <QueryView query={overview} what="a visão geral">
        {(data) => (
          <OverviewBody data={data} receivedAt={overview.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};
