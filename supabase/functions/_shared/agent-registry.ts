// The tools the conversational agent may call, and the rule about which door may call what.
//
// These are Gemini function declarations over the same helpers the MCP server uses
// (_shared/agent-tools.ts), so "tomorrow 9am" and "which rows may I touch" are answered
// in one place for every caller. What is *new* here is the surface allowlist, because the
// MCP server has only one kind of caller and the agent has several.

import { embedBatch, type ToolDeclaration } from "./gemini.ts";
import {
  type Ctx,
  ensureTags,
  mine,
  myRow,
  parseInstant,
  parseRemindBefore,
  sanitizeSearch,
  shapeTask,
  snapToLocalMidnight,
} from "./agent-tools.ts";
import { TASK_COLUMNS, completeTask, type TaskRow } from "./tasks.ts";
import { dayKey } from "./time.ts";

export type Surface = "chat" | "voice" | "telegram" | "planner";

/**
 * Which tools each door may reach.
 *
 * Not a nicety. A chat window shows the user exactly what was done and offers an undo;
 * a voice device in a room has heard something it may have misheard and shows nothing at
 * all; the planner runs on cron with no one present to notice a mistake. So the doors get
 * different permissions by construction rather than by careful prompting, because a prompt is a
 * request and an allowlist is a rule.
 *
 * Nothing destructive is reachable from any of them. delete_task is deliberately absent
 * everywhere — the MCP server has it because a developer's editor can confirm first, and
 * "delete the thing about the client" said out loud to a speaker is not a confirmation.
 */
export const SURFACE_TOOLS: Record<Surface, readonly string[]> = {
  chat: ["search_news", "my_news", "list_tasks", "get_brief", "create_task", "complete_task"],
  voice: ["search_news", "my_news", "list_tasks", "get_brief", "create_task"],
  telegram: ["search_news", "my_news", "list_tasks", "get_brief", "create_task", "complete_task"],
  planner: ["list_tasks", "get_brief", "my_news"],
};

/** Tools that change something. Used to decide what needs confirming, and what to report. */
export const MUTATING_TOOLS = new Set(["create_task", "complete_task"]);

/** A news row the model was shown, kept so an answer's citations can be checked. */
export type Citation = {
  title: string;
  url: string;
  source: string | null;
  published_at: string | null;
  via_google_news: boolean;
};

export type Run = {
  ctx: Ctx;
  surface: Surface;
  /** Everything any retrieval tool returned this run — the only URLs an answer may cite. */
  citations: Map<string, Citation>;
};

// ----------------------------------------------------------------- declarations

const DECLARATIONS: Record<string, ToolDeclaration> = {
  search_news: {
    name: "search_news",
    description:
      "Search the shared news archive by meaning, not keywords. Use this for any question " +
      "about what has happened — 'what's going on with RBI rates', 'any Kubernetes CVEs'. " +
      "Returns articles with their URLs; cite only what this returns.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, as a phrase." },
        days: {
          type: "integer",
          description: "How far back to search. Default 14, max 90.",
        },
        limit: { type: "integer", description: "Max articles, default 8, max 20." },
      },
      required: ["query"],
    },
  },
  my_news: {
    name: "my_news",
    description:
      "The user's own curated digest for a day — the stories picked for them, with why each " +
      "mattered. Use this for 'what was in my brief' rather than search_news.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: 'Digest date "YYYY-MM-DD". Default today.' },
        saved_only: { type: "boolean", description: "Only items the user bookmarked." },
      },
    },
  },
  list_tasks: {
    name: "list_tasks",
    description:
      "The user's tasks. Filter by 'today', 'overdue', 'upcoming', 'someday' or 'done'; omit " +
      "for all open tasks. Call this to find a task's id before completing one.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["today", "overdue", "upcoming", "someday", "done"],
        },
        search: { type: "string", description: "Substring match on title and notes." },
        tag: { type: "string" },
        limit: { type: "integer", description: "Default 30, max 100." },
      },
    },
  },
  get_brief: {
    name: "get_brief",
    description:
      "Today at a glance: the digest summary, today's tasks, overdue items and birthdays in " +
      "the next week. The same content as the user's morning email.",
    parameters: { type: "object", properties: {} },
  },
  create_task: {
    name: "create_task",
    description:
      "Create a task. due_at must be ISO 8601 WITH the user's UTC offset — the offset is in " +
      "the system prompt, do not guess it. Set remind_before if they asked to be reminded.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short and imperative." },
        notes: { type: "string" },
        due_at: {
          type: "string",
          description: 'ISO 8601 with offset, e.g. "2026-10-29T09:00:00+05:30". Omit for someday.',
        },
        all_day: { type: "boolean", description: "True for a date with no time." },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        recurrence: {
          type: "string",
          enum: ["none", "daily", "weekly", "monthly", "yearly"],
        },
        remind_before: { type: "string", description: 'e.g. "15 minutes", "1 hour", "1 day".' },
        tags: { type: "array", items: { type: "string" }, description: "Reuse existing names." },
      },
      required: ["title"],
    },
  },
  complete_task: {
    name: "complete_task",
    description:
      "Mark a task done. Logs the completion and rolls a recurring task to its next " +
      "occurrence. Find the id with list_tasks first.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id from list_tasks." } },
      required: ["id"],
    },
  },
};

