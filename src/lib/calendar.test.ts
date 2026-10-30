import { describe, expect, it } from "vitest";
import { buildCalendarEvent, downloadTaskAsIcs, googleCalendarUrl } from "@/lib/calendar";
import type { Task } from "@/lib/task-logic";

const TZ = "Asia/Kolkata";

/**
 * Create a minimal task object for testing.
 */
function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-123",
    user_id: "user-123",
    title: "Test Task",
    due_at: "2026-10-31T03:30:00.000Z", // ~11:00 IST
    all_day: false,
    status: "pending",
    notes: null,
    recurrence: "none",
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("buildCalendarEvent", () => {
  it("builds a timed event with UTC timestamps", () => {
    const task = createTask({
      title: "Review the Dubai estimates",
      due_at: "2026-10-31T03:30:00.000Z",
      all_day: false,
      notes: null,
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("DTSTART:20261031T033000Z");
    // 1-hour duration by default
    expect(ics).toContain("DTEND:20261031T043000Z");
    expect(ics).toContain("SUMMARY:Review the Dubai estimates");
  });

  it("uses DATE format for all-day events", () => {
    const task = createTask({
      title: "Birthday",
      due_at: "2026-10-30T18:30:00.000Z", // 2026-10-31 00:00:00 IST
      all_day: true,
    });

    const ics = buildCalendarEvent(task, TZ);

    // All-day events use DATE format without time
    expect(ics).toContain("DTSTART;VALUE=DATE:20261031");
    // DTEND is exclusive, so next day
    expect(ics).toContain("DTEND;VALUE=DATE:20261101");
    expect(ics).not.toContain("T033000Z");
  });

  it("escapes semicolons in summary", () => {
    const task = createTask({
      title: "Call; check; confirm",
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("SUMMARY:Call\\; check\\; confirm");
  });

  it("escapes commas in summary", () => {
    const task = createTask({
      title: "Send to Abhishek, Priya, and Rohit",
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("SUMMARY:Send to Abhishek\\, Priya\\, and Rohit");
  });

  it("escapes backslashes in summary", () => {
    const task = createTask({
      title: "Path: C:\\Users\\test",
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("SUMMARY:Path: C:\\\\Users\\\\test");
  });

  it("escapes newlines in summary", () => {
    const task = createTask({
      title: "Line 1\nLine 2",
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("SUMMARY:Line 1\\nLine 2");
  });

  it("escapes multiple special characters in description", () => {
    const task = createTask({
      notes: "First; second, third\nNext: do this",
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("DESCRIPTION:Repo: First\\; second\\, third\\nNext: do this");
  });

  it("uses CRLF line endings", () => {
    const task = createTask();
    const ics = buildCalendarEvent(task, TZ);

    // Count CRLF vs LF
    const crlfCount = (ics.match(/\r\n/g) || []).length;
    const lfOnlyCount = (ics.match(/[^\r]\n/g) || []).length;

    expect(crlfCount).toBeGreaterThan(0);
    expect(lfOnlyCount).toBe(0); // No bare LF, only CRLF
  });

  it("generates stable UID from task id", () => {
    const task = createTask({ id: "stable-id-456" });

    const ics1 = buildCalendarEvent(task, TZ);
    const ics2 = buildCalendarEvent(task, TZ);

    // Extract UID lines
    const uid1 = ics1.split("\r\n").find((l) => l.startsWith("UID:"));
    const uid2 = ics2.split("\r\n").find((l) => l.startsWith("UID:"));

    expect(uid1).toBe("UID:stable-id-456@dailyedgeapp.lovable.app");
    expect(uid1).toBe(uid2);
  });

  it("handles a title at 300 characters", () => {
    const longTitle = "A".repeat(300);
    const task = createTask({ title: longTitle });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain(`SUMMARY:${"A".repeat(300)}`);
  });

  it("throws when task has no due_at", () => {
    const task = createTask({ due_at: null });

    expect(() => buildCalendarEvent(task, TZ)).toThrow("Task has no due_at");
  });

  it("includes VERSION 2.0 and PRODID", () => {
    const task = createTask();
    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//Daily Edge//EN");
  });

  it("includes DTSTAMP in correct format", () => {
    const task = createTask();
    const before = new Date();
    const ics = buildCalendarEvent(task, TZ);
    const after = new Date();

    // Extract DTSTAMP
    const dtstampLine = ics.split("\r\n").find((l) => l.startsWith("DTSTAMP:"));
    expect(dtstampLine).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);

    // Verify it's recent
    const dtstampStr = dtstampLine?.replace("DTSTAMP:", "") || "";
    const dtstampDate = new Date(
      dtstampStr
        .replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z")
        .replace(/Z$/, ".000Z"),
    );

    expect(dtstampDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(dtstampDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("includes task notes in description", () => {
    const task = createTask({
      notes: "Important context here",
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("DESCRIPTION:Repo: Important context here");
  });

  it("defaults to daily notes when no notes provided", () => {
    const task = createTask({
      notes: null,
    });

    const ics = buildCalendarEvent(task, TZ);

    expect(ics).toContain("DESCRIPTION:Repo: edge-daily-flow");
  });
});

describe("downloadTaskAsIcs", () => {
  it("throws when task has no due_at", () => {
    const task = createTask({ due_at: null });

    expect(() => downloadTaskAsIcs(task, TZ)).toThrow("Task has no due_at");
  });

  // Note: downloadTaskAsIcs uses DOM APIs (document.createElement, etc.)
  // which are available in vitest's environment, but actual download behavior
  // cannot be unit tested without mocking. This test verifies the error path.
});

describe("googleCalendarUrl", () => {
  it("builds a timed-event link with a UTC range an hour apart and ctz set", () => {
    const task = createTask({
      title: "Review the Dubai estimates",
      due_at: "2026-10-31T03:30:00.000Z",
      all_day: false,
      notes: null,
    });

    const url = googleCalendarUrl(task, TZ);
    const params = new URL(url).searchParams;

    expect(url).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?/);
    expect(params.get("action")).toBe("TEMPLATE");
    expect(params.get("dates")).toBe("20261031T033000Z/20261031T043000Z");
    expect(params.get("ctz")).toBe(TZ);
  });

  it("builds an all-day link with a plain date range, end on the next day", () => {
    const task = createTask({
      title: "Birthday",
      due_at: "2026-10-30T18:30:00.000Z", // 2026-10-31 00:00:00 IST
      all_day: true,
    });

    const url = googleCalendarUrl(task, TZ);
    const params = new URL(url).searchParams;

    expect(params.get("dates")).toBe("20261031/20261101");
  });

  it("round-trips a title and notes containing characters that need encoding", () => {
    const task = createTask({
      title: "Call; check, confirm & review",
      notes: 'Notes with "quotes" & an & ampersand, plus a comma',
    });

    const url = googleCalendarUrl(task, TZ);
    const params = new URL(url).searchParams;

    expect(params.get("text")).toBe("Call; check, confirm & review");
    expect(params.get("details")).toBe('Repo: Notes with "quotes" & an & ampersand, plus a comma');
  });

  it("throws when task has no due_at", () => {
    const task = createTask({ due_at: null });

    expect(() => googleCalendarUrl(task, TZ)).toThrow("Task has no due_at");
  });
});
