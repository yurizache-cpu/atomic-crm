// How the recorder (engine/domain/companyOsRecordedResponses.dbtest.ts) turns
// the answers of the REAL company_os_api reads into recordings the browser
// tests replay (src/company-os/testing/recorded/): the same answers, made
// deterministic, and nothing invented.
//
// Three things in a live answer differ from one recording session to the
// next, and each is normalised here:
//
//   * IDS. Every uuid is random. Each is mapped to a deterministic uuid
//     through the stable label the fixture gave its row (`agent:lead-triage`,
//     `run:held`, `event:007`), numbered in creation order within its kind. An
//     id the recorder cannot place fails the recording: nothing unlabelled,
//     such as an auth user id or another tenant's row, can hide in one.
//   * TIMESTAMPS. The fixture is built in one transaction, so most rows carry
//     the transaction's now(), and the rest lie minutes away from it. Every
//     distinct timestamp is replaced by BASE_TIME plus its rank relative to
//     now() in minutes, which keeps their order and their equalities. Each
//     envelope's `asOf` and the context's `serverTime` become AS_OF.
//   * ORDER. Every row created in that transaction shares one created_at, so
//     the server's tie-break, the row's own random id, decides the order of a
//     list and which run of a retried task is its latest. The normaliser
//     replays the server's comparator on the mapped ids, which number rows in
//     creation order: a list reads newest-created first, as it would had the
//     rows been created apart. The events' order is the server's own (its
//     tie-break is the global sequence, deterministic within a session).
//
// Pure functions of their input: no database, no file.

import type { CompanyOsOperation } from "../../../contracts/company-os-api/index.ts";

/** One read as the browser would make it, and the server's answer. */
export interface RecordedCall {
  readonly operation: CompanyOsOperation;
  /** The canonical input (contracts' withoutDefaultArguments). */
  readonly args: Readonly<Record<string, unknown>>;
  readonly response: unknown;
}

/** The kinds a label may name, and the block of mapped ids each owns. */
export const LABEL_KINDS = {
  tenant: 0x0001,
  principal: 0x0002,
  company: 0x0010,
  department: 0x0011,
  agent: 0x0012,
  channel: 0x0013,
  limit: 0x0014,
  task: 0x0020,
  run: 0x0021,
  review: 0x0022,
  outbound: 0x0023,
  stop: 0x0024,
  event: 0x0030,
} as const;

export type LabelKind = keyof typeof LABEL_KINDS;

/** The fixed time the transaction's now() maps to. */
export const BASE_TIME = "2026-09-22T10:00:00.000000Z";
/** Every envelope's asOf, and the operator context's serverTime. */
export const AS_OF = "2026-09-22T11:00:00.000000Z";

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const ANY_UUID = new RegExp(UUID_SOURCE, "i");
const CURSOR = new RegExp(`^(tk|rn|rv|ev|st)1:(${UUID_SOURCE})$`);

const fail = (message: string): never => {
  throw new Error(`recording: ${message}`);
};

/** The deterministic uuid of the `ordinal`-th row (from 1) of `kind`. */
export const mappedId = (kind: LabelKind, ordinal: number): string =>
  `00000000-0000-4000-8000-${LABEL_KINDS[kind].toString(16).padStart(4, "0")}${ordinal
    .toString(16)
    .padStart(8, "0")}`;

/**
 * The mapping, built from [live uuid, label] pairs in creation order: each
 * label's kind is its prefix, and its ordinal its place among its kind.
 */
export interface IdMap {
  /** live uuid -> mapped uuid */
  readonly ids: ReadonlyMap<string, string>;
  /** label -> mapped uuid, in the order the labels came */
  readonly labels: Readonly<Record<string, string>>;
}

