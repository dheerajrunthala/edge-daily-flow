// The parts of a tool call that must not differ between front doors.
//
// Daily Edge now answers to four callers that all mutate the same rows: the MCP server
// (Claude Code, Claude Desktop, ChatGPT), the chat agent in the web app, the Telegram
// bot, and the morning planner running on cron with nobody watching. Each needs its own
// *interface* — the MCP SDK wants zod schemas, Gemini wants OpenAPI function
// declarations — but they must not each get their own idea of what "tomorrow 9am" means
// or which rows a caller may touch.
//
// So the interfaces stay separate and everything underneath them lives here: the
// ownership guard, every value coercion, the task shape, and tag creation. This is the
// same lesson CLAUDE.md records about src/lib/tz.ts and _shared/time.ts drifting — that
// one cost a production bug where completing a birthday from Telegram threw a
// RangeError. Two copies of parseInstant would cost something similar and quieter: one
// door silently booking 2:30pm for an Asia/Kolkata user who said 9am.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { describeDue, taskGroup, type TaskRow } from "./tasks.ts";
import { dayKey, isValidTimezone, partsInTz, zonedToUtc } from "./time.ts";

export const DEFAULT_TZ = "Asia/Kolkata";
export const DEFAULT_MORNING = "09:00";
/** Matches the palette the web app's tag colour picker offers (queries.ts TAG_COLORS). */
export const TAG_COLORS = [
  "slate",
  "blue",
  "green",
  "amber",
  "rose",
  "violet",
  "cyan",
  "orange",
] as const;
export const CATEGORIES = [
  "AI",
  "Software Development",
  "Indian Stock Market",
  "Indian Startups & Tech",
  "Global Tech",
  "Policy & Regulation",
] as const;
/** Birthdays are called out this far ahead, matching send-briefs. */
export const BIRTHDAY_HORIZON_DAYS = 7;

/**
 * Who the call is for, and the handful of their settings every tool needs.
 *
 * Deliberately carries no credential. The MCP server extends this with the API token it
 * authenticated, the chat agent resolves the same shape from a session JWT, and the
 * planner builds it from a user id on a cron tick — none of which a tool body should be
 * able to tell apart, because a tool that can tell would eventually behave differently.
 */
export type Ctx = {
  admin: SupabaseClient;
  userId: string;
  tz: string;
  morningTime: string;
  appUrl: string;
};

// ----------------------------------------------------------------- the ownership guard

/**
 * A read, already scoped to the caller. Using this instead of `admin.from(...)` is what
 * makes forgetting the guard require actively going around it rather than merely
 * forgetting a line.
 *
 * It matters more than RLS here: every one of these callers runs on the service role,
 * which bypasses RLS entirely, so this line is the only thing between two accounts.
 */
export function mine(ctx: Ctx, table: string, columns: string) {
  return ctx.admin.from(table).select(columns).eq("user_id", ctx.userId);
}

/**
 * One of the caller's rows by id, or null. The `.eq("user_id")` is the whole point: an id
 * belonging to another account must read as "not found", never as a row.
 */
export async function myRow<T>(
  ctx: Ctx,
  table: string,
  columns: string,
  id: string,
): Promise<T | null> {
  const { data, error } = await mine(ctx, table, columns).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as T) ?? null;
}

// ----------------------------------------------------------------- value coercion

/**
 * An ISO 8601 instant, which the client is told to send with the user's own UTC offset.
 *
 * A bare "2026-10-13T09:00:00" is rejected rather than assumed: Date would read it as
 * local-to-the-server (UTC on this platform), which for an Asia/Kolkata user silently
 * books 2:30pm. Being strict here is the difference between a reminder at the right hour
 * and a reminder the user quietly stops trusting.
 */
