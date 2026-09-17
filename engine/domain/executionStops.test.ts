// @vitest-environment node
import { describe, expect, expectTypeOf, it } from "vitest";
import type { TxClient } from "../db/types.ts";
import { CompanyOsError } from "./errors.ts";
import {
  EXECUTION_STOP_SCOPES,
  MAX_LISTED_EXECUTION_STOPS,
  clearExecutionStop,
  listExecutionStops,
  tripExecutionStop,
  tripExecutionStopWithOutcome,
  type ExecutionStopAct,
  type ExecutionStopTarget,
} from "./executionStops.ts";

// What the typed boundary itself decides, with no database. That a stop holds the
// jobs it covers — at the lease, before the call, and for agent runs at request
// and start, deny winning — needs one, and is proven against a real Postgres in
// the SQL suites and the driver-backed tests.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const COMPANY = "b0000000-0000-4000-8000-00000000000b";
const DEPARTMENT = "c0000000-0000-4000-8000-00000000000c";
const AGENT = "d0000000-0000-4000-8000-00000000000d";
const STOP = "e0000000-0000-4000-8000-00000000000e";
const KIND = "agent_run.execute";

const TRIP_SQL =
  "select ops.trip_execution_stop($1, $2, $3, $4, $5, $6, $7, $8) as result";
const CLEAR_SQL = "select ops.clear_execution_stop($1, $2, $3) as result";

interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A database that answers every call with `rows` and records what it was sent. */
const recordingDatabase = (rows: readonly unknown[]) => {
  const calls: RecordedCall[] = [];
  const tx: TxClient = {
    async query<TRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [...rows] as TRow[] };
    },
  };
  return { tx, calls };
};

const answering = (result: unknown) => recordingDatabase([{ result }]);

/** A database that must never be reached. */
const unreachable: TxClient = {
  query: () => {
    throw new Error("the database was reached with input that is never valid");
  },
};

const failingWith = (code: string, message: string): TxClient => ({
  query: async () => {
    throw Object.assign(new Error(message), { code });
  },
});

const ACT: ExecutionStopAct = {
  reason: "runaway retries on the assessment route",
  actor: "owner",
};

const outcomeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CompanyOsError ? error.code : error;
  }
  return "resolved";
};

