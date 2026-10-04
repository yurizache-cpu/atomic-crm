// Argument fixtures shared by the operator tool's tests (operator.test.ts and
// operatorArgs.test.ts). Test data only: the tool itself never imports this.

export const TENANT = "a0000000-0000-4000-8000-00000000000a";
export const COMPANY = "b0000000-0000-4000-8000-00000000000b";
export const LIMIT = "c0000000-0000-4000-8000-00000000000c";
export const REVIEW = "e0000000-0000-4000-8000-00000000000e";
export const AUTH_USER = "f0000000-0000-4000-8000-00000000000f";
export const PRINCIPAL = "a1000000-0000-4000-8000-0000000000a1";
export const MEMBERSHIP = "b1000000-0000-4000-8000-0000000000b1";
export const DATA_AUTHORIZATION = "c1000000-0000-4000-8000-0000000000c1";
export const TASK = "d1000000-0000-4000-8000-0000000000d1";

/** The command words, then each flag as `--name value`, in the order given. */
const argv = (
  words: string,
  flags: Readonly<Record<string, string>>,
): readonly string[] =>
  Object.freeze([
    ...words.split(" "),
    ...Object.entries(flags).flatMap(([name, value]) => [`--${name}`, value]),
  ]);

/** Every read-only command, with and without its options. */
export const READS: readonly (readonly string[])[] = [
  ["status"],
  ["stops"],
  ["stops", "--all"],
  ["routes"],
  ["prices"],
  ["prices", "--all"],
  ["limits"],
  ["limits", "--all"],
  ["spend"],
  ["spend", "--tenant", TENANT],
  ["runs"],
  ["runs", "--tenant", TENANT, "--status", "indeterminate", "--limit", "20"],
  ["indeterminate"],
  ["indeterminate", "--tenant", TENANT],
  // Appended: RUNS_WITH_OPTIONS below is an index into this array.
  ["triage", "list"],
  [
    "triage",
    "list",
    "--tenant",
    TENANT,
    "--status",
    "pending",
    "--limit",
    "20",
  ],
  ["triage", "show", "--id", REVIEW],
  ["triage", "show", "--id", REVIEW, "--tenant", TENANT],
  ["membership", "list"],
  ["membership", "list", "--tenant", TENANT, "--limit", "20"],
  ["data-auth", "list"],
  ["data-auth", "list", "--tenant", TENANT, "--all"],
  ["retention", "list"],
  ["retention", "list", "--tenant", TENANT],
  ["identifiers", "list"],
  ["identifiers", "list", "--tenant", TENANT],
];

/** READS[RUNS_WITH_OPTIONS] is `runs` with a tenant, a status and a limit. */
export const RUNS_WITH_OPTIONS = 11;

export const PRICE_RECORD = argv("price record", {
  provider: "openai",
  model: "gpt-test-2026-01-01",
  "input-usd-per-mtok": "2.50",
  "output-usd-per-mtok": "10",
  "reasoning-in-output": "yes",
  "effective-from": "2026-09-17T00:00:00Z",
  "expires-at": "2026-12-17T00:00:00Z",
  source: "provider pricing page, read 2026-09-17",
  actor: "owner",
});

export const LIMIT_SET = argv("limit set", {
  scope: "tenant",
  tenant: TENANT,
  "daily-usd": "25.50",
  timezone: "America/Sao_Paulo",
  reason: "clinic launch budget",
  actor: "owner",
});

export const LIMIT_RETIRE = argv("limit retire", {
  id: LIMIT,
  reason: "budget replaced",
  actor: "owner",
});

export const TRIAGE_ACCEPT = argv("triage accept", {
  id: REVIEW,
  tenant: TENANT,
  reviewer: "owner",
  note: "reads fine, send after edit",
});

export const TRIAGE_REJECT = argv("triage reject", {
  id: REVIEW,
  tenant: TENANT,
  reviewer: "owner",
});

