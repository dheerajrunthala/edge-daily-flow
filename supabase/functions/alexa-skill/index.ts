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
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { requireApiToken } from "../_shared/api-tokens.ts";
import { loadUserCtx } from "../_shared/agent-tools.ts";
import { type Run, declarationsFor, runTool } from "../_shared/agent-registry.ts";
import { GEMINI_FALLBACK_MODEL, generateWithTools } from "../_shared/gemini.ts";
import { isEnabled } from "../_shared/features.ts";
import { logToolCall } from "../_shared/api-tokens.ts";
import { HttpError, countAiEvents, json, logAiEvent, serviceClient } from "../_shared/supabase.ts";
import { offsetLabel } from "../_shared/time.ts";

/** Spoken turns a user may have per day. Shares the agent's budget, counted the same way. */
const DAILY_LIMIT = 60;

/**
 * Everything here is sized to Alexa's ~8 second patience, which is the tightest budget any
 * surface in this project has and changes which answers are even reachable.
 *
 * Measured on the first real device session: the agent answered correctly in **56 seconds**
 * and Alexa had long since said "there was a problem". The whole 56s was one cause —
 * `gemini-flash-latest` timing out at its 25s deadline on every call before falling through
 * to flash-lite, which then answered in about three seconds.
 *
 * So voice does not use the primary model at all. It calls flash-lite directly, with no
 * fallback (there is no time for a second attempt) and a 4s per-call deadline, which leaves
 * room for two turns plus a tool round trip inside the budget. On every other surface the
 * primary-then-fallback order is right; here it is the difference between an answer and a
 * failure.
 */
const VOICE_CALL_TIMEOUT_MS = 4_000;

/**
 * Two turns: one to pick a tool, one to speak the result. Four is right where latency is
 * free. Here a third turn cannot finish before Alexa hangs up, so allowing it only wastes
 * the user's quota on an answer nobody hears.
 */
const VOICE_MAX_TURNS = 2;

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

  // ---------------------------------------------------------------- fast paths
  //
  // The three things people actually ask a speaker need no model at all, and on an 8 second
  // budget that matters more than elegance. "What's due today" is a query and a sentence;
  // routing it through two Gemini turns spends four of those eight seconds to produce the
  // same words, and spends them again on the next question.
  //
  // This is a latency decision, not a capability decision. Anything that is not one of these
  // shapes still goes to the agent, which is why the list is short and deliberately does not
  // try to grow into an intent router. It also still goes through runTool, so the ownership
  // guard and the mcp_tool_calls audit trail apply exactly as they do everywhere else.
  const ctxEarly = await loadUserCtx(admin, token.userId);
  const runEarly: Run = { ctx: ctxEarly, surface: "voice", citations: new Map() };
  const quick = await fastAnswer(admin, token, runEarly, utterance);
  if (quick) return speak(quick, false, "Anything else?");

  const used = await countAiEvents(admin, token.userId, "agent", startOfToday());
  if (used >= DAILY_LIMIT) {
    return speak("You have reached today's limit for the assistant. Try again tomorrow.", true);
  }

  // ---------------------------------------------------------------- the agent
  const ctx = ctxEarly;
  const run: Run = runEarly;

  const result = await generateWithTools({
    // flash-lite, deliberately, and as the primary rather than the fallback — see
    // VOICE_CALL_TIMEOUT_MS above.
    model: GEMINI_FALLBACK_MODEL,
    fallbackModel: null,
    callTimeoutMs: VOICE_CALL_TIMEOUT_MS,
    system: voicePrompt(ctx.tz, ctx.morningTime, offsetLabel(new Date(), ctx.tz)),
    messages: [{ role: "user" as const, text: utterance }],
    tools: declarationsFor("voice"),
    maxTurns: VOICE_MAX_TURNS,
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

/**
 * Answer the common asks directly, or return null and let the agent handle it.
 *
 * Patterns are matched on the whole utterance and kept broad rather than clever: Alexa's
 * speech-to-text varies ("what's due", "what is do", "whats on my list"), so a near miss
 * costing a slower agent answer is fine, while a false positive answering the wrong question
 * is not. That is why every pattern requires a noun — "today" alone does not match.
 */
async function fastAnswer(
  admin: SupabaseClient,
  token: { userId: string; tokenId: string },
  run: Run,
  utterance: string,
): Promise<string | null> {
  const u = utterance.toLowerCase().trim();

  const asksTasks =
    /\b(task|tasks|to ?do|to-?dos?|due|list|agenda|pending|overdue)\b/.test(u) &&
    !/\b(add|create|remind|new|remember)\b/.test(u);
  const asksNews = /\b(news|headline|headlines|brief|briefing|digest|stor(y|ies))\b/.test(u);

  if (!asksTasks && !asksNews) return null;

  const call = async (tool: string, args: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const out = await runTool(run, tool, args);
      await logToolCall(admin, {
        userId: token.userId,
        tokenId: token.tokenId,
        tool,
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
        tool,
        ok: false,
        error: msg,
        durationMs: Date.now() - started,
        surface: "voice",
      });
      throw err;
    }
  };

  if (asksTasks) {
    const res = (await call("list_tasks", { limit: 50 })) as {
      tasks?: { title: string; group: string; due_label: string }[];
    };
    const all = res.tasks ?? [];
    const overdue = all.filter((t) => t.group === "overdue");
    const today = all.filter((t) => t.group === "today");

    if (overdue.length === 0 && today.length === 0) {
      const open = all.length;
      return open === 0
        ? "Nothing on your list at all. Enjoy it."
        : `Nothing due today. You have ${say(open, "task")} further out.`;
    }

    const parts: string[] = [];
    // Overdue first, because that is the thing a person needs to hear first.
    if (overdue.length > 0) {
      parts.push(`${say(overdue.length, "overdue task")}: ${titles(overdue)}.`);
    }
    if (today.length > 0) {
      parts.push(`Due today, ${say(today.length, "task")}: ${titles(today)}.`);
    }
    return parts.join(" ");
  }

  const res = (await call("my_news", {})) as {
    ready?: boolean;
    items?: { headline: string; why_it_matters?: string | null }[];
  };
  if (!res.ready) {
    return "Your brief for today is not ready yet. It is usually built early in the morning.";
  }
  const items = res.items ?? [];
  if (items.length === 0) return "There is nothing in today's brief.";

  // Three headlines. More than that and a listener has lost the first by the last.
  const top = items.slice(0, 3).map((i) => i.headline.replace(/\s+/g, " ").trim());
  const why = items[0]?.why_it_matters?.replace(/\s+/g, " ").trim();
  return (
    `Today's top ${say(top.length, "story")}. ${top.map((t, i) => `${i + 1}. ${t}`).join(" ")}` +
    (why ? ` On the first: ${why}` : "")
  );
}

/** "1 task" / "3 tasks" — because "1 tasks" is the kind of thing a speaker makes obvious. */
function say(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** At most three titles, comma-joined with an "and", which is how a person would say it. */
function titles(list: { title: string }[]): string {
  const names = list.slice(0, 3).map((t) => t.title.replace(/\s+/g, " ").trim());
  const extra = list.length - names.length;
  const joined =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return extra > 0 ? `${joined}, plus ${say(extra, "more")}` : joined;
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
