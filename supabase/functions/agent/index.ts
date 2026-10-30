// agent (user JWT) — the conversational door.
//
//   {"message": "what's happened with RBI rates?", "history": [...], "surface": "chat"}
//
// Daily Edge's MCP server is built on the principle that the *client* is the
// intelligence: it does no parsing, because an MCP client is already a model holding the
// conversation. This function is the other case. There is no model on the other side —
// just a person typing or talking — so the intelligence has to live here, and that is the
// only reason this function calls Gemini while the MCP server never does.
//
// What it deliberately shares with the MCP server is everything underneath: the same
// ownership guard, the same date coercion, the same task shaping (_shared/agent-tools.ts).
// The two doors differ in who thinks, not in what is true.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { GEMINI_PARSE_MODEL, generateWithTools } from "../_shared/gemini.ts";
import { loadUserCtx } from "../_shared/agent-tools.ts";
import {
  MUTATING_TOOLS,
  type Run,
  type Surface,
  declarationsFor,
  runTool,
  unknownCitations,
} from "../_shared/agent-registry.ts";
import { isEnabled } from "../_shared/features.ts";
import {
  CORS_HEADERS,
  HttpError,
  countAiEvents,
  json,
  logAiEvent,
  requireUser,
  serviceClient,
} from "../_shared/supabase.ts";
import { logToolCall } from "../_shared/api-tokens.ts";
import { offsetLabel } from "../_shared/time.ts";

/** Conversations a user may have per day. Same shape of limit as parse-task's 50 parses. */
const DAILY_LIMIT = 60;

/** How much history is sent back to the model. */
const MAX_HISTORY = 12;

