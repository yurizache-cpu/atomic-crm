import {
  CheckCircle2,
  Hourglass,
  Inbox,
  ListTodo,
  PauseCircle,
  PlayCircle,
  Wallet,
  XCircle,
} from "lucide-react";
import { Link } from "react-router";

import {
  AGENT_RUN_STATUSES,
  type OverviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  Note,
  ScreenLayout,
  Section,
  StateBadge,
} from "../../components/display";
import {
  EmptyState,
  MoneyValue,
  RelativeTime,
  StatCard,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import { LIST_PATHS } from "../../components/recordPaths";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import {
  admissionLabel,
  exactTime,
  moneyLabel,
  runStatusLabel,
  yesNoLabel,
} from "../../format/ptBR";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import {
  attentionItems,
  externalCallRows,
  failuresInWindow,
  jobKindLabel,
  uncertainInWindow,
} from "./healthModel";

// Saúde operacional (Phase 2E.2): is the Company OS working, is work backing
// up, what failed or ended uncertain, what the reviews and stops hold, and what
// it cost. Every value is the overview's operationalHealth, which the database
// builds from its own rows: it stays correct with the observability stack
// offline, and nothing here is a score. Read-only: every control is a link to
// the list that proves the number. The overview is read every 15 s while the
// tab is visible, and an answer older than two polling intervals shows every
// value as "Desconhecido".

type Data = OverviewSummary;

const HeadlineCards = ({ data, current }: { data: Data; current: boolean }) => {
  const health = data.operationalHealth;
  const failures = failuresInWindow(health);
  const uncertain = uncertainInWindow(health);
  const stops = data.stops.tenantScopedActive;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={ListTodo}
        label="Na fila"
        value={health.queue.ready}
        tone={health.queue.ready > 0 ? "blue" : "green"}
        hint={
          health.queue.scheduled > 0
            ? `Prontos para executar · mais ${health.queue.scheduled} agendados`
            : "Prontos para executar"
        }
        current={current}
      />
      <StatCard
        icon={PlayCircle}
        label="Em execução"
        value={health.queue.running}
        tone={health.queue.expiredLeases > 0 ? "red" : "blue"}
        hint={
          health.queue.expiredLeases > 0
            ? `${health.queue.expiredLeases} passaram do prazo`
            : "Trabalhos em execução agora"
        }
        current={current}
      />
      <StatCard
        icon={XCircle}
        label="Falhas recentes"
        value={failures.total}
        to={LIST_PATHS.runs}
        tone={failures.total > 0 ? "amber" : "green"}
        hint="Trabalhos, execuções, decisões e envios · 24 h"
        current={current}
      />
      <StatCard
        icon={Hourglass}
        label="Resultado incerto"
        value={uncertain.total}
        to={`${LIST_PATHS.runs}?attention=1`}
        tone={uncertain.total > 0 ? "amber" : "green"}
        hint="Execuções, decisões e envios · 24 h"
        current={current}
      />
      <StatCard
        icon={Inbox}
        label="Revisões pendentes"
        value={data.reviews.pending}
        to={LIST_PATHS.reviews}
        tone={data.reviews.pending > 0 ? "amber" : "green"}
        hint={
          data.reviews.pending > 0
            ? "Aguardando sua decisão"
            : "Nenhuma aguardando"
        }
        current={current}
      />
      <StatCard
        icon={PauseCircle}
        label="Pausas ativas"
        value={stops}
        to={LIST_PATHS.stops}
        tone={
          stops > 0 || data.platform.globalAdmissionBlocked ? "red" : "green"
        }
        hint={
          data.platform.globalAdmissionBlocked
            ? "A plataforma bloqueia novas execuções"
            : "Pausas desta empresa"
        }
        current={current}
      />
      <StatCard
        icon={Wallet}
        label="Custo hoje"
        value={moneyLabel(health.spend.chargedToday)}
        to={LIST_PATHS.costs}
        tone="gray"
        hint="Cobrado hoje, com reservas em andamento"
        current={current}
      />
    </div>
  );
};

