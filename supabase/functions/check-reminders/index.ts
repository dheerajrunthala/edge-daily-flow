// check-reminders — the task escalation. Cron every minute.
//
// A task that opted into reminders (remind_before is set) walks a ladder of stages:
//
//   lead    the user's own remind_before
//   1h      one hour out
//   15m     fifteen minutes out
//   due     the moment it is due
//   nag:k   every nag_interval after that, while it is still open
//
// Not every channel carries every rung: email gets `lead` and `due` only, the rest are
// push-shaped (see EMAIL_STAGES / routeStage below).
//
// Each stage fires at most once per occurrence per channel, and that is enforced by rows
// in task_notifications rather than by timing: the row is claimed *before* the send, so
// two overlapping ticks cannot both notify, and deleted again if the send fails so the
// next tick retries. A recurring task rolling due_at forward starts a fresh ladder for
// free, because the ledger is keyed on due_at.
//
// Delivery itself (which channels, quiet hours) belongs to _shared/notify.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  CORS_HEADERS,
  HttpError,
  hasCronSecret,
  json,
  serviceClient,
} from "../_shared/supabase.ts";
import {
  activeChannels,
  loadRecipient,
  notify,
  type Channel,
  type NotifyPayload,
  type Recipient,
} from "../_shared/notify.ts";
import { TASK_COLUMNS, describeDue, describeGap, type TaskRow } from "../_shared/tasks.ts";
import { intervalMs } from "../_shared/time.ts";

/**
 * Don't deliver a fixed stage that came due long ago — if the function was down for a day
 * the user wants their current tasks, not a backlog of stale alarms. Nags are exempt: the
 * nag index is derived from now, so the one that fires is always the current one.
 */
const MAX_LATENESS_HOURS = 6;
/**
 * Safety rails on "nag until it's done". Unbounded nagging across every channel is how a
 * reminder app becomes something you mute: stop after two days or 24 pings, whichever
 * comes first, and let the daily brief carry it from there.
 */
const NAG_WINDOW_HOURS = 48;
const MAX_NAGS = 24;
/** Per-user cap per tick, so one over-scheduled hour cannot become twenty emails. */
const MAX_PER_USER = 5;
/** Enough to cover every task that could have a stage due this minute. */
const CANDIDATE_LIMIT = 500;

/** Postgres unique violation — a stage another tick already claimed. */
const UNIQUE_VIOLATION = "23505";

/**
 * Which stages email is allowed to carry. Email is the channel you read later, so it gets
 * the two rungs that are still news on a delay — the heads-up you asked for, and the
 * moment it came due. The in-between rungs and every nag are push-shaped: they are only
 * useful now, and an inbox full of "still open" is how a reminder app gets muted.
 */
const EMAIL_STAGES = new Set(["lead", "due"]);

/**
 * The channels that will carry one stage, out of the ones the user has enabled and
 * available right now. Applied before the ledger is claimed, not after, so a stage email
 * never carries leaves no email row behind — and a user with only email enabled simply
 * has a shorter ladder (lead and due) rather than stages that silently go nowhere.
 */
function routeStage(stage: string, channels: Channel[]): Channel[] {
  return channels.filter((c) => c !== "email" || EMAIL_STAGES.has(stage));
}

type Stage = { stage: string; fireAt: number };

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");
  if (!hasCronSecret(req)) throw new HttpError(401, "Missing or bad x-cron-secret");

  const started = Date.now();
  const admin = serviceClient();
  const body = await readBody(req);
  const now = new Date();

  const candidates = await candidateTasks(admin, now, body.user_id);
  if (candidates.length === 0) {
    return json({ ok: true, runtime_ms: Date.now() - started, notified: 0, candidates: 0 });
  }

  // Group by user: the recipient lookup, the quiet-hours check and MAX_PER_USER are all
  // per person, not per task.
  const byUser = new Map<string, TaskRow[]>();
  for (const task of candidates) {
    const list = byUser.get(task.user_id);
    if (list) list.push(task);
    else byUser.set(task.user_id, [task]);
  }

  let notified = 0;
  const report: Record<string, unknown>[] = [];

  for (const [userId, tasks] of byUser) {
    try {
      const recipient = await loadRecipient(admin, userId);
      const { channels, skipped } = activeChannels(recipient, now);

      if (channels.length === 0) {
        // Nothing is claimed, so every stage still pending resumes once the user's quiet
        // hours end — minus anything the lateness horizon has by then dropped.
        report.push({
          user_id: userId,
          status: "no active channels",
          reasons: skipped.map((s) => `${s.channel}: ${s.reason}`),
        });
        continue;
      }

      let userNotified = 0;
      for (const task of tasks) {
        if (userNotified >= MAX_PER_USER) {
          report.push({ user_id: userId, task_id: task.id, status: "capped" });
          break;
        }
        const outcome = await escalate(admin, recipient, task, channels, now);
        if (!outcome) continue;
        if (outcome.delivered) {
          userNotified++;
          notified++;
        }
        report.push({ user_id: userId, task_id: task.id, ...outcome });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`check-reminders failed for ${userId}`, message);
      report.push({ user_id: userId, status: "failed", error: message });
    }
  }

  const runtime_ms = Date.now() - started;
  if (notified > 0 || report.length > 0) {
    console.log(
      `check-reminders: ${notified} notified from ${candidates.length} candidates in ${runtime_ms}ms`,
    );
  }
  return json({ ok: true, runtime_ms, notified, candidates: candidates.length, detail: report });
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
 * Tasks that could have a stage due this minute: still open, opted into reminders, and
 * with a due_at inside the window the ladder can reach. The exact stage arithmetic needs
 * the interval in milliseconds and the per-user nag cadence, so it happens in JS.
 */
