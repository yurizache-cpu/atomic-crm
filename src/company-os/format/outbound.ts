import type { OutboundStatus } from "../../../contracts/company-os-api/index.ts";
import { OUTBOUND_AUTHORIZED_TEXT } from "../copy";
import { outboundStatusLabel } from "./ptBR";

/**
 * An outbound record's status in words (docs/PHASE_2C_BRIEF.md §7.5). The
 * `authorized` state is written by an operator's CLI send request
 * (ops.request_outbound_send), never by a review decision, so it never reads
 * as a bare "authorized", which a person could take for "the acceptance
 * authorized a send": it names the act that authorized it.
 */
export const outboundStatusText = (status: OutboundStatus): string =>
  status === "authorized"
    ? OUTBOUND_AUTHORIZED_TEXT
    : outboundStatusLabel(status);
