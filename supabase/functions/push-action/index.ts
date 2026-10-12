// push-action (no JWT) — the Done / Snooze buttons on a desktop notification.
//
// Why this cannot require a JWT: the buttons are handled in a *service worker*, and the
// Supabase session lives in the page's localStorage, which a worker cannot read. The
// worker often runs with no page open at all. So the request is authenticated by the
// HMAC action token that _shared/push.ts minted into the notification itself.
//
// What that token can do is the whole security story, and it is deliberately tiny: it
// names one user and one task, expires in a day, and this function does nothing else with
// it. It cannot list tasks, read news, touch another task, or be replayed into a different
// account — the task is re-read scoped to the user id *inside* the token, the same way the
// Telegram webhook scopes a button press to the chat's user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { CORS_HEADERS, HttpError, json, serviceClient } from "../_shared/supabase.ts";
import { verifyActionToken } from "../_shared/push.ts";
import {
  TASK_COLUMNS,
  completeTask,
  describeDue,
  snoozeTask,
  type TaskRow,
} from "../_shared/tasks.ts";
import { isValidTimezone } from "../_shared/time.ts";

const DEFAULT_TZ = "Asia/Kolkata";
/** Notification snooze. Shorter than Telegram's hour: a desktop "not now" means minutes. */
const SNOOZE_MS = 10 * 60_000;

/** The service worker posts cross-origin, so it needs the preflight to pass. */
const HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "access-control-allow-headers": "content-type",
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const claims = await verifyActionToken(body.token);
  // One message for a bad signature and for an expired token: which one it was is not
  // something an unauthenticated caller needs to learn.
  if (!claims) throw new HttpError(401, "That notification has expired.");

  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "done" && action !== "snooze") throw new HttpError(400, "Unknown action");

  const admin = serviceClient();

  const { data, error } = await admin
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("id", claims.taskId)
    .eq("user_id", claims.userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "That task is gone.");
  const task = data as TaskRow;

  const { data: profile } = await admin
    .from("profiles")
    .select("timezone")
    .eq("id", claims.userId)
    .maybeSingle();
  const tz = profile?.timezone && isValidTimezone(profile.timezone) ? profile.timezone : DEFAULT_TZ;

  if (action === "done") {
    const { rolledTo } = await completeTask(admin, task, tz);
    return json({
      ok: true,
      action,
      title: task.title,
      message: rolledTo
        ? `Done — next on ${describeDue(rolledTo, task.all_day, tz)}`
        : "Marked done",
    });
  }

  const until = new Date(Date.now() + SNOOZE_MS);
  await snoozeTask(admin, task.id, until);
  return json({
    ok: true,
    action,
    title: task.title,
    message: `Snoozed until ${describeDue(until.toISOString(), false, tz)}`,
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: err.status,
        headers: { ...HEADERS, "content-type": "application/json" },
      });
    }
    console.error("push-action failed", err);
    return new Response(JSON.stringify({ error: "push-action failed" }), {
      status: 500,
      headers: { ...HEADERS, "content-type": "application/json" },
    });
  }
});
