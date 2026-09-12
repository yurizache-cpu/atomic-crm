// The first real handler. Deliberately boring.
//
// WHY THIS ONE, and why not the ingestion replay it sits next to:
//
// `public.inbound_emails` stores inbound email bodies — under the LGPD, other
// people's personal data held by a psychology clinic. Its own migration writes
// down a retention policy and then says the policy is "documented and manual"
// because "Phase 0.5 has no scheduler ... building a worker is explicitly out
// of scope". The obligation predates this phase; only the mechanism was
// missing. Phase 1B supplies the mechanism, so this handler is a real operation
// that was already specified, not a demonstration invented to make the worker
// look busy.
//
// Replaying the INGESTION was the obvious candidate and was rejected on
// evidence. Re-running an ingest means creating contacts, companies, notes and
// storage objects across `public.*`; that code is Deno and runs as
// service_role. Moving it here would mean handing the worker a service_role
// client or granting `ops_worker` broad write privileges on `public.*` — the
// two things the security baseline forbids. The retention half of the same
// ledger is expressible as ONE narrow capability; the ingestion half is not.
//
// IDEMPOTENCY. The operation is a set-based delete against a predicate, so a
// second run removes nothing the first already removed. The delete and the
// job's settlement share one transaction, so a crash between them discards
// both. Neither property is asserted here — both are tested against a real
// database.

import type { HandlerDefinition } from "../worker/handlerRegistry.ts";
import { payloadInteger, payloadObject } from "../worker/job.ts";
import { PermanentError } from "../worker/failures.ts";

export const POSTMARK_LEDGER_RETENTION_KIND = "postmark.ledger_retention";

/** Matches the window written in the ledger migration. */
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_ROW_LIMIT = 5000;

/**
 * The payload may TUNE the run. It cannot loosen it: the database floors the
 * retention window regardless of what arrives here, so this validation is a
 * clearer error message, not the security boundary.
 */
const readPositiveInteger = (
  payload: unknown,
  key: string,
  fallback: number,
): number => {
  const raw = payloadObject(payload)[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    // Retrying cannot turn "-1" into a valid number of days.
    throw new PermanentError(
      `payload.${key} must be a positive integer, received ${JSON.stringify(raw)}`,
    );
  }
  return payloadInteger(payload, key, fallback);
};

export const postmarkLedgerRetention: HandlerDefinition<"purgeInboundEmailLedger"> =
  {
    kind: POSTMARK_LEDGER_RETENTION_KIND,
    capabilities: ["purgeInboundEmailLedger"],
    async run(job, capabilities) {
      const retentionDays = readPositiveInteger(
        job.payload,
        "retention_days",
        DEFAULT_RETENTION_DAYS,
      );
      const limit = readPositiveInteger(
        job.payload,
        "limit",
        DEFAULT_ROW_LIMIT,
      );

      const purged = await capabilities.purgeInboundEmailLedger({
        retentionDays,
        limit,
      });

      // Counts and parameters only. The rows this removed were email bodies;
      // none of that belongs in a log line.
      return `purged=${purged} retention_days=${retentionDays} limit=${limit}`;
    },
  };
