// The owner's front-desk tool (ADR 0023).
//
//   npm run front-desk -- config list --tenant <uuid> [--agent <uuid>]
//   npm run front-desk -- config show --tenant <uuid> --id <uuid>
//   npm run front-desk -- config draft --tenant <uuid> --agent <uuid> --kind <kind> --file <path.json> --actor <label>
//   npm run front-desk -- config publish --tenant <uuid> --id <uuid> --actor <label>
//   npm run front-desk -- conversations --tenant <uuid>
//   npm run front-desk -- takeover --tenant <uuid> --conversation <uuid> --actor <label>
//   npm run front-desk -- release --tenant <uuid> --conversation <uuid> --actor <label>
//   npm run front-desk -- reply --tenant <uuid> --conversation <uuid> --text-file <path.txt> --actor <label>
//   npm run front-desk -- screenings --tenant <uuid>
//   npm run front-desk -- exceptions --tenant <uuid> [--all]
//   npm run front-desk -- exception resolve --tenant <uuid> --id <uuid> --resolution resolved|dismissed --occurrences <n> --actor <label>
//   npm run front-desk -- exceptions sync --tenant <uuid>
//
// READ-ONLY BY DEFAULT. config list, config show, conversations, screenings
// and exceptions run inside a read-only transaction. The acts are drafting and
// publishing a configuration version, taking a conversation over, releasing
// it, recording a person's reply (an accepted review that `npm run
// messaging -- send` then sends), resolving or dismissing an exception (ADR
// 0025), and syncing a tenant's send exceptions after a send could not record
// its own. No act sends a message, calls a model or writes the CRM. The kinds: operating_policy, playbook, knowledge,
// fixed_messages; a send mode is staging or supervised, never autonomous.
//
// OWNER ONLY. The one variable read is ADMIN_DATABASE_URL. OUTPUT: one JSON
// object per line: ids, versions, states and counts. `config show` prints the
// version's content, which is the owner's own configuration; no command prints
// a contact's number or a message. Exit 0, 2 on a usage error, 1 when the
// database or the domain refused.

import { readFileSync } from "node:fs";
import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  draftAgentConfiguration,
  listAgentConfigurations,
  listConversationStates,
  publishAgentConfiguration,
  recordPersonReply,
  releaseConversation,
  screeningSummary,
  showAgentConfiguration,
  takeOverConversation,
} from "../domain/frontDesk.ts";
import {
  listExceptions,
  resolveException,
  syncTenantSendExceptions,
} from "../domain/exceptionQueue.ts";
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

export const FRONT_DESK_SYNOPSIS =
  "npm run front-desk -- config list --tenant <uuid> [--agent <uuid>] | config show --tenant <uuid> --id <uuid> | config draft --tenant <uuid> --agent <uuid> --kind <kind> --file <path> --actor <label> | config publish --tenant <uuid> --id <uuid> --actor <label> | conversations --tenant <uuid> | takeover|release --tenant <uuid> --conversation <uuid> --actor <label> | reply --tenant <uuid> --conversation <uuid> --text-file <path> --actor <label> | screenings --tenant <uuid> | exceptions --tenant <uuid> [--all] | exception resolve --tenant <uuid> --id <uuid> --resolution resolved|dismissed --occurrences <n> --actor <label> | exceptions sync --tenant <uuid>";

type CommandName =
  | "config list"
  | "config show"
  | "config draft"
  | "config publish"
  | "conversations"
  | "takeover"
  | "release"
  | "reply"
  | "screenings"
  | "exceptions"
  | "exception resolve"
  | "exceptions sync";

interface Grammar {
  readonly flags: ReadonlyMap<string, FlagArity>;
  readonly required: readonly string[];
  readonly readOnly: boolean;
}

const grammar = (
  readOnly: boolean,
  flags: readonly string[],
  required: readonly string[] = flags,
  switches: readonly string[] = [],
): Grammar => ({
  flags: new Map([
    ...flags.map((name): [string, FlagArity] => [name, "value"]),
    ...switches.map((name): [string, FlagArity] => [name, "switch"]),
  ]),
  required,
  readOnly,
});

const COMMANDS: ReadonlyMap<CommandName, Grammar> = new Map([
  ["config list", grammar(true, ["tenant", "agent"], ["tenant"])],
  ["config show", grammar(true, ["tenant", "id"])],
  [
    "config draft",
    grammar(false, ["tenant", "agent", "kind", "file", "actor"]),
  ],
  ["config publish", grammar(false, ["tenant", "id", "actor"])],
  ["conversations", grammar(true, ["tenant"])],
  ["takeover", grammar(false, ["tenant", "conversation", "actor"])],
  ["release", grammar(false, ["tenant", "conversation", "actor"])],
  ["reply", grammar(false, ["tenant", "conversation", "text-file", "actor"])],
  ["screenings", grammar(true, ["tenant"])],
  ["exceptions", grammar(true, ["tenant"], ["tenant"], ["all"])],
  [
    "exception resolve",
    grammar(false, ["tenant", "id", "resolution", "occurrences", "actor"]),
  ],
  ["exceptions sync", grammar(false, ["tenant"])],
]);

/** The only commands that change state, in order. */
export const FRONT_DESK_ACTS: readonly string[] = Object.freeze(
  [...COMMANDS].filter(([, g]) => !g.readOnly).map(([name]) => name),
);

