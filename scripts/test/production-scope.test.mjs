import { describe, expect, it } from "vitest";
import { readTrackedFiles } from "../dev-signing-key.mjs";
import {
  PRODUCTION_FUNCTIONS,
  checkProductionScope,
  parseSupabaseCommands,
} from "../production-scope.mjs";
import {
  CONFIG,
  found,
  mutate,
  read,
  rulesOf,
} from "./production-scope-helpers.mjs";

// Every "refuses" case is an attack on a deploy path or on the development
// seed: it reintroduces a path the owner closed on 2026-09-13, and the guard
// must name it. Cases marked (review), (review 2) and (review 3) reproduce ways
// three adversarial reviews got past earlier versions of this guard; (closure)
// cases come from the final pre-1D closure. Function source attacks live in
// production-scope-functions.test.mjs, and the hosted check's own logic in
// production-scope-remote.test.mjs.

const DEPLOY_ALL = "npx supabase functions deploy";
const EXPLICIT = `${DEPLOY_ALL} ${PRODUCTION_FUNCTIONS.join(" ")}`;
/** deploy.yml's deploy: the binary supabase/setup-cli installed at the measured version. */
const WORKFLOW_EXPLICIT = `supabase functions deploy ${PRODUCTION_FUNCTIONS.join(" ")}`;
const WORKFLOW = ".github/workflows/deploy.yml";
/** The reviewed deploy command as the real file spells it. */
const explicitIn = (path) => (path === WORKFLOW ? WORKFLOW_EXPLICIT : EXPLICIT);
const MAKEFILE = "makefile";
const REMOTE_INIT = "scripts/supabase-remote-init.mjs";
const SCOPE_RUN = "run: node scripts/production-scope.mjs";
const SCOPE_RECIPE = "\tnode scripts/production-scope.mjs";
const SCOPE_STEP = `            - name: 🔒 Production scope (reviewed functions only, no development seed)\n              ${SCOPE_RUN}`;
const REMOTE_RUN =
  'run: node scripts/production-scope.mjs --project-ref "$SUPABASE_PROJECT_ID"';
const REMOTE_RECIPE = "\tnode scripts/production-scope.mjs --linked";
const REMOTE_STEP = `            - if: \${{ env.IS_SUPABASE_CONFIGURED }}\n              name: 🔒 Project serves reviewed functions only\n              ${REMOTE_RUN}`;
/** A deploy.yml whose one job runs both scope checks, then `run`. */
const scopedWorkflow = (run) => ({
  path: WORKFLOW,
  content: `jobs:\n  fn:\n    steps:\n      - ${SCOPE_RUN}\n      - ${REMOTE_RUN}\n      - run: ${run}\n`,
});

describe("production scope: the committed repository", () => {
  it("keeps the MCP function and the development seed out of every deployment path", () => {
    expect(checkProductionScope(readTrackedFiles())).toEqual([]);
  });

  it("deploys exactly the reviewed functions, after the scope check, from deploy.yml and the makefile", () => {
    for (const path of [WORKFLOW, MAKEFILE]) {
      const content = read(path);
      expect(content).toContain(explicitIn(path));
      const scope = content.indexOf("node scripts/production-scope.mjs");
      expect(scope).toBeGreaterThan(-1);
      expect(scope).toBeLessThan(content.indexOf(explicitIn(path)));
    }
  });
});

