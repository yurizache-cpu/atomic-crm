import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readTrackedFiles } from "../dev-signing-key.mjs";
import { checkDeployGate } from "../production-scope.mjs";
import { read } from "./production-scope-helpers.mjs";

// Phase 1D.2: a push to main starts check.yml and deploy.yml as two workflow
// runs, and `needs:` cannot cross them, so the hosted database deploy used to
// run before, or despite, a red live-database job. Every "refuses" case below
// is a way to get that back, applied to the real workflow files. The database
// push, function deploy and key-check steps are cut from the real deploy.yml:
// this file writes out no push or function deploy of its own, only link,
// --linked and --db-url commands and respelled ones, which the deploy-order
// rules do not match. A fixture the scope rules would read as a subcommand
// they cannot resolve is assembled at run time from a separate value.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "deploy-without-database-gate";
const DEPLOY = ".github/workflows/deploy.yml";
const CHECK = ".github/workflows/check.yml";
const GATE = ".github/workflows/database.yml";
const HOTFIX = ".github/workflows/hotfix.yml";
const NEEDS = "        needs: [gate, database]\n";
const CALL = "        uses: ./.github/workflows/database.yml\n";
const CHECKOUT = "              uses: actions/checkout@v4\n";
const DEPLOY_JOB = "    deploy-supabase:\n";
const DRAFT =
  "        if: ${{ !github.event.pull_request.draft || github.event_name == 'push' }}\n        permissions:\n";
const NEL = String.fromCharCode(0x85);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
/** The suites the gate must run, in order: the spec, independent of the guard's own list. */
const SUITES = [
  "npx supabase start",
  "npm run test:db",
  "npm run test:db:engine",
  "npm run test:db:upgrade -- --workdir .",
  "npx supabase db reset --local --no-seed",
  "node supabase/tests/referenceData.mjs --without-seed",
  "npx supabase db reset --local",
  "npm run test:db",
];

let tracked;
const trackedFiles = () => (tracked ??= readTrackedFiles());

/** The tracked tree with each change applied; `content: null` removes a file. */
const treeWith = (changes) => {
  const changed = new Set(changes.map((c) => c.path));
  return [
    ...trackedFiles().filter((f) => !changed.has(f.path)),
    ...changes.filter((c) => c.content !== null),
  ];
};

/** `rule file` for each distinct refusal of the tree with these changes. */
const refusals = (...changes) => [
  ...new Set(
    checkDeployGate(treeWith(changes)).map((v) => `${v.rule} ${v.file}`),
  ),
];

/** A real file with `from` replaced by `to`, after proving `from` is there. */
const edit = (path, from, to) => {
  const real = read(path);
  expect(real, path).toContain(from);
  return { path, content: real.replace(from, to) };
};

/** `edit` on each workflow. */
const deploy = (from, to) => edit(DEPLOY, from, to);
const gate = (from, to) => edit(GATE, from, to);
const check = (from, to) => edit(CHECK, from, to);

/** The real deploy-supabase job, as text: it links, checks and pushes. */
const deployJob = () => {
  const text = read(DEPLOY);
  expect(text).toContain(DEPLOY_JOB);
  return text.slice(text.indexOf(DEPLOY_JOB));
};

/** deploy.yml with `change` applied to the deploy-supabase job only. */
const editDeployJob = (change) => {
  const job = deployJob();
  const changed = change(job);
  expect(changed).not.toBe(job);
  const text = read(DEPLOY);
  return { path: DEPLOY, content: text.replace(job, changed) };
};

/** The real deploy-supabase steps whose names contain one of `names`. */
const deploySteps = (...names) => {
  const steps = deployJob()
    .split(/(?=^ {12}- )/m)
    .filter((step) => names.some((name) => step.includes(name)));
  expect(steps).toHaveLength(names.length);
  return steps;
};

/** The real database push, as its run value. */
const pushRun = () =>
  deploySteps("Push supabase migrations")[0].match(/run: (.+)/)[1];

/** deploy.yml with one more job at the end. */
const appended = (job) => ({
  path: DEPLOY,
  content: `${read(DEPLOY)}\n${job}`,
});

