// check-reminders — a short email when a task's reminder comes due. Cron every 15 min.
//
// A task is due for a reminder when `due_at - remind_before <= now()`, it is still todo,
// and it has not already been reminded *for this occurrence*. That last part is what
// last_reminded_at is for: recurring tasks roll due_at forward on completion, so a
// timestamp older than the current due_at means "reminded for a previous occurrence".

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
import { isValidTimezone } from "../_shared/time.ts";

const DEFAULT_TZ = "Asia/Kolkata";
/**
 * Don't email about something that came due long ago — if the function was down for a
 * day, the user wants their tasks, not a backlog of stale alarms.
 */
const MAX_LATENESS_HOURS = 6;
/** Per-user cap per tick, so one over-scheduled day cannot become twenty emails. */
const MAX_PER_USER = 5;

type TaskRow = {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  due_at: string;
  all_day: boolean;
  priority: string;
  remind_before: string | null;
  last_reminded_at: string | null;
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");

  const started = Date.now();
  const admin = serviceClient();
  const body = await readBody(req);
  const now = new Date();

  const due = await dueReminders(admin, now, body.user_id);
  if (due.length === 0) {
    return json({ ok: true, runtime_ms: Date.now() - started, sent: 0, due: 0 });
  }

  // Group by user so one person's burst stays inside MAX_PER_USER and we look their
  // email and timezone up once.
  const byUser = new Map<string, TaskRow[]>();
  for (const task of due) {
    const list = byUser.get(task.user_id);
    if (list) list.push(task);
    else byUser.set(task.user_id, [task]);
  }

  let sent = 0;
  const report: Record<string, unknown>[] = [];

  for (const [userId, tasks] of byUser) {
    try {
      const { email, timezone } = await recipient(admin, userId);
      for (const task of tasks.slice(0, MAX_PER_USER)) {
        const built = buildReminder(task, timezone);
        await sendMail({ to: email, subject: built.subject, html: built.html, text: built.text });
        // Stamp only after the send succeeds, so a failure is retried next tick.
        const { error } = await admin
          .from("tasks")
          .update({ last_reminded_at: new Date().toISOString() })
          .eq("id", task.id);
        if (error) throw error;
        sent++;
      }
      report.push({ user_id: userId, reminded: Math.min(tasks.length, MAX_PER_USER) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`check-reminders failed for ${userId}`, message);
      report.push({ user_id: userId, status: "failed", error: message });
    }
  }

  const runtime_ms = Date.now() - started;
  console.log(`check-reminders: ${sent} sent in ${runtime_ms}ms`);
  return json({ ok: true, runtime_ms, sent, due: due.length, users: report });
}

async function readBody(req: Request): Promise<{ user_id?: string }> {
  try {
    const raw = (await req.json()) as { user_id?: unknown };
    return { user_id: typeof raw?.user_id === "string" ? raw.user_id : undefined };
  } catch {
    return {};
  }
}

/**
 * Tasks whose reminder has come due. `remind_before` is an interval, so the comparison
 * has to happen in Postgres — hence the RPC-free filter here plus the final check in JS
 * for the per-occurrence condition, which PostgREST cannot express.
 */
async function dueReminders(
  admin: SupabaseClient,
  now: Date,
  onlyUser?: string,
): Promise<TaskRow[]> {
  const horizon = new Date(now.getTime() - MAX_LATENESS_HOURS * 3_600_000);

  let query = admin
    .from("tasks")
    .select("id, user_id, title, notes, due_at, all_day, priority, remind_before, last_reminded_at")
    .eq("status", "todo")
    .not("remind_before", "is", null)
    .not("due_at", "is", null)
    // Cheap bound: anything whose due_at is already far past is out of scope, and
    // anything more than a few days out cannot be due yet for any sane remind_before.
    .gte("due_at", horizon.toISOString())
    .lte("due_at", new Date(now.getTime() + 8 * 86_400_000).toISOString())
    .order("due_at", { ascending: true })
    .limit(200);
  if (onlyUser) query = query.eq("user_id", onlyUser);

  const { data, error } = await query;
  if (error) throw error;

  return ((data ?? []) as TaskRow[]).filter((task) => {
    const dueAt = new Date(task.due_at).getTime();
    const lead = parseInterval(task.remind_before);
    if (lead === null) return false;

    const fireAt = dueAt - lead;
    if (fireAt > now.getTime()) return false; // not yet
    if (fireAt < horizon.getTime()) return false; // too late to be useful

    // Already reminded for this occurrence? last_reminded_at is reset implicitly by the
    // recurrence roll-forward moving due_at past it.
    if (task.last_reminded_at && new Date(task.last_reminded_at).getTime() >= fireAt) {
      return false;
    }
    return true;
  });
}

/**
 * Postgres interval text to milliseconds. PostgREST renders `remind_before` either as
 * "HH:MM:SS" or as "N days" / "N days HH:MM:SS" depending on the value, which is why
 * both shapes are handled here.
 */
export function parseInterval(value: string | null): number | null {
  if (!value) return null;
  let ms = 0;
  let matched = false;

  const days = /(-?\d+)\s+days?/.exec(value);
  if (days) {
    ms += Number(days[1]) * 86_400_000;
    matched = true;
  }
  const clock = /(\d{1,2}):(\d{2}):(\d{2})/.exec(value);
  if (clock) {
    ms += (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000;
    matched = true;
  }
  const hours = /(-?\d+)\s+hours?/.exec(value);
  if (!clock && hours) {
    ms += Number(hours[1]) * 3_600_000;
    matched = true;
  }
  const mins = /(-?\d+)\s+mins?(?:utes?)?/.exec(value);
  if (!clock && mins) {
    ms += Number(mins[1]) * 60_000;
    matched = true;
  }
  return matched ? ms : null;
}

async function recipient(
  admin: SupabaseClient,
  userId: string,
): Promise<{ email: string; timezone: string }> {
  const { data: userData, error } = await admin.auth.admin.getUserById(userId);
  if (error || !userData.user?.email) throw new Error(`no auth email for ${userId}`);

  const { data: profile } = await admin
    .from("profiles")
    .select("timezone")
    .eq("id", userId)
    .maybeSingle();
  const tz = profile?.timezone && isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ;
  return { email: userData.user.email, timezone: tz };
}

function buildReminder(task: TaskRow, tz: string): { subject: string; html: string; text: string } {
  const when = task.all_day
    ? new Intl.DateTimeFormat("en-IN", { timeZone: tz, day: "numeric", month: "long" }).format(
        new Date(task.due_at),
      )
    : new Intl.DateTimeFormat("en-IN", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
        day: "numeric",
        month: "short",
      }).format(new Date(task.due_at));

  const inner =
    `<h1 style="${S.h1}">${escapeHtml(task.title)}</h1>` +
    `<p style="${S.sub}">Due ${escapeHtml(when)}${task.priority === "high" ? " · high priority" : ""}</p>` +
    (task.notes ? `<p style="${S.why}">${escapeHtml(task.notes)}</p>` : "") +
    `<p style="${S.task}"><a href="${escapeHtml(tasksUrl())}" style="${S.link}">Open your tasks →</a></p>`;

  const text =
    `${task.title}\nDue ${when}${task.priority === "high" ? " (high priority)" : ""}\n` +
    (task.notes ? `\n${task.notes}\n` : "") +
    `\nOpen your tasks: ${tasksUrl()}\n`;

  return {
    subject: `Reminder: ${task.title}`,
    html: wrap(task.title, inner, "A reminder you set in Daily Edge."),
    text: `${text}\nA reminder you set in Daily Edge.\nChange your settings: ${settingsUrl()}\n`,
  };
}

const base = () => (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
const tasksUrl = () => `${base()}/tasks`;
const settingsUrl = () => `${base()}/settings`;

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error("check-reminders failed", err);
    return json({ error: err instanceof Error ? err.message : "check-reminders failed" }, 500);
  }
});
