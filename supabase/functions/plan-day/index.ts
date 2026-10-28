// plan-day (cron secret) — the door with nobody behind it.
//
// Every other front door answers a person: the browser, the Telegram bot, an editor's
// MCP client. This one runs on a schedule and decides, unprompted, what to say about
// someone's day. That difference is the whole design:
//
//   * It is the only feature that defaults OFF (_shared/features.ts). A cron job that
//     messages you at 9am is something you agree to, not something you discover.
//   * It gets the narrowest tool allowlist of any surface — three read tools, no writes.
//     An agent acting while nobody is watching should not be able to change anything.
//   * It delivers through notify(), so it inherits quiet hours, the channel fan-out and
//     the per-channel reporting for free rather than reimplementing any of it.
//
//   {"user_id": "...", "force": true}   run for one user regardless of their morning time

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { GEMINI_PARSE_MODEL, generateWithTools } from "../_shared/gemini.ts";
import { loadUserCtx } from "../_shared/agent-tools.ts";
import { type Run, declarationsFor, runTool } from "../_shared/agent-registry.ts";
import { filterEnabled } from "../_shared/features.ts";
import { activeChannels, loadRecipient, notify } from "../_shared/notify.ts";
import {
  CORS_HEADERS,
  HttpError,
  hasCronSecret,
  json,
  logAiEvent,
  serviceClient,
} from "../_shared/supabase.ts";
import { logToolCall } from "../_shared/api-tokens.ts";
import { dayKey, partsInTz } from "../_shared/time.ts";

/**
 * How close to the user's morning_time a tick has to be to fire.
 *
 * The cron runs every 15 minutes, so a window slightly wider than the interval means a
 * user whose morning_time falls between ticks is not skipped, while `plan_sends` keeps
 * the overlap from sending twice.
 */
const WINDOW_MINUTES = 16;

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");

  const admin = serviceClient();
  const body = (await req.json().catch(() => ({}))) as { user_id?: string; force?: boolean };

  const candidates = await dueUsers(admin, body.user_id, body.force === true);
  if (candidates.length === 0) {
    return json({ ok: true, note: "no users due for a plan", planned: [] });
  }

  const report = [];
  for (const userId of candidates) {
    try {
      report.push(await planForUser(admin, userId, body.force === true));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`plan-day failed for ${userId}: ${message}`);
      report.push({ user_id: userId, status: "failed", error: message });
    }
  }
  return json({ ok: true, planned: report });
}

/**
 * Users whose local clock is at their morning_time right now, and who want this.
 *
 * The feature filter runs before anything is spent, and in bulk — one query rather than
 * one per user, which is the same reasoning the news pipeline uses to keep the marginal
 * cost of a user near zero.
 */
async function dueUsers(
  admin: SupabaseClient,
  onlyUser: string | undefined,
  force: boolean,
): Promise<string[]> {
  let query = admin.from("notification_prefs").select("user_id, morning_time");
  if (onlyUser) query = query.eq("user_id", onlyUser);
  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as { user_id: string; morning_time: string | null }[];
  const ids: string[] = [];

  for (const row of rows) {
    if (force) {
      ids.push(row.user_id);
      continue;
    }
    const { data: profile } = await admin
      .from("profiles")
      .select("timezone")
      .eq("id", row.user_id)
      .maybeSingle();
    const tz = profile?.timezone ?? "Asia/Kolkata";
    if (withinWindow(row.morning_time ?? "09:00", tz)) ids.push(row.user_id);
  }

  return filterEnabled(admin, ids, "planner");
}

/** Is the user's local wall clock inside the window after `hhmm`? */
function withinWindow(hhmm: string, tz: string): boolean {
  const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const now = partsInTz(new Date(), tz);
  const minutesNow = now.h * 60 + now.min;
  const target = h * 60 + m;
  const delta = minutesNow - target;
  return delta >= 0 && delta < WINDOW_MINUTES;
}