describe("tripping an execution stop", () => {
  it.each<[ExecutionStopTarget, readonly unknown[]]>([
    [{ scope: "global" }, [null, null, null, null, null]],
    [{ scope: "tenant", tenantId: TENANT }, [TENANT, null, null, null, null]],
    [
      { scope: "company", tenantId: TENANT, companyId: COMPANY },
      [TENANT, COMPANY, null, null, null],
    ],
    [
      {
        scope: "department",
        tenantId: TENANT,
        companyId: COMPANY,
        departmentId: DEPARTMENT,
      },
      [TENANT, COMPANY, DEPARTMENT, null, null],
    ],
    [
      { scope: "agent", tenantId: TENANT, companyId: COMPANY, agentId: AGENT },
      [TENANT, COMPANY, null, AGENT, null],
    ],
    [{ scope: "job_kind", jobKind: KIND }, [null, null, null, null, KIND]],
    [
      { scope: "job_kind", tenantId: TENANT, jobKind: KIND },
      [TENANT, null, null, null, KIND],
    ],
  ])(
    "sends a well-formed %o target as scope, reason, actor and its five coordinates",
    async (target, coordinates) => {
      const { tx, calls } = answering(STOP);

      const id = await tripExecutionStop(tx, target, ACT);

      expect(id).toBe(STOP);
      expect(calls).toEqual([
        {
          sql: TRIP_SQL,
          params: [target.scope, ACT.reason, ACT.actor, ...coordinates],
        },
      ]);
    },
  );

  it("covers every scope the database knows", () => {
    expect([...EXECUTION_STOP_SCOPES]).toEqual([
      "global",
      "tenant",
      "company",
      "department",
      "agent",
      "job_kind",
    ]);
  });

  it.each<[string, ExecutionStopTarget, string]>([
    ["an unknown scope", { scope: "fleet" as never }, "invalid_argument"],
    ["an upper-case scope", { scope: "GLOBAL" as never }, "invalid_argument"],
    [
      "a global stop naming a tenant",
      { scope: "global", tenantId: TENANT },
      "invalid_argument",
    ],
    [
      "a tenant stop with no tenant",
      { scope: "tenant" },
      "missing_tenant_scope",
    ],
    [
      "a tenant stop with an empty tenant",
      { scope: "tenant", tenantId: "" },
      "missing_tenant_scope",
    ],
    [
      "a company stop with no tenant",
      { scope: "company", companyId: COMPANY },
      "missing_tenant_scope",
    ],
    [
      "an agent stop with no tenant",
      { scope: "agent", companyId: COMPANY, agentId: AGENT },
      "missing_tenant_scope",
    ],
    [
      "a tenant stop naming a company",
      { scope: "tenant", tenantId: TENANT, companyId: COMPANY },
      "invalid_argument",
    ],
    [
      "a company stop with no company",
      { scope: "company", tenantId: TENANT },
      "invalid_argument",
    ],
    [
      "a company stop naming a department",
      {
        scope: "company",
        tenantId: TENANT,
        companyId: COMPANY,
        departmentId: DEPARTMENT,
      },
      "invalid_argument",
    ],
    [
      "a department stop with no department",
      { scope: "department", tenantId: TENANT, companyId: COMPANY },
      "invalid_argument",
    ],
    [
      "a department stop naming an agent",
      {
        scope: "department",
        tenantId: TENANT,
        companyId: COMPANY,
        departmentId: DEPARTMENT,
        agentId: AGENT,
      },
      "invalid_argument",
    ],
    [
      "an agent stop with no company",
      { scope: "agent", tenantId: TENANT, agentId: AGENT },
      "invalid_argument",
    ],
    [
      "an agent stop naming a department",
      {
        scope: "agent",
        tenantId: TENANT,
        companyId: COMPANY,
        departmentId: DEPARTMENT,
        agentId: AGENT,
      },
      "invalid_argument",
    ],
    [
      "a job_kind stop with no kind",
      { scope: "job_kind", tenantId: TENANT },
      "invalid_argument",
    ],
    [
      "a job_kind stop naming a company",
      {
        scope: "job_kind",
        tenantId: TENANT,
        companyId: COMPANY,
        jobKind: KIND,
      },
      "invalid_argument",
    ],
    [
      "a job_kind stop naming an agent",
      { scope: "job_kind", jobKind: KIND, agentId: AGENT },
      "invalid_argument",
    ],
    [
      "a job_kind stop with an empty tenant",
      { scope: "job_kind", tenantId: "", jobKind: KIND },
      "malformed_identifier",
    ],
    [
      "a global stop naming a kind",
      { scope: "global", jobKind: KIND },
      "invalid_argument",
    ],
    [
      "a tenant stop naming a kind",
      { scope: "tenant", tenantId: TENANT, jobKind: KIND },
      "invalid_argument",
    ],
    [
      "an agent stop naming a kind",
      {
        scope: "agent",
        tenantId: TENANT,
        companyId: COMPANY,
        agentId: AGENT,
        jobKind: KIND,
      },
      "invalid_argument",
    ],
    [
      "a kind with no namespace",
      { scope: "job_kind", jobKind: "execute" },
      "invalid_argument",
    ],
    [
      "a kind in upper case",
      { scope: "job_kind", jobKind: "Agent_Run.Execute" },
      "invalid_argument",
    ],
    [
      "a kind with a wildcard",
      { scope: "job_kind", jobKind: "agent_run.*" },
      "invalid_argument",
    ],
    [
      "a kind with a trailing dot",
      { scope: "job_kind", jobKind: "agent_run." },
      "invalid_argument",
    ],
    [
      "a 101-character kind",
      { scope: "job_kind", jobKind: `a.${"b".repeat(99)}` },
      "invalid_argument",
    ],
    [
      "a malformed tenant",
      { scope: "tenant", tenantId: "tenant-a" },
      "malformed_identifier",
    ],
    [
      "a malformed agent",
      {
        scope: "agent",
        tenantId: TENANT,
        companyId: COMPANY,
        agentId: "agent-7",
      },
      "malformed_identifier",
    ],
  ])("refuses %s before reaching the database", async (_case, target, code) => {
    expect(await outcomeOf(tripExecutionStop(unreachable, target, ACT))).toBe(
      code,
    );
  });

  it.each<[string, ExecutionStopAct]>([
    ["an empty reason", { reason: "", actor: "owner" }],
    ["a reason of spaces", { reason: "   ", actor: "owner" }],
    ["a reason with no visible character", { reason: "\t\n", actor: "owner" }],
    ["a 501-character reason", { reason: "r".repeat(501), actor: "owner" }],
    ["an empty actor", { reason: "incident", actor: "" }],
    ["an upper-case actor", { reason: "incident", actor: "Owner" }],
    [
      "an actor starting with punctuation",
      { reason: "incident", actor: "-owner" },
    ],
    ["an actor with a space", { reason: "incident", actor: "the owner" }],
    ["a 129-character actor", { reason: "incident", actor: "a".repeat(129) }],
    [
      "an actor claiming the system: prefix",
      { reason: "incident", actor: "system:spend_ceiling" },
    ],
  ])("refuses %s before reaching the database", async (_case, act) => {
    expect(
      await outcomeOf(tripExecutionStop(unreachable, { scope: "global" }, act)),
    ).toBe("invalid_argument");
  });

  it("measures a reason as the database does, after trimming the spaces around it", async () => {
    const { tx, calls } = answering(STOP);
    const reason = `  ${"r".repeat(500)}  `;

    await tripExecutionStop(
      tx,
      { scope: "global" },
      { reason, actor: "ops:on-call@example" },
    );

    expect(calls[0]?.params.slice(0, 3)).toEqual([
      "global",
      reason,
      "ops:on-call@example",
    ]);
  });

  it("offers no force or override, and never forwards one set on the act or the target", async () => {
    expectTypeOf<keyof ExecutionStopAct>().toEqualTypeOf<"reason" | "actor">();
    expectTypeOf<keyof ExecutionStopTarget>().toEqualTypeOf<
      | "scope"
      | "tenantId"
      | "companyId"
      | "departmentId"
      | "agentId"
      | "jobKind"
    >();
    expect(tripExecutionStop.length).toBe(3);
    expect(tripExecutionStopWithOutcome.length).toBe(3);
    expect(clearExecutionStop.length).toBe(3);

    const { tx, calls } = answering(STOP);
    const act = { ...ACT, force: true, override: true };
    const target = { scope: "global" as const, force: true };
    await tripExecutionStop(tx, target, act);

    expect(calls[0]?.params).toHaveLength(8);
    expect(calls[0]?.params).not.toContain(true);
  });

  it("surfaces the database's refusal as a typed error", async () => {
    expect(
      await outcomeOf(
        tripExecutionStop(
          failingWith(
            "OS404",
            "ops.trip_execution_stop: agent not found in this company",
          ),
          {
            scope: "agent",
            tenantId: TENANT,
            companyId: COMPANY,
            agentId: AGENT,
          },
          ACT,
        ),
      ),
    ).toBe("not_found");
  });

  it("rejects the promise rather than throwing", async () => {
    const pending = tripExecutionStop(unreachable, { scope: "tenant" }, ACT);

    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(CompanyOsError);
  });

  it("refuses to invent an id when the database returns none", async () => {
    const outcome = await outcomeOf(
      tripExecutionStop(answering(null).tx, { scope: "global" }, ACT),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
  });
});

describe("tripping an execution stop and reporting what the trip did", () => {
  /** A database whose trip returns STOP and whose read-back returns `stop`. */
  const trippingInto = (stop: {
    tripped_by: string;
    reason: string;
    recorded_now: boolean;
  }) => {
    const calls: RecordedCall[] = [];
    const tx: TxClient = {
      async query<TRow>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        const rows = sql === TRIP_SQL ? [{ result: STOP }] : [stop];
        return { rows: rows as TRow[] };
      },
    };
    return { tx, calls };
  };

  it("reports stopped when this act recorded the stop, reading it back in the same transaction", async () => {
    const { tx, calls } = trippingInto({
      tripped_by: ACT.actor,
      reason: ACT.reason,
      recorded_now: true,
    });

    expect(
      await tripExecutionStopWithOutcome(
        tx,
        { scope: "job_kind", jobKind: KIND },
        ACT,
      ),
    ).toEqual({ stopId: STOP, outcome: "stopped", trippedBy: ACT.actor });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toBe(TRIP_SQL);
    expect(calls[1]?.sql).toMatch(/from ops\.execution_stops s\b/);
    expect(calls[1]?.params).toEqual([STOP]);
  });

  it("decides that this act recorded the stop by the transaction clock, never by matching actor and reason alone", async () => {
    const { tx, calls } = trippingInto({
      tripped_by: ACT.actor,
      reason: ACT.reason,
      recorded_now: true,
    });

    await tripExecutionStopWithOutcome(tx, { scope: "global" }, ACT);

    // The insert guard stamps tripped_at with now(), the transaction's own
    // timestamp, so only a stop inserted by this transaction equals it. An older
    // stop with the same actor and reason must still read as already_stopped.
    expect(calls[1]?.sql).toMatch(
      /\bs\.tripped_at = now\(\) as recorded_now\b/,
    );
  });

  it.each([
    [
      "another actor tripped it",
      { tripped_by: "ops:on-call", reason: ACT.reason, recorded_now: false },
      "ops:on-call",
    ],
    [
      "the same actor tripped it earlier for another reason",
      {
        tripped_by: ACT.actor,
        reason: "an earlier incident",
        recorded_now: false,
      },
      ACT.actor,
    ],
    [
      "the same actor tripped it earlier for the same reason",
      { tripped_by: ACT.actor, reason: ACT.reason, recorded_now: false },
      ACT.actor,
    ],
    [
      "its reason was redacted",
      { tripped_by: ACT.actor, reason: "[redacted]", recorded_now: false },
      ACT.actor,
    ],
  ])(
    "reports already_stopped, naming the existing actor, when %s",
    async (_case, stop, trippedBy) => {
      const { tx } = trippingInto(stop);

      expect(
        await tripExecutionStopWithOutcome(tx, { scope: "global" }, ACT),
      ).toEqual({ stopId: STOP, outcome: "already_stopped", trippedBy });
    },
  );

  it("refuses a malformed target or act before reaching the database", async () => {
    expect(
      await outcomeOf(
        tripExecutionStopWithOutcome(unreachable, { scope: "job_kind" }, ACT),
      ),
    ).toBe("invalid_argument");
    expect(
      await outcomeOf(
        tripExecutionStopWithOutcome(
          unreachable,
          { scope: "global" },
          { reason: "incident", actor: "system:spend_ceiling" },
        ),
      ),
    ).toBe("invalid_argument");
  });

  it("refuses to report an outcome for a stop it cannot read back", async () => {
    const calls: RecordedCall[] = [];
    const tx: TxClient = {
      async query<TRow>(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: (sql === TRIP_SQL ? [{ result: STOP }] : []) as TRow[] };
      },
    };

    const outcome = await outcomeOf(
      tripExecutionStopWithOutcome(tx, { scope: "global" }, ACT),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
  });

  it("surfaces the database's refusal of a kind that is not external as a typed error", async () => {
    expect(
      await outcomeOf(
        tripExecutionStopWithOutcome(
          failingWith(
            "OS400",
            "ops.trip_execution_stop: 'postmark.ledger_retention' is not an external job kind, so a stop on it would hold nothing",
          ),
          { scope: "job_kind", jobKind: "postmark.ledger_retention" },
          ACT,
        ),
      ),
    ).toBe("invalid_argument");
  });
});

