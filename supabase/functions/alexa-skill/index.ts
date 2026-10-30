// alexa-skill (no JWT; authenticated by the linked account's de_ token) — the voice door.
//
// The fifth front door and the only one with no screen. That single fact drives every
// decision here:
//
//   * It runs on the `voice` surface, whose allowlist (in _shared/agent-registry.ts) grants
//     reads plus create_task and deliberately NOT complete_task. A device in a room may have
//     misheard, and it shows nothing back for the user to check — so it may add to the list
//     and may not tick things off it.
//   * Replies are two or three sentences, no markdown, no URLs. The system prompt in
//     _shared/agent-prompt logic already branches on surface for this.
//   * Account linking is OAuth2 **implicit grant**, not authorization-code. Alexa supports
//     both, and implicit needs no token endpoint and no refresh because the token it receives
//     is already long-lived and revocable: it is an ordinary `de_` row in api_tokens. So
//     revoking a token in Settings → Integrations kills the Alexa skill immediately, and
//     there is no second credential system to keep in step.
//
// Auth is therefore the access token Alexa sends in every request, resolved through the same
// requireApiToken() the MCP server uses.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { requireApiToken } from "../_shared/api-tokens.ts";
import { loadUserCtx } from "../_shared/agent-tools.ts";
import { type Run, declarationsFor, runTool } from "../_shared/agent-registry.ts";
import { GEMINI_PARSE_MODEL, generateWithTools } from "../_shared/gemini.ts";
import { isEnabled } from "../_shared/features.ts";
import { logToolCall } from "../_shared/api-tokens.ts";
import { HttpError, countAiEvents, json, logAiEvent, serviceClient } from "../_shared/supabase.ts";
import { offsetLabel } from "../_shared/time.ts";

/** Spoken turns a user may have per day. Shares the agent's budget, counted the same way. */
const DAILY_LIMIT = 60;

/**
 * How stale an Alexa request may be.
 *
 * Amazon requires rejecting anything older than 150 seconds. This is the replay guard that
 * does not need the certificate chain — see the note on verification below.
 */
const MAX_SKEW_MS = 150_000;

type AlexaRequest = {
  version?: string;
  session?: { user?: { accessToken?: string } };
  context?: {
    System?: {
      application?: { applicationId?: string };
      user?: { accessToken?: string };
    };
  };
  request?: {
    type?: string;
    timestamp?: string;
    locale?: string;
    intent?: { name?: string; slots?: Record<string, { value?: string }> };
    reason?: string;
  };
};

/** Alexa's response envelope. `shouldEndSession: false` keeps the mic open for a follow-up. */
function speak(text: string, endSession = false, reprompt?: string) {
  return json({
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      ...(reprompt ? { reprompt: { outputSpeech: { type: "PlainText", text: reprompt } } } : {}),
      shouldEndSession: endSession,
    },
  });
}

/**
 * Ask the user to link, in the way Alexa understands.
 *
 * A LinkAccount card makes the Alexa app show a "Link Account" button rather than the user
 * having to find it in settings, which is the difference between a skill people connect and
 * one they abandon.
 */
function needsLinking() {
  return json({
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text: "First, link your Daily Edge account in the Alexa app. I have put a card there for you.",
      },
      card: { type: "LinkAccount" },
      shouldEndSession: true,
    },
  });
}

