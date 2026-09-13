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
const RUNS_AFTER_FAILURE =
  /^\s*(?:-\s+)?if:.*\b(?:always|cancelled|failure)\s*\(/;
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
    content.split(/\r?\n/).forEach((text, i) => {
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
const STEP_CONDITION = /^\s*(?:-\s+)?if:/;
const MAY_CONTINUE = /^\s*(?:-\s+)?continue-on-error:(?!\s*false\s*$)/;

/** A workflow step that runs the scope check, unconditionally, and stops the job when it fails. */
const isWorkflowScopeCheck = (step) => {
  const stepLines = step.text.split("\n");
  return (
    stepLines.some((l) => SCOPE_RUN.test(l)) &&
    !stepLines.some((l) => STEP_CONDITION.test(l) || MAY_CONTINUE.test(l)) &&
    isBlocking(step.text, { makefile: false })
  );
};

/**
 * In deploy.yml and the makefile, every function deploy and database push
 * follows the scope check in the same job or target, and the check can stop
 * it: not commented out, not conditional, not `|| true` or `; exit 0`, not
 * continue-on-error, not a make `-` recipe, and not undone by a push step that
 * runs after a failure or a make setting that ignores failed recipes.
 */
export function scopeCheckViolations(path, content) {
  if (!PIPELINES.has(path)) return [];
  const pushLines = new Set(
    commandTexts(path, content)
      .filter(({ text }) =>
        parseSupabaseCommands(text).some((cmd) =>
          SCOPED_COMMANDS.has(cmd.command),
        ),
      )
      .map(({ line }) => line),
  );
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
  const covered = new Set();
  for (const { unit, steps } of units) {
    let checked = false;
    for (const step of steps) {
      step.lines.forEach((n) => covered.add(n));
      if (
        makefile ? SCOPE_RECIPE.test(step.text) : isWorkflowScopeCheck(step)
      ) {
        checked = true;
        continue;
      }
      const push = step.lines.find((n) => pushLines.has(n));
      if (push === undefined) continue;
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
