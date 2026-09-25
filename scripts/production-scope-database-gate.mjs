// Production scope, database gate: no hosted Supabase deploy runs before the
// live-database suites pass on the commit it ships, in the same workflow run
// (Phase 1D.2).
//
// WHY. A push to main starts deploy.yml and check.yml as two workflow runs,
// and `needs:` cannot reach a job in another run, so the hosted deploy could
// finish before, or despite, a red live-database job for the same commit. The
// proof now lives once, in .github/workflows/database.yml, called by both:
//   a) in every workflow, a job that can reach a hosted project has no
//      job-level `if:`, directly needs a job that only calls database.yml,
//      deploys the tree its one plain checkout gave it, and runs only on push
//      or workflow_dispatch. A job can reach a hosted project when it runs a
//      hosted CLI command (push, function deploy, secret, config push, link,
//      or anything aimed at a linked project, a ref or a database URL) or one
//      whose subcommand cannot be read, directly, through a local action or a
//      make target; when it can read any secret but the two Pages tokens; or
//      when it runs on a machine GitHub does not host. Credentials are the test
//      a respelled command cannot dodge: without one, the CLI cannot
//      authenticate. No job calls a workflow from another repository;
//   b) database.yml runs only when called and is exactly the reviewed job:
//      checkout, node, `npm ci`, every suite in order, each step a plain name
//      and one command. Anything else changes this rule first: an added step
//      can make every suite a no-op (`npm pkg set`, `.npmrc`, the env file),
//      and a checkout input can test another commit. Every Supabase CLI call
//      in it names exactly the measured version (scripts/supabase-cli.mjs): a
//      bare `npx supabase` runs whatever release is latest (Check #72,
//      2026-09-25);
//   c) check.yml calls the same file, on the reviewed triggers and under the
//      draft condition only, and runs no database suite of its own.
//
// WHY ANY `if:` IS REFUSED. A job whose needs failed or were skipped runs
// anyway under `always()` or `!cancelled()`, and a job or step skipped by its
// own condition leaves the caller green: a gate that can skip itself is none.
//
// HOW IT READS. Line by line, with no YAML parser (no new dependency), keys
// compared case-insensitively. A spelling it would have to guess at is refused:
// a quoted, explicit or duplicate key, an anchor, alias, tag or merge key, a
// flow mapping, tabs, a quoted value or flow collection left open at the end of
// its line, a document marker or directive, and any character a YAML reader
// may take as a line break or that renders as nothing (a lone CR after a
// comment once hid a whole job from every line-based guard).
//
// LIMITS. It reads committed workflows, the local actions they use and the root
// makefile. It cannot see a deploy through an npm or node script or a
// third-party action's code, a credential in a configuration variable or in a
// Pages secret, a person deploying by hand (the makefile's deploy target), or
// branch protection. It checks that each suite runs, not what it proves.

import { parseSupabaseCommands } from "./production-scope-commands.mjs";
import { pinnedSupabaseCommand } from "./supabase-cli.mjs";
import {
  isBlank,
  isComment,
  leadOf,
  lineProblems,
  needsOf,
  readJobs,
  splitLines,
  stepCode,
  stepKeys,
  stepsReader,
  topLevelKeys,
  triggersOf,
  unquote,
  withoutComment,
} from "./production-scope-workflow-reader.mjs";

export const DATABASE_GATE_RULE = "deploy-without-database-gate";
export const DATABASE_WORKFLOW = ".github/workflows/database.yml";
export const CHECK_WORKFLOW = ".github/workflows/check.yml";
/** How a job calls the gate: this repository's file, at the caller's commit. */
export const GATE_USES = `./${DATABASE_WORKFLOW}`;

/**
 * The gate job's suites, in the order they must run. Each CLI step runs the
 * measured CLI by its exact package spec, so a respelled or drifted version is
 * a changed step like any other.
 */
