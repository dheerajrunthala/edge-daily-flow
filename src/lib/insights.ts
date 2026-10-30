/**
 * Aggregation for the Insights page.
 *
 * Pure on purpose, and the page does no arithmetic of its own. Every figure on that page
 * has to survive being checked against the same query run straight against the database,
 * and the only way to pin that is a function that takes rows and returns the number — the
 * page used to multiply a scanned count by an invented 3 minutes per article, which no
 * query could have reproduced because no row said it.
 *
 * Everything buckets by `profiles.timezone`, never the browser's zone: a tool call at
 * 01:00 IST belongs to that IST day, and the two zones disagree about which day that is
 * for five and a half hours out of every twenty-four.
 */
import { addDaysKey, dayKey, fmt, fromKeys } from "./tz";

/**
 * The window every number on the page shares, stated in the page subtitle.
 *
 * One window for the whole page rather than per-card: a tile counting all time beside a
 * chart counting a month invites exactly the comparison that is wrong. It is also what
 * keeps each query bounded — an all-time count of news_items would eventually meet
 * PostgREST's row cap and start quietly under-reporting.
 */
export const INSIGHTS_DAYS = 30;

export type Day = { key: string; label: string };

/**
 * The days of the window, oldest first, as a `YYYY-MM-DD` key plus its axis label.
 *
 * Labels are formatted from noon rather than midnight: midnight is the instant a DST
 * change moves, and formatting it can name the previous day.
 */
export function windowDays(tz: string, days = INSIGHTS_DAYS, now: Date = new Date()): Day[] {
  const today = dayKey(now, tz);
  return Array.from({ length: days }, (_, i) => {
    const key = addDaysKey(today, i - (days - 1));
    return { key, label: fmt(fromKeys(key, "12:00", tz), tz, { day: "numeric", month: "short" }) };
  });
}

/**
 * The first instant of the window as an ISO timestamp — what each query sends as its
 * `created_at >=` bound, so the rows fetched and the days charted are the same window.
 */
export function windowStart(tz: string, days = INSIGHTS_DAYS, now: Date = new Date()): string {
  const first = windowDays(tz, days, now)[0] as Day;
  return fromKeys(first.key, "00:00", tz).toISOString();
}

// ----------------------------------------------------------------- the five front doors

/**
 * The surfaces an agent can act through, in the order the palette assigns colours.
 *
 * Pinned by a CHECK constraint on `mcp_tool_calls.surface`, and fixed here rather than
 * derived from the rows so a door keeps its colour on a day it made no calls. Colour
 * follows the door, never its rank in today's data.
 */
export const SURFACES = ["mcp", "chat", "voice", "telegram", "planner"] as const;
export type Surface = (typeof SURFACES)[number];

/** Where a surface this file has not heard of lands, rather than taking a colour slot. */
export const OTHER_SURFACE = "other";

export const SURFACE_LABELS: Record<string, string> = {
  mcp: "MCP client",
  chat: "Chat",
  voice: "Voice",
  telegram: "Telegram",
  planner: "Planner",
  [OTHER_SURFACE]: "Other",
};

function knownSurface(raw: string): string {
  return (SURFACES as readonly string[]).includes(raw) ? raw : OTHER_SURFACE;
}

export type ToolCallRow = { surface: string; ok: boolean; created_at: string };

/**
 * One day of the stacked chart: the axis label plus a count per active surface.
 *
 * The surfaces are an index signature because recharts reads its stacks off flat keys on
 * the row, and which keys exist depends on which doors this account has actually used.
 */
export interface SurfaceDay {
  day: string;
  [surface: string]: number | string;
}

export type SurfaceSeries = {
  /** One row per day of the window, zero-filled, oldest first — stacked bar input. */
  data: SurfaceDay[];
  /** Surfaces with at least one call, in SURFACES order: the legend, and the stack order. */
  active: string[];
  totals: Record<string, number>;
  total: number;
  failed: number;
};

/**
 * Tool calls per day, split by the surface that made them.
 *
 * Only surfaces with a call in the window get a stack and a legend row. A door nobody
 * opened is not a zero worth drawing — it is five legend rows of nothing, and it would
 * push the real two down to the fourth colour.
 */
export function surfaceSeries(rows: ToolCallRow[], days: Day[], tz: string): SurfaceSeries {
  const keys = new Set(days.map((d) => d.key));
  const perDay = new Map<string, Map<string, number>>();
  const totals: Record<string, number> = {};
  let failed = 0;

  for (const r of rows) {
    const key = dayKey(r.created_at, tz);
    // Dropped rather than counted: a row outside the charted days would show up in the
    // legend total with no bar under it, and the legend must not out-claim the chart.
    if (!keys.has(key)) continue;
    const surface = knownSurface(r.surface);
    if (!r.ok) failed += 1;
    totals[surface] = (totals[surface] ?? 0) + 1;
    const day = perDay.get(key) ?? new Map<string, number>();
    day.set(surface, (day.get(surface) ?? 0) + 1);
    perDay.set(key, day);
  }

  const active = [...SURFACES, OTHER_SURFACE].filter((s) => (totals[s] ?? 0) > 0);
  const data = days.map((d) => {
    const counts = perDay.get(d.key);
    const row: SurfaceDay = { day: d.label };
    for (const s of active) row[s] = counts?.get(s) ?? 0;
    return row;
  });

  const total = active.reduce((s, k) => s + (totals[k] ?? 0), 0);
  return { data, active, totals, total, failed };
}

// ----------------------------------------------------------------- model spend