export function parseInstant(value: string, field: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
  if (!hasZone) {
    throw new Error(
      `${field} must be ISO 8601 including the UTC offset, e.g. "2026-10-13T09:00:00+05:30". ` +
        `Got "${value}", which has no offset — call get_context for the user's current offset rather than guessing.`,
    );
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new Error(`${field} is not a valid ISO 8601 datetime: "${value}"`);
  return d;
}

/**
 * "15 minutes" / "1 hour" / "2 days" / "01:00:00" to Postgres interval text.
 *
 * Normalised to the exact strings REMIND_OPTIONS uses in the web app where they match, so
 * a task created from an editor shows "1 hour before" in the task form's dropdown instead
 * of falling through to a raw interval the UI has no label for.
 */
export function parseRemindBefore(value: string): string {
  const v = value.trim().toLowerCase();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) return v.length === 5 ? `${v}:00` : v;

  const m = /^(\d{1,3})\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$/.exec(v);
  if (!m) {
    throw new Error(
      `remind_before must look like "15 minutes", "1 hour", "1 day" or "HH:MM:SS". Got "${value}".`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2];
  const minutes = /^(m|min|mins|minute|minutes)$/.test(unit)
    ? n
    : /^(h|hr|hrs|hour|hours)$/.test(unit)
      ? n * 60
      : /^(d|day|days)$/.test(unit)
        ? n * 1440
        : n * 10080;

  if (minutes < 1) throw new Error("remind_before must be at least 1 minute.");
  // 30 days of lead time is already absurd for a reminder; beyond that it is a typo.
  if (minutes > 43_200) throw new Error("remind_before cannot be more than 30 days.");

  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  const h = Math.floor(minutes / 60);
  return `${String(h).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
}

/**
 * An all-day task's due_at must be local midnight — the escalation ladder reads it to
 * decide that an all-day task gets a lead reminder and nothing else, and a birthday with
 * a 09:00 due_at would otherwise nag from 9am (see the Notifications notes in CLAUDE.md).
 * So a time-of-day on an all_day task is snapped rather than refused: the client's intent
 * is clear, and the normalisation belongs server-side where the invariant lives.
 */
export function snapToLocalMidnight(instant: Date, tz: string): Date {
  const p = partsInTz(instant, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}

/** "YYYY-MM-DD" as the user's own calendar reads it. */
export function parseDate(value: string | undefined, tz: string, now: Date): string {
  if (!value) return dayKey(now, tz);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`date must be "YYYY-MM-DD". Got "${value}".`);
  }
  return value;
}

/**
 * Strip the characters that are *syntax* in a PostgREST `or=(...)` filter. Left in, a
 * search for "fix(auth), part 2" would not merely fail to match — it would be parsed as
 * extra filter clauses.
 */
export function sanitizeSearch(term: string): string {
  return term.replace(/[,()\\%_]/g, " ").trim();
}

// ----------------------------------------------------------------- shaping rows

export type TaskOut = Record<string, unknown>;

export function shapeTask(
  task: TaskRow & { tags?: string[] | null; source?: string },
  ctx: Ctx,
): TaskOut {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    group: taskGroup(task, ctx.tz),
    due_at: task.due_at,
    // The client already knows the timezone, but rendering it here means a reply can
    // confirm "tomorrow 9:00 AM" without the model doing offset arithmetic to say so.
    due_label: task.due_at ? describeDue(task.due_at, task.all_day, ctx.tz) : "someday",
    all_day: task.all_day,
    recurrence: task.recurrence,
    priority: task.priority,
    tags: task.tags ?? [],
    remind_before: task.remind_before,
    reminders_on: !!task.remind_before,
    snoozed_until: task.snoozed_until,
    last_reminded_at: task.last_reminded_at,
    source: task.source,
    created_at: task.created_at,
    app_url: `${ctx.appUrl}/tasks`,
  };
}

// ----------------------------------------------------------------- tags

/**
 * Make sure every tag name on a task exists as a real `tags` row.
 *
 * tasks.tags is a text[] of names with no foreign key, so an unknown name is not an
 * error — it simply renders uncoloured and, worse, never appears in the /tasks tag
 * filter. Creating the row is what makes a tag an agent invented usable in the app
 * afterwards. Returns the canonical names, matching existing tags case-insensitively so
 * "coding" folds into "Coding" instead of forking it.
 */
export async function ensureTags(ctx: Ctx, names: string[]): Promise<string[]> {
  const cleaned = [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((n) =>
    n.slice(0, 32),
  );
  if (cleaned.length === 0) return [];

  const { data: existing, error } = await mine(ctx, "tags", "id, name, color");
  if (error) throw error;
  const byLower = new Map(
    (existing ?? []).map((t: { name: string }) => [t.name.toLowerCase(), t.name]),
  );

  const canonical: string[] = [];
  const toCreate: string[] = [];
  for (const name of cleaned) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) {
      canonical.push(hit);
    } else {
      canonical.push(name);
      toCreate.push(name);
      byLower.set(name.toLowerCase(), name);
    }
  }

  if (toCreate.length > 0) {
    const { error: insErr } = await ctx.admin.from("tags").insert(
      toCreate.map((name, i) => ({
        user_id: ctx.userId,
        name,
        color: TAG_COLORS[((existing?.length ?? 0) + i) % TAG_COLORS.length],
      })),
    );
    // A duplicate here means a concurrent call created the same tag; the name is what
    // matters and it now exists either way.
    if (insErr && insErr.code !== "23505") throw insErr;
  }
  return [...new Set(canonical)];
}

// ----------------------------------------------------------------- context

/**
 * The caller's settings, from a user id alone.
 *
 * Takes the id rather than a credential so the MCP server, the chat agent and the cron
 * planner all load context the same way. Whatever authenticated the request has already
 * done its job by this point.
 */
export async function loadUserCtx(admin: SupabaseClient, userId: string): Promise<Ctx> {
  const [profileRes, prefsRes] = await Promise.all([
    admin.from("profiles").select("timezone").eq("id", userId).maybeSingle(),
    admin.from("notification_prefs").select("morning_time").eq("user_id", userId).maybeSingle(),
  ]);

  const raw = profileRes.data?.timezone;
  return {
    admin,
    userId,
    tz: raw && isValidTimezone(raw) ? raw : DEFAULT_TZ,
    morningTime: (prefsRes.data?.morning_time ?? DEFAULT_MORNING).slice(0, 5),
    appUrl: (Deno.env.get("APP_URL") ?? "https://dailyedgeapp.lovable.app").replace(/\/+$/, ""),
  };
}
