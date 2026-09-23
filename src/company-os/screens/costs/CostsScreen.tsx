import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type {
  SpendSummary,
  TenantSpendRow,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  IdText,
  MoneyText,
  None,
  Note,
  RecordLink,
  ScreenLayout,
  Section,
  StateBadge,
  Timestamp,
  YesNo,
} from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { MONEY_NOTE, PLATFORM_ADMISSION_LABEL } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";

// Screen 8, Costs / runtime governance (docs/PHASE_2C_BRIEF.md §12): the
// tenant's own budget rows and today's charged cost by agent and by model,
// every amount the server's string (all arithmetic in SQL, §13 item 5), and
// the one platform-derived boolean. Never the global ceiling, global spend,
// another tenant's limits or a price. Limits change only in the operator CLI.

const LimitRow = ({ row }: { row: TenantSpendRow }) => (
  <TableRow>
    <TableCell>{row.scope}</TableCell>
    <TableCell>
      {row.companyId === null ? <None /> : <IdText id={row.companyId} />}
    </TableCell>
    <TableCell>{row.timezone}</TableCell>
    <TableCell>
      <MoneyText value={row.dailyLimit} />
    </TableCell>
    <TableCell>
      <MoneyText value={row.charged} />
    </TableCell>
    <TableCell>
      <MoneyText value={row.settled} />
    </TableCell>
    <TableCell>
      <MoneyText value={row.estimated} />
    </TableCell>
    <TableCell>
      <MoneyText value={row.remaining} />
    </TableCell>
    <TableCell>{row.runningRuns}</TableCell>
    <TableCell>{row.unknownCostRuns}</TableCell>
    <TableCell>{row.refusedRuns}</TableCell>
    <TableCell>
      <YesNo value={row.settledExhausted} />
    </TableCell>
    <TableCell>
      <StateBadge value={row.newRunAdmission} />
    </TableCell>
  </TableRow>
);

const LimitTable = ({ rows }: { rows: readonly TenantSpendRow[] }) => (
  <Table aria-label="Daily limits">
    <TableHeader>
      <TableRow>
        <TableHead>Scope</TableHead>
        <TableHead>Company id</TableHead>
        <TableHead>Timezone</TableHead>
        <TableHead>Daily limit</TableHead>
        <TableHead>Charged</TableHead>
        <TableHead>Settled</TableHead>
        <TableHead>Estimated</TableHead>
        <TableHead>Remaining</TableHead>
        <TableHead>Running runs</TableHead>
        <TableHead>Unknown-cost runs</TableHead>
        <TableHead>Refused runs</TableHead>
        <TableHead>Settled exhausted</TableHead>
        <TableHead>New-run admission</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <LimitRow key={`${row.scope}-${row.companyId ?? "tenant"}`} row={row} />
      ))}
    </TableBody>
  </Table>
);

const ByAgent = ({ rows }: { rows: SpendSummary["today"]["byAgent"] }) => (
  <Table aria-label="Charged today by agent">
    <TableHeader>
      <TableRow>
        <TableHead>Agent</TableHead>
        <TableHead>Runs</TableHead>
        <TableHead>Charged</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={row.agent.id}>
          <TableCell>
            <RecordLink kind="agent" id={row.agent.id}>
              {row.agent.name}
            </RecordLink>
          </TableCell>
          <TableCell>{row.runs}</TableCell>
          <TableCell>
            <MoneyText value={row.charged} />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const ByModel = ({ rows }: { rows: SpendSummary["today"]["byModel"] }) => (
  <Table aria-label="Charged today by model">
    <TableHeader>
      <TableRow>
        <TableHead>Provider</TableHead>
        <TableHead>Model</TableHead>
        <TableHead>Runs</TableHead>
        <TableHead>Charged</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((row) => (
        <TableRow key={`${row.provider}-${row.model ?? ""}`}>
          <TableCell>{row.provider}</TableCell>
          <TableCell>{row.model === null ? <None /> : row.model}</TableCell>
          <TableCell>{row.runs}</TableCell>
          <TableCell>
            <MoneyText value={row.charged} />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

const CostsBody = ({ data }: { data: SpendSummary }) => (
  <>
    <Note>{MONEY_NOTE}</Note>
    <Fields label="Window">
      <Field term="Window start">
        <Timestamp value={data.windowStart} />
      </Field>
      <Field term="Server time of this answer">
        <Timestamp value={data.asOf} />
      </Field>
      <Field term={PLATFORM_ADMISSION_LABEL}>
        <YesNo value={data.platform.globalAdmissionBlocked} />
      </Field>
    </Fields>
    <Section title="Daily limits">
      {data.tenantRows.length === 0 ? (
        <Note>No tenant or company budget is configured.</Note>
      ) : (
        <LimitTable rows={data.tenantRows} />
      )}
    </Section>
    <Section title="Charged today by agent">
      {data.today.byAgent.length === 0 ? (
        <Note>Nothing was charged today.</Note>
      ) : (
        <ByAgent rows={data.today.byAgent} />
      )}
    </Section>
    <Section title="Charged today by model">
      {data.today.byModel.length === 0 ? (
        <Note>Nothing was charged today.</Note>
      ) : (
        <ByModel rows={data.today.byModel} />
      )}
    </Section>
  </>
);

export const CostsScreen = () => {
  const spend = useCompanyOsQuery("spend_summary", {});
  return (
    <ScreenLayout
      title="Costs"
      description="This tenant's budgets and today's charged cost. Limits and prices change only through the operator CLI."
    >
      <QueryView query={spend} what="the costs">
        {(data) => <CostsBody data={data} />}
      </QueryView>
    </ScreenLayout>
  );
};