export type FrontDeskCommand =
  | { readonly kind: "usage_error"; readonly message: string }
  | {
      readonly kind: CommandName;
      readonly values: ReadonlyMap<string, string>;
      readonly switches: ReadonlySet<string>;
    };

/** Pure: syntax only. What a value means is the domain's and the database's. */
export function parseFrontDeskArgs(argv: readonly string[]): FrontDeskCommand {
  const [first, second, ...rest] = argv;
  const twoWord = `${first ?? ""} ${second ?? ""}` as CommandName;
  const [name, tokens] = COMMANDS.has(twoWord)
    ? [twoWord, rest]
    : [first as CommandName, argv.slice(1)];
  const command = COMMANDS.get(name);
  if (command === undefined || (first ?? "").includes(" ")) {
    return {
      kind: "usage_error",
      message:
        first === undefined
          ? "no command given"
          : `unknown command ${JSON.stringify(argv.slice(0, 2).join(" "))}`,
    };
  }
  const parsed = parseFlags(tokens, {
    command: name,
    accepted: command.flags,
    required: command.required,
    takenElsewhere: (flag) =>
      [...COMMANDS.values()].some((other) => other.flags.has(flag)),
  });
  if (!parsed.ok) return { kind: "usage_error", message: parsed.message };
  return {
    kind: name,
    values: parsed.flags.values,
    switches: parsed.flags.switches,
  };
}

export interface FrontDeskCliDependencies {
  /** Only ADMIN_DATABASE_URL is ever read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
  /** Reads a file the owner names. */
  readonly readTextFile: (path: string) => string;
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** A file's text with a byte-order mark and Windows line ends removed. */
export const textFromFile = (raw: string): string =>
  (raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw)
    .replace(/\r\n/gu, "\n")
    .replace(/\n$/u, "");

async function run(
  tx: Parameters<typeof listAgentConfigurations>[0],
  command: Exclude<FrontDeskCommand, { kind: "usage_error" }>,
  readTextFile: (path: string) => string,
): Promise<readonly object[]> {
  const get = (flag: string): string => command.values.get(flag) as string;
  const optional = (flag: string): string | undefined =>
    command.values.get(flag);
  const tenantId = get("tenant");
  switch (command.kind) {
    case "config list":
      return listAgentConfigurations(tx, {
        tenantId,
        agentId: optional("agent"),
      });
    case "config show":
      return [
        await showAgentConfiguration(tx, { tenantId, versionId: get("id") }),
      ];
    case "config draft": {
      let content: unknown;
      try {
        content = JSON.parse(textFromFile(readTextFile(get("file"))));
      } catch {
        throw new Error("--file is not a readable JSON document");
      }
      const drafted = await draftAgentConfiguration(tx, {
        tenantId,
        agentId: get("agent"),
        kind: get("kind"),
        content,
        actor: get("actor"),
      });
      return [{ result: "drafted", ...drafted }];
    }
    case "config publish":
      return [
        await publishAgentConfiguration(tx, {
          tenantId,
          versionId: get("id"),
          actor: get("actor"),
        }),
      ];
    case "conversations":
      return listConversationStates(tx, { tenantId });
    case "takeover":
      return [
        await takeOverConversation(tx, {
          tenantId,
          conversationId: get("conversation"),
          actor: get("actor"),
        }),
      ];
    case "release":
      return [
        await releaseConversation(tx, {
          tenantId,
          conversationId: get("conversation"),
          actor: get("actor"),
        }),
      ];
    case "reply":
      return [
        await recordPersonReply(tx, {
          tenantId,
          conversationId: get("conversation"),
          text: textFromFile(readTextFile(get("text-file"))),
          actor: get("actor"),
        }),
      ];
    case "screenings":
      return screeningSummary(tx, { tenantId });
    case "exceptions":
      return listExceptions(tx, {
        tenantId,
        all: command.switches.has("all"),
      });
    case "exception resolve":
      return [
        await resolveException(tx, {
          tenantId,
          exceptionId: get("id"),
          resolution: get("resolution"),
          actor: get("actor"),
          // The count the listing showed; the domain refuses anything but a
          // positive integer.
          occurrences: /^[0-9]{1,7}$/.test(get("occurrences"))
            ? Number(get("occurrences"))
            : Number.NaN,
        }),
      ];
    case "exceptions sync":
      return [await syncTenantSendExceptions(tx, { tenantId })];
  }
}

/** Runs one command and resolves to the process exit code. Never rejects on a database failure. */
export async function runFrontDeskCli(
  argv: readonly string[],
  dependencies: FrontDeskCliDependencies,
): Promise<number> {
  const { stdout, stderr } = dependencies;
  const command = parseFrontDeskArgs(argv);
  if (command.kind === "usage_error") {
    stderr(usageLine(command.message, FRONT_DESK_SYNOPSIS));
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
      if (COMMANDS.get(command.kind)?.readOnly === true) {
        await tx.query("set transaction read only");
      }
      return run(tx, command, dependencies.readTextFile);
    },
  });
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runFrontDeskCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    // One connection: a command is one transaction.
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 1 }),
    readTextFile: (path) => readFileSync(path, "utf8"),
  });
}
