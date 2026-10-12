import { describe, expect, it } from "vitest";
import { absoluteDue, relativeDue } from "./tz";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-12T09:30:00.000Z"); // 15:00 IST

describe("relativeDue", () => {
  it("counts minutes, then hours, then days", () => {
    expect(relativeDue("2026-10-12T09:55:00.000Z", TZ, false, NOW)).toBe("in 25m");
    expect(relativeDue("2026-10-12T12:30:00.000Z", TZ, false, NOW)).toBe("in 3h");
    expect(relativeDue("2026-10-16T09:30:00.000Z", TZ, false, NOW)).toBe("in 4d");
  });
  it("says overdue rather than a negative", () => {
    expect(relativeDue("2026-10-12T08:30:00.000Z", TZ, false, NOW)).toBe("overdue 1h");
    expect(relativeDue("2026-10-11T09:30:00.000Z", TZ, false, NOW)).toBe("overdue 1d");
  });
  it("compares all-day tasks by day, so a birthday today is not overdue", () => {
    // 2026-10-12 00:00 IST = 2026-10-11T18:30Z — hours "past" but the same local day.
    expect(relativeDue("2026-10-11T18:30:00.000Z", TZ, true, NOW)).toBe("today");
    expect(relativeDue("2026-10-12T18:30:00.000Z", TZ, true, NOW)).toBe("tomorrow");
    expect(relativeDue("2026-10-10T18:30:00.000Z", TZ, true, NOW)).toBe("overdue 1d");
  });
});

describe("absoluteDue", () => {
  it("drops the clock for an all-day task", () => {
    expect(absoluteDue("2026-10-11T18:30:00.000Z", TZ, true)).not.toMatch(/\d:\d/);
    expect(absoluteDue("2026-10-12T09:30:00.000Z", TZ)).toMatch(/3:00/);
  });
});