describe("clearing an execution stop", () => {
  it("sends the stop, the reason and the actor, and reports that it cleared the stop", async () => {
    const { tx, calls } = answering(true);

    expect(await clearExecutionStop(tx, STOP, ACT)).toBe(true);
    expect(calls).toEqual([
      { sql: CLEAR_SQL, params: [STOP, ACT.reason, ACT.actor] },
    ]);
  });

  it("reports false for a stop that was already cleared", async () => {
    expect(await clearExecutionStop(answering(false).tx, STOP, ACT)).toBe(
      false,
    );
  });

  it("refuses a malformed stop id or act before reaching the database", async () => {
    expect(
      await outcomeOf(clearExecutionStop(unreachable, "stop-1", ACT)),
    ).toBe("malformed_identifier");
    expect(
      await outcomeOf(
        clearExecutionStop(unreachable, STOP, {
          reason: "resolved",
          actor: "system:spend_ceiling",
        }),
      ),
    ).toBe("invalid_argument");
    expect(
      await outcomeOf(
        clearExecutionStop(unreachable, STOP, { reason: " ", actor: "owner" }),
      ),
    ).toBe("invalid_argument");
  });

  it("maps an unknown stop and a native permission failure faithfully", async () => {
    expect(
      await outcomeOf(
        clearExecutionStop(
          failingWith("OS404", "ops.clear_execution_stop: stop not found"),
          STOP,
          ACT,
        ),
      ),
    ).toBe("not_found");

    const native = await outcomeOf(
      clearExecutionStop(
        failingWith(
          "42501",
          "permission denied for function clear_execution_stop",
        ),
        STOP,
        ACT,
      ),
    );
    expect(native).not.toBeInstanceOf(CompanyOsError);
    expect((native as { code?: string }).code).toBe("42501");
  });

  it("refuses to read anything but a boolean as the outcome", async () => {
    const outcome = await outcomeOf(
      clearExecutionStop(answering(null).tx, STOP, ACT),
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CompanyOsError);
  });
});

