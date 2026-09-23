// The owner's operator tool (ADR 0017 §9; SI-39): what the runtime is doing,
// and an explicit allowlist of narrow acts.
//
//   npm run ops -- status
//   npm run ops -- stops [--all]
//   npm run ops -- routes
//   npm run ops -- prices [--all]
//   npm run ops -- limits [--all]
//   npm run ops -- spend [--tenant <uuid>]
//   npm run ops -- runs [--tenant <uuid>] [--status <status>] [--limit <n>]
//   npm run ops -- indeterminate [--tenant <uuid>]
//   npm run ops -- price record --provider <name> --model <id>
//                  --input-usd-per-mtok <decimal> --output-usd-per-mtok <decimal>
//                  [--cached-input-usd-per-mtok <decimal>] --reasoning-in-output yes|no
//                  --effective-from <ISO instant> --expires-at <ISO instant>
//                  --source <text> --actor <label>
//   npm run ops -- limit set --scope global|tenant|company [--tenant <uuid>]
//                  [--company <uuid>] --daily-usd <decimal> --timezone <IANA name>
//                  --reason <text> --actor <label>
//   npm run ops -- limit retire --id <uuid> --reason <text> --actor <label>
//   npm run ops -- triage list [--tenant <uuid>] [--status <status>] [--limit <n>]
//   npm run ops -- triage show --id <uuid> [--tenant <uuid>]
//   npm run ops -- triage accept --id <uuid> --tenant <uuid> --reviewer <label> [--note <text>]
//   npm run ops -- triage reject --id <uuid> --tenant <uuid> --reviewer <label> [--note <text>]
//   npm run ops -- triage needs-edit --id <uuid> --tenant <uuid> --reviewer <label> [--note <text>]
//   npm run ops -- triage recover [--tenant <uuid>] [--limit <n>]
//   npm run ops -- membership grant --tenant <uuid> --auth-user-id <uuid>
//                  --display-name <label> --actor <label> --reason <text>
//   npm run ops -- membership revoke --id <uuid> --actor <label> --reason <text>
//   npm run ops -- membership list [--tenant <uuid>] [--limit <n>]
//
// TRIAGE (Phase 2A) is the human review queue: `list` shows what is waiting,
// `show` prints one item with the advisory result a person is being asked to
// decide about, and the three decisions record that person's answer. Recording
// a decision performs NO downstream action — nothing is sent and nothing in the
// CRM is written; a later send of an accepted review is a separate operator act
// (`npm run messaging -- send`). Accepting an item whose lead must not be
// contacted is refused by the database. `recover` opens the reviews that
// succeeded runs are missing, from their stored results.
//
// MEMBERSHIP (Phase 2C) is who may use the Company OS operator surface. A person
// is named ONLY by auth user id: no option takes an email, and anything else is a
// usage error before any connection opens. `revoke` is the Company OS off-switch
// for one person; `list` flags emailChangedSinceGrant, computed in SQL.
//
// READ-ONLY BY DEFAULT. Every read command runs `set transaction read only` as
// the first statement of its transaction, so it cannot change anything, even
// through a function with a side effect. The tool changes state only through an
// explicit allowlist of acts (OPERATOR_ACTS): price record, limit set and retire,
// triage accept, reject, needs-edit and recover, and membership grant and revoke.
// None has a force flag, every other command is a read, and no further act
// exists without a reviewed extension of SI-39. Tripping and clearing stops stay
// in `npm run execution-stop`.
//
// ENVIRONMENT. The one variable read is ADMIN_DATABASE_URL, the owner connection.
// The tool never reads a provider key or a model routing variable: `routes` shows
// what the most recently seen workers, stopped ones included, published into
// their heartbeat detail, so the provider key and the owner connection string
// never need to share a process.
//
// OUTPUT. One JSON object per line on stdout, printed only after the transaction
// committed: one per row for a list (nothing for an empty one), always one object
// for `status`, and one for each act. Amounts are exact decimal text. Never a
// run's result, a prompt, task or agent text, an idempotency key, a connection
// string or a key, with one exception: `triage show` prints the stored proposal,
// reply draft included, of the one review item it names, so its output is as
// sensitive as the message (synthetic or test data only while Q8 is open). The
// membership commands never print an email, an email hash, an auth token or
// privileged connection information, on success or on any refusal. Exit codes
// and the failure line are cliOutput.ts's: 0, 2 on a usage error, 1 when the
// database or the domain refused.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  AGENT_RUN_STATUSES,
  isAgentRunStatus,
  type AgentRunStatus,
} from "../domain/agentRunStateMachine.ts";
import { listExecutionStops } from "../domain/executionStops.ts";
import {
  grantMembership,
  isUuid,
  listMemberships,
  revokeMembership,
  type GrantMembershipInput,
  type MembershipAct,
} from "../domain/memberships.ts";
import {
  listModelPrices,
  recordModelPrice,
  type ModelPriceAct,
  type ModelPriceInput,
} from "../domain/modelPrices.ts";
import {
  listRecentRuns,
  listRunsNeedingAttention,
  listWorkerRoutes,
  readRuntimeStatus,
} from "../domain/runtimeReadModel.ts";
import {
  isReviewStatus,
  listReviewItems,
  openMissingReviews,
  readReviewItem,
  recordReviewDecision,
  REVIEW_STATUSES,
  type RecordDecisionInput,
  type ReviewDecision,
  type ReviewStatus,
} from "../domain/reviewQueue.ts";
import {
  SPEND_LIMIT_SCOPES,
  isSpendLimitScope,
  listSpendLimits,
  readSpendStatus,
  retireSpendLimit,
  setSpendLimit,
  type SpendLimitAct,
  type SpendLimitTarget,
  type SpendLimitValue,
} from "../domain/spendLimits.ts";
import {
  EXIT_USAGE,
  isEntryPoint,
  missingAdminUrlLine,
  parseFlags,
  readAdminDatabaseUrl,
  runOwnerTransaction,
  usageLine,
  type FlagArity,
} from "./cliOutput.ts";

