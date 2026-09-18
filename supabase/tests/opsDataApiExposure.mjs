// The `ops` schema is unreachable through the Data API — attacked, not assumed.
//
// SI-15 used to rest on two static facts: `supabase/config.toml` does not list
// `ops`, and the migrations revoke `anon`/`authenticated`. Neither is a request.
// This suite sends requests. It reads EVERY relation and function that exists in
// `ops` from the live catalogue — so a table a later phase adds is attacked the
// day it lands, with nobody remembering to list it — and tries to reach each one
// through Kong, exactly as a browser or a script with a leaked key would:
//
//   * with no key, the publishable key, the legacy anon JWT, the service_role
//     JWT and the secret key — service_role is the most privileged Data API
//     role, so if it cannot reach `ops`, no Data API caller can;
//   * by schema profile (`Accept-Profile: ops` / `Content-Profile: ops`), which
//     must be refused with 406 PGRST106;
//   * by bare name on the default profile, which must be exactly 404 PGRST205;
//   * through GraphQL, which Kong routes to PostgREST's `graphql` RPC. pg_graphql
//     reflects whatever is on the request's search_path, so this channel is
//     governed by PGRST_DB_EXTRA_SEARCH_PATH, not by the schema allowlist.
//
// Every credential first passes a POSITIVE CONTROL: the privileged keys must
// read a CRM table that anon cannot, and the unprivileged ones must be refused
// as a live anon role (42501), not as an invalid token (PGRST301). A mislabelled
// or dead key would otherwise make every refusal below vacuous.
//
// Not in the matrix: a signed-in `authenticated` JWT. Minting one needs the
// development signing key, which SI-20 confines, or a real sign-up, which
// writes. `authenticated` holds no USAGE on `ops` (asserted by the migrations and
// by supabase/tests/company_domain_core.sql), and the profile refusal below is
// decided before any role is applied.
//
// THE PROBE NEVER WRITES, EVEN WHEN IT FINDS A HOLE. Every REST write and RPC
// attempt carries an unparseable body. Measured against this stack: PostgREST
// resolves the schema profile BEFORE it parses the body, so a refused schema
// answers 406 PGRST106, while an EXPOSED relation or function answers 400
// PGRST102 and inserts nothing, executes nothing. An earlier draft sent `{}`,
// and its mutant — pointed at a relation that IS exposed — really inserted a row
// as service_role. The GraphQL request is introspection only: it returns field
// names, never rows.
//
// Keys come from `supabase status -o env` at runtime and are never printed.
// Nothing here reads a key file. It fails closed: a stack it cannot find, a key
// it cannot read, or an empty catalogue is a FAILURE, never a skip — a security
// suite that did not run has verified nothing.
//
// Run by scripts/run-db-tests.mjs. SUPABASE_DB_CONTAINER picks the stack
// (default: the isolated e2e stack); SUPABASE_WORKDIR overrides the CLI workdir.

import { execFileSync, execSync } from "node:child_process";

const CONTAINER =
  process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";
const PROJECT = CONTAINER.replace(/^supabase_db_/, "");

