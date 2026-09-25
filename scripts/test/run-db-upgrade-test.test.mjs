import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSERTIONS,
  BASE_VERSION,
  FIRST_UPGRADE_MIGRATION,
  FIXTURE,
  HALT_MARKER,
  HALTED_ASSERTIONS,
  OPERATOR_ACT,
  OWNER_GUARD_MIGRATION,
  REPLAYED_MIGRATIONS,
  checkBaseVersion,
  differingMigrations,
  isGuardHalt,
  parseProjectId,
  parseWorkdir,
  preflight,
  supabaseInvocation,
} from "../run-db-upgrade-test.mjs";

// The upgrade replay resets a database, so everything that decides WHICH
// database, and whether the run proved anything, is tested here without one.
// The replay itself runs in the database gate (npm run test:db:upgrade).

const SCRIPT = fileURLToPath(
  new URL("../run-db-upgrade-test.mjs", import.meta.url),
);
const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const migrationFiles = readdirSync(MIGRATIONS).filter((f) =>
  f.endsWith(".sql"),
);

/** A throwaway repository with just what preflight reads. */
const fakeRepo = ({ projectId = "demo", copy = null } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "upgrade-replay-"));
  const write = (path, content) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write("supabase/config.toml", `project_id = "${projectId}"\n`);
  for (const name of [
    `${BASE_VERSION}_base.sql`,
    FIRST_UPGRADE_MIGRATION,
    ...REPLAYED_MIGRATIONS,
  ]) {
    write(`supabase/migrations/${name}`, `-- ${name}\nselect 1;\n`);
  }
  for (const file of [FIXTURE, HALTED_ASSERTIONS, OPERATOR_ACT, ASSERTIONS]) {
    write(file, "select 1;\n");
  }
  if (copy) {
    write(".copy/supabase/config.toml", `project_id = "${copy.projectId}"\n`);
    for (const [name, content] of Object.entries(copy.migrations)) {
      write(`.copy/supabase/migrations/${name}`, content);
    }
  }
  return root;
};

