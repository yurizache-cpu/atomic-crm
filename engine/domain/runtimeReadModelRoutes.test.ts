// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import {
  formatWorkerDetail,
  type RouteSummaryEntry,
} from "../models/routeSummary.ts";
import { CompanyOsError } from "./errors.ts";
import {
  MAX_LISTED_WORKERS,
  ROUTE_PRICING_SQL,
  listWorkerRoutes,
} from "./runtimeReadModelRoutes.ts";

// The owner's read of the routes recently seen workers published, with no database. What
// the database answers about each route (a price, a ceiling, the reservations) is
// proven against a real Postgres by the driver-backed tests.

const PRICE = "f0000000-0000-4000-8000-00000000000f";
const SEEN = "2026-09-17T13:45:00.000000Z";

// Assembled, so no key-shaped literal sits in the source.
const keyShaped = (suffix: string) =>
  ["sk", "proj", "not", "a", "real", "key", suffix].join("-");

const standard: RouteSummaryEntry = {
  route: "standard",
  provider: "openai",
  model: "gpt-test-2026-01-01",
  maxOutputTokens: 8000,
  timeoutMs: 45_000,
};
const economy: RouteSummaryEntry = {
  route: "economy",
  provider: "openai",
  model: "gpt-test-mini-2026-01-01",
  maxOutputTokens: 2000,
  timeoutMs: 20_000,
};

const worker = (workerId: string, detail: string | null) => ({
  worker_id: workerId,
  last_seen_at: SEEN,
  stopped_at: null,
  detail,
});

interface PricingAnswer {
  readonly price_id: string | null;
  readonly max_output_tokens: number | null;
  readonly smallest_reservation_micros: string | null;
  readonly largest_reservation_micros: string | null;
}

const priced: PricingAnswer = {
  price_id: PRICE,
  max_output_tokens: 8000,
  smallest_reservation_micros: "100480",
  largest_reservation_micros: "342345",
};

/**
 * Workers as given; pricing rows answered per requested route, in request order,
 * by `pricing(route, index)`, unless `pricingRows` replaces them outright.
 */
const routesDatabase = (options: {
  readonly workers: readonly unknown[];
  readonly pricing?: (route: string, index: number) => PricingAnswer;
  readonly pricingRows?: readonly unknown[];
}) => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("from ops.worker_instances")) {
        return { rows: [...options.workers] as TRow[] };
      }
      if (options.pricingRows !== undefined) {
        return { rows: [...options.pricingRows] as TRow[] };
      }
      const routes = params[0] as string[];
      const answer = options.pricing ?? (() => priced);
      return {
        rows: routes.map((route, index) => ({
          ord: index + 1,
          ...answer(route, index),
        })) as TRow[],
      };
    },
  };
  return { tx, calls };
};

const outcomeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

