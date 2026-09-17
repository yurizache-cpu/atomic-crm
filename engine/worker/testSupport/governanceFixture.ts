// The runtime governance a driver-backed suite needs before any agent run can
// start (ADR 0017): a current price for the provider and model a route names, a
// global daily ceiling, and each tenant's daily budget. Without all three every
// start is refused, so dbFixture.ts configures them on every reset.
//
// Reached through dbFixture.ts, which refuses any database that is not on this
// machine before a pool exists: these helpers retire whatever ceiling is in
// force, and delete what a suite recorded.
//
// Every value here is synthetic. The price is not a vendor's price, and the
// limits are far above anything a suite spends, so a test that is about a limit
// sets its own over them.

import type { Pool } from "pg";

/** The actor every fixture act is recorded under; cleanup keys on its prefix. */
const ACTOR = "dbtest";

/** The provider the suites' routes name, and every model id they configure. */
export const FIXTURE_PROVIDER = "fake";
export const FIXTURE_MODELS: readonly string[] = Object.freeze([
  "fake-model-1",
]);

/** Far above anything a suite spends: 1,000,000 USD and 100,000 USD a day. */
export const FIXTURE_GLOBAL_LIMIT_MICROS = "1000000000000";
export const FIXTURE_TENANT_LIMIT_MICROS = "100000000000";

/** USD per million tokens, input and output alike. */
const FIXTURE_RATE_USD_PER_MTOK = "0.5";

export interface GovernanceOptions {
  /** Tenants that get a budget. */
  readonly tenantIds: readonly string[];
  readonly globalLimitMicros?: string;
  readonly tenantLimitMicros?: string;
  /** USD per million tokens, as exact decimals. */
  readonly inputUsdPerMtok?: string;
  readonly outputUsdPerMtok?: string;
}

export interface FixtureGovernance {
  /** The synthetic price version of each fixture model, by model id. */
  readonly priceIds: Readonly<Record<string, string>>;
  readonly globalLimitId: string;
  /** The budget of each configured tenant, by tenant id. */
  readonly tenantLimitIds: Readonly<Record<string, string>>;
}

/**
 * Records a synthetic price version for every fixture model, effective an hour
 * ago and expiring in a day, with reasoning inside output; retires the active
 * global ceiling and the tenants' active limits, whoever set them; then sets a
 * large ceiling and large budgets, all in UTC. A test that needs a tighter
 * limit sets one over these with ops.set_spend_limit (UTC), or retires them.
 */
export async function recordGovernance(
  admin: Pool,
  options: GovernanceOptions,
): Promise<FixtureGovernance> {
  const priceIds: Record<string, string> = {};
  for (const model of FIXTURE_MODELS) {
    const { rows } = await admin.query<{ id: string }>(
      `select ops.record_model_price(
                $1, $2, $3::numeric, $4::numeric, true,
                now() - interval '1 hour', now() + interval '1 day',
                'dbtest synthetic price', $5) as id`,
      [
        FIXTURE_PROVIDER,
        model,
        options.inputUsdPerMtok ?? FIXTURE_RATE_USD_PER_MTOK,
        options.outputUsdPerMtok ?? FIXTURE_RATE_USD_PER_MTOK,
        ACTOR,
      ],
    );
    priceIds[model] = rows[0].id;
  }

  const { rows: active } = await admin.query<{ id: string }>(
    `select id from ops.spend_limits
      where ended_at is null
        and (scope = 'global' or tenant_id = any($1::uuid[]))`,
    [options.tenantIds],
  );
  for (const limit of active) {
    await admin.query(
      "select ops.retire_spend_limit($1, 'dbtest governance reset', $2)",
      [limit.id, ACTOR],
    );
  }

  const setLimit = async (
    scope: "global" | "tenant",
    micros: string,
    tenantId: string | null,
  ): Promise<string> => {
    const { rows } = await admin.query<{ id: string }>(
      `select ops.set_spend_limit($1, $2::bigint, 'UTC', $3, $4, $5::uuid) as id`,
      [scope, micros, `dbtest ${scope} limit`, ACTOR, tenantId],
    );
    return rows[0].id;
  };
  const globalLimitId = await setLimit(
    "global",
    options.globalLimitMicros ?? FIXTURE_GLOBAL_LIMIT_MICROS,
    null,
  );
  const tenantLimitIds: Record<string, string> = {};
  for (const tenantId of options.tenantIds) {
    tenantLimitIds[tenantId] = await setLimit(
      "tenant",
      options.tenantLimitMicros ?? FIXTURE_TENANT_LIMIT_MICROS,
      tenantId,
    );
  }
  return { priceIds, globalLimitId, tenantLimitIds };
}

/**
 * Removes the tenant-less governance data these suites record: global spend
 * limits a suite set (set_by starts with `dbtest`), ended first when active
 * because an active limit is never deleted, and the price versions a suite
 * recorded. A tenant's limits go with its other rows (deleteCompanyOsRows).
 *
 * Call it after the fixture tenants' runs are gone: a run references its price
 * version and the limit that refused it, both ON DELETE RESTRICT.
 */
export async function deleteFixtureGovernance(admin: Pool): Promise<void> {
  await admin.query(
    `update ops.spend_limits
        set ended_by = $1, end_reason = 'dbtest cleanup'
      where scope = 'global' and set_by like 'dbtest%' and ended_at is null`,
    [ACTOR],
  );
  await admin.query(
    "delete from ops.spend_limits where scope = 'global' and set_by like 'dbtest%'",
  );
  await admin.query(
    "delete from ops.model_prices where recorded_by like 'dbtest%'",
  );
}
