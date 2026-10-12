// One way to reach a user. Everything that notifies a person about a task goes through
// notify() so a new channel is a change to this file, the way every email goes through
// email.ts.
//
// Two deliberate non-responsibilities:
//
//   * Idempotency. notify() sends; it does not decide whether sending was allowed twice.
//     check-reminders owns that, in task_notifications, because only the caller knows
//     what "the same notification" means. The caller claims per channel, which is why
//     activeChannels() is exported separately from notify().
//   * Quiet hours are enforced here, not by the caller: it is a property of the user, and
//     forgetting it in one call site is exactly the bug that wakes someone at 3am.
//
// Each channel renders the same payload the way that channel works: email gets a link,
// Telegram gets inline buttons, push gets notification actions and a collapse tag. The
// caller describes *what* happened; it never writes channel markup.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { S, escapeHtml, sendMail, wrap } from "./email.ts";
import { mintActionToken, pushConfigured, sendPush, type PushSubscriptionRow } from "./push.ts";
import { sendMessage, tgEscape, type InlineButton } from "./telegram.ts";
import { clockToMinutes, intervalMs, isValidTimezone, minutesOfDay } from "./time.ts";

export const DEFAULT_TZ = "Asia/Kolkata";
/** The nag cadence when notification_prefs is missing or unreadable. */
const DEFAULT_NAG_MS = 15 * 60_000;

export type Channel = "email" | "push" | "telegram";

export type NotifyPrefs = {
  channels: Channel[];
  /** "HH:MM" wall clock in the recipient's timezone. start === end means no quiet hours. */
  quietStart: string;
  quietEnd: string;
  nagIntervalMs: number;
};

export type Recipient = {
  userId: string;
  email: string | null;
  name: string | null;
  timezone: string;
  prefs: NotifyPrefs;
  telegramChatId: number | null;
  /** Every browser that has granted this user notification permission. */
  pushSubscriptions: PushSubscriptionRow[];
};

/** A Telegram inline button. `data` is the callback_data the webhook will receive. */
export type NotifyAction = { label: string; data: string };

export type NotifyPayload = {
  /** Email subject, and the bold first line on Telegram. */
  title: string;
  /** One line of context under the title: "Due in 15 minutes". */
  subtitle?: string;
  /** The task's notes, or any longer body text. */
  body?: string | null;
  /** Where "open this" goes. Defaults to ${APP_URL}/tasks. */
  url?: string;
  /** Footer line explaining why this arrived. */
  note?: string;
  /** Telegram-only inline buttons. Email gets `url` instead. */
  actions?: NotifyAction[];
  /**
   * Set when the notification is about one task. Push grows its own Done / Snooze
   * buttons from this (a service worker cannot reuse Telegram's callback_data) and the
   * token that authorizes them is minted per notification.
   */
  taskId?: string;
  /**
   * Push collapse key. A later rung of the same ladder replaces the earlier one on screen
   * instead of stacking. Defaults to the task.
   */
  tag?: string;
};

export type ChannelResult = {
  channel: Channel;
  status: "sent" | "skipped" | "failed";
  reason?: string;
};

// ------------------------------------------------------------------ recipient

const CHANNELS: Channel[] = ["email", "push", "telegram"];

function coerceChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) return ["email"];
  const out = value.filter((c): c is Channel => CHANNELS.includes(c as Channel));
  return out;
}

/**
 * Everything notify() needs about one user, in one place: auth email, timezone, channel
 * preferences, the Telegram chat id and the subscribed browsers. Five reads in parallel,
 * but only ever on a tick where something is actually due.
 *
 * The subscriptions are loaded here rather than inside the push sender so that
 * activeChannels() can stay synchronous: "is push deliverable" is then a property of the
 * recipient, answerable before any ledger row is claimed.
 */
