// API token authentication for the MCP server — the verification half only. Minting
// lives in the database (`create_api_token()`), so the plaintext exists in exactly one
// HTTP response and is never reconstructible from anything stored here.
//
// This is the project's third authentication shape, and the reason for a third one is
// the client: an MCP client is a config file. `claude mcp add --header "Authorization:
// Bearer de_..."` is pasted once and expected to work for months, which a Supabase
// access token (one hour) cannot do, and there is no browser present to refresh one.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { HttpError } from "./supabase.ts";

/**
 * How many tool calls one token may make per hour. Generous for a human working in an
 * editor — a busy session is a handful of calls a minute — and low enough that a looping
 * agent stops before it has rewritten someone's whole task list.
 */
export const RATE_LIMIT_PER_HOUR = 120;

export type ApiToken = {
  tokenId: string;
  userId: string;
  name: string;
};

/** sha256 hex of the plaintext — the same digest the database stored at mint time. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Resolve the calling user from an `Authorization: Bearer de_...` header.
 *
 * Throws 401 rather than returning null, like requireUser(): this is the *only* guard on
 * everything downstream, because the tools run with the service role and the service role
 * bypasses RLS. A tool that forgets to filter by the returned user_id is a cross-account
 * data leak, which is why every query in the server does so explicitly and why there is a
 * test that proves it.
 *
 * The lookup is by hash, so a stolen database row cannot be replayed, and an unknown
 * token and a revoked one deliberately produce the same message: which one it was is not
 * something an unauthenticated caller needs to learn.
 */
export async function requireApiToken(req: Request, admin: SupabaseClient): Promise<ApiToken> {
  const header = req.headers.get("authorization") ?? "";
  const raw = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!raw) {
    throw new HttpError(401, "Missing Authorization header. Expected: Bearer de_...");
  }
  // Checked before the query so a pasted Supabase JWT gets a useful message rather than
  // "invalid token" after a pointless round trip.
  if (!raw.startsWith("de_")) {
    throw new HttpError(
      401,
      "That is not a Daily Edge API token. Create one in Settings → Integrations; it starts with de_.",
    );
  }

  const { data, error } = await admin
    .from("api_tokens")
    .select("id, user_id, name, revoked_at")
    .eq("token_hash", await sha256Hex(raw))
    .maybeSingle();
  if (error) throw error;
  if (!data || data.revoked_at) {
    throw new HttpError(401, "Unknown or revoked API token. Create a new one in Settings.");
  }

  return { tokenId: data.id as string, userId: data.user_id as string, name: data.name as string };
}

/**
 * Stamp last_used_at so Settings can show "last used 3 minutes ago" — the one signal that
 * tells a user whether a token they have forgotten about is still in something's config.
 *
 * Fire-and-forget: a failed stamp must never fail the user's tool call.
 */
export async function touchToken(admin: SupabaseClient, tokenId: string): Promise<void> {
  const { error } = await admin
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", tokenId);
  if (error) console.error("api_tokens last_used_at stamp failed", error.message);
}

/**
 * Per-token rate limit, counted over the trailing hour of mcp_tool_calls.
 *
 * Counted per token rather than per user on purpose: one misbehaving agent should stop
 * without taking out the user's other editors, and the token is the thing they can revoke.
 */
export async function checkRateLimit(
  admin: SupabaseClient,
  tokenId: string,
): Promise<{ used: number; limit: number }> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count, error } = await admin
    .from("mcp_tool_calls")
    .select("id", { count: "exact", head: true })
    .eq("token_id", tokenId)
    .gte("created_at", since);
  if (error) throw error;

  const used = count ?? 0;
  if (used >= RATE_LIMIT_PER_HOUR) {
    throw new HttpError(
      429,
      `Rate limit reached: ${RATE_LIMIT_PER_HOUR} Daily Edge tool calls per hour. Try again shortly.`,
    );
  }
  return { used, limit: RATE_LIMIT_PER_HOUR };
}

/**
 * Which front door made the call.
 *
 * Worth recording because the same tool reached through different doors has different
 * blast radius: `mcp` is a developer's editor, `voice` is a device in a room that may
 * have misheard, and `planner` is cron acting with nobody present. Without this column
 * the audit trail cannot answer "what did it do while I was asleep".
 */
export type ToolSurface = "mcp" | "chat" | "voice" | "telegram" | "planner";

/**
 * Record one tool call. Awaited rather than fired and forgotten, because this is the table
 * the rate limit counts — the same reasoning as logAiEvent — and it is the only audit
 * trail of what an agent did while nobody was watching.
 */
export async function logToolCall(
  admin: SupabaseClient,
  entry: {
    userId: string;
    tokenId: string | null;
    tool: string;
    ok: boolean;
    error?: string | null;
    durationMs?: number;
    surface?: ToolSurface;
  },
): Promise<void> {
  const { error } = await admin.from("mcp_tool_calls").insert({
    user_id: entry.userId,
    token_id: entry.tokenId,
    tool: entry.tool,
    ok: entry.ok,
    error: entry.error ? entry.error.slice(0, 500) : null,
    duration_ms: entry.durationMs ?? null,
    surface: entry.surface ?? "mcp",
  });
  if (error) console.error("mcp_tool_calls insert failed", error.message);
}
