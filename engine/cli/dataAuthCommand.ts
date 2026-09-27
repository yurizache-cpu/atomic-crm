// `npm run ops -- data-auth list | record | retire` (ADR 0020 §D2; owner
// decision D10): the owner's only way to record or retire a BASELINE Q8
// model-data authorization. Kept apart from operator.ts, which wires it in.
//
//   npm run ops -- data-auth list [--tenant <uuid>] [--all]
//   npm run ops -- data-auth record --tenant <uuid> --class operational|person_text|health
//                  --capability <name> --provider <name> --model <id>
//                  --valid-from <ISO instant> --expires-at <ISO instant>
//                  --evidence-ref <ref> --evidence-verified-at <ISO instant>
//                  --training-excluded yes|no
//                  [--contract-ref <ref>] [--dpa-ref <ref>] [--zero-retention-ref <ref>]
//                  [--retention-evidence-ref <ref>] [--transfer-ref <ref>]
//                  [--lawful-basis-ref <ref>] [--content-retention-days <n>]
//                  --actor <label>
//   npm run ops -- data-auth retire --id <uuid> --reason <text> --actor <label>
//
// Every field is a flag: nothing is defaulted, nothing is read from the
// environment. A reference is a pointer to the owner's record, never its text.

import {
  isAuthorizableDataClass,
  MODEL_AUTHORIZABLE_DATA_CLASSES,
} from "../domain/dataClasses.ts";
import type {
  ModelDataAuthorizationAct,
  ModelDataAuthorizationInput,
} from "../domain/modelDataAuthorizations.ts";

export const DATA_AUTH_SYNOPSIS =
  "data-auth list [--tenant <uuid>] [--all] | data-auth record --tenant <uuid> --class operational|person_text|health --capability <name> --provider <name> --model <id> --valid-from <ISO instant> --expires-at <ISO instant> --evidence-ref <ref> --evidence-verified-at <ISO instant> --training-excluded yes|no [--contract-ref <ref>] [--dpa-ref <ref>] [--zero-retention-ref <ref>] [--retention-evidence-ref <ref>] [--transfer-ref <ref>] [--lawful-basis-ref <ref>] [--content-retention-days <n>] --actor <label> | data-auth retire --id <uuid> --reason <text> --actor <label>";

export const DATA_AUTH_RECORD_REQUIRED: readonly string[] = Object.freeze([
  "tenant",
  "class",
  "capability",
  "provider",
  "model",
  "valid-from",
  "expires-at",
  "evidence-ref",
  "evidence-verified-at",
  "training-excluded",
  "actor",
]);

export const DATA_AUTH_RECORD_FLAGS: readonly string[] = Object.freeze([
  ...DATA_AUTH_RECORD_REQUIRED,
  "contract-ref",
  "dpa-ref",
  "zero-retention-ref",
  "retention-evidence-ref",
  "transfer-ref",
  "lawful-basis-ref",
  "content-retention-days",
]);

const DAYS_TEXT = /^[0-9]{1,3}$/;

export type DataAuthRecordParse =
  | {
      readonly ok: true;
      readonly input: ModelDataAuthorizationInput;
      readonly act: ModelDataAuthorizationAct;
    }
  | { readonly ok: false; readonly message: string };

/** Syntax only: whether the values are valid is the domain's answer, and the database's. */
export function buildDataAuthRecord(
  values: ReadonlyMap<string, string>,
): DataAuthRecordParse {
  const dataClass = values.get("class");
  if (!isAuthorizableDataClass(dataClass)) {
    return {
      ok: false,
      message: `--class must be one of ${MODEL_AUTHORIZABLE_DATA_CLASSES.join(", ")}`,
    };
  }
  const training = values.get("training-excluded");
  if (training !== "yes" && training !== "no") {
    return { ok: false, message: "--training-excluded must be yes or no" };
  }
  const daysText = values.get("content-retention-days");
  if (daysText !== undefined && !DAYS_TEXT.test(daysText)) {
    return {
      ok: false,
      message: "--content-retention-days must be a whole number",
    };
  }
  return {
    ok: true,
    input: {
      tenantId: values.get("tenant") as string,
      dataClass,
      capability: values.get("capability") as string,
      provider: values.get("provider") as string,
      model: values.get("model") as string,
      validFrom: values.get("valid-from") as string,
      expiresAt: values.get("expires-at") as string,
      providerEvidenceRef: values.get("evidence-ref") as string,
      evidenceVerifiedAt: values.get("evidence-verified-at") as string,
      trainingExcluded: training === "yes",
      contractRef: values.get("contract-ref"),
      dpaRef: values.get("dpa-ref"),
      zeroRetentionRef: values.get("zero-retention-ref"),
      retentionEvidenceRef: values.get("retention-evidence-ref"),
      transferMechanismRef: values.get("transfer-ref"),
      lawfulBasisRef: values.get("lawful-basis-ref"),
      contentRetentionDays:
        daysText === undefined ? undefined : Number(daysText),
    },
    act: { actor: values.get("actor") as string },
  };
}
