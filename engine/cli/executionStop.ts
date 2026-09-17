// The owner's execution stop tool: ADR 0010's "CLI that does not depend on the UI
// being up", for the one kill switch (ADR 0016 §11, ADR 0017 §6).
//
//   npm run execution-stop -- list [--all]
//   npm run execution-stop -- trip --scope <global|tenant|company|department|agent|job_kind>
//                                  --reason <text> --actor <label>
//                                  [--tenant <uuid>] [--company <uuid>]
//                                  [--department <uuid>] [--agent <uuid>]
//                                  [--kind <job kind>]
//   npm run execution-stop -- clear --id <uuid> --reason <text> --actor <label>
//
// OWNER ONLY. It connects with ADMIN_DATABASE_URL, the owner connection, because
// tripping and clearing are owner acts that no application role can perform. The
// connection rules and the failure description are cliOutput.ts's, shared with
// `npm run ops`: the connection string is never printed or logged.
//
// NO FORCE. There is no --force, no --override, and no flag beyond the ones above.
// An unknown flag is a usage error, never something quietly ignored: a kill switch
// with an escape hatch is advisory (ADR 0010). What a stop covers, and whether it
// may be cleared, is decided by the database and recorded on the stop's row. The
// actor prefix `system:` belongs to the database's automatic trips and is refused.
//
// OUTPUT. One JSON object per line on stdout, written only after the transaction
// committed: `list` prints one line per stop, newest first, with its kind and
// origin, and nothing when no stop matches; `trip` prints
// {result: stopped | already_stopped, stopId, trippedBy}, where already_stopped
// means an active stop at the same target and origin absorbed the trip and
// trippedBy names who tripped it; `clear` prints one line. Exit 0 on success, 2 on
// a usage error, 1 when the database or the domain refused, with one JSON line on
// stderr: {"error": <CompanyOsError code or SQLSTATE>, "message": <text>}.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import {
  EXECUTION_STOP_SCOPES,
  clearExecutionStop,
  isExecutionStopScope,
  listExecutionStops,
  tripExecutionStopWithOutcome,
  type ExecutionStopAct,
  type ExecutionStopTarget,
} from "../domain/executionStops.ts";
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

export type ExecutionStopCommand =
  | { readonly kind: "list"; readonly includeCleared: boolean }
  | {
      readonly kind: "trip";
      readonly target: ExecutionStopTarget;
      readonly act: ExecutionStopAct;
    }
  | {
      readonly kind: "clear";
      readonly stopId: string;
      readonly act: ExecutionStopAct;
    }
  | { readonly kind: "usage_error"; readonly message: string };

type RunnableCommand = Exclude<ExecutionStopCommand, { kind: "usage_error" }>;
type CommandName = RunnableCommand["kind"];

export const EXECUTION_STOP_SYNOPSIS =
  "npm run execution-stop -- list [--all] | trip --scope <global|tenant|company|department|agent|job_kind> --reason <text> --actor <label> [--tenant <uuid>] [--company <uuid>] [--department <uuid>] [--agent <uuid>] [--kind <job kind>] | clear --id <uuid> --reason <text> --actor <label>";

// Every flag each command accepts, and whether it takes a value. A Map, so a
// name like `constructor` or `__proto__` cannot find an inherited entry.
const FLAGS: ReadonlyMap<CommandName, ReadonlyMap<string, FlagArity>> = new Map<
  CommandName,
  ReadonlyMap<string, FlagArity>
>([
  ["list", new Map<string, FlagArity>([["all", "switch"]])],
  [
    "trip",
    new Map<string, FlagArity>([
      ["scope", "value"],
      ["reason", "value"],
      ["actor", "value"],
      ["tenant", "value"],
      ["company", "value"],
      ["department", "value"],
      ["agent", "value"],
      ["kind", "value"],
    ]),
  ],
  [
    "clear",
    new Map([
      ["id", "value"],
      ["reason", "value"],
      ["actor", "value"],
    ]),
  ],
]);

