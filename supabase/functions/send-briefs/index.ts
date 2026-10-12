// send-briefs — email each user their daily brief. Cron every 15 minutes.
//
// Every tick: for each user with news_prefs.enabled, is one of their email_times inside
// the current 15-minute window *in their own timezone*, and has that slot not been sent
// today? If so, build the brief from what is already in the database — today's digest,
// their tasks, upcoming birthdays — and email it. No Gemini call: the "at a glance" line
// was written once by build-digests.
//
// Idempotency is the brief_sends unique constraint, claimed *before* the send: two
// overlapping ticks cannot both email the same slot.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  CORS_HEADERS,
  HttpError,
  hasCronSecret,
  json,
  serviceClient,
} from "../_shared/supabase.ts";
import { S, escapeHtml, sendMail, wrap } from "../_shared/email.ts";
import { dayKey, isValidTimezone, partsInTz, startOfDayUtc } from "../_shared/time.ts";

const DEFAULT_TZ = "Asia/Kolkata";
/** The cron cadence. An email_time lands in exactly one of these windows per day. */
const SLOT_MINUTES = 15;
/** Birthdays are called out this far ahead. */
const BIRTHDAY_HORIZON_DAYS = 7;

type Prefs = {
  user_id: string;
  categories: string[];
  email_times: string[];
  timezone: string;
  full_name: string | null;
};

type NewsRow = {
  category: string;
  headline: string;
  summary: string;
  why_it_matters: string | null;
  url: string;
  source: string | null;
  url_resolved: boolean;
  rank: number | null;
  related_item_id: string | null;
};

type TaskRow = {
  id: string;
  title: string;
  due_at: string | null;
  all_day: boolean;
  priority: string;
  tags: string[];
  recurrence: string;
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");

  const started = Date.now();
  const admin = serviceClient();
  const body = await readBody(req);
  const now = new Date();

  const users = await targetUsers(admin, body.user_id);
  const report: Record<string, unknown>[] = [];
  let sent = 0;

  for (const prefs of users) {
    const slot = body.slot ?? dueSlot(prefs, now);
    if (!slot) continue;
    const today = dayKey(now, prefs.timezone);
    let claimed = false;

    try {
      claimed = await claimSlot(admin, prefs.user_id, today, slot);
      if (!claimed) {
        report.push({ user_id: prefs.user_id, slot, status: "already sent" });
        continue;
      }

      const result = await sendBrief(admin, prefs, today, slot, now);
      if (result.status === "sent") sent++;
      report.push({ user_id: prefs.user_id, slot, ...result });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`send-briefs failed for ${prefs.user_id}`, message);
      // Hand the slot back. Without this, one SMTP hiccup would mark the slot as sent
      // and the user would silently get no brief at all today.
      if (claimed) await releaseSlot(admin, prefs.user_id, today, slot);
      report.push({ user_id: prefs.user_id, slot, status: "failed", error: message });
    }
  }

  const runtime_ms = Date.now() - started;
  if (report.length > 0) console.log(`send-briefs: ${sent} sent in ${runtime_ms}ms`);
  return json({ ok: true, runtime_ms, sent, considered: users.length, users: report });
}

async function readBody(req: Request): Promise<{ user_id?: string; slot?: string }> {
  try {
    const raw = (await req.json()) as { user_id?: unknown; slot?: unknown };
    return {
      user_id: typeof raw?.user_id === "string" ? raw.user_id : undefined,
      // An explicit slot is for manual sends; it still goes through brief_sends.
      slot:
        typeof raw?.slot === "string" && /^[0-2]\d:[0-5]\d$/.test(raw.slot) ? raw.slot : undefined,
    };
  } catch {
    return {};
  }
}

/** news_prefs and profiles have no FK between them, so this is two queries. */
async function targetUsers(admin: SupabaseClient, onlyUser?: string): Promise<Prefs[]> {
  let query = admin
    .from("news_prefs")
    .select("user_id, categories, email_times")
    .eq("enabled", true);
  if (onlyUser) query = query.eq("user_id", onlyUser);

  const { data: prefs, error } = await query;
  if (error) throw error;
  if (!prefs || prefs.length === 0) return [];

  const { data: profiles, error: profileError } = await admin
    .from("profiles")
    .select("id, timezone, full_name")
    .in(
      "id",
      prefs.map((p: { user_id: string }) => p.user_id),
    );
  if (profileError) throw profileError;
  const byId = new Map(
    (profiles ?? []).map((p: { id: string; timezone: string | null; full_name: string | null }) => [
      p.id,
      p,
    ]),
  );

  return prefs.map((row: Record<string, unknown>) => {
    const profile = byId.get(row.user_id as string);
    return {
      user_id: row.user_id as string,
      categories: (row.categories ?? []) as string[],
      email_times: (row.email_times ?? []) as string[],
      timezone:
        profile?.timezone && isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ,
      full_name: profile?.full_name ?? null,
    };
  });
}

/**
 * The user's email_time that falls inside the current window, in their timezone.
 * Returns null when this tick is not their time.
 */