/** A deploy.yml job that needs only `gate` and runs `run`. */
const withJob = (id, run, needs = "gate") =>
  appended(
    `    ${id}:\n        needs: ${needs}\n        runs-on: ubuntu-latest\n        steps:\n            - run: ${run}\n`,
  );

/** A workflow of its own with these jobs. */
const workflow = (path, jobs, on = "    workflow_dispatch:\n") => ({
  path,
  content: `name: Extra\non:\n${on}\njobs:\n${jobs}`,
});

/** An ungated job holding a Supabase token and running `run`. */
const credentialed = (run) =>
  workflow(
    HOTFIX,
    `    hotfix:\n        runs-on: ubuntu-latest\n        env:\n            SUPABASE_ACCESS_TOKEN: \${{ secrets.SUPABASE_ACCESS_TOKEN }}\n        steps:\n            - uses: actions/checkout@v4\n            - run: ${run}\n`,
  );

/** A local composite action running `run`, and an ungated job using it. */
const localAction = (run, path = ".github/actions/migrate") => [
  {
    path: `${path}/action.yml`,
    content: `name: Migrate\nruns:\n    using: composite\n    steps:\n        - run: ${run}\n          shell: bash\n`,
  },
  workflow(
    HOTFIX,
    "    hotfix:\n        runs-on: ubuntu-latest\n        steps:\n            - uses: actions/checkout@v4\n            - uses: ./.github/actions/migrate\n",
  ),
];

/** The real gate, with `change(lines, suiteLines)` applied to its lines. */
const gateEdit = (change) => {
  const lines = read(GATE).split("\n");
  const runs = lines.flatMap((line, i) =>
    /^ {14}run: /.test(line) ? [i] : [],
  );
  expect(runs.map((i) => lines[i].trim())).toEqual(
    ["npm ci", ...SUITES].map((run) => `run: ${run}`),
  );
  // runs[0] is `npm ci`; runs[k + 1] is SUITES[k].
  change(lines, runs.slice(1), runs[0]);
  return { path: GATE, content: lines.join("\n") };
};

/** A gate with `text` inserted after the run line of SUITES[k]. */
const afterSuite = (k, text) =>
  gateEdit((lines, suites) => lines.splice(suites[k] + 1, 0, text));

/** A gate with `text` inserted as a step before the first suite. */
const beforeSuites = (text) =>
  gateEdit((lines, suites) => lines.splice(suites[0] - 1, 0, text));

const expectRefused = (path, changes) => {
  for (const change of changes) {
    const all = [change].flat();
    const label = all.map((c) => c.content ?? `${c.path} removed`).join("\n");
    expect(refusals(...all), label.slice(-300)).toEqual([`${RULE} ${path}`]);
  }
};