describe("upgrade replay: which database it may reset", () => {
  it("defaults to the isolated e2e stack and accepts only --workdir <dir>", () => {
    expect(parseWorkdir([])).toBe(".supabase-e2e");
    expect(parseWorkdir(["--workdir", "."])).toBe(".");
    for (const argv of [
      ["--workdir"],
      ["--workdir", ""],
      ["--workdir", "  "],
      ["."],
      ["--wd", "."],
      ["--workdir", ".", "--linked"],
    ]) {
      expect(parseWorkdir(argv), JSON.stringify(argv)).toBeNull();
    }
  });

  it("reads project_id from a project config file", () => {
    expect(parseProjectId('project_id = "atomic-crm-e2e"\n[api]\n')).toBe(
      "atomic-crm-e2e",
    );
    expect(parseProjectId('# project_id = "x"\n')).toBeNull();
    expect(parseProjectId("[api]\nport = 1\n")).toBeNull();
  });

  it("accepts the CI stack for the repository workdir", () => {
    const projectId = parseProjectId(
      readFileSync(join(ROOT, "supabase", "config.toml"), "utf8"),
    );
    expect(
      preflight({
        repoRoot: ROOT,
        workdir: ".",
        container: `supabase_db_${projectId}`,
      }),
    ).toEqual([]);
  });

  it("refuses to reset a container that is not the workdir's database", () => {
    const root = fakeRepo({ projectId: "demo" });
    const problems = preflight({
      repoRoot: root,
      workdir: ".",
      container: "supabase_db_other",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/refusing to reset it/);
  });

  it("refuses a workdir without a config or a project_id", () => {
    const root = fakeRepo();
    expect(
      preflight({ repoRoot: root, workdir: "missing", container: "x" })[0],
    ).toMatch(/no Supabase config/);
    writeFileSync(join(root, "supabase", "config.toml"), "[api]\n");
    expect(
      preflight({ repoRoot: root, workdir: ".", container: "x" })[0],
    ).toMatch(/no project_id/);
  });

  it("refuses a copied workdir whose migrations are stale", () => {
    const root = fakeRepo({
      copy: {
        projectId: "copy",
        migrations: {
          [`${BASE_VERSION}_base.sql`]: `-- ${BASE_VERSION}_base.sql\r\nselect 1;\r\n`,
          [FIRST_UPGRADE_MIGRATION]: "-- an older version\n",
        },
      },
    });
    const problems = preflight({
      repoRoot: root,
      workdir: ".copy",
      container: "supabase_db_copy",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/copy them across first/);
    // Different content and missing files are named; a CRLF checkout is not.
    expect(problems[0]).toContain(FIRST_UPGRADE_MIGRATION);
    expect(problems[0]).toContain(REPLAYED_MIGRATIONS[0]);
    expect(problems[0]).not.toContain(`${BASE_VERSION}_base.sql`);
  });

  it("refuses when a file the replay needs is missing", () => {
    const root = fakeRepo();
    expect(
      preflight({
        repoRoot: root,
        workdir: ".",
        container: "supabase_db_demo",
      }),
    ).toEqual([]);
    rmSync(join(root, FIXTURE));
    rmSync(join(root, "supabase", "migrations", OWNER_GUARD_MIGRATION));
    expect(
      preflight({
        repoRoot: root,
        workdir: ".",
        container: "supabase_db_demo",
      }),
    ).toEqual([
      `replayed migration ${OWNER_GUARD_MIGRATION} does not exist`,
      `missing ${FIXTURE}`,
    ]);
  });

  it("exits before touching any database when the arguments are wrong", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--workdir"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage: run-db-upgrade-test\.mjs/);
    expect(result.stderr).toMatch(/not a skip/);
    expect(result.stdout).not.toMatch(/1\/7/);
  });
});

describe("upgrade replay: the CLI it runs", () => {
  it("runs exactly the measured Supabase CLI package, never the latest release", () => {
    // Arrange / Act
    const invocation = supabaseInvocation(
      ["db", "reset", "--workdir", ".", "--local", "--no-seed"],
      "linux",
    );

    // Assert: the version is spelled out, so the latest release (Check #72)
    // can never be the one that resets and migrates the database.
    expect(invocation).toEqual({
      file: "npx",
      args: [
        "--yes",
        "supabase@2.117.0",
        "db",
        "reset",
        "--workdir",
        ".",
        "--local",
        "--no-seed",
      ],
      shell: false,
    });
  });

  it("goes through a shell on Windows only, where npx is a .cmd shim", () => {
    const up = ["migration", "up", "--workdir", ".supabase-e2e", "--local"];
    expect(supabaseInvocation(up, "win32").shell).toBe(true);
    expect(supabaseInvocation(up, "linux").shell).toBe(false);
    expect(supabaseInvocation(up, "win32").args.slice(0, 2)).toEqual([
      "--yes",
      "supabase@2.117.0",
    ]);
  });
});

describe("upgrade replay: the fixture describes the schema it is loaded into", () => {
  it("bases the replay on the migration right before pending_delta", () => {
    expect(checkBaseVersion(migrationFiles)).toBeNull();
  });

  it("refuses a migration inserted between the base and pending_delta", () => {
    expect(
      checkBaseVersion([...migrationFiles, "20260911200000_inserted.sql"]),
    ).toMatch(/is 20260911200000_inserted\.sql, not 20260911130000/);
    expect(
      checkBaseVersion(
        migrationFiles.filter((f) => f !== FIRST_UPGRADE_MIGRATION),
      ),
    ).toMatch(/missing or has no predecessor/);
  });

  it("compares migration copies byte for byte, line endings aside", () => {
    const a = mkdtempSync(join(tmpdir(), "migrations-a-"));
    const b = mkdtempSync(join(tmpdir(), "migrations-b-"));
    writeFileSync(join(a, "1_same.sql"), "select 1;\nselect 2;\n");
    writeFileSync(join(b, "1_same.sql"), "select 1;\r\nselect 2;\r\n");
    writeFileSync(join(a, "2_changed.sql"), "select 1;\n");
    writeFileSync(join(b, "2_changed.sql"), "select 2;\n");
    writeFileSync(join(a, "3_only_source.sql"), "");
    writeFileSync(join(b, "4_only_copy.sql"), "");
    writeFileSync(join(b, "notes.txt"), "not a migration");
    expect(differingMigrations(a, b)).toEqual([
      "2_changed.sql",
      "3_only_source.sql",
      "4_only_copy.sql",
    ]);
    expect(differingMigrations(a, join(b, "missing"))).toEqual([
      "1_same.sql",
      "2_changed.sql",
      "3_only_source.sql",
    ]);
  });
});

describe("upgrade replay: the owner guard halt is the only accepted halt", () => {
  it("accepts a non-zero exit that carries the guard's message", () => {
    expect(
      isGuardHalt({ status: 1, output: `ERROR: ${HALT_MARKER}: sales 1` }),
    ).toBe(true);
  });

  it("refuses no halt, another failure, or a killed process", () => {
    expect(isGuardHalt({ status: 0, output: HALT_MARKER })).toBe(false);
    expect(
      isGuardHalt({ status: 1, output: "ERROR: relation does not exist" }),
    ).toBe(false);
    expect(isGuardHalt({ status: null, output: HALT_MARKER })).toBe(false);
    expect(isGuardHalt({ status: 1, output: "" })).toBe(false);
  });

  it("matches the message the guard migration actually raises", () => {
    const guard = readFileSync(join(MIGRATIONS, OWNER_GUARD_MIGRATION), "utf8");
    expect(guard).toContain(`message = format('${HALT_MARKER} `);
  });

  it("replays only the idempotent migrations, in apply order, after the bootstrap", () => {
    const bootstrap = migrationFiles.find((f) =>
      /_owner_bootstrap\.sql$/.test(f),
    );
    expect(bootstrap).toBeDefined();
    expect(REPLAYED_MIGRATIONS).not.toContain(bootstrap);
    expect([...REPLAYED_MIGRATIONS].sort()).toEqual(REPLAYED_MIGRATIONS);
    for (const name of REPLAYED_MIGRATIONS) {
      expect(migrationFiles, name).toContain(name);
    }
    // The guard halts only after both backfills and the bootstrap function are
    // committed, so a halted upgrade already holds them.
    expect(REPLAYED_MIGRATIONS.at(-1)).toBe(OWNER_GUARD_MIGRATION);
    expect(OWNER_GUARD_MIGRATION > bootstrap).toBe(true);
  });

  it("bootstraps the fixture's first administrator, by auth user id", () => {
    const fixture = readFileSync(join(ROOT, FIXTURE), "utf8");
    const act = readFileSync(join(ROOT, OPERATOR_ACT), "utf8");
    const id = /bootstrap_owner\(\s*'([0-9a-f-]{36})'/.exec(act)?.[1];
    expect(id).toBeDefined();
    expect(fixture).toMatch(
      new RegExp(`'${id}'[^;]*'first-admin@upgrade\\.test'`),
    );
  });

  it("is reachable through an npm script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["test:db:upgrade"]).toBe(
      "node ./scripts/run-db-upgrade-test.mjs",
    );
  });
});
