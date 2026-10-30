# P2 — Make Insights real

**Model: sonnet.** Data shaping plus chart work. **Size: ~1.5h.** **Depends on: nothing.**

Load the `dataviz` skill before writing any chart code.

## Why

`src/routes/_authenticated/insights.tsx` is 143 lines: four stat tiles and one bar chart. One
of the tiles is **invented** — `MIN_PER_ARTICLE = 3` at line 29, multiplied by articles scanned
to claim "reading time saved". The page is honest about it in a subtitle, which is better than
nothing, but it is still a made-up number on a page whose whole job is to show real ones.

Meanwhile the interesting data arrived in Phase 8 and nothing reads it. `mcp_tool_calls.surface`
records which of five front doors made every tool call — it is the only record of what an agent
did while nobody was watching — and `ai_events` has every model call with its token counts.

## What to build

Replace the invented tile, then add what the new tables support:

1. **Articles read vs scanned.** Real counts from `articles` and `news_items.read_at`. Drop
   `MIN_PER_ARTICLE` entirely rather than refining the guess.
2. **Agent activity by surface** — `mcp_tool_calls` grouped by `surface` over time. This is the
   chart that makes the multi-door architecture _visible_ instead of claimed, and it is the
   most valuable thing on the page.
3. **Model spend** — `ai_events` grouped by `kind` (`task_parse`, `digest`, `summary`,
   `embedding`, `brief`, `agent`, `plan`) with `input_tokens`/`output_tokens` summed. Note
   `user_id` is **nullable** on this table: ingest-news is shared work with no owning user, so a
   per-user query must not assume every row has one.
4. **Tasks by `source`** — `manual` / `ai` / `mcp` / `telegram` / `agent`. Five creation paths
   with different amounts of human review; this is the product's thesis in one tile.
5. **Topic coverage** — how many of the latest digest's items arrived via a topic rather than a
   category. Needs `match_topics_pool` or a stored marker; if neither is cheap, **skip it and
   say so** rather than approximating.
6. **Follow-up threads found** — `count(*) where related_item_id is not null`.

## Files

- `src/lib/insights.ts` — **new.** All aggregation as pure functions taking rows and returning
  chart-ready data. This is the part that gets unit-tested, and it is why the page logic should
  not stay inline.
- `src/lib/queries.ts` — add the hooks. Follow the existing shape exactly (`useDigests` at
  ~line 226 is the model: `queryKey` from `qk`, `uid()` for scoping, named columns never `*`).
- `src/lib/query-keys.ts` — add keys.
- `src/routes/_authenticated/insights.tsx` — the page.
- `src/lib/insights.test.ts` — **new.**

## Reuse, do not rewrite

- `Card`, `SectionTitle`, `EmptyState`, `ListSkeleton` from `src/components/common.tsx`.
- `dayKey`, `fmt`, `addDaysKey` from `src/lib/tz.ts` — **never** the browser's local zone;
  always `profiles.timezone`.
- The existing recharts setup in `src/components/ui/chart.tsx`.
- `onTimeRate` from `src/lib/task-logic.ts`.

## Acceptance criteria

- No invented constants. Every number traces to a row.
- Aggregation is pure, in `src/lib/insights.ts`, with ~8 unit tests: empty data, a single day,
  surface grouping, token sums **with nulls present**, a tz boundary.
- The surface chart shows the `mcp` and `planner` rows that exist in `mcp_tool_calls` today.
- Skeletons while loading and a real empty state — a new account must not see a broken page.
- Readable in light and dark (the `dataviz` skill covers this).
- `npm run build && npm run lint && npm test` green.

## Verification

1. `npm run dev`, open `/insights`, compare each number against the same query run through the
   Supabase MCP. They must match exactly.
2. Check a brand-new account's view, or simulate empty data — the most likely bug here is a
   divide-by-zero or a chart with no domain.
