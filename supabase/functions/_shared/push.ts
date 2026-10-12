// Web Push (RFC 8030 / 8291 / 8292) — the sender behind the `push` channel in notify.ts.
//
// Two things live here because they are two halves of one trust story:
//
//   * sendPush() encrypts a payload to each of a user's browser subscriptions, and prunes
//     the ones the push service says are dead. A subscription outlives the page that
//     created it, so "gone" is a normal answer, not an error to retry.
//   * mintActionToken()/verifyActionToken() let a *service worker* act on a task. The
//     worker has no Supabase session — the session lives in the page's localStorage,
//     which a worker cannot read — so the Done/Snooze buttons cannot send a JWT. Instead
//     each notification carries a short-lived token naming exactly one (user, task), and
//     push-action trusts the signature instead of a bearer token. Nothing else is
//     actionable with it: no listing, no other task, no other user.
//
// The signing key is derived from SUPABASE_SERVICE_ROLE_KEY with HKDF, so there is no new
// secret for the owner to set and the derived key cannot be used as the service role.

import * as webpush from "jsr:@negrel/webpush@^0.5.0";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** One browser that granted notification permission. */
export type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * What the service worker receives. Kept flat and explicit rather than passing a
 * Notification options bag, because public/sw.js has to read it without a type checker.
 */
export type PushPayload = {
  title: string;
  body?: string;
  /** Collapses re-sends about the same thing into one notification on screen. */
  tag?: string;
  /** Where a click on the body goes. */
  url?: string;
  /** Keep the notification on screen until the user deals with it. */
  requireInteraction?: boolean;
  /** Chrome shows at most two; a third is silently dropped. */
  actions?: { action: string; title: string }[];
  /** Where the worker POSTs a button press, and the token that authorizes it. */
  actionUrl?: string;
  token?: string;
};

export type PushResult = { sent: number; removed: number; failed: string[] };

const enc = new TextEncoder();

// ------------------------------------------------------------------ vapid

const VAPID_PUBLIC = () => Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = () => Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
/** RFC 8292 wants a contact the push service can complain to. */
const VAPID_SUBJECT = () =>
  Deno.env.get("VAPID_SUBJECT") ?? `mailto:${Deno.env.get("GMAIL_USER") ?? "admin@example.com"}`;

/** Is the project configured to send push at all? */
export function pushConfigured(): boolean {
  return VAPID_PUBLIC().length > 0 && VAPID_PRIVATE().length > 0;
}

/** The applicationServerKey the browser needs to subscribe, base64url as stored. */
export function vapidPublicKey(): string {
  return VAPID_PUBLIC();
}

function fromB64Url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function toB64Url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The VAPID pair as Web Crypto keys.
 *
 * `npx web-push generate-vapid-keys` emits the two halves the way every web-push tutorial
 * does: the public key as a base64url X9.62 uncompressed point (0x04 || x || y) and the
 * private key as the bare base64url scalar. Web Crypto only imports JWK or PKCS#8, so the
 * point is split back into x and y here. That keeps the secrets in the format the owner
 * generated rather than asking them to convert anything by hand.
 */
async function vapidKeys(): Promise<CryptoKeyPair> {
  const pub = fromB64Url(VAPID_PUBLIC());
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error(
      `VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point (got ${pub.length})`,
    );
  }
  const x = toB64Url(pub.slice(1, 33));
  const y = toB64Url(pub.slice(33, 65));
  const d = toB64Url(fromB64Url(VAPID_PRIVATE()));

  return await webpush.importVapidKeys(
    {
      publicKey: { kty: "EC", crv: "P-256", x, y, ext: true },
      privateKey: { kty: "EC", crv: "P-256", x, y, d, ext: true },
    },
    { extractable: false },
  );
}

/**
 * A fresh application server per send batch. The ECDH key inside it is ephemeral by
 * design (RFC 8291 §2), so it is deliberately *not* cached across invocations.
 */
async function applicationServer(): Promise<webpush.ApplicationServer> {
  return await webpush.ApplicationServer.new({
    contactInformation: VAPID_SUBJECT(),
    vapidKeys: await vapidKeys(),
  });
}

// ------------------------------------------------------------------ sending

/** A push service saying the subscription no longer exists. Prune, never retry. */
const GONE = new Set([404, 410]);

/**
 * Encrypt `payload` to every browser `userId` has subscribed, in parallel.
 *
 * Reports per-endpoint rather than throwing on the first failure: one stale subscription
 * on an old laptop must not stop the phone from buzzing. 404/410 means the push service
 * has forgotten the subscription, so the row is deleted — that is the whole of expiry
 * handling, and why `removed` is reported separately from `failed`.
 */
