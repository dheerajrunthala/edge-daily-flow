// mcp (no JWT) — the Daily Edge MCP server, over Streamable HTTP.
//
// This is the app's fourth front door, after the browser, the Telegram bot and the push
// service worker. What makes it different from all three is the design principle: the
// *client* is the intelligence. Claude Code already holds the conversation, the repo, the
// branch and the diff, so it resolves "remind me tomorrow morning" itself and sends an
// exact timestamp. The server does no natural-language parsing and never calls Gemini —
// it validates, enforces ownership, and persists. See instructions.ts.
//
// Transport: the official TypeScript SDK's WebStandardStreamableHTTPServerTransport,
// which speaks Request/Response rather than node's req/res and so runs in the Edge
// runtime unmodified (the Express-flavoured StreamableHTTPServerTransport does not).
//
// Stateless, and deliberately so: `sessionIdGenerator: undefined` plus a fresh McpServer
// per request. Edge invocations are ephemeral and a later request may land in a different
// isolate, so a session id would be a promise this platform cannot keep — it would resolve
// to "session not found" the moment an isolate recycled. Every request carries its own
// bearer token, which is all the identity a tool call needs. `enableJsonResponse: true`
// for the same reason: there is nothing to stream when each response is one tool result.
//
// Auth is `Authorization: Bearer de_...` against api_tokens, hashed. verify_jwt is off
// because the platform gate only understands Supabase JWTs and would reject every real
// caller before the handler ran; requireApiToken() is the replacement, not the absence,
// of a check.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/webStandardStreamableHttp.js";

import { HttpError, json, serviceClient } from "../_shared/supabase.ts";
import { requireApiToken, touchToken } from "../_shared/api-tokens.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { loadCtx, registerTools } from "./tools.ts";

const SERVER_NAME = "daily-edge";
const SERVER_VERSION = "1.0.0";

/**
 * MCP clients send `mcp-session-id`, `mcp-protocol-version` and `last-event-id`, none of
 * which are in the project's shared CORS header list. A browser-based client preflighting
 * against this function would otherwise fail on the headers it is required to send.
 */
const HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "mcp-session-id",
};

/**
 * A JSON-RPC-shaped error, because an MCP client parses the body it gets back. A bare
 * `{"error": "..."}` (the convention everywhere else in this project) would surface in the
 * client as a parse failure rather than as the reason the user's token was rejected.
 */
function rpcError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: status === 429 ? -32000 : -32001, message },
      id: null,
    }),
    { status, headers: { ...HEADERS, "content-type": "application/json" } },
  );
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: HEADERS });

  const url = new URL(req.url);
  // A browser (or a curious user) hitting the URL gets something human-readable rather
  // than a protocol error, and no authentication is needed to read it.
  if (req.method === "GET" && url.searchParams.get("about") !== null) {
    return json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: "streamable-http",
      authentication: "Authorization: Bearer de_... (create one in Settings → Integrations)",
      docs: "https://dailyedgeapp.lovable.app/settings",
    });
  }

  const admin = serviceClient();
  const token = await requireApiToken(req, admin);
  const ctx = await loadCtx(admin, token);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, ctx);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(req);
  // After the response, not before: a 401 should not advertise that the token is live.
  await touchToken(admin, token.tokenId);
  return new Response(response.body, {
    status: response.status,
    headers: { ...Object.fromEntries(response.headers), ...HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) return rpcError(err.status, err.message);
    console.error("mcp failed", err);
    return rpcError(500, err instanceof Error ? err.message : "mcp failed");
  }
});
