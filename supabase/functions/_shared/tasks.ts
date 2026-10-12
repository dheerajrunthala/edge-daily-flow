// Server-side task mutations. Mirrors src/lib/task-logic.ts the way time.ts mirrors
// src/lib/tz.ts: the browser and the Telegram bot must agree on what completing or
// rescheduling a task does, and the bot has no browser to borrow the logic from.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { dayKey, partsInTz, zonedToUtc } from "./time.ts";

export type Recurrence = "none" | "daily" | "weekly" | "monthly" | "yearly";

export type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  all_day: boolean;
  priority: string;
  status: string;
  recurrence: Recurrence;
  remind_before: string | null;
  last_reminded_at: string | null;
  snoozed_until: string | null;
  created_at: string;
};

export const TASK_COLUMNS =
  "id, user_id, title, notes, due_at, all_day, priority, status, recurrence, " +
  "remind_before, last_reminded_at, snoozed_until, created_at";

/** Next occurrence of a recurring due date, keeping the wall-clock time in tz. */
export function nextOccurrence(dueAt: string, recurrence: Recurrence, tz: string): string | null {
  if (recurrence === "none") return null;
  const p = partsInTz(new Date(dueAt), tz);
  let { y, m, d } = p;
  if (recurrence === "daily") d += 1;
  else if (recurrence === "weekly") d += 7;
  else if (recurrence === "monthly") m += 1;
  else if (recurrence === "yearly") y += 1;

  if (recurrence === "monthly" || recurrence === "yearly") {
    // Clamp to the last day of the target month (Jan 31 -> Feb 28)
    const norm = new Date(Date.UTC(y, m - 1, 1));
    const lastDay = new Date(
      Date.UTC(norm.getUTCFullYear(), norm.getUTCMonth() + 1, 0),
    ).getUTCDate();
    y = norm.getUTCFullYear();
    m = norm.getUTCMonth() + 1;
    d = Math.min(d, lastDay);
  } else {
    const norm = new Date(Date.UTC(y, m - 1, d));
    y = norm.getUTCFullYear();
    m = norm.getUTCMonth() + 1;
    d = norm.getUTCDate();
  }
  return zonedToUtc(y, m, d, p.h, p.min, tz).toISOString();
}

/**
 * Where a recurring task should land after it's completed: the first occurrence that is
 * still ahead. Stepping once isn't enough — a daily task left for a week would roll from
 * "5 days overdue" to "4 days overdue".
 */
export function nextOccurrenceAhead(
  dueAt: string,
  recurrence: Recurrence,
  tz: string,
  allDay = false,
  now = new Date(),
): string | null {
  let next = nextOccurrence(dueAt, recurrence, tz);
  if (!next) return null;
  const today = dayKey(now, tz);
  for (let i = 0; i < 400; i++) {
    const ahead = allDay ? dayKey(next!, tz) > today : new Date(next!) > now;
    if (ahead) break;
    const step = nextOccurrence(next!, recurrence, tz);
    if (!step) break;
    next = step;
  }
  return next;
}

/**
 * Complete a task. Same two shapes as the web app's useToggleTask: a recurring task logs
 * the occurrence and rolls due_at forward (which also starts a fresh escalation, because
 * task_notifications is keyed on due_at); a one-off is marked done and logged.
 */
export async function completeTask(
  admin: SupabaseClient,
  task: TaskRow,
  tz: string,
): Promise<{ rolledTo: string | null }> {
  const now = new Date().toISOString();

  if (task.recurrence !== "none" && task.due_at) {
    const { error: logErr } = await admin
      .from("task_completions")
      .insert({ task_id: task.id, user_id: task.user_id, due_at: task.due_at, completed_at: now });
    if (logErr) throw logErr;

    const next = nextOccurrenceAhead(task.due_at, task.recurrence, tz, task.all_day);
    const { error } = await admin
      .from("tasks")
      .update({ due_at: next, last_reminded_at: null, snoozed_until: null })
      .eq("id", task.id);
    if (error) throw error;
    return { rolledTo: next };
  }

  const { error } = await admin
    .from("tasks")
    .update({ status: "done", completed_at: now, snoozed_until: null })
    .eq("id", task.id);
  if (error) throw error;

  const { error: logErr } = await admin
    .from("task_completions")
    .insert({ task_id: task.id, user_id: task.user_id, due_at: task.due_at, completed_at: now });
  if (logErr) throw logErr;

  return { rolledTo: null };
}

/** "Not now": suppress every escalation stage before `until`. */
export async function snoozeTask(
  admin: SupabaseClient,
  taskId: string,
  until: Date,
): Promise<void> {
  const { error } = await admin
    .from("tasks")
    .update({ snoozed_until: until.toISOString() })
    .eq("id", taskId);
  if (error) throw error;
}

/**
 * Move a task to tomorrow, keeping its wall-clock time. "Tomorrow" means tomorrow's date
 * in the user's timezone — not due_at + 1 day, which for a task three days overdue would
 * still land in the past.
 */
export async function moveToTomorrow(
  admin: SupabaseClient,
  task: TaskRow,
  tz: string,
  now = new Date(),
): Promise<string> {
  const today = partsInTz(now, tz);
  const keep = task.due_at ? partsInTz(new Date(task.due_at), tz) : null;
  // An all-day task has no meaningful clock time; a someday task gets a 9am default.
  const h = task.all_day ? 0 : (keep?.h ?? 9);
  const min = task.all_day ? 0 : (keep?.min ?? 0);

  const tomorrow = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  const next = zonedToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    h,
    min,
    tz,
  ).toISOString();

  const { error } = await admin
    .from("tasks")
    .update({ due_at: next, last_reminded_at: null, snoozed_until: null })
    .eq("id", task.id);
  if (error) throw error;
  return next;
}

/** "3:30 pm, 12 Oct" / "12 October" for an all-day task. */
export function describeDue(dueAt: string, allDay: boolean, tz: string): string {
  return allDay
    ? new Intl.DateTimeFormat("en-IN", { timeZone: tz, day: "numeric", month: "long" }).format(
        new Date(dueAt),
      )
    : new Intl.DateTimeFormat("en-IN", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      }).format(new Date(dueAt));
}

/** "in 15 minutes" / "2 hours ago", for the one-line context under a notification title. */
export function describeGap(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  const unit =
    mins < 60
      ? `${Math.max(1, mins)} minute${mins === 1 ? "" : "s"}`
      : abs < 86_400_000
        ? `${Math.round(abs / 3_600_000)} hour${Math.round(abs / 3_600_000) === 1 ? "" : "s"}`
        : `${Math.round(abs / 86_400_000)} day${Math.round(abs / 86_400_000) === 1 ? "" : "s"}`;
  return ms >= 0 ? `in ${unit}` : `${unit} ago`;
}
