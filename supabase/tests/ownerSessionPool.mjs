// SI-27 through the real driver. Starts ownerSessionPool.probe.ts as a main
// service in the local stack's edge runtime, against
// supabase/functions/_shared/db.ts as it is in the repository (deno-postgres,
// Kysely, runAsUser), plus PROBE_EXPORT, one appended line that hands the probe
// the module's private pool. It checks what the probe measured:
//
//   A  inside a merge transaction the session is authenticated, as the caller
//   B  every ops read, write and function call there is refused at the schema
//   C  COMMIT, and D ROLLBACK, leave the pooled session as the owner, with no
//      role, identity, tenant context or open transaction
//   E  every transaction and every check ran on the same backend
//   F/G a thrown error, a missing contact and a database error all roll back
//      and leave the session clean
//
// `npm run test:db` runs it. It needs the stack's edge runtime container
// (supabase_edge_runtime_<project>), which `supabase start` creates.
// Exit 0 pass, 1 a failed check, 2 not run.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DB_CONTAINER =
  process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";
const EDGE_CONTAINER = DB_CONTAINER.replace(
  /^supabase_db_/,
  "supabase_edge_runtime_",
);
const PROBE_DIR = `/tmp/owner-session-probe-${process.pid}`;
const PORT = 20000 + Math.floor(Math.random() * 20000);
const DEADLINE_MS = 150_000;
const SCHEMA_REFUSAL = /^42501 permission denied for schema ops/;
// The only change to db.ts: the probe needs the private pool to read the
// session between transactions. Nothing in the repository exports it.
const PROBE_EXPORT = "export { db as ownerPoolForProbe };";

const notRun = (reason) => {
  console.error(`owner session pool could not be checked: ${reason}`);
  process.exit(2);
};

if (!/^[\w.-]+$/.test(EDGE_CONTAINER) || EDGE_CONTAINER === DB_CONTAINER) {
  notRun(`cannot derive the edge runtime container from ${DB_CONTAINER}`);
}

const inEdge = (script, input) =>
  spawnSync("docker", ["exec", "-i", EDGE_CONTAINER, "bash", "-c", script], {
    input,
    encoding: "utf8",
    timeout: 60_000,
  });

