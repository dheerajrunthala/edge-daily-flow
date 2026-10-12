// Free text -> structured tasks. Lives in _shared because two front doors need it: the
// web app's quick-add (parse-task, which returns a preview the user confirms) and the
// Telegram bot (which has no preview step and saves what comes back).
//
// Both go through parseTasks(), so the prompt, the schema and the 50-calls-a-day limit
// cannot drift apart between them.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { GEMINI_PARSE_MODEL, generateJson } from "./gemini.ts";
import { HttpError, countAiEvents, logAiEvent } from "./supabase.ts";
import { dayKey, isValidTimezone, offsetLabel, startOfDayUtc, weekdayName } from "./time.ts";

export const DAILY_LIMIT = 50;
export const MAX_INPUT_CHARS = 1000;
const MAX_TASKS = 10;
const DEFAULT_TZ = "Asia/Kolkata";

const RECURRENCES = ["none", "daily", "weekly", "monthly", "yearly"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;
/** Mirrors REMIND_OPTIONS in src/lib/task-logic.ts so the UI's select can show the result. */
const REMINDERS = ["none", "00:15:00", "01:00:00", "1 day", "3 days"] as const;

type Recurrence = (typeof RECURRENCES)[number];
type Priority = (typeof PRIORITIES)[number];

/** A task ready to insert into `tasks` (or to show as a preview). */
export type DraftTask = {
  title: string;
  notes: string | null;
  due_at: string | null;
  all_day: boolean;
  recurrence: Recurrence;
  priority: Priority;
  tags: string[];
  remind_before: string | null;
};

// Every field is required and non-null; "" is the empty sentinel. Constraining the model
// this way avoids the nullable-union handling and keeps the parse below simple.
const SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        propertyOrdering: [
          "title",
          "notes",
          "due_at",
          "all_day",
          "recurrence",
          "priority",
          "tags",
          "remind_before",
        ],
        properties: {
          title: {
            type: "string",
            description: "Short imperative title. No date or tag text inside it.",
          },
          notes: {
            type: "string",
            description: "Extra detail the title drops, else an empty string.",
          },
          due_at: {
            type: "string",
            description:
              "Local ISO 8601 with the user's UTC offset, e.g. 2026-10-14T15:00:00+05:30. " +
              "Empty string when the text names no date — that means 'someday'.",
          },
          all_day: {
            type: "boolean",
            description: "True when a date is given with no clock time.",
          },
          recurrence: { type: "string", enum: [...RECURRENCES] },
          priority: { type: "string", enum: [...PRIORITIES] },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Only names from the user's existing tag list.",
          },
          remind_before: {
            type: "string",
            enum: [...REMINDERS],
            description: 'Use "none" unless the text asks to be reminded ahead of time.',
          },
        },
        required: [
          "title",
          "notes",
          "due_at",
          "all_day",
          "recurrence",
          "priority",
          "tags",
          "remind_before",
        ],
      },
    },
  },
  required: ["tasks"],
} as const;

type ModelTask = {
  title: string;
  notes: string;
  due_at: string;
  all_day: boolean;
  recurrence: string;
  priority: string;
  tags: string[];
  remind_before: string;
};

function systemPrompt(ctx: {
  today: string;
  weekday: string;
  tz: string;
  offset: string;
  tags: string[];
}): string {
  return [
    "You turn a person's short, informal note into structured to-do items.",
    "",
    `Today is ${ctx.weekday}, ${ctx.today} in the user's timezone ${ctx.tz} (UTC${ctx.offset}).`,
    'Resolve every relative date against that: "tomorrow", "next Tuesday", "in 3 days", "month end".',
    '"next <weekday>" means the next occurrence strictly after today, never today itself.',
    "",
    "Rules:",
    `- due_at is local ISO 8601 carrying the offset, e.g. 2026-10-14T15:00:00${ctx.offset}. Never UTC, never bare.`,
    '- No date mentioned at all -> due_at is "" (a someday task). Do not invent a date.',
    "- A date with no clock time -> all_day true and the time component 00:00.",
    "- A bare time with no date means today if it is still ahead, otherwise tomorrow.",
    '- Informal Indian times: "subah"/morning 09:00, "shaam"/evening 18:00, "raat"/night 21:00, "dopahar" 13:00.',
    "- Split genuinely separate errands into separate tasks. Keep one errand as one task.",
    '- recurrence: only when the text says it repeats ("every year", "roz", "har mahine", "daily").',
    "- A birthday or anniversary is yearly and all_day.",
    '- priority: high only for explicit urgency ("urgent", "asap", "zaroori"), else medium; low for idle wishes.',
    '- remind_before: "none" unless the text asks to be reminded ahead of time.',
    "- Write title and notes in English even when the input is Hindi, Hinglish or mixed.",
    "- Strip date, time and tag words out of the title.",
    "",
    ctx.tags.length
      ? `Tags — choose only from this list, copying the spelling exactly, or return []:\n${ctx.tags.map((t) => `  - ${t}`).join("\n")}`
      : "The user has no tags. Always return [] for tags.",
  ].join("\n");
}

