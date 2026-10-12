// push-subscribe (user JWT) — everything the browser needs to turn the `push` channel on.
//
//   {"action":"key"}          the VAPID public key, so the page can call
//                             pushManager.subscribe without a build-time env var
//   {"action":"subscribe"}    store a PushSubscription and switch the channel on
//   {"action":"unsubscribe"}  drop one endpoint, and switch the channel off with the last
//   {"action":"test"}         send a test notification to this user's browsers
//
// The public key is served rather than baked into the bundle on purpose: the keys then
// live only in the platform's secret store, exactly like the Telegram bot token, and
// rotating them needs no rebuild of the frontend.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { CORS_HEADERS, HttpError, json, requireUser, serviceClient } from "../_shared/supabase.ts";
import { loadSubscriptions, pushConfigured, sendPush, vapidPublicKey } from "../_shared/push.ts";

/** A browser's PushSubscription, as PushSubscription.toJSON() reports it. */
type IncomingSubscription = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
};

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");

  const admin = serviceClient();
  const user = await requireUser(req, admin);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "key";

  if (action === "key") {
    // Answered even when unconfigured, so the UI can say "ask the owner to set the VAPID
    // keys" instead of failing with an opaque subscribe error inside the browser.
    return json({ configured: pushConfigured(), vapid_public_key: vapidPublicKey() });
  }

  if (!pushConfigured()) {
    throw new HttpError(503, "Push is not configured on this project (VAPID keys are not set)");
  }

  if (action === "subscribe") return json(await subscribe(admin, user.id, body));
  if (action === "unsubscribe") return json(await unsubscribe(admin, user.id, body));
  if (action === "test") return json(await test(admin, user.id));

  throw new HttpError(400, `Unknown action "${action}"`);
}

/**
 * Store (or refresh) one browser's subscription.
 *
 * Upsert on `endpoint`, because that is what the browser re-reports: Chrome hands back
 * the same endpoint for a subscription that already exists, and a rotated one after
 * `pushsubscriptionchange`. Keying on the endpoint also means a shared machine where two
 * accounts have signed in moves the row to whoever subscribed last, rather than sending
 * one person's reminders to another's browser profile.
 */
async function subscribe(admin: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const sub = (body.subscription ?? {}) as IncomingSubscription;
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
  const p256dh = typeof sub.keys?.p256dh === "string" ? sub.keys.p256dh : "";
  const auth = typeof sub.keys?.auth === "string" ? sub.keys.auth : "";

  if (!endpoint.startsWith("https://"))
    throw new HttpError(400, "subscription.endpoint is missing");
  if (!p256dh || !auth) throw new HttpError(400, "subscription.keys are missing");

  const { error } = await admin.from("push_subscriptions").upsert(
    {
      user_id: userId,
      endpoint,
      p256dh,
      auth,
      user_agent: typeof body.user_agent === "string" ? body.user_agent.slice(0, 300) : null,
      last_used_at: null,
    },
    { onConflict: "endpoint" },
  );
  if (error) throw error;

  await setPushChannel(admin, userId, true);
  return { ok: true, subscribed: true };
}

/**
 * Drop one endpoint. Scoped to the caller so a known endpoint string cannot be used to
 * unsubscribe someone else's browser.
 */
async function unsubscribe(admin: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  if (endpoint) {
    const { error } = await admin
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("endpoint", endpoint);
    if (error) throw error;
  } else {
    // No endpoint means "this account, everywhere" — what a Settings-page "turn it off"
    // should do when the browser has already forgotten its own subscription.
    const { error } = await admin.from("push_subscriptions").delete().eq("user_id", userId);
    if (error) throw error;
  }

  const left = await loadSubscriptions(admin, userId);
  // Only the last device switches the channel off: unsubscribing a laptop should not stop
  // the phone, and a channel enabled with nothing behind it is just a silent setting.
  if (left.length === 0) await setPushChannel(admin, userId, false);
  return { ok: true, remaining: left.length };
}

/**
 * The "send me a test" button. Deliberately calls sendPush directly rather than notify():
 * the user is standing in front of the browser asking for it, so quiet hours and channel
 * preferences are not what they are testing — the plumbing is.
 */
async function test(admin: SupabaseClient, userId: string) {
  const subs = await loadSubscriptions(admin, userId);
  if (subs.length === 0) {
    throw new HttpError(400, "This browser isn't subscribed yet — enable notifications first.");
  }

  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");
  const result = await sendPush(
    admin,
    userId,
    {
      title: "Daily Edge notifications are on",
      body: "This is what a task reminder will look like. Buttons appear on real reminders.",
      tag: "daily-edge-test",
      url: `${appUrl}/tasks`,
      requireInteraction: true,
    },
    subs,
  );
  return { ok: true, ...result, devices: subs.length };
}

/** Keep notification_prefs.channels in step, the way the Telegram webhook does on link. */
async function setPushChannel(admin: SupabaseClient, userId: string, on: boolean) {
  const { data, error } = await admin
    .from("notification_prefs")
    .select("channels")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;

  const current = (data?.channels ?? ["email"]) as string[];
  const has = current.includes("push");
  if (has === on) return;

  const channels = on ? [...current, "push"] : current.filter((c) => c !== "push");
  const { error: upErr } = await admin
    .from("notification_prefs")
    .upsert({ user_id: userId, channels }, { onConflict: "user_id" });
  if (upErr) throw upErr;
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    console.error("push-subscribe failed", err);
    return json({ error: err instanceof Error ? err.message : "push-subscribe failed" }, 500);
  }
});
