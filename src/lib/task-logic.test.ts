import { describe, expect, it } from "vitest";
import {
  displayGroup,
  matchesSearch,
  nextOccurrence,
  nextOccurrenceAhead,
  onTimeRate,
  repoContextLine,
  sortTasks,
  taskGroup,
  type Task,
} from "./task-logic";

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

// A fixture with only the fields the helpers under test look at.
function task(p: Partial<Task> = {}): Task {
  return {
    id: p.id ?? crypto.randomUUID(),
    user_id: "u",
    title: "x",
    notes: null,
    due_at: null,
    all_day: false,
    recurrence: "none",
    priority: "medium",
    status: "todo",
    tags: [],
    remind_before: null,
    last_reminded_at: null,
    snoozed_until: null,
    completed_at: null,
    source: "manual",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...p,
  } as Task;
}

describe("sortTasks", () => {
  it("puts high priority first and keeps someday last", () => {
    const a = task({ title: "a", priority: "low", due_at: "2026-10-12T00:00:00.000Z" });
    const b = task({ title: "b", priority: "high", due_at: "2026-10-14T00:00:00.000Z" });
    const c = task({ title: "c", priority: "medium", due_at: null });
    expect(sortTasks([a, b, c], "priority").map((t) => t.title)).toEqual(["b", "c", "a"]);
    expect(sortTasks([c, a, b], "due").map((t) => t.title)).toEqual(["a", "b", "c"]);
  });
  it("A–Z is case-insensitive", () => {
    const list = [task({ title: "beta" }), task({ title: "Alpha" })];
    expect(sortTasks(list, "alpha").map((t) => t.title)).toEqual(["Alpha", "beta"]);
  });
  it("recently created and recently updated are newest first", () => {
    const old = task({
      title: "old",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-05-01T00:00:00.000Z",
    });
    const fresh = task({
      title: "fresh",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-02-01T00:00:00.000Z",
    });
    expect(sortTasks([old, fresh], "created").map((t) => t.title)).toEqual(["fresh", "old"]);
    expect(sortTasks([fresh, old], "updated").map((t) => t.title)).toEqual(["old", "fresh"]);
  });
  it("does not mutate its input", () => {
    const list = [task({ title: "b" }), task({ title: "a" })];
    const copy = [...list];
    sortTasks(list, "alpha");
    expect(list).toEqual(copy);
  });
});

describe("matchesSearch", () => {
  const t = task({ title: "Fix auth redirect", notes: "Repo: edge-daily-flow", tags: ["Coding"] });
  it("matches title, notes and tags, case-insensitively", () => {
    expect(matchesSearch(t, "AUTH")).toBe(true);
    expect(matchesSearch(t, "edge-daily")).toBe(true);
    expect(matchesSearch(t, "coding")).toBe(true);
    expect(matchesSearch(t, "news")).toBe(false);
  });
  it("an empty query matches everything", () => {
    expect(matchesSearch(t, "   ")).toBe(true);
  });
});

describe("repoContextLine", () => {
  it("prefers the Next: line over the other labels", () => {
    const notes = "Project: edge-daily-flow\nBranch: main\nNext: wire the cron";
    expect(repoContextLine(notes)).toBe("Next: wire the cron");
  });
  it("falls back to the first labelled line", () => {
    expect(repoContextLine("Repo: foo\nsomething else")).toBe("Repo: foo");
  });
  it("leaves freeform notes alone", () => {
    expect(repoContextLine("remember to call the plumber")).toBeNull();
    expect(repoContextLine(null)).toBeNull();
  });
});

describe("displayGroup", () => {
  it("files a completed task under done however overdue it was", () => {
    const t = task({ status: "done", due_at: "2026-10-01T00:00:00.000Z" });
    expect(displayGroup(t, TZ, new Date("2026-10-12T06:00:00.000Z"))).toBe("done");
  });
});
