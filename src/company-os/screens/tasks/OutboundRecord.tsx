import type { OutboundSummary } from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  IdText,
  None,
  Note,
  RecordLink,
  StateBadge,
  Timestamp,
} from "../../components/display";
import { outboundStatusText } from "../../format/outbound";

// A task's single outbound record (docs/PHASE_2C_BRIEF.md §9 OutboundSummary):
// its state and times, and nothing about the recipient, the body, the draft or
// who requested the send. It records what an operator's CLI send did; the
// Company OS neither sends nor offers to.

const Text = ({ value }: { value: string | null }) =>
  value === null ? <None /> : <span>{value}</span>;

export const OutboundRecord = ({
  outbound,
}: {
  outbound: OutboundSummary | null;
}) =>
  outbound === null ? (
    <Note>Nenhum envio registrado para esta tarefa.</Note>
  ) : (
    <Fields label="Registro de envio">
      <Field term="Identificador do envio">
        <IdText id={outbound.id} />
      </Field>
      <Field term="Situação">
        <StateBadge
          value={outbound.status}
          label={outboundStatusText(outbound.status)}
        />
      </Field>
      <Field term="Revisão">
        {outbound.reviewItemId === null ? (
          <None />
        ) : (
          <RecordLink kind="review" id={outbound.reviewItemId} />
        )}
      </Field>
      <Field term="Canal">
        <IdText id={outbound.channelId} />
      </Field>
      <Field term="Motivo do bloqueio">
        <Text value={outbound.blockedReason} />
      </Field>
      <Field term="Tipo de erro">
        <Text value={outbound.errorClass} />
      </Field>
      <Field term="Código de erro do provedor">
        <Text value={outbound.errorCode} />
      </Field>
      <Field term="Pedido de envio registrado">
        <Timestamp value={outbound.authorizedAt} />
      </Field>
      <Field term="Enviando desde">
        <Timestamp value={outbound.sendingAt} />
      </Field>
      <Field term="Concluído">
        <Timestamp value={outbound.settledAt} />
      </Field>
      <Field term="Entregue">
        <Timestamp value={outbound.deliveredAt} />
      </Field>
      <Field term="Lido">
        <Timestamp value={outbound.readAt} />
      </Field>
    </Fields>
  );
