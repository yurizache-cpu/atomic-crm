import { AlertTriangle, MessageSquare, Radio, Users } from "lucide-react";

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
} from "../../components/display";
import {
  OwnerCard,
  RelativeTime,
  StatCard,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
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
    <Note>Nenhum canal configurado para esta empresa.</Note>
  ) : (
    <div role="list" aria-label="Canais" className="grid gap-3 md:grid-cols-2">
      {channels.map((channel) => (
        <div role="listitem" key={channel.id}>
          <OwnerCard
            label={`Canal ${channel.label}`}
            className="flex flex-col gap-2"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{channel.label}</span>
              <span className="flex gap-1">
                <StatusChip
                  tone={channel.mode === "test" ? "amber" : "blue"}
                  label={channel.mode === "test" ? "Teste" : "Produção"}
                />
                <StatusChip
                  tone={channel.active ? "green" : "gray"}
                  label={channel.active ? "Ativo" : "Inativo"}
                />
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {"Agente: "}
              <RecordLink
                kind="agent"
                id={channel.agent.id}
                label={`Agente ${channel.agent.name}`}
              >
                {channel.agent.name}
              </RecordLink>
              {" · atualizado "}
              <RelativeTime value={channel.updatedAt} />
            </span>
            <TechnicalDetails
              rows={[
                ["Canal", channel.id],
                ["Modo", channel.mode],
                ["Atualizado (UTC)", channel.updatedAt],
              ]}
            />
          </OwnerCard>
        </div>
      ))}
    </div>
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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        icon={Radio}
        label="Canais"
        value={data.channels.length}
        tone="gray"
      />
      <StatCard
        icon={MessageSquare}
        label="Recebidas hoje"
        value={data.inbound.admittedToday}
        tone="blue"
      />
      <StatCard
        icon={Users}
        label="Conversas ativas (24 h)"
        value={data.conversationsActive24h}
        tone="blue"
      />
      <StatCard
        icon={AlertTriangle}
        label="Envios incertos em aberto"
        value={data.outbound.indeterminateOpen}
        tone={data.outbound.indeterminateOpen > 0 ? "amber" : "green"}
      />
    </div>
    <Note>{COMMUNICATIONS_SCOPE_NOTE}</Note>
    <Note>
      Entregas que não chegam a um canal configurado nunca são guardadas.
    </Note>
    <TechnicalDetails rows={[["Nota do servidor", data.note]]} />
    <Section title="Canais">
      <Channels channels={data.channels} />
    </Section>
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="Recebidas hoje">
        <h3 className="text-sm font-medium">Recusadas hoje, por motivo</h3>
        <CountFields
          label="Recusadas hoje por motivo"
          counts={data.inbound.refusedTodayByReason}
        />
      </Section>
      <Section title="Envios">
        <h3 className="text-sm font-medium">Por situação</h3>
        <CountFields
          label="Envios por situação"
          counts={byStatusInOrder(data.outbound.byStatus)}
          termOf={(status) => outboundStatusText(status as OutboundStatus)}
        />
        <h3 className="text-sm font-medium">Bloqueados, por motivo</h3>
        <CountFields
          label="Envios bloqueados por motivo"
          counts={data.outbound.blockedByReason}
        />
        <Fields label="Atenção nos envios">
          <Field term={ACCEPTED_WITHOUT_SEND_LABEL}>
            {data.outbound.acceptedWithoutSend}
          </Field>
        </Fields>
      </Section>
    </div>
  </>
);

export const CommunicationsScreen = () => {
  const status = useCompanyOsQuery("communication_status", {});
  return (
    <ScreenLayout
      title="Comunicações"
      description="Canais e contagens desta empresa. Nada pode ser enviado ou alterado daqui."
    >
      <QueryView query={status} what="as comunicações">
        {(data) => <CommunicationsBody data={data} />}
      </QueryView>
    </ScreenLayout>
  );
};
