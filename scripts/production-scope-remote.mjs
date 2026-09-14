// Production scope, hosted functions: asks the target project which edge
// functions it serves, and refuses any outside PRODUCTION_FUNCTIONS (SI-03).
//
//   node scripts/production-scope.mjs --project-ref <ref>   deploy.yml
//   node scripts/production-scope.mjs --linked              the makefile
//
// A named deploy never deletes a function, so a project deployed while the MCP
// function still existed would keep serving it, and no repository rule can see
// that. The project can. This lists its functions through the Supabase CLI, with
// the access token, project ref and API host the deploy itself uses, so no token
// and no Management API URL is handled here.
//
// It deletes nothing: an unexpected function stops the deploy and waits for a
// person. It prints function names only. Exit 0 when every function the project
// serves is reviewed, 1 when one is not, 2 when it cannot tell.

import { spawnSync } from "node:child_process";
import { linkedProjectRef } from "./dev-signing-key.mjs";

export const REMOTE_USAGE =
  "usage: node scripts/production-scope.mjs [--project-ref <ref> | --linked]";

/** The Supabase CLI's own project-ref shape. */
const PROJECT_REF = /^[a-z]{20}$/;
const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const STATUS = /^[A-Z][A-Z_]*$/;
/** Arguments reach cmd.exe on Windows, so each must be plain. */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_.@-]+$/;
/** The API lists a deleted function as REMOVED: listed, no longer served. */
const NOT_SERVED = new Set(["REMOVED"]);
const CLI_TIMEOUT_MS = 180_000;

/** The CLI invocation, spelled like the deploy steps that follow it. */
export const functionListArgs = (ref) => [
  "supabase",
  "functions",
  "list",
  "--project-ref",
  ref,
  "-o",
  "json",
];

/**
 * The project to ask. Refuses anything that would make the CLI list a
 * different project, or read a different tree, than the deploy that follows.
 * @returns {{ref: string} | {error: string}}
 */
export function remoteTargetOf(
  args,
  { env = process.env, linkedRef = linkedProjectRef } = {},
) {
  let ref;
  if (args.length === 2 && args[0] === "--project-ref") {
    ref = args[1];
  } else if (args.length === 1 && args[0] === "--linked") {
    ref = linkedRef();
    if (!ref) {
      return {
        error: "no project is linked (supabase/.temp/project-ref is missing)",
      };
    }
  } else {
    return { error: "expected --project-ref <ref> or --linked" };
  }
  if (!PROJECT_REF.test(ref ?? "")) {
    return { error: "the project ref is not a 20-letter Supabase project ref" };
  }
  if (env.SUPABASE_WORKDIR) {
    return {
      error: "SUPABASE_WORKDIR is set, so the CLI would read another tree",
    };
  }
  if (env.SUPABASE_PROJECT_ID && env.SUPABASE_PROJECT_ID !== ref) {
    return {
      error:
        "SUPABASE_PROJECT_ID names another project, which the deploy would use instead of the one checked",
    };
  }
  return { ref };
}

/**
 * The function list the CLI printed with `-o json`. Strict: anything other
 * than an array of entries with a readable slug and status is not a list.
 * Never throws, and never quotes what it could not read.
 * @returns {{ok: true, functions: Array<{slug: string, status: string}>} | {ok: false, detail: string}}
 */
export function parseFunctionList(stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout ?? "").trim());
  } catch {
    return { ok: false, detail: "the CLI did not print a JSON function list" };
  }
  // The CLI prints `null` for a project with no functions.
  if (value === null) return { ok: true, functions: [] };
  if (!Array.isArray(value)) {
    return { ok: false, detail: "the CLI printed JSON that is not a list" };
  }
  const functions = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, detail: "an entry in the list is not an object" };
    }
    const { slug, status } = entry;
    if (typeof slug !== "string" || !FUNCTION_NAME.test(slug)) {
      return { ok: false, detail: "an entry in the list has no readable slug" };
    }
    if (typeof status !== "string" || !STATUS.test(status)) {
      return { ok: false, detail: `function ${slug} has no readable status` };
    }
    if (seen.has(slug)) {
      return { ok: false, detail: `function ${slug} is listed twice` };
    }
    seen.add(slug);
    functions.push({ slug, status });
  }
  return { ok: true, functions };
}

