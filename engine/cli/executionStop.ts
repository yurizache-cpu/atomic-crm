// The owner's execution stop tool: ADR 0010's "CLI that does not depend on the UI
// being up", for the Phase 1D kill switch (ADR 0016 §11).
//
//   npm run execution-stop -- list [--all]
//   npm run execution-stop -- trip --scope <global|tenant|company|department|agent>
//                                  --reason <text> --actor <label>
//                                  [--tenant <uuid>] [--company <uuid>]
//                                  [--department <uuid>] [--agent <uuid>]
//   npm run execution-stop -- clear --id <uuid> --reason <text> --actor <label>
//
// OWNER ONLY. It connects with ADMIN_DATABASE_URL, the owner connection, because
// tripping and clearing are owner acts that no application role can perform. It
// deliberately does NOT run the worker identity gate, which exists to refuse
// exactly this identity. The connection string is read from the environment only
// and is never printed or logged, not even redacted. An error that did not come
// from the database server, and ANY error raised before the transaction opened
// (a connection refusal names the user, database or host, whatever its SQLSTATE),
// is reported by its code alone: those are the places a connection string or its
// parts could surface. SQLSTATE classes 08, 28 and 3D are withheld at any point.
//
// NO FORCE. There is no --force, no --override, and no flag beyond the ones above.
// An unknown flag is a usage error, never something quietly ignored: a kill switch
// with an escape hatch is advisory (ADR 0010). What a stop covers, and whether it
// may be cleared, is decided by the database and recorded on the stop's row.
//
// OUTPUT. One JSON object per line on stdout, written only after the transaction
// committed: `list` prints one line per stop, newest first, and nothing when no
// stop matches; `trip` and `clear` print one line. Exit 0 on success, 2 on a usage
// error, 1 when the database or the domain refused, with one JSON line on stderr:
// {"error": <CompanyOsError code or SQLSTATE>, "message": <text>}.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { CompanyOsError, toDomainError } from "../domain/errors.ts";
import {
  EXECUTION_STOP_SCOPES,
  clearExecutionStop,
  isExecutionStopScope,
  listExecutionStops,
  tripExecutionStop,
  type ExecutionStopAct,
  type ExecutionStopTarget,
} from "../domain/executionStops.ts";

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

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

/** The one variable this tool reads. Named in its error; its value never is. */
export const ADMIN_DATABASE_URL = "ADMIN_DATABASE_URL";

export const EXECUTION_STOP_SYNOPSIS =
  "npm run execution-stop -- list [--all] | trip --scope <global|tenant|company|department|agent> --reason <text> --actor <label> [--tenant <uuid>] [--company <uuid>] [--department <uuid>] [--agent <uuid>] | clear --id <uuid> --reason <text> --actor <label>";

type Arity = "value" | "switch";

// Every flag each command accepts, and whether it takes a value. A Map, so a
// name like `constructor` or `__proto__` cannot find an inherited entry.
const FLAGS: ReadonlyMap<CommandName, ReadonlyMap<string, Arity>> = new Map<
  CommandName,
  ReadonlyMap<string, Arity>
