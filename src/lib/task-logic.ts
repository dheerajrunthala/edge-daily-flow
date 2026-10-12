import type { Tables } from "@/integrations/supabase/types";
import { addDaysKey, dayKey, partsInTz, zonedToUtc } from "./tz";

export type Task = Tables<"tasks">;
export type Recurrence = Task["recurrence"];

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
    const lastDay = new Date(Date.UTC(norm.getUTCFullYear(), norm.getUTCMonth() + 1, 0)).getUTCDate();
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

export type Group = "overdue" | "today" | "upcoming" | "someday";

export function taskGroup(task: Pick<Task, "due_at" | "all_day">, tz: string, now = new Date()): Group {
  if (!task.due_at) return "someday";
  const today = dayKey(now, tz);
  const k = dayKey(task.due_at, tz);
  if (k < today) return "overdue";
  if (k > today) return "upcoming";
  if (!task.all_day && new Date(task.due_at) < now) return "overdue";
  return "today";
}

/** True when a task's due date falls within the next `days` days (inclusive of today). */
export function withinNextDays(dueAt: string | null, days: number, tz: string, now = new Date()) {
  if (!dueAt) return false;
  const k = dayKey(dueAt, tz);
  const today = dayKey(now, tz);
  return k >= today && k <= addDaysKey(today, days);
}

export const REMIND_OPTIONS = [
  { label: "None", value: "" },
  { label: "15 min before", value: "00:15:00" },
  { label: "1 hour before", value: "01:00:00" },
  { label: "1 day before", value: "1 day" },
  { label: "3 days before", value: "3 days" },
] as const;

export function normalizeInterval(v: string | null): string {
  if (!v) return "";
  if (v === "00:15:00") return "00:15:00";
  if (v === "01:00:00") return "01:00:00";
  if (/^1 day/.test(v)) return "1 day";
  if (/^3 days/.test(v)) return "3 days";
  return v;
}

/** On-time rate: share of completions done on or before their due time. */
export function onTimeRate(rows: { due_at: string | null; completed_at: string | null }[]) {
  const withDue = rows.filter((r) => r.due_at && r.completed_at);
  if (!withDue.length) return null;
  const ok = withDue.filter((r) => new Date(r.completed_at!) <= new Date(r.due_at!)).length;
  return Math.round((ok / withDue.length) * 100);
}
