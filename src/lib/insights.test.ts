// The Insights aggregation. Every figure on that page comes out of these functions, so
// this is also where "the number matches the database" is pinned.
//
// Fixtures are real rows, trimmed: the two tool-call clusters, the three ai_events kinds
// and their exact token sums are what the live project held on 2026-10-30, so a test
// failing here means the page would have disagreed with the database that day.
import { describe, expect, it } from "vitest";
import {
  completionsByDay,
  INSIGHTS_DAYS,
  inWindow,
  kindSpend,
  readShare,
  scannedArticles,
  surfaceSeries,
  tasksBySource,
  windowDays,
  windowStart,
  type SurfaceSeries,
} from "./insights";

const TZ = "Asia/Kolkata"; // UTC+5:30, no DST — the default and the owner's zone
const NOW = new Date("2026-10-30T09:30:00.000Z"); // 15:00 IST on the 30th
const DAYS = windowDays(TZ, INSIGHTS_DAYS, NOW);

/** The count one surface had on one day, by day key rather than by index. */
const on = (s: SurfaceSeries, day: string, surface: string) =>
  Number(s.data[DAYS.findIndex((d) => d.key === day)]?.[surface] ?? 0);

const plotted = (s: SurfaceSeries) =>
  s.data.reduce((sum, row) => sum + s.active.reduce((n, k) => n + Number(row[k] ?? 0), 0), 0);

describe("windowDays / windowStart", () => {
  it("ends today and runs back INSIGHTS_DAYS, in the user's zone", () => {
    expect(DAYS).toHaveLength(30);
    expect(DAYS[0]?.key).toBe("2026-10-01");
    expect(DAYS[29]?.key).toBe("2026-10-30");
  });

  it("starts at local midnight, which is not UTC midnight", () => {
    // 2026-10-01 00:00 IST is 2026-09-30T18:30Z. A UTC-midnight bound would have pulled
    // in five and a half hours of rows that belong to September for this reader.
    expect(windowStart(TZ, INSIGHTS_DAYS, NOW)).toBe("2026-09-30T18:30:00.000Z");
  });

  it("puts a row just after local midnight on the new day, not the old one", () => {
    // 18:45Z on the 11th is 00:15 IST on the 12th.
    const series = surfaceSeries(
      [{ surface: "mcp", ok: true, created_at: "2026-10-11T18:45:00.000Z" }],
      DAYS,
      TZ,
    );
    expect(on(series, "2026-10-12", "mcp")).toBe(1);
    expect(on(series, "2026-10-11", "mcp")).toBe(0);
  });
});

describe("surfaceSeries", () => {
  // 74 mcp calls on 12 Oct, then 7 mcp (one failed) and 3 planner on 28 Oct.
  const rows = [
    ...Array.from({ length: 74 }, () => ({
      surface: "mcp",
      ok: true,
      created_at: "2026-10-12T06:00:00.000Z",
    })),
    ...Array.from({ length: 6 }, () => ({
      surface: "mcp",
      ok: true,
      created_at: "2026-10-28T11:00:00.000Z",
    })),
    { surface: "mcp", ok: false, created_at: "2026-10-28T11:05:00.000Z" },
    ...Array.from({ length: 3 }, () => ({
      surface: "planner",
      ok: true,
      created_at: "2026-10-28T01:30:00.000Z",
    })),
  ];

  it("groups by surface and day, and counts failures separately", () => {
    const s = surfaceSeries(rows, DAYS, TZ);
    expect(s.totals).toEqual({ mcp: 81, planner: 3 });
    expect(s.total).toBe(84);
    expect(s.failed).toBe(1);
  });

  it("lists only the surfaces that were used, in their fixed order", () => {
    // Fixed order, not busiest-first: a surface must not change colour because another
    // one went quiet. planner is the 5th slot even though it is the 2nd most used.
    expect(surfaceSeries(rows, DAYS, TZ).active).toEqual(["mcp", "planner"]);
    expect(surfaceSeries(rows.slice(-3), DAYS, TZ).active).toEqual(["planner"]);
  });

  it("zero-fills every day of the window so the axis has a domain", () => {
    const s = surfaceSeries(rows, DAYS, TZ);
    expect(s.data).toHaveLength(30);
    expect(s.data.filter((d) => Number(d["mcp"] ?? 0) > 0)).toHaveLength(2);
    expect(s.data[0]).toEqual({ day: DAYS[0]?.label, mcp: 0, planner: 0 });
    expect(on(s, "2026-10-12", "mcp")).toBe(74);
    expect(on(s, "2026-10-28", "planner")).toBe(3);
  });

  it("returns an empty, drawable chart for an account with no calls", () => {
    const s = surfaceSeries([], DAYS, TZ);
    expect(s.total).toBe(0);
    expect(s.active).toEqual([]);
    expect(s.data).toHaveLength(30);
    expect(s.data.every((d) => Object.keys(d).length === 1)).toBe(true);
  });

  it("folds a surface it has never heard of into `other` rather than dropping it", () => {
    // The CHECK constraint could gain a sixth door before this file does; the count has
    // to keep adding up either way.
    const s = surfaceSeries(
      [{ surface: "alexa", ok: true, created_at: "2026-10-28T11:00:00.000Z" }],
      DAYS,
      TZ,
    );
    expect(s.active).toEqual(["other"]);
    expect(s.total).toBe(1);
  });

  it("keeps the legend total equal to the bars, dropping rows outside the window", () => {
    const stale = [{ surface: "mcp", ok: true, created_at: "2026-09-01T06:00:00.000Z" }];
    const s = surfaceSeries([...rows, ...stale], DAYS, TZ);
    expect(s.total).toBe(84);
    expect(plotted(s)).toBe(84);
  });
});