export const buildIdMap = (
  pairs: readonly (readonly [string, string])[],
): IdMap => {
  const ids = new Map<string, string>();
  const labels: Record<string, string> = {};
  const ordinals = new Map<string, number>();
  for (const [live, label] of pairs) {
    const kind = label.split(":")[0];
    if (!(kind in LABEL_KINDS)) fail(`label ${label} names no known kind`);
    if (label in labels) fail(`label ${label} is used twice`);
    if (ids.has(live)) fail(`${label} names a row another label names`);
    const ordinal = (ordinals.get(kind) ?? 0) + 1;
    ordinals.set(kind, ordinal);
    const mapped = mappedId(kind as LabelKind, ordinal);
    ids.set(live, mapped);
    labels[label] = mapped;
  }
  return { ids, labels };
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const mapTree = (
  value: unknown,
  path: string,
  leaf: (text: string, path: string) => Json,
): Json => {
  if (typeof value === "string") return leaf(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => mapTree(item, `${path}[${index}]`, leaf));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapTree(item, `${path}.${key}`, leaf),
      ]),
    );
  }
  return value as Json;
};

/** Every uuid, bare or inside a cursor, replaced by its mapped id. */
const mapIds = (value: unknown, where: string, idMap: IdMap): Json =>
  mapTree(value, where, (text, path) => {
    const cursor = CURSOR.exec(text);
    if (cursor !== null) {
      const mapped = idMap.ids.get(cursor[2]);
      return mapped === undefined
        ? fail(`${path}: a cursor names an unlabelled row`)
        : `${cursor[1]}1:${mapped}`;
    }
    if (UUID.test(text)) {
      const mapped = idMap.ids.get(text);
      return mapped === undefined ? fail(`${path}: an unlabelled id`) : mapped;
    }
    if (ANY_UUID.test(text)) fail(`${path}: an id inside free text`);
    return text;
  });

// ---------------------------------------------------------------------------
// Order: the server's comparators, replayed on the mapped ids.
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly createdAt: string;
}