export {
  ADMIN_DATABASE_URL,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
} from "./cliOutput.ts";

type ReadCommand =
  | { readonly kind: "status" }
  | { readonly kind: "stops"; readonly includeCleared: boolean }
  | { readonly kind: "routes" }
  | { readonly kind: "prices"; readonly includeHistory: boolean }
  | { readonly kind: "limits"; readonly includeHistory: boolean }
  | { readonly kind: "spend"; readonly tenantId?: string }
  | {
      readonly kind: "runs";
      readonly tenantId?: string;
      readonly status?: AgentRunStatus;
      readonly limit?: number;
    }
  | { readonly kind: "indeterminate"; readonly tenantId?: string }
  | {
      readonly kind: "triage list";
      readonly tenantId?: string;
      readonly status?: ReviewStatus;
      readonly limit?: number;
    }
  | {
      readonly kind: "triage show";
      readonly reviewId: string;
      readonly tenantId?: string;
    }
  | {
      readonly kind: "membership list";
      readonly tenantId?: string;
      readonly limit?: number;
    };

type ActCommand =
  | {
      readonly kind: "price record";
      readonly input: ModelPriceInput;
      readonly act: ModelPriceAct;
    }
  | {
      readonly kind: "limit set";
      readonly target: SpendLimitTarget;
      readonly value: SpendLimitValue;
      readonly act: SpendLimitAct;
    }
  | {
      readonly kind: "limit retire";
      readonly limitId: string;
      readonly act: SpendLimitAct;
    }
  | {
      readonly kind: "triage accept" | "triage reject" | "triage needs-edit";
      readonly tenantId: string;
      readonly input: RecordDecisionInput;
    }
  | {
      readonly kind: "triage recover";
      readonly tenantId?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: "membership grant";
      readonly input: GrantMembershipInput;
      readonly act: MembershipAct;
    }
  | {
      readonly kind: "membership revoke";
      readonly membershipId: string;
      readonly act: MembershipAct;
    };