export const GATE_RUNS = Object.freeze([
  pinnedSupabaseCommand(["start"]),
  "npm run test:db",
  "npm run test:db:engine",
  "npm run test:db:upgrade -- --workdir .",
  pinnedSupabaseCommand(["db", "reset", "--local", "--no-seed"]),
  "node supabase/tests/referenceData.mjs --without-seed",
  pinnedSupabaseCommand(["db", "reset", "--local"]),
  "npm run test:db",
]);
/** database.yml's steps, all of them, in order: a plain name and exactly these keys. */
const GATE_STEPS = Object.freeze([
  { uses: "actions/checkout@v4" },
  { uses: "actions/setup-node@v4", with: ["cache: npm", "node-version: 22"] },
  { run: "npm ci" },
  ...GATE_RUNS.map((run) => ({ run })),
]);
/** check.yml's triggers, line for line: pushes to main and feature branches, and every pull request update. */
// prettier-ignore
const CHECK_TRIGGERS = Object.freeze([
  "    push:", "        branches:", "            - main",
  '            - "feature/**"', "    pull_request:", "        types:",
  "            - opened", "            - reopened", "            - synchronize",
  "            - ready_for_review",
]);
const DRAFT_CONDITION =
  "${{ !github.event.pull_request.draft || github.event_name == 'push' }}";
/** A deploy ships the pushed commit, or the one a person picked: no other trigger. */
const DEPLOY_TRIGGERS = new Set(["push", "workflow_dispatch"]);

const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const MAKEFILE = /^(?:GNU)?[Mm]akefile$/;
const CONFIG = "supabase/config.toml";
/** CLI commands that change a hosted project, or point the CLI at one. */
// prettier-ignore
const HOSTED_COMMANDS = new Set([
  "db push", "functions deploy", "secrets set", "config push", "link",
]);
const HOSTED_FLAGS = ["--linked", "--project-ref", "--db-url"];
const isHosted = (cmd) =>
  HOSTED_COMMANDS.has(cmd.command) ||
  HOSTED_FLAGS.some((flag) => cmd.flags.has(flag));
const PLAIN_WORD = /^[a-z][a-z0-9-]*$/i;
/** Any secret but the two tokens that publish GitHub Pages. */
const CREDENTIAL = /\bsecrets\b(?!\.(?:github_token|deploy_token)\b)/i;
/** Only an expression reads the secrets context; only a `secrets:` key passes it on. */
const hasCredential = (text) =>
  /^[ \t]*(?:-[ \t]+)?secrets[ \t]*:/im.test(text) ||
  [...text.matchAll(/\$\{\{[\s\S]*?\}\}/g)].some(([e]) => CREDENTIAL.test(e));
const GITHUB_HOSTED = /^(?:ubuntu|windows|macos)-[\w.-]+$/i;
/** A command that swaps the tree a job deploys for another commit's. */
const TREE_CHANGE =
  /\b(?:git|gh)\b.*\b(?:checkout|switch|reset|restore|worktree|fetch|pull|clone|merge|rebase|cherry-pick|revert|am|apply|stash|submodule|read-tree|update-ref|symbolic-ref|update-index|bisect)\b|\bgit[ \t]+-C\b|--(?:git-dir|work-tree)\b|\bGIT_(?:DIR|WORK_TREE|INDEX_FILE)\b/i;
/** A suite, or the runner behind one, in check.yml. */
const DATABASE_SUITE =
  /\btest:db(?![\w-])|\brun-db-[\w-]+\.mjs\b|\breferenceData\.mjs\b/;

