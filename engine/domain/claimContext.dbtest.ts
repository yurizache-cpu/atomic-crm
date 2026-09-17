// The context a claim hands a worker is the context its start reserves for
// (ADR 0017 §2), against a real Postgres through the real `pg` driver and the
// real worker capabilities, with TWO sessions at once.
//
// ops.claim_agent_run share-locks the task and agent rows it read for the rest
// of the prepare transaction, and ops.start_agent_run computes the run's input
// ceiling from those same rows. supabase/tests/runtime_governance.sql can see
// that the claim takes the locks; only a second session can show what they buy:
// an owner who edits the claimed text while the prepare is open WAITS until the
// prepare ends, even after the start has answered `running`, so the text cannot
// change (in particular, shrink) between the claim the worker builds its prompt
// from and the reservation the start records. Every wait is read from
// pg_stat_activity while the waiting statement is still unsettled.
//
// It lives in engine/domain because only there may a test import the domain
// services, the worker capabilities and the database fixture together
// (eslint.config.js). All data is synthetic office-operations text.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { WorkerDatabase } from "../db/types.ts";
import { MODEL_ROUTE_POLICIES } from "../models/router.ts";
import {
  resetFixtures,
  TENANT_A,
  type FixtureGovernance,
} from "../worker/testSupport/dbFixture.ts";
import {
  inputTokenCeiling,
  readRunCost,
  reservationFor,
  reservationMicros,
} from "../worker/testSupport/spendProbes.ts";
import {
  openSession,
  waitUntilBlocked,
} from "../worker/testSupport/transactionSession.ts";
import {
  agentRunProbes,
  capabilities,
  HOLDER,
  resume,
  START,
} from "./testSupport/agentRunSessions.ts";
import {
  buildGovernedOffice,
  closeGovernanceDatabases,
  openGovernanceDatabases,
  PLAIN_OFFICE,
  PRICED_MODEL,
  requestRuns,
  type GovernedOffice,
} from "./testSupport/governanceRuntime.ts";

let admin: Pool;
let owner: WorkerDatabase;
let db: WorkerDatabase;
let governance: FixtureGovernance;

beforeAll(() => {
  ({ admin, owner, db } = openGovernanceDatabases());
}, 60_000);

afterAll(() => closeGovernanceDatabases({ admin, owner, db }));

beforeEach(async () => {
  governance = await resetFixtures(admin);
});

const { blockingPids, leaseHead } = agentRunProbes(() => ({
  admin,
  owner,
  worker: db,
}));

interface ClaimedText {
  readonly action: string;
  readonly agent_run_id: string;
  readonly agent: { readonly description: string | null };
  readonly task: { readonly description: string | null };
}

/** An owner's edit of one claimed text column, and where the claim returned it. */
interface ClaimedColumn {
  readonly label: string;
  readonly sql: string;
  readonly rowId: (office: GovernedOffice) => string;
  readonly longer: string;
  readonly claimed: (claim: ClaimedText) => string | null;
  readonly stored: string | null;
  readonly readBack: string;
}

const COLUMNS: readonly ClaimedColumn[] = [
  {
    label: "task description",
    sql: "update ops.tasks set description = $2 where id = $1",
    rowId: (office) => office.taskId,
    longer: "Recount the stock room shelf by shelf. ".repeat(250),
    claimed: (claim) => claim.task.description,
    stored: PLAIN_OFFICE.taskDescription,
    readBack: "select description from ops.tasks where id = $1",
  },
  {
    label: "agent description",
    sql: "update ops.agents set description = $2 where id = $1",
    rowId: (office) => office.agentId,
    longer: "Orders supplies and tracks deliveries. ".repeat(50),
    claimed: (claim) => claim.agent.description,
    stored: PLAIN_OFFICE.agentDescription,
    readBack: "select description from ops.agents where id = $1",
  },
];

describe("an owner's edit of the text a prepare transaction claimed", () => {
  it.each(COLUMNS.map((column) => [column.label, column] as const))(
    "waits until the prepare transaction ends when it edits the claimed %s, and the start reserves for the text the claim returned",
    async (_label, column) => {
      const office = await buildGovernedOffice(owner, TENANT_A, "dbtest-claim");
      const [runId] = await requestRuns(owner, office, ["claim-1"]);
      const jobId = (await readRunCost(admin, runId)).jobId as string;
      expect(await leaseHead(HOLDER)).toBe(jobId);
      const priceId = governance.priceIds[PRICED_MODEL];
      const prepare = openSession(db);
      const editor = openSession(owner);
      let claim: ClaimedText;
      try {
        await prepare.run((tx) => resume(tx, HOLDER, jobId));
        claim = (await prepare.run((tx) =>
          capabilities(tx).claimAgentRun(),
        )) as ClaimedText;
        expect(claim).toMatchObject({ action: "start", agent_run_id: runId });
        expect(column.claimed(claim)).toBe(column.stored);
        const preparePid = await prepare.pid;
        const editorPid = await editor.pid;

        const edit = editor.run((tx) =>
          tx.query(column.sql, [column.rowId(office), column.longer]),
        );
        await waitUntilBlocked(admin, editorPid, edit);
        expect(await blockingPids(editorPid)).toEqual([preparePid]);

        expect(
          await prepare.run((tx) => capabilities(tx).startAgentRun(START)),
        ).toBe("running");
        // Still waiting after the start answered: the claim's lock lasts as
        // long as the prepare transaction, not as long as the claim.
        await waitUntilBlocked(admin, editorPid, edit);
        expect(await blockingPids(editorPid)).toEqual([preparePid]);

        await prepare.end("commit");
        await edit;
        await editor.end("commit");
      } finally {
        await prepare.end("rollback");
        await editor.end("rollback");
      }

      const { rows } = await admin.query<{ description: string }>(
        column.readBack,
        [column.rowId(office)],
      );
      expect(rows[0].description).toBe(column.longer);
      const cost = await readRunCost(admin, runId);
      const claimedReservation = await reservationMicros(
        admin,
        priceId,
        await inputTokenCeiling(admin, claim),
        MODEL_ROUTE_POLICIES.standard.maxOutputTokens,
      );
      expect(cost).toMatchObject({
        status: "running",
        priceId,
        reserved: claimedReservation,
        charged: claimedReservation,
      });
      // The edit landed after the start, and it would have reserved more.
      expect(await reservationFor(admin, runId, priceId)).toBeGreaterThan(
        claimedReservation,
      );
    },
    30_000,
  );
});
