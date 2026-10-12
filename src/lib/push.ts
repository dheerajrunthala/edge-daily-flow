// Browser half of the `push` channel: permission, the service worker, and keeping the
// stored subscription in step with the one the browser actually holds.
//
// Three things here are not obvious and are each load-bearing:
//
//   * The VAPID public key is fetched from push-subscribe rather than read from an env
//     var, so the keys live only in Supabase's secret store and rotating them needs no
//     frontend rebuild.
//   * syncSubscription() runs on every app load. A push service may rotate an endpoint at
//     any time, and the service worker cannot report that itself — telling the server
//     needs the user's session, which lives here in the page. So the page re-upserts
//     whatever the browser currently holds, and the stale row is pruned server-side when a
//     send comes back 404/410.
//   * Service workers only run on a secure origin served from the real site. The Lovable
//     *preview* iframe is neither, which is why this has to be tested on the published URL.

import { supabase } from "@/integrations/supabase/client";

export type PushState = {
  supported: boolean;
  permission: NotificationPermission;
  /** Does this browser currently hold a subscription? */
  subscribed: boolean;
  /** Has the project got VAPID keys? Null until asked. */
  configured: boolean | null;
};

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function permissionNow(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "denied";
  return Notification.permission;
}

/** Pull the server's error message out of a functions.invoke() failure. */
async function describe(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx && typeof ctx.json === "function") {
    try {
      const body = (await ctx.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("push-subscribe", { body });
  if (error) throw new Error(await describe(error));
  return data as T;
}

// ------------------------------------------------------------------ worker

/**
 * Register the worker and wait for it to be usable. `ready` rather than the register()
 * result: a freshly registered worker is still installing, and pushManager.subscribe on
 * an installing registration throws.
 */
export async function serviceWorker(): Promise<ServiceWorkerRegistration> {
  if (!pushSupported()) throw new Error("This browser can't do desktop notifications.");
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return await navigator.serviceWorker.ready;
}

/**
 * base64url → the BufferSource pushManager.subscribe wants for applicationServerKey.
 * Built on an explicit ArrayBuffer rather than Uint8Array.from, because the DOM types
 * reject the ArrayBufferLike that produces (it could be a SharedArrayBuffer).
 */
function decodeKey(base64url: string): ArrayBuffer {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

async function vapidKey(): Promise<string> {
  const res = await call<{ configured: boolean; vapid_public_key: string }>({ action: "key" });
  if (!res.configured || !res.vapid_public_key) {
    throw new Error("Push isn't configured on this project yet (no VAPID keys).");
  }
  return res.vapid_public_key;
}

// ------------------------------------------------------------------ state

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) {
    return { supported: false, permission: "denied", subscribed: false, configured: null };
  }
  let subscribed = false;
  // Only ask the worker if permission was actually granted: registering a worker just to
  // discover "default" would install one for a user who never opted in.
  if (Notification.permission === "granted") {
    try {
      const reg = await serviceWorker();
      subscribed = (await reg.pushManager.getSubscription()) !== null;
    } catch {
      subscribed = false;
    }
  }
  return { supported: true, permission: Notification.permission, subscribed, configured: null };
}

// ------------------------------------------------------------------ enable / disable

/**
 * The "Enable desktop notifications" button, end to end: ask permission, register the
 * worker, subscribe to the push service, store the subscription.
 *
 * A browser that is already subscribed reuses that subscription rather than creating a
 * second one — the endpoint is stable, and re-posting it is how a row that was deleted
 * server-side gets restored.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("This browser can't do desktop notifications.");

  const key = await vapidKey();

  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    throw new Error(
      "Notifications are blocked for this site. Allow them in your browser's site settings, then try again.",
    );
  }
  if (permission !== "granted") throw new Error("Notification permission wasn't granted.");

  const reg = await serviceWorker();
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      // Required by Chrome: a push must always result in something the user can see.
      userVisibleOnly: true,
      applicationServerKey: decodeKey(key),
    }));

  await call({ action: "subscribe", subscription: sub.toJSON(), user_agent: navigator.userAgent });
}

/** Turn it off on this browser: drop the local subscription and the stored row. */
export async function disablePush(): Promise<void> {
  let endpoint: string | undefined;
  if (pushSupported() && Notification.permission === "granted") {
    try {
      const reg = await serviceWorker();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    } catch {
      // The browser has already forgotten it; still clear the server side below.
    }
  }
  await call({ action: "unsubscribe", ...(endpoint ? { endpoint } : {}) });
}

export async function testPush(): Promise<{ sent: number; devices: number }> {
  return await call<{ sent: number; devices: number }>({ action: "test" });
}

/**
 * Re-upsert the subscription this browser currently holds. Cheap, idempotent, and the
 * only thing that repairs an endpoint the push service rotated while the app was closed.
 * Never throws: it runs on app load, where a failure must not break the page.
 */
export async function syncSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  try {
    const reg = await serviceWorker();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await call({
      action: "subscribe",
      subscription: sub.toJSON(),
      user_agent: navigator.userAgent,
    });
  } catch (e) {
    console.warn("[push] could not sync subscription", e);
  }
}