interface RunFacts extends Row {
  readonly taskId: string;
  readonly status: string;
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** (created_at desc, id desc): the server's order for every such list. */
const newestFirst = (left: Row, right: Row): number =>
  compare(right.createdAt, left.createdAt) || compare(right.id, left.id);

const oldestFirst = (left: Row, right: Row): number =>
  -newestFirst(left, right);

type Obj = { [key: string]: Json };

const asObject = (value: Json, what: string): Obj =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : fail(`${what} is not an object`);

const asArray = (value: Json, what: string): Json[] =>
  Array.isArray(value) ? value : fail(`${what} is not an array`);

/** The runs every recording names, from their summaries. */
const runIndex = (calls: readonly { operation: string; response: Json }[]) => {
  const runs = new Map<string, RunFacts>();
  const add = (value: Json) => {
    const run = asObject(value, "a run");
    if (runs.has(String(run.id))) return;
    runs.set(String(run.id), {
      id: String(run.id),
      createdAt: String(run.createdAt),
      taskId: String(run.taskId),
      status: String(run.status),
    });
  };
  for (const { operation, response } of calls) {
    const body = asObject(response, operation);
    if (operation === "list_runs") asArray(body.items, "items").forEach(add);
    if (operation === "get_run") add(body);
    if (operation === "get_agent") {
      asArray(body.recentRuns, "recentRuns").forEach(add);
    }
    if (operation === "get_task") asArray(body.runs, "runs").forEach(add);
  }
  return runs;
};

const sortRunIds = (
  ids: Json,
  runs: ReadonlyMap<string, RunFacts>,
  order: (left: Row, right: Row) => number,
  what: string,
): Json[] =>
  asArray(ids, what)
    .map((id) => runs.get(String(id)) ?? fail(`${what}: run ${id} unknown`))
    .sort(order)
    .map((run) => run.id);

const sortAgentEvidence = (
  agent: Json,
  runs: ReadonlyMap<string, RunFacts>,
): Json => {
  const body = asObject(agent, "an agent");
  const evidence = asObject(body.evidence, "evidence");
  const sorted: Obj = { ...evidence };
  for (const key of [
    "workingRunIds",
    "heldRunIds",
    "queuedRunIds",
    "staleRunIds",
    "attentionRunIds",
  ]) {
    sorted[key] = sortRunIds(evidence[key], runs, newestFirst, key);
  }
  return { ...body, evidence: sorted };
};

/**
 * A task's latest run: the server picks it with (created_at desc, id desc),
 * so a tie is decided by the random id. Replayed on the mapped ids, over every
 * run of the task the recordings name; the server's pick must be one of the
 * runs tied for latest, or the normaliser would be changing more than order.
 */
const latestRunOf = (task: Obj, runs: ReadonlyMap<string, RunFacts>): Json => {
  const pipeline = asObject(task.pipeline, "pipeline");
  if (pipeline.latestRun === null) return task;
  const recorded = asObject(pipeline.latestRun, "latestRun");
  const candidates = [...runs.values()]
    .filter((run) => run.taskId === task.id)
    .sort(newestFirst);
  const pick = candidates[0] ?? fail(`task ${task.id}: no run recorded`);
  const recordedRun = runs.get(String(recorded.id));
  if (recordedRun === undefined || recordedRun.createdAt !== pick.createdAt) {
    fail(`task ${task.id}: the server's latest run is not tied for latest`);
  }
  return {
    ...task,
    pipeline: { ...pipeline, latestRun: { id: pick.id, status: pick.status } },
  };
};

const onePage = (body: Obj, what: string): Obj[] => {
  if (body.nextCursor !== null) {
    fail(`${what}: a list the normaliser re-sorts must fit on one page`);
  }
  return asArray(body.items, what).map((item) => asObject(item, what));
};

const reorder = (
  call: { operation: string; args: Json; response: Json },
  runs: ReadonlyMap<string, RunFacts>,
): Json => {
  const body = asObject(call.response, call.operation);
  const args = asObject(call.args, "args");
  switch (call.operation) {
    case "list_tasks":
      return {
        ...body,
        items: onePage(body, "list_tasks")
          .sort((l, r) => newestFirst(l as never, r as never))
          .map((task) => latestRunOf(task, runs)),
      };
    case "get_task":
      return latestRunOf(
        {
          ...body,
          runs: asArray(body.runs, "runs")
            .map((run) => asObject(run, "run"))
            .sort((l, r) => newestFirst(l as never, r as never)),
        },
        runs,
      );
    case "list_runs":
      return {
        ...body,
        items: onePage(body, "list_runs").sort((l, r) =>
          newestFirst(l as never, r as never),
        ),
      };
    case "get_run":
      return {
        ...body,
        retriedByRunIds: sortRunIds(
          body.retriedByRunIds,
          runs,
          oldestFirst,
          "retriedByRunIds",
        ),
      };
    case "list_reviews": {
      // The pending tab is oldest first; the decided tabs are newest first.
      const pending = args.p_status === undefined;
      return {
        ...body,
        items: onePage(body, "list_reviews").sort((l, r) =>
          (pending ? oldestFirst : newestFirst)(l as never, r as never),
        ),
      };
    }
    case "list_stops":
      return {
        ...body,
        items: onePage(body, "list_stops").sort(
          (l, r) =>
            compare(String(r.trippedAt), String(l.trippedAt)) ||
            compare(String(r.id), String(l.id)),
        ),
      };
    case "list_agents":
      return {
        ...body,
        items: asArray(body.items, "items").map((agent) =>
          sortAgentEvidence(agent, runs),
        ),
      };
    case "get_agent":
      return {
        ...body,
        agent: sortAgentEvidence(body.agent, runs),
        recentRuns: asArray(body.recentRuns, "recentRuns")
          .map((run) => asObject(run, "run"))
          .sort((l, r) => newestFirst(l as never, r as never)),
      };
    default:
      return body;
  }
};

// ---------------------------------------------------------------------------
// Time.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

const timeAt = (base: string, minutes: number): string =>
  `${new Date(Date.parse(base) + minutes * MINUTE_MS).toISOString().slice(0, 19)}.000000Z`;

/** Every envelope's asOf and the context's serverTime, fixed. */
const fixEnvelopeTimes = (value: Json): Json => {
  const body = asObject(value, "a response");
  return {
    ...body,
    ...("asOf" in body ? { asOf: AS_OF } : {}),
    ...("serverTime" in body ? { serverTime: AS_OF } : {}),
  };
};

const collectTimes = (value: Json, into: Set<string>): void => {
  mapTree(value, "", (text) => {
    if (TIMESTAMP.test(text)) into.add(text);
    return text;
  });
};

// ---------------------------------------------------------------------------
// The whole normalisation.
// ---------------------------------------------------------------------------

const callKey = (call: { operation: string; args: Json }): string =>
  `${call.operation} ${JSON.stringify(call.args)}`;

const byCall = (
  left: { operation: string; args: Json },
  right: { operation: string; args: Json },
): number => compare(callKey(left), callKey(right));

export interface Normalised {
  readonly scenarios: Readonly<Record<string, readonly RecordedCall[]>>;
}

/**
 * Normalises every scenario together, so one live id or one live time maps to
 * one value everywhere. `now` is the recording transaction's now(), as
 * ops.cos_ts prints it.
 */
export const normalise = (
  scenarios: Readonly<Record<string, readonly RecordedCall[]>>,
  idMap: IdMap,
  now: string,
): Normalised => {
  if (!TIMESTAMP.test(now)) fail("now is not a contract timestamp");
  const mapped = Object.fromEntries(
    Object.entries(scenarios).map(([name, calls]) => [
      name,
      calls.map((call, index) => ({
        operation: call.operation,
        args: mapIds(call.args, `${name}[${index}].args`, idMap),
        response: mapIds(call.response, `${name}[${index}].response`, idMap),
      })),
    ]),
  );

  // Order. A run's creation time and task are the same in every scenario, so
  // one index serves them all; a status comes from the first scenario that
  // names the run, and only the first scenario lists tasks.
  const runs = runIndex(Object.values(mapped).flat());
  const ordered = Object.fromEntries(
    Object.entries(mapped).map(([name, calls]) => [
      name,
      calls.map((call) => ({
        ...call,
        response: fixEnvelopeTimes(reorder(call, runs)),
      })),
    ]),
  );

  // Time, across every scenario at once.
  const times = new Set<string>([now]);
  for (const calls of Object.values(ordered)) {
    for (const call of calls) collectTimes(call.response, times);
  }
  times.delete(AS_OF);
  const sorted = [...times].sort();
  const origin = sorted.indexOf(now);
  const timeMap = new Map(
    sorted.map((time, index) => [time, timeAt(BASE_TIME, index - origin)]),
  );
  const withTimes = Object.fromEntries(
    Object.entries(ordered).map(([name, calls]) => [
      name,
      // Recorded in whatever order the live ids sorted in; kept in one fixed
      // order, so a recording changes only where an answer does.
      [...calls].sort(byCall).map((call) => ({
        operation: call.operation as CompanyOsOperation,
        args: call.args as Record<string, unknown>,
        response: mapTree(call.response, "", (text) =>
          TIMESTAMP.test(text) && text !== AS_OF
            ? (timeMap.get(text) ?? fail(`time ${text} unmapped`))
            : text,
        ),
      })),
    ]),
  );
  return { scenarios: withTimes };
};

/**
 * The first place two JSON values differ, as a path, or null when they are
 * equal: what a drifted recording reports instead of a whole-file diff.
 */
export const firstDifference = (
  left: unknown,
  right: unknown,
  path = "$",
): string | null => {
  if (Object.is(left, right)) return null;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return path;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path} (length)`;
    for (let index = 0; index < left.length; index += 1) {
      const found = firstDifference(
        left[index],
        right[index],
        `${path}[${index}]`,
      );
      if (found !== null) return found;
    }
    return null;
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(leftObject),
    ...Object.keys(rightObject),
  ]);
  for (const key of keys) {
    const found = firstDifference(
      leftObject[key],
      rightObject[key],
      `${path}.${key}`,
    );
    if (found !== null) return found;
  }
  return null;
};