describe("production scope: the live database gates every hosted deploy (Phase 1D.2)", () => {
  it("gates the committed deploy on the database suites", () => {
    expect(trackedFiles().map((f) => f.path)).toEqual(
      expect.arrayContaining([DEPLOY, CHECK, GATE]),
    );
    expect(checkDeployGate(trackedFiles())).toEqual([]);
  });

  it("refuses a hosted deploy that does not directly wait for a plain call of the gate", () => {
    const changes = [
      [NEEDS, "        needs: gate\n"],
      [NEEDS, "        needs:\n            - gate\n"],
      [NEEDS, "        needs: [gate, databse]\n"],
      [NEEDS, `${NEEDS}        if: \${{ always() }}\n`],
      [NEEDS, `${NEEDS}        if: \${{ !cancelled() }}\n`],
      [NEEDS, `${NEEDS}        if: \${{ true }}\n`],
      // Keys are case-insensitive to this rule, whatever GitHub makes of them.
      [NEEDS, `${NEEDS}        If: \${{ always() }}\n`],
      [NEEDS, `${NEEDS}        IF: \${{ always() }}\n`],
      // A condition behind a comment and a lone CR, or a line starting with
      // one: a YAML reader sees the key, a split on LF does not.
      [
        NEEDS,
        `${NEEDS}        # run even when the gate fails\r        if: \${{ always() }}\n`,
      ],
      [NEEDS, `${NEEDS}\r        if: \${{ always() }}\n`],
      [NEEDS, `${NEEDS}        # note${NEL}        if: \${{ always() }}\n`],
      [
        NEEDS,
        `${NEEDS}        # note${LINE_SEPARATOR}        if: \${{ always() }}\n`,
      ],
      // A quoted value left open swallows the needs line after it.
      [
        NEEDS,
        "        environment: 'production\n        needs: [gate, database] #'\n",
      ],
      // Spellings it would have to guess at, even where the last reading
      // would pass: a second needs, a quoted key hiding a condition.
      [NEEDS, `${NEEDS}        needs: gate\n`],
      [NEEDS, `        needs: gate\n${NEEDS}`],
      [NEEDS, `${NEEDS}        "if": \${{ always() }}\n`],
      [NEEDS, '        "needs": [gate, database]\n'],
      [NEEDS, "        needs: gate, database\n"],
      [NEEDS, `${NEEDS}        \tif: \${{ always() }}\n`],
      [CALL, `        if: \${{ github.event_name != 'push' }}\n${CALL}`],
      [CALL, "        uses: ./.github/workflows/other.yml\n"],
      [CALL, "        uses: ./.github/workflows/database.yml@main\n"],
      [
        CALL,
        "        uses: someone/repo/.github/workflows/database.yml@main\n",
      ],
      [CALL, `${CALL}        secrets: inherit\n`],
      [CALL, `${CALL}        with:\n            suites: none\n`],
      [CALL, `${CALL}        needs: gate\n`],
      [CALL, `${CALL}        strategy:\n            fail-fast: false\n`],
      [CALL, `${CALL}        concurrency: gate\n`],
      ["    database:\n", "    database: &gate\n"],
    ];
    // Two jobs with the gate's id: one reader takes the first, another the last.
    const other = deploy(CALL, "        uses: ./.github/workflows/other.yml\n");
    const twice = `${other.content}\n    database:\n        name: Gate\n${CALL}`;
    expectRefused(DEPLOY, [
      ...changes.map(([from, to]) => deploy(from, to)),
      { path: DEPLOY, content: twice },
    ]);
  });

  it("refuses a deploy that ships another tree than the one the gate tested, or deploys on another trigger", () => {
    const git =
      "                  git config --global user.name github-actions-bot\n";
    const withInput = (input) =>
      editDeployJob((job) =>
        job.replace(
          CHECKOUT,
          `${CHECKOUT}              with:\n                  ${input}\n`,
        ),
      );
    const afterGit = (command) =>
      editDeployJob((job) =>
        job.replace(git, `${git}                  ${command}\n`),
      );
    expectRefused(DEPLOY, [
      withInput("ref: release-candidate"),
      withInput("repository: someone/fork"),
      withInput("path: elsewhere"),
      editDeployJob((job) =>
        job.replace(
          CHECKOUT,
          `${CHECKOUT}              With:\n                  ref: release-candidate\n`,
        ),
      ),
      editDeployJob((job) =>
        job.replace(
          CHECKOUT,
          `${CHECKOUT}\n            - uses: actions/checkout@v4\n`,
        ),
      ),
      afterGit("git fetch origin release && git checkout FETCH_HEAD"),
      afterGit("git switch release"),
      afterGit("git -C ../release log -1"),
      afterGit("gh pr checkout 12"),
      editDeployJob((job) =>
        job.replace(
          "        env:\n",
          "        env:\n            GIT_WORK_TREE: ../release\n",
        ),
      ),
      deploy("on:\n    push:\n", "on:\n    pull_request_target:\n    push:\n"),
      deploy(
        "on:\n    push:\n        branches:\n            - main\n",
        "on: [push, workflow_run]\n",
      ),
      deploy("on:\n", '"on":\n'),
      // A top level or a step it cannot read, in a workflow that deploys.
      deploy("concurrency:\n", "'concurrency':\n"),
      deploy(
        "concurrency:\n",
        "permissions:\n    contents: write\n\nconcurrency:\n",
      ),
      editDeployJob((job) =>
        job.replace("            - name: ", "            - name: &first "),
      ),
      // A tab-indented condition, which a line reader would file under env.
      editDeployJob((job) =>
        job.replace(
          "\n        steps:\n",
          "        \tif: ${{ always() }}\n\n        steps:\n",
        ),
      ),
    ]);
    // A deploy after check.yml, through workflow_run, with its own gate call.
    const afterCheck = ".github/workflows/after-check.yml";
    const gated = `    database:\n        name: Gate\n${CALL}${deployJob().replace(NEEDS, "        needs: database\n")}`;
    expectRefused(afterCheck, [
      workflow(
        afterCheck,
        gated,
        "    workflow_run:\n        workflows: [Check]\n        types: [completed]\n",
      ),
      workflow(
        afterCheck,
        gated.replace(
          CHECKOUT,
          `${CHECKOUT}              with:\n                  ref: \${{ github.event.workflow_run.head_sha }}\n`,
        ),
      ),
    ]);
  });

  it("refuses a second deploying job, however it reaches the hosted project", () => {
    const copy = deployJob()
      .replace(DEPLOY_JOB, "    deploy-again:\n")
      .replace(NEEDS, "        needs: gate\n");
    const job = (id, lines) =>
      `    ${id}:\n        needs: gate\n${lines.map((l) => `        ${l}\n`).join("")}`;
    const subcommand = "$SUB";
    const expression = "${{ 'db' }} push";
    expectRefused(DEPLOY, [
      appended(copy),
      // A step repeated through an alias, and a step list no rule reads.
      appended(
        job("redeploy", ["runs-on: ubuntu-latest", "steps:", "    - *deploy"]),
      ),
      appended(
        job("relink", [
          "runs-on: ubuntu-latest",
          "steps: [{ run: npx supabase link --project-ref abcdefghijabcdefghij }]",
        ]),
      ),
      withJob("migrate", "npx supabase migration up --linked"),
      withJob("dump", 'npx supabase db dump --db-url "$DATABASE_URL"'),
      // Respelled for the shell, continued over a line, or with a subcommand
      // no rule can read.
      withJob("respelled", String.raw`npx supa\base db push`),
      withJob("split", 'npx supa""base db push'),
      withJob(
        "continued",
        "|\n                npx supabase \\\n                  db push",
      ),
      withJob("computed", `npx supabase ${subcommand}`),
      withJob("expression", `npx supabase ${expression}`),
      // Through the makefile: its own target, a prerequisite, a sub-make, and
      // a make pointed at a makefile this rule does not read.
      withJob("make-deploy", "make supabase-deploy"),
      withJob("make-prod", "make build prod-deploy"),
      withJob("make-init", "make supabase-remote-init"),
      withJob("make-elsewhere", "make -C tools release"),
      withJob("make-computed", "make ${{ vars.TARGET }}"),
      // No readable command at all, but a credential or a machine GitHub does
      // not host: without either, the CLI cannot authenticate.
      appended(
        job("sync", [
          "runs-on: ubuntu-latest",
          "env:",
          "    TOKEN: ${{ secrets.PROD_TOKEN }}",
          "steps:",
          "    - run: node scripts/sync.mjs",
        ]),
      ),
      appended(
        job("dump-all", [
          "runs-on: ubuntu-latest",
          "steps:",
          "    - run: echo '${{ toJSON(SECRETS) }}' > all.json",
        ]),
      ),
      appended(
        job("release", [
          "uses: ./.github/workflows/release.yml",
          "secrets: inherit",
        ]),
      ),
      appended(
        job("local", ["runs-on: self-hosted", "steps:", "    - run: npm ci"]),
      ),
      appended(
        job("labelled", [
          "runs-on: [self-hosted, linux]",
          "steps:",
          "    - run: npm ci",
        ]),
      ),
    ]);
    // A target that starts to deploy makes every job running it a deploy.
    expectRefused(DEPLOY, [
      edit(
        "makefile",
        "doc-build:\n\t@(cd doc && npm run build)\n",
        "doc-build:\n\t@(cd doc && npm run build)\n\t$(MAKE) supabase-deploy\n",
      ),
    ]);
  });

  it("refuses a hosted deploy in any workflow, not only deploy.yml", () => {
    const steps = deploySteps(
      "Project does not trust",
      "Supabase Link",
      "Push supabase migrations",
    );
    const minimal = `    hotfix:\n        runs-on: ubuntu-latest\n        steps:\n${steps.join("")}`;
    // A whole job behind comments ending in a lone CR.
    const hidden = [
      "    # h\r    hotfix:",
      "    # a\r        runs-on: ubuntu-latest",
      "    # b\r        steps:",
      `    # c\r            - run: ${pushRun()}`,
    ].join("\n");
    const noop =
      "    noop:\n        runs-on: ubuntu-latest\n        steps:\n            - run: echo ok\n";
    expectRefused(HOTFIX, [
      workflow(HOTFIX, minimal),
      workflow(HOTFIX, deployJob().replace(NEEDS, "")),
      // It names jobs that exist only in deploy.yml.
      workflow(HOTFIX, deployJob()),
      // A workflow from another repository runs steps no rule can read.
      workflow(
        HOTFIX,
        "    release:\n        uses: someone/repo/.github/workflows/release.yml@v1\n",
      ),
      workflow(HOTFIX, `${noop}${hidden}\n`),
      // A credential for every job, and a shell every step runs in.
      {
        path: HOTFIX,
        content: `name: Extra\non:\n    workflow_dispatch:\n\nenv:\n    TOKEN: \${{ secrets.PROD_TOKEN }}\n\njobs:\n${noop}`,
      },
      {
        path: HOTFIX,
        content: `name: Extra\non:\n    workflow_dispatch:\n\ndefaults:\n    run:\n        shell: npx supabase link --project-ref $REF {0}\n\njobs:\n${noop}`,
      },
      // A step its reader cannot place might deploy: it needs the gate, and
      // a gated deploy may not have one.
      workflow(
        HOTFIX,
        "    odd:\n        runs-on: ubuntu-latest\n        steps:\n            - - run: echo odd\n",
      ),
      workflow(
        HOTFIX,
        `    database:\n        name: Gate\n${CALL}${deployJob().replace(NEEDS, "        needs: database\n")}            - - run: echo odd\n`,
      ),
      // Respelled commands, readable or not, in a job holding a credential.
      credentialed('SB=$(command -v supabase); "$SB" db push'),
      credentialed("echo db push | xargs npx supabase"),
      credentialed(
        'mkdir -p supabase/.temp && echo "$REF" > supabase/.temp/project-ref && npx supabase functions delete users',
      ),
      // A local action: what it runs, one this rule cannot find, and one it
      // reaches through another.
      localAction('npx supabase migration up --db-url "$DB_URL"'),
      localAction("npx supabase link --project-ref $REF"),
      localAction("npm ci", ".github/actions/other"),
      localAction(
        "npm ci\n          shell: bash\n        # x\r        - run: npx supabase link --project-ref $REF",
      ),
      // A step the step reader drops, which calls a local action that links.
      [
        localAction("npx supabase link --project-ref $REF")[0],
        workflow(
          HOTFIX,
          "    hotfix:\n        runs-on: ubuntu-latest\n        steps:\n            - run: echo ok\n          - uses: ./.github/actions/migrate\n",
        ),
      ],
      [
        {
          path: ".github/actions/migrate/action.yml",
          content:
            "name: Migrate\nruns:\n    using: composite\n    steps:\n        - uses: ./.github/actions/link\n",
        },
        {
          path: ".github/actions/link/action.yml",
          content:
            "name: Link\nruns:\n    using: composite\n    steps:\n        - run: npx supabase link --project-ref $REF\n          shell: bash\n",
        },
        localAction("unused")[1],
      ],
    ]);
    expectRefused(DEPLOY, [
      { path: DEPLOY, content: `${read(DEPLOY)}${hidden}\n` },
    ]);
  });

  it("refuses a database gate that can pass without running every suite", () => {
    const job = "        timeout-minutes: 25\n";
    const top = "permissions:\n    contents: read\n";
    // One fixture per line: a table, like the guards' own.
    // prettier-ignore
    expectRefused(GATE, [
      { path: GATE, content: null },
      // Each suite removed with its step name, each pair of neighbouring
      // suites swapped, and each suite allowed to fail.
      ...SUITES.map((_, k) => gateEdit((lines, suites) => lines.splice(suites[k] - 1, 2))),
      ...SUITES.slice(1).map((_, k) =>
        gateEdit((lines, suites) => {
          [lines[suites[k]], lines[suites[k + 1]]] = [lines[suites[k + 1]], lines[suites[k]]];
        }),
      ),
      ...SUITES.flatMap((_, k) => [
        gateEdit((lines, suites) => (lines[suites[k]] += " || true")),
        gateEdit((lines, suites) => (lines[suites[k]] += "; exit 0")),
      ]),
      // A suite that is not what the step runs: an input of another action,
      // a folded name, a quoted name left open, a block running something
      // else, a name turned into a condition.
      gateEdit((lines, suites) => suites.forEach((i) => (lines[i] = lines[i].replace(/run: (.*)/, "uses: actions/checkout@v4\n              with:\n                  run: $1")))),
      gateEdit((lines, suites) => lines.splice(suites[1] - 1, 2, "            - name: >-\n                Database suites\n                run: npm run test:db", '              run: "true"')),
      gateEdit((lines, suites) => lines.splice(suites[2] - 1, 2, "            - name: 'Worker suites", "              run: npm run test:db:engine #'")),
      gateEdit((lines, suites) => (lines[suites[2]] = "              run: |\n                  echo skipped\n            - name: Worker\n              run: npm run test:db:engine")),
      gateEdit((lines, suites) => (lines[suites[1] - 1] = "            - if: ${{ false }}")),
      // A step added anywhere, or added to `npm ci`, can make every suite a
      // no-op, or test another commit; so can a checkout or node input.
      beforeSuites("            - name: Prepare\n              run: npm pkg set scripts.test:db=true scripts.test:db:engine=true scripts.test:db:upgrade=true\n"),
      beforeSuites("            - name: Prepare\n              run: echo NODE_OPTIONS=--require=./x.cjs >> \"$(printenv | sed -n 's/^GITHUB_E.V=//p')\"\n"),
      beforeSuites("            - uses: someone/skip-action@v1\n"),
      beforeSuites("            - name: Older\n              run: git checkout HEAD~1\n"),
      afterSuite(0, "            - run: npx supabase status"),
      afterSuite(0, "            - run: npx supabase status || true"),
      afterSuite(0, '            - run: echo "PATH=$PWD/bin:$PATH" >> "$GITHUB_ENV"'),
      afterSuite(7, "            - run: echo done"),
      gateEdit((lines, suites, ci) => (lines[ci] += " && npm pkg set scripts.test:db=true")),
      gateEdit((lines, suites, ci) => (lines[ci] += " && echo script-shell=true >> .npmrc")),
      gate(CHECKOUT, `${CHECKOUT}              with:\n                  ref: \${{ github.event.before }}\n`),
      gate(CHECKOUT, `${CHECKOUT}              with:\n                  repository: someone/known-green\n`),
      gate("actions/checkout@v4", "actions/checkout@v1"),
      gate("                  node-version: 22\n", "                  node-version: 18\n"),
      gate("                  cache: npm\n", "                  cache: npm\n                  node-version-file: .nvmrc\n"),
      // Step keys that skip a suite or change how it runs, in any case.
      afterSuite(1, "              continue-on-error: true"),
      afterSuite(1, "              continue-on-error: false"),
      afterSuite(1, "              Continue-On-Error: true"),
      afterSuite(2, "              if: ${{ false }}"),
      afterSuite(2, "              If: ${{ false }}"),
      afterSuite(2, "              if: ${{ github.event_name == 'push' }}"),
      afterSuite(2, '              "if": false'),
      afterSuite(3, "              shell: sh -c 'exit 0' {0}"),
      afterSuite(3, "              Shell: bash"),
      afterSuite(4, "              working-directory: supabase"),
      afterSuite(5, "              env:\n                  PGHOST: 192.0.2.1"),
      // Keys behind a comment and a lone CR or NEL.
      afterSuite(7, "              # skipped on purpose\r              if: ${{ false }}"),
      afterSuite(7, `              # skipped on purpose${NEL}              if: \${{ false }}`),
      gate(job, `${job}        # gate note\r        if: \${{ false }}\n`),
      gate(job, `${job}        # gate note\r        continue-on-error: true\n`),
      gate(top, `${top}# shared settings\rdefaults:\n    run:\n        shell: sh -c 'exit 0' {0}\n`),
      gate(top, `${top}# shared settings\renv:\n    npm_config_script_shell: "true"\n`),
      // The job itself, its environment, and the config that names its stack.
      gate(job, `${job}        continue-on-error: true\n`),
      gate(job, `${job}        if: \${{ false }}\n`),
      gate(job, `${job}        strategy:\n            matrix:\n                run: [1]\n`),
      gate(job, `${job}        container: node:22\n`),
      gate("        runs-on: ubuntu-latest\n", "        runs-on: [self-hosted]\n"),
      gate("            SUPABASE_DB_CONTAINER:", "            BASH_ENV: ./.github/skip.sh\n            SUPABASE_DB_CONTAINER:"),
      gate("supabase_db_atomic-crm-demo", "supabase_db_other"),
      gateEdit((lines) => lines.splice(lines.indexOf("        env:"), 1)),
      [{ path: "supabase/config.toml", content: null }],
      // The top level, the trigger, anchors, and a second job: the suites
      // share one stack.
      gate("permissions:\n", "concurrency:\n    group: ${{ github.workflow }}-${{ github.ref }}\n    cancel-in-progress: true\n\npermissions:\n"),
      gate("permissions:\n", "defaults:\n    run:\n        shell: sh -c 'exit 0' {0}\n\npermissions:\n"),
      gate("permissions:\n", "env:\n    CI: false\n\npermissions:\n"),
      gate("on:\n    workflow_call:\n", "on:\n    push:\n"),
      gate("on:\n    workflow_call:\n", "on:\n    workflow_call:\n    push:\n"),
      gate("on:\n    workflow_call:\n", "on: [workflow_call, push]\n"),
      gate("on:\n    workflow_call:\n", "on:\n    workflow_call:\n        inputs:\n            skip:\n                type: boolean\n"),
      gate("            - name: ", "            - &start\n              name: "),
      gate("            - name: ", "            - name: &checkout "),
      { path: GATE, content: `${read(GATE)}\n    noop:\n        runs-on: ubuntu-latest\n        steps:\n            - run: npm ci\n` },
    ]);
  });

  it("keeps one definition of the gate, which check.yml calls on its reviewed triggers", () => {
    const unitTests =
      "              run: CI=1 npm run test:unit:claude -- --run\n";
    const addStep = (run) =>
      check(unitTests, `${unitTests}            - run: ${run}\n`);
    expectRefused(CHECK, [
      { path: CHECK, content: null },
      check(CALL, ""),
      check(CALL, "        uses: ./.github/workflows/other.yml\n"),
      addStep("npm run test:db"),
      addStep("npm run test:db:engine"),
      addStep("node scripts/run-db-tests.mjs"),
      // The call skipped, or run under another condition.
      check(DRAFT, "        if: ${{ false }}\n        permissions:\n"),
      check(DRAFT, "        if: ${{ always() }}\n        permissions:\n"),
      check(
        DRAFT,
        `${DRAFT.replace("        permissions:\n", "")}        needs: lint\n        permissions:\n`,
      ),
      // Fewer pushes or pull requests reach it.
      check('            - "feature/**"\n', ""),
      check("            - synchronize\n", ""),
      check(
        "    pull_request:\n",
        "        paths:\n            - src/**\n    pull_request:\n",
      ),
      // Under YAML 1.1, `on` reads as a boolean: no trigger at all.
      { path: CHECK, content: `%YAML 1.1\n---\n${read(CHECK)}` },
    ]);
  });

  it("accepts the spellings it can read, and workflows that do not deploy", () => {
    const preview = (steps, extra = []) => [
      ...extra,
      workflow(
        ".github/workflows/preview.yml",
        `    preview:\n        if: \${{ !github.event.pull_request.draft }}\n        runs-on: ubuntu-latest\n        steps:\n${steps}`,
        "    pull_request:\n",
      ),
    ];
    for (const change of [
      deploy(
        NEEDS,
        "        needs:\n            - gate\n            - database # the live suites\n",
      ),
      deploy(NEEDS, "        needs: database\n"),
      deploy(NEEDS, "        needs: [ database, gate, ]\n"),
      deploy(NEEDS, '        needs: ["gate", "database"]\n'),
      deploy(
        CALL,
        "        uses: ./.github/workflows/database.yml # the gate\n",
      ),
      deploy(CALL, "        uses: './.github/workflows/database.yml'\n"),
      gate("on:\n    workflow_call:\n", "on: workflow_call\n"),
      gate("on:\n    workflow_call:\n", "on: [workflow_call]\n"),
      gate(
        "              run: npm run test:db:engine\n",
        "              run: npm run test:db:engine # driver-backed\n",
      ),
      { path: GATE, content: `---\n${read(GATE)}` },
      check(DRAFT, "        permissions:\n"),
      check(
        "    # (Phase 1D.2). deploy.yml",
        "    # (Phase 1D.2), which runs npm run test:db and more. deploy.yml",
      ),
      check(
        "              run: npm run typecheck\n",
        "              run: npm run typecheck && npm run test:dbml-docs\n",
      ),
      withJob("make-docs", "make doc-build registry-build"),
      workflow(
        HOTFIX,
        `    database:\n        name: Gate\n${CALL}${deployJob().replace(NEEDS, "        needs: database\n")}`,
      ),
      preview(
        "            - name: Supabase link check\n              run: npx supabase start && npx supabase status\n            - run: make doc-build\n",
      ),
      // A local command continued over two lines is still one command.
      preview(
        "            - run: |\n                  npx supabase \\\n                    start\n",
      ),
      // A step name and a Pages token are no credential; a local action that
      // reaches nothing is no deploy.
      preview(
        "            - name: No secrets in the build\n              run: npm run build\n              env:\n                  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
      ),
      // A script line that starts with a quote is not an open YAML value.
      preview(
        '            - run: |\n                  "$(command -v node)" --version\n',
      ),
      preview("            - uses: ./.github/actions/setup\n", [
        {
          path: ".github/actions/setup/action.yml",
          content:
            "name: Setup\nruns:\n    using: composite\n    steps:\n        - run: npm ci\n          shell: bash\n",
        },
      ]),
    ]) {
      const all = [change].flat();
      expect(refusals(...all), all.at(-1).content.slice(0, 120)).toEqual([]);
    }
  });

  it("refuses a broken gate from the command line deploy-supabase runs", () => {
    // A copy of the guard in a repository whose only workflow is the real
    // deploy.yml, with no database.yml: the command must refuse it by rule.
    const dir = mkdtempSync(join(tmpdir(), "database-gate-"));
    try {
      mkdirSync(join(dir, "scripts"));
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      for (const name of [
        "production-scope.mjs",
        "production-scope-commands.mjs",
        "production-scope-database-gate.mjs",
        "production-scope-workflow-reader.mjs",
        "production-scope-remote.mjs",
        "dev-signing-key.mjs",
        "source-facts.mjs",
      ]) {
        copyFileSync(join(ROOT, "scripts", name), join(dir, "scripts", name));
      }
      writeFileSync(join(dir, DEPLOY), read(DEPLOY));
      const git = (...args) =>
        execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
          cwd: dir,
          stdio: "pipe",
        });
      git("init", "-q");
      git("add", "-A");
      const result = spawnSync(
        process.execPath,
        [join(dir, "scripts", "production-scope.mjs")],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, NODE_PATH: join(ROOT, "node_modules") },
          timeout: 60000,
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(`[${RULE}] ${GATE}`);
      expect(result.stderr).toContain(`[${RULE}] ${CHECK}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