/** Keep only tags the user actually has, matched case-insensitively and re-cased to theirs. */
function resolveTags(modelTags: unknown, known: string[]): string[] {
  if (!Array.isArray(modelTags)) return [];
  const byLower = new Map(known.map((t) => [t.toLowerCase(), t]));
  const out: string[] = [];
  for (const raw of modelTags) {
    if (typeof raw !== "string") continue;
    const hit = byLower.get(raw.trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Normalize one model task into the shape the UI's taskToDraft() expects. Returns null for
 * anything unusable, so a single bad row doesn't sink the whole response.
 */
function normalize(raw: ModelTask, known: string[]): DraftTask | null {
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 300) : "";
  if (!title) return null;

  let dueAt: string | null = null;
  if (typeof raw.due_at === "string" && raw.due_at.trim()) {
    const parsed = new Date(raw.due_at.trim());
    // A date the model got wrong enough to be unparseable is better dropped than guessed at.
    if (!Number.isNaN(parsed.getTime())) dueAt = parsed.toISOString();
  }

  const recurrence = (RECURRENCES as readonly string[]).includes(raw.recurrence)
    ? (raw.recurrence as Recurrence)
    : "none";
  const priority = (PRIORITIES as readonly string[]).includes(raw.priority)
    ? (raw.priority as Priority)
    : "medium";
  const remind =
    (REMINDERS as readonly string[]).includes(raw.remind_before) && raw.remind_before !== "none"
      ? raw.remind_before
      : "";
  const notes = typeof raw.notes === "string" ? raw.notes.trim() : "";

  return {
    title,
    notes: notes || null,
    due_at: dueAt,
    // Recurrence and all_day are meaningless without a date.
    all_day: dueAt ? raw.all_day === true : false,
    recurrence: dueAt ? recurrence : "none",
    priority,
    tags: resolveTags(raw.tags, known),
    remind_before: dueAt && remind ? remind : null,
  };
}

export type ParseResult = { tasks: DraftTask[]; remaining: number };

/**
 * Parse `text` for `userId`. Enforces the daily Gemini budget (throws HttpError 429) and
 * logs an ai_events row. Writes nothing to `tasks` — the caller decides whether a preview
 * or a direct insert is the right thing.
 */
export async function parseTasks(
  admin: SupabaseClient,
  opts: { userId: string; text: string },
): Promise<ParseResult> {
  const text = opts.text.trim();
  if (!text) throw new HttpError(400, "Send { text: string }");
  if (text.length > MAX_INPUT_CHARS) {
    throw new HttpError(400, `Keep it under ${MAX_INPUT_CHARS} characters`);
  }

  // Timezone first: it decides which day the rate limit window covers.
  const { data: profile } = await admin
    .from("profiles")
    .select("timezone")
    .eq("id", opts.userId)
    .maybeSingle();
  const tz = profile?.timezone && isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ;

  const now = new Date();
  const used = await countAiEvents(admin, opts.userId, "task_parse", startOfDayUtc(now, tz));
  if (used >= DAILY_LIMIT) {
    throw new HttpError(429, `You've used all ${DAILY_LIMIT} AI task parses for today.`, {
      limit: DAILY_LIMIT,
      used,
    });
  }

  const { data: tagRows } = await admin.from("tags").select("name").eq("user_id", opts.userId);
  const known = (tagRows ?? []).map((t: { name: string }) => t.name);

  const system = systemPrompt({
    today: dayKey(now, tz),
    weekday: weekdayName(now, tz),
    tz,
    offset: offsetLabel(now, tz),
    tags: known,
  });

  const { data, usage } = await generateJson<{ tasks: ModelTask[] }>({
    model: GEMINI_PARSE_MODEL,
    system,
    input: text,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });

  const tasks = (data?.tasks ?? [])
    .slice(0, MAX_TASKS)
    .map((t) => normalize(t, known))
    .filter((t): t is DraftTask => t !== null);

  await logAiEvent(admin, {
    userId: opts.userId,
    kind: "task_parse",
    itemsProcessed: tasks.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  return { tasks, remaining: Math.max(0, DAILY_LIMIT - used - 1) };
}
