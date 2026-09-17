// Offices with neighbours, for the kill switch suites (killSwitchLease.dbtest.ts,
// executionStopOutcome.dbtest.ts): one assigned task whose run knows its company,
// department and agent, beside a second company, a second department and a second
// agent in the same tenant. A stop on a neighbour covers other work only, so it is
// the case that must NOT hold the run.
//
// It lives in engine/domain because only there may code import the domain
// services and the database fixture together (eslint.config.js). All data is
// synthetic office-operations text.

import type { WorkerDatabase } from "../../db/types.ts";
import { AGENT_RUN_EXECUTE_KIND } from "../../handlers/agentRunExecute.ts";
import { TENANT_B } from "../../worker/testSupport/dbFixture.ts";
import { requestAgentRun } from "../agentRuns.ts";
import {
  assignTask,
  createAgent,
  createCompany,
  createDepartment,
  createTask,
} from "../companyOs.ts";
import type { ExecutionStopTarget } from "../executionStops.ts";

export const STOP_SOURCE = "dbtest-kill-switch";

export interface StopOffice {
  readonly tenantId: string;
  readonly companyId: string;
  readonly departmentId: string;
  readonly agentId: string;
  readonly taskId: string;
  /** Same tenant, another company. */
  readonly otherCompanyId: string;
  /** Same company, another department. */
  readonly otherDepartmentId: string;
  /** Same company, another agent (in the other department). */
  readonly otherAgentId: string;
}

/** Builds a StopOffice in one owner transaction. */
export function buildStopOffice(
  owner: WorkerDatabase,
  tenantId: string,
): Promise<StopOffice> {
  return owner.withTransaction(async (tx) => {
    const ctx = { tenantId, source: STOP_SOURCE };
    const companyId = await createCompany(tx, ctx, {
      slug: "dbtest-stop-office",
      name: "Office",
    });
    const otherCompanyId = await createCompany(tx, ctx, {
      slug: "dbtest-stop-annex",
      name: "Annex",
    });
    const departmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "operations",
      name: "Operations",
    });
    const otherDepartmentId = await createDepartment(tx, ctx, {
      companyId,
      slug: "facilities",
      name: "Facilities",
    });
    const agentId = await createAgent(tx, ctx, {
      companyId,
      departmentId,
      slug: "office-assistant",
      name: "Office assistant",
      role: "Operations assistant",
      description: "Keeps the office stocked and orders supplies.",
    });
    const otherAgentId = await createAgent(tx, ctx, {
      companyId,
      departmentId: otherDepartmentId,
      slug: "facilities-assistant",
      name: "Facilities assistant",
      role: "Facilities assistant",
    });
    const taskId = await createTask(tx, ctx, {
      companyId,
      departmentId,
      type: "operations.supply_order",
      title: "Prepare next week's office supply order",
      description: "Paper, toner and coffee are running low.",
    });
    await assignTask(tx, ctx, taskId, agentId);
    return {
      tenantId,
      companyId,
      departmentId,
      agentId,
      taskId,
      otherCompanyId,
      otherDepartmentId,
      otherAgentId,
    };
  });
}

/** One run on the office's task, requested by the owner and committed. */
export function requestStopRun(
  owner: WorkerDatabase,
  office: StopOffice,
  idempotencyKey: string,
): Promise<string> {
  return owner.withTransaction((tx) =>
    requestAgentRun(
      tx,
      { tenantId: office.tenantId, source: STOP_SOURCE },
      {
        taskId: office.taskId,
        agentId: office.agentId,
        capability: "task_assessment",
        idempotencyKey,
      },
    ),
  );
}

export interface StopCase {
  /** How the case reads in a test name. */
  readonly name: string;
  /** An idempotency key fragment: printable, no spaces. */
  readonly key: string;
  readonly target: (office: StopOffice) => ExecutionStopTarget;
}

const covering: StopCase[] = [
  { name: "global", key: "global", target: () => ({ scope: "global" }) },
  {
    name: "tenant",
    key: "tenant",
    target: (o) => ({ scope: "tenant", tenantId: o.tenantId }),
  },
  {
    name: "company",
    key: "company",
    target: (o) => ({
      scope: "company",
      tenantId: o.tenantId,
      companyId: o.companyId,
    }),
  },
  {
    name: "department",
    key: "department",
    target: (o) => ({
      scope: "department",
      tenantId: o.tenantId,
      companyId: o.companyId,
      departmentId: o.departmentId,
    }),
  },
  {
    name: "agent",
    key: "agent",
    target: (o) => ({
      scope: "agent",
      tenantId: o.tenantId,
      companyId: o.companyId,
      agentId: o.agentId,
    }),
  },
  {
    name: "job_kind (all tenants)",
    key: "kind-all",
    target: () => ({ scope: "job_kind", jobKind: AGENT_RUN_EXECUTE_KIND }),
  },
  {
    name: "job_kind (its tenant)",
    key: "kind-tenant",
    target: (o) => ({
      scope: "job_kind",
      tenantId: o.tenantId,
      jobKind: AGENT_RUN_EXECUTE_KIND,
    }),
  },
];

/** Every scope, each naming a target that covers the office's run. */
export const COVERING_STOPS: readonly StopCase[] = Object.freeze(covering);

const neighbours: StopCase[] = [
  {
    name: "tenant stop on another tenant",
    key: "other-tenant",
    target: () => ({ scope: "tenant", tenantId: TENANT_B }),
  },
  {
    name: "company stop on another company of its tenant",
    key: "other-company",
    target: (o) => ({
      scope: "company",
      tenantId: o.tenantId,
      companyId: o.otherCompanyId,
    }),
  },
  {
    name: "department stop on another department of its company",
    key: "other-department",
    target: (o) => ({
      scope: "department",
      tenantId: o.tenantId,
      companyId: o.companyId,
      departmentId: o.otherDepartmentId,
    }),
  },
  {
    name: "agent stop on another agent of its company",
    key: "other-agent",
    target: (o) => ({
      scope: "agent",
      tenantId: o.tenantId,
      companyId: o.companyId,
      agentId: o.otherAgentId,
    }),
  },
  {
    name: "job_kind stop for another tenant",
    key: "kind-other-tenant",
    target: () => ({
      scope: "job_kind",
      tenantId: TENANT_B,
      jobKind: AGENT_RUN_EXECUTE_KIND,
    }),
  },
];

/** Stops that cover other work only: a neighbour of the office's run. */
export const NEIGHBOUR_STOPS: readonly StopCase[] = Object.freeze(neighbours);