>([
  ["list", new Map<string, Arity>([["all", "switch"]])],
  [
    "trip",
    new Map<string, Arity>([
      ["scope", "value"],
      ["reason", "value"],
      ["actor", "value"],
      ["tenant", "value"],
      ["company", "value"],
      ["department", "value"],
      ["agent", "value"],
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

const REQUIRED: ReadonlyMap<CommandName, readonly string[]> = new Map([
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

  const accepted = FLAGS.get(command) ?? new Map();
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      return usageError(`unexpected argument ${JSON.stringify(token)}`);
    }
    const name = token.slice(2);
    const arity = accepted.get(name);
    if (arity === undefined) {
      const elsewhere = [...FLAGS.values()].some((flags) => flags.has(name));
      return usageError(
        elsewhere
          ? `${token} is not a flag of ${command}`
          : `unknown flag ${JSON.stringify(token)}`,
      );
    }
    if (values.has(name) || switches.has(name)) {
      return usageError(`${token} is given more than once`);
    }
    if (arity === "switch") {
      switches.add(name);
      continue;
    }
    // A following flag is not a value: `--reason --actor x` must not record
    // "--actor" as the reason and lose the actor.
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return usageError(`${token} needs a value`);
    }
    values.set(name, value);
    index += 1;
  }

  const missing = (REQUIRED.get(command) ?? []).find(
    (name) => !values.has(name),
  );
  if (missing !== undefined) {
    return usageError(`${command} needs --${missing}`);
  }

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
    case "trip":
      return [
        {
          result: "stopped",
          stopId: await tripExecutionStop(tx, command.target, command.act),
        },
      ];
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

const CODE = /^[A-Za-z0-9_]{1,40}$/;

// SQLSTATE classes raised while connecting: 08 connection exception, 28 invalid
// authorization, 3D invalid catalog name. Their server messages name the user,
// the database or the client host (measured: `password authentication failed for
// user "postgres"`, `database "…" does not exist`) — pieces of the connection
// string, and on a pooled hosted URL the user carries the project ref.
const CONNECTION_PHASE = /^(08|28|3D)/;

/**
 * The error line. A domain refusal and a database server error raised inside the
 * open transaction carry the server's own message. Everything raised before the
 * transaction opened, a connection-class server error at any point, and anything
 * that did not come from the server — a driver, socket or URL error — is reported
 * by its code alone. The phase decides, not a list of SQLSTATEs: a server refuses
 * a connection under many codes (53300 too many connections for a role, 55000 a
 * database not accepting connections, 42501 no CONNECT privilege), and each names
 * the role or the database.
 */
function describeFailure(
  error: unknown,
  transactionOpened: boolean,
): { error: string; message: string } {
  const mapped = toDomainError(error);
  if (mapped instanceof CompanyOsError) {
    return { error: mapped.code, message: mapped.message };
  }
  const fields =
    typeof mapped === "object" && mapped !== null
      ? (mapped as { code?: unknown; severity?: unknown; message?: unknown })
      : {};
  const code =
    typeof fields.code === "string" && CODE.test(fields.code)
      ? fields.code
      : "unexpected";
  if (!transactionOpened || CONNECTION_PHASE.test(code)) {
    return {
      error: code,
      message:
        "the database refused the connection; its message names parts of the connection string, so only the SQLSTATE is reported",
    };
  }
  // `severity` is set only on an error the server sent (pg's DatabaseError).
  if (
    typeof fields.severity === "string" &&
    typeof fields.message === "string"
  ) {
    return { error: code, message: fields.message };
  }
  return {
    error: code,
    message:
      "the command failed outside the database; errors that did not come from the database server are reported by code only",
  };
}

/** Runs one command and resolves to the process exit code. Never rejects on a database failure. */
export async function runExecutionStopCli(
  argv: readonly string[],
  dependencies: ExecutionStopCliDependencies,
): Promise<number> {
  const { stdout, stderr } = dependencies;
  const command = parseExecutionStopArgs(argv);
  if (command.kind === "usage_error") {
    stderr(
      JSON.stringify({
        error: "usage",
        message: command.message,
        usage: EXECUTION_STOP_SYNOPSIS,
      }),
    );
    return EXIT_USAGE;
  }

  const connectionString = dependencies.env[ADMIN_DATABASE_URL];
  if (!connectionString) {
    stderr(
      JSON.stringify({
        error: "usage",
        message: `${ADMIN_DATABASE_URL} is required: the database owner's connection string, read from the environment only`,
      }),
    );
    return EXIT_USAGE;
  }

  let db: WorkerDatabase | undefined;
  let transactionOpened = false;
  try {
    db = dependencies.openDatabase(connectionString);
    const lines = await db.withTransaction((tx) => {
      transactionOpened = true;
      return execute(tx, command);
    });
    for (const line of lines) stdout(JSON.stringify(line));
    return EXIT_OK;
  } catch (error) {
    stderr(JSON.stringify(describeFailure(error, transactionOpened)));
    return EXIT_REFUSED;
  } finally {
    try {
      await db?.close();
    } catch (error) {
      // The act already committed or already failed; a pool that closes badly
      // changes neither, but it is reported rather than swallowed.
      stderr(
        JSON.stringify({
          warning: "the database pool did not close cleanly",
          ...describeFailure(error, transactionOpened),
        }),
      );
    }
  }
}

// `import.meta.url === \`file://${process.argv[1]}\`` is never true on Windows,
// so this uses pathToFileURL, as engine/worker/main.ts does.
const isEntryPoint = async (): Promise<boolean> => {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (await isEntryPoint()) {
  process.exitCode = await runExecutionStopCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    // One connection: an owner act is one transaction.
    openDatabase: (connectionString) =>
      createWorkerDatabase({ connectionString, max: 1 }),
  });
}