describe("kindSpend", () => {
  const rows = [
    {
      kind: "digest",
      input_tokens: 187075,
      output_tokens: 22021,
      created_at: "2026-10-20T01:00:00.000Z",
    },
    {
      kind: "plan",
      input_tokens: 10015,
      output_tokens: 154,
      created_at: "2026-10-28T01:00:00.000Z",
    },
    {
      kind: "task_parse",
      input_tokens: 4285,
      output_tokens: 883,
      created_at: "2026-10-12T06:00:00.000Z",
    },
  ];

  it("sums input and output per kind, biggest spender first", () => {
    const spend = kindSpend(rows, DAYS, TZ);
    expect(spend.map((s) => s.kind)).toEqual(["digest", "plan", "task_parse"]);
    expect(spend[0]).toMatchObject({
      label: "Digest ranking",
      calls: 1,
      input: 187075,
      output: 22021,
      total: 209096,
    });
  });

  it("counts a call whose provider reported no usage, and adds nothing for it", () => {
    // input_tokens/output_tokens are nullable: the row is written because the call
    // happened, so it has to appear in `calls` while contributing 0 to the sums.
    const spend = kindSpend(
      [
        ...rows,
        {
          kind: "digest",
          input_tokens: null,
          output_tokens: null,
          created_at: "2026-10-21T01:00:00.000Z",
        },
        {
          kind: "digest",
          input_tokens: 1000,
          output_tokens: null,
          created_at: "2026-10-22T01:00:00.000Z",
        },
      ],
      DAYS,
      TZ,
    );
    expect(spend[0]).toMatchObject({ kind: "digest", calls: 3, input: 188075, output: 22021 });
    expect(spend[0]?.total).toBe(210096);
  });

  it("is empty, not zero-filled, when nothing was spent", () => {
    // Unlike the surface chart there is no day axis to give a domain to, so an empty
    // result is the signal the page needs to show an empty state instead of a plot.
    expect(kindSpend([], DAYS, TZ)).toEqual([]);
  });

  it("ignores rows older than the window", () => {
    const old = [
      {
        kind: "summary",
        input_tokens: 999,
        output_tokens: 999,
        created_at: "2026-08-01T06:00:00.000Z",
      },
    ];
    expect(kindSpend(old, DAYS, TZ)).toEqual([]);
  });
});

describe("tasksBySource", () => {
  const rows = [
    ...Array.from({ length: 37 }, () => ({
      source: "mcp",
      created_at: "2026-10-12T07:00:00.000Z",
    })),
    ...Array.from({ length: 6 }, () => ({
      source: "manual",
      created_at: "2026-10-12T07:00:00.000Z",
    })),
    ...Array.from({ length: 3 }, () => ({ source: "ai", created_at: "2026-10-12T07:00:00.000Z" })),
    { source: "telegram", created_at: "2026-10-12T07:00:00.000Z" },
  ];

  it("lists every creation path, including the ones at zero", () => {
    const by = tasksBySource(rows, DAYS, TZ);
    expect(by.map((r) => [r.source, r.count])).toEqual([
      ["manual", 6],
      ["ai", 3],
      ["mcp", 37],
      ["telegram", 1],
      ["agent", 0],
    ]);
  });

  it("still lists all five paths for an account with no tasks", () => {
    expect(tasksBySource([], DAYS, TZ).map((r) => r.count)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("scannedArticles", () => {
  it("sums sources_scanned over the digests inside the window", () => {
    const digests = [
      { digest_date: "2026-10-30", sources_scanned: 198 },
      { digest_date: "2026-10-29", sources_scanned: 112 },
      { digest_date: "2026-09-30", sources_scanned: 500 }, // one day before the window
    ];
    expect(scannedArticles(digests, DAYS)).toBe(310);
  });

  it("is 0, not NaN, with no digests", () => {
    expect(scannedArticles([], DAYS)).toBe(0);
  });
});

describe("readShare", () => {
  it("rounds to a whole percent", () => {
    expect(readShare(7, 320)).toBe(2);
    expect(readShare(4, 20)).toBe(20);
  });

  it("is null rather than a division by zero when nothing was delivered", () => {
    expect(readShare(0, 0)).toBeNull();
  });
});

describe("completionsByDay and inWindow", () => {
  const rows = [
    { completed_at: "2026-10-30T04:00:00.000Z", due_at: "2026-10-30T06:00:00.000Z" },
    { completed_at: "2026-10-30T05:00:00.000Z", due_at: "2026-10-30T03:00:00.000Z" },
    { completed_at: "2026-09-15T05:00:00.000Z", due_at: "2026-09-15T03:00:00.000Z" },
  ];

  it("buckets by local day and zero-fills the rest", () => {
    const series = completionsByDay(rows, DAYS, TZ);
    expect(series).toHaveLength(30);
    expect(series[29]).toEqual({ day: DAYS[29]?.label, count: 2 });
    expect(series.reduce((s, d) => s + d.count, 0)).toBe(2);
  });

  it("trims to the window so the rate is over the same days as the chart", () => {
    expect(inWindow(rows, (r) => r.completed_at, DAYS, TZ)).toHaveLength(2);
    expect(inWindow([], (r: { completed_at: string }) => r.completed_at, DAYS, TZ)).toEqual([]);
  });
});