describe("production scope: reading the Supabase CLI", () => {
  it("reads the command through version pins, wrappers and global flags (review)", () => {
    const commands = [
      "npx supabase@2.117.0 functions deploy",
      "npx --yes supabase@2 functions deploy users",
      "pnpm dlx supabase --debug functions deploy users",
      "bunx supabase --workdir . functions deploy users",
      "node_modules/.bin/supabase db --linked reset",
    ].map((text) => parseSupabaseCommands(text)[0].command);
    expect(commands).toEqual([
      "functions deploy",
      "functions deploy",
      "functions deploy",
      "functions deploy",
      "db reset",
    ]);
  });

  it("reads the CLI behind a wrapper's flag value, a subshell or a make prefix (review 2)", () => {
    expect(
      parseSupabaseCommands(
        "npx -p supabase supabase functions deploy mcp",
      ).map((c) => `${c.command}:${c.args.join(",")}`),
    ).toContain("functions deploy:mcp");
    for (const [to, rule] of [
      [
        "npx -p supabase@2.117.0 supabase functions deploy",
        "functions-deploy-all",
      ],
      [
        "out=$(supabase functions deploy users mcp)",
        "functions-deploy-unlisted",
      ],
      ["(supabase functions deploy)", "functions-deploy-all"],
    ]) {
      expect(rulesOf(mutate(WORKFLOW, WORKFLOW_EXPLICIT, to))).toEqual([rule]);
    }
    expect(
      rulesOf(mutate(MAKEFILE, EXPLICIT, "@supabase functions deploy")),
    ).toEqual(["functions-deploy-all"]);
  });

  it("reads a command written as a template, a tagged template or a string held in a variable (review 3)", () => {
    expect(
      found(
        {
          path: "scripts/b.mjs",
          content:
            'await execa({ stdio: "inherit" })`npx supabase db reset --db-url ${url}`;\n',
        },
        {
          path: "engine/tools/reset.ts",
          content: "await $`supabase db reset --linked`.printCommand();\n",
        },
        {
          path: "scripts/c.mjs",
          content:
            'const reset = "npx supabase db reset --linked";\nexecSync(reset);\n',
        },
        {
          path: "e2e/global-setup.ts",
          content: "execSync(`npx supabase functions deploy ${name}`);\n",
        },
      ),
    ).toEqual([
      "remote-db-reset scripts/b.mjs:1",
      "remote-db-reset engine/tools/reset.ts:1",
      "remote-db-reset scripts/c.mjs:1",
      "functions-deploy-outside-pipeline e2e/global-setup.ts:1",
    ]);
  });

  it("does not mistake flags and their values for function names", () => {
    const [cmd] = parseSupabaseCommands(
      'npx supabase functions deploy --project-ref "$SUPABASE_PROJECT_ID" --use-api -j 2 --dns-resolver native users postmark',
    );
    expect(cmd.args).toEqual(["users", "postmark"]);
  });

  it("does not read prose or a log call naming the CLI as a command", () => {
    expect(
      found(
        {
          path: "scripts/smoke.sh",
          content:
            'echo "starting isolated Supabase (slot $slot, api :$api_port)..."\n',
        },
        {
          path: "scripts/log.mjs",
          content: 'console.error("supabase", error, details);\n',
        },
      ),
    ).toEqual([]);
  });

  it("keeps an empty quoted value as a value (review)", () => {
    const [cmd] = parseSupabaseCommands(
      "npx supabase functions deploy users --workdir '' mcp",
    );
    expect(cmd.flags.get("--workdir")).toBe("$EMPTY");
    expect(cmd.args).toEqual(["users", "mcp"]);
  });

  it("reads every command on a chained line (review)", () => {
    expect(
      parseSupabaseCommands(`${EXPLICIT} && ${DEPLOY_ALL}`).map((c) => c.args),
    ).toEqual([[...PRODUCTION_FUNCTIONS], []]);
  });
});

