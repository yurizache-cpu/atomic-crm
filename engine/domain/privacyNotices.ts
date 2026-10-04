// ADR 0021 (decided 2026-10-04 by owner delegation): the owner's narrow, typed
// boundary over a tenant's privacy notice, ops.privacy_notices.
//
// A notice is owner data, versioned: the URL of the full notice, the short
// text the first WhatsApp reply of a conversation carries, and the lawful
// basis reference (W2). Recording a version supersedes the current one;
// nothing is deleted. The text is the tenant's own words (data, never code):
// the repository holds no notice. Each act validates before the database and
// calls exactly one function; the database still decides everything.

import type { TxClient } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "./errors.ts";

export interface PrivacyNoticeRow {
  readonly id: string;
  readonly version: string;
  readonly noticeUrl: string;
  readonly whatsappText: string;
  readonly lawfulBasisRef: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly supersededAt: string | null;
  readonly current: boolean;
}

/** The provider's 4096 holds a 2000-character draft, a blank line and this. */
export const MAX_NOTICE_TEXT_LENGTH = 1000;
export const MAX_NOTICE_URL_LENGTH = 500;
export const MAX_LISTED_NOTICES = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = /^[a-z0-9][a-z0-9_.:@-]{0,127}$/;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const BASIS = /^[a-z0-9][a-z0-9_.:+-]{0,127}$/;
const URL_TEXT = /^https:\/\/[\x21-\x7e]+$/;
// Control characters other than a line break.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x01-\x09\x0b-\x1f\x7f]/;

const invalid = (message: string): CompanyOsError =>
  new CompanyOsError("invalid_argument", message);

const UTC = (column: string): string =>
  `case when ${column} is null then null else to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end`;

const LIST_SQL = `select n.id, n.version, n.notice_url, n.whatsapp_text, n.lawful_basis_ref, n.recorded_by,
         ${UTC("n.recorded_at")} as recorded_at, ${UTC("n.superseded_at")} as superseded_at
    from ops.privacy_notices n
   where n.tenant_id = $1
   order by n.recorded_at desc, n.id
   limit $2`;

interface PrivacyNoticeRecord {
  id: string;
  version: string;
  notice_url: string;
  whatsapp_text: string;
  lawful_basis_ref: string;
  recorded_by: string;
  recorded_at: string;
  superseded_at: string | null;
}

const requireUuid = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CompanyOsError("malformed_identifier", `${field} is not a uuid`);
  }
  return value;
};

const requireMatch = (
  value: unknown,
  pattern: RegExp,
  field: string,
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw invalid(`${field} is missing or malformed`);
  }
  return value;
};

/** The notice text as the table holds it: 1 to 1000 characters, not blank, no control character but a line break. */
export function validateNoticeText(text: unknown): string {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    [...text].length > MAX_NOTICE_TEXT_LENGTH ||
    !/\S/.test(text) ||
    CONTROL.test(text)
  ) {
    throw invalid(
      `the notice text must be 1 to ${MAX_NOTICE_TEXT_LENGTH} characters, not blank, with no control character but a line break`,
    );
  }
  return text;
}

/** Records a version of the tenant's notice, superseding the current one. */
export async function recordPrivacyNotice(
  tx: TxClient,
  input: {
    readonly tenantId: string;
    readonly version: string;
    readonly noticeUrl: string;
    readonly whatsappText: string;
    readonly lawfulBasisRef: string;
    readonly actor: string;
  },
): Promise<{ readonly id: string; readonly version: string }> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  const version = requireMatch(input.version, VERSION, "version");
  const noticeUrl = requireMatch(input.noticeUrl, URL_TEXT, "noticeUrl");
  if (noticeUrl.length > MAX_NOTICE_URL_LENGTH) {
    throw invalid(
      `noticeUrl is longer than ${MAX_NOTICE_URL_LENGTH} characters`,
    );
  }
  const whatsappText = validateNoticeText(input.whatsappText);
  const lawfulBasisRef = requireMatch(
    input.lawfulBasisRef,
    BASIS,
    "lawfulBasisRef",
  );
  const actor = requireMatch(input.actor, ACTOR, "actor");
  let id: unknown;
  try {
    const { rows } = await tx.query<{ id: unknown }>(
      "select ops.record_privacy_notice($1, $2, $3, $4, $5, $6) as id",
      [tenantId, version, noticeUrl, whatsappText, lawfulBasisRef, actor],
    );
    id = rows[0]?.id;
  } catch (error) {
    throw toDomainError(error);
  }
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new Error("ops.record_privacy_notice answered outside its contract");
  }
  return { id, version };
}

/** The tenant's notices, newest first; the current one is marked. */
export async function listPrivacyNotices(
  tx: TxClient,
  input: { readonly tenantId: string },
): Promise<readonly PrivacyNoticeRow[]> {
  const tenantId = requireUuid(input.tenantId, "tenantId");
  try {
    const { rows } = await tx.query<PrivacyNoticeRecord>(LIST_SQL, [
      tenantId,
      MAX_LISTED_NOTICES,
    ]);
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      noticeUrl: row.notice_url,
      whatsappText: row.whatsapp_text,
      lawfulBasisRef: row.lawful_basis_ref,
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
      supersededAt: row.superseded_at,
      current: row.superseded_at === null,
    }));
  } catch (error) {
    throw toDomainError(error);
  }
}
