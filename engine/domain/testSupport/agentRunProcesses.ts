// Real worker PROCESSES for the agent runtime suites: the test worker in
// engine/worker/testSupport/agentRunWorker.ts, spawned with a scripted fake
// provider, whose model call a suite catches in flight by waiting for the line
// it prints when a call starts, never by guessing with a timer.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { testChildEnvironment } from "../../worker/testSupport/childEnvironment.ts";
import { WORKER_URL } from "../../worker/testSupport/dbFixture.ts";

export const AGENT_WORKER_SCRIPT =
  "engine/worker/testSupport/agentRunWorker.ts";

export interface WorkerExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SpawnedAgentWorker {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves on the worker's `model_call_started` line; rejects if it exits first. */
  readonly modelCallStarted: Promise<void>;
  /** Resolves once the process has exited and its output streams have closed. */
  readonly closed: Promise<WorkerExit>;
}

const isModelCallStartedLine = (line: string): boolean => {
  try {
    return JSON.parse(line).event === "model_call_started";
  } catch {
    return false;
  }
};

/** How many model calls a worker's stdout says it started. */
export const modelCallsStarted = (stdout: string): number =>
  stdout.split("\n").filter(isModelCallStartedLine).length;

export function spawnAgentRunWorker(
  workerId: string,
  behavior: string,
  env: Readonly<Record<string, string>> = {},
): SpawnedAgentWorker {
  const child = spawn(process.execPath, [AGENT_WORKER_SCRIPT], {
    env: testChildEnvironment(process.env, {
      OPS_WORKER_DATABASE_URL: WORKER_URL,
      OPS_WORKER_ID: workerId,
      FAKE_MODEL_BEHAVIOR: behavior,
      ...env,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const closed = new Promise<WorkerExit>((resolve) =>
    child.once("close", (code) => resolve({ code, stdout, stderr })),
  );
  const modelCallStarted = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.split("\n").some(isModelCallStartedLine)) resolve();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      reject(
        new Error(
          `${workerId} exited ${code} before its model call started: ${stderr || stdout}`,
        ),
      ),
    );
  });
  // A case that never waits for a call (a process that refuses to start) must
  // not leave this rejection unhandled; awaiting it still rejects.
  modelCallStarted.catch(() => undefined);
  return { child, modelCallStarted, closed };
}

/**
 * Asks a spawned worker to stop the way an operator would: SIGTERM on POSIX, as
 * main.ts wires it; the stdin channel on win32, where child.kill("SIGTERM") is
 * TerminateProcess and no handler runs (measured in concurrency.dbtest.ts).
 */
export function requestStop(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32") {
    child.stdin.write("stop\n");
  } else {
    child.kill("SIGTERM");
  }
}
