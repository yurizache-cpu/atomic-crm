// The owner CLIs (`npm run ops`, `npm run execution-stop`) run in process
// against the real database, for the operator suites (operatorRuntime.dbtest.ts,
// operatorCatalog.dbtest.ts, executionStopOutcome.dbtest.ts).
//
// In process rather than as a child: a case can then wrap the owner connection
// (a probe inside a read-only transaction) and read what each command printed
// line by line. The connection is the production one: createWorkerDatabase over
// the fixture's ADMIN_URL, one socket, as the CLIs' own entry points open it.
// Every line a command writes is kept, so a case can check that none of them
// carries anything it must never print.

import { runExecutionStopCli } from "../../cli/executionStop.ts";
import { runOperatorCli } from "../../cli/operator.ts";
import type { WorkerDatabase } from "../../db/types.ts";
import { createWorkerDatabase } from "../../db/workerDatabase.ts";
import { ADMIN_URL } from "../../worker/testSupport/dbFixture.ts";

export interface CliRun {
  readonly code: number;
  /** Every stdout line, as written. */
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  /** stdout, parsed: one object per line. */
  readonly lines: readonly Record<string, unknown>[];
}

export type OpenDatabase = (connectionString: string) => WorkerDatabase;

/** The CLIs' own choice: one connection, because a command is one transaction. */
export const openOwnerDatabase: OpenDatabase = (connectionString) =>
  createWorkerDatabase({ connectionString, max: 1 });

type Cli = typeof runOperatorCli;

/** Every line any command of this suite printed, for the leak checks. */
export interface CliTranscript {
  readonly lines: string[];
}

export const newTranscript = (): CliTranscript => ({ lines: [] });

async function run(
  cli: Cli,
  argv: readonly string[],
  transcript: CliTranscript | undefined,
  openDatabase: OpenDatabase,
): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await cli(argv, {
    env: { ADMIN_DATABASE_URL: ADMIN_URL },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    openDatabase,
  });
  transcript?.lines.push(...stdout, ...stderr);
  return {
    code,
    stdout,
    stderr,
    lines: stdout.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** `npm run ops -- <argv>`. */
export function runOps(
  argv: readonly string[],
  options: {
    readonly transcript?: CliTranscript;
    readonly openDatabase?: OpenDatabase;
  } = {},
): Promise<CliRun> {
  return run(
    runOperatorCli,
    argv,
    options.transcript,
    options.openDatabase ?? openOwnerDatabase,
  );
}

/** `npm run execution-stop -- <argv>`. */
export function runStops(
  argv: readonly string[],
  transcript?: CliTranscript,
): Promise<CliRun> {
  return run(runExecutionStopCli, argv, transcript, openOwnerDatabase);
}

/** The pieces of the owner connection string that no output may carry. */
export function connectionPieces(
  connectionString: string = ADMIN_URL,
): string[] {
  const url = new URL(connectionString);
  return [
    connectionString,
    `${url.protocol}//`,
    url.password,
    `${url.hostname}:${url.port}`,
    url.pathname.length > 1 ? `@${url.hostname}` : "",
  ].filter((piece) => piece !== "");
}

/** Each forbidden text some printed line contains, with the line's index. */
export function leaks(
  transcript: CliTranscript,
  forbidden: readonly string[],
): string[] {
  const found: string[] = [];
  transcript.lines.forEach((line, index) => {
    for (const text of forbidden) {
      if (line.includes(text)) found.push(`line ${index}: ${text}`);
    }
  });
  return found;
}
