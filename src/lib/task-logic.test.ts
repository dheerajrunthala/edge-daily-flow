import { describe, expect, it } from "vitest";
import { nextOccurrence, nextOccurrenceAhead, onTimeRate, taskGroup } from "./task-logic";

const TZ = "Asia/Kolkata";

describe("recurring tasks", () => {
  it("daily moves to the next day at the same local time", () => {
    // 2026-10-12 15:00 IST = 09:30Z
    expect(nextOccurrence("2026-10-12T09:30:00.000Z", "daily", TZ)).toBe(
      "2026-10-13T09:30:00.000Z",
    );
  });
  it("weekly adds seven days", () => {
    expect(nextOccurrence("2026-10-12T09:30:00.000Z", "weekly", TZ)).toBe(
      "2026-10-19T09:30:00.000Z",
    );
  });
  it("yearly birthday 14 Nov moves to next year", () => {
    expect(nextOccurrence("2026-11-13T18:30:00.000Z", "yearly", TZ)).toBe(
      "2027-11-13T18:30:00.000Z",
    );
  });
  it("monthly clamps Jan 31 to Feb 28", () => {
    expect(nextOccurrence("2027-01-31T04:30:00.000Z", "monthly", TZ)).toBe(
      "2027-02-28T04:30:00.000Z",
    );
  });
  it("non-recurring has no next occurrence", () => {
    expect(nextOccurrence("2026-10-12T09:30:00.000Z", "none", TZ)).toBeNull();
  });
});

describe("rolling a recurring task forward", () => {
  // 2026-10-12 15:00 IST
  const now = new Date("2026-10-12T09:30:00.000Z");

  it("steps once when the next occurrence is already ahead", () => {
    expect(nextOccurrenceAhead("2026-10-12T12:00:00.000Z", "daily", TZ, false, now)).toBe(
      "2026-10-13T12:00:00.000Z",
    );
  });

  it("skips past every missed occurrence of an overdue daily task", () => {
    // Five days behind: one step would still leave it overdue.
    expect(nextOccurrenceAhead("2026-10-07T09:30:00.000Z", "daily", TZ, false, now)).toBe(
      "2026-10-13T09:30:00.000Z",
    );
  });

  it("moves an all-day task due today to the next day, not later today", () => {
    expect(nextOccurrenceAhead("2026-10-12T18:30:00.000Z", "daily", TZ, true, now)).toBe(
      "2026-10-13T18:30:00.000Z",
    );
  });

  it("catches a yearly birthday up to next year", () => {
    expect(nextOccurrenceAhead("2024-11-13T18:30:00.000Z", "yearly", TZ, true, now)).toBe(
      "2026-11-13T18:30:00.000Z",
    );
  });

  it("non-recurring has nothing to roll to", () => {
    expect(nextOccurrenceAhead("2026-10-12T09:30:00.000Z", "none", TZ, false, now)).toBeNull();
  });
});

describe("task grouping", () => {
  const now = new Date("2026-10-12T06:00:00.000Z"); // 11:30 IST
  it("no due date is someday", () => {
    expect(taskGroup({ due_at: null, all_day: false }, TZ, now)).toBe("someday");
  });
  it("yesterday is overdue", () => {
    expect(taskGroup({ due_at: "2026-10-11T06:00:00.000Z", all_day: false }, TZ, now)).toBe(
      "overdue",
    );
  });
  it("later today is today", () => {
    expect(taskGroup({ due_at: "2026-10-12T10:00:00.000Z", all_day: false }, TZ, now)).toBe(
      "today",
    );
  });
  it("tomorrow is upcoming", () => {
    expect(taskGroup({ due_at: "2026-10-13T06:00:00.000Z", all_day: true }, TZ, now)).toBe(
      "upcoming",
    );
  });
});

describe("on-time rate", () => {
  it("counts completions on or before due", () => {
    expect(
      onTimeRate([
        { due_at: "2026-10-12T10:00:00Z", completed_at: "2026-10-12T09:00:00Z" },
        { due_at: "2026-10-12T10:00:00Z", completed_at: "2026-10-12T11:00:00Z" },
      ]),
    ).toBe(50);
  });
});