export type OperatorCommand =
  | ReadCommand
  | ActCommand
  | { readonly kind: "usage_error"; readonly message: string };

type CommandName = (ReadCommand | ActCommand)["kind"];

export const OPERATOR_SYNOPSIS =
  "npm run ops -- status | stops [--all] | routes | prices [--all] | limits [--all] | spend [--tenant <uuid>] | runs [--tenant <uuid>] [--status <status>] [--limit <n>] | indeterminate [--tenant <uuid>] | price record --provider <name> --model <id> --input-usd-per-mtok <decimal> --output-usd-per-mtok <decimal> [--cached-input-usd-per-mtok <decimal>] --reasoning-in-output yes|no --effective-from <ISO instant> --expires-at <ISO instant> --source <text> --actor <label> | limit set --scope global|tenant|company [--tenant <uuid>] [--company <uuid>] --daily-usd <decimal> --timezone <IANA name> --reason <text> --actor <label> | limit retire --id <uuid> --reason <text> --actor <label> | triage list [--tenant <uuid>] [--status <status>] [--limit <n>] | triage show --id <uuid> [--tenant <uuid>] | triage accept|reject|needs-edit --id <uuid> --tenant <uuid> --reviewer <label> [--note <text>] | triage recover [--tenant <uuid>] [--limit <n>] | membership grant --tenant <uuid> --auth-user-id <uuid> --display-name <label> --actor <label> --reason <text> | membership revoke --id <uuid> --actor <label> --reason <text> | membership list [--tenant <uuid>] [--limit <n>]";

/** The first statement of every read command's transaction. */
export const READ_ONLY_TRANSACTION = "set transaction read only";

/** The provenance recorded on the fact a review decision writes. */
const TRIAGE_DECISION_SOURCE = "operator-cli";

interface CommandGrammar {
  readonly readOnly: boolean;
  readonly flags: ReadonlyMap<string, FlagArity>;
  readonly required: readonly string[];
}

/** The three decisions take the same flags: an item, its tenant, a person, a note. */
const DECISION_FLAGS: readonly string[] = Object.freeze([
  "id",
  "tenant",
  "reviewer",
  "note",
]);
const DECISION_REQUIRED: readonly string[] = Object.freeze([
  "id",
  "tenant",
  "reviewer",
]);

/** A grant takes every one of these, and nothing else. */
const MEMBERSHIP_GRANT_FLAGS: readonly string[] = Object.freeze([
  "tenant",
  "auth-user-id",
  "display-name",
  "actor",
  "reason",
]);

const grammar = (
  readOnly: boolean,
  values: readonly string[],
  switches: readonly string[] = [],
  required: readonly string[] = [],
): CommandGrammar => ({
  readOnly,
  flags: new Map<string, FlagArity>([
    ...values.map((name): [string, FlagArity] => [name, "value"]),
    ...switches.map((name): [string, FlagArity] => [name, "switch"]),
  ]),
  required,
});

// Every command, whether it only reads, and every flag it takes. A Map, so a
// name like `constructor` or `__proto__` cannot find an inherited entry.
const COMMANDS: ReadonlyMap<CommandName, CommandGrammar> = new Map<
  CommandName,
  CommandGrammar
