import { Gauge, PiggyBank, PlayCircle, Wallet } from "lucide-react";

import type {
  SpendSummary,
  TenantSpendRow,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Note,
  RecordLink,
  ScreenLayout,
  Section,
  StateBadge,
} from "../../components/display";
import {
  EmptyState,
  MoneyValue,
  OwnerCard,
  RelativeTime,
  StatCard,
  TechnicalDetails,
} from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import { MONEY_NOTE, PLATFORM_ADMISSION_LABEL } from "../../copy";
import {
  admissionLabel,
  exactMoney,
  moneyLabel,
  yesNoLabel,
} from "../../format/ptBR";
import { agentDisplayName } from "../../format/displayNames";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";

// Screen 8, Custos (docs/PHASE_2C_BRIEF.md §12): the tenant's and its
// companies' daily budgets, what was charged today by agent and by model, and
// the platform admission boolean only. Every amount is the server's own figure
// (§13 item 5), formatted for the owner; the exact amount stays in the
// technical details. Limits and prices change only through the operator CLI.

const exactRows = (row: TenantSpendRow): (readonly [string, string])[] => [
  ["Alcance", row.scope],
  ["Empresa", row.companyId ?? "—"],
  ["Fuso horário", row.timezone],
  ["Orçamento diário", exactMoney(row.dailyLimit)],
  ["Cobrado", exactMoney(row.charged)],
  ["Liquidado", exactMoney(row.settled)],
  ["Estimado", exactMoney(row.estimated)],
  ["Disponível", exactMoney(row.remaining)],
  ["Execuções com custo desconhecido", String(row.unknownCostRuns)],
  ["Execuções recusadas", String(row.refusedRuns)],
  ["Orçamento esgotado", row.settledExhausted ? "sim" : "não"],
  ["Admissão", row.newRunAdmission],
];

const TenantBudget = ({ row }: { row: TenantSpendRow }) => (
  <>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={Wallet}
        label="Custo hoje"
        value={moneyLabel(row.charged)}
        tone="blue"
      />
      <StatCard
        icon={PiggyBank}
        label="Orçamento diário"
        value={moneyLabel(row.dailyLimit)}
        tone="gray"
      />
      <StatCard
        icon={Gauge}
        label="Disponível"
        value={moneyLabel(row.remaining)}
        tone={row.settledExhausted ? "red" : "green"}
        hint={
          row.settledExhausted
            ? "Orçamento esgotado"
            : admissionLabel(row.newRunAdmission)
        }
      />
      <StatCard
        icon={PlayCircle}
        label="Execuções em andamento"
        value={row.runningRuns}
        tone="blue"
      />
    </div>
    <TechnicalDetails rows={exactRows(row)} />
  </>
);

const CompanyBudgets = ({ rows }: { rows: readonly TenantSpendRow[] }) => (
  <Section title="Orçamentos por empresa">
    <div className="grid gap-3 md:grid-cols-2">
      {rows.map((row) => (
        <OwnerCard key={row.companyId ?? "tenant"} label="Orçamento de empresa">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">Custo hoje</span>
            <StateBadge
              value={row.newRunAdmission}
              label={admissionLabel(row.newRunAdmission)}
            />
          </div>
          <div className="text-xl font-semibold">
            <MoneyValue value={row.charged} />
            <span className="text-sm font-normal text-muted-foreground">
              {` de ${moneyLabel(row.dailyLimit)}`}
            </span>
          </div>
          <TechnicalDetails rows={exactRows(row)} />
        </OwnerCard>
      ))}
    </div>
  </Section>
);

const ByAgent = ({ rows }: { rows: SpendSummary["today"]["byAgent"] }) => (
  <ul aria-label="Custo hoje por agente" className="flex flex-col divide-y">
    {rows.map((row) => (
      <li
        key={row.agent.id}
        className="flex items-center justify-between gap-3 py-2"
      >
        <RecordLink
          kind="agent"
          id={row.agent.id}
          label={`Agente ${agentDisplayName(row.agent.name)}`}
        >
          {agentDisplayName(row.agent.name)}
        </RecordLink>
        <span className="text-sm">
          <span className="text-muted-foreground">{`${row.runs} ${row.runs === 1 ? "execução" : "execuções"} · `}</span>
          <MoneyValue value={row.charged} />
        </span>
      </li>
    ))}
  </ul>
);

const ByModel = ({ rows }: { rows: SpendSummary["today"]["byModel"] }) => (
  <ul aria-label="Custo hoje por modelo" className="flex flex-col divide-y">
    {rows.map((row) => (
      <li
        key={`${row.provider}-${row.model ?? ""}`}
        className="flex items-center justify-between gap-3 py-2"
      >
        <span>
          <span>{row.model ?? "Modelo não informado"}</span>
          <span className="text-xs text-muted-foreground">{` · ${row.provider}`}</span>
        </span>
        <span className="text-sm">
          <span className="text-muted-foreground">{`${row.runs} ${row.runs === 1 ? "execução" : "execuções"} · `}</span>
          <MoneyValue value={row.charged} />
        </span>
      </li>
    ))}
  </ul>
);

const CostsBody = ({ data }: { data: SpendSummary }) => {
  const tenant = data.tenantRows.find((row) => row.scope === "tenant");
  const companies = data.tenantRows.filter((row) => row.scope === "company");
  return (
    <>
      {tenant === undefined ? (
        <EmptyState
          icon={Wallet}
          title="Nenhum orçamento diário configurado."
          text="Os orçamentos são definidos pelo operador."
        />
      ) : (
        <TenantBudget row={tenant} />
      )}
      {companies.length === 0 ? null : <CompanyBudgets rows={companies} />}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Custo hoje por agente">
          {data.today.byAgent.length === 0 ? (
            <Note>Nada foi cobrado hoje.</Note>
          ) : (
            <ByAgent rows={data.today.byAgent} />
          )}
        </Section>
        <Section title="Custo hoje por modelo">
          {data.today.byModel.length === 0 ? (
            <Note>Nada foi cobrado hoje.</Note>
          ) : (
            <ByModel rows={data.today.byModel} />
          )}
        </Section>
      </div>
      <Section title="Janela e plataforma">
        <p className="text-sm">
          {`${PLATFORM_ADMISSION_LABEL}: ${yesNoLabel(data.platform.globalAdmissionBlocked)}`}
        </p>
        <p className="text-sm text-muted-foreground">
          Dia de cobrança iniciado <RelativeTime value={data.windowStart} /> ·
          atualizado <RelativeTime value={data.asOf} />
        </p>
        <Note>{MONEY_NOTE}</Note>
      </Section>
    </>
  );
};

export const CostsScreen = () => {
  const spend = useCompanyOsQuery("spend_summary", {});
  return (
    <ScreenLayout
      title="Custos"
      description="Quanto sua empresa gastou hoje e quanto ainda pode gastar. Orçamentos e preços mudam apenas pelo operador."
    >
      <QueryView query={spend} what="os custos">
        {(data) => <CostsBody data={data} />}
      </QueryView>
    </ScreenLayout>
  );
};
