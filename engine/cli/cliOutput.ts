// What every owner CLI shares: exit codes, the flag grammar, one JSON object per
// output line, the owner-connection lifecycle, and the one rule for describing a
// failure without leaking a connection string (npm run execution-stop, npm run
// ops).
//
// FLAGS. `--name value` and `--switch` only. No `--name=value`, no short flags, no
// positional arguments; an unknown or repeated flag, or a value that is missing or
// is itself a flag, is a usage error, never something quietly ignored or guessed.
//
// OWNER CONNECTION. The tools connect with ADMIN_DATABASE_URL, read from the
// environment only, and never print or log it, not even redacted. They do NOT run
// the worker identity gate, which exists to refuse exactly this identity.
//
// FAILURES. An error that did not come from the database server, and ANY error
// raised before the transaction opened (a connection refusal names the user,
// database or host, whatever its SQLSTATE), is reported by its code alone: those
// are the places a connection string or its parts could surface. SQLSTATE classes
// 08, 28 and 3D are withheld at any point.
//
// OUTPUT. One JSON object per line on stdout, written only after the transaction
// committed. Exit 0 on success, 2 on a usage error, 1 when the database or the
// domain refused, with one JSON line on stderr:
// {"error": <CompanyOsError code or SQLSTATE>, "message": <text>}.

import type { TxClient, WorkerDatabase } from "../db/types.ts";
import { CompanyOsError, toDomainError } from "../domain/errors.ts";

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_USAGE = 2;

/** The one variable the owner tools read. Named in their errors; its value never is. */
export const ADMIN_DATABASE_URL = "ADMIN_DATABASE_URL";

export interface CliStreams {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface FailureDescription {
  readonly error: string;
  readonly message: string;
}

export type FlagArity = "value" | "switch";

export interface ParsedFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

export type FlagParse =
  | { readonly ok: true; readonly flags: ParsedFlags }
  | { readonly ok: false; readonly message: string };

export interface FlagGrammar {
  /** How the command is named in a message, e.g. `trip` or `limit set`. */
  readonly command: string;
  /** Every flag the command accepts. A Map, so `--constructor` finds nothing inherited. */
  readonly accepted: ReadonlyMap<string, FlagArity>;
  /** Flags the command cannot run without. */
  readonly required: readonly string[];
  /** Whether another command of the same tool takes this flag: a clearer message, same refusal. */
  readonly takenElsewhere: (name: string) => boolean;
}

/**
 * Parses the tokens after a command. Pure: reads nothing but its arguments and
 * never modifies them. Decides syntax only; what a value means is the caller's.
 */
export function parseFlags(
  tokens: readonly string[],
  grammar: FlagGrammar,
): FlagParse {
  const refuse = (message: string): FlagParse => ({ ok: false, message });
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      return refuse(`unexpected argument ${JSON.stringify(token)}`);
    }
    const name = token.slice(2);
    const arity = grammar.accepted.get(name);
    if (arity === undefined) {
      return refuse(
        grammar.takenElsewhere(name)
          ? `${token} is not a flag of ${grammar.command}`
          : `unknown flag ${JSON.stringify(token)}`,
      );
    }
    if (values.has(name) || switches.has(name)) {
      return refuse(`${token} is given more than once`);
    }
    if (arity === "switch") {
      switches.add(name);
      continue;
    }
    // A following flag is not a value: `--reason --actor x` must not record
    // "--actor" as the reason and lose the actor.
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return refuse(`${token} needs a value`);
    }
    values.set(name, value);
    index += 1;
  }
  const missing = grammar.required.find((name) => !values.has(name));
  if (missing !== undefined) {
    return refuse(`${grammar.command} needs --${missing}`);
  }
  return { ok: true, flags: { values, switches } };
}

/** One output line: exactly one JSON object, no trailing newline. */
export const jsonLine = (value: object): string => JSON.stringify(value);

/** The stderr line of a usage error, with the tool's synopsis. */
export const usageLine = (message: string, usage: string): string =>
  jsonLine({ error: "usage", message, usage });

/** The stderr line when the owner connection string is absent. */
export const missingAdminUrlLine = (): string =>
  jsonLine({
    error: "usage",
    message: `${ADMIN_DATABASE_URL} is required: the database owner's connection string, read from the environment only`,
  });

/**
 * The owner connection string. Reads exactly one key of `env`, and nothing
 * else: no enumeration, no other variable. Undefined when absent or empty.
 */
export function readAdminDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = env[ADMIN_DATABASE_URL];
  return typeof value === "string" && value !== "" ? value : undefined;
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
export function describeFailure(
  error: unknown,
  transactionOpened: boolean,
): FailureDescription {
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

export interface OwnerTransactionOptions {
  readonly connectionString: string;
  /** Opens the owner connection. Production passes createWorkerDatabase. */
  readonly openDatabase: (connectionString: string) => WorkerDatabase;
  readonly streams: CliStreams;
  /** The whole command, in one transaction. Resolves to the lines to print. */
  readonly work: (tx: TxClient) => Promise<readonly object[]>;
}

/**
 * Opens the owner connection, runs `work` in one transaction, prints its lines
 * only after the commit, and always closes the pool. Resolves to the exit code;
 * never rejects on a database failure.
 */
export async function runOwnerTransaction(
  options: OwnerTransactionOptions,
): Promise<number> {
  const { stdout, stderr } = options.streams;
  let db: WorkerDatabase | undefined;
  let transactionOpened = false;
  try {
    db = options.openDatabase(options.connectionString);
    const lines = await db.withTransaction((tx) => {
      transactionOpened = true;
      return options.work(tx);
    });
    for (const line of lines) stdout(jsonLine(line));
    return EXIT_OK;
  } catch (error) {
    stderr(jsonLine(describeFailure(error, transactionOpened)));
    return EXIT_REFUSED;
  } finally {
    try {
      await db?.close();
    } catch (error) {
      // The act already committed or already failed; a pool that closes badly
      // changes neither, but it is reported rather than swallowed.
      stderr(
        jsonLine({
          warning: "the database pool did not close cleanly",
          ...describeFailure(error, transactionOpened),
        }),
      );
    }
  }
}

/**
 * Whether the module at `moduleUrl` is the process entry point.
 * `import.meta.url === \`file://${process.argv[1]}\`` is never true on Windows,
 * so this uses pathToFileURL, as engine/worker/main.ts does.
 */
export async function isEntryPoint(moduleUrl: string): Promise<boolean> {
  if (!process.argv[1]) return false;
  const { pathToFileURL } = await import("node:url");
  return moduleUrl === pathToFileURL(process.argv[1]).href;
}
