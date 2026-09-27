// BASELINE Q8 at the model boundary (ADR 0020 §D; SI-70), through the REAL
// worker loop and the production agent run handler, against a real Postgres.
//
// supabase/tests/model_data_authorization.sql attacks the database inside one
// rolled-back transaction. What only this file proves is that the runtime a
// deployed worker runs asks the gate before it asks a provider: every case
// counts the provider's calls. The provider is the in-process fake, NAMED
// "openai" so that the gate treats it as the real one would be treated (only the
// literal in-process name "fake" is exempt), and it never leaves the process.
//
// ALL DATA HERE IS SYNTHETIC, and every evidence reference is a FAKE fixture.
// The "health" class below labels invented text, to exercise the gate; no real
// person, message or clinical content is used, and no real provider is called.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { createFakeModelProvider } from "../models/fakeModelProvider.ts";
import {
  LEAD_TRIAGE_CAPABILITY,
  LEAD_TRIAGE_PROMPT_VERSION,
  type LeadTriage,
} from "../models/leadTriage.ts";
import { resetFixtures, TENANT_A } from "../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "./agentRuns.ts";
import type { DataClass } from "./dataClasses.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "./companyOs.ts";
import { clearExecutionStop, tripExecutionStop } from "./executionStops.ts";
import {
  recordModelDataAuthorization,
  retireModelDataAuthorization,
} from "./modelDataAuthorizations.ts";
import {
  agentRuntimeProbes,
  closeAgentRuntimeDatabases,
  MODEL,
  openAgentRuntimeDatabases,
  registryServing,
} from "./testSupport/agentRuntimeProbes.ts";

const SOURCE = "dbtest-q8";
const PROVIDER = "openai";

/** Invented enquiry text carrying structured identifiers the builder must remove. */
const SYNTHETIC_BODY =
  "Oi, sou uma pessoa inventada. Meu zap é (11) 98765-4321 e o email pessoa.inventada@example.test.";

const ADVICE: LeadTriage = Object.freeze({
  outcome: "triaged",
  summary: "A synthetic enquiry about a first session.",
  intent: "information",
  priority: "normal",
  recommended_next_action: "Reply with how a first session works.",
  response_draft: "Oi! Obrigado por escrever.",
  needs_human_review: true,
  flags: Object.freeze(["unclear"]),
}) as LeadTriage;

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;

beforeAll(() => {
  ({ admin, owner, db } = openAgentRuntimeDatabases());
}, 60_000);

afterAll(() => closeAgentRuntimeDatabases({ admin, owner, db }));

const { countJobs, runAgentJob } = agentRuntimeProbes(() => ({
  admin,
  owner,
  db,
}));

/** The in-process fake, under a real provider's name, answering valid advice. */
const openaiNamedFake = () => {
  const provider = createFakeModelProvider(
    { type: "respond", content: ADVICE },
    { name: PROVIDER },
  );
  return { provider, registry: registryServing(provider) };
};

interface Lead {
  readonly companyId: string;
  readonly agentId: string;
  readonly taskId: string;
}

const buildLead = (dataClass: DataClass): Promise<Lead> =>
  owner.withTransaction(async (tx) => {
    const ctx = { tenantId: TENANT_A, source: SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-q8-clinic",
      name: "Clinic",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "intake",
      name: "Intake",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "lead-triage",
      name: "Lead Triage",
      role: "Intake assistant",
    });
    const taskId = await createTask(tx, ctx, {
      companyId,
      type: LEAD_TRIAGE_CAPABILITY,
      title: "Lead triage",
      description: SYNTHETIC_BODY,
      dataClass,
    });
    await assignTask(tx, ctx, taskId, agentId);
    return { companyId, agentId, taskId };
  });

const request = (lead: Lead, key: string) =>
  owner.withTransaction((tx) =>
    requestAgentRun(
      tx,
      { tenantId: TENANT_A, source: SOURCE },
      {
        taskId: lead.taskId,
        agentId: lead.agentId,
        capability: LEAD_TRIAGE_CAPABILITY,
        idempotencyKey: key,
      },
    ),
  );

