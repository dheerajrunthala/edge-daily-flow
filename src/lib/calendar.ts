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
  const descriptionText = task.notes ? task.notes : "edge-daily-flow";
  const description = escapeIcsText(`Repo: ${descriptionText}`);

  let dtstart: string;
  let dtend: string;

  if (task.all_day) {
    // All-day event: use DATE format
    dtstart = `DTSTART;VALUE=DATE:${formatIcsDate(new Date(task.due_at), tz)}`;
    // DTEND is exclusive, so it's the next day for all-day events
    const nextDay = new Date(new Date(task.due_at).getTime() + 24 * 60 * 60 * 1000);
    dtend = `DTEND;VALUE=DATE:${formatIcsDate(nextDay, tz)}`;
  } else {
    // Timed event: use UTC timestamps
    const dueDate = new Date(task.due_at);
    dtstart = `DTSTART:${formatIcsUtcTime(dueDate)}`;

    // Add default duration of 1 hour
    const endDate = new Date(dueDate.getTime() + TIMED_TASK_DURATION_MINUTES * 60 * 1000);
    dtend = `DTEND:${formatIcsUtcTime(endDate)}`;
  }

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
