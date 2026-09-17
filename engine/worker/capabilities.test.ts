// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { TxClient } from "../db/types.ts";
import {
  grantCapabilities,
  CAPABILITY_NAMES,
  type AgentRunCompletion,
  type AgentRunFailure,
  type AgentRunStart,
  type AgentRunUsage,
  type Capabilities,
} from "./capabilities.ts";

const fakeTx = () => {
  const calls: { sql: string; params?: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ purged: 7 }] } as never;
    },
  };
  return { tx, calls };
};

describe("a handler receives capabilities, not a database", () => {
  it("grants exactly what was declared", () => {
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    expect(typeof granted.purgeInboundEmailLedger).toBe("function");
    expect(Object.keys(granted)).toEqual(["purgeInboundEmailLedger"]);
  });

  it("grants NOTHING when nothing was declared", () => {
    // The fail-closed default. A handler that declared no capabilities gets an
    // object with no methods, so reaching for one is a TypeError at the call
    // site rather than a privilege nobody reviewed.
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, []);
    expect(Object.keys(granted)).toEqual([]);
    expect(
      (granted as Record<string, unknown>).purgeInboundEmailLedger,
    ).toBeUndefined();
  });

  it("cannot be widened after it is built", () => {
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, []) as Record<string, unknown>;
    expect(Object.isFrozen(granted)).toBe(true);
    expect(() => {
      "use strict";
      granted.purgeInboundEmailLedger = () => Promise.resolve(0);
    }).toThrow();
  });

  it("refuses a capability name that does not exist", () => {
    const { tx } = fakeTx();
    expect(() => grantCapabilities(tx, ["deleteEverything" as never])).toThrow(
      /unknown capability/i,
    );
  });

  it("exposes no way to run arbitrary SQL", () => {
    const { tx } = fakeTx();
    const granted = grantCapabilities(tx, [
      "purgeInboundEmailLedger",
    ]) as Record<string, unknown>;
    // The transaction itself must not be reachable from the capability bag.
    for (const value of Object.values(granted)) {
      expect(value).not.toBe(tx);
    }
    expect(Object.values(granted)).not.toContain(tx.query);
  });
});

describe("the purge capability", () => {
  it("calls the ops function and passes NO tenant", async () => {
    // The property that matters: there is no tenant parameter to get wrong.
    // The database resolves it from the live lease.
    const { tx, calls } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    const purged = await granted.purgeInboundEmailLedger({
      retentionDays: 120,
      limit: 10,
    });

    expect(purged).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("ops.purge_inbound_email_ledger");
    expect(calls[0].params).toEqual([120, 10]);
    expect(JSON.stringify(calls[0])).not.toMatch(/tenant/i);
  });

  it("passes nulls when nothing was specified, so the database picks", async () => {
    const { tx, calls } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    await granted.purgeInboundEmailLedger();
    expect(calls[0].params).toEqual([null, null]);
  });

  it("is parameterised, never interpolated", async () => {
    const { tx, calls } = fakeTx();
    const granted = grantCapabilities(tx, ["purgeInboundEmailLedger"]);
    await granted.purgeInboundEmailLedger({ retentionDays: 45 });
    expect(calls[0].sql).not.toContain("45");
    expect(calls[0].sql).toContain("$1");
  });
});

// --- The agent run capabilities ---------------------------------------------

const TENANT_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const RUN_ID = "0f2d5c8e-6b1a-4c3e-9d7f-1a2b3c4d5e6f";
const TASK_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const AGENT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const JOB_ID = "11111111-1111-1111-1111-111111111111";
const IDS = [TENANT_ID, RUN_ID, TASK_ID, AGENT_ID, JOB_ID];

/** Ids smuggled onto an input object. A capability that spread its input would send them. */
const SMUGGLED = {
  tenantId: TENANT_ID,
  agentRunId: RUN_ID,
  taskId: TASK_ID,
  agentId: AGENT_ID,
  jobId: JOB_ID,
};

