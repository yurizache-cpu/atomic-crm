// Production scope, deploy commands: how scripts/production-scope.mjs reads a
// Supabase CLI invocation, and the rules it applies to one (SI-03, SI-25).
//
// Shell, YAML and JSON are read line by line, comments included: skipping
// comments once hid a live command. JavaScript and TypeScript are read only
// through the argument vectors the TypeScript parser finds
// (scripts/source-facts.mjs): a line of source is not a command line.

import {
  isBlocking,
  makefileUnits,
  workflowUnits,
} from "./dev-signing-key.mjs";
import { literalVectors, parseSource } from "./source-facts.mjs";

const CODE = /\.(?:m|c)?[jt]sx?$/i;
const YAML = /\.ya?ml$/i;
const MAKEFILE = "makefile";
/** The only files that may deploy functions, each after the scope check. */
export const PIPELINES = new Set([".github/workflows/deploy.yml", MAKEFILE]);

const FUNCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CLI = /^(?:.*[\\/])?supabase(?:@[^\s\\/]*)?(?:\.exe)?$/i;
/** A make recipe prefix (`@`, `-`, `+`) or a list comma does not change the program. */
const isCli = (token) =>
  CLI.test(token.replace(/^[@+-]+/, "").replace(/,+$/, ""));
const SEGMENTS = /&&|\|\||;|\||(?<![<>&|])&(?![&>])/;
const LITERAL_BLOCK = /^\|(?:[1-9][-+]?|[-+][1-9]?)?\s*(?:#.*)?$/;
const FOLDED_BLOCK = /^>(?:[1-9][-+]?|[-+][1-9]?)?\s*(?:#.*)?$/;
const CHANGES_DIRECTORY = /(?:^|[\s:;&|(])(?:cd|pushd)\s+\S/;
const YAML_ANCHOR_OR_ALIAS = /(?:^\s*-|:)\s+[&*][A-Za-z][\w-]*(?:\s|$)/;
/** Any status function replaces GitHub's implicit success(), `!success()` included. */
const RUNS_AFTER_FAILURE =
  /^\s*(?:-\s+)?if:.*\b(?:always|cancelled|failure|success)\s*\(/;
const MAKE_IGNORES_FAILURES =
  /^\s*\.(?:ONESHELL|IGNORE)\s*:|^\s*(?:export\s+)?\.?MAKEFLAGS\s*[:+?]?=.*(?:--ignore-errors|(?:^|\s)-[A-Za-z]*i)/;
// prettier-ignore
const VALUE_FLAGS = new Set([
  "--project-ref", "--import-map", "--jobs", "-j", "--workdir", "--profile",
  "--network-id", "--log-level", "--output", "-o", "--output-format",
  "--dns-resolver", "--db-url", "--password", "-p", "--schema", "-s",
]);
// prettier-ignore
const SINGLE_WORD_COMMANDS = new Set([
  "link", "unlink", "start", "stop", "status", "init", "login", "logout",
  "bootstrap", "services",
]);
// prettier-ignore
const REMOTE_COMMANDS = new Set([
  "functions deploy", "db push", "db reset", "link", "secrets set", "config push",
  "functions list",
]);
/** What must follow the scope check in a pipeline. */
const SCOPED_COMMANDS = new Set(["functions deploy", "db push"]);
/** CLI command groups whose second word is the subcommand. */
// prettier-ignore
const COMMAND_GROUPS = new Set([
  "functions", "db", "secrets", "config", "migration", "storage", "projects",
  "branches",
]);

const indentOf = (line) => line.match(/^\s*/)[0].length;
const isLoopback = (value) =>
  typeof value === "string" &&
  /(?:^|@|\/\/)(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/?]|$)/i.test(
    value,
  );

function readCommand(tokens, at) {
  const flags = new Map();
  const words = [];
  const args = [];
  const clean = (token) => token.replace(/,+$/, "");
  for (let i = at + 1; i < tokens.length; i++) {
    const token = clean(tokens[i]);
    if (!token) continue;
    if (token.startsWith("-") && token !== "-") {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      if (eq !== -1) flags.set(name, token.slice(eq + 1));
      else if (VALUE_FLAGS.has(name) && i + 1 < tokens.length) {
        // A separator left by a stripped comma is not the flag's value.
        while (i + 2 < tokens.length && clean(tokens[i + 1]) === "") i++;
        flags.set(name, clean(tokens[++i]));
      } else flags.set(name, true);
      continue;
    }
    const takesWord =
      args.length === 0 &&
      words.length < 2 &&
      !(words.length === 1 && SINGLE_WORD_COMMANDS.has(words[0]));
    if (takesWord) words.push(token);
    else args.push(token);
  }
  return {
    env: tokens.slice(0, at),
    command: words.join(" "),
    words,
    flags,
    args,
  };
}

/**
 * Tokenises every Supabase CLI invocation in one shell-like text. Every token
 * that names the CLI starts a reading, so a wrapper flag's value
 * (`npx -p supabase supabase ...`) cannot shadow the real invocation.
 */
export function parseSupabaseCommands(text) {
  const normalized = text
    .replace(/\$\{\{[\s\S]*?\}\}/g, " $EXPR ")
    .replace(/(["'])\1/g, " $EMPTY ")
    .replace(/\$\(/g, " ")
    .replace(/["'`(){}[\]]/g, " ");
  const commands = [];
  for (const segment of normalized.split(SEGMENTS)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    tokens.forEach((token, at) => {
      if (isCli(token)) commands.push(readCommand(tokens, at));
    });
  }
  return commands;
}

/**
 * A folded or plain YAML `run` scalar as the shell receives it: lines join with
 * spaces, except across a blank line, and, in a folded block only, around a
 * more-indented line.
 */
function foldedRunTexts(lines, i, head, block, texts) {
  const folded = FOLDED_BLOCK.test(head);
  const base = indentOf(lines[block.find((j) => lines[j].trim() !== "")]);
  let paragraph = folded ? null : { line: i + 1, parts: [head] };
  let first = true;
  const flush = () => {
    if (paragraph) {
      texts.push({ line: paragraph.line, text: paragraph.parts.join(" ") });
    }
    paragraph = null;
    first = false;
  };
  for (const j of block) {
    const value = lines[j].trim();
    if (value === "") {
      flush();
    } else if (folded && indentOf(lines[j]) > base) {
      flush();
      texts.push({ line: j + 1, text: value });
    } else {
      paragraph ??= { line: first ? i + 1 : j + 1, parts: [] };
      paragraph.parts.push(value);
    }
  }
  flush();
}

/**
 * Candidate texts: every line (`shell: false` for a line of code, which only
 * the text rules read), folded YAML scalars, and literal argument vectors in
 * code.
 */
function commandTexts(path, content) {
  const lines = content.split(/\r?\n/);
  const texts = [];
  const joined = new Set();
  const code = CODE.test(path);
  if (YAML.test(path)) {
    lines.forEach((text, i) => {
      const m = text.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
      if (!m) return;
      const keyIndent = text.indexOf("run:");
      const block = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== "" && indentOf(lines[j]) <= keyIndent) break;
        block.push(j);
      }
      while (block.length > 0 && lines[block.at(-1)].trim() === "") {
        block.pop();
      }
      const head = m[1].trim();
      if (block.length === 0 || LITERAL_BLOCK.test(head)) return;
      joined.add(i);
      block.forEach((j) => joined.add(j));
      foldedRunTexts(lines, i, head, block, texts);
    });
  }
  for (let i = 0; i < lines.length; i++) {
    if (joined.has(i)) continue;
    const line = i + 1;
    let text = lines[i];
    while (/\\\s*$/.test(text) && !/^\s*#/.test(text) && i + 1 < lines.length) {
      text = `${text.replace(/\\\s*$/, " ")}${lines[++i]}`;
    }
    texts.push({ line, text, shell: !code });
  }
  if (code && /supabase/i.test(content)) {
    for (const { line, tokens } of literalVectors(parseSource(path, content))) {
      // A CLI token followed only by computed values is a call that mentions
      // the name (a log line), not a command anyone can read.
      const readable = tokens.some(
        (token, k) =>
          isCli(token) && tokens.slice(k + 1).some((t) => t !== "$EXPR"),
      );
      if (readable) texts.push({ line, text: tokens.join(" ") });
    }
  }
  return texts;
}

/**
 * @param {string} path
 * @param {string} content
 * @param {{functions: readonly string[]}} scope  the reviewed function names
 */
export function commandViolations(path, content, { functions }) {
  const violations = [];
  const add = (rule, line, detail) =>
    violations.push({ rule, file: path, line, detail });

  for (const { line, text, shell } of commandTexts(path, content)) {
    if (/--include-seed\b/.test(text)) {
      add(
        "remote-seed",
        line,
        "carries --include-seed, which pushes the development seed to a remote project. The seed is local and CI data and must never populate a hosted project",
      );
    }
    if (/api\.supabase\.com\/v1\/projects\/\S*\/functions/i.test(text)) {
      add(
        "functions-deploy-api",
        line,
        "calls the Management API's functions endpoint, a deploy path no rule can read. Deploy functions from deploy.yml or the makefile",
      );
    }
    const commands = shell === false ? [] : parseSupabaseCommands(text);
    if (
      CHANGES_DIRECTORY.test(text) &&
      commands.some((cmd) => REMOTE_COMMANDS.has(cmd.command))
    ) {
      add(
        "supabase-workdir-remote",
        line,
        "changes directory before a remote CLI command, so it runs against a tree no rule inspects",
      );
    }
    for (const cmd of commands) {
      commandRuleViolations({ path, line, cmd, add, functions });
    }
  }

  if (YAML.test(path) || PIPELINES.has(path)) {
    let projectKeys = 0;
    content.split(/\r?\n/).forEach((text, i) => {
      if (PIPELINES.has(path) && /\bSUPABASE_PROJECT_ID\s*[:+?]?=/.test(text)) {
        add(
          "deploy-target-mismatch",
          i + 1,
          "sets SUPABASE_PROJECT_ID in a deploy path, so a command can reach another project than the one the hosted check asked about",
        );
      }
      if (
        PIPELINES.has(path) &&
        YAML.test(path) &&
        /^\s*["']?SUPABASE_PROJECT_ID["']?\s*:/.test(text) &&
        ++projectKeys > 1
      ) {
        add(
          "deploy-target-mismatch",
          i + 1,
          "sets SUPABASE_PROJECT_ID a second time, so a step can reach another project than the one the hosted check asked about",
        );
      }
      if (
        PIPELINES.has(path) &&
        YAML.test(path) &&
        /^\s*(?:-\s+)?["']?(?:shell|defaults)["']?\s*:/.test(text)
      ) {
        add(
          "workflow-shell-override",
          i + 1,
          "replaces the shell a deploy path's steps run in, which can make a check exit 0 whatever its command returns",
        );
      }
      if (/\bSUPABASE_WORKDIR\b/.test(text)) {
        add(
          "supabase-workdir-remote",
          i + 1,
          "sets SUPABASE_WORKDIR in a deploy path, which points every CLI command at a tree no rule inspects",
        );
      }
      const pipelineWorkflow = PIPELINES.has(path) && YAML.test(path);
      if (pipelineWorkflow && /^\s*(?:-\s+)?working-directory:/.test(text)) {
        add(
          "supabase-workdir-remote",
          i + 1,
          "sets a working directory in a deploy path, so its CLI commands run against a tree no rule inspects",
        );
      } else if (pipelineWorkflow && YAML_ANCHOR_OR_ALIAS.test(text)) {
        add(
          "workflow-command-unresolvable",
          i + 1,
          "uses a YAML anchor or alias, which repeats a step where no rule reads it",
        );
      }
      if (pipelineWorkflow && /\bGITHUB_(?:ENV|PATH)\b/.test(text)) {
        add(
          "workflow-env-mutation",
          i + 1,
          "rewrites the job's environment or PATH between steps, which can change what a later step's condition or command means after the checks ran",
        );
      }
      if (/^\s*(?:-\s+)?run:\s*\$\{\{[^}]*\}\}\s*$/.test(text)) {
        add(
          "workflow-command-unresolvable",
          i + 1,
          "a run step whose whole command is an expression, which no rule can read",
        );
      }
    });
  }
  return violations;
}

function commandRuleViolations({ path, line, cmd, add, functions }) {
  const group = cmd.words[0] ?? "";
  if (
    /^[$%]/.test(group) ||
    (COMMAND_GROUPS.has(group) && /^[$%]/.test(cmd.words[1] ?? ""))
  ) {
    add(
      "supabase-subcommand-unresolvable",
      line,
      `runs the Supabase CLI with a subcommand this rule cannot read ("${cmd.words.join(" ")}")`,
    );
  }
  const remoteReset =
    cmd.command === "db reset" &&
    (cmd.flags.has("--linked") ||
      (cmd.flags.has("--db-url") && !isLoopback(cmd.flags.get("--db-url"))));
  if (remoteReset) {
    add(
      "remote-db-reset",
      line,
      "resets a linked or non-loopback database, which wipes it and applies the development seed",
    );
  }
  const remote =
    REMOTE_COMMANDS.has(cmd.command) &&
    (cmd.command !== "db reset" || remoteReset);
  if (
    remote &&
    (cmd.flags.has("--workdir") ||
      cmd.env.some((token) => /^SUPABASE_WORKDIR=/.test(token)))
  ) {
    add(
      "supabase-workdir-remote",
      line,
      `runs \`${cmd.command}\` against another workdir, whose functions and seed no rule inspects`,
    );
  }
  if (cmd.command !== "functions deploy") return;
  if (!PIPELINES.has(path)) {
    add(
      "functions-deploy-outside-pipeline",
      line,
      "deploys edge functions from outside deploy.yml and the makefile, where the function list is read and pinned",
    );
    return;
  }
  if (cmd.flags.has("--import-map")) {
    add(
      "functions-deploy-import-map",
      line,
      "deploys functions with an import map this rule does not read. A function's import map lives at its canonical path",
    );
  }
  if (cmd.args.length === 0) {
    add(
      "functions-deploy-all",
      line,
      "`functions deploy` names no function, so it publishes every directory under supabase/functions, including any added later. Name the functions from PRODUCTION_FUNCTIONS",
    );
  }
  for (const arg of cmd.args) {
    if (!FUNCTION_NAME.test(arg)) {
      add(
        "functions-deploy-unresolvable",
        line,
        `\`functions deploy\` names "${arg}", which this rule cannot resolve to a reviewed function. Name the functions literally`,
      );
    } else if (!functions.includes(arg)) {
      add(
        "functions-deploy-unlisted",
        line,
        `deploys "${arg}", which is not in PRODUCTION_FUNCTIONS (scripts/production-scope.mjs)`,
      );
    }
  }
}

const SCOPE_RUN = /^\s*(?:-\s+)?run:\s*node scripts\/production-scope\.mjs\s*$/;
const SCOPE_RECIPE = /^\tnode scripts\/production-scope\.mjs\s*$/;
const REMOTE_SCOPE_RUN =
  /^\s*(?:-\s+)?run:\s*node scripts\/production-scope\.mjs --project-ref "\$SUPABASE_PROJECT_ID"\s*$/;
const REMOTE_SCOPE_RECIPE =
  /^\tnode scripts\/production-scope\.mjs --linked\s*$/;
/** One makefile push or deploy command as reviewed: the CLI, flags and names only. */
const MAKE_PUSH_SEGMENT =
  /^@?(?:npx\s+)?supabase(?:@[\w.-]+)?(?:\s+--?[\w-]+(?:=[\w.:/-]+)?)*\s+(?:db(?:\s+--?[\w-]+(?:=[\w.:/-]+)?)*\s+push|functions(?:\s+--?[\w-]+(?:=[\w.:/-]+)?)*\s+deploy)(?:\s+(?:--?[\w-]+(?:=[\w.:/-]+)?|[\w.-]+))*$/;
/** A recipe line made only of reviewed push or deploy commands, on one line. */
const isPlainMakePush = (text) =>
  !text.includes("\n") &&
  text
    .split(SEGMENTS)
    .every((segment) => MAKE_PUSH_SEGMENT.test(segment.trim()));
/** deploy.yml's link, run by the binary supabase/setup-cli installed at the measured version. */
const LINK_RUN =
  /^\s*(?:-\s+)?run:\s*supabase link --project-ref "?\$SUPABASE_PROJECT_ID"?\s*$/;
const IF_KEY = /^\s*(?:-\s+)?["']?if["']?\s*:/;
const NAME_KEY = /^\s*(?:-\s+)?name:/;
/** Step keys that change what a check's command runs against, or how it exits. */
const STEP_OVERRIDE =
  /^\s*(?:-\s+)?["']?(?:env|shell|working-directory)["']?\s*:/m;
/** A condition spelled so that no comparison here can trust it. */
const UNREADABLE = Symbol("unreadable condition");

const leadingSpaces = (line) => line.match(/^\s*/)[0].length;

/**
 * A step's `if:` expression, null when it has none, or UNREADABLE when it is
 * spelled any way but one plain line. Only the step's own keys count, never a
 * line inside a run block or a nested map. A quoted, escaped or explicit
 * (`? if`) key anywhere in the step, a spaced or second `if` key, a block or
 * multi-line scalar, a tag, anchor or quoted value, or an expression left open
 * is UNREADABLE.
 */
const conditionOf = (step) => {
  const lines = step.text.split("\n");
  const keyIndent = (lines[0].match(/^\s*-\s+/) ?? [""])[0].length;
  const keys = lines.flatMap((line, at) =>
    at === 0 || (line.trim() !== "" && leadingSpaces(line) === keyIndent)
      ? [{ at, key: line.slice(keyIndent).trim() }]
      : [],
  );
  if (keys.some(({ key }) => /^[?"'{[!&*]/.test(key))) return UNREADABLE;
  const conditions = keys.filter(({ key }) => /^if\s*:/.test(key));
  if (conditions.length === 0) return null;
  if (conditions.length > 1) return UNREADABLE;
  const [{ at, key }] = conditions;
  const plain = key.match(/^if: (\S.*?)\s*$/);
  const next = lines.slice(at + 1).find((l) => l.trim() !== "");
  if (!plain || (next && leadingSpaces(next) > keyIndent)) return UNREADABLE;
  const value = plain[1].replace(/\s+#.*$/, "");
  const opened = value.split("${{").length - 1;
  const closed = value.split("}}").length - 1;
  return /^[|>"'&*!]/.test(value) || opened !== closed ? UNREADABLE : value;
};

/** True when a condition reads only env, vars and secrets, which no later step can change (GITHUB_ENV writes are refused). */
const readsOnlyStableContexts = (condition) =>
  [
    ...condition
      .replace(/'(?:[^']|'')*'/g, "''")
      .matchAll(/[A-Za-z_][\w-]*(?=\s*[.([])/g),
  ].every(([name]) => ["env", "vars", "secrets"].includes(name));

/** A workflow step that runs the repository scope check, unconditionally, and stops the job when it fails. */
const isWorkflowScopeCheck = (step) =>
  step.text.split("\n").some((l) => SCOPE_RUN.test(l)) &&
  conditionOf(step) === null &&
  isBlocking(step.text, { makefile: false });

/**
 * A workflow step that asks the hosted project and stops the job when it fails:
 * nothing overrides its environment, shell or directory, and its condition is
 * absent or one plain line reading only env, vars and secrets.
 */
const isWorkflowRemoteScopeCheck = (step) => {
  const condition = conditionOf(step);
  return (
    step.text.split("\n").some((l) => REMOTE_SCOPE_RUN.test(l)) &&
    condition !== UNREADABLE &&
    (condition === null || readsOnlyStableContexts(condition)) &&
    !STEP_OVERRIDE.test(step.text) &&
    isBlocking(step.text, { makefile: false })
  );
};

/** A workflow step that only links the project the hosted check asked about. */
const isCanonicalLink = (step) => {
  const lines = step.text.split("\n");
  return (
    lines.some((l) => LINK_RUN.test(l)) &&
    lines.every(
      (l) => IF_KEY.test(l) || NAME_KEY.test(l) || LINK_RUN.test(l),
    ) &&
    conditionOf(step) !== UNREADABLE
  );
};

/**
 * In deploy.yml and the makefile, every function deploy and database push
 * follows two checks in the same job or target: the repository scope check,
 * and the hosted check that asks the project which functions it serves. Each
 * can stop it: not commented out, not `|| true` or `; exit 0`, not
 * continue-on-error (unless statically false), not a make `-` recipe, and not
 * undone by a push step that runs after a failure or a make setting that
 * ignores failed recipes. The repository check is unconditional. The hosted
 * check may carry a condition, one plain line reading only env, vars and
 * secrets, and then the push must carry the same one, so the push never runs
 * where the check did not. The push reaches the project the check asked about:
 * it names no project or database of its own, and the only link is the
 * workflow's own `supabase link --project-ref $SUPABASE_PROJECT_ID`.
 */
export function scopeCheckViolations(path, content) {
  if (!PIPELINES.has(path)) return [];
  const pushLines = new Set();
  const targetedPushLines = new Set();
  const linkLines = new Set();
  for (const { text, line } of commandTexts(path, content)) {
    for (const cmd of parseSupabaseCommands(text)) {
      if (SCOPED_COMMANDS.has(cmd.command)) {
        pushLines.add(line);
        if (cmd.flags.has("--project-ref") || cmd.flags.has("--db-url")) {
          targetedPushLines.add(line);
        }
      } else if (cmd.command === "link") {
        linkLines.add(line);
      }
    }
  }
  if (pushLines.size === 0) return [];

  const makefile = path === MAKEFILE;
  const lines = content.split(/\r?\n/);
  const violations = [];
  const violation = (line, detail) =>
    violations.push({
      rule: "deploy-before-scope-check",
      file: path,
      line,
      detail,
    });
  if (makefile) {
    lines.forEach((text, i) => {
      if (MAKE_IGNORES_FAILURES.test(text)) {
        violation(
          i + 1,
          "makes a failed recipe line non-fatal, so the scope check cannot stop the push that follows it",
        );
      }
    });
  }
  const units = (makefile ? makefileUnits(lines) : workflowUnits(lines)) ?? [];
  const remoteViolation = (line, detail) =>
    violations.push({
      rule: "deploy-before-remote-scope-check",
      file: path,
      line,
      detail,
    });
  const targetViolation = (line, detail) =>
    violations.push({
      rule: "deploy-target-mismatch",
      file: path,
      line,
      detail,
    });
  const remoteCheck = makefile
    ? "node scripts/production-scope.mjs --linked"
    : 'node scripts/production-scope.mjs --project-ref "$SUPABASE_PROJECT_ID"';
  const covered = new Set();
  for (const { unit, steps } of units) {
    let checked = false;
    let remote = null;
    const pushes = steps.some((s) => s.lines.some((n) => pushLines.has(n)));
    const lastPush = steps.findLastIndex((s) =>
      s.lines.some((n) => pushLines.has(n)),
    );
    for (const [index, step] of steps.entries()) {
      step.lines.forEach((n) => covered.add(n));
      const link = step.lines.find((n) => linkLines.has(n));
      if (
        link !== undefined &&
        pushes &&
        (makefile || !isCanonicalLink(step))
      ) {
        targetViolation(
          link,
          `"${unit}" links a project this rule cannot match to the one the hosted check asked about, so a push can reach another project`,
        );
      }
      if (
        makefile ? SCOPE_RECIPE.test(step.text) : isWorkflowScopeCheck(step)
      ) {
        checked = true;
        continue;
      }
      if (
        makefile
          ? REMOTE_SCOPE_RECIPE.test(step.text)
          : isWorkflowRemoteScopeCheck(step)
      ) {
        remote = { condition: makefile ? null : conditionOf(step) };
        continue;
      }
      if (
        makefile &&
        remote &&
        index <= lastPush &&
        !isPlainMakePush(step.text)
      ) {
        targetViolation(
          step.lines[0],
          `"${unit}" runs something other than a plain push between the hosted check and its last push, which can change the project a push reaches`,
        );
      }
      const push = step.lines.find((n) => pushLines.has(n));
      if (push === undefined) continue;
      if (step.lines.some((n) => targetedPushLines.has(n))) {
        targetViolation(
          push,
          `"${unit}" names its own project or database on a deploy or push, so the hosted check may have asked about another`,
        );
      }
      if (!remote) {
        remoteViolation(
          push,
          `"${unit}" deploys functions or pushes the database before a blocking \`${remoteCheck}\` asks the project which functions it serves`,
        );
      } else if (conditionOf(step) === UNREADABLE) {
        remoteViolation(
          push,
          `"${unit}" deploys or pushes under a condition this rule cannot read, so it can run where the hosted check did not`,
        );
      } else if (
        remote.condition !== null &&
        conditionOf(step) !== remote.condition
      ) {
        remoteViolation(
          push,
          `"${unit}" deploys or pushes under a condition other than the hosted check's, so it can run where that check did not`,
        );
      }
      if (!checked) {
        violation(
          push,
          `"${unit}" deploys functions or pushes the database before a blocking, unconditional \`node scripts/production-scope.mjs\` in the same ${makefile ? "target" : "job"}`,
        );
      } else if (
        !makefile &&
        step.text.split("\n").some((l) => RUNS_AFTER_FAILURE.test(l))
      ) {
        violation(
          push,
          `"${unit}" runs a deploy or push even after an earlier step failed, so the scope check cannot stop it`,
        );
      }
    }
  }
  for (const line of pushLines) {
    if (!covered.has(line)) {
      violation(
        line,
        "deploys functions or pushes the database outside any job or target this rule can read",
      );
    }
  }
  return violations;
}
