// The thirteen tools, their schemas, and the ownership guard.
//
// Two rules hold this file together:
//
// 1. **No parsing.** Parameters arrive structured and validated; nothing here interprets
//    English, calls Gemini, or guesses a date. If a value is ambiguous the tool rejects it
//    with a message telling the client what to send instead — a loud error the model can
//    act on beats a silent wrong guess that lands in someone's calendar.
//
// 2. **Every query is scoped to the authenticated user.** These run with the service role,
//    which bypasses RLS, so the token's user_id is the *only* thing standing between two
//    accounts. That guard is therefore not left to each handler to remember: reads go
//    through mine(), writes through myRow(), and both pin user_id before the caller can
//    add a filter.

import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@3.25.76";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { checkRateLimit, logToolCall, type ApiToken } from "../_shared/api-tokens.ts";
import {
  TASK_COLUMNS,
  completeTask,
  describeDue,
  snoozeTask,
  taskGroup,
  type TaskGroup,
  type TaskRow,
} from "../_shared/tasks.ts";
import {
  dayKey,
  isValidTimezone,
  offsetLabel,
  partsInTz,
  startOfDayUtc,
  weekdayName,
  zonedToUtc,
} from "../_shared/time.ts";

const DEFAULT_TZ = "Asia/Kolkata";
const DEFAULT_MORNING = "09:00";
/** Matches the palette the web app's tag colour picker offers (queries.ts TAG_COLORS). */
const TAG_COLORS = ["slate", "blue", "green", "amber", "rose", "violet", "cyan", "orange"] as const;
const CATEGORIES = [
  "AI",
  "Software Development",
  "Indian Stock Market",
  "Indian Startups & Tech",
  "Global Tech",
  "Policy & Regulation",
] as const;
/** Birthdays are called out this far ahead, matching send-briefs. */
const BIRTHDAY_HORIZON_DAYS = 7;

export type Ctx = {
  admin: SupabaseClient;
  token: ApiToken;
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
 */
function mine(ctx: Ctx, table: string, columns: string) {
  return ctx.admin.from(table).select(columns).eq("user_id", ctx.userId);
}

/**
 * One of the caller's rows by id, or null. The `.eq("user_id")` is the whole point: an id
 * belonging to another account must read as "not found", never as a row.
 */
async function myRow<T>(ctx: Ctx, table: string, columns: string, id: string): Promise<T | null> {
  const { data, error } = await mine(ctx, table, columns).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as T) ?? null;
}

/** The task, or a clear error. Separate so every task tool fails identically. */
async function myTask(ctx: Ctx, id: string): Promise<TaskRow> {
  const task = await myRow<TaskRow>(ctx, "tasks", TASK_COLUMNS, id);
  if (!task) {
    throw new Error(
      `No task with id ${id} in this account. Use list_tasks to find the right id — ids from a different account or an already-deleted task will not resolve.`,
    );
  }
  return task;
}

// ----------------------------------------------------------------- result shaping

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Tool results are JSON in a text block: unambiguous ids, and the client does the prose. */
function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * The slice of the SDK's tool config these tools use. Spelled out rather than left loose
 * so a mistyped annotation name is a mistake here and not a hint the client silently
 * never receives.
 */