>([
  ["status", grammar(true, [])],
  ["stops", grammar(true, [], ["all"])],
  ["routes", grammar(true, [])],
  ["prices", grammar(true, [], ["all"])],
  ["limits", grammar(true, [], ["all"])],
  ["spend", grammar(true, ["tenant"])],
  ["runs", grammar(true, ["tenant", "status", "limit"])],
  ["indeterminate", grammar(true, ["tenant"])],
  [
    "price record",
    grammar(
      false,
      [
        "provider",
        "model",
        "input-usd-per-mtok",
        "output-usd-per-mtok",
        "cached-input-usd-per-mtok",
        "reasoning-in-output",
        "effective-from",
        "expires-at",
        "source",
        "actor",
      ],
      [],
      [
        "provider",
        "model",
        "input-usd-per-mtok",
        "output-usd-per-mtok",
        "reasoning-in-output",
        "effective-from",
        "expires-at",
        "source",
        "actor",
      ],
    ),
  ],
  [
    "limit set",
    grammar(
      false,
      [
        "scope",
        "tenant",
        "company",
        "daily-usd",
        "timezone",
        "reason",
        "actor",
      ],
      [],
      ["scope", "daily-usd", "timezone", "reason", "actor"],
    ),
  ],
  [
    "limit retire",
    grammar(false, ["id", "reason", "actor"], [], ["id", "reason", "actor"]),
  ],
  ["triage list", grammar(true, ["tenant", "status", "limit"])],
  ["triage show", grammar(true, ["id", "tenant"], [], ["id"])],
  ["triage accept", grammar(false, DECISION_FLAGS, [], DECISION_REQUIRED)],
  ["triage reject", grammar(false, DECISION_FLAGS, [], DECISION_REQUIRED)],
  ["triage needs-edit", grammar(false, DECISION_FLAGS, [], DECISION_REQUIRED)],
  ["triage recover", grammar(false, ["tenant", "limit"])],
  // No option takes an email; a person is named only by --auth-user-id.
  [
    "membership grant",
    grammar(false, MEMBERSHIP_GRANT_FLAGS, [], MEMBERSHIP_GRANT_FLAGS),
  ],
  [
    "membership revoke",
    grammar(false, ["id", "actor", "reason"], [], ["id", "actor", "reason"]),
  ],
  ["membership list", grammar(true, ["tenant", "limit"])],
]);

/** The acts, in SI-39's order: the only commands that change state. */
export const OPERATOR_ACTS: readonly string[] = Object.freeze(
  [...COMMANDS].filter(([, entry]) => !entry.readOnly).map(([name]) => name),
);

/** The commands that take a subcommand, and the subcommands each takes. */
const GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  ["price", ["record"]],
  ["limit", ["set", "retire"]],
  ["triage", ["list", "show", "accept", "reject", "needs-edit", "recover"]],
  ["membership", ["grant", "revoke", "list"]],
]);

const LIMIT_TEXT = /^[0-9]{1,6}$/;

const usageError = (message: string): OperatorCommand => ({
  kind: "usage_error",
  message,
});

const isCommandName = (value: string): value is CommandName =>
  COMMANDS.has(value as CommandName);

/** The command name and the tokens after it, or the usage error that names neither. */
function splitCommand(
  argv: readonly string[],
):
  | { readonly name: CommandName; readonly rest: readonly string[] }
  | { readonly message: string } {
  const [first, second, ...others] = argv;
  if (first === undefined) {
    return { message: "no command given" };
  }
  const subcommands = GROUPS.get(first);
  if (subcommands !== undefined) {
    const name = `${first} ${second}`;
    if (second === undefined || !subcommands.includes(second)) {
      return {
        message: `${first} needs a subcommand: ${subcommands.join(" or ")}`,
      };
    }
    return isCommandName(name)
      ? { name, rest: others }
      : { message: `unknown command ${JSON.stringify(name)}` };
  }
  // A subcommand is always its own argument: one argument "price record" is not
  // the command `price record`, and is refused rather than guessed.
  if (first.includes(" ") || !isCommandName(first)) {
    return {
      message: `unknown command ${JSON.stringify(first)}; expected ${[...COMMANDS.keys()].join(", ")}`,
    };
  }
  return { name: first, rest: argv.slice(1) };
}