export async function loadRecipient(admin: SupabaseClient, userId: string): Promise<Recipient> {
  const [authRes, profileRes, prefsRes, linkRes, pushRes] = await Promise.all([
    admin.auth.admin.getUserById(userId),
    admin.from("profiles").select("timezone, full_name").eq("id", userId).maybeSingle(),
    admin
      .from("notification_prefs")
      .select("channels, quiet_start, quiet_end, nag_interval")
      .eq("user_id", userId)
      .maybeSingle(),
    admin.from("telegram_links").select("chat_id").eq("user_id", userId).maybeSingle(),
    // Skipped entirely when the project has no VAPID keys: there is nothing a
    // subscription could be used for, so the query would be pure waste.
    pushConfigured()
      ? admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId)
      : Promise.resolve({ data: [] as PushSubscriptionRow[] }),
  ]);

  const tzRaw = profileRes.data?.timezone;
  const prefs = prefsRes.data;

  return {
    userId,
    email: authRes.data?.user?.email ?? null,
    name: profileRes.data?.full_name ?? null,
    timezone: tzRaw && isValidTimezone(tzRaw) ? tzRaw : DEFAULT_TZ,
    prefs: {
      // A user with no prefs row is a user who signed up before this table existed; the
      // defaults match the column defaults rather than silently going quiet.
      channels: prefs ? coerceChannels(prefs.channels) : ["email"],
      quietStart: prefs?.quiet_start ?? "22:00",
      quietEnd: prefs?.quiet_end ?? "07:00",
      nagIntervalMs: intervalMs(prefs?.nag_interval ?? null) ?? DEFAULT_NAG_MS,
    },
    telegramChatId: linkRes.data?.chat_id ?? null,
    pushSubscriptions: (pushRes.data ?? []) as PushSubscriptionRow[],
  };
}

// ------------------------------------------------------------------ quiet hours

/**
 * Is `now` inside the recipient's quiet window? The window normally wraps midnight
 * (22:00 -> 07:00), so the wrapped case is the main branch, not an afterthought.
 */
