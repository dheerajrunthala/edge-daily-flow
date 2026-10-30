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

// ---------------------------------------------------------------- slot reading

type AlexaSlot = {
  name?: string;
  value?: string;
  resolutions?: {
    resolutionsPerAuthority?: { values?: { value?: { name?: string } }[] }[];
  };
};

function firstSlotValue(slots?: Record<string, AlexaSlot>): string {
  if (!slots) return "";
  const candidates: string[] = [];
  for (const slot of Object.values(slots)) {
    if (typeof slot?.value === "string" && slot.value.trim()) {
      candidates.push(slot.value.trim());
      continue;
    }
    const resolved =
      slot?.resolutions?.resolutionsPerAuthority?.[0]?.values?.[0]?.value?.name?.trim();
    if (resolved) candidates.push(resolved);
  }
  if (candidates.length === 0) return "";
  return candidates.reduce((a, b) => (b.length > a.length ? b : a));
}

describe("reading the spoken words out of Alexa's slots", () => {
  // The bug this exists for: the first version read `slots.query.value` and then
  // `slots.text.value`. The interaction model is configured by hand, so when the slot ended
  // up called anything else the skill replied "sorry, I did not catch that" to every single
  // utterance — which sounds exactly like a speech recognition failure and is not one.
  it.each(["query", "text", "utterance", "searchQuery", "somethingElse", "q"])(
    "reads the value from a slot named %s",
    (name) => {
      expect(firstSlotValue({ [name]: { name, value: "what is due today" } })).toBe(
        "what is due today",
      );
    },
  );

  it("prefers the longest value when several slots filled", () => {
    // Alexa often fills a date or number slot alongside the free-text one. The long value is
    // the sentence; the short one is a fragment of it.
    expect(
      firstSlotValue({
        when: { name: "when", value: "today" },
        query: { name: "query", value: "what is due today" },
      }),
    ).toBe("what is due today");
  });

  it("falls back to a resolved synonym when the raw value is absent", () => {
    // A custom-type slot can arrive with no `value` but a resolution.
    expect(
      firstSlotValue({
        topic: {
          name: "topic",
          resolutions: {
            resolutionsPerAuthority: [{ values: [{ value: { name: "the news" } }] }],
          },
        },
      }),
    ).toBe("the news");
  });

  it.each([
    ["no slots at all", undefined],
    ["an empty slot map", {}],
    ["a slot with no value", { query: { name: "query" } }],
    ["a slot whose value is blank", { query: { name: "query", value: "   " } }],
  ])("returns empty for %s", (_label, slots) => {
    expect(firstSlotValue(slots as Record<string, AlexaSlot> | undefined)).toBe("");
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

  it("still reads slots by value rather than by name", () => {
    // If someone reintroduces `slots.query.value`, the skill silently stops answering
    // anything whenever the console names the slot differently.
    expect(fn).toContain("firstSlotValue(body.request?.intent?.slots)");
    expect(fn).not.toContain("slots?.query?.value");
  });
});
