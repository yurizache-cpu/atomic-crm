import type {
  OutboundStatus,
  ReviewStatus,
} from "../../../../contracts/company-os-api/index.ts";
import { NEEDS_EDIT_TEXT } from "../../copy";
import { humanize } from "../../format/labels";
import { outboundStatusText } from "../../format/outbound";

// How a review's status and its outbound record read (docs/PHASE_2C_BRIEF.md
// §7.5, §10). needs_edit has no follow-up path in this phase and says so; an
// accepted review with no outbound record has "no send recorded", which is a
// fact, never "awaiting a send".

export const reviewStatusText = (status: ReviewStatus): string =>
  status === "needs_edit"
    ? `${humanize(status)}: ${NEEDS_EDIT_TEXT}`
    : humanize(status);

export const outboundRecordText = (status: OutboundStatus | null): string =>
  status === null ? "no send recorded" : outboundStatusText(status);

export const WITHHELD_TEXT = {
  capability_not_pinned: "no advice projection exists for this capability",
  origin_not_synthetic_or_test:
    "the task did not arrive through a synthetic or test origin",
  contract_invalid: "the stored proposal does not match its contract",
} as const;
