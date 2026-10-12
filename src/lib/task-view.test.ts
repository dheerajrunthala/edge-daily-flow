import { describe, expect, it } from "vitest";
import { parseTasksSearch } from "./task-view";

describe("parseTasksSearch", () => {
  it("keeps a real view", () => {
    expect(
      parseTasksSearch({
        view: "calendar",
        sort: "priority",
        status: "all",
        tags: "Coding,Work",
        mode: "or",
        src: "mcp,telegram",
        q: "auth",
        month: "2026-11",
      }),
    ).toEqual({
      view: "calendar",
      sort: "priority",
      status: "all",
      tags: "Coding,Work",
      mode: "or",
      src: "mcp,telegram",
      q: "auth",
      month: "2026-11",
    });
  });

  it("drops every default, so a plain view is a plain URL", () => {
    expect(parseTasksSearch({ view: "list", sort: "due", status: "todo", mode: "and" })).toEqual(
      {},
    );
  });

  it("drops junk rather than trusting the URL", () => {
    expect(
      parseTasksSearch({
        sort: "nonsense",
        status: "maybe",
        src: "carrier-pigeon",
        month: "banana",
      }),
    ).toEqual({});
  });

  it("ignores AND/OR with fewer than two tags", () => {
    expect(parseTasksSearch({ tags: "Coding", mode: "or" })).toEqual({ tags: "Coding" });
    expect(parseTasksSearch({ tags: "Coding,Work", mode: "or" })).toEqual({
      tags: "Coding,Work",
      mode: "or",
    });
  });

  it("strips blank tag entries", () => {
    expect(parseTasksSearch({ tags: ",, ," })).toEqual({});
  });
});