export const TRIAGE_NEEDS_EDIT = argv("triage needs-edit", {
  id: REVIEW,
  tenant: TENANT,
  reviewer: "owner",
});

export const TRIAGE_RECOVER = argv("triage recover", {
  tenant: TENANT,
  limit: "50",
});

export const DECISION_RECOVER = argv("decision recover", {
  review: REVIEW,
  tenant: TENANT,
});

export const MEMBERSHIP_GRANT = argv("membership grant", {
  tenant: TENANT,
  "auth-user-id": AUTH_USER,
  "display-name": "Synthetic Operator",
  actor: "owner",
  reason: "synthetic pilot operator",
});

export const MEMBERSHIP_REVOKE = argv("membership revoke", {
  id: MEMBERSHIP,
  actor: "owner",
  reason: "pilot ended",
});

/** Every field of a person-content authorization, with FAKE evidence references. */
export const DATA_AUTH_RECORD = argv("data-auth record", {
  tenant: TENANT,
  class: "health",
  capability: "lead_triage",
  provider: "openai",
  model: "gpt-fixture-2026-09-01",
  "valid-from": "2026-10-01T00:00:00Z",
  "expires-at": "2026-12-01T00:00:00Z",
  "evidence-ref": "fixture:provider-evidence:v1",
  "evidence-verified-at": "2026-09-30T00:00:00Z",
  "training-excluded": "yes",
  "contract-ref": "fixture:contract:v1",
  "dpa-ref": "fixture:dpa:v1",
  "zero-retention-ref": "fixture:zdr:v1",
  "retention-evidence-ref": "fixture:retention:v1",
  "transfer-ref": "fixture:transfer:v1",
  "lawful-basis-ref": "fixture:consent:v1",
  "content-retention-days": "30",
  actor: "owner",
});

export const DATA_AUTH_RETIRE = argv("data-auth retire", {
  id: DATA_AUTHORIZATION,
  reason: "evidence withdrawn",
  actor: "owner",
});

export const RETENTION_ERASE = argv("retention erase", {
  tenant: TENANT,
  task: TASK,
  actor: "owner",
});

export const RETENTION_SWEEP = argv("retention sweep", {
  actor: "owner",
  limit: "50",
});

/** A synthetic number: an input to the erasure act, never printed. */
export const ERASED_NUMBER = "5511900000858";

export const IDENTIFIERS_ERASE = argv("identifiers erase", {
  tenant: TENANT,
  number: ERASED_NUMBER,
  actor: "owner",
});

export const IDENTIFIERS_SWEEP = argv("identifiers sweep", {
  actor: "owner",
  limit: "50",
});

/**
 * Every mutation the tool offers, SI-39's act allowlist in its order: the price
 * and spend-limit acts, Phase 2A's three review decisions and the review
 * recovery, and Phase 2C's membership grant and revoke. A decision changes
 * ops.review_items and nothing else — it sends nothing and writes nothing to
 * the CRM; the recovery opens reviews a settlement could not.
 */
export const ACTS: readonly (readonly string[])[] = [
  PRICE_RECORD,
  LIMIT_SET,
  LIMIT_RETIRE,
  TRIAGE_ACCEPT,
  TRIAGE_REJECT,
  TRIAGE_NEEDS_EDIT,
  TRIAGE_RECOVER,
  DECISION_RECOVER,
  MEMBERSHIP_GRANT,
  MEMBERSHIP_REVOKE,
  DATA_AUTH_RECORD,
  DATA_AUTH_RETIRE,
  RETENTION_ERASE,
  RETENTION_SWEEP,
  IDENTIFIERS_ERASE,
  IDENTIFIERS_SWEEP,
];

/** `args` without the flag `--name` and the value after it. */
export const withoutFlag = (
  args: readonly string[],
  name: string,
): readonly string[] =>
  args.filter(
    (token, index) => token !== `--${name}` && args[index - 1] !== `--${name}`,
  );