const HOUR_MS = 3_600_000;
/** An ISO instant this far from now, so the fixture never ages out. */
const fromNow = (ms: number): string => new Date(Date.now() + ms).toISOString();

/** One authorization with FAKE evidence references, recorded as the owner act does. */
const authorize = (model: string) =>
  owner.withTransaction((tx) =>
    recordModelDataAuthorization(
      tx,
      {
        tenantId: TENANT_A,
        dataClass: "health",
        capability: LEAD_TRIAGE_CAPABILITY,
        provider: PROVIDER,
        model,
        validFrom: fromNow(-HOUR_MS),
        expiresAt: fromNow(30 * 24 * HOUR_MS),
        providerEvidenceRef: "fixture:provider-evidence:v1",
        evidenceVerifiedAt: fromNow(-2 * HOUR_MS),
        trainingExcluded: true,
        contractRef: "fixture:contract:v1",
        dpaRef: "fixture:dpa:v1",
        zeroRetentionRef: "fixture:zdr:v1",
        retentionEvidenceRef: "fixture:retention:v1",
        transferMechanismRef: "fixture:transfer:v1",
        lawfulBasisRef: "fixture:consent:v1",
        contentRetentionDays: 30,
      },
      { actor: "dbtest" },
    ),
  );

const readGate = async (runId: string) => {
  const { rows } = await admin.query<{
    status: string;
    error_code: string | null;
    data_class: string | null;
    data_authorization_id: string | null;
    job_id: string | null;
    provider: string | null;
    prompt_version: string | null;
  }>(
    `select status, error_code, data_class, data_authorization_id, job_id, provider, prompt_version
       from ops.agent_runs where id = $1`,
    [runId],
  );
  return rows[0];
};

beforeEach(async () => {
  await resetFixtures(admin);
  // The route's price under the real provider's name; the gate decides before it.
  await admin.query(
    `select ops.record_model_price($1, $2, 1.25, 2.5, true, now() - interval '1 hour',
                                   now() + interval '1 day', 'dbtest q8 price', 'dbtest')`,
    [PROVIDER, MODEL],
  );
});