export async function sendPush(
  admin: SupabaseClient,
  userId: string,
  payload: PushPayload,
  subscriptions?: PushSubscriptionRow[],
): Promise<PushResult> {
  if (!pushConfigured()) throw new Error("VAPID keys are not configured");

  const subs = subscriptions ?? (await loadSubscriptions(admin, userId));
  if (subs.length === 0) throw new Error("no push subscriptions");

  const server = await applicationServer();
  const body = JSON.stringify(payload);

  const outcomes = await Promise.all(
    subs.map(async (sub) => {
      try {
        await server
          .subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })
          // A reminder is only useful now, so ask the push service to wake the device and
          // to drop it rather than queue it for a day if it cannot.
          .pushTextMessage(body, { urgency: webpush.Urgency.High, ttl: 3600 });
        return { ok: true as const, id: sub.id };
      } catch (e) {
        const status = e instanceof webpush.PushMessageError ? e.response.status : 0;
        if (GONE.has(status)) return { ok: false as const, gone: true, id: sub.id, status };
        return {
          ok: false as const,
          gone: false,
          id: sub.id,
          status,
          message: e instanceof Error ? e.message || String(e) : String(e),
        };
      }
    }),
  );

  const sentIds = outcomes.filter((o) => o.ok).map((o) => o.id);
  const goneIds = outcomes.filter((o) => !o.ok && o.gone).map((o) => o.id);
  const failed = outcomes
    .filter((o) => !o.ok && !o.gone)
    .map((o) => `${o.status || "?"} ${("message" in o && o.message) || "push failed"}`);

  if (sentIds.length > 0) {
    const { error } = await admin
      .from("push_subscriptions")
      .update({ last_used_at: new Date().toISOString() })
      .in("id", sentIds);
    if (error) console.error("could not stamp push_subscriptions.last_used_at", error.message);
  }
  if (goneIds.length > 0) {
    const { error } = await admin.from("push_subscriptions").delete().in("id", goneIds);
    if (error) console.error("could not prune dead push subscriptions", error.message);
    else console.log(`pruned ${goneIds.length} expired push subscription(s) for ${userId}`);
  }

  // Every endpoint failed for a reason that is not expiry — the caller should retry, so
  // this has to be an error rather than a quiet { sent: 0 }.
  if (sentIds.length === 0 && failed.length > 0) throw new Error(failed.join("; "));

  return { sent: sentIds.length, removed: goneIds.length, failed };
}

export async function loadSubscriptions(
  admin: SupabaseClient,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  const { data, error } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []) as PushSubscriptionRow[];
}

// ------------------------------------------------------------------ action tokens

/**
 * How long a notification's buttons keep working. Long enough to survive a locked phone
 * overnight, short enough that a token scraped off a device is not useful forever.
 */
export const ACTION_TOKEN_TTL_MS = 24 * 3_600_000;

let actionKeyPromise: Promise<CryptoKey> | null = null;

/**
 * HMAC key for action tokens, derived from the service role key via HKDF. Deriving rather
 * than reusing means the token key cannot be turned back into database credentials, and
 * the owner has one less secret to manage.
 */
function actionKey(): Promise<CryptoKey> {
  if (!actionKeyPromise) {
    actionKeyPromise = (async () => {
      const secret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!secret) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
      const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode("daily-edge/push-action"),
          info: enc.encode("v1"),
        },
        base,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    })();
  }
  return actionKeyPromise;
}

type ActionClaims = { u: string; t: string; e: number };

/** A token authorizing Done/Snooze on exactly one task, for exactly one user. */
export async function mintActionToken(
  userId: string,
  taskId: string,
  ttlMs = ACTION_TOKEN_TTL_MS,
): Promise<string> {
  const claims: ActionClaims = { u: userId, t: taskId, e: Date.now() + ttlMs };
  const body = toB64Url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await actionKey(), enc.encode(body));
  return `${body}.${toB64Url(new Uint8Array(sig))}`;
}

/**
 * The (user, task) a token authorizes, or null. Verified with crypto.subtle.verify so the
 * comparison is not a string compare, and the claims are only parsed *after* the
 * signature holds — an unsigned token never reaches JSON.parse.
 */
export async function verifyActionToken(
  token: unknown,
): Promise<{ userId: string; taskId: string } | null> {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await actionKey(),
      fromB64Url(token.slice(dot + 1)),
      enc.encode(body),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromB64Url(body))) as ActionClaims;
    if (typeof claims.u !== "string" || typeof claims.t !== "string") return null;
    if (!(typeof claims.e === "number") || claims.e < Date.now()) return null;
    return { userId: claims.u, taskId: claims.t };
  } catch {
    return null;
  }
}
