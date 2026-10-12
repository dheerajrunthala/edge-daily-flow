// telegram-webhook — the bot's front door. @DailyEdgeAppBot.
//
// Telegram posts every update here with no JWT, so verify_jwt is off and the handler
// authenticates the *request* against TELEGRAM_WEBHOOK_SECRET (the secret_token given to
// setWebhook, echoed back in x-telegram-bot-api-secret-token) and the *user* by looking
// the chat_id up in telegram_links. An unlinked chat can do nothing but /start.
//
// What it does:
//   /start <code>   consume a one-time code minted by request_telegram_link()
//   /today /tasks   read-only views of the user's own rows
//   /brief          today's digest, already written by build-digests
//   /help
//   free text       -> _shared/parse-tasks.ts -> rows in `tasks` (no preview step here)
//   buttons         Done / Snooze 1h / Tomorrow on a reminder card
//
// It also registers itself: POST {"register": true} with a valid x-cron-secret calls
// setWebhook, so the bot token never has to leave the platform's secret store.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { GeminiError } from "../_shared/gemini.ts";
import { parseTasks } from "../_shared/parse-tasks.ts";
import { HttpError, hasCronSecret, json, serviceClient } from "../_shared/supabase.ts";
import {
  answerCallback,
  botUsername,
  editMessageText,
  getWebhookInfo,
  sendMessage,
  setWebhook,
  tgEscape,
  type TelegramUpdate,
} from "../_shared/telegram.ts";
import {
  TASK_COLUMNS,
  completeTask,
  describeDue,
  moveToTomorrow,
  snoozeTask,
  type TaskRow,
} from "../_shared/tasks.ts";
import { dayKey, isValidTimezone, startOfDayUtc } from "../_shared/time.ts";

const DEFAULT_TZ = "Asia/Kolkata";
const SNOOZE_MS = 3_600_000;
/** Keep a chat reply readable; the app is one tap away for the full list. */
const MAX_TASKS_SHOWN = 15;
const MAX_NEWS_SHOWN = 8;

type LinkedUser = { userId: string; timezone: string; chatId: number };

// ------------------------------------------------------------------ entry

Deno.serve(async (req: Request) => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST");
    const admin = serviceClient();
    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Admin path: registration, authenticated with the cron secret the same way the
    // scheduled functions are, so it can be driven from invoke_edge_function().
    if (raw.register === true || raw.info === true) {
      if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");
      return json(await administer(raw.register === true));
    }

    if (!validSecret(req)) throw new HttpError(401, "Bad webhook secret");

    // From here on, always answer 200: a non-200 makes Telegram redeliver the update, and
    // a bug that fails every time would turn into an endless retry loop.
    try {
      await route(admin, raw as unknown as TelegramUpdate);
    } catch (e) {
      console.error("telegram-webhook update failed", e instanceof Error ? e.message : e);
    }
    return json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("telegram-webhook failed", err);
    return json({ error: "telegram-webhook failed" }, 500);
  }
});

/** Constant-time-ish comparison of Telegram's echoed secret header. */
function validSecret(req: Request): boolean {
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || !got || expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function administer(register: boolean): Promise<Record<string, unknown>> {
  if (!register) return { info: await getWebhookInfo() };

  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!base) throw new HttpError(500, "SUPABASE_URL is not set");
  if (!secret) throw new HttpError(500, "TELEGRAM_WEBHOOK_SECRET is not set");

  const url = `${base}/functions/v1/telegram-webhook`;
  const result = await setWebhook(url, secret);
  console.log(`telegram setWebhook -> ${url}`);
  return { registered: url, bot: botUsername(), result, info: await getWebhookInfo() };
}

async function route(admin: SupabaseClient, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) return await onCallback(admin, update);
  const message = update.message;
  if (!message?.text || !message.chat?.id) return;
  await onMessage(admin, message.chat.id, message.text.trim());
}

// ------------------------------------------------------------------ identity

async function linkedUser(admin: SupabaseClient, chatId: number): Promise<LinkedUser | null> {
  const { data, error } = await admin
    .from("telegram_links")
    .select("user_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("timezone")
    .eq("id", data.user_id)
    .maybeSingle();
  const tz = profile?.timezone && isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ;
  return { userId: data.user_id, timezone: tz, chatId };
}

/**
 * Consume a /start code. The code is single-use and expires in 15 minutes, so a deep link
 * sitting in someone's chat history cannot later hand them the account.
 */
async function consumeCode(
  admin: SupabaseClient,
  code: string,
  chatId: number,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const { data, error } = await admin
    .from("telegram_links")
    .select("user_id, code_expires_at")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, reason: "That link code isn't valid any more." };
  if (data.code_expires_at && new Date(data.code_expires_at) < new Date()) {
    return { ok: false, reason: "That link code has expired — tap Connect Telegram again." };
  }

  // Another account already owning this chat_id would violate the unique index; clear it
  // first so re-linking a chat to a different account works instead of erroring.
  await admin
    .from("telegram_links")
    .update({ chat_id: null, linked_at: null })
    .eq("chat_id", chatId)
    .neq("user_id", data.user_id);

  const { error: upErr } = await admin
    .from("telegram_links")
    .update({
      chat_id: chatId,
      code: null,
      code_expires_at: null,
      linked_at: new Date().toISOString(),
    })
    .eq("user_id", data.user_id);
  if (upErr) throw upErr;

  // Linking is the user asking for notifications here, so turn the channel on.
  const { data: prefs } = await admin
    .from("notification_prefs")
    .select("channels")
    .eq("user_id", data.user_id)
    .maybeSingle();
  const channels = new Set<string>(prefs?.channels ?? ["email"]);
  channels.add("telegram");
  await admin
    .from("notification_prefs")
    .upsert({ user_id: data.user_id, channels: [...channels] }, { onConflict: "user_id" });

  return { ok: true, userId: data.user_id };
}