const START: AgentRunStart = {
  provider: "fake",
  model: "fake-model-1",
  promptVersion: "task_assessment.v1",
  inputFingerprint: "a".repeat(64),
  maxOutputTokens: 8000,
};

const USAGE: AgentRunUsage = {
  inputTokens: 120,
  outputTokens: 60,
  totalTokens: 180,
  cachedInputTokens: 5,
  reasoningTokens: 7,
};

const COMPLETION: AgentRunCompletion = {
  result: {
    outcome: "completed",
    summary: "select 1; drop table ops.jobs",
    proposed_next_steps: [],
  },
  responseModel: "fake-model-1",
  finishReason: "completed",
  providerRequestId: "fake-req-1",
  providerResponseId: "fake-resp-1",
  usage: USAGE,
  latencyMs: 42,
};

const FAILURE: AgentRunFailure = {
  category: "rate_limit",
  code: "rate_limit_exceeded",
  responseModel: null,
  providerRequestId: "fake-req-2",
  providerResponseId: null,
  usage: null,
  latencyMs: 9,
};

/** A transaction that answers every agent run function with a fixed row. */
const agentRunTx = (row: Record<string, unknown> = { status: "running" }) => {
  const calls: { sql: string; params?: readonly unknown[] }[] = [];
  const tx: TxClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row] } as never;
    },
  };
  return { tx, calls };
};

const ALL_AGENT_RUN_CAPABILITIES = [
  "claimAgentRun",
  "startAgentRun",
  "refuseAgentRun",
  "completeAgentRun",
  "failAgentRun",
] as const;

describe("the agent run capabilities send fixed SQL with bound parameters, and no id of any kind", () => {
  const cases: readonly {
    readonly name: string;
    readonly sql: string;
    readonly invoke: (
      granted: Pick<Capabilities, (typeof ALL_AGENT_RUN_CAPABILITIES)[number]>,
    ) => Promise<unknown>;
    readonly params: readonly unknown[] | undefined;
  }[] = [
    {
      name: "claimAgentRun",
      sql: "select ops.claim_agent_run() as claim",
      invoke: (granted) => granted.claimAgentRun(),
      params: undefined,
    },
    {
      name: "startAgentRun",
      sql: "select ops.start_agent_run($1, $2, $3, $4, $5) as status",
      invoke: (granted) =>
        granted.startAgentRun({ ...START, ...SMUGGLED } as AgentRunStart),
      params: [
        START.provider,
        START.model,
        START.promptVersion,
        START.inputFingerprint,
        START.maxOutputTokens,
      ],
    },
    {
      name: "refuseAgentRun",
      sql: "select ops.refuse_agent_run($1) as status",
      invoke: (granted) => granted.refuseAgentRun("route_unavailable"),
      params: ["route_unavailable"],
    },
    {
      name: "completeAgentRun",
      sql: "select ops.complete_agent_run($1::jsonb, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as status",
      invoke: (granted) =>
        granted.completeAgentRun({
          ...COMPLETION,
          ...SMUGGLED,
        } as AgentRunCompletion),
      params: [
        JSON.stringify(COMPLETION.result),
        "fake-model-1",
        "completed",
        "fake-req-1",
        "fake-resp-1",
        120,
        60,
        180,
        5,
        7,
        42,
      ],
    },
    {
      name: "failAgentRun",
      sql: "select ops.fail_agent_run($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as status",
      invoke: (granted) =>
        granted.failAgentRun({ ...FAILURE, ...SMUGGLED } as AgentRunFailure),
      params: [
        "rate_limit",
        "rate_limit_exceeded",
        null,
        "fake-req-2",
        null,
        null,
        null,
        null,
        null,
        null,
        9,
      ],
    },
  ];

  for (const { name, sql, invoke, params } of cases) {
    it(`${name} issues exactly one fixed statement, parameterised in declared order`, async () => {
      const { tx, calls } = agentRunTx();
      await invoke(grantCapabilities(tx, ALL_AGENT_RUN_CAPABILITIES));
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toBe(sql);
      expect(calls[0].params).toEqual(params);
    });

    it(`${name} carries no tenant, run, task, agent or job id, even one smuggled onto its input`, async () => {
      // The run is resolved from the live lease by the database. An id here
      // would be the caller choosing what to touch.
      const { tx, calls } = agentRunTx();
      await invoke(grantCapabilities(tx, ALL_AGENT_RUN_CAPABILITIES));
      const sent = JSON.stringify(calls[0]);
      for (const id of IDS) expect(sent).not.toContain(id);
      expect(sent).not.toMatch(/tenant/i);
    });
  }

  it("keeps model output out of the statement text, as one jsonb parameter", async () => {
    const { tx, calls } = agentRunTx({ status: "succeeded" });
    await grantCapabilities(tx, ["completeAgentRun"]).completeAgentRun(
      COMPLETION,
    );
    expect(calls[0].sql).not.toContain("drop table");
    expect(JSON.parse(String(calls[0].params?.[0]))).toEqual(COMPLETION.result);
  });

  it("returns the database's status token and the claim as the driver parsed it", async () => {
    const claim = { action: "settled", agent_run_id: RUN_ID, status: "failed" };
    const claimed = agentRunTx({ claim });
    expect(
      await grantCapabilities(claimed.tx, ["claimAgentRun"]).claimAgentRun(),
    ).toEqual(claim);
    const started = agentRunTx({ status: "cancelled" });
    expect(
      await grantCapabilities(started.tx, ["startAgentRun"]).startAgentRun(
        START,
      ),
    ).toBe("cancelled");
  });

  it("throws rather than invent a status when the function returned none", async () => {
    // A made-up token could read as a decision the database never made.
    for (const row of [{}, { status: null }, { status: 7 }]) {
      const { tx } = agentRunTx(row);
      const granted = grantCapabilities(tx, ALL_AGENT_RUN_CAPABILITIES);
      await expect(granted.startAgentRun(START)).rejects.toThrow(
        /returned no status/,
      );
      await expect(granted.refuseAgentRun("configuration")).rejects.toThrow(
        /returned no status/,
      );
      await expect(granted.completeAgentRun(COMPLETION)).rejects.toThrow(
        /returned no status/,
      );
      await expect(granted.failAgentRun(FAILURE)).rejects.toThrow(
        /returned no status/,
      );
    }
  });
});