async function planForUser(admin: SupabaseClient, userId: string, force: boolean) {
  const ctx = await loadUserCtx(admin, userId);
  const today = dayKey(new Date(), ctx.tz);

  // Claimed before anything is spent, exactly like brief_sends and task_notifications:
  // the unique constraint is what makes two overlapping ticks unable to double-send, and
  // claiming first is what makes a crash visible rather than silent.
  if (!force) {
    const { error } = await admin.from("plan_sends").insert({ user_id: userId, sent_for: today });
    if (error) {
      if (error.code === "23505")
        return { user_id: userId, status: "skipped", reason: "already planned" };
      throw error;
    }
  }

  const run: Run = { ctx, surface: "planner", citations: new Map() };
  let result;
  try {
    result = await generateWithTools({
      model: GEMINI_PARSE_MODEL,
      system: planPrompt(ctx.tz, ctx.morningTime, today),
      messages: [
        {
          role: "user" as const,
          text: "Plan my day. Start by looking at my tasks and my brief.",
        },
      ],
      tools: declarationsFor("planner"),
      maxTurns: 4,
      execute: async (name, args) => {
        const started = Date.now();
        try {
          const out = await runTool(run, name, args);
          await logToolCall(admin, {
            userId,
            tokenId: null,
            tool: name,
            ok: true,
            durationMs: Date.now() - started,
            surface: "planner",
          });
          return out;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await logToolCall(admin, {
            userId,
            tokenId: null,
            tool: name,
            ok: false,
            error: msg,
            durationMs: Date.now() - started,
            surface: "planner",
          });
          throw err;
        }
      },
    });
  } catch (err) {
    // Release the claim so tomorrow's tick — or a retry today — can try again. The same
    // rule send-briefs follows: one upstream hiccup must not mark the day done.
    if (!force) await admin.from("plan_sends").delete().eq("user_id", userId).eq("sent_for", today);
    throw err;
  }

  await logAiEvent(admin, {
    userId,
    kind: "plan",
    itemsProcessed: result.calls.length,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  const recipient = await loadRecipient(admin, userId);
  const { channels, skipped } = activeChannels(recipient, new Date());

  if (channels.length === 0) {
    return {
      user_id: userId,
      status: "held",
      reason: "quiet hours or no channel enabled",
      skipped,
      plan: result.text,
      tool_calls: result.calls.length,
    };
  }

  const delivery = await notify(
    admin,
    recipient,
    {
      title: `Your plan for ${today}`,
      subtitle: "Suggested order for today",
      body: result.text,
      url: `${ctx.appUrl}/tasks`,
      note: "Daily plan — turn this off in Settings → Features.",
    },
    channels,
  );

  return {
    user_id: userId,
    status: "sent",
    plan: result.text,
    tool_calls: result.calls.length,
    turns: result.turns,
    usage: result.usage,
    delivery,
  };
}

/**
 * The planner's brief.
 *
 * Insistently read-only in tone as well as in permissions: it is told it cannot change
 * anything, because a model that believes it just rescheduled something will say so, and
 * a plan that claims to have moved a meeting it did not move is worse than no plan.
 */
function planPrompt(tz: string, morningTime: string, today: string): string {
  return `You are writing one short daily plan for the owner of Daily Edge. It is ${today},
their local morning (${morningTime}, ${tz}). They will read this as a notification, before
they have opened anything.

Call list_tasks and get_brief first. You may also call my_news. You cannot change anything —
you have no write tools — so never claim to have rescheduled, completed or created anything.

Write at most 120 words, plain text, no markdown:
- Open with the single most important thing today, and why.
- Then a suggested order for the rest, overdue items first. Group them if there are many.
- If there is nothing due, say so in one line and stop. Do not invent work.
- Close with one sentence from their news only if it genuinely bears on their day.

Write to them, not about them: "Start with the client interview prep", not "The user should".`;
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error(err);
    return json({ error: err instanceof Error ? err.message : "plan-day failed" }, 500);
  }
});
