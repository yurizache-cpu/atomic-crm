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
    <Note>No send recorded for this task.</Note>
  ) : (
    <Fields label="Outbound record">
      <Field term="Outbound record id">
        <IdText id={outbound.id} />
      </Field>
      <Field term="Status">
        <StateBadge
          value={outbound.status}
          label={outboundStatusText(outbound.status)}
        />
      </Field>
      <Field term="Review">
        {outbound.reviewItemId === null ? (
          <None />
        ) : (
          <RecordLink kind="review" id={outbound.reviewItemId} />
        )}
      </Field>
      <Field term="Channel id">
        <IdText id={outbound.channelId} />
      </Field>
      <Field term="Blocked reason">
        <Text value={outbound.blockedReason} />
      </Field>
      <Field term="Error class">
        <Text value={outbound.errorClass} />
      </Field>
      <Field term="Provider error code">
        <Text value={outbound.errorCode} />
      </Field>
      <Field term="Send request recorded">
        <Timestamp value={outbound.authorizedAt} />
      </Field>
      <Field term="Sending since">
        <Timestamp value={outbound.sendingAt} />
      </Field>
      <Field term="Settled">
        <Timestamp value={outbound.settledAt} />
      </Field>
      <Field term="Delivered">
        <Timestamp value={outbound.deliveredAt} />
      </Field>
      <Field term="Read">
        <Timestamp value={outbound.readAt} />
      </Field>
    </Fields>
  );