describe("listing execution stops", () => {
  const record = {
    id: STOP,
    scope: "department",
    tenant_id: TENANT,
    company_id: COMPANY,
    department_id: DEPARTMENT,
    agent_id: null,
    job_kind: null,
    origin: "owner",
    reason: "incident 42",
    tripped_by: "owner",
    tripped_at: "2026-09-14T10:00:00.000000+00:00",
    cleared_by: "owner",
    cleared_reason: "resolved",
    cleared_at: "2026-09-14T11:00:00.000000+00:00",
  };

  it("reads the active stops only, bounded, unless cleared ones are asked for", async () => {
    const active = recordingDatabase([]);
    await listExecutionStops(active.tx);
    const all = recordingDatabase([]);
    await listExecutionStops(all.tx, { includeCleared: true });

    expect(MAX_LISTED_EXECUTION_STOPS).toBe(200);
    expect(active.calls[0]?.params).toEqual([false, 200]);
    expect(all.calls[0]?.params).toEqual([true, 200]);
    expect(active.calls[0]?.sql).toMatch(/from ops\.execution_stops s\b/);
    expect(active.calls[0]?.sql).toMatch(/order by s\.tripped_at desc/);
  });

  it("returns each stop with every recorded fact of its tripping and clearing", async () => {
    const { tx } = recordingDatabase([record]);

    expect(await listExecutionStops(tx, { includeCleared: true })).toEqual([
      {
        id: STOP,
        scope: "department",
        tenantId: TENANT,
        companyId: COMPANY,
        departmentId: DEPARTMENT,
        agentId: null,
        jobKind: null,
        origin: "owner",
        reason: "incident 42",
        trippedBy: "owner",
        trippedAt: "2026-09-14T10:00:00.000000+00:00",
        clearedBy: "owner",
        clearedReason: "resolved",
        clearedAt: "2026-09-14T11:00:00.000000+00:00",
      },
    ]);
  });

  it("returns a system stop on one job kind with its kind and origin", async () => {
    const { tx, calls } = recordingDatabase([
      {
        ...record,
        scope: "job_kind",
        tenant_id: null,
        company_id: null,
        department_id: null,
        job_kind: KIND,
        origin: "system",
        tripped_by: "system:spend_ceiling",
      },
    ]);

    expect(await listExecutionStops(tx)).toEqual([
      expect.objectContaining({
        scope: "job_kind",
        tenantId: null,
        jobKind: KIND,
        origin: "system",
        trippedBy: "system:spend_ceiling",
      }),
    ]);
    expect(calls[0]?.sql).toMatch(/s\.job_kind, s\.origin/);
  });

  it("refuses a row whose scope it does not know rather than typing it", async () => {
    const { tx } = recordingDatabase([{ ...record, scope: "fleet" }]);

    expect(await outcomeOf(listExecutionStops(tx))).toBeInstanceOf(Error);
  });

  it("refuses a row whose origin it does not know rather than typing it", async () => {
    const { tx } = recordingDatabase([{ ...record, origin: "robot" }]);

    expect(await outcomeOf(listExecutionStops(tx))).toBeInstanceOf(Error);
  });

  it("refuses a non-boolean includeCleared before reaching the database", async () => {
    expect(
      await outcomeOf(
        listExecutionStops(unreachable, {
          includeCleared: "yes" as unknown as boolean,
        }),
      ),
    ).toBe("invalid_argument");
  });

  it("does not disguise a native permission failure as a domain refusal", async () => {
    const outcome = await outcomeOf(
      listExecutionStops(
        failingWith("42501", "permission denied for table execution_stops"),
      ),
    );

    expect(outcome).not.toBeInstanceOf(CompanyOsError);
    expect((outcome as { code?: string }).code).toBe("42501");
  });
});