describe("production scope: deploying functions", () => {
  it("refuses deploy.yml deploying every function, an unlisted or unreadable name, or a second chained deploy (review)", () => {
    for (const [path, to, rule] of [
      [WORKFLOW, DEPLOY_ALL, "functions-deploy-all"],
      [WORKFLOW, `${EXPLICIT} mcp`, "functions-deploy-unlisted"],
      [WORKFLOW, `${DEPLOY_ALL} $FUNCTIONS`, "functions-deploy-unresolvable"],
      [WORKFLOW, "npx supabase@2 functions deploy", "functions-deploy-all"],
      [
        MAKEFILE,
        "npx supabase --debug functions deploy users mcp",
        "functions-deploy-unlisted",
      ],
      [MAKEFILE, `${EXPLICIT} && ${DEPLOY_ALL}`, "functions-deploy-all"],
    ]) {
      expect(rulesOf(mutate(path, explicitIn(path), to))).toEqual([rule]);
    }
  });

  it("refuses deploying functions from anywhere but deploy.yml and the makefile (review 2)", () => {
    expect(
      found(
        {
          path: "package.json",
          content:
            '{\n  "scripts": {\n    "fn": "supabase functions deploy users"\n  }\n}\n',
        },
        {
          path: ".github/actions/deploy/action.yml",
          content: `runs:\n  using: composite\n  steps:\n    - run: ${EXPLICIT}\n      shell: bash\n`,
        },
        {
          path: ".github/workflows/staging.yml",
          content: `jobs:\n  s:\n    steps:\n      - run: ${EXPLICIT}\n`,
        },
        { path: "GNUmakefile", content: `stage:\n\t${EXPLICIT}\n` },
        {
          path: "Dockerfile",
          content: "RUN npx supabase@2 functions deploy users\n",
        },
        {
          path: "scripts/deploy-functions.mjs",
          content:
            'await execa("npx", [\n  "supabase",\n  "functions",\n  "deploy",\n  "users",\n]);\n',
        },
        {
          path: "scripts/deploy-one.mjs",
          content:
            'await execa("supabase", ["functions", "deploy", names[0]]);\n',
        },
        {
          path: "scripts/deploy-deno.ts",
          content:
            'new Deno.Command("supabase", { args: ["functions", "deploy"] });\n',
        },
      ),
    ).toEqual([
      "functions-deploy-outside-pipeline package.json:3",
      "functions-deploy-outside-pipeline .github/actions/deploy/action.yml:4",
      "functions-deploy-outside-pipeline .github/workflows/staging.yml:4",
      "functions-deploy-outside-pipeline GNUmakefile:2",
      "functions-deploy-outside-pipeline Dockerfile:1",
      "functions-deploy-outside-pipeline scripts/deploy-functions.mjs:1",
      "functions-deploy-outside-pipeline scripts/deploy-one.mjs:1",
      "functions-deploy-outside-pipeline scripts/deploy-deno.ts:1",
    ]);
  });

  it("refuses a remote command pointed at another workdir or import map (review 2)", () => {
    for (const to of [
      `${EXPLICIT} --workdir staging`,
      `SUPABASE_WORKDIR=staging ${EXPLICIT}`,
      `cd staging && ${EXPLICIT}`,
    ]) {
      expect(rulesOf(mutate(WORKFLOW, WORKFLOW_EXPLICIT, to))).toEqual([
        "supabase-workdir-remote",
      ]);
    }
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          SCOPE_RUN,
          `${SCOPE_RUN}\n              working-directory: staging`,
        ),
      ),
    ).toEqual(["supabase-workdir-remote"]);
    expect(
      rulesOf(
        mutate(
          MAKEFILE,
          "supabase-deploy:",
          "export SUPABASE_WORKDIR := staging\nsupabase-deploy:",
        ),
      ),
    ).toEqual(["supabase-workdir-remote"]);
    expect(
      found(
        {
          path: "scripts/staging.sh",
          content: "SUPABASE_WORKDIR=staging npx supabase db push\n",
        },
        {
          path: ".github/workflows/x.yml",
          content: "env:\n  SUPABASE_WORKDIR: staging\n",
        },
      ),
    ).toEqual([
      "supabase-workdir-remote scripts/staging.sh:1",
      "supabase-workdir-remote .github/workflows/x.yml:2",
    ]);
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          WORKFLOW_EXPLICIT,
          `${WORKFLOW_EXPLICIT} --import-map supabase/map.json`,
        ),
      ),
    ).toEqual(["functions-deploy-import-map"]);
  });

  it("refuses a scope check that cannot stop the deploy (review 3)", () => {
    for (const to of [
      `${SCOPE_STEP} || true`,
      `${SCOPE_STEP}; exit 0`,
      `${SCOPE_STEP}\n              continue-on-error: true`,
      `${SCOPE_STEP}\n              continue-on-error: \${{ true }}`,
      SCOPE_STEP.replace(/^( +)/gm, "$1# "),
      SCOPE_STEP.replace("- name:", "- if: always()\n              name:"),
      "",
    ]) {
      expect(rulesOf(mutate(WORKFLOW, SCOPE_STEP, to))).toEqual([
        "deploy-before-scope-check",
      ]);
    }
    const deployStep =
      "if: ${{ env.IS_SUPABASE_CONFIGURED }}\n              name: 📡 Deploy supabase functions";
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          deployStep,
          deployStep.replace("${{ env", "${{ always() && env"),
        ),
      ).sort(),
    ).toEqual([
      "deploy-before-remote-scope-check",
      "deploy-before-scope-check",
    ]);
    const withoutStep = mutate(WORKFLOW, SCOPE_STEP, "").content;
    expect(
      rulesOf({
        path: WORKFLOW,
        content: withoutStep.replace(
          "              run: npm run typecheck",
          `              run: npm run typecheck\n\n${SCOPE_STEP}`,
        ),
      }),
    ).toEqual(["deploy-before-scope-check"]);
    for (const to of [
      `${SCOPE_RECIPE} || true\n`,
      "\t-node scripts/production-scope.mjs\n",
      "",
    ]) {
      expect(rulesOf(mutate(MAKEFILE, `${SCOPE_RECIPE}\n`, to))).toEqual([
        "deploy-before-scope-check",
      ]);
    }
    for (const prefix of [
      ".ONESHELL:\n",
      ".IGNORE: supabase-deploy\n",
      "MAKEFLAGS += --ignore-errors\n",
      "DEPLOYED := $(shell npx supabase db push)\n",
    ]) {
      expect(
        rulesOf({ path: MAKEFILE, content: `${prefix}${read(MAKEFILE)}` }),
      ).toEqual(["deploy-before-scope-check"]);
    }
  });

  it("counts a scope check as blocking only when continue-on-error is statically false (closure)", () => {
    for (const value of [
      "${{ vars.CONTINUE }}",
      "${{ true }}",
      "'false'",
      "true",
    ]) {
      expect(
        rulesOf(
          mutate(
            WORKFLOW,
            SCOPE_STEP,
            `${SCOPE_STEP}\n              continue-on-error: ${value}`,
          ),
        ),
        value,
      ).toEqual(["deploy-before-scope-check"]);
    }
    for (const key of [
      '"continue-on-error": true',
      "continue-on-error : true",
    ]) {
      expect(
        rulesOf(
          mutate(WORKFLOW, SCOPE_STEP, `${SCOPE_STEP}\n              ${key}`),
        ),
        key,
      ).toEqual(["deploy-before-scope-check"]);
    }
    for (const value of [
      "false",
      "False",
      "${{ false }}",
      "false # reviewed",
    ]) {
      expect(
        rulesOf(
          mutate(
            WORKFLOW,
            SCOPE_STEP,
            `${SCOPE_STEP}\n              continue-on-error: ${value}`,
          ),
        ),
        value,
      ).toEqual([]);
    }
  });

  it("refuses a deploy or push no blocking hosted check precedes under the same condition (closure)", () => {
    for (const to of [
      "",
      `${REMOTE_STEP} || true`,
      `${REMOTE_STEP}\n              continue-on-error: \${{ vars.SOFT }}`,
      REMOTE_STEP.replace(/^( +)/gm, "$1# "),
      REMOTE_STEP.replace("IS_SUPABASE_CONFIGURED", "OTHER_FLAG"),
      REMOTE_STEP.replace('"$SUPABASE_PROJECT_ID"', '"$OTHER_PROJECT"'),
      REMOTE_STEP.replace(' --project-ref "$SUPABASE_PROJECT_ID"', " --linked"),
    ]) {
      expect(rulesOf(mutate(WORKFLOW, REMOTE_STEP, to)), to).toEqual([
        "deploy-before-remote-scope-check",
      ]);
    }
    const deployStep =
      "if: ${{ env.IS_SUPABASE_CONFIGURED }}\n              name: 📡 Deploy supabase functions";
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          deployStep,
          deployStep.replace(
            "${{ env.IS_SUPABASE_CONFIGURED }}",
            "${{ vars.DEPLOY }}",
          ),
        ),
      ),
    ).toEqual(["deploy-before-remote-scope-check"]);
    for (const to of [
      "",
      `${REMOTE_RECIPE} || true\n`,
      "\t-node scripts/production-scope.mjs --linked\n",
    ]) {
      expect(rulesOf(mutate(MAKEFILE, `${REMOTE_RECIPE}\n`, to)), to).toEqual([
        "deploy-before-remote-scope-check",
      ]);
    }
  });

  it("refuses a deploy path that rewrites its environment, or lists functions from another workdir (closure)", () => {
    for (const to of [
      `echo DEPLOY=1 >> $GITHUB_ENV && ${EXPLICIT}`,
      `echo ./bin >> $GITHUB_PATH && ${EXPLICIT}`,
    ]) {
      expect(rulesOf(mutate(WORKFLOW, WORKFLOW_EXPLICIT, to)), to).toEqual([
        "workflow-env-mutation",
      ]);
    }
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          WORKFLOW_EXPLICIT,
          `npx supabase functions list --workdir staging -o json && ${EXPLICIT}`,
        ),
      ),
    ).toEqual(["supabase-workdir-remote"]);
  });

  it("reads a step condition only as one plain line, and only env, vars and secrets in the hosted check's (closure)", () => {
    const ifLine = "if: ${{ env.IS_SUPABASE_CONFIGURED }}";
    for (const to of [
      REMOTE_STEP.replace(ifLine, "if: >-\n                ${{ false }}"),
      REMOTE_STEP.replace(
        ifLine,
        "if: ${{ env.IS_SUPABASE_CONFIGURED\n                && false }}",
      ),
      REMOTE_STEP.replace(
        ifLine,
        "if: env.IS_SUPABASE_CONFIGURED\n                && false",
      ),
      REMOTE_STEP.replace(ifLine, '"if": ${{ env.IS_SUPABASE_CONFIGURED }}'),
      REMOTE_STEP.replace(ifLine, "if : ${{ env.IS_SUPABASE_CONFIGURED }}"),
    ]) {
      expect(rulesOf(mutate(WORKFLOW, REMOTE_STEP, to)), to).toEqual([
        "deploy-before-remote-scope-check",
      ]);
    }
    const conditioned = (check, push = check) => ({
      path: WORKFLOW,
      content: `jobs:\n  fn:\n    steps:\n      - ${SCOPE_RUN}\n      - if: ${check}\n        ${REMOTE_RUN}\n      - if: ${push}\n        run: ${EXPLICIT}\n`,
    });
    for (const condition of [
      "${{ steps.decide.outputs.go }}",
      "${{ env.IS_SUPABASE_CONFIGURED && hashFiles('deploy.flag') != '' }}",
      "${{ github.event_name == 'push' }}",
    ]) {
      expect(rulesOf(conditioned(condition)), condition).toEqual([
        "deploy-before-remote-scope-check",
      ]);
    }
    for (const condition of [
      "${{ env.IS_SUPABASE_CONFIGURED }}",
      "${{ vars.DEPLOY == 'true' && secrets.SUPABASE_ACCESS_TOKEN != '' }}",
    ]) {
      expect(found(conditioned(condition)), condition).toEqual([]);
    }
    expect(
      rulesOf(
        conditioned(
          "${{ env.IS_SUPABASE_CONFIGURED }}",
          '"${{ env.IS_SUPABASE_CONFIGURED }}"',
        ),
      ),
    ).toEqual(["deploy-before-remote-scope-check"]);
  });

  it("refuses a deploy that runs after a failed check, or under a condition it cannot read (closure)", () => {
    const after = (condition) => ({
      path: WORKFLOW,
      content: `jobs:\n  fn:\n    steps:\n      - ${SCOPE_RUN}\n      - ${REMOTE_RUN}\n      - ${condition}\n        run: ${EXPLICIT}\n`,
    });
    expect(rulesOf(after("if: ${{ !success() }}"))).toEqual([
      "deploy-before-scope-check",
    ]);
    for (const condition of [
      '"if": ${{ always() }}',
      "if: >-\n          ${{ always() }}",
    ]) {
      expect(rulesOf(after(condition)), condition).toEqual([
        "deploy-before-remote-scope-check",
      ]);
    }
  });

  it("refuses a deploy aimed at a project other than the one the hosted check asked about (closure)", () => {
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          REMOTE_STEP,
          `${REMOTE_STEP}\n              env:\n                  SUPABASE_PROJECT_ID: abcdefghijabcdefghij`,
        ),
      ).sort(),
    ).toEqual(["deploy-before-remote-scope-check", "deploy-target-mismatch"]);
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          REMOTE_STEP,
          `${REMOTE_STEP}\n              shell: sh -c 'exit 0' {0}`,
        ),
      ).sort(),
    ).toEqual(["deploy-before-remote-scope-check", "workflow-shell-override"]);
    for (const [from, to, rule] of [
      [
        WORKFLOW_EXPLICIT,
        WORKFLOW_EXPLICIT.replace(
          " deploy ",
          " deploy --project-ref abcdefghijabcdefghij ",
        ),
        "deploy-target-mismatch",
      ],
      [
        "run: supabase db push",
        "run: supabase db push --project-ref abcdefghijabcdefghij",
        "deploy-target-mismatch",
      ],
      [
        "run: supabase link --project-ref $SUPABASE_PROJECT_ID",
        "run: supabase link --project-ref abcdefghijabcdefghij",
        "deploy-target-mismatch",
      ],
      [
        "run: supabase link --project-ref $SUPABASE_PROJECT_ID",
        "run: npx supabase link --project-ref $SUPABASE_PROJECT_ID",
        "deploy-target-mismatch",
      ],
      [
        "    deploy-supabase:\n",
        "    deploy-supabase:\n        defaults:\n            run:\n                shell: sh -c 'exit 0' {0}\n",
        "workflow-shell-override",
      ],
    ]) {
      expect(rulesOf(mutate(WORKFLOW, from, to)), to).toEqual([rule]);
    }
    for (const [from, to] of [
      [
        `${REMOTE_RECIPE}\n`,
        `${REMOTE_RECIPE}\n\tnpx supabase link --project-ref abcdefghijabcdefghij\n`,
      ],
      [
        "\tnpx supabase db push\n",
        "\tSUPABASE_PROJECT_ID=abcdefghijabcdefghij npx supabase db push\n",
      ],
      [
        "\tnpx supabase db push\n",
        "\tnpx supabase db push --project-ref abcdefghijabcdefghij\n",
      ],
    ]) {
      expect(rulesOf(mutate(MAKEFILE, from, to)), to).toEqual([
        "deploy-target-mismatch",
      ]);
    }
  });

  it("reads a make recipe continued with a backslash as one command (closure)", () => {
    for (const lead of ["\techo \\\n", "\ttrue || \\\n"]) {
      expect(
        rulesOf(
          mutate(MAKEFILE, `${REMOTE_RECIPE}\n`, `${lead}${REMOTE_RECIPE}\n`),
        ),
        lead,
      ).toEqual(["deploy-before-remote-scope-check"]);
      expect(
        rulesOf(
          mutate(MAKEFILE, `${SCOPE_RECIPE}\n`, `${lead}${SCOPE_RECIPE}\n`),
        ),
        lead,
      ).toEqual(["deploy-before-scope-check"]);
    }
  });

  it("reads only a step's own if key, and refuses a makefile step that can repoint the push (closure)", () => {
    const heredoc = {
      path: WORKFLOW,
      content: `jobs:\n  fn:\n    steps:\n      - ${SCOPE_RUN}\n      - if: \${{ vars.NEVER }}\n        ${REMOTE_RUN}\n      - run: |\n          cat <<'X' >/dev/null\n          if: \${{ vars.NEVER }}\n          X\n          ${EXPLICIT}\n`,
    };
    expect(rulesOf(heredoc)).toEqual(["deploy-before-remote-scope-check"]);
    const ifLine = "if: ${{ env.IS_SUPABASE_CONFIGURED }}";
    for (const to of [
      REMOTE_STEP.replace(ifLine, '"\\x69f": ${{ false }}'),
      REMOTE_STEP.replace(ifLine, "? if\n              : ${{ false }}"),
    ]) {
      expect(rulesOf(mutate(WORKFLOW, REMOTE_STEP, to)), to).toEqual([
        "deploy-before-remote-scope-check",
      ]);
    }
    expect(
      rulesOf(
        mutate(
          WORKFLOW,
          SCOPE_STEP,
          SCOPE_STEP.replace(
            "- name:",
            '- "\\x69f": ${{ false }}\n              name:',
          ),
        ),
      ),
    ).toEqual(["deploy-before-scope-check"]);
    for (const to of [
      "\techo abcdefghijabcdefghij > supabase/.temp/project-ref\n\tnpx supabase db push\n",
      "\t$(MAKE) relink\n\tnpx supabase db push\n",
      "\techo abcdefghijabcdefghij > supabase/.temp/project-ref && npx supabase db push\n",
    ]) {
      expect(
        rulesOf(mutate(MAKEFILE, "\tnpx supabase db push\n", to)),
        to,
      ).toEqual(["deploy-target-mismatch"]);
    }
  });

  it("refuses a deploy step repeated through a YAML alias (review 3)", () => {
    expect(
      rulesOf({
        path: WORKFLOW,
        content: `${read(WORKFLOW)}\n    redeploy:\n        runs-on: ubuntu-latest\n        steps:\n            - *deploy-functions\n`,
      }),
    ).toEqual(["workflow-command-unresolvable"]);
  });

  it("reads a YAML command however its scalar is spelled (review 2)", () => {
    expect(
      found(
        scopedWorkflow(
          ">\n          npx supabase functions deploy\n          users mcp",
        ),
      ),
    ).toEqual([`functions-deploy-unlisted ${WORKFLOW}:6`]);
    expect(
      found(
        scopedWorkflow(
          `>\n          ${DEPLOY_ALL}\n          ${PRODUCTION_FUNCTIONS.join(" ")}`,
        ),
      ),
    ).toEqual([]);
    expect(
      found(
        scopedWorkflow(
          "|2-\n          echo deploying supabase\n          npx supabase functions deploy mcp",
        ),
      ),
    ).toEqual([`functions-deploy-unlisted ${WORKFLOW}:8`]);
    expect(
      found(
        scopedWorkflow(`>\n          echo supabase\n\n          ${DEPLOY_ALL}`),
      ),
    ).toEqual([`functions-deploy-all ${WORKFLOW}:9`]);
  });

  it("does not let a comment ending in a backslash hide the next command (review)", () => {
    expect(
      found({
        path: MAKEFILE,
        content: `fn:\n${SCOPE_RECIPE}\n${REMOTE_RECIPE}\n\t# deploy everything \\\n\t${DEPLOY_ALL}\n`,
      }),
    ).toEqual([
      `functions-deploy-all ${MAKEFILE}:5`,
      `deploy-target-mismatch ${MAKEFILE}:4`,
    ]);
  });

  it("refuses the Management API, an expression-only run step and an unreadable subcommand (review)", () => {
    expect(
      found({
        path: ".github/workflows/api.yml",
        content:
          'jobs:\n  a:\n    steps:\n      - run: curl -X POST "https://api.supabase.com/v1/projects/$REF/functions/deploy?slug=mcp"\n      - run: ${{ vars.DEPLOY_CMD }}\n      - run: npx supabase functions $VERB\n',
      }),
    ).toEqual([
      "functions-deploy-api .github/workflows/api.yml:4",
      "supabase-subcommand-unresolvable .github/workflows/api.yml:6",
      "workflow-command-unresolvable .github/workflows/api.yml:5",
    ]);
  });

  it("refuses application or engine code pointing at the endpoint", () => {
    expect(
      found(
        {
          path: "src/components/atomic-crm/settings/Mcp.tsx",
          content:
            "const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/MCP`;\n",
        },
        {
          path: "engine/worker/tools.ts",
          content: 'await supabase.functions.invoke("mcp", { body });\n',
        },
      ),
    ).toEqual([
      "mcp-consumer src/components/atomic-crm/settings/Mcp.tsx:1",
      "mcp-consumer engine/worker/tools.ts:1",
    ]);
  });

  it("leaves prose alone", () => {
    expect(
      found({
        path: "docs/history.md",
        content: `It was deployed with \`${DEPLOY_ALL} mcp\` at /functions/v1/mcp.\n`,
      }),
    ).toEqual([]);
  });
});