const NeedsAttention = ({
  data,
  current,
}: {
  data: Data;
  current: boolean;
}) => {
  const items = attentionItems(data);
  return (
    <Section title="Precisa de atenção">
      {!current ? (
        <StateBadge value="unknown" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nada exige atenção agora."
          text="Nenhum prazo vencido, resultado incerto, pausa ativa ou falha nas últimas 24 h."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                to={item.to}
                className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm transition-colors hover:bg-accent/40"
              >
                <item.icon aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{item.text}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
};

const Count = ({ value, current }: { value: number; current: boolean }) =>
  current ? <>{value}</> : <StateBadge value="unknown" />;

const QueueSection = ({ data, current }: { data: Data; current: boolean }) => {
  const queue = data.operationalHealth.queue;
  return (
    <Section title="Fila e execuções">
      <Fields label="Fila e execuções">
        <Field term="Prontos para executar">
          <Count value={queue.ready} current={current} />
        </Field>
        <Field term="Agendados para depois">
          <Count value={queue.scheduled} current={current} />
        </Field>
        <Field term="Em execução agora">
          <Count value={queue.running} current={current} />
        </Field>
        <Field term="Precisam de atenção (prazo vencido)">
          <Count value={queue.expiredLeases} current={current} />
        </Field>
        <Field term="Espera do mais antigo pronto">
          {current ? (
            <RelativeTime value={queue.oldestReadyAt} empty="Nenhum na fila" />
          ) : (
            <StateBadge value="unknown" />
          )}
        </Field>
        <Field term="Concluídos nas últimas 24 h">
          <Count value={queue.succeededInWindow} current={current} />
        </Field>
        <Field term="Falharam nas últimas 24 h">
          <Count value={queue.failedInWindow} current={current} />
        </Field>
      </Fields>
      <Note>
        A espera é mostrada como ela é: não há um prazo aprovado para julgá-la.
      </Note>
      {current ? (
        <TechnicalDetails
          rows={[
            ...(queue.oldestReadyAt === null
              ? []
              : ([["oldestReadyAt", exactTime(queue.oldestReadyAt)]] as const)),
          ]}
        >
          <table className="mt-2 w-full text-left">
            <caption className="sr-only">Trabalhos por tipo</caption>
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-3 font-normal">Tipo</th>
                <th className="py-1 pr-3 font-normal">Prontos</th>
                <th className="py-1 pr-3 font-normal">Agendados</th>
                <th className="py-1 pr-3 font-normal">Em execução</th>
                <th className="py-1 pr-3 font-normal">Prazo vencido</th>
                <th className="py-1 pr-3 font-normal">Concluídos 24 h</th>
                <th className="py-1 font-normal">Falharam 24 h</th>
              </tr>
            </thead>
            <tbody>
              {data.operationalHealth.queueByKind.map((row) => (
                <tr key={row.kind} className="border-t">
                  <td className="py-1 pr-3">
                    {jobKindLabel(row.kind)}
                    <span className="block font-mono text-muted-foreground">
                      {row.kind}
                    </span>
                  </td>
                  <td className="py-1 pr-3">{row.ready}</td>
                  <td className="py-1 pr-3">{row.scheduled}</td>
                  <td className="py-1 pr-3">{row.running}</td>
                  <td className="py-1 pr-3">{row.expiredLeases}</td>
                  <td className="py-1 pr-3">{row.succeededInWindow}</td>
                  <td className="py-1">{row.failedInWindow}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.operationalHealth.queueByKind.length === 0 ? (
            <p className="mt-2 text-muted-foreground">
              Nenhum trabalho vivo ou concluído nas últimas 24 h.
            </p>
          ) : null}
        </TechnicalDetails>
      ) : null}
    </Section>
  );
};

const LatencyValue = ({
  value,
  minimum,
  current,
}: {
  value: number | null;
  minimum: number;
  current: boolean;
}) => {
  if (!current) return <StateBadge value="unknown" />;
  if (value === null) {
    return (
      <span className="text-muted-foreground">{`Aparece a partir de ${minimum} amostras`}</span>
    );
  }
  return <>{`${value} ms`}</>;
};

const AgentsSection = ({ data, current }: { data: Data; current: boolean }) => {
  const runs = data.operationalHealth.agentRuns;
  const statuses = AGENT_RUN_STATUSES.filter(
    (status) => (runs.inWindowByStatus[status] ?? 0) > 0,
  );
  return (
    <Section title="Agentes">
      <Fields label="Execuções de agente nas últimas 24 h">
        {statuses.length === 0 ? (
          <Field term="Execuções nas últimas 24 h">
            <Count value={0} current={current} />
          </Field>
        ) : (
          statuses.map((status) => (
            <Field key={status} term={runStatusLabel(status)}>
              <Count
                value={runs.inWindowByStatus[status] ?? 0}
                current={current}
              />
            </Field>
          ))
        )}
      </Fields>
      <Fields label="Tempo de resposta do modelo">
        <Field term="Amostras (24 h)">
          <Count value={runs.latency.sampleSize} current={current} />
        </Field>
        <Field term="Mediana (p50)">
          <LatencyValue
            value={runs.latency.p50Ms}
            minimum={runs.latency.minSamplesP50}
            current={current}
          />
        </Field>
        <Field term="Percentil 95 (p95)">
          <LatencyValue
            value={runs.latency.p95Ms}
            minimum={runs.latency.minSamplesP95}
            current={current}
          />
        </Field>
      </Fields>
    </Section>
  );
};

const ExternalCallsSection = ({
  data,
  current,
}: {
  data: Data;
  current: boolean;
}) => (
  <Section title="Chamadas externas">
    <Note>
      O resultado registrado de cada trabalho que chama um serviço fora do
      Company OS, nas últimas 24 h. “Resultado incerto”: a chamada pode ter
      acontecido ou não, e nada a repete automaticamente.
    </Note>
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Chamadas externas nas últimas 24 h
        </caption>
        <thead>
          <tr className="text-muted-foreground">
            <th className="py-1 pr-3 font-normal">Serviço</th>
            <th className="py-1 pr-3 font-normal">Concluídas</th>
            <th className="py-1 pr-3 font-normal">Falharam</th>
            <th className="py-1 pr-3 font-normal">Resultado incerto</th>
            <th className="py-1 font-normal">Aguardando ou em andamento</th>
          </tr>
        </thead>
        <tbody>
          {externalCallRows(data.operationalHealth).map((row) => (
            <tr key={row.label} className="border-t">
              <th scope="row" className="py-1 pr-3 font-normal">
                {row.label}
              </th>
              <td className="py-1 pr-3">
                <Count value={row.done} current={current} />
              </td>
              <td className="py-1 pr-3">
                <Count value={row.failed} current={current} />
              </td>
              <td className="py-1 pr-3">
                <Count value={row.uncertain} current={current} />
              </td>
              <td className="py-1">
                <Count value={row.inProgress} current={current} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Section>
);

const DecisionsSection = ({
  data,
  current,
}: {
  data: Data;
  current: boolean;
}) => {
  const decisions = data.operationalHealth.decisions;
  return (
    <Section title="Decisões em sombra">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="blue" label="Modo sombra" />
        <span className="text-sm text-muted-foreground">
          Recomendações apenas: nenhuma decisão é tomada automaticamente.
        </span>
      </div>
      <Fields label="Avaliações pedidas nas últimas 24 h">
        <Field term="Com recomendação">
          <Count value={decisions.inWindow.completed} current={current} />
        </Field>
        <Field term="Abstenções">
          <Count value={decisions.inWindow.abstained} current={current} />
        </Field>
        <Field term="Respostas inválidas">
          <Count value={decisions.inWindow.invalid} current={current} />
        </Field>
        <Field term="Falharam">
          <Count value={decisions.inWindow.failed} current={current} />
        </Field>
        <Field term="Resultado incerto">
          <Count value={decisions.inWindow.indeterminate} current={current} />
        </Field>
        <Field term="Recusadas antes de perguntar">
          <Count value={decisions.inWindow.refused} current={current} />
        </Field>
        <Field term="Aguardando agora">
          <Count value={decisions.pendingNow} current={current} />
        </Field>
      </Fields>
    </Section>
  );
};

const GovernanceSection = ({
  data,
  current,
}: {
  data: Data;
  current: boolean;
}) => (
  <Section title="Governança">
    <Fields label="Governança">
      <Field term="Pausas ativas desta empresa">
        <Count value={data.stops.tenantScopedActive} current={current} />
      </Field>
      <Field term="Plataforma bloqueando novas execuções">
        {current ? (
          yesNoLabel(data.platform.globalAdmissionBlocked)
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
      <Field term="Novas execuções desta empresa">
        {current ? (
          <StateBadge
            value={data.admission.tenantAdmission}
            label={admissionLabel(data.admission.tenantAdmission)}
          />
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
      <Field term="Revisões aguardando decisão">
        <Count value={data.reviews.pending} current={current} />
      </Field>
      <Field term="A mais antiga espera desde">
        {current ? (
          <RelativeTime
            value={data.reviews.oldestPendingAt}
            empty="Nenhuma aguardando"
          />
        ) : (
          <StateBadge value="unknown" />
        )}
      </Field>
    </Fields>
  </Section>
);

const CostsSection = ({ data, current }: { data: Data; current: boolean }) => {
  const spend = data.operationalHealth.spend;
  const money = (value: typeof spend.chargedToday) =>
    current ? <MoneyValue value={value} /> : <StateBadge value="unknown" />;
  return (
    <Section title="Custos">
      <Fields label="Custos">
        <Field term="Hoje (dia do orçamento)">
          {money(spend.chargedToday)}
        </Field>
        <Field term="Últimas 24 h">{money(spend.chargedInWindow)}</Field>
        <Field term="Últimos 7 dias">{money(spend.chargedLast7Days)}</Field>
        <Field term="Reservado por execuções em andamento">
          {money(spend.reservedInFlight)}
        </Field>
      </Fields>
      <Note>
        Valores cobrados, com a reserva das execuções em andamento incluída. O
        valor exato, em micros, fica no título de cada valor.
      </Note>
    </Section>
  );
};

const HealthBody = ({
  data,
  receivedAt,
}: {
  data: Data;
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
      <NeedsAttention data={data} current={current} />
      <div className="grid gap-6 lg:grid-cols-2">
        <QueueSection data={data} current={current} />
        <AgentsSection data={data} current={current} />
      </div>
      <ExternalCallsSection data={data} current={current} />
      <div className="grid gap-6 lg:grid-cols-3">
        <DecisionsSection data={data} current={current} />
        <GovernanceSection data={data} current={current} />
        <CostsSection data={data} current={current} />
      </div>
      <p className="text-xs text-muted-foreground">
        Dados do próprio Company OS, não da telemetria. Atualizado{" "}
        <RelativeTime value={data.asOf} />
      </p>
    </>
  );
};

export const HealthScreen = () => {
  const overview = useCompanyOsQuery("overview", {}, { poll: true });
  return (
    <ScreenLayout
      title="Saúde operacional"
      description="Veja filas, execuções, falhas, custos e bloqueios do Company OS."
    >
      <QueryView query={overview} what="a saúde operacional">
        {(data) => (
          <HealthBody data={data} receivedAt={overview.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};
