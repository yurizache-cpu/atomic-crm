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
// three adversarial reviews got past earlier versions of this guard. Function
// source attacks live in production-scope-functions.test.mjs.

const DEPLOY_ALL = "npx supabase functions deploy";
const EXPLICIT = `${DEPLOY_ALL} ${PRODUCTION_FUNCTIONS.join(" ")}`;
const WORKFLOW = ".github/workflows/deploy.yml";
const MAKEFILE = "makefile";
const REMOTE_INIT = "scripts/supabase-remote-init.mjs";
const SCOPE_RUN = "run: node scripts/production-scope.mjs";
const SCOPE_RECIPE = "\tnode scripts/production-scope.mjs";
const SCOPE_STEP = `            - name: 🔒 Production scope (reviewed functions only, no development seed)\n              ${SCOPE_RUN}`;
/** A deploy.yml whose one job runs the scope check, then `run`. */
const scopedWorkflow = (run) => ({
  path: WORKFLOW,
  content: `jobs:\n  fn:\n    steps:\n      - ${SCOPE_RUN}\n      - run: ${run}\n`,
});

describe("production scope: the committed repository", () => {
  it("keeps the MCP function and the development seed out of every deployment path", () => {
    expect(checkProductionScope(readTrackedFiles())).toEqual([]);
  });

  it("deploys exactly the reviewed functions, after the scope check, from deploy.yml and the makefile", () => {
    for (const path of [WORKFLOW, MAKEFILE]) {
      const content = read(path);
      expect(content).toContain(EXPLICIT);
      const scope = content.indexOf("node scripts/production-scope.mjs");
      expect(scope).toBeGreaterThan(-1);
      expect(scope).toBeLessThan(content.indexOf(EXPLICIT));
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
      expect(rulesOf(mutate(WORKFLOW, EXPLICIT, to))).toEqual([rule]);
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
      expect(rulesOf(mutate(path, EXPLICIT, to))).toEqual([rule]);
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
      expect(rulesOf(mutate(WORKFLOW, EXPLICIT, to))).toEqual([
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
          EXPLICIT,
          `${EXPLICIT} --import-map supabase/map.json`,
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
      ),
    ).toEqual(["deploy-before-scope-check"]);
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
    ).toEqual([`functions-deploy-unlisted ${WORKFLOW}:5`]);
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
    ).toEqual([`functions-deploy-unlisted ${WORKFLOW}:7`]);
    expect(
      found(
        scopedWorkflow(`>\n          echo supabase\n\n          ${DEPLOY_ALL}`),
      ),
    ).toEqual([`functions-deploy-all ${WORKFLOW}:8`]);
  });

  it("does not let a comment ending in a backslash hide the next command (review)", () => {
    expect(
      found({
        path: MAKEFILE,
        content: `fn:\n${SCOPE_RECIPE}\n\t# deploy everything \\\n\t${DEPLOY_ALL}\n`,
      }),
    ).toEqual([`functions-deploy-all ${MAKEFILE}:4`]);
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
          content: `db:\n${SCOPE_RECIPE}\n\tnpx supabase@2 db push --linked --include-seed\n`,
        },
      ),
    ).toEqual([
      "remote-seed .github/workflows/seed.yml:4",
      "remote-seed makefile:3",
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