const SURFACES: Surface[] = ["chat", "voice", "telegram", "planner"];

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");

  const admin = serviceClient();
  const user = await requireUser(req, admin);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) throw new HttpError(400, "message is required");
  if (message.length > 2000) throw new HttpError(400, "message is too long (2000 chars max)");

  const requested = typeof body.surface === "string" ? body.surface : "chat";
  const surface = (SURFACES.includes(requested as Surface) ? requested : "chat") as Surface;

  // The feature gate is checked here, at the entry point, not in the UI. A switch that
  // only hides a nav item is decoration.
  if (!(await isEnabled(admin, user.id, "chat"))) {
    throw new HttpError(403, "The assistant is turned off for this account (Settings → Features).");
  }

  const used = await countAiEvents(admin, user.id, "agent", startOfToday());
  if (used >= DAILY_LIMIT) {
    throw new HttpError(429, `Daily limit of ${DAILY_LIMIT} assistant messages reached.`, {
      used,
      limit: DAILY_LIMIT,
    });
  }

  const ctx = await loadUserCtx(admin, user.id);
  const run: Run = { ctx, surface, citations: new Map() };

  const history = readHistory(body.history);
  const started = Date.now();

  const result = await generateWithTools({
    model: GEMINI_PARSE_MODEL,
    system: await systemPrompt(run),
    messages: [...history, { role: "user" as const, text: message }],
    tools: declarationsFor(surface),
    execute: async (name, args) => {
      const toolStart = Date.now();
      try {
        const out = await runTool(run, name, args);
        await logToolCall(admin, {
          userId: user.id,
          tokenId: null,
          tool: name,
          ok: true,
          durationMs: Date.now() - toolStart,
          surface,
        });
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logToolCall(admin, {
          userId: user.id,
          tokenId: null,
          tool: name,
          ok: false,
          error: msg,
          durationMs: Date.now() - toolStart,
          surface,
        });
        throw err;
      }
    },
  });

  await logAiEvent(admin, {
    userId: user.id,
    kind: "agent",
    itemsProcessed: result.calls.length,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  // A link the model produced that no tool returned is a fabrication, and a fabricated
  // link is worse than a wrong summary: the summary is visibly the model's opinion, a
  // URL looks like a fact. Reported rather than silently stripped, so the UI can mark it
  // and so this shows up in the logs instead of only in a user's confusion.
  const invented = unknownCitations(run, result.text);
  if (invented.length > 0) {
    console.error(`[${user.id}] agent cited ${invented.length} URL(s) no tool returned`, invented);
  }

  return json({
    answer: result.text,
    surface,
    citations: [...run.citations.values()].filter((c) => result.text.includes(c.url)),
    tool_calls: result.calls.map((c) => ({
      name: c.name,
      ok: c.ok,
      error: c.error ?? null,
      mutating: MUTATING_TOOLS.has(c.name),
      duration_ms: c.durationMs,
    })),
    unverified_links: invented,
    turns: result.turns,
    duration_ms: Date.now() - started,
    usage: result.usage,
    quota: { used: used + 1, limit: DAILY_LIMIT },
  });
}

function startOfToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** Prior turns, trusted only for their shape. */
function readHistory(raw: unknown): { role: "user" | "model"; text: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { role: "user" | "model"; text: string }[] = [];
  for (const entry of raw.slice(-MAX_HISTORY)) {
    const e = entry as Record<string, unknown>;
    const role = e?.role === "model" || e?.role === "assistant" ? "model" : "user";
    const text = typeof e?.text === "string" ? e.text.slice(0, 4000) : "";
    if (text) out.push({ role, text });
  }
  // Gemini rejects a conversation that opens on a model turn.
  while (out.length > 0 && out[0].role === "model") out.shift();
  return out;
}

/**
 * The context the model would otherwise have to spend a tool call to learn.
 *
 * The MCP server makes its client call get_context first; here the same facts are simply
 * inlined, because a turn spent asking "what timezone am I in" is a turn of latency the
 * user is watching tick by. The UTC offset is spelled out because create_task refuses a
 * due_at without one, and a model that has to guess an offset will guess wrong.
 */
async function systemPrompt(run: Run): Promise<string> {
  const { ctx } = run;
  const now = new Date();
  const offset = offsetLabel(now, ctx.tz);
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: ctx.tz,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);

  const { data: tags } = await ctx.admin
    .from("tags")
    .select("name")
    .eq("user_id", ctx.userId)
    .limit(40);
  const tagNames = (tags ?? []).map((t: { name: string }) => t.name).join(", ");

  const voiceNote =
    run.surface === "voice"
      ? "\nThis is a VOICE conversation. Answer in two or three sentences, no markdown, no " +
        "lists, no URLs read aloud. Say 'I've put that on your list' rather than reciting ids."
      : "";

  return `You are the assistant inside Daily Edge, ${ctx.appUrl} — a personal task manager and
daily AI news brief. You are talking to its owner.

Their clock, which is the only one that matters:
- timezone ${ctx.tz}, currently UTC${offset}
- right now it is ${local}
- "morning" means ${ctx.morningTime}, afternoon 14:00, evening 19:00, tonight 21:00

Their existing tags (reuse these, do not invent near-duplicates): ${tagNames || "none yet"}

How to behave:
- Answer questions about news by calling search_news or my_news first. Never answer from your
  own knowledge — the user is asking what *their* news said, and your training data is not it.
  If a search returns nothing, say so plainly. "I don't have anything on that" is a good
  answer; a plausible-sounding summary of a story you half-remember is not.
- Cite with the exact URLs the tools returned, and only those. Do not construct, shorten,
  guess or tidy a URL. If an article is flagged via_google_news, its link is a redirect — say
  "via Google News" when you give it.
- When you create a task, repeat the resolved date back in plain words ("tomorrow at 9am"), so
  a wrongly understood date is caught immediately rather than at the reminder.
- due_at must be ISO 8601 with the offset above, e.g. 2026-10-29T09:00:00${offset}. Never send a
  bare local time; it will be rejected.
- Find a task with list_tasks before completing it. If more than one plausibly matches what
  they said, ask which — do not pick.
- Be brief. They are looking at a small panel, not reading an essay.${voiceNote}`;
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error(err);
    return json({ error: err instanceof Error ? err.message : "agent failed" }, 500);
  }
});
