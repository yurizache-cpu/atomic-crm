// Argument fixtures shared by the operator tool's tests (operator.test.ts and
// operatorArgs.test.ts). Test data only: the tool itself never imports this.

export const TENANT = "a0000000-0000-4000-8000-00000000000a";
export const COMPANY = "b0000000-0000-4000-8000-00000000000b";
export const LIMIT = "c0000000-0000-4000-8000-00000000000c";
export const REVIEW = "e0000000-0000-4000-8000-00000000000e";

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

/**
 * Every mutation the tool offers: the three governance acts, and Phase 2A's
 * three review decisions. A decision changes ops.review_items and nothing else
 * — it sends nothing and writes nothing to the CRM.
 */
export const ACTS: readonly (readonly string[])[] = [
  PRICE_RECORD,
  LIMIT_SET,
  LIMIT_RETIRE,
  TRIAGE_ACCEPT,
  TRIAGE_REJECT,
  TRIAGE_NEEDS_EDIT,
];

/** `args` without the flag `--name` and the value after it. */
export const withoutFlag = (
  args: readonly string[],
  name: string,
): readonly string[] =>
  args.filter(
    (token, index) => token !== `--${name}` && args[index - 1] !== `--${name}`,
  );