// ------------------------------------------------------------------ messages

const HELP = [
  "<b>Daily Edge</b>",
  "",
  "Just type what you need to do — “call the plumber tomorrow 5pm, remind me 15 min before” — and I'll turn it into a task.",
  "",
  "<b>/today</b> — what's due today",
  "<b>/tasks</b> — everything open",
  "<b>/brief</b> — today's news brief",
  "<b>/help</b> — this message",
].join("\n");

async function onMessage(admin: SupabaseClient, chatId: number, text: string): Promise<void> {
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, "");

  if (command === "/start") {
    const code = rest.join("").trim();
    if (!code) {
      const user = await linkedUser(admin, chatId);
      await sendMessage(
        chatId,
        user
          ? `You're already connected.\n\n${HELP}`
          : "Open Daily Edge → Settings → <b>Connect Telegram</b> and tap the link there to connect this chat.",
      );
      return;
    }
    const result = await consumeCode(admin, code, chatId);
    await sendMessage(
      chatId,
      result.ok
        ? `✅ Connected. Reminders will come here too.\n\n${HELP}`
        : `⚠️ ${tgEscape(result.reason)}`,
    );
    return;
  }

  const user = await linkedUser(admin, chatId);
  if (!user) {
    await sendMessage(
      chatId,
      "This chat isn't connected to a Daily Edge account yet. Open the app → Settings → <b>Connect Telegram</b>.",
    );
    return;
  }

  if (command === "/help") return void (await sendMessage(chatId, HELP));
  if (command === "/today") return void (await sendMessage(chatId, await todayText(admin, user)));
  if (command === "/tasks") return void (await sendMessage(chatId, await tasksText(admin, user)));
  if (command === "/brief")
    return void (await sendMessage(chatId, await briefText(admin, user), { preview: false }));
  if (command.startsWith("/")) {
    await sendMessage(chatId, `Unknown command.\n\n${HELP}`);
    return;
  }

  await createFromText(admin, user, text);
}

/** Free text becomes tasks directly: there is no preview step in a chat. */
async function createFromText(
  admin: SupabaseClient,
  user: LinkedUser,
  text: string,
): Promise<void> {
  let parsed;
  try {
    parsed = await parseTasks(admin, { userId: user.userId, text });
  } catch (e) {
    if (e instanceof HttpError) {
      await sendMessage(user.chatId, `⚠️ ${tgEscape(e.message)}`);
      return;
    }
    if (e instanceof GeminiError) {
      await sendMessage(user.chatId, "⚠️ The AI model is busy right now. Try again in a moment.");
      return;
    }
    throw e;
  }

  if (parsed.tasks.length === 0) {
    await sendMessage(user.chatId, "I couldn't find a task in that. Try “pay rent on the 1st”.");
    return;
  }

  const rows = parsed.tasks.map((t) => ({ ...t, user_id: user.userId, source: "ai" }));
  const { data, error } = await admin
    .from("tasks")
    .insert(rows)
    .select("id, title, due_at, all_day");
  if (error) throw error;

  const lines = (data ?? []).map((t) => {
    const when = t.due_at ? describeDue(t.due_at, t.all_day, user.timezone) : "someday";
    return `✅ <b>${tgEscape(t.title)}</b>\n    ${tgEscape(when)}`;
  });
  await sendMessage(user.chatId, lines.join("\n"));
}

// ------------------------------------------------------------------ views

function taskLine(
  task: { title: string; due_at: string | null; all_day: boolean; priority: string },
  tz: string,
): string {
  const when = task.due_at ? describeDue(task.due_at, task.all_day, tz) : "someday";
  const flag = task.priority === "high" ? " ❗" : "";
  return `• <b>${tgEscape(task.title)}</b>${flag}\n    ${tgEscape(when)}`;
}