async function candidateTasks(
  admin: SupabaseClient,
  now: Date,
  onlyUser?: string,
): Promise<TaskRow[]> {
  let query = admin
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("status", "todo")
    .not("remind_before", "is", null)
    .not("due_at", "is", null)
    // Overdue far enough that nagging has stopped, or far enough out that no stage can
    // have fired yet (the longest remind_before the UI offers is 3 days).
    .gte("due_at", new Date(now.getTime() - NAG_WINDOW_HOURS * 3_600_000).toISOString())
    .lte("due_at", new Date(now.getTime() + 8 * 86_400_000).toISOString())
    .order("due_at", { ascending: true })
    .limit(CANDIDATE_LIMIT);
  if (onlyUser) query = query.eq("user_id", onlyUser);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as TaskRow[];
}

/**
 * The full ladder for one occurrence, in fire order.
 *
 * An all-day task gets only its lead stage: its due_at is local midnight, so escalating
 * through "due now" and then nagging would mean a birthday pinging you from midnight on.
 */
export function plan(task: TaskRow, nagMs: number, now: Date): Stage[] {
  const due = new Date(task.due_at!).getTime();
  const lead = intervalMs(task.remind_before);

  // Keyed by fire time so stages that coincide collapse into one send: with
  // remind_before = 1 hour, 'lead' and '1h' are the same instant and the user should get
  // one notification, not two. Insertion order decides the winner, so lead goes first.
  const slots = new Map<number, string>();
  const put = (fireAt: number, stage: string) => {
    if (!slots.has(fireAt)) slots.set(fireAt, stage);
  };

  if (lead !== null && lead > 0) put(due - lead, "lead");

  if (!task.all_day) {
    put(due - 3_600_000, "1h");
    put(due - 900_000, "15m");
    put(due, "due");

    const overdue = now.getTime() - due;
    if (overdue > 0 && nagMs > 0 && overdue <= NAG_WINDOW_HOURS * 3_600_000) {
      // Only the current nag matters — the ones before it have been superseded, and
      // deriving the index from now is what keeps a late tick from replaying them.
      const k = Math.floor(overdue / nagMs);
      if (k >= 1 && k <= MAX_NAGS) put(due + k * nagMs, `nag:${k}`);
    }
  }

  return [...slots.entries()]
    .map(([fireAt, stage]) => ({ fireAt, stage }))
    .sort((a, b) => a.fireAt - b.fireAt);
}

/** Stages that have come due, are not too stale to be worth sending, and are not snoozed past. */
function pendingStages(task: TaskRow, stages: Stage[], now: Date): Stage[] {
  const t = now.getTime();
  // A stage from before the task existed never applies: creating a task due in five
  // minutes must not fire "due in 1 hour" on the spot.
  let floor = new Date(task.created_at).getTime();
  // Snoozing permanently retires every stage before the snooze expiry, so the ladder
  // resumes at the current nag instead of replaying what it slept through.
  if (task.snoozed_until) {
    floor = Math.max(floor, new Date(task.snoozed_until).getTime());
  }
  const lateFloor = t - MAX_LATENESS_HOURS * 3_600_000;

  return stages.filter((s) => {
    if (s.fireAt > t || s.fireAt < floor) return false;
    // Nags are exempt from the lateness horizon: plan() only ever emits the current one.
    if (s.stage.startsWith("nag:")) return true;
    return s.fireAt >= lateFloor;
  });
}