/** The declarations this surface is allowed to see. A tool it cannot see, it cannot call. */
export function declarationsFor(surface: Surface): ToolDeclaration[] {
  return SURFACE_TOOLS[surface].map((name) => DECLARATIONS[name]).filter(Boolean);
}

// ----------------------------------------------------------------- execution

/**
 * Run one tool call.
 *
 * The allowlist is checked here as well as at declaration time. Belt and braces on
 * purpose: a model that hallucinates a tool name it was never given would otherwise land
 * in whatever the dispatcher's default branch happens to be, and this is the layer that
 * has the user's id in its hand.
 */
export async function runTool(
  run: Run,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (!SURFACE_TOOLS[run.surface].includes(name)) {
    throw new Error(`Tool "${name}" is not available here.`);
  }
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool "${name}".`);
  return handler(run, args);
}

type Handler = (run: Run, args: Record<string, unknown>) => Promise<unknown>;

const num = (v: unknown, dflt: number, max: number) => {
  const n = typeof v === "number" ? Math.floor(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const HANDLERS: Record<string, Handler> = {
  async search_news(run, args) {
    const query = str(args.query);
    if (!query) throw new Error("search_news needs a query.");
    const days = num(args.days, 14, 90);
    const limit = num(args.limit, 8, 20);

    // The topic label and the article pool must be embedded the same way or the cosine
    // distances stop meaning anything — see the note in the topics function.
    const [vector] = await embedBatch([query], { taskType: "SEMANTIC_SIMILARITY" });
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

    const { data, error } = await run.ctx.admin.rpc("match_articles", {
      p_query_embedding: vector,
      p_match_count: limit,
      p_since: since,
      p_categories: null,
      // The measured coverage floor. Below it the pool is returning its least-unrelated
      // stories rather than matches, and the model cannot tell the difference.
      p_min_similarity: 0.8,
    });
    if (error) throw error;

    const rows = (data ?? []) as {
      title: string;
      url: string;
      source: string;
      summary: string | null;
      published_at: string | null;
      url_resolved: boolean;
      category: string;
      similarity: number;
    }[];

    for (const r of rows) {
      run.citations.set(r.url, {
        title: r.title,
        url: r.url,
        source: r.source,
        published_at: r.published_at,
        via_google_news: !r.url_resolved,
      });
    }

    if (rows.length === 0) {
      return {
        query,
        found: 0,
        note:
          "Nothing in the archive matches this closely. Say so plainly — do not answer from " +
          "your own knowledge, because the user is asking what their news said.",
      };
    }

    return {
      query,
      days,
      found: rows.length,
      articles: rows.map((r) => ({
        title: r.title,
        url: r.url,
        source: r.source,
        category: r.category,
        published_at: r.published_at,
        summary: r.summary,
        via_google_news: !r.url_resolved,
        similarity: Number(r.similarity.toFixed(3)),
      })),
    };
  },

  async my_news(run, args) {
    const savedOnly = args.saved_only === true;
    const cols =
      "headline, summary, why_it_matters, url, source, category, importance, published_at, url_resolved, is_saved";

    let query = mine(run.ctx, "news_items", cols);
    if (savedOnly) {
      query = query.eq("is_saved", true).order("created_at", { ascending: false }).limit(25);
    } else {
      const date = str(args.date) || dayKey(new Date(), run.ctx.tz);
      const { data: digest } = await run.ctx.admin
        .from("digests")
        .select("id, summary, status")
        .eq("user_id", run.ctx.userId)
        .eq("digest_date", date)
        .maybeSingle();
      if (!digest || digest.status !== "ready") {
        return {
          date,
          ready: false,
          note: `No digest for ${date}. Tell the user plainly; do not invent headlines.`,
        };
      }
      query = query.eq("digest_id", digest.id).order("rank", { ascending: true });
    }

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];

    for (const r of rows) {
      const url = r.url as string;
      run.citations.set(url, {
        title: r.headline as string,
        url,
        source: (r.source as string) ?? null,
        published_at: (r.published_at as string) ?? null,
        via_google_news: r.url_resolved === false,
      });
    }
    return { ready: true, count: rows.length, items: rows };
  },

  async list_tasks(run, args) {
    const limit = num(args.limit, 30, 100);
    const filter = str(args.filter);

    let query = mine(run.ctx, "tasks", `${TASK_COLUMNS}, tags, source`);
    query = filter === "done" ? query.eq("status", "done") : query.eq("status", "todo");

    const tag = str(args.tag);
    if (tag) query = query.contains("tags", [tag]);

    const search = sanitizeSearch(str(args.search));
    if (search) query = query.or(`title.ilike.%${search}%,notes.ilike.%${search}%`);

    const { data, error } = await query.limit(200);
    if (error) throw error;

    // Grouping happens here rather than in SQL, mirroring src/lib/task-logic.ts: the
    // comparison is by *day* in the user's timezone, so a task due later today is
    // "today" and an all-day task due today is never overdue. A due_at < now() query
    // gets both wrong and would disagree with the /tasks page.
    let tasks = (data ?? []).map((t) => shapeTask(t as TaskRow & { tags: string[] }, run.ctx));
    if (filter && filter !== "done") {
      tasks = tasks.filter((t) => t.group === filter);
    }
    return { filter: filter || "open", count: tasks.length, tasks: tasks.slice(0, limit) };
  },

  async get_brief(run) {
    const today = dayKey(new Date(), run.ctx.tz);
    const { data: digest } = await run.ctx.admin
      .from("digests")
      .select("summary, items_count, sources_scanned, status")
      .eq("user_id", run.ctx.userId)
      .eq("digest_date", today)
      .maybeSingle();

    const { data: openTasks } = await mine(run.ctx, "tasks", `${TASK_COLUMNS}, tags, source`)
      .eq("status", "todo")
      .limit(200);

    const shaped = (openTasks ?? []).map((t) =>
      shapeTask(t as TaskRow & { tags: string[] }, run.ctx),
    );
    return {
      date: today,
      at_a_glance: digest?.status === "ready" ? digest.summary : null,
      digest_ready: digest?.status === "ready",
      today: shaped.filter((t) => t.group === "today"),
      overdue: shaped.filter((t) => t.group === "overdue"),
      open_count: shaped.length,
    };
  },

  async create_task(run, args) {
    const title = str(args.title);
    if (!title) throw new Error("create_task needs a title.");

    const allDay = args.all_day === true;
    let dueAt: string | null = null;
    const rawDue = str(args.due_at);
    if (rawDue) {
      let instant = parseInstant(rawDue, "due_at");
      if (allDay) instant = snapToLocalMidnight(instant, run.ctx.tz);
      dueAt = instant.toISOString();
    }

    const remind = str(args.remind_before);
    if (remind && !dueAt) {
      throw new Error("remind_before needs a due_at — there is nothing to remind before.");
    }

    const tags = Array.isArray(args.tags)
      ? await ensureTags(
          run.ctx,
          (args.tags as unknown[]).map((t) => String(t)),
        )
      : [];

    const { data, error } = await run.ctx.admin
      .from("tasks")
      .insert({
        user_id: run.ctx.userId,
        title: title.slice(0, 300),
        notes: str(args.notes).slice(0, 5000) || null,
        due_at: dueAt,
        all_day: allDay,
        priority: ["low", "medium", "high"].includes(str(args.priority))
          ? str(args.priority)
          : "medium",
        recurrence: ["none", "daily", "weekly", "monthly", "yearly"].includes(str(args.recurrence))
          ? str(args.recurrence)
          : "none",
        remind_before: remind ? parseRemindBefore(remind) : null,
        tags,
        // Not 'ai' and not 'mcp': this one came from a conversation the user was present
        // for, and Insights counts the sources separately.
        source: "agent",
      })
      .select(`${TASK_COLUMNS}, tags, source`)
      .single();
    if (error) throw error;

    const shaped = shapeTask(data as TaskRow & { tags: string[] }, run.ctx);
    return {
      created: true,
      task: shaped,
      confirm: `Created "${title}" — ${shaped.due_label}. Repeat the resolved date back to the user so a wrong one is caught now.`,
    };
  },

  async complete_task(run, args) {
    const id = str(args.id);
    if (!id) throw new Error("complete_task needs a task id from list_tasks.");

    const task = await myRow<TaskRow>(run.ctx, "tasks", TASK_COLUMNS, id);
    if (!task) {
      throw new Error(
        `No task with id ${id} in this account. Use list_tasks to find the right id.`,
      );
    }
    const { rolledTo } = await completeTask(run.ctx.admin, task, run.ctx.tz);
    return {
      completed: true,
      title: task.title,
      recurring: task.recurrence !== "none",
      next_due_at: rolledTo,
    };
  },
};

/**
 * Which of an answer's links were not in anything a tool returned.
 *
 * This is the hallucinated-citation check, and it is the reason `citations` is collected
 * at all. The model is told to cite only retrieved articles; this is how we find out
 * whether it did. A URL it invented is worse than a wrong summary — the summary is
 * visibly the model's, while a link looks like a fact.
 */
export function unknownCitations(run: Run, answer: string): string[] {
  const found = answer.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [];
  const stripped = (u: string) => u.replace(/[.,;:]+$/, "");
  return [...new Set(found.map(stripped))].filter((u) => !run.citations.has(u));
}