describe("the agent run capabilities are granted like every other", () => {
  it("builds a frozen bag holding only the declared names", () => {
    const { tx } = agentRunTx();
    const prepare = grantCapabilities(tx, [
      "claimAgentRun",
      "startAgentRun",
      "refuseAgentRun",
    ]) as Record<string, unknown>;
    expect(Object.keys(prepare)).toEqual([
      "claimAgentRun",
      "startAgentRun",
      "refuseAgentRun",
    ]);
    expect(Object.isFrozen(prepare)).toBe(true);
    for (const absent of [
      "completeAgentRun",
      "failAgentRun",
      "purgeInboundEmailLedger",
    ]) {
      expect(prepare[absent]).toBeUndefined();
    }
  });
});

describe("the capability list", () => {
  it("is small, and every entry is a deliberate decision", () => {
    // If this fails, a capability was added. That is fine — but it is a review
    // event, and this test is the prompt for it. The five agent run
    // capabilities were that review event for Phase 1D: each is a lease-bound
    // SECURITY DEFINER function that takes no id (ADR 0016).
    expect([...CAPABILITY_NAMES]).toEqual([
      "purgeInboundEmailLedger",
      "claimAgentRun",
      "startAgentRun",
      "refuseAgentRun",
      "completeAgentRun",
      "failAgentRun",
    ]);
  });
});

describe("noop guard", () => {
  it("does not call the database when only building the bag", () => {
    const query = vi.fn();
    grantCapabilities({ query } as unknown as TxClient, [
      "purgeInboundEmailLedger",
    ]);
    expect(query).not.toHaveBeenCalled();
  });
});