describe("listing the routes the most recently seen workers published", () => {
  it("shows each published route with its current price, the database ceiling and the smallest and largest reservation", async () => {
    const { tx } = routesDatabase({
      workers: [worker("worker-a", formatWorkerDetail("running", [standard]))],
    });

    const [row] = await listWorkerRoutes(tx);

    expect(row).toEqual({
      workerId: "worker-a",
      lastSeenAt: SEEN,
      stoppedAt: null,
      detail: "published",
      state: "running",
      routes: [
        {
          ...standard,
          priceId: PRICE,
          priced: true,
          databaseMaxOutputTokens: 8000,
          matchesDatabase: true,
          smallestReservationMicros: "100480",
          largestReservationMicros: "342345",
          smallestReservationUsd: "0.100480",
          largestReservationUsd: "0.342345",
        },
      ],
    });
  });

  it("reads the most recently seen workers first, bounded", async () => {
    const { tx, calls } = routesDatabase({ workers: [] });

    expect(await listWorkerRoutes(tx)).toEqual([]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([MAX_LISTED_WORKERS]);
    expect(calls[0]?.sql).toMatch(/order by w\.last_seen_at desc/);
  });

  it("prices each distinct published route once, through array parameters only", async () => {
    const detail = formatWorkerDetail("running", [standard, economy]);
    const { tx, calls } = routesDatabase({
      workers: [worker("worker-a", detail), worker("worker-b", detail)],
      pricing: (route) =>
        route === "economy" ? { ...priced, max_output_tokens: 2000 } : priced,
    });

    const rows = await listWorkerRoutes(tx);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual([
      ["standard", "economy"],
      ["openai", "openai"],
      [standard.model, economy.model],
    ]);
    expect(calls[1]?.sql).not.toContain(standard.model);
    expect(rows.map((row) => row.routes?.map((r) => r.route))).toEqual([
      ["standard", "economy"],
      ["standard", "economy"],
    ]);
    expect(rows[0]?.routes?.[1]).toMatchObject({
      databaseMaxOutputTokens: 2000,
      matchesDatabase: true,
    });
  });

  it("marks a route whose published ceiling differs from the database's, since every start on it is refused", async () => {
    const { tx } = routesDatabase({
      workers: [
        worker(
          "worker-old",
          formatWorkerDetail("running", [
            { ...standard, maxOutputTokens: 9000 },
          ]),
        ),
      ],
    });

    const [row] = await listWorkerRoutes(tx);

    expect(row?.routes?.[0]).toMatchObject({
      maxOutputTokens: 9000,
      databaseMaxOutputTokens: 8000,
      matchesDatabase: false,
    });
  });

  it("reports a route with no current price as unpriced, with no reservation", async () => {
    const { tx } = routesDatabase({
      workers: [worker("worker-a", formatWorkerDetail("running", [standard]))],
      pricing: () => ({
        price_id: null,
        max_output_tokens: 8000,
        smallest_reservation_micros: null,
        largest_reservation_micros: null,
      }),
    });

    const [row] = await listWorkerRoutes(tx);

    expect(row?.routes?.[0]).toMatchObject({
      priceId: null,
      priced: false,
      smallestReservationMicros: null,
      largestReservationMicros: null,
      smallestReservationUsd: null,
      largestReservationUsd: null,
    });
  });

  it("reports a worker with no detail or an unreadable one, and asks for no price when nothing was published", async () => {
    const { tx, calls } = routesDatabase({
      workers: [
        worker("worker-silent", null),
        worker("worker-older", "starting"),
        worker(
          "worker-widened",
          JSON.stringify({
            version: "worker.detail.v1",
            state: "running",
            routes: [{ ...standard, apiKey: "x" }],
          }),
        ),
      ],
    });

    const rows = await listWorkerRoutes(tx);

    expect(
      rows.map(({ detail, state, routes }) => ({ detail, state, routes })),
    ).toEqual([
      { detail: "absent", state: null, routes: null },
      { detail: "unreadable", state: null, routes: null },
      { detail: "unreadable", state: null, routes: null },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("never prints a key-shaped model id or worker id that a worker published", async () => {
    const key = keyShaped("0001");
    const { tx, calls } = routesDatabase({
      workers: [
        worker(
          "worker-a",
          formatWorkerDetail("running", [{ ...standard, model: key }]),
        ),
        worker(keyShaped("0002"), formatWorkerDetail("running", [])),
      ],
    });

    const rows = await listWorkerRoutes(tx);

    expect(rows[0]).toMatchObject({
      detail: "withheld",
      state: null,
      routes: null,
    });
    expect(rows[1]?.workerId).toBe("[withheld]");
    const printed = JSON.stringify(rows);
    expect(printed).not.toMatch(/sk-/i);
    for (const call of calls) {
      expect(JSON.stringify(call.params)).not.toContain(key);
    }
  });

  it("sizes the largest reservation from a worst-case context of escaped text at every field's bound", () => {
    expect(ROUTE_PRICING_SQL).toContain(
      "ops.agent_run_input_token_ceiling('{}'::jsonb)",
    );
    for (const bound of [
      "'name', repeat(chr(1), 200)",
      "'role', repeat(chr(1), 200)",
      "'description', repeat(chr(1), 2000)",
      "'type', repeat('a', 100)",
      "'title', repeat(chr(1), 300)",
      "'description', repeat(chr(1), 10000)",
      "'priority', 1000",
      "'due_at', now()",
    ]) {
      expect(ROUTE_PRICING_SQL).toContain(bound);
    }
    expect(ROUTE_PRICING_SQL).toContain(
      "ops.current_model_price(p.provider, p.model, now())",
    );
    expect(ROUTE_PRICING_SQL).toMatch(
      /left join ops\.agent_run_route_policies\(\) pol on pol\.model_route = p\.route/,
    );
    expect(ROUTE_PRICING_SQL).toMatch(/pol\.max_output_tokens\)::text/);
  });

  it("refuses a pricing answer for a route it did not ask about", async () => {
    const { tx } = routesDatabase({
      workers: [worker("worker-a", formatWorkerDetail("running", [standard]))],
      pricingRows: [{ ord: 2, ...priced }],
    });

    expect(await outcomeOf(listWorkerRoutes(tx))).toBeInstanceOf(Error);
  });

  it("refuses a published route that comes back without its pricing", async () => {
    const { tx } = routesDatabase({
      workers: [worker("worker-a", formatWorkerDetail("running", [standard]))],
      pricingRows: [],
    });

    expect(await outcomeOf(listWorkerRoutes(tx))).toBeInstanceOf(Error);
  });

  it("surfaces the database's refusal to read prices under row security as a typed error", async () => {
    const tx: TxClient = {
      query: async () => {
        throw Object.assign(
          new Error(
            "ops.current_model_price: row security would hide the prices from this caller",
          ),
          { code: "OS403", severity: "ERROR" },
        );
      },
    };

    expect(await outcomeOf(listWorkerRoutes(tx))).toBe("refused");
  });
});
