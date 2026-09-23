import type {
  OutboundStatus,
  ReviewStatus,
} from "../../../../contracts/company-os-api/index.ts";
import { NEEDS_EDIT_TEXT } from "../../copy";
import { reviewStatusLabel, withheldLabel } from "../../format/ptBR";
import { outboundStatusText } from "../../format/outbound";

// How a review's status and its outbound record read (docs/PHASE_2C_BRIEF.md
// §7.5, §10). needs_edit has no follow-up path in this phase and says so; an
// review with no outbound record reads "Nenhuma resposta enviada", which is a
// fact: it never says a reply was approved, is expected or awaits a send.

export const reviewStatusText = (status: ReviewStatus): string =>
  status === "needs_edit"
    ? `${reviewStatusLabel(status)}: ${NEEDS_EDIT_TEXT}`
    : reviewStatusLabel(status);

export const NO_REPLY_SENT_TEXT = "Nenhuma resposta enviada";

export const outboundRecordText = (status: OutboundStatus | null): string =>
  status === null ? NO_REPLY_SENT_TEXT : outboundStatusText(status);

export const WITHHELD_TEXT = {
  capability_not_pinned: withheldLabel("capability_not_pinned"),
  origin_not_synthetic_or_test: withheldLabel("origin_not_synthetic_or_test"),
  contract_invalid: withheldLabel("contract_invalid"),
} as const;
