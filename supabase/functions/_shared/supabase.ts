// Supabase access and request plumbing shared by every Edge Function.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

/** An error the caller is meant to see, with a status that isn't 500. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Service-role client. Server-side only — it bypasses RLS. */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Resolve the calling user from the request's bearer token. Throws 401 rather than
 * returning null so callers can't forget to check.
 */
export async function requireUser(
  req: Request,
  admin: SupabaseClient,
): Promise<{ id: string; email: string | null }> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new HttpError(401, "Missing bearer token");

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Invalid or expired token");
  return { id: data.user.id, email: data.user.email ?? null };
}

/** Constant-time-ish comparison for the cron shared secret. */
export function hasCronSecret(req: Request): boolean {
  const expected = Deno.env.get("CRON_SECRET");
  const got = req.headers.get("x-cron-secret");
  if (!expected || !got || expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

export type AiEventKind = "task_parse" | "digest" | "summary" | "embedding" | "brief";

/**
 * Record a Gemini call. Fire-and-forget by design: losing a log line must never fail
 * the user's request, but it is the table the rate limit counts, so it is awaited.
 */
export async function logAiEvent(
  admin: SupabaseClient,
  event: {
    userId: string;
    kind: AiEventKind;
    itemsProcessed?: number;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
): Promise<void> {
  const { error } = await admin.from("ai_events").insert({
    user_id: event.userId,
    kind: event.kind,
    items_processed: event.itemsProcessed ?? 0,
    input_tokens: event.inputTokens ?? null,
    output_tokens: event.outputTokens ?? null,
  });
  if (error) console.error("ai_events insert failed", error.message);
}

/** How many calls of `kind` the user has made since `since`. */
export async function countAiEvents(
  admin: SupabaseClient,
  userId: string,
  kind: AiEventKind,
  since: Date,
): Promise<number> {
  const { count, error } = await admin
    .from("ai_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .gte("created_at", since.toISOString());
  if (error) throw error;
  return count ?? 0;
}
