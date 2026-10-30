// Which spoken utterances take the model-free fast path on the Alexa surface.
//
// Why this is worth testing rather than eyeballing: a false negative costs a slower answer
// from the agent, which is merely worse. A false POSITIVE answers the wrong question out
// loud, to someone who cannot see what was asked and cannot scroll back. The two failure
// modes are not comparable, so the patterns are tuned to be conservative and these tests
// pin that asymmetry.
//
// The rules are duplicated here rather than imported because the Alexa function is Deno and
// imports the Supabase client as a value. The final block asserts the patterns in the
// function still match the ones under test — the drift guard for a sixth mirrored pair.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TASK_RE = /\b(task|tasks|to ?do|to-?dos?|due|list|agenda|pending|overdue)\b/;
const EXCLUDE_RE = /\b(add|create|remind|new|remember)\b/;
const NEWS_RE = /\b(news|headline|headlines|brief|briefing|digest|stor(y|ies))\b/;

type Route = "tasks" | "news" | "agent";

function route(utterance: string): Route {
  const u = utterance.toLowerCase().trim();
  const asksTasks = TASK_RE.test(u) && !EXCLUDE_RE.test(u);
  const asksNews = NEWS_RE.test(u);
  if (asksTasks) return "tasks";
  if (asksNews) return "news";
  return "agent";
}

describe("the task fast path", () => {
  // Including the shapes Alexa's speech-to-text actually produces, which are not always the
  // shapes a person thinks they said.
  it.each([
    "what are my tasks",
    "what is due today",
    "what's due today",
    "whats on my list",
    "what is on my to do list",
    "read my todos",
    "anything overdue",
    "what is pending",
    "what's my agenda",
    "do i have any tasks today",
  ])("routes %s to tasks", (u) => {
    expect(route(u)).toBe("tasks");
  });
});

describe("the news fast path", () => {
  it.each([
    "what was the news today",
    "what's the news",
    "read my brief",
    "what is in my briefing",
    "todays headlines",
    "any news stories",
    "what's in the digest",
  ])("routes %s to news", (u) => {
    expect(route(u)).toBe("news");
  });
});

describe("creating a task must never hit the task fast path", () => {
  // The dangerous case. These contain task words, but the user is asking to WRITE. Answering
  // them by reading the list back would silently drop what they said — and on a speaker they
  // would have no way to tell that it had not been saved.
  it.each([
    "add a task to call the bank",
    "remind me to call the bank tomorrow",
    "create a new task for the review",
    "remember to pay the bill",
    "add to my list buy milk",
    "new task review the estimates",
  ])("sends %s to the agent", (u) => {
    expect(route(u)).toBe("agent");
  });
});

describe("open questions go to the agent", () => {
  it.each([
    "what is happening with interest rates",
    "tell me about kubernetes security",
    "what did the rbi say",
    "how is the market doing",
    "what's the weather",
  ])("sends %s to the agent", (u) => {
    expect(route(u)).toBe("agent");
  });

  // Every pattern requires a noun on purpose. "today" alone is ambiguous between tasks,
  // news and something else entirely, so it must not be claimed by a fast path.
  it.each(["today", "what about today", "anything", "hello"])(
    "does not claim the bare utterance %s",
    (u) => {
      expect(route(u)).toBe("agent");
    },
  );
});

describe("precedence", () => {
  // Deliberate: a question containing both is more likely about the list than the brief,
  // and reading three headlines when someone asked what was due is the worse error.
  it("prefers tasks when an utterance mentions both", () => {
    expect(route("what are my tasks and the news")).toBe("tasks");
  });

  it("is case insensitive", () => {
    expect(route("WHAT IS DUE TODAY")).toBe("tasks");
    expect(route("Read My Brief")).toBe("news");
  });
});

describe("the function's copy of the rules matches this one", () => {
  const fn = readFileSync("supabase/functions/alexa-skill/index.ts", "utf8");

  it("has the same three patterns", () => {
    for (const re of [TASK_RE, EXCLUDE_RE, NEWS_RE]) {
      expect(fn).toContain(re.source);
    }
  });

  it("still requires the exclusion to suppress the task path", () => {
    expect(fn).toContain("!/\\b(add|create|remind|new|remember)\\b/.test(u)");
  });
});
