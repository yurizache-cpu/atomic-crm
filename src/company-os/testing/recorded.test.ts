import {
  COMPANY_OS_OPERATION_NAMES,
  parseOperationResult,
} from "../../../contracts/company-os-api/index.ts";
import {
  RECORDED_IDS,
  createRecordedSession,
  everyRecording,
  recorded,
  rid,
} from "./recorded";

// The recordings the screens' tests replay are only worth their assertions if
// the real contracts accept them and they carry nothing but synthetic values:
// every recorded answer parses with its operation's response contract, and no
// recording holds an email-shaped value, a sentinel, or an id the recorder did
// not mint (engine/domain/companyOsRecordedResponses.dbtest.ts sweeps the
// fixture's own identity values before it writes them).

const MINTED_ID = /^00000000-0000-4000-8000-[0-9a-f]{12}$/;
const ANY_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

describe("the recorded company_os_api answers", () => {
  it("cover every read operation, and each answer parses with its response contract", () => {
    const recordings = everyRecording();

    expect(
      [...new Set(recordings.map((call) => call.operation))].sort(),
    ).toEqual([...COMPANY_OS_OPERATION_NAMES].sort());
    for (const call of recordings) {
      expect(
        () => parseOperationResult(call.operation, call.response),
        `${call.scenario} ${call.operation} ${JSON.stringify(call.args)}`,
      ).not.toThrow();
    }
  });

  it("hold no identity value: nothing email-shaped, no sentinel, and only ids the recorder minted", () => {
    const text = JSON.stringify([everyRecording(), RECORDED_IDS]);

    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/sentinel/i);
    const ids = [...text.matchAll(ANY_ID)].map((match) => match[0]);
    expect(ids.filter((id) => !MINTED_ID.test(id))).toEqual([]);
    const labelled = new Set(Object.values(RECORDED_IDS));
    expect(ids.filter((id) => !labelled.has(id))).toEqual([]);
  });

  it("answer a read as the server did, an unknown id as not found and an unissued cursor as a restart", async () => {
    const session = createRecordedSession();

    const agent = await session.port.rpc("get_agent", {
      p_agent_id: rid("agent:lead-triage"),
    });
    const missing = await session.port.rpc("get_agent", {
      p_agent_id: rid("task:bare"),
    });
    const cursor = await session.port.rpc("list_tasks", {
      p_cursor: `tk1:${rid("task:bare")}`,
    });
    const unrecorded = await session.port.rpc("list_tasks", {
      p_status: "cancelled",
    });

    expect(agent).toEqual({
      data: recorded("get_agent", { p_agent_id: rid("agent:lead-triage") }),
      error: null,
    });
    expect(missing.error).toEqual({ code: "OS404" });
    expect(cursor.error).toEqual({ code: "OS400" });
    expect(unrecorded.error).toEqual({ code: "OS500" });
    expect(session.unmatched).toEqual([
      { operation: "list_tasks", args: { p_status: "cancelled" } },
    ]);
  });

  it("key a read by its canonical input: an omitted, a null and a DEFAULT argument ask the same thing", async () => {
    const session = createRecordedSession();

    const omitted = await session.port.rpc("list_runs", {});
    const spelledOut = await session.port.rpc("list_runs", {
      p_status: null,
      p_agent_id: null,
      p_attention_only: false,
      p_cursor: null,
    });

    expect(spelledOut).toEqual(omitted);
    expect(omitted.error).toBeNull();
  });
});