describe("the model boundary (SI-70)", () => {
  it("refuses health data with no authorization at its request: no job, and the provider is never called", async () => {
    const { provider, registry } = openaiNamedFake();
    const lead = await buildLead("health");

    const runId = await request(lead, "dbtest-q8-absent");
    await runAgentJob(registry);

    const run = await readGate(runId);
    expect(run).toMatchObject({
      status: "cancelled",
      error_code: "data_not_authorized",
      data_class: "health",
      job_id: null,
    });
    expect(await countJobs(TENANT_A)).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses at the start, before any call, a model the authorization does not name", async () => {
    const { provider, registry } = openaiNamedFake();
    const lead = await buildLead("health");
    await authorize("another-model");

    const runId = await request(lead, "dbtest-q8-mismatch");
    await runAgentJob(registry);

    const run = await readGate(runId);
    expect(run).toMatchObject({
      status: "cancelled",
      error_code: "data_not_authorized",
      provider: null,
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("runs the exact binding once, records the version it relied on, and sends the minimised input", async () => {
    const { provider, registry } = openaiNamedFake();
    const lead = await buildLead("health");
    const authorizationId = await authorize(MODEL);

    const runId = await request(lead, "dbtest-q8-exact");
    await runAgentJob(registry);

    const run = await readGate(runId);
    expect(run).toMatchObject({
      status: "succeeded",
      data_class: "health",
      data_authorization_id: authorizationId,
      prompt_version: LEAD_TRIAGE_PROMPT_VERSION,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].input).toContain("[phone]");
    expect(provider.calls[0].input).toContain("[email]");
    expect(provider.calls[0].input).not.toContain("98765");
    expect(provider.calls[0].input).not.toContain("pessoa.inventada@");
  });

  it("refuses at the start when the authorization is retired after the request", async () => {
    const { provider, registry } = openaiNamedFake();
    const lead = await buildLead("health");
    const authorizationId = await authorize(MODEL);
    const runId = await request(lead, "dbtest-q8-retired");

    await owner.withTransaction((tx) =>
      retireModelDataAuthorization(tx, authorizationId, {
        reason: "dbtest evidence withdrawn",
        actor: "dbtest",
      }),
    );
    await runAgentJob(registry);

    expect(await readGate(runId)).toMatchObject({
      status: "cancelled",
      error_code: "data_not_authorized",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("holds the run under a stop before the gate refuses it, and refuses it once the stop is cleared", async () => {
    const { provider, registry } = openaiNamedFake();
    const lead = await buildLead("health");
    const authorizationId = await authorize(MODEL);
    const runId = await request(lead, "dbtest-q8-held");
    await owner.withTransaction((tx) =>
      retireModelDataAuthorization(tx, authorizationId, {
        reason: "dbtest evidence withdrawn",
        actor: "dbtest",
      }),
    );
    const stopId = await owner.withTransaction((tx) =>
      tripExecutionStop(
        tx,
        { scope: "tenant", tenantId: TENANT_A },
        { reason: "dbtest q8 stop", actor: "dbtest" },
      ),
    );

    await runAgentJob(registry);
    expect(await readGate(runId)).toMatchObject({
      status: "pending",
      error_code: null,
    });

    await owner.withTransaction((tx) =>
      clearExecutionStop(tx, stopId, {
        reason: "dbtest cleanup",
        actor: "dbtest",
      }),
    );
    await admin.query(
      "update ops.jobs set available_at = now() where tenant_id = $1 and status = 'queued'",
      [TENANT_A],
    );
    await runAgentJob(registry);

    expect(await readGate(runId)).toMatchObject({
      status: "cancelled",
      error_code: "data_not_authorized",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("keeps a health task health: refused for a real-looking provider before any call, then run on the in-process fake relying on no authorization", async () => {
    const real = openaiNamedFake();
    const inProcess = createFakeModelProvider({
      type: "respond",
      content: ADVICE,
    });
    const lead = await buildLead("health");
    // Some provider is authorized for the class, so the request is admitted;
    // not the model this worker would call.
    await authorize("another-model");

    const refusedId = await request(lead, "dbtest-q8-real-looking");
    await runAgentJob(real.registry);
    expect(await readGate(refusedId)).toMatchObject({
      status: "cancelled",
      error_code: "data_not_authorized",
      data_class: "health",
    });
    expect(real.provider.calls).toHaveLength(0);

    // The SAME task, retried on the in-process fake: nothing leaves the process.
    const retryId = await owner.withTransaction((tx) =>
      requestAgentRun(
        tx,
        { tenantId: TENANT_A, source: SOURCE },
        {
          taskId: lead.taskId,
          agentId: lead.agentId,
          capability: LEAD_TRIAGE_CAPABILITY,
          idempotencyKey: "dbtest-q8-in-process",
          retryOfRunId: refusedId,
        },
      ),
    );
    await runAgentJob(registryServing(inProcess));

    expect(await readGate(retryId)).toMatchObject({
      status: "succeeded",
      provider: "fake",
      data_class: "health",
      data_authorization_id: null,
    });
    const { rows } = await admin.query<{ data_class: string }>(
      "select data_class from ops.tasks where id = $1",
      [lead.taskId],
    );
    expect(rows[0].data_class).toBe("health");
    expect(inProcess.calls).toHaveLength(1);
    expect(real.provider.calls).toHaveLength(0);
  });

  it("leaves synthetic data unaffected: it runs with no authorization and relies on none", async () => {
    const { provider, registry } = openaiNamedFake();
    const lead = await buildLead("synthetic");

    const runId = await request(lead, "dbtest-q8-synthetic");
    await runAgentJob(registry);

    expect(await readGate(runId)).toMatchObject({
      status: "succeeded",
      data_class: "synthetic",
      data_authorization_id: null,
    });
    expect(provider.calls).toHaveLength(1);
  });
});