const running = spawnSync(
  "docker",
  ["inspect", "-f", "{{.State.Running}}", EDGE_CONTAINER],
  { encoding: "utf8" },
);
if (running.status !== 0 || running.stdout.trim() !== "true") {
  notRun(`${EDGE_CONTAINER} is not running`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runProbe() {
  const files = {
    [`${PROBE_DIR}/_shared/db.ts`]: `${readFileSync(
      join(ROOT, "supabase", "functions", "_shared", "db.ts"),
      "utf8",
    )}\n${PROBE_EXPORT}\n`,
    [`${PROBE_DIR}/main/index.ts`]: readFileSync(
      join(ROOT, "supabase", "tests", "ownerSessionPool.probe.ts"),
      "utf8",
    ),
  };
  for (const [path, content] of Object.entries(files)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const write = inEdge(`mkdir -p '${dir}' && cat > '${path}'`, content);
    if (write.status !== 0) notRun(`could not write ${path} into the runtime`);
  }
  const start = inEdge(
    `(timeout ${Math.ceil(DEADLINE_MS / 1000)} edge-runtime start --main-service '${PROBE_DIR}/main' --port ${PORT} > '${PROBE_DIR}/out.log' 2>&1 &)`,
  );
  if (start.status !== 0) notRun("could not start the edge runtime probe");

  const deadline = Date.now() + DEADLINE_MS - 10_000;
  while (Date.now() < deadline) {
    // A request wakes the main service if it has not started yet.
    inEdge(
      `exec 3<>/dev/tcp/127.0.0.1/${PORT} && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && timeout 5 cat <&3 > /dev/null`,
    );
    const log = inEdge(`cat '${PROBE_DIR}/out.log' 2>/dev/null || true`);
    const line = (log.stdout ?? "")
      .split(/\r?\n/)
      .find((l) => l.startsWith("OWNER_SESSION_PROBE "));
    if (line) return JSON.parse(line.slice("OWNER_SESSION_PROBE ".length));
    await sleep(2_000);
  }
  const tail = inEdge(`tail -n 20 '${PROBE_DIR}/out.log' 2>/dev/null || true`);
  notRun(`the probe printed no result in time:\n${tail.stdout ?? ""}`);
}

function cleanUp() {
  inEdge(
    `for p in /proc/[0-9]*; do if grep -q 'owner-session-probe-${process.pid}' "$p/cmdline" 2>/dev/null; then kill "\${p#/proc/}" 2>/dev/null; fi; done; rm -rf '${PROBE_DIR}'`,
  );
}

const failures = [];
const check = (ok, message) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${message}\n`);
  if (!ok) failures.push(message);
};

let probe;
try {
  probe = await runProbe();
} finally {
  cleanUp();
}
if (!probe?.ok) notRun(`the probe failed: ${probe?.error ?? "no result"}`);

const r = probe.result;
const { before, after, attempts, contactFound } = r.committed;

check(
  before.currentUser === "authenticated" &&
    before.sessionUser === "postgres" &&
    before.role === "authenticated" &&
    before.uid === r.user,
  `A: inside the transaction the session is authenticated, as the caller (${before.currentUser}, ${before.role}, ${before.uid})`,
);
check(
  contactFound === false,
  "A: a merge-shaped read of public.contacts runs under RLS as the caller",
);
for (const [name, result] of Object.entries(attempts)) {
  check(
    SCHEMA_REFUSAL.test(result),
    `B: ${name} is refused at the schema (${result})`,
  );
}
check(
  after.currentUser === "authenticated" && after.uid === r.user,
  "B: the refusals leave the transaction authenticated, as the caller",
);

check(
  !r.thrown.ok && r.thrown.error.includes("probe: client-side failure"),
  `F: a thrown error rejects the merge (${r.thrown.error})`,
);
check(
  !r.noResult.ok && /no result/i.test(r.noResult.error),
  `G: a missing contact rejects the merge, as merge_contacts' first query does (${r.noResult.error})`,
);
check(
  !r.databaseError.ok && SCHEMA_REFUSAL.test(r.databaseError.error),
  `G: a database error rejects the merge (${r.databaseError.error})`,
);
check(
  !r.resetRole.ok && r.resetRole.error.includes("reset role gives postgres"),
  `characterisation: the owner session can switch back (${r.resetRole.error}), so containment rests on fixed statements in sealed files (SI-27)`,
);

const pid = r.states[0].pid;
for (const state of r.states) {
  const clean =
    state.pid === pid &&
    state.currentUser === "postgres" &&
    state.sessionUser === "postgres" &&
    state.role === "none" &&
    state.claimSub === "" &&
    state.claims === "" &&
    state.workerId === "" &&
    state.jobId === "" &&
    state.uid === null &&
    state.tenant === null &&
    state.autocommit === true &&
    state.prepared === 0;
  check(
    clean,
    `C/D/E: after ${state.label} the pooled session is backend ${state.pid}, ${state.currentUser}, role ${state.role}, no identity, no tenant, no open transaction, ${state.prepared} prepared statements`,
  );
}
check(
  r.committed.before.pid === pid &&
    [...r.sequential, ...r.concurrent].every((c) => c.pid === pid),
  `E: every transaction ran on backend ${pid}, the one pooled session`,
);
check(
  r.sequential.map((c) => c.uid).join() === [r.user, r.other].join(),
  "E: callers in turn each see only their own identity",
);
check(
  r.concurrent
    .map((c) => c.uid)
    .sort()
    .join() === [r.user, r.other].sort().join(),
  "E: callers at once each see only their own identity",
);

if (failures.length > 0) {
  console.error(`\n${failures.length} owner session check(s) failed.`);
  process.exit(1);
}
process.stdout.write(
  "\nowner session pool: the merge transaction reaches nothing in ops, and nothing outlives it on the pooled session.\n",
);