type Outcome = {
  stage: string;
  delivered: boolean;
  channels?: string[];
  superseded?: string[];
  status?: string;
};

/**
 * Advance one task by at most one notification. When several stages are pending (the
 * function was down, or the user was asleep until the lateness horizon caught up) only
 * the latest is sent; the older ones are written to the ledger as `delivered = false` so
 * they are accounted for without claiming an email went out, and never fire late.
 */
async function escalate(
  admin: SupabaseClient,
  recipient: Recipient,
  task: TaskRow,
  channels: Channel[],
  now: Date,
): Promise<Outcome | null> {
  if (task.snoozed_until && new Date(task.snoozed_until) > now) return null;

  const stages = plan(task, recipient.prefs.nagIntervalMs, now).filter(
    (s) => routeStage(s.stage, channels).length > 0,
  );
  const pending = pendingStages(task, stages, now);
  if (pending.length === 0) return null;

  const target = pending[pending.length - 1];
  const superseded = pending.slice(0, -1);

  for (const old of superseded) {
    for (const channel of routeStage(old.stage, channels)) {
      await claim(admin, task, old.stage, channel, false);
    }
  }

  const claimed: Channel[] = [];
  for (const channel of routeStage(target.stage, channels)) {
    if (await claim(admin, task, target.stage, channel, true)) claimed.push(channel);
  }
  if (claimed.length === 0) {
    return {
      stage: target.stage,
      delivered: false,
      status: "already notified",
      superseded: superseded.map((s) => s.stage),
    };
  }

  const results = await notify(recipient, payloadFor(task, target.stage, recipient, now), claimed);

  // Hand back the channels that failed, so the next tick tries them again. Without this
  // one SMTP hiccup would silently retire the stage.
  const failed = results.filter((x) => x.status !== "sent");
  for (const f of failed) await release(admin, task, target.stage, f.channel);

  const sent = results.filter((x) => x.status === "sent").map((x) => x.channel);
  if (sent.length > 0) {
    // last_reminded_at is what the rest of the app reads to show "reminded"; the ledger
    // is the authority on *which* stage.
    const { error } = await admin
      .from("tasks")
      .update({ last_reminded_at: now.toISOString() })
      .eq("id", task.id);
    if (error) throw error;
  }

  return {
    stage: target.stage,
    delivered: sent.length > 0,
    channels: sent,
    ...(failed.length ? { status: `failed: ${failed.map((f) => f.channel).join(",")}` } : {}),
    ...(superseded.length ? { superseded: superseded.map((s) => s.stage) } : {}),
  };
}

/** Claim a (task, occurrence, stage, channel). False when someone else already has it. */
async function claim(
  admin: SupabaseClient,
  task: TaskRow,
  stage: string,
  channel: Channel,
  delivered: boolean,
): Promise<boolean> {
  const { error } = await admin.from("task_notifications").insert({
    user_id: task.user_id,
    task_id: task.id,
    due_at: task.due_at,
    stage,
    channel,
    delivered,
  });
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return false;
    throw error;
  }
  return true;
}

async function release(
  admin: SupabaseClient,
  task: TaskRow,
  stage: string,
  channel: Channel,
): Promise<void> {
  const { error } = await admin
    .from("task_notifications")
    .delete()
    .eq("task_id", task.id)
    .eq("due_at", task.due_at!)
    .eq("stage", stage)
    .eq("channel", channel);
  if (error) console.error("could not release claim", error.message);
}

// ------------------------------------------------------------------ wording

function payloadFor(task: TaskRow, stage: string, recipient: Recipient, now: Date): NotifyPayload {
  const tz = recipient.timezone;
  const due = new Date(task.due_at!);
  const gap = due.getTime() - now.getTime();
  const when = describeDue(task.due_at!, task.all_day, tz);

  const subtitle = stage.startsWith("nag:")
    ? `Still open — was due ${describeGap(gap)}`
    : stage === "due"
      ? `Due now · ${when}`
      : `Due ${describeGap(gap)} · ${when}`;

  return {
    title: task.title,
    subtitle: task.priority === "high" ? `${subtitle} · high priority` : subtitle,
    body: task.notes,
    note: stage.startsWith("nag:")
      ? "You're getting this because the task is still open. Snooze it from Telegram, or mark it done."
      : "A reminder you set in Daily Edge.",
    // Telegram-only; the email gets the "Open your tasks" link instead.
    actions: [
      { label: "✓ Done", data: `done:${task.id}` },
      { label: "💤 1h", data: `snooze:${task.id}` },
      { label: "→ Tomorrow", data: `tomorrow:${task.id}` },
    ],
  };
}

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
