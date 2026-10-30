// The feature gate's resolution rules, which are the whole of its behaviour.
//
// Worth testing for one reason: every rule here is about what happens when a row is
// *missing*, and a missing row is the normal case. Getting the default backwards would
// either silently switch the product off for every existing account, or quietly opt
// everyone into a cron job that messages them in the morning.

import { describe, expect, it } from "vitest";

import { ALL_FEATURES, defaultFor, type Feature } from "./features.ts";

describe("defaults", () => {
  it("defaults everything except the planner to on", () => {
    for (const f of ALL_FEATURES) {
      if (f === "planner") continue;
      expect(defaultFor(f), f).toBe(true);
    }
  });

  // The planner is the only feature that starts a conversation the user did not ask for.
  it("defaults the planner off, because nothing should message you unasked", () => {
    expect(defaultFor("planner")).toBe(false);
  });

  it("covers every feature the migration's CHECK constraint allows", () => {
    // Kept in step by hand; if these drift, a feature becomes unreachable from the UI
    // or a row the UI writes fails the constraint.
    const inMigration: Feature[] = [
      "digest",
      "topics",
      "reminders",
      "planner",
      "chat",
      "voice",
      "followups",
      "telegram",
      "push",
    ];
    expect([...ALL_FEATURES].sort()).toEqual([...inMigration].sort());
  });
});