describe("production scope: the development seed stays local", () => {
  it("refuses remote initialisation pushing the seed again", () => {
    const init = mutate(
      REMOTE_INIT,
      '      "--include-roles",\n',
      '      "--include-roles",\n      "--include-seed",\n',
    );
    expect(rulesOf(init)).toEqual(["remote-seed"]);
  });

  it("refuses a workflow or make target that pushes the seed", () => {
    expect(
      found(
        {
          path: ".github/workflows/seed.yml",
          content:
            "jobs:\n  db:\n    steps:\n      - run: npx supabase db push --include-seed\n",
        },
        {
          path: MAKEFILE,
          content: `db:\n${SCOPE_RECIPE}\n${REMOTE_RECIPE}\n\tnpx supabase@2 db push --linked --include-seed\n`,
        },
      ),
    ).toEqual([
      "remote-seed .github/workflows/seed.yml:4",
      "remote-seed makefile:4",
    ]);
  });

  it("refuses a remote reset, however it is spelled (review 3)", () => {
    expect(
      found(
        {
          path: MAKEFILE,
          content:
            'reset:\n\tnpx supabase db reset --linked\n\tnpx supabase db --linked reset\n\tnpx supabase db reset --db-url "postgresql://postgres:pw@db.abc.supabase.co:5432/postgres"\n',
        },
        {
          path: ".github/workflows/reset.yml",
          content:
            "jobs:\n  r:\n    steps:\n      - run: >\n          npx supabase db reset\n          --linked\n",
        },
        {
          path: ".github/workflows/staging.yml",
          content:
            "jobs:\n  s:\n    steps:\n      - run: npx supabase db reset\n          --debug\n            --linked\n",
        },
        {
          path: "docker-compose.staging.yml",
          content:
            "services:\n  reset:\n    command: [npx, supabase, db, reset, --linked]\n",
        },
        {
          path: "scripts/reset.sh",
          content: "npx -p supabase supabase db reset --linked\n",
        },
        {
          path: "scripts/reset-remote.mjs",
          content:
            'await execa("npx", [\n  "supabase",\n  "db",\n  "reset",\n  "--linked",\n]);\n',
        },
        {
          path: "scripts/reset-staging.mjs",
          content:
            'await execa("supabase", ["db", "reset", "--linked"], { stdio: "inherit" });\n',
        },
        {
          path: "scripts/reset-url.mjs",
          content:
            'await execa("npx", [\n  "supabase", "db", "reset", "--db-url",\n  process.env["SUPABASE_DB_URL"],\n]);\n',
        },
        {
          path: "scripts/reset-zx.mjs",
          content:
            'import { $ } from "zx";\nawait $`npx supabase db reset --linked`;\n',
        },
      ),
    ).toEqual([
      "remote-db-reset makefile:2",
      "remote-db-reset makefile:3",
      "remote-db-reset makefile:4",
      "remote-db-reset .github/workflows/reset.yml:4",
      "remote-db-reset .github/workflows/staging.yml:4",
      "remote-db-reset docker-compose.staging.yml:3",
      "remote-db-reset scripts/reset.sh:1",
      "remote-db-reset scripts/reset-remote.mjs:1",
      "remote-db-reset scripts/reset-staging.mjs:1",
      "remote-db-reset scripts/reset-url.mjs:1",
      "remote-db-reset scripts/reset-zx.mjs:2",
    ]);
  });

  it("refuses a seed file named anywhere outside the reviewed local uses (review 3)", () => {
    expect(
      found(
        {
          path: ".github/workflows/seed.yml",
          content:
            'jobs:\n  s:\n    steps:\n      - run: |\n          SEED=supabase/seed.sql\n          psql "$SUPABASE_DB_URL" -f "$SEED"\n',
        },
        {
          path: "scripts/seed-remote.mjs",
          content:
            'const sql = readFileSync("supabase/seed.sql", "utf8");\nawait client.query(sql);\n',
        },
        {
          path: "scripts/seed-glob.sh",
          content: 'psql "$SUPABASE_DB_URL" -f supabase/seed*.sql\n',
        },
        {
          path: "scripts/seed-dir.sh",
          content:
            'for f in supabase/seeds/*.sql; do psql "$STAGING_DB_URL" -f "$f"; done\n',
        },
      ),
    ).toEqual([
      "seed-file-reference .github/workflows/seed.yml:5",
      "seed-file-reference scripts/seed-remote.mjs:1",
      "seed-file-reference scripts/seed-glob.sh:1",
      "seed-file-reference scripts/seed-dir.sh:1",
    ]);
    const line = 'const seed = readFileSync(join(HERE, "seed.sql"), "utf8");';
    expect(
      rulesOf(
        mutate(
          "supabase/schemaReproducibility.test.ts",
          line,
          `${line} await remote.query(seed);`,
        ),
      ),
    ).toEqual(["seed-file-reference"]);
  });

  it("refuses a glob that can expand to the seed file, in any file (closure)", () => {
    const globs = [
      'psql "$DB" -f supabase/*.sql',
      'for f in supabase/*.sql; do psql "$DB" -f "$f"; done',
      "cat supabase/**/*.sql",
      "cat supabase/s*.sql",
      "cat supabase/se?d.sql",
      "cat supabase/[s]eed.sql",
      "cat supabase/{seed,other}.sql",
      "cat supabase/seed.s?l",
      'cat "supabase/"*.sql',
      'cat "$ROOT"/supabase/*.sql',
      "cd supabase && psql -f *.sql",
    ];
    expect(
      found(
        {
          path: "scripts/seed-remote.sh",
          content: `${globs.join("\n")}\n`,
        },
        {
          path: ".github/workflows/seed.yml",
          content:
            'jobs:\n  s:\n    steps:\n      - run: psql "$DB" -f supabase/*.sql\n',
        },
        {
          path: "scripts/seed.mjs",
          content:
            'const files = globSync("supabase/*.sql");\nconst more = glob(`${root}/supabase/*.sql`);\n',
        },
      ),
    ).toEqual([
      ...globs.map(
        (_, i) => `seed-file-reference scripts/seed-remote.sh:${i + 1}`,
      ),
      "seed-file-reference .github/workflows/seed.yml:4",
      "seed-file-reference scripts/seed.mjs:1",
      "seed-file-reference scripts/seed.mjs:2",
    ]);
    expect(
      rulesOf(
        mutate(
          MAKEFILE,
          "supabase-deploy:",
          'seed-staging:\n\tpsql "$(DB)" -f supabase/*.sql\n\nsupabase-deploy:',
        ),
      ),
    ).toEqual(["seed-file-reference"]);
  });

  it("accepts globs that cannot reach the seed file (closure)", () => {
    expect(
      found({
        path: "scripts/local-tools.sh",
        content: [
          'psql "$DB" -f supabase/migrations/*.sql',
          "ls supabase/tests/*.sql",
          'ls "$workdir"/supabase/migrations/*_e2e_throwaway.sql',
          'include: ["src/**/*"]',
          "class: transition-[color,box-shadow]",
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("refuses the seed glob spellings the closure review found (closure)", () => {
    for (const glob of [
      "supabase/seed.*",
      "supabase/*.{sql,ts}",
      "supabase/se*",
      "-name 'seed.*'",
      "supabase/seed[.]sql",
      "supabase/seed.[s]ql",
      "supabase/seed.[Ss][Qq][Ll]",
      "supabase/seed{.,}sql",
      "supabase/[[:alpha:]]eed.sql",
      "supabase/{s{e,x}ed,y}.sql",
      `supabase/*.sql{${",".repeat(200)}}`,
    ]) {
      expect(
        rulesOf({ path: "scripts/seed-remote.sh", content: `cat ${glob}\n` }),
        glob,
      ).toEqual(["seed-file-reference"]);
    }
    expect(
      found({
        path: "scripts/local-tools.sh",
        content: "ls supabase/*\ndu -sh supabase/**\n",
      }),
    ).toEqual([]);
  });

  it("refuses a brace sequence, or a glob too long to read, that can reach the seed file (closure)", () => {
    for (const glob of [
      "supabase/{r..t}eed.sql",
      "supabase/s{e..e}ed.sql",
      `supabase/se[${"e".repeat(210)}]d.*`,
    ]) {
      expect(
        rulesOf({
          path: "scripts/seed-remote.sh",
          content: `cat ${glob} | psql\n`,
        }),
        glob,
      ).toEqual(["seed-file-reference"]);
    }
  });

  it("refuses seed configuration in an inline table, however it is spelled (closure)", () => {
    for (const content of [
      '[db]\nseed = { enabled = true, "sql_paths" = ["./*.sql"] }\n',
      "[db]\nseed = { enabled = true, 'sql_paths' = ['./*.sql'] }\n",
      '[db]\nseed = { enabled = true, sql_paths = [\n  "./*.sql",\n] }\n',
      'db = { seed = { sql_paths = ["./*.sql"] } }\n',
      "[remotes.staging]\ndb = { seed = { enabled = true } }\n",
      "remotes = { staging = { db = { seed = { enabled = true } } } }\n",
      "remotes.staging.db = { seed = { enabled = true } }\n",
    ]) {
      expect(rulesOf({ path: CONFIG, content }), content).toEqual([
        "seed-file-reference",
      ]);
    }
    expect(
      found({ path: CONFIG, content: "[db]\nseed = { enabled = false }\n" }),
    ).toEqual([]);
  });

  it("refuses changed seed paths, an inline seed table and a remote seed table (review 3)", () => {
    for (const content of [
      '[db.seed]\nsql_paths = ["./data/reference.sql"]\n',
      '[db]\nseed = { enabled = true, sql_paths = ["./data/reference.sql"] }\n',
    ]) {
      expect(found({ path: CONFIG, content })).toEqual([
        `seed-file-reference ${CONFIG}:2`,
      ]);
    }
    expect(
      found({
        path: CONFIG,
        content: "[remotes.staging.db.seed]\nenabled = true\n",
      }),
    ).toEqual([
      `seed-file-reference ${CONFIG}:1`,
      `seed-file-reference ${CONFIG}:2`,
    ]);
  });

  it("accepts the local and CI paths that seed on purpose", () => {
    expect(
      found(
        { path: MAKEFILE, content: read(MAKEFILE) },
        {
          path: ".github/workflows/check.yml",
          content: read(".github/workflows/check.yml"),
        },
        {
          path: ".github/workflows/database.yml",
          content: read(".github/workflows/database.yml"),
        },
        {
          path: ".claude/scripts/e2e-smoke.sh",
          content: read(".claude/scripts/e2e-smoke.sh"),
        },
        {
          path: "scripts/local.mjs",
          content:
            'await execa("npx", ["supabase", "db", "reset", "--db-url", "postgresql://postgres:postgres@127.0.0.1:54342/postgres"]);\n',
        },
        {
          path: "scripts/local.sh",
          content: "npx supabase db reset --workdir .supabase-e2e --local\n",
        },
      ),
    ).toEqual([]);
  });

  it("reads comments too, so a comment naming the flag is refused like a command", () => {
    expect(
      found({
        path: REMOTE_INIT,
        content: "// Never pass --include-seed here.\n",
      }),
    ).toEqual([`remote-seed ${REMOTE_INIT}:1`]);
  });
});