type Values = ReadonlyMap<string, string>;

function buildRuns(values: Values): OperatorCommand {
  const status = values.get("status");
  if (status !== undefined && !isAgentRunStatus(status)) {
    return usageError(
      `--status must be one of ${AGENT_RUN_STATUSES.join(", ")}`,
    );
  }
  const limitText = values.get("limit");
  if (limitText !== undefined && !LIMIT_TEXT.test(limitText)) {
    return usageError("--limit must be a whole number");
  }
  return {
    kind: "runs",
    tenantId: values.get("tenant"),
    status,
    limit: limitText === undefined ? undefined : Number(limitText),
  };
}

function buildTriageList(values: Values): OperatorCommand {
  const status = values.get("status");
  if (status !== undefined && !isReviewStatus(status)) {
    return usageError(`--status must be one of ${REVIEW_STATUSES.join(", ")}`);
  }
  const limitText = values.get("limit");
  if (limitText !== undefined && !LIMIT_TEXT.test(limitText)) {
    return usageError("--limit must be a whole number");
  }
  return {
    kind: "triage list",
    tenantId: values.get("tenant"),
    status,
    limit: limitText === undefined ? undefined : Number(limitText),
  };
}

/** The decision is the SUBCOMMAND, never a flag: there is no `--decision` to mistype. */
const DECISION_OF: ReadonlyMap<string, ReviewDecision> = new Map([
  ["triage accept", "accepted"],
  ["triage reject", "rejected"],
  ["triage needs-edit", "needs_edit"],
]);

function buildTriageDecision(
  name: "triage accept" | "triage reject" | "triage needs-edit",
  values: Values,
): OperatorCommand {
  return {
    kind: name,
    tenantId: values.get("tenant") as string,
    input: {
      reviewId: values.get("id") as string,
      decision: DECISION_OF.get(name) as ReviewDecision,
      reviewer: values.get("reviewer") as string,
      note: values.get("note"),
    },
  };
}

function buildPriceRecord(values: Values): OperatorCommand {
  const reasoning = values.get("reasoning-in-output");
  if (reasoning !== "yes" && reasoning !== "no") {
    return usageError("--reasoning-in-output must be yes or no");
  }
  return {
    kind: "price record",
    input: {
      provider: values.get("provider") as string,
      model: values.get("model") as string,
      inputUsdPerMtok: values.get("input-usd-per-mtok") as string,
      cachedInputUsdPerMtok: values.get("cached-input-usd-per-mtok"),
      outputUsdPerMtok: values.get("output-usd-per-mtok") as string,
      reasoningInOutput: reasoning === "yes",
      effectiveFrom: values.get("effective-from") as string,
      expiresAt: values.get("expires-at") as string,
    },
    act: {
      source: values.get("source") as string,
      actor: values.get("actor") as string,
    },
  };
}

function buildLimitSet(values: Values): OperatorCommand {
  const scope = values.get("scope");
  if (!isSpendLimitScope(scope)) {
    return usageError(
      `--scope must be one of ${SPEND_LIMIT_SCOPES.join(", ")}`,
    );
  }
  return {
    kind: "limit set",
    target: {
      scope,
      tenantId: values.get("tenant"),
      companyId: values.get("company"),
    },
    value: {
      dailyUsd: values.get("daily-usd") as string,
      timezone: values.get("timezone") as string,
    },
    act: actFrom(values),
  };
}

const actFrom = (values: Values): SpendLimitAct & MembershipAct => ({
  reason: values.get("reason") as string,
  actor: values.get("actor") as string,
});

/**
 * The one value this parser checks beyond syntax, before the environment is
 * read or a connection opens: a person is named only by auth user id, so
 * anything typed in its place (an email, say) never reaches a database and is
 * never repeated.
 */
