// Argument fixtures shared by the operator tool's tests (operator.test.ts and
// operatorArgs.test.ts). Test data only: the tool itself never imports this.

export const TENANT = "a0000000-0000-4000-8000-00000000000a";
export const COMPANY = "b0000000-0000-4000-8000-00000000000b";
export const LIMIT = "c0000000-0000-4000-8000-00000000000c";

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

/** The only three mutations the tool offers. */
export const ACTS: readonly (readonly string[])[] = [
  PRICE_RECORD,
  LIMIT_SET,
  LIMIT_RETIRE,
];

/** `args` without the flag `--name` and the value after it. */
export const withoutFlag = (
  args: readonly string[],
  name: string,
): readonly string[] =>
  args.filter(
    (token, index) => token !== `--${name}` && args[index - 1] !== `--${name}`,
  );
