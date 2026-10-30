import type { Task } from "@/lib/task-logic";
import { dayKey, partsInTz } from "@/lib/tz";

/**
 * RFC 5545 escaping for SUMMARY and DESCRIPTION fields.
 * Backslash-escape \ ; , and replace newlines with \n.
 */
function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\") // Backslash first
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Format a Date in ISO 8601 basic format (YYYYMMDDTHHmmssZ).
 * Used for DTSTAMP.
 */
function formatIcsUtcTimestamp(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Format a Date in ISO 8601 UTC format (YYYYMMDDTHHmmssZ).
 * Used for DTSTART and DTEND of timed events.
 */
function formatIcsUtcTime(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
}

/**
 * Format a date as YYYYMMDD for all-day events.
 * Takes the date in the user's timezone and formats it as a DATE value.
 */
function formatIcsDate(date: Date, tz: string): string {
  const key = dayKey(date, tz);
  return key.replace(/-/g, "");
}

/**
 * Default duration for a timed task: 1 hour.
 * RFC 5545 requires either DTEND or DURATION; timed tasks have no end_time
 * in the schema, so we default to this constant.
 */
const TIMED_TASK_DURATION_MINUTES = 60;

/**
 * Build an RFC 5545 VEVENT for a task and return the .ics file content.
 *
 * Handles two cases:
 * - All-day task: DTSTART;VALUE=DATE and DTEND is the next day (exclusive)
 * - Timed task: DTSTART/DTEND in UTC with Z suffix, 1-hour default duration
 *
 * Includes proper escaping of summary/description, CRLF line endings, stable UID.
 */
/** The "Repo: ..." line shared by the .ics DESCRIPTION and the Google Calendar `details` param. */
function descriptionText(task: Task): string {
  return `Repo: ${task.notes ? task.notes : "edge-daily-flow"}`;
}

/**
 * All-day-vs-timed date range for a task, in the same basic ICS format (YYYYMMDD or
 * YYYYMMDDTHHMMSSZ) that Google Calendar's `dates=` param also accepts — computed once so
 * the .ics export and the Google Calendar link can't drift apart on the IST-offset logic.
 */
function calendarDateRange(task: Task, tz: string): { start: string; end: string } {
  if (!task.due_at) {
    throw new Error("Task has no due_at; cannot export to calendar");
  }

  if (task.all_day) {
    // All-day event: use DATE format. End is exclusive, so it's the next day.
    const start = formatIcsDate(new Date(task.due_at), tz);
    const nextDay = new Date(new Date(task.due_at).getTime() + 24 * 60 * 60 * 1000);
    const end = formatIcsDate(nextDay, tz);
    return { start, end };
  }

  // Timed event: use UTC timestamps with a default 1-hour duration.
  const dueDate = new Date(task.due_at);
  const start = formatIcsUtcTime(dueDate);
  const endDate = new Date(dueDate.getTime() + TIMED_TASK_DURATION_MINUTES * 60 * 1000);
  const end = formatIcsUtcTime(endDate);
  return { start, end };
}

export function buildCalendarEvent(task: Task, tz: string): string {
  if (!task.due_at) {
    throw new Error("Task has no due_at; cannot export to calendar");
  }

  const now = new Date();
  const dtstamp = formatIcsUtcTimestamp(now);

  // Build the UID from task id — stable across re-exports
  const uid = `${task.id}@dailyedgeapp.lovable.app`;

  // Build event summary and description
  const summary = escapeIcsText(task.title);
  const description = escapeIcsText(descriptionText(task));

  const { start, end } = calendarDateRange(task, tz);
  const dtstart = task.all_day ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`;
  const dtend = task.all_day ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`;

  // Build the VEVENT
  const event = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    dtstart,
    dtend,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    "END:VEVENT",
  ];

  // Build the complete VCALENDAR with CRLF line endings
  const calendar = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Daily Edge//EN",
    ...event,
    "END:VCALENDAR",
  ];

  return calendar.join("\r\n");
}

/**
 * A pre-filled "create event" link to calendar.google.com, using the same date-range
 * logic as the .ics export (calendarDateRange) so the two can't disagree.
 */
export function googleCalendarUrl(task: Task, tz: string): string {
  if (!task.due_at) {
    throw new Error("Task has no due_at; cannot export to calendar");
  }
  const { start, end } = calendarDateRange(task, tz);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: task.title,
    dates: `${start}/${end}`,
    details: descriptionText(task),
    ctz: tz,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Trigger a download of a task as an .ics file.
 */
export function downloadTaskAsIcs(task: Task, tz: string): void {
  if (!task.due_at) {
    throw new Error("Task has no due_at; cannot export to calendar");
  }

  const ics = buildCalendarEvent(task, tz);
  const blob = new Blob([ics], { type: "text/calendar; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${task.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.ics`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