/** A key or item these rules cannot read: quoted, explicit, flow, tag, anchor, alias or merge. */
const UNREADABLE_LINE = /^[ \t]*(?:-[ \t]+)*(?:["'?{[!&*]|<<)/;
const ANCHOR_ALIAS_OR_TAG = /(?:^[ \t]*-|:)[ \t]+[&*!]/;
const CALLER_KEYS = new Set(["name", "uses", "permissions"]);
const CHECK_CALLER_KEYS = new Set([...CALLER_KEYS, "if"]);
const GATE_TOP_KEYS = new Set(["name", "on", "permissions", "jobs"]);
// prettier-ignore
const GATE_JOB_KEYS = new Set([
  "name", "runs-on", "timeout-minutes", "env", "steps", "permissions",
]);

/** A function that records a refusal of `file` into `found`. */
const adder = (found, file) => (line, detail) =>
  found.push({ rule: DATABASE_GATE_RULE, file, line, detail });

/** Every refusal, by the shape it catches. */
// prettier-ignore
const WHY = Object.freeze({
  unreadable: (detail) => `${detail}: this rule cannot read the jobs here, so one could deploy without the database gate`,
  remoteCall: (id) => `"${id}" calls a workflow from outside this repository, whose steps no rule can read`,
  stray: "runs a hosted Supabase command outside any step this rule can read",
  anchor: "uses a YAML anchor, alias or tag in a workflow that deploys, which can repeat a hosted command where no rule reads it",
  topLevel: "is not a plain, unique top-level key in a workflow that deploys, so its triggers cannot be read",
  trigger: `deploys on a trigger other than ${[...DEPLOY_TRIGGERS].join(" or ")}, or on triggers this rule cannot read, so the deployed commit may not be the one the gate tested`,
  jobCondition: (id) => `"${id}" can reach a hosted project under a job-level condition, which can run it after the database gate failed or was skipped`,
  stepUnreadable: (id) => `"${id}" can reach a hosted project and has a step this rule cannot read`,
  otherTree: (id) => `"${id}" can reach a hosted project and checks out, fetches or switches to a tree other than the commit the database gate tested`,
  needsUnreadable: (id) => `"${id}" needs jobs this rule cannot read`,
  ungated: (id, reasons) => `"${id}" can reach a hosted project without directly needing a job that only calls ${GATE_USES}${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}`,
  callerExtra: (id, keys) => `"${id}" also sets ${keys.join(", ")}, which can skip, change or replace the gate`,
  callerUses: (id) => `"${id}" does not call exactly ${GATE_USES}`,
  gateMissing: "is missing, so a hosted deploy would wait on no database suite",
  gateSpelling: "is spelled in a way this rule cannot read: a quoted, explicit or flow key, an anchor, alias, tag or merge key",
  gateTopKey: (key) => `sets ${key} at the top level, where only one name, on, permissions and jobs belong: a shared concurrency group can cancel the gate, and defaults or env change what every suite runs`,
  gateTrigger: "must run only when a workflow calls it: on: workflow_call, with no inputs, secrets or other trigger",
  gateJobs: "must hold exactly one readable job, so every suite runs against the same stack",
  gateJobKey: (id, key) => `job "${id}" sets ${key}, which can skip it, repeat it, move it or change what its steps run`,
  gateEnv: `must set exactly one environment variable, SUPABASE_DB_CONTAINER, naming the database of ${CONFIG}`,
  gateSteps: (k) => `must be exactly these steps, in order, each a plain name and nothing else: a checkout with no inputs, setup-node with node-version 22 and the npm cache, npm ci, then ${GATE_RUNS.join("; ")}. Step ${k + 1} is not`,
  checkMissing: `is missing, so pushes and pull requests no longer run ${DATABASE_WORKFLOW}`,
  checkInline: `runs a database suite itself. The suites are defined once, in ${DATABASE_WORKFLOW}, so the checked and the deployed definition cannot drift`,
  checkUncalled: `has no job calling ${GATE_USES}, so a push or pull request no longer proves what the deploy waits on`,
  checkCaller: (id) => `"${id}" calls ${GATE_USES} with more than a name, permissions and the draft condition ${DRAFT_CONDITION}, so it can skip or change the gate`,
  checkTriggers: `must keep its reviewed triggers exactly: ${CHECK_TRIGGERS.map((l) => l.trim()).join(" ")}`,
});

// --- Gate calls ---------------------------------------------------------

/** Why a job is not a plain call of the database gate, or null when it is. */
function notAGateCall(job, allowed = CALLER_KEYS) {
  const extra = [...job.keys.keys()].filter((key) => !allowed.has(key));
  if (extra.length > 0) return WHY.callerExtra(job.id, extra);
  const uses = job.keys.get("uses");
  const exact = uses?.block.length === 0 && unquote(uses.value) === GATE_USES;
  return exact ? null : WHY.callerUses(job.id);
}

// --- What reaches a hosted project ---------------------------------------

/**
 * Whether shell text runs a hosted CLI command, read as written and with its
 * quotes and backslashes removed (`supa""base` is `supabase` to the shell), or
 * a CLI command whose subcommand no rule can read (`supabase $SUB`).
 */
function cliReaches(text) {
  const joined = text.replace(/\\\r?\n/g, " ");
  const readings = [joined, joined.replace(/[\\'"]/g, "")];
  const unreadable = (cmd) => cmd.words.some((w) => !PLAIN_WORD.test(w));
  return (
    readings.some((t) => parseSupabaseCommands(t).some(isHosted)) ||
    joined
      .split("\n")
      .some((line) => parseSupabaseCommands(line).some(unreadable))
  );
}

const UNREADABLE_GOAL = Symbol("unreadable make goal");
const DEFAULT_GOAL = Symbol("default make goal");
const MAKE_PROGRAM = /^(?:\S*\/)?g?make$/;
/** Flags that point make at another makefile or directory. */
const MAKE_ELSEWHERE =
  /^-(?:[A-Za-z]*[CfI]|-(?:directory|file|makefile|include-dir|eval)\b)/;
const MAKE_HEADER = /^([^:=\s#][^:=#]*?)\s*:(?![:=])([^;#]*)(?:;(.*))?/;

/**
 * The goals of every make invocation in a shell text. A `NAME=value` argument
 * overrides the makefile's own value of NAME in every recipe, so one whose
 * value no rule can read (`$X`, an expression) makes the whole call unreadable.
 */
function makeGoals(text) {
  const normalized = text
    .replace(/\$\{\{[\s\S]*?\}\}/g, " $EXPR ")
    .replace(/\$[({]MAKE[)}]/g, " make ")
    .replace(/["'`(){}]/g, " ");
  const goals = [];
  for (const segment of normalized.split(/&&|\|\||[;|&\n]/)) {
    const tokens = segment.trim().split(/\s+/);
    const at = tokens.findIndex((t) =>
      MAKE_PROGRAM.test(t.replace(/^[@+-]+/, "")),
    );
    if (at === -1) continue;
    const named = [];
    let unreadable = false;
    for (const token of tokens.slice(at + 1)) {
      if (token.startsWith("-")) unreadable ||= MAKE_ELSEWHERE.test(token);
      else if (token.includes("$")) unreadable = true;
      else if (token && !token.includes("=")) named.push(token);
    }
    if (unreadable) goals.push(UNREADABLE_GOAL);
    else goals.push(...(named.length > 0 ? named : [DEFAULT_GOAL]));
  }
  return goals;
}

/**
 * Whether a make goal reaches a hosted command in the root makefile, through
 * its recipe, a prerequisite or a sub-make. A goal this cannot read counts.
 */
function makeGoalReachesHosted(files) {
  const makefile = files.find((f) => MAKEFILE.test(f.path));
  if (!makefile) return (goal) => goal === UNREADABLE_GOAL;
  const targets = new Map();
  const target = (name) => {
    if (!targets.has(name)) targets.set(name, { edges: new Set(), recipe: [] });
    return targets.get(name);
  };
  let current = [];
  let continued = false;
  let first = null;
  for (const line of splitLines(makefile.content)) {
    if (continued || (line.startsWith("\t") && line.trim())) {
      current.forEach((t) => t.recipe.push(line));
      continued = line.endsWith("\\");
      continue;
    }
    if (line.startsWith("\t") || isBlank(line) || isComment(line)) continue;
    const header = line.match(MAKE_HEADER);
    const names = header?.[1].trim().split(/\s+/) ?? [];
    current = names.map(target);
    first ??= names.find((name) => !name.startsWith("."));
    for (const name of (header?.[2] ?? "").replace(/\|/g, " ").split(/\s+/)) {
      const goal = name.includes("$") ? UNREADABLE_GOAL : name;
      if (name) current.forEach((t) => t.edges.add(goal));
    }
    if (header?.[3]) current.forEach((t) => t.recipe.push(header[3]));
  }
  for (const t of targets.values()) {
    const text = t.recipe.join("\n");
    t.hosted = cliReaches(text);
    makeGoals(text.replace(/\\$/gm, " ")).forEach((g) => t.edges.add(g));
  }
  const hosted = (goal) =>
    goal === UNREADABLE_GOAL ||
    Boolean(targets.get(goal === DEFAULT_GOAL ? first : goal)?.hosted);
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of targets.values()) {
      if (!t.hosted && [...t.edges].some(hosted)) t.hosted = changed = true;
    }
  }
  return hosted;
}

/** Whether a local action (`uses: ./path`) can reach a hosted project. One this cannot read counts. */
function localActionReaches(ctx, uses, seen = new Set()) {
  const dir = uses.slice(2).replace(/\/+$/, "");
  const at = (name) => (dir ? `${dir}/${name}` : name);
  const paths = [at("action.yml"), at("action.yaml")];
  const file = ctx.files.find((f) => paths.includes(f.path));
  if (!file) return true;
  if (seen.has(file.path)) return false;
  seen.add(file.path);
  const lines = splitLines(file.content);
  if (lineProblems(lines).length > 0) return true;
  const code = lines.filter((line) => !isComment(line)).join("\n");
  const nested = code.matchAll(/\buses[ \t]*:[ \t]*["']?(\.\/[^\s"'#]*)/gi);
  return (
    hasCredential(code) ||
    cliReaches(code) ||
    makeGoals(code).some(ctx.reachesHosted) ||
    [...nested].some(([, next]) => localActionReaches(ctx, next, seen))
  );
}

/** Whether a job can reach a hosted project: a command, a credential or a machine GitHub does not host. */
function reachesProject(job, lines, ctx) {
  const runsOn = job.keys.get("runs-on");
  const selfHosted =
    runsOn &&
    (runsOn.block.length > 0 || !GITHUB_HOSTED.test(unquote(runsOn.value)));
  const text = job.lineNumbers.map((n) => lines[n - 1]).join("\n");
  if (selfHosted || ctx.topCredential || hasCredential(text)) return true;
  return ctx.stepsOf(job).some((step) => {
    const keys = stepKeys(step, lines);
    if (!keys) return true;
    const code = stepCode(keys);
    const uses = unquote(keys.get("uses")?.value ?? "");
    return (
      cliReaches(code) ||
      makeGoals(code).some(ctx.reachesHosted) ||
      (uses.startsWith("./") && localActionReaches(ctx, uses))
    );
  });
}

// --- The rules ----------------------------------------------------------

/** Rule (a) for one job that can reach a hosted project. */
function deployJobViolations(job, jobs, lines, ctx, add) {
  const condition = job.keys.get("if");
  if (condition) add(condition.line, WHY.jobCondition(job.id));
  let checkouts = 0;
  for (const step of ctx.stepsOf(job)) {
    const keys = stepKeys(step, lines);
    const uses = unquote(keys?.get("uses")?.value ?? "");
    const checkout = /^actions\/checkout@/i.test(uses);
    if (!keys) add(step.lines[0], WHY.stepUnreadable(job.id));
    else if (checkout && (++checkouts > 1 || keys.has("with"))) {
      add(step.lines[0], WHY.otherTree(job.id));
    }
  }
  for (const n of job.lineNumbers) {
    if (TREE_CHANGE.test(lines[n - 1])) add(n, WHY.otherTree(job.id));
  }
  const needs = needsOf(job.keys.get("needs"));
  if (needs === null) {
    return add(job.keys.get("needs").line, WHY.needsUnreadable(job.id));
  }
  const needed = needs.map((id) => jobs.get(id)).filter(Boolean);
  if (needed.some((gate) => notAGateCall(gate) === null)) return;
  const reasons = needed
    .filter((gate) => gate.keys.has("uses"))
    .map((gate) => notAGateCall(gate));
  add(job.line, WHY.ungated(job.id, reasons));
}

/** Rule (a) for a workflow with a job that can reach a hosted project: readable top level, reviewed triggers. */
function deployFileViolations(lines, add) {
  lines.forEach((line, i) => {
    if (!isComment(line) && ANCHOR_ALIAS_OR_TAG.test(line)) {
      add(i + 1, WHY.anchor);
    }
  });
  const seen = new Set();
  for (const { line, key } of topLevelKeys(lines)) {
    if (!key || seen.has(key)) add(line, WHY.topLevel);
    seen.add(key);
  }
  const triggers = triggersOf(lines);
  if (!triggers?.names.every((name) => DEPLOY_TRIGGERS.has(name))) {
    add(triggers?.line ?? 1, WHY.trigger);
  }
}

/** Every line of a workflow this rule cannot read, including steps its step reader skipped. */
function unreadableLines(lines, read, stepsOf) {
  const unread = lineProblems(lines);
  if (!read) return [...unread, { line: 1, detail: "no plain jobs block" }];
  unread.push(...read.problems);
  for (const job of read.jobs.values()) {
    const steps = job.keys.get("steps");
    const covered = new Set(stepsOf(job).flatMap((s) => s.lines));
    if (steps && (steps.value || steps.lines.some((n) => !covered.has(n)))) {
      const detail = `steps of "${job.id}" that are not a plain list`;
      unread.push({ line: steps.line, detail });
    }
  }
  return unread;
}

/** Rule (a) for one workflow. `hosted` is true when the file needs the gate. */
function workflowViolations(path, content, ctx) {
  const lines = splitLines(content);
  const found = [];
  const add = adder(found, path);
  const read = readJobs(lines);
  const stepsOf = stepsReader(lines);
  const unread = unreadableLines(lines, read, stepsOf);
  unread.forEach(({ line, detail }) => add(line, WHY.unreadable(detail)));
  if (unread.length > 0) return { found, hosted: true };
  for (const job of read.jobs.values()) {
    const uses = job.keys.get("uses");
    if (uses && !unquote(uses.value).startsWith("./")) {
      add(uses.line, WHY.remoteCall(job.id));
    }
  }
  const jobs = [...read.jobs.values()];
  const stepLines = new Set(
    jobs.flatMap((job) => stepsOf(job)).flatMap((s) => s.lines),
  );
  lines.forEach((line, i) => {
    if (isComment(line) || stepLines.has(i + 1)) return;
    if (cliReaches(line) || makeGoals(line).some(ctx.reachesHosted)) {
      add(i + 1, WHY.stray);
    }
  });
  const top = read.top.filter((line) => !isComment(line)).join("\n");
  const jobCtx = { ...ctx, stepsOf, topCredential: hasCredential(top) };
  const deploying = jobs.filter((job) => reachesProject(job, lines, jobCtx));
  if (deploying.length > 0) deployFileViolations(lines, add);
  for (const job of deploying) {
    deployJobViolations(job, read.jobs, lines, jobCtx, add);
  }
  return { found, hosted: found.length > 0 || deploying.length > 0 };
}

/** Whether a step is a name and exactly the expected keys and values. */
function matchesStep(keys, expected) {
  const wanted = Object.keys(expected);
  // The one key besides the expected ones is a name, never a condition.
  if (!keys?.has("name") || keys.size !== wanted.length + 1) return false;
  return wanted.every((key) => {
    const got = keys.get(key);
    if (key !== "with") {
      return got?.value === expected[key] && got.block.length === 0;
    }
    const block = got?.block.map((text) => withoutComment(text)).sort();
    return got?.value === "" && block.join("\n") === expected.with.join("\n");
  });
}

/**
 * Rule (b) for the gate's one job: the reviewed keys, environment and steps,
 * and nothing else. A runner GitHub does not host is refused by rule (a).
 */
function gateJobViolations(job, lines, files, add) {
  for (const [key, { line }] of job.keys) {
    if (!GATE_JOB_KEYS.has(key)) add(line, WHY.gateJobKey(job.id, key));
  }
  const config = files.find((f) => f.path === CONFIG)?.content ?? "";
  const project = config.match(/^\s*project_id\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const container = `SUPABASE_DB_CONTAINER: supabase_db_${project}`;
  const env = job.keys.get("env");
  const envLines = env?.block.map((text) => withoutComment(text)) ?? [];
  if (!project || env?.value !== "" || envLines.join("\n") !== container) {
    add(env?.line ?? job.line, WHY.gateEnv);
  }
  // One past the last expected step: a step there is one too many.
  const steps = stepsReader(lines)(job);
  const wrong = [...GATE_STEPS, null].findIndex((expected, i) =>
    expected
      ? !matchesStep(steps[i] && stepKeys(steps[i], lines), expected)
      : i < steps.length,
  );
  if (wrong !== -1) {
    add(steps[wrong]?.lines[0] ?? job.line, WHY.gateSteps(wrong));
  }
}

/** Rule (b): the gate runs every suite, in order, and nothing lets it pass without one. */
function gateWorkflowViolations(file, files) {
  const found = [];
  const add = adder(found, DATABASE_WORKFLOW);
  if (!file) {
    add(undefined, WHY.gateMissing);
    return found;
  }
  const lines = splitLines(file.content);
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (UNREADABLE_LINE.test(line) || ANCHOR_ALIAS_OR_TAG.test(line)) {
      add(i + 1, WHY.gateSpelling);
    }
  });
  const seen = new Set();
  for (const { line, key } of topLevelKeys(lines)) {
    if (!GATE_TOP_KEYS.has(key) || seen.has(key)) {
      add(line, WHY.gateTopKey(key ?? lines[line - 1].trim()));
    }
    seen.add(key);
  }
  const triggers = triggersOf(lines);
  if (triggers?.names.join() !== "workflow_call" || triggers.configured) {
    add(triggers?.line ?? 1, WHY.gateTrigger);
  }
  const read = readJobs(lines);
  if (!read || read.problems.length > 0 || read.jobs.size !== 1) {
    add(read?.problems[0]?.line ?? 1, WHY.gateJobs);
    return found;
  }
  gateJobViolations([...read.jobs.values()][0], lines, files, add);
  return found;
}

/** Rule (c): check.yml runs the same definition, on the reviewed triggers, and no copy of it. */
function checkWorkflowViolations(file) {
  const found = [];
  const add = adder(found, CHECK_WORKFLOW);
  if (!file) {
    add(undefined, WHY.checkMissing);
    return found;
  }
  const lines = splitLines(file.content);
  lines.forEach((line, i) => {
    if (!isComment(line) && DATABASE_SUITE.test(line)) {
      add(i + 1, WHY.checkInline);
    }
  });
  const triggers = triggersOf(lines);
  const block = [];
  for (const line of triggers ? lines.slice(triggers.line) : []) {
    if (isBlank(line) || isComment(line)) continue;
    if (leadOf(line).length === 0) break;
    block.push(line.trimEnd());
  }
  if (block.join("\n") !== CHECK_TRIGGERS.join("\n")) {
    add(triggers?.line, WHY.checkTriggers);
  }
  const callers = [...(readJobs(lines)?.jobs.values() ?? [])].filter(
    (job) => unquote(job.keys.get("uses")?.value ?? "") === GATE_USES,
  );
  if (callers.length === 0) add(undefined, WHY.checkUncalled);
  for (const job of callers) {
    const condition = job.keys.get("if");
    const reviewed =
      !condition ||
      (condition.value === DRAFT_CONDITION && condition.block.length === 0);
    if (notAGateCall(job, CHECK_CALLER_KEYS) || !reviewed) {
      add(job.line, WHY.checkCaller(job.id));
    }
  }
  return found;
}

/**
 * @param {Array<{path: string, content: string}>} files  tracked files, POSIX paths
 * @returns {Array<{rule: string, file: string, line?: number, detail: string}>}
 */
export function checkDeployGate(files) {
  const ctx = { files, reachesHosted: makeGoalReachesHosted(files) };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const violations = [];
  let gated = byPath.has(DATABASE_WORKFLOW);
  for (const { path, content } of files) {
    if (!WORKFLOW_FILE.test(path)) continue;
    const { found, hosted } = workflowViolations(path, content, ctx);
    violations.push(...found);
    gated ||= hosted;
  }
  if (gated) {
    violations.push(
      ...gateWorkflowViolations(byPath.get(DATABASE_WORKFLOW), files),
      ...checkWorkflowViolations(byPath.get(CHECK_WORKFLOW)),
    );
  }
  return violations;
}
