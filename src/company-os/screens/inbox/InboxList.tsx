import type { OverviewSummary } from "../../../../contracts/company-os-api/index.ts";
import { Note, ScreenLayout, Section } from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { WaitingListItems } from "../overview/WaitingListSection";
import {
  INBOX_DESCRIPTION,
  INBOX_NOT_AVAILABLE,
  INBOX_TITLE,
} from "./inboxCopy";

// The Fila de atendimento (ADR 0026 §E, SI-87): the conversations waiting for
// a person, oldest first, as the overview's waiting list reports them (no
// text, number or name). Each row opens its conversation; nothing of a
// conversation is read until then.

const InboxBody = ({
  data,
  receivedAt,
}: {
  data: OverviewSummary;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  if (data.waitingList === undefined) return <Note>{INBOX_NOT_AVAILABLE}</Note>;
  return (
    <Section title="Aguardando uma pessoa">
      {current ? (
        <WaitingListItems list={data.waitingList} asOf={data.asOf} />
      ) : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
    </Section>
  );
};

export const InboxList = () => {
  const overview = useCompanyOsQuery("overview", {}, { poll: true });
  return (
    <ScreenLayout title={INBOX_TITLE} description={INBOX_DESCRIPTION}>
      <QueryView query={overview} what="a fila de atendimento">
        {(data) => (
          <InboxBody data={data} receivedAt={overview.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};