async function todayText(admin: SupabaseClient, user: LinkedUser): Promise<string> {
  const start = startOfDayUtc(new Date(), user.timezone);
  const end = new Date(start.getTime() + 86_400_000);

  const { data, error } = await admin
    .from("tasks")
    .select("title, due_at, all_day, priority")
    .eq("user_id", user.userId)
    .eq("status", "todo")
    .gte("due_at", start.toISOString())
    .lt("due_at", end.toISOString())
    .order("due_at", { ascending: true })
    .limit(MAX_TASKS_SHOWN);
  if (error) throw error;

  if (!data?.length) return "Nothing due today. 🎉";
  return [`<b>Today</b>`, ...data.map((t) => taskLine(t, user.timezone))].join("\n");
}

async function tasksText(admin: SupabaseClient, user: LinkedUser): Promise<string> {
  const { data, error } = await admin
    .from("tasks")
    .select("title, due_at, all_day, priority")
    .eq("user_id", user.userId)
    .eq("status", "todo")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(MAX_TASKS_SHOWN);
  if (error) throw error;

  if (!data?.length) return "No open tasks. 🎉";
  const now = new Date();
  const overdue = data.filter((t) => t.due_at && new Date(t.due_at) < now);
  const ahead = data.filter((t) => !overdue.includes(t));

  const out: string[] = [];
  if (overdue.length) {
    out.push("<b>Overdue</b>", ...overdue.map((t) => taskLine(t, user.timezone)));
  }
  if (ahead.length) {
    if (out.length) out.push("");
    out.push("<b>Open</b>", ...ahead.map((t) => taskLine(t, user.timezone)));
  }
  return out.join("\n");
}

async function briefText(admin: SupabaseClient, user: LinkedUser): Promise<string> {
  const today = dayKey(new Date(), user.timezone);
  const { data: digest, error } = await admin
    .from("digests")
    .select("id, summary, items_count, digest_date")
    .eq("user_id", user.userId)
    .eq("digest_date", today)
    .maybeSingle();
  if (error) throw error;
  if (!digest) return "Today's brief isn't ready yet — it's built early each morning.";

  const { data: items } = await admin
    .from("news_items")
    .select("headline, url, source, category, url_resolved")
    .eq("digest_id", digest.id)
    .order("rank", { ascending: true, nullsFirst: false })
    .limit(MAX_NEWS_SHOWN);

  const out = [`<b>Your brief · ${tgEscape(today)}</b>`];
  if (digest.summary) out.push("", tgEscape(digest.summary));
  for (const item of items ?? []) {
    const via = item.url_resolved ? (item.source ?? "") : "via Google News";
    out.push("", `• <a href="${tgEscape(item.url)}">${tgEscape(item.headline)}</a>`);
    if (via) out.push(`    <i>${tgEscape(via)}</i>`);
  }
  if ((digest.items_count ?? 0) > MAX_NEWS_SHOWN) {
    out.push("", `<i>…and ${digest.items_count - MAX_NEWS_SHOWN} more in the app.</i>`);
  }
  return out.join("\n");
}

// ------------------------------------------------------------------ buttons

async function onCallback(admin: SupabaseClient, update: TelegramUpdate): Promise<void> {
  const cq = update.callback_query!;
  const chatId = cq.message?.chat.id;
  const [action, taskId] = (cq.data ?? "").split(":");

  if (!chatId || !taskId) return void (await answerCallback(cq.id, "Sorry, that button expired."));

  const user = await linkedUser(admin, chatId);
  if (!user) return void (await answerCallback(cq.id, "This chat isn't connected."));

  // Scoped to the user: a guessed task id from another account must not be actionable.
  const { data: task, error } = await admin
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("id", taskId)
    .eq("user_id", user.userId)
    .maybeSingle();
  if (error) throw error;
  if (!task) return void (await answerCallback(cq.id, "That task is gone."));

  const row = task as TaskRow;
  let toast: string;
  let suffix: string;

  if (action === "done") {
    const { rolledTo } = await completeTask(admin, row, user.timezone);
    toast = rolledTo ? "Done — next one scheduled" : "Done";
    suffix = rolledTo
      ? `✅ Done · next on ${tgEscape(describeDue(rolledTo, row.all_day, user.timezone))}`
      : "✅ Done";
  } else if (action === "snooze") {
    const until = new Date(Date.now() + SNOOZE_MS);
    await snoozeTask(admin, row.id, until);
    toast = "Snoozed for an hour";
    suffix = `💤 Snoozed until ${tgEscape(describeDue(until.toISOString(), false, user.timezone))}`;
  } else if (action === "tomorrow") {
    const next = await moveToTomorrow(admin, row, user.timezone);
    toast = "Moved to tomorrow";
    suffix = `→ Moved to ${tgEscape(describeDue(next, row.all_day, user.timezone))}`;
  } else {
    return void (await answerCallback(cq.id, "Unknown action."));
  }

  await answerCallback(cq.id, toast);
  // Rewrite the card so the spent buttons disappear and the chat shows what happened.
  if (cq.message) {
    await editMessageText(
      chatId,
      cq.message.message_id,
      `<b>${tgEscape(row.title)}</b>\n${suffix}`,
    ).catch((e) => console.error("editMessageText failed", e instanceof Error ? e.message : e));
  }
}
