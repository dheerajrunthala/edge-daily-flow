// parse-task — free text in, a preview array of tasks out. The UI saves; this never writes
// to tasks. Requires a user JWT.
//
// The parsing itself lives in _shared/parse-tasks.ts, which the Telegram bot also calls:
// this function is the browser's front door to it, nothing more.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { GeminiError } from "../_shared/gemini.ts";
import { parseTasks } from "../_shared/parse-tasks.ts";
import { CORS_HEADERS, HttpError, json, requireUser, serviceClient } from "../_shared/supabase.ts";

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") throw new HttpError(405, "Use POST");

  const admin = serviceClient();
  const user = await requireUser(req, admin);

  const body = await req.json().catch(() => ({}));
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) throw new HttpError(400, "Send { text: string }");

  const result = await parseTasks(admin, { userId: user.id, text });
  return json(result);
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    if (err instanceof HttpError) {
      return json({ error: err.message, ...(err.extra ?? {}) }, err.status);
    }
    if (err instanceof GeminiError) {
      console.error("gemini failure", err.message);
      // Overload survives the retries often enough to deserve its own wording — telling the
      // user to try again in a moment is actionable, "did not respond properly" is not.
      const busy = err.status === 503 || err.status === 429;
      return json(
        {
          error: busy
            ? "The AI model is busy right now. Please try again in a moment."
            : "The AI service did not respond properly. Please try again.",
        },
        busy ? 503 : 502,
      );
    }
    console.error("parse-task failed", err);
    return json({ error: "Something went wrong parsing that." }, 500);
  }
});