async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") throw new HttpError(405, "Use POST");

  const body = (await req.json().catch(() => ({}))) as AlexaRequest;

  // ---------------------------------------------------------------- request validation
  //
  // Not the full certificate-chain check Amazon documents. That verifies the request really
  // came from Amazon; what actually gates access here is the account-linking token, which an
  // attacker does not have and cannot forge. So this checks the two things that are cheap and
  // close the practical gaps — a request for somebody else's skill, and a replayed one — and
  // the signature gap is recorded in docs/roadmap.md rather than left implied.
  const expectedAppId = Deno.env.get("ALEXA_SKILL_ID");
  const appId = body.context?.System?.application?.applicationId;
  if (expectedAppId && appId && appId !== expectedAppId) {
    throw new HttpError(401, "Request is for a different skill");
  }

  const stamp = body.request?.timestamp ? Date.parse(body.request.timestamp) : NaN;
  if (Number.isFinite(stamp) && Math.abs(Date.now() - stamp) > MAX_SKEW_MS) {
    throw new HttpError(401, "Request timestamp is outside the allowed window");
  }

  // ---------------------------------------------------------------- identity
  const accessToken =
    body.session?.user?.accessToken ?? body.context?.System?.user?.accessToken ?? "";
  if (!accessToken) return needsLinking();

  const admin = serviceClient();
  let token;
  try {
    // Reuses the MCP server's resolver, so a revoked token stops the skill with no extra code.
    token = await requireApiToken(
      new Request("https://local/", { headers: { authorization: `Bearer ${accessToken}` } }),
      admin,
    );
  } catch {
    // A stale token must prompt re-linking, not read as a server error — otherwise the user
    // hears "something went wrong" forever and has no idea what to do.
    return needsLinking();
  }

  const type = body.request?.type ?? "";
  if (type === "SessionEndedRequest") return json({ version: "1.0", response: {} });

  if (!(await isEnabled(admin, token.userId, "voice"))) {
    return speak("Voice is turned off for your account. You can switch it on in settings.", true);
  }

  // ---------------------------------------------------------------- intents
  if (type === "LaunchRequest") {
    return speak(
      "Daily Edge here. Ask me what is happening in your news, what is due today, or tell me something to remember.",
      false,
      "You can say: what is due today?",
    );
  }

  const intent = body.request?.intent?.name ?? "";

  if (intent === "AMAZON.StopIntent" || intent === "AMAZON.CancelIntent") {
    return speak("Right you are.", true);
  }
  if (intent === "AMAZON.HelpIntent") {
    return speak(
      "Ask me about your news, like: what is happening with interest rates. Or ask what is due today. Or say: remind me to call the bank tomorrow morning.",
      false,
      "What would you like?",
    );
  }

  // Every useful intent funnels into one free-text slot and lets the agent decide. A voice
  // interaction model with one AskIntent beats ten brittle intents, because the agent is
  // better at working out what was meant than a slot grammar is.
  const utterance =
    body.request?.intent?.slots?.query?.value ?? body.request?.intent?.slots?.text?.value ?? "";

  if (!utterance) {
    return speak("Sorry, I did not catch that.", false, "Try asking what is due today.");
  }

  const used = await countAiEvents(admin, token.userId, "agent", startOfToday());
  if (used >= DAILY_LIMIT) {
    return speak("You have reached today's limit for the assistant. Try again tomorrow.", true);
  }

  // ---------------------------------------------------------------- the agent
  const ctx = await loadUserCtx(admin, token.userId);
  const run: Run = { ctx, surface: "voice", citations: new Map() };

  const result = await generateWithTools({
    model: GEMINI_PARSE_MODEL,
    system: voicePrompt(ctx.tz, ctx.morningTime, offsetLabel(new Date(), ctx.tz)),
    messages: [{ role: "user" as const, text: utterance }],
    tools: declarationsFor("voice"),
    maxTurns: 4,
    execute: async (name, args) => {
      const started = Date.now();
      try {
        const out = await runTool(run, name, args);
        await logToolCall(admin, {
          userId: token.userId,
          tokenId: token.tokenId,
          tool: name,
          ok: true,
          durationMs: Date.now() - started,
          surface: "voice",
        });
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logToolCall(admin, {
          userId: token.userId,
          tokenId: token.tokenId,
          tool: name,
          ok: false,
          error: msg,
          durationMs: Date.now() - started,
          surface: "voice",
        });
        throw err;
      }
    },
  });

  await logAiEvent(admin, {
    userId: token.userId,
    kind: "agent",
    itemsProcessed: result.calls.length,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  // Spoken output must not contain markdown or a URL even if the model slipped. Stripping is
  // right here where silently reading "https colon slash slash" aloud is the failure.
  return speak(forSpeech(result.text), false, "Anything else?");
}

/** Flatten anything that reads badly aloud. */
function forSpeech(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function startOfToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

function voicePrompt(tz: string, morningTime: string, offset: string): string {
  return `You are Daily Edge, answering out loud through a speaker. The person cannot see
anything you say, cannot scroll back, and cannot read a link.

Their clock: timezone ${tz}, currently UTC${offset}. "Morning" means ${morningTime},
afternoon 14:00, evening 19:00, tonight 21:00.

Rules for speech:
- Two or three sentences. Never more. No markdown, no lists, no URLs, no ids.
- Answer news questions by calling search_news or my_news first, and never from your own
  knowledge — they are asking what their brief said. If nothing matches, say so plainly.
- When you add a task, say it back in plain words including the day and time, because that
  confirmation is the only chance they have to catch a mistake.
- due_at must be ISO 8601 with the offset above, e.g. 2026-10-31T09:00:00${offset}.
- You cannot mark anything done from here. If they ask, say it has to be done in the app or
  on Telegram, and offer to add a reminder instead.
- Say "via Google News" if a story's link was a redirect, but never read the link itself.`;
}

Deno.serve(async (req: Request) => {
  try {
    return await handle(req);
  } catch (err) {
    console.error(err);
    // Alexa shows the user nothing useful on a non-200, so speak the failure instead.
    return speak("Sorry, something went wrong on my end. Please try again.", true);
  }
});