type ToolConfig = {
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/**
 * Register a tool with the rate limit and the call log wrapped around it.
 *
 * Doing both here rather than in the HTTP layer means `initialize` and `tools/list` cost
 * nothing — a client reconnecting should not spend the user's quota — and that the log
 * records the tool name, which is the only part worth auditing later.
 *
 * `args` arrives as `unknown` and is asserted to the handler's own parameter type. That
 * is not a hole: the SDK validates arguments against `inputSchema` and fails the call
 * before a handler is ever reached, which is what the rejected-enum test exercises. The
 * assertion only recovers the type that passing the schema through this wrapper erases.
 */
function register<Args>(
  server: McpServer,
  ctx: Ctx,
  name: string,
  config: ToolConfig,
  handler: (args: Args) => Promise<ToolResult>,
): void {
  server.registerTool(name, config, async (args: unknown) => {
    const started = Date.now();
    await checkRateLimit(ctx.admin, ctx.token.tokenId);
    try {
      const result = await handler((args ?? {}) as Args);
      await logToolCall(ctx.admin, {
        userId: ctx.userId,
        tokenId: ctx.token.tokenId,
        tool: name,
        ok: true,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logToolCall(ctx.admin, {
        userId: ctx.userId,
        tokenId: ctx.token.tokenId,
        tool: name,
        ok: false,
        error: message,
        durationMs: Date.now() - started,
      });
      throw err;
    }
  });
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
function parseInstant(value: string, field: string): Date {
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
function parseRemindBefore(value: string): string {
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
function snapToLocalMidnight(instant: Date, tz: string): Date {
  const p = partsInTz(instant, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}

/** "YYYY-MM-DD" as the user's own calendar reads it. */
function parseDate(value: string | undefined, tz: string, now: Date): string {
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
function sanitizeSearch(term: string): string {
  return term.replace(/[,()\\%_]/g, " ").trim();
}

// ----------------------------------------------------------------- shaping rows

type TaskOut = Record<string, unknown>;

function shapeTask(task: TaskRow & { tags?: string[] | null; source?: string }, ctx: Ctx): TaskOut {
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
async function ensureTags(ctx: Ctx, names: string[]): Promise<string[]> {
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

// ----------------------------------------------------------------- registration

export function registerTools(server: McpServer, ctx: Ctx): void {
  // ------------------------------------------------------------- get_context

  register(
    server,
    ctx,
    "get_context",
    {
      title: "Get user context",
      description:
        "The user's name, timezone, current local date and time, UTC offset, preferred morning time, " +
        "existing tags with their colours, and which notification channels are on. " +
        "Call this BEFORE creating or rescheduling anything: it is how you resolve 'tomorrow morning' " +
        "or 'next Friday' against the user's own clock, and how you reuse their existing tags instead " +
        "of inventing near-duplicates.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const now = new Date();
      const [profileRes, prefsRes, tagsRes, newsRes] = await Promise.all([
        ctx.admin
          .from("profiles")
          .select("full_name, timezone, news_profile")
          .eq("id", ctx.userId)
          .maybeSingle(),
        mine(
          ctx,
          "notification_prefs",
          "channels, quiet_start, quiet_end, nag_interval, morning_time",
        ).maybeSingle(),
        mine(ctx, "tags", "name, color").order("created_at"),
        mine(ctx, "news_prefs", "categories, headline_count, enabled").maybeSingle(),
      ]);
      if (tagsRes.error) throw tagsRes.error;

      const p = partsInTz(now, ctx.tz);
      const pad = (n: number) => String(n).padStart(2, "0");
      const local = `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}:${pad(p.s)}`;
      const offset = offsetLabel(now, ctx.tz);
      const quietStart = (prefsRes.data?.quiet_start ?? "22:00:00").slice(0, 5);
      const quietEnd = (prefsRes.data?.quiet_end ?? "07:00:00").slice(0, 5);

      return ok({
        user: {
          name: profileRes.data?.full_name ?? null,
          timezone: ctx.tz,
          utc_offset: offset,
          local_datetime: `${local}${offset}`,
          local_date: dayKey(now, ctx.tz),
          weekday: weekdayName(now, ctx.tz),
          morning_time: ctx.morningTime,
          about: profileRes.data?.news_profile ?? null,
        },
        time_of_day_defaults: {
          note: "Use these when the user says a vague time, unless they name an actual hour.",
          morning: ctx.morningTime,
          afternoon: "14:00",
          evening: "19:00",
          tonight: "21:00",
        },
        tags: (tagsRes.data ?? []).map((t: { name: string; color: string }) => ({
          name: t.name,
          color: t.color,
        })),
        tag_colors_available: TAG_COLORS,
        notifications: {
          channels_enabled: prefsRes.data?.channels ?? ["email"],
          quiet_hours: quietStart === quietEnd ? "off" : `${quietStart}–${quietEnd} local`,
          nag_interval: prefsRes.data?.nag_interval ?? "00:15:00",
          note:
            "Quiet hours are enforced server-side on every channel, so you do not need to avoid " +
            "setting a due time inside them.",
        },
        news: {
          categories_followed: newsRes.data?.categories ?? [],
          digest_enabled: newsRes.data?.enabled ?? false,
          all_categories: CATEGORIES,
        },
        app_url: ctx.appUrl,
      });
    },
  );

  // ------------------------------------------------------------- list_tasks

  register(
    server,
    ctx,
    "list_tasks",
    {
      title: "List tasks",
      description:
        "List the user's tasks. Use this to find a task's id before completing, updating or deleting " +
        "one the user referred to by description — and if more than one result plausibly matches what " +
        "they said, ask them which before acting. Filters: 'today', 'overdue', 'upcoming', 'someday' " +
        "(no due date) and 'done'; omitting the filter returns all open tasks. The groupings match the " +
        "app's own, so 'overdue' excludes an all-day task due today and includes a timed one whose hour " +
        "has passed.",
      inputSchema: {
        filter: z
          .enum(["today", "overdue", "upcoming", "someday", "done"])
          .optional()
          .describe("Which set to return. Omit for all open (not-done) tasks."),
        tag: z
          .string()
          .optional()
          .describe("Only tasks carrying this tag name (exact, case-sensitive)."),
        search: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on title and notes."),
        limit: z.number().int().min(1).max(100).optional().describe("Max results, default 50."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: {
      filter?: TaskGroup | "done";
      tag?: string;
      search?: string;
      limit?: number;
    }) => {
      const limit = args.limit ?? 50;
      const now = new Date();

      let query = mine(ctx, "tasks", `${TASK_COLUMNS}, tags, source`);
      query =
        args.filter === "done"
          ? query.eq("status", "done").order("completed_at", { ascending: false })
          : query
              .eq("status", "todo")
              .order("due_at", { ascending: true, nullsFirst: false })
              .order("created_at", { ascending: false });

      if (args.tag) query = query.contains("tags", [args.tag]);
      if (args.search) {
        const term = sanitizeSearch(args.search);
        if (term) query = query.or(`title.ilike.%${term}%,notes.ilike.%${term}%`);
      }

      // The four open groups are day-key comparisons in the user's timezone, not a
      // due_at range, so they are applied after the fetch (see taskGroup). The row cap is
      // raised accordingly: filtering first and limiting second is the only order that
      // returns a full page of "overdue".
      const { data, error } = await query.limit(
        args.filter && args.filter !== "done" ? 500 : limit,
      );
      if (error) throw error;

      let rows = (data ?? []) as (TaskRow & { tags: string[]; source: string })[];
      if (args.filter && args.filter !== "done") {
        rows = rows.filter((t) => taskGroup(t, ctx.tz, now) === args.filter).slice(0, limit);
      }

      return ok({
        filter: args.filter ?? "open",
        count: rows.length,
        timezone: ctx.tz,
        tasks: rows.map((t) => shapeTask(t, ctx)),
      });
    },
  );

  // ------------------------------------------------------------- get_task

  register(
    server,
    ctx,
    "get_task",
    {
      title: "Get one task",
      description:
        "Full detail for one task by id, including its notes and, for a recurring task, its recent " +
        "completion history.",
      inputSchema: { id: z.string().uuid().describe("The task id, from list_tasks.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { id: string }) => {
      const task = await myTask(ctx, args.id);
      const { data: withTags } = await mine(ctx, "tasks", "tags, source")
        .eq("id", args.id)
        .maybeSingle();
      const shaped = shapeTask(
        { ...task, tags: withTags?.tags ?? [], source: withTags?.source },
        ctx,
      );

      if (task.recurrence !== "none") {
        const { data: completions } = await mine(ctx, "task_completions", "due_at, completed_at")
          .eq("task_id", args.id)
          .order("completed_at", { ascending: false })
          .limit(5);
        shaped.recent_completions = completions ?? [];
      }
      return ok(shaped);
    },
  );

  // ------------------------------------------------------------- create_task

  register(
    server,
    ctx,
    "create_task",
    {
      title: "Create a task",
      description:
        "Create a task in the user's account. Resolve relative dates yourself from get_context and send " +
        "due_at as ISO 8601 with their UTC offset. Set remind_before whenever the user asks to be " +
        "reminded — without it the task is a dated list entry that never notifies. Put the retrievable " +
        "context in notes (repo, branch, file paths, PR link, and a 'Next: ...' line), because the user " +
        "will read it later with none of this conversation in front of them. Tag names that do not exist " +
        "yet are created, so spell them as the user would.",
      inputSchema: {
        title: z.string().min(1).max(300).describe("Short and imperative. Detail goes in notes."),
        notes: z
          .string()
          .max(5000)
          .optional()
          .describe(
            "Context for later: repo and branch, file paths, PR/issue URL, the error, and a one-line 'Next: ...'.",
          ),
        due_at: z
          .string()
          .optional()
          .describe(
            'ISO 8601 WITH the user\'s UTC offset, e.g. "2026-10-13T09:00:00+05:30". Omit for a "someday" task with no date.',
          ),
        all_day: z
          .boolean()
          .optional()
          .describe(
            "True for a date without a time (birthdays, deadlines). The time is snapped to local midnight.",
          ),
        recurrence: z
          .enum(["none", "daily", "weekly", "monthly", "yearly"])
          .optional()
          .describe(
            "Repeat cadence; requires due_at. Default none. A birthday is yearly + all_day + the 'Birthday' tag.",
          ),
        priority: z.enum(["low", "medium", "high"]).optional().describe("Default medium."),
        tags: z
          .array(z.string().min(1).max(32))
          .max(10)
          .optional()
          .describe(
            "Tag names. Reuse the ones from get_context where they fit; new names are created.",
          ),
        remind_before: z
          .string()
          .optional()
          .describe(
            'How far ahead to start reminding, e.g. "15 minutes", "1 hour", "1 day". Requires due_at.',
          ),
        project: z
          .string()
          .max(80)
          .optional()
          .describe(
            "Repo or project name for coding work. Adds the 'Coding' tag plus a tag for the project, and records it in notes.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args: {
      title: string;
      notes?: string;
      due_at?: string;
      all_day?: boolean;
      recurrence?: string;
      priority?: string;
      tags?: string[];
      remind_before?: string;
      project?: string;
    }) => {
      const allDay = args.all_day ?? false;
      let dueAt: string | null = null;
      if (args.due_at) {
        const instant = parseInstant(args.due_at, "due_at");
        dueAt = (allDay ? snapToLocalMidnight(instant, ctx.tz) : instant).toISOString();
      }

      const recurrence = args.recurrence ?? "none";
      if (recurrence !== "none" && !dueAt) {
        throw new Error(
          `A ${recurrence} task needs a due_at to recur from — there is no first occurrence to step forward otherwise.`,
        );
      }
      const remindBefore = args.remind_before ? parseRemindBefore(args.remind_before) : null;
      if (remindBefore && !dueAt) {
        throw new Error(
          "remind_before needs a due_at: a reminder is scheduled relative to the due time, so a task with no date cannot have one.",
        );
      }

      // `project` is a convenience for the common case: it carries the two things that
      // make a coding task findable later — the "Coding" tag and the repo name — without
      // the client having to remember both conventions.
      const tagNames = [...(args.tags ?? [])];
      let notes = args.notes ?? null;
      if (args.project) {
        const project = args.project.trim();
        if (project) {
          if (!tagNames.some((t) => t.toLowerCase() === "coding")) tagNames.push("Coding");
          if (!tagNames.some((t) => t.toLowerCase() === project.toLowerCase()))
            tagNames.push(project);
          notes = notes ? `Project: ${project}\n${notes}` : `Project: ${project}`;
        }
      }
      const tags = await ensureTags(ctx, tagNames);

      const { data, error } = await ctx.admin
        .from("tasks")
        .insert({
          user_id: ctx.userId,
          title: args.title.trim(),
          notes,
          due_at: dueAt,
          all_day: allDay,
          recurrence,
          priority: args.priority ?? "medium",
          tags,
          remind_before: remindBefore,
          // The one source where no human saw the task before it was saved.
          source: "mcp",
        })
        .select(`${TASK_COLUMNS}, tags, source`)
        .single();
      if (error) throw error;

      const shaped = shapeTask(data as TaskRow & { tags: string[]; source: string }, ctx);
      return ok({
        created: true,
        task: shaped,
        confirm:
          `Created "${shaped.title}" — ${shaped.due_label}` +
          (remindBefore ? `, reminder ${args.remind_before}` : ", no reminder set") +
          `. Repeat this back to the user so a wrongly resolved date is caught now.`,
      });
    },
  );

  // ------------------------------------------------------------- update_task

  register(
    server,
    ctx,
    "update_task",
    {
      title: "Update a task",
      description:
        "Change fields on an existing task. Only the fields you pass are touched; pass null to clear " +
        "notes, due_at or remind_before. Rescheduling (a new due_at) restarts the reminder escalation " +
        "from scratch. To finish a task use complete_task, not this — that is what logs the completion " +
        "and rolls a recurring task forward.",
      inputSchema: {
        id: z.string().uuid().describe("The task id, from list_tasks."),
        title: z.string().min(1).max(300).optional(),
        notes: z.string().max(5000).nullable().optional().describe("null clears the notes."),
        due_at: z
          .string()
          .nullable()
          .optional()
          .describe('ISO 8601 with the user\'s UTC offset. null makes it a "someday" task.'),
        all_day: z.boolean().optional(),
        recurrence: z.enum(["none", "daily", "weekly", "monthly", "yearly"]).optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        tags: z
          .array(z.string().min(1).max(32))
          .max(10)
          .optional()
          .describe("Replaces the whole tag list. Pass [] to clear."),
        remind_before: z
          .string()
          .nullable()
          .optional()
          .describe('e.g. "1 hour". null turns reminders off for this task.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args: Record<string, unknown>) => {
      const task = await myTask(ctx, args.id as string);
      const patch: Record<string, unknown> = {};

      if (args.title !== undefined) patch.title = (args.title as string).trim();
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.priority !== undefined) patch.priority = args.priority;
      if (args.recurrence !== undefined) patch.recurrence = args.recurrence;
      if (args.all_day !== undefined) patch.all_day = args.all_day;
      if (args.tags !== undefined) patch.tags = await ensureTags(ctx, args.tags as string[]);

      const allDay = (patch.all_day ?? task.all_day) as boolean;

      let dueChanged = false;
      if (args.due_at !== undefined) {
        if (args.due_at === null) {
          patch.due_at = null;
        } else {
          const instant = parseInstant(args.due_at as string, "due_at");
          patch.due_at = (allDay ? snapToLocalMidnight(instant, ctx.tz) : instant).toISOString();
        }
        dueChanged = patch.due_at !== task.due_at;
      } else if (args.all_day !== undefined && task.due_at && allDay) {
        // Flipping an existing task to all_day has to move its due_at to local midnight
        // too, or the ladder keeps treating it as a timed task.
        patch.due_at = snapToLocalMidnight(new Date(task.due_at), ctx.tz).toISOString();
        dueChanged = patch.due_at !== task.due_at;
      }

      if (args.remind_before !== undefined) {
        patch.remind_before =
          args.remind_before === null ? null : parseRemindBefore(args.remind_before as string);
      }

      const finalDue = (patch.due_at !== undefined ? patch.due_at : task.due_at) as string | null;
      const finalRemind = (
        patch.remind_before !== undefined ? patch.remind_before : task.remind_before
      ) as string | null;
      if (finalRemind && !finalDue) {
        throw new Error(
          "This task would have a reminder but no due date. Clear remind_before, or give it a due_at.",
        );
      }
      const finalRecurrence = (patch.recurrence ?? task.recurrence) as string;
      if (finalRecurrence !== "none" && !finalDue) {
        throw new Error(
          `A ${finalRecurrence} task needs a due_at to recur from. Set one, or set recurrence to "none".`,
        );
      }

      if (Object.keys(patch).length === 0) {
        throw new Error("Nothing to update — pass at least one field to change.");
      }

      if (dueChanged) {
        // A fresh ladder for the new time. task_notifications is keyed on due_at, so the
        // new occurrence starts clean for free; what has to be undone by hand is the
        // *old* occurrence's state. last_reminded_at and snoozed_until are cleared for the
        // same reason completeTask clears them on roll-forward — a snooze aimed at the
        // time the user just moved away from should not mute the time they moved to.
        patch.last_reminded_at = null;
        patch.snoozed_until = null;
        if (task.due_at) {
          // Dropping the old occurrence's ledger rows, rather than leaving them as
          // history, matters for one real case: rescheduling *back* to a time that had
          // already been notified would otherwise find every stage claimed and send
          // nothing at all. Guarded because a task that had no due_at has no old
          // occurrence to clear.
          const { error: delErr } = await ctx.admin
            .from("task_notifications")
            .delete()
            .eq("user_id", ctx.userId)
            .eq("task_id", task.id)
            .eq("due_at", task.due_at);
          if (delErr) throw delErr;
        }
      }

      const { data, error } = await ctx.admin
        .from("tasks")
        .update(patch)
        .eq("id", task.id)
        .eq("user_id", ctx.userId)
        .select(`${TASK_COLUMNS}, tags, source`)
        .single();
      if (error) throw error;

      const shaped = shapeTask(data as TaskRow & { tags: string[]; source: string }, ctx);
      return ok({
        updated: true,
        changed: Object.keys(patch),
        reminder_ladder_reset: dueChanged,
        task: shaped,
      });
    },
  );

  // ------------------------------------------------------------- complete_task

  register(
    server,
    ctx,
    "complete_task",
    {
      title: "Complete a task",
      description:
        "Mark a task done. This is the right tool for 'I finished X' — it logs the completion for the " +
        "user's Insights page, and a recurring task rolls forward to its next occurrence rather than " +
        "disappearing. Pass done: false to reopen a task that was completed by mistake. Make sure you " +
        "have the right task first: nothing in the app flags a wrongly completed one.",
      inputSchema: {
        id: z.string().uuid().describe("The task id, from list_tasks."),
        done: z.boolean().optional().describe("Default true. false reopens a completed task."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args: { id: string; done?: boolean }) => {
      const task = await myTask(ctx, args.id);

      if (args.done === false) {
        // The mirror image of the web app's useToggleTask reopen branch, including
        // dropping the logged completion — Insights would otherwise keep counting a task
        // that is open again.
        const { error } = await ctx.admin
          .from("tasks")
          .update({ status: "todo", completed_at: null, snoozed_until: null })
          .eq("id", task.id)
          .eq("user_id", ctx.userId);
        if (error) throw error;
        const { error: delErr } = await ctx.admin
          .from("task_completions")
          .delete()
          .eq("user_id", ctx.userId)
          .eq("task_id", task.id);
        if (delErr) throw delErr;
        return ok({ reopened: true, task: shapeTask({ ...task, status: "todo" }, ctx) });
      }

      if (task.status === "done") {
        return ok({ completed: false, already_done: true, title: task.title });
      }

      // The shared helper the Telegram bot and the push buttons use, so "done" means
      // exactly one thing across all four front doors.
      const { rolledTo } = await completeTask(ctx.admin, task, ctx.tz);
      return ok({
        completed: true,
        title: task.title,
        recurring: task.recurrence !== "none",
        next_due_at: rolledTo,
        next_due_label: rolledTo ? describeDue(rolledTo, task.all_day, ctx.tz) : null,
      });
    },
  );

  // ------------------------------------------------------------- snooze_task

  register(
    server,
    ctx,
    "snooze_task",
    {
      title: "Snooze a task",
      description:
        "Suppress a task's reminders until a given moment, without changing its due date. This is 'not " +
        "now' — the task stays overdue and picks its nagging back up afterwards. Use update_task instead " +
        "when the user genuinely wants to do it at a different time.",
      inputSchema: {
        id: z.string().uuid().describe("The task id, from list_tasks."),
        until: z
          .string()
          .describe(
            'ISO 8601 with the user\'s UTC offset, e.g. "2026-10-13T14:00:00+05:30". Must be in the future.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args: { id: string; until: string }) => {
      const task = await myTask(ctx, args.id);
      const until = parseInstant(args.until, "until");
      if (until.getTime() <= Date.now()) {
        throw new Error(
          `until must be in the future — ${args.until} has already passed. The user's current local time is in get_context.`,
        );
      }
      await snoozeTask(ctx.admin, task.id, until);
      return ok({
        snoozed: true,
        title: task.title,
        until: until.toISOString(),
        until_label: describeDue(until.toISOString(), false, ctx.tz),
      });
    },
  );

  // ------------------------------------------------------------- delete_task

  register(
    server,
    ctx,
    "delete_task",
    {
      title: "Delete a task",
      description:
        "Permanently delete a task and its reminder history. CONFIRM WITH THE USER FIRST, naming the " +
        "task you are about to delete — this cannot be undone. If they have simply finished the task, " +
        "use complete_task instead; that is what they almost always mean.",
      inputSchema: { id: z.string().uuid().describe("The task id, from list_tasks.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args: { id: string }) => {
      const task = await myTask(ctx, args.id);
      // task_completions and task_notifications both cascade from tasks, so one delete is
      // the whole cleanup.
      const { error } = await ctx.admin
        .from("tasks")
        .delete()
        .eq("id", task.id)
        .eq("user_id", ctx.userId);
      if (error) throw error;
      return ok({ deleted: true, id: task.id, title: task.title });
    },
  );

  // ------------------------------------------------------------- tags

  register(
    server,
    ctx,
    "list_tags",
    {
      title: "List tags",
      description:
        "The user's tags with their colours and how many open tasks carry each. get_context already " +
        "includes the tag names, so reach for this only when the counts matter.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const [tagsRes, tasksRes] = await Promise.all([
        mine(ctx, "tags", "id, name, color, created_at").order("created_at"),
        mine(ctx, "tasks", "tags").eq("status", "todo"),
      ]);
      if (tagsRes.error) throw tagsRes.error;
      if (tasksRes.error) throw tasksRes.error;

      const counts = new Map<string, number>();
      for (const row of (tasksRes.data ?? []) as { tags: string[] | null }[]) {
        for (const t of row.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      return ok({
        count: tagsRes.data?.length ?? 0,
        tags: (tagsRes.data ?? []).map(
          (t: { name: string; color: string; created_at: string }) => ({
            name: t.name,
            color: t.color,
            open_tasks: counts.get(t.name) ?? 0,
            created_at: t.created_at,
          }),
        ),
      });
    },
  );

  register(
    server,
    ctx,
    "create_tag",
    {
      title: "Create a tag",
      description:
        "Create a tag explicitly, with a colour of your choosing. You rarely need this: a tag name " +
        "passed to create_task or update_task is created automatically. Use it when the user asks for a " +
        "tag by name, or when the colour matters.",
      inputSchema: {
        name: z.string().min(1).max(32).describe("Tag name as the user would write it."),
        color: z.enum(TAG_COLORS).optional().describe("Default slate."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args: { name: string; color?: string }) => {
      const name = args.name.trim();
      if (!name) throw new Error("A tag needs a name.");

      const { data: existing } = await mine(ctx, "tags", "id, name, color")
        .ilike("name", name)
        .maybeSingle();
      if (existing) {
        return ok({
          created: false,
          existed: true,
          tag: { name: existing.name, color: existing.color },
        });
      }

      const { data, error } = await ctx.admin
        .from("tags")
        .insert({ user_id: ctx.userId, name, color: args.color ?? "slate" })
        .select("name, color")
        .single();
      if (error) throw error;
      return ok({ created: true, tag: data });
    },
  );

  // ------------------------------------------------------------- get_news

  register(
    server,
    ctx,
    "get_news",
    {
      title: "Get news items",
      description:
        "The user's curated news for a day: headline, summary, why it matters to them, URL, source and " +
        "importance. Reads the digest built that morning — it never fetches or triggers an AI call, so " +
        "if the digest is not ready, say so rather than retrying. An item flagged via_google_news has a " +
        "redirect URL rather than the publisher's own. Link what you cite.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('Digest date "YYYY-MM-DD" in the user\'s timezone. Default today.'),
        category: z.enum(CATEGORIES).optional().describe("Only this category."),
        saved_only: z
          .boolean()
          .optional()
          .describe("Only items the user saved, across all dates — `date` is then ignored."),
        limit: z.number().int().min(1).max(50).optional().describe("Max items, default 20."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { date?: string; category?: string; saved_only?: boolean; limit?: number }) => {
      const limit = args.limit ?? 20;
      const columns =
        "id, category, headline, summary, why_it_matters, url, source, published_at, importance, rank, is_saved, url_resolved, related_item_id, created_at";

      let query = mine(ctx, "news_items", columns);
      let digestDate: string | null = null;

      if (args.saved_only) {
        query = query.eq("is_saved", true).order("created_at", { ascending: false });
      } else {
        digestDate = parseDate(args.date, ctx.tz, new Date());
        const { data: digest, error: digestErr } = await mine(
          ctx,
          "digests",
          "id, status, summary, items_count",
        )
          .eq("digest_date", digestDate)
          .maybeSingle();
        if (digestErr) throw digestErr;
        if (!digest) {
          return ok({
            date: digestDate,
            digest_ready: false,
            count: 0,
            items: [],
            note: `No digest for ${digestDate}. Digests are built once each morning (around 06:30 IST); there is nothing to fetch on demand.`,
          });
        }
        if (digest.status !== "ready") {
          return ok({
            date: digestDate,
            digest_ready: false,
            digest_status: digest.status,
            count: 0,
            items: [],
            note: `Today's digest is "${digest.status}", not ready.`,
          });
        }
        query = query
          .eq("digest_id", digest.id)
          .order("rank", { ascending: true, nullsFirst: false })
          .order("importance", { ascending: false, nullsFirst: false });
      }

      if (args.category) query = query.eq("category", args.category);

      const { data, error } = await query.limit(limit);
      if (error) throw error;
      const items = (data ?? []) as Record<string, unknown>[];

      // Follow-up linking (related_item_id) is a Phase 6 item that is not built yet, so
      // this is almost always empty — resolved rather than skipped so the tool does not
      // need changing when it lands.
      const relatedIds = items.map((i) => i.related_item_id).filter(Boolean) as string[];
      const related = new Map<string, { headline: string; url: string; created_at: string }>();
      if (relatedIds.length > 0) {
        const { data: rel } = await mine(ctx, "news_items", "id, headline, url, created_at").in(
          "id",
          relatedIds,
        );
        for (const r of (rel ?? []) as Record<string, string>[]) {
          related.set(r.id, { headline: r.headline, url: r.url, created_at: r.created_at });
        }
      }

      return ok({
        date: args.saved_only ? "saved (all dates)" : digestDate,
        digest_ready: true,
        count: items.length,
        items: items.map((i) => ({
          id: i.id,
          category: i.category,
          headline: i.headline,
          summary: i.summary,
          why_it_matters: i.why_it_matters,
          url: i.url,
          source: i.source,
          importance: i.importance,
          published_at: i.published_at,
          is_saved: i.is_saved,
          via_google_news: i.url_resolved === false,
          follows_up_on: i.related_item_id
            ? (related.get(i.related_item_id as string) ?? null)
            : null,
        })),
      });
    },
  );

  // ------------------------------------------------------------- get_brief

  register(
    server,
    ctx,
    "get_brief",
    {
      title: "Get the daily brief",
      description:
        "The 'what do I need to know today' call: the digest's at-a-glance summary, today's tasks, " +
        "overdue items, and birthdays in the next week. Same content as the user's morning email. Use " +
        "get_news for the stories themselves.",
      inputSchema: {
        date: z
          .string()
          .optional()
          .describe('"YYYY-MM-DD" in the user\'s timezone. Default today.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { date?: string }) => {
      const now = new Date();
      const date = parseDate(args.date, ctx.tz, now);
      // Anchor the task windows on the requested date, so a brief for another day is
      // actually that day's brief rather than today's tasks under yesterday's digest.
      const anchor = zonedToUtc(
        Number(date.slice(0, 4)),
        Number(date.slice(5, 7)),
        Number(date.slice(8, 10)),
        12,
        0,
        ctx.tz,
      );
      const startOfDay = startOfDayUtc(anchor, ctx.tz);
      const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
      const horizon = new Date(startOfDay.getTime() + BIRTHDAY_HORIZON_DAYS * 86_400_000);
      const columns = `${TASK_COLUMNS}, tags, source`;

      const [digestRes, todayRes, overdueRes, birthdayRes] = await Promise.all([
        mine(ctx, "digests", "id, status, summary, items_count, sources_scanned, emailed_at")
          .eq("digest_date", date)
          .maybeSingle(),
        mine(ctx, "tasks", columns)
          .eq("status", "todo")
          .gte("due_at", startOfDay.toISOString())
          .lt("due_at", endOfDay.toISOString())
          .order("due_at", { ascending: true }),
        mine(ctx, "tasks", columns)
          .eq("status", "todo")
          .lt("due_at", startOfDay.toISOString())
          .order("due_at", { ascending: true })
          .limit(25),
        // Birthdays are yearly tasks tagged "Birthday" and the roll-forward keeps due_at
        // on the next occurrence, so a plain range query finds them (same as send-briefs).
        mine(ctx, "tasks", columns)
          .eq("recurrence", "yearly")
          .contains("tags", ["Birthday"])
          .gte("due_at", startOfDay.toISOString())
          .lt("due_at", horizon.toISOString())
          .order("due_at", { ascending: true }),
      ]);
      for (const r of [todayRes, overdueRes, birthdayRes]) if (r.error) throw r.error;

      const shape = (rows: unknown) =>
        ((rows ?? []) as (TaskRow & { tags: string[]; source: string })[]).map((t) =>
          shapeTask(t, ctx),
        );
      const digest = digestRes.data;

      return ok({
        date,
        timezone: ctx.tz,
        today_local: dayKey(now, ctx.tz),
        news: {
          digest_ready: digest?.status === "ready",
          digest_status: digest?.status ?? "none",
          at_a_glance: digest?.status === "ready" ? digest.summary : null,
          items_count: digest?.items_count ?? 0,
          note:
            digest?.status === "ready"
              ? "Call get_news for the stories."
              : `No digest ready for ${date}.`,
        },
        tasks: {
          today: shape(todayRes.data),
          overdue: shape(overdueRes.data),
          birthdays_next_7_days: shape(birthdayRes.data),
        },
        app_url: `${ctx.appUrl}/brief`,
      });
    },
  );

  // ------------------------------------------------------------- save_news_item

  register(
    server,
    ctx,
    "save_news_item",
    {
      title: "Save or unsave a news item",
      description:
        "Bookmark a news item for the user (or remove the bookmark). Saved items show on the News page " +
        "and can be read back with get_news({ saved_only: true }).",
      inputSchema: {
        id: z.string().uuid().describe("The news item id, from get_news."),
        saved: z.boolean().describe("true to save, false to unsave."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args: { id: string; saved: boolean }) => {
      const item = await myRow<{ id: string; headline: string }>(
        ctx,
        "news_items",
        "id, headline",
        args.id,
      );
      if (!item) {
        throw new Error(`No news item with id ${args.id} in this account. Get ids from get_news.`);
      }
      const { error } = await ctx.admin
        .from("news_items")
        .update({ is_saved: args.saved })
        .eq("id", args.id)
        .eq("user_id", ctx.userId);
      if (error) throw error;
      return ok({ ok: true, id: args.id, headline: item.headline, is_saved: args.saved });
    },
  );
}

/**
 * Load the per-request context: the timezone every date in every tool is interpreted in,
 * and the morning_time get_context hands back.
 */
export async function loadCtx(admin: SupabaseClient, token: ApiToken): Promise<Ctx> {
  const [profileRes, prefsRes] = await Promise.all([
    admin.from("profiles").select("timezone").eq("id", token.userId).maybeSingle(),
    admin
      .from("notification_prefs")
      .select("morning_time")
      .eq("user_id", token.userId)
      .maybeSingle(),
  ]);

  const raw = profileRes.data?.timezone;
  return {
    admin,
    token,
    userId: token.userId,
    tz: raw && isValidTimezone(raw) ? raw : DEFAULT_TZ,
    morningTime: (prefsRes.data?.morning_time ?? DEFAULT_MORNING).slice(0, 5),
    appUrl: (Deno.env.get("APP_URL") ?? "https://dailyedgeapp.lovable.app").replace(/\/+$/, ""),
  };
}