// The e2e stack lives in its own CLI workdir; CI's single stack uses the default.
const WORKDIR =
  process.env.SUPABASE_WORKDIR ??
  (PROJECT === "atomic-crm-e2e" ? ".supabase-e2e" : undefined);

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** Rows from the live catalogue, as postgres, one value per line. */
const catalogue = (sql) =>
  execFileSync(
    "docker",
    [
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-q",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** The host origin Kong publishes for this project. */
function apiOrigin() {
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
 * The Data API credentials of the running stack, by NAME only. Values stay in
 * memory; nothing logs them.
 *
 * `execSync` goes through a shell on purpose: on win32 `npx` is a .cmd shim that
 * `execFile` cannot start. The only interpolated value is WORKDIR, which is a
 * fixed literal or an environment variable the caller controls.
 */
function readKeys() {
  const command = `npx supabase status -o env${WORKDIR ? ` --workdir ${WORKDIR}` : ""}`;
  const env = execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const read = (name) =>
    new RegExp(`^${name}="?([^"\\n]+)"?$`, "m").exec(env)?.[1];
  const keys = {
    none: undefined,
    publishable: read("PUBLISHABLE_KEY"),
    anon: read("ANON_KEY"),
    service_role: read("SERVICE_ROLE_KEY"),
    secret: read("SECRET_KEY"),
  };
  for (const [name, value] of Object.entries(keys)) {
    if (name !== "none" && !value) {
      throw new Error(
        `supabase status did not report ${name}; refusing to run with a partial credential matrix`,
      );
    }
  }
  return keys;
}

/** Credentials that must read what anon cannot. */
const PRIVILEGED = new Set(["service_role", "secret"]);

/** A CRM table granted to authenticated and service_role, never to anon. */
const CONTROL_RELATION = "configuration";

const headersFor = (key, extra = {}) => ({
  ...(key ? { apikey: key, Authorization: `Bearer ${key}` } : {}),
  ...extra,
});

/** Status and parsed body. Callers keep only error codes and schema names. */
async function probe(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, code: json?.code, json };
}

/** Refused by a closed schema before parsing; unparseable if the schema is open. */
const UNPARSEABLE_BODY = "[";

const INTROSPECTION =
  "{ __schema { queryType { fields { name } } mutationType { fields { name } } } }";

/** The field names pg_graphql derives from a relation. */
const graphqlFieldsFor = (relation) => [
  `${relation}Collection`,
  `insertInto${relation}Collection`,
  `update${relation}Collection`,
  `deleteFrom${relation}Collection`,
];

async function main() {
  const relations = catalogue(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and c.relkind in ('r', 'v', 'm', 'p', 'f')
     order by 1`);
  const functions = [
    ...new Set(
      catalogue(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'ops' order by 1`),
    ),
  ];
  // A bare name on the default profile resolves in `public`. Where `public`
  // has an object of the same name (the CRM's `companies` and `tasks`), a 2xx
  // there is the CRM answering, not `ops` — so only the profile attack is
  // meaningful for those names, and GraphQL may reflect each such name once.
  const publicRelations = new Set(
    catalogue(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'`),
  );
  const publicFunctions = new Set(
    catalogue(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'`),
  );

  // Positive control: an empty catalogue would make every assertion below
  // vacuously true.
  check(
    relations.includes("jobs") && relations.includes("tenants"),
    `the ops catalogue looks empty or wrong (${relations.length} relations); this suite would prove nothing`,
  );
  check(
    functions.includes("lease_job"),
    `ops.lease_job is missing from the catalogue (${functions.length} functions)`,
  );
  check(
    publicRelations.has(CONTROL_RELATION),
    `public.${CONTROL_RELATION} is missing; the per-credential positive control cannot run`,
  );
  // Phase 1C: the Company OS objects must be in the matrix, or a stack without
  // the migration would pass having attacked less.
  for (const relation of [
    "companies",
    "departments",
    "agents",
    "tasks",
    "events",
    "task_jobs",
  ]) {
    check(
      relations.includes(relation),
      `ops.${relation} is missing from the catalogue; is the Phase 1C migration applied?`,
    );
  }
  for (const fn of [
    "create_company",
    "assign_task",
    "transition_task",
    "record_event",
    "request_task_execution",
  ]) {
    check(
      functions.includes(fn),
      `ops.${fn} is missing from the catalogue; is the Phase 1C migration applied?`,
    );
  }
  // Phase 1D: the agent runtime objects, for the same reason.
  for (const relation of ["agent_runs", "execution_stops"]) {
    check(
      relations.includes(relation),
      `ops.${relation} is missing from the catalogue; is the Phase 1D migration (20260914120000_agent_runtime) applied?`,
    );
  }
  for (const fn of [
    "request_agent_run",
    "claim_agent_run",
    "trip_execution_stop",
  ]) {
    check(
      functions.includes(fn),
      `ops.${fn} is missing from the catalogue; is the Phase 1D migration (20260914120000_agent_runtime) applied?`,
    );
  }
  // Phase 1D.1: the price and limit tables, their owner services, and the three
  // worker capabilities runtime governance adds, for the same reason.
  for (const relation of ["model_prices", "spend_limits"]) {
    check(
      relations.includes(relation),
      `ops.${relation} is missing from the catalogue; is the Phase 1D.1 migration (20260917120000_runtime_governance) applied?`,
    );
  }
  for (const fn of [
    "record_model_price",
    "set_spend_limit",
    "job_execution_stop",
    "defer_job",
    "enforce_spend_ceiling",
  ]) {
    check(
      functions.includes(fn),
      `ops.${fn} is missing from the catalogue; is the Phase 1D.1 migration (20260917120000_runtime_governance) applied?`,
    );
  }
  // Phase 2A: the admission ledger, the review queue and their services, for
  // the same reason — the matrix must attack them, not merely pass without them.
  for (const relation of ["inbound_messages", "review_items"]) {
    check(
      relations.includes(relation),
      `ops.${relation} is missing from the catalogue; is the Phase 2A migration (20260917190000_lead_triage_pilot) applied?`,
    );
  }
  for (const fn of [
    "admit_inbound_message",
    "record_review_decision",
    "open_review_for_run",
    "open_missing_reviews",
    "open_review_for_settled_job",
  ]) {
    check(
      functions.includes(fn),
      `ops.${fn} is missing from the catalogue; are the Phase 2A migrations (20260917190000, 20260918090000, 20260918120000) applied?`,
    );
  }

  // The live PostgREST configuration, not the file that is supposed to produce it.
  const restEnv = execFileSync(
    "docker",
    [
      "inspect",
      `supabase_rest_${PROJECT}`,
      "--format",
      "{{range .Config.Env}}{{println .}}{{end}}",
    ],
    { encoding: "utf8" },
  );
  const listFromEnv = (name) =>
    new RegExp(`^${name}=(.*)$`, "m")
      .exec(restEnv)?.[1]
      ?.split(",")
      .map((s) => s.trim());
  const exposed = listFromEnv("PGRST_DB_SCHEMAS") ?? [];
  check(
    exposed.length > 0,
    "could not read PGRST_DB_SCHEMAS from the running PostgREST container",
  );
  check(
    !exposed.includes("ops"),
    `the running PostgREST exposes ops (PGRST_DB_SCHEMAS=${exposed.join(",")})`,
  );
  // The search path every Data API request runs with. With ops on it, GraphQL
  // reflects ops.enqueue_job to service_role and executes it (measured, rolled
  // back) while every REST check above stays green.
  const searchPath = listFromEnv("PGRST_DB_EXTRA_SEARCH_PATH");
  check(
    searchPath !== undefined,
    "could not read PGRST_DB_EXTRA_SEARCH_PATH from the running PostgREST container",
  );
  check(
    !(searchPath ?? []).includes("ops"),
    `the running PostgREST puts ops on every request's search_path (PGRST_DB_EXTRA_SEARCH_PATH=${(searchPath ?? []).join(",")})`,
  );
  // PostgREST also reads pgrst.* settings from its login role.
  const inDatabase = catalogue(`
    select c from pg_roles r, unnest(r.rolconfig) c
     where r.rolname = 'authenticator' and c like 'pgrst.%'`);
  for (const setting of inDatabase) {
    check(
      !/(^|[=,\s"])ops([,\s"]|$)/.test(setting),
      `the authenticator role carries a PostgREST setting naming ops: ${setting}`,
    );
  }

  const origin = apiOrigin();
  const rest = `${origin}/rest/v1`;
  const graphql = `${origin}/graphql/v1`;
  const keys = readKeys();
  let requests = 0;

  for (const [who, key] of Object.entries(keys)) {
    const control = await probe(`${rest}/${CONTROL_RELATION}?limit=0`, {
      headers: headersFor(key),
    });
    requests += 1;
    if (PRIVILEGED.has(who)) {
      check(
        control.status === 200,
        `${who}: positive control GET /${CONTROL_RELATION} returned ${control.status} ${control.code ?? ""}; this is not the privileged credential the matrix claims, so its refusals below prove nothing`,
      );
    } else {
      check(
        control.status === 401 && control.code === "42501",
        `${who}: positive control GET /${CONTROL_RELATION} returned ${control.status} ${control.code ?? ""}, expected 401 42501 (a live anon role); a rejected token would make its refusals below vacuous`,
      );
    }

    for (const relation of relations) {
      const read = await probe(`${rest}/${relation}?limit=1`, {
        headers: headersFor(key, { "Accept-Profile": "ops" }),
      });
      const write = await probe(`${rest}/${relation}`, {
        method: "POST",
        headers: headersFor(key, {
          "Content-Profile": "ops",
          "Content-Type": "application/json",
        }),
        body: UNPARSEABLE_BODY,
      });
      requests += 2;
      for (const [verb, attempt] of [
        ["GET", read],
        ["POST", write],
      ]) {
        check(
          attempt.status === 406 && attempt.code === "PGRST106",
          `${who}: ${verb} ops.${relation} by profile returned ${attempt.status} ${attempt.code ?? ""}, expected 406 PGRST106 (schema not exposed)`,
        );
      }

      if (!publicRelations.has(relation)) {
        const bare = await probe(`${rest}/${relation}?limit=1`, {
          headers: headersFor(key),
        });
        requests += 1;
        check(
          bare.status === 404 && bare.code === "PGRST205",
          `${who}: GET /${relation} on the default profile returned ${bare.status} ${bare.code ?? ""}, expected 404 PGRST205 (no such relation in the schema cache)`,
        );
      }
    }

    // Functions by profile only. A bare `/rpc/<name>` with an unparseable body
    // proves nothing: measured, PostgREST parses the body first and answers 400
    // PGRST102 even for a function that exists in no schema. Which schemas RPC
    // resolves in is PGRST_DB_SCHEMAS, asserted above.
    for (const fn of functions) {
      const call = await probe(`${rest}/rpc/${fn}`, {
        method: "POST",
        headers: headersFor(key, {
          "Content-Profile": "ops",
          "Content-Type": "application/json",
        }),
        body: UNPARSEABLE_BODY,
      });
      requests += 1;
      check(
        call.status === 406 && call.code === "PGRST106",
        `${who}: RPC ops.${fn} by profile returned ${call.status} ${call.code ?? ""}, expected 406 PGRST106`,
      );
    }

    const introspection = await probe(graphql, {
      method: "POST",
      headers: headersFor(key, { "Content-Type": "application/json" }),
      body: JSON.stringify({ query: INTROSPECTION }),
    });
    requests += 1;
    const schema = introspection.json?.data?.__schema;
    check(
      introspection.status === 200 && schema,
      `${who}: GraphQL introspection returned ${introspection.status} ${introspection.code ?? ""}; the GraphQL channel was not measured`,
    );
    const fields = [
      ...(schema?.queryType?.fields ?? []),
      ...(schema?.mutationType?.fields ?? []),
    ].map((field) => field.name);
    const occurrences = (name) => fields.filter((f) => f === name).length;
    if (PRIVILEGED.has(who)) {
      check(
        fields.includes("contactsCollection"),
        `${who}: GraphQL reflected no CRM table; an empty schema would pass every ops check below`,
      );
    }
    for (const relation of relations) {
      const allowed = publicRelations.has(relation) ? 1 : 0;
      for (const field of graphqlFieldsFor(relation)) {
        check(
          occurrences(field) <= allowed,
          `${who}: GraphQL exposes ${field} ${occurrences(field)} time(s); ops.${relation} is reflected through pg_graphql`,
        );
      }
    }
    for (const fn of functions) {
      const allowed = publicFunctions.has(fn) ? 1 : 0;
      check(
        occurrences(fn) <= allowed,
        `${who}: GraphQL exposes ${fn} ${occurrences(fn)} time(s); ops.${fn} is reflected through pg_graphql`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  process.stdout.write(
    `  ${relations.length} ops relations, ${functions.length} ops functions, ${Object.keys(keys).length} credentials: ${requests} Data API requests over REST and GraphQL, none reached ops\n`,
  );
}

main().catch((error) => {
  console.error(`  ${error.message}`);
  process.exit(1);
});
