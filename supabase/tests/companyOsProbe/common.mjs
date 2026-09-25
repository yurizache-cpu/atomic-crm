// Shared by the Company OS Data API probe, supabase/tests/companyOsApiExposure.mjs,
// and its helper modules in this directory: the stack, the probe's constants
// and sentinels, the psql and HTTP helpers, and the one list of failures.
//
// scripts/run-db-tests.mjs executes only the *.mjs files directly inside
// supabase/tests, so nothing in this directory runs on its own. All data is
// synthetic office-operations text.

import { randomBytes } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { pinnedSupabaseCommand } from "../../../scripts/supabase-cli.mjs";

export const CONTAINER =
  process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";
const PROJECT = CONTAINER.replace(/^supabase_db_/, "");
const WORKDIR =
  process.env.SUPABASE_WORKDIR ??
  (PROJECT === "atomic-crm-e2e" ? ".supabase-e2e" : undefined);

/**
 * The Phase 2C read catalogue (brief §8 rows 1-15): the names of
 * COMPANY_OS_OPERATION_NAMES in contracts/company-os-api/operations.ts, which a
 * Node script cannot import. surfaceChecks.mjs checks it against the live one.
 */
export const CATALOGUE = Object.freeze([
  "operator_context",
  "overview",
  "list_agents",
  "get_agent",
  "list_tasks",
  "get_task",
  "list_runs",
  "get_run",
  "list_reviews",
  "get_review",
  "get_review_advice",
  "list_events",
  "list_stops",
  "spend_summary",
  "communication_status",
]);

/** The two browser acts (S7.1, S7.2) and their arguments. */
export const ACTS = Object.freeze({
  decide_review: ["p_review_id", "p_decision"],
  trip_stop: ["p_scope", "p_target_id"],
});

/** Every exposed function: the reads and the one act. */
export const EXPOSED = Object.freeze([...CATALOGUE, ...Object.keys(ACTS)]);

/** A clear: the browser can never reach one, under any name. */
export const ABSENT_ACTS = Object.freeze({
  clear_stop: ["p_stop_id"],
  clear_execution_stop: ["p_stop_id", "p_reason"],
});

// The two persistent probe tenants, found by these fixed slugs on every run. A
// membership row references its tenant and is never deleted, so a tenant that
// ever held one cannot be deleted either: the probe reuses these two instead
// of creating tenants it could never remove.
export const SLUG_A = "cos-probe-a";
export const SLUG_B = "cos-probe-b";
/** The two probe slugs as an SQL list, for `slug in ${PROBE_SLUGS}`. */
export const PROBE_SLUGS = `('${SLUG_A}', '${SLUG_B}')`;
/** Rows of a probe tenant, for `tenant_id in ${IN_PROBE_TENANTS}`. */
export const IN_PROBE_TENANTS = `(select id from ops.tenants where slug in ${PROBE_SLUGS})`;
export const TENANT_A_NAME = "Probe tenant A";

// What the probe writes, each distinctive, so leftovers are recognisable and a
// sentinel found in an answer names exactly what leaked.
export const EMAIL_PREFIX = "cos-probe-";
export const EMAIL_DOMAIN = "@example.test";
export const DISPLAY_PREFIX = "cos probe ";
export const ACTOR = "cos-probe";
export const SOURCE = "cos-probe-source-3d9b";
/** The price row the planted run starts under: platform data, never returned. */
export const PRICE = Object.freeze({
  provider: "cos_probe",
  model: "cos-probe-model",
});
export const SENTINELS = Object.freeze({
  display: `${DISPLAY_PREFIX}member display sentinel 5e0d`,
  taskTitle: "cos probe task title sentinel 2f8a",
  taskBody: "cos probe task body sentinel 9d14",
  // The synthetic lead admitted for legacy fixture A: its body becomes that
  // task's description, which no read returns.
  admittedBody: "cos probe admitted lead body sentinel 5a7e",
  agentRole: "cos probe agent role sentinel 4b6e",
  agentDescription: "cos probe agent description sentinel c05f",
  draft: "cos probe reply draft sentinel 8e27",
  // The planted run's stored result: the advice fields are withheld for a
  // task no admission created, and a run projection never carries a result.
  runSummary: "cos probe run summary sentinel 6a1f",
  runNextAction: "cos probe run next action sentinel 93be",
  runRequester: "cos-probe-run-requester-2c9d",
  leaseOwner: "cos-probe-lease-owner-4e1a",
  jobError: "cos probe job last error sentinel 0c5d",
  jobEventDetail: "cos probe job event detail sentinel b7a2",
  priceSource: "cos probe price source sentinel 1d7c",
  priceRecorder: "cos-probe-price-recorder-8f3b",
  // The PR #6 legacy actor labels (brief §16 A to C), each email-like and
  // each a valid stored value: none may reach any answer.
  reviewer: "cos-probe-reviewer@example.test",
  tripper: "cos-probe-tripper@example.test",
  clearer: "cos-probe-clearer@example.test",
  requester: "cos-probe-requester@example.test",
  configurer: "cos-probe-configurer@example.test",
  tenantB: "cos probe tenant B sentinel 71c3",
  companyB: "cos probe company B sentinel 0a9e",
  agentB: "cos probe agent B sentinel e4d2",
  taskTitleB: "cos probe task B title sentinel 5b80",
  taskBodyB: "cos probe task B body sentinel 3e61",
});
/** Tenant B's name while the probe holds nothing of anyone's (see fixture.mjs). */
export const TENANT_B_NAME = SENTINELS.tenantB;
/** Content a projection returns as content (brief §13 item 2): positive controls. */
export const CONTENT = Object.freeze({
  stopReason: "cos probe stop reason, returned as content",
  drillReason: "cos probe tenant drill, returned as content",
  clearedReason: "cos probe drill over, returned as content",
  decisionNote: "cos probe decision note, returned as content",
});