/** The `ai_events.kind` values, pinned by a CHECK constraint on the table. */
export const AI_KINDS = [
  "task_parse",
  "digest",
  "summary",
  "embedding",
  "brief",
  "agent",
  "plan",
] as const;

export const AI_KIND_LABELS: Record<string, string> = {
  task_parse: "Task parsing",
  digest: "Digest ranking",
  summary: "Article summaries",
  embedding: "Embeddings",
  brief: "Spoken brief",
  agent: "Assistant",
  plan: "Day plan",
};

export type AiEventRow = {
  kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
};

export type KindSpend = {
  kind: string;
  label: string;
  calls: number;
  input: number;
  output: number;
  total: number;
};

/**
 * Tokens by what the model was asked to do, biggest spender first.
 *
 * `input_tokens` and `output_tokens` are both nullable — a call whose provider response
 * carried no usage block is logged anyway, because the fact that it happened is the point
 * of the row. Such a call counts in `calls` and adds nothing to the sums, which is the
 * honest reading: one model call, token count unknown. Treating null as zero in `calls`
 * too would hide the call entirely.
 *
 * `user_id` is nullable on this table — ingest-news summarises the shared article pool and
 * no user owns that work — but a browser never sees those rows: the select policy is
 * `user_id = auth.uid()`, and NULL is not equal to anything. So this is every model call
 * made *for this account*, not every model call the project made.
 */
export function kindSpend(rows: AiEventRow[], days: Day[], tz: string): KindSpend[] {
  const keys = new Set(days.map((d) => d.key));
  const byKind = new Map<string, KindSpend>();

  for (const r of rows) {
    if (!keys.has(dayKey(r.created_at, tz))) continue;
    const kind = r.kind;
    const row =
      byKind.get(kind) ??
      ({
        kind,
        label: AI_KIND_LABELS[kind] ?? kind,
        calls: 0,
        input: 0,
        output: 0,
        total: 0,
      } satisfies KindSpend);
    row.calls += 1;
    row.input += r.input_tokens ?? 0;
    row.output += r.output_tokens ?? 0;
    row.total = row.input + row.output;
    byKind.set(kind, row);
  }

  return [...byKind.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ----------------------------------------------------------------- tasks by creation path

/** The ways a task can come into being, pinned by a CHECK constraint on `tasks.source`. */
export const TASK_SOURCES = ["manual", "ai", "mcp", "telegram", "agent"] as const;

export const TASK_SOURCE_LABELS: Record<string, string> = {
  manual: "Typed by hand",
  ai: "Quick Add, AI-parsed",
  mcp: "MCP client",
  telegram: "Telegram",
  agent: "Assistant",
};

export type SourceCount = { source: string; label: string; count: number };

/**
 * Tasks by how they were created, in the fixed `TASK_SOURCES` order.
 *
 * Every path is listed, including the ones at zero: the point of this chart is the set of
 * doors that exist, so a door nobody used is information rather than clutter. This is the
 * opposite call from `surfaceSeries` because a bar at zero costs one row, while an empty
 * stack costs a colour slot and a legend entry on every day of the chart.
 */
export function tasksBySource(
  rows: { source: string; created_at: string }[],
  days: Day[],
  tz: string,
): SourceCount[] {
  const keys = new Set(days.map((d) => d.key));
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!keys.has(dayKey(r.created_at, tz))) continue;
    counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  }
  const known = TASK_SOURCES.map((source) => ({
    source,
    label: TASK_SOURCE_LABELS[source] ?? source,
    count: counts.get(source) ?? 0,
  }));
  // A source added to the CHECK constraint but not to this file still shows up, rather
  // than being silently dropped from a chart whose whole claim is that it is complete.
  const extra = [...counts.keys()]
    .filter((s) => !(TASK_SOURCES as readonly string[]).includes(s))
    .sort()
    .map((source) => ({ source, label: source, count: counts.get(source) ?? 0 }));
  return [...known, ...extra];
}

// ----------------------------------------------------------------- the simple counts

/** Completions per day of the window, zero-filled — the bar chart that was already here. */
export function completionsByDay(
  rows: { completed_at: string }[],
  days: Day[],
  tz: string,
): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = dayKey(r.completed_at, tz);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return days.map((d) => ({ day: d.label, count: counts.get(d.key) ?? 0 }));
}

/** Completions that fall inside the window, for the rate — which is over the same days. */
export function inWindow<T>(rows: T[], at: (row: T) => string, days: Day[], tz: string): T[] {
  const keys = new Set(days.map((d) => d.key));
  return rows.filter((r) => keys.has(dayKey(at(r), tz)));
}

/**
 * Articles the pipeline read to build the briefs in the window.
 *
 * `digests.sources_scanned` is written by build-digests as the size of the candidate pool
 * it ranked, so this is a sum of rows and not an estimate. Dates are compared as keys:
 * `digest_date` is a `date`, already the user's day, and parsing it into a Date would
 * re-introduce a zone it never had.
 */
export function scannedArticles(
  digests: { digest_date: string; sources_scanned: number }[],
  days: Day[],
): number {
  const keys = new Set(days.map((d) => d.key));
  return digests
    .filter((d) => keys.has(d.digest_date))
    .reduce((sum, d) => sum + d.sources_scanned, 0);
}

/** `opened` as a percentage of `delivered`, or null when nothing was delivered. */
export function readShare(opened: number, delivered: number): number | null {
  if (delivered <= 0) return null;
  return Math.round((opened / delivered) * 100);
}

/** 1,689 — the page's one number format, so no card invents its own. */
export function num(n: number): string {
  return n.toLocaleString("en-IN");
}
