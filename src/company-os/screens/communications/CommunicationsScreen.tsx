import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  OUTBOUND_STATUSES,
  type CommunicationStatusSummary,
  type OutboundStatus,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
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
import {
  ACCEPTED_WITHOUT_SEND_LABEL,
  COMMUNICATIONS_SCOPE_NOTE,
} from "../../copy";
import { humanize } from "../../format/labels";
import { outboundStatusText } from "../../format/outbound";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";

// The optional, narrow Communications status view (docs/PHASE_2C_BRIEF.md §12,
// OD-9), over the existing communication_status read and nothing else: channel
// labels, modes and states, and counts. Not an inbox, a message list, a
// composer, a send surface or a place to enable production. Its counts are
// never labelled as messages approved or waiting to be sent (§7.5).

const CountFields = ({
  label,
  counts,
  termOf = humanize,
}: {
  label: string;
  counts: Readonly<Record<string, number | undefined>>;
  /** A key in words; a reason code or status humanized by default. */
  termOf?: (key: string) => string;
}) => {
  const entries = Object.entries(counts).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  return entries.length === 0 ? (
    <None />
  ) : (
    <Fields label={label}>
      {entries.map(([key, count]) => (
        <Field key={key} term={termOf(key)}>
          {count}
        </Field>
      ))}
    </Fields>
  );
};

const Channels = ({
  channels,
}: {
  channels: CommunicationStatusSummary["channels"];
}) =>
  channels.length === 0 ? (
    <Note>No channel is configured for this tenant.</Note>
  ) : (
    <Table aria-label="Channels">
      <TableHeader>
        <TableRow>
          <TableHead>Label</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Active</TableHead>
          <TableHead>Agent</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.map((channel) => (
          <TableRow key={channel.id}>
            <TableCell>{channel.label}</TableCell>
            <TableCell>
              <StateBadge value={channel.mode} />
            </TableCell>
            <TableCell>
              <YesNo value={channel.active} />
            </TableCell>
            <TableCell>
              <RecordLink kind="agent" id={channel.agent.id}>
                {channel.agent.name}
              </RecordLink>
            </TableCell>
            <TableCell>
              <Timestamp value={channel.updatedAt} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

/** The outbound counts in the vocabulary's order. */
const byStatusInOrder = (
  byStatus: CommunicationStatusSummary["outbound"]["byStatus"],
) =>
  Object.fromEntries(
    OUTBOUND_STATUSES.filter((status) => byStatus[status] !== undefined).map(
      (status) => [status, byStatus[status]],
    ),
  );

const CommunicationsBody = ({ data }: { data: CommunicationStatusSummary }) => (
  <>
    <Note>{COMMUNICATIONS_SCOPE_NOTE}</Note>
    <Note>{data.note}</Note>
    <Section title="Channels">
      <Channels channels={data.channels} />
    </Section>
    <Section title="Inbound today">
      <Fields label="Inbound today">
        <Field term="Admitted today">{data.inbound.admittedToday}</Field>
        <Field term="Conversations active in the last 24 hours">
          {data.conversationsActive24h}
        </Field>
      </Fields>
      <h3 className="text-sm font-medium">Refused today, by reason</h3>
      <CountFields
        label="Refused today by reason"
        counts={data.inbound.refusedTodayByReason}
      />
    </Section>
    <Section title="Outbound records">
      <h3 className="text-sm font-medium">By status</h3>
      <CountFields
        label="Outbound records by status"
        counts={byStatusInOrder(data.outbound.byStatus)}
        termOf={(status) => outboundStatusText(status as OutboundStatus)}
      />
      <h3 className="text-sm font-medium">Blocked, by reason</h3>
      <CountFields
        label="Blocked outbound records by reason"
        counts={data.outbound.blockedByReason}
      />
      <Fields label="Outbound attention">
        <Field term="Indeterminate sends open">
          {data.outbound.indeterminateOpen}
        </Field>
        <Field term={ACCEPTED_WITHOUT_SEND_LABEL}>
          {data.outbound.acceptedWithoutSend}
        </Field>
      </Fields>
    </Section>
  </>
);

export const CommunicationsScreen = () => {
  const status = useCompanyOsQuery("communication_status", {});
  return (
    <ScreenLayout
      title="Communications status"
      description="Channel states and counts for this tenant."
    >
      <QueryView query={status} what="the communications status">
        {(data) => <CommunicationsBody data={data} />}
      </QueryView>
    </ScreenLayout>
  );
};