function buildMembershipGrant(values: Values): OperatorCommand {
  const authUserId = values.get("auth-user-id");
  if (!isUuid(authUserId)) {
    return usageError(
      "--auth-user-id must be the person's auth user id, a uuid; a person is never named by email",
    );
  }
  return {
    kind: "membership grant",
    input: {
      tenantId: values.get("tenant") as string,
      authUserId,
      displayName: values.get("display-name") as string,
    },
    act: actFrom(values),
  };
}

/** `triage recover` and `membership list`: an optional tenant and an optional limit. */
function buildTenantLimit(
  kind: "triage recover" | "membership list",
  values: Values,
): OperatorCommand {
  const limitText = values.get("limit");
  if (limitText !== undefined && !LIMIT_TEXT.test(limitText)) {
    return usageError("--limit must be a whole number");
  }
  return {
    kind,
    tenantId: values.get("tenant"),
    limit: limitText === undefined ? undefined : Number(limitText),
  };
}

/**
 * Parses the arguments after the script name. Pure: it reads nothing but `argv`,
 * never modifies it, and decides only syntax, apart from the auth user id of a
 * membership grant. Whether any other value is valid is the domain's answer,
 * and whether it exists is the database's.
 */
export function parseOperatorArgs(argv: readonly string[]): OperatorCommand {
  const split = splitCommand(argv);
  if ("message" in split) return usageError(split.message);
  const { name, rest } = split;
  const commandGrammar = COMMANDS.get(name) as CommandGrammar;
  const parsed = parseFlags(rest, {
    command: name,
    accepted: commandGrammar.flags,
    required: commandGrammar.required,
    takenElsewhere: (flag) =>
      [...COMMANDS.values()].some((other) => other.flags.has(flag)),
  });
  if (!parsed.ok) {
    // parseFlags quotes a stray token back; a membership command never repeats
    // one that could be an email.
    return usageError(
      name.startsWith("membership ") && parsed.message.includes("@")
        ? `${name} takes only its own flags; the unexpected token is not repeated`
        : parsed.message,
    );
  }
  const { values, switches } = parsed.flags;

  switch (name) {
    case "status":
    case "routes":
      return { kind: name };
    case "stops":
      return { kind: "stops", includeCleared: switches.has("all") };
    case "prices":
    case "limits":
      return { kind: name, includeHistory: switches.has("all") };
    case "spend":
    case "indeterminate":
      return { kind: name, tenantId: values.get("tenant") };
    case "runs":
      return buildRuns(values);
    case "price record":
      return buildPriceRecord(values);
    case "limit set":
      return buildLimitSet(values);
    case "limit retire":
      return {
        kind: "limit retire",
        limitId: values.get("id") as string,
        act: actFrom(values),
      };
    case "triage list":
      return buildTriageList(values);
    case "triage show":
      return {
        kind: "triage show",
        reviewId: values.get("id") as string,
        tenantId: values.get("tenant"),
      };
    case "triage accept":
    case "triage reject":
    case "triage needs-edit":
      return buildTriageDecision(name, values);
    case "triage recover":
    case "membership list":
      return buildTenantLimit(name, values);
    case "membership grant":
      return buildMembershipGrant(values);
    case "membership revoke":
      return {
        kind: "membership revoke",
        membershipId: values.get("id") as string,
        act: actFrom(values),
      };
  }
}

/** Whether a command only reads, and so runs in a read-only transaction. */
export const isReadOnlyCommand = (
  command: ReadCommand | ActCommand,
): command is ReadCommand => COMMANDS.get(command.kind)?.readOnly === true;

