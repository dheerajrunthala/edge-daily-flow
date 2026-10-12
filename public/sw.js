/*
 * Daily Edge service worker — desktop notifications.
 *
 * Deliberately a plain static file rather than a generated one. The only reason to build
 * a service worker is to inject a precache manifest, and this app is server-rendered with
 * nothing worth precaching; `vite-plugin-pwa` would also emit it into `dist/`, which the
 * nitro build never copies into `.output/public/`, so it would 404 in production.
 *
 * It needs no build-time configuration either: every notification carries the URL to open
 * and the URL to post a button press to, so there is no project URL or key compiled in
 * here. See _shared/push.ts for the payload shape.
 */

self.addEventListener("install", () => {
  // Take over immediately. An old worker holding on would keep showing notifications in
  // last week's shape after a deploy changed the payload.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

const ICON = "/icon-192.png";
const BADGE = "/favicon.png";

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    // A push with no usable body still means *something* happened; a notification saying
    // so beats silently swallowing it, because Chrome may otherwise show its own
    // "site updated in the background" notice.
    payload = { title: "Daily Edge", body: "You have a new reminder." };
  }

  const title = payload.title || "Daily Edge";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: ICON,
      badge: BADGE,
      tag: payload.tag || undefined,
      // With a tag, Chrome replaces silently unless asked to alert again — so a later
      // rung of the escalation updates the card in place *and* still gets attention.
      renotify: payload.tag ? true : undefined,
      requireInteraction: payload.requireInteraction === true,
      actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : [],
      timestamp: Date.now(),
      data: {
        url: payload.url || "/tasks",
        actionUrl: payload.actionUrl || null,
        token: payload.token || null,
      },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const action = event.action;
  event.notification.close();

  // Tapping the body (rather than a button) opens the app. Reuse a tab that is already
  // on it instead of piling up windows.
  if (!action) {
    event.waitUntil(openApp(data.url || "/tasks"));
    return;
  }

  if (!data.actionUrl || !data.token) {
    event.waitUntil(openApp(data.url || "/tasks"));
    return;
  }

  event.waitUntil(runAction(data, action));
});

/**
 * Spend the notification's action token. No credentials are involved: the token itself is
 * the authorization, and it is good for this one task only (see push-action).
 */
async function runAction(data, action) {
  try {
    const res = await fetch(data.actionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: data.token, action }),
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      await self.registration.showNotification("Couldn't update that task", {
        body: body.error || "Open Daily Edge to do it there.",
        icon: ICON,
        badge: BADGE,
        tag: "daily-edge-action-error",
        data: { url: data.url || "/tasks" },
      });
      return;
    }

    // The card the buttons were on is gone, so without this the press would look like it
    // did nothing. Silent and dismissible — it is a receipt, not a new alarm.
    await self.registration.showNotification(body.title || "Daily Edge", {
      body: body.message || "Updated",
      icon: ICON,
      badge: BADGE,
      tag: "daily-edge-action-done",
      silent: true,
      data: { url: data.url || "/tasks" },
    });

    // An open tab is showing a stale task list; tell it to refetch.
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "task-updated", action });
  } catch (e) {
    await self.registration.showNotification("You're offline", {
      body: "That change didn't save. Open Daily Edge to try again.",
      icon: ICON,
      badge: BADGE,
      tag: "daily-edge-action-error",
      data: { url: data.url || "/tasks" },
    });
  }
}

async function openApp(url) {
  const target = new URL(url, self.location.origin);
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

  for (const client of clients) {
    if (new URL(client.url).origin !== target.origin) continue;
    await client.focus();
    if (client.url !== target.href && "navigate" in client) {
      await client.navigate(target.href).catch(() => {});
    }
    return;
  }
  await self.clients.openWindow(target.href);
}

/**
 * The push service rotated this browser's endpoint. Re-subscribe with the same
 * application server key so notifications keep arriving, but do not try to tell the
 * server: that call needs the user's session, which lives in the page. The app re-syncs
 * its current subscription on every load, so the new endpoint is stored the next time the
 * user opens it, and the stale row is pruned when a send returns 404/410.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .catch((e) => console.error("[sw] re-subscribe failed", e)),
  );
});
