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
 * "5 days overdue" to "4 days overdue" and need completing five times to catch up.
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
  // Daily tasks can be years behind; cap the walk so a bad row can't spin forever.
  for (let i = 0; i < 400; i++) {
    const ahead = allDay ? dayKey(next!, tz) > today : new Date(next!) > now;
    if (ahead) break;
    const step = nextOccurrence(next!, recurrence, tz);
    if (!step) break;
    next = step;
  }
  return next;
}

export type Group = "overdue" | "today" | "upcoming" | "someday";

/**
 * What the Tasks page groups by. "done" is a status rather than a time, but it reads as
 * a fifth bucket: a completed task that was due last Tuesday belongs under Done, not
 * under Overdue, where it would make the overdue count a lie.
 */
export type DisplayGroup = Group | "done";

export function displayGroup(task: Task, tz: string, now = new Date()): DisplayGroup {
  return task.status === "done" ? "done" : taskGroup(task, tz, now);
}

export function taskGroup(
  task: Pick<Task, "due_at" | "all_day">,
  tz: string,
  now = new Date(),
): Group {
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

// ---------- Sorting, searching and provenance (Tasks page) ----------

export const SORTS = [
  { key: "due", label: "Due date" },
  { key: "priority", label: "Priority" },
  { key: "created", label: "Recently created" },
  { key: "updated", label: "Recently updated" },
  { key: "alpha", label: "A–Z" },
] as const;

export type SortKey = (typeof SORTS)[number]["key"];

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Sort within a group, not across them — the grouping (Overdue / Today / …) is the
 * primary order on this page and a sort that reshuffled groups would be a different
 * feature. Every comparator falls back to due date and then to title, so the order is
 * total: two tasks of the same priority must not swap places between renders.
 */
export function sortTasks(tasks: Task[], sort: SortKey): Task[] {
  const byDue = (a: Task, b: Task) => {
    // Someday last, whichever direction we are sorting the dated ones.
    if (!a.due_at && !b.due_at) return 0;
    if (!a.due_at) return 1;
    if (!b.due_at) return -1;
    return a.due_at.localeCompare(b.due_at);
  };
  const byTitle = (a: Task, b: Task) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  const cmp: Record<SortKey, (a: Task, b: Task) => number> = {
    due: (a, b) => byDue(a, b) || byTitle(a, b),
    priority: (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
      byDue(a, b) ||
      byTitle(a, b),
    created: (a, b) => b.created_at.localeCompare(a.created_at) || byTitle(a, b),
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at) || byTitle(a, b),
    alpha: (a, b) => byTitle(a, b) || byDue(a, b),
  };
  return [...tasks].sort(cmp[sort]);
}

export const TASK_SOURCES = [
  { key: "manual", label: "Manual" },
  { key: "ai", label: "AI" },
  { key: "mcp", label: "MCP" },
  { key: "telegram", label: "Telegram" },
] as const;

export type TaskSource = (typeof TASK_SOURCES)[number]["key"];

/**
 * Instant client-side search. Everything is already in memory — the whole task list is
 * one query — so this is a filter, not a round trip, and it matches notes and tags as
 * well as titles because "that thing about the auth repo" is in the notes.
 */
export function matchesSearch(task: Task, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return (
    task.title.toLowerCase().includes(needle) ||
    (task.notes ?? "").toLowerCase().includes(needle) ||
    task.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

/**
 * The one line of a task's notes worth showing in a list row.
 *
 * MCP-created tasks carry structured context the client wrote for a reader who no longer
 * has the conversation in front of them: the repo, the branch, a PR link and a "Next:"
 * step. "Next:" is the line you actually want at a glance, so it wins; otherwise the
 * first labelled line does. Freeform notes get nothing — a row is not the place to start
 * rendering prose.
 */
const CONTEXT_LABELS = /^(next|project|repo|repository|branch|pr|path|paths|file|files)\s*:/i;

export function repoContextLine(notes: string | null): string | null {
  if (!notes) return null;
  const lines = notes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => CONTEXT_LABELS.test(l));
  if (!lines.length) return null;
  const next = lines.find((l) => /^next\s*:/i.test(l));
  return next ?? lines[0] ?? null;
}
