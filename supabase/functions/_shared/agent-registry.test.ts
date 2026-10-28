// The surface allowlist and the citation check.
//
// These two are the agent layer's guardrails, and both are the kind of thing that is
// easy to weaken by accident later — someone adds a tool to the registry and forgets
// that `voice` exists, or loosens the URL regex and stops catching invented links.

import { describe, expect, it } from "vitest";

import {
  MUTATING_TOOLS,
  SURFACE_TOOLS,
  type Citation,
  type Run,
  declarationsFor,
  unknownCitations,
} from "./agent-registry.ts";

const runWith = (urls: string[]): Run =>
  ({
    ctx: {} as Run["ctx"],
    surface: "chat",
    citations: new Map<string, Citation>(
      urls.map((url) => [
        url,
        { title: "t", url, source: null, published_at: null, via_google_news: false },
      ]),
    ),
  }) as Run;

describe("surface allowlists", () => {
  it("never exposes delete_task anywhere", () => {
    for (const [surface, tools] of Object.entries(SURFACE_TOOLS)) {
      expect(tools, surface).not.toContain("delete_task");
    }
  });

  // A voice device has heard something it may have misheard and shows nothing back, so
  // it must not be able to mark work done.
  it("withholds every mutating tool but create_task from voice", () => {
    for (const tool of SURFACE_TOOLS.voice) {
      if (MUTATING_TOOLS.has(tool)) expect(tool).toBe("create_task");
    }
    expect(SURFACE_TOOLS.voice).not.toContain("complete_task");
  });

  // The planner runs on cron with nobody present. It reads and reports; it does not act.
  it("gives the planner no mutating tool at all", () => {
    for (const tool of SURFACE_TOOLS.planner) {
      expect(MUTATING_TOOLS.has(tool), tool).toBe(false);
    }
  });

  it("declares exactly the tools a surface is allowed, and no others", () => {
    for (const surface of Object.keys(SURFACE_TOOLS) as (keyof typeof SURFACE_TOOLS)[]) {
      const declared = declarationsFor(surface).map((d) => d.name);
      expect(declared.sort()).toEqual([...SURFACE_TOOLS[surface]].sort());
    }
  });

  it("declares every tool with a description and an object schema", () => {
    for (const d of declarationsFor("chat")) {
      expect(d.description.length, d.name).toBeGreaterThan(20);
      expect((d.parameters as { type: string }).type, d.name).toBe("object");
    }
  });
});

describe("unknownCitations", () => {
  it("passes a link that a tool actually returned", () => {
    const run = runWith(["https://reuters.com/a"]);
    expect(unknownCitations(run, "See https://reuters.com/a for more.")).toEqual([]);
  });

  // The failure this exists to catch: a plausible URL the model composed itself. A wrong
  // summary is visibly the model's opinion; a wrong link looks like a fact.
  it("flags a link no tool returned", () => {
    const run = runWith(["https://reuters.com/a"]);
    expect(unknownCitations(run, "See https://reuters.com/invented-slug.")).toEqual([
      "https://reuters.com/invented-slug",
    ]);
  });

  it("strips trailing punctuation before comparing, so prose does not false-positive", () => {
    const run = runWith(["https://reuters.com/a"]);
    expect(unknownCitations(run, "Read https://reuters.com/a, then stop.")).toEqual([]);
  });

  it("does not treat a markdown-wrapped link as unknown", () => {
    const run = runWith(["https://reuters.com/a"]);
    expect(unknownCitations(run, "[story](https://reuters.com/a)")).toEqual([]);
  });

  it("reports each invented link once, however often it appears", () => {
    const run = runWith([]);
    const answer = "https://a.com/x and again https://a.com/x";
    expect(unknownCitations(run, answer)).toEqual(["https://a.com/x"]);
  });

  it("finds nothing in an answer with no links", () => {
    expect(unknownCitations(runWith([]), "Nothing is due today.")).toEqual([]);
  });
});
