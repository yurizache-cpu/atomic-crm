// The Data API surface around the operator functions: key credentials, the
// closed ops schema, GraphQL and OpenAPI, and the live catalogue itself
// (supabase/tests/companyOsApiExposure.mjs).

import {
  CATALOGUE,
  SCHEMA_REFUSAL,
  authOf,
  check,
  expectAnswer,
  psql,
  request,
} from "./common.mjs";

/** Refused by a closed schema before parsing; unparseable if the schema is open. */
const UNPARSEABLE_BODY = "[";
const INTROSPECTION =
  "{ __schema { queryType { fields { name } } mutationType { fields { name } } } }";

/** Every key credential is refused at the schema, for every function. */
export async function keysAreRefused(t, rpc) {
  for (const [who, credential] of Object.entries(t.keyCredentials)) {
    const status = who === "service_role" || who === "secret" ? 403 : 401;
    for (const fn of CATALOGUE) {
      const answer = await rpc(fn, t.argsFor(fn), credential);
      expectAnswer(answer, status, SCHEMA_REFUSAL, `${who}: ${fn}`);
    }
  }
}

/** ops by profile answers 406 PGRST106 to every credential. */
export async function opsStaysClosed(t, rest) {
  const relations = psql(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and c.relkind in ('r', 'v', 'm', 'p', 'f') order by 1;`);
  const functions = [
    ...new Set(
      psql(`
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'ops' order by 1;`),
    ),
  ];
  t.opsRelations = relations;
  t.opsFunctions = functions;
  check(
    ["principals", "tenant_memberships", "tenants"].every((r) =>
      relations.includes(r),
    ) &&
      ["operator_scope", "gate_operator_context", "grant_membership"].every(
        (f) => functions.includes(f),
      ),
    "the ops catalogue lacks the Phase 2C objects; is 20260922120000_company_os_read_surface applied?",
  );
  const attempt = async (who, credential, kind, name) => {
    const answer =
      kind === "relation"
        ? await request(`${rest}/${name}?limit=1`, {
            headers: { ...authOf(credential), "Accept-Profile": "ops" },
          })
        : await request(`${rest}/rpc/${name}`, {
            method: "POST",
            headers: {
              ...authOf(credential),
              "Content-Profile": "ops",
              "Content-Type": "application/json",
            },
            body: UNPARSEABLE_BODY,
          });
    expectAnswer(answer, 406, "PGRST106", `${who}: ops.${name} by profile`);
  };
  const callers = {
    ...t.keyCredentials,
    "signed-in non-member": t.nonMember.credential,
  };
  for (const [who, credential] of Object.entries(callers)) {
    for (const name of ["principals", "tenant_memberships", "tenants"]) {
      await attempt(who, credential, "relation", name);
    }
    for (const name of ["operator_scope", "gate_operator_context"]) {
      await attempt(who, credential, "function", name);
    }
  }
  // The signed-in member, across the whole live catalogue.
  for (const name of relations) {
    await attempt("member", t.member.credential, "relation", name);
  }
  for (const name of functions) {
    await attempt("member", t.member.credential, "function", name);
  }
}

const rpcPaths = (answer) =>
  Object.keys(answer.json?.paths ?? {}).filter((p) => p.startsWith("/rpc/"));
const sameList = (a, b) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** GraphQL with a member's JWT, and the anonymous OpenAPI document. */
export async function graphqlAndOpenApi(t, origin, rest) {
  const introspection = await request(`${origin}/graphql/v1`, {
    method: "POST",
    headers: {
      ...authOf(t.member.credential),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: INTROSPECTION }),
  });
  const schema = introspection.json?.data?.__schema;
  const fields = [
    ...(schema?.queryType?.fields ?? []),
    ...(schema?.mutationType?.fields ?? []),
  ].map((field) => field.name);
  check(
    introspection.status === 200 && fields.includes("contactsCollection"),
    `member: GraphQL introspection returned ${introspection.status} without the CRM's tables; the channel was not measured`,
  );
  const publicNames = new Set(
    psql(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
      union select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public';`),
  );
  const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const reflected = [
    ...CATALOGUE.flatMap((fn) => [fn, camel(fn)]),
    ...t.opsFunctions.filter((fn) => !publicNames.has(fn)),
    // The field names pg_graphql derives from a relation.
    ...t.opsRelations
      .filter((relation) => !publicNames.has(relation))
      .flatMap((r) => [
        `${r}Collection`,
        `insertInto${r}Collection`,
        `update${r}Collection`,
        `deleteFrom${r}Collection`,
      ]),
  ];
  for (const field of fields) {
    check(
      !/company_?os/i.test(field) && !reflected.includes(field),
      `member: GraphQL exposes ${field}`,
    );
  }

  for (const [who, credential] of [
    ["none", t.keyCredentials.none],
    ["anon", t.keyCredentials.anon],
  ]) {
    const standard = await request(`${rest}/`, { headers: authOf(credential) });
    const profiled = await request(`${rest}/`, {
      headers: { ...authOf(credential), "Accept-Profile": "company_os_api" },
    });
    check(
      standard.status === 200 && standard.json?.swagger && standard.json?.paths,
      `${who}: the default OpenAPI document returned ${standard.status}; the check would read nothing`,
    );
    check(
      !rpcPaths(standard).some((path) =>
        CATALOGUE.includes(path.slice("/rpc/".length)),
      ),
      `${who}: the default OpenAPI document lists a company_os_api function`,
    );
    check(
      rpcPaths(profiled).length === 0,
      `${who}: the company_os_api OpenAPI document lists ${rpcPaths(profiled).join(", ")}`,
    );
  }
  await catalogueIsExact(t, rest);
}

/**
 * The live catalogue equals the probe's CATALOGUE exactly, both as PostgREST
 * exposes it to a member and as the database defines it: a function added to
 * company_os_api fails the probe until it has an entry here, and so a matrix.
 * The member's document listing the catalogue is also the positive control of
 * the anonymous check above.
 */
async function catalogueIsExact(t, rest) {
  const memberDocument = await request(`${rest}/`, {
    headers: {
      ...authOf(t.member.credential),
      "Accept-Profile": "company_os_api",
    },
  });
  const exposed = rpcPaths(memberDocument).map((p) => p.slice("/rpc/".length));
  check(
    memberDocument.status === 200 && sameList(exposed, CATALOGUE),
    `member: the company_os_api OpenAPI document lists [${[...exposed].sort().join(", ")}], not exactly the probe's catalogue`,
  );
  const defined = psql(`
    select p.proname from pg_proc p
     where p.pronamespace = 'company_os_api'::regnamespace order by 1;`);
  check(
    sameList(defined, CATALOGUE),
    `company_os_api defines [${defined.join(", ")}], not exactly the probe's catalogue (an overload counts twice)`,
  );
}
