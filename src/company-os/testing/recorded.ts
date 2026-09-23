import {
  withoutDefaultArguments,
  type CompanyOsOperation,
  type OperationResult,
} from "../../../contracts/company-os-api/index.ts";
import {
  createFakeSession,
  ok,
  refused,
  type FakeSession,
  type RecordedCall as PortCall,
} from "./fakeSession";
import idsFile from "./recorded/ids.json";
import platformStopFile from "./recorded/platform-stop.json";
import taskManyRunsFile from "./recorded/task-many-runs.json";
import tenantKindStopFile from "./recorded/tenant-kind-stop.json";
import tenantFile from "./recorded/tenant.json";
import { USER_A } from "./samples";

// The Company OS screens' tests are fed with answers RECORDED from the real
// company_os_api reads (docs/PHASE_2C_BRIEF.md §16 "Browser"), never with
// hand-invented activity. engine/domain/companyOsRecordedResponses.dbtest.ts
// drives the functions as a signed-in member over the synthetic tenant of the
// contract parity suite, normalises the answers (deterministic ids and times)
// and writes them here; recorded.test.ts parses every one with its contract.
//
// A recorded session answers a read exactly as the server did, keyed by the
// operation and its canonical input (contracts' withoutDefaultArguments, so an
// omitted, a null and a DEFAULT argument ask the same thing). What the server
// was never asked is answered the way it answers such a read: an id it does
// not hold is OS404, a cursor it never issued is OS400. Anything else (a
// filter no recording covers) answers OS500 and is listed in `unmatched`, so a
// test that strays from the recordings fails visibly.

export type RecordedScenario =
  | "tenant"
  | "tenant-kind-stop"
  | "platform-stop"
  | "task-many-runs";

interface RecordedCall {
  readonly operation: CompanyOsOperation;
  readonly args: Readonly<Record<string, unknown>>;
  readonly response: unknown;
}

interface RecordedFile {
  readonly calls: readonly RecordedCall[];
}

const FILES: Readonly<Record<RecordedScenario, RecordedFile>> = {
  tenant: tenantFile as unknown as RecordedFile,
  "tenant-kind-stop": tenantKindStopFile as unknown as RecordedFile,
  "platform-stop": platformStopFile as unknown as RecordedFile,
  "task-many-runs": taskManyRunsFile as unknown as RecordedFile,
};

/** Every recorded row, by the stable label the recorder gave it. */
export const RECORDED_IDS: Readonly<Record<string, string>> = idsFile.ids;

/** The recorded id of a fixture row (`agent:lead-triage`, `run:held`). */
export const rid = (label: string): string => {
  const id = RECORDED_IDS[label];
  if (id === undefined)
    throw new Error(`No recorded row is labelled ${label}.`);
  return id;
};

const keyOf = (
  operation: CompanyOsOperation,
  args: Readonly<Record<string, unknown>>,
): string =>
  `${operation} ${JSON.stringify(withoutDefaultArguments(operation, args))}`;

const indexOf = (file: RecordedFile) =>
  new Map(file.calls.map((call) => [keyOf(call.operation, call.args), call]));

const INDEXES: Readonly<
  Record<RecordedScenario, ReadonlyMap<string, RecordedCall>>
> = {
  tenant: indexOf(FILES.tenant),
  "tenant-kind-stop": indexOf(FILES["tenant-kind-stop"]),
  "platform-stop": indexOf(FILES["platform-stop"]),
  "task-many-runs": indexOf(FILES["task-many-runs"]),
};

/**
 * The recorded answer to one read. A scenario answers what it recorded, and
 * the tenant scenario (the same tenant, read in the same session) the rest.
 */
export const recorded = <O extends CompanyOsOperation>(
  operation: O,
  args: Readonly<Record<string, unknown>> = {},
  scenario: RecordedScenario = "tenant",
): OperationResult<O> => {
  const key = keyOf(operation, args);
  const call = INDEXES[scenario].get(key) ?? INDEXES.tenant.get(key);
  if (call === undefined) throw new Error(`No recording answers ${key}.`);
  return call.response as OperationResult<O>;
};

/** Every recorded read of every scenario, for the contract check. */
export const everyRecording = (): readonly (RecordedCall & {
  readonly scenario: RecordedScenario;
})[] =>
  (Object.keys(FILES) as RecordedScenario[]).flatMap((scenario) =>
    FILES[scenario].calls.map((call) => ({ ...call, scenario })),
  );

/** The arguments that select one row: an unrecorded one is not found. */
const SELECTORS: readonly string[] = [
  "p_agent_id",
  "p_task_id",
  "p_run_id",
  "p_review_id",
  "p_subject_id",
];

export interface RecordedSession extends FakeSession {
  /** Reads no recording answered, and no server rule would have. */
  readonly unmatched: readonly PortCall[];
}

/** A signed-in member of the recorded tenant: every read answers as recorded. */
export const createRecordedSession = (
  scenario: RecordedScenario = "tenant",
  user = USER_A,
): RecordedSession => {
  const session = createFakeSession(user);
  const unmatched: PortCall[] = [];
  const answerFor =
    (operation: CompanyOsOperation) =>
    (args: Readonly<Record<string, unknown>>) => {
      const key = keyOf(operation, args);
      const call = INDEXES[scenario].get(key) ?? INDEXES.tenant.get(key);
      if (call !== undefined) return ok(call.response);
      if (typeof args.p_cursor === "string") return refused("OS400");
      if (SELECTORS.some((name) => typeof args[name] === "string")) {
        return refused("OS404");
      }
      unmatched.push({ operation, args });
      return refused("OS500");
    };
  const operations = new Set(
    (Object.values(FILES) as RecordedFile[]).flatMap((file) =>
      file.calls.map((call) => call.operation),
    ),
  );
  for (const operation of operations) {
    session.answer(operation, answerFor(operation));
  }
  return Object.assign(session, { unmatched });
};