function dueSlot(prefs: Prefs, now: Date): string | null {
  const { h, min } = partsInTz(now, prefs.timezone);
  const windowStart = Math.floor((h * 60 + min) / SLOT_MINUTES) * SLOT_MINUTES;
  for (const slot of prefs.email_times) {
    const m = /^([0-2]\d):([0-5]\d)$/.exec(slot.trim());
    if (!m) continue;
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    if (minutes >= windowStart && minutes < windowStart + SLOT_MINUTES) return slot.trim();
  }
  return null;
}

/**
 * Insert the brief_sends row first and treat a unique violation as "someone else has
 * this slot". Claiming before sending means a crash can cost one brief, which is far
 * better than a duplicate landing in the user's inbox.
 */
async function claimSlot(
  admin: SupabaseClient,
  userId: string,
  sentFor: string,
  slot: string,
): Promise<boolean> {
  const { error } = await admin
    .from("brief_sends")
    .insert({ user_id: userId, sent_for: sentFor, slot });
  if (!error) return true;
  if (error.code === "23505") return false; // unique_violation
  throw error;
}

async function releaseSlot(
  admin: SupabaseClient,
  userId: string,
  sentFor: string,
  slot: string,
): Promise<void> {
  const { error } = await admin
    .from("brief_sends")
    .delete()
    .eq("user_id", userId)
    .eq("sent_for", sentFor)
    .eq("slot", slot);
  if (error) console.error("could not release brief slot", error.message);
}

async function sendBrief(
  admin: SupabaseClient,
  prefs: Prefs,
  today: string,
  slot: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(prefs.user_id);
  if (userError || !userData.user?.email) {
    throw new Error(`no auth email for ${prefs.user_id}`);
  }
  const to = userData.user.email;

  const { data: digest } = await admin
    .from("digests")
    .select("id, summary, items_count")
    .eq("user_id", prefs.user_id)
    .eq("digest_date", today)
    .eq("status", "ready")
    .maybeSingle();

  const news = digest ? await newsItems(admin, digest.id) : [];
  const tasks = await taskSets(admin, prefs, now);

  // Nothing to say is a reason not to send, not a reason to send an empty email.
  if (news.length === 0 && tasks.today.length === 0 && tasks.overdue.length === 0) {
    await releaseSlot(admin, prefs.user_id, today, slot);
    return { status: "skipped", reason: "nothing to send" };
  }

  const built = buildBrief(prefs, digest?.summary ?? null, news, tasks, now);
  await sendMail({ to, subject: built.subject, html: built.html, text: built.text });

  if (digest?.id) {
    await admin
      .from("brief_sends")
      .update({ digest_id: digest.id })
      .eq("user_id", prefs.user_id)
      .eq("sent_for", today)
      .eq("slot", slot);
    // emailed_at marks the digest as delivered at least once.
    await admin
      .from("digests")
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", digest.id)
      .is("emailed_at", null);
  }

  return {
    status: "sent",
    items: news.length,
    tasks_today: tasks.today.length,
    overdue: tasks.overdue.length,
    birthdays: tasks.birthdays.length,
  };
}

async function newsItems(admin: SupabaseClient, digestId: string): Promise<NewsRow[]> {
  const { data, error } = await admin
    .from("news_items")
    .select(
      "category, headline, summary, why_it_matters, url, source, url_resolved, rank, related_item_id",
    )
    .eq("digest_id", digestId)
    .order("rank", { ascending: true });
  if (error) throw error;
  return (data ?? []) as NewsRow[];
}

async function taskSets(
  admin: SupabaseClient,
  prefs: Prefs,
  now: Date,
): Promise<{ today: TaskRow[]; overdue: TaskRow[]; birthdays: TaskRow[] }> {
  const startOfToday = startOfDayUtc(now, prefs.timezone);
  const endOfToday = new Date(startOfToday.getTime() + 86_400_000);
  const horizon = new Date(startOfToday.getTime() + BIRTHDAY_HORIZON_DAYS * 86_400_000);

  const columns = "id, title, due_at, all_day, priority, tags, recurrence";

  const [todayRes, overdueRes, birthdayRes] = await Promise.all([
    admin
      .from("tasks")
      .select(columns)
      .eq("user_id", prefs.user_id)
      .eq("status", "todo")
      .gte("due_at", startOfToday.toISOString())
      .lt("due_at", endOfToday.toISOString())
      .order("due_at", { ascending: true }),
    admin
      .from("tasks")
      .select(columns)
      .eq("user_id", prefs.user_id)
      .eq("status", "todo")
      .lt("due_at", startOfToday.toISOString())
      .order("due_at", { ascending: true })
      .limit(10),
    // Birthdays are yearly tasks tagged "Birthday" (see CLAUDE.md), and the roll-forward
    // keeps due_at on the next occurrence, so a plain range query finds them.
    admin
      .from("tasks")
      .select(columns)
      .eq("user_id", prefs.user_id)
      .eq("recurrence", "yearly")
      .contains("tags", ["Birthday"])
      .gte("due_at", startOfToday.toISOString())
      .lt("due_at", horizon.toISOString())
      .order("due_at", { ascending: true }),
  ]);

  for (const r of [todayRes, overdueRes, birthdayRes]) if (r.error) throw r.error;
  return {
    today: (todayRes.data ?? []) as TaskRow[],
    overdue: (overdueRes.data ?? []) as TaskRow[],
    birthdays: (birthdayRes.data ?? []) as TaskRow[],
  };
}