/** psql variables are uuids, emails of this probe or fixed labels, nothing else. */
const SAFE_PSQL_VALUE = /^[A-Za-z0-9@._:-]{1,200}$/;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const failures = [];
export const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** The exact body a gate answers a refused caller with (fixed and data-free). */
export const refusalBody = (code, fn, text) =>
  JSON.stringify({
    code,
    details: null,
    hint: null,
    message: `company_os_api.${fn}: ${text}`,
  });
export const SCHEMA_REFUSAL = JSON.stringify({
  code: "42501",
  details: null,
  hint: null,
  message: "permission denied for schema company_os_api",
});

/** A string of `n` decimal digits, for a synthetic provider target or contact. */
export const digits = (n) =>
  Array.from(randomBytes(n), (byte) => String(byte % 10)).join("");
/** `n` random lower-case hex characters (n even). */
export const hex = (n) => randomBytes(n / 2).toString("hex");

/**
 * Runs an owner script through psql as postgres, SQL on stdin, and returns its
 * non-empty output lines. On failure only the ERROR line leaves, never input.
 */
export function psql(script, vars = {}) {
  const args = ["exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres"];
  args.push("-d", "postgres", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1");
  for (const [name, value] of Object.entries(vars)) {
    if (!SAFE_PSQL_VALUE.test(String(value))) {
      throw new Error(`refusing to pass ${name} to psql: unexpected shape`);
    }
    args.push("-v", `${name}=${value}`);
  }
  try {
    return execFileSync("docker", args, {
      input: script,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    const line = String(error.stderr ?? "")
      .split("\n")
      .find((l) => /ERROR/.test(l));
    throw new Error(`owner fixture failed: ${line?.trim() ?? "psql exited"}`);
  }
}

/** `key=value` lines of a fixture script, as an object of uuids. */
export function idsOf(lines, keys) {
  const values = Object.fromEntries(
    lines
      .filter((line) => line.includes("="))
      .map((line) => line.split("=", 2)),
  );
  for (const key of keys) {
    if (!UUID.test(values[key] ?? "")) {
      throw new Error(`the owner fixture did not report ${key}`);
    }
  }
  return values;
}

/** The host origin Kong publishes for this project. */
export function apiOrigin() {
  const out = execFileSync(
    "docker",
    ["port", `supabase_kong_${PROJECT}`, "8000/tcp"],
    { encoding: "utf8" },
  );
  const port = /:(\d+)\s*$/m.exec(out.split("\n")[0] ?? "")?.[1];
  if (!port) {
    throw new Error(
      `could not read the Kong port for supabase_kong_${PROJECT}`,
    );
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * The Data API credentials of the running stack. Values stay in memory;
 * nothing logs them. `execSync` goes through a shell on purpose: on win32
 * `npx` is a .cmd shim that `execFile` cannot start. The CLI is the measured
 * one (scripts/supabase-cli.mjs), never the latest release.
 */
export function readKeys() {
  const command = pinnedSupabaseCommand([
    "status",
    "-o",
    "json",
    ...(WORKDIR ? ["--workdir", WORKDIR] : []),
  ]);
  const status = JSON.parse(
    execSync(command, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const keys = {
    publishable: status.PUBLISHABLE_KEY,
    anon: status.ANON_KEY,
    service_role: status.SERVICE_ROLE_KEY,
    secret: status.SECRET_KEY,
  };
  for (const [name, value] of Object.entries(keys)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `supabase status did not report ${name}; refusing to run with a partial credential matrix`,
      );
    }
  }
  return keys;
}

/** The request headers a credential carries: an apikey, a bearer, or none. */
export const authOf = (credential) => ({
  ...(credential.apikey ? { apikey: credential.apikey } : {}),
  ...(credential.bearer
    ? { Authorization: `Bearer ${credential.bearer}` }
    : {}),
});

let requests = 0;
/** Counts a request made outside `request` (a supabase-js call). */
export const countRequest = () => {
  requests += 1;
};
export const requestCount = () => requests;

/** Status, the raw body, its parsed form and the cache header. */
export async function request(url, init) {
  requests += 1;
  const response = await fetch(url, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    code: json?.code,
    text,
    json,
    cacheControl: response.headers.get("cache-control"),
  };
}

/** Asserts an answer's status and either its exact body or its error code. */
export function expectAnswer(answer, status, expected, label) {
  const matches = expected.startsWith("{")
    ? answer.text === expected
    : answer.code === expected;
  const code = expected.startsWith("{") ? JSON.parse(expected).code : expected;
  check(
    answer.status === status && matches,
    `${label} returned ${answer.status} ${answer.code ?? ""}, expected ${status} ${code}`,
  );
}