async function runRead(
  tx: TxClient,
  command: ReadCommand,
): Promise<readonly object[]> {
  switch (command.kind) {
    case "status":
      return [await readRuntimeStatus(tx)];
    case "stops":
      return listExecutionStops(tx, { includeCleared: command.includeCleared });
    case "routes":
      return listWorkerRoutes(tx);
    case "prices":
      return listModelPrices(tx, { includeHistory: command.includeHistory });
    case "limits":
      return listSpendLimits(tx, { includeHistory: command.includeHistory });
    case "spend":
      return readSpendStatus(tx, { tenantId: command.tenantId });
    case "runs":
      return listRecentRuns(tx, {
        tenantId: command.tenantId,
        status: command.status,
        limit: command.limit,
      });
    case "indeterminate":
      return listRunsNeedingAttention(tx, { tenantId: command.tenantId });
    case "triage list":
      return listReviewItems(tx, {
        tenantId: command.tenantId,
        status: command.status,
        limit: command.limit,
      });
    case "triage show": {
      const item = await readReviewItem(tx, command.reviewId, {
        tenantId: command.tenantId,
      });
      // Nothing for an item this tenant cannot see, exactly as an empty list
      // prints nothing: an operator learns no other tenant's identifiers here.
      return item === undefined ? [] : [item];
    }
    case "membership list":
      return listMemberships(tx, {
        tenantId: command.tenantId,
        limit: command.limit,
      });
  }
}

async function runAct(
  tx: TxClient,
  command: ActCommand,
): Promise<readonly object[]> {
  switch (command.kind) {
    case "price record": {
      const priceId = await recordModelPrice(tx, command.input, command.act);
      return [{ result: "recorded", priceId }];
    }
    case "limit set": {
      const limitId = await setSpendLimit(
        tx,
        command.target,
        command.value,
        command.act,
      );
      return [{ result: "set", limitId, scope: command.target.scope }];
    }
    case "limit retire": {
      const retired = await retireSpendLimit(tx, command.limitId, command.act);
      return [
        {
          result: retired ? "retired" : "already_retired",
          limitId: command.limitId,
        },
      ];
    }
    case "triage accept":
    case "triage reject":
    case "triage needs-edit": {
      const decided = await recordReviewDecision(
        tx,
        { tenantId: command.tenantId, source: TRIAGE_DECISION_SOURCE },
        command.input,
      );
      return [
        {
          result: decided.recorded ? "recorded" : "already_recorded",
          reviewItemId: decided.reviewItemId,
          status: decided.status,
        },
      ];
    }
    case "triage recover": {
      // Opens the reviews a settlement could not: the run's answer was kept,
      // so this derives them from it. Opens nothing twice.
      const opened = await openMissingReviews(tx, {
        tenantId: command.tenantId,
        limit: command.limit,
      });
      return [{ result: "recovered", opened }];
    }
    case "membership grant":
      return [await grantMembership(tx, command.input, command.act)];
    case "membership revoke":
      return [await revokeMembership(tx, command.membershipId, command.act)];
  }
}

export interface OperatorCliDependencies {
  /** Only ADMIN_DATABASE_URL is ever read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Opens the owner connection. Production passes createWorkerDatabase. */
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

/** Runs one command and resolves to the process exit code. Never rejects on a database failure. */
export async function runOperatorCli(
  argv: readonly string[],
  dependencies: OperatorCliDependencies,
): Promise<number> {
  const { stdout, stderr } = dependencies;
  const command = parseOperatorArgs(argv);
  if (command.kind === "usage_error") {
    stderr(usageLine(command.message, OPERATOR_SYNOPSIS));
    return EXIT_USAGE;
  }

  const connectionString = readAdminDatabaseUrl(dependencies.env);
  if (connectionString === undefined) {
    stderr(missingAdminUrlLine());
    return EXIT_USAGE;
  }

  return runOwnerTransaction({
    connectionString,
    openDatabase: dependencies.openDatabase,
    streams: { stdout, stderr },
    work: async (tx) => {
      if (!isReadOnlyCommand(command)) return runAct(tx, command);
      await tx.query(READ_ONLY_TRANSACTION);
      return runRead(tx, command);
    },
  });
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runOperatorCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    // One connection: a command is one transaction.
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 1 }),
  });
}
