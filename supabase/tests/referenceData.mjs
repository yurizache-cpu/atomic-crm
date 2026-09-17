// Global reference data exists, and development data is not what provides it
// (owner decision 2026-09-13, SI-25).
//
//   node supabase/tests/referenceData.mjs                 every reference domain
//                                                         present exactly once
//   node supabase/tests/referenceData.mjs --without-seed  also: no loss reasons,
//                                                         no Company OS tenant,
//                                                         no CRM rows, and no
//                                                         model price or spend
//                                                         limit
//
// `npm run test:db` runs the first form against the seeded local stack. CI runs
// the second after replaying migrations alone, which is how a hosted project is
// initialised. The reference list is read from the migration that ships it, so
// the migration and this check cannot drift apart.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const MIGRATION_NAME = "_favicons_excluded_domains_reference.sql";
const CONTAINER =
  process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_atomic-crm-e2e";
const DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

const args = process.argv.slice(2);
const withoutSeed = args.includes("--without-seed");
if (args.some((arg) => arg !== "--without-seed")) {
  console.error(
    "usage: node supabase/tests/referenceData.mjs [--without-seed]",
  );
  process.exit(2);
}

function referenceDomains() {
  const file = readdirSync(MIGRATIONS).find((name) =>
    name.endsWith(MIGRATION_NAME),
  );
  if (!file) throw new Error(`no migration ending ${MIGRATION_NAME}`);
  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  // Sliced rather than matched: scripts/production-scope.mjs reads a bracket
  // expression on a tracked line as a glob that could reach the seed file.
  const start = sql.indexOf("array[");
  const end = start === -1 ? -1 : sql.indexOf("]", start);
  if (end === -1) throw new Error(`${file} holds no domain array`);
  const domains = [
    ...sql.slice(start + "array[".length, end).matchAll(/'([^']*)'/g),
  ].map((m) => m[1]);
  const invalid = domains.filter((domain) => !DOMAIN.test(domain));
  if (domains.length === 0 || invalid.length > 0) {
    throw new Error(`${file} holds an unreadable domain list`);
  }
  return { version: file.slice(0, 14), domains };
}

function psql(sql) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-F",
      "\t",
    ],
    { input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql in ${CONTAINER} failed: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

const failures = [];
const check = (ok, message) => {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${message}\n`);
  if (!ok) failures.push(message);
};

try {
  const { version, domains } = referenceDomains();
  const values = domains.map((domain) => `('${domain}')`).join(",");

  const [[applied]] = psql(
    `select count(*) from supabase_migrations.schema_migrations where version = '${version}';`,
  );
  check(applied === "1", `migration ${version} is applied`);

  const wrong = psql(
    `with listed(domain) as (values ${values})
     select listed.domain, count(existing.id)
     from listed
     left join public.favicons_excluded_domains existing
       on existing.domain = listed.domain
     group by listed.domain
     having count(existing.id) <> 1
     order by 1;`,
  );
  check(
    wrong.length === 0,
    `all ${domains.length} reference domains present exactly once` +
      (wrong.length
        ? ` (${wrong.map(([d, n]) => `${d}=${n}`).join(", ")})`
        : ""),
  );

  if (withoutSeed) {
    const [[lossReasons, tenants, companies, contacts]] = psql(
      `select (select count(*) from public.loss_reasons),
              (select count(*) from ops.tenants),
              (select count(*) from ops.companies),
              (select count(*) from public.contacts);`,
    );
    check(
      lossReasons === "0",
      `no loss reasons: tenant vocabulary waits for onboarding (found ${lossReasons})`,
    );
    check(tenants === "0", `no Company OS tenant (found ${tenants})`);
    check(companies === "0", `no Company OS company (found ${companies})`);
    check(contacts === "0", `no CRM contact (found ${contacts})`);

    // Prices and spend limits are owner data (ADR 0017): a migration that shipped
    // one would price runs, or admit spend, with a number nobody recorded.
    const [[modelPrices, spendLimits]] = psql(
      `select (select count(*) from ops.model_prices),
              (select count(*) from ops.spend_limits);`,
    );
    check(
      modelPrices === "0",
      `no model price: prices are recorded by an owner act, never shipped by a migration (found ${modelPrices})`,
    );
    check(
      spendLimits === "0",
      `no spend limit: limits are set by an owner act, never shipped by a migration (found ${spendLimits})`,
    );
  }
} catch (error) {
  console.error(`reference data could not be checked: ${error.message}`);
  process.exit(2);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} reference data check(s) failed.`);
  process.exit(1);
}
process.stdout.write(
  `\nreference data holds${withoutSeed ? " without the development data" : ""}.\n`,
);
