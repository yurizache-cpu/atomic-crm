import { instantToWallTime, wallTimeToInstant } from "./funnelModel";

// The next action a person types is a date and a time on the tenant's wall
// clock; the act sends the absolute instant (Phase 3B.2).

describe("the funnel's wall-clock time", () => {
  it("turns a date and time in the funnel's zone into the absolute instant", () => {
    expect(wallTimeToInstant("2030-03-06", "09:30", "America/Sao_Paulo")).toBe(
      "2030-03-06T12:30:00.000Z",
    );
    expect(wallTimeToInstant("2030-07-01", "12:00", "Europe/Berlin")).toBe(
      "2030-07-01T10:00:00.000Z",
    );
    expect(wallTimeToInstant("2030-03-04", "00:00", "UTC")).toBe(
      "2030-03-04T00:00:00.000Z",
    );
  });

  it("refuses a local time that does not exist, and takes the earlier of a repeated one", () => {
    // Clocks jump from 02:00 to 03:00 in New York on 2030-03-10.
    expect(
      wallTimeToInstant("2030-03-10", "02:30", "America/New_York"),
    ).toBeNull();
    // 01:30 happens twice on 2030-11-03: the first, still on daylight time.
    expect(wallTimeToInstant("2030-11-03", "01:30", "America/New_York")).toBe(
      "2030-11-03T05:30:00.000Z",
    );
  });

  it("refuses a malformed or impossible date or time", () => {
    for (const [date, time] of [
      ["", "09:30"],
      ["2030-02-30", "09:30"],
      ["2030-03-04", "24:00"],
      ["2030-03-04", "9:30"],
      ["04/03/2030", "09:30"],
    ]) {
      expect(wallTimeToInstant(date, time, "America/Sao_Paulo")).toBeNull();
    }
  });

  it("reads an instant back as the date and time the owner sees", () => {
    expect(
      instantToWallTime("2030-03-06T12:30:00.000000Z", "America/Sao_Paulo"),
    ).toEqual({ date: "2030-03-06", time: "09:30" });
    const back = instantToWallTime(
      wallTimeToInstant("2030-11-03", "01:30", "America/New_York")!,
      "America/New_York",
    );
    expect(back).toEqual({ date: "2030-11-03", time: "01:30" });
  });
});
