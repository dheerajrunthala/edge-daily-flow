---
name: add-news-feed
description: Add or change a source in the news pipeline (_shared/feeds.ts) — the tier system, the gotchas that cost an hour each, the DROPPED list, and how to verify a feed actually parses. Use when adding a feed, debugging a feed that returns nothing, or changing categories.
---

# Adding a news source

Every feed is `{ url, name, category, tier }` in `FEEDS` in
`supabase/functions/_shared/feeds.ts`. That array is the single source of truth:
`ingest-news` rewrites the `prefetch_feeds` table from it on every run, so adding an
aggregator feed needs no SQL.

## Pick the tier honestly — it is passed to the ranking prompt

- `primary` — the actor speaking for itself (a regulator, a lab, a release feed). First-hand
  facts, and given a **72-hour** recency window because these are quiet for days at a time.
- `trusted` — a newsroom with an editor, reporting on someone else. 24 hours.
- `aggregator` — Google News, Hacker News. Best recall and the signal of what is breaking,
  but no editorial control and the links need cleaning. 24 hours.

The model is told to treat `primary` as authoritative and a high `source_count` as
corroboration rather than quality. Mislabelling a tier corrupts the ranking, quietly.

## Check DROPPED before adding anything

`DROPPED` records dead feeds **with reasons**. Do not re-add VentureBeat (429s on every
path — a block, not rate limiting), Moneycontrol (abandoned, newest item Apr 2024),
Anthropic (no public RSS), or PIB's `RssMain.aspx` (serves an empty `<channel>` for every
parameter combination). If you drop a feed, add it there with the reason.

## Gotchas that are already handled — do not rediscover them

- **Send a browser User-Agent.** Business Standard answers 403 to anything bot-shaped.
- **Google News feeds answer 503 from the Edge runtime** — the functions network's IP range
  is blocked, while Postgres egress and a laptop both get 200. That is why aggregator feeds
  are fetched by `prefetch_aggregator_feeds()` via pg_net and read back with
  `get_prefetched_feeds()`. A direct fetch is the fallback, not the path.
- **Current Google News `/rss/articles/CBMi…` links cannot be resolved server-side at all.**
  The id is opaque, the hop is client-side JS, and the `Fbv4je` RPC returns empty even with
  the page's own signature. Verified against live links. Those keep `url_resolved = false`
  and render "via Google News". Re-test occasionally; do not rebuild it.
- **Entire-archive feeds.** OpenAI and Hugging Face serve 1287 and 876 items; `parseFeed`
  caps at the 150 newest.
- **Atom's `<link>` is self-closing**, so the element-text picker misses it and `linkHref`
  handles `rel="alternate"`.
- **A quiet day is normal.** GitHub release feeds and lab blogs often have nothing in 24h.
  That is not a broken feed.

## Verify before committing

`feeds.ts` has no `npm:`/`jsr:` imports, so it is unit-testable directly — and
`supabase/functions/_shared/feeds.test.ts` already covers the gotchas above. Add a case
there for any new malformation you find, using real captured XML.

Then prove the feed actually parses against the live source, one category at a time:

```sql
select public.invoke_edge_function('ingest-news', '{"category": "<category>"}');
```

and read `net._http_response` for the returned id. Expect `parsed`, `in window` and
`inserted` counts. `parsed > 0` with `in window = 0` means the feed works and was simply
quiet; `parsed = 0` means it did not parse and is worth the hour.
