import {
  AlarmClock,
  CircleSlash,
  Filter,
  Sparkles,
  Trophy,
  TrendingUp,
  UserX,
  Users,
} from "lucide-react";

import type {
  AvailableFunnel,
  CommercialFunnel,
  FunnelStage,
  OpportunityCard,
  OverviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import { Note, ScreenLayout, Section } from "../../components/display";
import {
  EmptyState,
  OwnerCard,
  RelativeTime,
  StatCard,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import {
  amountText,
  closingRate,
  coverageText,
  localDate,
  localDateTime,
  movementText,
  nextActionText,
  opportunityLabel,
  originCountLabel,
  originText,
  shownOf,
  stageAgeText,
  stageLabeller,
} from "./funnelModel";

// Funil comercial (Phase 3B.1): where the opportunities are, which need a
// commercial action, what closed recently and where leads come from. Every
// value is the overview's funnel, which the database reads from the local CRM
// (the commercial source of truth) through one adapter. READ ONLY: nothing here
// creates, moves, wins or loses an opportunity. The cards are articles, not
// controls, and nothing can be dragged. An opportunity is its CRM reference,
// never a name. The overview is read every 15 s while the tab is visible, and
// an answer older than two polling intervals shows every value as
// "Desconhecido".

const SummaryCards = ({
  funnel,
  current,
}: {
  funnel: AvailableFunnel;
  current: boolean;
}) => {
  const { summary } = funnel;
  const rate = closingRate(summary);
  const days = summary.windowDays;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={Users}
        label="Em andamento"
        value={summary.active}
        hint="Oportunidades abertas"
        current={current}
      />
      <StatCard
        icon={Sparkles}
        label={`Novas nos últimos ${days} dias`}
        value={summary.newDeals}
        hint="Criadas no CRM"
        current={current}
      />
      <StatCard
        icon={Trophy}
        label={`Convertidas nos últimos ${days} dias`}
        value={summary.converted}
        tone="green"
        hint="Pela data de conversão"
        current={current}
      />
      <StatCard
        icon={UserX}
        label={`Perdidas nos últimos ${days} dias`}
        value={summary.lost}
        hint="Pela data de perda"
        current={current}
      />
      <StatCard
        icon={TrendingUp}
        label={`Taxa de fechamento — ${days} dias`}
        value={rate.value}
        hint={rate.hint}
        current={current}
      />
      <StatCard
        icon={AlarmClock}
        label="Próxima ação atrasada"
        value={summary.overdue}
        tone={summary.overdue > 0 ? "red" : "gray"}
        hint={
          summary.dueToday > 0 ? `${summary.dueToday} para hoje` : undefined
        }
        current={current}
      />
      <StatCard
        icon={CircleSlash}
        label="Sem próxima ação"
        value={summary.noNextAction}
        tone={summary.noNextAction > 0 ? "amber" : "gray"}
        hint="Oportunidades abertas sem ação marcada"
        current={current}
      />
    </div>
  );
};

const OpportunityTile = ({
  card,
  funnel,
}: {
  card: OpportunityCard;
  funnel: AvailableFunnel;
}) => {
  const next = nextActionText(card, funnel.timezone);
  return (
    <OwnerCard label={opportunityLabel(card.dealRef)} className="p-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">
            {opportunityLabel(card.dealRef)}
          </span>
          <span className="text-xs text-muted-foreground">
            {stageAgeText(card.stageAgeDays)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {card.outcome === "converted" ? (
            <StatusChip tone="green" label="Convertida" />
          ) : (
            <StatusChip tone={next.tone} label={next.label} />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Origem: {originText(card.origin)}
        </p>
        {card.amount === null ? null : (
          <p className="text-xs text-muted-foreground">
            Valor informado: {amountText(card.amount, funnel.currency)}
          </p>
        )}
      </div>
    </OwnerCard>
  );
};

const StageColumn = ({
  title,
  total,
  cards,
  funnel,
  amountTotal,
  amountCount,
}: {
  title: string;
  total: number;
  cards: readonly OpportunityCard[];
  funnel: AvailableFunnel;
  amountTotal: number | null;
  amountCount: number;
}) => {
  const more = shownOf(cards.length, total);
  return (
    <section
      aria-label={`${title}: ${total}`}
      className="flex w-64 shrink-0 flex-col gap-2 rounded-xl border bg-muted/30 p-3"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium">
          {total}
        </span>
      </header>
      {amountCount > 0 && amountTotal !== null ? (
        <p className="text-xs text-muted-foreground">
          Valor informado: {amountText(amountTotal, funnel.currency)}
        </p>
      ) : null}
      {cards.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma oportunidade.</p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label={`Oportunidades em ${title}`}
        >
          {cards.map((card) => (
            <li key={card.dealRef}>
              <OpportunityTile card={card} funnel={funnel} />
            </li>
          ))}
        </ul>
      )}
      {more === null ? null : (
        <p className="text-xs text-muted-foreground">{more}</p>
      )}
    </section>
  );
};

const Board = ({ funnel }: { funnel: AvailableFunnel }) => (
  <Section title="Etapas do funil">
    <div
      role="group"
      aria-label="Quadro do funil"
      className="flex gap-3 overflow-x-auto pb-2"
    >
      {funnel.stages.map((stage: FunnelStage) => (
        <StageColumn
          key={stage.code}
          title={stage.label}
          total={stage.total}
          cards={stage.cards}
          funnel={funnel}
          amountTotal={stage.amountTotal}
          amountCount={stage.amountCount}
        />
      ))}
      {funnel.unconfigured.total > 0 ? (
        <StageColumn
          title="Etapa não configurada"
          total={funnel.unconfigured.total}
          cards={funnel.unconfigured.cards}
          funnel={funnel}
          amountTotal={null}
          amountCount={0}
        />
      ) : null}
    </div>
    <Note>
      Somente leitura: criar, mover, converter ou perder oportunidades acontece
      no CRM. O tempo na etapa conta desde a entrada na etapa atual.
    </Note>
  </Section>
);

const AttentionList = ({
  title,
  list,
  funnel,
  empty,
  describe,
}: {
  title: string;
  list: AvailableFunnel["attention"]["overdue"];
  funnel: AvailableFunnel;
  empty: string;
  describe: (card: OpportunityCard) => string;
}) => {
  const label = stageLabeller(funnel);
  const more = shownOf(list.items.length, list.total);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        {title} ({list.total})
      </h3>
      {list.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm" aria-label={title}>
          {list.items.map((card) => (
            <li key={card.dealRef}>
              <span className="font-medium">
                {opportunityLabel(card.dealRef)}
              </span>
              {" · "}
              {label(card.stage)}
              {" · "}
              {describe(card)}
            </li>
          ))}
        </ul>
      )}
      {more === null ? null : (
        <p className="text-xs text-muted-foreground">{more}</p>
      )}
    </div>
  );
};

const Attention = ({ funnel }: { funnel: AvailableFunnel }) => (
  <Section title="Precisa de atenção">
    <div className="grid gap-6 md:grid-cols-2">
      <AttentionList
        title="Próximas ações atrasadas"
        list={funnel.attention.overdue}
        funnel={funnel}
        empty="Nenhuma próxima ação atrasada."
        describe={(card) =>
          card.nextActionAt === null
            ? ""
            : `prevista para ${localDateTime(card.nextActionAt, funnel.timezone)}`
        }
      />
      <AttentionList
        title="Sem próxima ação"
        list={funnel.attention.noNextAction}
        funnel={funnel}
        empty="Todas as oportunidades abertas têm uma próxima ação."
        describe={(card) =>
          `${stageAgeText(card.stageAgeDays).toLowerCase()} nesta etapa`
        }
      />
    </div>
  </Section>
);

const Movements = ({ funnel }: { funnel: AvailableFunnel }) => {
  const label = stageLabeller(funnel);
  const { movements } = funnel;
  return (
    <Section title="Movimentações recentes">
      <Note>{coverageText(movements, funnel.timezone)}</Note>
      {movements.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma movimentação nos últimos {movements.windowDays} dias.
        </p>
      ) : (
        <>
          <ul
            className="flex flex-col gap-1 text-sm"
            aria-label="Movimentações recentes"
          >
            {movements.items.map((m, index) => (
              <li key={`${m.dealRef}-${m.at}-${index}`}>
                <span className="font-medium">
                  {opportunityLabel(m.dealRef)}
                </span>
                {": "}
                {movementText(m, label)}
                {" · "}
                <RelativeTime value={m.at} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {movements.totalInWindow} movimentaç
            {movements.totalInWindow === 1 ? "ão" : "ões"} nos últimos{" "}
            {movements.windowDays} dias.
          </p>
        </>
      )}
    </Section>
  );
};

const Origins = ({ funnel }: { funnel: AvailableFunnel }) => {
  const { origins } = funnel;
  return (
    <Section title="Origem das oportunidades">
      <p className="text-sm text-muted-foreground">
        Oportunidades criadas nos últimos {origins.windowDays} dias:{" "}
        {origins.total}
      </p>
      {origins.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nenhuma oportunidade criada no período.
        </p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label="Origem das oportunidades"
        >
          {origins.items.map((item) => (
            <li key={`${item.kind}-${item.label ?? ""}`} className="text-sm">
              <div className="flex justify-between gap-2">
                <span>{originCountLabel(item)}</span>
                <span className="font-medium">{item.count}</span>
              </div>
              <div
                aria-hidden
                className="mt-1 h-1.5 rounded-full bg-sky-500/70"
                style={{
                  width: `${Math.max(4, Math.round((item.count / Math.max(1, origins.total)) * 100))}%`,
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <Note>
        A origem é a registrada no contato da oportunidade no CRM, sem nenhuma
        dedução. Com mais de um contato ou mais de uma origem registrada, conta
        como &quot;Várias origens&quot;.
      </Note>
    </Section>
  );
};

const Outcomes = ({ funnel }: { funnel: AvailableFunnel }) => {
  const label = stageLabeller(funnel);
  const { outcomes, summary } = funnel;
  return (
    <Section title="Resultados recentes">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            Convertidas nos últimos {outcomes.windowDays} dias (
            {summary.converted})
          </h3>
          {outcomes.converted.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma conversão no período.
            </p>
          ) : (
            <ul
              className="flex flex-col gap-1 text-sm"
              aria-label="Convertidas"
            >
              {outcomes.converted.items.map((o) => (
                <li key={o.dealRef}>
                  <span className="font-medium">
                    {opportunityLabel(o.dealRef)}
                  </span>
                  {" · "}
                  {localDate(o.at, funnel.timezone)}
                  {o.amount === null
                    ? null
                    : ` · Valor informado: ${amountText(o.amount, funnel.currency)}`}
                  {` · Origem: ${originText(o.origin)}`}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            Perdidas nos últimos {outcomes.windowDays} dias ({summary.lost})
          </h3>
          {outcomes.lost.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma perda no período.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" aria-label="Perdidas">
              {outcomes.lost.items.map((o) => (
                <li key={o.dealRef}>
                  <span className="font-medium">
                    {opportunityLabel(o.dealRef)}
                  </span>
                  {" · "}
                  {localDate(o.at, funnel.timezone)}
                  {` · Motivo: ${o.reason ?? "não informado"}`}
                  {` · Etapa: ${label(o.stage)}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {summary.conflicting > 0 ? (
        <Note>
          {summary.conflicting} oportunidade
          {summary.conflicting === 1 ? " tem" : "s têm"} conversão e perda
          registradas no período e não entra
          {summary.conflicting === 1 ? "" : "m"} em nenhuma contagem.
        </Note>
      ) : null}
      {summary.convertedUndated > 0 ? (
        <Note>
          {summary.convertedUndated} oportunidade
          {summary.convertedUndated === 1 ? " está" : "s estão"} em etapa de
          conversão sem data de conversão e não entra
          {summary.convertedUndated === 1 ? "" : "m"} nas contagens do período.
        </Note>
      ) : null}
      <Note>
        Valor informado é o valor registrado na oportunidade, não um pagamento
        recebido.
      </Note>
    </Section>
  );
};

const NOT_AVAILABLE: Readonly<
  Record<Exclude<CommercialFunnel["status"], "available">, string>
> = {
  not_configured:
    "Esta empresa não tem um CRM local ligado ao Company OS, por isso não há funil para mostrar.",
  stages_not_configured:
    "As etapas do funil ainda não foram salvas no CRM. Abra as Configurações do CRM e salve as etapas para que o funil apareça aqui.",
};

const Unavailable = ({ funnel }: { funnel: CommercialFunnel }) => {
  if (funnel.status === "available") return null;
  const invalid =
    funnel.status === "stages_not_configured" && funnel.reason === "invalid";
  return (
    <EmptyState
      icon={Filter}
      title={
        funnel.status === "not_configured"
          ? "Funil comercial não configurado"
          : "Etapas do funil não configuradas"
      }
      text={
        invalid
          ? "A configuração de etapas salva no CRM está incompleta ou inválida. Revise e salve as etapas nas Configurações do CRM."
          : NOT_AVAILABLE[funnel.status]
      }
    />
  );
};

const FunnelBody = ({
  data,
  receivedAt,
}: {
  data: OverviewSummary;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  const funnel = data.funnel;
  if (funnel.status !== "available") return <Unavailable funnel={funnel} />;
  return (
    <>
      {current ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <SummaryCards funnel={funnel} current={current} />
      {current ? (
        <>
          <Board funnel={funnel} />
          <Attention funnel={funnel} />
          <Movements funnel={funnel} />
          <div className="grid gap-6 lg:grid-cols-2">
            <Origins funnel={funnel} />
            <Outcomes funnel={funnel} />
          </div>
          <TechnicalDetails
            rows={[
              ['Fuso usado para "hoje"', funnel.timezone],
              [
                "Fuso configurado",
                funnel.timezoneConfigured ? "Sim" : "Não (UTC)",
              ],
              [
                "Taxa de fechamento",
                `Convertidas ÷ (convertidas + perdidas), com data nos últimos ${funnel.summary.windowDays} dias`,
              ],
              ["Cartões por etapa", `Até ${funnel.perStageCap}`],
            ]}
          />
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Dados do CRM local, lidos pelo Company OS. Somente leitura. Atualizado{" "}
        <RelativeTime value={data.asOf} />
      </p>
    </>
  );
};

export const FunnelScreen = () => {
  const overview = useCompanyOsQuery("overview", {}, { poll: true });
  return (
    <ScreenLayout
      title="Funil comercial"
      description="Acompanhe em que etapa estão as oportunidades e onde é preciso agir."
    >
      <QueryView query={overview} what="o funil comercial">
        {(data) => (
          <FunnelBody data={data} receivedAt={overview.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};
