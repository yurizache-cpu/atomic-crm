// Admission — the one service that turns an inbound message into Company OS
// work.
//
// It calls ops.admit_inbound_message and nothing else. The authority, the
// idempotency, the task, the assignment, the agent run request and the two
// facts all live there, in one transaction (Phase 2A migration, section 6).
// This module adds what TypeScript can, exactly as companyOs.ts does: typed
// input, fast rejection of input that can never be valid, and typed errors.
//
// WHAT IT DOES NOT DO, and must never start doing:
//   * call a model. The only path to a provider is the agent run it requests,
//     which becomes a job the runtime leases under every Phase 1D/1D.1 gate.
//   * write to the CRM. Nothing here touches public.*.
//   * send anything. There is no transport in this direction.
//
// TENANCY. `target` is the scope the CALLER is already authorised for, built
// from trusted configuration. Nothing in `message` is a tenant, a company or an
// agent, so no delivery can select one.

import type { TxClient } from "../db/types.ts";
import type {
  CommunicationTarget,
  InboundMessage,
} from "../communication/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export interface AdmitInboundMessageResult {
  readonly inboundMessageId: string;
  readonly taskId: string;
  readonly agentRunId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const PRINTABLE = /^[\x21-\x7e]{1,200}$/;
const MAX_BODY_LENGTH = 4000;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
}

function requirePrintable(value: unknown, field: string): string {
  if (typeof value !== "string" || !PRINTABLE.test(value)) {
    throw new CompanyOsError(
      "invalid_argument",
      `${field} must be 1 to 200 printable ASCII characters`,
    );
  }
  return value;
}

/**
 * Admits one inbound message and resolves to the work it became. The same
 * message admitted twice resolves to the same three ids and creates nothing a
 * second time; the same id with a different body is refused (invalid_state).
 *
 * `async`, so invalid input REJECTS the returned promise rather than throwing
 * before one exists.
 */
export async function admitInboundMessage(
  tx: TxClient,
  target: CommunicationTarget,
  message: InboundMessage,
  source: string,
): Promise<AdmitInboundMessageResult> {
  if (typeof source !== "string" || !SOURCE.test(source)) {
    throw new CompanyOsError(
      "invalid_argument",
      "source is missing or malformed",
    );
  }
  if (typeof message.body !== "string" || message.body.trim() === "") {
    throw new CompanyOsError("invalid_argument", "the message body is empty");
  }
  if (message.body.length > MAX_BODY_LENGTH) {
    throw new CompanyOsError(
      "invalid_argument",
      `the message body is longer than ${MAX_BODY_LENGTH} characters`,
    );
  }
  if (
    !(message.receivedAt instanceof Date) ||
    Number.isNaN(message.receivedAt.getTime())
  ) {
    throw new CompanyOsError("invalid_argument", "receivedAt is not a date");
  }
  if (typeof message.doNotContact !== "boolean") {
    throw new CompanyOsError(
      "invalid_argument",
      "doNotContact must be stated, because a message whose consent is unknown is not admitted on a guess",
    );
  }

  // Exactly ten positions, each read from a named field: nothing else on
  // `target` or `message` can become an argument.
  const params = [
    requireUuid(target.tenantId, "tenantId"),
    requireUuid(target.companyId, "companyId"),
    requireUuid(target.agentId, "agentId"),
    message.sourceKind,
    requirePrintable(message.externalMessageId, "externalMessageId"),
    requirePrintable(message.contactRef, "contactRef"),
    message.body,
    source,
    message.doNotContact,
    message.receivedAt,
  ] as const;

  let admitted: unknown;
  try {
    const { rows } = await tx.query<{ result: unknown }>(
      "select ops.admit_inbound_message($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as result",
      params,
    );
    admitted = rows[0]?.result;
  } catch (error) {
    throw toDomainError(error);
  }

  const record = admitted as Record<string, unknown> | undefined;
  const inboundMessageId = record?.inbound_message_id;
  const taskId = record?.task_id;
  const agentRunId = record?.agent_run_id;
  if (
    typeof inboundMessageId !== "string" ||
    typeof taskId !== "string" ||
    typeof agentRunId !== "string"
  ) {
    throw new Error("ops.admit_inbound_message returned no admission");
  }
  return Object.freeze({ inboundMessageId, taskId, agentRunId });
}