const REQUIRED: ReadonlyMap<CommandName, readonly string[]> = new Map<
  CommandName,
  readonly string[]
>([
  ["list", []],
  ["trip", ["scope", "reason", "actor"]],
  ["clear", ["id", "reason", "actor"]],
]);

const usageError = (message: string): ExecutionStopCommand => ({
  kind: "usage_error",
  message,
});

const isCommandName = (value: string | undefined): value is CommandName =>
  value !== undefined && FLAGS.has(value as CommandName);

/**
 * Parses the arguments after the script name. Pure: it reads nothing but `argv`,
 * never modifies it, and decides only syntax. Whether a target is well formed for
 * its scope, and whether it exists, is the domain's and the database's answer.
 */
export function parseExecutionStopArgs(
  argv: readonly string[],
): ExecutionStopCommand {
  const [command, ...rest] = argv;
  if (!isCommandName(command)) {
    return usageError(
      command === undefined
        ? "no command given; expected list, trip or clear"
        : `unknown command ${JSON.stringify(command)}; expected list, trip or clear`,
    );
  }

  const parsed = parseFlags(rest, {
    command,
    accepted: FLAGS.get(command) ?? new Map(),
    required: REQUIRED.get(command) ?? [],
    takenElsewhere: (name) =>
      [...FLAGS.values()].some((flags) => flags.has(name)),
  });
  if (!parsed.ok) return usageError(parsed.message);
  const { values, switches } = parsed.flags;

  switch (command) {
    case "list":
      return { kind: "list", includeCleared: switches.has("all") };
    case "clear":
      return {
        kind: "clear",
        stopId: values.get("id") as string,
        act: actFrom(values),
      };
    case "trip": {
      const scope = values.get("scope");
      if (!isExecutionStopScope(scope)) {
        return usageError(
          `--scope must be one of ${EXECUTION_STOP_SCOPES.join(", ")}`,
        );
      }
      return {
        kind: "trip",
        target: {
          scope,
          tenantId: values.get("tenant"),
          companyId: values.get("company"),
          departmentId: values.get("department"),
          agentId: values.get("agent"),
          jobKind: values.get("kind"),
        },
        act: actFrom(values),
      };
    }
  }
}

const actFrom = (values: ReadonlyMap<string, string>): ExecutionStopAct => ({
  reason: values.get("reason") as string,
  actor: values.get("actor") as string,
});

export interface ExecutionStopCliDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** Opens the owner connection. Production passes createWorkerDatabase. */
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
}

async function execute(
  tx: TxClient,
  command: RunnableCommand,
): Promise<readonly object[]> {
  switch (command.kind) {
    case "list":
      return listExecutionStops(tx, { includeCleared: command.includeCleared });
    case "trip": {
      const trip = await tripExecutionStopWithOutcome(
        tx,
        command.target,
        command.act,
      );
      return [
        {
          result: trip.outcome,
          stopId: trip.stopId,
          trippedBy: trip.trippedBy,
        },
      ];
    }
    case "clear": {
      const cleared = await clearExecutionStop(tx, command.stopId, command.act);
      return [
        {
          result: cleared ? "cleared" : "already_cleared",
          stopId: command.stopId,
        },
      ];
    }
  }
}

/** Runs one command and resolves to the process exit code. Never rejects on a database failure. */
export async function runExecutionStopCli(
  argv: readonly string[],
  dependencies: ExecutionStopCliDependencies,
): Promise<number> {
  const { stdout, stderr } = dependencies;
  const command = parseExecutionStopArgs(argv);
  if (command.kind === "usage_error") {
    stderr(usageLine(command.message, EXECUTION_STOP_SYNOPSIS));
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
    work: (tx) => execute(tx, command),
  });
}

if (await isEntryPoint(import.meta.url)) {
  process.exitCode = await runExecutionStopCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    // One connection: an owner act is one transaction.
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 1 }),
  });
}