export function inQuietHours(r: Recipient, now: Date): boolean {
  const start = clockToMinutes(r.prefs.quietStart);
  const end = clockToMinutes(r.prefs.quietEnd);
  if (start === null || end === null || start === end) return false;
  const t = minutesOfDay(now, r.timezone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/**
 * The channels a notification sent right now would actually go out on, and why the others
 * would not. Callers claim their idempotency rows against this list, so a channel the user
 * has switched off never gets a ledger row at all.
 */
export function activeChannels(
  r: Recipient,
  now: Date,
): { channels: Channel[]; skipped: ChannelResult[] } {
  const skipped: ChannelResult[] = [];

  if (inQuietHours(r, now)) {
    return {
      channels: [],
      skipped: r.prefs.channels.map((channel) => ({
        channel,
        status: "skipped" as const,
        reason: `quiet hours ${r.prefs.quietStart}-${r.prefs.quietEnd}`,
      })),
    };
  }

  const channels: Channel[] = [];
  for (const channel of r.prefs.channels) {
    const reason = unavailable(r, channel);
    if (reason) skipped.push({ channel, status: "skipped", reason });
    else channels.push(channel);
  }
  return { channels, skipped };
}

/** Why a channel the user has enabled still cannot be delivered on. */
function unavailable(r: Recipient, channel: Channel): string | null {
  if (channel === "email") return r.email ? null : "no auth email";
  if (channel === "telegram") return r.telegramChatId ? null : "telegram not linked";
  if (channel === "push") {
    if (!pushConfigured()) return "VAPID keys are not configured";
    // Permission is per browser, and revoking it happens outside the app entirely, so
    // "enabled but no subscriptions" is an ordinary state rather than a misconfiguration.
    return r.pushSubscriptions.length > 0 ? null : "no browser is subscribed";
  }
  return "unknown channel";
}

// ------------------------------------------------------------------ fan-out

/**
 * Deliver `payload` on each of `channels`. Pass the list from activeChannels() — or a
 * subset of it, which is what check-reminders does after claiming the ledger — so quiet
 * hours and availability have already been applied.
 *
 * One channel failing never stops another: the result array reports each independently
 * and the caller decides what to retry.
 */
export async function notify(
  admin: SupabaseClient,
  r: Recipient,
  payload: NotifyPayload,
  channels: Channel[],
): Promise<ChannelResult[]> {
  const results = await Promise.all(
    channels.map(async (channel): Promise<ChannelResult> => {
      try {
        if (channel === "email") await notifyEmail(r, payload);
        else if (channel === "telegram") await notifyTelegram(r, payload);
        else if (channel === "push") await notifyPush(admin, r, payload);
        else
          return { channel, status: "skipped", reason: unavailable(r, channel) ?? "unsupported" };
        return { channel, status: "sent" };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`notify(${channel}) failed for ${r.userId}`, message);
        return { channel, status: "failed", reason: message };
      }
    }),
  );
  return results;
}

const appBase = () => (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");

function targetUrl(payload: NotifyPayload): string {
  return payload.url ?? `${appBase()}/tasks`;
}

async function notifyEmail(r: Recipient, payload: NotifyPayload): Promise<void> {
  if (!r.email) throw new Error("no auth email");
  const url = targetUrl(payload);
  const note = payload.note ?? "A reminder you set in Daily Edge.";

  const inner =
    `<h1 style="${S.h1}">${escapeHtml(payload.title)}</h1>` +
    (payload.subtitle ? `<p style="${S.sub}">${escapeHtml(payload.subtitle)}</p>` : "") +
    (payload.body ? `<p style="${S.why}">${escapeHtml(payload.body)}</p>` : "") +
    `<p style="${S.task}"><a href="${escapeHtml(url)}" style="${S.link}">Open your tasks →</a></p>`;

  const text =
    `${payload.title}\n` +
    (payload.subtitle ? `${payload.subtitle}\n` : "") +
    (payload.body ? `\n${payload.body}\n` : "") +
    `\nOpen your tasks: ${url}\n\n${note}\n` +
    `Change your settings: ${appBase()}/settings\n`;

  await sendMail({
    to: r.email,
    subject: payload.subtitle ? `${payload.title} — ${payload.subtitle}` : payload.title,
    html: wrap(payload.title, inner, note),
    text,
  });
}

async function notifyTelegram(r: Recipient, payload: NotifyPayload): Promise<void> {
  if (!r.telegramChatId) throw new Error("telegram not linked");

  const lines = [`<b>${tgEscape(payload.title)}</b>`];
  if (payload.subtitle) lines.push(tgEscape(payload.subtitle));
  if (payload.body) lines.push("", tgEscape(payload.body));

  // One row of buttons: three short labels fit a phone, and stacking them is uglier.
  const buttons: InlineButton[][] | undefined = payload.actions?.length
    ? [payload.actions.map((a) => ({ text: a.label, callback_data: a.data }))]
    : undefined;

  await sendMessage(r.telegramChatId, lines.join("\n"), { buttons });
}

/**
 * Deliver to every browser this user has subscribed.
 *
 * The push payload is built here rather than taken from `payload.actions`, because a
 * service worker cannot act on Telegram's callback_data: it has no Supabase session to
 * spend. So a task-shaped notification carries its own single-task action token and the
 * URL to spend it at, and the worker needs nothing else to mark the task done.
 *
 * Two buttons, not three: Chrome renders at most two notification actions and silently
 * drops the rest, so "Tomorrow" is left to Telegram and the app rather than being the
 * button that mysteriously never appears.
 */
async function notifyPush(admin: SupabaseClient, r: Recipient, payload: NotifyPayload) {
  const token = payload.taskId ? await mintActionToken(r.userId, payload.taskId) : undefined;
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

  await sendPush(
    admin,
    r.userId,
    {
      title: payload.title,
      body: [payload.subtitle, payload.body].filter(Boolean).join("\n") || undefined,
      // A later rung replaces the earlier one on screen instead of stacking three
      // "still open" cards; the worker pairs this with renotify so it still alerts.
      tag: payload.tag ?? (payload.taskId ? `task:${payload.taskId}` : undefined),
      url: targetUrl(payload),
      // The whole point of the channel: a reminder that vanishes after four seconds is
      // not a reminder. macOS needs Chrome set to "Alerts" for this to be honoured.
      requireInteraction: true,
      ...(token
        ? {
            actions: [
              { action: "done", title: "✓ Done" },
              { action: "snooze", title: "💤 10 min" },
            ],
            actionUrl: `${supabaseUrl}/functions/v1/push-action`,
            token,
          }
        : {}),
    },
    r.pushSubscriptions,
  );
}
