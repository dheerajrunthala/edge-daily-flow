import { describe, expect, it } from "vitest";

import { dayKey, offsetLabel, startOfDayUtc, zonedToUtc } from "./time";

const TZ = "Asia/Kolkata";

describe("dayKey", () => {
  /**
   * The regression this file exists for.
   *
   * src/lib/tz.ts has always done `new Date(date)` inside dayKey; the Edge copy did not,
   * while half its callers pass an ISO timestamp straight out of Postgres. Intl coerces a
   * string argument with ToNumber, gets NaN, and throws "Invalid time value" — so
   * nextOccurrenceAhead threw on its `allDay` branch, i.e. every time an all-day
   * recurring task (a birthday) was completed from Telegram or a push notification.
   */
  it("accepts an ISO string, not only a Date", () => {
    const iso = "2026-10-12T09:30:00.000Z";
    expect(() => dayKey(iso, TZ)).not.toThrow();
    expect(dayKey(iso, TZ)).toBe(dayKey(new Date(iso), TZ));
  });

  it("reads the date in the target zone, not UTC", () => {
    // 2026-10-12 23:00 IST is still 17:30Z the same day...
    expect(dayKey("2026-10-12T17:30:00.000Z", TZ)).toBe("2026-10-12");
    // ...but 19:00Z has already rolled over to the 13th in Kolkata.
    expect(dayKey("2026-10-12T19:00:00.000Z", TZ)).toBe("2026-10-13");
    expect(dayKey("2026-10-12T19:00:00.000Z", "UTC")).toBe("2026-10-12");
  });

  it("pads single-digit months and days", () => {
    expect(dayKey("2026-01-05T06:00:00.000Z", TZ)).toBe("2026-01-05");
  });
});

describe("zonedToUtc", () => {
  it("maps wall-clock time in the zone to the right instant", () => {
    expect(zonedToUtc(2026, 10, 13, 9, 0, TZ).toISOString()).toBe("2026-10-13T03:30:00.000Z");
  });

  it("round-trips through dayKey for a local midnight", () => {
    // The all-day invariant create_task relies on: local midnight must still read as
    // that same local date, which a naive UTC midnight would not for a +05:30 zone.
    const midnight = zonedToUtc(2026, 10, 20, 0, 0, TZ);
    expect(midnight.toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(dayKey(midnight, TZ)).toBe("2026-10-20");
  });
});

describe("startOfDayUtc", () => {
  it("returns the instant the user's day began", () => {
    expect(startOfDayUtc(new Date("2026-10-12T17:30:00.000Z"), TZ).toISOString()).toBe(
      "2026-10-11T18:30:00.000Z",
    );
  });
});

describe("offsetLabel", () => {
  it("formats a half-hour offset the way an ISO timestamp needs it", () => {
    expect(offsetLabel(new Date("2026-10-12T00:00:00.000Z"), TZ)).toBe("+05:30");
    expect(offsetLabel(new Date("2026-10-12T00:00:00.000Z"), "UTC")).toBe("+00:00");
  });

  it("signs a negative offset", () => {
    expect(offsetLabel(new Date("2026-01-15T00:00:00.000Z"), "America/New_York")).toBe("-05:00");
  });
});