function buildBrief(
  prefs: Prefs,
  atAGlance: string | null,
  news: NewsRow[],
  tasks: { today: TaskRow[]; overdue: TaskRow[]; birthdays: TaskRow[] },
  now: Date,
): { subject: string; html: string; text: string } {
  const tz = prefs.timezone;
  const dateLabel = new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(now);
  const first = (prefs.full_name ?? "").trim().split(/\s+/)[0];

  const html: string[] = [];
  const text: string[] = [];

  html.push(`<h1 style="${S.h1}">Your Daily Edge</h1>`);
  html.push(`<p style="${S.sub}">${escapeHtml(dateLabel)}</p>`);
  text.push(`YOUR DAILY EDGE — ${dateLabel}`);

  if (atAGlance) {
    html.push(`<div style="${S.glance}">${escapeHtml(atAGlance)}</div>`);
    text.push(`\nAT A GLANCE\n${atAGlance}`);
  }

  if (tasks.today.length > 0) {
    html.push(`<h2 style="${S.h2}">Today</h2>`);
    text.push(`\nTODAY`);
    for (const t of tasks.today) {
      const when = t.all_day ? "" : ` · ${timeLabel(t.due_at, tz)}`;
      const flag = t.priority === "high" ? " · high" : "";
      html.push(
        `<p style="${S.task}">${escapeHtml(t.title)}` +
          `<span style="${S.taskMeta}">${escapeHtml(when + flag)}</span></p>`,
      );
      text.push(`- ${t.title}${when}${flag}`);
    }
  }

  if (tasks.overdue.length > 0) {
    html.push(`<h2 style="${S.h2}">Overdue</h2>`);
    text.push(`\nOVERDUE`);
    for (const t of tasks.overdue) {
      const when = dateOnlyLabel(t.due_at, tz);
      html.push(
        `<p style="${S.task}">${escapeHtml(t.title)}` +
          `<span style="${S.taskMeta}"> · ${escapeHtml(when)}</span></p>`,
      );
      text.push(`- ${t.title} · ${when}`);
    }
  }

  if (tasks.birthdays.length > 0) {
    html.push(`<h2 style="${S.h2}">Birthdays this week</h2>`);
    text.push(`\nBIRTHDAYS THIS WEEK`);
    for (const t of tasks.birthdays) {
      const when = dateOnlyLabel(t.due_at, tz);
      html.push(
        `<p style="${S.task}">${escapeHtml(t.title)}` +
          `<span style="${S.taskMeta}"> · ${escapeHtml(when)}</span></p>`,
      );
      text.push(`- ${t.title} · ${when}`);
    }
  }

  // Digest, grouped by category but keeping the model's ranking inside each group.
  const byCategory = new Map<string, NewsRow[]>();
  for (const item of news) {
    const group = byCategory.get(item.category);
    if (group) group.push(item);
    else byCategory.set(item.category, [item]);
  }
  for (const [category, items] of byCategory) {
    html.push(`<h2 style="${S.h2}">${escapeHtml(category)}</h2>`);
    text.push(`\n${category.toUpperCase()}`);
    for (const item of items) {
      const via = item.url_resolved ? "" : " · via Google News";
      html.push(
        `<div style="${S.item}">` +
          `<p style="${S.headline}">` +
          `<a href="${escapeHtml(item.url)}" style="${S.link}">${escapeHtml(item.headline)}</a>` +
          `</p>` +
          `<p style="${S.meta}">${escapeHtml((item.source ?? "") + via)}</p>` +
          (item.why_it_matters
            ? `<p style="${S.why}">${escapeHtml(item.why_it_matters)}</p>`
            : `<p style="${S.why}">${escapeHtml(item.summary)}</p>`) +
          `</div>`,
      );
      text.push(`- ${item.headline}${via}\n  ${item.url}`);
      if (item.why_it_matters) text.push(`  Why: ${item.why_it_matters}`);
    }
  }

  const note =
    news.length > 0 ? `${news.length} stories, picked for you.` : "Your tasks for today.";
  const subject = `Daily Edge${first ? ` for ${first}` : ""} — ${dateLabel}`;
  return {
    subject,
    html: wrap(subject, html.join(""), note),
    text: `${text.join("\n")}\n\n${note}\nChange your times or turn this off: ${settingsUrl()}\n`,
  };
}

function settingsUrl(): string {
  return `${(Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "")}/settings`;
}

function timeLabel(iso: string | null, tz: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function dateOnlyLabel(iso: string | null, tz: string): string {
  if (!iso) return "someday";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error("send-briefs failed", err);
    return json({ error: err instanceof Error ? err.message : "send-briefs failed" }, 500);
  }
});