/** Which listed functions are served outside the allowlist, compared exactly. */
export function compareDeployedFunctions(functions, allowed) {
  const served = functions.filter((f) => !NOT_SERVED.has(f.status));
  const deployed = served
    .map((f) => f.slug)
    .filter((slug) => allowed.includes(slug))
    .sort();
  const unexpected = served
    .map((f) => f.slug)
    .filter((slug) => !allowed.includes(slug))
    .sort();
  const removed = functions
    .filter((f) => NOT_SERVED.has(f.status) && !allowed.includes(f.slug))
    .map((f) => f.slug)
    .sort();
  const missing = allowed.filter((slug) => !deployed.includes(slug)).sort();
  return {
    status: unexpected.length > 0 ? "fail" : "pass",
    deployed,
    unexpected,
    removed,
    missing,
  };
}

function defaultRunCli(args, { timeoutMs }) {
  return spawnSync("npx", args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    // npx is a .cmd on Windows; every argument is checked plain first.
    shell: process.platform === "win32",
  });
}

/**
 * Lists the project's functions and compares them with `allowed`. Fails
 * CLOSED: anything that prevents a readable answer is `unverified`.
 * @returns {{status: "pass" | "fail" | "unverified", detail?: string, deployed?: string[], unexpected?: string[], removed?: string[], missing?: string[]}}
 */
export function checkRemoteFunctions(
  ref,
  { allowed, runCli = defaultRunCli, timeoutMs = CLI_TIMEOUT_MS },
) {
  const args = functionListArgs(ref);
  if (
    !PROJECT_REF.test(ref ?? "") ||
    !args.every((arg) => PLAIN_ARGUMENT.test(arg))
  ) {
    return {
      status: "unverified",
      detail: "the project ref is not a 20-letter Supabase project ref",
    };
  }
  let run;
  try {
    run = runCli(args, { timeoutMs });
  } catch (error) {
    return {
      status: "unverified",
      detail: `the Supabase CLI could not be started (${error?.name ?? "error"})`,
    };
  }
  if (run.error) {
    return {
      status: "unverified",
      detail: `the Supabase CLI could not run (${run.error.code ?? run.error.name ?? "error"})`,
    };
  }
  if (run.signal) {
    return {
      status: "unverified",
      detail: `the Supabase CLI was stopped by ${run.signal}`,
    };
  }
  if (run.status !== 0) {
    return {
      status: "unverified",
      detail: `the Supabase CLI exited ${run.status}`,
    };
  }
  const parsed = parseFunctionList(run.stdout);
  if (!parsed.ok) return { status: "unverified", detail: parsed.detail };
  return compareDeployedFunctions(parsed.functions, allowed);
}

/** What to print, where, and the exit code. Names only. */
export function reportRemoteFunctions(result) {
  if (result.status === "pass") {
    const notes = [];
    if (result.missing.length > 0) {
      notes.push(`not deployed yet: ${result.missing.join(", ")}`);
    }
    if (result.removed.length > 0) {
      notes.push(`listed as removed: ${result.removed.join(", ")}`);
    }
    return {
      exitCode: 0,
      stream: "stdout",
      text: `[pass] hosted functions: ${result.deployed.length} served, all in PRODUCTION_FUNCTIONS${notes.length ? `; ${notes.join("; ")}` : ""}`,
    };
  }
  if (result.status === "fail") {
    const n = result.unexpected.length;
    return {
      exitCode: 1,
      stream: "stderr",
      text: `[fail] hosted functions: the project serves ${n} function(s) outside PRODUCTION_FUNCTIONS: ${result.unexpected.join(", ")}.\nThis check deletes nothing. A person must delete ${n === 1 ? "it" : "them"} in the project, or review adding ${n === 1 ? "it" : "them"} to PRODUCTION_FUNCTIONS, before this deploy can run.`,
    };
  }
  return {
    exitCode: 2,
    stream: "stderr",
    text: `[unverified] hosted functions: ${result.detail}\nNothing was verified. Refusing.`,
  };
}
